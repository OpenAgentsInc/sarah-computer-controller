import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import type { ChildProcessSpawner } from "effect/unstable/process"

import * as Api from "./Api.js"
import * as Channel from "./Channel.js"
import * as Config from "./Config.js"
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
            onJoined: () => console.log("Connected. Serving read-only discovery requests."),
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
              )
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
