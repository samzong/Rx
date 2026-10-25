# Context compaction

This document is part of the normative [rx-agent design contract](../DESIGN.md).

## Invariants

| ID | Contract |
| --- | --- |
| RX-COMPACT-001 | Automatic compaction is enabled before each working request, including requests after tools. Its ceiling is the lower of 80% of the selected window and the room left after pi-ai's safety reserve and an output allowance. A valid working measurement supplies the baseline plus an estimate of newer messages; otherwise Rx estimates message content without provider signatures or response metadata. Small windows reduce summary and recent-history budgets. An infeasible estimated summary plan leaves the original request to the provider; an estimate alone cannot prove that the original request will not fit. Fixed instructions and current input are never silently truncated. An empty history does not cause a summary request. |
| RX-COMPACT-002 | A successful compaction appends one `compaction` checkpoint with `version: 1` to the existing v1 log. It records the raw message count covered, summary, and recent visible records. Only a complete, valid checkpoint changes the active context. Failed summaries or appends preserve the earlier projection. Raw history remains complete. Older Rx readers ignore this event and replay full history, which can overflow again. This is a downgrade limitation, not full compatibility. |
| RX-COMPACT-003 | Summaries use the selected model, endpoint, and credentials, request thinking off, and allow at most eight sequential requests. Rx sets the provider output limit and aborts streamed visible output that exceeds its conservative estimate. Subscription endpoints can omit the provider limit; hidden reasoning has no client-enforced hard limit. Rx covers the entire selected source without silently dropping old input. Reaching the request limit fails without a checkpoint. Summary failures, empty output, output truncation, or tool calls cannot become checkpoints. Generic compaction replaces old native reasoning and tool protocol with a text summary and recent visible records. Recent images retain their image blocks. |
| RX-COMPACT-004 | Only an explicit context overflow with no delivered content or tool calls in the failed response permits one recovery attempt. A smaller checkpoint must be committed first. Recovery continues from that projection and never replays tools. Other errors and a second overflow end the run. Cancellation ends the activity and prevents further requests. A completed checkpoint remains valid after cancellation. |
| RX-COMPACT-005 | The REPL and ACP accept `/compact` only as an exact plain-text command without arguments. Print mode sends its input as a normal prompt. ACP advertises the command on new and load. Each compaction reports one lifecycle: standard ACP updates when the client declares support, otherwise a synthetic tool activity with Lody context-compaction metadata. Every start ends as completed or failed, including cancellation. This activity is not an executable tool. |

## Mechanism

Rx owns the budget and checkpoint projection through pi-agent-core `prepareRequest`.
The returned loop context and the Agent state both change after the log append succeeds.
The current system message and tool declarations remain independent of the checkpoint.
Load rebuilds current instructions under RX-CONTEXT-001 and RX-RESUME-001.

The budget reserves pi-ai 1.4.0's 4096 safety tokens and an output allowance of 10% of the window, with a 256-token floor.
The allowance cannot exceed the selected model's output limit.
The summary limit is the lower of 4096 tokens, the model output limit, and 10% of the request ceiling.
Recent history targets the lower of 20000 tokens and 25% of the ceiling.
These are initial limits. Token estimates include text, images, instructions, and tools, but are not exact tokenizer counts.
The fallback uses pi's content estimate with a Unicode adjustment and excludes signatures, usage objects, timestamps, and response metadata.
The conservative text estimate used to bound summary chunks and streamed output is independent of the working-context estimate.
Only working responses from the current agent instance supply measured budget baselines.
A valid baseline replaces the full estimate; it is not the maximum of those two values.
The baseline must match the model, API, endpoint, and current system messages and tool declarations.
Changed instructions, endpoints, models, or checkpoints cannot reuse a mismatched measurement.
If the estimated fixed instructions or current input leave no room for a summary, automatic compaction sends the original request without truncation.
The provider can accept it or return an explicit overflow, which permits the existing single recovery attempt.
Manual compaction still reports an infeasible summary plan without changing the log.
Tiny windows that cannot hold pi's summary request can still reach the native working request.

Rx reuses pi-coding-agent 1.4.0 `estimateTokens` and `generateSummaryWithUsage`.
Rx converts source records to visible transcripts before the helper because its native serializer truncates tool results and omits images.
Summary requests carry a capped model output limit because the helper does not set `maxTokens` itself.
Summary requests select thinking off so a thinking allowance does not consume a small answer budget.
The working request retains the user's thinking level.
Rx also monitors streamed text and visible thinking, aborts output that exceeds the estimate, and rejects an over-budget final usage report.
An in-flight delta can arrive before cancellation takes effect.
Codex and ChatGPT subscription endpoints omit the provider output limit in pi-ai 1.4.0.
Their hidden reasoning cannot be counted during streaming; Rx does not promise a hard usage or billing cap.
Models that cannot disable reasoning can still use the provider's lowest supported effort or default.
Older images are described as omitted and require a new read when visual detail matters.
The complete original image, reasoning, and provider signatures remain in the raw log.

The strongest alternative is pi `AgentSession` with `SessionManager`.
That path also owns persistence, settings, and a session tree, which conflict with Rx's existing log owner.
A transient `transformContext` summary is smaller but loses its checkpoint after restart and repeats paid summary calls.
Rx therefore keeps its own persisted projection and uses pi's public helpers without importing private preparation code.
Revisit this choice if measured maintenance cost exceeds the value of owning context and session data.
Eight summary requests cap one operation. Oversized archives fail with their original history intact.
No background compaction, tool-result pruning, separate summary model, native provider compaction, or cross-session memory is included.
