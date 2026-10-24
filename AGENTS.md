# Rx

Independent native harness launcher. This repository owns Rx, its provider
metadata, binaries, and release workflow.

- Before changing Rx, read `docs/DESIGN.md`: it owns invariants, per-surface
  ownership, change authority, and native-behavior acceptance requirements.
  Identify affected invariant IDs and trace `request -> install -> plan ->
  config -> exec`.
- For provider or model-catalog work, also read `docs/PROVIDERS.md`. Admission is
  in `data/provider-admission.json`; regenerate `data/providers.json` with
  `scripts/update-rx-providers`. Both files are committed.
- Provider `none` skips injection. With no selected provider, an OpenRouter
  key still selects OpenRouter; absence of a selection alone does not prove
  native passthrough.
- Verify with `cargo test -p rx`, `make check`, and the affected native
  behavior checks required by `docs/DESIGN.md`.

- `agent/` holds rx-agent, Rx's TypeScript coding agent on
  `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. Before changing
  it, read `agent/DESIGN.md` and trace `input -> agent -> tools -> session log
  -> output`. The launcher-side handoff is RX-AGENT-001..003 in
  `docs/DESIGN.md`; change both sides together.
- In `agent/`, use Node 22.19 or later and pnpm. Source runs directly as `.ts`
  through Node type stripping; keep syntax erasable. `make agent-check` runs
  `pnpm audit`, `tsc --noEmit`, and `node --test`; `make agent` compiles the
  single-file binary with Bun. Keep `"private": true`.
- Pass provider credentials only through the environment of the process under
  test. Eval tasks and session logs stay outside the repository.

- Keep `publish = false`; Rx ships as an application binary. The release owner
  chooses version bumps and publication.
- `make check` is the Rust CI gate: cargo-audit 0.22.2, format, Clippy and
  tests. `make agent-check` is the agent CI gate.
- Never add code comments or doc comments. Preserve unrelated work.
- `.local/` is scratch and is not an architecture source.
