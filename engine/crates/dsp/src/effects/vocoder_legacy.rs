#![allow(dead_code)]

use super::{frames, sane_sr, sanitize_block};
use crate::blocks::filters::{Svf, SvfMode};
use crate::blocks::osc::{blep_wave, Shape};
use crate::blocks::{db_to_gain, midi_to_hz, tc_coef, Rng, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Bands => stepped("bands", "Bands", 8.0, 32.0, 16.0, "", 4.0, "Vocoder"),
    Voice => choice("voice", "Voice (modulator)", &["Sidechain", "Input"], 0, "Routing"),
    Carrier => choice("carrier", "Carrier", &["Input", "Sidechain", "Internal saw", "Internal noise"], 0, "Routing"),
    CarrierNote => stepped("carrierNote", "Internal pitch", 24.0, 84.0, 48.0, "", 1.0, "Routing"),
    LowFreq => logp("lowFreq", "Lowest band", 50.0, 500.0, 100.0, "Hz", "Vocoder"),
    HighFreq => logp("highFreq", "Highest band", 2000.0, 16000.0, 8000.0, "Hz", "Vocoder"),
    Width => lin("width", "Band width", 0.0, 1.0, 0.5, "%", "Vocoder"),
    Formant => lin("formant", "Formant shift", -12.0, 12.0, 0.0, "st", "Vocoder"),
    Flatten => lin("flatten", "Carrier flatten", 0.0, 1.0, 0.7, "%", "Vocoder"),
    Sibilance => lin("sibilance", "Sibilance", 0.0, 1.0, 0.3, "%", "Vocoder"),
    Attack => logp("attack", "Attack", 0.5, 100.0, 4.0, "ms", "Envelope"),
    Release => logp("release", "Release", 5.0, 500.0, 60.0, "ms", "Envelope"),
    Output => lin("output", "Output", -24.0, 24.0, 0.0, "dB", "Output"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.vocoder",
        name: "Krypt Vocoder",
        kind: PluginKind::Effect,
        category: "Vocal",
        description: "Filterbank vocoder, 8-32 bands. Default: this slot's input is the carrier (synth) and the sidechain \
                      is the voice; swap them, or use the internal saw (Internal pitch, MIDI note) or noise carrier. With \
                      no sidechain routed, the input becomes the voice over the internal carrier. Carrier flatten evens \
                      out the carrier's spectrum; Formant shift moves the carrier bands; Sibilance passes the voice's top \
                      end for consonants.",
        params: param_specs(),
        uses_sample: None,
        sidechain: Some(true),
        default_mix: Some(1.0),
    }
}

const MAX_BANDS: usize = 32;
const CTRL: usize = 16;
const FLOOR: f32 = 0.01;
const MAX_GAIN: f32 = 1e4;
const TRIM: f32 = 2.0;

#[derive(Clone, Copy, Default)]
struct BandPass {
    a: Svf,
    b: Svf,
}

impl BandPass {
    fn design(&mut self, fc: f64, q: f64, fs: f64) {
        self.a.design(SvfMode::Bandpass, fc, q, 0.0, fs);
        self.b.design(SvfMode::Bandpass, fc, q, 0.0, fs);
    }
    #[inline]
    fn tick(&mut self, x: f64) -> f64 {
        self.b.tick(self.a.tick(x))
    }
    fn reset(&mut self) {
        self.a.reset();
        self.b.reset();
    }
}

pub struct Vocoder {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    sr: f32,
    bands: usize,
    voice_sc: bool,
    carrier: usize,
    mod_bp: [BandPass; MAX_BANDS],
    car_bp: [[BandPass; MAX_BANDS]; 2],
    mod_env: [f32; MAX_BANDS],
    car_env: [f32; MAX_BANDS],
    gain: [f32; MAX_BANDS],
    gain_prev: [f32; MAX_BANDS],
    att: f32,
    rel: f32,
    c_rel: f32,
    flatten: f32,
    sib_hp: [Svf; 2],
    sib: Smooth,
    out: Smooth,
    ctrl: usize,
    saw_ph: [f64; 2],
    saw_inc: [f64; 2],
    rng: Rng,
}

impl Vocoder {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let mut v = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            bands: 16,
            voice_sc: true,
            carrier: 0,
            mod_bp: [BandPass::default(); MAX_BANDS],
            car_bp: [[BandPass::default(); MAX_BANDS]; 2],
            mod_env: [0.0; MAX_BANDS],
            car_env: [0.0; MAX_BANDS],
            gain: [0.0; MAX_BANDS],
            gain_prev: [0.0; MAX_BANDS],
            att: 0.1,
            rel: 0.01,
            c_rel: tc_coef(300.0, sr),
            flatten: 0.7,
            sib_hp: [Svf::default(); 2],
            sib: Smooth::with_time(0.3, 20.0, sr),
            out: Smooth::with_time(1.0, 20.0, sr),
            ctrl: 0,
            saw_ph: [0.0, 0.37],
            saw_inc: [0.0; 2],
            rng: Rng::new(0x5EED),
        };
        v.update();
        v.sib.reset(v.sib.target);
        v.out.reset(v.out.target);
        v
    }

    fn update(&mut self) {
        let p = &self.pb;
        let fs = self.sr as f64;
        self.bands = ((p.get(P::Bands as usize).round() as usize) / 4 * 4).clamp(8, MAX_BANDS);
        self.voice_sc = p.idx(P::Voice as usize) == 0;
        self.carrier = p.idx(P::Carrier as usize).min(3);
        let lo = p.get(P::LowFreq as usize) as f64;
        let hi = (p.get(P::HighFreq as usize) as f64).min(fs * 0.42).max(lo * 2.0);
        let nb = self.bands;
        let ratio = (hi / lo).powf(1.0 / (nb - 1) as f64);
        let bw = ratio.log2() * (0.7 + 1.3 * p.get(P::Width as usize) as f64);
        let q = (2f64.powf(bw)).sqrt() / (2f64.powf(bw) - 1.0);
        let shift = 2f64.powf(p.get(P::Formant as usize) as f64 / 12.0);
        for b in 0..nb {
            let f = lo * ratio.powi(b as i32);
            self.mod_bp[b].design(f, q, fs);
            let fc = (f * shift).clamp(20.0, fs * 0.45);
            for ch in 0..2 {
                self.car_bp[ch][b].design(fc, q, fs);
            }
        }
        for s in self.sib_hp.iter_mut() {
            s.design(SvfMode::Highpass, hi.min(fs * 0.45), 0.707, 0.0, fs);
        }
        self.att = tc_coef(p.get(P::Attack as usize), self.sr);
        self.rel = tc_coef(p.get(P::Release as usize), self.sr);
        self.flatten = p.get(P::Flatten as usize);
        self.sib.set(p.get(P::Sibilance as usize));
        self.out.set(db_to_gain(p.get(P::Output as usize)) * TRIM);
        let f0 = midi_to_hz(p.get(P::CarrierNote as usize)) as f64;
        self.saw_inc = [f0 * 2f64.powf(-6.0 / 1200.0) / fs, f0 * 2f64.powf(6.0 / 1200.0) / fs];
    }

    fn snap(&mut self) {
        self.sib.reset(self.sib.target);
        self.out.reset(self.out.target);
    }

    fn refresh_gains(&mut self) {
        let f = self.flatten;
        let nb = self.bands;
        let avg = self.car_env[..nb].iter().sum::<f32>() / nb as f32;
        for b in 0..nb {
            self.gain_prev[b] = self.gain[b];
            let m = self.mod_env[b];
            let g = if m <= 0.0 || avg < 1e-7 {
                0.0
            } else if f <= 0.0 {
                m / avg
            } else {
                let c = self.car_env[b].max(FLOOR * avg);
                m * avg.powf(f - 1.0) / c.powf(f)
            };
            self.gain[b] = g.min(MAX_GAIN);
        }
    }
}

impl Effect for Vocoder {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Vocoder::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        self.snap();
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn process(&mut self, ctx: &ProcessContext, mut buf: [&mut [f32]; 2], sidechain: Option<[&[f32]; 2]>) {
        let n = frames(ctx, &buf);
        if self.pb.take_dirty() {
            self.update();
        }
        if self.fresh {
            self.fresh = false;
            self.snap();
        }
        let sc = sidechain.filter(|s| s[0].len() >= n && s[1].len() >= n);
        let (voice_from_sc, carrier_src) = match sc {
            Some(_) => (self.voice_sc, self.carrier),
            None => {
                let internal = if self.carrier == 3 { 3 } else { 2 };
                if self.voice_sc || self.carrier == 1 {
                    (false, internal)
                } else {
                    (false, self.carrier)
                }
            }
        };
        let mono_carrier = carrier_src >= 2;
        let nb = self.bands;
        let saw_dt = [self.saw_inc[0], self.saw_inc[1]];
        for i in 0..n {
            let (il, ir) = (crate::blocks::finite(buf[0][i]), crate::blocks::finite(buf[1][i]));
            let (sl, sr) = match sc {
                Some(s) => (crate::blocks::finite(s[0][i]), crate::blocks::finite(s[1][i])),
                None => (0.0, 0.0),
            };
            let voice = if voice_from_sc { 0.5 * (sl + sr) } else { 0.5 * (il + ir) };
            let car = match carrier_src {
                0 => [il, ir],
                1 => [sl, sr],
                2 => {
                    let mut v = 0.0f32;
                    for k in 0..2 {
                        v += blep_wave(Shape::Saw, self.saw_ph[k], saw_dt[k]) as f32;
                        self.saw_ph[k] += saw_dt[k];
                        if self.saw_ph[k] >= 1.0 {
                            self.saw_ph[k] -= 1.0;
                        }
                    }
                    [0.35 * v; 2]
                }
                _ => [0.5 * self.rng.bipolar(); 2],
            };
            if self.ctrl == 0 {
                self.refresh_gains();
                self.ctrl = CTRL;
            }
            let t = 1.0 - self.ctrl as f32 / CTRL as f32;
            self.ctrl -= 1;
            let mut y = [0.0f32; 2];
            for b in 0..nb {
                let mv = self.mod_bp[b].tick(voice as f64) as f32;
                let lvl = mv.abs();
                let e = &mut self.mod_env[b];
                *e += (lvl - *e) * if lvl > *e { self.att } else { self.rel };
                if *e < 1e-9 {
                    *e = 0.0;
                }
                let g = self.gain_prev[b] + (self.gain[b] - self.gain_prev[b]) * t;
                let c0 = self.car_bp[0][b].tick(car[0] as f64) as f32;
                let c1 = if mono_carrier { c0 } else { self.car_bp[1][b].tick(car[1] as f64) as f32 };
                let ce = &mut self.car_env[b];
                let cl = 0.5 * (c0.abs() + c1.abs());
                *ce = if cl > *ce { cl } else { *ce + (cl - *ce) * self.c_rel };
                if *ce < 1e-9 {
                    *ce = 0.0;
                }
                y[0] += c0 * g;
                y[1] += c1 * g;
            }
            let sib = self.sib.next();
            let o = self.out.next();
            for ch in 0..2 {
                let hp = self.sib_hp[ch].tick(voice as f64) as f32;
                buf[ch][i] = (y[ch] + hp * sib) * o;
            }
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.mod_bp.iter_mut().for_each(BandPass::reset);
        for ch in self.car_bp.iter_mut() {
            ch.iter_mut().for_each(BandPass::reset);
        }
        self.mod_env = [0.0; MAX_BANDS];
        self.car_env = [0.0; MAX_BANDS];
        self.gain = [0.0; MAX_BANDS];
        self.gain_prev = [0.0; MAX_BANDS];
        self.sib_hp.iter_mut().for_each(Svf::reset);
        self.ctrl = 0;
    }
}
