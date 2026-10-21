//! Gain-reduction meters (`Effect::meter`, docs/ENGINE_PROTOCOL.md §15) on a level step, processed in
//! the engine's 32-frame sub-blocks.

use crate::{create_effect, descriptor, Effect, ProcessContext};

const SR: f32 = 48000.0;
const SUB: usize = 32;

fn fx(id: &str, params: &[(&str, f32)]) -> Box<dyn Effect> {
    let d = descriptor(id).unwrap();
    let mut e = create_effect(id, SR, 512).unwrap();
    for (pid, v) in params {
        e.set_param(d.param_index(pid).unwrap_or_else(|| panic!("{id}: no param {pid}")), *v);
    }
    e
}

/// Run `level(i)` (both channels) through the effect; returns the meter after each sub-block.
fn run(e: &mut dyn Effect, frames: usize, level: impl Fn(usize) -> f32) -> Vec<f32> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < frames {
        let n = SUB.min(frames - at);
        let mut l: Vec<f32> = (at..at + n).map(&level).collect();
        let mut r = l.clone();
        let ctx = ProcessContext { sample_rate: SR, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: at as f64 / SR as f64 * 2.0, frames: n };
        e.process(&ctx, [&mut l, &mut r], None);
        out.push(e.meter().expect("dynamics effects report a meter"));
        at += n;
    }
    out
}

const STEP: usize = 24000; // 0.5 s quiet, then loud

fn sine(i: usize, amp: f32) -> f32 {
    amp * (std::f32::consts::TAU * 1000.0 * i as f32 / SR).sin()
}

#[test]
fn comp_reads_its_static_curve_on_a_step() {
    // −8 dBFS (RMS detector, peak-referenced) into −20 dB at 4:1, hard knee → 12 · 3/4 = 9 dB
    let mut e = fx("krypt.comp", &[("threshold", -20.0), ("ratio", 4.0), ("knee", 0.0), ("attack", 1.0), ("release", 100.0)]);
    let amp_hi = 10f32.powf(-8.0 / 20.0);
    let m = run(e.as_mut(), STEP + 24000, |i| sine(i, if i < STEP { 0.01 } else { amp_hi }));
    let before = m[STEP / SUB - 1];
    let after = *m.last().unwrap();
    assert!(before < 0.01, "quiet input: {before} dB");
    assert!((after - 9.0).abs() < 0.4, "loud input: {after} dB");
}

#[test]
fn glue_reads_ratio_reduction_on_a_step() {
    // 20 dB over the threshold at 2:1 (6 dB knee far away) → 10 dB
    let mut e = fx("krypt.glue", &[("threshold", -20.0), ("ratio", 0.0), ("attack", 2.0), ("release", 1.0)]);
    let m = run(e.as_mut(), STEP + 48000, |i| if i < STEP { 0.01 } else { 1.0 });
    assert!(m[STEP / SUB - 1] < 0.01);
    let after = *m.last().unwrap();
    assert!((after - 10.0).abs() < 0.1, "{after}");
    // with its own Mix at 50 % the meter shows what is applied: −20·log10(0.5 + 0.5 · 10^(−10/20)) ≈ 3.6 dB
    let mut half = fx("krypt.glue", &[("threshold", -20.0), ("ratio", 0.0), ("attack", 2.0), ("release", 1.0), ("mix", 0.5)]);
    let m = run(half.as_mut(), STEP + 48000, |i| if i < STEP { 0.01 } else { 1.0 });
    let want = -20.0 * (0.5 + 0.5 * 10f32.powf(-0.5)).log10();
    assert!((m.last().unwrap() - want).abs() < 0.1, "{} vs {want}", m.last().unwrap());
}

#[test]
fn limiter_reads_the_overshoot_above_its_ceiling() {
    // 0 dBFS into a −6 dB ceiling → 6 dB (+ the 0.03 dB safety margin)
    let mut e = fx("krypt.limiter", &[("ceiling", -6.0), ("truePeak", 0.0)]);
    let m = run(e.as_mut(), STEP + 24000, |i| if i < STEP { 0.1 } else { 1.0 });
    assert!(m[STEP / SUB - 1] < 0.01, "{}", m[STEP / SUB - 1]);
    let after = *m.last().unwrap();
    assert!((after - 6.03).abs() < 0.05, "{after}");
}

#[test]
fn other_dynamics_meters_move() {
    // Squash pulls a hot signal down
    let mut sq = fx("krypt.squash", &[]);
    let m = run(sq.as_mut(), 24000, |i| sine(i, 0.9));
    assert!(*m.last().unwrap() > 3.0, "squash {}", m.last().unwrap());
    // Clipper: 0.5 driven by +12 dB over a −0.1 dB ceiling ≈ 6.1 dB over
    let mut cl = fx("krypt.clipper", &[("drive", 12.0), ("ceiling", -0.1)]);
    let m = run(cl.as_mut(), 4800, |_| 0.5);
    let want = 20.0 * (0.5 * 10f32.powf(0.6) / 10f32.powf(-0.1 / 20.0)).log10();
    assert!((m.last().unwrap() - want).abs() < 0.1, "clipper {} vs {want}", m.last().unwrap());
    let m = run(fx("krypt.clipper", &[]).as_mut(), 4800, |_| 0.5);
    assert_eq!(*m.last().unwrap(), 0.0);
    // Duck (tempo shape) dips on every beat while playing
    let mut du = fx("krypt.duck", &[("depth", 0.8)]);
    let m = run(du.as_mut(), 48000, |_| 0.5);
    let max = m.iter().fold(0f32, |a, &v| a.max(v));
    assert!(max > 6.0 && max < 20.0, "duck {max}");
    // effects without a GR meter report None
    assert!(fx("krypt.eq", &[]).meter().is_none());
    assert!(fx("krypt.analyzer", &[]).meter().is_none());
}
