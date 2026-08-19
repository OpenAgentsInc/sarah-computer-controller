/**
 * On-disk controller configuration. The machine, not the server, owns these
 * values: the tier and roots recorded here bound everything Sarah may ask for.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { defaultCuratedExecute } from "./AcpAgent.js"
import type { Tier } from "./Policy.js"

/**
 * One operator-configured ACP agent: how to spawn it (argv only, no shell)
 * and which named environment variables may pass through the scrubbed
 * allowlist to it. Env passthrough is a deliberate, recorded opt-in per
 * agent — never a server-supplied value.
 */
export interface AgentConfigEntry {
  readonly id: string
  readonly argv: ReadonlyArray<string>
  readonly env: ReadonlyArray<string>
}

export interface ControllerConfig {
  readonly endpoint: string
  readonly tier: Tier
  readonly roots: ReadonlyArray<string>
  readonly preApproved: ReadonlyArray<string>
  readonly machineName: string
  readonly machineId: string
  /** Operator-installed ACP agents, keyed by the id Sarah asks for. */
  readonly agents: ReadonlyArray<AgentConfigEntry>
  /**
   * Opt-in: allow resolving unknown agent ids from the vendored ACP registry
   * snapshot. Off by default — resolution downloads and runs code, so it is a
   * named opt-in (`--allow registry-agents`) like every widened capability.
   */
  readonly registryAgents: boolean
  /**
   * Named programs a curated-tier ACP delegation may execute (every command
   * chain segment must head with one of these, or `cd`). Owner opt-in
   * recorded 2026-08-17 so delegated agents can use `gh`.
   */
  readonly curatedExecute: ReadonlyArray<string>
  /**
   * Operator-granted extensions to the curated-tier DIRECT `run` allowlist,
   * keyed by argv[0] with the permitted first arguments (empty = the bare
   * command). Symmetric with `curatedExecute` (which governs delegated ACP
   * shells): this governs `computer_run`. Off by default; a deploy machine
   * might set `{"gcloud": ["run", "builds", "config", "auth"]}` so
   * `gcloud run deploy …` is permitted while `gcloud secrets …` is not. The
   * compiled deny floor (sudo/chmod/…) still overrides everything here.
   */
  readonly curatedRun: Readonly<Record<string, ReadonlyArray<string>>>
  /**
   * Explicit path to the first-party probe agent binary. Overrides the
   * pinned `@openagentsinc/probe` npm resolution; also settable via
   * `SARAH_PROBE_BIN`. Empty means "resolve the pinned package if present".
   */
  readonly probePath: string
}

export const defaultEndpoint = "https://stage.openagents.com"

export const configDirectory = (): string => {
  const override = process.env["SARAH_CONTROLLER_HOME"]
  if (override !== undefined && override !== "") {
    return override
  }
  if (process.platform === "win32") {
    return path.join(process.env["APPDATA"] ?? os.homedir(), "sarah-computer-controller")
  }
  const base = process.env["XDG_CONFIG_HOME"]
  return path.join(base !== undefined && base !== "" ? base : path.join(os.homedir(), ".config"), "sarah-controller")
}

export const configPath = (): string => path.join(configDirectory(), "config.json")

export const tokenPath = (): string => path.join(configDirectory(), "token")

export const defaultConfig = (): ControllerConfig => ({
  endpoint: defaultEndpoint,
  tier: "probe",
  roots: [],
  preApproved: [],
  machineName: os.hostname(),
  machineId: "",
  agents: [],
  registryAgents: false,
  curatedExecute: [...defaultCuratedExecute],
  curatedRun: {},
  probePath: ""
})

const isTier = (value: unknown): value is Tier => value === "probe" || value === "curated" || value === "shell"

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

// A curated-run key is one command name; its value is the permitted first
// arguments. Bounded (≤16 commands, ≤32 args each) and shape-validated so a
// malformed config can never widen more than intended.
const commandNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

const readCuratedRun = (value: unknown): Readonly<Record<string, ReadonlyArray<string>>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, ReadonlyArray<string>> = {}
  for (const [name, args] of Object.entries(value as Record<string, unknown>).slice(0, 16)) {
    if (!commandNamePattern.test(name)) {
      continue
    }
    out[name] = stringArray(args).map((entry) => entry.trim()).filter((entry) => entry !== "").slice(0, 32)
  }
  return out
}

const agentIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * Normalize the on-disk `agents` object (`{ "devin": { "argv": [...], "env":
 * [...] } }`) into validated entries. Malformed entries are dropped rather
 * than trusted: an agent with no argv cannot be spawned.
 */
export const readAgentEntries = (value: unknown): ReadonlyArray<AgentConfigEntry> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return []
  }
  const entries: Array<AgentConfigEntry> = []
  for (const [id, raw] of Object.entries(value)) {
    if (!agentIdPattern.test(id) || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      continue
    }
    const body = raw as Record<string, unknown>
    const argv = stringArray(body["argv"])
    if (argv.length === 0) {
      continue
    }
    entries.push({ id, argv, env: stringArray(body["env"]) })
  }
  return entries
}

const writeAgentEntries = (agents: ReadonlyArray<AgentConfigEntry>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const entry of agents) {
    out[entry.id] = { argv: entry.argv, env: entry.env }
  }
  return out
}

export const readConfig = (): ControllerConfig => {
  const location = configPath()
  if (!fs.existsSync(location)) {
    return defaultConfig()
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(location, "utf8"))
  if (typeof parsed !== "object" || parsed === null) {
    return defaultConfig()
  }
  const record = parsed as Record<string, unknown>
  const fallback = defaultConfig()
  return {
    endpoint: typeof record["endpoint"] === "string" ? record["endpoint"] : fallback.endpoint,
    tier: isTier(record["tier"]) ? record["tier"] : fallback.tier,
    roots: stringArray(record["roots"]),
    preApproved: stringArray(record["preApproved"]),
    machineName: typeof record["machineName"] === "string" ? record["machineName"] : fallback.machineName,
    machineId: typeof record["machineId"] === "string" ? record["machineId"] : fallback.machineId,
    agents: readAgentEntries(record["agents"]),
    registryAgents: record["registryAgents"] === true,
    curatedExecute: "curatedExecute" in record
      ? stringArray(record["curatedExecute"]).map((entry) => entry.trim()).filter((entry) => entry !== "").slice(0, 32)
      : fallback.curatedExecute,
    curatedRun: readCuratedRun(record["curatedRun"]),
    probePath: typeof record["probePath"] === "string" ? record["probePath"] : fallback.probePath
  }
}

export const writeConfig = (config: ControllerConfig): void => {
  fs.mkdirSync(configDirectory(), { recursive: true, mode: 0o700 })
  const serialized = { ...config, agents: writeAgentEntries(config.agents) }
  fs.writeFileSync(configPath(), `${JSON.stringify(serialized, null, 2)}\n`, { mode: 0o600 })
}

export const hasToken = (): boolean => fs.existsSync(tokenPath())

/**
 * The machine token lives in a `0600` file under the controller's own
 * directory and is never printed, journalled, or passed as an argument.
 */
export const writeToken = (token: string): void => {
  fs.mkdirSync(configDirectory(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(tokenPath(), token, { mode: 0o600 })
}

export const readToken = (): string | undefined => {
  if (!hasToken()) {
    return undefined
  }
  const token = fs.readFileSync(tokenPath(), "utf8").trim()
  return token === "" ? undefined : token
}

export const removeToken = (): void => {
  if (hasToken()) {
    fs.rmSync(tokenPath())
  }
}

/** Resolve declared roots to absolute paths so policy comparisons are sound. */
export const resolveRoots = (roots: ReadonlyArray<string>): ReadonlyArray<string> =>
  roots.map((root) => path.resolve(root.replace(/^~(?=$|\/)/, os.homedir())))
