//! HT-Demucs spectrogram front and back end, run outside the ONNX graph.
//!
//! Mirrors demucs `HTDemucs._spec` / `HTDemucs._ispec` (demucs/htdemucs.py,
//! MIT) on top of `torch.stft` / `torch.istft` with n_fft 4096, hop 1024, a
//! periodic Hann window, `normalized=True`, `center=True` and reflect padding:
//!
//! - `_spec`: reflect-pad the signal by 1536 on the left and
//!   `1536 + ceil(len/1024)*1024 - len` on the right, STFT, drop the Nyquist
//!   bin and the first/last two frames → `[2048 bins][ceil(len/1024) frames]`.
//! - `_ispec`: put the Nyquist bin and two empty frames on each side back,
//!   iSTFT, and cut the 1536-sample pad off again.
//!
//! The kept frames never reach `torch.stft`'s own centre padding, so only the
//! first reflection exists here. The inverse divides by the full window²
//! envelope including the four empty frames, exactly like `torch.istft`, which
//! is why the first and last ~1.5k samples of a segment are attenuated: the
//! model was trained with that, and the chunk overlap hides it.

use std::sync::Arc;

use realfft::num_complex::Complex32;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};

pub const NFFT: usize = 4096;
pub const HOP: usize = NFFT / 4;
/// Frequency bins the model sees (Nyquist dropped).
pub const BINS: usize = NFFT / 2;
/// demucs: `pad = hl // 2 * 3`.
const PAD: usize = HOP / 2 * 3;

/// Spectrogram frames for a segment of `length` samples.
pub fn frames(length: usize) -> usize {
    length.div_ceil(HOP)
}

pub struct Spectro {
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    window: Vec<f32>,
    time: Vec<f32>,
    freq: Vec<Complex32>,
    scratch_fwd: Vec<Complex32>,
    scratch_inv: Vec<Complex32>,
    /// 1 / window² envelope per output sample, cached per segment length.
    inv_env: (usize, Vec<f32>),
}

impl Default for Spectro {
    fn default() -> Self {
        Self::new()
    }
}

impl Spectro {
    pub fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(NFFT);
        let inv = planner.plan_fft_inverse(NFFT);
        // torch.hann_window(N) is periodic: 0.5 - 0.5 cos(2πn/N).
        let window = (0..NFFT).map(|n| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / NFFT as f64).cos()) as f32).collect();
        Self {
            scratch_fwd: fwd.make_scratch_vec(),
            scratch_inv: inv.make_scratch_vec(),
            time: fwd.make_input_vec(),
            freq: fwd.make_output_vec(),
            fwd,
            inv,
            window,
            inv_env: (0, Vec::new()),
        }
    }

    /// `_spec` of one channel. Writes the real and imaginary planes, each
    /// `[BINS][frames(x.len())]` row-major (bin-major, like the model input).
    pub fn forward(&mut self, x: &[f32], re: &mut [f32], im: &mut [f32]) {
        let len = x.len();
        let le = frames(len);
        assert!(len >= NFFT, "segment too short for the HT-Demucs STFT");
        assert_eq!(re.len(), BINS * le);
        assert_eq!(im.len(), BINS * le);
        let scale = 1.0 / (NFFT as f32).sqrt();
        let last = (len - 1) as isize;
        for t in 0..le {
            // Frame t starts at t*HOP in the padded signal = t*HOP - PAD in x.
            let base = (t * HOP) as isize - PAD as isize;
            for k in 0..NFFT {
                let mut j = base + k as isize;
                if j < 0 {
                    j = -j;
                } else if j > last {
                    j = 2 * last - j;
                }
                self.time[k] = x[j as usize] * self.window[k];
            }
            self.fwd
                .process_with_scratch(&mut self.time, &mut self.freq, &mut self.scratch_fwd)
                .expect("realfft forward: buffer sizes are fixed");
            for f in 0..BINS {
                re[f * le + t] = self.freq[f].re * scale;
                im[f * le + t] = self.freq[f].im * scale;
            }
        }
    }

    /// `_ispec` of one channel: planes `[BINS][frames(out.len())]` → `out`.
    pub fn inverse(&mut self, re: &[f32], im: &[f32], out: &mut [f32]) {
        let length = out.len();
        let le = frames(length);
        assert_eq!(re.len(), BINS * le);
        assert_eq!(im.len(), BINS * le);
        self.ensure_envelope(length);
        out.fill(0.0);
        // normalized istft: × sqrt(N); realfft's inverse is unnormalised: × 1/N.
        let scale = (NFFT as f32).sqrt() / NFFT as f32;
        for t in 0..le {
            for f in 0..BINS {
                self.freq[f] = Complex32::new(re[f * le + t], im[f * le + t]);
            }
            // A real signal's DC and Nyquist bins are real; torch's c2r ignores
            // their imaginary parts, realfft insists on it.
            self.freq[0].im = 0.0;
            self.freq[BINS] = Complex32::new(0.0, 0.0);
            self.inv
                .process_with_scratch(&mut self.freq, &mut self.time, &mut self.scratch_inv)
                .expect("realfft inverse: buffer sizes are fixed");
            // Data frame t sits at istft frame t+2 → output index t*HOP - PAD.
            let base = (t * HOP) as isize - PAD as isize;
            let k0 = (-base).max(0) as usize;
            let k1 = ((length as isize - base).min(NFFT as isize)).max(0) as usize;
            for k in k0..k1 {
                out[(base + k as isize) as usize] += self.time[k] * self.window[k] * scale;
            }
        }
        for (o, e) in out.iter_mut().zip(&self.inv_env.1) {
            *o *= e;
        }
    }

    fn ensure_envelope(&mut self, length: usize) {
        if self.inv_env.0 == length && !self.inv_env.1.is_empty() {
            return;
        }
        let le = frames(length);
        let n_frames = le + 4;
        let mut env = vec![0f32; length];
        for (i, e) in env.iter_mut().enumerate() {
            // istft buffer index of output sample i: centre pad (NFFT/2) + PAD.
            let p = i + NFFT / 2 + PAD;
            let t_hi = (p / HOP).min(n_frames - 1);
            let t_lo = (p + HOP).saturating_sub(NFFT) / HOP;
            let mut s = 0f32;
            for t in t_lo..=t_hi {
                let k = p - t * HOP;
                if k < NFFT {
                    s += self.window[k] * self.window[k];
                }
            }
            *e = if s > 1e-11 { 1.0 / s } else { 0.0 };
        }
        self.inv_env = (length, env);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal(len: usize) -> Vec<f32> {
        (0..len)
            .map(|n| {
                let n = n as f64;
                ((2.0 * std::f64::consts::PI * 0.013 * n).sin()
                    + 0.5 * (2.0 * std::f64::consts::PI * 0.1 * n + 1.0).sin()
                    + 0.25 * (2.0 * std::f64::consts::PI * 0.0021 * n).cos()) as f32
            })
            .collect()
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() <= 2e-4 + 1e-4 * b.abs()
    }

    /// Values from demucs `HTDemucs._spec` / `_ispec` (torch 2.14, demucs 4.0.1)
    /// for the same 10 000-sample signal (scratch script golden_spec.py).
    #[test]
    #[allow(clippy::excessive_precision)] // golden values copied verbatim from torch
    fn matches_torch_reference() {
        let x = signal(10_000);
        let le = frames(x.len());
        assert_eq!(le, 10);
        let mut sp = Spectro::new();
        let (mut re, mut im) = (vec![0f32; BINS * le], vec![0f32; BINS * le]);
        sp.forward(&x, &mut re, &mut im);
        let golden: [(usize, usize, f32, f32); 8] = [
            (0, 0, 3.3410820e-01, 0.0),
            (53, 3, 8.4009943e+00, -1.2877294e+01),
            (130, 5, -6.8802196e-06, 8.6217165e-07),
            (409, 5, -4.8808188e+00, -3.9943032e+00),
            (1000, 9, 3.4502358e-03, -5.5943457e-03),
            (2047, 7, -1.6705599e-08, 3.7252903e-09),
            (21, 0, 2.7985805e-01, 2.8363994e-01),
            (21, 9, -3.4907252e-01, -2.8801754e-01),
        ];
        for (f, t, r, i) in golden {
            let (gr, gi) = (re[f * le + t], im[f * le + t]);
            assert!(close(gr, r) && close(gi, i), "bin {f} frame {t}: got ({gr}, {gi}), torch ({r}, {i})");
        }
        let mut y = vec![0f32; x.len()];
        sp.inverse(&re, &im, &mut y);
        let golden_inv: [(usize, f32); 7] =
            [(0, 3.3538345e-01), (100, 8.2028639e-01), (1535, -6.5830475e-01), (1536, -6.6069359e-01), (5000, 1.7073549e-01), (8703, 8.5225910e-01), (9999, 2.3457009e-01)];
        for (i, v) in golden_inv {
            assert!(close(y[i], v), "sample {i}: got {}, torch {v}", y[i]);
        }
    }

    #[test]
    fn round_trip_is_exact_in_the_interior() {
        // 343 980 = the HT-Demucs segment; interior = away from the 1536-sample
        // edges that lose their outer frames (by design, see module docs).
        let x = signal(343_980);
        let le = frames(x.len());
        let mut sp = Spectro::new();
        let (mut re, mut im) = (vec![0f32; BINS * le], vec![0f32; BINS * le]);
        sp.forward(&x, &mut re, &mut im);
        let mut y = vec![0f32; x.len()];
        sp.inverse(&re, &im, &mut y);
        let err = x[PAD..le * HOP - PAD].iter().zip(&y[PAD..le * HOP - PAD]).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(err < 1e-4, "interior round-trip error {err}");
        // And a second call reuses the cached envelope.
        let mut y2 = vec![0f32; x.len()];
        sp.inverse(&re, &im, &mut y2);
        assert_eq!(y, y2);
    }
}
