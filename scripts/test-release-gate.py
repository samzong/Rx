import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

GATE_PATH = Path(__file__).with_name("release-gate.py")
SPEC = importlib.util.spec_from_file_location("release_gate", GATE_PATH)
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)

REPO_ROOT = Path(__file__).resolve().parent.parent
CORE_CLIFF = REPO_ROOT / "cliff.toml"
AGENT_CLIFF = REPO_ROOT / "agent" / "cliff.toml"
CORE_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "release.yml"
AGENT_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "agent-release.yml"

GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}


def init_repo(root: Path) -> None:
    subprocess.run(["git", "-C", str(root), "init", "-q"], env=GIT_ENV, check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.com"], env=GIT_ENV, check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], env=GIT_ENV, check=True)


def commit_file(root: Path, rel: str, content: str, message: str, tag: str | None = None) -> str:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "add", rel], env=GIT_ENV, check=True)
    subprocess.run(["git", "-C", str(root), "commit", "-q", "-m", message], env=GIT_ENV, check=True)
    if tag:
        subprocess.run(["git", "-C", str(root), "tag", "-a", tag, "-m", tag], env=GIT_ENV, check=True)
    return subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], env=GIT_ENV, text=True).strip()


def run_gate(args: list[str], cwd: Path = REPO_ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(GATE_PATH), *args],
        cwd=cwd,
        env=GIT_ENV,
        capture_output=True,
        text=True,
        check=False,
    )


class ReleaseGateTests(unittest.TestCase):
    def test_step1_rejects_malformed_tags_and_manifest_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            init_repo(repo)
            commit_file(repo, "Cargo.toml", '[package]\nname = "rx"\nversion = "0.3.0-rc.1"\n', "chore(release): prepare core", "v0.3.0-rc.1")
            commit_file(repo, "agent/package.json", '{"name": "rx-agent", "version": "0.3.0-beta.2"}\n', "chore(release): prepare agent", "rx-agent-v0.3.0-beta.2")

            ok_agent = run_gate(["validate", "--artifact", "agent", "--tag", "rx-agent-v0.3.0-beta.2", "--repo", str(repo)])
            self.assertEqual(0, ok_agent.returncode, ok_agent.stderr)
            agent_data = json.loads(ok_agent.stdout)
            self.assertTrue(agent_data["is_prerelease"])
            self.assertFalse(agent_data["make_latest"])

            subprocess.run(["git", "-C", str(repo), "checkout", "-q", "v0.3.0-rc.1"], env=GIT_ENV, check=True)
            ok_core = run_gate(["validate", "--artifact", "core", "--tag", "v0.3.0-rc.1", "--repo", str(repo)])
            self.assertEqual(0, ok_core.returncode, ok_core.stderr)
            core_data = json.loads(ok_core.stdout)
            self.assertTrue(core_data["is_prerelease"])
            self.assertFalse(core_data["make_latest"])

            bad_tags = [
                ("core", "v0.1.0-dev.1"),
                ("core", "v0.1.0-fix.1"),
                ("core", "v01.2.0"),
                ("core", "v0.1.0-alpha.0"),
                ("core", "v0.1.0-rc.01"),
                ("core", "rx-agent-v0.3.0-rc.1"),
                ("agent", "rx-agent-v0.1.0-dev.1"),
                ("agent", "rx-agent-v01.2.0"),
                ("agent", "rx-agent-v0.1.0-beta.0"),
                ("agent", "v0.3.0-beta.2"),
            ]
            for artifact, tag in bad_tags:
                with self.assertRaises(ValueError):
                    GATE.parse_tag(artifact, tag)
                res = run_gate(["validate", "--artifact", artifact, "--tag", tag, "--repo", str(repo)])
                self.assertNotEqual(0, res.returncode, f"expected failure for {artifact} {tag}")
                self.assertIn("Invalid SemVer release tag", res.stderr)

            mismatch = run_gate(["validate", "--artifact", "core", "--tag", "v0.3.0", "--repo", str(repo)])
            self.assertNotEqual(0, mismatch.returncode)
            self.assertIn("does not match", mismatch.stderr)

            commit_file(repo, "README.md", "moved\n", "fix: move head")
            moved = run_gate(["validate", "--artifact", "core", "--tag", "v0.3.0-rc.1", "--repo", str(repo)])
            self.assertNotEqual(0, moved.returncode)
            self.assertIn("does not match release tag", moved.stderr)

    def test_release_flags_and_publish_verification_reject_latest_leakage(self):
        core_stable = GATE.build_release_flags("core", "v0.3.0", "create", "notes.md")
        self.assertIn("--latest", core_stable)
        self.assertNotIn("--prerelease", core_stable)
        self.assertNotIn("--latest=false", core_stable)

        core_pre = GATE.build_release_flags("core", "v0.3.0-rc.1", "create", "notes.md")
        self.assertIn("--prerelease", core_pre)
        self.assertIn("--latest=false", core_pre)
        self.assertNotIn("--latest", core_pre)

        agent_stable = GATE.build_release_flags("agent", "rx-agent-v0.3.0", "create", "notes.md")
        self.assertIn("--latest=false", agent_stable)
        self.assertNotIn("--prerelease", agent_stable)
        self.assertNotIn("--latest", agent_stable)

        agent_pre = GATE.build_release_flags("agent", "rx-agent-v0.3.0-alpha.2", "create", "notes.md")
        self.assertIn("--prerelease", agent_pre)
        self.assertIn("--latest=false", agent_pre)
        self.assertNotIn("--latest", agent_pre)

        for artifact, tag, bad_flags in [
            ("core", "v0.3.0-rc.1", ["--latest"]),
            ("core", "v0.3.0-rc.1", ["--latest=false"]),
            ("core", "v0.3.0", ["--latest=false"]),
            ("core", "v0.3.0", ["--prerelease", "--latest"]),
            ("agent", "rx-agent-v0.3.0", ["--latest"]),
            ("agent", "rx-agent-v0.3.0", []),
            ("agent", "rx-agent-v0.3.0-beta.1", ["--latest=false"]),
            ("agent", "rx-agent-v0.3.0-beta.1", ["--prerelease", "--latest"]),
        ]:
            res = run_gate(["assert-flags", "--artifact", artifact, "--tag", tag, "--", *bad_flags])
            self.assertNotEqual(0, res.returncode, f"expected flag rejection for {artifact} {tag} {bad_flags}")

        GATE.verify_published("core", "v0.3.0", "v0.3.0", "false", "false", "v0.3.0")
        GATE.verify_published("core", "v0.3.0-rc.1", "v0.3.0-rc.1", "true", "false", "v0.2.1")
        GATE.verify_published("agent", "rx-agent-v0.3.0", "rx-agent-v0.3.0", "false", "false", "v0.2.1")
        GATE.verify_published("agent", "rx-agent-v0.3.0-alpha.1", "rx-agent-v0.3.0-alpha.1", "true", "false", "v0.2.1")

        for args in [
            ("core", "v0.3.0-rc.1", "v0.3.0-rc.1", "false", "false", "v0.2.1"),
            ("core", "v0.3.0-rc.1", "v0.3.0-rc.1", "true", "false", "v0.3.0-rc.1"),
            ("agent", "rx-agent-v0.3.0", "rx-agent-v0.3.0", "false", "false", "rx-agent-v0.3.0"),
            ("core", "v0.3.0", "v0.3.0", "false", "false", "v0.2.1"),
            ("core", "v0.3.0", "v0.3.0", "false", "true", "v0.3.0"),
        ]:
            with self.assertRaises(ValueError):
                GATE.verify_published(*args)

        self.assertEqual("v0.2.1", GATE.parse_latest_api_result(0, "v0.2.1\n", ""))
        self.assertEqual("", GATE.parse_latest_api_result(1, "", "gh: Not Found (HTTP 404)"))
        with self.assertRaises(ValueError):
            GATE.parse_latest_api_result(1, "", "gh: Bad Gateway (HTTP 502)")

    def test_git_cliff_configs_isolate_core_and_agent_commits_and_tags(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            init_repo(repo)
            commit_file(repo, "Cargo.toml", '[package]\nname = "rx"\nversion = "0.1.0"\n', "feat: init core", "v0.1.0")
            commit_file(repo, "agent/package.json", '{"version": "0.1.0"}\n', "feat(agent): init agent", "rx-agent-v0.1.0")
            commit_file(repo, "src/lib.rs", "pub fn core() {}\n", "feat(core): add core launcher feature")
            commit_file(repo, "agent/src/cli.ts", "export const v = 1;\n", "fix(agent): repair agent prompt loop")
            commit_file(repo, "Cargo.toml", '[package]\nname = "rx"\nversion = "0.2.0"\n', "chore(release): bump core")
            subprocess.run(["git", "-C", str(repo), "tag", "-a", "v0.2.0", "-m", "v0.2.0"], env=GIT_ENV, check=True)
            subprocess.run(["git", "-C", str(repo), "tag", "-a", "rx-agent-v0.2.0", "-m", "rx-agent-v0.2.0"], env=GIT_ENV, check=True)

            core_out = Path(tmp) / "core-notes.md"
            agent_out = Path(tmp) / "agent-notes.md"
            core_notes = GATE.generate_notes(repo, "core", "v0.2.0", CORE_CLIFF, core_out)
            agent_notes = GATE.generate_notes(repo, "agent", "rx-agent-v0.2.0", AGENT_CLIFF, agent_out)

            self.assertIn("## [0.2.0]", core_notes)
            self.assertIn("add core launcher feature", core_notes)
            self.assertNotIn("repair agent prompt loop", core_notes)
            self.assertNotIn("init agent", core_notes)

            self.assertIn("## [0.2.0]", agent_notes)
            self.assertIn("repair agent prompt loop", agent_notes)
            self.assertNotIn("add core launcher feature", agent_notes)

            commit_file(repo, "Cargo.toml", '[package]\nname = "rx"\nversion = "0.2.1"\n', "chore(release): bump core 0.2.1", "v0.2.1")
            quiet_notes = GATE.generate_notes(repo, "core", "v0.2.1", CORE_CLIFF, core_out)
            self.assertIn("## [0.2.1]", quiet_notes)
            self.assertIn("No user-facing changes.", quiet_notes)

            bad_cliff = Path(tmp) / "empty.toml"
            bad_cliff.write_text('[changelog]\nheader = ""\nbody = ""\ntrim = true\nfooter = ""\n[git]\n', encoding="utf-8")
            with self.assertRaises(ValueError):
                GATE.generate_notes(repo, "core", "v0.2.1", bad_cliff, core_out)

            subprocess.run(["git", "-C", str(repo), "checkout", "-q", "v0.1.0"], env=GIT_ENV, check=True)
            first_core = GATE.generate_notes(repo, "core", "v0.1.0", CORE_CLIFF, core_out)
            self.assertIn("## [0.1.0]", first_core)
            self.assertIn("init core", first_core)

    def test_workflow_regexes_reject_malformed_tags(self):
        core_wf = CORE_WORKFLOW.read_text(encoding="utf-8")
        agent_wf = AGENT_WORKFLOW.read_text(encoding="utf-8")
        core_match = re.search(r"\$RELEASE_TAG\"? =~ (\^[^\s]+)", core_wf)
        agent_match = re.search(r"\$RELEASE_TAG\"? =~ (\^[^\s]+)", agent_wf)
        self.assertIsNotNone(core_match)
        self.assertIsNotNone(agent_match)

        for label, pattern, good, bad in [
            (
                "core",
                core_match.group(1),
                ["v0.2.1", "v0.3.0-alpha.1", "v1.0.0-beta.2", "v1.2.3-rc.10"],
                ["v0.1.0-dev.1", "v0.1.0-fix.1", "v01.2.0", "v0.1.0-alpha.0", "rx-agent-v0.2.0"],
            ),
            (
                "agent",
                agent_match.group(1),
                ["rx-agent-v0.2.0", "rx-agent-v0.3.0-alpha.1", "rx-agent-v1.0.0-rc.3"],
                ["rx-agent-v0.1.0-dev.1", "rx-agent-v01.2.0", "rx-agent-v0.1.0-rc.0", "v0.2.1"],
            ),
        ]:
            res = subprocess.run(
                [
                    "bash",
                    "-c",
                    'pat="$1"; shift; for t in "$@"; do [[ "$t" =~ $pat ]] && echo "MATCH:$t" || echo "FAIL:$t"; done',
                    "_",
                    pattern,
                    *good,
                    *bad,
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            lines = {tag: status for line in res.stdout.splitlines() for status, tag in [line.split(":", 1)]}
            for t in good:
                self.assertEqual("MATCH", lines[t], f"{label} expected match for {t}")
            for t in bad:
                self.assertEqual("FAIL", lines[t], f"{label} expected failure for {t}")


if __name__ == "__main__":
    unittest.main()
