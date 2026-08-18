/**
 * Dispatch one `agent` channel event (or a legacy `devin` event mapped to
 * agent_id "devin") to an ACP delegation. This module owns the wire contract
 * for the terminal payload:
 *
 *   { status, stop_reason, session_id, output, truncated, duration_ms,
 *     detail, agent_id }
 *
 * with status in completed|refused|cancelled|timeout|unavailable|failed. An
 * unknown agent id refuses with status "refused" and a detail naming
 * `agent_not_available` plus the committed inventory, so Sarah learns the
 * available ids from the refusal itself.
 */

import * as path from "node:path"

import * as AcpAgent from "./AcpAgent.js"
import * as AgentCatalog from "./AgentCatalog.js"
import type { Responder } from "./Channel.js"
import type { ControllerConfig } from "./Config.js"
import * as Policy from "./Policy.js"

export const boundedTimeout = (value: unknown, fallback: number, maximum: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), maximum) : fallback

export const resolveCwd = (value: unknown, roots: ReadonlyArray<string>): string => {
  const fallback = roots[0] ?? process.cwd()
  if (typeof value !== "string" || value.trim() === "") {
    return fallback
  }
  const absolute = path.resolve(value)
  return roots.some((root) => Policy.withinRoot(absolute, root)) ? absolute : fallback
}

export interface JournalEntryInput {
  readonly requestId: string
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly outcome: string
  readonly detail: string
}

export interface AgentDispatchDeps {
  readonly config: ControllerConfig
  readonly roots: ReadonlyArray<string>
  readonly journal: (entry: JournalEntryInput) => void
  readonly registerCancel: (requestId: string, cancel: () => void) => void
  readonly unregisterCancel: (requestId: string) => void
  /** Injectable for tests; defaults to the real ACP client. */
  readonly startJob?: (request: AcpAgent.AgentRequest) => AcpAgent.AgentJob
}

const maximumDetailLength = 2_000

const agentExit = (respond: Responder, agentId: string, outcome: AcpAgent.AgentOutcome): void => {
  respond.exit({
    status: outcome.status,
    stop_reason: outcome.stopReason,
    session_id: outcome.sessionId,
    output: outcome.output,
    truncated: outcome.truncated,
    duration_ms: outcome.durationMillis,
    detail: outcome.detail.slice(0, maximumDetailLength),
    agent_id: agentId
  })
}

const emptyOutcome = (
  status: AcpAgent.AgentStatus,
  detail: string
): AcpAgent.AgentOutcome => ({
  status,
  stopReason: "",
  sessionId: "",
  output: "",
  truncated: false,
  durationMillis: 0,
  detail,
  agentCapabilities: {},
  authMethods: []
})

export const agentNotAvailableDetail = (
  agentId: string,
  availableIds: ReadonlyArray<string>,
  reason: string
): string => {
  const available = availableIds.length > 0 ? availableIds.join(", ") : "(none)"
  const suffix = reason !== "" ? ` (${reason})` : ""
  return `agent_not_available: "${agentId || "?"}" is not available on this machine${suffix}; ` +
    `available agents: ${available}`
}

/**
 * Handle one delegation request end to end: local tier gate, catalog
 * resolution, bounded ACP job, and exactly one terminal push.
 */
export const handleAgentEvent = (
  requestId: string,
  agentId: string,
  payload: Record<string, unknown>,
  respond: Responder,
  deps: AgentDispatchDeps
): void => {
  const start = deps.startJob ?? AcpAgent.start
  const prompt = typeof payload["prompt"] === "string" ? payload["prompt"] : ""
  const cwd = resolveCwd(payload["cwd"], deps.roots)

  if (prompt.trim() === "") {
    respond.refused("empty_command", "no prompt was supplied")
    return
  }

  if (deps.config.tier === "probe") {
    deps.journal({
      requestId,
      argv: ["agent", agentId],
      cwd,
      outcome: "refused",
      detail: "probe tier"
    })
    respond.refused("tier_insufficient", "this machine is paired at probe tier; only discovery is permitted")
    return
  }

  const catalog = AgentCatalog.buildCatalog(deps.config)
  const resolution = AgentCatalog.resolveAgent(agentId, deps.config, catalog)

  if (resolution._tag === "NotAvailable") {
    const detail = agentNotAvailableDetail(agentId, resolution.availableIds, resolution.detail)
    deps.journal({ requestId, argv: ["agent", agentId], cwd, outcome: "refused", detail })
    agentExit(respond, agentId, emptyOutcome("refused", detail))
    return
  }

  const resumeSessionId = typeof payload["resume_session_id"] === "string" && payload["resume_session_id"] !== ""
    ? payload["resume_session_id"]
    : typeof payload["session_id"] === "string" && payload["session_id"] !== ""
    ? payload["session_id"]
    : undefined

  const launch = (entry: AgentCatalog.CatalogEntry): void => {
    const job = start({
      agentArgv: entry.argv,
      prompt,
      cwd,
      resumeSessionId,
      env: AgentCatalog.agentEnvironment(entry.envPassthrough),
      limits: {
        ...AcpAgent.defaultAgentLimits,
        timeoutMillis: boundedTimeout(payload["timeout_ms"], AcpAgent.defaultAgentLimits.timeoutMillis, 600_000)
      },
      onChunk: respond.chunk,
      decidePermission: (query) => AcpAgent.permissionAllowed(deps.config.tier, query, deps.config.curatedExecute),
      agentLabel: agentId
    })
    deps.registerCancel(requestId, job.cancel)
    void job.done.then((outcome) => {
      deps.unregisterCancel(requestId)
      deps.journal({
        requestId,
        argv: entry.argv,
        cwd,
        outcome: outcome.status,
        detail: outcome.detail !== "" ? outcome.detail : `stop reason ${outcome.stopReason || "none"}`
      })
      agentExit(respond, agentId, outcome)
    })
  }

  if (resolution._tag === "Resolved") {
    launch(resolution.entry)
    return
  }

  // RegistryDownload: fetch, verify, unpack — only behind the named opt-in.
  void AgentCatalog.prepareRegistryBinary(resolution.agent, resolution.target).then(
    (argv) => {
      launch({
        id: resolution.agent.id,
        source: "registry",
        argv,
        envPassthrough: deps.config.agents.find((entry) => entry.id === agentId)?.env ?? [],
        version: resolution.agent.version,
        authReady: null
      })
    },
    (cause: unknown) => {
      const detail = `registry agent could not be prepared: ${cause instanceof Error ? cause.message : String(cause)}`
      deps.journal({ requestId, argv: ["agent", agentId], cwd, outcome: "unavailable", detail })
      agentExit(respond, agentId, emptyOutcome("unavailable", detail))
    }
  )
}
