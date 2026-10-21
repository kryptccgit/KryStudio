pub fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let q = x * x * 0.25;
    for k in 1..64 {
        term *= q / (k as f64 * k as f64);
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
    }
    sum
}

pub fn kaiser(n: usize, len: usize, beta: f64) -> f64 {
    let m = (len - 1) as f64;
    let r = 2.0 * n as f64 / m - 1.0;
    bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / bessel_i0(beta)
}

fn halfband(len: usize, beta: f64) -> Vec<f64> {
    let c = (len - 1) / 2;
    (0..len)
        .map(|i| {
            let n = i as isize - c as isize;
            if n == 0 {
                0.5
            } else if n % 2 == 0 {
                0.0
            } else {
                let x = std::f64::consts::PI * n as f64 * 0.5;
                (x.sin() / (std::f64::consts::PI * n as f64)) * kaiser(i, len, beta)
            }
        })
        .collect()
}

#[derive(Clone, Debug)]
struct Stage {
    side: Vec<f32>,
    m: usize,
    up_hist: Vec<f32>,
    up_pos: usize,
    dn_even: Vec<f32>,
    dn_odd: Vec<f32>,
    dn_pos: usize,
    dn_odd_pos: usize,
}

impl Stage {
    fn new(len: usize, beta: f64) -> Self {
        assert!(len % 4 == 3, "halfband length must be 4m+3");
        let h = halfband(len, beta);
        let side: Vec<f32> = h.iter().step_by(2).map(|&v| v as f32).collect();
        let k = side.len();
        let m = (len - 3) / 4;
        Self {
            side,
            m,
            up_hist: vec![0.0; 2 * k],
            up_pos: 0,
            dn_even: vec![0.0; 2 * k],
            dn_odd: vec![0.0; 2 * (m + 2)],
            dn_pos: 0,
            dn_odd_pos: 0,
        }
    }

    fn reset(&mut self) {
        self.up_hist.iter_mut().for_each(|v| *v = 0.0);
        self.dn_even.iter_mut().for_each(|v| *v = 0.0);
        self.dn_odd.iter_mut().for_each(|v| *v = 0.0);
    }

    #[inline]
    fn up(&mut self, x: f32) -> (f32, f32) {
        let k = self.side.len();
        self.up_pos = if self.up_pos == 0 { k - 1 } else { self.up_pos - 1 };
        self.up_hist[self.up_pos] = x;
        self.up_hist[self.up_pos + k] = x;
        let hist = &self.up_hist[self.up_pos..self.up_pos + k];
        let mut acc = 0.0f32;
        for (h, v) in self.side.iter().zip(hist) {
            acc += h * v;
        }
        let even = 2.0 * acc;
        let odd = hist[self.m];
        (even, odd)
    }

    #[inline]
    fn down(&mut self, a: f32, b: f32) -> f32 {
        let k = self.side.len();
        self.dn_pos = if self.dn_pos == 0 { k - 1 } else { self.dn_pos - 1 };
        self.dn_even[self.dn_pos] = a;
        self.dn_even[self.dn_pos + k] = a;
        let hist = &self.dn_even[self.dn_pos..self.dn_pos + k];
        let mut acc = 0.0f32;
        for (h, v) in self.side.iter().zip(hist) {
            acc += h * v;
        }
        let n = self.m + 2;
        self.dn_odd_pos = if self.dn_odd_pos == 0 { n - 1 } else { self.dn_odd_pos - 1 };
        self.dn_odd[self.dn_odd_pos] = b;
        self.dn_odd[self.dn_odd_pos + n] = b;
        let centre = self.dn_odd[self.dn_odd_pos + self.m + 1];
        acc + 0.5 * centre
    }
}

#[derive(Clone, Debug)]
pub struct Decimator2x {
    st: Stage,
}

impl Default for Decimator2x {
    fn default() -> Self {
        Self::new()
    }
}

impl Decimator2x {
    pub fn new() -> Self {
        Self { st: Stage::new(71, 9.0) }
    }

    pub fn reset(&mut self) {
        self.st.reset();
    }

    #[inline]
    pub fn process(&mut self, a: f32, b: f32) -> f32 {
        self.st.down(a, b)
    }

    pub fn flush_len(&self) -> usize {
        self.st.side.len() + self.st.m + 2
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Factor {
    X1,
    X2,
    X4,
}

impl Factor {
    pub fn ratio(self) -> usize {
        match self {
            Factor::X1 => 1,
            Factor::X2 => 2,
            Factor::X4 => 4,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Oversampler {
    a: Stage,
    b: Stage,
    b_pad: [f32; 2],
}

impl Default for Oversampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Oversampler {
    pub fn new() -> Self {
        Self { a: Stage::new(71, 9.0), b: Stage::new(23, 7.0), b_pad: [0.0; 2] }
    }

    pub fn reset(&mut self) {
        self.a.reset();
        self.b.reset();
        self.b_pad = [0.0; 2];
    }

    pub fn latency(&self, f: Factor) -> usize {
        match f {
            Factor::X1 => 0,
            Factor::X2 => 2 * self.a.m + 1,
            Factor::X4 => 2 * self.a.m + 1 + (2 * self.b.m + 1).div_ceil(2),
        }
    }

    #[inline]
    pub fn process<F: FnMut(f32) -> f32>(&mut self, x: f32, factor: Factor, mut f: F) -> f32 {
        match factor {
            Factor::X1 => f(x),
            Factor::X2 => {
                let (u0, u1) = self.a.up(x);
                let (y0, y1) = (f(u0), f(u1));
                self.a.down(y0, y1)
            }
            Factor::X4 => {
                let (u0, u1) = self.a.up(x);
                let (v0, v1) = self.b.up(u0);
                let (v2, v3) = self.b.up(u1);
                let (y0, y1, y2, y3) = (f(v0), f(v1), f(v2), f(v3));
                let d0 = self.b.down(y0, y1);
                let d1 = self.b.down(y2, y3);
                let p = self.b_pad[0];
                self.b_pad[0] = d1;
                self.a.down(p, d0)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(f: Factor, sig: &[f32]) -> Vec<f32> {
        let mut os = Oversampler::new();
        sig.iter().map(|&x| os.process(x, f, |v| v)).collect()
    }

    #[test]
    fn identity_with_integer_latency() {
        let fs = 48000.0;
        let n = 4000;
        let sig: Vec<f32> = (0..n).map(|i| (2.0 * std::f32::consts::PI * 997.0 * i as f32 / fs).sin() * 0.5).collect();
        for f in [Factor::X2, Factor::X4] {
            let lat = Oversampler::new().latency(f);
            let out = run(f, &sig);
            let mut err = 0.0f32;
            for i in 500..n {
                err = err.max((out[i] - sig[i - lat]).abs());
            }
            assert!(err < 2e-3, "{f:?} lat {lat} err {err}");
        }
    }

    #[test]
    fn impulse_peak_at_latency() {
        for f in [Factor::X2, Factor::X4] {
            let mut sig = vec![0.0f32; 300];
            sig[10] = 1.0;
            let out = run(f, &sig);
            let (imax, _) = out.iter().enumerate().fold((0, 0.0f32), |a, (i, &v)| if v.abs() > a.1 { (i, v.abs()) } else { a });
            let lat = Oversampler::new().latency(f);
            assert_eq!(imax, 10 + lat, "{f:?}");
        }
    }
}
