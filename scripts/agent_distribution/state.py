import tomllib
from .support import Acp, require


def repair_update_record(fixture):
    fixture.update_file.write_text("invalid update state")
    requests = fixture.state["release_requests"]
    repaired = Acp(fixture.acp_command, fixture.active_environment, fixture.work)
    repaired.close()
    fixture.wait_checked(requests)
    require(
        not fixture.helper_pids()
        and bool(tomllib.loads(fixture.update_file.read_text()).get("last_check")),
        "corrupt check state was not repaired",
    )
    fixture.checks["corrupt_update_record_repaired_by_helper"] = True
