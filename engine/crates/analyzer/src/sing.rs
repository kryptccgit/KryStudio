use std::sync::atomic::AtomicBool;

use krypt_studio_stretch::{map_out_to_in, stretch_mapped, stretch_mapped_curve, Profile, StretchError, MAX_SEMITONES};

use crate::audio;
use crate::protocol::{SingArgs, SingResult, SingSegment, SungSegment};
use crate::syllables::{median_f0, voicing_track, VoiceFrame};
use crate::{JobCtx, JobError};

pub const MAX_SEGMENTS: usize = 5000;
pub const MAX_OUT_SEC: f64 = 1800.0;
const XFADE_SEC: f64 = 0.008;
const PRE_ROLL_SEC: f64 = 0.04;
const VOICE_HOP: f32 = 0.01;
const MIN_VOICED_FRAMES: usize = 3;
const VIBRATO_HZ: f64 = 5.5;
const VIBRATO_MAX_CENTS: f64 = 50.0;
const MAX_VOWEL_RATIO: f64 = 8.0;
const PEAK_TARGET: f32 = 0.891;
const MAX_GAIN: f32 = 4.0;

fn fail(m: impl Into<String>) -> JobError {
    JobError::Failed(m.into())
}

pub fn midi_hz(midi: f64) -> f64 {
    440.0 * 2f64.powf((midi - 69.0) / 12.0)
}

fn validate(args: &SingArgs) -> Result<(), JobError> {
    if args.segments.is_empty() {
        return Err(fail("Nothing to sing: no segments were given"));
    }
    if args.segments.len() > MAX_SEGMENTS {
        return Err(fail(format!("Too many segments ({}; at most {MAX_SEGMENTS})", args.segments.len())));
    }
    for (i, s) in args.segments.iter().enumerate() {
        let n = i + 1;
        if ![s.src_start_sec, s.src_end_sec, s.out_start_sec, s.dur_sec, s.midi].iter().all(|v| v.is_finite()) {
            return Err(fail(format!("Segment {n} has a value that is not a number")));
        }
        if s.src_start_sec < 0.0 || s.src_end_sec <= s.src_start_sec {
            return Err(fail(format!("Segment {n}: the source range {:.3}–{:.3} s is empty", s.src_start_sec, s.src_end_sec)));
        }
        if s.dur_sec <= 0.0 || s.out_start_sec < 0.0 || s.out_start_sec + s.dur_sec > MAX_OUT_SEC {
            return Err(fail(format!("Segment {n}: the note must start at 0 s or later, last more than 0 s and end within {MAX_OUT_SEC} s")));
        }
        if !(0.0..=127.0).contains(&s.midi) {
            return Err(fail(format!("Segment {n}: MIDI key {} is outside 0..127", s.midi)));
        }
    }
    Ok(())
}

pub fn knots_for(core: usize, ext: usize, out: usize, voiced: Option<(usize, usize)>) -> (Vec<(f64, f64)>, f64) {
    let (l, d) = (core as f64, out as f64);
    let ratio = d / l;
    let mut k: Vec<(f64, f64)> = vec![(0.0, 0.0)];
    let mut tail_ratio = ratio;
    match voiced {
        Some((a, b)) if ratio > 1.0 && b > a && (b - a) as f64 >= 0.05 * l => {
            let (a, b) = (a as f64, b as f64);
            let cons = l - (b - a);
            let mut rc = 1.0;
            let mut rv = (d - rc * cons) / (b - a);
            if rv > MAX_VOWEL_RATIO && cons > 0.0 {
                rv = MAX_VOWEL_RATIO;
                rc = (d - rv * (b - a)) / cons;
            }
            if a > 0.0 {
                k.push((a, a * rc));
            }
            let ob = a * rc + (b - a) * rv;
            if b < l && ob < d {
                k.push((b, ob));
            }
            k.push((l, d));
            tail_ratio = rc;
        }
        _ => k.push((l, d)),
    }
    if ext > 0 {
        k.push((l + ext as f64, d + ext as f64 * tail_ratio));
    }
    let mut clean: Vec<(f64, f64)> = Vec::with_capacity(k.len());
    for p in k {
        if clean.last().is_none_or(|q: &(f64, f64)| p.0 > q.0 + 1e-9 && p.1 > q.1 + 1e-9) {
            clean.push(p);
        }
    }
    (clean, tail_ratio)
}

pub fn pitch_curve(t: f64, dur: f64, glide_from_cents: f64, glide_sec: f64, vibrato: f64) -> f64 {
    let mut c = 0.0;
    if glide_sec > 0.0 && glide_from_cents != 0.0 && t < glide_sec {
        let u = t / glide_sec;
        c += glide_from_cents * 0.5 * (1.0 + (std::f64::consts::PI * u).cos());
    }
    if vibrato > 0.0 {
        let delay = (0.35 * dur).clamp(0.12, 0.6);
        if t > delay {
            let ramp = ((t - delay) / 0.25).min(1.0);
            c += vibrato * VIBRATO_MAX_CENTS * ramp * (2.0 * std::f64::consts::PI * VIBRATO_HZ * (t - delay)).sin();
        }
    }
    c
}

pub fn contour(frames: &[VoiceFrame], median: f32) -> Vec<f64> {
    let raw: Vec<Option<f64>> = frames.iter().map(|f| f.f0.map(|v| 1200.0 * f64::from(v / median).log2()).filter(|c| c.abs() <= 700.0)).collect();
    let n = raw.len();
    let mut filled = vec![0f64; n];
    let known: Vec<usize> = (0..n).filter(|&i| raw[i].is_some()).collect();
    if known.is_empty() {
        return filled;
    }
    for (i, v) in filled.iter_mut().enumerate() {
        let next = known.partition_point(|&k| k < i);
        *v = match (next.checked_sub(1).map(|j| known[j]), known.get(next).copied()) {
            (Some(a), Some(b)) if a != b => {
                let (va, vb) = (raw[a].unwrap_or(0.0), raw[b].unwrap_or(0.0));
                va + (vb - va) * (i - a) as f64 / (b - a) as f64
            }
            (Some(a), _) => raw[a].unwrap_or(0.0),
            (None, Some(b)) => raw[b].unwrap_or(0.0),
            (None, None) => 0.0,
        };
    }
    let med: Vec<f64> = (0..n)
        .map(|i| {
            let mut w: Vec<f64> = filled[i.saturating_sub(2)..(i + 3).min(n)].to_vec();
            w.sort_by(f64::total_cmp);
            w[w.len() / 2]
        })
        .collect();
    (0..n).map(|i| {
        let w = &med[i.saturating_sub(1)..(i + 2).min(n)];
        w.iter().sum::<f64>() / w.len() as f64
    }).collect()
}

fn stretch_err(e: StretchError) -> JobError {
    match e {
        StretchError::Cancelled => JobError::Cancelled,
        StretchError::Failed(m) => fail(format!("Singing failed: {m}")),
    }
}

pub fn run(args: &SingArgs, ctx: &JobCtx) -> Result<SingResult, JobError> {
    validate(args)?;
    let vibrato = f64::from(args.vibrato.unwrap_or(0.0)).clamp(0.0, 1.0);
    let glide = f64::from(args.glide_ms.unwrap_or(0.0)).clamp(0.0, 1000.0) / 1000.0;
    ctx.progress("decoding", -1.0);
    let data = audio::load(&args.path)?;
    let x = audio::mono(&data.channels);
    let sr = f64::from(data.sample_rate);
    ctx.check()?;
    let (out, segs) = render(&x, sr, &args.segments, vibrato, glide, ctx)?;
    ctx.progress("writing", -1.0);
    crate::wav::write_mono(&args.out, &out, data.sample_rate.round() as u32)?;
    Ok(SingResult { path: args.out.clone(), duration_sec: (out.len() as f64 / sr) as f32, segments: segs })
}

pub fn render(x: &[f32], sr: f64, segments: &[SingSegment], vibrato: f64, glide: f64, ctx: &JobCtx) -> Result<(Vec<f32>, Vec<SungSegment>), JobError> {
    let xf = (XFADE_SEC * sr).round() as usize;
    let h = xf / 2;
    let end_sec = segments.iter().map(|s| s.out_start_sec + s.dur_sec).fold(0.0, f64::max);
    let mut out = vec![0f32; (end_sec * sr).ceil() as usize + h + 1];
    let mut result = Vec::with_capacity(segments.len());
    let cancel = AtomicBool::new(false);
    let mut prev: Option<(f64, f64, bool)> = None;
    ctx.progress("singing", 0.0);
    for (i, seg) in segments.iter().enumerate() {
        ctx.check()?;
        let s0 = ((seg.src_start_sec * sr).round() as usize).min(x.len());
        let s1 = ((seg.src_end_sec * sr).round() as usize).min(x.len());
        let o0 = (seg.out_start_sec * sr).round() as usize;
        let d = ((seg.dur_sec * sr).round() as usize).max(1);
        if s1 <= s0 + 16 {
            result.push(SungSegment { f0_hz: None, shift_st: 0.0 });
            continue;
        }
        let core = &x[s0..s1];
        let frames = voicing_track(core, sr as f32, VOICE_HOP);
        let f0 = median_f0(&frames, MIN_VOICED_FRAMES);
        let hop = f64::from(VOICE_HOP) * sr;
        let voiced_range = f0.and_then(|_| {
            let a = frames.iter().position(|f| f.f0.is_some())?;
            let b = frames.iter().rposition(|f| f.f0.is_some())?;
            let a = ((a as f64 - 0.5) * hop).max(0.0) as usize;
            let b = (((b as f64 + 0.5) * hop) as usize).min(core.len());
            Some((a, b))
        });
        let shift = f0.map_or(0.0, |f| (12.0 * (midi_hz(seg.midi) / f64::from(f)).log2()).clamp(-MAX_SEMITONES, MAX_SEMITONES));
        let ratio = d as f64 / core.len() as f64;
        let pre = s0.min((PRE_ROLL_SEC * sr) as usize);
        let ext = ((xf as f64 / ratio.clamp(0.125, 1.0)).ceil() as usize).min(x.len() - s1);
        let src = &x[s0 - pre..s1 + ext];
        let (core_knots, _) = knots_for(core.len(), ext, d, voiced_range);
        let first_slope = (core_knots[1].1 - core_knots[0].1) / (core_knots[1].0 - core_knots[0].0);
        let pre_out = (pre as f64 * first_slope).round() as usize;
        let mut knots: Vec<(f64, f64)> = if pre > 0 && pre_out > 0 { vec![(0.0, 0.0)] } else { Vec::new() };
        knots.extend(core_knots.iter().map(|&(a, b)| (a + pre as f64, b + pre_out as f64)));
        let lead = h.min(pre_out).min(o0);
        let n_full = pre_out + d + h;
        let glide_from = match prev {
            Some((end, midi, true)) if f0.is_some() && seg.out_start_sec - end < 0.06 => ((midi - seg.midi) * 100.0).clamp(-1200.0, 1200.0),
            _ => 0.0,
        };
        let glide_sec = glide.min(0.5 * seg.dur_sec);
        let rendered = match f0 {
            None => stretch_mapped(&[src], sr, &knots, n_full, 0.0, true, Profile::Tones, &cancel),
            Some(median) => {
                let cont = contour(&frames, median);
                let dur = seg.dur_sec;
                let (pre_f, pre_o) = (pre as f64, pre_out as f64);
                let curve = |o: usize| {
                    let t_in = (map_out_to_in(&knots, o as f64) - pre_f) / hop;
                    let k = t_in.clamp(0.0, (cont.len().max(1) - 1) as f64);
                    let (i0, fr) = (k.floor() as usize, k - k.floor());
                    let c = match (cont.get(i0), cont.get(i0 + 1)) {
                        (Some(a), Some(b)) => a + (b - a) * fr,
                        (Some(a), None) => *a,
                        _ => 0.0,
                    };
                    let t_note = ((o as f64 - pre_o) / sr).max(0.0);
                    shift + (pitch_curve(t_note, dur, glide_from, glide_sec, vibrato) - c) / 100.0
                };
                stretch_mapped_curve(&[src], sr, &knots, n_full, &curve, true, Profile::Tones, &cancel)
            }
        }
        .map_err(stretch_err)?;
        let full = rendered.into_iter().next().unwrap_or_default();
        let mut y: Vec<f32> = full[pre_out - lead..].to_vec();
        let fade_in = lead + h;
        for (k, v) in y.iter_mut().take(fade_in).enumerate() {
            *v *= (std::f64::consts::FRAC_PI_2 * k as f64 / fade_in as f64).sin() as f32;
        }
        let n = y.len();
        let fade_out = (2 * h).min(n);
        for k in 0..fade_out {
            y[n - fade_out + k] *= (std::f64::consts::FRAC_PI_2 * (k + 1) as f64 / fade_out as f64).cos() as f32;
        }
        let at = o0 - lead;
        for (k, v) in y.iter().enumerate() {
            if let Some(o) = out.get_mut(at + k) {
                *o += *v;
            }
        }
        result.push(SungSegment { f0_hz: f0, shift_st: shift as f32 });
        prev = Some((seg.out_start_sec + seg.dur_sec, seg.midi, f0.is_some()));
        ctx.progress("singing", (i + 1) as f32 / segments.len() as f32);
    }
    let peak = out.iter().fold(0f32, |m, v| m.max(v.abs()));
    if peak > 0.0 {
        let g = (PEAK_TARGET / peak).min(MAX_GAIN);
        out.iter_mut().for_each(|v| *v *= g);
    }
    Ok((out, result))
}

#[cfg(test)]
mod tests;
