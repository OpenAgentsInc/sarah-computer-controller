import * as path from "node:path"
import * as url from "node:url"

import { describe, expect, it } from "vitest"

import * as DevinAcp from "../src/DevinAcp.js"

const here = path.dirname(url.fileURLToPath(import.meta.url))
const fakeAgent = path.join(here, "fixtures", "fake-acp-agent.mjs")

const nodeBinary = process.execPath

const baseRequest = (
  mode: string,
  overrides: Partial<DevinAcp.DevinRequest> = {}
): { request: DevinAcp.DevinRequest; chunks: Array<string> } => {
  const chunks: Array<string> = []
  const request: DevinAcp.DevinRequest = {
    agentArgv: [nodeBinary, fakeAgent, mode],
    prompt: "say hello",
    cwd: here,
    env: process.env as Record<string, string>,
    limits: { ...DevinAcp.defaultDevinLimits, timeoutMillis: 10_000 },
    onChunk: (text) => chunks.push(text),
    decidePermission: () => true,
    ...overrides
  }
  return { request, chunks }
}

describe("DevinAcp", () => {
  it("completes the initialize → session/new → session/prompt handshake and streams updates", async () => {
    const { chunks, request } = baseRequest("--happy")
    const outcome = await DevinAcp.start(request).done
    expect(outcome.status).toBe("completed")
    expect(outcome.stopReason).toBe("end_turn")
    expect(outcome.sessionId).toBe("sess-fake-1")
    expect(chunks.join("")).toContain("working on it")
    expect(chunks.join("")).toContain("finished.")
  })

  it("grants a permission request when local policy allows it", async () => {
    const { chunks, request } = baseRequest("--permission")
    const outcome = await DevinAcp.start(request).done
    expect(outcome.status).toBe("completed")
    expect(chunks.join("")).toContain("[permission granted]")
    expect(chunks.join("")).toContain("permitted, done.")
  })

  it("rejects a permission request when local policy denies it", async () => {
    const { chunks, request } = baseRequest("--permission", { decidePermission: () => false })
    const outcome = await DevinAcp.start(request).done
    expect(outcome.status).toBe("refused")
    expect(chunks.join("")).toContain("[permission denied]")
  })

  it("authenticates when the agent requires it and retries session creation", async () => {
    const { request } = baseRequest("--auth")
    const outcome = await DevinAcp.start(request).done
    expect(outcome.status).toBe("completed")
    expect(outcome.sessionId).toBe("sess-fake-1")
  })

  it("returns a typed unavailable outcome when authentication fails", async () => {
    const { request } = baseRequest("--auth-strict")
    const outcome = await DevinAcp.start(request).done
    expect(outcome.status).toBe("unavailable")
    expect(outcome.detail).toContain("authentication")
  })

  it("returns a typed refusal when the agent refuses the prompt", async () => {
    const { request } = baseRequest("--refuse")
    const outcome = await DevinAcp.start(request).done
    expect(outcome.status).toBe("refused")
    expect(outcome.stopReason).toBe("refusal")
  })

  it("cancels an in-flight prompt via session/cancel and kills the subprocess", async () => {
    const { request } = baseRequest("--slow")
    const job = DevinAcp.start(request)
    setTimeout(() => job.cancel(), 500)
    const outcome = await job.done
    expect(outcome.status).toBe("cancelled")
  })

  it("times out a prompt that never completes", async () => {
    const { request } = baseRequest("--slow", {
      limits: { ...DevinAcp.defaultDevinLimits, timeoutMillis: 800 }
    })
    const outcome = await DevinAcp.start(request).done
    expect(outcome.status).toBe("timeout")
  }, 15_000)

  it("ignores malformed and non-protocol lines on stdout", async () => {
    const { request } = baseRequest("--garbage")
    const outcome = await DevinAcp.start(request).done
    expect(outcome.status).toBe("completed")
  })

  it("returns unavailable when the agent binary does not exist", async () => {
    const { request } = baseRequest("--happy", {
      agentArgv: ["/nonexistent/devin-binary-for-test", "acp"]
    })
    const outcome = await DevinAcp.start(request).done
    expect(outcome.status).toBe("unavailable")
    expect(outcome.detail).toContain("not installed")
  })

  it("returns unavailable when the argv is empty", async () => {
    const { request } = baseRequest("--happy", { agentArgv: [] })
    const outcome = await DevinAcp.start(request).done
    expect(outcome.status).toBe("unavailable")
  })
})

describe("LineBuffer", () => {
  it("splits newline-delimited messages and ignores malformed lines", () => {
    const buffer = new DevinAcp.LineBuffer(1024)
    const messages = buffer.push(`{"jsonrpc":"2.0","id":1,"result":{}}\nnot json\n{"noise":true}\n`)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.["id"]).toBe(1)
  })

  it("handles messages split across chunks", () => {
    const buffer = new DevinAcp.LineBuffer(1024)
    expect(buffer.push(`{"jsonrpc":"2.0",`)).toHaveLength(0)
    const messages = buffer.push(`"id":2,"result":{}}\n`)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.["id"]).toBe(2)
  })

  it("drops a single message larger than the limit", () => {
    const buffer = new DevinAcp.LineBuffer(64)
    const oversized = `{"jsonrpc":"2.0","id":3,"result":{"x":"${"a".repeat(200)}"}}\n`
    expect(buffer.push(oversized)).toHaveLength(0)
    const messages = buffer.push(`{"jsonrpc":"2.0","id":4,"result":{}}\n`)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.["id"]).toBe(4)
  })
})

describe("updateText", () => {
  it("extracts agent message chunks", () => {
    expect(
      DevinAcp.updateText({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } })
    ).toBe("hi")
  })

  it("summarizes tool calls and plans, and drops thoughts", () => {
    expect(DevinAcp.updateText({ sessionUpdate: "tool_call", title: "Read file" })).toContain("Read file")
    expect(DevinAcp.updateText({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "x" } })).toBe("")
    expect(
      DevinAcp.updateText({ sessionUpdate: "plan", entries: [{ content: "step one" }] })
    ).toContain("step one")
  })
})
