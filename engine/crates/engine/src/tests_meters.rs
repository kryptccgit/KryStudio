//! Meters and scopes (meters.rs, docs/ENGINE_PROTOCOL.md §15) through the whole engine: the test sine
//! instrument into the REAL stock Krypt Comp / Krypt EQ / Krypt Analyzer.

use super::*;
use crate::meters::{collect_gr, Watcher};

fn mixed_descriptors() -> Vec<PluginDescriptor> {
    let mut v = test_descriptors();
    v.retain(|d| d.kind == PluginKind::Instrument);
    v.extend(krypt_studio_dsp::descriptors().into_iter().filter(|d| d.kind == PluginKind::Effect));
    v
}

/// Test instruments, stock effects.
fn mixed_host() -> PluginHost {
    PluginHost { create_instrument: test_create_instrument, create_effect: krypt_studio_dsp::create_effect, descriptors: mixed_descriptors }
}

/// A held loud sine on insert i1 → comp (threshold −40 dB) → eq → analyzer → master.
fn project() -> Value {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.sine", "i1");
    add_note(&mut p, "pa", "c1", "n1", 0.0, 3840.0, 69);
    add_slot(&mut p, "i1", "comp", "krypt.comp", None);
    p["mixer"]["inserts"]["i1"]["slots"]["comp"]["params"] = json!({ "threshold": -40.0, "ratio": 4.0, "autoMakeup": 0 });
    add_slot(&mut p, "i1", "eq", "krypt.eq", None);
    add_slot(&mut p, "i1", "an", "krypt.analyzer", None);
    p
}

#[test]
fn offline_render_reports_gain_reduction_per_dynamics_slot() {
    let p = project();
    let mut w = Warnings::default();
    let model = Model::from_project(&p, &mut w);
    let req = RenderRequest {
        path: String::new(),
        scope: RenderScope::Pattern { pattern_id: None },
        format: "wav32f".into(),
        sample_rate: Some(48000.0),
        tail_sec: Some(0.0),
        analyze: None,
        stems: None,
        stem_inserts: None,
        loops: None,
        normalize: None,
        mp3_kbps: None,
    };
    let mut progress = |_p: f64| {};
    let mut log = |_l: &str, _m: String| {};
    let mut env = RenderEnv {
        host: mixed_host(),
        cache: Arc::new(SampleCache::new()),
        factory_dir: ".".into(),
        packs_dir: None,
        base_dir: None,
        cancel: Arc::new(AtomicBool::new(false)),
        default_sr: 48000.0,
        progress: &mut progress,
        log: &mut log,
    };
    let r = render_audio(&model, &req, &mut env).expect("render");
    assert!(r.left.iter().any(|x| x.abs() > 0.01), "the sine plays");
    assert_eq!(r.gain_reduction.len(), 1, "{:?}", r.gain_reduction);
    let g = &r.gain_reduction[0];
    assert_eq!((g.insert_id.as_str(), g.slot_id.as_str()), ("i1", "comp"));
    assert!(g.max_db > 5.0 && g.avg_db > 3.0 && g.avg_db <= g.max_db, "{g:?}");
    assert!(g.active > 0.5, "{g:?}");
    // serialized as RenderResult.gainReduction
    let v = serde_json::to_value(&r.gain_reduction).unwrap();
    assert!(v[0]["avgDb"].is_number() && v[0]["insertId"] == "i1" && v[0]["slotId"] == "comp");
}

#[cfg(debug_assertions)]
#[test]
fn live_meters_and_watched_slot_are_allocation_free() {
    let p = project();
    let shared = Arc::new(Shared::new());
    let (mut tx, rx) = rtrb::RingBuffer::new(64);
    let (gtx, mut grx) = rtrb::RingBuffer::new(1024);
    let mut core = Core::new(48000.0, shared.clone(), Some(rx), Some(gtx), None);
    let mut session = Session::new(mixed_host(), 48000.0, Arc::new(SampleCache::new()), ".".into(), SampleMode::Sync);
    let mut w = Warnings::default();
    session.model = Model::from_project(&p, &mut w);
    session.version = 1;
    let b = session.build(true);
    let names = session.names.fx.clone();
    assert!(names.iter().any(|(_, k)| k == "i1/an") && names.iter().any(|(_, k)| k == "i1/comp"));
    assert!(tx.push(Cmd::Batch(b)).is_ok());
    assert!(tx.push(Cmd::Play).is_ok());

    let mut watcher = Watcher::default();
    assert!(watcher.on_message("client", r#"{"t":"watch","slots":["i1/an","i1/eq"]}"#));
    assert!(watcher.update(&shared.meters, &names, 48000, false, false).is_some());

    let mut buf = vec![0f32; 480 * 2];
    let before = assert_no_alloc::violation_count();
    let mut scopes = None;
    // ~0.8 s in 16 ms telemetry frames (the last one full)
    for frame in 0..51 {
        for _ in 0..2 {
            crate::rt::no_alloc(|| core.process_interleaved(&mut buf, 2));
        }
        scopes = watcher.update(&shared.meters, &names, 48000, false, frame % 2 == 0);
    }
    assert_eq!(assert_no_alloc::violation_count(), before, "meters / taps allocated on the audio path");
    while let Ok(g) = grx.pop() {
        drop(g);
    }
    let s = scopes.expect("watched slots stream");
    let an = &s["i1/an"];
    let lufs = an.lufs_m.expect("the analyzer hears the sine");
    assert!(lufs > -40.0 && lufs < 0.0, "{lufs}");
    assert_eq!(an.correlation, Some(1.0), "a centred sine is mono");
    let spec = an.spectrum.as_ref().expect("full frame");
    // 440 Hz → bin log(440/20)/log(1000) · 96 ≈ 42.9
    let peak = spec.iter().enumerate().fold((0, -999f32), |a, (i, &v)| if v > a.1 { (i, v) } else { a }).0;
    assert!((42..=43).contains(&peak), "spectrum peak bin {peak}");
    assert!(s.contains_key("i1/eq"));
    let gr = collect_gr(&shared.meters, &names).expect("the comp is reducing");
    assert!(gr["i1/comp"] > 5.0, "{gr:?}");
    assert!(!gr.contains_key("i1/eq") && !gr.contains_key("i1/an"));
}
