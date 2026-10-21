//! `analyze`: tempo, beats, key, chords, swing, sections, loudness, stereo,
//! energy, and (on request) drum hits.
//!
//! Pipeline (all on a 22 050 Hz mono mix except loudness/levels/stereo,
//! which use the file's own channels and rate):
//! levels (engine analysis) → onset envelopes → chroma → tempo (DSP) →
//! beats + downbeats (Beat This! small when `beatModelDir` is given, else
//! the DSP tracker) → key → chords → swing → sections → energy curve.
//! Drum hits (`drums`) run on their own thread from the same mono mix.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use crate::audio::{self, ANALYSIS_SR};
use crate::features::{self, Onsets};
use crate::key::{self, cosine, Chroma};
use crate::loudness::Loudness;
use crate::onnx::{CancelledInModel, RtenModel};
use crate::protocol::{AnalyzeArgs, AudioAnalysis, Beats, Energy, Key, Section, Stereo, Tempo};
use crate::{chords, drums, sections, tempo, transcribe, JobCtx, JobError};

pub const BEAT_MEL_FILE: &str = "mel_spectrogram.onnx";
pub const BEAT_MODEL_FILE: &str = "beat_this_small.onnx";

/// Energy curve hop (seconds).
pub const ENERGY_HOP_SEC: f32 = 0.5;

#[derive(Debug, Clone, Default)]
pub struct Options {
    pub sections: bool,
    pub beat_model_dir: Option<PathBuf>,
    /// Also transcribe drum hits (as `transcribe` mode 'drums', default sensitivity).
    pub drums: bool,
}

pub fn run(args: &AnalyzeArgs, ctx: &JobCtx) -> Result<AudioAnalysis, JobError> {
    ctx.progress("decoding", -1.0);
    let data = audio::load(&args.path)?;
    ctx.check()?;
    let opts = Options { sections: args.sections, beat_model_dir: args.beat_model_dir.as_ref().filter(|d| !d.trim().is_empty()).map(PathBuf::from), drums: args.drums };
    analyze_channels(&args.path, &data.channels, data.sample_rate, &opts, ctx)
}

/// Round to milliseconds (compact JSON, no false precision).
pub(crate) fn ms(x: f32) -> f32 {
    if x.is_finite() {
        (x * 1000.0).round() / 1000.0
    } else {
        0.0
    }
}

fn r2(x: f32) -> f32 {
    if x.is_finite() {
        (x * 100.0).round() / 100.0
    } else {
        0.0
    }
}

struct ModelBeats {
    beats: Vec<f32>,
    downbeats: Vec<f32>,
    /// Mean beat probability at the detected beats (0..1).
    clarity: f32,
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// Beat This! small (CPJKU, MIT) through the beat-this crate's pipeline on rten.
fn model_beats(dir: &Path, x22: &[f32], ctx: &JobCtx, p0: f32, p1: f32) -> Result<ModelBeats, JobError> {
    let mel_frames = x22.len() / 441 + 1;
    let expected = (mel_frames.div_ceil(1536) + mel_frames.div_ceil(1488)).max(1);
    let done = Arc::new(AtomicUsize::new(0));
    let progress = {
        let ctx = ctx.clone();
        let done = done.clone();
        move |_: usize| {
            let k = done.fetch_add(1, Ordering::Relaxed);
            ctx.progress("analyzing", p0 + (p1 - p0) * (k as f32 / expected as f32).min(1.0));
        }
    };
    let mel = RtenModel::load(&dir.join(BEAT_MEL_FILE), "Beat This! mel")?.with_ctx(ctx);
    let net = RtenModel::load(&dir.join(BEAT_MODEL_FILE), "Beat This!")?.with_ctx(ctx).on_run(progress);
    let mut bt = beat_this::BeatThis::from_models(mel, net);
    let a = bt.analyze_audio(x22, ANALYSIS_SR).map_err(|e| {
        if e.downcast_ref::<CancelledInModel>().is_some() || ctx.cancelled() {
            JobError::Cancelled
        } else {
            JobError::Failed(format!("Beat tracking failed ({}): {e}", dir.display()))
        }
    })?;
    // Logits are at 50 fps.
    let clarity = if a.beats.is_empty() {
        0.0
    } else {
        a.beats.iter().map(|&t| a.beat_logits.get((t * 50.0).round() as usize).map(|&l| sigmoid(l)).unwrap_or(0.0)).sum::<f32>() / a.beats.len() as f32
    };
    Ok(ModelBeats { beats: a.beats, downbeats: a.downbeats, clarity })
}

/// Stage timings on stderr when `KRYPT_ANALYZER_TIMING` is set (diagnostics).
fn timing(stage: &str, since: std::time::Instant) {
    if std::env::var_os("KRYPT_ANALYZER_TIMING").is_some() {
        eprintln!("analyzer timing: {stage} {:.3} s", since.elapsed().as_secs_f32());
    }
}

/// Harmonic change at each beat: cosine distance between the chroma of the
/// beat before and the beat after.
fn harmonic_change(chroma: &Chroma, beats: &[f32]) -> Vec<f32> {
    (0..beats.len())
        .map(|i| {
            let prev = if i > 0 { beats[i - 1] } else { (beats[i] - 0.5).max(0.0) };
            let next = if i + 1 < beats.len() { beats[i + 1] } else { beats[i] + 0.5 };
            let a = chroma.mean_between(prev, beats[i]);
            let b = chroma.mean_between(beats[i], next);
            1.0 - cosine(&a, &b)
        })
        .collect()
}

/// Analyse decoded audio. `channels` are at `sr` (1 or 2 channels).
pub fn analyze_channels(path: &str, channels: &[Vec<f32>], sr: f32, opts: &Options, ctx: &JobCtx) -> Result<AudioAnalysis, JobError> {
    let has_model = opts.beat_model_dir.is_some();
    // Progress: with a beat model, the model reports 0.05..0.85 while the DSP
    // front end runs alongside it silently; without one, the DSP stages do.
    let front = if has_model { 0.05 } else { 0.3 };
    let dsp_step = |f: f32| {
        if !has_model {
            ctx.progress("analyzing", f);
        }
    };
    ctx.progress("analyzing", 0.0);
    let n = channels.iter().map(|c| c.len()).min().unwrap_or(0);
    if n == 0 || channels.is_empty() {
        return Err(JobError::Failed(format!("{path} contains no audio")));
    }
    let duration = n as f32 / sr;
    let left = &channels[0][..n];
    let right = if channels.len() > 1 { &channels[1][..n] } else { left };
    let x = audio::resample(&audio::mono(channels), sr, ANALYSIS_SR);
    ctx.check()?;
    dsp_step(0.05);
    let fsr = ANALYSIS_SR as f32;

    // The beat model (seconds of work) runs on its own thread while the DSP
    // front end runs here.
    let (model_res, drum_res, dsp) = std::thread::scope(|scope| {
        let model_thread = opts.beat_model_dir.as_ref().map(|dir| {
            let x = &x;
            scope.spawn(move || {
                let t = std::time::Instant::now();
                let r = model_beats(dir, x, ctx, front, 0.85);
                timing("beat model", t);
                r
            })
        });
        // Drum hits: the same algorithm and default as `transcribe` 'drums'.
        let drum_thread = opts.drums.then(|| {
            let x = &x;
            scope.spawn(move || {
                let t = std::time::Instant::now();
                let r = drums::transcribe(x, fsr, &drums::DrumParams { sensitivity: transcribe::DRUM_ONSET_THRESHOLD }, ctx);
                timing("drum hits", t);
                r
            })
        });
        let t_dsp = std::time::Instant::now();
        let dsp = (|| -> Result<_, JobError> {
            // ── measured: levels, stereo, loudness ──
            let levels = krypt_studio_dsp::analysis::analyze(left, right, sr);
            let (mut em, mut es) = (0f64, 0f64);
            for i in 0..n {
                let (l, r) = (left[i] as f64, right[i] as f64);
                if l.is_finite() && r.is_finite() {
                    em += (0.5 * (l + r)).powi(2);
                    es += (0.5 * (l - r)).powi(2);
                }
            }
            let width = if em > 1e-12 { (es / em).min(1.0) as f32 } else if es > 1e-12 { 1.0 } else { 0.0 };
            let stereo = Stereo { width: r2(width), correlation: r2(levels.stereo_correlation.clamp(-1.0, 1.0)) };
            let chans: Vec<&[f32]> = if channels.len() > 1 { vec![left, right] } else { vec![left] };
            let loud = Loudness::measure(&chans, sr);
            ctx.check()?;
            dsp_step(0.12);
            // ── front end at 22 050 Hz ──
            let ons: Onsets = features::onsets(&x, fsr, ctx)?;
            dsp_step(0.2);
            let chroma = key::chroma(&x, fsr, ctx)?;
            dsp_step(front);
            timing("dsp front end", t_dsp);
            Ok((levels, stereo, loud, ons, chroma))
        })();
        let model_res = model_thread.map(|h| match h.join() {
            Ok(r) => r,
            Err(p) => std::panic::resume_unwind(p),
        });
        let drum_res = drum_thread.map(|h| match h.join() {
            Ok(r) => r,
            Err(p) => std::panic::resume_unwind(p),
        });
        (model_res, drum_res, dsp)
    });
    let (levels, stereo, loud, ons, chroma) = dsp?;
    let drum_hits = drum_res.transpose()?;
    let fps = ons.fps;

    let mut sources: Vec<String> = vec!["levels: EBU R128 (ebur128) + krypt-dsp spectrum".into()];
    let mut estimated: Vec<String> = Vec::new();

    // ── tempo + beats ──
    let dsp_tempo = tempo::estimate_tempo(&ons.env, fps, ons.onsets.len());
    let mut model: Option<ModelBeats> = None;
    // Same "is there a pulse at all" gate as the DSP tempo: ≥ 0.75 onsets/s.
    let pulse_possible = ons.onsets.len() as f32 >= 0.75 * duration;
    match model_res {
        None => {}
        Some(Ok(m)) if m.beats.len() >= 8 && m.clarity >= 0.25 && pulse_possible => model = Some(m),
        Some(Ok(_)) => sources.push("beat model found no steady pulse".into()),
        Some(Err(JobError::Cancelled)) => return Err(JobError::Cancelled),
        Some(Err(JobError::Failed(m))) => {
            ctx.log("warn", format!("{m}; using DSP beat tracking instead"));
            sources.push(format!("beat model unavailable ({m}); DSP fallback"));
        }
    }
    ctx.check()?;
    let after_model = if has_model { 0.85 } else { front };
    let step = |f: f32| ctx.progress("analyzing", f);
    step(after_model);

    let mut tempo_out: Option<Tempo> = None;
    let mut beats_out: Option<Beats> = None;
    let mut beat_frames: Vec<f32> = Vec::new();
    // Onset times (s), for extending beat grids into sparse edges.
    let lat = features::onset_latency(1024, ANALYSIS_SR as f32);
    let onset_secs: Vec<f32> = ons.onsets.iter().map(|&f| f as f32 / fps + lat).collect();
    if let Some(m) = model {
        let bpm = tempo::bpm_from_beats(&m.beats).unwrap_or(0.0);
        if bpm > 0.0 {
            let period = 60.0 / bpm;
            // Regularity: how far the model's intervals sit from whole periods.
            let dev: Vec<f32> = m.beats.windows(2).map(|w| {
                let d = w[1] - w[0];
                (d - (d / period).round().max(1.0) * period).abs() / period
            }).collect();
            let regular = (1.0 - features::mean(&dev) / 0.1).clamp(0.0, 1.0);
            let conf = (0.6 * m.clarity + 0.4 * regular).clamp(0.0, 1.0);
            tempo_out = Some(Tempo { bpm: r2(bpm), confidence: r2(conf), alternatives: alternatives(bpm, dsp_tempo.as_ref()) });
            // Beat This! can fall to half time for a stretch (a sparse intro) or
            // drop beats: fill the grid at the tracked tempo.
            let beats = tempo::smooth_beats(&tempo::regularize_beats(&m.beats, period, &onset_secs, duration), 4);
            let nearest = |t: f32| -> Option<usize> {
                let i = beats.partition_point(|&b| b < t);
                [i.saturating_sub(1), i.min(beats.len() - 1)].into_iter().min_by(|&x, &y| (beats[x] - t).abs().total_cmp(&(beats[y] - t).abs())).filter(|&j| (beats[j] - t).abs() < 0.25 * period)
            };
            let mut idx: Vec<usize> = m.downbeats.iter().filter_map(|&d| nearest(d)).collect();
            idx.dedup();
            // Bar length: most common beat count between consecutive downbeats
            // (2..7; 8..14 count as two bars), default 4.
            let mut counts = [0u32; 8];
            for w in idx.windows(2) {
                let d = w[1] - w[0];
                if (2..=7).contains(&d) {
                    counts[d] += 1;
                } else if d % 2 == 0 && (8..=14).contains(&d) {
                    counts[d / 2] += 1;
                }
            }
            let mut bpb = counts.iter().enumerate().max_by_key(|(_, &n)| n).filter(|(_, &n)| n > 0).map(|(i, _)| i).unwrap_or(4);
            // One consistent bar phase: the most common downbeat index mod bpb.
            let phase_of = |bpb: usize| -> usize {
                let mut votes = vec![0u32; bpb];
                for &i in &idx {
                    votes[i % bpb] += 1;
                }
                votes.iter().enumerate().max_by_key(|(_, &n)| n).map(|(i, _)| i).unwrap_or(0)
            };
            let mut phase = phase_of(bpb);
            if bpb == 2 {
                // 2/4 readings are nearly always 4/4 with a strong beat 3: pick the
                // half with more harmonic change and low-end weight (first on a tie).
                let low = |t: f32| -> f32 {
                    let c = ((t - lat) * fps).round() as i64;
                    (c - 2..=c + 2).filter(|&k| k >= 0 && (k as usize) < ons.low.len()).map(|k| ons.low[k as usize]).fold(0.0, f32::max)
                };
                let cand = |ph: usize| -> Vec<f32> { (ph..beats.len()).step_by(4).map(|i| beats[i]).collect() };
                let score = |ph: usize| -> f32 {
                    let d = cand(ph);
                    if d.is_empty() {
                        return 0.0;
                    }
                    let change = harmonic_change(&chroma, &d);
                    let lmax = beats.iter().map(|&t| low(t)).fold(1e-9, f32::max);
                    d.iter().zip(&change).map(|(&t, c)| c + 0.5 * low(t) / lmax).sum::<f32>() / d.len() as f32
                };
                if score(phase + 2) > score(phase) * 1.05 {
                    phase += 2;
                }
                bpb = 4;
            }
            let downbeats: Vec<f32> = (phase..beats.len()).step_by(bpb).map(|i| beats[i]).collect();
            beat_frames = beats.iter().map(|t| t * fps).collect();
            beats_out = Some(Beats { times: beats.iter().map(|&t| ms(t)).collect(), downbeats: downbeats.iter().map(|&t| ms(t)).collect(), beats_per_bar: bpb as u32 });
            sources.push("tempo, beats, downbeats: Beat This! small (CPJKU, MIT) on rten; grid gaps filled at the tracked tempo".into());
        }
    }
    if tempo_out.is_none() {
        if let Some(t) = &dsp_tempo {
            let period = 60.0 * fps / t.bpm;
            let frames = tempo::track_beats(&ons.env, period, 100.0);
            let times: Vec<f32> = frames.iter().map(|f| f / fps + lat).collect();
            let mut bpm = t.bpm;
            if let Some(b) = tempo::bpm_from_beats(&times) {
                if (b / t.bpm - 1.0).abs() < 0.03 {
                    bpm = b;
                }
            }
            tempo_out = Some(Tempo { bpm: r2(bpm), confidence: r2(t.confidence), alternatives: t.alternatives.iter().map(|&a| r2(a)).collect() });
            sources.push("tempo: krypt-dsp onset autocorrelation".into());
            if times.len() >= 4 {
                // The tracker trims weak edge beats; extend the grid while it
                // keeps landing on onsets (a hats-only intro or outro).
                let times = tempo::smooth_beats(&tempo::regularize_beats(&times, 60.0 / bpm, &onset_secs, duration), 4);
                let frames: Vec<f32> = times.iter().map(|t| (t - lat) * fps).collect();
                let change = harmonic_change(&chroma, &times);
                let (down_idx, bpb) = tempo::downbeats_dsp(&frames, &ons.low, &ons.env, &change);
                beats_out = Some(Beats { times: times.iter().map(|&t| ms(t)).collect(), downbeats: down_idx.iter().map(|&i| ms(times[i])).collect(), beats_per_bar: bpb });
                beat_frames = frames;
                sources.push("beats: krypt-dsp dynamic-programming tracker; downbeats: bar-phase heuristic (rough)".into());
            }
        }
    }
    if tempo_out.is_some() {
        estimated.push("tempo".into());
    }
    if beats_out.is_some() {
        estimated.push("beats".into());
    }
    ctx.check()?;

    // ── key + chords ──
    // Chords need a key-able (tonal) file: drum stems with pitched kicks and
    // tuned rolls pass the chroma gates but not the profile fit. Key-neutral
    // chords re-rank near-tied keys by harmonic function; the reported
    // chords then use the final key.
    let t_chords = std::time::Instant::now();
    let key_guess = if key::detect_key(&chroma).is_some() {
        let neutral = chords::estimate_full(&chroma, beats_out.as_ref(), None, duration);
        key::detect_key_with_chords(&chroma, &neutral.spans, &neutral.bass_share)
    } else {
        None
    };
    let chords_out = match &key_guess {
        Some(k) => chords::estimate(&chroma, beats_out.as_ref(), Some((k.tonic_pc, k.minor)), duration),
        None => Vec::new(),
    };
    timing("chords", t_chords);
    let pitch_profile = {
        let total = key::total_chroma(&chroma);
        let sum: f32 = total.iter().sum();
        (sum.is_finite() && sum > 1e-9).then(|| total.iter().map(|v| (v / sum * 1000.0).round() / 1000.0).collect::<Vec<f32>>())
    };
    let key_out = key_guess.as_ref().map(|k| Key {
        tonic: key::tonic_name(k.tonic_pc, k.minor).to_string(),
        mode: if k.minor { "minor".into() } else { "major".into() },
        name: key::key_name(k.tonic_pc, k.minor),
        confidence: r2(k.confidence),
    });
    if let Some(k) = &key_guess {
        estimated.push("key".into());
        sources.push(if k.reranked {
            "key: Krumhansl-Kessler profiles on harmonic chroma; near-tied keys re-ranked by the chords' harmonic function".into()
        } else {
            "key: Krumhansl-Kessler profiles on harmonic chroma".into()
        });
    }
    if !chords_out.is_empty() {
        estimated.push("chords".into());
        sources.push("chords: template matching on beat-synchronous harmonic chroma, bass-aware Viterbi smoothing".into());
    }
    if drum_hits.is_some() {
        estimated.push("drumHits".into());
        sources.push("drumHits: krypt-dsp band-split onsets (as transcribe 'drums')".into());
    }
    step(after_model + (1.0 - after_model) * 0.3);

    // ── swing ──
    // Swing lives mostly in hats/percussion: broadband flux + high-region rise.
    let swing_env: Vec<f32> = {
        let (m1, m2) = (ons.env.iter().cloned().fold(1e-9, f32::max), ons.rise[2].iter().cloned().fold(1e-9, f32::max));
        ons.env.iter().zip(&ons.rise[2]).map(|(a, b)| a / m1 + b / m2).collect()
    };
    let swing = if beat_frames.len() >= 8 { tempo::swing(&swing_env, fps, &beat_frames).map(r2) } else { None };
    if swing.is_some() {
        estimated.push("swing".into());
    }
    ctx.check()?;

    // ── sections ──
    let mut sections_out = Vec::new();
    if opts.sections {
        let (grid, bars, fpb): (Vec<f32>, Vec<f32>, usize) = match &beats_out {
            Some(b) if b.times.len() >= 16 => {
                let mut g = Vec::with_capacity(b.times.len() + 2);
                if b.times[0] > 0.05 {
                    g.push(0.0);
                }
                g.extend(b.times.iter().copied());
                if *g.last().unwrap() < duration - 0.05 {
                    g.push(duration);
                }
                (g, b.downbeats.clone(), b.beats_per_bar.max(2) as usize)
            }
            _ => {
                let steps = (duration / 0.5).ceil() as usize;
                ((0..=steps).map(|i| (i as f32 * 0.5).min(duration)).collect(), Vec::new(), 4)
            }
        };
        let segs = sections::segment(&sections::SegInput { grid: &grid, bars: &bars, frames_per_bar: fpb, chroma: &chroma, band_db: &ons.band_db, band_fps: fps, duration });
        sections_out = segs.into_iter().map(|(a, b, label)| Section { start_sec: ms(a), end_sec: ms(b), label, lufs: r2(loud.integrated(a, b)) }).collect();
        if !sections_out.is_empty() {
            estimated.push("sections".into());
            sources.push("sections: Foote novelty on beat-synchronous chroma/timbre".into());
        }
    }
    ctx.check()?;
    step(after_model + (1.0 - after_model) * 0.8);

    // ── energy + onset rate ──
    let energy = Energy { hop_sec: ENERGY_HOP_SEC, lufs: loud.short_term_curve(ENERGY_HOP_SEC, duration).into_iter().map(r2).collect() };
    let onset_rate = if duration > 0.0 { r2(ons.onsets.len() as f32 / duration) } else { 0.0 };
    step(1.0);

    Ok(AudioAnalysis {
        path: path.to_string(),
        duration_sec: ms(duration),
        sample_rate: sr.round() as u32,
        channels: channels.len().min(2) as u32,
        tempo: tempo_out,
        beats: beats_out,
        key: key_out,
        pitch_profile,
        swing,
        sections: sections_out,
        levels,
        stereo,
        energy,
        onset_rate,
        chords: chords_out,
        drum_hits,
        estimated,
        sources,
    })
}

/// Half/double readings for a model tempo, the DSP reading's octave first
/// when it disagrees with the model.
fn alternatives(bpm: f32, dsp: Option<&tempo::TempoEstimate>) -> Vec<f32> {
    let mut alts: Vec<f32> = [bpm * 0.5, bpm * 2.0].into_iter().filter(|a| (tempo::MIN_BPM * 0.9..=tempo::MAX_BPM * 1.1).contains(a)).collect();
    if let Some(d) = dsp {
        // Put the alternative closest to the DSP reading first.
        alts.sort_by(|a, b| (a / d.bpm).ln().abs().total_cmp(&(b / d.bpm).ln().abs()));
    }
    alts.into_iter().map(r2).collect()
}
