#![allow(dead_code)]

use std::sync::Arc;

use super::{instrument_process, usable_frames, OutStage, Voice, VoiceManager, CHOKE_MS};
use crate::blocks::env::{Ahdsr, EnvParams, ExpDecay};
use crate::blocks::filters::{svf_g, Svf};
use crate::blocks::sinc::{apply, SincTable, MAX_TAPS};
use crate::blocks::{db_to_gain, pan_gains, vel_gain, Glide, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Instrument, NoteExtras, PluginDescriptor, PluginKind, ProcessContext, SampleData};

param_table! {
    OneShot => toggle("oneShot", "One-shot (ignore note length)", true, "Playback"),
    Start => lin("start", "Start", 0.0, 1.0, 0.0, "%", "Playback"),
    Reverse => toggle("reverse", "Reverse", false, "Playback"),
    Loop => toggle("loop", "Loop", false, "Playback"),
    KeyTrack => toggle("keyTrack", "Key tracking", true, "Playback"),
    Gain => lin("gain", "Gain", -24.0, 24.0, 0.0, "dB", "Playback"),
    AmpAttack => logp("ampAttack", "Attack", 0.1, 5000.0, 0.1, "ms", "Envelope"),
    AmpHold => logp("ampHold", "Hold", 0.1, 5000.0, 0.1, "ms", "Envelope"),
    AmpDecay => logp("ampDecay", "Decay", 1.0, 10000.0, 1000.0, "ms", "Envelope"),
    AmpSustain => lin("ampSustain", "Sustain", 0.0, 1.0, 1.0, "%", "Envelope"),
    AmpRelease => logp("ampRelease", "Release", 1.0, 10000.0, 30.0, "ms", "Envelope"),
    FilterType => choice("filterType", "Type", &["Low pass", "High pass", "Band pass", "Notch"], 0, "Filter"),
    Cutoff => logp("cutoff", "Cutoff", 20.0, 20000.0, 20000.0, "Hz", "Filter"),
    Reso => lin("reso", "Resonance", 0.0, 1.0, 0.0, "%", "Filter"),
    PitchEnvAmount => lin("pitchEnvAmount", "Amount", -48.0, 48.0, 0.0, "st", "Pitch envelope"),
    PitchEnvDecay => logp("pitchEnvDecay", "Decay", 1.0, 5000.0, 100.0, "ms", "Pitch envelope"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.sampler",
        name: "Krypt Sampler",
        kind: PluginKind::Instrument,
        category: "Sampler",
        description: "Plays a sample across the keyboard (C4 / MIDI 60 = original pitch unless the WAV has a root key) with \
                      windowed-sinc resampling, AHDSR envelope, filter, pitch envelope, reverse and loop. One-shot ignores \
                      note length (unless Loop is on). Per-note Mod X/Y offset cutoff/resonance. The default drum/one-shot channel.",
        params: param_specs(),
        uses_sample: Some(true),
        sidechain: None,
        default_mix: None,
    }
}

#[inline]
pub(crate) fn reso_to_k(r: f32) -> f64 {
    let q = std::f64::consts::FRAC_1_SQRT_2 * (2f64).powf(r.clamp(0.0, 1.0) as f64 * 5.1);
    1.0 / q
}

#[inline]
pub(crate) fn svf_typed(f: &mut Svf, ftype: usize, x: f64) -> f64 {
    let (lp, bp, hp) = f.tick3(x);
    match ftype {
        0 => lp,
        1 => hp,
        2 => f.k() * bp,
        _ => x - f.k() * bp,
    }
}

pub(crate) struct SamplerShared {
    pub sample: Option<Arc<SampleData>>,
    pub sinc: SincTable,
    pub sr: f32,
    pub one_shot: bool,
    pub start: f32,
    pub reverse: bool,
    pub looping: bool,
    pub key_track: bool,
    pub env: EnvParams,
    pub ftype: usize,
    pub cutoff: f32,
    pub reso: f32,
    pub penv_amt: f32,
    pub penv_ms: f32,
}

pub(crate) struct SamplerVoice {
    active: bool,
    pos: f64,
    dir: f64,
    glide: Glide,
    root: f32,
    ratio_base: f64,
    vel: f32,
    pl: f32,
    pr: f32,
    env: Ahdsr,
    penv: ExpDecay,
    filt: [Svf; 2],
    cut_s: Smooth,
    res_s: Smooth,
    coef_count: u32,
    mod_x: f32,
    mod_y: f32,
    fade: f32,
    fade_step: f32,
    choking: bool,
    fadein: f32,
    fadein_step: f32,
    sr: f32,
}

impl SamplerVoice {
    fn new(sr: f32) -> Self {
        let mut env = Ahdsr::default();
        env.set_sr(sr);
        Self {
            active: false,
            pos: 0.0,
            dir: 1.0,
            glide: Glide::default(),
            root: 60.0,
            ratio_base: 1.0,
            vel: 0.0,
            pl: 1.0,
            pr: 1.0,
            env,
            penv: ExpDecay::default(),
            filt: [Svf::default(); 2],
            cut_s: Smooth::with_time(20000.0, 10.0, sr),
            res_s: Smooth::with_time(0.0, 10.0, sr),
            coef_count: 0,
            mod_x: 0.5,
            mod_y: 0.5,
            fade: 1.0,
            fade_step: 1.0 / (CHOKE_MS * 0.001 * sr),
            choking: false,
            fadein: 1.0,
            fadein_step: 1.0,
            sr,
        }
    }

    fn filter_targets(&self, sh: &SamplerShared) -> (f32, f32) {
        let cut = sh.cutoff * ((self.mod_x - 0.5) * 4.0).exp2();
        let res = (sh.reso + (self.mod_y - 0.5) * 0.5).clamp(0.0, 1.0);
        (cut.clamp(20.0, 20000.0), res)
    }
}

impl Voice for SamplerVoice {
    type Shared = SamplerShared;

    fn start(&mut self, sh: &SamplerShared, n: &NoteStart, _glide_from: Option<f32>, _glide_ms: f32) {
        let Some(s) = sh.sample.as_ref() else {
            self.active = false;
            return;
        };
        let len = usable_frames(s);
        if len == 0 || s.sample_rate <= 0.0 {
            self.active = false;
            return;
        }
        let offset = (sh.start as f64 * len as f64 + n.extras.sample_start.max(0.0) * s.sample_rate as f64).max(0.0);
        if offset >= len as f64 && !sh.looping {
            self.active = false;
            return;
        }
        let offset = offset % len as f64;
        self.dir = if sh.reverse { -1.0 } else { 1.0 };
        self.pos = if sh.reverse { (len - 1) as f64 - offset } else { offset };
        self.root = s.root_key.map(|k| k as f32).unwrap_or(60.0);
        self.ratio_base = s.sample_rate as f64 / self.sr as f64;
        self.glide.jump(n.pitch);
        self.vel = vel_gain(n.vel);
        (self.pl, self.pr) = pan_gains(n.extras.pan);
        self.mod_x = n.extras.mod_x;
        self.mod_y = n.extras.mod_y;
        self.env.kill();
        self.env.trigger(&sh.env);
        self.penv.trigger(sh.penv_ms, 60.0, self.sr);
        self.filt = [Svf::default(); 2];
        let (c, r) = self.filter_targets(sh);
        self.cut_s.reset(c);
        self.res_s.reset(r);
        self.coef_count = 0;
        self.fade = 1.0;
        self.choking = false;
        if n.xfade {
            self.fadein = 0.0;
            self.fadein_step = 1.0 / (CHOKE_MS * 0.001 * self.sr);
        } else if offset > 0.5 {
            self.fadein = 0.0;
            self.fadein_step = 1.0 / (0.001 * self.sr);
        } else {
            self.fadein = 1.0;
        }
        self.active = true;
    }

    fn legato(&mut self, _sh: &SamplerShared, pitch: f32, glide_ms: f32) {
        self.glide.to(pitch, glide_ms, self.sr);
    }

    fn release(&mut self, sh: &SamplerShared) {
        if sh.one_shot && !sh.looping {
            return;
        }
        self.env.release(&sh.env);
    }

    fn choke(&mut self) {
        self.choking = true;
    }

    fn kill(&mut self) {
        self.active = false;
        self.choking = false;
        self.env.kill();
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

    fn render(&mut self, sh: &SamplerShared, l: &mut [f32], r: &mut [f32]) {
        let Some(s) = sh.sample.as_ref() else {
            self.kill();
            return;
        };
        let len = usable_frames(s);
        let ch0 = &s.channels[0][..len];
        let ch1 = if s.channels.len() > 1 { Some(&s.channels[1][..len]) } else { None };
        let mut w = [0.0f32; MAX_TAPS];
        let wrap = if sh.looping { Some((0i64, len as i64)) } else { None };
        let (ct, rt) = self.filter_targets(sh);
        self.cut_s.set(ct);
        self.res_s.set(rt);
        let filter_on = !(sh.ftype == 0 && ct >= 19_500.0 && rt < 0.02);
        let pitch_static = !self.glide.gliding() && sh.penv_amt == 0.0;
        let mut step = 0.0f64;
        if pitch_static {
            let semis = if sh.key_track { self.glide.cur - self.root } else { 0.0 };
            step = self.ratio_base * ((semis as f64) / 12.0).exp2();
        }
        for i in 0..l.len() {
            if !pitch_static {
                let p = self.glide.next();
                let pe = self.penv.next();
                let semis = if sh.key_track { p - self.root } else { 0.0 } + sh.penv_amt * pe;
                step = self.ratio_base * ((semis as f64) / 12.0).exp2();
            }
            let (mut a, mut b);
            let fr = self.pos - self.pos.floor();
            if fr == 0.0 && step == 1.0 && self.pos >= 0.0 && (self.pos as usize) < len {
                let k = self.pos as usize;
                a = ch0[k];
                b = ch1.map_or(a, |c| c[k]);
            } else {
                let (first, nt) = sh.sinc.weights(self.pos, step, &mut w);
                a = apply(ch0, first, &w[..nt], wrap);
                b = match ch1 {
                    Some(c) => apply(c, first, &w[..nt], wrap),
                    None => a,
                };
            }
            self.pos += self.dir * step;
            let mut finished = false;
            if sh.looping {
                if self.pos >= len as f64 || self.pos < 0.0 {
                    self.pos = self.pos.rem_euclid(len as f64);
                }
            } else if self.pos >= len as f64 || self.pos < -1.0 {
                finished = true;
            }
            let e = self.env.next(&sh.env);
            if self.env.idle() {
                finished = true;
            }
            if filter_on {
                if self.coef_count == 0 {
                    let c = self.cut_s.advance(16);
                    let rs = self.res_s.advance(16);
                    let g = svf_g(c as f64, self.sr as f64);
                    let k = reso_to_k(rs);
                    self.filt[0].set_gk(g, k);
                    self.filt[1].set_gk(g, k);
                    self.coef_count = 16;
                }
                self.coef_count -= 1;
                a = svf_typed(&mut self.filt[0], sh.ftype, a as f64) as f32;
                b = svf_typed(&mut self.filt[1], sh.ftype, b as f64) as f32;
            }
            let mut g = e * self.vel;
            if self.fadein < 1.0 {
                self.fadein = (self.fadein + self.fadein_step).min(1.0);
                g *= self.fadein;
            }
            if self.choking {
                self.fade -= self.fade_step;
                if self.fade <= 0.0 {
                    finished = true;
                    self.fade = 0.0;
                }
                g *= self.fade;
            }
            l[i] += a * g * self.pl;
            r[i] += b * g * self.pr;
            if finished {
                self.kill();
                return;
            }
        }
    }
}

use super::NoteStart;

pub struct Sampler {
    pb: ParamBank<N_PARAMS>,
    shared: SamplerShared,
    vm: VoiceManager<SamplerVoice>,
    out: OutStage,
    sr: f32,
}

impl Sampler {
    pub fn new(sample_rate: f32, max_frames: usize) -> Self {
        let sr = sanitize_sr(sample_rate);
        let shared = SamplerShared {
            sample: None,
            sinc: SincTable::new(),
            sr,
            one_shot: true,
            start: 0.0,
            reverse: false,
            looping: false,
            key_track: true,
            env: EnvParams::default(),
            ftype: 0,
            cutoff: 20000.0,
            reso: 0.0,
            penv_amt: 0.0,
            penv_ms: 100.0,
        };
        let mut s = Self {
            pb: ParamBank::new(&param_specs()),
            shared,
            vm: VoiceManager::new(32, || SamplerVoice::new(sr)),
            out: OutStage::new(max_frames, sr),
            sr,
        };
        s.update();
        s.out.gain.reset(s.out.gain.target);
        s
    }

    fn update(&mut self) {
        let p = &self.pb;
        let sh = &mut self.shared;
        sh.one_shot = p.on(P::OneShot as usize);
        sh.start = p.get(P::Start as usize);
        sh.reverse = p.on(P::Reverse as usize);
        sh.looping = p.on(P::Loop as usize);
        sh.key_track = p.on(P::KeyTrack as usize);
        sh.env = EnvParams {
            attack_ms: p.get(P::AmpAttack as usize),
            hold_ms: p.get(P::AmpHold as usize),
            decay_ms: p.get(P::AmpDecay as usize),
            sustain: p.get(P::AmpSustain as usize),
            release_ms: p.get(P::AmpRelease as usize),
        };
        sh.ftype = p.idx(P::FilterType as usize).min(3);
        sh.cutoff = p.get(P::Cutoff as usize);
        sh.reso = p.get(P::Reso as usize);
        sh.penv_amt = p.get(P::PitchEnvAmount as usize);
        sh.penv_ms = p.get(P::PitchEnvDecay as usize);
        self.out.gain.set(db_to_gain(p.get(P::Gain as usize)));
    }
}

pub(crate) fn sanitize_sr(sr: f32) -> f32 {
    if sr.is_finite() && sr >= 8000.0 {
        sr.min(768_000.0)
    } else {
        48000.0
    }
}

impl Instrument for Sampler {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let sr = sanitize_sr(sample_rate);
        self.sr = sr;
        self.shared.sr = sr;
        self.vm.all_off();
        for v in self.vm.voices.iter_mut() {
            *v = SamplerVoice::new(sr);
        }
        self.out.prepare(max_frames, sr);
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn set_sample(&mut self, sample: Option<Arc<SampleData>>) {
        self.vm.all_off();
        self.shared.sample = sample.filter(|s| usable_frames(s) > 0 && s.sample_rate.is_finite() && s.sample_rate > 0.0);
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
