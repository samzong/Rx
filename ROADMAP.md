# Rx Roadmap

Adopt an existing default harness, build on Pi, and optionally develop an
independent core. Provider maintenance and external harness contributions
continue throughout.

Today, Rx launches six native CLIs and opens a picker when no harness is given.
No default agent is implemented. Before changing behavior, update the affected
contracts in [DESIGN.md](docs/DESIGN.md).

## Ongoing commitments

### Providers

Accept any provider that meets [PROVIDERS.md](docs/PROVIDERS.md), whether or not
the maintainer uses it. Keep admission standards unchanged across all phases.

Require the existing model-discovery and streaming protocol probes through one
API key. Verify model controls on their exact endpoint and protocol; unknown
capabilities remain unknown. Maintain the admission file and generated snapshot
with compatibility evidence. Success with the default harness alone does not
qualify a bundled provider.

### External harnesses

Keep existing integrations working and accept new ones for concrete needs.
The maintainer adds harnesses they use; contributors can add others. There is
no fixed shortlist. Each integration must meet DESIGN's installation, routing,
permissions, ownership, secrets, hosted-mode, and native acceptance requirements.

### Subscriptions

Rx does not implement subscription authentication, token extraction or refresh,
or subscription-sharing gateways. Harnesses keep their native subscription
support. Recommend [Magpie](https://github.com/yetone/magpie) for cross-agent
subscription sharing; it remains an external tool.

## Select a default harness

Recommend [Pi](https://github.com/earendil-works/pi): Rx already supports it,
and its SDK and extensions provide a path to the next phase. Selection remains
proposed. Codex is the alternative if Pi requires substantially more correction
or cannot complete the required tasks.

- Compare real repository tasks by completion, corrections, time, and cost.
- Define default selection alongside the picker, explicit launches, scripts,
  and hosted callers.
- Use the installed native CLI and existing provider adapters. Preserve explicit
  harness selection, `--provider none`, native sessions, and user configuration.

Done when the default supports daily work and passes native acceptance checks.

## Build an Rx harness on Pi

Use Pi's [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
or extensions. Compare runtime and distribution cost in an embedding or
subprocess prototype.

- Reuse Rx's provider configuration, credentials, catalogs, and capability data.
- Define the harness's entrypoint, settings, permissions, sessions, and packaging.
  Preserve the external Pi installation and its user-owned state.
- Reuse Pi's loop, tools, sessions, and compaction. Support repository instructions,
  streaming output, file editing, shell execution, cancellation, and steering.
- Verify task completion, failures, interruption, and session recovery through Rx.

Done when this harness is the maintainer's daily default, with reliable resume
and clear verification results.

## Consider an independent core

Optional. Stay on Pi indefinitely if it meets the project's needs. Revisit when
Pi limits required behavior or the owner chooses independent core ownership.

- Define the intended improvement and compare it with continued Pi maintenance.
- Build the execution loop and necessary tools, streaming, permissions,
  cancellation, recovery, and compaction, reusing Rx's provider infrastructure.
- Compare both implementations on the same tasks and failure scenarios.
- Plan session migration or coexistence and rollback before replacing the default.

Done when the replacement delivers the intended improvement while preserving
necessary functionality and user sessions.

## Tracking and verification

Update progress and decisions in place. Changes must pass `cargo test -p rx`,
`make check`, and affected DESIGN acceptance checks; agent changes also need
real task and recovery evidence.
