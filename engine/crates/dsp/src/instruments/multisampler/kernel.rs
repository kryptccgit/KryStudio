//! Polyphase kernels for playback FASTER than the source rate (pitching up).
//!
//! At or below the source rate the multisampler uses the sampler's
//! `SincTable` fast path. Above it, `SincTable` evaluates the stretched
//! kernel tap by tap for every output sample, which is 4–5× the cost; a
//! multisampled piano pitches half its notes up by a semitone or two, so this
//! bank precomputes the same Kaiser-windowed sinc (β 8, 12 zero crossings,
//! 0.96 of the new Nyquist) per semitone band up to two octaves. A step in
//! band b, `2^((b-1)/12) < step <= 2^(b/12)`, uses band b's cutoff: at most
//! one semitone lower than ideal, so it never aliases. Built once per process
//! (`bank()`, forced in `Multisampler::new`, never on the audio thread).

use crate::blocks::oversample::bessel_i0;
use crate::blocks::sinc::{BANDWIDTH, HALF_WIDTH, MAX_TAPS, MIN_CUTOFF};
use std::sync::OnceLock;

const PHASES: usize = 512;
const BETA: f64 = 8.0;
/// Semitone bands from just above 1× up to 1 / MIN_CUTOFF (two octaves).
pub(crate) const BANDS: usize = 24;

pub(crate) struct Band {
    taps: usize,
    hw: usize,
    /// (PHASES + 1) normalized rows of `taps`.
    rows: Vec<f32>,
}

pub(crate) struct KernelBank {
    bands: Vec<Band>,
}

fn kernel(u: f64) -> f64 {
    let x = u.abs();
    let hw = HALF_WIDTH as f64;
    if x >= hw {
        return 0.0;
    }
    let s = if x == 0.0 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
    let r = x / hw;
    s * bessel_i0(BETA * (1.0 - r * r).max(0.0).sqrt()) / bessel_i0(BETA)
}

impl KernelBank {
    fn build() -> Self {
        let bands = (1..=BANDS)
            .map(|b| {
                let step = 2f64.powf(b as f64 / 12.0);
                // same (f32) arithmetic as SincTable::weights, so the tap counts agree
                let cf = ((1.0 / step) as f32).clamp(MIN_CUTOFF, 1.0) * BANDWIDTH;
                let hw = ((HALF_WIDTH as f32 / cf).ceil() as usize).min(MAX_TAPS / 2);
                let c = cf as f64;
                let taps = 2 * hw;
                let mut rows = vec![0.0f32; (PHASES + 1) * taps];
                for ph in 0..=PHASES {
                    let frac = ph as f64 / PHASES as f64;
                    let row = &mut rows[ph * taps..(ph + 1) * taps];
                    let mut sum = 0.0f64;
                    let vals: Vec<f64> = (0..taps).map(|j| kernel(((j as f64 - hw as f64 + 1.0) - frac) * c)).collect();
                    for v in &vals {
                        sum += v;
                    }
                    for (dst, v) in row.iter_mut().zip(&vals) {
                        *dst = (v / sum) as f32;
                    }
                }
                Band { taps, hw, rows }
            })
            .collect();
        Self { bands }
    }

    /// [RT] The band for a playback step > 1.
    #[inline]
    pub fn band(&self, step: f64) -> &Band {
        let b = (12.0 * step.max(1.0).log2() - 1e-9).ceil().clamp(1.0, BANDS as f64) as usize;
        &self.bands[b - 1]
    }
}

impl Band {
    /// [RT] Weights for reading at `pos`; returns (first source index, taps).
    #[inline]
    pub fn weights(&self, pos: f64, w: &mut [f32; MAX_TAPS]) -> (i64, usize) {
        let i0 = pos.floor();
        let x = ((pos - i0) * PHASES as f64) as f32;
        let p = (x as usize).min(PHASES - 1);
        let a = x - p as f32;
        let n = self.taps;
        let r0 = &self.rows[p * n..(p + 1) * n];
        let r1 = &self.rows[(p + 1) * n..(p + 2) * n];
        for ((wj, &u), &v) in w.iter_mut().zip(r0).zip(r1) {
            *wj = u + (v - u) * a;
        }
        (i0 as i64 - self.hw as i64 + 1, n)
    }
}

static BANK: OnceLock<KernelBank> = OnceLock::new();

/// The process-wide bank (built on first use: call it off the audio thread first).
pub(crate) fn bank() -> &'static KernelBank {
    BANK.get_or_init(KernelBank::build)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::sinc::SincTable;

    #[test]
    fn bands_match_the_sampler_kernel() {
        let t = SincTable::new();
        let bank = bank();
        let mut a = [0.0f32; MAX_TAPS];
        let mut b = [0.0f32; MAX_TAPS];
        // exactly on a band edge the cutoffs agree: same weights as SincTable
        for semis in [1, 2, 7, 12, 24] {
            let step = 2f64.powf(semis as f64 / 12.0);
            for pos in [10.0, 10.25, 10.5, 10.731] {
                let (f1, n1) = t.weights(pos, step, &mut a);
                let (f2, n2) = bank.band(step).weights(pos, &mut b);
                assert_eq!((f1, n1), (f2, n2), "{semis} st");
                let err = a[..n1].iter().zip(&b[..n2]).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max);
                assert!(err < 2e-3, "{semis} st @ {pos}: {err}");
            }
        }
        // band choice rounds the step UP (lower cutoff: no aliasing)
        assert_eq!(bank.band(1.0001).taps, bank.bands[0].taps);
        assert!(std::ptr::eq(bank.band(2f64.powf(1.5 / 12.0)), &bank.bands[1]));
        assert!(std::ptr::eq(bank.band(100.0), &bank.bands[BANDS - 1]));
    }
}
