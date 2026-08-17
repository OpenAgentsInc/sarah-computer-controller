/**
 * On-disk controller configuration. The machine, not the server, owns these
 * values: the tier and roots recorded here bound everything Sarah may ask for.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { Tier } from "./Policy.js"

export interface ControllerConfig {
  readonly endpoint: string
  readonly tier: Tier
  readonly roots: ReadonlyArray<string>
  readonly preApproved: ReadonlyArray<string>
  readonly machineName: string
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
  machineName: os.hostname()
})

const isTier = (value: unknown): value is Tier => value === "probe" || value === "curated" || value === "shell"

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

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
    machineName: typeof record["machineName"] === "string" ? record["machineName"] : fallback.machineName
  }
}

export const writeConfig = (config: ControllerConfig): void => {
  fs.mkdirSync(configDirectory(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

export const hasToken = (): boolean => fs.existsSync(tokenPath())

export const removeToken = (): void => {
  if (hasToken()) {
    fs.rmSync(tokenPath())
  }
}

/** Resolve declared roots to absolute paths so policy comparisons are sound. */
export const resolveRoots = (roots: ReadonlyArray<string>): ReadonlyArray<string> =>
  roots.map((root) => path.resolve(root.replace(/^~(?=$|\/)/, os.homedir())))
