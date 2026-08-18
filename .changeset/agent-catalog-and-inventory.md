---
"sarah-computer-controller": minor
---

Agent catalog, probe inventory, and channel generalization. Three catalog
layers with deliberate precedence: operator `agents` config entries (id →
argv + named env opt-ins), the pinned `@agentclientprotocol/claude-agent-acp`
adapter spawned from `node_modules` as the zero-configuration `claude`
default, and opt-in registry resolution (`--allow registry-agents`) from a
vendored snapshot of the ACP registry — npx/uvx pinned by the snapshot,
binary distributions only with sha256 verification. The probe report gains an
`acp_agents` inventory (`{id, source, version, auth_ready}` per entry,
bounded and normalized). The channel accepts the new `agent` event
(`agent_id` validated against the catalog; unknown ids answered with a
terminal `refused` push whose detail names `agent_not_available` and the
available ids) and keeps accepting the legacy `devin` event for one release,
mapped to `agent_id: "devin"`.
