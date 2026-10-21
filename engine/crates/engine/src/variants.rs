//! Time-stretched / pitch-shifted copies ("variants") of samples for
//! `krypt.audioclip` channels (docs/ENGINE_PROTOCOL.md §4, audio clips).
//!
//! A variant is rendered OFF the audio thread (Signalsmith Stretch via
//! krypt-studio-stretch) — by the variant workers for the live engine, inline
//! for offline renders — and reaches the instrument like any sample: as an
//! `Arc<SampleData>` given to `set_sample` when the compiler (re)creates the
//! instance. The audio thread only ever plays plain buffers.
//!
//! The cache is keyed by sample identity (resolved path + file mtime), the
//! time ratio (quantized to 1e-9), the pitch (quantized to 0.001 st), the
//! formant flag and the clip's warp map (warp.rs: mode, markers, mode
//! settings and, when they matter, the project tempo). It is LRU-bounded by `cap` bytes: entries that an instrument
//! still holds or that the live project currently wants are never evicted
//! (correctness over the cap; going over is logged once).

use crate::model_ext::WarpMap;
use crate::warp::{self, WarpKey};
use krypt_studio_dsp::SampleData;
use krypt_studio_stretch::{output_frames, stretch_planar, StretchError, StretchSettings, MAX_RATIO, MIN_RATIO};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

/// Ratio quantum (1e-9: no audible drift even over 30 min of audio).
const RATIO_SCALE: f64 = 1e9;
/// Pitch quantum: 0.001 semitone (0.1 cent).
const SEMI_SCALE: f64 = 1000.0;
/// Default memory cap for cached variants (bytes of f32 sample data).
pub const DEFAULT_CAP_BYTES: usize = 1 << 30;
/// Longest variant we render (same limit as decoded samples).
pub const MAX_VARIANT_SECONDS: f64 = 30.0 * 60.0;
/// Failure entries kept (cleared wholesale beyond this).
const MAX_FAILED: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VariantKey {
    pub path: PathBuf,
    pub mtime: Option<SystemTime>,
    ratio_q: i64,
    semis_q: i32,
    formant: bool,
    /// Warp markers / mode (None = the plain Signalsmith stretch path).
    warp: Option<Arc<WarpKey>>,
}

/// What a variant's timing is: (quantized Stretch ratio, warp marker hash or 0).
pub type Timing = (i64, u64);

impl VariantKey {
    /// Quantizes; the formant flag only matters when pitched. Ratios are
    /// clamped to the stretcher's range.
    pub fn new(path: &Path, mtime: Option<SystemTime>, ratio: f64, semitones: f64, keep_formants: bool) -> Self {
        let ratio = if ratio.is_finite() { ratio.clamp(MIN_RATIO, MAX_RATIO) } else { 1.0 };
        let semitones = if semitones.is_finite() { semitones.clamp(-48.0, 48.0) } else { 0.0 };
        let ratio_q = (ratio * RATIO_SCALE).round() as i64;
        let semis_q = (semitones * SEMI_SCALE).round() as i32;
        Self { path: path.to_path_buf(), mtime, ratio_q, semis_q, formant: keep_formants && semis_q != 0, warp: None }
    }
    /// The key for a clip with an optional warp map at the project tempo
    /// (warp::resolve), plus a warning if the map was unusable. Normalized so
    /// that 'complex' without markers, and any mode without markers at ratio
    /// 1 and 0 st, is exactly the un-warped key (bit-identical playback).
    #[allow(clippy::too_many_arguments)]
    pub fn warped(path: &Path, mtime: Option<SystemTime>, ratio: f64, semitones: f64, keep_formants: bool, map: Option<&WarpMap>, bpm: f64) -> (Self, Option<String>) {
        let r = warp::resolve(map, ratio, semitones, bpm);
        let mut key = Self::new(path, mtime, r.ratio, r.semitones, keep_formants);
        if let Some(w) = r.warp {
            let plain = w.marker_count() == 0 && (w.mode == warp::Mode::Complex || (key.ratio_q == RATIO_SCALE as i64 && key.semis_q == 0));
            if !plain {
                key.warp = Some(Arc::new(w));
            }
        }
        (key, r.warning)
    }
    pub fn warp(&self) -> Option<&WarpKey> {
        self.warp.as_deref()
    }
    pub fn ratio(&self) -> f64 {
        self.ratio_q as f64 / RATIO_SCALE
    }
    pub fn semitones(&self) -> f64 {
        self.semis_q as f64 / SEMI_SCALE
    }
    pub fn keep_formants(&self) -> bool {
        self.formant
    }
    /// Equal values = identical timing (pitch / formants / warp mode may differ).
    pub fn timing(&self) -> Timing {
        (self.ratio_q, self.warp.as_ref().map_or(0, |w| w.timing_hash()))
    }
    pub fn is_identity(&self) -> bool {
        self.ratio_q == RATIO_SCALE as i64 && self.semis_q == 0 && self.warp.is_none()
    }
    /// "drums.wav ×1.2500 +3.00 st (formants kept)"
    pub fn describe(&self) -> String {
        let name = self.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| self.path.display().to_string());
        let mut s = format!("'{name}' ×{:.4}", self.ratio());
        if self.semis_q != 0 {
            s.push_str(&format!(" {:+.2} st{}", self.semitones(), if self.formant { " (formants kept)" } else { "" }));
        }
        if let Some(w) = &self.warp {
            s.push_str(&format!(" ({})", w.describe()));
        }
        s
    }
}

/// Timing of the original sample (ratio 1, no warp markers).
pub const IDENTITY_TIMING: Timing = (RATIO_SCALE as i64, 0);

pub enum VLookup {
    Hit(Arc<SampleData>),
    Failed(String),
    Miss,
}

enum Entry {
    Ready { data: Arc<SampleData>, bytes: usize, used: u64, pinned: bool },
    Failed(String),
}

#[derive(Default)]
struct Inner {
    map: HashMap<VariantKey, Entry>,
    bytes: usize,
    clock: u64,
    failed: usize,
    over_cap_logged: bool,
    logs: Vec<(&'static str, String)>,
}

/// LRU cache of rendered variants, shared by the control thread, the variant
/// workers and render threads (lives inside `SampleCache`).
pub struct VariantCache {
    inner: Mutex<Inner>,
    cap: AtomicUsize,
}

impl Default for VariantCache {
    fn default() -> Self {
        Self { inner: Mutex::new(Inner::default()), cap: AtomicUsize::new(DEFAULT_CAP_BYTES) }
    }
}

fn data_bytes(d: &SampleData) -> usize {
    d.channels.iter().map(|c| c.len() * std::mem::size_of::<f32>()).sum()
}

impl VariantCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn lookup(&self, key: &VariantKey) -> VLookup {
        let mut g = self.lock();
        g.clock += 1;
        let now = g.clock;
        match g.map.get_mut(key) {
            Some(Entry::Ready { data, used, .. }) => {
                *used = now;
                VLookup::Hit(data.clone())
            }
            Some(Entry::Failed(e)) => VLookup::Failed(e.clone()),
            None => VLookup::Miss,
        }
    }

    /// Store a rendered variant (`pinned`: the live project wants it right now).
    pub fn insert(&self, key: VariantKey, data: Arc<SampleData>, pinned: bool) {
        let bytes = data_bytes(&data);
        let cap = self.cap.load(Ordering::Relaxed);
        let mut g = self.lock();
        g.clock += 1;
        let used = g.clock;
        if let Some(Entry::Ready { bytes: b, .. }) = g.map.insert(key, Entry::Ready { data, bytes, used, pinned }) {
            g.bytes -= b;
        }
        g.bytes += bytes;
        Self::evict(&mut g, cap);
    }

    pub fn insert_failed(&self, key: VariantKey, msg: String) {
        let mut g = self.lock();
        if g.failed >= MAX_FAILED {
            g.map.retain(|_, e| matches!(e, Entry::Ready { .. }));
            g.failed = 0;
        }
        if let Some(Entry::Ready { bytes, .. }) = g.map.insert(key, Entry::Failed(msg)) {
            g.bytes -= bytes;
        }
        g.failed += 1;
    }

    /// The live project's current set of wanted variants: these are never
    /// evicted (a variant rendered but not yet installed must survive).
    pub fn set_pins(&self, wanted: &HashSet<VariantKey>) {
        let cap = self.cap.load(Ordering::Relaxed);
        let mut g = self.lock();
        for (k, e) in g.map.iter_mut() {
            if let Entry::Ready { pinned, .. } = e {
                *pinned = wanted.contains(k);
            }
        }
        Self::evict(&mut g, cap);
    }

    /// Re-apply the cap (periodic prune).
    pub fn trim(&self) {
        let cap = self.cap.load(Ordering::Relaxed);
        Self::evict(&mut self.lock(), cap);
    }

    pub fn set_cap(&self, bytes: usize) {
        self.cap.store(bytes, Ordering::Relaxed);
        self.trim();
    }

    pub fn bytes(&self) -> usize {
        self.lock().bytes
    }

    pub fn len(&self) -> usize {
        self.lock().map.values().filter(|e| matches!(e, Entry::Ready { .. })).count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Log lines produced by evictions (drained by whoever can emit logs).
    pub fn drain_logs(&self) -> Vec<(&'static str, String)> {
        std::mem::take(&mut self.lock().logs)
    }

    fn evict(g: &mut Inner, cap: usize) {
        while g.bytes > cap {
            // Least recently used entry nobody holds and the project doesn't want.
            let victim = g
                .map
                .iter()
                .filter_map(|(k, e)| match e {
                    Entry::Ready { data, used, pinned, .. } if !*pinned && Arc::strong_count(data) == 1 => Some((*used, k)),
                    _ => None,
                })
                .min_by_key(|(u, _)| *u)
                .map(|(_, k)| k.clone());
            let Some(k) = victim else {
                if !g.over_cap_logged {
                    g.over_cap_logged = true;
                    let msg = format!(
                        "Stretched audio in use needs {} MB, over the {} MB stretch cache; keeping it (nothing unused to evict)",
                        g.bytes >> 20,
                        cap >> 20
                    );
                    g.logs.push(("warn", msg));
                }
                return;
            };
            if let Some(Entry::Ready { bytes, .. }) = g.map.remove(&k) {
                g.bytes -= bytes;
                let msg = format!("Stretch cache: evicted {} ({} MB; cache {} MB of {} MB)", k.describe(), bytes >> 20, g.bytes >> 20, cap >> 20);
                g.logs.push(("info", msg));
            }
        }
        g.over_cap_logged = false;
    }
}

/// Render a variant of `src` (blocking: worker / render threads only).
/// The result has `src`'s sample rate and root key and exactly
/// `round(frames × ratio)` frames (warped: the time map's end, warp.rs).
pub fn compute(src: &SampleData, key: &VariantKey, cancel: &AtomicBool) -> Result<SampleData, StretchError> {
    let sr = src.sample_rate as f64;
    let frames = src.channels.iter().take(2).map(|c| c.len()).min().unwrap_or(0);
    if let Some(w) = &key.warp {
        let chans: Vec<&[f32]> = src.channels.iter().take(2).map(|c| &c[..frames]).collect();
        let channels = warp::render(&chans, sr, key.ratio(), key.semitones(), key.keep_formants(), w, MAX_VARIANT_SECONDS, cancel)?;
        return Ok(SampleData { sample_rate: src.sample_rate, channels, root_key: src.root_key });
    }
    if output_frames(frames, key.ratio()) as f64 > MAX_VARIANT_SECONDS * sr.max(1.0) {
        return Err(StretchError::Failed(format!(
            "the result would be longer than {} minutes; shorten the sample or lower the stretch",
            MAX_VARIANT_SECONDS / 60.0
        )));
    }
    let chans: Vec<&[f32]> = src.channels.iter().take(2).map(|c| &c[..frames]).collect();
    let settings = StretchSettings { time_ratio: key.ratio(), semitones: key.semitones(), keep_formants: key.keep_formants() };
    let channels = stretch_planar(&chans, sr, &settings, cancel)?;
    Ok(SampleData { sample_rate: src.sample_rate, channels, root_key: src.root_key })
}

/// A job for the live variant workers.
pub struct VariantJob {
    pub key: VariantKey,
    pub source: Arc<SampleData>,
    pub cancel: Arc<AtomicBool>,
}

/// Outcome reported back to the control thread.
pub enum VariantOutcome {
    /// Rendered and cached (seconds of compute).
    Ready(f64),
    Failed(String),
    Cancelled,
}

/// Run one job: render, cache, report. Never panics.
pub fn run_job(cache: &VariantCache, job: &VariantJob) -> VariantOutcome {
    if job.cancel.load(Ordering::Relaxed) {
        return VariantOutcome::Cancelled;
    }
    if let VLookup::Hit(_) = cache.lookup(&job.key) {
        return VariantOutcome::Ready(0.0);
    }
    let t0 = std::time::Instant::now();
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| compute(&job.source, &job.key, &job.cancel)));
    match res {
        Ok(Ok(d)) => {
            cache.insert(job.key.clone(), Arc::new(d), true);
            VariantOutcome::Ready(t0.elapsed().as_secs_f64())
        }
        Ok(Err(StretchError::Cancelled)) => VariantOutcome::Cancelled,
        Ok(Err(StretchError::Failed(m))) => {
            let msg = format!("Could not time-stretch {}: {m}", job.key.describe());
            cache.insert_failed(job.key.clone(), msg.clone());
            VariantOutcome::Failed(msg)
        }
        Err(_) => {
            let msg = format!("Time-stretch crashed on {}", job.key.describe());
            cache.insert_failed(job.key.clone(), msg.clone());
            VariantOutcome::Failed(msg)
        }
    }
}

/// Render several variants in parallel, blocking until all are cached
/// (offline renders: correctness over speed) or `cancel` is raised.
/// Returns failures.
pub fn compute_all(cache: &VariantCache, jobs: Vec<(VariantKey, Arc<SampleData>)>, cancel: &Arc<AtomicBool>) -> Vec<String> {
    if jobs.is_empty() {
        return Vec::new();
    }
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(1, 8).min(jobs.len());
    let queue = Mutex::new(jobs);
    let failures = Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let next = queue.lock().unwrap_or_else(|e| e.into_inner()).pop();
                let Some((key, source)) = next else { break };
                let job = VariantJob { key, source, cancel: cancel.clone() };
                if let VariantOutcome::Failed(m) = run_job(cache, &job) {
                    failures.lock().unwrap_or_else(|e| e.into_inner()).push(m);
                }
            });
        }
    });
    failures.into_inner().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sd(frames: usize) -> SampleData {
        SampleData { sample_rate: 48000.0, channels: vec![(0..frames).map(|i| ((i as f32) * 0.05).sin() * 0.5).collect()], root_key: Some(60) }
    }

    fn key(r: f64) -> VariantKey {
        VariantKey::new(Path::new("C:/x/a.wav"), None, r, 0.0, true)
    }

    #[test]
    fn keys_quantize_and_normalize() {
        let a = VariantKey::new(Path::new("a.wav"), None, 120.0 / 140.0, 0.0, true);
        let b = VariantKey::new(Path::new("a.wav"), None, 0.857_142_857_142_9, 0.0, false);
        assert_eq!(a, b, "formant flag is irrelevant without pitch; ratio quantized");
        assert!(VariantKey::new(Path::new("a.wav"), None, 1.0, 0.0, true).is_identity());
        assert!(VariantKey::new(Path::new("a.wav"), None, 1.0, 0.0004, true).is_identity(), "below the 0.001 st quantum");
        assert!(!VariantKey::new(Path::new("a.wav"), None, 1.0 + 1e-6, 0.0, true).is_identity());
        let p = VariantKey::new(Path::new("a.wav"), None, 1.0, 3.0, true);
        assert!(p.keep_formants() && !p.is_identity() && p.timing() == IDENTITY_TIMING);
        assert_eq!(VariantKey::new(Path::new("a.wav"), None, 100.0, 0.0, true).ratio(), MAX_RATIO);
    }

    #[test]
    fn lru_eviction_respects_pins_and_holders() {
        let c = VariantCache::default();
        let d = Arc::new(sd(1000)); // 4000 bytes
        c.set_cap(10_000);
        c.insert(key(1.1), d.clone(), false);
        drop(d);
        c.insert(key(1.2), Arc::new(sd(1000)), true);
        let held = match c.lookup(&key(1.1)) {
            VLookup::Hit(h) => h,
            _ => panic!(),
        };
        // 3 × 4000 > 10_000: 1.1 and 1.3 are held, 1.2 pinned → nothing evictable yet.
        let held3 = Arc::new(sd(1000));
        c.insert(key(1.3), held3.clone(), false);
        assert_eq!(c.len(), 3);
        assert!(c.drain_logs().iter().any(|(l, m)| *l == "warn" && m.contains("over the")));
        drop(held);
        c.trim();
        assert!(matches!(c.lookup(&key(1.1)), VLookup::Miss), "unheld LRU entry evicted");
        assert!(matches!(c.lookup(&key(1.2)), VLookup::Hit(_)));
        assert!(c.drain_logs().iter().any(|(l, m)| *l == "info" && m.contains("evicted")));
        // Unpin 1.2, release 1.3 and touch it: 1.2 is now the LRU victim.
        drop(held3);
        c.set_pins(&HashSet::new());
        let _ = c.lookup(&key(1.3));
        c.insert(key(1.4), Arc::new(sd(1000)), false);
        assert!(matches!(c.lookup(&key(1.2)), VLookup::Miss));
        assert!(matches!(c.lookup(&key(1.3)), VLookup::Hit(_)));
        assert!(c.bytes() <= 10_000);
    }

    #[test]
    fn compute_keeps_rate_root_and_exact_length() {
        let src = sd(4801);
        let k = VariantKey::new(Path::new("a.wav"), None, 1.5, 2.0, true);
        let v = compute(&src, &k, &AtomicBool::new(false)).unwrap();
        assert_eq!(v.sample_rate, 48000.0);
        assert_eq!(v.root_key, Some(60));
        assert_eq!(v.frames(), output_frames(4801, 1.5));
        let c = VariantCache::default();
        let jobs = || vec![(k.clone(), Arc::new(sd(4801))), (key(0.75), Arc::new(sd(9600)))];
        let stop = Arc::new(AtomicBool::new(true));
        assert!(compute_all(&c, jobs(), &stop).is_empty(), "cancelled jobs are not failures");
        assert_eq!(c.len(), 0, "and cache nothing");
        let fails = compute_all(&c, jobs(), &Arc::new(AtomicBool::new(false)));
        assert!(fails.is_empty());
        assert_eq!(c.len(), 2);
    }
}
