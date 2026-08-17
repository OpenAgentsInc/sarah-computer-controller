/**
 * The operator's own audit trail. Everything Sarah asks for is appended here,
 * whether it ran or was refused, so the question "what did she do on my
 * machine?" is answerable locally without asking OpenAgents.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { configDirectory } from "./Config.js"

export interface JournalEntry {
  readonly at: string
  readonly requestId: string
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly outcome: string
  readonly detail: string
}

export const journalPath = (): string => path.join(configDirectory(), "journal.log")

export const append = (entry: Omit<JournalEntry, "at">): void => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  fs.mkdirSync(configDirectory(), { recursive: true, mode: 0o700 })
  fs.appendFileSync(journalPath(), `${line}\n`, { mode: 0o600 })
}

export const read = (limit: number): ReadonlyArray<JournalEntry> => {
  const location = journalPath()
  if (!fs.existsSync(location)) {
    return []
  }
  const lines = fs.readFileSync(location, "utf8").split("\n").filter((line) => line.trim() !== "")
  return lines.slice(-limit).map((line) => JSON.parse(line) as JournalEntry)
}
