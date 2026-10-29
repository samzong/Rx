# rx-agent

rx-agent is Rx's own coding agent. `rx rx-agent`, `rxa`, and `rx agent` launch it
with the selected provider, and `rx rx-agent acp` serves the Agent Client
Protocol. The root [README](../README.md) covers installation and command usage.
[DESIGN.md](DESIGN.md) owns the contracts and the module list.

The table below maps every capability to its owner. Owner is Rx, a pinned
package, or nothing yet. The Plan column gives the replacement plan for a
borrowed package and the tracking location for a capability that does not exist.

| Capability | Owner | Code | Plan |
| --- | --- | --- | --- |
| Agent loop: turns, tool calls, message queue | `pi-agent-core` | `src/agent.ts` | Conditional. Replace it when evals show that the loop is the limit. That needs eval evidence and an owner decision (RX-CORE-001). Evals are not started. |
| Model access: streaming, provider adapters, thinking levels, model catalog | `pi-ai` | `src/agent.ts`, `src/models.ts`, `src/rx-provider.ts`, `src/cli.ts`, and most modules that handle model or message types | No. Rx keeps pi-ai as the borrowed commodity layer. A replacement needs the same eval evidence and owner decision (RX-CORE-001). |
| Provider login: OAuth flows, device code, key prompts | `pi-ai` | `src/login.ts` | No. pi-ai runs the login. Rx owns the credential store and the terminal interaction. |
| Tool argument validation | `pi-ai` | `src/hooks.ts` | No. |
| Skill metadata and prompt catalog text | `pi-coding-agent` | `src/skills.ts` | No plan. Rx uses 4 functions from this package, so removing it is the smallest dependency change. No decision yet. |
| Token estimate and summary request | `pi-coding-agent` | `src/context.ts` | Same package and plan as the row above. |
| MCP client: stdio and Streamable HTTP transports, content conversion | `pi-mcp` | `src/mcp.ts` | No. RX-MCP-001 names pi-mcp as the MCP client. |
| Agent Client Protocol types and wire format | `@agentclientprotocol/sdk` 2.0.2 | `src/acp.ts`, `src/acp-config.ts`, `src/acp-messages.ts`, `src/acp-usage.ts` | Not a pi package. RX-ACP-001 pins SDK 2.0.2. |
| Historical content by original ordinal: `recall_log`, current session only | Rx | `src/session-history.ts` | Not applicable. |
| Tools: `read`, `write`, `edit`, `bash`, local image input | Rx | `src/tools.ts` | Not applicable. |
| System prompt, `AGENTS.md` and `CLAUDE.md` discovery, `@path` expansion | Rx | `src/agent.ts`, `src/instructions.ts` | Not applicable. |
| Skill discovery, precedence, collision reports | Rx | `src/skills.ts` | Not applicable. |
| Compaction: clear old tool output first, summarize with original source references, checkpoints, overflow recovery, `/compact` | Rx | `src/context.ts`, `src/context-control.ts` | Not applicable. |
| Session log, resume repair, session list, locks | Rx | `src/session-log.ts`, `src/pid-lock.ts` | Not applicable. |
| Command hooks and lifecycle events | Rx | `src/hooks.ts`, `src/hook-config.ts`, `src/hook-runner.ts` | Not applicable. |
| MCP configuration validation and tool adaptation | Rx | `src/mcp.ts` | Not applicable. |
| Credential store and login terminal flow | Rx | `src/credentials.ts`, `src/login.ts` | Not applicable. |
| CLI, REPL, print mode | Rx | `src/cli.ts`, `src/terminal.ts` | Not applicable. |
| Provider handoff validation and transport error capture | Rx | `src/rx-provider.ts`, `src/transport-errors.ts` | Not applicable. |
| ACP server: session controls, usage reports, cancel | Rx | `src/acp.ts`, `src/acp-config.ts`, `src/acp-messages.ts`, `src/acp-usage.ts` | Not applicable. |
| Fast service tier injection | Rx | `src/acp-fast.ts` | Not applicable. |
| Sandbox for tool execution | Not built | Tools run with your permissions (RX-PERM-001) | `ROADMAP.md`, after phase 1. |
| Eval set and runner | Not built | No score exists for a change in behavior | `ROADMAP.md`, phase 1 B. |
| rx-agent through ACP in Lody | Not built | The ACP server ships | `ROADMAP.md`, phase 1 A. |
| Cross-session memory | Not built | A session loads one log at a time | `ROADMAP.md`, after phase 1. |
| Idempotency keys for external actions | Not built | A retried `git push` can run twice | `ROADMAP.md`, after phase 1. |
| Plan mode, subagents, todo list, web search, LSP diagnostics | Not built, not scheduled | No tool or mode exists for these | None. |
| Permission request over ACP | Contract limit | Tools run without a prompt (RX-ACP-001) | Not applicable. |
| Cost in ACP usage reports | Contract limit | Tokens and context window only (RX-ACP-004) | Not applicable. |
