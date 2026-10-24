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
| RX-LOG-001 | Every message that enters the agent context is appended to the session log with its real origin: `cli`, `acp`, `model`, `tool`, or `rx`. The only exception is the initial system prompt, which is regenerated on every start. Rx never rewrites or deletes a complete log line; the only permitted change is truncating an unterminated final fragment (RX-LOG-002). |
| RX-LOG-002 | A log starts with a versioned header. Only newline-terminated lines count. Rx rejects unknown versions and fails on any corrupt terminated line. Opening a session to append truncates an unterminated final fragment first, and a failed append truncates its partial line. A new log version must keep reading every earlier version. |
| RX-LOG-003 | One process writes a session at a time. Creating or opening a session atomically takes `sessions/<id>.lock` holding the owner pid. A lock held by a live process is an error that names the lock file; a lock left by a dead process is reclaimed. An open that fails releases the lock it took. `session/load` checks the session's `cwd` before taking the lock. If the dead owner's pid has been reused, the lock is not reclaimed and the user deletes the named file. Two processes reclaiming the same dead lock at the same moment can both proceed; Rx accepts this because it needs a crash followed by two simultaneous opens of that session. |
| RX-RESUME-001 | Resume replays the logged messages under the current system prompt. Each tool call without a recorded result gets exactly one `rx`-origin error result stating that its side effects are unknown. Rx never re-runs it. |
| RX-CANCEL-001 | Cancelling a turn (ACP `session/cancel`, Ctrl-C) kills the running tool's whole process group and ends the turn. A closed ACP connection, SIGTERM, or SIGHUP aborts running turns the same way and waits for them to be logged. `bash` completes when its shell exits, after a short grace period for output pipes, so background processes cannot hold a turn open. The log ends with an `aborted` assistant message and the ACP prompt returns `cancelled`. pi-ai can report an abort as `error`; Rx normalizes it. |
| RX-SECRET-001 | Credentials come from rx-agent's own store or from provider environment variables, both resolved by pi-ai; a stored credential wins over the environment. Rx never writes credentials to its config, logs, or argv. Tools inherit the full environment, including provider keys, and tool output is logged verbatim, so a command that prints a key puts it in the session log. Filtering the tool environment requires an owner decision. |
| RX-AUTH-001 | `rx-agent login` and `logout` manage rx-agent's own credentials, including ChatGPT subscriptions (OAuth) and API keys, in `$RX_HOME/auth.json`. This store is independent of the rx launcher's provider configuration and key store. The file is `0600` in a `0700` directory and is replaced atomically. Every write, including an OAuth token refresh during a run, holds `auth.json.lock` with the owner pid; a live owner is waited for up to 30 seconds and then named in the error, and a dead owner's lock is reclaimed with the same pid-reuse limit as RX-LOG-003. A malformed file or entry is an error and is never overwritten. |
| RX-AUTH-002 | During an rx launch, the store hides the handed-off provider id: its key comes only from the launch environment, and `login` / `logout` ignore the handoff. Other stored providers stay available, so `--model <provider>/<id>` can select a subscription model in an rx launch. |
| RX-HANDOFF-001 | When `RX_AGENT_PROVIDER` is set, rx-agent validates it and fails closed on malformed input, then registers that provider with the handed-off models only. A listed model keeps pi-ai's built-in metadata only when the provider id, endpoint (ignoring a trailing `/v1`), and API all match a built-in provider; any other model gets the handed-off context window and reasoning levels with text input, zero cost, and 16384 max output tokens. The key is read from the named environment variable. `defaultModel` must name a handed-off model. Requests to an `openai-responses` handoff omit `prompt_cache_key`, because gateways such as Tokener reject it for some models. |
| RX-MODEL-001 | The model is `--model`, then `RX_MODEL`, then `model` in `$RX_HOME/config.json`. In an rx launch, a missing `model` selects `RX_AGENT_PROVIDER`'s `defaultModel` with a stderr note, and a `model` of another provider, or one that cannot be resolved in that launch, falls back to `defaultModel` with a stderr note naming the reason. Without a launch, a missing or unresolvable model is an error. An invalid `thinking` is always an error. |
| RX-PRIVATE-001 | Session logs live under `$RX_HOME` (default `~/.rx`) with `0700` directories and `0600` files. Session logs and eval tasks never enter this repository. |
| RX-PERM-001 | Tools run with the user's permissions and no sandbox. This is an owner decision for the prototype; a sandbox replaces it in a later phase. |

## Ownership

| Surface | Owner | Rule |
| --- | --- | --- |
| `$RX_HOME/config.json` | user | Rx reads `model` and `thinking`; it never writes the file. |
| `$RX_HOME/sessions/<id>.jsonl` | Rx | Created and appended by Rx only. |
| `$RX_HOME/sessions/<id>.lock` | Rx | Written while a process holds the session; removed when that process exits. |
| `$RX_HOME/auth.json`, `auth.json.lock` | Rx | Written only by `login`, `logout`, and OAuth refresh under RX-AUTH-001. |
| `$RX_HOME/device-id` | Rx | A random UUID created on first need and sent to providers whose login requires an installation id. |
| Project `AGENTS.md` / `CLAUDE.md` | user | Read into the system prompt; `AGENTS.md` wins when both exist. Never written by Rx itself. |
| Provider environment variables | user | Read by pi-ai when the store has no credential for that provider. |
| `RX_AGENT_PROVIDER`, `RX_MODEL` | Rx launcher | Set by `rx agent` / `rxa` for one launch; `RX_MODEL` only when `rx.toml` selects a model. rx-agent never persists them. |

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
