use super::sampler::{reso_to_k, sanitize_sr, svf_typed};
use super::{NoteStart, OutStage, Voice, VoiceManager, CHOKE_MS};
use crate::blocks::env::{Ahdsr, EnvParams};
use crate::blocks::filters::{svf_g, Svf};
use crate::blocks::lfo::{sane_bpm, shape as lfo_shape};
use crate::blocks::osc::{blep_wave, Shape};
use crate::blocks::{db_to_gain, midi_to_hz, pan_gains, tc_coef, vel_gain, Glide, Rng, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Instrument, NoteExtras, PluginDescriptor, PluginKind, ProcessContext};

const SHAPES: [&str; 6] = ["Sine", "Triangle", "Saw", "Square", "Pulse 25%", "Noise"];

pub const LFO_SHAPES: [&str; 7] = ["Sine", "Triangle", "Saw up", "Saw down", "Square", "Sample & hold", "Smooth random"];
pub const LFO_DESTS: [&str; 6] = ["Pitch", "Filter cutoff", "Amp (tremolo)", "Pan", "Detune spread", "Osc 1/2 mix"];
pub const LFO_DIVISIONS: [&str; 19] = [
    "1/32T", "1/32", "1/32D", "1/16T", "1/16", "1/16D", "1/8T", "1/8", "1/8D", "1/4T", "1/4", "1/4D", "1/2T", "1/2", "1/2D", "1 bar",
    "2 bars", "4 bars", "8 bars",
];
pub const LFO_DIV_BEATS: [f64; 19] = [
    0.125 * 2.0 / 3.0,
    0.125,
    0.1875,
    0.25 * 2.0 / 3.0,
    0.25,
    0.375,
    0.5 * 2.0 / 3.0,
    0.5,
    0.75,
    2.0 / 3.0,
    1.0,
    1.5,
    4.0 / 3.0,
    2.0,
    3.0,
    4.0,
    8.0,
    16.0,
    32.0,
];

pub const PITCH_ST: f32 = 12.0;
pub const CUTOFF_OCT: f32 = 4.0;
pub const DETUNE_CT: f32 = 30.0;
const CTRL: u32 = 8;

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
    Lfo1Shape => choice("lfo1Shape", "Shape", &LFO_SHAPES, 0, "LFO 1"),
    Lfo1Dest => choice("lfo1Dest", "Destination", &LFO_DESTS, 0, "LFO 1"),
    Lfo1Amount => lin("lfo1Amount", "Amount", -1.0, 1.0, 0.0, "%", "LFO 1"),
    Lfo1Sync => toggle("lfo1Sync", "Tempo sync", false, "LFO 1"),
    Lfo1Rate => logp("lfo1Rate", "Rate (free)", 0.02, 40.0, 5.0, "Hz", "LFO 1"),
    Lfo1Division => choice("lfo1Division", "Rate (sync)", &LFO_DIVISIONS, 10, "LFO 1"),
    Lfo1Retrig => toggle("lfo1Retrig", "Retrigger", false, "LFO 1"),
    Lfo1Fade => lin("lfo1Fade", "Fade in", 0.0, 5000.0, 0.0, "ms", "LFO 1"),
    Lfo2Shape => choice("lfo2Shape", "Shape", &LFO_SHAPES, 0, "LFO 2"),
    Lfo2Dest => choice("lfo2Dest", "Destination", &LFO_DESTS, 1, "LFO 2"),
    Lfo2Amount => lin("lfo2Amount", "Amount", -1.0, 1.0, 0.0, "%", "LFO 2"),
    Lfo2Sync => toggle("lfo2Sync", "Tempo sync", false, "LFO 2"),
    Lfo2Rate => logp("lfo2Rate", "Rate (free)", 0.02, 40.0, 5.0, "Hz", "LFO 2"),
    Lfo2Division => choice("lfo2Division", "Rate (sync)", &LFO_DIVISIONS, 10, "LFO 2"),
    Lfo2Retrig => toggle("lfo2Retrig", "Retrigger", false, "LFO 2"),
    Lfo2Fade => lin("lfo2Fade", "Fade in", 0.0, 5000.0, 0.0, "ms", "LFO 2"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.triosc",
        name: "Krypt TriOsc",
        kind: PluginKind::Instrument,
        category: "Synth",
        description: "Three-oscillator subtractive synth (sine/triangle/saw/square/pulse/noise). Detune spread doubles each \
                      oscillator into a detuned stereo pair; drift adds analog wander. Filter envelope ±7 octaves (scaled by \
                      velocity); per-note Mod X/Y offset cutoff/resonance. Two LFOs (incl. sample & hold, smooth random; Hz or \
                      synced 1/32 to 8 bars; song-locked or retrigger; fade in), one destination each. Amount 100 % = pitch \
                      ±12 st, cutoff ±4 oct, full tremolo or pan, ±30 ct detune, osc 1/2 crossfade. The default melodic synth.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: None,
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct OscCfg {
    shape: Shape,
    ratio: [f64; 2],
    level: f32,
    gl: [f32; 2],
    gr: [f32; 2],
    phase: [f64; 2],
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct LfoCfg {
    shape: usize,
    dest: usize,
    amount: f32,
    retrig: bool,
    fade: f32,
    inc: f64,
    c0: f64,
    seed: u32,
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
    lfo: [LfoCfg; 2],
}

#[derive(Clone, Copy, Debug)]
struct Ramp {
    cur: f32,
    step: f32,
}

impl Ramp {
    const fn at(v: f32) -> Self {
        Self { cur: v, step: 0.0 }
    }
    #[inline]
    fn to(&mut self, target: f32, snap: bool) {
        if snap {
            self.cur = target;
            self.step = 0.0;
        } else {
            self.step = (target - self.cur) * (1.0 / CTRL as f32);
        }
    }
    #[inline]
    fn next(&mut self) -> f32 {
        self.cur += self.step;
        self.cur
    }
}

#[inline]
fn hash_bipolar(seed: u32, n: i64) -> f32 {
    let mut z = (n as u64).wrapping_add(((seed as u64) << 32) | seed as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    (z >> 40) as f32 * (2.0 / 16_777_216.0) - 1.0
}

#[inline]
pub(crate) fn lfo_value(shape: usize, c: f64, seed: u32) -> f32 {
    let n = c.floor();
    let ph = c - n;
    match shape {
        5 => hash_bipolar(seed, n as i64),
        6 => {
            let a = hash_bipolar(seed, n as i64);
            let b = hash_bipolar(seed, n as i64 + 1);
            let t = ph as f32;
            a + (b - a) * (t * t * (3.0 - 2.0 * t))
        }
        k => lfo_shape(k, ph),
    }
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
    span: usize,
    age: u32,
    lfo_c: [f64; 2],
    lfo_y: [f32; 2],
    amt_s: [Smooth; 2],
    id_seed: u32,
    starts: u32,
    lfo_seed: u32,
    lfo_count: u32,
    lfo_on: bool,
    lfo_snap: bool,
    slew: f32,
    note_pan: f32,
    pitch_mul: f64,
    det_mul: [f64; 2],
    cut_oct: f32,
    amp_r: Ramp,
    pan_r: [Ramp; 2],
    mix_r: [Ramp; 2],
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
            span: 0,
            age: 0,
            lfo_c: [0.0; 2],
            lfo_y: [0.0; 2],
            amt_s: [Smooth::with_time(0.0, 20.0, sr); 2],
            id_seed: seed,
            starts: 0,
            lfo_seed: 0,
            lfo_count: 0,
            lfo_on: false,
            lfo_snap: true,
            slew: tc_coef(1.0, sr / CTRL as f32),
            note_pan: 0.0,
            pitch_mul: 1.0,
            det_mul: [1.0; 2],
            cut_oct: 0.0,
            amp_r: Ramp::at(1.0),
            pan_r: [Ramp::at(1.0); 2],
            mix_r: [Ramp::at(1.0); 2],
        }
    }

    fn update_drift(&mut self, amount: f32) {
        for o in 0..3 {
            if self.rng.unit() < 0.0015 {
                self.drift_tgt[o] = self.rng.bipolar();
            }
            self.drift_cur[o] += (self.drift_tgt[o] - self.drift_cur[o]) * 0.003;
            let cents = amount * (6.0 * self.drift_cur[o] + self.drift_static[o]);
            self.drift_ratio[o] = ((cents as f64) / 1200.0).exp2();
        }
    }

    #[inline]
    fn lfo_live(&self, sh: &TriShared) -> bool {
        sh.lfo[0].amount != 0.0 || sh.lfo[1].amount != 0.0 || self.amt_s[0].cur != 0.0 || self.amt_s[1].cur != 0.0
    }

    fn lfo_control(&mut self, sh: &TriShared) {
        let snap = std::mem::replace(&mut self.lfo_snap, false);
        let (mut pitch, mut cut, mut amp, mut pan, mut det, mut mix) = (0.0f32, 0.0f32, 1.0f32, 0.0f32, 0.0f32, 0.0f32);
        for k in 0..2 {
            let cfg = &sh.lfo[k];
            self.amt_s[k].set(cfg.amount);
            let amt = self.amt_s[k].advance(CTRL as usize);
            let (c, seed) = if cfg.retrig {
                (self.lfo_c[k], self.lfo_seed ^ cfg.seed)
            } else {
                (cfg.c0 + self.span as f64 * cfg.inc, cfg.seed)
            };
            let raw = lfo_value(cfg.shape, c, seed);
            self.lfo_y[k] = if snap { raw } else { self.lfo_y[k] + (raw - self.lfo_y[k]) * self.slew };
            if amt == 0.0 {
                continue;
            }
            let fade = if cfg.fade >= 1.0 { (self.age as f32 / cfg.fade).min(1.0) } else { 1.0 };
            let a = amt * fade;
            let m = a * self.lfo_y[k];
            match cfg.dest {
                0 => pitch += m * PITCH_ST,
                1 => cut += m * CUTOFF_OCT,
                2 => amp *= 1.0 - 0.5 * (a.abs() - m),
                3 => pan += m,
                4 => det += m,
                _ => mix += m,
            }
        }
        self.pitch_mul = if pitch != 0.0 { (pitch as f64 / 12.0).exp2() } else { 1.0 };
        self.cut_oct = cut;
        self.det_mul = if det != 0.0 {
            let c = (det * DETUNE_CT) as f64 / 1200.0;
            [(-c).exp2(), c.exp2()]
        } else {
            [1.0; 2]
        };
        let (pl, pr) = if pan != 0.0 { pan_gains(self.note_pan + pan) } else { (self.pl, self.pr) };
        let mix = mix.clamp(-1.0, 1.0);
        self.amp_r.to(amp.clamp(0.0, 1.0), snap);
        self.pan_r[0].to(pl, snap);
        self.pan_r[1].to(pr, snap);
        self.mix_r[0].to(1.0 - mix.max(0.0), snap);
        self.mix_r[1].to(1.0 + mix.min(0.0), snap);
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
        self.note_pan = if n.extras.pan.is_finite() { n.extras.pan } else { 0.0 };
        self.age = 0;
        self.lfo_c = [0.0; 2];
        self.starts = self.starts.wrapping_add(1);
        self.lfo_seed = hash_bipolar(self.id_seed, self.starts as i64).to_bits();
        for k in 0..2 {
            self.amt_s[k].reset(sh.lfo[k].amount);
        }
        self.lfo_count = 0;
        self.lfo_on = false;
        self.lfo_snap = true;
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

    fn span_start(&mut self, frame: usize) {
        self.span = frame;
    }

    fn render(&mut self, sh: &TriShared, l: &mut [f32], r: &mut [f32]) {
        for o in 0..3 {
            self.lvl_s[o].set(sh.osc[o].level);
        }
        self.cut_s.set(sh.cutoff * ((self.mod_x - 0.5) * 4.0).exp2());
        self.res_s.set((sh.reso + (self.mod_y - 0.5) * 0.5).clamp(0.0, 1.0));
        let nyq = 0.45 * self.sr;
        let env_scale = sh.env_amt * 7.0 * (0.55 + 0.45 * self.vel_raw);
        let lfo = self.lfo_live(sh);
        if lfo && !self.lfo_on {
            self.lfo_snap = true;
            self.lfo_count = 0;
        }
        self.lfo_on = lfo;
        let lfo_inc = [sh.lfo[0].inc, sh.lfo[1].inc];
        for i in 0..l.len() {
            if lfo {
                if self.lfo_count == 0 {
                    self.lfo_control(sh);
                    self.lfo_count = CTRL;
                }
                self.lfo_count -= 1;
            }
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
                let mut lvl = self.lvl_s[o].next();
                if lfo && o < 2 {
                    lvl *= self.mix_r[o].next();
                }
                for u in 0..2 {
                    let mut dt = self.base_inc * cfg.ratio[u] * self.drift_ratio[o];
                    if lfo {
                        dt *= self.pitch_mul * self.det_mul[u];
                    }
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
            let fe = self.fenv.next(&sh.fenv);
            if self.coef_count == 0 {
                let base = self.cut_s.advance(8);
                let rs = self.res_s.advance(8);
                let p = self.glide.cur;
                let mut oct = env_scale * fe + sh.kt * (p - 60.0) / 12.0;
                if lfo {
                    oct += self.cut_oct;
                }
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
            let (pl, pr) = if lfo {
                g *= self.amp_r.next();
                (self.pan_r[0].next(), self.pan_r[1].next())
            } else {
                (self.pl, self.pr)
            };
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
            l[i] += fl * g * pl;
            r[i] += fr * g * pr;
            self.lfo_c[0] += lfo_inc[0];
            self.lfo_c[1] += lfo_inc[1];
            self.span += 1;
            self.age = self.age.saturating_add(1);
            if done {
                self.kill();
                return;
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct LfoRate {
    sync: bool,
    hz: f32,
    div: f64,
    bars: bool,
}

#[derive(Clone, Copy, Debug, Default)]
struct LfoClock {
    cycles: f64,
    expect_beat: f64,
    was_playing: bool,
}

pub struct TriOsc {
    pb: ParamBank<N_PARAMS>,
    shared: TriShared,
    vm: VoiceManager<TriVoice>,
    out: OutStage,
    sr: f32,
    lfo_rate: [LfoRate; 2],
    clocks: [LfoClock; 2],
}

impl TriOsc {
    pub fn new(sample_rate: f32, max_frames: usize) -> Self {
        let sr = sanitize_sr(sample_rate);
        let osc = OscCfg { shape: Shape::Saw, ratio: [1.0; 2], level: 0.0, gl: [0.5; 2], gr: [0.5; 2], phase: [0.0; 2] };
        let mut seed = 0x1234u32;
        let lfo = |k: u32| LfoCfg { seed: 0x5EED_0001u32.wrapping_mul(k + 1), ..LfoCfg::default() };
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
                lfo: [lfo(0), lfo(1)],
            },
            vm: VoiceManager::new(32, || {
                seed = seed.wrapping_add(7919);
                TriVoice::new(sr, seed)
            }),
            out: OutStage::new(max_frames, sr),
            sr,
            lfo_rate: [LfoRate { sync: false, hz: 5.0, div: 1.0, bars: false }; 2],
            clocks: [LfoClock::default(); 2],
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
        let lfo_base = [P::Lfo1Shape as usize, P::Lfo2Shape as usize];
        for (k, &b) in lfo_base.iter().enumerate() {
            let cfg = &mut self.shared.lfo[k];
            cfg.shape = p.idx(b).min(LFO_SHAPES.len() - 1);
            cfg.dest = p.idx(b + 1).min(LFO_DESTS.len() - 1);
            cfg.amount = p.get(b + 2);
            cfg.retrig = p.on(b + 6);
            cfg.fade = p.get(b + 7) * 0.001 * self.sr;
            let di = p.idx(b + 5).min(LFO_DIV_BEATS.len() - 1);
            self.lfo_rate[k] = LfoRate { sync: p.on(b + 3), hz: p.get(b + 4), div: LFO_DIV_BEATS[di], bars: di >= 15 };
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

    fn clock_lfos(&mut self, ctx: &ProcessContext, frames: usize) {
        let sr = self.sr as f64;
        let bpm = sane_bpm(ctx.bpm);
        let beats_per_sample = bpm / 60.0 / sr;
        let playing = ctx.playing && ctx.beat_pos.is_finite();
        for k in 0..2 {
            let mut rt = self.lfo_rate[k];
            if rt.bars && ctx.beats_per_bar.is_finite() && ctx.beats_per_bar > 0.0 {
                rt.div = rt.div / 4.0 * ctx.beats_per_bar;
            }
            let clk = &mut self.clocks[k];
            let cfg = &mut self.shared.lfo[k];
            cfg.inc = if rt.sync { beats_per_sample / rt.div } else { rt.hz as f64 / sr };
            let mut c = clk.cycles;
            if playing {
                if rt.sync {
                    c = ctx.beat_pos / rt.div;
                } else if !clk.was_playing || (ctx.beat_pos - clk.expect_beat).abs() > 1e-3 {
                    c = ctx.beat_pos * 60.0 / bpm * rt.hz as f64;
                }
                clk.expect_beat = ctx.beat_pos + frames as f64 * beats_per_sample;
            }
            clk.was_playing = playing;
            cfg.c0 = if c.is_finite() { c } else { 0.0 };
        }
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
        self.sr = sr;
        self.clocks = [LfoClock::default(); 2];
        self.update();
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
        let frames = ctx.frames.min(out[0].len()).min(out[1].len());
        self.clock_lfos(ctx, frames);
        if self.out.fresh {
            self.out.fresh = false;
            self.out.gain.reset(self.out.gain.target);
        }
        let mut at = 0usize;
        let mut peak = 0.0f32;
        while at < frames {
            let n = (frames - at).min(self.out.chunk());
            self.out.mix_l[..n].iter_mut().for_each(|v| *v = 0.0);
            self.out.mix_r[..n].iter_mut().for_each(|v| *v = 0.0);
            {
                let (ml, mr) = (self.out.mix_l.as_mut_slice(), self.out.mix_r.as_mut_slice());
                self.vm.render(&self.shared, &mut ml[..n], &mut mr[..n]);
            }
            peak = peak.max(self.out.emit(&mut out, at, n));
            at += n;
            for lfo in self.shared.lfo.iter_mut() {
                lfo.c0 += n as f64 * lfo.inc;
            }
        }
        self.out.peak = peak;
        for k in 0..2 {
            self.clocks[k].cycles = self.shared.lfo[k].c0;
        }
    }

    fn activity(&self) -> f32 {
        self.out.peak.min(1.0)
    }

    fn is_active(&self) -> bool {
        self.vm.is_active()
    }
}

#[cfg(test)]
#[path = "triosc_tests.rs"]
mod tests;
