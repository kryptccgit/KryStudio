//! Analysis on musical material (tempo, speed) and the factory kit.

mod common;
use common::*;

use krypt_studio_dsp::analysis::analyze;
use krypt_studio_dsp::factory::generate_kit;
use krypt_studio_dsp::wav::decode_wav;
use krypt_studio_dsp::{create_instrument, NoteExtras, ProcessContext};

/// Render a 4-on-the-floor + offbeat hat + backbeat clap loop with DrumSynth.
fn drum_loop(bpm: f64, secs: f32) -> (Vec<f32>, Vec<f32>) {
    let n = (secs * SR) as usize;
    let voices: Vec<(f32, Vec<f64>)> = vec![
        (0.0, (0..64).map(|b| b as f64).collect()),          // kick on every beat
        (3.0, (0..64).map(|b| b as f64 + 0.5).collect()),    // closed hat offbeats
        (2.0, (0..32).map(|b| b as f64 * 2.0 + 1.0).collect()), // clap on 2 and 4
    ];
    let (mut l, mut r) = (vec![0.0f32; n], vec![0.0f32; n]);
    let spb = 60.0 / bpm * SR as f64;
    for (voice, beats) in voices {
        let mut inst = create_instrument("krypt.drumsynth", SR, BLOCK).unwrap();
        inst.set_param(param("krypt.drumsynth", "voice"), voice);
        let mut at = 0usize;
        let mut events: Vec<usize> = beats.iter().map(|b| (b * spb) as usize).filter(|&s| s < n).collect();
        events.sort();
        let mut ei = 0;
        while at < n {
            let m = (n - at).min(BLOCK);
            while ei < events.len() && events[ei] < at + m {
                inst.note_on(events[ei] - at, 60, 60.0, 0.9, NoteExtras::default());
                ei += 1;
            }
            let ctx = ProcessContext { sample_rate: SR, bpm, beats_per_bar: 4.0, playing: true, beat_pos: at as f64 / spb, frames: m };
            inst.process(&ctx, [&mut l[at..at + m], &mut r[at..at + m]]);
            at += m;
        }
    }
    (l, r)
}

#[test]
fn bpm_estimate_on_drum_loops() {
    // exact inside the reported octave (85–170), folded by an octave outside it
    for i in 0..=24 {
        let bpm = 65.0 + 5.0 * i as f64;
        let (l, r) = drum_loop(bpm, 16.0);
        let a = analyze(&l, &r, SR);
        let est = a.estimated_bpm.unwrap_or(0.0) as f64;
        let expect = if bpm < 85.0 { bpm * 2.0 } else if bpm > 170.0 { bpm / 2.0 } else { bpm };
        assert!((est - expect).abs() <= 0.5, "{bpm} BPM estimated as {:?} (expected {expect})", a.estimated_bpm);
    }
}

#[test]
fn noise_has_no_tempo() {
    let l = noise(48000 * 10, 5, 0.3);
    let r = noise(48000 * 10, 6, 0.3);
    let a = analyze(&l, &r, SR);
    assert!(a.estimated_bpm.is_none(), "{:?}", a.estimated_bpm);
    assert!(a.stereo_correlation.abs() < 0.05);
    assert!((a.stereo_width - 0.5).abs() < 0.05);
}

#[test]
fn analyze_three_minutes_is_fast() {
    let (l1, r1) = drum_loop(128.0, 20.0);
    let reps = 9; // 180 s
    let mut l = Vec::with_capacity(l1.len() * reps);
    let mut r = Vec::with_capacity(r1.len() * reps);
    let pad = noise(l1.len(), 9, 0.05);
    for _ in 0..reps {
        l.extend(l1.iter().zip(&pad).map(|(a, b)| a + b));
        r.extend(r1.iter().zip(&pad).map(|(a, b)| a - b));
    }
    let t0 = std::time::Instant::now();
    let a = analyze(&l, &r, SR);
    let dt = t0.elapsed();
    println!("analyze(180 s) took {dt:?}: {:?} BPM, {} LUFS", a.estimated_bpm, a.lufs_integrated);
    assert_eq!(a.energy_curve.len(), 180);
    assert!((a.duration_sec - 180.0).abs() < 0.01);
    if !cfg!(debug_assertions) {
        assert!(dt.as_secs_f32() < 1.0, "too slow: {dt:?}");
    }
}

#[test]
fn factory_kit_is_written_normalized_and_sane() {
    let dir = std::env::temp_dir().join(format!("krypt-kit-test-{}", std::process::id()));
    let paths = generate_kit(&dir).unwrap();
    let names: Vec<String> = paths.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
    for want in ["kick", "kick-2", "snare", "clap", "hat-closed", "hat-open", "rim", "perc", "tom", "crash", "808"] {
        assert!(names.contains(&format!("{want}.wav")), "missing {want}.wav");
    }
    for p in &paths {
        let bytes = std::fs::read(p).unwrap();
        // 24-bit PCM at 48 kHz
        assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 24);
        let (sr, ch) = decode_wav(&bytes).unwrap();
        assert_eq!(sr, 48000);
        let r = ch.get(1).unwrap_or(&ch[0]);
        let a = analyze(&ch[0], r, 48000.0);
        let name = p.file_name().unwrap().to_string_lossy();
        assert!(a.true_peak_db <= -0.95 && a.true_peak_db >= -1.05, "{name} true peak {}", a.true_peak_db);
        assert!(!a.clipping, "{name} clips");
        assert!(a.duration_sec > 0.03 && a.duration_sec < 3.0, "{name} length {}", a.duration_sec);
        // starts within a few ms and ends in silence
        let start = ch[0].iter().position(|v| v.abs() > 0.01).unwrap();
        assert!(start < 48 * 30, "{name} starts late");
        let tail = ch.iter().map(|c| peak(&c[c.len() - 16..])).fold(0.0f32, f32::max);
        assert!(tail < 0.003, "{name} ends abruptly ({tail})");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
