use std::sync::Arc;

use krypt_studio_dsp::analysis::{Bands, BAND_EDGES};
use realfft::num_complex::Complex32;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};

use crate::audio;
use crate::protocol::{FingerprintArgs, FingerprintResult, FingerprintSegment, SoundFingerprint};
use crate::{JobCtx, JobError};

pub const TRIM_LEVEL: f32 = 0.001;
pub const TRIM_REL: f32 = 0.01;
pub const BAND_FLOOR_DB: f32 = -90.0;
pub const LEVEL_FLOOR_DB: f32 = -120.0;
pub const F0_MIN_HARMONICITY: f32 = 0.4;
const ENV_WIN: f32 = 0.005;
const ENV_HOP: f32 = 0.001;
const ENV_SMOOTH: f32 = 0.02;
const YIN_THRESHOLD: f32 = 0.15;
const VOICED_APERIODICITY: f32 = 0.3;
const F0_MIN: f32 = 27.5;
const F0_MAX: f32 = 2000.0;
const MAX_YIN_FRAMES: usize = 16;
const MAX_PITCH_SPAN: f32 = 12.0;
pub const MAX_SEGMENTS: usize = 200_000;
const EULER_GAMMA: f64 = 0.577_215_664_901_532_9;

pub fn run(args: &FingerprintArgs, ctx: &JobCtx) -> Result<FingerprintResult, JobError> {
    let segs = validate(args.segments.as_deref())?;
    ctx.progress("decoding", -1.0);
    let data = audio::load(&args.path)?;
    ctx.check()?;
    match args.highpass_hz.filter(|hz| hz.is_finite() && *hz > 0.0 && *hz < data.sample_rate * 0.45) {
        Some(hz) => {
            let filtered: Vec<Vec<f32>> = data.channels.iter().take(2).map(|c| highpass(c, data.sample_rate, hz)).collect();
            fingerprint_channels(&filtered, data.sample_rate, segs.as_deref(), args.pitch.unwrap_or(true), ctx)
        }
        None => fingerprint_channels(&data.channels, data.sample_rate, segs.as_deref(), args.pitch.unwrap_or(true), ctx),
    }
}

pub fn highpass(x: &[f32], sr: f32, hz: f32) -> Vec<f32> {
    let mut y: Vec<f32> = x.to_vec();
    for q in [0.541_196_1_f64, 1.306_563_f64] {
        let w = 2.0 * std::f64::consts::PI * hz as f64 / sr as f64;
        let (sw, cw) = w.sin_cos();
        let alpha = sw / (2.0 * q);
        let a0 = 1.0 + alpha;
        let b0 = (1.0 + cw) / 2.0 / a0;
        let b1 = -(1.0 + cw) / a0;
        let b2 = b0;
        let a1 = -2.0 * cw / a0;
        let a2 = (1.0 - alpha) / a0;
        let (mut x1, mut x2, mut y1, mut y2) = (0f64, 0f64, 0f64, 0f64);
        for v in y.iter_mut() {
            let xi = *v as f64;
            let yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = xi;
            y2 = y1;
            y1 = yi;
            *v = yi as f32;
        }
    }
    y
}

fn validate(segs: Option<&[FingerprintSegment]>) -> Result<Option<Vec<(f64, f64)>>, JobError> {
    let Some(segs) = segs.filter(|s| !s.is_empty()) else { return Ok(None) };
    if segs.len() > MAX_SEGMENTS {
        return Err(JobError::Failed(format!("Too many segments ({}; at most {MAX_SEGMENTS})", segs.len())));
    }
    let mut out = Vec::with_capacity(segs.len());
    for (i, s) in segs.iter().enumerate() {
        if !(s.start_sec.is_finite() && s.end_sec.is_finite()) {
            return Err(JobError::Failed(format!("Segment {} has an invalid time ({}..{})", i + 1, s.start_sec, s.end_sec)));
        }
        out.push((s.start_sec, s.end_sec));
    }
    Ok(Some(out))
}

pub fn fingerprint_channels(channels: &[Vec<f32>], sr: f32, segments: Option<&[(f64, f64)]>, pitch: bool, ctx: &JobCtx) -> Result<FingerprintResult, JobError> {
    let n = channels.iter().take(2).map(|c| c.len()).min().unwrap_or(0);
    let l: &[f32] = channels.first().map(|c| &c[..n]).unwrap_or(&[]);
    let r: Option<&[f32]> = channels.get(1).map(|c| &c[..n]);
    let mut fp = Fingerprinter::new(sr);
    match segments {
        None => {
            ctx.progress("fingerprinting", 0.0);
            let whole = fp.measure(l, r, pitch);
            ctx.progress("fingerprinting", 1.0);
            Ok(FingerprintResult { segments: Vec::new(), whole: Some(whole) })
        }
        Some(segs) => {
            let total = segs.len();
            let report = total >= 32;
            let step = (total / 100).max(1);
            if report {
                ctx.progress("fingerprinting", 0.0);
            }
            let mut out = Vec::with_capacity(total);
            for (i, &(a, b)) in segs.iter().enumerate() {
                if i % 16 == 0 {
                    ctx.check()?;
                }
                let s0 = ((a.max(0.0) * sr as f64).round() as usize).min(n);
                let s1 = ((b.max(0.0) * sr as f64).round() as usize).min(n);
                out.push(if s1 > s0 { fp.measure(&l[s0..s1], r.map(|r| &r[s0..s1]), pitch) } else { SoundFingerprint::empty() });
                if report && (i + 1) % step == 0 {
                    ctx.progress("fingerprinting", (i + 1) as f32 / total as f32);
                }
            }
            if report {
                ctx.progress("fingerprinting", 1.0);
            }
            Ok(FingerprintResult { segments: out, whole: None })
        }
    }
}

fn db(lin: f64) -> f32 {
    if lin > 1e-12 {
        ((20.0 * lin.log10()) as f32).max(LEVEL_FLOOR_DB)
    } else {
        LEVEL_FLOOR_DB
    }
}

fn fin(x: f32, lo: f32, hi: f32) -> f32 {
    if x.is_finite() {
        x.clamp(lo, hi)
    } else {
        lo
    }
}

pub struct Fingerprinter {
    sr: f32,
    n_fft: usize,
    hop: usize,
    window: Vec<f32>,
    planner: RealFftPlanner<f32>,
    fwd: Arc<dyn RealToComplex<f32>>,
    time: Vec<f32>,
    freq: Vec<Complex32>,
    scratch: Vec<Complex32>,
}

impl Fingerprinter {
    pub fn new(sr: f32) -> Self {
        let sr = if sr.is_finite() && sr >= 1000.0 { sr } else { 44_100.0 };
        let n_fft = ((sr * 0.085) as usize).next_power_of_two().clamp(512, 16_384);
        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(n_fft);
        let window = crate::features::hann(n_fft);
        let time = fwd.make_input_vec();
        let freq = fwd.make_output_vec();
        let scratch = fwd.make_scratch_vec();
        Self { sr, n_fft, hop: n_fft / 2, window, planner, fwd, time, freq, scratch }
    }

    pub fn measure(&mut self, l: &[f32], r: Option<&[f32]>, pitch: bool) -> SoundFingerprint {
        let n = r.map(|r| r.len().min(l.len())).unwrap_or(l.len());
        let l = &l[..n];
        let r = r.map(|r| &r[..n]);
        let clean = |x: f32| if x.is_finite() { x } else { 0.0 };
        let abs_at = |i: usize| -> f32 {
            let a = clean(l[i]).abs();
            match r {
                Some(r) => a.max(clean(r[i]).abs()),
                None => a,
            }
        };
        let peak = (0..n).fold(0f32, |m, i| m.max(abs_at(i)));
        if peak < 1e-6 {
            return SoundFingerprint::empty();
        }
        let thr = TRIM_LEVEL.min(peak * TRIM_REL);
        let i0 = (0..n).find(|&i| abs_at(i) >= thr).unwrap_or(0);
        let i1 = (0..n).rev().find(|&i| abs_at(i) >= thr).unwrap_or(n - 1);
        let (l, r) = (&l[i0..=i1], r.map(|r| &r[i0..=i1]));
        let len = l.len();
        let sr = self.sr;
        let length_sec = len as f32 / sr;

        let mut mono = Vec::with_capacity(len);
        let mut pow = Vec::with_capacity(len);
        let (mut e_mid, mut e_side, mut e_sum) = (0f64, 0f64, 0f64);
        for i in 0..len {
            let a = clean(l[i]);
            match r {
                Some(r) => {
                    let b = clean(r[i]);
                    let m = 0.5 * (a + b);
                    let s = 0.5 * (a - b);
                    e_mid += (m * m) as f64;
                    e_side += (s * s) as f64;
                    let p = 0.5 * (a * a + b * b);
                    e_sum += p as f64;
                    mono.push(m);
                    pow.push(p);
                }
                None => {
                    e_sum += (a * a) as f64;
                    mono.push(a);
                    pow.push(a * a);
                }
            }
        }
        let rms = (e_sum / len as f64).sqrt();
        let peak_db = db(peak as f64);
        let rms_db = db(rms);
        let crest_db = fin(peak_db - rms_db, 0.0, 120.0);
        let width = if r.is_none() || e_mid + e_side < 1e-18 {
            0.0
        } else if e_mid < 1e-18 {
            1.0
        } else {
            fin((e_side / e_mid) as f32, 0.0, 1.0)
        };

        let hop = ((ENV_HOP * sr).round() as usize).max(1);
        let mut pre = Vec::with_capacity(len + 1);
        pre.push(0f64);
        let mut acc = 0f64;
        for &p in &pow {
            acc += p as f64;
            pre.push(acc);
        }
        let n_env = len.div_ceil(hop).max(1);
        let rms_env = |win: usize, centred: bool| -> Vec<f32> {
            (0..n_env)
                .map(|k| {
                    let c = k * hop;
                    let a = if centred { c.saturating_sub(win / 2) } else { c }.min(len);
                    let b = (if centred { c + win / 2 } else { c + win }).min(len);
                    if b > a && (b - a) * 2 >= win.min(len) {
                        ((pre[b] - pre[a]) / (b - a) as f64).max(0.0).sqrt() as f32
                    } else {
                        0.0
                    }
                })
                .collect()
        };
        let env5 = rms_env(((ENV_WIN * sr).round() as usize).max(1), false);
        let win_s = ((ENV_SMOOTH * sr).round() as usize).max(1);
        let env = rms_env(win_s, true);
        let peak5 = env5.iter().cloned().fold(0f32, f32::max);
        let env_peak = env.iter().cloned().fold(0f32, f32::max);
        let k_att = env5.iter().position(|&v| v >= peak5 * 0.891).unwrap_or(0);
        let k_pk = env.iter().position(|&v| v >= env_peak * 0.891).unwrap_or(0);
        let t_of = |k: usize| (k * hop) as f32 / sr;
        let attack_ms = t_of(k_att) * 1000.0;
        let decay_ms = match env[k_pk..].iter().position(|&v| v < env_peak * 0.1) {
            Some(d) => t_of(d) * 1000.0,
            None => (length_sec - t_of(k_pk)).max(0.0) * 1000.0,
        }
        .min(length_sec * 1000.0);
        let half = len / 2;
        let tail: Vec<f32> = env.iter().enumerate().filter(|(k, &v)| k * hop >= half && v > 0.0).map(|(_, &v)| v).collect();
        let sustain = if env_peak <= 0.0 || tail.is_empty() { 0.0 } else { tail.iter().sum::<f32>() / tail.len() as f32 / env_peak };

        let spec = self.spectrum(&mono);

        let last_loud = env.iter().rposition(|&v| v >= env_peak * 0.1).unwrap_or(n_env - 1);
        let s0 = (k_att * hop + (0.005 * sr) as usize).min(len);
        let s1 = (last_loud * hop + win_s / 2).min(len);
        let (s0, s1) = if s1 > s0 + (0.02 * sr) as usize { (s0, s1) } else { (0, len) };
        let max_span = (MAX_PITCH_SPAN * sr) as usize;
        let (s0, s1) = if s1 - s0 > max_span {
            let c = (s0 + s1) / 2;
            (c - max_span / 2, c - max_span / 2 + max_span)
        } else {
            (s0, s1)
        };
        let (harmonicity, f0) = self.yin(&mono[s0..s1]);
        let f0_hz = if pitch && harmonicity >= F0_MIN_HARMONICITY { f0 } else { None };

        SoundFingerprint {
            length_sec: fin(length_sec, 0.0, 1e7),
            centroid_hz: fin(spec.centroid, 0.0, sr * 0.5),
            rolloff_hz: fin(spec.rolloff, 0.0, sr * 0.5),
            flatness: fin(spec.flatness, 0.0, 1.0),
            harmonicity: fin(harmonicity, 0.0, 1.0),
            f0_hz: f0_hz.filter(|f| f.is_finite() && *f > 0.0),
            attack_ms: fin(attack_ms, 0.0, length_sec * 1000.0),
            decay_ms: fin(decay_ms, 0.0, length_sec * 1000.0),
            sustain: fin(sustain, 0.0, 1.0),
            bands: spec.bands,
            crest_db,
            width,
            peak_db,
            rms_db,
        }
    }

    fn spectrum(&mut self, x: &[f32]) -> Spec {
        let (n_fft, hop) = (self.n_fft, self.hop);
        let bins = n_fft / 2 + 1;
        let bin_hz = self.sr / n_fft as f32;
        let nyq = self.sr * 0.5;
        let len = x.len();
        let frames = len / hop + 1;
        let half = (n_fft / 2) as i64;
        let mut total = vec![0f64; bins];
        let mut frame_pow = vec![0f32; bins];
        let fl_lo = ((20.0 / bin_hz).ceil() as usize).max(1);
        let fl_hi = (((16_000f32).min(nyq * 0.95) / bin_hz).floor() as usize).min(bins - 2).max(fl_lo);
        let (mut flat_num, mut flat_den) = (0f64, 0f64);
        let mut flats: Vec<(f64, f64)> = Vec::with_capacity(frames);
        for t in 0..frames {
            let start = t as i64 * hop as i64 - half;
            for (j, w) in self.window.iter().enumerate() {
                let k = start + j as i64;
                self.time[j] = if k >= 0 && (k as usize) < len { x[k as usize] * w } else { 0.0 };
            }
            if self.fwd.process_with_scratch(&mut self.time, &mut self.freq, &mut self.scratch).is_err() {
                continue;
            }
            let mut e = 0f64;
            for k in 0..bins {
                let p = self.freq[k].norm_sqr();
                frame_pow[k] = p;
                total[k] += p as f64;
                e += p as f64;
            }
            let band = &frame_pow[fl_lo..=fl_hi];
            let mean = band.iter().map(|&p| p as f64).sum::<f64>() / band.len() as f64;
            if mean > 0.0 {
                let floor = mean * 1e-12;
                let lmean = band.iter().map(|&p| (p as f64).max(floor).ln()).sum::<f64>() / band.len() as f64;
                let f = (lmean.exp() / mean * EULER_GAMMA.exp()).min(1.0);
                flats.push((e, f));
            }
        }
        let e_max = flats.iter().map(|f| f.0).fold(0f64, f64::max);
        for &(e, f) in &flats {
            if e >= e_max * 1e-6 {
                flat_num += e * f;
                flat_den += e;
            }
        }
        let flatness = if flat_den > 0.0 { (flat_num / flat_den) as f32 } else { 0.0 };
        let k_lo = ((20.0 / bin_hz).ceil() as usize).max(1);
        let k_hi = ((20_000f32.min(nyq) / bin_hz).floor() as usize).min(bins - 1).max(k_lo);
        let sum: f64 = total[k_lo..=k_hi].iter().sum();
        let (mut centroid, mut rolloff) = (0f32, 0f32);
        if sum > 0.0 {
            centroid = (total[k_lo..=k_hi].iter().enumerate().map(|(i, &p)| (k_lo + i) as f64 * p).sum::<f64>() / sum) as f32 * bin_hz;
            let mut c = 0f64;
            for k in k_lo..=k_hi {
                c += total[k];
                if c >= 0.85 * sum {
                    rolloff = k as f32 * bin_hz;
                    break;
                }
            }
        }
        let mut band_p = [0f64; 6];
        for (k, &p) in total.iter().enumerate() {
            let f = k as f32 * bin_hz;
            for (b, &(lo, hi)) in BAND_EDGES.iter().enumerate() {
                if f >= lo && f < hi {
                    band_p[b] += p;
                }
            }
        }
        let loudest = band_p.iter().cloned().fold(0f64, f64::max);
        let rel = |p: f64| -> f32 {
            if loudest <= 0.0 || p <= 0.0 {
                return if loudest <= 0.0 { 0.0 } else { BAND_FLOOR_DB };
            }
            fin((10.0 * (p / loudest).log10()) as f32, BAND_FLOOR_DB, 0.0)
        };
        let bands = Bands { sub: rel(band_p[0]), low: rel(band_p[1]), low_mid: rel(band_p[2]), mid: rel(band_p[3]), high_mid: rel(band_p[4]), high: rel(band_p[5]) };
        Spec { centroid, rolloff, flatness, bands }
    }

    fn yin(&mut self, x: &[f32]) -> (f32, Option<f32>) {
        let q = ((self.sr / 11_025.0).floor() as usize).max(1);
        let y = audio::decimate(x, q);
        let sr_d = self.sr / q as f32;
        let n = y.len();
        let tau_min = ((sr_d / F0_MAX.min(sr_d * 0.25)).floor() as usize).max(2);
        let mut tau_max = (sr_d / F0_MIN).ceil() as usize;
        if 2 * tau_max > n {
            tau_max = n / 2;
        }
        if tau_max < tau_min + 3 {
            return (0.0, None);
        }
        let w = tau_max;
        let frame_len = w + tau_max;
        let size = (w + frame_len).next_power_of_two();
        let fwd = self.planner.plan_fft_forward(size);
        let inv: Arc<dyn ComplexToReal<f32>> = self.planner.plan_fft_inverse(size);
        let mut ta = fwd.make_input_vec();
        let mut tb = fwd.make_input_vec();
        let mut fa = fwd.make_output_vec();
        let mut fb = fwd.make_output_vec();
        let mut scratch = fwd.make_scratch_vec();
        let mut iscratch = inv.make_scratch_vec();
        let mut corr = inv.make_output_vec();
        let span = n - frame_len;
        let step = ((0.01 * sr_d) as usize).max(1);
        let count = (span / step + 1).min(MAX_YIN_FRAMES).max(1);
        let mut d = vec![0f32; tau_max + 1];
        let mut cm = vec![1f32; tau_max + 1];
        let mut pre = vec![0f32; frame_len + 1];
        let (mut h_num, mut h_den) = (0f64, 0f64);
        let mut voiced: Vec<(f32, f32)> = Vec::new();
        for i in 0..count {
            let s = if count > 1 { i * span / (count - 1) } else { span / 2 };
            let frame = &y[s..s + frame_len];
            for j in 0..frame_len {
                pre[j + 1] = pre[j] + frame[j] * frame[j];
            }
            let e0 = pre[w];
            if e0 <= 1e-12 {
                continue;
            }
            ta.iter_mut().for_each(|v| *v = 0.0);
            tb.iter_mut().for_each(|v| *v = 0.0);
            ta[..w].copy_from_slice(&frame[..w]);
            tb[..frame_len].copy_from_slice(frame);
            if fwd.process_with_scratch(&mut ta, &mut fa, &mut scratch).is_err() || fwd.process_with_scratch(&mut tb, &mut fb, &mut scratch).is_err() {
                continue;
            }
            for (a, b) in fa.iter_mut().zip(fb.iter()) {
                *a = a.conj() * b;
            }
            fa[0].im = 0.0;
            if let Some(last) = fa.last_mut() {
                last.im = 0.0;
            }
            if inv.process_with_scratch(&mut fa, &mut corr, &mut iscratch).is_err() {
                continue;
            }
            let scale = 1.0 / size as f32;
            d[0] = 0.0;
            for tau in 1..=tau_max {
                let et = pre[tau + w] - pre[tau];
                d[tau] = (e0 + et - 2.0 * corr[tau] * scale).max(0.0);
            }
            cm[0] = 1.0;
            let mut run = 0f32;
            for tau in 1..=tau_max {
                run += d[tau];
                cm[tau] = if run > 0.0 { d[tau] * tau as f32 / run } else { 1.0 };
            }
            let mut best = None;
            let mut tau = tau_min;
            while tau < tau_max {
                if cm[tau] < YIN_THRESHOLD {
                    while tau + 1 < tau_max && cm[tau + 1] < cm[tau] {
                        tau += 1;
                    }
                    best = Some(tau);
                    break;
                }
                tau += 1;
            }
            let best = best.unwrap_or_else(|| (tau_min..tau_max).min_by(|&a, &b| cm[a].total_cmp(&cm[b])).unwrap_or(tau_min));
            let ap = cm[best].clamp(0.0, 1.0);
            let wgt = e0 as f64;
            h_num += wgt * (1.0 - ap) as f64;
            h_den += wgt;
            if ap < VOICED_APERIODICITY && best > tau_min && best < tau_max {
                let off = crate::features::parabolic(cm[best - 1], cm[best], cm[best + 1]);
                let f0 = sr_d / (best as f32 + off);
                if f0.is_finite() && f0 > 0.0 {
                    voiced.push((f0, e0));
                }
            }
        }
        let harmonicity = if h_den > 0.0 { (h_num / h_den) as f32 } else { 0.0 };
        if voiced.is_empty() {
            return (harmonicity, None);
        }
        voiced.sort_by(|a, b| a.0.total_cmp(&b.0));
        let total: f32 = voiced.iter().map(|v| v.1).sum();
        let mut c = 0f32;
        let mut f0 = voiced[voiced.len() / 2].0;
        for v in &voiced {
            c += v.1;
            if c >= total * 0.5 {
                f0 = v.0;
                break;
            }
        }
        (harmonicity, Some(f0))
    }
}

struct Spec {
    centroid: f32,
    rolloff: f32,
    flatness: f32,
    bands: Bands,
}
