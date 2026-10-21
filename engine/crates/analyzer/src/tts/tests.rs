//! `tts` tests. The model tests need Kokoro and ONNX Runtime:
//!
//!   KRYPT_TEST_KOKORO=<dir with model_quantized.onnx (or model.onnx) + <voice>.bin or voices/<voice>.bin>
//!     (default: %APPDATA%\Krypt Studio\models\kokoro, where the Model Manager installs it)
//!   ORT_DYLIB_PATH=<…\onnxruntime.dll>   (default: <repo>/resources/bin/onnxruntime.dll)
//!
//! and are skipped (pass trivially, with a note on stderr) without them.

use std::path::PathBuf;
use std::time::Instant;

use super::*;
use crate::protocol::TtsArgs;

fn model_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("KRYPT_TEST_KOKORO")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Krypt Studio").join("models").join("kokoro")))?;
    kokoro::model_file(&dir).map(|_| dir)
}

fn test_dylib() -> PathBuf {
    std::env::var_os("ORT_DYLIB_PATH")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../resources/bin").join(runtime::DYLIB))
}

/// Model dir when the model AND ONNX Runtime are available; else None (skip).
fn setup(test: &str) -> Option<PathBuf> {
    let Some(dir) = model_dir() else {
        eprintln!("{test}: skipped (no Kokoro model; set KRYPT_TEST_KOKORO)");
        return None;
    };
    if let Err(e) = runtime::runtime_from(&test_dylib()) {
        eprintln!("{test}: skipped (ONNX Runtime unavailable: {e})");
        return None;
    }
    Some(dir)
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("krypt-tts-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn args(text: &str, voice: &str, out: &std::path::Path, dir: &std::path::Path) -> TtsArgs {
    TtsArgs { text: text.into(), phonemes: None, voice: voice.into(), speed: None, out: out.to_string_lossy().into(), model_dir: dir.to_string_lossy().into() }
}

fn message<T>(r: Result<T, JobError>) -> String {
    match r {
        Err(JobError::Failed(m)) => m,
        Err(JobError::Cancelled) => "cancelled".into(),
        Ok(_) => "ok".into(),
    }
}

fn read_wav(path: &std::path::Path) -> (Vec<f32>, u32) {
    let mut r = hound::WavReader::open(path).unwrap();
    let sr = r.spec().sample_rate;
    (r.samples::<f32>().map(Result::unwrap).collect(), sr)
}

#[test]
fn chunks_and_style_rows() {
    let chunks = text_chunks("Hello there. This is Krypt Voice! Is it working?");
    assert_eq!(chunks.len(), 3);
    assert!(chunks.iter().all(|c| c.phonemes.chars().count() <= MAX_CHUNK));
    let long = "word ".repeat(300);
    let pieces = text_chunks(&long);
    assert!(pieces.len() >= 3, "{}", pieces.len());
    assert!(pieces.iter().all(|c| c.phonemes.chars().count() <= MAX_CHUNK));
    // Every word of the long text survives the split.
    assert_eq!(pieces.iter().map(|p| p.words.len()).sum::<usize>(), 300);
    let table: Vec<f32> = (0..510 * 256).map(|i| (i / 256) as f32).collect();
    assert_eq!(style_for(&table, 10)[0], 10.0);
    assert_eq!(style_for(&table, 9999)[0], 509.0);
}

#[test]
fn word_samples_follow_durations() {
    // "ab cd": tokens a b ␠ c d; durations incl. pads: [2, 1, 1, 1, 2, 2, 3]
    let words = vec![WordSpan { text: "ab".into(), start: 0, end: 2 }, WordSpan { text: "cd".into(), start: 3, end: 5 }];
    let src = vec![0, 1, 2, 3, 4];
    let dur = vec![2.0, 1.0, 1.0, 1.0, 2.0, 2.0, 3.0];
    let w = word_samples(&words, &src, &dur, 12 * 600);
    assert_eq!(w, vec![("ab".to_string(), 1200, 2400), ("cd".to_string(), 3000, 5400)]);
}

#[test]
fn rejects_bad_requests_with_clear_messages() {
    let ctx = JobCtx::detached();
    let out = scratch("bad").join("x.wav");
    let dir = scratch("empty-model");
    let m = message(run(&args("hi", "jf_alpha", &out, &dir), &ctx));
    assert!(m.contains("English only") && m.contains("Fish"), "{m}");
    let m = message(run(&args("hi", "af_heart", &out, &dir), &ctx));
    assert!(m.contains("Model Manager"), "{m}");
    let m = message(run(&args("hi", "../evil", &out, &dir), &ctx));
    assert!(m.contains("not a Kokoro voice id"), "{m}");
    let mut a = args("hi", "af_heart", &out, &dir);
    a.speed = Some(3.0);
    assert!(message(run(&a, &ctx)).contains("out of range"));
}

#[test]
fn exposes_the_duration_tensor() {
    let Some(dir) = model_dir() else {
        eprintln!("exposes_the_duration_tensor: skipped (no Kokoro model)");
        return;
    };
    let file = kokoro::model_file(&dir).unwrap();
    let bytes = std::fs::read(&file).unwrap();
    let n = bytes.len();
    let (patched, name) = kokoro::expose_durations(bytes).unwrap();
    assert!(name.is_some(), "no duration tensor found in {}", file.display());
    assert!(patched.len() > n && patched.len() < n + 200);
}

#[test]
fn smoke_speaks_with_word_timings() {
    let Some(dir) = setup("smoke_speaks_with_word_timings") else { return };
    let out = scratch("smoke").join("hello.wav");
    let ctx = JobCtx::detached();
    let text = "Hello world, this is Krypt Voice. It runs on your own computer!";
    let t = Instant::now();
    let r = run(&args(text, "af_heart", &out, &dir), &ctx).unwrap_or_else(|e| panic!("{}", message::<()>(Err(e))));
    let cold = t.elapsed().as_secs_f32();
    let (x, sr) = read_wav(&out);
    assert_eq!(sr, 24_000);
    assert_eq!(r.sample_rate, 24_000);
    assert!((r.duration_sec - x.len() as f32 / 24_000.0).abs() < 1e-3);
    assert!(r.duration_sec > 2.0 && r.duration_sec < 8.0, "duration {}", r.duration_sec);
    let peak = x.iter().fold(0f32, |m, v| m.max(v.abs()));
    assert!(peak > 0.05 && peak <= 0.99, "peak {peak}");
    // Words: all 12, in order, inside the audio.
    let texts: Vec<&str> = r.words.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(texts, ["Hello", "world", "this", "is", "Krypt", "Voice", "It", "runs", "on", "your", "own", "computer"]);
    for w in r.words.windows(2) {
        assert!(w[0].start_sec <= w[0].end_sec && w[0].end_sec <= w[1].start_sec + 0.05, "{:?}", w);
    }
    assert!(r.words.last().unwrap().end_sec <= r.duration_sec + 1e-3);
    // Warm run for the speed figure.
    let t = Instant::now();
    let r2 = run(&args(text, "am_michael", &out, &dir), &ctx).unwrap();
    let warm = t.elapsed().as_secs_f32();
    eprintln!("tts smoke: {:.2} s audio, cold {cold:.2} s, warm {warm:.2} s (RTF {:.3}); words {:?}", r2.duration_sec, warm / r2.duration_sec, r.words);
}

#[test]
fn deterministic_output() {
    let Some(dir) = setup("deterministic_output") else { return };
    let d = scratch("det");
    let ctx = JobCtx::detached();
    let a = run(&args("Same words, same sound.", "af_bella", &d.join("a.wav"), &dir), &ctx).unwrap();
    let b = run(&args("Same words, same sound.", "af_bella", &d.join("b.wav"), &dir), &ctx).unwrap();
    assert_eq!(a.duration_sec, b.duration_sec);
    assert_eq!(read_wav(&d.join("a.wav")).0, read_wav(&d.join("b.wav")).0);
}

/// Device benchmark (prints only): `cargo test ... tts::tests::bench_devices -- --ignored --nocapture`.
#[test]
#[ignore]
fn bench_devices() {
    let Some(dir) = setup("bench_devices") else { return };
    let text = "The quick brown fox jumps over the lazy dog, and then it runs back home to sleep. Krypt Studio makes beats on your own computer, free.";
    let chunks = text_chunks(text);
    let table = load_voice(&voice_file(&dir, "af_heart").unwrap()).unwrap();
    for file in kokoro::MODEL_FILES.iter().map(|f| dir.join(f)).filter(|p| p.is_file()) {
        for device in [Device::Cpu, Device::DirectMl] {
            if device == Device::DirectMl && runtime::directml().is_err() {
                continue;
            }
            let t = Instant::now();
            let r = kokoro::with_model(&file, device, |m| {
                let mut audio = 0usize;
                let t = Instant::now();
                for _ in 0..2 {
                    audio = 0;
                    for c in &chunks {
                        let (ids, _) = vocab::encode(&c.phonemes);
                        let mut p = vec![0];
                        p.extend(&ids);
                        p.push(0);
                        let (w, d) = m.infer(&p, style_for(&table, ids.len()), 1.0)?;
                        if let Some(d) = d {
                            let frames: f32 = d.iter().sum();
                            eprintln!("  samples {} vs frames×600 {}", w.len(), frames * 600.0);
                        }
                        audio += w.len();
                    }
                }
                Ok((audio, t.elapsed().as_secs_f32() / 2.0))
            });
            match r {
                Ok(((audio, secs), load)) => {
                    let a = audio as f32 / 24_000.0;
                    eprintln!("{} on {}: load {load} ms (total {:.1} s), {a:.2} s audio in {secs:.2} s → RTF {:.3}", file.display(), device.label(), t.elapsed().as_secs_f32(), secs / a);
                }
                Err(e) => eprintln!("{} on {}: failed: {e}", file.display(), device.label()),
            }
        }
    }
}

/// The "Sing my notes" chain on real Kokoro speech: tts → syllables → sing.
#[test]
fn speech_to_syllables_to_song() {
    let Some(dir) = setup("speech_to_syllables_to_song") else { return };
    let d = scratch("chain");
    let ctx = JobCtx::detached();
    let speech = d.join("speech.wav");
    // 8 syllables: "la la la la, sing a long song"
    run(&args("La la la la, sing a long song.", "af_heart", &speech, &dir), &ctx).unwrap();
    let (x, sr) = read_wav(&speech);
    let free = crate::syllables::detect(&x, sr as f32, None, &ctx).unwrap();
    eprintln!("syllables found without a target: {} (8 spoken)", free.len());
    assert!((5..=12).contains(&free.len()), "{free:?}");
    let syl = crate::syllables::detect(&x, sr as f32, Some(8), &ctx).unwrap();
    assert_eq!(syl.len(), 8);
    let melody = [60.0, 62.0, 64.0, 65.0, 67.0, 65.0, 64.0, 62.0];
    let segs: Vec<crate::protocol::SingSegment> = syl
        .iter()
        .zip(melody)
        .enumerate()
        .map(|(i, (s, m))| crate::protocol::SingSegment { src_start_sec: f64::from(s.start_sec), src_end_sec: f64::from(s.end_sec), out_start_sec: 0.4 * i as f64, dur_sec: 0.4, midi: m })
        .collect();
    let t = Instant::now();
    let (y, r) = crate::sing::render(&x, f64::from(sr), &segs, 0.2, 0.04, &ctx).unwrap();
    eprintln!("sing on speech: {:.1} s in {:.3} s; f0s {:?}", y.len() as f64 / f64::from(sr), t.elapsed().as_secs_f64(), r.iter().map(|s| s.f0_hz).collect::<Vec<_>>());
    assert!(r.iter().filter(|s| s.f0_hz.is_some()).count() >= 6, "{r:?}");
    // Each voiced note's median pitch lands near its key. Synthetic voices land within ±20 cents
    // (sing tests); real speech keeps some movement (creaky phrase ends, YIN slips): ±75 here,
    // ~25 cents typical. Krypt Tune runs on the result.
    for (i, (s, m)) in r.iter().zip(melody).enumerate() {
        if s.f0_hz.is_none() {
            continue;
        }
        let a = ((0.4 * i as f64 + 0.08) * f64::from(sr)) as usize;
        let b = ((0.4 * i as f64 + 0.32) * f64::from(sr)) as usize;
        let fr = crate::syllables::voicing_track(&y[a..b], sr as f32, 0.01);
        if let Some(f) = crate::syllables::median_f0(&fr, 3) {
            let c = 1200.0 * (f64::from(f) / crate::sing::midi_hz(m)).log2();
            eprintln!("note {i}: {c:+.0} cents");
            assert!(c.abs() < 75.0, "note {i}: {c:.0} cents off");
        }
    }
}
