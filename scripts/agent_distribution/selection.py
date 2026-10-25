import hashlib
import time
from .support import require


def check_external_selection(fixture):
    external = fixture.scratch / "external"
    external.mkdir()
    external_agent = external / "rx-agent"
    external_agent.write_text("#!/bin/sh\nprintf '%s\\n' 'source-fixture'\n")
    external_agent.chmod(0o755)
    external_digest = hashlib.sha256(external_agent.read_bytes()).hexdigest()
    fixture.overdue()
    before = fixture.install_file.read_bytes()
    before_check = fixture.update_file.read_bytes()
    requests = fixture.state["release_requests"]
    path_environment = {
        **fixture.active_environment,
        "PATH": f"{external}:/usr/bin:/bin",
    }
    require(
        fixture.run(["rx-agent", "--version"], env=path_environment).stdout.strip()
        == b"source-fixture",
        "managed version shadowed PATH",
    )
    beside_agent = fixture.binaries / "rx-agent"
    beside_agent.write_text("#!/bin/sh\nprintf '%s\\n' 'beside-fixture'\n")
    beside_agent.chmod(0o755)
    require(
        fixture.run(["rx-agent", "--version"], env=path_environment).stdout.strip()
        == b"source-fixture",
        "beside Rx shadowed PATH",
    )
    require(
        fixture.run(
            ["rx-agent", "--version"], env=fixture.active_environment
        ).stdout.strip()
        == b"beside-fixture",
        "managed version shadowed beside Rx",
    )
    time.sleep(0.1)
    require(not fixture.helper_pids(), "external agent triggered maintenance")
    require(
        fixture.state["release_requests"] == requests
        and fixture.update_file.read_bytes() == before_check,
        "external agent triggered managed update",
    )
    require(
        fixture.install_file.read_bytes() == before,
        "external launch changed management",
    )
    require(
        hashlib.sha256(external_agent.read_bytes()).hexdigest() == external_digest,
        "managed updater overwrote PATH",
    )
    fixture.install_file.write_text("invalid")
    require(
        fixture.run(["rx-agent", "--version"], env=path_environment).stdout.strip()
        == b"source-fixture",
        "external lookup read managed state",
    )
    fixture.install_file.write_bytes(before)
    fixture.checks["external_agent_precedes_management_without_update"] = {
        "order": ["PATH", "beside Rx", "managed"],
        "network_requests": 0,
        "managed_state_unchanged": True,
        "path_file_unchanged": True,
    }
    beside_agent.unlink()
    require(
        fixture.run(["rx-agent", "--version"]).stdout.strip().decode()
        == fixture.versions[2],
        "managed fallback unavailable",
    )
    require(
        fixture.update_file.read_bytes() == before_check
        and fixture.state["release_requests"] == requests,
        "RX_NO_UPDATE allowed maintenance",
    )
    fixture.checks["no_update_disables_background"] = True
