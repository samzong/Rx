# MCP tools

rx-agent connects MCP servers through `@earendil-works/pi-mcp` 1.4.0.
The same tools work in CLI sessions and ACP sessions.
Tools run with the user's permissions under RX-PERM-001.
MCP adds no permission prompt or sandbox.

## Contract

RX-MCP-001: User MCP configuration and ACP new/load servers supply session tools through pi-mcp. ACP entries replace same-name user entries without persistence. Connections open before log creation or repair. Load and connection shutdown close replaced or finished connections. Only stdio and Streamable HTTP are supported.

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
An unset variable stops session startup.
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
Progress notifications renew the request timeout.
`enabled: false` disables an entry.

`type` is optional and accepts `stdio`, `http`, or `streamable-http` for the matching transport.
`description` is accepted as metadata.
Other pi extension fields, including exposure controls, OAuth, and command-based credentials, are rejected.
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

A startup or discovery failure rejects session opening before the session log changes.
The error names the server and a safe failure category.
Raw transport errors and server stderr are excluded because they can contain credentials.
Correct the configuration or disable the server, then open the session again.
rx-agent adds no connection retry.
pi owns Streamable HTTP stream reconnection.

A tool timeout, protocol error, or MCP `isError` result produces a failed tool result.
ACP cancellation cancels the pending MCP request and returns `cancelled` for the turn.
Cancellation cannot prove that a remote server reversed side effects already performed.
Session logs retain tool arguments and results under RX-LOG-001, including sensitive data that a tool returns.
