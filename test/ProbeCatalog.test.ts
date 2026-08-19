import { describe, expect, it } from "vitest"

import * as AgentCatalog from "../src/AgentCatalog.js"
import * as AgentDispatch from "../src/AgentDispatch.js"
import type { ControllerConfig } from "../src/Config.js"
import { defaultConfig } from "../src/Config.js"
import { scrubSecrets } from "../src/Executor.js"

const config = (overrides: Partial<ControllerConfig> = {}): ControllerConfig => ({
  ...defaultConfig(),
  tier: "curated",
  roots: ["/tmp"],
  ...overrides
})

describe("probe as a pinned catalog agent", () => {
  it("resolves an explicit probePath and appends the acp mode arg", () => {
    const pinned = AgentCatalog.resolvePinnedProbeAgent(process.execPath)
    expect(pinned?.binPath).toBe(process.execPath)
  })

  it("appears in the catalog with auth_ready true (no machine credential)", () => {
    const catalog = AgentCatalog.buildCatalog(config({ probePath: process.execPath }))
    const probe = catalog.find((entry) => entry.id === "probe")
    expect(probe).toBeDefined()
    expect(probe?.source).toBe("pinned")
    expect(probe?.argv[0]).toBe(process.execPath)
    expect(probe?.argv[probe.argv.length - 1]).toBe("acp")
    expect(probe?.authReady).toBe(true)
  })

  it("reports probe in acpAgentInventory with auth_ready true", () => {
    const inventory = AgentCatalog.acpAgentInventory(config({ probePath: process.execPath }))
    const probe = inventory.find((entry) => entry.id === "probe")
    expect(probe?.auth_ready).toBe(true)
  })

  it("lets an operator config entry override the pinned probe", () => {
    const catalog = AgentCatalog.buildCatalog(
      config({ probePath: process.execPath, agents: [{ id: "probe", argv: ["/opt/probe", "acp"], env: [] }] })
    )
    const probe = catalog.filter((entry) => entry.id === "probe")
    expect(probe).toHaveLength(1)
    expect(probe[0]?.source).toBe("config")
    expect(probe[0]?.argv).toEqual(["/opt/probe", "acp"])
  })
})

describe("delegation-scoped grant env injection", () => {
  it("injects the grant and url for a first-party probe delegation", () => {
    const env = AgentDispatch.grantEnvironment("probe", {
      inference_grant: "grant_supersecret_token",
      inference_url: "https://openagents.com/api/inference/proxy"
    })
    expect(env["PROBE_INFERENCE_GRANT"]).toBe("grant_supersecret_token")
    expect(env["PROBE_INFERENCE_URL"]).toBe("https://openagents.com/api/inference/proxy")
    expect(env["PROBE_TRANSPORT"]).toBe("openai")
  })

  it("registers the grant with the scrubber so it never leaks", () => {
    AgentDispatch.grantEnvironment("probe", { inference_grant: "grant_scrub_me_98765" })
    expect(scrubSecrets("saw grant_scrub_me_98765 in output")).toBe("saw [redacted] in output")
  })

  it("never injects a grant for any other agent id", () => {
    const env = AgentDispatch.grantEnvironment("claude", {
      inference_grant: "grant_should_be_ignored",
      inference_url: "https://evil.example/proxy"
    })
    expect(env).toEqual({})
  })

  it("injects nothing when the delegation carries no grant", () => {
    expect(AgentDispatch.grantEnvironment("probe", {})).toEqual({})
  })
})
