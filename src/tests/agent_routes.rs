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
fn agent_route_hands_off_provider_catalog_and_first_model() {
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
    assert_env(&plan, &[("ACME_API_KEY", "sk-fixture"), ("RX_MODEL", "acme/glm-5")]);
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
        })
    );
    assert!(
        !plan
            .env_set
            .iter()
            .any(|(key, value)| key != "ACME_API_KEY" && value.contains("sk-fixture"))
    );
    assert!(plan.stderr_note.as_deref().unwrap().contains("using acme/glm-5"));
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
    assert_env(&plan, &[("RX_MODEL", "acme/kimi-k3")]);
    let document: Value = serde_json::from_str(
        &plan.env_set.iter().find(|(key, _)| key == "RX_AGENT_PROVIDER").unwrap().1,
    )
    .unwrap();
    assert_eq!(
        document["models"],
        serde_json::json!([{"id": "kimi-k3", "contextWindow": 200000, "reasoning": false}])
    );
    let note = plan.stderr_note.unwrap();
    assert!(note.contains("handing off only the selected model"));
    assert!(!note.contains("first listed model"));
    assert!(launch::plan(&request(Harness::Agent, Some("acme"), &[]), &paths, &env).is_err());
}
