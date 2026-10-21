use super::{frames, sane_sr, sanitize_block};
use crate::blocks::delay::DelayLine;
use crate::blocks::lfo::{shape, TempoPhase};
use crate::blocks::{tanh_fast, Smooth};
use crate::params::{param_table, sync_beats, ParamBank, SYNC_BEATS};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Delay => logp("delay", "Delay", 0.1, 10.0, 1.0, "ms", "Flanger"),
    Depth => lin("depth", "Depth", 0.0, 1.0, 0.7, "%", "Flanger"),
    Rate => logp("rate", "Rate (free)", 0.01, 10.0, 0.2, "Hz", "Flanger"),
    Sync => toggle("sync", "Tempo sync", false, "Flanger"),
    Division => choice("division", "Rate (sync)", &SYNC_DIVISIONS, 12, "Flanger"),
    Shape => choice("shape", "LFO shape", &["Sine", "Triangle"], 1, "Flanger"),
    Feedback => lin("feedback", "Feedback", -0.95, 0.95, 0.5, "%", "Flanger"),
    ThroughZero => not_automatable(toggle("throughZero", "Through-zero", false, "Flanger")),
    Stereo => lin("stereo", "Stereo phase", 0.0, 180.0, 90.0, "deg", "Flanger"),
    Mix => lin("mix", "Mix", 0.0, 1.0, 0.5, "%", "Output"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.flanger",
        name: "Krypt Flanger",
        kind: PluginKind::Effect,
        category: "Modulation",
        description: "Flanger: a 0.1-10 ms delay swept exponentially by a sine or triangle LFO (free or tempo-synced to the \
                      bar), with positive or negative feedback for metallic or hollow tones. Stereo phase offsets the right \
                      LFO. Through-zero mode delays the dry signal 3 ms (that is its latency; 0 otherwise) and sweeps the \
                      wet tap through it for the classic jet cancellation; Delay is then ignored. Has its own Mix.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

const MAX_DELAY_S: f32 = 0.075;
const TZ_MS: f32 = 3.0;
const SWEEP_OCT: f32 = 2.5;

pub struct Flanger {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    sr: f32,
    lines: [DelayLine; 2],
    dry: [DelayLine; 2],
    lfo: TempoPhase,
    sync: bool,
    div_beats: f64,
    div_idx: usize,
    rate: f32,
    tri: bool,
    tz: bool,
    tz_len: usize,
    stereo: f64,
    log_base: Smooth,
    depth: Smooth,
    fb: Smooth,
    mix: Smooth,
    last: [f32; 2],
}

impl Flanger {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let max = (MAX_DELAY_S * sr) as usize + 16;
        let tz_len = ((TZ_MS * 0.001 * sr).round() as usize).max(4);
        let mut f = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            lines: [DelayLine::new(max), DelayLine::new(max)],
            dry: [DelayLine::new(tz_len + 4), DelayLine::new(tz_len + 4)],
            lfo: TempoPhase::default(),
            sync: false,
            div_beats: 4.0,
            div_idx: 12,
            rate: 0.2,
            tri: true,
            tz: false,
            tz_len,
            stereo: 0.25,
            log_base: Smooth::with_time(0.0, 40.0, sr),
            depth: Smooth::with_time(0.7, 30.0, sr),
            fb: Smooth::with_time(0.5, 20.0, sr),
            mix: Smooth::with_time(0.5, 20.0, sr),
            last: [0.0; 2],
        };
        f.update();
        f.snap();
        f
    }

    fn update(&mut self) {
        let p = &self.pb;
        let base = p.get(P::Delay as usize) * 0.001 * self.sr;
        self.log_base.set(base.max(1e-3).log2());
        self.depth.set(p.get(P::Depth as usize));
        self.rate = p.get(P::Rate as usize);
        self.sync = p.on(P::Sync as usize);
        self.div_idx = p.idx(P::Division as usize).min(SYNC_BEATS.len() - 1);
        self.tri = p.idx(P::Shape as usize) == 1;
        self.fb.set(p.get(P::Feedback as usize));
        let tz = p.on(P::ThroughZero as usize);
        if tz != self.tz {
            self.tz = tz;
            self.dry.iter_mut().for_each(DelayLine::clear);
        }
        self.stereo = p.get(P::Stereo as usize) as f64 / 360.0;
        self.mix.set(p.get(P::Mix as usize));
    }

    fn snap(&mut self) {
        self.log_base.reset(self.log_base.target);
        self.depth.reset(self.depth.target);
        self.fb.reset(self.fb.target);
        self.mix.reset(self.mix.target);
    }

    #[inline]
    fn lfo_at(&self, ph: f64) -> f32 {
        shape(if self.tri { 1 } else { 0 }, ph.rem_euclid(1.0))
    }
}

impl Effect for Flanger {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Flanger::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        self.snap();
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
        if self.pb.take_dirty() {
            self.update();
        }
    }

    fn latency(&self) -> usize {
        if self.tz {
            self.tz_len
        } else {
            0
        }
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
        let max_d = self.lines[0].capacity() as f32 - 4.0;
        let tzl = self.tz_len as f32;
        for i in 0..n {
            let ph = self.lfo.next();
            let base = self.log_base.next().exp2();
            let depth = self.depth.next();
            let fb = self.fb.next();
            let mix = self.mix.next();
            for ch in 0..2 {
                let lfo = self.lfo_at(ph + if ch == 1 { self.stereo } else { 0.0 });
                let x = crate::blocks::finite(buf[ch][i]);
                let (d, dry) = if self.tz {
                    self.dry[ch].push(x);
                    ((tzl * (1.0 + depth * lfo)).clamp(0.0, max_d), self.dry[ch].read(self.tz_len))
                } else {
                    ((base * (SWEEP_OCT * depth * lfo).exp2()).clamp(1.0, max_d), x)
                };
                let fbv = 2.0 * tanh_fast(0.5 * fb * self.last[ch]);
                self.lines[ch].push(crate::blocks::flush(x + fbv));
                let wet = self.lines[ch].read_f64(d as f64);
                self.last[ch] = wet;
                buf[ch][i] = dry + (wet - dry) * mix;
            }
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.lines.iter_mut().for_each(DelayLine::clear);
        self.dry.iter_mut().for_each(DelayLine::clear);
        self.last = [0.0; 2];
        self.lfo.reset();
    }
}
