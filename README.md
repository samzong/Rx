# Rx

`rx` launches rx-agent, Claude Code, Codex, OpenCode, Pi, DeepSeek Harness, and Kimi Code with one provider configuration. rx-agent is Rx's own coding agent, built from [`agent/`](agent/); the other harnesses run their native CLI.

[![Rx architecture](assets/rx-architecture.png)](assets/rx-architecture.png)

## Install

Requires Rust, [Bun](https://bun.sh), and pnpm.

```bash
git clone https://github.com/samzong/Rx.git
cd Rx
make install
```

## Usage

```bash
rx providers login
rxa
rx codex
rx --provider openrouter opencode
rx --provider none claude
rx dsh web
rx kimi
```

Running `rx` without a harness opens the picker; `tab` there picks a configured provider for that launch only, leaving the default unchanged. Arguments after the harness name are passed to that harness.
For Kimi Code, `rx` seeds the selected provider and its cached models as `rx-<provider>/<model>` aliases in Kimi's native catalog. `--model <id>` selects one of those models. Without it or a provider-level `model` in `rx.toml`, `rx` uses the first cached provider model and reports that choice on stderr. Rx-owned entries are refreshed only while their payload remains unchanged; native and user-edited entries are preserved. Kimi requires catalog credentials in its config, so the selected provider key is also stored in Kimi's local `config.toml` with secret-only file permissions.

Concurrent `rx kimi` launches retain their catalog aliases until they exit. A later
launch reclaims unchanged entries no longer used by a running launch. Changing
an active alias to a different route fails; close the launch using that alias
before retrying. Identical catalog snapshots reuse a shared lease file; empty
lease files are retained as catalogs change, without automatic cleanup.

When upgrading from a version 1 Kimi catalog marker, first close all Kimi
sessions started by older Rx versions. Run the same `rx kimi` command in a
terminal and type `migrate` when prompted to confirm those sessions have exited.
Declining the prompt or running without a terminal leaves the existing catalog
unchanged. Older Rx versions cannot update the migrated catalog. Keep the
catalog marker and lease files in place, including when rolling back Rx.

| Harness | Commands |
| --- | --- |
| rx-agent | `rx rx-agent`, `rxa` (`rx agent` is an alias) |
| Claude Code | `rx claude`, `rxc` |
| Codex | `rx codex`, `rxx` |
| OpenCode | `rx opencode`, `rxo` |
| Pi | `rx pi`, `rxp` |
| DeepSeek Harness | `rx dsh`, `rxd` |
| Kimi Code | `rx kimi`, `rxk` |

### rx-agent

If rx-agent is not on PATH or beside Rx, `rxa` in a terminal offers to install it
from this repository's `rx-agent-v*` releases after a SHA-256 check (`[y/N]`, Enter declines).
Rx checks for a new managed version in the background at most once per 24 hours.
The new version takes effect at the next launch. Rx keeps the current and previous versions.
`RX_NO_INSTALL=1` disables the prompt and `RX_NO_UPDATE=1` disables update checks.
See [distribution](agent/docs/distribution.md).

`rx rx-agent` and `rxa` start rx-agent with the selected provider, its cached
models, and its key in the child environment. The model is the first of
`--model <provider>/<id>`, the provider-level `model` in `rx.toml`, `model` in
`$RX_HOME/config.json` (default `~/.rx/config.json`), the provider's default
model, and the first listed model. `config.json` applies only to a model of
the launched provider; when it names another provider's model or a model this
launch cannot use, rx-agent says so on stderr and uses the launch default. With
`--provider none`, rx-agent runs as-is and resolves models through pi-ai and
its own `$RX_HOME/config.json`.

```json
{ "model": "tokener/claude-opus-5", "thinking": "medium" }
```

```bash
rxa                          # interactive session
rxa "Read notes.txt"
rxa -- "-review this change"
rxa -p "..."                 # one prompt, then exit
rxa -c                       # continue the latest session here
rxa sessions                 # list sessions
rxa acp                      # serve the Agent Client Protocol on stdio
rx-agent login [provider]    # sign in to a subscription or store an API key
rx-agent logout <provider>   # remove stored credentials
```

rx-agent works in the current directory with `read`, `write`, `edit`, and
`bash`, running with your permissions and no sandbox. Sessions are append-only
logs under `$RX_HOME/sessions/` (`RX_HOME` defaults to `~/.rx`). To use it from
an editor that speaks ACP, configure the editor to run `rx rx-agent acp`. See
[agent/DESIGN.md](agent/DESIGN.md) for its contract.

Add MCP servers in `$RX_HOME/mcp.json` or supply them through ACP new/load.
rx-agent supports stdio and Streamable HTTP. See [MCP tools](agent/docs/mcp.md).

Long sessions compact automatically before a model request reaches its context budget.
In the REPL or ACP, enter `/compact` to compact the session now.
Stop cancels a summary request. The complete session history remains in the log.
Resume uses the latest completed checkpoint. Older Rx versions replay the full history and can overflow again.
Generic summaries do not replay old native reasoning or signed thinking.

rx-agent keeps its own credentials, separate from `rx providers`.
`rx-agent login` without a provider lists the providers that support login.
ChatGPT subscriptions (`openai` or `openai-codex`) sign in through the browser
or a device code; API-key providers such as `deepseek` prompt for the key.
Credentials are stored in `$RX_HOME/auth.json` with owner-only permissions.
To use a stored subscription during an rx launch, pass its model, for example
`rxa --model openai-codex/<id>`.

Provider commands:

```bash
rx providers list
rx providers use <provider>
rx providers models update [provider]
rx providers logout <provider>
```

Bundled provider metadata is compiled into the binary. Live model catalogs come from the selected provider and are cached under `~/.recall/catalogs/` for one hour. Custom provider configuration and admission requirements are documented in [PROVIDERS.md](docs/PROVIDERS.md).

## Agent capability map

rx-agent owns the parts that gain value as models improve. It borrows the agent
loop, model adapters, skill helpers, and MCP client from pinned
`@earendil-works/pi-*` 1.4.0 packages. The tables below name the owner of each
capability and the replacement plan for each borrowed package.

### Borrowed from pi

| Capability | Package | Used in | Replacement plan |
| --- | --- | --- | --- |
| Agent loop, tool scheduling, message queue, tool-call hooks | `pi-agent-core` | `agent/src/agent.ts` | Conditional. Replace it only when evals show that the loop is the limit. That needs eval evidence and an owner decision (RX-CORE-001). Evals are not started. |
| Model access, streaming, provider adapters, thinking levels, model catalog | `pi-ai` | `agent/src/agent.ts`, `agent/src/rx-provider.ts`, `agent/src/models.ts`, `agent/src/cli.ts`, and most modules that handle model or message types | No. Rx keeps this as the borrowed commodity layer. A replacement needs the same eval evidence and owner decision (RX-CORE-001). |
| Login flows and credential types | `pi-ai` | `agent/src/login.ts`, `agent/src/credentials.ts` | No. |
| Tool input validation | `pi-ai` | `agent/src/hooks.ts` | No. |
| Skill catalog, token estimate, summary request | `pi-coding-agent` | `agent/src/skills.ts`, `agent/src/context.ts` | No plan. Rx uses 4 functions from this package, so it is the cheapest borrowed surface to remove. No decision yet. |
| MCP client, stdio and Streamable HTTP transports, content conversion | `pi-mcp` | `agent/src/mcp.ts` | No. RX-MCP-001 names pi-mcp as the MCP client. |
| Agent Client Protocol wire format | `@agentclientprotocol/sdk` 2.0.2 | `agent/src/acp.ts` | Not a pi package. Pinned and covered by RX-ACP-001. |

### Owned by Rx

| Capability | Used in |
| --- | --- |
| `read`, `write`, `edit`, `bash`, and local image input | `agent/src/tools.ts` |
| System prompt, `AGENTS.md` and `CLAUDE.md` loading, `@path` expansion | `agent/src/agent.ts`, `agent/src/instructions.ts` |
| Skill discovery, precedence, and collision reports | `agent/src/skills.ts` |
| Context budgets, compaction, checkpoints, overflow recovery, `/compact` | `agent/src/context.ts`, `agent/src/context-control.ts` |
| Session log, resume repair, session list, pid locks | `agent/src/session-log.ts`, `agent/src/pid-lock.ts` |
| Command hooks and lifecycle events | `agent/src/hooks.ts`, `agent/src/hook-config.ts`, `agent/src/hook-runner.ts` |
| MCP configuration validation and tool adaptation | `agent/src/mcp.ts` |
| CLI, REPL, print mode, and transport error capture | `agent/src/cli.ts`, `agent/src/terminal.ts`, `agent/src/transport-errors.ts` |
| ACP server, session controls, usage reports, cancel | `agent/src/acp.ts`, `agent/src/acp-config.ts`, `agent/src/acp-messages.ts`, `agent/src/acp-usage.ts` |
| Fast service tier injection | `agent/src/acp-fast.ts` |
| Provider handoff from the launcher | `agent/src/rx-provider.ts` |

### Not built yet

| Capability | Current state | Tracked in |
| --- | --- | --- |
| Sandbox for tool execution | Tools run with your permissions (RX-PERM-001) | `ROADMAP.md`, after phase 1 |
| Eval set and runner | Not started. No agent score exists yet. | `ROADMAP.md`, phase 1 B |
| Run rx-agent through ACP in Lody | The ACP server ships. The Lody run is still open. | `ROADMAP.md`, phase 1 A |
| Cross-session memory | Not built | `ROADMAP.md`, after phase 1 |
| Idempotency keys for external actions | Not built. A retried `git push` can run twice. | `ROADMAP.md`, after phase 1 |
| Plan mode, subagents, todo list, web search, LSP diagnostics | Not built and not scheduled | no entry |
| Permission requests over ACP | Not advertised (RX-ACP-001) | `agent/DESIGN.md` |
| Cost in ACP usage reports | Omitted by contract (RX-ACP-004) | `agent/DESIGN.md` |

## Development

Install Rust and cargo-audit 0.22.2, then run:

```bash
cargo install cargo-audit --locked --version 0.22.2
make check
make build
```

`make install` installs `rx`, its seven shortcuts, and the single-file `rx-agent`
binary compiled by `bun build --compile` into the Cargo bin directory.
`rx --version`, `rxa --version`, and `rx-agent --version` then add the source
commit and its date, for example `rx 0.2.0 (1afb9fcbd 2026-10-26)`; an
uncommitted tree adds `dirty` and the build time. Release binaries and plain
`cargo build` print only the version.
`make agent-check` audits, type-checks, and tests `agent/`.
Shell completions are available through `rx completions bash|zsh|fish`.
The GitHub release workflow builds the four supported targets from the checked tag.

See [DESIGN.md](docs/DESIGN.md) for native behavior and ownership rules,
[PROVIDERS.md](docs/PROVIDERS.md) for provider admission, and
[HOSTING.md](docs/HOSTING.md) for the embedding protocol.
