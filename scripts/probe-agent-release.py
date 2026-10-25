import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
from pathlib import Path


def exchange(child, request):
    response = queue.Queue()
    reader = threading.Thread(target=lambda: response.put(child.stdout.readline()), daemon=True)
    reader.start()
    child.stdin.write(json.dumps(request) + "\n")
    child.stdin.flush()
    try:
        line = response.get(timeout=15)
    except queue.Empty:
        raise RuntimeError("ACP response timed out.") from None
    reader.join()
    message = json.loads(line)
    if message.get("jsonrpc") != "2.0" or message.get("id") != request["id"] or "error" in message:
        raise RuntimeError("ACP did not return the expected NDJSON response.")
    return message["result"]


binary = str(Path(sys.argv[1]).resolve())
version = sys.argv[2]
with tempfile.TemporaryDirectory(prefix="rx-agent-release-") as home:
    env = {key: value for key, value in os.environ.items() if key not in {"RX_AGENT_PROVIDER", "RX_MODEL"}}
    env["RX_HOME"] = home
    result = subprocess.run([binary, "--version"], env=env, capture_output=True, text=True, timeout=15, check=True)
    if result.stdout.strip() != version:
        sys.exit("The binary version differs.")
    child = subprocess.Popen([binary, "acp"], cwd=home, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        response = exchange(child, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1, "clientCapabilities": {}}})
        capabilities = response.get("agentCapabilities", {})
        if response.get("protocolVersion") != 1 or response.get("agentInfo", {}).get("version") != version or not capabilities.get("loadSession") or "list" not in capabilities.get("sessionCapabilities", {}):
            sys.exit("ACP initialize did not preserve the version and session capabilities.")
        listed = exchange(child, {"jsonrpc": "2.0", "id": 2, "method": "session/list", "params": {}})
        if listed.get("sessions") != []:
            sys.exit("ACP session/list did not return an empty temporary home.")
    finally:
        child.terminate()
        try:
            remaining, _ = child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            remaining, _ = child.communicate()
    if remaining.strip():
        sys.exit("ACP wrote unexpected stdout after the responses.")
    print(f"Native {version}: --version, ACP initialize, and session/list passed.")
