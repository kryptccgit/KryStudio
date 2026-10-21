use super::filters::{Svf, SvfMode, BUTTER_Q_4};

pub struct Yin {
    decim: usize,
    dcount: usize,
    aa: [Svf; 2],
    ring: Vec<f32>,
    mask: usize,
    w: usize,
    filled: usize,
    hop: usize,
    hop_ctr: usize,
    work: Vec<f32>,
    d: Vec<f32>,
    tau_min: usize,
    tau_max: usize,
    win: usize,
    sr_d: f32,
    pub threshold: f32,
    pub gate: f32,
    pub freq: f32,
    pub aperiodicity: f32,
}

impl Yin {
    pub fn new(sr: f32, fmin: f32, fmax: f32) -> Self {
        let decim = ((sr / 16000.0).floor() as usize).max(1);
        let sr_d = sr / decim as f32;
        let fmin = fmin.clamp(20.0, 1000.0);
        let fmax = fmax.clamp(fmin * 2.0, sr_d * 0.25);
        let tau_max = (sr_d / fmin).ceil() as usize + 2;
        let tau_min = ((sr_d / fmax).floor() as usize).max(2);
        let win = tau_max;
        let n = win + tau_max + 2;
        let size = (n + 64).next_power_of_two();
        let mut aa = [Svf::default(); 2];
        let fc = (0.25 * sr_d).min(5000.0) as f64;
        aa[0].design(SvfMode::Lowpass, fc, BUTTER_Q_4[0], 0.0, sr as f64);
        aa[1].design(SvfMode::Lowpass, fc, BUTTER_Q_4[1], 0.0, sr as f64);
        Self {
            decim,
            dcount: 0,
            aa,
            ring: vec![0.0; size],
            mask: size - 1,
            w: 0,
            filled: 0,
            hop: ((sr_d * 0.004) as usize).max(16),
            hop_ctr: 0,
            work: vec![0.0; n],
            d: vec![0.0; tau_max + 2],
            tau_min,
            tau_max,
            win,
            sr_d,
            threshold: 0.15,
            gate: 0.003,
            freq: 0.0,
            aperiodicity: 1.0,
        }
    }

    pub fn hop_samples(&self) -> usize {
        self.hop * self.decim
    }

    pub fn reset(&mut self) {
        self.aa.iter_mut().for_each(Svf::reset);
        self.filled = 0;
        self.dcount = 0;
        self.hop_ctr = 0;
        self.freq = 0.0;
        self.aperiodicity = 1.0;
    }

    #[inline]
    pub fn push(&mut self, x: f32) -> bool {
        let x = if x.is_finite() { x } else { 0.0 };
        let a = self.aa[0].tick(x as f64);
        let y = self.aa[1].tick(a) as f32;
        self.dcount += 1;
        if self.dcount < self.decim {
            return false;
        }
        self.dcount = 0;
        self.w = (self.w + 1) & self.mask;
        self.ring[self.w] = y;
        if self.filled < self.ring.len() {
            self.filled += 1;
        }
        self.hop_ctr += 1;
        if self.hop_ctr < self.hop {
            return false;
        }
        self.hop_ctr = 0;
        self.analyze();
        true
    }

    fn analyze(&mut self) {
        let n = self.win + self.tau_max;
        if self.filled < n {
            self.freq = 0.0;
            return;
        }
        let size = self.ring.len();
        let mut energy = 0.0f32;
        for i in 0..n {
            let v = self.ring[(self.w + size - (n - 1 - i)) & self.mask];
            self.work[i] = v;
            energy += v * v;
        }
        if (energy / n as f32).sqrt() < self.gate {
            self.freq = 0.0;
            self.aperiodicity = 1.0;
            return;
        }
        let win = self.win;
        self.d[0] = 0.0;
        for tau in 1..=self.tau_max {
            let (a, b) = (&self.work[..win], &self.work[tau..tau + win]);
            let mut s = 0.0f32;
            for (x, y) in a.iter().zip(b) {
                let e = x - y;
                s += e * e;
            }
            self.d[tau] = s;
        }
        let mut running = 0.0f32;
        self.d[0] = 1.0;
        for tau in 1..=self.tau_max {
            running += self.d[tau];
            self.d[tau] = if running > 1e-20 { self.d[tau] * tau as f32 / running } else { 1.0 };
        }
        let mut found = None;
        let mut tau = self.tau_min;
        while tau < self.tau_max {
            if self.d[tau] < self.threshold {
                while tau + 1 < self.tau_max && self.d[tau + 1] < self.d[tau] {
                    tau += 1;
                }
                found = Some(tau);
                break;
            }
            tau += 1;
        }
        let tau = match found {
            Some(t) => t,
            None => {
                let mut best = self.tau_min;
                for t in self.tau_min..self.tau_max {
                    if self.d[t] < self.d[best] {
                        best = t;
                    }
                }
                if self.d[best] > 0.3 {
                    self.freq = 0.0;
                    self.aperiodicity = self.d[best];
                    return;
                }
                best
            }
        };
        let (a, b, c) = (self.d[tau - 1], self.d[tau], self.d[tau + 1]);
        let den = a - 2.0 * b + c;
        let off = if den.abs() > 1e-12 { (0.5 * (a - c) / den).clamp(-0.5, 0.5) } else { 0.0 };
        let tf = tau as f32 + off;
        self.aperiodicity = b;
        self.freq = if tf > 1.0 { self.sr_d / tf } else { 0.0 };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_fundamental_of_rich_tones() {
        for &sr in &[44100.0f32, 48000.0, 96000.0] {
            for &f in &[82.4f32, 110.0, 196.0, 261.6, 440.0, 659.3] {
                let mut y = Yin::new(sr, 60.0, 1000.0);
                let mut last = 0.0;
                for i in 0..(sr * 0.3) as usize {
                    let t = i as f32 / sr;
                    let x = 0.3 * (std::f32::consts::TAU * f * t).sin()
                        + 0.25 * (std::f32::consts::TAU * 2.0 * f * t).sin()
                        + 0.2 * (std::f32::consts::TAU * 3.0 * f * t + 0.4).sin();
                    if y.push(x) {
                        last = y.freq;
                    }
                }
                let cents = 1200.0 * (last / f).log2();
                assert!(cents.abs() < 5.0, "sr {sr} f {f}: got {last} ({cents:.1} ct)");
            }
        }
    }

    #[test]
    fn silence_and_noise_are_unvoiced() {
        let mut y = Yin::new(48000.0, 60.0, 1000.0);
        for _ in 0..20000 {
            y.push(0.0);
        }
        assert_eq!(y.freq, 0.0);
        let mut s = 7u32;
        let mut voiced = 0;
        let mut total = 0;
        for _ in 0..48000 {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            if y.push((s >> 8) as f32 / 16_777_216.0 - 0.5) {
                total += 1;
                if y.freq > 0.0 {
                    voiced += 1;
                }
            }
        }
        assert!(voiced * 10 < total, "noise read as voiced {voiced}/{total}");
    }
}
