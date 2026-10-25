use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::config::Paths;
use crate::file_io;

use super::release;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Installed {
    pub version: String,
    pub sha256: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CheckState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_check: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Selection {
    #[serde(default)]
    pub declined: bool,
    pub current: Option<Installed>,
}

pub(super) fn root(paths: &Paths) -> PathBuf {
    paths.dir.join("rx-agent")
}

pub(super) fn binary_name() -> &'static str {
    if cfg!(windows) { "rx-agent.exe" } else { "rx-agent" }
}

pub(super) fn version_dir(paths: &Paths, version: &str) -> Result<PathBuf> {
    if release::stable_version(version).is_none() {
        bail!("invalid managed rx-agent version");
    }
    Ok(root(paths).join("versions").join(version))
}

pub(super) fn load(paths: &Paths) -> Result<Selection> {
    let selection: Selection = read(&root(paths).join("install.toml"))?.unwrap_or_default();
    for installed in selection.current.iter() {
        version_dir(paths, &installed.version)?;
        if installed.sha256.len() != 64 || !installed.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        {
            bail!("invalid managed rx-agent SHA-256");
        }
    }
    Ok(selection)
}

pub(super) fn save(paths: &Paths, selection: &Selection) -> Result<()> {
    write(&root(paths).join("install.toml"), selection)
}

pub(super) fn load_update(paths: &Paths) -> Result<CheckState> {
    Ok(read(&root(paths).join("update.toml"))?.unwrap_or_default())
}

pub(super) fn save_update(paths: &Paths, state: &CheckState) -> Result<()> {
    write(&root(paths).join("update.toml"), state)
}

pub(super) fn prune_versions(paths: &Paths, current: &str, previous: Option<&str>) {
    let Ok(entries) = fs::read_dir(root(paths).join("versions")) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(version) = name.to_str() else { continue };
        if version == current
            || Some(version) == previous
            || release::stable_version(version).is_none()
        {
            continue;
        }
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

pub(super) fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    file_io::read_optional(path)?
        .map(|bytes| {
            toml::from_str(std::str::from_utf8(&bytes)?)
                .with_context(|| format!("parse {}", path.display()))
        })
        .transpose()
}

pub(super) fn write(path: &Path, value: &impl Serialize) -> Result<()> {
    file_io::write(path, toml::to_string_pretty(value)?.as_bytes())
}

pub(super) fn try_lock(paths: &Paths, name: &str) -> Result<File> {
    fs::create_dir_all(root(paths))?;
    let path = root(paths).join(name);
    let file =
        OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&path)?;
    fs2::FileExt::try_lock_exclusive(&file)
        .with_context(|| format!("rx-agent is busy: {}", path.display()))?;
    Ok(file)
}

pub(super) fn verified_path(paths: &Paths, installed: &Installed) -> Result<PathBuf> {
    let path = version_dir(paths, &installed.version)?.join(binary_name());
    let metadata = fs::symlink_metadata(&path)
        .with_context(|| format!("managed rx-agent is missing: {}", path.display()))?;
    if !metadata.is_file() {
        bail!("managed rx-agent is not a regular file: {}", path.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            bail!("managed rx-agent is not executable");
        }
    }
    if release::binary_digest(&path)? != installed.sha256 {
        bail!("managed rx-agent SHA-256 mismatch: {}", path.display());
    }
    Ok(path)
}
