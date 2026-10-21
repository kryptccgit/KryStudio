use super::oversample::bessel_i0;

pub const TAPS: usize = 24;
pub const PHASES: usize = 4;
const BETA: f64 = 7.5;
const HANN_TAPS: usize = 12;
const HANN_OFFSET: usize = TAPS / 2 - HANN_TAPS / 2;

fn design_kaiser() -> [[f32; TAPS]; PHASES] {
    let mut c = [[0.0f32; TAPS]; PHASES];
    let half = TAPS as f64 / 2.0;
    let i0b = bessel_i0(BETA);
    for (p, row) in c.iter_mut().enumerate() {
        let tau = p as f64 / PHASES as f64;
        let mut sum = 0.0;
        let mut tmp = [0.0f64; TAPS];
        for (j, t) in tmp.iter_mut().enumerate() {
            let t_rel = j as f64 - half + tau;
            let s = if t_rel.abs() < 1e-12 { 1.0 } else { (std::f64::consts::PI * t_rel).sin() / (std::f64::consts::PI * t_rel) };
            let r = (t_rel / (half + 1.0)).clamp(-1.0, 1.0);
            let w = bessel_i0(BETA * (1.0 - r * r).sqrt()) / i0b;
            *t = s * w;
            sum += *t;
        }
        for (j, v) in row.iter_mut().enumerate() {
            *v = (tmp[j] / sum) as f32;
        }
    }
    c
}

fn design_hann() -> [[f32; HANN_TAPS]; PHASES] {
    let n = HANN_TAPS * PHASES;
    let mut h = vec![0.0f64; n];
    for (j, v) in h.iter_mut().enumerate() {
        let w = 0.5 * (1.0 - (2.0 * std::f64::consts::PI * j as f64 / n as f64).cos());
        let m = j as f64 - n as f64 / 2.0;
        let x = m * std::f64::consts::PI / PHASES as f64;
        *v = if m.abs() < 1e-9 { w } else { w * x.sin() / x };
    }
    let mut c = [[0.0f32; HANN_TAPS]; PHASES];
    for (f, row) in c.iter_mut().enumerate() {
        for (t, v) in row.iter_mut().enumerate() {
            *v = h[PHASES * t + f] as f32;
        }
    }
    c
}

#[derive(Clone, Debug)]
pub struct TruePeak {
    coef: [[f32; TAPS]; PHASES],
    hann: [[f32; HANN_TAPS]; PHASES],
    hist: [f32; 2 * TAPS],
    pos: usize,
}

impl Default for TruePeak {
    fn default() -> Self {
        Self::new()
    }
}

impl TruePeak {
    pub fn new() -> Self {
        Self { coef: design_kaiser(), hann: design_hann(), hist: [0.0; 2 * TAPS], pos: 0 }
    }

    pub const fn latency() -> usize {
        TAPS / 2
    }

    pub fn reset(&mut self) {
        self.hist = [0.0; 2 * TAPS];
    }

    #[inline]
    pub fn push(&mut self, x: f32) -> f32 {
        self.pos = if self.pos == 0 { TAPS - 1 } else { self.pos - 1 };
        self.hist[self.pos] = x;
        self.hist[self.pos + TAPS] = x;
        let h = &self.hist[self.pos..self.pos + TAPS];
        let mut m = h[TAPS / 2].abs();
        for row in &self.coef[1..] {
            let mut acc = 0.0f32;
            for (c, v) in row.iter().zip(h) {
                acc += c * v;
            }
            m = m.max(acc.abs());
        }
        let hh = &h[HANN_OFFSET..HANN_OFFSET + HANN_TAPS];
        for row in &self.hann {
            let mut acc = 0.0f32;
            for (c, v) in row.iter().zip(hh) {
                acc += c * v;
            }
            m = m.max(acc.abs());
        }
        m
    }
}

pub fn true_peak(x: &[f32]) -> f32 {
    let coef = design_kaiser();
    let hann = design_hann();
    let l1k = coef.iter().map(|r| r.iter().map(|v| v.abs()).sum::<f32>()).fold(1.0f32, f32::max);
    let l1h = hann.iter().map(|r| r.iter().map(|v| v.abs()).sum::<f32>()).fold(1.0f32, f32::max);
    let l1 = l1k.max(l1h);
    let n = x.len();
    if n == 0 {
        return 0.0;
    }
    let at = |k: isize| -> f32 {
        if k >= 0 && (k as usize) < n {
            x[k as usize]
        } else {
            0.0
        }
    };
    let mut best = x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    const BLK: usize = 64;
    let half = (TAPS / 2) as isize;
    let hhalf = (HANN_TAPS / 2) as isize;
    let mut b = 0;
    while b < n {
        let e = (b + BLK).min(n);
        let lo = b.saturating_sub(TAPS);
        let hi = (e + TAPS).min(n);
        let local = x[lo..hi].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        if local * l1 > best {
            for m in b..e {
                let m = m as isize;
                for row in &coef[1..] {
                    let mut acc = 0.0f32;
                    for (j, c) in row.iter().enumerate() {
                        acc += c * at(m + half - j as isize);
                    }
                    best = best.max(acc.abs());
                }
                for row in &hann[1..] {
                    let mut acc = 0.0f32;
                    for (t, c) in row.iter().enumerate() {
                        acc += c * at(m + hhalf - t as isize);
                    }
                    best = best.max(acc.abs());
                }
            }
        }
        b = e;
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_intersample_peak() {
        let x: Vec<f32> = (0..2000).map(|i| (std::f32::consts::FRAC_PI_2 * i as f32 + std::f32::consts::FRAC_PI_4).sin()).collect();
        let sp = x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((sp - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-3);
        let tp = true_peak(&x);
        assert!((tp - 1.0).abs() < 0.03, "tp {tp}");
        let mut d = TruePeak::new();
        let mut m = 0.0f32;
        for &v in &x {
            m = m.max(d.push(v));
        }
        assert!((m - 1.0).abs() < 0.03, "stream tp {m}");
    }

    #[test]
    fn hann_phase0_is_identity() {
        let h = design_hann();
        for (t, v) in h[0].iter().enumerate() {
            let want = if t == HANN_TAPS / 2 { 1.0 } else { 0.0 };
            assert!((v - want).abs() < 1e-6, "{t}: {v}");
        }
    }
}
