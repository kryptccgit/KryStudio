use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::protocol::{Event, SeparateArgs};

fn model_dir() -> Option<PathBuf> {
    std::env::var_os("KRYPT_TEST_HTDEMUCS").filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn test_dylib() -> PathBuf {
    std::env::var_os("ORT_DYLIB_PATH")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../resources/bin").join(runtime::DYLIB))
}

fn init_runtime() -> Result<(), String> {
    runtime::runtime_from(&test_dylib()).map(|_| ())
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("krypt-separate-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn args(path: &str, model_dir: &str, out_dir: &str, device: &str) -> SeparateArgs {
    SeparateArgs { path: path.into(), model: "htdemucs".into(), model_dir: model_dir.into(), out_dir: out_dir.into(), device: device.into() }
}

fn ctx_with(cancel: Arc<AtomicBool>, events: Arc<Mutex<Vec<Event>>>) -> JobCtx {
    JobCtx::new(7, cancel, Arc::new(move |e| events.lock().unwrap().push(e)))
}

fn message(r: Result<StemsResult, JobError>) -> String {
    match r {
        Err(JobError::Failed(m)) => m,
        Err(JobError::Cancelled) => "cancelled".into(),
        Ok(_) => "ok".into(),
    }
}

#[test]
fn rejects_unknown_model_and_device() {
    let ctx = JobCtx::detached();
    let mut a = args("x.wav", "nowhere", "out", "auto");
    a.model = "umxl".into();
    assert!(message(run(&a, &ctx)).contains("Unknown stem model 'umxl'"));
    let a = args("x.wav", "nowhere", "out", "cuda");
    assert!(message(run(&a, &ctx)).contains("Unknown inference device 'cuda'"));
}

#[test]
fn missing_model_names_the_folder_and_file() {
    let dir = scratch("nomodel");
    let a = args("x.wav", dir.to_str().unwrap(), dir.join("out").to_str().unwrap(), "auto");
    let m = message(run(&a, &JobCtx::detached()));
    assert!(m.contains("HT-Demucs model not found") && m.contains("htdemucs_fwd.onnx") && m.contains("Model Manager"), "{m}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn devices_lists_cpu_first() {
    let _ = init_runtime();
    let d = devices();
    assert_eq!(d[0], "cpu");
    assert!(d.iter().all(|x| x == "cpu" || x == "directml"));
}

struct Mix {
    left: Vec<f32>,
    right: Vec<f32>,
    bass: Vec<f32>,
}

fn synth_mix(rate: u32, seconds: f32) -> Mix {
    let sr = rate as f32;
    let n = (sr * seconds) as usize;
    let beat = 0.5f32;
    let (mut left, mut right, mut bass) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
    let mut seed = 0x1234_5678u32;
    let mut noise = move || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed as f32 / u32::MAX as f32 * 2.0 - 1.0
    };
    let mut t0 = 0.0;
    while t0 < seconds {
        let i0 = (t0 * sr) as usize;
        let mut ph = 0f32;
        for k in 0..((0.35 * sr) as usize).min(n.saturating_sub(i0)) {
            let t = k as f32 / sr;
            ph += 2.0 * std::f32::consts::PI * (50.0 + 120.0 * (-t * 30.0).exp()) / sr;
            let s = ph.sin() * (-t * 9.0).exp() * 0.9;
            left[i0 + k] += s;
            right[i0 + k] += s;
        }
        let h0 = ((t0 + beat / 2.0) * sr) as usize;
        let mut prev = 0f32;
        for k in 0..((0.05 * sr) as usize).min(n.saturating_sub(h0)) {
            let x = noise();
            let s = (x - prev) * (-(k as f32 / sr) * 80.0).exp() * 0.15;
            prev = x;
            left[h0 + k] += s;
            right[h0 + k] += s * 0.9;
        }
        t0 += beat;
    }
    let notes = [55.0f32, 55.0, 73.42, 65.41];
    let melody = [220.0f32, 246.94, 293.66, 329.63, 293.66, 246.94];
    let (mut pb, mut pv) = (0f32, 0f32);
    for i in 0..n {
        let t = i as f32 / sr;
        pb += 2.0 * std::f32::consts::PI * notes[((t / (4.0 * beat)) as usize) % 4] / sr;
        let b = pb.sin() * 0.35;
        bass[i] = b;
        let f = melody[((t / beat) as usize) % 6] * (1.0 + 0.012 * (2.0 * std::f32::consts::PI * 5.5 * t).sin());
        pv += 2.0 * std::f32::consts::PI * f / sr;
        let env = 0.6 + 0.4 * (2.0 * std::f32::consts::PI * 0.25 * t).sin().powi(2);
        let v = (pv.sin() + 0.4 * (2.0 * pv).sin() + 0.2 * (3.0 * pv).sin()) * 0.18 * env;
        left[i] += b + v * 0.9;
        right[i] += b + v * 1.1;
    }
    Mix { left, right, bass }
}

fn write_wav(path: &std::path::Path, rate: u32, mix: &Mix) {
    let spec = hound::WavSpec { channels: 2, sample_rate: rate, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for (l, r) in mix.left.iter().zip(&mix.right) {
        w.write_sample(*l).unwrap();
        w.write_sample(*r).unwrap();
    }
    w.finalize().unwrap();
}

fn read_wav(path: &std::path::Path) -> (hound::WavSpec, Vec<f32>, Vec<f32>) {
    let mut r = hound::WavReader::open(path).unwrap();
    let spec = r.spec();
    let s: Vec<f32> = r.samples::<f32>().map(Result::unwrap).collect();
    (spec, s.iter().step_by(2).copied().collect(), s.iter().skip(1).step_by(2).copied().collect())
}

fn dot(a: &[f32], b: &[f32]) -> f64 {
    a.iter().zip(b).map(|(x, y)| f64::from(*x) * f64::from(*y)).sum()
}

fn e2e(rate: u32, device: &str) {
    let Some(model) = model_dir() else {
        eprintln!("skipped: set KRYPT_TEST_HTDEMUCS=<model dir> (and ORT_DYLIB_PATH) to run the HT-Demucs end-to-end test");
        return;
    };
    init_runtime().expect("ONNX Runtime must load for the gated test");
    let dir = scratch(&format!("e2e-{rate}-{device}"));
    let mix = synth_mix(rate, 10.0);
    let src = dir.join("mix.wav");
    write_wav(&src, rate, &mix);
    let out = dir.join("stems");
    let events = Arc::new(Mutex::new(Vec::new()));
    let ctx = ctx_with(Arc::new(AtomicBool::new(false)), events.clone());
    let a = args(src.to_str().unwrap(), model.to_str().unwrap(), out.to_str().unwrap(), device);
    let res = match run(&a, &ctx) {
        Ok(r) => r,
        Err(e) => panic!("separate failed: {}", message(Err(e))),
    };
    eprintln!("[{rate} Hz, {device}] device used: {}, {:.2} s for 10 s of audio", res.device, res.seconds);
    if device != "auto" {
        assert_eq!(res.device, device);
    }
    assert_eq!(res.stems.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["drums", "bass", "other", "vocals"]);

    let n = mix.left.len();
    let (mut sum_l, mut sum_r) = (vec![0f32; n], vec![0f32; n]);
    let mut bass_share = Vec::new();
    for s in &res.stems {
        let (spec, l, r) = read_wav(std::path::Path::new(&s.path));
        assert_eq!((spec.channels, spec.sample_rate, spec.bits_per_sample), (2, rate, 32), "{}", s.name);
        assert_eq!(l.len(), n, "{} length", s.name);
        for i in 0..n {
            sum_l[i] += l[i];
            sum_r[i] += r[i];
        }
        bass_share.push((dot(&l, &mix.bass) + dot(&r, &mix.bass)) / (2.0 * dot(&mix.bass, &mix.bass)));
        assert!(s.peak_db.is_finite() && s.rms_db.is_finite());
    }
    let resid: f64 = sum_l.iter().zip(&mix.left).chain(sum_r.iter().zip(&mix.right)).map(|(a, b)| f64::from(a - b).powi(2)).sum();
    let energy: f64 = mix.left.iter().chain(&mix.right).map(|v| f64::from(*v).powi(2)).sum();
    let resid_db = 10.0 * (resid / energy).log10();
    eprintln!("[{rate} Hz, {device}] sum-of-stems residual {resid_db:.1} dB; bass-line share per stem (drums, bass, other, vocals): {bass_share:.3?}");
    assert!(resid_db < -15.0, "stems don't add up to the mix: residual {resid_db:.1} dB");
    let tail = n - (rate as usize / 20);
    let tail_resid: f64 = (tail..n).map(|i| f64::from(sum_l[i] - mix.left[i]).powi(2)).sum();
    let tail_energy: f64 = (tail..n).map(|i| f64::from(mix.left[i]).powi(2)).sum();
    let tail_db = 10.0 * (tail_resid / tail_energy).log10();
    assert!(tail_db < -10.0, "last 50 ms don't match the mix: residual {tail_db:.1} dB");
    assert!(bass_share[1] > 0.6, "bass line not in the bass stem: {bass_share:?}");
    assert!(bass_share[1] > 3.0 * bass_share.iter().enumerate().filter(|(i, _)| *i != 1).map(|(_, v)| v.abs()).fold(0.0, f64::max));

    let ev = events.lock().unwrap();
    let sep: Vec<f32> = ev.iter().filter_map(|e| match e {
        Event::Progress { stage, fraction, .. } if stage == "separating" => Some(*fraction),
        _ => None,
    }).collect();
    assert!(sep.windows(2).all(|w| w[1] >= w[0]) && sep.last() == Some(&1.0), "progress {sep:?}");
    assert!(!out.join("drums.wav.partial").exists());
    drop(ev);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn e2e_44k_auto() {
    e2e(44_100, "auto");
}

#[test]
fn e2e_48k_cpu() {
    e2e(48_000, "cpu");
}

#[test]
fn e2e_cancel_mid_run_leaves_nothing() {
    let Some(model) = model_dir() else {
        eprintln!("skipped: set KRYPT_TEST_HTDEMUCS to run");
        return;
    };
    init_runtime().expect("ONNX Runtime must load for the gated test");
    let dir = scratch("cancel");
    let rate = 44_100;
    let mix = synth_mix(rate, 10.0);
    let src = dir.join("mix.wav");
    write_wav(&src, rate, &mix);
    let out = dir.join("stems");
    let cancel = Arc::new(AtomicBool::new(false));
    let events = Arc::new(Mutex::new(Vec::new()));
    let (c2, armed) = (cancel.clone(), Arc::new(AtomicBool::new(false)));
    let ctx = JobCtx::new(9, cancel.clone(), {
        let events = events.clone();
        Arc::new(move |e: Event| {
            if let Event::Progress { stage, fraction, .. } = &e {
                if stage == "separating" && *fraction == 0.0 && !armed.swap(true, Ordering::SeqCst) {
                    let c = c2.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(300));
                        c.store(true, Ordering::SeqCst);
                    });
                }
            }
            events.lock().unwrap().push(e);
        })
    });
    let a = args(src.to_str().unwrap(), model.to_str().unwrap(), out.to_str().unwrap(), "cpu");
    let t = std::time::Instant::now();
    let r = run(&a, &ctx);
    assert!(matches!(r, Err(JobError::Cancelled)), "expected cancel, got {}", message(r));
    eprintln!("cancelled after {:.2} s", t.elapsed().as_secs_f32());
    let left: Vec<_> = std::fs::read_dir(&out).map(|d| d.flatten().map(|e| e.file_name()).collect()).unwrap_or_default();
    assert!(left.is_empty(), "partial files left behind: {left:?}");
    std::fs::remove_dir_all(&dir).unwrap();
}
