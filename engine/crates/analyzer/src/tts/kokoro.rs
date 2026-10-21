//! Kokoro-82M v1.0 (hexgrad, Apache-2.0) as the ONNX export published by
//! onnx-community (Kokoro-82M-v1.0-ONNX), run by ONNX Runtime through `ort`
//! (the same runtime stem separation uses).
//!
//! Graph: `input_ids` int64 [1, n+2] (pad 0 at both ends), `style` f32
//! [1, 256] (row `n` of the voice's [510, 1, 256] table), `speed` f32 [1] →
//! `waveform` f32 [1, samples] at 24 kHz.
//!
//! Word timings: the export does not output the predicted durations, but
//! they are in the graph (`round(sigmoid(d).sum(-1) / speed).clamp(min=1)`:
//! the only `Round` node, then a `Clip`). At load time we append a graph
//! output for that tensor to the model bytes in memory (a protobuf repeated
//! field is extended by appending; the downloaded file stays byte-identical
//! and its SHA-256 still verifies). Durations are in frames of 600 samples.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use ort::ep;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::TensorRef;

use crate::separate::onnx_patch::{parse, write_len_field, WIRE_LEN};
use crate::separate::runtime::{self, Device};

pub const SAMPLE_RATE: u32 = 24_000;
pub const STYLE_DIM: usize = 256;
/// Model files the analyzer accepts, in order of preference.
/// (fp32 `model.onnx` is the catalog file: 3× faster than the int8 one on CPU
/// and the only one DirectML runs. The fp16 export has float16 durations.)
pub const MODEL_FILES: [&str; 2] = ["model.onnx", "model_quantized.onnx"];
/// Samples per predicted-duration frame (hop 300 × the decoder's 2× upsampling).
pub const SAMPLES_PER_FRAME: usize = 600;

const MODEL_GRAPH: u32 = 7;
const GRAPH_NODE: u32 = 1;
const GRAPH_OUTPUT: u32 = 12;
const NODE_INPUT: u32 = 1;
const NODE_OUTPUT: u32 = 2;
const NODE_OP_TYPE: u32 = 4;
const ELEM_FLOAT: u64 = 1;

pub struct Kokoro {
    session: Session,
    pub device: Device,
    /// Name of the exposed duration tensor, when the graph has one.
    durations: Option<String>,
    pub file: PathBuf,
}

/// The model file inside `dir`, if any.
pub fn model_file(dir: &Path) -> Option<PathBuf> {
    MODEL_FILES.iter().map(|f| dir.join(f)).find(|p| p.is_file())
}

fn strings(buf: &[u8], num: u32) -> Result<Vec<String>, String> {
    Ok(parse(buf)?.into_iter().filter(|f| f.num == num && f.wire == WIRE_LEN).map(|f| String::from_utf8_lossy(f.payload).into_owned()).collect())
}

/// Finds the predicted-duration tensor and returns the model bytes with it
/// added as a graph output (plus its name), or the bytes unchanged.
pub fn expose_durations(mut model: Vec<u8>) -> Result<(Vec<u8>, Option<String>), String> {
    let name = {
        let top = parse(&model)?;
        let graph = top.iter().find(|f| f.num == MODEL_GRAPH && f.wire == WIRE_LEN).ok_or("no graph in the model")?;
        let mut nodes: Vec<(String, Vec<String>, Vec<String>)> = Vec::new();
        for f in parse(graph.payload)? {
            if f.num == GRAPH_NODE && f.wire == WIRE_LEN {
                let op = strings(f.payload, NODE_OP_TYPE)?.into_iter().next().unwrap_or_default();
                if op == "Round" || op == "Clip" {
                    nodes.push((op, strings(f.payload, NODE_INPUT)?, strings(f.payload, NODE_OUTPUT)?));
                }
            }
        }
        let rounds: Vec<&(String, Vec<String>, Vec<String>)> = nodes.iter().filter(|n| n.0 == "Round").collect();
        match rounds.as_slice() {
            [r] => {
                let r_out = r.2.first().cloned().unwrap_or_default();
                let clip = nodes.iter().find(|n| n.0 == "Clip" && n.1.first() == Some(&r_out)).and_then(|n| n.2.first().cloned());
                Some(clip.unwrap_or(r_out)).filter(|s| !s.is_empty())
            }
            _ => None,
        }
    };
    let Some(name) = name else {
        return Ok((model, None));
    };
    // ValueInfoProto { name, type: TypeProto { tensor_type: { elem_type: FLOAT } } }
    let tensor = vec![0x08, ELEM_FLOAT as u8]; // field 1 (varint) = FLOAT
    let mut ty = Vec::new();
    write_len_field(&mut ty, 1, &tensor);
    let mut vi = Vec::new();
    write_len_field(&mut vi, 1, name.as_bytes());
    write_len_field(&mut vi, 2, &ty);
    let mut graph = Vec::new();
    write_len_field(&mut graph, GRAPH_OUTPUT, &vi);
    write_len_field(&mut model, MODEL_GRAPH, &graph);
    Ok((model, Some(name)))
}

/// ONNX Runtime session with its default memory settings (unlike HT-Demucs,
/// Kokoro's tensors are small; the arena and memory patterns speed it up).
fn session(model: &[u8], device: Device) -> Result<Session, String> {
    runtime::runtime()?;
    if device == Device::DirectMl {
        runtime::directml()?;
    }
    runtime::guard("creating the Kokoro session", || {
        let e = |e: ort::Error<ort::session::builder::SessionBuilder>| e.to_string();
        let mut b = Session::builder().map_err(|e| e.to_string())?.with_optimization_level(GraphOptimizationLevel::Level3).map_err(e)?;
        let cpu = ep::CPU::default().build();
        b = if device == Device::Cpu {
            b.with_execution_providers([cpu]).map_err(e)?
        } else {
            b.with_memory_pattern(false).map_err(e)?.with_parallel_execution(false).map_err(e)?.with_execution_providers([runtime::directml_ep(), cpu]).map_err(e)?
        };
        b.commit_from_memory(model).map_err(|e| e.to_string())
    })
}

impl Kokoro {
    pub fn load(file: &Path, device: Device) -> Result<Self, String> {
        let bytes = std::fs::read(file).map_err(|e| format!("Cannot read {}: {e}", file.display()))?;
        let (bytes, durations) = expose_durations(bytes).map_err(|e| format!("{} is not a valid ONNX model: {e}", file.display()))?;
        let session = session(&bytes, device)?;
        let names: Vec<String> = session.inputs().iter().map(|i| i.name().to_string()).collect();
        for want in ["input_ids", "style", "speed"] {
            if !names.iter().any(|n| n == want) {
                return Err(format!("{} does not look like the Kokoro model (no input '{want}')", file.display()));
            }
        }
        if !session.outputs().iter().any(|o| o.name() == "waveform") {
            return Err(format!("{} does not look like the Kokoro model (no 'waveform' output)", file.display()));
        }
        Ok(Self { session, device, durations, file: file.to_path_buf() })
    }

    /// One utterance: `ids` WITH the two pads. Returns the waveform and, when
    /// the graph exposes them, the per-token durations in frames.
    pub fn infer(&mut self, ids: &[i64], style: &[f32], speed: f32) -> Result<(Vec<f32>, Option<Vec<f32>>), String> {
        let e = |e: ort::Error| e.to_string();
        let speed_v = [speed];
        let inputs = ort::inputs![
            "input_ids" => TensorRef::from_array_view(([1usize, ids.len()], ids)).map_err(e)?,
            "style" => TensorRef::from_array_view(([1usize, STYLE_DIM], style)).map_err(e)?,
            "speed" => TensorRef::from_array_view(([1usize], &speed_v[..])).map_err(e)?,
        ];
        let dur_name = self.durations.clone();
        let outputs = self.session.run(inputs).map_err(e)?;
        let (_, wav) = outputs["waveform"].try_extract_tensor::<f32>().map_err(e)?;
        let wav = wav.to_vec();
        let dur = match dur_name.as_deref().and_then(|n| outputs.get(n)) {
            Some(v) => v.try_extract_tensor::<f32>().ok().map(|(_, d)| d.to_vec()).filter(|d| d.len() == ids.len()),
            None => None,
        };
        Ok((wav, dur))
    }
}

struct Cached {
    file: PathBuf,
    modified: Option<std::time::SystemTime>,
    model: Kokoro,
}

/// One loaded model per process (the next job reuses it; loading takes ~1 s).
static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// `tts` uses the CPU: ONNX Runtime 1.24's DirectML EP rejects Kokoro's grouped
/// upsampling ConvTranspose nodes ("The parameter is incorrect"), and on the
/// CPU the fp32 model already runs ~2.7× faster than real time (i7-10700K).
///
/// Runs `f` with the model at `file` on `device` (loaded on first use, or
/// when the file or device changed). Returns the load time in ms (0 = reused).
pub fn with_model<T>(file: &Path, device: Device, f: impl FnOnce(&mut Kokoro) -> Result<T, String>) -> Result<(T, u128), String> {
    let mut guard = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let modified = std::fs::metadata(file).and_then(|m| m.modified()).ok();
    let mut load_ms = 0;
    let stale = guard.as_ref().is_none_or(|c| c.file != file || c.modified != modified || c.model.device != device);
    if stale {
        *guard = None; // free the old session first
        let t = Instant::now();
        let model = Kokoro::load(file, device)?;
        load_ms = t.elapsed().as_millis();
        *guard = Some(Cached { file: file.to_path_buf(), modified, model });
    }
    let cached = guard.as_mut().ok_or("the Kokoro model is not loaded")?;
    f(&mut cached.model).map(|v| (v, load_ms))
}

/// Drops the cached model (frees its memory).
pub fn unload() {
    *CACHE.lock().unwrap_or_else(|p| p.into_inner()) = None;
}
