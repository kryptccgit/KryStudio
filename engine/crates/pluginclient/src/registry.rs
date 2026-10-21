use krypt_studio_dsp::{ParamSpec, PluginDescriptor, PluginKind};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Vst3,
    Clap,
}

impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Format::Vst3 => "vst3",
            Format::Clap => "clap",
        }
    }
}

pub fn is_external_id(id: &str) -> bool {
    id.starts_with("vst3:") || id.starts_with("clap:")
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtParam {
    id: String,
    name: String,
    min: f64,
    max: f64,
    default: f64,
    #[serde(default)]
    unit: String,
    #[serde(default)]
    scale: String,
    #[serde(default)]
    step: Option<f64>,
    #[serde(default)]
    options: Option<Vec<String>>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    automatable: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtDesc {
    id: String,
    name: String,
    kind: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    params: Vec<ExtParam>,
    path: String,
    #[serde(default)]
    format: Option<String>,
}

#[derive(Clone)]
pub struct Entry {
    pub desc: Arc<PluginDescriptor>,
    pub format: Format,
    pub raw_id: String,
    pub path: String,
    pub param_ids: Arc<[u32]>,
}

fn registry() -> &'static RwLock<HashMap<String, Entry>> {
    static R: OnceLock<RwLock<HashMap<String, Entry>>> = OnceLock::new();
    R.get_or_init(|| RwLock::new(HashMap::new()))
}

fn intern(s: &str) -> &'static str {
    static POOL: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    let mut pool = POOL.get_or_init(|| Mutex::new(HashSet::new())).lock().unwrap_or_else(|e| e.into_inner());
    if let Some(&hit) = pool.get(s) {
        return hit;
    }
    let leaked: &'static str = Box::leak(s.to_string().into_boxed_str());
    pool.insert(leaked);
    leaked
}

fn convert(d: &ExtDesc) -> Result<Entry, String> {
    let (format, raw_id) = if let Some(r) = d.id.strip_prefix("vst3:") {
        (Format::Vst3, r.to_string())
    } else if let Some(r) = d.id.strip_prefix("clap:") {
        (Format::Clap, r.to_string())
    } else {
        return Err(format!("'{}' is not a vst3:/clap: plugin id", d.id));
    };
    if let Some(f) = &d.format {
        if f != format.as_str() {
            return Err(format!("'{}' says format '{f}'", d.id));
        }
    }
    let kind = match d.kind.as_str() {
        "instrument" => PluginKind::Instrument,
        "effect" => PluginKind::Effect,
        k => return Err(format!("'{}' has unknown kind '{k}'", d.id)),
    };
    let mut params = Vec::with_capacity(d.params.len());
    let mut ids = Vec::with_capacity(d.params.len());
    for (i, p) in d.params.iter().enumerate() {
        let (min, max) = if p.max >= p.min { (p.min as f32, p.max as f32) } else { (p.max as f32, p.min as f32) };
        params.push(ParamSpec {
            id: intern(&p.id),
            name: intern(&p.name),
            min,
            max,
            default: (p.default as f32).clamp(min, max),
            unit: intern(&p.unit),
            scale: intern(if p.scale == "log" && min > 0.0 { "log" } else { "linear" }),
            step: p.step.filter(|s| *s > 0.0).map(|s| s as f32),
            options: p.options.as_ref().map(|o| o.iter().map(|s| intern(s)).collect()),
            group: p.group.as_deref().map(intern),
            automatable: p.automatable,
        });
        ids.push(p.id.parse::<u32>().unwrap_or(i as u32));
    }
    let desc = PluginDescriptor {
        id: intern(&d.id),
        name: intern(&d.name),
        kind,
        category: intern(&d.category),
        description: intern(&d.description),
        params,
        uses_sample: None,
        sidechain: None,
        default_mix: None,
    };
    Ok(Entry { desc: Arc::new(desc), format, raw_id, path: d.path.clone(), param_ids: ids.into() })
}

pub fn register_json(list: &serde_json::Value) -> (usize, Vec<String>) {
    let Some(arr) = list.as_array() else {
        return (0, vec!["plugins must be an array".into()]);
    };
    let mut ok = 0;
    let mut errs = Vec::new();
    let mut reg = registry().write().unwrap_or_else(|e| e.into_inner());
    for v in arr {
        match serde_json::from_value::<ExtDesc>(v.clone()).map_err(|e| e.to_string()).and_then(|d| convert(&d)) {
            Ok(e) => {
                reg.insert(e.desc.id.to_string(), e);
                ok += 1;
            }
            Err(e) => errs.push(e),
        }
    }
    (ok, errs)
}

pub fn register_file(path: &std::path::Path) -> Result<usize, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
    let list = if v.is_array() { v } else { v.get("plugins").cloned().unwrap_or(serde_json::Value::Array(vec![])) };
    let (n, errs) = register_json(&list);
    for e in errs {
        eprintln!("[plugins] skipped a descriptor: {e}");
    }
    Ok(n)
}

pub fn entry(id: &str) -> Option<Entry> {
    registry().read().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
}

pub fn descriptor(id: &str) -> Option<Arc<PluginDescriptor>> {
    if !is_external_id(id) {
        return None;
    }
    entry(id).map(|e| e.desc)
}

pub fn count() -> usize {
    registry().read().unwrap_or_else(|e| e.into_inner()).len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registers_and_converts() {
        let (n, errs) = register_json(&json!([
            { "id": "clap:test.gain", "name": "Gain", "kind": "effect", "path": "C:/x.clap",
              "params": [ { "id": "1", "name": "Volume", "min": 0, "max": 1, "default": 1, "unit": "", "scale": "linear" } ] },
            { "id": "bogus", "name": "x", "kind": "effect", "path": "" }
        ]));
        assert_eq!(n, 1);
        assert_eq!(errs.len(), 1);
        let e = entry("clap:test.gain").unwrap();
        assert_eq!(e.format, Format::Clap);
        assert_eq!(e.raw_id, "test.gain");
        assert_eq!(&*e.param_ids, &[1]);
        assert_eq!(e.desc.params[0].id, "1");
        assert!(descriptor("krypt.eq").is_none());
    }
}
