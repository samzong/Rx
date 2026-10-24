use super::*;

#[test]
fn agent_passthrough_execs_rx_agent_without_injection() {
    let (_dir, paths) = temp_paths();
    let env = isolated(&[("OPENROUTER_API_KEY", "sk-or-test")]);
    for provider in [None, Some("none")] {
        let env = if provider.is_none() { isolated(&[]) } else { env.clone() };
        let plan =
            launch::plan(&request(Harness::Agent, provider, &["-p", "hi"]), &paths, &env).unwrap();
        assert_eq!(plan.program, PathBuf::from("rx-agent"));
        assert_eq!(plan.args, os(&["-p", "hi"]));
        assert!(plan.env_set.is_empty());
    }
}

#[test]
fn agent_route_hands_off_provider_catalog_with_first_model_as_default() {
    let (_dir, paths) = temp_paths();
    let (base_url, server) = serve_openai_models(
        r#"{"data":[{"id":"glm-5","context_length":200000},{"id":"kimi-k3","name":"Kimi K3","context_length":262144}]}"#,
    );
    fs::write(&paths.config, fixture_config(&base_url)).unwrap();
    let env = isolated(&[("ACME_API_KEY", "sk-fixture")]);
    let plan =
        launch::plan(&request(Harness::Agent, Some("acme"), &["-p", "hi"]), &paths, &env).unwrap();
    server.join().unwrap();
    assert_eq!(plan.program, PathBuf::from("rx-agent"));
    assert_eq!(plan.args, os(&["-p", "hi"]));
    assert_env(&plan, &[("ACME_API_KEY", "sk-fixture")]);
    assert!(!plan.env_set.iter().any(|(key, _)| key == "RX_MODEL"));
    let document: Value = serde_json::from_str(
        &plan.env_set.iter().find(|(key, _)| key == "RX_AGENT_PROVIDER").unwrap().1,
    )
    .unwrap();
    assert_eq!(
        document,
        serde_json::json!({
            "id": "acme",
            "name": "acme",
            "api": "openai-completions",
            "baseUrl": format!("{base_url}/v1"),
            "env": "ACME_API_KEY",
            "models": [
                {"id": "glm-5", "name": "glm-5", "contextWindow": 200000, "reasoning": false},
                {"id": "kimi-k3", "name": "Kimi K3", "contextWindow": 262144, "reasoning": false},
            ],
            "defaultModel": "glm-5",
        })
    );
    assert!(
        !plan
            .env_set
            .iter()
            .any(|(key, value)| key != "ACME_API_KEY" && value.contains("sk-fixture"))
    );
    assert!(plan.stderr_note.is_none());
}

#[test]
fn agent_rx_toml_model_is_the_selected_and_default_model() {
    let (_dir, paths) = temp_paths();
    let (base_url, server) = serve_openai_models(
        r#"{"data":[{"id":"glm-5","context_length":200000},{"id":"kimi-k3","context_length":262144}]}"#,
    );
    fs::write(&paths.config, format!("{}model = \"kimi-k3\"\n", fixture_config(&base_url)))
        .unwrap();
    let env = isolated(&[("ACME_API_KEY", "sk-fixture")]);
    let plan =
        launch::plan(&request(Harness::Agent, Some("acme"), &["-p", "hi"]), &paths, &env).unwrap();
    server.join().unwrap();
    assert_env(&plan, &[("RX_MODEL", "acme/kimi-k3")]);
    let document: Value = serde_json::from_str(
        &plan.env_set.iter().find(|(key, _)| key == "RX_AGENT_PROVIDER").unwrap().1,
    )
    .unwrap();
    assert_eq!(document["defaultModel"], "kimi-k3");
    assert_eq!(entries(&document, "models").len(), 2);
}

#[test]
fn agent_selected_model_survives_an_unavailable_catalog() {
    let (_dir, paths) = temp_paths();
    fs::write(&paths.config, fixture_config("http://127.0.0.1:9")).unwrap();
    let env = isolated(&[("ACME_API_KEY", "sk-fixture")]);
    let plan = launch::plan(
        &request(Harness::Agent, Some("acme"), &["--model", "acme/kimi-k3", "-p", "hi"]),
        &paths,
        &env,
    )
    .unwrap();
    assert_eq!(plan.args, os(&["--model", "acme/kimi-k3", "-p", "hi"]));
    assert!(!plan.env_set.iter().any(|(key, _)| key == "RX_MODEL"));
    let document: Value = serde_json::from_str(
        &plan.env_set.iter().find(|(key, _)| key == "RX_AGENT_PROVIDER").unwrap().1,
    )
    .unwrap();
    assert_eq!(
        document["models"],
        serde_json::json!([{"id": "kimi-k3", "contextWindow": 200000, "reasoning": false}])
    );
    assert_eq!(document["defaultModel"], "kimi-k3");
    assert!(plan.stderr_note.unwrap().contains("handing off only the selected models"));

    fs::write(
        &paths.config,
        format!("{}model = \"glm-5\"\n", fixture_config("http://127.0.0.1:9")),
    )
    .unwrap();
    let plan = launch::plan(
        &request(Harness::Agent, Some("acme"), &["--model", "acme/kimi-k3", "-p", "hi"]),
        &paths,
        &env,
    )
    .unwrap();
    assert_env(&plan, &[("RX_MODEL", "acme/glm-5")]);
    let document: Value = serde_json::from_str(
        &plan.env_set.iter().find(|(key, _)| key == "RX_AGENT_PROVIDER").unwrap().1,
    )
    .unwrap();
    assert_eq!(
        entries(&document, "models").iter().map(|model| &model["id"]).collect::<Vec<_>>(),
        ["kimi-k3", "glm-5"]
    );
    assert_eq!(document["defaultModel"], "glm-5");
    fs::write(&paths.config, fixture_config("http://127.0.0.1:9")).unwrap();
    assert!(launch::plan(&request(Harness::Agent, Some("acme"), &[]), &paths, &env).is_err());
}
