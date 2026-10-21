use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use ort::session::{RunOptions, Session};
use ort::value::TensorRef;

use super::onnx_patch;
use super::runtime::{self, Device};
use super::spec::{self, Spectro, BINS};

pub const ID: &str = "htdemucs";
pub const LABEL: &str = "HT-Demucs";
pub const SAMPLE_RATE: u32 = 44_100;
pub const SEGMENT: usize = 343_980;
pub const SOURCES: [&str; 4] = ["drums", "bass", "other", "vocals"];
pub const MODEL_FILE: &str = "htdemucs_fwd.onnx";
pub const WEIGHTS_FILE: &str = "htdemucs_fwd.onnx.data";

const FRAMES: usize = SEGMENT.div_ceil(spec::HOP);
const PLANE: usize = BINS * FRAMES;
const EPS: f64 = 1e-5;

pub enum SegmentError {
    Cancelled,
    Failed(String),
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Timing {
    pub load: Duration,
    pub pre: Duration,
    pub run: Duration,
    pub post: Duration,
    pub segments: u32,
}

pub struct HtDemucs {
    session: Session,
    pub device: Device,
    pub timing: Timing,
    x: Vec<f32>,
    xt: Vec<f32>,
    workers: Vec<Worker>,
}

struct Worker {
    spec: Spectro,
    re: Vec<f32>,
    im: Vec<f32>,
}

pub fn load_graph(model_dir: &Path) -> Result<Vec<u8>, String> {
    let path = model_dir.join(MODEL_FILE);
    let weights = model_dir.join(WEIGHTS_FILE);
    for p in [&path, &weights] {
        if !p.is_file() {
            return Err(format!(
                "{LABEL} model not found in {} ({} is missing). Install it from the Model Manager.",
                model_dir.display(),
                p.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let (patched, _removed) = onnx_patch::strip_zero_output_padding(&bytes).map_err(|e| format!("{} is not a valid ONNX model: {e}", path.display()))?;
    Ok(patched)
}

impl HtDemucs {
    pub fn new(graph: &[u8], model_dir: &Path, device: Device) -> Result<Self, String> {
        let t = Instant::now();
        let session = runtime::session(graph, model_dir, device)?;
        check_io(&session).map_err(|e| format!("{} does not look like the {LABEL} forward graph: {e}", model_dir.join(MODEL_FILE).display()))?;
        Ok(Self {
            session,
            device,
            timing: Timing { load: t.elapsed(), ..Timing::default() },
            x: vec![0f32; 4 * PLANE],
            xt: vec![0f32; 2 * SEGMENT],
            workers: (0..8).map(|_| Worker { spec: Spectro::new(), re: vec![0f32; PLANE], im: vec![0f32; PLANE] }).collect(),
        })
    }

    pub fn separate_segment(&mut self, mix: [&[f32]; 2], out: &mut [Vec<f32>], cancelled: &(dyn Fn() -> bool + Sync)) -> Result<(), SegmentError> {
        assert!(mix[0].len() == SEGMENT && mix[1].len() == SEGMENT && out.len() == 8);
        let t0 = Instant::now();
        std::thread::scope(|s| {
            for ((ch, planes), w) in mix.iter().zip(self.x.chunks_mut(2 * PLANE)).zip(&mut self.workers) {
                s.spawn(move || {
                    let (re, im) = planes.split_at_mut(PLANE);
                    w.spec.forward(ch, re, im);
                });
            }
        });
        let (mean, std) = mean_std(&self.x);
        normalize(&mut self.x, mean, std);
        self.xt[..SEGMENT].copy_from_slice(mix[0]);
        self.xt[SEGMENT..].copy_from_slice(mix[1]);
        let (meant, stdt) = mean_std(&self.xt);
        normalize(&mut self.xt, meant, stdt);

        let fail = |e: ort::Error| SegmentError::Failed(e.to_string());
        let run_options = RunOptions::new().map_err(fail)?;
        let done = AtomicBool::new(false);
        let Self { session, x, xt, workers, timing, .. } = self;
        timing.pre += t0.elapsed();
        std::thread::scope(|s| {
            s.spawn(|| {
                while !done.load(Ordering::Relaxed) {
                    if cancelled() {
                        let _ = run_options.terminate();
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            });
            let result = (|| {
                let inputs = ort::inputs![
                    "x" => TensorRef::from_array_view(([1usize, 4, BINS, FRAMES], &x[..])).map_err(fail)?,
                    "xt" => TensorRef::from_array_view(([1usize, 2, SEGMENT], &xt[..])).map_err(fail)?,
                ];
                let t1 = Instant::now();
                let outputs = match session.run_with_options(inputs, &run_options) {
                    Ok(o) => o,
                    Err(_) if cancelled() => return Err(SegmentError::Cancelled),
                    Err(e) => return Err(fail(e)),
                };
                timing.run += t1.elapsed();
                let t2 = Instant::now();
                let (_, x_out) = outputs["x_out"].try_extract_tensor::<f32>().map_err(fail)?;
                let (_, xt_out) = outputs["xt_out"].try_extract_tensor::<f32>().map_err(fail)?;
                if x_out.len() != 16 * PLANE || xt_out.len() != 8 * SEGMENT {
                    return Err(SegmentError::Failed(format!("unexpected output sizes {} / {}", x_out.len(), xt_out.len())));
                }
                let (std, mean) = (std as f32, mean as f32);
                let (stdt, meant) = (stdt as f32, meant as f32);
                std::thread::scope(|s| {
                    for (k, (o, w)) in out.iter_mut().zip(workers.iter_mut()).enumerate() {
                        let spec_planes = &x_out[2 * k * PLANE..(2 * k + 2) * PLANE];
                        let wave = &xt_out[k * SEGMENT..(k + 1) * SEGMENT];
                        s.spawn(move || {
                            for (d, v) in w.re.iter_mut().zip(&spec_planes[..PLANE]) {
                                *d = v * std + mean;
                            }
                            for (d, v) in w.im.iter_mut().zip(&spec_planes[PLANE..]) {
                                *d = v * std + mean;
                            }
                            o.resize(SEGMENT, 0.0);
                            w.spec.inverse(&w.re, &w.im, o);
                            for (v, t) in o.iter_mut().zip(wave) {
                                *v += t * stdt + meant;
                            }
                        });
                    }
                });
                timing.post += t2.elapsed();
                timing.segments += 1;
                Ok(())
            })();
            done.store(true, Ordering::Relaxed);
            result
        })
    }
}

fn check_io(session: &Session) -> Result<(), String> {
    let want_in: [(&str, &[i64]); 2] = [("x", &[1, 4, BINS as i64, FRAMES as i64]), ("xt", &[1, 2, SEGMENT as i64])];
    let want_out: [(&str, &[i64]); 2] = [("x_out", &[1, 16, BINS as i64, FRAMES as i64]), ("xt_out", &[1, 8, SEGMENT as i64])];
    for (outlets, want) in [(session.inputs(), &want_in), (session.outputs(), &want_out)] {
        for (name, shape) in want {
            let o = outlets.iter().find(|o| o.name() == *name).ok_or_else(|| format!("no tensor named '{name}'"))?;
            let got = o.dtype().tensor_shape().ok_or_else(|| format!("'{name}' is not a tensor"))?;
            if &got[..] != *shape {
                return Err(format!("'{name}' has shape {got:?}, expected {shape:?}"));
            }
        }
    }
    Ok(())
}

fn mean_std(v: &[f32]) -> (f64, f64) {
    let n = v.len() as f64;
    let mean = v.iter().map(|&x| f64::from(x)).sum::<f64>() / n;
    let var = v.iter().map(|&x| (f64::from(x) - mean).powi(2)).sum::<f64>() / (n - 1.0).max(1.0);
    (mean, var.sqrt())
}

fn normalize(v: &mut [f32], mean: f64, std: f64) {
    let (m, inv) = (mean as f32, (1.0 / (EPS + std)) as f32);
    for x in v {
        *x = (*x - m) * inv;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_the_graph() {
        assert_eq!(FRAMES, 336);
        assert_eq!(SEGMENT, (39 * 44_100) / 5);
    }

    #[test]
    fn mean_std_is_unbiased() {
        let (m, s) = mean_std(&[1.0, 2.0, 3.0, 4.0]);
        assert!((m - 2.5).abs() < 1e-12);
        assert!((s - (5.0f64 / 3.0).sqrt()).abs() < 1e-12);
    }
}
