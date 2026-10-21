//! Wave 7b transitions (research/14 §2.1): more risers, downlifters,
//! reverse-reverb and volume swells, reverse cymbals, whooshes and tape /
//! vinyl stops. Tempo-synced files are exactly N bars at 128 BPM. Risers,
//! swells and reverse cymbals reach their loudest point on the very last
//! sample; whooshes cross the listener in their last ~10 % (aligned to the
//! boundary by their end); tape stops come to a halt on their last sample;
//! downlifters start at full level on sample 0.

use super::drums::{cymbal, kick, snare, Cym, Kick, Snare, CRASH, KICK, SNARE};
use super::kit::*;
use super::library::{spec, Spec};
use super::synth::*;

const EDM: &[&str] = &["edm", "house", "future-bass", "dubstep", "pop", "tech-house", "techno", "dnb"];

// ── Risers ──────────────────────────────────────────────────────────────

/// Filtered saw chord: a resonant low pass opening from ~180 Hz to 14 kHz,
/// detune widening, an octave layer fading in, air on top, a hall behind.
fn saw_riser(bars: u32, notes: &'static [f32], seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let mut ch = supersaw(notes, n, 5, 0.9, seed, |u| 0.08 + 0.22 * u, |_| 0.0);
    let up: Vec<f32> = notes.iter().map(|x| x + 12.0).collect();
    let mut oct = supersaw(&up, n, 3, 1.0, seed + 1, |u| 0.1 + 0.2 * u, |_| 0.0);
    shape(&mut oct, |u| 0.6 * smooth01((u - 0.35) / 0.65));
    add_ch(&mut ch, &oct, 1.0, 0);
    sweep_ch(&mut ch, LP, 1.6, |u| expi(180.0, 14_000.0, u.powf(1.5)));
    sweep_ch(&mut ch, HP, 0.7, |u| expi(40.0, 260.0, u.powf(2.0)));
    let mut air = stereo_noise(n, 0.3, false, seed + 2);
    sweep_ch(&mut air, HP, 0.8, |u| expi(3000.0, 9000.0, u));
    shape(&mut air, |u| 0.06 * smooth01(u * 1.2));
    add_ch(&mut ch, &air, 1.0, 0);
    shape(&mut ch, |u| db(-26.0 + 26.0 * u.powf(0.9)));
    let mut wet = reverb_wet(&ch, &rev(1.0, 0.8, 2.6).pre(18.0).low(300.0), 0.0);
    shape(&mut wet, |u| 0.12 + 0.3 * u);
    add_ch(&mut ch, &wet, 1.0, 0);
    cut(&mut ch, n);
    ch
}

/// Tension: a sub sine rising an octave under a dissonant cluster that
/// rises too, with a tremolo speeding up from 2 to 16 Hz, plus hiss.
fn tension_riser(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let len = n as f32 / SR;
    let sub = tone(n, 0.0, |t| hz(31.0 + 12.0 * (t / len).powf(1.3)), |t| 0.9 * smooth01(t / len * 3.0));
    let mut out = to_stereo(vec![sub]);
    let cluster = [60.0f32, 61.0, 66.0, 67.0, 72.5];
    let mut nz = Noise::new(seed);
    for (k, &note) in cluster.iter().enumerate() {
        let ph0 = nz.unit();
        let vr = nz.range(4.5, 6.5);
        let mut tr_ph = nz.unit();
        let mut x = vec![0.0f32; n];
        let mut ph = nz.unit() as f64;
        for (i, v) in x.iter_mut().enumerate() {
            let t = i as f32 / SR;
            let u = t / len;
            let nn = note + 12.0 * u.powf(1.6) + 0.15 * (TAU32 * (ph0 + vr * t)).sin();
            let (p, dt) = step(&mut ph, hz(nn));
            let rate = expi(2.0, 16.0, u);
            tr_ph = (tr_ph + rate / SR).fract();
            let trem = 1.0 - 0.6 * (0.5 - 0.5 * (TAU32 * tr_ph).cos());
            *v = (0.7 * (p * TAU64).sin() as f32 + 0.3 * saw(p, dt)) * trem;
        }
        lp(&mut x, 6000.0);
        let pan = 0.15 + 0.7 * k as f32 / (cluster.len() - 1) as f32;
        let s = pan_mono(&x, |_| pan);
        add_ch(&mut out, &s, 0.22, 0);
    }
    let mut hiss = stereo_noise(n, 0.2, false, seed + 1);
    sweep_ch(&mut hiss, BP, 0.9, |u| expi(1200.0, 10_000.0, u));
    shape(&mut hiss, |u| 0.25 * u * u);
    add_ch(&mut out, &hiss, 1.0, 0);
    shape(&mut out, |u| db(-30.0 + 30.0 * u.powf(0.8)));
    let mut out = reverb(&out, &rev(1.0, 0.75, 2.2).pre(15.0).low(250.0), 0.18, 0.0);
    cut(&mut out, n);
    out
}

/// Accelerating snare roll (8ths → 16ths → 32nds, pitch rising) layered
/// with a stereo noise uplifter.
fn snare_noise_riser(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let plan: Vec<(f32, f32, usize)> = if bars == 1 { vec![(0.0, 0.5, 8), (0.5, 0.75, 16), (0.75, 1.0, 32)] } else { vec![(0.0, 1.0, 8), (1.0, 1.5, 16), (1.5, 1.75, 32), (1.75, 2.0, 64)] };
    let mut roll = vec![0.0f32; n];
    let mut k = 0u32;
    for (b0, b1, per) in plan {
        let stp = BAR as f64 / per as f64;
        let mut pos = b0 as f64 * BAR as f64;
        while pos < b1 as f64 * BAR as f64 - 0.5 {
            let at = pos.round() as usize;
            let u = at as f32 / n as f32;
            let hit = snare(&Snare { f: 200.0 * (8.0 * u / 12.0).exp2(), body: 0.6, body_ms: 100.0, noise: 0.95, n_hp: 1800.0, n_lp: 12_000.0, noise_ms: 150.0, crack: 0.6, drive: 0.4, seed: seed.wrapping_add(k * 17), ..SNARE });
            add(&mut roll, &hit, 0.3 + 0.7 * u.powf(1.2), at);
            k += 1;
            pos += stp;
        }
    }
    roll.truncate(n);
    sweep(&mut roll, LP, 0.8, |u| expi(3000.0, 16_000.0, u));
    let mut out = to_stereo(vec![roll]);
    let mut nn = stereo_noise(n, 0.3, false, seed + 1);
    sweep_ch(&mut nn, BP, 1.0, |u| expi(400.0, 12_000.0, u.powf(1.2)));
    shape(&mut nn, |u| 0.5 * db(-24.0 + 24.0 * u));
    add_ch(&mut out, &nn, 1.0, 0);
    shape(&mut out, |u| db(-14.0 + 14.0 * u));
    let mut out = reverb(&out, &rev(2.0, 0.55, 1.4).pre(10.0).low(400.0), 0.2, 0.0);
    cut(&mut out, n);
    out
}

/// Shepard-style rise: octave-spaced partials gliding up under a fixed
/// spectral bell, so the pitch seems to climb forever; level rises into the end.
fn shepard_riser(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let octs = 8;
    let travel = 1.5 * bars as f32; // octaves climbed over the file
    let mut out: Chans = Vec::new();
    for c in 0..2u32 {
        let mut nz = Noise::new(seed + c * 31);
        let det = if c == 0 { 1.0 } else { 1.004 };
        let mut ph: Vec<f64> = (0..octs).map(|_| nz.unit() as f64).collect();
        let mut x = vec![0.0f32; n];
        for (i, v) in x.iter_mut().enumerate() {
            let u = i as f32 / n as f32;
            let mut s = 0.0;
            for k in 0..octs {
                let o = (k as f32 + travel * u).rem_euclid(octs as f32); // 0..8 octaves above the base
                let f = 32.7 * det * o.exp2();
                let w = (-((o - 4.2) / 1.4).powi(2)).exp();
                let (p, _) = step(&mut ph[k], f);
                let pp = p * TAU64;
                s += w * (pp.sin() as f32 + 0.18 * (2.0 * pp).sin() as f32);
            }
            *v = s * 0.35;
        }
        out.push(x);
    }
    let mut air = stereo_noise(n, 0.3, false, seed + 7);
    sweep_ch(&mut air, BP, 1.2, |u| expi(800.0, 9000.0, u));
    shape(&mut air, |u| 0.15 * u.powf(1.5));
    add_ch(&mut out, &air, 1.0, 0);
    shape(&mut out, |u| db(-28.0 + 28.0 * u.powf(0.85)));
    let mut out = reverb(&out, &rev(1.0, 0.8, 2.4).pre(20.0).low(300.0), 0.25, 0.0);
    cut(&mut out, n);
    out
}

/// Low rumble rising: brown noise through a band pass climbing from 60 Hz
/// to 900 Hz, a sub drone climbing an octave, drive growing (mono).
fn rumble_riser(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let len = n as f32 / SR;
    let mut nz = Noise::new(seed);
    let mut x: Vec<f32> = (0..n).map(|_| nz.brown()).collect();
    sweep(&mut x, BP, 2.2, |u| expi(60.0, 900.0, u.powf(1.3)));
    normalize(&mut x, 0.8);
    let sub = tone(n, 0.15, |t| hz(29.0 + 12.0 * (t / len).powf(1.5)), |_| 0.6);
    add(&mut x, &sub, 1.0, 0);
    for (i, v) in x.iter_mut().enumerate() {
        let u = i as f32 / n as f32;
        let k = 1.0 + 5.0 * u * u;
        *v = (k * *v).tanh() / k.tanh();
    }
    sweep(&mut x, LP, 0.8, |u| expi(400.0, 6000.0, u));
    let mut out = vec![x];
    shape(&mut out, |u| db(-30.0 + 30.0 * u.powf(0.8)));
    out
}

/// Plucks on an accelerating grid climbing a minor pentatonic over two
/// octaves, ping-pong echoes and a hall.
fn pluck_riser(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let scale = [0.0f32, 3.0, 5.0, 7.0, 10.0];
    let plan: Vec<(f32, f32, usize)> = vec![(0.0, 0.5, 8), (0.5, 0.75, 16), (0.75, 0.9375, 32), (0.9375, 1.0, 64)];
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    let mut k = 0usize;
    let mut cache: Vec<Option<Vec<f32>>> = vec![None; 16];
    for (u0, u1, per) in plan {
        let stp = BAR as f64 / per as f64;
        let mut pos = u0 as f64 * n as f64;
        while pos < u1 as f64 * n as f64 - 0.5 {
            let at = pos.round() as usize;
            let u = at as f32 / n as f32;
            let deg = ((u * 10.0) as usize).min(10) + (k % 2);
            let note = 60.0 + 12.0 * (deg / 5) as f32 + scale[deg % 5];
            let idx = deg.min(15);
            if cache[idx].is_none() {
                cache[idx] = Some(pluck(note, 0.35, 0.28, 0.6, seed + idx as u32));
            }
            let p = cache[idx].as_ref().unwrap();
            let g = 0.35 + 0.65 * u.powf(1.1);
            let side = if k % 2 == 0 { (1.0, 0.55) } else { (0.55, 1.0) };
            add(&mut l, p, g * side.0, at);
            add(&mut r, p, g * side.1, at);
            k += 1;
            pos += stp;
        }
    }
    let mut ch = vec![l, r];
    even(&mut ch);
    // ping-pong: dotted-eighth echo into the opposite side
    let d = s16(3.0);
    let (src_l, src_r) = (ch[0].clone(), ch[1].clone());
    add(&mut ch[1], &src_l, 0.35, d);
    add(&mut ch[0], &src_r, 0.35, d);
    add(&mut ch[0], &src_l, 0.15, 2 * d);
    add(&mut ch[1], &src_r, 0.15, 2 * d);
    even(&mut ch);
    sweep_ch(&mut ch, LP, 0.9, |u| expi(1500.0, 16_000.0, u));
    cut(&mut ch, n);
    shape(&mut ch, |u| db(-12.0 + 12.0 * u));
    let mut out = reverb(&ch, &rev(1.0, 0.7, 2.0).pre(20.0).low(300.0), 0.25, 0.0);
    cut(&mut out, n);
    out
}

/// Short airy noise wash: pink noise opening upward, a big room behind it,
/// most of the level arriving in the last half.
fn noise_wash(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let mut ch = stereo_noise(n, 0.25, true, seed);
    sweep_ch(&mut ch, HP, 0.8, |u| expi(300.0, 5000.0, u.powf(1.2)));
    sweep_ch(&mut ch, LP, 0.9, |u| expi(2500.0, 18_000.0, u));
    shape(&mut ch, |u| db(-36.0 + 36.0 * u.powf(1.4)));
    let mut out = reverb(&ch, &rev(1.0, 0.9, 3.0).pre(10.0).low(500.0), 0.35, 0.0);
    shape(&mut out, |u| smooth01(u * 5.0));
    cut(&mut out, n);
    out
}

// ── Downlifters ─────────────────────────────────────────────────────────

/// Saw stack falling two octaves (fast, then slowing), filter closing.
fn pitch_fall(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let mut ch = supersaw(&[67.0, 74.0, 79.0], n, 5, 0.9, seed, |u| 0.15 + 0.2 * u, |u| -24.0 * u.powf(0.55));
    sweep_ch(&mut ch, LP, 1.2, |u| expi(14_000.0, 350.0, u.powf(0.6)));
    shape(&mut ch, |u| db(-38.0 * u.powf(0.8)) * (1.0 - u).powf(0.4));
    let mut burst = stereo_noise(ns(0.3), 0.5, false, seed + 1);
    for c in burst.iter_mut() {
        lp(c, 10_000.0);
        let m = c.len() as f32;
        for (i, v) in c.iter_mut().enumerate() {
            *v *= (-(i as f32) / (0.05 * SR)).exp() * (1.0 - i as f32 / m);
        }
    }
    add_ch(&mut ch, &burst, 0.35, 0);
    let mut out = reverb(&ch, &rev(1.0, 0.8, 2.4).pre(5.0).low(300.0), 0.25, 0.0);
    cut(&mut out, n);
    out
}

/// A held minor chord whose low pass closes from 14 kHz to 150 Hz while it
/// fades, a kick-and-noise hit on the downbeat.
fn chord_fall(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let mut ch = supersaw(&[48.0, 55.0, 60.0, 63.0, 67.0], n, 4, 0.9, seed, |_| 0.15, |_| 0.0);
    sweep_ch(&mut ch, LP, 1.3, |u| expi(14_000.0, 150.0, u.powf(0.7)));
    let mut nn = stereo_noise(n, 0.3, false, seed + 1);
    sweep_ch(&mut nn, BP, 1.0, |u| expi(9000.0, 300.0, u.powf(0.6)));
    add_ch(&mut ch, &nn, 0.25, 0);
    shape(&mut ch, |u| db(-34.0 * u.powf(0.9)) * (1.0 - u).powf(0.3));
    let k = kick(&Kick { f: 45.0, decay: 700.0, drive: 0.4, seed: seed + 2, ..KICK });
    add_ch(&mut ch, &vec![k], 0.7, 0);
    let mut out = reverb(&ch, &rev(1.0, 0.85, 2.6).pre(5.0).low(250.0), 0.2, 0.0);
    cut(&mut out, n);
    out
}

/// Crash + noise falling: a downbeat crash with a sweeping noise tail.
fn crash_down(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let len = n as f32 / SR;
    let mut c = cymbal(&Cym { t60: len * 0.8, noise_t60: len * 0.6, len, seed, ..CRASH });
    let mut nn = stereo_noise(n, 0.35, false, seed + 1);
    sweep_ch(&mut nn, BP, 1.1, |u| expi(10_000.0, 200.0, u.powf(0.6)));
    shape(&mut nn, |u| db(-36.0 * u.powf(0.8)) * (1.0 - u).powf(0.3));
    let g = 0.6 / peak_ch(&c).max(1e-6);
    gain_ch(&mut c, g);
    add_ch(&mut c, &nn, 0.8, 0);
    let k = kick(&Kick { f: 48.0, decay: 500.0, drive: 0.5, seed: seed + 2, ..KICK });
    add_ch(&mut c, &vec![k], 0.6, 0);
    let mut out = reverb(&c, &rev(1.0, 0.8, 2.2).pre(5.0).low(300.0), 0.2, 0.0);
    cut(&mut out, n);
    out
}

/// Deep fall: a driven sine dropping from 90 Hz to 28 Hz over the bar, with
/// a low-passed noise thump on the downbeat (mono).
fn deep_fall(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let len = n as f32 / SR;
    let mut x = tone(n, 0.1, |t| expi(90.0, 28.0, (t / len).powf(0.6)), |t| dec60(t, len * 1.1));
    drive(&mut x, 2.5, 0.05);
    lp(&mut x, 1800.0);
    let mut nz = Noise::new(seed);
    let mut f = svf(LP, 900.0, 0.7);
    for (i, v) in x.iter_mut().enumerate().take(ns(0.25)) {
        *v += tick(&mut f, nz.white()) * (-(i as f32) / (0.03 * SR)).exp() * 0.6;
    }
    vec![x]
}

// ── Swells ──────────────────────────────────────────────────────────────

/// A soft detuned saw chord stab (the source for reverse swells).
fn pad_stab(notes: &[f32], len_s: f32, seed: u32) -> Chans {
    let n = ns(len_s);
    let mut ch = supersaw(notes, n, 4, 0.8, seed, |_| 0.12, |_| 0.0);
    sweep_ch(&mut ch, LP, 0.7, |_| 3500.0);
    shape(&mut ch, |u| smooth01(u * 20.0) * (1.0 - u).powf(1.5));
    ch
}

fn pad_swell(bars: u32, notes: &'static [f32], seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let src = pad_stab(notes, 0.7, seed);
    let mut out = reverse_swell(&src, &rev(1.0, 0.95, 7.0).pre(0.5).low(180.0).damp(6000.0), n, 0.45);
    shape(&mut out, |u| smooth01(u * 3.0));
    out
}

/// Formant "aah" choir chord (three voices per note) for the vocal swell.
pub(crate) fn choir(notes: &[f32], len_s: f32, vowel: Vowel, seed: u32) -> Chans {
    let n = ns(len_s);
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    let mut k = 0u32;
    for (j, &note) in notes.iter().enumerate() {
        for v in 0..3 {
            let det = [-0.08f32, 0.0, 0.09][v];
            let x = sung(n, note + det, vowel.scale(if note >= 60.0 { 1.12 } else { 1.0 }), 0.08, len_s - 0.25, 0.2, 0.25, seed + k * 13);
            let pan = (0.5 + 0.35 * ([-1.0f32, 0.2, 1.0][v]) * if j % 2 == 0 { 1.0 } else { -0.7 }).clamp(0.0, 1.0);
            let s = pan_mono(&x, |_| pan);
            add(&mut l, &s[0], 1.0, 0);
            add(&mut r, &s[1], 1.0, 0);
            k += 1;
        }
    }
    vec![l, r]
}

fn vocal_swell(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let mut src = choir(&[57.0, 60.0, 64.0], 0.9, AH, seed);
    // a sung stab that dies away, so the reverb peaks right after its onset
    shape(&mut src, |u| (1.0 - u).powf(1.5));
    let mut out = reverse_swell(&src, &rev(1.0, 0.95, 6.5).pre(0.5).low(200.0).damp(7000.0), n, 0.5);
    shape(&mut out, |u| smooth01(u * 3.0));
    out
}

/// Inharmonic bell / metal partials, reversed through a long plate.
fn metal_swell(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let mut nz = Noise::new(seed);
    let base = 330.0;
    let ratios = [1.0f32, 2.01, 2.76, 3.52, 4.18, 5.43, 6.79, 8.21, 9.6, 11.3];
    let m: Vec<(f32, f32, f32, f32)> = ratios.iter().enumerate().map(|(i, r)| (base * r * (1.0 + 0.002 * nz.white()), 1.0 / (1.0 + i as f32 * 0.4), 2.5 / (1.0 + 0.25 * i as f32), nz.unit())).collect();
    let a = modes(&m, ns(2.5));
    let m2: Vec<(f32, f32, f32, f32)> = m.iter().map(|&(f, a, t, p)| (f * 1.003, a, t, (p + 0.25).fract())).collect();
    let b = modes(&m2, ns(2.5));
    let src = stereo_pair(&a, &b, 0.6);
    let mut out = reverse_swell(&src, &rev(2.0, 0.95, 6.0).pre(0.5).low(300.0).damp(9000.0), n, 0.5);
    shape(&mut out, |u| smooth01(u * 3.0));
    out
}

/// Volume swell: a chord fading in exponentially with its filter opening.
fn volume_swell(bars: u32, notes: &'static [f32], seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let mut ch = supersaw(notes, n, 5, 0.9, seed, |u| 0.1 + 0.08 * u, |_| 0.0);
    sweep_ch(&mut ch, LP, 0.9, |u| expi(400.0, 9000.0, u.powf(1.3)));
    sweep_ch(&mut ch, HP, 0.7, |_| 90.0);
    shape(&mut ch, |u| db(-40.0 + 40.0 * u.powf(0.7)));
    let mut out = reverb(&ch, &rev(1.0, 0.85, 3.0).pre(20.0).low(250.0), 0.3, 0.0);
    cut(&mut out, n);
    out
}

/// A snare through a big plate, reversed: the classic "reverse snare" suck-in.
fn reverse_snare(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let s = snare(&Snare { f: 195.0, noise: 1.0, noise_ms: 240.0, crack: 0.7, drive: 0.4, seed, ..SNARE });
    let mut out = reverse_swell(&vec![s], &rev(2.0, 0.9, 3.2).pre(0.5).low(250.0).damp(9000.0), n, 0.6);
    shape(&mut out, |u| smooth01(u * 4.0));
    out
}

// ── Reverse cymbals ─────────────────────────────────────────────────────

/// Any cymbal reversed so its attack lands on the last sample, with a
/// reversed hall swelling into it.
fn reverse_cym(bars: u32, base: Cym, rev_amt: f32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    let len = n as f32 / SR + 0.4;
    let c = cymbal(&Cym { t60: len * 0.9, noise_t60: len * 0.8, len, seed, ..base });
    let wet = reverb_wet(&c, &rev(1.0, 0.85, 3.2).pre(4.0).low(500.0), 0.0);
    let mut out = c;
    add_ch(&mut out, &wet, rev_amt, 0);
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
    shape(&mut out, |u| smooth01(u * 4.0));
    out
}

const DARK_CRASH: Cym = Cym { f_lo: 380.0, f_hi: 8500.0, tilt: -0.25, n_hp: 2200.0, n_lp: 7500.0, lp: 8500.0, ..CRASH };
const RIDE: Cym = Cym {
    modes: 150,
    f_lo: 700.0,
    f_hi: 12_000.0,
    tilt: -0.1,
    t60_exp: 0.2,
    noise: 0.3,
    n_hp: 5000.0,
    n_lp: 13_000.0,
    bell: 0.25,
    bell_hz: 760.0,
    bell_t60: 2.5,
    ping: 0.8,
    ping_hz: 5200.0,
    swell: 0.3,
    hp: 400.0,
    width: 0.35,
    ..CRASH
};
const SIZZLE: Cym = Cym { modes: 300, f_lo: 300.0, f_hi: 15_000.0, tilt: 0.05, noise: 1.6, n_hp: 3000.0, n_lp: 14_000.0, swell: 1.5, width: 0.8, ..CRASH };

// ── Whooshes ────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
struct Whoosh {
    len: f32,
    /// Where it passes the listener (0..1 of the length).
    at: f32,
    /// Approach width (s): smaller = faster pass.
    w: f32,
    /// Band centre at the crossing (Hz) and its Q.
    f: f32,
    q: f32,
    /// Doppler depth (0.1 subtle … 0.4 exaggerated).
    dop: f32,
    /// Narrow tonal whistle layer level.
    whistle: f32,
    /// Pan from → to (0 left … 1 right).
    p0: f32,
    p1: f32,
    pink: bool,
    room: f32,
    seed: u32,
}

const WH: Whoosh = Whoosh { len: 1.0, at: 0.92, w: 0.12, f: 1500.0, q: 1.2, dop: 0.25, whistle: 0.0, p0: 0.5, p1: 0.5, pink: false, room: 0.0, seed: 1 };

/// A pass-by: band-passed noise whose level follows 1/distance, centre
/// frequency shifting with the doppler factor (higher approaching, lower
/// receding), panning across, fast fall-off after the crossing.
fn whoosh(p: &Whoosh) -> Chans {
    let n = ns(p.len);
    let tc = p.at * p.len;
    let tail = (p.len - tc).max(0.02);
    let mut nz = Noise::new(p.seed);
    let flutter = Wander::new(&mut nz, 9.0, 23.0);
    let lvl = move |t: f32| -> f32 {
        let d = (t - tc) / p.w;
        let a = 1.0 / (1.0 + d * d).powf(0.8);
        if t > tc {
            a * (1.0 - ((t - tc) / tail).clamp(0.0, 1.0)).powf(1.5)
        } else {
            a
        }
    };
    let freq = move |t: f32| -> f32 {
        let d = (t - tc) / p.w;
        let vr = d / (1.0 + d * d).sqrt(); // -1 approaching … +1 receding
        let close = 1.0 / (1.0 + d * d).sqrt();
        p.f * (1.0 - p.dop * vr) * (0.55 + 0.45 * close)
    };
    let src = stereo_noise(n, 0.55, p.pink, p.seed + 1);
    let mut out: Chans = Vec::new();
    for (c, mut x) in src.into_iter().enumerate() {
        let off = if c == 0 { 0.985 } else { 1.015 };
        let mut wl = x.clone();
        sweep(&mut x, BP, p.q, |u| freq(u * p.len) * off);
        sweep(&mut x, LP, 0.7, |u| (freq(u * p.len) * 4.0).min(18_000.0));
        if p.whistle > 0.0 {
            sweep(&mut wl, BP, 14.0, |u| freq(u * p.len) * 2.1 * off);
            add(&mut x, &wl, p.whistle, 0);
        }
        for (i, v) in x.iter_mut().enumerate() {
            let t = i as f32 / SR;
            let fl = 1.0 + 0.18 * flutter.at(t + c as f32 * 0.013);
            *v *= lvl(t) * fl;
        }
        out.push(x);
    }
    // pan across (equal power), crossing at tc
    if (p.p1 - p.p0).abs() > 1e-3 {
        for i in 0..n {
            let t = i as f32 / SR;
            let d = (t - tc) / p.w;
            let pos = 0.5 + d.atan() / std::f32::consts::PI; // 0 → 1 through the crossing
            let pan = (p.p0 + (p.p1 - p.p0) * pos).clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
            let (gl, gr) = (pan.cos() * std::f32::consts::SQRT_2, pan.sin() * std::f32::consts::SQRT_2);
            let m = 0.5 * (out[0][i] + out[1][i]);
            let s = 0.5 * (out[0][i] - out[1][i]);
            out[0][i] = m * gl + s * 0.5;
            out[1][i] = m * gr - s * 0.5;
        }
    }
    if p.room > 0.0 {
        let mut o = reverb(&out, &rev(0.0, 0.5, 0.8).pre(5.0).low(300.0), p.room, 0.0);
        cut(&mut o, n);
        return o;
    }
    out
}

// ── Tape / vinyl stops ──────────────────────────────────────────────────

/// One bar of a simple beat (kick, snare, hats, bass, chord stabs) used as
/// the material a tape / turntable stop slows down; `bars` bars long.
fn beat_material(bars: f32, chords: bool, drums: bool, seed: u32) -> Chans {
    let n = (bars * BAR as f32) as usize;
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    let steps = (bars * 16.0) as usize;
    if drums {
        let k = kick(&Kick { f: 50.0, decay: 350.0, drive: 0.4, seed, ..KICK });
        let s = snare(&Snare { seed: seed + 1, ..SNARE });
        let h = super::drums::hat(&super::drums::Hat { seed: seed + 2, ..super::drums::HAT });
        for st in 0..steps {
            let at = s16(st as f32);
            match st % 16 {
                0 | 10 => {
                    add(&mut l, &k, 0.9, at);
                    add(&mut r, &k, 0.9, at);
                }
                4 | 12 => {
                    add(&mut l, &s, 0.6, at);
                    add(&mut r, &s, 0.6, at);
                }
                _ => {}
            }
            if st % 2 == 0 {
                let g = if st % 4 == 2 { 0.3 } else { 0.18 };
                add(&mut l, &h, g * 0.8, at);
                add(&mut r, &h, g, at);
            }
        }
        // bass: root notes on the 8ths, short and round
        for st in (0..steps).step_by(2) {
            let note = if (st / 8) % 2 == 0 { 36.0 } else { 39.0 };
            let mut b = pluck(note, 0.22, 0.18, 0.15, seed + 50 + st as u32);
            lp(&mut b, 900.0);
            add(&mut l, &b, 0.45, s16(st as f32));
            add(&mut r, &b, 0.45, s16(st as f32));
        }
    }
    if chords {
        let stab = pad_stab(&[60.0, 63.0, 67.0, 70.0], 0.5, seed + 3);
        for st in [0usize, 3, 6, 10, 14, 16, 19, 22, 26, 30] {
            if st < steps {
                add(&mut l, &stab[0], 0.55, s16(st as f32));
                add(&mut r, &stab[1], 0.55, s16(st as f32));
            }
        }
    }
    let mut ch = vec![l, r];
    cut(&mut ch, n);
    ch
}

/// Stop the material: speed(u) falls from 1 to 0 on the last sample, with
/// a little wow (tape) or a once-per-turn wobble and crackle (vinyl).
pub(crate) fn stop(src: Chans, n: usize, curve: f32, vinyl: bool, seed: u32) -> Chans {
    let mut nz = Noise::new(seed);
    let wow_ph = nz.unit();
    let len = n as f32 / SR;
    let speed = move |u: f32| -> f32 {
        let base = (1.0 - u).max(0.0).powf(curve);
        let t = u * len;
        let wob = if vinyl { 0.006 * (TAU32 * (wow_ph + 0.55 * t * base.max(0.2))).sin() } else { 0.004 * (TAU32 * (wow_ph + 4.5 * t)).sin() + 0.002 * (TAU32 * 0.9 * t).sin() };
        base * (1.0 + wob)
    };
    let mut out = varispeed(&src, n, 0.45, speed);
    if vinyl {
        // surface crackle slows with the platter: fewer, duller clicks
        let mut x = vec![0.0f32; n];
        for (i, v) in x.iter_mut().enumerate() {
            let u = i as f32 / n as f32;
            let s = (1.0 - u).powf(curve);
            if nz.unit() < 30.0 * s / SR {
                *v = nz.range(-1.0, 1.0) * (0.2 + 0.8 * nz.unit().powi(4)) * s;
            }
        }
        hp(&mut x, 800.0);
        sweep(&mut x, LP, 0.7, |u| expi(7000.0, 600.0, u));
        let pk = peak_ch(&out).max(1e-6);
        let g = 0.12 * pk / peak(&x).max(1e-6);
        add_ch(&mut out, &vec![x], g, 0);
    }
    cut(&mut out, n);
    out
}

/// Material length a stop of `n` samples consumes (∫ speed ≈ n / (curve + 1)) plus margin.
fn material_bars(n: usize, curve: f32) -> f32 {
    (n as f32 / (curve + 1.0) / BAR as f32) * 1.15 + 0.1
}

// ── Specs ───────────────────────────────────────────────────────────────

fn bar_name(bars: u32) -> String {
    format!("{bars} Bar{}", if bars > 1 { "s" } else { "" })
}

pub(crate) fn specs() -> Vec<Spec> {
    let mut v = Vec::new();

    // risers (end on their last sample)
    let chords: [(u32, &'static [f32], u8, u32); 3] = [(1, &[53.0, 57.0, 60.0, 65.0], 53, 3001), (2, &[57.0, 60.0, 64.0, 69.0], 57, 3002), (4, &[48.0, 55.0, 60.0, 64.0], 48, 3003)];
    for (bars, notes, root, seed) in chords {
        v.push(
            spec(
                format!("fx/riser/filtered-saw-riser-{bars}bar.wav"),
                format!("Filtered Saw Riser {}", bar_name(bars)),
                "riser",
                &["bright", "big", "wide", "euphoric", "detuned"],
                &["edm", "house", "future-bass", "pop", "techno", "tech-house"],
                move || saw_riser(bars, notes, seed),
            )
            .bars(bars)
            .root(root)
            .peak(-3.0)
            .fades(5.0, 3.0),
        );
    }
    v.push(
        spec("fx/riser/tension-sub-riser-2bar.wav", "Tension Sub Riser 2 Bars", "riser", &["dark", "deep", "aggressive", "evolving"], &["dubstep", "trap", "drill", "techno", "dnb", "edm"], || tension_riser(2, 3011))
            .bars(2)
            .peak(-3.0)
            .fades(5.0, 3.0),
    );
    for (bars, seed) in [(1u32, 3021u32)] {
        v.push(
            spec(
                format!("fx/riser/snare-noise-build-{bars}bar.wav"),
                format!("Snare Noise Build {}", bar_name(bars)),
                "riser",
                &["bright", "punchy", "big", "aggressive"],
                &["edm", "house", "future-bass", "dubstep", "pop", "tech-house"],
                move || snare_noise_riser(bars, seed),
            )
            .bars(bars)
            .peak(-3.0)
            .fades(2.0, 3.0),
        );
    }
    v.push(
        spec("fx/riser/endless-rise-2bar.wav", "Endless Rise 2 Bars", "riser", &["evolving", "dreamy", "wide", "clean"], &["edm", "future-bass", "techno", "synthwave", "pop"], || shepard_riser(2, 3031))
            .bars(2)
            .peak(-3.0)
            .fades(5.0, 3.0),
    );
    v.push(
        spec("fx/riser/rumble-riser-2bar.wav", "Rumble Riser 2 Bars", "riser", &["dark", "deep", "dirty", "mono", "aggressive"], &["techno", "dubstep", "dnb", "drill", "trap"], || rumble_riser(2, 3041))
            .bars(2)
            .peak(-3.0)
            .fades(5.0, 3.0),
    );
    v.push(
        spec("fx/riser/pluck-climb-2bar.wav", "Pluck Climb Riser 2 Bars", "riser", &["bright", "euphoric", "wide", "modern"], &["future-bass", "edm", "pop", "house"], || pluck_riser(2, 3051))
            .bars(2)
            .root(60)
            .peak(-3.0)
            .fades(5.0, 3.0),
    );
    v.push(
        spec("fx/riser/noise-wash-1bar.wav", "Noise Wash Riser 1 Bar", "riser", &["airy", "bright", "wide", "short"], EDM, || noise_wash(1, 3061)).bars(1).peak(-3.0).fades(5.0, 3.0),
    );

    // downlifters (full level on sample 0)
    for (bars, seed) in [(1u32, 3101u32), (2, 3102)] {
        v.push(
            spec(
                format!("fx/downlifter/pitch-fall-{bars}bar.wav"),
                format!("Pitch Fall Downlifter {}", bar_name(bars)),
                "downlifter",
                &["big", "wide", "detuned", "dark"],
                &["edm", "future-bass", "dubstep", "house", "pop", "dnb"],
                move || pitch_fall(bars, seed),
            )
            .bars(bars)
            .peak(-3.0)
            .fades(0.15, 5.0),
        );
    }
    v.push(
        spec("fx/downlifter/filtered-chord-fall-2bar.wav", "Filtered Chord Fall 2 Bars", "downlifter", &["warm", "wide", "emotional", "dark"], &["future-bass", "edm", "pop", "house", "deep-house"], || chord_fall(2, 3111))
            .bars(2)
            .root(48)
            .peak(-3.0)
            .fades(0.15, 5.0),
    );
    v.push(
        spec("fx/downlifter/crash-noise-fall-1bar.wav", "Crash Noise Fall 1 Bar", "downlifter", &["bright", "wide", "big", "airy"], EDM, || crash_down(1, 3121)).bars(1).peak(-3.0).fades(0.15, 5.0),
    );
    v.push(
        spec("fx/downlifter/deep-fall-1bar.wav", "Deep Fall Downlifter 1 Bar", "downlifter", &["deep", "dark", "mono", "clean"], &["trap", "drill", "dubstep", "techno", "dnb"], || deep_fall(1, 3131))
            .bars(1)
            .peak(-3.0)
            .hp(18.0)
            .fades(0.15, 5.0),
    );

    // swells (end on their last sample)
    for (bars, seed) in [(1u32, 3201u32), (2, 3202)] {
        v.push(
            spec(
                format!("fx/swell/reverse-pad-swell-{bars}bar.wav"),
                format!("Reverse Pad Swell {}", bar_name(bars)),
                "swell",
                &["dreamy", "wide", "warm", "soft"],
                &["future-bass", "rnb", "pop", "lofi", "deep-house", "edm", "synthwave"],
                move || pad_swell(bars, &[57.0, 60.0, 64.0, 67.0, 71.0], seed),
            )
            .bars(bars)
            .root(57)
            .peak(-3.0)
            .fades(10.0, 3.0),
        );
        v.push(
            spec(
                format!("fx/swell/reverse-vocal-swell-{bars}bar.wav"),
                format!("Reverse Vocal Swell {}", bar_name(bars)),
                "swell",
                &["dreamy", "airy", "emotional", "wide"],
                &["future-bass", "pop", "rnb", "edm", "house", "afrobeats"],
                move || vocal_swell(bars, seed + 10),
            )
            .bars(bars)
            .root(57)
            .peak(-3.0)
            .fades(10.0, 3.0),
        );
        v.push(
            spec(
                format!("fx/swell/volume-swell-{bars}bar.wav"),
                format!("Chord Volume Swell {}", bar_name(bars)),
                "swell",
                &["warm", "wide", "euphoric", "detuned"],
                &["edm", "future-bass", "house", "pop", "synthwave"],
                move || volume_swell(bars, &[48.0, 55.0, 60.0, 64.0, 67.0], seed + 20),
            )
            .bars(bars)
            .root(48)
            .peak(-3.0)
            .fades(10.0, 3.0),
        );
    }
    v.push(
        spec("fx/swell/metallic-swell-1bar.wav", "Metallic Reverse Swell 1 Bar", "swell", &["metallic", "cold", "wide", "bright"], &["techno", "dubstep", "dnb", "edm", "drill"], || metal_swell(1, 3231)).bars(1).peak(-3.0).fades(10.0, 3.0),
    );
    v.push(
        spec("fx/swell/reverse-snare-1bar.wav", "Reverse Snare Swell 1 Bar", "swell", &["bright", "big", "airy", "punchy"], &["edm", "pop", "trap", "future-bass", "house", "rnb"], || reverse_snare(1, 3241)).bars(1).peak(-3.0).fades(10.0, 3.0),
    );

    // reverse cymbals (attack on the last sample)
    let cyms: [(&str, &str, u32, Cym, f32, &[&'static str], u32); 4] = [
        ("dark-reverse-crash", "Dark Reverse Crash", 1, DARK_CRASH, 0.3, &["dark", "wide", "airy", "warm"], 3301),
        ("dark-reverse-crash", "Dark Reverse Crash", 2, DARK_CRASH, 0.35, &["dark", "wide", "airy", "long"], 3302),
        ("reverse-ride", "Reverse Ride", 1, RIDE, 0.25, &["metallic", "bright", "small"], 3303),
        ("reverse-sizzle", "Reverse Sizzle Cymbal", 1, SIZZLE, 0.3, &["bright", "wide", "dirty", "airy"], 3304),
    ];
    for (slug, name, bars, cym, amt, tags, seed) in cyms {
        v.push(
            spec(
                format!("fx/reverse-cymbal/{slug}-{bars}bar.wav"),
                format!("{name} {}", bar_name(bars)),
                "reverse-cymbal",
                tags,
                &["edm", "house", "pop", "future-bass", "dubstep", "trap", "techno", "rnb", "dnb"],
                move || reverse_cym(bars, cym, amt, seed),
            )
            .bars(bars)
            .peak(-3.0)
            .fades(5.0, 2.0),
        );
    }

    // whooshes (cross the listener near the end)
    let all_genres: &[&'static str] = &["edm", "house", "pop", "future-bass", "dubstep", "trap", "techno", "dnb", "rnb", "afrobeats"];
    let whooshes: [(&str, &str, Whoosh, &[&'static str]); 9] = [
        ("short", "Short Whoosh", Whoosh { len: 0.5, w: 0.07, f: 1600.0, seed: 3401, ..WH }, &["short", "airy", "clean"]),
        ("short-dark", "Short Dark Whoosh", Whoosh { len: 0.6, w: 0.08, f: 520.0, q: 1.0, pink: true, seed: 3402, ..WH }, &["short", "dark", "deep"]),
        ("short-bright", "Short Bright Whoosh", Whoosh { len: 0.45, w: 0.06, f: 4200.0, q: 1.4, seed: 3403, ..WH }, &["short", "bright", "airy"]),
        ("swish", "Swish", Whoosh { len: 0.3, at: 0.85, w: 0.035, f: 2800.0, q: 2.0, dop: 0.35, whistle: 0.5, seed: 3404, ..WH }, &["short", "bright", "small"]),
        ("pass-left-right", "Pass-By Left to Right", Whoosh { len: 1.0, w: 0.14, f: 1300.0, p0: 0.05, p1: 0.95, seed: 3405, ..WH }, &["wide", "airy"]),
        ("pass-right-left", "Pass-By Right to Left", Whoosh { len: 1.0, w: 0.14, f: 1100.0, p0: 0.95, p1: 0.05, pink: true, seed: 3406, ..WH }, &["wide", "airy", "warm"]),
        ("long-dark", "Long Dark Whoosh", Whoosh { len: 1.8, at: 0.9, w: 0.3, f: 450.0, q: 0.9, pink: true, room: 0.2, seed: 3407, ..WH }, &["long", "dark", "deep", "big"]),
        ("long-airy", "Long Airy Whoosh", Whoosh { len: 1.6, at: 0.9, w: 0.25, f: 3000.0, q: 1.0, room: 0.3, p0: 0.3, p1: 0.7, seed: 3408, ..WH }, &["long", "airy", "bright", "wide"]),
        ("jet", "Jet Whoosh", Whoosh { len: 1.2, w: 0.16, f: 900.0, q: 1.6, dop: 0.4, whistle: 0.6, p0: 0.15, p1: 0.85, seed: 3409, ..WH }, &["metallic", "big", "wide"]),
    ];
    for (slug, name, w, tags) in whooshes {
        v.push(spec(format!("fx/whoosh/{slug}.wav"), name, "whoosh", tags, all_genres, move || whoosh(&w)).peak(-3.0).fades(1.0, 4.0).trim(-70.0));
    }
    v.push(
        spec("fx/whoosh/long-pass-by-1bar.wav", "Long Pass-By 1 Bar", "whoosh", &["long", "wide", "airy", "evolving"], all_genres, || {
            whoosh(&Whoosh { len: BAR as f32 / SR, at: 0.9, w: 0.35, f: 1200.0, q: 1.0, dop: 0.3, whistle: 0.25, p0: 0.1, p1: 0.9, pink: true, room: 0.2, seed: 3410, ..WH })
        })
        .bars(1)
        .peak(-3.0)
        .fades(5.0, 4.0),
    );

    // tape / vinyl stops (halt on the last sample)
    let half = BAR / 2;
    v.push(
        spec("fx/tape-stop/beat-tape-stop-1bar.wav", "Beat Tape Stop 1 Bar", "tape-stop", &["vintage", "warm", "lofi"], &["lofi", "boom-bap", "trap", "phonk", "rnb", "pop", "house"], || {
            let c = 1.1;
            vec![mono_sum(&stop(beat_material(material_bars(BAR, c), true, true, 3501), BAR, c, false, 3502))]
        })
        .bars(1)
        .peak(-3.0)
        .fades(1.0, 3.0),
    );
    v.push(
        spec("fx/tape-stop/chord-tape-stop-1bar.wav", "Chord Tape Stop 1 Bar", "tape-stop", &["warm", "wide", "vintage"], &["lofi", "rnb", "pop", "future-bass", "synthwave"], || {
            let c = 1.3;
            let n = BAR;
            let len_s = material_bars(n, c) * BAR as f32 / SR;
            let mut src = supersaw(&[60.0, 63.0, 67.0, 70.0, 74.0], ns(len_s), 4, 0.8, 3511, |_| 0.12, |_| 0.0);
            sweep_ch(&mut src, LP, 0.8, |_| 5000.0);
            stop(src, n, c, false, 3512)
        })
        .bars(1)
        .peak(-3.0)
        .fades(5.0, 3.0),
    );
    v.push(
        spec("fx/tape-stop/vinyl-stop-1bar.wav", "Vinyl Stop 1 Bar", "tape-stop", &["vintage", "lofi", "dirty"], &["lofi", "boom-bap", "phonk", "rnb", "house", "deep-house"], || {
            let c = 0.85;
            vec![mono_sum(&stop(beat_material(material_bars(BAR, c), true, true, 3521), BAR, c, true, 3522))]
        })
        .bars(1)
        .peak(-3.0)
        .fades(1.0, 3.0),
    );
    v.push(
        spec("fx/tape-stop/beat-stop-short.wav", "Beat Tape Stop Short", "tape-stop", &["short", "vintage", "warm"], &["trap", "lofi", "boom-bap", "phonk", "pop", "drill"], move || {
            let c = 1.0;
            vec![mono_sum(&stop(beat_material(material_bars(half, c), true, true, 3531), half, c, false, 3532))]
        })
        .peak(-3.0)
        .fades(1.0, 3.0)
        .trim(-70.0),
    );
    v.push(
        spec("fx/tape-stop/808-stop-short.wav", "808 Tape Stop Short", "tape-stop", &["short", "deep", "dark"], &["trap", "drill", "phonk", "dubstep"], move || {
            let c = 1.2;
            let n = ns(material_bars(half, c) * BAR as f32 / SR);
            let mut x = tone(n, 0.25, |_| hz(36.0), |t| smooth01(t / 0.003) * (0.6 + 0.4 * dec60(t, 0.4)));
            drive(&mut x, 2.0, 0.08);
            let k = kick(&Kick { f: 55.0, decay: 250.0, drive: 0.4, seed: 3541, ..KICK });
            add(&mut x, &k, 0.6, 0);
            stop(vec![x], half, c, false, 3542)
        })
        .peak(-3.0)
        .hp(18.0)
        .fades(1.0, 3.0)
        .trim(-70.0),
    );
    v.push(
        spec("fx/tape-stop/vinyl-brake-short.wav", "Vinyl Brake Short", "tape-stop", &["short", "lofi", "vintage", "dirty"], &["lofi", "boom-bap", "phonk", "house"], move || {
            let c = 0.6;
            vec![mono_sum(&stop(beat_material(material_bars(half, c), true, true, 3551), half, c, true, 3552))]
        })
        .peak(-3.0)
        .fades(1.0, 3.0)
        .trim(-70.0),
    );
    v
}
