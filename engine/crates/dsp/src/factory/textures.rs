//! Texture and noise loops: 4 bars at 128 BPM (1 for the plain white noise),
//! seamless (the tail past the loop point is crossfaded onto the start).
//! Vinyl crackle, tape hiss, rain, wind, room tone and a white noise loop.

use super::library::{spec, Spec};
use super::synth::*;

/// Loop crossfade (0.5 s).
pub(crate) const XF: usize = 24_000;

/// Render `bars` bars of loopable stereo: `f(total_len, channel)` makes each
/// side (total = loop + crossfade), then the seam is crossfaded.
pub(crate) fn looped(bars: u32, f: impl Fn(usize, u32) -> Vec<f32>) -> Chans {
    let n = bars as usize * BAR;
    (0..2u32)
        .map(|c| {
            let mut x = f(n + XF, c);
            x.resize(n + XF, 0.0);
            make_loop(&mut x, n, XF);
            x
        })
        .collect()
}

/// Mono variant of `looped`.
pub(crate) fn looped1(bars: u32, f: impl Fn(usize, u32) -> Vec<f32>) -> Chans {
    let n = bars as usize * BAR;
    let mut x = f(n + XF, 0);
    x.resize(n + XF, 0.0);
    make_loop(&mut x, n, XF);
    vec![x]
}

/// Sparse clicks (many small, few loud) and occasional low pops.
pub(crate) fn crackle(tot: usize, seed: u32) -> Vec<f32> {
    let mut nz = Noise::new(seed);
    let mut clicks = vec![0.0f32; tot];
    let mut pops = vec![0.0f32; tot];
    let (p_click, p_pop) = (38.0 / SR, 2.5 / SR);
    for i in 0..tot {
        if nz.unit() < p_click {
            let a = 0.08 + 0.92 * nz.unit().powi(5);
            clicks[i] += if nz.unit() < 0.5 { a } else { -a };
        }
        if nz.unit() < p_pop {
            let a = 0.5 + 0.5 * nz.unit();
            let len = ns(nz.range(0.002, 0.006));
            for k in 0..len.min(tot - i) {
                pops[i + k] += nz.white() * a * (-(k as f32) / (len as f32 * 0.3)).exp();
            }
        }
    }
    hp(&mut clicks, 700.0);
    lp(&mut clicks, 7000.0);
    lp(&mut pops, 2500.0);
    hp(&mut pops, 150.0);
    add(&mut clicks, &pops, 0.5, 0);
    clicks
}

/// Vinyl crackle is the groove itself, so it is mono.
fn vinyl() -> Chans {
    looped1(4, |tot, c| {
        let mut x = crackle(tot, 1201);
        add(&mut x, &crackle(tot, 1210 + c), 0.3, 0);
        // surface noise
        let mut nz = Noise::new(1220 + c);
        let mut s: Vec<f32> = (0..tot).map(|_| nz.pink()).collect();
        hp(&mut s, 400.0);
        lp(&mut s, 5000.0);
        add(&mut x, &s, 0.05, 0);
        x
    })
}

fn tape_hiss() -> Chans {
    looped(4, |tot, c| {
        let mut nz = Noise::new(1301 + c);
        let wan = Wander::new(&mut nz, 0.3, 1.2);
        let mut x: Vec<f32> = (0..tot).map(|i| (0.6 * nz.white() + 0.8 * nz.pink()) * (1.0 + 0.05 * wan.at(i as f32 / SR))).collect();
        hp(&mut x, 1200.0);
        eq(&mut x, HighShelf, 7000.0, 0.7, 3.0);
        lp(&mut x, 15_000.0);
        x
    })
}

fn rain() -> Chans {
    looped(4, |tot, c| {
        let mut nz = Noise::new(1401 + c * 17);
        let wan = Wander::new(&mut nz, 0.05, 0.2);
        let mut bed: Vec<f32> = (0..tot).map(|i| nz.pink() * (1.0 + 0.15 * wan.at(i as f32 / SR))).collect();
        lp(&mut bed, 4500.0);
        hp(&mut bed, 250.0);
        let mut drops = vec![0.0f32; tot];
        let p_drop = 260.0 / SR;
        let p_tick = 90.0 / SR;
        for i in 0..tot {
            if nz.unit() < p_drop {
                let f = 1500.0 * (6500.0f32 / 1500.0).powf(nz.unit());
                let tau = nz.range(0.002, 0.007);
                let a = 0.15 + 0.85 * nz.unit().powi(3);
                let len = ns(tau * 5.0).min(tot - i);
                let mut ph = 0.0f64;
                for k in 0..len {
                    let t = k as f32 / SR;
                    let (p, _) = step(&mut ph, f * (1.0 + 0.3 * t / (tau * 5.0)));
                    drops[i + k] += (p * TAU64).sin() as f32 * a * (-t / tau).exp() * (k as f32 / 12.0).min(1.0);
                }
            }
            if nz.unit() < p_tick {
                let a = 0.05 + 0.3 * nz.unit();
                drops[i] += if nz.unit() < 0.5 { a } else { -a };
            }
        }
        hp(&mut drops, 900.0);
        let mut x = bed;
        gain(&mut x, 0.35);
        add(&mut x, &drops, 0.9, 0);
        x
    })
}

fn wind() -> Chans {
    // shared gust shape, slightly different per side
    looped(4, |tot, c| {
        let mut shared = Noise::new(1501);
        let w_gust = Wander::new(&mut shared, 0.04, 0.15);
        let w_pitch = Wander::new(&mut shared, 0.05, 0.2);
        let mut own = Noise::new(1510 + c);
        let o_pitch = Wander::new(&mut own, 0.1, 0.3);
        let src: Vec<f32> = (0..tot).map(|_| own.pink()).collect();
        let mut b1 = svf(BP, 500.0, 3.0);
        let mut b2 = svf(BP, 1200.0, 8.0);
        let mut x = vec![0.0f32; tot];
        for i in 0..tot {
            let t = i as f32 / SR;
            if i % 16 == 0 {
                let w = 0.7 * w_pitch.at(t) + 0.3 * o_pitch.at(t);
                let fc = 520.0 * (2.0f32).powf(1.5 * w);
                b1.design(BP, fc as f64, 3.0, 0.0, FS);
                b2.design(BP, (fc * 2.3) as f64, 8.0, 0.0, FS);
            }
            let s = src[i];
            let gust = 0.3 + 0.7 * smooth01(0.5 + 0.6 * w_gust.at(t + 0.15 * c as f32));
            x[i] = (tick(&mut b1, s) + 0.25 * tick(&mut b2, s)) * gust;
        }
        hp(&mut x, 60.0);
        x
    })
}

/// Room tone: low, quiet air (mono; it sits under everything).
fn room_tone() -> Chans {
    looped1(4, |tot, c| {
        let mut nz = Noise::new(1601 + c);
        let mut x: Vec<f32> = (0..tot).map(|_| 0.5 * nz.brown() + 0.5 * nz.pink()).collect();
        lp(&mut x, 1200.0);
        hp(&mut x, 45.0);
        let mut air: Vec<f32> = (0..tot).map(|_| nz.white()).collect();
        hp(&mut air, 6000.0);
        add(&mut x, &air, 0.02, 0);
        x
    })
}

fn white_noise() -> Chans {
    looped(1, |tot, c| {
        let mut nz = Noise::new(1711 + c);
        let mut x: Vec<f32> = (0..tot).map(|_| nz.white()).collect();
        hp(&mut x, 20.0);
        lp(&mut x, 18_000.0);
        x
    })
}

pub(crate) fn specs() -> Vec<Spec> {
    let all: &[&'static str] = &[];
    vec![
        spec("textures/vinyl-crackle.wav", "Vinyl Crackle", "texture", &["lofi", "vintage", "dirty", "warm"], &["lofi", "boom-bap", "rnb", "phonk"], vinyl).bars(4).looped().peak(-6.0),
        spec("textures/tape-hiss.wav", "Tape Hiss", "texture", &["lofi", "vintage", "airy", "soft"], &["lofi", "boom-bap", "rnb", "synthwave"], tape_hiss).bars(4).looped().peak(-12.0),
        spec("textures/rain.wav", "Rain Texture", "texture", &["organic", "soft", "wide", "dreamy"], &["lofi", "rnb", "deep-house", "future-bass"], rain).bars(4).looped().peak(-8.0),
        spec("textures/wind.wav", "Wind", "noise", &["airy", "dark", "wide", "evolving"], &["techno", "deep-house", "dubstep", "lofi", "synthwave"], wind).bars(4).looped().peak(-6.0),
        spec("textures/room-tone.wav", "Room Tone", "texture", &["soft", "warm", "organic", "small"], &["lofi", "rnb", "boom-bap"], room_tone).bars(4).looped().peak(-14.0),
        spec("textures/white-noise-1bar.wav", "White Noise Loop", "noise", &["bright", "wide", "airy"], all, white_noise).bars(1).looped().peak(-9.0),
    ]
}
