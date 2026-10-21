//! Transition FX. Tempo-synced ones are exactly N bars at 128 BPM:
//! risers, uplifting sweeps and reverse cymbals build to their climax on the
//! very last sample (the next downbeat); downlifters and down-sweeps start
//! at full level on sample 0. Impacts and sub drops are one-shots with the
//! transient on sample 0.

use super::drums::{cymbal, kick, snare, Cym, Kick, Snare, CRASH, KICK, SNARE};
use super::library::{spec, Spec};
use super::synth::*;

/// Stereo noise with a shared centre: `corr` 0 = independent sides, 1 = mono.
pub(crate) fn stereo_noise(n: usize, corr: f32, pink: bool, seed: u32) -> Chans {
    let mut c = Noise::new(seed);
    let mut a = Noise::new(seed.wrapping_add(101));
    let mut b = Noise::new(seed.wrapping_add(202));
    let (gc, gs) = (corr.sqrt(), (1.0 - corr).sqrt());
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    for i in 0..n {
        let (m, x, y) = if pink { (c.pink(), a.pink(), b.pink()) } else { (c.white(), a.white(), b.white()) };
        l[i] = gc * m + gs * x;
        r[i] = gc * m + gs * y;
    }
    vec![l, r]
}

/// Multiply every channel by `env(u)` (u = 0..1 through the buffer).
pub(crate) fn shape(ch: &mut Chans, env: impl Fn(f32) -> f32) {
    for c in ch.iter_mut() {
        let n = c.len().max(1) as f32;
        for (i, v) in c.iter_mut().enumerate() {
            *v *= env(i as f32 / n);
        }
    }
}

pub(crate) fn cut(ch: &mut Chans, n: usize) {
    for c in ch.iter_mut() {
        c.resize(n, 0.0);
    }
}

/// Noise uplifter: resonant band pass + high pass sweeping up, level rising
/// to the end, with a growing hall behind it.
fn noise_uplifter(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let mut ch = stereo_noise(n, 0.35, false, seed);
    for (k, c) in ch.iter_mut().enumerate() {
        let mut whistle = c.clone();
        let det = if k == 0 { 1.0 } else { 1.03 };
        sweep(c, BP, 1.2, |u| 250.0 * det * (14_000.0f32 / 250.0).powf(u.powf(1.25)));
        sweep(c, HP, 0.7, |u| 120.0 * (4000.0f32 / 120.0).powf(u.powf(1.3)));
        sweep(&mut whistle, BP, 9.0, |u| 400.0 * det * (9000.0f32 / 400.0).powf(u.powf(1.3)));
        add(c, &whistle, 0.35, 0);
    }
    shape(&mut ch, |u| db(-34.0 + 34.0 * u.powf(0.85)));
    let mut wet = reverb_wet(&ch, &rev(1.0, 0.8, 2.5).pre(20.0).low(400.0), 0.0);
    shape(&mut wet, |u| 0.15 + 0.35 * u);
    let mut out = ch;
    add_ch(&mut out, &wet, 1.0, 0);
    cut(&mut out, n);
    out
}

/// Detuned saw stack (7 voices per side), pitch rising `from` → `to` (MIDI),
/// filter opening, a tremolo gate that doubles speed every quarter of the
/// length (1/4 → 1/8 → 1/16 → 1/32) and level rising into the downbeat.
fn synth_riser(bars: u32, from: f32, to: f32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let mut nz = Noise::new(seed);
    let voices = 7;
    let mut ph: Vec<f64> = (0..voices * 2).map(|_| nz.unit() as f64).collect();
    let offs: Vec<f32> = (0..voices).map(|v| v as f32 / (voices - 1) as f32 * 2.0 - 1.0).collect();
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    let beat_hz = BPM / 60.0;
    let mut gate_ph = 0.0f32;
    let mut fv = vec![0.0f32; voices];
    for i in 0..n {
        let u = i as f32 / n as f32;
        if i % 32 == 0 {
            let note = from + (to - from) * u.powf(1.4);
            let det = 0.12 + 0.25 * u;
            for v in 0..voices {
                fv[v] = hz(note + offs[v] * det);
            }
        }
        let (mut sl, mut sr) = (0.0, 0.0);
        for v in 0..voices {
            let f = fv[v];
            let (pa, da) = step(&mut ph[v], f * 1.0007);
            let (pb, db_) = step(&mut ph[voices + v], f * 0.9993);
            let pan = 0.5 + 0.45 * offs[v];
            sl += saw(pa, da) * (1.0 - pan) + saw(pb, db_) * 0.3;
            sr += saw(pb, db_) * pan + saw(pa, da) * 0.3;
        }
        let rate = beat_hz * 2f32.powi((u * 4.0).floor().min(3.0) as i32);
        gate_ph = (gate_ph + rate / SR).fract();
        let gate = 1.0 - 0.55 * (0.5 - 0.5 * (TAU32 * gate_ph).cos());
        let g = gate * db(-26.0 + 26.0 * u.powf(0.75)) / voices as f32;
        l[i] = sl * g;
        r[i] = sr * g;
    }
    let mut ch = vec![l, r];
    for c in ch.iter_mut() {
        sweep(c, LP, 0.9, |u| 500.0 * (15_000.0f32 / 500.0).powf(u.powf(1.2)));
        hp(c, 120.0);
    }
    // a little white noise on top that also rises
    let mut nn = stereo_noise(n, 0.3, false, seed + 9);
    for c in nn.iter_mut() {
        sweep(c, HP, 0.7, |u| 2000.0 * (8000.0f32 / 2000.0).powf(u));
    }
    shape(&mut nn, |u| 0.12 * db(-30.0 + 30.0 * u.powf(1.2)));
    add_ch(&mut ch, &nn, 1.0, 0);
    let mut out = reverb(&ch, &rev(1.0, 0.7, 2.0).pre(15.0).low(300.0), 0.22, 0.0);
    cut(&mut out, n);
    out
}

/// Pure tension riser: a sine sweeping up with growing vibrato (mono).
fn sine_riser(bars: u32) -> Chans {
    let n = bars as usize * BAR;
    let mut x = vec![0.0f32; n];
    let mut ph = 0.0f64;
    for (i, v) in x.iter_mut().enumerate() {
        let u = i as f32 / n as f32;
        let t = i as f32 / SR;
        let vib = (0.02 + 0.25 * u) * (TAU32 * (4.0 + 6.0 * u) * t).sin();
        let note = 55.0 + 41.0 * u.powf(1.5) + vib;
        let (p, _) = step(&mut ph, hz(note));
        let s = (p * TAU64).sin() as f32;
        *v = (s + 0.15 * (3.0 * p * TAU64).sin() as f32) * db(-30.0 + 30.0 * u.powf(0.8));
    }
    vec![x]
}

/// Noise downlifter: starts on sample 0 at full level and falls, filter
/// closing from 12 kHz to ~150 Hz.
fn noise_downlifter(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let mut ch = stereo_noise(n, 0.35, false, seed);
    for (k, c) in ch.iter_mut().enumerate() {
        let det = if k == 0 { 1.0 } else { 1.04 };
        let mut whistle = c.clone();
        sweep(c, BP, 1.0, |u| 12_000.0 * det * (150.0f32 / 12_000.0).powf(u.powf(0.6)));
        sweep(&mut whistle, BP, 8.0, |u| 8000.0 * det * (250.0f32 / 8000.0).powf(u.powf(0.6)));
        add(c, &whistle, 0.3, 0);
    }
    shape(&mut ch, |u| db(-40.0 * u.powf(0.8)) * (1.0 - u).powf(0.3));
    // a burst on the downbeat
    let mut burst = stereo_noise(ns(0.25), 0.6, false, seed + 5);
    for c in burst.iter_mut() {
        lp(c, 9000.0);
        let m = c.len();
        for (i, v) in c.iter_mut().enumerate() {
            *v *= (-(i as f32) / (0.04 * SR)).exp() * (1.0 - i as f32 / m as f32);
        }
    }
    add_ch(&mut ch, &burst, 0.6, 0);
    let mut out = reverb(&ch, &rev(1.0, 0.8, 2.2).pre(10.0).low(300.0), 0.25, 0.0);
    cut(&mut out, n);
    out
}

/// "Jet" sweep: noise through a comb whose delay shrinks (rising) or grows
/// (falling), a matching low pass and an auto-pan.
fn jet_sweep(bars: u32, up: bool, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let src = stereo_noise(n, 0.5, false, seed);
    let mut out = Vec::with_capacity(2);
    for (k, c) in src.into_iter().enumerate() {
        let mut y = vec![0.0f32; n];
        let mut buf = vec![0.0f32; 1024];
        let mut w = 0usize;
        for i in 0..n {
            let u = i as f32 / n as f32;
            let pos = if up { u } else { 1.0 - u };
            let d_ms = 9.0 * (0.25f32 / 9.0).powf(pos) * if k == 0 { 1.0 } else { 1.07 };
            let d = (d_ms * 0.001 * SR).clamp(1.0, 1000.0);
            let rp = (w as f32 + 1024.0 - d) % 1024.0;
            let i0 = rp.floor() as usize;
            let fr = rp - i0 as f32;
            let del = buf[i0 % 1024] * (1.0 - fr) + buf[(i0 + 1) % 1024] * fr;
            let v = c[i] + 0.65 * del;
            buf[w] = v;
            w = (w + 1) % 1024;
            y[i] = v;
        }
        if up {
            sweep(&mut y, LP, 1.1, |u| 600.0 * (18_000.0f32 / 600.0).powf(u.powf(1.1)));
        } else {
            sweep(&mut y, LP, 1.1, |u| 18_000.0 * (500.0f32 / 18_000.0).powf(u.powf(0.7)));
        }
        hp(&mut y, 150.0);
        out.push(y);
    }
    // level: rises into the end (up) or falls from sample 0 (down); slow auto-pan
    let pan_hz = 0.5 * BPM / 60.0 / 4.0 * if up { 2.0 } else { 1.0 };
    for (k, c) in out.iter_mut().enumerate() {
        for (i, v) in c.iter_mut().enumerate() {
            let u = i as f32 / n as f32;
            let lvl = if up { db(-30.0 + 30.0 * u.powf(0.9)) } else { db(-36.0 * u.powf(0.8)) * (1.0 - u).powf(0.3) };
            let p = 0.5 + 0.35 * (TAU32 * pan_hz * i as f32 / SR).sin();
            let pg = if k == 0 { (1.0 - p).sqrt() } else { p.sqrt() } * std::f32::consts::SQRT_2;
            *v *= lvl * pg;
        }
    }
    out
}

/// A crash reversed so its attack lands on the very last sample, with a
/// reversed reverb swelling into it.
fn reverse_crash(bars: u32, dark: bool, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let len = n as f32 / SR + 0.4;
    let base = if dark { Cym { f_lo: 400.0, f_hi: 9000.0, tilt: -0.2, n_hp: 2500.0, n_lp: 8000.0, lp: 9000.0, ..CRASH } } else { CRASH };
    let c = cymbal(&Cym { t60: len * 0.9, noise_t60: len * 0.8, len, swell: 0.8, width: 0.7, seed, ..base });
    let wet = reverb_wet(&c, &rev(1.0, 0.85, 3.0).pre(5.0).low(500.0), 0.0);
    let mut out = c;
    add_ch(&mut out, &wet, 0.35, 0);
    even(&mut out);
    for ch in out.iter_mut() {
        ch.truncate(ns(len));
        ch.reverse();
        let m = ch.len();
        if m >= n {
            ch.drain(..m - n);
        } else {
            let mut pad = vec![0.0f32; n - m];
            pad.extend_from_slice(ch);
            *ch = pad;
        }
    }
    // keep the very start silent-ish and swell like a real reverse cymbal
    shape(&mut out, |u| smooth01(u * 4.0));
    out
}

/// Sub drop: a sine falling from `f0` to `f1` Hz (time constant `tau` s),
/// level decaying to -60 dB at `t60` s, optional drive.
fn sub_drop(f0: f32, f1: f32, tau: f32, t60: f32, drv: f32, lp_hz: f32) -> Vec<f32> {
    let n = ns(t60 + 0.05);
    let mut ph = 0.0f64;
    let mut x = vec![0.0f32; n];
    for (i, v) in x.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let f = f1 + (f0 - f1) * (-t / tau).exp();
        let (p, _) = step(&mut ph, f);
        *v = (p * TAU64).sin() as f32 * dec60(t, t60);
    }
    if drv > 0.0 {
        drive(&mut x, 1.0 + 6.0 * drv, 0.05);
        lp(&mut x, lp_hz);
    }
    x
}

fn impact_boom(seed: u32) -> Chans {
    let mut x = sub_drop(120.0, 38.0, 0.12, 2.6, 0.35, 3000.0);
    let mut nz = Noise::new(seed);
    let mut l = svf(LP, 2500.0, 0.7);
    for (i, v) in x.iter_mut().enumerate().take(ns(0.4)) {
        let t = i as f32 / SR;
        *v += tick(&mut l, nz.white()) * (-t / 0.04).exp() * 0.8;
    }
    let k = kick(&Kick { f: 45.0, decay: 600.0, drive: 0.5, seed: seed + 1, ..KICK });
    add(&mut x, &k, 0.8, 0);
    reverb(&vec![x], &rev(1.0, 0.9, 3.0).pre(10.0).low(90.0).damp(4000.0), 0.35, 2.0)
}

fn impact_reverb_hit(seed: u32) -> Chans {
    let mut x = snare(&Snare { f: 190.0, noise: 1.0, noise_ms: 260.0, crack: 0.8, drive: 0.5, seed, ..SNARE });
    let k = kick(&Kick { f: 50.0, decay: 300.0, drive: 0.4, seed: seed + 1, ..KICK });
    add(&mut x, &k, 0.7, 0);
    let w = reverb_wet(&vec![x.clone()], &rev(1.0, 1.0, 3.6).pre(25.0).low(200.0).damp(7000.0), 2.8);
    let mut out = vec![x.clone(), x];
    add_ch(&mut out, &w, 0.9, 0);
    out
}

fn impact_short(seed: u32) -> Chans {
    let mut x = kick(&Kick { f: 55.0, decay: 280.0, click: 0.5, drive: 0.5, seed, ..KICK });
    let s = snare(&Snare { f: 210.0, noise: 0.9, crack: 0.7, drive: 0.4, seed: seed + 1, ..SNARE });
    add(&mut x, &s, 0.7, 0);
    let mut c = cymbal(&Cym { t60: 0.7, noise_t60: 0.5, len: 0.9, seed: seed + 2, ..CRASH });
    let g = 0.35 / peak_ch(&c).max(1e-6);
    gain_ch(&mut c, g);
    let mut out = vec![x.clone(), x];
    add_ch(&mut out, &c, 1.0, 0);
    even(&mut out);
    reverb(&out, &rev(0.0, 0.6, 0.9).low(200.0), 0.2, 0.6)
}

fn impact_metal(seed: u32) -> Chans {
    let mut nz = Noise::new(seed);
    let m: Vec<(f32, f32, f32, f32)> = (0..24).map(|_| (180.0 * (5000.0f32 / 180.0).powf(nz.unit()), 0.4 + 0.6 * nz.unit(), 0.6 + 1.2 * nz.unit(), 0.0)).collect();
    let mut x = modes(&m, ns(2.0));
    normalize(&mut x, 0.7);
    let boom = sub_drop(90.0, 40.0, 0.1, 1.6, 0.2, 2000.0);
    add(&mut x, &boom, 0.9, 0);
    let mut h = svf(BP, 3000.0, 1.0);
    for (i, v) in x.iter_mut().enumerate().take(ns(0.05)) {
        *v += tick(&mut h, nz.white()) * (-(i as f32) / (0.006 * SR)).exp();
    }
    reverb(&vec![x], &rev(1.0, 0.85, 2.5).pre(12.0).low(150.0).damp(6000.0), 0.3, 1.6)
}

fn impact_gated(seed: u32) -> Chans {
    let mut x = kick(&Kick { f: 50.0, decay: 400.0, drive: 0.4, seed, ..KICK });
    let s = snare(&Snare { f: 180.0, noise: 1.0, noise_ms: 300.0, drive: 0.4, seed: seed + 1, ..SNARE });
    add(&mut x, &s, 0.9, 0);
    gated(&vec![x], &rev(0.0, 1.0, 3.0).damp(8000.0).low(120.0).pre(3.0), 0.9, 420.0, 80.0)
}

pub(crate) fn specs() -> Vec<Spec> {
    let mut v = Vec::new();
    // risers: end on their last bar line
    for (bars, seed) in [(2u32, 901u32), (4, 902), (8, 903)] {
        v.push(
            spec(
                format!("fx/riser/noise-uplifter-{bars}bar.wav"),
                format!("Noise Uplifter {bars} Bars"),
                "riser",
                &["bright", "airy", "big", "euphoric"],
                &["edm", "house", "techno", "future-bass", "dubstep", "pop", "tech-house", "dnb"],
                move || noise_uplifter(bars, seed),
            )
            .bars(bars)
            .peak(-3.0)
            .fades(5.0, 3.0),
        );
    }
    for (bars, seed) in [(4u32, 911u32), (8, 912)] {
        v.push(
            spec(
                format!("fx/riser/synth-pitch-riser-{bars}bar.wav"),
                format!("Synth Pitch Riser {bars} Bars"),
                "riser",
                &["bright", "big", "euphoric", "detuned", "wide"],
                &["edm", "future-bass", "dubstep", "pop", "house"],
                move || synth_riser(bars, 48.0, 84.0, seed),
            )
            .bars(bars)
            .peak(-3.0)
            .fades(5.0, 3.0),
        );
    }
    v.push(
        spec("fx/riser/sine-tension-riser-2bar.wav", "Sine Tension Riser 2 Bars", "riser", &["clean", "dark", "mono"], &["techno", "dnb", "dubstep", "trap", "drill"], || {
            sine_riser(2)
        })
        .bars(2)
        .peak(-4.0)
        .fades(5.0, 3.0),
    );
    // downlifters: transient on sample 0
    for (bars, seed) in [(1u32, 931u32), (2, 932), (4, 933)] {
        v.push(
            spec(
                format!("fx/downlifter/noise-downlifter-{bars}bar.wav"),
                format!("Noise Downlifter {bars} Bars"),
                "downlifter",
                &["airy", "wide", "dark"],
                &["edm", "house", "techno", "future-bass", "dubstep", "pop", "tech-house", "dnb"],
                move || noise_downlifter(bars, seed),
            )
            .bars(bars)
            .peak(-3.0)
            .fades(0.15, 5.0),
        );
    }
    // impacts
    v.push(spec("fx/impact/boom.wav", "Boom Impact", "impact", &["big", "deep", "dark", "wide"], &["edm", "dubstep", "future-bass", "trap", "techno"], || impact_boom(951)));
    v.push(
        spec("fx/impact/sub-impact.wav", "Sub Impact", "impact", &["deep", "clean", "mono", "big"], &["edm", "dubstep", "trap", "drill", "future-bass", "dnb"], || {
            let mut x = sub_drop(62.0, 34.0, 0.15, 2.4, 0.15, 1200.0);
            let k = kick(&Kick { f: 42.0, decay: 500.0, sub: 0.5, sub_ms: 1500.0, click: 0.35, drive: 0.3, seed: 961, ..KICK });
            add(&mut x, &k, 0.7, 0);
            vec![x]
        })
        .hp(20.0),
    );
    v.push(spec("fx/impact/reverb-hit.wav", "Reverb Hit", "impact", &["big", "wide", "long", "bright"], &["edm", "pop", "future-bass", "synthwave", "house"], || impact_reverb_hit(971)).trim(-60.0));
    v.push(spec("fx/impact/short-hit.wav", "Short Hit", "impact", &["short", "punchy", "hard"], &["edm", "pop", "trap", "dubstep", "dnb"], || impact_short(981)));
    v.push(spec("fx/impact/metal-slam.wav", "Metal Slam Impact", "impact", &["metallic", "big", "dark", "aggressive"], &["dubstep", "techno", "dnb", "drill"], || impact_metal(991)).trim(-60.0));
    v.push(spec("fx/impact/gated-hit.wav", "Gated 80s Hit", "impact", &["retro", "big", "vintage"], &["synthwave", "pop"], || impact_gated(995)));
    // sweeps
    for (bars, seed) in [(1u32, 1001u32), (2, 1002), (4, 1003)] {
        v.push(
            spec(
                format!("fx/sweep-up/white-sweep-up-{bars}bar.wav"),
                format!("White Sweep Up {bars} Bars"),
                "sweep-up",
                &["airy", "bright", "wide"],
                &["edm", "house", "tech-house", "techno", "future-bass", "pop", "dnb"],
                move || jet_sweep(bars, true, seed),
            )
            .bars(bars)
            .peak(-4.0)
            .fades(5.0, 3.0),
        );
        if bars == 4 {
            continue;
        }
        v.push(
            spec(
                format!("fx/sweep-down/white-sweep-down-{bars}bar.wav"),
                format!("White Sweep Down {bars} Bars"),
                "sweep-down",
                &["airy", "wide", "dark"],
                &["edm", "house", "tech-house", "techno", "future-bass", "pop", "dnb"],
                move || jet_sweep(bars, false, seed + 50),
            )
            .bars(bars)
            .peak(-4.0)
            .fades(0.15, 5.0),
        );
    }
    // reverse cymbals: the crash attack lands on the last sample
    for (bars, dark, seed) in [(1u32, false, 1101u32), (2, false, 1102)] {
        let (slug, name, tags): (&str, &str, &[&'static str]) =
            if dark { ("reverse-crash-dark", "Dark Reverse Crash", &["dark", "wide", "airy"]) } else { ("reverse-crash", "Reverse Crash", &["bright", "wide", "airy"]) };
        v.push(
            spec(
                format!("fx/reverse-cymbal/{slug}-{bars}bar.wav"),
                format!("{name} {bars} Bar{}", if bars > 1 { "s" } else { "" }),
                "reverse-cymbal",
                tags,
                &["edm", "house", "pop", "future-bass", "dubstep", "trap", "techno", "rnb"],
                move || reverse_crash(bars, dark, seed),
            )
            .bars(bars)
            .peak(-3.0)
            .fades(5.0, 2.0),
        );
    }
    // sub drops
    v.push(
        spec("fx/sub-drop/long.wav", "Long Sub Drop", "sub-drop", &["deep", "long", "clean", "mono"], &["edm", "trap", "dubstep", "future-bass", "drill"], || {
            vec![sub_drop(110.0, 30.0, 0.6, 3.0, 0.15, 1500.0)]
        })
        .hp(18.0),
    );
    v.push(
        spec("fx/sub-drop/short.wav", "Short Sub Drop", "sub-drop", &["deep", "short", "punchy", "mono"], &["trap", "drill", "edm", "dnb"], || {
            vec![sub_drop(100.0, 35.0, 0.2, 1.2, 0.1, 1500.0)]
        })
        .hp(18.0),
    );
    v.push(
        spec("fx/sub-drop/distorted.wav", "Distorted Sub Drop", "sub-drop", &["distorted", "aggressive", "dirty", "deep"], &["dubstep", "phonk", "trap", "edm"], || {
            vec![sub_drop(120.0, 30.0, 0.45, 2.5, 0.9, 2000.0)]
        })
        .hp(18.0),
    );
    v
}
