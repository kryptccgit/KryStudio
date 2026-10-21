use crate::clap_host;
use clack_host::prelude::*;
use serde_json::{json, Value};

pub fn emit(v: &Value) {
    use std::io::Write;
    let mut so = std::io::stdout().lock();
    let _ = writeln!(so, "{v}");
    let _ = so.flush();
}

pub fn run(path: &str) -> i32 {
    let abs = std::path::absolute(path).map(|p| p.display().to_string()).unwrap_or_else(|_| path.to_string());
    let path = abs.as_str();
    let lower = path.to_ascii_lowercase();
    let r = if lower.ends_with(".clap") {
        scan_clap(path).map(|p| json!({ "ok": true, "format": "clap", "path": path, "plugins": p }))
    } else if lower.ends_with(".vst3") {
        crate::vst3_host::scan(path, &mut |partial| emit(&partial)).map(|p| json!({ "ok": true, "format": "vst3", "path": path, "plugins": p }))
    } else {
        Err("Not a .clap or .vst3 plugin".into())
    };
    match r {
        Ok(v) => {
            emit(&v);
            0
        }
        Err(e) => {
            let fmt = if lower.ends_with(".clap") { "clap" } else { "vst3" };
            emit(&json!({ "ok": false, "format": fmt, "path": path, "message": e }));
            0
        }
    }
}

pub fn category_from(features: &[String], instrument: bool) -> String {
    const MAP: &[(&str, &str)] = &[
        ("synthesizer", "Synth"),
        ("synth", "Synth"),
        ("sampler", "Sampler"),
        ("drum-machine", "Drums"),
        ("drum", "Drums"),
        ("piano", "Piano"),
        ("reverb", "Reverb"),
        ("delay", "Delay"),
        ("distortion", "Distortion"),
        ("compressor", "Dynamics"),
        ("limiter", "Dynamics"),
        ("dynamics", "Dynamics"),
        ("gate", "Dynamics"),
        ("equalizer", "EQ"),
        ("eq", "EQ"),
        ("filter", "Filter"),
        ("chorus", "Modulation"),
        ("flanger", "Modulation"),
        ("phaser", "Modulation"),
        ("modulation", "Modulation"),
        ("pitch-shifter", "Pitch"),
        ("pitch shift", "Pitch"),
        ("analyzer", "Analyzer"),
        ("analyser", "Analyzer"),
        ("spatial", "Spatial"),
        ("restoration", "Restoration"),
        ("mastering", "Mastering"),
        ("utility", "Utility"),
        ("tools", "Utility"),
    ];
    for f in features {
        let f = f.to_ascii_lowercase();
        if let Some((_, c)) = MAP.iter().find(|(k, _)| f == *k || f.contains(k)) {
            return c.to_string();
        }
    }
    if instrument { "Instrument".into() } else { "Effect".into() }
}

fn scan_clap(path: &str) -> Result<Vec<Value>, String> {
    let entry = unsafe { PluginEntry::load(path) }.map_err(|e| format!("couldn't load: {e}"))?;
    let factory = entry.get_plugin_factory().ok_or("no CLAP plugin factory")?;
    struct D {
        id: String,
        name: String,
        vendor: String,
        version: String,
        description: String,
        features: Vec<String>,
    }
    let s = |c: Option<&std::ffi::CStr>| c.map(|x| x.to_string_lossy().trim().to_string()).unwrap_or_default();
    let descs: Vec<D> = factory
        .plugin_descriptors()
        .map(|d| D {
            id: s(d.id()),
            name: s(d.name()),
            vendor: s(d.vendor()),
            version: s(d.version()),
            description: s(d.description()),
            features: d.features().map(|f| f.to_string_lossy().to_string()).collect(),
        })
        .filter(|d| !d.id.is_empty())
        .collect();
    let mut out = Vec::new();
    for d in descs {
        let has = |f: &str| d.features.iter().any(|x| x == f);
        if has("note-effect") && !has("audio-effect") && !has("instrument") {
            eprintln!("[scan] skipping {} (note effects are not supported yet)", d.id);
            continue;
        }
        let mut kind = if has("instrument") { Some("instrument") } else if has("audio-effect") || has("analyzer") { Some("effect") } else { None };
        let mut params = Vec::new();
        let mut has_editor = false;
        let mut message = Value::Null;
        match clap_host::new_instance(&entry, &d.id) {
            Ok(mut inst) => {
                let mut h = inst.plugin_handle();
                let ports = clap_host::discover_ports(&mut h, kind != Some("instrument"));
                if kind.is_none() {
                    kind = Some(if ports.inputs.is_empty() && ports.note_inputs > 0 { "instrument" } else { "effect" });
                }
                params = clap_host::describe_params(&mut h);
                has_editor = clap_host::gui_support(&mut h).is_some();
            }
            Err(e) => message = json!(e),
        }
        let kind = kind.unwrap_or("effect");
        let name = if d.name.is_empty() { d.id.clone() } else { d.name.clone() };
        out.push(json!({
            "id": format!("clap:{}", d.id),
            "name": name,
            "vendor": d.vendor,
            "version": d.version,
            "kind": kind,
            "category": category_from(&d.features, kind == "instrument"),
            "description": if d.description.is_empty() { format!("{} · CLAP", if d.vendor.is_empty() { "Third-party" } else { &d.vendor }) } else { d.description.clone() },
            "features": d.features,
            "format": "clap",
            "path": path,
            "params": params,
            "hasEditor": has_editor,
            "message": message,
        }));
    }
    Ok(out)
}
