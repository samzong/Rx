use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::args;
use crate::catalog;
use crate::catalog::openai_base;
use crate::config::Paths;
use crate::file_io;
use crate::launch::EnvLookup;
use crate::opencode;
use crate::provider::{Provider, Setup};
use crate::residue::Residue;

const MARKER_VERSION: u32 = 2;

const PI_ENV_CLEAR: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "GEMINI_API_KEY",
];

fn global_agent_dir(env: &EnvLookup) -> Result<PathBuf> {
    if let Some(dir) = env
        .get("PI_CODING_AGENT_DIR")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let expanded = match dir.strip_prefix("~/") {
            Some(rest) => {
                let home = if env.is_real() {
                    dirs::home_dir()
                } else {
                    env.get("HOME").filter(|value| !value.trim().is_empty()).map(PathBuf::from)
                }
                .context("cannot expand PI_CODING_AGENT_DIR without a home directory")?;
                home.join(rest)
            }
            None => PathBuf::from(dir),
        };
        return Ok(expanded);
    }
    if !env.is_real() {
        bail!("PI_CODING_AGENT_DIR is required in an isolated environment");
    }
    let home = dirs::home_dir().context("cannot determine home directory")?;
    Ok(home.join(".pi").join("agent"))
}

pub(crate) fn prepare(
    provider_id: &str,
    provider: &Provider,
    base_url: &str,
    key: &str,
    paths: &Paths,
    env: &EnvLookup,
) -> Result<String> {
    let allow_fetch = env.is_real() || provider.setup == Setup::Generated;
    let document = generated_provider(provider, provider_id, base_url, key, paths, allow_fetch)?;
    if document.get("models").and_then(Value::as_array).is_none_or(|models| models.is_empty()) {
        if provider.setup == Setup::Generated {
            bail!("{} returned no models from {}", provider.name, openai_base(base_url));
        }
        return Ok(provider_id.to_string());
    }
    let agent_dir = global_agent_dir(env)?;
    merge_provider(&agent_dir.join("models.json"), provider_id, document)
}

pub(crate) fn env_set(env_key: &str, key: &str) -> Vec<(String, String)> {
    let mut env_set = vec![(env_key.to_string(), key.to_string())];
    for name in PI_ENV_CLEAR {
        if *name != env_key {
            env_set.push(((*name).to_string(), String::new()));
        }
    }
    env_set
}

pub(crate) fn args(
    provider_id: &str,
    model: Option<&str>,
    passthrough: &[OsString],
) -> Vec<OsString> {
    let mut args = Vec::new();
    if !args::has_flags(passthrough, &["--models"]) {
        args.push(OsString::from("--models"));
        args.push(OsString::from(format!("{provider_id}/**")));
    }
    if let Some(model) = model.filter(|_| !user_sets_model(passthrough)) {
        args.push(OsString::from("--model"));
        args.push(OsString::from(opencode::prefixed_model(provider_id, model)));
    } else if !args::has_flags(passthrough, &["--provider"]) {
        args.push(OsString::from("--provider"));
        args.push(OsString::from(provider_id));
    }
    args.extend(passthrough.iter().cloned());
    args
}

fn generated_provider(
    provider: &Provider,
    provider_id: &str,
    base_url: &str,
    key: &str,
    paths: &Paths,
    allow_fetch: bool,
) -> Result<Value> {
    let models = match catalog::load_pi_models(paths, provider_id, base_url, key, allow_fetch) {
        Ok(models) => models,
        Err(error) if provider.setup != Setup::Generated => {
            eprintln!("[rx] model catalog skipped: {error:#}");
            Vec::new()
        }
        Err(error) => return Err(error),
    };
    Ok(json!({
        "baseUrl": openai_base(base_url),
        "apiKey": format!("${}", provider.env),
        "api": "openai-responses",
        "authHeader": true,
        "models": models
    }))
}

pub(crate) fn merge_provider(
    models_path: &Path,
    provider_id: &str,
    provider: Value,
) -> Result<String> {
    let _lock = file_io::lock(&file_io::appended(models_path, ".rx.lock"))?;
    let (mut contents, mut document) = read_models(models_path)?;
    let providers = providers_mut(&mut document, models_path)?;
    let marker_path = marker_path(models_path);
    let mut marker = read_marker(&marker_path)?;
    let alias = format!("rx-{provider_id}");
    let native_id =
        if marker.providers.get(&alias).is_some_and(|owned| owned.provider_id == provider_id) {
            alias
        } else if writable(providers, &marker, provider_id, provider_id) {
            provider_id.to_string()
        } else {
            alias
        };
    if !writable(providers, &marker, &native_id, provider_id) {
        bail!(
            "Pi provider {native_id} in {} is unowned or modified; preserve it and choose a different Rx provider id",
            models_path.display()
        );
    }
    patch_provider(&mut contents, &native_id, Some(&provider))?;
    marker.providers.insert(
        native_id.clone(),
        OwnedProvider { provider_id: provider_id.to_string(), value: provider },
    );
    file_io::write(models_path, &contents)?;
    file_io::write(&marker_path, &serde_json::to_vec_pretty(&marker)?)?;
    Ok(native_id)
}

fn writable(
    providers: &serde_json::Map<String, Value>,
    marker: &OwnedProviders,
    native_id: &str,
    provider_id: &str,
) -> bool {
    match marker.providers.get(native_id) {
        Some(owned) => {
            owned.provider_id == provider_id
                && providers.get(native_id).is_none_or(|current| current == &owned.value)
        }
        None => !providers.contains_key(native_id),
    }
}

pub(crate) fn purge(provider_id: &str, env: &EnvLookup) -> Result<Residue> {
    let models_path = global_agent_dir(env)?.join("models.json");
    if !models_path.is_file() {
        return Ok(Residue::Absent);
    }
    let _lock = file_io::lock(&file_io::appended(&models_path, ".rx.lock"))?;
    let marker_path = marker_path(&models_path);
    let mut marker = read_marker(&marker_path)?;
    let (mut contents, mut document) = read_models(&models_path)?;
    let providers = providers_mut(&mut document, &models_path)?;
    let mut removed = Vec::new();
    let mut modified = false;
    let mut marked = false;
    marker.providers.retain(|native_id, owned| {
        if owned.provider_id != provider_id {
            return true;
        }
        marked = true;
        match providers.get(native_id) {
            Some(current) if current != &owned.value => {
                modified = true;
                true
            }
            _ => {
                if providers.remove(native_id).is_some() {
                    removed.push(native_id.clone());
                }
                false
            }
        }
    });
    if !marked {
        return Ok(if providers.contains_key(provider_id) {
            Residue::Unowned(models_path)
        } else {
            Residue::Absent
        });
    }
    for native_id in &removed {
        patch_provider(&mut contents, native_id, None)?;
    }
    if !removed.is_empty() {
        file_io::write(&models_path, &contents)?;
    }
    if marker.providers.is_empty() {
        file_io::remove(&marker_path)?;
    } else {
        file_io::write(&marker_path, &serde_json::to_vec_pretty(&marker)?)?;
    }
    Ok(if modified {
        Residue::Modified(models_path)
    } else if !removed.is_empty() {
        Residue::Removed
    } else {
        Residue::Absent
    })
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct OwnedProviders {
    version: u32,
    providers: BTreeMap<String, OwnedProvider>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnedProvider {
    provider_id: String,
    value: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawOwnedProviders {
    version: u32,
    providers: BTreeMap<String, Value>,
}

fn marker_path(models_path: &Path) -> PathBuf {
    file_io::appended(models_path, ".rx-catalog.json")
}

fn read_marker(path: &Path) -> Result<OwnedProviders> {
    let Some(contents) = file_io::read_optional(path)? else {
        return Ok(OwnedProviders { version: MARKER_VERSION, providers: BTreeMap::new() });
    };
    let raw: RawOwnedProviders = serde_json::from_slice(&contents)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    if raw.version != 1 && raw.version != MARKER_VERSION {
        bail!("unsupported Pi catalog marker version {}", raw.version);
    }
    let mut providers = BTreeMap::new();
    for (native_id, value) in raw.providers {
        let owned = if raw.version == 1 {
            OwnedProvider { provider_id: native_id.clone(), value }
        } else {
            serde_json::from_value::<OwnedProvider>(value)
                .with_context(|| format!("failed to parse {}", path.display()))?
        };
        if owned.provider_id.is_empty()
            || (native_id != owned.provider_id && native_id != format!("rx-{}", owned.provider_id))
            || !owned.value.is_object()
        {
            bail!("invalid Pi catalog ownership record in {}", path.display());
        }
        providers.insert(native_id, owned);
    }
    Ok(OwnedProviders { version: MARKER_VERSION, providers })
}

fn read_models(models_path: &Path) -> Result<(Vec<u8>, Value)> {
    let contents = file_io::read_optional(models_path)?.unwrap_or_else(|| b"{}".to_vec());
    let document = serde_json::from_slice(&contents).with_context(|| {
        format!("failed to parse {}; fix or remove the file and retry", models_path.display())
    })?;
    Ok((contents, document))
}

struct JsonEntry {
    key: String,
    key_start: usize,
    value_start: usize,
    end: usize,
}

struct JsonObject {
    open: usize,
    entries: Vec<JsonEntry>,
}

impl JsonObject {
    fn patch(&self, contents: &mut Vec<u8>, key: &str, value: Option<&Value>) -> Result<()> {
        if let Some(index) = self.entries.iter().position(|entry| entry.key == key) {
            let entry = &self.entries[index];
            if let Some(value) = value {
                contents.splice(entry.value_start..entry.end, serde_json::to_vec(value)?);
            } else {
                let range = if let Some(next) = self.entries.get(index + 1) {
                    entry.key_start..next.key_start
                } else if index > 0 {
                    self.entries[index - 1].end..entry.end
                } else {
                    entry.key_start..entry.end
                };
                contents.drain(range);
            }
        } else if let Some(value) = value {
            let mut addition = Vec::new();
            if !self.entries.is_empty() {
                addition.push(b',');
            }
            addition.extend(serde_json::to_vec(key)?);
            addition.push(b':');
            addition.extend(serde_json::to_vec(value)?);
            let at = self.entries.last().map_or(self.open + 1, |entry| entry.end);
            contents.splice(at..at, addition);
        }
        Ok(())
    }
}

fn patch_provider(contents: &mut Vec<u8>, provider_id: &str, value: Option<&Value>) -> Result<()> {
    let root = json_object(contents, 0)?;
    if let Some(providers) = root.entries.iter().find(|entry| entry.key == "providers") {
        json_object(contents, providers.value_start)?.patch(contents, provider_id, value)
    } else if let Some(value) = value {
        let providers = serde_json::Map::from_iter([(provider_id.to_string(), value.clone())]);
        root.patch(contents, "providers", Some(&Value::Object(providers)))
    } else {
        Ok(())
    }
}

fn json_object(contents: &[u8], start: usize) -> Result<JsonObject> {
    let open = skip_json_whitespace(contents, start);
    if contents.get(open) != Some(&b'{') {
        bail!("Pi catalog entry is not a JSON object");
    }
    let mut object = JsonObject { open, entries: Vec::new() };
    let mut at = open + 1;
    loop {
        at = skip_json_whitespace(contents, at);
        if contents.get(at) == Some(&b'}') {
            return Ok(object);
        }
        let key_start = at;
        let (key, end) = json_token::<String>(contents, at)?;
        if object.entries.iter().any(|entry| entry.key == key) {
            bail!("duplicate Pi catalog JSON key {key}");
        }
        at = skip_json_whitespace(contents, end);
        if contents.get(at) != Some(&b':') {
            bail!("missing Pi catalog JSON member separator");
        }
        let value_start = skip_json_whitespace(contents, at + 1);
        let (_, end) = json_token::<IgnoredAny>(contents, value_start)?;
        object.entries.push(JsonEntry { key, key_start, value_start, end });
        at = skip_json_whitespace(contents, end);
        match contents.get(at) {
            Some(b',') => at += 1,
            Some(b'}') => return Ok(object),
            _ => bail!("missing Pi catalog JSON object separator"),
        }
    }
}

fn json_token<'a, T: Deserialize<'a>>(contents: &'a [u8], at: usize) -> Result<(T, usize)> {
    let mut stream = serde_json::Deserializer::from_slice(&contents[at..]).into_iter::<T>();
    let value = stream.next().context("missing Pi catalog JSON value")??;
    Ok((value, at + stream.byte_offset()))
}

fn skip_json_whitespace(contents: &[u8], mut at: usize) -> usize {
    while matches!(contents.get(at), Some(b' ' | b'\t' | b'\r' | b'\n')) {
        at += 1;
    }
    at
}

fn providers_mut<'a>(
    document: &'a mut Value,
    models_path: &Path,
) -> Result<&'a mut serde_json::Map<String, Value>> {
    let Some(root) = document.as_object_mut() else {
        bail!(
            "{} root is not a JSON object; fix or remove the file and retry",
            models_path.display()
        );
    };
    root.entry("providers").or_insert_with(|| json!({})).as_object_mut().ok_or_else(|| {
        anyhow::anyhow!(
            "{} providers is not a JSON object; fix or remove the file and retry",
            models_path.display()
        )
    })
}

fn user_sets_model(passthrough: &[OsString]) -> bool {
    args::before_double_dash(passthrough)
        .iter()
        .any(|arg| arg == "-m" || arg == "--model" || args::os_prefix(arg, "--model="))
}
