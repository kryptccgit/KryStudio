use super::{frames, sane_sr, sanitize_block};
use crate::blocks::filters::svf_g;
use crate::blocks::lfo::{shape, TempoPhase};
use crate::blocks::{flush, tanh_fast, Smooth};
use crate::params::{param_table, sync_beats, ParamBank, SYNC_BEATS};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Stages => stepped("stages", "Stages", 4.0, 12.0, 6.0, "", 2.0, "Phaser"),
    Center => logp("center", "Centre", 100.0, 8000.0, 700.0, "Hz", "Phaser"),
    Depth => lin("depth", "Depth", 0.0, 1.0, 0.7, "%", "Phaser"),
    Rate => logp("rate", "Rate (free)", 0.01, 10.0, 0.35, "Hz", "Phaser"),
    Sync => toggle("sync", "Tempo sync", false, "Phaser"),
    Division => choice("division", "Rate (sync)", &SYNC_DIVISIONS, 11, "Phaser"),
    Feedback => lin("feedback", "Feedback", -0.9, 0.9, 0.5, "%", "Phaser"),
    Stereo => lin("stereo", "Stereo phase", 0.0, 180.0, 90.0, "deg", "Phaser"),
    Mix => lin("mix", "Mix", 0.0, 1.0, 0.5, "%", "Output"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.phaser",
        name: "Krypt Phaser",
        kind: PluginKind::Effect,
        category: "Modulation",
        description: "Phaser with 4-12 allpass stages (stages/2 notches) swept around Centre by a sine LFO: depth 1 = ±2 \
                      octaves. Free rate or tempo-synced to the bar. Feedback (±) sharpens the peaks; Stereo phase offsets \
                      the right LFO. Has its own Mix (50% = deepest notches). Zero latency.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

const MAX_STAGES: usize = 12;
const SWEEP_OCT: f32 = 2.0;

pub struct Phaser {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    sr: f32,
    s: [[f32; MAX_STAGES]; 2],
    last: [f32; 2],
    stages: usize,
    lfo: TempoPhase,
    sync: bool,
    div_beats: f64,
    div_idx: usize,
    rate: f32,
    stereo: f64,
    log_fc: Smooth,
    depth: Smooth,
    fb: Smooth,
    mix: Smooth,
}

impl Phaser {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let mut p = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            s: [[0.0; MAX_STAGES]; 2],
            last: [0.0; 2],
            stages: 6,
            lfo: TempoPhase::default(),
            sync: false,
            div_beats: 2.0,
            div_idx: 11,
            rate: 0.35,
            stereo: 0.25,
            log_fc: Smooth::with_time(700f32.log2(), 30.0, sr),
            depth: Smooth::with_time(0.7, 30.0, sr),
            fb: Smooth::with_time(0.5, 20.0, sr),
            mix: Smooth::with_time(0.5, 20.0, sr),
        };
        p.update();
        p.snap();
        p
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.stages = ((p.get(P::Stages as usize).round() as usize) & !1).clamp(4, MAX_STAGES);
        self.log_fc.set(p.get(P::Center as usize).log2());
        self.depth.set(p.get(P::Depth as usize));
        self.rate = p.get(P::Rate as usize);
        self.sync = p.on(P::Sync as usize);
        self.div_idx = p.idx(P::Division as usize).min(SYNC_BEATS.len() - 1);
        self.fb.set(p.get(P::Feedback as usize));
        self.stereo = p.get(P::Stereo as usize) as f64 / 360.0;
        self.mix.set(p.get(P::Mix as usize));
    }

    fn snap(&mut self) {
        self.log_fc.reset(self.log_fc.target);
        self.depth.reset(self.depth.target);
        self.fb.reset(self.fb.target);
        self.mix.reset(self.mix.target);
    }
}

impl Effect for Phaser {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Phaser::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
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
        if self.fresh {
            self.fresh = false;
            self.snap();
        }
        self.lfo.begin(ctx, self.sr, self.sync, self.div_beats, self.rate);
        let fs = self.sr as f64;
        let nyq = 0.45 * self.sr;
        let stages = self.stages;
        for i in 0..n {
            let ph = self.lfo.next();
            let lfc = self.log_fc.next();
            let depth = self.depth.next();
            let fb = self.fb.next();
            let mix = self.mix.next();
            for ch in 0..2 {
                let lfo = shape(0, (ph + if ch == 1 { self.stereo } else { 0.0 }).rem_euclid(1.0));
                let fc = (lfc + SWEEP_OCT * depth * lfo).exp2().clamp(20.0, nyq);
                let g = svf_g(fc as f64, fs) as f32;
                let gg = g / (1.0 + g);
                let x = crate::blocks::finite(buf[ch][i]);
                let mut v = x + 2.0 * tanh_fast(0.5 * fb * self.last[ch]);
                let st = &mut self.s[ch];
                for k in 0..stages {
                    let u = (v - st[k]) * gg;
                    let lp = u + st[k];
                    st[k] = flush(lp + u);
                    v = 2.0 * lp - v;
                }
                self.last[ch] = v;
                buf[ch][i] = x + (v - x) * mix;
            }
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.s = [[0.0; MAX_STAGES]; 2];
        self.last = [0.0; 2];
        self.lfo.reset();
    }
}
