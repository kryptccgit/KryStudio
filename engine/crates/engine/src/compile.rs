use crate::automation::Point;
use crate::model::{Model, WarpMap, Warnings};
use crate::params::{self, ChannelParam, InsertParam, ParamRef, TransportParam};
use crate::program::*;
use crate::samples::{is_sfz, missing_pack_hint, resolve_path, Lookup, MultiLookup, SampleCache};
use crate::time::{bar_ticks, pattern_length};
use crate::variants::{self, VLookup, VariantJob, VariantKey, VariantOutcome, IDENTITY_TIMING};
use krypt_studio_dsp::instruments::multisampler::{self, MultiSampleSet};
use krypt_studio_dsp::instruments::slicer::{self, Slice, SliceSet};
use krypt_studio_dsp::instruments::audioclip;
use krypt_studio_dsp::{clamp_to_spec, Instrument, ParamSpec, PluginDescriptor, SampleData};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::core::Shared;
use crate::plugins::PluginHost;

#[path = "rack_compile.rs"]
mod rack_compile;

#[derive(Default)]
struct SlotAlloc {
    map: HashMap<String, u32>,
    free: Vec<u32>,
    pending_free: Vec<u32>,
    next: u32,
    cap: u32,
}

impl SlotAlloc {
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
    fn release_missing(&mut self, live: &HashSet<String>) -> Vec<(String, u32)> {
        let gone: Vec<(String, u32)> = self.map.iter().filter(|(k, _)| !live.contains(*k)).map(|(k, v)| (k.clone(), *v)).collect();
        for (k, s) in &gone {
            self.map.remove(k);
            self.pending_free.push(*s);
        }
        gone
    }
    fn commit(&mut self) {
        self.free.append(&mut self.pending_free);
    }
    fn entries(&self) -> Vec<(u32, String)> {
        let mut v: Vec<(u32, String)> = self.map.iter().map(|(k, s)| (*s, k.clone())).collect();
        v.sort();
        v
    }
}

struct InstRec {
    type_id: String,
    has_instance: bool,
    sample: Option<PathBuf>,
    variant: Option<VariantKey>,
    params: Vec<f32>,
    voice: (bool, f32),
    rack: Option<String>,
    slices: Option<Arc<SliceSet>>,
    latency: usize,
    version: u64,
}

fn slice_set(markers: Option<&[crate::model::SliceMarker]>) -> Option<Arc<SliceSet>> {
    let m = markers.filter(|m| !m.is_empty())?;
    let set = SliceSet::new(m.iter().map(|s| Slice {
        start_sec: s.sec,
        pitch: s.pitch.unwrap_or(0.0) as f32,
        reverse: s.reverse.unwrap_or(false),
        gain: s.gain.unwrap_or(1.0) as f32,
    }));
    (!set.is_empty()).then(|| Arc::new(set))
}

enum VariantState {
    Ready(Arc<SampleData>),
    Pending,
    Failed(String),
}

struct FxRec {
    type_id: String,
    has_instance: bool,
    params: Vec<f32>,
    latency: usize,
    version: u64,
    rack: Option<String>,
}

#[derive(Default, Clone)]
pub struct Names {
    pub inserts: Vec<(u32, String)>,
    pub channels: Vec<(u32, String)>,
    pub patterns: Vec<(u32, String)>,
    pub launch: crate::launcher::LaunchNames,
    pub fx: Vec<(u32, String)>,
}

pub enum SampleMode {
    Async(crossbeam_channel::Sender<PathBuf>),
    Sync,
}

pub struct Session {
    pub model: Model,
    host: PluginHost,
    descs: HashMap<String, Arc<PluginDescriptor>>,
    pub sr: f32,
    chan_slots: SlotAlloc,
    ins_slots: SlotAlloc,
    fx_slots: SlotAlloc,
    pat_slots: SlotAlloc,
    insts: HashMap<String, InstRec>,
    fxs: HashMap<String, FxRec>,
    prev_targets: HashMap<String, usize>,
    warned: HashSet<String>,
    pub cache: Arc<SampleCache>,
    pub factory_dir: PathBuf,
    pub packs_dir: Option<PathBuf>,
    pub base_dir: Option<PathBuf>,
    sample_mode: SampleMode,
    loading: HashSet<PathBuf>,
    pub logs: Vec<(&'static str, String)>,
    pub names: Names,
    pub version: u64,
    pub variant_tx: Option<crossbeam_channel::Sender<VariantJob>>,
    variant_jobs: HashMap<VariantKey, Arc<AtomicBool>>,
    pub stretch_pending: Vec<String>,
    pub cancel: Arc<AtomicBool>,
    pub launcher: crate::launcher::LauncherCompiler,
    rack_targets: HashMap<String, rack_compile::RackTargets>,
}

impl Session {
    pub fn new(host: PluginHost, sr: f32, cache: Arc<SampleCache>, factory_dir: PathBuf, sample_mode: SampleMode) -> Self {
        let mut descs: HashMap<String, Arc<PluginDescriptor>> = (host.descriptors)().into_iter().map(|d| (d.id.to_string(), Arc::new(d))).collect();
        for d in crate::rack::rack_descriptors() {
            descs.entry(d.id.to_string()).or_insert_with(|| Arc::new(d));
        }
        Self {
            model: Model::default(),
            host,
            descs,
            sr,
            chan_slots: SlotAlloc::new(MAX_CHANNELS),
            ins_slots: SlotAlloc::new(MAX_INSERTS),
            fx_slots: SlotAlloc::new(MAX_FX),
            pat_slots: SlotAlloc::new(1 << 16),
            insts: HashMap::new(),
            fxs: HashMap::new(),
            prev_targets: HashMap::new(),
            warned: HashSet::new(),
            cache,
            factory_dir,
            packs_dir: None,
            base_dir: None,
            sample_mode,
            loading: HashSet::new(),
            logs: Vec::new(),
            names: Names::default(),
            version: 0,
            variant_tx: None,
            variant_jobs: HashMap::new(),
            stretch_pending: Vec::new(),
            cancel: Arc::new(AtomicBool::new(false)),
            launcher: crate::launcher::LauncherCompiler::new(),
            rack_targets: HashMap::new(),
        }
    }

    pub fn warn(&mut self, msg: String) {
        self.logs.push(("warn", msg));
    }

    fn warn_once(&mut self, key: String, msg: String) {
        if self.warned.insert(key) {
            self.logs.push(("warn", msg));
        }
    }

    pub fn take_warnings(&mut self, w: &mut Warnings) {
        for m in w.drain_messages() {
            self.logs.push(("warn", m));
        }
    }

    pub fn descriptor(&self, id: &str) -> Option<Arc<PluginDescriptor>> {
        self.descs.get(id).cloned().or_else(|| krypt_studio_pluginclient::descriptor(id))
    }

    pub fn channel_slot(&self, id: &str) -> Option<u32> {
        self.chan_slots.get(id)
    }

    pub fn forget_instances(&mut self) {
        self.insts.clear();
        self.fxs.clear();
    }

    pub fn forget_plugins(&mut self, all_external: bool) {
        let keep = |type_id: &str, has: bool| has && !(all_external && krypt_studio_pluginclient::is_external_id(type_id));
        self.insts.retain(|_, r| keep(&r.type_id, r.has_instance));
        self.fxs.retain(|_, r| keep(&r.type_id, r.has_instance));
    }

    pub fn referenced_samples(&self) -> HashSet<PathBuf> {
        self.model
            .channels
            .values()
            .flat_map(|c| crate::rack::generator_sample_ids(&c.generator))
            .filter_map(|sid| self.model.samples.get(sid))
            .filter_map(|s| self.resolve(&s.path).ok())
            .collect()
    }

    pub fn resolve(&self, p: &str) -> Result<PathBuf, String> {
        resolve_path(p, &self.factory_dir, self.packs_dir.as_deref(), self.base_dir.as_deref())
    }

    pub fn sample_loaded(&mut self, path: &Path) {
        self.loading.remove(path);
    }

    pub fn variant_done(&mut self, key: &VariantKey) {
        self.variant_jobs.remove(key);
    }

    pub fn variants_in_flight(&self) -> usize {
        self.variant_jobs.len()
    }

    fn doc_bpm(model: &Model) -> f64 {
        let b = model.transport.bpm;
        if b.is_finite() {
            b.clamp(10.0, 999.0)
        } else {
            140.0
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn clip_variant(&mut self, id: &str, type_id: &str, desc: Option<&PluginDescriptor>, params: &[f32], path: &Path, bpm: f64, warp: Option<&WarpMap>) -> Option<VariantKey> {
        if type_id != audioclip::PLUGIN_ID {
            return None;
        }
        let desc = desc?;
        let req = audioclip::stretch_request(|pid| desc.param_index(pid).and_then(|i| params.get(i).copied()), bpm);
        let (key, warning) = VariantKey::warped(path, SampleCache::mtime_of(path), req.ratio, req.semitones, req.keep_formants, warp, bpm);
        if let Some(w) = warning {
            self.warn_once(format!("warp:{id}:{w}"), format!("Audio clip channel {id}: {w}"));
        }
        if req.missing_src_bpm && !key.warp().is_some_and(|w| w.overrides_stretch()) {
            self.warn_once(
                format!("src-bpm:{id}"),
                format!("Audio clip channel {id} follows the tempo but its Source BPM is 0 (unknown); set Source BPM to stretch it"),
            );
        }
        (!key.is_identity()).then_some(key)
    }

    fn variant_for(&mut self, key: &VariantKey, src: &Arc<SampleData>) -> VariantState {
        match self.cache.variants.lookup(key) {
            VLookup::Hit(d) => VariantState::Ready(d),
            VLookup::Failed(e) => VariantState::Failed(e),
            VLookup::Miss => match &self.variant_tx {
                Some(tx) => {
                    if !self.variant_jobs.contains_key(key) {
                        let cancel = Arc::new(AtomicBool::new(false));
                        if tx.send(VariantJob { key: key.clone(), source: src.clone(), cancel: cancel.clone() }).is_err() {
                            return VariantState::Failed(format!("Could not time-stretch {}: the stretch worker is not running", key.describe()));
                        }
                        self.variant_jobs.insert(key.clone(), cancel);
                    }
                    VariantState::Pending
                }
                None => {
                    let job = VariantJob { key: key.clone(), source: src.clone(), cancel: self.cancel.clone() };
                    match variants::run_job(&self.cache.variants, &job) {
                        VariantOutcome::Ready(secs) => {
                            if secs > 0.0 {
                                self.logs.push(("info", format!("Time-stretched {} in {secs:.2} s", key.describe())));
                            }
                            match self.cache.variants.lookup(key) {
                                VLookup::Hit(d) => VariantState::Ready(d),
                                _ => VariantState::Failed(format!("Could not keep the stretched copy of {} in memory", key.describe())),
                            }
                        }
                        VariantOutcome::Failed(m) => VariantState::Failed(m),
                        VariantOutcome::Cancelled => VariantState::Pending,
                    }
                }
            },
        }
    }

    fn prefetch_variants(&mut self, model: &Model) {
        let bpm = Self::doc_bpm(model);
        let mut jobs: Vec<(VariantKey, Arc<SampleData>)> = Vec::new();
        for (id, ch) in &model.channels {
            if ch.generator.type_id != audioclip::PLUGIN_ID {
                continue;
            }
            let Some(s) = ch.generator.sample_id.as_ref().and_then(|sid| model.samples.get(sid)) else { continue };
            let Ok(path) = self.resolve(&s.path) else { continue };
            let desc = self.descriptor(&ch.generator.type_id);
            let params = Self::param_values(desc.as_deref(), &ch.generator.params);
            let Some(key) = self.clip_variant(id, &ch.generator.type_id, desc.as_deref(), &params, &path, bpm, ch.generator.warp.as_ref()) else { continue };
            if jobs.iter().any(|(k, _)| *k == key) || !matches!(self.cache.variants.lookup(&key), VLookup::Miss) {
                continue;
            }
            if let Some(src) = self.sample_for(&path) {
                jobs.push((key, src));
            }
        }
        if jobs.is_empty() {
            return;
        }
        let t0 = std::time::Instant::now();
        let n = jobs.len();
        let names: Vec<String> = jobs.iter().map(|(k, _)| k.describe()).collect();
        let failures = variants::compute_all(&self.cache.variants, jobs, &self.cancel);
        if failures.len() < n {
            self.logs.push(("info", format!("Time-stretched {} clip(s) in {:.2} s: {}", n - failures.len(), t0.elapsed().as_secs_f64(), names.join(", "))));
        }
    }

    pub fn refresh_latencies(&mut self, shared: &Shared) -> bool {
        let applied = shared.applied_version.load(Ordering::Acquire);
        let mut changed = false;
        for (key, rec) in self.fxs.iter_mut() {
            if !rec.has_instance || rec.version > applied {
                continue;
            }
            let Some(slot) = self.fx_slots.get(key) else { continue };
            let lat = krypt_studio_pluginclient::effect_latency(key).unwrap_or_else(|| shared.fx_latency[slot as usize].load(Ordering::Relaxed) as usize);
            if lat != rec.latency {
                rec.latency = lat;
                changed = true;
            }
        }
        for (id, rec) in self.insts.iter_mut() {
            if !rec.has_instance || rec.version > applied {
                continue;
            }
            let Some(slot) = self.chan_slots.get(id) else { continue };
            let lat = krypt_studio_pluginclient::instrument_latency(id).unwrap_or_else(|| shared.ch_latency[slot as usize].load(Ordering::Relaxed) as usize);
            if lat != rec.latency {
                rec.latency = lat;
                changed = true;
            }
        }
        changed
    }

    fn sample_for(&mut self, path: &Path) -> Option<Arc<SampleData>> {
        match self.cache.lookup(path) {
            Lookup::Hit(d) => Some(d),
            Lookup::Failed(e) => {
                self.warn_once(format!("sample-fail:{}", path.display()), e);
                None
            }
            Lookup::Miss => match &self.sample_mode {
                SampleMode::Sync => match self.cache.load(path) {
                    Ok(d) => Some(d),
                    Err(e) => {
                        self.warn_once(format!("sample-fail:{}", path.display()), e);
                        None
                    }
                },
                SampleMode::Async(tx) => {
                    if self.loading.insert(path.to_path_buf()) {
                        let _ = tx.send(path.to_path_buf());
                    }
                    None
                }
            },
        }
    }

    fn multi_for(&mut self, path: &Path) -> Option<Arc<MultiSampleSet>> {
        let res = match self.cache.lookup_multi(path) {
            MultiLookup::Hit(d) => Ok(d),
            MultiLookup::Failed(e) => Err(e),
            MultiLookup::Miss => match &self.sample_mode {
                SampleMode::Sync => self.cache.load_multi(path),
                SampleMode::Async(tx) => {
                    if self.loading.insert(path.to_path_buf()) {
                        let _ = tx.send(path.to_path_buf());
                    }
                    return None;
                }
            },
        };
        match res {
            Ok(set) => {
                if self.warned.insert(format!("multi-report:{}", set.id)) {
                    for (level, msg) in &set.report {
                        self.logs.push((level, msg.clone()));
                    }
                }
                Some(set)
            }
            Err(e) => {
                let msg = missing_pack_hint(path, self.packs_dir.as_deref()).unwrap_or(e);
                self.warn_once(format!("sample-fail:{}", path.display()), msg);
                None
            }
        }
    }

    fn param_values(desc: Option<&PluginDescriptor>, params: &BTreeMap<String, f64>) -> Vec<f32> {
        match desc {
            Some(d) => d
                .params
                .iter()
                .map(|s| clamp_to_spec(s, params.get(s.id).map(|v| *v as f32).unwrap_or(s.default)))
                .collect(),
            None => Vec::new(),
        }
    }

    pub fn build(&mut self, reset: bool) -> Box<Batch> {
        let model = std::mem::take(&mut self.model);
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.build_inner(&model, reset)));
        self.model = model;
        match res {
            Ok(b) => b,
            Err(_) => {
                self.logs.push(("error", "Internal error while compiling the project; the previous state keeps playing".into()));
                let mut b = Box::new(Batch::new(self.version));
                b.reset = reset;
                b
            }
        }
    }

    fn build_inner(&mut self, model: &Model, reset: bool) -> Box<Batch> {
        let version = self.version;
        let mut b = Box::new(Batch::new(version));
        b.reset = reset;
        self.rack_targets.clear();
        let mut prog = Program::empty();
        prog.version = version;
        let ts = &model.transport;
        let bar = bar_ticks(ts.time_sig.num, ts.time_sig.den);
        let bpm = Self::doc_bpm(model);
        if self.variant_tx.is_none() {
            self.prefetch_variants(model);
        }
        let mut wanted_variants: HashSet<VariantKey> = HashSet::new();
        self.stretch_pending.clear();

        let ins_ids = model.ordered_insert_ids();
        let live_ins: HashSet<String> = ins_ids.iter().cloned().collect();
        self.ins_slots.release_missing(&live_ins);
        for id in &ins_ids {
            if self.ins_slots.alloc(id).is_none() {
                self.warn_once(format!("ins-cap:{id}"), format!("Too many mixer inserts; insert {id} is ignored"));
            }
        }
        let live_ch: HashSet<String> = model.channels.keys().cloned().collect();
        for (id, slot) in self.chan_slots.release_missing(&live_ch) {
            if self.insts.remove(&id).map(|r| r.has_instance).unwrap_or(false) {
                b.instruments.push((slot, None));
            }
        }
        let live_pat: HashSet<String> = model.patterns.keys().cloned().collect();
        self.pat_slots.release_missing(&live_pat);

        let master_slot = self.ins_slots.get(&model.master_id);
        if master_slot.is_none() {
            self.warn_once("no-master".into(), "Project has no master insert; output is silent".into());
        }

        for (id, p) in &model.patterns {
            let Some(slot) = self.pat_slots.alloc(id) else { continue };
            let len = pattern_length(p, ts.time_sig.num, ts.time_sig.den);
            let mut notes = Vec::new();
            for (ch_id, list) in &p.notes {
                let Some(ch_slot) = self.chan_slots.get(ch_id).or_else(|| if model.channels.contains_key(ch_id) { self.chan_slots.alloc(ch_id) } else { None }) else {
                    continue;
                };
                for n in list {
                    if n.tick < 0.0 || n.mute {
                        continue;
                    }
                    notes.push(NoteProg {
                        ch_slot,
                        tick: n.tick,
                        dur: n.dur.max(1.0),
                        key: n.key.round().clamp(0.0, 127.0) as u8,
                        vel: n.vel.clamp(0.0, 1.0) as f32,
                        pan: n.pan.clamp(-1.0, 1.0) as f32,
                        release: n.release.clamp(0.0, 1.0) as f32,
                        fine: n.fine.clamp(-100.0, 100.0) as f32,
                        slide: n.slide,
                        mod_x: n.mod_x.clamp(0.0, 1.0) as f32,
                        mod_y: n.mod_y.clamp(0.0, 1.0) as f32,
                    });
                }
            }
            notes.sort_by(|a, b| a.tick.total_cmp(&b.tick).then(a.ch_slot.cmp(&b.ch_slot)).then(a.key.cmp(&b.key)));
            let s = slot as usize;
            if prog.patterns.len() <= s {
                prog.patterns.resize_with(s + 1, || None);
            }
            prog.patterns[s] = Some(PatternProg { len, notes });
        }

        for (id, ch) in &model.channels {
            let Some(slot) = self.chan_slots.alloc(id) else {
                self.warn_once(format!("ch-cap:{id}"), format!("Too many channels; channel {id} is ignored"));
                continue;
            };
            let type_id = ch.generator.type_id.clone();
            let desc = self.descriptor(&type_id);
            let uses_sample = desc.as_ref().map(|d| d.uses_sample == Some(true)).unwrap_or(false);
            let mut sample_path: Option<PathBuf> = None;
            if uses_sample {
                if let Some(sid) = &ch.generator.sample_id {
                    match model.samples.get(sid) {
                        Some(s) => match self.resolve(&s.path) {
                            Ok(p) => sample_path = Some(p),
                            Err(e) => self.warn_once(format!("resolve:{e}"), format!("{e}. Channels that use it stay silent.")),
                        },
                        None => self.warn_once(format!("ch-sample:{id}:{sid}"), format!("Channel {id} references missing sample {sid}")),
                    }
                }
            }
            let sfz = sample_path.as_deref().is_some_and(is_sfz);
            let multi_data = match &sample_path {
                Some(p) if sfz && type_id == multisampler::PLUGIN_ID => self.multi_for(p),
                _ => None,
            };
            let sample_data = match &sample_path {
                Some(p) if sfz => {
                    if type_id != multisampler::PLUGIN_ID {
                        self.warn_once(
                            format!("sfz-inst:{id}"),
                            format!("Channel {id}: {} is an SFZ instrument, which only Krypt Multisampler plays; the channel stays silent", p.display()),
                        );
                    }
                    None
                }
                Some(p) => self.sample_for(p),
                None => None,
            };
            let rack_plan = crate::rack::RackKind::of_instrument(&type_id).map(|k| self.rack_plan(id, k, &ch.generator.params, ch.generator.rack.as_deref(), model));
            let rack_key = rack_plan.as_ref().map(|p| p.key.clone());
            let params = match &rack_plan {
                Some(p) => p.values.clone(),
                None => Self::param_values(desc.as_deref(), &ch.generator.params),
            };
            let mut play_data = sample_data.clone();
            let mut variant: Option<VariantKey> = None;
            let mut keep_current = false;
            if let (Some(p), Some(src)) = (&sample_path, &sample_data) {
                if let Some(key) = self.clip_variant(id, &type_id, desc.as_deref(), &params, p, bpm, ch.generator.warp.as_ref()) {
                    wanted_variants.insert(key.clone());
                    match self.variant_for(&key, src) {
                        VariantState::Ready(d) => {
                            play_data = Some(d);
                            variant = Some(key);
                        }
                        VariantState::Pending => {
                            self.stretch_pending.push(id.clone());
                            keep_current = self.insts.get(id).is_some_and(|r| {
                                r.has_instance
                                    && r.type_id == type_id
                                    && r.sample.as_ref() == Some(p)
                                    && r.variant.as_ref().map_or(IDENTITY_TIMING, |v| v.timing()) == key.timing()
                            });
                            play_data = None;
                        }
                        VariantState::Failed(e) => {
                            self.warn_once(format!("variant-fail:{e}"), format!("{e}; the clip stays silent"));
                            play_data = None;
                        }
                    }
                }
            }
            let (sample_key, variant) = match self.insts.get(id) {
                Some(r) if keep_current => (r.sample.clone(), r.variant.clone()),
                _ if play_data.is_some() || multi_data.is_some() => (sample_path.clone(), variant),
                _ => (None, None),
            };
            let voice = (ch.poly.mono, ch.poly.glide_ms.max(0.0) as f32);
            let slices = if type_id == slicer::PLUGIN_ID { slice_set(ch.generator.slices.as_deref()) } else { None };
            let need_new = match self.insts.get(id) {
                None => true,
                Some(r) => r.type_id != type_id || r.sample != sample_key || r.variant != variant || r.rack != rack_key || r.slices != slices,
            };
            if need_new {
                let had = self.insts.get(id).map(|r| r.has_instance).unwrap_or(false);
                let had_rec = self.insts.contains_key(id);
                let create = self.host.create_instrument;
                let host = self.host;
                let sr = self.sr;
                let realtime = matches!(self.sample_mode, SampleMode::Async(_));
                let made = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut inst: Box<dyn Instrument> = match &rack_plan {
                        Some(plan) => crate::rack::build_instrument(plan, &host, sr, PREPARE_MAX),
                        None => create(&type_id, sr, PREPARE_MAX)
                            .or_else(|| krypt_studio_pluginclient::create_instrument(&type_id, id, ch.generator.state.as_deref(), &ch.generator.params, sr, realtime))?,
                    };
                    for (i, v) in params.iter().enumerate() {
                        inst.set_param(i, *v);
                    }
                    inst.set_voice_mode(voice.0, voice.1);
                    if let Some(d) = &play_data {
                        inst.set_sample(Some(d.clone()));
                    }
                    if let Some(m) = &multi_data {
                        inst.set_multisample(Some(m.clone()));
                    }
                    if let Some(s) = &slices {
                        inst.set_slices(Some(s.clone()));
                    }
                    let latency = inst.latency();
                    Some((inst, latency))
                }));
                let inst = made.unwrap_or_else(|_| {
                    self.logs.push(("error", format!("Instrument '{type_id}' crashed while loading; channel {id} is silent")));
                    None
                });
                match inst {
                    Some((inst, latency)) => {
                        b.instruments.push((slot, Some(inst)));
                        if had_rec && type_id == audioclip::PLUGIN_ID && play_data.is_some() {
                            b.rechase.push(slot);
                        }
                        self.insts.insert(id.clone(), InstRec { type_id: type_id.clone(), has_instance: true, sample: sample_key, variant, params, voice, rack: rack_key, slices, latency, version });
                    }
                    None => {
                        self.warn_once(
                            format!("inst:{type_id}"),
                            format!("Instrument '{type_id}' is not available; its channels stay silent"),
                        );
                        if had {
                            b.instruments.push((slot, None));
                        }
                        self.insts.insert(id.clone(), InstRec { type_id: type_id.clone(), has_instance: false, sample: sample_key, variant, params, voice, rack: rack_key, slices, latency: 0, version });
                    }
                }
            } else if let Some(rec) = self.insts.get_mut(id) {
                if rec.has_instance {
                    for (i, v) in params.iter().enumerate() {
                        if rec.params.get(i) != Some(v) {
                            b.inst_params.push((slot, i, *v));
                            rec.version = version;
                        }
                    }
                    if rec.voice != voice {
                        b.voice.push((slot, voice.0, voice.1));
                    }
                }
                rec.params = params;
                rec.voice = voice;
            }
            let insert_slot = self.ins_slots.get(&ch.insert_id).or(master_slot).unwrap_or(NONE);
            let root_key = ch.root_key.round().clamp(0.0, 127.0) as u8;
            prog.chan_index[slot as usize] = prog.channels.len() as u32;
            prog.channels.push(ChannelProg {
                slot,
                insert_slot,
                volume: ch.volume.max(0.0) as f32,
                pan: ch.pan.clamp(-1.0, 1.0) as f32,
                pitch: ch.pitch as f32,
                mute: ch.mute,
                root_shift: if uses_sample && ch.generator.type_id != "krypt.multisampler" && ch.generator.type_id != slicer::PLUGIN_ID {
                    sample_data.as_ref().and_then(|d| d.root_key).map(|k| k as f32).unwrap_or(60.0) - root_key as f32
                } else {
                    0.0
                },
                root_key,
                swing: ch.swing.clamp(0.0, 1.0) as f32,
                chokes: Vec::new(),
                latency: self.insts.get(id).filter(|r| r.has_instance).map_or(0, |r| r.latency.min(MAX_PDC)),
                pdc: None,
            });
        }
        if self.variant_tx.is_some() {
            self.variant_jobs.retain(|k, cancel| {
                let keep = wanted_variants.contains(k);
                if !keep {
                    cancel.store(true, Ordering::Relaxed);
                }
                keep
            });
            self.cache.variants.set_pins(&wanted_variants);
        }
        self.logs.extend(self.cache.variants.drain_logs());
        self.stretch_pending.sort();

        let cut_by: Vec<(u32, i64)> = model
            .channels
            .iter()
            .filter_map(|(id, c)| self.chan_slots.get(id).map(|s| (s, c.poly.cut_by.round() as i64)))
            .collect();
        for cp in prog.channels.iter_mut() {
            let Some(ch) = model.channels.iter().find(|(id, _)| self.chan_slots.get(id) == Some(cp.slot)).map(|(_, c)| c) else { continue };
            let g = ch.poly.cut_group.round() as i64;
            if g > 0 {
                cp.chokes = cut_by.iter().filter(|(_, by)| *by == g).map(|(s, _)| *s).collect();
            }
        }

        let mut live_fx: HashSet<String> = HashSet::new();
        for iid in &ins_ids {
            let ins = &model.inserts[iid];
            for sid in &ins.slot_order {
                if ins.slots.contains_key(sid) {
                    live_fx.insert(format!("{iid}/{sid}"));
                }
            }
        }
        for (key, slot) in self.fx_slots.release_missing(&live_fx) {
            if self.fxs.remove(&key).map(|r| r.has_instance).unwrap_or(false) {
                b.effects.push((slot, None));
            }
        }

        let n = ins_ids.len();
        let index: HashMap<&str, usize> = ins_ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
        let master_idx = index.get(model.master_id.as_str()).copied();
        let mut extra_routes: HashSet<(String, String)> = HashSet::new();
        for clip in model.clips.values() {
            if clip.kind != "automation" {
                continue;
            }
            if let Some(a) = clip.automation_id.as_ref().and_then(|a| model.automations.get(a)) {
                if let Some(ParamRef::Route { insert, target }) = a.target.as_deref().and_then(params::parse_param_ref) {
                    extra_routes.insert((insert, target));
                }
            }
        }
        let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
        let mut routes_ok: Vec<Vec<(usize, f32)>> = vec![Vec::new(); n];
        for u in 0..n {
            if Some(u) == master_idx {
                continue;
            }
            let ins = &model.inserts[&ins_ids[u]];
            let mut targets: Vec<(String, f64)> = ins.routes.iter().map(|(k, v)| (k.clone(), *v)).collect();
            for (src, dst) in &extra_routes {
                if src == &ins_ids[u] && !ins.routes.contains_key(dst) {
                    targets.push((dst.clone(), 0.0));
                }
            }
            for (tid, level) in targets {
                let Some(&v) = index.get(tid.as_str()) else {
                    self.warn_once(format!("route-missing:{}:{tid}", ins_ids[u]), format!("Insert {} routes to missing insert {tid}; ignored", ins_ids[u]));
                    continue;
                };
                if u == v || reachable(&adj, v, u) {
                    self.warn_once(
                        format!("cycle:{}:{tid}", ins_ids[u]),
                        format!("Ignored route {} → {tid}: it would create a feedback loop", ins_ids[u]),
                    );
                    continue;
                }
                adj[u].push(v);
                routes_ok[u].push((v, level.clamp(0.0, 4.0) as f32));
            }
        }
        let route_adj = adj.clone();
        let mut sc_ok: HashMap<(usize, String), usize> = HashMap::new();
        for v in 0..n {
            let ins = &model.inserts[&ins_ids[v]];
            for sid in &ins.slot_order {
                let Some(slot) = ins.slots.get(sid) else { continue };
                let Some(src) = slot.sidechain_from.as_deref() else { continue };
                let Some(&u) = index.get(src) else { continue };
                if u == v || reachable(&adj, v, u) {
                    self.warn_once(
                        format!("sc-cycle:{}:{sid}", ins_ids[v]),
                        format!("Ignored sidechain {src} → {} ({sid}): it would create a feedback loop", ins_ids[v]),
                    );
                    continue;
                }
                adj[u].push(v);
                sc_ok.insert((v, sid.clone()), u);
            }
        }
        let order = topo_order(&adj);

        let soloed: Vec<usize> = (0..n).filter(|&i| model.inserts[&ins_ids[i]].solo).collect();
        let mut solo_muted = vec![false; n];
        if !soloed.is_empty() {
            let mut keep = vec![false; n];
            for &s in &soloed {
                keep[s] = true;
            }
            let mut q: VecDeque<usize> = soloed.iter().copied().collect();
            let mut seen = keep.clone();
            while let Some(x) = q.pop_front() {
                for &y in &route_adj[x] {
                    if !seen[y] {
                        seen[y] = true;
                        keep[y] = true;
                        q.push_back(y);
                    }
                }
            }
            let mut radj: Vec<Vec<usize>> = vec![Vec::new(); n];
            for (u, vs) in route_adj.iter().enumerate() {
                for &v in vs {
                    radj[v].push(u);
                }
            }
            let mut q: VecDeque<usize> = soloed.iter().copied().collect();
            let mut seen = vec![false; n];
            for &s in &soloed {
                seen[s] = true;
            }
            while let Some(x) = q.pop_front() {
                for &y in &radj[x] {
                    if !seen[y] {
                        seen[y] = true;
                        keep[y] = true;
                        q.push_back(y);
                    }
                }
            }
            for i in 0..n {
                solo_muted[i] = !keep[i] && Some(i) != master_idx;
            }
        }

        let mut fx_progs: Vec<Vec<FxProg>> = vec![Vec::new(); n];
        let mut lat = vec![0usize; n];
        let mut can_sleep = vec![true; n];
        for u in 0..n {
            let iid = ins_ids[u].clone();
            let ins = &model.inserts[&iid];
            for sid in &ins.slot_order {
                let Some(fx) = ins.slots.get(sid) else { continue };
                let key = format!("{iid}/{sid}");
                let Some(slot) = self.fx_slots.alloc(&key) else {
                    self.warn_once(format!("fx-cap:{key}"), "Too many FX slots; some are ignored".into());
                    continue;
                };
                let desc = self.descriptor(&fx.type_id);
                let rack_plan = (fx.type_id == crate::rack::FX_RACK_PLUGIN).then(|| self.rack_plan(&key, crate::rack::RackKind::Effect, &fx.params, fx.rack.as_deref(), model));
                let rack_key = rack_plan.as_ref().map(|p| p.key.clone());
                let params = match &rack_plan {
                    Some(p) => p.values.clone(),
                    None => Self::param_values(desc.as_deref(), &fx.params),
                };
                let need_new = match self.fxs.get(&key) {
                    None => true,
                    Some(r) => r.type_id != fx.type_id || r.rack != rack_key,
                };
                if need_new {
                    let had = self.fxs.get(&key).map(|r| r.has_instance).unwrap_or(false);
                    let create = self.host.create_effect;
                    let host = self.host;
                    let sr = self.sr;
                    let realtime = matches!(self.sample_mode, SampleMode::Async(_));
                    let made = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let mut e = match &rack_plan {
                            Some(plan) => crate::rack::build_effect(plan, &host, sr, PREPARE_MAX),
                            None => create(&fx.type_id, sr, PREPARE_MAX)
                                .or_else(|| krypt_studio_pluginclient::create_effect(&fx.type_id, &key, fx.state.as_deref(), &fx.params, sr, realtime))?,
                        };
                        for (i, v) in params.iter().enumerate() {
                            e.set_param(i, *v);
                        }
                        let latency = e.latency();
                        let e: Box<dyn krypt_studio_dsp::Effect> = Box::new(crate::fxmix::LatencyAligned::new(e));
                        Some((e, latency))
                    }));
                    let made = made.unwrap_or_else(|_| {
                        self.logs.push(("error", format!("Effect '{}' crashed while loading; passing audio through", fx.type_id)));
                        None
                    });
                    match made {
                        Some((e, latency)) => {
                            b.effects.push((slot, Some(e)));
                            self.fxs.insert(key.clone(), FxRec { type_id: fx.type_id.clone(), has_instance: true, params, latency, version, rack: rack_key });
                        }
                        None => {
                            let t = fx.type_id.clone();
                            self.warn_once(format!("fx:{t}"), format!("Effect '{t}' is not available; passing audio through"));
                            if had {
                                b.effects.push((slot, None));
                            }
                            self.fxs.insert(key.clone(), FxRec { type_id: t, has_instance: false, params, latency: 0, version, rack: rack_key });
                        }
                    }
                } else if let Some(rec) = self.fxs.get_mut(&key) {
                    if rec.has_instance {
                        let mut changed = false;
                        for (i, v) in params.iter().enumerate() {
                            if rec.params.get(i) != Some(v) {
                                b.fx_params.push((slot, i, *v));
                                changed = true;
                            }
                        }
                        if changed {
                            rec.version = version;
                        }
                    }
                    rec.params = params;
                }
                let rec = &self.fxs[&key];
                if fx.enabled && rec.has_instance {
                    lat[u] += rec.latency;
                }
                let wants_sc = desc.as_ref().map(|d| d.sidechain == Some(true)).unwrap_or(false);
                let sidechain = if wants_sc {
                    sc_ok.get(&(u, sid.clone())).and_then(|&src| self.ins_slots.get(&ins_ids[src])).unwrap_or(NONE)
                } else {
                    NONE
                };
                if fx.enabled && (!fx.type_id.starts_with("krypt.") || matches!(fx.type_id.as_str(), "krypt.delay" | "krypt.tapeecho" | "krypt.grain")) {
                    can_sleep[u] = false;
                }
                if fx.enabled && fx.rack.as_deref().is_some_and(|r| !crate::rack::devices_may_sleep(r)) {
                    can_sleep[u] = false;
                }
                fx_progs[u].push(FxProg { slot, enabled: fx.enabled, mix: fx.mix.clamp(0.0, 1.0) as f32, sidechain });
            }
        }

        let mut in_lat = vec![0usize; n];
        let ins_of_slot: HashMap<u32, usize> = (0..n).filter_map(|u| self.ins_slots.get(&ins_ids[u]).map(|s| (s, u))).collect();
        for c in prog.channels.iter() {
            if let Some(&u) = ins_of_slot.get(&c.insert_slot) {
                in_lat[u] = in_lat[u].max(c.latency);
            }
        }
        for c in prog.channels.iter_mut() {
            let d = ins_of_slot.get(&c.insert_slot).map_or(0, |&u| in_lat[u] - c.latency);
            c.pdc = (d > 0).then(|| DelayLine::new(d));
        }
        let mut arrive = in_lat.clone();
        for &u in &order {
            for &(v, _) in &routes_ok[u] {
                arrive[v] = arrive[v].max(arrive[u] + lat[u]);
            }
        }
        let fed_by_channel: HashSet<u32> = prog.channels.iter().map(|c| c.insert_slot).collect();

        let mut pos_of = vec![usize::MAX; n];
        for (k, &u) in order.iter().enumerate() {
            pos_of[u] = k;
        }
        for &u in &order {
            let iid = &ins_ids[u];
            let Some(slot) = self.ins_slots.get(iid) else { continue };
            let ins = &model.inserts[iid];
            let routes = routes_ok[u]
                .iter()
                .filter_map(|&(v, level)| {
                    let target_slot = self.ins_slots.get(&ins_ids[v])?;
                    let d = arrive[v].saturating_sub(arrive[u] + lat[u]).min(MAX_PDC);
                    Some(RouteProg { target_slot, level, delay: if d > 0 { Some(DelayLine::new(d)) } else { None } })
                })
                .collect();
            let cd = arrive[u].saturating_sub(in_lat[u]).min(MAX_PDC);
            let chan_delay = if cd > 0 && fed_by_channel.contains(&slot) { Some(DelayLine::new(cd)) } else { None };
            let is_master = Some(u) == master_idx;
            prog.inserts.push(InsertProg {
                slot,
                volume: ins.volume.clamp(0.0, 4.0) as f32,
                pan: ins.pan.clamp(-1.0, 1.0) as f32,
                sep: ins.stereo_sep.clamp(-1.0, 1.0) as f32,
                mute: ins.mute || solo_muted[u],
                phase: ins.phase_invert,
                swap: ins.swap_lr,
                is_master,
                fx: std::mem::take(&mut fx_progs[u]),
                routes,
                chan_delay,
                in_lat: in_lat[u],
                quiet_frames: if can_sleep[u] && !is_master { (0.5 * self.sr).max(1.0) as u32 } else { 0 },
            });
            if is_master {
                prog.master = Some(prog.inserts.len() - 1);
            }
        }
        let ins_prog_index: HashMap<u32, usize> = prog.inserts.iter().enumerate().map(|(i, p)| (p.slot, i)).collect();

        prog.transport = TransportProg {
            bpm: if ts.bpm.is_finite() { ts.bpm.clamp(10.0, 999.0) } else { 140.0 },
            swing: ts.swing.clamp(0.0, 1.0),
            master_volume: ts.master_volume.clamp(0.0, 4.0) as f32,
            num: ts.time_sig.num,
            den: ts.time_sig.den,
            song_mode: ts.song_mode(),
            active_pattern: ts.active_pattern_id.as_deref().and_then(|p| self.pat_slots.get(p)).unwrap_or(NONE),
            loop_on: ts.loop_region.enabled,
            loop_start: ts.loop_region.start,
            loop_end: ts.loop_region.end,
            metronome: ts.metronome,
        };

        for (k, m) in self.launcher.alloc_tracks(model) {
            self.warn_once(k, m);
        }
        let any_track_solo = model.tracks.values().any(|t| t.solo);
        let mut song_end_raw: f64 = 0.0;
        let mut target_index: HashMap<String, usize> = HashMap::new();
        for clip in model.clips.values() {
            if clip.length < 1.0 || clip.start < 0.0 {
                continue;
            }
            let end = clip.start + clip.length;
            song_end_raw = song_end_raw.max(end);
            let track = model.tracks.get(&clip.track_id);
            let muted = clip.mute || track.map(|t| t.mute).unwrap_or(false) || (any_track_solo && !track.map(|t| t.solo).unwrap_or(false));
            if muted {
                continue;
            }
            let offset = clip.offset.max(0.0);
            match clip.kind.as_str() {
                "pattern" => {
                    let Some(ps) = clip.pattern_id.as_deref().and_then(|p| self.pat_slots.get(p)) else {
                        self.warn_once(format!("clip-pat:{}", clip.id), format!("Clip {} references a missing pattern", clip.id));
                        continue;
                    };
                    prog.pattern_clips.push(PatternClipProg { start: clip.start, end, offset, pattern_slot: ps, track: self.launcher.track(&clip.track_id) });
                }
                "audio" => {
                    let Some(cid) = clip.channel_id.as_deref() else { continue };
                    let (Some(cs), Some(ch)) = (self.chan_slots.get(cid), model.channels.get(cid)) else {
                        self.warn_once(format!("clip-ch:{}", clip.id), format!("Audio clip {} references a missing channel", clip.id));
                        continue;
                    };
                    prog.audio_clips.push(AudioClipProg {
                        start: clip.start,
                        end,
                        offset,
                        ch_slot: cs,
                        key: ch.root_key.round().clamp(0.0, 127.0) as u8,
                        gain: clip.gain.unwrap_or(1.0).clamp(0.0, 4.0) as f32,
                        fade_in: clip.fade_in.unwrap_or(0.0).max(0.0),
                        fade_out: clip.fade_out.unwrap_or(0.0).max(0.0),
                        track: self.launcher.track(&clip.track_id),
                    });
                }
                "automation" => {
                    let Some(a) = clip.automation_id.as_deref().and_then(|a| model.automations.get(a)) else {
                        self.warn_once(format!("clip-aut:{}", clip.id), format!("Clip {} references a missing automation", clip.id));
                        continue;
                    };
                    let Some(tref) = a.target.clone() else { continue };
                    let ti = match target_index.get(&tref) {
                        Some(&i) => i,
                        None => {
                            let Some((kind, spec, doc)) = self.resolve_target(model, &tref, &prog, &ins_prog_index) else {
                                self.warn_once(format!("target:{tref}"), format!("Automation target '{tref}' not found; ignored"));
                                continue;
                            };
                            let i = prog.targets.len();
                            prog.targets.push(AutoTarget { kind, spec, doc, held: None, carry: self.prev_targets.get(&tref).copied() });
                            target_index.insert(tref.clone(), i);
                            i
                        }
                    };
                    let mut pts: Vec<(f64, String, f64, f64)> = a.points.iter().map(|p| (p.tick, p.id.clone(), p.value.clamp(0.0, 1.0), p.tension.clamp(-1.0, 1.0))).collect();
                    crate::automation::sort_points(&mut pts);
                    let points = pts.into_iter().map(|(tick, _, value, tension)| Point { tick, value, tension }).collect();
                    prog.auto_clips.push(AutoClipProg { start: clip.start, end, offset, target: ti, points, active: false });
                }
                other => self.warn_once(format!("clip-kind:{other}"), format!("Unknown clip kind '{other}'")),
            }
        }
        prog.pattern_clips.sort_by(|a, b| a.start.total_cmp(&b.start));
        prog.audio_clips.sort_by(|a, b| a.start.total_cmp(&b.start));
        prog.auto_clips.sort_by(|a, b| a.start.total_cmp(&b.start));
        prog.max_pattern_clip_len = prog.pattern_clips.iter().map(|c| c.end - c.start).fold(0.0, f64::max);
        prog.max_audio_clip_len = prog.audio_clips.iter().map(|c| c.end - c.start).fold(0.0, f64::max);
        prog.song_end = bar.max((song_end_raw / bar).ceil() * bar);
        self.prev_targets = target_index;

        let (lp, lwarns) = {
            let pats = &self.pat_slots;
            let chans = &self.chan_slots;
            let pattern = |id: &str| pats.get(id);
            let audio = |id: &str| model.channels.get(id).and_then(|c| chans.get(id).map(|s| (s, c.root_key.round().clamp(0.0, 127.0) as u8)));
            self.launcher.compile(model, &pattern, &audio)
        };
        prog.launcher = lp;
        for (k, m) in lwarns {
            self.warn_once(k, m);
        }

        self.names = Names { inserts: self.ins_slots.entries(), channels: self.chan_slots.entries(), patterns: self.pat_slots.entries(), launch: self.launcher.names(), fx: self.fx_slots.entries() };
        self.names.inserts.retain(|(_, id)| model.inserts.contains_key(id));
        self.names.channels.retain(|(_, id)| model.channels.contains_key(id));

        self.chan_slots.commit();
        self.ins_slots.commit();
        self.fx_slots.commit();
        self.pat_slots.commit();
        b.program = Some(Box::new(prog));
        b
    }

    fn resolve_target(
        &self,
        model: &Model,
        tref: &str,
        prog: &Program,
        ins_index: &HashMap<u32, usize>,
    ) -> Option<(TargetKind, ParamSpec, f32)> {
        let r = params::parse_param_ref(tref)?;
        let ins_idx = |id: &str| -> Option<usize> { self.ins_slots.get(id).and_then(|s| ins_index.get(&s).copied()) };
        Some(match r {
            ParamRef::Transport(TransportParam::Bpm) => (TargetKind::Bpm, params::spec_bpm(), model.transport.bpm as f32),
            ParamRef::Transport(TransportParam::Swing) => (TargetKind::Swing, params::spec_swing(), model.transport.swing as f32),
            ParamRef::Transport(TransportParam::MasterVolume) => (TargetKind::MasterVolume, params::spec_master_volume(), model.transport.master_volume as f32),
            ParamRef::Channel { channel, param } => {
                let ch = model.channels.get(&channel)?;
                let slot = self.chan_slots.get(&channel)?;
                let ci = *prog.chan_index.get(slot as usize)?;
                if ci == NONE {
                    return None;
                }
                let ci = ci as usize;
                match param {
                    ChannelParam::Volume => (TargetKind::ChanVolume(ci), params::spec_channel_volume(), ch.volume as f32),
                    ChannelParam::Pan => (TargetKind::ChanPan(ci), params::spec_pan(), ch.pan as f32),
                    ChannelParam::Pitch => (TargetKind::ChanPitch(ci), params::spec_pitch(), ch.pitch as f32),
                }
            }
            ParamRef::Gen { channel, param } => {
                let ch = model.channels.get(&channel)?;
                let slot = self.chan_slots.get(&channel)?;
                let desc = self.descriptor(&ch.generator.type_id)?;
                let index = desc.param_index(&param)?;
                let spec = desc.params[index].clone();
                let doc = clamp_to_spec(&spec, ch.generator.params.get(&param).map(|v| *v as f32).unwrap_or(spec.default));
                (TargetKind::Gen { ch_slot: slot, index }, spec, doc)
            }
            ParamRef::Insert { insert, param } => {
                let ins = model.inserts.get(&insert)?;
                let i = ins_idx(&insert)?;
                match param {
                    InsertParam::Volume => (TargetKind::InsVolume(i), params::spec_insert_volume(), ins.volume as f32),
                    InsertParam::Pan => (TargetKind::InsPan(i), params::spec_pan(), ins.pan as f32),
                    InsertParam::StereoSep => (TargetKind::InsSep(i), params::spec_stereo_sep(), ins.stereo_sep as f32),
                }
            }
            ParamRef::Slot { insert, slot, param } => {
                let ins = model.inserts.get(&insert)?;
                let fx = ins.slots.get(&slot)?;
                let i = ins_idx(&insert)?;
                let fx_slot = self.fx_slots.get(&format!("{insert}/{slot}"))?;
                if param == "mix" {
                    let k = prog.inserts[i].fx.iter().position(|f| f.slot == fx_slot)?;
                    (TargetKind::SlotMix { ins: i, fx: k }, params::spec_mix(), fx.mix as f32)
                } else {
                    let desc = self.descriptor(&fx.type_id)?;
                    let index = desc.param_index(&param)?;
                    let spec = desc.params[index].clone();
                    let doc = clamp_to_spec(&spec, fx.params.get(&param).map(|v| *v as f32).unwrap_or(spec.default));
                    (TargetKind::SlotParam { fx_slot, index }, spec, doc)
                }
            }
            ParamRef::Route { insert, target } => {
                let ins = model.inserts.get(&insert)?;
                let i = ins_idx(&insert)?;
                let ts = self.ins_slots.get(&target)?;
                let k = prog.inserts[i].routes.iter().position(|r| r.target_slot == ts)?;
                (TargetKind::Route { ins: i, route: k }, params::spec_route(), ins.routes.get(&target).copied().unwrap_or(0.0) as f32)
            }
            ParamRef::Rack { host, chain, what } => match host {
                params::RackHost::Channel(ch) => {
                    let slot = self.chan_slots.get(&ch)?;
                    if !self.insts.get(&ch)?.has_instance {
                        return None;
                    }
                    let (target, spec, doc) = self.rack_targets.get(&ch)?.find(&chain, &what)?;
                    (TargetKind::RackInst { ch_slot: slot, target }, spec, doc)
                }
                params::RackHost::Slot { insert, slot } => {
                    let key = format!("{insert}/{slot}");
                    let fx_slot = self.fx_slots.get(&key)?;
                    if !self.fxs.get(&key)?.has_instance {
                        return None;
                    }
                    let (target, spec, doc) = self.rack_targets.get(&key)?.find(&chain, &what)?;
                    (TargetKind::RackFx { fx_slot, target }, spec, doc)
                }
            },
        })
    }
}

pub fn reachable(adj: &[Vec<usize>], from: usize, to: usize) -> bool {
    if from == to {
        return true;
    }
    let mut seen = vec![false; adj.len()];
    let mut stack = vec![from];
    seen[from] = true;
    while let Some(x) = stack.pop() {
        for &y in &adj[x] {
            if y == to {
                return true;
            }
            if !seen[y] {
                seen[y] = true;
                stack.push(y);
            }
        }
    }
    false
}

pub fn topo_order(adj: &[Vec<usize>]) -> Vec<usize> {
    let n = adj.len();
    let mut indeg = vec![0usize; n];
    for vs in adj {
        for &v in vs {
            indeg[v] += 1;
        }
    }
    let mut ready: std::collections::BTreeSet<usize> = (0..n).filter(|&i| indeg[i] == 0).collect();
    let mut out = Vec::with_capacity(n);
    while let Some(&u) = ready.iter().next() {
        ready.remove(&u);
        out.push(u);
        for &v in &adj[u] {
            indeg[v] -= 1;
            if indeg[v] == 0 {
                ready.insert(v);
            }
        }
    }
    if out.len() < n {
        for i in 0..n {
            if !out.contains(&i) {
                out.push(i);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topo_and_cycle_rejection() {
        let n = 4;
        let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
        let edges = [(1, 0), (2, 1), (3, 2), (0, 3), (1, 2), (3, 0)];
        let mut rejected = Vec::new();
        for (u, v) in edges {
            if u == v || reachable(&adj, v, u) {
                rejected.push((u, v));
            } else {
                adj[u].push(v);
            }
        }
        assert_eq!(rejected, vec![(0, 3), (1, 2)]);
        let order = topo_order(&adj);
        assert_eq!(order.len(), 4);
        let pos = |x: usize| order.iter().position(|&y| y == x).unwrap();
        for (u, vs) in adj.iter().enumerate() {
            for &v in vs {
                assert!(pos(u) < pos(v), "{u} must precede {v}");
            }
        }
        assert_eq!(order, vec![3, 2, 1, 0]);
    }

    #[test]
    fn slot_alloc_defers_reuse() {
        let mut s = SlotAlloc::new(4);
        assert_eq!(s.alloc("a"), Some(0));
        assert_eq!(s.alloc("b"), Some(1));
        let live: HashSet<String> = ["b".to_string()].into_iter().collect();
        assert_eq!(s.release_missing(&live), vec![("a".to_string(), 0)]);
        assert_eq!(s.alloc("c"), Some(2));
        s.commit();
        assert_eq!(s.alloc("d"), Some(0));
        assert_eq!(s.alloc("e"), Some(3));
        assert_eq!(s.alloc("f"), None);
    }
}
