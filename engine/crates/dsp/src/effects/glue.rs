//! krypt.glue — VCA-style bus compressor.
//!
//! Feed-forward, stereo-linked peak detector (optionally high-passed, so the
//! kick does not pump the whole bus), a 6 dB soft-knee gain computer in dB
//! (crate::effects::comp::gain_computer) with switched ratios (2 / 4 / 10),
//! and smooth branching attack / release on the gain reduction with the
//! classic switched times. Auto release is program dependent: a fast
//! release (150 ms) for short peaks and a slow one (1.2 s) that only builds
//! up under sustained compression (the reduction is the larger of the two).
//! Range caps the reduction; Mix is a parallel blend (zero latency, so it is
//! phase-exact). The external sidechain input works like Krypt Comp's.

use super::comp::gain_computer;
use super::{frames, sane_sr, sanitize_block};
use crate::blocks::filters::{Svf, SvfMode};
use crate::blocks::{db_to_gain, tc_coef, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

const RATIOS: [f32; 3] = [2.0, 4.0, 10.0];
const ATTACK_MS: [f32; 6] = [0.1, 0.3, 1.0, 3.0, 10.0, 30.0];
const RELEASE_MS: [f32; 4] = [100.0, 300.0, 600.0, 1200.0];
const AUTO: usize = 4;
const SC_HPF_HZ: [f32; 7] = [0.0, 60.0, 90.0, 120.0, 150.0, 200.0, 300.0];
const KNEE: f32 = 6.0;

param_table! {
    Threshold => lin("threshold", "Threshold", -40.0, 0.0, -10.0, "dB", "Compressor"),
    Ratio => choice("ratio", "Ratio", &["2:1", "4:1", "10:1"], 0, "Compressor"),
    Attack => choice("attack", "Attack", &["0.1 ms", "0.3 ms", "1 ms", "3 ms", "10 ms", "30 ms"], 4, "Compressor"),
    Release => choice("release", "Release", &["0.1 s", "0.3 s", "0.6 s", "1.2 s", "Auto"], 4, "Compressor"),
    Makeup => lin("makeup", "Makeup", 0.0, 24.0, 0.0, "dB", "Compressor"),
    Range => lin("range", "Range", 0.0, 40.0, 40.0, "dB", "Compressor"),
    ScHpf => choice("scHpf", "Sidechain HPF", &["Off", "60 Hz", "90 Hz", "120 Hz", "150 Hz", "200 Hz", "300 Hz"], 0, "Sidechain"),
    UseSidechain => toggle("useSidechain", "Use sidechain input", false, "Sidechain"),
    Mix => lin("mix", "Mix", 0.0, 1.0, 1.0, "%", "Output"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.glue",
        name: "Krypt Glue",
        kind: PluginKind::Effect,
        category: "Dynamics",
        description: "VCA-style bus compressor that glues a drum bus, a mix bus or the master: switched ratio (2:1, 4:1, \
                      10:1), attack (0.1-30 ms) and release (0.1-1.2 s or Auto, which recovers fast after peaks and \
                      slowly under steady compression). Sidechain HPF keeps the kick from pumping the bus; Range caps the \
                      gain reduction; Mix is parallel compression. Optional external sidechain input. Typical glue: 2:1, \
                      10 ms or 30 ms attack, Auto release, 2-4 dB of reduction. Zero latency.",
        params: param_specs(),
        uses_sample: None,
        sidechain: Some(true),
        default_mix: Some(1.0),
    }
}

pub struct Glue {
    pb: ParamBank<N_PARAMS>,
    /// snap smoothers on the first block after creation / prepare / reset
    fresh: bool,
    sr: f32,
    thr: f32,
    ratio: f32,
    range: f32,
    att: f32,
    rel: f32,
    auto: bool,
    rel_fast: f32,
    slow_att: f32,
    rel_slow: f32,
    hpf_on: bool,
    hpf: [Svf; 2],
    use_sc: bool,
    /// gain reduction in dB (>= 0): the main / fast branch and the slow auto-release branch
    gr: f32,
    gr_slow: f32,
    makeup: Smooth,
    mix: Smooth,
}

impl Glue {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let mut g = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            thr: -10.0,
            ratio: 2.0,
            range: 40.0,
            att: 0.0,
            rel: 0.0,
            auto: true,
            rel_fast: tc_coef(150.0, sr),
            slow_att: tc_coef(400.0, sr),
            rel_slow: tc_coef(1200.0, sr),
            hpf_on: false,
            hpf: [Svf::default(); 2],
            use_sc: false,
            gr: 0.0,
            gr_slow: 0.0,
            makeup: Smooth::with_time(1.0, 20.0, sr),
            mix: Smooth::with_time(1.0, 15.0, sr),
        };
        g.update();
        g.snap();
        g
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.thr = p.get(P::Threshold as usize);
        self.ratio = RATIOS[p.idx(P::Ratio as usize).min(RATIOS.len() - 1)];
        self.att = tc_coef(ATTACK_MS[p.idx(P::Attack as usize).min(ATTACK_MS.len() - 1)], self.sr);
        let r = p.idx(P::Release as usize).min(AUTO);
        self.auto = r == AUTO;
        self.rel = if self.auto { self.rel_fast } else { tc_coef(RELEASE_MS[r], self.sr) };
        self.makeup.set(db_to_gain(p.get(P::Makeup as usize)));
        self.range = p.get(P::Range as usize);
        let hz = SC_HPF_HZ[p.idx(P::ScHpf as usize).min(SC_HPF_HZ.len() - 1)];
        self.hpf_on = hz > 0.0;
        if self.hpf_on {
            for f in self.hpf.iter_mut() {
                f.design(SvfMode::Highpass, hz as f64, std::f64::consts::FRAC_1_SQRT_2, 0.0, self.sr as f64);
            }
        }
        self.use_sc = p.on(P::UseSidechain as usize);
        self.mix.set(p.get(P::Mix as usize));
    }

    fn snap(&mut self) {
        self.makeup.reset(self.makeup.target);
        self.mix.reset(self.mix.target);
    }

    /// Current gain reduction in dB (>= 0), for meters and tests.
    pub fn gain_reduction_db(&self) -> f32 {
        if self.auto {
            self.gr.max(self.gr_slow)
        } else {
            self.gr
        }
    }
}

impl Effect for Glue {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Glue::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        self.snap();
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
            let (xl, xr) = (crate::blocks::finite(buf[0][i]), crate::blocks::finite(buf[1][i]));
            let (mut dl, mut dr) = match sc {
                Some(s) => (crate::blocks::finite(s[0][i]), crate::blocks::finite(s[1][i])),
                None => (xl, xr),
            };
            if self.hpf_on {
                dl = self.hpf[0].tick(dl as f64) as f32;
                dr = self.hpf[1].tick(dr as f64) as f32;
            }
            let level = dl.abs().max(dr.abs());
            let xdb = if level > 1e-9 { 20.0 * level.log10() } else { -180.0 };
            let target = (-gain_computer(xdb, self.thr, self.ratio, KNEE)).min(self.range);
            let c = if target > self.gr { self.att } else { self.rel };
            self.gr += (target - self.gr) * c;
            if self.gr < 1e-6 {
                self.gr = 0.0;
            }
            let gr = if self.auto {
                // the slow branch only climbs while compression is sustained
                let cs = if target > self.gr_slow { self.slow_att } else { self.rel_slow };
                self.gr_slow += (target.min(self.gr) - self.gr_slow) * cs;
                if self.gr_slow < 1e-6 {
                    self.gr_slow = 0.0;
                }
                self.gr.max(self.gr_slow)
            } else {
                self.gr
            };
            let g = db_to_gain(-gr) * self.makeup.next();
            let mix = self.mix.next();
            let k = 1.0 - mix + mix * g;
            buf[0][i] = if mix == 0.0 { xl } else { xl * k };
            buf[1][i] = if mix == 0.0 { xr } else { xr * k };
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.gr = 0.0;
        self.gr_slow = 0.0;
        self.hpf.iter_mut().for_each(Svf::reset);
    }

    fn meter(&self) -> Option<f32> {
        // what the glue applies: the larger branch, blended by its own dry/wet mix
        let gr = self.gain_reduction_db();
        let k = 1.0 - self.mix.cur + self.mix.cur * db_to_gain(-gr);
        Some(if k > 1e-6 && k < 1.0 { -20.0 * k.log10() } else { 0.0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(ratio: usize, attack: usize, frames_after: usize) -> (Glue, Vec<f32>) {
        let mut g = Glue::new(48000.0, 256);
        g.set_param(P::Threshold as usize, -20.0);
        g.set_param(P::Ratio as usize, ratio as f32);
        g.set_param(P::Attack as usize, attack as f32);
        g.set_param(P::Release as usize, 1.0);
        let n = 4800 + frames_after;
        let mut l: Vec<f32> = (0..n).map(|i| if i < 4800 { 0.01 } else { 1.0 }).collect();
        let mut r = l.clone();
        let ctx = ProcessContext { sample_rate: 48000.0, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: n };
        g.process(&ctx, [&mut l, &mut r], None);
        (g, l)
    }

    #[test]
    fn ratio_sets_the_steady_state_reduction_on_a_step() {
        // 20 dB over the threshold: 2:1 → 10 dB, 4:1 → 15 dB, 10:1 → 18 dB
        for (ri, want) in [(0usize, 10.0f32), (1, 15.0), (2, 18.0)] {
            let (g, out) = step(ri, 2, 48000);
            assert!((g.gain_reduction_db() - want).abs() < 0.05, "ratio {ri}: {}", g.gain_reduction_db());
            let got = -20.0 * out[out.len() - 1].log10();
            assert!((got - want).abs() < 0.05, "ratio {ri}: output {got} dB down");
            // below the threshold (-40 dBFS) nothing happens
            assert!((out[4000] - 0.01).abs() < 1e-7);
        }
    }

    #[test]
    fn attack_time_is_the_63_percent_point() {
        for (ai, ms) in ATTACK_MS.iter().enumerate().skip(2) {
            let at = (ms * 48.0) as usize;
            let (_, out) = step(1, ai, at + 10);
            let gr_db = -20.0 * out[4800 + at].log10();
            let frac = gr_db / 15.0;
            assert!((frac - 0.632).abs() < 0.06, "attack {ms} ms: {frac}");
        }
    }

    #[test]
    fn auto_release_is_fast_after_a_peak_and_slow_after_sustained_reduction() {
        let recover = |hold: usize| {
            let mut g = Glue::new(48000.0, 256);
            g.set_param(P::Threshold as usize, -20.0);
            g.set_param(P::Attack as usize, 2.0);
            let n = hold + 48000;
            let mut l: Vec<f32> = (0..n).map(|i| if i < hold { 1.0 } else { 0.001 }).collect();
            let mut r = l.clone();
            let ctx = ProcessContext { sample_rate: 48000.0, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: n };
            g.process(&ctx, [&mut l, &mut r], None);
            // gain reduction left 500 ms after the signal dropped
            -20.0 * (l[hold + 24000] / 0.001).log10()
        };
        let short = recover(480); // 10 ms peak
        let long = recover(96000); // 2 s of compression
        assert!(short < 1.0, "fast recovery after a peak: {short} dB left");
        assert!(long > 3.0, "slow recovery after sustained compression: {long} dB left");
    }
}
