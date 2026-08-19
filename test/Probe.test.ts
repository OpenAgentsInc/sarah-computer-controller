import { describe, expect, it } from "vitest"

import type { ProbeReport } from "../src/Probe.js"
import { formatReport, wireReport } from "../src/Probe.js"

const report: ProbeReport = {
  schema: "sarah.computer_probe.v1",
  host: {
    platform: "darwin",
    release: "24.0.0",
    architecture: "arm64",
    hostname: "workshop",
    shell: "/bin/zsh",
    cpuCount: 12,
    totalMemoryBytes: 1024,
    uptimeSeconds: 10
  },
  codingAgents: [{ name: "claude", present: true, path: "/usr/local/bin/claude", version: "1.0.0" }],
  toolchains: [{ name: "git", present: true, path: "/usr/bin/git", version: "git version 2.49.0" }],
  roots: ["/tmp"],
  acpAgents: [
    {
      id: "claude",
      source: "pinned",
      version: "0.69.0",
      auth_ready: true,
      model: null,
      reasoning_effort: null,
      mode: null
    },
    {
      id: "devin",
      source: "config",
      version: "",
      auth_ready: null,
      model: null,
      reasoning_effort: null,
      mode: null
    }
  ]
}

describe("wireReport", () => {
  it("carries the acp_agents inventory in the committed wire shape", () => {
    const wire = wireReport(report)
    expect(wire["schema"]).toBe("sarah.computer_probe.v1")
    expect(wire["acp_agents"]).toEqual([
      {
        id: "claude",
        source: "pinned",
        version: "0.69.0",
        auth_ready: true,
        model: null,
        reasoning_effort: null,
        mode: null
      },
      {
        id: "devin",
        source: "config",
        version: "",
        auth_ready: null,
        model: null,
        reasoning_effort: null,
        mode: null
      }
    ])
  })
})

describe("formatReport", () => {
  it("renders the acp agent inventory for the operator", () => {
    const rendered = formatReport(report)
    expect(rendered).toContain("acp agents")
    expect(rendered).toContain("claude")
    expect(rendered).toContain("auth ready")
    expect(rendered).toContain("auth unknown")
  })
})
