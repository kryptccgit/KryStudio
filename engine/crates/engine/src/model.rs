//! The engine's mirror of the Project document (shared/schema/project.ts).
//!
//! Parsing is deliberately liberal: every entity is deserialized on its own,
//! with `#[serde(default)]` everywhere, so one malformed note / clip / slot is
//! skipped with a warning instead of rejecting the whole project
//! (docs/ENGINE_PROTOCOL.md §1: never crash on bad project data).

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub use crate::model_ext::{FollowRule, LaunchClip, RackDef, Scene, SessionCfg, SliceMarker, WarpMap};

// ── Entities ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TimeSig {
    pub num: f64,
    pub den: f64,
}

impl Default for TimeSig {
    fn default() -> Self {
        Self { num: 4.0, den: 4.0 }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LoopRegion {
    pub enabled: bool,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Transport {
    pub bpm: f64,
    pub time_sig: TimeSig,
    pub swing: f64,
    /// 'pattern' | 'song'
    pub mode: String,
    pub active_pattern_id: Option<String>,
    #[serde(rename = "loop")]
    pub loop_region: LoopRegion,
    pub metronome: bool,
    pub master_volume: f64,
}

impl Default for Transport {
    fn default() -> Self {
        Self {
            bpm: 140.0,
            time_sig: TimeSig::default(),
            swing: 0.0,
            mode: "pattern".into(),
            active_pattern_id: None,
            loop_region: LoopRegion::default(),
            metronome: false,
            master_volume: 1.0,
        }
    }
}

impl Transport {
    pub fn song_mode(&self) -> bool {
        self.mode == "song"
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Generator {
    #[serde(rename = "type")]
    pub type_id: String,
    #[serde(deserialize_with = "de_num_map")]
    pub params: BTreeMap<String, f64>,
    pub sample_id: Option<String>,
    /// Opaque third-party plugin state (base64), restored when the remote instance loads.
    pub state: Option<String>,
    /// 'krypt.audioclip': warp markers + mode (Wave 12.2). None = Stretch params only.
    pub warp: Option<WarpMap>,
    /// 'krypt.rack' / 'krypt.drumrack': chains + macros (Wave 12.2).
    pub rack: Option<Box<RackDef>>,
    /// 'krypt.slicer': the slice markers (sorted by sec). None / empty = the whole sample is one slice.
    pub slices: Option<Vec<SliceMarker>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Poly {
    pub mono: bool,
    pub glide_ms: f64,
    pub cut_group: f64,
    pub cut_by: f64,
}

impl Default for Poly {
    fn default() -> Self {
        Self { mono: false, glide_ms: 0.0, cut_group: 0.0, cut_by: 0.0 }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Channel {
    pub id: String,
    pub generator: Generator,
    pub volume: f64,
    pub pan: f64,
    pub pitch: f64,
    pub mute: bool,
    pub insert_id: String,
    pub root_key: f64,
    pub swing: f64,
    pub poly: Poly,
}

impl Default for Channel {
    fn default() -> Self {
        Self {
            id: String::new(),
            generator: Generator::default(),
            volume: 0.78,
            pan: 0.0,
            pitch: 0.0,
            mute: false,
            insert_id: String::new(),
            root_key: 60.0,
            swing: 1.0,
            poly: Poly::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Note {
    pub id: String,
    pub tick: f64,
    pub dur: f64,
    pub key: f64,
    pub vel: f64,
    pub pan: f64,
    pub release: f64,
    pub fine: f64,
    pub slide: bool,
    pub mod_x: f64,
    pub mod_y: f64,
    /// Wave 2 (piano-roll mute tool): optional `mute` on a note. Muted notes stay in
    /// the document but are never scheduled (skipped in compile.rs). Absent = false.
    pub mute: bool,
}

impl Default for Note {
    fn default() -> Self {
        Self {
            id: String::new(),
            tick: 0.0,
            dur: 240.0,
            key: 60.0,
            vel: 0.78,
            pan: 0.0,
            release: 0.5,
            fine: 0.0,
            slide: false,
            mod_x: 0.5,
            mod_y: 0.5,
            mute: false,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Pattern {
    pub id: String,
    /// None (or <= 0) = auto length.
    pub length: Option<f64>,
    /// notes[channelId] = notes (unsorted).
    pub notes: BTreeMap<String, Vec<Note>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Track {
    pub id: String,
    pub mute: bool,
    pub solo: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Clip {
    pub id: String,
    pub track_id: String,
    /// 'pattern' | 'audio' | 'automation'
    pub kind: String,
    pub start: f64,
    pub length: f64,
    pub offset: f64,
    pub mute: bool,
    pub pattern_id: Option<String>,
    pub channel_id: Option<String>,
    pub automation_id: Option<String>,
    pub gain: Option<f64>,
    pub fade_in: Option<f64>,
    pub fade_out: Option<f64>,
}

impl Default for Clip {
    fn default() -> Self {
        Self {
            id: String::new(),
            track_id: String::new(),
            kind: String::new(),
            start: 0.0,
            length: 1.0,
            offset: 0.0,
            mute: false,
            pattern_id: None,
            channel_id: None,
            automation_id: None,
            gain: None,
            fade_in: None,
            fade_out: None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutomationPoint {
    pub id: String,
    pub tick: f64,
    pub value: f64,
    pub tension: f64,
}

#[derive(Debug, Clone, Default)]
pub struct Automation {
    pub id: String,
    pub target: Option<String>,
    pub points: Vec<AutomationPoint>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FxSlot {
    pub id: String,
    #[serde(rename = "type")]
    pub type_id: String,
    pub enabled: bool,
    pub mix: f64,
    #[serde(deserialize_with = "de_num_map")]
    pub params: BTreeMap<String, f64>,
    pub sidechain_from: Option<String>,
    /// Opaque third-party plugin state (base64), restored when the remote instance loads.
    pub state: Option<String>,
    /// 'krypt.fxrack': parallel chains + macros (Wave 12.2).
    pub rack: Option<Box<RackDef>>,
}

impl Default for FxSlot {
    fn default() -> Self {
        Self {
            id: String::new(),
            type_id: String::new(),
            enabled: true,
            mix: 1.0,
            params: BTreeMap::new(),
            sidechain_from: None,
            state: None,
            rack: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Insert {
    pub id: String,
    /// Display name (stem file names).
    pub name: String,
    pub volume: f64,
    pub pan: f64,
    pub stereo_sep: f64,
    pub mute: bool,
    pub solo: bool,
    pub phase_invert: bool,
    pub swap_lr: bool,
    pub slots: BTreeMap<String, FxSlot>,
    pub slot_order: Vec<String>,
    pub routes: BTreeMap<String, f64>,
    pub is_master: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct InsertRaw {
    id: String,
    name: String,
    volume: f64,
    pan: f64,
    stereo_sep: f64,
    mute: bool,
    solo: bool,
    phase_invert: bool,
    #[serde(rename = "swapLR", alias = "swapLr")]
    swap_lr: bool,
    slots: Map<String, Value>,
    slot_order: Vec<String>,
    #[serde(deserialize_with = "de_num_map")]
    routes: BTreeMap<String, f64>,
    is_master: bool,
}

impl Default for InsertRaw {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            volume: 1.0,
            pan: 0.0,
            stereo_sep: 0.0,
            mute: false,
            solo: false,
            phase_invert: false,
            swap_lr: false,
            slots: Map::new(),
            slot_order: Vec::new(),
            routes: BTreeMap::new(),
            is_master: false,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SampleRef {
    pub id: String,
    pub path: String,
}

// ── The mirror ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct Model {
    pub transport: Transport,
    pub channels: BTreeMap<String, Channel>,
    pub patterns: BTreeMap<String, Pattern>,
    pub tracks: BTreeMap<String, Track>,
    pub clips: BTreeMap<String, Clip>,
    pub automations: BTreeMap<String, Automation>,
    pub inserts: BTreeMap<String, Insert>,
    /// Display order of inserts (master first). Only used for deterministic
    /// graph edge ordering; inserts missing from it are appended.
    pub insert_order: Vec<String>,
    pub master_id: String,
    pub samples: BTreeMap<String, SampleRef>,
    /// Clip launcher (Wave 12.2): scenes, launch clips and the session settings.
    pub scenes: BTreeMap<String, Scene>,
    pub launch_clips: BTreeMap<String, LaunchClip>,
    pub session: SessionCfg,
}

/// Collects warnings while parsing, capped so a corrupt project can't flood the log.
#[derive(Default)]
pub struct Warnings {
    pub list: Vec<String>,
    pub dropped: usize,
}

impl Warnings {
    pub fn push(&mut self, msg: String) {
        if self.list.len() < 20 {
            self.list.push(msg);
        } else {
            self.dropped += 1;
        }
    }
    pub fn drain_messages(&mut self) -> Vec<String> {
        let mut v = std::mem::take(&mut self.list);
        if self.dropped > 0 {
            v.push(format!("…and {} more project data warnings", self.dropped));
            self.dropped = 0;
        }
        v
    }
}

fn parse<T: DeserializeOwned>(what: &str, id: &str, v: &Value, w: &mut Warnings) -> Option<T> {
    match T::deserialize(v) {
        Ok(t) => Some(t),
        Err(e) => {
            w.push(format!("Skipped invalid {what} {id}: {e}"));
            None
        }
    }
}

fn obj<'a>(v: &'a Value, key: &str) -> Option<&'a Map<String, Value>> {
    v.get(key).and_then(|x| x.as_object())
}

/// Deserialize a JSON object of numbers, ignoring non-numeric values.
fn de_num_map<'de, D: serde::Deserializer<'de>>(d: D) -> Result<BTreeMap<String, f64>, D::Error> {
    let m = Option::<Map<String, Value>>::deserialize(d)?.unwrap_or_default();
    Ok(m.into_iter().filter_map(|(k, v)| v.as_f64().map(|x| (k, x))).collect())
}

fn parse_pattern(id: &str, v: &Value, w: &mut Warnings) -> Option<Pattern> {
    if !v.is_object() {
        w.push(format!("Skipped invalid pattern {id}: not an object"));
        return None;
    }
    let length = v.get("length").and_then(|x| x.as_f64()).filter(|x| *x > 0.0);
    let mut notes = BTreeMap::new();
    if let Some(by_ch) = obj(v, "notes") {
        for (ch, list) in by_ch {
            let mut out = Vec::new();
            if let Some(m) = list.as_object() {
                for (nid, nv) in m {
                    if let Some(mut n) = parse::<Note>("note", nid, nv, w) {
                        if n.id.is_empty() {
                            n.id = nid.clone();
                        }
                        if n.tick.is_finite() && n.dur.is_finite() && n.key.is_finite() {
                            out.push(n);
                        } else {
                            w.push(format!("Skipped note {nid} with non-finite values"));
                        }
                    }
                }
            }
            notes.insert(ch.clone(), out);
        }
    }
    Some(Pattern { id: id.to_string(), length, notes })
}

fn parse_automation(id: &str, v: &Value, w: &mut Warnings) -> Option<Automation> {
    if !v.is_object() {
        w.push(format!("Skipped invalid automation {id}: not an object"));
        return None;
    }
    let target = v.get("target").and_then(|x| x.as_str()).map(|s| s.to_string());
    let mut points = Vec::new();
    if let Some(m) = obj(v, "points") {
        for (pid, pv) in m {
            if let Some(mut p) = parse::<AutomationPoint>("automation point", pid, pv, w) {
                if p.id.is_empty() {
                    p.id = pid.clone();
                }
                if p.tick.is_finite() && p.value.is_finite() && p.tension.is_finite() {
                    points.push(p);
                }
            }
        }
    }
    Some(Automation { id: id.to_string(), target, points })
}

fn parse_insert(id: &str, v: &Value, w: &mut Warnings) -> Option<Insert> {
    let raw: InsertRaw = parse("mixer insert", id, v, w)?;
    let mut slots = BTreeMap::new();
    for (sid, sv) in &raw.slots {
        if let Some(mut s) = parse::<FxSlot>("FX slot", sid, sv, w) {
            if s.id.is_empty() {
                s.id = sid.clone();
            }
            slots.insert(sid.clone(), s);
        }
    }
    Some(Insert {
        id: id.to_string(),
        name: raw.name,
        volume: raw.volume,
        pan: raw.pan,
        stereo_sep: raw.stereo_sep,
        mute: raw.mute,
        solo: raw.solo,
        phase_invert: raw.phase_invert,
        swap_lr: raw.swap_lr,
        slots,
        slot_order: raw.slot_order,
        routes: raw.routes,
        is_master: raw.is_master,
    })
}

impl Model {
    /// Build from a full Project JSON value (loadProject / --render).
    pub fn from_project(v: &Value, w: &mut Warnings) -> Model {
        let mut m = Model::default();
        if let Some(t) = v.get("transport") {
            if let Some(t) = parse::<Transport>("transport", "", t, w) {
                m.transport = t;
            }
        }
        if let Some(chs) = obj(v, "channels") {
            for (id, cv) in chs {
                m.upsert_entity("channel", id, cv, w);
            }
        }
        if let Some(ps) = obj(v, "patterns") {
            for (id, pv) in ps {
                m.upsert_entity("pattern", id, pv, w);
            }
        }
        if let Some(pl) = v.get("playlist") {
            if let Some(ts) = obj(pl, "tracks") {
                for (id, tv) in ts {
                    m.upsert_entity("track", id, tv, w);
                }
            }
            if let Some(cs) = obj(pl, "clips") {
                for (id, cv) in cs {
                    m.upsert_entity("clip", id, cv, w);
                }
            }
        }
        if let Some(a) = obj(v, "automations") {
            for (id, av) in a {
                m.upsert_entity("automation", id, av, w);
            }
        }
        if let Some(mx) = v.get("mixer") {
            if let Some(ins) = obj(mx, "inserts") {
                for (id, iv) in ins {
                    m.upsert_entity("insert", id, iv, w);
                }
            }
            if let Some(order) = mx.get("insertOrder").and_then(|o| o.as_array()) {
                m.insert_order = order.iter().filter_map(|x| x.as_str().map(String::from)).collect();
            }
            if let Some(mid) = mx.get("masterId").and_then(|x| x.as_str()) {
                m.master_id = mid.to_string();
            }
        }
        if let Some(s) = obj(v, "samples") {
            for (id, sv) in s {
                m.upsert_entity("sample", id, sv, w);
            }
        }
        if let Some(sess) = v.get("session") {
            if let Some(sc) = obj(sess, "scenes") {
                for (id, sv) in sc {
                    m.upsert_entity("scene", id, sv, w);
                }
            }
            if let Some(cs) = obj(sess, "clips") {
                for (id, cv) in cs {
                    m.upsert_entity("launchClip", id, cv, w);
                }
            }
            let mut cfg = Map::new();
            for k in ["quantize", "sceneOrder"] {
                if let Some(x) = sess.get(k) {
                    cfg.insert(k.to_string(), x.clone());
                }
            }
            m.upsert_entity("session", "", &Value::Object(cfg), w);
        }
        if m.master_id.is_empty() {
            if let Some(i) = m.inserts.values().find(|i| i.is_master) {
                m.master_id = i.id.clone();
            }
        }
        m
    }

    /// Apply one entity upsert. `id` may be empty for singletons.
    pub fn upsert_entity(&mut self, kind: &str, id: &str, v: &Value, w: &mut Warnings) {
        let pick_id = |own: &str| if id.is_empty() { own.to_string() } else { id.to_string() };
        match kind {
            "transport" => {
                if let Some(t) = parse::<Transport>("transport", "", v, w) {
                    self.transport = t;
                }
            }
            "mixer" => {
                if let Some(mid) = v.get("masterId").and_then(|x| x.as_str()) {
                    self.master_id = mid.to_string();
                }
            }
            "channel" => {
                if let Some(mut c) = parse::<Channel>("channel", id, v, w) {
                    c.id = pick_id(&c.id);
                    if c.id.is_empty() {
                        w.push("Skipped channel without id".into());
                        return;
                    }
                    self.channels.insert(c.id.clone(), c);
                }
            }
            "pattern" => {
                let own = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
                let pid = pick_id(own);
                if pid.is_empty() {
                    w.push("Skipped pattern without id".into());
                    return;
                }
                if let Some(p) = parse_pattern(&pid, v, w) {
                    self.patterns.insert(pid, p);
                }
            }
            "track" => {
                if let Some(mut t) = parse::<Track>("track", id, v, w) {
                    t.id = pick_id(&t.id);
                    if !t.id.is_empty() {
                        self.tracks.insert(t.id.clone(), t);
                    }
                }
            }
            "clip" => {
                if let Some(mut c) = parse::<Clip>("clip", id, v, w) {
                    c.id = pick_id(&c.id);
                    if c.id.is_empty() {
                        return;
                    }
                    if !(c.start.is_finite() && c.length.is_finite() && c.offset.is_finite()) {
                        w.push(format!("Skipped clip {} with non-finite timing", c.id));
                        return;
                    }
                    self.clips.insert(c.id.clone(), c);
                }
            }
            "automation" => {
                let own = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
                let aid = pick_id(own);
                if aid.is_empty() {
                    return;
                }
                if let Some(a) = parse_automation(&aid, v, w) {
                    self.automations.insert(aid, a);
                }
            }
            "insert" => {
                let own = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
                let iid = pick_id(own);
                if iid.is_empty() {
                    return;
                }
                if let Some(i) = parse_insert(&iid, v, w) {
                    if !self.insert_order.iter().any(|x| x == &iid) {
                        self.insert_order.push(iid.clone());
                    }
                    self.inserts.insert(iid, i);
                }
            }
            "sample" => {
                if let Some(mut s) = parse::<SampleRef>("sample", id, v, w) {
                    s.id = pick_id(&s.id);
                    if !s.id.is_empty() {
                        self.samples.insert(s.id.clone(), s);
                    }
                }
            }
            "scene" => {
                if let Some(mut sc) = parse::<Scene>("scene", id, v, w) {
                    sc.id = pick_id(&sc.id);
                    if !sc.id.is_empty() {
                        self.scenes.insert(sc.id.clone(), sc);
                    }
                }
            }
            "launchClip" => {
                if let Some(mut c) = parse::<LaunchClip>("launch clip", id, v, w) {
                    c.id = pick_id(&c.id);
                    if c.id.is_empty() {
                        return;
                    }
                    if !(c.length.is_finite() && c.length >= 1.0 && c.offset.is_finite()) {
                        w.push(format!("Skipped launch clip {} with bad timing", c.id));
                        return;
                    }
                    self.launch_clips.insert(c.id.clone(), c);
                }
            }
            "session" => {
                if let Some(cfg) = parse::<SessionCfg>("session", "", v, w) {
                    if let Some(ids) = &cfg.clip_ids {
                        self.launch_clips.retain(|k, _| ids.contains(k));
                    }
                    self.scenes.retain(|k, _| cfg.scene_order.contains(k));
                    self.session = cfg;
                }
            }
            other => w.push(format!("Ignored upsert of unknown entity kind '{other}'")),
        }
    }

    pub fn delete_entity(&mut self, kind: &str, id: &str, w: &mut Warnings) {
        match kind {
            "channel" => {
                self.channels.remove(id);
            }
            "pattern" => {
                self.patterns.remove(id);
            }
            "track" => {
                self.tracks.remove(id);
            }
            "clip" => {
                self.clips.remove(id);
            }
            "automation" => {
                self.automations.remove(id);
            }
            "insert" => {
                self.inserts.remove(id);
                self.insert_order.retain(|x| x != id);
            }
            "sample" => {
                self.samples.remove(id);
            }
            "scene" => {
                self.scenes.remove(id);
            }
            "launchClip" => {
                self.launch_clips.remove(id);
            }
            "transport" | "mixer" | "session" => {}
            other => w.push(format!("Ignored delete of unknown entity kind '{other}'")),
        }
    }

    /// Inserts in deterministic order: insert_order first, then any others by id.
    pub fn ordered_insert_ids(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::with_capacity(self.inserts.len());
        for id in &self.insert_order {
            if self.inserts.contains_key(id) && !out.contains(id) {
                out.push(id.clone());
            }
        }
        for id in self.inserts.keys() {
            if !out.contains(id) {
                out.push(id.clone());
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liberal_parsing_skips_bad_entities() {
        let v: Value = serde_json::json!({
            "transport": { "bpm": 120, "mode": "song" },
            "channels": {
                "a": { "id": "a", "generator": { "type": "x", "params": { "p": 1, "bad": "str" } } },
                "b": { "id": "b", "volume": "loud" }
            },
            "patterns": { "p1": { "id": "p1", "length": null, "notes": { "a": {
                "n1": { "id": "n1", "tick": 0, "key": 60 },
                "n2": { "id": "n2", "tick": "x" }
            } } } },
            "mixer": { "inserts": { "m": { "id": "m", "isMaster": true, "swapLR": true } }, "insertOrder": ["m"], "masterId": "m" }
        });
        let mut w = Warnings::default();
        let m = Model::from_project(&v, &mut w);
        assert_eq!(m.transport.bpm, 120.0);
        assert!(m.transport.song_mode());
        assert!(m.channels.contains_key("a"));
        assert!(!m.channels.contains_key("b"));
        assert_eq!(m.channels["a"].generator.params.len(), 1);
        assert_eq!(m.patterns["p1"].notes["a"].len(), 1);
        assert!(m.inserts["m"].swap_lr);
        assert_eq!(m.master_id, "m");
        assert!(w.list.len() >= 2);
    }

    #[test]
    fn note_mute_parses_and_defaults_off() {
        let v: Value = serde_json::json!({
            "channels": { "a": { "id": "a", "generator": { "type": "x", "params": {} } } },
            "patterns": { "p1": { "id": "p1", "length": null, "notes": { "a": {
                "n1": { "id": "n1", "tick": 0, "key": 60, "mute": true, "color": 3 },
                "n2": { "id": "n2", "tick": 240, "key": 62 }
            } } } }
        });
        let mut w = Warnings::default();
        let m = Model::from_project(&v, &mut w);
        let notes = &m.patterns["p1"].notes["a"];
        assert_eq!(notes.len(), 2);
        assert!(notes.iter().find(|n| n.id == "n1").unwrap().mute);
        assert!(!notes.iter().find(|n| n.id == "n2").unwrap().mute);
    }
}
