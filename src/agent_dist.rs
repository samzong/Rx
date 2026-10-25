pub(crate) mod release;
mod store;

use std::fs;
use std::io::{self, IsTerminal, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

use crate::args::{Harness, LaunchRequest};
use crate::config::Paths;
use crate::launch::EnvLookup;
use crate::update::{self, ReleaseInfo};
use store::Installed;

pub(crate) const BACKGROUND_ARGUMENT: &str = "--rx-agent-background-update";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LaunchMode {
    Interactive,
    Acp,
    Quiet,
}

pub(crate) fn launch_mode(request: &LaunchRequest, interactive: bool) -> LaunchMode {
    let args = crate::args::before_double_dash(&request.passthrough);
    if crate::args::has_flags(args, &["-p", "--print", "-h", "--help", "-v", "-V", "--version"]) {
        return LaunchMode::Quiet;
    }
    if request.harness == Harness::Agent {
        let mut tokens = request.passthrough.iter();
        let mut command = None;
        while let Some(arg) = tokens.next() {
            match arg.to_str() {
                Some("--") => {
                    command = tokens.next().and_then(|arg| arg.to_str());
                    break;
                }
                Some("-m" | "--model" | "--thinking" | "-r" | "--resume" | "-p" | "--print") => {
                    tokens.next();
                }
                Some(value) if !value.starts_with('-') => {
                    command = Some(value);
                    break;
                }
                _ => {}
            }
        }
        if command == Some("acp") {
            return LaunchMode::Acp;
        }
        if command.is_some() {
            return LaunchMode::Quiet;
        }
    }
    if !interactive { LaunchMode::Quiet } else { LaunchMode::Interactive }
}

fn confirm_install(paths: &Paths) -> Result<bool> {
    if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
        bail!("rx-agent is not installed. Run `rxa` once in a terminal to install it, then retry.");
    }
    eprint!("Install rx-agent under {} and use it for rxa? [y/N] ", store::root(paths).display());
    io::stderr().flush()?;
    let mut line = String::new();
    if io::stdin().read_line(&mut line)? == 0 {
        return Ok(false);
    }
    let accepted = matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes");
    if !accepted {
        let Ok(_lock) = store::try_lock(paths, "install.lock") else { return Ok(false) };
        let mut selection = store::load(paths)?;
        selection.declined = true;
        store::save(paths, &selection)?;
    }
    Ok(accepted)
}

pub(crate) fn recommend(paths: &Paths, env: &EnvLookup) -> Result<bool> {
    if disabled(env, "RX_NO_INSTALL") || !env.is_real() {
        return Ok(false);
    }
    if crate::install::native_agent_path().is_some() {
        return Ok(false);
    }
    let Ok(selection) = store::load(paths) else { return Ok(false) };
    Ok(!selection.declined && selection.current.is_none())
}

pub(crate) fn ensure(paths: &Paths, env: &EnvLookup, mode: LaunchMode) -> Result<PathBuf> {
    if !env.is_real() {
        return Ok("rx-agent".into());
    }
    if let Some(path) = crate::install::native_agent_path() {
        return Ok(path);
    }
    let selection = store::load(paths)?;
    if let Some(installed) = &selection.current {
        let selected = store::verified_path(paths, installed)?;
        if !disabled(env, "RX_NO_UPDATE")
            && store::load_update(paths)
                .map_or(true, |state| update::should_check(state.last_check.as_deref()))
            && let Err(error) = spawn_background()
        {
            eprintln!("[rx] rx-agent background update skipped: {error:#}");
        }
        return Ok(selected);
    }
    if mode != LaunchMode::Interactive || disabled(env, "RX_NO_INSTALL") {
        bail!("rx-agent is not installed. Run `rxa` once in a terminal to install it, then retry.");
    }
    if !confirm_install(paths)? {
        bail!("installation cancelled. Run `rxa` in a terminal to try again.");
    }
    let release = release::latest(update::LAUNCH_CHECK_TIMEOUT)?;
    activate(paths, &release, None)
}

fn claim_check(paths: &Paths) -> Result<bool> {
    let _lock = store::try_lock(paths, "update.lock")?;
    let mut state = store::load_update(paths).unwrap_or_default();
    if !update::should_check(state.last_check.as_deref()) {
        return Ok(false);
    }
    state.last_check = Some(update::now_unix_seconds());
    store::save_update(paths, &state)?;
    Ok(true)
}

pub(crate) fn background(paths: &Paths) -> Result<()> {
    let _lock = store::try_lock(paths, "install.lock")?;
    let Some(installed) = store::load(paths)?.current else { return Ok(()) };
    if !claim_check(paths)? {
        return Ok(());
    }
    let release = release::latest(update::LAUNCH_CHECK_TIMEOUT)?;
    if release::stable_version(&release.version) > release::stable_version(&installed.version) {
        activate_locked(paths, &release, Some(&installed))?;
    }
    Ok(())
}

fn activate(paths: &Paths, release: &ReleaseInfo, expected: Option<&Installed>) -> Result<PathBuf> {
    let _lock = store::try_lock(paths, "install.lock")?;
    activate_locked(paths, release, expected)
}

fn activate_locked(
    paths: &Paths,
    release: &ReleaseInfo,
    expected: Option<&Installed>,
) -> Result<PathBuf> {
    let mut selection = store::load(paths)?;
    if expected.is_some() && selection.current.as_ref() != expected {
        bail!("rx-agent management selection changed during the update");
    }
    if selection.current.as_ref().is_some_and(|current| {
        release::stable_version(&current.version) > release::stable_version(&release.version)
    }) {
        return store::verified_path(paths, selection.current.as_ref().unwrap());
    }
    let bytes = update::http_get_bytes(&release.download_url, &[], update::HTTP_TIMEOUT)?;
    let manifest = update::http_get(&release.checksum_url, &[], update::HTTP_TIMEOUT)?;
    release::verify_sha256(&bytes, &release.asset_name, &manifest)?;
    let versions = store::root(paths).join("versions");
    fs::create_dir_all(&versions)?;
    let staging = tempfile::Builder::new().prefix(".staging-").tempdir_in(&versions)?;
    let staged_binary = staging.path().join(store::binary_name());
    release::unpack(&bytes, &release.asset_name, &staged_binary)?;
    probe(&staged_binary, &release.version)?;
    let installed = Installed {
        version: release.version.clone(),
        sha256: release::binary_digest(&staged_binary)?,
    };
    store::write(&staging.path().join("receipt.toml"), &installed)?;
    let destination = store::version_dir(paths, &release.version)?;
    if destination.exists() {
        let receipt: Installed = store::read(&destination.join("receipt.toml"))?
            .context("existing agent directory is not Rx-owned")?;
        if receipt != installed {
            bail!("existing rx-agent version has different contents");
        }
        store::verified_path(paths, &installed)?;
    } else {
        fs::rename(staging.path(), &destination).context("activate agent version directory")?;
    }
    let previous = selection.current.replace(installed.clone());
    selection.declined = false;
    store::save(paths, &selection)?;
    if previous.as_ref() != Some(&installed) {
        store::prune_versions(
            paths,
            &installed.version,
            previous.as_ref().map(|old| old.version.as_str()),
        );
    }
    Ok(destination.join(store::binary_name()))
}

fn probe(binary: &Path, expected: &str) -> Result<()> {
    let mut stdout = tempfile::tempfile()?;
    let mut command = Command::new(binary);
    command
        .arg("--version")
        .env_clear()
        .stdin(Stdio::null())
        .stdout(stdout.try_clone()?)
        .stderr(Stdio::null());
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    let mut child = command.spawn().context("probe downloaded rx-agent")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("rx-agent version probe timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    stdout.rewind()?;
    let mut output = String::new();
    stdout.take(1024).read_to_string(&mut output)?;
    if !status.success() || output.trim() != expected {
        bail!("downloaded rx-agent version does not match release {expected}");
    }
    Ok(())
}

fn disabled(env: &EnvLookup, key: &str) -> bool {
    env.get(key).is_some_and(|value| !value.is_empty() && value != "0")
}

fn background_command() -> Result<Command> {
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
    #[cfg(rx_release_fixture)]
    if let Some(value) = std::env::var_os("RX_TEST_RELEASE_SOURCE") {
        command.env("RX_TEST_RELEASE_SOURCE", value);
    }
    Ok(command)
}

fn spawn_background() -> Result<()> {
    let mut command = background_command()?;
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
