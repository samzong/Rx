# Model connection failures

For HTTP adapters that accept custom fetch, Rx captures fetch failures before pi-ai converts errors to strings.
The agent attaches the cause to the existing assistant `errorMessage` before logging and output.
CLI errors and ACP JSON-RPC errors therefore use the same diagnostic as the session log.
Rx does not add conversation text for a failed live ACP prompt.

Diagnostics contain only known system and TLS error codes, nonzero integer errno values, and known syscall names.
Cause chains and aggregate errors have a limit of eight objects.
Raw exception text, stacks, headers, URLs, and hostnames are excluded because they can contain credentials.
Unknown codes are omitted. An error without recognized fields reports that its cause is unavailable.
The log format and version stay unchanged. Existing logs cannot recover causes that were already discarded.

OpenAI-compatible, Codex HTTP, Anthropic, Mistral, and pi-messages requests use the supported fetch hook in pi-ai 1.4.0.
Google, Vertex, Bedrock, WebSocket failures, and errors while reading a response body keep their existing diagnostics.
Patching pi-ai to expose the original SDK exception is the strongest alternative.
The public fetch hook avoids a dependency fork and gives Rx a narrow boundary for secret filtering.
Each agent reuses one fetch wrapper so that provider clients retain their authentication caches without sharing failure state between sessions.
If a needed cause remains unavailable or an adapter changes its fetch support, revisit that choice.

Working model requests retry transient provider and transport failures at most three times, after 2, 4, and 8 seconds.
Rx uses pi-ai's public `retryAssistantCall` and error classification around each `streamSimple` request, with provider retries disabled.
Context overflow keeps RX-COMPACT-004 recovery. Authentication, quota, invalid requests, and certificate failures do not retry.
The owner selected retries to recover interrupted turns.
Provider `maxRetries` omits response-body recovery and retry events.

Cancellation stops waits and requests. A cancelled wait logs an empty `aborted` message. A live response retains text and drops unfinished tool calls.
Failed attempts retain safe diagnostics and usage. pi-ai excludes them from provider input.
Tools execute only after a successful response, so retries retain completed tool results.
ACP reports retries as activities. Only terminal working model failures use `-32010` (`provider_error`) and credential or quota guidance. Internal errors use `-32603`.
Terminals report each wait.
Delivered text cannot be withdrawn. Retry activity separates a partial answer from the complete retry.
Three extra requests bound retry charges. Summary limits follow RX-COMPACT-003.
