//! Behaviour of the wave-2 stock plugins: modulation FX, Gate/Time,
//! vocoder, transient shaper, Squash, imager, Krypt Tune, Krypt FM and
//! Krypt Wave. (The generic suites in effects.rs / instruments.rs /
//! rt_alloc.rs cover silence, tails, resets, extreme params, sample rates
//! and real-time allocation for these too.)

mod common;
use common::*;

use krypt_studio_dsp::{create_effect, create_instrument, Effect, Instrument, NoteExtras, ProcessContext};

fn fx(id: &str, params: &[(&str, f32)]) -> Box<dyn Effect> {
    let mut e = create_effect(id, SR, BLOCK).unwrap();
    for (p, v) in params {
        e.set_param(param(id, p), *v);
    }
    e
}

fn inst(id: &str, params: &[(&str, f32)]) -> Box<dyn Instrument> {
    let mut i = create_instrument(id, SR, BLOCK).unwrap();
    for (p, v) in params {
        i.set_param(param(id, p), *v);
    }
    i
}

fn sine(f: f32, n: usize, amp: f32) -> Vec<f32> {
    (0..n).map(|i| (amp as f64 * (std::f64::consts::TAU * f as f64 * i as f64 / SR as f64).sin()) as f32).collect()
}

/// Hann-windowed single-bin DFT magnitude (amplitude units).
fn goertzel(x: &[f32], f: f32) -> f32 {
    let n = x.len();
    let w = std::f64::consts::TAU * f as f64 / SR as f64;
    let (mut re, mut im, mut wsum) = (0.0f64, 0.0f64, 0.0f64);
    for (i, v) in x.iter().enumerate() {
        let h = 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos();
        re += *v as f64 * h * (w * i as f64).cos();
        im += *v as f64 * h * (w * i as f64).sin();
        wsum += h;
    }
    (2.0 * (re * re + im * im).sqrt() / wsum) as f32
}

fn db(x: f32) -> f32 {
    20.0 * x.max(1e-12).log10()
}

/// Play one note for `frames` (released at `off`), returning (L, R).
fn play(i: &mut dyn Instrument, key: u8, vel: f32, frames: usize, off: usize) -> (Vec<f32>, Vec<f32>) {
    i.note_on(0, key, key as f32, vel, NoteExtras::default());
    let (mut l, mut r) = (vec![0.0f32; frames], vec![0.0f32; frames]);
    let mut at = 0;
    while at < frames {
        let n = (frames - at).min(BLOCK);
        if at <= off && off < at + n {
            i.note_off(off - at, key);
        }
        i.process(&ctx(n, 0.0, 120.0, true), [&mut l[at..at + n], &mut r[at..at + n]]);
        at += n;
    }
    (l, r)
}

/// Run an effect with an explicit transport state per block.
fn run_transport(e: &mut dyn Effect, l: &mut [f32], r: &mut [f32], playing: bool) {
    let mut at = 0;
    while at < l.len() {
        let n = (l.len() - at).min(BLOCK);
        let c = ProcessContext { sample_rate: SR, bpm: 120.0, beats_per_bar: 4.0, playing, beat_pos: at as f64 / 24000.0, frames: n };
        e.process(&c, [&mut l[at..at + n], &mut r[at..at + n]], None);
        at += n;
    }
}

// ── Modulation FX ────────────────────────────────────────────────────────

#[test]
fn chorus_widens_mono_and_mix_zero_is_dry() {
    let src = sine(330.0, 48000, 0.5);
    let mut e = fx("krypt.chorus", &[("mix", 1.0), ("lowCut", 20.0)]);
    let (mut l, mut r) = (src.clone(), src.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    let (a, b) = (&l[24000..], &r[24000..]);
    let diff: Vec<f32> = a.iter().zip(b).map(|(x, y)| x - y).collect();
    assert!(rms(&diff) > 0.1 * rms(a), "chorus left mono input mono: side {} vs {}", rms(&diff), rms(a));
    assert!(rms(a) > 0.2 && rms(a) < 0.6, "wet level {}", rms(a));
    let mut e = fx("krypt.chorus", &[("mix", 0.0)]);
    let (mut l, mut r) = (src.clone(), src.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert_eq!(l, src, "mix 0 must be the untouched dry signal");
}

#[test]
fn flanger_static_comb_and_through_zero_alignment() {
    // depth 0: a fixed 1 ms (48-sample) comb mixed 50/50 → notch at 500 Hz, peak at 1 kHz
    for (f, want_db, tol) in [(500.0f32, -40.0f32, 40.0f32), (1000.0, 0.0, 0.5)] {
        let mut e = fx("krypt.flanger", &[("depth", 0.0), ("feedback", 0.0), ("delay", 1.0)]);
        let src = sine(f, 24000, 0.5);
        let (mut l, mut r) = (src.clone(), src.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        let g = db(rms(&l[12000..]) / rms(&src[12000..]));
        if want_db < -20.0 {
            assert!(g < -30.0, "notch at {f} Hz only {g:.1} dB");
        } else {
            assert!((g - want_db).abs() < tol, "{f} Hz: {g:.2} dB");
        }
    }
    // through-zero: the wet tap sits exactly on the delayed dry at the zero point
    let mut e = fx("krypt.flanger", &[("throughZero", 1.0), ("depth", 0.0), ("feedback", 0.0)]);
    let lat = e.latency();
    assert_eq!(lat, 144, "3 ms at 48 kHz");
    let (mut l, mut r) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
    l[1000] = 0.5;
    r[1000] = 0.5;
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!((l[1000 + lat] - 0.5).abs() < 1e-6, "dry + wet coincide: {}", l[1000 + lat]);
    assert!(peak(&l[..1000 + lat]) < 1e-6);
    // and through-zero off reports no latency again
    e.set_param(param("krypt.flanger", "throughZero"), 0.0);
    assert_eq!(e.latency(), 0);
}

#[test]
fn phaser_notch_sits_at_the_centre_for_six_stages() {
    let mut gains = vec![];
    for f in [1000.0f32, 100.0, 8000.0] {
        let mut e = fx("krypt.phaser", &[("stages", 6.0), ("center", 1000.0), ("depth", 0.0), ("feedback", 0.0)]);
        let src = sine(f, 24000, 0.5);
        let (mut l, mut r) = (src.clone(), src.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        gains.push(db(rms(&l[12000..]) / rms(&src[12000..])));
    }
    assert!(gains[0] < -30.0, "6 stages → 540° at the centre → notch: {:.1} dB", gains[0]);
    assert!(gains[1] > -3.0 && gains[2] > -3.0, "far from the notches: {gains:?}");
    // 4 stages: 360° at the centre → in phase, no notch there
    let mut e = fx("krypt.phaser", &[("stages", 4.0), ("center", 1000.0), ("depth", 0.0), ("feedback", 0.0)]);
    let src = sine(1000.0, 24000, 0.5);
    let (mut l, mut r) = (src.clone(), src.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!(db(rms(&l[12000..]) / rms(&src[12000..])).abs() < 0.5);
}

// ── Gate / Time ──────────────────────────────────────────────────────────

/// Feed a ramp (value = sample index × 1e-6) on the left and a constant 1
/// on the right: left / right reveals which past sample the time engine is
/// reading (the volume engine scales both sides alike). NaN where muted.
fn gate_read_positions(params: &[(&str, f32)], n: usize) -> Vec<f32> {
    let mut e = fx("krypt.gate", params);
    let mut l: Vec<f32> = (0..n).map(|i| i as f32 * 1e-6).collect();
    let mut r = vec![1.0f32; n];
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    l.iter().zip(&r).map(|(a, b)| if b.abs() > 0.05 { a / b * 1e6 } else { f32::NAN }).collect()
}

#[test]
fn gate_time_patterns_read_the_right_past_samples() {
    // 120 bpm: one beat = 24000 samples
    let pos = gate_read_positions(&[("pattern", 0.0), ("smoothing", 1.0)], 96000);
    for &n in &[30000usize, 50000, 90000] {
        assert!((pos[n] - n as f32 / 2.0).abs() < 2.0, "half-time at {n}: reads {}", pos[n]);
    }
    let pos = gate_read_positions(&[("pattern", 1.0), ("smoothing", 1.0)], 96000);
    assert!((pos[30000] - 30000.0).abs() < 1.0, "first 1/8 of a beat plays normally");
    assert!((pos[40000] - 28000.0).abs() < 1.0, "second 1/8 repeats the first: {}", pos[40000]);
    let pos = gate_read_positions(&[("pattern", 5.0), ("smoothing", 1.0)], 96000);
    // reverse: halfway through beat 1 we hear the middle of beat 0, backwards
    assert!((pos[36000] - 12000.0).abs() < 2.0, "reverse reads {}", pos[36000]);
    assert!(pos[36001] < pos[36000], "and moves backwards");
    // every pattern only ever reads the past
    for p in 0..10 {
        let pos = gate_read_positions(&[("pattern", p as f32)], 96000);
        for (i, v) in pos.iter().enumerate() {
            assert!(v.is_nan() || *v <= i as f32 + 0.05, "pattern {p} read the future at {i}: {v}");
        }
    }
}

#[test]
fn gate_custom_steps_read_the_right_past_samples() {
    // 120 bpm, 1/16 steps: one step = 6000 samples, 16 steps = 96000
    let params = [
        ("pattern", 10.0),
        ("smoothing", 1.0),
        ("stepDiv", 1.0),
        ("s5", 6.0), // reverse over steps 5-6 (from 24000)
        ("s6", 6.0),
        ("s9", 1.0), // roll x2 (48000)
        ("s11", 4.0), // repeat prev over steps 11-12 (60000)
        ("s12", 4.0),
        ("s13", 5.0), // half speed (72000)
        ("g15", 0.0), // muted (84000..90000)
    ];
    let pos = gate_read_positions(&params, 96000);
    assert!((pos[10000] - 10000.0).abs() < 1.0, "play: {}", pos[10000]);
    assert!((pos[30000] - 18000.0).abs() < 2.0, "reverse reads {}", pos[30000]);
    assert!(pos[30001] < pos[30000], "and moves backwards");
    assert!((pos[52000] - 49000.0).abs() < 1.0, "roll x2 restarts the step halfway: {}", pos[52000]);
    assert!((pos[62000] - 56000.0).abs() < 1.0 && (pos[68000] - 56000.0).abs() < 1.0, "repeat prev: {} {}", pos[62000], pos[68000]);
    assert!((pos[76000] - 74000.0).abs() < 2.0, "half speed: {}", pos[76000]);
    assert!(pos[87000].is_nan(), "muted step: {}", pos[87000]);
    for (i, v) in pos.iter().enumerate() {
        assert!(v.is_nan() || *v <= i as f32 + 0.05, "read the future at {i}: {v}");
    }
}

#[test]
fn gate_volume_patterns_and_tape_stop() {
    let mut e = fx("krypt.gate", &[("pattern", 7.0), ("smoothing", 1.0)]);
    let (mut l, mut r) = (vec![0.5f32; 48000], vec![0.5f32; 48000]);
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    // Gate 1/8: open for the first 1/16 of every 1/8
    assert!((l[3000] - 0.5).abs() < 1e-3 && l[9000].abs() < 1e-3, "{} {}", l[3000], l[9000]);
    assert!((l[15000] - 0.5).abs() < 1e-3 && l[21000].abs() < 1e-3);
    // depth 0.5 only halves the closed steps
    let mut e = fx("krypt.gate", &[("pattern", 7.0), ("smoothing", 1.0), ("depth", 0.5)]);
    let (mut l, mut r) = (vec![0.5f32; 48000], vec![0.5f32; 48000]);
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!((l[9000] - 0.25).abs() < 1e-3, "{}", l[9000]);
    // tape stop: normal for two beats, then slows and fades to silence
    let pos = gate_read_positions(&[("pattern", 4.0), ("smoothing", 1.0)], 96000);
    assert!((pos[40000] - 40000.0).abs() < 1.0);
    let early = pos[50001] - pos[50000];
    let late = pos[90101] - pos[90001];
    // over 100 samples: a speed under 0.1
    assert!(early > 0.8 && (0.0..10.0).contains(&late), "speed {early} → {late}/100");
    let mut e = fx("krypt.gate", &[("pattern", 4.0)]);
    let (mut l, mut r) = (vec![0.5f32; 96000], vec![0.5f32; 96000]);
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!(l[95000].abs() < 0.02, "stopped tape is silent: {}", l[95000]);
}

#[test]
fn gate_trigger_modes_and_transport() {
    let src = noise(48000, 5, 0.5);
    // Active param mode, inactive: bit-exact passthrough, no latency
    let mut e = fx("krypt.gate", &[("trigger", 1.0), ("pattern", 2.0)]);
    let (mut l, mut r) = (src.clone(), src.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert_eq!(l, src);
    assert_eq!(e.latency(), 0);
    // transport stopped: passthrough even in Always mode
    let mut e = fx("krypt.gate", &[("pattern", 0.0)]);
    let (mut l, mut r) = (src.clone(), src.clone());
    run_transport(e.as_mut(), &mut l, &mut r, false);
    assert_eq!(l, src);
    // activation mid-bar restarts the pattern from the 1/16 grid at or before it
    let mut e = fx("krypt.gate", &[("trigger", 1.0), ("pattern", 1.0), ("smoothing", 1.0)]);
    let n = 96000;
    let mut l: Vec<f32> = (0..n).map(|i| i as f32 * 1e-6).collect();
    let mut r = l.clone();
    let mut at = 0;
    while at < n {
        let m = (n - at).min(BLOCK);
        if at == 30208 {
            e.set_param(param("krypt.gate", "active"), 1.0);
        }
        let c = ProcessContext { sample_rate: SR, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: at as f64 / 24000.0, frames: m };
        e.process(&c, [&mut l[at..at + m], &mut r[at..at + m]], None);
        at += m;
    }
    // activated at beat 1.2587 → anchor at beat 1.25 (sample 30000); its 1/8
    // (12000 samples) plays, then repeats
    assert!((l[40000] * 1e6 - 40000.0).abs() < 1.0, "{}", l[40000] * 1e6);
    assert!((l[45000] * 1e6 - 33000.0).abs() < 1.0, "repeat of the 1/8 from the anchor: {}", l[45000] * 1e6);
    assert!((l[20000] * 1e6 - 20000.0).abs() < 1e-3, "untouched before activation");
}

// ── Vocoder ──────────────────────────────────────────────────────────────

fn one_pole_split(x: &[f32], fc: f32) -> (Vec<f32>, Vec<f32>) {
    let a = (-std::f32::consts::TAU * fc / SR).exp();
    let mut s = 0.0f32;
    let mut lo = Vec::with_capacity(x.len());
    let mut hi = Vec::with_capacity(x.len());
    for v in x {
        s = (1.0 - a) * v + a * s;
        lo.push(s);
        hi.push(v - s);
    }
    (lo, hi)
}

#[test]
fn vocoder_follows_the_voice_level_and_spectrum() {
    let n = 48000;
    let carrier: Vec<f32> = (0..n).map(|i| ((i as f32 * 110.0 / SR).fract() * 2.0 - 1.0) * 0.5).collect();
    // voice: noise bursts, on for 0.25 s, off for 0.25 s
    let nz = noise(n, 9, 0.5);
    let voice: Vec<f32> = nz.iter().enumerate().map(|(i, v)| if (i / 12000) % 2 == 0 { *v } else { 0.0 }).collect();
    let mut e = fx("krypt.vocoder", &[("release", 10.0)]);
    let (mut l, mut r) = (carrier.clone(), carrier.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, Some((&voice, &voice)));
    let on = rms(&l[3000..11000]);
    let off = rms(&l[17000..23000]);
    assert!(on > 0.05, "vocoded output too quiet: {on}");
    assert!(off < on * 0.02, "output should close with the voice: on {on} off {off}");
    // the output takes the voice's spectral balance
    let (vlo, _) = one_pole_split(&nz, 400.0);
    let (_, vhi) = one_pole_split(&nz, 3000.0);
    let mut balance = vec![];
    for v in [&vlo, &vhi] {
        let mut e = fx("krypt.vocoder", &[("sibilance", 0.0)]);
        let (mut l, mut r) = (carrier.clone(), carrier.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, Some((v, v)));
        let (lo, hi) = one_pole_split(&l[12000..], 1000.0);
        balance.push(db(rms(&hi) / rms(&lo)));
    }
    assert!(balance[1] - balance[0] > 10.0, "dark voice vs bright voice: {balance:?}");
    // no sidechain: the input becomes the voice over the internal saw
    let mut e = fx("krypt.vocoder", &[("release", 10.0)]);
    let (mut l, mut r) = (voice.clone(), voice.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!(rms(&l[3000..11000]) > 0.05 && rms(&l[17000..23000]) < 0.002);
}

// ── Dynamics ─────────────────────────────────────────────────────────────

/// 100 Hz hits decaying over ~150 ms, every 0.5 s.
fn hits(n: usize, amp: f32) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let t = (i % 24000) as f32 / SR;
            amp * (-t / 0.05).exp() * (std::f32::consts::TAU * 100.0 * t).sin()
        })
        .collect()
}

#[test]
fn transient_shaper_moves_attack_and_sustain_at_any_level() {
    for amp in [0.8f32, 0.05] {
        let src = hits(96000, amp);
        let measure = |a: f32, s: f32| {
            let mut e = fx("krypt.transient", &[("attack", a), ("sustain", s)]);
            let (mut l, mut r) = (src.clone(), src.clone());
            run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
            let at = 48000;
            (db(peak(&l[at..at + 240]) / peak(&src[at..at + 240])), db(rms(&l[at + 7200..at + 14400]) / rms(&src[at + 7200..at + 14400])))
        };
        let (a_up, _) = measure(1.0, 0.0);
        let (a_dn, _) = measure(-1.0, 0.0);
        let (_, s_up) = measure(0.0, 1.0);
        let (_, s_dn) = measure(0.0, -1.0);
        let (a0, s0) = measure(0.0, 0.0);
        assert!(a0.abs() < 0.01 && s0.abs() < 0.01, "neutral is transparent: {a0} {s0}");
        assert!(a_up > 3.0 && a_dn < -3.0, "amp {amp}: attack {a_up:.1} / {a_dn:.1} dB");
        assert!(s_up > 3.0 && s_dn < -3.0, "amp {amp}: sustain {s_up:.1} / {s_dn:.1} dB");
    }
}

#[test]
fn ott_lifts_quiet_and_tames_loud_and_depth_zero_is_flat() {
    let gain_at = |amp: f32, params: &[(&str, f32)], f: f32| {
        let mut e = fx("krypt.squash", params);
        let src = sine(f, 48000, amp);
        let (mut l, mut r) = (src.clone(), src.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        db(rms(&l[24000..]) / rms(&src[24000..]))
    };
    assert!(gain_at(0.002, &[], 1000.0) > 10.0, "quiet detail comes up");
    assert!(gain_at(0.7, &[], 1000.0) < -10.0, "loud parts come down");
    assert!(gain_at(0.002, &[("upward", 0.0)], 1000.0).abs() < 0.5, "upward 0: no lift");
    for f in [50.0f32, 88.0, 700.0, 2500.0, 9000.0] {
        let g = gain_at(0.3, &[("depth", 0.0)], f);
        assert!(g.abs() < 0.05, "depth 0 at {f} Hz: {g:.3} dB (crossovers must sum flat)");
    }
}

#[test]
fn imager_band_widths() {
    let n = 48000;
    // pure side signal in the low band, width 0 → removed
    let s = sine(50.0, n, 0.5);
    let neg: Vec<f32> = s.iter().map(|v| -v).collect();
    let mut e = fx("krypt.imager", &[("lowWidth", 0.0)]);
    let (mut l, mut r) = (s.clone(), neg.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!(db(rms(&l[24000..]) / rms(&s[24000..])) < -30.0, "low side should vanish");
    // high band side doubled at width 200%
    let s = sine(12000.0, n, 0.25);
    let neg: Vec<f32> = s.iter().map(|v| -v).collect();
    let mut e = fx("krypt.imager", &[("highWidth", 2.0)]);
    let (mut l, mut r) = (s.clone(), neg.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    let g = db(rms(&l[24000..]) / rms(&s[24000..]));
    assert!((g - 6.02).abs() < 0.3, "high side +6 dB: {g:.2}");
    // default: flat magnitude, mono stays mono at any width
    for f in [60.0f32, 200.0, 1000.0, 4000.0, 12000.0] {
        let src = sine(f, n, 0.3);
        let mut e = fx("krypt.imager", &[("midWidth", 0.0), ("highWidth", 2.0)]);
        let (mut l, mut r) = (src.clone(), src.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        assert!(db(rms(&l[24000..]) / rms(&src[24000..])).abs() < 0.05, "mono level at {f}");
        assert!(l.iter().zip(&r).all(|(a, b)| (a - b).abs() < 1e-6), "mono stays mono at {f}");
    }
}

// ── Krypt Tune ───────────────────────────────────────────────────────────

/// Mean frequency from zero crossings over a window.
fn freq_of(x: &[f32]) -> f32 {
    zc_freq(x, SR)
}

#[test]
fn tune_snaps_to_the_scale() {
    let cases: &[(f32, f32, f32, f32)] = &[
        // (input Hz, scale, root, expected Hz)
        (450.0, 0.0, 0.0, 440.0),     // chromatic: A4 + 39 ct → A4
        (475.0, 1.0, 0.0, 493.88),    // C major: A#4 + 31 ct → B4 (A# is not in the key)
        (210.0, 0.0, 0.0, 207.65),    // chromatic: G#3 + 19 ct
        (130.0, 5.0, 9.0, 130.81),    // A minor pentatonic: C3 − 11 ct → C3
    ];
    for &(f_in, scale, root, f_out) in cases {
        let mut e = fx("krypt.pitch", &[("scale", scale), ("root", root), ("speed", 0.0), ("humanize", 0.0)]);
        let src = sine(f_in, 48000, 0.5);
        let (mut l, mut r) = (src.clone(), src.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        let got = freq_of(&l[19200..47000]);
        let cents = 1200.0 * (got / f_out).log2();
        assert!(cents.abs() < 6.0, "{f_in} Hz → {got:.2} Hz, want {f_out} ({cents:.1} ct)");
        assert!(l.iter().all(|v| v.abs() < 0.75), "splices must not overshoot");
    }
}

#[test]
fn tune_amount_zero_is_a_pure_delay_and_humanize_keeps_vibrato() {
    let mut e = fx("krypt.pitch", &[("amount", 0.0)]);
    let lat = e.latency();
    assert!(lat > 600 && lat < 800, "≈15 ms latency, got {lat}");
    let src = sine(450.0, 24000, 0.5);
    let (mut l, mut r) = (src.clone(), src.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    for i in lat..24000 {
        assert!((l[i] - src[i - lat]).abs() < 1e-6, "sample {i}");
    }
    // a note 20 ct sharp with ±25 ct vibrato at 5 Hz (never closer to A# than to A)
    let vib: Vec<f32> = {
        let mut ph = 0.0f64;
        (0..72000)
            .map(|i| {
                let f = 445.0 * (25.0 / 1200.0 * (std::f64::consts::TAU * 5.0 * i as f64 / SR as f64).sin()).exp2();
                ph += f / SR as f64;
                (0.5 * (std::f64::consts::TAU * ph).sin()) as f32
            })
            .collect()
    };
    let spread = |humanize: f32| {
        let mut e = fx("krypt.pitch", &[("speed", 0.0), ("humanize", humanize)]);
        let (mut l, mut r) = (vib.clone(), vib.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        let fs: Vec<f32> = (0..20).map(|k| freq_of(&l[24000 + k * 2400..24000 + (k + 1) * 2400])).collect();
        let mean = fs.iter().sum::<f32>() / fs.len() as f32;
        let sd = (fs.iter().map(|f| (f - mean).powi(2)).sum::<f32>() / fs.len() as f32).sqrt();
        (mean, 1200.0 * ((mean + sd) / mean).log2())
    };
    let (mean_hard, sd_hard) = spread(0.0);
    let (mean_human, sd_human) = spread(1.0);
    assert!((1200.0 * (mean_hard / 440.0).log2()).abs() < 8.0, "hard tune centre {mean_hard}");
    assert!((1200.0 * (mean_human / 440.0).log2()).abs() < 8.0, "humanized centre {mean_human}");
    assert!(sd_hard < 8.0, "hard tune flattens vibrato: {sd_hard:.1} ct");
    assert!(sd_human > 12.0, "humanize keeps vibrato: {sd_human:.1} ct");
}

// ── Krypt FM ─────────────────────────────────────────────────────────────

const LONE_CARRIER: &[(&str, f32)] = &[
    ("algorithm", 7.0),
    ("op2Level", 0.0),
    ("op3Level", 0.0),
    ("op4Level", 0.0),
    ("op1Sustain", 1.0),
    ("op1Vel", 0.0),
];

#[test]
fn fm_carrier_pitch_ratio_and_modulation() {
    let mut i = inst("krypt.fm", LONE_CARRIER);
    let (l, _) = play(i.as_mut(), 69, 1.0, 24000, 24000);
    assert!((freq_of(&l[2400..24000]) - 440.0).abs() < 0.5, "{}", freq_of(&l[2400..24000]));
    assert!(goertzel(&l[2400..], 880.0) < goertzel(&l[2400..], 440.0) * 1e-3, "lone carrier is a pure sine");
    let mut p = LONE_CARRIER.to_vec();
    p.push(("op1Ratio", 2.0));
    p.push(("op1Fine", 0.5));
    let mut i = inst("krypt.fm", &p);
    let (l, _) = play(i.as_mut(), 57, 1.0, 24000, 24000);
    assert!((freq_of(&l[2400..24000]) - 660.0).abs() < 1.0, "ratio 2 × 1.5 on A3: {}", freq_of(&l[2400..24000]));
    // stack: more modulator level → more upper partials
    let bright = |lvl: f32| {
        let mut i = inst("krypt.fm", &[("algorithm", 0.0), ("op2Level", lvl), ("op3Level", 0.0), ("op4Level", 0.0), ("op1Sustain", 1.0), ("op2Sustain", 1.0)]);
        let (l, _) = play(i.as_mut(), 57, 1.0, 24000, 24000);
        let s = &l[4800..];
        (2..8).map(|h| goertzel(s, 220.0 * h as f32)).sum::<f32>() / goertzel(s, 220.0)
    };
    let (dull, mid, hot) = (bright(0.0), bright(0.6), bright(0.85));
    assert!(dull < 0.01 && mid > dull * 10.0 && hot > mid * 2.0, "{dull} {mid} {hot}");
}

#[test]
fn fm_velocity_sensitivity_per_operator() {
    let level = |vel: f32, sens: f32| {
        let mut p = LONE_CARRIER.to_vec();
        p.push(("op1Vel", sens));
        let mut i = inst("krypt.fm", &p);
        let (l, _) = play(i.as_mut(), 60, vel, 9600, 9600);
        rms(&l[2400..])
    };
    let full = level(1.0, 1.0) / level(0.5, 1.0);
    assert!((1.0 / full - 0.5f32.powf(1.6)).abs() < 0.02, "full sensitivity follows vel^1.6: {}", 1.0 / full);
    assert!((level(1.0, 0.0) / level(0.5, 0.0) - 1.0).abs() < 1e-3, "no sensitivity: velocity ignored");
}

#[test]
fn fm_oversampling_suppresses_aliases() {
    // f0 = 3100 Hz with a hard 1:1 modulator: partials at k·3100 reach far
    // past Nyquist; without 2x oversampling the 10th/11th would fold to
    // 17000 / 13900 Hz, between the real partials
    let mut i = inst("krypt.fm", &[("algorithm", 0.0), ("op2Level", 0.9), ("op3Level", 0.0), ("op4Level", 0.0), ("op1Sustain", 1.0), ("op2Sustain", 1.0)]);
    let key = 69.0 + 12.0 * (3100.0f32 / 440.0).log2();
    i.note_on(0, 100, key, 1.0, NoteExtras::default());
    let (l, _) = render_inst(i.as_mut(), 24000);
    let s = &l[4800..];
    let f0 = goertzel(s, 3100.0);
    for alias in [17000.0f32, 13900.0, 10800.0] {
        let a = goertzel(s, alias);
        assert!(db(a / f0) < -60.0, "alias at {alias} Hz: {:.1} dB", db(a / f0));
    }
    assert!(goertzel(s, 6200.0) > f0 * 0.05, "real partials are there");
}

#[test]
fn fm_default_patch_is_a_decaying_epiano() {
    let mut i = inst("krypt.fm", &[]);
    let (l, r) = play(i.as_mut(), 60, 0.9, 96000, 96000);
    let early = rms(&l[480..4800]);
    let late = rms(&l[72000..96000]);
    assert!(early > 0.05 && late < early * 0.3, "piano-like decay: {early} → {late}");
    assert!(l.iter().chain(&r).all(|v| v.abs() < 1.0));
    // the tine (14:1) brightness fades faster than the body
    let hf = |x: &[f32]| (10..20).map(|h| goertzel(x, 261.63 * h as f32)).sum::<f32>() / goertzel(x, 261.63);
    assert!(hf(&l[2400..7200]) > hf(&l[48000..52800]) * 3.0);
}

// ── Krypt Wave ───────────────────────────────────────────────────────────

const PLAIN: &[(&str, f32)] = &[("unison", 1.0), ("cutoff", 20000.0), ("modToCutoff", 0.0), ("filterKeyTrack", 0.0), ("reso", 0.0), ("ampSustain", 1.0)];

#[test]
fn wave_position_morphs_the_timbre() {
    let harm = |pos: f32| {
        let mut p = PLAIN.to_vec();
        p.push(("position", pos));
        let mut i = inst("krypt.wavetable", &p);
        let (l, _) = play(i.as_mut(), 57, 1.0, 24000, 24000);
        let s = &l[4800..];
        let f1 = goertzel(s, 220.0);
        (freq_of(s), goertzel(s, 440.0) / f1, goertzel(s, 660.0) / f1)
    };
    let (f, h2, h3) = harm(0.0);
    assert!((f - 220.0).abs() < 0.5, "pitch {f}");
    assert!(h2 < 1e-3 && h3 < 1e-3, "position 0 is a sine: {h2} {h3}");
    let (_, h2, h3) = harm(2.0 / 3.0);
    assert!((h2 - 0.5).abs() < 0.05 && (h3 - 1.0 / 3.0).abs() < 0.05, "saw: {h2} {h3}");
    let (_, h2, h3) = harm(1.0);
    assert!(h2 < 0.01 && (h3 - 1.0 / 3.0).abs() < 0.05, "square: {h2} {h3}");
}

#[test]
fn wave_high_notes_do_not_alias() {
    // a saw at 2637 Hz (E7): only true harmonics, nothing folded in between
    let mut p = PLAIN.to_vec();
    p.push(("position", 2.0 / 3.0));
    let mut i = inst("krypt.wavetable", &p);
    let (l, _) = play(i.as_mut(), 100, 1.0, 24000, 24000);
    let s = &l[4800..];
    let f0 = 2637.02f32;
    let fund = goertzel(s, f0);
    for k in 1..8 {
        let between = goertzel(s, f0 * (k as f32 + 0.5));
        assert!(db(between / fund) < -60.0, "energy between harmonics {k}/{}: {:.1} dB", k + 1, db(between / fund));
    }
    // 48000 − 9·2637 = 24267 is out of band; 48000 − 10·2637 = 21630 would be an alias
    assert!(db(goertzel(s, 21630.0) / fund) < -60.0);
}

#[test]
fn wave_unison_spreads_and_sub_adds_an_octave_below() {
    let mut p = PLAIN.to_vec();
    p.extend_from_slice(&[("unison", 8.0), ("detune", 0.5), ("spread", 1.0)]);
    let mut i = inst("krypt.wavetable", &p);
    let (l, r) = play(i.as_mut(), 57, 1.0, 24000, 24000);
    let side: Vec<f32> = l.iter().zip(&r).map(|(a, b)| a - b).collect();
    assert!(rms(&side[4800..]) > 0.2 * rms(&l[4800..]), "unison spread is stereo");
    let mut p = PLAIN.to_vec();
    p.extend_from_slice(&[("position", 0.0), ("subLevel", 1.0)]);
    let mut i = inst("krypt.wavetable", &p);
    let (l, _) = play(i.as_mut(), 57, 1.0, 24000, 24000);
    let s = &l[4800..];
    assert!(goertzel(s, 110.0) > 0.5 * goertzel(s, 220.0), "sub at 110 Hz");
}
