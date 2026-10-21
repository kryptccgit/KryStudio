//! krypt.heat — three-band multiband saturator.
//!
//! The input is oversampled once (linear-phase halfband FIRs, blocks/oversample),
//! split at the oversampled rate by an LR4 crossover tree (blocks/crossover:
//! the three bands sum to an allpass, so with every band clean the device is
//! magnitude-flat), each band is driven into its own waveshaper (soft, tube,
//! tape, hard, fold, rectify or bitcrush), levelled, summed and decimated.
//! A DC blocker follows (tube / rectify make DC). Mix blends a dry copy that
//! is delayed by the oversampler latency AND passed through the crossover's
//! allpass, so a parallel blend does not notch at the split points. At Mix 0
//! the dry copy is the plain delayed input (bit-identical, latency-aligned).

use super::{frames, sane_sr, sanitize_block};
use crate::blocks::crossover::{Split3, Split3Allpass};
use crate::blocks::delay::DelayLine;
use crate::blocks::filters::DcBlock;
use crate::blocks::oversample::{Factor, Oversampler};
use crate::blocks::{db_to_gain, flush, tanh_fast, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

/// Waveshaper names (index = the `*Shape` param value).
pub(crate) const SHAPES: [&str; 7] = ["Soft", "Tube", "Tape", "Hard", "Fold", "Rectify", "Bitcrush"];
const BITCRUSH: usize = 6;

param_table! {
    LowFreq => logp("lowFreq", "Low / mid split", 40.0, 2000.0, 200.0, "Hz", "Crossover"),
    HighFreq => logp("highFreq", "Mid / high split", 400.0, 16000.0, 2500.0, "Hz", "Crossover"),
    LowDrive => lin("lowDrive", "Low drive", 0.0, 36.0, 6.0, "dB", "Low"),
    LowShape => choice("lowShape", "Low shape", &SHAPES, 1, "Low"),
    LowLevel => lin("lowLevel", "Low level", -24.0, 12.0, 0.0, "dB", "Low"),
    MidDrive => lin("midDrive", "Mid drive", 0.0, 36.0, 6.0, "dB", "Mid"),
    MidShape => choice("midShape", "Mid shape", &SHAPES, 2, "Mid"),
    MidLevel => lin("midLevel", "Mid level", -24.0, 12.0, 0.0, "dB", "Mid"),
    HighDrive => lin("highDrive", "High drive", 0.0, 36.0, 3.0, "dB", "High"),
    HighShape => choice("highShape", "High shape", &SHAPES, 0, "High"),
    HighLevel => lin("highLevel", "High level", -24.0, 12.0, 0.0, "dB", "High"),
    Oversample => choice("oversample", "Oversampling", &["Off", "2x", "4x"], 1, "Output"),
    Mix => lin("mix", "Mix", 0.0, 1.0, 1.0, "%", "Output"),
    Output => lin("output", "Output", -24.0, 12.0, 0.0, "dB", "Output"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.heat",
        name: "Krypt Heat",
        kind: PluginKind::Effect,
        category: "Distortion",
        description: "Multiband saturator: splits into low / mid / high (Linkwitz-Riley, two split points) and drives each \
                      band into its own shape (soft, tube, tape, hard, fold, rectify, bitcrush; for bitcrush Drive lowers \
                      the bit depth) with its own level. Warm the lows without mud, crunch only the mids, add air to the \
                      top. Half of each band's drive is compensated. Mix is phase-coherent parallel saturation. 2x \
                      oversampling = 35 samples latency (4x: 41, Off: 0).",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

const TUBE_BIAS: f32 = 0.3;

/// One waveshaper, unity small-signal gain (except rectify, which folds the
/// negative half up, and bitcrush, which quantizes to `levels` steps).
#[inline]
pub(crate) fn shape(kind: usize, x: f32, levels: f32) -> f32 {
    match kind {
        // algebraic sigmoid: a wider, gentler knee than tanh
        0 => x / (1.0 + x * x).sqrt(),
        // biased tanh, even harmonics; normalized to slope 1 at 0
        1 => {
            // the same approximation at the bias, so silence stays exactly 0
            let t0 = tanh_fast(TUBE_BIAS);
            (tanh_fast(x + TUBE_BIAS) - t0) * (1.0 / (1.0 - t0 * t0))
        }
        2 => tanh_fast(x),
        3 => x.clamp(-1.0, 1.0),
        // sine wavefolder (slope 1 at 0, folds back past ±π/2)
        4 => x.clamp(-1e4, 1e4).sin(),
        5 => tanh_fast(x).abs(),
        _ => (x.clamp(-1.0, 1.0) * levels).round() / levels,
    }
}

fn factor_of(i: usize) -> Factor {
    match i {
        0 => Factor::X1,
        2 => Factor::X4,
        _ => Factor::X2,
    }
}

/// Per-band gains, smoothed at the base rate.
#[derive(Clone, Copy)]
struct Band {
    shape: usize,
    levels: f32,
    pre: Smooth,
    post: Smooth,
}

pub struct Heat {
    pb: ParamBank<N_PARAMS>,
    /// snap smoothers on the first block after creation / prepare / reset
    fresh: bool,
    sr: f32,
    factor: Factor,
    os: [Oversampler; 2],
    split: [Split3; 2],
    dry_ap: [Split3Allpass; 2],
    dry_line: [DelayLine; 2],
    dc: [DcBlock; 2],
    bands: [Band; 3],
    mix: Smooth,
    out: Smooth,
    lat: usize,
}

impl Heat {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let sm = |v| Smooth::with_time(v, 15.0, sr);
        let band = Band { shape: 0, levels: 32768.0, pre: sm(1.0), post: sm(1.0) };
        let os = Oversampler::new();
        let max_lat = os.latency(Factor::X4);
        let mut h = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            factor: Factor::X2,
            os: [os.clone(), os],
            split: [Split3::default(); 2],
            dry_ap: [Split3Allpass::default(); 2],
            dry_line: [DelayLine::new(max_lat + 4), DelayLine::new(max_lat + 4)],
            dc: [DcBlock::new(5.0, sr); 2],
            bands: [band; 3],
            mix: sm(1.0),
            out: sm(1.0),
            lat: 0,
        };
        h.update();
        h.snap();
        h
    }

    fn update(&mut self) {
        let p = &self.pb;
        let factor = factor_of(p.idx(P::Oversample as usize));
        self.factor = factor;
        self.lat = self.os[0].latency(factor);
        let (lo, hi) = (p.get(P::LowFreq as usize) as f64, p.get(P::HighFreq as usize) as f64);
        let fs = self.sr as f64;
        let fs_os = fs * factor.ratio() as f64;
        for s in self.split.iter_mut() {
            s.set(lo, hi, fs_os);
        }
        for a in self.dry_ap.iter_mut() {
            a.set(lo, hi, fs);
        }
        let idx = [
            (P::LowDrive, P::LowShape, P::LowLevel),
            (P::MidDrive, P::MidShape, P::MidLevel),
            (P::HighDrive, P::HighShape, P::HighLevel),
        ];
        for (b, (d, s, l)) in idx.into_iter().enumerate() {
            let drive = p.get(d as usize);
            let kind = p.idx(s as usize).min(BITCRUSH);
            let level = db_to_gain(p.get(l as usize));
            let band = &mut self.bands[b];
            band.shape = kind;
            if kind == BITCRUSH {
                // Drive 0 dB = 16 bits (clean) … 36 dB = 3 bits
                let bits = 16.0 - drive * (13.0 / 36.0);
                band.levels = (bits - 1.0).exp2().max(2.0);
                band.pre.set(1.0);
                band.post.set(level);
            } else {
                band.levels = 32768.0;
                band.pre.set(db_to_gain(drive));
                // partial compensation: half the drive (in dB) is taken back
                band.post.set(db_to_gain(-0.5 * drive) * level);
            }
        }
        self.mix.set(p.get(P::Mix as usize));
        self.out.set(db_to_gain(p.get(P::Output as usize)));
    }

    fn snap(&mut self) {
        for b in self.bands.iter_mut() {
            b.pre.reset(b.pre.target);
            b.post.reset(b.post.target);
        }
        self.mix.reset(self.mix.target);
        self.out.reset(self.out.target);
    }
}

impl Effect for Heat {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Heat::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        self.snap();
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
        if index == P::Oversample as usize {
            // the engine reads latency() right after set_param
            self.lat = self.os[0].latency(factor_of(self.pb.idx(index)));
        }
    }

    fn latency(&self) -> usize {
        self.lat
    }

    fn process(&mut self, ctx: &ProcessContext, mut buf: [&mut [f32]; 2], _sc: Option<[&[f32]; 2]>) {
        let n = frames(ctx, &buf);
        if self.pb.take_dirty() {
            self.update();
        }
        if self.fresh {
            self.fresh = false;
            self.snap();
        }
        let (factor, lat) = (self.factor, self.lat);
        for i in 0..n {
            let mut pre = [0.0f32; 3];
            let mut post = [0.0f32; 3];
            for b in 0..3 {
                pre[b] = self.bands[b].pre.next();
                post[b] = self.bands[b].post.next();
            }
            let shapes = [self.bands[0].shape, self.bands[1].shape, self.bands[2].shape];
            let levels = [self.bands[0].levels, self.bands[1].levels, self.bands[2].levels];
            let mix = self.mix.next();
            let out = self.out.next();
            // below ~5 % mix the dry copy fades from plain to allpassed (phase-coherent blend)
            let phase_k = (mix * 20.0).min(1.0);
            for ch in 0..2 {
                let x = crate::blocks::finite(buf[ch][i]);
                let split = &mut self.split[ch];
                let wet = self.os[ch].process(x, factor, |v| {
                    let (l, m, h) = split.split(v as f64);
                    let bands = [l as f32, m as f32, h as f32];
                    let mut y = 0.0f32;
                    for b in 0..3 {
                        y += shape(shapes[b], bands[b] * pre[b], levels[b]) * post[b];
                    }
                    y
                });
                let wet = flush(self.dc[ch].tick(wet)) * out;
                self.dry_line[ch].push(x);
                let raw = if lat == 0 { x } else { self.dry_line[ch].read(lat) };
                if mix >= 1.0 {
                    // fully wet: the dry allpass is not heard (it restarts from rest when the mix comes down)
                    self.dry_ap[ch].reset();
                    buf[ch][i] = wet;
                    continue;
                }
                let ap = self.dry_ap[ch].tick(raw as f64) as f32;
                let dry = raw + (ap - raw) * phase_k;
                buf[ch][i] = dry * (1.0 - mix) + wet * mix;
            }
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.os.iter_mut().for_each(Oversampler::reset);
        self.split.iter_mut().for_each(Split3::reset);
        self.dry_ap.iter_mut().for_each(Split3Allpass::reset);
        self.dry_line.iter_mut().for_each(DelayLine::clear);
        self.dc.iter_mut().for_each(DcBlock::reset);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_have_unity_small_signal_gain_and_stay_bounded() {
        for k in 0..5 {
            let y = shape(k, 1e-3, 32768.0);
            assert!((y / 1e-3 - 1.0).abs() < 2e-3, "shape {k}: {y}");
            for x in [-50.0f32, -3.0, 3.0, 50.0] {
                // tube is asymmetric: its negative side reaches (1 + tanh 0.3) / sech² 0.3 ≈ 1.41
                let bound = if k == 1 { 1.42 } else { 1.0 + 1e-3 };
                assert!(shape(k, x, 32768.0).abs() <= bound, "shape {k} at {x}");
            }
        }
        assert_eq!(shape(BITCRUSH, 0.3, 4.0), 0.25);
        assert_eq!(shape(5, -0.5, 1.0), shape(5, 0.5, 1.0));
        assert_eq!(shape(0, 0.0, 1.0), 0.0);
        assert_eq!(shape(1, 0.0, 1.0), 0.0);
    }
}
