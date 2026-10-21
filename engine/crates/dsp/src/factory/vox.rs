//! Synthetic vocal one-shots (no recorded voices): formant synthesis of
//! vowels on a glottal-style source ("ah", "oh", "hey", "ooh", "ee", "uh"),
//! breaths (aspiration noise through the vocal tract), and talking-synth
//! blips (a saw chord through moving vowel formants). Pitched shots carry
//! their root note.

use super::kit::*;
use super::library::{spec, Spec};
use super::synth::*;
use super::transitions::choir;

const PLATE: Rev = rev(2.0, 0.45, 1.3);

/// A single sung vowel with a small scoop into the note.
fn shot(note: f32, len: f32, vowel: Vowel, attack: f32, rel_at: f32, rel: f32, breath: f32, scoop: f32, seed: u32) -> Vec<f32> {
    let n = ns(len);
    let f = hz(note);
    let amp = move |t: f32| smooth01(t / attack) * (1.0 - smooth01((t - rel_at) / rel));
    voice(
        &Voice {
            pitch: &move |t| f * (-scoop * (1.0 - smooth01(t / 0.07)) / 12.0).exp2(),
            vowel: &move |_| vowel,
            amp: &amp,
            breath: &move |t| breath * amp(t),
            vib: 0.3,
            vib_hz: 5.5,
            vib_in: 0.3,
            seed,
        },
        n,
    )
}

/// A short plate folded back to mono (a single voice is a mono source).
fn plate(x: &[f32], wet: f32, tail: f32) -> Chans {
    vec![reverb_mono(x, &PLATE.pre(12.0).low(250.0).damp(8000.0), wet, tail)]
}

/// "Hey": an aspirated onset, then eh → ee with the pitch falling at the end.
/// `voices` > 1 stacks slightly different takes into a small crowd.
fn hey(note: f32, voices: usize, seed: u32) -> Chans {
    let len = 0.5;
    let n = ns(len);
    let mut l = vec![0.0f32; n + ns(0.03)];
    let mut r = vec![0.0f32; n + ns(0.03)];
    let mut nz = Noise::new(seed);
    for k in 0..voices {
        let det = if voices > 1 { nz.range(-0.25, 0.25) } else { 0.0 };
        let off = if k == 0 { 0 } else { ns(nz.range(0.004, 0.022)) };
        let sc = nz.range(0.95, 1.12);
        let f = hz(note + det);
        let amp = move |t: f32| smooth01((t - 0.05) / 0.03) * (1.0 - smooth01((t - 0.36) / 0.1));
        let x = voice(
            &Voice {
                pitch: &move |t| f * (if t > 0.3 { -2.5 * smooth01((t - 0.3) / 0.15) } else { 0.3 * smooth01(t / 0.12) } / 12.0).exp2(),
                vowel: &move |t| Vowel::mix(&EH, &EE, smooth01((t - 0.2) / 0.18)).scale(sc),
                amp: &amp,
                breath: &move |t| 1.6 * (smooth01(t / 0.01) * (1.0 - smooth01((t - 0.04) / 0.03))) + 0.12 * amp(t),
                vib: 0.1,
                vib_hz: 6.0,
                vib_in: 0.2,
                seed: seed + 1 + k as u32,
            },
            n,
        );
        let pan = if voices == 1 { 0.5 } else { 0.5 + 0.35 * (k as f32 / (voices - 1) as f32 * 2.0 - 1.0) };
        let s = pan_mono(&x, |_| pan);
        add(&mut l, &s[0], 1.0, off);
        add(&mut r, &s[1], 1.0, off);
    }
    let mut ch = vec![l, r];
    for c in ch.iter_mut() {
        normalize(c, 1.0);
        drive(c, 1.8, 0.0);
    }
    let room = rev(0.0, 0.5, 0.9).pre(8.0).low(250.0);
    if voices == 1 {
        return vec![reverb_mono(&ch[0], &room, 0.15, 0.5)];
    }
    let mut out = reverb(&ch, &room, 0.15, 0.5);
    even(&mut out);
    out
}

/// Breath: aspiration only, through the vocal tract (in = rising, out = sigh).
fn breath(inhale: bool, seed: u32) -> Chans {
    let len = if inhale { 0.65 } else { 0.85 };
    let n = ns(len);
    let env = move |t: f32| {
        if inhale {
            smooth01(t / 0.5).powf(1.5) * (1.0 - smooth01((t - 0.55) / 0.06))
        } else {
            smooth01(t / 0.04) * dec60(t, 0.9)
        }
    };
    let mut x = voice(
        &Voice {
            pitch: &|_| hz(43.0),
            vowel: &move |t| if inhale { Vowel::mix(&OH, &AH, t / len) } else { Vowel::mix(&AH, &UH, t / len) },
            amp: &move |t| if inhale { 0.0 } else { 0.05 * env(t) },
            breath: &env,
            vib: 0.0,
            vib_hz: 5.0,
            vib_in: 1.0,
            seed,
        },
        n,
    );
    hp(&mut x, 350.0);
    if inhale {
        // in-breaths are brighter and narrower
        eq(&mut x, HighShelf, 4000.0, 0.7, 4.0);
    }
    plate(&x, 0.08, 0.3)
}

/// Talking synth: a saw chord through vowel formants gliding along `path`.
fn talk(notes: &[f32], len: f32, path: &'static [(f32, Vowel)], bend: f32, crush_bits: f32, seed: u32) -> Chans {
    let n = ns(len);
    let src = mono_sum(&supersaw(notes, n, 2, 0.0, seed, |_| 0.08, move |u| bend * smooth01((u - 0.7) / 0.3)));
    let vowel = move |t: f32| {
        let u = t / len;
        let mut k = 0;
        while k + 1 < path.len() && path[k + 1].0 <= u {
            k += 1;
        }
        if k + 1 >= path.len() {
            return path[k].1;
        }
        let (u0, v0) = path[k];
        let (u1, v1) = path[k + 1];
        Vowel::mix(&v0, &v1, smooth01((u - u0) / (u1 - u0).max(1e-3)))
    };
    let mut x = formants(&src, vowel);
    for (i, v) in x.iter_mut().enumerate() {
        let t = i as f32 / SR;
        *v *= smooth01(t / 0.005) * (1.0 - smooth01((t - (len - 0.08)) / 0.07));
    }
    if crush_bits > 0.0 {
        normalize(&mut x, 0.9);
        crush(&mut x, crush_bits, 2);
        lp(&mut x, 10_000.0);
    }
    plate(&x, 0.12, 0.4)
}

pub(crate) fn specs() -> Vec<Spec> {
    let vocal_genres: &[&'static str] = &["house", "tech-house", "edm", "future-bass", "pop", "afrobeats", "reggaeton", "deep-house"];
    let mut v = Vec::new();
    v.push(
        spec("oneshots/vox/ah-shot.wav", "Ah Vox Shot", "vox", &["airy", "soft", "dreamy", "emotional"], vocal_genres, || {
            let x = shot(60.0, 0.9, AH.scale(1.15), 0.04, 0.6, 0.25, 0.2, 1.0, 5001);
            plate(&x, 0.18, 0.6)
        })
        .root(60)
        .peak(-2.0),
    );
    v.push(
        spec("oneshots/vox/oh-shot.wav", "Oh Vox Shot", "vox", &["warm", "deep", "soft"], vocal_genres, || {
            let x = shot(48.0, 0.95, OH, 0.05, 0.65, 0.25, 0.15, 0.8, 5011);
            plate(&x, 0.15, 0.6)
        })
        .root(48)
        .peak(-2.0),
    );
    v.push(spec("oneshots/vox/hey-shot.wav", "Hey Shout", "vox", &["punchy", "short", "hard"], &["house", "tech-house", "edm", "pop", "afrobeats", "reggaeton", "trap"], || hey(55.0, 1, 5021)).root(55).peak(-2.0));
    v.push(spec("oneshots/vox/hey-crowd.wav", "Hey Crowd Shout", "vox", &["big", "wide", "punchy", "hard"], &["house", "tech-house", "edm", "pop", "afrobeats", "reggaeton", "trap"], || hey(55.0, 4, 5031)).root(55).peak(-2.0));
    v.push(
        spec("oneshots/vox/ooh-choir.wav", "Ooh Choir Stab", "vox", &["wide", "dreamy", "warm", "emotional"], &["future-bass", "pop", "rnb", "deep-house", "house", "lofi"], || {
            let c = choir(&[60.0, 63.0, 67.0], 1.4, OO, 5041);
            reverb(&c, &rev(1.0, 0.8, 2.2).pre(15.0).low(250.0), 0.25, 1.0)
        })
        .root(60)
        .peak(-2.0),
    );
    v.push(
        spec("oneshots/vox/ee-chop.wav", "Ee Vox Chop", "vox", &["short", "bright", "small"], vocal_genres, || {
            let x = shot(72.0, 0.24, EE.scale(1.2), 0.008, 0.14, 0.07, 0.12, 0.0, 5051);
            plate(&x, 0.1, 0.25)
        })
        .root(72)
        .peak(-2.0),
    );
    v.push(
        spec("oneshots/vox/uh-chop-low.wav", "Low Uh Vox Chop", "vox", &["short", "deep", "dark"], &["house", "tech-house", "techno", "trap", "phonk", "drill"], || {
            let x = shot(48.0, 0.32, UH.scale(0.86), 0.01, 0.2, 0.09, 0.1, 0.0, 5061);
            plate(&x, 0.1, 0.25)
        })
        .root(48)
        .peak(-2.0),
    );
    v.push(spec("oneshots/vox/breath-in.wav", "Breath In", "vox", &["airy", "soft", "organic", "short"], &["pop", "rnb", "lofi", "future-bass", "trap"], || breath(true, 5071)).peak(-4.0));
    v.push(spec("oneshots/vox/breath-out.wav", "Breath Out Sigh", "vox", &["airy", "soft", "organic", "warm"], &["pop", "rnb", "lofi", "future-bass", "trap"], || breath(false, 5081)).peak(-4.0));
    v.push(
        spec("oneshots/vox/talk-blip.wav", "Talking Synth Blip", "vox", &["retro", "modern", "short", "bright"], &["future-bass", "edm", "house", "synthwave", "dubstep"], || {
            const PATH: &[(f32, Vowel)] = &[(0.0, OO), (0.35, AH), (0.75, EE)];
            talk(&[60.0, 64.0, 67.0, 71.0], 0.38, PATH, 0.0, 0.0, 5091)
        })
        .root(60)
        .peak(-2.0),
    );
    v.push(
        spec("oneshots/vox/robot-yeah.wav", "Robot Yeah", "vox", &["retro", "gritty", "lofi"], &["future-bass", "edm", "house", "dubstep", "synthwave", "phonk"], || {
            const PATH: &[(f32, Vowel)] = &[(0.0, EE), (0.2, EH), (0.45, AH), (1.0, AH)];
            talk(&[48.0, 55.0, 60.0, 63.0], 0.55, PATH, -2.0, 7.0, 5101)
        })
        .root(48)
        .peak(-2.0),
    );
    v
}
