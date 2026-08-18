import * as path from "node:path"
import * as url from "node:url"

import type { PermissionOptionKind } from "@agentclientprotocol/sdk"
import { describe, expect, it } from "vitest"

import * as AcpAgent from "../src/AcpAgent.js"

const here = path.dirname(url.fileURLToPath(import.meta.url))
const fakeAgent = path.join(here, "fixtures", "fake-acp-agent.mjs")

const nodeBinary = process.execPath

const baseRequest = (
  mode: string,
  overrides: Partial<AcpAgent.AgentRequest> = {}
): { request: AcpAgent.AgentRequest; chunks: Array<string> } => {
  const chunks: Array<string> = []
  const request: AcpAgent.AgentRequest = {
    agentArgv: [nodeBinary, fakeAgent, mode],
    prompt: "say hello",
    cwd: here,
    env: process.env as Record<string, string>,
    limits: { ...AcpAgent.defaultAgentLimits, timeoutMillis: 10_000 },
    onChunk: (text) => chunks.push(text),
    decidePermission: () => true,
    ...overrides
  }
  return { request, chunks }
}

describe("AcpAgent", () => {
  it("completes the initialize → session/new → session/prompt handshake and streams updates", async () => {
    const { chunks, request } = baseRequest("--happy")
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("completed")
    expect(outcome.stopReason).toBe("end_turn")
    expect(outcome.sessionId).toBe("sess-fake-1")
    expect(chunks.join("")).toContain("working on it")
    expect(chunks.join("")).toContain("finished.")
  })

  it("records agent capabilities and auth methods in the outcome for evidence", async () => {
    const { request } = baseRequest("--happy")
    const outcome = await AcpAgent.start(request).done
    expect(outcome.agentCapabilities["loadSession"]).toBe(false)
    expect(outcome.authMethods).toEqual([])
  })

  it("accumulates the streamed text into the bounded outcome output", async () => {
    const { chunks, request } = baseRequest("--happy")
    const outcome = await AcpAgent.start(request).done
    expect(outcome.output).toBe(chunks.join(""))
    expect(outcome.output).toContain("finished.")
  })

  it("grants a permission request when local policy allows it", async () => {
    const { chunks, request } = baseRequest("--permission")
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("completed")
    expect(chunks.join("")).toContain("[permission granted]")
    expect(chunks.join("")).toContain("permitted, done.")
  })

  it("rejects a permission request when local policy denies it", async () => {
    const { chunks, request } = baseRequest("--permission", { decidePermission: () => false })
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("refused")
    expect(chunks.join("")).toContain("[permission denied]")
  })

  it("never selects a bypass-style permission option, even when policy allows the tool", async () => {
    const { chunks, request } = baseRequest("--permission-bypass", { decidePermission: () => true })
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("refused")
    expect(chunks.join("")).not.toContain("BYPASSED")
  })

  it("authenticates when the agent requires it and retries session creation", async () => {
    const { request } = baseRequest("--auth")
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("completed")
    expect(outcome.sessionId).toBe("sess-fake-1")
  })

  it("returns a typed unavailable outcome carrying auth methods when authentication fails", async () => {
    const { request } = baseRequest("--auth-strict")
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("unavailable")
    expect(outcome.detail).toContain("authentication")
    expect(outcome.detail).toContain("fake-login")
    expect(outcome.authMethods).toEqual([{ id: "fake-login", name: "Fake login" }])
  })

  it("returns a typed refusal when the agent refuses the prompt", async () => {
    const { request } = baseRequest("--refuse")
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("refused")
    expect(outcome.stopReason).toBe("refusal")
  })

  it("resumes an existing session via session/load when the agent supports it", async () => {
    const { chunks, request } = baseRequest("--load", { resumeSessionId: "sess-resume-1" })
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("completed")
    expect(outcome.sessionId).toBe("sess-resume-1")
    expect(chunks.join("")).toContain("resumed sess-resume-1")
  })

  it("creates a fresh session when resume is asked for but the agent lacks loadSession", async () => {
    const { request } = baseRequest("--happy", { resumeSessionId: "sess-resume-1" })
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("completed")
    expect(outcome.sessionId).toBe("sess-fake-1")
  })

  it("cancels an in-flight prompt via session/cancel and kills the subprocess", async () => {
    const { request } = baseRequest("--slow")
    const job = AcpAgent.start(request)
    setTimeout(() => job.cancel(), 500)
    const outcome = await job.done
    expect(outcome.status).toBe("cancelled")
  })

  it("times out a prompt that never completes", async () => {
    const { request } = baseRequest("--slow", {
      limits: { ...AcpAgent.defaultAgentLimits, timeoutMillis: 800 }
    })
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("timeout")
  }, 15_000)

  it("ignores malformed and non-protocol lines on stdout", async () => {
    const { request } = baseRequest("--garbage")
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("completed")
  })

  it("drops a single oversize message without losing the rest of the stream", async () => {
    const { chunks, request } = baseRequest("--oversize", {
      limits: { ...AcpAgent.defaultAgentLimits, timeoutMillis: 10_000, maximumMessageBytes: 16 * 1024 }
    })
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("completed")
    const streamed = chunks.join("")
    expect(streamed).toContain("small before.")
    expect(streamed).toContain("small after.")
    expect(streamed).not.toContain("HUGE")
  })

  it("returns unavailable when the agent binary does not exist", async () => {
    const { request } = baseRequest("--happy", {
      agentArgv: ["/nonexistent/acp-binary-for-test", "acp"],
      agentLabel: "devin"
    })
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("unavailable")
    expect(outcome.detail).toContain("not installed")
    expect(outcome.detail).toContain("devin")
  })

  it("returns unavailable when the argv is empty", async () => {
    const { request } = baseRequest("--happy", { agentArgv: [] })
    const outcome = await AcpAgent.start(request).done
    expect(outcome.status).toBe("unavailable")
  })
})

describe("permissionAllowed", () => {
  it("refuses everything at probe tier", () => {
    expect(AcpAgent.permissionAllowed("probe", "read")).toBe(false)
    expect(AcpAgent.permissionAllowed("probe", "execute")).toBe(false)
  })

  it("allows only read-shaped kinds at curated tier", () => {
    expect(AcpAgent.permissionAllowed("curated", "read")).toBe(true)
    expect(AcpAgent.permissionAllowed("curated", "search")).toBe(true)
    expect(AcpAgent.permissionAllowed("curated", "fetch")).toBe(true)
    expect(AcpAgent.permissionAllowed("curated", "think")).toBe(true)
    expect(AcpAgent.permissionAllowed("curated", "execute")).toBe(false)
    expect(AcpAgent.permissionAllowed("curated", "edit")).toBe(false)
    expect(AcpAgent.permissionAllowed("curated", "")).toBe(false)
  })

  it("grants curated execute only for allowlisted command chains", () => {
    const query = (command: string) => ({ kind: "execute", rawInput: { command } })
    expect(AcpAgent.permissionAllowed("curated", query("gh issue create --title x"))).toBe(true)
    expect(AcpAgent.permissionAllowed("curated", query("cd /repo && gh pr list"))).toBe(true)
    expect(AcpAgent.permissionAllowed("curated", query("gh api repos | jq .name"))).toBe(false)
    expect(AcpAgent.permissionAllowed("curated", query("gh issue list; rm -rf /"))).toBe(false)
    expect(AcpAgent.permissionAllowed("curated", query("rm -rf /"))).toBe(false)
    expect(AcpAgent.permissionAllowed("curated", query("cd /repo"))).toBe(false)
    expect(AcpAgent.permissionAllowed("curated", query(""))).toBe(false)
    // Title is the fallback command source when rawInput carries none.
    expect(AcpAgent.permissionAllowed("curated", { kind: "execute", title: "gh issue view 85" })).toBe(true)
    // Operator config can widen the list; probe never grants execute.
    expect(AcpAgent.permissionAllowed("curated", query("git status"), ["gh", "git"])).toBe(true)
    expect(AcpAgent.permissionAllowed("probe", query("gh issue list"))).toBe(false)
  })

  it("allows any proposed tool at shell tier", () => {
    expect(AcpAgent.permissionAllowed("shell", "execute")).toBe(true)
    expect(AcpAgent.permissionAllowed("shell", "edit")).toBe(true)
  })
})

describe("selectPermissionOption", () => {
  const option = (optionId: string, kind: PermissionOptionKind, name = optionId) => ({ optionId, kind, name })

  it("prefers allow_once over allow_always", () => {
    const options = [option("always", "allow_always"), option("once", "allow_once")]
    expect(AcpAgent.selectPermissionOption(options, true)?.optionId).toBe("once")
  })

  it("falls back to allow_always when no one-shot grant exists", () => {
    const options = [option("always", "allow_always"), option("reject", "reject_once")]
    expect(AcpAgent.selectPermissionOption(options, true)?.optionId).toBe("always")
  })

  it("selects reject_once for denials", () => {
    const options = [option("once", "allow_once"), option("reject", "reject_once")]
    expect(AcpAgent.selectPermissionOption(options, false)?.optionId).toBe("reject")
  })

  it("never selects a bypass-style option", () => {
    const options = [option("bypass-permissions", "allow_always", "Always allow (bypassPermissions)")]
    expect(AcpAgent.selectPermissionOption(options, true)).toBeUndefined()
  })

  it("returns undefined when no acceptable option exists", () => {
    expect(AcpAgent.selectPermissionOption([], true)).toBeUndefined()
  })
})

describe("boundedLineStream", () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const collect = async (
    chunks: ReadonlyArray<string>,
    maximumMessageBytes: number
  ): Promise<Array<string>> => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      }
    })
    const lines: Array<string> = []
    const reader = AcpAgent.boundedLineStream(input, maximumMessageBytes).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return lines
      }
      lines.push(decoder.decode(value))
    }
  }

  it("passes complete lines through with their newline", async () => {
    const lines = await collect(["{\"a\":1}\n{\"b\":2}\n"], 1024)
    expect(lines).toEqual(["{\"a\":1}\n", "{\"b\":2}\n"])
  })

  it("reassembles lines split across chunks", async () => {
    const lines = await collect(["{\"a\":", "1}\n"], 1024)
    expect(lines).toEqual(["{\"a\":1}\n"])
  })

  it("drops a single oversize line and keeps the stream flowing", async () => {
    const oversized = `{"x":"${"a".repeat(200)}"}\n`
    const lines = await collect([oversized, "{\"ok\":true}\n"], 64)
    expect(lines).toEqual(["{\"ok\":true}\n"])
  })

  it("drops an oversize line even when it arrives in many chunks", async () => {
    const parts = ["{\"x\":\"", "a".repeat(100), "a".repeat(100), "\"}\n", "{\"ok\":true}\n"]
    const lines = await collect(parts, 64)
    expect(lines).toEqual(["{\"ok\":true}\n"])
  })
})

describe("updateText", () => {
  it("extracts agent message chunks", () => {
    expect(
      AcpAgent.updateText({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } })
    ).toBe("hi")
  })

  it("summarizes tool calls and plans, and drops thoughts", () => {
    expect(
      AcpAgent.updateText({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read file" })
    ).toContain("Read file")
    expect(
      AcpAgent.updateText({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "x" } })
    ).toBe("")
    expect(
      AcpAgent.updateText({
        sessionUpdate: "plan",
        entries: [{ content: "step one", priority: "high", status: "pending" }]
      })
    ).toContain("step one")
  })
})
