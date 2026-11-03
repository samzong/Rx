# Lody ACP extensions

This document owns RX-ACP-005 and RX-ACP-006 under the [agent design contract](../DESIGN.md).
Rx uses ACP SDK 2.0.2 and imports shared types and method names from
[`acp-extension-core` 0.3.0](https://github.com/LodyAI/acp-extension-core/tree/ea90d0b).
`src/acp-lody.ts` constructs `agentCapabilities._meta.lody` in one place.
Rx advertises only these capabilities:

| Capability | Declaration | Behavior |
| --- | --- | --- |
| Steering | `{version:1, transport:"request", upstreamTurn:"same", configPolicy:"active"}` | Inject user input into the active prompt with its current configuration. |
| Worktree project | `{version:1}` | Keep the logical project separate from the execution directory. |
| Usage | `{version:1}` | Report cumulative usage per model within an accounting scope. |
| Fork at turn | `{version:1}` | Copy history through a selected turn without changing its source. |
| Session activity | `{version:1}` | Report idle, running, or waiting for a user answer, with zero background tasks. |
| Rate limits | `{version:1}` | Push observed ChatGPT subscription quota windows. Other providers return no windows. |

## Steering

`_lody/session/steer` accepts `{sessionId, steerId, prompt: ContentBlock[]}`.
Rx validates content with the same `promptInput` conversion as `session/prompt`.
The selected model must support any supplied images.
Missing, idle, cancelled, or manually compacting sessions reject the request with `invalidRequest`.
A duplicate pending `steerId` also fails with `invalidRequest`.

Rx calls pi-agent-core 1.4.0 `Agent.steer()` without starting another ACP prompt.
The current model call or tool finishes before pi consumes the queue.
The queued message enters the append-only log as an `acp` user message.
`session/load` replays it as user input through the existing history conversion.

At each working-model stream call after request preparation, Rx matches pending input
against user messages by timestamp and complete content. Compaction can copy retained
messages, so object identity is not used. Pruning and history replay preserve these values.
At enqueue time, each steering timestamp exceeds every timestamp in the current context
and every steering timestamp allocated by the live controller. After load, the restored
context provides the timestamp floor even if the clock has moved backwards.
Identical queued inputs remain distinct.
A steering input can still match the prompt message before that message enters the context.
This requires identical content and timestamps allocated in the same millisecond.
The match adds no identifier to model-visible content.
Rx sends `_lody/session/steer_applied {sessionId, steerId}` and returns `{outcome:"injected"}`.
An enqueue or `message_end` event alone does not prove that the model request contains the message.
Cancellation, connection closure, and prompt completion clear the queue and reject undelivered requests.
An active ordinary ACP prompt can queue input before the agent loop starts.
Manual `/compact` does not accept steering. Pending messages cannot enter a later prompt.
The existing RX-CANCEL-001 process and request cancellation rules still apply.

## Startup configuration

`session/new` and `session/load` accept `_meta.lody.sessionConfig` with
`{version:1, modelId?, configOptionValues}`.
Rx applies model selection before thinking and Fast, before it builds the first snapshot or agent.
A nonempty string `modelId` wins over `configOptionValues.model`.
The existing `changeSessionConfig` function owns credential checks, thinking validation, model clamps, and Fast resets.
Fast also requires the client's boolean configuration capability.
A saved `fast:false` is ignored when the selected model does not support Fast.
`fast:true` still requires a supported model.

Unknown configuration keys do not affect session creation.
A malformed `modelId` does not discard valid option values.
A malformed option map does not discard a valid `modelId`.
Invalid values for supported options fail with the existing `invalidParams` path.
Without version 1 startup configuration, Rx uses current launch defaults.
Startup configuration does not persist model selections in the session log.

## Logical project identity

`session/new` and `session/load` accept
`_meta.lody.worktreeProject: {version:1, originProjectPath}`.
The origin must be an absolute path without NUL characters.
Rx records a changed origin in a version 1 `session_metadata` log record.
The record has `at` and `originProjectPath` fields and does not consume a message ordinal.
Loading without this metadata preserves the saved origin.
Loading with a different origin appends a replacement record without rewriting history.
Old readers ignore this record. New readers still accept logs without it.

`session/list` returns the origin as `_meta.lody.worktreeProject` on each applicable session.
A `cwd` filter matches either the execution directory or the saved logical origin.
The returned `cwd` remains the execution directory.
Load validation, tools, AGENTS.md discovery, and skills discovery still use that execution directory.
Lody uses the origin for project membership. It does not request a second source of project instructions.
Using the origin for instruction discovery would change RX-CONTEXT-001 and RX-SKILL-001 without this requirement.

## Usage

Rx advertises `agentCapabilities._meta.lody.usage: {version: 1}` during `initialize`.
After each live model response, Rx sends `_lody/session/usage_update` with these fields:

- `sessionId` identifies the ACP session.
- `usage` contains the latest request's measured token buckets and known cost.
- `modelUsage` contains cumulative usage under `provider/model` keys.
- `delta.usage` and `delta.modelUsage` contain the new contribution since the previous notification.
- `_meta.lody.usageScopeId` identifies the current accounting lifetime.

Each new or loaded session starts a random scope, even within the same process.
Replay sends no extension usage and adds no historical requests to the new scope.
Lody accounts for each scope separately. Compaction and model changes keep the active scope and cumulative totals.
Counters include tool-loop requests, failed retry attempts, successful retries, and context-summary requests, including rejected summaries.
Notifications share the ordered ACP output queue and finish before the prompt response.
A failed notification aborts the running work through the existing connection-failure path.

The token buckets are disjoint. Input excludes cache reads and writes.
Output excludes reasoning tokens when pi-ai reports a reasoning breakdown.
`cacheCreationInputTokens` includes all cache writes, including the one-hour subset.
`costUSD` uses pi-ai's reported catalog estimate in USD, not an invoice.
`rx-provider` marks placeholder prices for handoff models that lack matching pi-ai metadata.
Rx omits their `costUSD` from request snapshots, cumulative totals, and deltas.
Catalog prices remain known, including real zero prices. An absent or invalid cost also stays absent.
If any request for a model has unknown cost, that model's cumulative cost and later delta costs stay unknown within the scope.
Other models retain their known costs. Token accounting continues in either case.

Standard `usage_update` retains RX-ACP-004: the latest working-context measurement and its context window, without costs.
Summary requests do not update that context measurement.
Clients must not add standard context measurements to cumulative usage or add `delta` to the same `modelUsage` snapshot twice.

The wire contract follows [acp-extension-core 0.3.0](https://github.com/LodyAI/acp-extension-core/blob/ea90d0b23d4f850c66c0f542f53cbc596ef2c62f/src/usage.ts).
Rx imports the core usage types and retains its internal accumulator.
The strongest alternative is the core `SessionUsageAccumulator`, which merges repeated operation snapshots monotonically.
Rx receives one completion per request directly from its request owners, so it needs only cumulative model buckets.
If a future source repeats or corrects completion snapshots, add operation identity before accounting for that source.

The core package depends on SDK `^1.4.0` and exposes TypeScript source through its `types` field.
The lockfile includes both SDK versions. The core package imports SDK types only, so the Bun runtime bundle uses SDK 2.0.2 only.
Core source uses syntax that Node cannot strip. TypeScript checks the complete dependency graph without `erasableSyntaxOnly`.
The typecheck command also applies Node's `stripTypeScriptTypes` in strip mode to all Rx source, script, test, and eval files.

For Lody acceptance, start an Rx session and complete two prompts.
Make sure that the session's token statistics increase after the second prompt.
For models with known pi-ai prices, make sure that the cost increases too.
For handoff models with placeholder prices, make sure that request snapshots, cumulative totals, and deltas omit `costUSD`.
Load the session and complete another prompt. Prior scopes remain separate from the new scope.

## Forks and turn identity

ACP SDK 2.0.2 exposes `session/fork` through its public `/unstable` entry point. The dependency version does not change.

Initialization declares `sessionCapabilities.fork: {}` and `_meta.lody.forkAtTurn: {version: 1}` under `agentCapabilities`.
At the start of each ACP prompt, Rx appends a versioned `turn` record and sends an empty `agent_message_chunk`.
The update carries `_meta.lody.turnId`. Load replays the same identity after the user message and before its response.
The `/compact` command and blocked prompts also get distinct boundaries. CLI prompts and manual compaction write the same records.

`session/fork` accepts `sessionId`, `cwd`, optional `mcpServers`, and optional `_meta.lody.forkAtTurn: {version: 1, turnId?}`.
The selected turn is inclusive. Rx copies its user input, response, tools, and control records up to the next turn boundary.
Without `turnId`, Rx copies all complete source records. An unknown turn is an error.
The new header supplies a new session ID, creation time, and requested working directory.
The source stays unchanged. The fork returns the complete configuration snapshot and can accept a prompt immediately or after load.

Fork reads one snapshot of the source, including when its process is active.
Only newline-terminated records count. Rx never opens the source for repair or takes its writer lock.
An unfinished tool call gets an error result in the copy under RX-RESUME-001. Fork never repeats the tool.
Checkpoints and clearing records before the boundary keep their original ordinals and projection.

If this process owns the source session, fork inherits its current model, thinking level, and Fast value.
Client `_meta.lody.sessionConfig` values override that selection, with model applied before thinking and Fast.
For a source in another process, the client supplies its current choices through `sessionConfig`.
Without that metadata, a separate process uses its launch defaults because logs do not store session choices.
Lody sends `sessionConfig` when it starts the fork process. MCP connections follow the same path as new and load.

Lody reads turn identity from `update._meta.lody.turnId` and stores it on the active assistant entry.
Its fork service copies history through the selected assistant entry, then sends that identity as `forkAtTurn.turnId`.
Both capability declarations are required before Lody starts an anchored fork.

## Plans and elicitation

RX-ACP-008 owns task lists and structured questions.
The Plan control excluded by RX-ACP-001 means the `plan_mode` configuration option.
It does not prohibit standard `plan` session updates.
These tools do not change tool permissions or add agent-side Lody capability declarations.

## Task lists

The `todo` tool accepts `entries`, the complete list of tasks.
Each entry has `content`, `status` (`pending`, `in_progress`, or `completed`), and optional `priority` (`high`, `medium`, or `low`).
The default priority is `medium`. An empty list clears the task list.
The tool replaces the list and does not execute tasks.

The tool result stores `{version: 1, entries}` in `details` in the existing session log.
ACP emits `sessionUpdate: "plan"` after each successful result.
Load replays every snapshot at its original position after that tool result.
This preserves the plan for each historical turn in Lody.
Failed or interrupted tool calls do not update the plan.
The CLI and REPL also expose `todo` and print its checklist to stderr.

Whole-list replacement follows Codex, OpenCode, and deepseek-harness.
The strongest alternative is the incremental `list`/`add`/`toggle`/`clear` interface in Lody's pi adapter.
Replacement reuses the result log and avoids mutable task identifiers or a second state store.
For unusually large task lists, repeated full lists cost more input tokens. Revisit incremental changes if measured task-list traffic dominates a turn.

## Structured questions

Rx registers `ask_user` only when the ACP client declares `clientCapabilities.elicitation.form`.
The CLI and REPL do not register it. The model asks questions in its text response there.
A terminal form is the strongest alternative. It requires another input and cancellation lifecycle, which these clients do not need.

`ask_user` accepts `questions`, a list of 1 to 8 questions.
Each question has a unique `id`, `question`, and optional `header`, `options`, `multiSelect`, and `allowCustomAnswer`.
Each option has a unique `label` and optional `description`.
Omit options for free text. `multiSelect: true` requires options.
Custom answers are enabled by default. Set `allowCustomAnswer: false` to restrict a choice to its options.

Each question maps to a generated field key, independent of its model-supplied ID.
Single choices use a string with `oneOf`. Multiple choices use an array with `items.anyOf`.
Free-text questions use a string. Optional custom fields carry `_meta.lody.elicitation.customAnswerFor`.
If the client declares `_meta.lody.elicitation: {version: 1, answerNotes: true}`, optional note fields carry `noteFor`.
Lody metadata is version 1. Request metadata sets `autoResolveAfterSeconds: null`, so Rx does not time out unanswered questions.

Accepted results return `{answers: {<id>: <string or string[]>}, notes?: {<id>: <string>}}`.
A custom answer replaces the selected answer. Skipped fields stay absent.
Decline or cancel returns `{cancelled: true}` and lets the model continue.
Invalid supplied answers fail the tool instead of fabricating a user answer.
Cancelling the turn aborts the tool and sends protocol cancellation to the client.
The turn finishes even if the client ignores cancellation. A late answer does not enter the log or another turn.
Connection closure uses the same agent abort path under RX-CANCEL-001.

## Lody acceptance

Use a Lody Rx configuration that starts the binary built from this checkout.
Ask Rx to create a two-step task list and mark its first task in progress.
The task panel must show both tasks with the expected status. Lody does not render priority; check it in the session log.
Complete the tasks, reopen the session, and make sure that the historical plan appears without executing the tools again.

Ask Rx to call `ask_user` with a choice, a multiple choice, and a free-text question.
The form card must show the questions. Answer them and add a note.
The model must receive the answer and note and finish the turn.
Start another question and cancel the turn. The session must accept another prompt without waiting for the unanswered card.
Also select Cancel on the card. The model must receive `{cancelled: true}` and continue.
Lody form cards offer Submit answers and Cancel. They do not expose decline, which the unit tests cover.

## Session activity

Rx advertises `sessionActivity: {version: 1}` and sends `_lody/session/activity_update`.
Every update contains `version: 1`, `sessionId`, `state`, and `backgroundTaskCount: 0`.
Rx has no native background tasks that wake the agent. A shell process that a tool leaves behind does not wake the agent.

The stdio transport writes the successful new, load, or fork response before it writes the first idle update.
This order matters because Lody ignores activity updates until it assigns its ACP session ID.
SDK 2.0.2 does not expose a handler callback after a response write.
A timer is a simpler alternative, but it cannot bind the update to that write.
The transport uses the request ID to pair each successful establishment response with its idle update.
Failed establishment sends no idle update. Resume remains unsupported.

An accepted prompt sends running before the turn starts, including `/compact`.
While `ask_user` waits for an elicitation answer, Rx sends requires_action before the request and running after the answer.
Cancellation skips the return to running. Success, cancellation, provider failure, and compaction failure finish with idle.
The turn owner drains its ordered output queue before the final idle update and prompt response.
Rx does not request tool permissions under RX-ACP-001, so there is no permission wait to report.

Lody uses this level to distinguish observed idle from unknown native activity.
For acceptance, create an automation with a settled condition on an Rx session, then complete a tool-using prompt.
The automation must trigger after the turn instead of blocking with `native_activity_unobserved`.
Cancel another turn and answer an `ask_user` question. Each completed turn must settle again.

## Subscription rate limits

Rx advertises `rateLimits: {version: 1}` for push only.
For working and summary requests, pi-ai 1.4.0 `onProviderStreamEvent` supplies `codex.rate_limits` events over WebSocket or SSE.
`onResponse` also supplies SSE headers. Rx preserves pi-ai's default WebSocket-first transport and cached-context continuation.
Only `openai-codex` with API `openai-codex-responses` at `https://chatgpt.com/backend-api` supplies quota.
Other providers, including Tokener, emit no quota push and return `{rateLimits: []}` to queries.

The parsers follow [Codex 0.164.0 headers and events](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/codex-api/src/rate_limits.rs#L22-L178).
Events read top-level `rate_limits.primary` and `secondary`, ignoring `additional_rate_limits`.
Their `used_percent`, `window_minutes`, and `reset_at` match header percentage, rolling minutes, and Unix seconds.
Event limit IDs use normalized `metered_limit_name`, then `limit_name`, else `codex`.
Both paths convert minutes to seconds. Invalid percentages omit windows; missing duration or reset time stays null.
Wallet, plan, account, and model limits are not inferred.

Each valid observation pushes `_lody/rate_limits/update` with its timestamp and stays in memory.
The retained query handler returns it only for a known session with a matching subscription selection.
Missing or unknown session IDs and unmatched filters return empty data. Queries preserve observation time without network requests.

Lody a3510eab queries initialize a separate process without a session, which cannot read this cache.
Omitting `query` skips those refresh subprocesses without blocking push or quota display.
Quota enters through active-turn pushes. Lody expires automation capacity observations after five minutes.
Active querying of the ChatGPT usage endpoint remains future work.

For acceptance, complete a ChatGPT subscription prompt and inspect Lody's quota display. Expect windows matching the provider observation.
Repeat with Tokener and expect no quota windows. A fresh process has no observation until a response supplies quota.

## Other limits

Rx does not advertise permission modes or permission requests under RX-ACP-001.
Subagents, goals, prompt suggestions, and session resume, close, or delete remain outside this change.
