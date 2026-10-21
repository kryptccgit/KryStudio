//! The Rust catalog must keep every id / param / range / default / unit /
//! scale / options / group of the seed spec (tests/seed-catalog.json, a copy
//! of the original shared/plugins/catalog.gen.json), except the deliberate
//! changes listed in `DELIBERATE`. Plugins shipped later are frozen the
//! same way by their own snapshot (tests/wave2-catalog.json).

use krypt_studio_dsp::{create_effect, create_instrument, descriptors, PluginKind};
use serde_json::Value;

/// (plugin id, param id, field) that intentionally differ from the seed.
const DELIBERATE: &[(&str, &str, &str)] = &[
    // DrumSynth gained two voices (the factory kit's crash and perc models).
    ("krypt.drumsynth", "voice", "max"),
    ("krypt.drumsynth", "voice", "options"),
];

/// Params added on top of the seed (must come after the seed params).
const ADDED: &[(&str, &str)] = &[
    ("krypt.kick808", "gate"),
    // wave 3A: audio-clip time-stretch / pitch-shift
    ("krypt.audioclip", "pitch"),
    ("krypt.audioclip", "formant"),
    ("krypt.audioclip", "tempo_sync"),
    ("krypt.audioclip", "src_bpm"),
    ("krypt.audioclip", "stretch"),
    // wave 12.2: sampler region end (slices)
    ("krypt.sampler", "end"),
    // wave 12.2b: TriOsc LFOs
    ("krypt.triosc", "lfo1Shape"), ("krypt.triosc", "lfo1Dest"), ("krypt.triosc", "lfo1Amount"), ("krypt.triosc", "lfo1Sync"),
    ("krypt.triosc", "lfo1Rate"), ("krypt.triosc", "lfo1Division"), ("krypt.triosc", "lfo1Retrig"), ("krypt.triosc", "lfo1Fade"),
    ("krypt.triosc", "lfo2Shape"), ("krypt.triosc", "lfo2Dest"), ("krypt.triosc", "lfo2Amount"), ("krypt.triosc", "lfo2Sync"),
    ("krypt.triosc", "lfo2Rate"), ("krypt.triosc", "lfo2Division"), ("krypt.triosc", "lfo2Retrig"), ("krypt.triosc", "lfo2Fade"),
];

/// Plugins added after the seed (wave 2), appended after the seed plugins.
const ADDED_PLUGINS: &[&str] = &[
    "krypt.fm",
    "krypt.wavetable",
    "krypt.chorus",
    "krypt.flanger",
    "krypt.phaser",
    "krypt.gate",
    "krypt.vocoder",
    "krypt.transient",
    "krypt.squash",
    "krypt.imager",
    "krypt.pitch",
];

/// Plugins added in wave 5 (real instruments), appended after the wave-2 plugins.
const WAVE5_PLUGINS: &[&str] = &["krypt.multisampler"];

/// Wave 12.2 devices, appended after the wave-5 plugins.
const WAVE12_PLUGINS: &[&str] = &["krypt.heat", "krypt.tapeecho", "krypt.grain", "krypt.glue"];

/// Auto Mix (research/20): the vocal de-esser, appended after the wave-12.2 devices.
const AUTOMIX_PLUGINS: &[&str] = &["krypt.deesser"];

/// research/13 §8.5: the loop slicer, appended after the de-esser.
const SLICER_PLUGINS: &[&str] = &["krypt.slicer"];

fn seed() -> Value {
    serde_json::from_str(include_str!("seed-catalog.json")).expect("seed json")
}

/// JSON equality where numbers compare by value (1 == 1.0).
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a.and_then(Value::as_f64), b.and_then(Value::as_f64)) {
        (Some(x), Some(y)) => (x - y).abs() < 1e-6,
        _ => a == b,
    }
}

fn deliberate(pid: &str, param: &str, field: &str) -> bool {
    DELIBERATE.iter().any(|&(p, q, f)| p == pid && q == param && f == field)
}

#[test]
fn every_seed_plugin_and_param_exists_unchanged() {
    let seed = seed();
    let ours = serde_json::to_value(descriptors()).unwrap();
    let ours = ours.as_array().unwrap();
    let seed_plugins = seed["plugins"].as_array().unwrap();
    assert_eq!(ours.len(), seed_plugins.len() + ADDED_PLUGINS.len() + WAVE5_PLUGINS.len() + WAVE12_PLUGINS.len() + AUTOMIX_PLUGINS.len() + SLICER_PLUGINS.len(), "plugin count");
    for (i, sp) in seed_plugins.iter().enumerate() {
        assert_eq!(ours[i]["id"], sp["id"], "seed plugins keep their order");
    }
    for op in &ours[seed_plugins.len()..] {
        let id = op["id"].as_str().unwrap();
        assert!(ADDED_PLUGINS.contains(&id) || WAVE5_PLUGINS.contains(&id) || WAVE12_PLUGINS.contains(&id) || AUTOMIX_PLUGINS.contains(&id) || SLICER_PLUGINS.contains(&id), "undeclared new plugin {id}");
    }
    for sp in seed_plugins {
        let id = sp["id"].as_str().unwrap();
        let op = ours.iter().find(|p| p["id"] == sp["id"]).unwrap_or_else(|| panic!("missing plugin {id}"));
        for f in ["name", "kind", "category", "usesSample", "sidechain", "defaultMix"] {
            assert!(same(op.get(f), sp.get(f)), "{id}.{f}: {:?} vs seed {:?}", op.get(f), sp.get(f));
        }
        let sparams = sp["params"].as_array().unwrap();
        let oparams = op["params"].as_array().unwrap();
        for (i, spar) in sparams.iter().enumerate() {
            let pid = spar["id"].as_str().unwrap();
            let opar = &oparams[i];
            assert_eq!(opar["id"], spar["id"], "{id}: param #{i} order/id");
            for f in ["name", "min", "max", "default", "unit", "scale", "step", "options", "group", "automatable"] {
                if deliberate(id, pid, f) {
                    continue;
                }
                let (a, b) = (opar.get(f), spar.get(f));
                assert!(same(a, b), "{id}.{pid}.{f}: {a:?} vs seed {b:?}");
            }
        }
        for extra in &oparams[sparams.len()..] {
            let pid = extra["id"].as_str().unwrap();
            assert!(ADDED.contains(&(id, pid)), "{id}: undeclared extra param {pid}");
        }
    }
    // the deliberate drumsynth change only appends options
    let ds = ours.iter().find(|p| p["id"] == "krypt.drumsynth").unwrap();
    let opts = ds["params"][0]["options"].as_array().unwrap();
    let seed_ds = seed_plugins.iter().find(|p| p["id"] == "krypt.drumsynth").unwrap();
    let seed_opts = seed_ds["params"][0]["options"].as_array().unwrap();
    assert_eq!(&opts[..seed_opts.len()], &seed_opts[..]);
}

/// (plugin id, param id, field) of wave-2 plugins that intentionally differ from the snapshot.
const WAVE2_DELIBERATE: &[(&str, &str, &str)] = &[
    // Wave 12.2: the vocoder goes up to 40 bands (stored values keep their meaning).
    ("krypt.vocoder", "bands", "max"),
];

/// Wave-2 plugins: ids, param order and specs are frozen by the snapshot
/// (params may only be appended; options may only be appended).
#[test]
fn wave2_plugins_keep_their_ids_and_params() {
    let snap: Value = serde_json::from_str(include_str!("wave2-catalog.json")).expect("wave2 json");
    let ours = serde_json::to_value(descriptors()).unwrap();
    let ours = ours.as_array().unwrap();
    let snap_plugins = snap["plugins"].as_array().unwrap();
    assert_eq!(snap_plugins.len(), ADDED_PLUGINS.len());
    for sp in snap_plugins {
        let id = sp["id"].as_str().unwrap();
        assert!(ADDED_PLUGINS.contains(&id));
        let op = ours.iter().find(|p| p["id"] == sp["id"]).unwrap_or_else(|| panic!("missing plugin {id}"));
        for f in ["name", "kind", "category", "usesSample", "sidechain", "defaultMix"] {
            assert!(same(op.get(f), sp.get(f)), "{id}.{f}: {:?} vs snapshot {:?}", op.get(f), sp.get(f));
        }
        let (sparams, oparams) = (sp["params"].as_array().unwrap(), op["params"].as_array().unwrap());
        assert!(oparams.len() >= sparams.len(), "{id}: params removed");
        for (i, spar) in sparams.iter().enumerate() {
            let pid = spar["id"].as_str().unwrap();
            let opar = &oparams[i];
            assert_eq!(opar["id"], spar["id"], "{id}: param #{i} order/id");
            for f in ["name", "min", "default", "unit", "scale", "step", "group", "automatable"] {
                assert!(same(opar.get(f), spar.get(f)), "{id}.{pid}.{f}: {:?} vs snapshot {:?}", opar.get(f), spar.get(f));
            }
            match (opar["options"].as_array(), spar["options"].as_array()) {
                (Some(o), Some(s)) => assert_eq!(&o[..s.len()], &s[..], "{id}.{pid}: options may only be appended"),
                (o, s) => {
                    assert_eq!(o.is_some(), s.is_some(), "{id}.{pid}: options");
                    if !WAVE2_DELIBERATE.contains(&(id, pid, "max")) {
                        assert!(same(opar.get("max"), spar.get("max")), "{id}.{pid}.max");
                    }
                }
            }
        }
    }
}

#[test]
fn descriptors_are_well_formed() {
    let ds = descriptors();
    let mut ids: Vec<_> = ds.iter().map(|d| d.id).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), ds.len(), "duplicate plugin ids");
    for d in &ds {
        assert!(!d.description.is_empty() && d.description.len() < 600, "{} description", d.id);
        let mut pids: Vec<_> = d.params.iter().map(|p| p.id).collect();
        pids.sort();
        pids.dedup();
        assert_eq!(pids.len(), d.params.len(), "{} duplicate param ids", d.id);
        for p in &d.params {
            let tag = format!("{}.{}", d.id, p.id);
            assert!(p.min < p.max, "{tag} range");
            assert!(p.default >= p.min && p.default <= p.max, "{tag} default");
            if p.scale == "log" {
                assert!(p.min > 0.0, "{tag} log min");
            }
            if p.scale == "gain" {
                assert_eq!(p.min, 0.0, "{tag} gain min");
            }
            if let Some(o) = &p.options {
                assert_eq!(p.min, 0.0, "{tag}");
                assert_eq!(p.max as usize, o.len() - 1, "{tag} options/max");
                assert_eq!(p.step, Some(1.0), "{tag} step");
            }
            if let Some(s) = p.step {
                let k = (p.default - p.min) / s;
                assert!((k - k.round()).abs() < 1e-4, "{tag} default not on step");
            }
        }
        match d.kind {
            PluginKind::Instrument => assert!(create_instrument(d.id, 48000.0, 512).is_some(), "{}", d.id),
            PluginKind::Effect => {
                assert!(create_effect(d.id, 48000.0, 512).is_some(), "{}", d.id);
                assert!(d.default_mix.is_some(), "{} defaultMix", d.id);
            }
        }
    }
    assert!(create_instrument("vst3.unknown", 48000.0, 512).is_none());
    assert!(create_effect("krypt.sampler", 48000.0, 512).is_none());
    assert!(create_instrument("krypt.eq", 48000.0, 512).is_none());
}

#[test]
fn catalog_serializes_like_the_ts_types() {
    let v = serde_json::to_value(serde_json::json!({ "version": 1, "plugins": descriptors() })).unwrap();
    let p = &v["plugins"][0];
    assert!(p.get("usesSample").is_some());
    assert!(p["params"][0].get("min").is_some());
    // optional fields are omitted, not null
    let s = serde_json::to_string(&v).unwrap();
    assert!(!s.contains(":null"), "nulls in catalog json");
    // f32 values print in shortest form even through serde_json::Value
    assert!(!s.contains("0000000"), "f32 widening artifacts in catalog json");
    assert!(s.contains("\"default\":0.8") && s.contains("\"min\":0.1"));
}
