# sarah-computer-controller

Pair your computer with [Sarah](https://openagents.com) and let her run bounded shell
commands on it.

The controller is the part that runs on **your** machine. It connects outbound to the
Sarah API — no inbound port, no router configuration — and it is the authority on what
Sarah may do here. The server proposes; this process decides.

> Status: early. `probe`, `policy`, `status`, and `journal` work today and need no
> account. Pairing and the live command channel land with the next milestone, and the
> corresponding Sarah-side modules are described in
> [`docs/COMPUTER_CONTROLLER.md`](https://github.com/OpenAgentsInc/sarah/blob/main/docs/COMPUTER_CONTROLLER.md).

## Install

Requires Node.js 20.16 or newer.

```sh
pnpm install
pnpm build
node dist/bin.js --help
```

## First contact: discovery

Sarah's first move on a newly paired machine is not execution, it is discovery — which
coding agents and toolchains exist here:

```sh
pnpm tsx src/bin.ts probe
```

```
host      darwin 24.5.0 arm64
hostname  workshop
cpus      12
roots     /Users/you/code

coding agents
  claude         1.0.44 (Claude Code)
  codex          —
  cursor-agent   2026.01.14
  aider          —
  ...

toolchains
  git            git version 2.49.0
  gh             gh version 2.63.2
  node           v22.12.0
  ...
```

Absence is an answer, not an error: a machine with none of these still produces a
complete report. Nothing is executed beyond fixed `--version` probes.

## Tiers

The tier is recorded locally and is the ceiling on what Sarah can ask for. It defaults
to the most restrictive one.

| Tier      | What Sarah may ask for                                        |
| --------- | ------------------------------------------------------------- |
| `probe`   | Fixed read-only discovery only. No arguments from the server.  |
| `curated` | A versioned allowlist of read-only project commands.           |
| `shell`   | Arbitrary argv, each invocation confirmed by you interactively. |

```sh
node dist/bin.js pair --allow curated --root ~/code/my-project
node dist/bin.js policy
```

## What the machine refuses, always

These hold at every tier, including `shell`, and the server cannot widen them:

- no shell — commands are argv arrays, never a string handed to `sh -c`;
- no `sudo`, `su`, `chmod`, `dd`, `systemctl`, and similar privilege or destructive commands;
- no reads of credential material (`.ssh`, `.aws`, `.gnupg`, `.env`, `.npmrc`, keychains);
- no working directory or path argument outside the roots you declared;
- a wall-clock timeout and an output cap per command;
- a scrubbed environment — only `PATH`, `HOME`, and a few locale variables reach the child;
- secret-shaped output is masked before it leaves the machine;
- every request, allowed or refused, is appended to a local journal you own.

```sh
node dist/bin.js journal --limit 20
```

Local state lives in `~/.config/sarah-controller` (`%APPDATA%` on Windows), mode `0600`.

## Development

```sh
pnpm check   # typecheck
pnpm lint    # lint
pnpm test    # tests
pnpm build   # bundle to dist/
pnpm run ci  # all of the above
```

There is no hosted CI: checks run locally, manually or via the standard git hooks in
`.githooks/` — enable them once with `git config core.hooksPath .githooks`.

Built on [Effect](https://effect.website) v4.

## License

MIT
