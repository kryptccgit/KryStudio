use ebur128::{EbuR128, Mode};
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use serde::Serialize;
use std::sync::Arc;

pub const SCOPE_FFT: usize = 4096;
pub const SCOPE_BINS: usize = 96;
pub const SCOPE_POINTS: usize = 256;
pub const SCOPE_SPAN: usize = 1024;
const CORR_SEC: f64 = 0.3;
const LUFS_FLOOR: f64 = -70.0;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScopeData {
    pub lufs_m: Option<f32>,
    pub lufs_s: Option<f32>,
    pub lufs_i: Option<f32>,
    pub true_peak: Option<f32>,
    pub correlation: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spectrum: Option<Vec<f32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<Vec<f32>>,
}

pub struct SlotScope {
    sr: u32,
    meter: Option<EbuR128>,
    hist: Vec<f32>,
    pos: usize,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    buf: Vec<Complex<f32>>,
    mags: Vec<f32>,
    lin: Vec<f32>,
    sxy: f64,
    sxx: f64,
    syy: f64,
    decay: f64,
}

impl SlotScope {
    pub fn new(sample_rate: u32) -> Self {
        let sr = sample_rate.clamp(8000, 384_000);
        let fft = FftPlanner::<f32>::new().plan_fft_forward(SCOPE_FFT);
        let window = (0..SCOPE_FFT).map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / SCOPE_FFT as f32).cos()).collect();
        Self {
            sr,
            meter: EbuR128::new(2, sr, Mode::M | Mode::S | Mode::I | Mode::TRUE_PEAK).ok(),
            hist: vec![0.0; SCOPE_FFT],
            pos: 0,
            fft,
            window,
            buf: vec![Complex::new(0.0, 0.0); SCOPE_FFT],
            mags: vec![0.0; SCOPE_FFT / 2 + 1],
            lin: vec![0.0; SCOPE_FFT],
            sxy: 0.0,
            sxx: 0.0,
            syy: 0.0,
            decay: (-1.0 / (CORR_SEC * sr as f64)).exp(),
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sr
    }

    pub fn push(&mut self, l: &[f32], r: &[f32]) {
        let n = l.len().min(r.len());
        if n == 0 {
            return;
        }
        if let Some(m) = self.meter.as_mut() {
            let _ = m.add_frames_planar_f32(&[&l[..n], &r[..n]]);
        }
        let a = self.decay;
        for i in 0..n {
            let (x, y) = (fin(l[i]), fin(r[i]));
            self.hist[self.pos] = 0.5 * (x + y);
            self.pos = (self.pos + 1) % SCOPE_FFT;
            let (x, y) = (x as f64, y as f64);
            self.sxy = self.sxy * a + x * y;
            self.sxx = self.sxx * a + x * x;
            self.syy = self.syy * a + y * y;
        }
    }

    pub fn snapshot(&mut self, full: bool) -> ScopeData {
        let lufs = |v: Result<f64, ebur128::Error>| v.ok().filter(|x| x.is_finite() && *x > LUFS_FLOOR).map(|x| round1(x as f32));
        let (m, s, i, tp) = match self.meter.as_ref() {
            Some(e) => {
                let tp = (0..2).filter_map(|c| e.true_peak(c).ok()).fold(0f64, f64::max);
                (lufs(e.loudness_momentary()), lufs(e.loudness_shortterm()), lufs(e.loudness_global()), tp)
            }
            None => (None, None, None, 0.0),
        };
        let true_peak = (tp > 1e-5).then(|| round1(20.0 * (tp as f32).log10()));
        let correlation = (self.sxx > 1e-9 && self.syy > 1e-9).then(|| (self.sxy / (self.sxx * self.syy).sqrt()).clamp(-1.0, 1.0) as f32).map(|c| (c * 100.0).round() / 100.0);
        ScopeData {
            lufs_m: m,
            lufs_s: s,
            lufs_i: i,
            true_peak,
            correlation,
            spectrum: full.then(|| self.spectrum()),
            scope: full.then(|| self.scope()),
        }
    }

    pub fn spectrum(&mut self) -> Vec<f32> {
        for i in 0..SCOPE_FFT {
            let s = self.hist[(self.pos + i) % SCOPE_FFT];
            self.buf[i] = Complex::new(s * self.window[i], 0.0);
        }
        self.fft.process(&mut self.buf);
        let norm = 2.0 / (SCOPE_FFT as f32 * 0.5);
        let half = SCOPE_FFT / 2;
        for (k, m) in self.mags.iter_mut().enumerate() {
            *m = self.buf[k].norm() * norm;
        }
        let bin_hz = self.sr as f32 / SCOPE_FFT as f32;
        let (f0, f1) = (20f32, 20_000f32);
        let ratio = f1 / f0;
        let mut out = Vec::with_capacity(SCOPE_BINS);
        for b in 0..SCOPE_BINS {
            let lo = f0 * ratio.powf(b as f32 / SCOPE_BINS as f32);
            let hi = f0 * ratio.powf((b + 1) as f32 / SCOPE_BINS as f32);
            let k0 = (lo / bin_hz).ceil() as usize;
            let k1 = ((hi / bin_hz).floor() as usize).min(half);
            let mag = if k0 <= k1 && k0 <= half {
                self.mags[k0..=k1].iter().fold(0f32, |a, &m| a.max(m))
            } else {
                let k = ((lo * hi).sqrt() / bin_hz).min(half as f32);
                let i = k.floor() as usize;
                let j = (i + 1).min(half);
                let t = k - i as f32;
                self.mags[i] * (1.0 - t) + self.mags[j] * t
            };
            out.push(round1((20.0 * mag.max(1e-9).log10()).clamp(-120.0, 6.0)));
        }
        out
    }

    pub fn scope(&mut self) -> Vec<f32> {
        for i in 0..SCOPE_FFT {
            self.lin[i] = self.hist[(self.pos + i) % SCOPE_FFT];
        }
        let last_start = SCOPE_FFT - SCOPE_SPAN;
        let search_from = last_start.saturating_sub(SCOPE_SPAN).max(1);
        let start = (search_from..=last_start).rev().find(|&i| self.lin[i - 1] < 0.0 && self.lin[i] >= 0.0).unwrap_or(last_start);
        let group = SCOPE_SPAN / SCOPE_POINTS;
        (0..SCOPE_POINTS)
            .map(|p| {
                let g = &self.lin[start + p * group..start + (p + 1) * group];
                let v = g.iter().fold(0f32, |a, &x| if x.abs() > a.abs() { x } else { a });
                (v.clamp(-2.0, 2.0) * 1000.0).round() / 1000.0
            })
            .collect()
    }
}

fn fin(x: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

fn round1(x: f32) -> f32 {
    (x * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(amp: f32, hz: f32, secs: f32, sr: f32) -> Vec<f32> {
        (0..(secs * sr) as usize).map(|i| amp * (std::f32::consts::TAU * hz * i as f32 / sr).sin()).collect()
    }

    #[test]
    fn sine_peaks_in_the_right_bin() {
        let mut s = SlotScope::new(48000);
        let x = sine(1.0, 1000.0, 0.2, 48000.0);
        s.push(&x, &x);
        let bins = s.spectrum();
        assert_eq!(bins.len(), SCOPE_BINS);
        let (imax, vmax) = bins.iter().enumerate().fold((0, -999f32), |a, (i, &v)| if v > a.1 { (i, v) } else { a });
        assert_eq!(imax, 54, "peak bin");
        assert!(vmax > -1.5 && vmax < 0.5, "peak level {vmax}");
        assert!(bins[10] < -60.0, "far bins stay low: {}", bins[10]);
    }

    #[test]
    fn calibrated_tone_reads_its_loudness() {
        let sr = 48000.0;
        let x = sine(0.1, 997.0, 4.0, sr);
        let mut s = SlotScope::new(48000);
        for (l, r) in x.chunks(768).zip(x.chunks(768)) {
            s.push(l, r);
        }
        let d = s.snapshot(true);
        for (name, v) in [("M", d.lufs_m), ("S", d.lufs_s), ("I", d.lufs_i)] {
            let v = v.unwrap_or(-999.0);
            assert!((v + 20.0).abs() <= 0.15, "{name} = {v}");
        }
        let tp = d.true_peak.unwrap();
        assert!((tp + 20.0).abs() <= 0.2, "true peak {tp}");
        assert_eq!(d.correlation, Some(1.0));
        assert_eq!(d.spectrum.as_ref().map(|v| v.len()), Some(SCOPE_BINS));
        let sc = d.scope.unwrap();
        assert_eq!(sc.len(), SCOPE_POINTS);
        assert!(sc[0] >= 0.0 && sc[0] < 0.06 && sc[2] > sc[0], "{:?}", &sc[..4]);
        assert!(sc.iter().fold(0f32, |a, &v| a.max(v.abs())) > 0.095);
    }

    #[test]
    fn correlation_and_silence() {
        let x = sine(0.5, 220.0, 0.5, 48000.0);
        let y: Vec<f32> = x.iter().map(|v| -v).collect();
        let mut s = SlotScope::new(48000);
        s.push(&x, &y);
        assert_eq!(s.snapshot(false).correlation, Some(-1.0));
        let mut q = SlotScope::new(48000);
        let z = vec![0.0; 48000];
        q.push(&z, &z);
        let d = q.snapshot(false);
        assert_eq!((d.lufs_m, d.lufs_i, d.true_peak, d.correlation), (None, None, None, None));
        assert!(d.spectrum.is_none() && d.scope.is_none());
    }
}
