use crate::compile::Session;
use crate::midi::{GridFilter, GridHit, MidiSink};
use crate::model::Model;
use crate::program::NONE;
use crate::protocol::Out;
use crate::time::{bar_ticks, PPQ};
use crossbeam_channel::{Receiver, Sender};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::Relaxed};
use std::sync::{Arc, Mutex};

pub const MAX_TRACKS: usize = 1024;
pub const MAX_LAUNCH_CLIPS: usize = 4096;
pub const MAX_SCENES: usize = 1024;
pub const LAUNCH_OWNER: u32 = 0x8000_0000;
pub const Q_STOP: u32 = u32::MAX - 1;
pub const REC_RING: usize = 4096;
pub const MAX_STEPS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchMode {
    Trigger,
    Gate,
    Toggle,
    Repeat,
}

impl LaunchMode {
    pub fn parse(s: &str) -> Self {
        match s {
            "gate" => Self::Gate,
            "toggle" => Self::Toggle,
            "repeat" => Self::Repeat,
            _ => Self::Trigger,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowAction {
    None,
    Stop,
    Again,
    Next,
    Previous,
    First,
    Last,
    Any,
    Other,
}

impl FollowAction {
    pub fn parse(s: &str) -> Self {
        match s {
            "stop" => Self::Stop,
            "again" => Self::Again,
            "next" => Self::Next,
            "previous" => Self::Previous,
            "first" => Self::First,
            "last" => Self::Last,
            "any" => Self::Any,
            "other" => Self::Other,
            _ => Self::None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FollowProg {
    pub action: FollowAction,
    pub other: FollowAction,
    pub chance: f64,
    pub after: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct LaunchClipProg {
    pub slot: u32,
    pub track: u32,
    pub row: u32,
    pub pattern_slot: u32,
    pub ch_slot: u32,
    pub key: u8,
    pub gain: f32,
    pub length: f64,
    pub offset: f64,
    pub looping: bool,
    pub mode: LaunchMode,
    pub quant: f64,
    pub follow: Option<FollowProg>,
    pub seed: u64,
}

impl LaunchClipProg {
    #[inline]
    pub fn is_audio(&self) -> bool {
        self.pattern_slot == NONE
    }
    #[inline]
    pub fn source_pos(&self, elapsed: f64) -> f64 {
        self.offset + if self.looping { elapsed.max(0.0).rem_euclid(self.length) } else { elapsed.clamp(0.0, self.length) }
    }
}

#[derive(Debug, Clone)]
pub struct LaneProg {
    pub track: u32,
    pub muted: bool,
    pub clips: Vec<u32>,
}

#[derive(Debug, Clone, Copy)]
pub struct SceneProg {
    pub slot: u32,
    pub row: u32,
}

#[derive(Debug, Clone)]
pub struct LauncherProg {
    pub clips: Vec<LaunchClipProg>,
    pub clip_index: Vec<u32>,
    pub lanes: Vec<LaneProg>,
    pub lane_index: Vec<u32>,
    pub scenes: Vec<SceneProg>,
    pub global_quant: f64,
}

impl LauncherProg {
    pub fn empty() -> Self {
        Self { clips: Vec::new(), clip_index: Vec::new(), lanes: Vec::new(), lane_index: Vec::new(), scenes: Vec::new(), global_quant: 3840.0 }
    }
    #[inline]
    pub fn clip(&self, slot: u32) -> Option<&LaunchClipProg> {
        let i = *self.clip_index.get(slot as usize)?;
        if i == NONE {
            None
        } else {
            self.clips.get(i as usize)
        }
    }
    #[inline]
    pub fn lane(&self, track: u32) -> Option<&LaneProg> {
        let i = *self.lane_index.get(track as usize)?;
        if i == NONE {
            None
        } else {
            self.lanes.get(i as usize)
        }
    }
    #[inline]
    pub fn scene_row(&self, slot: u32) -> Option<u32> {
        self.scenes.iter().find(|s| s.slot == slot).map(|s| s.row)
    }
}

pub fn quant_ticks(q: &str, num: f64, den: f64) -> Option<f64> {
    let bar = bar_ticks(num, den);
    Some(match q {
        "none" => 0.0,
        "1/16" => PPQ / 4.0,
        "1/8" => PPQ / 2.0,
        "1/4" => PPQ,
        "1/2" => PPQ * 2.0,
        "1bar" => bar,
        "2bars" => bar * 2.0,
        "4bars" => bar * 4.0,
        "8bars" => bar * 8.0,
        _ => return None,
    })
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[inline]
pub fn splitmix(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[inline]
pub fn follow_rng(seed: u64, starts: u32, n: u32) -> u64 {
    splitmix(seed ^ (((starts as u64) << 32) | n as u64))
}

#[inline]
pub fn decide(f: &FollowProg, r: u64) -> FollowAction {
    let u = (r >> 11) as f64 / (1u64 << 53) as f64;
    if u < f.chance {
        f.action
    } else {
        f.other
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowResult {
    Keep,
    Stop,
    Launch(u32),
}

pub fn follow_target(clips: &[u32], cur: u32, action: FollowAction, r: u64) -> FollowResult {
    let len = clips.len();
    let pos = clips.iter().position(|&c| c == cur);
    match action {
        FollowAction::None => FollowResult::Keep,
        FollowAction::Stop => FollowResult::Stop,
        FollowAction::Again => FollowResult::Launch(cur),
        _ if len == 0 => FollowResult::Keep,
        FollowAction::Next => FollowResult::Launch(clips[pos.map_or(0, |p| (p + 1) % len)]),
        FollowAction::Previous => FollowResult::Launch(clips[pos.map_or(len - 1, |p| (p + len - 1) % len)]),
        FollowAction::First => FollowResult::Launch(clips[0]),
        FollowAction::Last => FollowResult::Launch(clips[len - 1]),
        FollowAction::Any => FollowResult::Launch(clips[(r % len as u64) as usize]),
        FollowAction::Other => match pos {
            Some(p) if len > 1 => {
                let k = (r % (len as u64 - 1)) as usize;
                FollowResult::Launch(clips[if k >= p { k + 1 } else { k }])
            }
            None => FollowResult::Launch(clips[(r % len as u64) as usize]),
            _ => FollowResult::Keep,
        },
    }
}

#[derive(Default)]
struct IdSlots {
    map: HashMap<String, u32>,
    free: Vec<u32>,
    pending: Vec<u32>,
    next: u32,
    cap: u32,
}

impl IdSlots {
    fn new(cap: usize) -> Self {
        Self { cap: cap as u32, ..Default::default() }
    }
    fn get(&self, id: &str) -> Option<u32> {
        self.map.get(id).copied()
    }
    fn alloc(&mut self, id: &str) -> Option<u32> {
        if let Some(s) = self.map.get(id) {
            return Some(*s);
        }
        let s = if let Some(s) = self.free.pop() {
            s
        } else if self.next < self.cap {
            self.next += 1;
            self.next - 1
        } else {
            return None;
        };
        self.map.insert(id.to_string(), s);
        Some(s)
    }
    fn release_missing(&mut self, live: &dyn Fn(&str) -> bool) {
        let gone: Vec<String> = self.map.keys().filter(|k| !live(k)).cloned().collect();
        for k in gone {
            if let Some(s) = self.map.remove(&k) {
                self.pending.push(s);
            }
        }
    }
    fn commit(&mut self) {
        self.free.append(&mut self.pending);
    }
    fn entries(&self) -> Vec<(u32, String)> {
        let mut v: Vec<(u32, String)> = self.map.iter().map(|(k, s)| (*s, k.clone())).collect();
        v.sort();
        v
    }
}

#[derive(Default, Clone, Debug)]
pub struct LaunchNames {
    pub tracks: Vec<(u32, String)>,
    pub clips: Vec<(u32, String)>,
}

impl LaunchNames {
    pub fn track_id(&self, slot: u32) -> Option<&str> {
        self.tracks.binary_search_by_key(&slot, |(s, _)| *s).ok().map(|i| self.tracks[i].1.as_str())
    }
    pub fn clip_id(&self, slot: u32) -> Option<&str> {
        self.clips.binary_search_by_key(&slot, |(s, _)| *s).ok().map(|i| self.clips[i].1.as_str())
    }
}

pub struct LauncherCompiler {
    tracks: IdSlots,
    clips: IdSlots,
    scenes: IdSlots,
}

impl Default for LauncherCompiler {
    fn default() -> Self {
        Self::new()
    }
}

impl LauncherCompiler {
    pub fn new() -> Self {
        Self { tracks: IdSlots::new(MAX_TRACKS), clips: IdSlots::new(MAX_LAUNCH_CLIPS), scenes: IdSlots::new(MAX_SCENES) }
    }

    pub fn track_slot(&self, id: &str) -> Option<u32> {
        self.tracks.get(id)
    }
    pub fn clip_slot(&self, id: &str) -> Option<u32> {
        self.clips.get(id)
    }
    pub fn scene_slot(&self, id: &str) -> Option<u32> {
        self.scenes.get(id)
    }
    pub fn track(&self, id: &str) -> u32 {
        self.tracks.get(id).unwrap_or(NONE)
    }

    pub fn names(&self) -> LaunchNames {
        LaunchNames { tracks: self.tracks.entries(), clips: self.clips.entries() }
    }

    pub fn alloc_tracks(&mut self, model: &Model) -> Vec<(String, String)> {
        self.tracks.release_missing(&|id| model.tracks.contains_key(id));
        let mut warns = Vec::new();
        for id in model.tracks.keys() {
            if self.tracks.alloc(id).is_none() {
                warns.push(("launch-track-cap".to_string(), format!("More than {MAX_TRACKS} playlist tracks: the clip launcher ignores the rest")));
            }
        }
        warns
    }

    pub fn compile(
        &mut self,
        model: &Model,
        pattern: &dyn Fn(&str) -> Option<u32>,
        audio: &dyn Fn(&str) -> Option<(u32, u8)>,
    ) -> (LauncherProg, Vec<(String, String)>) {
        let mut warns: Vec<(String, String)> = Vec::new();
        let mut prog = LauncherProg::empty();
        let ts = &model.transport.time_sig;
        let (num, den) = (ts.num, ts.den);
        let bar = bar_ticks(num, den);
        prog.global_quant = quant_ticks(&model.session.quantize, num, den).unwrap_or(bar);

        let order: Vec<&String> = model.session.scene_order.iter().filter(|id| model.scenes.contains_key(*id)).collect();
        self.scenes.release_missing(&|id| model.scenes.contains_key(id) && model.session.scene_order.iter().any(|s| s == id));
        let mut row_of: HashMap<&str, u32> = HashMap::new();
        for (row, id) in order.iter().enumerate() {
            if row_of.contains_key(id.as_str()) {
                continue;
            }
            match self.scenes.alloc(id) {
                Some(slot) => {
                    row_of.insert(id.as_str(), row as u32);
                    prog.scenes.push(SceneProg { slot, row: row as u32 });
                }
                None => warns.push(("launch-scene-cap".into(), format!("More than {MAX_SCENES} scenes: the clip launcher ignores the rest"))),
            }
        }

        let any_solo = model.tracks.values().any(|t| t.solo);
        let mut lane_of: HashMap<u32, usize> = HashMap::new();
        for (id, t) in &model.tracks {
            let Some(slot) = self.tracks.get(id) else { continue };
            lane_of.insert(slot, prog.lanes.len());
            prog.lanes.push(LaneProg { track: slot, muted: t.mute || (any_solo && !t.solo), clips: Vec::new() });
        }

        self.clips.release_missing(&|id| model.launch_clips.contains_key(id));
        let mut taken: HashMap<(u32, u32), String> = HashMap::new();
        for (id, c) in &model.launch_clips {
            let Some(track) = self.tracks.get(&c.track_id) else {
                warns.push((format!("launch-track:{id}"), format!("Launch clip {id} is on a missing track; ignored")));
                continue;
            };
            let Some(&row) = row_of.get(c.scene_id.as_str()) else {
                warns.push((format!("launch-scene:{id}"), format!("Launch clip {id} is in a missing scene; ignored")));
                continue;
            };
            if let Some(first) = taken.get(&(track, row)) {
                warns.push((format!("launch-dup:{id}"), format!("Launch clips {first} and {id} share one slot; {id} is ignored")));
                continue;
            }
            let (pattern_slot, ch_slot, key) = match c.kind.as_str() {
                "audio" => match c.channel_id.as_deref().and_then(audio) {
                    Some((s, k)) => (NONE, s, k),
                    None => {
                        warns.push((format!("launch-ch:{id}"), format!("Launch clip {id} references a missing audio channel; ignored")));
                        continue;
                    }
                },
                _ => match c.pattern_id.as_deref().and_then(pattern) {
                    Some(p) => (p, NONE, 60),
                    None => {
                        warns.push((format!("launch-pat:{id}"), format!("Launch clip {id} references a missing pattern; ignored")));
                        continue;
                    }
                },
            };
            let Some(slot) = self.clips.alloc(id) else {
                warns.push(("launch-clip-cap".into(), format!("More than {MAX_LAUNCH_CLIPS} launch clips: the rest are ignored")));
                continue;
            };
            let quant = match c.quantize.as_deref() {
                None => prog.global_quant,
                Some(q) => quant_ticks(q, num, den).unwrap_or(prog.global_quant),
            };
            let follow = c.follow.as_ref().map(|f| FollowProg {
                action: FollowAction::parse(&f.action),
                other: FollowAction::parse(&f.other_action),
                chance: if f.chance.is_finite() { f.chance.clamp(0.0, 1.0) } else { 1.0 },
                after: if f.after_bars.is_finite() && f.after_bars > 0.0 { f.after_bars * bar } else { bar },
            });
            taken.insert((track, row), id.clone());
            let ci = prog.clips.len() as u32;
            prog.clips.push(LaunchClipProg {
                slot,
                track,
                row,
                pattern_slot,
                ch_slot,
                key,
                gain: c.gain.unwrap_or(1.0).clamp(0.0, 4.0) as f32,
                length: c.length.max(1.0),
                offset: c.offset.max(0.0),
                looping: c.looping,
                mode: LaunchMode::parse(&c.launch_mode),
                quant,
                follow,
                seed: fnv1a(id),
            });
            if prog.clip_index.len() <= slot as usize {
                prog.clip_index.resize(slot as usize + 1, NONE);
            }
            prog.clip_index[slot as usize] = ci;
            if let Some(&li) = lane_of.get(&track) {
                prog.lanes[li].clips.push(slot);
            }
        }
        for lane in prog.lanes.iter_mut() {
            let idx = &prog.clip_index;
            let clips = &prog.clips;
            lane.clips.sort_by_key(|&s| clips[idx[s as usize] as usize].row);
        }
        prog.lane_index = vec![NONE; prog.lanes.iter().map(|l| l.track as usize + 1).max().unwrap_or(0)];
        for (i, l) in prog.lanes.iter().enumerate() {
            prog.lane_index[l.track as usize] = i as u32;
        }
        self.tracks.commit();
        self.clips.commit();
        self.scenes.commit();
        (prog, warns)
    }
}

pub const K_NONE: u8 = 0;
pub const K_QUEUE: u8 = 1;
pub const K_END: u8 = 2;
pub const K_FOLLOW: u8 = 3;

#[derive(Clone, Copy, Debug)]
pub struct TrackRt {
    pub playing: u32,
    pub gen_e: f64,
    pub queued: u32,
    pub q_ticks: f64,
    pub q_immediate: bool,
    pub q_after: f64,
    pub follow_c: f64,
    pub follow_n: u32,
    pub held: bool,
    pub overridden: bool,
    pub rec_open: bool,
    pub rec_clip: u32,
    pub rec_start: f64,
    pub rec_offset: f64,
    pub next_t: f64,
    pub next_kind: u8,
    pub rechase: bool,
}

impl Default for TrackRt {
    fn default() -> Self {
        Self {
            playing: NONE,
            gen_e: 0.0,
            queued: NONE,
            q_ticks: 0.0,
            q_immediate: false,
            q_after: f64::NEG_INFINITY,
            follow_c: f64::INFINITY,
            follow_n: 0,
            held: false,
            overridden: false,
            rec_open: false,
            rec_clip: NONE,
            rec_start: 0.0,
            rec_offset: 0.0,
            next_t: f64::INFINITY,
            next_kind: K_NONE,
            rechase: false,
        }
    }
}

impl TrackRt {
    #[inline]
    pub fn idle(&self) -> bool {
        self.playing == NONE && self.queued == NONE && !self.overridden && !self.rec_open
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LaunchCmd {
    Launch { clip: u32, release: bool },
    Scene(u32),
    Stop(u32),
    BackToArrangement,
    Record(bool),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LaunchRecMsg {
    Span { track: u32, clip: u32, start: f64, end: f64, offset: f64 },
    Flush,
}

pub struct LaunchRt {
    pub tracks: Vec<TrackRt>,
    pub clock: f64,
    pub play_start_c: f64,
    pub starts: u32,
    pub forced_song: bool,
    pub rec_on: bool,
    pub rec_ran: bool,
    pub last_to: f64,
    pub last_valid: bool,
    pub rec_tx: Option<rtrb::Producer<LaunchRecMsg>>,
    pub dropped: u32,
}

impl LaunchRt {
    pub fn new(rec_tx: Option<rtrb::Producer<LaunchRecMsg>>) -> Self {
        Self {
            tracks: vec![TrackRt::default(); MAX_TRACKS],
            clock: 0.0,
            play_start_c: 0.0,
            starts: 0,
            forced_song: false,
            rec_on: false,
            rec_ran: false,
            last_to: 0.0,
            last_valid: false,
            rec_tx,
            dropped: 0,
        }
    }

    pub fn push_rec(&mut self, m: LaunchRecMsg) {
        if let Some(tx) = self.rec_tx.as_mut() {
            if tx.push(m).is_err() {
                self.dropped = self.dropped.wrapping_add(1);
            }
        }
    }
}

pub struct LaunchShared {
    pub any: AtomicBool,
    pub recording: AtomicBool,
    pub playing: Vec<AtomicU32>,
    pub queued: Vec<AtomicU32>,
    pub progress: Vec<AtomicU32>,
    pub overridden: Vec<AtomicBool>,
    rec_tx: Mutex<Option<rtrb::Producer<LaunchRecMsg>>>,
    rec_rx: Mutex<Option<rtrb::Consumer<LaunchRecMsg>>>,
}

impl Default for LaunchShared {
    fn default() -> Self {
        Self::new()
    }
}

impl LaunchShared {
    pub fn new() -> Self {
        let (tx, rx) = rtrb::RingBuffer::new(REC_RING);
        Self {
            any: AtomicBool::new(false),
            recording: AtomicBool::new(false),
            playing: (0..MAX_TRACKS).map(|_| AtomicU32::new(NONE)).collect(),
            queued: (0..MAX_TRACKS).map(|_| AtomicU32::new(NONE)).collect(),
            progress: (0..MAX_TRACKS).map(|_| AtomicU32::new(0)).collect(),
            overridden: (0..MAX_TRACKS).map(|_| AtomicBool::new(false)).collect(),
            rec_tx: Mutex::new(Some(tx)),
            rec_rx: Mutex::new(Some(rx)),
        }
    }
    pub fn take_rec_tx(&self) -> Option<rtrb::Producer<LaunchRecMsg>> {
        self.rec_tx.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
    pub fn take_rec_rx(&self) -> Option<rtrb::Consumer<LaunchRecMsg>> {
        self.rec_rx.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

#[derive(Serialize, Debug, Default)]
pub struct LauncherTel {
    pub playing: BTreeMap<String, String>,
    pub queued: BTreeMap<String, String>,
    pub progress: BTreeMap<String, f32>,
    pub overridden: Vec<String>,
    pub recording: bool,
}

pub fn telemetry(s: &LaunchShared, names: &LaunchNames) -> Option<LauncherTel> {
    if !s.any.load(Relaxed) {
        return None;
    }
    let mut t = LauncherTel { recording: s.recording.load(Relaxed), ..Default::default() };
    for (slot, tid) in &names.tracks {
        let i = *slot as usize;
        if i >= MAX_TRACKS {
            continue;
        }
        let p = s.playing[i].load(Relaxed);
        if let Some(cid) = names.clip_id(p) {
            t.playing.insert(tid.clone(), cid.to_string());
            let pr = f32::from_bits(s.progress[i].load(Relaxed));
            t.progress.insert(cid.to_string(), if pr.is_finite() { pr.clamp(0.0, 1.0) } else { 0.0 });
        }
        match s.queued[i].load(Relaxed) {
            Q_STOP => {
                t.queued.insert(tid.clone(), "stop".into());
            }
            q => {
                if let Some(cid) = names.clip_id(q) {
                    t.queued.insert(tid.clone(), cid.to_string());
                }
            }
        }
        if s.overridden[i].load(Relaxed) {
            t.overridden.push(tid.clone());
        }
    }
    Some(t)
}

#[derive(Clone, Debug, PartialEq)]
pub enum GridAction {
    Clip(String),
    Scene(String),
    Stop(Option<String>),
}

pub fn parse_grid_action(v: &Value) -> Option<GridAction> {
    if let Some(c) = v.get("clipId").and_then(|x| x.as_str()) {
        return Some(GridAction::Clip(c.to_string()));
    }
    if let Some(s) = v.get("sceneId").and_then(|x| x.as_str()) {
        return Some(GridAction::Scene(s.to_string()));
    }
    v.get("stopTrackId").map(|t| GridAction::Stop(t.as_str().map(String::from)))
}

pub struct LauncherCtl {
    rec_rx: Option<rtrb::Consumer<LaunchRecMsg>>,
    entries: Vec<Value>,
    sink: Option<Arc<MidiSink>>,
    grid: HashMap<u8, GridAction>,
    hits_tx: Sender<GridHit>,
    hits_rx: Receiver<GridHit>,
}

impl LauncherCtl {
    pub fn new(shared: &LaunchShared, sink: Option<Arc<MidiSink>>) -> Self {
        let (hits_tx, hits_rx) = crossbeam_channel::unbounded();
        Self { rec_rx: shared.take_rec_rx(), entries: Vec::new(), sink, grid: HashMap::new(), hits_tx, hits_rx }
    }

    pub fn command(&mut self, cmd: &str, v: &Value, session: &Session) -> Option<Result<(Value, Vec<LaunchCmd>), String>> {
        let l = &session.launcher;
        let r = match cmd {
            "launch" => {
                let id = v.get("clipId").and_then(|x| x.as_str()).unwrap_or("");
                let release = v.get("release").and_then(|x| x.as_bool()).unwrap_or(false);
                match l.clip_slot(id).filter(|_| session.model.launch_clips.contains_key(id)) {
                    Some(clip) => Ok((json!({}), vec![LaunchCmd::Launch { clip, release }])),
                    None => Err(format!("Unknown launch clip '{id}'")),
                }
            }
            "launchScene" => {
                let id = v.get("sceneId").and_then(|x| x.as_str()).unwrap_or("");
                match l.scene_slot(id).filter(|_| session.model.scenes.contains_key(id)) {
                    Some(s) => Ok((json!({}), vec![LaunchCmd::Scene(s)])),
                    None => Err(format!("Unknown scene '{id}'")),
                }
            }
            "launchStop" => match v.get("trackId").and_then(|x| x.as_str()) {
                None => Ok((json!({}), vec![LaunchCmd::Stop(NONE)])),
                Some(id) => match l.track_slot(id).filter(|_| session.model.tracks.contains_key(id)) {
                    Some(t) => Ok((json!({}), vec![LaunchCmd::Stop(t)])),
                    None => Err(format!("Unknown track '{id}'")),
                },
            },
            "backToArrangement" => Ok((json!({}), vec![LaunchCmd::BackToArrangement])),
            "setLaunchRecord" => match v.get("on").and_then(|x| x.as_bool()) {
                Some(on) => Ok((json!({ "on": on }), vec![LaunchCmd::Record(on)])),
                None => Err("setLaunchRecord needs a boolean 'on'".into()),
            },
            "setLaunchGrid" => self.set_grid(v).map(|n| (json!({ "notes": n }), Vec::new())),
            _ => return None,
        };
        Some(r)
    }

    fn set_grid(&mut self, v: &Value) -> Result<usize, String> {
        let mut grid = HashMap::new();
        if let Some(m) = v.get("notes").and_then(|x| x.as_object()) {
            for (k, a) in m {
                let Some(note) = k.trim().parse::<u8>().ok().filter(|n| *n < 128) else {
                    return Err(format!("setLaunchGrid: '{k}' is not a MIDI note number (0..127)"));
                };
                let Some(act) = parse_grid_action(a) else {
                    return Err(format!("setLaunchGrid: note {note} needs clipId, sceneId or stopTrackId"));
                };
                grid.insert(note, act);
            }
        }
        let device = v.get("device").and_then(|x| x.as_str()).map(String::from);
        let channel = v.get("channel").and_then(|x| x.as_u64()).map(|c| c.min(15) as u8);
        let n = grid.len();
        if let Some(sink) = &self.sink {
            if n == 0 {
                sink.set_grid(None);
            } else {
                let mut keys = [false; 128];
                for k in grid.keys() {
                    keys[*k as usize] = true;
                }
                let cc = v.get("cc").and_then(|x| x.as_bool()).unwrap_or(false);
                sink.set_grid(Some(GridFilter { device, channel, keys, tx: self.hits_tx.clone(), cc }));
            }
        }
        self.grid = grid;
        Ok(n)
    }

    pub fn grid_cmds(&self, hit: GridHit, session: &Session) -> Option<LaunchCmd> {
        let l = &session.launcher;
        match self.grid.get(&hit.key)? {
            GridAction::Clip(id) => l.clip_slot(id).map(|clip| LaunchCmd::Launch { clip, release: !hit.on }),
            GridAction::Scene(id) if hit.on => l.scene_slot(id).map(LaunchCmd::Scene),
            GridAction::Stop(None) if hit.on => Some(LaunchCmd::Stop(NONE)),
            GridAction::Stop(Some(t)) if hit.on => l.track_slot(t).map(LaunchCmd::Stop),
            _ => None,
        }
    }

    pub fn tick(&mut self, session: &Session, out: &Out) -> Vec<LaunchCmd> {
        let mut cmds = Vec::new();
        while let Ok(hit) = self.hits_rx.try_recv() {
            if let Some(c) = self.grid_cmds(hit, session) {
                cmds.push(c);
            }
        }
        for ev in self.drain_records(&session.names.launch) {
            out.event(ev);
        }
        cmds
    }

    pub fn drain_records(&mut self, names: &LaunchNames) -> Vec<Value> {
        let mut ev = Vec::new();
        let Some(rx) = self.rec_rx.as_mut() else { return ev };
        while let Ok(m) = rx.pop() {
            match m {
                LaunchRecMsg::Span { track, clip, start, end, offset } => {
                    let (Some(t), Some(c)) = (names.track_id(track), names.clip_id(clip)) else { continue };
                    self.entries.push(json!({ "trackId": t, "clipId": c, "startTick": start, "endTick": end, "offset": offset }));
                }
                LaunchRecMsg::Flush => {
                    ev.push(json!({ "event": "launchRecorded", "entries": std::mem::take(&mut self.entries) }));
                }
            }
        }
        ev
    }
}
