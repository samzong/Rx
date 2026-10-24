# Rx

Rx is a personal coding agent. It runs in a terminal or behind any editor that
speaks the [Agent Client Protocol](https://agentclientprotocol.com), works in
your local directory with four tools (`read`, `write`, `edit`, `bash`), and
keeps every session as an append-only log you can resume.

The agent loop comes from
[pi-agent-core](https://github.com/earendil-works/pi) and model access from
pi-ai, so any provider that pi-ai supports works with an API key in the
environment.

The previous Rust launcher is preserved at tag `v0.1.0`.

## Install

Requires Node 22.19 or later (CI uses Node 24) and pnpm.

```bash
git clone https://github.com/samzong/Rx.git
cd Rx
make install
```

`make install` links `rx` into `~/.local/bin`; set `PREFIX` to change it.

## Usage

```bash
export DEEPSEEK_API_KEY=...
rx -m deepseek/deepseek-flash            # interactive session
rx -m deepseek/deepseek-flash -p "..."   # one prompt, then exit
rx -c                                    # continue the latest session here
rx -r <session-id>                       # resume a session
rx sessions [--all]                      # list sessions
rx models                                # list models with credentials
rx acp                                   # serve ACP on stdio
```

The model comes from `-m`, then `RX_MODEL`, then `model` in
`~/.rx/config.json`. `--thinking` sets the reasoning level (default `medium`).
Project instructions are read from `AGENTS.md`, or `CLAUDE.md` if there is no
`AGENTS.md`.

Tools run with your permissions and no sandbox.

### Editor setup

Configure your ACP client to start `rx acp`, with `RX_MODEL` and the provider
API key in its environment.

## Files

| Path | Content |
| --- | --- |
| `$RX_HOME/config.json` | `{"model": "provider/id", "thinking": "medium"}` |
| `$RX_HOME/sessions/<id>.jsonl` | Session logs, private to your user |
| `$RX_HOME/sessions/<id>.lock` | Pid of the process using the session |

`RX_HOME` defaults to `~/.rx`.

## Development

```bash
make deps
make check
```

See [DESIGN.md](docs/DESIGN.md) for invariants and acceptance checks and
[ROADMAP.md](ROADMAP.md) for what comes next.
