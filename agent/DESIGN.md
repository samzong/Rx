# rx-agent Design Contract

This is the normative contract for rx-agent, Rx's coding agent. The launcher
side of the provider handoff is RX-AGENT-001..003 in
[docs/DESIGN.md](../docs/DESIGN.md). Conflicting code is a bug, not precedent.

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
| `src/instructions.ts` | Finds the project boundary and loads instructions with local file references. |
| `src/skills.ts` | Finds skill files and uses pi-coding-agent to load metadata and format the catalog. |
| `src/tools.ts` | `read`, `write`, `edit`, and `bash`, all relative to the session working directory. |
| `src/session-log.ts` | Append-only JSONL session log, resume repair, and session listing. |
| `src/models.ts` | Model and thinking-level resolution through pi-ai `Models`. |
| `src/rx-provider.ts` | Validates the `RX_AGENT_PROVIDER` handoff and registers its provider and models. |
| `src/credentials.ts` | rx-agent's credential store (`$RX_HOME/auth.json`) and installation id. |
| `src/login.ts` | Terminal `login` flow: provider and method choice, prompts, browser and device-code links. |
| `src/pid-lock.ts` | Pid lock primitives shared by session and credential locks. |
| `src/terminal.ts` | REPL and `-p` print mode. |
| `src/acp.ts` | Agent Client Protocol server over stdio. |
| `src/cli.ts` | Argument parsing and entrypoint. |

## Invariants

| ID | Contract |
| --- | --- |
| RX-CORE-001 | The agent loop is pi-agent-core's `Agent`, constructed only in `src/agent.ts`. Model calls go through pi-ai `Models`. Replacing either requires eval evidence and an owner decision. |
| RX-LOG-001 | Every message that enters the agent context is appended to the session log with its real origin: `cli`, `acp`, `model`, `tool`, or `rx`. The only exception is the initial system prompt. Rx rebuilds that prompt from the current environment, global and project instructions, referenced files, and skill metadata when it creates or loads an agent. Rx completes this read-only context build before creating or opening a session log. A context failure creates no session file or lock and does not repair or change an existing log. These inputs are not saved in the log. Skill bodies and references enter the log only through normal tool results. Rx never rewrites or deletes a complete log line; the only permitted change is truncating an unterminated final fragment (RX-LOG-002). |
| RX-LOG-002 | A log starts with a versioned header. Only newline-terminated lines count. Rx rejects unknown versions and fails on any corrupt terminated line. Opening a session to append truncates an unterminated final fragment first, and a failed append truncates its partial line. A new log version must keep reading every earlier version. |
| RX-LOG-003 | One process writes a session at a time. Creating or opening a session atomically takes `sessions/<id>.lock` holding the owner pid. A lock held by a live process is an error that names the lock file; a lock left by a dead process is reclaimed. An open that fails releases the lock it took. `session/load` checks the session's `cwd` before taking the lock. If the dead owner's pid has been reused, the lock is not reclaimed and the user deletes the named file. Two processes reclaiming the same dead lock at the same moment can both proceed; Rx accepts this because it needs a crash followed by two simultaneous opens of that session. |
| RX-RESUME-001 | Resume replays the logged messages under the current system prompt, rebuilt for the saved session working directory. If that directory is missing, resume and ACP load still open the session with global instructions and skills only. The saved working directory and the CLI note remain unchanged; tools still run at that original path. Changes to instructions, their references, skill metadata, HOME, or RX_HOME can change resumed behavior. The log alone cannot reproduce the earlier system prompt. Each tool call without a recorded result gets exactly one `rx`-origin error result stating that its side effects are unknown. Rx never re-runs it. |
| RX-CANCEL-001 | Cancelling a turn (ACP `session/cancel`, Ctrl-C) kills the running tool's whole process group and ends the turn. A closed ACP connection, SIGTERM, or SIGHUP aborts running turns the same way and waits for them to be logged. `bash` completes when its shell exits, after a short grace period for output pipes, so background processes cannot hold a turn open. The log ends with an `aborted` assistant message and the ACP prompt returns `cancelled`. pi-ai can report an abort as `error`; Rx normalizes it. |
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
| RX-ACP-004 | After each measured assistant response, ACP reports the latest input, output, cache-read, and cache-write token sum with that model's context window. These values are a recent context measurement, not cumulative session usage or an estimate of unsent input. Costs are omitted. Load replays the latest matching measurement. Image input requires the current model's image capability. Rx does not connect MCP servers and reports this limitation on stderr when servers are supplied. HTTP and SSE MCP capabilities are false. |
| RX-CONTEXT-001 | Global instructions come from `$RX_HOME/AGENTS.md`. A missing session working directory has no project instructions or skills; global context still loads. New sessions require an existing working directory and fail before creating a log or lock otherwise. Project instructions follow from the project root through the session working directory. Each directory selects `AGENTS.md`, or `CLAUDE.md` when `AGENTS.md` is absent. Later instruction files take precedence on conflicts, as stated in the system prompt. Standalone local `@path` lines expand in place. Missing paths with a `./`, `../`, `~/`, or `/` prefix stop startup; unprefixed paths expand only when they resolve to regular files and otherwise stay literal. Permission errors still stop startup. Rx reads these files and never creates or changes them. |
| RX-SKILL-001 | Skills follow the Agent Skills format. Project `.agents/skills` directories take precedence from the working directory toward the project root, followed by `~/.agents/skills`. The first skill with a given name wins. Within each search root, ordinary skills precede `.system` groups. Other hidden directories are excluded. Rx reports collisions with both paths on stderr, except when an ordinary skill overrides a `.system` skill. The prompt lists only the name, description, absolute `SKILL.md` path, and reading instructions. Rx excludes skills with `disable-model-invocation: true` from this catalog. |

## Ownership

| Surface | Owner | Rule |
| --- | --- | --- |
| `$RX_HOME/config.json` | user | Rx reads `model` and `thinking`; it never writes the file. |
| `$RX_HOME/AGENTS.md` and referenced files | user | Rx reads global instructions. Users can create a symlink to their shared instructions. Rx never creates that link. |
| `$RX_HOME/sessions/<id>.jsonl` | Rx | Created and appended by Rx only. |
| `$RX_HOME/sessions/<id>.lock` | Rx | Written while a process holds the session; removed when that process exits. |
| `$RX_HOME/auth.json`, `auth.json.lock` | Rx | Written only by `login`, `logout`, and OAuth refresh under RX-AUTH-001. |
| `$RX_HOME/device-id` | Rx | A random UUID created on first need and sent to providers whose login requires an installation id. |
| Project `AGENTS.md` / `CLAUDE.md` and referenced files | user | Read into the system prompt under RX-CONTEXT-001. Never written by Rx itself. |
| `~/.agents/skills` and project `.agents/skills` | user | Rx reads skill metadata at agent creation and load. The existing `read` tool loads skill bodies and references on demand. |
| Provider environment variables | user | Read by pi-ai when the store has no credential for that provider. |
| `RX_AGENT_PROVIDER`, `RX_MODEL` | Rx launcher | Set by `rx agent` / `rxa` for one launch; `RX_MODEL` only when `rx.toml` selects a model. rx-agent never persists them. |

## Instructions and skills

Rx resolves working-directory symlinks, then runs `git rev-parse --show-toplevel` there once per system prompt to find the nearest project root.
Git owns worktree, submodule, and nested-repository boundaries, unlike the simpler `.git` marker search.
Without Git or a containing root, project scope is the working directory alone.
Rx reads no project instructions or skills from ancestors outside that scope.
A missing directory or non-directory ancestor removes project scope.
Resume and ACP load keep the saved working directory and global context, without searching surviving ancestors or substituting the caller's directory.
Other path errors, including permission errors, stop context loading.

Local `@path` references occupy their own line outside fenced or indented code and expand in place.
Absolute, `~/`, `./`, and `../` paths permit spaces.
Unprefixed paths require a slash or dot, forbid whitespace, and expand only to regular files, including through symlinks.
Missing candidates, directories, and other file types stay literal, as do bare mentions, email addresses, URLs, and references within prose.
Thus `@types/node`, `@1.4.0`, and `@app.route` expand only if a matching file exists.
Relative paths use the resolved referring file's directory. `~/` uses the current home.
Rx loads each real file once across all instructions and references. Active-file cycles stop startup.
Missing top-level files are optional. Unreadable files, broken top-level symlinks, and missing explicit references stop startup with the source path.
Reference permission errors also include the source line.

Skill discovery follows directory symlinks and deduplicates real paths to stop cycles.
RX-SKILL-001 defines hidden-directory traversal, root priority, and collision reporting.
Names have deterministic ordering within each root.
A directory containing `SKILL.md` ends discovery below that directory.
Discovery skips `node_modules` and loose Markdown files.
Missing search directories are optional. Other discovery and metadata problems appear on stderr.
ACP stdout carries only protocol messages.

CLI and ACP build the complete system prompt before creating or opening a log.
Resume reads the saved directory without a lock before building context, then opens and repairs the session.
A failed build leaves no empty session ahead of the last real session in `--continue`.
Fixing the reference permits retry without cleanup. ACP errors include the source path and line when available.
Post-failure cleanup is the strongest alternative, but requires separate rollback for new logs, repairs, and locks.
Preflight avoids those writes and never silently drops missing references or cycles.

Rx supplies discovered files to the public pi-coding-agent 1.4.0 API through
`loadSkills({ includeDefaults: false, skillPaths: [...] })` and `formatSkillsForPrompt(skills, "read")`.
Upstream owns YAML metadata, validation, collision diagnostics, and prompt formatting.
Explicit `skillPaths` include hidden groups that upstream discovery skips, without upstream changes.
Rx retains its agent loop, tools, log, discovery boundary, and instruction expansion.
The simpler upstream default resource loader has different instruction paths and defaults from RX-CONTEXT-001 and RX-SKILL-001.
The `read` tool opens skill bodies by absolute path. References are relative to the skill directory.
Skills add no tools or permissions. Without a skill command, disabled skills require an ordinary user request supplying the file.
This contract adds no flags, environment variables, or hot reload.

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

Lody sends its built-in stdio MCP server even without HTTP MCP support.
The stable protocol has no flag to disable stdio MCP. Rx adds no MCP client or approval policy.
Ordinary chat retains four tools, excluding Lody's server tools.
Global image support means at least one available model accepts images.
Each prompt rejects unsupported images before logging or provider access.

## Change authority

Agents may change internal structure, helpers, errors, prompts that do not
change public behavior, and tests when all invariants hold.

Owner approval and a matching update to this contract are required for CLI
commands and flags, defaults (model, thinking level, tool set, limits), file
locations and log format, credential persistence, permission or sandbox
policy, replacing pi-agent-core or pi-ai, and releases.

## Acceptance

Every change passes `make agent-check`, and `make agent` compiles.

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
