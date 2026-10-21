//! Spectral building blocks shared by analysis and transcription: STFT,
//! log-band spectrogram, spectral-flux onset envelopes, autocorrelation,
//! peak picking. Krypt-original DSP (textbook methods; no GPL sources).

use std::sync::Arc;

use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};

use crate::{JobCtx, JobError};

/// Power spectrogram, frames × bins (row-major), centred frames:
/// frame `t` is centred on sample `t·hop`.
pub struct Spectrogram {
    pub n_fft: usize,
    pub hop: usize,
    pub sr: f32,
    pub frames: usize,
    pub bins: usize,
    pub power: Vec<f32>,
}

impl Spectrogram {
    #[inline]
    pub fn frame(&self, t: usize) -> &[f32] {
        &self.power[t * self.bins..(t + 1) * self.bins]
    }

    pub fn fps(&self) -> f32 {
        self.sr / self.hop as f32
    }

    pub fn bin_hz(&self) -> f32 {
        self.sr / self.n_fft as f32
    }
}

pub fn hann(n: usize) -> Vec<f32> {
    (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos()).collect()
}

/// STFT power spectrogram (Hann). Two real frames share one complex FFT.
/// `max_bin` limits the stored bins (inclusive upper bound, ≤ n_fft/2).
/// Checks for cancellation every few hundred frames.
pub fn power_spectrogram(x: &[f32], sr: f32, n_fft: usize, hop: usize, max_bin: usize, ctx: &JobCtx) -> Result<Spectrogram, JobError> {
    let bins = max_bin.min(n_fft / 2) + 1;
    let frames = if x.is_empty() { 0 } else { x.len() / hop + 1 };
    let mut power = vec![0f32; frames * bins];
    let win = hann(n_fft);
    let fft: Arc<dyn Fft<f32>> = FftPlanner::new().plan_fft_forward(n_fft);
    let mut buf = vec![Complex32::new(0.0, 0.0); n_fft];
    let mut scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];
    let half = (n_fft / 2) as i64;
    let len = x.len() as i64;
    let fill = |t: usize, out: &mut dyn FnMut(usize, f32)| {
        let start = t as i64 * hop as i64 - half;
        for (j, w) in win.iter().enumerate() {
            let k = start + j as i64;
            let v = if k >= 0 && k < len { x[k as usize] } else { 0.0 };
            out(j, v * w);
        }
    };
    let mut t = 0;
    while t < frames {
        if t % 512 == 0 {
            ctx.check()?;
        }
        let pair = t + 1 < frames;
        fill(t, &mut |j, v| buf[j] = Complex32::new(v, 0.0));
        if pair {
            fill(t + 1, &mut |j, v| buf[j].im = v);
        }
        fft.process_with_scratch(&mut buf, &mut scratch);
        for k in 0..bins {
            let z = buf[k];
            let zc = buf[(n_fft - k) % n_fft].conj();
            // X1 = (Z + conj(Z[N-k]))/2, X2 = (Z - conj(Z[N-k]))/(2i)
            let x1 = (z + zc) * 0.5;
            power[t * bins + k] = x1.norm_sqr();
            if pair {
                let d = (z - zc) * 0.5;
                let x2 = Complex32::new(d.im, -d.re);
                power[(t + 1) * bins + k] = x2.norm_sqr();
            }
        }
        t += if pair { 2 } else { 1 };
    }
    Ok(Spectrogram { n_fft, hop, sr, frames, bins, power })
}

/// Log-spaced band filterbank over a spectrogram (rectangular bands, at least
/// one bin wide). Returns band edges as bin ranges and centre frequencies.
pub struct Bands {
    pub ranges: Vec<(usize, usize)>,
    pub centers_hz: Vec<f32>,
}

pub fn log_bands(spec: &Spectrogram, lo_hz: f32, hi_hz: f32, n: usize) -> Bands {
    let bin_hz = spec.bin_hz();
    let mut ranges = Vec::new();
    let mut centers = Vec::new();
    let mut prev_hi = ((lo_hz / bin_hz).floor() as usize).max(1);
    for b in 0..n {
        let f_hi = lo_hz * (hi_hz / lo_hz).powf((b + 1) as f32 / n as f32);
        let hi = ((f_hi / bin_hz).round() as usize).min(spec.bins - 1).max(prev_hi + 1);
        if prev_hi >= spec.bins - 1 {
            break;
        }
        let hi = hi.min(spec.bins);
        if hi <= prev_hi {
            continue;
        }
        centers.push(((prev_hi + hi) as f32 * 0.5) * bin_hz);
        ranges.push((prev_hi, hi));
        prev_hi = hi;
    }
    Bands { ranges, centers_hz: centers }
}

/// Dynamic range kept in the band spectrogram. Bins near the floor would
/// otherwise turn noise-floor flicker into large dB "rises".
pub const BAND_DB_RANGE: f32 = 55.0;

/// Band energies in dB (frames × bands), floored at (global max − [`BAND_DB_RANGE`]).
pub fn band_db(spec: &Spectrogram, bands: &Bands) -> Vec<Vec<f32>> {
    let mut out = vec![vec![0f32; bands.ranges.len()]; spec.frames];
    let mut gmax = f32::MIN;
    for (t, row) in out.iter_mut().enumerate() {
        let f = spec.frame(t);
        for (b, &(lo, hi)) in bands.ranges.iter().enumerate() {
            let e: f32 = f[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
            let db = 10.0 * (e + 1e-12).log10();
            row[b] = db;
            gmax = gmax.max(db);
        }
    }
    let floor = gmax - BAND_DB_RANGE;
    for row in out.iter_mut() {
        for v in row.iter_mut() {
            *v = v.max(floor);
        }
    }
    out
}

/// Half-wave-rectified spectral flux over the bands whose centres lie in
/// [lo_hz, hi_hz), averaged over those bands (one value per frame).
pub fn flux(db: &[Vec<f32>], bands: &Bands, lo_hz: f32, hi_hz: f32) -> Vec<f32> {
    let sel: Vec<usize> = (0..bands.ranges.len()).filter(|&b| bands.centers_hz[b] >= lo_hz && bands.centers_hz[b] < hi_hz).collect();
    let mut out = vec![0f32; db.len()];
    if sel.is_empty() {
        return out;
    }
    for t in 1..db.len() {
        let mut s = 0.0;
        for &b in &sel {
            s += (db[t][b] - db[t - 1][b]).max(0.0);
        }
        out[t] = s / sel.len() as f32;
    }
    out
}

/// Moving average (centred, window `w` frames).
pub fn moving_average(x: &[f32], w: usize) -> Vec<f32> {
    let n = x.len();
    if n == 0 {
        return Vec::new();
    }
    let h = (w / 2).max(1);
    let mut pre = vec![0f64; n + 1];
    for i in 0..n {
        pre[i + 1] = pre[i] + x[i] as f64;
    }
    (0..n)
        .map(|i| {
            let a = i.saturating_sub(h);
            let b = (i + h + 1).min(n);
            ((pre[b] - pre[a]) / (b - a) as f64) as f32
        })
        .collect()
}

pub fn mean(x: &[f32]) -> f32 {
    if x.is_empty() {
        0.0
    } else {
        x.iter().sum::<f32>() / x.len() as f32
    }
}

pub fn std_dev(x: &[f32]) -> f32 {
    if x.len() < 2 {
        return 0.0;
    }
    let m = mean(x);
    (x.iter().map(|v| (v - m) * (v - m)).sum::<f32>() / x.len() as f32).sqrt()
}

pub fn median(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    let mut v: Vec<f32> = x.iter().copied().filter(|v| v.is_finite()).collect();
    if v.is_empty() {
        return 0.0;
    }
    let k = v.len() / 2;
    v.select_nth_unstable_by(k, |a, b| a.total_cmp(b));
    v[k]
}

pub fn percentile(x: &[f32], p: f32) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    let mut v: Vec<f32> = x.iter().copied().filter(|v| v.is_finite()).collect();
    if v.is_empty() {
        return 0.0;
    }
    let k = ((p.clamp(0.0, 1.0) * (v.len() - 1) as f32).round() as usize).min(v.len() - 1);
    v.select_nth_unstable_by(k, |a, b| a.total_cmp(b));
    v[k]
}

/// Linear-interpolated sample of `x` at fractional index `i`.
pub fn lerp_at(x: &[f32], i: f32) -> f32 {
    if x.is_empty() || !i.is_finite() || i < 0.0 {
        return 0.0;
    }
    let i0 = i.floor() as usize;
    if i0 + 1 >= x.len() {
        return *x.last().unwrap_or(&0.0);
    }
    let f = i - i0 as f32;
    x[i0] * (1.0 - f) + x[i0 + 1] * f
}

/// Autocorrelation of `x` (mean removed) for lags 0..=max_lag, via FFT.
pub fn autocorr(x: &[f32], max_lag: usize) -> Vec<f32> {
    let n = x.len();
    if n == 0 {
        return vec![0.0; max_lag + 1];
    }
    let m = mean(x);
    let size = (2 * n).next_power_of_two();
    let mut buf: Vec<Complex32> = (0..size).map(|i| Complex32::new(if i < n { x[i] - m } else { 0.0 }, 0.0)).collect();
    let mut planner = FftPlanner::new();
    planner.plan_fft_forward(size).process(&mut buf);
    for z in buf.iter_mut() {
        *z = Complex32::new(z.norm_sqr(), 0.0);
    }
    planner.plan_fft_inverse(size).process(&mut buf);
    let scale = 1.0 / size as f32;
    (0..=max_lag).map(|l| if l < n { buf[l].re * scale } else { 0.0 }).collect()
}

/// Indices of local maxima of `x` that exceed `thresh[i]` and are at least
/// `min_dist` apart (stronger peaks win).
pub fn pick_peaks(x: &[f32], thresh: &[f32], min_dist: usize) -> Vec<usize> {
    let n = x.len();
    let mut cand: Vec<usize> = (1..n.saturating_sub(1)).filter(|&i| x[i] > thresh[i] && x[i] >= x[i - 1] && x[i] > x[i + 1]).collect();
    if min_dist <= 1 {
        return cand;
    }
    cand.sort_by(|&a, &b| x[b].total_cmp(&x[a]));
    let mut taken = vec![false; n];
    let mut keep = Vec::new();
    for i in cand {
        let lo = i.saturating_sub(min_dist - 1);
        let hi = (i + min_dist).min(n);
        if (lo..hi).any(|j| taken[j]) {
            continue;
        }
        taken[i] = true;
        keep.push(i);
    }
    keep.sort_unstable();
    keep
}

/// Parabolic interpolation of a peak at `i`: returns the fractional offset (-0.5..0.5).
pub fn parabolic(y0: f32, y1: f32, y2: f32) -> f32 {
    let d = y0 - 2.0 * y1 + y2;
    if d.abs() < 1e-12 {
        0.0
    } else {
        (0.5 * (y0 - y2) / d).clamp(-0.5, 0.5)
    }
}

/// Onset envelopes from centred Hann frames peak about a quarter window
/// before the true attack (the window's steepest slope crosses it first).
/// Add this to frame times derived from onset peaks.
pub fn onset_latency(n_fft: usize, sr: f32) -> f32 {
    0.25 * n_fft as f32 / sr
}

/// Frequency regions for region onsets: low (kick, bass), mid (body, snare,
/// most notes), high (hats, cymbals).
pub const REGIONS: [(f32, f32); 3] = [(30.0, 150.0), (150.0, 5000.0), (5000.0, 11_025.0)];

/// Rise threshold (dB within ~12 ms) for a region onset. Steady noise and
/// sustained tones stay well under it; drum hits rise 20–40 dB.
pub const REGION_RISE_DB: f32 = 8.0;

/// Per-region summed power in dB (floored at the loudest region's max −
/// [`BAND_DB_RANGE`], so an almost empty region can't flicker), then the rise
/// over `lag` frames: one envelope per region. Summing the region's bins
/// keeps the variance low where log bands are only one bin wide.
pub fn region_rise(spec: &Spectrogram, regions: &[(f32, f32)], lag: usize) -> Vec<Vec<f32>> {
    let bin_hz = spec.bin_hz();
    let mut dbs: Vec<Vec<f32>> = regions
        .iter()
        .map(|&(lo, hi)| {
            let a = ((lo / bin_hz).floor() as usize).max(1).min(spec.bins - 1);
            let b = ((hi / bin_hz).ceil() as usize).min(spec.bins).max(a + 1);
            (0..spec.frames).map(|t| 10.0 * (spec.frame(t)[a..b].iter().sum::<f32>() + 1e-12).log10()).collect()
        })
        .collect();
    let floor = dbs.iter().flatten().cloned().fold(f32::MIN, f32::max) - BAND_DB_RANGE;
    for db in dbs.iter_mut() {
        for v in db.iter_mut() {
            *v = v.max(floor);
        }
    }
    dbs.iter().map(|db| (0..spec.frames).map(|t| if t >= lag { (db[t] - db[t - lag]).max(0.0) } else { 0.0 }).collect()).collect()
}

/// Onset frames from several envelopes, each with its own absolute floor,
/// merged: onsets closer than `merge_sec` collapse to the earliest.
pub fn merged_onsets(envs: &[(&[f32], f32)], fps: f32, delta: f32, merge_sec: f32) -> Vec<usize> {
    let mut all: Vec<usize> = Vec::new();
    for &(env, floor) in envs {
        if env.len() < 3 {
            continue;
        }
        let avg = moving_average(env, (fps * 0.4) as usize);
        let sd = std_dev(env);
        let th: Vec<f32> = avg.iter().map(|a| (a + delta * sd).max(floor)).collect();
        all.extend(pick_peaks(env, &th, ((0.03 * fps).round() as usize).max(1)));
    }
    all.sort_unstable();
    let gap = ((merge_sec * fps).round() as usize).max(1);
    let mut out: Vec<usize> = Vec::new();
    for f in all {
        if out.last().map(|&l| f - l >= gap).unwrap_or(true) {
            out.push(f);
        }
    }
    out
}

/// Onset analysis of a mono signal at the analysis rate.
pub struct Onsets {
    pub fps: f32,
    /// Broadband spectral flux (log bands).
    pub env: Vec<f32>,
    /// Low-band (< 150 Hz) flux: kick drums / bass.
    pub low: Vec<f32>,
    /// High-band (> 5 kHz) flux: hats.
    pub high: Vec<f32>,
    /// Log band energies per frame (dB), for timbre features.
    pub band_db: Vec<Vec<f32>>,
    pub bands: Bands,
    /// Detected onsets (frames): broadband flux and per-region rises, merged.
    pub onsets: Vec<usize>,
    /// Summed-power rise per [`REGIONS`] entry (low, mid, high).
    pub rise: Vec<Vec<f32>>,
}

/// STFT 1024 / hop 256 at 22 050 Hz (≈ 86 frames per second).
pub fn onsets(x: &[f32], sr: f32, ctx: &JobCtx) -> Result<Onsets, JobError> {
    let spec = power_spectrogram(x, sr, 1024, 256, 512, ctx)?;
    let bands = log_bands(&spec, 30.0, sr * 0.5 * 0.98, 48);
    let db = band_db(&spec, &bands);
    let env = flux(&db, &bands, 0.0, f32::MAX);
    let low = flux(&db, &bands, 0.0, 150.0);
    let high = flux(&db, &bands, 5000.0, f32::MAX);
    let fps = spec.fps();
    let rise = region_rise(&spec, &REGIONS, ((0.012 * fps).round() as usize).max(1));
    let mut envs: Vec<(&[f32], f32)> = vec![(&env, ONSET_FLOOR)];
    envs.extend(rise.iter().map(|r| (r.as_slice(), REGION_RISE_DB)));
    let onsets = merged_onsets(&envs, fps, 0.5, 0.03);
    Ok(Onsets { fps, env, low, high, band_db: db, bands, onsets, rise })
}

/// Absolute floor for an onset in the log-band flux envelope (mean dB rise
/// per frame across bands). Drum hits peak around 15–30, note/chord onsets
/// at 3–10; amplitude beating in sustained tones and steady noise stay
/// below ~3 (scale-invariant: the envelope is in dB).
pub const ONSET_FLOOR: f32 = 3.0;

/// Onset times (frames) from an onset envelope: peaks above a local
/// threshold (moving mean + `delta` × global std) and [`ONSET_FLOOR`],
/// ≥ 30 ms apart.
pub fn onset_frames(env: &[f32], fps: f32, delta: f32) -> Vec<usize> {
    if env.len() < 3 {
        return Vec::new();
    }
    let avg = moving_average(env, (fps * 0.4) as usize);
    let sd = std_dev(env);
    let floor = (percentile(env, 0.99) * 0.04).max(ONSET_FLOOR);
    let th: Vec<f32> = avg.iter().map(|a| (a + delta * sd).max(floor)).collect();
    pick_peaks(env, &th, ((0.03 * fps).round() as usize).max(1))
}
