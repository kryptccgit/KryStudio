//! Monophonic pitch (pYIN-style) and note segmentation.
//!
//! f0 candidates follow pYIN (Mauch & Dixon, "pYIN: a fundamental frequency
//! estimator using probabilistic threshold distributions", ICASSP 2014): the
//! YIN cumulative-mean-normalised difference function (de Cheveigné &
//! Kawahara 2002) is thresholded at 100 thresholds weighted by a Beta(2, 18)
//! prior, giving each trough a probability. A sparse Viterbi pass (voiced
//! candidates + one unvoiced state, pitch-jump and voicing-switch penalties)
//! picks a smooth path. Notes are stable-pitch runs, split at pitch changes
//! and at loudness re-attacks. Krypt-original implementation.

use std::sync::Arc;

use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};

use crate::features::{median, parabolic};
use crate::protocol::TranscribedNote;
use crate::{JobCtx, JobError};

pub const FRAME: usize = 2048;
pub const HOP: usize = 256;
const W: usize = FRAME / 2; // YIN integration window

/// Short energy envelope (for note onsets/offsets): window and hop.
pub const SHORT_WIN: usize = 256;
pub const SHORT_HOP: usize = 64;

pub struct PitchTrack {
    pub sr: f32,
    pub hop: usize,
    /// MIDI pitch per frame (NaN when unvoiced). Frame t is centred on t·hop.
    pub midi: Vec<f32>,
    /// Voicing probability (sum of candidate probabilities) per frame.
    pub voiced_prob: Vec<f32>,
    /// Frame RMS in dBFS.
    pub rms_db: Vec<f32>,
    /// RMS in dBFS over [`SHORT_WIN`] samples every [`SHORT_HOP`] (centred).
    pub short_db: Vec<f32>,
}

/// Beta(2, 18) CDF: 1 − (1−x)^18 · (1 + 18x).
fn beta_cdf(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0) as f64;
    (1.0 - (1.0 - x).powi(18) * (1.0 + 18.0 * x)) as f32
}

struct Cand {
    midi: f32,
    p: f32,
}

pub fn track(x: &[f32], sr: f32, fmin: f32, fmax: f32, ctx: &JobCtx) -> Result<PitchTrack, JobError> {
    let n_frames = if x.is_empty() { 0 } else { x.len() / HOP + 1 };
    let tau_min = ((sr / fmax).floor() as usize).max(2);
    let tau_max = ((sr / fmin).ceil() as usize).min(W - 1);
    let size = (FRAME + W).next_power_of_two();
    let fft: Arc<dyn Fft<f32>> = FftPlanner::new().plan_fft_forward(size);
    let ifft: Arc<dyn Fft<f32>> = FftPlanner::new().plan_fft_inverse(size);
    let mut buf = vec![Complex32::new(0.0, 0.0); size];
    let mut prod = vec![Complex32::new(0.0, 0.0); size];
    let mut scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len().max(ifft.get_inplace_scratch_len())];
    // Thresholds 0.01..1.00 with Beta(2,18) prior mass.
    let thresholds: Vec<(f32, f32)> = (1..=100).map(|i| {
        let s = i as f32 / 100.0;
        (s, beta_cdf(s) - beta_cdf(s - 0.01))
    }).collect();
    let mut frame = vec![0f32; FRAME];
    let mut rms_db = vec![-120f32; n_frames];
    let mut cands: Vec<Vec<Cand>> = Vec::with_capacity(n_frames);
    // The YIN integration window [s, s+W) is centred on the frame time.
    let half = (W / 2) as i64;
    let mut d = vec![0f32; tau_max + 2];
    let mut cm = vec![0f32; tau_max + 2];
    // Silence gate relative to the loudest frame.
    let mut frame_rms = vec![0f32; n_frames];
    for (t, r) in frame_rms.iter_mut().enumerate() {
        let start = t as i64 * HOP as i64 - half;
        let mut e = 0f32;
        for j in 0..FRAME {
            let k = start + j as i64;
            if k >= 0 && (k as usize) < x.len() {
                e += x[k as usize] * x[k as usize];
            }
        }
        *r = (e / FRAME as f32).sqrt();
    }
    let rmax = frame_rms.iter().cloned().fold(0f32, f32::max);
    for t in 0..n_frames {
        if t % 256 == 0 {
            ctx.check()?;
        }
        rms_db[t] = 20.0 * (frame_rms[t] + 1e-9).log10();
        if frame_rms[t] < rmax * 10f32.powf(-55.0 / 20.0) || frame_rms[t] < 1e-5 {
            cands.push(Vec::new());
            continue;
        }
        let start = t as i64 * HOP as i64 - half;
        for (j, v) in frame.iter_mut().enumerate() {
            let k = start + j as i64;
            *v = if k >= 0 && (k as usize) < x.len() { x[k as usize] } else { 0.0 };
        }
        // r(τ) = Σ_{j<W} x_j x_{j+τ}: correlate head (real) with frame (imag) in one FFT.
        for i in 0..size {
            let a = if i < W { frame[i] } else { 0.0 };
            let b = if i < FRAME { frame[i] } else { 0.0 };
            buf[i] = Complex32::new(a, b);
        }
        fft.process_with_scratch(&mut buf, &mut scratch);
        for k in 0..size {
            let z = buf[k];
            let zc = buf[(size - k) % size].conj();
            let a = (z + zc) * 0.5; // FFT(head)
            let dd = (z - zc) * 0.5;
            let b = Complex32::new(dd.im, -dd.re); // FFT(frame)
            prod[k] = a.conj() * b;
        }
        ifft.process_with_scratch(&mut prod, &mut scratch);
        let inv = 1.0 / size as f32;
        // Energies: e0 = Σ_{j<W} x_j², eτ = Σ_{j<W} x_{j+τ}².
        let mut pre = vec![0f32; FRAME + 1];
        for j in 0..FRAME {
            pre[j + 1] = pre[j] + frame[j] * frame[j];
        }
        let e0 = pre[W];
        d[0] = 0.0;
        for tau in 1..=tau_max {
            let et = pre[tau + W] - pre[tau];
            d[tau] = (e0 + et - 2.0 * prod[tau].re * inv).max(0.0);
        }
        // CMNDF
        cm[0] = 1.0;
        let mut run = 0f32;
        for tau in 1..=tau_max {
            run += d[tau];
            cm[tau] = if run > 0.0 { d[tau] * tau as f32 / run } else { 1.0 };
        }
        // Troughs (local minima) in range.
        let mut troughs: Vec<usize> = Vec::new();
        for tau in tau_min.max(1)..tau_max {
            if cm[tau] < cm[tau - 1] && cm[tau] <= cm[tau + 1] {
                troughs.push(tau);
            }
        }
        let mut probs: Vec<(usize, f32)> = Vec::new();
        if !troughs.is_empty() {
            let gmin = *troughs.iter().min_by(|&&a, &&b| cm[a].total_cmp(&cm[b])).unwrap();
            for &(s, w) in &thresholds {
                match troughs.iter().find(|&&tau| cm[tau] < s) {
                    Some(&tau) => add(&mut probs, tau, w),
                    None => add(&mut probs, gmin, w * 0.01),
                }
            }
        }
        let c = probs
            .into_iter()
            .filter(|&(_, p)| p > 1e-4)
            .map(|(tau, p)| {
                let off = if tau > 0 && tau < tau_max { parabolic(cm[tau - 1], cm[tau], cm[tau + 1]) } else { 0.0 };
                let f0 = sr / (tau as f32 + off);
                Cand { midi: 69.0 + 12.0 * (f0 / 440.0).log2(), p }
            })
            .filter(|c| c.midi.is_finite())
            .collect();
        cands.push(c);
    }
    // Sparse Viterbi: states = candidates of the frame + unvoiced (index len).
    let ln = |p: f32| p.max(1e-9).ln();
    let stay_v = ln(0.99);
    let switch = ln(0.01);
    let jump = |a: f32, b: f32| -> f32 { -((a - b).abs() / 2.5) }; // Laplacian, 2.5 semitones
    let mut score: Vec<f32> = Vec::new();
    let mut back: Vec<Vec<usize>> = Vec::with_capacity(n_frames);
    let mut prev_c: &[Cand] = &[];
    for (t, c) in cands.iter().enumerate() {
        if t % 4096 == 0 {
            ctx.check()?;
        }
        let pv: f32 = c.iter().map(|c| c.p).sum::<f32>().min(1.0);
        let mut ns = vec![f32::MIN; c.len() + 1];
        let mut bk = vec![0usize; c.len() + 1];
        let first = t == 0;
        for (j, cj) in c.iter().enumerate() {
            let em = ln(cj.p);
            if first {
                ns[j] = em + switch;
                continue;
            }
            for (i, ci) in prev_c.iter().enumerate() {
                let s = score[i] + stay_v + jump(ci.midi, cj.midi);
                if s > ns[j] {
                    ns[j] = s;
                    bk[j] = i;
                }
            }
            let s = score[prev_c.len()] + switch;
            if s > ns[j] {
                ns[j] = s;
                bk[j] = prev_c.len();
            }
            ns[j] += em;
        }
        let u = c.len();
        let em_u = ln(1.0 - pv);
        if first {
            ns[u] = em_u;
        } else {
            for (i, _) in prev_c.iter().enumerate() {
                let s = score[i] + switch;
                if s > ns[u] {
                    ns[u] = s;
                    bk[u] = i;
                }
            }
            let s = score[prev_c.len()] + stay_v;
            if s > ns[u] {
                ns[u] = s;
                bk[u] = prev_c.len();
            }
            ns[u] += em_u;
        }
        score = ns;
        back.push(bk);
        prev_c = c;
    }
    let mut midi = vec![f32::NAN; n_frames];
    let mut voiced_prob = vec![0f32; n_frames];
    if n_frames > 0 {
        let mut s = score.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|x| x.0).unwrap_or(0);
        for t in (0..n_frames).rev() {
            let c = &cands[t];
            voiced_prob[t] = c.iter().map(|c| c.p).sum::<f32>().min(1.0);
            if s < c.len() {
                midi[t] = c[s].midi;
            }
            s = back[t][s];
        }
    }
    let n_short = if x.is_empty() { 0 } else { x.len() / SHORT_HOP + 1 };
    let mut pre = vec![0f64; x.len() + 1];
    for (i, v) in x.iter().enumerate() {
        pre[i + 1] = pre[i] + (*v as f64) * (*v as f64);
    }
    let short_db = (0..n_short)
        .map(|u| {
            let c = u * SHORT_HOP;
            let a = c.saturating_sub(SHORT_WIN / 2);
            let b = (c + SHORT_WIN / 2).min(x.len());
            let e = if b > a { (pre[b] - pre[a]) / SHORT_WIN as f64 } else { 0.0 };
            (10.0 * (e + 1e-12).log10()) as f32
        })
        .collect();
    Ok(PitchTrack { sr, hop: HOP, midi, voiced_prob, rms_db, short_db })
}

fn add(v: &mut Vec<(usize, f32)>, tau: usize, w: f32) {
    if let Some(e) = v.iter_mut().find(|e| e.0 == tau) {
        e.1 += w;
    } else {
        v.push((tau, w));
    }
}

pub struct SegParams {
    /// Voicing probability needed per frame (0..1).
    pub voicing: f32,
    /// Loudness rise (dB within ~35 ms) that starts a new note on the same pitch.
    pub reattack_db: f32,
    pub min_note_sec: f32,
    pub min_key: u8,
    pub max_key: u8,
}

/// Segment a pitch track into notes: voiced runs split at pitch changes,
/// then at loudness re-attacks; boundaries next to silence are refined on the
/// short energy envelope.
pub fn segment(tr: &PitchTrack, p: &SegParams) -> Vec<TranscribedNote> {
    let n = tr.midi.len();
    if n == 0 || tr.short_db.is_empty() {
        return Vec::new();
    }
    let fps = tr.sr / tr.hop as f32;
    let sfps = tr.sr / SHORT_HOP as f32;
    // A frame counts only if its centre isn't silent: the 93 ms YIN window
    // otherwise "hears" a neighbouring note from inside a gap.
    let s_peak = tr.short_db.iter().cloned().fold(-120f32, f32::max);
    let centre_loud = |t: usize| -> bool {
        let u = (t * tr.hop / SHORT_HOP).min(tr.short_db.len() - 1);
        let a = u.saturating_sub(2);
        let b = (u + 2).min(tr.short_db.len() - 1);
        tr.short_db[a..=b].iter().cloned().fold(-120f32, f32::max) >= s_peak - 45.0
    };
    let voiced: Vec<bool> = (0..n).map(|t| tr.midi[t].is_finite() && tr.voiced_prob[t] >= p.voicing && centre_loud(t)).collect();
    let peak_db = tr.rms_db.iter().cloned().fold(-120f32, f32::max);
    // 1. Voiced runs (gaps of ≤ 2 frames bridged), split where the pitch moves
    //    more than 0.7 semitone for ≥ 3 frames (a legato boundary).
    struct Seg {
        a: usize,
        b: usize,
        legato_start: bool,
        legato_end: bool,
    }
    let mut segs: Vec<Seg> = Vec::new();
    let mut t = 0;
    let mut legato_next = false;
    while t < n {
        if !voiced[t] {
            t += 1;
            legato_next = false;
            continue;
        }
        let start = t;
        let mut pitches: Vec<f32> = vec![tr.midi[t]];
        let mut end = t + 1;
        let mut gap = 0;
        let mut off = 0;
        let mut i = t + 1;
        let mut changed = false;
        while i < n {
            if !voiced[i] {
                gap += 1;
                if gap > 2 {
                    break;
                }
                i += 1;
                continue;
            }
            let reference = median(&pitches[pitches.len().saturating_sub(12)..]);
            if (tr.midi[i] - reference).abs() > 0.7 {
                off += 1;
                if off >= 3 {
                    end = i + 1 - off;
                    changed = true;
                    break;
                }
            } else {
                off = 0;
                pitches.push(tr.midi[i]);
            }
            gap = 0;
            end = i + 1;
            i += 1;
        }
        if end <= start {
            end = start + 1;
        }
        segs.push(Seg { a: start, b: end, legato_start: legato_next, legato_end: changed });
        legato_next = changed;
        t = end;
    }
    // 2. Times refined on the short envelope; 3. splits at re-attacks.
    let sdb = &tr.short_db;
    let last = sdb.len() - 1;
    let s_at = |sec: f32| -> usize { ((sec * sfps).round().max(0.0) as usize).min(last) };
    let mut spans: Vec<(f32, f32)> = Vec::new();
    let mut prev_end = 0f32;
    for (si, sg) in segs.iter().enumerate() {
        let mut t0 = sg.a as f32 / fps;
        let mut t1 = sg.b as f32 / fps;
        let next_start = segs.get(si + 1).map(|n| n.a as f32 / fps).unwrap_or(f32::MAX);
        let (ba, bb) = (s_at(t0 + 0.02), s_at((t1 - 0.02).max(t0 + 0.02)));
        let level = median(&sdb[ba.min(bb)..=bb.max(ba)]);
        let th = level - 12.0;
        if !sg.legato_start {
            // Rising crossing of (body − 12 dB) within ±70 ms, after the previous note.
            let lo = s_at((t0 - 0.07).max(prev_end)).max(1);
            if let Some(u) = (lo..=s_at(t0 + 0.07)).find(|&u| sdb[u] >= th && sdb[u - 1] < th) {
                t0 = u as f32 / sfps;
            }
        }
        if !sg.legato_end {
            // Last falling crossing within −120..+70 ms, before the next note.
            let hi = s_at((t1 + 0.07).min(next_start)).min(last.saturating_sub(1));
            if let Some(u) = (s_at(t1 - 0.12)..=hi).rev().find(|&u| sdb[u] >= th && sdb[u + 1] < th) {
                t1 = (u as f32 / sfps).max(t0 + 0.001);
            }
        }
        prev_end = t1;
        // Re-attacks: a rise of ≥ reattack_db within 30 ms, up to the body level.
        // Low notes: the 11.6 ms envelope ripples once per period (a bass with a
        // weak fundamental swings > 10 dB every cycle), which would read as
        // re-attacks and chop the note into fragments. So the rise is measured
        // on a peak-hold over 1.25 periods of the note's pitch.
        let mut cuts = vec![t0];
        let lag = ((0.03 * sfps).round() as usize).max(1);
        let min_gap = p.min_note_sec.max(0.04);
        let (ua, ub) = (s_at(t0 + min_gap), s_at(t1 - min_gap));
        let seg_pitch: Vec<f32> = (sg.a..sg.b).filter(|&t| voiced[t]).map(|t| tr.midi[t]).collect();
        let f0 = if seg_pitch.is_empty() { 0.0 } else { 440.0 * 2f32.powf((median(&seg_pitch) - 69.0) / 12.0) };
        let hold = if f0 > 0.0 { ((1.25 / f0 * sfps).ceil() as usize).max(1) } else { 1 };
        let env = |u: usize| -> f32 { sdb[u.saturating_sub(hold - 1)..=u].iter().cloned().fold(f32::MIN, f32::max) };
        let mut u = ua.max(lag);
        while u < ub {
            let lo = (u - lag..u).map(env).fold(f32::MAX, f32::min);
            let cur = env(u);
            if cur - lo >= p.reattack_db && cur >= level - 6.0 && u as f32 / sfps - cuts.last().copied().unwrap_or(t0) >= min_gap {
                // Onset = first point of the rise within 12 dB of the body.
                let on = (u - lag..=u).find(|&k| sdb[k] >= level - 12.0).unwrap_or(u);
                cuts.push(on as f32 / sfps);
                u += lag;
                continue;
            }
            u += 1;
        }
        cuts.push(t1);
        let k = cuts.len() - 1;
        for (i, w) in cuts.windows(2).enumerate() {
            let mut end = w[1];
            if i + 1 < k {
                // Split at a re-attack: end at the dip before it, if there is one.
                let (a, b) = (s_at((w[1] - 0.12).max(w[0])), s_at(w[1]).saturating_sub(1));
                if let Some(u) = (a..b.min(last - 1)).rev().find(|&u| sdb[u] >= th && sdb[u + 1] < th) {
                    end = (u as f32 / sfps).max(w[0] + 0.001);
                }
            }
            spans.push((w[0], end));
        }
    }
    let mut out = Vec::new();
    for (t0, t1) in spans {
        let dur = t1 - t0;
        if dur + 1e-6 < p.min_note_sec {
            continue;
        }
        let a = ((t0 * fps).round() as usize).min(n - 1);
        let b = ((t1 * fps).round() as usize).min(n).max(a + 1);
        let ps: Vec<f32> = (a..b).filter(|&t| voiced[t]).map(|t| tr.midi[t]).collect();
        if ps.is_empty() {
            continue;
        }
        let m = median(&ps);
        let key = m.round();
        if !(key >= p.min_key as f32 && key <= p.max_key as f32) {
            continue;
        }
        let near: Vec<f32> = ps.iter().copied().filter(|v| (v - key).abs() <= 0.5).collect();
        let cents = if near.is_empty() { (m - key) * 100.0 } else { (near.iter().sum::<f32>() / near.len() as f32 - key) * 100.0 };
        let loud = (a..b).map(|t| tr.rms_db[t]).fold(-120f32, f32::max);
        let vel = ((loud - (peak_db - 40.0)) / 40.0).clamp(0.05, 1.0);
        out.push(TranscribedNote {
            start_sec: crate::analyze::ms(t0.max(0.0)),
            dur_sec: crate::analyze::ms(dur),
            key: key as u8,
            vel: (vel * 1000.0).round() / 1000.0,
            cents: Some((cents.clamp(-50.0, 50.0) * 10.0).round() / 10.0),
        });
    }
    out
}
