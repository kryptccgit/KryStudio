//! FROZEN COPY of krypt.triosc as it shipped before Wave 12.2b (test only).
//! `triosc::tests` renders it next to TriOsc with the new LFO params at their
//! defaults to prove existing patches sound bit-identical. Never edit this file.
#![allow(dead_code)]

//! krypt.triosc — three band-limited oscillators (PolyBLEP/PolyBLAMP), each
//! doubled into a detuned stereo pair by "Detune spread", analog drift,
//! AHDSR amp envelope and a TPT SVF with its own ADSR + key tracking.

use super::sampler::{reso_to_k, sanitize_sr, svf_typed};
use super::{instrument_process, NoteStart, OutStage, Voice, VoiceManager, CHOKE_MS};
use crate::blocks::env::{Ahdsr, EnvParams};
use crate::blocks::filters::{svf_g, Svf};
use crate::blocks::osc::{blep_wave, Shape};
use crate::blocks::{db_to_gain, midi_to_hz, pan_gains, vel_gain, Glide, Rng, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Instrument, NoteExtras, PluginDescriptor, PluginKind, ProcessContext};

const SHAPES: [&str; 6] = ["Sine", "Triangle", "Saw", "Square", "Pulse 25%", "Noise"];

param_table! {
    Osc1Shape => choice("osc1Shape", "Shape", &SHAPES, 2, "Osc 1"),
    Osc1Coarse => stepped("osc1Coarse", "Coarse", -48.0, 48.0, 0.0, "st", 1.0, "Osc 1"),
    Osc1Fine => lin("osc1Fine", "Fine", -100.0, 100.0, 0.0, "ct", "Osc 1"),
    Osc1Level => lin("osc1Level", "Level", 0.0, 1.0, 0.8, "%", "Osc 1"),
    Osc1Pan => lin("osc1Pan", "Pan", -1.0, 1.0, 0.0, "", "Osc 1"),
    Osc1Phase => lin("osc1Phase", "Phase", 0.0, 1.0, 0.0, "%", "Osc 1"),
    Osc2Shape => choice("osc2Shape", "Shape", &SHAPES, 2, "Osc 2"),
    Osc2Coarse => stepped("osc2Coarse", "Coarse", -48.0, 48.0, 0.0, "st", 1.0, "Osc 2"),
    Osc2Fine => lin("osc2Fine", "Fine", -100.0, 100.0, 7.0, "ct", "Osc 2"),
    Osc2Level => lin("osc2Level", "Level", 0.0, 1.0, 0.6, "%", "Osc 2"),
    Osc2Pan => lin("osc2Pan", "Pan", -1.0, 1.0, 0.0, "", "Osc 2"),
    Osc2Phase => lin("osc2Phase", "Phase", 0.0, 1.0, 0.0, "%", "Osc 2"),
    Osc3Shape => choice("osc3Shape", "Shape", &SHAPES, 3, "Osc 3"),
    Osc3Coarse => stepped("osc3Coarse", "Coarse", -48.0, 48.0, -12.0, "st", 1.0, "Osc 3"),
    Osc3Fine => lin("osc3Fine", "Fine", -100.0, 100.0, 0.0, "ct", "Osc 3"),
    Osc3Level => lin("osc3Level", "Level", 0.0, 1.0, 0.4, "%", "Osc 3"),
    Osc3Pan => lin("osc3Pan", "Pan", -1.0, 1.0, 0.0, "", "Osc 3"),
    Osc3Phase => lin("osc3Phase", "Phase", 0.0, 1.0, 0.0, "%", "Osc 3"),
    UnisonDetune => lin("unisonDetune", "Detune spread", 0.0, 1.0, 0.1, "%", "Voice"),
    Drift => lin("drift", "Analog drift", 0.0, 1.0, 0.1, "%", "Voice"),
    Gain => lin("gain", "Gain", -24.0, 12.0, -6.0, "dB", "Voice"),
    AmpAttack => logp("ampAttack", "Attack", 0.1, 5000.0, 2.0, "ms", "Amp envelope"),
    AmpHold => logp("ampHold", "Hold", 0.1, 5000.0, 0.1, "ms", "Amp envelope"),
    AmpDecay => logp("ampDecay", "Decay", 1.0, 10000.0, 400.0, "ms", "Amp envelope"),
    AmpSustain => lin("ampSustain", "Sustain", 0.0, 1.0, 0.7, "%", "Amp envelope"),
    AmpRelease => logp("ampRelease", "Release", 1.0, 10000.0, 200.0, "ms", "Amp envelope"),
    FilterType => choice("filterType", "Type", &["Low pass", "High pass", "Band pass", "Notch"], 0, "Filter"),
    Cutoff => logp("cutoff", "Cutoff", 20.0, 20000.0, 8000.0, "Hz", "Filter"),
    Reso => lin("reso", "Resonance", 0.0, 1.0, 0.15, "%", "Filter"),
    FilterEnvAmount => lin("filterEnvAmount", "Amount", -1.0, 1.0, 0.3, "%", "Filter envelope"),
    FilterEnvAttack => logp("filterEnvAttack", "Attack", 0.1, 5000.0, 1.0, "ms", "Filter envelope"),
    FilterEnvDecay => logp("filterEnvDecay", "Decay", 1.0, 10000.0, 350.0, "ms", "Filter envelope"),
    FilterEnvSustain => lin("filterEnvSustain", "Sustain", 0.0, 1.0, 0.2, "%", "Filter envelope"),
    FilterEnvRelease => logp("filterEnvRelease", "Release", 1.0, 10000.0, 250.0, "ms", "Filter envelope"),
    FilterKeyTrack => lin("filterKeyTrack", "Key tracking", 0.0, 1.0, 0.5, "%", "Filter envelope"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.triosc",
        name: "Krypt TriOsc",
        kind: PluginKind::Instrument,
        category: "Synth",
        description: "Three-oscillator subtractive synth (alias-suppressed sine/triangle/saw/square/pulse/noise). Detune spread \
                      doubles each oscillator into a detuned stereo pair; drift adds analog pitch wander. Filter envelope \
                      amount is ±7 octaves (scaled by velocity); per-note Mod X/Y offset cutoff/resonance. Fast, light, the \
                      default for new melodic channels.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: None,
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct OscCfg {
    shape: Shape,
    /// frequency ratios of the two unison copies
    ratio: [f64; 2],
    level: f32,
    /// (l, r) gains for the two copies (pan + unison gain folded in)
    gl: [f32; 2],
    gr: [f32; 2],
    phase: [f64; 2],
}

pub(crate) struct TriShared {
    osc: [OscCfg; 3],
    drift: f32,
    amp: EnvParams,
    fenv: EnvParams,
    ftype: usize,
    cutoff: f32,
    reso: f32,
    env_amt: f32,
    kt: f32,
}

pub(crate) struct TriVoice {
    fadein: f32,
    fadein_step: f32,
    active: bool,
    choking: bool,
    fade: f32,
    fade_step: f32,
    glide: Glide,
    vel: f32,
    vel_raw: f32,
    pl: f32,
    pr: f32,
    mod_x: f32,
    mod_y: f32,
    phase: [[f64; 2]; 3],
    drift_cur: [f32; 3],
    drift_tgt: [f32; 3],
    drift_static: [f32; 3],
    drift_ratio: [f64; 3],
    drift_count: u32,
    rng: Rng,
    amp: Ahdsr,
    fenv: Ahdsr,
    filt: [Svf; 2],
    cut_s: Smooth,
    res_s: Smooth,
    lvl_s: [Smooth; 3],
    coef_count: u32,
    base_inc: f64,
    sr: f32,
}

impl TriVoice {
    fn new(sr: f32, seed: u32) -> Self {
        let mut amp = Ahdsr::default();
        amp.set_sr(sr);
        let mut fenv = Ahdsr::default();
        fenv.set_sr(sr);
        Self {
            fadein: 1.0,
            fadein_step: 1.0 / (CHOKE_MS * 0.001 * sr),
            active: false,
            choking: false,
            fade: 1.0,
            fade_step: 1.0 / (CHOKE_MS * 0.001 * sr),
            glide: Glide::default(),
            vel: 0.0,
            vel_raw: 0.0,
            pl: 1.0,
            pr: 1.0,
            mod_x: 0.5,
            mod_y: 0.5,
            phase: [[0.0; 2]; 3],
            drift_cur: [0.0; 3],
            drift_tgt: [0.0; 3],
            drift_static: [0.0; 3],
            drift_ratio: [1.0; 3],
            drift_count: 0,
            rng: Rng::new(seed),
            amp,
            fenv,
            filt: [Svf::default(); 2],
            cut_s: Smooth::with_time(8000.0, 8.0, sr),
            res_s: Smooth::with_time(0.0, 8.0, sr),
            lvl_s: [Smooth::with_time(0.0, 8.0, sr); 3],
            coef_count: 0,
            base_inc: 0.0,
            sr,
        }
    }

    fn update_drift(&mut self, amount: f32) {
        for o in 0..3 {
            // called every 32 samples: new target every ~0.5 s, ~0.3 s glide
            if self.rng.unit() < 0.0015 {
                self.drift_tgt[o] = self.rng.bipolar();
            }
            self.drift_cur[o] += (self.drift_tgt[o] - self.drift_cur[o]) * 0.003;
            let cents = amount * (6.0 * self.drift_cur[o] + self.drift_static[o]);
            self.drift_ratio[o] = ((cents as f64) / 1200.0).exp2();
        }
    }
}

impl Voice for TriVoice {
    type Shared = TriShared;

    fn start(&mut self, sh: &TriShared, n: &NoteStart, _g: Option<f32>, _gm: f32) {
        self.fadein = if n.xfade { 0.0 } else { 1.0 };
        self.glide.jump(n.pitch);
        self.vel = vel_gain(n.vel);
        self.vel_raw = n.vel;
        (self.pl, self.pr) = pan_gains(n.extras.pan);
        self.mod_x = n.extras.mod_x;
        self.mod_y = n.extras.mod_y;
        for o in 0..3 {
            self.phase[o] = sh.osc[o].phase;
            self.drift_static[o] = self.rng.bipolar() * 4.0;
            self.drift_cur[o] = self.rng.bipolar() * 0.5;
            self.drift_tgt[o] = self.rng.bipolar();
            self.lvl_s[o].reset(sh.osc[o].level);
        }
        self.update_drift(sh.drift);
        self.amp.kill();
        self.amp.trigger(&sh.amp);
        self.fenv.kill();
        self.fenv.trigger(&sh.fenv);
        self.filt = [Svf::default(); 2];
        self.cut_s.reset(sh.cutoff);
        self.res_s.reset(sh.reso);
        self.coef_count = 0;
        self.base_inc = midi_to_hz(n.pitch) as f64 / self.sr as f64;
        self.fade = 1.0;
        self.choking = false;
        self.active = true;
    }

    fn legato(&mut self, _sh: &TriShared, pitch: f32, glide_ms: f32) {
        self.glide.to(pitch, glide_ms, self.sr);
    }

    fn release(&mut self, sh: &TriShared) {
        self.amp.release(&sh.amp);
        self.fenv.release(&sh.fenv);
    }

    fn choke(&mut self) {
        self.choking = true;
    }

    fn kill(&mut self) {
        self.active = false;
        self.choking = false;
        self.amp.kill();
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

    fn render(&mut self, sh: &TriShared, l: &mut [f32], r: &mut [f32]) {
        for o in 0..3 {
            self.lvl_s[o].set(sh.osc[o].level);
        }
        self.cut_s.set(sh.cutoff * ((self.mod_x - 0.5) * 4.0).exp2());
        self.res_s.set((sh.reso + (self.mod_y - 0.5) * 0.5).clamp(0.0, 1.0));
        let nyq = 0.45 * self.sr;
        let env_scale = sh.env_amt * 7.0 * (0.55 + 0.45 * self.vel_raw);
        for i in 0..l.len() {
            if self.glide.gliding() {
                self.base_inc = midi_to_hz(self.glide.next()) as f64 / self.sr as f64;
            }
            if self.drift_count == 0 {
                self.update_drift(sh.drift);
                self.drift_count = 32;
            }
            self.drift_count -= 1;
            let (mut sl, mut sr) = (0.0f32, 0.0f32);
            for o in 0..3 {
                let cfg = &sh.osc[o];
                let lvl = self.lvl_s[o].next();
                for u in 0..2 {
                    let dt = self.base_inc * cfg.ratio[u] * self.drift_ratio[o];
                    let ph = self.phase[o][u];
                    let v = if lvl > 0.0 {
                        if cfg.shape == Shape::Noise {
                            self.rng.bipolar()
                        } else {
                            blep_wave(cfg.shape, ph, dt.min(0.5)) as f32
                        }
                    } else {
                        0.0
                    };
                    let mut np = ph + dt;
                    if np >= 1.0 {
                        np -= np.floor();
                    }
                    self.phase[o][u] = np;
                    let v = v * lvl;
                    sl += v * cfg.gl[u];
                    sr += v * cfg.gr[u];
                }
            }
            // filter
            let fe = self.fenv.next(&sh.fenv);
            if self.coef_count == 0 {
                let base = self.cut_s.advance(8);
                let rs = self.res_s.advance(8);
                let p = self.glide.cur;
                let oct = env_scale * fe + sh.kt * (p - 60.0) / 12.0;
                let c = (base * oct.clamp(-12.0, 12.0).exp2()).clamp(20.0, nyq);
                let g = svf_g(c as f64, self.sr as f64);
                let k = reso_to_k(rs);
                self.filt[0].set_gk(g, k);
                self.filt[1].set_gk(g, k);
                self.coef_count = 8;
            }
            self.coef_count -= 1;
            let fl = svf_typed(&mut self.filt[0], sh.ftype, sl as f64) as f32;
            let fr = svf_typed(&mut self.filt[1], sh.ftype, sr as f64) as f32;
            let a = self.amp.next(&sh.amp);
            let mut g = a * self.vel * 0.5;
            if self.fadein < 1.0 {
                self.fadein = (self.fadein + self.fadein_step).min(1.0);
                g *= self.fadein;
            }
            let mut done = self.amp.idle();
            if self.choking {
                self.fade -= self.fade_step;
                if self.fade <= 0.0 {
                    self.fade = 0.0;
                    done = true;
                }
                g *= self.fade;
            }
            l[i] += fl * g * self.pl;
            r[i] += fr * g * self.pr;
            if done {
                self.kill();
                return;
            }
        }
    }
}

pub struct TriOsc {
    pb: ParamBank<N_PARAMS>,
    shared: TriShared,
    vm: VoiceManager<TriVoice>,
    out: OutStage,
}

impl TriOsc {
    pub fn new(sample_rate: f32, max_frames: usize) -> Self {
        let sr = sanitize_sr(sample_rate);
        let osc = OscCfg { shape: Shape::Saw, ratio: [1.0; 2], level: 0.0, gl: [0.5; 2], gr: [0.5; 2], phase: [0.0; 2] };
        let mut seed = 0x1234u32;
        let mut s = Self {
            pb: ParamBank::new(&param_specs()),
            shared: TriShared {
                osc: [osc; 3],
                drift: 0.0,
                amp: EnvParams::default(),
                fenv: EnvParams::default(),
                ftype: 0,
                cutoff: 8000.0,
                reso: 0.0,
                env_amt: 0.0,
                kt: 0.0,
            },
            vm: VoiceManager::new(32, || {
                seed = seed.wrapping_add(7919);
                TriVoice::new(sr, seed)
            }),
            out: OutStage::new(max_frames, sr),
        };
        s.update();
        s.out.gain.reset(s.out.gain.target);
        s
    }

    fn update(&mut self) {
        let p = &self.pb;
        let spread = p.get(P::UnisonDetune as usize);
        let cents = spread as f64 * 30.0;
        let coh = (spread * 5.0).min(1.0);
        let ugain = 0.5 + 0.207 * coh;
        let pan_off = spread * 0.8;
        let base = [P::Osc1Shape as usize, P::Osc2Shape as usize, P::Osc3Shape as usize];
        for (o, &b) in base.iter().enumerate() {
            // per-osc block: shape, coarse, fine, level, pan, phase
            let shape = Shape::from_index(p.idx(b));
            let semis = p.get(b + 1) as f64 + p.get(b + 2) as f64 / 100.0;
            let level = p.get(b + 3);
            let pan = p.get(b + 4);
            let phase = p.get(b + 5) as f64;
            let r0 = (semis / 12.0).exp2();
            let cfg = &mut self.shared.osc[o];
            cfg.shape = shape;
            cfg.ratio = [r0 * (-cents / 1200.0).exp2(), r0 * (cents / 1200.0).exp2()];
            cfg.level = level;
            let (al, ar) = pan_gains((pan - pan_off).clamp(-1.0, 1.0));
            let (bl, br) = pan_gains((pan + pan_off).clamp(-1.0, 1.0));
            cfg.gl = [al * ugain, bl * ugain];
            cfg.gr = [ar * ugain, br * ugain];
            cfg.phase = [phase, (phase + 0.37 * (spread as f64 * 10.0).min(1.0)).fract()];
        }
        let sh = &mut self.shared;
        sh.drift = p.get(P::Drift as usize);
        sh.amp = EnvParams {
            attack_ms: p.get(P::AmpAttack as usize),
            hold_ms: p.get(P::AmpHold as usize),
            decay_ms: p.get(P::AmpDecay as usize),
            sustain: p.get(P::AmpSustain as usize),
            release_ms: p.get(P::AmpRelease as usize),
        };
        sh.fenv = EnvParams {
            attack_ms: p.get(P::FilterEnvAttack as usize),
            hold_ms: 0.0,
            decay_ms: p.get(P::FilterEnvDecay as usize),
            sustain: p.get(P::FilterEnvSustain as usize),
            release_ms: p.get(P::FilterEnvRelease as usize),
        };
        sh.ftype = p.idx(P::FilterType as usize).min(3);
        sh.cutoff = p.get(P::Cutoff as usize);
        sh.reso = p.get(P::Reso as usize);
        sh.env_amt = p.get(P::FilterEnvAmount as usize);
        sh.kt = p.get(P::FilterKeyTrack as usize);
        self.out.gain.set(db_to_gain(p.get(P::Gain as usize)));
    }
}

impl Instrument for TriOsc {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let sr = sanitize_sr(sample_rate);
        self.vm.all_off();
        let mut seed = 0x1234u32;
        for v in self.vm.voices.iter_mut() {
            seed = seed.wrapping_add(7919);
            *v = TriVoice::new(sr, seed);
        }
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
