# Session logs and resume

This document is part of the normative [rx-agent design contract](../DESIGN.md).

| ID | Contract |
| --- | --- |
| RX-LOG-001 | Every message that enters the agent context is appended to the session log with its real origin: `cli`, `acp`, `model`, `tool`, or `rx`. The only exception is the initial system prompt. Rx rebuilds that prompt from the current environment, global and project instructions, referenced files, and skill metadata when it creates or loads an agent. Rx completes this read-only context build before creating or opening a session log. A context failure creates no session file or lock and does not repair or change an existing log. These inputs are not saved in the log. Skill bodies and references enter the log only through normal tool results. Summary usage records have `purpose: "compaction"`, `origin: "model"`, and an assistant message with empty content. They keep the reported model, API, provider, token usage, cost, stop reason, and timestamp. They never enter working context, ACP history replay, or working-context usage. Versioned compaction checkpoints record the active model context without replacing the complete history. Rx never rewrites or deletes a complete log line; the only permitted change is truncating an unterminated final fragment (RX-LOG-002). |
| RX-LOG-002 | A log starts with a versioned header. Only newline-terminated lines count. Rx rejects unknown versions and fails on any corrupt terminated line. Opening a session to append truncates an unterminated final fragment first, and a failed append truncates its partial line. A new log version must keep reading every earlier version. Version 1 logs accept versioned compaction checkpoints under RX-COMPACT-002. Invalid checkpoints fail before log repair. |
| RX-LOG-003 | One process writes a session at a time. Creating or opening a session atomically takes `sessions/<id>.lock` holding the owner pid. A lock held by a live process is an error that names the lock file; a lock left by a dead process is reclaimed. An open that fails releases the lock it took. `session/load` checks the session's `cwd` before taking the lock. If the dead owner's pid has been reused, the lock is not reclaimed and the user deletes the named file. Two processes reclaiming the same dead lock at the same moment can both proceed; Rx accepts this because it needs a crash followed by two simultaneous opens of that session. |
| RX-RESUME-001 | Resume projects the latest checkpoint and subsequent messages under the current system prompt, rebuilt for the saved session working directory. If that directory is missing, resume and ACP load still open the session with global instructions and skills only. The saved working directory and the CLI note remain unchanged; tools still run at that original path. Changes to instructions, their references, skill metadata, HOME, or RX_HOME can change resumed behavior. The log alone cannot reproduce the earlier system prompt. The complete history remains available for ACP replay and interrupted-tool repair. Each tool call without a recorded result gets exactly one `rx`-origin error result stating that its side effects are unknown. Rx never re-runs it. |

## Summary accounting

Each summary response with nonzero input, output, cache-read, or cache-write tokens appends a usage record.
Rx writes the record before it accepts or rejects the summary, including failed, truncated, over-budget, and cancelled responses.
Multiple summary requests produce separate records.
A response without a provider measurement cannot supply a usage record.
Old logs cannot recover discarded measurements.

The raw message count includes summary usage records.
Checkpoint `through` uses that count.
Resume slices the raw records at `through` before it excludes summary usage records.
It excludes those records from complete conversational history and active working context.
ACP keeps RX-ACP-004: summary requests do not measure working-context usage.

Recall consumes assistant usage from `type: "message"` records, even when their content is empty.
A separate `type: "usage"` event is the strongest simpler alternative, but the existing Recall reader ignores it.
Rx uses an additive `purpose` field and keeps `LOG_VERSION = 1` so Recall can consume the measurements without a format migration.
Logs without this field keep their existing meaning.

Older Rx readers ignore `purpose` and can retain empty summary messages in memory.
After a failed compaction, an older ACP load can display summary usage as working-context usage until the next working response.
Successful checkpoints exclude earlier measurements under the existing load rules.
This downgrade limitation does not change how the new reader loads old logs.

Rx does not create forks, branches, child sessions, or subagents through CLI or ACP.
Its headers therefore have no parent or fork field.
The system prompt remains rebuilt under RX-LOG-001 and RX-RESUME-001.
Recall does not need a stored system prompt for its current history and usage reader.
A reproducible prompt snapshot would be a separate product contract.
