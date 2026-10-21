//! Drum recipes: kicks, snares, claps, hats, rides, crashes, toms and snare
//! fills. Layered synthesis: a pitched sine body with a two-stage pitch
//! envelope + a click/transient layer + saturation (kicks); a tuned body +
//! filtered noise wires + a crack (snares); offset noise bursts + a short
//! room (claps); a six-square metallic bank through band/high passes + noise
//! (hats); modal banks of decaying partials + a noise wash (cymbals).

use super::library::{spec, Spec};
use super::synth::*;
use crate::instruments::drums::{render as drum_render, DrumKind, DrumParams};

// ── Kick ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub(crate) struct Kick {
    /// End pitch of the body (Hz).
    pub f: f32,
    /// Fast pitch drop: start = f × (1 + a1 + a2).
    pub a1: f32,
    pub t1: f32,
    /// Slower "knock" bend.
    pub a2: f32,
    pub t2: f32,
    /// Full level (ms), then `decay` ms to -60 dB shaped by `curve` (0 exp … 1 hold-then-drop).
    pub hold: f32,
    pub decay: f32,
    pub curve: f32,
    /// Share of a longer sub tail.
    pub sub: f32,
    pub sub_ms: f32,
    pub click: f32,
    pub click_hz: f32,
    pub click_ms: f32,
    pub tick: f32,
    pub tick_hz: f32,
    pub drive: f32,
    pub bias: f32,
    pub lp: f32,
    pub hp: f32,
    pub seed: u32,
}

pub(crate) const KICK: Kick = Kick {
    f: 50.0,
    a1: 5.0,
    t1: 3.5,
    a2: 1.2,
    t2: 25.0,
    hold: 20.0,
    decay: 380.0,
    curve: 0.5,
    sub: 0.0,
    sub_ms: 800.0,
    click: 0.3,
    click_hz: 4500.0,
    click_ms: 2.5,
    tick: 0.12,
    tick_hz: 1600.0,
    drive: 0.3,
    bias: 0.0,
    lp: 14000.0,
    hp: 28.0,
    seed: 101,
};

/// Hold, then fall to exactly zero at -60 dB (no end click).
pub(crate) fn env_hd(t_ms: f32, hold: f32, decay: f32, curve: f32) -> f32 {
    if t_ms <= hold {
        return 1.0;
    }
    let u = (t_ms - hold) / decay.max(1.0);
    if u >= 1.0 {
        return 0.0;
    }
    let s = (1.0 - curve) * u + curve * u * u;
    (((-6.907_755 * s).exp() - 0.001 * u) / 0.999).max(0.0)
}

pub(crate) fn kick(p: &Kick) -> Vec<f32> {
    let total = p.hold + if p.sub > 0.0 { p.decay.max(p.sub_ms) } else { p.decay };
    let n = ns(total / 1000.0) + 1;
    let mut nz = Noise::new(p.seed);
    let mut cbp = svf(BP, p.click_hz, 0.8);
    let mut clp = svf(LP, (p.click_hz * 2.5).min(19_000.0), 0.7);
    let mut out = vec![0.0f32; n];
    let mut ph = 0.0f64;
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR * 1000.0;
        let f = p.f * (1.0 + p.a1 * (-t / p.t1).exp() + p.a2 * (-t / p.t2).exp());
        let body = (ph * TAU64).sin() as f32;
        ph = (ph + f as f64 / FS).fract();
        let mut amp = env_hd(t, p.hold, p.decay, p.curve);
        if p.sub > 0.0 {
            amp = (1.0 - p.sub) * amp + p.sub * env_hd(t, p.hold, p.sub_ms, 0.35);
        }
        let ce = (t / 0.08).min(1.0) * (-t / p.click_ms).exp();
        let c = tick(&mut clp, tick(&mut cbp, nz.white())) * ce * p.click * 2.0;
        let tk = (TAU32 * p.tick_hz * t * 0.001).sin() * (-t / 1.2).exp() * p.tick;
        *o = body * amp + c + tk;
    }
    if p.drive > 0.0 {
        normalize(&mut out, 1.0);
        drive(&mut out, 1.0 + 8.0 * p.drive, p.bias);
    }
    if p.lp < 19_000.0 {
        lp(&mut out, p.lp);
    }
    hp(&mut out, p.hp);
    out
}

/// Techno "rumble": the kick through a long dark hall, low passed, driven
/// and ducked under the kick, then added back (mono).
fn rumble(k: Vec<f32>, amount: f32, decay_s: f32, lp_hz: f32) -> Vec<f32> {
    let w = reverb_wet(&vec![k.clone()], &rev(1.0, 0.85, decay_s).damp(2500.0).low(25.0).pre(15.0).width(0.0), decay_s * 0.55);
    let mut r = mono_sum(&w);
    lp4(&mut r, lp_hz);
    normalize(&mut r, 1.0);
    drive(&mut r, 3.5, 0.0);
    lp(&mut r, lp_hz * 1.6);
    hp(&mut r, 32.0);
    for (i, v) in r.iter_mut().enumerate() {
        *v *= smooth01((i as f32 / SR - 0.05) / 0.14);
    }
    let pk = peak(&k);
    normalize(&mut r, pk * amount);
    let mut out = k;
    add(&mut out, &r, 1.0, 0);
    out
}

fn kicks() -> Vec<Spec> {
    let k = |p: Kick| move || vec![kick(&p)];
    vec![
        spec(
            "drums/kick/punchy-club.wav",
            "Punchy Club Kick",
            "kick",
            &["punchy", "clean", "modern"],
            &["house", "tech-house", "edm", "pop"],
            k(Kick { f: 51.0, a1: 5.5, t1: 3.2, a2: 1.3, t2: 24.0, hold: 22.0, decay: 360.0, curve: 0.55, click: 0.35, drive: 0.4, seed: 111, ..KICK }),
        ),
        spec(
            "drums/kick/big-room-long.wav",
            "Big Room Long Kick",
            "kick",
            &["big", "long", "distorted", "hard"],
            &["edm"],
            k(Kick {
                f: 47.0,
                a1: 7.0,
                t1: 3.0,
                a2: 2.2,
                t2: 38.0,
                hold: 70.0,
                decay: 720.0,
                curve: 0.85,
                click: 0.5,
                click_hz: 3500.0,
                tick: 0.25,
                tick_hz: 2000.0,
                drive: 0.85,
                bias: 0.12,
                lp: 8500.0,
                hp: 32.0,
                seed: 112,
                ..KICK
            }),
        ),
        spec("drums/kick/rumble-techno.wav", "Rumble Techno Kick", "kick", &["dark", "deep", "long", "distorted"], &["techno"], || {
            let base = kick(&Kick { f: 49.0, a1: 5.0, t1: 3.0, a2: 1.4, t2: 22.0, hold: 18.0, decay: 300.0, curve: 0.5, click: 0.4, drive: 0.5, seed: 113, ..KICK });
            vec![rumble(base, 0.55, 2.0, 160.0)]
        }),
        spec(
            "drums/kick/deep-house-soft.wav",
            "Soft Deep House Kick",
            "kick",
            &["soft", "deep", "warm"],
            &["deep-house", "house"],
            k(Kick {
                f: 52.0,
                a1: 3.5,
                t1: 4.0,
                a2: 0.8,
                t2: 30.0,
                hold: 15.0,
                decay: 420.0,
                curve: 0.5,
                click: 0.12,
                click_hz: 3000.0,
                tick: 0.05,
                drive: 0.15,
                lp: 7000.0,
                seed: 114,
                ..KICK
            }),
        ),
        spec(
            "drums/kick/trap-thump.wav",
            "Trap Thump Kick",
            "kick",
            &["punchy", "short", "hard"],
            &["trap", "drill", "phonk"],
            k(Kick { f: 56.0, a1: 4.5, t1: 3.0, a2: 1.4, t2: 22.0, hold: 10.0, decay: 280.0, curve: 0.4, click: 0.45, click_hz: 5000.0, drive: 0.45, seed: 115, ..KICK }),
        ),
        spec("drums/kick/boom-bap-dusty.wav", "Dusty Boom Bap Kick", "kick", &["lofi", "vintage", "dirty", "warm"], &["boom-bap", "lofi"], || {
            let mut x = kick(&Kick {
                f: 58.0,
                a1: 3.5,
                t1: 5.0,
                a2: 1.0,
                t2: 35.0,
                hold: 10.0,
                decay: 320.0,
                curve: 0.45,
                click: 0.3,
                click_hz: 2500.0,
                drive: 0.55,
                bias: 0.1,
                lp: 6000.0,
                seed: 116,
                ..KICK
            });
            normalize(&mut x, 0.9);
            crush(&mut x, 12.0, 2);
            lp(&mut x, 5200.0);
            vec![reverb_mono(&x, &rev(0.0, 0.25, 0.45).damp(4500.0).low(150.0), 0.12, 0.3)]
        }),
        spec("drums/kick/lofi-soft.wav", "Lo-fi Soft Kick", "kick", &["lofi", "soft", "warm", "vintage"], &["lofi", "boom-bap", "rnb"], || {
            let mut x = kick(&Kick {
                f: 55.0,
                a1: 3.0,
                t1: 5.0,
                a2: 0.6,
                t2: 30.0,
                hold: 8.0,
                decay: 300.0,
                curve: 0.4,
                click: 0.1,
                click_hz: 2000.0,
                tick: 0.03,
                drive: 0.3,
                lp: 3000.0,
                seed: 117,
                ..KICK
            });
            normalize(&mut x, 0.9);
            crush(&mut x, 10.0, 1);
            lp(&mut x, 2600.0);
            vec![reverb_mono(&x, &rev(0.0, 0.3, 0.5).damp(3000.0).low(150.0), 0.1, 0.3)]
        }),
        spec(
            "drums/kick/dnb-tight.wav",
            "Tight DnB Kick",
            "kick",
            &["punchy", "short", "bright", "hard"],
            &["dnb", "dubstep"],
            k(Kick {
                f: 60.0,
                a1: 6.0,
                t1: 2.5,
                a2: 1.5,
                t2: 18.0,
                hold: 8.0,
                decay: 230.0,
                curve: 0.3,
                click: 0.55,
                click_hz: 5500.0,
                tick: 0.2,
                tick_hz: 2200.0,
                drive: 0.5,
                lp: 15_000.0,
                hp: 35.0,
                seed: 118,
                ..KICK
            }),
        ),
        spec("drums/kick/hard-distorted.wav", "Hard Distorted Kick", "kick", &["distorted", "hard", "aggressive", "dirty"], &["techno", "edm", "phonk"], || {
            let mut x = kick(&Kick {
                f: 52.0,
                a1: 8.0,
                t1: 3.0,
                a2: 2.5,
                t2: 30.0,
                hold: 40.0,
                decay: 520.0,
                curve: 0.8,
                click: 0.5,
                drive: 0.9,
                bias: 0.06,
                lp: 9000.0,
                hp: 30.0,
                seed: 119,
                ..KICK
            });
            normalize(&mut x, 1.0);
            let mut r = x.clone();
            effect("krypt.drive", &[("mode", 0.0), ("drive", 12.0), ("tone", 7000.0), ("output", -6.0)], &mut x, &mut r, 0.0);
            vec![x]
        }),
        spec(
            "drums/kick/clicky.wav",
            "Clicky Kick",
            "kick",
            &["bright", "short", "punchy"],
            &["tech-house", "techno", "house"],
            k(Kick {
                f: 54.0,
                a1: 5.0,
                t1: 3.0,
                a2: 1.0,
                t2: 20.0,
                hold: 12.0,
                decay: 260.0,
                curve: 0.4,
                click: 0.9,
                click_hz: 6000.0,
                click_ms: 1.5,
                tick: 0.4,
                tick_hz: 3000.0,
                drive: 0.3,
                lp: 18_000.0,
                seed: 120,
                ..KICK
            }),
        ),
        spec(
            "drums/kick/sub-heavy.wav",
            "Sub Heavy Kick",
            "kick",
            &["deep", "big", "long"],
            &["trap", "rnb", "future-bass", "reggaeton"],
            k(Kick { f: 45.0, a1: 4.0, t1: 3.5, a2: 1.0, t2: 28.0, hold: 20.0, decay: 340.0, curve: 0.5, sub: 0.6, sub_ms: 900.0, click: 0.25, drive: 0.25, seed: 121, ..KICK }),
        ),
        spec(
            "drums/kick/tight-pop.wav",
            "Tight Pop Kick",
            "kick",
            &["punchy", "clean", "modern"],
            &["pop", "rnb", "future-bass"],
            k(Kick { f: 57.0, a1: 4.5, t1: 3.0, a2: 1.2, t2: 22.0, hold: 12.0, decay: 300.0, curve: 0.45, click: 0.35, click_hz: 4800.0, drive: 0.3, seed: 122, ..KICK }),
        ),
        spec(
            "drums/kick/afro-warm.wav",
            "Warm Afro Kick",
            "kick",
            &["warm", "soft", "organic"],
            &["afrobeats", "reggaeton", "deep-house"],
            k(Kick {
                f: 52.0,
                a1: 3.0,
                t1: 6.0,
                a2: 0.9,
                t2: 30.0,
                hold: 15.0,
                decay: 380.0,
                curve: 0.5,
                click: 0.15,
                click_hz: 2000.0,
                tick: 0.06,
                tick_hz: 900.0,
                drive: 0.25,
                lp: 6000.0,
                seed: 123,
                ..KICK
            }),
        ),
        spec(
            "drums/kick/reggaeton-thick.wav",
            "Thick Reggaeton Kick",
            "kick",
            &["punchy", "big", "warm"],
            &["reggaeton", "afrobeats", "pop"],
            k(Kick { f: 54.0, a1: 4.5, t1: 3.5, a2: 1.3, t2: 26.0, hold: 18.0, decay: 340.0, curve: 0.5, click: 0.35, drive: 0.6, bias: 0.05, lp: 10_000.0, seed: 124, ..KICK }),
        ),
        spec("drums/kick/phonk-blown.wav", "Blown Phonk Kick", "kick", &["distorted", "dirty", "aggressive", "lofi"], &["phonk", "trap"], || {
            let mut x = kick(&Kick { f: 50.0, a1: 6.0, t1: 3.0, a2: 1.8, t2: 28.0, hold: 25.0, decay: 420.0, curve: 0.6, click: 0.4, drive: 1.0, bias: 0.08, lp: 12_000.0, seed: 125, ..KICK });
            normalize(&mut x, 1.0);
            drive(&mut x, 4.0, 0.0);
            lp(&mut x, 5500.0);
            hp(&mut x, 30.0);
            vec![x]
        }),
        spec("drums/kick/gated-80s.wav", "Gated 80s Kick", "kick", &["retro", "big", "vintage", "wide"], &["synthwave", "pop"], || {
            let x = kick(&Kick { f: 53.0, a1: 4.0, t1: 4.0, a2: 1.0, t2: 25.0, hold: 10.0, decay: 260.0, curve: 0.4, click: 0.3, drive: 0.3, seed: 126, ..KICK });
            gated(&vec![x], &rev(0.0, 0.8, 1.6).damp(6000.0).low(120.0).pre(4.0), 0.35, 200.0, 40.0)
        }),
        spec(
            "drums/kick/dubstep-punch.wav",
            "Dubstep Punch Kick",
            "kick",
            &["punchy", "hard", "bright"],
            &["dubstep", "future-bass", "dnb"],
            k(Kick {
                f: 56.0,
                a1: 6.0,
                t1: 2.8,
                a2: 1.6,
                t2: 20.0,
                hold: 10.0,
                decay: 280.0,
                curve: 0.4,
                click: 0.6,
                click_hz: 5000.0,
                tick: 0.25,
                tick_hz: 2500.0,
                drive: 0.6,
                lp: 14_000.0,
                hp: 32.0,
                seed: 127,
                ..KICK
            }),
        ),
        spec(
            "drums/kick/classic-house.wav",
            "Classic House Kick",
            "kick",
            &["punchy", "warm", "vintage"],
            &["house", "deep-house", "tech-house"],
            k(Kick {
                f: 50.0,
                a1: 5.0,
                t1: 3.0,
                a2: 1.5,
                t2: 30.0,
                hold: 15.0,
                decay: 340.0,
                curve: 0.5,
                click: 0.45,
                click_hz: 3800.0,
                tick: 0.2,
                tick_hz: 1800.0,
                drive: 0.55,
                bias: 0.05,
                lp: 11_000.0,
                seed: 128,
                ..KICK
            }),
        ),
        spec(
            "drums/kick/techno-punch.wav",
            "Techno Punch Kick",
            "kick",
            &["hard", "punchy", "dark", "short"],
            &["techno", "tech-house"],
            k(Kick {
                f: 51.0,
                a1: 7.0,
                t1: 2.5,
                a2: 2.0,
                t2: 18.0,
                hold: 10.0,
                decay: 260.0,
                curve: 0.35,
                click: 0.6,
                drive: 0.75,
                bias: 0.1,
                lp: 10_000.0,
                hp: 35.0,
                seed: 129,
                ..KICK
            }),
        ),
        spec(
            "drums/kick/long-boom.wav",
            "Long Boom Kick",
            "kick",
            &["long", "deep", "big"],
            &["trap", "drill", "reggaeton", "future-bass"],
            k(Kick { f: 46.0, a1: 5.0, t1: 3.5, a2: 1.2, t2: 28.0, hold: 30.0, decay: 650.0, curve: 0.6, sub: 0.4, sub_ms: 900.0, click: 0.35, drive: 0.35, seed: 130, ..KICK }),
        ),
        spec(
            "drums/kick/soft-round.wav",
            "Soft Round Kick",
            "kick",
            &["soft", "warm", "clean"],
            &["rnb", "lofi", "pop", "afrobeats"],
            k(Kick { f: 54.0, a1: 2.5, t1: 6.0, a2: 0.5, t2: 30.0, hold: 10.0, decay: 300.0, curve: 0.45, click: 0.05, tick: 0.0, drive: 0.1, lp: 4000.0, seed: 131, ..KICK }),
        ),
    ]
}

// ── Snare ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub(crate) struct Snare {
    /// Body (shell) pitch and its second mode ratio.
    pub f: f32,
    pub r2: f32,
    pub body: f32,
    pub body_ms: f32,
    pub bend: f32,
    pub bend_ms: f32,
    /// Wires: band-limited noise.
    pub noise: f32,
    pub n_hp: f32,
    pub n_lp: f32,
    pub noise_ms: f32,
    /// Share of a longer wire tail.
    pub tail: f32,
    pub tail_ms: f32,
    /// Stick crack: a short band-passed burst.
    pub crack: f32,
    pub crack_hz: f32,
    pub crack_ms: f32,
    pub drive: f32,
    pub lp: f32,
    pub hp: f32,
    pub seed: u32,
}

pub(crate) const SNARE: Snare = Snare {
    f: 200.0,
    r2: 1.62,
    body: 0.8,
    body_ms: 130.0,
    bend: 0.4,
    bend_ms: 6.0,
    noise: 0.75,
    n_hp: 1200.0,
    n_lp: 8000.0,
    noise_ms: 200.0,
    tail: 0.0,
    tail_ms: 400.0,
    crack: 0.45,
    crack_hz: 3500.0,
    crack_ms: 3.0,
    drive: 0.3,
    lp: 16_000.0,
    hp: 90.0,
    seed: 201,
};

pub(crate) fn snare(p: &Snare) -> Vec<f32> {
    let len_ms = p.body_ms.max(p.noise_ms).max(if p.tail > 0.0 { p.tail_ms } else { 0.0 });
    let n = ns(len_ms / 1000.0 + 0.005);
    let mut nz = Noise::new(p.seed);
    let mut h1 = svf(HP, p.n_hp, 0.7);
    let mut l1 = svf(LP, p.n_lp, 0.54);
    let mut l2 = svf(LP, p.n_lp, 1.31);
    let mut cb = svf(BP, p.crack_hz, 1.2);
    let (mut p1, mut p2) = (0.0f64, 0.0f64);
    let mut out = vec![0.0f32; n];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR * 1000.0;
        let bend = 1.0 + p.bend * (-t / p.bend_ms).exp();
        let (a, _) = step(&mut p1, p.f * bend);
        let (b, _) = step(&mut p2, p.f * p.r2 * bend);
        let body = ((a * TAU64).sin() as f32 * 0.8 + (b * TAU64).sin() as f32 * 0.45 * (-t / (p.body_ms * 0.18)).exp()) * dec60(t, p.body_ms);
        let w = nz.white();
        let wires = tick(&mut l2, tick(&mut l1, tick(&mut h1, w)));
        let att = (t / 0.5).min(1.0);
        let nenv = att * ((1.0 - p.tail) * dec60(t, p.noise_ms) + p.tail * dec60(t, p.tail_ms));
        // the wires rattle with the shell
        let wires = wires * (1.0 + 0.25 * body) * nenv;
        let crack = tick(&mut cb, w) * (-t / p.crack_ms).exp() * 1.5;
        *o = body * p.body * 1.2 + wires * p.noise + crack * p.crack;
    }
    if p.drive > 0.0 {
        normalize(&mut out, 1.0);
        drive(&mut out, 1.0 + 5.0 * p.drive, 0.0);
    }
    if p.lp < 19_000.0 {
        lp(&mut out, p.lp);
    }
    hp(&mut out, p.hp);
    out
}

fn snares() -> Vec<Spec> {
    vec![
        spec("drums/snare/tight-house.wav", "Tight House Snare", "snare", &["short", "bright", "clean"], &["house", "tech-house", "deep-house"], || {
            let x = snare(&Snare { f: 205.0, body_ms: 110.0, noise_ms: 170.0, crack: 0.4, seed: 211, ..SNARE });
            vec![reverb_mono(&x, &rev(2.0, 0.3, 0.7).pre(6.0).low(300.0), 0.12, 0.4)]
        }),
        spec("drums/snare/fat-trap.wav", "Fat Trap Snare", "snare", &["big", "punchy", "wide"], &["trap", "drill", "phonk"], || {
            let x = snare(&Snare {
                f: 185.0,
                r2: 1.7,
                body: 0.9,
                body_ms: 160.0,
                noise: 0.8,
                n_hp: 1000.0,
                n_lp: 9000.0,
                noise_ms: 260.0,
                tail: 0.3,
                tail_ms: 480.0,
                crack: 0.5,
                drive: 0.4,
                seed: 212,
                ..SNARE
            });
            reverb(&vec![x], &rev(2.0, 0.45, 1.2).pre(10.0).low(250.0), 0.18, 0.9)
        }),
        spec("drums/snare/boom-bap-crack.wav", "Boom Bap Crack Snare", "snare", &["vintage", "dirty", "punchy"], &["boom-bap", "lofi"], || {
            let mut x = snare(&Snare {
                f: 210.0,
                r2: 1.55,
                body: 1.0,
                body_ms: 140.0,
                noise: 0.8,
                n_hp: 1200.0,
                n_lp: 7000.0,
                noise_ms: 220.0,
                crack: 0.6,
                crack_hz: 3000.0,
                drive: 0.6,
                lp: 8000.0,
                seed: 213,
                ..SNARE
            });
            normalize(&mut x, 0.9);
            crush(&mut x, 12.0, 2);
            lp(&mut x, 7500.0);
            vec![reverb_mono(&x, &rev(0.0, 0.35, 0.6).damp(5000.0).low(250.0), 0.2, 0.4)]
        }),
        spec("drums/snare/lofi-soft.wav", "Lo-fi Soft Snare", "snare", &["lofi", "soft", "warm"], &["lofi", "boom-bap", "rnb"], || {
            let mut x = snare(&Snare {
                f: 190.0,
                body: 0.9,
                body_ms: 130.0,
                noise: 0.5,
                n_hp: 900.0,
                n_lp: 4500.0,
                noise_ms: 200.0,
                crack: 0.2,
                crack_hz: 2500.0,
                drive: 0.3,
                lp: 4500.0,
                seed: 214,
                ..SNARE
            });
            normalize(&mut x, 0.9);
            crush(&mut x, 11.0, 1);
            lp(&mut x, 4200.0);
            vec![reverb_mono(&x, &rev(0.0, 0.4, 0.7).damp(3500.0).low(200.0), 0.15, 0.4)]
        }),
        spec("drums/snare/dnb-crack.wav", "DnB Crack Snare", "snare", &["bright", "punchy", "hard"], &["dnb", "dubstep"], || {
            let x = snare(&Snare {
                f: 250.0,
                r2: 1.65,
                body: 0.9,
                body_ms: 110.0,
                bend: 0.6,
                noise: 0.9,
                n_hp: 2000.0,
                n_lp: 12_000.0,
                noise_ms: 170.0,
                crack: 0.8,
                crack_hz: 4500.0,
                drive: 0.5,
                seed: 215,
                ..SNARE
            });
            vec![reverb_mono(&x, &rev(0.0, 0.3, 0.5).low(400.0), 0.1, 0.3)]
        }),
        spec("drums/snare/big-room.wav", "Big Room Snare", "snare", &["big", "wide", "bright", "long"], &["edm", "future-bass"], || {
            let mut x = snare(&Snare { f: 220.0, body: 0.8, noise: 0.9, noise_ms: 300.0, crack: 0.6, drive: 0.45, seed: 216, ..SNARE });
            let c = clap_ch(&Clap { tail_ms: 250.0, seed: 217, ..CLAP }, 217);
            add(&mut x, &c, 0.6, 0);
            reverb(&vec![x], &rev(1.0, 0.75, 1.7).pre(15.0).low(300.0).damp(9000.0), 0.3, 1.5)
        }),
        spec("drums/snare/gated-80s.wav", "Gated 80s Snare", "snare", &["retro", "big", "wide", "vintage"], &["synthwave", "pop"], || {
            let x = snare(&Snare { f: 180.0, body: 0.9, noise: 0.9, noise_ms: 250.0, crack: 0.5, drive: 0.35, seed: 218, ..SNARE });
            gated(&vec![x], &rev(0.0, 0.9, 2.2).damp(8000.0).low(200.0).pre(3.0), 0.7, 280.0, 50.0)
        }),
        spec("drums/snare/drill-sharp.wav", "Sharp Drill Snare", "snare", &["bright", "short", "hard"], &["drill", "trap"], || {
            let x = snare(&Snare {
                f: 260.0,
                r2: 1.5,
                body: 0.6,
                body_ms: 90.0,
                bend: 0.5,
                noise: 1.0,
                n_hp: 2500.0,
                n_lp: 14_000.0,
                noise_ms: 160.0,
                crack: 0.9,
                crack_hz: 5000.0,
                drive: 0.4,
                hp: 150.0,
                seed: 219,
                ..SNARE
            });
            vec![reverb_mono(&x, &rev(2.0, 0.25, 0.5).low(500.0), 0.08, 0.3)]
        }),
        spec("drums/snare/pop-clean.wav", "Clean Pop Snare", "snare", &["clean", "punchy", "modern"], &["pop", "rnb", "future-bass"], || {
            let x = snare(&Snare { f: 205.0, body: 0.8, body_ms: 130.0, noise: 0.75, noise_ms: 200.0, crack: 0.5, drive: 0.25, seed: 220, ..SNARE });
            reverb(&vec![x], &rev(2.0, 0.4, 1.0).pre(12.0).low(300.0), 0.15, 0.8)
        }),
        spec("drums/snare/techno-noise.wav", "Noisy Techno Snare", "snare", &["dirty", "short", "distorted"], &["techno", "tech-house"], || {
            let x = snare(&Snare {
                f: 230.0,
                body: 0.4,
                body_ms: 80.0,
                noise: 1.0,
                n_hp: 1800.0,
                n_lp: 9000.0,
                noise_ms: 150.0,
                crack: 0.6,
                drive: 0.7,
                seed: 221,
                ..SNARE
            });
            vec![x]
        }),
        spec("drums/snare/dubstep-huge.wav", "Huge Dubstep Snare", "snare", &["big", "aggressive", "distorted", "wide"], &["dubstep", "future-bass", "edm"], || {
            let x = snare(&Snare {
                f: 190.0,
                body: 1.0,
                body_ms: 180.0,
                noise: 0.9,
                noise_ms: 280.0,
                tail: 0.25,
                tail_ms: 450.0,
                crack: 0.7,
                drive: 0.8,
                seed: 222,
                ..SNARE
            });
            reverb(&vec![x], &rev(1.0, 0.7, 1.6).pre(12.0).low(350.0), 0.25, 1.6)
        }),
        spec("drums/snare/rnb-soft.wav", "Soft R&B Snare", "snare", &["soft", "warm", "organic"], &["rnb", "pop", "lofi"], || {
            let x = snare(&Snare {
                f: 195.0,
                body: 0.7,
                body_ms: 120.0,
                noise: 0.55,
                n_hp: 1000.0,
                n_lp: 7000.0,
                noise_ms: 220.0,
                crack: 0.25,
                crack_hz: 2800.0,
                drive: 0.2,
                lp: 9000.0,
                seed: 223,
                ..SNARE
            });
            reverb(&vec![x], &rev(0.0, 0.5, 0.9).damp(6000.0).low(250.0), 0.18, 0.7)
        }),
        spec("drums/snare/dembow-tight.wav", "Tight Dembow Snare", "snare", &["short", "bright", "punchy"], &["reggaeton", "afrobeats"], || {
            let x = snare(&Snare {
                f: 230.0,
                body: 0.75,
                body_ms: 100.0,
                noise: 0.8,
                n_hp: 1600.0,
                n_lp: 11_000.0,
                noise_ms: 140.0,
                crack: 0.6,
                drive: 0.35,
                seed: 224,
                ..SNARE
            });
            vec![reverb_mono(&x, &rev(0.0, 0.25, 0.4).low(400.0), 0.08, 0.3)]
        }),
        spec("drums/snare/rimshot.wav", "Rimshot Snare", "snare", &["bright", "punchy", "hard"], &["boom-bap", "dnb", "rnb", "pop"], || {
            let mut x = snare(&Snare { f: 240.0, body: 0.9, body_ms: 100.0, noise: 0.6, noise_ms: 160.0, crack: 0.9, crack_hz: 2800.0, crack_ms: 4.0, drive: 0.4, seed: 225, ..SNARE });
            let ring = modes(&[(1650.0, 0.5, 0.04, 0.0), (2900.0, 0.3, 0.025, 0.0)], ns(0.08));
            add(&mut x, &ring, 1.0, 0);
            vec![reverb_mono(&x, &rev(0.0, 0.3, 0.5).low(300.0), 0.1, 0.3)]
        }),
        spec("drums/snare/brushed.wav", "Brushed Snare", "snare", &["soft", "warm", "organic", "lofi"], &["lofi", "rnb", "boom-bap"], || {
            let mut x = snare(&Snare { f: 190.0, body: 0.3, body_ms: 90.0, noise: 0.9, n_hp: 800.0, n_lp: 6000.0, noise_ms: 240.0, crack: 0.0, drive: 0.0, seed: 226, ..SNARE });
            // a swish, not a stick: soften the first 8 ms
            for (i, v) in x.iter_mut().enumerate().take(ns(0.008)) {
                *v *= i as f32 / ns(0.008) as f32;
            }
            vec![reverb_mono(&x, &rev(0.0, 0.4, 0.6).damp(5000.0).low(250.0), 0.12, 0.3)]
        }),
        spec("drums/snare/phonk-dirty.wav", "Dirty Phonk Snare", "snare", &["dirty", "distorted", "lofi", "aggressive"], &["phonk", "trap"], || {
            let mut x = snare(&Snare { f: 200.0, body: 1.0, noise: 0.9, crack: 0.7, drive: 0.9, seed: 227, ..SNARE });
            normalize(&mut x, 0.9);
            crush(&mut x, 8.0, 3);
            lp(&mut x, 6000.0);
            vec![x]
        }),
    ]
}

// ── Clap ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub(crate) struct Clap {
    pub bursts: usize,
    pub spacing: f32,
    pub jitter: f32,
    pub burst_ms: f32,
    pub tail_ms: f32,
    pub bp: f32,
    pub q: f32,
    pub hp: f32,
    pub bright: f32,
    pub drive: f32,
    pub lp: f32,
    pub seed: u32,
}

pub(crate) const CLAP: Clap =
    Clap { bursts: 4, spacing: 9.0, jitter: 1.2, burst_ms: 2.6, tail_ms: 200.0, bp: 1150.0, q: 0.9, hp: 480.0, bright: 0.4, drive: 0.2, lp: 11_000.0, seed: 401 };

/// One channel of a clap: several short bursts, the last one rings out.
pub(crate) fn clap_ch(p: &Clap, seed: u32) -> Vec<f32> {
    let mut nz = Noise::new(seed);
    let mut times = vec![0.0f32];
    for i in 1..p.bursts.max(1) {
        times.push(i as f32 * p.spacing + nz.white() * p.jitter);
    }
    let last = *times.last().unwrap_or(&0.0);
    let n = ns((last + p.tail_ms) / 1000.0 + 0.005);
    let mut bp = svf(BP, p.bp, p.q);
    let mut h = svf(HP, p.hp, 0.7);
    let mut hb = svf(BP, p.bp * 2.6, 0.8);
    let gains: Vec<f32> = (0..times.len()).map(|i| if i + 1 == times.len() { 1.0 } else { 0.8 + 0.2 * nz.unit() }).collect();
    let mut out = vec![0.0f32; n];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR * 1000.0;
        let mut env = 0.0f32;
        for (k, &tk) in times.iter().enumerate() {
            if t >= tk {
                let d = t - tk;
                let e = if k + 1 < times.len() { (d / 0.12).min(1.0) * (-d / p.burst_ms).exp() * gains[k] } else { (d / 0.25).min(1.0) * dec60(d, p.tail_ms) };
                env = env.max(e);
            }
        }
        let w = nz.white();
        let body = tick(&mut h, tick(&mut bp, w)) * 1.8;
        let br = tick(&mut hb, w) * p.bright;
        *o = (body + br) * env;
    }
    if p.drive > 0.0 {
        normalize(&mut out, 1.0);
        drive(&mut out, 1.0 + 4.0 * p.drive, 0.0);
    }
    if p.lp < 19_000.0 {
        lp(&mut out, p.lp);
    }
    out
}

/// A clap rendered twice with different burst timing and noise per side.
pub(crate) fn clap(p: &Clap, width: f32) -> Chans {
    let a = clap_ch(p, p.seed);
    if width <= 0.0 {
        return vec![a];
    }
    let b = clap_ch(p, p.seed.wrapping_add(7777));
    stereo_pair(&a, &b, width)
}

fn claps() -> Vec<Spec> {
    vec![
        spec("drums/clap/classic-house.wav", "House Clap", "clap", &["bright", "wide"], &["house", "deep-house", "tech-house"], || {
            reverb(&clap(&Clap { seed: 411, ..CLAP }, 0.4), &rev(2.0, 0.35, 0.9).pre(8.0).low(300.0), 0.16, 0.7)
        }),
        spec("drums/clap/tight-trap.wav", "Tight Trap Clap", "clap", &["short", "punchy"], &["trap", "drill", "phonk"], || {
            let c = clap_ch(&Clap { bursts: 3, spacing: 7.0, burst_ms: 2.0, tail_ms: 140.0, bp: 1300.0, bright: 0.55, drive: 0.3, seed: 412, ..CLAP }, 412);
            vec![reverb_mono(&c, &rev(0.0, 0.3, 0.5).low(400.0), 0.1, 0.3)]
        }),
        spec("drums/clap/big-room.wav", "Big Room Clap", "clap", &["big", "wide", "long", "bright"], &["edm", "future-bass"], || {
            let c = clap(&Clap { bursts: 5, spacing: 10.0, tail_ms: 260.0, bright: 0.5, drive: 0.3, seed: 413, ..CLAP }, 0.7);
            reverb(&c, &rev(1.0, 0.75, 1.8).pre(18.0).low(350.0).damp(9000.0), 0.32, 1.5)
        }),
        spec("drums/clap/dry-short.wav", "Dry Short Clap", "clap", &["short", "clean", "mono", "small"], &["tech-house", "techno", "pop"], || {
            clap(&Clap { bursts: 3, spacing: 6.0, burst_ms: 2.2, tail_ms: 90.0, bp: 1250.0, drive: 0.15, seed: 414, ..CLAP }, 0.0)
        }),
        spec("drums/clap/wide-stereo.wav", "Wide Stereo Clap", "clap", &["wide", "bright", "modern"], &["pop", "future-bass", "edm"], || {
            let c = clap(&Clap { spacing: 8.5, tail_ms: 190.0, bp: 1350.0, bright: 0.6, seed: 415, ..CLAP }, 1.0);
            reverb(&c, &rev(2.0, 0.5, 1.2).pre(10.0).low(300.0), 0.2, 1.0)
        }),
        spec("drums/clap/lofi-dusty.wav", "Dusty Lo-fi Clap", "clap", &["lofi", "vintage", "dirty", "soft"], &["lofi", "boom-bap"], || {
            let mut a = clap_ch(&Clap { bp: 950.0, bright: 0.2, drive: 0.35, lp: 5000.0, seed: 416, ..CLAP }, 416);
            normalize(&mut a, 0.9);
            crush(&mut a, 11.0, 2);
            lp(&mut a, 4800.0);
            vec![reverb_mono(&a, &rev(0.0, 0.4, 0.7).damp(4000.0).low(250.0), 0.18, 0.4)]
        }),
        spec("drums/clap/gated-80s.wav", "Gated 80s Clap", "clap", &["retro", "big", "vintage"], &["synthwave", "pop"], || {
            gated(&clap(&Clap { tail_ms: 180.0, seed: 417, ..CLAP }, 0.3), &rev(0.0, 0.9, 2.0).damp(7000.0).low(250.0), 0.6, 260.0, 45.0)
        }),
        spec("drums/clap/snappy-pop.wav", "Snappy Pop Clap", "clap", &["bright", "punchy", "clean"], &["pop", "rnb", "afrobeats", "reggaeton"], || {
            let c = clap(&Clap { spacing: 8.0, tail_ms: 160.0, bp: 1400.0, bright: 0.7, drive: 0.25, seed: 418, ..CLAP }, 0.35);
            reverb(&c, &rev(2.0, 0.3, 0.8).pre(6.0).low(350.0), 0.12, 0.6)
        }),
        spec("drums/clap/roomy-rnb.wav", "Roomy R&B Clap", "clap", &["soft", "warm", "wide", "organic"], &["rnb", "lofi", "pop"], || {
            let c = clap(&Clap { tail_ms: 220.0, bp: 1050.0, bright: 0.25, drive: 0.1, lp: 9000.0, seed: 419, ..CLAP }, 0.5);
            reverb(&c, &rev(0.0, 0.6, 1.1).damp(6000.0).low(250.0), 0.3, 0.9)
        }),
        spec("drums/clap/layered-edm.wav", "Layered EDM Clap", "clap", &["big", "bright", "wide", "hard"], &["edm", "dubstep", "future-bass"], || {
            let mut c = clap(&Clap { bursts: 4, spacing: 9.5, tail_ms: 230.0, bp: 1250.0, bright: 0.6, drive: 0.4, seed: 420, ..CLAP }, 0.8);
            // a second, brighter clap from the drum voice and a snare body underneath
            let lay = drum_render(DrumKind::Clap, DrumParams { tune: 2.0, decay_ms: 200.0, tone: 0.7, snap: 0.8, drive: 0.3 }, SR, 421);
            let body = snare(&Snare { f: 210.0, body: 1.0, body_ms: 90.0, noise: 0.2, noise_ms: 80.0, crack: 0.3, seed: 422, ..SNARE });
            add(&mut c[0], &lay, 0.5, 0);
            add(&mut c[1], &lay, 0.5, 0);
            add(&mut c[0], &body, 0.35, 0);
            add(&mut c[1], &body, 0.35, 0);
            even(&mut c);
            reverb(&c, &rev(1.0, 0.65, 1.5).pre(14.0).low(350.0), 0.22, 1.4)
        }),
        spec("drums/clap/phonk-crushed.wav", "Crushed Phonk Clap", "clap", &["dirty", "distorted", "lofi"], &["phonk", "trap", "drill"], || {
            let mut a = clap_ch(&Clap { drive: 0.6, seed: 423, ..CLAP }, 423);
            normalize(&mut a, 0.9);
            crush(&mut a, 8.0, 3);
            lp(&mut a, 6000.0);
            hp(&mut a, 300.0);
            vec![a]
        }),
        spec("drums/clap/afro-light.wav", "Light Afro Clap", "clap", &["soft", "short", "organic", "small"], &["afrobeats", "reggaeton", "house", "pop"], || {
            let a = clap_ch(&Clap { bursts: 3, spacing: 7.0, burst_ms: 2.0, tail_ms: 120.0, bp: 1500.0, bright: 0.3, drive: 0.1, seed: 424, ..CLAP }, 424);
            vec![reverb_mono(&a, &rev(0.0, 0.3, 0.5).low(350.0), 0.1, 0.3)]
        }),
    ]
}

// ── Hats ────────────────────────────────────────────────────────────────

/// Inharmonic square-oscillator sets: the classic analog hat ratios, a
/// brighter clangy set, and our own wider set.
const HAT_SETS: [[f32; 6]; 3] = [
    [205.3, 304.4, 369.6, 522.7, 540.0, 800.0],
    [263.0, 401.0, 541.0, 627.0, 773.0, 911.0],
    [317.0, 421.0, 489.0, 597.0, 731.0, 1053.0],
];

#[derive(Clone, Copy)]
pub(crate) struct Hat {
    pub set: usize,
    pub pitch: f32,
    pub metal: f32,
    pub noise: f32,
    pub bp: f32,
    pub q: f32,
    pub hp: f32,
    pub lp: f32,
    pub decay: f32,
    pub open: bool,
    pub drive: f32,
    pub seed: u32,
}

pub(crate) const HAT: Hat =
    Hat { set: 0, pitch: 1.0, metal: 1.0, noise: 0.45, bp: 9000.0, q: 1.0, hp: 7000.0, lp: 16_000.0, decay: 55.0, open: false, drive: 0.1, seed: 301 };

pub(crate) fn hat(p: &Hat) -> Vec<f32> {
    let n = ns(p.decay / 1000.0 * if p.open { 1.3 } else { 1.1 } + 0.004);
    let mut nz = Noise::new(p.seed);
    let freqs = HAT_SETS[p.set % HAT_SETS.len()];
    let mut ph = [0.0f64; 6];
    for x in ph.iter_mut() {
        *x = nz.unit() as f64;
    }
    let mut bp = svf(BP, p.bp, p.q);
    let mut h1 = svf(HP, p.hp, 0.54);
    let mut h2 = svf(HP, p.hp, 1.31);
    let mut nh = svf(HP, p.hp + 800.0, 0.7);
    let mut lpf = svf(LP, p.lp, 0.7);
    let mut out = vec![0.0f32; n];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR * 1000.0;
        let mut m = 0.0;
        for k in 0..6 {
            let (q, dt) = step(&mut ph[k], freqs[k] * p.pitch);
            m += square(q, dt);
        }
        let metal = tick(&mut h2, tick(&mut h1, tick(&mut bp, m / 6.0)));
        let nn = tick(&mut nh, nz.white());
        let x = tick(&mut lpf, metal * 2.2 * p.metal + nn * p.noise);
        let att = (t / 0.2).min(1.0);
        let env = if p.open { 0.3 * (-t / 12.0).exp() + 0.7 * dec60(t, p.decay) } else { 0.55 * (-t / (p.decay * 0.12)).exp() + 0.45 * dec60(t, p.decay) };
        *o = x * env * att;
    }
    if p.drive > 0.0 {
        normalize(&mut out, 1.0);
        drive(&mut out, 1.0 + 4.0 * p.drive, 0.0);
    }
    out
}

fn hats() -> Vec<Spec> {
    let h = |p: Hat| move || vec![hat(&p)];
    vec![
        spec("drums/hat/tight.wav", "Tight Closed Hat", "hat", &["short", "clean", "bright"], &[], h(Hat { decay: 45.0, seed: 311, ..HAT })),
        spec("drums/hat/crisp.wav", "Crisp Closed Hat", "hat", &["bright", "short", "modern"], &["house", "pop", "edm"], h(Hat { set: 1, decay: 60.0, noise: 0.6, bp: 10_000.0, seed: 312, ..HAT })),
        spec(
            "drums/hat/soft.wav",
            "Soft Closed Hat",
            "hat",
            &["soft", "warm"],
            &["rnb", "deep-house", "lofi"],
            h(Hat { pitch: 0.9, metal: 0.7, noise: 0.3, bp: 8000.0, lp: 10_000.0, decay: 70.0, drive: 0.0, seed: 313, ..HAT }),
        ),
        spec("drums/hat/dusty.wav", "Dusty Closed Hat", "hat", &["lofi", "vintage", "dirty"], &["lofi", "boom-bap"], || {
            let mut x = hat(&Hat { set: 2, decay: 55.0, lp: 9000.0, bp: 8000.0, drive: 0.3, seed: 314, ..HAT });
            normalize(&mut x, 0.9);
            crush(&mut x, 10.0, 2);
            lp(&mut x, 7500.0);
            vec![x]
        }),
        spec(
            "drums/hat/trap-sharp.wav",
            "Sharp Trap Hat",
            "hat",
            &["bright", "short", "hard"],
            &["trap", "drill", "phonk"],
            h(Hat { set: 1, pitch: 1.15, noise: 0.7, bp: 11_000.0, decay: 35.0, drive: 0.25, seed: 315, ..HAT }),
        ),
        spec(
            "drums/hat/bright-house.wav",
            "Bright House Hat",
            "hat",
            &["bright", "airy"],
            &["house", "tech-house", "techno"],
            h(Hat { pitch: 1.05, noise: 0.5, bp: 10_000.0, lp: 18_000.0, decay: 80.0, seed: 316, ..HAT }),
        ),
        spec(
            "drums/hat/metallic.wav",
            "Metallic Closed Hat",
            "hat",
            &["metallic", "bright"],
            &["techno", "tech-house"],
            h(Hat { set: 2, pitch: 1.2, metal: 1.4, noise: 0.2, bp: 8500.0, q: 1.4, decay: 70.0, seed: 317, ..HAT }),
        ),
        spec("drums/hat/noisy.wav", "Noisy Closed Hat", "hat", &["dirty", "short"], &["dnb", "dubstep", "techno"], h(Hat { metal: 0.2, noise: 1.0, hp: 8000.0, decay: 60.0, drive: 0.3, seed: 318, ..HAT })),
        spec("drums/hat/tick.wav", "Tick Hat", "hat", &["short", "small", "clean"], &["trap", "tech-house", "pop"], h(Hat { set: 1, pitch: 1.1, noise: 0.6, bp: 11_000.0, decay: 22.0, seed: 319, ..HAT })),
        spec(
            "drums/hat/dark.wav",
            "Dark Closed Hat",
            "hat",
            &["dark", "soft", "warm"],
            &["deep-house", "rnb", "afrobeats"],
            h(Hat { pitch: 0.8, bp: 6500.0, hp: 5500.0, lp: 7500.0, decay: 70.0, noise: 0.35, seed: 320, ..HAT }),
        ),
        spec(
            "drums/hat/pedal.wav",
            "Pedal Hat",
            "hat",
            &["soft", "short", "small"],
            &["house", "rnb", "lofi", "boom-bap"],
            h(Hat { pitch: 0.85, metal: 0.8, noise: 0.3, bp: 7000.0, hp: 5000.0, lp: 11_000.0, decay: 35.0, drive: 0.0, seed: 321, ..HAT }),
        ),
        spec("drums/hat/house-shuffle.wav", "Shuffle House Hat", "hat", &["bright", "airy"], &["house", "tech-house", "deep-house"], h(Hat { set: 1, noise: 0.55, bp: 9500.0, decay: 110.0, seed: 322, ..HAT })),
        spec("drums/hat/phonk-dirty.wav", "Dirty Phonk Hat", "hat", &["dirty", "lofi", "gritty"], &["phonk", "trap", "drill"], || {
            let mut x = hat(&Hat { set: 2, noise: 0.7, decay: 50.0, drive: 0.6, seed: 323, ..HAT });
            normalize(&mut x, 0.9);
            crush(&mut x, 8.0, 2);
            lp(&mut x, 9000.0);
            vec![x]
        }),
    ]
}

fn openhats() -> Vec<Spec> {
    let o = |p: Hat, w: f32| {
        move || {
            let a = hat(&p);
            if w <= 0.0 {
                return vec![a];
            }
            let b = hat(&Hat { seed: p.seed + 5000, ..p });
            stereo_pair(&a, &b, w)
        }
    };
    let open = Hat { open: true, decay: 450.0, noise: 0.5, ..HAT };
    vec![
        spec("drums/openhat/classic.wav", "Classic Open Hat", "openhat", &["bright", "metallic"], &["house", "techno", "edm"], o(Hat { seed: 331, ..open }, 0.0)),
        spec("drums/openhat/long.wav", "Long Open Hat", "openhat", &["long", "bright", "airy"], &["edm", "trap", "future-bass"], o(Hat { set: 1, decay: 900.0, noise: 0.6, seed: 332, ..open }, 0.3)),
        spec(
            "drums/openhat/short-offbeat.wav",
            "Short Offbeat Open Hat",
            "openhat",
            &["short", "bright", "punchy"],
            &["house", "tech-house", "edm"],
            o(Hat { decay: 220.0, pitch: 1.05, bp: 10_000.0, seed: 333, ..open }, 0.0),
        ),
        spec(
            "drums/openhat/dark.wav",
            "Dark Open Hat",
            "openhat",
            &["dark", "warm"],
            &["deep-house", "techno", "rnb"],
            o(Hat { pitch: 0.82, bp: 6500.0, hp: 5500.0, lp: 8000.0, decay: 520.0, seed: 334, ..open }, 0.0),
        ),
        spec(
            "drums/openhat/sizzle.wav",
            "Sizzle Open Hat",
            "openhat",
            &["bright", "airy", "dirty"],
            &["trap", "dubstep", "dnb"],
            o(Hat { set: 1, metal: 0.6, noise: 1.0, hp: 8000.0, lp: 18_000.0, decay: 600.0, drive: 0.3, seed: 335, ..open }, 0.4),
        ),
        spec("drums/openhat/lofi.wav", "Lo-fi Open Hat", "openhat", &["lofi", "vintage", "soft"], &["lofi", "boom-bap"], || {
            let mut x = hat(&Hat { set: 2, open: true, decay: 380.0, bp: 7500.0, lp: 8000.0, noise: 0.4, drive: 0.2, seed: 336, ..HAT });
            normalize(&mut x, 0.9);
            crush(&mut x, 10.0, 2);
            lp(&mut x, 7000.0);
            vec![x]
        }),
    ]
}

// ── Cymbals (modal) ─────────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub(crate) struct Cym {
    pub modes: usize,
    pub f_lo: f32,
    pub f_hi: f32,
    /// Mode amplitude tilt: amp ∝ (f / 2 kHz)^tilt.
    pub tilt: f32,
    /// T60 (s) of a 2 kHz mode; higher modes decay faster by (2k/f)^t60_exp.
    pub t60: f32,
    pub t60_exp: f32,
    pub noise: f32,
    pub n_hp: f32,
    pub n_lp: f32,
    pub noise_t60: f32,
    /// Ride bell partials.
    pub bell: f32,
    pub bell_hz: f32,
    pub bell_t60: f32,
    /// Stick ping.
    pub ping: f32,
    pub ping_hz: f32,
    /// Extra level in the first ~30 ms.
    pub swell: f32,
    pub hp: f32,
    pub lp: f32,
    pub len: f32,
    pub width: f32,
    pub seed: u32,
}

pub(crate) const CRASH: Cym = Cym {
    modes: 260,
    f_lo: 500.0,
    f_hi: 16_000.0,
    tilt: 0.15,
    t60: 2.2,
    t60_exp: 0.15,
    noise: 1.0,
    n_hp: 3500.0,
    n_lp: 15_000.0,
    noise_t60: 2.0,
    bell: 0.0,
    bell_hz: 700.0,
    bell_t60: 2.0,
    ping: 0.0,
    ping_hz: 5000.0,
    swell: 1.0,
    hp: 350.0,
    lp: 17_000.0,
    len: 2.4,
    width: 0.6,
    seed: 501,
};

pub(crate) fn cymbal(p: &Cym) -> Chans {
    let n = ns(p.len);
    let mut nz = Noise::new(p.seed);
    let mut set: Vec<(f32, f32, f32)> = Vec::with_capacity(p.modes + 5);
    for _ in 0..p.modes {
        let f = p.f_lo * (p.f_hi / p.f_lo).powf(nz.unit());
        let a = (0.2 + 0.8 * nz.unit()) * (f / 2000.0).powf(p.tilt);
        let t = (p.t60 * (2000.0 / f).powf(p.t60_exp)).min(p.t60 * 1.25) * (0.6 + 0.8 * nz.unit());
        set.push((f, a, t));
    }
    if p.bell > 0.0 {
        for (r, a, tm) in [(1.0, 1.0, 1.0), (2.32, 0.7, 0.8), (2.98, 0.45, 0.7), (4.16, 0.35, 0.55), (5.41, 0.2, 0.45)] {
            set.push((p.bell_hz * r, a * p.bell * 3.0, p.bell_t60 * tm));
        }
    }
    let mut chans = Vec::with_capacity(2);
    for c in 0..2u32 {
        let mut cn = Noise::new(p.seed.wrapping_mul(31).wrapping_add(c * 7919 + 1));
        let m: Vec<(f32, f32, f32, f32)> = set.iter().map(|&(f, a, t)| (f * (1.0 + 0.0008 * cn.white()), a * (0.8 + 0.4 * cn.unit()), t, cn.unit())).collect();
        let mut x = modes(&m, n);
        normalize(&mut x, 1.0);
        let mut h = svf(HP, p.n_hp, 0.7);
        let mut l = svf(LP, p.n_lp, 0.7);
        let mut pb = svf(BP, p.ping_hz, 1.5);
        for (i, v) in x.iter_mut().enumerate() {
            let t = i as f32 / SR;
            let w = cn.white();
            let wash = tick(&mut l, tick(&mut h, w)) * dec60(t, p.noise_t60) * p.noise;
            let ping = tick(&mut pb, w) * (-t / 0.004).exp() * p.ping * 2.0;
            let att = (t / 0.0012).min(1.0);
            let sw = 1.0 + p.swell * (-t / 0.03).exp();
            *v = ((*v + wash) * sw + ping) * att;
        }
        hp4(&mut x, p.hp);
        lp(&mut x, p.lp);
        chans.push(x);
    }
    stereo_pair(&chans[0], &chans[1], p.width)
}

fn cymbals() -> Vec<Spec> {
    let ride = Cym {
        modes: 150,
        f_lo: 700.0,
        f_hi: 12_000.0,
        tilt: -0.1,
        t60: 2.8,
        t60_exp: 0.2,
        noise: 0.3,
        n_hp: 5000.0,
        n_lp: 13_000.0,
        noise_t60: 1.2,
        bell: 0.25,
        bell_hz: 760.0,
        bell_t60: 2.5,
        ping: 0.8,
        ping_hz: 5200.0,
        swell: 0.3,
        hp: 400.0,
        len: 2.4,
        width: 0.35,
        seed: 511,
        ..CRASH
    };
    vec![
        spec("drums/ride/classic.wav", "Classic Ride", "ride", &["metallic", "bright", "long"], &["house", "techno", "dnb"], move || cymbal(&ride)),
        spec("drums/ride/dark.wav", "Dark Ride", "ride", &["dark", "warm", "long"], &["deep-house", "lofi", "rnb"], move || {
            cymbal(&Cym { f_hi: 8000.0, tilt: -0.4, lp: 9000.0, n_lp: 8000.0, noise: 0.2, bell: 0.15, bell_hz: 640.0, ping: 0.5, ping_hz: 4000.0, seed: 512, ..ride })
        }),
        spec("drums/ride/bell.wav", "Ride Bell", "ride", &["metallic", "bright"], &["house", "afrobeats", "reggaeton", "tech-house"], move || {
            vec![mono_sum(&cymbal(&Cym { modes: 60, t60: 1.6, bell: 1.0, bell_hz: 820.0, bell_t60: 1.6, ping: 1.0, noise: 0.15, len: 1.9, seed: 513, ..ride }))]
        }),
        spec("drums/crash/bright.wav", "Bright Crash", "crash", &["bright", "big", "long"], &["edm", "pop", "dubstep"], || cymbal(&Cym { seed: 521, ..CRASH })),
        spec("drums/crash/dark.wav", "Dark Crash", "crash", &["dark", "warm", "long"], &["rnb", "lofi", "deep-house"], || {
            cymbal(&Cym { f_lo: 400.0, f_hi: 9000.0, tilt: -0.2, n_hp: 2500.0, n_lp: 8000.0, lp: 9000.0, t60: 2.4, seed: 522, ..CRASH })
        }),
        spec("drums/crash/long-wash.wav", "Long Wash Crash", "crash", &["long", "wide", "big", "airy"], &["edm", "future-bass", "synthwave"], || {
            cymbal(&Cym { t60: 3.0, noise_t60: 2.6, len: 2.9, width: 0.85, swell: 0.6, seed: 523, ..CRASH })
        }),
        spec("drums/crash/short-splash.wav", "Short Splash", "crash", &["short", "bright", "small"], &["dnb", "pop", "trap"], || {
            cymbal(&Cym { f_lo: 900.0, t60: 0.9, noise_t60: 0.8, len: 1.4, swell: 1.4, width: 0.5, seed: 524, ..CRASH })
        }),
    ]
}

// ── Toms ────────────────────────────────────────────────────────────────

/// Circular-membrane mode ratios (ratio, amplitude, decay multiplier).
pub(crate) const MEMBRANE: [(f32, f32, f32); 4] = [(1.0, 1.0, 1.0), (1.594, 0.42, 0.55), (2.136, 0.26, 0.4), (2.653, 0.15, 0.3)];

#[derive(Clone, Copy)]
pub(crate) struct Drum {
    pub f: f32,
    pub bend: f32,
    pub bend_ms: f32,
    /// T60 of the fundamental (ms).
    pub decay: f32,
    pub m: [(f32, f32, f32); 4],
    pub slap: f32,
    pub slap_hz: f32,
    pub slap_ms: f32,
    pub drive: f32,
    pub lp: f32,
    pub seed: u32,
}

pub(crate) const DRUM: Drum = Drum { f: 120.0, bend: 0.35, bend_ms: 45.0, decay: 500.0, m: MEMBRANE, slap: 0.3, slap_hz: 3000.0, slap_ms: 2.0, drive: 0.15, lp: 12_000.0, seed: 601 };

pub(crate) fn membrane(p: &Drum) -> Vec<f32> {
    let n = ns(p.decay / 1000.0 + 0.01);
    let mut nz = Noise::new(p.seed);
    let mut sb = svf(BP, p.slap_hz, 1.0);
    let mut ph = [0.0f64; 4];
    let mut out = vec![0.0f32; n];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR * 1000.0;
        let b = 1.0 + p.bend * (-t / p.bend_ms).exp();
        let mut x = 0.0;
        for (phk, &(r, a, d)) in ph.iter_mut().zip(&p.m) {
            let (q, _) = step(phk, p.f * r * b);
            x += (q * TAU64).sin() as f32 * a * dec60(t, p.decay * d);
        }
        let s = tick(&mut sb, nz.white()) * (-t / p.slap_ms).exp() * p.slap * 2.0;
        *o = x + s;
    }
    if p.drive > 0.0 {
        normalize(&mut out, 1.0);
        drive(&mut out, 1.0 + 4.0 * p.drive, 0.0);
    }
    if p.lp < 19_000.0 {
        lp(&mut out, p.lp);
    }
    out
}

fn toms() -> Vec<Spec> {
    let room = rev(0.0, 0.45, 0.8).low(150.0).damp(7000.0);
    vec![
        spec("drums/tom/low.wav", "Low Tom", "tom", &["deep", "warm", "organic"], &[], move || {
            vec![reverb_mono(&membrane(&Drum { f: 92.0, decay: 650.0, seed: 611, ..DRUM }), &room, 0.12, 0.4)]
        }),
        spec("drums/tom/mid.wav", "Mid Tom", "tom", &["warm", "organic"], &[], move || {
            vec![reverb_mono(&membrane(&Drum { f: 132.0, decay: 520.0, seed: 612, ..DRUM }), &room, 0.12, 0.4)]
        }),
        spec("drums/tom/high.wav", "High Tom", "tom", &["bright", "organic"], &[], move || {
            vec![reverb_mono(&membrane(&Drum { f: 185.0, decay: 420.0, seed: 613, ..DRUM }), &room, 0.12, 0.4)]
        }),
        spec("drums/tom/electronic-80s.wav", "Electronic 80s Tom", "tom", &["retro", "vintage", "big"], &["synthwave", "pop"], || {
            let x = membrane(&Drum { f: 110.0, bend: 1.0, bend_ms: 120.0, decay: 600.0, m: [(1.0, 1.0, 1.0), (2.0, 0.08, 0.3), (0.0, 0.0, 1.0), (0.0, 0.0, 1.0)], slap: 0.5, slap_hz: 2000.0, drive: 0.3, seed: 614, ..DRUM });
            gated(&vec![x], &rev(0.0, 0.85, 1.8).damp(7000.0).low(150.0), 0.35, 300.0, 60.0)
        }),
    ]
}

// ── Fills ───────────────────────────────────────────────────────────────

/// A snare build that ends on its last bar line: the subdivisions get
/// faster, louder, brighter and higher toward the downbeat.
fn snare_build(bars: u32, seed: u32) -> Chans {
    let n = bars as usize * BAR;
    // (start bar, end bar, hits per bar) segments
    let plan: Vec<(f32, f32, usize)> = match bars {
        1 => vec![(0.0, 1.0, 16)],
        2 => vec![(0.0, 1.0, 8), (1.0, 1.5, 16), (1.5, 2.0, 32)],
        _ => vec![(0.0, 1.0, 4), (1.0, 2.0, 8), (2.0, 3.0, 16), (3.0, 3.5, 32), (3.5, 4.0, 64)],
    };
    let semis = match bars {
        1 => 3.0,
        2 => 7.0,
        _ => 12.0,
    };
    let mut out = vec![0.0f32; n];
    let mut k = 0u32;
    for (b0, b1, per) in plan {
        let step = BAR as f64 / per as f64;
        let mut pos = b0 as f64 * BAR as f64;
        while pos < b1 as f64 * BAR as f64 - 0.5 {
            let at = pos.round() as usize;
            let u = at as f32 / n as f32;
            let vel = 0.32 + 0.68 * u.powf(1.3);
            let ratio = (semis * u / 12.0).exp2();
            let hit = snare(&Snare {
                f: 215.0 * ratio,
                body: 0.75,
                body_ms: 110.0,
                noise: 0.85,
                n_hp: 1500.0,
                n_lp: 12_000.0,
                noise_ms: 170.0,
                crack: 0.55,
                drive: 0.35,
                seed: seed.wrapping_add(k * 13),
                ..SNARE
            });
            add(&mut out, &hit, vel, at);
            k += 1;
            pos += step;
        }
    }
    out.truncate(n);
    sweep(&mut out, LP, 0.8, |u| 2500.0 * (16_000.0f32 / 2500.0).powf(u.powf(0.8)));
    let mut x = reverb_mono(&out, &rev(2.0, 0.45, 1.1).pre(8.0).low(350.0), 0.16, 0.0);
    x.truncate(n);
    vec![x]
}

fn fills() -> Vec<Spec> {
    let tags: &[&'static str] = &["bright", "punchy", "big"];
    let genres: &[&'static str] = &["edm", "house", "future-bass", "dubstep", "pop", "techno"];
    vec![
        spec("drums/fill/snare-roll-1bar.wav", "Snare Roll 1 Bar", "fill", tags, genres, || snare_build(1, 701)).bars(1).fades(0.15, 3.0),
        spec("drums/fill/snare-build-2bar.wav", "Snare Build 2 Bars", "fill", tags, genres, || snare_build(2, 711)).bars(2).fades(0.15, 3.0),
        spec("drums/fill/snare-build-4bar.wav", "Snare Build 4 Bars", "fill", tags, genres, || snare_build(4, 721)).bars(4).fades(0.15, 3.0),
    ]
}

pub(crate) fn specs() -> Vec<Spec> {
    let mut v = Vec::new();
    v.extend(kicks());
    v.extend(snares());
    v.extend(claps());
    v.extend(hats());
    v.extend(openhats());
    v.extend(cymbals());
    v.extend(toms());
    v.extend(fills());
    v
}
