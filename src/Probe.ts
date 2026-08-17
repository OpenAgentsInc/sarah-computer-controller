/**
 * Discovery. This is the first thing Sarah does on a newly paired machine, and
 * the only thing she can do at `probe` tier: find out which coding agents and
 * toolchains exist here. Absence is a first-class answer, never an error.
 */

import * as os from "node:os"

import { Effect } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"

import { executeQuietly } from "./Executor.js"

export interface ToolReport {
  readonly name: string
  readonly present: boolean
  readonly path: string
  readonly version: string
}

export interface HostReport {
  readonly platform: string
  readonly release: string
  readonly architecture: string
  readonly hostname: string
  readonly shell: string
  readonly cpuCount: number
  readonly totalMemoryBytes: number
  readonly uptimeSeconds: number
}

export interface ProbeReport {
  readonly schema: "sarah.computer_probe.v1"
  readonly host: HostReport
  readonly codingAgents: ReadonlyArray<ToolReport>
  readonly toolchains: ReadonlyArray<ToolReport>
  readonly roots: ReadonlyArray<string>
}

interface Probed {
  readonly name: string
  readonly versionArgv: ReadonlyArray<string>
}

/**
 * Coding agents worth knowing about. Every entry is checked; a machine with
 * none of them still produces a complete report.
 */
export const codingAgentCatalog: ReadonlyArray<Probed> = [
  { name: "claude", versionArgv: ["--version"] },
  { name: "codex", versionArgv: ["--version"] },
  { name: "devin", versionArgv: ["--version"] },
  { name: "gemini", versionArgv: ["--version"] },
  { name: "cursor-agent", versionArgv: ["--version"] },
  { name: "aider", versionArgv: ["--version"] },
  { name: "goose", versionArgv: ["--version"] },
  { name: "opencode", versionArgv: ["--version"] },
  { name: "amp", versionArgv: ["--version"] },
  { name: "copilot", versionArgv: ["--version"] },
  { name: "crush", versionArgv: ["--version"] }
]

export const toolchainCatalog: ReadonlyArray<Probed> = [
  { name: "git", versionArgv: ["--version"] },
  { name: "gh", versionArgv: ["--version"] },
  { name: "node", versionArgv: ["--version"] },
  { name: "npm", versionArgv: ["--version"] },
  { name: "pnpm", versionArgv: ["--version"] },
  { name: "bun", versionArgv: ["--version"] },
  { name: "deno", versionArgv: ["--version"] },
  { name: "python3", versionArgv: ["--version"] },
  { name: "uv", versionArgv: ["--version"] },
  { name: "cargo", versionArgv: ["--version"] },
  { name: "go", versionArgv: ["version"] },
  { name: "elixir", versionArgv: ["--version"] },
  { name: "docker", versionArgv: ["--version"] },
  { name: "tmux", versionArgv: ["-V"] }
]

const maximumVersionLength = 120

/** Bounded so a chatty `--version` cannot inflate Sarah's model context. */
export const boundedVersion = (value: string): string => value.slice(0, maximumVersionLength)

const whichArgv = (name: string): ReadonlyArray<string> =>
  process.platform === "win32" ? ["where", name] : ["which", name]

const probeOne = (
  probed: Probed,
  cwd: string
): Effect.Effect<ToolReport, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const resolved = yield* executeQuietly(whichArgv(probed.name), cwd)
    if (resolved === "") {
      return { name: probed.name, present: false, path: "", version: "" }
    }
    const version = yield* executeQuietly([probed.name, ...probed.versionArgv], cwd)
    return { name: probed.name, present: true, path: resolved, version: boundedVersion(version) }
  })

export const hostReport = (): HostReport => ({
  platform: process.platform,
  release: os.release(),
  architecture: process.arch,
  hostname: os.hostname(),
  shell: process.env["SHELL"] ?? "",
  cpuCount: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  uptimeSeconds: Math.round(os.uptime())
})

export const probe = (
  roots: ReadonlyArray<string>
): Effect.Effect<ProbeReport, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const cwd = roots[0] ?? process.cwd()
    const codingAgents = yield* Effect.forEach(codingAgentCatalog, (probed) => probeOne(probed, cwd), {
      concurrency: 4
    })
    const toolchains = yield* Effect.forEach(toolchainCatalog, (probed) => probeOne(probed, cwd), {
      concurrency: 4
    })
    return {
      schema: "sarah.computer_probe.v1" as const,
      host: hostReport(),
      codingAgents,
      toolchains,
      roots
    }
  })

const formatTool = (tool: ToolReport): string =>
  tool.present ? `  ${tool.name.padEnd(14)} ${tool.version || "present"}` : `  ${tool.name.padEnd(14)} —`

export const formatReport = (report: ProbeReport): string => {
  const lines = [
    `host      ${report.host.platform} ${report.host.release} ${report.host.architecture}`,
    `hostname  ${report.host.hostname}`,
    `cpus      ${report.host.cpuCount}`,
    `roots     ${report.roots.join(", ") || "(none declared)"}`,
    "",
    "coding agents",
    ...report.codingAgents.map(formatTool),
    "",
    "toolchains",
    ...report.toolchains.map(formatTool)
  ]
  return lines.join("\n")
}
