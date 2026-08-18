import * as fs from "node:fs"

import { describe, expect, it } from "vitest"

import * as AgentCatalog from "../src/AgentCatalog.js"
import type { ControllerConfig } from "../src/Config.js"
import { defaultConfig, readAgentEntries } from "../src/Config.js"

const config = (overrides: Partial<ControllerConfig> = {}): ControllerConfig => ({
  ...defaultConfig(),
  tier: "curated",
  roots: ["/tmp"],
  ...overrides
})

describe("resolvePinnedClaudeAdapter", () => {
  it("finds the pinned claude adapter bin inside node_modules", () => {
    const pinned = AgentCatalog.resolvePinnedClaudeAdapter()
    expect(pinned).toBeDefined()
    expect(pinned?.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(fs.existsSync(pinned?.binPath ?? "")).toBe(true)
  })
})

describe("buildCatalog", () => {
  it("ships claude as the pinned default entry with zero configuration", () => {
    const catalog = AgentCatalog.buildCatalog(config())
    const claude = catalog.find((entry) => entry.id === "claude")
    expect(claude).toBeDefined()
    expect(claude?.source).toBe("pinned")
    expect(claude?.argv[0]).toBe(process.execPath)
    expect(claude?.version).not.toBe("")
  })

  it("lets an operator config entry override the pinned entry of the same id", () => {
    const catalog = AgentCatalog.buildCatalog(
      config({ agents: [{ id: "claude", argv: ["/opt/claude-acp"], env: ["ANTHROPIC_API_KEY"] }] })
    )
    const claude = catalog.filter((entry) => entry.id === "claude")
    expect(claude).toHaveLength(1)
    expect(claude[0]?.source).toBe("config")
    expect(claude[0]?.argv).toEqual(["/opt/claude-acp"])
    expect(claude[0]?.envPassthrough).toEqual(["ANTHROPIC_API_KEY"])
  })

  it("includes operator-configured agents", () => {
    const catalog = AgentCatalog.buildCatalog(
      config({ agents: [{ id: "codex", argv: ["codex-acp"], env: [] }] })
    )
    const codex = catalog.find((entry) => entry.id === "codex")
    expect(codex?.source).toBe("config")
    expect(codex?.argv).toEqual(["codex-acp"])
  })
})

describe("resolveAgent", () => {
  const emptyCatalog: ReadonlyArray<AgentCatalog.CatalogEntry> = []

  it("resolves a catalog entry directly", () => {
    const resolution = AgentCatalog.resolveAgent("claude", config())
    expect(resolution._tag).toBe("Resolved")
    if (resolution._tag === "Resolved") {
      expect(resolution.entry.source).toBe("pinned")
    }
  })

  it("refuses unknown ids with the available inventory when registry resolution is off", () => {
    const resolution = AgentCatalog.resolveAgent("codex-acp", config({ registryAgents: false }))
    expect(resolution._tag).toBe("NotAvailable")
    if (resolution._tag === "NotAvailable") {
      expect(resolution.availableIds).toContain("claude")
      expect(resolution.detail).toContain("registry-agents")
    }
  })

  it("resolves an npx registry distribution to a pinned-package argv behind the opt-in", () => {
    const resolution = AgentCatalog.resolveAgent("codex-acp", config({ registryAgents: true }), emptyCatalog)
    expect(resolution._tag).toBe("Resolved")
    if (resolution._tag === "Resolved") {
      expect(resolution.entry.source).toBe("registry")
      expect(resolution.entry.argv[0]).toBe("npx")
      expect(resolution.entry.argv[1]).toBe("-y")
      expect(resolution.entry.argv[2]).toMatch(/^@agentclientprotocol\/codex-acp@/)
    }
  })

  it("refuses a binary distribution without a sha256", () => {
    // The devin registry entry ships platform binaries with no sha256 digest.
    const resolution = AgentCatalog.resolveAgent("devin", config({ registryAgents: true }), emptyCatalog)
    expect(resolution._tag).toBe("NotAvailable")
    if (resolution._tag === "NotAvailable") {
      expect(resolution.detail).toContain("sha256")
    }
  })

  it("refuses ids that are not in the vendored snapshot", () => {
    const resolution = AgentCatalog.resolveAgent("not-a-real-agent", config({ registryAgents: true }), emptyCatalog)
    expect(resolution._tag).toBe("NotAvailable")
    if (resolution._tag === "NotAvailable") {
      expect(resolution.detail).toContain("snapshot")
    }
  })
})

describe("agentEnvironment", () => {
  it("passes through only the scrubbed allowlist by default", () => {
    const env = AgentCatalog.agentEnvironment([], {
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      GITHUB_TOKEN: "ghp_secret"
    })
    expect(env["PATH"]).toBe("/usr/bin")
    expect(env["HOME"]).toBe("/home/x")
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined()
    expect(env["GITHUB_TOKEN"]).toBeUndefined()
  })

  it("layers named per-agent opt-ins on top of the allowlist", () => {
    const env = AgentCatalog.agentEnvironment(["ANTHROPIC_API_KEY"], {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      GITHUB_TOKEN: "ghp_secret"
    })
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-secret")
    expect(env["GITHUB_TOKEN"]).toBeUndefined()
  })
})

describe("acpAgentInventory", () => {
  it("reports id, source, version, and auth_ready for every catalog entry", () => {
    const inventory = AgentCatalog.acpAgentInventory(config())
    expect(inventory.length).toBeGreaterThan(0)
    for (const entry of inventory) {
      expect(Object.keys(entry).sort()).toEqual(["auth_ready", "id", "source", "version"])
      expect(["pinned", "config", "registry"]).toContain(entry.source)
      expect([true, false, null]).toContain(entry.auth_ready)
      expect(typeof entry.version).toBe("string")
    }
    const claude = inventory.find((entry) => entry.id === "claude")
    expect(claude?.source).toBe("pinned")
  })

  it("marks a configured agent with missing named credentials as not auth-ready", () => {
    const inventory = AgentCatalog.acpAgentInventory(
      config({ agents: [{ id: "custom", argv: ["custom-acp"], env: ["SARAH_TEST_MISSING_CREDENTIAL"] }] })
    )
    const custom = inventory.find((entry) => entry.id === "custom")
    expect(custom?.auth_ready).toBe(false)
  })

  it("includes registry ids only behind the opt-in, and stays bounded", () => {
    const closed = AgentCatalog.acpAgentInventory(config({ registryAgents: false }))
    expect(closed.some((entry) => entry.source === "registry")).toBe(false)

    const open = AgentCatalog.acpAgentInventory(config({ registryAgents: true }))
    expect(open.some((entry) => entry.source === "registry")).toBe(true)
    expect(open.length).toBeLessThanOrEqual(64)
  })
})

describe("readAgentEntries", () => {
  it("normalizes the on-disk agents object and drops malformed entries", () => {
    const entries = readAgentEntries({
      devin: { argv: ["devin", "acp"], env: ["DEVIN_API_KEY"] },
      "no-argv": { env: ["X"] },
      "Bad Id!": { argv: ["x"] },
      wrongShape: "nope"
    })
    expect(entries).toEqual([{ id: "devin", argv: ["devin", "acp"], env: ["DEVIN_API_KEY"] }])
  })
})
