# pi upgrade surfaces

Read this when a pi upgrade looks warranted, before finalizing the report.

## Lockstep set

The pi packages resolve at one version: pi-ai, pi-agent-core, pi-coding-agent,
pi-codemode, pi-mcp, pi-tui, pi-telemetry. pi-agent-core pins pi-ai exactly;
pi-coding-agent pins all five exactly. A bump means all seven move to the same
tag. The ACP SDK pin (`@agentclientprotocol/sdk`) is separate and is currently
2.0.2.

## Version-sensitive surfaces

| Surface | Pinned value | Check on upgrade |
| --- | --- | --- |
| `agent/DESIGN.md` RX-ACP-001 | ACP SDK 2.0.2 configOptions | SDK changes require re-checking session configuration behavior |
| `agent/DESIGN.md` RX-ACP-003 + `src/acp-fast.ts` | Codex 0.163.0 catalog and the seven Fast model IDs | re-verify the model list and endpoint |
| `agent/DESIGN.md` + `src/agent.ts` + `src/transport-errors.ts` | pi-ai 1.4.0 `streamSimple`/`onPayload` fetch hook | run a payload probe to confirm Fast forwarding |
| `src/acp.ts` | `sourceVersion: "pi-ai/1.4.0;codex/0.163.0"` | update the string in `_meta.lody.modelCapabilities` |
| `src/transport-errors.ts` | `FETCH_APIS` set | add any new HTTP adapter pi-ai introduced |
| `src/rx-provider.ts` | `APIS` map | update if pi-ai renames api entrypoints |

## Verification loop for an approved upgrade

1. Bump all `@earendil-works/pi-*` to the target version in `agent/package.json`.
2. `cd agent && pnpm install` to regenerate the lockfile.
3. `make agent-check` (pnpm audit, typecheck, node --test) and `make agent`
   (Bun compile must still produce the single-file binary).
4. Real-model acceptance per `agent/DESIGN.md`: `rx-agent -p "<tool task>"`
   and `node scripts/acp-smoke.ts [provider/id]`, with a scratch `RX_HOME` and
   the provider key only in that run's environment.
5. Update every version pin the bump touched, including `agent/DESIGN.md`
   numbers and the `sourceVersion` string.
