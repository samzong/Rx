import fcntl
import json
import os
import subprocess
import time
import tomllib
from .support import Acp, require, terminal


def check_missing_and_refusal(fixture):
    start = time.monotonic()
    missing = subprocess.run(
        fixture.acp_command,
        env=fixture.environment,
        cwd=fixture.work,
        input=b"",
        capture_output=True,
        timeout=3,
    )
    require(
        missing.returncode != 0
        and missing.stdout == b""
        and (b"Run `rxa` once in a terminal" in missing.stderr),
        "missing-agent ACP must fail without stdout",
    )
    fixture.checks["missing_acp"] = {
        "seconds": time.monotonic() - start,
        "exit": missing.returncode,
        "stdout_bytes": len(missing.stdout),
    }
    first_picker, shown = terminal(
        [str(fixture.rx), "--provider", "none"],
        fixture.environment,
        fixture.work,
        b"pick a harness",
        stop_after=b"\x1b",
    )
    require(
        shown and "recommended" in first_picker.lower(),
        "missing-agent picker did not recommend the agent",
    )
    fixture.install_file = fixture.home / ".recall/rx-agent/install.toml"
    fixture.install_file.parent.mkdir(parents=True, exist_ok=True)
    fixture.install_file.write_text("future = 1\n")
    corrupt_picker, shown = terminal(
        [str(fixture.rx), "--provider", "none"],
        fixture.environment,
        fixture.work,
        b"pick a harness",
        stop_after=b"\x1b",
    )
    require(
        shown and "recommended" not in corrupt_picker.lower(),
        "corrupt management blocked the picker",
    )
    corrupt_agent = subprocess.run(
        fixture.acp_command,
        env=fixture.environment,
        cwd=fixture.work,
        input=b"",
        capture_output=True,
        timeout=3,
    )
    require(
        corrupt_agent.returncode != 0 and (not corrupt_agent.stdout),
        "corrupt management did not fail closed for agent",
    )
    require(
        fixture.install_file.read_text() == "future = 1\n",
        "corrupt installation record was changed",
    )
    fixture.checks["corrupt_install_record_does_not_block_picker"] = True
    fixture.install_file.unlink()
    with (fixture.install_file.parent / "install.lock").open("w+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        busy_decline, asked = terminal(
            [str(fixture.alias), "--provider", "none"],
            fixture.environment,
            fixture.work,
            b"[y/N]",
            stop_after=b"n\n",
        )
        require(
            asked
            and "rx-agent is busy" not in busy_decline
            and (not fixture.install_file.exists()),
            "refusal failed on a busy installation lock",
        )
    fixture.checks["busy_refusal_returns_cancelled_without_record"] = True
    declined, asked = terminal(
        [str(fixture.alias), "--provider", "none"],
        fixture.environment,
        fixture.work,
        b"[y/N]",
    )
    require(asked, declined)
    fixture.install_file = fixture.home / ".recall/rx-agent/install.toml"
    require(
        tomllib.loads(fixture.install_file.read_text())["declined"],
        "refusal was not persisted",
    )
    repeated, asked = terminal(
        [str(fixture.alias), "--provider", "none"],
        fixture.environment,
        fixture.work,
        b"[y/N]",
    )
    require(asked, "explicit launch must ask after a refusal")
    fixture.checks["explicit_launch_asks_after_refusal"] = True
    refused_picker, shown = terminal(
        [str(fixture.rx), "--provider", "none"],
        fixture.environment,
        fixture.work,
        b"pick a harness",
        stop_after=b"\x1b",
    )
    require(
        shown and "recommended" not in refused_picker.lower(),
        "picker repeated the refused recommendation",
    )
    fixture.checks["picker_hides_refused_recommendation"] = True
    no_install = {**fixture.environment, "RX_NO_INSTALL": "1"}
    result = subprocess.run(
        [str(fixture.alias)],
        env=no_install,
        cwd=fixture.work,
        input=b"",
        capture_output=True,
        timeout=3,
    )
    require(
        result.returncode != 0 and b"[y/N]" not in result.stderr,
        "RX_NO_INSTALL must disable prompts",
    )
    fixture.checks["no_install_disables_prompt"] = True


def start_managed_session(fixture):
    output, accepted = terminal(
        fixture.terminal_command,
        fixture.environment,
        fixture.work,
        b"[y/N]",
        stop_after=b"y\n",
        finish_when=b"Ctrl-D exits",
    )
    require(accepted and f"rx {fixture.versions[0]} " in output, output)
    require(
        fixture.run(["rx-agent", "--version"]).stdout.strip().decode()
        == fixture.versions[0],
        "managed version selection",
    )
    fixture.checks["terminal_installation"] = fixture.versions[0]
    fixture.rx_update_file = fixture.home / ".recall/rx-update.toml"
    fixture.rx_update_file.write_text('auto_update = true\nlast_check = "0"\n')
    fixture.rx_update_before = fixture.rx_update_file.read_bytes()
    old_command = fixture.acp_command
    old_environment = fixture.environment
    if fixture.args.live_model:
        key_name = (
            fixture.args.live_model.split("/", 1)[0].upper().replace("-", "_")
            + "_API_KEY"
        )
        require(
            bool(os.environ.get(key_name)),
            f"{key_name} is required for the live model probe",
        )
        old_environment = {**fixture.environment, key_name: os.environ[key_name]}
        old_command = [
            str(fixture.alias),
            "--provider",
            "none",
            "--model",
            fixture.args.live_model,
            "acp",
        ]
    fixture.old = Acp(old_command, old_environment, fixture.work)
    session = fixture.old.request(
        "session/new", {"cwd": str(fixture.work), "mcpServers": []}
    )
    require(
        session.get("configOptions"), "session must expose existing model configuration"
    )
    fixture.old_session_id = session["sessionId"]
    fixture.checks["installed_acp"] = {
        "seconds": fixture.old.seconds,
        "version": fixture.old.initialize["agentInfo"]["version"],
        "session": fixture.old_session_id,
    }
    fixture.managed_versions = fixture.home / ".recall/rx-agent/versions"
    fixture.update_file = fixture.home / ".recall/rx-agent/update.toml"
    fixture.lock_file = fixture.home / ".recall/rx-agent/install.lock"
    fixture.active_environment = {
        key: value
        for key, value in fixture.environment.items()
        if key != "RX_NO_UPDATE"
    }
    fixture.active_environment.update(
        {
            "ANTHROPIC_API_KEY": "fixture-secret-alpha",
            "CUSTOM_API_KEY": "fixture-secret-beta",
            "AWS_SECRET_ACCESS_KEY": "fixture-secret-gamma",
            "RX_AGENT_PROVIDER": json.dumps(
                {
                    "id": "openai",
                    "name": "Fixture",
                    "api": "openai-responses",
                    "baseUrl": "https://api.openai.com/v1",
                    "env": "OPENAI_API_KEY",
                    "models": [
                        {
                            "id": "gpt-4.1-mini",
                            "contextWindow": 1000000,
                            "reasoning": False,
                        }
                    ],
                    "defaultModel": "gpt-4.1-mini",
                }
            ),
        }
    )
