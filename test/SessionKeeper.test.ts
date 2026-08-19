import { describe, expect, it } from "vitest"
import type { AgentJob } from "../src/AcpAgent.js"
import type { Responder } from "../src/Channel.js"
import { makeSink, SessionKeeper } from "../src/SessionKeeper.js"

const recorder = () => {
  const chunks: Array<string> = []
  const responder: Responder = {
    chunk: (t) => chunks.push(t),
    session: () => {},
    exit: () => {},
    refused: () => {}
  }
  return { chunks, responder }
}

const fakeJob = () => {
  let cancelled = false
  let resolve!: () => void
  const done = new Promise<any>((r) => (resolve = () => r({ status: "completed" })))
  const job: AgentJob = { done, cancel: () => (cancelled = true) } as unknown as AgentJob
  return { job, finish: resolve, wasCancelled: () => cancelled }
}

describe("SessionKeeper", () => {
  it("keeps an agent session alive across a disconnect and re-attaches its output", async () => {
    const keeper = new SessionKeeper()
    const a = recorder()
    const { job, wasCancelled } = fakeJob()

    const sink = makeSink(a.responder)
    keeper.registerAgent("req-1", job, sink)
    keeper.bindSession("req-1", "sess-42")

    // Output flows to the first channel.
    sink.chunk("before-drop")
    expect(a.chunks).toEqual(["before-drop"])

    // The WebSocket drops: the agent is NOT cancelled, just detached.
    keeper.onDisconnect()
    expect(wasCancelled()).toBe(false)
    expect(sink.attached()).toBe(false)
    sink.chunk("during-outage") // discarded, no throw
    expect(a.chunks).toEqual(["before-drop"])

    // A survivor reconnects and resumes by session id — output re-attaches.
    const b = recorder()
    expect(keeper.hasSession("sess-42")).toBe(true)
    expect(keeper.reattach("sess-42", b.responder)).toBe(true)
    sink.chunk("after-reattach")
    expect(b.chunks).toEqual(["after-reattach"])
    expect(a.chunks).toEqual(["before-drop"])
  })

  it("cancels short-lived run jobs on disconnect (nothing can re-attach a shell stdout)", () => {
    const keeper = new SessionKeeper()
    let cancelled = false
    keeper.registerRun("run-1", () => (cancelled = true))
    keeper.onDisconnect()
    expect(cancelled).toBe(true)
  })

  it("reattach returns false for an unknown session", () => {
    const keeper = new SessionKeeper()
    expect(keeper.reattach("nope", recorder().responder)).toBe(false)
  })

  it("forgets a session once its job completes", async () => {
    const keeper = new SessionKeeper()
    const { finish, job } = fakeJob()
    keeper.registerAgent("req-2", job, makeSink(recorder().responder))
    keeper.bindSession("req-2", "sess-done")
    expect(keeper.hasSession("sess-done")).toBe(true)
    finish()
    await job.done
    // allow the .then cleanup microtask to run
    await Promise.resolve()
    expect(keeper.hasSession("sess-done")).toBe(false)
    expect(keeper.liveAgentCount()).toBe(0)
  })
})
