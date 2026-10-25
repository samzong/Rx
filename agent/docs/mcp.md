# MCP tools

rx-agent connects MCP servers through `@earendil-works/pi-mcp` 1.4.0.
The same tools work in CLI sessions and ACP sessions.
Tools run with the user's permissions under RX-PERM-001.
MCP adds no permission prompt or sandbox.

## Contract

RX-MCP-001: User MCP configuration and ACP new/load servers supply session tools through pi-mcp. ACP entries replace same-name user entries without persistence. Connections start in parallel before log creation or repair. Startup failures skip only the affected server and produce a sanitized warning. Invalid user files do not block ACP servers. Cancellation still aborts startup. Load and connection shutdown close replaced or finished connections. Only stdio and Streamable HTTP are supported.

## User configuration

Create `$RX_HOME/mcp.json`, where `RX_HOME` defaults to `~/.rx`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "timeout": 60
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  }
}
```

`mcpServers` uses pi's basic configuration format.
rx-agent only reads this file.
Keep credentials in environment variables and reference them in `env` or `headers` with `${NAME}`.
An unset variable skips only that server and reports the variable name.
rx-agent does not run command substitutions in these fields.

Stdio entries accept `command`, `args`, `env`, and `cwd`.
The command is one executable, without a shell wrapper.
Relative working directories resolve from the session directory.
A leading `~/` in a command, argument, or working directory expands to the user's home.
The server inherits the agent environment, with `env` entries applied afterward.

HTTP entries accept `url` and `headers` and use Streamable HTTP.
Credentials embedded in a URL are rejected.
OAuth login and legacy SSE are not supported.
Both transports accept a positive `timeout` in seconds, up to 86400, with a default of 60.
The timeout bounds the complete connection and tool discovery for each server.
All servers start concurrently, so startup waits for the longest deadline, plus transport cleanup grace.
The same timeout applies separately to tool calls, where progress notifications renew it.
`enabled: false` disables an entry.

`type` is optional and accepts `stdio`, `http`, or `streamable-http` for the matching transport.
`description` is accepted as metadata.
rx-agent skips entries with unsupported pi fields, including exposure controls, OAuth, and command-based credentials.
rx-agent declares discovered tools directly to the model.
It does not load pi's extension runtime, project configuration, resource tools, prompt templates, or tool search.

## ACP and session lifetime

ACP `session/new` and `session/load` merge `mcpServers` with the user configuration.
An ACP entry replaces the user entry with the same server name.
ACP environment and header values are literals, without configuration-variable expansion.
rx-agent never saves ACP server definitions or credentials in session logs.

Each session owns its connections.
Load reconnects with current user configuration and the client's current server list.
After a successful load, rx-agent closes the previous connections for that session.
A failed load preserves the previous live session.
An MCP failure alone does not fail a load. The loaded session uses the servers that connected.
An active prompt or load prevents concurrent changes to the same session.

ACP advertises `http: true` and `sse: false`.
ACP has no capability flag for stdio servers.
Tool calls and results use ordinary ACP updates, so Lody displays their progress and completion status.
Closing the ACP connection or CLI session closes the servers.
Stdio shutdown closes stdin and then terminates the process group if needed.

## Results and failures

Tools use names such as `mcp__filesystem__read_file`.
Unsupported characters or a generated name longer than 64 characters require a stable hash suffix.
The suffix also applies to `__` inside either component, server names ending with `_`, and tool names starting with `_`.
Tool results preserve text and images through pi's `toLlmContent` conversion.
Structured results without content blocks become JSON text.
Other content types become pi's text representation.

A startup, validation, or discovery failure skips only that server. Its tools are not registered.
A missing environment variable, unsupported entry, or duplicate tool name has the same effect.
The first valid server in configuration order keeps a conflicting tool name. The later server is skipped in full.
An invalid or unreadable `mcp.json` skips the user configuration. ACP servers still connect.
The file remains unchanged.

CLI writes each warning to stderr.
ACP collects startup warnings and sends one ordinary `agent_message_chunk` before model execution on the session's first prompt.
New and loaded sessions both follow this rule, without a `notices` capability.
The warning names each failed server and a safe error category or missing variable name.
Header values, environment values, raw transport errors, and server stderr are excluded.
These display messages do not enter model context or session logs and are not replayed from history.
A later load tries the current configuration again and reports its own warnings.
Correct or disable a failed server before reopening the session to use its tools.

All configured servers are optional. Rx adds no `required` field.
The strongest alternative is Codex's `required: true`. ACP has no such field, and the current use case has no required server.
Cancellation or connection shutdown still aborts startup and closes all connections before any log creation or recovery.
rx-agent adds no connection retry.
pi owns Streamable HTTP stream reconnection.

A tool timeout, protocol error, or MCP `isError` result produces a failed tool result.
ACP cancellation cancels the pending MCP request and returns `cancelled` for the turn.
Cancellation cannot prove that a remote server reversed side effects already performed.
Session logs retain tool arguments and results under RX-LOG-001, including sensitive data that a tool returns.
