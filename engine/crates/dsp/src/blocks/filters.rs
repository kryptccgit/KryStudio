//! Filters.
//!
//! `Svf` is the linear trapezoidal (TPT / "zero-delay feedback") state
//! variable filter described by Andrew Simper (Cytomic, "Linear Trapezoidal
//! Integrated SVF", 2013) and Vadim Zavalishin ("The Art of VA Filter
//! Design"). It is stable under fast modulation and, being a bilinear
//! transform with pre-warping, hits the exact analog gain at the centre
//! frequency, which is what the EQ relies on. State is f64 for low-frequency
//! precision; scalar f64 costs the same as f32 here.

use std::f64::consts::PI;

/// Pre-warped integrator gain for cutoff `fc` at rate `fs`.
#[inline]
pub fn svf_g(fc: f64, fs: f64) -> f64 {
    let f = (fc / fs).clamp(1e-6, 0.499);
    (PI * f).tan()
}

/// Butterworth section Qs for cascaded 2nd-order cut filters.
pub const BUTTER_Q_2: [f64; 1] = [std::f64::consts::FRAC_1_SQRT_2];
pub const BUTTER_Q_4: [f64; 2] = [0.541_196_100_146_197, 1.306_562_964_876_376_8];
pub const BUTTER_Q_8: [f64; 4] = [0.509_795_579_104_159_2, 0.601_344_886_935_045_3, 0.899_976_223_136_415_6, 2.562_915_447_741_505_5];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SvfMode {
    Lowpass,
    Highpass,
    /// Band pass normalized to 0 dB at the centre.
    Bandpass,
    Notch,
    Bell,
    LowShelf,
    HighShelf,
}

#[derive(Clone, Copy, Debug)]
pub struct Svf {
    a1: f64,
    a2: f64,
    a3: f64,
    k: f64,
    m0: f64,
    m1: f64,
    m2: f64,
    ic1: f64,
    ic2: f64,
}

impl Default for Svf {
    fn default() -> Self {
        let mut s = Self { a1: 0.0, a2: 0.0, a3: 0.0, k: 1.0, m0: 1.0, m1: 0.0, m2: 0.0, ic1: 0.0, ic2: 0.0 };
        s.set_gk(0.5, 1.4);
        s
    }
}

impl Svf {
    #[inline]
    pub fn set_gk(&mut self, g: f64, k: f64) {
        self.k = k;
        self.a1 = 1.0 / (1.0 + g * (g + k));
        self.a2 = g * self.a1;
        self.a3 = g * self.a2;
    }

    /// Full design: mode, cutoff/centre (Hz), Q, gain (dB, for bell/shelves).
    pub fn design(&mut self, mode: SvfMode, fc: f64, q: f64, gain_db: f64, fs: f64) {
        let q = q.max(0.025);
        let g = svf_g(fc, fs);
        let k = 1.0 / q;
        match mode {
            SvfMode::Lowpass => {
                self.set_gk(g, k);
                (self.m0, self.m1, self.m2) = (0.0, 0.0, 1.0);
            }
            SvfMode::Highpass => {
                self.set_gk(g, k);
                (self.m0, self.m1, self.m2) = (1.0, -k, -1.0);
            }
            SvfMode::Bandpass => {
                self.set_gk(g, k);
                (self.m0, self.m1, self.m2) = (0.0, k, 0.0);
            }
            SvfMode::Notch => {
                self.set_gk(g, k);
                (self.m0, self.m1, self.m2) = (1.0, -k, 0.0);
            }
            SvfMode::Bell => {
                let a = 10f64.powf(gain_db / 40.0);
                let k = 1.0 / (q * a);
                self.set_gk(g, k);
                (self.m0, self.m1, self.m2) = (1.0, k * (a * a - 1.0), 0.0);
            }
            SvfMode::LowShelf => {
                let a = 10f64.powf(gain_db / 40.0);
                self.set_gk(g / a.sqrt(), k);
                (self.m0, self.m1, self.m2) = (1.0, k * (a - 1.0), a * a - 1.0);
            }
            SvfMode::HighShelf => {
                let a = 10f64.powf(gain_db / 40.0);
                self.set_gk(g * a.sqrt(), k);
                (self.m0, self.m1, self.m2) = (a * a, k * (1.0 - a) * a, 1.0 - a * a);
            }
        }
    }

    /// One sample through the core; returns (lowpass, bandpass, highpass).
    #[inline]
    pub fn tick3(&mut self, v0: f64) -> (f64, f64, f64) {
        let v3 = v0 - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        if self.ic1.abs() < 1e-30 {
            self.ic1 = 0.0;
        }
        if self.ic2.abs() < 1e-30 {
            self.ic2 = 0.0;
        }
        (v2, v1, v0 - self.k * v1 - v2)
    }

    /// One sample through the designed response.
    #[inline]
    pub fn tick(&mut self, v0: f64) -> f64 {
        let v3 = v0 - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        if self.ic1.abs() < 1e-30 {
            self.ic1 = 0.0;
        }
        if self.ic2.abs() < 1e-30 {
            self.ic2 = 0.0;
        }
        self.m0 * v0 + self.m1 * v1 + self.m2 * v2
    }

    #[inline]
    pub fn k(&self) -> f64 {
        self.k
    }

    pub fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }

    /// Analytic magnitude (linear) of the designed response at `f` Hz.
    /// Evaluates the digital transfer function on the unit circle.
    pub fn magnitude(&self, f: f64, fs: f64) -> f64 {
        // H(z) for the trapezoidal SVF equals the bilinear-transformed analog
        // prototype; recover g from a1/a2 (g = a2/a1).
        let g = self.a2 / self.a1;
        let w = 2.0 * PI * f / fs;
        // s = (1/g) * tan(w/2) * j in the prototype's normalized domain
        let s_im = (w * 0.5).tan() / g;
        // prototype: lp = 1/(s²+ks+1), bp = s/(...), so out = (m0(s²+ks+1) + m1 s + m2)/(s²+ks+1)
        let (re_d, im_d) = (1.0 - s_im * s_im, self.k * s_im);
        let re_n = self.m0 * (1.0 - s_im * s_im) + self.m2;
        let im_n = self.m0 * self.k * s_im + self.m1 * s_im;
        ((re_n * re_n + im_n * im_n) / (re_d * re_d + im_d * im_d)).sqrt()
    }
}

/// One-pole lowpass (TPT form, exact cutoff).
#[derive(Clone, Copy, Debug, Default)]
pub struct OnePole {
    g: f32,
    s: f32,
}

impl OnePole {
    pub fn set(&mut self, fc: f32, fs: f32) {
        let g = svf_g(fc as f64, fs as f64) as f32;
        self.g = g / (1.0 + g);
    }
    #[inline]
    pub fn lp(&mut self, x: f32) -> f32 {
        let v = (x - self.s) * self.g;
        let y = v + self.s;
        self.s = super::flush(y + v);
        y
    }
    #[inline]
    pub fn hp(&mut self, x: f32) -> f32 {
        x - self.lp(x)
    }
    pub fn reset(&mut self) {
        self.s = 0.0;
    }
}

/// DC blocker (1st-order high pass at a few Hz).
#[derive(Clone, Copy, Debug, Default)]
pub struct DcBlock {
    r: f32,
    x1: f32,
    y1: f32,
}

impl DcBlock {
    pub fn new(fc: f32, fs: f32) -> Self {
        Self { r: 1.0 - (std::f32::consts::TAU * fc / fs).min(0.5), x1: 0.0, y1: 0.0 }
    }
    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        let y = x - self.x1 + self.r * self.y1;
        self.x1 = x;
        self.y1 = super::flush(y);
        y
    }
    pub fn reset(&mut self) {
        self.x1 = 0.0;
        self.y1 = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measure(svf: &mut Svf, f: f64, fs: f64) -> f64 {
        svf.reset();
        let n = (fs * 0.5) as usize;
        let (mut ey, mut ex) = (0.0f64, 0.0f64);
        for i in 0..n {
            let x = (2.0 * PI * f * i as f64 / fs).sin();
            let y = svf.tick(x);
            if i > n / 2 {
                ey += y * y;
                ex += x * x;
            }
        }
        (ey / ex).sqrt()
    }

    #[test]
    fn bell_exact_at_centre() {
        let fs = 48000.0;
        for &(f, db, q) in &[(1000.0, 12.0, 1.0), (100.0, -9.0, 4.0), (8000.0, 6.0, 0.7), (16000.0, -12.0, 2.0)] {
            let mut s = Svf::default();
            s.design(SvfMode::Bell, f, q, db, fs);
            let m = 20.0 * s.magnitude(f, fs).log10();
            assert!((m - db).abs() < 0.01, "analytic {m} vs {db}");
            let meas = 20.0 * measure(&mut s, f, fs).log10();
            assert!((meas - db).abs() < 0.1, "measured {meas} vs {db}");
        }
    }

    #[test]
    fn lowpass_minus3db_at_cutoff() {
        let fs = 48000.0;
        let mut s = Svf::default();
        s.design(SvfMode::Lowpass, 1000.0, std::f64::consts::FRAC_1_SQRT_2, 0.0, fs);
        let m = 20.0 * s.magnitude(1000.0, fs).log10();
        assert!((m + 3.0103).abs() < 0.01, "{m}");
    }
}
