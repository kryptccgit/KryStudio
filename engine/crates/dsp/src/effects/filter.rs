use super::{frames, sane_sr, sanitize_block};
use crate::blocks::filters::{svf_g, Svf};
use crate::blocks::{tanh_fast, Smooth, TAU};
use crate::params::{param_table, sync_beats, ParamBank, SYNC_BEATS};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Type => choice("type", "Type", &["LP 12", "LP 24", "HP 12", "HP 24", "Band pass", "Notch"], 1, "Filter"),
    Cutoff => logp("cutoff", "Cutoff", 20.0, 20000.0, 20000.0, "Hz", "Filter"),
    Reso => lin("reso", "Resonance", 0.0, 1.0, 0.1, "%", "Filter"),
    Drive => lin("drive", "Drive", 0.0, 1.0, 0.0, "%", "Filter"),
    LfoSync => toggle("lfoSync", "LFO sync", true, "Filter"),
    LfoDivision => choice("lfoDivision", "LFO rate (sync)", &SYNC_DIVISIONS, 9, "Filter"),
    LfoRate => logp("lfoRate", "LFO rate (free)", 0.01, 30.0, 1.0, "Hz", "Filter"),
    LfoDepth => lin("lfoDepth", "LFO depth", 0.0, 1.0, 0.0, "%", "Filter"),
    LfoShape => choice("lfoShape", "LFO shape", &["Sine", "Triangle", "Saw up", "Saw down", "Square"], 0, "Filter"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.filter",
        name: "Krypt Filter",
        kind: PluginKind::Effect,
        category: "Filter",
        description: "Resonant multimode filter (LP/HP 12 or 24 dB, band pass, notch) with drive and an LFO on cutoff \
                      (depth 1 = ±3 octaves). Synced LFO locks to the bar grid while playing. Fully open low pass with no \
                      LFO is bypassed, so the default is transparent.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

pub struct Filter {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    sr: f32,
    st: [[Svf; 2]; 2],
    ftype: usize,
    cutoff: Smooth,
    reso: Smooth,
    drive: Smooth,
    wet: Smooth,
    lfo_sm: Smooth,
    phase: f64,
    sync: bool,
    div_beats: f64,
    div_idx: usize,
    rate: f32,
    depth: f32,
    shape: usize,
    coef_ctr: u32,
}

impl Filter {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let mut f = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            st: [[Svf::default(); 2]; 2],
            ftype: 1,
            cutoff: Smooth::with_time(20000f32.log2(), 15.0, sr),
            reso: Smooth::with_time(0.1, 15.0, sr),
            drive: Smooth::with_time(0.0, 15.0, sr),
            wet: Smooth::with_time(0.0, 20.0, sr),
            lfo_sm: Smooth::with_time(0.0, 1.5, sr),
            phase: 0.0,
            sync: true,
            div_beats: 1.0,
            div_idx: 9,
            rate: 1.0,
            depth: 0.0,
            shape: 0,
            coef_ctr: 0,
        };
        f.update();
        f.cutoff.reset(f.cutoff.target);
        f.reso.reset(f.reso.target);
        f.drive.reset(f.drive.target);
        f.wet.reset(f.wet.target);
        f
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.ftype = p.idx(P::Type as usize).min(5);
        let cut = p.get(P::Cutoff as usize);
        self.cutoff.set(cut.log2());
        self.reso.set(p.get(P::Reso as usize));
        let drv = p.get(P::Drive as usize);
        self.drive.set(drv);
        self.sync = p.on(P::LfoSync as usize);
        self.div_idx = p.idx(P::LfoDivision as usize).min(SYNC_BEATS.len() - 1);
        self.rate = p.get(P::LfoRate as usize);
        self.depth = p.get(P::LfoDepth as usize);
        self.shape = p.idx(P::LfoShape as usize).min(4);
        let transparent = self.ftype <= 1 && cut >= 19_500.0 && self.depth == 0.0 && drv == 0.0;
        self.wet.set(if transparent { 0.0 } else { 1.0 });
    }

    #[inline]
    fn lfo_value(&self, ph: f64) -> f32 {
        let t = ph as f32;
        match self.shape {
            0 => (t * TAU).sin(),
            1 => 1.0 - 4.0 * (t - 0.5).abs(),
            2 => 2.0 * t - 1.0,
            3 => 1.0 - 2.0 * t,
            _ => {
                if t < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
        }
    }

    fn design(&mut self, cutoff_hz: f32, reso: f32) {
        let fs = self.sr as f64;
        let c = (cutoff_hz as f64).clamp(20.0, fs * 0.45);
        let g = svf_g(c, fs);
        let r = reso.clamp(0.0, 1.0) as f64;
        match self.ftype {
            0 | 2 => {
                let q = std::f64::consts::FRAC_1_SQRT_2 * (2f64).powf(r * 5.1);
                for ch in 0..2 {
                    self.st[ch][0].set_gk(g, 1.0 / q);
                }
            }
            1 | 3 => {
                let q1 = 0.541_196;
                let q2 = 1.306_563 * (20.0f64 / 1.306_563).powf(r);
                for ch in 0..2 {
                    self.st[ch][0].set_gk(g, 1.0 / q1);
                    self.st[ch][1].set_gk(g, 1.0 / q2);
                }
            }
            _ => {
                let q = 0.7 * (2f64).powf(r * 5.0);
                for ch in 0..2 {
                    self.st[ch][0].set_gk(g, 1.0 / q);
                }
            }
        }
    }
}

impl Filter {
    fn snap(&mut self) {
        self.cutoff.reset(self.cutoff.target);
        self.reso.reset(self.reso.target);
        self.drive.reset(self.drive.target);
        self.wet.reset(self.wet.target);
    }
}

impl Effect for Filter {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Filter::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        self.cutoff.reset(self.cutoff.target);
        self.wet.reset(self.wet.target);
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn process(&mut self, ctx: &ProcessContext, mut buf: [&mut [f32]; 2], _sc: Option<[&[f32]; 2]>) {
        let n = frames(ctx, &buf);
        if self.pb.take_dirty() {
            self.update();
        }
        self.div_beats = sync_beats(self.div_idx, ctx.beats_per_bar);
        if self.fresh {
            self.fresh = false;
            self.snap();
        }
        let bpm = if ctx.bpm.is_finite() && ctx.bpm > 1.0 { ctx.bpm } else { 120.0 };
        let beats_per_sample = bpm / 60.0 / self.sr as f64;
        let locked = self.sync && ctx.playing && ctx.beat_pos.is_finite();
        let inc = if self.sync { beats_per_sample / self.div_beats } else { self.rate as f64 / self.sr as f64 };
        let modulated = self.depth > 0.0;
        for i in 0..n {
            let w = self.wet.next();
            let lc = self.cutoff.next();
            let rs = self.reso.next();
            let dv = self.drive.next();
            if locked {
                self.phase = ((ctx.beat_pos + i as f64 * beats_per_sample) / self.div_beats).rem_euclid(1.0);
            } else {
                self.phase = (self.phase + inc).rem_euclid(1.0);
            }
            let lfo = self.lfo_sm.next();
            self.lfo_sm.set(self.lfo_value(self.phase));
            if self.coef_ctr == 0 || modulated {
                let oct = if modulated { lfo * self.depth * 3.0 } else { 0.0 };
                self.design((lc + oct).exp2(), rs);
                self.coef_ctr = 16;
            }
            self.coef_ctr -= 1;
            if w <= 0.0 {
                for ch in self.st.iter_mut() {
                    ch.iter_mut().for_each(Svf::reset);
                }
                continue;
            }
            for ch in 0..2 {
                let dry = crate::blocks::finite(buf[ch][i]);
                let mut x = dry;
                if dv > 0.0 {
                    let k = 1.0 + 6.0 * dv;
                    x = tanh_fast(x * k) / k.powf(0.6);
                }
                let x = x as f64;
                let y = match self.ftype {
                    0 => self.st[ch][0].tick3(x).0,
                    1 => {
                        let a = self.st[ch][0].tick3(x).0;
                        self.st[ch][1].tick3(a).0
                    }
                    2 => self.st[ch][0].tick3(x).2,
                    3 => {
                        let a = self.st[ch][0].tick3(x).2;
                        self.st[ch][1].tick3(a).2
                    }
                    4 => {
                        let k = self.st[ch][0].k();
                        k * self.st[ch][0].tick3(x).1
                    }
                    _ => {
                        let k = self.st[ch][0].k();
                        x - k * self.st[ch][0].tick3(x).1
                    }
                } as f32;
                buf[ch][i] = dry + (y - dry) * w;
            }
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        for ch in self.st.iter_mut() {
            ch.iter_mut().for_each(Svf::reset);
        }
    }
}
