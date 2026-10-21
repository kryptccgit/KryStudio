mod common;
use common::*;

use krypt_studio_dsp::{create_effect, Effect, ProcessContext};

const DEVICES: [&str; 4] = ["krypt.heat", "krypt.tapeecho", "krypt.grain", "krypt.glue"];
type Params = &'static [(&'static str, f32)];

fn fx(id: &str, params: &[(&str, f32)]) -> Box<dyn Effect> {
    let mut e = create_effect(id, SR, BLOCK).unwrap();
    for (p, v) in params {
        e.set_param(param(id, p), *v);
    }
    e
}

fn sine(f: f32, n: usize, amp: f32) -> Vec<f32> {
    (0..n).map(|i| (amp as f64 * (std::f64::consts::TAU * f as f64 * i as f64 / SR as f64).sin()) as f32).collect()
}

fn impulse(n: usize, at: usize, amp: f32) -> Vec<f32> {
    let mut v = vec![0.0f32; n];
    v[at] = amp;
    v
}

fn argmax(x: &[f32]) -> usize {
    x.iter().enumerate().fold((0, 0.0f32), |a, (i, &v)| if v.abs() > a.1 { (i, v.abs()) } else { a }).0
}

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

#[test]
fn finite_on_noise_impulse_and_sine_for_every_setting_family() {
    let cases: &[(&str, &[(&str, f32)])] = &[
        ("krypt.heat", &[]),
        ("krypt.heat", &[("lowShape", 4.0), ("midShape", 5.0), ("highShape", 6.0), ("lowDrive", 36.0), ("midDrive", 36.0), ("highDrive", 36.0)]),
        ("krypt.heat", &[("oversample", 2.0), ("lowFreq", 2000.0), ("highFreq", 400.0)]),
        ("krypt.heat", &[("oversample", 0.0), ("midShape", 3.0)]),
        ("krypt.tapeecho", &[]),
        ("krypt.tapeecho", &[("feedback", 1.1), ("saturation", 1.0), ("wow", 1.0), ("flutter", 1.0), ("age", 1.0), ("pingPong", 1.0)]),
        ("krypt.tapeecho", &[("sync", 0.0), ("timeMs", 10.0), ("freeze", 1.0)]),
        ("krypt.grain", &[]),
        ("krypt.grain", &[("pitch", 24.0), ("reverse", 1.0), ("spray", 1.0), ("density", 100.0), ("size", 500.0), ("feedback", 0.95)]),
        ("krypt.grain", &[("pitch", -24.0), ("freeze", 1.0), ("delay", 2000.0)]),
        ("krypt.grain", &[("mode", 1.0), ("blur", 1.0)]),
        ("krypt.grain", &[("mode", 1.0), ("freeze", 1.0)]),
        ("krypt.glue", &[]),
        ("krypt.glue", &[("threshold", -40.0), ("ratio", 2.0), ("attack", 0.0), ("release", 0.0), ("makeup", 24.0), ("scHpf", 6.0)]),
        ("krypt.vocoder", &[("carrier", 4.0), ("bands", 40.0), ("unvoiced", 1.0), ("releaseTilt", -1.0)]),
    ];
    for (id, params) in cases {
        for (k, input) in [noise(24000, 7, 0.9), impulse(24000, 100, 1.0), sine(220.0, 24000, 0.9)].into_iter().enumerate() {
            let mut e = fx(id, params);
            let (mut l, mut r) = (input.clone(), input);
            run_fx(e.as_mut(), &mut l, &mut r, 128.0, None);
            assert!(l.iter().chain(&r).all(|v| v.is_finite() && v.abs() < 20.0), "{id} {params:?} input {k}: {}", peak(&l));
        }
    }
}

#[test]
fn mix_zero_is_the_dry_signal_latency_aligned() {
    let cases: &[(&str, &[(&str, f32)])] = &[
        ("krypt.heat", &[("lowDrive", 30.0), ("midShape", 4.0)]),
        ("krypt.heat", &[("oversample", 2.0)]),
        ("krypt.heat", &[("oversample", 0.0)]),
        ("krypt.tapeecho", &[("feedback", 0.9), ("age", 1.0)]),
        ("krypt.grain", &[("feedback", 0.8)]),
        ("krypt.grain", &[("mode", 1.0)]),
        ("krypt.glue", &[("threshold", -40.0), ("makeup", 12.0)]),
    ];
    for (id, params) in cases {
        let mut e = fx(id, params);
        e.set_param(param(id, "mix"), 0.0);
        let lat = e.latency();
        let src_l = noise(48000, 1, 0.8);
        let src_r = noise(48000, 2, 0.8);
        let (mut l, mut r) = (src_l.clone(), src_r.clone());
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        for i in 0..48000 {
            let (dl, dr) = if i >= lat { (src_l[i - lat], src_r[i - lat]) } else { (0.0, 0.0) };
            assert!(l[i] == dl && r[i] == dr, "{id} {params:?}: sample {i} differs ({} vs {dl}, lat {lat})", l[i]);
        }
    }
}

#[test]
fn no_denormals_and_digital_silence_after_signal() {
    for id in DEVICES {
        for params in [&[][..], &[("mode", 1.0)][..]] {
            if id != "krypt.grain" && !params.is_empty() {
                continue;
            }
            let mut e = fx(id, params);
            let mut l = sine(110.0, 24000, 0.8);
            let mut r = noise(24000, 3, 0.5);
            l.extend(std::iter::repeat_n(0.0, 48000 * 30));
            r.extend(std::iter::repeat_n(0.0, 48000 * 30));
            run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
            let tail = &l[l.len() - 48000..];
            assert!(l.iter().chain(&r).all(|v| *v == 0.0 || v.abs() >= f32::MIN_POSITIVE), "{id}: subnormal output");
            assert!(tail.iter().chain(&r[r.len() - 48000..]).all(|v| *v == 0.0), "{id} {params:?}: not digital silence after 30 s");
        }
    }
}

#[test]
fn reset_clears_frozen_and_spectral_state() {
    for (id, params) in [
        ("krypt.grain", &[("freeze", 1.0)][..]),
        ("krypt.grain", &[("mode", 1.0), ("blur", 1.0)][..]),
        ("krypt.grain", &[("mode", 1.0), ("freeze", 1.0)][..]),
        ("krypt.tapeecho", &[("feedback", 1.1)][..]),
        ("krypt.glue", &[("threshold", -40.0)][..]),
        ("krypt.heat", &[("oversample", 2.0)][..]),
    ] {
        let mut e = fx(id, params);
        if id == "krypt.grain" && params.iter().any(|p| p.0 == "freeze") {
            e.set_param(param(id, "freeze"), 0.0);
            let (mut l, mut r) = (noise(24000, 1, 0.8), noise(24000, 2, 0.8));
            run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
            e.set_param(param(id, "freeze"), 1.0);
        }
        let (mut l, mut r) = (noise(24000, 1, 0.8), noise(24000, 2, 0.8));
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        e.reset();
        let (mut l, mut r) = (vec![0.0f32; 9600], vec![0.0f32; 9600]);
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        assert_eq!(peak(&l).max(peak(&r)), 0.0, "{id} {params:?} kept state after reset");
    }
}

#[test]
fn reported_latency_matches_the_impulse() {
    let cases: &[(&str, Params, usize)] = &[
        ("krypt.heat", &[("oversample", 0.0)], 0),
        ("krypt.heat", &[("oversample", 1.0)], 35),
        ("krypt.heat", &[("oversample", 2.0)], 41),
        ("krypt.grain", &[("mode", 1.0), ("blur", 0.0), ("mix", 1.0)], 2048),
        ("krypt.grain", &[], 0),
        ("krypt.tapeecho", &[], 0),
        ("krypt.glue", &[], 0),
    ];
    for (id, params, want) in cases {
        let mut e = fx(id, params);
        if *id == "krypt.heat" {
            for b in ["lowDrive", "midDrive", "highDrive"] {
                e.set_param(param(id, b), 0.0);
            }
            for b in ["lowShape", "midShape", "highShape"] {
                e.set_param(param(id, b), 3.0);
            }
        }
        let lat = e.latency();
        assert_eq!(lat, *want, "{id} {params:?}");
        if *id == "krypt.heat" || (*id == "krypt.grain" && lat > 0) {
            let (mut l, mut r) = (impulse(9600, 3000, 0.5), impulse(9600, 3000, 0.5));
            run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
            let at = argmax(&l);
            assert!((at as i64 - (3000 + lat) as i64).abs() <= 1, "{id} {params:?}: impulse at {at}, latency {lat}");
        }
    }
}

#[test]
fn heat_crossover_sums_flat_when_clean() {
    for os in [0.0, 1.0, 2.0] {
        for f in [40.0f32, 100.0, 200.0, 450.0, 1000.0, 2500.0, 5000.0, 10000.0, 16000.0] {
            let mut e = fx("krypt.heat", &[("oversample", os), ("lowDrive", 0.0), ("midDrive", 0.0), ("highDrive", 0.0)]);
            for b in ["lowShape", "midShape", "highShape"] {
                e.set_param(param("krypt.heat", b), 3.0);
            }
            let n = 48000;
            let x = sine(f, n, 0.25);
            let (mut l, mut r) = (x.clone(), x.clone());
            run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
            let gain = rms(&l[n / 2..]) / rms(&x[n / 2..]);
            let db = 20.0 * gain.log10();
            assert!(db.abs() < 0.1, "oversample {os}: {f} Hz is {db:.3} dB");
        }
    }
}

#[test]
fn heat_bands_drive_only_their_own_range() {
    let thd = |f: f32| {
        let mut e = fx("krypt.heat", &[("lowDrive", 0.0), ("midDrive", 0.0), ("highDrive", 30.0), ("highShape", 3.0)]);
        for b in ["lowShape", "midShape"] {
            e.set_param(param("krypt.heat", b), 3.0);
        }
        let x = sine(f, 48000, 0.5);
        let (mut l, mut r) = (x.clone(), x);
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        let fund = goertzel(&l[24000..], f);
        let h3 = goertzel(&l[24000..], 3.0 * f);
        h3 / fund
    };
    assert!(thd(100.0) < 1e-3, "low tone distorted: {}", thd(100.0));
    let x = 6000.0f32;
    let mut e = fx("krypt.heat", &[("highDrive", 30.0), ("highShape", 3.0)]);
    let s = sine(x, 48000, 0.5);
    let (mut l, mut r) = (s.clone(), s);
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!(goertzel(&l[24000..], 18000.0) / goertzel(&l[24000..], x) > 0.05);
}

#[test]
fn heat_rectify_and_tube_leave_no_dc() {
    let mut e = fx("krypt.heat", &[("lowShape", 5.0), ("midShape", 5.0), ("highShape", 1.0), ("lowDrive", 24.0), ("midDrive", 24.0)]);
    let x = sine(150.0, 96000, 0.7);
    let (mut l, mut r) = (x.clone(), x);
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    let mean = l[48000..].iter().map(|v| *v as f64).sum::<f64>() / 48000.0;
    assert!(mean.abs() < 1e-3, "DC {mean}");
}

#[test]
fn tape_echo_lands_on_the_synced_time() {
    for (bpm, div, want) in [(120.0, 9.0, 24000usize), (100.0, 5.0, 9600), (90.0, 7.0, 24000), (150.0, 3.0, 4800)] {
        let mut e = fx(
            "krypt.tapeecho",
            &[("division", div), ("wow", 0.0), ("flutter", 0.0), ("age", 0.0), ("feedback", 0.0), ("saturation", 0.0), ("mix", 1.0)],
        );
        let (mut l, mut r) = (impulse(60000, 1000, 0.5), impulse(60000, 1000, 0.5));
        run_fx(e.as_mut(), &mut l, &mut r, bpm, None);
        let at = argmax(&l);
        assert!((at as i64 - (1000 + want) as i64).abs() <= 2, "{bpm} bpm div {div}: echo at {}, want {want}", at - 1000);
    }
    let mut e = fx("krypt.tapeecho", &[("sync", 0.0), ("timeMs", 250.0), ("wow", 0.0), ("flutter", 0.0), ("feedback", 0.0), ("mix", 1.0)]);
    let (mut l, mut r) = (impulse(30000, 500, 0.5), impulse(30000, 500, 0.5));
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!((argmax(&l) as i64 - 12500).abs() <= 2, "{}", argmax(&l));
}

#[test]
fn tape_echo_feedback_saturates_and_wow_bends_pitch() {
    let mut e = fx("krypt.tapeecho", &[("feedback", 1.1), ("saturation", 1.0), ("mix", 1.0), ("division", 3.0)]);
    let (mut l, mut r) = (noise(48000 * 4, 5, 0.9), noise(48000 * 4, 6, 0.9));
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!(peak(&l) < 1.5, "{}", peak(&l));
    let spread = |wow: f32| {
        let mut e = fx("krypt.tapeecho", &[("wow", wow), ("flutter", 0.0), ("feedback", 0.0), ("mix", 1.0), ("age", 0.0)]);
        let x = sine(1000.0, 48000 * 3, 0.5);
        let (mut l, mut r) = (x.clone(), x);
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        let mut fmin = f32::MAX;
        let mut fmax = 0.0f32;
        for k in 0..20 {
            let s = 48000 + k * 4000;
            let f = zc_freq(&l[s..s + 2400], SR);
            fmin = fmin.min(f);
            fmax = fmax.max(f);
        }
        fmax - fmin
    };
    let (still, wobbly) = (spread(0.0), spread(1.0));
    assert!(still < 1.0, "no wow but the pitch moves: {still} Hz");
    assert!(wobbly > 5.0, "wow does not bend the pitch: {wobbly} Hz");
}

#[test]
fn tape_echo_freeze_loops_without_loss_and_ping_pong_alternates() {
    let mut e = fx("krypt.tapeecho", &[("division", 9.0), ("wow", 0.0), ("flutter", 0.0), ("mix", 1.0), ("feedback", 0.0)]);
    let (mut l, mut r) = (sine(300.0, 48000, 0.5), sine(300.0, 48000, 0.5));
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    e.set_param(param("krypt.tapeecho", "freeze"), 1.0);
    let (mut l, mut r) = (vec![0.0f32; 48000 * 4], vec![0.0f32; 48000 * 4]);
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    let (a, b) = (rms(&l[24000..48000]), rms(&l[48000 * 3..48000 * 4]));
    assert!(a > 0.2 && (a - b).abs() < 0.01 * a, "frozen loop decays: {a} → {b}");
    let mut e = fx("krypt.tapeecho", &[("division", 9.0), ("wow", 0.0), ("flutter", 0.0), ("mix", 1.0), ("pingPong", 1.0), ("feedback", 0.8)]);
    let (mut l, mut r) = (impulse(60000, 100, 0.5), impulse(60000, 100, 0.5));
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!(peak(&l[24000..24300]) > 0.1 && peak(&r[24000..24300]) < 1e-3, "first echo not left");
    assert!(peak(&r[48000..48300]) > 0.05 && peak(&l[48000..48300]) < 1e-3, "second echo not right");
}

#[test]
fn grain_is_deterministic_and_reset_restarts_it() {
    for params in [&[("spray", 1.0), ("reverse", 0.5), ("pitch", 7.0)][..], &[("mode", 1.0), ("blur", 0.7)][..]] {
        let render = |e: &mut dyn Effect| {
            let (mut l, mut r) = (noise(48000, 11, 0.7), sine(330.0, 48000, 0.5));
            run_fx(e, &mut l, &mut r, 120.0, None);
            (l, r)
        };
        let mut a = fx("krypt.grain", params);
        let mut b = fx("krypt.grain", params);
        let ra = render(a.as_mut());
        assert!(ra == render(b.as_mut()), "{params:?}: two instances differ");
        a.reset();
        assert!(ra == render(a.as_mut()), "{params:?}: reset does not restart identically");
    }
}

#[test]
fn grain_pitch_moves_the_tone() {
    for (st, f_out) in [(12.0f32, 880.0f32), (-12.0, 220.0), (7.0, 440.0 * 1.498_307)] {
        let mut e = fx("krypt.grain", &[("pitch", st), ("spray", 0.0), ("feedback", 0.0), ("mix", 1.0), ("size", 60.0), ("density", 40.0)]);
        let x = sine(440.0, 48000 * 2, 0.5);
        let (mut l, mut r) = (x.clone(), x);
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        let tail = &l[48000..];
        let band = |f: f32| (-12..=12).map(|k| goertzel(tail, f * (1.0 + 0.01 * k as f32)).powi(2)).sum::<f32>();
        let (moved, orig) = (band(f_out), band(440.0));
        assert!(moved > 4.0 * orig, "{st} st: {moved} at {f_out} Hz vs {orig} at 440 Hz");
    }
}

#[test]
fn grain_freeze_keeps_sounding_on_silence_in_both_modes() {
    for mode in [0.0, 1.0] {
        let mut e = fx("krypt.grain", &[("mode", mode), ("mix", 1.0), ("feedback", 0.0)]);
        let (mut l, mut r) = (sine(500.0, 48000, 0.5), sine(500.0, 48000, 0.5));
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        e.set_param(param("krypt.grain", "freeze"), 1.0);
        let (mut l, mut r) = (vec![0.0f32; 48000 * 3], vec![0.0f32; 48000 * 3]);
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
        let late = &l[48000 * 2..];
        assert!(rms(late) > 0.05, "mode {mode}: freeze died out ({})", rms(late));
        assert!(goertzel(late, 500.0) > 0.03, "mode {mode}: frozen tone lost");
    }
}

#[test]
fn grain_spectral_blur_zero_is_transparent_and_blur_smears() {
    let mut e = fx("krypt.grain", &[("mode", 1.0), ("blur", 0.0), ("mix", 1.0)]);
    let lat = e.latency();
    let x = noise(48000, 21, 0.5);
    let (mut l, mut r) = (x.clone(), x.clone());
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    let mut err = 0.0f32;
    for i in 8192..48000 {
        err = err.max((l[i] - x[i - lat]).abs());
    }
    assert!(err < 1e-4, "blur 0 is not transparent: {err}");
    let mut e = fx("krypt.grain", &[("mode", 1.0), ("blur", 0.6), ("mix", 1.0)]);
    let mut l = noise(24000, 3, 0.5);
    l.extend(std::iter::repeat_n(0.0, 24000));
    let mut r = l.clone();
    run_fx(e.as_mut(), &mut l, &mut r, 120.0, None);
    assert!(rms(&l[24000 + lat + 4800..24000 + lat + 9600]) > 0.02, "no smear tail");
}

#[test]
fn glue_follows_the_external_sidechain_and_its_hpf() {
    let run = |use_sc: f32, hpf: f32, sc_f: f32| {
        let mut e = fx("krypt.glue", &[("threshold", -20.0), ("ratio", 2.0), ("useSidechain", use_sc), ("scHpf", hpf)]);
        let x = sine(1000.0, 48000, 0.05);
        let (mut l, mut r) = (x.clone(), x);
        let sc = sine(sc_f, 48000, 0.9);
        run_fx(e.as_mut(), &mut l, &mut r, 120.0, Some((&sc, &sc)));
        20.0 * (rms(&l[24000..]) / (0.05 / 2f32.sqrt())).log10()
    };
    assert!(run(0.0, 0.0, 60.0) > -0.5, "own quiet input should pass");
    assert!(run(1.0, 0.0, 60.0) < -6.0, "loud sidechain should duck");
    assert!(run(1.0, 6.0, 40.0) > run(1.0, 0.0, 40.0) + 6.0);
}

#[test]
#[ignore]
fn cpu_per_block() {
    let cases: &[(&str, &str, Params)] = &[
        ("krypt.drive (reference)", "krypt.drive", &[]),
        ("krypt.heat 2x", "krypt.heat", &[]),
        ("krypt.heat 4x", "krypt.heat", &[("oversample", 2.0)]),
        ("krypt.heat off", "krypt.heat", &[("oversample", 0.0)]),
        ("krypt.tapeecho", "krypt.tapeecho", &[("pingPong", 1.0)]),
        ("krypt.grain (20/s, 90 ms)", "krypt.grain", &[]),
        ("krypt.grain (100/s, 500 ms, 64 grains)", "krypt.grain", &[("density", 100.0), ("size", 500.0), ("pitch", 5.0)]),
        ("krypt.grain spectral", "krypt.grain", &[("mode", 1.0)]),
        ("krypt.glue", "krypt.glue", &[("scHpf", 3.0)]),
        ("krypt.vocoder 16 bands", "krypt.vocoder", &[]),
        ("krypt.vocoder 40 bands + unvoiced", "krypt.vocoder", &[("bands", 40.0), ("unvoiced", 1.0)]),
    ];
    let n = 128;
    let blocks = 4000;
    for (name, id, params) in cases {
        let mut e = fx(id, params);
        e.prepare(SR, n);
        for (p, v) in params.iter() {
            e.set_param(param(id, p), *v);
        }
        let src_l = noise(n * 64, 1, 0.5);
        let src_r = noise(n * 64, 2, 0.5);
        let (mut l, mut r) = (vec![0.0f32; n], vec![0.0f32; n]);
        let mut worst = 0.0f64;
        let t0 = std::time::Instant::now();
        for b in 0..blocks {
            let o = (b % 64) * n;
            l.copy_from_slice(&src_l[o..o + n]);
            r.copy_from_slice(&src_r[o..o + n]);
            let c = ProcessContext { sample_rate: SR, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: n };
            let tb = std::time::Instant::now();
            e.process(&c, [&mut l, &mut r], Some([&src_r[o..o + n], &src_l[o..o + n]]));
            worst = worst.max(tb.elapsed().as_secs_f64());
        }
        let avg = t0.elapsed().as_secs_f64() / blocks as f64;
        println!("CPU {name:42} avg {:7.2} us / 128-frame stereo block (worst {:7.2} us)", avg * 1e6, worst * 1e6);
    }
}
