//! krypt.drive — waveshaping distortion at 2x oversampling with first-order
//! antiderivative anti-aliasing (ADAA, Parker/Zavalishin/Le Bivic 2016),
//! plus a bitcrusher. Tone is a 12 dB/oct low pass after the shaper.

use super::{frames, sane_sr, sanitize_block};
use crate::blocks::filters::{DcBlock, Svf, SvfMode};
use crate::blocks::oversample::{Factor, Oversampler};
use crate::blocks::{db_to_gain, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Mode => choice("mode", "Mode", &["Tape", "Tube", "Hard", "Fold", "Bitcrush"], 0, "Drive"),
    Drive => lin("drive", "Drive", 0.0, 48.0, 6.0, "dB", "Drive"),
    Bits => stepped("bits", "Bits (crush)", 1.0, 16.0, 12.0, "", 1.0, "Drive"),
    Downsample => stepped("downsample", "Downsample (crush)", 1.0, 32.0, 1.0, "x", 1.0, "Drive"),
    Tone => logp("tone", "Tone", 500.0, 20000.0, 12000.0, "Hz", "Drive"),
    Output => lin("output", "Output", -24.0, 12.0, 0.0, "dB", "Drive"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.drive",
        name: "Krypt Drive",
        kind: PluginKind::Effect,
        category: "Distortion",
        description: "Saturation and distortion: tape (soft), tube (asymmetric, even harmonics), hard clip, wavefolder and \
                      bitcrusher (bits + sample-rate reduction). 2x oversampling + ADAA keep it clean (35 samples latency). \
                      Partial level compensation: +6 dB of drive adds about +3 dB of level before saturation.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

const TUBE_BIAS: f64 = 0.25;

#[inline]
fn shaper(mode: usize, x: f64) -> f64 {
    match mode {
        0 => x.tanh(),
        1 => (x + TUBE_BIAS).tanh() - TUBE_BIAS.tanh(),
        2 => x.clamp(-1.0, 1.0),
        _ => (x * std::f64::consts::FRAC_PI_2).sin(),
    }
}

/// Antiderivative of `shaper`.
#[inline]
fn shaper_ad(mode: usize, x: f64) -> f64 {
    match mode {
        0 => log_cosh(x),
        1 => log_cosh(x + TUBE_BIAS) - TUBE_BIAS.tanh() * x,
        2 => {
            if x.abs() <= 1.0 {
                0.5 * x * x
            } else {
                x.abs() - 0.5
            }
        }
        _ => -(x * std::f64::consts::FRAC_PI_2).cos() / std::f64::consts::FRAC_PI_2,
    }
}

#[inline]
fn log_cosh(x: f64) -> f64 {
    let a = x.abs();
    // ln(cosh x) = |x| + ln(1 + e^{-2|x|}) - ln 2, stable for large |x|
    a + (-2.0 * a).exp().ln_1p() - std::f64::consts::LN_2
}

/// First-order ADAA state for one channel. `ad1` must always be the
/// antiderivative of `x1` in the CURRENT mode: Tube's and Fold's
/// antiderivatives aren't 0 at 0, so a zeroed state (after new / reset) or a
/// mode switch mid-stream would divide a large jump by a tiny dx and spike
/// to ~80x full scale on the next sample.
#[derive(Clone, Copy)]
struct Adaa {
    x1: f64,
    ad1: f64,
    /// Mode `ad1` was computed in; usize::MAX = not yet.
    mode: usize,
}

impl Default for Adaa {
    fn default() -> Self {
        Self { x1: 0.0, ad1: 0.0, mode: usize::MAX }
    }
}

impl Adaa {
    #[inline]
    fn tick(&mut self, mode: usize, x: f64) -> f64 {
        if self.mode != mode {
            self.ad1 = shaper_ad(mode, self.x1);
            self.mode = mode;
        }
        let ad = shaper_ad(mode, x);
        let dx = x - self.x1;
        let y = if dx.abs() < 1e-6 { shaper(mode, 0.5 * (x + self.x1)) } else { (ad - self.ad1) / dx };
        self.x1 = x;
        self.ad1 = ad;
        y
    }
}

pub struct Drive {
    pb: ParamBank<N_PARAMS>,
    /// snap smoothers on the first block after creation / prepare / reset
    fresh: bool,
    sr: f32,
    os: [Oversampler; 2],
    adaa: [Adaa; 2],
    tone: [Svf; 2],
    dc: [DcBlock; 2],
    mode: usize,
    drive: Smooth,
    comp: Smooth,
    out: Smooth,
    levels: f32,
    hold: u32,
    hold_ctr: [u32; 2],
    held: [f32; 2],
}

impl Drive {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let mut d = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            os: [Oversampler::new(), Oversampler::new()],
            adaa: [Adaa::default(); 2],
            tone: [Svf::default(); 2],
            dc: [DcBlock::new(5.0, sr); 2],
            mode: 0,
            drive: Smooth::with_time(1.0, 15.0, sr),
            comp: Smooth::with_time(1.0, 15.0, sr),
            out: Smooth::with_time(1.0, 15.0, sr),
            levels: 2048.0,
            hold: 1,
            hold_ctr: [0; 2],
            held: [0.0; 2],
        };
        d.update();
        d.drive.reset(d.drive.target);
        d.comp.reset(d.comp.target);
        d.out.reset(d.out.target);
        d
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.mode = p.idx(P::Mode as usize).min(4);
        let ddb = p.get(P::Drive as usize);
        self.drive.set(db_to_gain(ddb));
        self.comp.set(db_to_gain(-0.5 * ddb));
        self.out.set(db_to_gain(p.get(P::Output as usize)));
        let bits = p.get(P::Bits as usize).clamp(1.0, 16.0);
        self.levels = (bits - 1.0).exp2().max(1.0);
        // downsample factor at the 2x rate
        self.hold = (p.get(P::Downsample as usize).round().max(1.0) as u32) * 2;
        let tone = (p.get(P::Tone as usize) as f64).min(self.sr as f64 * 0.45);
        for t in self.tone.iter_mut() {
            t.design(SvfMode::Lowpass, tone, 0.707, 0.0, self.sr as f64);
        }
    }
}

impl Drive {
    fn snap(&mut self) {
        self.drive.reset(self.drive.target);
        self.comp.reset(self.comp.target);
        self.out.reset(self.out.target);
    }
}

impl Effect for Drive {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Drive::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        self.drive.reset(self.drive.target);
        self.comp.reset(self.comp.target);
        self.out.reset(self.out.target);
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn latency(&self) -> usize {
        self.os[0].latency(Factor::X2)
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
        let mode = self.mode;
        for i in 0..n {
            let g = self.drive.next();
            let c = self.comp.next();
            let o = self.out.next();
            for ch in 0..2 {
                let x = crate::blocks::finite(buf[ch][i]) * g;
                let adaa = &mut self.adaa[ch];
                let y = if mode < 4 {
                    self.os[ch].process(x, Factor::X2, |v| adaa.tick(mode, v as f64) as f32)
                } else {
                    let (levels, hold) = (self.levels, self.hold);
                    let (ctr, held) = (&mut self.hold_ctr[ch], &mut self.held[ch]);
                    self.os[ch].process(x, Factor::X2, |v| {
                        if *ctr == 0 {
                            let q = (v.clamp(-1.0, 1.0) * levels).round() / levels;
                            *held = q;
                            *ctr = hold;
                        }
                        *ctr -= 1;
                        *held
                    })
                };
                let y = self.tone[ch].tick(y as f64) as f32;
                let y = self.dc[ch].tick(y);
                // partial compensation: half the drive gain is taken back
                buf[ch][i] = y * c * o;
            }
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.os.iter_mut().for_each(Oversampler::reset);
        self.adaa = [Adaa::default(); 2];
        self.tone.iter_mut().for_each(Svf::reset);
        self.dc.iter_mut().for_each(DcBlock::reset);
        self.hold_ctr = [0; 2];
        self.held = [0.0; 2];
    }
}
