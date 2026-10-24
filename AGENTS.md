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

- Keep `publish = false`; Rx ships as an application binary. The release owner
  chooses version bumps and publication.
- `make check` is the CI gate: cargo-audit 0.22.2, format, Clippy and tests.
- Never add code comments or doc comments. Preserve unrelated work.
- `.local/` is scratch and is not an architecture source.
