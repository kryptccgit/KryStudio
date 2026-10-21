mod common;

use common::*;
use krypt_studio_analyzer::fingerprint::{fingerprint_channels, run};
use krypt_studio_analyzer::protocol::{FingerprintArgs, FingerprintSegment, SoundFingerprint};
use krypt_studio_analyzer::JobCtx;
use std::f32::consts::PI;

fn fp1(x: &[f32]) -> SoundFingerprint {
    fp_ch(&[x.to_vec()])
}

fn fp_ch(ch: &[Vec<f32>]) -> SoundFingerprint {
    fingerprint_channels(ch, SR, None, true, &JobCtx::detached()).unwrap().whole.unwrap()
}

fn sine(f: f32, secs: f32, amp: f32) -> Vec<f32> {
    (0..(secs * SR) as usize).map(|i| amp * (2.0 * PI * f * i as f32 / SR).sin()).collect()
}

fn noise(seed: u64, secs: f32, amp: f32) -> Vec<f32> {
    let mut r = Rng::new(seed);
    (0..(secs * SR) as usize).map(|_| amp * r.next()).collect()
}

fn bands(fp: &SoundFingerprint) -> [f32; 6] {
    let b = &fp.bands;
    [b.sub, b.low, b.low_mid, b.mid, b.high_mid, b.high]
}

fn all_finite(fp: &SoundFingerprint) {
    let v = serde_json::to_value(fp).unwrap();
    for (k, x) in v.as_object().unwrap() {
        match x {
            serde_json::Value::Number(n) => assert!(n.as_f64().unwrap().is_finite(), "{k}"),
            serde_json::Value::Null => assert_eq!(k, "f0Hz"),
            serde_json::Value::Object(o) => assert!(o.values().all(|n| n.as_f64().is_some_and(f64::is_finite)), "{k}"),
            other => panic!("{k}: {other}"),
        }
    }
    assert!(bands(fp).iter().all(|&b| b <= 0.0));
}

#[test]
fn sine_440_is_pitched_and_tonal() {
    let fp = fp1(&sine(440.0, 1.0, 0.5));
    eprintln!("sine: {fp:?}");
    all_finite(&fp);
    let f0 = fp.f0_hz.expect("f0");
    assert!((f0 - 440.0).abs() < 2.0, "f0 {f0}");
    assert!(fp.harmonicity > 0.95, "harmonicity {}", fp.harmonicity);
    assert!(fp.flatness < 0.02, "flatness {}", fp.flatness);
    assert!((fp.centroid_hz - 440.0).abs() < 30.0, "centroid {}", fp.centroid_hz);
    assert!((fp.rolloff_hz - 440.0).abs() < 30.0, "rolloff {}", fp.rolloff_hz);
    assert_eq!(fp.bands.low_mid, 0.0);
    assert!((fp.peak_db - -6.02).abs() < 0.1, "peak {}", fp.peak_db);
    assert!((fp.rms_db - -9.03).abs() < 0.1, "rms {}", fp.rms_db);
    assert!((fp.crest_db - 3.01).abs() < 0.1, "crest {}", fp.crest_db);
    assert!(fp.sustain > 0.9, "sustain {}", fp.sustain);
    assert!(fp.attack_ms < 10.0, "attack {}", fp.attack_ms);
    assert_eq!(fp.width, 0.0);
    assert!((fp.length_sec - 1.0).abs() < 0.01);
    let np = fingerprint_channels(&[sine(440.0, 1.0, 0.5)], SR, None, false, &JobCtx::detached()).unwrap().whole.unwrap();
    assert!(np.f0_hz.is_none());
    assert!((np.harmonicity - fp.harmonicity).abs() < 1e-6);
}

#[test]
fn low_and_high_pitches() {
    for f in [41.2f32, 55.0, 110.0, 880.0, 1500.0] {
        let fp = fp1(&tone(f, 1.0, &[0.5, 0.25]));
        let f0 = fp.f0_hz.unwrap_or(0.0);
        assert!((f0 / f).log2().abs() < 0.02, "{f} Hz → f0 {f0} (h {})", fp.harmonicity);
    }
}

#[test]
fn white_noise_is_flat_and_unpitched() {
    let fp = fp1(&noise(3, 1.0, 0.5));
    eprintln!("noise: {fp:?}");
    all_finite(&fp);
    assert!(fp.flatness > 0.85, "flatness {}", fp.flatness);
    assert!(fp.harmonicity < 0.4, "harmonicity {}", fp.harmonicity);
    assert!(fp.f0_hz.is_none());
    assert_eq!(fp.bands.high, 0.0);
    assert!(fp.centroid_hz > 7000.0, "centroid {}", fp.centroid_hz);
    assert!(fp.rolloff_hz > 14_000.0, "rolloff {}", fp.rolloff_hz);
}

#[test]
fn kick_is_low_short_and_snappy() {
    let mut k = silence(0.1);
    k.extend(kick());
    k.extend(silence(0.3));
    let fp = fp1(&k);
    eprintln!("kick: {fp:?}");
    all_finite(&fp);
    let b = bands(&fp);
    let loudest = b.iter().position(|&x| x == 0.0).unwrap();
    assert!(loudest <= 1, "bands {b:?}");
    assert!(fp.bands.high < -40.0, "bands {b:?}");
    assert!(fp.attack_ms < 10.0, "attack {}", fp.attack_ms);
    assert!(fp.decay_ms > 80.0 && fp.decay_ms < 260.0, "decay {}", fp.decay_ms);
    assert!(fp.sustain < 0.25, "sustain {}", fp.sustain);
    assert!(fp.length_sec < 0.27, "silence trimmed: {}", fp.length_sec);
    assert!(fp.centroid_hz < 150.0, "centroid {}", fp.centroid_hz);
    if let Some(f0) = fp.f0_hz {
        assert!((40.0..160.0).contains(&f0), "f0 {f0}");
    }
}

#[test]
fn pad_is_sustained_with_slow_attack() {
    let mut p = saw_pad(&[(&[57.0, 60.0, 64.0], 2.0)], 12.0, 0.0, 2500.0, 0.15);
    let ramp = (0.4 * SR) as usize;
    for (i, v) in p.iter_mut().enumerate().take(ramp) {
        *v *= i as f32 / ramp as f32;
    }
    let fp = fp1(&p);
    eprintln!("pad: {fp:?}");
    all_finite(&fp);
    assert!(fp.sustain > 0.6, "sustain {}", fp.sustain);
    assert!(fp.attack_ms > 250.0 && fp.attack_ms < 450.0, "attack {}", fp.attack_ms);
    let mut o = tone(220.0, 2.0, &[0.5, 0.3, 0.2]);
    for (i, v) in o.iter_mut().enumerate().take(ramp) {
        *v *= i as f32 / ramp as f32;
    }
    let organ = fp1(&o);
    assert!(organ.sustain > 0.9, "organ sustain {}", organ.sustain);
    assert!(organ.attack_ms > 300.0 && organ.attack_ms < 420.0, "organ attack {}", organ.attack_ms);
    assert!((organ.f0_hz.unwrap() - 220.0).abs() < 1.5);
    assert!(fp.decay_ms > 1000.0, "decay {}", fp.decay_ms);
    assert!(fp.harmonicity > 0.4, "harmonicity {}", fp.harmonicity);
    assert!(fp.flatness < 0.3, "flatness {}", fp.flatness);
}

#[test]
fn stereo_width() {
    let l = noise(1, 1.0, 0.3);
    let r = noise(2, 1.0, 0.3);
    let wide = fp_ch(&[l.clone(), r]);
    let mono = fp_ch(&[l.clone(), l.clone()]);
    let single = fp_ch(&[l.clone()]);
    let anti = fp_ch(&[l.clone(), l.iter().map(|v| -v).collect()]);
    eprintln!("width: decorrelated {} dual-mono {} mono {} anti {}", wide.width, mono.width, single.width, anti.width);
    assert!(wide.width > 0.85, "{}", wide.width);
    assert!(mono.width < 1e-6);
    assert_eq!(single.width, 0.0);
    assert_eq!(anti.width, 1.0);
    let r2: Vec<f32> = l.iter().zip(noise(5, 1.0, 0.3)).map(|(a, b)| 0.7 * a + 0.3 * b).collect();
    let mid = fp_ch(&[l, r2]);
    assert!(mid.width > 0.02 && mid.width < 0.6, "{}", mid.width);
}

#[test]
fn segments_from_a_file() {
    let sr = 48_000u32;
    let s = |secs: f32| (secs * sr as f32) as usize;
    let mut x = vec![0f32; s(2.0)];
    for (i, v) in x.iter_mut().enumerate().take(s(1.0)) {
        *v = 0.4 * (2.0 * PI * 220.0 * i as f32 / sr as f32).sin();
    }
    let mut rng = Rng::new(9);
    for v in x.iter_mut().skip(s(1.5)) {
        *v = 0.3 * rng.next();
    }
    let dir = temp_dir("fingerprint");
    let path = dir.join("segs.wav");
    write_wav(&path, &[x.clone(), x.clone()], sr);
    let seg = |a: f64, b: f64| FingerprintSegment { start_sec: a, end_sec: b };
    let args = FingerprintArgs {
        path: path.display().to_string(),
        segments: Some(vec![seg(0.1, 0.6), seg(1.0, 1.5), seg(1.6, 3.0), seg(5.0, 6.0), seg(0.8, 0.2), seg(-1.0, 0.3)]),
        pitch: None,
        highpass_hz: None,
    };
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let ev2 = events.clone();
    let ctx = JobCtx::new(1, Default::default(), std::sync::Arc::new(move |e| ev2.lock().unwrap().push(e)));
    let res = run(&args, &ctx).unwrap();
    assert!(res.whole.is_none());
    assert_eq!(res.segments.len(), 6);
    let f = &res.segments;
    assert!((f[0].f0_hz.unwrap() - 220.0).abs() < 1.5, "{:?}", f[0].f0_hz);
    assert!((f[0].length_sec - 0.5).abs() < 0.01);
    assert_eq!(f[1].length_sec, 0.0, "silent segment");
    assert_eq!(f[1].peak_db, -120.0);
    assert!(f[2].flatness > 0.8 && f[2].f0_hz.is_none(), "{:?}", f[2]);
    assert!((f[2].length_sec - 0.4).abs() < 0.01, "clipped at EOF: {}", f[2].length_sec);
    assert_eq!(f[3].length_sec, 0.0, "past EOF");
    assert_eq!(f[4].length_sec, 0.0, "inverted");
    assert!((f[5].length_sec - 0.3).abs() < 0.01, "negative start clipped: {}", f[5].length_sec);
    for fp in f {
        all_finite(fp);
    }
    let v = serde_json::to_value(&res).unwrap();
    assert!(v.get("whole").is_none());
    let s0 = &v["segments"][0];
    for k in ["lengthSec", "centroidHz", "rolloffHz", "flatness", "harmonicity", "f0Hz", "attackMs", "decayMs", "sustain", "bands", "crestDb", "width", "peakDb", "rmsDb"] {
        assert!(s0.get(k).is_some(), "missing {k}");
    }
    for k in ["sub", "low", "lowMid", "mid", "highMid", "high"] {
        assert!(s0["bands"].get(k).is_some(), "missing bands.{k}");
    }
    assert!(v["segments"][2]["f0Hz"].is_null());
    let whole = run(&FingerprintArgs { path: path.display().to_string(), segments: None, pitch: Some(false), highpass_hz: None }, &JobCtx::detached()).unwrap();
    assert!(whole.segments.is_empty());
    let w = whole.whole.unwrap();
    assert!((w.length_sec - 2.0).abs() < 0.01);
    assert!(w.f0_hz.is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn many_segments_report_progress_and_bad_input_is_named() {
    let x = sine(330.0, 4.0, 0.3);
    let segs: Vec<(f64, f64)> = (0..64).map(|i| (i as f64 * 0.05, i as f64 * 0.05 + 0.5)).collect();
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let ev2 = events.clone();
    let ctx = JobCtx::new(7, Default::default(), std::sync::Arc::new(move |e| ev2.lock().unwrap().push(e)));
    let res = fingerprint_channels(&[x], SR, Some(&segs), true, &ctx).unwrap();
    assert_eq!(res.segments.len(), 64);
    let n = events.lock().unwrap().len();
    assert!(n >= 10, "progress events {n}");
    let bad = FingerprintArgs { path: "x.wav".into(), segments: Some(vec![FingerprintSegment { start_sec: f64::NAN, end_sec: 1.0 }]), pitch: None, highpass_hz: None };
    let e = match run(&bad, &JobCtx::detached()) {
        Err(krypt_studio_analyzer::JobError::Failed(m)) => m,
        _ => panic!("expected an error"),
    };
    assert!(e.contains("Segment 1"), "{e}");
    let missing = FingerprintArgs { path: "C:\\nope\\missing.wav".into(), segments: None, pitch: None, highpass_hz: None };
    assert!(matches!(run(&missing, &JobCtx::detached()), Err(krypt_studio_analyzer::JobError::Failed(m)) if m.contains("does not exist")));
}

#[test]
fn speed_per_half_second_segment() {
    let sr = 48_000.0;
    let n = (sr * 30.0) as usize;
    let mut r = Rng::new(4);
    let l: Vec<f32> = (0..n).map(|i| 0.3 * (2.0 * PI * 110.0 * i as f32 / sr).sin() + 0.05 * r.next()).collect();
    let rr: Vec<f32> = l.iter().map(|v| v * 0.9).collect();
    let segs: Vec<(f64, f64)> = (0..200).map(|i| (i as f64 * 0.145, i as f64 * 0.145 + 0.5)).collect();
    let t = std::time::Instant::now();
    let res = fingerprint_channels(&[l, rr], sr, Some(&segs), true, &JobCtx::detached()).unwrap();
    let per = t.elapsed().as_secs_f64() * 1000.0 / 200.0;
    eprintln!("fingerprint: {per:.2} ms per 0.5 s segment ({} build)", if cfg!(debug_assertions) { "debug" } else { "release" });
    assert_eq!(res.segments.len(), 200);
    if !cfg!(debug_assertions) {
        assert!(per < 5.0, "{per} ms per segment");
    }
}

fn sub_len() -> usize {
    (0.12 * SR) as usize
}

#[test]
fn highpass_removes_a_ringing_kick_under_a_hat() {
    let sr = SR;
    let n = sub_len();
    let sub = sine(50.0, 0.12, 0.8);
    let hiss = noise(7, 0.12, 0.15);
    let n = n.min(sub.len()).min(hiss.len());
    let hp_hiss = krypt_studio_analyzer::fingerprint::highpass(&hiss, sr, 6000.0);
    let mix: Vec<f32> = (0..n).map(|i| sub[i] + hp_hiss[i] * (1.0 - i as f32 / n as f32)).collect();
    let raw = fp1(&mix);
    let filtered = fp1(&krypt_studio_analyzer::fingerprint::highpass(&mix, sr, 2000.0));
    assert!(raw.rolloff_hz < 1000.0, "unfiltered rolloff {} Hz is the kick's", raw.rolloff_hz);
    assert!(filtered.rolloff_hz > 6000.0, "filtered rolloff {} Hz is the hat's", filtered.rolloff_hz);
    assert!(filtered.centroid_hz > 5000.0, "filtered centroid {} Hz", filtered.centroid_hz);
    all_finite(&filtered);
}
