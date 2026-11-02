# Agent evaluations

The runner measures an agent and its selected model on reproducible tasks.
Tasks come from private sessions. Task inputs, answers, graders, provenance,
and traces stay outside this repository, under `~/.rx/evals/` by default.
The repository contains the runner, its schema, and synthetic self-tests.

## Run a task set

Use Node 22.19 or later, pnpm, and Docker. If Docker cannot access the default
temporary directory, set `TMPDIR` to a directory shared with its VM.
Build the fixed evaluation image:

```sh
make agent-deps
make eval-image
make eval AGENT=rx-agent
make eval AGENT=claude
make eval AGENT=codex
```

Supply credentials through the runner process environment. Rx uses
`DEEPSEEK_API_KEY`. Claude Code accepts `CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY`. Codex accepts `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, or
`OPENAI_API_KEY`. A Codex access token is a dedicated automation credential.
A token extracted from a normal ChatGPT sign-in is not interchangeable with it.
API keys use the provider's API billing rather than a CLI subscription.
The runner does not load, copy, or refresh credential stores.

These commands select a split, validate graders, or run another agent:

```sh
make eval AGENT=claude ARGS='--split holdout'
make eval ARGS='--self-check'
make eval AGENT=external ARGS='-- command --flag'
make eval-lifecycle
```

An external command reads its prompt from stdin. It runs inside the evaluation
image and must already be installed there. Its exit status and final artifacts
remain available for grading. Unsupported telemetry stays `unknown`.
Use `--env NAME` to pass an external agent's credential variable by name.
Use `--root` for another private dataset and `--limit` for a pilot cohort.
Use repeated `--task ID` arguments to select tasks without rerunning a recorded cohort.

## Task contract

[`task.schema.json`](../evals/task.schema.json) defines version 1. Each manifest
lives at `tasks/<id>.json`. Its files live at `fixtures/<id>/`.
All paths in the manifest are relative to that fixture directory.

Each task contains six records:

| Record | Required content |
| --- | --- |
| Requirement | The result, constraints, and boundary known at the task start. |
| Initial state | A clean file snapshot, its SHA-256, and the private base reference. |
| Environment | The runtime and explicit instruction inputs. Service dependencies use local fixtures. |
| Acceptance | An independent grader directory, revision, and commands for each scored dimension. |
| Reference | A valid result, a reasonable alternative, and a known incorrect result. |
| Provenance | Private session references and the reconstruction limits. |

A task also declares its family and its development or holdout split.
Related sessions, retries, and child sessions belong to one family.
The loader rejects a family that crosses splits. It also rejects changed input
snapshots, path escapes, symlinks, special files, and Git history.

The runner copies only the initial state into the agent container.
It sends the requirement, constraints, and explicit instructions as the prompt.
Reference results, graders, and provenance never enter that container.
Grader commands run later with `/work` and `/checks` mounted read-only and networking disabled.
Each check receives a fresh writable copy of the artifacts in `/grade/work` on tmpfs.
Its working directory is that copy. Check writes cannot alter later checks or retained artifacts.
Commands use argv arrays. They do not pass through a host shell.
The final answer is available to graders as `/work/.eval-answer.txt`.

Every run first checks all three grader controls. The reference and alternative
must pass. The known incorrect result must fail. A failed control stops the run
before model use. Hidden checks must test the stated task, not a preferred patch.

## Isolation and evidence

Each trial gets a new directory and a new Docker container. The container has
no host home, Docker socket, hidden grader, or reference mount. Its root is
read-only. Only the disposable work directory, temporary files, and empty agent
home are writable. Credentials reach the tested process through its environment.
The bootstrap receives them over stdin, never Docker arguments or environment
files. It redacts those exact values from stdout and stderr before returning them.
The agent can read its own environment. This boundary does not prevent it from
reading its provider credential or from making network requests.

Do not replay production operations. Replace external services with local
fixtures before admitting a task. The evaluation container permits model
network traffic. It is not a network allowlist for provider endpoints.

Private run records retain redacted output artifacts before grading, plus the
artifact hash and any omitted links, dependency trees, or oversized files.
Files above 16 MiB and artifacts above 64 MiB are omitted from retention.
Omission or redaction limits later artifact replay; it does not change the files
used for the original grading. Process output is limited to 16 MiB. A deadline
retains the output captured before termination. Reported cost is agent telemetry,
not evidence of a subscription charge.

The runner records the image ID, architecture, CLI versions, source hashes,
task-set hash, task hashes, input hashes, grader revisions, and observed model controls.
An input hash binds the initial snapshot, requirement, and environment separately
from hidden grading material. Retain original run records when correcting a grader.
The compiled Rx source hash and the runner source must match the checkout.
The final image contains the Rx executable, not its TypeScript source or tests.
Rebuild the image after source or dependency changes.
Claude uses the probed CLI defaults, pinned to `claude-sonnet-5-5` and `medium`.
Rx uses `deepseek/deepseek-flash` with its default thinking level, reported by ACP.
Codex uses its native defaults; do not publish a baseline until its actual model
and reasoning level have been verified and fixed for that run.
It also records every attempt, including failures and one retry permitted only after an infrastructure failure.
A scored failure ends the task without a retry.
Development and holdout results remain separate. Correctness, constraints,
evidence, elapsed time, and human intervention remain separate dimensions.
Human intervention stays `unknown` because the runner cannot observe external operator actions.
Missing tokens and cost stay `unknown`. ACP context usage is not cumulative usage.

Each task has a 15-minute deadline. At most two tasks run concurrently.
The dataset's run history shares a 20-agent-hour budget across agents and runs.
In-flight attempts reserve their full deadline before they start.
A dataset lock prevents simultaneous runner processes from spending that budget.
After an interrupted runner, inspect its process and containers before removing
a stale `run.lock`. An interrupted attempt reserves its full deadline in later
budget calculations. Do not delete run history to reset an active task budget.

Run states are `planned`, `completed`, `failed`, `infra_error`, and `unscored`.
Infrastructure failures remain visible. They do not silently become zero scores
or disappear from the cohort. A retry retains the first attempt's evidence.
An external command that cannot start is an infrastructure failure, not a scored failure.
Structured native request errors count as infrastructure failures.
Reports use the first scored attempt (`completed` or `failed`) for each task: pass@1.
If no attempt is scored, they show the latest state. All infrastructure-error attempts
are counted separately, including those followed by a scored attempt.
Reports keep per-dimension numerators and denominators.

## ACP lifecycle and Lody

The lifecycle suite launches the actual `rx-agent acp` entrypoint against a
loopback provider fixture. It checks call order, tool results, replay without
execution, cancellation without a late write, stalled-request cancellation,
process crashes, and loading after a crash without another model request.
It makes no real-model requests and contributes no tasks to the private 40-task set.
It does not assign ACP scores to native CLI agents.

Lody consumes configuration snapshots, workspace MCP tools, message and tool
updates, completion and cancellation, loaded history, and context usage.
SDK and subprocess checks do not establish installed Lody behavior.
In Lody, run the same sanitized fixture and inspect these results:

1. The artifact is correct, and the tool card reaches its final state.
2. Stop returns cancellation, and no delayed artifact appears.
3. Reload shows history without repeating an old tool's side effect.
4. A crash or stall does not appear as successful completion.

## Design boundary

TypeScript reuses the existing ACP SDK, type checker, and Node test runner.
Extending the smoke script mixes task projection, isolation, and three protocols
in one place. A Rust runner needs another ACP client without reducing that work.
The evaluation runner stays separate from the single-file product binary.

Docker supplies the isolation that a fresh working directory cannot provide
under RX-PERM-001. Grading uses another container because candidate code is
untrusted even after the agent stops. The lifecycle suite borrows failure
categories and replay boundaries from hermesh. It does not integrate hermesh.
This work preserves RX-CORE-001 and the existing launcher, tool, ACP, log,
credential, and resume contracts. Evaluation results alone do not authorize
replacing pi or changing those contracts.
