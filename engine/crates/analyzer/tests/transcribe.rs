//! `transcribe` on synthetic signals: mono (pYIN), poly (Basic Pitch), drums.

mod common;

use common::*;
use std::f32::consts::PI;
use krypt_studio_analyzer::audio;
use krypt_studio_analyzer::protocol::{DrumRole, TranscribeArgs, TranscribeMode, TranscribedNote};
use krypt_studio_analyzer::transcribe::transcribe_signal;
use krypt_studio_analyzer::{JobCtx, JobError};

fn args(mode: TranscribeMode) -> TranscribeArgs {
    TranscribeArgs {
        path: String::new(),
        mode,
        model_dir: if mode == TranscribeMode::Poly { Some(model_dir("basic-pitch").to_string_lossy().into()) } else { None },
        onset_threshold: None,
        frame_threshold: None,
        min_note_ms: None,
        min_key: None,
        max_key: None,
    }
}

fn at22(x: &[f32]) -> Vec<f32> {
    audio::resample(x, SR, 22_050)
}

fn show(n: &[TranscribedNote]) -> String {
    n.iter().map(|n| format!("[{:.3}+{:.3} k{} v{:.2} c{:?}]", n.start_sec, n.dur_sec, n.key, n.vel, n.cents)).collect::<Vec<_>>().join(" ")
}

/// Melody: (midi, start, dur) with sines + 2 harmonics.
fn melody(notes: &[(f32, f32, f32)], total: f32) -> Vec<f32> {
    let mut x = silence(total);
    for &(m, t, d) in notes {
        add(&mut x, t, &tone(midi_hz(m), d, &[0.4, 0.2]), 0.4);
    }
    x
}

#[test]
fn mono_melody_with_gaps() {
    let notes = [(60.0, 0.5, 0.4), (62.0, 1.0, 0.4), (64.0, 1.5, 0.4), (67.0, 2.0, 0.8), (65.0, 3.0, 0.3), (57.0, 3.5, 0.6)];
    let x = melody(&notes, 4.5);
    let r = transcribe_signal(&at22(&x), &args(TranscribeMode::Mono), &JobCtx::detached()).unwrap();
    eprintln!("mono gaps: {}", show(&r.notes));
    assert_eq!(r.source, "pyin");
    assert_eq!(r.notes.len(), notes.len(), "{}", show(&r.notes));
    for (got, &(m, t, d)) in r.notes.iter().zip(&notes) {
        assert_eq!(got.key, m as u8);
        assert!((got.start_sec - t).abs() < 0.015, "start {} vs {t}", got.start_sec);
        assert!((got.dur_sec - d).abs() < 0.03, "dur {} vs {d}", got.dur_sec);
        assert!(got.cents.unwrap().abs() < 10.0, "cents {:?}", got.cents);
    }
}

#[test]
fn mono_legato_and_detuned() {
    // Legato line (no gaps), 20 cents sharp, low register (bass/808 range).
    let det = 0.2;
    let seq = [(40.0, 0.0, 0.5), (43.0, 0.5, 0.5), (45.0, 1.0, 0.5), (47.0, 1.5, 0.5), (40.0, 2.0, 1.0)];
    let mut x = silence(3.3);
    let mut ph = 0.0f32;
    for (i, out) in x.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let m = seq.iter().rev().find(|s| t >= s.1).map(|s| s.0).unwrap_or(40.0) + det;
        ph += 2.0 * std::f32::consts::PI * midi_hz(m) / SR;
        let env = (t / 0.01).min(1.0) * ((3.0 - t) / 0.01).clamp(0.0, 1.0);
        *out = 0.4 * env * (ph.sin() + 0.5 * (2.0 * ph).sin());
    }
    let r = transcribe_signal(&at22(&x), &args(TranscribeMode::Mono), &JobCtx::detached()).unwrap();
    eprintln!("mono legato: {}", show(&r.notes));
    let keys: Vec<u8> = r.notes.iter().map(|n| n.key).collect();
    assert_eq!(keys, vec![40, 43, 45, 47, 40], "{}", show(&r.notes));
    for (n, s) in r.notes.iter().zip(&seq) {
        assert!((n.start_sec - s.1).abs() < 0.05, "start {} vs {}", n.start_sec, s.1);
        let c = n.cents.unwrap();
        assert!((c - 20.0).abs() < 8.0, "cents {c}");
    }
}

#[test]
fn mono_repeated_notes_and_key_range() {
    // Same pitch re-attacked (staccato-ish with tiny dips) + an out-of-range note.
    let mut x = silence(3.0);
    for k in 0..4 {
        add(&mut x, 0.3 + k as f32 * 0.5, &tone(midi_hz(69.0), 0.45, &[0.3]), 0.4);
    }
    add(&mut x, 2.4, &tone(midi_hz(84.0), 0.4, &[0.3]), 0.4);
    let mut a = args(TranscribeMode::Mono);
    a.max_key = Some(80);
    let r = transcribe_signal(&at22(&x), &a, &JobCtx::detached()).unwrap();
    eprintln!("mono repeats: {}", show(&r.notes));
    let a4: Vec<&TranscribedNote> = r.notes.iter().filter(|n| n.key == 69).collect();
    assert_eq!(a4.len(), 4, "{}", show(&r.notes));
    for (k, n) in a4.iter().enumerate() {
        let t = 0.3 + k as f32 * 0.5;
        assert!((n.start_sec - t).abs() < 0.015 && (n.dur_sec - 0.45).abs() < 0.03, "repeat {k}: {}", show(&r.notes));
    }
    assert!(r.notes.iter().all(|n| n.key <= 80));
}

#[test]
fn poly_basic_pitch_chords() {
    let dir = model_dir("basic-pitch");
    assert!(dir.join("nmp.onnx").is_file(), "bundled Basic Pitch missing at {}", dir.display());
    // C major triad, then F major (C4 F4 A4), then a G3 bass + B4 D5 dyad; piano-ish decaying tones.
    let chords: [(&[f32], f32, f32); 3] = [(&[60.0, 64.0, 67.0], 0.5, 1.0), (&[60.0, 65.0, 69.0], 1.75, 1.0), (&[55.0, 71.0, 74.0], 3.0, 1.0)];
    let mut x = silence(4.5);
    for (notes, t, d) in chords {
        for &m in notes {
            let n = (d * SR) as usize;
            let s: Vec<f32> = (0..n)
                .map(|i| {
                    let tt = i as f32 / SR;
                    let f = midi_hz(m);
                    let env = (tt / 0.005).min(1.0) * (-tt * 1.5).exp() * ((d - tt) / 0.02).clamp(0.0, 1.0);
                    env * ((2.0 * std::f32::consts::PI * f * tt).sin() + 0.5 * (4.0 * std::f32::consts::PI * f * tt).sin() + 0.25 * (6.0 * std::f32::consts::PI * f * tt).sin())
                })
                .collect();
            add(&mut x, t, &s, 0.25);
        }
    }
    let r = transcribe_signal(&at22(&x), &args(TranscribeMode::Poly), &JobCtx::detached()).unwrap();
    eprintln!("poly: {}", show(&r.notes));
    assert_eq!(r.source, "basic-pitch");
    for (notes, t, _) in chords {
        for &m in notes {
            let hit = r.notes.iter().find(|n| n.key == m as u8 && (n.start_sec - t).abs() < 0.06);
            assert!(hit.is_some(), "missing key {m} at {t}: {}", show(&r.notes));
            let n = hit.unwrap();
            assert!(n.dur_sec > 0.4, "key {m} too short: {}", n.dur_sec);
            if let Some(c) = n.cents {
                assert!(c.abs() < 25.0, "key {m} cents {c}");
            }
        }
    }
    // Spurious notes: upper partials of these strongly harmonic synthetic
    // tones (e.g. D6 = 3rd harmonic of G4). At most 6 beyond the 9 real ones,
    // all quieter than the real notes.
    assert!(r.notes.len() <= 15, "{} notes: {}", r.notes.len(), show(&r.notes));
    let real_min = r.notes.iter().filter(|n| chords.iter().any(|c| c.0.contains(&(n.key as f32)))).map(|n| n.vel).fold(1.0f32, f32::min);
    let ghost_max = r.notes.iter().filter(|n| !chords.iter().any(|c| c.0.contains(&(n.key as f32)))).map(|n| n.vel).fold(0.0f32, f32::max);
    assert!(ghost_max < real_min, "ghost vel {ghost_max} vs real {real_min}");
    // Key range restriction.
    let mut a = args(TranscribeMode::Poly);
    a.min_key = Some(62);
    a.max_key = Some(70);
    let r = transcribe_signal(&at22(&x), &a, &JobCtx::detached()).unwrap();
    assert!(r.notes.iter().all(|n| (62..=70).contains(&n.key)), "{}", show(&r.notes));
    assert!(r.notes.iter().any(|n| n.key == 64));
}

#[test]
fn poly_errors_name_the_model() {
    let x = vec![0.0; 22_050];
    let mut a = args(TranscribeMode::Poly);
    a.model_dir = Some("C:\\nowhere\\basic-pitch".into());
    match transcribe_signal(&x, &a, &JobCtx::detached()) {
        Err(JobError::Failed(m)) => assert!(m.contains("Basic Pitch model not found in") && m.contains("nmp.onnx"), "{m}"),
        _ => panic!("expected failure"),
    }
    a.model_dir = None;
    match transcribe_signal(&x, &a, &JobCtx::detached()) {
        Err(JobError::Failed(m)) => assert!(m.contains("Basic Pitch"), "{m}"),
        _ => panic!("expected failure"),
    }
    let mut a = args(TranscribeMode::Mono);
    a.onset_threshold = Some(1.5);
    assert!(matches!(transcribe_signal(&x, &a, &JobCtx::detached()), Err(JobError::Failed(m)) if m.contains("onsetThreshold")));
    let mut a = args(TranscribeMode::Mono);
    a.min_key = Some(80);
    a.max_key = Some(40);
    assert!(matches!(transcribe_signal(&x, &a, &JobCtx::detached()), Err(JobError::Failed(m)) if m.contains("key range")));
}

#[test]
fn drums_roles() {
    // Bar at 100 BPM: kick, hat, snare, hat, kick+hat, hat, snare, open hat.
    let step = 0.3;
    let mut x = silence(3.2);
    let mut want: Vec<(f32, DrumRole)> = Vec::new();
    let k = kick();
    for (i, ev) in ["k", "h", "s", "h", "kh", "h", "s", "o"].iter().enumerate() {
        let t = 0.2 + i as f32 * step;
        if ev.contains('k') {
            add(&mut x, t, &k, 0.9);
            want.push((t, DrumRole::Kick));
        }
        if ev.contains('s') {
            add(&mut x, t, &snare(i as u64), 0.6);
            want.push((t, DrumRole::Snare));
        }
        if ev.contains('h') {
            add(&mut x, t, &hat(i as u64 + 50, 0.015), 0.35);
            want.push((t, DrumRole::Hat));
        }
        if ev.contains('o') {
            add(&mut x, t, &hat(i as u64 + 80, 0.12), 0.35);
            want.push((t, DrumRole::Openhat));
        }
    }
    let r = transcribe_signal(&at22(&x), &args(TranscribeMode::Drums), &JobCtx::detached()).unwrap();
    let got: Vec<String> = r.hits.iter().map(|h| format!("{:.3}:{:?}:{:.2}", h.time_sec, h.role, h.vel)).collect();
    eprintln!("drums: {}", got.join(" "));
    assert_eq!(r.source, "onsets");
    for (t, role) in &want {
        assert!(r.hits.iter().any(|h| h.role == *role && (h.time_sec - t).abs() < 0.015), "missing {role:?} at {t}: {}", got.join(" "));
    }
    assert!(r.hits.len() <= want.len() + 1, "too many hits: {}", got.join(" "));
    assert!(r.hits.iter().all(|h| h.vel > 0.0 && h.vel <= 1.0));
}

#[test]
fn drums_groove_counts_and_velocity() {
    let x = groove(120.0, 4, "x... .... x... ....", ".... x... .... x...", "x.x. x.x. x.x. x.x.", 0.0, 0.25);
    let r = transcribe_signal(&at22(&x), &args(TranscribeMode::Drums), &JobCtx::detached()).unwrap();
    let count = |role| r.hits.iter().filter(|h| h.role == role).count();
    eprintln!("groove drums: kick {} snare {} hat {} open {} perc {}", count(DrumRole::Kick), count(DrumRole::Snare), count(DrumRole::Hat), count(DrumRole::Openhat), count(DrumRole::Perc));
    assert_eq!(count(DrumRole::Kick), 8);
    assert_eq!(count(DrumRole::Snare), 8);
    // 32 eighth-note hats; the 8 under snares are masked by the snare and come
    // from the hat stream running through them.
    assert!((30..=32).contains(&(count(DrumRole::Hat) + count(DrumRole::Openhat))), "hats {}", count(DrumRole::Hat));
    // Timing: every kick on the grid (0.25 s offset, 1 s apart) within 15 ms.
    for h in r.hits.iter().filter(|h| h.role == DrumRole::Kick) {
        let ph = ((h.time_sec - 0.25) / 1.0).round();
        assert!((h.time_sec - 0.25 - ph).abs() < 0.015, "kick at {}", h.time_sec);
    }
    assert!(count(DrumRole::Perc) <= 1);
}

/// A big-room kick: a click and a pitch sweep from 400 Hz that only reaches the
/// low band (< 150 Hz) after ~30 ms, then a long 50 Hz tail (common in EDM and
/// house). Its attack sits in the body band, so it used to read as a perc hit
/// with the kick proper as a second onset ~30 ms later, often missed.
fn big_room_kick() -> Vec<f32> {
    let n = (0.45 * SR) as usize;
    let mut ph = 0.0f32;
    let mut rng = Rng::new(3);
    (0..n)
        .map(|i| {
            let t = i as f32 / SR;
            let f = 50.0 + 350.0 * (-t * 40.0).exp();
            ph += 2.0 * PI * f / SR;
            let click = if t < 0.002 { 0.6 * rng.next() } else { 0.0 };
            let tail = ((n - i) as f32 / (0.02 * SR)).min(1.0);
            (ph.sin() * (-t * 4.0).exp() + click) * tail
        })
        .collect()
}

#[test]
fn drums_big_room_kick_four_on_the_floor_over_a_sub() {
    let bpm = 128.0;
    let beat = 60.0 / bpm;
    let beats = 32;
    let mut x = silence(0.5 + beats as f32 * beat + 1.0);
    let k = big_room_kick();
    let mut want = Vec::new();
    for b in 0..beats {
        let t = 0.25 + b as f32 * beat;
        add(&mut x, t, &k, 0.8);
        want.push(t);
        if b % 2 == 1 {
            add(&mut x, t, &snare(b as u64 + 3), 0.45);
        }
        add(&mut x, t + beat / 2.0, &hat(b as u64 + 40, 0.03), 0.3);
    }
    // A sustained sub under the drop, tuned to the kick's tail as producers do (a detuned one beats, and the beating
    // reads as low-band onsets of its own; sidechained mixes duck it, and the drum stem has none).
    let sub = tone(50.0, x.len() as f32 / SR, &[]);
    mix(&mut x, &sub, 0.12);
    let r = transcribe_signal(&at22(&x), &args(TranscribeMode::Drums), &JobCtx::detached()).unwrap();
    let kicks: Vec<f32> = r.hits.iter().filter(|h| h.role == DrumRole::Kick).map(|h| h.time_sec).collect();
    let percs = r.hits.iter().filter(|h| h.role == DrumRole::Perc).count();
    let on_beat = want.iter().filter(|&&t| kicks.iter().any(|&k| (k - t).abs() < 0.02)).count();
    eprintln!("big-room kick: {} kicks ({} on the beat of {}), {} perc", kicks.len(), on_beat, want.len(), percs);
    assert!(on_beat >= beats - 2, "kicks on the beat: {on_beat}/{beats}; kicks at {kicks:?}");
    assert!(kicks.len() <= beats + 2, "one kick per hit, not two: {} kicks", kicks.len());
    assert!(kicks.windows(2).all(|w| w[1] - w[0] > 0.04), "no double kicks: {kicks:?}");
    assert!(percs <= 3, "the kick's attack is not a perc hit: {percs} perc");
}

/// Hits of `role` (hats: closed or open) scored against `want` (s) within
/// 30 ms, one hit per want: (matched, hits reported).
fn score(hits: &[krypt_studio_analyzer::protocol::DrumHit], roles: &[DrumRole], want: &[f32]) -> (usize, usize) {
    let got: Vec<f32> = hits.iter().filter(|h| roles.contains(&h.role)).map(|h| h.time_sec).collect();
    let mut used = vec![false; got.len()];
    let mut tp = 0;
    for &w in want {
        if let Some(k) = (0..got.len()).find(|&k| !used[k] && (got[k] - w).abs() < 0.03) {
            used[k] = true;
            tp += 1;
        }
    }
    (tp, got.len())
}

/// Bus-limiter ducking after each of `kicks` (s): −`depth_db`, back in ~80 ms.
fn duck(x: &mut [f32], kicks: &[f32], depth_db: f32) {
    let floor = 10f32.powf(-depth_db / 20.0);
    for (i, v) in x.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let g = kicks.iter().filter(|&&k| t >= k - 0.002).map(|&k| 1.0 - (1.0 - floor) * (-(t - k).max(0.0) / 0.08).exp()).fold(1.0f32, f32::min);
        *v *= g;
    }
}

/// A rim / stick click: a 1.7 kHz ping and a noise tick, gone in ~15 ms.
fn rim(seed: u64) -> Vec<f32> {
    let mut rng = Rng::new(seed);
    (0..(0.04 * SR) as usize)
        .map(|i| {
            let t = i as f32 / SR;
            ((2.0 * PI * 1700.0 * t).sin() * 0.8 + 0.4 * rng.next()) * (-t / 0.004).exp()
        })
        .collect()
}

/// Neon Fog's failure: trap at 140 bpm, 16th hats that ring, a long 808
/// under every kick and the hats ducked by the kick (a bus limiter). The
/// hat a 16th after a kick sat on the 808's swell and became a kick, and
/// the hats under kicks and claps were lost.
#[test]
fn drums_fast_16th_hats_over_kicks_808_and_claps() {
    let bpm = 140.0;
    let step = 60.0 / bpm / 4.0;
    let bars = 4;
    let t0 = 0.3;
    let mut hats = silence(t0 + bars as f32 * 16.0 * step + 1.5);
    let mut x = hats.clone();
    let (mut want_k, mut want_s, mut want_h) = (Vec::new(), Vec::new(), Vec::new());
    let k = kick();
    for s in 0..bars * 16 {
        let t = t0 + s as f32 * step;
        add(&mut hats, t, &hat(s as u64 + 7, 0.03), if s % 2 == 0 { 0.4 } else { 0.28 });
        want_h.push(t);
        if [0, 6, 11].contains(&(s % 16)) {
            add(&mut x, t, &k, 0.9);
            // The 808: a long 49 Hz tone under each kick (overlapping ones beat).
            add(&mut x, t, &bass_note(31.0, 1.2, &[0.5, 0.1], 1.5), 0.5);
            want_k.push(t);
        }
        if s % 8 == 4 {
            add(&mut x, t, &snare(s as u64 + 300), 0.55);
            want_s.push(t);
        }
    }
    duck(&mut hats, &want_k, 8.0);
    mix(&mut x, &hats, 1.0);
    let r = transcribe_signal(&at22(&x), &args(TranscribeMode::Drums), &JobCtx::detached()).unwrap();
    let (tk, nk) = score(&r.hits, &[DrumRole::Kick], &want_k);
    let (ts, ns) = score(&r.hits, &[DrumRole::Snare], &want_s);
    let (th, nh) = score(&r.hits, &[DrumRole::Hat, DrumRole::Openhat], &want_h);
    eprintln!("trap 16ths: kick {tk}/{} of {nk}, snare {ts}/{} of {ns}, hats {th}/{} of {nh}", want_k.len(), want_s.len(), want_h.len());
    assert_eq!((tk, nk), (want_k.len(), want_k.len()), "every kick once, no hat read as a kick");
    assert_eq!((ts, ns), (want_s.len(), want_s.len()), "every clap once");
    assert!(th as f32 >= 0.9 * want_h.len() as f32, "hats found {th}/{}", want_h.len());
    assert!(th as f32 >= 0.95 * nh as f32, "hat precision {th}/{nh}");
}

/// House: kick on every beat, the clap on top of the kicks on 2 and 4,
/// 16th closed hats with an open hat on each offbeat, rim clicks. The clap
/// must not be lost on the kick (nor a snare added to the other kicks), and
/// a rim is a perc, not a snare.
#[test]
fn drums_clap_on_kick_and_rims() {
    let bpm = 124.0;
    let step = 60.0 / bpm / 4.0;
    let bars = 4;
    let t0 = 0.3;
    let mut x = silence(t0 + bars as f32 * 16.0 * step + 1.0);
    let (mut want_k, mut want_s, mut want_h, mut want_r) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let k = kick();
    for s in 0..bars * 16 {
        let t = t0 + s as f32 * step;
        if s % 4 == 0 {
            add(&mut x, t, &k, 0.9);
            want_k.push(t);
        }
        if s % 8 == 4 {
            add(&mut x, t, &snare(s as u64 + 11), 0.5);
            want_s.push(t);
        }
        if s % 4 == 2 {
            add(&mut x, t, &hat(s as u64 + 70, 0.06), 0.3);
        } else {
            add(&mut x, t, &hat(s as u64 + 40, 0.02), if s % 2 == 0 { 0.45 } else { 0.35 });
        }
        want_h.push(t);
        if s % 16 == 7 || s % 16 == 13 {
            add(&mut x, t + step / 2.0, &rim(s as u64), 0.35);
            want_r.push(t + step / 2.0);
        }
    }
    let r = transcribe_signal(&at22(&x), &args(TranscribeMode::Drums), &JobCtx::detached()).unwrap();
    let (tk, nk) = score(&r.hits, &[DrumRole::Kick], &want_k);
    let (ts, ns) = score(&r.hits, &[DrumRole::Snare], &want_s);
    let (th, nh) = score(&r.hits, &[DrumRole::Hat, DrumRole::Openhat], &want_h);
    let (tr, _) = score(&r.hits, &[DrumRole::Perc], &want_r);
    eprintln!("house: kick {tk}/{} of {nk}, clap {ts}/{} of {ns}, hats {th}/{} of {nh}, rims as perc {tr}/{}", want_k.len(), want_s.len(), want_h.len(), want_r.len());
    assert_eq!((tk, nk), (want_k.len(), want_k.len()));
    assert_eq!((ts, ns), (want_s.len(), want_s.len()), "claps on kicks, and no snare on the other kicks or the rims");
    assert!(tr + 1 >= want_r.len(), "rims are perc: {tr}/{}", want_r.len());
    assert!(th as f32 >= 0.9 * want_h.len() as f32 && th as f32 >= 0.95 * nh as f32, "hats {th}/{} of {nh}", want_h.len());
}

/// Hats only on the offbeats, a kick on every beat: the hat stream is a
/// quarter-note stream between the kicks, not 8ths under them.
#[test]
fn drums_offbeat_hats_stay_offbeat() {
    let beat = 60.0 / 124.0;
    let t0 = 0.3;
    let mut x = silence(t0 + 16.0 * beat + 1.0);
    let mut want_h = Vec::new();
    let k = kick();
    for b in 0..16 {
        let t = t0 + b as f32 * beat;
        add(&mut x, t, &k, 0.9);
        if b % 2 == 1 {
            add(&mut x, t, &snare(b as u64), 0.5);
        }
        add(&mut x, t + beat / 2.0, &hat(b as u64 + 20, 0.02), 0.3);
        want_h.push(t + beat / 2.0);
    }
    let r = transcribe_signal(&at22(&x), &args(TranscribeMode::Drums), &JobCtx::detached()).unwrap();
    let (th, nh) = score(&r.hits, &[DrumRole::Hat, DrumRole::Openhat], &want_h);
    eprintln!("offbeat hats: {th}/{} of {nh}", want_h.len());
    assert_eq!((th, nh), (want_h.len(), want_h.len()));
}

/// Transcription speed (run with --ignored, release).
#[test]
#[ignore]
fn perf_transcription() {
    let mut mel = Vec::new();
    for i in 0..360 {
        mel.push(((48 + (i * 7) % 24) as f32, i as f32 * 0.5, 0.45));
    }
    let x = at22(&melody(&mel, 180.0));
    for mode in [TranscribeMode::Poly, TranscribeMode::Mono, TranscribeMode::Drums] {
        let t = std::time::Instant::now();
        let r = transcribe_signal(&x, &args(mode), &JobCtx::detached()).unwrap();
        let s = t.elapsed().as_secs_f32();
        eprintln!("PERF transcribe {mode:?} 180 s audio: {s:.2} s ({:.0}x real time), {} notes {} hits", 180.0 / s, r.notes.len(), r.hits.len());
    }
}

/// Degenerate inputs never panic: tiny, silent and noise-only signals in
/// every mode (and through `analyze`).
#[test]
fn degenerate_inputs_are_handled() {
    use krypt_studio_analyzer::analyze::{analyze_channels, Options};
    let mut rng = Rng::new(9);
    let signals: Vec<(&str, Vec<f32>)> = vec![
        ("one sample", vec![0.5]),
        ("100 samples", (0..100).map(|i| (i as f32 * 0.1).sin()).collect()),
        ("0.3 s sine", tone(440.0, 0.3, &[])),
        ("5 s silence", silence(5.0)),
        ("3 s noise", (0..(3.0 * SR) as usize).map(|_| 0.3 * rng.next()).collect()),
        ("clipped square", (0..(2.0 * SR) as usize).map(|i| if (i / 100) % 2 == 0 { 1.0 } else { -1.0 }).collect()),
    ];
    for (name, x) in &signals {
        let a = analyze_channels(name, std::slice::from_ref(x), SR, &Options { sections: true, beat_model_dir: Some(model_dir("beat-this-small")), ..Default::default() }, &JobCtx::detached());
        let a = a.unwrap_or_else(|e| panic!("analyze {name}: {e:?}"));
        assert!(a.energy.lufs.iter().all(|v| v.is_finite()), "{name}");
        serde_json::to_string(&a).unwrap();
        let y = at22(x);
        for mode in [TranscribeMode::Poly, TranscribeMode::Mono, TranscribeMode::Drums] {
            let r = transcribe_signal(&y, &args(mode), &JobCtx::detached()).unwrap_or_else(|e| panic!("{mode:?} {name}: {e:?}"));
            assert!(r.notes.iter().all(|n| n.dur_sec > 0.0 && n.start_sec >= 0.0 && n.vel > 0.0 && n.vel <= 1.0), "{mode:?} {name}");
        }
    }
    // Silence: nothing to report.
    let a = analyze_channels("s", &[silence(5.0)], SR, &Options { sections: true, beat_model_dir: None, ..Default::default() }, &JobCtx::detached()).unwrap();
    assert!(a.tempo.is_none() && a.key.is_none() && a.swing.is_none() && a.beats.is_none());
    assert_eq!(a.onset_rate, 0.0);
}

/// A bass note: harmonics `amps` (index 0 = fundamental), exponential decay,
/// 4 ms attack, 10 ms release.
fn bass_note(m: f32, secs: f32, amps: &[f32], decay: f32) -> Vec<f32> {
    let f = midi_hz(m);
    (0..(secs * SR) as usize)
        .map(|i| {
            let t = i as f32 / SR;
            let v: f32 = amps.iter().enumerate().map(|(h, &a)| a * (2.0 * PI * f * (h as f32 + 1.0) * t).sin()).sum();
            v * (-t * decay).exp() * (t / 0.004).min(1.0) * ((secs - t) / 0.01).clamp(0.0, 1.0)
        })
        .collect()
}

#[test]
fn mono_sub_bass_weak_fundamental_and_a0() {
    // E1 G1 A1 C2 D1 E2 C1 B1 A0 A#0 B0: 808 sine, a weak fundamental, no
    // fundamental at all. The short envelope ripples once per period on such
    // notes; they must come out whole (not chopped into re-attacks).
    let ns = [28.0, 31.0, 33.0, 36.0, 26.0, 40.0, 24.0, 35.0, 21.0, 22.0, 23.0];
    let mut a = args(TranscribeMode::Mono);
    a.max_key = Some(60);
    for (label, amps, decay) in [("808", &[0.6f32][..], 2.0f32), ("weak f0", &[0.15, 0.5, 0.35, 0.2][..], 1.0), ("no f0", &[0.0, 0.5, 0.35, 0.2][..], 1.0)] {
        let mut x = silence(0.3);
        for &m in &ns {
            x.extend(bass_note(m, 0.5, amps, decay));
            x.extend(silence(0.1));
        }
        let r = transcribe_signal(&at22(&x), &a, &JobCtx::detached()).unwrap();
        eprintln!("{label}: {}", show(&r.notes));
        assert_eq!(r.notes.len(), ns.len(), "{label}: {}", show(&r.notes));
        for (i, (got, &m)) in r.notes.iter().zip(&ns).enumerate() {
            let t = 0.3 + 0.6 * i as f32;
            assert_eq!(got.key, m as u8, "{label} note {i}");
            assert!((got.start_sec - t).abs() < 0.02, "{label} note {i}: start {} vs {t}", got.start_sec);
            assert!((got.dur_sec - 0.5).abs() < 0.04, "{label} note {i}: dur {}", got.dur_sec);
        }
    }
    // Back-to-back repeated sub notes (no gap) still split at each attack.
    let mut x = silence(0.2);
    for _ in 0..4 {
        x.extend(bass_note(28.0, 0.4, &[0.3, 0.5, 0.3], 6.0));
    }
    x.extend(silence(0.2));
    let r = transcribe_signal(&at22(&x), &a, &JobCtx::detached()).unwrap();
    eprintln!("repeated E1: {}", show(&r.notes));
    assert_eq!(r.notes.len(), 4, "{}", show(&r.notes));
    for (i, n) in r.notes.iter().enumerate() {
        assert_eq!(n.key, 28);
        assert!((n.start_sec - (0.2 + 0.4 * i as f32)).abs() < 0.03, "start {}", n.start_sec);
    }
}

#[test]
fn mono_fast_legato_bass_with_octave_jumps() {
    // A trap bass line like a real HT-Demucs bass stem: 808-ish (sine + 2nd harmonic), legato (no gaps, one
    // continuous phase), 0.13-0.25 s notes jumping octaves. pYIN alone left a hole at every change (~58% of the
    // sounding time covered); the low-line reader must cover it with the right keys at the right times.
    let seq: [(f32, f32); 16] = [
        (36.0, 0.18), (48.0, 0.25), (36.0, 0.20), (48.0, 0.25), (36.0, 0.17), (39.0, 0.15), (51.0, 0.23), (63.0, 0.14),
        (39.0, 0.20), (51.0, 0.16), (39.0, 0.19), (51.0, 0.18), (36.0, 0.15), (48.0, 0.24), (60.0, 0.13), (36.0, 0.30),
    ];
    let total: f32 = seq.iter().map(|s| s.1).sum::<f32>() + 0.6;
    let mut x = silence(total);
    let mut ph = 0.0f32;
    let t0 = 0.3;
    let mut starts = Vec::new();
    let mut t = t0;
    for s in &seq {
        starts.push(t);
        t += s.1;
    }
    let end = t;
    for (i, out) in x.iter_mut().enumerate() {
        let tt = i as f32 / SR;
        if tt < t0 || tt >= end {
            continue;
        }
        let k = starts.iter().rposition(|&s| tt >= s).unwrap();
        let since = tt - starts[k];
        ph += 2.0 * PI * midi_hz(seq[k].0) / SR;
        // each note re-attacks a little (decay inside the note), the line never stops
        let env = (0.75 + 0.25 * (-since * 8.0).exp()) * ((tt - t0) / 0.004).min(1.0) * ((end - tt) / 0.01).clamp(0.0, 1.0);
        *out = 0.45 * env * (ph.sin() + 0.45 * (2.0 * ph).sin());
    }
    let r = transcribe_signal(&at22(&x), &args(TranscribeMode::Mono), &JobCtx::detached()).unwrap();
    eprintln!("fast legato bass: {}", show(&r.notes));
    let keys: Vec<u8> = r.notes.iter().map(|n| n.key).collect();
    assert_eq!(keys, seq.iter().map(|s| s.0 as u8).collect::<Vec<_>>(), "{}", show(&r.notes));
    let mut covered = 0.0;
    for (n, (&s, q)) in r.notes.iter().zip(starts.iter().zip(&seq)) {
        assert!((n.start_sec - s).abs() < 0.035, "key {} start {} vs {s}", q.0, n.start_sec);
        covered += n.dur_sec;
    }
    let sounding = end - t0;
    assert!(covered / sounding > 0.93, "covered {covered:.2} of {sounding:.2} s: {}", show(&r.notes));
}
