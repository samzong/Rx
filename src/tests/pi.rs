use super::*;

#[test]
fn pi_openrouter_injects_provider_without_extension() {
    let (_dir, paths) = temp_paths();
    let env = isolated(&[("OPENROUTER_API_KEY", "sk-or-test")]);
    let plan =
        launch::plan(&request(Harness::Pi, Some("openrouter"), &["--print", "hi"]), &paths, &env)
            .unwrap();
    assert_eq!(plan.program, PathBuf::from("pi"));
    assert_eq!(plan.args[0], "--models");
    assert_eq!(plan.args[1], "openrouter/**");
    assert_eq!(plan.args[2], "--provider");
    assert_eq!(plan.args[3], "openrouter");
    assert!(!plan.args.iter().any(|arg| arg == "--approve"));
    assert!(!plan.args.iter().any(|arg| arg == "--extension"));
    assert!(!plan.env_set.iter().any(|(k, _)| k == "PI_CODING_AGENT_DIR"));
    assert_env(&plan, &[("OPENROUTER_API_KEY", "sk-or-test")]);
}

#[test]
fn pi_selected_credential_survives_route_cleanup() {
    let (_dir, paths) = temp_paths();
    for env_key in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CUSTOM_API_KEY"] {
        fs::write(
            &paths.config,
            format!("[provider.openrouter]\nenv = \"{env_key}\"\nauth = \"env\"\n"),
        )
        .unwrap();
        let env = isolated(&[(env_key, "sk-selected")]);
        let plan =
            launch::plan(&request(Harness::Pi, Some("openrouter"), &[]), &paths, &env).unwrap();
        let child_env: HashMap<_, _> = plan.env_set.into_iter().collect();
        assert_eq!(child_env.get(env_key).map(String::as_str), Some("sk-selected"));
        for other in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"] {
            if other != env_key {
                assert_eq!(child_env.get(other).map(String::as_str), Some(""));
            }
        }
    }
}

#[test]
fn pi_merge_provider_refuses_to_reset_corrupt_models_json() {
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    let env = isolated(&[("PI_CODING_AGENT_DIR", dir.path().to_str().unwrap())]);
    for body in [
        "{",
        "[]",
        r#"{"providers":[{"name":"user-entry"}],"other":"keep"}"#,
        r#"{"providers":null}"#,
        r#"{"providers":"user-entry"}"#,
        r#"{"providers":42}"#,
        r#"{"providers":false}"#,
    ] {
        fs::write(&models_path, body).unwrap();
        let provider = json!({ "baseUrl": "https://provider.test/v1" });
        assert!(crate::pi::merge_provider(&models_path, "acme", provider).is_err());
        assert!(crate::pi::purge("acme", &env).is_err());
        assert_eq!(fs::read_to_string(&models_path).unwrap(), body);
    }
}

#[test]
fn pi_purge_removes_only_the_marked_provider() {
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    fs::write(&models_path, r#"{"providers":{"ollama":{"baseUrl":"http://127.0.0.1:11434/v1"}}}"#)
        .unwrap();
    let provider = json!({ "baseUrl": "https://provider.test/v1", "apiKey": "$ACME_API_KEY" });
    crate::pi::merge_provider(&models_path, "acme", provider).unwrap();
    let env = isolated(&[("PI_CODING_AGENT_DIR", dir.path().to_str().unwrap())]);

    assert_eq!(crate::pi::purge("acme", &env).unwrap(), crate::residue::Residue::Removed);

    let document: Value = read_json(&models_path);
    assert!(document["providers"]["ollama"].is_object());
    assert!(document["providers"].get("acme").is_none());
    assert!(!dir.path().join("models.json.rx-catalog.json").exists());
}

#[test]
fn pi_purge_preserves_unmarked_and_reports_user_edited_residue() {
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    let env = isolated(&[("PI_CODING_AGENT_DIR", dir.path().to_str().unwrap())]);
    fs::write(&models_path, r#"{"providers":{"acme":{"baseUrl":"https://provider.test/v1"}}}"#)
        .unwrap();

    assert_eq!(crate::pi::purge("acme", &env).unwrap(), crate::residue::Residue::Absent);
    assert!(read_json::<Value>(&models_path)["providers"]["acme"].is_object());

    let provider = json!({ "baseUrl": "https://provider.test/v1", "apiKey": "$ACME_API_KEY" });
    fs::remove_file(&models_path).unwrap();
    crate::pi::merge_provider(&models_path, "acme", provider).unwrap();
    let mut document: Value = read_json(&models_path);
    document["providers"]["acme"]["baseUrl"] = json!("https://edited.test/v1");
    write_json(&models_path, &document);

    assert_eq!(
        crate::pi::purge("acme", &env).unwrap(),
        crate::residue::Residue::Modified(models_path.clone())
    );
    assert_eq!(
        read_json::<Value>(&models_path)["providers"]["acme"]["baseUrl"],
        "https://edited.test/v1"
    );
}

#[test]
fn pi_alias_plan_and_purge_preserve_unowned_json_bytes() {
    let (dir, paths) = temp_paths();
    let agent_dir = dir.path().join("pi");
    fs::create_dir(&agent_dir).unwrap();
    let models_path = agent_dir.join("models.json");
    let original_entry = r#""a\u0063me" \t: { "z" : 1.2000e+003, "api":"openai-completions", "apiKey":"$USER_KEY", "models":[{"id":"user/model"}], "path":"a\/b\u0020c", "compat" : {"sendSessionAffinityHeaders":true}, "a":-0.0 }"#.replace("\\t", "\t");
    let root_before = r#""before" : {"number":2.000e-2, "escaped":"\u0041\/"}"#;
    let root_after = r#""after"\t: [ 3e+004, "\u0062" ]"#.replace("\\t", "\t");
    let neighbor = r#""neighbor" : { "path":"\/", "models" : [] }"#;
    let original = format!(" \n{{ {root_before}, \"providers\" : {{\n {original_entry},\n {neighbor}\t\n }}, {root_after} }}\n").into_bytes();
    fs::write(&models_path, &original).unwrap();
    let (base_url, server) = serve_openai_models(r#"{"data":[{"id":"nested/model"}]}"#);
    fs::write(&paths.config, fixture_config(&base_url)).unwrap();
    let env = isolated(&[
        ("ACME_API_KEY", "sk-test"),
        ("PI_CODING_AGENT_DIR", agent_dir.to_str().unwrap()),
    ]);

    for _ in 0..2 {
        let plan = launch::plan(&request(Harness::Pi, Some("acme"), &[]), &paths, &env).unwrap();
        assert_eq!(plan.args, os(&["--models", "rx-acme/**", "--provider", "rx-acme"]));
        let document: Value = read_json(&models_path);
        assert_eq!(document["providers"]["rx-acme"]["apiKey"], "$ACME_API_KEY");
        assert_eq!(document["providers"]["rx-acme"]["models"][0]["id"], "nested/model");
        let merged = fs::read(&models_path).unwrap();
        for untouched in [&original_entry, root_before, &root_after, neighbor] {
            assert!(
                merged.windows(untouched.len()).any(|bytes| bytes == untouched.as_bytes()),
                "untouched JSON bytes changed: {untouched}"
            );
        }
    }
    fs::write(&paths.config, format!("{}model = \"nested/model\"\n", fixture_config(&base_url)))
        .unwrap();
    let plan = launch::plan(&request(Harness::Pi, Some("acme"), &[]), &paths, &env).unwrap();
    assert_eq!(plan.args, os(&["--models", "rx-acme/**", "--model", "rx-acme/nested/model"]));
    server.join().unwrap();
    assert_eq!(crate::pi::purge("acme", &env).unwrap(), crate::residue::Residue::Removed);
    assert_eq!(fs::read(&models_path).unwrap(), original);
    assert!(!agent_dir.join("models.json.rx-catalog.json").exists());

    launch::plan(&request(Harness::Pi, Some("acme"), &[]), &paths, &env).unwrap();
    let mut document: Value = read_json(&models_path);
    document["providers"].as_object_mut().unwrap().remove("acme");
    write_json(&models_path, &document);
    let plan = launch::plan(&request(Harness::Pi, Some("acme"), &[]), &paths, &env).unwrap();
    assert_eq!(plan.args, os(&["--models", "rx-acme/**", "--model", "rx-acme/nested/model"]));
    assert!(read_json::<Value>(&models_path)["providers"].get("acme").is_none());
    assert_eq!(crate::pi::purge("acme", &env).unwrap(), crate::residue::Residue::Removed);
    assert!(!agent_dir.join("models.json.rx-catalog.json").exists());
}

#[test]
fn pi_edited_owned_provider_gets_alias_and_remains_after_purge() {
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    let env = isolated(&[("PI_CODING_AGENT_DIR", dir.path().to_str().unwrap())]);
    let provider = json!({ "baseUrl": "https://provider.test/v1" });
    crate::pi::merge_provider(&models_path, "acme", provider.clone()).unwrap();
    let edited = json!({ "baseUrl": "https://edited.test/v1", "user": true });
    write_json(&models_path, &json!({ "providers": { "acme": edited } }));

    crate::pi::merge_provider(&models_path, "acme", provider.clone()).unwrap();
    let document: Value = read_json(&models_path);
    assert_eq!(document["providers"]["acme"], edited);
    assert_eq!(document["providers"]["rx-acme"], provider);
    assert_eq!(
        crate::pi::purge("acme", &env).unwrap(),
        crate::residue::Residue::Modified(models_path.clone())
    );
    assert_eq!(read_json::<Value>(&models_path), json!({ "providers": { "acme": edited } }));
    assert_eq!(
        crate::pi::purge("acme", &env).unwrap(),
        crate::residue::Residue::Modified(models_path)
    );
}

#[test]
fn pi_alias_collision_never_claims_matching_or_edited_values() {
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    let marker_path = dir.path().join("models.json.rx-catalog.json");
    let provider = json!({ "baseUrl": "https://provider.test/v1" });
    write_json(&models_path, &json!({ "providers": { "acme": provider, "rx-acme": provider } }));
    let before = fs::read(&models_path).unwrap();
    assert!(crate::pi::merge_provider(&models_path, "acme", provider.clone()).is_err());
    assert_eq!(fs::read(&models_path).unwrap(), before);
    assert!(!marker_path.exists());

    write_json(&models_path, &json!({ "providers": { "acme": provider } }));
    crate::pi::merge_provider(&models_path, "acme", provider.clone()).unwrap();
    let mut document: Value = read_json(&models_path);
    document["providers"]["rx-acme"]["user"] = json!(true);
    write_json(&models_path, &document);
    let before = fs::read(&models_path).unwrap();
    let marker_before = fs::read(&marker_path).unwrap();
    assert!(crate::pi::merge_provider(&models_path, "acme", provider).is_err());
    assert_eq!(fs::read(&models_path).unwrap(), before);
    assert_eq!(fs::read(&marker_path).unwrap(), marker_before);
}

#[test]
fn pi_v1_marker_migrates_without_losing_other_provider_ownership() {
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    let marker_path = dir.path().join("models.json.rx-catalog.json");
    let env = isolated(&[("PI_CODING_AGENT_DIR", dir.path().to_str().unwrap())]);
    let old = json!({ "baseUrl": "https://old.test/v1" });
    let other_bytes = r#""other" : {"baseUrl":"https:\/\/other.test\/v1", "number":1.2000e+03}"#;
    let other: Value = serde_json::from_str(other_bytes.split_once(':').unwrap().1).unwrap();
    let root_bytes = r#""root" : "\u0041\/""#;
    fs::write(
        &models_path,
        format!("{{ \"providers\" : {{ \"acme\" : {old}, {other_bytes} }}, {root_bytes} }}"),
    )
    .unwrap();
    write_json(
        &marker_path,
        &json!({ "version": 1, "providers": { "acme": old, "other": other } }),
    );
    let new = json!({ "baseUrl": "https://new.test/v1" });

    assert_eq!(crate::pi::merge_provider(&models_path, "acme", new.clone()).unwrap(), "acme");
    assert_eq!(read_json::<Value>(&models_path)["providers"]["acme"], new);
    let merged = fs::read(&models_path).unwrap();
    for untouched in [other_bytes, root_bytes] {
        assert!(merged.windows(untouched.len()).any(|bytes| bytes == untouched.as_bytes()));
    }
    assert_eq!(read_json::<Value>(&marker_path)["version"], 2);
    assert_eq!(crate::pi::purge("acme", &env).unwrap(), crate::residue::Residue::Removed);
    assert_eq!(read_json::<Value>(&models_path)["providers"]["other"], other);
    let purged = fs::read(&models_path).unwrap();
    for untouched in [other_bytes, root_bytes] {
        assert!(purged.windows(untouched.len()).any(|bytes| bytes == untouched.as_bytes()));
    }
    assert_eq!(crate::pi::purge("other", &env).unwrap(), crate::residue::Residue::Removed);
    assert!(!marker_path.exists());
}

#[test]
fn pi_alias_ownership_cannot_be_claimed_by_another_logical_provider() {
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    let env = isolated(&[("PI_CODING_AGENT_DIR", dir.path().to_str().unwrap())]);
    let original = json!({ "baseUrl": "https://user.test/v1" });
    write_json(&models_path, &json!({ "providers": { "acme": original } }));
    let first = json!({ "baseUrl": "https://first.test/v1" });
    assert_eq!(crate::pi::merge_provider(&models_path, "acme", first.clone()).unwrap(), "rx-acme");
    let second = json!({ "baseUrl": "https://second.test/v1" });
    assert_eq!(
        crate::pi::merge_provider(&models_path, "rx-acme", second.clone()).unwrap(),
        "rx-rx-acme"
    );

    assert_eq!(crate::pi::purge("rx-acme", &env).unwrap(), crate::residue::Residue::Removed);
    assert_eq!(
        read_json::<Value>(&models_path),
        json!({ "providers": { "acme": original, "rx-acme": first } })
    );
    assert_eq!(crate::pi::purge("acme", &env).unwrap(), crate::residue::Residue::Removed);
    assert_eq!(read_json::<Value>(&models_path), json!({ "providers": { "acme": original } }));
}

#[test]
fn pi_corrupt_marker_blocks_merge_and_purge_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    let marker_path = dir.path().join("models.json.rx-catalog.json");
    let env = isolated(&[("PI_CODING_AGENT_DIR", dir.path().to_str().unwrap())]);
    let provider = json!({ "baseUrl": "https://provider.test/v1" });
    for marker in [
        "{",
        "[]",
        r#"{"version":99,"providers":{}}"#,
        r#"{"version":2,"providers":{"acme":{}}}"#,
        r#"{"version":2,"providers":{"unrelated":{"provider_id":"acme","value":{}}}}"#,
    ] {
        write_json(&models_path, &json!({ "providers": { "acme": provider } }));
        fs::write(&marker_path, marker).unwrap();
        let before = fs::read(&models_path).unwrap();
        assert!(
            crate::pi::merge_provider(&models_path, "acme", json!({ "changed": true })).is_err()
        );
        assert_eq!(fs::read(&models_path).unwrap(), before);
        assert_eq!(fs::read_to_string(&marker_path).unwrap(), marker);
        assert!(crate::pi::purge("acme", &env).is_err());
        assert_eq!(fs::read(&models_path).unwrap(), before);
        assert_eq!(fs::read_to_string(&marker_path).unwrap(), marker);
    }
}
