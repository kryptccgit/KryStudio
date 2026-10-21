use super::drums::{clap, cymbal, kick, membrane, snare, Clap, Cym, Drum, Kick, Snare, CLAP, CRASH, DRUM, KICK, SNARE};
use super::kit::*;
use super::library::{spec, Spec};
use super::synth::*;

fn boom(f0: f32, f1: f32, tau: f32, t60: f32) -> Vec<f32> {
    tone(ns(t60 + 0.05), 0.0, |t| f1 + (f0 - f1) * (-t / tau).exp(), |t| dec60(t, t60) * smooth01(t / 0.0015))
}

fn burst(len: f32, tau: f32, lp_hz: f32, seed: u32) -> Vec<f32> {
    let mut nz = Noise::new(seed);
    let mut x: Vec<f32> = (0..ns(len)).map(|i| nz.white() * (-(i as f32) / (tau * SR)).exp()).collect();
    lp(&mut x, lp_hz);
    x
}

fn cinematic_hit(seed: u32) -> Chans {
    let mut body = boom(75.0, 34.0, 0.25, 3.4);
    let k = kick(&Kick { f: 48.0, decay: 700.0, drive: 0.5, click: 0.5, seed, ..KICK });
    add(&mut body, &k, 0.8, 0);
    add(&mut body, &burst(0.5, 0.06, 4000.0, seed + 1), 0.5, 0);
    let mut nz = Noise::new(seed + 2);
    let m: Vec<(f32, f32, f32, f32)> = (0..18).map(|_| (expi(150.0, 3500.0, nz.unit()), 0.3 + 0.7 * nz.unit(), 0.4 + 1.0 * nz.unit(), 0.0)).collect();
    let mut metal = modes(&m, ns(1.6));
    normalize(&mut metal, 0.35);
    add(&mut body, &metal, 1.0, 0);
    drive(&mut body, 1.6, 0.0);
    let mut out = reverb(&vec![body], &rev(1.0, 1.0, 4.5).pre(12.0).low(80.0).damp(5000.0), 0.4, 2.5);
    sweep_ch(&mut out, LP, 0.7, |u| expi(12_000.0, 3000.0, u));
    out
}

fn thud(seed: u32) -> Chans {
    let mut x = boom(95.0, 42.0, 0.04, 0.9);
    let k = kick(&Kick { f: 46.0, decay: 420.0, click: 0.15, tick: 0.0, drive: 0.25, seed, ..KICK });
    add(&mut x, &k, 0.8, 0);
    let mut b = burst(0.15, 0.02, 600.0, seed + 1);
    lp(&mut b, 600.0);
    add(&mut x, &b, 0.9, 0);
    vec![reverb_mono(&x, &rev(0.0, 0.35, 0.5).low(120.0).damp(3000.0), 0.12, 0.3)]
}

fn clap_impact(seed: u32) -> Chans {
    let mut c = clap(&Clap { bursts: 5, spacing: 11.0, tail_ms: 380.0, bp: 1100.0, drive: 0.35, seed, ..CLAP }, 0.5);
    let s = snare(&Snare { f: 185.0, noise: 1.0, noise_ms: 280.0, crack: 0.8, drive: 0.4, seed: seed + 1, ..SNARE });
    let k = kick(&Kick { f: 50.0, decay: 450.0, drive: 0.5, seed: seed + 2, ..KICK });
    add_ch(&mut c, &vec![s], 0.7, 0);
    add_ch(&mut c, &vec![k], 0.8, 0);
    even(&mut c);
    reverb(&c, &rev(2.0, 0.9, 2.8).pre(15.0).low(250.0).damp(9000.0), 0.45, 2.0)
}

fn braam(seed: u32) -> Chans {
    let n = ns(3.5);
    let len = 3.5;
    let mut ch = supersaw(&[24.0, 36.0, 43.0], n, 4, 0.7, seed, |_| 0.12, |u| -0.25 * u);
    for c in ch.iter_mut() {
        normalize(c, 1.0);
        drive(c, 3.0, 0.1);
    }
    sweep_ch(&mut ch, LP, 1.5, |u| {
        let t = u * len;
        if t < 0.03 {
            expi(250.0, 3200.0, t / 0.03)
        } else {
            expi(3200.0, 350.0, ((t - 0.03) / 2.6).min(1.0))
        }
    });
    shape(&mut ch, |u| dec60(u * len, 3.6) * smooth01(u * len / 0.004));
    let k = kick(&Kick { f: 42.0, decay: 600.0, drive: 0.5, seed: seed + 1, ..KICK });
    add_ch(&mut ch, &vec![k], 0.9, 0);
    let mut out = reverb(&ch, &rev(1.0, 0.95, 3.5).pre(20.0).low(120.0).damp(4000.0), 0.25, 1.0);
    for c in out.iter_mut() {
        hp(c, 25.0);
    }
    out
}

fn dirty_boom(seed: u32) -> Chans {
    let mut x = boom(130.0, 38.0, 0.18, 2.4);
    let k = kick(&Kick { f: 45.0, decay: 500.0, drive: 0.7, click: 0.6, seed, ..KICK });
    add(&mut x, &k, 0.9, 0);
    add(&mut x, &burst(0.3, 0.035, 6000.0, seed + 1), 0.4, 0);
    normalize(&mut x, 1.0);
    drive(&mut x, 6.0, 0.15);
    lp(&mut x, 3500.0);
    vec![reverb_mono(&x, &rev(0.0, 0.6, 1.2).low(150.0).damp(4000.0), 0.15, 0.8)]
}

fn tom_impact(seed: u32) -> Chans {
    let t = membrane(&Drum { f: 68.0, bend: 0.6, bend_ms: 80.0, decay: 1600.0, slap: 0.6, slap_hz: 2000.0, drive: 0.4, seed, ..DRUM });
    let t2 = membrane(&Drum { f: 102.0, bend: 0.5, bend_ms: 60.0, decay: 1100.0, slap: 0.4, drive: 0.3, seed: seed + 1, ..DRUM });
    let mut x = t;
    add(&mut x, &t2, 0.5, 0);
    let mut out = reverb(&vec![x], &rev(1.0, 0.9, 2.6).pre(10.0).low(100.0).damp(5000.0), 0.35, 1.5);
    for c in out.iter_mut() {
        hp(c, 30.0);
    }
    out
}

fn crash_impact(seed: u32) -> Chans {
    let mut c = cymbal(&Cym { t60: 2.4, noise_t60: 1.8, len: 2.6, swell: 1.4, width: 0.7, seed, ..CRASH });
    let g = 0.55 / peak_ch(&c).max(1e-6);
    gain_ch(&mut c, g);
    let k = kick(&Kick { f: 50.0, decay: 450.0, drive: 0.5, seed: seed + 1, ..KICK });
    let s = snare(&Snare { f: 200.0, noise: 1.0, crack: 0.8, drive: 0.4, seed: seed + 2, ..SNARE });
    add_ch(&mut c, &vec![k], 0.9, 0);
    add_ch(&mut c, &vec![s], 0.6, 0);
    add_ch(&mut c, &vec![burst(0.25, 0.03, 12_000.0, seed + 3)], 0.4, 0);
    even(&mut c);
    reverb(&c, &rev(1.0, 0.85, 2.5).pre(10.0).low(200.0), 0.2, 1.0)
}

fn hall_kick(seed: u32) -> Chans {
    let k = kick(&Kick { f: 47.0, decay: 650.0, drive: 0.55, click: 0.45, sub: 0.3, sub_ms: 1200.0, seed, ..KICK });
    let w = reverb_wet(&vec![k.clone()], &rev(1.0, 1.0, 3.8).pre(30.0).low(180.0).damp(6000.0), 3.0);
    let mut out = vec![k.clone(), k];
    add_ch(&mut out, &w, 0.55, 0);
    even(&mut out);
    out
}

fn sub_to(n0: f32, n1: f32, glide: f32, len: f32, harm: f32, drv: f32, click: f32, seed: u32) -> Vec<f32> {
    let mut x = tone(ns(len + 0.05), harm, |t| hz(n1 + (n0 - n1) * (1.0 - (t / glide).min(1.0)).powi(2)), |t| smooth01(t / 0.002) * dec60(t, len));
    if drv > 0.0 {
        normalize(&mut x, 1.0);
        drive(&mut x, 1.0 + 6.0 * drv, 0.05);
        lp(&mut x, 2500.0);
    }
    if click > 0.0 {
        let k = kick(&Kick { f: hz(n1).max(40.0), decay: 220.0, click, drive: 0.3, seed, ..KICK });
        add(&mut x, &k, 0.6, 0);
    }
    x
}

fn laser(f0: f32, f1: f32, len: f32, fm: f32, seed: u32) -> Vec<f32> {
    let n = ns(len);
    let mut nz = Noise::new(seed);
    let (mut p1, mut p2) = (nz.unit() as f64, nz.unit() as f64);
    let mut bp = svf(BP, 1000.0, 2.0);
    let mut out = vec![0.0f32; n];
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let u = t / len;
        let f = expi(f0, f1, u) * (1.0 + fm * (TAU32 * 38.0 * t).sin() * (1.0 - u));
        if i % 16 == 0 {
            bp.design(BP, (f * 2.0).clamp(80.0, 16_000.0) as f64, 3.0, 0.0, FS);
        }
        let (a, da) = step(&mut p1, f);
        let (b, dbb) = step(&mut p2, f * 1.007);
        let s = 0.55 * square(a, da) + 0.45 * saw(b, dbb);
        let env = smooth01(t / 0.001) * (1.0 - u).powf(1.4);
        *o = (0.6 * s + 0.8 * tick(&mut bp, s)) * env;
    }
    out
}

fn echo(x: &[f32], d_s: f32, fb: f32, taps: usize) -> Chans {
    let d = ns(d_s);
    let mut l = x.to_vec();
    let mut r = x.to_vec();
    let mut g = fb;
    for k in 1..=taps {
        let mut tap = x.to_vec();
        lp(&mut tap, 6000.0 / k as f32);
        if k % 2 == 1 {
            add(&mut r, &tap, g, k * d);
        } else {
            add(&mut l, &tap, g, k * d);
        }
        g *= fb;
    }
    let mut ch = vec![l, r];
    even(&mut ch);
    ch
}

fn blip(f: f32, len: f32) -> Vec<f32> {
    tone(ns(len), 0.15, |t| f * (1.0 + (-t / 0.004).exp()), |t| smooth01(t / 0.0008) * (1.0 - t / len).max(0.0).powf(2.0))
}

fn glitch(seed: u32) -> Chans {
    let n = ns(0.42);
    let mut nz = Noise::new(seed);
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    let mut at = 0usize;
    let mut prev: Vec<f32> = Vec::new();
    while at < n {
        let g = ns(nz.range(0.012, 0.03));
        let kind = (nz.unit() * 4.0) as u32;
        let grain: Vec<f32> = if kind == 3 && !prev.is_empty() {
            prev.clone()
        } else if kind == 2 {
            let mut x: Vec<f32> = (0..g).map(|_| nz.white()).collect();
            crush(&mut x, 3.0, 4);
            hp(&mut x, 1200.0);
            x
        } else {
            let f = expi(300.0, 5000.0, nz.unit());
            let mut ph = 0.0f64;
            (0..g)
                .map(|_| {
                    let (p, dt) = step(&mut ph, f);
                    square(p, dt)
                })
                .collect()
        };
        let pan = nz.unit();
        let amp = 0.5 + 0.5 * nz.unit();
        let m = grain.len();
        for (k, v) in grain.iter().enumerate() {
            if at + k >= n {
                break;
            }
            let e = (k as f32 / 24.0).min(1.0) * ((m - k) as f32 / 24.0).min(1.0) * amp;
            l[at + k] += v * e * (1.0 - pan).sqrt();
            r[at + k] += v * e * pan.sqrt();
        }
        prev = grain;
        at += m + if nz.unit() < 0.3 { ns(0.01) } else { 0 };
    }
    let mut ch = vec![l, r];
    for c in ch.iter_mut() {
        crush(c, 6.0, 3);
        lp(c, 12_000.0);
    }
    ch
}

fn crush_stab(seed: u32) -> Chans {
    let n = ns(0.5);
    let ch = supersaw(&[60.0, 63.0, 67.0, 70.0], n, 3, 0.0, seed, |_| 0.1, |_| 0.0);
    let mut x = mono_sum(&ch);
    for (i, v) in x.iter_mut().enumerate() {
        let t = i as f32 / SR;
        *v *= smooth01(t / 0.001) * dec60(t, 0.5);
    }
    normalize(&mut x, 0.9);
    crush(&mut x, 5.0, 6);
    lp(&mut x, 9000.0);
    hp(&mut x, 300.0);
    vec![x]
}

fn radio_tune(seed: u32) -> Chans {
    let n = ns(1.4);
    let len = 1.4;
    let mut nz = Noise::new(seed);
    let mut stat: Vec<f32> = (0..n).map(|_| nz.white()).collect();
    filt(&mut stat, BP, 1400.0, 0.5);
    let crackle: Vec<f32> = (0..n).map(|_| if nz.unit() < 0.002 { nz.white() * 3.0 } else { 0.0 }).collect();
    add(&mut stat, &crackle, 1.0, 0);
    let whistle = tone(
        n,
        0.0,
        |t| {
            let u = t / len;
            let base = if u < 0.45 { expi(3200.0, 250.0, u / 0.45) } else { expi(250.0, 1800.0, (u - 0.45) / 0.55) };
            base * (1.0 + 0.03 * (TAU32 * 6.0 * t).sin())
        },
        |t| 0.5 * (1.0 - smooth01((t / len - 0.4) / 0.1) * smooth01((0.62 - t / len) / 0.1)),
    );
    let mut station = mono_sum(&supersaw(&[57.0, 64.0, 69.0, 72.0], n, 2, 0.0, seed + 1, |_| 0.1, |_| 0.0));
    filt(&mut station, BP, 1200.0, 0.7);
    for (i, v) in station.iter_mut().enumerate() {
        let u = i as f32 / n as f32;
        *v *= smooth01((u - 0.38) / 0.08) * smooth01((0.66 - u) / 0.08) * (1.0 + 0.4 * (TAU32 * 3.0 * u * len).sin());
    }
    let mut x = stat;
    for (i, v) in x.iter_mut().enumerate() {
        let u = i as f32 / n as f32;
        *v *= 0.35 * (1.0 - 0.7 * smooth01((u - 0.38) / 0.08) * smooth01((0.66 - u) / 0.08));
    }
    add(&mut x, &whistle, 1.0, 0);
    add(&mut x, &station, 0.8, 0);
    filt(&mut x, HP, 300.0, 0.7);
    filt(&mut x, LP, 3800.0, 0.7);
    vec![x]
}

fn spark(seed: u32) -> Chans {
    let n = ns(0.7);
    let mut out: Chans = Vec::new();
    let mut shared = Noise::new(seed);
    let clusters: Vec<(usize, usize)> = (0..6).map(|_| (ns(shared.range(0.0, 0.5)), ns(shared.range(0.02, 0.12)))).collect();
    for c in 0..2u32 {
        let mut nz = Noise::new(seed + 1 + c);
        let mut x = vec![0.0f32; n];
        for &(at, len) in &clusters {
            for i in at..(at + len).min(n) {
                if nz.unit() < 0.08 {
                    x[i] += nz.white() * (0.3 + 0.7 * nz.unit());
                }
            }
        }
        filt(&mut x, BP, 4500.0, 0.8);
        let buzz = tone(n, 0.9, |_| 100.0, |t| 0.25 * dec60(t, 0.7));
        let mut b = buzz;
        hp(&mut b, 600.0);
        add(&mut x, &b, 1.0, 0);
        out.push(x);
    }
    out
}

fn ray_gun(seed: u32) -> Chans {
    let n = ns(0.55);
    let len = 0.55;
    let mut nz = Noise::new(seed);
    let mut pc = nz.unit() as f64;
    let mut pm = nz.unit() as f64;
    let mut x = vec![0.0f32; n];
    for (i, v) in x.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let u = t / len;
        let f = expi(2200.0, 350.0, u) * (1.0 + 0.12 * (1.0 - u) * (TAU32 * 30.0 * t).sin());
        let (m, _) = step(&mut pm, f * 1.5);
        let idx = 2.0 * (1.0 - u);
        let (p, _) = step(&mut pc, f);
        *v = ((p * TAU64) as f32 + idx * (m * TAU64).sin() as f32).sin() * smooth01(t / 0.001) * (1.0 - u).powf(1.2);
    }
    vec![x]
}

pub(crate) fn specs() -> Vec<Spec> {
    let mut v = Vec::new();
    let big: &[&'static str] = &["edm", "dubstep", "future-bass", "trap", "techno", "pop", "dnb", "drill"];
    v.push(spec("fx/impact/cinematic-hit.wav", "Cinematic Hit", "impact", &["big", "dark", "deep", "wide", "long"], big, || cinematic_hit(4001)));
    v.push(spec("fx/impact/thud.wav", "Low Thud", "impact", &["deep", "short", "dark", "mono", "soft"], &["trap", "drill", "lofi", "rnb", "pop", "boom-bap"], || thud(4011)).hp(20.0));
    v.push(spec("fx/impact/clap-impact.wav", "Clap Impact", "impact", &["big", "bright", "wide", "punchy"], &["edm", "house", "pop", "future-bass", "tech-house"], || clap_impact(4021)));
    v.push(spec("fx/impact/low-braam.wav", "Low Braam", "impact", &["big", "dark", "distorted", "aggressive", "long"], &["dubstep", "edm", "trap", "drill", "techno"], || braam(4031)).root(36));
    v.push(spec("fx/impact/dirty-boom.wav", "Dirty Boom", "impact", &["distorted", "dirty", "deep", "aggressive", "mono"], &["dubstep", "phonk", "trap", "drill", "dnb"], || dirty_boom(4041)).hp(20.0));
    v.push(spec("fx/impact/tom-impact.wav", "Big Tom Impact", "impact", &["big", "organic", "deep", "wide"], &["pop", "edm", "afrobeats", "trap", "future-bass"], || tom_impact(4051)));
    v.push(spec("fx/impact/crash-impact.wav", "Crash Impact", "impact", &["bright", "big", "wide", "hard"], &["edm", "house", "pop", "dnb", "dubstep", "tech-house"], || crash_impact(4061)));
    v.push(spec("fx/impact/hall-kick.wav", "Hall Kick Impact", "impact", &["big", "deep", "long", "wide"], &["edm", "techno", "house", "future-bass", "pop"], || hall_kick(4071)));

    let subs: [(&str, &str, f32, f32, f32, f32, f32, f32, f32, &[&'static str]); 6] = [
        ("drop-to-f1-long", "Sub Drop to F1 Long", 43.0, 29.0, 1.6, 3.5, 0.0, 0.0, 0.0, &["deep", "long", "clean", "mono"]),
        ("drop-to-g1-short", "Sub Drop to G1 Short", 45.0, 31.0, 0.35, 1.1, 0.0, 0.0, 0.0, &["deep", "short", "clean", "mono"]),
        ("drop-to-a1", "Sub Drop to A1", 47.0, 33.0, 0.9, 2.2, 0.1, 0.15, 0.0, &["deep", "warm", "mono"]),
        ("drop-to-c2-punchy", "Punchy Sub Drop to C2", 52.0, 36.0, 0.22, 1.0, 0.1, 0.1, 0.4, &["punchy", "short", "deep", "mono"]),
        ("drop-to-e1-distorted", "Distorted Sub Drop to E1", 50.0, 28.0, 1.3, 2.6, 0.2, 0.9, 0.0, &["distorted", "dirty", "aggressive", "deep"]),
        ("glide-drop-to-c2", "Glide Drop to C2", 48.0, 36.0, 0.8, 2.0, 0.2, 0.4, 0.25, &["glide", "deep", "warm"]),
    ];
    for (k, (slug, name, n0, n1, glide, len, harm, drv, click, tags)) in subs.into_iter().enumerate() {
        v.push(
            spec(format!("fx/sub-drop/{slug}.wav"), name, "sub-drop", tags, &["trap", "drill", "edm", "dubstep", "future-bass", "phonk", "dnb"], move || {
                vec![sub_to(n0, n1, glide, len, harm, drv, click, 4101 + k as u32)]
            })
            .root(n1 as u8)
            .hp(18.0),
        );
    }

    let sci: &[&'static str] = &["edm", "dubstep", "dnb", "future-bass", "trap", "techno", "synthwave"];
    v.push(spec("fx/zap/laser-down.wav", "Laser Down", "zap", &["bright", "retro", "short"], sci, || echo(&laser(3200.0, 160.0, 0.28, 0.0, 4201), 0.09, 0.45, 3)).peak(-2.0));
    v.push(spec("fx/zap/laser-down-wide.wav", "Wide Laser Down", "zap", &["wide", "big", "aggressive"], sci, || echo(&laser(1600.0, 220.0, 0.45, 0.08, 4202), 0.14, 0.5, 4)).peak(-2.0));
    v.push(spec("fx/zap/laser-up.wav", "Laser Up", "zap", &["bright", "short", "retro"], sci, || vec![laser(180.0, 4200.0, 0.3, 0.0, 4203)]).peak(-2.0));
    v.push(spec("fx/zap/blip.wav", "Blip", "zap", &["short", "small", "clean", "bright"], &["house", "tech-house", "techno", "pop", "future-bass", "synthwave"], || vec![blip(1600.0, 0.07)]).peak(-3.0));
    v.push(
        spec("fx/zap/double-blip.wav", "Double Blip", "zap", &["short", "small", "clean"], &["house", "tech-house", "techno", "pop", "synthwave"], || {
            let mut x = blip(1200.0, 0.06);
            add(&mut x, &blip(1800.0, 0.06), 0.9, ns(0.075));
            vec![x]
        })
        .peak(-3.0),
    );
    v.push(spec("fx/zap/glitch-burst.wav", "Glitch Burst", "zap", &["dirty", "gritty", "wide", "modern"], &["dubstep", "dnb", "techno", "future-bass", "edm", "drill"], || glitch(4206)).peak(-3.0));
    v.push(spec("fx/zap/bitcrush-stab.wav", "Bitcrush Stab", "zap", &["lofi", "dirty", "retro", "gritty"], &["dubstep", "phonk", "dnb", "trap", "techno"], || crush_stab(4207)).root(60).peak(-3.0));
    v.push(spec("fx/zap/radio-tune.wav", "Radio Tune", "zap", &["lofi", "vintage", "retro", "dirty"], &["lofi", "boom-bap", "phonk", "synthwave", "rnb"], || radio_tune(4208)).peak(-4.0));
    v.push(spec("fx/zap/electric-spark.wav", "Electric Spark", "zap", &["gritty", "bright", "aggressive"], &["dubstep", "techno", "dnb", "drill"], || spark(4209)).peak(-3.0));
    v.push(spec("fx/zap/ray-gun.wav", "Ray Gun", "zap", &["retro", "bright", "short"], &["synthwave", "dubstep", "edm", "future-bass"], || ray_gun(4210)).peak(-2.0));
    v
}
