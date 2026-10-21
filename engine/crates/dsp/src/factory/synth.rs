//! Offline synthesis toolkit for the factory library: noise, filters,
//! saturation, modal resonators, stereo helpers and thin wrappers that run
//! the stock effects and instruments offline. Nothing here runs on the audio
//! thread, so allocation is fine; everything is deterministic (seeded noise,
//! fixed block sizes).

use crate::blocks::filters::{Svf, SvfMode, BUTTER_Q_4};
use crate::blocks::osc::{blep_wave, Shape};
use crate::blocks::Rng;
use crate::{descriptor, NoteExtras, ProcessContext};

pub(crate) const SR: f32 = 48_000.0;
pub(crate) const FS: f64 = 48_000.0;
pub(crate) const TAU64: f64 = std::f64::consts::TAU;
pub(crate) const TAU32: f32 = std::f32::consts::TAU;
/// Tempo every tempo-synced file is written at.
pub(crate) const BPM: f32 = 128.0;
/// Samples per 4/4 bar at 128 BPM and 48 kHz: 4 × 60/128 s × 48 000 = 90 000 exactly.
pub(crate) const BAR: usize = 90_000;
const BLOCK: usize = 512;
/// Silence run through effects/instruments first, so their parameter
/// smoothers have settled before the first real sample.
const PREROLL: usize = 12_000;

pub(crate) type Chans = Vec<Vec<f32>>;

pub(crate) use SvfMode::{Bandpass as BP, HighShelf, Highpass as HP, LowShelf, Lowpass as LP};

/// Seconds → samples.
#[inline]
pub(crate) fn ns(sec: f32) -> usize {
    (sec * SR).round().max(0.0) as usize
}

/// dB → linear.
#[inline]
pub(crate) fn db(d: f32) -> f32 {
    10f32.powf(d / 20.0)
}

/// MIDI note → Hz.
#[inline]
pub(crate) fn hz(note: f32) -> f32 {
    440.0 * ((note - 69.0) / 12.0).exp2()
}

/// T60-style decay: 1 at t = 0, -60 dB at t = `t60` (same units).
#[inline]
pub(crate) fn dec60(t: f32, t60: f32) -> f32 {
    (-6.907_755 * t / t60.max(1e-6)).exp()
}

/// Smoothstep 0..1.
#[inline]
pub(crate) fn smooth01(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

// ── Noise ───────────────────────────────────────────────────────────────

/// White / pink / brown noise from one seeded generator.
pub(crate) struct Noise {
    rng: Rng,
    p: [f32; 3],
    br: f32,
}

impl Noise {
    pub fn new(seed: u32) -> Self {
        Self { rng: Rng::new(seed), p: [0.0; 3], br: 0.0 }
    }
    /// Uniform -1..1.
    #[inline]
    pub fn white(&mut self) -> f32 {
        self.rng.bipolar()
    }
    /// Uniform 0..1.
    #[inline]
    pub fn unit(&mut self) -> f32 {
        self.rng.unit()
    }
    #[inline]
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.rng.unit()
    }
    /// -3 dB/oct (three-pole approximation, roughly ±1).
    #[inline]
    pub fn pink(&mut self) -> f32 {
        let w = self.rng.bipolar();
        self.p[0] = 0.99765 * self.p[0] + w * 0.099_046;
        self.p[1] = 0.963 * self.p[1] + w * 0.296_516_4;
        self.p[2] = 0.57 * self.p[2] + w * 1.052_691_3;
        (self.p[0] + self.p[1] + self.p[2] + w * 0.1848) * 0.22
    }
    /// -6 dB/oct (leaky integrator).
    #[inline]
    pub fn brown(&mut self) -> f32 {
        self.br = (self.br * 0.996 + self.rng.bipolar() * 0.06).clamp(-1.0, 1.0);
        self.br * 2.0
    }
}

/// A slow random wander in -1..1: a sum of three sines at random rates and
/// phases (cheap, smooth, loop-friendly after a crossfade).
pub(crate) struct Wander {
    ph: [f32; 3],
    rate: [f32; 3],
}

impl Wander {
    pub fn new(nz: &mut Noise, lo_hz: f32, hi_hz: f32) -> Self {
        let mut ph = [0.0; 3];
        let mut rate = [0.0; 3];
        for i in 0..3 {
            ph[i] = nz.unit();
            rate[i] = nz.range(lo_hz, hi_hz);
        }
        Self { ph, rate }
    }
    #[inline]
    pub fn at(&self, t: f32) -> f32 {
        let mut v = 0.0;
        for i in 0..3 {
            v += (TAU32 * (self.ph[i] + self.rate[i] * t)).sin();
        }
        v / 3.0
    }
}

// ── Filters ─────────────────────────────────────────────────────────────

pub(crate) fn svf(mode: SvfMode, fc: f32, q: f32) -> Svf {
    let mut s = Svf::default();
    s.design(mode, fc.clamp(10.0, 0.45 * SR) as f64, q as f64, 0.0, FS);
    s
}

pub(crate) fn svf_gain(mode: SvfMode, fc: f32, q: f32, gain_db: f32) -> Svf {
    let mut s = Svf::default();
    s.design(mode, fc.clamp(10.0, 0.45 * SR) as f64, q as f64, gain_db as f64, FS);
    s
}

#[inline]
pub(crate) fn tick(f: &mut Svf, x: f32) -> f32 {
    f.tick(x as f64) as f32
}

/// Run a static filter over a buffer.
pub(crate) fn filt(x: &mut [f32], mode: SvfMode, fc: f32, q: f32) {
    let mut f = svf(mode, fc, q);
    for v in x.iter_mut() {
        *v = f.tick(*v as f64) as f32;
    }
}

/// Bell / shelf EQ over a buffer.
pub(crate) fn eq(x: &mut [f32], mode: SvfMode, fc: f32, q: f32, gain_db: f32) {
    let mut f = svf_gain(mode, fc, q, gain_db);
    for v in x.iter_mut() {
        *v = f.tick(*v as f64) as f32;
    }
}

pub(crate) fn hp(x: &mut [f32], fc: f32) {
    filt(x, HP, fc, std::f32::consts::FRAC_1_SQRT_2);
}

pub(crate) fn lp(x: &mut [f32], fc: f32) {
    filt(x, LP, fc, std::f32::consts::FRAC_1_SQRT_2);
}

/// 24 dB/oct Butterworth high pass.
pub(crate) fn hp4(x: &mut [f32], fc: f32) {
    for q in BUTTER_Q_4 {
        filt(x, HP, fc, q as f32);
    }
}

/// 24 dB/oct Butterworth low pass.
pub(crate) fn lp4(x: &mut [f32], fc: f32) {
    for q in BUTTER_Q_4 {
        filt(x, LP, fc, q as f32);
    }
}

/// Time-varying filter: `f(u)` gives the cutoff (Hz) at position u = 0..1
/// through the buffer. The TPT SVF stays stable under fast sweeps.
pub(crate) fn sweep(x: &mut [f32], mode: SvfMode, q: f32, f: impl Fn(f32) -> f32) {
    let n = x.len().max(1) as f32;
    let mut s = Svf::default();
    for (i, v) in x.iter_mut().enumerate() {
        if i % 16 == 0 {
            let fc = f(i as f32 / n).clamp(15.0, 0.45 * SR);
            s.design(mode, fc as f64, q as f64, 0.0, FS);
        }
        *v = s.tick(*v as f64) as f32;
    }
}

// ── Level / shaping ─────────────────────────────────────────────────────

pub(crate) fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

pub(crate) fn peak_ch(ch: &Chans) -> f32 {
    ch.iter().map(|c| peak(c)).fold(0.0, f32::max)
}

pub(crate) fn gain(x: &mut [f32], g: f32) {
    for v in x.iter_mut() {
        *v *= g;
    }
}

pub(crate) fn gain_ch(ch: &mut Chans, g: f32) {
    for c in ch.iter_mut() {
        gain(c, g);
    }
}

/// Scale so the sample peak is `to`.
pub(crate) fn normalize(x: &mut [f32], to: f32) {
    let p = peak(x);
    if p > 1e-9 {
        gain(x, to / p);
    }
}

/// tanh saturation, peak-preserving for a full-scale input; `bias` adds
/// even harmonics (the DC it creates is removed by the caller's high pass).
pub(crate) fn drive(x: &mut [f32], k: f32, bias: f32) {
    let k = k.max(0.01);
    let off = (k * bias).tanh();
    let norm = 1.0 / k.tanh();
    for v in x.iter_mut() {
        *v = ((k * (*v + bias)).tanh() - off) * norm;
    }
}

/// Bit / rate reduction: quantize to `bits` and hold every `hold` samples.
pub(crate) fn crush(x: &mut [f32], bits: f32, hold: usize) {
    let q = 2f32.powf(bits - 1.0);
    let hold = hold.max(1);
    let mut held = 0.0;
    for (i, v) in x.iter_mut().enumerate() {
        if i % hold == 0 {
            held = (*v * q).round() / q;
        }
        *v = held;
    }
}

/// Fade in/out (raised cosine) over `a` / `b` samples.
pub(crate) fn fades(x: &mut [f32], a: usize, b: usize) {
    let n = x.len();
    let a = a.min(n);
    for (i, v) in x.iter_mut().take(a).enumerate() {
        *v *= 0.5 - 0.5 * (std::f32::consts::PI * i as f32 / a as f32).cos();
    }
    let b = b.min(n);
    for i in 0..b {
        let g = 0.5 - 0.5 * (std::f32::consts::PI * i as f32 / b as f32).cos();
        x[n - 1 - i] *= g;
    }
}

/// Add `src × g` into `dst` starting at `at`, growing `dst` as needed.
pub(crate) fn add(dst: &mut Vec<f32>, src: &[f32], g: f32, at: usize) {
    if dst.len() < at + src.len() {
        dst.resize(at + src.len(), 0.0);
    }
    for (d, s) in dst[at..].iter_mut().zip(src) {
        *d += s * g;
    }
}

/// Add a mono or stereo buffer into a stereo one.
pub(crate) fn add_ch(dst: &mut Chans, src: &Chans, g: f32, at: usize) {
    while dst.len() < 2 {
        let c = dst[0].clone();
        dst.push(c);
    }
    add(&mut dst[0], &src[0], g, at);
    add(&mut dst[1], src.get(1).unwrap_or(&src[0]), g, at);
}

pub(crate) fn mono_sum(ch: &Chans) -> Vec<f32> {
    if ch.len() == 1 {
        return ch[0].clone();
    }
    let n = ch[0].len().max(ch[1].len());
    (0..n).map(|i| 0.5 * (ch[0].get(i).copied().unwrap_or(0.0) + ch[1].get(i).copied().unwrap_or(0.0))).collect()
}

/// Make both channels the same length (zero padded).
pub(crate) fn even(ch: &mut Chans) {
    let n = ch.iter().map(|c| c.len()).max().unwrap_or(0);
    for c in ch.iter_mut() {
        c.resize(n, 0.0);
    }
}

/// Partially decorrelated stereo pair from two renders (width 0..1).
pub(crate) fn stereo_pair(a: &[f32], b: &[f32], width: f32) -> Chans {
    let n = a.len().max(b.len());
    let get = |v: &[f32], i: usize| v.get(i).copied().unwrap_or(0.0);
    let (wa, wb) = (1.0 - 0.5 * width, 0.5 * width);
    let l = (0..n).map(|i| wa * get(a, i) + wb * get(b, i)).collect();
    let r = (0..n).map(|i| wb * get(a, i) + wa * get(b, i)).collect();
    vec![l, r]
}

/// Crossfade the `xf` samples past `n` onto the start, so the first `n`
/// samples loop seamlessly (equal power: suits decorrelated noise).
pub(crate) fn make_loop(x: &mut Vec<f32>, n: usize, xf: usize) {
    assert!(x.len() >= n + xf, "loop source too short");
    for i in 0..xf {
        let a = i as f32 / xf as f32 * std::f32::consts::FRAC_PI_2;
        x[i] = x[i] * a.sin() + x[n + i] * a.cos();
    }
    x.truncate(n);
}

// ── Oscillators ─────────────────────────────────────────────────────────

/// Band-limited saw / square at phase `ph` with increment `dt` (cycles/sample).
#[inline]
pub(crate) fn saw(ph: f64, dt: f64) -> f32 {
    blep_wave(Shape::Saw, ph, dt) as f32
}

#[inline]
pub(crate) fn square(ph: f64, dt: f64) -> f32 {
    blep_wave(Shape::Square, ph, dt) as f32
}

/// Advance a phase accumulator by `f` Hz and return the phase before the step.
#[inline]
pub(crate) fn step(ph: &mut f64, f: f32) -> (f64, f64) {
    let p = *ph;
    let dt = (f as f64 / FS).clamp(0.0, 0.49);
    *ph = (p + dt).fract();
    (p, dt)
}

/// A bank of exponentially decaying sinusoids (modal synthesis): each mode
/// is (Hz, amplitude, T60 seconds, start phase 0..1). Rendered with a
/// rotating phasor per mode, so cost is a complex multiply per mode/sample.
pub(crate) fn modes(m: &[(f32, f32, f32, f32)], n: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; n];
    for &(f, a, t60, ph) in m {
        if f <= 0.0 || f >= 0.48 * SR || a == 0.0 {
            continue;
        }
        let w = TAU64 * f as f64 / FS;
        let r = (-6.907_755 / (t60.max(1e-3) as f64 * FS)).exp();
        let (rc, rs) = (r * w.cos(), r * w.sin());
        let (mut zr, mut zi) = ((TAU64 * ph as f64).cos() * a as f64, (TAU64 * ph as f64).sin() * a as f64);
        for o in out.iter_mut() {
            *o += zi as f32;
            let nr = zr * rc - zi * rs;
            zi = zr * rs + zi * rc;
            zr = nr;
            if zr.abs() + zi.abs() < 1e-9 {
                break;
            }
        }
    }
    out
}

// ── Stock effects / instruments, offline ───────────────────────────────

fn ctx(frames: usize, beat: f64) -> ProcessContext {
    ProcessContext { sample_rate: SR, bpm: BPM as f64, beats_per_bar: 4.0, playing: true, beat_pos: beat, frames }
}

/// Run a stock effect (by id, params in plain units) over a stereo pair in
/// place, latency-compensated, extending it by `tail_s` seconds.
pub(crate) fn effect(id: &str, params: &[(&str, f32)], l: &mut Vec<f32>, r: &mut Vec<f32>, tail_s: f32) {
    let d = descriptor(id).unwrap_or_else(|| panic!("factory: unknown effect {id}"));
    let mut fx = crate::create_effect(id, SR, BLOCK).unwrap_or_else(|| panic!("factory: cannot create {id}"));
    for (pid, v) in params {
        let i = d.param_index(pid).unwrap_or_else(|| panic!("factory: {id} has no param {pid}"));
        fx.set_param(i, *v);
    }
    // settle smoothers on silence
    let mut zl = vec![0.0f32; BLOCK];
    let mut zr = vec![0.0f32; BLOCK];
    let mut done = 0;
    while done < PREROLL {
        zl.iter_mut().for_each(|v| *v = 0.0);
        zr.iter_mut().for_each(|v| *v = 0.0);
        fx.process(&ctx(BLOCK, 0.0), [&mut zl, &mut zr], None);
        done += BLOCK;
    }
    // no fx.reset() here: krypt.drive's reset() zeroes its ADAA state, which
    // spikes on the next samples in Tube / Fold mode; silence already settled it
    let lat = fx.latency();
    let n = l.len().max(r.len()) + ns(tail_s) + lat;
    l.resize(n, 0.0);
    r.resize(n, 0.0);
    let mut at = 0;
    while at < n {
        let m = (n - at).min(BLOCK);
        let beat = at as f64 / FS * BPM as f64 / 60.0;
        fx.process(&ctx(m, beat), [&mut l[at..at + m], &mut r[at..at + m]], None);
        at += m;
    }
    if lat > 0 {
        l.drain(..lat);
        r.drain(..lat);
    }
}

/// Effect over a mono buffer (processed as dual mono, left channel kept).
pub(crate) fn effect_mono(id: &str, params: &[(&str, f32)], x: &mut Vec<f32>, tail_s: f32) {
    let mut r = x.clone();
    effect(id, params, x, &mut r, tail_s);
}

/// Reverb settings (krypt.reverb params). mode: 0 Room, 1 Hall, 2 Plate.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Rev {
    pub mode: f32,
    pub size: f32,
    pub decay: f32,
    pub pre: f32,
    pub damp: f32,
    pub low: f32,
    pub diff: f32,
    pub width: f32,
}

pub(crate) const fn rev(mode: f32, size: f32, decay: f32) -> Rev {
    Rev { mode, size, decay, pre: 8.0, damp: 8000.0, low: 200.0, diff: 0.8, width: 1.0 }
}

impl Rev {
    pub const fn pre(mut self, ms: f32) -> Self {
        self.pre = ms;
        self
    }
    pub const fn damp(mut self, hz: f32) -> Self {
        self.damp = hz;
        self
    }
    pub const fn low(mut self, hz: f32) -> Self {
        self.low = hz;
        self
    }
    pub const fn width(mut self, w: f32) -> Self {
        self.width = w;
        self
    }
}

/// 100% wet reverb return of a mono or stereo source (stereo out).
pub(crate) fn reverb_wet(src: &Chans, r: &Rev, tail_s: f32) -> Chans {
    let mut l = src[0].clone();
    let mut rr = src.get(1).unwrap_or(&src[0]).clone();
    effect(
        "krypt.reverb",
        &[
            ("mode", r.mode),
            ("size", r.size),
            ("decay", r.decay),
            ("predelay", r.pre),
            ("damping", r.damp),
            ("lowCut", r.low),
            ("diffusion", r.diff),
            ("width", r.width),
        ],
        &mut l,
        &mut rr,
        tail_s,
    );
    vec![l, rr]
}

/// Dry + `wet` × reverb, stereo out, extended by `tail_s`.
pub(crate) fn reverb(src: &Chans, r: &Rev, wet: f32, tail_s: f32) -> Chans {
    let w = reverb_wet(src, r, tail_s);
    let mut out = vec![src[0].clone(), src.get(1).unwrap_or(&src[0]).clone()];
    add_ch(&mut out, &w, wet, 0);
    out
}

/// Reverb folded back to mono (a "room" on a mono drum).
pub(crate) fn reverb_mono(x: &[f32], r: &Rev, wet: f32, tail_s: f32) -> Vec<f32> {
    let w = reverb_wet(&vec![x.to_vec()], r, tail_s);
    let mut out = x.to_vec();
    add(&mut out, &mono_sum(&w), wet, 0);
    out
}

/// 1980s gated reverb: the return is cut `gate_ms` after the hit with a
/// `rel_ms` release.
pub(crate) fn gated(src: &Chans, r: &Rev, wet: f32, gate_ms: f32, rel_ms: f32) -> Chans {
    let mut w = reverb_wet(src, r, (gate_ms + rel_ms) / 1000.0 + 0.05);
    let (g0, g1) = (ns(gate_ms / 1000.0), ns((gate_ms + rel_ms) / 1000.0));
    for c in w.iter_mut() {
        for (i, v) in c.iter_mut().enumerate() {
            if i >= g1 {
                *v = 0.0;
            } else if i > g0 {
                *v *= 0.5 + 0.5 * (std::f32::consts::PI * (i - g0) as f32 / (g1 - g0) as f32).cos();
            }
        }
        c.truncate(g1);
    }
    let mut out = vec![src[0].clone(), src.get(1).unwrap_or(&src[0]).clone()];
    add_ch(&mut out, &w, wet, 0);
    out
}

/// Play a chord on a stock instrument: notes held `hold_s`, rendered for
/// `total_s` (stereo).
pub(crate) fn play(id: &str, params: &[(&str, f32)], notes: &[f32], vel: f32, hold_s: f32, total_s: f32) -> Chans {
    let d = descriptor(id).unwrap_or_else(|| panic!("factory: unknown instrument {id}"));
    let mut inst = crate::create_instrument(id, SR, BLOCK).unwrap_or_else(|| panic!("factory: cannot create {id}"));
    for (pid, v) in params {
        let i = d.param_index(pid).unwrap_or_else(|| panic!("factory: {id} has no param {pid}"));
        inst.set_param(i, *v);
    }
    let mut zl = vec![0.0f32; BLOCK];
    let mut zr = vec![0.0f32; BLOCK];
    let mut done = 0;
    while done < PREROLL {
        inst.process(&ctx(BLOCK, 0.0), [&mut zl, &mut zr]);
        done += BLOCK;
    }
    let n = ns(total_s);
    let off = ns(hold_s);
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    for &p in notes {
        inst.note_on(0, p.round().clamp(0.0, 127.0) as u8, p, vel, NoteExtras::default());
    }
    let mut at = 0;
    while at < n {
        let m = (n - at).min(BLOCK);
        if off >= at && off < at + m {
            for &p in notes {
                inst.note_off(off - at, p.round().clamp(0.0, 127.0) as u8);
            }
        }
        inst.process(&ctx(m, 0.0), [&mut l[at..at + m], &mut r[at..at + m]]);
        at += m;
    }
    vec![l, r]
}
