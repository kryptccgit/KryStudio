#![allow(dead_code)]

use std::f32::consts::PI;
use std::path::PathBuf;

pub const SR: f32 = 44_100.0;

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

pub fn model_dir(id: &str) -> PathBuf {
    repo_root().join("resources").join("models").join(id)
}

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407))
    }
    pub fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
}

pub fn silence(secs: f32) -> Vec<f32> {
    vec![0.0; (secs * SR) as usize]
}

pub fn add(buf: &mut [f32], at_sec: f32, sound: &[f32], gain: f32) {
    let s0 = (at_sec * SR).round() as usize;
    for (i, &v) in sound.iter().enumerate() {
        if s0 + i < buf.len() {
            buf[s0 + i] += v * gain;
        }
    }
}

pub fn kick() -> Vec<f32> {
    let n = (0.25 * SR) as usize;
    let mut ph = 0.0f32;
    (0..n)
        .map(|i| {
            let t = i as f32 / SR;
            let f = 50.0 + 100.0 * (-t * 30.0).exp();
            ph += 2.0 * PI * f / SR;
            let tail = ((n - i) as f32 / (0.02 * SR)).min(1.0);
            ph.sin() * (-t * 12.0).exp() * tail
        })
        .collect()
}

fn hp_noise(rng: &mut Rng, n: usize, a: f32) -> Vec<f32> {
    let mut prev_x = 0.0;
    let mut prev_y = 0.0;
    (0..n)
        .map(|_| {
            let x = rng.next();
            let y = a * (prev_y + x - prev_x);
            prev_x = x;
            prev_y = y;
            y
        })
        .collect()
}

pub fn snare(seed: u64) -> Vec<f32> {
    let mut rng = Rng::new(seed);
    let n = (0.18 * SR) as usize;
    let noise = hp_noise(&mut rng, n, 0.85);
    let mut lp = 0.0f32;
    (0..n)
        .map(|i| {
            let t = i as f32 / SR;
            lp += 0.6 * (noise[i] - lp);
            let tail = ((n - i) as f32 / (0.02 * SR)).min(1.0);
            (0.7 * lp * (-t * 22.0).exp() + 0.5 * (2.0 * PI * 190.0 * t).sin() * (-t * 30.0).exp()) * tail
        })
        .collect()
}

pub fn hat(seed: u64, decay: f32) -> Vec<f32> {
    let mut rng = Rng::new(seed);
    let n = ((decay * 6.0).max(0.03) * SR) as usize;
    let noise = hp_noise(&mut rng, n, 0.2);
    let noise2 = {
        let mut px = 0.0;
        let mut py = 0.0;
        noise
            .iter()
            .map(|&x| {
                let y = 0.3 * (py + x - px);
                px = x;
                py = y;
                y
            })
            .collect::<Vec<f32>>()
    };
    (0..n).map(|i| 3.0 * noise2[i] * (-(i as f32 / SR) / decay).exp()).collect()
}

pub fn tone(freq: f32, secs: f32, harmonics: &[f32]) -> Vec<f32> {
    let n = (secs * SR) as usize;
    let fade = (0.01 * SR) as usize;
    (0..n)
        .map(|i| {
            let t = i as f32 / SR;
            let mut v = (2.0 * PI * freq * t).sin();
            for (h, &a) in harmonics.iter().enumerate() {
                v += a * (2.0 * PI * freq * (h as f32 + 2.0) * t).sin();
            }
            let env = (i.min(n - 1 - i) as f32 / fade as f32).min(1.0);
            v * env
        })
        .collect()
}

pub fn midi_hz(m: f32) -> f32 {
    440.0 * 2f32.powf((m - 69.0) / 12.0)
}

pub fn chord(notes: &[f32], secs: f32, gain: f32) -> Vec<f32> {
    let mut out = vec![0.0; (secs * SR) as usize];
    for &m in notes {
        let t = tone(midi_hz(m), secs, &[0.3, 0.1]);
        for (o, v) in out.iter_mut().zip(t) {
            *o += v * gain;
        }
    }
    out
}

pub fn groove(bpm: f32, bars: usize, kick_p: &str, snare_p: &str, hat_p: &str, swing: f32, offset: f32) -> Vec<f32> {
    let step = 60.0 / bpm / 4.0;
    let total = offset + bars as f32 * 16.0 * step + 0.5;
    let mut buf = silence(total);
    let k = kick();
    let kp: Vec<char> = kick_p.chars().filter(|c| !c.is_whitespace()).collect();
    let sp: Vec<char> = snare_p.chars().filter(|c| !c.is_whitespace()).collect();
    let hp: Vec<char> = hat_p.chars().filter(|c| !c.is_whitespace()).collect();
    for bar in 0..bars {
        for s in 0..16 {
            let idx = bar * 16 + s;
            let mut t = offset + idx as f32 * step;
            if s % 2 == 1 {
                t += swing * 0.5 * step;
            }
            if !kp.is_empty() && kp[s % kp.len()] == 'x' {
                add(&mut buf, t, &k, 0.9);
            }
            if !sp.is_empty() && sp[s % sp.len()] == 'x' {
                add(&mut buf, t, &snare(idx as u64 + 7), 0.6);
            }
            if !hp.is_empty() && hp[s % hp.len()] == 'x' {
                add(&mut buf, t, &hat(idx as u64 + 99, 0.02), if s % 4 == 0 { 0.35 } else { 0.25 });
            }
        }
    }
    buf
}

pub fn mix(a: &mut Vec<f32>, b: &[f32], gain: f32) {
    if a.len() < b.len() {
        a.resize(b.len(), 0.0);
    }
    for (x, y) in a.iter_mut().zip(b) {
        *x += y * gain;
    }
}

pub fn write_wav(path: &std::path::Path, channels: &[Vec<f32>], sr: u32) {
    let spec = hound::WavSpec { channels: channels.len() as u16, sample_rate: sr, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..channels[0].len() {
        for c in channels {
            w.write_sample(c[i]).unwrap();
        }
    }
    w.finalize().unwrap();
}

pub fn temp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("krypt-analyzer-test-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn poly_blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

pub fn osc(freq: f32, n: usize, square: bool, phase0: f32) -> Vec<f32> {
    let dt = freq / SR;
    let mut ph = phase0.fract();
    (0..n)
        .map(|_| {
            let v = if square {
                let mut s = if ph < 0.5 { 1.0 } else { -1.0 };
                s += poly_blep(ph, dt);
                s -= poly_blep((ph + 0.5).fract(), dt);
                s
            } else {
                2.0 * ph - 1.0 - poly_blep(ph, dt)
            };
            ph += dt;
            if ph >= 1.0 {
                ph -= 1.0;
            }
            v
        })
        .collect()
}

pub fn lowpass(x: &mut [f32], fc: f32) {
    let a = 1.0 - (-2.0 * PI * fc / SR).exp();
    for _ in 0..2 {
        let mut y = 0.0;
        for v in x.iter_mut() {
            y += a * (*v - y);
            *v = y;
        }
    }
}

pub fn saw_pad(chords: &[(&[f32], f32)], spread: f32, detune: f32, cutoff: f32, gain: f32) -> Vec<f32> {
    let total: f32 = chords.iter().map(|c| c.1).sum();
    let mut out = vec![0f32; (total * SR) as usize + 1];
    let mut t = 0.0;
    for (ci, (notes, secs)) in chords.iter().enumerate() {
        let n = (secs * SR) as usize;
        let mut buf = vec![0f32; n];
        for (ni, &m) in notes.iter().enumerate() {
            let f = midi_hz(m + detune / 100.0);
            for (vi, c) in [-spread, 0.0, spread].iter().enumerate() {
                let o = osc(f * 2f32.powf(c / 1200.0), n, false, (ci * 7 + ni * 3 + vi) as f32 * 0.137);
                for (b, v) in buf.iter_mut().zip(o) {
                    *b += v * 0.33;
                }
            }
            if ni == 0 {
                let o = osc(f * 0.5, n, true, 0.0);
                for (b, v) in buf.iter_mut().zip(o) {
                    *b += v * 0.3;
                }
            }
        }
        lowpass(&mut buf, cutoff);
        let fade = (0.01 * SR) as usize;
        for (i, b) in buf.iter_mut().enumerate() {
            let e = (i.min(n - 1 - i) as f32 / fade as f32).min(1.0);
            *b *= e * gain;
        }
        add(&mut out, t, &buf, 1.0);
        t += secs;
    }
    out
}

pub fn square_bass(notes: &[(f32, f32)], detune: f32, gain: f32) -> Vec<f32> {
    let total: f32 = notes.iter().map(|c| c.1).sum();
    let mut out = vec![0f32; (total * SR) as usize + 1];
    let mut t = 0.0;
    for &(m, secs) in notes {
        let n = (secs * SR) as usize;
        let mut buf = osc(midi_hz(m + detune / 100.0), n, true, 0.0);
        lowpass(&mut buf, 300.0);
        for (i, b) in buf.iter_mut().enumerate() {
            let tt = i as f32 / SR;
            *b *= gain * (tt / 0.005).min(1.0) * (-tt * 0.8).exp() * ((secs - tt) / 0.01).clamp(0.0, 1.0);
        }
        add(&mut out, t, &buf, 1.0);
        t += secs;
    }
    out
}

pub fn hats_and_claps(bpm: f32, secs: f32, gain: f32) -> Vec<f32> {
    let mut out = silence(secs);
    let step = 60.0 / bpm / 8.0;
    let mut i = 0;
    let mut t = 0.0;
    while t < secs - 0.3 {
        add(&mut out, t, &hat(i as u64 + 500, 0.012), gain * if i % 2 == 0 { 0.5 } else { 0.3 });
        if i % 16 == 8 {
            add(&mut out, t, &snare(i as u64 + 900), gain * 1.2);
        }
        i += 1;
        t += step;
    }
    out
}
