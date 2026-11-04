use super::*;

#[test]
fn launch_syntax_preserves_harness_provider_and_literal_arguments() {
    use Harness::*;
    type LaunchCase<'a> = (&'a [&'a str], Harness, Option<&'a str>, &'a [&'a str]);
    let cases: &[LaunchCase<'_>] = &[
        (&["/usr/local/bin/rxc", "fix login"], Claude, None, &["fix login"]),
        (&["rxa", "-p", "cargo test"], Agent, None, &["-p", "cargo test"]),
        (&["rxc", "--provider", "acme"], Claude, Some("acme"), &[]),
        (
            &["rx", "--provider", "openrouter", "claude", "--resume", "abc"],
            Claude,
            Some("openrouter"),
            &["--resume", "abc"],
        ),
        (
            &["rx", "claude", "--provider=openrouter", "--resume", "abc"],
            Claude,
            Some("openrouter"),
            &["--resume", "abc"],
        ),
        (
            &["rx", "claude", "--", "--provider", "openrouter"],
            Claude,
            None,
            &["--", "--provider", "openrouter"],
        ),
    ];
    for (argv, harness, provider, passthrough) in cases {
        assert_eq!(
            parse_line(argv),
            Command::Launch(request(*harness, *provider, passthrough)),
            "{argv:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn bash_completions_follow_argument_context() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("rx");
    fs::write(
        &bin,
        "#!/bin/sh\ncase \"$*\" in\n'completions --targets') printf 'openrouter\\nnone\\n';;\n'completions --providers') echo all-provider;;\n'completions --configured') echo configured-provider;;\n*) exit 1;;\nesac\n",
    )
    .unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
    let script = format!(
        "{}\nCOMP_WORDS=(\"$@\"); COMP_CWORD=$(($# - 1)); _rx; if ((${{#COMPREPLY[@]}})); then printf '%s\\n' \"${{COMPREPLY[@]}}\"; fi",
        crate::completions::script(CompletionShell::Bash)
    );
    let cases: &[(&[&str], &[&str])] = &[
        (&["rx", "co"], &["codex", "completions"]),
        (&["rx", "ag"], &["agent"]),
        (&["rx", "rx-a"], &["rx-agent"]),
        (&["rx", "--provider=none", "rx-a"], &["rx-agent"]),
        (&["rx", "rx-agent", "--prov"], &["--provider"]),
        (&["rx", "agent", "--prov"], &["--provider"]),
        (&["rx", "codex", "--prov"], &["--provider"]),
        (&["rx", "--provider", "open"], &["openrouter"]),
        (&["rx", "--provider=open"], &["--provider=openrouter"]),
        (&["rx", "--provider", "=", "open"], &["openrouter"]),
        (&["rx", "--provider", "="], &["openrouter", "none"]),
        (&["rx", "--provider", "=", "none", "co"], &["codex"]),
        (&["rx", "--provider=none", "co"], &["codex"]),
        (&["rx", "codex", "--", "--prov"], &[]),
        (&["rx", "codex", "--", "--provider", "open"], &[]),
        (&["rx", "codex", "--", "--provider=open"], &[]),
        (&["rx", "--provider", "none", "codex", "--", "--prov"], &[]),
        (&["rx", "providers", "lo"], &["login", "logout"]),
        (&["rx", "providers", "login", "all"], &["all-provider"]),
        (&["rx", "providers", "logout", "conf"], &["configured-provider"]),
        (&["rx", "providers", "use", "open"], &["openrouter"]),
        (&["rx", "providers", "models", "update", "conf"], &["configured-provider"]),
        (&["rx", "completions", "z"], &["zsh"]),
        (&["rx", "update", "--y"], &["--yes"]),
        (&["rx", "codex", "--provider", "none", "--prov"], &[]),
    ];
    let check = |words: &[&str], expected: &[&str]| {
        let output = std::process::Command::new("bash")
            .args(["--noprofile", "--norc", "-c", &script, "completion-test"])
            .args(words)
            .env_clear()
            .env("HOME", dir.path())
            .env("PATH", format!("{}:/usr/bin:/bin", dir.path().display()))
            .output()
            .unwrap();
        assert!(output.status.success(), "{words:?}: {}", String::from_utf8_lossy(&output.stderr));
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert_eq!(stdout.lines().collect::<Vec<_>>(), expected, "{words:?}");
    };
    for (words, expected) in cases {
        check(words, expected);
    }
    for alias in ["rxa", "rxc", "rxx", "rxo", "rxp", "rxd", "rxk"] {
        check(&[alias, "--prov"], &["--provider"]);
        check(&[alias, "--", "--prov"], &[]);
        check(&[alias, "--provider", "=", "open"], &["openrouter"]);
    }
}

#[cfg(unix)]
#[test]
fn non_utf8_arguments_survive_passthrough_but_cannot_select_a_provider() {
    use std::os::unix::ffi::OsStringExt;
    let value = OsString::from_vec(vec![b'x', 0xff]);
    for prefix in [&["rx", "claude"][..], &["rx", "claude", "--", "--provider"][..]] {
        let mut argv = os(prefix);
        argv.push(value.clone());
        let Command::Launch(request) = parse(&argv).unwrap() else { panic!("expected launch") };
        assert_eq!(request.passthrough, argv[2..]);
        assert_eq!(request.provider, None);
    }
    let mut argv = os(&["rx", "claude", "--provider"]);
    argv.push(value);
    assert!(parse(&argv).is_err());
}

#[test]
fn argv0_harness_resolves_aliases() {
    assert_eq!(crate::args::argv0_harness("rxa"), Some("rx-agent"));
    assert_eq!(crate::args::argv0_harness("rxx"), Some("codex"));
}
