import * as path from "node:path"

import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import type { ChildProcessSpawner } from "effect/unstable/process"

import * as Api from "./Api.js"
import * as Channel from "./Channel.js"
import * as Config from "./Config.js"
import * as DevinAcp from "./DevinAcp.js"
import * as Executor from "./Executor.js"
import * as Journal from "./Journal.js"
import * as Policy from "./Policy.js"
import * as Probe from "./Probe.js"

const version = "0.1.0"

const rootFlag = Flag.string("root").pipe(
  Flag.withDescription("A directory Sarah may work inside. Repeatable."),
  Flag.atLeast(0)
)

const tierFlag = Flag.choice("allow", ["probe", "curated", "shell"]).pipe(
  Flag.withDescription("Capability tier granted to Sarah on this machine"),
  Flag.withDefault("probe" as Policy.Tier)
)

const endpointFlag = Flag.string("endpoint").pipe(
  Flag.withDescription("Sarah API base URL"),
  Flag.withDefault(Config.defaultEndpoint)
)

const effectiveRoots = (roots: ReadonlyArray<string>): ReadonlyArray<string> => {
  const stored = Config.readConfig().roots
  const chosen = roots.length > 0 ? roots : stored.length > 0 ? stored : [process.cwd()]
  return Config.resolveRoots(chosen)
}

const probeCommand = Command.make("probe", { root: rootFlag }, ({ root }) =>
  Effect.gen(function*() {
    const report = yield* Probe.probe(effectiveRoots(root))
    yield* Console.log(Probe.formatReport(report))
  })).pipe(
    Command.withDescription(
      "Report this machine's coding agents, toolchains, and host facts. Works with no account."
    )
  )

const policyCommand = Command.make(
  "policy",
  { root: rootFlag, allow: tierFlag },
  ({ allow, root }) =>
    Effect.gen(function*() {
      const stored = Config.readConfig()
      const tier = allow === "probe" ? stored.tier : allow
      const roots = effectiveRoots(root)
      yield* Console.log(`tier         ${tier}`)
      yield* Console.log(`roots        ${roots.join(", ")}`)
      yield* Console.log(`pre-approved ${stored.preApproved.join(", ") || "(none)"}`)
      yield* Console.log("")
      yield* Console.log("curated allowlist")
      for (const [name, permitted] of Object.entries(Policy.curatedAllowlist)) {
        yield* Console.log(
          `  ${name.padEnd(10)} ${permitted.length === 0 ? "(any read-only invocation)" : permitted.join(" ")}`
        )
      }
    })
).pipe(Command.withDescription("Show the effective tier, roots, and command allowlist"))

const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function*() {
    const config = Config.readConfig()
    yield* Console.log(`endpoint  ${config.endpoint}`)
    yield* Console.log(`machine   ${config.machineName}`)
    yield* Console.log(`tier      ${config.tier}`)
    yield* Console.log(`roots     ${config.roots.join(", ") || "(none declared)"}`)
    yield* Console.log(`paired    ${Config.hasToken() ? "yes" : "no"}`)
    yield* Console.log(`journal   ${Journal.journalPath()}`)
  })).pipe(Command.withDescription("Show pairing state and where local files live"))

const journalCommand = Command.make(
  "journal",
  { limit: Flag.integer("limit").pipe(Flag.withDefault(20)) },
  ({ limit }) =>
    Effect.gen(function*() {
      const entries = Journal.read(limit)
      if (entries.length === 0) {
        yield* Console.log("No requests recorded yet.")
        return
      }
      for (const entry of entries) {
        yield* Console.log(`${entry.at}  ${entry.outcome.padEnd(10)} ${entry.argv.join(" ")}`)
      }
    })
).pipe(Command.withDescription("Show what Sarah has asked this machine to do"))

const pairCommand = Command.make(
  "pair",
  { allow: tierFlag, endpoint: endpointFlag, root: rootFlag },
  ({ allow, endpoint, root }) =>
    Effect.gen(function*() {
      const roots = effectiveRoots(root)
      const stored = Config.readConfig()
      Config.writeConfig({ ...stored, endpoint, roots, tier: allow })

      const start = yield* Api.startPairing({
        endpoint,
        name: stored.machineName,
        tier: allow,
        platform: `${process.platform}-${process.arch}`,
        agentVersion: version,
        roots
      })

      yield* Console.log(`Approve this machine at ${start.verifyUrl}`)
      yield* Console.log(`Pairing code  ${start.code}`)
      yield* Console.log("Waiting for approval…")

      const claim = yield* awaitApproval(endpoint, start)
      Config.writeToken(claim.token)
      Config.writeConfig({ ...Config.readConfig(), machineId: claim.machineId })
      yield* Console.log(`Paired as "${claim.name}". Run \`sarah-computer-controller up\` to connect.`)
    })
).pipe(Command.withDescription("Record endpoint, tier, and roots, then pair this machine with Sarah"))

const awaitApproval = (
  endpoint: string,
  start: Api.PairingStart
): Effect.Effect<Api.PairingClaim, Api.ApiError> =>
  Effect.gen(function*() {
    const outcome = yield* Api.pollPairing(endpoint, start.pairingId, start.pollSecret)
    if (outcome._tag === "Approved") {
      return outcome.claim
    }
    if (outcome._tag === "Expired") {
      return yield* Effect.fail(new Api.ApiError({ reason: "pairing_expired" }))
    }
    yield* Effect.sleep(`${start.intervalSeconds} seconds`)
    return yield* awaitApproval(endpoint, start)
  })

const stringArray = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? value
    : undefined

const boundedTimeout = (value: unknown, fallback: number, maximum: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), maximum) : fallback

const resolveCwd = (value: unknown, roots: ReadonlyArray<string>): string => {
  const fallback = roots[0] ?? process.cwd()
  if (typeof value !== "string" || value.trim() === "") {
    return fallback
  }
  const absolute = path.resolve(value)
  return roots.some((root) => Policy.withinRoot(absolute, root)) ? absolute : fallback
}

/**
 * Which ACP permission requests the local tier grants. `shell` allows any
 * tool Devin proposes; `curated` allows only read-shaped tools; `probe`
 * (and anything unrecognized) is refused. Never maps to an "always" grant.
 */
export const devinPermissionAllowed = (tier: Policy.Tier, kind: string): boolean => {
  if (tier === "shell") {
    return true
  }
  if (tier === "curated") {
    return ["read", "search", "fetch", "think"].includes(kind)
  }
  return false
}

const upCommand = Command.make(
  "up",
  { endpoint: endpointFlag, root: rootFlag },
  ({ endpoint, root }) =>
    Effect.gen(function*() {
      const stored = Config.readConfig()
      const token = Config.readToken()
      if (token === undefined || stored.machineId === "") {
        yield* Console.log("This machine is not paired. Run `sarah-computer-controller pair` first.")
        return
      }
      const roots = effectiveRoots(root)
      const target = endpoint === Config.defaultEndpoint ? stored.endpoint : endpoint
      const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>()
      const initial = yield* Probe.probe(roots)
      const policyConfig: Policy.PolicyConfig = {
        tier: stored.tier,
        roots,
        preApproved: stored.preApproved
      }
      const devinPath = initial.codingAgents.find((agent) => agent.name === "devin" && agent.present)?.path ?? ""

      /** Cancel handles for every in-flight run/devin request, by request id. */
      const active = new Map<string, () => void>()

      const handleRun = (requestId: string, payload: Record<string, unknown>, respond: Channel.Responder): void => {
        const argv = stringArray(payload["argv"])
        if (argv === undefined || argv.length === 0) {
          respond.refused("empty_command", "no command was supplied")
          return
        }
        const cwd = resolveCwd(payload["cwd"], roots)
        const decision = Policy.decide({ argv, cwd }, policyConfig)
        if (decision._tag === "Refused") {
          Journal.append({ requestId, argv, cwd, outcome: "refused", detail: decision.detail })
          respond.refused(decision.reason, decision.detail)
          return
        }
        const limits: Executor.ExecutionLimits = {
          timeoutMillis: boundedTimeout(payload["timeout_ms"], 30_000, 120_000),
          maximumOutputBytes: Executor.defaultLimits.maximumOutputBytes
        }
        const job = Executor.executeStreamed(argv, cwd, limits, respond.chunk)
        active.set(requestId, job.cancel)
        void job.done.then((outcome) => {
          active.delete(requestId)
          Journal.append({
            requestId,
            argv,
            cwd,
            outcome: outcome.cancelled ? "cancelled" : outcome.timedOut ? "timeout" : "ran",
            detail: `exit ${outcome.exitCode} in ${outcome.durationMillis}ms`
          })
          respond.exit({
            exit_code: outcome.exitCode,
            status: outcome.cancelled ? "cancelled" : outcome.timedOut ? "timeout" : "completed",
            timed_out: outcome.timedOut,
            truncated: outcome.truncated,
            duration_ms: outcome.durationMillis
          })
        })
      }

      const handleDevin = (requestId: string, payload: Record<string, unknown>, respond: Channel.Responder): void => {
        const prompt = typeof payload["prompt"] === "string" ? payload["prompt"] : ""
        if (prompt.trim() === "") {
          respond.refused("empty_command", "no prompt was supplied")
          return
        }
        if (stored.tier === "probe") {
          Journal.append({
            requestId,
            argv: ["devin", "acp"],
            cwd: roots[0] ?? process.cwd(),
            outcome: "refused",
            detail: "probe tier"
          })
          respond.refused("tier_insufficient", "this machine is paired at probe tier; only discovery is permitted")
          return
        }
        if (devinPath === "") {
          respond.exit({
            status: "unavailable",
            detail: "devin is not installed on this machine",
            session_id: "",
            duration_ms: 0,
            truncated: false
          })
          return
        }
        const cwd = resolveCwd(payload["cwd"], roots)
        const resumeSessionId = typeof payload["session_id"] === "string" && payload["session_id"] !== ""
          ? payload["session_id"]
          : undefined
        const job = DevinAcp.start({
          agentArgv: [devinPath, "acp"],
          prompt,
          cwd,
          resumeSessionId,
          env: process.env as Record<string, string>,
          limits: {
            ...DevinAcp.defaultDevinLimits,
            timeoutMillis: boundedTimeout(payload["timeout_ms"], DevinAcp.defaultDevinLimits.timeoutMillis, 600_000)
          },
          onChunk: respond.chunk,
          decidePermission: (query) => devinPermissionAllowed(stored.tier, query.kind)
        })
        active.set(requestId, job.cancel)
        void job.done.then((outcome) => {
          active.delete(requestId)
          Journal.append({
            requestId,
            argv: ["devin", "acp"],
            cwd,
            outcome: outcome.status,
            detail: outcome.detail !== "" ? outcome.detail : `stop reason ${outcome.stopReason || "none"}`
          })
          respond.exit({
            status: outcome.status,
            stop_reason: outcome.stopReason,
            session_id: outcome.sessionId,
            detail: outcome.detail,
            truncated: outcome.truncated,
            duration_ms: outcome.durationMillis
          })
        })
      }

      yield* Console.log(`Connecting to ${target} as "${stored.machineName}" (tier ${stored.tier}).`)

      const reason = yield* Effect.promise(() =>
        Channel.serve(
          {
            endpoint: target,
            token,
            machineId: stored.machineId,
            hello: {
              agent_version: version,
              tier: stored.tier,
              roots,
              probe: Probe.wireReport(initial)
            }
          },
          {
            onJoined: () =>
              console.log(`Connected. Serving discovery, command, and Devin requests (tier ${stored.tier}).`),
            onEvent: (message) => console.log(message),
            onProbe: (requestId) =>
              Effect.runPromiseWith(services)(
                Probe.probe(roots).pipe(
                  Effect.map((report) => {
                    Journal.append({
                      requestId,
                      argv: ["probe"],
                      cwd: roots[0] ?? process.cwd(),
                      outcome: "answered",
                      detail: "read-only discovery"
                    })
                    return Probe.wireReport(report)
                  })
                )
              ),
            onRun: handleRun,
            onDevin: handleDevin,
            onCancel: (requestId) => {
              const cancel = active.get(requestId)
              if (cancel !== undefined) {
                cancel()
              }
            },
            onClosed: () => {
              for (const cancel of active.values()) {
                cancel()
              }
              active.clear()
            }
          }
        )
      )

      yield* Console.log(`Disconnected (${reason}).`)
    })
).pipe(Command.withDescription("Connect to Sarah and serve bounded requests"))

const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function*() {
    Config.removeToken()
    yield* Console.log("Local token removed.")
  })).pipe(Command.withDescription("Remove the stored machine token"))

const controller = Command.make("sarah-computer-controller").pipe(
  Command.withDescription(
    "Pair your computer with Sarah and let her run bounded shell commands on it. Default tier is read-only discovery."
  ),
  Command.withSubcommands([
    probeCommand,
    policyCommand,
    statusCommand,
    journalCommand,
    pairCommand,
    upCommand,
    logoutCommand
  ])
)

export const run = Command.run(controller, { version })
