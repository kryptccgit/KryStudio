use super::library::Spec;
use super::synth::{db, fades, hp, Chans, BAR, SR};
use crate::blocks::truepeak::true_peak;
use crate::blocks::Rng;
use crate::wav::{encode_wav, WavFormat};

pub(crate) const PCM24_MAX_SEC: f32 = 2.0;

pub(crate) fn finish(mut ch: Chans, spec: &Spec) -> Chans {
    let f = spec.fin;
    if ch.is_empty() {
        ch.push(Vec::new());
    }
    ch.truncate(2);
    let n = ch.iter().map(|c| c.len()).max().unwrap_or(0);
    for c in ch.iter_mut() {
        c.resize(n, 0.0);
        for v in c.iter_mut() {
            if !v.is_finite() {
                *v = 0.0;
            }
        }
    }
    if ch.len() == 2 && ch[0].iter().zip(&ch[1]).all(|(a, b)| (a - b).abs() <= 1e-7) {
        ch.truncate(1);
    }
    if !f.looped && f.hp_hz > 0.0 {
        for c in ch.iter_mut() {
            hp(c, f.hp_hz);
        }
    }
    if let Some(bars) = spec.bars {
        let exact = bars as usize * BAR;
        for c in ch.iter_mut() {
            c.resize(exact, 0.0);
        }
    } else {
        let pk = ch.iter().map(|c| c.iter().fold(0.0f32, |m, v| m.max(v.abs()))).fold(0.0, f32::max);
        let thr = pk * db(f.trim_db);
        let last = ch.iter().map(|c| c.iter().rposition(|v| v.abs() > thr).unwrap_or(0)).max().unwrap_or(0);
        let len = (last + 1 + (f.fade_out_ms * 0.001 * SR) as usize).min(ch[0].len());
        for c in ch.iter_mut() {
            c.truncate(len.max(1));
        }
    }
    if !f.looped {
        let a = (f.fade_in_ms * 0.001 * SR).round() as usize;
        let b = (f.fade_out_ms * 0.001 * SR).round() as usize;
        for c in ch.iter_mut() {
            fades(c, a, b);
        }
    }
    let tp = ch.iter().map(|c| true_peak(c)).fold(0.0f32, f32::max);
    if tp > 1e-9 {
        let g = db(spec.peak_db) / tp;
        for c in ch.iter_mut() {
            for v in c.iter_mut() {
                *v *= g;
            }
        }
    }
    ch
}

pub(crate) fn format_for(frames: usize, synced: bool) -> WavFormat {
    if !synced && frames as f32 / SR <= PCM24_MAX_SEC + 1e-6 {
        WavFormat::Pcm24
    } else {
        WavFormat::Pcm16
    }
}

fn seed_of(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

pub(crate) fn encode(ch: &Chans, root: Option<u8>, synced: bool, rel: &str) -> Vec<u8> {
    let frames = ch[0].len();
    let fmt = format_for(frames, synced);
    let mut bytes = if fmt == WavFormat::Pcm16 {
        let mut rng = Rng::new(seed_of(rel));
        let lsb = 1.0 / 32767.0;
        let dithered: Vec<Vec<f32>> = ch.iter().map(|c| c.iter().map(|v| v + (rng.unit() - rng.unit()) * lsb).collect()).collect();
        let refs: Vec<&[f32]> = dithered.iter().map(|c| c.as_slice()).collect();
        encode_wav(&refs, SR as u32, fmt)
    } else {
        let refs: Vec<&[f32]> = ch.iter().map(|c| c.as_slice()).collect();
        encode_wav(&refs, SR as u32, fmt)
    };
    if bytes.len() % 2 == 1 {
        bytes.push(0);
        let riff = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff.to_le_bytes());
    }
    if let Some(note) = root {
        let period = (1e9 / SR as f64).round() as u32;
        let fields = [0u32, 0, period, note as u32, 0, 0, 0, 0, 0];
        bytes.extend_from_slice(b"smpl");
        bytes.extend_from_slice(&36u32.to_le_bytes());
        for v in fields {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let riff = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff.to_le_bytes());
    }
    bytes
}
