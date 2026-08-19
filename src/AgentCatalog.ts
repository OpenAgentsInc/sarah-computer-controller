/**
 * The agent catalog: which ACP agents this machine can run, and how. Three
 * layers with deliberate precedence:
 *
 *   1. Operator config (`agents` entries in the machine config) — the
 *      operator installed it, the operator's argv wins, including over the
 *      pinned default of the same id.
 *   2. Pinned dependencies — `@agentclientprotocol/claude-agent-acp` ships
 *      as a direct dependency and is spawned from `node_modules`
 *      (version-pinned, no PATH or network dependency). This is the default
 *      `claude` entry.
 *   3. Registry resolution (opt-in, `--allow registry-agents`) — unknown ids
 *      are resolved from the vendored registry snapshot: npx/uvx execution,
 *      binary only with sha256 verification. Off by default because
 *      resolution downloads and runs code.
 *
 * The catalog is also what the probe reports to Sarah as evidence, so the
 * model chooses agents from committed facts, not guesses.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"

import type { AgentConfigEntry, ControllerConfig } from "./Config.js"
import { configDirectory } from "./Config.js"
import { scrubbedEnvironment } from "./Executor.js"
import type { RegistryAgent, RegistryBinaryTarget } from "./RegistrySnapshot.js"
import { registrySnapshot } from "./RegistrySnapshot.js"

export type CatalogSource = "pinned" | "config" | "registry"

export interface CatalogEntry {
  readonly id: string
  readonly source: CatalogSource
  /** Full argv to spawn the agent's ACP adapter. Empty for unresolved registry entries. */
  readonly argv: ReadonlyArray<string>
  /** Named env variables the operator opted in to pass through for this agent. */
  readonly envPassthrough: ReadonlyArray<string>
  /** Version when cheaply known, "" otherwise. */
  readonly version: string
  /** Whether the agent's login/credential looks present. null = cannot cheaply tell. */
  readonly authReady: boolean | null
}

const require_ = createRequire(import.meta.url)

const claudeAdapterPackage = "@agentclientprotocol/claude-agent-acp"
const probePackage = "@openagentsinc/probe"

interface PinnedAdapter {
  readonly version: string
  readonly binPath: string
}

/**
 * Locate the pinned claude adapter inside our own `node_modules`. Resolution
 * is by package name from this module, so it works installed or from a
 * checkout, with no PATH or network dependency.
 */
export const resolvePinnedClaudeAdapter = (): PinnedAdapter | undefined => {
  try {
    const packageJsonPath = require_.resolve(`${claudeAdapterPackage}/package.json`)
    const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
    const record = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {}
    const bin = typeof record["bin"] === "object" && record["bin"] !== null
      ? record["bin"] as Record<string, unknown>
      : {}
    const relative = typeof bin["claude-agent-acp"] === "string" ? bin["claude-agent-acp"] : "dist/index.js"
    return {
      version: typeof record["version"] === "string" ? record["version"] : "",
      binPath: path.join(path.dirname(packageJsonPath), relative)
    }
  } catch {
    return undefined
  }
}

/**
 * Locate the pinned first-party probe agent. Probe is the platform-neutral
 * `@openagentsinc/probe` npm package (a wasm core with an async, non-JSPI
 * ABI); it is spawned from `node_modules` under the controller's own Node,
 * exactly like the claude adapter, with no PATH or network dependency. An
 * explicit path (config `probePath` or `SARAH_PROBE_BIN`) wins — useful
 * before the package is published and for local development.
 */
export const resolvePinnedProbeAgent = (probePath?: string): PinnedAdapter | undefined => {
  const override = probePath ?? process.env["SARAH_PROBE_BIN"]
  if (override !== undefined && override !== "" && fs.existsSync(override)) {
    return { version: "", binPath: override }
  }
  try {
    const packageJsonPath = require_.resolve(`${probePackage}/package.json`)
    const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
    const record = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {}
    const bin = typeof record["bin"] === "object" && record["bin"] !== null
      ? record["bin"] as Record<string, unknown>
      : {}
    const relative = typeof bin["probe"] === "string" ? bin["probe"] : "bin/probe.mjs"
    return {
      version: typeof record["version"] === "string" ? record["version"] : "",
      binPath: path.join(path.dirname(packageJsonPath), relative)
    }
  } catch {
    return undefined
  }
}

/**
 * Cheap, read-nothing check for whether Claude credentials look present on
 * this machine: an API key in the controller's own environment or a
 * credential file's existence. File contents are never read. `null` means we
 * cannot cheaply tell (e.g. macOS keychain-stored OAuth), which is an honest
 * first-class answer.
 */
export const claudeAuthReady = (): boolean | null => {
  if ((process.env["ANTHROPIC_API_KEY"] ?? "") !== "") {
    return true
  }
  const home = os.homedir()
  if (
    fs.existsSync(path.join(home, ".claude", ".credentials.json")) ||
    fs.existsSync(path.join(home, ".claude.json"))
  ) {
    return true
  }
  return null
}

/**
 * Auth readiness for an operator-configured agent: when the operator named
 * env opt-ins, their presence in the controller's environment is the signal;
 * with no named opt-ins we cannot cheaply tell.
 */
const configAuthReady = (entry: AgentConfigEntry): boolean | null => {
  if (entry.env.length === 0) {
    return null
  }
  return entry.env.every((name) => (process.env[name] ?? "") !== "")
}

/** Where `which` finds a binary, or "" — never throws. */
const binaryOnPath = (name: string): string => {
  const argv0 = process.platform === "win32" ? "where" : "which"
  try {
    const result = spawnSync(argv0, [name], { shell: false, timeout: 5_000, encoding: "utf8" })
    if (result.status === 0) {
      return (result.stdout.split("\n")[0] ?? "").trim()
    }
  } catch {
    // absence is an answer
  }
  return ""
}

/**
 * Build the committed catalog for this machine: operator config entries, then
 * the pinned claude adapter (unless the operator overrode the id), then — for
 * one release of legacy compatibility — a synthesized `devin` entry when the
 * devin binary is on PATH and the operator has not configured it explicitly.
 */
export const buildCatalog = (config: ControllerConfig): ReadonlyArray<CatalogEntry> => {
  const entries: Array<CatalogEntry> = []
  const seen = new Set<string>()

  for (const entry of config.agents) {
    if (seen.has(entry.id)) {
      continue
    }
    seen.add(entry.id)
    entries.push({
      id: entry.id,
      source: "config",
      argv: entry.argv,
      envPassthrough: entry.env,
      version: "",
      authReady: configAuthReady(entry)
    })
  }

  // The first-party probe agent, pinned like claude. It needs NO machine
  // credential — authority arrives per delegation as a Sarah inference grant
  // injected at spawn — so its auth is ready on every paired machine. That is
  // exactly what "a free coding agent for every Sarah user" requires.
  if (!seen.has("probe")) {
    const pinned = resolvePinnedProbeAgent(config.probePath)
    if (pinned !== undefined) {
      seen.add("probe")
      entries.push({
        id: "probe",
        source: "pinned",
        argv: [process.execPath, pinned.binPath, "acp"],
        envPassthrough: [],
        version: pinned.version,
        authReady: true
      })
    }
  }

  if (!seen.has("claude")) {
    const pinned = resolvePinnedClaudeAdapter()
    if (pinned !== undefined) {
      seen.add("claude")
      entries.push({
        id: "claude",
        source: "pinned",
        argv: [process.execPath, pinned.binPath],
        envPassthrough: [],
        version: pinned.version,
        authReady: claudeAuthReady()
      })
    }
  }

  // Legacy compatibility (one release): the `devin` delegation used to be
  // resolved from PATH with no configuration. Keep that working until every
  // operator has an explicit config entry.
  if (!seen.has("devin")) {
    const devinPath = binaryOnPath("devin")
    if (devinPath !== "") {
      seen.add("devin")
      entries.push({
        id: "devin",
        source: "config",
        argv: [devinPath, "acp"],
        envPassthrough: [],
        version: "",
        authReady: null
      })
    }
  }

  return entries
}

export type Resolution =
  | { readonly _tag: "Resolved"; readonly entry: CatalogEntry }
  | {
    readonly _tag: "RegistryDownload"
    /** Resolved lazily: downloading is a side effect the caller schedules. */
    readonly agent: RegistryAgent
    readonly target: RegistryBinaryTarget
  }
  | {
    readonly _tag: "NotAvailable"
    readonly requestedId: string
    readonly availableIds: ReadonlyArray<string>
    readonly detail: string
  }

const notAvailable = (
  requestedId: string,
  catalog: ReadonlyArray<CatalogEntry>,
  detail: string
): Resolution => ({
  _tag: "NotAvailable",
  requestedId,
  availableIds: catalog.map((entry) => entry.id),
  detail
})

/** Registry platform identifier for this host, per the registry FORMAT. */
export const registryPlatform = (): string => {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch
  const platform = process.platform === "win32" ? "windows" : process.platform
  return `${platform}-${arch}`
}

/**
 * Resolve a requested agent id against the catalog, falling back to the
 * vendored registry snapshot only when the operator opted in. npx/uvx
 * distributions resolve to argv immediately; binary distributions resolve to
 * a download plan and are refused outright without a sha256.
 */
export const resolveAgent = (
  requestedId: string,
  config: ControllerConfig,
  catalog: ReadonlyArray<CatalogEntry> = buildCatalog(config)
): Resolution => {
  const local = catalog.find((entry) => entry.id === requestedId)
  if (local !== undefined) {
    return { _tag: "Resolved", entry: local }
  }

  if (!config.registryAgents) {
    return notAvailable(
      requestedId,
      catalog,
      "registry resolution is off; enable it with `--allow registry-agents` or add a config entry"
    )
  }

  const agent = registrySnapshot.find((entry) => entry.id === requestedId)
  if (agent === undefined) {
    return notAvailable(requestedId, catalog, "not in the vendored registry snapshot")
  }

  const optIns = config.agents.find((entry) => entry.id === requestedId)?.env ?? []

  if (agent.distribution.npx !== undefined) {
    const npx = agent.distribution.npx
    return {
      _tag: "Resolved",
      entry: {
        id: agent.id,
        source: "registry",
        argv: ["npx", "-y", npx.package, ...npx.args],
        envPassthrough: optIns,
        version: agent.version,
        authReady: null
      }
    }
  }

  if (agent.distribution.uvx !== undefined) {
    const uvx = agent.distribution.uvx
    return {
      _tag: "Resolved",
      entry: {
        id: agent.id,
        source: "registry",
        argv: ["uvx", uvx.package, ...uvx.args],
        envPassthrough: optIns,
        version: agent.version,
        authReady: null
      }
    }
  }

  const target = agent.distribution.binary?.[registryPlatform()]
  if (target === undefined) {
    return notAvailable(requestedId, catalog, `no distribution for platform ${registryPlatform()}`)
  }
  if (!/^[0-9a-fA-F]{64}$/.test(target.sha256)) {
    return notAvailable(
      requestedId,
      catalog,
      "binary distribution has no sha256; the controller refuses unverifiable downloads"
    )
  }
  return { _tag: "RegistryDownload", agent, target }
}

export const sha256Of = (file: string): string => {
  const hash = createHash("sha256")
  hash.update(fs.readFileSync(file))
  return hash.digest("hex")
}

const archiveKind = (archiveUrl: string): "tar" | "zip" | "raw" => {
  const lowered = archiveUrl.toLowerCase().split("?")[0] ?? ""
  if (/\.(tar\.gz|tgz|tar\.bz2|tbz2)$/.test(lowered)) {
    return "tar"
  }
  if (lowered.endsWith(".zip")) {
    return "zip"
  }
  return "raw"
}

/**
 * Download, sha256-verify, and unpack a registry binary distribution into
 * the controller's own cache directory. Extraction runs `tar`/`unzip` with
 * argv only. Returns the argv to spawn, or throws with a reason. This runs
 * only behind the `registry-agents` opt-in.
 */
export const prepareRegistryBinary = async (
  agent: RegistryAgent,
  target: RegistryBinaryTarget
): Promise<ReadonlyArray<string>> => {
  const cacheDir = path.join(configDirectory(), "registry-agents", `${agent.id}-${agent.version}`)
  const cmdPath = path.resolve(cacheDir, target.cmd)
  if (!cmdPath.startsWith(path.resolve(cacheDir) + path.sep)) {
    throw new Error("registry cmd escapes the extraction directory")
  }
  if (fs.existsSync(cmdPath)) {
    return [cmdPath, ...target.args]
  }
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })

  const response = await fetch(target.archive)
  if (!response.ok || response.body === null) {
    throw new Error(`download failed: ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const archivePath = path.join(cacheDir, "archive.download")
  fs.writeFileSync(archivePath, bytes, { mode: 0o600 })

  const digest = sha256Of(archivePath)
  if (digest.toLowerCase() !== target.sha256.toLowerCase()) {
    fs.rmSync(archivePath)
    throw new Error(`sha256 mismatch: expected ${target.sha256}, got ${digest}`)
  }

  const kind = archiveKind(target.archive)
  if (kind === "raw") {
    fs.renameSync(archivePath, cmdPath)
    fs.chmodSync(cmdPath, 0o755)
    return [cmdPath, ...target.args]
  }
  const extractArgv = kind === "tar"
    ? ["tar", "xf", archivePath, "-C", cacheDir]
    : ["unzip", "-o", archivePath, "-d", cacheDir]
  const [extractor, ...extractorArgs] = extractArgv
  const result = spawnSync(extractor as string, extractorArgs, { shell: false, timeout: 120_000 })
  fs.rmSync(archivePath, { force: true })
  if (result.status !== 0) {
    throw new Error(`archive extraction failed (exit ${String(result.status)})`)
  }
  if (!fs.existsSync(cmdPath)) {
    throw new Error("archive did not contain the declared cmd")
  }
  fs.chmodSync(cmdPath, 0o755)
  return [cmdPath, ...target.args]
}

/**
 * Environment for an agent subprocess: the scrubbed passthrough allowlist,
 * plus the named per-agent opt-ins copied from the controller's own
 * environment. Opt-in values never come from the server.
 */
export const agentEnvironment = (
  envPassthrough: ReadonlyArray<string>,
  source: Record<string, string | undefined> = process.env
): Record<string, string> => {
  const env = scrubbedEnvironment(source)
  for (const name of envPassthrough) {
    const value = source[name]
    if (value !== undefined) {
      env[name] = value
    }
  }
  return env
}

/** Bound on the probe's `acp_agents` array, like every other probe field. */
const maximumInventoryEntries = 64
const maximumVersionLength = 120

export interface AcpAgentInventoryEntry {
  readonly id: string
  readonly source: CatalogSource
  readonly version: string
  readonly auth_ready: boolean | null
}

/**
 * The probe's `acp_agents` inventory: every catalog entry, plus — when the
 * operator opted in to registry resolution — the resolvable registry ids.
 * Bounded and normalized like every other probe field.
 */
export const acpAgentInventory = (config: ControllerConfig): ReadonlyArray<AcpAgentInventoryEntry> => {
  const catalog = buildCatalog(config)
  const entries: Array<AcpAgentInventoryEntry> = catalog.map((entry) => ({
    id: entry.id,
    source: entry.source,
    version: entry.version.slice(0, maximumVersionLength),
    auth_ready: entry.authReady
  }))
  if (config.registryAgents) {
    const seen = new Set(entries.map((entry) => entry.id))
    for (const agent of registrySnapshot) {
      if (entries.length >= maximumInventoryEntries) {
        break
      }
      if (seen.has(agent.id)) {
        continue
      }
      seen.add(agent.id)
      entries.push({
        id: agent.id,
        source: "registry",
        version: agent.version.slice(0, maximumVersionLength),
        auth_ready: null
      })
    }
  }
  return entries.slice(0, maximumInventoryEntries)
}
