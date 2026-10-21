//! Effect behaviour: silence, tails, latency, extreme params, limiter
//! ceiling incl. true peak, EQ accuracy, sidechain, tempo sync.

mod common;
use common::*;

use ebur128::{EbuR128, Mode};
use krypt_studio_dsp::{create_effect, descriptors, Effect, PluginKind};

fn effect_ids() -> Vec<&'static str> {
    descriptors().into_iter().filter(|d| d.kind == PluginKind::Effect).map(|d| d.id).collect()
}

fn fx(id: &str) -> Box<dyn Effect> {
    create_effect(id, SR, BLOCK).unwrap()
}

#[test]
fn silence_in_gives_silence_out() {
    for id in effect_ids() {
        // fresh instance: digital silence stays digital silence
        let mut e = fx(id);
        let mut l = vec![0.0f32; 48000];
        let mut r = vec![0.0f32; 48000];
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        assert_eq!(peak(&l).max(peak(&r)), 0.0, "{id} made noise from silence");
        // after a loud burst, tails decay to (near) silence
        let mut l = noise(48000, 3, 0.7);
        let mut r = noise(48000, 4, 0.7);
        l.extend(std::iter::repeat_n(0.0, 48000 * 12));
        r.extend(std::iter::repeat_n(0.0, 48000 * 12));
        let mut e = fx(id);
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        let n = l.len();
        let tail = peak(&l[n - 4800..]).max(peak(&r[n - 4800..]));
        assert!(tail < 1e-5, "{id} tail did not decay: {tail}");
    }
}

#[test]
fn reset_clears_tails() {
    for id in effect_ids() {
        let mut e = fx(id);
        let mut l = noise(24000, 5, 0.8);
        let mut r = noise(24000, 6, 0.8);
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        e.reset();
        let mut l = vec![0.0f32; 9600];
        let mut r = vec![0.0f32; 9600];
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        assert!(peak(&l).max(peak(&r)) < 1e-6, "{id} kept a tail after reset: {}", peak(&l));
    }
}

#[test]
fn extreme_params_stay_finite() {
    let mut seed = 77u32;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (seed >> 8) as f32 / 16_777_216.0
    };
    for d in descriptors().into_iter().filter(|d| d.kind == PluginKind::Effect) {
        for round in 0..16 {
            let mut e = fx(d.id);
            for (i, p) in d.params.iter().enumerate() {
                let v = match round {
                    0 => p.min,
                    1 => p.max,
                    2 => f32::NAN,
                    3 => -1e30,
                    _ => p.min + (p.max - p.min) * rnd(),
                };
                e.set_param(i, v);
            }
            let mut l = noise(9600, round + 1, 1.0);
            let mut r = noise(9600, round + 2, 1.0);
            l[100] = 1e6; // a spike
            r[200] = f32::NAN; // and garbage
            let sc_l = noise(9600, 9, 1.0);
            let sc_r = noise(9600, 10, 1.0);
            run_fx(e.as_mut(), &mut l, &mut r, if round == 5 { 1e-9 } else { 40.0 + 200.0 * rnd() as f64 }, Some((&sc_l, &sc_r)));
            for v in l.iter().chain(&r) {
                assert!(v.is_finite(), "{} round {round}: {v}", d.id);
            }
        }
    }
}

#[test]
fn reported_latency_matches_impulse_delay() {
    let cases: &[(&str, &[(&str, f32)])] = &[
        ("krypt.limiter", &[]),
        ("krypt.clipper", &[("oversample", 0.0)]),
        ("krypt.clipper", &[("oversample", 1.0)]),
        ("krypt.clipper", &[("oversample", 2.0)]),
        ("krypt.drive", &[("drive", 0.0), ("tone", 20000.0)]),
        ("krypt.eq", &[]),
        ("krypt.comp", &[]),
        ("krypt.utility", &[]),
        ("krypt.filter", &[]),
        ("krypt.pitch", &[]),
        ("krypt.flanger", &[("throughZero", 1.0), ("mix", 0.0)]),
        ("krypt.flanger", &[("throughZero", 1.0), ("depth", 0.0)]),
        ("krypt.flanger", &[("mix", 0.0)]),
        ("krypt.chorus", &[("mix", 0.0)]),
        ("krypt.phaser", &[("mix", 0.0)]),
        ("krypt.gate", &[("trigger", 1.0)]),
        ("krypt.transient", &[]),
    ];
    for (id, params) in cases {
        let mut e = fx(id);
        for (p, v) in *params {
            e.set_param(param(id, p), *v);
        }
        // the engine reads latency() right after set_param, before processing
        let lat = e.latency();
        let mut l = vec![0.0f32; 4800];
        let mut r = vec![0.0f32; 4800];
        l[1000] = 0.05;
        r[1000] = 0.05;
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        let imax = l.iter().enumerate().fold((0, 0.0f32), |a, (i, &v)| if v.abs() > a.1 { (i, v.abs()) } else { a }).0;
        // drive's tone low pass (20 kHz) adds ~1 sample of group delay of its own
        let slack = if *id == "krypt.drive" { 1 } else { 0 };
        assert!((imax as i64 - (1000 + lat) as i64).abs() <= slack, "{id} {params:?}: peak at {imax}, latency() = {lat}");
    }
}

fn ebu_true_peak(l: &[f32], r: &[f32]) -> f32 {
    let mut m = EbuR128::new(2, SR as u32, Mode::TRUE_PEAK).unwrap();
    m.add_frames_planar_f32(&[l, r]).unwrap();
    m.true_peak(0).unwrap().max(m.true_peak(1).unwrap()) as f32
}

#[test]
fn limiter_never_exceeds_ceiling_including_true_peak() {
    let n = 48000 * 3;
    let signals: Vec<(&str, Vec<f32>, Vec<f32>)> = vec![
        ("sine 997 Hz", (0..n).map(|i| (std::f32::consts::TAU * 997.0 * i as f32 / SR).sin()).collect(), vec![]),
        (
            "fs/4 at 45° (inter-sample peaks)",
            (0..n).map(|i| (std::f32::consts::FRAC_PI_2 * i as f32 + std::f32::consts::FRAC_PI_4).sin()).collect(),
            vec![],
        ),
        ("noise", noise(n, 11, 1.0), noise(n, 12, 1.0)),
        (
            "bursts",
            (0..n).map(|i| if (i / 4800) % 3 == 0 { (std::f32::consts::TAU * 11025.0 * i as f32 / SR + 0.3).sin() } else { 0.05 * ((i % 97) as f32 / 97.0 - 0.5) }).collect(),
            vec![],
        ),
        (
            "near-nyquist chirp",
            (0..n).map(|i| {
                let t = i as f32 / SR;
                (std::f32::consts::TAU * (8000.0 + 4000.0 * t) * t).sin()
            }).collect(),
            vec![],
        ),
    ];
    for (name, l0, r0) in signals {
        let r0 = if r0.is_empty() { l0.clone() } else { r0 };
        for &(gain, ceiling, rel) in &[(12.0f32, -0.3f32, 60.0f32), (24.0, -1.0, 5.0), (6.0, -6.0, 500.0), (0.0, -0.3, 1.0)] {
            let mut e = fx("krypt.limiter");
            e.set_param(param("krypt.limiter", "inputGain"), gain);
            e.set_param(param("krypt.limiter", "ceiling"), ceiling);
            e.set_param(param("krypt.limiter", "release"), rel);
            let (mut l, mut r) = (l0.clone(), r0.clone());
            run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
            let ceil_lin = 10f32.powf(ceiling / 20.0);
            let sp = peak(&l).max(peak(&r));
            assert!(sp <= ceil_lin * 1.000_001, "{name} g{gain} c{ceiling}: sample peak {sp} > {ceil_lin}");
            let tp_db = 20.0 * ebu_true_peak(&l, &r).log10();
            assert!(tp_db <= ceiling + 0.05, "{name} g{gain} c{ceiling} r{rel}: true peak {tp_db:.3} dBTP > ceiling");
        }
    }
}

#[test]
fn limiter_is_transparent_below_ceiling() {
    let mut e = fx("krypt.limiter");
    let src: Vec<f32> = (0..48000).map(|i| 0.3 * (std::f32::consts::TAU * 440.0 * i as f32 / SR).sin()).collect();
    let (mut l, mut r) = (src.clone(), src.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    let d = e.latency();
    for i in d..48000 {
        assert!((l[i] - src[i - d]).abs() < 1e-6);
    }
}

fn sine_gain_db(e: &mut dyn Effect, f: f32) -> f32 {
    let n = 48000;
    let src: Vec<f32> = (0..n).map(|i| (0.25 * (std::f64::consts::TAU * f as f64 * i as f64 / SR as f64).sin()) as f32).collect();
    let (mut l, mut r) = (src.clone(), src.clone());
    e.reset();
    run_fx(e, &mut l, &mut r, 120.0, None);
    20.0 * (rms(&l[24000..]) / rms(&src[24000..])).log10()
}

#[test]
fn eq_gain_at_centre_frequency_within_half_db() {
    let bands = [("b3", 100.0f32), ("b4", 1000.0), ("b5", 8000.0), ("b3", 15000.0)];
    for &(b, f) in &bands {
        for &g in &[12.0f32, -12.0, 6.0, -18.0] {
            for &q in &[0.5f32, 1.0, 4.0] {
                let mut e = fx("krypt.eq");
                e.set_param(param("krypt.eq", &format!("{b}Freq")), f);
                e.set_param(param("krypt.eq", &format!("{b}Gain")), g);
                e.set_param(param("krypt.eq", &format!("{b}Q")), q);
                let m = sine_gain_db(e.as_mut(), f);
                assert!((m - g).abs() < 0.5, "{b} {f} Hz {g} dB Q{q}: measured {m:.2}");
            }
        }
    }
    // shelves: full gain far from the corner, half (in dB) at the corner
    let mut e = fx("krypt.eq");
    e.set_param(param("krypt.eq", "b2Gain"), 9.0);
    e.set_param(param("krypt.eq", "b2Freq"), 200.0);
    let far = sine_gain_db(e.as_mut(), 30.0);
    let corner = sine_gain_db(e.as_mut(), 200.0);
    assert!((far - 9.0).abs() < 0.5, "low shelf far {far}");
    assert!((corner - 4.5).abs() < 0.5, "low shelf corner {corner}");
    let mut e = fx("krypt.eq");
    e.set_param(param("krypt.eq", "b6Gain"), -9.0);
    e.set_param(param("krypt.eq", "b6Freq"), 3000.0);
    let far = sine_gain_db(e.as_mut(), 18000.0);
    assert!((far + 9.0).abs() < 0.5, "high shelf far {far}");
    // cuts: -3 dB at the corner per Butterworth section, slope per setting
    for (slope, expect_oct) in [(0.0f32, 12.0f32), (1.0, 24.0), (2.0, 48.0)] {
        let mut e = fx("krypt.eq");
        e.set_param(param("krypt.eq", "b1On"), 1.0);
        e.set_param(param("krypt.eq", "b1Freq"), 400.0);
        e.set_param(param("krypt.eq", "b1Slope"), slope);
        let at = sine_gain_db(e.as_mut(), 400.0);
        assert!((at + 3.01).abs() < 0.5, "low cut corner {at}");
        let below = sine_gain_db(e.as_mut(), 100.0);
        assert!((below + 2.0 * expect_oct).abs() < 2.0, "low cut slope {slope}: {below} dB two octaves down");
    }
    // flat by default
    let mut e = fx("krypt.eq");
    for f in [30.0f32, 440.0, 5000.0, 16000.0] {
        assert!(sine_gain_db(e.as_mut(), f).abs() < 0.01, "default EQ not flat at {f}");
    }
}

#[test]
fn compressor_reduces_and_follows_sidechain() {
    // 0 dBFS-peak sine, threshold -18, ratio 4 → steady reduction 13.5 dB
    // (RMS detector is peak-referenced for sines, so it reads 0 dB)
    let mut e = fx("krypt.comp");
    e.set_param(param("krypt.comp", "autoMakeup"), 0.0);
    e.set_param(param("krypt.comp", "knee"), 0.0);
    e.set_param(param("krypt.comp", "detector"), 1.0);
    let n = 48000;
    let src: Vec<f32> = (0..n).map(|i| (std::f32::consts::TAU * 1000.0 * i as f32 / SR).sin()).collect();
    let (mut l, mut r) = (src.clone(), src.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    let gr = 20.0 * (peak(&l[40000..]) / 1.0).log10();
    assert!((gr + 13.5).abs() < 0.5, "reduction {gr}");
    // sidechain: quiet input, loud key → ducks only when enabled
    let quiet: Vec<f32> = src.iter().map(|v| v * 0.05).collect();
    let key: Vec<f32> = src.clone();
    for (use_sc, expect_duck) in [(1.0, true), (0.0, false)] {
        let mut e = fx("krypt.comp");
        e.set_param(param("krypt.comp", "useSidechain"), use_sc);
        e.set_param(param("krypt.comp", "autoMakeup"), 0.0);
        let (mut l, mut r) = (quiet.clone(), quiet.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, Some((&key, &key)));
        let g = peak(&l[40000..]) / 0.05;
        if expect_duck {
            assert!(g < 0.3, "sidechain didn't duck: {g}");
        } else {
            assert!((g - 1.0).abs() < 0.02, "ducked without sidechain: {g}");
        }
    }
}

#[test]
fn delay_echo_lands_on_the_synced_time() {
    let mut e = fx("krypt.delay");
    for (p, v) in [("division", 9.0f32), ("pingPong", 0.0), ("modDepth", 0.0), ("lowCut", 20.0), ("highCut", 20000.0), ("feedback", 0.5)] {
        e.set_param(param("krypt.delay", p), v);
    }
    let mut l = vec![0.0f32; 96000];
    let mut r = vec![0.0f32; 96000];
    l[100] = 1.0;
    r[100] = 1.0;
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None); // 1/4 at 120 bpm = 0.5 s
    let first = l.iter().enumerate().skip(200).fold((0, 0.0f32), |a, (i, &v)| if v.abs() > a.1 { (i, v.abs()) } else { a });
    assert!((first.0 as i64 - (100 + 24000)).abs() <= 2, "echo at {}", first.0);
    let second = l[24200..].iter().enumerate().skip(23000).fold((0, 0.0f32), |a, (i, &v)| if v.abs() > a.1 { (i, v.abs()) } else { a });
    assert!((second.0 as i64 + 24200 - (100 + 48000)).abs() <= 3, "second echo at {}", second.0 + 24200);
    assert!(second.1 < first.1 * 0.7, "feedback should decay");
    // ping-pong alternates sides
    let mut e = fx("krypt.delay");
    e.set_param(param("krypt.delay", "modDepth"), 0.0);
    e.set_param(param("krypt.delay", "division"), 9.0);
    let mut l = vec![0.0f32; 72000];
    let mut r = vec![0.0f32; 72000];
    l[100] = 1.0;
    r[100] = 1.0;
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!(peak(&l[23000..25000]) > 0.05 && peak(&r[23000..25000]) < 1e-3, "first echo left");
    assert!(peak(&r[47000..49000]) > 0.01 && peak(&l[47000..49000]) < 1e-3, "second echo right");
}

#[test]
fn duck_tempo_shape_locks_to_beats() {
    let mut e = fx("krypt.duck");
    let n = 48000 * 2;
    let (mut l, mut r) = (vec![0.5f32; n], vec![0.5f32; n]);
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None); // beats every 24000 samples
    for beat in 1..4 {
        let at = beat * 24000;
        let dip = l[at + 60..at + 200].iter().cloned().fold(1.0f32, f32::min);
        assert!(dip < 0.5 * 0.3, "no dip at beat {beat}: {dip}");
        let before = l[at - 300];
        assert!(before > 0.45, "not recovered before beat {beat}: {before}");
    }
    // follow mode without sidechain passes audio unchanged
    let mut e = fx("krypt.duck");
    e.set_param(param("krypt.duck", "mode"), 1.0);
    let (mut l, mut r) = (vec![0.5f32; 9600], vec![0.5f32; 9600]);
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!(l.iter().all(|v| (*v - 0.5).abs() < 1e-6));
}

#[test]
fn clipper_and_drive_behave() {
    let mut e = fx("krypt.clipper");
    e.set_param(param("krypt.clipper", "drive"), 12.0);
    e.set_param(param("krypt.clipper", "ceiling"), -3.0);
    let src: Vec<f32> = (0..48000).map(|i| (std::f32::consts::TAU * 100.0 * i as f32 / SR).sin()).collect();
    let (mut l, mut r) = (src.clone(), src.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!(peak(&l) <= 10f32.powf(-3.0 / 20.0) + 1e-6);
    for mode in 0..5 {
        let mut e = fx("krypt.drive");
        e.set_param(param("krypt.drive", "mode"), mode as f32);
        e.set_param(param("krypt.drive", "drive"), 24.0);
        let (mut l, mut r) = (src.clone(), src.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        assert!(peak(&l) > 0.05 && peak(&l) < 4.0, "drive mode {mode}: {}", peak(&l));
    }
}

/// Tube's and Fold's ADAA antiderivatives aren't 0 at 0: a zeroed state after
/// reset (playback restart mid-note) or a mode switch mid-stream used to
/// divide that jump by a tiny dx and spike to ~80x full scale.
#[test]
fn drive_never_spikes_after_reset_or_a_mode_switch() {
    // starts at its crest: the first sample after reset is far from 0
    let src: Vec<f32> = (0..9600).map(|i| 0.3 * (std::f32::consts::TAU * 220.0 * i as f32 / SR).cos()).collect();
    for mode in 0..4 {
        let mut e = fx("krypt.drive");
        e.set_param(param("krypt.drive", "mode"), mode as f32);
        e.set_param(param("krypt.drive", "drive"), 18.0);
        let (mut l, mut r) = (src.clone(), src.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        e.reset();
        let (mut l, mut r) = (src.clone(), src.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        assert!(peak(&l) < 2.0, "drive mode {mode} after reset: peak {}", peak(&l));
    }
    for (from, to) in [(0, 1), (0, 3), (1, 3), (3, 2), (2, 1)] {
        let mut e = fx("krypt.drive");
        e.set_param(param("krypt.drive", "drive"), 18.0);
        e.set_param(param("krypt.drive", "mode"), from as f32);
        let (mut l, mut r) = (src.clone(), src.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        e.set_param(param("krypt.drive", "mode"), to as f32);
        let (mut l, mut r) = (src.clone(), src.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        assert!(peak(&l) < 2.0, "drive mode {from} -> {to}: peak {}", peak(&l));
    }
}

#[test]
fn filter_lfo_is_tempo_locked() {
    let mut e = fx("krypt.filter");
    for (p, v) in [("type", 0.0f32), ("cutoff", 800.0), ("lfoDepth", 1.0), ("lfoDivision", 9.0), ("lfoShape", 2.0)] {
        e.set_param(param("krypt.filter", p), v);
    }
    let n = 48000 * 2;
    let mut l = noise(n, 21, 0.5);
    let mut r = l.clone();
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    // saw-up LFO per beat: the second half of each beat is brighter (louder) than the first
    for beat in 0..3 {
        let s = beat * 24000;
        let a = rms(&l[s + 1000..s + 9000]);
        let b = rms(&l[s + 15000..s + 23000]);
        assert!(b > a * 1.5, "beat {beat}: {a} vs {b}");
    }
}

#[test]
fn utility_and_analyzer() {
    let mut e = fx("krypt.analyzer");
    let src = noise(4800, 1, 0.5);
    let (mut l, mut r) = (src.clone(), src.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert_eq!(l, src);
    let mut u = fx("krypt.utility");
    u.set_param(param("krypt.utility", "mono"), 1.0);
    u.set_param(param("krypt.utility", "gain"), -6.0);
    let mut l = noise(48000, 2, 0.5);
    let mut r = noise(48000, 3, 0.5);
    run_fx(u.as_mut(), &mut l, &mut r, 120.0, None);
    for i in 9600..48000 {
        assert!((l[i] - r[i]).abs() < 1e-6);
    }
}

#[test]
fn reverb_decay_matches_rt60_and_is_decorrelated() {
    for mode in [0.0f32, 1.0, 2.0] {
        let mut e = fx("krypt.reverb");
        for (p, v) in [("mode", mode), ("decay", 2.0), ("damping", 20000.0), ("lowCut", 20.0), ("predelay", 0.1)] {
            e.set_param(param("krypt.reverb", p), v);
        }
        let n = 48000 * 8;
        let (mut l, mut r) = (vec![0.0f32; n], vec![0.0f32; n]);
        l[0] = 1.0;
        r[0] = 1.0;
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        // Schroeder backward integration: T30 extrapolated to RT60
        let mut sch = vec![0.0f64; n];
        let mut acc = 0.0f64;
        for i in (0..n).rev() {
            acc += (l[i] as f64).powi(2) + (r[i] as f64).powi(2);
            sch[i] = acc;
        }
        let t_at = |db: f64| sch.iter().position(|&v| 10.0 * (v / sch[0]).log10() < db).unwrap_or(n) as f64 / SR as f64;
        let rt60 = 2.0 * (t_at(-35.0) - t_at(-5.0));
        assert!((rt60 - 2.0).abs() < 0.4, "mode {mode}: RT60 {rt60:.2} s for Decay 2 s");
        let (lr, ll, rr) = l.iter().zip(&r).fold((0.0f64, 0.0f64, 0.0f64), |a, (x, y)| {
            (a.0 + (*x as f64) * (*y as f64), a.1 + (*x as f64).powi(2), a.2 + (*y as f64).powi(2))
        });
        assert!((lr / (ll * rr).sqrt()).abs() < 0.2, "mode {mode}: tail not decorrelated");
    }
}

#[test]
fn comp_auto_makeup_keeps_level() {
    let mut e = fx("krypt.comp"); // defaults: -18 dB, 4:1, auto makeup on
    let n = 48000 * 6;
    let src: Vec<f32> = (0..n).map(|i| 0.7 * (std::f32::consts::TAU * 220.0 * i as f32 / SR).sin()).collect();
    let (mut l, mut r) = (src.clone(), src.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    let g = 20.0 * (rms(&l[n - 48000..]) / rms(&src[n - 48000..])).log10();
    assert!(g.abs() < 1.0, "auto makeup should restore the level of a steady signal: {g:.2} dB");
}

#[test]
fn every_plugin_runs_at_common_sample_rates() {
    use krypt_studio_dsp::{create_instrument, NoteExtras, ProcessContext};
    for sr in [44100.0f32, 88200.0, 96000.0, 192000.0] {
        for d in descriptors() {
            let n = (sr * 0.3) as usize;
            let (mut l, mut r) = (vec![0.0f32; n], vec![0.0f32; n]);
            match d.kind {
                PluginKind::Instrument => {
                    let mut inst = create_instrument(d.id, sr, 512).unwrap();
                    if d.uses_sample == Some(true) {
                        inst.set_sample(Some(test_sample(44100.0, 0.5, None)));
                    }
                    inst.note_on(0, 60, 60.0, 1.0, NoteExtras::default());
                    let mut at = 0;
                    while at < n {
                        let m = (n - at).min(512);
                        let ctx = ProcessContext { sample_rate: sr, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: m };
                        inst.process(&ctx, [&mut l[at..at + m], &mut r[at..at + m]]);
                        at += m;
                    }
                    assert!(peak(&l) > 0.01, "{} silent at {sr}", d.id);
                }
                PluginKind::Effect => {
                    let mut e = create_effect(d.id, sr, 512).unwrap();
                    l = noise(n, 3, 0.5);
                    r = noise(n, 4, 0.5);
                    let mut at = 0;
                    while at < n {
                        let m = (n - at).min(512);
                        let ctx = ProcessContext { sample_rate: sr, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: at as f64 / sr as f64 * 2.0, frames: m };
                        e.process(&ctx, [&mut l[at..at + m], &mut r[at..at + m]], None);
                        at += m;
                    }
                }
            }
            assert!(l.iter().chain(&r).all(|v| v.is_finite() && v.abs() < 100.0), "{} at {sr}", d.id);
        }
    }
}
