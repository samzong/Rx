# Supervisor sources and acceptance

This appendix supports the proposed [local supervisor](supervisor.md).
The comparison uses fixed upstream source, except Claude Code's current official documentation.
Source inspection proves the named version only. No upstream runtime or future supervisor received end-to-end acceptance here.

## Five-harness comparison

| Harness and inspected version | Dispatch and completion | Persistence and recovery | Cancellation and depth |
| --- | --- | --- | --- |
| Codex `rust-v0.163.0`, commit `83086188ae0614bd882818ff1aa23f3194962012` | Native child threads, spawn/follow-up tools, and a completion watcher. The watcher injects a parent fragment or sends V2 communication with `trigger_turn=false`. This is not proof of an automatic new parent turn. | Rollout-backed resume exists. V1 can reopen recorded descendants. V2 returns after resuming the selected thread, without that V1 descendant walk. | V2 interrupt targets an existing child runtime without loading it. Legacy spawn enforces `agents.max_depth`, default 1. V2 explicitly ignores that setting, so a universal Codex depth claim is false. |
| Claude Code official documentation, retrieved 2026-10-30. Repository changelog snapshot `b3f291d131924810e2b7713ededc144843a229d5`, version `2.1.314` | Foreground and background subagents. Background results reach the parent in a later completion notification. | Independent child JSONL transcripts support resume within the same session after restart. Default cleanup is 30 days. No durable exactly-once completion claim was established. | `TaskStop`, the task panel, and SDK stop requests have documented stop behavior. Current documentation describes default nesting of three layers, with `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` override. Implementation is not public in the inspected repository. |
| pi `v1.4.0`, commit `4a080252f06caf63a525d7873c5d94d3c23887e0` | The official subagent extension example spawns separate pi processes, streams progress, and returns completed output to the parent tool call. It is an extension example, not a durable supervisor or demonstrated idle-parent wake. | The example passes `--no-session`. Its children therefore do not supply durable child sessions through this path. Other pi session features do not repair that omission. | Abort sends SIGTERM and includes a delayed SIGKILL attempt. This code is not proof of descendant cleanup. No recursive depth guard was found in this example. Its parallel limits are distinct from depth. |
| OpenCode `v1.19.5`, commit `810c0eba1a7348036f8bdf61e6632d0c36c6876c` | The task tool creates or continues child sessions. Experimental background subagents return immediately and inject a synthetic result through a parent prompt. | Task IDs permit session continuation. Background jobs use an in-memory map. This inspected path does not establish durable job recovery or a transactional completion inbox. | Abort invokes child prompt cancellation and background-job cancellation. `subagent_depth` defaults to 1 in the task guard. Background execution requires an experimental flag. |
| deepseek-harness commit `ce7073d51254c26cd63b22a60835b8f948deb447` | Child activation returns an ID immediately. Parent delivery sends a completion notice after settlement. External children execute once and reject continuation. | Local cold resume requires persistence and Session query. The documented activation inbox and ownership graph are process-local. There is no durable parent mailbox, and accepted-but-unlogged prompts can be lost. | Disposal cancels the exact activation and waits for descendants, pending startups, and resource cleanup. Default tool delegation depth is 1. Direct service callers and explicit tool depth have separate rules. |

The absence statements above cover the inspected path only.
Missing runtime evidence is not an assertion that a harness lacks every equivalent capability.
The supervisor borrows explicit task identities and completion delivery, while owning the durable acceptance and crash boundary itself.
It does not import another harness's model loop or assume that native subagents obey its role policy.

### Codex source locations

- [Legacy spawn depth guard, `spawn.rs:73–79`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs#L73-L79) and [default depth, `config/mod.rs:265`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/config/mod.rs#L265).
- [Completion watcher, `control.rs:450–560`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/agent/control.rs#L450-L560), [rollout resume, `spawn.rs:1341–1408`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/agent/control/spawn.rs#L1341-L1408), and [V2 interruption](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/agent/control/interrupt.rs).
- [V2 ignores configured depth, `multi_agents_tests.rs:2485–2539`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/tools/handlers/multi_agents_tests.rs#L2485-L2539). This is an upstream regression test, not a test run performed for this proposal.

### Claude Code source locations

- [Foreground/background behavior and later result notifications](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background).
- [Nested subagent depth](https://code.claude.com/docs/en/sub-agents#let-subagents-spawn-their-own-subagents) and [resume, stop, transcript paths, and retention](https://code.claude.com/docs/en/sub-agents#resume-subagents).
- [Fixed changelog snapshot](https://github.com/anthropics/claude-code/blob/b3f291d131924810e2b7713ededc144843a229d5/CHANGELOG.md#L1-L3).

The changelog fixes the public version context, not the implementation of those features.
The official documentation is not versioned with that commit.
Its claims are documentation evidence for the retrieval date, not a binary test or a source-level audit of 2.1.314.

### pi source locations

- [Official subagent example, `README.md:3–12`](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/examples/extensions/subagent/README.md#L3-L12) and [parent output, `README.md:112–117`](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/examples/extensions/subagent/README.md#L112-L117).
- [`--no-session`, `index.ts:298`](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/examples/extensions/subagent/index.ts#L298), [abort handling, `index.ts:408–422`](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/examples/extensions/subagent/index.ts#L408-L422), and [parallel limits, `index.ts:34–35`](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/examples/extensions/subagent/index.ts#L34-L35).

### OpenCode source locations

- [Task inputs, flag and depth guard, `task.ts:24–117`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/tool/task.ts#L24-L117).
- [Child creation/continuation and result injection, `task.ts:136–263`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/tool/task.ts#L136-L263), [cancellation, `task.ts:276–359`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/tool/task.ts#L276-L359), and [process-local job state, `background-job.ts:120–166`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/core/src/background-job.ts#L120-L166).

### deepseek-harness source locations

- [Dispatch, depth, and cold resume, `README.md:45–61`](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/subagent/subagent/README.md#L45-L61).
- [Messaging and cancellation, `README.md:69–73`](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/subagent/subagent/README.md#L69-L73), [depth enforcement, `child-agent.ts:49–57`](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/subagent/subagent/src/child-agent.ts#L49-L57), and [recovery limits, `README.md:205–212`](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/subagent/subagent/README.md#L205-L212).

## Confer and Rx boundaries

Confer 0.2.4 is inspected at `cf15b5c55e785c02e684b641448ecb9a996857f4`.
Its [specification](https://github.com/samzong/confer/blob/cf15b5c55e785c02e684b641448ecb9a996857f4/docs/SPEC.md#L80-L124) persists room/seat identities but not delivery queues or answers.
Its [delivery implementation](https://github.com/samzong/confer/blob/cf15b5c55e785c02e684b641448ecb9a996857f4/src/mcp/delivery.rs#L434-L491) reports uncertainty when cancellation cleanup exceeds eight seconds.
Its [ACP client](https://github.com/samzong/confer/blob/cf15b5c55e785c02e684b641448ecb9a996857f4/src/adapters/acp.rs#L49-L54) collects text chunks only.
The [new/resume request construction](https://github.com/samzong/confer/blob/cf15b5c55e785c02e684b641448ecb9a996857f4/src/adapters/acp.rs#L131-L181) has no server injection.
Its [bridge](https://github.com/samzong/confer/blob/cf15b5c55e785c02e684b641448ecb9a996857f4/src/adapters/bridge.rs#L64-L94) rejects nonempty MCP server lists.
These facts limit v1 seats to execution targets without supervisor tools or full live tool events.

Rx is inspected at `3e62c8c90bffee95d73720c6bf9e17335e9b34ab`.
[ACP open/new/load](https://github.com/samzong/Rx/blob/3e62c8c90bffee95d73720c6bf9e17335e9b34ab/agent/src/acp.ts#L88-L175) passes the supplied server list to MCP setup.
[HTTP header conversion](https://github.com/samzong/Rx/blob/3e62c8c90bffee95d73720c6bf9e17335e9b34ab/agent/src/mcp.ts#L118-L122) and [transport construction](https://github.com/samzong/Rx/blob/3e62c8c90bffee95d73720c6bf9e17335e9b34ab/agent/src/mcp.ts#L174-L181) support the proposed injection.
The [MCP contract](../agent/docs/mcp.md) keeps failed servers optional and reports sanitized warnings.
A local no-model probe used ACP new and load with a mock HTTP MCP server.
Both connections sent authenticated initialization and tool discovery. The source process exited 0.
The probe used a synthetic provider credential only for local model selection and made no model request.
It did not exercise task dispatch, GUI rendering, or real-model cancellation.

No private usage records, conversation data, or deployment configuration support this public design.

## Upgrade contract

Version the HTTP protocol and database separately. Use SQLite `user_version` for ordered migrations.
Before migration, stop admission and create a consistent SQLite backup through the backup API.
Run the migration in one transaction and retain the backup until the migrated database opens successfully.
A newer unknown schema fails closed. An older executable never writes that database.
Recovery from migration failure uses the untouched backup, with the supervisor stopped.
Back up SQLite and referenced logs together.
Native logs stay unchanged. Missing logs reduce evidence without erasing task receipts.

## Wake receipt recovery

These rules apply to the frozen receipts of each wake, including reconciliation of an uncertain wake.
Each transition commits task state, session state, and receipt changes in one transaction.
Wake tasks never create their own inbox receipts.

| Observed outcome | Frozen receipts and automatic delivery |
| --- | --- |
| Success | Mark receipts delivered and release the active-task slot. Preserve any existing pause. |
| Failure or user cancellation | Clear claims, return receipts to pending, release the slot, and set a pause reason. This includes user cancellation before dispatch. |
| Confirmed system cancellation | Clear claims, return receipts to pending, and release the slot. Do not add a pause. Preserve any existing pause. |
| Uncertain, release unknown | Retain claims and block the target. Reject resumption until release is proved. |
| Release proved, delivery unknown | Retain claims. Atomically record release proof, unblock the target, and set the delivery-unknown pause. No later receipt can wake it automatically. |

System cancellation includes supervisor shutdown and system removal of a wake before dispatch.
Persist cancellation initiator and reason with the task's cancel intent.
A cancellation request without confirmed release follows uncertainty rules, regardless of its initiator.
A paused session remains paused after restart. The GUI shows its pause reason and pending receipt count, with retained claims shown separately.
Human continuation after proven release does not clear an automatic-delivery pause.

For released work, explicit GUI `inbox_resume` authorizes renewed automatic delivery.
In one transaction, return any frozen claimed batch to pending, clear its claims, and clear the pause.
Keep original receipt sequences. The scheduler selects those earlier receipts before later completions.
For an outcome-unknown wake, this action authorizes another attempt without changing the old task's uncertain outcome.
Neither release proof alone nor new receipts authorize that attempt.
A system-cancelled wake without an existing pause can be rebuilt after restart from its pending receipts.
Failure does not automatically retry, and no wake outcome can create a self-notification loop.

## V1 workflow acceptance

This PR supplies a design, so the following runtime workflow is not yet implemented or passed.
Use a scratch project, synthetic secrets, and a private data directory for implementation acceptance.
Record observed processes, native IDs, database rows, and protocol messages without publishing private content.

1. Select a project and an Rx role. Create an independent session and show its cwd, role revision, native ID, and advertised controls.
2. Ask it to read a fixture and run a bounded shell task. Show streamed text, tool input, progress, final output, and usage through ACP.
3. Dispatch a child with one operation ID. Submit it again, then submit changed input under that ID. Observe one execution and one conflict.
4. Complete two children while the parent is busy. Observe no concurrent parent prompt, one ordered wake batch, and independent GUI unread state.
5. Cancel a queued task and then a running sleep task. Observe no dispatch for the former and a stopped process group for the latter.
6. Close the GUI during work and reopen it. Observe the same supervisor instance, running task, final result, and unread receipt.
7. Kill the supervisor before send, after send, and after result receipt but before commit. Observe recoverable queued work or uncertain running work. Interrupt non-wake completion, uncertainty, and reconciliation transactions. Observe each receipt together with its result/slot release, target block, or result revision, never a partial commit.
8. Exercise every row in the wake receipt recovery table. While an earlier wake has unknown delivery, prove release and complete later tasks. Observe a pause with retained claims until explicit resumption returns the frozen batch ahead of later receipts. Shut down with queued and running wakes, then restart. Observe pending receipts without a new pause after confirmed system cancellation. Preserve existing pauses and display the GUI pause reason and pending count. No path creates a wake inbox receipt.
9. Test a Confer seat. Observe final delivery and cancellation evidence, unavailable nested dispatch, and no claim of streamed tool cards.
10. Reject a wrong token, a cross-session identity, a forbidden role, a depth/hop overflow, and a browser request. Search database files for synthetic runtime credentials.
11. Run migration, failed migration, newer-schema rejection, and backup restore. Observe preserved task IDs, result revisions, and native references.
12. Reconcile an uncertain task with proven release but unknown outcome. Observe that it stays uncertain, permits explicit continuation, and can be archived. Refuse archive while any queued/running task or uncertainty without release proof remains. Reopen the GUI and recover archived results and uncertainty evidence without replaying work.

Keep the existing ACP contract unchanged and perform these ACP client regression steps before an implementation release:

1. Launch `rxa acp` in a local ACP client project and read a known file. Observe its tool card and final answer.
2. Change model, thinking, and supported Fast controls. Reload the native session and observe that the client reapplies its choices.
3. Cancel a sleep task. Observe `cancelled`, tool cleanup, and the aborted log record.
4. Reopen the client and load the same native session. Observe history replay, current usage, and compression events through existing capabilities.

ACP clients consume ACP new/load/list, prompt/update/cancel, configuration options, and their documented metadata extensions.
ACP clients do not need access to the proposed database or supervisor MCP, and this document adds no ACP client integration.
A multi-machine proposal becomes justified when accepted work repeatedly requires another host or local-only scheduling causes measured manual transfers.
That proposal needs per-host execution ownership, authenticated remote control, directory mapping, and disconnected recovery.
Sharing a WAL file over a network filesystem is not that design.
