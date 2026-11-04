use ratatui::{Terminal, backend::TestBackend};

use super::*;
use crate::provider::Setup;

fn state(id: &str, name: &str, configured: bool, default: bool) -> ProviderState {
    ProviderState {
        provider: Provider {
            id: id.to_string(),
            name: name.to_string(),
            endpoint: format!("https://{id}.test/v1"),
            anthropic_base: None,
            default_context: None,
            env: format!("{}_API_KEY", id.to_ascii_uppercase()),
            setup: Setup::Generated,
            default_model: None,
            claude_default_model: None,
        },
        orphaned: false,
        configured,
        stored_key: configured,
        environment_active: false,
        default,
    }
}

#[test]
fn provider_selection_matches_launch_credentials_and_overrides() {
    for id in ["tokener", "custom"] {
        for auth in [AuthMode::ApiKey, AuthMode::Env] {
            for stored in [false, true] {
                for environment in [false, true] {
                    let dir = tempfile::tempdir().unwrap();
                    let paths = Paths::in_dir(dir.path().to_path_buf());
                    let config = crate::config::RxConfig {
                        provider: std::collections::BTreeMap::from([(
                            id.to_string(),
                            crate::config::ProviderConfig {
                                base_url: Some("http://127.0.0.1:1/v1".to_string()),
                                env: Some("CUSTOM_TOKEN".to_string()),
                                auth,
                                ..Default::default()
                            },
                        )]),
                        ..Default::default()
                    };
                    std::fs::write(&paths.config, toml::to_string(&config).unwrap()).unwrap();
                    if stored {
                        std::fs::write(&paths.keys, format!("{id} = \"stored-key\"")).unwrap();
                    }
                    let mut values = std::collections::HashMap::new();
                    if environment {
                        values.insert("CUSTOM_TOKEN".to_string(), "env-key".to_string());
                    }
                    let env = EnvLookup::isolated(values);
                    let states = provider_states(&paths, &env).unwrap();
                    let state = states.iter().find(|state| state.provider.id == id).unwrap();
                    let expected = match auth {
                        AuthMode::ApiKey if stored => Some("stored-key"),
                        AuthMode::Env if environment => Some("env-key"),
                        AuthMode::ApiKey if environment && id == "tokener" => Some("env-key"),
                        _ => None,
                    };
                    assert_eq!(state.configured, expected.is_some());
                    let selection = use_provider(&paths, &env, Some(id));
                    let launched = launch::configured_provider(Some(id), &paths, &env);
                    if let Some(key) = expected {
                        selection.unwrap();
                        let launch::ProviderResolution::Target(target) = launched.unwrap() else {
                            panic!("configured provider must launch");
                        };
                        assert_eq!(target.provider, state.provider);
                        assert_eq!(target.key, key);
                    } else {
                        assert!(selection.is_err());
                        assert!(launched.is_err());
                    }
                    if stored || expected.is_some() {
                        let app = App::new(Action::Logout, &states);
                        assert!(
                            app.filtered_providers()
                                .iter()
                                .any(|index| app.providers[*index].provider.id == id)
                        );
                        logout(&paths, &env, Some(id)).unwrap();
                        assert!(crate::config::stored_key(&paths, id).unwrap().is_none());
                    }
                }
            }
        }
    }
}

#[test]
fn api_key_is_masked_in_the_rendered_terminal() {
    let providers = vec![state("openrouter", "OpenRouter", false, false)];
    let mut app = App::new(Action::Login, &providers);
    app.step = Step::ApiKey;
    app.selected = Some(0);
    app.api_key = "sk-secret".to_string();
    let palette = Palette::current(&EnvLookup::isolated(Default::default()));
    let backend = TestBackend::new(80, 13);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &app, palette)).unwrap();
    let rendered =
        terminal.backend().buffer().content.iter().map(|cell| cell.symbol()).collect::<String>();
    assert!(!rendered.contains("sk-secret"));
}

#[test]
fn list_keeps_a_stored_key_visible_after_its_provider_disappears() {
    let configured = state("openrouter", "OpenRouter", true, true);
    let unconfigured = state("acme", "Acme", false, false);
    let mut orphan = state("retired", "retired", true, false);
    orphan.provider = crate::provider::orphan("retired");
    orphan.orphaned = true;

    let output = render_list(&[&configured, &unconfigured, &orphan]);

    assert!(output.contains("retired"), "{output}");
    assert!(!output.contains("Acme"), "{output}");
    assert!(!orphan.selectable(Action::Use));
    assert!(!orphan.selectable(Action::Login));
    assert!(orphan.selectable(Action::Logout));
}
