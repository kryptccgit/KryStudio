//! Audio-clip time-stretch / pitch-shift (variants.rs) through the whole
//! engine, with the REAL stock `krypt.audioclip` instrument (every other
//! plugin is the test host's). Child of `tests` for its project builders.

use super::*;
use crate::variants::{self, VariantJob, VariantOutcome};
use krypt_studio_dsp::PluginDescriptor;
use rustfft::{num_complex::Complex, FftPlanner};
use std::f64::consts::PI;
use std::path::PathBuf;

const SR: f64 = 48000.0;

// ── Host: real audio clip, test plugins elsewhere ─────────────────────────

fn clip_create(id: &str, sr: f32, max: usize) -> Option<Box<dyn Instrument>> {
    if id == "krypt.audioclip" {
        krypt_studio_dsp::create_instrument(id, sr, max)
    } else {
        test_create_instrument(id, sr, max)
    }
}

fn clip_descs() -> Vec<PluginDescriptor> {
    let real = krypt_studio_dsp::descriptor("krypt.audioclip").expect("stock audioclip");
    test_descriptors().into_iter().map(|d| if d.id == "krypt.audioclip" { real.clone() } else { d }).collect()
}

fn clip_host() -> PluginHost {
    PluginHost { create_instrument: clip_create, create_effect: test_create_effect, descriptors: clip_descs }
}

// ── Fixtures ──────────────────────────────────────────────────────────────

fn tmp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("kse-stretch-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write_wav(path: &std::path::Path, chans: &[Vec<f32>]) {
    let spec = hound::WavSpec { channels: chans.len() as u16, sample_rate: SR as u32, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..chans[0].len() {
        for c in chans {
            w.write_sample(c[i]).unwrap();
        }
    }
    w.finalize().unwrap();
}

fn sine(freq: f64, secs: f64, amp: f64) -> Vec<f32> {
    (0..(secs * SR) as usize).map(|i| (amp * (2.0 * PI * freq * i as f64 / SR).sin()) as f32).collect()
}

/// 1 kHz bursts (1 ms attack, 12 ms decay) at the given times.
fn bursts(secs: f64, at: &[f64]) -> Vec<f32> {
    let mut x = vec![0f32; (secs * SR) as usize];
    for &t in at {
        let s0 = (t * SR) as usize;
        for k in 0..(0.08 * SR) as usize {
            let tt = k as f64 / SR;
            let env = (tt / 0.001).min(1.0) * (-tt / 0.012).exp();
            if s0 + k < x.len() {
                x[s0 + k] += (0.8 * env * (2.0 * PI * 1000.0 * tt).sin()) as f32;
            }
        }
    }
    x
}

/// 120 Hz pulse train through a resonance at 800 Hz (vowel stand-in).
fn vowel(secs: f64) -> Vec<f32> {
    let w = 2.0 * PI * 800.0 / SR;
    let (alpha, cw) = (w.sin() / 16.0, w.cos());
    let (b0, a0, a1, a2) = (alpha, 1.0 + alpha, -2.0 * cw, 1.0 - alpha);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    (0..(secs * SR) as usize)
        .map(|i| {
            let x0 = if (i as f64 % (SR / 120.0)) < 1.0 { 1.0 } else { 0.0 };
            let y0 = (b0 * x0 - b0 * x2 - a1 * y1 - a2 * y2) / a0;
            (x2, x1, y2, y1) = (x1, x0, y1, y0);
            (y0 * 0.5) as f32
        })
        .collect()
}

/// Song with one audio clip (channel "ca", volume 1) of `clip_ticks` at tick 0.
fn clip_project(bpm: f64, path: &std::path::Path, params: Value, clip_ticks: f64) -> Value {
    let mut p = base(bpm, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "ca", "krypt.audioclip", "i1");
    p["channels"]["ca"]["volume"] = json!(1.0);
    p["samples"]["s1"] = json!({ "id": "s1", "name": "x", "path": path.to_string_lossy() });
    p["channels"]["ca"]["generator"]["sampleId"] = json!("s1");
    p["channels"]["ca"]["generator"]["params"] = params;
    add_clip(&mut p, "k1", "audio", 0.0, clip_ticks, json!({ "channelId": "ca" }));
    p
}

/// Offline render of ticks [a, b) (left channel) + logs.
fn render_range(p: &Value, cache: &Arc<SampleCache>, a: f64, b: f64) -> (Vec<f32>, Vec<String>) {
    let mut w = Warnings::default();
    let model = Model::from_project(p, &mut w);
    let req = RenderRequest {
        path: String::new(),
        scope: RenderScope::Range { start_tick: a, end_tick: b },
        format: "wav32f".into(),
        sample_rate: Some(SR),
        tail_sec: Some(0.0),
        analyze: None,
        stems: None,
        stem_inserts: None,
        loops: None,
        normalize: None,
        mp3_kbps: None,
    };
    let mut progress = |_p: f64| {};
    let mut logs: Vec<String> = w.drain_messages();
    let out = {
        let mut log = |_l: &str, m: String| logs.push(m);
        let mut env = RenderEnv {
            host: clip_host(),
            cache: cache.clone(),
            factory_dir: ".".into(),
            packs_dir: None,
            base_dir: None,
            cancel: Arc::new(AtomicBool::new(false)),
            default_sr: SR,
            progress: &mut progress,
            log: &mut log,
        };
        render_audio(&model, &req, &mut env).expect("render")
    };
    (out.left, logs)
}

fn ticks(secs: f64, bpm: f64) -> f64 {
    secs * bpm / 60.0 * 960.0
}

fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt()
}

fn seg(x: &[f32], a: f64, b: f64) -> &[f32] {
    let (ia, ib) = (((a * SR) as usize).min(x.len()), ((b * SR) as usize).min(x.len()));
    &x[ia..ib]
}

/// Energy-weighted centre time (s) of x within [a, b) seconds.
fn centroid(x: &[f32], a: f64, b: f64) -> f64 {
    let ia = (a * SR) as usize;
    let (mut num, mut den) = (0.0, 0.0);
    for (k, v) in seg(x, a, b).iter().enumerate() {
        let e = (*v as f64).powi(2);
        num += e * (ia + k) as f64;
        den += e;
    }
    num / den.max(1e-30) / SR
}

/// Last time (s) the signal exceeds `thr`.
fn last_sound(x: &[f32], thr: f32) -> f64 {
    x.iter().rposition(|v| v.abs() > thr).map_or(0.0, |i| i as f64 / SR)
}

fn peak_hz(x: &[f32], a: f64) -> f64 {
    let n = 1 << 15;
    let a = (a * SR) as usize;
    let mut buf: Vec<Complex<f64>> =
        (0..n).map(|i| Complex::new(x[a + i] as f64 * (0.5 - 0.5 * (2.0 * PI * i as f64 / n as f64).cos()), 0.0)).collect();
    FftPlanner::new().plan_fft_forward(n).process(&mut buf);
    let k = (1..n / 2).max_by(|&i, &j| buf[i].norm().total_cmp(&buf[j].norm())).unwrap();
    k as f64 * SR / n as f64
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[test]
fn identity_params_are_bit_exact_and_never_stretch() {
    let dir = tmp_dir("ident");
    let path = dir.join("a.wav");
    let mut x = sine(330.0, 1.0, 0.4);
    for (i, v) in x.iter_mut().enumerate() {
        *v += 0.2 * (((i * 7919) % 1000) as f32 / 1000.0 - 0.5);
    }
    write_wav(&path, &[x.clone(), x.clone()]);
    let len = ticks(1.5, 120.0);
    let cache = Arc::new(SampleCache::new());
    let (plain, _) = render_range(&clip_project(120.0, &path, json!({}), len), &cache, 0.0, len);
    // Identity spelled out: stretch 1, 0 st, formants, Follow tempo at the source tempo.
    let ident = json!({ "pitch": 0, "stretch": 1, "formant": 1, "tempo_sync": 1, "src_bpm": 120 });
    let (same, _) = render_range(&clip_project(120.0, &path, ident, len), &cache, 0.0, len);
    assert_eq!(plain.len(), same.len());
    assert!(plain.iter().zip(&same).all(|(a, b)| a.to_bits() == b.to_bits()), "identity params changed the output");
    assert!(cache.variants.is_empty(), "the stretcher must not run at identity");
    // ...and it is the sample itself: a constant gain (no SRC, no stretch).
    let g = plain[1000] / x[1000];
    for i in (1000..47000).step_by(997) {
        assert!((plain[i] - g * x[i]).abs() <= 1e-6, "frame {i}: {} vs {}", plain[i], g * x[i]);
    }
    assert!(seg(&plain, 1.01, 1.5).iter().all(|v| *v == 0.0), "sound past the sample end");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stretch_2x_doubles_duration_and_onset_times() {
    let dir = tmp_dir("s2x");
    let path = dir.join("b.wav");
    let at = [0.1, 0.6, 1.1, 1.6];
    write_wav(&path, &[bursts(2.0, &at)]);
    let cache = Arc::new(SampleCache::new());
    let len = ticks(5.0, 120.0);
    let (orig, _) = render_range(&clip_project(120.0, &path, json!({}), len), &cache, 0.0, len);
    let (y, logs) = render_range(&clip_project(120.0, &path, json!({ "stretch": 2 }), len), &cache, 0.0, len);
    assert!(logs.iter().any(|l| l.contains("Time-stretched")), "{logs:?}");
    let (lo, ly) = (last_sound(&orig, 1e-3), last_sound(&y, 1e-3));
    assert!(lo > 1.6 && lo < 2.0, "original ends at {lo}");
    assert!(ly > 3.2 && ly <= 4.0, "stretched ends at {ly}");
    for &t in &at {
        let co = centroid(&orig, t - 0.05, t + 0.25);
        let cy = centroid(&y, 2.0 * t - 0.1, 2.0 * t + 0.5);
        assert!((cy - 2.0 * co).abs() < 0.005, "burst at {t}: {cy:.4} vs 2 × {co:.4}");
    }
    // The clip's offset is song time: starting 1 s into the clip plays the variant from 1 s.
    let (mid, _) = render_range(&clip_project(120.0, &path, json!({ "stretch": 2 }), len), &cache, ticks(1.0, 120.0), len);
    let c = centroid(&mid, 0.1, 0.6); // the 0.6 s burst, stretched to 1.2 s → 0.2 s into this render
    assert!((c - (centroid(&y, 1.1, 1.6) - 1.0)).abs() < 0.002, "mid-clip start: {c}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn pitch_up_an_octave_doubles_the_frequency_not_the_duration() {
    let dir = tmp_dir("p12");
    let path = dir.join("s.wav");
    write_wav(&path, &[sine(440.0, 2.0, 0.5)]);
    let cache = Arc::new(SampleCache::new());
    let len = ticks(3.0, 120.0);
    let (y, _) = render_range(&clip_project(120.0, &path, json!({ "pitch": 12 }), len), &cache, 0.0, len);
    let f = peak_hz(&y, 0.5);
    assert!((f - 880.0).abs() < 4.0, "pitched peak {f}");
    let end = last_sound(&y, 1e-3);
    assert!((end - 2.0).abs() < 0.02, "duration changed: ends at {end}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn formant_flag_changes_the_output() {
    let dir = tmp_dir("fmt");
    let path = dir.join("v.wav");
    write_wav(&path, &[vowel(1.5)]);
    let cache = Arc::new(SampleCache::new());
    let len = ticks(1.5, 120.0);
    let (on, _) = render_range(&clip_project(120.0, &path, json!({ "pitch": 7, "formant": 1 }), len), &cache, 0.0, len);
    let (off, _) = render_range(&clip_project(120.0, &path, json!({ "pitch": 7, "formant": 0 }), len), &cache, 0.0, len);
    let diff: Vec<f32> = on.iter().zip(&off).map(|(a, b)| a - b).collect();
    assert!(rms(&diff) > 0.2 * rms(&off), "formant flag had no effect ({} vs {})", rms(&diff), rms(&off));
    assert_eq!(cache.variants.len(), 2, "on and off are distinct variants");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn tempo_sync_follows_the_project_tempo() {
    let dir = tmp_dir("sync");
    let path = dir.join("l.wav");
    write_wav(&path, &[bursts(2.0, &[0.0, 0.5, 1.0, 1.5])]);
    let cache = Arc::new(SampleCache::new());
    let params = json!({ "tempo_sync": 1, "src_bpm": 120 });
    let (orig, _) = render_range(&clip_project(120.0, &path, json!({}), ticks(2.5, 120.0)), &cache, 0.0, ticks(2.5, 120.0));
    // A 120 BPM loop in a 60 BPM project lasts twice as long: one beat is still one beat.
    let len = ticks(5.0, 60.0);
    let (y, _) = render_range(&clip_project(60.0, &path, params.clone(), len), &cache, 0.0, len);
    let orig_end = last_sound(&orig, 1e-3);
    let end = last_sound(&y, 1e-3);
    assert!((end - 2.0 * orig_end).abs() < 0.06, "60 BPM: ends at {end} (original {orig_end})");
    for k in 0..4 {
        let t = k as f64 * 0.5;
        let co = centroid(&orig, (t - 0.05).max(0.0), t + 0.25);
        let c = centroid(&y, (2.0 * t - 0.1).max(0.0), 2.0 * t + 0.5);
        assert!((c - 2.0 * co).abs() < 0.005, "beat {k}: {c:.4} vs 2 × {co:.4}");
    }
    // Tempo change → a new variant: 90 BPM gives 120/90 of the length.
    let len = ticks(5.0, 90.0);
    let (y, _) = render_range(&clip_project(90.0, &path, params.clone(), len), &cache, 0.0, len);
    let end = last_sound(&y, 1e-3);
    assert!((end - orig_end * 120.0 / 90.0).abs() < 0.06, "90 BPM: ends at {end} (original {orig_end})");
    assert_eq!(cache.variants.len(), 2);
    // Without a source BPM the tempo factor is ignored, with a warning.
    let (y, logs) = render_range(&clip_project(60.0, &path, json!({ "tempo_sync": 1 }), len), &cache, 0.0, len);
    assert!(last_sound(&y, 1e-3) < 2.0);
    assert!(logs.iter().any(|l| l.contains("Source BPM")), "{logs:?}");

    // Live: the compiler re-derives the variant when the tempo changes and cancels the stale job.
    let mut s = Session::new(clip_host(), 48000.0, Arc::new(SampleCache::new()), ".".into(), SampleMode::Sync);
    let (vtx, vrx) = crossbeam_channel::unbounded::<VariantJob>();
    s.variant_tx = Some(vtx);
    let mut w = Warnings::default();
    s.model = Model::from_project(&clip_project(60.0, &path, params, len), &mut w);
    let _ = s.build(true);
    let first = vrx.try_recv().expect("job at 60 BPM");
    assert!((first.key.ratio() - 2.0).abs() < 1e-9);
    s.model.transport.bpm = 90.0;
    let _ = s.build(false);
    let second = vrx.try_recv().expect("job at 90 BPM");
    assert!((second.key.ratio() - 120.0 / 90.0).abs() < 1e-8);
    assert!(first.cancel.load(std::sync::atomic::Ordering::Relaxed), "stale job cancelled");
    assert!(!second.cancel.load(std::sync::atomic::Ordering::Relaxed));
    assert!(matches!(variants::run_job(&s.cache.variants, &first), VariantOutcome::Cancelled));
    assert_eq!(s.stretch_pending, vec!["ca".to_string()]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn reverse_and_gain_work_with_stretch() {
    let dir = tmp_dir("rev");
    let path = dir.join("r.wav");
    write_wav(&path, &[bursts(1.0, &[0.1])]);
    let cache = Arc::new(SampleCache::new());
    let len = ticks(3.0, 120.0);
    let (y, _) = render_range(&clip_project(120.0, &path, json!({ "stretch": 2, "reverse": 1 }), len), &cache, 0.0, len);
    // Forward the burst sits at 0.2 s of the 2 s variant; reversed it ends 0.2 s before the end.
    let (fwd, _) = render_range(&clip_project(120.0, &path, json!({ "stretch": 2 }), len), &cache, 0.0, len);
    let cf = centroid(&fwd, 0.0, 2.0);
    let cr = centroid(&y, 0.0, 2.1);
    assert!((cr - (2.0 - cf)).abs() < 0.01, "reversed centroid {cr} vs {}", 2.0 - cf);
    assert!(rms(seg(&y, 0.0, 1.5)) < 1e-3, "reversed: silent until the burst");
    assert!(last_sound(&y, 1e-3) <= 2.0);
    assert_eq!(cache.variants.len(), 1, "reverse plays the same variant backwards");
    let (q, _) = render_range(&clip_project(120.0, &path, json!({ "stretch": 2, "reverse": 1, "gain": -6.0206 }), len), &cache, 0.0, len);
    let ratio = rms(&q) / rms(&y);
    assert!((ratio - 0.5).abs() < 0.01, "gain with stretch: {ratio}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn render_right_after_a_param_change_waits_for_the_variant() {
    let dir = tmp_dir("wait");
    let path = dir.join("w.wav");
    write_wav(&path, &[sine(220.0, 2.0, 0.5)]);
    let cache = Arc::new(SampleCache::new());
    let len = ticks(5.0, 120.0);
    // The live session queues the variant on a worker that has not run yet...
    let mut s = Session::new(clip_host(), 48000.0, cache.clone(), ".".into(), SampleMode::Sync);
    let (vtx, _vrx) = crossbeam_channel::unbounded::<VariantJob>();
    s.variant_tx = Some(vtx);
    let mut w = Warnings::default();
    s.model = Model::from_project(&clip_project(120.0, &path, json!({ "stretch": 2 }), len), &mut w);
    let b = s.build(true);
    assert_eq!(s.stretch_pending, vec!["ca".to_string()], "live: still rendering");
    assert!(b.instruments.iter().all(|(_, i)| i.is_some()), "instance exists (silent) while it renders");
    assert!(cache.variants.is_empty());
    // ...but a render of that same model renders the variant first: stretched, not silent, not original.
    let model = s.model.clone();
    let mut progress = |_p: f64| {};
    let mut log = |_l: &str, _m: String| {};
    let req = RenderRequest {
        path: String::new(),
        scope: RenderScope::Range { start_tick: 0.0, end_tick: len },
        format: "wav32f".into(),
        sample_rate: Some(SR),
        tail_sec: Some(0.0),
        analyze: None,
        stems: None,
        stem_inserts: None,
        loops: None,
        normalize: None,
        mp3_kbps: None,
    };
    let mut env = RenderEnv {
        host: clip_host(),
        cache: cache.clone(),
        factory_dir: ".".into(),
        packs_dir: None,
        base_dir: None,
        cancel: Arc::new(AtomicBool::new(false)),
        default_sr: SR,
        progress: &mut progress,
        log: &mut log,
    };
    let out = render_audio(&model, &req, &mut env).expect("render");
    let y = out.left;
    assert!(rms(seg(&y, 0.05, 0.5)) > 0.2, "silence at the start of the render");
    let end = last_sound(&y, 1e-3);
    assert!(end > 3.9 && end <= 4.0, "render holds the 2× variant (ends at {end})");
    assert_eq!(cache.variants.len(), 1, "and leaves it cached for the live engine");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Live core + Session with a (manually driven) variant worker.
struct LiveClip {
    core: Core,
    tx: rtrb::Producer<Cmd>,
    grx: rtrb::Consumer<Garbage>,
    session: Session,
    jobs: crossbeam_channel::Receiver<VariantJob>,
}

impl LiveClip {
    fn new(p: &Value, cache: Arc<SampleCache>) -> Self {
        let shared = Arc::new(Shared::new());
        let (tx, rx) = rtrb::RingBuffer::new(64);
        let (gtx, grx) = rtrb::RingBuffer::new(1024);
        let core = Core::new(48000.0, shared, Some(rx), Some(gtx), None);
        let mut session = Session::new(clip_host(), 48000.0, cache, ".".into(), SampleMode::Sync);
        let (vtx, jobs) = crossbeam_channel::unbounded::<VariantJob>();
        session.variant_tx = Some(vtx);
        let mut w = Warnings::default();
        session.model = Model::from_project(p, &mut w);
        session.version = 1;
        let mut l = Self { core, tx, grx, session, jobs };
        l.rebuild(true);
        l
    }
    fn rebuild(&mut self, reset: bool) -> (usize, Vec<u32>) {
        self.session.version += 1;
        let b = self.session.build(reset);
        let r = (b.instruments.len(), b.rechase.clone());
        assert!(self.tx.push(Cmd::Batch(b)).is_ok());
        r
    }
    fn set_params(&mut self, params: Value) {
        let ch = self.session.model.channels.get_mut("ca").unwrap();
        ch.generator.params.clear();
        for (k, v) in params.as_object().unwrap() {
            ch.generator.params.insert(k.clone(), v.as_f64().unwrap());
        }
    }
    /// Run the queued variant jobs like the workers do.
    fn finish_jobs(&mut self) {
        while let Ok(job) = self.jobs.try_recv() {
            let _ = variants::run_job(&self.session.cache.variants, &job);
            self.session.variant_done(&job.key);
        }
    }
    /// Process `frames` (in 480-frame device blocks) on the "audio thread"; left channel.
    fn run(&mut self, frames: usize) -> Vec<f32> {
        let mut buf = vec![0f32; frames * 2];
        let mut done = 0;
        while done < frames {
            let n = 480.min(frames - done);
            let core = &mut self.core;
            let b = &mut buf[done * 2..(done + n) * 2];
            crate::rt::no_alloc(|| core.process_interleaved(b, 2));
            done += n;
        }
        while let Ok(g) = self.grx.pop() {
            drop(g);
        }
        buf.chunks(2).map(|c| c[0]).collect()
    }
    fn tick(&self) -> f64 {
        f64::from_bits(self.core.shared.tick.load(std::sync::atomic::Ordering::Relaxed))
    }
}

#[test]
fn live_variant_swaps_in_mid_clip_without_allocating() {
    let dir = tmp_dir("live");
    let path = dir.join("m.wav");
    let x: Vec<f32> = (0..(4.0 * SR) as usize).map(|i| (0.5 * (2.0 * PI * 200.0 * i as f64 / SR).sin() * (1.0 + 0.3 * (i as f64 / SR * 3.0).sin())) as f32).collect();
    write_wav(&path, &[x]);
    let cache = Arc::new(SampleCache::new());
    let len = ticks(8.0, 120.0);
    let p = clip_project(120.0, &path, json!({}), len);
    #[cfg(debug_assertions)]
    let before = assert_no_alloc::violation_count();
    let mut live = LiveClip::new(&p, cache.clone());
    live.tx.push(Cmd::Play).ok();
    let a = live.run(24000);
    assert!(rms(&a[2400..]) > 0.2, "identity plays at once");

    // Pitch only (same timing): the original keeps playing while the variant renders.
    live.set_params(json!({ "pitch": 5 }));
    let (insts, _) = live.rebuild(false);
    assert_eq!(insts, 0, "instance kept while only the pitch changes");
    assert_eq!(live.session.stretch_pending, vec!["ca".to_string()]);
    let b = live.run(4800);
    assert!(rms(&b) > 0.2, "keeps playing the previous pitch");

    // New timing: silence until it is ready (never audio at the wrong tempo).
    live.set_params(json!({ "pitch": 5, "stretch": 1.5 }));
    let (insts, _) = live.rebuild(false);
    assert_eq!(insts, 1, "re-created without audio");
    let c = live.run(4800);
    assert!(rms(&c[480..]) < 1e-4, "silent while the new timing renders: {}", rms(&c[480..]));

    // The worker finishes → rebuild installs the variant and resumes mid-clip at once.
    live.finish_jobs();
    let (insts, rechase) = live.rebuild(false);
    assert_eq!((insts, rechase.len()), (1, 1));
    assert!(live.session.stretch_pending.is_empty());
    let at = live.tick();
    let d = live.run(9600);
    assert!(rms(&d[480..]) > 0.15, "variant resumes mid-clip: {}", rms(&d[480..]));
    // ...in sync with an offline render of the same song position.
    let p2 = clip_project(120.0, &path, json!({ "pitch": 5, "stretch": 1.5 }), len);
    let (off, _) = render_range(&p2, &cache, at, at + ticks(0.2, 120.0));
    let (u, v) = (&d[960..8640], &off[960..8640]);
    let dot: f64 = u.iter().zip(v).map(|(a, b)| *a as f64 * *b as f64).sum();
    let corr = dot / (rms(u) * rms(v) * u.len() as f64);
    assert!(corr > 0.95, "live vs offline correlation {corr}");
    live.tx.push(Cmd::Stop).ok();
    live.run(480);
    #[cfg(debug_assertions)]
    assert_eq!(assert_no_alloc::violation_count(), before, "the audio path allocated");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn failed_variants_warn_and_stay_silent() {
    let dir = tmp_dir("fail");
    let path = dir.join("long.wav");
    // 113 s × the 16× maximum ratio is past the 30-minute variant limit: refused, visibly.
    let spec = hound::WavSpec { channels: 1, sample_rate: 8000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut wr = hound::WavWriter::create(&path, spec).unwrap();
    for i in 0..113 * 8000 {
        wr.write_sample(((i as f32 * 0.1).sin() * 8000.0) as i16).unwrap();
    }
    wr.finalize().unwrap();
    let cache = Arc::new(SampleCache::new());
    let len = ticks(1.0, 10.0);
    let p = clip_project(10.0, &path, json!({ "stretch": 4, "tempo_sync": 1, "src_bpm": 999 }), len);
    let (y, logs) = render_range(&p, &cache, 0.0, len);
    assert!(logs.iter().any(|l| l.contains("longer than 30 minutes") && l.contains("silent")), "{logs:?}");
    assert!(y.iter().all(|v| *v == 0.0), "a failed variant must not play the unstretched sample");
    let _ = std::fs::remove_dir_all(&dir);
}

// Warp markers + warp modes (warp.rs), reusing the fixtures above.
#[path = "tests_warp.rs"]
mod warp;
