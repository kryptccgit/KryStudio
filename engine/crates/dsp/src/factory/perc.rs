use super::drums::{membrane, Drum, DRUM, MEMBRANE};
use super::library::{spec, Spec};
use super::synth::*;
use crate::instruments::drums::{render as drum_render, DrumKind, DrumParams};

fn modal_hit(m: &[(f32, f32, f32)], click: f32, click_hz: f32, len_ms: f32, seed: u32) -> Vec<f32> {
    let n = ns(len_ms / 1000.0);
    let mm: Vec<(f32, f32, f32, f32)> = m.iter().map(|&(f, a, t)| (f, a, t / 1000.0, 0.0)).collect();
    let mut x = modes(&mm, n);
    let mut nz = Noise::new(seed);
    let mut b = svf(BP, click_hz, 1.2);
    for (i, v) in x.iter_mut().enumerate() {
        let t = i as f32 / SR * 1000.0;
        *v += tick(&mut b, nz.white()) * (-t / 0.6).exp() * click * 2.0;
    }
    x
}

#[derive(Clone, Copy)]
struct Shaker {
    att: f32,
    decay: f32,
    bp: f32,
    q: f32,
    hp: f32,
    lp: f32,
    grain: f32,
    seed: u32,
}

fn shaker(p: &Shaker) -> Vec<f32> {
    let n = ns((p.att + p.decay * 1.1) / 1000.0 + 0.005);
    let mut nz = Noise::new(p.seed);
    let mut h = svf(HP, p.hp, 0.7);
    let mut b = svf(BP, p.bp, p.q);
    let mut l = svf(LP, p.lp, 0.7);
    let rate = 1.0 / (0.0007 * SR);
    let gdec = (-1.0 / (0.0006 * SR)).exp();
    let mut g = 0.0f32;
    let mut out = vec![0.0f32; n];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR * 1000.0;
        if nz.unit() < rate {
            g += 0.6 + 0.4 * nz.unit();
        }
        g = (g * gdec).min(1.8);
        let env = if t < p.att { (t / p.att).powi(2) } else { dec60(t - p.att, p.decay) };
        let x = tick(&mut l, tick(&mut b, tick(&mut h, nz.white())));
        *o = x * env * ((1.0 - p.grain) + p.grain * g);
    }
    out
}

fn snap(bp_hz: f32, tail_ms: f32, seed: u32) -> Vec<f32> {
    let n = ns(tail_ms / 1000.0 + 0.01);
    let mut nz = Noise::new(seed);
    let mut b = svf(BP, bp_hz, 1.6);
    let mut c = svf(HP, 5000.0, 0.7);
    let mut f = svf(BP, 900.0, 1.0);
    let mut out = vec![0.0f32; n];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR * 1000.0;
        let w = nz.white();
        let att = (t / 0.3).min(1.0);
        let crack = tick(&mut b, w) * att * dec60(t, tail_ms) * 2.0;
        let click = tick(&mut c, w) * (-t / 0.5).exp() * 0.8;
        let flesh = tick(&mut f, w) * (-t / 9.0).exp() * 0.6;
        *o = crack + click + flesh;
    }
    out
}

fn tambourine(decay_ms: f32, seed: u32) -> Vec<f32> {
    let n = ns(decay_ms / 1000.0 + 0.05);
    let mut nz = Noise::new(seed);
    let base: Vec<(f32, f32, f32)> = (0..10).map(|_| (4500.0 * (11_000.0f32 / 4500.0).powf(nz.unit()), 0.5 + 0.5 * nz.unit(), decay_ms / 1000.0 * (0.4 + 0.6 * nz.unit()))).collect();
    let mut out = vec![0.0f32; n];
    for (k, (at_ms, g)) in [(0.0, 1.0), (5.0, 0.55), (11.0, 0.35), (19.0, 0.2)].into_iter().enumerate() {
        let at = ns((at_ms + if k > 0 { nz.white() * 1.2 } else { 0.0 }) / 1000.0);
        let m: Vec<(f32, f32, f32, f32)> = base.iter().map(|&(f, a, t)| (f * (1.0 + 0.004 * nz.white()), a, t, nz.unit())).collect();
        let r = modes(&m, n.saturating_sub(at));
        let mut r = r;
        let ramp = ns(0.0003);
        for (i, v) in r.iter_mut().take(ramp).enumerate() {
            *v *= i as f32 / ramp as f32;
        }
        add(&mut out, &r, g, at);
    }
    out.truncate(n);
    normalize(&mut out, 1.0);
    let mut h = svf(HP, 6000.0, 0.7);
    for (i, v) in out.iter_mut().enumerate() {
        let t = i as f32 / SR * 1000.0;
        *v += tick(&mut h, nz.white()) * (-t / 18.0).exp() * 0.6 * (t / 0.3).min(1.0);
    }
    hp(&mut out, 2000.0);
    out
}

fn guiro(seed: u32) -> Vec<f32> {
    let mut nz = Noise::new(seed);
    let n = ns(0.2);
    let mut out = vec![0.0f32; n];
    let mut b = svf(BP, 2600.0, 1.4);
    let ticks = 18;
    for k in 0..ticks {
        let at = ns(0.007 * k as f32 * (1.0 - 0.012 * k as f32));
        let a = (k as f32 / 4.0).min(1.0) * (1.0 - k as f32 / ticks as f32 * 0.6) * (0.8 + 0.2 * nz.unit());
        for j in 0..ns(0.0012) {
            if at + j < n {
                out[at + j] += nz.white() * a * (-(j as f32) / (0.0004 * SR)).exp();
            }
        }
    }
    for v in out.iter_mut() {
        *v = tick(&mut b, *v);
    }
    hp(&mut out, 900.0);
    out
}

fn water_drop() -> Vec<f32> {
    let n = ns(0.12);
    let mut ph = 0.0f64;
    let mut out = vec![0.0f32; n];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let f = 600.0 * (4.0f32).powf((t / 0.025).min(1.0));
        let (p, _) = step(&mut ph, f);
        *o = (p * TAU64).sin() as f32 * (-t / 0.03).exp() * (t / 0.0008).min(1.0);
    }
    out
}

fn cowbell_tuned() -> Vec<f32> {
    let (f1, f2) = (hz(72.0), hz(79.0));
    let n = ns(0.95);
    let (mut p1, mut p2) = (0.0f64, 0.25f64);
    let mut b = svf(BP, 1700.0, 0.8);
    let mut out = vec![0.0f32; n];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR * 1000.0;
        let (a, da) = step(&mut p1, f1);
        let (c, dc) = step(&mut p2, f2);
        let x = tick(&mut b, square(a, da) * 0.55 + square(c, dc) * 0.45);
        let env = (t / 0.3).min(1.0) * (0.5 * (-t / 14.0).exp() + 0.5 * dec60(t, 900.0));
        *o = x * env;
    }
    normalize(&mut out, 1.0);
    drive(&mut out, 5.0, 0.12);
    lp(&mut out, 7000.0);
    hp(&mut out, 200.0);
    out
}

fn log_drum(seed: u32) -> Vec<f32> {
    let f0 = hz(48.0);
    let len_ms = 700.0;
    let n = ns(len_ms / 1000.0);
    let mut nz = Noise::new(seed);
    let mut kb = svf(BP, 1200.0, 1.2);
    let mut ph = 0.0f64;
    let mut out = vec![0.0f32; n];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR * 1000.0;
        let f = f0 * (1.0 + 0.35 * (-t / 12.0).exp());
        let (q, _) = step(&mut ph, f);
        let a = (q * TAU64) as f32;
        let x = a.sin() + 0.35 * (2.0 * a).sin() * (-t / 80.0).exp() + 0.12 * (3.0 * a).sin() * (-t / 50.0).exp();
        let amp = if t < 20.0 { 1.0 } else { dec60(t - 20.0, 560.0) };
        let k = tick(&mut kb, nz.white()) * (-t / 4.0).exp() * 0.5;
        *o = x * amp + k;
    }
    sweep(&mut out, LP, 2.5, |u| 380.0 + 2600.0 * (-(u * len_ms) / 60.0).exp());
    normalize(&mut out, 1.0);
    drive(&mut out, 2.5, 0.0);
    out
}

pub(crate) fn specs() -> Vec<Spec> {
    let small = rev(0.0, 0.3, 0.45).low(300.0);
    vec![
        spec("drums/rim/tight.wav", "Tight Rim", "rim", &["short", "bright", "clean"], &["house", "tech-house", "afrobeats", "reggaeton"], || {
            let mut x = modal_hit(&[(1720.0, 1.0, 35.0), (470.0, 0.5, 60.0), (2650.0, 0.35, 20.0)], 0.6, 4000.0, 120.0, 801);
            normalize(&mut x, 1.0);
            drive(&mut x, 2.0, 0.0);
            hp(&mut x, 300.0);
            vec![x]
        }),
        spec("drums/rim/woody.wav", "Woody Rim", "rim", &["warm", "organic", "short"], &["lofi", "boom-bap", "rnb", "afrobeats"], || {
            let mut x = modal_hit(&[(820.0, 1.0, 60.0), (1260.0, 0.6, 45.0), (2300.0, 0.3, 30.0)], 0.4, 2500.0, 160.0, 802);
            hp(&mut x, 200.0);
            vec![x]
        }),
        spec("drums/rim/trap-click.wav", "Trap Click Rim", "rim", &["bright", "short", "hard"], &["trap", "drill", "phonk"], move || {
            let mut x = modal_hit(&[(2100.0, 1.0, 25.0), (5200.0, 0.4, 12.0), (640.0, 0.3, 40.0)], 0.8, 6000.0, 90.0, 803);
            hp(&mut x, 400.0);
            reverb(&vec![x], &small, 0.1, 0.3)
        }),
        spec("drums/shaker/short.wav", "Short Shaker", "shaker", &["short", "bright", "organic"], &["afrobeats", "reggaeton", "house", "pop"], || {
            vec![shaker(&Shaker { att: 6.0, decay: 60.0, bp: 7000.0, q: 0.9, hp: 4000.0, lp: 14_000.0, grain: 0.5, seed: 811 })]
        }),
        spec("drums/shaker/long.wav", "Long Shaker", "shaker", &["long", "organic", "airy"], &["afrobeats", "deep-house", "house", "rnb"], || {
            vec![shaker(&Shaker { att: 25.0, decay: 140.0, bp: 6500.0, q: 0.8, hp: 3500.0, lp: 13_000.0, grain: 0.6, seed: 812 })]
        }),
        spec("drums/shaker/soft.wav", "Soft Shaker", "shaker", &["soft", "warm", "organic"], &["lofi", "rnb", "afrobeats"], || {
            vec![shaker(&Shaker { att: 15.0, decay: 90.0, bp: 5500.0, q: 0.7, hp: 3000.0, lp: 9000.0, grain: 0.4, seed: 813 })]
        }),
        spec("drums/snap/finger.wav", "Finger Snap", "snap", &["short", "organic", "bright"], &["trap", "rnb", "pop", "drill"], move || {
            reverb(&vec![snap(2300.0, 60.0, 821)], &small, 0.12, 0.3)
        }),
        spec("drums/snap/tight-room.wav", "Tight Room Snap", "snap", &["short", "bright", "wide"], &["pop", "trap", "future-bass"], || {
            reverb(&vec![snap(2800.0, 45.0, 822)], &rev(2.0, 0.4, 0.8).pre(6.0).low(400.0), 0.22, 0.6)
        }),
        spec("drums/perc/tambourine.wav", "Tambourine", "perc", &["bright", "organic", "metallic"], &["pop", "rnb", "house", "afrobeats"], || vec![tambourine(260.0, 831)]),
        spec("drums/perc/conga-high.wav", "High Conga", "perc", &["organic", "warm"], &["afrobeats", "reggaeton", "house"], || {
            vec![reverb_mono(&membrane(&Drum { f: 330.0, bend: 0.08, bend_ms: 20.0, decay: 300.0, slap: 0.5, slap_hz: 2500.0, drive: 0.1, lp: 9000.0, seed: 832, ..DRUM }), &rev(0.0, 0.3, 0.5).low(250.0), 0.08, 0.3)]
        }),
        spec("drums/perc/conga-low.wav", "Low Conga", "perc", &["organic", "warm", "deep"], &["afrobeats", "reggaeton", "house"], || {
            vec![reverb_mono(&membrane(&Drum { f: 225.0, bend: 0.08, bend_ms: 20.0, decay: 380.0, slap: 0.4, slap_hz: 2200.0, drive: 0.1, lp: 8000.0, seed: 833, ..DRUM }), &rev(0.0, 0.3, 0.5).low(200.0), 0.08, 0.3)]
        }),
        spec("drums/perc/bongo-high.wav", "High Bongo", "perc", &["organic", "bright", "short"], &["afrobeats", "reggaeton", "house"], || {
            vec![membrane(&Drum { f: 520.0, bend: 0.06, bend_ms: 15.0, decay: 170.0, slap: 0.6, slap_hz: 3500.0, drive: 0.1, lp: 11_000.0, seed: 834, ..DRUM })]
        }),
        spec("drums/perc/bongo-low.wav", "Low Bongo", "perc", &["organic", "short"], &["afrobeats", "reggaeton", "house"], || {
            vec![membrane(&Drum { f: 390.0, bend: 0.06, bend_ms: 15.0, decay: 200.0, slap: 0.5, slap_hz: 3000.0, drive: 0.1, lp: 10_000.0, m: MEMBRANE, seed: 835, ..DRUM })]
        }),
        spec("drums/perc/cowbell-classic.wav", "Classic Cowbell", "perc", &["metallic", "retro", "bright"], &["house", "techno", "reggaeton"], || {
            vec![drum_render(DrumKind::Cowbell, DrumParams { tune: 0.0, decay_ms: 320.0, tone: 0.5, snap: 0.5, drive: 0.2 }, SR, 836)]
        }),
        spec("drums/perc/cowbell-phonk.wav", "Phonk Cowbell (C)", "perc", &["distorted", "metallic", "dirty", "aggressive"], &["phonk", "drill", "trap"], || vec![cowbell_tuned()]).root(72),
        spec("drums/perc/clave.wav", "Clave", "perc", &["bright", "short", "organic"], &["reggaeton", "afrobeats", "house"], || {
            vec![modal_hit(&[(2500.0, 1.0, 110.0), (5000.0, 0.08, 50.0)], 0.3, 5000.0, 160.0, 838)]
        }),
        spec("drums/perc/woodblock.wav", "Woodblock", "perc", &["organic", "short", "warm"], &["lofi", "afrobeats", "house"], || {
            vec![modal_hit(&[(1050.0, 1.0, 70.0), (2730.0, 0.35, 40.0), (4100.0, 0.12, 25.0)], 0.4, 3000.0, 140.0, 839)]
        }),
        spec("drums/perc/log-drum.wav", "Log Drum (C)", "perc", &["deep", "warm", "punchy", "organic"], &["afrobeats", "deep-house"], || vec![log_drum(840)]).root(48),
        spec("drums/perc/agogo-high.wav", "High Agogo", "perc", &["metallic", "bright", "organic"], &["afrobeats", "reggaeton", "house"], || {
            vec![modal_hit(&[(920.0, 1.0, 500.0), (2475.0, 0.4, 250.0), (3790.0, 0.2, 150.0), (5150.0, 0.1, 90.0)], 0.3, 4000.0, 600.0, 842)]
        }),
        spec("drums/perc/agogo-low.wav", "Low Agogo", "perc", &["metallic", "warm", "organic"], &["afrobeats", "reggaeton", "house"], || {
            vec![modal_hit(&[(650.0, 1.0, 550.0), (1750.0, 0.4, 280.0), (2680.0, 0.2, 160.0), (3640.0, 0.1, 100.0)], 0.3, 3500.0, 650.0, 843)]
        }),
        spec("drums/perc/timbale.wav", "Timbale", "perc", &["bright", "metallic", "organic"], &["reggaeton", "afrobeats", "house"], || {
            let mut x = membrane(&Drum { f: 420.0, bend: 0.05, bend_ms: 15.0, decay: 450.0, slap: 0.7, slap_hz: 3500.0, drive: 0.1, lp: 12_000.0, seed: 844, ..DRUM });
            let ring = modes(&[(1900.0, 0.25, 0.3, 0.0), (3100.0, 0.15, 0.2, 0.0)], ns(0.3));
            add(&mut x, &ring, 1.0, 0);
            vec![x]
        }),
        spec("drums/perc/guiro.wav", "Guiro Scrape", "perc", &["organic", "short"], &["reggaeton", "afrobeats", "lofi"], || vec![guiro(845)]),
        spec("drums/perc/water-drop.wav", "Water Drop", "perc", &["bright", "short", "clean", "dreamy"], &["future-bass", "lofi", "pop", "trap"], || vec![water_drop()]),
        spec("drums/rim/sidestick.wav", "Sidestick", "rim", &["warm", "organic", "short"], &["rnb", "pop", "lofi", "boom-bap"], || {
            let x = modal_hit(&[(1400.0, 1.0, 45.0), (380.0, 0.6, 70.0), (2400.0, 0.3, 25.0)], 0.5, 3000.0, 130.0, 846);
            vec![reverb_mono(&x, &rev(0.0, 0.3, 0.45).low(300.0), 0.1, 0.25)]
        }),
        spec("drums/snap/dry.wav", "Dry Snap", "snap", &["short", "clean", "small"], &["trap", "pop", "rnb"], || vec![snap(2500.0, 50.0, 847)]),
        spec("drums/shaker/egg.wav", "Egg Shaker", "shaker", &["short", "small", "bright"], &["pop", "afrobeats", "house"], || {
            vec![shaker(&Shaker { att: 4.0, decay: 45.0, bp: 8000.0, q: 1.0, hp: 5000.0, lp: 15_000.0, grain: 0.35, seed: 848 })]
        }),
        spec("drums/perc/fm-blip.wav", "FM Blip", "perc", &["short", "bright", "metallic"], &["tech-house", "techno", "house"], || {
            vec![drum_render(DrumKind::Perc, DrumParams { tune: 3.0, decay_ms: 180.0, tone: 0.8, snap: 0.6, drive: 0.15 }, SR, 841)]
        }),
    ]
}
