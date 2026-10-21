//! krypt.sampler — polyphonic sample player: windowed-sinc resampling
//! (anti-aliased when pitching up), AHDSR, TPT SVF filter, pitch envelope,
//! one-shot / loop / reverse, sample start and end, glide and slides.
//!
//! Start / End mark the region that plays (End ≤ Start = silent). Forward
//! playback runs Start → End, reverse runs End → Start; a region edge that is
//! not the sample's own edge stops with the short choke fade. With Loop on,
//! the loop runs over the whole sample at End = 100% (the original
//! behaviour) and between Start and End below it.

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
    // wave 12.2 (appended): region end, so slices can stop
    End => lin("end", "End", 0.0, 1.0, 1.0, "%", "Playback"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.sampler",
        name: "Krypt Sampler",
        kind: PluginKind::Instrument,
        category: "Sampler",
        description: "Plays a sample across the keyboard (C4 / MIDI 60 = original pitch unless the WAV has a root key) with \
                      windowed-sinc resampling, AHDSR envelope, filter, pitch envelope, reverse and loop. One-shot ignores \
                      note length (unless Loop is on). Start/End pick the region (slices; End <= Start is silent; reverse plays End to Start). \
                      Per-note Mod X/Y offset cutoff/resonance. The default drum/one-shot channel.",
        params: param_specs(),
        uses_sample: Some(true),
        sidechain: None,
        default_mix: None,
    }
}

/// Resonance 0..1 → SVF damping k (Q 0.707 … ~25).
#[inline]
pub(crate) fn reso_to_k(r: f32) -> f64 {
    let q = std::f64::consts::FRAC_1_SQRT_2 * (2f64).powf(r.clamp(0.0, 1.0) as f64 * 5.1);
    1.0 / q
}

/// Apply the filter type tap to an SVF tick (0 LP, 1 HP, 2 BP, 3 Notch).
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
    pub end: f32,
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

/// The playing region in frames: (loop start, region start, region end).
/// At End = 100% the region ends at the sample's end and a loop wraps over the whole sample (the original behaviour).
#[inline]
fn region(sh: &SamplerShared, len: usize) -> (f64, f64, f64) {
    let lo = sh.start as f64 * len as f64;
    if sh.end >= 1.0 {
        (0.0, lo, len as f64)
    } else {
        // whole frames, so End lands exactly where a slice says (0.6 as f32 is not 0.6)
        let hi = (sh.end as f64 * len as f64).round().min(len as f64);
        (lo.floor(), lo, hi)
    }
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
        let (ll, lo, hi) = region(sh, len);
        if hi <= lo {
            // End at or before Start: nothing to play
            self.active = false;
            return;
        }
        let extra = n.extras.sample_start.max(0.0) * s.sample_rate as f64;
        // `offset` = how far into the region playback enters (a mid-sample entry fades in)
        let offset = if sh.reverse {
            // reverse runs End → Start; sample_start moves the entry point back from End
            let back = if sh.looping { extra % (hi - ll) } else { extra };
            let pos = hi - 1.0 - back;
            if pos <= lo - 1.0 && !sh.looping {
                self.active = false;
                return;
            }
            self.pos = pos;
            if hi < len as f64 {
                back.max(1.0)
            } else {
                back
            }
        } else {
            let o = (sh.start as f64 * len as f64 + extra).max(0.0);
            if o >= hi && !sh.looping {
                self.active = false;
                return;
            }
            let o = if sh.looping && o >= hi { ll + (o - ll) % (hi - ll) } else { o };
            self.pos = o;
            o
        };
        self.dir = if sh.reverse { -1.0 } else { 1.0 };
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
        let (ll, lo, hi) = region(sh, len);
        // a loop that ends before the sample does reads only up to its end (the kernel wraps there)
        let data_len = if sh.looping { (hi.ceil() as usize).clamp(1, len) } else { len };
        let ch0 = &s.channels[0][..data_len];
        let ch1 = if s.channels.len() > 1 { Some(&s.channels[1][..data_len]) } else { None };
        let mut w = [0.0f32; MAX_TAPS];
        let wrap = if sh.looping { Some((ll as i64, data_len as i64)) } else { None };
        // a region edge inside the sample stops with the choke fade instead of a click
        let edge_fade = !sh.looping && if sh.reverse { lo > 0.0 } else { hi < len as f64 };
        let fade_len = (CHOKE_MS * 0.001 * self.sr) as f64;
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
            // read
            let (mut a, mut b);
            let fr = self.pos - self.pos.floor();
            if fr == 0.0 && step == 1.0 && self.pos >= 0.0 && (self.pos as usize) < data_len {
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
            let edge = if edge_fade {
                let dist = if self.dir > 0.0 { hi - self.pos } else { self.pos - lo };
                (dist / (step * fade_len).max(1e-9)).clamp(0.0, 1.0) as f32
            } else {
                1.0
            };
            // advance
            self.pos += self.dir * step;
            let mut finished = false;
            if sh.looping {
                if self.pos >= hi || self.pos < ll {
                    self.pos = ll + (self.pos - ll).rem_euclid(hi - ll);
                }
            } else if self.pos >= hi || self.pos < lo - 1.0 {
                finished = true;
            }
            // envelope
            let e = self.env.next(&sh.env);
            if self.env.idle() {
                finished = true;
            }
            // filter
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
            if edge_fade {
                g *= edge;
            }
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
            end: 1.0,
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
        sh.end = p.get(P::End as usize);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::sampler_legacy;

    const SR: f32 = 48000.0;

    /// A ramp (0 → 1 over the sample) on the left, a decaying tone on the right.
    fn sample(frames: usize) -> Arc<SampleData> {
        let l = (0..frames).map(|i| i as f32 / frames as f32).collect();
        let r = (0..frames).map(|i| (i as f32 * 0.05).sin() * (-(i as f32) / 20000.0).exp()).collect();
        Arc::new(SampleData { sample_rate: SR, channels: vec![l, r], root_key: None })
    }

    fn render(inst: &mut dyn Instrument, frames: usize, notes: &[(usize, u8, f32, f64)]) -> (Vec<f32>, Vec<f32>) {
        let (mut l, mut r) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        let mut at = 0;
        while at < frames {
            let n = (frames - at).min(256);
            for &(t, key, pitch, start) in notes {
                if t >= at && t < at + n {
                    inst.note_on(t - at, key, pitch, 0.9, NoteExtras { sample_start: start, ..Default::default() });
                }
                if t + 30000 >= at && t + 30000 < at + n {
                    inst.note_off(t + 30000 - at, key);
                }
            }
            let ctx = ProcessContext { sample_rate: SR, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: n };
            inst.process(&ctx, [&mut l[at..at + n], &mut r[at..at + n]]);
            at += n;
        }
        (l, r)
    }

    fn pid(id: &str) -> usize {
        param_specs().iter().position(|p| p.id == id).unwrap()
    }

    #[test]
    fn default_end_keeps_existing_playback_bit_identical() {
        let s = sample(24000);
        let notes = [(0usize, 60u8, 60.0f32, 0.0f64), (5000, 64, 64.0, 0.0), (9000, 55, 55.3, 0.05), (20000, 60, 60.0, 0.4)];
        let configs: &[&[(&str, f32)]] = &[
            &[],
            &[("start", 0.3)],
            &[("reverse", 1.0)],
            &[("loop", 1.0), ("oneShot", 0.0)],
            &[("loop", 1.0), ("start", 0.25), ("oneShot", 0.0)],
            &[("loop", 1.0), ("reverse", 1.0), ("oneShot", 0.0)],
            &[("cutoff", 900.0), ("reso", 0.5), ("pitchEnvAmount", 12.0)],
        ];
        for (k, cfg) in configs.iter().enumerate() {
            let mut old = sampler_legacy::Sampler::new(SR, 256);
            let mut new = Sampler::new(SR, 256);
            old.set_sample(Some(s.clone()));
            new.set_sample(Some(s.clone()));
            for (id, v) in cfg.iter() {
                old.set_param(pid(id), *v);
                new.set_param(pid(id), *v);
            }
            let (ol, or) = render(&mut old, 60000, &notes);
            let (nl, nr) = render(&mut new, 60000, &notes);
            assert!(ol.iter().any(|v| v.abs() > 1e-3), "config {k} silent");
            assert!(ol == nl && or == nr, "config {k} ({cfg:?}) changed");
        }
    }

    fn one_note(params: &[(&str, f32)], frames: usize) -> Vec<f32> {
        let mut inst = Sampler::new(SR, 256);
        inst.set_sample(Some(sample(24000)));
        for (id, v) in params {
            inst.set_param(pid(id), *v);
        }
        render(&mut inst, frames, &[(0, 60, 60.0, 0.0)]).0
    }

    #[test]
    fn end_stops_playback_with_a_short_fade() {
        let out = one_note(&[("end", 0.5)], 24000);
        // plays the first half, then stops: nothing after frame 12000
        assert!(out[11000].abs() > 0.3, "{}", out[11000]);
        assert!(out[12000..].iter().all(|v| *v == 0.0), "played past End");
        // the last ~2 ms fade down instead of cutting at full level
        let last = out[11999].abs();
        assert!(last < 0.05, "no fade at End: {last}");
        assert!(out[11850].abs() > 0.3);
    }

    #[test]
    fn end_at_or_before_start_is_silent() {
        for (s, e) in [(0.5, 0.5), (0.6, 0.2), (0.0, 0.0)] {
            let out = one_note(&[("start", s), ("end", e)], 6000);
            assert!(out.iter().all(|v| *v == 0.0), "start {s} end {e} made sound");
        }
    }

    #[test]
    fn reverse_plays_from_end_to_start() {
        let out = one_note(&[("start", 0.2), ("end", 0.6), ("reverse", 1.0)], 24000);
        // the ramp: value = position / length; entry ≈ 0.6, last sound ≈ 0.2, region = 9600 frames
        let g = out[200] / ((14400 - 1 - 200) as f32 / 24000.0);
        assert!((out[300] / g - (14400 - 1 - 300) as f32 / 24000.0).abs() < 1e-3);
        assert!(out[9600..].iter().all(|v| *v == 0.0), "played past Start");
        assert!(out[9500].abs() > 0.1 * g, "region cut short");
        // forward with the same region: entry ≈ 0.2, stops after 9600 frames
        let fwd = one_note(&[("start", 0.2), ("end", 0.6)], 24000);
        assert!((fwd[300] / g - (4800 + 300) as f32 / 24000.0).abs() < 1e-3, "{} vs {}", fwd[300] / g, (4800 + 300) as f32 / 24000.0);
        assert!(fwd[9600..].iter().all(|v| *v == 0.0));
    }

    #[test]
    fn looping_below_end_wraps_between_start_and_end() {
        let out = one_note(&[("start", 0.5), ("end", 0.75), ("loop", 1.0), ("oneShot", 0.0)], 20000);
        // the ramp stays inside 0.5 .. 0.75 of full scale, and is still sounding long after one pass
        let g = out[100] / ((12000 + 100) as f32 / 24000.0);
        for i in (200..20000).step_by(37) {
            let v = out[i] / g;
            assert!((0.49..=0.76).contains(&v), "frame {i}: {v}");
        }
    }
}
