---
"sarah-computer-controller": minor
---

Adopt the official `@agentclientprotocol/sdk` and generalize the Devin-only ACP
client into an any-agent client (`AcpAgent`). The SDK owns the JSON-RPC
framing; the controller keeps its hard bounds as wrappers around the byte
streams: per-message size cap in both directions, streamed-output ceiling,
wall-clock ceiling, subprocess always reaped, argv-only spawn, and secret
scrubbing on everything emitted. Permission answers are tier-aware (probe
rejects all, curated grants only read-shaped tool kinds, shell grants per
local policy), always prefer the one-shot `allow_once`, and never select
bypass-style options. Client capabilities stay minimal (no fs, no terminal)
and unregistered agent→client methods are refused. `-32000 auth_required`
becomes a typed `unavailable` outcome carrying the agent's advertised auth
methods, and the outcome records agent capabilities for Sarah-side evidence.
Agent subprocesses now receive the scrubbed environment allowlist plus named
per-agent env opt-ins instead of the controller's full environment.
`DevinAcp` is removed in favor of `AcpAgent`.
