//! krypt.limiter — lookahead brickwall limiter with 4x-oversampled
//! true-peak detection.
//!
//! Detection p[n] (true peak around input sample n-M) → required gain
//! r = ceiling / p → sliding minimum over D+1 samples → moving average over
//! L+1 samples (a smooth attack ramp that is GUARANTEED to reach r before the
//! peak) → one-pole release. Audio is delayed D = L + 2M samples, so the
//! applied gain is at or below the requirement of every sample within ±M of
//! the output sample (M = interpolation half-width). Constant latency D.

use super::{frames, sane_sr, sanitize_block};
use crate::blocks::delay::DelayLine;
use crate::blocks::truepeak::TruePeak;
use crate::blocks::{db_to_gain, tc_coef, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    InputGain => lin("inputGain", "Gain", 0.0, 24.0, 0.0, "dB", "Limiter"),
    Ceiling => lin("ceiling", "Ceiling", -12.0, 0.0, -0.3, "dB", "Limiter"),
    Release => logp("release", "Release", 1.0, 1000.0, 60.0, "ms", "Limiter"),
    TruePeakOn => toggle("truePeak", "True peak", true, "Limiter"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.limiter",
        name: "Krypt Limiter",
        kind: PluginKind::Effect,
        category: "Dynamics",
        description: "Lookahead brickwall limiter (2 ms lookahead, 2.5 ms latency). With True peak on, the ceiling also \
                      holds for inter-sample peaks (4x oversampled detection). The master bus default.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

/// Internal safety margin under the ceiling (dB).
const MARGIN_DB: f32 = 0.03;

/// Fixed-capacity monotonic deque for sliding-window minimum.
struct MinWindow {
    vals: Vec<f32>,
    idx: Vec<u64>,
    head: usize,
    len: usize,
    window: u64,
    t: u64,
}

impl MinWindow {
    fn new(window: usize) -> Self {
        let cap = window + 2;
        Self { vals: vec![0.0; cap], idx: vec![0; cap], head: 0, len: 0, window: window as u64, t: 0 }
    }
    fn reset(&mut self) {
        self.head = 0;
        self.len = 0;
        self.t = 0;
    }
    #[inline]
    fn push(&mut self, v: f32) -> f32 {
        let cap = self.vals.len();
        // pop from back while back >= v
        while self.len > 0 {
            let back = (self.head + self.len - 1) % cap;
            if self.vals[back] >= v {
                self.len -= 1;
            } else {
                break;
            }
        }
        let pos = (self.head + self.len) % cap;
        self.vals[pos] = v;
        self.idx[pos] = self.t;
        self.len += 1;
        // drop expired front
        while self.len > 0 && self.idx[self.head] + self.window <= self.t {
            self.head = (self.head + 1) % cap;
            self.len -= 1;
        }
        self.t += 1;
        self.vals[self.head]
    }
}

pub struct Limiter {
    pb: ParamBank<N_PARAMS>,
    /// snap smoothers on the first block after creation / prepare / reset
    fresh: bool,
    sr: f32,
    l: usize,
    m: usize,
    d: usize,
    tp: [TruePeak; 2],
    raw: [DelayLine; 2],
    audio: [DelayLine; 2],
    minw: MinWindow,
    boxbuf: Vec<f32>,
    box_pos: usize,
    box_sum: f64,
    g: f32,
    rel: f32,
    in_gain: Smooth,
    ceiling: Smooth,
    tp_on: bool,
}

impl Limiter {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let l = ((0.002 * sr).round() as usize).max(8);
        let m = TruePeak::latency();
        let d = l + 2 * m;
        let mut s = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            l,
            m,
            d,
            tp: [TruePeak::new(), TruePeak::new()],
            raw: [DelayLine::new(m + 4), DelayLine::new(m + 4)],
            audio: [DelayLine::new(d + 4), DelayLine::new(d + 4)],
            minw: MinWindow::new(d + 1),
            boxbuf: vec![1.0; l + 1],
            box_pos: 0,
            box_sum: (l + 1) as f64,
            g: 1.0,
            rel: tc_coef(60.0, sr),
            in_gain: Smooth::with_time(1.0, 10.0, sr),
            ceiling: Smooth::with_time(db_to_gain(-0.3), 30.0, sr),
            tp_on: true,
        };
        s.update();
        s.in_gain.reset(s.in_gain.target);
        s.ceiling.reset(s.ceiling.target);
        s
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.in_gain.set(db_to_gain(p.get(P::InputGain as usize)));
        self.ceiling.set(db_to_gain(p.get(P::Ceiling as usize)));
        self.rel = tc_coef(p.get(P::Release as usize), self.sr);
        self.tp_on = p.on(P::TruePeakOn as usize);
    }
}

impl Limiter {
    fn snap(&mut self) {
        self.in_gain.reset(self.in_gain.target);
        self.ceiling.reset(self.ceiling.target);
    }
}

impl Effect for Limiter {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Limiter::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        self.in_gain.reset(self.in_gain.target);
        self.ceiling.reset(self.ceiling.target);
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn latency(&self) -> usize {
        self.d
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
        let margin = db_to_gain(-MARGIN_DB);
        let inv_box = 1.0 / (self.l + 1) as f64;
        for i in 0..n {
            let gi = self.in_gain.next();
            let ceil = self.ceiling.next();
            let xl = crate::blocks::finite(buf[0][i]) * gi;
            let xr = crate::blocks::finite(buf[1][i]) * gi;
            // detection (aligned to input sample n - M)
            let tpl = self.tp[0].push(xl);
            let tpr = self.tp[1].push(xr);
            self.raw[0].push(xl);
            self.raw[1].push(xr);
            let p = if self.tp_on {
                tpl.max(tpr)
            } else {
                self.raw[0].read(self.m).abs().max(self.raw[1].read(self.m).abs())
            };
            let lim = ceil * margin;
            let r = if p > lim { lim / p } else { 1.0 };
            let h = self.minw.push(r);
            // moving average (attack ramp)
            self.box_sum += h as f64 - self.boxbuf[self.box_pos] as f64;
            self.boxbuf[self.box_pos] = h;
            self.box_pos += 1;
            if self.box_pos == self.boxbuf.len() {
                self.box_pos = 0;
            }
            let b = ((self.box_sum * inv_box) as f32).min(1.0);
            // release
            if b < self.g {
                self.g = b;
            } else {
                self.g += (b - self.g) * self.rel;
            }
            // delayed audio
            self.audio[0].push(xl);
            self.audio[1].push(xr);
            let yl = (self.audio[0].read(self.d) * self.g).clamp(-ceil, ceil);
            let yr = (self.audio[1].read(self.d) * self.g).clamp(-ceil, ceil);
            buf[0][i] = yl;
            buf[1][i] = yr;
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        for t in self.tp.iter_mut() {
            t.reset();
        }
        for d in self.raw.iter_mut().chain(self.audio.iter_mut()) {
            d.clear();
        }
        self.minw.reset();
        self.boxbuf.iter_mut().for_each(|v| *v = 1.0);
        self.box_sum = self.boxbuf.len() as f64;
        self.box_pos = 0;
        self.g = 1.0;
    }

    fn meter(&self) -> Option<f32> {
        Some(if self.g > 1e-6 && self.g < 1.0 { -20.0 * self.g.log10() } else { 0.0 })
    }
}
