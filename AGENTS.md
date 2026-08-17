# Agent guidelines

## No hosted CI

**Never add GitHub Actions workflows (`.github/workflows/`) or any other hosted CI configuration to this repository.** All checks run locally:

- Manually: `pnpm ci` (typecheck, lint, test, build)
- Automatically: standard git hooks in `.githooks/` — enable once with `git config core.hooksPath .githooks`

## Project guidelines

- Effect v4 (currently pinned to an exact RC version) — do not downgrade to Effect v3 APIs
- Package manager is `pnpm`; Node >= 20.16.0
- Commands are always argv arrays executed without a shell — never `sh -c` or shell-string interpolation
- The local policy engine (`src/Policy.ts`) is authoritative; the server can never override local deny rules
- Never read or expose credential files, tokens, or secrets; keep the secret-masking in `src/Executor.ts` intact
- Run `pnpm ci` before pushing
