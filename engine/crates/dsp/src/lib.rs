//! krypt-studio-dsp — pure DSP for Krypt Studio: the stock instruments and
//! effects, the plugin catalog (source of truth for every ParamSpec), the
//! procedural factory drum kit, and offline audio analysis.
//!
//! No I/O threads, no device code, no project model. The engine crate owns
//! scheduling and routing and talks to plugins ONLY through the traits below.
//!
//! REAL-TIME RULES (every method marked [RT] runs on the audio thread):
//! no allocation, no locks, no I/O, no panics. Allocate in `new`/`prepare`.

use serde::Serialize;
use std::sync::Arc;

pub mod catalog;

// ── Plugin descriptors (mirrors shared/plugins/types.ts) ─────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamSpec {
    pub id: &'static str,
    pub name: &'static str,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub min: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub max: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub default: f32,
    /// '', 'dB', 'Hz', 'ms', 's', 'st', 'ct', '%', 'x', 'bpm', 'deg'
    pub unit: &'static str,
    /// 'linear' | 'log' | 'gain'
    pub scale: &'static str,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "crate::serde_clean::opt_f32")]
    pub step: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<&'static str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automatable: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Instrument,
    Effect,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: PluginKind,
    pub category: &'static str,
    pub description: &'static str,
    pub params: Vec<ParamSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uses_sample: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidechain: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "crate::serde_clean::opt_f32")]
    pub default_mix: Option<f32>,
}

impl PluginDescriptor {
    /// Index of a param id (the engine resolves ids → indices once, off the audio thread).
    pub fn param_index(&self, id: &str) -> Option<usize> {
        self.params.iter().position(|p| p.id == id)
    }
}

// ── Shared runtime types ─────────────────────────────────────────────────

/// Decoded audio, at its ORIGINAL sample rate (the sampler resamples on the fly).
#[derive(Debug)]
pub struct SampleData {
    pub sample_rate: f32,
    /// One Vec per channel (1 = mono, 2 = stereo). All the same length.
    pub channels: Vec<Vec<f32>>,
    /// Root key from the WAV `smpl` chunk, if present.
    pub root_key: Option<u8>,
}

impl SampleData {
    pub fn frames(&self) -> usize {
        self.channels.first().map(|c| c.len()).unwrap_or(0)
    }
}

/// Per-block context handed to every plugin.
#[derive(Debug, Clone, Copy)]
pub struct ProcessContext {
    pub sample_rate: f32,
    /// Current tempo.
    pub bpm: f64,
    pub playing: bool,
    /// Musical position at the first sample of the block, in beats (quarter notes).
    pub beat_pos: f64,
    /// Quarter notes per bar from the time signature (4/4 = 4, 3/4 = 3, 6/8 = 3, 7/8 = 3.5): tempo-synced
    /// "bar" divisions use it.
    pub beats_per_bar: f64,
    /// Frames in this block (<= the max block size given to `prepare`).
    pub frames: usize,
}

/// Extra per-note data from the piano roll.
#[derive(Debug, Clone, Copy)]
pub struct NoteExtras {
    pub pan: f32,     // -1..1
    pub fine: f32,    // cents
    pub mod_x: f32,   // 0..1
    pub mod_y: f32,   // 0..1
    pub slide: bool,  // glide from the previous note instead of retriggering
    pub release: f32, // note-off velocity 0..1
    /// Seconds into the sample to start playback (audio clips started mid-clip,
    /// clip offsets). Sample instruments add their own `start` param on top.
    pub sample_start: f64,
}

impl Default for NoteExtras {
    fn default() -> Self {
        Self { pan: 0.0, fine: 0.0, mod_x: 0.5, mod_y: 0.5, slide: false, release: 0.5, sample_start: 0.0 }
    }
}

/// A sound generator (one per Channel Rack channel).
pub trait Instrument: Send {
    /// Called whenever sample rate or max block size changes (may allocate).
    fn prepare(&mut self, sample_rate: f32, max_frames: usize);
    /// [RT] Set a parameter by index into the descriptor's params, plain units.
    fn set_param(&mut self, index: usize, value: f32);
    /// Set (or clear) the sample for sample-based instruments. Not [RT]-called:
    /// the engine swaps samples from its control path between blocks.
    fn set_sample(&mut self, _sample: Option<Arc<SampleData>>) {}
    /// Set (or clear) a multisample instrument (krypt.multisampler: an SFZ
    /// mapping decoded off the audio thread). Not [RT]-called, like `set_sample`.
    fn set_multisample(&mut self, _set: Option<Arc<instruments::multisampler::MultiSampleSet>>) {}
    /// Set (or clear) the slice map of a slicing instrument (krypt.slicer: `Generator.slices`). Not [RT]-called,
    /// like `set_sample`.
    fn set_slices(&mut self, _slices: Option<Arc<instruments::slicer::SliceSet>>) {}
    /// [RT] Channel voice mode: mono legato + glide time (808 slides).
    fn set_voice_mode(&mut self, _mono: bool, _glide_ms: f32) {}
    /// [RT] Start a note `offset` frames into the next process() block.
    /// `pitch` is a fractional MIDI note (key + channel pitch + fine already applied).
    fn note_on(&mut self, offset: usize, key: u8, pitch: f32, velocity: f32, extras: NoteExtras);
    /// [RT] Release a note.
    fn note_off(&mut self, offset: usize, key: u8);
    /// [RT] Choke all voices quickly (cut groups) — a ~2 ms fade, not a click.
    fn choke(&mut self, offset: usize);
    /// [RT] Kill everything immediately (transport stop / panic).
    fn all_off(&mut self);
    /// [RT] Render `ctx.frames` frames, ADDING into out[0] (L) and out[1] (R).
    fn process(&mut self, ctx: &ProcessContext, out: [&mut [f32]; 2]);
    /// Rough activity level 0..1 for the Channel Rack LED (peak of last block).
    fn activity(&self) -> f32 {
        0.0
    }
    /// True if any voice is sounding (lets the engine skip silent channels).
    fn is_active(&self) -> bool;
    /// Latency in samples between a note and its sound (lookahead inside the
    /// instrument, e.g. an instrument rack whose chains hold latent effects).
    /// The engine delays the other channels by it (plugin delay compensation,
    /// docs/ENGINE_PROTOCOL.md §12). Stock instruments have none.
    fn latency(&self) -> usize {
        0
    }
}

/// An insert effect (one per mixer FX slot).
pub trait Effect: Send {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize);
    /// [RT] Set a parameter by index into the descriptor's params, plain units.
    fn set_param(&mut self, index: usize, value: f32);
    /// [RT] Process in place. `sidechain` is the post-fader signal of the
    /// slot's sidechainFrom insert (only for descriptors with sidechain).
    fn process(&mut self, ctx: &ProcessContext, buf: [&mut [f32]; 2], sidechain: Option<[&[f32]; 2]>);
    /// Latency in samples this effect adds (for plugin delay compensation).
    fn latency(&self) -> usize {
        0
    }
    /// [RT] Clear internal state (tails) — transport stop / locate.
    fn reset(&mut self);
    /// [RT] Delay a copy of this effect's dry input by its latency, so a slot mix below 100 % blends aligned
    /// signals. Default: nothing (the engine wraps every effect in `fxmix::LatencyAligned`, which does it).
    fn align_dry(&mut self, _dry: [&mut [f32]; 2]) {}
    /// [RT] Gain-reduction meter (docs/ENGINE_PROTOCOL.md §15): how many dB (>= 0) the effect is turning the
    /// signal down right now (compressors, limiter, ducker, gate; the clipper reports how far its input goes
    /// over the ceiling). None = this effect has no GR meter. Called once per processed block; no allocation.
    fn meter(&self) -> Option<f32> {
        None
    }
}

/// Create a stock instrument by plugin id. None for unknown ids.
pub fn create_instrument(id: &str, sample_rate: f32, max_frames: usize) -> Option<Box<dyn Instrument>> {
    catalog::create_instrument(id, sample_rate, max_frames)
}

/// Create a stock effect by plugin id. None for unknown ids.
pub fn create_effect(id: &str, sample_rate: f32, max_frames: usize) -> Option<Box<dyn Effect>> {
    catalog::create_effect(id, sample_rate, max_frames)
}

/// Every stock plugin descriptor. `--dump-catalog` serializes this to
/// shared/plugins/catalog.gen.json as {"version":1,"plugins":[...]}.
pub fn descriptors() -> Vec<PluginDescriptor> {
    catalog::descriptors()
}

pub fn descriptor(id: &str) -> Option<PluginDescriptor> {
    descriptors().into_iter().find(|d| d.id == id)
}

// ── Param value mapping (identical to shared/plugins/types.ts) ───────────

pub fn clamp_to_spec(spec: &ParamSpec, v: f32) -> f32 {
    let mut x = if v.is_finite() { v.clamp(spec.min, spec.max) } else { spec.default };
    if let Some(step) = spec.step {
        if step > 0.0 {
            x = ((x - spec.min) / step).round() * step + spec.min;
        }
    }
    x
}

/// Normalized 0..1 → plain value (automation playback).
pub fn from_normalized(spec: &ParamSpec, n: f32) -> f32 {
    let t = n.clamp(0.0, 1.0);
    let v = match spec.scale {
        "log" => spec.min * (spec.max / spec.min).powf(t),
        "gain" => spec.max * t * t * t,
        _ => spec.min + t * (spec.max - spec.min),
    };
    clamp_to_spec(spec, v)
}

pub fn to_normalized(spec: &ParamSpec, v: f32) -> f32 {
    let x = clamp_to_spec(spec, v);
    if spec.max == spec.min {
        return 0.0;
    }
    match spec.scale {
        "log" => (x / spec.min).ln() / (spec.max / spec.min).ln(),
        "gain" => (x / spec.max).cbrt(),
        _ => (x - spec.min) / (spec.max - spec.min),
    }
}

#[cfg(feature = "decode")]
pub mod decode;
pub mod analysis;
pub mod factory;
pub mod mp3;
/// Live meters and scopes for watched FX slots (spectrum, oscilloscope, LUFS, true peak, correlation).
pub mod scope;

// DSP building blocks, stock instruments/effects and helpers (implementation).
pub mod blocks;
pub mod effects;
pub mod instruments;
mod params;
mod serde_clean;
pub mod wav;
