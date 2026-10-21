use super::sampler::sanitize_sr;
use super::{instrument_process, NoteStart, OutStage, Voice, VoiceManager, CHOKE_MS};
use crate::blocks::filters::{Svf, SvfMode};
use crate::blocks::{db_to_gain, midi_to_hz, pan_gains, tanh_fast, vel_gain, Glide, Rng, TAU};
use crate::params::{param_table, ParamBank};
use crate::{Instrument, NoteExtras, PluginDescriptor, PluginKind, ProcessContext};

pub const PITCH_OFFSET: f32 = 0.0;

param_table! {
    Tune => lin("tune", "Tune", -24.0, 24.0, 0.0, "st", "808"),
    Decay => logp("decay", "Decay", 20.0, 8000.0, 900.0, "ms", "808"),
    Punch => lin("punch", "Punch (pitch sweep)", 0.0, 48.0, 24.0, "st", "808"),
    PunchDecay => logp("punchDecay", "Punch decay", 1.0, 500.0, 40.0, "ms", "808"),
    Click => lin("click", "Click", 0.0, 1.0, 0.2, "%", "808"),
    Drive => lin("drive", "Drive", 0.0, 1.0, 0.25, "%", "808"),
    Tone => logp("tone", "Tone", 100.0, 20000.0, 6000.0, "Hz", "808"),
    Gain => lin("gain", "Gain", -24.0, 12.0, -3.0, "dB", "808"),
    Gate => choice("gate", "Note length", &["One-shot", "Gate"], 0, "808"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.kick808",
        name: "Krypt 808",
        kind: PluginKind::Instrument,
        category: "Drums",
        description: "Tuned 808 / kick synth: sine body with pitch sweep, click, drive and long decay. Key-tracked at true pitch \
                      (C2 = MIDI 36 = 65.4 Hz): write 808 lines around C1-C3. Overlapping notes glide when the channel is mono \
                      with glide (slide notes always glide). Note length: One-shot rings for Decay; Gate releases at note off.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: None,
    }
}

pub(crate) struct Shared808 {
    tune: f32,
    decay_s: f32,
    punch: f32,
    punch_tau_s: f32,
    click: f32,
    drive_k: f32,
    drive_norm: f32,
    tone_hz: f32,
    gate: bool,
}

pub(crate) struct Voice808 {
    fadein: f32,
    fadein_step: f32,
    active: bool,
    choking: bool,
    releasing: bool,
    fade: f32,
    fade_step: f32,
    rel_coef: f32,
    glide: Glide,
    t: u32,
    ph: f64,
    vel: f32,
    pl: f32,
    pr: f32,
    rng: Rng,
    click_hp: Svf,
    tone_lp: Svf,
    tone_set: f32,
    dc_x: f32,
    dc_y: f32,
    sr: f32,
}

impl Voice808 {
    fn new(sr: f32, seed: u32) -> Self {
        let mut click_hp = Svf::default();
        click_hp.design(SvfMode::Highpass, 2500.0, 0.7, 0.0, sr as f64);
        Self {
            fadein: 1.0,
            fadein_step: 1.0 / (CHOKE_MS * 0.001 * sr),
            active: false,
            choking: false,
            releasing: false,
            fade: 1.0,
            fade_step: 1.0 / (CHOKE_MS * 0.001 * sr),
            rel_coef: (-1.0 / (0.012 * sr)).exp(),
            glide: Glide::default(),
            t: 0,
            ph: 0.0,
            vel: 0.0,
            pl: 1.0,
            pr: 1.0,
            rng: Rng::new(seed),
            click_hp,
            tone_lp: Svf::default(),
            tone_set: -1.0,
            dc_x: 0.0,
            dc_y: 0.0,
            sr,
        }
    }
}

impl Voice for Voice808 {
    type Shared = Shared808;

    fn start(&mut self, _sh: &Shared808, n: &NoteStart, _g: Option<f32>, _gm: f32) {
        self.fadein = if n.xfade { 0.0 } else { 1.0 };
        self.glide.jump(n.pitch);
        self.t = 0;
        self.ph = 0.0;
        self.vel = vel_gain(n.vel);
        (self.pl, self.pr) = pan_gains(n.extras.pan);
        self.click_hp.reset();
        self.tone_lp.reset();
        self.dc_x = 0.0;
        self.dc_y = 0.0;
        self.fade = 1.0;
        self.choking = false;
        self.releasing = false;
        self.active = true;
    }

    fn legato(&mut self, _sh: &Shared808, pitch: f32, glide_ms: f32) {
        self.glide.to(pitch, glide_ms, self.sr);
        self.releasing = false;
        self.fade = 1.0;
    }

    fn release(&mut self, sh: &Shared808) {
        if sh.gate {
            self.releasing = true;
        }
    }

    fn choke(&mut self) {
        self.choking = true;
    }

    fn kill(&mut self) {
        self.active = false;
        self.choking = false;
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

    fn render(&mut self, sh: &Shared808, l: &mut [f32], r: &mut [f32]) {
        if self.tone_set != sh.tone_hz {
            self.tone_lp.design(SvfMode::Lowpass, sh.tone_hz.min(0.45 * self.sr) as f64, 0.7, 0.0, self.sr as f64);
            self.tone_set = sh.tone_hz;
        }
        let inv_sr = 1.0 / self.sr;
        let mut f0 = midi_to_hz(self.glide.cur + PITCH_OFFSET + sh.tune);
        let r_dc = 1.0 - TAU * 5.0 / self.sr;
        for i in 0..l.len() {
            if self.glide.gliding() {
                f0 = midi_to_hz(self.glide.next() + PITCH_OFFSET + sh.tune);
            }
            let t = self.t as f32 * inv_sr;
            let u = t / sh.decay_s;
            if u >= 1.0 {
                self.kill();
                return;
            }
            let pe = (-t / sh.punch_tau_s).exp();
            let f = f0 * (sh.punch * pe * (1.0 / 12.0)).exp2();
            let body = (self.ph * std::f64::consts::TAU).sin() as f32;
            self.ph += (f * inv_sr) as f64;
            if self.ph >= 1.0 {
                self.ph -= 1.0;
            }
            let amp = ((-6.9 * (0.3 * u + 0.7 * u * u)).exp() - 0.001 * u) * (1.0 / 0.999);
            let mut x = body * amp;
            if sh.click > 0.0 && t < 0.02 {
                let ms = t * 1000.0;
                let n = self.click_hp.tick(self.rng.bipolar() as f64) as f32;
                let tick = (TAU * 1400.0 * t).sin() * (-ms / 1.2).exp();
                x += sh.click * (0.6 * n * (-ms / 0.6).exp() + 0.45 * tick);
            }
            let y = tanh_fast(sh.drive_k * x) * sh.drive_norm;
            let y = self.tone_lp.tick(y as f64) as f32;
            let d = y - self.dc_x + r_dc * self.dc_y;
            self.dc_x = y;
            self.dc_y = crate::blocks::flush(d);
            let mut g = self.vel * 0.9;
            if self.fadein < 1.0 {
                self.fadein = (self.fadein + self.fadein_step).min(1.0);
                g *= self.fadein;
            }
            if self.releasing {
                self.fade *= self.rel_coef;
                if self.fade < 1e-4 {
                    self.kill();
                    return;
                }
                g *= self.fade;
            }
            if self.choking {
                self.fade -= self.fade_step;
                if self.fade <= 0.0 {
                    self.kill();
                    return;
                }
                g *= self.fade;
            }
            l[i] += d * g * self.pl;
            r[i] += d * g * self.pr;
            self.t += 1;
        }
    }
}

pub struct Kick808 {
    pb: ParamBank<N_PARAMS>,
    shared: Shared808,
    vm: VoiceManager<Voice808>,
    out: OutStage,
}

impl Kick808 {
    pub fn new(sample_rate: f32, max_frames: usize) -> Self {
        let sr = sanitize_sr(sample_rate);
        let mut seed = 5u32;
        let mut s = Self {
            pb: ParamBank::new(&param_specs()),
            shared: Shared808 {
                tune: 0.0,
                decay_s: 0.9,
                punch: 24.0,
                punch_tau_s: 0.013,
                click: 0.2,
                drive_k: 1.0,
                drive_norm: 1.0,
                tone_hz: 6000.0,
                gate: false,
            },
            vm: VoiceManager::new(8, || {
                seed += 17;
                Voice808::new(sr, seed)
            }),
            out: OutStage::new(max_frames, sr),
        };
        s.update();
        s.out.gain.reset(s.out.gain.target);
        s
    }

    fn update(&mut self) {
        let p = &self.pb;
        let sh = &mut self.shared;
        sh.tune = p.get(P::Tune as usize);
        sh.decay_s = p.get(P::Decay as usize) * 0.001;
        sh.punch = p.get(P::Punch as usize);
        sh.punch_tau_s = p.get(P::PunchDecay as usize) * 0.001 / 3.0;
        sh.click = p.get(P::Click as usize);
        let k = 1.0 + p.get(P::Drive as usize) * 7.0;
        sh.drive_k = k;
        sh.drive_norm = 1.0 / k.tanh();
        sh.tone_hz = p.get(P::Tone as usize);
        sh.gate = p.idx(P::Gate as usize) == 1;
        self.out.gain.set(db_to_gain(p.get(P::Gain as usize)));
    }

    pub fn render_note(sr: f32, pitch: f32, params: &[(usize, f32)], seconds: f32) -> Vec<f32> {
        let mut k = Kick808::new(sr, 512);
        for &(i, v) in params {
            k.set_param(i, v);
        }
        let n = (seconds * sr) as usize;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        k.note_on(0, 60, pitch, 1.0, NoteExtras::default());
        let mut at = 0;
        while at < n {
            let m = (n - at).min(512);
            let ctx = ProcessContext { sample_rate: sr, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: m };
            let (lo, ro) = (&mut l[at..at + m], &mut r[at..at + m]);
            k.process(&ctx, [lo, ro]);
            at += m;
        }
        l
    }
}

pub(crate) fn param_index(id: &str) -> Option<usize> {
    param_specs().iter().position(|p| p.id == id)
}

impl Instrument for Kick808 {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let sr = sanitize_sr(sample_rate);
        self.vm.all_off();
        let mut seed = 5u32;
        for v in self.vm.voices.iter_mut() {
            seed += 17;
            *v = Voice808::new(sr, seed);
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
