use super::{frames, sane_sr, sanitize_block};
use crate::blocks::{tc_coef, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Mode => choice("mode", "Mode", &["Tempo shape", "Sidechain follow"], 0, "Duck"),
    Depth => lin("depth", "Depth", 0.0, 1.0, 0.8, "%", "Duck"),
    Rate => choice("rate", "Rate", &["1/8", "1/4", "1/2", "1 bar"], 1, "Duck"),
    Curve => lin("curve", "Curve", 0.0, 1.0, 0.5, "%", "Duck"),
    Attack => logp("attack", "Attack", 0.1, 100.0, 1.0, "ms", "Duck"),
    Release => logp("release", "Release", 10.0, 2000.0, 180.0, "ms", "Duck"),
    Threshold => lin("threshold", "Threshold (sidechain)", -60.0, 0.0, -24.0, "dB", "Duck"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.duck",
        name: "Krypt Duck",
        kind: PluginKind::Effect,
        category: "Dynamics",
        description: "Sidechain ducker. Tempo shape: pumps on every step of Rate, locked to the beat while playing (uses \
                      depth, curve, attack; curve 0 = snappy recovery, 1 = long pump). Sidechain follow: ducks when the \
                      sidechain input exceeds the threshold (uses depth, attack, release); passes audio unchanged if no \
                      sidechain is routed.",
        params: param_specs(),
        uses_sample: None,
        sidechain: Some(true),
        default_mix: Some(1.0),
    }
}

const RATE_BEATS: [f64; 4] = [0.5, 1.0, 2.0, 4.0];

pub struct Duck {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    sr: f32,
    mode: usize,
    depth: f32,
    period_beats: f64,
    q: f32,
    attack_ms: f32,
    att: f32,
    rel: f32,
    thr: f32,
    env: f32,
    gain: Smooth,
}

impl Duck {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let mut d = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            mode: 0,
            depth: 0.8,
            period_beats: 1.0,
            q: 1.0,
            attack_ms: 1.0,
            att: 0.0,
            rel: 0.0,
            thr: -24.0,
            env: 0.0,
            gain: Smooth::with_time(1.0, 0.7, sr),
        };
        d.update();
        d
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.mode = p.idx(P::Mode as usize).min(1);
        self.depth = p.get(P::Depth as usize);
        self.period_beats = RATE_BEATS[p.idx(P::Rate as usize).min(3)];
        self.q = 0.4 * 10f32.powf(p.get(P::Curve as usize));
        self.attack_ms = p.get(P::Attack as usize);
        self.att = tc_coef(self.attack_ms, self.sr);
        self.rel = tc_coef(p.get(P::Release as usize), self.sr);
        self.thr = p.get(P::Threshold as usize);
    }

    #[inline]
    fn shape(&self, t: f32, period_s: f32) -> f32 {
        let atk = (self.attack_ms * 0.001).min(period_s * 0.5);
        if t < atk {
            1.0 - self.depth * (t / atk.max(1e-6))
        } else {
            let x = ((t - atk) / (period_s - atk).max(1e-6)).clamp(0.0, 1.0);
            1.0 - self.depth * (1.0 - x.powf(self.q))
        }
    }
}

impl Duck {
    fn snap(&mut self) {
        self.gain.reset(self.gain.target);
    }
}

impl Effect for Duck {
    fn prepare(&mut self, sample_rate: f32, _max_frames: usize) {
        self.fresh = true;
        self.sr = sane_sr(sample_rate);
        self.gain.set_time(0.7, self.sr);
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
        let bpm = if ctx.bpm.is_finite() && ctx.bpm > 1.0 { ctx.bpm } else { 120.0 };
        let beats_per_sample = bpm / 60.0 / self.sr as f64;
        let period_s = (self.period_beats * 60.0 / bpm) as f32;
        let sc = sidechain.filter(|s| s[0].len() >= n && s[1].len() >= n);
        for i in 0..n {
            let target = if self.mode == 0 {
                if ctx.playing && ctx.beat_pos.is_finite() {
                    let beat = ctx.beat_pos + i as f64 * beats_per_sample;
                    let ph = (beat / self.period_beats).rem_euclid(1.0);
                    self.shape(ph as f32 * period_s, period_s)
                } else {
                    1.0
                }
            } else if let Some(s) = sc {
                let lvl = crate::blocks::finite(s[0][i]).abs().max(crate::blocks::finite(s[1][i]).abs());
                let db = if lvl > 1e-9 { 20.0 * lvl.log10() } else { -180.0 };
                let amt = ((db - self.thr) / 12.0).clamp(0.0, 1.0);
                let c = if amt > self.env { self.att } else { self.rel };
                self.env += (amt - self.env) * c;
                self.env = crate::blocks::flush(self.env);
                1.0 - self.depth * self.env
            } else {
                1.0
            };
            self.gain.set(target);
            let g = self.gain.next();
            buf[0][i] *= g;
            buf[1][i] *= g;
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.env = 0.0;
        self.gain.reset(1.0);
    }

    fn meter(&self) -> Option<f32> {
        let g = self.gain.cur;
        Some(if g > 1e-6 && g < 1.0 { -20.0 * g.log10() } else if g <= 1e-6 { 120.0 } else { 0.0 })
    }
}
