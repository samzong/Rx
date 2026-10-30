# Rx Design Contract

This is the normative Rx contract. Conflicting code is a bug, not precedent.

## Principles

- Native first: Rx executes the installed harness and preserves its behavior.
- User ownership: users own harness installation, sessions, and unowned config.
- Scoped adaptation: inject at launch; persist only when the harness requires it.
- Explicit ownership: location or matching content never proves Rx ownership.
- Harness fidelity: do not force different CLIs through a behavior-changing
  common abstraction.
- No inference: missing product decisions require the owner; agents do not
  invent defaults or boundaries.

Rx owns provider selection, its credential store, generated catalogs, and the
minimum adapter state needed to launch. It does not depend on Recall core or
read `recall.db`.

rx-agent is the one first-party harness. It is built from `agent/`, whose own
contract is [agent/DESIGN.md](../agent/DESIGN.md), and the launcher treats it
under the rules in [rx-agent](#rx-agent).

## Invariants

| ID | Contract |
| --- | --- |
| RX-NATIVE-001 | Execute the installed native CLI, never an Rx fork, bundled copy, or relocated third-party installation. rx-agent is Rx-owned under RX-AGENT-001. |
| RX-INSTALL-001 | For third-party harnesses, run the official installer with the user's path-shaping environment. Manual and Rx installation use the same command, environment, and location. Rx-managed rx-agent follows RX-AGENT-001. |
| RX-INSTALL-002 | Discovery, installation, and verification use the same user-owned harness home; hosted state never participates. |
| RX-ARGS-001 | Preserve argv and executable paths as OS strings. Treat everything after `--` as literal. |
| RX-ROUTE-001 | `--provider none` or no provider means native passthrough without provider or model injection. |
| RX-ROUTE-002 | Inject only the selected route, credential reference, model, and permission policy; preserve unrelated native behavior. |
| RX-MINIMAL-001 | Injection is launch-scoped (flags, child environment, launch overlays). Rx never redirects, replaces, or hides a harness's user-owned home or configuration discovery path in any mode, and never mutates user-owned configuration beyond marker-owned entries. |
| RX-CATALOG-001 | Runtime model discovery decides availability only. Protocol-scoped model capabilities come from the bundled provider snapshot and apply only to the matching provider endpoint; unknown capabilities are never inferred. |
| RX-OWN-001 | Mutate only explicitly Rx-owned identities, preserve unowned data, follow each surface's owned-edit rule, lock, write atomically, and fail closed on malformed input. |
| RX-SECRET-001 | Never put credentials in argv, logs, or broad-permission files. Persist only when unavoidable and owner-approved. |
| RX-LIFECYCLE-001 | Install policy, planning controls, and child environment are separate scopes; Rx-only controls never reach the child. |
| RX-AGENT-001 | The canonical harness is `rx-agent`, launched by `rx rx-agent`, `rx agent`, and `rxa`. Discovery is PATH, then beside Rx, then a verified managed version under `~/.recall/rx-agent/versions/<version>/`. A missing-agent terminal launch can install that managed version after `[y/N]` approval. External installations always precede management and never trigger managed updates. Independent `rx-agent-v*` releases never become the repository latest release. Rx releases explicitly become latest. Both products require SHA256SUMS. `make install` continues to install both binaries. See [distribution](../agent/docs/distribution.md). |
| RX-AGENT-002 | A provider launch hands rx-agent only the child environment: the provider key under the provider's `env` name, `RX_AGENT_PROVIDER` (provider id, name, API, base URL, key variable name, the catalog models, and `defaultModel`; a model with a bundled `anthropic-messages` capability entry also carries `api: anthropic-messages` and the provider's Messages base URL), and `RX_MODEL` as `provider/model` only when `rx.toml` sets the provider-level `model`. `defaultModel` is that `model`, else the provider's default model, else the first listed model. Catalog failure hands off only the `--model` and default models, and fails when neither exists. Argv is never rewritten. |
| RX-AGENT-003 | Handed-off model capabilities follow RX-CATALOG-001: reasoning levels come only from the bundled snapshot for the protocol the model is handed off on, unlisted levels are sent as unsupported, and models without snapshot capabilities are sent with `reasoning: false`. A missing context length uses the provider's fallback context. |
| RX-HOST-001 | Hosted mode injects the same launch-scoped route and permissions as a native Rx launch; it never overrides any harness home, and hosted state holds Rx-internal runtime state only. |
| RX-CONCURRENCY-001 | Concurrent launches cannot retarget, corrupt, or delete another launch or user edit. |
| RX-FAIL-001 | Non-interactive runs never install or destructively repair without approval. An accepted managed rx-agent can update in a detached process under RX-AGENT-004; malformed user config is preserved and reported. |
| RX-AGENT-004 | A missing-agent terminal launch asks `[y/N]`, even after an earlier refusal. Only the picker recommends installation, and only before a refusal. `RX_NO_INSTALL` disables the prompt. `RX_NO_UPDATE` disables both startup updaters. Rx self-update skips noninteractive launches, which includes ACP over pipes, and print, help, and version launches. A launch whose managed agent check is overdue spawns a detached updater with null stdio, proxy settings, and no provider credentials. It then executes the already selected path. Installation holds `install.lock` and verifies SHA-256. It records the version only after the version directory is in place. After an install, cleanup keeps the current and previous versions and makes one silent deletion attempt on the others, without in-use detection. |

## Ownership

| Surface | Owner | Rule |
| --- | --- | --- |
| `~/.recall/rx.toml`, `rx.keys`, `catalogs/` | Rx | Provider config, secret store, and endpoint-scoped catalog cache. |
| Bundled provider and model capability snapshot | Rx release | Stable provider, endpoint, model, and protocol semantics; runtime discovery intersects but never rewrites them. |
| Claude catalog caches | shared | Marker identity stays Rx-owned even if changed or deleted; preserve unmarked entries. |
| Codex config | launch | Prefer `-c` and environment injection. |
| OpenCode config | launch | Prefer `OPENCODE_CONFIG_CONTENT`; only warn about native auth conflicts. |
| Pi `models.json` | shared | Own the selected provider entry recorded in the `models.json.rx-catalog.json` marker; preserve the rest; reject malformed roots. |
| DSH install and profile | user | Use the user's npm prefix and native `DSH_HOME` (`~/.dsh` by default); routing uses a per-provider launch overlay under `~/.recall/dsh/<provider>/`. |
| Kimi `config.toml` | shared | Use `rx`-prefixed marked entries; preserve collisions and user edits. Launch leases protect active catalog identities. Its required literal credential uses secret mode. |
| `$RX_HOME` (default `~/.rx`) | rx-agent / user | rx-agent owns sessions and its credentials (`auth.json`, `device-id`), independent of `rx.keys`. The user owns `config.json`, `mcp.json`, `hooks.json`, and `AGENTS.md`, which rx-agent only reads. The launcher never reads or writes this directory. |
| `~/.recall/rx-agent/install.toml`, `install.lock`, `versions/` | Rx | Selected version, installation refusal, last update check, and verified release directories. Malformed state fails closed when management is used. |
| Hosted state | host caller | Rx-internal runtime state only (catalog cache); harness homes are never redirected into it; never an installation root. |

Injection preference is: flags or environment, immutable launch config, then a
narrowly merged owned entry. Convenience never justifies persistent mutation.

Kimi launches hold shared file leases across native execution. Unix uses inherited
`flock` locks. Windows uses inherited read handles that deny write sharing.
During planning, lease descriptors retain close-on-exec and Windows handles remain
non-inheritable. `launch::exec` creates an inheritable duplicate for native handoff.
On Unix, discarding a plan explicitly unlocks its lease before closing the
descriptor, so unrelated forked children cannot prolong a cancelled launch.
Successful exec replaces Rust without running that cleanup and leaves the native
process holding the lock.
Identical complete
catalog snapshots share one immutable lease identity derived from the snapshot
fingerprint. The catalog marker records active and current snapshots; historical
lease files alone never establish config ownership. A later launch may reclaim
an exited snapshot's entries only when its lease permits an exclusive probe and
the entries still match their ownership records. Active identities retain their
original aliases; conflicting changes fail closed. Missing or malformed lease
records do not prove that a launch exited. Empty lease files are retained and
reused, so file growth follows distinct snapshots rather than launch count.
Rx never truncates lease files. Only `rx providers logout` deletes them, and
only for a catalog it has just purged after an exclusive probe proved it exited.

Before migrating a version 1 Kimi catalog marker, the user must close every
Kimi session started by an older Rx and explicitly confirm migration in a
terminal. Rx never terminates those sessions. Non-interactive launches refuse
migration, and older Rx versions cannot write the migrated marker. Rolling
back Rx must preserve the new marker so older writers continue to fail closed.

## Logout cascade

`rx providers logout <provider>` removes the stored key and every Rx-owned
entry that provider caused Rx to persist in a harness config: the Kimi provider
and model entries plus their marker and exited leases, the Claude catalog caches
and their markers, the Pi provider entry, the DSH launch overlay, and the
generated catalog cache.

Removal follows RX-OWN-001: an entry is removed only when a marker records Rx as
its author and the on-disk value still matches the recorded payload. Entries
without a marker, or edited since Rx wrote them, are preserved and reported by
path so the user decides. Kimi is the only surface holding a literal credential,
so an active lease there blocks removal. Logout is fail-closed: when any
credential surface still holds a copy of the key, Rx keeps its own stored key
too, names the blocker, and tells the user to rerun logout. A logout that
removes the stored key therefore means no Rx-written copy of that key is left
behind.

Hosted order is: select harness, discover or install in the user environment,
validate route conflicts, execute with the same launch-scoped injection as a
native `rx` / `rxc` launch, permission flags included. Route checks stop at
`--`.

## rx-agent

`rx rx-agent` and `rxa` launch rx-agent. The legacy command `rx agent` remains
an alias. The first picker entry displays `rx-agent` with shortcut `a`.
Shell completions offer both command names and keep prefix completion for `ag`.
Codex keeps `rxx` and shortcut `x`. With `--provider none`,
rx-agent runs as-is under RX-ROUTE-001 and resolves models through its own
pi-ai configuration and the credentials it stores with `rx-agent login`. Rx applies no permission flags; rx-agent's tool policy
is RX-PERM-001 in its own contract. Hosted mode does not launch rx-agent and
the hosted picker omits it.

The harness parser accepts both names and returns one harness identity.
A separate picker label is the simpler alternative, but it leaves commands,
completion, and launch diagnostics with different canonical names.
Rx stores no harness selection in `rx.toml`, `$RX_HOME/config.json`, or session
logs. Existing commands stored by callers remain readable through the alias.
The rename requires no data migration. ACP keeps its existing `rx` identity
and `Rx` title. CLI harness selection does not control ACP identity or the
client's saved Agent configuration name.

rx-agent validates `RX_AGENT_PROVIDER` and fails closed on malformed input. When
the handed-off provider id and endpoint match a pi-ai built-in provider with the
same API, rx-agent keeps pi-ai's metadata for listed models, because pi-ai
carries per-endpoint compatibility settings the snapshot does not. Built-in
models absent from the handoff are dropped. Other models get pi-ai custom-model
defaults: text input, zero cost, and 16384 max output tokens.

Context compaction belongs to rx-agent under RX-COMPACT-001..005 in its own contract.
The launcher keeps the request, plan, configuration, and exec path. Binary discovery follows RX-AGENT-001.
RX-AGENT-002/003 continue to supply endpoint-scoped model metadata and context windows.
Its `recall_log` tool retrieves visible content from the current session without a Recall dependency or new ACP message types.
Summary usage uses additive v1 message fields under the [session log contract](../agent/docs/session-log.md).
Initial CLI prompts follow the [agent CLI contract](../agent/docs/cli.md).
The launcher preserves prompt arguments and `--` through the same request, install, plan, configuration, and exec path.

MCP startup belongs to rx-agent under RX-MCP-001. It connects servers in parallel,
skips failed servers, and reports sanitized warnings in CLI and ACP sessions.
The launcher preserves the same environment-only handoff under RX-AGENT-002/003.
It never reads or repairs the user-owned MCP configuration.

User command hooks belong to rx-agent under RX-HOOK-001 in its own contract.
The launcher never reads or writes `$RX_HOME/hooks.json`.
Hook execution starts after exec and preserves RX-AGENT-001..003.
See the [hook contract](../agent/docs/hooks.md).

## Adding a harness

Adding a harness requires an owner decision covering CLI name, alias, install,
provider/model behavior, permissions, persistence, secrets, and hosted state.
Implementation must cover:

- enum, parser, help, picker, shortcuts, aliases, completions, Makefile, release;
- official install, discovery, partial install, and non-interactive behavior;
- provider/model precedence, `none`, `--`, resume, subcommands, and permissions;
- config ownership, malformed input, locking, atomicity, cleanup, and concurrency;
- credential transport, persistence, permissions, and redaction;
- hosted capabilities, route guards, environment scopes, and documentation.

Acceptance must prove native behavior, manual/Rx install parity, reuse of an
existing installation, passthrough and provider routing, preservation of
unowned config, hosted route integrity, real-TTY alias/picker behavior, and
both `cargo test -p rx` and `make check`.

## Change authority

Agents may change internal structure, helpers, errors, caches, serialization,
or tests when public behavior and all invariants stay unchanged.

Owner approval and a matching contract update are required for harnesses,
aliases, CLI semantics, defaults, install behavior, native config ownership,
secret persistence, hosted overrides/protocol, or Rx-managed distribution.

Before changing Rx: identify affected invariant IDs, trace `request -> install
-> plan -> config -> exec`, verify upstream native behavior, reproduce the
failure, and review the final diff against this contract. Tests never excuse a
contract mismatch.
