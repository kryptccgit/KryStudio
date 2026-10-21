//! krypt.chorus — multi-voice chorus / ensemble. Up to six modulated delay
//! voices per channel (cubic Hermite reads), spread over slightly different
//! base delays and LFO rates so the ensemble never moves in lockstep. The
//! right channel's LFOs are offset by Stereo spread, which turns a mono
//! source wide. The wet path has its own low and high cut and an optional
//! touch of feedback; the dry path is untouched (zero latency).

use super::{frames, sane_sr, sanitize_block};
use crate::blocks::delay::DelayLine;
use crate::blocks::filters::{Svf, SvfMode};
use crate::blocks::{tanh_fast, Smooth, TAU};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Voices => stepped("voices", "Voices", 1.0, 6.0, 3.0, "", 1.0, "Chorus"),
    Rate => logp("rate", "Rate", 0.05, 10.0, 0.6, "Hz", "Chorus"),
    Depth => lin("depth", "Depth", 0.0, 1.0, 0.45, "%", "Chorus"),
    Delay => logp("delay", "Delay", 2.0, 40.0, 14.0, "ms", "Chorus"),
    Spread => lin("spread", "Stereo spread", 0.0, 1.0, 0.8, "%", "Chorus"),
    Feedback => lin("feedback", "Feedback", 0.0, 0.7, 0.0, "%", "Chorus"),
    LowCut => logp("lowCut", "Low cut", 20.0, 1000.0, 120.0, "Hz", "Tone"),
    HighCut => logp("highCut", "High cut", 1000.0, 20000.0, 12000.0, "Hz", "Tone"),
    Mix => lin("mix", "Mix", 0.0, 1.0, 0.5, "%", "Output"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.chorus",
        name: "Krypt Chorus",
        kind: PluginKind::Effect,
        category: "Modulation",
        description: "Multi-voice chorus and ensemble: 1-6 modulated delay voices per side with staggered delays and rates. \
                      Stereo spread offsets the right side's LFOs (a mono source turns wide). Depth 1 sweeps up to ±5 ms. \
                      Low/high cut shape the wet signal only, so bass stays mono and tight. Has its own Mix (50% = classic \
                      chorus). Zero latency.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

const MAX_VOICES: usize = 6;
/// Longest read: 40 ms base * 1.25 spread + 5 ms sweep, plus headroom.
const MAX_DELAY_S: f32 = 0.075;
const DELAY_MUL: [f32; MAX_VOICES] = [1.0, 1.12, 0.89, 1.21, 0.81, 1.05];
const RATE_MUL: [f32; MAX_VOICES] = [1.0, 1.07, 0.93, 1.13, 0.88, 1.03];
const PHASE_OFF: [f64; MAX_VOICES] = [0.0, 0.5, 0.25, 0.75, 0.125, 0.625];

pub struct Chorus {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    sr: f32,
    lines: [DelayLine; 2],
    hp: [Svf; 2],
    lp: [Svf; 2],
    phase: [f64; MAX_VOICES],
    voices: usize,
    rate: f32,
    spread: f32,
    base: Smooth,
    amp: Smooth,
    fb: Smooth,
    mix: Smooth,
    /// voice fade-in/out gains so changing the voice count never clicks
    vgain: [Smooth; MAX_VOICES],
}

impl Chorus {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let max = (MAX_DELAY_S * sr) as usize + 16;
        let mut c = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            lines: [DelayLine::new(max), DelayLine::new(max)],
            hp: [Svf::default(); 2],
            lp: [Svf::default(); 2],
            phase: [0.0; MAX_VOICES],
            voices: 3,
            rate: 0.6,
            spread: 0.8,
            base: Smooth::with_time(0.014 * sr, 60.0, sr),
            amp: Smooth::with_time(0.0, 40.0, sr),
            fb: Smooth::with_time(0.0, 20.0, sr),
            mix: Smooth::with_time(0.5, 20.0, sr),
            vgain: [Smooth::with_time(0.0, 15.0, sr); MAX_VOICES],
        };
        c.update();
        c.snap();
        c
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.voices = (p.get(P::Voices as usize).round() as usize).clamp(1, MAX_VOICES);
        self.rate = p.get(P::Rate as usize);
        self.spread = p.get(P::Spread as usize);
        let base_ms = p.get(P::Delay as usize);
        self.base.set(base_ms * 0.001 * self.sr);
        // sweep amplitude: never deeper than 80% of the base delay
        let amp_ms = p.get(P::Depth as usize) * (0.8 * base_ms).min(5.0);
        self.amp.set(amp_ms * 0.001 * self.sr);
        self.fb.set(p.get(P::Feedback as usize));
        self.mix.set(p.get(P::Mix as usize));
        let norm = 1.0 / (self.voices as f32).sqrt();
        for (v, g) in self.vgain.iter_mut().enumerate() {
            g.set(if v < self.voices { norm } else { 0.0 });
        }
        let fs = self.sr as f64;
        let lc = p.get(P::LowCut as usize) as f64;
        let hc = (p.get(P::HighCut as usize) as f64).min(fs * 0.45);
        for ch in 0..2 {
            self.hp[ch].design(SvfMode::Highpass, lc, 0.707, 0.0, fs);
            self.lp[ch].design(SvfMode::Lowpass, hc, 0.707, 0.0, fs);
        }
    }

    fn snap(&mut self) {
        self.base.reset(self.base.target);
        self.amp.reset(self.amp.target);
        self.fb.reset(self.fb.target);
        self.mix.reset(self.mix.target);
        for g in self.vgain.iter_mut() {
            g.reset(g.target);
        }
    }
}

impl Effect for Chorus {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Chorus::new(sample_rate, max_frames);
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
        if self.fresh {
            self.fresh = false;
            self.snap();
        }
        let nv = MAX_VOICES;
        // fixed per-voice patterns (independent of the voice count, so
        // adding a voice never moves the others)
        let mut inc = [0.0f64; MAX_VOICES];
        let mut dmul = [[1.0f32; MAX_VOICES]; 2];
        let active = self.voices;
        for v in 0..nv {
            inc[v] = (self.rate * RATE_MUL[v]) as f64 / self.sr as f64;
            dmul[0][v] = DELAY_MUL[v];
            let alt = if v % 2 == 0 { 1.0 } else { -1.0 };
            dmul[1][v] = DELAY_MUL[v] * (1.0 + 0.08 * self.spread * alt);
        }
        let r_off = self.spread as f64 * 0.25;
        let max_d = self.lines[0].capacity() as f32 - 4.0;
        for i in 0..n {
            let base = self.base.next();
            let amp = self.amp.next();
            let fb = self.fb.next();
            let mix = self.mix.next();
            let mut g = [0.0f32; MAX_VOICES];
            for v in 0..nv {
                g[v] = self.vgain[v].next();
                self.phase[v] += inc[v];
                if self.phase[v] >= 1.0 {
                    self.phase[v] -= 1.0;
                }
            }
            let mut wet = [0.0f32; 2];
            let mut first = [0.0f32; 2];
            for ch in 0..2 {
                let line = &self.lines[ch];
                let mut acc = 0.0f32;
                for v in 0..nv {
                    if g[v] == 0.0 && v >= active {
                        continue;
                    }
                    let ph = self.phase[v] + PHASE_OFF[v] + if ch == 1 { r_off } else { 0.0 };
                    let lfo = ((ph as f32) * TAU).sin();
                    let d = (base * dmul[ch][v] + amp * lfo).clamp(1.0, max_d);
                    let y = line.read_frac(d);
                    if v == 0 {
                        first[ch] = y;
                    }
                    acc += y * g[v];
                }
                wet[ch] = acc;
            }
            for ch in 0..2 {
                let x = crate::blocks::finite(buf[ch][i]);
                // bounded feedback (2·tanh(v/2) is ~identity for small v)
                let fbv = if fb > 0.0 { 2.0 * tanh_fast(0.5 * fb * first[ch]) } else { 0.0 };
                self.lines[ch].push(crate::blocks::flush(x + fbv));
                let w = self.lp[ch].tick(self.hp[ch].tick(wet[ch] as f64)) as f32;
                buf[ch][i] = x + (w - x) * mix;
            }
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
