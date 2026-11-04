use super::*;

#[test]
fn claude_seed_uses_openai_models_and_merges_from_cache() {
    let (_dir, paths) = temp_paths();
    let config_dir = tempfile::tempdir().unwrap();
    let (base_url, server) = serve_openai_models(
        r#"{"data":[{"id":"claude-sonnet-5","display_name":"Sonnet 5","max_input_tokens":200000,"reasoning":{"supported_efforts":["max"]}}]}"#,
    );
    let env = isolated(&[("CLAUDE_CONFIG_DIR", config_dir.path().to_str().unwrap())]);
    let first = claude::try_seed_user_catalog(&paths, "openrouter", &base_url, "sk-test", &env);
    server.join().unwrap();
    assert_eq!(first, claude::SeedOutcome::Seeded);
    let cached: claude::SeedCaches = read_json(paths.dir.join("catalogs/openrouter.claude.json"));
    let config_path = config_dir.path().join(".claude.json");
    let mut document: Value = read_json(&config_path);
    assert_eq!(document["modelAccessCache"][0]["entitled"], true);
    assert!(document["modelAccessCache"][0].get("maxEffortLevel").is_none());
    document["modelAccessCache"][0]["maxEffortLevel"] = json!("max");
    document["rxSeededCatalog"]["modelAccessCache"]["claude-sonnet-5"]["payload"] =
        document["modelAccessCache"][0].clone();
    document["modelAccessCache"].as_array_mut().unwrap().push(json!({
        "apiName": "user-model", "entitled": true, "maxEffortLevel": "high"
    }));
    write_json(&config_path, &document);
    let cache_path = paths.dir.join("catalogs/openrouter.claude.json");
    let mut cached = serde_json::to_value(cached).unwrap();
    cached["model_access"][0]["max_effort_level"] = json!("max");
    write_json(&cache_path, &cached);
    for stale in [false, true] {
        if stale {
            let meta_path = paths.dir.join("catalogs/openrouter.meta.json");
            let mut meta: Value = read_json(&meta_path);
            meta["fetched_at"] = json!(0);
            write_json(&meta_path, &meta);
        }
        let outcome =
            claude::try_seed_user_catalog(&paths, "openrouter", &base_url, "sk-test", &env);
        assert_eq!(outcome, claude::SeedOutcome::Seeded);
        let document: Value = read_json(&config_path);
        assert_eq!(document["additionalModelOptionsCache"][0]["value"], "claude-sonnet-5");
        let access = entries(&document, "modelAccessCache");
        let owned = access.iter().find(|entry| entry["apiName"] == "claude-sonnet-5").unwrap();
        assert_eq!(owned["entitled"], true);
        assert!(owned.get("maxEffortLevel").is_none());
        let unowned = access.iter().find(|entry| entry["apiName"] == "user-model").unwrap();
        assert_eq!(unowned["maxEffortLevel"], "high");
    }
}

#[test]
fn empty_claude_catalog_does_not_claim_seeded_discovery() {
    let (_dir, paths) = temp_paths();
    let config_dir = tempfile::tempdir().unwrap();
    let (base_url, server) = serve_openai_models(r#"{"data":[]}"#);
    let env = isolated(&[("CLAUDE_CONFIG_DIR", config_dir.path().to_str().unwrap())]);
    let outcome = claude::try_seed_user_catalog(&paths, "lab", &base_url, "sk-test", &env);
    server.join().unwrap();
    assert_eq!(outcome, claude::SeedOutcome::Fallback);
    assert!(!config_dir.path().join(".claude.json").exists());
}

#[test]
fn real_claude_plan_uses_seeded_generated_route() {
    let (_dir, paths) = temp_paths();
    let config_dir = tempfile::tempdir().unwrap();
    let (base_url, server) = serve_openai_models(r#"{"data":[{"id":"claude-test"}]}"#);
    fs::write(
        &paths.config,
        format!(
            "[provider.lab]\nbase_url = \"{base_url}\"\nenv = \"LAB_API_KEY\"\nauth = \"env\"\n"
        ),
    )
    .unwrap();
    let env = EnvLookup::real_with(HashMap::from([
        ("CLAUDE_CONFIG_DIR".to_string(), config_dir.path().display().to_string()),
        ("LAB_API_KEY".to_string(), "sk-test".to_string()),
        ("RX_NO_YOLO".to_string(), "1".to_string()),
    ]));
    let plan =
        launch::plan(&request(Harness::Claude, Some("lab"), &["fix it"]), &paths, &env).unwrap();
    server.join().unwrap();
    assert_eq!(plan.args[0], "--settings");
    assert_eq!(plan.args[2], "fix it");
    assert_env(&plan, &[("ANTHROPIC_AUTH_TOKEN", "sk-test")]);
    assert!(config_dir.path().join(".claude.json").is_file());
}

#[test]
fn claude_seed_replaces_previous_provider_catalog_without_dropping_unowned_entries() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join(".claude.json");
    let openrouter = catalog::parse_openai_models(
        r#"{"data":[{"id":"google/gemini-3.7-flash","name":"Gemini","context_length":200000}]}"#,
    )
    .unwrap();
    claude::write_seed(&config_path, &claude::seed_from_listed("openrouter", &openrouter)).unwrap();

    let mut document: Value = read_json(&config_path);
    document["additionalModelOptionsCache"].as_array_mut().unwrap().push(json!({
        "value": "user-model",
        "label": "User",
        "description": "manual",
    }));
    document["modelAccessCache"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "apiName": "user-model", "entitled": true }));
    document["additionalModelCostsCache"]["user-model"] = json!({ "inputTokens": 42.0 });
    document["autoCompactWindowsCache"]["user-model"] = json!(123_456);
    document["cachedGrowthBookFeatures"]["tengu_tool_search_unsupported_models"]
        .as_array_mut()
        .unwrap()
        .push(json!("user-model"));
    write_json(&config_path, &document);

    let lab = catalog::parse_openai_models(
        r#"{"data":[{"id":"claude-sonnet-5","name":"Sonnet 5","context_length":200000}]}"#,
    )
    .unwrap();
    claude::write_seed(&config_path, &claude::seed_from_listed("lab", &lab)).unwrap();
    let document: Value = read_json(&config_path);
    let values = entries(&document, "additionalModelOptionsCache")
        .iter()
        .filter_map(|entry| entry["value"].as_str())
        .collect::<Vec<_>>();
    assert!(!values.contains(&"google/gemini-3.7-flash"));
    assert!(values.contains(&"claude-sonnet-5"));
    assert!(values.contains(&"user-model"));

    let access = entries(&document, "modelAccessCache");
    assert!(!access.iter().any(|entry| entry["apiName"] == "google/gemini-3.7-flash"));
    assert!(access.iter().any(|entry| entry["apiName"] == "claude-sonnet-5"));
    assert!(access.iter().any(|entry| entry["apiName"] == "user-model"));
    assert_eq!(document["additionalModelCostsCache"]["user-model"]["inputTokens"], 42.0);
    assert_eq!(document["autoCompactWindowsCache"]["user-model"], 123_456);
    let denylist = document["cachedGrowthBookFeatures"]["tengu_tool_search_unsupported_models"]
        .as_array()
        .unwrap();
    assert!(!denylist.iter().any(|entry| entry == "google/gemini-3.7-flash"));
    assert!(denylist.iter().any(|entry| entry == "user-model"));
}

#[test]
fn claude_seed_refreshes_and_removes_unmodified_owned_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join(".claude.json");
    let first_seed = claude::build_seed(&[
        model("anthropic/claude-current", "Current Old", 200_000, Some(("0.000001", "0.000003"))),
        model("anthropic/claude-removed", "Removed", 200_000, Some(("0.000001", "0.000003"))),
    ]);
    claude::write_seed(&config_path, &first_seed).unwrap();

    let second_seed = claude::build_seed(&[model(
        "anthropic/claude-current",
        "Current New",
        300_000,
        Some(("0.000002", "0.000004")),
    )]);
    claude::write_seed(&config_path, &second_seed).unwrap();

    let document: Value = read_json(&config_path);
    let options = entries(&document, "additionalModelOptionsCache");
    assert!(
        options
            .iter()
            .any(|entry| { entry["value"] == "claude-current" && entry["label"] == "Current New" })
    );
    assert!(!options.iter().any(|entry| entry["value"] == "claude-removed"));

    let access = entries(&document, "modelAccessCache");
    assert!(
        access
            .iter()
            .any(|entry| { entry["apiName"] == "claude-current" && entry["entitled"] == true })
    );
    assert!(!access.iter().any(|entry| entry["apiName"] == "claude-removed"));
    assert_eq!(document["additionalModelCostsCache"]["claude-current"]["inputTokens"], 2.0);
    assert!(document["additionalModelCostsCache"].get("claude-removed").is_none());
    assert_eq!(document["autoCompactWindowsCache"]["claude-current"], 300_000);
    assert!(document["autoCompactWindowsCache"].get("claude-removed").is_none());
}

#[test]
fn claude_seed_reclaims_modified_owned_payloads_and_preserves_unowned() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join(".claude.json");
    fs::write(
        &config_path,
        r#"{"additionalModelOptionsCache":[{"value":"user-owned","label":"User","description":"manual"}]}"#,
    )
    .unwrap();
    let seed = claude::build_seed(&[model(
        "anthropic/claude-edited",
        "RX",
        200_000,
        Some(("0.000001", "0.000003")),
    )]);
    claude::write_seed(&config_path, &seed).unwrap();

    let mut document: Value = read_json(&config_path);
    let edited_option = document["additionalModelOptionsCache"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["value"] == "claude-edited")
        .unwrap();
    edited_option["label"] = json!("User Override");
    let edited_access = document["modelAccessCache"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["apiName"] == "claude-edited")
        .unwrap();
    edited_access["entitled"] = json!(false);
    document["additionalModelCostsCache"]["claude-edited"]["inputTokens"] = json!(99.0);
    document["autoCompactWindowsCache"]["claude-edited"] = json!(123_456);
    write_json(&config_path, &document);

    claude::write_seed(&config_path, &claude::SeedCaches::default()).unwrap();
    claude::write_seed(&config_path, &seed).unwrap();

    let document: Value = read_json(&config_path);
    let options = entries(&document, "additionalModelOptionsCache");
    assert!(
        options.iter().any(|entry| { entry["value"] == "claude-edited" && entry["label"] == "RX" })
    );
    assert!(options.iter().any(|entry| entry["value"] == "user-owned"));
    assert!(
        entries(&document, "modelAccessCache")
            .iter()
            .any(|entry| { entry["apiName"] == "claude-edited" && entry["entitled"] == true })
    );
    assert_eq!(document["additionalModelCostsCache"]["claude-edited"]["inputTokens"], 1.0);
    assert_eq!(document["autoCompactWindowsCache"]["claude-edited"], 200_000);
}

#[test]
fn claude_seed_recreates_deleted_owned_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join(".claude.json");
    let seed = claude::build_seed(&[model(
        "openai/deleted",
        "Deleted",
        200_000,
        Some(("0.000001", "0.000003")),
    )]);
    claude::write_seed(&config_path, &seed).unwrap();

    let mut document: Value = read_json(&config_path);
    document["additionalModelOptionsCache"]
        .as_array_mut()
        .unwrap()
        .retain(|entry| entry["value"] != "openai/deleted");
    document["modelAccessCache"]
        .as_array_mut()
        .unwrap()
        .retain(|entry| entry["apiName"] != "openai/deleted");
    document["additionalModelCostsCache"].as_object_mut().unwrap().remove("openai/deleted");
    document["autoCompactWindowsCache"].as_object_mut().unwrap().remove("openai/deleted");
    document["cachedGrowthBookFeatures"]["tengu_tool_search_unsupported_models"]
        .as_array_mut()
        .unwrap()
        .retain(|entry| entry != "openai/deleted");
    write_json(&config_path, &document);

    claude::write_seed(&config_path, &seed).unwrap();
    claude::write_seed(&config_path, &seed).unwrap();

    let document: Value = read_json(&config_path);
    assert!(
        entries(&document, "additionalModelOptionsCache")
            .iter()
            .any(|entry| entry["value"] == "openai/deleted")
    );
    assert!(
        entries(&document, "modelAccessCache")
            .iter()
            .any(|entry| entry["apiName"] == "openai/deleted")
    );
    assert_eq!(document["additionalModelCostsCache"]["openai/deleted"]["inputTokens"], 1.0);
    assert_eq!(document["autoCompactWindowsCache"]["openai/deleted"], 200_000);
    assert!(
        document["cachedGrowthBookFeatures"]["tengu_tool_search_unsupported_models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry == "openai/deleted")
    );
}

#[test]
fn claude_seed_does_not_claim_unmarked_matching_identity() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join(".claude.json");
    fs::write(
        &config_path,
        r#"{"additionalModelOptionsCache":[{"value":"claude-existing","label":"User","description":"manual"}]}"#,
    )
    .unwrap();
    let seed = claude::build_seed(&[model("anthropic/claude-existing", "RX", 200_000, None)]);
    claude::write_seed(&config_path, &seed).unwrap();
    claude::write_seed(&config_path, &claude::SeedCaches::default()).unwrap();

    let document: Value = read_json(&config_path);
    assert!(entries(&document, "additionalModelOptionsCache").iter().any(|entry| {
        entry["value"] == "claude-existing"
            && entry["label"] == "User"
            && entry["description"] == "manual"
    }));
}

#[test]
fn concurrent_claude_seed_writes_leave_one_complete_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join(".claude.json");
    fs::write(
        &config_path,
        serde_json::to_vec(&json!({
            "padding": "x".repeat(4_000_000)
        }))
        .unwrap(),
    )
    .unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let mut writers = Vec::new();
    for id in ["anthropic/claude-race-a", "anthropic/claude-race-b"] {
        let path = config_path.clone();
        let barrier = Arc::clone(&barrier);
        let caches = claude::build_seed(&[model(id, id, 200_000, None)]);
        writers.push(thread::spawn(move || {
            barrier.wait();
            claude::write_seed(&path, &caches).unwrap();
        }));
    }
    for writer in writers {
        writer.join().unwrap();
    }
    let document: Value = read_json(&config_path);
    let values = entries(&document, "additionalModelOptionsCache")
        .iter()
        .filter_map(|entry| entry["value"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(values.len(), 1);
    assert!(matches!(values[0], "claude-race-a" | "claude-race-b"));
}

#[test]
fn claude_seed_remerges_external_config_changes() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join(".claude.json");
    fs::write(&config_path, r#"{"before":true}"#).unwrap();
    let caches = claude::build_seed(&[model("anthropic/claude-race-rx", "Race RX", 200_000, None)]);
    let external_path = config_path.clone();
    claude::write_seed_with_hook(&config_path, &caches, |attempt| {
        if attempt == 0 {
            fs::write(&external_path, r#"{"external":"keep"}"#).unwrap();
        }
    })
    .unwrap();
    let document: Value = read_json(&config_path);
    assert_eq!(document["external"], "keep");
    assert!(
        entries(&document, "additionalModelOptionsCache")
            .iter()
            .any(|entry| entry["value"] == "claude-race-rx")
    );
}

#[test]
fn claude_seed_errors_on_non_object_config_root_instead_of_panicking() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join(".claude.json");
    fs::write(&config_path, r#"["not", "an", "object"]"#).unwrap();
    let caches = claude::SeedCaches::default();
    assert!(claude::write_seed(&config_path, &caches).is_err());
    assert_eq!(fs::read_to_string(&config_path).unwrap(), r#"["not", "an", "object"]"#);
}

#[test]
#[ignore = "live OpenRouter network + writes ~/.claude.json when HOME/CLAUDE_CONFIG_DIR aim at temp dir"]
fn live_openrouter_seed_populates_claude_json() {
    let dir = tempfile::tempdir().unwrap();
    let recall = dir.path().join(".recall");
    fs::create_dir_all(&recall).unwrap();
    fs::write(
        recall.join("rx.toml"),
        "default_provider = \"openrouter\"\n\n[provider.openrouter]\n",
    )
    .unwrap();
    let key = std::env::var("OPENROUTER_API_KEY")
        .or_else(|_| std::env::var("ORI_OPENROUTER_API_KEY"))
        .expect("set OPENROUTER_API_KEY for live seed test");
    fs::write(recall.join("rx.keys"), format!("openrouter = \"{key}\"\n")).unwrap();
    let env = isolated(&[
        ("CLAUDE_CONFIG_DIR", dir.path().to_str().unwrap()),
        ("OPENROUTER_API_KEY", &key),
    ]);
    let paths = Paths::in_dir(recall);
    let outcome = claude::try_seed_user_catalog(
        &paths,
        "openrouter",
        "https://openrouter.ai/api",
        &env.get("OPENROUTER_API_KEY").unwrap(),
        &env,
    );
    assert_eq!(outcome, claude::SeedOutcome::Seeded);
    let document: Value = read_json(dir.path().join(".claude.json"));
    let count = entries(&document, "additionalModelOptionsCache").len();
    assert!(count > 100, "expected a large seeded catalog, got {count}");
}

#[test]
fn claude_purge_clears_seeded_caches_and_keeps_user_entries() {
    let (_dir, paths) = temp_paths();
    let config_dir = tempfile::tempdir().unwrap();
    let (base_url, server) = serve_openai_models(
        r#"{"data":[{"id":"claude-sonnet-5","display_name":"Sonnet 5","max_input_tokens":200000}]}"#,
    );
    let env = isolated(&[("CLAUDE_CONFIG_DIR", config_dir.path().to_str().unwrap())]);
    assert_eq!(
        claude::try_seed_user_catalog(&paths, "openrouter", &base_url, "sk-test", &env),
        claude::SeedOutcome::Seeded
    );
    server.join().unwrap();
    let config_path = config_dir.path().join(".claude.json");
    let mut document: Value = read_json(&config_path);
    document["modelAccessCache"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "apiName": "user-model", "entitled": true }));
    document["userSetting"] = json!("keep");
    write_json(&config_path, &document);

    assert_eq!(crate::claude_catalog::purge("lab", &env).unwrap(), crate::residue::Residue::Absent);
    assert_eq!(
        crate::claude_catalog::purge("openrouter", &env).unwrap(),
        crate::residue::Residue::Removed
    );

    let document: Value = read_json(&config_path);
    assert!(document.get("rxSeededCatalog").is_none());
    assert!(document.get("rxSeededToolSearchDenylist").is_none());
    let access = entries(&document, "modelAccessCache");
    assert_eq!(access.len(), 1);
    assert_eq!(access[0]["apiName"], "user-model");
    assert!(document.get("additionalModelOptionsCache").is_none());
    assert_eq!(document["userSetting"], "keep");
}

#[test]
fn claude_purge_keeps_user_edited_seeded_entries() {
    let (_dir, paths) = temp_paths();
    let config_dir = tempfile::tempdir().unwrap();
    let (base_url, server) = serve_openai_models(
        r#"{"data":[{"id":"claude-sonnet-5","display_name":"Sonnet 5","max_input_tokens":200000}]}"#,
    );
    let env = isolated(&[("CLAUDE_CONFIG_DIR", config_dir.path().to_str().unwrap())]);
    assert_eq!(
        claude::try_seed_user_catalog(&paths, "openrouter", &base_url, "sk-test", &env),
        claude::SeedOutcome::Seeded
    );
    server.join().unwrap();
    let config_path = config_dir.path().join(".claude.json");
    let mut document: Value = read_json(&config_path);
    document["modelAccessCache"][0]["entitled"] = json!(false);
    write_json(&config_path, &document);

    assert_eq!(
        crate::claude_catalog::purge("openrouter", &env).unwrap(),
        crate::residue::Residue::Modified(config_path.clone())
    );

    let document: Value = read_json(&config_path);
    assert_eq!(document["modelAccessCache"][0]["apiName"], "claude-sonnet-5");
    assert_eq!(document["modelAccessCache"][0]["entitled"], false);
    assert!(document.get("rxSeededCatalog").is_none());
}
