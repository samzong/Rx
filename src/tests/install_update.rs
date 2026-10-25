use super::*;

#[test]
fn update_parses_yes_flag() {
    assert_eq!(parse_line(&["rx", "update"]), Command::Update(UpdateCommand::Run { yes: false }));
    assert_eq!(
        parse_line(&["rx", "update", "--yes"]),
        Command::Update(UpdateCommand::Run { yes: true })
    );
}

#[test]
fn version_cmp_orders_releases() {
    use std::cmp::Ordering;

    assert_eq!(crate::update::version_cmp("0.1.0", "0.5.0"), Ordering::Less);
    assert_eq!(crate::update::version_cmp("0.5.0", "0.5.0"), Ordering::Equal);
    assert_eq!(crate::update::version_cmp("0.6.0", "0.5.0"), Ordering::Greater);
}

#[test]
fn update_pending_uses_release_version() {
    let release = crate::update::ReleaseInfo {
        version: "0.5.0".to_string(),
        asset_name: String::new(),
        download_url: String::new(),
        checksum_url: String::new(),
    };
    assert!(!crate::update::update_pending("0.5.0", &release));
    assert!(crate::update::update_pending("0.4.0", &release));
}

#[test]
fn homebrew_managed_rx_requires_brew_upgrade() {
    for path in [
        "/opt/homebrew/Cellar/rx/0.5.1/bin/rx",
        "/usr/local/Cellar/rx/0.5.1/bin/rx",
        "/home/linuxbrew/.linuxbrew/Cellar/rx/0.5.1/bin/rx",
        "/srv/custom-brew/Cellar/rx/0.5.1/bin/rx",
    ] {
        assert_eq!(
            crate::update::self_update_blocker(Path::new(path)),
            Some(crate::update::HOMEBREW_UPDATE_HINT)
        );
    }
    assert_eq!(crate::update::self_update_blocker(Path::new("/Users/x/.cargo/bin/rx")), None);
    assert_eq!(
        crate::update::self_update_blocker(Path::new("/opt/homebrew/Cellar/other/0.5.1/bin/rx")),
        None
    );
}

#[cfg(unix)]
#[test]
fn homebrew_managed_rx_is_detected_through_bin_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let cellar_rx = dir.path().join("Cellar/rx/0.5.1/bin/rx");
    fs::create_dir_all(cellar_rx.parent().unwrap()).unwrap();
    fs::write(&cellar_rx, b"rx").unwrap();
    let linked_rx = dir.path().join("bin/rx");
    fs::create_dir_all(linked_rx.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&cellar_rx, &linked_rx).unwrap();

    assert_eq!(
        crate::update::self_update_blocker(&linked_rx),
        Some(crate::update::HOMEBREW_UPDATE_HINT)
    );
    assert_eq!(
        crate::update::homebrew_launch_update_notice(&linked_rx, "0.6.0"),
        Some("Rx 0.6.0 is available — run `brew upgrade rx`".to_string())
    );
}

#[test]
fn release_asset_name_matches_host() {
    let name = crate::update::release_asset_name().unwrap();
    assert!(name.starts_with("rx-"));
}

#[test]
fn install_specs_use_official_urls() {
    let claude = crate::install::spec(Harness::Claude).unwrap();
    assert_eq!(claude.url, "https://claude.ai/install.sh");
    assert_eq!(claude.shell, "bash");
    assert_eq!(
        crate::install::command_line(&claude),
        "curl -fsSL https://claude.ai/install.sh | bash"
    );

    let codex = crate::install::spec(Harness::Codex).unwrap();
    assert_eq!(codex.url, "https://chatgpt.com/codex/install.sh");
    assert_eq!(codex.shell, "sh");

    let opencode = crate::install::spec(Harness::OpenCode).unwrap();
    assert_eq!(opencode.url, "https://opencode.ai/install");
    assert_eq!(opencode.shell, "bash");

    let pi = crate::install::spec(Harness::Pi).unwrap();
    assert_eq!(pi.url, "https://pi.dev/install.sh");
    assert_eq!(pi.shell, "sh");

    let kimi = crate::install::spec(Harness::Kimi).unwrap();
    assert_eq!(kimi.program, "kimi");
    assert_eq!(kimi.display, "Kimi Code");
    assert_eq!(kimi.url, "https://code.kimi.com/kimi-code/install.sh");
    assert_eq!(kimi.shell, "bash");
}

#[test]
fn install_lookup_finds_extra_dir_when_absent_from_path() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("pi");
    fs::write(&bin, "#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let found = crate::install::lookup_with("pi", "", &[dir.path().to_path_buf()], None).unwrap();
    assert_eq!(found, bin);
    assert!(crate::install::lookup_with("pi", "", &[], None).is_none());
}

#[test]
fn install_lookup_honors_windows_executable_extensions() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("codex.exe");
    fs::write(&bin, "windows executable").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let found = crate::install::lookup_with(
        "codex",
        "",
        &[dir.path().to_path_buf()],
        Some(std::ffi::OsStr::new(".COM;.EXE;.exe")),
    )
    .unwrap();
    assert!(found.is_file());
    assert_eq!(found.parent(), bin.parent());
    assert!(found.file_name().unwrap().to_string_lossy().eq_ignore_ascii_case("codex.exe"));
}

#[test]
fn isolated_env_skips_install_offer() {
    let path = crate::install::ensure(Harness::Pi, &isolated(&[])).unwrap();
    assert_eq!(path, std::path::PathBuf::from("pi"));
    let dsh = crate::install::ensure(Harness::Dsh, &isolated(&[])).unwrap();
    assert_eq!(dsh, std::path::PathBuf::from("dsh"));
    let kimi = crate::install::ensure(Harness::Kimi, &isolated(&[])).unwrap();
    assert_eq!(kimi, std::path::PathBuf::from("kimi"));
}

struct RxUpdateFixture {
    stop: Arc<std::sync::atomic::AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
    requests: Arc<std::sync::Mutex<Vec<String>>>,
}

impl RxUpdateFixture {
    fn new(version: &str, manifest: bool) -> Self {
        use std::sync::atomic::{AtomicBool, Ordering};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        crate::update::TEST_RELEASE_SOURCE.with(|source| *source.borrow_mut() = Some(base.clone()));
        let name = crate::update::release_asset_name().unwrap();
        let mut assets = vec![json!({
            "name": name, "browser_download_url": format!("{base}/archive")
        })];
        if manifest {
            assets.push(json!({
                "name": "SHA256SUMS", "browser_download_url": format!("{base}/sums")
            }));
        }
        let release = json!({"tag_name":format!("v{version}"), "assets":assets}).to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let received = requests.clone();
        let worker = thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut bytes = [0; 8192];
                let count = stream.read(&mut bytes).unwrap();
                let request = String::from_utf8_lossy(&bytes[..count]);
                let path = request.split_whitespace().nth(1).unwrap().to_string();
                received.lock().unwrap().push(path.clone());
                let body = match path.as_str() {
                    "/releases/latest" => release.clone(),
                    "/archive" => "invalid archive".to_string(),
                    "/sums" => format!("{}  {name}\n", "0".repeat(64)),
                    _ => panic!("unexpected request: {path}"),
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        Self { stop, worker: Some(worker), requests }
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for RxUpdateFixture {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
        crate::update::TEST_RELEASE_SOURCE.with(|source| *source.borrow_mut() = None);
    }
}

#[test]
fn rx_update_same_release_without_manifest_is_a_noop() {
    let fixture = RxUpdateFixture::new(crate::RELEASE_VERSION, false);
    let result = crate::update::run(UpdateCommand::Run { yes: false });
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(fixture.requests(), ["/releases/latest"]);
}

#[test]
fn rx_update_older_release_without_manifest_is_a_noop() {
    let fixture = RxUpdateFixture::new("0.0.0", false);
    let result = crate::update::run(UpdateCommand::Run { yes: false });
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(fixture.requests(), ["/releases/latest"]);
}

#[test]
fn rx_update_new_release_without_manifest_is_rejected() {
    let fixture = RxUpdateFixture::new("999.0.0", false);
    let error = crate::update::run(UpdateCommand::Run { yes: true }).unwrap_err();
    assert!(error.to_string().contains("missing SHA256SUMS"), "{error:#}");
    assert_eq!(fixture.requests(), ["/releases/latest"]);
}

#[test]
fn rx_update_new_release_with_bad_hash_is_rejected() {
    let fixture = RxUpdateFixture::new("999.0.0", true);
    let error = crate::update::run(UpdateCommand::Run { yes: true }).unwrap_err();
    assert!(error.to_string().contains("SHA-256 mismatch"), "{error:#}");
    assert_eq!(fixture.requests(), ["/releases/latest", "/archive", "/sums"]);
}

#[test]
fn noninteractive_startup_does_not_touch_update_state() {
    let fixture = RxUpdateFixture::new(crate::RELEASE_VERSION, false);
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::in_dir(dir.path().to_path_buf());
    let state = paths.dir.join("rx-update.toml");
    fs::write(&state, "auto_update = true\n").unwrap();
    let before = fs::read(&state).unwrap();
    let env = EnvLookup::isolated(Default::default());
    crate::update::maybe_before_launch_with_interactivity(
        &paths,
        &env,
        &["rxa".into(), "acp".into()],
        false,
    )
    .unwrap();
    assert_eq!(fs::read(&state).unwrap(), before);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    assert!(fixture.requests().is_empty());
}
