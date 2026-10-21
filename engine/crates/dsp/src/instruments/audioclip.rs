use std::sync::Arc;

use super::sampler::sanitize_sr;
use super::{instrument_process, usable_frames, NoteStart, OutStage, Voice, VoiceManager, CHOKE_MS};
use crate::blocks::sinc::{apply, SincTable, MAX_TAPS};
use crate::blocks::{db_to_gain, pan_gains, vel_gain};
use crate::params::{param_table, ParamBank};
use crate::{Instrument, NoteExtras, PluginDescriptor, PluginKind, ProcessContext, SampleData};

param_table! {
    Gain => lin("gain", "Gain", -24.0, 24.0, 0.0, "dB", "Playback"),
    Reverse => toggle("reverse", "Reverse", false, "Playback"),
    Pitch => not_automatable(lin("pitch", "Pitch", -24.0, 24.0, 0.0, "st", "Stretch")),
    Formant => not_automatable(toggle("formant", "Keep formants", true, "Stretch")),
    TempoSync => not_automatable(toggle("tempo_sync", "Follow tempo", false, "Stretch")),
    SrcBpm => not_automatable(lin("src_bpm", "Source BPM", 0.0, 999.0, 0.0, "bpm", "Stretch")),
    Stretch => not_automatable(logp("stretch", "Stretch", 0.25, 4.0, 1.0, "x", "Stretch")),
}

pub const PLUGIN_ID: &str = "krypt.audioclip";

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: PLUGIN_ID,
        name: "Audio Clip",
        kind: PluginKind::Instrument,
        category: "Sampler",
        description: "Plays a sample in sync with playlist audio clips (no key tracking, high-quality sample-rate conversion). \
                      Stretch: time-stretch (Stretch × source BPM / project BPM when Follow tempo is on) and pitch-shift in \
                      semitones with optional formant preservation, rendered in the background (Signalsmith Stretch); the clip \
                      is silent until a new timing is ready. Created automatically when audio is dropped on the playlist.",
        params: param_specs(),
        uses_sample: Some(true),
        sidechain: None,
        default_mix: None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StretchRequest {
    pub ratio: f64,
    pub semitones: f64,
    pub keep_formants: bool,
    pub missing_src_bpm: bool,
}

impl StretchRequest {
    pub fn is_identity(&self) -> bool {
        self.ratio == 1.0 && self.semitones == 0.0
    }
}

pub fn stretch_request(get: impl Fn(&str) -> Option<f32>, project_bpm: f64) -> StretchRequest {
    let specs = param_specs();
    let val = |p: P| -> f64 {
        let s = &specs[p as usize];
        let v = get(s.id).filter(|v| v.is_finite()).unwrap_or(s.default);
        crate::clamp_to_spec(s, v) as f64
    };
    let semitones = val(P::Pitch);
    let keep_formants = val(P::Formant) >= 0.5;
    let sync = val(P::TempoSync) >= 0.5;
    let src_bpm = val(P::SrcBpm);
    let mut ratio = val(P::Stretch);
    let bpm = if project_bpm.is_finite() && project_bpm > 0.0 { project_bpm } else { 140.0 };
    if sync && src_bpm > 0.0 {
        ratio *= src_bpm / bpm;
    }
    StretchRequest { ratio, semitones, keep_formants, missing_src_bpm: sync && src_bpm <= 0.0 }
}

pub(crate) struct ClipShared {
    sample: Option<Arc<SampleData>>,
    sinc: SincTable,
    reverse: bool,
}

pub(crate) struct ClipVoice {
    active: bool,
    pos: f64,
    dir: f64,
    step: f64,
    vel: f32,
    pl: f32,
    pr: f32,
    fade: f32,
    fade_step: f32,
    fading: bool,
    choking: bool,
    fadein: f32,
    fadein_step: f32,
    sr: f32,
}

impl ClipVoice {
    fn new(sr: f32) -> Self {
        Self {
            active: false,
            pos: 0.0,
            dir: 1.0,
            step: 1.0,
            vel: 1.0,
            pl: 1.0,
            pr: 1.0,
            fade: 1.0,
            fade_step: 0.0,
            fading: false,
            choking: false,
            fadein: 1.0,
            fadein_step: 1.0,
            sr,
        }
    }
}

impl Voice for ClipVoice {
    type Shared = ClipShared;

    fn start(&mut self, sh: &ClipShared, n: &NoteStart, _g: Option<f32>, _gm: f32) {
        let Some(s) = sh.sample.as_ref() else {
            self.active = false;
            return;
        };
        let len = usable_frames(s);
        let offset = n.extras.sample_start.max(0.0) * s.sample_rate as f64;
        if len == 0 || s.sample_rate <= 0.0 || offset >= len as f64 {
            self.active = false;
            return;
        }
        self.step = s.sample_rate as f64 / self.sr as f64;
        self.dir = if sh.reverse { -1.0 } else { 1.0 };
        self.pos = if sh.reverse { (len - 1) as f64 - offset } else { offset };
        self.vel = vel_gain(n.vel);
        (self.pl, self.pr) = pan_gains(n.extras.pan);
        self.fade = 1.0;
        self.fading = false;
        self.choking = false;
        if offset > 0.5 || n.xfade {
            self.fadein = 0.0;
            self.fadein_step = 1.0 / (CHOKE_MS * 0.001 * self.sr);
        } else {
            self.fadein = 1.0;
        }
        self.active = true;
    }

    fn legato(&mut self, _sh: &ClipShared, _pitch: f32, _glide_ms: f32) {}

    fn release(&mut self, _sh: &ClipShared) {
        if !self.fading {
            self.fading = true;
            self.fade_step = 1.0 / (4.0 * 0.001 * self.sr);
        }
    }

    fn choke(&mut self) {
        self.fading = true;
        self.choking = true;
        self.fade_step = 1.0 / (CHOKE_MS * 0.001 * self.sr);
    }

    fn kill(&mut self) {
        self.active = false;
        self.choking = false;
        self.fading = false;
    }

    fn active(&self) -> bool {
        self.active
    }

    fn choking(&self) -> bool {
        self.choking
    }

    fn pitch(&self) -> f32 {
        60.0
    }

    fn render(&mut self, sh: &ClipShared, l: &mut [f32], r: &mut [f32]) {
        let Some(s) = sh.sample.as_ref() else {
            self.kill();
            return;
        };
        let len = usable_frames(s);
        let ch0 = &s.channels[0][..len];
        let ch1 = if s.channels.len() > 1 { Some(&s.channels[1][..len]) } else { None };
        let mut w = [0.0f32; MAX_TAPS];
        let exact = self.step == 1.0 && self.pos.fract() == 0.0;
        for i in 0..l.len() {
            let (a, b);
            if exact {
                if self.pos < 0.0 || self.pos >= len as f64 {
                    self.kill();
                    return;
                }
                let k = self.pos as usize;
                a = ch0[k];
                b = ch1.map_or(a, |c| c[k]);
            } else {
                if self.pos < -1.0 || self.pos >= len as f64 {
                    self.kill();
                    return;
                }
                let (first, nt) = sh.sinc.weights(self.pos, self.step, &mut w);
                a = apply(ch0, first, &w[..nt], None);
                b = match ch1 {
                    Some(c) => apply(c, first, &w[..nt], None),
                    None => a,
                };
            }
            self.pos += self.dir * self.step;
            let mut g = self.vel;
            if self.fadein < 1.0 {
                self.fadein = (self.fadein + self.fadein_step).min(1.0);
                g *= self.fadein;
            }
            if self.fading {
                self.fade -= self.fade_step;
                if self.fade <= 0.0 {
                    self.kill();
                    return;
                }
                g *= self.fade;
            }
            l[i] += a * g * self.pl;
            r[i] += b * g * self.pr;
        }
    }
}

pub struct AudioClip {
    pb: ParamBank<N_PARAMS>,
    shared: ClipShared,
    vm: VoiceManager<ClipVoice>,
    out: OutStage,
}

impl AudioClip {
    pub fn new(sample_rate: f32, max_frames: usize) -> Self {
        let sr = sanitize_sr(sample_rate);
        let mut s = Self {
            pb: ParamBank::new(&param_specs()),
            shared: ClipShared { sample: None, sinc: SincTable::new(), reverse: false },
            vm: VoiceManager::new(8, || ClipVoice::new(sr)),
            out: OutStage::new(max_frames, sr),
        };
        s.update();
        s.out.gain.reset(s.out.gain.target);
        s
    }

    fn update(&mut self) {
        self.shared.reverse = self.pb.on(P::Reverse as usize);
        self.out.gain.set(db_to_gain(self.pb.get(P::Gain as usize)));
    }
}

impl Instrument for AudioClip {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let sr = sanitize_sr(sample_rate);
        self.vm.all_off();
        for v in self.vm.voices.iter_mut() {
            *v = ClipVoice::new(sr);
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

    fn note_on(&mut self, offset: usize, key: u8, pitch: f32, velocity: f32, extras: NoteExtras) {
        let extras = NoteExtras { slide: false, ..extras };
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
    use std::collections::HashMap;

    fn req(params: &[(&str, f32)], bpm: f64) -> StretchRequest {
        let m: HashMap<&str, f32> = params.iter().copied().collect();
        stretch_request(|id| m.get(id).copied(), bpm)
    }

    #[test]
    fn stretch_request_formula() {
        let r = req(&[], 140.0);
        assert!(r.is_identity() && r.keep_formants && !r.missing_src_bpm);
        assert_eq!(req(&[("stretch", 2.0)], 140.0).ratio, 2.0);
        assert_eq!(req(&[("tempo_sync", 1.0), ("src_bpm", 120.0)], 60.0).ratio, 2.0);
        assert!((req(&[("tempo_sync", 1.0), ("src_bpm", 120.0), ("stretch", 1.5)], 60.0).ratio - 3.0).abs() < 1e-12);
        assert!(req(&[("tempo_sync", 1.0), ("src_bpm", 128.0)], 128.0).is_identity(), "source tempo = project tempo");
        assert_eq!(req(&[("tempo_sync", 0.0), ("src_bpm", 120.0)], 60.0).ratio, 1.0, "src_bpm alone does nothing");
        let r = req(&[("tempo_sync", 1.0), ("stretch", 0.5)], 60.0);
        assert!(r.missing_src_bpm && r.ratio == 0.5, "unknown source tempo: the factor is 1");
        assert_eq!(req(&[("pitch", 30.0)], 120.0).semitones, 24.0);
        assert_eq!(req(&[("pitch", -0.5)], 120.0).semitones, -0.5);
        assert_eq!(req(&[("stretch", 10.0)], 120.0).ratio, 4.0);
        assert!(!req(&[("formant", 0.0), ("pitch", 3.0)], 120.0).keep_formants);
        let ids: Vec<&str> = param_specs().iter().map(|s| s.id).collect();
        assert_eq!(ids, ["gain", "reverse", "pitch", "formant", "tempo_sync", "src_bpm", "stretch"]);
        assert!(param_specs()[2..].iter().all(|s| s.automatable == Some(false) && s.group == Some("Stretch")));
    }

    #[test]
    fn stretch_params_never_touch_realtime_playback() {
        let n = 256 * 40;
        let l: Vec<f32> = (0..n).map(|i| ((i as f32) * 0.031).sin() * 0.5).collect();
        let r: Vec<f32> = l.iter().map(|v| -v * 0.7).collect();
        let s = Arc::new(SampleData { sample_rate: 48000.0, channels: vec![l, r], root_key: None });
        let render = |params: &[(usize, f32)]| {
            let mut a = AudioClip::new(48000.0, 256);
            for &(i, v) in params {
                a.set_param(i, v);
            }
            a.set_sample(Some(s.clone()));
            a.note_on(3, 60, 60.0, 1.0, NoteExtras { sample_start: 0.01, ..Default::default() });
            let (mut ol, mut or) = (vec![0f32; n], vec![0f32; n]);
            for k in (0..n).step_by(256) {
                let ctx = ProcessContext { sample_rate: 48000.0, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: 256 };
                a.process(&ctx, [&mut ol[k..k + 256], &mut or[k..k + 256]]);
            }
            (ol, or)
        };
        let plain = render(&[]);
        let set = render(&[(P::Pitch as usize, 7.0), (P::Formant as usize, 0.0), (P::TempoSync as usize, 1.0), (P::SrcBpm as usize, 90.0), (P::Stretch as usize, 2.0)]);
        assert!(plain.0.iter().zip(&set.0).chain(plain.1.iter().zip(&set.1)).all(|(a, b)| a.to_bits() == b.to_bits()));
        assert!(plain.0[1000].abs() > 0.0);
    }
}
