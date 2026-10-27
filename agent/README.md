# rx-agent

rx-agent is Rx's own coding agent. `rx rx-agent`, `rxa`, and `rx agent` launch it
with the selected provider, and `rx rx-agent acp` serves the Agent Client
Protocol. The root [README](../README.md) covers installation and command usage.
[DESIGN.md](DESIGN.md) owns the contracts and the module list.

This file answers two questions. Which capabilities does Rx implement, and which
capabilities come from a pinned package that Rx may replace?

## Borrowed from packages

| Capability | Package | Used in | Replacement plan |
| --- | --- | --- | --- |
| Agent loop: turns, tool calls, message queue | `pi-agent-core` | `src/agent.ts` | Conditional. Replace it when evals show that the loop is the limit. That needs eval evidence and an owner decision (RX-CORE-001). Evals are not started. |
| Model access: streaming, provider adapters, thinking levels, model catalog | `pi-ai` | `src/agent.ts`, `src/models.ts`, `src/rx-provider.ts`, `src/cli.ts`, and most modules that handle model or message types | No. Rx keeps pi-ai as the borrowed commodity layer. A replacement needs the same eval evidence and owner decision (RX-CORE-001). |
| Provider login: OAuth flows, device code, key prompts | `pi-ai` | `src/login.ts` | No. pi-ai runs the login. Rx owns the credential store and the terminal interaction. |
| Tool argument validation | `pi-ai` | `src/hooks.ts` | No. |
| Skill metadata and prompt catalog text | `pi-coding-agent` | `src/skills.ts` | No plan. Rx uses 4 functions from this package, so removing it is the smallest dependency change. No decision yet. |
| Token estimate and summary request | `pi-coding-agent` | `src/context.ts` | Same package and plan as the row above. |
| MCP client: stdio and Streamable HTTP transports, content conversion | `pi-mcp` | `src/mcp.ts` | No. RX-MCP-001 names pi-mcp as the MCP client. |
| Agent Client Protocol types and wire format | `@agentclientprotocol/sdk` 2.0.2 | `src/acp.ts` and the other `src/acp-*.ts` modules | Not a pi package. RX-ACP-001 pins SDK 2.0.2. |

## Owned by Rx

| Capability | Code |
| --- | --- |
| Tools: `read`, `write`, `edit`, `bash`, local image input | `src/tools.ts` |
| System prompt, `AGENTS.md` and `CLAUDE.md` discovery, `@path` expansion | `src/agent.ts`, `src/instructions.ts` |
| Skill discovery, precedence, collision reports | `src/skills.ts` |
| Compaction: request budgets, checkpoints, overflow recovery, `/compact` | `src/context.ts`, `src/context-control.ts` |
| Session log, resume repair, session list, locks | `src/session-log.ts`, `src/pid-lock.ts` |
| Command hooks and lifecycle events | `src/hooks.ts`, `src/hook-config.ts`, `src/hook-runner.ts` |
| MCP configuration validation and tool adaptation | `src/mcp.ts` |
| Credential store and login terminal flow | `src/credentials.ts`, `src/login.ts` |
| CLI, REPL, and print mode | `src/cli.ts`, `src/terminal.ts` |
| Transport error capture | `src/transport-errors.ts` |
| ACP server: session controls, usage reports, cancel | `src/acp.ts`, `src/acp-config.ts`, `src/acp-messages.ts`, `src/acp-usage.ts` |
| Fast service tier injection | `src/acp-fast.ts` |
| Provider handoff validation and registration | `src/rx-provider.ts` |

## Not implemented

| Capability | Current state | Tracked in |
| --- | --- | --- |
| Sandbox for tool execution | Tools run with your permissions (RX-PERM-001) | `ROADMAP.md`, after phase 1 |
| Eval set and runner | Not started, so no score exists for a change in behavior | `ROADMAP.md`, phase 1 B |
| rx-agent through ACP in Lody | The ACP server ships. No Lody run is recorded. | `ROADMAP.md`, phase 1 A |
| Cross-session memory | Not built | `ROADMAP.md`, after phase 1 |
| Idempotency keys for external actions | Not built. A retried `git push` can run twice. | `ROADMAP.md`, after phase 1 |
| Plan mode, subagents, todo list, web search, LSP diagnostics | Not built and not scheduled | none |

## Contract limits

These rows are decisions, not gaps.

| Limit | Contract |
| --- | --- |
| No permission request over ACP | RX-ACP-001 advertises no permission requests, so tools run without a prompt. |
| No cost in ACP usage reports | RX-ACP-004 reports tokens and the context window, and omits cost. |
