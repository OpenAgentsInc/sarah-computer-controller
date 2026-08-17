import { describe, expect, it } from "@effect/vitest"

import { decide, withinRoot } from "sarah-computer-controller/Policy"
import type { PolicyConfig } from "sarah-computer-controller/Policy"

const base: PolicyConfig = {
  tier: "curated",
  roots: ["/home/dev/project"],
  preApproved: []
}

describe("withinRoot", () => {
  it("accepts the root itself and children", () => {
    expect(withinRoot("/home/dev/project", "/home/dev/project")).toBe(true)
    expect(withinRoot("/home/dev/project/src", "/home/dev/project")).toBe(true)
  })

  it("rejects siblings that merely share a prefix", () => {
    expect(withinRoot("/home/dev/project-evil", "/home/dev/project")).toBe(false)
    expect(withinRoot("/home/dev", "/home/dev/project")).toBe(false)
  })
})

describe("decide", () => {
  it("refuses empty commands", () => {
    const decision = decide({ argv: [], cwd: "/home/dev/project" }, base)
    expect(decision).toMatchObject({ _tag: "Refused", reason: "empty_command" })
  })

  it("refuses shell metacharacters in any argument", () => {
    const decision = decide({ argv: ["git", "status;rm -rf /"], cwd: "/home/dev/project" }, base)
    expect(decision).toMatchObject({ _tag: "Refused", reason: "shell_metacharacter" })
  })

  it("refuses denied commands at every tier", () => {
    for (const tier of ["probe", "curated", "shell"] as const) {
      const decision = decide({ argv: ["sudo", "ls"], cwd: "/home/dev/project" }, { ...base, tier })
      expect(decision).toMatchObject({ _tag: "Refused", reason: "denied_command" })
    }
  })

  it("refuses denied commands hidden behind paths and extensions", () => {
    const decision = decide({ argv: ["/usr/bin/SUDO.exe", "ls"], cwd: "/home/dev/project" }, base)
    expect(decision).toMatchObject({ _tag: "Refused", reason: "denied_command" })
  })

  it("refuses arguments referencing protected paths", () => {
    const decision = decide({ argv: ["cat", "/home/dev/project/.env"], cwd: "/home/dev/project" }, base)
    expect(decision).toMatchObject({ _tag: "Refused", reason: "denied_argument" })
  })

  it("refuses when no roots are declared", () => {
    const decision = decide({ argv: ["ls"], cwd: "/home/dev/project" }, { ...base, roots: [] })
    expect(decision).toMatchObject({ _tag: "Refused", reason: "root_not_declared" })
  })

  it("refuses a cwd outside every root", () => {
    const decision = decide({ argv: ["ls"], cwd: "/etc" }, base)
    expect(decision).toMatchObject({ _tag: "Refused", reason: "root_not_declared" })
  })

  it("refuses path arguments escaping the roots", () => {
    const decision = decide({ argv: ["cat", "/etc/passwd"], cwd: "/home/dev/project" }, base)
    expect(decision).toMatchObject({ _tag: "Refused", reason: "denied_argument" })
  })

  it("refuses everything at probe tier", () => {
    const decision = decide({ argv: ["git", "status"], cwd: "/home/dev/project" }, { ...base, tier: "probe" })
    expect(decision).toMatchObject({ _tag: "Refused", reason: "tier_insufficient" })
  })

  it("allows allowlisted curated commands without confirmation", () => {
    const decision = decide({ argv: ["git", "status"], cwd: "/home/dev/project" }, base)
    expect(decision).toEqual({ _tag: "Allowed", needsConfirmation: false })
  })

  it("refuses curated commands with unlisted subcommands", () => {
    const decision = decide({ argv: ["git", "push"], cwd: "/home/dev/project" }, base)
    expect(decision).toMatchObject({ _tag: "Refused", reason: "not_allowlisted" })
  })

  it("refuses non-allowlisted commands at curated tier", () => {
    const decision = decide({ argv: ["rm", "file.txt"], cwd: "/home/dev/project" }, base)
    expect(decision).toMatchObject({ _tag: "Refused", reason: "not_allowlisted" })
  })

  it("requires confirmation for arbitrary commands at shell tier", () => {
    const decision = decide({ argv: ["make", "build"], cwd: "/home/dev/project" }, { ...base, tier: "shell" })
    expect(decision).toEqual({ _tag: "Allowed", needsConfirmation: true })
  })

  it("skips confirmation for pre-approved commands at shell tier", () => {
    const decision = decide(
      { argv: ["make", "build"], cwd: "/home/dev/project" },
      { ...base, tier: "shell", preApproved: ["make"] }
    )
    expect(decision).toEqual({ _tag: "Allowed", needsConfirmation: false })
  })

  it("keeps universal denials above shell tier", () => {
    const decision = decide(
      { argv: ["sudo", "make"], cwd: "/home/dev/project" },
      { ...base, tier: "shell", preApproved: ["sudo"] }
    )
    expect(decision).toMatchObject({ _tag: "Refused", reason: "denied_command" })
  })
})
