//! krypt.tapeecho — a tape-style echo.
//!
//! One delay line per side, read by a modulated "playback head": wow (a slow
//! sine with a smoothed random drift, up to ±4 ms) and flutter (two fast
//! sines, up to ±0.25 ms) move a fractional read with cubic Hermite
//! interpolation, so the echoes bend in pitch like tape. Time is tempo
//! synced (straight, dotted and triplet values) or free in ms, and glides
//! (~150 ms) when changed, like a tape speed change. Each repeat goes
//! through the age filters (band-limit: low cut 30 → 300 Hz, high cut
//! 16 → 2.4 kHz) and a tanh tape saturator in the loop, so high feedback
//! thickens and compresses instead of exploding. Age also adds hiss, gated
//! by the echo level (silence stays silent). Ping-pong bounces the repeats
//! left / right; Freeze stops recording and loops the last delay time
//! forever without loss. Mix blends inside the device (zero latency).

use super::{frames, sane_sr, sanitize_block};
use crate::blocks::delay::DelayLine;
use crate::blocks::filters::{Svf, SvfMode};
use crate::blocks::lfo::sane_bpm;
use crate::blocks::{flush, tanh_fast, Rng, Smooth, TAU};
use crate::params::{param_table, sync_beats, ParamBank, SYNC_BEATS};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Sync => toggle("sync", "Tempo sync", true, "Time"),
    Division => choice("division", "Time (sync)", &SYNC_DIVISIONS, 7, "Time"),
    TimeMs => logp("timeMs", "Time (free)", 10.0, 2000.0, 350.0, "ms", "Time"),
    Feedback => lin("feedback", "Feedback", 0.0, 1.1, 0.45, "%", "Echo"),
    Saturation => lin("saturation", "Saturation", 0.0, 1.0, 0.35, "%", "Echo"),
    PingPong => toggle("pingPong", "Ping-pong", false, "Echo"),
    Freeze => toggle("freeze", "Freeze", false, "Echo"),
    Wow => lin("wow", "Wow", 0.0, 1.0, 0.25, "%", "Tape"),
    Flutter => lin("flutter", "Flutter", 0.0, 1.0, 0.2, "%", "Tape"),
    Age => lin("age", "Age", 0.0, 1.0, 0.3, "%", "Tape"),
    Mix => lin("mix", "Mix", 0.0, 1.0, 0.35, "%", "Output"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.tapeecho",
        name: "Krypt Tape Echo",
        kind: PluginKind::Effect,
        category: "Space",
        description: "Tape echo: tempo-synced (straight, dotted, triplet) or free time, feedback through a tape saturator \
                      (above 100% it builds into dub runaway), wow and flutter that bend the repeats' pitch, Age (darker, \
                      thinner repeats plus hiss), ping-pong, and Freeze to loop the last repeat forever. Mix is built in \
                      (default 35%; use 100% on a send). Zero latency.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

const MAX_SECONDS: f32 = 10.0;
/// Wow: ±4 ms at 100 %; flutter: ±0.25 ms.
const WOW_S: f32 = 0.004;
const FLUTTER_S: f32 = 0.000_25;

pub struct TapeEcho {
    pb: ParamBank<N_PARAMS>,
    /// snap smoothers on the first block after creation / prepare / reset
    fresh: bool,
    sr: f32,
    lines: [DelayLine; 2],
    hp: [Svf; 2],
    lp: [Svf; 2],
    time: Smooth,
    fb: Smooth,
    mix: Smooth,
    sat_k: f32,
    wow: f32,
    flutter: f32,
    hiss: f32,
    ping: bool,
    sync: bool,
    freeze: bool,
    freeze_req: bool,
    /// read offset (pushes) that recirculates one loop while frozen
    frozen_d: usize,
    div_beats: f64,
    div_idx: usize,
    free_ms: f32,
    max_samples: f32,
    last_bpm: f64,
    // modulation state
    wow_ph: f32,
    fl_ph: [f32; 2],
    drift: f32,
    drift_target: f32,
    drift_ctr: u32,
    env: f32,
    env_rel: f32,
    rng: Rng,
}

impl TapeEcho {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let max = (MAX_SECONDS * sr) as usize + 64;
        let mut d = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            lines: [DelayLine::new(max), DelayLine::new(max)],
            hp: [Svf::default(); 2],
            lp: [Svf::default(); 2],
            time: Smooth::with_time(0.375 * sr, 150.0, sr),
            fb: Smooth::with_time(0.45, 20.0, sr),
            mix: Smooth::with_time(0.35, 15.0, sr),
            sat_k: 1.0,
            wow: 0.0,
            flutter: 0.0,
            hiss: 0.0,
            ping: false,
            sync: true,
            freeze: false,
            freeze_req: false,
            frozen_d: 0,
            div_beats: 0.75,
            div_idx: 7,
            free_ms: 350.0,
            max_samples: MAX_SECONDS * sr - (WOW_S + FLUTTER_S) * sr - 8.0,
            last_bpm: 120.0,
            wow_ph: 0.0,
            fl_ph: [0.0, 0.31],
            drift: 0.0,
            drift_target: 0.0,
            drift_ctr: 0,
            env: 0.0,
            env_rel: crate::blocks::tc_coef(250.0, sr),
            rng: Rng::new(0x7A9E),
        };
        d.update();
        let t = d.target_samples(120.0);
        d.time.reset(t);
        d.snap();
        d
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.sync = p.on(P::Sync as usize);
        self.div_idx = p.idx(P::Division as usize).min(SYNC_BEATS.len() - 1);
        self.free_ms = p.get(P::TimeMs as usize);
        self.fb.set(p.get(P::Feedback as usize));
        self.sat_k = 1.0 + 3.0 * p.get(P::Saturation as usize);
        self.ping = p.on(P::PingPong as usize);
        self.wow = p.get(P::Wow as usize);
        self.flutter = p.get(P::Flutter as usize);
        let age = p.get(P::Age as usize);
        self.hiss = 0.003 * age * age;
        self.mix.set(p.get(P::Mix as usize));
        self.freeze_req = p.on(P::Freeze as usize);
        let sr = self.sr as f64;
        let hp = 30.0 * 10f64.powf(age as f64);
        let lp = (16000.0 * 0.15f64.powf(age as f64)).min(sr * 0.45);
        for h in self.hp.iter_mut() {
            h.design(SvfMode::Highpass, hp, 0.6, 0.0, sr);
        }
        for l in self.lp.iter_mut() {
            l.design(SvfMode::Lowpass, lp, 0.6, 0.0, sr);
        }
    }

    fn target_samples(&self, bpm: f64) -> f32 {
        let secs = if self.sync { self.div_beats * 60.0 / sane_bpm(bpm) } else { self.free_ms as f64 * 0.001 };
        ((secs * self.sr as f64) as f32).clamp(2.0, self.max_samples)
    }

    fn snap(&mut self) {
        self.fb.reset(self.fb.target);
        self.mix.reset(self.mix.target);
    }
}

impl Effect for TapeEcho {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = TapeEcho::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        let t = self.target_samples(self.last_bpm);
        self.time.reset(t);
        self.snap();
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
        self.last_bpm = sane_bpm(ctx.bpm);
        self.time.set(self.target_samples(ctx.bpm));
        if self.fresh {
            self.fresh = false;
            self.time.reset(self.time.target);
            self.snap();
        }
        if self.freeze_req && !self.freeze {
            // loop exactly one (current) delay time
            self.frozen_d = (self.time.cur.round().max(2.0) as usize) - 1;
        }
        self.freeze = self.freeze_req;
        let sr = self.sr;
        let wow_d = self.wow * WOW_S * sr;
        let fl_d = self.flutter * FLUTTER_S * sr;
        let wow_inc = 0.55 / sr;
        let fl_inc = [7.3 / sr, 11.9 / sr];
        let drift_period = (0.35 * sr) as u32;
        let drift_coef = crate::blocks::tc_coef(300.0, sr);
        let k = self.sat_k;
        let inv_k = 1.0 / k;
        for i in 0..n {
            let t = self.time.next();
            let fb = self.fb.next();
            let mix = self.mix.next();
            // playback-head modulation (centred, so the average echo time is exact)
            let mut m = 0.0f32;
            if wow_d > 0.0 {
                self.wow_ph += wow_inc;
                if self.wow_ph >= 1.0 {
                    self.wow_ph -= 1.0;
                }
                if self.drift_ctr == 0 {
                    self.drift_target = self.rng.bipolar();
                    self.drift_ctr = drift_period.max(1);
                }
                self.drift_ctr -= 1;
                self.drift += (self.drift_target - self.drift) * drift_coef;
                m += wow_d * (0.7 * (self.wow_ph * TAU).sin() + 0.3 * self.drift);
            }
            if fl_d > 0.0 {
                let mut f = 0.0;
                for (j, ph) in self.fl_ph.iter_mut().enumerate() {
                    *ph += fl_inc[j];
                    if *ph >= 1.0 {
                        *ph -= 1.0;
                    }
                    f += (*ph * TAU).sin() * if j == 0 { 0.75 } else { 0.25 };
                }
                m += fl_d * f;
            }
            // the read happens before this sample's push: offset t - 1 = an echo exactly t samples later
            let d = ((t + m) as f64 - 1.0).max(0.0);
            let dl = self.lines[0].read_f64(d);
            let dr = self.lines[1].read_f64(d);
            let (xl, xr) = (crate::blocks::finite(buf[0][i]), crate::blocks::finite(buf[1][i]));
            if self.freeze {
                let fd = self.frozen_d;
                let (a, b) = (self.lines[0].read(fd), self.lines[1].read(fd));
                self.lines[0].push(a);
                self.lines[1].push(b);
            } else {
                let (inl, inr) = if self.ping { (0.5 * (xl + xr) + dr * fb, dl) } else { (xl + dl * fb, xr + dr * fb) };
                let wl = self.lp[0].tick(self.hp[0].tick(inl as f64)) as f32;
                let wr = self.lp[1].tick(self.hp[1].tick(inr as f64)) as f32;
                self.lines[0].push(flush(tanh_fast(wl * k) * inv_k));
                self.lines[1].push(flush(tanh_fast(wr * k) * inv_k));
            }
            // hiss follows the echo level, so silence stays digital silence
            let lvl = xl.abs().max(xr.abs()).max(dl.abs()).max(dr.abs());
            self.env = if lvl > self.env { lvl } else { self.env + (lvl - self.env) * self.env_rel };
            if self.env < 1e-6 {
                self.env = 0.0;
            }
            let (mut hl, mut hr) = (0.0, 0.0);
            if self.hiss > 0.0 && self.env > 0.0 {
                let g = self.hiss * (self.env * 8.0).min(1.0);
                hl = self.rng.bipolar() * g;
                hr = self.rng.bipolar() * g;
            }
            buf[0][i] = xl * (1.0 - mix) + (dl + hl) * mix;
            buf[1][i] = xr * (1.0 - mix) + (dr + hr) * mix;
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.lines.iter_mut().for_each(DelayLine::clear);
        self.hp.iter_mut().for_each(Svf::reset);
        self.lp.iter_mut().for_each(Svf::reset);
        self.env = 0.0;
        self.wow_ph = 0.0;
        self.fl_ph = [0.0, 0.31];
        self.drift = 0.0;
        self.drift_target = 0.0;
        self.drift_ctr = 0;
        self.rng = Rng::new(0x7A9E);
    }
}
