use crate::compile::{SampleMode, Session};
use crate::core::{Core, Shared};
use crate::model::Model;
use crate::plugins::PluginHost;
use crate::program::NONE;
use crate::protocol::{Mp3RenderInfo, RenderRequest, RenderResult, RenderScope, StemResult};
use krypt_studio_dsp::mp3;
use crate::samples::SampleCache;
use crate::time::{bar_ticks, pattern_length, ticks_to_seconds};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct RenderEnv<'a> {
    pub host: PluginHost,
    pub cache: Arc<SampleCache>,
    pub factory_dir: PathBuf,
    pub packs_dir: Option<PathBuf>,
    pub base_dir: Option<PathBuf>,
    pub cancel: Arc<AtomicBool>,
    pub default_sr: f64,
    pub progress: &'a mut dyn FnMut(f64),
    pub log: &'a mut dyn FnMut(&str, String),
}

pub struct Rendered {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub sample_rate: f32,
    pub gain_reduction: Vec<crate::meters::GrStat>,
}

const BLOCK: usize = 512;
const MAX_SECONDS: f64 = 7200.0;

pub fn render_audio(model: &Model, req: &RenderRequest, env: &mut RenderEnv) -> Result<Rendered, String> {
    render_inner(model, req, env, None).map(|(a, _)| a)
}

struct StemPlan<'a> {
    wanted: Option<&'a [String]>,
    dir: PathBuf,
    mem_budget: usize,
    progress_share: f64,
}

fn render_inner(model: &Model, req: &RenderRequest, env: &mut RenderEnv, stems: Option<&StemPlan>) -> Result<(Rendered, Vec<StemTap>), String> {
    let sr = req.sample_rate.filter(|s| s.is_finite() && *s >= 8000.0 && *s <= 384000.0).unwrap_or(env.default_sr) as f32;
    let mut session = Session::new(env.host, sr, env.cache.clone(), env.factory_dir.clone(), SampleMode::Sync);
    session.base_dir = env.base_dir.clone();
    session.packs_dir = env.packs_dir.clone();
    session.cancel = env.cancel.clone();
    session.model = model.clone();
    session.version = 1;
    let batch = session.build(true);
    for (level, msg) in session.logs.drain(..) {
        (env.log)(level, msg);
    }
    let program = batch.program.as_ref().ok_or("internal: no program")?;
    let ts = &model.transport;
    let bar = bar_ticks(ts.time_sig.num, ts.time_sig.den);
    let bpm_doc = program.transport.bpm;

    let (song, start, pslot, ticks) = match &req.scope {
        RenderScope::Song => (true, 0.0, NONE, program.song_end.max(bar)),
        RenderScope::Range { start_tick, end_tick } => {
            if !(end_tick > start_tick) || *start_tick < 0.0 {
                return Err(format!("Invalid render range {start_tick}..{end_tick}"));
            }
            (true, *start_tick, NONE, end_tick - start_tick)
        }
        RenderScope::Pattern { pattern_id } => {
            let pid = pattern_id.clone().or_else(|| ts.active_pattern_id.clone()).ok_or("No pattern to render: pass patternId or set an active pattern")?;
            let pat = model.patterns.get(&pid).ok_or_else(|| format!("Pattern {pid} not found"))?;
            let slot = session.names.patterns.iter().find(|(_, id)| *id == pid).map(|(s, _)| *s).ok_or_else(|| format!("Pattern {pid} not found"))?;
            let loops = req.loops.filter(|l| l.is_finite() && *l >= 1.0).unwrap_or(1.0).round();
            (false, 0.0, slot, pattern_length(pat, ts.time_sig.num, ts.time_sig.den) * loops)
        }
    };
    let tail = req.tail_sec.filter(|t| t.is_finite() && *t >= 0.0).unwrap_or(2.0).min(60.0);
    let est_frames = (ticks_to_seconds(ticks, bpm_doc) * sr as f64).max(1.0) + tail * sr as f64;
    let max_frames = (MAX_SECONDS * sr as f64) as usize;

    let shared = Arc::new(Shared::new());
    let mut gr = crate::meters::GrAccum::new(&session.names.fx);
    let mut core = Core::new(sr, shared.clone(), None, None, None);
    core.apply_batch_now(batch);
    core.start_render(song, start, pslot, ticks);
    let mut taps = match stems {
        Some(plan) => plan_taps(model, &session.names.inserts, &core.stem_alignment(), plan, est_frames as usize, env)?,
        None => Vec::new(),
    };
    let tap_slots: Vec<u32> = taps.iter().map(|t| t.slot).collect();
    let mut tap_err: Option<String> = None;
    let share = stems.map(|p| p.progress_share).unwrap_or(1.0);

    let mut left: Vec<f32> = Vec::with_capacity(est_frames as usize + BLOCK);
    let mut right: Vec<f32> = Vec::with_capacity(est_frames as usize + BLOCK);
    let mut l = vec![0f32; BLOCK];
    let mut r = vec![0f32; BLOCK];
    let tail_frames = (tail * sr as f64).round() as usize;
    let mut end_frame: Option<usize> = None;
    let mut last_progress = std::time::Instant::now();
    loop {
        if env.cancel.load(Ordering::Relaxed) {
            return Err("Render cancelled".into());
        }
        if taps.is_empty() {
            core.process_stereo(&mut l, &mut r);
        } else {
            core.process_stereo_tapped(&mut l, &mut r, &tap_slots, &mut |i, tl, tr| {
                let t = &mut taps[i];
                t.peak = tl.iter().chain(tr.iter()).fold(t.peak, |m, x| m.max(x.abs()));
                if let Err(e) = t.store.push(tl, tr) {
                    tap_err.get_or_insert(e);
                }
            });
            if let Some(e) = tap_err.take() {
                return Err(e);
            }
        }
        left.extend_from_slice(&l);
        right.extend_from_slice(&r);
        gr.sample(&shared.meters);
        if end_frame.is_none() {
            if let Some(fe) = core.finished_at() {
                end_frame = Some(fe as usize + tail_frames);
            }
        }
        if let Some(e) = end_frame {
            if left.len() >= e {
                left.truncate(e.max(1));
                right.truncate(e.max(1));
                break;
            }
        }
        if left.len() >= max_frames {
            (env.log)("warn", "Render stopped at the 2 hour safety limit".into());
            break;
        }
        if last_progress.elapsed().as_millis() >= 100 {
            last_progress = std::time::Instant::now();
            (env.progress)((left.len() as f64 / est_frames).min(0.99) * share);
        }
    }
    (env.progress)(share);
    Ok((Rendered { left, right, sample_rate: sr, gain_reduction: gr.finish() }, taps))
}

pub fn write_wav(path: &Path, format: &str, left: &[f32], right: &[f32], sr: u32) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create folder {}: {e}", dir.display()))?;
        }
    }
    let (bits, fmt) = match format {
        "wav16" => (16, hound::SampleFormat::Int),
        "wav24" => (24, hound::SampleFormat::Int),
        "wav32f" => (32, hound::SampleFormat::Float),
        other => return Err(format!("Unknown WAV format '{other}' (use wav16, wav24 or wav32f)")),
    };
    let spec = hound::WavSpec { channels: 2, sample_rate: sr, bits_per_sample: bits, sample_format: fmt };
    let tmp = path.with_extension("wav.part");
    let res = (|| -> Result<(), hound::Error> {
        let mut w = hound::WavWriter::create(&tmp, spec)?;
        match (bits, fmt) {
            (32, hound::SampleFormat::Float) => {
                for i in 0..left.len() {
                    w.write_sample(left[i])?;
                    w.write_sample(right[i])?;
                }
            }
            (16, _) => {
                let mut wr = w.get_i16_writer((left.len() * 2) as u32);
                for i in 0..left.len() {
                    wr.write_sample((left[i].clamp(-1.0, 1.0) * 32767.0).round() as i16);
                    wr.write_sample((right[i].clamp(-1.0, 1.0) * 32767.0).round() as i16);
                }
                wr.flush()?;
            }
            _ => {
                let scale = 8_388_607.0f32;
                for i in 0..left.len() {
                    w.write_sample((left[i].clamp(-1.0, 1.0) * scale).round() as i32)?;
                    w.write_sample((right[i].clamp(-1.0, 1.0) * scale).round() as i32)?;
                }
            }
        }
        w.finalize()
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Cannot write {}: {e}", path.display()));
    }
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("Cannot move render into place at {}: {e}", path.display()))
}

pub fn peak_db(left: &[f32], right: &[f32]) -> f64 {
    let pk = left.iter().chain(right.iter()).fold(0f32, |a, &x| a.max(x.abs()));
    if pk > 0.0 {
        (20.0 * (pk as f64).log10()).max(-120.0)
    } else {
        -120.0
    }
}

fn finite_or(x: f32, d: f64) -> f64 {
    if x.is_finite() {
        x as f64
    } else {
        d
    }
}

pub const NORMALIZE_TARGET_DB: f64 = -0.1;

pub fn normalize_peak(left: &mut [f32], right: &mut [f32], target_db: f64) -> f64 {
    let peak = left.iter().chain(right.iter()).filter(|x| x.is_finite()).fold(0.0f32, |m, x| m.max(x.abs())) as f64;
    if peak < 1e-6 {
        return 1.0;
    }
    let gain = 10f64.powf(target_db / 20.0) / peak;
    for x in left.iter_mut().chain(right.iter_mut()) {
        *x = (*x as f64 * gain) as f32;
    }
    gain
}

pub fn validate_request(req: &RenderRequest) -> Result<(), String> {
    if req.path.trim().is_empty() {
        return Err(if req.stems == Some(true) { "Stem export needs a folder".into() } else { "Render path is empty".into() });
    }
    match req.format.as_str() {
        "wav16" | "wav24" | "wav32f" => {}
        "mp3" => {
            mp3::parse_kbps(req.mp3_kbps)?;
            mp3::check_encoder()?;
        }
        other => return Err(format!("Unknown render format '{other}' (use wav16, wav24, wav32f or mp3)")),
    }
    if let RenderScope::Range { start_tick, end_tick } = req.scope {
        if !(start_tick.is_finite() && end_tick.is_finite() && start_tick >= 0.0 && end_tick > start_tick) {
            return Err(format!("Invalid render range {start_tick}..{end_tick}"));
        }
    }
    Ok(())
}

pub fn write_mp3(path: &Path, kbps: Option<f64>, left: &[f32], right: &[f32], sr: u32, cancel: &AtomicBool) -> Result<Mp3RenderInfo, String> {
    let kbps = mp3::parse_kbps(kbps)?;
    let info = mp3::write_mp3(path, left, right, sr, kbps, Some(cancel))?;
    Ok(Mp3RenderInfo {
        sample_rate: info.sample_rate,
        kbps: info.kbps,
        samples: info.frames as u64,
        encoder_delay: info.encoder_delay,
        end_padding: info.end_padding,
        itun_smpb: info.itunsmpb,
    })
}

pub fn run_render(model: &Model, req: &RenderRequest, env: &mut RenderEnv) -> Result<RenderResult, String> {
    validate_request(req)?;
    if req.stems == Some(true) {
        return run_stems(model, req, env, STEM_MEM_BUDGET);
    }
    let path = PathBuf::from(&req.path);
    let mut audio = render_audio(model, req, env)?;
    if req.normalize == Some(true) {
        normalize_peak(&mut audio.left, &mut audio.right, NORMALIZE_TARGET_DB);
    }
    let sr = audio.sample_rate as u32;
    let mp3 = if req.format == "mp3" {
        let t = std::time::Instant::now();
        let m = write_mp3(&path, req.mp3_kbps, &audio.left, &audio.right, sr, &env.cancel)?;
        let resampled = if m.sample_rate != sr { format!(", resampled from {sr} Hz") } else { String::new() };
        (env.log)("info", format!("Encoded MP3 ({} kbps, {} Hz{resampled}) in {:.2} s", m.kbps, m.sample_rate, t.elapsed().as_secs_f64()));
        Some(m)
    } else {
        write_wav(&path, &req.format, &audio.left, &audio.right, sr)?;
        None
    };
    let analysis = krypt_studio_dsp::analysis::analyze(&audio.left, &audio.right, audio.sample_rate);
    let duration = audio.left.len() as f64 / audio.sample_rate as f64;
    let analysis_json = if req.analyze == Some(true) { serde_json::to_value(&analysis).ok() } else { None };
    Ok(RenderResult {
        path: req.path.clone(),
        files: vec![req.path.clone()],
        duration_sec: duration,
        peak_db: peak_db(&audio.left, &audio.right),
        lufs_integrated: finite_or(analysis.lufs_integrated, -70.0),
        analysis: analysis_json,
        stem_results: None,
        mp3,
        gain_reduction: Some(std::mem::take(&mut audio.gain_reduction)).filter(|v| !v.is_empty()),
    })
}

pub const STEM_MEM_BUDGET: usize = 1 << 30;
pub const STEM_SILENT_PEAK: f32 = 1.585e-5;

pub(crate) struct StemTap {
    insert_id: String,
    name: String,
    number: usize,
    slot: u32,
    listed: bool,
    peak: f32,
    store: TapStore,
}

enum TapStore {
    Mem { l: Vec<f32>, r: Vec<f32> },
    Spill { path: PathBuf, w: std::io::BufWriter<std::fs::File> },
}

impl TapStore {
    fn push(&mut self, l: &[f32], r: &[f32]) -> Result<(), String> {
        match self {
            TapStore::Mem { l: ml, r: mr } => {
                ml.extend_from_slice(l);
                mr.extend_from_slice(r);
                Ok(())
            }
            TapStore::Spill { path, w } => {
                use std::io::Write;
                let mut buf = [0u8; 8 * crate::program::SUB];
                for (chunk_l, chunk_r) in l.chunks(crate::program::SUB).zip(r.chunks(crate::program::SUB)) {
                    let n = chunk_l.len().min(chunk_r.len());
                    for i in 0..n {
                        buf[i * 8..i * 8 + 4].copy_from_slice(&chunk_l[i].to_le_bytes());
                        buf[i * 8 + 4..i * 8 + 8].copy_from_slice(&chunk_r[i].to_le_bytes());
                    }
                    w.write_all(&buf[..n * 8]).map_err(|e| format!("Cannot write stem data to {}: {e}", path.display()))?;
                }
                Ok(())
            }
        }
    }

    fn take(self, frames: usize) -> Result<(Vec<f32>, Vec<f32>), String> {
        let (mut l, mut r) = match self {
            TapStore::Mem { l, r } => (l, r),
            TapStore::Spill { path, w } => {
                let f = w.into_inner().map_err(|e| format!("Cannot write stem data to {}: {}", path.display(), e.error()))?;
                drop(f);
                let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read stem data back from {}: {e}", path.display()))?;
                let _ = std::fs::remove_file(&path);
                let n = (bytes.len() / 8).min(frames);
                let mut l = Vec::with_capacity(frames);
                let mut r = Vec::with_capacity(frames);
                for c in bytes.chunks_exact(8).take(n) {
                    l.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
                    r.push(f32::from_le_bytes([c[4], c[5], c[6], c[7]]));
                }
                (l, r)
            }
        };
        l.resize(frames, 0.0);
        r.resize(frames, 0.0);
        Ok((l, r))
    }
}

struct Cleanup {
    paths: Vec<PathBuf>,
    armed: bool,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.armed {
            for p in &self.paths {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

pub fn stem_file_name(number: usize, name: &str, fallback: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c }).collect();
    let mut s = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > 60 {
        s = s.chars().take(60).collect();
    }
    let s = s.trim_end_matches(['.', ' ']).to_string();
    let s = if s.trim_matches(['_', '.', ' ']).is_empty() { fallback.to_string() } else { s };
    format!("{number:02} {s}")
}

fn spill_prefix() -> String {
    format!(".krypt-stem-{}-", std::process::id())
}

fn remove_spills(dir: &Path) {
    let prefix = spill_prefix();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn stem_insert_ids(model: &Model) -> Vec<String> {
    model.ordered_insert_ids().into_iter().filter(|id| *id != model.master_id && model.inserts.get(id).is_some_and(|i| !i.is_master)).collect()
}

fn plan_taps(model: &Model, slots: &[(u32, String)], align: &[(u32, usize)], plan: &StemPlan, est_frames: usize, env: &mut RenderEnv) -> Result<Vec<StemTap>, String> {
    if let Some(w) = plan.wanted {
        for id in w {
            if !model.inserts.contains_key(id) {
                return Err(format!("Can't export a stem for insert {id}: it is not in the mixer"));
            }
        }
    }
    let mut picked = Vec::new();
    for (k, id) in stem_insert_ids(model).iter().enumerate() {
        let listed = plan.wanted.is_some_and(|w| w.contains(id));
        if plan.wanted.is_some() && !listed {
            continue;
        }
        let Some(&(slot, _)) = slots.iter().find(|(_, sid)| sid == id) else {
            (env.log)("warn", format!("Insert {id} has no mixer slot (too many inserts); no stem for it"));
            continue;
        };
        let delay = align.iter().find(|(s, _)| *s == slot).map(|a| a.1).unwrap_or(0);
        let name = model.inserts.get(id).map(|i| i.name.clone()).unwrap_or_default();
        picked.push((k + 1, id.clone(), name, slot, listed, delay));
    }
    let bytes = (est_frames + 4096) * 8 * picked.len();
    let spill = bytes > plan.mem_budget;
    if spill {
        (env.log)("info", format!("Stems: {} inserts ({} MB) stream to disk while rendering", picked.len(), bytes >> 20));
    }
    let mut taps = Vec::with_capacity(picked.len());
    for (number, insert_id, name, slot, listed, delay) in picked {
        let mut store = if spill {
            let path = plan.dir.join(format!("{}{slot}.f32.part", spill_prefix()));
            let f = std::fs::File::create(&path).map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
            TapStore::Spill { path, w: std::io::BufWriter::with_capacity(1 << 20, f) }
        } else {
            let cap = est_frames + delay + 4096;
            TapStore::Mem { l: Vec::with_capacity(cap), r: Vec::with_capacity(cap) }
        };
        if delay > 0 {
            let z = vec![0f32; delay];
            store.push(&z, &z)?;
        }
        taps.push(StemTap { insert_id, name, number, slot, listed, peak: 0.0, store });
    }
    Ok(taps)
}

fn write_stem(path: &Path, req: &RenderRequest, l: &[f32], r: &[f32], sr: u32, cancel: &AtomicBool) -> Result<Option<Mp3RenderInfo>, String> {
    if req.format == "mp3" {
        write_mp3(path, req.mp3_kbps, l, r, sr, cancel).map(Some)
    } else {
        write_wav(path, &req.format, l, r, sr).map(|_| None)
    }
}

pub(crate) fn run_stems(model: &Model, req: &RenderRequest, env: &mut RenderEnv, mem_budget: usize) -> Result<RenderResult, String> {
    let dir = PathBuf::from(&req.path);
    if dir.is_file() {
        return Err(format!("Stem export needs a folder, but {} is a file", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create folder {}: {e}", dir.display()))?;
    let analyze = req.analyze == Some(true);
    let plan = StemPlan { wanted: req.stem_inserts.as_deref(), dir: dir.clone(), mem_budget, progress_share: 0.7 };
    let mut written = Cleanup { paths: Vec::new(), armed: true };
    let t0 = std::time::Instant::now();
    let rendered = render_inner(model, req, env, Some(&plan));
    let (mut audio, taps) = match rendered {
        Ok(x) => x,
        Err(e) => {
            remove_spills(&dir);
            return Err(e);
        }
    };
    let render_secs = t0.elapsed().as_secs_f64();
    let result = (|| -> Result<RenderResult, String> {
        let gain = if req.normalize == Some(true) { normalize_peak(&mut audio.left, &mut audio.right, NORMALIZE_TARGET_DB) } else { 1.0 };
        let sr = audio.sample_rate as u32;
        let frames = audio.left.len();
        let ext = if req.format == "mp3" { "mp3" } else { "wav" };
        let considered = taps.len();
        let keep: Vec<StemTap> = taps.into_iter().filter(|t| t.listed || t.peak >= STEM_SILENT_PEAK).collect();
        let skipped = considered - keep.len();
        let total = keep.len() + 1;
        let mut results: Vec<StemResult> = Vec::with_capacity(total);
        let master_number = stem_insert_ids(model).len() + 1;
        let mut clipped: Vec<String> = Vec::new();
        let cancelled = |env: &RenderEnv| -> Result<(), String> {
            if env.cancel.load(Ordering::Relaxed) {
                Err("Render cancelled".into())
            } else {
                Ok(())
            }
        };
        for (k, tap) in keep.into_iter().enumerate() {
            cancelled(env)?;
            let (mut l, mut r) = tap.store.take(frames)?;
            if gain != 1.0 {
                for x in l.iter_mut().chain(r.iter_mut()) {
                    *x = (*x as f64 * gain) as f32;
                }
            }
            if req.format != "wav32f" {
                let pk = l.iter().chain(r.iter()).fold(0f32, |m, x| m.max(x.abs()));
                if pk > 1.0 {
                    clipped.push(format!("{} (+{:.1} dB)", if tap.name.trim().is_empty() { format!("Insert {}", tap.number) } else { tap.name.clone() }, 20.0 * pk.log10()));
                }
            }
            let fallback = format!("Insert {}", tap.number);
            let file = dir.join(format!("{}.{ext}", stem_file_name(tap.number, &tap.name, &fallback)));
            written.paths.push(file.clone());
            write_stem(&file, req, &l, &r, sr, &env.cancel)?;
            let analysis = if analyze { serde_json::to_value(krypt_studio_dsp::analysis::analyze(&l, &r, audio.sample_rate)).ok() } else { None };
            let name = if tap.name.trim().is_empty() { fallback } else { tap.name };
            results.push(StemResult { insert_id: tap.insert_id, name, path: file.display().to_string(), analysis });
            (env.progress)(plan.progress_share + (1.0 - plan.progress_share) * (k + 1) as f64 / total as f64);
        }
        cancelled(env)?;
        if !clipped.is_empty() {
            (env.log)("warn", format!("These stems go over 0 dBFS and were clipped in {}: {}. Export as WAV 32-bit float to keep them intact.", req.format, clipped.join(", ")));
        }
        let master_file = dir.join(format!("{}.{ext}", stem_file_name(master_number, "Master", "Master")));
        written.paths.push(master_file.clone());
        let mp3 = write_stem(&master_file, req, &audio.left, &audio.right, sr, &env.cancel)?;
        let analysis = krypt_studio_dsp::analysis::analyze(&audio.left, &audio.right, audio.sample_rate);
        let analysis_json = if analyze { serde_json::to_value(&analysis).ok() } else { None };
        results.push(StemResult { insert_id: model.master_id.clone(), name: "Master".into(), path: master_file.display().to_string(), analysis: analysis_json.clone() });
        cancelled(env)?;
        (env.progress)(1.0);
        let skipped_note = if skipped > 0 { format!(", {skipped} silent insert{} skipped", if skipped == 1 { "" } else { "s" }) } else { String::new() };
        (env.log)("info", format!("Stems: {} files in {:.2} s (render pass {:.2} s){skipped_note}", results.len(), t0.elapsed().as_secs_f64(), render_secs));
        Ok(RenderResult {
            path: req.path.clone(),
            files: results.iter().map(|r| r.path.clone()).collect(),
            duration_sec: frames as f64 / audio.sample_rate as f64,
            peak_db: peak_db(&audio.left, &audio.right),
            lufs_integrated: finite_or(analysis.lufs_integrated, -70.0),
            analysis: analysis_json,
            stem_results: Some(results),
            mp3,
            gain_reduction: Some(std::mem::take(&mut audio.gain_reduction)).filter(|v| !v.is_empty()),
        })
    })();
    remove_spills(&dir);
    if result.is_ok() {
        written.armed = false;
    }
    result
}
