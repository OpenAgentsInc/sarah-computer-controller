/**
 * Any-agent ACP (Agent Client Protocol) v1 client. The controller is the ACP
 * *client*: it spawns an agent adapter as a subprocess (argv only, no shell),
 * runs the initialize → session/new → session/prompt handshake through the
 * official `@agentclientprotocol/sdk` connection, streams `session/update`
 * notifications back through `onChunk`, answers `session/request_permission`
 * with a local tier-aware policy decision, and supports `session/cancel`.
 *
 * The SDK owns the JSON-RPC framing; the hard bounds stay ours, wrapped
 * around the byte streams: per-message size cap in both directions, streamed
 * output ceiling, wall-clock ceiling, the subprocess always reaped, and
 * secret scrubbing on everything emitted. Client capabilities are minimal
 * (no fs, no terminal) and any agent→client method we did not register is
 * refused by the SDK with a method-not-found error.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawn } from "node:child_process"
import { Readable } from "node:stream"

import * as acp from "@agentclientprotocol/sdk"

import { scrubSecrets } from "./Executor.js"
import type { Tier } from "./Policy.js"

export const protocolVersion = 1

export interface AgentLimits {
  /** Wall-clock ceiling for the whole delegation. */
  readonly timeoutMillis: number
  /** Streamed output ceiling. Updates beyond this are dropped. */
  readonly maximumOutputBytes: number
  /** Single JSON-RPC message ceiling in either direction. */
  readonly maximumMessageBytes: number
}

export const defaultAgentLimits: AgentLimits = {
  timeoutMillis: 240_000,
  maximumOutputBytes: 128 * 1024,
  maximumMessageBytes: 4 * 1024 * 1024
}

export type AgentStatus =
  | "completed"
  | "refused"
  | "cancelled"
  | "timeout"
  | "unavailable"
  | "failed"

export interface AuthMethodSummary {
  readonly id: string
  readonly name: string
}

export interface AgentOutcome {
  readonly status: AgentStatus
  readonly stopReason: string
  readonly sessionId: string
  /** Bounded, secret-scrubbed copy of everything streamed through onChunk. */
  readonly output: string
  readonly truncated: boolean
  readonly durationMillis: number
  readonly detail: string
  /** Agent-advertised capabilities, recorded for Sarah-side evidence. */
  readonly agentCapabilities: Record<string, unknown>
  /** Agent-advertised auth methods, recorded for Sarah-side evidence. */
  readonly authMethods: ReadonlyArray<AuthMethodSummary>
}

export interface PermissionQuery {
  readonly toolCallId: string
  readonly title: string
  readonly kind: string
  readonly rawInput: unknown
}

export interface AgentRequest {
  /** Full argv of the agent process, e.g. `["/usr/local/bin/devin", "acp"]`. */
  readonly agentArgv: ReadonlyArray<string>
  readonly prompt: string
  /** Absolute working directory for the session (ACP paths must be absolute). */
  readonly cwd: string
  /** Resume an existing ACP session when the agent supports `loadSession`. */
  readonly resumeSessionId?: string | undefined
  readonly env: Record<string, string>
  readonly limits: AgentLimits
  /** Bounded, secret-scrubbed progress stream. */
  readonly onChunk: (text: string) => void
  /** Called once with the ACP session id as soon as session/new returns, before
   * streaming — lets the server checkpoint it for re-attach (M2). Optional. */
  readonly onSession?: (sessionId: string) => void
  /** Local policy decision for `session/request_permission`. */
  readonly decidePermission: (query: PermissionQuery) => boolean
  /** Human-readable agent name used in detail messages. Defaults to "agent". */
  readonly agentLabel?: string | undefined
}

export interface AgentJob {
  readonly done: Promise<AgentOutcome>
  readonly cancel: () => void
}

/**
 * ACP tool-call kinds that are read-shaped: they observe but do not mutate the
 * machine. This is the per-kind allowlist the `curated` tier grants.
 */
export const readShapedPermissionKinds: ReadonlyArray<string> = ["read", "search", "fetch", "think"]

/**
 * File-mutating ACP kinds a curated-tier coding delegation may grant, when
 * the target path is inside a declared root (or no path is known because
 * cwd is already constrained to a root). `move` and `delete` stay denied.
 */
export const writeShapedPermissionKinds: ReadonlyArray<string> = ["edit", "write"]

/**
 * Execute-kind commands the `curated` tier may additionally grant to a
 * delegated coding agent. Owner opt-in, widened 2026-08-18: a delegated agent
 * that cannot even `ls`/`cat`/`git status`/`git log` to read the repo it was
 * asked to change is a broken loop — the earlier `["gh"]`-only list denied
 * every exploration command Claude Code proposed. The set is the curated
 * dev loop: read/inspect tools, version control, and the package/build/test
 * runners a coding task needs to verify its own work, on the owner's own
 * paired machine. It is named programs, never patterns; `cd` is tolerated
 * only as a chain prefix; and it deliberately excludes shell interpreters
 * (`bash`/`sh`/`zsh`), arbitrary-exec launchers (`env`/`xargs`/`eval`), and
 * privilege/remote tools (`sudo`/`ssh`) so the per-segment chain guard stays
 * meaningful. The compiled-in denied-command floor still applies to direct
 * `run`; delegated agents edit files through their own in-process tools, not
 * this shell surface. Operators can widen or clear it via the machine config
 * `curatedExecute`.
 */
export const defaultCuratedExecute: ReadonlyArray<string> = [
  "git",
  "gh",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "which",
  "find",
  "rg",
  "grep",
  "sed",
  "awk",
  "sort",
  "uniq",
  "cut",
  "diff",
  "echo",
  "stat",
  "file",
  "node",
  "npm",
  "npx",
  "pnpm",
  "python3",
  "cargo",
  "go",
  "make",
  "mix"
]

/**
 * True when every `&&` / `||` / `;` / `|` / newline segment of the command
 * starts with an allowlisted program (or `cd`), and at least one segment
 * actually runs an allowlisted program. Conservative on purpose: any
 * unrecognized segment head — including pipe targets — refuses the whole
 * command.
 */
export const commandChainAllowed = (
  command: string,
  allowlist: ReadonlyArray<string>
): boolean => {
  const segments = command.split(/&&|\|\||;|\||\n/)
  let sawAllowlisted = false
  for (const segment of segments) {
    const first = segment.trim().split(/\s+/)[0] ?? ""
    if (first === "") {
      return false
    }
    if (first === "cd") {
      continue
    }
    if (!allowlist.includes(first)) {
      return false
    }
    sawAllowlisted = true
  }
  return sawAllowlisted
}

/** The fields of a permission request that local policy examines. */
export interface PermissionPolicyQuery {
  readonly kind: string
  readonly title?: string
  readonly rawInput?: unknown
}

/**
 * Which ACP permission requests the local tier grants. `shell` allows any
 * tool the agent proposes (each grant is still a one-shot `allow_once`);
 * `curated` allows read-shaped tool kinds, file edits/writes under declared
 * roots, and execute commands whose every chain segment is on the named
 * `curatedExecute` allowlist; `probe` (and anything unrecognized) is refused.
 * Never maps to an "always" grant on its own.
 */
export const permissionAllowed = (
  tier: Tier,
  query: string | PermissionPolicyQuery,
  curatedExecute: ReadonlyArray<string> = defaultCuratedExecute,
  roots: ReadonlyArray<string> = []
): boolean => {
  const normalized: PermissionPolicyQuery = typeof query === "string" ? { kind: query } : query
  if (tier === "shell") {
    return true
  }
  if (tier === "curated") {
    if (readShapedPermissionKinds.includes(normalized.kind)) {
      return true
    }
    if (writeShapedPermissionKinds.includes(normalized.kind)) {
      return writePathAllowed(normalized, roots)
    }
    if (normalized.kind === "execute") {
      const raw = normalized.rawInput as Record<string, unknown> | undefined
      const fromInput = raw !== undefined && typeof raw["command"] === "string" ? (raw["command"] as string) : ""
      const command = fromInput !== "" ? fromInput : (normalized.title ?? "")
      return command !== "" && commandChainAllowed(command, curatedExecute)
    }
    return false
  }
  return false
}

const writePathAllowed = (query: PermissionPolicyQuery, roots: ReadonlyArray<string>): boolean => {
  const filePath = extractFilePath(query.rawInput)
  if (filePath === undefined || filePath === "") {
    return true
  }
  if (roots.length === 0) {
    return true
  }
  const absolute = filePath.startsWith("/") ? filePath : `${roots[0] ?? ""}/${filePath}`
  return roots.some((root) => pathUnderRoot(absolute, root))
}

const extractFilePath = (rawInput: unknown): string | undefined => {
  const raw = asRecord(rawInput)
  if (raw === undefined) {
    return undefined
  }
  for (const key of ["path", "file_path", "filePath", "file"]) {
    const value = raw[key]
    if (typeof value === "string" && value !== "") {
      return value
    }
  }
  return undefined
}

const pathUnderRoot = (candidate: string, root: string): boolean => {
  const target = candidate.replace(/\/+$/, "")
  const base = root.replace(/\/+$/, "")
  return target === base || target.startsWith(`${base}/`)
}

/**
 * Permission options the controller never selects, regardless of policy:
 * anything that reads as a blanket bypass of the agent's own permission
 * prompts. Rejecting these is compiled in, like the denied-command list.
 */
const looksLikeBypass = (option: acp.PermissionOption): boolean =>
  /bypass/i.test(option.optionId) || /bypass/i.test(option.name) || /bypass/i.test(option.kind)

/**
 * Pick the option that answers a permission request under local policy.
 * Prefers the conservative one-shot grant (`allow_once`) over persistent
 * grants, and never selects a bypass-style option. Returns undefined when no
 * acceptable option exists, in which case the request is answered "cancelled".
 */
export const selectPermissionOption = (
  options: ReadonlyArray<acp.PermissionOption>,
  allowed: boolean
): acp.PermissionOption | undefined => {
  const acceptable = options.filter((option) => !looksLikeBypass(option))
  const preference: ReadonlyArray<string> = allowed
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"]
  for (const kind of preference) {
    const match = acceptable.find((option) => option.kind === kind)
    if (match !== undefined) {
      return match
    }
  }
  return undefined
}

/**
 * A rendered `session/update`: `stream` is what the live rail receives —
 * structured tool frames plus prose — and `durable` is the clean readable
 * copy accumulated into the delegation's persisted output. Splitting them
 * keeps the rail rich while the durable record stays free of control bytes.
 */
export interface RenderedUpdate {
  readonly stream: string
  readonly durable: string
}

/**
 * Frame delimiters for structured events carried inside the plain-text stream.
 * A frame is one line that begins with RS (record separator) and splits its
 * fields on US (unit separator); everything else in the stream is prose. The
 * Sarah rail parses frames into collapsible tool cards; the delimiters are
 * control bytes so they never collide with agent prose. Titles, commands, and
 * output are base64 so their own newlines and separators survive intact.
 */
const RS = ""
const US = ""

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64")

/**
 * One tool frame: `RS T US <id> US <phase> US <kind> US <b64 title> US <b64 detail>`.
 * phase 0 = started (detail is the command), 1 = completed, 2 = failed
 * (detail is a bounded output/error snippet). A note frame is
 * `RS N US <b64 text> US <tone>`.
 */
const toolFrame = (
  id: string,
  phase: 0 | 1 | 2,
  kind: string,
  title: string,
  detail: string
): string => `${RS}T${US}${id}${US}${phase}${US}${kind}${US}${b64(title)}${US}${b64(detail)}\n`

const noteFrame = (text: string, tone: "info" | "warn" | "error"): string => `${RS}N${US}${b64(text)}${US}${tone}\n`

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const out = value.trim()
  return out === "" ? undefined : out
}

/** Join a command that may arrive as a string or an argv array. */
const commandValue = (value: unknown): string | undefined => {
  const direct = trimmed(value)
  if (direct !== undefined) {
    return direct
  }
  if (!Array.isArray(value)) {
    return undefined
  }
  const parts = value.map((entry) => trimmed(entry)).filter((part): part is string => part !== undefined)
  return parts.length === 0 ? undefined : parts.join(" ")
}

/**
 * Best-effort command extraction from a tool call's raw input or title, ported
 * from t3code's tool-activity reader: prefer an explicit `command`, then an
 * `executable`+`args` pair, then a backticked fragment in the title.
 */
const extractCommand = (rawInput: unknown, title: string): string | undefined => {
  const raw = asRecord(rawInput)
  const fromCommand = commandValue(raw?.["command"])
  if (fromCommand !== undefined) {
    return fromCommand
  }
  const executable = trimmed(raw?.["executable"])
  const args = commandValue(raw?.["args"])
  if (executable !== undefined) {
    return args !== undefined ? `${executable} ${args}` : executable
  }
  const backtick = /`([^`]+)`/u.exec(title)
  return trimmed(backtick?.[1])
}

/** Pull displayable text out of a tool call's content blocks. */
const extractContentText = (content: unknown): string => {
  if (!Array.isArray(content)) {
    return ""
  }
  const parts: Array<string> = []
  for (const entry of content) {
    const record = asRecord(entry)
    if (record === undefined) {
      continue
    }
    const inner = asRecord(record["content"])
    const text = trimmed(inner?.["text"]) ?? trimmed(record["text"]) ?? trimmed(record["content"])
    if (text !== undefined) {
      parts.push(text)
    }
  }
  return parts.join("\n")
}

/** Strip a trailing `<exited with exit code N>` marker Claude Code appends. */
const stripExitMarker = (value: string): string => value.replace(/\s*<exited with exit code \d+>\s*$/iu, "").trim()

const maximumDetailChars = 1_400

const boundedDetail = (value: string): string =>
  value.length > maximumDetailChars ? `${value.slice(0, maximumDetailChars)}\n…` : value

/**
 * Render one `session/update` into a rail stream string (structured frames +
 * prose) and a clean durable string. Every user-derived field is scrubbed of
 * secrets here, before framing, so the base64 payloads the rail parses are
 * already safe and the caller does not scrub again.
 */
export const renderUpdate = (update: acp.SessionUpdate): RenderedUpdate => {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = update.content.type === "text" ? scrubSecrets(update.content.text) : ""
      return { stream: text, durable: text }
    }
    case "agent_thought_chunk":
      return { stream: "", durable: "" }
    case "tool_call": {
      const id = update.toolCallId
      const kind = update.kind ?? "other"
      const title = scrubSecrets(update.title ?? "")
      const command = extractCommand(update.rawInput, title)
      const detail = command !== undefined ? scrubSecrets(command) : ""
      const durable = detail !== "" ? `\n$ ${detail}\n` : title !== "" ? `\n[${kind}] ${title}\n` : ""
      return { stream: toolFrame(id, 0, kind, title, detail), durable }
    }
    case "tool_call_update": {
      const status = update.status
      if (status !== "completed" && status !== "failed") {
        return { stream: "", durable: "" }
      }
      const id = update.toolCallId
      const kind = update.kind ?? "other"
      const title = scrubSecrets(update.title ?? "")
      const output = boundedDetail(stripExitMarker(scrubSecrets(extractContentText(update.content))))
      const durable = status === "failed" && output !== "" ? `  ✗ ${output.split("\n")[0]}\n` : ""
      return { stream: toolFrame(id, status === "completed" ? 1 : 2, kind, title, output), durable }
    }
    case "plan": {
      const lines = update.entries
        .map((entry) => scrubSecrets(entry.content))
        .filter((line) => line !== "")
      if (lines.length === 0) {
        return { stream: "", durable: "" }
      }
      const text = `Plan:\n${lines.map((line) => `- ${line}`).join("\n")}`
      return { stream: noteFrame(text, "info"), durable: `\n[plan]\n${lines.map((line) => `- ${line}`).join("\n")}\n` }
    }
    default:
      return { stream: "", durable: "" }
  }
}

const newline = 0x0a

/**
 * Bound a byte stream of newline-delimited messages so no single message
 * larger than the limit ever reaches the JSON-RPC parser. Oversize lines are
 * dropped whole — a runaway agent cannot exhaust the controller's memory —
 * and everything else passes through untouched.
 */
export const boundedLineStream = (
  input: ReadableStream<Uint8Array>,
  maximumMessageBytes: number
): ReadableStream<Uint8Array> => {
  let pending: Array<Uint8Array> = []
  let pendingBytes = 0
  let dropping = false

  const completeLine = (tail: Uint8Array): Uint8Array => {
    const line = new Uint8Array(pendingBytes + tail.byteLength + 1)
    let offset = 0
    for (const part of pending) {
      line.set(part, offset)
      offset += part.byteLength
    }
    line.set(tail, offset)
    line[line.byteLength - 1] = newline
    pending = []
    pendingBytes = 0
    return line
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let start = 0
      let index = chunk.indexOf(newline, start)
      while (index !== -1) {
        const tail = chunk.subarray(start, index)
        if (dropping) {
          dropping = false
          pending = []
          pendingBytes = 0
        } else if (pendingBytes + tail.byteLength <= maximumMessageBytes) {
          controller.enqueue(completeLine(tail))
        } else {
          pending = []
          pendingBytes = 0
        }
        start = index + 1
        index = chunk.indexOf(newline, start)
      }
      if (start < chunk.byteLength) {
        const tail = new Uint8Array(chunk.subarray(start))
        if (!dropping) {
          if (pendingBytes + tail.byteLength > maximumMessageBytes) {
            dropping = true
            pending = []
            pendingBytes = 0
          } else {
            pending.push(tail)
            pendingBytes += tail.byteLength
          }
        }
      }
    }
  })

  return input.pipeThrough(transform)
}

const authRequiredCode = -32000

const summarizeAuthMethods = (methods: ReadonlyArray<AuthMethodSummary>): string =>
  methods.map((method) => (method.name !== "" ? `${method.id} (${method.name})` : method.id)).join(", ")

/**
 * Start an agent delegation. Returns immediately with a cancel handle; `done`
 * settles exactly once with a typed outcome and the subprocess is always
 * terminated by the time it does.
 */
export const start = (request: AgentRequest): AgentJob => {
  const startedAt = Date.now()
  const label = request.agentLabel ?? "agent"
  let settled = false
  let cancelled = false
  let timedOut = false
  let sessionId = ""
  let outputBytes = 0
  let streamBytes = 0
  let truncated = false
  let outputText = ""
  let agentCapabilities: Record<string, unknown> = {}
  let authMethods: ReadonlyArray<AuthMethodSummary> = []
  let connection: acp.ClientContext | undefined
  let resolveDone: (outcome: AgentOutcome) => void
  const done = new Promise<AgentOutcome>((resolve) => {
    resolveDone = resolve
  })

  const [command, ...args] = request.agentArgv
  if (command === undefined) {
    setTimeout(() =>
      resolveDone({
        status: "unavailable",
        stopReason: "",
        sessionId: "",
        output: "",
        truncated: false,
        durationMillis: Date.now() - startedAt,
        detail: `${label} is not installed`,
        agentCapabilities: {},
        authMethods: []
      }), 0)
    return { done, cancel: () => undefined }
  }

  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd: request.cwd,
    env: request.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  })

  const settle = (
    outcome: Pick<AgentOutcome, "status" | "stopReason" | "detail">
  ): void => {
    if (settled) {
      return
    }
    settled = true
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
      // already gone
    }
    resolveDone({
      ...outcome,
      sessionId,
      output: outputText,
      truncated,
      durationMillis: Date.now() - startedAt,
      agentCapabilities,
      authMethods
    })
  }

  // The durable copy: bounded, secret-scrubbed prose accumulated into the
  // outcome output. This is the persisted authority the tool step records.
  const emitDurable = (raw: string): void => {
    if (raw === "" || settled) {
      return
    }
    if (outputBytes >= request.limits.maximumOutputBytes) {
      truncated = true
      return
    }
    const scrubbed = scrubSecrets(raw)
    const remaining = request.limits.maximumOutputBytes - outputBytes
    const bounded = scrubbed.length > remaining ? scrubbed.slice(0, remaining) : scrubbed
    truncated = truncated || bounded.length < scrubbed.length
    outputBytes += bounded.length
    outputText += bounded
  }

  // The live-rail copy: structured tool frames plus prose, already scrubbed by
  // renderUpdate. Bounded separately so a chatty tool trace cannot starve the
  // durable budget, and never accumulated into the persisted output.
  const emitStream = (raw: string): void => {
    if (raw === "" || settled || streamBytes >= request.limits.maximumOutputBytes) {
      return
    }
    const remaining = request.limits.maximumOutputBytes - streamBytes
    const bounded = raw.length > remaining ? raw.slice(0, remaining) : raw
    streamBytes += bounded.length
    request.onChunk(bounded)
  }

  // Render one update to both surfaces at once.
  const emitUpdate = (update: acp.SessionUpdate): void => {
    const { durable, stream } = renderUpdate(update)
    emitStream(stream)
    emitDurable(durable)
  }

  child.stderr.resume()

  child.on("error", (cause: NodeJS.ErrnoException) => {
    settle({
      status: "unavailable",
      stopReason: "",
      detail: cause.code === "ENOENT"
        ? `${label} is not installed on this machine`
        : `${label} failed to start: ${cause.message}`
    })
  })

  child.on("exit", (code) => {
    settle({
      status: cancelled ? "cancelled" : timedOut ? "timeout" : "failed",
      stopReason: "",
      detail: `${label} exited before completing (exit code ${String(code)})`
    })
  })

  /**
   * Outbound bound: a message larger than the cap is silently dropped rather
   * than written, exactly like the previous hand-rolled transport. The wall
   * clock ceiling bounds the resulting stall.
   */
  const boundedStdin = new WritableStream<Uint8Array>({
    write: (chunk) =>
      new Promise<void>((resolve) => {
        if (settled || chunk.byteLength > request.limits.maximumMessageBytes || child.stdin.destroyed) {
          resolve()
          return
        }
        child.stdin.write(chunk, () => resolve())
      })
  })

  const boundedStdout = boundedLineStream(
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    request.limits.maximumMessageBytes
  )

  const stream = acp.ndJsonStream(boundedStdin, boundedStdout)

  const handlePermission = (params: acp.RequestPermissionRequest): acp.RequestPermissionResponse => {
    if (cancelled || timedOut || settled) {
      return { outcome: { outcome: "cancelled" } }
    }
    const toolCall = params.toolCall
    const allowed = request.decidePermission({
      toolCallId: toolCall.toolCallId,
      title: toolCall.title ?? "",
      kind: toolCall.kind ?? "",
      rawInput: toolCall.rawInput
    })
    const option = selectPermissionOption(params.options, allowed)
    if (option === undefined) {
      return { outcome: { outcome: "cancelled" } }
    }
    const subject = scrubSecrets(toolCall.title ?? toolCall.kind ?? "")
    emitStream(noteFrame(`Permission ${allowed ? "granted" : "denied"}: ${subject}`, allowed ? "info" : "warn"))
    emitDurable(`\n[permission ${allowed ? "granted" : "denied"}] ${subject}\n`)
    return { outcome: { outcome: "selected", optionId: option.optionId } }
  }

  // Client capability posture: no fs, no terminal. Only the two methods below
  // are registered; the SDK answers everything else agent→client with a
  // method-not-found error, exactly as the hand-rolled client refused them.
  const app = acp.client({ name: "sarah-computer-controller" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => handlePermission(ctx.params))
    .onNotification(acp.methods.client.session.update, (ctx) => {
      emitUpdate(ctx.params.update)
    })

  const run = app.connectWith(stream, async (ctx): Promise<void> => {
    connection = ctx
    const initialized = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "sarah-computer-controller", title: "Sarah Computer Controller", version: "0.1.0" }
    })
    agentCapabilities = { ...(initialized.agentCapabilities ?? {}) } as Record<string, unknown>
    authMethods = (initialized.authMethods ?? []).map((method) => ({
      id: method.id,
      name: method.name
    }))
    if (initialized.protocolVersion !== protocolVersion) {
      settle({
        status: "unavailable",
        stopReason: "",
        detail: `agent negotiated unsupported protocol version ${String(initialized.protocolVersion)}`
      })
      return
    }

    const supportsLoad = initialized.agentCapabilities?.loadSession === true
    const resuming = request.resumeSessionId !== undefined && supportsLoad

    const createSession = async (): Promise<string> => {
      if (resuming && request.resumeSessionId !== undefined) {
        await ctx.request(acp.methods.agent.session.load, {
          sessionId: request.resumeSessionId,
          cwd: request.cwd,
          mcpServers: []
        })
        return request.resumeSessionId
      }
      const created = await ctx.request(acp.methods.agent.session.new, {
        cwd: request.cwd,
        mcpServers: []
      })
      return created.sessionId
    }

    try {
      sessionId = await createSession()
    } catch (failure) {
      if (failure instanceof acp.RequestError && failure.code === authRequiredCode && authMethods.length > 0) {
        const methodId = authMethods[0]?.id ?? ""
        try {
          await ctx.request(acp.methods.agent.authenticate, { methodId })
          sessionId = await createSession()
        } catch {
          settle({
            status: "unavailable",
            stopReason: "",
            detail: `${label} requires authentication on this machine ` +
              `(available auth methods: ${summarizeAuthMethods(authMethods)})`
          })
          return
        }
      } else {
        throw failure
      }
    }

    // Report the session id upstream before we start prompting, so the server
    // can checkpoint it and a survivor can re-attach by id after a node loss.
    if (sessionId !== "") {
      request.onSession?.(sessionId)
    }

    const result = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: request.prompt }]
    })
    const stopReason: string = result.stopReason
    const status: AgentStatus = stopReason === "refusal"
      ? "refused"
      : stopReason === "cancelled"
      ? (timedOut ? "timeout" : "cancelled")
      : "completed"
    settle({ status, stopReason, detail: "" })
  })

  const timeout = setTimeout(() => {
    timedOut = true
    if (sessionId !== "" && connection !== undefined) {
      void connection.notify(acp.methods.agent.session.cancel, { sessionId })
    }
    setTimeout(() => settle({ status: "timeout", stopReason: "", detail: "delegation timed out" }), 5_000)
      .unref()
  }, request.limits.timeoutMillis)
  timeout.unref()

  run
    .catch((failure: unknown) => {
      const detail = failure instanceof acp.RequestError
        ? `${label} reported an error: ${failure.message} (${failure.code})`
        : `delegation failed: ${failure instanceof Error ? failure.message : String(failure)}`
      settle({ status: "failed", stopReason: "", detail })
    })
    .finally(() => clearTimeout(timeout))

  return {
    done,
    cancel: () => {
      cancelled = true
      if (sessionId !== "" && connection !== undefined) {
        void connection.notify(acp.methods.agent.session.cancel, { sessionId })
      }
      setTimeout(
        () => settle({ status: "cancelled", stopReason: "cancelled", detail: "cancelled by request" }),
        5_000
      ).unref()
    }
  }
}
