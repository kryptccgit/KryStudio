//! Polyphonic transcription with Spotify's Basic Pitch (ICASSP 2022 model,
//! `nmp.onnx`).
//!
//! Model windowing and the note post-processing below are ported from the
//! Apache-2.0 reference implementation (spotify/basic-pitch:
//! `basic_pitch/inference.py`, `basic_pitch/note_creation.py`),
//! Copyright 2022 Spotify AB, licensed under the Apache License 2.0. Changes
//! from the reference: frame times are computed exactly from each window's
//! hop (the reference approximates with a per-172-frame correction), the
//! melodia loop visits cells in sorted order instead of re-scanning for the
//! maximum (same result), and pitch bends are reduced to a mean offset in
//! cents with sub-bin interpolation.

use std::path::Path;

use crate::onnx::RtenModel;
use crate::protocol::TranscribedNote;
use crate::{JobCtx, JobError};

pub const MODEL_FILE: &str = "nmp.onnx";

const SR: usize = 22_050;
const FFT_HOP: usize = 256;
/// Model input length: 2 s minus one hop.
const AUDIO_N_SAMPLES: usize = SR * 2 - FFT_HOP; // 43 844
const N_OVERLAP_FRAMES: usize = 30;
const OVERLAP_LEN: usize = N_OVERLAP_FRAMES * FFT_HOP; // 7 680
const HOP_SIZE: usize = AUDIO_N_SAMPLES - OVERLAP_LEN; // 36 164
const WINDOW_FRAMES: usize = 172;
const KEEP_FRAMES: usize = WINDOW_FRAMES - N_OVERLAP_FRAMES; // 142
const N_NOTES: usize = 88;
const N_CONTOUR: usize = 264;
const MIDI_OFFSET: usize = 21;
const ENERGY_TOL: usize = 11;
const BATCH: usize = 4;

const OUT_CONTOUR: &str = "StatefulPartitionedCall:0";
const OUT_NOTE: &str = "StatefulPartitionedCall:1";
const OUT_ONSET: &str = "StatefulPartitionedCall:2";

pub struct Activations {
    pub frames: usize,
    /// frames × 88
    pub note: Vec<f32>,
    /// frames × 88
    pub onset: Vec<f32>,
    /// frames × 264 (3 bins per semitone; bin 3·(key−21)+1 is the key's centre)
    pub contour: Vec<f32>,
    /// Time (s) of each frame.
    pub times: Vec<f32>,
}

/// Run the model over 22 050 Hz mono audio (overlapping 2 s windows).
pub fn infer(model_dir: &Path, x: &[f32], ctx: &JobCtx, mut progress: impl FnMut(f32)) -> Result<Activations, JobError> {
    let mut model = RtenModel::load(&model_dir.join(MODEL_FILE), "Basic Pitch")?.with_ctx(ctx);
    let names = model.output_names();
    for want in [OUT_CONTOUR, OUT_NOTE, OUT_ONSET] {
        if !names.iter().any(|n| n == want) {
            return Err(JobError::Failed(format!("{} is not the expected Basic Pitch model (missing output '{want}')", model_dir.join(MODEL_FILE).display())));
        }
    }
    let input = "serving_default_input_2:0";
    let orig_len = x.len();
    // Prepend half the overlap so the first kept frame is t = 0.
    let pad = OVERLAP_LEN / 2;
    let padded_len = orig_len + pad;
    let starts: Vec<usize> = (0..padded_len).step_by(HOP_SIZE).collect();
    let sample = |i: usize| -> f32 {
        if i < pad {
            0.0
        } else {
            x.get(i - pad).copied().unwrap_or(0.0)
        }
    };
    let n_keep_total = ((orig_len as f64 / HOP_SIZE as f64) * KEEP_FRAMES as f64) as usize;
    let mut note = Vec::with_capacity(n_keep_total * N_NOTES);
    let mut onset = Vec::with_capacity(n_keep_total * N_NOTES);
    let mut contour = Vec::with_capacity(n_keep_total * N_CONTOUR);
    let mut times = Vec::with_capacity(n_keep_total);
    let mut buf = Vec::with_capacity(BATCH * AUDIO_N_SAMPLES);
    let half_olap = N_OVERLAP_FRAMES / 2;
    for (bi, chunk) in starts.chunks(BATCH).enumerate() {
        ctx.check()?;
        progress(bi as f32 * BATCH as f32 / starts.len() as f32);
        buf.clear();
        for &s in chunk {
            buf.extend((s..s + AUDIO_N_SAMPLES).map(sample));
        }
        let b = chunk.len();
        let out = model.run_named(&[(input, &[b, AUDIO_N_SAMPLES, 1], &buf)])?;
        let get = |name: &str, width: usize| -> Result<&Vec<f32>, JobError> {
            let (shape, data) = out.get(name).ok_or_else(|| JobError::Failed(format!("Basic Pitch returned no '{name}' output")))?;
            if shape.len() != 3 || shape[0] != b || shape[2] != width || shape[1] < WINDOW_FRAMES {
                return Err(JobError::Failed(format!("Basic Pitch output '{name}' has an unexpected shape {shape:?}")));
            }
            Ok(data)
        };
        let (n_d, o_d, c_d) = (get(OUT_NOTE, N_NOTES)?, get(OUT_ONSET, N_NOTES)?, get(OUT_CONTOUR, N_CONTOUR)?);
        let tf = out[OUT_NOTE].0[1];
        for (w, &start) in chunk.iter().enumerate() {
            for j in half_olap..half_olap + KEEP_FRAMES {
                if times.len() >= n_keep_total {
                    break;
                }
                let r = w * tf + j;
                note.extend_from_slice(&n_d[r * N_NOTES..(r + 1) * N_NOTES]);
                onset.extend_from_slice(&o_d[r * N_NOTES..(r + 1) * N_NOTES]);
                contour.extend_from_slice(&c_d[r * N_CONTOUR..(r + 1) * N_CONTOUR]);
                // Window starts at padded sample `start`; frame j is j hops in.
                times.push((start + j * FFT_HOP) as f32 / SR as f32 - pad as f32 / SR as f32);
            }
        }
    }
    progress(1.0);
    Ok(Activations { frames: times.len(), note, onset, contour, times })
}

pub struct NoteParams {
    pub onset_thresh: f32,
    pub frame_thresh: f32,
    /// Minimum length in frames (a note must be longer than this).
    pub min_note_len: usize,
    /// Inclusive MIDI range.
    pub min_key: u8,
    pub max_key: u8,
}

/// Frames for a minimum note length in ms (reference rounding).
pub fn min_len_frames(ms: f32) -> usize {
    (ms / 1000.0 * (SR as f32 / FFT_HOP as f32)).round().max(0.0) as usize
}

/// Note events (start frame, end frame (exclusive), MIDI key, amplitude).
fn notes_polyphonic(act: &Activations, p: &NoteParams) -> Vec<(usize, usize, usize, f32)> {
    let n = act.frames;
    if n < 3 {
        return Vec::new();
    }
    let frames = &act.note;
    let mut onsets = act.onset.clone();
    let mut frames_c = frames.clone();
    // constrain_frequency (inclusive key range).
    let lo = (p.min_key as usize).saturating_sub(MIDI_OFFSET).min(N_NOTES);
    let hi = ((p.max_key as usize + 1).saturating_sub(MIDI_OFFSET)).min(N_NOTES);
    for t in 0..n {
        for f in (0..lo).chain(hi..N_NOTES) {
            onsets[t * N_NOTES + f] = 0.0;
            frames_c[t * N_NOTES + f] = 0.0;
        }
    }
    let frames = &frames_c;
    // get_infered_onsets (n_diff = 2).
    let mut diff = vec![0f32; n * N_NOTES];
    let mut dmax = 0f32;
    for t in 2..n {
        for f in 0..N_NOTES {
            let cur = frames[t * N_NOTES + f];
            let d1 = cur - frames[(t - 1) * N_NOTES + f];
            let d2 = cur - frames[(t - 2) * N_NOTES + f];
            let d = d1.min(d2).max(0.0);
            diff[t * N_NOTES + f] = d;
            dmax = dmax.max(d);
        }
    }
    let omax = onsets.iter().cloned().fold(0f32, f32::max);
    if dmax > 0.0 {
        let k = omax / dmax;
        for (o, d) in onsets.iter_mut().zip(&diff) {
            *o = o.max(d * k);
        }
    }
    // Peaks along time (strict local maxima, edges excluded) above threshold.
    let mut peaks: Vec<(usize, usize)> = Vec::new();
    for t in 1..n - 1 {
        for f in 0..N_NOTES {
            let v = onsets[t * N_NOTES + f];
            if v >= p.onset_thresh && v > onsets[(t - 1) * N_NOTES + f] && v > onsets[(t + 1) * N_NOTES + f] {
                peaks.push((t, f));
            }
        }
    }
    let mut remaining = frames.clone();
    let mut notes = Vec::new();
    let zero3 = |rem: &mut Vec<f32>, t: usize, f: usize| {
        rem[t * N_NOTES + f] = 0.0;
        if f < N_NOTES - 1 {
            rem[t * N_NOTES + f + 1] = 0.0;
        }
        if f > 0 {
            rem[t * N_NOTES + f - 1] = 0.0;
        }
    };
    // Backwards in time (reference order: time desc, then freq desc).
    for &(start, f) in peaks.iter().rev() {
        if start >= n - 1 {
            continue;
        }
        let mut i = start + 1;
        let mut k = 0;
        while i < n - 1 && k < ENERGY_TOL {
            if remaining[i * N_NOTES + f] < p.frame_thresh {
                k += 1;
            } else {
                k = 0;
            }
            i += 1;
        }
        i -= k;
        if i - start <= p.min_note_len {
            continue;
        }
        for t in start..i {
            zero3(&mut remaining, t, f);
        }
        let amp = (start..i).map(|t| frames[t * N_NOTES + f]).sum::<f32>() / (i - start) as f32;
        notes.push((start, i, f + MIDI_OFFSET, amp));
    }
    // Melodia trick: grow notes from the strongest leftover frames.
    let mut cells: Vec<(usize, f32)> = remaining.iter().enumerate().filter(|(_, &v)| v > p.frame_thresh).map(|(i, &v)| (i, v)).collect();
    cells.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    for (idx, v) in cells {
        if remaining[idx] != v {
            continue; // already consumed by an earlier note
        }
        let (i_mid, f) = (idx / N_NOTES, idx % N_NOTES);
        remaining[idx] = 0.0;
        // forward
        let mut i = i_mid + 1;
        let mut k = 0usize;
        while i < n - 1 && k < ENERGY_TOL {
            if remaining[i * N_NOTES + f] < p.frame_thresh {
                k += 1;
            } else {
                k = 0;
            }
            zero3(&mut remaining, i, f);
            i += 1;
        }
        let i_end = i as i64 - 1 - k as i64;
        // backward
        let mut i = i_mid as i64 - 1;
        let mut k = 0usize;
        while i > 0 && k < ENERGY_TOL {
            let iu = i as usize;
            if remaining[iu * N_NOTES + f] < p.frame_thresh {
                k += 1;
            } else {
                k = 0;
            }
            zero3(&mut remaining, iu, f);
            i -= 1;
        }
        let i_start = i + 1 + k as i64;
        if i_end - i_start <= p.min_note_len as i64 || i_start < 0 {
            continue;
        }
        let (a, b) = (i_start as usize, (i_end as usize).min(n));
        if b <= a {
            continue;
        }
        let amp = (a..b).map(|t| frames[t * N_NOTES + f]).sum::<f32>() / (b - a) as f32;
        notes.push((a, b, f + MIDI_OFFSET, amp));
    }
    notes
}

/// Mean pitch offset of a note in cents from the contour (±25 bins around the
/// key's centre bin, Gaussian-weighted argmax as in the reference, refined by
/// parabolic interpolation). None when the contour is too weak to tell.
fn note_cents(act: &Activations, start: usize, end: usize, key: usize) -> Option<f32> {
    let centre = 3 * (key - MIDI_OFFSET) as i64 + 1;
    let tol = 25i64;
    let mut sum = 0f32;
    let mut wsum = 0f32;
    for t in start..end.min(act.frames) {
        let row = &act.contour[t * N_CONTOUR..(t + 1) * N_CONTOUR];
        let mut best = (centre, f32::MIN);
        for b in (centre - tol).max(0)..=(centre + tol).min(N_CONTOUR as i64 - 1) {
            let g = (-0.5 * ((b - centre) as f32 / 5.0).powi(2)).exp();
            let v = row[b as usize] * g;
            if v > best.1 {
                best = (b, v);
            }
        }
        let b = best.0;
        let raw = row[b as usize];
        if raw < 0.05 {
            continue;
        }
        let off = if b > 0 && (b as usize) < N_CONTOUR - 1 { crate::features::parabolic(row[b as usize - 1], raw, row[b as usize + 1]) } else { 0.0 };
        sum += ((b - centre) as f32 + off) * raw;
        wsum += raw;
    }
    if wsum <= 0.0 {
        None
    } else {
        Some(((sum / wsum) * 100.0 / 3.0).clamp(-50.0, 50.0))
    }
}

pub fn notes(act: &Activations, p: &NoteParams) -> Vec<TranscribedNote> {
    let mut out: Vec<TranscribedNote> = notes_polyphonic(act, p)
        .into_iter()
        .filter(|&(_, _, key, _)| key >= p.min_key as usize && key <= p.max_key as usize)
        .map(|(a, b, key, amp)| {
            let t0 = act.times[a];
            let t1 = act.times.get(b).copied().unwrap_or_else(|| act.times[act.frames - 1] + FFT_HOP as f32 / SR as f32);
            TranscribedNote {
                start_sec: crate::analyze::ms(t0.max(0.0)),
                dur_sec: crate::analyze::ms((t1 - t0).max(0.001)),
                key: key as u8,
                vel: ((amp.clamp(0.0, 1.0)) * 1000.0).round() / 1000.0,
                cents: note_cents(act, a, b, key).map(|c| (c * 10.0).round() / 10.0),
            }
        })
        .collect();
    out.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec).then(a.key.cmp(&b.key)));
    out
}
