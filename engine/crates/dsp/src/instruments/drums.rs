//! Synthesized drum models (Krypt-original), used by krypt.drumsynth in real
//! time and by the factory kit generator offline.
//!
//! Recipes follow well-known analog drum-machine topologies (sine body with
//! pitch sweep, multi-burst clap, six-square metallic hats, bridged-T style
//! damped resonances for rim/tom) — implemented from scratch.

use crate::blocks::filters::{Svf, SvfMode};
use crate::blocks::osc::{blep_wave, Shape};
use crate::blocks::{tanh_fast, Rng, TAU};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrumKind {
    Kick,
    Snare,
    Clap,
    ClosedHat,
    OpenHat,
    Tom,
    Rim,
    Cowbell,
    Crash,
    Perc,
}

impl DrumKind {
    pub fn from_index(i: usize) -> Self {
        match i {
            0 => DrumKind::Kick,
            1 => DrumKind::Snare,
            2 => DrumKind::Clap,
            3 => DrumKind::ClosedHat,
            4 => DrumKind::OpenHat,
            5 => DrumKind::Tom,
            6 => DrumKind::Rim,
            7 => DrumKind::Cowbell,
            8 => DrumKind::Crash,
            _ => DrumKind::Perc,
        }
    }

    /// The `decay` knob is scaled per voice so every voice sounds right at
    /// the shared default (250 ms): hats short, open hat/crash long.
    pub fn decay_scale(self) -> f32 {
        match self {
            DrumKind::Kick => 1.4,
            DrumKind::Snare => 1.0,
            DrumKind::Clap => 1.0,
            DrumKind::ClosedHat => 0.24,
            DrumKind::OpenHat => 1.6,
            DrumKind::Tom => 1.4,
            DrumKind::Rim => 0.25,
            DrumKind::Cowbell => 1.0,
            DrumKind::Crash => 6.0,
            DrumKind::Perc => 0.45,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct DrumParams {
    /// Semitones (includes key tracking).
    pub tune: f32,
    pub decay_ms: f32,
    pub tone: f32,
    pub snap: f32,
    pub drive: f32,
}

impl Default for DrumParams {
    fn default() -> Self {
        Self { tune: 0.0, decay_ms: 250.0, tone: 0.5, snap: 0.5, drive: 0.1 }
    }
}

const HAT_FREQS: [f32; 6] = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
const CRASH_FREQS: [f32; 6] = [263.0, 401.0, 541.0, 627.0, 773.0, 911.0];

/// One sounding drum hit.
#[derive(Clone, Debug)]
pub struct DrumHit {
    pub kind: DrumKind,
    p: DrumParams,
    sr: f32,
    t: u32,
    len: u32,
    rng: Rng,
    ph: [f64; 6],
    f: [f32; 6],
    flt: [Svf; 4],
    burst: [f32; 4],
    drive_k: f32,
    drive_norm: f32,
    dc_x: f32,
    dc_y: f32,
    pub done: bool,
}

impl DrumHit {
    pub fn new(sr: f32) -> Self {
        Self {
            kind: DrumKind::Kick,
            p: DrumParams::default(),
            sr,
            t: 0,
            len: 0,
            rng: Rng::new(1),
            ph: [0.0; 6],
            f: [0.0; 6],
            flt: [Svf::default(); 4],
            burst: [0.0; 4],
            drive_k: 1.0,
            drive_norm: 1.0,
            dc_x: 0.0,
            dc_y: 0.0,
            done: true,
        }
    }

    pub fn trigger(&mut self, kind: DrumKind, p: DrumParams, seed: u32) {
        let sr = self.sr as f64;
        self.kind = kind;
        let mut p = p;
        p.tone = p.tone.clamp(0.0, 1.0);
        p.snap = p.snap.clamp(0.0, 1.0);
        p.drive = p.drive.clamp(0.0, 1.0);
        p.tune = p.tune.clamp(-48.0, 48.0);
        p.decay_ms = (p.decay_ms * kind.decay_scale()).clamp(3.0, 30_000.0);
        self.p = p;
        self.t = 0;
        self.rng = Rng::new(seed);
        self.ph = [0.0; 6];
        self.flt = [Svf::default(); 4];
        self.dc_x = 0.0;
        self.dc_y = 0.0;
        self.done = false;
        let tr = (p.tune / 12.0).exp2();
        // total length: decay (to -60 dB) + margin
        let tail_ms = match kind {
            DrumKind::Clap => p.decay_ms * 1.5 + 30.0,
            DrumKind::Snare => p.decay_ms * 1.45,
            DrumKind::Crash => p.decay_ms * 1.1,
            _ => p.decay_ms,
        };
        self.len = ((tail_ms + 5.0) * 0.001 * self.sr) as u32;
        // drive: tanh(k x)/tanh(k), peak-preserving
        let dk = match kind {
            DrumKind::Rim => 1.5 + p.drive * 6.0,
            _ => 1.0 + p.drive * 5.0,
        };
        self.drive_k = dk;
        self.drive_norm = 1.0 / dk.tanh();
        let tone = p.tone as f64;
        match kind {
            DrumKind::Kick => {
                // beater click: band-passed noise around 3-5 kHz (tone moves it)
                self.flt[0].design(SvfMode::Bandpass, (3000.0 * (2f64).powf(tone * 1.2)).min(sr * 0.4), 0.8, 0.0, sr);
                self.flt[1].design(SvfMode::Lowpass, (9000.0 * (2f64).powf(tone)).min(sr * 0.45), 0.7, 0.0, sr);
            }
            DrumKind::Tom | DrumKind::Perc => {
                // click/noise path filter
                self.flt[0].design(SvfMode::Highpass, 1500.0 + 2500.0 * tone, 0.7, 0.0, sr);
                self.flt[1].design(SvfMode::Lowpass, 3000.0 * (2f64).powf(tone * 2.5), 0.7, 0.0, sr);
            }
            DrumKind::Snare => {
                self.f[0] = 180.0 * tr;
                self.f[1] = 180.0 * tr * 1.78;
                self.flt[0].design(SvfMode::Highpass, 650.0, 0.7, 0.0, sr);
                self.flt[1].design(SvfMode::Lowpass, (6500.0 * (2f64).powf(tone * 1.3)).min(sr * 0.45), 0.6, 0.0, sr);
                self.flt[2].design(SvfMode::Bell, 1800.0 * (2f64).powf(tone - 0.5), 0.9, 3.0, sr);
                self.flt[3].design(SvfMode::Bandpass, 2600.0 * (2f64).powf(tone - 0.5), 0.9, 0.0, sr);
            }
            DrumKind::Clap => {
                let fc = 1150.0 * (2f64).powf((tone - 0.5) * 1.5) * tr as f64;
                self.flt[0].design(SvfMode::Bandpass, fc, 1.4, 0.0, sr);
                self.flt[1].design(SvfMode::Highpass, 480.0, 0.7, 0.0, sr);
                self.flt[2].design(SvfMode::Highpass, 3000.0, 0.7, 0.0, sr);
                // burst times (ms) with a little human jitter
                for (i, b) in self.burst.iter_mut().enumerate() {
                    let base = [0.0, 8.5, 17.5, 27.0][i];
                    *b = (base + if i == 0 { 0.0 } else { self.rng.bipolar() * 1.1 }) * 0.001 * self.sr;
                }
            }
            DrumKind::ClosedHat | DrumKind::OpenHat => {
                for i in 0..6 {
                    self.f[i] = HAT_FREQS[i] * tr * (1.0 + 0.35 * p.tone);
                    self.ph[i] = self.rng.unit() as f64;
                }
                let bp = (8000.0 + 4000.0 * tone) * (tr as f64).sqrt();
                self.flt[0].design(SvfMode::Bandpass, bp.min(sr * 0.45), 0.9, 0.0, sr);
                self.flt[1].design(SvfMode::Highpass, 6500.0 * (tr as f64).sqrt(), 0.7, 0.0, sr);
                self.flt[2].design(SvfMode::Highpass, (7500.0 + 2000.0 * tone).min(sr * 0.45), 0.7, 0.0, sr);
                self.flt[3].design(SvfMode::Lowpass, (15000.0 + 4000.0 * tone).min(sr * 0.46), 0.7, 0.0, sr);
            }
            DrumKind::Crash => {
                for i in 0..6 {
                    self.f[i] = CRASH_FREQS[i] * tr * (1.0 + 0.02 * self.rng.bipolar());
                    self.ph[i] = self.rng.unit() as f64;
                }
                self.flt[0].design(SvfMode::Highpass, 4200.0 * (tr as f64).sqrt(), 0.7, 0.0, sr);
                self.flt[1].design(SvfMode::Bell, 9000.0, 0.8, 4.0 + 2.0 * tone, sr);
                self.flt[2].design(SvfMode::Lowpass, 16000.0f64.min(sr * 0.46), 0.7, 0.0, sr);
                self.flt[3].design(SvfMode::Highpass, 2500.0, 0.7, 0.0, sr);
            }
            DrumKind::Rim => {
                self.f[0] = 1720.0 * tr;
                self.f[1] = 470.0 * tr;
                self.flt[0].design(SvfMode::Highpass, 2500.0, 0.7, 0.0, sr);
                self.flt[1].design(SvfMode::Bandpass, 1700.0 * tr as f64, 2.0, 0.0, sr);
            }
            DrumKind::Cowbell => {
                self.f[0] = 540.0 * tr;
                self.f[1] = 800.0 * tr;
                let bp = 2640.0 * (2f64).powf(tone - 0.5) * tr as f64;
                self.flt[0].design(SvfMode::Bandpass, bp.min(sr * 0.4), 1.3, 0.0, sr);
                self.flt[1].design(SvfMode::Lowpass, 7000.0f64.min(sr * 0.45), 0.7, 0.0, sr);
                self.flt[2].design(SvfMode::Highpass, 300.0, 0.7, 0.0, sr);
            }
        }
        if matches!(kind, DrumKind::Kick) {
            self.f[0] = 50.0 * tr;
        }
        if matches!(kind, DrumKind::Tom) {
            self.f[0] = 118.0 * tr;
        }
        if matches!(kind, DrumKind::Perc) {
            self.f[0] = 690.0 * tr;
        }
    }

    #[inline]
    fn drive(&self, x: f32) -> f32 {
        tanh_fast(self.drive_k * x) * self.drive_norm
    }

    #[inline]
    fn sine(&mut self, i: usize, hz: f32) -> f32 {
        let v = (self.ph[i] * std::f64::consts::TAU).sin() as f32;
        self.ph[i] += hz as f64 / self.sr as f64;
        if self.ph[i] >= 1.0 {
            self.ph[i] -= 1.0;
        }
        v
    }

    #[inline]
    fn square(&mut self, i: usize, hz: f32) -> f32 {
        let dt = (hz / self.sr) as f64;
        let v = blep_wave(Shape::Square, self.ph[i], dt.min(0.5)) as f32;
        self.ph[i] += dt;
        if self.ph[i] >= 1.0 {
            self.ph[i] -= 1.0;
        }
        v
    }

    /// Next mono sample. Sets `done` when finished.
    #[inline]
    pub fn next(&mut self) -> f32 {
        if self.done {
            return 0.0;
        }
        let t = self.t as f32 / self.sr; // seconds
        let ms = t * 1000.0;
        let p = self.p;
        let u = (ms / p.decay_ms).min(1.0);
        let y = match self.kind {
            DrumKind::Kick => {
                let f_end = self.f[0];
                let a1 = 3.5 + 4.0 * p.tone;
                let f = f_end * (1.0 + a1 * (-ms / 3.5).exp() + 1.2 * (-ms / 28.0).exp());
                let body = self.sine(0, f);
                // body envelope: holds, then falls to -60 dB at `decay`
                let amp = (-6.9 * (0.25 * u + 0.75 * u * u)).exp();
                // transient: band-passed noise "beater" + a short knock tick
                let n = self.rng.bipolar();
                let nb = self.flt[0].tick(n as f64) as f32;
                let att = (ms / 0.15).min(1.0);
                let click_env = att * (-ms / 2.5).exp();
                let tick = (TAU * 1100.0 * t).sin() * (-ms / 3.0).exp();
                let click = (nb * 1.6 * click_env + tick * 0.3) * p.snap;
                let click = self.flt[1].tick(click as f64) as f32;
                self.drive(body * amp * 0.92 + click)
            }
            DrumKind::Snare => {
                let bend = 1.0 + 0.5 * (-ms / 6.0).exp();
                let b1 = self.sine(0, self.f[0] * bend);
                let b2 = self.sine(1, self.f[1] * bend);
                let body_env = (-ms / (28.0 + 36.0 * (1.0 - p.tone))).exp();
                let body = (b1 * 0.75 + b2 * 0.45) * body_env * (1.0 - 0.35 * p.snap);
                let n = self.rng.bipolar();
                let nf = self.flt[0].tick(n as f64);
                let nf = self.flt[1].tick(nf);
                let nf = self.flt[2].tick(nf) as f32;
                let att = (ms / 0.6).min(1.0);
                let n_env = att * (-ms * 4.8 / p.decay_ms).exp();
                let noise = nf * n_env * (0.55 + 0.75 * p.snap);
                let crack = self.flt[3].tick(n as f64) as f32 * (-ms / 4.0).exp() * 1.1 * p.snap;
                self.drive(body + noise + crack)
            }
            DrumKind::Clap => {
                let n = self.rng.bipolar();
                let s = self.t as f32;
                // envelope = max of short bursts; the last one rings out as the tail
                let mut env = 0.0f32;
                for (i, &b) in self.burst.iter().enumerate() {
                    if s >= b {
                        let dms = (s - b) / self.sr * 1000.0;
                        let e = if i < 3 {
                            (-dms / 2.6).exp() * (1.0 - 0.06 * i as f32)
                        } else {
                            0.92 * (-dms * 4.6 / p.decay_ms).exp()
                        };
                        env = env.max(e);
                    }
                }
                let bp = self.flt[0].tick(n as f64);
                let body = self.flt[1].tick(bp) as f32 * 1.6;
                let crack = self.flt[2].tick(n as f64) as f32 * 0.45 * p.snap;
                self.drive((body + crack) * env)
            }
            DrumKind::ClosedHat | DrumKind::OpenHat => {
                let mut metal = 0.0f32;
                for i in 0..6 {
                    let hz = self.f[i];
                    metal += self.square(i, hz);
                }
                metal *= 1.0 / 6.0;
                let m = self.flt[0].tick(metal as f64);
                let m = self.flt[1].tick(m) as f32;
                let n = self.rng.bipolar();
                let nh = self.flt[2].tick(n as f64) as f32;
                let mix = m * 2.4 * (1.15 - 0.6 * p.snap) + nh * (0.25 + 0.75 * p.snap);
                let mix = self.flt[3].tick(mix as f64) as f32;
                let att = (ms / 0.25).min(1.0);
                let env = if self.kind == DrumKind::ClosedHat {
                    att * (-6.9 * u).exp()
                } else {
                    // open hat: slower body with a quick initial drop
                    att * (0.35 * (-ms / 18.0).exp() + 0.65 * (-6.9 * u * u.sqrt()).exp())
                };
                self.drive(mix * env)
            }
            DrumKind::Tom => {
                let bend = 1.0 + (0.35 + 0.5 * p.tone) * (-ms / 45.0).exp();
                let f = self.f[0] * bend;
                let b = self.sine(0, f) + 0.22 * self.sine(1, f * 1.59) * (-ms / 60.0).exp();
                let amp = (-6.9 * (0.4 * u + 0.6 * u * u)).exp();
                let n = self.rng.bipolar();
                let click = self.flt[0].tick(n as f64) as f32 * (-ms / 1.4).exp() * 0.5 * p.snap;
                let click = self.flt[1].tick(click as f64) as f32;
                self.drive(b * amp * 0.85 + click)
            }
            DrumKind::Rim => {
                let s1 = self.sine(0, self.f[0]) * (-ms / (5.0 + 3.0 * u)).exp();
                let s2 = self.sine(1, self.f[1]) * (-ms / 11.0).exp() * 0.65;
                let n = self.rng.bipolar();
                let nb = self.flt[0].tick(n as f64) as f32 * (-ms / 1.0).exp() * (0.3 + 0.6 * p.snap);
                let amp = (-6.9 * u).exp();
                let x = (s1 + s2 + nb) * amp;
                let x = 0.6 * x + 0.4 * self.flt[1].tick(x as f64) as f32;
                self.drive(x * 1.2)
            }
            DrumKind::Cowbell => {
                let (f0, f1) = (self.f[0], self.f[1]);
                let sq = self.square(0, f0) * 0.55 + self.square(1, f1) * 0.45;
                let x = self.flt[0].tick(sq as f64);
                let x = self.flt[1].tick(x);
                let x = self.flt[2].tick(x) as f32 * 2.2;
                let env = 0.55 * (-ms / 9.0).exp() + 0.45 * (-6.9 * u).exp();
                self.drive(x * env)
            }
            DrumKind::Crash => {
                let mut metal = 0.0f32;
                for i in 0..3 {
                    let (fa, fb) = (self.f[2 * i], self.f[2 * i + 1]);
                    metal += self.square(2 * i, fa) * self.square(2 * i + 1, fb);
                }
                let n = self.rng.bipolar();
                let x = metal * 0.5 + n * 0.55;
                let x = self.flt[0].tick(x as f64);
                let x = self.flt[1].tick(x);
                // brightness falls over the decay
                let lp = self.flt[2].tick(x) as f32;
                let dark = self.flt[3].tick(x) as f32;
                let bright = 1.0 - 0.6 * u;
                let x = lp * bright + dark * (1.0 - bright) * 0.6;
                let att = (ms / 1.5).min(1.0);
                let env = att * (1.0 + 1.2 * (-ms / 25.0).exp()) * (-6.9 * u).exp() * 0.6;
                self.drive(x * env)
            }
            DrumKind::Perc => {
                let bend = 1.0 + 0.15 * (-ms / 10.0).exp();
                let fc = self.f[0] * bend;
                let idx = 3.0 * (0.4 + p.tone) * (-ms / 6.0).exp();
                let m = self.sine(1, fc * 1.47);
                let c_ph = self.ph[0];
                let v = ((c_ph * std::f64::consts::TAU) as f32 + idx * m).sin();
                self.ph[0] = (c_ph + fc as f64 / self.sr as f64).fract();
                let amp = (-6.9 * u).exp();
                let n = self.rng.bipolar();
                let click = self.flt[0].tick(n as f64) as f32 * (-ms / 0.8).exp() * 0.4 * p.snap;
                self.drive(v * amp * 0.9 + click)
            }
        };
        // DC blocker (~8 Hz)
        let r = 1.0 - TAU * 8.0 / self.sr;
        let out = y - self.dc_x + r * self.dc_y;
        self.dc_x = y;
        self.dc_y = crate::blocks::flush(out);
        self.t += 1;
        if self.t >= self.len {
            self.done = true;
        }
        // short end fade: never truncate with a click
        let left = self.len.saturating_sub(self.t);
        let fade_n = (0.004 * self.sr) as u32;
        if left < fade_n {
            out * left as f32 / fade_n as f32
        } else {
            out
        }
    }
}

/// Render a whole hit offline (factory kit, tests).
pub fn render(kind: DrumKind, p: DrumParams, sr: f32, seed: u32) -> Vec<f32> {
    let mut h = DrumHit::new(sr);
    h.trigger(kind, p, seed);
    let mut v = Vec::with_capacity(h.len as usize + 1);
    while !h.done {
        v.push(h.next());
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_sounds_and_ends() {
        for k in 0..10 {
            let kind = DrumKind::from_index(k);
            let v = render(kind, DrumParams::default(), 48000.0, 7);
            let peak = v.iter().fold(0.0f32, |m, x| m.max(x.abs()));
            assert!(peak > 0.1 && peak <= 1.2, "{kind:?} peak {peak}");
            assert!(v.iter().all(|x| x.is_finite()));
            let tail = &v[v.len() - 32..];
            let tpk = tail.iter().fold(0.0f32, |m, x| m.max(x.abs()));
            assert!(tpk < peak * 0.01, "{kind:?} tail {tpk} vs {peak}");
        }
    }
}
