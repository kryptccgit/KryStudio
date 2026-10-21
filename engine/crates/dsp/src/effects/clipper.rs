//! krypt.clipper — soft/hard clipper at 1x/2x/4x oversampling. The curve is
//! linear up to (1 - softness) x ceiling, then a quadratic knee that lands
//! exactly on the ceiling with zero slope (C1-continuous, odd-symmetric).

use super::{frames, sane_sr, sanitize_block};
use crate::blocks::oversample::{Factor, Oversampler};
use crate::blocks::{db_to_gain, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Drive => lin("drive", "Drive", 0.0, 24.0, 0.0, "dB", "Clipper"),
    Ceiling => lin("ceiling", "Ceiling", -12.0, 0.0, -0.1, "dB", "Clipper"),
    Softness => lin("softness", "Softness", 0.0, 1.0, 0.5, "%", "Clipper"),
    Oversample => choice("oversample", "Oversampling", &["1x", "2x", "4x"], 1, "Clipper"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.clipper",
        name: "Krypt Clipper",
        kind: PluginKind::Effect,
        category: "Dynamics",
        description: "Soft/hard clipper with oversampling (2x: 35 samples latency, 4x: 41) to keep the clipping clean. \
                      Softness 0 is a hard clip; output never exceeds the ceiling. Loud drums without pumping.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

/// Clip curve with ceiling `c` and knee half-width `w` (0 = hard).
#[inline]
pub(crate) fn clip(x: f32, c: f32, w: f32) -> f32 {
    let a = x.abs();
    let y = if w <= 1e-9 {
        a.min(c)
    } else if a <= c - w {
        a
    } else if a >= c + w {
        c
    } else {
        let d = a - (c - w);
        a - d * d / (4.0 * w)
    };
    y.copysign(x)
}

fn factor_of(i: usize) -> Factor {
    match i {
        0 => Factor::X1,
        1 => Factor::X2,
        _ => Factor::X4,
    }
}

pub struct Clipper {
    pb: ParamBank<N_PARAMS>,
    /// snap smoothers on the first block after creation / prepare / reset
    fresh: bool,
    os: [Oversampler; 2],
    factor: Factor,
    drive: Smooth,
    ceil: Smooth,
    soft: Smooth,
    /// meter: dB the driven input went over the ceiling in the last block (>= 0)
    over_db: f32,
}

impl Clipper {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let mut s = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            os: [Oversampler::new(), Oversampler::new()],
            factor: Factor::X2,
            drive: Smooth::with_time(1.0, 10.0, sr),
            ceil: Smooth::with_time(1.0, 10.0, sr),
            soft: Smooth::with_time(0.5, 10.0, sr),
            over_db: 0.0,
        };
        s.update();
        s.drive.reset(s.drive.target);
        s.ceil.reset(s.ceil.target);
        s.soft.reset(s.soft.target);
        s
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.drive.set(db_to_gain(p.get(P::Drive as usize)));
        self.ceil.set(db_to_gain(p.get(P::Ceiling as usize)));
        self.soft.set(p.get(P::Softness as usize));
        let f = factor_of(p.idx(P::Oversample as usize));
        if f != self.factor {
            self.factor = f;
            self.os.iter_mut().for_each(Oversampler::reset);
        }
    }
}

impl Clipper {
    fn snap(&mut self) {
        self.drive.reset(self.drive.target);
        self.ceil.reset(self.ceil.target);
        self.soft.reset(self.soft.target);
    }
}

impl Effect for Clipper {
    fn prepare(&mut self, sample_rate: f32, _max_frames: usize) {
        self.fresh = true;
        let sr = sane_sr(sample_rate);
        self.drive.set_time(10.0, sr);
        self.ceil.set_time(10.0, sr);
        self.soft.set_time(10.0, sr);
        self.reset();
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn latency(&self) -> usize {
        // read the param directly: the engine asks right after set_param,
        // before the next process() applies it
        self.os[0].latency(factor_of(self.pb.idx(P::Oversample as usize)))
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
        let f = self.factor;
        let mut over = 0f32;
        for i in 0..n {
            let g = self.drive.next();
            let c = self.ceil.next();
            let w = self.soft.next().clamp(0.0, 1.0) * c * 0.999;
            for ch in 0..2 {
                let x = crate::blocks::finite(buf[ch][i]) * g;
                over = over.max(x.abs() / c.max(1e-6));
                let y = self.os[ch].process(x, f, |v| clip(v, c, w));
                buf[ch][i] = y.clamp(-c, c);
            }
        }
        self.over_db = if over > 1.0 && over.is_finite() { (20.0 * over.log10()).min(60.0) } else { 0.0 };
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.os.iter_mut().for_each(Oversampler::reset);
        self.over_db = 0.0;
    }

    fn meter(&self) -> Option<f32> {
        Some(self.over_db)
    }
}

#[cfg(test)]
mod tests {
    use super::clip;

    #[test]
    fn curve_is_continuous_and_bounded() {
        let (c, w) = (0.9, 0.3);
        let mut prev = clip(0.0, c, w);
        let mut x = 0.0;
        while x < 3.0 {
            x += 0.001;
            let y = clip(x, c, w);
            assert!(y <= c + 1e-6);
            assert!((y - prev).abs() < 0.0011);
            assert!(y >= prev - 1e-6);
            prev = y;
        }
        assert_eq!(clip(-5.0, c, 0.0), -c);
    }
}
