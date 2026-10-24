# Rx

Rx is a personal coding agent written in TypeScript. It reuses the agent loop
from `@earendil-works/pi-agent-core` and model access from
`@earendil-works/pi-ai`; this repository owns the tools, session log, CLI, and
ACP server.

- Before changing Rx, read `docs/DESIGN.md`: it owns invariants, ownership,
  change authority, and acceptance requirements. Identify the affected
  invariant IDs and trace `input -> agent -> tools -> session log -> output`.
- Use Node 22.19 or later (CI uses Node 24) and pnpm. Source runs directly as `.ts` through Node type
  stripping; there is no build step. Keep syntax erasable.
- `make check` is the CI gate: `pnpm audit`, `tsc --noEmit`, and `node --test`.
  Changes to agent, tool, log, or ACP behavior also need the real-model checks
  in `docs/DESIGN.md`.
- Pass provider credentials only through the environment of the process under
  test. Never print, log, or commit them.
- Eval tasks and session logs are private and stay outside the repository.
- Keep `"private": true`; Rx is not published to npm. The owner chooses
  version bumps and releases.
- Never add code comments or doc comments. Preserve unrelated work.
- `.local/` is scratch and is not an architecture source.
