---
"sarah-computer-controller": patch
---

Allow read-only `gh` commands at curated tier through a subcommand-aware gate (issue/pr/release/run/workflow/repo/gist/cache/label/ruleset list+view, auth status, search, and GET-only `gh api`). Writes — create/edit/delete/close/merge/comment/clone and field-bearing api calls — stay refused. Fixes the earlier attempt that only touched the ACP permission path, not the computer_run command allowlist.
