# Rx Roadmap

Rx is a personal coding agent built while it is used. Every piece of work
maps to a real use or an eval task; work that maps to neither waits.

Update progress and decisions in place. Contract changes go to
[DESIGN.md](docs/DESIGN.md) first.

## Phase 1

Two lines that can run in parallel. Line A merges first; line B rebases onto it.

### A: agent core

- [x] Agent loop from pi-agent-core and model access through pi-ai.
- [x] `read`, `write`, `edit`, and `bash` tools.
- [x] Append-only session log that records each message's real origin.
- [x] Resume that closes interrupted tool calls without re-running them.
- [x] CLI: REPL, `-p`, `models`, `sessions`, `--resume`, `--continue`.
- [x] ACP server with load, list, cancel, and streaming tool updates.
- [ ] Run Rx through ACP in Lody, or Zed if Lody cannot host a custom agent.

Done when the owner completes at least one real task with Rx every day.

### B: evals

- [ ] 30 eval tasks from past sessions plus a 10-task holdout set, stored
  outside the repository under `~/.rx/evals/`.
- [ ] A runner and task schema in this repository.
- [ ] Baseline scores for Claude Code and Codex.

Done when one command scores any agent on the task set.

## After phase 1

Each Rx failure is fixed and then becomes an eval task. Candidates, ordered by
what daily use and evals show:

- Sandbox for tool execution (replaces RX-PERM-001).
- Context compaction and memory.
- MCP tools.
- Idempotency keys for external actions such as `git push`.
- Replacing the pi-agent-core loop, only when evals show the loop is the limit.
