//! Engine integration tests with test-only plugins (independent of the
//! real krypt-studio-dsp implementations).
//!
//! - `test.sine` / stock instrument ids → a tiny polyphonic sine.
//! - `test.dc` / `krypt.audioclip` → outputs 0.25 per held note and records
//!   every event with its absolute frame (sample-accurate timing checks).
//! - effects: gain (pass-through), `test.latency` (64-sample delay, reports
//!   latency), `test.sc` (outputs its sidechain input).

use crate::compile::{SampleMode, Session};
use crate::core::{Cmd, Core, Garbage, Shared};
use crate::model::{Model, Warnings};
use crate::plugins::PluginHost;
use crate::protocol::{RenderRequest, RenderScope};
use crate::render::{normalize_peak, render_audio, run_render, RenderEnv, NORMALIZE_TARGET_DB};
use crate::samples::SampleCache;
use krypt_studio_dsp::{Effect, Instrument, NoteExtras, ParamSpec, PluginDescriptor, PluginKind, ProcessContext};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

// ── Test plugins ─────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
struct Rec {
    inst: u32,
    kind: &'static str,
    key: u8,
    frame: u64,
    pitch: f32,
    sample_start: f64,
}

thread_local! {
    static LOG: RefCell<Vec<Rec>> = const { RefCell::new(Vec::new()) };
    static CUTOFFS: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static NEXT_ID: Cell<u32> = const { Cell::new(0) };
}

fn log_take() -> Vec<Rec> {
    LOG.with(|l| std::mem::take(&mut *l.borrow_mut()))
}

#[derive(Clone, Copy, Default)]
struct Voice {
    on: bool,
    key: u8,
    inc: f32,
    phase: f32,
    amp: f32,
    env: f32,
    start: usize,
    rel_at: Option<usize>,
    releasing: bool,
    fast: bool,
}

struct Sine {
    sr: f32,
    voices: [Voice; 16],
    peak: f32,
}

impl Instrument for Sine {
    fn prepare(&mut self, sample_rate: f32, _max: usize) {
        self.sr = sample_rate;
    }
    fn set_param(&mut self, index: usize, value: f32) {
        if index == 1 {
            // Recording allocates; only used by tests that don't check allocation.
            let _ = CUTOFFS.try_with(|c| {
                if let Ok(mut c) = c.try_borrow_mut() {
                    if c.capacity() > c.len() {
                        c.push(value);
                    }
                }
            });
        }
    }
    fn note_on(&mut self, offset: usize, key: u8, pitch: f32, velocity: f32, _extras: NoteExtras) {
        let idx = self.voices.iter().position(|v| !v.on).unwrap_or(0);
        let freq = 440.0 * 2f32.powf((pitch - 69.0) / 12.0);
        self.voices[idx] = Voice { on: true, key, inc: freq / self.sr, phase: 0.0, amp: velocity * 0.3, env: 1.0, start: offset, ..Default::default() };
    }
    fn note_off(&mut self, offset: usize, key: u8) {
        for v in self.voices.iter_mut() {
            if v.on && v.key == key && !v.releasing {
                v.rel_at = Some(offset);
            }
        }
    }
    fn choke(&mut self, offset: usize) {
        for v in self.voices.iter_mut() {
            if v.on {
                v.rel_at = Some(offset);
                v.fast = true;
            }
        }
    }
    fn all_off(&mut self) {
        for v in self.voices.iter_mut() {
            v.on = false;
        }
    }
    fn process(&mut self, ctx: &ProcessContext, out: [&mut [f32]; 2]) {
        let [l, r] = out;
        let n = ctx.frames.min(l.len()).min(r.len());
        let mut pk = 0f32;
        for v in self.voices.iter_mut() {
            if !v.on {
                continue;
            }
            for i in 0..n {
                if i < v.start {
                    continue;
                }
                if let Some(ra) = v.rel_at {
                    if i >= ra {
                        v.releasing = true;
                    }
                }
                if v.releasing {
                    v.env *= if v.fast { 0.99 } else { 0.9995 };
                    if v.env < 1e-4 {
                        v.on = false;
                        break;
                    }
                }
                let s = (v.phase * std::f32::consts::TAU).sin() * v.amp * v.env;
                v.phase += v.inc;
                if v.phase >= 1.0 {
                    v.phase -= 1.0;
                }
                l[i] += s;
                r[i] += s;
                pk = pk.max(s.abs());
            }
            v.start = 0;
            v.rel_at = None;
        }
        self.peak = pk;
    }
    fn activity(&self) -> f32 {
        self.peak
    }
    fn is_active(&self) -> bool {
        self.voices.iter().any(|v| v.on)
    }
}

/// Outputs 0.25 per held note; logs every event at its absolute frame.
struct Dc {
    id: u32,
    frames: u64,
    held: [u16; 128],
    pending: Vec<(usize, i32, u8)>, // (offset, +1 on / -1 off / 0 choke, key)
}

impl Dc {
    fn new() -> Self {
        let id = NEXT_ID.with(|n| {
            let v = n.get();
            n.set(v + 1);
            v
        });
        Self { id, frames: 0, held: [0; 128], pending: Vec::new() }
    }
    fn rec(&self, kind: &'static str, key: u8, offset: usize, pitch: f32, sample_start: f64) {
        LOG.with(|l| l.borrow_mut().push(Rec { inst: self.id, kind, key, frame: self.frames + offset as u64, pitch, sample_start }));
    }
}

impl Instrument for Dc {
    fn prepare(&mut self, _sr: f32, _max: usize) {}
    fn set_param(&mut self, _index: usize, _value: f32) {}
    fn note_on(&mut self, offset: usize, key: u8, pitch: f32, _velocity: f32, extras: NoteExtras) {
        self.rec("on", key, offset, pitch, extras.sample_start);
        self.pending.push((offset, 1, key));
    }
    fn note_off(&mut self, offset: usize, key: u8) {
        self.rec("off", key, offset, 0.0, 0.0);
        self.pending.push((offset, -1, key));
    }
    fn choke(&mut self, offset: usize) {
        self.rec("choke", 0, offset, 0.0, 0.0);
        self.pending.push((offset, 0, 0));
    }
    fn all_off(&mut self) {
        self.rec("alloff", 0, 0, 0.0, 0.0);
        self.held = [0; 128];
        self.pending.clear();
    }
    fn process(&mut self, ctx: &ProcessContext, out: [&mut [f32]; 2]) {
        let [l, r] = out;
        let n = ctx.frames;
        self.pending.sort_by_key(|e| e.0);
        let mut k = 0;
        for i in 0..n {
            while k < self.pending.len() && self.pending[k].0 <= i {
                let (_, d, key) = self.pending[k];
                match d {
                    1 => self.held[key as usize] += 1,
                    -1 => self.held[key as usize] = self.held[key as usize].saturating_sub(1),
                    _ => self.held = [0; 128],
                }
                k += 1;
            }
            let count: u32 = self.held.iter().map(|&h| h as u32).sum();
            l[i] += 0.25 * count as f32;
            r[i] += 0.25 * count as f32;
        }
        self.pending.clear();
        self.frames += n as u64;
    }
    fn is_active(&self) -> bool {
        true
    }
}

struct Gain {
    g: f32,
}

thread_local! {
    /// Gain::process calls on this thread (offline renders run on the test thread).
    static GAIN_CALLS: Cell<usize> = const { Cell::new(0) };
}

impl Effect for Gain {
    fn prepare(&mut self, _sr: f32, _max: usize) {}
    fn set_param(&mut self, index: usize, value: f32) {
        if index == 0 {
            self.g = 10f32.powf(value / 20.0);
        }
    }
    fn process(&mut self, _ctx: &ProcessContext, buf: [&mut [f32]; 2], _sc: Option<[&[f32]; 2]>) {
        GAIN_CALLS.with(|c| c.set(c.get() + 1));
        let [l, r] = buf;
        for x in l.iter_mut().chain(r.iter_mut()) {
            *x *= self.g;
        }
    }
    fn reset(&mut self) {}
}

const LAT: usize = 64;

struct Latency {
    l: [f32; LAT],
    r: [f32; LAT],
    pos: usize,
}

impl Effect for Latency {
    fn prepare(&mut self, _sr: f32, _max: usize) {}
    fn set_param(&mut self, _index: usize, _value: f32) {}
    fn process(&mut self, _ctx: &ProcessContext, buf: [&mut [f32]; 2], _sc: Option<[&[f32]; 2]>) {
        let [l, r] = buf;
        for i in 0..l.len() {
            let (a, b) = (self.l[self.pos], self.r[self.pos]);
            self.l[self.pos] = l[i];
            self.r[self.pos] = r[i];
            l[i] = a;
            r[i] = b;
            self.pos = (self.pos + 1) % LAT;
        }
    }
    fn latency(&self) -> usize {
        LAT
    }
    fn reset(&mut self) {
        self.l = [0.0; LAT];
        self.r = [0.0; LAT];
    }
}

/// Replaces its input with the sidechain signal.
struct ScCopy;

impl Effect for ScCopy {
    fn prepare(&mut self, _sr: f32, _max: usize) {}
    fn set_param(&mut self, _index: usize, _value: f32) {}
    fn process(&mut self, _ctx: &ProcessContext, buf: [&mut [f32]; 2], sc: Option<[&[f32]; 2]>) {
        let [l, r] = buf;
        match sc {
            Some([sl, sr]) => {
                l.copy_from_slice(&sl[..l.len()]);
                r.copy_from_slice(&sr[..r.len()]);
            }
            None => {
                l.fill(0.0);
                r.fill(0.0);
            }
        }
    }
    fn reset(&mut self) {}
}

fn spec(id: &'static str, min: f32, max: f32, default: f32, scale: &'static str) -> ParamSpec {
    ParamSpec { id, name: id, min, max, default, unit: "", scale, step: None, options: None, group: None, automatable: None }
}

const INSTS: [(&str, bool); 6] =
    [("krypt.sampler", true), ("krypt.audioclip", true), ("krypt.triosc", false), ("krypt.kick808", false), ("test.dc", false), ("test.sine", false)];
const FXS: [(&str, bool); 9] = [
    ("krypt.limiter", false),
    ("krypt.reverb", false),
    ("krypt.delay", false),
    ("krypt.tapeecho", false),
    ("krypt.grain", false),
    ("krypt.drive", false),
    ("test.gain", false),
    ("test.latency", false),
    ("test.sc", true),
];

fn test_descriptors() -> Vec<PluginDescriptor> {
    let mut v = Vec::new();
    for (id, us) in INSTS {
        v.push(PluginDescriptor {
            id,
            name: id,
            kind: PluginKind::Instrument,
            category: "test",
            description: "test",
            params: vec![spec("gain", -24.0, 24.0, 0.0, "linear"), spec("cutoff", 20.0, 20000.0, 8000.0, "log")],
            uses_sample: if us { Some(true) } else { None },
            sidechain: None,
            default_mix: None,
        });
    }
    for (id, sc) in FXS {
        v.push(PluginDescriptor {
            id,
            name: id,
            kind: PluginKind::Effect,
            category: "test",
            description: "test",
            params: vec![spec("gain", -24.0, 24.0, 0.0, "linear")],
            uses_sample: None,
            sidechain: if sc { Some(true) } else { None },
            default_mix: None,
        });
    }
    v
}

fn test_create_instrument(id: &str, sr: f32, _max: usize) -> Option<Box<dyn Instrument>> {
    match id {
        "test.panic" => panic!("test plugin constructor panic"),
        "test.dc" | "krypt.audioclip" => Some(Box::new(Dc::new())),
        _ if INSTS.iter().any(|(i, _)| *i == id) => Some(Box::new(Sine { sr, voices: [Voice::default(); 16], peak: 0.0 })),
        _ => None,
    }
}

fn test_create_effect(id: &str, _sr: f32, _max: usize) -> Option<Box<dyn Effect>> {
    match id {
        "test.latency" => Some(Box::new(Latency { l: [0.0; LAT], r: [0.0; LAT], pos: 0 })),
        "test.sc" => Some(Box::new(ScCopy)),
        _ if FXS.iter().any(|(i, _)| *i == id) => Some(Box::new(Gain { g: 1.0 })),
        _ => None,
    }
}

pub fn test_host() -> PluginHost {
    PluginHost { create_instrument: test_create_instrument, create_effect: test_create_effect, descriptors: test_descriptors }
}

// ── Project builders ─────────────────────────────────────────────────────

fn insert(id: &str, master: bool, routes: Value) -> Value {
    json!({ "id": id, "name": id, "color": "#ffffff", "volume": 1, "pan": 0, "stereoSep": 0, "mute": false, "solo": false,
            "phaseInvert": false, "swapLR": false, "slots": {}, "slotOrder": [], "routes": routes, "isMaster": master })
}

fn base(bpm: f64, mode: &str) -> Value {
    json!({
        "schemaVersion": 1, "id": "prj",
        "meta": { "name": "t", "author": "", "genre": "", "notes": "", "createdAt": "" },
        "transport": { "bpm": bpm, "timeSig": { "num": 4, "den": 4 }, "swing": 0, "mode": mode, "activePatternId": "pa",
                       "loop": { "enabled": false, "start": 0, "end": 0 }, "metronome": false, "masterVolume": 1 },
        "channels": {}, "channelOrder": [],
        "patterns": { "pa": { "id": "pa", "name": "A", "color": "#fff", "length": null, "notes": {} } }, "patternOrder": ["pa"],
        "playlist": { "tracks": { "t1": { "id": "t1", "name": "T", "color": "#000", "height": 44, "mute": false, "solo": false } },
                      "trackOrder": ["t1"], "clips": {}, "markers": {} },
        "automations": {},
        "mixer": { "inserts": { "m": insert("m", true, json!({})) }, "insertOrder": ["m"], "masterId": "m" },
        "samples": {}
    })
}

fn add_insert(p: &mut Value, id: &str, routes: Value) {
    p["mixer"]["inserts"][id] = insert(id, false, routes);
    p["mixer"]["insertOrder"].as_array_mut().unwrap().push(json!(id));
}

fn add_channel(p: &mut Value, id: &str, gen: &str, ins: &str) {
    p["channels"][id] = json!({ "id": id, "name": id, "color": "#fff",
        "generator": { "type": gen, "params": {}, "sampleId": null },
        "volume": 0.78, "pan": 0, "pitch": 0, "mute": false, "insertId": ins, "rootKey": 60, "swing": 1,
        "poly": { "mono": false, "glideMs": 0, "cutGroup": 0, "cutBy": 0 } });
    p["channelOrder"].as_array_mut().unwrap().push(json!(id));
}

fn add_note(p: &mut Value, pat: &str, ch: &str, nid: &str, tick: f64, dur: f64, key: u8) {
    p["patterns"][pat]["notes"][ch][nid] = json!({ "id": nid, "tick": tick, "dur": dur, "key": key, "vel": 0.8, "pan": 0,
        "release": 0.5, "fine": 0, "slide": false, "modX": 0.5, "modY": 0.5 });
}

fn add_slot(p: &mut Value, ins: &str, sid: &str, kind: &str, sidechain: Option<&str>) {
    p["mixer"]["inserts"][ins]["slots"][sid] = json!({ "id": sid, "type": kind, "enabled": true, "mix": 1, "params": {}, "sidechainFrom": sidechain });
    p["mixer"]["inserts"][ins]["slotOrder"].as_array_mut().unwrap().push(json!(sid));
}

fn add_clip(p: &mut Value, id: &str, kind: &str, start: f64, len: f64, extra: Value) {
    let mut c = json!({ "id": id, "trackId": "t1", "kind": kind, "start": start, "length": len, "offset": 0, "mute": false, "color": null });
    for (k, v) in extra.as_object().unwrap() {
        c[k] = v.clone();
    }
    p["playlist"]["clips"][id] = c;
}

fn beat_json() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../test/fixtures/beat.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read beat.json")).expect("parse beat.json")
}

struct Rendered {
    l: Vec<f32>,
    r: Vec<f32>,
    warnings: Vec<String>,
}

fn render_p(p: &Value, scope: RenderScope, tail: f64) -> Rendered {
    log_take();
    let mut w = Warnings::default();
    let model = Model::from_project(p, &mut w);
    let mut warnings = w.drain_messages();
    let req = RenderRequest {
        path: String::new(),
        scope,
        format: "wav32f".into(),
        sample_rate: Some(48000.0),
        tail_sec: Some(tail),
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
            host: test_host(),
            cache: Arc::new(SampleCache::new()),
            factory_dir: ".".into(),
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

const PATTERN: RenderScope = RenderScope::Pattern { pattern_id: None };

fn ons(log: &[Rec]) -> Vec<(u8, u64)> {
    log.iter().filter(|r| r.kind == "on").map(|r| (r.key, r.frame)).collect()
}

fn near(a: f32, b: f32, tol: f32) -> bool {
    (a - b).abs() <= tol
}

/// DC level of one held note through a default channel (vol 0.78, centre pan).
const DC1: f32 = 0.25 * 0.78;

// ── Tests ────────────────────────────────────────────────────────────────

#[test]
fn note_timing_is_sample_accurate() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "n1", 960.0, 480.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    // One 4/4 bar at 120 bpm / 48 kHz = 96000 frames; tick 960 = frame 24000.
    assert_eq!(o.l.len(), 96000);
    assert_eq!(o.l[23999], 0.0);
    assert!(near(o.l[24000], DC1, 1e-5), "onset level {}", o.l[24000]);
    assert!(near(o.l[35999], DC1, 1e-5));
    assert_eq!(o.l[36000], 0.0);
    let log = log_take();
    assert_eq!(ons(&log), vec![(60, 24000)]);
    let off = log.iter().find(|r| r.kind == "off").unwrap();
    assert_eq!(off.frame, 36000);
}

#[test]
fn muted_notes_are_never_scheduled() {
    // Wave 2 (piano-roll mute tool): `mute: true` notes are skipped in compile.rs,
    // but still count towards the auto pattern length (like patternLength() in TS).
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "a", 0.0, 240.0, 60);
    add_note(&mut p, "pa", "c1", "b", 960.0, 240.0, 62);
    add_note(&mut p, "pa", "c1", "c", 3840.0, 240.0, 64); // bar 2
    p["patterns"]["pa"]["notes"]["c1"]["b"]["mute"] = json!(true);
    p["patterns"]["pa"]["notes"]["c1"]["c"]["mute"] = json!(true);
    let o = render_p(&p, PATTERN, 0.0);
    assert_eq!(ons(&log_take()), vec![(60, 0)]);
    assert_eq!(o.l.len(), 2 * 96000, "the muted note in bar 2 still makes the pattern two bars long");
}

#[test]
fn swing_delays_odd_sixteenths() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "a", 240.0, 60.0, 61); // odd step
    add_note(&mut p, "pa", "c1", "b", 480.0, 60.0, 62); // even step
    p["transport"]["swing"] = json!(1.0);
    render_p(&p, PATTERN, 0.0);
    // 240 + 1*1*240*0.5 = 360 ticks → 9000 frames; even step unchanged.
    assert_eq!(ons(&log_take()), vec![(61, 9000), (62, 12000)]);
    p["transport"]["swing"] = json!(0.5);
    p["channels"]["c1"]["swing"] = json!(0.5);
    render_p(&p, PATTERN, 0.0);
    // 240 + 0.5*0.5*120 = 270 ticks → 6750 frames.
    assert_eq!(ons(&log_take()), vec![(61, 6750), (62, 12000)]);
}

#[test]
fn pattern_clips_loop_offset_and_cut() {
    // (a) A 2-bar clip of a 1-bar pattern loops its source.
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "n", 0.0, 240.0, 60);
    add_clip(&mut p, "k1", "pattern", 0.0, 7680.0, json!({ "patternId": "pa" }));
    render_p(&p, RenderScope::Song, 0.0);
    assert_eq!(ons(&log_take()), vec![(60, 0), (60, 96000)]);

    // (b) Trimmed start (offset 960): the source note at 0 plays only on the next loop.
    p["playlist"]["clips"]["k1"]["length"] = json!(3840.0);
    p["playlist"]["clips"]["k1"]["offset"] = json!(960.0);
    render_p(&p, RenderScope::Song, 0.0);
    assert_eq!(ons(&log_take()), vec![(60, 72000)]);

    // (c) Notes are cut at the clip end.
    p["playlist"]["clips"]["k1"]["offset"] = json!(0.0);
    p["playlist"]["clips"]["k1"]["length"] = json!(1000.0);
    p["patterns"]["pa"]["notes"]["c1"]["n"]["dur"] = json!(3000.0);
    let o = render_p(&p, RenderScope::Song, 0.0);
    let log = log_take();
    assert_eq!(log.iter().find(|r| r.kind == "off").map(|r| r.frame), Some(25000));
    assert!(o.l[24999] > 0.0 && o.l[25000] == 0.0);
}

#[test]
fn tempo_automation_changes_timing() {
    let mut p = base(60.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "n", 960.0, 240.0, 60);
    add_clip(&mut p, "k1", "pattern", 0.0, 3840.0, json!({ "patternId": "pa" }));
    let v = (120.0 - 10.0) / 989.0; // normalized for 120 bpm
    p["automations"]["a1"] = json!({ "id": "a1", "name": "Tempo", "color": "#fff", "target": "transport/bpm",
        "points": { "p1": { "id": "p1", "tick": 0, "value": v, "tension": 0 }, "p2": { "id": "p2", "tick": 3840, "value": v, "tension": 0 } } });
    add_clip(&mut p, "k2", "automation", 0.0, 3840.0, json!({ "automationId": "a1" }));
    let o = render_p(&p, RenderScope::Song, 0.0);
    // At the document tempo (60) the note would start at 48000; automated to 120 → 24000.
    assert_eq!(ons(&log_take()), vec![(60, 24000)]);
    assert!((o.l.len() as i64 - 96000).abs() <= 1, "len {}", o.l.len());
}

#[test]
fn param_automation_follows_curve_and_holds() {
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.sine", "i1");
    p["automations"]["a1"] = json!({ "id": "a1", "name": "Cutoff", "color": "#fff", "target": "channel/c1/gen/cutoff",
        "points": { "p1": { "id": "p1", "tick": 0, "value": 0.0, "tension": 0 }, "p2": { "id": "p2", "tick": 1920, "value": 1.0, "tension": 0 } } });
    add_clip(&mut p, "k2", "automation", 0.0, 1920.0, json!({ "automationId": "a1" }));
    CUTOFFS.with(|c| {
        let mut c = c.borrow_mut();
        c.clear();
        c.reserve(10_000);
    });
    render_p(&p, RenderScope::Song, 0.0);
    let vals = CUTOFFS.with(|c| c.borrow().clone());
    // [0] = document default at creation, then one value per 32-frame sub-block.
    assert_eq!(vals[0], 8000.0);
    assert!((vals[1] - 20.0).abs() < 1e-3);
    // Sub-block 750 starts at tick 960 → normalized 0.5 → 20 * 1000^0.5 Hz.
    let mid = 20.0 * 1000f32.sqrt();
    assert!((vals[751] - mid).abs() / mid < 0.01, "mid {}", vals[751]);
    assert!(vals[1..].windows(2).all(|w| w[1] >= w[0]));
    // After the clip ends its last value holds (no reset to 8000).
    assert_eq!(*vals.last().unwrap(), 20000.0);
}

#[test]
fn cut_groups_choke() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "open", "test.dc", "i1");
    add_channel(&mut p, "closed", "test.dc", "i1");
    p["channels"]["open"]["pan"] = json!(-1.0);
    p["channels"]["open"]["poly"]["cutBy"] = json!(1);
    p["channels"]["closed"]["pan"] = json!(1.0);
    p["channels"]["closed"]["poly"]["cutGroup"] = json!(1);
    add_note(&mut p, "pa", "open", "a", 0.0, 3000.0, 60);
    add_note(&mut p, "pa", "closed", "b", 960.0, 240.0, 62);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(o.l[23999] > 0.2, "open hat rings until choked");
    assert_eq!(o.l[24000], 0.0, "choked at the closed hat's onset");
    assert!(o.r[24000] > 0.2);
    let log = log_take();
    assert!(log.iter().any(|r| r.kind == "choke" && r.frame == 24000));
}

#[test]
fn equal_power_channel_pan() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    p["channels"]["c1"]["pan"] = json!(0.5);
    add_note(&mut p, "pa", "c1", "a", 0.0, 960.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    let th = 1.5 * std::f32::consts::FRAC_PI_4;
    let sq = std::f32::consts::SQRT_2;
    assert!(near(o.l[100], DC1 * th.cos() * sq, 1e-5));
    assert!(near(o.r[100], DC1 * th.sin() * sq, 1e-5));
    // Power is preserved: L² + R² = 2 · centre².
    assert!(near(o.l[100].powi(2) + o.r[100].powi(2), 2.0 * DC1 * DC1, 1e-5));
}

#[test]
fn mixer_solo_mute_and_bus_rules() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_insert(&mut p, "i2", json!({ "m": 1 }));
    p["mixer"]["inserts"]["i1"]["pan"] = json!(-1.0);
    p["mixer"]["inserts"]["i2"]["pan"] = json!(1.0);
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_channel(&mut p, "c2", "test.dc", "i2");
    add_note(&mut p, "pa", "c1", "a", 0.0, 3840.0, 60);
    add_note(&mut p, "pa", "c2", "b", 0.0, 3840.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(near(o.l[100], DC1, 1e-5) && near(o.r[100], DC1, 1e-5));
    // Solo i2 → i1 muted.
    p["mixer"]["inserts"]["i2"]["solo"] = json!(true);
    let o = render_p(&p, PATTERN, 0.0);
    assert_eq!(o.l[100], 0.0);
    assert!(near(o.r[100], DC1, 1e-5));
    // Mute instead.
    p["mixer"]["inserts"]["i2"]["solo"] = json!(false);
    p["mixer"]["inserts"]["i2"]["mute"] = json!(true);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(near(o.l[100], DC1, 1e-5));
    assert_eq!(o.r[100], 0.0);
    // Soloing an insert that reaches the master through a bus keeps the bus open.
    p["mixer"]["inserts"]["i2"]["mute"] = json!(false);
    add_insert(&mut p, "bus", json!({ "m": 1 }));
    p["mixer"]["inserts"]["i1"]["routes"] = json!({ "bus": 1 });
    p["mixer"]["inserts"]["i1"]["solo"] = json!(true);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(near(o.l[100], DC1, 1e-5), "soloed insert audible through its bus");
    assert_eq!(o.r[100], 0.0);
}

#[test]
fn routing_cycles_are_ignored_with_a_warning() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1, "i2": 1 }));
    add_insert(&mut p, "i2", json!({ "m": 1, "i1": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "a", 0.0, 3840.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(o.warnings.iter().any(|w| w.contains("feedback loop")), "{:?}", o.warnings);
    // i1→m plus i1→i2→m (i2→i1 dropped).
    assert!(near(o.l[100], 2.0 * DC1, 1e-5), "{}", o.l[100]);
}

#[test]
fn plugin_delay_compensation_aligns_parallel_paths() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_insert(&mut p, "i2", json!({ "m": 1 }));
    add_slot(&mut p, "i1", "s1", "test.latency", None);
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_channel(&mut p, "c2", "test.dc", "i2");
    add_note(&mut p, "pa", "c1", "a", 960.0, 480.0, 60);
    add_note(&mut p, "pa", "c2", "b", 960.0, 480.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    // Without PDC frame 24000 would already carry the undelayed path.
    assert_eq!(o.l[24000 + LAT - 1], 0.0);
    assert!(near(o.l[24000 + LAT], 2.0 * DC1, 1e-5), "{}", o.l[24000 + LAT]);
}

#[test]
fn sidechain_input_is_routed_in_topological_order() {
    let mut p = base(120.0, "pattern");
    // i2 listed before i1, but i2's sidechain needs i1 first.
    add_insert(&mut p, "i2", json!({ "m": 1 }));
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_slot(&mut p, "i2", "s1", "test.sc", Some("i1"));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "a", 960.0, 480.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(near(o.l[24000], 2.0 * DC1, 1e-5), "{}", o.l[24000]);
}

/// A silent insert's chain of stock effects sleeps once its output has been
/// silent for quiet_frames (no work for idle parts) and wakes on the first
/// input sample; chains with an echo delay or a third-party effect never sleep.
#[test]
fn silent_inserts_let_stock_fx_sleep_and_wake_on_input() {
    let gap = |fx: &str| {
        let mut p = base(120.0, "pattern");
        add_insert(&mut p, "i1", json!({ "m": 1 }));
        add_slot(&mut p, "i1", "s1", fx, None);
        add_channel(&mut p, "c1", "test.dc", "i1");
        add_note(&mut p, "pa", "c1", "a", 0.0, 480.0, 60); // the first half beat
        add_note(&mut p, "pa", "c1", "b", 7680.0, 480.0, 60); // bar 3 (4 s at 120 bpm)
        GAIN_CALLS.with(|c| c.set(0));
        let o = render_p(&p, PATTERN, 0.0);
        (o, GAIN_CALLS.with(|c| c.get()))
    };
    let (o, calls) = gap("krypt.reverb");
    let blocks = o.l.len() / 32;
    assert!(calls < blocks * 3 / 4, "the reverb stand-in slept through the gap: {calls} of {blocks} sub-blocks processed");
    assert!(near(o.l[192_000 + 1], DC1, 1e-5), "woke for the second note: {}", o.l[192_000 + 1]);
    assert_eq!(o.l[100_000], 0.0);
    for fx in ["krypt.delay", "krypt.tapeecho", "krypt.grain", "test.gain"] {
        let (o, calls) = gap(fx);
        assert!(calls >= o.l.len() / 32, "{fx} never sleeps: {calls} calls for {} sub-blocks", o.l.len() / 32);
    }
}

#[test]
fn unknown_plugins_are_silent_or_pass_through() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_slot(&mut p, "i1", "s1", "vendor.mystery-fx", None);
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_channel(&mut p, "c2", "vendor.mystery-synth", "i1");
    add_note(&mut p, "pa", "c1", "a", 0.0, 960.0, 60);
    add_note(&mut p, "pa", "c2", "b", 0.0, 960.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(near(o.l[100], DC1, 1e-5));
    assert_eq!(o.warnings.iter().filter(|w| w.contains("vendor.mystery-synth")).count(), 1);
    assert_eq!(o.warnings.iter().filter(|w| w.contains("vendor.mystery-fx")).count(), 1);
}

#[test]
fn audio_clips_start_mid_sample_with_gain_and_fades() {
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "ca", "krypt.audioclip", "i1");
    p["samples"]["s1"] = json!({ "id": "s1", "name": "x", "path": "does-not-exist.wav" });
    p["channels"]["ca"]["generator"]["sampleId"] = json!("s1");
    add_clip(&mut p, "k1", "audio", 0.0, 7680.0, json!({ "channelId": "ca", "gain": 0.5, "fadeIn": 960, "fadeOut": 0 }));
    p["playlist"]["clips"]["k1"]["offset"] = json!(480.0);
    // Start in the middle of the clip: the engine chases it.
    let o = render_p(&p, RenderScope::Range { start_tick: 1920.0, end_tick: 3840.0 }, 0.0);
    let log = log_take();
    let on = log.iter().find(|r| r.kind == "on").expect("chased note-on");
    assert_eq!(on.frame, 0);
    // (1920 - 0 + 480) ticks at 120 bpm = 2.5 beats = 1.25 s.
    assert!((on.sample_start - 1.25).abs() < 1e-9, "sample_start {}", on.sample_start);
    assert!((on.pitch - 60.0).abs() < 1e-6);
    assert!(near(o.l[1000], DC1 * 0.5, 1e-4), "{}", o.l[1000]);
    assert!(o.warnings.iter().any(|w| w.contains("does-not-exist")));
    // From the clip start: offset → 0.25 s, and the fade-in at tick 480 is half way.
    let o = render_p(&p, RenderScope::Range { start_tick: 0.0, end_tick: 1920.0 }, 0.0);
    let on = log_take().into_iter().find(|r| r.kind == "on").unwrap();
    assert!((on.sample_start - 0.25).abs() < 1e-9);
    assert!(near(o.l[12000], DC1 * 0.5 * 0.5, DC1 * 0.01), "{}", o.l[12000]);
}

#[test]
fn metronome_clicks_on_beats() {
    let mut p = base(120.0, "pattern");
    p["transport"]["metronome"] = json!(true);
    let o = render_p(&p, PATTERN, 0.0);
    let pk = |a: usize, b: usize| o.l[a..b].iter().fold(0f32, |m, x| m.max(x.abs()));
    assert!(pk(0, 1000) > 0.3, "accent on the bar");
    assert!(pk(24000, 25000) > 0.1 && pk(24000, 25000) < pk(0, 1000));
    assert_eq!(pk(20000, 24000), 0.0);
}

#[test]
fn beat_fixture_renders_non_silent_with_test_sine() {
    let p = beat_json();
    let o = render_p(&p, RenderScope::Song, 1.0);
    // 8 bars at 140 bpm = 30720 ticks = 13.714 s, + 1 s tail.
    let expect = (30720.0 / 960.0 * 60.0 / 140.0 * 48000.0f64).round() as i64 + 48000;
    assert!((o.l.len() as i64 - expect).abs() <= 1, "len {} vs {expect}", o.l.len());
    assert!(o.l.iter().chain(o.r.iter()).all(|x| x.is_finite()));
    let peak = o.l.iter().chain(o.r.iter()).fold(0f32, |m, x| m.max(x.abs()));
    let rms = (o.l.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / o.l.len() as f64).sqrt();
    eprintln!("beat.json (test sine): {} frames, peak {:.3} ({:.1} dBFS), rms {:.4}", o.l.len(), peak, 20.0 * peak.log10(), rms);
    assert!(peak > 0.05, "peak {peak}");
    assert!(rms > 0.005, "rms {rms}");
    let bar = (o.l.len() - 48000) / 8;
    for b in 0..8 {
        let e: f64 = o.l[b * bar..(b + 1) * bar].iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / bar as f64;
        assert!(e.sqrt() > 0.001, "bar {b} is silent");
    }
    // The tail decays.
    let tail_pk = o.l[o.l.len() - 4800..].iter().fold(0f32, |m, x| m.max(x.abs()));
    assert!(tail_pk < peak);
}

#[test]
fn run_render_writes_wav_and_result() {
    let p = beat_json();
    let mut w = Warnings::default();
    let model = Model::from_project(&p, &mut w);
    let dir = std::env::temp_dir().join(format!("kse-render-{}", std::process::id()));
    let path = dir.join("beat.wav");
    for (fmt, bits) in [("wav16", 16u16), ("wav24", 24), ("wav32f", 32)] {
        let req = RenderRequest {
            path: path.display().to_string(),
            scope: RenderScope::Range { start_tick: 0.0, end_tick: 3840.0 },
            format: fmt.into(),
            sample_rate: Some(44100.0),
            tail_sec: Some(0.0),
            analyze: Some(true),
            stems: None,
            stem_inserts: None,
            loops: None,
            normalize: None,
            mp3_kbps: None,
        };
        let mut progress = |_p: f64| {};
        let mut log = |_l: &str, _m: String| {};
        let mut env = RenderEnv {
            host: test_host(),
            cache: Arc::new(SampleCache::new()),
            factory_dir: ".".into(),
            packs_dir: None,
            base_dir: None,
            cancel: Arc::new(AtomicBool::new(false)),
            default_sr: 48000.0,
            progress: &mut progress,
            log: &mut log,
        };
        let r = run_render(&model, &req, &mut env).expect("render");
        assert!(r.analysis.is_some());
        assert!(r.peak_db > -40.0 && r.peak_db < 6.0, "peak {}", r.peak_db);
        let rd = hound::WavReader::open(&path).unwrap();
        assert_eq!(rd.spec().bits_per_sample, bits);
        assert_eq!(rd.spec().channels, 2);
        assert_eq!(rd.spec().sample_rate, 44100);
        // One bar at 140 bpm @ 44.1 kHz.
        let expect = (60.0 / 140.0 * 4.0 * 44100.0f64).round() as u32;
        assert!((rd.duration() as i64 - expect as i64).abs() <= 1, "{} vs {expect}", rd.duration());
        assert!((r.duration_sec - rd.duration() as f64 / 44100.0).abs() < 1e-6);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn normalize_peak_scales_to_target_and_skips_silence() {
    let mut l = vec![0.0f32, 0.25, -0.5, 0.1];
    let mut r = vec![0.0f32, -0.125, 0.2, f32::NAN];
    let g = normalize_peak(&mut l, &mut r, -6.0);
    let target = 10f64.powf(-6.0 / 20.0);
    assert!((g - target / 0.5).abs() < 1e-9, "gain {g}");
    assert!((l[2].abs() as f64 - target).abs() < 1e-6);
    let mut sl = vec![0.0f32; 16];
    let mut sr = vec![1e-8f32; 16];
    assert_eq!(normalize_peak(&mut sl, &mut sr, -0.1), 1.0);
    assert_eq!(sr[0], 1e-8);
}

#[test]
fn run_render_normalize_hits_minus_0_1_dbfs() {
    let p = beat_json();
    let mut w = Warnings::default();
    let model = Model::from_project(&p, &mut w);
    let dir = std::env::temp_dir().join(format!("kse-norm-{}", std::process::id()));
    let path = dir.join("norm.wav");
    let req = RenderRequest {
        path: path.display().to_string(),
        scope: RenderScope::Range { start_tick: 0.0, end_tick: 3840.0 },
        format: "wav32f".into(),
        sample_rate: Some(44100.0),
        tail_sec: Some(0.0),
        analyze: None,
        stems: None,
        stem_inserts: None,
        loops: None,
        normalize: Some(true),
        mp3_kbps: None,
    };
    let mut progress = |_p: f64| {};
    let mut log = |_l: &str, _m: String| {};
    let mut env = RenderEnv {
        host: test_host(),
        cache: Arc::new(SampleCache::new()),
        factory_dir: ".".into(),
        packs_dir: None,
        base_dir: None,
        cancel: Arc::new(AtomicBool::new(false)),
        default_sr: 48000.0,
        progress: &mut progress,
        log: &mut log,
    };
    let r = run_render(&model, &req, &mut env).expect("render");
    assert!((r.peak_db - NORMALIZE_TARGET_DB).abs() < 0.01, "peak {}", r.peak_db);
    let mut rd = hound::WavReader::open(&path).unwrap();
    let pk = rd.samples::<f32>().map(|s| s.unwrap().abs()).fold(0.0f32, f32::max) as f64;
    assert!((20.0 * pk.log10() - NORMALIZE_TARGET_DB).abs() < 0.01, "file peak {pk}");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── MP3 export ───────────────────────────────────────────────────────────

/// A held A4 (the 440 Hz test sine) for one 120 bpm bar: 2 s.
fn sine_project() -> Value {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.sine", "i1");
    add_note(&mut p, "pa", "c1", "a", 0.0, 3840.0, 69);
    p
}

/// Windows' MP3 encoder is here, or the test is skipped with a note.
fn mp3_encoder() -> bool {
    match krypt_studio_dsp::mp3::check_encoder() {
        Ok(()) => true,
        Err(e) => {
            eprintln!("SKIPPED: {e}");
            false
        }
    }
}

fn render_job(path: &std::path::Path, format: &str, sr: f64, kbps: Option<f64>) -> RenderRequest {
    RenderRequest {
        path: path.display().to_string(),
        scope: PATTERN,
        format: format.into(),
        sample_rate: Some(sr),
        tail_sec: Some(0.0),
        analyze: Some(true),
        stems: None,
        stem_inserts: None,
        loops: None,
        normalize: None,
        mp3_kbps: kbps,
    }
}

fn run_job(model: &Model, req: &RenderRequest) -> Result<crate::protocol::RenderResult, String> {
    let mut progress = |_p: f64| {};
    let mut log = |_l: &str, _m: String| {};
    let mut env = RenderEnv {
        host: test_host(),
        cache: Arc::new(SampleCache::new()),
        factory_dir: ".".into(),
        packs_dir: None,
        base_dir: None,
        cancel: Arc::new(AtomicBool::new(false)),
        default_sr: 48000.0,
        progress: &mut progress,
        log: &mut log,
    };
    run_render(model, req, &mut env)
}

#[cfg(windows)]
fn mid(x: &[f32]) -> &[f32] {
    &x[x.len() / 4..x.len() * 3 / 4]
}

#[cfg(windows)]
fn rms_db(x: &[f32]) -> f64 {
    10.0 * (x.iter().map(|&v| v as f64 * v as f64).sum::<f64>() / x.len() as f64).log10()
}

#[cfg(windows)]
fn zc_hz(x: &[f32], sr: f64) -> f64 {
    x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count() as f64 * sr / x.len() as f64
}

/// Decode an MP3 export (Windows' decoder and symphonia), line it up with
/// the float render using the reported encoder delay and compare. Symphonia
/// keeps the standard 529-sample decoder delay; Windows' decoder removes 528
/// of it (measured: its output is 1 sample later than the delay says).
/// MP3 export uses Windows' encoder, so these checks run on Windows only.
#[cfg(windows)]
fn check_mp3_against(path: &std::path::Path, m: &crate::protocol::Mp3RenderInfo, reference: &[Vec<f32>], what: &str) {
    let bytes = std::fs::read(path).unwrap();
    assert!(bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0, "{what}: the file starts with an MPEG frame (no ID3 tag)");
    let n = reference[0].len();
    assert_eq!(m.samples as usize, n, "{what}");
    let delay = m.encoder_delay.expect("encoder delay") as usize;
    for (dec_name, d, lag) in [("Windows", krypt_studio_dsp::decode::decode_mf(path).unwrap(), delay + 1), ("symphonia", krypt_studio_dsp::decode::decode_file(path).unwrap(), delay + 529)] {
        let what = format!("{what}, {dec_name} decoder");
        assert_eq!((d.sample_rate, d.channels.len()), (m.sample_rate as f32, 2), "{what}");
        assert!(d.frames() >= n + lag && d.frames() <= n + lag + krypt_studio_dsp::mp3::TAIL_PAD + 2 * 1152, "{what}: {} frames for {n} + {lag}", d.frames());
        for (c, (chan, refc)) in d.channels.iter().zip(reference).enumerate() {
            let dec = &chan[lag..lag + n];
            let (a, b) = (rms_db(mid(dec)), rms_db(mid(refc)));
            assert!((a - b).abs() < 0.5, "{what} ch{c}: rms {a:.2} dB vs float {b:.2} dB");
            let hz = zc_hz(mid(dec), m.sample_rate as f64);
            assert!((hz - 440.0).abs() < 2.0, "{what} ch{c}: {hz} Hz");
            // Aligned by the reported delay, the decode matches the waveform
            // (one sample off would cap this at ~24 dB for 440 Hz).
            let err: Vec<f32> = mid(dec).iter().zip(mid(refc)).map(|(x, y)| x - y).collect();
            let snr = b - rms_db(&err);
            if c == 0 {
                eprintln!("{what}: SNR {snr:.1} dB at lag {lag}");
            }
            assert!(snr > 35.0, "{what} ch{c}: SNR {snr:.1} dB against the float render");
        }
    }
}

#[cfg(windows)]
#[test]
fn run_render_writes_mp3_at_every_bitrate() {
    if !mp3_encoder() {
        return;
    }
    let mut w = Warnings::default();
    let model = Model::from_project(&sine_project(), &mut w);
    let dir = std::env::temp_dir().join(format!("kse-mp3-{}", std::process::id()));
    for sr in [44_100u32, 48_000] {
        let wav = dir.join(format!("ref-{sr}.wav"));
        let r_wav = run_job(&model, &render_job(&wav, "wav32f", sr as f64, Some(100.0))).expect("mp3Kbps is ignored for WAV");
        assert!(r_wav.mp3.is_none());
        let mut rd = hound::WavReader::open(&wav).unwrap();
        let s: Vec<f32> = rd.samples::<f32>().map(|x| x.unwrap()).collect();
        let reference = vec![s.iter().step_by(2).copied().collect::<Vec<f32>>(), s.iter().skip(1).step_by(2).copied().collect()];
        assert_eq!(reference[0].len(), 2 * sr as usize);
        for kbps in [None, Some(128.0), Some(192.0), Some(256.0), Some(320.0)] {
            let path = dir.join(format!("sine-{sr}-{}.mp3", kbps.unwrap_or(0.0)));
            let t0 = std::time::Instant::now();
            let r = run_job(&model, &render_job(&path, "mp3", sr as f64, kbps)).expect("mp3 render");
            let what = format!("{sr} Hz / {kbps:?} kbps");
            eprintln!("{what}: {:.0} ms, {:?}", t0.elapsed().as_secs_f64() * 1000.0, r.mp3);
            // The numbers describe the float audio, exactly as the WAV render's.
            assert_eq!((r.path.as_str(), r.files.clone()), (path.to_str().unwrap(), vec![path.display().to_string()]));
            assert_eq!((r.duration_sec, r.peak_db, r.lufs_integrated), (r_wav.duration_sec, r_wav.peak_db, r_wav.lufs_integrated), "{what}");
            assert_eq!(r.analysis, r_wav.analysis, "{what}");
            let m = r.mp3.as_ref().unwrap();
            assert_eq!((m.sample_rate, m.kbps), (sr, kbps.unwrap_or(320.0) as u32), "{what}");
            let g: Vec<u64> = m.itun_smpb.as_deref().unwrap().split_whitespace().map(|h| u64::from_str_radix(h, 16).unwrap()).collect();
            assert_eq!((g[1], g[2], g[3]), (m.encoder_delay.unwrap() as u64, m.end_padding.unwrap() as u64, m.samples), "{what}");
            check_mp3_against(&path, m, &reference, &what);
        }
    }
    let parts: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".part")).collect();
    assert!(parts.is_empty(), "no temp files left behind");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(windows)]
#[test]
fn mp3_render_resamples_rates_the_encoder_cannot_take() {
    if !mp3_encoder() {
        return;
    }
    let mut w = Warnings::default();
    let model = Model::from_project(&sine_project(), &mut w);
    let dir = std::env::temp_dir().join(format!("kse-mp3-rate-{}", std::process::id()));
    for (sr, want) in [(96_000u32, 48_000u32), (88_200, 44_100)] {
        let path = dir.join(format!("sine-{sr}.mp3"));
        let r = run_job(&model, &render_job(&path, "mp3", sr as f64, Some(192.0))).unwrap();
        let m = r.mp3.as_ref().unwrap();
        assert_eq!(m.sample_rate, want);
        assert!((r.duration_sec - 2.0).abs() < 1e-9, "duration of the float render");
        // Reference: the same project rendered at the MP3 rate (a pure tone,
        // so the two renders agree up to the resampler's passband error).
        let wav = dir.join(format!("ref-{want}.wav"));
        run_job(&model, &render_job(&wav, "wav32f", want as f64, None)).unwrap();
        let mut rd = hound::WavReader::open(&wav).unwrap();
        let s: Vec<f32> = rd.samples::<f32>().map(|x| x.unwrap()).collect();
        let reference = vec![s.iter().step_by(2).copied().collect::<Vec<f32>>(), s.iter().skip(1).step_by(2).copied().collect()];
        check_mp3_against(&path, m, &reference, &format!("{sr} Hz -> {want} Hz"));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn mp3_jobs_validate_before_rendering() {
    use crate::render::validate_request;
    let mut w = Warnings::default();
    let model = Model::from_project(&sine_project(), &mut w);
    let dir = std::env::temp_dir().join(format!("kse-mp3-bad-{}", std::process::id()));
    let path = dir.join("bad.mp3");
    for bad in [100.0, 64.0, 320.5, 0.0, -1.0] {
        let e = run_job(&model, &render_job(&path, "mp3", 48_000.0, Some(bad))).unwrap_err();
        assert!(e.starts_with("MP3 bitrate ") && e.ends_with(" kbps is not supported: use 128, 192, 256 or 320"), "{e}");
    }
    assert_eq!(run_job(&model, &render_job(&path, "mp3", 48_000.0, Some(100.0))).unwrap_err(), "MP3 bitrate 100 kbps is not supported: use 128, 192, 256 or 320");
    assert!(!dir.exists(), "nothing was written");
    assert_eq!(validate_request(&render_job(&path, "ogg", 48_000.0, None)).unwrap_err(), "Unknown render format 'ogg' (use wav16, wav24, wav32f or mp3)");
    // The protocol shapes: `mp3Kbps` in (here), `mp3` out (below).
    let job: RenderRequest = serde_json::from_value(json!({ "path": "C:/x.mp3", "scope": { "kind": "song" }, "format": "mp3", "mp3Kbps": 192 })).unwrap();
    assert_eq!((job.format.as_str(), job.mp3_kbps), ("mp3", Some(192.0)));
    let job: RenderRequest = serde_json::from_value(json!({ "path": "C:/x.mp3", "format": "mp3" })).unwrap();
    assert_eq!(job.mp3_kbps, None);
    if !mp3_encoder() {
        let e = validate_request(&render_job(&path, "mp3", 48_000.0, None)).unwrap_err();
        assert_eq!(e, krypt_studio_dsp::mp3::ENCODER_MISSING, "a Windows without the encoder is told so before rendering");
        return;
    }
    assert_eq!(validate_request(&render_job(&path, "mp3", 48_000.0, None)), Ok(()));
    let out = dir.join("ok.mp3");
    let r = run_job(&model, &render_job(&out, "mp3", 48_000.0, None)).unwrap();
    let v = serde_json::to_value(&r).unwrap();
    let mut keys: Vec<&str> = v["mp3"].as_object().unwrap().keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["encoderDelay", "endPadding", "itunSmpb", "kbps", "sampleRate", "samples"]);
    assert_eq!((v["mp3"]["kbps"].as_u64(), v["mp3"]["sampleRate"].as_u64(), v["mp3"]["samples"].as_u64()), (Some(320), Some(48_000), Some(96_000)));
    let wav = run_job(&model, &render_job(&dir.join("x.wav"), "wav16", 48_000.0, None)).unwrap();
    assert!(serde_json::to_value(wav).unwrap().get("mp3").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

// ── Live core (command queue) tests ──────────────────────────────────────

struct Live {
    core: Core,
    tx: rtrb::Producer<Cmd>,
    grx: rtrb::Consumer<Garbage>,
    session: Session,
}

impl Live {
    fn new(p: &Value) -> Live {
        log_take();
        let shared = Arc::new(Shared::new());
        let (mut tx, rx) = rtrb::RingBuffer::new(64);
        let (gtx, grx) = rtrb::RingBuffer::new(1024);
        let core = Core::new(48000.0, shared, Some(rx), Some(gtx), None);
        let mut session = Session::new(test_host(), 48000.0, Arc::new(SampleCache::new()), ".".into(), SampleMode::Sync);
        let mut w = Warnings::default();
        session.model = Model::from_project(p, &mut w);
        session.version = 1;
        let b = session.build(true);
        assert!(tx.push(Cmd::Batch(b)).is_ok());
        Live { core, tx, grx, session }
    }
    fn send(&mut self, c: Cmd) {
        assert!(self.tx.push(c).is_ok());
    }
    fn run(&mut self, frames: usize) -> Vec<f32> {
        let mut buf = vec![0f32; frames * 2];
        let mut done = 0;
        while done < frames {
            let n = 480.min(frames - done);
            self.core.process_interleaved(&mut buf[done * 2..(done + n) * 2], 2);
            done += n;
        }
        while let Ok(g) = self.grx.pop() {
            drop(g);
        }
        buf
    }
    fn tick(&self) -> f64 {
        f64::from_bits(self.core.shared.tick.load(std::sync::atomic::Ordering::Relaxed))
    }
}

#[test]
fn pattern_switch_waits_for_loop_boundary() {
    let mut p = base(120.0, "pattern");
    p["patterns"]["pb"] = json!({ "id": "pb", "name": "B", "color": "#fff", "length": null, "notes": {} });
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "a", 0.0, 240.0, 60);
    add_note(&mut p, "pb", "c1", "b", 0.0, 240.0, 72);
    let mut live = Live::new(&p);
    live.send(Cmd::Play);
    live.run(10_000);
    live.session.model.transport.active_pattern_id = Some("pb".into());
    live.session.version = 2;
    let b = live.session.build(false);
    live.send(Cmd::Batch(b));
    live.run(200_000);
    let o = ons(&log_take());
    assert_eq!(o, vec![(60, 0), (72, 96000), (72, 192000)]);
    assert_eq!(live.core.shared.applied_version.load(std::sync::atomic::Ordering::Relaxed), 2);
}

#[test]
fn song_loop_region_wraps_with_events_on_the_boundary() {
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "a", 960.0, 240.0, 60);
    add_clip(&mut p, "k1", "pattern", 0.0, 3840.0, json!({ "patternId": "pa" }));
    p["transport"]["loop"] = json!({ "enabled": true, "start": 960, "end": 1920 });
    let mut live = Live::new(&p);
    live.send(Cmd::Play);
    live.run(80_000);
    // 0 → 1920 (48000 frames), then [960, 1920) every 24000 frames.
    assert_eq!(ons(&log_take()), vec![(60, 24000), (60, 48000), (60, 72000)]);
    // Without a loop region the whole song (1 bar) loops.
    p["transport"]["loop"]["enabled"] = json!(false);
    let mut live = Live::new(&p);
    live.send(Cmd::Play);
    live.run(130_000);
    assert_eq!(ons(&log_take()), vec![(60, 24000), (60, 120000)]);
}

#[test]
fn transport_stop_pause_locate() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_note(&mut p, "pa", "c1", "a", 0.0, 3000.0, 60);
    let mut live = Live::new(&p);
    live.send(Cmd::Play);
    live.run(9600);
    assert!((live.tick() - 384.0).abs() < 1e-6);
    live.send(Cmd::Pause);
    let out = live.run(480);
    assert!((live.tick() - 384.0).abs() < 1e-6, "pause keeps the position");
    assert!(out.iter().all(|x| *x == 0.0), "pause releases notes");
    live.send(Cmd::Locate(1920.0));
    live.send(Cmd::Play);
    live.run(480);
    assert!((live.tick() - (1920.0 + 480.0 * 0.04)).abs() < 1e-6);
    live.send(Cmd::Stop);
    live.run(480);
    assert_eq!(live.tick(), 0.0);
    assert!(!live.core.is_playing());
    assert!(log_take().iter().any(|r| r.kind == "alloff"));
}

#[test]
fn audition_plays_while_stopped_through_the_chain() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    let mut live = Live::new(&p);
    let slot = live.session.channel_slot("c1").unwrap();
    live.send(Cmd::NoteOn { slot, key: 64, vel: 0.9 });
    let out = live.run(480);
    assert!(near(out[0], DC1, 1e-5));
    live.send(Cmd::AuditionOff);
    let out = live.run(480);
    assert_eq!(out[0], 0.0);
}

#[test]
fn edits_update_params_without_recreating_instances() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.sine", "i1");
    add_slot(&mut p, "i1", "s1", "test.gain", None);
    let mut s = Session::new(test_host(), 48000.0, Arc::new(SampleCache::new()), ".".into(), SampleMode::Sync);
    let mut w = Warnings::default();
    s.model = Model::from_project(&p, &mut w);
    let b1 = s.build(true);
    assert_eq!(b1.instruments.len(), 1);
    assert_eq!(b1.effects.len(), 1);
    let slot = b1.instruments[0].0;
    // Param edit → set_param only.
    s.model.channels.get_mut("c1").unwrap().generator.params.insert("cutoff".into(), 1000.0);
    s.model.inserts.get_mut("i1").unwrap().slots.get_mut("s1").unwrap().params.insert("gain".into(), -6.0);
    let b2 = s.build(false);
    assert!(b2.instruments.is_empty() && b2.effects.is_empty());
    assert_eq!(b2.inst_params, vec![(slot, 1, 1000.0)]);
    assert_eq!(b2.fx_params.len(), 1);
    // Out-of-range values are clamped to the spec.
    s.model.channels.get_mut("c1").unwrap().generator.params.insert("cutoff".into(), 1e9);
    let b3 = s.build(false);
    assert_eq!(b3.inst_params, vec![(slot, 1, 20000.0)]);
    // Voice mode change → set_voice_mode only.
    s.model.channels.get_mut("c1").unwrap().poly.mono = true;
    s.model.channels.get_mut("c1").unwrap().poly.glide_ms = 60.0;
    let b4 = s.build(false);
    assert!(b4.instruments.is_empty());
    assert_eq!(b4.voice, vec![(slot, true, 60.0)]);
    // Generator type change → re-create.
    s.model.channels.get_mut("c1").unwrap().generator.type_id = "test.dc".into();
    let b5 = s.build(false);
    assert_eq!(b5.instruments.len(), 1);
    assert!(b5.instruments[0].1.is_some());
    // Delete → removal.
    s.model.delete_entity("channel", "c1", &mut w);
    let b6 = s.build(false);
    assert_eq!(b6.instruments.len(), 1);
    assert_eq!(b6.instruments[0].0, slot);
    assert!(b6.instruments[0].1.is_none());
}

#[cfg(debug_assertions)]
#[test]
fn audio_path_does_not_allocate() {
    let mut p = beat_json();
    p["transport"]["metronome"] = json!(true);
    // First channel of the fixture (ids are regenerated with the fixture, never hard-code them).
    let first_channel = p["channelOrder"][0].as_str().expect("fixture has channels").to_string();
    let mut live = Live::new(&p);
    let before = assert_no_alloc::violation_count();
    let mut buf = vec![0f32; 480 * 2];
    live.send(Cmd::Play);
    for _ in 0..600 {
        crate::rt::no_alloc(|| live.core.process_interleaved(&mut buf, 2));
    }
    // Apply an edit, locate, audition, pattern mode, stop — all on the "audio thread".
    live.session.model.transport.bpm = 150.0;
    live.session.model.transport.mode = "pattern".into();
    live.session.version = 2;
    let b = live.session.build(false);
    let slot = live.session.channel_slot(&first_channel).unwrap();
    live.send(Cmd::Batch(b));
    live.send(Cmd::Locate(1000.0));
    live.send(Cmd::NoteOn { slot, key: 60, vel: 0.8 });
    for _ in 0..200 {
        crate::rt::no_alloc(|| live.core.process_interleaved(&mut buf, 2));
    }
    live.send(Cmd::Stop);
    crate::rt::no_alloc(|| live.core.process_interleaved(&mut buf, 2));
    assert_eq!(assert_no_alloc::violation_count(), before, "the audio path allocated");
    while let Ok(g) = live.grx.pop() {
        drop(g);
    }
}

#[test]
fn panicking_plugin_constructor_is_contained() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_channel(&mut p, "c2", "test.panic", "i1");
    add_note(&mut p, "pa", "c1", "a", 0.0, 960.0, 60);
    add_note(&mut p, "pa", "c2", "b", 0.0, 960.0, 60);
    let o = render_p(&p, PATTERN, 0.0);
    assert!(near(o.l[100], DC1, 1e-5), "healthy channel still plays");
    assert!(o.warnings.iter().any(|w| w.contains("crashed while loading")), "{:?}", o.warnings);
}

/// Proves the guard behind `audio_path_does_not_allocate` is live.
#[cfg(debug_assertions)]
#[test]
fn alloc_guard_detects_allocations() {
    let before = assert_no_alloc::violation_count();
    crate::rt::no_alloc(|| {
        std::hint::black_box(Vec::<u8>::with_capacity(16));
    });
    assert!(assert_no_alloc::violation_count() > before);
}

// ── Live MIDI input + recording (record.rs / record_hooks.rs) ────────────

use crate::record::{LiveCtlEnds, RecMsg};
use std::sync::atomic::Ordering::Relaxed as LiveRelaxed;

const MS: u64 = 1_000_000;

fn attach_live(live: &mut Live) -> LiveCtlEnds {
    crate::midi::init_clock();
    let (rt, ctl) = crate::record::live_channels(live.core.shared.live.clone());
    live.core.live.attach(rt);
    ctl
}

/// Deliver MIDI bytes as if they arrived at `t_ns` (engine clock).
fn midi_at(ctl: &LiveCtlEnds, t_ns: u64, bytes: &[u8]) {
    let dev: Arc<str> = Arc::from("test");
    let mut rs = 0;
    ctl.sink.feed_at(t_ns, &dev, bytes, &mut rs);
}

fn rec_msgs(ctl: &mut LiveCtlEnds) -> Vec<RecMsg> {
    let mut v = Vec::new();
    while let Ok(m) = ctl.rec_rx.pop() {
        v.push(m);
    }
    v
}

#[test]
fn live_midi_plays_the_target_channel_sample_accurately() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_channel(&mut p, "c2", "test.dc", "i1");
    let mut live = Live::new(&p);
    let ctl = attach_live(&mut live);
    let s1 = live.session.channel_slot("c1").unwrap();
    let s2 = live.session.channel_slot("c2").unwrap();
    live.core.shared.live.target_slot.store(s1, LiveRelaxed);
    live.run(480);
    log_take();
    // 5 ms and 6 ms after the previous block started → frames 240 / 288 of the next block.
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + 5 * MS, &[0x90, 64, 100]);
    midi_at(&ctl, t + 6 * MS, &[0x80, 64, 0]);
    let out = live.run(480);
    let evs: Vec<(&str, u8, u64)> = log_take().iter().map(|r| (r.kind, r.key, r.frame)).collect();
    assert_eq!(evs, vec![("on", 64, 720), ("off", 64, 768)]);
    assert!(near(out[2 * 250], DC1, 1e-5), "sounds while held");
    assert_eq!(out[2 * 230], 0.0);
    assert_eq!(out[2 * 300], 0.0);
    // Retarget while a key is held: the note-off still reaches the first channel.
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + MS, &[0x90, 67, 90]);
    live.run(480);
    live.core.shared.live.target_slot.store(s2, LiveRelaxed);
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + MS, &[0x80, 67, 0, 0x90, 69, 90]);
    live.run(480);
    let log = log_take();
    let first = log.iter().find(|r| r.kind == "on" && r.key == 67).unwrap().inst;
    assert!(log.iter().any(|r| r.kind == "off" && r.key == 67 && r.inst == first));
    assert!(log.iter().any(|r| r.kind == "on" && r.key == 69 && r.inst != first), "new notes follow the new target");
    // No target → nothing plays.
    live.core.shared.live.target_slot.store(crate::program::NONE, LiveRelaxed);
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + MS, &[0x90, 65, 100]);
    live.run(480);
    assert!(!log_take().iter().any(|r| r.kind == "on"));
}

#[test]
fn sustain_pedal_defers_note_offs() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    let mut live = Live::new(&p);
    let ctl = attach_live(&mut live);
    live.core.shared.live.target_slot.store(live.session.channel_slot("c1").unwrap(), LiveRelaxed);
    live.run(480);
    log_take();
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + MS, &[0xB0, 64, 127]); // pedal down
    midi_at(&ctl, t + 2 * MS, &[0x90, 60, 100]);
    midi_at(&ctl, t + 3 * MS, &[0x80, 60, 0]); // held by the pedal
    live.run(480);
    assert!(!log_take().iter().any(|r| r.kind == "off"));
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + 5 * MS, &[0xB0, 64, 0]); // pedal up → release at frame 240
    live.run(480);
    let offs: Vec<u64> = log_take().iter().filter(|r| r.kind == "off").map(|r| r.frame).collect();
    assert_eq!(offs, vec![960 + 240]);
}

#[test]
fn records_pattern_notes_with_latency_compensation_and_loop_reports() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    let mut live = Live::new(&p);
    let mut ctl = attach_live(&mut live);
    let slot = live.session.channel_slot("c1").unwrap();
    let l = live.core.shared.live.clone();
    l.target_slot.store(slot, LiveRelaxed);
    l.armed.store(true, LiveRelaxed);
    live.send(Cmd::Play);
    live.run(4800);
    assert_eq!(l.state.load(LiveRelaxed), crate::record::STATE_RECORDING);
    // 120 bpm @ 48 kHz = 0.04 ticks/frame. Latency = one 480-frame block (+0 output
    // latency in tests) = 19.2 ticks. Note-on at frame 5040 (tick 201.6) → 182.4.
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + 5 * MS, &[0x90, 60, 127]);
    live.run(480);
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + 5 * MS, &[0x80, 60, 0]); // frame 5520 → 19.2 ticks long
    live.run(480);
    // Run up to the loop end (1 bar = 96000 frames). A note right on the downbeat of
    // pass 2 was heard (compensated) 19.2 ticks before the end of pass 1.
    live.run(96000 - 5760);
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t, &[0x90, 61, 64]); // offset 0 of the next block = frame 96000
    live.run(480);
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + 2_500_000, &[0x80, 61, 0, 0x90, 62, 127]); // frame 96600 (tick 24.0 → 4.8)
    live.run(480);
    live.send(Cmd::Stop); // processed at frame 96960: 62 is still held
    live.run(480);
    let msgs = rec_msgs(&mut ctl);
    let near64 = |a: f64, b: f64| (a - b).abs() < 1e-6;
    match msgs.first() {
        Some(RecMsg::Start { take: 1, song: false, start_tick, pattern_slot, midi: true, audio: false }) => {
            assert!(near64(*start_tick, 0.0));
            assert_ne!(*pattern_slot, crate::program::NONE);
        }
        other => panic!("expected Start, got {other:?}"),
    }
    let notes: Vec<(u8, f64, f64, f32)> = msgs
        .iter()
        .filter_map(|m| match m {
            RecMsg::Note { key, tick, dur, vel, slot: s, .. } => {
                assert_eq!(*s, slot);
                Some((*key, *tick, *dur, *vel))
            }
            _ => None,
        })
        .collect();
    assert_eq!(notes.len(), 3, "{msgs:?}");
    assert!(notes[0].0 == 60 && near64(notes[0].1, 182.4) && near64(notes[0].2, 19.2) && notes[0].3 == 1.0, "{:?}", notes[0]);
    assert!(notes[1].0 == 61 && near64(notes[1].1, 3820.8) && near64(notes[1].2, 24.0), "{:?}", notes[1]);
    assert!(notes[2].0 == 62 && near64(notes[2].1, 4.8) && near64(notes[2].2, 14.4), "closed at stop: {:?}", notes[2]);
    let wrap_at = msgs.iter().position(|m| matches!(m, RecMsg::Wrap { take: 1, .. })).expect("loop reported");
    let n61_at = msgs.iter().position(|m| matches!(m, RecMsg::Note { key: 61, .. })).unwrap();
    assert!(wrap_at < n61_at, "pass 1 is reported before the notes of pass 2");
    assert!(matches!(msgs.last(), Some(RecMsg::End { take: 1, .. })));
    assert_eq!(l.state.load(LiveRelaxed), crate::record::STATE_IDLE);
    // Disarmed: playing doesn't record.
    l.armed.store(false, LiveRelaxed);
    live.send(Cmd::Play);
    live.run(4800);
    assert!(rec_msgs(&mut ctl).is_empty());
}

#[test]
fn count_in_clicks_then_starts_the_take() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    let mut live = Live::new(&p);
    let mut ctl = attach_live(&mut live);
    let l = live.core.shared.live.clone();
    l.armed.store(true, LiveRelaxed);
    l.count_in_bars.store(1, LiveRelaxed);
    live.send(Cmd::Play);
    let out = live.run(48000);
    assert!(!live.core.is_playing(), "counting in, not playing yet");
    assert_eq!(l.state.load(LiveRelaxed), crate::record::STATE_COUNT_IN);
    assert_eq!(l.count_in_beats.load(LiveRelaxed), 2);
    assert!(out[..200].iter().any(|x| x.abs() > 0.05), "accent click on beat 1");
    assert!(out[2 * 24000..2 * 24100].iter().any(|x| x.abs() > 0.05), "click on beat 2");
    assert!(out[2 * 12000..2 * 12100].iter().all(|x| *x == 0.0));
    assert!(live.tick() == 0.0 && rec_msgs(&mut ctl).is_empty());
    live.run(48000);
    live.run(480);
    assert!(live.core.is_playing());
    assert!((live.tick() - 19.2).abs() < 1e-9, "starts exactly at the end of the count-in: {}", live.tick());
    assert!(matches!(rec_msgs(&mut ctl).first(), Some(RecMsg::Start { start_tick, .. }) if *start_tick == 0.0));
    // Stop during a count-in cancels it.
    live.send(Cmd::Stop);
    live.run(480);
    live.send(Cmd::Play);
    live.run(4800);
    live.send(Cmd::Stop);
    live.run(480);
    assert!(!live.core.is_playing());
    assert_eq!(l.state.load(LiveRelaxed), crate::record::STATE_IDLE);
    live.send(Cmd::Play);
    live.run(480);
    assert_eq!(l.state.load(LiveRelaxed), crate::record::STATE_COUNT_IN, "a new play counts in again");
}

#[test]
fn armed_song_mode_plays_past_the_song_end() {
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    let mut live = Live::new(&p);
    let mut ctl = attach_live(&mut live);
    live.core.shared.live.armed.store(true, LiveRelaxed);
    live.send(Cmd::Play);
    live.run(192_000);
    assert!((live.tick() - 7680.0).abs() < 1e-6, "an empty song loops after a bar unless recording: {}", live.tick());
    live.send(Cmd::Stop);
    live.run(480);
    assert!(matches!(rec_msgs(&mut ctl).first(), Some(RecMsg::Start { song: true, .. })));
    live.core.shared.live.armed.store(false, LiveRelaxed);
    live.send(Cmd::Play);
    live.run(192_000);
    assert!(live.tick() < 3840.0);
}

/// Takes (docs/ENGINE_PROTOCOL.md §13): song-mode loop recording reports each
/// pass boundary (loop region + heard seconds) and tags every note with its pass.
#[test]
fn song_loop_recording_reports_passes() {
    let mut p = base(120.0, "song");
    p["transport"]["loop"] = json!({ "enabled": true, "start": 0, "end": 3840 });
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    let mut live = Live::new(&p);
    let mut ctl = attach_live(&mut live);
    let l = live.core.shared.live.clone();
    l.target_slot.store(live.session.channel_slot("c1").unwrap(), LiveRelaxed);
    l.armed.store(true, LiveRelaxed);
    live.send(Cmd::Play);
    live.run(4800);
    // Pass 0: a note at ~frame 5000.
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + MS, &[0x90, 60, 100]);
    live.run(480);
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + MS, &[0x80, 60, 0]);
    live.run(480);
    // Into pass 1 (the loop is 96000 frames), then a note there.
    live.run(96000);
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + MS, &[0x90, 64, 100]);
    live.run(480);
    let t = live.core.live.block_t_ns;
    midi_at(&ctl, t + MS, &[0x80, 64, 0]);
    live.run(480);
    // Into pass 2, then stop.
    live.run(96000);
    live.send(Cmd::Stop);
    live.run(480);
    let msgs = rec_msgs(&mut ctl);
    let wraps: Vec<(f64, f64, f64)> = msgs.iter().filter_map(|m| match m { RecMsg::Wrap { sec, lo, hi, .. } => Some((*sec, *lo, *hi)), _ => None }).collect();
    assert_eq!(wraps.len(), 2, "{msgs:?}");
    assert!(wraps.iter().all(|w| w.1 == 0.0 && w.2 == 3840.0));
    // `sec` is heard (wall-clock) time; tests run blocks faster than real time, so only its sign is checked here.
    assert!(wraps.iter().all(|w| w.0.is_finite() && w.0 >= 0.0), "{wraps:?}");
    let passes: Vec<(u8, u32)> = msgs.iter().filter_map(|m| match m { RecMsg::Note { key, pass, .. } => Some((*key, *pass)), _ => None }).collect();
    assert_eq!(passes, vec![(60, 0), (64, 1)]);
    match msgs.last() {
        Some(RecMsg::End { sec, .. }) => assert!(sec.is_finite() && *sec >= 0.0),
        other => panic!("expected End, got {other:?}"),
    }
}

/// Input monitoring: what the input thread pushes reaches the output, transport stopped, and
/// stops when monitoring is turned off.
#[test]
fn live_monitor_reaches_the_output_while_stopped() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    let mut live = Live::new(&p);
    let mut ctl = attach_live(&mut live);
    let l = live.core.shared.live.clone();
    let mut buf = vec![0f32; 256 * 2];
    let mut loudest = |live: &mut Live, ctl: &mut LiveCtlEnds, on: bool| -> f32 {
        l.monitor.store(on, LiveRelaxed);
        let mut peak = 0f32;
        // ~0.5 s: the input thread delivers 480-frame packets (10 ms), the output pulls 256-frame blocks.
        let mut queued = 0usize;
        for _ in 0..94 {
            while queued < 256 * 3 {
                for _ in 0..480 {
                    let _ = ctl.mon_tx.push(0.25);
                    let _ = ctl.mon_tx.push(0.25);
                }
                queued += 480;
            }
            buf.fill(0.0);
            live.core.process_interleaved(&mut buf, 2);
            queued -= 256;
            peak = buf.iter().fold(peak, |m, v| m.max(v.abs()));
        }
        peak
    };
    let on = loudest(&mut live, &mut ctl, true);
    assert!(on > 0.1, "monitored input never reached the output (peak {on})");
    let off = loudest(&mut live, &mut ctl, false);
    assert!(off < 1e-6, "monitoring off still plays the input (peak {off})");
}

#[cfg(debug_assertions)]
#[test]
fn live_input_path_does_not_allocate() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.sine", "i1");
    p["transport"]["metronome"] = json!(true);
    let mut live = Live::new(&p);
    let mut ctl = attach_live(&mut live);
    let l = live.core.shared.live.clone();
    l.target_slot.store(live.session.channel_slot("c1").unwrap(), LiveRelaxed);
    l.armed.store(true, LiveRelaxed);
    l.count_in_bars.store(1, LiveRelaxed);
    l.monitor.store(true, LiveRelaxed);
    let mut buf = vec![0f32; 480 * 2];
    crate::rt::no_alloc(|| live.core.process_interleaved(&mut buf, 2));
    let before = assert_no_alloc::violation_count();
    live.send(Cmd::Play);
    for i in 0..600u64 {
        let t = live.core.live.block_t_ns;
        if i % 7 == 0 {
            midi_at(&ctl, t + MS, &[0x90, (48 + i % 24) as u8, 100, 0xB0, 64, if i % 2 == 0 { 127 } else { 0 }]);
        }
        if i % 7 == 3 {
            midi_at(&ctl, t + 2 * MS, &[0x80, (48 + (i - 3) % 24) as u8, 0]);
        }
        for _ in 0..240 {
            let _ = ctl.mon_tx.push(0.01);
        }
        crate::rt::no_alloc(|| live.core.process_interleaved(&mut buf, 2));
        if i % 50 == 0 {
            rec_msgs(&mut ctl);
        }
    }
    live.send(Cmd::Stop);
    crate::rt::no_alloc(|| live.core.process_interleaved(&mut buf, 2));
    assert_eq!(assert_no_alloc::violation_count(), before, "the live input path allocated");
    assert!(rec_msgs(&mut ctl).iter().any(|m| matches!(m, RecMsg::End { .. })));
    while let Ok(g) = live.grx.pop() {
        drop(g);
    }
}

// Audio-clip time-stretch / pitch-shift through the whole engine (variants.rs).
#[path = "tests_stretch.rs"]
mod stretch;

// Stem export: one pass, post-fader taps per insert plus Master (render.rs).
#[path = "tests_stems.rs"]
mod stems;

// Racks and macros: zones, chokes, FX-rack sums, macro maps, edits (rack.rs).
#[path = "tests_rack.rs"]
mod rack;

// Wave 12.2b rack-plus: automation of inner rack params, macro vs automation, instrument PDC.
#[path = "tests_rack_plus.rs"]
mod rack_plus;

// Clip launcher: quantize, follow actions, modes, override, launch recording, grid (launcher.rs).
#[path = "tests_launcher.rs"]
mod launcher_tests;

// Wave 12.2b meters: gain reduction, watched-slot taps, render GR stats (meters.rs).
#[path = "tests_meters.rs"]
mod meters_tests;

// MIDI clock out + external sync through the live core (clock.rs, clock_hooks.rs).
#[path = "tests_clock.rs"]
mod clock_tests;
