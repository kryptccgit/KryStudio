mod chunks;
mod htdemucs;
pub(crate) mod onnx_patch;
mod resample;
pub(crate) mod runtime;
mod spec;
mod writer;

use std::path::Path;
use std::time::Instant;

use crate::protocol::{SeparateArgs, Stem, StemsResult};
use crate::{JobCtx, JobError};

use chunks::{center_trim_start, padded_chunk, transition_weight, ChunkPlan, OverlapAdd};
use htdemucs::{HtDemucs, SegmentError};
use resample::StreamResampler;
use runtime::Device;
use writer::StemFiles;

pub const MODELS: &[&str] = &[htdemucs::ID];
const OVERLAP: f64 = 0.25;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Want {
    Auto,
    Cpu,
    DirectMl,
}

pub fn run(args: &SeparateArgs, ctx: &JobCtx) -> Result<StemsResult, JobError> {
    let started = Instant::now();
    if args.model != htdemucs::ID {
        return Err(JobError::Failed(format!("Unknown stem model '{}' (this build supports: {})", args.model, MODELS.join(", "))));
    }
    let want = match args.device.as_str() {
        "auto" | "" => Want::Auto,
        "cpu" => Want::Cpu,
        "directml" => Want::DirectMl,
        d => return Err(JobError::Failed(format!("Unknown inference device '{d}' (use auto, cpu or directml)"))),
    };
    let model_dir = Path::new(&args.model_dir);
    let graph = htdemucs::load_graph(model_dir)?;
    runtime::runtime().map_err(|e| JobError::Failed(format!("Stem separation is unavailable: {e}")))?;

    ctx.progress("decoding", -1.0);
    let src = krypt_studio_dsp::decode::decode_file(Path::new(&args.path))?;
    let src_rate = src.sample_rate.round() as u32;
    let frames = src.channels.first().map_or(0, Vec::len);
    if frames == 0 || src_rate == 0 {
        return Err(JobError::Failed(format!("{} contains no audio", args.path)));
    }
    let mut stereo = src.channels;
    if stereo.len() == 1 {
        stereo.push(stereo[0].clone());
    }
    ctx.check()?;
    let mut mix = if src_rate == htdemucs::SAMPLE_RATE {
        stereo
    } else {
        let m = resample::resample_all(&stereo, src_rate, htdemucs::SAMPLE_RATE)?;
        drop(stereo);
        m
    };
    ctx.check()?;

    ctx.progress("separating", -1.0);
    let mut model = open_model(&graph, model_dir, want, ctx)?;
    ctx.progress("separating", 0.0);

    let (ref_mean, ref_std) = reference_stats(&mix[0], &mix[1]);
    for ch in &mut mix {
        for v in ch.iter_mut() {
            *v = (*v - ref_mean) / ref_std;
        }
    }

    let total = mix[0].len();
    let plan = ChunkPlan::new(total, htdemucs::SEGMENT, OVERLAP);
    let weight = transition_weight(plan.segment);
    let mut ola = OverlapAdd::new(8, &plan);
    let mut files = StemFiles::create(Path::new(&args.out_dir), &htdemucs::SOURCES, src_rate, frames as u64)?;
    let mut back: Vec<Option<StreamResampler>> = Vec::new();
    for _ in 0..htdemucs::SOURCES.len() {
        back.push(if src_rate == htdemucs::SAMPLE_RATE { None } else { Some(StreamResampler::new(htdemucs::SAMPLE_RATE, src_rate, 2)?) });
    }
    let mut seg = [vec![0f32; plan.segment], vec![0f32; plan.segment]];
    let mut out: Vec<Vec<f32>> = (0..8).map(|_| Vec::with_capacity(plan.segment)).collect();
    let mut region: Vec<Vec<f32>> = vec![Vec::new(); 8];
    let n_chunks = plan.count();
    let cancelled = || ctx.cancelled();

    for (i, offset) in plan.offsets().enumerate() {
        ctx.check()?;
        let len = plan.chunk_len(offset);
        for (s, m) in seg.iter_mut().zip(&mix) {
            padded_chunk(m, offset, len, s);
        }
        loop {
            match model.separate_segment([seg[0].as_slice(), seg[1].as_slice()], &mut out, &cancelled) {
                Ok(()) => break,
                Err(SegmentError::Cancelled) => return Err(JobError::Cancelled),
                Err(SegmentError::Failed(msg)) if model.device == Device::DirectMl && want == Want::Auto => {
                    ctx.log("warn", format!("DirectML failed while separating ({msg}); continuing on the CPU"));
                    model = HtDemucs::new(&graph, model_dir, Device::Cpu).map_err(|e| JobError::Failed(format!("Stem separation failed: {e}")))?;
                }
                Err(SegmentError::Failed(msg)) => {
                    return Err(JobError::Failed(format!("Stem separation failed on {}: {msg}", model.device.label())));
                }
            }
        }
        let start = center_trim_start(plan.segment, len);
        let views: Vec<&[f32]> = out.iter().map(|o| &o[start..start + len]).collect();
        ola.add(&views, &weight[..len]);
        ola.take(plan.final_until(offset) - offset, &mut region);
        for r in &mut region {
            for v in r.iter_mut() {
                *v = *v * ref_std + ref_mean;
            }
        }
        for (st, rs) in back.iter_mut().enumerate() {
            let (l, r) = (&region[st * 2], &region[st * 2 + 1]);
            match rs {
                None => files.write(st, l, r)?,
                Some(rs) => rs.push(&[l.as_slice(), r.as_slice()], &mut |b: &[&[f32]]| files.write(st, b[0], b[1]))?,
            }
        }
        ctx.progress("separating", (i + 1) as f32 / n_chunks as f32);
    }
    drop(mix);

    ctx.progress("writing", -1.0);
    for (st, rs) in back.iter_mut().enumerate() {
        if let Some(rs) = rs {
            rs.finish(frames, &mut |b: &[&[f32]]| files.write(st, b[0], b[1]))?;
        }
    }
    ctx.check()?;
    let stems = files.finish()?;
    let t = model.timing;
    let ms = |d: std::time::Duration| d.as_millis();
    ctx.log(
        "info",
        format!(
            "{} on {}: {} segments in {:.1} s (model load {} ms, inference {} ms, STFT/normalise {} ms, iSTFT/de-normalise {} ms)",
            htdemucs::LABEL,
            model.device.label(),
            t.segments,
            started.elapsed().as_secs_f32(),
            ms(t.load),
            ms(t.run),
            ms(t.pre),
            ms(t.post)
        ),
    );
    Ok(StemsResult {
        model: htdemucs::ID.into(),
        device: model.device.id().into(),
        seconds: started.elapsed().as_secs_f32(),
        stems: stems
            .into_iter()
            .map(|s| Stem { name: s.name, path: s.path.to_string_lossy().into_owned(), peak_db: s.peak_db, rms_db: s.rms_db })
            .collect(),
    })
}

fn open_model(graph: &[u8], model_dir: &Path, want: Want, ctx: &JobCtx) -> Result<HtDemucs, JobError> {
    let cpu = || HtDemucs::new(graph, model_dir, Device::Cpu).map_err(|e| JobError::Failed(format!("Cannot load {}: {e}", htdemucs::LABEL)));
    match want {
        Want::Cpu => cpu(),
        Want::DirectMl => HtDemucs::new(graph, model_dir, Device::DirectMl)
            .map_err(|e| JobError::Failed(format!("DirectML is not available ({e}). Choose CPU or Auto for stem separation."))),
        Want::Auto if !cfg!(windows) => cpu(),
        Want::Auto => match runtime::directml().and_then(|_| HtDemucs::new(graph, model_dir, Device::DirectMl)) {
            Ok(m) => Ok(m),
            Err(e) => {
                ctx.log("warn", format!("DirectML failed to initialise ({e}); using the CPU"));
                cpu()
            }
        },
    }
}

fn reference_stats(l: &[f32], r: &[f32]) -> (f32, f32) {
    let n = l.len() as f64;
    let mono = |i: usize| 0.5 * (f64::from(l[i]) + f64::from(r[i]));
    let mean = (0..l.len()).map(mono).sum::<f64>() / n;
    let var = (0..l.len()).map(|i| (mono(i) - mean).powi(2)).sum::<f64>() / (n - 1.0).max(1.0);
    let std = var.sqrt();
    (mean as f32, if std > 1e-8 { std as f32 } else { 1.0 })
}

pub fn devices() -> Vec<String> {
    let mut d = vec![Device::Cpu.id().to_string()];
    if runtime::directml().is_ok() {
        d.push(Device::DirectMl.id().to_string());
    }
    d
}

#[cfg(test)]
mod tests;
