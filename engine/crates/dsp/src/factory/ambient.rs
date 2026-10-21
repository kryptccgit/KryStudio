use super::kit::*;
use super::library::{spec, Spec};
use super::synth::*;
use super::textures::{crackle, looped, looped1};

fn hum(n: usize, level: f32) -> Vec<f32> {
    let f = 60.0f64;
    (0..n)
        .map(|i| {
            let p = TAU64 * f * i as f64 / FS;
            level * (p.sin() + 0.35 * (2.0 * p).sin() + 0.2 * (3.0 * p).sin() + 0.08 * (5.0 * p).sin()) as f32
        })
        .collect()
}

fn vinyl_dusty() -> Chans {
    looped1(2, |tot, _| {
        let mut x = crackle(tot, 7001);
        add(&mut x, &crackle(tot, 7002), 0.6, 0);
        let mut nz = Noise::new(7003);
        let mut dust = vec![0.0f32; tot];
        for v in dust.iter_mut() {
            if nz.unit() < 400.0 / SR {
                *v = nz.white() * 0.12;
            }
        }
        hp(&mut dust, 2000.0);
        add(&mut x, &dust, 1.0, 0);
        let mut s: Vec<f32> = (0..tot).map(|_| nz.pink()).collect();
        hp(&mut s, 300.0);
        lp(&mut s, 3500.0);
        add(&mut x, &s, 0.09, 0);
        let mut rumble: Vec<f32> = (0..tot).map(|_| nz.brown()).collect();
        lp(&mut rumble, 90.0);
        hp(&mut rumble, 25.0);
        add(&mut x, &rumble, 0.04, 0);
        x
    })
}

fn radio_static() -> Chans {
    looped1(2, |tot, _| {
        let mut nz = Noise::new(7101);
        let fade = Wander::new(&mut nz, 0.15, 0.5);
        let wob = Wander::new(&mut nz, 3.0, 7.0);
        let mut x: Vec<f32> = (0..tot).map(|i| nz.white() * (0.75 + 0.25 * fade.at(i as f32 / SR)) * (1.0 + 0.15 * wob.at(i as f32 / SR))).collect();
        filt(&mut x, HP, 350.0, 0.7);
        filt(&mut x, LP, 4200.0, 0.7);
        filt(&mut x, LP, 4200.0, 0.7);
        let mut cr = crackle(tot, 7102);
        gain(&mut cr, 1.8);
        add(&mut x, &cr, 1.0, 0);
        let drift = Wander::new(&mut nz, 0.05, 0.12);
        let mut ph = 0.0f64;
        let w: Vec<f32> = (0..tot)
            .map(|i| {
                let t = i as f32 / SR;
                let (p, _) = step(&mut ph, 1100.0 * (1.0 + 0.08 * drift.at(t)));
                (p * TAU64).sin() as f32 * 0.04 * (0.5 + 0.5 * fade.at(t + 1.3))
            })
            .collect();
        add(&mut x, &w, 1.0, 0);
        x
    })
}

fn tape_hum() -> Chans {
    let mut ch = looped1(2, |tot, _| {
        let mut nz = Noise::new(7201);
        let wan = Wander::new(&mut nz, 0.3, 1.0);
        let mut x: Vec<f32> = (0..tot).map(|i| (0.5 * nz.white() + 0.9 * nz.pink()) * (1.0 + 0.06 * wan.at(i as f32 / SR))).collect();
        hp(&mut x, 900.0);
        lp(&mut x, 9000.0);
        gain(&mut x, 0.6);
        x
    });
    let n = ch[0].len();
    let h = hum(n, 0.05);
    add(&mut ch[0], &h, 1.0, 0);
    ch
}

fn brown_noise() -> Chans {
    looped1(1, |tot, _| {
        let mut nz = Noise::new(7301);
        let mut x: Vec<f32> = (0..tot).map(|_| nz.brown()).collect();
        hp(&mut x, 25.0);
        lp(&mut x, 6000.0);
        x
    })
}

fn heavy_rain() -> Chans {
    looped(2, |tot, c| {
        let mut nz = Noise::new(7401 + c * 19);
        let wan = Wander::new(&mut nz, 0.08, 0.25);
        let mut bed: Vec<f32> = (0..tot).map(|i| nz.pink() * (1.0 + 0.2 * wan.at(i as f32 / SR))).collect();
        lp(&mut bed, 6500.0);
        hp(&mut bed, 180.0);
        let mut drops = vec![0.0f32; tot];
        for i in 0..tot {
            if nz.unit() < 900.0 / SR {
                let f = expi(1200.0, 7000.0, nz.unit());
                let tau = nz.range(0.0015, 0.005);
                let a = 0.1 + 0.9 * nz.unit().powi(3);
                let len = ns(tau * 5.0).min(tot - i);
                let mut ph = 0.0f64;
                for k in 0..len {
                    let t = k as f32 / SR;
                    let (p, _) = step(&mut ph, f * (1.0 + 0.35 * t / (tau * 5.0)));
                    drops[i + k] += (p * TAU64).sin() as f32 * a * (-t / tau).exp() * (k as f32 / 10.0).min(1.0);
                }
            }
        }
        hp(&mut drops, 800.0);
        let mut roar: Vec<f32> = (0..tot).map(|_| nz.brown()).collect();
        lp(&mut roar, 400.0);
        hp(&mut roar, 50.0);
        let mut x = bed;
        gain(&mut x, 0.5);
        add(&mut x, &drops, 0.7, 0);
        add(&mut x, &roar, 0.25, 0);
        x
    })
}

fn storm_wind() -> Chans {
    looped(2, |tot, c| {
        let mut shared = Noise::new(7501);
        let gust = Wander::new(&mut shared, 0.1, 0.35);
        let pitch = Wander::new(&mut shared, 0.12, 0.4);
        let mut own = Noise::new(7510 + c);
        let src: Vec<f32> = (0..tot).map(|_| own.pink()).collect();
        let mut b1 = svf(BP, 600.0, 4.0);
        let mut b2 = svf(BP, 1500.0, 12.0);
        let mut low = svf(LP, 250.0, 0.7);
        let mut x = vec![0.0f32; tot];
        for i in 0..tot {
            let t = i as f32 / SR;
            if i % 16 == 0 {
                let fc = 650.0 * 2f32.powf(1.3 * pitch.at(t + 0.2 * c as f32));
                b1.design(BP, fc as f64, 4.0, 0.0, FS);
                b2.design(BP, (fc * 2.6) as f64, 12.0, 0.0, FS);
            }
            let s = src[i];
            let g = 0.25 + 0.75 * smooth01(0.5 + 0.7 * gust.at(t + 0.1 * c as f32));
            x[i] = (tick(&mut b1, s) + 0.35 * tick(&mut b2, s) + 0.6 * tick(&mut low, s)) * g;
        }
        hp(&mut x, 40.0);
        x
    })
}

fn hall_air() -> Chans {
    looped1(2, |tot, _| {
        let mut nz = Noise::new(7601);
        let mut x: Vec<f32> = (0..tot).map(|_| 0.7 * nz.brown() + 0.3 * nz.pink()).collect();
        lp(&mut x, 700.0);
        hp(&mut x, 30.0);
        let mut v: Vec<f32> = (0..tot).map(|_| nz.white()).collect();
        filt(&mut v, BP, 260.0, 1.5);
        add(&mut x, &v, 0.12, 0);
        let mut air: Vec<f32> = (0..tot).map(|_| nz.white()).collect();
        hp(&mut air, 7000.0);
        add(&mut x, &air, 0.015, 0);
        x
    })
}

pub(crate) fn specs() -> Vec<Spec> {
    vec![
        spec("textures/vinyl-dusty.wav", "Dusty Vinyl", "texture", &["lofi", "vintage", "dirty", "warm", "gritty"], &["lofi", "boom-bap", "phonk", "rnb"], vinyl_dusty).bars(2).looped().peak(-6.0),
        spec("textures/radio-static.wav", "Radio Static", "noise", &["lofi", "dirty", "vintage", "gritty"], &["lofi", "boom-bap", "phonk", "synthwave", "techno"], radio_static).bars(2).looped().peak(-9.0),
        spec("textures/tape-hum.wav", "Tape Hum", "texture", &["lofi", "vintage", "warm", "soft"], &["lofi", "boom-bap", "rnb", "synthwave"], tape_hum).bars(2).looped().peak(-14.0),
        spec("textures/brown-noise-1bar.wav", "Brown Noise Loop", "noise", &["dark", "deep", "soft", "warm"], &["lofi", "techno", "deep-house", "dubstep"], brown_noise).bars(1).looped().peak(-9.0),
        spec("textures/heavy-rain.wav", "Heavy Rain", "texture", &["organic", "wide", "dark", "evolving"], &["lofi", "rnb", "deep-house", "future-bass", "drill"], heavy_rain).bars(2).looped().peak(-8.0),
        spec("textures/storm-wind.wav", "Storm Wind", "noise", &["dark", "wide", "evolving", "aggressive"], &["techno", "dubstep", "dnb", "drill", "synthwave"], storm_wind).bars(2).looped().peak(-6.0),
        spec("textures/hall-air.wav", "Empty Hall Air", "texture", &["soft", "dark", "big", "organic"], &["lofi", "rnb", "deep-house", "techno"], hall_air).bars(2).looped().peak(-14.0),
    ]
}
