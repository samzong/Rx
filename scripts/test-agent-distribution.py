import argparse
from pathlib import Path
import os
import json

from agent_distribution.support import Acp, require, terminal
from agent_distribution.fixture import Fixture
from agent_distribution.installation import (
    check_missing_and_refusal,
    start_managed_session,
)
from agent_distribution.state import repair_update_record
from agent_distribution.updates import check_background_updates
from agent_distribution.retention import check_retention
from agent_distribution.proxy import check_proxy
from agent_distribution.selection import check_external_selection


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rx", type=Path, required=True)
    parser.add_argument("--agent", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--live-model")
    args = parser.parse_args()
    require(os.name == "posix", "this native probe requires Unix PTYs and flock")
    repository = Path(__file__).resolve().parents[1]
    fixture = Fixture(args, repository)
    check_missing_and_refusal(fixture)
    fixture.prepare_releases()
    try:
        start_managed_session(fixture)
        repair_update_record(fixture)
        check_background_updates(fixture)
        check_retention(fixture)
        check_proxy(fixture)
        check_external_selection(fixture)
        fixture.report["result"] = "pass"
    finally:
        fixture.unblock.set()
        if fixture.old is not None and fixture.old.process.poll() is None:
            fixture.old.process.kill()
            fixture.old.process.wait()
        fixture.server.shutdown()
        args.output.write_text(json.dumps(fixture.report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "result": fixture.report["result"],
                "checks": fixture.checks,
                "evidence": str(args.output),
                "scratch": str(fixture.scratch),
            }
        )
    )


if __name__ == "__main__":
    main()
