/**
 * Bounded command execution. Every command Sarah asks for runs through here,
 * so the limits in this module are the limits of what she can do to a machine.
 */

import { spawn as nodeSpawn } from "node:child_process"

import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process"

export interface ExecutionLimits {
  /** Wall-clock ceiling for a single command. */
  readonly timeoutMillis: number
  /** Combined stdout/stderr ceiling. Output beyond this is dropped. */
  readonly maximumOutputBytes: number
}

export const defaultLimits: ExecutionLimits = {
  timeoutMillis: 30_000,
  maximumOutputBytes: 64 * 1024
}

export interface ExecutionOutcome {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly exitCode: number
  readonly output: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly durationMillis: number
}

/**
 * Environment variables passed through to child processes. Everything else is
 * withheld, so a leaked token in the controller's own environment does not
 * become readable by a command Sarah proposed.
 */
export const passthroughEnvironmentNames = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "USER", "TERM"]

export const scrubbedEnvironment = (source: Record<string, string | undefined>): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const name of passthroughEnvironmentNames) {
    const value = source[name]
    if (value !== undefined) {
      result[name] = value
    }
  }
  return result
}

/** Secret-shaped substrings are masked before output leaves the machine. */
const secretPatterns: ReadonlyArray<RegExp> = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9-_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
]

/**
 * Exact secret values registered at runtime — e.g. a Sarah inference grant
 * injected for a delegation. Pattern matching cannot know a grant token's
 * shape, so the value is registered here and masked like any other secret
 * before output leaves the machine.
 */
const runtimeSecrets = new Set<string>()

/** Register an exact secret value so scrubSecrets masks it. Short values are
 * ignored to avoid masking innocuous substrings. */
export const registerRuntimeSecret = (value: string): void => {
  if (value.length >= 8) {
    runtimeSecrets.add(value)
  }
}

export const scrubSecrets = (text: string): string => {
  let out = secretPatterns.reduce((accumulator, pattern) => accumulator.replace(pattern, "[redacted]"), text)
  for (const secret of runtimeSecrets) {
    out = out.split(secret).join("[redacted]")
  }
  return out
}

const decoder = new TextDecoder()

const collectBounded = (
  stream: Stream.Stream<Uint8Array, unknown>,
  maximumOutputBytes: number
): Effect.Effect<{ readonly text: string; readonly truncated: boolean }, unknown> =>
  Stream.runFold(
    stream,
    () => ({ bytes: [] as Array<Uint8Array>, size: 0, truncated: false }),
    (accumulator, chunk: Uint8Array) => {
      if (accumulator.size >= maximumOutputBytes) {
        return { ...accumulator, truncated: true }
      }
      const remaining = maximumOutputBytes - accumulator.size
      const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
      accumulator.bytes.push(slice)
      return {
        bytes: accumulator.bytes,
        size: accumulator.size + slice.byteLength,
        truncated: accumulator.truncated || slice.byteLength < chunk.byteLength
      }
    }
  ).pipe(
    Effect.map((accumulator) => {
      const buffer = new Uint8Array(accumulator.size)
      let offset = 0
      for (const chunk of accumulator.bytes) {
        buffer.set(chunk, offset)
        offset = offset + chunk.byteLength
      }
      return { text: scrubSecrets(decoder.decode(buffer)), truncated: accumulator.truncated }
    })
  )

/**
 * Run one command with argv only. There is no shell, so no server-supplied
 * string is ever interpreted, and `cwd`/`env` are fixed by the caller.
 */
export const execute = (
  argv: ReadonlyArray<string>,
  cwd: string,
  limits: ExecutionLimits = defaultLimits
): Effect.Effect<ExecutionOutcome, unknown, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const [command, ...args] = argv
    if (command === undefined) {
      return yield* Effect.fail(new Error("no command was supplied"))
    }

    const startedAt = Date.now()

    const run = Effect.gen(function*() {
      const handle = yield* ChildProcess.make(command, args, {
        cwd,
        env: scrubbedEnvironment(process.env),
        shell: false
      })
      const collected = yield* collectBounded(handle.all, limits.maximumOutputBytes)
      const exitCode = yield* handle.exitCode
      return { collected, exitCode }
    }).pipe(Effect.scoped)

    const result = yield* Effect.timeout(run, limits.timeoutMillis).pipe(Effect.option)

    if (result._tag === "None") {
      return {
        argv,
        cwd,
        exitCode: 124,
        output: "",
        truncated: false,
        timedOut: true,
        durationMillis: Date.now() - startedAt
      }
    }

    return {
      argv,
      cwd,
      exitCode: Number(result.value.exitCode),
      output: result.value.collected.text,
      truncated: result.value.collected.truncated,
      timedOut: false,
      durationMillis: Date.now() - startedAt
    }
  })

export interface StreamedOutcome {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly exitCode: number
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly durationMillis: number
}

export interface RunningExecution {
  readonly done: Promise<StreamedOutcome>
  readonly cancel: () => void
}

/**
 * Run one command with argv only, streaming bounded, secret-scrubbed output
 * chunks as they arrive instead of aggregating them. Used for the channel
 * `run` path so Sarah sees progress while a command executes. The returned
 * cancel handle kills the process; the promise always settles exactly once.
 */
export const executeStreamed = (
  argv: ReadonlyArray<string>,
  cwd: string,
  limits: ExecutionLimits,
  onChunk: (text: string) => void
): RunningExecution => {
  const startedAt = Date.now()
  const [command, ...args] = argv
  let settled = false
  let cancelled = false
  let timedOut = false
  let outputBytes = 0
  let truncated = false
  let resolveDone: (outcome: StreamedOutcome) => void
  const done = new Promise<StreamedOutcome>((resolve) => {
    resolveDone = resolve
  })

  const finish = (exitCode: number): void => {
    if (settled) {
      return
    }
    settled = true
    resolveDone({ argv, cwd, exitCode, truncated, timedOut, cancelled, durationMillis: Date.now() - startedAt })
  }

  if (command === undefined) {
    setTimeout(() => finish(127), 0)
    return { done, cancel: () => undefined }
  }

  const child = nodeSpawn(command, args, {
    cwd,
    env: scrubbedEnvironment(process.env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  })

  const emit = (chunk: Buffer): void => {
    if (outputBytes >= limits.maximumOutputBytes) {
      truncated = true
      return
    }
    const text = scrubSecrets(chunk.toString("utf8"))
    const remaining = limits.maximumOutputBytes - outputBytes
    const bounded = text.length > remaining ? text.slice(0, remaining) : text
    truncated = truncated || bounded.length < text.length
    outputBytes += bounded.length
    if (bounded !== "") {
      onChunk(bounded)
    }
  }

  child.stdout.on("data", emit)
  child.stderr.on("data", emit)

  const kill = (): void => {
    try {
      child.kill("SIGTERM")
      setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // already gone
        }
      }, 3_000).unref()
    } catch {
      // already gone
    }
  }

  const timeout = setTimeout(() => {
    timedOut = true
    kill()
  }, limits.timeoutMillis)
  timeout.unref()

  child.on("error", () => {
    clearTimeout(timeout)
    finish(127)
  })

  child.on("close", (code) => {
    clearTimeout(timeout)
    finish(code ?? (timedOut || cancelled ? 124 : 1))
  })

  return {
    done,
    cancel: () => {
      cancelled = true
      kill()
    }
  }
}

/**
 * Run a command and return its trimmed first line, or `""` when it is absent or
 * fails. Discovery treats absence as an answer, never as an error.
 */
export const executeQuietly = (
  argv: ReadonlyArray<string>,
  cwd: string,
  limits: ExecutionLimits = defaultLimits
): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
  execute(argv, cwd, limits).pipe(
    Effect.map((outcome) => (outcome.exitCode === 0 ? (outcome.output.split("\n")[0] ?? "").trim() : "")),
    Effect.catchCause(() => Effect.succeed(""))
  )
