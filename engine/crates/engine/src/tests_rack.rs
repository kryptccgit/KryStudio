use super::*;
use crate::rack::{DRUM_RACK_PLUGIN, FX_RACK_PLUGIN, RACK_PLUGIN};

fn chain(id: &str, inst: Option<&str>, zone: Option<(u8, u8, f64, f64)>) -> Value {
    let mut c = json!({ "id": id, "name": id, "color": null, "volume": 1, "pan": 0, "mute": false, "solo": false,
        "devices": {}, "deviceOrder": [] });
    if let Some(t) = inst {
        c["instrument"] = json!({ "type": t, "params": {}, "sampleId": null });
    }
    if let Some((a, b, lo, hi)) = zone {
        c["zone"] = json!({ "keyLo": a, "keyHi": b, "velLo": lo, "velHi": hi });
    }
    c
}

fn device(c: &mut Value, id: &str, kind: &str) {
    c["devices"][id] = json!({ "id": id, "type": kind, "enabled": true, "mix": 1, "params": {}, "sidechainFrom": null });
    c["deviceOrder"].as_array_mut().unwrap().push(json!(id));
}

fn rack(kind: &str, chains: Vec<Value>) -> Value {
    let order: Vec<Value> = chains.iter().map(|c| c["id"].clone()).collect();
    let map: serde_json::Map<String, Value> = chains.into_iter().map(|c| (c["id"].as_str().unwrap().to_string(), c)).collect();
    let macros: Vec<Value> = (0..8).map(|i| json!({ "name": format!("Macro {}", i + 1), "maps": {} })).collect();
    json!({ "kind": kind, "chains": map, "chainOrder": order, "macros": macros, "variations": {}, "variationOrder": [] })
}

fn map_macro(r: &mut Value, m: usize, id: &str, target: Value, min: f64, max: f64) {
    r["macros"][m]["maps"][id] = json!({ "id": id, "target": target, "min": min, "max": max });
}

fn add_rack_channel(p: &mut Value, id: &str, kind: &str, ins: &str, r: Value) {
    add_channel(p, id, kind, ins);
    p["channels"][id]["generator"]["rack"] = r;
}

fn add_rack_slot(p: &mut Value, ins: &str, sid: &str, r: Value) {
    add_slot(p, ins, sid, FX_RACK_PLUGIN, None);
    p["mixer"]["inserts"][ins]["slots"][sid]["rack"] = r;
}

fn note_vel(p: &mut Value, ch: &str, nid: &str, vel: f64) {
    p["patterns"]["pa"]["notes"][ch][nid]["vel"] = json!(vel);
}

fn session(p: &Value, host: PluginHost) -> Session {
    let mut s = Session::new(host, 48000.0, Arc::new(SampleCache::new()), ".".into(), SampleMode::Sync);
    let mut w = Warnings::default();
    s.model = Model::from_project(p, &mut w);
    s.version = 1;
    s
}

fn render_with(p: &Value, host: PluginHost, factory_dir: std::path::PathBuf, scope: RenderScope) -> Rendered {
    log_take();
    let mut w = Warnings::default();
    let model = Model::from_project(p, &mut w);
    let mut warnings = w.drain_messages();
    let req = RenderRequest {
        path: String::new(),
        scope,
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
    let mut logs: Vec<String> = Vec::new();
    let res = {
        let mut log = |_l: &str, m: String| logs.push(m);
        let mut env = RenderEnv {
            host,
            cache: Arc::new(SampleCache::new()),
            factory_dir,
            packs_dir: None,
            base_dir: None,
            cancel: Arc::new(AtomicBool::new(false)),
            default_sr: 48000.0,
            progress: &mut progress,
            log: &mut log,
        };
        render_audio(&model, &req, &mut env).expect("render")
    };
    warnings.extend(logs);
    Rendered { l: res.left, r: res.right, warnings }
}

fn cutoffs_reset() {
    CUTOFFS.with(|c| {
        let mut c = c.borrow_mut();
        c.clear();
        c.reserve(10_000);
    });
}

fn last_cutoff() -> f32 {
    CUTOFFS.with(|c| *c.borrow().last().expect("cutoff was set"))
}

#[test]
fn rack_devices_are_in_the_stock_catalog() {
    let text = crate::plugins::catalog_text(&PluginHost::stock());
    let v: Value = serde_json::from_str(&text).unwrap();
    for (id, kind) in [(RACK_PLUGIN, "instrument"), (DRUM_RACK_PLUGIN, "instrument"), (FX_RACK_PLUGIN, "effect")] {
        let d = v["plugins"].as_array().unwrap().iter().find(|d| d["id"] == id).unwrap_or_else(|| panic!("{id} missing"));
        assert_eq!(d["kind"], kind);
        assert!(d["description"].as_str().unwrap().len() > 40);
        let ps = d["params"].as_array().unwrap();
        assert_eq!(ps.len(), 8);
        for (i, p) in ps.iter().enumerate() {
            assert_eq!(p["id"], format!("macro{}", i + 1));
            assert_eq!((p["min"].as_f64(), p["max"].as_f64(), p["default"].as_f64()), (Some(0.0), Some(1.0), Some(0.0)));
            assert_eq!(p["group"], "Macros");
            assert_eq!(p["automatable"], true);
        }
    }
    assert_eq!(v["plugins"][0]["id"], krypt_studio_dsp::descriptors()[0].id);
}

#[test]
fn notes_route_by_key_and_velocity_zone_inclusive() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut a = chain("a", Some("test.dc"), Some((0, 59, 0.0, 1.0)));
    a["pan"] = json!(-1.0);
    let mut b = chain("b", Some("test.dc"), Some((60, 127, 0.0, 0.5)));
    b["pan"] = json!(1.0);
    let mut c = chain("c", Some("test.dc"), Some((60, 127, 0.5, 1.0)));
    c["pan"] = json!(1.0);
    c["volume"] = json!(2.0);
    add_rack_channel(&mut p, "c1", RACK_PLUGIN, "i1", rack("instrument", vec![a, b, c]));
    add_note(&mut p, "pa", "c1", "n1", 0.0, 240.0, 48);
    add_note(&mut p, "pa", "c1", "n2", 960.0, 240.0, 72);
    add_note(&mut p, "pa", "c1", "n3", 1920.0, 240.0, 60);
    note_vel(&mut p, "c1", "n3", 0.5);
    add_note(&mut p, "pa", "c1", "n4", 2880.0, 240.0, 59);
    note_vel(&mut p, "c1", "n4", 1.0);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(o.warnings.is_empty(), "{:?}", o.warnings);
    let at = |f: usize| (o.l[f], o.r[f]);
    assert!(near(at(100).0, DC1, 1e-5) && at(100).1 == 0.0, "{:?}", at(100));
    assert!(at(24100).0 == 0.0 && near(at(24100).1, 2.0 * DC1, 1e-5), "{:?}", at(24100));
    assert!(at(48100).0 == 0.0 && near(at(48100).1, 3.0 * DC1, 1e-5), "{:?}", at(48100));
    assert!(near(at(72100).0, DC1, 1e-5) && at(72100).1 == 0.0, "{:?}", at(72100));
    let log = log_take();
    assert!(log.iter().filter(|r| r.kind == "on").all(|r| r.pitch == r.key as f32));
    assert_eq!(log.iter().filter(|r| r.kind == "on").count(), 5);
}

#[test]
fn drum_rack_pads_choke_their_group() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut open = chain("open", Some("test.dc"), Some((46, 46, 0.0, 1.0)));
    open["pan"] = json!(-1.0);
    open["choke"] = json!(1);
    let mut closed = chain("closed", Some("test.dc"), Some((42, 42, 0.0, 1.0)));
    closed["pan"] = json!(1.0);
    closed["choke"] = json!(1);
    let mut ride = chain("ride", Some("test.dc"), Some((51, 51, 0.0, 1.0)));
    ride["choke"] = json!(2);
    ride["volume"] = json!(0.0);
    add_rack_channel(&mut p, "c1", DRUM_RACK_PLUGIN, "i1", rack("drum", vec![open, closed, ride]));
    add_note(&mut p, "pa", "c1", "a", 0.0, 3000.0, 46);
    add_note(&mut p, "pa", "c1", "r", 0.0, 3000.0, 51);
    add_note(&mut p, "pa", "c1", "b", 960.0, 240.0, 42);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(o.l[23999] > 0.15, "open hat rings until choked: {}", o.l[23999]);
    assert_eq!(o.l[24000], 0.0, "choked at the closed hat's onset");
    assert!(near(o.r[24000], DC1, 1e-5));
    let log = log_take();
    let chokes: Vec<u64> = log.iter().filter(|r| r.kind == "choke").map(|r| r.frame).collect();
    assert_eq!(chokes, vec![0, 24000]);
    assert!(log.iter().filter(|r| r.kind == "on").all(|r| r.pitch == 60.0), "{:?}", log);
}

#[test]
fn chain_mute_and_solo_within_the_rack() {
    let build = |mute_a: bool, solo_a: bool, solo_b: bool| {
        let mut p = base(120.0, "pattern");
        add_insert(&mut p, "i1", json!({ "m": 1 }));
        let mut a = chain("a", Some("test.dc"), None);
        a["pan"] = json!(-1.0);
        a["mute"] = json!(mute_a);
        a["solo"] = json!(solo_a);
        let mut b = chain("b", Some("test.dc"), None);
        b["pan"] = json!(1.0);
        b["solo"] = json!(solo_b);
        let c = chain("c", Some("test.dc"), None);
        add_rack_channel(&mut p, "c1", RACK_PLUGIN, "i1", rack("instrument", vec![a, b, c]));
        add_note(&mut p, "pa", "c1", "n", 0.0, 960.0, 60);
        let o = render_p(&p, PATTERN, 0.0);
        (o.l[1000], o.r[1000])
    };
    let (l, r) = build(false, false, false);
    assert!(near(l, 2.0 * DC1, 1e-5) && near(r, 2.0 * DC1, 1e-5));
    let (l, r) = build(true, false, false);
    assert!(near(l, DC1, 1e-5) && near(r, 2.0 * DC1, 1e-5), "a muted: {l} {r}");
    let (l, r) = build(false, true, false);
    assert!(near(l, DC1, 1e-5) && r == 0.0, "a soloed: {l} {r}");
    let (l, r) = build(false, true, true);
    assert!(near(l, DC1, 1e-5) && near(r, DC1, 1e-5), "a + b soloed: {l} {r}");
    let (l, r) = build(true, true, false);
    assert!(l == 0.0 && r == 0.0, "the only soloed chain is muted: {l} {r}");
}

#[test]
fn fx_rack_sums_parallel_chains_latency_aligned() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut a = chain("a", None, None);
    device(&mut a, "lat", "test.latency");
    device(&mut a, "g", "test.gain");
    let mut b = chain("b", None, None);
    device(&mut b, "g", "test.gain");
    b["devices"]["g"]["params"]["gain"] = json!(-6.020_6);
    add_rack_slot(&mut p, "i1", "s1", rack("effect", vec![a, b]));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_insert(&mut p, "i2", json!({ "m": 1 }));
    add_channel(&mut p, "c2", "test.dc", "i2");
    add_note(&mut p, "pa", "c1", "n", 960.0, 480.0, 60);
    add_note(&mut p, "pa", "c2", "n", 960.0, 480.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(o.warnings.is_empty(), "{:?}", o.warnings);
    assert_eq!(o.l[24000 + LAT - 1], 0.0, "nothing before the aligned onset");
    assert!(near(o.l[24000 + LAT], 1.5 * DC1 + DC1, 1e-4), "1 + 0.5 summed, plus the PDC'd parallel insert: {}", o.l[24000 + LAT]);

    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_rack_slot(&mut p, "i1", "s1", rack("effect", vec![]));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "n", 0.0, 480.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(near(o.l[100], DC1, 1e-6));

    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut a = chain("a", None, None);
    device(&mut a, "g", "test.gain");
    let b = chain("b", None, None);
    add_rack_slot(&mut p, "i1", "s1", rack("effect", vec![a, b]));
    p["mixer"]["inserts"]["i1"]["slots"]["s1"]["mix"] = json!(0.5);
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "n", 0.0, 480.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(near(o.l[100], 0.5 * 2.0 * DC1 + 0.5 * DC1, 1e-5), "{}", o.l[100]);
}

#[test]
fn fx_rack_with_an_echo_inside_keeps_its_insert_awake() {
    let gap = |inner: &str| {
        let mut p = base(120.0, "pattern");
        add_insert(&mut p, "i1", json!({ "m": 1 }));
        let mut a = chain("a", None, None);
        device(&mut a, "d", inner);
        add_rack_slot(&mut p, "i1", "s1", rack("effect", vec![a]));
        add_channel(&mut p, "c1", "test.dc", "i1");
        add_note(&mut p, "pa", "c1", "a", 0.0, 480.0, 60);
        add_note(&mut p, "pa", "c1", "b", 7680.0, 480.0, 60);
        GAIN_CALLS.with(|c| c.set(0));
        let o = render_p(&p, PATTERN, 0.0);
        (o.l.len() / 32, GAIN_CALLS.with(|c| c.get()))
    };
    let (blocks, calls) = gap("krypt.reverb");
    assert!(calls < blocks * 3 / 4, "a rack of sleep-safe devices sleeps: {calls} of {blocks}");
    let (blocks, calls) = gap("krypt.delay");
    assert!(calls >= blocks, "an echo inside never sleeps: {calls} of {blocks}");
}

fn macro_rack() -> (Value, Value) {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let r = rack("instrument", vec![chain("a", Some("test.sine"), None)]);
    (p, r)
}

fn first_instrument(s: &mut Session) -> Box<dyn Instrument> {
    let mut b = s.build(true);
    b.instruments.pop().and_then(|(_, i)| i).expect("an instrument")
}

#[test]
fn macro_maps_in_normalized_space_through_the_param_scale() {
    let inst_cutoff = json!({ "chainId": "a", "kind": "instrument", "param": "cutoff" });
    let log = |n: f32| 20.0 * 1000f32.powf(n);
    let (mut p, mut r) = macro_rack();
    map_macro(&mut r, 0, "m1", inst_cutoff.clone(), 0.0, 1.0);
    add_rack_channel(&mut p, "c1", RACK_PLUGIN, "i1", r);
    p["channels"]["c1"]["generator"]["params"]["macro1"] = json!(0.5);
    cutoffs_reset();
    let mut s = session(&p, test_host());
    let mut inst = first_instrument(&mut s);
    assert!((last_cutoff() - log(0.5)).abs() < 0.01, "{}", last_cutoff());
    inst.set_param(0, 1.0);
    assert!((last_cutoff() - 20000.0).abs() < 0.5);
    inst.set_param(0, f32::NAN);
    assert!((last_cutoff() - 20000.0).abs() < 0.5);

    let (mut p, mut r) = macro_rack();
    map_macro(&mut r, 2, "m1", inst_cutoff.clone(), 0.8, 0.2);
    add_rack_channel(&mut p, "c1", RACK_PLUGIN, "i1", r);
    cutoffs_reset();
    let mut s = session(&p, test_host());
    let mut inst = first_instrument(&mut s);
    assert!((last_cutoff() - log(0.8)).abs() / log(0.8) < 1e-4, "macro 0 → min: {}", last_cutoff());
    inst.set_param(2, 1.0);
    assert!((last_cutoff() - log(0.2)).abs() / log(0.2) < 1e-4, "macro 1 → max: {}", last_cutoff());

    let (mut p, mut r) = macro_rack();
    map_macro(&mut r, 0, "m1", inst_cutoff.clone(), 0.0, 1.0);
    map_macro(&mut r, 4, "m5", inst_cutoff.clone(), 0.0, 0.5);
    add_rack_channel(&mut p, "c1", RACK_PLUGIN, "i1", r);
    cutoffs_reset();
    let mut s = session(&p, test_host());
    let mut inst = first_instrument(&mut s);
    assert!((last_cutoff() - 20.0).abs() < 1e-3);
    let n = CUTOFFS.with(|c| c.borrow().len());
    inst.set_param(0, 1.0);
    assert_eq!(CUTOFFS.with(|c| c.borrow().len()), n, "macro 1 lost the param to macro 5");
    inst.set_param(4, 1.0);
    assert!((last_cutoff() - log(0.5)).abs() < 0.01);
    assert!(s.logs.is_empty(), "{:?}", s.logs);

    let (mut p, mut r) = macro_rack();
    map_macro(&mut r, 0, "bad", json!({ "chainId": "a", "kind": "instrument", "param": "nope" }), 0.0, 1.0);
    add_rack_channel(&mut p, "c1", RACK_PLUGIN, "i1", r);
    let mut s = session(&p, test_host());
    let _ = first_instrument(&mut s);
    assert!(s.logs.iter().any(|(_, m)| m.contains("macro 1 maps to 'nope'")), "{:?}", s.logs);
}

#[test]
fn macros_drive_chain_volume_pan_and_device_params_and_mix() {
    let run = |m1: f64, m2: f64| {
        let mut p = base(120.0, "pattern");
        add_insert(&mut p, "i1", json!({ "m": 1 }));
        let mut a = chain("a", None, None);
        device(&mut a, "g", "test.gain");
        let mut r = rack("effect", vec![a]);
        map_macro(&mut r, 0, "m1", json!({ "chainId": "a", "kind": "device", "deviceId": "g", "param": "gain" }), 0.5, 0.625);
        map_macro(&mut r, 1, "m2", json!({ "chainId": "a", "kind": "device", "deviceId": "g", "param": "mix" }), 1.0, 0.0);
        add_rack_slot(&mut p, "i1", "s1", r);
        p["mixer"]["inserts"]["i1"]["slots"]["s1"]["params"] = json!({ "macro1": m1, "macro2": m2 });
        add_channel(&mut p, "c1", "test.dc", "i1");
        add_note(&mut p, "pa", "c1", "n", 0.0, 480.0, 60);
        render_p(&p, PATTERN, 0.0).l[100]
    };
    assert!(near(run(0.0, 0.0), DC1, 1e-6));
    let g6 = 10f32.powf(6.0 / 20.0);
    assert!(near(run(1.0, 0.0), DC1 * g6, 1e-5), "{}", run(1.0, 0.0));
    assert!(near(run(1.0, 1.0), DC1, 1e-6));
    assert!(near(run(1.0, 0.5), DC1 * (0.5 + 0.5 * g6), 1e-5));

    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut r = rack("instrument", vec![chain("a", Some("test.dc"), None)]);
    map_macro(&mut r, 0, "v", json!({ "chainId": "a", "kind": "chain", "param": "volume" }), 0.0, 1.0);
    map_macro(&mut r, 1, "p", json!({ "chainId": "a", "kind": "chain", "param": "pan" }), 0.5, 1.0);
    add_rack_channel(&mut p, "c1", RACK_PLUGIN, "i1", r);
    p["channels"]["c1"]["generator"]["params"] = json!({ "macro1": 0.5, "macro2": 0.5 });
    add_note(&mut p, "pa", "c1", "n", 0.0, 480.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    let vol = 2.0 * 0.125;
    assert!(near(o.l[100], DC1 * vol * 0.5, 1e-5) && near(o.r[100], DC1 * vol, 1e-5), "{} {}", o.l[100], o.r[100]);
}

#[test]
fn macro_automation_moves_mapped_targets() {
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut r = rack("instrument", vec![chain("a", Some("test.dc"), None)]);
    map_macro(&mut r, 0, "p", json!({ "chainId": "a", "kind": "chain", "param": "pan" }), 0.0, 1.0);
    add_rack_channel(&mut p, "c1", RACK_PLUGIN, "i1", r);
    add_note(&mut p, "pa", "c1", "n", 0.0, 3840.0, 60);
    add_clip(&mut p, "k1", "pattern", 0.0, 3840.0, json!({ "patternId": "pa" }));
    p["automations"]["a1"] = json!({ "id": "a1", "name": "M1", "color": "#fff", "target": "channel/c1/gen/macro1",
        "points": { "p1": { "id": "p1", "tick": 0, "value": 0.0, "tension": 0 }, "p2": { "id": "p2", "tick": 3840, "value": 1.0, "tension": 0 } } });
    add_clip(&mut p, "k2", "automation", 0.0, 3840.0, json!({ "automationId": "a1" }));
    let o = render_p(&p, RenderScope::Song, 0.0);
    assert!(o.warnings.is_empty(), "{:?}", o.warnings);
    assert!(near(o.l[200], DC1, 1e-4) && o.r[200] < 0.01, "start: hard left {} {}", o.l[200], o.r[200]);
    assert!(near(o.l[48_000], DC1, 0.01) && near(o.r[48_000], DC1, 0.01), "middle: centre {} {}", o.l[48_000], o.r[48_000]);
    assert!(o.l[95_900] < 0.01 && near(o.r[95_900], DC1, 1e-4), "end: hard right {} {}", o.l[95_900], o.r[95_900]);

    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut r = rack("effect", vec![chain("a", None, None)]);
    map_macro(&mut r, 0, "p", json!({ "chainId": "a", "kind": "chain", "param": "pan" }), 0.0, 1.0);
    add_rack_slot(&mut p, "i1", "s1", r);
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "n", 0.0, 3840.0, 60);
    add_clip(&mut p, "k1", "pattern", 0.0, 3840.0, json!({ "patternId": "pa" }));
    p["automations"]["a1"] = json!({ "id": "a1", "name": "M1", "color": "#fff", "target": "insert/i1/slot/s1/macro1",
        "points": { "p1": { "id": "p1", "tick": 0, "value": 0.0, "tension": 0 }, "p2": { "id": "p2", "tick": 3840, "value": 1.0, "tension": 0 } } });
    add_clip(&mut p, "k2", "automation", 0.0, 3840.0, json!({ "automationId": "a1" }));
    let o = render_p(&p, RenderScope::Song, 0.0);
    assert!(o.warnings.is_empty(), "{:?}", o.warnings);
    assert!(near(o.l[200], DC1, 1e-4) && o.r[200] < 0.01, "start {} {}", o.l[200], o.r[200]);
    assert!(o.l[95_900] < 0.01 && near(o.r[95_900], DC1, 1e-4), "end {} {}", o.l[95_900], o.r[95_900]);
}

#[test]
fn param_only_edits_keep_the_instance_and_its_voices() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut r = rack("instrument", vec![chain("a", Some("test.dc"), None), chain("b", Some("test.dc"), Some((0, 10, 0.0, 1.0)))]);
    device(&mut r["chains"]["a"], "g", "test.gain");
    map_macro(&mut r, 0, "m", json!({ "chainId": "a", "kind": "chain", "param": "volume" }), 0.0, 1.0);
    add_rack_channel(&mut p, "c1", RACK_PLUGIN, "i1", r);
    add_rack_slot(&mut p, "i1", "s1", rack("effect", vec![chain("x", None, None)]));
    p["channels"]["c1"]["generator"]["params"]["macro1"] = json!(0.793_700_5);
    let mut live = Live::new(&p);
    live.run(480);
    let slot = live.session.channel_slot("c1").unwrap();
    live.send(Cmd::NoteOn { slot, key: 60, vel: 0.8 });
    let a = live.run(4800);
    assert!(near(a[2 * 4799], DC1, 1e-4), "held note: {}", a[2 * 4799]);

    let edit = |live: &mut Live, f: &dyn Fn(&mut crate::model_ext::RackDef, &mut std::collections::BTreeMap<String, f64>)| {
        let ch = live.session.model.channels.get_mut("c1").unwrap();
        f(ch.generator.rack.as_mut().unwrap(), &mut ch.generator.params);
        live.session.version += 1;
        let b = live.session.build(false);
        assert!(b.instruments.is_empty() && b.effects.is_empty(), "a param-only edit re-created an instance");
        assert!(!b.inst_params.is_empty(), "the edit reached the instance as set_param");
        live.send(Cmd::Batch(b));
    };
    edit(&mut live, &|_, params| {
        params.insert("macro1".into(), 0.5);
    });
    let o = live.run(4800);
    assert!(near(o[2 * 4799], 0.25 * DC1, 1e-4), "voice continues at the new level: {}", o[2 * 4799]);
    edit(&mut live, &|r, _| {
        r.macros[0].maps.clear();
    });
    let o = live.run(4800);
    assert!(near(o[2 * 4799], DC1, 1e-4), "unmapped → own volume: {}", o[2 * 4799]);
    edit(&mut live, &|r, _| {
        let a = r.chains.get_mut("a").unwrap();
        a.volume = 0.5;
        a.devices.get_mut("g").unwrap().params.insert("gain".into(), -6.020_6);
        let b = r.chains.get_mut("b").unwrap();
        b.zone.as_mut().unwrap().key_hi = 127.0;
    });
    let o = live.run(4800);
    assert!(near(o[2 * 4799], 0.25 * DC1, 1e-4), "volume 0.5 × gain 0.5 on the same voice: {}", o[2 * 4799]);
    live.send(Cmd::NoteOn { slot, key: 61, vel: 0.8 });
    let o = live.run(4800);
    assert!(near(o[2 * 4799], 0.25 * DC1 + 0.25 * DC1 + DC1, 1e-4), "a (2 notes × 0.25) + b: {}", o[2 * 4799]);
    edit(&mut live, &|r, _| {
        r.chains.get_mut("b").unwrap().mute = true;
    });
    let o = live.run(4800);
    assert!(near(o[2 * 4799], 0.5 * DC1, 1e-4), "b muted: {}", o[2 * 4799]);
    let ins = live.session.model.inserts.get_mut("i1").unwrap();
    ins.slots.get_mut("s1").unwrap().rack.as_mut().unwrap().chains.get_mut("x").unwrap().pan = 0.3;
    live.session.version += 1;
    let b = live.session.build(false);
    assert!(b.effects.is_empty() && !b.fx_params.is_empty());

    let structural: [&dyn Fn(&mut crate::model_ext::RackDef); 3] = [
        &|r| {
            let a = r.chains.get_mut("a").unwrap();
            a.devices.insert("g2".into(), crate::model::FxSlot { id: "g2".into(), type_id: "test.gain".into(), ..Default::default() });
            a.device_order.push("g2".into());
        },
        &|r| r.chains.get_mut("b").unwrap().instrument.as_mut().unwrap().type_id = "test.sine".into(),
        &|r| {
            r.chains.remove("b");
            r.chain_order.retain(|c| c != "b");
        },
    ];
    for f in structural {
        f(live.session.model.channels.get_mut("c1").unwrap().generator.rack.as_mut().unwrap());
        live.session.version += 1;
        let b = live.session.build(false);
        assert_eq!(b.instruments.len(), 1, "a structural edit re-creates the rack");
        assert!(b.instruments[0].1.is_some());
        live.send(Cmd::Batch(b));
        live.run(480);
    }
}

#[test]
fn nested_racks_third_party_and_inner_sidechains_are_skipped_with_warnings() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut a = chain("a", Some("test.dc"), None);
    device(&mut a, "nest", FX_RACK_PLUGIN);
    device(&mut a, "vst", "vst3:0123456789abcdef0123456789abcdef");
    device(&mut a, "sc", "test.sc");
    a["devices"]["sc"]["sidechainFrom"] = json!("i1");
    let b = chain("b", Some(DRUM_RACK_PLUGIN), None);
    let c = chain("c", Some("clap:com.vendor.synth"), None);
    add_rack_channel(&mut p, "c1", RACK_PLUGIN, "i1", rack("instrument", vec![a, b, c]));
    add_note(&mut p, "pa", "c1", "n", 0.0, 480.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    let has = |s: &str| o.warnings.iter().filter(|w| w.contains(s)).count();
    assert_eq!(has("racks inside racks"), 2, "{:?}", o.warnings);
    assert_eq!(has("third-party plugins can't go inside a rack"), 2, "{:?}", o.warnings);
    assert_eq!(has("sidechain inputs inside a rack"), 1, "{:?}", o.warnings);
    let mut p2 = p.clone();
    p2["channels"]["c1"]["generator"]["rack"]["chains"]["a"]["deviceOrder"] = json!(["nest", "vst"]);
    let o = render_p(&p2, PATTERN, 0.0);
    assert!(near(o.l[100], DC1, 1e-5), "the supported part of the rack plays: {}", o.l[100]);
}

fn factory_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../resources/factory"))
}

fn pad(id: &str, key: u8, sample: &str) -> Value {
    let mut c = chain(id, Some("krypt.sampler"), Some((key, key, 0.0, 1.0)));
    c["instrument"]["sampleId"] = json!(sample);
    c
}

#[test]
fn drum_rack_of_factory_samples_renders_like_channels() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    for (sid, path) in [("kick", "factory:drums/kick.wav"), ("snare", "factory:drums/snare.wav"), ("ch", "factory:drums/hat-closed.wav"), ("oh", "factory:drums/hat-open.wav")] {
        p["samples"][sid] = json!({ "id": sid, "name": sid, "path": path, "durationSec": 1, "sampleRate": 48000, "channels": 2 });
    }
    let mut ch = pad("ch", 42, "ch");
    ch["choke"] = json!(1);
    let mut oh = pad("oh", 46, "oh");
    oh["choke"] = json!(1);
    let mut r = rack("drum", vec![pad("k", 36, "kick"), pad("s", 38, "snare"), ch, oh]);
    device(&mut r["chains"]["s"], "rev", "krypt.reverb");
    add_rack_channel(&mut p, "dr", DRUM_RACK_PLUGIN, "i1", r);
    add_note(&mut p, "pa", "dr", "k", 0.0, 240.0, 36);
    add_note(&mut p, "pa", "dr", "s", 960.0, 240.0, 38);
    add_note(&mut p, "pa", "dr", "o", 1920.0, 480.0, 46);
    add_note(&mut p, "pa", "dr", "c", 2400.0, 240.0, 42);
    add_note(&mut p, "pa", "dr", "x", 2880.0, 240.0, 50);
    let o = render_with(&p, PluginHost::stock(), factory_dir(), PATTERN);
    assert!(o.warnings.iter().all(|w| !w.contains("missing") && !w.contains("not available")), "{:?}", o.warnings);
    assert!(o.l.iter().chain(&o.r).all(|v| v.is_finite()));
    let pk = |a: usize, b: usize| o.l[a..b].iter().chain(&o.r[a..b]).fold(0f32, |m, v| m.max(v.abs()));
    assert!(pk(0, 4000) > 0.05, "kick: {}", pk(0, 4000));
    assert!(pk(24_000, 28_000) > 0.02, "snare: {}", pk(24_000, 28_000));
    assert!(pk(48_000, 52_000) > 0.01, "open hat: {}", pk(48_000, 52_000));

    let mut q = base(120.0, "pattern");
    add_insert(&mut q, "i1", json!({ "m": 1 }));
    q["samples"]["kick"] = p["samples"]["kick"].clone();
    add_rack_channel(&mut q, "dr", DRUM_RACK_PLUGIN, "i1", rack("drum", vec![pad("k", 36, "kick")]));
    add_note(&mut q, "pa", "dr", "k", 0.0, 240.0, 36);
    let a = render_with(&q, PluginHost::stock(), factory_dir(), PATTERN);
    let mut q2 = base(120.0, "pattern");
    add_insert(&mut q2, "i1", json!({ "m": 1 }));
    q2["samples"]["kick"] = p["samples"]["kick"].clone();
    add_channel(&mut q2, "k", "krypt.sampler", "i1");
    q2["channels"]["k"]["generator"]["sampleId"] = json!("kick");
    add_note(&mut q2, "pa", "k", "k", 0.0, 240.0, 60);
    let b = render_with(&q2, PluginHost::stock(), factory_dir(), PATTERN);
    assert!(a.l.iter().any(|v| v.abs() > 0.05));
    let diff = a.l.iter().zip(&b.l).chain(a.r.iter().zip(&b.r)).fold(0f32, |m, (x, y)| m.max((x - y).abs()));
    assert!(diff < 1e-5, "pad vs channel differ by {diff}");
}

struct NanFx;
impl Effect for NanFx {
    fn prepare(&mut self, _sr: f32, _max: usize) {}
    fn set_param(&mut self, _index: usize, _value: f32) {}
    fn process(&mut self, _ctx: &ProcessContext, buf: [&mut [f32]; 2], _sc: Option<[&[f32]; 2]>) {
        let [l, r] = buf;
        l.fill(f32::NAN);
        r.fill(f32::INFINITY);
    }
    fn reset(&mut self) {}
}

struct NanInst;
impl Instrument for NanInst {
    fn prepare(&mut self, _sr: f32, _max: usize) {}
    fn set_param(&mut self, _index: usize, _value: f32) {}
    fn note_on(&mut self, _o: usize, _k: u8, _p: f32, _v: f32, _e: NoteExtras) {}
    fn note_off(&mut self, _o: usize, _k: u8) {}
    fn choke(&mut self, _o: usize) {}
    fn all_off(&mut self) {}
    fn process(&mut self, ctx: &ProcessContext, out: [&mut [f32]; 2]) {
        let [l, r] = out;
        for i in 0..ctx.frames {
            l[i] += f32::NAN;
            r[i] -= f32::INFINITY;
        }
    }
    fn is_active(&self) -> bool {
        true
    }
}

fn nan_descriptors() -> Vec<PluginDescriptor> {
    let mut v = test_descriptors();
    for (id, kind) in [("test.nanfx", PluginKind::Effect), ("test.naninst", PluginKind::Instrument)] {
        v.push(PluginDescriptor { id, name: id, kind, category: "test", description: "test", params: vec![], uses_sample: None, sidechain: None, default_mix: None });
    }
    v
}

fn nan_create_instrument(id: &str, sr: f32, max: usize) -> Option<Box<dyn Instrument>> {
    if id == "test.naninst" {
        return Some(Box::new(NanInst));
    }
    test_create_instrument(id, sr, max)
}

fn nan_create_effect(id: &str, sr: f32, max: usize) -> Option<Box<dyn Effect>> {
    if id == "test.nanfx" {
        return Some(Box::new(NanFx));
    }
    test_create_effect(id, sr, max)
}

#[test]
fn nan_from_inner_plugins_never_leaves_the_rack() {
    let host = PluginHost { create_instrument: nan_create_instrument, create_effect: nan_create_effect, descriptors: nan_descriptors };
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut bad = chain("bad", None, None);
    device(&mut bad, "n", "test.nanfx");
    add_rack_slot(&mut p, "i1", "s1", rack("effect", vec![bad, chain("ok", None, None)]));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_rack_channel(&mut p, "c2", RACK_PLUGIN, "i1", rack("instrument", vec![chain("n", Some("test.naninst"), None), chain("d", Some("test.dc"), None)]));
    add_note(&mut p, "pa", "c1", "n", 0.0, 480.0, 60);
    add_note(&mut p, "pa", "c2", "n", 0.0, 480.0, 60);
    let o = render_with(&p, host, ".".into(), PATTERN);
    assert!(o.l.iter().chain(&o.r).all(|v| v.is_finite()));
    assert!(near(o.l[100], 2.0 * DC1, 1e-5), "{}", o.l[100]);
}

#[cfg(debug_assertions)]
#[test]
fn rack_audio_path_does_not_allocate() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut a = chain("a", Some("test.sine"), Some((0, 64, 0.0, 1.0)));
    device(&mut a, "g", "test.gain");
    device(&mut a, "l", "test.latency");
    let b = chain("b", Some("test.sine"), Some((60, 127, 0.0, 1.0)));
    let mut r = rack("instrument", vec![a, b]);
    map_macro(&mut r, 0, "m", json!({ "chainId": "a", "kind": "device", "deviceId": "g", "param": "gain" }), 0.0, 1.0);
    add_rack_channel(&mut p, "c1", DRUM_RACK_PLUGIN, "i1", r);
    let mut fx = chain("x", None, None);
    device(&mut fx, "l", "test.latency");
    add_rack_slot(&mut p, "i1", "s1", rack("effect", vec![fx, chain("y", None, None)]));
    for (i, k) in [40u8, 62, 64, 90].iter().enumerate() {
        add_note(&mut p, "pa", "c1", &format!("n{i}"), i as f64 * 480.0, 240.0, *k);
    }
    let mut live = Live::new(&p);
    let before = assert_no_alloc::violation_count();
    let mut buf = vec![0f32; 480 * 2];
    live.send(Cmd::Play);
    for _ in 0..300 {
        crate::rt::no_alloc(|| live.core.process_interleaved(&mut buf, 2));
    }
    let ch = live.session.model.channels.get_mut("c1").unwrap();
    ch.generator.params.insert("macro1".into(), 0.7);
    ch.generator.rack.as_mut().unwrap().chains.get_mut("b").unwrap().pan = 0.4;
    live.session.model.inserts.get_mut("i1").unwrap().slots.get_mut("s1").unwrap().rack.as_mut().unwrap().chains.get_mut("y").unwrap().volume = 0.3;
    live.session.version = 2;
    let b = live.session.build(false);
    assert!(b.instruments.is_empty() && b.effects.is_empty());
    live.send(Cmd::Batch(b));
    for _ in 0..300 {
        crate::rt::no_alloc(|| live.core.process_interleaved(&mut buf, 2));
    }
    live.send(Cmd::Stop);
    crate::rt::no_alloc(|| live.core.process_interleaved(&mut buf, 2));
    assert_eq!(assert_no_alloc::violation_count(), before, "the rack audio path allocated");
    assert!(buf.iter().all(|v| v.is_finite()));
    while let Ok(g) = live.grx.pop() {
        drop(g);
    }
}

#[path = "tests_slicer.rs"]
mod slicer;
