use std::cmp::Ordering;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::config::Paths;
use crate::launch::EnvLookup;
use crate::update::{self, ReleaseInfo};

pub(crate) const BACKGROUND_ARGUMENT: &str = "--rx-agent-background-update";
pub(crate) const MISSING: &str =
    "rx-agent is not installed. Run `rxa` once in a terminal to install it, then retry.";

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct State {
    #[serde(default)]
    declined: bool,
    current: Option<String>,
    last_check: Option<String>,
}

pub(crate) fn recommend(paths: &Paths, env: &EnvLookup) -> bool {
    if disabled(env, "RX_NO_INSTALL") || !env.is_real() {
        return false;
    }
    if crate::install::native_agent_path().is_some() {
        return false;
    }
    load(paths).is_ok_and(|state| !state.declined && state.current.is_none())
}

pub(crate) fn ensure(paths: &Paths, env: &EnvLookup, interactive: bool) -> Result<PathBuf> {
    if !env.is_real() {
        return Ok(crate::agent::PROGRAM.into());
    }
    if let Some(path) = crate::install::native_agent_path() {
        return Ok(path);
    }
    let state = load(paths)?;
    if let Some(version) = &state.current {
        let path = binary(paths, version)?;
        if path.is_file() {
            if !disabled(env, "RX_NO_UPDATE")
                && update::should_check(state.last_check.as_deref())
                && let Err(error) = spawn_background()
            {
                eprintln!("[rx] rx-agent background update skipped: {error:#}");
            }
            return Ok(path);
        }
    }
    if !interactive || disabled(env, "RX_NO_INSTALL") {
        bail!(MISSING);
    }
    asset_name()?;
    if !confirm_install(paths)? {
        bail!("installation cancelled. Run `rxa` in a terminal to try again.");
    }
    let _lock = lock(paths)?;
    install(paths, &latest()?)
}

pub(crate) fn background(paths: &Paths) -> Result<()> {
    let _lock = lock(paths)?;
    let mut state = load(paths)?;
    let Some(current) = state.current.clone() else { return Ok(()) };
    if !update::should_check(state.last_check.as_deref()) {
        return Ok(());
    }
    state.last_check = Some(update::now_unix_seconds());
    save(paths, &state)?;
    let release = latest()?;
    if update::version_cmp(&release.version, &current) == Ordering::Greater {
        install(paths, &release)?;
    }
    Ok(())
}

fn confirm_install(paths: &Paths) -> Result<bool> {
    eprint!("Install rx-agent under {} and use it for rxa? [y/N] ", root(paths).display());
    io::stderr().flush()?;
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    let accepted = matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes");
    if !accepted && let Ok(_lock) = lock(paths) {
        let mut state = load(paths)?;
        state.declined = true;
        save(paths, &state)?;
    }
    Ok(accepted)
}

fn install(paths: &Paths, release: &ReleaseInfo) -> Result<PathBuf> {
    let path = binary(paths, &release.version)?;
    let dir = path.parent().context("managed rx-agent directory")?;
    if !path.is_file() {
        let versions = root(paths).join("versions");
        fs::create_dir_all(&versions)?;
        let staging = tempfile::Builder::new().prefix(".staging-").tempdir_in(&versions)?;
        update::download_release(release, staging.path())?;
        if !staging.path().join(path.file_name().context("rx-agent name")?).is_file() {
            bail!("release archive did not contain rx-agent");
        }
        fs::rename(staging.keep(), dir).context("activate rx-agent version")?;
    }
    let mut state = load(paths)?;
    let previous = state
        .current
        .replace(release.version.clone())
        .filter(|version| binary(paths, version).is_ok_and(|path| path.is_file()));
    state.declined = false;
    state.last_check = Some(update::now_unix_seconds());
    save(paths, &state)?;
    prune(paths, &release.version, previous.as_deref());
    Ok(path)
}

fn prune(paths: &Paths, current: &str, previous: Option<&str>) {
    let Ok(entries) = fs::read_dir(root(paths).join("versions")) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(version) = name.to_str() else { continue };
        if version != current && Some(version) != previous && stable(version) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn latest() -> Result<ReleaseInfo> {
    let body = update::http_get(
        &format!("https://api.github.com/repos/{}/releases?per_page=100", update::GITHUB_REPO),
        &[("Accept", "application/vnd.github+json")],
        update::LAUNCH_CHECK_TIMEOUT,
    )?;
    let releases: Vec<serde_json::Value> =
        serde_json::from_str(&body).context("GitHub release list")?;
    select_release(&releases)
}

fn select_release(releases: &[serde_json::Value]) -> Result<ReleaseInfo> {
    let (version, release) = releases
        .iter()
        .filter(|release| release["draft"] == false && release["prerelease"] == false)
        .filter_map(|release| {
            let version = release["tag_name"].as_str()?.strip_prefix("rx-agent-v")?;
            stable(version).then_some((version, release))
        })
        .max_by(|left, right| update::version_cmp(left.0, right.0))
        .context("no rx-agent release found")?;
    update::release_info(release, version.to_string(), asset_name()?)
}

fn asset_name() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("rx-agent-darwin-arm64.tar.gz"),
        ("macos", "x86_64") => Ok("rx-agent-darwin-x64.tar.gz"),
        ("linux", "x86_64") => Ok("rx-agent-linux-x64.tar.gz"),
        ("windows", "x86_64") => Ok("rx-agent-windows-x64.zip"),
        (os, arch) => bail!("unsupported platform for rx-agent: {os}-{arch}"),
    }
}

fn stable(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

fn root(paths: &Paths) -> PathBuf {
    paths.dir.join("rx-agent")
}

fn binary(paths: &Paths, version: &str) -> Result<PathBuf> {
    if !stable(version) {
        bail!("invalid managed rx-agent version: {version}");
    }
    let name = if cfg!(windows) { "rx-agent.exe" } else { "rx-agent" };
    Ok(root(paths).join("versions").join(version).join(name))
}

fn state_path(paths: &Paths) -> PathBuf {
    root(paths).join("install.toml")
}

fn load(paths: &Paths) -> Result<State> {
    let path = state_path(paths);
    let Some(bytes) = crate::file_io::read_optional(&path)? else { return Ok(State::default()) };
    toml::from_str(std::str::from_utf8(&bytes)?)
        .with_context(|| format!("parse {}", path.display()))
}

fn save(paths: &Paths, state: &State) -> Result<()> {
    crate::file_io::write(&state_path(paths), toml::to_string_pretty(state)?.as_bytes())
}

fn lock(paths: &Paths) -> Result<File> {
    fs::create_dir_all(root(paths))?;
    let path = root(paths).join("install.lock");
    let file =
        OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&path)?;
    fs2::FileExt::try_lock_exclusive(&file)
        .with_context(|| format!("rx-agent is busy: {}", path.display()))?;
    Ok(file)
}

fn disabled(env: &EnvLookup, key: &str) -> bool {
    env.get(key).is_some_and(|value| !value.is_empty() && value != "0")
}

fn spawn_background() -> Result<()> {
    let mut command = Command::new(std::env::current_exe()?);
    command.env_clear();
    for key in [
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "SystemRoot",
        "TEMP",
        "TMP",
        "TMPDIR",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "https_proxy",
        "http_proxy",
        "all_proxy",
        "no_proxy",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .arg(BACKGROUND_ARGUMENT)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe extern "C" {
            fn setsid() -> i32;
            fn fork() -> i32;
            fn _exit(status: i32) -> !;
        }
        unsafe {
            command.pre_exec(|| {
                if setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                match fork() {
                    -1 => Err(io::Error::last_os_error()),
                    0 => Ok(()),
                    _ => _exit(0),
                }
            });
        }
        let status = command.status().context("detach rx-agent updater")?;
        if !status.success() {
            bail!("failed to detach rx-agent updater");
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command
            .creation_flags(0x00000008 | 0x00000200)
            .spawn()
            .context("detach rx-agent updater")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
