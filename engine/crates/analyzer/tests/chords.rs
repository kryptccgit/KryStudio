mod common;

use common::*;
use krypt_studio_analyzer::analyze::{analyze_channels, Options};
use krypt_studio_analyzer::chords::NOTE;
use krypt_studio_analyzer::protocol::{AudioAnalysis, ChordSpan};
use krypt_studio_analyzer::JobCtx;

const KICK_44: &str = "x... .... x... ....";
const SNARE_BACK: &str = ".... x... .... x...";
const HAT_8: &str = "x.x. x.x. x.x. x.x.";

fn run(x: Vec<f32>, drums: bool) -> AudioAnalysis {
    let opts = Options { sections: false, beat_model_dir: None, drums };
    analyze_channels("synthetic.wav", &[x], SR, &opts, &JobCtx::detached()).expect("analysis")
}

fn label(root: u8, q: &str) -> String {
    format!("{}{}", NOTE[root as usize % 12], q)
}

fn show(spans: &[ChordSpan]) -> String {
    spans.iter().map(|s| format!("{:.2}-{:.2} {} ({:.2})", s.start_sec, s.end_sec, label(s.root, s.quality.as_str()), s.confidence)).collect::<Vec<_>>().join(" | ")
}

type Truth<'a> = Vec<(f32, f32, u8, &'a [&'a str])>;

fn accuracy(spans: &[ChordSpan], truth: &Truth, from: f32, to: f32) -> (f32, f32, f32) {
    let (mut n, mut root, mut fam, mut exact) = (0usize, 0usize, 0usize, 0usize);
    let mut t = from;
    while t < to {
        if let Some(g) = truth.iter().find(|g| t >= g.0 && t < g.1) {
            n += 1;
            if let Some(s) = spans.iter().find(|s| t >= s.start_sec && t < s.end_sec) {
                if s.root == g.2 {
                    root += 1;
                    let q = s.quality.as_str();
                    if g.3.contains(&q) {
                        fam += 1;
                    }
                    if g.3[0] == q {
                        exact += 1;
                    }
                }
            }
        }
        t += 0.01;
    }
    let n = n.max(1) as f32;
    (root as f32 / n, fam as f32 / n, exact as f32 / n)
}

fn looped<'a>(bar: &[(u8, &'a [&'a str])], secs: f32, loops: usize) -> Truth<'a> {
    let mut out = Vec::new();
    let mut t = 0.0;
    for _ in 0..loops {
        for &(r, q) in bar {
            out.push((t, t + secs, r, q));
            t += secs;
        }
    }
    out
}

const BAR140: f32 = 60.0 / 140.0 * 4.0;
const FM9: &[f32] = &[53.0, 56.0, 60.0, 63.0, 67.0];
const DBMAJ7: &[f32] = &[49.0, 53.0, 56.0, 60.0, 65.0];
const EBMAJ9: &[f32] = &[51.0, 55.0, 58.0, 62.0, 65.0];
const CM7: &[f32] = &[48.0, 51.0, 55.0, 58.0, 63.0];

const M7: &[&str] = &["m7", "min"];
const MAJ7: &[&str] = &["maj7", "maj"];

#[test]
fn neon_fog_loop_saw_pad_with_drums() {
    let loops = 4;
    let bar: [(&[f32], f32); 4] = [(FM9, BAR140), (DBMAJ7, BAR140), (EBMAJ9, BAR140), (CM7, BAR140)];
    let chords: Vec<(&[f32], f32)> = (0..loops).flat_map(|_| bar.iter().copied()).collect();
    let truth = looped(&[(5, M7), (1, MAJ7), (3, MAJ7), (0, M7)], BAR140, loops);
    let end = BAR140 * 4.0 * loops as f32;
    for (detune, drums) in [(0.0f32, false), (20.0, true), (-20.0, true)] {
        let mut x = saw_pad(&chords, 12.0, detune, 2400.0, 0.12);
        if drums {
            let mut d = groove(140.0, 4 * loops, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.0);
            d.truncate(x.len());
            mix(&mut x, &d, 1.0);
        }
        let a = run(x, false);
        let (root, fam, exact) = accuracy(&a.chords, &truth, 0.0, end);
        eprintln!("saw pad loop (detune {detune:+}, drums {drums}): root {root:.2} family {fam:.2} exact {exact:.2} beats {} — {}", a.beats.as_ref().map(|b| b.times.len()).unwrap_or(0), show(&a.chords));
        assert!(root >= 0.85, "root accuracy {root:.2}");
        assert!(fam >= 0.8, "quality accuracy {fam:.2}");
        assert!(a.estimated.iter().any(|e| e == "chords"));
        assert!(a.chords.len() <= 4 * loops + 4, "{} spans", a.chords.len());
    }
}

#[test]
fn pop_triads_with_square_bass_and_drums() {
    let bar = 2.0;
    let loops = 3;
    let voicings: [(&[f32], f32); 4] = [(&[60.0, 64.0, 67.0], bar), (&[57.0, 60.0, 64.0], bar), (&[53.0, 57.0, 60.0], bar), (&[55.0, 59.0, 62.0], bar)];
    let chords: Vec<(&[f32], f32)> = (0..loops).flat_map(|_| voicings.iter().copied()).collect();
    let bass: Vec<(f32, f32)> = (0..loops).flat_map(|_| [(36.0, bar), (33.0, bar), (29.0, bar), (31.0, bar)]).collect();
    let mut x = saw_pad(&chords, 15.0, 20.0, 3000.0, 0.12);
    mix(&mut x, &square_bass(&bass, 20.0, 0.4), 1.0);
    let mut d = groove(120.0, 4 * loops, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.0);
    d.truncate(x.len());
    mix(&mut x, &d, 1.0);
    let a = run(x, false);
    let truth = looped(&[(0, &["maj"]), (9, &["min"]), (5, &["maj"]), (7, &["maj"])], bar, loops);
    let (root, fam, exact) = accuracy(&a.chords, &truth, 0.0, bar * 4.0 * loops as f32);
    eprintln!("C–Am–F–G: root {root:.2} exact {exact:.2} — {}", show(&a.chords));
    assert!(root >= 0.85 && fam >= 0.85, "root {root:.2} quality {fam:.2}");
}

#[test]
fn seventh_chords_without_a_beat() {
    let bar: [(&[f32], f32); 4] = [(&[50.0, 53.0, 57.0, 60.0], 2.0), (&[43.0, 53.0, 59.0, 62.0], 2.0), (&[48.0, 55.0, 59.0, 64.0], 2.0), (&[45.0, 55.0, 61.0, 64.0], 2.0)];
    let chords: Vec<(&[f32], f32)> = (0..3).flat_map(|_| bar.iter().copied()).collect();
    let x = saw_pad(&chords, 10.0, 0.0, 3000.0, 0.12);
    let a = run(x, false);
    let truth = looped(&[(2, &["m7"]), (7, &["7"]), (0, &["maj7"]), (9, &["7"])], 2.0, 3);
    let (root, fam, _) = accuracy(&a.chords, &truth, 0.0, 24.0);
    eprintln!("Dm7–G7–Cmaj7–A7: tempo {:?} root {root:.2} quality {fam:.2} — {}", a.tempo.as_ref().map(|t| t.bpm), show(&a.chords));
    assert!(a.tempo.is_none(), "sustained pads have no pulse");
    assert!(root >= 0.85 && fam >= 0.8, "root {root:.2} quality {fam:.2}");
}

#[test]
fn half_bar_harmonic_rhythm() {
    let half = 60.0 / 100.0 * 2.0;
    let voicings: [(&[f32], f32); 4] = [(&[48.0, 60.0, 64.0, 67.0], half), (&[43.0, 59.0, 62.0, 67.0], half), (&[45.0, 60.0, 64.0, 69.0], half), (&[41.0, 60.0, 65.0, 69.0], half)];
    let chords: Vec<(&[f32], f32)> = (0..4).flat_map(|_| voicings.iter().copied()).collect();
    let mut x = saw_pad(&chords, 12.0, 0.0, 3000.0, 0.12);
    let mut d = groove(100.0, 8, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.0);
    d.truncate(x.len());
    mix(&mut x, &d, 1.0);
    let a = run(x, false);
    let truth = looped(&[(0, &["maj"]), (7, &["maj"]), (9, &["min"]), (5, &["maj"])], half, 4);
    let (root, fam, _) = accuracy(&a.chords, &truth, 0.0, half * 16.0);
    eprintln!("C–G–Am–F half bars: root {root:.2} quality {fam:.2} — {}", show(&a.chords));
    assert!(root >= 0.8 && fam >= 0.8, "root {root:.2} quality {fam:.2}");
    for s in a.chords.iter().skip(1) {
        let k = (s.start_sec / half).round();
        assert!((s.start_sec - k * half).abs() <= 0.61, "span starts at {} (half bars every {half} s)", s.start_sec);
    }
}

#[test]
fn drums_noise_and_bass_alone_have_no_chords() {
    let a = run(groove(120.0, 8, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.0), false);
    assert!(a.chords.is_empty(), "drums: {}", show(&a.chords));
    assert!(!a.estimated.iter().any(|e| e == "chords"));
    let a = run(hats_and_claps(140.0, 20.0, 1.0), false);
    assert!(a.chords.is_empty(), "hats + claps: {}", show(&a.chords));
    let mut rng = Rng::new(9);
    let a = run((0..(15.0 * SR) as usize).map(|_| 0.2 * rng.next()).collect(), false);
    assert!(a.chords.is_empty(), "noise: {}", show(&a.chords));
    let q = 60.0 / 140.0;
    let riff = [29.0, 32.0, 36.0, 29.0, 25.0, 29.0, 32.0, 25.0];
    let notes: Vec<(f32, f32)> = (0..6).flat_map(|_| riff.iter().map(|&m| (m, q))).collect();
    let a = run(square_bass(&notes, 0.0, 0.6), false);
    assert!(a.chords.is_empty(), "bass alone: {}", show(&a.chords));
    let a = run(silence(5.0), false);
    assert!(a.chords.is_empty());
}

#[test]
fn drums_option_matches_transcribe_from_the_same_decode() {
    use krypt_studio_analyzer::protocol::{TranscribeArgs, TranscribeMode};
    let mut x = groove(120.0, 8, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.3);
    let pad: Vec<f32> = saw_pad(&[(&[57.0, 60.0, 64.0], 8.0), (&[53.0, 57.0, 60.0], 8.0)], 12.0, 0.0, 2400.0, 0.06);
    mix(&mut x, &pad, 1.0);
    let without = run(x.clone(), false);
    assert!(without.drum_hits.is_none());
    let json = serde_json::to_value(&without).unwrap();
    assert!(json.get("drumHits").is_none(), "drumHits must be omitted when not requested");
    assert!(json["chords"].is_array());
    let with = run(x.clone(), true);
    let hits = with.drum_hits.as_ref().expect("drumHits");
    assert!(with.estimated.iter().any(|e| e == "drumHits"));
    let args = TranscribeArgs { path: String::new(), mode: TranscribeMode::Drums, model_dir: None, onset_threshold: None, frame_threshold: None, min_note_ms: None, min_key: None, max_key: None };
    let mono = krypt_studio_analyzer::audio::resample(&x, SR, krypt_studio_analyzer::audio::ANALYSIS_SR);
    let tr = krypt_studio_analyzer::transcribe::transcribe_signal(&mono, &args, &JobCtx::detached()).unwrap();
    assert_eq!(hits.len(), tr.hits.len());
    for (a, b) in hits.iter().zip(&tr.hits) {
        assert_eq!((a.time_sec, a.role, a.vel), (b.time_sec, b.role, b.vel));
    }
    let kicks = hits.iter().filter(|h| format!("{:?}", h.role) == "Kick").count();
    assert!((14..=18).contains(&kicks), "{kicks} kicks (16 expected)");
    let json = serde_json::to_value(&with).unwrap();
    assert!(json["drumHits"][0]["timeSec"].is_number() && json["drumHits"][0]["role"].is_string());
    assert_eq!(serde_json::to_value(&without.chords).unwrap(), serde_json::to_value(&with.chords).unwrap());
    assert_eq!(without.tempo.as_ref().map(|t| t.bpm), with.tempo.as_ref().map(|t| t.bpm));
}

#[test]
fn analyze_args_parse_drums() {
    let a: krypt_studio_analyzer::protocol::AnalyzeArgs = serde_json::from_str(r#"{"path":"x.wav"}"#).unwrap();
    assert!(!a.drums && a.sections);
    let a: krypt_studio_analyzer::protocol::AnalyzeArgs = serde_json::from_str(r#"{"path":"x.wav","drums":true,"sections":false}"#).unwrap();
    assert!(a.drums && !a.sections);
}

#[cfg(windows)]
#[test]
fn analyze_m4a_with_chords_and_drums() {
    use krypt_studio_analyzer::protocol::AnalyzeArgs;
    use krypt_studio_dsp::decode::{mf_encode, MfCodec};
    let bar = 2.0;
    let voicings: [(&[f32], f32); 4] = [(&[60.0, 64.0, 67.0], bar), (&[57.0, 60.0, 64.0], bar), (&[53.0, 57.0, 60.0], bar), (&[55.0, 59.0, 62.0], bar)];
    let chords: Vec<(&[f32], f32)> = (0..2).flat_map(|_| voicings.iter().copied()).collect();
    let mut x = saw_pad(&chords, 15.0, 0.0, 3000.0, 0.12);
    let mut d = groove(120.0, 8, KICK_44, SNARE_BACK, HAT_8, 0.0, 0.0);
    d.truncate(x.len());
    mix(&mut x, &d, 0.7);
    let peak = x.iter().fold(0f32, |m, v| m.max(v.abs()));
    for v in x.iter_mut() {
        *v *= 0.9 / peak;
    }
    let dir = temp_dir("m4a");
    let p = dir.join("song.m4a");
    if let Err(e) = mf_encode(&p, &[x.clone(), x], 44_100, MfCodec::Aac) {
        eprintln!("SKIPPED: no AAC encoder on this Windows ({e})");
        return;
    }
    let args = AnalyzeArgs { path: p.to_string_lossy().into(), sections: false, beat_model_dir: None, drums: true };
    let a = krypt_studio_analyzer::analyze::run(&args, &JobCtx::detached()).unwrap();
    let truth = looped(&[(0, &["maj"]), (9, &["min"]), (5, &["maj"]), (7, &["maj"])], bar, 2);
    let (root, fam, _) = accuracy(&a.chords, &truth, 0.0, 16.0);
    eprintln!("m4a: {} Hz {} ch {:.2} s, tempo {:?}, key {:?}, root {root:.2} quality {fam:.2}, {} drum hits — {}", a.sample_rate, a.channels, a.duration_sec, a.tempo.as_ref().map(|t| t.bpm), a.key.as_ref().map(|k| k.name.clone()), a.drum_hits.as_ref().map(|h| h.len()).unwrap_or(0), show(&a.chords));
    assert_eq!((a.sample_rate, a.channels), (44_100, 2));
    assert!((a.duration_sec - 16.0).abs() < 0.1);
    assert!(root >= 0.85 && fam >= 0.85, "root {root:.2} quality {fam:.2}");
    let hits = a.drum_hits.as_ref().expect("drumHits");
    let count = |r: &str| hits.iter().filter(|h| format!("{:?}", h.role) == r).count();
    eprintln!("roles: kick {} snare {} hat {} openhat {} perc {}", count("Kick"), count("Snare"), count("Hat"), count("Openhat"), count("Perc"));
    assert!((14..=22).contains(&count("Kick")) && hits.len() >= 32, "{} kicks, {} hits", count("Kick"), hits.len());
    let _ = std::fs::remove_dir_all(&dir);
}
