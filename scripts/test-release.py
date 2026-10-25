import contextlib
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SHA = "a" * 40

FAKE_GH = '''#!/usr/bin/env python3
import hashlib
import json
import os
import sys
from pathlib import Path
state_path = Path(os.environ["FAKE_GH_STATE"])
state = json.loads(state_path.read_text())
args = sys.argv[1:]
state["calls"].append(args)
code = 200
body = None
if args[0] == "api":
    endpoint = args[-1]
    if "/git/ref/tags/" in endpoint:
        body = {"object": {"type": "tag" if state.get("annotated") else "commit", "sha": state.get("remote_sha", "a" * 40)}}
    elif "/git/tags/" in endpoint:
        body = {"object": {"type": "commit", "sha": state.get("remote_sha", "a" * 40)}}
    elif endpoint.endswith("/latest"):
        tag = state.get("latest")
        body = {"tag_name": tag} if tag else None
    else:
        body = state.get("release")
    if body is None:
        code = state.get("missing_status", 404)
        body = {"message": "Not Found"}
else:
    operation = args[1]
    if operation in ("create", "upload"):
        assets = []
        for arg in args:
            path = Path(arg)
            if path.is_file() and path.parent.name == "assets":
                assets.append({"name": path.name, "size": path.stat().st_size, "state": "uploaded", "digest": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()})
        state["release"] = {"draft": False, "prerelease": False, "assets": assets}
    if "--latest" in args:
        state["latest"] = args[2]
    if state.get("hijack"):
        state["latest"] = state["hijack"]
    if state.get("bad_digest"):
        state["release"]["assets"][0]["digest"] = "sha256:bad"
state_path.write_text(json.dumps(state))
if args[0] == "api":
    print(f"HTTP/2.0 {code} Status\\n\\n" + json.dumps(body))
    sys.exit(0 if code == 200 else 1)
'''


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rx-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / "assets"
        self.directory.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        gh = self.bin / "gh"
        gh.write_text(FAKE_GH)
        gh.chmod(0o755)
        self.state = self.root / "state.json"
        self.env = patch.dict(os.environ, {"FAKE_GH_STATE": str(self.state), "PATH": str(self.bin) + os.pathsep + os.environ["PATH"]})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.tag_patch = patch.object(release, "validate_tag", return_value=SHA)
        self.tag_patch.start()
        self.addCleanup(self.tag_patch.stop)
        self.configure()

    def configure(self, **values):
        state = {"latest": "v0.1.0", "calls": []}
        state.update(values)
        self.state.write_text(json.dumps(state))

    def fixture(self, product="rx-agent"):
        for name in release.ASSETS[product]:
            binary = product + (".exe" if name.endswith(".zip") else "")
            path = self.directory / name
            if name.endswith(".zip"):
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr(binary, b"binary")
            else:
                with tarfile.open(path, "w:gz") as archive:
                    info = tarfile.TarInfo(binary)
                    info.size = 6
                    info.mode = 0o755
                    archive.addfile(info, io.BytesIO(b"binary"))
            (self.directory / (name.removesuffix(".tar.gz").removesuffix(".zip") + ".sha")).write_text(SHA + "\n")

    def publish(self, product="rx-agent"):
        tag = "rx-agent-v0.1.0" if product == "rx-agent" else "v0.1.0"
        with contextlib.redirect_stdout(io.StringIO()):
            release.publish(product, tag, SHA, self.directory, "owner/repo")
        return json.loads(self.state.read_text())

    def mutations(self):
        return [call for call in json.loads(self.state.read_text())["calls"] if call[0] == "release"]

    def test_agent_create_preserves_latest_and_uploads_only_manifest_assets(self):
        self.fixture()
        state = self.publish()
        create = self.mutations()[0]
        self.assertIn("--latest=false", create)
        self.assertIn("--verify-tag", create)
        self.assertEqual(state["latest"], "v0.1.0")
        lines = (self.directory / "SHA256SUMS").read_text().splitlines()
        self.assertEqual(len(lines), 4)
        for line in lines:
            checksum, name = line.split("  ")
            self.assertEqual(checksum, hashlib.sha256((self.directory / name).read_bytes()).hexdigest())
        self.assertEqual(len(state["release"]["assets"]), 5)

    def test_annotated_tag_is_peeled_to_the_compiled_commit(self):
        self.fixture()
        self.configure(annotated=True)
        state = self.publish()
        self.assertTrue(any("/git/tags/" in call[-1] for call in state["calls"]))

    def test_agent_rerun_explicitly_sets_latest_false(self):
        self.fixture()
        self.publish()
        state = self.publish()
        self.assertEqual(self.mutations()[-1][:3], ["release", "edit", "rx-agent-v0.1.0"])
        self.assertIn("--latest=false", self.mutations()[-1])
        self.assertEqual(state["latest"], "v0.1.0")
        self.assertFalse(any(call[1] == "upload" for call in self.mutations()))

    def test_rx_create_and_rerun_explicitly_select_latest(self):
        self.fixture("rx")
        self.configure(latest="v0.0.9")
        self.publish("rx")
        self.assertIn("--latest", self.mutations()[0])
        self.publish("rx")
        self.assertIn("--latest", self.mutations()[-1])

    def test_no_latest_stays_absent(self):
        self.fixture()
        self.configure(latest=None)
        self.assertIsNone(self.publish()["latest"])

    def test_concurrent_rx_publication_is_reported_without_correction(self):
        self.fixture()
        self.configure(hijack="v0.2.0")
        with self.assertRaisesRegex(RuntimeError, "Latest release changed"):
            self.publish()
        self.assertEqual(len(self.mutations()), 1)
        self.assertEqual(json.loads(self.state.read_text())["latest"], "v0.2.0")

    def test_agent_becoming_latest_fails_readback(self):
        self.fixture()
        self.configure(latest=None, hijack="rx-agent-v0.1.0")
        with self.assertRaisesRegex(RuntimeError, "Latest release changed"):
            self.publish()

    def test_bad_initial_latest_stops_before_mutation(self):
        self.fixture()
        self.configure(latest="rx-agent-v0.1.0")
        with self.assertRaisesRegex(RuntimeError, "not an Rx release"):
            self.publish()
        self.assertEqual(self.mutations(), [])

    def test_http_failure_is_not_no_latest(self):
        self.fixture()
        self.configure(latest=None, missing_status=403)
        with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
            self.publish()
        self.assertEqual(self.mutations(), [])

    def test_moved_remote_tag_stops_before_mutation(self):
        self.fixture()
        self.configure(remote_sha="b" * 40)
        with self.assertRaisesRegex(RuntimeError, "Remote tag moved"):
            self.publish()
        self.assertEqual(self.mutations(), [])

    def test_wrong_build_commit_stops_before_mutation(self):
        self.fixture()
        (self.directory / "rx-agent-linux-x64.sha").write_text("b" * 40)
        with self.assertRaisesRegex(RuntimeError, "Build commit differs"):
            self.publish()
        self.assertEqual(self.mutations(), [])

    def test_extra_missing_or_wrong_product_assets_fail(self):
        self.fixture("rx")
        with self.assertRaisesRegex(RuntimeError, "platform list"):
            release.prepare("rx-agent", "rx-agent-v0.1.0", SHA, self.directory)
        (self.directory / "rx-linux-x86_64.tar.gz").unlink()
        with self.assertRaisesRegex(RuntimeError, "platform list"):
            release.prepare("rx", "v0.1.0", SHA, self.directory)

    def test_archive_with_agent_inside_rx_is_rejected(self):
        self.fixture("rx")
        with tarfile.open(self.directory / "rx-linux-x86_64.tar.gz", "w:gz") as archive:
            for name in ["rx", "rx-agent"]:
                info = tarfile.TarInfo(name)
                info.size = 1
                info.mode = 0o755
                archive.addfile(info, io.BytesIO(b"x"))
        with self.assertRaisesRegex(RuntimeError, "only executable rx"):
            release.prepare("rx", "v0.1.0", SHA, self.directory)

    def test_bad_uploaded_digest_fails_readback(self):
        self.fixture()
        self.configure(bad_digest=True)
        with self.assertRaisesRegex(RuntimeError, "checksum differs"):
            self.publish()

    def test_tag_matches_package_and_checked_out_commit(self):
        self.tag_patch.stop()
        (self.root / "agent").mkdir()
        (self.root / "agent/package.json").write_text('{"version":"0.1.0"}')
        with patch.object(release, "ROOT", self.root), patch.object(release, "git", return_value=SHA):
            self.assertEqual(release.validate_tag("rx-agent", "rx-agent-v0.1.0"), SHA)
            for tag in ["rx-agent-v0.1.1", "v0.1.0", "rx-agent-v0.1.0;touch /tmp/injected"]:
                with self.assertRaisesRegex(RuntimeError, "does not match"):
                    release.validate_tag("rx-agent", tag)
        with patch.object(release, "ROOT", self.root), patch.object(release, "git", side_effect=[SHA, "b" * 40]):
            with self.assertRaisesRegex(RuntimeError, "checked out commit"):
                release.validate_tag("rx-agent", "rx-agent-v0.1.0")


if __name__ == "__main__":
    unittest.main()
