use super::*;

#[test]
fn a_stored_key_outlives_its_provider_and_can_still_be_removed() {
    let (_dir, paths) = temp_paths();
    let env = isolated(&[]);
    fs::write(
        &paths.config,
        "default_provider = \"retired\"\n\n[provider.retired]\nauth = \"api_key\"\n",
    )
    .unwrap();
    fs::write(&paths.keys, "retired = \"sk-stranded\"\n").unwrap();

    let configured =
        crate::providers::completion_ids(&paths, &env, ProviderIdFilter::Configured).unwrap();
    assert!(configured.contains(&"retired".to_string()), "{configured:?}");
    let targets =
        crate::providers::completion_ids(&paths, &env, ProviderIdFilter::Targets).unwrap();
    assert!(!targets.contains(&"retired".to_string()), "{targets:?}");

    crate::run_with(os(&["rx", "providers", "logout", "retired"]), &paths, &env).unwrap();

    assert_eq!(config::stored_key(&paths, "retired").unwrap(), None);
    assert_eq!(config::load(&paths).unwrap().unwrap().default_provider, None);
}

#[test]
fn bundled_providers_match_the_admission_list() {
    let admission: Value =
        serde_json::from_str(include_str!("../../data/provider-admission.json")).unwrap();
    let models_dev = entries(&admission, "models_dev_ids")
        .iter()
        .map(|entry| entry.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    let managed = entries(&admission, "managed")
        .iter()
        .map(|entry| entry["id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    let admitted = models_dev
        .iter()
        .take(1)
        .chain(managed.iter().take(1))
        .chain(models_dev.iter().skip(1))
        .chain(managed.iter().skip(1))
        .cloned()
        .collect::<Vec<_>>();
    let bundled =
        provider::catalog().iter().map(|provider| provider.id.clone()).collect::<Vec<_>>();
    assert_eq!(bundled, admitted);
    for provider in provider::catalog() {
        provider::validate_id(&provider.id).unwrap();
        assert!(provider.endpoint.starts_with("https://"), "{}", provider.id);
        assert!(!provider.endpoint.contains("${"), "{}", provider.id);
        assert!(!provider.env.is_empty(), "{}", provider.id);
        if let Some(claude) = &provider.anthropic_base {
            assert!(claude.starts_with("https://"), "{}", provider.id);
            assert!(!claude.contains("${"), "{}", provider.id);
        }
        if let Some(context) = provider.default_context {
            assert!(context > 0, "{}", provider.id);
        }
    }
}

#[test]
fn custom_provider_does_not_inherit_catalog_env_key() {
    let (_dir, paths) = temp_paths();
    fs::write(
        &paths.config,
        r#"default_provider = "tokener-dev"

[provider.tokener-dev]
base_url = "https://dev.provider.test"
"#,
    )
    .unwrap();
    let env = isolated(&[("TOKENER_API_KEY", "sk-prod")]);

    assert!(launch::plan(&request(Harness::Codex, None, &[]), &paths, &env).is_err());
}

#[test]
fn provider_login_stores_secret_permissions_and_launches() {
    let (_dir, paths) = temp_paths();
    config::login(&paths, "openrouter", "sk-secret".to_string()).unwrap();

    let loaded = config::load(&paths).unwrap().unwrap();
    assert_eq!(loaded.default_provider.as_deref(), Some("openrouter"));
    assert_eq!(loaded.provider["openrouter"].auth, config::AuthMode::ApiKey);

    let stored = fs::read_to_string(&paths.keys).unwrap();
    assert!(stored.contains("sk-secret"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&paths.keys).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir_mode = fs::metadata(&paths.dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
    }

    let env = isolated(&[]);
    let plan = launch::plan(&request(Harness::Claude, None, &[]), &paths, &env).unwrap();
    assert_eq!(plan.env_set[1], ("ANTHROPIC_API_KEY".to_string(), "sk-secret".to_string()));
}

#[test]
fn provider_login_does_not_switch_auth_when_keys_cannot_be_loaded() {
    let (_dir, paths) = temp_paths();
    fs::write(
        &paths.config,
        r#"default_provider = "openrouter"

[provider.openrouter]
base_url = "https://openrouter.ai/api"
auth = "env"
"#,
    )
    .unwrap();
    fs::write(&paths.keys, "{").unwrap();

    assert!(config::login(&paths, "openrouter", "sk-secret".to_string()).is_err());

    let config = config::load(&paths).unwrap().unwrap();
    assert_eq!(config.provider["openrouter"].auth, config::AuthMode::Env);
}

#[test]
fn overlapping_provider_mutations_preserve_distinct_updates() {
    let (_dir, paths) = temp_paths();
    let ids = (0..24).map(|index| format!("custom-{index}")).collect::<Vec<_>>();
    fs::write(
        &paths.config,
        ids.iter()
            .map(|id| {
                format!(
                    "[provider.{id}]\nbase_url = \"https://provider.test/v1\"\nauth = \"env\"\n"
                )
            })
            .collect::<String>(),
    )
    .unwrap();
    fs::write(
        &paths.keys,
        ids[12..].iter().map(|id| format!("{id} = \"old-key\"\n")).collect::<String>(),
    )
    .unwrap();
    let barrier = std::sync::Barrier::new(ids.len() + 2);
    thread::scope(|scope| {
        for (index, id) in ids.iter().enumerate() {
            let paths = &paths;
            let barrier = &barrier;
            scope.spawn(move || {
                barrier.wait();
                if index < 12 {
                    config::login(paths, id, format!("key-{id}")).unwrap();
                } else {
                    assert!(config::logout(paths, id).unwrap());
                }
            });
        }
        scope.spawn(|| {
            barrier.wait();
            config::set_default(&paths, &ids[0]).unwrap();
        });
        scope.spawn(|| {
            barrier.wait();
            config::set_none(&paths).unwrap();
        });
    });
    let loaded = config::load_or_default(&paths).unwrap();
    assert_eq!(loaded.provider.len(), ids.len());
    for (index, id) in ids.iter().enumerate() {
        assert_eq!(
            config::stored_key(&paths, id).unwrap(),
            (index < 12).then(|| format!("key-{id}"))
        );
        assert_eq!(
            loaded.provider[id].auth,
            if index < 12 { config::AuthMode::ApiKey } else { config::AuthMode::Env }
        );
        assert_eq!(loaded.provider[id].base_url.as_deref(), Some("https://provider.test/v1"));
    }
}

#[test]
fn provider_default_selection_preserves_env_auth() {
    let (_dir, paths) = temp_paths();
    fs::write(
        &paths.config,
        r#"[provider.custom]
base_url = "https://provider.test/v1"
env = "CUSTOM_API_KEY"
auth = "env"
"#,
    )
    .unwrap();

    config::set_default(&paths, "custom").unwrap();

    let loaded = config::load(&paths).unwrap().unwrap();
    assert_eq!(loaded.default_provider.as_deref(), Some("custom"));
    assert_eq!(loaded.provider["custom"].auth, config::AuthMode::Env);
    assert!(!paths.keys.exists());
}

#[test]
fn provider_use_argument_sets_default_without_a_terminal() {
    let (_dir, paths) = temp_paths();
    fs::write(&paths.config, fixture_config("https://provider.test/v1")).unwrap();
    config::login(&paths, "openrouter", "sk-openrouter".to_string()).unwrap();
    config::login(&paths, "acme", "sk-fixture".to_string()).unwrap();

    crate::run_with(os(&["rx", "providers", "use", "openrouter"]), &paths, &isolated(&[])).unwrap();

    let loaded = config::load(&paths).unwrap().unwrap();
    assert_eq!(loaded.default_provider.as_deref(), Some("openrouter"));
}

#[test]
fn provider_logout_argument_removes_key_without_a_terminal() {
    let (_dir, paths) = temp_paths();
    fs::write(&paths.config, fixture_config("https://provider.test/v1")).unwrap();
    config::login(&paths, "acme", "sk-fixture".to_string()).unwrap();

    crate::run_with(os(&["rx", "providers", "logout", "acme"]), &paths, &isolated(&[])).unwrap();

    assert!(config::stored_key(&paths, "acme").unwrap().is_none());
}

#[test]
fn providers_keep_independent_keys_and_behavior() {
    let (dir, paths) = temp_paths();
    let (dev_base_url, server) = serve_openai_models(r#"{"data":[{"id":"gpt-dev"}]}"#);
    fs::write(
        &paths.config,
        format!(
            r#"default_provider = "lab-dev"

[provider.lab-dev]
base_url = "{dev_base_url}"
model = "gpt-dev"

[provider.lab-prod]
base_url = "https://prod.provider.test"
model = "gpt-prod"
"#
        ),
    )
    .unwrap();

    config::login(&paths, "lab-prod", "sk-prod".to_string()).unwrap();
    config::login(&paths, "lab-dev", "sk-dev".to_string()).unwrap();
    config::set_default(&paths, "lab-prod").unwrap();

    let loaded = config::load(&paths).unwrap().unwrap();
    assert_eq!(loaded.default_provider.as_deref(), Some("lab-prod"));
    assert_eq!(loaded.provider["lab-dev"].base_url.as_deref(), Some(dev_base_url.as_str()));
    assert_eq!(loaded.provider["lab-prod"].base_url.as_deref(), Some("https://prod.provider.test"));

    let agent_dir = dir.path().join("pi-agent");
    let env = isolated(&[("PI_CODING_AGENT_DIR", agent_dir.to_str().unwrap())]);
    let codex = launch::plan(&request(Harness::Codex, Some("lab-dev"), &[]), &paths, &env).unwrap();
    assert_eq!(codex.args[1], "model_provider=\"lab-dev\"");
    assert!(arg_str(&codex.args[3]).contains("model_providers.lab-dev="));
    assert!(arg_str(&codex.args[3]).contains(&format!("base_url=\"{dev_base_url}/v1\"")));
    assert_eq!(
        codex.env_set,
        vec![("RX_PROVIDER_LAB_DEV_API_KEY".to_string(), "sk-dev".to_string())]
    );

    let opencode =
        launch::plan(&request(Harness::OpenCode, Some("lab-dev"), &[]), &paths, &env).unwrap();
    assert_eq!(opencode.args, ["--auto", "-m", "lab-dev/gpt-dev"]);
    let opencode_config = opencode
        .env_set
        .iter()
        .find(|(name, _)| name == "OPENCODE_CONFIG_CONTENT")
        .map(|(_, value)| serde_json::from_str::<Value>(value).unwrap())
        .unwrap();
    assert!(opencode_config["provider"]["lab-dev"].is_object());
    assert!(opencode_config["provider"]["lab-prod"].is_null());

    let pi = launch::plan(&request(Harness::Pi, Some("lab-dev"), &[]), &paths, &env).unwrap();
    assert_eq!(pi.args, ["--models", "lab-dev/*", "--model", "lab-dev/gpt-dev"]);
    let pi_models: Value = read_json(agent_dir.join("models.json"));
    assert!(pi_models["providers"]["lab-dev"].is_object());
    assert!(pi_models["providers"]["lab-prod"].is_null());
    server.join().unwrap();

    let claude =
        launch::plan(&request(Harness::Claude, Some("lab-prod"), &[]), &paths, &env).unwrap();
    assert_env(
        &claude,
        &[
            ("ANTHROPIC_BASE_URL", "https://prod.provider.test"),
            ("ANTHROPIC_AUTH_TOKEN", "sk-prod"),
        ],
    );
}

#[test]
fn provider_names_cannot_escape_generated_config_boundaries() {
    let (_dir, paths) = temp_paths();
    fs::write(
        &paths.config,
        r#"default_provider = "../prod"

[provider."../prod"]
base_url = "https://provider.test/v1"
"#,
    )
    .unwrap();

    assert!(launch::plan(&request(Harness::Pi, None, &[]), &paths, &isolated(&[])).is_err());
}

#[test]
fn logout_cascade_clears_the_plaintext_key_kimi_stored_for_the_provider() {
    let (_dir, paths) = temp_paths();
    fs::write(&paths.config, fixture_config("http://127.0.0.1:9")).unwrap();
    config::login(&paths, "acme", "sk-secret".to_string()).unwrap();
    let env = isolated(&[]);
    let plan = launch::plan(
        &request(Harness::Kimi, Some("acme"), &["--model", "rx-acme/kimi-k3"]),
        &paths,
        &env,
    )
    .unwrap();
    let kimi_config = paths.dir.join("kimi-code").join("config.toml");
    assert!(fs::read_to_string(&kimi_config).unwrap().contains("sk-secret"));
    drop(plan);

    let report = crate::residue::purge("acme", &paths, &env);
    assert!(report.removed(), "{:?}", report.notes());
    assert!(!report.credential_retained());
    assert!(config::logout(&paths, "acme").unwrap());

    assert!(!fs::read_to_string(&kimi_config).unwrap().contains("sk-secret"));
    assert!(!fs::read_to_string(&paths.keys).unwrap().contains("sk-secret"));
    assert!(!paths.dir.join("catalogs").join("acme.models.json").exists());
}

#[test]
fn logout_keeps_the_stored_key_while_a_kimi_session_holds_the_plaintext_copy() {
    let (_dir, paths) = temp_paths();
    fs::write(&paths.config, fixture_config("http://127.0.0.1:9")).unwrap();
    config::login(&paths, "acme", "sk-secret".to_string()).unwrap();
    let env = isolated(&[]);
    let plan = launch::plan(
        &request(Harness::Kimi, Some("acme"), &["--model", "rx-acme/kimi-k3"]),
        &paths,
        &env,
    )
    .unwrap();
    let kimi_config = paths.dir.join("kimi-code").join("config.toml");

    crate::providers::run(
        crate::args::ProvidersCommand::Logout { provider: Some("acme".to_string()) },
        &paths,
        &env,
    )
    .unwrap();

    assert_eq!(config::stored_key(&paths, "acme").unwrap().as_deref(), Some("sk-secret"));
    assert!(fs::read_to_string(&kimi_config).unwrap().contains("sk-secret"));
    drop(plan);

    crate::providers::run(
        crate::args::ProvidersCommand::Logout { provider: Some("acme".to_string()) },
        &paths,
        &env,
    )
    .unwrap();

    assert_eq!(config::stored_key(&paths, "acme").unwrap(), None);
    assert!(!fs::read_to_string(&kimi_config).unwrap().contains("sk-secret"));
}
