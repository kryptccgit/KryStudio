use std::path::Path;

use hound::{SampleFormat, WavSpec, WavWriter};

use crate::protocol::{ExtractArgs, ExtractResult};
use crate::{JobCtx, JobError};

pub fn write_mono(out: &str, samples: &[f32], sample_rate: u32) -> Result<(), JobError> {
    if out.trim().is_empty() {
        return Err(JobError::Failed("No output path was given".into()));
    }
    let path = Path::new(out);
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create the folder {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("wav.partial");
    let spec = WavSpec { channels: 1, sample_rate, bits_per_sample: 32, sample_format: SampleFormat::Float };
    let result = (|| -> Result<(), String> {
        let mut w = WavWriter::create(&tmp, spec).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
        for &s in samples {
            w.write_sample(if s.is_finite() { s } else { 0.0 }).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
        }
        w.finalize().map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("Cannot move the finished audio to {}: {e}", path.display()))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(JobError::Failed)
}

pub fn write_channels(out: &str, channels: &[&[f32]], sample_rate: u32, ctx: &JobCtx) -> Result<(), JobError> {
    if out.trim().is_empty() {
        return Err(JobError::Failed("No output path was given".into()));
    }
    let n_ch = channels.len().clamp(1, 2);
    let frames = channels.iter().map(|c| c.len()).min().unwrap_or(0);
    let path = Path::new(out);
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create the folder {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("wav.partial");
    let spec = WavSpec { channels: n_ch as u16, sample_rate, bits_per_sample: 32, sample_format: SampleFormat::Float };
    let result = (|| -> Result<(), JobError> {
        let err = |e: hound::Error| JobError::Failed(format!("Cannot write {}: {e}", tmp.display()));
        let mut w = WavWriter::create(&tmp, spec).map_err(err)?;
        for i in 0..frames {
            if i % 262_144 == 0 {
                ctx.check()?;
            }
            for c in channels.iter().take(n_ch) {
                let s = c[i];
                w.write_sample(if s.is_finite() { s } else { 0.0 }).map_err(err)?;
            }
        }
        w.finalize().map_err(err)?;
        std::fs::rename(&tmp, path).map_err(|e| JobError::Failed(format!("Cannot move the finished audio to {}: {e}", path.display())))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

pub fn extract(args: &ExtractArgs, ctx: &JobCtx) -> Result<ExtractResult, JobError> {
    ctx.progress("decoding", -1.0);
    let data = crate::audio::load(&args.path)?;
    ctx.check()?;
    let sr = data.sample_rate.round() as u32;
    let chans: Vec<&[f32]> = data.channels.iter().take(2).map(|c| c.as_slice()).collect();
    ctx.progress("writing", 0.5);
    write_channels(&args.out, &chans, sr, ctx)?;
    ctx.progress("writing", 1.0);
    Ok(ExtractResult { path: args.out.clone(), frames: data.frames() as u64, sample_rate: sr, channels: chans.len() as u32 })
}
