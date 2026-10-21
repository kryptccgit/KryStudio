//! Factory library tests. Everything is generated into a temp dir (never
//! resources/), checked against its index, then generated again and
//! compared byte for byte.

use super::*;
use super::synth::db;
use crate::wav::decode_wav;
use std::collections::{BTreeMap, BTreeSet};

const LEGACY_FACTORY_PATHS: [&str; 11] = [
    "factory:drums/808.wav",
    "factory:drums/clap.wav",
    "factory:drums/crash.wav",
    "factory:drums/hat-closed.wav",
    "factory:drums/hat-open.wav",
    "factory:drums/kick-2.wav",
    "factory:drums/kick.wav",
    "factory:drums/perc.wav",
    "factory:drums/rim.wav",
    "factory:drums/snare.wav",
    "factory:drums/tom.wav",
];

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("krypt-factory-test-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn walk(d: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(d).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn bits_of(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[34], bytes[35]])
}

fn smpl_root(bytes: &[u8]) -> Option<u32> {
    let mut pos = 12;
    while pos + 8 <= bytes.len() {
        let len = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        if &bytes[pos..pos + 4] == b"smpl" {
            return Some(u32::from_le_bytes(bytes[pos + 20..pos + 24].try_into().unwrap()));
        }
        pos += 8 + len + (len & 1);
    }
    None
}

/// The string literals of `export const <name> = [ ... ]` in a TS file.
fn ts_list(src: &str, name: &str) -> Vec<String> {
    let start = src.find(&format!("export const {name} = [")).unwrap_or_else(|| panic!("{name} not found"));
    let body = &src[start..];
    let end = body.find("] as const").unwrap();
    body[..end]
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let a = l.find('\'')?;
            let b = l[a + 1..].find('\'')? + a + 1;
            Some(l[a + 1..b].to_string())
        })
        .collect()
}

#[test]
fn kinds_and_genres_match_the_typescript_contract() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../shared/sounds");
    let (Ok(types), Ok(genres)) = (std::fs::read_to_string(root.join("types.ts")), std::fs::read_to_string(root.join("genres.ts"))) else {
        eprintln!("shared/sounds not found; skipping");
        return;
    };
    assert_eq!(ts_list(&types, "SAMPLE_KINDS"), SAMPLE_KINDS.to_vec());
    assert_eq!(ts_list(&genres, "GENRE_IDS"), GENRE_IDS.to_vec());
    assert_eq!(ts_list(&types, "LEGACY_FACTORY_PATHS"), LEGACY_FACTORY_PATHS.to_vec());
}

#[test]
fn json_numbers_are_stable() {
    assert_eq!(index::num(3.75, 4), "3.75");
    assert_eq!(index::num(-1.0, 1), "-1");
    assert_eq!(index::num(0.41234, 4), "0.4123");
    assert_eq!(index::num(-0.0001, 1), "0");
    assert_eq!(index::num(15.0, 4), "15");
}

#[test]
fn library_specs_are_well_formed() {
    let specs = library::specs();
    let mut paths = BTreeSet::new();
    let mut names = BTreeSet::new();
    for s in &specs {
        assert!(paths.insert(s.rel.clone()), "duplicate path {}", s.rel);
        assert!(names.insert((s.kind, s.name.clone())), "duplicate name {} for {}", s.name, s.kind);
        assert!(s.rel.ends_with(".wav") && !s.rel.contains('\\') && s.rel == s.rel.to_ascii_lowercase(), "bad path {}", s.rel);
        assert!(s.rel.chars().all(|c| c.is_ascii_alphanumeric() || "/-_.".contains(c)), "bad path {}", s.rel);
        let top = s.rel.split('/').next().unwrap();
        assert!(LIBRARY_FOLDERS.contains(&top), "{} is outside the library folders", s.rel);
        assert!(SAMPLE_KINDS.contains(&s.kind), "{}: unknown kind {}", s.rel, s.kind);
        for g in &s.genres {
            assert!(GENRE_IDS.contains(g), "{}: unknown genre {g}", s.rel);
        }
        assert!(!s.tags.is_empty() && s.tags.len() <= 24, "{}: tags", s.rel);
        for t in &s.tags {
            assert!(!t.is_empty() && t.len() <= 32, "{}: tag {t}", s.rel);
        }
        if let Some(b) = s.bars {
            assert!(s.rel.ends_with(&format!("-{b}bar.wav")) || s.rel.starts_with("textures/"), "{}: synced files are named -<n>bar", s.rel);
        }
        if matches!(s.kind, "808" | "bass-oneshot" | "stab-oneshot") {
            assert!(s.root.is_some(), "{}: tonal samples need a root note", s.rel);
        }
        // no product / trademark names
        let lower = format!("{} {}", s.rel, s.name).to_ascii_lowercase();
        for bad in ["909", "707", "606", "tr-", "linn", "m1 ", "serum", "sylenth", "nexus", "splice", "fruity", "image-line", "korg", "roland", "moog"] {
            assert!(!lower.contains(bad), "{}: trademark-like word {bad}", s.rel);
        }
    }
}

fn index_root(samples: &[serde_json::Value], rel: &str) -> f32 {
    let p = format!("factory:{rel}");
    let s = samples.iter().find(|s| s["path"] == p.as_str()).unwrap_or_else(|| panic!("{rel} not indexed"));
    s["rootNote"].as_f64().unwrap_or_else(|| panic!("{rel}: no rootNote")) as f32
}

/// Everything in one generation (debug builds are slow): structure, audio
/// checks, size, then a second run for byte-identical output.
#[test]
fn factory_library_is_complete_valid_and_deterministic() {
    let dir = temp_dir("a");
    let rep = generate_factory(&dir, "krypt-studio-engine test").expect("generate");
    eprintln!("{}", rep.table(false));
    eprintln!("total {:.2} MB in {:.1} s", rep.total_bytes as f64 / 1_048_576.0, rep.seconds);

    // index.json
    let text = std::fs::read_to_string(dir.join("index.json")).unwrap();
    let idx: serde_json::Value = serde_json::from_str(&text).expect("index.json parses");
    assert_eq!(idx["version"], 1);
    assert_eq!(idx["generator"], "krypt-studio-engine test");
    let samples = idx["samples"].as_array().unwrap();
    assert!(samples.len() >= 250, "only {} samples", samples.len());
    assert_eq!(samples.len(), rep.files.len());

    let paths: BTreeSet<&str> = samples.iter().map(|s| s["path"].as_str().unwrap()).collect();
    assert_eq!(paths.len(), samples.len(), "duplicate paths");
    for p in LEGACY_FACTORY_PATHS {
        assert!(paths.contains(p), "legacy {p} missing from the index");
    }

    // legacy files are byte-identical to generate_kit
    let kit_dir = temp_dir("kit");
    for p in generate_kit(&kit_dir).unwrap() {
        let name = p.file_name().unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), std::fs::read(dir.join("drums").join(name)).unwrap(), "legacy {name:?} differs");
    }
    let _ = std::fs::remove_dir_all(&kit_dir);

    let mut per_kind: BTreeMap<String, usize> = BTreeMap::new();
    let mut total = 0u64;
    for s in samples {
        let path = s["path"].as_str().unwrap();
        let rel = path.strip_prefix("factory:").expect("factory: prefix");
        assert!(!rel.contains('\\'));
        let kind = s["kind"].as_str().unwrap();
        assert!(SAMPLE_KINDS.contains(&kind), "{path}: kind {kind}");
        *per_kind.entry(kind.to_string()).or_default() += 1;
        for g in s["genres"].as_array().unwrap() {
            assert!(GENRE_IDS.contains(&g.as_str().unwrap()), "{path}: genre {g}");
        }
        assert!(!s["name"].as_str().unwrap().is_empty());
        assert!(!s["tags"].as_array().unwrap().is_empty(), "{path}: no tags");

        let file = rel.split('/').fold(dir.clone(), |p, c| p.join(c));
        let bytes = std::fs::read(&file).unwrap_or_else(|e| panic!("{path}: {e}"));
        total += bytes.len() as u64;
        let (sr, ch) = decode_wav(&bytes).unwrap_or_else(|| panic!("{path}: not a WAV"));
        assert_eq!(sr, 48_000, "{path}");
        assert!(ch.iter().flatten().all(|v| v.is_finite()), "{path}: NaN / inf");
        let frames = ch[0].len();
        assert_eq!(ch.len() as u64, s["channels"].as_u64().unwrap(), "{path}: channels");
        let len = s["lengthSec"].as_f64().unwrap();
        assert!((len * 48_000.0 - frames as f64).abs() < 5.0, "{path}: lengthSec {len} vs {frames} frames");
        let legacy = LEGACY_FACTORY_PATHS.contains(&path);

        // bit depth: legacy 24-bit; library one-shots 24-bit up to 2 s, 16-bit beyond and for synced files
        let bits = bits_of(&bytes);
        if legacy || (s.get("bars").is_none() && frames as f32 / 48_000.0 <= 2.0) {
            assert_eq!(bits, 24, "{path}: {bits}-bit");
        } else {
            assert_eq!(bits, 16, "{path}: {bits}-bit");
        }

        // no clipping, peak at or below its normalisation target
        let peak_db = s["peakDb"].as_f64().unwrap() as f32;
        let pk = ch.iter().flat_map(|c| c.iter()).fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(pk < 0.999, "{path}: clips ({pk})");
        assert!(pk <= db(peak_db) * 1.002 + 1e-4, "{path}: peak {:.2} dB above its {peak_db} dB target", 20.0 * pk.log10());
        assert!(pk >= db(peak_db) * 0.5, "{path}: peak {:.2} dB far below its {peak_db} dB target", 20.0 * pk.log10());
        let tp = ch.iter().map(|c| crate::blocks::truepeak::true_peak(c)).fold(0.0f32, f32::max);
        assert!(tp <= db(peak_db) * 1.01 + 1e-4, "{path}: true peak {:.2} dB over {peak_db}", 20.0 * tp.log10());

        // tempo-synced files are exactly bars × 4 beats at 128 BPM
        if let Some(bars) = s["bars"].as_u64() {
            assert_eq!(s["bpm"].as_f64(), Some(128.0), "{path}: bpm");
            assert_eq!(frames, bars as usize * 90_000, "{path}: not exactly {bars} bars");
            assert!((len - bars as f64 * 4.0 * 60.0 / 128.0).abs() < 1e-6, "{path}: lengthSec {len}");
        } else {
            assert!(s.get("bpm").is_none(), "{path}: bpm without bars");
        }

        // tonal samples carry their root in the index and the smpl chunk
        let root = s["rootNote"].as_u64();
        if matches!(kind, "808" | "bass-oneshot" | "stab-oneshot") {
            assert!(root.is_some(), "{path}: no rootNote");
        }
        if !legacy {
            assert_eq!(smpl_root(&bytes), root.map(|r| r as u32), "{path}: smpl chunk root");
        }

        if legacy {
            continue;
        }
        let mono: Vec<f32> = if ch.len() == 2 { ch[0].iter().zip(&ch[1]).map(|(a, b)| 0.5 * (a + b)).collect() } else { ch[0].clone() };
        // no DC
        let mean = mono.iter().map(|v| *v as f64).sum::<f64>() / frames as f64;
        assert!((mean.abs() as f32) < pk * 0.01, "{path}: DC {mean}");
        // click-free ends (loops are seamless instead)
        let looped = rel.starts_with("textures/");
        if looped {
            for c in &ch {
                let jump = (c[0] - c[frames - 1]).abs();
                let typical = c.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
                assert!(jump <= typical * 1.01, "{path}: loop seam jumps {jump} (max step {typical})");
            }
        } else {
            for c in &ch {
                assert!(c[0].abs() < pk * 0.05, "{path}: starts with a click ({})", c[0]);
                assert!(c[frames - 1].abs() < pk * 0.02 + 2e-4, "{path}: ends with a click ({})", c[frames - 1]);
            }
        }
        // where the energy sits
        let env: Vec<f32> = mono.chunks(240).map(|c| c.iter().fold(0.0f32, |m, v| m.max(v.abs()))).collect();
        let first10 = env.iter().take(2).fold(0.0f32, |m, v| m.max(*v));
        let emax = env.iter().fold(0.0f32, |m, v| m.max(*v));
        let at = env.iter().position(|v| *v >= emax).unwrap() as f32 / env.len() as f32;
        let rms = |a: usize, b: usize| -> f32 {
            let s = &mono[a.min(frames)..b.min(frames)];
            (s.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / s.len().max(1) as f64).sqrt() as f32
        };
        match kind {
            "riser" | "swell" | "reverse-cymbal" => {
                assert!(at > 0.85, "{path}: climax at {at:.2} of the length, not the end");
                // end-aligned: the last 5 % is clearly louder than the first half
                let (head, tail) = (rms(0, frames / 2), rms(frames * 95 / 100, frames));
                assert!(tail > head * 2.0, "{path}: last 5% ({:.1} dB) not louder than the first half ({:.1} dB)", 20.0 * tail.log10(), 20.0 * head.log10());
            }
            "sweep-up" => assert!(at > 0.85, "{path}: climax at {at:.2} of the length, not the end"),
            // a pass-by: approaches, crosses near the end, short fall-off
            "whoosh" => assert!(at > 0.75, "{path}: whoosh crosses at {at:.2}, want the last quarter"),
            "tape-stop" => {
                // everything has slid down low near the end (dominant < ~300 Hz),
                // still sounding until it halts on the last sample
                // (the exact speed curve is checked in tape_stop_slows_pitch_and_speed_together)
                let zcr = |a: usize, b: usize| mono[a..b].windows(2).filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0)).count() as f32 / (b - a) as f32;
                let z1 = zcr(frames * 80 / 100, frames * 95 / 100);
                assert!(z1 < 0.0125, "{path}: still high-pitched near the end (zero-crossing rate {z1:.4})");
                assert!(at < 0.5, "{path}: loudest at {at:.2}; a stop starts at full speed");
                let (head, late) = (rms(0, frames / 2), rms(frames * 80 / 100, frames * 95 / 100));
                assert!(late > head * db(-40.0), "{path}: silent before it halts ({:.1} dB vs {:.1} dB)", 20.0 * late.log10(), 20.0 * head.log10());
            }
            "downlifter" | "sweep-down" | "impact" | "sub-drop" | "kick" | "snare" | "clap" | "hat" | "openhat" | "crash" | "tom" | "rim" | "snap" | "808" => {
                assert!(first10 >= emax * 0.3, "{path}: transient not at the start ({first10} vs {emax})")
            }
            _ => {}
        }
    }
    assert!(total <= MAX_TOTAL_BYTES, "factory is {total} bytes (> {MAX_TOTAL_BYTES})");
    assert!(rep.total_bytes <= MAX_TOTAL_BYTES);

    // every WAV on disk is indexed
    let mut on_disk = Vec::new();
    walk(&dir, &mut on_disk);
    let wavs: Vec<_> = on_disk.iter().filter(|p| p.extension().is_some_and(|e| e == "wav")).collect();
    assert_eq!(wavs.len(), samples.len(), "unindexed files on disk");
    assert!(!on_disk.iter().any(|p| p.extension().is_some_and(|e| e == "tmp")), "temp files left behind");

    // measured sanity per category
    let stat = |rel: &str| rep.files.iter().find(|f| f.rel == rel).map(|f| f.stat.clone()).unwrap();
    for f in &rep.files {
        let s = &f.stat;
        if f.legacy {
            continue;
        }
        match s.kind.as_str() {
            "kick" | "808" | "sub-drop" | "tom" => {
                // the low end (sub / low band) is the loudest part
                let lowest = s.bands[0].max(s.bands[1]);
                assert!(s.bands[2..].iter().all(|b| *b <= lowest + 1.0), "{}: bands {:?}", s.rel, s.bands);
                assert!(s.kind != "kick" || s.centroid_hz < 3500.0, "{}: kick centroid {}", s.rel, s.centroid_hz);
                if s.kind == "808" {
                    let f0 = s.f0_hz.unwrap_or(0.0);
                    assert!((f0 / 65.406 - 1.0).abs() < 0.02, "{}: 808 f0 {f0} Hz, want C2 65.41 Hz", s.rel);
                }
            }
            "snare" | "clap" => assert!((1000.0..8000.0).contains(&s.centroid_hz), "{}: centroid {}", s.rel, s.centroid_hz),
            "hat" | "openhat" => assert!(s.centroid_hz > 4000.0, "{}: hat centroid {}", s.rel, s.centroid_hz),
            "bass-oneshot" => {
                let f0 = s.f0_hz.unwrap_or(0.0);
                assert!((f0 / 65.406 - 1.0).abs() < 0.03, "{}: bass f0 {f0} Hz, want C2 65.41 Hz", s.rel);
            }
            "zap" => {
                // lasers / blips / glitches live above 500 Hz
                assert!(s.centroid_hz > 500.0, "{}: zap centroid {}", s.rel, s.centroid_hz);
                let low = s.bands[0].max(s.bands[1]);
                let high = s.bands[3].max(s.bands[4]).max(s.bands[5]);
                assert!(high > low + 6.0, "{}: zap bands {:?}", s.rel, s.bands);
            }
            "vox" => {
                // formant voices: energy in the voice band, nothing above ~8 kHz to speak of
                assert!((250.0..3000.0).contains(&s.centroid_hz), "{}: vox centroid {}", s.rel, s.centroid_hz);
            }
            _ => {}
        }
    }
    assert!(stat("drums/kick/punchy-club.wav").t20_ms < 400.0);
    // single-voice vocal shots sing their root (within a quarter tone)
    for rel in ["oneshots/vox/ah-shot.wav", "oneshots/vox/oh-shot.wav", "oneshots/vox/ee-chop.wav", "oneshots/vox/uh-chop-low.wav", "oneshots/vox/hey-shot.wav"] {
        let s = stat(rel);
        let root = index_root(samples, rel);
        let want = 440.0 * 2f32.powf((root - 69.0) / 12.0);
        let f0 = s.f0_hz.unwrap_or(0.0);
        assert!((f0 / want).log2().abs() * 12.0 < 0.5, "{rel}: sings {f0:.1} Hz, root {root} is {want:.1} Hz");
    }
    // sub drops: the sub / low bands dominate and the centroid stays low
    for f in rep.files.iter().filter(|f| f.stat.kind == "sub-drop") {
        assert!(f.stat.centroid_hz < 1000.0, "{}: sub-drop centroid {}", f.rel, f.stat.centroid_hz);
    }
    for k in [
        "kick", "snare", "clap", "hat", "openhat", "ride", "crash", "perc", "tom", "808", "riser", "downlifter", "impact", "sweep-up", "sweep-down", "reverse-cymbal", "sub-drop", "texture", "noise", "fill", "whoosh",
        "tape-stop", "swell", "zap", "vox",
    ] {
        assert!(per_kind.get(k).copied().unwrap_or(0) > 0, "no {k} samples");
    }

    // a second run writes identical bytes
    let dir_b = temp_dir("b");
    let rep_b = generate_factory(&dir_b, "krypt-studio-engine test").expect("generate again");
    assert_eq!(rep.files.len(), rep_b.files.len());
    let mut files_a = Vec::new();
    walk(&dir, &mut files_a);
    for a in &files_a {
        let rel = a.strip_prefix(&dir).unwrap();
        let b = dir_b.join(rel);
        assert!(std::fs::read(a).unwrap() == std::fs::read(&b).unwrap(), "{rel:?} differs between runs");
    }
    // regenerating over an existing dir removes stale library files
    let stale = dir_b.join("fx").join("riser").join("old-name-2bar.wav");
    std::fs::write(&stale, b"RIFF").unwrap();
    let keep: BTreeSet<PathBuf> = rep_b.files.iter().map(|f| f.path.clone()).collect();
    let removed = remove_stale(&dir_b, &keep).unwrap();
    assert!(!stale.exists() && removed == vec![stale.clone()], "stale file kept: {removed:?}");
    assert!(rep_b.files.iter().all(|f| f.path.exists()), "an indexed file was removed");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir_b);
}

/// A tape stop on a steady 1 kHz tone: the pitch follows the speed curve
/// down to a halt on the last sample, and the tone stays audible meanwhile.
#[test]
fn tape_stop_slows_pitch_and_speed_together() {
    use super::synth::{BAR, FS, TAU64};
    let n_src = BAR + BAR / 2;
    let sine: Vec<f32> = (0..n_src).map(|i| (TAU64 * 1000.0 * i as f64 / FS).sin() as f32 * 0.5).collect();
    let curve = 1.1;
    let out = transitions::stop(vec![sine.clone(), sine], BAR, curve, false, 1);
    assert_eq!(out[0].len(), BAR);
    let x = &out[0];
    let freq = |a: f32, b: f32| {
        let (i, j) = ((a * BAR as f32) as usize, (b * BAR as f32) as usize);
        x[i..j].windows(2).filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0)).count() as f32 / 2.0 / ((j - i) as f32 / 48_000.0)
    };
    let rms = |a: f32, b: f32| {
        let s = &x[(a * BAR as f32) as usize..(b * BAR as f32) as usize];
        (s.iter().map(|v| v * v).sum::<f32>() / s.len() as f32).sqrt()
    };
    for (a, b) in [(0.05f32, 0.1f32), (0.4, 0.45), (0.7, 0.75), (0.85, 0.9)] {
        let want = 1000.0 * (1.0 - 0.5 * (a + b)).powf(curve);
        let got = freq(a, b);
        assert!((got / want - 1.0).abs() < 0.12, "at {a:.2}..{b:.2}: {got:.0} Hz, want ~{want:.0} Hz");
    }
    assert!(freq(0.97, 1.0) < 60.0, "not halted at the end: {:.0} Hz", freq(0.97, 1.0));
    assert!(rms(0.85, 0.9) > rms(0.05, 0.1) * db(-20.0), "the stop fades out before it halts");
    assert!(x.iter().all(|v| v.is_finite()));
}

/// Manual check: `cargo test -p krypt-studio-dsp factory_table -- --ignored --nocapture`
/// prints the per-file measurement table.
#[test]
#[ignore]
fn factory_table() {
    let dir = temp_dir("table");
    let rep = generate_factory(&dir, "krypt-studio-engine test").expect("generate");
    eprintln!("{}", rep.table(true));
    for (k, n, b) in rep.folder_counts() {
        eprintln!("{k:<10} {n:>4} files {:>7.2} MB", b as f64 / 1_048_576.0);
    }
    eprintln!("total {} files, {:.2} MB in {:.1} s", rep.files.len(), rep.total_bytes as f64 / 1_048_576.0, rep.seconds);
    let _ = std::fs::remove_dir_all(&dir);
}
