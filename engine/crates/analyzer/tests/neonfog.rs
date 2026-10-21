use std::path::PathBuf;

use krypt_studio_analyzer::analyze::{analyze_channels, Options};
use krypt_studio_analyzer::{audio, key, JobCtx};

fn dir() -> Option<PathBuf> {
    std::env::var_os("KRYPT_TEST_NEONFOG").map(PathBuf::from)
}

fn model_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../resources/models/beat-this-small")
}

fn key_of(path: &std::path::Path) -> (Option<String>, String) {
    let data = audio::load(&path.to_string_lossy()).unwrap();
    let x = audio::analysis_mono(&data);
    let ch = key::chroma(&x, audio::ANALYSIS_SR as f32, &JobCtx::detached()).unwrap();
    let mut total = [0f32; 12];
    for f in &ch.frames {
        for k in 0..12 {
            total[k] += f[k];
        }
    }
    let max = total.iter().cloned().fold(1e-12, f32::max);
    let shown: Vec<String> = total.iter().map(|v| format!("{:.2}", v / max)).collect();
    let k = key::detect_key(&ch);
    let name = k.as_ref().map(|k| format!("{} ({:.2})", key::key_name(k.tonic_pc, k.minor), k.confidence));
    (name, format!("tuning {:+.2} chroma C..B [{}] scores {:?}", ch.tuning, shown.join(" "), key::key_scores(&ch).iter().take(4).map(|s| format!("{}{} {:.3}", key::tonic_name(s.0, s.1), if s.1 { "m" } else { "" }, s.2)).collect::<Vec<_>>()))
}

#[test]
fn neon_fog_key_on_mix_and_stems() {
    let Some(d) = dir() else {
        eprintln!("KRYPT_TEST_NEONFOG not set; skipped");
        return;
    };
    let files = ["neonfog.wav", "stems/other.wav", "stems/bass.wav", "stems/drums.wav", "stems/vocals.wav"];
    let mut got = Vec::new();
    for f in files {
        let (k, diag) = key_of(&d.join(f));
        eprintln!("{f:18} key {:12} {diag}", k.clone().unwrap_or_else(|| "null".into()));
        got.push(k);
    }
    for (f, k) in files.iter().zip(&got).take(3) {
        let name = k.as_deref().unwrap_or("null");
        assert!(name.starts_with("Fm ") || name.starts_with("Ab "), "{f}: expected Fm (or relative Ab), got {name}");
    }
}

#[test]
fn neon_fog_beats_and_swing() {
    let Some(d) = dir() else {
        eprintln!("KRYPT_TEST_NEONFOG not set; skipped");
        return;
    };
    let data = audio::load(&d.join("neonfog.wav").to_string_lossy()).unwrap();
    let mut results = Vec::new();
    for model in [false, true] {
        let opts = Options { sections: true, beat_model_dir: if model { Some(model_dir()) } else { None }, ..Default::default() };
        let a = analyze_channels("neonfog.wav", &data.channels, data.sample_rate, &opts, &JobCtx::detached()).unwrap();
        let b = a.beats.as_ref().expect("beats");
        let mut ibis: Vec<f32> = b.times.windows(2).map(|w| w[1] - w[0]).collect();
        ibis.sort_by(|a, b| a.total_cmp(b));
        let med = ibis[ibis.len() / 2];
        let gaps: Vec<String> = b.times.windows(2).filter(|w| w[1] - w[0] > 1.5 * med).map(|w| format!("{:.2}-{:.2}", w[0], w[1])).collect();
        eprintln!(
            "model {model}: tempo {:?} beats {} (first {:?}) downbeats {:?} bpb {} swing {:?} gaps {:?} sections {:?}",
            a.tempo.as_ref().map(|t| (t.bpm, t.confidence, t.alternatives.clone())),
            b.times.len(),
            &b.times[..b.times.len().min(6)],
            &b.downbeats[..b.downbeats.len().min(6)],
            b.beats_per_bar,
            a.swing,
            gaps,
            a.sections.iter().map(|s| (s.start_sec, s.label.clone())).collect::<Vec<_>>()
        );
        results.push((a.tempo.clone(), b.times.len(), gaps.len(), a.swing, b.downbeats.clone()));
    }
    for (t, n, gaps, swing, downbeats) in results {
        let t = t.unwrap();
        let readings: Vec<f32> = std::iter::once(t.bpm).chain(t.alternatives.iter().copied()).collect();
        assert!(readings.iter().any(|r| (r - 140.0).abs() <= 1.0), "{readings:?}");
        let full = (t.bpm - 140.0).abs() <= 1.0;
        let expect = if full { 128.0 } else { 64.0 };
        assert!((n as f32 - expect).abs() <= expect * 0.05, "{n} beats, expected ≈ {expect}");
        assert_eq!(gaps, 0, "gaps in the beat grid");
        if full {
            let s = swing.expect("swing");
            assert!((s - 0.08).abs() <= 0.05, "swing {s}");
            for d in downbeats {
                let k = (d / (240.0 / 140.0)).round();
                assert!((d - k * 240.0 / 140.0).abs() < 0.03, "downbeat {d}");
            }
        }
    }
}

#[test]
fn neon_fog_chords() {
    let Some(d) = dir() else {
        eprintln!("KRYPT_TEST_NEONFOG not set; skipped");
        return;
    };
    let data = audio::load(&d.join("neonfog.wav").to_string_lossy()).unwrap();
    let bar = 240.0 / 140.0;
    let truth: [(u8, &[&str]); 4] = [(5, &["m7", "min"]), (1, &["maj7", "maj"]), (3, &["maj7", "maj"]), (0, &["m7", "min"])];
    for model in [false, true] {
        let opts = Options { sections: false, beat_model_dir: if model { Some(model_dir()) } else { None }, ..Default::default() };
        let t = std::time::Instant::now();
        let a = analyze_channels("neonfog.wav", &data.channels, data.sample_rate, &opts, &JobCtx::detached()).unwrap();
        let secs = t.elapsed().as_secs_f32();
        let (mut n, mut root, mut fam, mut exact) = (0, 0, 0, 0);
        let mut per_bar = String::new();
        let mut t = 0.0f32;
        while t < 32.0 * bar {
            let b = (t / bar) as usize;
            let (r, qs) = truth[b % 4];
            n += 1;
            if let Some(s) = a.chords.iter().find(|s| t >= s.start_sec && t < s.end_sec) {
                if s.root == r {
                    root += 1;
                    if qs.contains(&s.quality.as_str()) {
                        fam += 1;
                    }
                    if qs[0] == s.quality.as_str() {
                        exact += 1;
                    }
                }
            }
            t += 0.01;
        }
        for b in 0..32 {
            let mid = (b as f32 + 0.5) * bar;
            let s = a.chords.iter().find(|s| mid >= s.start_sec && mid < s.end_sec);
            per_bar.push_str(&s.map(|s| format!("{}{} ", krypt_studio_analyzer::chords::NOTE[s.root as usize], s.quality.as_str())).unwrap_or_else(|| "- ".into()));
        }
        let (root, fam, exact) = (root as f32 / n as f32, fam as f32 / n as f32, exact as f32 / n as f32);
        eprintln!("neon fog chords (model {model}, {secs:.2} s): root {root:.2} quality {fam:.2} exact {exact:.2}, {} spans\n  bars: {per_bar}", a.chords.len());
        assert!(root >= 0.8, "root accuracy {root:.2}");
        assert!(a.estimated.iter().any(|e| e == "chords"));
    }
}

#[test]
fn neon_fog_keys_through_analyze() {
    let Some(d) = dir() else {
        eprintln!("KRYPT_TEST_NEONFOG not set; skipped");
        return;
    };
    let mut keys = Vec::new();
    for f in ["neonfog.wav", "up5.wav", "stems/other.wav", "stems/bass.wav", "stems/drums.wav", "stems/vocals.wav"] {
        let p = d.join(f);
        if !p.is_file() {
            eprintln!("{f}: missing, skipped");
            keys.push((f, None, 0));
            continue;
        }
        let data = audio::load(&p.to_string_lossy()).unwrap();
        let opts = Options { sections: false, beat_model_dir: None, ..Default::default() };
        let a = analyze_channels(f, &data.channels, data.sample_rate, &opts, &JobCtx::detached()).unwrap();
        let key = a.key.as_ref().map(|k| (k.name.clone(), k.confidence));
        eprintln!("{f:18} key {key:?} sources {:?}", a.sources.iter().filter(|s| s.starts_with("key")).collect::<Vec<_>>());
        if f == "up5.wav" {
            let bar = 240.0 / 142.0;
            let truth = [10u8, 6, 8, 5];
            let (mut n, mut ok) = (0, 0);
            let mut t = 0.0f32;
            while t < 32.0 * bar {
                n += 1;
                if a.chords.iter().any(|s| t >= s.start_sec && t < s.end_sec && s.root == truth[(t / bar) as usize % 4]) {
                    ok += 1;
                }
                t += 0.01;
            }
            let bars: Vec<String> = (0..32)
                .map(|b| {
                    let mid = (b as f32 + 0.5) * bar;
                    a.chords.iter().find(|s| mid >= s.start_sec && mid < s.end_sec).map(|s| format!("{}{}", krypt_studio_analyzer::chords::NOTE[s.root as usize], s.quality.as_str())).unwrap_or_else(|| "-".into())
                })
                .collect();
            eprintln!("up5 chords: root {:.2}\n  bars: {}", ok as f32 / n as f32, bars.join(" "));
            assert!(ok as f32 / n as f32 >= 0.75, "up5 chord roots {:.2}", ok as f32 / n as f32);
        }
        keys.push((f, key.map(|k| k.0), a.chords.len()));
    }
    let name = |f: &str| keys.iter().find(|k| k.0 == f).and_then(|k| k.1.clone()).unwrap_or_else(|| "null".into());
    assert_eq!(name("neonfog.wav"), "Fm");
    if d.join("up5.wav").is_file() {
        assert_eq!(name("up5.wav"), "Bbm");
    }
    for f in ["stems/other.wav", "stems/bass.wav"] {
        assert!(name(f) == "Fm" || name(f) == "Ab", "{f}: {}", name(f));
    }
    assert!(keys.iter().any(|k| k.0 == "stems/drums.wav" && k.2 == 0), "chords on the drum stem");
}
