//! Minimal WAV writer (PCM 16/24-bit or float32), used by the factory kit
//! and the render example. Writes atomically (tmp file + rename).

use std::fs;
use std::io::{self, Write};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WavFormat {
    Pcm16,
    Pcm24,
    Float32,
}

/// Encode interleaved-by-channel planar data to WAV bytes.
pub fn encode_wav(channels: &[&[f32]], sample_rate: u32, fmt: WavFormat) -> Vec<u8> {
    let nch = channels.len().max(1) as u16;
    let frames = channels.iter().map(|c| c.len()).min().unwrap_or(0);
    let (bits, tag): (u16, u16) = match fmt {
        WavFormat::Pcm16 => (16, 1),
        WavFormat::Pcm24 => (24, 1),
        WavFormat::Float32 => (32, 3),
    };
    let block = nch as u32 * bits as u32 / 8;
    let data_len = frames as u32 * block;
    let mut v = Vec::with_capacity(44 + data_len as usize);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data_len).to_le_bytes());
    v.extend_from_slice(b"WAVE");
    v.extend_from_slice(b"fmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&tag.to_le_bytes());
    v.extend_from_slice(&nch.to_le_bytes());
    v.extend_from_slice(&sample_rate.to_le_bytes());
    v.extend_from_slice(&(sample_rate * block).to_le_bytes());
    v.extend_from_slice(&(block as u16).to_le_bytes());
    v.extend_from_slice(&bits.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data_len.to_le_bytes());
    for i in 0..frames {
        for c in channels {
            let x = if c[i].is_finite() { c[i].clamp(-1.0, 1.0) } else { 0.0 };
            match fmt {
                WavFormat::Pcm16 => {
                    let s = (x * 32767.0).round() as i16;
                    v.extend_from_slice(&s.to_le_bytes());
                }
                WavFormat::Pcm24 => {
                    let s = (x as f64 * 8_388_607.0).round() as i32;
                    let b = s.to_le_bytes();
                    v.extend_from_slice(&b[..3]);
                }
                WavFormat::Float32 => v.extend_from_slice(&x.to_le_bytes()),
            }
        }
    }
    v
}

/// Write a WAV file atomically.
pub fn write_wav(path: &Path, channels: &[&[f32]], sample_rate: u32, fmt: WavFormat) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let bytes = encode_wav(channels, sample_rate, fmt);
    let tmp = path.with_extension("wav.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

/// Read back a PCM16/24/float32 WAV written by `encode_wav` (tests, examples).
pub fn decode_wav(bytes: &[u8]) -> Option<(u32, Vec<Vec<f32>>)> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12;
    let (mut nch, mut sr, mut bits, mut tag) = (0u16, 0u32, 0u16, 0u16);
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().ok()?) as usize;
        let body = bytes.get(pos + 8..pos + 8 + len)?;
        if id == b"fmt " {
            tag = u16::from_le_bytes(body[0..2].try_into().ok()?);
            nch = u16::from_le_bytes(body[2..4].try_into().ok()?);
            sr = u32::from_le_bytes(body[4..8].try_into().ok()?);
            bits = u16::from_le_bytes(body[14..16].try_into().ok()?);
        } else if id == b"data" {
            let nch = nch.max(1) as usize;
            let bps = bits as usize / 8;
            let frames = body.len() / (bps * nch);
            let mut out = vec![Vec::with_capacity(frames); nch];
            for f in 0..frames {
                for (c, ch) in out.iter_mut().enumerate() {
                    let o = (f * nch + c) * bps;
                    let s = &body[o..o + bps];
                    let x = match (tag, bits) {
                        (1, 16) => i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0,
                        (1, 24) => (i32::from_le_bytes([0, s[0], s[1], s[2]]) >> 8) as f32 / 8_388_608.0,
                        (3, 32) => f32::from_le_bytes([s[0], s[1], s[2], s[3]]),
                        _ => return None,
                    };
                    ch.push(x);
                }
            }
            return Some((sr, out));
        }
        pos += 8 + len + (len & 1);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_24bit() {
        let l: Vec<f32> = (0..100).map(|i| (i as f32 * 0.1).sin() * 0.9).collect();
        let r: Vec<f32> = l.iter().map(|x| -x).collect();
        let b = encode_wav(&[&l, &r], 48000, WavFormat::Pcm24);
        let (sr, ch) = decode_wav(&b).unwrap();
        assert_eq!(sr, 48000);
        assert_eq!(ch.len(), 2);
        for i in 0..100 {
            assert!((ch[0][i] - l[i]).abs() < 1e-6);
            assert!((ch[1][i] - r[i]).abs() < 1e-6);
        }
    }
}
