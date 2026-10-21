//! krypt.comp — feed-forward compressor after Giannoulis, Massberg & Reiss
//! ("Digital Dynamic Range Compressor Design", JAES 2012): stereo-linked
//! peak or RMS detector, soft-knee gain computer in dB, smooth branching
//! attack/release on the gain reduction, auto makeup, sidechain input.

use super::{frames, sane_sr, sanitize_block};
use crate::blocks::{db_to_gain, tc_coef, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Threshold => lin("threshold", "Threshold", -60.0, 0.0, -18.0, "dB", "Compressor"),
    Ratio => logp("ratio", "Ratio", 1.0, 20.0, 4.0, "x", "Compressor"),
    Attack => logp("attack", "Attack", 0.1, 200.0, 10.0, "ms", "Compressor"),
    Release => logp("release", "Release", 5.0, 2000.0, 120.0, "ms", "Compressor"),
    Knee => lin("knee", "Knee", 0.0, 24.0, 6.0, "dB", "Compressor"),
    Makeup => lin("makeup", "Makeup", 0.0, 24.0, 0.0, "dB", "Compressor"),
    AutoMakeup => toggle("autoMakeup", "Auto makeup", true, "Compressor"),
    UseSidechain => toggle("useSidechain", "Use sidechain input", false, "Compressor"),
    Detector => choice("detector", "Detector", &["Peak", "RMS"], 1, "Compressor"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.comp",
        name: "Krypt Comp",
        kind: PluginKind::Effect,
        category: "Dynamics",
        description: concat!(
            "Feed-forward compressor with soft knee, peak or RMS detection, auto makeup (adds back the average ",
            "gain reduction over ~1.5 s, so loudness stays about level) and an optional sidechain input (falls back to ",
            "its own input if none is routed). Zero latency."
        ),
        params: param_specs(),
        uses_sample: None,
        sidechain: Some(true),
        default_mix: Some(1.0),
    }
}

/// Static gain computer: returns gain change in dB (<= 0) for input level `x` dB.
#[inline]
pub(crate) fn gain_computer(x: f32, t: f32, r: f32, w: f32) -> f32 {
    let over = x - t;
    let y = if 2.0 * over < -w {
        x
    } else if w > 0.0 && 2.0 * over.abs() <= w {
        let z = over + w * 0.5;
        x + (1.0 / r - 1.0) * z * z / (2.0 * w)
    } else {
        t + over / r
    };
    (y - x).min(0.0)
}

pub struct Comp {
    pb: ParamBank<N_PARAMS>,
    /// snap smoothers on the first block after creation / prepare / reset
    fresh: bool,
    sr: f32,
    thr: f32,
    ratio: f32,
    knee: f32,
    att: f32,
    rel: f32,
    rms_coef: f32,
    use_sc: bool,
    rms: bool,
    ms: f32,
    gr: f32,
    makeup: Smooth,
    auto: bool,
    /// slow average of the gain reduction (dB) for auto makeup
    avg_gr: f32,
    avg_coef: f32,
}

impl Comp {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let mut c = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            thr: -18.0,
            ratio: 4.0,
            knee: 6.0,
            att: 0.0,
            rel: 0.0,
            rms_coef: tc_coef(8.0, sr),
            use_sc: false,
            rms: true,
            ms: 0.0,
            gr: 0.0,
            makeup: Smooth::with_time(1.0, 20.0, sr),
            auto: true,
            avg_gr: 0.0,
            avg_coef: tc_coef(1500.0, sr),
        };
        c.update();
        c.makeup.reset(c.makeup.target);
        c
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.thr = p.get(P::Threshold as usize);
        self.ratio = p.get(P::Ratio as usize).max(1.0);
        self.knee = p.get(P::Knee as usize);
        self.att = tc_coef(p.get(P::Attack as usize), self.sr);
        self.rel = tc_coef(p.get(P::Release as usize), self.sr);
        self.use_sc = p.on(P::UseSidechain as usize);
        self.rms = p.idx(P::Detector as usize) == 1;
        self.auto = p.on(P::AutoMakeup as usize);
        self.makeup.set(db_to_gain(p.get(P::Makeup as usize)));
    }
}

impl Comp {
    fn snap(&mut self) {
        self.makeup.reset(self.makeup.target);
    }
}

impl Effect for Comp {
    fn prepare(&mut self, sample_rate: f32, _max_frames: usize) {
        self.fresh = true;
        self.sr = sane_sr(sample_rate);
        self.rms_coef = tc_coef(8.0, self.sr);
        self.avg_coef = tc_coef(1500.0, self.sr);
        self.makeup.set_time(20.0, self.sr);
        self.update();
        self.reset();
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn process(&mut self, ctx: &ProcessContext, mut buf: [&mut [f32]; 2], sidechain: Option<[&[f32]; 2]>) {
        let n = frames(ctx, &buf);
        if self.pb.take_dirty() {
            self.update();
        }
        if self.fresh {
            self.fresh = false;
            self.snap();
        }
        let sc = if self.use_sc { sidechain.filter(|s| s[0].len() >= n && s[1].len() >= n) } else { None };
        for i in 0..n {
            let (dl, dr) = match sc {
                Some(s) => (s[0][i], s[1][i]),
                None => (buf[0][i], buf[1][i]),
            };
            let (dl, dr) = (crate::blocks::finite(dl), crate::blocks::finite(dr));
            let level = if self.rms {
                let x2 = 0.5 * (dl * dl + dr * dr);
                self.ms += (x2 - self.ms) * self.rms_coef;
                self.ms = crate::blocks::flush(self.ms);
                // RMS of a sine reads 3 dB under its peak; +3 dB keeps thresholds peak-referenced
                (2.0 * self.ms).sqrt()
            } else {
                dl.abs().max(dr.abs())
            };
            let xdb = if level > 1e-9 { 20.0 * level.log10() } else { -180.0 };
            let target = -gain_computer(xdb, self.thr, self.ratio, self.knee); // reduction >= 0
            let c = if target > self.gr { self.att } else { self.rel };
            self.gr += (target - self.gr) * c;
            if self.gr < 1e-6 {
                self.gr = 0.0;
            }
            // auto makeup follows the average reduction while signal is present
            if self.auto && xdb > -60.0 {
                self.avg_gr += (self.gr - self.avg_gr) * self.avg_coef;
            }
            let auto_db = if self.auto { self.avg_gr } else { 0.0 };
            let g = db_to_gain(auto_db - self.gr) * self.makeup.next();
            buf[0][i] *= g;
            buf[1][i] *= g;
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.ms = 0.0;
        self.gr = 0.0;
        self.avg_gr = 0.0;
    }

    fn meter(&self) -> Option<f32> {
        Some(self.gr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knee_is_continuous_and_ratio_correct() {
        let (t, r, w) = (-20.0, 4.0, 6.0);
        assert_eq!(gain_computer(-40.0, t, r, w), 0.0);
        let g = gain_computer(0.0, t, r, w);
        assert!((g - (-15.0)).abs() < 1e-4, "{g}");
        // continuity at knee edges
        let a = gain_computer(-23.0 - 1e-4, t, r, w);
        let b = gain_computer(-23.0 + 1e-4, t, r, w);
        assert!((a - b).abs() < 1e-3);
        let a = gain_computer(-17.0 - 1e-4, t, r, w);
        let b = gain_computer(-17.0 + 1e-4, t, r, w);
        assert!((a - b).abs() < 1e-3, "{a} {b}");
    }
}
