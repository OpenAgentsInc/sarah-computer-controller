/**
 * Keeps in-flight ACP agent sessions alive across a server WebSocket drop, so a
 * surviving Sarah node can re-attach to a *live* session by id after a node loss
 * (M2) instead of orphaning the agent.
 *
 * The key idea: an agent job's output does not go straight to the channel
 * responder — it goes through a {@link Sink} whose target can be detached (WS
 * dropped) and re-attached (reconnected) without disturbing the running job.
 * Shell (`run`) jobs are short and are simply cancelled on disconnect; agent
 * jobs are kept alive and re-attachable.
 */
import type { AgentJob } from "./AcpAgent.js"
import type { Responder } from "./Channel.js"

/** A responder whose target channel can be swapped or removed at runtime. */
export interface Sink extends Responder {
  /** Point output at a (new) channel responder. */
  readonly attach: (responder: Responder) => void
  /** Drop the target — output is discarded until re-attached (WS is down). */
  readonly detach: () => void
  /** Whether a channel is currently attached. */
  readonly attached: () => boolean
}

export const makeSink = (initial: Responder | null = null): Sink => {
  let current: Responder | null = initial
  return {
    chunk: (t) => current?.chunk(t),
    session: (id) => current?.session(id),
    exit: (p) => current?.exit(p),
    refused: (r, d) => current?.refused(r, d),
    attach: (responder) => {
      current = responder
    },
    detach: () => {
      current = null
    },
    attached: () => current !== null
  }
}

interface LiveAgent {
  readonly requestId: string
  sessionId: string | null
  readonly job: AgentJob
  readonly sink: Sink
}

/**
 * Registry of live agent sessions + short-lived run jobs, persistent across
 * channel reconnects (it lives in the CLI command scope, outside `Channel.serve`).
 */
export class SessionKeeper {
  private readonly byRequest = new Map<string, LiveAgent>()
  private readonly bySession = new Map<string, LiveAgent>()
  private readonly runs = new Map<string, () => void>()

  /** Track a short-lived shell job so it can be cancelled on drop/stop. */
  registerRun(requestId: string, cancel: () => void): void {
    this.runs.set(requestId, cancel)
  }

  runDone(requestId: string): void {
    this.runs.delete(requestId)
  }

  /** Track a long-lived agent job and its swappable sink. */
  registerAgent(requestId: string, job: AgentJob, sink: Sink): void {
    const live: LiveAgent = { requestId, sessionId: null, job, sink }
    this.byRequest.set(requestId, live)
    void job.done.then(() => this.forget(requestId))
  }

  /** Bind a known ACP session id to a live agent (called when session/new returns). */
  bindSession(requestId: string, sessionId: string): void {
    const live = this.byRequest.get(requestId)
    if (live !== undefined && sessionId !== "") {
      live.sessionId = sessionId
      this.bySession.set(sessionId, live)
    }
  }

  /** True if a live agent session with this id is still running here. */
  hasSession(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  /**
   * Re-attach a live session's output to a new channel responder (after a
   * reconnect + a resume-by-id request). Returns false if no such live session.
   */
  reattach(sessionId: string, responder: Responder): boolean {
    const live = this.bySession.get(sessionId)
    if (live === undefined) return false
    live.sink.attach(responder)
    return true
  }

  /** Cancel a specific in-flight request (a Stop, or an explicit cancel). */
  cancel(requestId: string): void {
    const run = this.runs.get(requestId)
    if (run !== undefined) {
      run()
      this.runs.delete(requestId)
      return
    }
    const live = this.byRequest.get(requestId)
    if (live !== undefined) {
      live.job.cancel()
      this.forget(requestId)
    }
  }

  /**
   * The channel dropped. Cancel short-lived run jobs (nothing can re-attach a
   * shell command's stdout), but KEEP agent jobs alive with their output
   * detached, so a reconnect can re-attach them by session id.
   */
  onDisconnect(): void {
    for (const cancel of this.runs.values()) cancel()
    this.runs.clear()
    for (const live of this.byRequest.values()) live.sink.detach()
  }

  /** Number of live agent sessions being kept (for logging/tests). */
  liveAgentCount(): number {
    return this.byRequest.size
  }

  private forget(requestId: string): void {
    const live = this.byRequest.get(requestId)
    if (live?.sessionId != null) this.bySession.delete(live.sessionId)
    this.byRequest.delete(requestId)
  }
}
