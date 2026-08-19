import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import type { ChildProcessSpawner } from "effect/unstable/process"

import * as AgentCatalog from "./AgentCatalog.js"
import * as AgentDispatch from "./AgentDispatch.js"
import * as Api from "./Api.js"
import * as Channel from "./Channel.js"
import * as Config from "./Config.js"
import * as Executor from "./Executor.js"
import * as Journal from "./Journal.js"
import * as Policy from "./Policy.js"
import * as Probe from "./Probe.js"
import { makeSink, SessionKeeper } from "./SessionKeeper.js"

const version = "0.1.0"

const rootFlag = Flag.string("root").pipe(
  Flag.withDescription("A directory Sarah may work inside. Repeatable."),
  Flag.atLeast(0)
)

/**
 * `--allow` names every widened capability: the tier (`probe`, `curated`,
 * `shell`) and the named opt-ins (`registry-agents`). Repeatable, e.g.
 * `--allow curated --allow registry-agents`.
 */
const allowFlag = Flag.choice("allow", ["probe", "curated", "shell", "registry-agents"]).pipe(
  Flag.withDescription(
    "Capability granted to Sarah on this machine: a tier (probe, curated, shell) and/or the registry-agents opt-in. Repeatable."
  ),
  Flag.atLeast(0)
)

const isTier = (value: string): value is Policy.Tier => value === "probe" || value === "curated" || value === "shell"

const chosenTier = (allow: ReadonlyArray<string>, fallback: Policy.Tier): Policy.Tier => {
  const tiers = allow.filter(isTier)
  return tiers[tiers.length - 1] ?? fallback
}

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
    const report = yield* Probe.probe(effectiveRoots(root), AgentCatalog.acpAgentInventory(Config.readConfig()))
    yield* Console.log(Probe.formatReport(report))
  })).pipe(
    Command.withDescription(
      "Report this machine's coding agents, toolchains, and host facts. Works with no account."
    )
  )

const policyCommand = Command.make(
  "policy",
  { root: rootFlag, allow: allowFlag },
  ({ allow, root }) =>
    Effect.gen(function*() {
      const stored = Config.readConfig()
      const tier = chosenTier(allow, stored.tier)
      const registryAgents = allow.includes("registry-agents") || stored.registryAgents
      const roots = effectiveRoots(root)
      yield* Console.log(`tier            ${tier}`)
      yield* Console.log(`roots           ${roots.join(", ")}`)
      yield* Console.log(`pre-approved    ${stored.preApproved.join(", ") || "(none)"}`)
      yield* Console.log(`registry-agents ${registryAgents ? "allowed" : "off"}`)
      yield* Console.log("")
      yield* Console.log("acp agents")
      for (const agent of AgentCatalog.acpAgentInventory({ ...stored, tier, registryAgents })) {
        yield* Console.log(
          `  ${agent.id.padEnd(14)} ${(agent.version || "—").padEnd(12)} ${agent.source}`
        )
      }
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
  { allow: allowFlag, endpoint: endpointFlag, root: rootFlag },
  ({ allow, endpoint, root }) =>
    Effect.gen(function*() {
      const roots = effectiveRoots(root)
      const stored = Config.readConfig()
      const tier = chosenTier(allow, "probe")
      const registryAgents = allow.includes("registry-agents")
      Config.writeConfig({ ...stored, endpoint, roots, tier, registryAgents })

      const start = yield* Api.startPairing({
        endpoint,
        name: stored.machineName,
        tier,
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

const { boundedTimeout, resolveCwd } = AgentDispatch

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
      const acpInventory = AgentCatalog.acpAgentInventory(stored)
      const initial = yield* Probe.probe(roots, acpInventory)
      const policyConfig: Policy.PolicyConfig = {
        tier: stored.tier,
        roots,
        preApproved: stored.preApproved,
        curatedRun: stored.curatedRun
      }

      /** Cancel handles for every in-flight run/agent request, by request id. */
      // Persists across reconnects (it lives here, outside Channel.serve), so a
      // long-running ACP session survives a server WS drop and can be
      // re-attached by session id after the server relocates to a survivor (M2).
      const keeper = new SessionKeeper()

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
        keeper.registerRun(requestId, job.cancel)
        void job.done.then((outcome) => {
          keeper.runDone(requestId)
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

      const handleAgent = (
        requestId: string,
        agentId: string,
        payload: Record<string, unknown>,
        respond: Channel.Responder
      ): void => {
        // Re-attach path: if this exact ACP session is still running here (it
        // survived a WS drop), just point its output at the new channel and skip
        // starting a fresh agent — no orphaned agent, work continues live.
        const resumeId = payload["resume_session_id"]
        if (typeof resumeId === "string" && resumeId !== "" && keeper.hasSession(resumeId)) {
          keeper.reattach(resumeId, respond)
          console.log(`Re-attached live session ${resumeId.slice(0, 8)} to the reconnected channel.`)
          return
        }

        // Fresh (or cold-resume) path: route the agent's output through a
        // swappable sink so a later reconnect can re-attach it, and register the
        // whole job with the keeper so a WS drop does not kill it.
        const sink = makeSink(respond)
        const sinkResponder: Channel.Responder = {
          chunk: sink.chunk,
          session: (id) => {
            sink.session(id)
            keeper.bindSession(requestId, id)
          },
          exit: sink.exit,
          refused: sink.refused
        }

        AgentDispatch.handleAgentEvent(requestId, agentId, payload, sinkResponder, {
          config: stored,
          roots,
          journal: Journal.append,
          registerCancel: (_id, _cancel) => {},
          unregisterCancel: (_id) => {},
          registerAgentJob: (id, job) => keeper.registerAgent(id, job, sink)
        })
      }

      yield* Console.log(`Connecting to ${target} as "${stored.machineName}" (tier ${stored.tier}).`)

      const connect = (): Promise<string> =>
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
              console.log(`Connected. Serving discovery, command, and agent requests (tier ${stored.tier}).`),
            onEvent: (message) => console.log(message),
            onProbe: (requestId) =>
              Effect.runPromiseWith(services)(
                Probe.probe(roots, AgentCatalog.acpAgentInventory(stored)).pipe(
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
            onAgent: handleAgent,
            onCancel: (requestId) => keeper.cancel(requestId),
            onClosed: () => keeper.onDisconnect()
          }
        )

      // Serve until the connection drops. If live ACP sessions are being kept
      // (a delegation is mid-flight), reconnect and let the server re-attach to
      // them by session id instead of exiting and orphaning the agent; with
      // nothing to keep, exit on the first disconnect exactly as before. Bounded
      // so a permanently-gone server does not spin forever (kept sessions time
      // out and empty the keeper, ending the loop).
      const reason = yield* Effect.promise(async () => {
        let last = ""
        for (let attempt = 0; attempt < 600; attempt++) {
          last = await connect()
          if (keeper.liveAgentCount() === 0) return last
          console.log(
            `Disconnected (${last}); keeping ${keeper.liveAgentCount()} live session(s) — reconnecting…`
          )
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        return last
      })

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
