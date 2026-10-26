# Interactive initial prompts

This document is part of the normative [rx-agent design contract](../DESIGN.md).

RX-CLI-001: `rx-agent [options] [prompt...]` starts the existing REPL and sends the optional first prompt before it asks for another input.
Positional arguments join with one space. A quoted argument keeps its internal whitespace and newlines.
The initial prompt is ordinary model input, even when it is `/compact`, `/exit`, or `/quit`.
Later REPL input keeps its existing command handling.
`-p <prompt>` still runs once and exits. A positional prompt cannot accompany `-p`.
Resume and continue can receive the same optional first prompt.

`login`, `logout`, `acp`, `models`, and `sessions` remain commands when they are the first positional argument before `--`.
Their existing argument limits still apply.
After `--`, arguments are literal prompt text, including command names and leading hyphens.
Use `rx-agent -- "<prompt>"` for caller-supplied text that must never select a command or option.

The launcher preserves these arguments through `rx rx-agent`, `rx agent`, and `rxa` under RX-ARGS-001 and RX-AGENT-002.
The launcher does not need another prompt flag or an argument rewrite.
Recall can use the executable `rx-agent` with arguments `["--", prompt]` for its start command.
The equivalent shell form is `rx-agent -- "<prompt>"`.
A leading hyphen uses the same form: `rx-agent -- "-review this change"`.
Caller code must pass an argument array or apply its existing shell escaping to the complete prompt.

The strongest alternative is a new `--prompt` flag.
That adds another input path and forces callers to learn an Rx-specific flag.
The existing REPL already owns rendering, cancellation, cleanup, and the next input.
The optional positional prompt reuses that owner.
ACP clients keep `session/new` or `session/load`, followed by `session/prompt`.
They do not pass an initial CLI prompt to `rxa acp`.
