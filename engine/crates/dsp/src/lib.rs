use serde::Serialize;
use std::sync::Arc;

pub mod catalog;

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
    pub unit: &'static str,
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
    pub fn param_index(&self, id: &str) -> Option<usize> {
        self.params.iter().position(|p| p.id == id)
    }
}

#[derive(Debug)]
pub struct SampleData {
    pub sample_rate: f32,
    pub channels: Vec<Vec<f32>>,
    pub root_key: Option<u8>,
}

impl SampleData {
    pub fn frames(&self) -> usize {
        self.channels.first().map(|c| c.len()).unwrap_or(0)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ProcessContext {
    pub sample_rate: f32,
    pub bpm: f64,
    pub playing: bool,
    pub beat_pos: f64,
    pub beats_per_bar: f64,
    pub frames: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct NoteExtras {
    pub pan: f32,
    pub fine: f32,
    pub mod_x: f32,
    pub mod_y: f32,
    pub slide: bool,
    pub release: f32,
    pub sample_start: f64,
}

impl Default for NoteExtras {
    fn default() -> Self {
        Self { pan: 0.0, fine: 0.0, mod_x: 0.5, mod_y: 0.5, slide: false, release: 0.5, sample_start: 0.0 }
    }
}

pub trait Instrument: Send {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize);
    fn set_param(&mut self, index: usize, value: f32);
    fn set_sample(&mut self, _sample: Option<Arc<SampleData>>) {}
    fn set_multisample(&mut self, _set: Option<Arc<instruments::multisampler::MultiSampleSet>>) {}
    fn set_slices(&mut self, _slices: Option<Arc<instruments::slicer::SliceSet>>) {}
    fn set_voice_mode(&mut self, _mono: bool, _glide_ms: f32) {}
    fn note_on(&mut self, offset: usize, key: u8, pitch: f32, velocity: f32, extras: NoteExtras);
    fn note_off(&mut self, offset: usize, key: u8);
    fn choke(&mut self, offset: usize);
    fn all_off(&mut self);
    fn process(&mut self, ctx: &ProcessContext, out: [&mut [f32]; 2]);
    fn activity(&self) -> f32 {
        0.0
    }
    fn is_active(&self) -> bool;
    fn latency(&self) -> usize {
        0
    }
}

pub trait Effect: Send {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize);
    fn set_param(&mut self, index: usize, value: f32);
    fn process(&mut self, ctx: &ProcessContext, buf: [&mut [f32]; 2], sidechain: Option<[&[f32]; 2]>);
    fn latency(&self) -> usize {
        0
    }
    fn reset(&mut self);
    fn align_dry(&mut self, _dry: [&mut [f32]; 2]) {}
    fn meter(&self) -> Option<f32> {
        None
    }
}

pub fn create_instrument(id: &str, sample_rate: f32, max_frames: usize) -> Option<Box<dyn Instrument>> {
    catalog::create_instrument(id, sample_rate, max_frames)
}

pub fn create_effect(id: &str, sample_rate: f32, max_frames: usize) -> Option<Box<dyn Effect>> {
    catalog::create_effect(id, sample_rate, max_frames)
}

pub fn descriptors() -> Vec<PluginDescriptor> {
    catalog::descriptors()
}

pub fn descriptor(id: &str) -> Option<PluginDescriptor> {
    descriptors().into_iter().find(|d| d.id == id)
}

pub fn clamp_to_spec(spec: &ParamSpec, v: f32) -> f32 {
    let mut x = if v.is_finite() { v.clamp(spec.min, spec.max) } else { spec.default };
    if let Some(step) = spec.step {
        if step > 0.0 {
            x = ((x - spec.min) / step).round() * step + spec.min;
        }
    }
    x
}

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
pub mod scope;

pub mod blocks;
pub mod effects;
pub mod instruments;
mod params;
mod serde_clean;
pub mod wav;
