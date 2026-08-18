/**
 * Live smoke against the pinned claude adapter. Off by default: it needs a
 * working Claude login on this machine and spends real tokens. Enable with
 *
 *   SARAH_LIVE_CLAUDE_SMOKE=1 pnpm vitest run test/AcpAgentLive.test.ts
 */

import * as os from "node:os"

import { describe, expect, it } from "vitest"

import * as AcpAgent from "../src/AcpAgent.js"
import * as AgentCatalog from "../src/AgentCatalog.js"

const enabled = process.env["SARAH_LIVE_CLAUDE_SMOKE"] === "1"

describe("pinned claude adapter (live)", () => {
  it.runIf(enabled)("completes a trivial prompt through the pinned adapter", async () => {
    const pinned = AgentCatalog.resolvePinnedClaudeAdapter()
    expect(pinned).toBeDefined()
    const chunks: Array<string> = []
    const outcome = await AcpAgent.start({
      agentArgv: [process.execPath, pinned?.binPath ?? ""],
      prompt: "Reply with the single word: pong. Do not use any tools.",
      cwd: os.tmpdir(),
      env: AgentCatalog.agentEnvironment(["ANTHROPIC_API_KEY"]),
      limits: { ...AcpAgent.defaultAgentLimits, timeoutMillis: 120_000 },
      onChunk: (text) => chunks.push(text),
      decidePermission: () => false,
      agentLabel: "claude"
    }).done
    expect(["completed", "unavailable"]).toContain(outcome.status)
    if (outcome.status === "completed") {
      expect(chunks.join("").toLowerCase()).toContain("pong")
    } else {
      // No login on this machine: the typed unavailable outcome must carry
      // the agent's auth methods so Sarah can say what login is missing.
      expect(outcome.authMethods.length).toBeGreaterThan(0)
    }
  }, 180_000)

  it.runIf(!enabled)("is skipped unless SARAH_LIVE_CLAUDE_SMOKE=1", () => {
    expect(enabled).toBe(false)
  })
})
