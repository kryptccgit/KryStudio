use super::build::{self, JobResult};
use super::set::{tail_fade_frames, to_i16, MsSample, MultiSampleSet};
use super::sfz;
use crate::decode::{decode_file, is_mf_extension, open_format, read_wav_root_key, MAX_FRAMES};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::TrackType;

pub const DEFAULT_RAM_CAP_BYTES: u64 = 600 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct LoadOptions {
    pub ram_cap_bytes: u64,
    pub threads: usize,
}

impl Default for LoadOptions {
    fn default() -> Self {
        Self { ram_cap_bytes: DEFAULT_RAM_CAP_BYTES, threads: 0 }
    }
}

pub fn is_sfz(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("sfz"))
}

fn display_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

fn mb(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

pub fn load_set(path: &Path, opts: &LoadOptions) -> Result<MultiSampleSet, String> {
    if is_sfz(path) {
        return load_sfz(path, opts);
    }
    let t0 = Instant::now();
    let d = decode_file(path)?;
    let mut set = MultiSampleSet::from_sample_data(&display_name(path), &d);
    let bytes = set.bytes() as u64;
    if bytes > opts.ram_cap_bytes {
        return Err(format!("{} needs {:.0} MB of RAM, over the {:.0} MB limit per instrument", set.name, mb(bytes), mb(opts.ram_cap_bytes)));
    }
    set.load_ms = t0.elapsed().as_secs_f64() * 1000.0;
    Ok(set)
}

enum JobErr {
    Missing,
    Failed(String),
    OverCap,
}

fn decode_range(path: &Path, offset: u64, end: Option<u64>, budget: &(dyn Fn(u64) -> bool + Sync)) -> Result<MsSample, JobErr> {
    if !path.is_file() {
        return Err(JobErr::Missing);
    }
    if !is_mf_extension(path) {
        match decode_range_symphonia(path, offset, end, budget) {
            Err(JobErr::Failed(e)) => {
                return decode_range_whole(path, offset, end, budget).map_err(|e2| match e2 {
                    JobErr::Failed(_) => JobErr::Failed(e),
                    other => other,
                })
            }
            other => return other,
        }
    }
    decode_range_whole(path, offset, end, budget)
}

fn decode_range_whole(path: &Path, offset: u64, end: Option<u64>, budget: &(dyn Fn(u64) -> bool + Sync)) -> Result<MsSample, JobErr> {
    let d = decode_file(path).map_err(JobErr::Failed)?;
    let frames = d.frames() as u64;
    let a = offset.min(frames) as usize;
    let b = (end.unwrap_or(frames).min(frames) as usize).max(a);
    let ch = d.channels.len().clamp(1, 2) as u64;
    if !budget((b - a) as u64 * ch * 2) {
        return Err(JobErr::OverCap);
    }
    let chans: Vec<&[f32]> = d.channels.iter().take(2).map(|c| &c[a..b]).collect();
    Ok(MsSample::from_planar(&chans, d.sample_rate, d.root_key, (b as u64) < frames))
}

fn decode_range_symphonia(path: &Path, offset: u64, end: Option<u64>, budget: &(dyn Fn(u64) -> bool + Sync)) -> Result<MsSample, JobErr> {
    let mut format = open_format(path).map_err(JobErr::Failed)?;
    let track = format.default_track(TrackType::Audio).ok_or_else(|| JobErr::Failed(format!("No audio track in {}", path.display())))?;
    let track_id = track.id;
    let total = track.num_frames;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|c| c.audio())
        .ok_or_else(|| JobErr::Failed(format!("No audio codec parameters in {}", path.display())))?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| JobErr::Failed(format!("No decoder for {}: {e}", path.display())))?;
    let mut sample_rate = params.sample_rate.unwrap_or(0);
    let limit = end.unwrap_or(u64::MAX).min(offset.saturating_add(MAX_FRAMES as u64));
    let mut ch: usize = params.channels.as_ref().map(|c| c.count()).unwrap_or(0).min(2);
    let mut charged = 0u64;
    if let (Some(t), true) = (total, ch > 0) {
        charged = limit.min(t).saturating_sub(offset) * ch as u64 * 2;
        if !budget(charged) {
            return Err(JobErr::OverCap);
        }
    }
    let mut data: Vec<i16> = Vec::with_capacity((charged / 2) as usize);
    let mut scratch: Vec<Vec<f32>> = Vec::new();
    let mut pos: u64 = 0;
    let mut truncated = false;
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(SymError::ResetRequired) => break,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                if pos == 0 {
                    return Err(JobErr::Failed(format!("Failed to read {}: {e}", path.display())));
                }
                break;
            }
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                if sample_rate == 0 {
                    sample_rate = buf.spec().rate();
                }
                buf.copy_to_vecs_planar::<f32>(&mut scratch);
                if scratch.is_empty() {
                    continue;
                }
                if ch == 0 {
                    ch = scratch.len().min(2);
                }
                let n = scratch.iter().map(|c| c.len()).min().unwrap_or(0) as u64;
                let from = offset.saturating_sub(pos).min(n);
                let to = limit.saturating_sub(pos).min(n);
                for i in from..to {
                    for c in 0..ch {
                        let src = scratch.get(c).unwrap_or(&scratch[0]);
                        data.push(to_i16(src[i as usize]));
                    }
                }
                pos += n;
                if pos >= limit {
                    truncated = total.is_none_or(|t| t > limit);
                    break;
                }
            }
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => {
                if pos == 0 {
                    return Err(JobErr::Failed(format!("Failed to decode {}: {e}", path.display())));
                }
                break;
            }
        }
    }
    if ch == 0 || sample_rate == 0 {
        return Err(JobErr::Failed(format!("{} contains no decodable audio", path.display())));
    }
    let bytes = (data.len() * 2) as u64;
    if bytes > charged && !budget(bytes - charged) {
        return Err(JobErr::OverCap);
    }
    data.shrink_to_fit();
    let frames = data.len() / ch;
    let root_key = read_wav_root_key(path);
    Ok(MsSample { data, channels: ch, frames, sample_rate: sample_rate as f32, root_key, tail_fade: tail_fade_frames(frames, sample_rate as f32, truncated) })
}

pub fn load_sfz(path: &Path, opts: &LoadOptions) -> Result<MultiSampleSet, String> {
    let t0 = Instant::now();
    let name = display_name(path);
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let parsed = sfz::parse(&String::from_utf8_lossy(&bytes));
    if parsed.regions.is_empty() {
        let why = parsed.warnings.first().map(|w| format!(" ({w})")).unwrap_or_default();
        return Err(format!("{name} has no playable <region>{why}"));
    }
    let plan = build::plan(&parsed);
    let base = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let files: Vec<PathBuf> = plan
        .jobs
        .iter()
        .map(|j| {
            let mut f = base.clone();
            for part in j.sample.split('/').filter(|p| !p.is_empty() && *p != ".") {
                f.push(part);
            }
            f
        })
        .collect();

    let used = AtomicU64::new(0);
    let over = AtomicBool::new(false);
    let next = AtomicUsize::new(0);
    let cap = opts.ram_cap_bytes;
    let budget = |b: u64| {
        let now = used.fetch_add(b, Ordering::Relaxed) + b;
        if now > cap {
            over.store(true, Ordering::Relaxed);
            false
        } else {
            true
        }
    };
    let threads = match opts.threads {
        0 => std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8),
        n => n,
    }
    .clamp(1, plan.jobs.len().max(1));
    let mut results: Vec<Option<Result<MsSample, JobErr>>> = (0..plan.jobs.len()).map(|_| None).collect();
    std::thread::scope(|s| {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                s.spawn(|| {
                    let mut done: Vec<(usize, Result<MsSample, JobErr>)> = Vec::new();
                    while !over.load(Ordering::Relaxed) {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let (Some(job), Some(file)) = (plan.jobs.get(i), files.get(i)) else { break };
                        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decode_range(file, job.offset, job.end, &budget)))
                            .unwrap_or_else(|_| Err(JobErr::Failed(format!("The decoder crashed on {}", file.display()))));
                        done.push((i, res));
                    }
                    done
                })
            })
            .collect();
        for h in handles {
            if let Ok(done) = h.join() {
                for (i, r) in done {
                    results[i] = Some(r);
                }
            }
        }
    });
    if over.load(Ordering::Relaxed) {
        return Err(format!(
            "{name} needs more than {:.0} MB of RAM (the limit per instrument), so it was not loaded; trim long samples with end= or map fewer layers",
            mb(cap)
        ));
    }
    let results: Vec<JobResult> = results
        .into_iter()
        .zip(&files)
        .map(|(r, f)| match r {
            Some(Ok(s)) => JobResult::Ok(s),
            Some(Err(JobErr::Missing)) => JobResult::Missing,
            Some(Err(JobErr::Failed(e))) => JobResult::Failed(e),
            Some(Err(JobErr::OverCap)) | None => JobResult::Failed(format!("{} was not decoded", f.display())),
        })
        .collect();
    build::assemble(&name, &parsed, &plan, results, t0.elapsed().as_secs_f64() * 1000.0)
}
