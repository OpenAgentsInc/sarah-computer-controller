import { describe, expect, it } from "@effect/vitest"

import { scrubSecrets } from "sarah-computer-controller/Executor"

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
