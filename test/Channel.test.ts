import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import type WebSocket from "ws"

import * as Channel from "../src/Channel.js"

type Frame = [string | null, string | null, string, string, unknown]

interface AgentCall {
  readonly requestId: string
  readonly agentId: string
  readonly payload: Record<string, unknown>
}

const machineId = "machine-test"
const topic = `computer:${machineId}`

let server: WebSocketServer | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

/**
 * Serve one scripted exchange: accept the join, deliver the given events,
 * then close once the expected number of agent dispatches happened.
 */
const scripted = async (
  events: ReadonlyArray<{ event: string; payload: Record<string, unknown> }>,
  expectedAgentCalls: number
): Promise<{ agentCalls: Array<AgentCall>; pushes: Array<Frame> }> => {
  const agentCalls: Array<AgentCall> = []
  const pushes: Array<Frame> = []

  server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => server?.once("listening", resolve))
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0

  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Frame
      const [joinRef, ref, frameTopic, event] = frame
      if (event === "phx_join") {
        socket.send(JSON.stringify([joinRef, ref, frameTopic, "phx_reply", { status: "ok", response: {} }]))
        let counter = 100
        for (const entry of events) {
          counter += 1
          socket.send(JSON.stringify([null, String(counter), topic, entry.event, entry.payload]))
        }
        return
      }
      if (frameTopic === topic && event !== "hello") {
        pushes.push(frame)
      }
    })
  })

  const maybeFinish = (socketClose: () => void): void => {
    if (agentCalls.length >= expectedAgentCalls) {
      socketClose()
    }
  }

  const reason = await Channel.serve(
    {
      endpoint: `http://127.0.0.1:${port}`,
      token: "token-test",
      machineId,
      hello: { agent_version: "test" },
      heartbeatMillis: 60_000
    },
    {
      onProbe: () => Promise.resolve({}),
      onRun: () => undefined,
      onAgent: (requestId, agentId, payload, respond) => {
        agentCalls.push({ agentId, payload, requestId })
        respond.exit({ status: "completed", agent_id: agentId })
        maybeFinish(() => server?.clients.forEach((client) => client.close()))
      },
      onCancel: () => undefined,
      onClosed: () => undefined,
      onJoined: () => undefined,
      onEvent: () => undefined
    }
  )
  expect(reason).toBe("closed")
  return { agentCalls, pushes }
}

describe("Channel agent dispatch", () => {
  it("dispatches the agent event with its agent_id and pushes the terminal exit", async () => {
    const { agentCalls, pushes } = await scripted(
      [{
        event: "agent",
        payload: { request_id: "req-agent-1", agent_id: "claude", prompt: "hello" }
      }],
      1
    )
    expect(agentCalls).toHaveLength(1)
    expect(agentCalls[0]?.agentId).toBe("claude")
    expect(agentCalls[0]?.requestId).toBe("req-agent-1")
    expect(agentCalls[0]?.payload["prompt"]).toBe("hello")

    const exit = pushes.find((frame) => frame[3] === "exit")
    expect(exit).toBeDefined()
    const body = exit?.[4] as Record<string, unknown>
    expect(body["request_id"]).toBe("req-agent-1")
    expect(body["status"]).toBe("completed")
    expect(body["agent_id"]).toBe("claude")
  })

  it("maps the legacy devin event to agent_id devin", async () => {
    const { agentCalls } = await scripted(
      [{
        event: "devin",
        payload: { request_id: "req-devin-1", prompt: "hello" }
      }],
      1
    )
    expect(agentCalls).toHaveLength(1)
    expect(agentCalls[0]?.agentId).toBe("devin")
    expect(agentCalls[0]?.requestId).toBe("req-devin-1")
  })

  it("passes an empty agent_id through for the dispatcher to refuse", async () => {
    const { agentCalls } = await scripted(
      [{
        event: "agent",
        payload: { request_id: "req-agent-2", prompt: "hello" }
      }],
      1
    )
    expect(agentCalls[0]?.agentId).toBe("")
  })
})
