import fcntl
import struct
import termios
import json
import os
import pty
import select
import subprocess
import time


def require(condition, detail):
    if not condition:
        raise AssertionError(detail)


def wait_for(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.025)
    raise TimeoutError("condition did not become true")


class Acp:
    def __init__(self, command, environment, cwd):
        self.process = subprocess.Popen(
            command,
            env=environment,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self.buffer = b""
        self.messages = []
        self.counter = 0
        started = time.monotonic()
        self.initialize = self.request(
            "initialize", {"protocolVersion": 1, "clientCapabilities": {}}
        )
        self.seconds = time.monotonic() - started

    def request(self, method, params, timeout=10):
        self.counter += 1
        request_id = self.counter
        self.process.stdin.write(
            (
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "method": method,
                        "params": params,
                    }
                )
                + "\n"
            ).encode()
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if b"\n" not in self.buffer:
                ready, _, _ = select.select(
                    [self.process.stdout], [], [], max(0, deadline - time.monotonic())
                )
                if not ready:
                    break
                data = os.read(self.process.stdout.fileno(), 65536)
                if not data:
                    raise RuntimeError(self.process.stderr.read().decode())
                self.buffer += data
                continue
            line, self.buffer = self.buffer.split(b"\n", 1)
            response = json.loads(line)
            self.messages.append(response)
            if response.get("id") == request_id:
                require("result" in response, response)
                return response["result"]
        raise TimeoutError(method)

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=10)
        remainder = self.buffer + self.process.stdout.read()
        for line in remainder.splitlines():
            self.messages.append(json.loads(line))
        require(self.process.returncode == 0, self.process.stderr.read().decode())


def terminal(command, environment, cwd, text, stop_after=None, finish_when=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    process = subprocess.Popen(
        command, env=environment, cwd=cwd, stdin=slave, stdout=slave, stderr=slave
    )
    os.close(slave)
    output = b""
    sent = False
    finished = False
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
            if b"\x1b[6n" in chunk:
                os.write(master, b"\x1b[1;1R")
        if not sent and text in output:
            if stop_after is None:
                os.write(master, b"\n")
            else:
                os.write(master, stop_after)
            sent = True
        if (
            sent
            and finish_when is not None
            and (finish_when in output)
            and (not finished)
        ):
            os.write(master, b"/exit\n")
            finished = True
        if process.poll() is not None:
            break
    if process.poll() is None:
        process.terminate()
    process.wait(timeout=5)
    os.close(master)
    return (output.decode(errors="replace"), sent)
