//! Shared building blocks for the transition / FX recipes (Wave 7b):
//! detuned saw stacks, a cascade formant voice (vowels on a glottal-style
//! source), a variable-speed tape reader, equal-power panning, reverse
//! reverb swells and a tiny step sequencer for drum material. Offline only;
//! everything is seeded, so renders are deterministic.

use super::synth::*;

pub(crate) use super::fx::{cut, shape, stereo_noise};

#[inline]
pub(crate) fn lerp(a: f32, b: f32, u: f32) -> f32 {
    a + (b - a) * u
}

/// Exponential interpolation (a, b > 0): frequency-like sweeps.
#[inline]
pub(crate) fn expi(a: f32, b: f32, u: f32) -> f32 {
    a * (b / a).powf(u.clamp(0.0, 1.0))
}

/// Equal-power pan of a mono buffer; `pan(i)` is 0 (left) … 1 (right).
pub(crate) fn pan_mono(x: &[f32], pan: impl Fn(usize) -> f32) -> Chans {
    let mut l = vec![0.0f32; x.len()];
    let mut r = vec![0.0f32; x.len()];
    for (i, v) in x.iter().enumerate() {
        let p = pan(i).clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
        l[i] = v * p.cos() * std::f32::consts::SQRT_2;
        r[i] = v * p.sin() * std::f32::consts::SQRT_2;
    }
    vec![l, r]
}

/// Mono or stereo → stereo (copies the single channel).
pub(crate) fn to_stereo(ch: Chans) -> Chans {
    if ch.len() >= 2 {
        ch
    } else {
        vec![ch[0].clone(), ch[0].clone()]
    }
}

/// Run a static or swept filter over each channel.
pub(crate) fn sweep_ch(ch: &mut Chans, mode: SvfMode, q: f32, f: impl Fn(f32) -> f32 + Copy) {
    for c in ch.iter_mut() {
        sweep(c, mode, q, f);
    }
}

pub(crate) use crate::blocks::filters::SvfMode;

/// Detuned saw stack ("supersaw") playing `notes` (MIDI) with `voices`
/// voices per note spread over ±`detune(u)` semitones, voices panned across
/// the stereo field by `width`. `bend(u)` adds semitones to every voice.
pub(crate) fn supersaw(notes: &[f32], n: usize, voices: usize, width: f32, seed: u32, detune: impl Fn(f32) -> f32, bend: impl Fn(f32) -> f32) -> Chans {
    let mut nz = Noise::new(seed);
    let nv = notes.len() * voices;
    let mut ph: Vec<f64> = (0..nv).map(|_| nz.unit() as f64).collect();
    let offs: Vec<f32> = (0..voices).map(|v| if voices == 1 { 0.0 } else { v as f32 / (voices - 1) as f32 * 2.0 - 1.0 }).collect();
    let jit: Vec<f32> = (0..nv).map(|_| nz.range(-0.06, 0.06)).collect();
    let pans: Vec<(f32, f32)> = (0..nv)
        .map(|k| {
            let o = offs[k % voices] * if (k / voices) % 2 == 0 { 1.0 } else { -1.0 };
            let p = (0.5 + 0.5 * width * o) * std::f32::consts::FRAC_PI_2;
            (p.cos(), p.sin())
        })
        .collect();
    let mut fr = vec![0.0f32; nv];
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    let norm = 1.0 / (nv as f32).sqrt();
    for i in 0..n {
        if i % 32 == 0 {
            let u = i as f32 / n.max(1) as f32;
            let (d, b) = (detune(u), bend(u));
            for k in 0..nv {
                fr[k] = hz(notes[k / voices] + b + offs[k % voices] * d + jit[k] * d);
            }
        }
        let (mut sl, mut sr) = (0.0, 0.0);
        for k in 0..nv {
            let (p, dt) = step(&mut ph[k], fr[k]);
            let s = saw(p, dt);
            sl += s * pans[k].0;
            sr += s * pans[k].1;
        }
        l[i] = sl * norm;
        r[i] = sr * norm;
    }
    vec![l, r]
}

/// Vowel: formant centres (Hz) and bandwidths (Hz), F1..F5.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Vowel {
    pub f: [f32; 5],
    pub bw: [f32; 5],
}

// Average adult formant frequencies from the open phonetics literature.
pub(crate) const AH: Vowel = Vowel { f: [760.0, 1150.0, 2600.0, 3400.0, 4100.0], bw: [80.0, 90.0, 120.0, 160.0, 200.0] };
pub(crate) const OH: Vowel = Vowel { f: [480.0, 820.0, 2600.0, 3300.0, 4000.0], bw: [70.0, 80.0, 120.0, 160.0, 200.0] };
pub(crate) const OO: Vowel = Vowel { f: [320.0, 800.0, 2350.0, 3200.0, 4000.0], bw: [60.0, 80.0, 120.0, 160.0, 200.0] };
pub(crate) const EE: Vowel = Vowel { f: [290.0, 2250.0, 3000.0, 3600.0, 4300.0], bw: [60.0, 100.0, 140.0, 180.0, 220.0] };
pub(crate) const EH: Vowel = Vowel { f: [560.0, 1800.0, 2550.0, 3500.0, 4200.0], bw: [70.0, 100.0, 130.0, 170.0, 210.0] };
pub(crate) const UH: Vowel = Vowel { f: [640.0, 1200.0, 2450.0, 3300.0, 4000.0], bw: [80.0, 90.0, 120.0, 160.0, 200.0] };

impl Vowel {
    pub fn mix(a: &Vowel, b: &Vowel, u: f32) -> Vowel {
        let u = u.clamp(0.0, 1.0);
        let mut v = *a;
        for k in 0..5 {
            v.f[k] = expi(a.f[k], b.f[k], u);
            v.bw[k] = lerp(a.bw[k], b.bw[k], u);
        }
        v
    }
    /// Scale every formant (vocal-tract length: > 1 smaller / younger voice).
    pub fn scale(mut self, k: f32) -> Vowel {
        for f in self.f.iter_mut() {
            *f *= k;
        }
        self
    }
}

/// Settings for one sung / spoken voice.
pub(crate) struct Voice<'a> {
    /// Pitch in Hz at time t (s), before vibrato and jitter.
    pub pitch: &'a dyn Fn(f32) -> f32,
    /// Vowel at time t.
    pub vowel: &'a dyn Fn(f32) -> Vowel,
    /// Voiced level at time t (0..1).
    pub amp: &'a dyn Fn(f32) -> f32,
    /// Aspiration (breath) level at time t, relative to the voiced level.
    pub breath: &'a dyn Fn(f32) -> f32,
    /// Vibrato depth (semitones) and rate (Hz); it fades in over `vib_in` s.
    pub vib: f32,
    pub vib_hz: f32,
    pub vib_in: f32,
    pub seed: u32,
}

/// Cascade formant synthesis: a band-limited glottal-style pulse (saw with
/// jitter and shimmer, softened above ~5 kHz) plus phase-gated aspiration
/// noise, through five cascaded 2-pole resonators (unity gain at DC, Q =
/// F / bandwidth) — the classic vocal-tract model. Returns `n` samples.
pub(crate) fn voice(v: &Voice, n: usize) -> Vec<f32> {
    let mut nz = Noise::new(v.seed);
    let mut ph = nz.unit() as f64;
    let mut res: Vec<crate::blocks::filters::Svf> = (0..5).map(|_| svf(LP, 1000.0, 1.0)).collect();
    let mut soft = svf(LP, 5200.0, 0.6);
    let mut breath_hp = svf(HP, 900.0, 0.7);
    let mut out = vec![0.0f32; n];
    let mut jit = 0.0f32;
    let mut shim = 1.0f32;
    let vib_ph = nz.unit();
    let drift = Wander::new(&mut nz, 0.2, 0.9);
    for i in 0..n {
        let t = i as f32 / SR;
        if i % 32 == 0 {
            let vw = (v.vowel)(t);
            for k in 0..5 {
                let q = vw.f[k] / vw.bw[k].max(20.0);
                res[k].design(LP, vw.f[k].min(0.45 * SR) as f64, q as f64, 0.0, FS);
            }
        }
        let vin = smooth01(t / v.vib_in.max(1e-3));
        let vib = v.vib * vin * (TAU32 * (vib_ph + v.vib_hz * t)).sin() + 0.04 * drift.at(t);
        let f0 = (v.pitch)(t) * (vib / 12.0).exp2() * (1.0 + jit);
        let (p, dt) = step(&mut ph, f0);
        if p + dt >= 1.0 {
            // a new glottal cycle: small random period / amplitude changes
            jit = nz.range(-0.004, 0.004);
            shim = 1.0 + nz.range(-0.04, 0.04);
        }
        let pulse = -saw(p, dt) * shim;
        // aspiration is louder while the glottis is open (first part of the cycle)
        let gate = if p < 0.55 { 1.0 } else { 0.35 };
        let asp = tick(&mut breath_hp, nz.white()) * gate;
        let src = tick(&mut soft, pulse) * (v.amp)(t) + asp * (v.breath)(t);
        let mut y = src;
        for r in res.iter_mut() {
            y = tick(r, y);
        }
        out[i] = y;
    }
    hp(&mut out, 70.0);
    // presence, as a vocal chain would add (the all-pole tract is dark above F3)
    eq(&mut out, HighShelf, 2800.0, 0.7, 5.0);
    out
}

/// Run any source through the five-formant cascade (`vowel(t)`), e.g. a saw
/// chord for vocoder-style "talking synth" blips.
pub(crate) fn formants(x: &[f32], vowel: impl Fn(f32) -> Vowel) -> Vec<f32> {
    let mut res: Vec<crate::blocks::filters::Svf> = (0..5).map(|_| svf(LP, 1000.0, 1.0)).collect();
    let mut out = vec![0.0f32; x.len()];
    for (i, (o, s)) in out.iter_mut().zip(x).enumerate() {
        if i % 32 == 0 {
            let vw = vowel(i as f32 / SR);
            for k in 0..5 {
                res[k].design(LP, vw.f[k].min(0.45 * SR) as f64, (vw.f[k] / vw.bw[k].max(20.0)) as f64, 0.0, FS);
            }
        }
        let mut y = *s;
        for r in res.iter_mut() {
            y = tick(r, y);
        }
        *o = y;
    }
    hp(&mut out, 70.0);
    eq(&mut out, HighShelf, 2800.0, 0.7, 5.0);
    out
}

/// Constant-ish settings helper for `voice`.
pub(crate) fn sung(n: usize, note: f32, vowel: Vowel, attack: f32, release_at: f32, release: f32, breath: f32, seed: u32) -> Vec<f32> {
    let f = hz(note);
    let len = n as f32 / SR;
    let amp = move |t: f32| smooth01(t / attack.max(1e-3)) * (1.0 - smooth01((t - release_at) / release.max(1e-3))) * if t > len { 0.0 } else { 1.0 };
    voice(
        &Voice {
            pitch: &move |t| f * (1.0 + 0.012 * (-t / 0.05).exp()),
            vowel: &move |_| vowel,
            amp: &amp,
            breath: &move |t| breath * amp(t),
            vib: 0.25,
            vib_hz: 5.3,
            vib_in: 0.35,
            seed,
        },
        n,
    )
}

/// Cubic (Hermite) read of `x` at fractional index `pos` (0 outside).
#[inline]
pub(crate) fn read_cubic(x: &[f32], pos: f64) -> f32 {
    let i = pos.floor() as isize;
    let f = (pos - i as f64) as f32;
    let g = |k: isize| if k >= 0 && (k as usize) < x.len() { x[k as usize] } else { 0.0 };
    let (y0, y1, y2, y3) = (g(i - 1), g(i), g(i + 1), g(i + 2));
    let c1 = 0.5 * (y2 - y0);
    let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    ((c3 * f + c2) * f + c1) * f + y1
}

/// Variable-speed playback (tape / turntable): `speed(u)` is the playback
/// speed at output position u = 0..1 (1 = normal). Pitch and time fall
/// together; level follows the playback head (∝ speed^`lvl`) and a low pass
/// tracks the speed (head losses, and it removes interpolation images).
pub(crate) fn varispeed(src: &Chans, n: usize, lvl: f32, speed: impl Fn(f32) -> f32) -> Chans {
    let mut out: Chans = src.iter().map(|_| vec![0.0f32; n]).collect();
    let mut pos = 0.0f64;
    let mut filts: Vec<crate::blocks::filters::Svf> = src.iter().map(|_| svf(LP, 18_000.0, 0.7)).collect();
    let mut filts2: Vec<crate::blocks::filters::Svf> = src.iter().map(|_| svf(LP, 18_000.0, 0.7)).collect();
    for i in 0..n {
        let u = i as f32 / n as f32;
        let s = speed(u).max(0.0);
        if i % 16 == 0 {
            let fc = (250.0 + 17_000.0 * s.powf(1.3)).min(18_000.0);
            for f in filts.iter_mut().chain(filts2.iter_mut()) {
                f.design(LP, fc as f64, 0.7, 0.0, FS);
            }
        }
        let g = s.powf(lvl);
        for (c, ch) in src.iter().enumerate() {
            let y = read_cubic(ch, pos);
            let y = tick(&mut filts[c], y);
            out[c][i] = tick(&mut filts2[c], y) * g;
        }
        pos += s as f64;
    }
    out
}

/// Reverse-reverb swell: `src` through a 100% wet reverb, reversed, so the
/// tail swells into the very last of `n` samples; `dry` mixes in the
/// reversed dry source (its attack lands on the end).
pub(crate) fn reverse_swell(src: &Chans, r: &Rev, n: usize, dry: f32) -> Chans {
    let wet = reverb_wet(src, r, n as f32 / SR + 0.2);
    let mut out = to_stereo(wet);
    // the dry source decays over its length, so reversed it grows into its attack
    let mut s2 = to_stereo(src.clone());
    shape(&mut s2, |u| (1.0 - u).powi(2));
    add_ch(&mut out, &s2, dry, 0);
    even(&mut out);
    // first audible sample of the wet+dry sum goes on the last sample
    let pk = peak_ch(&out).max(1e-9);
    let first = out.iter().map(|c| c.iter().position(|v| v.abs() > pk * 1e-3).unwrap_or(0)).min().unwrap_or(0);
    for c in out.iter_mut() {
        c.drain(..first);
        c.resize(n, 0.0);
        c.reverse();
    }
    // a long hall peaks a few hundred ms after its onset; a gentle ramp keeps
    // the loudest point on the end (where the source's attack lands)
    shape(&mut out, |u| db(-24.0 * (1.0 - u).powf(0.8)));
    out
}

/// Sample position of a 16th step at 128 BPM.
#[inline]
pub(crate) fn s16(step: f32) -> usize {
    (step * BAR as f32 / 16.0).round() as usize
}

/// A plucked saw/square note: filter envelope + amp decay.
pub(crate) fn pluck(note: f32, len_s: f32, decay_s: f32, bright: f32, seed: u32) -> Vec<f32> {
    let n = ns(len_s);
    let mut nz = Noise::new(seed);
    let f = hz(note);
    let (mut p1, mut p2) = (nz.unit() as f64, nz.unit() as f64);
    let mut fl = svf(LP, 1000.0, 1.2);
    let mut out = vec![0.0f32; n];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        if i % 16 == 0 {
            let fc = f * (1.5 + bright * 30.0 * dec60(t, decay_s * 0.6));
            fl.design(LP, fc.min(18_000.0) as f64, 1.2, 0.0, FS);
        }
        let (a, da) = step(&mut p1, f * 1.003);
        let (b, dbb) = step(&mut p2, f * 0.997);
        let s = 0.6 * saw(a, da) + 0.4 * square(b, dbb);
        *o = tick(&mut fl, s) * dec60(t, decay_s) * smooth01(t / 0.002);
    }
    out
}

/// Exponential pitch glide oscillator mix (sine + `harm` × a soft square),
/// frequency `f(t)` (Hz), amplitude `a(t)`.
pub(crate) fn tone(n: usize, harm: f32, f: impl Fn(f32) -> f32, a: impl Fn(f32) -> f32) -> Vec<f32> {
    let mut ph = 0.0f64;
    let mut out = vec![0.0f32; n];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let (p, dt) = step(&mut ph, f(t));
        let s = (p * TAU64).sin() as f32;
        *o = (s * (1.0 - harm) + harm * square(p, dt) * 0.6) * a(t);
    }
    out
}
