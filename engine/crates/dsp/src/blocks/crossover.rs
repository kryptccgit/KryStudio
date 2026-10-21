use super::filters::{svf_g, Svf, SvfMode};

const BUTTER_Q: f64 = std::f64::consts::FRAC_1_SQRT_2;

#[derive(Clone, Copy, Debug, Default)]
pub struct Lr4 {
    first: Svf,
    lp2: Svf,
    hp2: Svf,
}

impl Lr4 {
    pub fn set(&mut self, fc: f64, fs: f64) {
        let fc = fc.clamp(10.0, fs * 0.45);
        self.first.design(SvfMode::Lowpass, fc, BUTTER_Q, 0.0, fs);
        self.lp2.design(SvfMode::Lowpass, fc, BUTTER_Q, 0.0, fs);
        self.hp2.design(SvfMode::Highpass, fc, BUTTER_Q, 0.0, fs);
    }

    #[inline]
    pub fn split(&mut self, x: f64) -> (f64, f64) {
        let (lp1, _, hp1) = self.first.tick3(x);
        (self.lp2.tick(lp1), self.hp2.tick(hp1))
    }

    pub fn reset(&mut self) {
        self.first.reset();
        self.lp2.reset();
        self.hp2.reset();
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Allpass2 {
    s: Svf,
    k: f64,
}

impl Allpass2 {
    pub fn set(&mut self, fc: f64, fs: f64) {
        let fc = fc.clamp(10.0, fs * 0.45);
        self.k = 1.0 / BUTTER_Q;
        self.s.set_gk(svf_g(fc, fs), self.k);
    }

    #[inline]
    pub fn tick(&mut self, x: f64) -> f64 {
        let (_, bp, _) = self.s.tick3(x);
        x - 2.0 * self.k * bp
    }

    pub fn reset(&mut self) {
        self.s.reset();
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Split3 {
    lo: Lr4,
    hi: Lr4,
    comp: Allpass2,
}

impl Split3 {
    pub fn set(&mut self, f_low: f64, f_high: f64, fs: f64) {
        let (a, b) = if f_low <= f_high { (f_low, f_high) } else { (f_high, f_low) };
        self.lo.set(a, fs);
        self.hi.set(b, fs);
        self.comp.set(b, fs);
    }

    #[inline]
    pub fn split(&mut self, x: f64) -> (f64, f64, f64) {
        let (l, rest) = self.lo.split(x);
        let low = self.comp.tick(l);
        let (mid, high) = self.hi.split(rest);
        (low, mid, high)
    }

    pub fn reset(&mut self) {
        self.lo.reset();
        self.hi.reset();
        self.comp.reset();
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Split3Allpass {
    a: Allpass2,
    b: Allpass2,
}

impl Split3Allpass {
    pub fn set(&mut self, f_low: f64, f_high: f64, fs: f64) {
        self.a.set(f_low.min(f_high), fs);
        self.b.set(f_low.max(f_high), fs);
    }

    #[inline]
    pub fn tick(&mut self, x: f64) -> f64 {
        self.b.tick(self.a.tick(x))
    }

    pub fn reset(&mut self) {
        self.a.reset();
        self.b.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bands_sum_to_the_matching_allpass() {
        let fs = 48000.0;
        let mut sp = Split3::default();
        sp.set(120.0, 2500.0, fs);
        let mut ap = Split3Allpass::default();
        ap.set(120.0, 2500.0, fs);
        let mut seed = 9u32;
        for _ in 0..20000 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let x = (seed >> 8) as f64 / 16_777_216.0 - 0.5;
            let (l, m, h) = sp.split(x);
            let y = ap.tick(x);
            assert!((l + m + h - y).abs() < 1e-9, "{} vs {}", l + m + h, y);
        }
    }
}
