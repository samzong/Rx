import fcntl
import os
import re
import subprocess
import time
import tomllib
from .support import Acp, require, wait_for


def check_background_updates(fixture):
    before = fixture.install_file.read_bytes()
    fixture.state.update(version=fixture.versions[1], bad_hash=True)
    fixture.overdue()
    requests = fixture.state["release_requests"]
    bad_hash = Acp(fixture.acp_command, fixture.active_environment, fixture.work)
    bad_hash.close()
    fixture.wait_checked(requests)
    require(fixture.install_file.read_bytes() == before, "bad hash changed selection")
    require(
        fixture.run(["rx-agent", "--version"]).stdout.strip().decode()
        == fixture.versions[0],
        "bad hash damaged active binary",
    )
    fixture.checks["bad_hash_preserves_selection"] = True
    fixture.state["bad_hash"] = False
    fixture.overdue()
    before_requests = fixture.state["release_requests"]
    with fixture.lock_file.open("r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        start = time.monotonic()
        locked = Acp(fixture.acp_command, fixture.active_environment, fixture.work)
        locked.close()
        wait_for(lambda: not fixture.helper_pids())
        require(
            fixture.state["release_requests"] == before_requests,
            "busy helper reached the network",
        )
        require(
            fixture.install_file.read_bytes() == before, "busy helper changed selection"
        )
        fixture.checks["concurrent_lock"] = {
            "seconds": time.monotonic() - start,
            "network_requests": 0,
        }
    fixture.checks["busy_helper_exits_before_network"] = True
    fixture.rx_update_file.write_text(
        f'auto_update = true\nlast_check = "{int(time.time())}"\n'
    )
    fixture.overdue()
    fixture.state["block_archive"] = True
    fixture.requested.clear()
    fixture.unblock.clear()
    first_seconds = fixture.launch_terminal(
        fixture.active_environment, fixture.versions[0]
    )
    require(
        fixture.requested.wait(timeout=5),
        "terminal updater did not reach its locked download",
    )
    require(
        fixture.install_file.read_bytes() == before,
        "blocked download switched the current version",
    )
    requests = fixture.state["release_requests"]
    fixture.overdue()
    second_seconds = fixture.launch_terminal(
        fixture.active_environment, fixture.versions[0]
    )
    require(
        fixture.state["release_requests"] == requests,
        "a competing helper reached the network",
    )
    fixture.unblock.set()
    wait_for(
        lambda: (
            tomllib.loads(fixture.install_file.read_text())["current"]["version"]
            == fixture.versions[1]
        )
    )
    wait_for(lambda: not fixture.helper_pids())
    fixture.state["block_archive"] = False
    next_seconds = fixture.launch_terminal(
        fixture.active_environment, fixture.versions[1]
    )
    fixture.checks["terminal_background_update"] = {
        "current_version": fixture.versions[0],
        "next_version": fixture.versions[1],
        "blocked_start_seconds": first_seconds,
        "competing_start_seconds": second_seconds,
        "next_start_seconds": next_seconds,
    }
    before = fixture.install_file.read_bytes()
    fixture.managed_versions.chmod(0o500)
    fixture.state["version"] = fixture.versions[2]
    fixture.overdue()
    requests = fixture.state["release_requests"]
    try:
        failed = Acp(fixture.acp_command, fixture.active_environment, fixture.work)
        failed.close()
        fixture.wait_checked(requests)
    finally:
        fixture.managed_versions.chmod(0o700)
    require(
        fixture.install_file.read_bytes() == before,
        "permission failure changed selection",
    )
    fixture.checks["permission_failure_preserves_selection"] = True
    fixture.rx_update_file.write_bytes(fixture.rx_update_before)
    fixture.overdue()
    fixture.state["offline"] = True
    offline = Acp(fixture.acp_command, fixture.active_environment, fixture.work)
    require(offline.seconds < 2.5, "ACP waited for offline update")
    offline.request("session/list", {})
    offline.close()
    fixture.checks["overdue_offline_acp"] = {
        "seconds": offline.seconds,
        "version": offline.initialize["agentInfo"]["version"],
    }
    require(
        fixture.rx_update_file.read_bytes() == fixture.rx_update_before,
        "ACP touched the Rx self-update state",
    )
    fixture.checks["acp_skips_rx_always_update"] = True
    wait_for(
        lambda: tomllib.loads(fixture.update_file.read_text()).get("last_check") != "0"
    )
    wait_for(lambda: not fixture.helper_pids())
    fixture.state["offline"] = False
    fixture.overdue()
    fixture.requested.clear()
    fixture.unblock.clear()
    fixture.state["block_archive"] = True
    updating = Acp(fixture.acp_command, fixture.active_environment, fixture.work)
    require(
        fixture.requested.wait(timeout=5),
        "background updater did not reach the blocked download",
    )
    helpers = fixture.helper_pids()
    require(len(helpers) == 1, "expected one detached updater")
    helper = helpers[0]
    raw_environment = subprocess.check_output(
        ["ps", "eww", "-p", str(helper), "-o", "command="], text=True
    )
    environment_names = sorted(
        set(re.findall("(?:^| )([A-Za-z_][A-Za-z0-9_]*)=", raw_environment))
    )
    require(
        not any(
            (
                name in raw_environment
                for name in [
                    "RX_AGENT_PROVIDER",
                    "OPENAI_API_KEY",
                    "ANTHROPIC_API_KEY",
                    "CUSTOM_API_KEY",
                    "AWS_SECRET_ACCESS_KEY",
                ]
            )
        ),
        "helper inherited provider credentials",
    )
    require(
        "fixture-secret-" not in raw_environment
        and "fixture-not-a-secret" not in raw_environment,
        "helper inherited a credential value",
    )
    if os.uname().sysname == "Darwin":
        descriptors = subprocess.check_output(
            ["/usr/sbin/lsof", "-a", "-p", str(helper), "-d", "0,1,2", "-Fn"], text=True
        )
        names = [line[1:] for line in descriptors.splitlines() if line.startswith("n")]
    else:
        names = [os.readlink(f"/proc/{helper}/fd/{number}") for number in range(3)]
    require(names == ["/dev/null"] * 3, "helper retains protocol stdio")
    updating.request("session/list", {})
    require(
        updating.initialize["agentInfo"]["version"] == fixture.versions[1],
        "current launch followed background activation",
    )
    fixture.checks["live_helper_isolation"] = {
        "pid": helper,
        "environment_names": environment_names,
        "stdio": names,
        "ndjson_responses": len(updating.messages),
        "launch_version": updating.initialize["agentInfo"]["version"],
    }
    fixture.unblock.set()
    updating.close()
    wait_for(
        lambda: (
            tomllib.loads(fixture.install_file.read_text())["current"]["version"]
            == fixture.versions[2]
        )
    )
    wait_for(lambda: not fixture.helper_pids())
    fixture.state["block_archive"] = False
    new = Acp(fixture.acp_command, fixture.environment, fixture.work)
    require(
        new.initialize["agentInfo"]["version"] == fixture.versions[2],
        "next ACP did not select new version",
    )
    new.close()
