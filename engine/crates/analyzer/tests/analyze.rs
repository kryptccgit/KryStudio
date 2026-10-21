//! `analyze` on synthetic signals: tempo, beats, downbeats, key, swing,
//! sections, loudness, stereo.

mod common;

use common::*;
use krypt_studio_analyzer::analyze::{analyze_channels, Options};
use krypt_studio_analyzer::protocol::AudioAnalysis;
use krypt_studio_analyzer::JobCtx;

const KICK_44: &str = "x... .... x... ....";
const SNARE_BACK: &str = ".... x... .... x...";
const HAT_8: &str = "x.x. x.x. x.x. x.x.";
const HAT_16: &str = "xxxx xxxx xxxx xxxx";

fn run(chans: &[Vec<f32>], sections: bool, model: bool) -> AudioAnalysis {
    let opts = Options { sections, beat_model_dir: if model { Some(model_dir("beat-this-small")) } else { None }, ..Default::default() };
    analyze_channels("synthetic.wav", chans, SR, &opts, &JobCtx::detached()).expect("analysis")
}

fn summary(a: &AudioAnalysis) -> String {
    format!(
        "tempo {:?} key {:?} swing {:?} beats {} downbeats {:?} bpb {:?} sections {:?}",
        a.tempo.as_ref().map(|t| (t.bpm, t.confidence, t.alternatives.clone())),
        a.key.as_ref().map(|k| (k.name.clone(), k.confidence)),
        a.swing,
        a.beats.as_ref().map(|b| b.times.len()).unwrap_or(0),
        a.beats.as_ref().map(|b| b.downbeats.iter().take(4).copied().collect::<Vec<_>>()),
        a.beats.as_ref().map(|b| b.beats_per_bar),
        a.sections.iter().map(|s| (s.start_sec, s.label.clone())).collect::<Vec<_>>()
    )
}

fn assert_tempo(a: &AudioAnalysis, bpm: f32) {
    let t = a.tempo.as_ref().unwrap_or_else(|| panic!("no tempo: {}", summary(a)));
    assert!((t.bpm - bpm).abs() <= 1.0, "tempo {} vs {bpm}: {}", t.bpm, summary(a));
}

#[test]
fn tempo_120_groove() {
    let x = groove(120.0, 16, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.3);
    let a = run(&[x], false, false);
    eprintln!("120: {}", summary(&a));
    assert_tempo(&a, 120.0);
    let b = a.beats.as_ref().unwrap();
    // 16 bars × 4 beats; the tracker may trim one at either end.
    assert!((60..=66).contains(&b.times.len()), "{} beats", b.times.len());
    // Beats sit on the grid (offset 0.3 s, 0.5 s period) within 15 ms.
    for &t in &b.times {
        let ph = ((t - 0.3) / 0.5).round();
        assert!(((t - 0.3) - ph * 0.5).abs() < 0.015, "beat at {t} off the grid");
    }
    assert_eq!(b.beats_per_bar, 4);
    // Downbeats: kick on 1 and 3, snare on 2 and 4 → bar starts at 0.3 + 2k s
    // (the DSP heuristic may land on beat 3, which also carries the kick).
    for &d in &b.downbeats {
        let ph = ((d - 0.3) / 1.0).round();
        assert!(((d - 0.3) - ph).abs() < 0.015, "downbeat {d} not on a kick beat");
    }
    assert!(a.estimated.contains(&"tempo".to_string()) && a.estimated.contains(&"beats".to_string()));
}

#[test]
fn tempo_93_groove() {
    let x = groove(93.0, 12, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.1);
    let a = run(&[x], false, false);
    eprintln!("93: {}", summary(&a));
    assert_tempo(&a, 93.0);
    // 8th-note hats: no off-beat 16ths, so no 16th swing to report.
    assert!(a.swing.is_none(), "swing {:?}", a.swing);
    // Unpitched drums: no key.
    assert!(a.key.is_none(), "key {:?}", a.key.as_ref().map(|k| &k.name));
}

#[test]
fn tempo_click_track_120_and_93() {
    for bpm in [120.0f32, 93.0] {
        let mut x = silence(30.0);
        let k = kick();
        let mut t = 0.2;
        while t < 29.5 {
            add(&mut x, t, &k, 0.8);
            t += 60.0 / bpm;
        }
        let a = run(&[x], false, false);
        eprintln!("click {bpm}: {}", summary(&a));
        assert_tempo(&a, bpm);
        assert!(a.key.is_none(), "a kick alone has no key: {}", summary(&a));
    }
}

#[test]
fn tempo_140_trap_half_time() {
    // 140 BPM, 16th hats, kick syncopated, snare on beat 3 (half-time feel).
    let x = groove(140.0, 16, "x... .... ..x. ..x.", ".... .... x... ....", HAT_16, 0.0, 0.2);
    let a = run(&[x], false, false);
    eprintln!("trap: {}", summary(&a));
    let t = a.tempo.as_ref().expect("tempo");
    let readings: Vec<f32> = std::iter::once(t.bpm).chain(t.alternatives.iter().copied()).collect();
    let near = |v: f32| readings.iter().any(|r| (r - v).abs() <= 1.0);
    assert!(near(140.0) && near(70.0), "140/70 ambiguity not reported: {:?}", readings);
    assert!((t.bpm - 140.0).abs() <= 1.0 || (t.bpm - 70.0).abs() <= 1.0, "{}", t.bpm);
}

#[test]
fn no_pulse_gives_null_tempo() {
    let mut rng = Rng::new(3);
    let noise: Vec<f32> = (0..(20.0 * SR) as usize).map(|_| 0.2 * rng.next()).collect();
    let a = run(&[noise], false, false);
    eprintln!("noise: {}", summary(&a));
    assert!(a.tempo.is_none(), "noise has a tempo: {}", summary(&a));
    assert!(a.beats.is_none());
    assert!(a.key.is_none(), "noise has a key: {}", summary(&a));
    // A sustained chord has a key but no pulse.
    let pad = chord(&[60.0, 64.0, 67.0], 20.0, 0.2);
    for model in [false, true] {
        let a = run(std::slice::from_ref(&pad), false, model);
        eprintln!("pad (model {model}): {}", summary(&a));
        assert!(a.tempo.is_none() && a.beats.is_none(), "pad has a tempo: {}", summary(&a));
    }
}

fn progression(chords: &[&[f32]], secs_each: f32, repeats: usize) -> Vec<f32> {
    let mut x = Vec::new();
    for _ in 0..repeats {
        for c in chords {
            x.extend(chord(c, secs_each, 0.15));
        }
    }
    x
}

#[test]
fn key_c_major_and_a_minor() {
    // I–IV–V–I in C (C E G, F A C, G B D, C E G), bass doubling the root.
    let c = progression(&[&[48.0, 60.0, 64.0, 67.0], &[53.0, 60.0, 65.0, 69.0], &[55.0, 59.0, 62.0, 67.0], &[48.0, 60.0, 64.0, 67.0]], 2.0, 3);
    let a = run(&[c], false, false);
    eprintln!("C: {}", summary(&a));
    let k = a.key.as_ref().expect("key");
    assert_eq!(k.name, "C");
    assert_eq!(k.mode, "major");
    // The pitch profile: 12 shares summing to 1, the C major notes on top.
    let pp = a.pitch_profile.as_ref().expect("pitch profile");
    assert_eq!(pp.len(), 12);
    assert!((pp.iter().sum::<f32>() - 1.0).abs() < 0.01, "{pp:?}");
    let in_key: f32 = [0usize, 2, 4, 5, 7, 9, 11].iter().map(|&i| pp[i]).sum();
    assert!(in_key > 0.85, "C major notes hold {in_key} of {pp:?}");
    assert!(pp[0] > pp[1] && pp[7] > pp[6], "{pp:?}");
    // i–iv–V–i in A minor (A C E, D F A, E G# B, A C E).
    let am = progression(&[&[45.0, 57.0, 60.0, 64.0], &[50.0, 57.0, 62.0, 65.0], &[52.0, 56.0, 59.0, 64.0], &[45.0, 57.0, 60.0, 64.0]], 2.0, 3);
    let a = run(&[am], false, false);
    eprintln!("Am: {}", summary(&a));
    let k = a.key.as_ref().expect("key");
    assert_eq!(k.name, "Am");
    assert_eq!(k.tonic, "A");
    assert_eq!(k.mode, "minor");
    // F# minor, spelled with a sharp: i–iv–V–i.
    let fsm = progression(&[&[42.0, 54.0, 57.0, 61.0], &[47.0, 54.0, 59.0, 62.0], &[49.0, 53.0, 56.0, 61.0], &[42.0, 54.0, 57.0, 61.0]], 2.0, 3);
    let a = run(&[fsm], false, false);
    eprintln!("F#m: {}", summary(&a));
    assert_eq!(a.key.as_ref().expect("key").name, "F#m");
}

#[test]
fn key_survives_drums_and_detuning() {
    // Eb major progression 30 cents sharp under a drum groove.
    let det = 0.3;
    let eb = progression(&[&[51.0 + det, 63.0 + det, 67.0 + det, 70.0 + det], &[56.0 + det, 63.0 + det, 68.0 + det, 72.0 + det], &[58.0 + det, 62.0 + det, 65.0 + det, 70.0 + det], &[51.0 + det, 63.0 + det, 67.0 + det, 70.0 + det]], 2.0, 3);
    let mut x = groove(120.0, 12, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.0);
    mix(&mut x, &eb, 1.0);
    let a = run(&[x], false, false);
    eprintln!("Eb+drums: {}", summary(&a));
    assert_eq!(a.key.as_ref().expect("key").name, "Eb");
}

#[test]
fn swing_measured_on_transport_scale() {
    for (sw, lo, hi) in [(0.0f32, 0.0f32, 0.08f32), (0.5, 0.4, 0.6), (0.67, 0.57, 0.77)] {
        let x = groove(100.0, 12, KICK_44, SNARE_BACK, HAT_16, sw, 0.25);
        let a = run(&[x], false, false);
        eprintln!("swing {sw}: {}", summary(&a));
        let s = a.swing.unwrap_or_else(|| panic!("no swing for {sw}: {}", summary(&a)));
        assert!(s >= lo && s <= hi, "swing {sw} measured {s}");
    }
    // Only quarter-note hits: off-beat 16ths are empty → nothing to measure.
    let x = groove(100.0, 12, "x... x... x... x...", "", "", 0.0, 0.25);
    let a = run(&[x], false, false);
    assert!(a.swing.is_none(), "swing on a quarter-note pattern: {:?}", a.swing);
}

#[test]
fn sections_label_repeats() {
    // A (C–F chords, 8th hats) / B (Am–E chords, 16th hats, louder kick) / A / B; 8 bars each at 120.
    let bars = 8;
    let make = |b: bool| -> Vec<f32> {
        let mut d = if b { groove(120.0, bars, "x.x. ..x. x.x. ..x.", SNARE_BACK, HAT_16, 0.0, 0.0) } else { groove(120.0, bars, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.0) };
        d.truncate((bars as f32 * 2.0 * SR) as usize);
        let ch = if b { progression(&[&[45.0, 57.0, 60.0, 64.0], &[52.0, 56.0, 59.0, 64.0]], 2.0, bars / 2) } else { progression(&[&[48.0, 60.0, 64.0, 67.0], &[53.0, 60.0, 65.0, 69.0]], 2.0, bars / 2) };
        mix(&mut d, &ch, if b { 1.3 } else { 0.8 });
        d.truncate((bars as f32 * 2.0 * SR) as usize);
        d
    };
    let mut x = Vec::new();
    for b in [false, true, false, true] {
        x.extend(make(b));
    }
    let a = run(&[x], true, false);
    eprintln!("sections: {}", summary(&a));
    let labels: Vec<&str> = a.sections.iter().map(|s| s.label.as_str()).collect();
    assert_eq!(labels, vec!["A", "B", "A", "B"], "{}", summary(&a));
    for (s, want) in a.sections.iter().zip([0.0f32, 16.0, 32.0, 48.0]) {
        assert!((s.start_sec - want).abs() <= 1.1, "section at {} (want {want})", s.start_sec);
    }
    // B is louder than A.
    assert!(a.sections[1].lufs > a.sections[0].lufs);
}

#[test]
fn loudness_energy_and_stereo() {
    // Stereo: uncorrelated noise → wide; mono → width 0, correlation 1.
    let mut r1 = Rng::new(1);
    let mut r2 = Rng::new(2);
    let n = (12.0 * SR) as usize;
    let l: Vec<f32> = (0..n).map(|_| 0.25 * r1.next()).collect();
    let r: Vec<f32> = (0..n).map(|_| 0.25 * r2.next()).collect();
    let a = run(&[l.clone(), r], false, false);
    assert!(a.stereo.width > 0.9, "width {}", a.stereo.width);
    assert!(a.stereo.correlation.abs() < 0.05, "corr {}", a.stereo.correlation);
    assert_eq!(a.channels, 2);
    let a = run(std::slice::from_ref(&l), false, false);
    assert_eq!(a.stereo.width, 0.0);
    assert!((a.stereo.correlation - 1.0).abs() < 1e-3);
    // Energy curve: 0.5 s hop, covers the file, matches the engine's integrated loudness.
    assert_eq!(a.energy.hop_sec, 0.5);
    assert_eq!(a.energy.lufs.len(), 24);
    let mid = a.energy.lufs[12];
    assert!((mid - a.levels.lufs_integrated).abs() < 0.5, "short-term {mid} vs integrated {}", a.levels.lufs_integrated);
    // Quiet then loud: the curve follows.
    let mut x = vec![0f32; n];
    for i in 0..n {
        x[i] = l[i] * if i < n / 2 { 0.1 } else { 1.0 };
    }
    let a = run(&[x], false, false);
    assert!(a.energy.lufs[20] - a.energy.lufs[3] > 15.0, "{:?}", a.energy.lufs);
}

#[test]
fn integrated_loudness_matches_engine() {
    use krypt_studio_analyzer::loudness::Loudness;
    let x = groove(120.0, 8, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.0);
    let lv = krypt_studio_dsp::analysis::analyze(&x, &x, SR);
    let ours = Loudness::measure(&[&x], SR).integrated(0.0, x.len() as f32 / SR);
    assert!((ours - lv.lufs_integrated).abs() < 0.3, "ours {ours} engine {}", lv.lufs_integrated);
}

#[test]
fn beat_model_path() {
    let dir = model_dir("beat-this-small");
    assert!(dir.join("beat_this_small.onnx").is_file(), "bundled model missing at {}", dir.display());
    let x = groove(120.0, 12, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.3);
    let a = run(&[x], false, true);
    eprintln!("model 120: {} sources {:?}", summary(&a), a.sources);
    assert!(a.sources.iter().any(|s| s.contains("Beat This!")), "{:?}", a.sources);
    let t = a.tempo.as_ref().expect("tempo");
    let readings: Vec<f32> = std::iter::once(t.bpm).chain(t.alternatives.iter().copied()).collect();
    assert!(readings.iter().any(|r| (r - 120.0).abs() <= 1.0), "{:?}", readings);
    let b = a.beats.as_ref().unwrap();
    assert!(b.downbeats.iter().all(|d| b.times.contains(d)), "downbeats must be a subset of beats");
    assert_eq!(b.beats_per_bar, 4);
}

#[test]
fn missing_beat_model_falls_back_with_a_note() {
    let x = groove(120.0, 8, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.3);
    let opts = Options { sections: false, beat_model_dir: Some(std::path::PathBuf::from("C:/nope/beat-this-small")), ..Default::default() };
    let a = analyze_channels("x.wav", &[x], SR, &opts, &JobCtx::detached()).unwrap();
    assert_tempo(&a, 120.0);
    assert!(a.sources.iter().any(|s| s.contains("beat model unavailable") && s.contains("not found")), "{:?}", a.sources);
}

#[test]
fn analyze_file_end_to_end_and_errors() {
    use krypt_studio_analyzer::protocol::AnalyzeArgs;
    let dir = temp_dir("analyze");
    let p = dir.join("loop.wav");
    let x = groove(120.0, 8, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.3);
    write_wav(&p, &[x.clone(), x], 44_100);
    let args = AnalyzeArgs { path: p.to_string_lossy().into(), sections: true, beat_model_dir: None, drums: false };
    let a = krypt_studio_analyzer::analyze::run(&args, &JobCtx::detached()).unwrap();
    assert_eq!(a.sample_rate, 44_100);
    assert_eq!(a.channels, 2);
    assert!((a.duration_sec - 16.8).abs() < 0.01);
    assert_tempo(&a, 120.0);
    let json = serde_json::to_value(&a).unwrap();
    for k in ["durationSec", "sampleRate", "tempo", "beats", "key", "swing", "sections", "levels", "stereo", "energy", "onsetRate", "estimated", "sources"] {
        assert!(json.get(k).is_some(), "missing {k}");
    }
    assert!(json["beats"]["beatsPerBar"].is_number());
    assert!((a.onset_rate - 4.0).abs() < 1.0, "onset rate {}", a.onset_rate);
    // Missing file → a sentence naming it.
    let bad = AnalyzeArgs { path: dir.join("nope.wav").to_string_lossy().into(), sections: true, beat_model_dir: None, drums: false };
    match krypt_studio_analyzer::analyze::run(&bad, &JobCtx::detached()) {
        Err(krypt_studio_analyzer::JobError::Failed(m)) => assert!(m.contains("nope.wav"), "{m}"),
        _ => panic!("expected failure"),
    }
    // Garbage file → unsupported/corrupt.
    let junk = dir.join("junk.wav");
    std::fs::write(&junk, b"this is not audio at all").unwrap();
    let bad = AnalyzeArgs { path: junk.to_string_lossy().into(), sections: true, beat_model_dir: None, drums: false };
    match krypt_studio_analyzer::analyze::run(&bad, &JobCtx::detached()) {
        Err(krypt_studio_analyzer::JobError::Failed(m)) => assert!(m.contains("junk.wav"), "{m}"),
        _ => panic!("expected failure"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cancel_stops_analysis() {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    let flag = Arc::new(AtomicBool::new(true));
    let ctx = JobCtx::new(1, flag, Arc::new(|_| {}));
    let x = groove(120.0, 8, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.3);
    let r = analyze_channels("x.wav", &[x], SR, &Options { sections: true, beat_model_dir: None, ..Default::default() }, &ctx);
    assert!(matches!(r, Err(krypt_studio_analyzer::JobError::Cancelled)));
}

/// 3-minute stereo 44.1 kHz performance check (run with --ignored, release).
#[test]
#[ignore]
fn perf_three_minutes() {
    let mut x = Vec::new();
    while x.len() < (180.0 * SR) as usize {
        x.extend(groove(124.0, 8, KICK_44, SNARE_BACK, HAT_16, 0.0, 0.0));
    }
    x.truncate((180.0 * SR) as usize);
    let pad = progression(&[&[45.0, 57.0, 60.0, 64.0], &[53.0, 57.0, 60.0, 65.0]], 2.0, 45);
    mix(&mut x, &pad, 1.0);
    let r: Vec<f32> = x.iter().enumerate().map(|(i, v)| v * if i % 2 == 0 { 0.9 } else { 1.0 }).collect();
    for model in [false, true] {
        let t = std::time::Instant::now();
        let a = run(&[x.clone(), r.clone()], true, model);
        eprintln!("PERF analyze 3 min stereo 44.1k (model {model}): {:.2} s — {}", t.elapsed().as_secs_f32(), summary(&a));
    }
}

// ── harmonic-rich key regressions (detuned saws, sub bass, dense hats) ──

const BAR140: f32 = 60.0 / 140.0 * 4.0;
const FM9: &[f32] = &[53.0, 56.0, 60.0, 63.0, 67.0]; // F3 Ab3 C4 Eb4 G4
const DBMAJ7: &[f32] = &[49.0, 53.0, 56.0, 60.0, 65.0]; // Db3 F3 Ab3 C4 F4
const EBMAJ9: &[f32] = &[51.0, 55.0, 58.0, 62.0, 65.0]; // Eb3 G3 Bb3 D4 F4
const CM7: &[f32] = &[48.0, 51.0, 55.0, 58.0]; // C3 Eb3 G3 Bb3

fn f_minor_pad(detune: f32, loops: usize) -> Vec<f32> {
    let bar: [(&[f32], f32); 4] = [(FM9, BAR140), (DBMAJ7, BAR140), (EBMAJ9, BAR140), (CM7, BAR140)];
    let chords: Vec<(&[f32], f32)> = (0..loops).flat_map(|_| bar.iter().copied()).collect();
    saw_pad(&chords, 12.0, detune, 2400.0, 0.12)
}

/// The expected key, or its relative with the expected key ranked second.
fn assert_key_or_relative(a: &AudioAnalysis, want: &str, relative: &str) {
    let k = a.key.as_ref().unwrap_or_else(|| panic!("no key (want {want}): {}", summary(a)));
    assert!(k.name == want || k.name == relative, "key {} (want {want} or {relative})", k.name);
}

#[test]
fn key_detuned_saw_pad_minor_sevenths() {
    for detune in [0.0f32, 20.0, -20.0] {
        let x = f_minor_pad(detune, 4);
        let a = run(&[x], false, false);
        eprintln!("saw pad Fm (detune {detune:+}): {}", summary(&a));
        assert_key_or_relative(&a, "Fm", "Ab");
    }
    // D minor with a harmonic-minor V7: Dm7 – Bbmaj7 – Gm7 – A7, 20 cents sharp.
    let bar: [(&[f32], f32); 4] = [(&[50.0, 53.0, 57.0, 60.0], 2.0), (&[46.0, 50.0, 53.0, 57.0], 2.0), (&[43.0, 46.0, 50.0, 53.0], 2.0), (&[45.0, 49.0, 52.0, 55.0], 2.0)];
    let chords: Vec<(&[f32], f32)> = (0..3).flat_map(|_| bar.iter().copied()).collect();
    let x = saw_pad(&chords, 15.0, 20.0, 3000.0, 0.12);
    let a = run(&[x], false, false);
    eprintln!("saw pad Dm: {}", summary(&a));
    assert_key_or_relative(&a, "Dm", "F");
}

#[test]
fn key_sub_bass_saw_pad_under_dense_hats() {
    // i – VI – VII – i in F minor; square-bass roots F1 (43.7 Hz), Db1
    // (34.6 Hz), Eb1 (38.9 Hz): the 808 register. (The Neon Fog loop itself,
    // i – VI – VII – v, is a near-tie between Fm and Cm on pitch content; a
    // loud, partial-rich bass then decides it. The real demo is covered by
    // tests/neonfog.rs.)
    let bass_bar = [(29.0, BAR140), (25.0, BAR140), (27.0, BAR140), (29.0, BAR140)];
    let bass_notes: Vec<(f32, f32)> = (0..4).flat_map(|_| bass_bar.iter().copied()).collect();
    let bar: [(&[f32], f32); 4] = [(FM9, BAR140), (DBMAJ7, BAR140), (EBMAJ9, BAR140), (FM9, BAR140)];
    let chords: Vec<(&[f32], f32)> = (0..4).flat_map(|_| bar.iter().copied()).collect();
    for detune in [0.0f32, -20.0] {
        let mut x = saw_pad(&chords, 12.0, detune, 2400.0, 0.12);
        mix(&mut x, &square_bass(&bass_notes, detune, 0.5), 1.0);
        let secs = x.len() as f32 / SR;
        mix(&mut x, &hats_and_claps(140.0, secs, 1.0), 1.0);
        let a = run(&[x], false, false);
        eprintln!("bass+pad+hats (detune {detune:+}): {}", summary(&a));
        assert_key_or_relative(&a, "Fm", "Ab");
    }
}

#[test]
fn key_square_bass_alone() {
    // An F-minor bass riff with fundamentals at 35–55 Hz (and its octave).
    let q = 60.0 / 140.0;
    let riff = [29.0, 32.0, 36.0, 29.0, 25.0, 29.0, 32.0, 25.0, 27.0, 31.0, 34.0, 27.0, 36.0, 32.0, 31.0, 29.0];
    let notes: Vec<(f32, f32)> = (0..4).flat_map(|_| riff.iter().map(|&m| (m, q))).collect();
    let x = square_bass(&notes, 0.0, 0.6);
    let a = run(&[x], false, false);
    eprintln!("square bass: {}", summary(&a));
    assert_key_or_relative(&a, "Fm", "Ab");
}

#[test]
fn dense_hats_and_claps_have_no_key() {
    let a = run(&[hats_and_claps(140.0, 20.0, 1.0)], false, false);
    eprintln!("hats+claps: {}", summary(&a));
    assert!(a.key.is_none(), "{}", summary(&a));
}

// ── key re-ranking by chord function (transposed Neon Fog loop) ──

/// The Neon Fog loop (i9 – VImaj7 – VIImaj9 – v7, demo voicings) moved by
/// `shift` semitones at 142 BPM: detuned saw pad, square bass on the roots
/// (the demo's 808 rhythm) and a drum groove whose kick has a fixed pitch
/// (~50 Hz) that does not move with the song — as in the real demo, it
/// biases the pitch profile, and the chords must set the key straight.
fn transposed_loop(shift: f32, loops: usize) -> Vec<f32> {
    let bar = 240.0 / 142.0;
    let s = |v: &[f32]| -> Vec<f32> { v.iter().map(|m| m + shift).collect() };
    let voicings = [s(FM9), s(DBMAJ7), s(EBMAJ9), s(CM7)];
    let bar_chords: Vec<(&[f32], f32)> = voicings.iter().map(|v| (v.as_slice(), bar)).collect();
    let chords: Vec<(&[f32], f32)> = (0..loops).flat_map(|_| bar_chords.iter().copied()).collect();
    let mut x = saw_pad(&chords, 12.0, 0.0, 2400.0, 0.12);
    // 808 rhythm on the roots (beats): F F Ab | Db Db C | Eb Eb F | C C Eb.
    let q = 60.0 / 142.0;
    let line: [(f32, f32); 12] = [(29.0, 2.5), (29.0, 1.0), (32.0, 0.5), (37.0, 2.5), (37.0, 0.75), (36.0, 0.75), (39.0, 2.5), (39.0, 1.0), (41.0, 0.5), (36.0, 2.5), (36.0, 0.75), (39.0, 0.75)];
    let notes: Vec<(f32, f32)> = (0..loops).flat_map(|_| line.iter().map(|&(m, b)| (m + shift, b * q))).collect();
    mix(&mut x, &square_bass(&notes, 0.0, 0.45), 1.0);
    let mut d = groove(142.0, 4 * loops, "x... .... ..x. ....", ".... x... .... x...", "x.x. x.x. x.x. x.x.", 0.0, 0.0);
    d.truncate(x.len());
    mix(&mut x, &d, 0.8);
    x
}

#[test]
fn key_from_chords_on_transposed_minor_loop() {
    for (shift, want) in [(5.0f32, "Bbm"), (0.0, "Fm"), (-3.0, "Dm")] {
        let x = transposed_loop(shift, 6);
        let a = run(&[x], false, false);
        eprintln!("loop {shift:+}: {} sources {:?}", summary(&a), a.sources.iter().filter(|s| s.starts_with("key")).collect::<Vec<_>>());
        let k = a.key.as_ref().unwrap_or_else(|| panic!("no key at {shift:+}"));
        assert_eq!(k.name, want, "shift {shift:+}");
    }
}
