#![allow(dead_code)]
//! Test helpers shared by the integration tests.

use std::sync::Arc;

use krypt_studio_dsp::{descriptor, Effect, Instrument, NoteExtras, ProcessContext, SampleData};

pub const SR: f32 = 48000.0;
pub const BLOCK: usize = 256;

pub fn ctx(frames: usize, beat_pos: f64, bpm: f64, playing: bool) -> ProcessContext {
    ProcessContext { sample_rate: SR, bpm, beats_per_bar: 4.0, playing, beat_pos, frames }
}

/// A decaying stereo test sample: 440 Hz sine + 2nd harmonic at `sr`.
pub fn test_sample(sr: f32, secs: f32, root: Option<u8>) -> Arc<SampleData> {
    let n = (secs * sr) as usize;
    let l: Vec<f32> = (0..n)
        .map(|i| {
            let t = i as f64 / sr as f64;
            let e = (-t * 3.0).exp();
            (0.6 * (std::f64::consts::TAU * 440.0 * t).sin() + 0.2 * (std::f64::consts::TAU * 880.0 * t).sin()) as f32 * e as f32
        })
        .collect();
    let r = l.iter().map(|v| v * 0.9).collect();
    Arc::new(SampleData { sample_rate: sr, channels: vec![l, r], root_key: root })
}

/// Pure sine sample (mono) for pitch tests.
pub fn sine_sample(sr: f32, hz: f64, secs: f32, root: Option<u8>) -> Arc<SampleData> {
    let n = (secs * sr) as usize;
    let l = (0..n).map(|i| (0.5 * (std::f64::consts::TAU * hz * i as f64 / sr as f64).sin()) as f32).collect();
    Arc::new(SampleData { sample_rate: sr, channels: vec![l], root_key: root })
}

/// Render an instrument for `frames`, returning (L, R).
pub fn render_inst(inst: &mut dyn Instrument, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let mut l = vec![0.0f32; frames];
    let mut r = vec![0.0f32; frames];
    let mut at = 0;
    while at < frames {
        let n = (frames - at).min(BLOCK);
        inst.process(&ctx(n, 0.0, 120.0, true), [&mut l[at..at + n], &mut r[at..at + n]]);
        at += n;
    }
    (l, r)
}

/// Run an effect over a stereo signal in blocks, in place, with an optional sidechain.
pub fn run_fx(fx: &mut dyn Effect, l: &mut [f32], r: &mut [f32], bpm: f64, sc: Option<(&[f32], &[f32])>) {
    let frames = l.len();
    let mut at = 0;
    let beats_per_sample = bpm / 60.0 / SR as f64;
    while at < frames {
        let n = (frames - at).min(BLOCK);
        let c = ctx(n, at as f64 * beats_per_sample, bpm, true);
        let side = sc.map(|(a, b)| [&a[at..at + n], &b[at..at + n]]);
        fx.process(&c, [&mut l[at..at + n], &mut r[at..at + n]], side);
        at += n;
    }
}

pub fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

pub fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len().max(1) as f64).sqrt() as f32
}

pub fn noise(n: usize, seed: u32, amp: f32) -> Vec<f32> {
    let mut s = seed.max(1);
    (0..n)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            ((s >> 8) as f32 / 16_777_216.0 * 2.0 - 1.0) * amp
        })
        .collect()
}

/// Estimate the fundamental from rising zero crossings.
pub fn zc_freq(x: &[f32], sr: f32) -> f32 {
    let mut first = None;
    let mut last = 0usize;
    let mut count = 0;
    for i in 1..x.len() {
        if x[i - 1] <= 0.0 && x[i] > 0.0 {
            if first.is_none() {
                first = Some(i);
            } else {
                count += 1;
            }
            last = i;
        }
    }
    match first {
        Some(f) if count > 0 => count as f32 * sr / (last - f) as f32,
        _ => 0.0,
    }
}

pub fn param(id: &str, p: &str) -> usize {
    descriptor(id).unwrap().param_index(p).unwrap_or_else(|| panic!("{id}.{p}"))
}

pub fn note(inst: &mut dyn Instrument, offset: usize, key: u8, vel: f32) {
    inst.note_on(offset, key, key as f32, vel, NoteExtras::default());
}
