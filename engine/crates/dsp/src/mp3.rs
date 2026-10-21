use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::blocks::sinc::resample;

pub const BITRATES_KBPS: [u32; 4] = [128, 192, 256, 320];
pub const DEFAULT_KBPS: u32 = 320;
pub const SAMPLE_RATES: [u32; 3] = [32_000, 44_100, 48_000];

pub const TAIL_PAD: usize = 6 * 1152;

pub const ENCODE_ATTEMPTS: usize = 3;

const DECODER_DELAY: u64 = 529;

pub const ENCODER_MISSING: &str = "MP3 export needs Windows' MP3 encoder, which is missing on Windows N editions without the Media Feature Pack.";

pub const ENCODER_WINDOWS_ONLY: &str = "MP3 export needs Windows' MP3 encoder (Media Foundation), which only Windows has";

pub fn parse_kbps(kbps: Option<f64>) -> Result<u32, String> {
    let Some(k) = kbps else { return Ok(DEFAULT_KBPS) };
    if let Some(&b) = BITRATES_KBPS.iter().find(|&&b| b as f64 == k) {
        return Ok(b);
    }
    let shown = if k.is_finite() && k.fract() == 0.0 { format!("{k:.0}") } else { format!("{k}") };
    Err(unsupported_kbps(&shown))
}

fn unsupported_kbps(shown: &str) -> String {
    format!("MP3 bitrate {shown} kbps is not supported: use 128, 192, 256 or 320")
}

pub fn check_encoder() -> Result<(), String> {
    #[cfg(all(windows, feature = "mediafoundation"))]
    {
        if crate::decode::mf::mp3_encoder_available() {
            Ok(())
        } else {
            Err(ENCODER_MISSING.to_string())
        }
    }
    #[cfg(not(all(windows, feature = "mediafoundation")))]
    {
        encode(Path::new(""), &[], &[], 0, 0, None)
    }
}

pub fn encode_rate(sample_rate: u32) -> u32 {
    if SAMPLE_RATES.contains(&sample_rate) {
        sample_rate
    } else if sample_rate.is_multiple_of(11_025) {
        44_100
    } else {
        48_000
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mp3Info {
    pub sample_rate: u32,
    pub kbps: u32,
    pub frames: usize,
    pub bytes: u64,
    pub mpeg_frames: usize,
    pub encoder_delay: Option<u32>,
    pub end_padding: Option<u32>,
    pub itunsmpb: Option<String>,
    pub sink_itunsmpb: Option<String>,
    pub stripped_tag_bytes: u64,
}

pub struct Tpdf(u32);

impl Default for Tpdf {
    fn default() -> Self {
        Tpdf(0x9E37_79B9)
    }
}

impl Tpdf {
    #[inline]
    fn uniform(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x >> 8) as f32 * (1.0 / 16_777_216.0) - 0.5
    }

    #[inline]
    pub fn quantize(&mut self, x: f32) -> i16 {
        let d = self.uniform() + self.uniform();
        if !x.is_finite() {
            return 0;
        }
        (x * 32_767.0 + d).round().clamp(-32_768.0, 32_767.0) as i16
    }
}

pub fn write_mp3(path: &Path, left: &[f32], right: &[f32], sample_rate: u32, kbps: u32, cancel: Option<&AtomicBool>) -> Result<Mp3Info, String> {
    if !BITRATES_KBPS.contains(&kbps) {
        return Err(unsupported_kbps(&kbps.to_string()));
    }
    if sample_rate == 0 {
        return Err("Cannot encode MP3: the audio has no sample rate".into());
    }
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create folder {}: {e}", dir.display()))?;
        }
    }
    let rate = encode_rate(sample_rate);
    let frames_in = left.len().min(right.len());
    let (l, r);
    let (left, right) = if rate != sample_rate {
        (l, r) = std::thread::scope(|s| {
            let h = s.spawn(|| resample(&left[..frames_in], sample_rate, rate));
            let r = resample(&right[..frames_in], sample_rate, rate);
            (h.join().unwrap_or_default(), r)
        });
        (&l[..], &r[..])
    } else {
        (&left[..frames_in], &right[..frames_in])
    };
    let frames = left.len().min(right.len());
    let enc = path.with_extension("mp3.enc.part");
    let tmp = part_path(path);
    let mut attempt = 0;
    let (tag_len, sink_itunsmpb, mpeg_frames) = loop {
        attempt += 1;
        let staged = encode(&enc, left, right, rate, kbps, cancel).and_then(|()| stage(&enc, &tmp).map_err(|e| format!("Cannot write {}: {e}", path.display())));
        let _ = std::fs::remove_file(&enc);
        let staged = match staged {
            Ok(t) => t,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        };
        let delay = staged.1.as_deref().and_then(sink_delay).unwrap_or(1152) as u64;
        if staged.2 as u64 * 1152 >= delay + frames as u64 + DECODER_DELAY {
            break staged;
        }
        let _ = std::fs::remove_file(&tmp);
        if attempt >= ENCODE_ATTEMPTS {
            return Err(format!("Windows' MP3 encoder cut off the end of {} ({ENCODE_ATTEMPTS} tries). Export again, or export WAV.", path.display()));
        }
    };
    let bytes = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Cannot move the MP3 into place at {}: {e}", path.display()));
    }
    let encoder_delay = sink_itunsmpb.as_deref().and_then(sink_delay);
    let end_padding = encoder_delay.and_then(|d| (mpeg_frames as u64 * 1152).checked_sub(d as u64 + frames as u64)).map(|p| p.min(u32::MAX as u64) as u32);
    let itunsmpb = match (&sink_itunsmpb, end_padding) {
        (Some(t), Some(pad)) => gapless_text(t, pad, frames as u64),
        _ => None,
    };
    Ok(Mp3Info { sample_rate: rate, kbps, frames, bytes, mpeg_frames, encoder_delay, end_padding, itunsmpb, sink_itunsmpb, stripped_tag_bytes: tag_len })
}

fn gapless_text(t: &str, padding: u32, samples: u64) -> Option<String> {
    let mut f: Vec<String> = t.split_whitespace().map(str::to_string).collect();
    if f.len() < 4 {
        return None;
    }
    f[2] = format!("{padding:08x}");
    f[3] = format!("{samples:016x}");
    Some(format!(" {}", f.join(" ")))
}

pub fn mpeg_frame_len(h: u32) -> Option<usize> {
    let (ver, layer, bi, si) = ((h >> 19) & 3, (h >> 17) & 3, ((h >> 12) & 0xF) as usize, ((h >> 10) & 3) as usize);
    if h >> 21 != 0x7FF || ver == 1 || layer != 1 || bi == 0 || bi == 15 || si == 3 {
        return None;
    }
    let mpeg1 = ver == 3;
    let kbps = if mpeg1 { [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][bi] } else { [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][bi] };
    let base = [44_100, 48_000, 32_000][si];
    let rate = match ver {
        3 => base,
        2 => base / 2,
        _ => base / 4,
    };
    let coef = if mpeg1 { 144 } else { 72 };
    Some((coef * kbps * 1000 / rate + ((h >> 9) & 1)) as usize)
}

fn count_mpeg_frames(path: &Path) -> std::io::Result<usize> {
    let mut f = std::io::BufReader::with_capacity(1 << 16, std::fs::File::open(path)?);
    let (mut n, mut h) = (0usize, [0u8; 4]);
    while f.read_exact(&mut h).is_ok() {
        let Some(len) = mpeg_frame_len(u32::from_be_bytes(h)) else { break };
        f.seek_relative(len as i64 - 4)?;
        n += 1;
    }
    Ok(n)
}

fn part_path(path: &Path) -> PathBuf {
    path.with_extension("mp3.part")
}

pub fn id3v2_len(head: &[u8]) -> Option<u64> {
    if head.len() < 10 || &head[0..3] != b"ID3" || head[3] == 0xFF || head[4] == 0xFF || head[6..10].iter().any(|b| b & 0x80 != 0) {
        return None;
    }
    let footer = if head[5] & 0x10 != 0 { 10 } else { 0 };
    Some(10 + syncsafe(&head[6..10]) as u64 + footer)
}

fn syncsafe(b: &[u8]) -> u32 {
    b.iter().fold(0u32, |a, &x| (a << 7) | (x & 0x7F) as u32)
}

pub fn itunsmpb(tag: &[u8]) -> Option<String> {
    let total = id3v2_len(tag)? as usize;
    let (ver, flags) = (tag[3], tag[5]);
    let end = total.min(tag.len()).saturating_sub(if flags & 0x10 != 0 { 10 } else { 0 });
    let mut pos = 10;
    if flags & 0x40 != 0 {
        let b = tag.get(10..14)?;
        pos += if ver >= 4 { syncsafe(b) as usize } else { 4 + u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize };
    }
    while pos + 10 <= end {
        let id = &tag[pos..pos + 4];
        if id[0] == 0 {
            break;
        }
        let sb = &tag[pos + 4..pos + 8];
        let size = if ver >= 4 { syncsafe(sb) } else { u32::from_be_bytes([sb[0], sb[1], sb[2], sb[3]]) } as usize;
        let body = tag.get(pos + 10..pos + 10 + size)?;
        if id == b"COMM" && body.len() > 4 {
            let (desc, text) = split_text(body[0], &body[4..]);
            if desc == "iTunSMPB" {
                return Some(text.trim_end_matches('\0').to_string());
            }
        }
        pos += 10 + size;
    }
    None
}

fn split_text(enc: u8, b: &[u8]) -> (String, String) {
    let wide = enc == 1 || enc == 2;
    let cut = if wide { (0..b.len().saturating_sub(1)).step_by(2).find(|&i| b[i] == 0 && b[i + 1] == 0) } else { b.iter().position(|&x| x == 0) };
    let Some(cut) = cut else { return (decode_text(enc, b), String::new()) };
    let skip = if wide { 2 } else { 1 };
    (decode_text(enc, &b[..cut]), decode_text(enc, &b[cut + skip..]))
}

fn decode_text(enc: u8, b: &[u8]) -> String {
    match enc {
        0 => b.iter().map(|&c| c as char).collect(),
        1 | 2 => {
            let mut be = enc == 2;
            let mut b = b;
            if b.len() >= 2 && (b[..2] == [0xFF, 0xFE] || b[..2] == [0xFE, 0xFF]) {
                be = b[0] == 0xFE;
                b = &b[2..];
            }
            let units: Vec<u16> = b.as_chunks::<2>().0.iter().map(|&c| if be { u16::from_be_bytes(c) } else { u16::from_le_bytes(c) }).collect();
            String::from_utf16_lossy(&units)
        }
        _ => String::from_utf8_lossy(b).into_owned(),
    }
}

fn stage(enc: &Path, tmp: &Path) -> std::io::Result<(u64, Option<String>, usize)> {
    let (tag_len, info) = strip_id3v2(enc, tmp)?;
    Ok((tag_len, info, count_mpeg_frames(tmp)?))
}

fn sink_delay(itunsmpb: &str) -> Option<u32> {
    itunsmpb.split_whitespace().nth(1).and_then(|h| u32::from_str_radix(h, 16).ok())
}

fn strip_id3v2(src: &Path, dst: &Path) -> std::io::Result<(u64, Option<String>)> {
    let mut f = std::fs::File::open(src)?;
    let mut head = [0u8; 10];
    let got = f.read(&mut head)?;
    let (tag_len, info) = match id3v2_len(&head[..got]) {
        Some(n) => {
            let mut tag = vec![0u8; n.min(1 << 20) as usize];
            f.seek(SeekFrom::Start(0))?;
            f.read_exact(&mut tag)?;
            (n, itunsmpb(&tag))
        }
        None => (0, None),
    };
    f.seek(SeekFrom::Start(tag_len))?;
    let mut out = std::io::BufWriter::with_capacity(1 << 20, std::fs::File::create(dst)?);
    std::io::copy(&mut f, &mut out)?;
    out.flush()?;
    out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
    Ok((tag_len, info))
}

#[cfg(all(windows, feature = "mediafoundation"))]
fn encode(tmp: &Path, left: &[f32], right: &[f32], rate: u32, kbps: u32, cancel: Option<&AtomicBool>) -> Result<(), String> {
    use crate::decode::mf::{encode_mp3, Mp3Error};
    use std::sync::atomic::Ordering;
    let mut dither = Tpdf::default();
    let n = left.len().min(right.len());
    let mut fill = |at: usize, out: &mut [i16]| -> bool {
        if cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
            return false;
        }
        for (i, pair) in out.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let k = at + i;
            if k < n {
                pair[0] = dither.quantize(left[k]);
                pair[1] = dither.quantize(right[k]);
            } else {
                pair[0] = 0;
                pair[1] = 0;
            }
        }
        true
    };
    encode_mp3(tmp, rate, kbps, n + TAIL_PAD, &mut fill).map_err(|e| match e {
        Mp3Error::EncoderMissing => ENCODER_MISSING.to_string(),
        Mp3Error::Cancelled => "Render cancelled".to_string(),
        Mp3Error::Other(m) => m,
    })
}

#[cfg(not(all(windows, feature = "mediafoundation")))]
fn encode(_tmp: &Path, _left: &[f32], _right: &[f32], _rate: u32, _kbps: u32, _cancel: Option<&AtomicBool>) -> Result<(), String> {
    Err(if cfg!(windows) { "MP3 export needs Windows Media Foundation, which this build doesn't include".to_string() } else { ENCODER_WINDOWS_ONLY.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitrates_and_rates() {
        assert_eq!(parse_kbps(None), Ok(320));
        for k in BITRATES_KBPS {
            assert_eq!(parse_kbps(Some(k as f64)), Ok(k));
        }
        for bad in [100.0, 0.0, -128.0, 320.5, 1e9, f64::NAN] {
            let e = parse_kbps(Some(bad)).unwrap_err();
            assert!(e.starts_with("MP3 bitrate ") && e.ends_with("use 128, 192, 256 or 320"), "{e}");
        }
        assert_eq!(parse_kbps(Some(100.0)).unwrap_err(), "MP3 bitrate 100 kbps is not supported: use 128, 192, 256 or 320");
        assert_eq!([32_000, 44_100, 48_000].map(encode_rate), [32_000, 44_100, 48_000]);
        assert_eq!([22_050, 88_200, 176_400, 352_800, 11_025].map(encode_rate), [44_100; 5]);
        assert_eq!([96_000, 192_000, 384_000, 8_000, 16_000, 24_000, 64_000].map(encode_rate), [48_000; 7]);
    }

    #[test]
    fn tpdf_dither_is_unbiased_and_bounded() {
        let mut d = Tpdf::default();
        let x = 0.3 / 32_767.0;
        let n = 200_000;
        let qs: Vec<i16> = (0..n).map(|_| d.quantize(x)).collect();
        let mean = qs.iter().map(|&q| q as f64).sum::<f64>() / n as f64;
        assert!((mean - 0.3).abs() < 0.01, "mean {mean} LSB: dither keeps sub-LSB level on average");
        assert!(qs.iter().all(|&q| (-1..=1).contains(&q)), "TPDF spans at most ±1 LSB around the value");
        assert!(qs.contains(&-1) && qs.contains(&1));
        assert_eq!(d.quantize(f32::NAN), 0);
        assert_eq!(d.quantize(2.0), 32_767);
        assert_eq!(d.quantize(-2.0), -32_768);
    }

    #[test]
    fn bad_bitrate_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("krypt-mp3-bad-{}", std::process::id()));
        let p = dir.join("x.mp3");
        let e = write_mp3(&p, &[0.0; 100], &[0.0; 100], 48_000, 100, None).unwrap_err();
        assert_eq!(e, "MP3 bitrate 100 kbps is not supported: use 128, 192, 256 or 320");
        assert!(!p.exists() && !part_path(&p).exists() && !dir.exists());
    }

    fn sink_like_tag() -> Vec<u8> {
        let mut body = Vec::new();
        let tflt: &[u8] = &[1, 0xFF, 0xFE, b'M', 0, b'P', 0, b'G', 0, b'/', 0, b'3', 0, 0, 0];
        body.extend_from_slice(b"TFLT");
        body.extend_from_slice(&(tflt.len() as u32).to_be_bytes());
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(tflt);
        let mut comm = vec![0u8];
        comm.extend_from_slice(b"engiTunSMPB\0 00000000 000002a0 00000780 0000000000017700\0");
        body.extend_from_slice(b"COMM");
        body.extend_from_slice(&(comm.len() as u32).to_be_bytes());
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(&comm);
        body.extend(std::iter::repeat_n(0u8, 64));
        let n = body.len() as u32;
        let mut tag = b"ID3\x03\x00\x00".to_vec();
        tag.extend_from_slice(&[(n >> 21) as u8 & 0x7F, (n >> 14) as u8 & 0x7F, (n >> 7) as u8 & 0x7F, n as u8 & 0x7F]);
        tag.extend_from_slice(&body);
        tag
    }

    #[test]
    fn id3v2_tags_are_measured_and_itunsmpb_read() {
        let tag = sink_like_tag();
        assert_eq!(id3v2_len(&tag), Some(tag.len() as u64));
        assert_eq!(itunsmpb(&tag).as_deref(), Some(" 00000000 000002a0 00000780 0000000000017700"));
        let mut comm = vec![1u8];
        comm.extend_from_slice(b"eng");
        for part in ["iTunSMPB", " 00000000 00000210"] {
            comm.extend_from_slice(&[0xFF, 0xFE]);
            comm.extend(part.encode_utf16().flat_map(|u| u.to_le_bytes()));
            comm.extend_from_slice(&[0, 0]);
        }
        let mut v4 = b"ID3\x04\x00\x00\x00\x00\x00\x00COMM".to_vec();
        let n = comm.len() as u32;
        v4.extend_from_slice(&[(n >> 21) as u8 & 0x7F, (n >> 14) as u8 & 0x7F, (n >> 7) as u8 & 0x7F, n as u8 & 0x7F, 0, 0]);
        v4.extend_from_slice(&comm);
        let size = (v4.len() - 10) as u32;
        v4[6..10].copy_from_slice(&[(size >> 21) as u8 & 0x7F, (size >> 14) as u8 & 0x7F, (size >> 7) as u8 & 0x7F, size as u8 & 0x7F]);
        assert_eq!(itunsmpb(&v4).as_deref(), Some(" 00000000 00000210"));
        assert_eq!(id3v2_len(&[0xFF, 0xFB, 0xE4, 0x40, 0, 0, 0, 0, 0, 0]), None);
        assert_eq!(id3v2_len(b"ID3"), None);
        assert_eq!(itunsmpb(&tag[..20]), None);
        assert_eq!(itunsmpb(b"ID3\x03\x00\x00\x00\x00\x00\x0A\0\0\0\0\0\0\0\0\0\0"), None);
    }

    #[test]
    fn strip_removes_only_the_leading_tag() {
        let dir = std::env::temp_dir().join(format!("krypt-mp3-strip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (src, dst) = (dir.join("a.bin"), dir.join("b.bin"));
        let frames: Vec<u8> = (0..5000u32).map(|i| (i * 7) as u8).collect();
        let mut file = sink_like_tag();
        file.extend_from_slice(&frames);
        std::fs::write(&src, &file).unwrap();
        let (n, info) = strip_id3v2(&src, &dst).unwrap();
        assert_eq!(n as usize, file.len() - frames.len());
        assert!(info.unwrap().starts_with(" 00000000 000002a0"));
        assert_eq!(std::fs::read(&dst).unwrap(), frames);
        std::fs::write(&src, &frames).unwrap();
        assert_eq!(strip_id3v2(&src, &dst).unwrap(), (0, None));
        assert_eq!(std::fs::read(&dst).unwrap(), frames);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(all(windows, feature = "mediafoundation"))]
    mod media_foundation {
        use super::*;
        use crate::decode::{decode_file, decode_mf};
        use crate::SampleData;

        fn encoder() -> bool {
            match check_encoder() {
                Ok(()) => true,
                Err(e) => {
                    assert_eq!(e, ENCODER_MISSING);
                    eprintln!("SKIPPED: {e}");
                    false
                }
            }
        }

        fn temp_dir(name: &str) -> PathBuf {
            let d = std::env::temp_dir().join(format!("krypt-mp3-test-{}-{name}", std::process::id()));
            std::fs::create_dir_all(&d).unwrap();
            d
        }

        fn tone(hz: f64, sr: u32, n: usize, amp: f64) -> Vec<f32> {
            (0..n).map(|i| (amp * (2.0 * std::f64::consts::PI * hz * i as f64 / sr as f64).sin()) as f32).collect()
        }

        fn mid(x: &[f32], len: usize) -> &[f32] {
            &x[len / 4..len * 3 / 4]
        }

        fn freq(x: &[f32], sr: f32) -> f32 {
            x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count() as f32 * sr / x.len() as f32
        }

        fn rms_db(x: &[f32]) -> f64 {
            10.0 * (x.iter().map(|&v| v as f64 * v as f64).sum::<f64>() / x.len() as f64).log10()
        }

        fn frames(bytes: &[u8]) -> (usize, Vec<u32>, Vec<u32>) {
            let (mut pos, mut n, mut kb, mut sr) = (0usize, 0usize, Vec::new(), Vec::new());
            while pos < bytes.len() {
                assert!(pos + 4 <= bytes.len(), "trailing bytes at {pos}");
                let h = u32::from_be_bytes([bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]]);
                assert_eq!(h >> 21, 0x7FF, "frame sync at {pos} (no tags, no junk)");
                assert_eq!((h >> 19) & 3, 3, "MPEG-1");
                assert_eq!((h >> 17) & 3, 1, "Layer III");
                let k = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0][((h >> 12) & 0xF) as usize];
                let r = [44_100, 48_000, 32_000, 0][((h >> 10) & 3) as usize];
                assert!(k > 0 && r > 0, "valid header at {pos}");
                if !kb.contains(&k) {
                    kb.push(k);
                }
                if !sr.contains(&r) {
                    sr.push(r);
                }
                pos += (144 * k * 1000 / r + ((h >> 9) & 1)) as usize;
                n += 1;
            }
            assert_eq!(pos, bytes.len(), "the last frame is complete");
            (n, kb, sr)
        }

        fn ffprobe() -> Option<PathBuf> {
            if let Some(p) = std::env::var_os("FFPROBE").map(PathBuf::from).filter(|p| p.is_file()) {
                return Some(p);
            }
            let on_path = std::process::Command::new("ffprobe").arg("-version").output().ok()?;
            on_path.status.success().then(|| PathBuf::from("ffprobe"))
        }

        fn probe(path: &Path) -> Option<serde_json::Value> {
            let exe = ffprobe()?;
            let out = std::process::Command::new(exe)
                .args(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels,bit_rate,duration", "-of", "json"])
                .arg(path)
                .output()
                .ok()?;
            let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
            v["streams"][0].as_object().map(|o| serde_json::Value::Object(o.clone()))
        }

        fn check_roundtrip(dir: &Path, sr: u32, kbps: u32, secs: f64) -> Mp3Info {
            let n = (secs * sr as f64) as usize;
            let (l, r) = (tone(1000.0, sr, n, 0.5), tone(1500.0, sr, n, 0.5));
            let p = dir.join(format!("tone-{sr}-{kbps}.mp3"));
            let info = write_mp3(&p, &l, &r, sr, kbps, None).unwrap();
            let what = format!("{sr} Hz / {kbps} kbps");
            let rate = encode_rate(sr);
            assert_eq!((info.sample_rate, info.kbps), (rate, kbps), "{what}");
            let n_out = (n as f64 * rate as f64 / sr as f64).round() as usize;
            assert_eq!(info.frames, n_out, "{what}");
            let delay = info.encoder_delay.expect("the sink reports its encoder delay") as usize;
            assert!(delay < 2304, "{what}: delay {delay}");
            assert!(info.stripped_tag_bytes > 0, "{what}: the sink's ID3 tag was removed");
            let bytes = std::fs::read(&p).unwrap();
            assert_eq!(bytes.len() as u64, info.bytes);
            let (count, kb, rates) = frames(&bytes);
            assert_eq!((kb, rates), (vec![kbps], vec![rate]), "{what}: CBR at the asked bitrate and rate");
            assert_eq!(count, info.mpeg_frames, "{what}");
            let pcm_frames = count * 1152;
            assert!(pcm_frames >= n_out + delay + 529 && pcm_frames <= n_out + delay + TAIL_PAD + 2 * 1152, "{what}: {count} frames for {n_out} samples");
            let g: Vec<u64> = info.itunsmpb.as_deref().unwrap().split_whitespace().map(|h| u64::from_str_radix(h, 16).unwrap()).collect();
            assert_eq!((g[1], g[3], g[1] + g[2] + g[3]), (delay as u64, n_out as u64, pcm_frames as u64), "{what}: {:?}", info.itunsmpb);
            for (dec, d, extra) in [("Media Foundation", decode_mf(&p).unwrap(), delay), ("symphonia", decode_file(&p).unwrap(), delay + 529)] {
                let what = format!("{what} ({dec})");
                check_decoded(&d, rate, n_out, extra, &what);
            }
            if let Some(v) = probe(&p) {
                eprintln!("ffprobe {what}: {v}");
                assert_eq!(v["codec_name"], "mp3", "{what}");
                assert_eq!(v["sample_rate"].as_str().and_then(|s| s.parse::<u32>().ok()), Some(rate), "{what}");
                assert_eq!(v["channels"], 2, "{what}");
                assert_eq!(v["bit_rate"].as_str().and_then(|s| s.parse::<u32>().ok()), Some(kbps * 1000), "{what}");
                let dur = v["duration"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap();
                assert!((dur - pcm_frames as f64 / rate as f64).abs() < 0.03, "{what}: ffprobe duration {dur}");
            }
            info
        }

        fn check_decoded(d: &SampleData, rate: u32, n: usize, delay: usize, what: &str) {
            assert_eq!((d.sample_rate, d.channels.len()), (rate as f32, 2), "{what}");
            let len = d.frames();
            assert!(len >= n + delay && len <= n + delay + TAIL_PAD + 2 * 1152, "{what}: {len} frames for {n} written + {delay} delay");
            let (l, r) = (&d.channels[0][delay..delay + n], &d.channels[1][delay..delay + n]);
            let fl = freq(mid(l, n), rate as f32);
            let fr = freq(mid(r, n), rate as f32);
            assert!((fl - 1000.0).abs() < 2.0 && (fr - 1500.0).abs() < 2.0, "{what}: {fl} / {fr} Hz");
            let want = 20.0 * (0.5f64 / 2f64.sqrt()).log10();
            for (c, x) in [("L", l), ("R", r)] {
                let db = rms_db(mid(x, n));
                assert!((db - want).abs() < 0.5, "{what}: {c} rms {db:.2} dB, want {want:.2}");
            }
        }

        #[test]
        fn every_bitrate_at_44k1_and_48k() {
            if !encoder() {
                return;
            }
            let dir = temp_dir("bitrates");
            for sr in [44_100u32, 48_000] {
                for kbps in BITRATES_KBPS {
                    let info = check_roundtrip(&dir, sr, kbps, 2.0);
                    eprintln!("{sr} Hz {kbps} kbps: {} bytes, {} MPEG frames, delay {:?}, end padding {:?}, sink tag {} bytes
  sink iTunSMPB {:?}
  ours          {:?}", info.bytes, info.mpeg_frames, info.encoder_delay, info.end_padding, info.stripped_tag_bytes, info.sink_itunsmpb, info.itunsmpb);
                }
            }
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn other_rates_are_resampled() {
            if !encoder() {
                return;
            }
            let dir = temp_dir("rates");
            for (sr, want) in [(96_000u32, 48_000u32), (88_200, 44_100), (22_050, 44_100), (32_000, 32_000)] {
                let info = check_roundtrip(&dir, sr, 192, 1.5);
                assert_eq!(info.sample_rate, want);
            }
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn encoder_delay_matches_itunsmpb() {
            if !encoder() {
                return;
            }
            let dir = temp_dir("delay");
            for sr in [44_100u32, 48_000] {
                let at = sr as usize / 4;
                let n = sr as usize;
                let mut x = vec![0f32; n];
                x[at..].copy_from_slice(&tone(1000.0, sr, n - at, 0.5));
                let p = dir.join(format!("onset-{sr}.mp3"));
                let info = write_mp3(&p, &x, &x, sr, 320, None).unwrap();
                let delay = info.encoder_delay.unwrap() as i64;
                for (dec, d, extra) in [("Media Foundation", decode_mf(&p).unwrap(), 1i64), ("symphonia", decode_file(&p).unwrap(), 529)] {
                    let onset = d.channels[0].iter().position(|v| v.abs() > 0.05).unwrap() as i64;
                    eprintln!("{sr} Hz, {dec}: onset at {onset} (written at {at}): +{} samples ({:.1} ms); iTunSMPB delay {delay}", onset - at as i64, (onset - at as i64) as f64 * 1000.0 / sr as f64);
                    assert!((onset - at as i64 - delay - extra - 1).abs() <= 1, "{sr} Hz {dec}: onset {onset}");
                }
            }
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn encoder_check_is_stable() {
            let first = check_encoder();
            assert_eq!(check_encoder(), first);
            if let Err(e) = first {
                assert_eq!(e, ENCODER_MISSING);
            }
        }

        #[test]
        fn atomic_replace_cancel_and_folders() {
            if !encoder() {
                return;
            }
            let dir = temp_dir("atomic");
            let sr = 48_000;
            let x = tone(440.0, sr, sr as usize, 0.25);
            let p = dir.join("a").join("b").join("song.mp3");
            write_mp3(&p, &x, &x, sr, 128, None).unwrap();
            let first = std::fs::metadata(&p).unwrap().len();
            write_mp3(&p, &x[..sr as usize / 2], &x[..sr as usize / 2], sr, 128, None).unwrap();
            assert!(std::fs::metadata(&p).unwrap().len() < first, "replaced");
            let leftovers = |d: &Path| std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".part")).collect::<Vec<_>>();
            assert!(leftovers(p.parent().unwrap()).is_empty());
            let cancel = AtomicBool::new(true);
            let e = write_mp3(&p, &x, &x, sr, 128, Some(&cancel)).unwrap_err();
            assert_eq!(e, "Render cancelled");
            assert!(p.is_file() && leftovers(p.parent().unwrap()).is_empty());
            let blocked = dir.join("song.mp3").join("x.mp3");
            std::fs::write(dir.join("song.mp3"), b"x").unwrap();
            let e = write_mp3(&blocked, &x, &x, sr, 128, None).unwrap_err();
            assert!(e.starts_with("Cannot create folder") && e.contains("song.mp3"), "{e}");
            write_mp3(&dir.join("silence.mp3"), &[0.0; 4800], &[0.0; 4800], sr, 320, None).unwrap();
            let one = write_mp3(&dir.join("one.mp3"), &[0.5], &[0.5], sr, 320, None).unwrap();
            assert!(one.bytes > 0);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn the_last_samples_survive_any_length() {
            if !encoder() {
                return;
            }
            let dir = temp_dir("lengths");
            let sr = 48_000u32;
            let mut lens = vec![1usize, 100, 1152, 1500, 2304, 16_384, 16_384 + 614, 49_152 + 614, 66_150, 66_151];
            lens.extend((0..12).map(|k| 20_000 + k * 2_977));
            for n in lens {
                let burst = n.min(960);
                let mut x = vec![0f32; n];
                x[n - burst..].copy_from_slice(&tone(1000.0, sr, burst, 0.5));
                let p = dir.join(format!("len-{n}.mp3"));
                let info = write_mp3(&p, &x, &x, sr, 192, None).unwrap();
                let delay = info.encoder_delay.unwrap() as usize;
                assert!(info.mpeg_frames * 1152 >= n + delay + 529, "n={n}: {} frames", info.mpeg_frames);
                assert_eq!(info.mpeg_frames * 1152, delay + n + info.end_padding.unwrap() as usize);
                let d = decode_mf(&p).unwrap();
                let (a, b) = (n - burst + delay, (n + delay).min(d.frames()));
                assert!(d.frames() >= n + delay, "n={n}: decoded {} frames", d.frames());
                if burst >= 100 {
                    let e = d.channels[0][a..b].iter().map(|v| v * v).sum::<f32>() / burst as f32;
                    assert!(e > 0.5 * 0.125, "n={n}: burst energy {e} (decoded {} frames)", d.frames());
                }
            }
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        #[ignore]
        fn perf_three_minutes() {
            if !encoder() {
                return;
            }
            let dir = temp_dir("perf");
            for (sr, kbps) in [(48_000u32, 320u32), (44_100, 320), (44_100, 128), (96_000, 320)] {
                let n = sr as usize * 180;
                let l: Vec<f32> = (0..n)
                    .map(|i| {
                        let t = i as f64 / sr as f64;
                        let w = |hz: f64| (2.0 * std::f64::consts::PI * hz * t).sin();
                        (0.2 * w(220.0) + 0.15 * w(277.2) + 0.1 * w(3300.0) * (1.0 + (t * 3.0).sin())) as f32
                    })
                    .collect();
                let r: Vec<f32> = l.iter().rev().copied().collect();
                let p = dir.join(format!("perf-{sr}-{kbps}.mp3"));
                let t0 = std::time::Instant::now();
                let info = write_mp3(&p, &l, &r, sr, kbps, None).unwrap();
                eprintln!("PERF 3 min stereo {sr} Hz -> MP3 {kbps} kbps: {:.2} s ({} bytes)", t0.elapsed().as_secs_f64(), info.bytes);
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
