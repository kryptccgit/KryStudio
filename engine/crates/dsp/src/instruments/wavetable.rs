//! krypt.wavetable — "Krypt Wave": wavetable synth with procedurally
//! generated factory tables.
//!
//! Tables (5 × 31 frames × 2048 samples) are generated here from our own
//! harmonic recipes, never from third-party content. Each frame is turned
//! into 11 octave-spaced mip levels by inverse FFT (rustfft) with the
//! harmonics above the level's limit removed, so every level is exactly
//! band-limited. A voice picks the level whose top harmonic stays under
//! 0.6 × the sample rate for its pitch: anything above Nyquist folds back
//! only into the top 20% of the band (above ~19 kHz at 48 kHz). Frames are
//! normalized to equal RMS (peaks capped at 1.5), so morphing and switching
//! tables keep a steady loudness. The bank is built once per process
//! (~14 MB) and shared by every instance.
//!
//! Per voice: up to 8 unison copies (symmetric detune, stereo spread),
//! position morphing between adjacent frames, a PolyBLEP/BLAMP sub
//! oscillator, a TPT SVF with key tracking, an amp AHDSR (env 1), a mod
//! ADSR (env 2 → position / cutoff) and an LFO (→ position / cutoff /
//! pitch; free or tempo-rate, restarted per note).

use std::sync::{Arc, OnceLock};

use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;

use super::sampler::{reso_to_k, sanitize_sr, svf_typed};
use super::{instrument_process, NoteStart, OutStage, Voice, VoiceManager, CHOKE_MS};
use crate::blocks::env::{Ahdsr, EnvParams};
use crate::blocks::filters::{svf_g, Svf};
use crate::blocks::lfo::{sane_bpm, shape, LFO_SHAPES};
use crate::blocks::osc::{blep_wave, Shape};
use crate::blocks::{db_to_gain, midi_to_hz, pan_gains, vel_gain, Glide, Rng, Smooth};
use crate::params::{param_table, ParamBank, SYNC_BEATS};
use crate::{Instrument, NoteExtras, PluginDescriptor, PluginKind, ProcessContext};

pub const TABLES: [&str; 5] = ["Basic morph", "PWM", "Formant", "Harmonic sweep", "Digital"];

param_table! {
    Table => choice("table", "Wavetable", &TABLES, 0, "Oscillator"),
    Position => lin("position", "Position", 0.0, 1.0, 0.67, "%", "Oscillator"),
    Coarse => stepped("coarse", "Coarse", -24.0, 24.0, 0.0, "st", 1.0, "Oscillator"),
    Fine => lin("fine", "Fine", -100.0, 100.0, 0.0, "ct", "Oscillator"),
    Level => lin("level", "Level", 0.0, 1.0, 0.8, "%", "Oscillator"),
    Unison => stepped("unison", "Voices", 1.0, 8.0, 3.0, "", 1.0, "Unison"),
    Detune => lin("detune", "Detune", 0.0, 1.0, 0.25, "%", "Unison"),
    Spread => lin("spread", "Stereo spread", 0.0, 1.0, 0.7, "%", "Unison"),
    SubLevel => lin("subLevel", "Level", 0.0, 1.0, 0.0, "%", "Sub"),
    SubShape => choice("subShape", "Shape", &["Sine", "Triangle", "Square"], 0, "Sub"),
    SubOctave => choice("subOctave", "Octave", &["-1", "-2"], 0, "Sub"),
    FilterType => choice("filterType", "Type", &["Low pass", "High pass", "Band pass", "Notch"], 0, "Filter"),
    Cutoff => logp("cutoff", "Cutoff", 20.0, 20000.0, 9000.0, "Hz", "Filter"),
    Reso => lin("reso", "Resonance", 0.0, 1.0, 0.15, "%", "Filter"),
    FilterKeyTrack => lin("filterKeyTrack", "Key tracking", 0.0, 1.0, 0.3, "%", "Filter"),
    AmpAttack => logp("ampAttack", "Attack", 0.1, 10000.0, 3.0, "ms", "Env 1 (amp)"),
    AmpHold => logp("ampHold", "Hold", 0.1, 5000.0, 0.1, "ms", "Env 1 (amp)"),
    AmpDecay => logp("ampDecay", "Decay", 1.0, 20000.0, 600.0, "ms", "Env 1 (amp)"),
    AmpSustain => lin("ampSustain", "Sustain", 0.0, 1.0, 0.8, "%", "Env 1 (amp)"),
    AmpRelease => logp("ampRelease", "Release", 1.0, 20000.0, 300.0, "ms", "Env 1 (amp)"),
    ModAttack => logp("modAttack", "Attack", 0.1, 10000.0, 5.0, "ms", "Env 2 (mod)"),
    ModDecay => logp("modDecay", "Decay", 1.0, 20000.0, 800.0, "ms", "Env 2 (mod)"),
    ModSustain => lin("modSustain", "Sustain", 0.0, 1.0, 0.0, "%", "Env 2 (mod)"),
    ModRelease => logp("modRelease", "Release", 1.0, 20000.0, 400.0, "ms", "Env 2 (mod)"),
    ModToPosition => lin("modToPosition", "Position amount", -1.0, 1.0, 0.0, "%", "Env 2 (mod)"),
    ModToCutoff => lin("modToCutoff", "Cutoff amount", -1.0, 1.0, 0.25, "%", "Env 2 (mod)"),
    LfoShape => choice("lfoShape", "Shape", &LFO_SHAPES, 1, "LFO"),
    LfoSync => toggle("lfoSync", "Tempo sync", false, "LFO"),
    LfoDivision => choice("lfoDivision", "Rate (sync)", &SYNC_DIVISIONS, 9, "LFO"),
    LfoRate => logp("lfoRate", "Rate (free)", 0.01, 30.0, 0.5, "Hz", "LFO"),
    LfoToPosition => lin("lfoToPosition", "Position amount", -1.0, 1.0, 0.0, "%", "LFO"),
    LfoToCutoff => lin("lfoToCutoff", "Cutoff amount", -1.0, 1.0, 0.0, "%", "LFO"),
    LfoToPitch => lin("lfoToPitch", "Vibrato", 0.0, 100.0, 0.0, "ct", "LFO"),
    Gain => lin("gain", "Gain", -24.0, 12.0, -6.0, "dB", "Voice"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.wavetable",
        name: "Krypt Wave",
        kind: PluginKind::Instrument,
        category: "Synth",
        description: "Wavetable synth with five generated tables (basic shapes morph, PWM, vowel formants, harmonic \
                      sweep, digital sync/bitcrush), band-limited per octave. Position morphs through each table (env 2 \
                      and the LFO can move it); up to 8 unison voices with detune and stereo spread; sub oscillator; \
                      filter with env 2/LFO/key tracking. Env 2 cutoff amount is ±6 octaves, LFO ±3.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: None,
    }
}

// ── Factory bank ──────────────────────────────────────────────────────────

const N: usize = 2048;
const HALF: usize = N / 2;
const MIPS: usize = 11;
/// 31 frames: the basic morph's triangle, saw and square land exactly on
/// frames 10, 20 and 30.
const FRAMES: usize = 31;
/// Stored length per mip: N plus one guard sample (= sample 0) for interpolation.
const STRIDE: usize = N + 1;
const MAX_UNISON: usize = 8;
const TARGET_RMS: f32 = 0.5;
const PEAK_CAP: f32 = 1.5;

pub struct WaveBank {
    data: Vec<f32>,
}

impl WaveBank {
    #[inline]
    fn level(&self, table: usize, frame: usize, mip: usize) -> &[f32] {
        let o = ((table * FRAMES + frame) * MIPS + mip) * STRIDE;
        &self.data[o..o + STRIDE]
    }
}

/// The shared factory bank (built on first use; never on the audio thread:
/// every instance fetches it in `new`).
pub fn bank() -> Arc<WaveBank> {
    static BANK: OnceLock<Arc<WaveBank>> = OnceLock::new();
    BANK.get_or_init(|| Arc::new(build_bank())).clone()
}

/// Harmonic coefficients for x(t) = Σ a_h cos(2πht) + b_h sin(2πht), stored
/// as (a_h − i·b_h)/2 so an inverse DFT rebuilds the waveform directly.
fn coef(a: f32, b: f32) -> Complex32 {
    Complex32::new(0.5 * a, -0.5 * b)
}

fn frame_spectrum(table: usize, x: f32, fwd: &dyn rustfft::Fft<f32>, scratch: &mut [Complex32], out: &mut [Complex32]) {
    use std::f32::consts::PI;
    out.iter_mut().for_each(|c| *c = Complex32::default());
    match table {
        0 => {
            // sine → triangle → saw → square (all with a positive fundamental)
            let key = |k: usize, h: usize| -> f32 {
                let hf = h as f32;
                match k {
                    0 => (h == 1) as u8 as f32,
                    1 => {
                        if h % 2 == 1 {
                            let s = if (h / 2).is_multiple_of(2) { 1.0 } else { -1.0 };
                            s * 8.0 / (PI * PI * hf * hf)
                        } else {
                            0.0
                        }
                    }
                    2 => 2.0 / (PI * hf),
                    _ => {
                        if h % 2 == 1 {
                            4.0 / (PI * hf)
                        } else {
                            0.0
                        }
                    }
                }
            };
            let seg = (x * 3.0).min(2.999);
            let k = seg as usize;
            let t = seg - k as f32;
            for h in 1..HALF {
                let b = key(k, h) * (1.0 - t) + key(k + 1, h) * t;
                out[h] = coef(0.0, b);
            }
        }
        1 => {
            // pulse width 50% → 6%
            let d = 0.5 - 0.44 * x;
            for h in 1..HALF {
                let hf = h as f32;
                let w = 2.0 * PI * hf * d;
                out[h] = coef(2.0 * w.sin() / (PI * hf), 2.0 * (1.0 - w.cos()) / (PI * hf));
            }
        }
        2 => {
            // two moving formants over a bright source, vowels a → e → i → o → u
            const F1: [f32; 5] = [730.0, 530.0, 280.0, 570.0, 320.0];
            const F2: [f32; 5] = [1090.0, 1840.0, 2250.0, 840.0, 900.0];
            let seg = (x * 4.0).min(3.999);
            let k = seg as usize;
            let t = seg - k as f32;
            let f1 = F1[k] * (1.0 - t) + F1[k + 1] * t;
            let f2 = F2[k] * (1.0 - t) + F2[k + 1] * t;
            let f_ref = 110.0;
            for h in 1..HALF {
                let f = h as f32 * f_ref;
                let r1 = 1.0 / (1.0 + ((f - f1) / 90.0).powi(2));
                let r2 = 0.7 / (1.0 + ((f - f2) / 130.0).powi(2));
                let amp = (r1 + r2 + 0.02) / (h as f32).sqrt();
                out[h] = coef(0.0, amp);
            }
        }
        3 => {
            // harmonics fade in one after another (1 → 64)
            let kf = 1.0 + 63.0 * x;
            for h in 1..HALF {
                let w = (kf - h as f32 + 1.0).clamp(0.0, 1.0);
                if w > 0.0 {
                    out[h] = coef(0.0, w / h as f32);
                }
            }
        }
        _ => {
            // hard-sync ramp (ratio 1 → 8), bit-reduced in the second half
            let ratio = 1.0 + 7.0 * x;
            let levels = if x > 0.5 { (6.0 - 8.0 * (x - 0.5)).exp2().max(2.0) } else { 0.0 };
            for (n, c) in scratch.iter_mut().enumerate() {
                let t = n as f32 / N as f32;
                let mut v = 1.0 - 2.0 * (ratio * t).fract();
                if levels > 0.0 {
                    let q = levels * 0.5;
                    v = (v * q).round() / q;
                }
                *c = Complex32::new(v, 0.0);
            }
            fwd.process(scratch);
            for h in 1..HALF {
                out[h] = scratch[h] / N as f32;
            }
        }
    }
}

fn build_bank() -> WaveBank {
    let mut planner = FftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(N);
    let inv = planner.plan_fft_inverse(N);
    let mut data = vec![0.0f32; TABLES.len() * FRAMES * MIPS * STRIDE];
    let mut spec = vec![Complex32::default(); HALF];
    let mut scratch = vec![Complex32::default(); N];
    let mut buf = vec![Complex32::default(); N];
    for t in 0..TABLES.len() {
        for f in 0..FRAMES {
            let x = f as f32 / (FRAMES - 1) as f32;
            frame_spectrum(t, x, fwd.as_ref(), &mut scratch, &mut spec);
            let mut norm = 1.0f32;
            for m in 0..MIPS {
                let hmax = (HALF >> m).min(HALF - 1);
                buf.iter_mut().for_each(|c| *c = Complex32::default());
                for h in 1..=hmax {
                    buf[h] = spec[h];
                    buf[N - h] = spec[h].conj();
                }
                inv.process(&mut buf);
                if m == 0 {
                    // equal loudness across frames and tables (RMS 0.5),
                    // with peaky shapes capped at a peak of 1.5
                    let peak = buf.iter().fold(0.0f32, |p, c| p.max(c.re.abs()));
                    let rms = (buf.iter().map(|c| c.re * c.re).sum::<f32>() / N as f32).sqrt();
                    norm = if peak > 1e-9 { (PEAK_CAP / peak).min(TARGET_RMS / rms.max(1e-9)) } else { 1.0 };
                }
                let o = ((t * FRAMES + f) * MIPS + m) * STRIDE;
                for n in 0..N {
                    data[o + n] = buf[n].re * norm;
                }
                data[o + N] = data[o];
            }
        }
    }
    WaveBank { data }
}

/// Mip level for a fundamental: the first whose harmonics all stay under
/// 0.6 × the sample rate.
#[inline]
fn mip_for(f0: f32, sr: f32) -> usize {
    let hmax = 0.6 * sr / f0.max(1.0);
    let mut m = 0;
    while m < MIPS - 1 && (HALF >> m) as f32 > hmax {
        m += 1;
    }
    m
}

// ── Voice ────────────────────────────────────────────────────────────────

pub(crate) struct WaveShared {
    bank: Arc<WaveBank>,
    table: usize,
    position: f32,
    level: f32,
    unison: usize,
    uratio: [f64; MAX_UNISON],
    umax: f64,
    ugl: [f32; MAX_UNISON],
    ugr: [f32; MAX_UNISON],
    semis: f32,
    sub_level: f32,
    sub_shape: Shape,
    sub_ratio: f64,
    amp_env: EnvParams,
    mod_env: EnvParams,
    mod_pos: f32,
    mod_cut: f32,
    lfo_shape: usize,
    lfo_inc: f64,
    lfo_pos: f32,
    lfo_cut: f32,
    lfo_pitch: f32,
    ftype: usize,
    cutoff: f32,
    reso: f32,
    kt: f32,
}

pub(crate) struct WaveVoice {
    active: bool,
    choking: bool,
    fade: f32,
    fade_step: f32,
    fadein: f32,
    fadein_step: f32,
    glide: Glide,
    vel: f32,
    vel_raw: f32,
    pl: f32,
    pr: f32,
    mod_x: f32,
    mod_y: f32,
    ph: [u32; MAX_UNISON],
    inc: [u32; MAX_UNISON],
    sub_ph: f64,
    sub_dt: f64,
    mip: usize,
    amp: Ahdsr,
    menv: Ahdsr,
    filt: [Svf; 2],
    lvl: Smooth,
    /// smoothed table position and log2 cutoff (automation without zipper)
    pos_s: Smooth,
    cut_s: Smooth,
    lfo_ph: f64,
    ctrl: u32,
    rng: Rng,
    sr: f32,
}

impl WaveVoice {
    fn new(sr: f32, seed: u32) -> Self {
        let mut amp = Ahdsr::default();
        amp.set_sr(sr);
        let mut menv = Ahdsr::default();
        menv.set_sr(sr);
        Self {
            active: false,
            choking: false,
            fade: 1.0,
            fade_step: 1.0 / (CHOKE_MS * 0.001 * sr),
            fadein: 1.0,
            fadein_step: 1.0 / (CHOKE_MS * 0.001 * sr),
            glide: Glide::default(),
            vel: 0.0,
            vel_raw: 0.0,
            pl: 1.0,
            pr: 1.0,
            mod_x: 0.5,
            mod_y: 0.5,
            ph: [0; MAX_UNISON],
            inc: [0; MAX_UNISON],
            sub_ph: 0.0,
            sub_dt: 0.0,
            mip: 0,
            amp,
            menv,
            filt: [Svf::default(); 2],
            lvl: Smooth::with_time(0.8, 8.0, sr),
            pos_s: Smooth::with_time(0.67, 15.0, sr),
            cut_s: Smooth::with_time(9000f32.log2(), 10.0, sr),
            lfo_ph: 0.0,
            ctrl: 0,
            rng: Rng::new(seed),
            sr,
        }
    }

    /// Pitch, mip level and filter coefficients (every 16 samples).
    fn control(&mut self, sh: &WaveShared, lfo: f32, menv: f32) {
        let pitch = self.glide.cur + sh.semis + lfo * sh.lfo_pitch * 0.01;
        let f0 = midi_to_hz(pitch);
        let base = f0 as f64 / self.sr as f64;
        for u in 0..sh.unison {
            self.inc[u] = ((base * sh.uratio[u]).min(0.49) * 4_294_967_296.0) as u32;
        }
        self.mip = mip_for((f0 as f64 * sh.umax) as f32, self.sr);
        self.sub_dt = (base * sh.sub_ratio).min(0.49);
        let oct = sh.mod_cut * 6.0 * menv * (0.6 + 0.4 * self.vel_raw)
            + sh.lfo_cut * 3.0 * lfo
            + sh.kt * (self.glide.cur - 60.0) / 12.0
            + (self.mod_x - 0.5) * 4.0;
        let c = (self.cut_s.advance(16) + oct.clamp(-12.0, 12.0)).exp2().clamp(20.0, 0.45 * self.sr);
        let g = svf_g(c as f64, self.sr as f64);
        let k = reso_to_k((sh.reso + (self.mod_y - 0.5) * 0.5).clamp(0.0, 1.0));
        self.filt[0].set_gk(g, k);
        self.filt[1].set_gk(g, k);
    }
}

impl Voice for WaveVoice {
    type Shared = WaveShared;

    fn start(&mut self, sh: &WaveShared, n: &NoteStart, _g: Option<f32>, _gm: f32) {
        self.fadein = if n.xfade { 0.0 } else { 1.0 };
        self.glide.jump(n.pitch);
        self.vel = vel_gain(n.vel);
        self.vel_raw = n.vel;
        (self.pl, self.pr) = pan_gains(n.extras.pan);
        self.mod_x = n.extras.mod_x;
        self.mod_y = n.extras.mod_y;
        // a single voice starts at phase 0 (punchy, repeatable); unison copies at random phases
        for u in 0..MAX_UNISON {
            self.ph[u] = if sh.unison > 1 { self.rng.next_u32() } else { 0 };
        }
        self.sub_ph = 0.0;
        self.amp.kill();
        self.amp.trigger(&sh.amp_env);
        self.menv.kill();
        self.menv.trigger(&sh.mod_env);
        self.filt = [Svf::default(); 2];
        self.lvl.reset(sh.level);
        self.pos_s.reset(sh.position);
        self.cut_s.reset(sh.cutoff.log2());
        self.lfo_ph = 0.0;
        self.ctrl = 0;
        self.fade = 1.0;
        self.choking = false;
        self.active = true;
    }

    fn legato(&mut self, _sh: &WaveShared, pitch: f32, glide_ms: f32) {
        self.glide.to(pitch, glide_ms, self.sr);
    }

    fn release(&mut self, sh: &WaveShared) {
        self.amp.release(&sh.amp_env);
        self.menv.release(&sh.mod_env);
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

    fn render(&mut self, sh: &WaveShared, l: &mut [f32], r: &mut [f32]) {
        self.lvl.set(sh.level);
        self.pos_s.set(sh.position);
        self.cut_s.set(sh.cutoff.log2());
        let last_frame = (FRAMES - 1) as f32;
        for i in 0..l.len() {
            self.glide.next();
            let m = self.menv.next(&sh.mod_env);
            self.lfo_ph += sh.lfo_inc;
            if self.lfo_ph >= 1.0 {
                self.lfo_ph -= self.lfo_ph.floor();
            }
            let lfo = shape(sh.lfo_shape, self.lfo_ph);
            if self.ctrl == 0 {
                self.control(sh, lfo, m);
                self.ctrl = 16;
            }
            self.ctrl -= 1;
            // table position (per sample: smooth morphing)
            let pos = (self.pos_s.next() + sh.mod_pos * m + sh.lfo_pos * 0.5 * lfo).clamp(0.0, 1.0) * last_frame;
            let fa = (pos as usize).min(FRAMES - 2);
            let ff = pos - fa as f32;
            let ta = sh.bank.level(sh.table, fa, self.mip);
            let tb = sh.bank.level(sh.table, fa + 1, self.mip);
            let (mut sl, mut sr) = (0.0f32, 0.0f32);
            for u in 0..sh.unison {
                let ph = self.ph[u];
                let idx = (ph >> 21) as usize;
                let frac = ((ph >> 5) & 0xFFFF) as f32 * (1.0 / 65536.0);
                let a = ta[idx] + (ta[idx + 1] - ta[idx]) * frac;
                let b = tb[idx] + (tb[idx + 1] - tb[idx]) * frac;
                let v = a + (b - a) * ff;
                sl += v * sh.ugl[u];
                sr += v * sh.ugr[u];
                self.ph[u] = ph.wrapping_add(self.inc[u]);
            }
            let lvl = self.lvl.next();
            sl *= lvl;
            sr *= lvl;
            if sh.sub_level > 0.0 {
                let s = blep_wave(sh.sub_shape, self.sub_ph, self.sub_dt) as f32 * sh.sub_level * 0.7;
                sl += s;
                sr += s;
            }
            self.sub_ph += self.sub_dt;
            if self.sub_ph >= 1.0 {
                self.sub_ph -= 1.0;
            }
            let fl = svf_typed(&mut self.filt[0], sh.ftype, sl as f64) as f32;
            let fr = svf_typed(&mut self.filt[1], sh.ftype, sr as f64) as f32;
            let a = self.amp.next(&sh.amp_env);
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

pub struct Wavetable {
    pb: ParamBank<N_PARAMS>,
    shared: WaveShared,
    vm: VoiceManager<WaveVoice>,
    out: OutStage,
    sr: f32,
    lfo_sync: bool,
    lfo_div: f64,
    lfo_rate: f32,
}

impl Wavetable {
    pub fn new(sample_rate: f32, max_frames: usize) -> Self {
        let sr = sanitize_sr(sample_rate);
        let mut seed = 0x9E11u32;
        let mut s = Self {
            pb: ParamBank::new(&param_specs()),
            shared: WaveShared {
                bank: bank(),
                table: 0,
                position: 0.67,
                level: 0.8,
                unison: 1,
                uratio: [1.0; MAX_UNISON],
                umax: 1.0,
                ugl: [1.0; MAX_UNISON],
                ugr: [1.0; MAX_UNISON],
                semis: 0.0,
                sub_level: 0.0,
                sub_shape: Shape::Sine,
                sub_ratio: 0.5,
                amp_env: EnvParams::default(),
                mod_env: EnvParams::default(),
                mod_pos: 0.0,
                mod_cut: 0.0,
                lfo_shape: 1,
                lfo_inc: 0.0,
                lfo_pos: 0.0,
                lfo_cut: 0.0,
                lfo_pitch: 0.0,
                ftype: 0,
                cutoff: 9000.0,
                reso: 0.0,
                kt: 0.0,
            },
            vm: VoiceManager::new(16, || {
                seed = seed.wrapping_add(7919);
                WaveVoice::new(sr, seed)
            }),
            out: OutStage::new(max_frames, sr),
            sr,
            lfo_sync: false,
            lfo_div: 1.0,
            lfo_rate: 0.5,
        };
        s.update();
        s.out.gain.reset(s.out.gain.target);
        s
    }

    fn update(&mut self) {
        let p = &self.pb;
        let sh = &mut self.shared;
        sh.table = p.idx(P::Table as usize).min(TABLES.len() - 1);
        sh.position = p.get(P::Position as usize);
        sh.level = p.get(P::Level as usize);
        sh.semis = p.get(P::Coarse as usize) + p.get(P::Fine as usize) * 0.01;
        let nu = (p.get(P::Unison as usize).round() as usize).clamp(1, MAX_UNISON);
        sh.unison = nu;
        let detune = p.get(P::Detune as usize) as f64;
        let spread = p.get(P::Spread as usize);
        let norm = 1.0 / (nu as f32).sqrt();
        sh.umax = 1.0;
        for u in 0..MAX_UNISON {
            let o = if nu > 1 { 2.0 * u as f64 / (nu - 1) as f64 - 1.0 } else { 0.0 };
            sh.uratio[u] = (detune * 50.0 * o / 1200.0).exp2();
            if u < nu {
                sh.umax = sh.umax.max(sh.uratio[u]);
            }
            let (gl, gr) = pan_gains(spread * o as f32);
            sh.ugl[u] = gl * norm;
            sh.ugr[u] = gr * norm;
        }
        sh.sub_level = p.get(P::SubLevel as usize);
        sh.sub_shape = match p.idx(P::SubShape as usize) {
            0 => Shape::Sine,
            1 => Shape::Triangle,
            _ => Shape::Square,
        };
        sh.sub_ratio = if p.idx(P::SubOctave as usize) == 0 { 0.5 } else { 0.25 };
        sh.ftype = p.idx(P::FilterType as usize).min(3);
        sh.cutoff = p.get(P::Cutoff as usize);
        sh.reso = p.get(P::Reso as usize);
        sh.kt = p.get(P::FilterKeyTrack as usize);
        sh.amp_env = EnvParams {
            attack_ms: p.get(P::AmpAttack as usize),
            hold_ms: p.get(P::AmpHold as usize),
            decay_ms: p.get(P::AmpDecay as usize),
            sustain: p.get(P::AmpSustain as usize),
            release_ms: p.get(P::AmpRelease as usize),
        };
        sh.mod_env = EnvParams {
            attack_ms: p.get(P::ModAttack as usize),
            hold_ms: 0.0,
            decay_ms: p.get(P::ModDecay as usize),
            sustain: p.get(P::ModSustain as usize),
            release_ms: p.get(P::ModRelease as usize),
        };
        sh.mod_pos = p.get(P::ModToPosition as usize);
        sh.mod_cut = p.get(P::ModToCutoff as usize);
        sh.lfo_shape = p.idx(P::LfoShape as usize).min(LFO_SHAPES.len() - 1);
        sh.lfo_pos = p.get(P::LfoToPosition as usize);
        sh.lfo_cut = p.get(P::LfoToCutoff as usize);
        sh.lfo_pitch = p.get(P::LfoToPitch as usize);
        self.lfo_sync = p.on(P::LfoSync as usize);
        self.lfo_div = SYNC_BEATS[p.idx(P::LfoDivision as usize).min(SYNC_BEATS.len() - 1)];
        self.lfo_rate = p.get(P::LfoRate as usize);
        self.out.gain.set(db_to_gain(p.get(P::Gain as usize)));
    }
}

impl Instrument for Wavetable {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let sr = sanitize_sr(sample_rate);
        self.sr = sr;
        self.vm.all_off();
        let mut seed = 0x9E11u32;
        for v in self.vm.voices.iter_mut() {
            seed = seed.wrapping_add(7919);
            *v = WaveVoice::new(sr, seed);
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
        self.shared.lfo_inc = if self.lfo_sync {
            sane_bpm(ctx.bpm) / 60.0 / self.lfo_div / self.sr as f64
        } else {
            self.lfo_rate as f64 / self.sr as f64
        };
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

    /// Energy of `x` at harmonic `h` of a 2048-sample cycle (naive DFT).
    fn harmonic(x: &[f32], h: usize) -> f32 {
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for (n, v) in x[..N].iter().enumerate() {
            let w = std::f64::consts::TAU * (h * n) as f64 / N as f64;
            re += *v as f64 * w.cos();
            im += *v as f64 * w.sin();
        }
        ((re * re + im * im).sqrt() * 2.0 / N as f64) as f32
    }

    #[test]
    fn mips_are_band_limited_and_normalized() {
        let b = bank();
        for t in 0..TABLES.len() {
            for f in [0, FRAMES / 2, FRAMES - 1] {
                let top = b.level(t, f, 0);
                let peak = top[..N].iter().fold(0.0f32, |p, v| p.max(v.abs()));
                let rms = (top[..N].iter().map(|v| v * v).sum::<f32>() / N as f32).sqrt();
                assert!(peak <= PEAK_CAP + 1e-3 && rms <= TARGET_RMS + 1e-3, "{} frame {f}: peak {peak} rms {rms}", TABLES[t]);
                assert!((peak - PEAK_CAP).abs() < 1e-3 || (rms - TARGET_RMS).abs() < 1e-3, "{} frame {f}: not normalized", TABLES[t]);
                assert_eq!(top[N], top[0], "guard sample");
                // level 4 keeps harmonics ≤ 64 only
                let lv = b.level(t, f, 4);
                for h in [65usize, 100, 300] {
                    assert!(harmonic(lv, h) < 1e-4, "{} frame {f}: harmonic {h} = {}", TABLES[t], harmonic(lv, h));
                }
            }
        }
        // the basic morph starts as a pure sine
        let sine = b.level(0, 0, 0);
        assert!((harmonic(sine, 1) - 0.707).abs() < 0.01 && harmonic(sine, 2) < 1e-4 && harmonic(sine, 3) < 1e-4);
    }

    #[test]
    fn mip_choice_keeps_harmonics_below_0_6_fs() {
        for f0 in [20.0f32, 55.0, 110.0, 440.0, 1760.0, 7040.0, 12000.0] {
            let m = mip_for(f0, 48000.0);
            let top = ((HALF >> m).min(HALF - 1)) as f32 * f0;
            assert!(top <= 0.6 * 48000.0 || m == MIPS - 1, "{f0} Hz → mip {m}, top {top}");
        }
    }
}
