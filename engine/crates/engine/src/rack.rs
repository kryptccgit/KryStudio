//! Racks and macros (Wave 12.2, research/16-ableton-parity.md §2.3; the
//! contract is shared/schema/rack.ts, the Rust mirror `RackDef` is in
//! model_ext.rs). Spec as built: docs/ENGINE_PROTOCOL.md §12.
//!
//! Three composites, built by the compiler (compile.rs → rack_compile.rs)
//! from `Generator.rack` / `FxSlot.rack` through the SAME plugin factories
//! channels and FX slots use:
//! - `krypt.rack` / `krypt.drumrack` → [`RackInstrument`] (an `Instrument`):
//!   notes go to every chain whose zone holds the key and velocity, each
//!   chain runs its stock instrument then its stock effects, chains are summed
//!   with volume / pan / mute / solo; drum racks add choke groups;
//! - `krypt.fxrack` → [`RackEffect`] (an `Effect`): the input is split into
//!   every chain, each runs its effects, the chains are summed (the slot's
//!   `mix` stays the outer wet/dry, applied by the core).
//!
//! PARAM-ONLY EDITS NEVER RE-INSTANTIATE. Everything a doc edit can change
//! without changing the rack's STRUCTURE (chains, their instrument types and
//! samples, their device types, all in order) lives in one flat param vector
//! that the compiler diffs like any plugin's params and the core delivers
//! with `set_param(index, value)`:
//!
//! ```text
//! [0, 8)                         macro1..macro8 (0..1) = the descriptor params
//! [8, 8 + 7·C)                   per chain: mute, solo, keyLo, keyHi, velLo, velHi, choke
//! [.., + D)                      per device (chain-major): enabled
//! [.., + 4·T)                    per mappable target: base (plain), macro (0 = none, 1..8), min, max
//! ```
//!
//! Targets, chain-major: chain volume, chain pan, the instrument's params
//! (descriptor order), then per device its `mix` and its params. The
//! compiler resolves macro maps ("last map in macro order wins") into the
//! per-target (macro, min, max) fields, so every target has at most one map:
//! effective = macro ? from_normalized(spec, min + v·(max − min)) : base.
//!
//! AUTOMATION OF INNER PARAMS (Wave 12.2b, ParamRef `<host>/rack/<chain>/…`):
//! `set_param(AUTO_BASE + t, plain)` sets target t's automation override and
//! `set_param(AUTO_BASE + t, NaN)` releases it. These indices sit outside the
//! flat vector, so the compiler never diffs them; only the core's automation
//! (TargetKind::RackInst / RackFx) writes them. The rule: AUTOMATION WINS.
//! effective = override ?? (macro ? macro value : base). While an automation
//! clip holds a value for the param, a macro mapped onto it moves nothing
//! (like an automated knob ignoring the hand); when the automation goes away
//! (clip deleted / retargeted) the core releases it and the macro takes over.
//!
//! Changes are applied EAGERLY inside `set_param` (O(1) per target field,
//! O(targets) per macro move), so `latency()` is right the moment the core
//! asks after a batch, and automation of a macro costs one pass per change.
//!
//! [RT] Everything after construction (`set_param`, `note_*`, `process`,
//! `reset`, `latency`) is allocation-free, lock-free and I/O-free: chain
//! scratch, PDC rings and dry buffers are preallocated in `new` / `prepare`.

// Per-sample index loops over parallel buffers are the clearest DSP style.
#![allow(clippy::needless_range_loop)]

use crate::fxmix::{LatencyAligned, MAX_ALIGN};
use crate::plugins::PluginHost;
use krypt_studio_dsp::instruments::multisampler::MultiSampleSet;
use krypt_studio_dsp::{from_normalized, Effect, Instrument, NoteExtras, ParamSpec, PluginDescriptor, ProcessContext, SampleData};
use std::sync::Arc;

pub use krypt_studio_dsp::catalog::{rack_descriptors, DRUM_RACK_PLUGIN, FX_RACK_PLUGIN, MACRO_PARAM_IDS, RACK_PLUGIN};

pub const MACRO_COUNT: usize = 8;
/// = MAX_RACK_CHAINS in shared/schema/rack.ts.
pub const MAX_RACK_CHAINS: usize = 128;
/// = MAX_FX_SLOTS in shared/schema/project.ts.
pub const MAX_CHAIN_DEVICES: usize = 10;
/// Flat settings per chain: mute, solo, keyLo, keyHi, velLo, velHi, choke.
pub const CHAIN_SETTINGS: usize = 7;
pub const S_MUTE: usize = 0;
pub const S_SOLO: usize = 1;
pub const S_KEY_LO: usize = 2;
pub const S_KEY_HI: usize = 3;
pub const S_VEL_LO: usize = 4;
pub const S_VEL_HI: usize = 5;
pub const S_CHOKE: usize = 6;
/// Fields per mappable target.
pub const TARGET_FIELDS: usize = 4;
/// `set_param(AUTO_BASE + t, v)`: automation override of target t (NaN releases it). Outside the flat vector.
pub const AUTO_BASE: usize = 1 << 24;

/// Key of a mappable target: (chain id, "chain" | "instrument" | "device", device id or "", param id).
pub type TargetKey = (String, &'static str, String, String);

/// Stock devices whose output can come back after a silent gap (echoes,
/// grain buffers): a chain holding one never sleeps, and an FX rack holding
/// one keeps its insert awake (same rule as compile.rs `can_sleep`).
const ECHO_DEVICES: [&str; 3] = ["krypt.delay", "krypt.tapeecho", "krypt.grain"];

/// The stock catalog as the engine serves it (`--dump-catalog`, `catalog`):
/// every dsp plugin, then the three rack devices.
pub fn stock_descriptors() -> Vec<PluginDescriptor> {
    let mut v = krypt_studio_dsp::descriptors();
    v.extend(rack_descriptors());
    v
}

pub fn is_rack(type_id: &str) -> bool {
    type_id == RACK_PLUGIN || type_id == DRUM_RACK_PLUGIN || type_id == FX_RACK_PLUGIN
}

/// Sample ids a generator uses: its own plus those of a rack's inner instruments.
pub fn generator_sample_ids(g: &crate::model::Generator) -> Vec<&String> {
    let mut v: Vec<&String> = g.sample_id.iter().collect();
    if let Some(r) = g.rack.as_deref() {
        for c in r.chains.values() {
            if let Some(s) = c.instrument.as_ref().and_then(|i| i.sample_id.as_ref()) {
                v.push(s);
            }
        }
    }
    v
}

/// Can an FX slot holding this rack sleep through silence (compile.rs
/// `can_sleep`)? Only when no inner device is third-party or an echo.
pub fn devices_may_sleep(def: &crate::model_ext::RackDef) -> bool {
    def.chains.values().flat_map(|c| c.devices.values()).filter(|d| d.enabled).all(|d| d.type_id.starts_with("krypt.") && !ECHO_DEVICES.contains(&d.type_id.as_str()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RackKind {
    Instrument,
    Drum,
    Effect,
}

impl RackKind {
    /// The rack kind of a channel generator type (None = not a rack instrument).
    pub fn of_instrument(type_id: &str) -> Option<Self> {
        match type_id {
            RACK_PLUGIN => Some(Self::Instrument),
            DRUM_RACK_PLUGIN => Some(Self::Drum),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Instrument => "instrument",
            Self::Drum => "drum",
            Self::Effect => "effect",
        }
    }
}

// ── Plan (control thread) ────────────────────────────────────────────────

/// What a mappable target drives inside its chain.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TargetWhat {
    Volume,
    Pan,
    /// Instrument param index.
    Inst(usize),
    /// Device (index within the chain) wet/dry.
    DevMix(usize),
    /// Device (index within the chain), param index.
    Dev(usize, usize),
}

#[derive(Clone, Debug)]
pub struct TargetPlan {
    pub chain: usize,
    pub what: TargetWhat,
    pub spec: ParamSpec,
}

pub struct InstPlan {
    pub type_id: String,
    pub sample: Option<Arc<SampleData>>,
    pub multi: Option<Arc<MultiSampleSet>>,
    /// Sample instruments (not the multisampler): the sample's root key (WAV smpl, else 60).
    pub sample_root: Option<f32>,
}

pub struct DevPlan {
    pub type_id: String,
    /// Plays its echo after silence (never let the chain sleep).
    pub echo: bool,
}

#[derive(Default)]
pub struct ChainPlan {
    pub id: String,
    pub inst: Option<InstPlan>,
    pub devices: Vec<DevPlan>,
}

/// A rack resolved against the catalog and the sample cache: what to build,
/// its flat param vector (see the module docs) and its structure key.
pub struct RackPlan {
    pub kind: RackKind,
    pub chains: Vec<ChainPlan>,
    pub targets: Vec<TargetPlan>,
    pub values: Vec<f32>,
    /// Equal keys ⇔ same layout and same inner instances: a param-only edit.
    pub key: String,
    /// Target key → target index (macro maps and automation of inner params resolve through it).
    pub index: std::collections::BTreeMap<TargetKey, usize>,
}

impl RackPlan {
    pub fn new(kind: RackKind) -> Self {
        Self { kind, chains: Vec::new(), targets: Vec::new(), values: Vec::new(), key: String::new(), index: Default::default() }
    }
    pub fn n_devices(&self) -> usize {
        self.chains.iter().map(|c| c.devices.len()).sum()
    }
    pub fn settings_base(&self) -> usize {
        MACRO_COUNT
    }
    pub fn enabled_base(&self) -> usize {
        MACRO_COUNT + CHAIN_SETTINGS * self.chains.len()
    }
    pub fn targets_base(&self) -> usize {
        self.enabled_base() + self.n_devices()
    }
    pub fn len(&self) -> usize {
        self.targets_base() + TARGET_FIELDS * self.targets.len()
    }
    pub fn is_empty(&self) -> bool {
        self.chains.is_empty()
    }
}

// ── Runtime (audio thread after construction) ───────────────────────────

struct DevRt {
    fx: Box<dyn Effect>,
    enabled: bool,
    mix: f32,
}

struct ChainRt {
    inst: Option<Box<dyn Instrument>>,
    devs: Vec<DevRt>,
    vol: f32,
    pan: f32,
    mute: bool,
    solo: bool,
    key_lo: u8,
    key_hi: u8,
    vel_lo: f32,
    vel_hi: f32,
    choke: i32,
    sample_root: Option<f32>,
    /// Smoothed output gains (ramped per block), `fresh` = jump on first use.
    gl: f32,
    gr: f32,
    fresh: bool,
    l: Vec<f32>,
    r: Vec<f32>,
    /// PDC ring (MAX_ALIGN frames, power of two) and write position.
    pdc: [Vec<f32>; 2],
    pdc_w: usize,
    /// Frames the chain's output has been silent (instrument racks: sleep).
    quiet: u32,
    never_sleep: bool,
    kick: bool,
}

impl ChainRt {
    #[inline]
    fn audible(&self, solo_any: bool) -> bool {
        !self.mute && (!solo_any || self.solo)
    }

    /// Latency of the devices that run (enabled, mix > 0).
    #[inline]
    fn latency(&self) -> usize {
        self.devs.iter().filter(|d| d.enabled && d.mix > 0.0).map(|d| d.fx.latency()).sum::<usize>().min(MAX_ALIGN - 1)
    }

    #[inline]
    fn in_zone(&self, key: u8, vel: f32) -> bool {
        key >= self.key_lo && key <= self.key_hi && vel >= self.vel_lo - 1e-6 && vel <= self.vel_hi + 1e-6
    }
}

struct Target {
    chain: usize,
    what: TargetWhat,
    spec: ParamSpec,
    base: f32,
    /// 0 = unmapped, 1..=8 = macro.
    mac: u8,
    min: f32,
    max: f32,
    /// Value last written to the target (NaN = never).
    cur: f32,
    /// Automation override (NaN = none): wins over the macro and the base.
    auto: f32,
}

/// The parts shared by the instrument and the effect rack.
struct RackCore {
    chains: Vec<ChainRt>,
    targets: Vec<Target>,
    macros: [f32; MACRO_COUNT],
    /// Global device index → (chain, device).
    dev_index: Vec<(usize, usize)>,
    enabled_base: usize,
    targets_base: usize,
    /// Scratch frames per call (chain buffers' length).
    cap: usize,
    dry: [Vec<f32>; 2],
    sr: f32,
    quiet_need: u32,
}

fn quiet_need(sr: f32) -> u32 {
    (0.5 * sr.clamp(8000.0, 768_000.0)) as u32
}

impl RackCore {
    /// Instantiate every inner plugin of `plan` through `host` (control thread).
    fn new(plan: &RackPlan, host: &PluginHost, sr: f32, max_frames: usize) -> Self {
        let cap = max_frames.max(1);
        let mut chains = Vec::with_capacity(plan.chains.len());
        let mut dev_index = Vec::new();
        for (ci, cp) in plan.chains.iter().enumerate() {
            let inst = cp.inst.as_ref().and_then(|ip| {
                let mut i = (host.create_instrument)(&ip.type_id, sr, max_frames)?;
                if let Some(s) = &ip.sample {
                    i.set_sample(Some(s.clone()));
                }
                if let Some(m) = &ip.multi {
                    i.set_multisample(Some(m.clone()));
                }
                Some(i)
            });
            let mut devs = Vec::with_capacity(cp.devices.len());
            for dp in &cp.devices {
                // A device the factory can't make passes audio through (keeps the flat layout).
                let fx = (host.create_effect)(&dp.type_id, sr, max_frames).unwrap_or_else(|| Box::new(Thru));
                dev_index.push((ci, devs.len()));
                devs.push(DevRt { fx: Box::new(LatencyAligned::new(fx)), enabled: true, mix: 1.0 });
            }
            chains.push(ChainRt {
                inst,
                devs,
                vol: 1.0,
                pan: 0.0,
                mute: false,
                solo: false,
                key_lo: 0,
                key_hi: 127,
                vel_lo: 0.0,
                vel_hi: 1.0,
                choke: 0,
                sample_root: cp.inst.as_ref().and_then(|i| i.sample_root),
                gl: 0.0,
                gr: 0.0,
                fresh: true,
                l: vec![0.0; cap],
                r: vec![0.0; cap],
                pdc: [vec![0.0; MAX_ALIGN], vec![0.0; MAX_ALIGN]],
                pdc_w: 0,
                quiet: quiet_need(sr),
                never_sleep: cp.devices.iter().any(|d| d.echo),
                kick: false,
            });
        }
        let targets = plan
            .targets
            .iter()
            .map(|t| Target { chain: t.chain, what: t.what, spec: t.spec.clone(), base: t.spec.default, mac: 0, min: 0.0, max: 1.0, cur: f32::NAN, auto: f32::NAN })
            .collect();
        let mut core = Self {
            chains,
            targets,
            macros: [0.0; MACRO_COUNT],
            dev_index,
            enabled_base: plan.enabled_base(),
            targets_base: plan.targets_base(),
            cap,
            dry: [vec![0.0; cap], vec![0.0; cap]],
            sr,
            quiet_need: quiet_need(sr),
        };
        for (i, v) in plan.values.iter().enumerate() {
            core.set_param(i, *v);
        }
        core
    }

    fn prepare(&mut self, sr: f32, max_frames: usize) {
        self.sr = sr;
        self.quiet_need = quiet_need(sr);
        let cap = max_frames.max(1);
        if cap > self.cap {
            self.cap = cap;
            for c in self.chains.iter_mut() {
                c.l.resize(cap, 0.0);
                c.r.resize(cap, 0.0);
            }
            self.dry[0].resize(cap, 0.0);
            self.dry[1].resize(cap, 0.0);
        }
        for c in self.chains.iter_mut() {
            if let Some(i) = c.inst.as_mut() {
                i.prepare(sr, max_frames);
            }
            for d in c.devs.iter_mut() {
                d.fx.prepare(sr, max_frames);
            }
        }
        self.reset();
    }

    /// [RT] Clear tails, PDC and gain ramps (devices only; instruments keep voices).
    fn reset(&mut self) {
        let need = self.quiet_need;
        for c in self.chains.iter_mut() {
            for d in c.devs.iter_mut() {
                d.fx.reset();
            }
            c.pdc[0].fill(0.0);
            c.pdc[1].fill(0.0);
            c.pdc_w = 0;
            c.fresh = true;
            c.quiet = need;
            c.kick = false;
        }
    }

    /// [RT] One flat param (see the module docs).
    fn set_param(&mut self, index: usize, value: f32) {
        if index >= AUTO_BASE {
            // Automation override of an inner param (NaN = release).
            let t = index - AUTO_BASE;
            let Some(tg) = self.targets.get_mut(t) else { return };
            let v = if value.is_finite() { value } else { f32::NAN };
            if v.to_bits() != tg.auto.to_bits() {
                tg.auto = v;
                self.apply_target(t);
            }
            return;
        }
        if !value.is_finite() {
            return;
        }
        if index < MACRO_COUNT {
            let v = value.clamp(0.0, 1.0);
            if self.macros[index] != v {
                self.macros[index] = v;
                let m = index as u8 + 1;
                for t in 0..self.targets.len() {
                    if self.targets[t].mac == m {
                        self.apply_target(t);
                    }
                }
            }
            return;
        }
        if index < self.enabled_base {
            let c = (index - MACRO_COUNT) / CHAIN_SETTINGS;
            let Some(ch) = self.chains.get_mut(c) else { return };
            match (index - MACRO_COUNT) % CHAIN_SETTINGS {
                S_MUTE => ch.mute = value >= 0.5,
                S_SOLO => ch.solo = value >= 0.5,
                S_KEY_LO => ch.key_lo = value.round().clamp(0.0, 127.0) as u8,
                S_KEY_HI => ch.key_hi = value.round().clamp(0.0, 127.0) as u8,
                S_VEL_LO => ch.vel_lo = value.clamp(0.0, 1.0),
                S_VEL_HI => ch.vel_hi = value.clamp(0.0, 1.0),
                _ => ch.choke = value.round().clamp(0.0, 32.0) as i32,
            }
            return;
        }
        if index < self.targets_base {
            if let Some(&(c, d)) = self.dev_index.get(index - self.enabled_base) {
                if let Some(dev) = self.chains.get_mut(c).and_then(|ch| ch.devs.get_mut(d)) {
                    dev.enabled = value >= 0.5;
                }
            }
            return;
        }
        let rel = index - self.targets_base;
        let t = rel / TARGET_FIELDS;
        let Some(tg) = self.targets.get_mut(t) else { return };
        match rel % TARGET_FIELDS {
            0 => tg.base = value,
            1 => tg.mac = value.round().clamp(0.0, MACRO_COUNT as f32) as u8,
            2 => tg.min = value.clamp(0.0, 1.0),
            _ => tg.max = value.clamp(0.0, 1.0),
        }
        self.apply_target(t);
    }

    /// [RT] Write target `t`'s effective value into its chain / plugin.
    fn apply_target(&mut self, t: usize) {
        let tg = &mut self.targets[t];
        if tg.chain == usize::MAX {
            return;
        }
        let v = if tg.auto.is_finite() {
            tg.auto
        } else if tg.mac > 0 {
            let m = self.macros[(tg.mac - 1) as usize];
            from_normalized(&tg.spec, tg.min + m * (tg.max - tg.min))
        } else {
            tg.base
        };
        if v == tg.cur || !v.is_finite() {
            return;
        }
        tg.cur = v;
        let (what, c) = (tg.what, tg.chain);
        let Some(ch) = self.chains.get_mut(c) else { return };
        match what {
            TargetWhat::Volume => ch.vol = v.clamp(0.0, 2.0),
            TargetWhat::Pan => ch.pan = v.clamp(-1.0, 1.0),
            TargetWhat::Inst(k) => {
                if let Some(i) = ch.inst.as_mut() {
                    i.set_param(k, v);
                }
            }
            TargetWhat::DevMix(d) => {
                if let Some(dev) = ch.devs.get_mut(d) {
                    dev.mix = v.clamp(0.0, 1.0);
                }
            }
            TargetWhat::Dev(d, k) => {
                if let Some(dev) = ch.devs.get_mut(d) {
                    dev.fx.set_param(k, v);
                }
            }
        }
    }

    fn solo_any(&self) -> bool {
        self.chains.iter().any(|c| c.solo)
    }

    /// Max latency over the chains (what the rack reports; shorter chains are delayed to it).
    fn latency(&self) -> usize {
        self.chains.iter().map(|c| c.latency()).max().unwrap_or(0)
    }

    /// [RT] Run chain `ci`'s devices, PDC to `max_lat`, NaN guard; the chain's
    /// buffers hold its signal on entry and its aligned output on exit.
    fn run_chain(chain: &mut ChainRt, dry: &mut [Vec<f32>; 2], ctx: &ProcessContext, n: usize, max_lat: usize) {
        let mut lat = 0usize;
        for d in chain.devs.iter_mut() {
            if !d.enabled || d.mix <= 0.0 {
                continue;
            }
            let mix = d.mix.min(1.0);
            if mix < 1.0 {
                dry[0][..n].copy_from_slice(&chain.l[..n]);
                dry[1][..n].copy_from_slice(&chain.r[..n]);
                let [dl, dr] = dry;
                d.fx.align_dry([&mut dl[..n], &mut dr[..n]]);
            }
            d.fx.process(ctx, [&mut chain.l[..n], &mut chain.r[..n]], None);
            if mix < 1.0 {
                let w = 1.0 - mix;
                for i in 0..n {
                    chain.l[i] = dry[0][i] * w + chain.l[i] * mix;
                    chain.r[i] = dry[1][i] * w + chain.r[i] * mix;
                }
            }
            lat += d.fx.latency();
        }
        // NaN / Inf guard: silence the bad samples and clear the devices' state.
        let mut bad = false;
        for i in 0..n {
            if !chain.l[i].is_finite() {
                chain.l[i] = 0.0;
                bad = true;
            }
            if !chain.r[i].is_finite() {
                chain.r[i] = 0.0;
                bad = true;
            }
        }
        if bad {
            for d in chain.devs.iter_mut() {
                d.fx.reset();
            }
        }
        // PDC: delay this chain by (max − own) latency so parallel chains line up.
        let delay = max_lat.saturating_sub(lat.min(MAX_ALIGN - 1));
        if delay > 0 {
            let mask = MAX_ALIGN - 1;
            let [pl, pr] = &mut chain.pdc;
            let mut w = chain.pdc_w;
            for i in 0..n {
                let rd = (w + MAX_ALIGN - delay) & mask;
                pl[w] = chain.l[i];
                pr[w] = chain.r[i];
                chain.l[i] = pl[rd];
                chain.r[i] = pr[rd];
                w = (w + 1) & mask;
            }
            chain.pdc_w = w;
        } else {
            // Keep the ring current, so a later latency change doesn't replay stale audio.
            let mask = MAX_ALIGN - 1;
            let mut w = chain.pdc_w;
            for i in 0..n {
                chain.pdc[0][w] = chain.l[i];
                chain.pdc[1][w] = chain.r[i];
                w = (w + 1) & mask;
            }
            chain.pdc_w = w;
        }
    }

    /// [RT] Add chain output × its (ramped) gain into `out`.
    fn mix_into(chain: &mut ChainRt, solo_any: bool, n: usize, out_l: &mut [f32], out_r: &mut [f32]) {
        let (tl, tr) = if chain.audible(solo_any) {
            let p = chain.pan.clamp(-1.0, 1.0);
            (chain.vol * (1.0 - p.max(0.0)), chain.vol * (1.0 + p.min(0.0)))
        } else {
            (0.0, 0.0)
        };
        if chain.fresh {
            chain.gl = tl;
            chain.gr = tr;
            chain.fresh = false;
        }
        let (gl0, gr0) = (chain.gl, chain.gr);
        chain.gl = tl;
        chain.gr = tr;
        if gl0 == 0.0 && gr0 == 0.0 && tl == 0.0 && tr == 0.0 {
            return;
        }
        let inv = 1.0 / n as f32;
        for i in 0..n {
            let a = (i + 1) as f32 * inv;
            out_l[i] += chain.l[i] * (gl0 + (tl - gl0) * a);
            out_r[i] += chain.r[i] * (gr0 + (tr - gr0) * a);
        }
    }
}

/// Stand-in for a device the factory refused: passes audio through.
struct Thru;

impl Effect for Thru {
    fn prepare(&mut self, _sample_rate: f32, _max_frames: usize) {}
    fn set_param(&mut self, _index: usize, _value: f32) {}
    fn process(&mut self, _ctx: &ProcessContext, _buf: [&mut [f32]; 2], _sidechain: Option<[&[f32]; 2]>) {}
    fn reset(&mut self) {}
}

#[inline]
fn silent(x: &[f32]) -> bool {
    x.iter().all(|v| v.abs() < 1e-7)
}

#[inline]
fn flush_bad(x: &mut [f32]) {
    for v in x.iter_mut() {
        if !v.is_finite() || v.abs() < 1e-30 {
            *v = 0.0;
        }
    }
}

// ── Instrument / drum rack ───────────────────────────────────────────────

pub struct RackInstrument {
    core: RackCore,
    drum: bool,
    peak: f32,
}

/// Build an instrument or drum rack from its plan (control thread).
pub fn build_instrument(plan: &RackPlan, host: &PluginHost, sr: f32, max_frames: usize) -> Box<dyn Instrument> {
    Box::new(RackInstrument { core: RackCore::new(plan, host, sr, max_frames), drum: plan.kind == RackKind::Drum, peak: 0.0 })
}

impl RackInstrument {
    /// Pitch offset of chain `c`: instrument racks play like a channel with
    /// rootKey 60; drum pads play their instrument at its root (sample root,
    /// else C4 = 60) on the zone's lowest key, so a pad sounds the same on any note.
    #[inline]
    fn shift(&self, c: &ChainRt) -> f32 {
        let base = if self.drum { c.key_lo as f32 } else { 60.0 };
        match c.sample_root {
            Some(root) => root - base,
            None if self.drum => 60.0 - base,
            None => 0.0,
        }
    }
}

impl Instrument for RackInstrument {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        self.core.prepare(sample_rate, max_frames);
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.core.set_param(index, value);
    }

    fn set_voice_mode(&mut self, mono: bool, glide_ms: f32) {
        for c in self.core.chains.iter_mut() {
            if let Some(i) = c.inst.as_mut() {
                i.set_voice_mode(mono, glide_ms);
            }
        }
    }

    fn note_on(&mut self, offset: usize, key: u8, pitch: f32, velocity: f32, extras: NoteExtras) {
        let solo_any = self.core.solo_any();
        for ci in 0..self.core.chains.len() {
            let (hit, choke) = {
                let c = &self.core.chains[ci];
                (c.inst.is_some() && c.audible(solo_any) && c.in_zone(key, velocity), c.choke)
            };
            if !hit {
                continue;
            }
            if self.drum && choke > 0 {
                for (cj, other) in self.core.chains.iter_mut().enumerate() {
                    if cj != ci && other.choke == choke {
                        if let Some(i) = other.inst.as_mut() {
                            i.choke(offset);
                        }
                    }
                }
            }
            let shift = self.shift(&self.core.chains[ci]);
            let c = &mut self.core.chains[ci];
            if let Some(i) = c.inst.as_mut() {
                i.note_on(offset, key, pitch + shift, velocity, extras);
                c.kick = true;
            }
        }
    }

    fn note_off(&mut self, offset: usize, key: u8) {
        // Every chain: a zone edit between on and off must not leave notes hanging.
        for c in self.core.chains.iter_mut() {
            if let Some(i) = c.inst.as_mut() {
                i.note_off(offset, key);
            }
        }
    }

    fn choke(&mut self, offset: usize) {
        for c in self.core.chains.iter_mut() {
            if let Some(i) = c.inst.as_mut() {
                i.choke(offset);
            }
        }
    }

    fn all_off(&mut self) {
        for c in self.core.chains.iter_mut() {
            if let Some(i) = c.inst.as_mut() {
                i.all_off();
            }
        }
        self.core.reset();
    }

    fn process(&mut self, ctx: &ProcessContext, out: [&mut [f32]; 2]) {
        let [out_l, out_r] = out;
        let total = ctx.frames.min(out_l.len()).min(out_r.len());
        let solo_any = self.core.solo_any();
        let max_lat = self.core.latency();
        let need = self.core.quiet_need;
        let mut pk = 0f32;
        let mut at = 0;
        while at < total {
            let n = (total - at).min(self.core.cap);
            let sub = ProcessContext { frames: n, ..*ctx };
            let RackCore { chains, dry, .. } = &mut self.core;
            for c in chains.iter_mut() {
                let inst_active = c.inst.as_ref().is_some_and(|i| i.is_active());
                // Devices (tails) or a PDC delay (audio still in the ring): sleep only after 0.5 s of silence.
                let tail = (!c.devs.is_empty() || max_lat > 0) && (c.never_sleep || c.quiet < need);
                if !(c.kick || inst_active || tail) {
                    // Asleep: no work; the gains jump when it wakes.
                    c.fresh = true;
                    continue;
                }
                c.kick = false;
                c.l[..n].fill(0.0);
                c.r[..n].fill(0.0);
                if let Some(i) = c.inst.as_mut() {
                    i.process(&sub, [&mut c.l[..n], &mut c.r[..n]]);
                }
                RackCore::run_chain(c, dry, &sub, n, max_lat);
                c.quiet = if silent(&c.l[..n]) && silent(&c.r[..n]) { c.quiet.saturating_add(n as u32) } else { 0 };
                RackCore::mix_into(c, solo_any, n, &mut out_l[at..at + n], &mut out_r[at..at + n]);
            }
            flush_bad(&mut out_l[at..at + n]);
            flush_bad(&mut out_r[at..at + n]);
            for i in at..at + n {
                pk = pk.max(out_l[i].abs()).max(out_r[i].abs());
            }
            at += n;
        }
        self.peak = pk;
    }

    fn activity(&self) -> f32 {
        self.peak
    }

    /// The longest chain's device latency: chains are aligned to it inside the
    /// rack, and the engine compensates it against other channels (channel PDC).
    fn latency(&self) -> usize {
        self.core.latency()
    }

    fn is_active(&self) -> bool {
        let need = self.core.quiet_need;
        let pdc = self.core.latency() > 0;
        self.core
            .chains
            .iter()
            .any(|c| c.kick || c.inst.as_ref().is_some_and(|i| i.is_active()) || ((!c.devs.is_empty() || pdc) && (c.never_sleep || c.quiet < need)))
    }
}

// ── Effect rack ──────────────────────────────────────────────────────────

pub struct RackEffect {
    core: RackCore,
    inp: [Vec<f32>; 2],
    acc: [Vec<f32>; 2],
}

/// Build an FX rack from its plan (control thread). The compiler wraps it in
/// `fxmix::LatencyAligned` like every slot effect.
pub fn build_effect(plan: &RackPlan, host: &PluginHost, sr: f32, max_frames: usize) -> Box<dyn Effect> {
    let core = RackCore::new(plan, host, sr, max_frames);
    let cap = core.cap;
    Box::new(RackEffect { core, inp: [vec![0.0; cap], vec![0.0; cap]], acc: [vec![0.0; cap], vec![0.0; cap]] })
}

impl Effect for RackEffect {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        self.core.prepare(sample_rate, max_frames);
        let cap = self.core.cap;
        for b in self.inp.iter_mut().chain(self.acc.iter_mut()) {
            if b.len() < cap {
                b.resize(cap, 0.0);
            }
        }
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.core.set_param(index, value);
    }

    fn process(&mut self, ctx: &ProcessContext, buf: [&mut [f32]; 2], _sidechain: Option<[&[f32]; 2]>) {
        let [bl, br] = buf;
        let total = ctx.frames.min(bl.len()).min(br.len());
        if self.core.chains.is_empty() {
            // An empty rack passes audio through (like an empty insert).
            flush_bad(&mut bl[..total]);
            flush_bad(&mut br[..total]);
            return;
        }
        let solo_any = self.core.solo_any();
        let max_lat = self.core.latency();
        let mut at = 0;
        while at < total {
            let n = (total - at).min(self.core.cap);
            let sub = ProcessContext { frames: n, ..*ctx };
            let [il, ir] = &mut self.inp;
            il[..n].copy_from_slice(&bl[at..at + n]);
            ir[..n].copy_from_slice(&br[at..at + n]);
            flush_bad(&mut il[..n]);
            flush_bad(&mut ir[..n]);
            let [al, ar] = &mut self.acc;
            al[..n].fill(0.0);
            ar[..n].fill(0.0);
            let RackCore { chains, dry, .. } = &mut self.core;
            for c in chains.iter_mut() {
                c.l[..n].copy_from_slice(&il[..n]);
                c.r[..n].copy_from_slice(&ir[..n]);
                RackCore::run_chain(c, dry, &sub, n, max_lat);
                RackCore::mix_into(c, solo_any, n, &mut al[..n], &mut ar[..n]);
            }
            flush_bad(&mut al[..n]);
            flush_bad(&mut ar[..n]);
            bl[at..at + n].copy_from_slice(&al[..n]);
            br[at..at + n].copy_from_slice(&ar[..n]);
            at += n;
        }
    }

    fn latency(&self) -> usize {
        self.core.latency()
    }

    fn reset(&mut self) {
        self.core.reset();
    }
}
