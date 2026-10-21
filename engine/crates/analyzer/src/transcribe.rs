//! `transcribe`: audio → notes (Basic Pitch polyphonic, pYIN-style
//! monophonic) or drum hits (band-split onsets).

use std::path::PathBuf;

use crate::audio::{self, ANALYSIS_SR};
use crate::protocol::{TranscribeArgs, TranscribeMode, TranscriptionResult};
use crate::{basic_pitch, drums, lowline, pitch, JobCtx, JobError};

/// Defaults per mode (0..1, higher = fewer notes).
pub const POLY_ONSET_THRESHOLD: f32 = 0.5;
pub const POLY_FRAME_THRESHOLD: f32 = 0.3;
pub const MONO_ONSET_THRESHOLD: f32 = 0.5;
pub const MONO_FRAME_THRESHOLD: f32 = 0.3;
pub const DRUM_ONSET_THRESHOLD: f32 = 0.3;
pub const DEFAULT_MIN_NOTE_MS: f32 = 60.0;

fn check_unit(name: &str, v: Option<f32>) -> Result<(), JobError> {
    match v {
        Some(x) if !(0.0..=1.0).contains(&x) => Err(JobError::Failed(format!("{name} must be between 0 and 1 (got {x})"))),
        _ => Ok(()),
    }
}

fn validate(args: &TranscribeArgs) -> Result<(u8, u8), JobError> {
    check_unit("onsetThreshold", args.onset_threshold)?;
    check_unit("frameThreshold", args.frame_threshold)?;
    if let Some(m) = args.min_note_ms {
        if !(m.is_finite() && (0.0..=10_000.0).contains(&m)) {
            return Err(JobError::Failed(format!("minNoteMs must be between 0 and 10000 (got {m})")));
        }
    }
    let lo = args.min_key.unwrap_or(0);
    let hi = args.max_key.unwrap_or(127);
    if lo > 127 || hi > 127 || lo > hi {
        return Err(JobError::Failed(format!("The key range {lo}..{hi} is invalid (MIDI keys 0..127, minKey ≤ maxKey)")));
    }
    Ok((lo, hi))
}

pub fn run(args: &TranscribeArgs, ctx: &JobCtx) -> Result<TranscriptionResult, JobError> {
    validate(args)?;
    if args.mode == TranscribeMode::Poly && args.model_dir.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err(JobError::Failed("Polyphonic transcription needs the Basic Pitch model, but no model directory was given".into()));
    }
    ctx.progress("decoding", -1.0);
    let data = audio::load(&args.path)?;
    ctx.check()?;
    let x = audio::analysis_mono(&data);
    ctx.check()?;
    transcribe_signal(&x, args, ctx)
}

/// Transcribe mono audio already at 22 050 Hz.
pub fn transcribe_signal(x: &[f32], args: &TranscribeArgs, ctx: &JobCtx) -> Result<TranscriptionResult, JobError> {
    let (min_key, max_key) = validate(args)?;
    let sr = ANALYSIS_SR as f32;
    let min_note_ms = args.min_note_ms.unwrap_or(DEFAULT_MIN_NOTE_MS);
    ctx.progress("transcribing", 0.0);
    let res = match args.mode {
        TranscribeMode::Poly => {
            let dir = PathBuf::from(args.model_dir.as_deref().unwrap_or("").trim());
            if dir.as_os_str().is_empty() {
                return Err(JobError::Failed("Polyphonic transcription needs the Basic Pitch model, but no model directory was given".into()));
            }
            let act = basic_pitch::infer(&dir, x, ctx, |f| ctx.progress("transcribing", 0.9 * f))?;
            ctx.check()?;
            let params = basic_pitch::NoteParams {
                onset_thresh: args.onset_threshold.unwrap_or(POLY_ONSET_THRESHOLD),
                frame_thresh: args.frame_threshold.unwrap_or(POLY_FRAME_THRESHOLD),
                min_note_len: basic_pitch::min_len_frames(min_note_ms),
                min_key: min_key.max(21),
                max_key: max_key.min(108),
            };
            TranscriptionResult { mode: TranscribeMode::Poly, notes: basic_pitch::notes(&act, &params), hits: Vec::new(), source: "basic-pitch".into() }
        }
        TranscribeMode::Mono => {
            // Search G#0 (26 Hz, so 808s down to A0 are found)..C7 (or wider
            // if asked) and filter by key afterwards: narrowing the search
            // would fold out-of-range notes an octave.
            let hz = |k: f32| 440.0 * 2f32.powf((k - 69.0) / 12.0);
            let fmin = hz((min_key.min(21) as f32 - 1.0).max(20.0));
            let fmax = hz((max_key.max(96) as f32 + 1.0).min(109.0)).min(sr * 0.25);
            let tr = pitch::track(x, sr, fmin, fmax.max(fmin * 2.0), ctx)?;
            ctx.progress("transcribing", 0.8);
            ctx.check()?;
            let onset = args.onset_threshold.unwrap_or(MONO_ONSET_THRESHOLD);
            let params = pitch::SegParams {
                voicing: args.frame_threshold.unwrap_or(MONO_FRAME_THRESHOLD),
                reattack_db: 3.0 + 9.0 * onset,
                min_note_sec: min_note_ms / 1000.0,
                min_key,
                max_key,
            };
            let mut notes = pitch::segment(&tr, &params);
            // Low lines (bass, 808): the fast-segmenting reader (lowline.rs) covers the notes pYIN leaves holes in.
            if lowline::is_low(&notes) {
                let low = lowline::segment(x, sr, &tr, &params, ctx)?;
                if !low.is_empty() {
                    notes = low;
                }
            }
            TranscriptionResult { mode: TranscribeMode::Mono, notes, hits: Vec::new(), source: "pyin".into() }
        }
        TranscribeMode::Drums => {
            let params = drums::DrumParams { sensitivity: args.onset_threshold.unwrap_or(DRUM_ONSET_THRESHOLD) };
            TranscriptionResult { mode: TranscribeMode::Drums, notes: Vec::new(), hits: drums::transcribe(x, sr, &params, ctx)?, source: "onsets".into() }
        }
    };
    ctx.progress("transcribing", 1.0);
    Ok(res)
}
