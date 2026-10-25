import uuid
from .support import require


def check_retention(fixture):
    require(
        not (fixture.managed_versions / fixture.versions[0]).exists(),
        "the oldest version directory remains",
    )
    retained = sorted((p.name for p in fixture.managed_versions.iterdir()))
    require(
        retained == fixture.versions[1:],
        "cleanup did not retain only current and previous versions",
    )
    initialized = fixture.old.request(
        "initialize", {"protocolVersion": 1, "clientCapabilities": {}}
    )
    require(
        initialized["agentInfo"]["version"] == fixture.versions[0],
        "the unlinked process did not initialize as its original version",
    )
    listed = fixture.old.request("session/list", {})
    require(
        any(
            (item["sessionId"] == fixture.old_session_id for item in listed["sessions"])
        ),
        "old session stopped after background update",
    )
    fixture.checks["unlinked_old_process"] = {
        "version": fixture.versions[0],
        "directory_exists": False,
        "initialize": True,
        "session_list": True,
    }
    if fixture.args.live_model:
        marker = "RETENTION_" + uuid.uuid4().hex
        (fixture.work / "retention-marker.txt").write_text(marker + "\n")
        turn = fixture.old.request(
            "session/prompt",
            {
                "sessionId": fixture.old_session_id,
                "prompt": [
                    {
                        "type": "text",
                        "text": "Use the read tool to read retention-marker.txt. Reply with its contents only.",
                    }
                ],
            },
            timeout=90,
        )
        updates = [
            item.get("params", {}).get("update", {}) for item in fixture.old.messages
        ]
        calls = [
            item
            for item in updates
            if item.get("sessionUpdate") == "tool_call" and item.get("kind") == "read"
        ]
        answer = "".join(
            (
                item.get("content", {}).get("text", "")
                for item in updates
                if item.get("sessionUpdate") == "agent_message_chunk"
            )
        )
        require(
            turn.get("stopReason") == "end_turn" and calls and (marker in answer),
            "the unlinked process did not complete the live read-tool round",
        )
        fixture.checks["unlinked_old_process"]["live_round"] = {
            "model": fixture.args.live_model,
            "stop_reason": turn["stopReason"],
            "read_tool_calls": len(calls),
            "answer_matches_file": True,
        }
    else:
        fixture.checks["unlinked_old_process"]["live_round"] = (
            "not requested; no provider credentials supplied"
        )
    fixture.old.close()
    fixture.old = None
    fixture.checks["background_update"] = {
        "new_version": fixture.versions[2],
        "old_session_still_lists": True,
        "retained_versions": retained,
    }
