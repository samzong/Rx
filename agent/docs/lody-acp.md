# Lody ACP extensions

This document owns RX-ACP-005 under the [agent design contract](../DESIGN.md).
Rx uses ACP SDK 2.0.2 and the Lody extension contract from
[`acp-extension-core` 0.3.0](https://github.com/LodyAI/acp-extension-core/tree/ea90d0b).
`src/acp-lody.ts` constructs `agentCapabilities._meta.lody` in one place.
Rx advertises only these capabilities:

| Capability | Declaration | Behavior |
| --- | --- | --- |
| Steering | `{version:1, transport:"request", upstreamTurn:"same", configPolicy:"active"}` | Inject user input into the active prompt with its current configuration. |
| Worktree project | `{version:1}` | Keep the logical project separate from the execution directory. |

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

## Cumulative usage

This capability is reserved for a later PR and is not advertised here.
Standard working-context measurements keep RX-ACP-004 semantics.

## Forks and turn identity

These capabilities are reserved for a later PR and are not advertised here.

## Plans and elicitation

These capabilities are reserved for a later PR and are not advertised here.
The Plan control excluded by RX-ACP-001 means the `plan_mode` configuration option.
It does not prohibit standard `plan` session updates.

## Other limits

Rx does not advertise permission modes or permission requests under RX-ACP-001.
Subagents, goals, prompt suggestions, rate limits, and session resume, close, or delete remain outside this change.
