use super::*;

fn os(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

fn request(harness: Option<&str>) -> String {
    serde_json::json!({
        "harness": harness,
        "gateway": {
            "provider_id": "acme",
            "name": "Acme",
            "endpoint": "https://gateway.test/v1",
            "credential_env": "ACME_API_KEY"
        },
        "state_dir": std::env::temp_dir().join("acme-agent"),
        "install_policy": "prompt"
    })
    .to_string()
}

#[test]
fn capabilities_are_stable() {
    let value: serde_json::Value = serde_json::from_str(&capabilities_json().unwrap()).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "protocol": {"major": 1, "minor": 1},
            "harnesses": ["claude", "codex", "opencode", "pi", "dsh", "kimi"],
            "version": crate::RELEASE_VERSION,
        })
    );
}

#[test]
fn host_entrypoint_rejects_malformed_requests() {
    let env = EnvLookup::isolated(HashMap::from([(REQUEST_ENV.to_string(), "{".to_string())]));
    assert!(run(Vec::new(), &env).is_err());
}

#[test]
fn host_entrypoint_rejects_the_rx_agent() {
    for name in ["rx-agent", "agent"] {
        let env =
            EnvLookup::isolated(HashMap::from([(REQUEST_ENV.to_string(), request(Some(name)))]));
        assert!(run(Vec::new(), &env).is_err());
    }
}

#[test]
fn request_rejects_unknown_fields_and_unsafe_profile_values() {
    let mut value: serde_json::Value = serde_json::from_str(&request(None)).unwrap();
    value["gateway_key"] = serde_json::json!("secret");
    assert!(parse_request(&value.to_string()).is_err());
    let mut value: serde_json::Value = serde_json::from_str(&request(None)).unwrap();
    value["gateway"]["credential_env"] = serde_json::json!("KEY;bad");
    assert!(parse_request(&value.to_string()).is_err());
}

#[test]
fn codex_route_overrides_are_rejected_in_native_config_forms() {
    for value in [
        "model_provider=other",
        "openai_base_url='http://127.0.0.1:1'",
        "model_providers.acme.base_url='http://127.0.0.1:1'",
        "model_providers={acme={name='Other',wire_api='responses'}}",
        "model_providers={acme={experimental_bearer_token='synthetic-gateway-secret'}}",
    ] {
        for override_args in [
            os(&["-c", value]),
            os(&["--config", value]),
            os(&[&format!("-c={value}")]),
            os(&[&format!("--config={value}")]),
            os(&[&format!("-c{value}")]),
        ] {
            let error = validate_route_args(Harness::Codex, &override_args, "acme").unwrap_err();
            assert!(!error.to_string().contains("synthetic-gateway-secret"));
            let mut literal = os(&["--"]);
            literal.extend(override_args);
            validate_route_args(Harness::Codex, &literal, "acme").unwrap();
        }
    }
    validate_route_args(Harness::Codex, &os(&["-csandbox_mode='read-only'"]), "acme").unwrap();
}

#[test]
fn model_scopes_follow_the_requested_gateway() {
    for provider in ["acme", "beta"] {
        for harness in [Harness::OpenCode, Harness::Pi] {
            for flag in ["-m", "--model"] {
                for (model, accepted) in
                    [(format!("{provider}/model-a"), true), ("other/model-a".to_string(), false)]
                {
                    assert_eq!(
                        validate_route_args(harness, &os(&[flag, &model]), provider).is_ok(),
                        accepted
                    );
                }
            }
        }
        for (argv, accepted) in [
            (vec!["--provider", provider, "--models", &format!("{provider}/*")], true),
            (vec!["--provider", "other"], false),
            (vec!["--models", &format!("{provider}/*,other/*")], false),
        ] {
            assert_eq!(validate_route_args(Harness::Pi, &os(&argv), provider).is_ok(), accepted);
        }
    }
}
