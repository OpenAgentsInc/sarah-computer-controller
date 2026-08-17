/**
 * ACP (Agent Client Protocol) v1 client for delegating coding work to the
 * Devin CLI. The controller is the ACP *client*: it spawns `devin acp` as a
 * subprocess (argv only, no shell), runs the initialize → session/new →
 * session/prompt handshake over newline-delimited JSON-RPC on stdio, streams
 * `session/update` notifications back through `onChunk`, answers
 * `session/request_permission` with a local policy decision, and supports
 * `session/cancel`. Everything is bounded: message size, streamed output,
 * wall-clock time, and subprocess lifetime.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawn } from "node:child_process"

import { scrubSecrets } from "./Executor.js"

export const protocolVersion = 1

export interface DevinLimits {
  /** Wall-clock ceiling for the whole delegation. */
  readonly timeoutMillis: number
  /** Streamed output ceiling. Updates beyond this are dropped. */
  readonly maximumOutputBytes: number
  /** Single JSON-RPC message ceiling in either direction. */
  readonly maximumMessageBytes: number
}

export const defaultDevinLimits: DevinLimits = {
  timeoutMillis: 240_000,
  maximumOutputBytes: 128 * 1024,
  maximumMessageBytes: 4 * 1024 * 1024
}

export type DevinStatus =
  | "completed"
  | "refused"
  | "cancelled"
  | "timeout"
  | "unavailable"
  | "failed"

export interface DevinOutcome {
  readonly status: DevinStatus
  readonly stopReason: string
  readonly sessionId: string
  readonly output: string
  readonly truncated: boolean
  readonly durationMillis: number
  readonly detail: string
}

export interface PermissionQuery {
  readonly toolCallId: string
  readonly title: string
  readonly kind: string
  readonly rawInput: unknown
}

export interface DevinRequest {
  /** Full argv of the agent process, e.g. `["/usr/local/bin/devin", "acp"]`. */
  readonly agentArgv: ReadonlyArray<string>
  readonly prompt: string
  /** Absolute working directory for the session (ACP paths must be absolute). */
  readonly cwd: string
  /** Resume an existing ACP session when the agent supports `loadSession`. */
  readonly resumeSessionId?: string | undefined
  readonly env: Record<string, string>
  readonly limits: DevinLimits
  /** Bounded, secret-scrubbed progress stream. */
  readonly onChunk: (text: string) => void
  /** Local policy decision for `session/request_permission`. */
  readonly decidePermission: (query: PermissionQuery) => boolean
}

export interface DevinJob {
  readonly done: Promise<DevinOutcome>
  readonly cancel: () => void
}

interface JsonRpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

const authRequiredCode = -32000
const methodNotFoundCode = -32601
const internalErrorCode = -32603

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const text = (value: unknown): string => (typeof value === "string" ? value : "")

class RpcFailure extends Error {
  readonly rpc: JsonRpcError
  constructor(rpc: JsonRpcError) {
    super(rpc.message)
    this.rpc = rpc
  }
}

/** Extract human-readable progress text from one `session/update` payload. */
export const updateText = (update: Record<string, unknown>): string => {
  const kind = text(update["sessionUpdate"])
  switch (kind) {
    case "agent_message_chunk": {
      const content = record(update["content"])
      return content["type"] === "text" ? text(content["text"]) : ""
    }
    case "agent_thought_chunk":
      return ""
    case "tool_call": {
      const title = text(update["title"])
      return title === "" ? "" : `\n[tool] ${title}\n`
    }
    case "tool_call_update": {
      const status = text(update["status"])
      if (status !== "completed" && status !== "failed") {
        return ""
      }
      return `[tool ${status}]\n`
    }
    case "plan": {
      const entries = Array.isArray(update["entries"]) ? update["entries"] : []
      const lines = entries
        .map((entry) => text(record(entry)["content"]))
        .filter((line) => line !== "")
      return lines.length === 0 ? "" : `\n[plan]\n${lines.map((line) => `- ${line}`).join("\n")}\n`
    }
    default:
      return ""
  }
}

/**
 * Split a stdio byte stream into newline-delimited JSON-RPC messages, dropping
 * any single message larger than the limit so a runaway agent cannot exhaust
 * memory. Malformed lines are ignored per the robustness rule for transports.
 */
export class LineBuffer {
  private buffer = ""
  private readonly maximumMessageBytes: number

  constructor(maximumMessageBytes: number) {
    this.maximumMessageBytes = maximumMessageBytes
  }

  push(chunk: string): ReadonlyArray<Record<string, unknown>> {
    this.buffer += chunk
    if (this.buffer.length > this.maximumMessageBytes && !this.buffer.includes("\n")) {
      this.buffer = ""
      return []
    }
    const messages: Array<Record<string, unknown>> = []
    let index = this.buffer.indexOf("\n")
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== "" && line.length <= this.maximumMessageBytes) {
        try {
          const parsed: unknown = JSON.parse(line)
          const message = record(parsed)
          if (message["jsonrpc"] === "2.0") {
            messages.push(message)
          }
        } catch {
          // Not valid JSON — ignored, the protocol forbids non-message output.
        }
      }
      index = this.buffer.indexOf("\n")
    }
    return messages
  }
}

/**
 * Start a Devin delegation. Returns immediately with a cancel handle; `done`
 * settles exactly once with a typed outcome and the subprocess is always
 * terminated by the time it does.
 */
export const start = (request: DevinRequest): DevinJob => {
  const startedAt = Date.now()
  let child: ChildProcessWithoutNullStreams
  let settled = false
  let cancelled = false
  let timedOut = false
  let sessionId = ""
  let outputBytes = 0
  let truncated = false
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: RpcFailure) => void }>()
  let resolveDone: (outcome: DevinOutcome) => void
  const done = new Promise<DevinOutcome>((resolve) => {
    resolveDone = resolve
  })

  const settle = (outcome: Omit<DevinOutcome, "durationMillis" | "sessionId" | "truncated">): void => {
    if (settled) {
      return
    }
    settled = true
    for (const entry of pending.values()) {
      entry.reject(new RpcFailure({ code: internalErrorCode, message: "connection closed" }))
    }
    pending.clear()
    try {
      child.kill("SIGTERM")
      setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // already gone
        }
      }, 3_000).unref()
    } catch {
      // never spawned or already gone
    }
    resolveDone({ ...outcome, sessionId, truncated, durationMillis: Date.now() - startedAt })
  }

  const emit = (raw: string): void => {
    if (raw === "" || outputBytes >= request.limits.maximumOutputBytes) {
      if (raw !== "" && !truncated && outputBytes >= request.limits.maximumOutputBytes) {
        truncated = true
      }
      return
    }
    const scrubbed = scrubSecrets(raw)
    const remaining = request.limits.maximumOutputBytes - outputBytes
    const bounded = scrubbed.length > remaining ? scrubbed.slice(0, remaining) : scrubbed
    truncated = truncated || bounded.length < scrubbed.length
    outputBytes += bounded.length
    request.onChunk(bounded)
  }

  const send = (message: Record<string, unknown>): void => {
    if (settled || child.stdin.destroyed) {
      return
    }
    const encoded = JSON.stringify(message)
    if (encoded.length > request.limits.maximumMessageBytes) {
      return
    }
    child.stdin.write(`${encoded}\n`)
  }

  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId
      nextId += 1
      pending.set(id, { resolve, reject })
      send({ jsonrpc: "2.0", id, method, params })
    })

  const notify = (method: string, params: unknown): void => {
    send({ jsonrpc: "2.0", method, params })
  }

  const respond = (id: unknown, result: unknown): void => {
    send({ jsonrpc: "2.0", id: id as number | string, result })
  }

  const respondError = (id: unknown, error: JsonRpcError): void => {
    send({ jsonrpc: "2.0", id: id as number | string, error })
  }

  const handlePermission = (id: unknown, params: Record<string, unknown>): void => {
    if (cancelled || timedOut) {
      respond(id, { outcome: { outcome: "cancelled" } })
      return
    }
    const toolCall = record(params["toolCall"])
    const options = Array.isArray(params["options"]) ? params["options"].map(record) : []
    const allowed = request.decidePermission({
      toolCallId: text(toolCall["toolCallId"]),
      title: text(toolCall["title"]),
      kind: text(toolCall["kind"]),
      rawInput: toolCall["rawInput"]
    })
    const wanted = allowed ? "allow_once" : "reject_once"
    const option = options.find((entry) => entry["kind"] === wanted) ??
      options.find((entry) => text(entry["kind"]).startsWith(allowed ? "allow" : "reject"))
    if (option === undefined) {
      respond(id, { outcome: { outcome: "cancelled" } })
      return
    }
    emit(`\n[permission ${allowed ? "granted" : "denied"}] ${text(toolCall["title"]) || text(toolCall["kind"])}\n`)
    respond(id, { outcome: { outcome: "selected", optionId: text(option["optionId"]) } })
  }

  const handleMessage = (message: Record<string, unknown>): void => {
    const id = message["id"]
    const method = message["method"]

    if (typeof method === "string") {
      const params = record(message["params"])
      if (method === "session/update") {
        emit(updateText(record(params["update"])))
        return
      }
      if (id === undefined || id === null) {
        return
      }
      if (method === "session/request_permission") {
        handlePermission(id, params)
        return
      }
      // fs/* and terminal/* were not advertised in clientCapabilities, so a
      // conforming agent never calls them. Refuse anything unexpected.
      respondError(id, { code: methodNotFoundCode, message: `method not supported: ${method}` })
      return
    }

    if (typeof id === "number") {
      const entry = pending.get(id)
      if (entry === undefined) {
        return
      }
      pending.delete(id)
      const error = message["error"]
      if (error !== undefined && error !== null) {
        const rpc = record(error)
        entry.reject(
          new RpcFailure({ code: Number(rpc["code"] ?? internalErrorCode), message: text(rpc["message"]) })
        )
      } else {
        entry.resolve(message["result"])
      }
    }
  }

  const run = async (): Promise<void> => {
    const initialized = record(
      await call("initialize", {
        protocolVersion,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "sarah-computer-controller", title: "Sarah Computer Controller", version: "0.1.0" }
      })
    )
    if (initialized["protocolVersion"] !== protocolVersion) {
      settle({
        status: "unavailable",
        stopReason: "",
        output: "",
        detail: `agent negotiated unsupported protocol version ${String(initialized["protocolVersion"])}`
      })
      return
    }
    const capabilities = record(initialized["agentCapabilities"])
    const authMethods = Array.isArray(initialized["authMethods"]) ? initialized["authMethods"].map(record) : []

    const createSession = (): Promise<unknown> =>
      request.resumeSessionId !== undefined && capabilities["loadSession"] === true
        ? call("session/load", { sessionId: request.resumeSessionId, cwd: request.cwd, mcpServers: [] })
        : call("session/new", { cwd: request.cwd, mcpServers: [] })

    let session: Record<string, unknown>
    try {
      session = record(await createSession())
    } catch (failure) {
      if (failure instanceof RpcFailure && failure.rpc.code === authRequiredCode && authMethods.length > 0) {
        const methodId = text(authMethods[0]?.["id"])
        try {
          await call("authenticate", { methodId })
          session = record(await createSession())
        } catch {
          settle({
            status: "unavailable",
            stopReason: "",
            output: "",
            detail: "devin requires authentication on this machine; run `devin` once to log in"
          })
          return
        }
      } else {
        throw failure
      }
    }

    sessionId = request.resumeSessionId !== undefined && capabilities["loadSession"] === true
      ? request.resumeSessionId
      : text(session["sessionId"])

    const result = record(
      await call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: request.prompt }]
      })
    )
    const stopReason = text(result["stopReason"])
    const status: DevinStatus = stopReason === "refusal"
      ? "refused"
      : stopReason === "cancelled"
      ? (timedOut ? "timeout" : "cancelled")
      : "completed"
    settle({ status, stopReason, output: "", detail: "" })
  }

  const [command, ...args] = request.agentArgv
  if (command === undefined) {
    child = undefined as unknown as ChildProcessWithoutNullStreams
    setTimeout(() => settle({ status: "unavailable", stopReason: "", output: "", detail: "devin is not installed" }), 0)
    return { done, cancel: () => undefined }
  }

  child = spawn(command, args, { cwd: request.cwd, env: request.env, shell: false, stdio: ["pipe", "pipe", "pipe"] })

  const lines = new LineBuffer(request.limits.maximumMessageBytes)
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    for (const message of lines.push(chunk)) {
      handleMessage(message)
    }
  })
  child.stderr.resume()

  child.on("error", (cause: NodeJS.ErrnoException) => {
    settle({
      status: "unavailable",
      stopReason: "",
      output: "",
      detail: cause.code === "ENOENT"
        ? "devin is not installed on this machine"
        : `devin failed to start: ${cause.message}`
    })
  })

  child.on("exit", (code) => {
    settle({
      status: cancelled ? "cancelled" : timedOut ? "timeout" : "failed",
      stopReason: "",
      output: "",
      detail: `devin exited before completing (exit code ${String(code)})`
    })
  })

  const timeout = setTimeout(() => {
    timedOut = true
    if (sessionId !== "") {
      notify("session/cancel", { sessionId })
    }
    setTimeout(() => settle({ status: "timeout", stopReason: "", output: "", detail: "delegation timed out" }), 5_000)
      .unref()
  }, request.limits.timeoutMillis)
  timeout.unref()

  run()
    .catch((failure: unknown) => {
      const detail = failure instanceof RpcFailure
        ? `devin reported an error: ${failure.rpc.message} (${failure.rpc.code})`
        : `delegation failed: ${failure instanceof Error ? failure.message : String(failure)}`
      settle({ status: "failed", stopReason: "", output: "", detail })
    })
    .finally(() => clearTimeout(timeout))

  return {
    done,
    cancel: () => {
      cancelled = true
      if (sessionId !== "") {
        notify("session/cancel", { sessionId })
      }
      setTimeout(
        () => settle({ status: "cancelled", stopReason: "cancelled", output: "", detail: "cancelled by request" }),
        5_000
      ).unref()
    }
  }
}
