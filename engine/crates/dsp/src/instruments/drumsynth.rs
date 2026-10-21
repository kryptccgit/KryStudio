use super::drums::{DrumHit, DrumKind, DrumParams};
use super::sampler::sanitize_sr;
use super::{instrument_process, NoteStart, OutStage, Voice, VoiceManager, CHOKE_MS};
use crate::blocks::{db_to_gain, pan_gains, vel_gain};
use crate::params::{param_table, ParamBank};
use crate::{Instrument, NoteExtras, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    VoiceSel => choice("voice", "Voice",
        &["Kick", "Snare", "Clap", "Closed hat", "Open hat", "Tom", "Rim", "Cowbell", "Crash", "Perc"], 0, "Drum"),
    Tune => lin("tune", "Tune", -24.0, 24.0, 0.0, "st", "Drum"),
    Decay => logp("decay", "Decay", 5.0, 4000.0, 250.0, "ms", "Drum"),
    Tone => lin("tone", "Tone", 0.0, 1.0, 0.5, "%", "Drum"),
    Snap => lin("snap", "Snap / noise", 0.0, 1.0, 0.5, "%", "Drum"),
    Drive => lin("drive", "Drive", 0.0, 1.0, 0.1, "%", "Drum"),
    Gain => lin("gain", "Gain", -24.0, 12.0, -3.0, "dB", "Drum"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.drumsynth",
        name: "Krypt DrumSynth",
        kind: PluginKind::Instrument,
        category: "Drums",
        description: "Synthesized drum voice (kick, snare, clap, closed/open hat, tom, rim, cowbell, crash, perc) with tune, \
                      decay, tone, snap and drive. One-shot; keys transpose relative to C4 (MIDI 60). Decay is scaled per \
                      voice (hats shorter, open hat/crash longer) so 250 ms suits every voice. No samples needed.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: None,
    }
}

pub(crate) struct DrumShared {
    kind: DrumKind,
    p: DrumParams,
}

pub(crate) struct DrumVoice {
    fadein: f32,
    fadein_step: f32,
    hit: DrumHit,
    vel: f32,
    pl: f32,
    pr: f32,
    fade: f32,
    fade_step: f32,
    choking: bool,
    active: bool,
    pitch: f32,
    seed: u32,
}

impl Voice for DrumVoice {
    type Shared = DrumShared;

    fn start(&mut self, sh: &DrumShared, n: &NoteStart, _g: Option<f32>, _gm: f32) {
        let mut p = sh.p;
        p.tune += n.pitch - 60.0;
        self.seed = self.seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        self.hit.trigger(sh.kind, p, self.seed);
        self.fadein = if n.xfade { 0.0 } else { 1.0 };
        self.vel = vel_gain(n.vel);
        (self.pl, self.pr) = pan_gains(n.extras.pan);
        self.fade = 1.0;
        self.choking = false;
        self.active = true;
        self.pitch = n.pitch;
    }

    fn legato(&mut self, _sh: &DrumShared, pitch: f32, _glide_ms: f32) {
        self.pitch = pitch;
    }

    fn release(&mut self, _sh: &DrumShared) {}

    fn choke(&mut self) {
        self.choking = true;
    }

    fn kill(&mut self) {
        self.active = false;
        self.choking = false;
        self.hit.done = true;
    }

    fn active(&self) -> bool {
        self.active
    }

    fn choking(&self) -> bool {
        self.choking
    }

    fn pitch(&self) -> f32 {
        self.pitch
    }

    fn render(&mut self, _sh: &DrumShared, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let mut x = self.hit.next() * self.vel;
            if self.fadein < 1.0 {
                self.fadein = (self.fadein + self.fadein_step).min(1.0);
                x *= self.fadein;
            }
            if self.choking {
                self.fade -= self.fade_step;
                if self.fade <= 0.0 {
                    self.kill();
                    return;
                }
                x *= self.fade;
            }
            l[i] += x * self.pl;
            r[i] += x * self.pr;
            if self.hit.done {
                self.kill();
                return;
            }
        }
    }
}

pub struct DrumSynth {
    pb: ParamBank<N_PARAMS>,
    shared: DrumShared,
    vm: VoiceManager<DrumVoice>,
    out: OutStage,
}

fn make_voice(sr: f32, seed: u32) -> DrumVoice {
    DrumVoice {
        fadein: 1.0,
        fadein_step: 1.0 / (CHOKE_MS * 0.001 * sr),
        hit: DrumHit::new(sr),
        vel: 0.0,
        pl: 1.0,
        pr: 1.0,
        fade: 1.0,
        fade_step: 1.0 / (CHOKE_MS * 0.001 * sr),
        choking: false,
        active: false,
        pitch: 60.0,
        seed,
    }
}

impl DrumSynth {
    pub fn new(sample_rate: f32, max_frames: usize) -> Self {
        let sr = sanitize_sr(sample_rate);
        let mut seed = 99u32;
        let mut s = Self {
            pb: ParamBank::new(&param_specs()),
            shared: DrumShared { kind: DrumKind::Kick, p: DrumParams::default() },
            vm: VoiceManager::new(8, || {
                seed += 31;
                make_voice(sr, seed)
            }),
            out: OutStage::new(max_frames, sr),
        };
        s.update();
        s.out.gain.reset(s.out.gain.target);
        s
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.shared.kind = DrumKind::from_index(p.idx(P::VoiceSel as usize));
        self.shared.p = DrumParams {
            tune: p.get(P::Tune as usize),
            decay_ms: p.get(P::Decay as usize),
            tone: p.get(P::Tone as usize),
            snap: p.get(P::Snap as usize),
            drive: p.get(P::Drive as usize),
        };
        self.out.gain.set(db_to_gain(p.get(P::Gain as usize)));
    }
}

impl Instrument for DrumSynth {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let sr = sanitize_sr(sample_rate);
        self.vm.all_off();
        let mut seed = 99u32;
        for v in self.vm.voices.iter_mut() {
            seed += 31;
            *v = make_voice(sr, seed);
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
