import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import tomllib

SEMVER_BODY = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.([1-9][0-9]*))?"
STAGE_ORDER = {"alpha": 0, "beta": 1, "rc": 2, None: 3}

ARTIFACTS = {
    "core": {
        "prefix": "v",
        "manifest": "Cargo.toml",
        "cliff": "cliff.toml",
    },
    "agent": {
        "prefix": "rx-agent-v",
        "manifest": "agent/package.json",
        "cliff": "agent/cliff.toml",
    },
}


def parse_tag(artifact: str, tag: str) -> tuple[str, tuple[int, int, int, int, int], bool]:
    spec = ARTIFACTS[artifact]
    prefix = spec["prefix"]
    pattern = re.compile(rf"^{re.escape(prefix)}{SEMVER_BODY}$")
    match = pattern.fullmatch(tag)
    if not match:
        raise ValueError(f"Invalid SemVer release tag for {artifact}: {tag}")
    major, minor, patch, stage, num = match.groups()
    version = tag[len(prefix) :]
    key = (int(major), int(minor), int(patch), STAGE_ORDER[stage], int(num or 0))
    return version, key, stage is not None


def read_manifest_version(artifact: str, manifest_path: Path) -> str:
    if not manifest_path.is_file():
        raise ValueError(f"Missing manifest file: {manifest_path}")
    raw = manifest_path.read_text(encoding="utf-8")
    if artifact == "core":
        data = tomllib.loads(raw)
        version = data.get("package", {}).get("version")
        if not isinstance(version, str):
            version = data.get("workspace", {}).get("package", {}).get("version")
        if not isinstance(version, str) or not version:
            raise ValueError(f"Missing package version in {manifest_path}")
        return version
    data = json.loads(raw)
    version = data.get("version")
    if not isinstance(version, str) or not version:
        raise ValueError(f"Missing version in {manifest_path}")
    return version


def git_output(repo: Path, args: list[str]) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise ValueError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout.strip()


def validate_release(artifact: str, tag: str, manifest_path: Path, repo: Path) -> dict[str, object]:
    version, _, is_prerelease = parse_tag(artifact, tag)
    manifest_version = read_manifest_version(artifact, manifest_path)
    if manifest_version != version:
        raise ValueError(
            f"Release tag {tag} version {version} does not match {manifest_path.as_posix()} version {manifest_version}"
        )
    head_sha = git_output(repo, ["rev-parse", "--verify", "HEAD"])
    tag_sha = git_output(repo, ["rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"])
    if head_sha != tag_sha:
        raise ValueError(f"Checked out commit {head_sha} does not match release tag {tag} commit {tag_sha}")
    make_latest = artifact == "core" and not is_prerelease
    return {
        "artifact": artifact,
        "tag": tag,
        "version": version,
        "sha": head_sha,
        "is_prerelease": is_prerelease,
        "make_latest": make_latest,
    }


def build_release_flags(
    artifact: str,
    tag: str,
    action: str = "create",
    notes_file: str | None = None,
) -> list[str]:
    _, _, is_prerelease = parse_tag(artifact, tag)
    make_latest = artifact == "core" and not is_prerelease
    flags = ["--title", tag]
    if action == "create":
        flags.append("--verify-tag")
    if notes_file:
        flags.extend(["--notes-file", notes_file])
    if is_prerelease:
        flags.extend(["--prerelease", "--latest=false"])
    elif make_latest:
        if action == "edit":
            flags.append("--prerelease=false")
        flags.append("--latest")
    else:
        if action == "edit":
            flags.append("--prerelease=false")
        flags.append("--latest=false")
    assert_release_flags(artifact, tag, flags)
    return flags


def assert_release_flags(artifact: str, tag: str, flags: list[str]) -> None:
    _, _, is_prerelease = parse_tag(artifact, tag)
    expect_latest = artifact == "core" and not is_prerelease
    has_prerelease = "--prerelease" in flags or "--prerelease=true" in flags
    has_latest = "--latest" in flags or "--latest=true" in flags
    has_not_latest = "--latest=false" in flags
    if is_prerelease and not has_prerelease:
        raise ValueError(f"Prerelease {tag} requires --prerelease")
    if not is_prerelease and has_prerelease:
        raise ValueError(f"Stable release {tag} must not set --prerelease")
    if expect_latest:
        if not has_latest or has_not_latest:
            raise ValueError(f"Stable core release {tag} requires --latest")
    else:
        if has_latest:
            raise ValueError(f"--latest is forbidden for {artifact} release {tag}")
        if not has_not_latest:
            raise ValueError(f"--latest=false is required for {artifact} release {tag}")


def verify_published(
    artifact: str,
    tag: str,
    actual_tag: str,
    actual_prerelease: str,
    actual_draft: str,
    latest_tag: str,
) -> None:
    _, _, is_prerelease = parse_tag(artifact, tag)
    expect_latest = artifact == "core" and not is_prerelease
    if actual_tag != tag:
        raise ValueError(f"Published release tag {actual_tag!r} does not equal {tag!r}")
    expected_prerelease = "true" if is_prerelease else "false"
    if actual_prerelease.strip().lower() != expected_prerelease:
        raise ValueError(
            f"Published release {tag} prerelease={actual_prerelease!r} does not equal {expected_prerelease!r}"
        )
    if actual_draft.strip().lower() != "false":
        raise ValueError(f"Published release {tag} must not remain a draft")
    if expect_latest:
        if latest_tag != tag:
            raise ValueError(f"Repository latest release {latest_tag!r} does not equal stable core tag {tag!r}")
    elif latest_tag == tag:
        raise ValueError(f"Repository latest release must not point to {artifact} tag {tag}")


def find_previous_tag(repo: Path, artifact: str, tag: str) -> str | None:
    _, target_key, _ = parse_tag(artifact, tag)
    target_commit = git_output(repo, ["rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"])
    raw_tags = git_output(
        repo,
        ["for-each-ref", f"--merged={target_commit}", "--format=%(refname:short)", "refs/tags"],
    )
    candidates: list[tuple[int, tuple[int, ...], str]] = []
    for candidate in raw_tags.splitlines():
        candidate = candidate.strip()
        if not candidate or candidate == tag:
            continue
        try:
            _, candidate_key, _ = parse_tag(artifact, candidate)
        except ValueError:
            continue
        candidate_commit = git_output(repo, ["rev-parse", "--verify", f"refs/tags/{candidate}^{{commit}}"])
        if candidate_commit == target_commit and candidate_key >= target_key:
            continue
        distance = int(git_output(repo, ["rev-list", "--count", f"{candidate_commit}..{target_commit}"]))
        neg_key = tuple(-part for part in candidate_key)
        candidates.append((distance, neg_key, candidate))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1]))
    return candidates[0][2]


def generate_notes(repo: Path, artifact: str, tag: str, config: Path, output: Path | None) -> str:
    parse_tag(artifact, tag)
    if not config.is_file():
        raise ValueError(f"Missing git-cliff config: {config}")
    target_commit = git_output(repo, ["rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"])
    prev_tag = find_previous_tag(repo, artifact, tag)
    cmd = ["git-cliff", "--repository", str(repo), "--config", str(config)]
    if prev_tag is not None:
        cmd.extend(["--tag", tag, f"{prev_tag}..{tag}"])
    else:
        head_commit = git_output(repo, ["rev-parse", "--verify", "HEAD"])
        if head_commit != target_commit:
            raise ValueError(
                f"Cannot generate initial release notes for {tag} when HEAD {head_commit} differs from {target_commit}"
            )
        cmd.extend(["--use-branch-tags", "--latest"])
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise ValueError(f"git-cliff failed for {tag}: {detail}")
    notes = result.stdout.strip()
    if not notes:
        raise ValueError(f"git-cliff produced empty release notes for {tag}")
    rendered = notes + "\n"
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
    return rendered


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate SemVer releases, flags, and scoped notes.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_validate = subparsers.add_parser("validate")
    p_validate.add_argument("--artifact", choices=sorted(ARTIFACTS), required=True)
    p_validate.add_argument("--tag", required=True)
    p_validate.add_argument("--manifest", type=Path)
    p_validate.add_argument("--repo", type=Path, default=Path("."))
    p_validate.add_argument("--github-output", type=Path)

    p_flags = subparsers.add_parser("flags")
    p_flags.add_argument("--artifact", choices=sorted(ARTIFACTS), required=True)
    p_flags.add_argument("--tag", required=True)
    p_flags.add_argument("--action", choices=("create", "edit"), default="create")
    p_flags.add_argument("--notes-file")

    p_assert = subparsers.add_parser("assert-flags")
    p_assert.add_argument("--artifact", choices=sorted(ARTIFACTS), required=True)
    p_assert.add_argument("--tag", required=True)
    p_assert.add_argument("flags", nargs=argparse.REMAINDER)

    p_verify = subparsers.add_parser("verify-published")
    p_verify.add_argument("--artifact", choices=sorted(ARTIFACTS), required=True)
    p_verify.add_argument("--tag", required=True)
    p_verify.add_argument("--actual-tag", required=True)
    p_verify.add_argument("--actual-prerelease", required=True)
    p_verify.add_argument("--actual-draft", required=True)
    p_verify.add_argument("--latest-tag", default="")

    p_notes = subparsers.add_parser("notes")
    p_notes.add_argument("--artifact", choices=sorted(ARTIFACTS), required=True)
    p_notes.add_argument("--tag", required=True)
    p_notes.add_argument("--repo", type=Path, default=Path("."))
    p_notes.add_argument("--config", type=Path)
    p_notes.add_argument("--output", type=Path)

    args = parser.parse_args()
    try:
        if args.command == "validate":
            repo = args.repo.resolve()
            manifest = args.manifest if args.manifest else repo / ARTIFACTS[args.artifact]["manifest"]
            if not manifest.is_absolute():
                manifest = repo / manifest
            info = validate_release(args.artifact, args.tag, manifest, repo)
            if args.github_output:
                with args.github_output.open("a", encoding="utf-8") as handle:
                    handle.write(f"sha={info['sha']}\n")
                    handle.write(f"version={info['version']}\n")
                    handle.write(f"is_prerelease={'true' if info['is_prerelease'] else 'false'}\n")
                    handle.write(f"make_latest={'true' if info['make_latest'] else 'false'}\n")
            print(json.dumps(info))
            return 0

        if args.command == "flags":
            flags = build_release_flags(args.artifact, args.tag, args.action, args.notes_file)
            for item in flags:
                print(item)
            return 0

        if args.command == "assert-flags":
            passed = args.flags[1:] if args.flags[:1] == ["--"] else args.flags
            assert_release_flags(args.artifact, args.tag, passed)
            return 0

        if args.command == "verify-published":
            verify_published(
                args.artifact,
                args.tag,
                args.actual_tag,
                args.actual_prerelease,
                args.actual_draft,
                args.latest_tag,
            )
            return 0

        if args.command == "notes":
            repo = args.repo.resolve()
            config = args.config if args.config else repo / ARTIFACTS[args.artifact]["cliff"]
            if not config.is_absolute():
                config = repo / config
            rendered = generate_notes(repo, args.artifact, args.tag, config, args.output)
            if args.output is None:
                sys.stdout.write(rendered)
            return 0
    except ValueError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
