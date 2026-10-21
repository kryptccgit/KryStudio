use super::{frames, sane_sr, sanitize_block};
use crate::blocks::delay::DelayLine;
use crate::blocks::lfo::sane_bpm;
use crate::blocks::{tanh_fast, tc_coef, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

pub const PATTERNS: [&str; 11] = [
    "Half-time",
    "Stutter 1/8",
    "Stutter 1/16",
    "Triplet chops",
    "Tape stop",
    "Reverse 1/4",
    "Scratch",
    "Gate 1/8",
    "Gate 1/16 trance",
    "Gate 3-3-2",
    "Custom steps",
];

pub const CUSTOM: usize = 10;

pub const STEP_MODES: [&str; 9] = ["Play", "Roll x2", "Roll x3", "Roll x4", "Repeat prev", "Half speed", "Reverse", "Tape stop", "Tape start"];
const STEP_DIVS: [&str; 4] = ["1/32", "1/16", "1/8", "1/4"];
const STEP_DIV_BEATS: [f64; 4] = [0.125, 0.25, 0.5, 1.0];
pub const MAX_STEPS: usize = 16;

param_table! {
    Pattern => choice("pattern", "Pattern", &PATTERNS, 0, "Gate/Time"),
    Trigger => choice("trigger", "Trigger", &["Always", "Active param"], 0, "Gate/Time"),
    Active => toggle("active", "Active", false, "Gate/Time"),
    Depth => lin("depth", "Depth", 0.0, 1.0, 1.0, "%", "Gate/Time"),
    Smoothing => logp("smoothing", "Smoothing", 0.5, 50.0, 6.0, "ms", "Gate/Time"),
    Mix => lin("mix", "Mix", 0.0, 1.0, 1.0, "%", "Output"),
    StepDiv => choice("stepDiv", "Step length", &STEP_DIVS, 1, "Steps"),
    StepCount => stepped("stepCount", "Steps", 1.0, 16.0, 16.0, "", 1.0, "Steps"),
    S1 => choice("s1", "Step 1", &STEP_MODES, 0, "Steps"),
    S2 => choice("s2", "Step 2", &STEP_MODES, 0, "Steps"),
    S3 => choice("s3", "Step 3", &STEP_MODES, 0, "Steps"),
    S4 => choice("s4", "Step 4", &STEP_MODES, 0, "Steps"),
    S5 => choice("s5", "Step 5", &STEP_MODES, 0, "Steps"),
    S6 => choice("s6", "Step 6", &STEP_MODES, 0, "Steps"),
    S7 => choice("s7", "Step 7", &STEP_MODES, 0, "Steps"),
    S8 => choice("s8", "Step 8", &STEP_MODES, 0, "Steps"),
    S9 => choice("s9", "Step 9", &STEP_MODES, 0, "Steps"),
    S10 => choice("s10", "Step 10", &STEP_MODES, 0, "Steps"),
    S11 => choice("s11", "Step 11", &STEP_MODES, 0, "Steps"),
    S12 => choice("s12", "Step 12", &STEP_MODES, 0, "Steps"),
    S13 => choice("s13", "Step 13", &STEP_MODES, 0, "Steps"),
    S14 => choice("s14", "Step 14", &STEP_MODES, 0, "Steps"),
    S15 => choice("s15", "Step 15", &STEP_MODES, 0, "Steps"),
    S16 => choice("s16", "Step 16", &STEP_MODES, 0, "Steps"),
    G1 => lin("g1", "Step 1 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G2 => lin("g2", "Step 2 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G3 => lin("g3", "Step 3 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G4 => lin("g4", "Step 4 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G5 => lin("g5", "Step 5 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G6 => lin("g6", "Step 6 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G7 => lin("g7", "Step 7 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G8 => lin("g8", "Step 8 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G9 => lin("g9", "Step 9 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G10 => lin("g10", "Step 10 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G11 => lin("g11", "Step 11 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G12 => lin("g12", "Step 12 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G13 => lin("g13", "Step 13 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G14 => lin("g14", "Step 14 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G15 => lin("g15", "Step 15 level", 0.0, 1.0, 1.0, "%", "Steps"),
    G16 => lin("g16", "Step 16 level", 0.0, 1.0, 1.0, "%", "Steps"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.gate",
        name: "Krypt Gate/Time",
        kind: PluginKind::Effect,
        category: "Creative",
        description: "Tempo-locked time and volume patterns: half-time, stutters, triplet chops, tape stop, reverse, \
                      scratch, three gate rhythms, or Custom steps: up to 16 steps, each with a time mode (play, rolls, \
                      repeat, half speed, reverse, tape stop or start) and a level. Reads only from the past (no \
                      latency). Trigger Always runs on the bar grid while playing; Active param runs only while Active \
                      is on (automate it). Depth scales the time warp and the gate; Smoothing sets crossfades.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

const MAX_SECONDS: f32 = 16.0;
const JUMP: f64 = 4.0;

fn pattern_cycle(p: usize) -> (f64, f64, bool) {
    match p {
        0 => (4.0, 0.0, false),
        4 => (4.0, 2.0, true),
        8 => (4.0, 0.0, false),
        9 => (2.0, 0.0, false),
        _ => (1.0, 0.0, false),
    }
}

const TRANCE: [u8; 16] = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1];
const TRESILLO: [u8; 8] = [1, 1, 0, 1, 1, 0, 1, 0];

pub fn pattern_eval(p: usize, u: f64, depth: f32) -> (f64, f32) {
    let d = depth.clamp(0.0, 1.0) as f64;
    let (lag, gain): (f64, f32) = match p {
        0 => (u * 0.5, 1.0),
        1 => (u - u.rem_euclid(0.5), 1.0),
        2 => (u - u.rem_euclid(0.25), 1.0),
        3 => {
            let l = 1.0 / 3.0;
            let q = u.rem_euclid(l) / l;
            (u - u.rem_euclid(l), if q < 0.62 { 1.0 } else { 0.0 })
        }
        4 => {
            if u < 2.0 {
                (0.0, 1.0)
            } else {
                let t = 2.0;
                let w = (u - 2.0).min(t);
                let k = 1.0 - w / t;
                let s = t / 3.0 * (1.0 - k * k * k);
                (w - s, k as f32)
            }
        }
        5 => (2.0 * u, 1.0),
        6 => {
            let a = 0.25;
            let ph = std::f64::consts::TAU * 2.0 * u;
            let s = -a * 0.5 * (1.0 - ph.cos());
            let speed = (-a * 0.5 * std::f64::consts::TAU * 2.0 * ph.sin()) as f32;
            (u - s, 0.4 + 0.6 * (0.5 + 0.5 * tanh_fast(3.0 * speed)))
        }
        7 => (0.0, if u.rem_euclid(0.5) < 0.25 { 1.0 } else { 0.0 }),
        8 => {
            let step = ((u / 0.25) as usize).min(15);
            let frac = u.rem_euclid(0.25) / 0.25;
            (0.0, if TRANCE[step] == 1 && frac < 0.85 { 1.0 } else { 0.0 })
        }
        _ => {
            let step = ((u / 0.25) as usize).min(7);
            (0.0, TRESILLO[step] as f32)
        }
    };
    (lag.max(0.0) * d, 1.0 - depth.clamp(0.0, 1.0) * (1.0 - gain))
}

#[derive(Clone, Copy, Debug)]
pub struct Steps {
    pub len: f64,
    pub count: usize,
    pub modes: [u8; MAX_STEPS],
    pub gains: [f32; MAX_STEPS],
    run_start: [u8; MAX_STEPS],
    run_len: [u8; MAX_STEPS],
}

impl Default for Steps {
    fn default() -> Self {
        Self::new(0.25, MAX_STEPS, [0; MAX_STEPS], [1.0; MAX_STEPS])
    }
}

impl Steps {
    pub fn new(len: f64, count: usize, modes: [u8; MAX_STEPS], gains: [f32; MAX_STEPS]) -> Self {
        let mut s = Self { len, count: count.clamp(1, MAX_STEPS), modes, gains, run_start: [0; MAX_STEPS], run_len: [1; MAX_STEPS] };
        s.runs();
        s
    }

    fn runs(&mut self) {
        let n = self.count;
        let mut i = 0;
        while i < n {
            let mut j = i + 1;
            while j < n && self.modes[j] == self.modes[i] {
                j += 1;
            }
            for k in i..j {
                self.run_start[k] = i as u8;
                self.run_len[k] = (j - i) as u8;
            }
            i = j;
        }
    }

    pub fn cycle(&self) -> f64 {
        self.len * self.count as f64
    }

    pub fn eval(&self, u: f64) -> (f64, f32) {
        let l = self.len;
        let i = ((u / l).max(0.0) as usize).min(self.count - 1);
        let w = (u - i as f64 * l).max(0.0);
        let rs = self.run_start[i] as usize;
        let t = u - rs as f64 * l;
        let span = self.run_len[i] as f64 * l;
        let roll = |k: f64| w - w.rem_euclid(l / k);
        let (lag, gain) = match self.modes[i] {
            1 => (roll(2.0), 1.0),
            2 => (roll(3.0), 1.0),
            3 => (roll(4.0), 1.0),
            4 => ((i - rs + 1) as f64 * l, 1.0),
            5 => (t * 0.5, 1.0),
            6 => (2.0 * t, 1.0),
            7 => {
                let k = 1.0 - (t / span).min(1.0);
                (t - span / 3.0 * (1.0 - k * k * k), k as f32)
            }
            8 => (t - t * t / (2.0 * span), 1.0),
            _ => (0.0, 1.0),
        };
        (lag.max(0.0), gain * self.gains[i].clamp(0.0, 1.0))
    }
}

pub fn steps_eval(steps: &Steps, u: f64, depth: f32) -> (f64, f32) {
    let (lag, gain) = steps.eval(u);
    let d = depth.clamp(0.0, 1.0);
    (lag * d as f64, 1.0 - d * (1.0 - gain))
}

pub struct Gate {
    pb: ParamBank<N_PARAMS>,
    steps: Steps,
    fresh: bool,
    sr: f32,
    ring: [DelayLine; 2],
    pattern: usize,
    always: bool,
    active: bool,
    depth: f32,
    smooth_ms: f32,
    mix: Smooth,
    gain: f32,
    gain_coef: f32,
    lag: f64,
    old_lag: f64,
    xf: f32,
    xf_step: f32,
    was_engaged: bool,
    anchor: f64,
}

impl Gate {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let cap = (MAX_SECONDS * sr) as usize;
        let mut g = Self {
            pb: ParamBank::new(&param_specs()),
            steps: Steps::default(),
            fresh: true,
            sr,
            ring: [DelayLine::new(cap), DelayLine::new(cap)],
            pattern: 0,
            always: true,
            active: false,
            depth: 1.0,
            smooth_ms: 6.0,
            mix: Smooth::with_time(1.0, 20.0, sr),
            gain: 1.0,
            gain_coef: 0.01,
            lag: 0.0,
            old_lag: 0.0,
            xf: 1.0,
            xf_step: 0.01,
            was_engaged: false,
            anchor: 0.0,
        };
        g.update();
        g.mix.reset(g.mix.target);
        g
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.pattern = p.idx(P::Pattern as usize).min(PATTERNS.len() - 1);
        self.always = p.idx(P::Trigger as usize) == 0;
        self.active = p.on(P::Active as usize);
        self.depth = p.get(P::Depth as usize);
        self.smooth_ms = p.get(P::Smoothing as usize);
        self.gain_coef = tc_coef(self.smooth_ms * 0.5, self.sr);
        let xf_len = (self.smooth_ms * 0.001 * self.sr).max(16.0);
        self.xf_step = 1.0 / xf_len;
        self.mix.set(p.get(P::Mix as usize));
        let mut modes = [0u8; MAX_STEPS];
        let mut gains = [1.0f32; MAX_STEPS];
        for k in 0..MAX_STEPS {
            modes[k] = p.idx(P::S1 as usize + k).min(STEP_MODES.len() - 1) as u8;
            gains[k] = p.get(P::G1 as usize + k);
        }
        let len = STEP_DIV_BEATS[p.idx(P::StepDiv as usize).min(STEP_DIV_BEATS.len() - 1)];
        self.steps = Steps::new(len, p.idx(P::StepCount as usize), modes, gains);
    }

    fn cycle(&self) -> (f64, f64, bool) {
        if self.pattern == CUSTOM { (self.steps.cycle(), 0.0, false) } else { pattern_cycle(self.pattern) }
    }

    #[inline]
    fn position(&mut self, b: f64, engaged: bool) -> Option<f64> {
        let (cycle, start, one_shot) = self.cycle();
        if !engaged {
            self.was_engaged = false;
            return None;
        }
        if self.always {
            self.was_engaged = true;
            return Some(b.rem_euclid(cycle));
        }
        if !self.was_engaged {
            self.was_engaged = true;
            self.anchor = (b / 0.25).floor() * 0.25;
        }
        let t = (b - self.anchor).max(0.0);
        let span = cycle - start;
        Some(if one_shot { start + t.min(span - 1e-9) } else { start + t.rem_euclid(span) })
    }
}

impl Effect for Gate {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Gate::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        self.mix.reset(self.mix.target);
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn process(&mut self, ctx: &ProcessContext, mut buf: [&mut [f32]; 2], _sc: Option<[&[f32]; 2]>) {
        let n = frames(ctx, &buf);
        if self.pb.take_dirty() {
            self.update();
        }
        if self.fresh {
            self.fresh = false;
            self.mix.reset(self.mix.target);
        }
        let bpm = sane_bpm(ctx.bpm);
        let spb = 60.0 / bpm * self.sr as f64;
        let bps = 1.0 / spb;
        let playing = ctx.playing && ctx.beat_pos.is_finite();
        let engaged = playing && (self.always || self.active);
        let max_lag = self.ring[0].capacity() as f64 - 8.0;
        for i in 0..n {
            let b = if playing { ctx.beat_pos + i as f64 * bps } else { 0.0 };
            let (lag_beats, g_target) = match self.position(b, engaged) {
                Some(u) if self.pattern == CUSTOM => steps_eval(&self.steps, u, self.depth),
                Some(u) => pattern_eval(self.pattern, u, self.depth),
                None => (0.0, 1.0),
            };
            let target = (lag_beats * spb).clamp(0.0, max_lag);
            if (target - self.lag).abs() > JUMP {
                self.old_lag = self.lag;
                self.xf = 0.0;
            }
            self.lag = target;
            self.gain += (g_target - self.gain) * self.gain_coef;
            if (self.gain - g_target).abs() < 1e-6 {
                self.gain = g_target;
            }
            let mix = self.mix.next();
            let fading = self.xf < 1.0;
            let w = if fading { 0.5 - 0.5 * (std::f32::consts::PI * self.xf).cos() } else { 1.0 };
            for ch in 0..2 {
                let x = crate::blocks::finite(buf[ch][i]);
                self.ring[ch].push(x);
                let mut y = self.ring[ch].read_f64(self.lag);
                if fading {
                    let o = self.ring[ch].read_f64(self.old_lag);
                    y = o + (y - o) * w;
                }
                let wet = y * self.gain;
                buf[ch][i] = if mix >= 1.0 { wet } else { x + (wet - x) * mix };
            }
            if fading {
                self.xf = (self.xf + self.xf_step).min(1.0);
            }
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.ring.iter_mut().for_each(DelayLine::clear);
        self.lag = 0.0;
        self.old_lag = 0.0;
        self.xf = 1.0;
        self.gain = 1.0;
        self.was_engaged = false;
    }

    fn meter(&self) -> Option<f32> {
        let k = 1.0 + (self.gain - 1.0) * self.mix.cur;
        Some(if k > 1e-6 && k < 1.0 { -20.0 * k.log10() } else if k <= 1e-6 { 120.0 } else { 0.0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_only_looks_back() {
        for p in 0..CUSTOM {
            let (cycle, _, _) = pattern_cycle(p);
            let mut u = 0.0;
            while u < cycle {
                let (lag, g) = pattern_eval(p, u, 1.0);
                assert!((0.0..=2.0 + 1e-9).contains(&lag), "{} at {u}: lag {lag}", PATTERNS[p]);
                assert!((0.0..=1.0).contains(&g), "{} gain {g}", PATTERNS[p]);
                u += 0.001;
            }
        }
    }

    #[test]
    fn custom_steps_only_look_back_and_stay_bounded() {
        let mut seed = 7u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            seed >> 8
        };
        for case in 0..200 {
            let mut modes = [0u8; MAX_STEPS];
            let mut gains = [1.0f32; MAX_STEPS];
            for k in 0..MAX_STEPS {
                modes[k] = if k > 0 && rnd() % 3 == 0 { modes[k - 1] } else { (rnd() % STEP_MODES.len() as u32) as u8 };
                gains[k] = (rnd() % 101) as f32 / 100.0;
            }
            let len = STEP_DIV_BEATS[case % 4];
            let st = Steps::new(len, 1 + case % MAX_STEPS, modes, gains);
            let mut u = 0.0;
            while u < st.cycle() {
                let (lag, g) = steps_eval(&st, u, 1.0);
                assert!(lag.is_finite() && lag >= 0.0 && lag <= 2.0 * st.cycle() + 1e-9, "case {case} at {u}: lag {lag}");
                assert!((0.0..=1.0).contains(&g), "case {case} gain {g}");
                u += len / 37.0;
            }
        }
    }

    #[test]
    fn custom_step_modes() {
        let mut modes = [0u8; MAX_STEPS];
        let mut gains = [1.0f32; MAX_STEPS];
        modes[1] = 3;
        modes[4] = 6;
        modes[5] = 6;
        modes[8] = 4;
        modes[9] = 4;
        modes[12] = 7;
        gains[14] = 0.0;
        let st = Steps::new(0.25, 16, modes, gains);
        let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
        assert!(near(st.eval(0.1).0, 0.0), "play");
        assert!(near(st.eval(0.25 + 0.07).0, 0.0625) && near(st.eval(0.25 + 0.2).0, 0.1875));
        assert!(near(1.3 - st.eval(1.3).0, 0.7));
        assert!(near(2.05 - st.eval(2.05).0, 1.8) && near(2.3 - st.eval(2.3).0, 1.8));
        assert!(st.eval(3.01).1 > 0.9 && st.eval(3.249).1 < 0.01);
        assert_eq!(st.eval(3.6).1, 0.0);
        assert_eq!(steps_eval(&st, 3.6, 0.5).1, 0.5);
        assert!(near(steps_eval(&st, 1.3, 0.5).0, 0.3));
        modes[0] = 6;
        modes[15] = 6;
        let st = Steps::new(0.25, 16, modes, gains);
        assert!(near(st.eval(3.8).0, 2.0 * 0.05));
        assert!(near(st.eval(0.1).0, 0.2));
    }

    #[test]
    fn built_in_patterns_are_unchanged_by_the_step_params() {
        let specs = param_specs();
        let mut g = Gate::new(48000.0, 512);
        for (i, s) in specs.iter().enumerate() {
            if s.group == Some("Steps") {
                g.set_param(i, s.max);
            }
        }
        g.update();
        for p in 0..CUSTOM {
            g.pattern = p;
            assert_eq!(g.cycle(), pattern_cycle(p));
        }
    }
}
