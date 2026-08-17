import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import * as Config from "./Config.js"
import * as Journal from "./Journal.js"
import * as Policy from "./Policy.js"
import * as Probe from "./Probe.js"

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
      Config.writeConfig({ ...Config.readConfig(), endpoint, roots, tier: allow })
      yield* Console.log(`Recorded endpoint ${endpoint}, tier ${allow}, roots ${roots.join(", ")}.`)
      yield* Console.log(
        "Device pairing against the Sarah API is not available yet — the pairing endpoint and machine channel ship with the next milestone. `probe` and `policy` work offline today."
      )
    })
).pipe(Command.withDescription("Record endpoint, tier, and roots, then pair this machine with Sarah"))

const upCommand = Command.make("up", { endpoint: endpointFlag }, ({ endpoint }) =>
  Effect.gen(function*() {
    if (!Config.hasToken()) {
      yield* Console.log("This machine is not paired. Run `sarah-computer-controller pair` first.")
      return
    }
    yield* Console.log(
      `Connecting to ${endpoint} is not available yet — the machine channel ships with the next milestone.`
    )
  })).pipe(Command.withDescription("Connect to Sarah and serve bounded requests"))

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

export const run = Command.run(controller, {
  version: "0.0.0"
})
