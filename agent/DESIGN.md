# rx-agent Design Contract

This is the normative contract for rx-agent, Rx's coding agent. The launcher
side of the provider handoff is RX-AGENT-001..003 in
[docs/DESIGN.md](../docs/DESIGN.md). Conflicting code is a bug, not precedent.
[README.md](README.md) maps each capability to its owner and names what is not
built yet.

## Principles

- Own the parts that gain value as models improve: tools, context, session
  data, and evals. Borrow commodity plumbing: provider adapters, protocols,
  and sandboxes.
- Usable every day. A change that breaks daily use is a regression even when
  tests pass.
- Measured, not felt. Claims that Rx got better need eval or real-run evidence.
- No inference of product decisions. Missing defaults, boundaries, or
  persistence choices go to the owner.

## Components

| Module | Role |
| --- | --- |
| `src/agent.ts` | Builds the pi-agent-core `Agent`: system prompt, model stream, tools, and log subscription. |
| `src/context.ts` | Owns request budgets, bounded summaries, checkpoint installation, cancellation, and overflow recovery. |
| `src/context-control.ts` | Defines the internal context controls and lifecycle events. |
| `src/transport-errors.ts` | Captures safe HTTP transport causes before provider adapters discard them. |
| `src/instructions.ts` | Finds the project boundary and loads instructions with local file references. |
| `src/skills.ts` | Finds skill files and uses pi-coding-agent to load metadata and format the catalog. |
| `src/hooks.ts`, `src/hook-config.ts`, `src/hook-runner.ts` | User command checks, lifecycle, protocol, and process cleanup. |
| `src/tools.ts` | `read`, `write`, `edit`, and `bash`, all relative to the session working directory. |
| `src/mcp.ts` | User and ACP MCP configuration, connections, and tool adaptation. |
| `src/session-log.ts` | Append-only JSONL session log, resume repair, and session listing. |
| `src/models.ts` | Model and thinking-level resolution through pi-ai `Models`. |
| `src/rx-provider.ts` | Validates the `RX_AGENT_PROVIDER` handoff and registers its provider and models. |
| `src/credentials.ts` | rx-agent's credential store (`$RX_HOME/auth.json`) and installation id. |
| `src/login.ts` | Terminal `login` flow: provider and method choice, prompts, browser and device-code links. |
| `src/pid-lock.ts` | Pid lock primitives shared by session and credential locks. |
| `src/terminal.ts` | REPL and `-p` print mode. |
| `src/acp.ts` | Agent Client Protocol server over stdio. |
| `src/acp-messages.ts` | ACP prompt, event, and history message conversion. |
| `src/cli.ts` | Argument parsing and entrypoint. |

## Invariants

| ID | Contract |
| --- | --- |
| RX-CLI-001 | Interactive initial prompts and literal arguments. [Full contract](docs/cli.md). |
| RX-CORE-001 | The agent loop is pi-agent-core's `Agent`, constructed only in `src/agent.ts`. Model calls go through pi-ai `Models`. Replacing either requires eval evidence and an owner decision. |
| RX-LOG-001 | Message history, summary usage, and replaced tool input. [Full contract](docs/session-log.md). |
| RX-LOG-002 | Versioned append-only records. [Full contract](docs/session-log.md). |
| RX-LOG-003 | Single writer. [Full contract](docs/session-log.md). |
| RX-RESUME-001 | Resume and interrupted tools. [Full contract](docs/session-log.md). |
| RX-CANCEL-001 | Cancelling a turn (ACP `session/cancel`, Ctrl-C), including a context summary, stops model requests and kills the running tool's whole process group and ends the turn. A closed ACP connection, SIGTERM, or SIGHUP aborts running turns the same way and waits for them to be logged. `bash` completes when its shell exits, after a short grace period for output pipes, so background processes cannot hold a turn open. The log ends with an `aborted` assistant message and the ACP prompt returns `cancelled`. pi-ai can report an abort as `error`; Rx normalizes it. |
| RX-SECRET-001 | Credentials come from rx-agent's own store or from provider environment variables, both resolved by pi-ai; a stored credential wins over the environment. Rx never writes credentials to its config, logs, or argv. Tools inherit the full environment, including provider keys, and tool output is logged verbatim, so a command that prints a key puts it in the session log. Filtering the tool environment requires an owner decision. |
| RX-AUTH-001 | `rx-agent login` and `logout` manage rx-agent's own credentials, including ChatGPT subscriptions (OAuth) and API keys, in `$RX_HOME/auth.json`. This store is independent of the rx launcher's provider configuration and key store. The file is `0600` in a `0700` directory and is replaced atomically. Every write, including an OAuth token refresh during a run, holds `auth.json.lock` with the owner pid; a live owner is waited for up to 30 seconds and then named in the error, and a dead owner's lock is reclaimed with the same pid-reuse limit as RX-LOG-003. A malformed file or entry is an error and is never overwritten. |
| RX-AUTH-002 | During an rx launch, the store hides the handed-off provider id: its key comes only from the launch environment, and `login` / `logout` ignore the handoff. Other stored providers stay available, so `--model <provider>/<id>` can select a subscription model in an rx launch. |
| RX-HANDOFF-001 | When `RX_AGENT_PROVIDER` is set, rx-agent validates it and fails closed on malformed input, then registers that provider with the handed-off models only. A model's own `api` and `baseUrl` override the provider's. A listed model keeps pi-ai's built-in metadata only when a built-in model of the same provider has the same id, API, and endpoint (ignoring a trailing `/v1`); any other model gets the handed-off context window and reasoning levels with text input, zero cost, and 16384 max output tokens. The key is read from the named environment variable. `defaultModel` must name a handed-off model. Requests to an `openai-responses` handoff omit `prompt_cache_key`, because gateways such as Tokener reject it for some models. On `anthropic-messages`, a model with reasoning levels uses adaptive thinking and sends the level's wire value as `output_config.effort`; pi-ai's default prompt caching applies. |
| RX-MODEL-001 | The model is `--model`, then `RX_MODEL`, then `model` in `$RX_HOME/config.json`. In an rx launch, a missing `model` selects `RX_AGENT_PROVIDER`'s `defaultModel` with a stderr note, and a `model` of another provider, or one that cannot be resolved in that launch, falls back to `defaultModel` with a stderr note naming the reason. Without a launch, a missing or unresolvable model is an error. An invalid `thinking` is always an error. |
| RX-PRIVATE-001 | Session logs live under `$RX_HOME` (default `~/.rx`) with `0700` directories and `0600` files. Session logs and eval tasks never enter this repository. |
| RX-PERM-001 | Tools run with the user's permissions and no sandbox. This is an owner decision for the prototype; a sandbox replaces it in a later phase. |
| RX-ACP-001 | ACP v1 uses SDK 2.0.2 session configuration options for model, thinking, and supported Fast controls. New and loaded sessions report a complete snapshot. Setters return and notify the complete updated snapshot. Changes apply only between prompts and stay in memory. Load uses current launch defaults, then the client can reapply its saved choices. No legacy model setter, permission modes, permission requests, or Plan control is advertised. |
| RX-ACP-002 | Each model exposes only its pi-ai thinking levels. Switching models clamps thinking to the new model and resets Fast. Boolean controls require the client capability. Lody receives per-model levels and Fast support through its versioned metadata because standard configuration options describe only the current model. |
| RX-ACP-003 | Fast is available only for the native openai-codex subscription endpoint and exact models supported by the Codex 0.163.0 catalog and current Speed documentation. Rx retains streamSimple and injects service_tier: priority through onPayload. Other providers and endpoints receive no Fast injection. |
| RX-ACP-004 | After each measured assistant response, ACP reports the latest input, output, cache-read, and cache-write token sum with that model's context window. These values are a recent context measurement, not cumulative session usage or an estimate of unsent input. Costs are omitted. Load replays the latest matching measurement after the latest checkpoint. Summary requests do not report working-context usage. Measurements before a checkpoint are no longer current. Image input requires the current model's image capability. |
| RX-CONTEXT-001 | Global instructions come from `$RX_HOME/AGENTS.md`. A missing session working directory has no project instructions or skills; global context still loads. New sessions require an existing working directory and fail before creating a log or lock otherwise. Project instructions follow from the project root through the session working directory. Each directory selects `AGENTS.md`, or `CLAUDE.md` when `AGENTS.md` is absent. Later instruction files take precedence on conflicts, as stated in the system prompt. Standalone local `@path` lines expand in place. Missing paths with a `./`, `../`, `~/`, or `/` prefix stop startup; unprefixed paths expand only when they resolve to regular files and otherwise stay literal. Permission errors still stop startup. Rx reads these files and never creates or changes them. |
| RX-SKILL-001 | Skills follow the Agent Skills format. Project `.agents/skills` directories take precedence from the working directory toward the project root, followed by `~/.agents/skills`. The first skill with a given name wins. Within each search root, ordinary skills precede `.system` groups. Other hidden directories are excluded. Rx reports collisions with both paths on stderr, except when an ordinary skill overrides a `.system` skill. The prompt lists only the name, description, absolute `SKILL.md` path, and reading instructions. Rx excludes skills with `disable-model-invocation: true` from this catalog. |
| RX-HOOK-001 | User command hooks use one read-only configuration snapshot, fail closed before execution, may replace pre-tool input, preserve completed tool output, persist labeled context, and cancel process groups. [Full contract](docs/hooks.md). |
| RX-MCP-001 | User and ACP MCP servers supply session tools through pi-mcp. Startup failures skip the failed server and produce a warning. See the full [MCP contract](docs/mcp.md#contract). |

| RX-COMPACT-001 | Automatic request budgets. [Full contract][compaction]. |
| RX-COMPACT-002 | Append-only checkpoints. [Full contract][compaction]. |
| RX-COMPACT-003 | Bounded summaries. [Full contract][compaction]. |
| RX-COMPACT-004 | Overflow recovery and cancellation. [Full contract][compaction]. |
| RX-COMPACT-005 | REPL and ACP lifecycle. [Full contract][compaction]. |

[compaction]: docs/context-compaction.md

## Ownership

| Surface | Owner | Rule |
| --- | --- | --- |
| `$RX_HOME/config.json` | user | Rx reads `model` and `thinking`; it never writes the file. |
| `$RX_HOME/hooks.json` | user | Read-only command checks under RX-HOOK-001. No project discovery. |
| `$RX_HOME/mcp.json` | user | Read-only MCP server definitions under RX-MCP-001. |
| `$RX_HOME/AGENTS.md` and referenced files | user | Rx reads global instructions. Users can create a symlink to their shared instructions. Rx never creates that link. |
| `$RX_HOME/sessions/<id>.jsonl` | Rx | Created and appended by Rx only. |
| `$RX_HOME/sessions/<id>.lock` | Rx | Written while a process holds the session; removed when that process exits. |
| `$RX_HOME/auth.json`, `auth.json.lock` | Rx | Written only by `login`, `logout`, and OAuth refresh under RX-AUTH-001. |
| `$RX_HOME/device-id` | Rx | A random UUID created on first need and sent to providers whose login requires an installation id. |
| Project `AGENTS.md` / `CLAUDE.md` and referenced files | user | Read into the system prompt under RX-CONTEXT-001. Never written by Rx itself. |
| `~/.agents/skills` and project `.agents/skills` | user | Rx reads skill metadata at agent creation and load. The existing `read` tool loads skill bodies and references on demand. |
| Provider environment variables | user | Read by pi-ai when the store has no credential for that provider. |
| `RX_AGENT_PROVIDER`, `RX_MODEL` | Rx launcher | Set by `rx rx-agent` / `rxa` for one launch; `RX_MODEL` only when `rx.toml` selects a model. rx-agent never persists them. |

## Instructions and skills

See [Instructions and skills](docs/instructions-and-skills.md) for context loading, references, discovery, and upstream ownership.

## ACP session controls

Configuration requests fail while a prompt or another configuration change is active.
Validation and snapshot construction finish before the selection changes.
The ACP session owns model, thinking, and Fast. The agent uses that selection for its next model call.
Lody owns and reapplies saved choices after new or loaded sessions. Session logs keep their format.
Standard `configOptions` are primary. SDK 2.0.2 does not expose the strongest alternative, the legacy model setter.
Optional `_meta.lody.modelCapabilities` describes each available model before selection because standard options describe only the current model.
The map and controls share pi-ai metadata and Fast policy.

The seven Fast model IDs are `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
They require https://chatgpt.com/backend-api and API `openai-codex-responses`.
Fast requests priority service and can use more subscription allowance ([Speed documentation](https://developers.openai.com/codex/speed/)).
The server chooses the actual tier. A successful priority request can receive default service and does not prove Fast delivery.
If Codex changes supported tiers, review the model list.
The strongest alternative is the low-level `stream` API with `serviceTier`.
Rx retains `streamSimple` for thinking-level conversion and `onPayload` forwarding in pi-ai 1.4.0.
If the dependency changes, run a payload probe to test that forwarding.

Lody sends workspace MCP servers through ACP new and load.
Rx connects those servers and reports HTTP support, with legacy SSE unsupported.
MCP tools use the same execution, cancellation, logging, and ACP result path as local tools.
Global image support means at least one available model accepts images.
Each prompt rejects unsupported images before logging or provider access.

## Model connection failures

For HTTP adapters that accept custom fetch, Rx captures fetch failures before pi-ai converts errors to strings.
The agent attaches the cause to the existing assistant `errorMessage` before logging and output.
CLI errors and ACP JSON-RPC errors therefore use the same diagnostic as the session log.
Rx does not add conversation text for a failed live ACP prompt.

Diagnostics contain only known system and TLS error codes, nonzero integer errno values, and known syscall names.
Cause chains and aggregate errors have a limit of eight objects.
Raw exception text, stacks, headers, URLs, and hostnames are excluded because they can contain credentials.
Unknown codes are omitted. An error without recognized fields reports that its cause is unavailable.
The log format and version stay unchanged. Existing logs cannot recover causes that were already discarded.

OpenAI-compatible, Codex HTTP, Anthropic, Mistral, and pi-messages requests use the supported fetch hook in pi-ai 1.4.0.
Google, Vertex, Bedrock, WebSocket failures, and errors while reading a response body keep their existing diagnostics.
Patching pi-ai to expose the original SDK exception is the strongest alternative.
The public fetch hook avoids a dependency fork and gives Rx a narrow boundary for secret filtering.
Each agent reuses one fetch wrapper so that provider clients retain their authentication caches without sharing failure state between sessions.
If a needed cause remains unavailable or an adapter changes its fetch support, revisit that choice.

Rx adds only the context-overflow recovery in RX-COMPACT-004. pi-ai supports bounded provider retries, but its current default is zero.
The original connection failure did not retain enough evidence to establish that a retry was safe or useful.
Repeated failures with a known transient cause are the signal to reconsider transport retries.
Cancellation keeps its existing aborted result and does not gain a connection diagnostic.
SDK timeouts and aborts keep pi-ai's own error message.

## Context compaction

The full RX-COMPACT-001..005 contracts, budgets, and rationale are in
[Context compaction](docs/context-compaction.md).

The `read` tool returns local images under the [image read contract](docs/read-images.md).

[Distribution](docs/distribution.md)

## Change authority

Agents may change internal structure, helpers, errors, prompts that do not
change public behavior, and tests when all invariants hold.

Owner approval and a matching update to this contract are required for CLI
commands and flags, defaults (model, thinking level, tool set, limits), file
locations and log format, credential persistence, permission or sandbox
policy, replacing pi-agent-core or pi-ai, and releases.

## Acceptance

Every change passes `make agent-check`, and `make agent` compiles.
CLI changes also prove that the first prompt completes and the REPL accepts another input through `rx-agent` and the affected launcher entrypoint.

Changes to agent, tool, log, cancel, or ACP behavior also pass both real-model
checks. Run them with a scratch `RX_HOME` and working directory, and pass the
provider key through the environment of that run only.

1. `rx-agent -p "<task that needs tools>"`, run directly or through `rxa`, exits 0 with the expected answer, and
   the log origins read `cli`, then `model`/`tool` pairs, then a final `model`
   message.
2. `node scripts/acp-smoke.ts [provider/id]` in `agent/` reports `end_turn` for the file
   read, `cancelled` for the cancelled `sleep`, and lists the session. The log
   ends with an `aborted` assistant message.

Changes to `login`, `logout`, or the credential store also pass a real login
with a scratch `RX_HOME`: `rx-agent login <provider>` stores the credential,
`rx-agent models` lists that provider without its environment variable, and a
`-p` run on one of its models exits 0.
