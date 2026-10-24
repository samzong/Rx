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
| RX-NATIVE-001 | Execute the installed native CLI, never an Rx fork, bundled copy, or relocated installation. rx-agent is Rx's own CLI, not a fork (RX-AGENT-001). |
| RX-INSTALL-001 | Run the official installer with the user's path-shaping environment. Manual and Rx installation must use the same command, environment, and location. |
| RX-INSTALL-002 | Discovery, installation, and verification use the same user-owned harness home; hosted state never participates. |
| RX-ARGS-001 | Preserve argv and executable paths as OS strings. Treat everything after `--` as literal. |
| RX-ROUTE-001 | `--provider none` or no provider means native passthrough without provider or model injection. |
| RX-ROUTE-002 | Inject only the selected route, credential reference, model, and permission policy; preserve unrelated native behavior. |
| RX-MINIMAL-001 | Injection is launch-scoped (flags, child environment, launch overlays). Rx never redirects, replaces, or hides a harness's user-owned home or configuration discovery path in any mode, and never mutates user-owned configuration beyond marker-owned entries. |
| RX-CATALOG-001 | Runtime model discovery decides availability only. Protocol-scoped model capabilities come from the bundled provider snapshot and apply only to the matching provider endpoint; unknown capabilities are never inferred. |
| RX-OWN-001 | Mutate only explicitly Rx-owned identities, preserve unowned data, follow each surface's owned-edit rule, lock, write atomically, and fail closed on malformed input. |
| RX-SECRET-001 | Never put credentials in argv, logs, or broad-permission files. Persist only when unavoidable and owner-approved. |
| RX-LIFECYCLE-001 | Install policy, planning controls, and child environment are separate scopes; Rx-only controls never reach the child. |
| RX-AGENT-001 | `make install` installs the single-file `rx-agent` binary, compiled by `bun build --compile` from `agent/`, beside `rx`. Rx resolves it from `PATH`, then beside the running `rx`, and never downloads or installs it; when it is missing, Rx fails and names `make install`. |
| RX-AGENT-002 | A provider launch hands rx-agent only the child environment: the provider key under the provider's `env` name, `RX_AGENT_PROVIDER` (provider id, name, API, base URL, key variable name, the catalog models, and `defaultModel`; a model with a bundled `anthropic-messages` capability entry also carries `api: anthropic-messages` and the provider's Messages base URL), and `RX_MODEL` as `provider/model` only when `rx.toml` sets the provider-level `model`. `defaultModel` is that `model`, else the provider's default model, else the first listed model. Catalog failure hands off only the `--model` and default models, and fails when neither exists. Argv is never rewritten. |
| RX-AGENT-003 | Handed-off model capabilities follow RX-CATALOG-001: reasoning levels come only from the bundled snapshot for the protocol the model is handed off on, unlisted levels are sent as unsupported, and models without snapshot capabilities are sent with `reasoning: false`. A missing context length uses the provider's fallback context. |
| RX-HOST-001 | Hosted mode injects the same launch-scoped route and permissions as a native Rx launch; it never overrides any harness home, and hosted state holds Rx-internal runtime state only. |
| RX-CONCURRENCY-001 | Concurrent launches cannot retarget, corrupt, or delete another launch or user edit. |
| RX-FAIL-001 | Non-interactive runs never install or destructively repair without approval; malformed user config is preserved and reported. |

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
| `$RX_HOME` (default `~/.rx`) | rx-agent | Sessions, rx-agent config, and rx-agent's own credentials (`auth.json`, `device-id`), independent of `rx.keys`; the launcher never reads or writes it. |
| Hosted state | host caller | Rx-internal runtime state only (catalog cache); harness homes are never redirected into it; never an installation root. |

Injection preference is: flags or environment, immutable launch config, then a
narrowly merged owned entry. Convenience never justifies persistent mutation.

Kimi launches hold shared file leases across native execution: inherited `flock`
locks on Unix and inherited read handles denying write sharing on Windows.
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

`rx agent` and `rxa` launch rx-agent; it is the first picker entry with
shortcut `a`. Codex keeps `rxx` and shortcut `x`. With `--provider none`,
rx-agent runs as-is under RX-ROUTE-001 and resolves models through its own
pi-ai configuration and the credentials it stores with `rx-agent login`. Rx applies no permission flags; rx-agent's tool policy
is RX-PERM-001 in its own contract. Hosted mode does not launch rx-agent and
the hosted picker omits it.

rx-agent validates `RX_AGENT_PROVIDER` and fails closed on malformed input. When
the handed-off provider id and endpoint match a pi-ai built-in provider with the
same API, rx-agent keeps pi-ai's metadata for listed models, because pi-ai
carries per-endpoint compatibility settings the snapshot does not. Built-in
models absent from the handoff are dropped. Other models get pi-ai custom-model
defaults: text input, zero cost, and 16384 max output tokens.

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
