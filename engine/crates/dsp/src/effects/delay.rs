//! krypt.delay — tempo-synced stereo / ping-pong delay. 100% wet output
//! (echoes only; the slot mix sets the blend). Feedback runs through a
//! high-pass, a low-pass and a gentle saturator; delay time glides smoothly
//! (tape-like) on changes, with optional wow modulation.

use super::{frames, sane_sr, sanitize_block};
use crate::blocks::delay::DelayLine;
use crate::blocks::filters::{Svf, SvfMode};
use crate::blocks::{tanh_fast, Smooth, TAU};
use crate::params::{param_table, sync_beats, ParamBank, SYNC_BEATS};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Sync => toggle("sync", "Tempo sync", true, "Delay"),
    Division => choice("division", "Time (sync)", &SYNC_DIVISIONS, 7, "Delay"),
    TimeMs => logp("timeMs", "Time (free)", 1.0, 4000.0, 375.0, "ms", "Delay"),
    Feedback => lin("feedback", "Feedback", 0.0, 0.95, 0.4, "%", "Delay"),
    PingPong => toggle("pingPong", "Ping-pong", true, "Delay"),
    LowCut => logp("lowCut", "Low cut", 20.0, 2000.0, 200.0, "Hz", "Delay"),
    HighCut => logp("highCut", "High cut", 1000.0, 20000.0, 9000.0, "Hz", "Delay"),
    ModDepth => lin("modDepth", "Modulation", 0.0, 1.0, 0.1, "%", "Delay"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.delay",
        name: "Krypt Delay",
        kind: PluginKind::Effect,
        category: "Space",
        description: "Tempo-synced stereo / ping-pong delay (bar divisions follow the time signature, up to 16 s) with filtered, softly saturated \
                      feedback and tape-style wow. Outputs echoes only; the slot's mix knob sets the blend (default 25%).",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(0.25),
    }
}

const MAX_SECONDS: f32 = 16.0;

pub struct Delay {
    pb: ParamBank<N_PARAMS>,
    /// snap smoothers on the first block after creation / prepare / reset
    fresh: bool,
    sr: f32,
    lines: [DelayLine; 2],
    hp: [Svf; 2],
    lp: [Svf; 2],
    time: Smooth,
    fb: Smooth,
    mod_depth: f32,
    lfo: f32,
    ping: bool,
    sync: bool,
    div_beats: f64,
    div_idx: usize,
    free_ms: f32,
    max_samples: f32,
    last_bpm: f64,
}

impl Delay {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let max = (MAX_SECONDS * sr) as usize + 16;
        let mut d = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            lines: [DelayLine::new(max), DelayLine::new(max)],
            hp: [Svf::default(); 2],
            lp: [Svf::default(); 2],
            time: Smooth::with_time(0.375 * sr, 80.0, sr),
            fb: Smooth::with_time(0.4, 20.0, sr),
            mod_depth: 0.0,
            lfo: 0.0,
            ping: true,
            sync: true,
            div_beats: 0.5,
            div_idx: 6,
            free_ms: 375.0,
            max_samples: (MAX_SECONDS * sr) - 8.0,
            last_bpm: 120.0,
        };
        d.update();
        let t = d.target_samples(120.0);
        d.time.reset(t);
        d.fb.reset(d.fb.target);
        d
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.sync = p.on(P::Sync as usize);
        self.div_idx = p.idx(P::Division as usize).min(SYNC_BEATS.len() - 1);
        self.free_ms = p.get(P::TimeMs as usize);
        self.fb.set(p.get(P::Feedback as usize));
        self.ping = p.on(P::PingPong as usize);
        self.mod_depth = p.get(P::ModDepth as usize);
        let sr = self.sr as f64;
        for h in self.hp.iter_mut() {
            h.design(SvfMode::Highpass, p.get(P::LowCut as usize) as f64, 0.6, 0.0, sr);
        }
        for l in self.lp.iter_mut() {
            l.design(SvfMode::Lowpass, (p.get(P::HighCut as usize) as f64).min(sr * 0.45), 0.6, 0.0, sr);
        }
    }

    fn target_samples(&self, bpm: f64) -> f32 {
        let secs = if self.sync {
            let bpm = if bpm.is_finite() && bpm > 1.0 { bpm } else { 120.0 };
            self.div_beats * 60.0 / bpm
        } else {
            self.free_ms as f64 * 0.001
        };
        ((secs * self.sr as f64) as f32).clamp(2.0, self.max_samples)
    }
}

impl Effect for Delay {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Delay::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        let t = self.target_samples(self.last_bpm);
        self.time.reset(t);
        self.fb.reset(self.fb.target);
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
        self.last_bpm = ctx.bpm;
        self.time.set(self.target_samples(ctx.bpm));
        if self.fresh {
            self.fresh = false;
            self.time.reset(self.time.target);
            self.fb.reset(self.fb.target);
        }
        let depth = self.mod_depth * 0.0025 * self.sr; // up to ±2.5 ms
        let lfo_inc = 0.55 / self.sr;
        for i in 0..n {
            let t = self.time.next();
            let fb = self.fb.next();
            self.lfo += lfo_inc;
            if self.lfo >= 1.0 {
                self.lfo -= 1.0;
            }
            let (ml, mr) = if depth > 0.0 {
                ((self.lfo * TAU).sin() * depth, (self.lfo * TAU).cos() * depth)
            } else {
                (0.0, 0.0)
            };
            let (xl, xr) = (crate::blocks::finite(buf[0][i]), crate::blocks::finite(buf[1][i]));
            let dl = self.lines[0].read_frac((t + ml + depth).max(1.0));
            let dr = self.lines[1].read_frac((t + mr + depth).max(1.0));
            let (inl, inr) = if self.ping {
                // mono in → left line; left echoes feed the right line; right feeds back left
                (0.5 * (xl + xr) + dr * fb, dl)
            } else {
                (xl + dl * fb, xr + dr * fb)
            };
            let wl = self.lp[0].tick(self.hp[0].tick(inl as f64)) as f32;
            let wr = self.lp[1].tick(self.hp[1].tick(inr as f64)) as f32;
            // soft saturation keeps runaway feedback musical
            let wl = if wl.abs() > 0.5 { tanh_fast(wl) } else { wl };
            let wr = if wr.abs() > 0.5 { tanh_fast(wr) } else { wr };
            self.lines[0].push(crate::blocks::flush(wl));
            self.lines[1].push(crate::blocks::flush(wr));
            buf[0][i] = dl;
            buf[1][i] = dr;
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.lines.iter_mut().for_each(DelayLine::clear);
        self.hp.iter_mut().for_each(Svf::reset);
        self.lp.iter_mut().for_each(Svf::reset);
    }
}
