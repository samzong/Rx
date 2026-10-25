use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use semver::Version;
use sha2::{Digest, Sha256};

use crate::update::{self, ReleaseInfo};

pub(crate) fn stable_version(value: &str) -> Option<Version> {
    Version::parse(value).ok().filter(|version| version.pre.is_empty())
}

pub(super) fn asset_name() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("rx-agent-darwin-arm64.tar.gz"),
        ("macos", "x86_64") => Ok("rx-agent-darwin-x64.tar.gz"),
        ("linux", "x86_64") => Ok("rx-agent-linux-x64.tar.gz"),
        ("windows", "x86_64") => Ok("rx-agent-windows-x64.zip"),
        (os, arch) => bail!("unsupported platform for rx-agent: {os}-{arch}"),
    }
}

pub(super) fn latest(timeout: Duration) -> Result<ReleaseInfo> {
    let started = Instant::now();
    let mut newest: Option<(Version, serde_json::Value)> = None;
    for page in 1.. {
        let remaining =
            timeout.checked_sub(started.elapsed()).context("release check timed out")?;
        let url =
            format!("https://api.github.com/repos/samzong/Rx/releases?per_page=100&page={page}");
        let body = update::http_get(&url, &[("Accept", "application/vnd.github+json")], remaining)?;
        let releases: Vec<serde_json::Value> =
            serde_json::from_str(&body).context("GitHub release list")?;
        for release in &releases {
            if release.get("draft").and_then(|v| v.as_bool()) != Some(false)
                || release.get("prerelease").and_then(|v| v.as_bool()) != Some(false)
            {
                continue;
            }
            let Some(version) = release
                .get("tag_name")
                .and_then(|v| v.as_str())
                .and_then(|tag| tag.strip_prefix("rx-agent-v"))
                .and_then(stable_version)
            else {
                continue;
            };
            if newest.as_ref().is_none_or(|(selected, _)| &version > selected) {
                newest = Some((version, release.clone()));
            }
        }
        if releases.len() < 100 {
            break;
        }
    }
    let (version, release) = newest.context("no stable rx-agent release found")?;
    let assets =
        release.get("assets").and_then(|v| v.as_array()).context("release missing assets")?;
    let find_url = |name: &str| -> Result<String> {
        assets
            .iter()
            .find(|a| a.get("name").and_then(|v| v.as_str()) == Some(name))
            .and_then(|a| a.get("browser_download_url").and_then(|v| v.as_str()))
            .map(str::to_owned)
            .with_context(|| format!("release asset not found: {name}"))
    };
    let asset_name = asset_name()?.to_owned();
    Ok(ReleaseInfo {
        version: version.to_string(),
        download_url: find_url(&asset_name)?,
        checksum_url: find_url("SHA256SUMS")?,
        asset_name,
    })
}

pub(crate) fn verify_sha256(bytes: &[u8], name: &str, manifest: &str) -> Result<()> {
    let mut expected = None;
    for line in manifest.lines().filter(|line| !line.trim().is_empty()) {
        let mut fields = line.split_whitespace();
        let digest = fields.next().context("invalid SHA256SUMS entry")?;
        let file = fields.next().context("invalid SHA256SUMS entry")?.trim_start_matches('*');
        if fields.next().is_some()
            || digest.len() != 64
            || !digest.bytes().all(|b| b.is_ascii_hexdigit())
        {
            bail!("invalid SHA256SUMS entry");
        }
        if file == name {
            if expected.is_some() {
                bail!("duplicate SHA256SUMS entry for {name}");
            }
            expected = Some(digest);
        }
    }
    let expected = expected.with_context(|| format!("SHA256SUMS missing {name}"))?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(expected) {
        bail!("SHA-256 mismatch for {name}");
    }
    Ok(())
}

pub(super) fn binary_digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hash = Sha256::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        hash.update(&chunk[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn unpack(bytes: &[u8], name: &str, destination: &Path) -> Result<()> {
    if name.ends_with(".tar.gz") {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
        let mut entries = archive.entries()?;
        let mut entry = entries.next().context("empty agent archive")??;
        if entry.path()?.as_ref() != Path::new("rx-agent") || !entry.header().entry_type().is_file()
        {
            bail!("agent archive must contain only a regular rx-agent binary");
        }
        let mut file = fs::File::create(destination)?;
        std::io::copy(&mut entry, &mut file)?;
        file.flush()?;
        file.sync_all()?;
        if entries.next().is_some() {
            bail!("unexpected extra agent archive entry");
        }
    } else {
        unpack_zip(bytes, destination)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

#[cfg(windows)]
fn unpack_zip(bytes: &[u8], destination: &Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    if archive.len() != 1 {
        bail!("agent archive must contain one binary");
    }
    let mut entry = archive.by_index(0)?;
    if entry.name() != "rx-agent.exe"
        || !entry.is_file()
        || entry.unix_mode().is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
    {
        bail!("agent archive must contain only a regular rx-agent.exe binary");
    }
    let mut file = fs::File::create(destination)?;
    std::io::copy(&mut entry, &mut file)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(not(windows))]
fn unpack_zip(_bytes: &[u8], _destination: &Path) -> Result<()> {
    bail!("zip agent archives are only supported on Windows")
}
