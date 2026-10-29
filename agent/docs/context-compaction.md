# Context compaction

This document is part of the normative [rx-agent design contract](../DESIGN.md).

## Invariants

| ID | Contract |
| --- | --- |
| RX-COMPACT-001 | Before each working request, Rx considers clearing eligible older tool results first. This includes requests after tools. Rx applies a clearing pass only if its estimated saving reaches the recent-history token budget. If eligible savings are smaller, Rx skips clearing and plans a summary. If the cleared projection still exceeds the budget, Rx summarizes it. Its ceiling is the lower of 80% of the selected window and the room left after pi-ai's safety reserve and an output allowance. A valid working measurement supplies the baseline plus an estimate of newer messages; otherwise Rx estimates message content without provider signatures or response metadata. Small windows reduce summary and recent-history budgets. An infeasible estimated summary plan leaves the original request to the provider; an estimate alone cannot prove that the original request will not fit. Fixed instructions and current input are never silently truncated. An empty history does not cause a summary request. |
| RX-COMPACT-002 | A clearing pass appends one versioned `context_prune` selection before changing the projection. A successful summary appends one `compaction` checkpoint with `version: 1` to the existing v1 log. It records the raw message count covered, including summary usage records, plus the summary, recent visible records, and their original source ranges. Invalid source metadata fails before log repair. Older checkpoints retain only a conservative coverage reference. Summary usage follows the [session log contract](session-log.md#summary-accounting). Only a complete, valid checkpoint changes the active context. Failed summaries or appends preserve the earlier projection. Raw history remains complete. Older Rx readers ignore this event and replay full history, which can overflow again. This is a downgrade limitation, not full compatibility. |
| RX-COMPACT-003 | Summaries use the selected model, endpoint, and credentials, request thinking off, and allow at most eight sequential requests. Rx sets the provider output limit and aborts streamed visible output that exceeds its conservative estimate. Subscription endpoints can omit the provider limit; hidden reasoning has no client-enforced hard limit. Rx covers the entire selected visible projection without silently dropping old input. Cleared results remain explicit omissions. Each substantive summary line cites original message ranges as `[log a-b]`. The citation range includes both endpoints. Repeated summaries preserve these original ranges. Rx rejects missing, malformed, out-of-source, and narrowed coverage references. Headings, empty placeholders, and pure Markdown markers do not need citations. Substantive text and table values still need valid sources. Syntax validation does not prove that a source supports a claim. Each chunk permits one citation correction if the eight-request limit leaves room for all remaining chunks. Failed attempts count toward this limit. Reaching the request limit fails without a checkpoint. Summary failures, empty output, output truncation, or tool calls cannot become checkpoints. Generic compaction replaces old native reasoning and tool protocol with a text summary and recent visible records. Recent images retain their image blocks. |
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
Changed instructions, endpoints, models, checkpoints, or clearing selections cannot reuse a mismatched measurement.
If the estimated fixed instructions or current input leave no room for a summary, automatic compaction sends the original request without truncation.
The provider can accept it or return an explicit overflow, which permits the existing single recovery attempt.
Manual compaction still reports an infeasible summary plan without changing the log.
Tiny windows that cannot hold pi's summary request can still reach the native working request.

Rx reuses pi-coding-agent 1.4.0 `estimateTokens` and `generateSummaryWithUsage`.
Rx converts source records to visible transcripts before the helper because its native serializer truncates tool results and omits images.
Summary requests carry a capped model output limit because the helper does not set `maxTokens` itself.
Summary requests select thinking off so a thinking allowance does not consume a small answer budget.
The working request retains the user's thinking level.
The prompt gives a character target that includes headings and source citations.
It asks the model to describe bulk sample data instead of copying it.
Rx also monitors streamed text and visible thinking, aborts output that exceeds the estimate, and rejects an over-budget final usage report.
An in-flight delta can arrive before cancellation takes effect.
Codex and ChatGPT subscription endpoints omit the provider output limit in pi-ai 1.4.0.
Their hidden reasoning cannot be counted during streaming; Rx does not promise a hard usage or billing cap.
Models that cannot disable reasoning can still use the provider's lowest supported effort or default.
Older images are described as omitted. Use `recall_log` with their source range when visual detail matters.
The complete original image, reasoning, and provider signatures remain in the raw log.

The strongest alternative is pi `AgentSession` with `SessionManager`.
That path also owns persistence, settings, and a session tree, which conflict with Rx's existing log owner.
A transient `transformContext` summary is smaller but loses its checkpoint after restart and repeats paid summary calls.
Rx therefore keeps its own persisted projection and uses pi's public helpers without importing private preparation code.
Revisit this choice if measured maintenance cost exceeds the value of owning context and session data.
Eight summary requests cap one operation, including rejected citation attempts.
Rx reserves one request for every planned chunk before it uses any spare request for a citation correction.
Each chunk permits at most one correction. The correction receives the same original sources and the last valid summary.
It receives the citation error and the allowed ranges, without the rejected draft.
Provider failures, cancellation, empty output, output limits, and tool calls do not trigger a correction.
A second citation failure ends the operation without a checkpoint. All measured attempts remain in the usage log.
Oversized archives fail with their original history intact.
No background compaction, separate summary model, native provider compaction, or cross-session memory is included.

## Clearing and source references

Clearing uses the existing recent-history budget and complete tool-call boundaries.
It protects fixed instructions, current input, unfinished tool calls, and the most recently completed tool group.
Narration or a later user message does not remove that group protection.
Only native tool results with one exact original source ordinal qualify.
Older checkpoint records with only coverage references do not qualify.
Rx chooses results from oldest to newest and skips replacements that do not reduce the estimate.
A clearing pass targets `ceiling - recent` to leave room for later turns, instead of stopping just below the ceiling.
The target reuses the existing recent-history budget. No fixed token threshold is added.
A clearing pass must save at least `recent` tokens. If candidates cannot supply that saving, Rx preserves the prefix and proceeds to summary planning.
Otherwise Rx commits the selected savings and checks the remaining pressure, even if protected content prevents the lower target.
One large result can supply this saving. The rule limits small prefix edits, not the number of records in an event.
It appends one selection, then installs `[cleared, log seq N]` as the result content.
The tool identity, call ID, error state, timestamp, and native call pairing remain intact.
Raw message lines never change.

The next working request uses the cleared projection without a summary if its remaining pressure fits.
Rx subtracts the estimated freed tokens from the valid working measurement plus estimates of newer messages.
Without a valid measurement, it subtracts from the content estimate.
Clearing never discards the triggering measurement in favor of a smaller pure estimate.
A summary failure leaves an earlier committed clearing pass valid.
Cancellation never replays the cleared tools.
Clearing emits no compaction activity and no estimated ACP usage.
It invalidates earlier working measurements. The next measured working response reports the changed context.
Load folds the same selections and replays measurements only after the latest projection change.

Source ordinals count complete `message` records, including summary accounting records.
Summary inputs repeat their source labels in each chunk of a long message.
Accounting records cannot serve as exact evidence sources.
The prompt lists allowed ranges and prohibits merging across missing ordinals.
For example, `[log 41-41] [log 43-43]` does not permit `[log 41-43]`.
A previous summary keeps its original cited sources instead of acquiring a new raw ordinal.
A legacy checkpoint carries only its full coverage range, such as `[log 1-120]`.
A new summary cannot narrow that range without new original evidence.

The strongest simpler alternative stores one coverage range for the whole summary.
That range locates the archive but makes each claim require a large reread.
Per-line citations reduce the range that `recall_log` needs to retrieve.
The strongest simpler correction policy uses prompts alone and fails on every invalid citation.
Real 16K sessions produced missing citations and ranges that crossed accounting records despite explicit source labels.
One bounded correction reduces manual retries while keeping the same total request limit and source boundary.
It can still fail or consume one extra request. Revisit it if first-attempt citations become reliable.
The model can still cite a real source that does not support its claim.
Read the cited content when that distinction affects the task.

OpenCode v1.19.5 and deepseek-harness dsh-v0.2.2-alpha.2 demonstrate clearing before summary decisions.
Rx reuses its existing log and small-window budgets instead of their fixed thresholds or session stores.
Clearing every eligible result is the strongest simpler batching alternative, but it removes more evidence from the working context.
Stopping at the ceiling retains more evidence but can rewrite an old prefix again after only a small addition.
The lower target balances these costs. If protected content dominates, it cannot guarantee headroom for another full turn.
Transient clearing is the strongest simpler persistence alternative, but load restores the discarded outputs.
The append-only selection preserves recovery without copying the original results.
Changing an old request prefix can invalidate a provider cache.
Rx does not promise cache savings. Revisit the policy if measured cost or latency rises on real long sessions.
