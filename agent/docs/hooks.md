# Command hooks

This document owns RX-HOOK-001 in the [agent design contract](../DESIGN.md).
A hook runs a user command at a session or tool boundary.
It can check an action, reject it before execution, or provide context.

## Configuration

Create `$RX_HOME/hooks.json`, or `~/.rx/hooks.json` when `RX_HOME` is unset.
Rx only reads this file. An absent file disables hooks.
Each new or resumed session reads one read-once snapshot.
Changes take effect when another session opens or resumes.
Rx never discovers hook files in projects, other harness homes, or plugins.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^bash$",
        "hooks": [
          { "type": "command", "command": "./checks/pre-tool", "timeout": 30 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^bash$",
        "hooks": [
          { "type": "command", "command": "./checks/post-tool", "timeout": 30 }
        ]
      }
    ]
  }
}
```

Commands run through `/bin/bash -c` in the saved session working directory.
Relative executable paths therefore refer to that directory.
Only the user-owned configuration enables these commands.
Commands inherit the process environment and user permissions, including access to credentials.
Hooks are trusted executable code. Rx adds no sandbox or ACP permission request.

Rx rejects malformed JSON, unknown fields, unsupported events or handlers, invalid matchers, and invalid timeouts.
It never repairs or overwrites the file.
Handlers run sequentially in configuration order without automatic retries.
A rejected preflight stops that event's remaining handlers.
Tools retain pi core's parallel execution and result order.
Hook commands do not trigger tool hooks themselves.

## Events and matching

Tool matchers are case-sensitive regular expressions over actual tool names.
Missing, empty, and `*` match all names.
SessionStart matches its `source`, either `startup` or `resume`.
UserPromptSubmit and Stop do not use matchers.
Use native names: `read`, `write`, `edit`, `bash`, or the discovered `mcp__...` name.

| Event | Boundary | Permitted effect |
| --- | --- | --- |
| SessionStart | Once after session opening, before its first model request. | Queue context for the next accepted prompt. A failure rejects opening. |
| UserPromptSubmit | Once per external prompt, before transcript acceptance or model access. | Reject the prompt or provide context. Internal summaries and continuations do not trigger it. |
| PreToolUse | After schema validation, before local or MCP execution. | Reject this call or provide context. Peer calls remain independent. |
| PostToolUse | After an executed successful tool, before its final result. | Provide context or report failed validation. Preserve the completed output and side effects. |
| PostToolUseFailure | After an executed failed tool. | Receive the error and provide context or feedback. Denied and invalid calls never trigger a post event. |
| Stop | Once after normal external prompt completion and log flush. | Observe completion and report a final-check failure. Never continue the model. |

Stop does not run after cancellation, fatal model failure, or manual compaction.
Post handlers run when their own call completes.
A post-check cannot roll back an action or prevent earlier streamed output.
It is not a redaction boundary.

## Command input

Each command receives one newline-terminated JSON object on stdin.
Common fields are `hook_event_name`, `session_id`, `cwd`, `transcript_path`, and `transcript_format`.
`transcript_path` is the actual Rx log. `transcript_format` is `rx-jsonl-v1`.
Rx never supplies a fabricated Claude or Codex transcript or permission mode.

| Event | Additional fields |
| --- | --- |
| SessionStart | `source`: `startup` or `resume`. |
| UserPromptSubmit | `prompt`: external prompt text. |
| Three tool events | `tool_name`, `tool_use_id`, and validated `tool_input`. |
| PostToolUse | `tool_response`: original `content` and `isError`. |
| PostToolUseFailure | `tool_response` and text `error`. |

Tool input retains the Rx schema.
For example, `bash.timeout` uses seconds, and file tools use `path`, `old_text`, and `new_text`.
Hooks cannot rewrite arguments by returning new input or mutating the received JSON.
ACP shows the same requested input that the tool executes.

## Command output

Exit 0 with empty stdout means no objection.
SessionStart and UserPromptSubmit can return plain stdout as context.
Other events treat plain stdout as diagnostic text.
Control output must be a JSON object.
If JSON parsing fails, trimmed stdout that starts with `{` is an error.
Other stdout that fails JSON parsing is plain text, including `[ok] checked` or text that starts with `"`.
Rx rejects unknown or unsupported control fields explicitly.

This pre-tool response rejects one call:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "This command writes outside the allowed directory."
  }
}
```

`permissionDecision: "allow"` means only that this hook has no objection.
It does not grant permission beyond the existing tool policy.
`hookSpecificOutput.hookEventName` must match the event.
Context-capable events accept `additionalContext` inside `hookSpecificOutput`.
Prompt and tool checks accept top-level `decision: "block"` with `reason`.
UserPromptSubmit also accepts `continue: false` with `stopReason` as a rejection.
`continue: true` and `suppressOutput: true` are accepted no-ops.

Exit 2 rejects a pre-tool call or prompt, with stderr as the reason.
On post events, it marks validation failed without losing the original output.
SessionStart failure rejects opening. Stop failure reports a final-check error.
Other nonzero exits, timeout, output overflow, and protocol errors use the same event-specific failure behavior.
Rx does not retry failed commands.

Unsupported controls include `ask`, `updatedInput`, `updatedToolOutput`, `updatedMCPToolOutput`, and `async`.
Stop cannot return context or request continuation.
An unsupported response fails explicitly instead of silently changing meaning.
Generic diagnostic output must not contain credentials.
Rx does not log commands, stdin, or environment as general failure diagnostics.

## Limits and cancellation

The default timeout is 30 seconds per command.
`timeout` accepts a positive finite number of seconds, up to 600.
Stdout and stderr each have a separate 64 KiB byte limit.
Accepted context has a combined 64 KiB limit per event.
Overflow is an error. Truncated JSON never counts as a successful decision.

Normal command exit, timeout, and cancellation end the command's entire process group.
Background work must finish before the script exits.
A descendant that deliberately leaves that group is outside this cleanup boundary.
User scripts must keep children in the group or own their cleanup.
A detached descendant that holds output pipes causes an explicit error after the shell exits.
ACP cancellation, disconnection, Ctrl-C, SIGTERM, and SIGHUP use that cleanup path.
Hook stdout never reaches ACP stdout directly.
ACP stdout carries protocol messages only.
Hook side effects are not exactly-once across crashes.

## Persistence and clients

Model-facing context uses existing v1 message records with origin `rx`.
Each message starts with `[Hook-provided context: EventName]`.
The submitted user message stays separate and retains its own origin.
Tool context enters the next model request through pi core's normal message path.
Post-check feedback appends to the final toolResult and preserves its original content.
A failed post-check sets `isError: true`.
The adapter catches hook errors itself so core cannot replace the original tool result.

CLI and ACP consume those same final results.
ACP emits a failed tool update with the original toolCallId and a readable reason.
A denied tool normally returns `end_turn` after the model responds.
Only cancellation returns `cancelled`.
A rejected prompt produces an agent notice, accepts no user record, and makes no model request.
Stop errors produce a visible notice without a new turn.

Resume replays labeled hook context and finalized results without rerunning historical hooks or tools.
The new SessionStart event still runs once with `source: "resume"`.
Its new context waits for the next accepted prompt.
ACP history presents `rx` context as labeled agent notices, not user-authored text.
Session titles use the first submitted user message.
The session log remains the sole durable history owner.
