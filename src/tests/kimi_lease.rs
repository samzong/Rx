use super::*;

#[cfg(unix)]
#[test]
fn kimi_lease_blocks_logout_until_the_exec_process_exits() {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    const CHILD_HOME: &str = "RX_TEST_KIMI_EXEC_HOME";
    const TEST_NAME: &str =
        "tests::kimi_lease::kimi_lease_blocks_logout_until_the_exec_process_exits";
    if let Some(home) = std::env::var_os(CHILD_HOME) {
        let paths = Paths::in_dir(PathBuf::from(home));
        let mut plan = launch::plan(
            &request(Harness::Kimi, Some("acme"), &["--model", "rx-acme/kimi-k3"]),
            &paths,
            &isolated(&[]),
        )
        .unwrap();
        plan.program = PathBuf::from("/bin/sh");
        plan.args = os(&["-c", "printf 'rx lease ready\\n'; read -r release"]);
        launch::exec(&plan).unwrap();
        unreachable!();
    }

    let (_dir, paths) = temp_paths();
    fs::write(&paths.config, fixture_config("http://127.0.0.1:9")).unwrap();
    config::login(&paths, "acme", "sk-secret".to_string()).unwrap();
    let mut native = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST_NAME, "--nocapture"])
        .env(CHILD_HOME, &paths.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(native.stdout.take().unwrap());
    let mut ready = false;
    loop {
        let mut line = String::new();
        if output.read_line(&mut line).unwrap() == 0 {
            break;
        }
        if line.trim() == "rx lease ready" {
            ready = true;
            break;
        }
    }
    let env = isolated(&[
        ("CLAUDE_CONFIG_DIR", paths.dir.to_str().unwrap()),
        ("PI_CODING_AGENT_DIR", paths.dir.to_str().unwrap()),
    ]);
    let active = crate::residue::purge("acme", &paths, &env);
    if ready {
        native.stdin.take().unwrap().write_all(b"release\n").unwrap();
    }
    assert!(native.wait().unwrap().success());
    assert!(ready);
    assert!(active.credential_retained());
    let exited = crate::residue::purge("acme", &paths, &env);
    assert!(exited.removed(), "{:?}", exited.notes());
    assert!(!exited.credential_retained());
}

#[cfg(unix)]
#[test]
fn logout_releases_kimi_lease_held_by_unrelated_child_before_exec() {
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;

    let (_dir, paths) = temp_paths();
    fs::write(&paths.config, fixture_config("http://127.0.0.1:9")).unwrap();
    config::login(&paths, "acme", "sk-secret".to_string()).unwrap();
    let env = isolated(&[
        ("CLAUDE_CONFIG_DIR", paths.dir.to_str().unwrap()),
        ("PI_CODING_AGENT_DIR", paths.dir.to_str().unwrap()),
    ]);
    let plan = launch::plan(
        &request(Harness::Kimi, Some("acme"), &["--model", "rx-acme/kimi-k3"]),
        &paths,
        &env,
    )
    .unwrap();
    let (mut parent, mut child) = UnixStream::pair().unwrap();
    parent.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let spawned = thread::spawn(move || {
        let mut command = std::process::Command::new("/usr/bin/true");
        unsafe {
            command.pre_exec(move || {
                child.write_all(&[1])?;
                child.read_exact(&mut [0])?;
                Ok(())
            });
        }
        command.status().unwrap()
    });
    let ready = parent.read_exact(&mut [0]);
    drop(plan);
    let report = crate::residue::purge("acme", &paths, &env);
    parent.write_all(&[1]).unwrap();
    assert!(spawned.join().unwrap().success());
    ready.unwrap();
    assert!(report.removed(), "{:?}", report.notes());
    assert!(!report.credential_retained());
}
