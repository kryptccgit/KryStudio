//! krypt.deesser — split-band de-esser (Auto Mix, research/20 §8).
//!
//! The input is split at `frequency` (4–10 kHz) by a Linkwitz–Riley 24 dB/oct
//! crossover (blocks::crossover::Lr4). The high band is the sidechain: a
//! stereo-linked peak envelope (0.2 ms attack, 30 ms decay) feeds a 6:1,
//! 6 dB soft-knee gain computer (effects::comp::gain_computer) whose
//! reduction is capped at `range` and smoothed (0.5 ms attack, 60 ms
//! release). Only the HIGH band is turned down; the low band passes
//! untouched, so a voice keeps its body while the "s" sounds shrink.
//!
//! Output = low + high · k with k = 1 − mix · (1 − g): the two LR4 bands sum
//! to an allpass, so with no reduction (or mix 0) the magnitude response is
//! exactly flat. `listen` solos the high band (what the detector hears).
//! Zero latency, no allocation in `process`, denormal-safe.

use super::comp::gain_computer;
use super::{frames, sane_sr, sanitize_block};
use crate::blocks::crossover::Lr4;
use crate::blocks::{db_to_gain, finite, flush, tc_coef, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

const RATIO: f32 = 6.0;
const KNEE: f32 = 6.0;
const ENV_ATTACK_MS: f32 = 0.2;
const ENV_DECAY_MS: f32 = 30.0;
const GR_ATTACK_MS: f32 = 0.5;
const GR_RELEASE_MS: f32 = 60.0;

param_table! {
    Frequency => logp("frequency", "Frequency", 4000.0, 10000.0, 6000.0, "Hz", "De-esser"),
    Threshold => lin("threshold", "Threshold", -60.0, 0.0, -30.0, "dB", "De-esser"),
    Range => lin("range", "Range", 0.0, 24.0, 8.0, "dB", "De-esser"),
    Listen => toggle("listen", "Listen", false, "De-esser"),
    Mix => lin("mix", "Mix", 0.0, 1.0, 1.0, "%", "Output"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.deesser",
        name: "Krypt De-Esser",
        kind: PluginKind::Effect,
        category: "Dynamics",
        description: "Split-band de-esser for vocals: everything above Frequency (4-10 kHz, usually 5-8 kHz) is \
                      compressed when it gets louder than Threshold, by at most Range dB; the body of the voice below \
                      the split is never touched. Listen solos the band it reacts to, to find the 's' sounds. Mix \
                      blends the reduction in. Typical: 6-7 kHz, 4-8 dB of reduction on the loudest 's'. Zero latency.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

pub struct DeEsser {
    pb: ParamBank<N_PARAMS>,
    /// snap smoothers on the first block after creation / prepare / reset
    fresh: bool,
    sr: f32,
    freq: f32,
    split: [Lr4; 2],
    thr: f32,
    range: f32,
    listen: bool,
    env_att: f32,
    env_dec: f32,
    gr_att: f32,
    gr_rel: f32,
    /// sidechain peak envelope (linear) and the applied reduction (dB, >= 0)
    env: f32,
    gr: f32,
    mix: Smooth,
    /// high-band gain applied on the last sample (for the meter)
    k_last: f32,
}

impl DeEsser {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let mut d = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            freq: 0.0,
            split: [Lr4::default(); 2],
            thr: -30.0,
            range: 8.0,
            listen: false,
            env_att: tc_coef(ENV_ATTACK_MS, sr),
            env_dec: tc_coef(ENV_DECAY_MS, sr),
            gr_att: tc_coef(GR_ATTACK_MS, sr),
            gr_rel: tc_coef(GR_RELEASE_MS, sr),
            env: 0.0,
            gr: 0.0,
            mix: Smooth::with_time(1.0, 15.0, sr),
            k_last: 1.0,
        };
        d.update();
        d.mix.reset(d.mix.target);
        d
    }

    fn update(&mut self) {
        let p = &self.pb;
        let f = p.get(P::Frequency as usize);
        if (f - self.freq).abs() > 1e-3 {
            self.freq = f;
            for s in self.split.iter_mut() {
                s.set(f as f64, self.sr as f64);
            }
        }
        self.thr = p.get(P::Threshold as usize);
        self.range = p.get(P::Range as usize).max(0.0);
        self.listen = p.on(P::Listen as usize);
        self.mix.set(p.get(P::Mix as usize));
    }

    /// Current reduction of the high band in dB (>= 0) before the mix, for tests.
    pub fn gain_reduction_db(&self) -> f32 {
        self.gr
    }
}

impl Effect for DeEsser {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: [f32; N_PARAMS] = std::array::from_fn(|i| self.pb.get(i));
        *self = DeEsser::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        self.mix.reset(self.mix.target);
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn process(&mut self, ctx: &ProcessContext, mut buf: [&mut [f32]; 2], _sidechain: Option<[&[f32]; 2]>) {
        let n = frames(ctx, &buf);
        if self.pb.take_dirty() {
            self.update();
        }
        if self.fresh {
            self.fresh = false;
            self.mix.reset(self.mix.target);
        }
        for i in 0..n {
            let (xl, xr) = (finite(buf[0][i]), finite(buf[1][i]));
            let (ll, hl) = self.split[0].split(xl as f64);
            let (lr, hr) = self.split[1].split(xr as f64);
            let (ll, hl, lr, hr) = (ll as f32, hl as f32, lr as f32, hr as f32);
            // sidechain: the high band's stereo-linked peak envelope
            let level = hl.abs().max(hr.abs());
            let c = if level > self.env { self.env_att } else { self.env_dec };
            self.env = flush(self.env + (level - self.env) * c);
            let xdb = if self.env > 1e-9 { 20.0 * self.env.log10() } else { -180.0 };
            let target = (-gain_computer(xdb, self.thr, RATIO, KNEE)).min(self.range);
            let c = if target > self.gr { self.gr_att } else { self.gr_rel };
            self.gr += (target - self.gr) * c;
            if self.gr < 1e-6 {
                self.gr = 0.0;
            }
            let mix = self.mix.next();
            let k = 1.0 - mix * (1.0 - db_to_gain(-self.gr));
            self.k_last = k;
            if self.listen {
                buf[0][i] = hl;
                buf[1][i] = hr;
            } else {
                buf[0][i] = ll + hl * k;
                buf[1][i] = lr + hr * k;
            }
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.env = 0.0;
        self.gr = 0.0;
        self.k_last = 1.0;
        self.split.iter_mut().for_each(Lr4::reset);
    }

    fn meter(&self) -> Option<f32> {
        // how far the "s" band is turned down right now, after the mix
        let k = self.k_last;
        Some(if k > 1e-6 && k < 1.0 { -20.0 * k.log10() } else { 0.0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48000.0;
    const SUB: usize = 32;

    fn make(params: &[(P, f32)]) -> DeEsser {
        let mut d = DeEsser::new(SR, 512);
        for (p, v) in params {
            d.set_param(*p as usize, *v);
        }
        d
    }

    /// Run a mono signal (both channels) through in 32-frame blocks; returns (left output, meter per block).
    fn run(d: &mut DeEsser, input: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let mut out = Vec::with_capacity(input.len());
        let mut meters = Vec::new();
        let mut at = 0;
        while at < input.len() {
            let n = SUB.min(input.len() - at);
            let mut l = input[at..at + n].to_vec();
            let mut r = l.clone();
            let ctx = ProcessContext { sample_rate: SR, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: n };
            d.process(&ctx, [&mut l, &mut r], None);
            out.extend_from_slice(&l);
            meters.push(d.meter().unwrap());
            at += n;
        }
        (out, meters)
    }

    fn rms_db(x: &[f32]) -> f32 {
        let p = x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len().max(1) as f64;
        (10.0 * p.max(1e-30).log10()) as f32
    }

    fn sine(hz: f32, amp: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| amp * (std::f32::consts::TAU * hz * i as f32 / SR).sin()).collect()
    }

    /// A synthetic "s": white noise high-passed at 5 kHz (two cascaded 2nd-order sections), 150 ms, after 100 ms of
    /// a quiet 220 Hz "voice".
    fn s_burst() -> (Vec<f32>, std::ops::Range<usize>) {
        use crate::blocks::filters::{Svf, SvfMode};
        let mut seed = 0x1234_5678u32;
        let (mut hp1, mut hp2) = (Svf::default(), Svf::default());
        for f in [&mut hp1, &mut hp2] {
            f.design(SvfMode::Highpass, 5000.0, std::f64::consts::FRAC_1_SQRT_2, 0.0, SR as f64);
        }
        let pre = 4800;
        let len = 7200;
        let mut x = sine(220.0, 0.05, pre + len);
        for v in x.iter_mut().skip(pre) {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let w = (seed as f32 / u32::MAX as f32) * 2.0 - 1.0;
            let h = hp2.tick(hp1.tick(w as f64)) as f32;
            *v += 0.6 * h;
        }
        (x, pre + 1200..pre + len)
    }

    #[test]
    fn an_s_burst_is_turned_down_in_the_sibilance_band() {
        let (x, burst) = s_burst();
        let mut d = make(&[(P::Frequency, 6000.0), (P::Threshold, -40.0), (P::Range, 10.0)]);
        let (y, meters) = run(&mut d, &x);
        let drop = rms_db(&x[burst.clone()]) - rms_db(&y[burst.clone()]);
        assert!(drop > 4.0, "the burst should come down by several dB: {drop} dB");
        let peak_meter = meters.iter().cloned().fold(0.0f32, f32::max);
        assert!(peak_meter > 6.0 && peak_meter <= 10.0 + 1e-3, "meter shows the reduction, capped at the range: {peak_meter}");
        // before the burst (the quiet low "voice") nothing is reduced
        assert!(meters[4800 / SUB - 2] < 0.05, "no reduction on the voice: {}", meters[4800 / SUB - 2]);
    }

    #[test]
    fn a_tone_well_inside_the_band_settles_at_the_range() {
        // 20 dB over the threshold at 6:1 wants 16.7 dB; Range caps it at 8 dB (10 kHz sits 1.3 octaves above a
        // 4 kHz split, so almost all of it is in the high band)
        let x = sine(10000.0, 0.316, 24000);
        let mut d = make(&[(P::Frequency, 4000.0), (P::Threshold, -30.0), (P::Range, 8.0)]);
        let (y, meters) = run(&mut d, &x);
        let tail = 12000..24000;
        let drop = rms_db(&x[tail.clone()]) - rms_db(&y[tail]);
        assert!((drop - 8.0).abs() < 0.6, "10 kHz comes down by the range: {drop} dB");
        assert!((meters.last().unwrap() - 8.0).abs() < 0.2, "meter {}", meters.last().unwrap());
    }

    #[test]
    fn transparent_on_a_low_tone() {
        let x = sine(200.0, 0.5, 24000);
        let mut d = make(&[(P::Threshold, -50.0), (P::Range, 24.0)]);
        let (y, meters) = run(&mut d, &x);
        assert!(meters.iter().all(|m| *m < 0.01), "no reduction on a 200 Hz tone");
        let diff = (rms_db(&x[4800..]) - rms_db(&y[4800..])).abs();
        assert!(diff < 0.02, "level unchanged: {diff} dB");
    }

    #[test]
    fn mix_zero_is_the_dry_level() {
        let x = sine(7000.0, 0.5, 24000);
        let mut d = make(&[(P::Threshold, -40.0), (P::Range, 20.0), (P::Mix, 0.0)]);
        let (y, meters) = run(&mut d, &x);
        assert!(meters.iter().all(|m| *m == 0.0), "mix 0 reduces nothing");
        let diff = (rms_db(&x[4800..]) - rms_db(&y[4800..])).abs();
        assert!(diff < 0.02, "mix 0 keeps the dry level: {diff} dB");
        // half mix is in between
        let mut h = make(&[(P::Threshold, -40.0), (P::Range, 20.0), (P::Mix, 0.5)]);
        let (yh, _) = run(&mut h, &x);
        let dh = rms_db(&x[12000..]) - rms_db(&yh[12000..]);
        assert!(dh > 2.0 && dh < 7.0, "half mix: {dh} dB");
    }

    #[test]
    fn listen_solos_the_sibilance_band() {
        let low = sine(200.0, 0.5, 24000);
        let mut d = make(&[(P::Listen, 1.0)]);
        let (y, _) = run(&mut d, &low);
        assert!(rms_db(&y[4800..]) < -80.0, "a 200 Hz tone is not in the band: {}", rms_db(&y[4800..]));
        let hi = sine(12000.0, 0.5, 24000);
        let mut d = make(&[(P::Listen, 1.0), (P::Threshold, 0.0), (P::Frequency, 4000.0)]);
        let (y, _) = run(&mut d, &hi);
        assert!((rms_db(&y[4800..]) - rms_db(&hi[4800..])).abs() < 0.5, "12 kHz passes in listen");
    }

    #[test]
    fn finite_and_denormal_safe() {
        let mut d = make(&[(P::Threshold, -60.0), (P::Range, 24.0)]);
        let mut x = sine(7000.0, 1.0, 4800);
        x[100] = f32::NAN;
        x[200] = f32::INFINITY;
        x[300] = f32::NEG_INFINITY;
        x.extend(std::iter::repeat(1e-38f32).take(48000));
        x.extend(std::iter::repeat(0.0f32).take(48000));
        let (y, meters) = run(&mut d, &x);
        assert!(y.iter().all(|v| v.is_finite()), "finite output");
        assert!(meters.iter().all(|m| m.is_finite() && *m >= 0.0));
        let tail = &y[y.len() - 4800..];
        assert!(tail.iter().all(|v| *v == 0.0 || v.is_normal()), "no denormals after silence");
        assert!(d.env == 0.0 || d.env.is_normal());
        // every parameter at both ends stays finite
        for (p, lo, hi) in [(P::Frequency, 4000.0, 10000.0), (P::Threshold, -60.0, 0.0), (P::Range, 0.0, 24.0), (P::Mix, 0.0, 1.0)] {
            for v in [lo, hi, f32::NAN] {
                let mut e = make(&[(p, v)]);
                let (y, _) = run(&mut e, &sine(6500.0, 0.9, 4800));
                assert!(y.iter().all(|s| s.is_finite()), "{p:?} = {v}");
            }
        }
    }
}
