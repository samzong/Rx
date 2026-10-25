use super::*;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;

use serde_json::json;
use sha2::{Digest, Sha256};

struct Fixture {
    #[cfg(unix)]
    base: String,
    archive: Vec<u8>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Fixture {
    fn new(version: &str, bad_hash: bool) -> Self {
        let mut archive = Vec::new();
        {
            let encoder =
                flate2::write::GzEncoder::new(&mut archive, flate2::Compression::default());
            let mut tar = tar::Builder::new(encoder);
            let content = format!("#!/bin/sh\nprintf '%s\\n' '{version}'\n");
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            tar.append_data(&mut header, "rx-agent", content.as_bytes()).unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let data = archive.clone();
        let address = base.clone();
        let version = version.to_owned();
        let worker = thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut request = [0; 8192];
                let count = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                let name = release::asset_name().unwrap();
                let body = if request.starts_with("GET /releases?") {
                    serde_json::to_vec(&json!([{
                        "tag_name": format!("rx-agent-v{version}"), "draft": false, "prerelease": false,
                        "assets": [
                            {"name":name, "browser_download_url":format!("{address}/archive")},
                            {"name":"SHA256SUMS", "browser_download_url":format!("{address}/sums")}
                        ]
                    }])).unwrap()
                } else if request.starts_with("GET /sums ") {
                    let digest = if bad_hash {
                        "0".repeat(64)
                    } else {
                        format!("{:x}", Sha256::digest(&data))
                    };
                    format!("{digest}  {name}\n").into_bytes()
                } else {
                    data.clone()
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        Self {
            #[cfg(unix)]
            base,
            archive,
            stop,
            worker: Some(worker),
        }
    }

    #[cfg(unix)]
    fn release(&self, version: &str) -> ReleaseInfo {
        ReleaseInfo {
            version: version.to_owned(),
            asset_name: release::asset_name().unwrap().to_owned(),
            download_url: format!("{}/archive", self.base),
            checksum_url: format!("{}/sums", self.base),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
        update::TEST_RELEASE_SOURCE.with(|source| *source.borrow_mut() = None);
    }
}

#[test]
fn protocol_and_query_launches_skip_rx_self_update() {
    for (args, expected) in [
        (vec!["acp"], LaunchMode::Acp),
        (vec!["--model", "acp"], LaunchMode::Interactive),
        (vec!["--model", "provider/model", "acp"], LaunchMode::Acp),
        (vec!["--thinking=high", "acp"], LaunchMode::Acp),
        (vec!["--", "acp"], LaunchMode::Acp),
        (vec!["acp", "--help"], LaunchMode::Quiet),
        (vec!["--print", "acp"], LaunchMode::Quiet),
        (vec!["sessions"], LaunchMode::Quiet),
        (vec!["--version"], LaunchMode::Quiet),
    ] {
        let request = LaunchRequest {
            harness: Harness::Agent,
            provider: None,
            passthrough: args.iter().map(OsString::from).collect(),
        };
        assert_eq!(launch_mode(&request, true), expected, "{args:?}");
    }
}

#[test]
fn checksum_requires_unique_matching_manifest_entry() {
    let bytes = b"release";
    let digest = format!("{:x}", Sha256::digest(bytes));
    let manifest = format!("{digest}  archive\n");
    release::verify_sha256(bytes, "archive", &manifest).unwrap();
    assert!(release::verify_sha256(b"changed", "archive", &manifest).is_err());
    assert!(release::verify_sha256(bytes, "absent", &manifest).is_err());
    assert!(release::verify_sha256(bytes, "archive", &manifest.repeat(2)).is_err());
}

#[cfg(unix)]
#[test]
fn installation_updates_retain_current_and_previous_versions() {
    if crate::tests::run_isolated(
        "agent_dist::tests::installation_updates_retain_current_and_previous_versions",
    ) {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let paths = Paths::in_dir(home.path().to_path_buf());
    let mut first = None;
    for version in ["0.1.0", "0.2.0", "0.3.0"] {
        let fixture = Fixture::new(version, false);
        let binary = activate(&paths, &fixture.release(version), None).unwrap();
        assert_eq!(
            Command::new(&binary).arg("--version").output().unwrap().stdout,
            format!("{version}\n").as_bytes()
        );
        if first.is_none() {
            first = Some(binary);
        }
    }
    let selection = store::load(&paths).unwrap();
    assert_eq!(selection.current.as_ref().unwrap().version, "0.3.0");
    assert!(!first.unwrap().exists());
    let versions = store::root(&paths).join("versions");
    assert!(versions.join("0.2.0").is_dir());
    assert_eq!(fs::read_dir(&versions).unwrap().count(), 2);
    assert!(store::verified_path(&paths, selection.current.as_ref().unwrap()).unwrap().is_file());
}

#[cfg(unix)]
#[test]
fn failed_version_cleanup_does_not_remove_current_previous_or_unowned_entries() {
    if crate::tests::run_isolated(
        "agent_dist::tests::failed_version_cleanup_does_not_remove_current_previous_or_unowned_entries",
    ) {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let paths = Paths::in_dir(home.path().to_path_buf());
    let versions = store::root(&paths).join("versions");
    for version in ["0.1.0", "0.2.0", ".staging-unowned"] {
        let dir = versions.join(version);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("rx-agent"), b"binary").unwrap();
    }
    let previous = Installed {
        version: "0.2.0".into(),
        sha256: release::binary_digest(&versions.join("0.2.0/rx-agent")).unwrap(),
    };
    store::save(&paths, &store::Selection { declined: false, current: Some(previous) }).unwrap();
    let blocked = versions.join("0.1.0");
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o500)).unwrap();
    let fixture = Fixture::new("0.3.0", false);
    let binary = activate(&paths, &fixture.release("0.3.0"), None).unwrap();
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(store::load(&paths).unwrap().current.unwrap().version, "0.3.0");
    assert!(binary.is_file());
    assert!(blocked.join("rx-agent").is_file());
    assert!(versions.join("0.2.0/rx-agent").is_file());
    assert!(versions.join("0.3.0/rx-agent").is_file());
    assert!(versions.join(".staging-unowned/rx-agent").is_file());
}

#[cfg(unix)]
#[test]
fn failed_hash_and_wrong_version_keep_the_old_installation() {
    if crate::tests::run_isolated(
        "agent_dist::tests::failed_hash_and_wrong_version_keep_the_old_installation",
    ) {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let paths = Paths::in_dir(home.path().to_path_buf());
    let first = Fixture::new("0.1.0", false);
    let path = activate(&paths, &first.release("0.1.0"), None).unwrap();
    let before = fs::read(store::root(&paths).join("install.toml")).unwrap();
    for fixture in [Fixture::new("0.2.0", true), Fixture::new("0.9.0", false)] {
        assert!(activate(&paths, &fixture.release("0.2.0"), None).is_err());
        assert_eq!(fs::read(store::root(&paths).join("install.toml")).unwrap(), before);
        assert!(path.is_file());
    }
}

#[cfg(unix)]
#[test]
fn concurrent_writer_and_changed_selection_cannot_retarget_agent() {
    let home = tempfile::tempdir().unwrap();
    let paths = Paths::in_dir(home.path().to_path_buf());
    let fixture = Fixture::new("0.1.0", false);
    let expected = Installed { version: "0.1.0".into(), sha256: "0".repeat(64) };
    let selection = store::Selection { declined: false, current: Some(expected.clone()) };
    store::save(&paths, &selection).unwrap();
    let lock = store::try_lock(&paths, "install.lock").unwrap();
    let start = Instant::now();
    assert!(activate(&paths, &fixture.release("0.1.0"), None).is_err());
    assert!(start.elapsed() < Duration::from_secs(1));
    drop(lock);
    let mut selection = store::load(&paths).unwrap();
    selection.current = None;
    store::save(&paths, &selection).unwrap();
    assert!(activate_locked(&paths, &fixture.release("0.1.0"), Some(&expected)).is_err());
    assert!(store::load(&paths).unwrap().current.is_none());
}

#[test]
fn background_check_claim_persists_the_interval() {
    let home = tempfile::tempdir().unwrap();
    let paths = Paths::in_dir(home.path().to_path_buf());
    assert!(claim_check(&paths).unwrap());
    assert!(!claim_check(&paths).unwrap());
    let state = store::load_update(&paths).unwrap();
    assert!(!update::should_check(state.last_check.as_deref()));
}

#[cfg(unix)]
#[test]
fn permission_failure_preserves_active_binary_and_selection() {
    if crate::tests::run_isolated(
        "agent_dist::tests::permission_failure_preserves_active_binary_and_selection",
    ) {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let paths = Paths::in_dir(home.path().to_path_buf());
    let first = Fixture::new("0.1.0", false);
    let active = activate(&paths, &first.release("0.1.0"), None).unwrap();
    let before = fs::read(store::root(&paths).join("install.toml")).unwrap();
    let versions = store::root(&paths).join("versions");
    fs::set_permissions(&versions, fs::Permissions::from_mode(0o500)).unwrap();
    let second = Fixture::new("0.2.0", false);
    let result = activate(&paths, &second.release("0.2.0"), None);
    fs::set_permissions(&versions, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert_eq!(fs::read(store::root(&paths).join("install.toml")).unwrap(), before);
    assert!(active.is_file());
    let oldest = versions.join("0.0.1");
    fs::create_dir(&oldest).unwrap();
    fs::write(oldest.join("rx-agent"), b"old binary").unwrap();
    fs::set_permissions(store::root(&paths), fs::Permissions::from_mode(0o500)).unwrap();
    let result = activate(&paths, &second.release("0.2.0"), None);
    fs::set_permissions(store::root(&paths), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert_eq!(fs::read(store::root(&paths).join("install.toml")).unwrap(), before);
    assert!(active.is_file());
    assert!(oldest.join("rx-agent").is_file());
}

#[test]
fn malformed_selection_fails_closed_without_rewriting_user_state() {
    let home = tempfile::tempdir().unwrap();
    let paths = Paths::in_dir(home.path().to_path_buf());
    fs::create_dir_all(store::root(&paths)).unwrap();
    let file = store::root(&paths).join("install.toml");
    for contents in ["invalid", "[current]\nversion = '../other'\nsha256 = 'bad'\n"] {
        fs::write(&file, contents).unwrap();
        assert!(store::load(&paths).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), contents);
    }
}

#[test]
fn archive_rejects_extra_entries_before_activation() {
    let fixture = Fixture::new("0.1.0", false);
    let home = tempfile::tempdir().unwrap();
    let output = home.path().join("agent");
    release::unpack(&fixture.archive, "test.tar.gz", &output).unwrap();
    let mut bytes = Vec::new();
    {
        let encoder = flate2::write::GzEncoder::new(&mut bytes, flate2::Compression::default());
        let mut tar = tar::Builder::new(encoder);
        for name in ["rx-agent", "extra"] {
            let mut header = tar::Header::new_gnu();
            header.set_size(3);
            header.set_mode(0o755);
            header.set_cksum();
            tar.append_data(&mut header, name, &b"bin"[..]).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
    }
    assert!(release::unpack(&bytes, "test.tar.gz", &output).is_err());
    assert_eq!(release::stable_version("0.1.0-beta"), None);
    assert_eq!(release::stable_version("../0.1.0"), None);
}

#[test]
fn background_environment_has_only_system_and_proxy_variables() {
    let command = background_command().unwrap();
    for (key, _) in command.get_envs() {
        assert!(
            [
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
                "no_proxy"
            ]
            .iter()
            .any(|allowed| key == *allowed)
        );
    }
}

#[test]
fn agent_release_selection_reads_later_pages_and_ignores_other_products() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let address = base.clone();
    let worker = thread::spawn(move || {
        for page in 1..=2 {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut bytes = [0; 8192];
            let count = stream.read(&mut bytes).unwrap();
            assert!(String::from_utf8_lossy(&bytes[..count]).contains(&format!("page={page}")));
            let releases = if page == 1 {
                vec![json!({"tag_name":"v99.0.0", "draft":false, "prerelease":false}); 100]
            } else {
                vec![
                    json!({"tag_name":"rx-agent-v0.3.0", "draft":false, "prerelease":false,
                    "assets":[{"name":release::asset_name().unwrap(),"browser_download_url":format!("{address}/archive")},
                              {"name":"SHA256SUMS","browser_download_url":format!("{address}/sums")}]}),
                    json!({"tag_name":"rx-agent-v1.0.0-beta", "draft":false, "prerelease":false}),
                    json!({"tag_name":"rx-agent-v9.0.0", "draft":true, "prerelease":false}),
                    json!({"tag_name":"rx-agent-v8.0.0", "draft":false, "prerelease":true}),
                ]
            };
            let body = serde_json::to_vec(&releases).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        }
    });
    update::TEST_RELEASE_SOURCE.with(|source| *source.borrow_mut() = Some(base));
    let result = release::latest(Duration::from_secs(5));
    update::TEST_RELEASE_SOURCE.with(|source| *source.borrow_mut() = None);
    worker.join().unwrap();
    assert_eq!(result.unwrap().version, "0.3.0");
}

#[test]
fn corrupt_update_state_is_repaired_under_the_check_lock() {
    let home = tempfile::tempdir().unwrap();
    let paths = Paths::in_dir(home.path().to_owned());
    fs::create_dir_all(store::root(&paths)).unwrap();
    let state = store::root(&paths).join("update.toml");
    fs::write(&state, "future = 1\n").unwrap();
    let lock = store::try_lock(&paths, "update.lock").unwrap();
    assert!(claim_check(&paths).is_err());
    assert_eq!(fs::read_to_string(&state).unwrap(), "future = 1\n");
    drop(lock);
    assert!(claim_check(&paths).unwrap());
    assert!(!update::should_check(store::load_update(&paths).unwrap().last_check.as_deref()));
    assert!(!claim_check(&paths).unwrap());
}
