//! Wave 7b drum fills: tom runs, trap snare / hat rolls, clap and triplet
//! builds, a breakbeat-style ghost-note fill, a pop kit fill and a hand-drum
//! fill. Exactly 1 or 2 bars at 128 BPM; the last hit leads into the next
//! downbeat (no crash on the downbeat itself, so they layer over any drop).

use super::drums::{clap_ch, hat, kick, membrane, snare, Clap, Drum, Hat, Kick, Snare, CLAP, DRUM, HAT, KICK, SNARE};
use super::kit::*;
use super::library::{spec, Spec};
use super::synth::*;

/// One placed hit: position (16th steps, fractional ok), mono sound, gain, pan.
struct Hit<'a> {
    at: f32,
    x: &'a [f32],
    g: f32,
    pan: f32,
}

fn mix(n: usize, hits: &[Hit]) -> Chans {
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    for h in hits {
        let at = s16(h.at);
        if at >= n {
            continue;
        }
        let p = h.pan.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
        add(&mut l, h.x, h.g * p.cos() * std::f32::consts::SQRT_2, at);
        add(&mut r, h.x, h.g * p.sin() * std::f32::consts::SQRT_2, at);
    }
    let mut ch = vec![l, r];
    cut(&mut ch, n);
    ch
}

fn toms() -> [Vec<f32>; 4] {
    [
        membrane(&Drum { f: 210.0, decay: 380.0, seed: 6001, ..DRUM }),
        membrane(&Drum { f: 160.0, decay: 450.0, seed: 6002, ..DRUM }),
        membrane(&Drum { f: 118.0, decay: 550.0, seed: 6003, ..DRUM }),
        membrane(&Drum { f: 86.0, decay: 700.0, seed: 6004, ..DRUM }),
    ]
}

fn kit_snare(seed: u32) -> Vec<f32> {
    snare(&Snare { f: 205.0, noise: 0.85, noise_ms: 180.0, crack: 0.55, drive: 0.3, seed, ..SNARE })
}

fn room(ch: &Chans, n: usize) -> Chans {
    let mut out = reverb(ch, &rev(0.0, 0.5, 0.8).pre(6.0).low(200.0).damp(7000.0), 0.18, 0.0);
    cut(&mut out, n);
    out
}

fn tom_fill(bars: u32) -> Chans {
    let n = bars as usize * BAR;
    let t = toms();
    let s = kit_snare(6011);
    let k = kick(&Kick { f: 52.0, decay: 320.0, seed: 6012, ..KICK });
    let mut hits: Vec<Hit> = Vec::new();
    let last = (bars as f32 - 1.0) * 16.0;
    if bars == 2 {
        // bar 1: a half-time groove with ghost notes building
        for st in 0..16 {
            match st {
                0 | 10 => hits.push(Hit { at: st as f32, x: &k, g: 0.8, pan: 0.5 }),
                4 | 12 => hits.push(Hit { at: st as f32, x: &s, g: 0.75, pan: 0.5 }),
                7 | 9 | 15 => hits.push(Hit { at: st as f32, x: &s, g: 0.2, pan: 0.5 }),
                _ => {}
            }
        }
    }
    // the fill bar: snare 8ths, then a 16th tom run high → floor
    hits.push(Hit { at: last, x: &k, g: 0.8, pan: 0.5 });
    hits.push(Hit { at: last + 2.0, x: &s, g: 0.5, pan: 0.5 });
    hits.push(Hit { at: last + 4.0, x: &s, g: 0.8, pan: 0.5 });
    hits.push(Hit { at: last + 6.0, x: &s, g: 0.55, pan: 0.5 });
    let pans = [0.72, 0.58, 0.42, 0.28];
    for i in 0..8 {
        let tom = i / 2;
        hits.push(Hit { at: last + 8.0 + i as f32, x: &t[tom], g: 0.65 + 0.04 * i as f32, pan: pans[tom] });
    }
    hits.push(Hit { at: last + 15.0, x: &k, g: 0.6, pan: 0.5 });
    room(&mix(n, &hits), n)
}

fn trap_snare_roll() -> Chans {
    let n = BAR;
    let mut hits_x: Vec<(f32, Vec<f32>, f32)> = Vec::new();
    // 16ths for two beats, 16th triplets, then 32nds rising in pitch and level
    let mut pos = 0.0f32;
    let mut k = 0u32;
    while pos < 16.0 - 1e-3 {
        let u = pos / 16.0;
        let stp = if pos < 8.0 { 1.0 } else if pos < 12.0 { 2.0 / 3.0 } else { 0.5 };
        let x = snare(&Snare { f: 230.0 * (5.0 * u / 12.0).exp2(), body: 0.5, body_ms: 90.0, noise: 0.9, n_hp: 1800.0, noise_ms: 120.0, crack: 0.65, drive: 0.4, seed: 6101 + k, ..SNARE });
        hits_x.push((pos, x, 0.35 + 0.65 * u.powf(1.3)));
        pos += stp;
        k += 1;
    }
    let hits: Vec<Hit> = hits_x.iter().map(|(at, x, g)| Hit { at: *at, x, g: *g, pan: 0.5 }).collect();
    let ch = mix(n, &hits);
    let mut x = mono_sum(&ch);
    x = reverb_mono(&x, &rev(0.0, 0.35, 0.5).low(300.0), 0.1, 0.0);
    x.truncate(n);
    vec![x]
}

fn trap_hat_roll() -> Chans {
    let n = BAR;
    let h = hat(&Hat { decay: 45.0, seed: 6201, ..HAT });
    let hi = hat(&Hat { pitch: 1.12, decay: 40.0, seed: 6202, ..HAT });
    let mut hits: Vec<Hit> = Vec::new();
    // 8ths, a 16th triplet roll, 16ths, a 32nd roll rising, 1/64 stutter at the end
    let plan: [(f32, f32, f32); 6] = [(0.0, 4.0, 2.0), (4.0, 6.0, 2.0 / 3.0), (6.0, 10.0, 1.0), (10.0, 12.0, 0.5), (12.0, 14.0, 1.0), (14.0, 16.0, 0.25)];
    for (a, b, stp) in plan {
        let mut pos = a;
        while pos < b - 1e-3 {
            let fast = stp < 1.0;
            let g = if fast { 0.45 + 0.4 * (pos - a) / (b - a) } else if (pos as i32) % 4 == 0 { 0.8 } else { 0.6 };
            hits.push(Hit { at: pos, x: if fast { &hi } else { &h }, g, pan: 0.5 });
            pos += stp;
        }
    }
    let ch = mix(n, &hits);
    vec![mono_sum(&ch)]
}

fn clap_build() -> Chans {
    let n = 2 * BAR;
    let c = clap_ch(&Clap { seed: 6301, ..CLAP }, 6301);
    let mut hits: Vec<Hit> = Vec::new();
    for (a, b, stp) in [(0.0f32, 16.0f32, 4.0f32), (16.0, 24.0, 2.0), (24.0, 28.0, 1.0), (28.0, 32.0, 0.5)] {
        let mut pos = a;
        while pos < b - 1e-3 {
            hits.push(Hit { at: pos, x: &c, g: 0.4 + 0.6 * (pos / 32.0).powf(1.2), pan: 0.5 });
            pos += stp;
        }
    }
    let ch = mix(n, &hits);
    let mut x = mono_sum(&ch);
    sweep(&mut x, LP, 0.8, |u| expi(2500.0, 15_000.0, u));
    let mut x = reverb_mono(&x, &rev(2.0, 0.5, 1.2).pre(8.0).low(350.0), 0.2, 0.0);
    x.truncate(n);
    vec![x]
}

fn break_fill() -> Chans {
    let n = BAR;
    let s = snare(&Snare { f: 240.0, noise: 0.8, noise_ms: 150.0, crack: 0.8, crack_hz: 4200.0, drive: 0.5, seed: 6401, ..SNARE });
    let ghost = snare(&Snare { f: 240.0, noise: 0.6, noise_ms: 90.0, crack: 0.3, seed: 6402, ..SNARE });
    let k = kick(&Kick { f: 55.0, decay: 260.0, click: 0.4, seed: 6403, ..KICK });
    let pat: [(f32, u8, f32); 14] = [
        (0.0, 0, 0.9),
        (2.0, 2, 0.25),
        (3.0, 1, 0.8),
        (5.0, 2, 0.3),
        (6.0, 0, 0.7),
        (7.0, 2, 0.3),
        (8.0, 1, 0.85),
        (10.0, 0, 0.75),
        (11.0, 1, 0.7),
        (12.0, 1, 0.65),
        (13.0, 1, 0.75),
        (14.0, 1, 0.85),
        (14.5, 2, 0.5),
        (15.0, 1, 0.95),
    ];
    let hits: Vec<Hit> = pat.iter().map(|&(at, w, g)| Hit { at, x: if w == 0 { &k } else if w == 1 { &s } else { &ghost }, g, pan: 0.5 }).collect();
    let ch = mix(n, &hits);
    let mut x = reverb_mono(&mono_sum(&ch), &rev(0.0, 0.3, 0.45).low(250.0), 0.12, 0.0);
    x.truncate(n);
    vec![x]
}

fn pop_fill() -> Chans {
    let n = BAR;
    let t = toms();
    let s = kit_snare(6501);
    let k = kick(&Kick { f: 54.0, decay: 300.0, seed: 6502, ..KICK });
    let h = hat(&Hat { seed: 6503, ..HAT });
    let mut hits: Vec<Hit> = Vec::new();
    for st in [0.0f32, 6.0, 8.0] {
        hits.push(Hit { at: st, x: &k, g: 0.85, pan: 0.5 });
    }
    for st in [0.0f32, 2.0, 4.0, 6.0, 8.0, 10.0] {
        hits.push(Hit { at: st, x: &h, g: 0.25, pan: 0.6 });
    }
    hits.push(Hit { at: 4.0, x: &s, g: 0.8, pan: 0.5 });
    // beat 3: snare 16ths, beat 4: toms high → low
    for (i, st) in [8.0f32, 9.0, 10.0, 11.0].iter().enumerate() {
        hits.push(Hit { at: *st, x: &s, g: 0.5 + 0.1 * i as f32, pan: 0.5 });
    }
    hits.push(Hit { at: 12.0, x: &t[0], g: 0.75, pan: 0.7 });
    hits.push(Hit { at: 13.0, x: &t[1], g: 0.75, pan: 0.55 });
    hits.push(Hit { at: 14.0, x: &t[2], g: 0.8, pan: 0.4 });
    hits.push(Hit { at: 15.0, x: &t[3], g: 0.85, pan: 0.3 });
    hits.push(Hit { at: 15.0, x: &k, g: 0.6, pan: 0.5 });
    room(&mix(n, &hits), n)
}

fn hand_drum_fill() -> Chans {
    let n = BAR;
    let hi = membrane(&Drum { f: 330.0, bend: 0.15, bend_ms: 20.0, decay: 260.0, slap: 0.6, slap_hz: 3500.0, seed: 6601, ..DRUM });
    let mid = membrane(&Drum { f: 240.0, bend: 0.15, bend_ms: 25.0, decay: 320.0, slap: 0.45, seed: 6602, ..DRUM });
    let lo = membrane(&Drum { f: 150.0, bend: 0.2, bend_ms: 30.0, decay: 420.0, slap: 0.3, seed: 6603, ..DRUM });
    let mut nz = Noise::new(6604);
    let mut shk: Vec<f32> = (0..ns(0.06)).map(|i| nz.white() * (1.0 - (i as f32 / ns(0.06) as f32)).powi(2) * (i as f32 / 120.0).min(1.0)).collect();
    hp(&mut shk, 5000.0);
    let mut hits: Vec<Hit> = Vec::new();
    // 3-3-2 then a run of 16ths over the last beat
    for st in [0.0f32, 3.0, 6.0, 8.0, 11.0, 14.0] {
        hits.push(Hit { at: st, x: &lo, g: 0.8, pan: 0.4 });
    }
    for st in [2.0f32, 5.0, 10.0] {
        hits.push(Hit { at: st, x: &mid, g: 0.6, pan: 0.6 });
    }
    for st in [12.0f32, 12.5, 13.0, 13.5, 14.5, 15.0, 15.5] {
        hits.push(Hit { at: st, x: &hi, g: 0.55 + 0.03 * st, pan: 0.65 });
    }
    for st in 0..16 {
        hits.push(Hit { at: st as f32, x: &shk, g: if st % 2 == 0 { 0.25 } else { 0.15 }, pan: 0.35 });
    }
    room(&mix(n, &hits), n)
}

fn triplet_build() -> Chans {
    let n = 2 * BAR;
    let mut owned: Vec<(f32, Vec<f32>, f32)> = Vec::new();
    let mut pos = 0.0f32;
    let mut k = 0u32;
    while pos < 32.0 - 1e-3 {
        let u = pos / 32.0;
        let stp = if pos < 12.0 { 8.0 / 3.0 } else if pos < 24.0 { 4.0 / 3.0 } else if pos < 28.0 { 2.0 / 3.0 } else { 1.0 / 3.0 };
        let x = snare(&Snare { f: 200.0 * (7.0 * u / 12.0).exp2(), noise: 0.9, noise_ms: 160.0, crack: 0.6, drive: 0.35, seed: 6701 + k, ..SNARE });
        owned.push((pos, x, 0.35 + 0.65 * u.powf(1.2)));
        pos += stp;
        k += 1;
    }
    let hits: Vec<Hit> = owned.iter().map(|(at, x, g)| Hit { at: *at, x, g: *g, pan: 0.5 }).collect();
    let mut x = mono_sum(&mix(n, &hits));
    sweep(&mut x, LP, 0.8, |u| expi(3000.0, 16_000.0, u));
    let mut x = reverb_mono(&x, &rev(2.0, 0.45, 1.0).pre(8.0).low(350.0), 0.15, 0.0);
    x.truncate(n);
    vec![x]
}

pub(crate) fn specs() -> Vec<Spec> {
    let f = |s: Spec| s.fades(0.15, 3.0);
    vec![
        f(spec("drums/fill/tom-fill-1bar.wav", "Tom Fill 1 Bar", "fill", &["organic", "punchy", "wide"], &["pop", "rnb", "afrobeats", "synthwave", "house"], || tom_fill(1)).bars(1)),
        f(spec("drums/fill/tom-fill-2bar.wav", "Tom Fill 2 Bars", "fill", &["organic", "punchy", "wide", "long"], &["pop", "rnb", "afrobeats", "synthwave"], || tom_fill(2)).bars(2)),
        f(spec("drums/fill/trap-snare-roll-1bar.wav", "Trap Snare Roll 1 Bar", "fill", &["punchy", "hard", "bright", "mono"], &["trap", "drill", "phonk"], trap_snare_roll).bars(1)),
        f(spec("drums/fill/trap-hat-roll-1bar.wav", "Trap Hat Roll 1 Bar", "fill", &["bright", "short", "mono"], &["trap", "drill", "phonk", "rnb"], trap_hat_roll).bars(1)),
        f(spec("drums/fill/clap-build-2bar.wav", "Clap Build 2 Bars", "fill", &["bright", "big", "mono"], &["house", "tech-house", "edm", "deep-house", "pop"], clap_build).bars(2)),
        f(spec("drums/fill/break-fill-1bar.wav", "Breakbeat Fill 1 Bar", "fill", &["punchy", "gritty", "mono"], &["dnb", "boom-bap", "lofi"], break_fill).bars(1)),
        f(spec("drums/fill/pop-kit-fill-1bar.wav", "Pop Kit Fill 1 Bar", "fill", &["organic", "punchy", "warm"], &["pop", "rnb", "synthwave", "afrobeats"], pop_fill).bars(1)),
        f(spec("drums/fill/hand-drum-fill-1bar.wav", "Hand Drum Fill 1 Bar", "fill", &["organic", "warm", "wide"], &["afrobeats", "reggaeton", "house", "deep-house"], hand_drum_fill).bars(1)),
        f(spec("drums/fill/triplet-snare-build-2bar.wav", "Triplet Snare Build 2 Bars", "fill", &["bright", "big", "punchy", "mono"], &["edm", "future-bass", "dubstep", "pop", "trap"], triplet_build).bars(2)),
    ]
}
