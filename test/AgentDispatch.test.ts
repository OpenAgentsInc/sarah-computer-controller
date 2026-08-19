import { describe, expect, it } from "vitest"

import type { AgentJob, AgentOutcome, AgentRequest } from "../src/AcpAgent.js"
import * as AgentDispatch from "../src/AgentDispatch.js"
import type { Responder } from "../src/Channel.js"
import type { ControllerConfig } from "../src/Config.js"
import { defaultConfig } from "../src/Config.js"

interface Recorded {
  readonly chunks: Array<string>
  readonly exits: Array<Record<string, unknown>>
  readonly refusals: Array<{ reason: string; detail: string }>
  readonly journal: Array<AgentDispatch.JournalEntryInput>
  readonly respond: Responder
}

const recorder = (): Recorded => {
  const chunks: Array<string> = []
  const sessions: Array<string> = []
  const exits: Array<Record<string, unknown>> = []
  const refusals: Array<{ reason: string; detail: string }> = []
  return {
    chunks,
    exits,
    refusals,
    journal: [],
    respond: {
      chunk: (text) => chunks.push(text),
      session: (id) => sessions.push(id),
      exit: (payload) => exits.push(payload),
      refused: (reason, detail) => refusals.push({ reason, detail })
    }
  }
}

const config = (overrides: Partial<ControllerConfig> = {}): ControllerConfig => ({
  ...defaultConfig(),
  tier: "curated",
  roots: ["/tmp"],
  ...overrides
})

const outcome = (overrides: Partial<AgentOutcome> = {}): AgentOutcome => ({
  status: "completed",
  stopReason: "end_turn",
  sessionId: "sess-1",
  output: "done",
  truncated: false,
  durationMillis: 42,
  detail: "",
  agentCapabilities: {},
  authMethods: [],
  model: "gpt-test",
  reasoningEffort: "medium",
  mode: "agent",
  ...overrides
})

const dispatch = (
  agentId: string,
  payload: Record<string, unknown>,
  cfg: ControllerConfig,
  startJob?: (request: AgentRequest) => AgentJob
): { recorded: Recorded; started: Array<AgentRequest>; settled: Promise<void> } => {
  const recorded = recorder()
  const started: Array<AgentRequest> = []
  let resolveSettled: () => void = () => undefined
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  const fallbackStart = (request: AgentRequest): AgentJob => {
    started.push(request)
    const done = Promise.resolve(outcome())
    void done.then(() => setTimeout(resolveSettled, 0))
    return { done, cancel: () => undefined }
  }
  AgentDispatch.handleAgentEvent("req-1", agentId, payload, recorded.respond, {
    config: cfg,
    roots: cfg.roots,
    journal: (entry) => recorded.journal.push(entry),
    registerCancel: () => undefined,
    unregisterCancel: () => undefined,
    startJob: startJob ?? fallbackStart
  })
  // Refusal paths settle synchronously; give async paths one macrotask.
  setTimeout(resolveSettled, 50)
  return { recorded, started, settled }
}

describe("handleAgentEvent", () => {
  it("refuses an empty prompt", () => {
    const { recorded } = dispatch("claude", { prompt: "  " }, config())
    expect(recorded.refusals[0]?.reason).toBe("empty_command")
  })

  it("refuses everything at probe tier", () => {
    const { recorded } = dispatch("claude", { prompt: "do it" }, config({ tier: "probe" }))
    expect(recorded.refusals[0]?.reason).toBe("tier_insufficient")
    expect(recorded.journal[0]?.outcome).toBe("refused")
  })

  it("emits one terminal refused push naming agent_not_available and the inventory for unknown ids", () => {
    const { recorded } = dispatch("no-such-agent", { prompt: "do it" }, config())
    expect(recorded.exits).toHaveLength(1)
    const exit = recorded.exits[0] ?? {}
    expect(exit["status"]).toBe("refused")
    expect(exit["agent_id"]).toBe("no-such-agent")
    expect(String(exit["detail"])).toContain("agent_not_available")
    expect(String(exit["detail"])).toContain("claude")
    expect(exit["session_id"]).toBe("")
    expect(exit["duration_ms"]).toBe(0)
    expect(recorded.journal[0]?.outcome).toBe("refused")
  })

  it("starts a configured agent with its argv, opted-in env, and resume id", async () => {
    const cfg = config({
      agents: [{ id: "devin", argv: ["/usr/local/bin/devin", "acp"], env: ["PATH_EXTRA_FOR_TEST"] }]
    })
    process.env["PATH_EXTRA_FOR_TEST"] = "opted-in"
    try {
      const { recorded, settled, started } = dispatch(
        "devin",
        { prompt: "fix the bug", resume_session_id: "sess-9", timeout_ms: 1_000 },
        cfg
      )
      await settled
      expect(started).toHaveLength(1)
      const request = started[0]
      expect(request?.agentArgv).toEqual(["/usr/local/bin/devin", "acp"])
      expect(request?.resumeSessionId).toBe("sess-9")
      expect(request?.limits.timeoutMillis).toBe(1_000)
      expect(request?.env["PATH_EXTRA_FOR_TEST"]).toBe("opted-in")
      expect(request?.env["SHELL"]).toBe(process.env["SHELL"])
      expect(Object.keys(request?.env ?? {}).every((name) => name !== "npm_config_registry")).toBe(true)

      expect(recorded.exits).toHaveLength(1)
      const exit = recorded.exits[0] ?? {}
      expect(exit["status"]).toBe("completed")
      expect(exit["stop_reason"]).toBe("end_turn")
      expect(exit["session_id"]).toBe("sess-1")
      expect(exit["output"]).toBe("done")
      expect(exit["truncated"]).toBe(false)
      expect(exit["duration_ms"]).toBe(42)
      expect(exit["agent_id"]).toBe("devin")
      expect(recorded.journal[0]?.outcome).toBe("completed")
    } finally {
      delete process.env["PATH_EXTRA_FOR_TEST"]
    }
  })

  it("accepts the legacy session_id field as the resume id", async () => {
    const cfg = config({ agents: [{ id: "devin", argv: ["devin", "acp"], env: [] }] })
    const { settled, started } = dispatch("devin", { prompt: "continue", session_id: "sess-old" }, cfg)
    await settled
    expect(started[0]?.resumeSessionId).toBe("sess-old")
  })

  it("delegates to the pinned claude entry with zero configuration", async () => {
    const { settled, started } = dispatch("claude", { prompt: "hello" }, config())
    await settled
    expect(started).toHaveLength(1)
    expect(started[0]?.agentArgv[0]).toBe(process.execPath)
    expect(String(started[0]?.agentArgv[1])).toContain("claude-agent-acp")
  })
})

describe("agentNotAvailableDetail", () => {
  it("names the code, the requested id, and the available inventory", () => {
    const detail = AgentDispatch.agentNotAvailableDetail("droid", ["claude", "devin"], "not configured")
    expect(detail).toContain("agent_not_available")
    expect(detail).toContain("droid")
    expect(detail).toContain("claude, devin")
  })
})

describe("boundedTimeout", () => {
  it("bounds and defaults", () => {
    expect(AgentDispatch.boundedTimeout(1_000, 240_000, 600_000)).toBe(1_000)
    expect(AgentDispatch.boundedTimeout(999_999_999, 240_000, 600_000)).toBe(600_000)
    expect(AgentDispatch.boundedTimeout("nope", 240_000, 600_000)).toBe(240_000)
    expect(AgentDispatch.boundedTimeout(-5, 240_000, 600_000)).toBe(240_000)
  })
})

describe("resolveCwd", () => {
  it("falls back to the first root for values outside every root", () => {
    expect(AgentDispatch.resolveCwd("/etc", ["/tmp"])).toBe("/tmp")
    expect(AgentDispatch.resolveCwd(undefined, ["/tmp"])).toBe("/tmp")
    expect(AgentDispatch.resolveCwd("/tmp/project", ["/tmp"])).toBe("/tmp/project")
  })
})
