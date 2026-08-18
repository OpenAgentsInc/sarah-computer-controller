// A minimal ACP v1 agent used by AcpAgent tests. Speaks newline-delimited
// JSON-RPC on stdio, exactly like `devin acp` or `claude-agent-acp`.
// Behavior is selected with a single argv flag so tests can exercise each
// handshake state.
//
//   node fake-acp-agent.mjs                 happy path with streamed updates
//   node fake-acp-agent.mjs --permission    asks permission before finishing
//   node fake-acp-agent.mjs --permission-bypass  offers only bypass/reject permission options
//   node fake-acp-agent.mjs --auth          requires authenticate before session/new
//   node fake-acp-agent.mjs --auth-strict   authentication always fails
//   node fake-acp-agent.mjs --slow          never completes the prompt (for cancel/timeout)
//   node fake-acp-agent.mjs --refuse        prompt ends with stopReason "refusal"
//   node fake-acp-agent.mjs --garbage       emits malformed lines between messages
//   node fake-acp-agent.mjs --load          supports loadSession; resumes sessions
//   node fake-acp-agent.mjs --oversize      streams one oversize update line before finishing

import process from "node:process"
import * as readline from "node:readline"

const mode = process.argv[2] ?? "--happy"
let authenticated = mode !== "--auth" && mode !== "--auth-strict"
let nextOutboundId = 1000
let pendingPromptId = null
const pendingOutbound = new Map()

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const reply = (id, result) => send({ jsonrpc: "2.0", id, result })
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } })

const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextOutboundId++
    pendingOutbound.set(id, resolve)
    send({ jsonrpc: "2.0", id, method, params })
  })

const streamText = (sessionId, text) => {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
    }
  })
}

const rl = readline.createInterface({ input: process.stdin })

rl.on("line", (line) => {
  if (line.trim() === "") return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (typeof message.id === "number" && pendingOutbound.has(message.id)) {
    pendingOutbound.get(message.id)(message.result)
    pendingOutbound.delete(message.id)
    return
  }

  const { id, method, params } = message

  if (method === "initialize") {
    if (mode === "--garbage") {
      process.stdout.write("this is not json\n")
      process.stdout.write(`${JSON.stringify({ noise: true })}\n`)
    }
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: mode === "--load" },
      agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
      authMethods: mode === "--auth" || mode === "--auth-strict"
        ? [{ id: "fake-login", name: "Fake login", description: "test auth" }]
        : []
    })
    return
  }

  if (method === "session/load") {
    if (mode !== "--load") {
      fail(id, -32601, "method not found: session/load")
      return
    }
    streamText(params.sessionId, `resumed ${params.sessionId}. `)
    reply(id, {})
    return
  }

  if (method === "authenticate") {
    if (mode === "--auth-strict") {
      fail(id, -32603, "authentication failed")
    } else {
      authenticated = true
      reply(id, {})
    }
    return
  }

  if (method === "session/new") {
    if (!authenticated) {
      fail(id, -32000, "authentication required")
      return
    }
    reply(id, { sessionId: "sess-fake-1" })
    return
  }

  if (method === "session/prompt") {
    const sessionId = params.sessionId
    if (mode === "--slow") {
      pendingPromptId = id
      return // never respond until cancelled; timeout must clean up
    }
    if (mode === "--refuse") {
      reply(id, { stopReason: "refusal" })
      return
    }
    if (mode === "--oversize") {
      streamText(sessionId, "small before. ")
      streamText(sessionId, `HUGE:${"x".repeat(64 * 1024)}`)
      streamText(sessionId, "small after. ")
      reply(id, { stopReason: "end_turn" })
      return
    }
    streamText(sessionId, "working on it… ")
    if (mode === "--permission-bypass") {
      request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "call-2", title: "Run anything", kind: "execute", rawInput: {} },
        options: [
          { optionId: "bypass-permissions", name: "Always allow (bypassPermissions)", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      }).then((result) => {
        const outcome = result?.outcome
        if (outcome?.outcome === "selected" && outcome.optionId === "bypass-permissions") {
          streamText(sessionId, "BYPASSED! ")
          reply(id, { stopReason: "end_turn" })
        } else {
          reply(id, { stopReason: "refusal" })
        }
      })
      return
    }
    if (mode === "--permission") {
      request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "call-1", title: "Run ls", kind: "execute", rawInput: { command: "ls" } },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      }).then((result) => {
        const outcome = result?.outcome
        if (outcome?.outcome === "selected" && outcome.optionId === "allow-once") {
          streamText(sessionId, "permitted, done. ")
          reply(id, { stopReason: "end_turn" })
        } else {
          reply(id, { stopReason: "refusal" })
        }
      })
      return
    }
    streamText(sessionId, "finished. ")
    reply(id, { stopReason: "end_turn" })
    return
  }

  if (method === "session/cancel") {
    // Notification: answer the pending prompt with "cancelled".
    if (pendingPromptId !== null) {
      reply(pendingPromptId, { stopReason: "cancelled" })
      pendingPromptId = null
    }
    return
  }

  if (typeof id === "number") {
    fail(id, -32601, `method not found: ${method}`)
  }
})
