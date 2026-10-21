//! Offline analysis of rendered audio — what an AI agent "hears"
//! (research/04 §6.5). Mirrors `Analysis` in shared/engine/protocol.ts.
//!
//! * Loudness: EBU R128 / ITU-R BS.1770-4 via the `ebur128` crate (MIT):
//!   integrated, max short-term (3 s window, 100 ms hop), loudness range.
//! * True peak: 4x polyphase interpolation (blocks::truepeak).
//! * Bands / centroid: Welch-averaged power spectrum (Hann, 4096, 50 % hop).
//! * Tempo: low-band-weighted spectral-flux onset envelope → autocorrelation
//!   → comb over beat multiples with a mild prior; reported in the 85–170 BPM
//!   octave (half/double-time folds into it: 70 → 140, 174 → 87). None when
//!   the periodicity is weak.
//!
//! All dB values are dBFS (RMS-style: a full-scale sine is -3 dB RMS);
//! silence floors at -120 dB and -70 LUFS so the JSON never holds -inf.

use ebur128::{EbuR128, Mode};
use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;
use serde::Serialize;

use crate::blocks::truepeak::true_peak;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bands {
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub sub: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub low: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub low_mid: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub mid: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub high_mid: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub high: f32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub duration_sec: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub peak_db: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub true_peak_db: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub lufs_integrated: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub lufs_short_term_max: f32,
    /// Loudness range (LU).
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub loudness_range: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub rms_db: f32,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub crest_db: f32,
    pub bands: Bands,
    /// -1..1; 1 = mono.
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub stereo_correlation: f32,
    /// Side share of the energy, 0..1: 0 = mono, 0.5 = uncorrelated stereo, 1 = out of phase.
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub stereo_width: f32,
    /// Short-term LUFS once per second.
    #[serde(serialize_with = "crate::serde_clean::vec_f32")]
    pub energy_curve: Vec<f32>,
    pub clipping: bool,
    /// Reported in the 85–170 BPM octave; None when no clear pulse.
    #[serde(serialize_with = "crate::serde_clean::opt_f32")]
    pub estimated_bpm: Option<f32>,
    #[serde(serialize_with = "crate::serde_clean::f32")]
    pub spectral_centroid_hz: f32,
}

pub const DB_FLOOR: f32 = -120.0;
pub const LUFS_FLOOR: f32 = -70.0;

/// Band edges in Hz (sub <60, low 60-250, lowMid 250-500, mid 500-2k, highMid 2k-6k, high 6k-20k).
pub const BAND_EDGES: [(f32, f32); 6] = [(20.0, 60.0), (60.0, 250.0), (250.0, 500.0), (500.0, 2000.0), (2000.0, 6000.0), (6000.0, 20000.0)];

fn to_db(lin: f64) -> f32 {
    if lin > 1e-12 {
        ((20.0 * lin.log10()) as f32).max(DB_FLOOR)
    } else {
        DB_FLOOR
    }
}

fn pow_db(p: f64) -> f32 {
    if p > 1e-24 {
        ((10.0 * p.log10()) as f32).max(DB_FLOOR)
    } else {
        DB_FLOOR
    }
}

fn lufs(v: Result<f64, ebur128::Error>) -> f32 {
    match v {
        Ok(x) if x.is_finite() => (x as f32).max(LUFS_FLOOR),
        _ => LUFS_FLOOR,
    }
}

/// Analyze a stereo buffer (equal-length channels) at `sample_rate`.
/// For a mono file pass the same slice twice (dual-mono: +3 LU versus a
/// single-channel measurement, as BS.1770 specifies for two channels).
pub fn analyze(left: &[f32], right: &[f32], sample_rate: f32) -> Analysis {
    let n = left.len().min(right.len());
    let (l, r) = (&left[..n], &right[..n]);
    let sr = if sample_rate.is_finite() && sample_rate >= 1000.0 { sample_rate } else { 48000.0 };
    let mut a = Analysis {
        duration_sec: n as f32 / sr,
        peak_db: DB_FLOOR,
        true_peak_db: DB_FLOOR,
        lufs_integrated: LUFS_FLOOR,
        lufs_short_term_max: LUFS_FLOOR,
        loudness_range: 0.0,
        rms_db: DB_FLOOR,
        crest_db: 0.0,
        stereo_correlation: 1.0,
        ..Default::default()
    };
    a.bands = Bands { sub: DB_FLOOR, low: DB_FLOOR, low_mid: DB_FLOOR, mid: DB_FLOOR, high_mid: DB_FLOOR, high: DB_FLOOR };
    if n == 0 {
        return a;
    }

    // ── sample statistics (single pass) ──
    let (mut peak, mut sll, mut srr, mut slr) = (0.0f32, 0.0f64, 0.0f64, 0.0f64);
    let mut run = 0usize;
    let mut flat_clip = false;
    let mut nonfinite = false;
    for i in 0..n {
        let (x, y) = (l[i], r[i]);
        if !x.is_finite() || !y.is_finite() {
            nonfinite = true;
            continue;
        }
        let m = x.abs().max(y.abs());
        peak = peak.max(m);
        if m >= 0.9999 {
            run += 1;
            if run >= 3 {
                flat_clip = true;
            }
        } else {
            run = 0;
        }
        sll += (x as f64) * (x as f64);
        srr += (y as f64) * (y as f64);
        slr += (x as f64) * (y as f64);
    }
    a.peak_db = to_db(peak as f64);
    let ms = (sll + srr) / (2.0 * n as f64);
    a.rms_db = pow_db(ms);
    a.crest_db = if ms > 1e-24 { a.peak_db - a.rms_db } else { 0.0 };
    if sll > 1e-20 && srr > 1e-20 {
        a.stereo_correlation = (slr / (sll * srr).sqrt()).clamp(-1.0, 1.0) as f32;
    }
    // mid/side energies: M = (L+R)/2, S = (L-R)/2
    let em = 0.25 * (sll + srr + 2.0 * slr);
    let es = 0.25 * (sll + srr - 2.0 * slr);
    a.stereo_width = if em + es > 1e-20 { (es / (em + es)).clamp(0.0, 1.0) as f32 } else { 0.0 };

    // The three heavy stages are independent: run them in parallel.
    let (tp, loud, spec, bpm) = std::thread::scope(|scope| {
        let tp = scope.spawn(|| true_peak(l).max(true_peak(r)));
        let loud = scope.spawn(|| loudness(l, r, sr));
        let mut planner = FftPlanner::<f32>::new();
        let spec = average_power_spectrum(l, r, sr, &mut planner);
        let bpm = estimate_bpm(l, r, sr, &mut planner);
        (tp.join().unwrap_or(0.0), loud.join().ok().flatten(), spec, bpm)
    });
    a.true_peak_db = to_db(tp as f64);
    a.clipping = nonfinite || flat_clip || peak > 1.0 || tp > 1.0001;
    if let Some(ld) = loud {
        a.lufs_integrated = ld.integrated;
        a.lufs_short_term_max = ld.short_term_max;
        a.loudness_range = ld.range;
        a.energy_curve = ld.curve;
    }

    // ── spectrum: bands + centroid ──
    if let Some(spec) = spec {
        let bin_hz = sr / spec.n as f32;
        let mut band_p = [0.0f64; 6];
        let (mut num, mut den) = (0.0f64, 0.0f64);
        // ignore bins >100 dB under the strongest one (window leakage / float noise)
        let floor = spec.power.iter().cloned().fold(0.0f64, f64::max) * 1e-10;
        for (k, &p) in spec.power.iter().enumerate() {
            let f = k as f32 * bin_hz;
            for (b, &(lo, hi)) in BAND_EDGES.iter().enumerate() {
                if f >= lo && f < hi {
                    band_p[b] += p;
                }
            }
            if (20.0..=20000.0).contains(&f) && p > floor {
                let mag = p.sqrt();
                num += f as f64 * mag;
                den += mag;
            }
        }
        a.bands = Bands {
            sub: pow_db(band_p[0]),
            low: pow_db(band_p[1]),
            low_mid: pow_db(band_p[2]),
            mid: pow_db(band_p[3]),
            high_mid: pow_db(band_p[4]),
            high: pow_db(band_p[5]),
        };
        a.spectral_centroid_hz = if den > 1e-20 { (num / den) as f32 } else { 0.0 };
    }

    a.estimated_bpm = bpm;
    round_for_humans(&mut a);
    a
}

fn round_to(x: f32, decimals: i32) -> f32 {
    let k = 10f64.powi(decimals);
    ((x as f64 * k).round() / k) as f32
}

/// Agents read these numbers: keep meaningful precision only.
fn round_for_humans(a: &mut Analysis) {
    a.duration_sec = round_to(a.duration_sec, 3);
    for v in [&mut a.peak_db, &mut a.true_peak_db, &mut a.lufs_integrated, &mut a.lufs_short_term_max, &mut a.loudness_range, &mut a.rms_db, &mut a.crest_db] {
        *v = round_to(*v, 2);
    }
    let b = &mut a.bands;
    for v in [&mut b.sub, &mut b.low, &mut b.low_mid, &mut b.mid, &mut b.high_mid, &mut b.high] {
        *v = round_to(*v, 2);
    }
    a.stereo_correlation = round_to(a.stereo_correlation, 3);
    a.stereo_width = round_to(a.stereo_width, 3);
    a.spectral_centroid_hz = round_to(a.spectral_centroid_hz, 0);
    a.energy_curve.iter_mut().for_each(|v| *v = round_to(*v, 2));
}

struct Loudness {
    integrated: f32,
    short_term_max: f32,
    range: f32,
    curve: Vec<f32>,
}

/// EBU R128 via the ebur128 crate. Short-term loudness is queried on a
/// 100 ms grid for files up to a minute; longer files use a coarser grid
/// (at most ~600 queries: each query re-sums the 3 s window in the crate).
fn loudness(l: &[f32], r: &[f32], sr: f32) -> Option<Loudness> {
    let n = l.len();
    let mut meter = EbuR128::new(2, sr.round() as u32, Mode::I | Mode::S | Mode::LRA).ok()?;
    let block = ((sr * 0.1) as usize).max(1); // 100 ms
    let total_blocks = n.div_ceil(block);
    let per_query = total_blocks.div_ceil(600).max(1);
    let mut st_max = f32::NEG_INFINITY;
    let mut curve = Vec::with_capacity(total_blocks / 10 + 1);
    let mut at = 0;
    let mut k = 0usize;
    while at < n {
        let e = (at + block).min(n);
        meter.add_frames_planar_f32(&[&l[at..e], &r[at..e]]).ok()?;
        at = e;
        k += 1;
        // one curve point per second (plus the final partial second)
        let second_mark = k.is_multiple_of(10) || at == n;
        if k.is_multiple_of(per_query) || second_mark {
            let st = meter.loudness_shortterm().ok().filter(|v| v.is_finite()).map(|v| v as f32);
            // short-term needs a full 3 s window (or the whole file) to mean anything
            if at as f32 >= 3.0 * sr || at == n {
                if let Some(v) = st {
                    st_max = st_max.max(v);
                }
            }
            if second_mark {
                curve.push(st.map(|v| v.max(LUFS_FLOOR)).unwrap_or(LUFS_FLOOR));
            }
        }
    }
    Some(Loudness {
        integrated: lufs(meter.loudness_global()),
        short_term_max: if st_max.is_finite() { st_max.max(LUFS_FLOOR) } else { LUFS_FLOOR },
        range: match meter.loudness_range() {
            Ok(v) if v.is_finite() => v as f32,
            _ => 0.0,
        },
        curve,
    })
}

struct Spectrum {
    n: usize,
    /// one-sided mean-square contribution per bin (sums to the signal's mean square)
    power: Vec<f64>,
}

/// Welch average power spectrum of the two channels (averaged), scaled so
/// that the sum over bins equals the mean square of the signal.
fn average_power_spectrum(l: &[f32], r: &[f32], sr: f32, planner: &mut FftPlanner<f32>) -> Option<Spectrum> {
    let n = if sr > 60000.0 { 8192 } else { 4096 };
    let len = l.len();
    let hop = n / 2;
    let window: Vec<f32> = (0..n).map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n as f32).cos()).collect();
    let wss: f64 = window.iter().map(|w| (*w as f64) * (*w as f64)).sum();
    let fft = planner.plan_fft_forward(n);
    let mut buf = vec![Complex32::new(0.0, 0.0); n];
    let mut scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];
    let mut acc = vec![0.0f64; n / 2 + 1];
    // frames start half a window early and run half a window past the end,
    // so every sample (including a transient at t=0) sits under two windows
    let mut frames = 0usize;
    let mut start: isize = -(hop as isize);
    while start < len as isize {
        for (i, c) in buf.iter_mut().enumerate() {
            let j = start + i as isize;
            let (x, y) = if j >= 0 && (j as usize) < len { (l[j as usize], r[j as usize]) } else { (0.0, 0.0) };
            let (x, y) = (if x.is_finite() { x } else { 0.0 }, if y.is_finite() { y } else { 0.0 });
            *c = Complex32::new(x * window[i], y * window[i]);
        }
        fft.process_with_scratch(&mut buf, &mut scratch);
        // unpack two real spectra from one complex FFT
        for k in 0..=n / 2 {
            let z = buf[k];
            let zc = buf[(n - k) % n].conj();
            let xl = (z + zc) * 0.5;
            let xr = (z - zc) * Complex32::new(0.0, -0.5);
            let p = 0.5 * (xl.norm_sqr() as f64 + xr.norm_sqr() as f64);
            let one_sided = if k == 0 || k == n / 2 { 1.0 } else { 2.0 };
            acc[k] += p * one_sided;
        }
        frames += 1;
        start += hop as isize;
    }
    if frames == 0 || len == 0 {
        return None;
    }
    // Σ_frames Σ_k |X|²/N ≈ (Σw²/hop) · Σ x²  →  mean square = Σ|X|² · hop / (N Σw² len)
    let norm = hop as f64 / (n as f64 * wss * len as f64);
    for v in acc.iter_mut() {
        *v *= norm;
    }
    Some(Spectrum { n, power: acc })
}

/// Best-effort tempo estimate (60–200 BPM), None if no clear pulse.
fn estimate_bpm(l: &[f32], r: &[f32], sr: f32, planner: &mut FftPlanner<f32>) -> Option<f32> {
    let n = 1024usize;
    let hop = 512usize;
    let len = l.len();
    if (len as f32) < sr * 4.0 {
        return None; // need a few bars
    }
    let fft = planner.plan_fft_forward(n);
    let window: Vec<f32> = (0..n).map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n as f32).cos()).collect();
    let max_bin = ((8000.0 / sr) * n as f32) as usize;
    let max_bin = max_bin.clamp(8, n / 2);
    let mut buf = vec![Complex32::new(0.0, 0.0); n];
    let mut scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];
    let mut prev = vec![0.0f32; max_bin];
    let mut cur = vec![0.0f32; max_bin];
    // beat-level events (kick/snare/bass) dominate the meter; hats mark subdivisions
    let bin_hz = sr / n as f32;
    let weight: Vec<f32> = (0..max_bin)
        .map(|k| {
            let f = k as f32 * bin_hz;
            if f < 250.0 {
                2.0
            } else if f < 2500.0 {
                1.0
            } else {
                0.25
            }
        })
        .collect();
    let frames = (len - n) / hop;
    let mut flux = Vec::with_capacity(frames);
    // two frames per complex FFT (frame A in re, frame B in im)
    let mut f = 0;
    while f < frames {
        let a0 = f * hop;
        let b0 = (f + 1) * hop;
        let has_b = f + 1 < frames;
        for (i, c) in buf.iter_mut().enumerate() {
            let xa = 0.5 * (l[a0 + i] + r[a0 + i]);
            let xb = if has_b { 0.5 * (l[b0 + i] + r[b0 + i]) } else { 0.0 };
            let xa = if xa.is_finite() { xa } else { 0.0 };
            let xb = if xb.is_finite() { xb } else { 0.0 };
            *c = Complex32::new(xa * window[i], xb * window[i]);
        }
        fft.process_with_scratch(&mut buf, &mut scratch);
        for half in 0..(1 + has_b as usize) {
            let mut sum = 0.0f32;
            for k in 1..max_bin {
                let z = buf[k];
                let zc = buf[n - k].conj();
                let x = if half == 0 { (z + zc) * 0.5 } else { (z - zc) * Complex32::new(0.0, -0.5) };
                let m = (1.0 + 100.0 * x.norm()).ln();
                cur[k] = m;
                let d = m - prev[k];
                if d > 0.0 {
                    sum += d * weight[k];
                }
            }
            std::mem::swap(&mut prev, &mut cur);
            flux.push(sum);
        }
        f += 2;
    }
    if flux.len() < 64 {
        return None;
    }
    // remove the local mean (≈0.4 s) and half-wave rectify
    let fr = sr / hop as f32; // frames per second
    let w = ((0.4 * fr) as usize).max(3);
    let mut csum = vec![0.0f64; flux.len() + 1];
    for (i, v) in flux.iter().enumerate() {
        csum[i + 1] = csum[i] + *v as f64;
    }
    let env: Vec<f32> = (0..flux.len())
        .map(|i| {
            let lo = i.saturating_sub(w);
            let hi = (i + w + 1).min(flux.len());
            let mean = (csum[hi] - csum[lo]) / (hi - lo) as f64;
            (flux[i] - mean as f32).max(0.0)
        })
        .collect();
    // widen onset peaks (±2 frames) so beat lags between frames still line up
    let env: Vec<f32> = (0..env.len())
        .map(|i| {
            let mut s = 0.0;
            for (j, w) in [1.0f32, 2.0, 3.0, 2.0, 1.0].iter().enumerate() {
                let k = i as isize + j as isize - 2;
                if k >= 0 && (k as usize) < env.len() {
                    s += env[k as usize] * w;
                }
            }
            s / 9.0
        })
        .collect();
    let energy: f64 = env.iter().map(|v| (*v as f64) * (*v as f64)).sum();
    if energy < 1e-9 {
        return None;
    }
    // autocorrelation over lags up to 8 s (many beat multiples → precise tempo)
    let max_lag = ((8.0 * fr) as usize).min(env.len() / 2);
    if max_lag < (2.0 * fr) as usize {
        return None;
    }
    let mut acf = vec![0.0f64; max_lag + 2];
    for (lag, a) in acf.iter_mut().enumerate().take(max_lag + 1) {
        let mut s = 0.0f64;
        for i in lag..env.len() {
            s += env[i] as f64 * env[i - lag] as f64;
        }
        *a = s / (env.len() - lag) as f64;
    }
    let a0 = acf[0].max(1e-12);
    let interp = |x: f32| -> f64 {
        let i = x.floor() as usize;
        if i + 1 > max_lag {
            return 0.0;
        }
        let t = (x - i as f32) as f64;
        acf[i] * (1.0 - t) + acf[i + 1] * t
    };
    // comb score: weighted mean of the ACF at every beat multiple that fits
    let mut best = (0.0f64, 0.0f32);
    let mut scores = Vec::with_capacity(1401);
    for step in 0..=1400 {
        let bpm = 60.0 + step as f32 * 0.1;
        let lag = 60.0 / bpm * fr;
        let (mut s, mut wsum) = (0.0f64, 0.0f64);
        let mut m = 1;
        while (lag * m as f32) < max_lag as f32 && m <= 16 {
            let w = 1.0 / (m as f64).sqrt();
            s += interp(lag * m as f32) * w;
            wsum += w;
            m += 1;
        }
        let mut s = if wsum > 0.0 { s / wsum } else { 0.0 };
        // tempo prior: log-Gaussian around 128 BPM (σ = 1 octave) nudges
        // half/double-time ambiguity the way producers usually count
        let o = (bpm / 128.0).log2() as f64;
        s *= (-0.5 * o * o).exp();
        scores.push(s);
        if s > best.0 {
            best = (s, bpm);
        }
    }
    let mean = scores.iter().sum::<f64>() / scores.len() as f64;
    let confident = best.0 > mean * 1.6 && best.0 / a0 > 0.12;
    if !confident {
        return None;
    }
    // refine with a parabola around the peak
    let i = ((best.1 - 60.0) / 0.1).round() as usize;
    let mut est = best.1;
    if i > 0 && i + 1 < scores.len() {
        let (y0, y1, y2) = (scores[i - 1], scores[i], scores[i + 1]);
        let d = y0 - 2.0 * y1 + y2;
        if d.abs() > 1e-15 {
            est += (0.5 * (y0 - y2) / d) as f32 * 0.1;
        }
    }
    let rounded = est.round();
    Some(if (est - rounded).abs() < 0.25 { rounded } else { (est * 10.0).round() / 10.0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(db: f32, f: f32, secs: f32, sr: f32) -> Vec<f32> {
        let a = 10f32.powf(db / 20.0);
        (0..(secs * sr) as usize).map(|i| a * (std::f64::consts::TAU * f as f64 * i as f64 / sr as f64).sin() as f32).collect()
    }

    #[test]
    fn ebu_3341_case1_stereo_minus23() {
        // EBU Tech 3341 test 1: 1 kHz sine at -23 dBFS in both channels → -23.0 LUFS
        let s = sine(-23.0, 1000.0, 20.0, 48000.0);
        let a = analyze(&s, &s, 48000.0);
        assert!((a.lufs_integrated + 23.0).abs() < 0.1, "{}", a.lufs_integrated);
        assert!((a.lufs_short_term_max + 23.0).abs() < 0.1, "{}", a.lufs_short_term_max);
        assert!(a.loudness_range < 0.5);
    }

    #[test]
    fn minus20_sine_expectations() {
        let sr = 48000.0;
        let s = sine(-20.0, 1000.0, 10.0, sr);
        let silent = vec![0.0f32; s.len()];
        // one channel: -20 dBFS sine → -23.0 LUFS (0 dBFS sine in one channel = -3.01 LUFS)
        let a = analyze(&s, &silent, sr);
        assert!((a.lufs_integrated + 23.0).abs() < 0.5, "{}", a.lufs_integrated);
        // both channels: +3 LU → -20 LUFS
        let b = analyze(&s, &s, sr);
        assert!((b.lufs_integrated + 20.0).abs() < 0.5, "{}", b.lufs_integrated);
        assert!((b.peak_db + 20.0).abs() < 0.05);
        assert!((b.true_peak_db + 20.0).abs() < 0.1);
        assert!((b.rms_db + 23.01).abs() < 0.05, "{}", b.rms_db);
        assert!((b.crest_db - 3.01).abs() < 0.05);
        assert!((b.bands.mid + 23.01).abs() < 0.3, "mid {}", b.bands.mid);
        assert!(b.bands.sub < -80.0 && b.bands.high < -80.0);
        assert!((b.spectral_centroid_hz - 1000.0).abs() < 50.0, "{}", b.spectral_centroid_hz);
        assert!((b.stereo_correlation - 1.0).abs() < 1e-4);
        assert!(b.stereo_width < 1e-4);
        assert!(!b.clipping);
        assert_eq!(b.energy_curve.len(), 10);
        assert!(b.estimated_bpm.is_none(), "sine has no tempo: {:?}", b.estimated_bpm);
    }

    #[test]
    fn silence_is_finite() {
        let z = vec![0.0f32; 48000];
        let a = analyze(&z, &z, 48000.0);
        assert_eq!(a.lufs_integrated, LUFS_FLOOR);
        assert_eq!(a.peak_db, DB_FLOOR);
        let j = serde_json::to_string(&a).unwrap();
        assert!(!j.contains("null") || j.contains("\"estimatedBpm\":null"), "{j}");
    }
}
