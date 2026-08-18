/**
 * The local policy decision. This is the security boundary of the controller:
 * the Sarah API proposes a command, and this module decides whether the machine
 * will run it. Nothing here reads the network, so it is pure and testable.
 */

/**
 * Capability tiers, in increasing order of what the server may ask for.
 */
export type Tier = "probe" | "curated" | "shell"

export const tierRank: Record<Tier, number> = {
  probe: 0,
  curated: 1,
  shell: 2
}

export interface PolicyConfig {
  readonly tier: Tier
  /** Absolute directories the operator exposed. A command must run inside one. */
  readonly roots: ReadonlyArray<string>
  /** argv[0] values pre-approved by the operator for the `shell` tier. */
  readonly preApproved: ReadonlyArray<string>
}

export interface CommandRequest {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
}

export type Decision =
  | { readonly _tag: "Allowed"; readonly needsConfirmation: boolean }
  | { readonly _tag: "Refused"; readonly reason: RefusalReason; readonly detail: string }

export type RefusalReason =
  | "empty_command"
  | "tier_insufficient"
  | "not_allowlisted"
  | "root_not_declared"
  | "denied_command"
  | "denied_argument"
  | "shell_metacharacter"

const refuse = (reason: RefusalReason, detail: string): Decision => ({ _tag: "Refused", reason, detail })

const allow = (needsConfirmation: boolean): Decision => ({ _tag: "Allowed", needsConfirmation })

/**
 * Read-only `gh` invocations permitted at `curated` tier. Keyed by resource
 * subcommand (argv[1]); the value is the set of read-only actions (argv[2])
 * allowed for it. Anything not listed — create, edit, delete, close, merge,
 * comment, clone, and every other mutation — is refused, so a delegated agent
 * can inspect GitHub but never change it.
 */
const ghReadActions: Record<string, ReadonlyArray<string>> = {
  issue: ["list", "view", "status"],
  pr: ["list", "view", "status", "diff", "checks"],
  release: ["list", "view"],
  run: ["list", "view"],
  workflow: ["list", "view"],
  repo: ["list", "view"],
  gist: ["list", "view"],
  cache: ["list"],
  label: ["list"],
  ruleset: ["list", "view"],
  auth: ["status"]
}

// `gh search …` and `gh status` are read-only in every form; `--version` too.
const ghReadTopLevel: ReadonlyArray<string> = ["search", "status", "--version", "version"]

// gh api is a GET by default but turns into a write the moment a method or a
// field is supplied, so it is allowed only when it stays an explicit GET with
// no field/input flags.
const ghApiWriteFlags = ["-f", "-F", "--field", "--raw-field", "--input"]

const ghApiReadOnly = (apiArgs: ReadonlyArray<string>): boolean => {
  if (apiArgs.some((arg) => ghApiWriteFlags.includes(arg))) return false
  const methodIndex = apiArgs.findIndex((arg) => arg === "-X" || arg === "--method")
  if (methodIndex === -1) return true
  const method = (apiArgs[methodIndex + 1] ?? "").toUpperCase()
  return method === "GET" || method === "HEAD"
}

export const ghReadOnlyAllowed = (rest: ReadonlyArray<string>): boolean => {
  const [resource, action] = rest
  if (resource === undefined) return false
  if (ghReadTopLevel.includes(resource)) return true
  if (resource === "api") return ghApiReadOnly(rest.slice(1))
  const actions = ghReadActions[resource]
  return actions !== undefined && action !== undefined && actions.includes(action)
}

/**
 * Read-only commands the controller will run at `curated` tier. Keyed by
 * argv[0]; the value lists the subcommands or first arguments permitted, where
 * an empty list means the bare command only.
 */
export const curatedAllowlist: Record<string, ReadonlyArray<string>> = {
  git: ["status", "log", "diff", "branch", "remote", "show", "rev-parse", "ls-files", "--version"],
  uname: [],
  date: [],
  echo: [],
  whoami: [],
  df: [],
  du: [],
  ps: [],
  uptime: [],
  env: [],
  file: [],
  stat: [],
  ls: [],
  cat: [],
  head: [],
  tail: [],
  wc: [],
  pwd: [],
  which: [],
  find: [],
  rg: [],
  grep: [],
  node: ["--version"],
  npm: ["--version", "ls", "run"],
  pnpm: ["--version", "ls"],
  python3: ["--version"],
  cargo: ["--version", "metadata"],
  go: ["version", "env"],
  mix: [],
  docker: ["ps", "images", "version"]
}

/**
 * Commands never run, at any tier. Compiled in and not overridable by the
 * server, because a server compromise must not become root on the machine.
 */
const deniedCommands: ReadonlyArray<string> = [
  "sudo",
  "doas",
  "su",
  "chmod",
  "chown",
  "mkfs",
  "dd",
  "shutdown",
  "reboot",
  "halt",
  "passwd",
  "ssh-keygen",
  "ssh-add",
  "keychain",
  "security",
  "gpg",
  "crontab",
  "systemctl",
  "launchctl",
  "nc",
  "ncat",
  "telnet"
]

/**
 * Paths never read, at any tier, even inside a declared root.
 */
const deniedPathFragments: ReadonlyArray<string> = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "id_rsa",
  "id_ed25519",
  ".env",
  "credentials.json",
  "Keychains"
]

/**
 * Characters that only mean something to a shell. The executor never uses a
 * shell, so their presence signals an injection attempt rather than intent.
 */
const shellMetacharacters = /[;&|`$><\n\r\\]/

const normalizeCommandName = (argv0: string): string => {
  const withoutDirectory = argv0.split(/[\\/]/).pop() ?? argv0
  return withoutDirectory.toLowerCase().replace(/\.exe$/, "")
}

const normalizePath = (value: string): string => {
  const collapsed = value.replace(/\\/g, "/").replace(/\/+/g, "/")
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed
}

/**
 * True when `candidate` is the root itself or lives beneath it. Both values are
 * expected to be absolute and already resolved by the caller.
 */
export const withinRoot = (candidate: string, root: string): boolean => {
  const target = normalizePath(candidate)
  const base = normalizePath(root)
  return target === base || target.startsWith(`${base}/`)
}

const looksLikePath = (argument: string): boolean =>
  argument.startsWith("/") || argument.startsWith("~") || argument.includes("../") || argument.startsWith("./")

/**
 * Decide whether a proposed command may run on this machine.
 *
 * The order matters: universal denials are checked before tier allowances, so
 * widening the tier can never unlock a denied command.
 */
export const decide = (request: CommandRequest, config: PolicyConfig): Decision => {
  const [argv0, ...rest] = request.argv

  if (argv0 === undefined || argv0.trim() === "") {
    return refuse("empty_command", "no command was supplied")
  }

  for (const part of request.argv) {
    if (shellMetacharacters.test(part)) {
      return refuse("shell_metacharacter", `argument contains shell metacharacters: ${part}`)
    }
  }

  const name = normalizeCommandName(argv0)

  if (deniedCommands.includes(name)) {
    return refuse("denied_command", `${name} is denied on this machine`)
  }

  for (const argument of request.argv) {
    for (const fragment of deniedPathFragments) {
      if (argument.includes(fragment)) {
        return refuse("denied_argument", `argument references a protected path: ${fragment}`)
      }
    }
  }

  if (config.roots.length === 0) {
    return refuse("root_not_declared", "no roots are declared; run pair or pass --root")
  }

  if (!config.roots.some((root) => withinRoot(request.cwd, root))) {
    return refuse("root_not_declared", `${request.cwd} is outside every declared root`)
  }

  for (const argument of rest) {
    if (looksLikePath(argument) && !config.roots.some((root) => withinRoot(argument, root))) {
      return refuse("denied_argument", `path argument is outside every declared root: ${argument}`)
    }
  }

  if (config.tier === "probe") {
    return refuse("tier_insufficient", "this machine is paired at probe tier; only discovery is permitted")
  }

  if (config.tier === "curated") {
    // gh needs subcommand-pair awareness: `gh issue list` is a read but
    // `gh issue create` is a write, and both share argv[1] "issue". A flat
    // first-arg allowlist cannot separate them, so gh has its own read-only
    // gate that whitelists (resource, action) read pairs and refuses the rest.
    if (name === "gh") {
      return ghReadOnlyAllowed(rest)
        ? allow(false)
        : refuse("not_allowlisted", `gh ${rest.join(" ")} is not a permitted read-only gh command`.trim())
    }

    const permittedArguments = curatedAllowlist[name]
    if (permittedArguments === undefined) {
      return refuse("not_allowlisted", `${name} is not in the curated allowlist`)
    }
    const first = rest[0]
    if (permittedArguments.length > 0 && (first === undefined || !permittedArguments.includes(first))) {
      return refuse("not_allowlisted", `${name} ${first ?? ""} is not in the curated allowlist`.trim())
    }
    return allow(false)
  }

  return allow(!config.preApproved.includes(name))
}
