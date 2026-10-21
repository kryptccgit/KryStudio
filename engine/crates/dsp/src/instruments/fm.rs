//! krypt.fm — "Krypt FM": four-operator phase-modulation synth.
//!
//! Our own design (no third-party code). Eight algorithms cover the usual
//! 4-operator topologies, from a full 4→3→2→1 stack to four additive
//! carriers. Operator 4 can modulate itself (feedback, averaged over two
//! samples for stability). Each operator has a frequency ratio
//! (coarse × (1 + fine)) plus detune, an output level on a 48 dB taper
//! (as a modulator, level 1 = 4π rad of index), velocity sensitivity and its
//! own AHDSR envelope.
//!
//! Anti-aliasing: below 88.2 kHz the operators run at 2x and every voice
//! decimates through the shared halfband design (`Decimator2x`). Voice
//! gain, velocity fade-in and choke fades are applied after decimation, so
//! a voice can stop at any sample without truncating the filter's memory
//! audibly. Sines come from a 4096-point table with linear interpolation
//! (error < −120 dB) and 32-bit phase accumulators.
//!
//! After the operators: a TPT SVF per voice (type, cutoff, resonance, key
//! tracking, decaying envelope), vibrato, per-note pan, Mod X → cutoff,
//! Mod Y → modulator brightness.

use super::sampler::{reso_to_k, sanitize_sr, svf_typed};
use super::{instrument_process, NoteStart, OutStage, Voice, VoiceManager, CHOKE_MS};
use crate::blocks::env::{Ahdsr, EnvParams, ExpDecay};
use crate::blocks::filters::{svf_g, Svf};
use crate::blocks::oversample::Decimator2x;
use crate::blocks::{db_to_gain, midi_to_hz, pan_gains, vel_gain, Glide, Smooth, TAU};
use crate::params::{param_table, ParamBank};
use crate::{Instrument, NoteExtras, PluginDescriptor, PluginKind, ProcessContext};

pub const ALGORITHMS: [&str; 8] = [
    "1: 4>3>2>1 stack",
    "2: (4+3)>2>1",
    "3: (3>2)+4 > 1",
    "4: (4>3)+2 > 1",
    "5: 4>3 + 2>1 pairs",
    "6: 4 > 3+2+1",
    "7: 4>3 + 2 + 1",
    "8: 4+3+2+1 additive",
];

param_table! {
    Algorithm => choice("algorithm", "Algorithm", &ALGORITHMS, 4, "Algorithm"),
    Feedback => lin("feedback", "Op 4 feedback", 0.0, 1.0, 0.0, "%", "Algorithm"),
    Op1Ratio => stepped("op1Ratio", "Ratio", 0.5, 16.0, 1.0, "x", 0.5, "Op 1"),
    Op1Fine => lin("op1Fine", "Fine", 0.0, 1.0, 0.0, "%", "Op 1"),
    Op1Detune => lin("op1Detune", "Detune", -50.0, 50.0, 0.0, "ct", "Op 1"),
    Op1Level => lin("op1Level", "Level", 0.0, 1.0, 0.85, "%", "Op 1"),
    Op1Vel => lin("op1Vel", "Velocity", 0.0, 1.0, 0.7, "%", "Op 1"),
    Op1Attack => logp("op1Attack", "Attack", 0.1, 10000.0, 1.0, "ms", "Op 1"),
    Op1Hold => logp("op1Hold", "Hold", 0.1, 5000.0, 0.1, "ms", "Op 1"),
    Op1Decay => logp("op1Decay", "Decay", 1.0, 20000.0, 3500.0, "ms", "Op 1"),
    Op1Sustain => lin("op1Sustain", "Sustain", 0.0, 1.0, 0.0, "%", "Op 1"),
    Op1Release => logp("op1Release", "Release", 1.0, 10000.0, 450.0, "ms", "Op 1"),
    Op2Ratio => stepped("op2Ratio", "Ratio", 0.5, 16.0, 1.0, "x", 0.5, "Op 2"),
    Op2Fine => lin("op2Fine", "Fine", 0.0, 1.0, 0.0, "%", "Op 2"),
    Op2Detune => lin("op2Detune", "Detune", -50.0, 50.0, 0.0, "ct", "Op 2"),
    Op2Level => lin("op2Level", "Level", 0.0, 1.0, 0.6, "%", "Op 2"),
    Op2Vel => lin("op2Vel", "Velocity", 0.0, 1.0, 0.9, "%", "Op 2"),
    Op2Attack => logp("op2Attack", "Attack", 0.1, 10000.0, 1.0, "ms", "Op 2"),
    Op2Hold => logp("op2Hold", "Hold", 0.1, 5000.0, 0.1, "ms", "Op 2"),
    Op2Decay => logp("op2Decay", "Decay", 1.0, 20000.0, 2000.0, "ms", "Op 2"),
    Op2Sustain => lin("op2Sustain", "Sustain", 0.0, 1.0, 0.1, "%", "Op 2"),
    Op2Release => logp("op2Release", "Release", 1.0, 10000.0, 450.0, "ms", "Op 2"),
    Op3Ratio => stepped("op3Ratio", "Ratio", 0.5, 16.0, 1.0, "x", 0.5, "Op 3"),
    Op3Fine => lin("op3Fine", "Fine", 0.0, 1.0, 0.0, "%", "Op 3"),
    Op3Detune => lin("op3Detune", "Detune", -50.0, 50.0, 3.0, "ct", "Op 3"),
    Op3Level => lin("op3Level", "Level", 0.0, 1.0, 0.65, "%", "Op 3"),
    Op3Vel => lin("op3Vel", "Velocity", 0.0, 1.0, 0.9, "%", "Op 3"),
    Op3Attack => logp("op3Attack", "Attack", 0.1, 10000.0, 0.5, "ms", "Op 3"),
    Op3Hold => logp("op3Hold", "Hold", 0.1, 5000.0, 0.1, "ms", "Op 3"),
    Op3Decay => logp("op3Decay", "Decay", 1.0, 20000.0, 1200.0, "ms", "Op 3"),
    Op3Sustain => lin("op3Sustain", "Sustain", 0.0, 1.0, 0.0, "%", "Op 3"),
    Op3Release => logp("op3Release", "Release", 1.0, 10000.0, 300.0, "ms", "Op 3"),
    Op4Ratio => stepped("op4Ratio", "Ratio", 0.5, 16.0, 14.0, "x", 0.5, "Op 4"),
    Op4Fine => lin("op4Fine", "Fine", 0.0, 1.0, 0.0, "%", "Op 4"),
    Op4Detune => lin("op4Detune", "Detune", -50.0, 50.0, 0.0, "ct", "Op 4"),
    Op4Level => lin("op4Level", "Level", 0.0, 1.0, 0.5, "%", "Op 4"),
    Op4Vel => lin("op4Vel", "Velocity", 0.0, 1.0, 1.0, "%", "Op 4"),
    Op4Attack => logp("op4Attack", "Attack", 0.1, 10000.0, 0.1, "ms", "Op 4"),
    Op4Hold => logp("op4Hold", "Hold", 0.1, 5000.0, 0.1, "ms", "Op 4"),
    Op4Decay => logp("op4Decay", "Decay", 1.0, 20000.0, 250.0, "ms", "Op 4"),
    Op4Sustain => lin("op4Sustain", "Sustain", 0.0, 1.0, 0.0, "%", "Op 4"),
    Op4Release => logp("op4Release", "Release", 1.0, 10000.0, 200.0, "ms", "Op 4"),
    FilterType => choice("filterType", "Type", &["Low pass", "High pass", "Band pass", "Notch"], 0, "Filter"),
    Cutoff => logp("cutoff", "Cutoff", 20.0, 20000.0, 20000.0, "Hz", "Filter"),
    Reso => lin("reso", "Resonance", 0.0, 1.0, 0.0, "%", "Filter"),
    FilterEnvAmount => lin("filterEnvAmount", "Env amount", -1.0, 1.0, 0.0, "%", "Filter"),
    FilterEnvDecay => logp("filterEnvDecay", "Env decay", 1.0, 10000.0, 400.0, "ms", "Filter"),
    FilterKeyTrack => lin("filterKeyTrack", "Key tracking", 0.0, 1.0, 0.0, "%", "Filter"),
    VibratoRate => logp("vibratoRate", "Vibrato rate", 0.1, 12.0, 5.0, "Hz", "Voice"),
    Vibrato => lin("vibrato", "Vibrato depth", 0.0, 100.0, 0.0, "ct", "Voice"),
    Gain => lin("gain", "Gain", -24.0, 12.0, -6.0, "dB", "Voice"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.fm",
        name: "Krypt FM",
        kind: PluginKind::Instrument,
        category: "Synth",
        description: "Four-operator FM synth: 8 algorithms (stack, pairs, one-to-many, additive), op 4 feedback, per-operator \
                      ratio (coarse x (1 + fine)), detune, level, velocity sensitivity and AHDSR. Default patch is an \
                      electric piano (pairs: 1:1 body + 14:1 tine); bells, basses, brass, organs and pads are a few knobs \
                      away. 2x oversampled, plus filter with envelope, vibrato, Mod X = cutoff, Mod Y = brightness.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: None,
    }
}

const TABLE_BITS: u32 = 12;
const TABLE_SIZE: usize = 1 << TABLE_BITS;
const FRAC_BITS: u32 = 32 - TABLE_BITS;
/// Phase-modulation depth at level 1, in cycles (2 cycles = 4π rad).
const MOD_CYCLES: f32 = 2.0;
/// Op 4 feedback depth at 100%, in cycles.
const FB_CYCLES: f32 = 0.3;
const TWO32: f32 = 4_294_967_296.0;

/// (modulation sources per op, carrier flags); op index 0 = operator 1.
/// In every algorithm a modulator has a higher index than its target, so
/// evaluating 4 → 1 is always in dependency order.
const ALGS: [([[bool; 4]; 4], [bool; 4]); 8] = {
    const F: bool = false;
    const T: bool = true;
    [
        ([[F, T, F, F], [F, F, T, F], [F, F, F, T], [F; 4]], [T, F, F, F]),
        ([[F, T, F, F], [F, F, T, T], [F; 4], [F; 4]], [T, F, F, F]),
        ([[F, T, F, T], [F, F, T, F], [F; 4], [F; 4]], [T, F, F, F]),
        ([[F, T, T, F], [F; 4], [F, F, F, T], [F; 4]], [T, F, F, F]),
        ([[F, T, F, F], [F; 4], [F, F, F, T], [F; 4]], [T, F, T, F]),
        ([[F, F, F, T], [F, F, F, T], [F, F, F, T], [F; 4]], [T, T, T, F]),
        ([[F; 4], [F; 4], [F, F, F, T], [F; 4]], [T, T, T, F]),
        ([[F; 4], [F; 4], [F; 4], [F; 4]], [T, T, T, T]),
    ]
};

/// Level knob → amplitude on a 48 dB taper (0 → silent).
#[inline]
fn level_amp(level: f32) -> f32 {
    if level <= 0.0 {
        0.0
    } else {
        db_to_gain(-48.0 * (1.0 - level.min(1.0)))
    }
}

pub(crate) struct FmShared {
    sine: Vec<f32>,
    mods: [[bool; 4]; 4],
    carrier: [bool; 4],
    carrier_norm: f32,
    ratio: [f64; 4],
    amp: [f32; 4],
    vel_sens: [f32; 4],
    env: [EnvParams; 4],
    fb: f32,
    vib_rate: f32,
    vib_cents: f32,
    ftype: usize,
    cutoff: f32,
    reso: f32,
    fenv_amt: f32,
    fenv_ms: f32,
    kt: f32,
    filter_on: bool,
    os: bool,
}

#[inline]
fn sine_at(table: &[f32], ph: u32) -> f32 {
    let i = (ph >> FRAC_BITS) as usize;
    let f = (ph & ((1 << FRAC_BITS) - 1)) as f32 * (1.0 / (1u32 << FRAC_BITS) as f32);
    let a = table[i];
    a + (table[i + 1] - a) * f
}

pub(crate) struct FmVoice {
    active: bool,
    choking: bool,
    fade: f32,
    fade_step: f32,
    fadein: f32,
    fadein_step: f32,
    glide: Glide,
    vel_raw: f32,
    vel_scale: [f32; 4],
    pl: f32,
    pr: f32,
    mod_x: f32,
    bright: f32,
    ph: [u32; 4],
    fb_hist: [f32; 2],
    env: [Ahdsr; 4],
    amp_s: [Smooth; 4],
    fenv: ExpDecay,
    filt: Svf,
    /// smoothed log2 cutoff (automation without zipper)
    cut_s: Smooth,
    dec: Decimator2x,
    vib_ph: f32,
    coef_count: u32,
    sr: f32,
}

impl FmVoice {
    fn new(sr: f32) -> Self {
        let mut env = [Ahdsr::default(); 4];
        env.iter_mut().for_each(|e| e.set_sr(sr));
        Self {
            active: false,
            choking: false,
            fade: 1.0,
            fade_step: 1.0 / (CHOKE_MS * 0.001 * sr),
            fadein: 1.0,
            fadein_step: 1.0 / (CHOKE_MS * 0.001 * sr),
            glide: Glide::default(),
            vel_raw: 0.0,
            vel_scale: [1.0; 4],
            pl: 1.0,
            pr: 1.0,
            mod_x: 0.5,
            bright: 1.0,
            ph: [0; 4],
            fb_hist: [0.0; 2],
            env,
            amp_s: [Smooth::with_time(0.0, 5.0, sr); 4],
            fenv: ExpDecay::default(),
            filt: Svf::default(),
            cut_s: Smooth::with_time(20000f32.log2(), 10.0, sr),
            dec: Decimator2x::new(),
            vib_ph: 0.0,
            coef_count: 0,
            sr,
        }
    }

    /// Operator amplitude: level × velocity scaling (× Mod Y on modulators).
    #[inline]
    fn amp_target(&self, sh: &FmShared, k: usize) -> f32 {
        let b = if sh.carrier[k] { 1.0 } else { self.bright };
        sh.amp[k] * self.vel_scale[k] * b
    }

    #[inline]
    fn sounding(&self, sh: &FmShared) -> bool {
        (0..4).any(|k| sh.carrier[k] && !self.env[k].idle())
    }

    /// One operator pass (the 4 → 1 evaluation) at phase increments `inc`.
    #[inline]
    fn tick_ops(&mut self, sh: &FmShared, amp: &[f32; 4], inc: &[u32; 4]) -> f32 {
        let mut out = [0.0f32; 4];
        let mut sum = 0.0f32;
        for k in (0..4).rev() {
            let mut pm = 0.0f32;
            for src in (k + 1)..4 {
                if sh.mods[k][src] {
                    pm += out[src];
                }
            }
            if k == 3 && sh.fb > 0.0 {
                pm += sh.fb * FB_CYCLES * 0.5 * (self.fb_hist[0] + self.fb_hist[1]) / MOD_CYCLES;
            }
            let off = (pm * MOD_CYCLES * TWO32) as i64 as u32;
            let s = sine_at(&sh.sine, self.ph[k].wrapping_add(off));
            let y = s * amp[k];
            if k == 3 {
                self.fb_hist[1] = self.fb_hist[0];
                self.fb_hist[0] = y;
            }
            out[k] = y;
            if sh.carrier[k] {
                sum += y;
            }
            self.ph[k] = self.ph[k].wrapping_add(inc[k]);
        }
        sum * sh.carrier_norm
    }
}

impl Voice for FmVoice {
    type Shared = FmShared;

    fn start(&mut self, sh: &FmShared, n: &NoteStart, _g: Option<f32>, _gm: f32) {
        self.fadein = if n.xfade { 0.0 } else { 1.0 };
        self.glide.jump(n.pitch);
        self.vel_raw = n.vel;
        let vg = vel_gain(n.vel);
        self.bright = ((n.extras.mod_y - 0.5) * 2.0).exp2();
        for k in 0..4 {
            let s = sh.vel_sens[k];
            self.vel_scale[k] = (1.0 - s) + s * vg;
            self.env[k].kill();
            self.env[k].trigger(&sh.env[k]);
            self.amp_s[k].reset(self.amp_target(sh, k));
        }
        (self.pl, self.pr) = pan_gains(n.extras.pan);
        self.mod_x = n.extras.mod_x;
        self.ph = [0; 4];
        self.fb_hist = [0.0; 2];
        self.fenv.trigger(sh.fenv_ms, 60.0, self.sr);
        self.filt.reset();
        self.cut_s.reset(sh.cutoff.log2());
        self.dec.reset();
        self.vib_ph = 0.0;
        self.coef_count = 0;
        self.fade = 1.0;
        self.choking = false;
        self.active = true;
    }

    fn legato(&mut self, _sh: &FmShared, pitch: f32, glide_ms: f32) {
        self.glide.to(pitch, glide_ms, self.sr);
    }

    fn release(&mut self, sh: &FmShared) {
        for k in 0..4 {
            self.env[k].release(&sh.env[k]);
        }
    }

    fn choke(&mut self) {
        self.choking = true;
    }

    fn kill(&mut self) {
        self.active = false;
        self.choking = false;
        self.env.iter_mut().for_each(Ahdsr::kill);
    }

    fn active(&self) -> bool {
        self.active
    }

    fn choking(&self) -> bool {
        self.choking
    }

    fn pitch(&self) -> f32 {
        self.glide.cur
    }

    fn render(&mut self, sh: &FmShared, l: &mut [f32], r: &mut [f32]) {
        let os = if sh.os { 2.0 } else { 1.0 };
        let rate = self.sr as f64 * os;
        let nyq = 0.45 * self.sr;
        let vib_inc = sh.vib_rate / self.sr;
        for k in 0..4 {
            let t = self.amp_target(sh, k);
            self.amp_s[k].set(t);
        }
        let env_scale = sh.fenv_amt * 7.0 * (0.55 + 0.45 * self.vel_raw);
        self.cut_s.set(sh.cutoff.log2());
        let mod_x_oct = (self.mod_x - 0.5) * 4.0;
        let mut inc = [0u32; 4];
        let mut pitch_ctr = 0u32;
        for i in 0..l.len() {
            if pitch_ctr == 0 {
                // pitch (glide + vibrato) at a 16-sample control rate
                self.vib_ph += vib_inc * 16.0;
                if self.vib_ph >= 1.0 {
                    self.vib_ph -= 1.0;
                }
                let vib = sh.vib_cents * 0.01 * (self.vib_ph * TAU).sin();
                let f0 = midi_to_hz(self.glide.cur + vib) as f64;
                for k in 0..4 {
                    let step = (f0 * sh.ratio[k] / rate).min(0.49);
                    inc[k] = (step * 4_294_967_296.0) as u32;
                }
                pitch_ctr = 16;
            }
            pitch_ctr -= 1;
            if self.glide.gliding() {
                self.glide.next();
            }
            let mut amp = [0.0f32; 4];
            for k in 0..4 {
                amp[k] = self.amp_s[k].next() * self.env[k].next(&sh.env[k]);
            }
            let y = if sh.os {
                let a = self.tick_ops(sh, &amp, &inc);
                let b = self.tick_ops(sh, &amp, &inc);
                self.dec.process(a, b)
            } else {
                self.tick_ops(sh, &amp, &inc)
            };
            // filter
            let fe = self.fenv.next();
            let y = if sh.filter_on {
                if self.coef_count == 0 {
                    let oct = env_scale * fe + sh.kt * (self.glide.cur - 60.0) / 12.0 + mod_x_oct;
                    let c = (self.cut_s.advance(8) + oct.clamp(-12.0, 12.0)).exp2().clamp(20.0, nyq);
                    self.filt.set_gk(svf_g(c as f64, self.sr as f64), reso_to_k(sh.reso));
                    self.coef_count = 8;
                }
                self.coef_count -= 1;
                svf_typed(&mut self.filt, sh.ftype, y as f64) as f32
            } else {
                y
            };
            let mut g = 1.0;
            if self.fadein < 1.0 {
                self.fadein = (self.fadein + self.fadein_step).min(1.0);
                g *= self.fadein;
            }
            let mut done = !self.sounding(sh);
            if self.choking {
                self.fade -= self.fade_step;
                if self.fade <= 0.0 {
                    self.fade = 0.0;
                    done = true;
                }
                g *= self.fade;
            }
            l[i] += y * g * self.pl;
            r[i] += y * g * self.pr;
            if done {
                self.kill();
                return;
            }
        }
    }
}

pub struct Fm {
    pb: ParamBank<N_PARAMS>,
    shared: FmShared,
    vm: VoiceManager<FmVoice>,
    out: OutStage,
}

impl Fm {
    pub fn new(sample_rate: f32, max_frames: usize) -> Self {
        let sr = sanitize_sr(sample_rate);
        let sine: Vec<f32> = (0..=TABLE_SIZE).map(|i| (i as f64 / TABLE_SIZE as f64 * std::f64::consts::TAU).sin() as f32).collect();
        let mut s = Self {
            pb: ParamBank::new(&param_specs()),
            shared: FmShared {
                sine,
                mods: ALGS[4].0,
                carrier: ALGS[4].1,
                carrier_norm: 1.0,
                ratio: [1.0; 4],
                amp: [0.0; 4],
                vel_sens: [0.0; 4],
                env: [EnvParams::default(); 4],
                fb: 0.0,
                vib_rate: 5.0,
                vib_cents: 0.0,
                ftype: 0,
                cutoff: 20000.0,
                reso: 0.0,
                fenv_amt: 0.0,
                fenv_ms: 400.0,
                kt: 0.0,
                filter_on: false,
                os: sr < 88_000.0,
            },
            vm: VoiceManager::new(16, || FmVoice::new(sr)),
            out: OutStage::new(max_frames, sr),
        };
        s.update();
        s.out.gain.reset(s.out.gain.target);
        s
    }

    fn update(&mut self) {
        let p = &self.pb;
        let sh = &mut self.shared;
        let alg = p.idx(P::Algorithm as usize).min(7);
        sh.mods = ALGS[alg].0;
        sh.carrier = ALGS[alg].1;
        let nc = sh.carrier.iter().filter(|c| **c).count().max(1);
        sh.carrier_norm = 1.0 / (nc as f32).sqrt();
        sh.fb = p.get(P::Feedback as usize);
        let base = P::Op1Ratio as usize;
        let stride = P::Op2Ratio as usize - base;
        for k in 0..4 {
            let o = base + k * stride;
            // ratio, fine, detune, level, vel, attack, hold, decay, sustain, release
            let ratio = p.get(o) as f64 * (1.0 + p.get(o + 1) as f64);
            sh.ratio[k] = ratio * (p.get(o + 2) as f64 / 1200.0).exp2();
            sh.amp[k] = level_amp(p.get(o + 3));
            sh.vel_sens[k] = p.get(o + 4);
            sh.env[k] = EnvParams {
                attack_ms: p.get(o + 5),
                hold_ms: p.get(o + 6),
                decay_ms: p.get(o + 7),
                sustain: p.get(o + 8),
                release_ms: p.get(o + 9),
            };
        }
        sh.ftype = p.idx(P::FilterType as usize).min(3);
        sh.cutoff = p.get(P::Cutoff as usize);
        sh.reso = p.get(P::Reso as usize);
        sh.fenv_amt = p.get(P::FilterEnvAmount as usize);
        sh.fenv_ms = p.get(P::FilterEnvDecay as usize);
        sh.kt = p.get(P::FilterKeyTrack as usize);
        sh.filter_on = !(sh.ftype == 0 && sh.cutoff >= 19_500.0 && sh.fenv_amt == 0.0 && sh.kt == 0.0 && sh.reso == 0.0);
        sh.vib_rate = p.get(P::VibratoRate as usize);
        sh.vib_cents = p.get(P::Vibrato as usize);
        self.out.gain.set(db_to_gain(p.get(P::Gain as usize)));
    }
}

impl Instrument for Fm {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let sr = sanitize_sr(sample_rate);
        self.vm.all_off();
        for v in self.vm.voices.iter_mut() {
            *v = FmVoice::new(sr);
        }
        self.shared.os = sr < 88_000.0;
        self.out.prepare(max_frames, sr);
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn set_voice_mode(&mut self, mono: bool, glide_ms: f32) {
        self.vm.set_voice_mode(mono, glide_ms);
    }

    fn note_on(&mut self, offset: usize, key: u8, pitch: f32, velocity: f32, extras: NoteExtras) {
        self.vm.note_on(offset, key, pitch, velocity, extras);
    }

    fn note_off(&mut self, offset: usize, key: u8) {
        self.vm.note_off(offset, key);
    }

    fn choke(&mut self, offset: usize) {
        self.vm.choke(offset);
    }

    fn all_off(&mut self) {
        self.vm.all_off();
    }

    fn process(&mut self, ctx: &ProcessContext, mut out: [&mut [f32]; 2]) {
        if self.pb.take_dirty() {
            self.update();
        }
        instrument_process!(self, ctx, out);
    }

    fn activity(&self) -> f32 {
        self.out.peak.min(1.0)
    }

    fn is_active(&self) -> bool {
        self.vm.is_active()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn algorithms_are_feed_forward_with_a_carrier() {
        for (mods, car) in ALGS.iter() {
            assert!(car.iter().any(|c| *c));
            for k in 0..4 {
                for src in 0..=k {
                    assert!(!mods[k][src], "op {k} modulated by {src} (not upstream)");
                }
            }
        }
    }

    #[test]
    fn table_sine_is_accurate() {
        let t: Vec<f32> = (0..=TABLE_SIZE).map(|i| (i as f64 / TABLE_SIZE as f64 * std::f64::consts::TAU).sin() as f32).collect();
        let mut err = 0.0f32;
        for k in 0..10_000u32 {
            let ph = k.wrapping_mul(429_497);
            let exact = (ph as f64 / 4_294_967_296.0 * std::f64::consts::TAU).sin() as f32;
            err = err.max((sine_at(&t, ph) - exact).abs());
        }
        assert!(err < 1e-6, "{err}");
    }
}
