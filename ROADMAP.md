# Rx Roadmap

Rx launches its own coding agent, rx-agent, alongside six native CLIs. rx-agent
is built from [`agent/`](agent/) on pi-agent-core and pi-ai, is the first picker
entry, and owns `rxa`. Provider maintenance and external harness contributions
continue throughout. Every piece of agent work maps to a real use or an eval
task; work that maps to neither waits.

Before changing behavior, update the affected contracts in
[DESIGN.md](docs/DESIGN.md) and [agent/DESIGN.md](agent/DESIGN.md).

## Ongoing commitments

### Providers

Accept any provider that meets [PROVIDERS.md](docs/PROVIDERS.md), whether or not
the maintainer uses it. Keep admission standards unchanged across all phases.

Require the existing model-discovery and streaming protocol probes through one
API key. Verify model controls on their exact endpoint and protocol; unknown
capabilities remain unknown. Maintain the admission file and generated snapshot
with compatibility evidence. Success with rx-agent alone does not
qualify a bundled provider.

### External harnesses

Keep existing integrations working and accept new ones for concrete needs.
The maintainer adds harnesses they use; contributors can add others. There is
no fixed shortlist. Each integration must meet DESIGN's installation, routing,
permissions, ownership, secrets, hosted-mode, and native acceptance requirements.

## Phase 1

Two lines that can run in parallel. Line A merges first; line B rebases onto it.

### A: agent core

- [x] Agent loop from pi-agent-core and model access through pi-ai.
- [x] `read`, `write`, `edit`, and `bash` tools.
- [x] Append-only session log that records each message's real origin.
- [x] Resume that closes interrupted tool calls without re-running them.
- [x] CLI: REPL, `-p`, `models`, `sessions`, `--resume`, `--continue`.
- [x] ACP server with load, list, cancel, and streaming tool updates.
- [x] Launch through `rx rx-agent` and `rxa` with Rx's provider configuration,
  credentials, and catalogs; single-file binary through `bun build --compile`.
- [x] `rx-agent login` / `logout` for its own subscriptions and API keys,
  independent of rx providers.
- [ ] Ship rx-agent in the release workflow and `rx update`.
- [ ] Run rx-agent through ACP in Lody, or Zed if Lody cannot host a custom agent.

Done when the owner completes at least one real task with rx-agent every day.

### B: evals

- [ ] 30 eval tasks from past sessions plus a 10-task holdout set, stored
  outside the repository under `~/.rx/evals/`.
- [ ] A runner and task schema in this repository.
- [ ] Baseline scores for Claude Code and Codex.

Done when one command scores any agent on the task set.

## After phase 1

Each rx-agent failure is fixed and then becomes an eval task. Candidates,
ordered by what daily use and evals show:

- Sandbox for tool execution (replaces RX-PERM-001).
- Context compaction and memory.
- MCP tools.
- Idempotency keys for external actions such as `git push`.
- Replacing the pi-agent-core loop, only when evals show the loop is the limit.

## Tracking and verification

Update progress and decisions in place. Launcher changes must pass
`cargo test -p rx`, `make check`, and affected DESIGN acceptance checks. Agent
changes must pass `make agent-check` and the real-model checks in
[agent/DESIGN.md](agent/DESIGN.md).
