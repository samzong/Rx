import argparse
import hashlib
import json
import re
import subprocess
import sys
import tarfile
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = {
    "rx": ["rx-linux-x86_64.tar.gz", "rx-macos-x86_64.tar.gz", "rx-macos-aarch64.tar.gz", "rx-windows-x86_64.zip"],
    "rx-agent": ["rx-agent-darwin-x64.tar.gz", "rx-agent-darwin-arm64.tar.gz", "rx-agent-linux-x64.tar.gz", "rx-agent-windows-x64.zip"],
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args], text=True).strip()


def validate_tag(product, tag):
    if product == "rx-agent":
        version = json.loads((ROOT / "agent/package.json").read_text())["version"]
        prefix = "rx-agent-v"
    else:
        version = tomllib.loads((ROOT / "Cargo.toml").read_text())["package"]["version"]
        prefix = "v"
    require(re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version), "Release version must be a stable semantic version.")
    require(tag == prefix + version, "Release tag does not match the package version.")
    sha = git("rev-parse", "HEAD")
    require(sha == git("rev-parse", f"refs/tags/{tag}^{{commit}}"), "Release tag does not match the checked out commit.")
    return sha


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(product, tag, sha, directory):
    require(re.fullmatch(r"[0-9a-f]{40}", sha), "Invalid validated commit.")
    require(validate_tag(product, tag) == sha, "Release tag moved after validation.")
    names = ASSETS[product]
    receipts = [name.removesuffix(".tar.gz").removesuffix(".zip") + ".sha" for name in names]
    expected = set(names + receipts)
    actual = {path.name for path in directory.iterdir()}
    require(all(path.is_file() and not path.is_symlink() for path in directory.iterdir()), "Release artifacts must be regular files.")
    require(actual - {"SHA256SUMS"} == expected, "Release artifacts do not match the complete platform list.")
    for name, receipt in zip(names, receipts):
        path = directory / name
        require(path.is_file() and not path.is_symlink(), f"Invalid archive: {name}")
        require((directory / receipt).read_text().strip() == sha, f"Build commit differs: {receipt}")
        binary = product + (".exe" if name.endswith(".zip") else "")
        if name.endswith(".zip"):
            with zipfile.ZipFile(path) as archive:
                members = archive.infolist()
                require(len(members) == 1 and members[0].filename == binary and members[0].file_size > 0 and not members[0].is_dir(), f"Archive must contain only {binary}: {name}")
                require(archive.testzip() is None, f"Corrupt archive: {name}")
        else:
            with tarfile.open(path, "r:gz") as archive:
                members = archive.getmembers()
                require(len(members) == 1 and members[0].name == binary and members[0].isfile() and members[0].size > 0 and members[0].mode & 0o111, f"Archive must contain only executable {binary}: {name}")
    manifest = directory / "SHA256SUMS"
    manifest.write_text("".join(f"{digest(directory / name)}  {name}\n" for name in names))
    return [directory / name for name in names] + [manifest]


def gh(*args):
    result = subprocess.run(["gh", *args], text=True, capture_output=True)
    require(result.returncode == 0, f"GitHub command failed: {' '.join(args[:2])}\n{result.stderr}")
    return result.stdout


def api(endpoint, missing=False):
    result = subprocess.run(["gh", "api", "--include", endpoint], text=True, capture_output=True)
    header, separator, body = result.stdout.partition("\n\n")
    status = re.search(r"^HTTP/\S+ (\d+)", header)
    require(separator and status, "GitHub API returned no HTTP status.")
    code = int(status[1])
    if missing and code == 404:
        return None
    require(result.returncode == 0 and code == 200, f"GitHub API failed with HTTP {code}: {endpoint}")
    return json.loads(body)


def latest(repo):
    release = api(f"repos/{repo}/releases/latest", missing=True)
    return release["tag_name"] if release else None


def remote_commit(repo, tag):
    obj = api(f"repos/{repo}/git/ref/tags/{tag}")["object"]
    seen = set()
    while obj["type"] == "tag":
        require(obj["sha"] not in seen, "Remote tag contains a cycle.")
        seen.add(obj["sha"])
        obj = api(f"repos/{repo}/git/tags/{obj['sha']}")["object"]
    require(obj["type"] == "commit", "Remote tag does not point to a commit.")
    return obj["sha"]


def publish(product, tag, sha, directory, repo):
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "Invalid GitHub repository.")
    paths = prepare(product, tag, sha, directory)
    endpoint = f"repos/{repo}"
    require(remote_commit(repo, tag) == sha, "Remote tag moved after the build.")
    before = latest(repo)
    print(f"Latest before publication: {before or '(none)'}", flush=True)
    if product == "rx-agent":
        require(before is None or re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", before), "Latest release is not an Rx release. No release was changed.")
    existing = api(f"{endpoint}/releases/tags/{tag}", missing=True)
    expected = {path.name for path in paths}
    if existing:
        require(not existing["draft"] and not existing["prerelease"], "Existing release must be a published stable release.")
        require({asset["name"] for asset in existing["assets"]} <= expected, "Existing release contains unexpected assets.")
    latest_flag = "--latest=false" if product == "rx-agent" else "--latest"
    if existing:
        previous = {asset["name"]: asset for asset in existing["assets"]}
        uploads = [path for path in paths if previous.get(path.name, {}).get("digest") != "sha256:" + digest(path) or previous.get(path.name, {}).get("state") != "uploaded" or previous.get(path.name, {}).get("size") != path.stat().st_size]
        if uploads:
            gh("release", "upload", tag, "--repo", repo, "--clobber", *map(str, uploads))
        gh("release", "edit", tag, "--repo", repo, latest_flag, "--verify-tag")
    else:
        gh("release", "create", tag, "--repo", repo, "--title", tag, "--generate-notes", "--verify-tag", latest_flag, *map(str, paths))
    after = latest(repo)
    print(f"Latest after publication: {after or '(none)'}", flush=True)
    require(after == (before if product == "rx-agent" else tag), "Latest release changed unexpectedly. Inspect concurrent publication. No automatic correction was attempted.")
    require(remote_commit(repo, tag) == sha, "Remote tag moved during publication.")
    release = api(f"{endpoint}/releases/tags/{tag}")
    require(not release["draft"] and not release["prerelease"], "Release is not published and stable.")
    require(len(release["assets"]) == len(paths) and {asset["name"] for asset in release["assets"]} == expected, "Published asset list differs.")
    local = {path.name: path for path in paths}
    for asset in release["assets"]:
        path = local[asset["name"]]
        require(asset["state"] == "uploaded" and asset["size"] == path.stat().st_size, f"Published asset is incomplete: {path.name}")
        require(asset.get("digest") == "sha256:" + digest(path), f"Published asset checksum differs: {path.name}")
    print(f"Published {tag} from {sha} with {len(paths)} verified assets.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["tag", "prepare", "publish"])
    parser.add_argument("--product", required=True, choices=ASSETS)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--sha")
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--repo")
    args = parser.parse_args()
    if args.command == "tag":
        print(validate_tag(args.product, args.tag))
        return
    require(args.sha and args.assets, "Supply --sha and --assets.")
    if args.command == "prepare":
        prepare(args.product, args.tag, args.sha, args.assets)
    else:
        require(args.repo, "Supply --repo.")
        publish(args.product, args.tag, args.sha, args.assets, args.repo)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError, tarfile.TarError, zipfile.BadZipFile) as error:
        sys.exit(str(error))
