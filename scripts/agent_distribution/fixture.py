import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
from .support import require, wait_for, terminal


class Fixture:
    def __init__(fixture, args, repository):
        fixture.args = args
        fixture.repository = repository
        fixture.scratch = Path(tempfile.mkdtemp(prefix="rx-distribution-"))
        fixture.home, fixture.binaries, fixture.work = [
            fixture.scratch / name for name in ("home", "bin", "work")
        ]
        for directory in (fixture.home, fixture.binaries, fixture.work):
            directory.mkdir()
        fixture.rx = fixture.binaries / "rx"
        shutil.copy2(fixture.args.rx.resolve(), fixture.rx)
        fixture.alias = fixture.binaries / "rxa"
        fixture.alias.symlink_to("rx")
        fixture.environment = {
            "HOME": str(fixture.home),
            "RX_HOME": str(fixture.home / ".rx"),
            "PATH": "/usr/bin:/bin",
            "TERM": "xterm-256color",
            "RX_NO_UPDATE": "1",
            "OPENAI_API_KEY": "fixture-not-a-secret",
        }
        fixture.report = {"scratch": str(fixture.scratch), "checks": {}}
        fixture.checks = fixture.report["checks"]
        fixture.old = None
        fixture.terminal_command = [
            str(fixture.alias),
            "--provider",
            "none",
            "--model",
            "openai/gpt-4.1-mini",
        ]
        fixture.acp_command = [*fixture.terminal_command, "acp"]
        fixture.install_file = fixture.home / ".recall/rx-agent/install.toml"
        fixture.update_file = fixture.home / ".recall/rx-agent/update.toml"

    def prepare_releases(fixture):
        package = json.loads((fixture.repository / "agent/package.json").read_text())
        original = package["version"]
        major, minor, patch = map(int, original.split("."))
        fixture.versions = [
            original,
            f"{major}.{minor}.{patch + 1}",
            f"{major}.{minor}.{patch + 2}",
        ]
        source = fixture.scratch / "agent"
        source.mkdir()
        shutil.copytree(fixture.repository / "agent/src", source / "src")
        (source / "node_modules").symlink_to(
            fixture.repository / "agent/node_modules", target_is_directory=True
        )
        fixture.archives = {}
        for index, version in enumerate(fixture.versions):
            binary = (
                fixture.args.agent.resolve()
                if index == 0
                else fixture.scratch / f"rx-agent-{version}"
            )
            if index:
                (source / "package.json").write_text(
                    json.dumps({**package, "version": version})
                )
                subprocess.run(
                    [
                        "bun",
                        "build",
                        "--compile",
                        str(source / "src/cli.ts"),
                        "--outfile",
                        str(binary),
                    ],
                    check=True,
                    capture_output=True,
                    cwd=fixture.repository,
                )
            memory = io.BytesIO()
            with tarfile.open(fileobj=memory, mode="w:gz", compresslevel=1) as archive:
                archive.add(binary, arcname="rx-agent")
            fixture.archives[version] = memory.getvalue()
        fixture.asset = (
            "rx-agent-darwin-arm64.tar.gz"
            if os.uname().sysname == "Darwin" and os.uname().machine == "arm64"
            else "rx-agent-darwin-x64.tar.gz"
            if os.uname().sysname == "Darwin"
            else "rx-agent-linux-x64.tar.gz"
        )
        fixture.state = {
            "version": fixture.versions[0],
            "bad_hash": False,
            "offline": False,
            "block_archive": False,
            "release_requests": 0,
        }
        fixture.requested = threading.Event()
        fixture.unblock = threading.Event()

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                version = fixture.state["version"]
                if self.path.startswith("/releases?"):
                    fixture.state["release_requests"] += 1
                    if fixture.state["offline"]:
                        time.sleep(7)
                    body = json.dumps(
                        [
                            {
                                "tag_name": f"rx-agent-v{version}",
                                "draft": False,
                                "prerelease": False,
                                "assets": [
                                    {
                                        "name": fixture.asset,
                                        "browser_download_url": f"{fixture.base}/archive/{version}",
                                    },
                                    {
                                        "name": "SHA256SUMS",
                                        "browser_download_url": f"{fixture.base}/sums/{version}",
                                    },
                                ],
                            }
                        ]
                    ).encode()
                elif self.path.startswith("/archive/"):
                    if fixture.state["block_archive"]:
                        fixture.requested.set()
                        fixture.unblock.wait(timeout=10)
                    body = fixture.archives[self.path.rsplit("/", 1)[-1]]
                elif self.path.startswith("/sums/"):
                    version = self.path.rsplit("/", 1)[-1]
                    digest = (
                        "0" * 64
                        if fixture.state["bad_hash"]
                        else hashlib.sha256(fixture.archives[version]).hexdigest()
                    )
                    body = f"{digest}  {fixture.asset}\n".encode()
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *_):
                pass

        fixture.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        fixture.server.daemon_threads = True
        fixture.base = f"http://127.0.0.1:{fixture.server.server_port}"
        fixture.environment["RX_TEST_RELEASE_SOURCE"] = fixture.base
        worker = threading.Thread(target=fixture.server.serve_forever, daemon=True)
        worker.start()

    def run(fixture, arguments, check=True, env=None):
        result = subprocess.run(
            [str(fixture.rx), *arguments],
            env=env or fixture.environment,
            cwd=fixture.work,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
        )
        if check:
            require(result.returncode == 0, result.stderr.decode())
        return result

    def helper_pids(fixture):
        processes = subprocess.check_output(["ps", "-axo", "pid=,command="], text=True)
        return [
            int(line.split(None, 1)[0])
            for line in processes.splitlines()
            if any(
                (
                    str(executable) + " --rx-agent-background-update" in line
                    for executable in (fixture.rx, fixture.alias)
                )
            )
        ]

    def overdue(fixture):
        fixture.update_file.write_text('last_check = "0"\n')

    def wait_checked(fixture, before_requests):
        wait_for(lambda: fixture.state["release_requests"] > before_requests)
        wait_for(lambda: not fixture.helper_pids())

    def launch_terminal(fixture, env, expected):
        start = time.monotonic()
        output, entered = terminal(
            fixture.terminal_command,
            env,
            fixture.work,
            b"Ctrl-D exits",
            stop_after=b"/exit\n",
        )
        seconds = time.monotonic() - start
        require(entered and f"rx {expected} " in output, output)
        require(
            "Update now" not in output
            and "Always auto-update" not in output
            and ("[y/N]" not in output),
            "managed startup asked for an update",
        )
        require(seconds < 2.5, "terminal startup waited for the updater")
        return seconds
