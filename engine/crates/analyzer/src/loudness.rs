//! ITU-R BS.1770-4 K-weighted 100 ms block powers, from which the energy
//! curve (short-term, 3 s) and per-section integrated loudness (gated) are
//! read. Filter design per BS.1770 (pre-filter shelf + RLB high-pass),
//! re-derived for any sample rate. Mono is measured as dual-mono, matching
//! `krypt_studio_dsp::analysis` (the engine's render analysis).

pub const LUFS_FLOOR: f32 = -70.0;

pub struct Loudness {
    pub block_sec: f32,
    /// Channel-summed K-weighted mean square per 100 ms block.
    pub blocks: Vec<f64>,
}

#[derive(Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 3],
    z: [f64; 2],
}

impl Biquad {
    #[inline]
    fn run(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[1] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[2] * y;
        y
    }
}

fn k_filters(rate: f64) -> (Biquad, Biquad) {
    use std::f64::consts::PI;
    // Stage 1: high shelf (+4 dB above ~1.7 kHz).
    let f0 = 1681.974450955533;
    let g = 3.999843853973347;
    let q = 0.7071752369554196;
    let k = (PI * f0 / rate).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b: [(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0],
        a: [1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
        z: [0.0; 2],
    };
    // Stage 2: RLB high-pass (~38 Hz).
    let f0 = 38.13547087602444;
    let q = 0.5003270373238773;
    let k = (PI * f0 / rate).tan();
    let d = 1.0 + k / q + k * k;
    let hp = Biquad { b: [1.0, -2.0, 1.0], a: [1.0, 2.0 * (k * k - 1.0) / d, (1.0 - k / q + k * k) / d], z: [0.0; 2] };
    (shelf, hp)
}

pub fn lufs_of(power: f64) -> f32 {
    if power > 1e-12 {
        ((-0.691 + 10.0 * power.log10()) as f32).max(LUFS_FLOOR)
    } else {
        LUFS_FLOOR
    }
}

impl Loudness {
    pub fn measure(channels: &[&[f32]], sr: f32) -> Loudness {
        let block = ((sr as f64) * 0.1).round().max(1.0) as usize;
        let n = channels.iter().map(|c| c.len()).min().unwrap_or(0);
        let nb = n.div_ceil(block);
        let mut blocks = vec![0f64; nb];
        let dual_mono = channels.len() == 1;
        for ch in channels.iter().take(2) {
            let (mut s1, mut s2) = k_filters(sr as f64);
            let mut acc = 0f64;
            let mut cnt = 0usize;
            let mut bi = 0usize;
            for &x in &ch[..n] {
                let x = if x.is_finite() { x as f64 } else { 0.0 };
                let y = s2.run(s1.run(x));
                acc += y * y;
                cnt += 1;
                if cnt == block {
                    blocks[bi] += acc / cnt as f64 * if dual_mono { 2.0 } else { 1.0 };
                    bi += 1;
                    acc = 0.0;
                    cnt = 0;
                }
            }
            if cnt > 0 && bi < nb {
                blocks[bi] += acc / cnt as f64 * if dual_mono { 2.0 } else { 1.0 };
            }
        }
        Loudness { block_sec: 0.1, blocks }
    }

    /// Short-term loudness (3 s window centred on i·hop) for i = 0..n.
    pub fn short_term_curve(&self, hop_sec: f32, duration: f32) -> Vec<f32> {
        let n = ((duration / hop_sec).ceil() as usize).max(1);
        let nb = self.blocks.len();
        (0..n)
            .map(|i| {
                let c = i as f32 * hop_sec / self.block_sec;
                let a = (c - 15.0).round().max(0.0) as usize;
                let b = ((c + 15.0).round().max(0.0) as usize).min(nb);
                if b <= a {
                    return LUFS_FLOOR;
                }
                lufs_of(self.blocks[a..b].iter().sum::<f64>() / (b - a) as f64)
            })
            .collect()
    }

    /// Gated integrated loudness of [t0, t1) seconds (BS.1770 gating with
    /// 400 ms blocks, 75 % overlap).
    pub fn integrated(&self, t0: f32, t1: f32) -> f32 {
        let nb = self.blocks.len();
        let a = ((t0 / self.block_sec).round().max(0.0) as usize).min(nb);
        let b = ((t1 / self.block_sec).round().max(0.0) as usize).min(nb);
        if b <= a {
            return LUFS_FLOOR;
        }
        let seg = &self.blocks[a..b];
        if seg.len() < 4 {
            return lufs_of(seg.iter().sum::<f64>() / seg.len() as f64);
        }
        let m: Vec<f64> = seg.windows(4).map(|w| w.iter().sum::<f64>() / 4.0).collect();
        let abs_gate = 10f64.powf((-70.0 + 0.691) / 10.0);
        let g1: Vec<f64> = m.iter().copied().filter(|&p| p > abs_gate).collect();
        if g1.is_empty() {
            return LUFS_FLOOR;
        }
        let rel = g1.iter().sum::<f64>() / g1.len() as f64 * 10f64.powf(-10.0 / 10.0);
        let g2: Vec<f64> = g1.into_iter().filter(|&p| p > rel).collect();
        if g2.is_empty() {
            return LUFS_FLOOR;
        }
        lufs_of(g2.iter().sum::<f64>() / g2.len() as f64)
    }
}
