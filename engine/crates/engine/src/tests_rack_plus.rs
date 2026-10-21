//! Wave 12.2b (rack-plus): automation of params INSIDE racks (ParamRef
//! `<host>/rack/<chain>/…` → TargetKind::RackInst / RackFx, an override in the
//! rack's target), the macro-vs-automation rule (automation wins; released when
//! the automation goes away), and instrument latency in PDC (an instrument rack
//! with a latent device stays sample-aligned with other channels).

use super::*;
use crate::rack::{AUTO_BASE, RACK_PLUGIN};

fn chain(id: &str, inst: Option<&str>) -> Value {
    let mut c = json!({ "id": id, "name": id, "color": null, "volume": 1, "pan": 0, "mute": false, "solo": false,
        "devices": {}, "deviceOrder": [] });
    if let Some(t) = inst {
        c["instrument"] = json!({ "type": t, "params": {}, "sampleId": null });
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

fn add_rack_channel(p: &mut Value, id: &str, ins: &str, r: Value) {
    add_channel(p, id, RACK_PLUGIN, ins);
    p["channels"][id]["generator"]["rack"] = r;
}

fn add_rack_slot(p: &mut Value, ins: &str, sid: &str, r: Value) {
    add_slot(p, ins, sid, crate::rack::FX_RACK_PLUGIN, None);
    p["mixer"]["inserts"][ins]["slots"][sid]["rack"] = r;
}

/// An automation clip over the first bar (song mode) with normalized points (tick, value).
fn automate(p: &mut Value, id: &str, target: &str, pts: &[(f64, f64)]) {
    let points: serde_json::Map<String, Value> =
        pts.iter().enumerate().map(|(i, (t, v))| (format!("p{i}"), json!({ "id": format!("p{i}"), "tick": t, "value": v, "tension": 0 }))).collect();
    p["automations"][id] = json!({ "id": id, "name": id, "color": "#fff", "target": target, "points": points });
    add_clip(p, &format!("k-{id}"), "automation", 0.0, 3840.0, json!({ "automationId": id }));
}

/// Song mode, one pattern clip over bar 1 holding key 60 on `ch` the whole bar.
fn song_with_held_note(p: &mut Value, ch: &str) {
    add_note(p, "pa", ch, "n", 0.0, 3840.0, 60);
    if p["playlist"]["clips"].get("kp").is_none() {
        add_clip(p, "kp", "pattern", 0.0, 3840.0, json!({ "patternId": "pa" }));
    }
}

// ── Automation of inner params ───────────────────────────────────────────

#[test]
fn automation_reaches_params_inside_instrument_and_effect_racks() {
    // Instrument rack: channel/c1/rack/a/pan sweeps −1 → 1.
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_rack_channel(&mut p, "c1", "i1", rack("instrument", vec![chain("a", Some("test.dc"))]));
    song_with_held_note(&mut p, "c1");
    automate(&mut p, "a1", "channel/c1/rack/a/pan", &[(0.0, 0.0), (3840.0, 1.0)]);
    let o = render_p(&p, RenderScope::Song, 0.0);
    assert!(o.warnings.is_empty(), "{:?}", o.warnings);
    assert!(near(o.l[200], DC1, 1e-4) && o.r[200] < 0.01, "start: hard left {} {}", o.l[200], o.r[200]);
    assert!(near(o.l[48_000], DC1, 0.01) && near(o.r[48_000], DC1, 0.01), "middle: centre {} {}", o.l[48_000], o.r[48_000]);
    assert!(o.l[95_900] < 0.01 && near(o.r[95_900], DC1, 1e-4), "end: hard right {} {}", o.l[95_900], o.r[95_900]);

    // The instrument's own param: channel/c1/rack/a/inst/cutoff (the test sine records its cutoffs).
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_rack_channel(&mut p, "c1", "i1", rack("instrument", vec![chain("a", Some("test.sine"))]));
    song_with_held_note(&mut p, "c1");
    automate(&mut p, "a1", "channel/c1/rack/a/inst/cutoff", &[(0.0, 0.5), (3840.0, 0.5)]);
    CUTOFFS.with(|c| {
        c.borrow_mut().clear();
        c.borrow_mut().reserve(1000);
    });
    let o = render_p(&p, RenderScope::Song, 0.0);
    assert!(o.warnings.is_empty(), "{:?}", o.warnings);
    let last = CUTOFFS.with(|c| *c.borrow().last().expect("the automation set the inner cutoff"));
    assert!((last - 20.0 * 1000f32.powf(0.5)).abs() < 0.01, "log-scale cutoff at normalized 0.5: {last}");

    // Effect rack: a device param (gain −24..24 dB: normalized 0.625 = +6 dB), the device mix
    // and the chain volume (0..2 gain: normalized 0.5 = 0.25).
    let fx = |target: &str, v: f64| {
        let mut p = base(120.0, "song");
        add_insert(&mut p, "i1", json!({ "m": 1 }));
        let mut a = chain("a", None);
        device(&mut a, "g", "test.gain");
        add_rack_slot(&mut p, "i1", "s1", rack("effect", vec![a]));
        add_channel(&mut p, "c1", "test.dc", "i1");
        song_with_held_note(&mut p, "c1");
        automate(&mut p, "a1", target, &[(0.0, v), (3840.0, v)]);
        let o = render_p(&p, RenderScope::Song, 0.0);
        assert!(o.warnings.is_empty(), "{target}: {:?}", o.warnings);
        o.l[48_000]
    };
    let g6 = 10f32.powf(6.0 / 20.0);
    assert!(near(fx("insert/i1/slot/s1/rack/a/dev/g/gain", 0.625), DC1 * g6, 1e-4));
    assert!(near(fx("insert/i1/slot/s1/rack/a/volume", 0.5), DC1 * 0.25, 1e-5));
    // Mix 0 skips the device: the +6 dB gain set in the doc can't reach the signal.
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut a = chain("a", None);
    device(&mut a, "g", "test.gain");
    a["devices"]["g"]["params"]["gain"] = json!(6.0);
    add_rack_slot(&mut p, "i1", "s1", rack("effect", vec![a]));
    add_channel(&mut p, "c1", "test.dc", "i1");
    song_with_held_note(&mut p, "c1");
    automate(&mut p, "a1", "insert/i1/slot/s1/rack/a/dev/g/mix", &[(0.0, 0.0), (3840.0, 0.0)]);
    let o = render_p(&p, RenderScope::Song, 0.0);
    assert!(near(o.l[48_000], DC1, 1e-5), "mix automated to 0: {}", o.l[48_000]);

    // A ref to something not in the rack warns and is ignored.
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_rack_channel(&mut p, "c1", "i1", rack("instrument", vec![chain("a", Some("test.dc"))]));
    song_with_held_note(&mut p, "c1");
    automate(&mut p, "a1", "channel/c1/rack/zz/volume", &[(0.0, 0.0)]);
    automate(&mut p, "a2", "channel/c1/rack/a/dev/nope/mix", &[(0.0, 0.0)]);
    let o = render_p(&p, RenderScope::Song, 0.0);
    assert!(o.warnings.iter().any(|w| w.contains("channel/c1/rack/zz/volume")), "{:?}", o.warnings);
    assert!(o.warnings.iter().any(|w| w.contains("channel/c1/rack/a/dev/nope/mix")), "{:?}", o.warnings);
    assert!(near(o.l[48_000], DC1, 1e-5), "the rack plays its document values");
}

// ── Macro + automation on one inner param ────────────────────────────────

#[test]
fn automation_wins_over_a_macro_on_the_same_inner_param_until_released() {
    // Directly on the rack: target 3 = chain a's instrument cutoff (volume, pan, gain, cutoff).
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut r = rack("instrument", vec![chain("a", Some("test.sine"))]);
    map_macro(&mut r, 0, "m1", json!({ "chainId": "a", "kind": "instrument", "param": "cutoff" }), 0.0, 1.0);
    add_rack_channel(&mut p, "c1", "i1", r);
    let mut s = Session::new(test_host(), 48000.0, Arc::new(SampleCache::new()), ".".into(), SampleMode::Sync);
    let mut w = Warnings::default();
    s.model = Model::from_project(&p, &mut w);
    s.version = 1;
    CUTOFFS.with(|c| {
        c.borrow_mut().clear();
        c.borrow_mut().reserve(1000);
    });
    let mut inst = s.build(true).instruments.pop().and_then(|(_, i)| i).expect("the rack");
    let last = || CUTOFFS.with(|c| *c.borrow().last().unwrap());
    let count = || CUTOFFS.with(|c| c.borrow().len());
    assert!((last() - 20.0).abs() < 1e-3, "macro 0 → cutoff min");
    inst.set_param(AUTO_BASE + 3, 1000.0);
    assert!((last() - 1000.0).abs() < 1e-3, "the automation override applies");
    let n = count();
    inst.set_param(0, 1.0);
    assert_eq!(count(), n, "the macro moves nothing while automation holds the param");
    inst.set_param(AUTO_BASE + 3, 2000.0);
    assert!((last() - 2000.0).abs() < 1e-3);
    inst.set_param(AUTO_BASE + 3, f32::NAN);
    assert!((last() - 20000.0).abs() < 0.5, "released: the macro (at 1) takes over: {}", last());
    inst.set_param(AUTO_BASE + 999, 5.0); // no such target: ignored
    // Unmapped target: the override wins over the base, and releasing returns to the base.
    inst.set_param(8 + 7 + 4 * 3 + 1, 0.0); // target 3's macro field → unmapped (base = doc 8000)
    assert!((last() - 8000.0).abs() < 0.5, "unmapped → its document value: {}", last());
    inst.set_param(AUTO_BASE + 3, 300.0);
    assert!((last() - 300.0).abs() < 1e-3);
    inst.set_param(8 + 7 + 4 * 3, 9000.0); // a doc edit of the base while automated
    assert!((last() - 300.0).abs() < 1e-3, "automation still wins over a doc edit");
    inst.set_param(AUTO_BASE + 3, f32::NAN);
    assert!((last() - 9000.0).abs() < 0.5, "released → the edited base");

    // Through the engine: macro 1 holds chain pan hard left, the automation of that same
    // pan holds it hard right; the automation wins for the whole song.
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut r = rack("instrument", vec![chain("a", Some("test.dc"))]);
    map_macro(&mut r, 0, "m1", json!({ "chainId": "a", "kind": "chain", "param": "pan" }), 0.0, 1.0);
    add_rack_channel(&mut p, "c1", "i1", r);
    song_with_held_note(&mut p, "c1");
    automate(&mut p, "a1", "channel/c1/rack/a/pan", &[(0.0, 1.0), (3840.0, 1.0)]);
    let o = render_p(&p, RenderScope::Song, 0.0);
    assert!(o.warnings.is_empty(), "{:?}", o.warnings);
    assert!(o.l[200] < 0.01 && near(o.r[200], DC1, 1e-4), "automation (right) beats macro (left): {} {}", o.l[200], o.r[200]);
}

#[test]
fn deleting_the_automation_hands_the_inner_param_back_to_its_macro() {
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut r = rack("instrument", vec![chain("a", Some("test.dc"))]);
    map_macro(&mut r, 0, "m1", json!({ "chainId": "a", "kind": "chain", "param": "volume" }), 0.0, 1.0);
    add_rack_channel(&mut p, "c1", "i1", r);
    p["channels"]["c1"]["generator"]["params"]["macro1"] = json!(0.793_700_5); // 2·n³ = 1
    song_with_held_note(&mut p, "c1");
    automate(&mut p, "a1", "channel/c1/rack/a/volume", &[(0.0, 0.5), (3840.0, 0.5)]); // 2·0.125 = 0.25
    let mut live = Live::new(&p);
    live.send(Cmd::Play);
    let o = live.run(4800);
    assert!(near(o[2 * 4799], 0.25 * DC1, 1e-4), "automated: {}", o[2 * 4799]);
    // An unrelated rebuild keeps the override (carried, re-sent to the instance).
    live.session.model.transport.master_volume = 1.0;
    live.session.version += 1;
    let b = live.session.build(false);
    live.send(Cmd::Batch(b));
    let o = live.run(4800);
    assert!(near(o[2 * 4799], 0.25 * DC1, 1e-4), "still automated after a rebuild: {}", o[2 * 4799]);
    // Delete the automation clip: the macro value (volume 1) takes over again.
    live.session.model.clips.retain(|_, c| c.kind != "automation");
    live.session.model.automations.clear();
    live.session.version += 1;
    let b = live.session.build(false);
    assert!(b.instruments.is_empty(), "no rebuild of the rack");
    live.send(Cmd::Batch(b));
    let o = live.run(4800);
    assert!(near(o[2 * 4799], DC1, 1e-4), "released → the macro's volume: {}", o[2 * 4799]);
}

// ── Instrument latency in PDC ────────────────────────────────────────────

/// A rack channel whose only chain is test.dc → test.latency (64 frames).
fn latent_rack() -> Value {
    let mut a = chain("a", Some("test.dc"));
    device(&mut a, "lat", "test.latency");
    rack("instrument", vec![a])
}

#[test]
fn a_latent_instrument_rack_stays_aligned_with_other_channels() {
    // On another insert, on the same insert, and next to an insert whose own FX is latent too.
    for (c2_insert, c2_fx) in [("i2", false), ("i1", false), ("i2", true)] {
        let mut p = base(120.0, "pattern");
        add_insert(&mut p, "i1", json!({ "m": 1 }));
        add_insert(&mut p, "i2", json!({ "m": 1 }));
        add_rack_channel(&mut p, "c1", "i1", latent_rack());
        add_channel(&mut p, "c2", "test.dc", c2_insert);
        if c2_fx {
            add_slot(&mut p, "i2", "s1", "test.latency", None);
        }
        add_note(&mut p, "pa", "c1", "n", 960.0, 480.0, 60);
        add_note(&mut p, "pa", "c2", "n", 960.0, 480.0, 60);
        let o = render_p(&p, PATTERN, 0.0);
        assert!(o.warnings.is_empty(), "{:?}", o.warnings);
        let at = 24000 + LAT;
        assert_eq!(o.l[at - 1], 0.0, "{c2_insert}/{c2_fx}: nothing before the aligned onset: {}", o.l[at - 1]);
        assert!(near(o.l[at], 2.0 * DC1, 1e-5), "{c2_insert}/{c2_fx}: both onsets on the same sample: {}", o.l[at]);
        // And they end together too.
        let end = 24000 + 12000 + LAT;
        assert!(near(o.l[end - 1], 2.0 * DC1, 1e-5) && near(o.l[end], 0.0, 1e-6), "{c2_insert}/{c2_fx}: ends {} {}", o.l[end - 1], o.l[end]);
    }
}

#[test]
fn instrument_latency_is_reported_and_refreshed_when_a_device_toggles() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_insert(&mut p, "i2", json!({ "m": 1 }));
    let mut r = latent_rack();
    r["chains"]["a"]["devices"]["lat"]["enabled"] = json!(false);
    add_rack_channel(&mut p, "c1", "i1", r);
    add_channel(&mut p, "c2", "test.dc", "i2");
    let mut live = Live::new(&p);
    live.run(480);
    let (s1, s2) = (live.session.channel_slot("c1").unwrap(), live.session.channel_slot("c2").unwrap());
    let shared = live.core.shared.clone();
    assert_eq!(shared.ch_latency[s1 as usize].load(std::sync::atomic::Ordering::Relaxed), 0);
    assert!(!live.session.refresh_latencies(&shared));
    // Enable the latent device: a param-only edit (no rebuild), then the latency poll sees 64.
    live.session.model.channels.get_mut("c1").unwrap().generator.rack.as_mut().unwrap().chains.get_mut("a").unwrap().devices.get_mut("lat").unwrap().enabled = true;
    live.session.version += 1;
    let b = live.session.build(false);
    assert!(b.instruments.is_empty() && !b.inst_params.is_empty());
    live.send(Cmd::Batch(b));
    live.run(480);
    assert_eq!(shared.ch_latency[s1 as usize].load(std::sync::atomic::Ordering::Relaxed), LAT as u32);
    assert!(live.session.refresh_latencies(&shared), "the poll asks for a PDC rebuild");
    live.session.version += 1;
    let b = live.session.build(false);
    let prog = b.program.as_ref().unwrap();
    let ch = |s: u32| prog.channel(s).unwrap();
    assert_eq!(ch(s1).latency, LAT);
    assert!(ch(s1).pdc.is_none(), "the latent channel itself is not delayed");
    assert!(ch(s2).pdc.is_none(), "c2 sits on another insert: the route into the master lines up instead");
    let slot_of = |id: &str| live.session.names.inserts.iter().find(|(_, x)| x == id).map(|(s, _)| *s);
    let i1 = prog.inserts.iter().find(|i| Some(i.slot) == slot_of("i1")).unwrap();
    let i2 = prog.inserts.iter().find(|i| Some(i.slot) == slot_of("i2")).unwrap();
    assert_eq!(i1.in_lat, LAT);
    assert_eq!(i2.routes[0].delay.as_ref().map(|d| d.len()), Some(LAT), "i2 → master is delayed by the rack's latency");
    assert!(i1.routes[0].delay.is_none());
    live.send(Cmd::Batch(b));
    live.run(480);
    assert!(!live.session.refresh_latencies(&shared));
}

#[test]
fn instruments_report_no_latency_by_default() {
    let inst = (test_host().create_instrument)("test.dc", 48000.0, 512).unwrap();
    assert_eq!(inst.latency(), 0);
    let real = krypt_studio_dsp::create_instrument("krypt.triosc", 48000.0, 512).unwrap();
    assert_eq!(real.latency(), 0);
}
