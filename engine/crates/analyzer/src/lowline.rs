//! Note segmentation for LOW monophonic lines (bass, 808, sub): where the
//! notes are. The pYIN track (pitch.rs) reads the pitch well, but its 93 ms
//! window hears two notes at once around every change of a fast bass line,
//! turns those frames unvoiced and leaves a gap of 40-90 ms on each side:
//! a legato line comes out as short blips with holes (measured on a real
//! HT-Demucs bass stem: 58% of the sounding time covered).
//!
//! Here the note boundaries come from two fast, robust readings every 10 ms:
//! * the dominant partial 25..400 Hz (a 186 ms spectrum, parabolic peak, one
//!   octave down when the sub-octave carries ≥ 30% of the peak), which flips
//!   right where one note hands over to the next;
//! * the level, as RMS over max(10 ms, 2.5 periods of that partial), so a
//!   sub note's per-cycle ripple doesn't read as re-attacks (even when the
//!   partial is the 2nd harmonic of a weak fundamental).
//!
//! Where pYIN has a confident reading of the same pitch class, its octave
//! replaces the partial's (a weak fundamental makes the peak flicker between
//! octaves); the partial fills pYIN's holes at the note changes.
//!
//! A note is a run of one partial pitch while the level is up, split where the
//! partial moves > 0.7 semitone for ≥ 30 ms or the level jumps by the
//! re-attack amount within 30 ms. Each note's KEY still comes from pYIN where
//! it has voiced frames that agree on the pitch class (pYIN copes with a
//! missing fundamental, the spectral peak doesn't); otherwise from the peak.
//! Fragments shorter than the minimum note length join their neighbour
//! instead of being dropped, so no sounding time goes silent.
//! Krypt-original.

use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;

use crate::features::{median, parabolic};
use crate::pitch::{PitchTrack, SegParams};
use crate::protocol::TranscribedNote;
use crate::{JobCtx, JobError};

const WIN: usize = 4096;
const LO_HZ: f32 = 25.0;
const HI_HZ: f32 = 400.0;
/// The sub-octave wins when it has this share of the peak's magnitude.
const SUB_OCTAVE: f32 = 0.3;
/// Sounding = within this many dB of the loudest frame.
const RANGE_DB: f32 = 35.0;
/// A pitch change must hold this many frames (10 ms each).
const HOLD: usize = 3;

/// Is this a low line? (the duration-weighted median pYIN note at or below G3).
pub fn is_low(notes: &[TranscribedNote]) -> bool {
    let mut w: Vec<(u8, f32)> = notes.iter().map(|n| (n.key, n.dur_sec)).collect();
    if w.is_empty() {
        return false;
    }
    w.sort_by_key(|a| a.0);
    let total: f32 = w.iter().map(|a| a.1).sum();
    let mut acc = 0.0;
    for (k, d) in w {
        acc += d;
        if acc >= total / 2.0 {
            return k <= 55;
        }
    }
    false
}

fn midi(hz: f32) -> f32 {
    69.0 + 12.0 * (hz / 440.0).log2()
}

/// Notes of a low monophonic line (x at `sr`), keyed with the help of the pYIN track `tr`.
pub fn segment(x: &[f32], sr: f32, tr: &PitchTrack, p: &SegParams, ctx: &JobCtx) -> Result<Vec<TranscribedNote>, JobError> {
    let hop = ((sr * 0.01).round() as usize).max(1);
    let n = x.len() / hop;
    if n < 4 {
        return Ok(Vec::new());
    }
    let fft = FftPlanner::<f32>::new().plan_fft_forward(WIN);
    let mut buf = vec![Complex32::new(0.0, 0.0); WIN];
    let mut scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];
    let hann: Vec<f32> = (0..WIN).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / WIN as f32).cos()).collect();
    let bin_hz = sr / WIN as f32;
    let lo = ((LO_HZ / bin_hz).floor() as usize).max(2);
    let hi = ((HI_HZ / bin_hz).ceil() as usize).min(WIN / 2 - 2);
    let mut part = vec![f32::NAN; n];
    let mut mag = vec![0f32; WIN / 2];
    for (i, pv) in part.iter_mut().enumerate() {
        if i % 512 == 0 {
            ctx.check()?;
        }
        let c = (i * hop + hop / 2) as i64;
        for (j, b) in buf.iter_mut().enumerate() {
            let k = c - (WIN / 2) as i64 + j as i64;
            let v = if k >= 0 && (k as usize) < x.len() { x[k as usize] } else { 0.0 };
            *b = Complex32::new(v * hann[j], 0.0);
        }
        fft.process_with_scratch(&mut buf, &mut scratch);
        for (k, m) in mag.iter_mut().enumerate() {
            *m = buf[k].norm();
        }
        let (mut k, mut best) = (lo, 0f32);
        for (j, &m) in mag.iter().enumerate().take(hi + 1).skip(lo) {
            if m > best {
                best = m;
                k = j;
            }
        }
        if best <= 0.0 {
            continue;
        }
        let mut f = (k as f32 + parabolic(mag[k - 1], mag[k], mag[k + 1])) * bin_hz;
        let k2 = (f / 2.0 / bin_hz).round() as usize;
        if k2 > lo && mag[k2 - 1].max(mag[k2]).max(mag[k2 + 1]) > SUB_OCTAVE * best {
            f /= 2.0;
        }
        if f > 0.0 {
            *pv = midi(f);
        }
    }
    // The octave from pYIN wherever it has a confident reading of the same pitch class: a weak
    // fundamental makes the peak flicker between octaves, which would split notes. The peak
    // fills pYIN's holes (note changes), which is what this reader is for.
    for (i, pv) in part.iter_mut().enumerate() {
        if !pv.is_finite() {
            continue;
        }
        let t = (((i * hop + hop / 2) as f32 / tr.hop as f32).round() as usize).min(tr.midi.len().saturating_sub(1));
        let y = tr.midi.get(t).copied().unwrap_or(f32::NAN);
        if y.is_finite() && tr.voiced_prob[t] >= p.voicing {
            let oct = ((y - *pv) / 12.0).round();
            if oct != 0.0 && (y - *pv - 12.0 * oct).abs() < 1.0 {
                *pv += 12.0 * oct;
            }
        }
    }
    // Frames whose pitch pYIN confirms (voiced, same pitch class).
    let backed: Vec<bool> = (0..n)
        .map(|i| {
            let t = (((i * hop + hop / 2) as f32 / tr.hop as f32).round() as usize).min(tr.midi.len().saturating_sub(1));
            let y = tr.midi.get(t).copied().unwrap_or(f32::NAN);
            part[i].is_finite() && y.is_finite() && tr.voiced_prob[t] >= p.voicing && (y - part[i]).abs() < 1.0
        })
        .collect();
    // Level: RMS over max(10 ms, 2.5 periods of the partial, i.e. >= 1.25 periods of a fundamental an octave below), centred.
    let mut pre = vec![0f64; x.len() + 1];
    for (i, &v) in x.iter().enumerate() {
        pre[i + 1] = pre[i] + (v as f64) * (v as f64);
    }
    let lev: Vec<f32> = (0..n)
        .map(|i| {
            let per = if part[i].is_finite() { 2.5 * sr / (440.0 * 2f32.powf((part[i] - 69.0) / 12.0)) } else { 0.0 };
            let w = (per.max(hop as f32)).round() as usize;
            let c = i * hop + hop / 2;
            let a = c.saturating_sub(w / 2);
            let b = (a + w).min(x.len());
            if b <= a {
                return -120.0;
            }
            (10.0 * (((pre[b] - pre[a]) / (b - a) as f64) as f32 + 1e-12).log10()).max(-120.0)
        })
        .collect();
    let peak = lev.iter().cloned().fold(-120f32, f32::max);
    // A 5 ms envelope: the long level window of a sub note would bridge a real gap.
    let fine = ((sr * 0.0025).round() as usize).max(1);
    let fine_db = |u: usize| -> f32 {
        let a = (u * fine).saturating_sub(fine);
        let b = (u * fine + fine).min(x.len());
        if b <= a {
            return -120.0;
        }
        10.0 * (((pre[b] - pre[a]) / (b - a) as f64) as f32 + 1e-12).log10()
    };
    let n_fine = x.len() / fine;
    let fine_peak = (0..n_fine).map(fine_db).fold(-120f32, f32::max);
    // Sounding: the level is up AND the 5 ms envelope is up somewhere within ±10 ms.
    let on: Vec<bool> = (0..n)
        .map(|i| {
            let (ua, ub) = ((i * hop).saturating_sub(hop) / fine, (((i + 2) * hop) / fine).min(n_fine));
            lev[i] > peak - RANGE_DB && part[i].is_finite() && (ua..ub).any(|u| fine_db(u) >= fine_peak - RANGE_DB - 5.0)
        })
        .collect();
    let reattack = p.reattack_db.clamp(3.0, 12.0);
    let lag = 3; // 30 ms

    // 1. Runs of one partial pitch while sounding, split at changes and re-attacks.
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < n {
        if !on[i] {
            i += 1;
            continue;
        }
        let a = i;
        let mut recent: Vec<f32> = vec![part[i]];
        let mut j = i + 1;
        while j < n && on[j] {
            let r = median(&recent[recent.len().saturating_sub(8)..]);
            let moved = |q: usize| j + q < n && on[j + q] && (part[j + q] - r).abs() > 0.7;
            if (0..HOLD).all(moved) {
                // An octave-only jump is real only if pYIN confirms the new octave within 150 ms
                // (else it's the peak flickering onto a harmonic, e.g. a weak fundamental fading).
                let d = part[j] - r;
                let octave_only = (d / 12.0).round() != 0.0 && (d - 12.0 * (d / 12.0).round()).abs() < 0.7;
                let confirmed = || (j..(j + 15).min(n)).any(|k| backed[k] && (part[k] - part[j]).abs() < 0.7);
                if !octave_only || confirmed() {
                    break;
                }
            }
            if j - a >= lag + 1 {
                let lo_db = lev[j - lag..j].iter().cloned().fold(f32::MAX, f32::min);
                if lev[j] - lo_db >= reattack {
                    break;
                }
            }
            recent.push(part[j]);
            j += 1;
        }
        spans.push((a, j));
        i = j;
    }
    // 2. Fragments shorter than the minimum note join a touching neighbour (the
    //    longer one), so nothing that sounds is left uncovered. An isolated short
    //    note (a staccato blip, >= 30 ms) stays as it is; shorter crumbs go.
    let min_frames = ((p.min_note_sec.max(0.03) / 0.01).round() as usize).max(2);
    let mut kept = vec![false; spans.len()];
    loop {
        let Some(s) = (0..spans.len()).filter(|&s| !kept[s] && spans[s].1 - spans[s].0 < min_frames).min_by_key(|&s| spans[s].1 - spans[s].0) else {
            break;
        };
        let (a, b) = spans[s];
        // Neighbours within 20 ms count as touching (a frame or two below the level gate).
        let prev = (s > 0 && a - spans[s - 1].1 <= 2).then(|| s - 1);
        let next = (s + 1 < spans.len() && spans[s + 1].0 - b <= 2).then_some(s + 1);
        let into = match (prev, next) {
            (Some(pv), Some(nx)) => Some(if spans[pv].1 - spans[pv].0 >= spans[nx].1 - spans[nx].0 { pv } else { nx }),
            (pv, nx) => pv.or(nx),
        };
        match into {
            Some(t) if t < s => spans[t].1 = b,
            Some(t) => spans[t].0 = a,
            None if b - a >= 3 => {
                kept[s] = true;
                continue;
            }
            None => {}
        }
        spans.remove(s);
        kept.remove(s);
    }

    // 3. Edges next to silence: the level window (up to 1.25 periods) reaches past the
    //    note, so snap the edge to where a 5 ms envelope crosses (body − 15 dB):
    //    the start within ±50 ms, the end within −120..+50 ms (a merged tail crumb).
    let mut edges: Vec<(f32, f32)> = Vec::with_capacity(spans.len());
    for (s, &(a, b)) in spans.iter().enumerate() {
        let mut t0 = a as f32 * hop as f32 / sr;
        let mut t1 = b as f32 * hop as f32 / sr;
        let body = median(&lev[a..b]);
        let th = body - 15.0;
        let to_u = |t: f32| ((t * sr / fine as f32).round().max(0.0) as usize).min(n_fine.saturating_sub(1));
        if s == 0 || spans[s - 1].1 != a {
            let (lo_u, hi_u) = (to_u(t0 - 0.05).max(1), to_u(t0 + 0.05));
            if let Some(u) = (lo_u..=hi_u).find(|&u| fine_db(u) >= th && fine_db(u - 1) < th) {
                t0 = u as f32 * fine as f32 / sr;
            }
        }
        if s + 1 == spans.len() || spans[s + 1].0 != b {
            let (lo_u, hi_u) = (to_u((t1 - 0.12).max(t0)), to_u(t1 + 0.05).min(n_fine.saturating_sub(2)));
            if let Some(u) = (lo_u..=hi_u).rev().find(|&u| fine_db(u) >= th && fine_db(u + 1) < th) {
                t1 = ((u + 1) as f32 * fine as f32 / sr).max(t0 + 0.01);
            }
        }
        edges.push((t0, t1));
    }

    // 4. Keys: pYIN's voiced frames inside the note when they agree on the pitch class, else the partial.
    let fps_tr = tr.sr / tr.hop as f32;
    let mut out = Vec::with_capacity(spans.len());
    for (&(a, b), &(t0, t1)) in spans.iter().zip(&edges) {
        let pp: Vec<f32> = (a..b).map(|i| part[i]).filter(|v| v.is_finite()).collect();
        if pp.is_empty() {
            continue;
        }
        let spec = median(&pp);
        let (ta, tb) = (((t0 * fps_tr).ceil() as usize).min(tr.midi.len()), ((t1 * fps_tr).floor() as usize).min(tr.midi.len()));
        let yin: Vec<f32> = (ta..tb).filter(|&t| tr.midi[t].is_finite() && tr.voiced_prob[t] >= p.voicing).map(|t| tr.midi[t]).collect();
        let m = if yin.len() >= 3 {
            let y = median(&yin);
            let pc = ((y - spec).rem_euclid(12.0) + 6.0).rem_euclid(12.0) - 6.0;
            if pc.abs() < 1.0 { y } else { spec }
        } else {
            spec
        };
        let key = m.round();
        if !(key >= p.min_key as f32 && key <= p.max_key as f32) || t1 - t0 < 0.03 {
            continue;
        }
        let loud = (a..b).map(|i| lev[i]).fold(-120f32, f32::max);
        let vel = ((loud - (peak - 40.0)) / 40.0).clamp(0.05, 1.0);
        out.push(TranscribedNote {
            start_sec: crate::analyze::ms(t0),
            dur_sec: crate::analyze::ms(t1 - t0),
            key: key as u8,
            vel: (vel * 1000.0).round() / 1000.0,
            cents: Some((((m - key) * 100.0).clamp(-50.0, 50.0) * 10.0).round() / 10.0),
        });
    }
    Ok(out)
}
