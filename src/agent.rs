use std::ffi::OsString;

use anyhow::{Result, bail};
use serde_json::{Map, Value, json};

use crate::args;
use crate::catalog::{self, ListedModel, openai_base};
use crate::config::Paths;
use crate::launch::EnvLookup;
use crate::provider::{ModelProtocol, Provider, ReasoningLevel, Setup};

pub(crate) const PROGRAM: &str = "rx-agent";
pub(crate) const PROVIDER_ENV: &str = "RX_AGENT_PROVIDER";
pub(crate) const MODEL_ENV: &str = "RX_MODEL";

pub(crate) struct Route {
    pub env_set: Vec<(String, String)>,
    pub note: Option<String>,
}

pub(crate) fn route(
    provider: &Provider,
    key: &str,
    model: Option<&str>,
    passthrough: &[OsString],
    paths: &Paths,
    env: &EnvLookup,
) -> Result<Route> {
    let base_url = provider.endpoint.as_str();
    let prefix = format!("{}/", provider.id);
    let (user_model, _) = args::take_model(passthrough)?;
    let requested = user_model.as_deref().and_then(|spec| spec.strip_prefix(&prefix));
    let fallback = model.or(provider.default_model);
    let allow_fetch = env.is_real() || provider.setup == Setup::Generated;
    let mut notes = Vec::new();
    let mut models = match catalog::load_listed_models(
        paths,
        &provider.id,
        base_url,
        key,
        allow_fetch,
    ) {
        Ok(models) => models,
        Err(error) if requested.or(fallback).is_some() => {
            notes.push(format!(
                    "[rx] rx-agent: provider catalog unavailable; handing off only the selected models: {error:#}"
                ));
            Vec::new()
        }
        Err(error) => return Err(error),
    };
    for id in [fallback, requested].into_iter().flatten() {
        if !models.iter().any(|listed| listed.id == id) {
            models.insert(0, ListedModel { id: id.to_string(), name: None, context_length: None });
        }
    }
    let Some(first) = models.first() else {
        bail!(
            "{} returned no models from {}; run: rx providers models update {}",
            provider.name,
            openai_base(base_url),
            provider.id
        );
    };
    let default_model = fallback.unwrap_or(&first.id);
    let protocol = crate::provider::dsh_protocol(&provider.id, base_url);
    let document = json!({
        "id": provider.id,
        "name": provider.name,
        "api": protocol.as_str(),
        "baseUrl": openai_base(base_url),
        "env": provider.env,
        "models": models
            .iter()
            .map(|listed| model_entry(provider, protocol, listed))
            .collect::<Vec<_>>(),
        "defaultModel": default_model,
    });
    let mut env_set = vec![
        (provider.env.clone(), key.to_string()),
        (PROVIDER_ENV.to_string(), document.to_string()),
    ];
    if let Some(model) = model {
        env_set.push((MODEL_ENV.to_string(), format!("{}/{model}", provider.id)));
    }
    Ok(Route { env_set, note: (!notes.is_empty()).then(|| notes.join("\n")) })
}

fn model_entry(provider: &Provider, protocol: ModelProtocol, listed: &ListedModel) -> Value {
    let mut entry = Map::new();
    entry.insert("id".into(), listed.id.clone().into());
    if let Some(name) = &listed.name {
        entry.insert("name".into(), name.clone().into());
    }
    let context = listed.context_length.unwrap_or_else(|| catalog::fallback_context(&provider.id));
    entry.insert("contextWindow".into(), context.into());
    let messages = ModelProtocol::AnthropicMessages;
    let protocol =
        if crate::provider::serves(&provider.id, &provider.endpoint, &listed.id, messages) {
            entry.insert("api".into(), messages.as_str().into());
            entry.insert("baseUrl".into(), crate::provider::claude_base(provider).into());
            messages
        } else if crate::provider::serves(
            &provider.id,
            &provider.endpoint,
            &listed.id,
            ModelProtocol::OpenAiCompletions,
        ) {
            entry.insert("api".into(), ModelProtocol::OpenAiCompletions.as_str().into());
            ModelProtocol::OpenAiCompletions
        } else {
            protocol
        };
    let control =
        crate::provider::reasoning_control(&provider.id, &provider.endpoint, &listed.id, protocol);
    entry.insert("reasoning".into(), control.is_some().into());
    if let Some(control) = control {
        let levels = control.levels();
        let map = ReasoningLevel::ALL
            .iter()
            .map(|level| {
                let wire = levels.get(level).cloned().flatten();
                (level.as_str().to_string(), wire.map_or(Value::Null, Value::from))
            })
            .collect::<Map<_, _>>();
        entry.insert("thinkingLevelMap".into(), Value::Object(map));
        if protocol == ModelProtocol::OpenAiCompletions
            && let Some(compat) = control.completions_compat()
        {
            entry.insert("compat".into(), compat);
        }
    }
    Value::Object(entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokener_reasoning_capabilities_project_to_pi_ai_levels() {
        let provider = crate::provider::find("tokener").unwrap();
        let protocol = crate::provider::dsh_protocol("tokener", &provider.endpoint);
        let entry = |id: &str| {
            model_entry(
                provider,
                protocol,
                &ListedModel { id: id.to_string(), name: None, context_length: None },
            )
        };
        assert_eq!(entry("gpt-5.6-sol")["thinkingLevelMap"]["max"], "max");
        assert_eq!(entry("glm-5.2")["reasoning"], true);
        assert_eq!(entry("glm-5.2")["thinkingLevelMap"]["high"], Value::Null);
        assert_eq!(entry("kimi-k3")["api"], "openai-completions");
        assert_eq!(entry("kimi-k3")["thinkingLevelMap"]["off"], "disabled");
        assert_eq!(entry("kimi-k3")["thinkingLevelMap"]["high"], "enabled");
        assert_eq!(entry("kimi-k3.1")["thinkingLevelMap"]["off"], Value::Null);
        assert_eq!(entry("kimi-k3.1")["thinkingLevelMap"]["high"], "high");
        assert_eq!(
            entry("kimi-k3.1-pro")["thinkingLevelMap"],
            entry("kimi-k3")["thinkingLevelMap"]
        );
    }

    #[test]
    fn tokener_claude_models_route_to_anthropic_messages() {
        let provider = crate::provider::find("tokener").unwrap();
        let listed =
            ListedModel { id: "claude-opus-5".to_string(), name: None, context_length: None };
        let protocol = crate::provider::dsh_protocol("tokener", &provider.endpoint);
        let entry = model_entry(provider, protocol, &listed);
        assert_eq!(entry["api"], "anthropic-messages");
        assert_eq!(entry["baseUrl"], "https://api.tokener.ai");
        assert_eq!(entry["reasoning"], true);
        let proxied =
            Provider { endpoint: "https://proxy.example/v1".to_string(), ..provider.clone() };
        let entry = model_entry(&proxied, protocol, &listed);
        assert!(entry.get("api").is_none());
        assert_eq!(entry["reasoning"], false);
    }
}
