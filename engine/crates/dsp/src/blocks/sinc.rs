use super::oversample::bessel_i0;

pub const HALF_WIDTH: usize = 12;
const RES: usize = 512;
const BETA: f64 = 8.0;
pub const BANDWIDTH: f32 = 0.96;
pub const MIN_CUTOFF: f32 = 0.25;
pub const MAX_TAPS: usize = 2 * ((HALF_WIDTH as f32 / (MIN_CUTOFF * BANDWIDTH)) as usize + 2);

const PHASES: usize = 512;

#[derive(Clone, Debug)]
pub struct SincTable {
    table: Vec<f32>,
    poly: Vec<f32>,
    poly_taps: usize,
    poly_hw: usize,
}

impl Default for SincTable {
    fn default() -> Self {
        Self::new()
    }
}

impl SincTable {
    pub fn new() -> Self {
        let n = HALF_WIDTH * RES + 2;
        let i0b = bessel_i0(BETA);
        let table = (0..n)
            .map(|i| {
                let x = i as f64 / RES as f64;
                if x >= HALF_WIDTH as f64 {
                    return 0.0;
                }
                let s = if x == 0.0 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
                let r = x / HALF_WIDTH as f64;
                let w = bessel_i0(BETA * (1.0 - r * r).max(0.0).sqrt()) / i0b;
                (s * w) as f32
            })
            .collect();
        let mut t = Self { table, poly: Vec::new(), poly_taps: 0, poly_hw: 0 };
        let c = BANDWIDTH;
        let hw = (HALF_WIDTH as f32 / c).ceil() as usize;
        let taps = 2 * hw;
        let mut poly = vec![0.0f32; (PHASES + 1) * taps];
        for ph in 0..=PHASES {
            let frac = ph as f32 / PHASES as f32;
            let row = &mut poly[ph * taps..(ph + 1) * taps];
            let mut sum = 0.0f32;
            for (j, v) in row.iter_mut().enumerate() {
                let x = (j as f32 - hw as f32 + 1.0) - frac;
                *v = t.k(x * c);
                sum += *v;
            }
            row.iter_mut().for_each(|v| *v /= sum);
        }
        t.poly = poly;
        t.poly_taps = taps;
        t.poly_hw = hw;
        t
    }

    #[inline]
    fn k(&self, u: f32) -> f32 {
        let p = u.abs() * RES as f32;
        let i = p as usize;
        if i + 1 >= self.table.len() {
            return 0.0;
        }
        let f = p - i as f32;
        let a = self.table[i];
        a + (self.table[i + 1] - a) * f
    }

    #[inline]
    pub fn weights(&self, pos: f64, step: f64, w: &mut [f32; MAX_TAPS]) -> (i64, usize) {
        if step <= 1.0 {
            let i0 = pos.floor();
            let x = ((pos - i0) * PHASES as f64) as f32;
            let p = (x as usize).min(PHASES - 1);
            let a = x - p as f32;
            let n = self.poly_taps;
            let r0 = &self.poly[p * n..(p + 1) * n];
            let r1 = &self.poly[(p + 1) * n..(p + 2) * n];
            for ((wj, &u), &v) in w.iter_mut().zip(r0).zip(r1) {
                *wj = u + (v - u) * a;
            }
            return (i0 as i64 - self.poly_hw as i64 + 1, n);
        }
        let c = ((1.0 / step.max(1e-6)) as f32).clamp(MIN_CUTOFF, 1.0) * BANDWIDTH;
        let hw = ((HALF_WIDTH as f32 / c).ceil() as usize).min(MAX_TAPS / 2);
        let i0 = pos.floor();
        let frac = (pos - i0) as f32;
        let first = i0 as i64 - hw as i64 + 1;
        let n = 2 * hw;
        let mut sum = 0.0f32;
        for (j, wj) in w.iter_mut().take(n).enumerate() {
            let t = (j as f32 - hw as f32 + 1.0) - frac;
            let v = self.k(t * c);
            *wj = v;
            sum += v;
        }
        if sum.abs() > 1e-9 {
            let inv = 1.0 / sum;
            w.iter_mut().take(n).for_each(|v| *v *= inv);
        }
        (first, n)
    }
}

#[inline]
pub fn apply(data: &[f32], first: i64, w: &[f32], wrap: Option<(i64, i64)>) -> f32 {
    let len = data.len() as i64;
    let n = w.len() as i64;
    if first >= 0 && first + n <= len {
        let s = &data[first as usize..(first + n) as usize];
        let mut acc = 0.0f32;
        for (a, b) in s.iter().zip(w) {
            acc += a * b;
        }
        return acc;
    }
    let mut acc = 0.0f32;
    for (j, wj) in w.iter().enumerate() {
        let mut k = first + j as i64;
        if let Some((lo, hi)) = wrap {
            let span = hi - lo;
            if span > 0 && (k < lo || k >= hi) {
                k = lo + (k - lo).rem_euclid(span);
            }
        }
        if k >= 0 && k < len {
            acc += data[k as usize] * wj;
        }
    }
    acc
}

pub fn resample(x: &[f32], from: u32, to: u32) -> Vec<f32> {
    if x.is_empty() || from == 0 || to == 0 || from == to {
        return x.to_vec();
    }
    let table = SincTable::new();
    let max_step = 1.0 / MIN_CUTOFF as f64;
    let (mut rate, target) = (from as f64, to as f64);
    let mut staged: Option<Vec<f32>> = None;
    while rate / target > max_step {
        staged = Some(resample_stage(&table, staged.as_deref().unwrap_or(x), 2.0));
        rate /= 2.0;
    }
    resample_stage(&table, staged.as_deref().unwrap_or(x), rate / target)
}

fn resample_stage(table: &SincTable, x: &[f32], step: f64) -> Vec<f32> {
    let n = (x.len() as f64 / step).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(n);
    if let Some(q) = (1..=64usize).find(|&q| {
        let v = step * q as f64;
        (v - v.round()).abs() < 1e-9
    }) {
        let p = (step * q as f64).round() as i64;
        let rows: Vec<([f32; MAX_TAPS], i64, usize)> = (0..q)
            .map(|k| {
                let mut w = [0.0f32; MAX_TAPS];
                let (first, taps) = table.weights(k as f64 * step, step, &mut w);
                (w, first, taps)
            })
            .collect();
        for i in 0..n {
            let (w, first, taps) = &rows[i % q];
            out.push(apply(x, (i / q) as i64 * p + first, &w[..*taps], None));
        }
        return out;
    }
    let mut w = [0.0f32; MAX_TAPS];
    for i in 0..n {
        let (first, taps) = table.weights(i as f64 * step, step, &mut w);
        out.push(apply(x, first, &w[..taps], None));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_positions_are_exact() {
        let t = SincTable::new();
        let data: Vec<f32> = (0..100)
            .map(|i| {
                let t = i as f32;
                0.3 * (0.31 * t).sin() + 0.2 * (1.7 * t + 0.4).sin() + 0.2 * (2.45 * t + 1.0).sin()
            })
            .collect();
        let mut w = [0.0f32; MAX_TAPS];
        for i in 20..80 {
            let (first, n) = t.weights(i as f64, 1.0, &mut w);
            let v = apply(&data, first, &w[..n], None);
            assert!((v - data[i]).abs() < 0.01, "{} vs {}", v, data[i]);
        }
    }

    #[test]
    fn resampled_sine_is_clean() {
        let t = SincTable::new();
        let f = 0.05f64;
        let data: Vec<f32> = (0..2000).map(|i| (2.0 * std::f64::consts::PI * f * i as f64).sin() as f32).collect();
        let mut w = [0.0f32; MAX_TAPS];
        let mut pos = 100.0f64;
        let step = 0.7371;
        let mut err = 0.0f32;
        while pos < 1800.0 {
            let (first, n) = t.weights(pos, step, &mut w);
            let v = apply(&data, first, &w[..n], None);
            let ideal = (2.0 * std::f64::consts::PI * f * pos).sin() as f32;
            err = err.max((v - ideal).abs());
            pos += step;
        }
        assert!(err < 2e-3, "max err {err}");
    }

    fn sine(hz: f64, sr: u32, n: usize) -> Vec<f32> {
        (0..n).map(|i| (0.5 * (2.0 * std::f64::consts::PI * hz * i as f64 / sr as f64).sin()) as f32).collect()
    }

    fn rms(x: &[f32]) -> f32 {
        let mid = &x[x.len() / 4..x.len() * 3 / 4];
        (mid.iter().map(|v| v * v).sum::<f32>() / mid.len() as f32).sqrt()
    }

    #[test]
    fn offline_resample_keeps_tones_and_removes_aliases() {
        for (from, to) in [(96_000u32, 48_000u32), (88_200, 44_100), (192_000, 48_000), (384_000, 48_000), (352_800, 44_100), (64_000, 48_000), (50_000, 48_000), (47_999, 48_000), (48_007, 44_100), (22_050, 44_100), (16_000, 48_000), (8_000, 48_000), (11_025, 44_100)] {
            let n = from as usize / 2;
            let y = resample(&sine(1000.0, from, n), from, to);
            assert_eq!(y.len(), (n as f64 * to as f64 / from as f64).round() as usize, "{from}->{to} length");
            let ideal = sine(1000.0, to, y.len());
            let err = y[y.len() / 4..y.len() * 3 / 4].iter().zip(&ideal[y.len() / 4..]).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
            assert!(err < 5e-3, "{from}->{to}: max error {err} vs the ideal tone");
            if from > to && to as f64 * 0.6 < from as f64 / 2.0 {
                let z = resample(&sine(to as f64 * 0.6, from, n), from, to);
                assert!(rms(&z) < 0.5 / 2f32.sqrt() * 0.01, "{from}->{to}: alias rms {}", rms(&z));
            }
        }
        assert_eq!(resample(&[0.25; 10], 48_000, 48_000), vec![0.25; 10]);
        assert!(resample(&[], 96_000, 48_000).is_empty());
    }
}
