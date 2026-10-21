//! `tts`: Krypt Voice local text → speech with Kokoro-82M (research/21).
//! Contract: docs/ANALYZER_PROTOCOL.md § Text to speech.
//!
//! text → sentences → G2P (g2p.rs, English, no GPL) → Kokoro token ids
//! (vocab.rs) → one inference per sentence (kokoro.rs; sentences over
//! [`MAX_CHUNK`] tokens are split at punctuation) → edge silence trimmed →
//! joined with short pauses → mono 24 kHz WAV, with word timings from the
//! model's predicted durations.

pub mod g2p;
pub mod kokoro;
pub mod lts;
pub mod numbers;
pub mod vocab;

use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::protocol::{TtsArgs, TtsResult, WordTiming};
use crate::separate::runtime::{self, Device};
use crate::{JobCtx, JobError};

use g2p::{Phonemized, WordSpan};

/// Tokens per inference. Kokoro's context is 510; it rushes past ~400.
pub const MAX_CHUNK: usize = 400;
/// Pause after a sentence / after a clause split (seconds).
const SENTENCE_PAUSE: f32 = 0.22;
const CLAUSE_PAUSE: f32 = 0.12;
/// Silence kept around each trimmed chunk (seconds).
const EDGE_KEEP: f32 = 0.03;

/// The English voices of Kokoro-82M v1.0 (what the Model Manager installs):
/// (id, display name, description). a* = US English, b* = UK English.
pub const ENGLISH_VOICES: [(&str, &str, &str); 28] = [
    ("af_heart", "Heart", "US English · female · warm (best)"),
    ("af_bella", "Bella", "US English · female · bright"),
    ("af_nicole", "Nicole", "US English · female · soft, close"),
    ("af_aoede", "Aoede", "US English · female"),
    ("af_kore", "Kore", "US English · female"),
    ("af_sarah", "Sarah", "US English · female"),
    ("af_alloy", "Alloy", "US English · female"),
    ("af_nova", "Nova", "US English · female"),
    ("af_sky", "Sky", "US English · female"),
    ("af_jessica", "Jessica", "US English · female"),
    ("af_river", "River", "US English · female"),
    ("am_michael", "Michael", "US English · male"),
    ("am_fenrir", "Fenrir", "US English · male · deep"),
    ("am_puck", "Puck", "US English · male · lively"),
    ("am_echo", "Echo", "US English · male"),
    ("am_eric", "Eric", "US English · male"),
    ("am_liam", "Liam", "US English · male"),
    ("am_onyx", "Onyx", "US English · male · low"),
    ("am_adam", "Adam", "US English · male"),
    ("am_santa", "Santa", "US English · male · jolly"),
    ("bf_emma", "Emma", "UK English · female"),
    ("bf_isabella", "Isabella", "UK English · female"),
    ("bf_alice", "Alice", "UK English · female"),
    ("bf_lily", "Lily", "UK English · female"),
    ("bm_george", "George", "UK English · male"),
    ("bm_fable", "Fable", "UK English · male"),
    ("bm_lewis", "Lewis", "UK English · male"),
    ("bm_daniel", "Daniel", "UK English · male"),
];

fn fail(m: impl Into<String>) -> JobError {
    JobError::Failed(m.into())
}

/// `<dir>/<voice>.bin` (Model Manager layout) or `<dir>/voices/<voice>.bin` (a copy of the HF repo).
pub fn voice_file(dir: &Path, voice: &str) -> Option<PathBuf> {
    [dir.join(format!("{voice}.bin")), dir.join("voices").join(format!("{voice}.bin"))].into_iter().find(|p| p.is_file())
}

/// The voice's style table: rows of 256 floats (510 rows in v1.0).
pub fn load_voice(path: &Path) -> Result<Vec<f32>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read the voice file {}: {e}", path.display()))?;
    if bytes.is_empty() || bytes.len() % (4 * kokoro::STYLE_DIM) != 0 {
        return Err(format!("{} is not a Kokoro voice file (unexpected size {} bytes)", path.display(), bytes.len()));
    }
    Ok(bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect())
}

/// Style vector for an utterance of `n_tokens` (without pads).
pub fn style_for(table: &[f32], n_tokens: usize) -> &[f32] {
    let rows = table.len() / kokoro::STYLE_DIM;
    let r = n_tokens.min(rows.saturating_sub(1));
    &table[r * kokoro::STYLE_DIM..(r + 1) * kokoro::STYLE_DIM]
}

/// Splits a caller-supplied phoneme string at sentence punctuation.
fn phoneme_chunks(ph: &str) -> Vec<Phonemized> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = ph.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        cur.push(c);
        if matches!(c, '.' | '!' | '?') && chars.get(i + 1).is_none_or(|n| *n == ' ') {
            if !cur.trim().is_empty() {
                out.push(Phonemized { phonemes: cur.trim().to_string(), words: Vec::new() });
            }
            cur.clear();
        }
    }
    if !cur.trim().is_empty() {
        out.push(Phonemized { phonemes: cur.trim().to_string(), words: Vec::new() });
    }
    out.into_iter().flat_map(|p| g2p::split_long(p, MAX_CHUNK)).collect()
}

/// Text → chunks for inference (each ≤ MAX_CHUNK tokens), with word spans.
pub fn text_chunks(text: &str) -> Vec<Phonemized> {
    g2p::sentences(text).iter().map(|s| g2p::phonemize(s)).filter(|p| !p.phonemes.trim().is_empty()).flat_map(|p| g2p::split_long(p, MAX_CHUNK)).collect()
}

/// First / last sample above the trim threshold, widened by EDGE_KEEP.
fn trim_bounds(x: &[f32]) -> (usize, usize) {
    let peak = x.iter().fold(0f32, |m, v| m.max(v.abs()));
    if peak <= 0.0 {
        return (0, 0);
    }
    let thr = (peak * 0.02).max(1e-4);
    let first = x.iter().position(|v| v.abs() > thr).unwrap_or(0);
    let last = x.iter().rposition(|v| v.abs() > thr).map_or(x.len(), |i| i + 1);
    let keep = (EDGE_KEEP * kokoro::SAMPLE_RATE as f32) as usize;
    (first.saturating_sub(keep), (last + keep).min(x.len()))
}

/// Word timings (in samples of this chunk's raw waveform) from per-token durations.
/// `src[t]` = character index of token t (no pads); `dur` has one entry per id incl. pads.
pub fn word_samples(words: &[WordSpan], src: &[usize], dur: &[f32], wav_len: usize) -> Vec<(String, usize, usize)> {
    let total: f64 = dur.iter().map(|&d| f64::from(d.max(0.0))).sum();
    if total <= 0.0 || wav_len == 0 {
        return Vec::new();
    }
    let spf = wav_len as f64 / total; // ≈ SAMPLES_PER_FRAME
    let mut cum = Vec::with_capacity(dur.len() + 1);
    cum.push(0f64);
    for &d in dur {
        cum.push(cum.last().copied().unwrap_or(0.0) + f64::from(d.max(0.0)));
    }
    let mut out = Vec::new();
    for w in words {
        let first = src.iter().position(|&c| c >= w.start && c < w.end);
        let last = src.iter().rposition(|&c| c >= w.start && c < w.end);
        if let (Some(a), Some(b)) = (first, last) {
            // token t ↔ dur[t + 1] (dur[0] is the leading pad)
            let s = (cum[a + 1] * spf).round() as usize;
            let e = (cum[b + 2] * spf).round() as usize;
            out.push((w.text.clone(), s.min(wav_len), e.min(wav_len)));
        }
    }
    out
}

fn check_voice_id(voice: &str) -> Result<(), JobError> {
    if voice.is_empty() || voice.len() > 40 || !voice.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
        return Err(fail(format!("'{voice}' is not a Kokoro voice id (e.g. af_heart)")));
    }
    Ok(())
}

pub fn run(args: &TtsArgs, ctx: &JobCtx) -> Result<TtsResult, JobError> {
    let started = Instant::now();
    let speed = args.speed.unwrap_or(1.0);
    if !(0.5..=2.0).contains(&speed) {
        return Err(fail(format!("Speed {speed} is out of range (0.5 to 2)")));
    }
    let voice = args.voice.trim().strip_prefix("local:").unwrap_or(args.voice.trim());
    check_voice_id(voice)?;
    let custom = args.phonemes.as_deref().map(str::trim).filter(|p| !p.is_empty());
    if custom.is_none() && !(voice.starts_with('a') || voice.starts_with('b')) {
        return Err(fail(format!(
            "The local engine speaks English only, and '{voice}' is not an English voice. Pick an English voice (af_…, am_…, bf_…, bm_…) or use the Fish engine (Cloud) for other languages."
        )));
    }
    let dir = Path::new(&args.model_dir);
    let model = kokoro::model_file(dir).ok_or_else(|| fail(format!("Kokoro is not installed in {} (no model file). Install \"Kokoro (Krypt Voice)\" from the Model Manager.", dir.display())))?;
    let vfile = voice_file(dir, voice).ok_or_else(|| fail(format!("The voice '{voice}' is not installed with Kokoro (no {voice}.bin in {}). Reinstall Kokoro from the Model Manager.", dir.display())))?;
    let table = load_voice(&vfile)?;

    ctx.progress("phonemes", -1.0);
    let chunks = match custom {
        Some(p) => phoneme_chunks(p),
        None => {
            if args.text.trim().is_empty() {
                return Err(fail("Nothing to say: the text is empty"));
            }
            g2p::ensure_dict()?;
            text_chunks(&args.text)
        }
    };
    let encoded: Vec<(Vec<i64>, Vec<usize>, &Phonemized)> = chunks
        .iter()
        .map(|c| {
            let (ids, src) = vocab::encode(&c.phonemes);
            (ids, src, c)
        })
        .filter(|(ids, _, _)| ids.iter().any(|&t| t != 16))
        .collect();
    if encoded.is_empty() {
        return Err(fail("Nothing to say: the text has no words Krypt Voice can pronounce"));
    }
    ctx.check()?;
    runtime::runtime().map_err(|e| fail(format!("Krypt Voice (local) is unavailable: {e}")))?;

    ctx.progress("speaking", 0.0);
    let sr = kokoro::SAMPLE_RATE as f32;
    let mut out: Vec<f32> = Vec::new();
    let mut words: Vec<WordTiming> = Vec::new();
    let mut infer_ms = 0u128;
    let n = encoded.len();
    let (_, load_ms) = kokoro::with_model(&model, Device::Cpu, |m| {
        for (i, (ids, src, chunk)) in encoded.iter().enumerate() {
            if ctx.cancelled() {
                return Err("cancelled".into());
            }
            let mut padded = Vec::with_capacity(ids.len() + 2);
            padded.push(vocab::PAD);
            padded.extend_from_slice(ids);
            padded.push(vocab::PAD);
            let style = style_for(&table, ids.len());
            let t = Instant::now();
            let (wav, dur) = m.infer(&padded, style, speed)?;
            infer_ms += t.elapsed().as_millis();
            let (a, b) = trim_bounds(&wav);
            if b > a {
                if !out.is_empty() {
                    let prev_end = encoded[i - 1].2.phonemes.trim_end().chars().last();
                    let pause = if matches!(prev_end, Some('.' | '!' | '?' | '…')) { SENTENCE_PAUSE } else { CLAUSE_PAUSE };
                    out.resize(out.len() + (pause * sr) as usize, 0.0);
                }
                let offset = out.len();
                if let Some(d) = &dur {
                    for (text, s, e) in word_samples(&chunk.words, src, d, wav.len()) {
                        let s = s.clamp(a, b) - a + offset;
                        let e = e.clamp(a, b) - a + offset;
                        words.push(WordTiming { text, start_sec: s as f32 / sr, end_sec: e.max(s) as f32 / sr });
                    }
                }
                out.extend_from_slice(&wav[a..b]);
            }
            ctx.progress("speaking", (i + 1) as f32 / n as f32);
        }
        Ok(())
    })
    .map_err(|e| if ctx.cancelled() { JobError::Cancelled } else { fail(format!("Speech synthesis failed: {e}")) })?;
    ctx.check()?;
    // Never clip.
    let peak = out.iter().fold(0f32, |m, v| m.max(v.abs()));
    if peak > 0.99 {
        let g = 0.99 / peak;
        out.iter_mut().for_each(|v| *v *= g);
    }
    ctx.progress("writing", -1.0);
    crate::wav::write_mono(&args.out, &out, kokoro::SAMPLE_RATE)?;
    let duration = out.len() as f32 / sr;
    ctx.log(
        "info",
        format!(
            "Kokoro ({}): {:.1} s of speech in {:.1} s (model load {load_ms} ms, inference {infer_ms} ms, {n} chunk(s))",
            model.file_name().unwrap_or_default().to_string_lossy(),
            duration,
            started.elapsed().as_secs_f32()
        ),
    );
    let phonemes = encoded.iter().map(|e| e.2.phonemes.as_str()).collect::<Vec<_>>().join(" ");
    Ok(TtsResult { path: args.out.clone(), duration_sec: duration, sample_rate: kokoro::SAMPLE_RATE, words, phonemes })
}

#[cfg(test)]
mod tests;
