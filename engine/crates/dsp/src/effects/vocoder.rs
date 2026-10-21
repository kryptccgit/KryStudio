//! krypt.vocoder — channel (filterbank) vocoder.
//!
//! The voice (modulator) and the carrier each run through 8–40 log-spaced
//! 4th-order band passes (two cascaded TPT SVF band-pass sections,
//! 0 dB at the centre). An envelope follower on every voice band sets
//! the gain of the matching carrier band. Carrier bands are normalized by
//! the carrier's average band level (so the output follows the voice's
//! level whatever the carrier's), and "Carrier flatten" additionally
//! divides each band by its own slow envelope (spectral whitening, at most
//! +40 dB over the average), so dull or bright carriers still take on the
//! voice's spectrum. The carrier envelopes release slowly (300 ms), so a
//! carrier's own note endings still come through. Formant shift moves the
//! carrier bank against the voice bank. Sibilance passes the voice's
//! content above the top band straight through for consonants.
//!
//! Wave 12.2 additions (all default to the old sound): up to 40 bands, an
//! internal saw + noise carrier, an unvoiced detector (when the voice's
//! energy sits mostly above 3 kHz — s, f, sh, t — the carrier crossfades to
//! noise so consonants stay intelligible over any carrier), and a release
//! tilt (longer release on the low bands for smooth vowels, shorter on the
//! high bands for crisp consonants, or the reverse).
//!
//! Routing: by default the slot's input is the carrier (put it on a synth)
//! and the sidechain is the voice. Either can be swapped, and the carrier
//! can be an internal saw pair or noise. With no sidechain routed, the
//! input is the voice and the internal carrier plays.

use super::{frames, sane_sr, sanitize_block};
use crate::blocks::filters::{Svf, SvfMode};
use crate::blocks::osc::{blep_wave, Shape};
use crate::blocks::{db_to_gain, midi_to_hz, tc_coef, Rng, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Bands => stepped("bands", "Bands", 8.0, 40.0, 16.0, "", 4.0, "Vocoder"),
    Voice => choice("voice", "Voice (modulator)", &["Sidechain", "Input"], 0, "Routing"),
    Carrier => choice("carrier", "Carrier", &["Input", "Sidechain", "Internal saw", "Internal noise", "Internal saw + noise"], 0, "Routing"),
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
    // wave 12.2 (appended; the defaults keep the old sound)
    Unvoiced => lin("unvoiced", "Unvoiced", 0.0, 1.0, 0.0, "%", "Vocoder"),
    CarrierNoise => lin("carrierNoise", "Noise (saw + noise)", 0.0, 1.0, 0.3, "%", "Routing"),
    ReleaseTilt => lin("releaseTilt", "Release tilt", -1.0, 1.0, 0.0, "", "Envelope"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.vocoder",
        name: "Krypt Vocoder",
        kind: PluginKind::Effect,
        category: "Vocal",
        description: "Filterbank vocoder, 8-40 bands. Default: this slot's input is the carrier (synth) and the sidechain \
                      is the voice; swap them, or use the internal saw, noise or saw + noise carrier (Internal pitch, MIDI \
                      note). With no sidechain routed, the input becomes the voice over the internal carrier. Carrier \
                      flatten evens out the carrier; Formant shift moves the carrier bands; Sibilance passes the voice's \
                      top end; Unvoiced swaps in noise on s/f/t sounds; Release tilt makes low bands smoother or snappier.",
        params: param_specs(),
        uses_sample: None,
        sidechain: Some(true),
        default_mix: Some(1.0),
    }
}

const MAX_BANDS: usize = 40;
const CTRL: usize = 16;
/// Whitening never lifts a band more than 1/FLOOR over the average band.
const FLOOR: f32 = 0.01;
const MAX_GAIN: f32 = 1e4;
/// Output calibration: a white-noise voice over a saw carrier comes out
/// about 6 dB under the voice's level (sparser, speech-like voices come
/// out close to their own level).
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
    rel: [f32; MAX_BANDS],
    c_rel: f32,
    unvoiced: f32,
    noise_amt: f32,
    uv_hp: Svf,
    uv_hf: f32,
    uv_all: f32,
    uv_coef: f32,
    uv_gain: Smooth,
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
            rel: [0.01; MAX_BANDS],
            c_rel: tc_coef(300.0, sr),
            unvoiced: 0.0,
            noise_amt: 0.3,
            uv_hp: Svf::default(),
            uv_hf: 0.0,
            uv_all: 0.0,
            uv_coef: tc_coef(10.0, sr),
            uv_gain: Smooth::with_time(0.0, 5.0, sr),
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
        self.carrier = p.idx(P::Carrier as usize).min(4);
        let lo = p.get(P::LowFreq as usize) as f64;
        let hi = (p.get(P::HighFreq as usize) as f64).min(fs * 0.42).max(lo * 2.0);
        let nb = self.bands;
        let ratio = (hi / lo).powf(1.0 / (nb - 1) as f64);
        // octave bandwidth per section: wider than the spacing so the bank overlaps
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
        let rel_ms = p.get(P::Release as usize);
        let tilt = p.get(P::ReleaseTilt as usize);
        for b in 0..MAX_BANDS {
            // tilt 0 → exactly the old single release; ±1 → ×/÷ 4 between the bottom and the top band
            let pos = b.min(nb - 1) as f32 / (nb - 1) as f32 * 2.0 - 1.0;
            let k = if tilt == 0.0 { 1.0 } else { (-2.0 * tilt * pos).exp2() };
            self.rel[b] = tc_coef(rel_ms * k, self.sr);
        }
        self.unvoiced = p.get(P::Unvoiced as usize);
        self.noise_amt = p.get(P::CarrierNoise as usize);
        self.uv_hp.design(SvfMode::Highpass, 3000.0f64.min(fs * 0.4), 0.707, 0.0, fs);
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

    /// Control-rate band gains from the envelopes:
    /// g = m · avg^(f−1) / max(c, FLOOR·avg)^f — at f = 0 every carrier band
    /// is scaled by the average band level, at f = 1 by its own level.
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
        // resolve routing: 0 input, 1 sidechain, 2 saw, 3 noise
        let (voice_from_sc, carrier_src) = match sc {
            Some(_) => (self.voice_sc, self.carrier),
            None => {
                let internal = if self.carrier >= 3 { self.carrier } else { 2 };
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
        let unvoiced = self.unvoiced;
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
                3 => [0.5 * self.rng.bipolar(); 2],
                _ => {
                    let mut v = 0.0f32;
                    for k in 0..2 {
                        v += blep_wave(Shape::Saw, self.saw_ph[k], saw_dt[k]) as f32;
                        self.saw_ph[k] += saw_dt[k];
                        if self.saw_ph[k] >= 1.0 {
                            self.saw_ph[k] -= 1.0;
                        }
                    }
                    let nz = self.noise_amt;
                    [0.35 * v * (1.0 - nz) + 0.5 * nz * self.rng.bipolar(); 2]
                }
            };
            // unvoiced detector: a mostly-HF voice crossfades the carrier to noise
            // (the same noise on both sides, so a mono internal carrier stays mono)
            let car = if unvoiced > 0.0 {
                let hf = self.uv_hp.tick(voice as f64) as f32;
                self.uv_hf += (hf.abs() - self.uv_hf) * self.uv_coef;
                self.uv_all += (voice.abs() - self.uv_all) * self.uv_coef;
                self.uv_hf = crate::blocks::flush(self.uv_hf);
                self.uv_all = crate::blocks::flush(self.uv_all);
                let r = if self.uv_all > 1e-6 { self.uv_hf / self.uv_all } else { 0.0 };
                self.uv_gain.set(((r - 0.35) * 3.0).clamp(0.0, 1.0) * unvoiced);
                let u = self.uv_gain.next();
                if u > 0.0 {
                    let nz = 0.5 * self.rng.bipolar() * u;
                    [car[0] * (1.0 - u) + nz, car[1] * (1.0 - u) + nz]
                } else {
                    car
                }
            } else {
                car
            };
            if self.ctrl == 0 {
                self.refresh_gains();
                self.ctrl = CTRL;
            }
            // linear interpolation of the control-rate gains
            let t = 1.0 - self.ctrl as f32 / CTRL as f32;
            self.ctrl -= 1;
            let mut y = [0.0f32; 2];
            for b in 0..nb {
                let mv = self.mod_bp[b].tick(voice as f64) as f32;
                let lvl = mv.abs();
                let e = &mut self.mod_env[b];
                *e += (lvl - *e) * if lvl > *e { self.att } else { self.rel[b] };
                if *e < 1e-9 {
                    *e = 0.0;
                }
                let g = self.gain_prev[b] + (self.gain[b] - self.gain_prev[b]) * t;
                let c0 = self.car_bp[0][b].tick(car[0] as f64) as f32;
                let c1 = if mono_carrier { c0 } else { self.car_bp[1][b].tick(car[1] as f64) as f32 };
                let ce = &mut self.car_env[b];
                let cl = 0.5 * (c0.abs() + c1.abs());
                // peak follower: instant attack, so |band| / envelope ≤ 1 (no onset spikes)
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
        self.uv_hp.reset();
        self.uv_hf = 0.0;
        self.uv_all = 0.0;
        self.uv_gain.reset(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::vocoder_legacy;

    fn sig(n: usize, seed: u32, f: f32) -> Vec<f32> {
        let mut r = Rng::new(seed);
        (0..n)
            .map(|i| {
                // a voice-ish test signal: a pitched buzz with noise bursts (consonants)
                let t = i as f32 / 48000.0;
                let buzz = (std::f32::consts::TAU * f * t).sin() * 0.4 + (std::f32::consts::TAU * 3.1 * f * t).sin() * 0.15;
                let burst = if (i / 6000) % 3 == 2 { r.bipolar() * 0.3 } else { 0.0 };
                buzz * (0.5 + 0.5 * (t * 3.0).sin()) + burst
            })
            .collect()
    }

    /// Render the same input through the frozen pre-12.2 vocoder and the upgraded one
    /// (old params set, new params left at their defaults) and return the max |difference|.
    fn diff(params: &[(usize, f32)], with_sc: bool) -> (f32, f32) {
        let mut old = vocoder_legacy::Vocoder::new(48000.0, 256);
        let mut new = Vocoder::new(48000.0, 256);
        for &(i, v) in params {
            old.set_param(i, v);
            new.set_param(i, v);
        }
        let n = 48000;
        let (car_l, car_r) = (sig(n, 1, 110.0), sig(n, 2, 165.0));
        let (voc_l, voc_r) = (sig(n, 3, 220.0), sig(n, 4, 220.0));
        let mut a = [car_l.clone(), car_r.clone()];
        let mut b = [car_l, car_r];
        let mut at = 0;
        let mut peak = 0.0f32;
        while at < n {
            let m = (n - at).min(256);
            let ctx = ProcessContext { sample_rate: 48000.0, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: m };
            let sc = if with_sc { Some([&voc_l[at..at + m], &voc_r[at..at + m]]) } else { None };
            let (al, ar) = a.split_at_mut(1);
            old.process(&ctx, [&mut al[0][at..at + m], &mut ar[0][at..at + m]], sc);
            let (bl, br) = b.split_at_mut(1);
            new.process(&ctx, [&mut bl[0][at..at + m], &mut br[0][at..at + m]], sc);
            at += m;
        }
        let mut d = 0.0f32;
        for ch in 0..2 {
            for i in 0..n {
                d = d.max((a[ch][i] - b[ch][i]).abs());
                peak = peak.max(a[ch][i].abs());
            }
        }
        (d, peak)
    }

    #[test]
    fn old_projects_sound_the_same() {
        let configs: &[(&[(usize, f32)], bool)] = &[
            (&[], true),
            (&[], false),
            (&[(P::Carrier as usize, 2.0)], true),
            (&[(P::Carrier as usize, 3.0), (P::Bands as usize, 32.0)], false),
            (&[(P::Voice as usize, 1.0), (P::Carrier as usize, 1.0), (P::Formant as usize, 5.0), (P::Flatten as usize, 0.0)], true),
            (&[(P::Bands as usize, 8.0), (P::Sibilance as usize, 1.0), (P::Release as usize, 300.0), (P::Width as usize, 1.0)], true),
        ];
        for (k, (params, sc)) in configs.iter().enumerate() {
            let (d, peak) = diff(params, *sc);
            assert!(peak > 1e-3, "config {k} is silent");
            // bit-identical in practice; the contract is -90 dB under the signal
            assert!(d <= peak * 3.2e-5, "config {k}: differs by {d} (peak {peak})");
            assert_eq!(d, 0.0, "config {k}: not bit-identical ({d})");
        }
    }

    #[test]
    fn new_carrier_and_unvoiced_and_forty_bands_run() {
        for params in [
            vec![(P::Carrier as usize, 4.0), (P::Bands as usize, 40.0)],
            vec![(P::Unvoiced as usize, 1.0), (P::ReleaseTilt as usize, 1.0)],
            vec![(P::Unvoiced as usize, 1.0), (P::Carrier as usize, 4.0), (P::ReleaseTilt as usize, -1.0)],
        ] {
            let mut v = Vocoder::new(48000.0, 256);
            for (i, x) in params {
                v.set_param(i, x);
            }
            let mut l = sig(24000, 5, 200.0);
            let mut r = l.clone();
            let ctx = ProcessContext { sample_rate: 48000.0, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: 24000 };
            v.process(&ctx, [&mut l, &mut r], None);
            assert!(l.iter().all(|x| x.is_finite()));
            assert!(l.iter().fold(0.0f32, |m, x| m.max(x.abs())) > 1e-3);
        }
        assert_eq!(Vocoder::new(48000.0, 256).bands, 16);
        let mut v = Vocoder::new(48000.0, 256);
        v.set_param(P::Bands as usize, 40.0);
        v.update();
        assert_eq!(v.bands, 40);
    }

    #[test]
    fn unvoiced_lifts_hissy_consonants_over_a_saw() {
        // voice = high-passed noise ("sss"); carrier = internal saw. Unvoiced fills the top bands with noise.
        let level = |unvoiced: f32| {
            let mut v = Vocoder::new(48000.0, 256);
            v.set_param(P::Unvoiced as usize, unvoiced);
            v.set_param(P::Sibilance as usize, 0.0);
            v.set_param(P::CarrierNote as usize, 36.0);
            let mut rng = Rng::new(9);
            let mut prev = 0.0f32;
            let mut l: Vec<f32> = (0..48000)
                .map(|_| {
                    let x = rng.bipolar() * 0.3;
                    let y = x - prev;
                    prev = x;
                    y
                })
                .collect();
            let mut r = l.clone();
            let ctx = ProcessContext { sample_rate: 48000.0, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: 48000 };
            v.process(&ctx, [&mut l, &mut r], None);
            (l[24000..].iter().map(|x| x * x).sum::<f32>() / 24000.0).sqrt()
        };
        let (off, on) = (level(0.0), level(1.0));
        assert!(on > off * 1.3, "unvoiced did not help: {off} → {on}");
    }
}
