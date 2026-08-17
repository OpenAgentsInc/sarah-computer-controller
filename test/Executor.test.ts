import { describe, expect, it } from "@effect/vitest"

import { executeStreamed, scrubSecrets } from "sarah-computer-controller/Executor"

const node = process.execPath

describe("executeStreamed", () => {
  it("streams stdout chunks and reports the exit code", async () => {
    const chunks: Array<string> = []
    const outcome = await executeStreamed(
      [node, "-e", "process.stdout.write('hello '); process.stdout.write('world')"],
      process.cwd(),
      { timeoutMillis: 10_000, maximumOutputBytes: 1024 },
      (text) => chunks.push(text)
    ).done
    expect(outcome.exitCode).toBe(0)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.cancelled).toBe(false)
    expect(chunks.join("")).toBe("hello world")
  })

  it("caps output and marks truncation", async () => {
    const chunks: Array<string> = []
    const outcome = await executeStreamed(
      [node, "-e", "process.stdout.write('x'.repeat(5000))"],
      process.cwd(),
      { timeoutMillis: 10_000, maximumOutputBytes: 100 },
      (text) => chunks.push(text)
    ).done
    expect(outcome.truncated).toBe(true)
    expect(chunks.join("").length).toBeLessThanOrEqual(100)
  })

  it("masks secret-shaped output in streamed chunks", async () => {
    const chunks: Array<string> = []
    await executeStreamed(
      [node, "-e", "process.stdout.write('key AKIAIOSFODNN7EXAMPLE end')"],
      process.cwd(),
      { timeoutMillis: 10_000, maximumOutputBytes: 1024 },
      (text) => chunks.push(text)
    ).done
    expect(chunks.join("")).toBe("key [redacted] end")
  })

  it("kills a command that exceeds the timeout", async () => {
    const outcome = await executeStreamed(
      [node, "-e", "setTimeout(() => {}, 60000)"],
      process.cwd(),
      { timeoutMillis: 500, maximumOutputBytes: 1024 },
      () => undefined
    ).done
    expect(outcome.timedOut).toBe(true)
  }, 15_000)

  it("kills a command when cancelled", async () => {
    const job = executeStreamed(
      [node, "-e", "setTimeout(() => {}, 60000)"],
      process.cwd(),
      { timeoutMillis: 60_000, maximumOutputBytes: 1024 },
      () => undefined
    )
    setTimeout(() => job.cancel(), 300)
    const outcome = await job.done
    expect(outcome.cancelled).toBe(true)
  }, 15_000)

  it("reports exit 127 for a missing binary without throwing", async () => {
    const outcome = await executeStreamed(
      ["/nonexistent/command-for-test"],
      process.cwd(),
      { timeoutMillis: 5_000, maximumOutputBytes: 1024 },
      () => undefined
    ).done
    expect(outcome.exitCode).toBe(127)
  })

  it("reports exit 127 for an empty argv", async () => {
    const outcome = await executeStreamed(
      [],
      process.cwd(),
      { timeoutMillis: 5_000, maximumOutputBytes: 1024 },
      () => undefined
    ).done
    expect(outcome.exitCode).toBe(127)
  })
})

describe("scrubSecrets", () => {
  it("masks GitHub tokens", () => {
    expect(scrubSecrets("token ghp_abcdefghijklmnop1234 end")).toBe("token [redacted] end")
    expect(scrubSecrets("github_pat_11ABCDEFGHIJKLMNOPQRST_more")).toBe("[redacted]")
  })

  it("masks OpenAI-style keys", () => {
    expect(scrubSecrets("sk-abcdefghijklmnopqrstuv")).toBe("[redacted]")
  })

  it("masks AWS access key ids", () => {
    expect(scrubSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[redacted]")
  })

  it("masks JWT-shaped strings", () => {
    expect(scrubSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop")).toBe("[redacted]")
  })

  it("leaves ordinary output untouched", () => {
    expect(scrubSecrets("On branch main, nothing to commit")).toBe("On branch main, nothing to commit")
  })
})
