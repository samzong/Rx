# Local supervisor for a future Rx GUI

Status: proposed. This specifies a future control layer.
It adds no executable, protocol change, migration, or GUI framework selection.
The [source comparison](supervisor-evidence.md) records the inspected versions and evidence limits.

## Scope and ownership

The supervisor owns scheduling, role policy, session bindings, and completion delivery.
It runs Rx sessions directly through `rxa acp`, with ACP v1 over stdio.
For other harnesses, it supervises unchanged `confer mcp` and its existing adapters.
Confer remains an execution adapter with process-local delivery state. It does not become the task authority.
The duo skill keeps its existing Confer use.

One supervisor owns one local SQLite database. Agent logs remain authoritative for conversation content.
The database stores task input, bounded completion results, and native log references, but no transcript copy.
The GUI mutates state only through the supervisor.
Daily work can continue in Lody. There is no automatic import or synchronization of Lody tasks.
Multi-machine execution, schedules, sharing, mobile access, and a UI framework are outside v1.

Use a Rust crate at `supervisor/`, with a future `rx-supervisor` binary.
At implementation, add a Cargo workspace for the root package and this crate.
Keep the launcher package intact, including `publish = false` and its current binary aliases.
Rust combines process ownership, SQLite, and local IPC in one binary.
The strongest alternative is a separate TypeScript package using the existing ACP SDK.
That saves protocol adaptation work, but adds a second runtime distribution contract for a persistent controller.
The controller must outlive both the GUI and agents.
An implementation spike must establish Rust ACP and MCP compatibility before release.

This new surface stays outside launch planning and `agent/`.
`docs/DESIGN.md` continues to own RX-NATIVE-001, RX-OWN-001, RX-SECRET-001, RX-CONCURRENCY-001, and RX-AGENT-001..004.
Add supervisor ownership there at implementation. Agent log ownership stays unchanged.
`agent/DESIGN.md` continues to own RX-ACP-001..004, RX-MCP-001, RX-CANCEL-001, RX-LOG-001..003, and RX-RESUME-001.
This proposal changes none of those contracts.

The launcher path stays `request -> install/discover -> plan -> configuration -> exec`.
Call `rxa acp` with explicit routing and noninteractive installation disabled.
It preserves the user's harness homes and uses the existing environment-only provider handoff.
A missing binary or credential is a setup failure.
After exec, the path stays `input -> agent -> tools -> session log -> ACP output`.
The supervisor adds task identity and delivery state, without another model loop.

## Local interface and lifetime

The GUI discovers or starts one detached supervisor per user and data directory.
An OS-held exclusive lock decides ownership.
The winner publishes an atomic `endpoint.json` containing the loopback port, protocol version, instance nonce, and GUI bearer token.
Competing starters connect to the winner without opening SQLite.
Bind `127.0.0.1` on an OS-selected port, with these routes:

| Route | Consumer | Contract |
| --- | --- | --- |
| `/v1/control` | Native GUI transport | JSON-RPC requests for catalog, sessions, tasks, inbox, reconciliation, and explicit shutdown. |
| `/v1/events` | Native GUI transport | SSE notifications for state changes and live ACP events. Reconnect requires a database snapshot. |
| `/mcp` | Injected Rx MCP client | Streamable HTTP MCP with session-scoped authority. No GUI or shutdown methods. |

Use HTTP because rx-agent accepts HTTP MCP and arbitrary headers.
A Unix socket for GUI control is the strongest alternative and gives stronger peer-credential checks on Unix.
V1 avoids a second transport while agents still need HTTP.
The GUI keeps tokens in its native transport, outside page URLs and web content.
Reject unauthenticated requests, unexpected Host values, and browser Origin headers. Do not enable CORS.
Tokens never appear in query strings, process arguments, telemetry, or request logs.

Store state under the platform user-data directory, in `Rx/supervisor` on macOS and Windows and `rx/supervisor` on Linux.
On macOS this means `~/Library/Application Support/Rx/supervisor`.
Use `0700` directories and `0600` database, WAL, SHM, endpoint, lock, and backup files on Unix.
Use equivalent user-only ACLs on Windows. Reject symlinks and incorrectly owned state paths before opening them.
Rotate the GUI token and instance nonce on every start. Remove a stale endpoint only after acquiring the lock.
Never write provider credentials or session bearer tokens to SQLite.

Closing the GUI disconnects its event reader and leaves tasks running.
Reconnection restores task state and live events. Mark missed live output as a gap until idle ACP load replays recorded history.
Never load a session concurrently with its running prompt.
An explicit supervisor shutdown stops admission, cancels queued work, and waits for running work to stop or become uncertain.
Then it closes Confer and ACP processes, checkpoints SQLite, and releases the lock.
V1 has no login service or execution guarantee across logout, reboot, or daemon failure.
Reopening the GUI restarts a stopped supervisor and performs recovery before admission.
A detached process satisfies close-and-reopen use. Reconsider an OS service if unattended restart becomes necessary.

Same-user process access is not a sandbox boundary.
RX-PERM-001 permits agent shell tools to read user files, including supervisor runtime files.
Per-session tokens prevent accidental identity confusion and reject untrusted local HTTP clients.
They cannot stop a malicious same-user agent from impersonating the GUI.
Stronger adversarial isolation requires a separate OS identity or sandbox, outside this proposal.

## Sessions, roles, and dispatch

Read the user-owned role catalog from the supervisor data directory.
Roles define backend, controls, allowed target roles, depth, and project access.
Sessions freeze role revisions and launch choices. Role edits affect new sessions only.
Catalog absence or invalid policy disables dispatch. Model instructions cannot relax a server-side rule.
V1 permits direct children by default. A role can explicitly allow deeper delegation.
Every request also carries a server-derived causal hop count, capped at 16 across dispatch and automatic wake turns.
A human continuation starts a new causal chain. A new agent operation ID does not reset that chain.

The GUI selects a project and role, then creates an independent native session.
A new session does not imply a new Git worktree. The GUI shows the exact working directory before execution.
The supervisor neither creates worktrees nor infers write isolation.
It serializes prompts per native session. Callers remain responsible for exclusive file ownership across sessions.
Do not expose a permission control that the selected backend cannot enforce.

For Rx, reserve the supervisor session ID before ACP `session/new`.
Inject a server named `rx-supervisor` through `mcpServers`, with `type: http`, the loopback URL, and an Authorization header.
Its random capability maps in memory to the reserved session, project, role revision, and causal context.
Bind the returned native session ID before accepting dispatch from that session.
On `session/load`, rotate that capability, inject it again, and reapply saved model, thinking, and Fast choices through advertised controls.
Rx's ACP server accepts HTTP headers through `src/mcp.ts` and advertises HTTP support, with legacy SSE disabled.
A no-model probe of new and load observed authenticated `initialize` and `tools/list` on both connections.
This proves injection and discovery only.

Expose these MCP tools with bounded JSON input and output:

| Tool | Behavior |
| --- | --- |
| `role_list()` | Return only roles reachable from the authenticated session. |
| `task_create(role, prompt, operationId, targetSessionId?)` | Commit a queued task and return its ID and state immediately. Omit the target to create a child session. |
| `task_status(operationId)` | Return the caller's task and result reference without waiting for completion. |
| `task_cancel(operationId)` | Request cancellation of a task owned by the caller. Return requested and observed state separately. |

Derive caller, project, policy, and hops from authentication and the active turn.
Continuation can target only a direct child with the same recorded role and project.
Cross-project dispatch, ancestor cancellation, and arbitrary session targeting are rejected.
Cancellation of the dispatching prompt does not cancel work already committed by `task_create`.
The caller releases its current turn after dispatch. Completion starts a later prompt through the wake mechanism.
The tool cannot force turn release. Reject agent requests outside an active task.

Current Confer cannot inject a supervisor MCP server into a seat.
Its public seat and send inputs have no such field, native ACP requests use an empty server list, and bridges reject nonempty lists.
Confer seats are execution targets only, without supervisor dispatch tools.
Do not write global harness configuration or put capability tokens into prompts to work around this limitation.
Resume a seat through its recorded room and seat identity.
Do not infer that a native harness's own subagents follow supervisor role or depth policy.
Policy covers supervisor tools only. Report native delegation separately.

Confer also collects text chunks internally and returns delivery results rather than a public stream of tool events.
Confer seats show task status and final output, without tool cards or usage.
The full streaming-tools acceptance path uses Rx ACP sessions.
Non-Rx streaming or nested dispatch needs a later capability decision.

Rx currently treats MCP startup failures as optional.
A failed supervisor MCP connection must remain visible as an ACP warning, with dispatch unavailable for that session.
`session/new` success does not prove readiness.
Its MCP endpoint records successful tool discovery against the bound capability before the GUI enables dispatch.
Tools do not fall back to prompt parsing. A later successful load can restore dispatch.

## Persistent model and transactions

Use three logical tables, SQLite foreign keys, WAL, and `synchronous=FULL`.
One supervisor actor owns writes. GUI and MCP handlers submit requests to it.
These records are authoritative user task data, not a rebuildable index.
Transient event buffers and connection maps do not own committed results.

| Table | Required fields and constraints |
| --- | --- |
| `sessions` | `id` primary key, project/cwd, parent ID, immutable role snapshot, backend, native ID or Confer room/seat reference, saved controls, title, archive time, revision, active task ID, blocked reason, automatic-wake pause reason. Native identity is unique within its backend and home. |
| `tasks` | Globally unique `operation_id`, caller and target session IDs, kind (`human`, `dispatch`, `wake`), canonical input and SHA-256 fingerprint, role revision, source task, depth/hops, state, revision, timestamps, cancel request, execution identity, native log reference, bounded result, stop reason, reconciliation evidence. |
| `inbox` | Monotonic sequence primary key, recipient session, operation ID, result revision, notification kind, bounded result reference, GUI read time, automatic-delivery state, wake task ID. Unique `(recipient, operation_id, result_revision)`. |

Fingerprint caller, project, exact prompt, target, role revision, and launch choices.
Use deterministic JSON encoding, with a versioned format and sorted object keys. Preserve prompt bytes and array order.
An existing operation ID with the same fingerprint returns the existing task.
An existing ID with different input returns a conflict without dispatch.
Keep identities after archive. V1 has no automatic task expiry, vacuum policy, or history deletion command.

Queued task input is durable because recovery needs it before any native log exists.
Store the final answer or failure summary, without intermediate messages.
Cap stored input and result at 256 KiB each. Reject oversized input before admission.
For oversized output, retain a bounded preview, explicit truncation status, and native session/log reference.
Do not claim that a lost Confer result can always be reconstructed from a native log.
Store credential references only. Resolve credentials through existing agent stores or child environment at launch.
Exclude environments, MCP headers, raw exceptions, and provider authentication from snapshots.
User-authored prompts and agent results can contain sensitive content. Local storage is not a general secret-detection guarantee.

The state machine has these transitions:

| From | To | Required observation |
| --- | --- | --- |
| New | `queued` | Policy, identity, size, and fingerprint checks succeeded in a committed admission transaction. |
| `queued` | `running` | Target is idle and unblocked. Commit execution identity before external I/O. |
| `queued` | `cancelled` | Cancellation commits before the worker claims it. No native dispatch occurs. |
| `running` | `finished` / `failed` / `cancelled` | The adapter reports a matching terminal outcome and managed execution release is established. |
| `running` | `uncertain` | Restart, ambiguous transport loss, or cancellation without stop evidence. Block the target. |
| `uncertain` | `finished` / `failed` / `cancelled` | Explicit reconciliation supplies outcome and release evidence. Never automatic redispatch. |
| `uncertain` | `uncertain` | Record release proof with unknown outcome. Permit explicit continuation and archive. Never redispatch automatically. |

Terminal states never return to queued or running. A retry requires a new operation ID after resource reconciliation.
Task completion does not mean human acceptance.
Archive requires no queued/running tasks or uncertain tasks without recorded release proof in the session subtree.

Admission, claims, completion, and reconciliation each use short `BEGIN IMMEDIATE` transactions.
Transactions never span ACP or Confer calls.
For each non-wake transition, commit these changes in one transaction:

- Completion: result, active-task slot release, and receipt.
- Uncertainty: receipt and target block.
- Reconciliation: result revision and receipt, preserving earlier receipts.

Wake tasks never create inbox receipts, including on failure, cancellation, uncertainty, or reconciliation.
Execution identity includes instance generation and attempt ID, then observed PID/start identity, process group, and native identity.
Persist intent before spawning. Missing process identity after a crash means uncertainty. Never signal a reused PID.
Duplicate completions compare operation, execution identity, and revision.
A stale callback cannot finish a newer task or overwrite an operator reconciliation.

## Completion delivery and restart

One scheduler serializes human prompts and automatic wakes per session.
While the dispatcher is busy, completion rows stay pending in its inbox.
When idle with automatic wakes enabled, take at most 32 receipts by sequence, within a 64 KiB wake input.
Inputs carry operation IDs, status, summaries, and result references. Status returns full stored results.
Mark the content as task output, without user authority. Agent output cannot grant permissions.
A human prompt takes priority over a wake that has not started.

In one transaction, create a queued `wake` task with a frozen receipt list and attach those inbox rows to it.
The wake uses the same execution claim and ACP `session/prompt` path as any other task.
It does not inject a second prompt during an active ACP prompt.
Each wake transition atomically updates its task and the [receipt disposition](supervisor-evidence.md#wake-receipt-recovery).
Confirmed system cancellation returns receipts to pending without adding a pause. Existing pauses remain.
Uncertainty retains claims and blocks the target until proven release.
Release proof with unknown delivery atomically unblocks the target and pauses automatic wakes, retaining claims.
After proven release, GUI `inbox_resume` atomically returns frozen receipts to pending, clears their claims, and clears the pause.
Preserve their sequences ahead of later receipts.
The GUI shows the pause reason and pending count. Human prompts remain available after release.
No wake creates a receipt, so it cannot notify itself. Repeated failures remain paused.
Completions during a wake form the next batch.
GUI read state stays independent of automatic delivery.

Receipt deduplication does not guarantee exactly-once model consumption.
A crash after wake dispatch makes the wake uncertain under the rules above. Its claimed receipts stay visible.
Replaying an uncertain wake can repeat model actions.

On startup, acquire the writer lock, open and migrate the database, then mark every leftover running task uncertain.
Preserve queued tasks and resume them only when their target and required resources are unblocked.
Rebuild pending wakes from unclaimed inbox rows. Recover queued wake tasks using their frozen receipt lists.
Do not reopen a native session while an uncertain execution can still own it.
A clean process exit or missing PID is insufficient evidence for unrelated detached or remote side effects.

Confer delivery IDs exist only inside the supervised MCP process.
Store the room, seat, delivery ID, and supervisor execution identity before waiting for output when those IDs become available.
A crash between send and recording the returned ID still leaves the task uncertain, not queued.
After Confer restart, old delivery lookup is unavailable. Inspect its seat/native session and lease state before clearing uncertainty.
Confer's own uncertainty-clear operation never substitutes for supervisor reconciliation.

## Cancellation and reconciliation

Cancel requests are idempotent and record intent before adapter calls.
Cancel only the named task, not its accepted child tasks. Show surviving children separately.
For Rx, send ACP `session/cancel`, await the prompt's `cancelled` result, and establish release under RX-CANCEL-001.
If the response is missing, terminate only the supervisor-owned agent process group and await exit.
A timeout or disconnect alone produces uncertain status.
For Confer, call `cancel_delivery` and inspect terminal status plus its uncertainty fields.
Its eight-second cleanup timeout can report uncertainty. Do not translate request acceptance into a confirmed stop.
After an eight-second grace period, show uncertainty and keep the target blocked until cleanup finishes or reconciliation occurs.
Late release evidence can support reconciliation, but cannot overwrite a newer result revision.
Cancellation never rolls back files, commits, API requests, or other completed effects.

Reconciliation shows execution identity, native reference, observed state, cancel intent, and missing evidence.
The user or a supervising caller inspects owned processes and native logs before choosing a recorded outcome.
If release is proved but the outcome stays unknown, record proof and keep the task uncertain.
Permit explicit continuation and archive, never a cancelled label or automatic redispatch.
If release remains unknown, keep the session blocked and refuse continuation.

See the [upgrade contract](supervisor-evidence.md#upgrade-contract) for versions, migrations, backup, and restore.

## Acceptance and evidence

The [evidence appendix](supervisor-evidence.md#v1-workflow-acceptance) defines the v1 workflow, Lody regression steps, and multi-machine revisit signal.
Lody keeps its existing ACP integration and needs no supervisor database access.
No supervisor or GUI runtime exists here. The injection probe does not prove dispatch, cancellation, or crash recovery.
