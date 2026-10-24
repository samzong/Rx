use std::ffi::OsString;

use anyhow::{Result, bail};
use serde_json::{Map, Value, json};

use crate::args;
use crate::catalog::{self, ListedModel, openai_base};
use crate::config::Paths;
use crate::launch::EnvLookup;
use crate::provider::{ModelProtocol, Provider, ReasoningControl, ReasoningLevel, Setup};

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
    let preferred = requested.or(model);
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
        Err(error) if preferred.is_some() => {
            notes.push(format!(
                    "[rx] agent: provider catalog unavailable; handing off only the selected model: {error:#}"
                ));
            Vec::new()
        }
        Err(error) => return Err(error),
    };
    if let Some(preferred) = preferred.filter(|id| !models.iter().any(|listed| listed.id == *id)) {
        models
            .insert(0, ListedModel { id: preferred.to_string(), name: None, context_length: None });
    }
    let Some(first) = models.first() else {
        bail!(
            "{} returned no models from {}; run: rx providers models update {}",
            provider.name,
            openai_base(base_url),
            provider.id
        );
    };
    if preferred.is_none() && user_model.is_none() {
        notes.push(format!(
            "[rx] agent: using {}/{} (first listed model; set model in rx.toml or pass --model)",
            provider.id, first.id
        ));
    }
    let selected = preferred.unwrap_or(&first.id);
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
    });
    Ok(Route {
        env_set: vec![
            (provider.env.clone(), key.to_string()),
            (PROVIDER_ENV.to_string(), document.to_string()),
            (MODEL_ENV.to_string(), format!("{}/{selected}", provider.id)),
        ],
        note: (!notes.is_empty()).then(|| notes.join("\n")),
    })
}

fn model_entry(provider: &Provider, protocol: ModelProtocol, listed: &ListedModel) -> Value {
    let mut entry = Map::new();
    entry.insert("id".into(), listed.id.clone().into());
    if let Some(name) = &listed.name {
        entry.insert("name".into(), name.clone().into());
    }
    let context = listed.context_length.unwrap_or_else(|| catalog::fallback_context(&provider.id));
    entry.insert("contextWindow".into(), context.into());
    let control =
        crate::provider::reasoning_control(&provider.id, &provider.endpoint, &listed.id, protocol);
    let levels = match control {
        Some(ReasoningControl::Effort { levels }) => Some(levels),
        _ => None,
    };
    entry.insert("reasoning".into(), levels.is_some().into());
    if let Some(levels) = levels {
        let map = ReasoningLevel::ALL
            .iter()
            .map(|level| {
                let wire = levels.get(level).cloned().flatten();
                (level.as_str().to_string(), wire.map_or(Value::Null, Value::from))
            })
            .collect::<Map<_, _>>();
        entry.insert("thinkingLevelMap".into(), Value::Object(map));
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
        assert_eq!(protocol, ModelProtocol::OpenAiResponses);
        let entry = |id: &str| {
            model_entry(
                provider,
                protocol,
                &ListedModel { id: id.to_string(), name: None, context_length: Some(400_000) },
            )
        };
        assert_eq!(
            entry("gpt-5.6-sol"),
            json!({
                "id": "gpt-5.6-sol",
                "contextWindow": 400_000,
                "reasoning": true,
                "thinkingLevelMap": {
                    "off": "none", "minimal": null, "low": "low", "medium": "medium",
                    "high": "high", "xhigh": "xhigh", "max": "max",
                },
            })
        );
        assert_eq!(
            entry("glm-5.2")["thinkingLevelMap"],
            json!({
                "off": "none", "minimal": null, "low": "low", "medium": "medium",
                "high": null, "xhigh": null, "max": null,
            })
        );
        assert_eq!(
            entry("kimi-k3"),
            json!({"id": "kimi-k3", "contextWindow": 400_000, "reasoning": false})
        );
    }
}
