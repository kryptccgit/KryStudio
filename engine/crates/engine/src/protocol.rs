//! JSON shapes of shared/engine/protocol.ts, plus the stdout writer.
//! stdout carries ONLY protocol JSON lines; free-form diagnostics go to stderr.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::sync::Mutex;

pub const PROTOCOL_VERSION: u32 = 1;
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub backend: &'static str,
    pub is_default: bool,
    pub channels: u16,
    pub sample_rates: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub open: bool,
    pub id: Option<String>,
    pub name: Option<String>,
    pub backend: Option<String>,
    pub sample_rate: u32,
    pub buffer_frames: u32,
    pub output_latency_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl DeviceStatus {
    pub fn closed(sample_rate: u32, message: Option<String>) -> Self {
        Self { open: false, id: None, name: None, backend: None, sample_rate, buffer_frames: 0, output_latency_ms: 0.0, message }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
pub enum RenderScope {
    #[serde(rename = "song")]
    Song,
    #[serde(rename = "pattern")]
    Pattern {
        #[serde(rename = "patternId", default)]
        pattern_id: Option<String>,
    },
    #[serde(rename = "range")]
    Range {
        #[serde(rename = "startTick")]
        start_tick: f64,
        #[serde(rename = "endTick")]
        end_tick: f64,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub path: String,
    #[serde(default = "default_scope")]
    pub scope: RenderScope,
    #[serde(default = "default_format")]
    pub format: String,
    #[serde(default)]
    pub sample_rate: Option<f64>,
    #[serde(default)]
    pub tail_sec: Option<f64>,
    #[serde(default)]
    pub analyze: Option<bool>,
    /// One offline pass that also writes every mixer insert's post-fader
    /// output to its own file; `path` is then a folder (render.rs, stems).
    #[serde(default)]
    pub stems: Option<bool>,
    /// With `stems`: only these insert ids (default: every insert that isn't
    /// silent over the range). Master is always written.
    #[serde(default)]
    pub stem_inserts: Option<Vec<String>>,
    #[serde(default)]
    pub loops: Option<f64>,
    /// Wave 2 (export dialog): scale the rendered audio so its peak hits
    /// -0.1 dBFS before writing (silence is left untouched). Absent = off.
    #[serde(default)]
    pub normalize: Option<bool>,
    /// `format: "mp3"` only: bitrate in kbit/s (128, 192, 256 or 320;
    /// absent = 320). Any other number is refused with a sentence. Ignored
    /// by the WAV formats.
    #[serde(default, rename = "mp3Kbps")]
    pub mp3_kbps: Option<f64>,
}

fn default_scope() -> RenderScope {
    RenderScope::Song
}
fn default_format() -> String {
    "wav24".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    pub path: String,
    pub files: Vec<String>,
    pub duration_sec: f64,
    pub peak_db: f64,
    pub lufs_integrated: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis: Option<Value>,
    /// `stems` renders: one entry per file written, in insert order, Master last.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stem_results: Option<Vec<StemResult>>,
    /// MP3 renders only: what was encoded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mp3: Option<Mp3RenderInfo>,
    /// meters (§15): gain reduction per dynamics slot over the render (slots that reduced at all).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gain_reduction: Option<Vec<crate::meters::GrStat>>,
}

/// `RenderResult.stemResults[]` (shared/engine/protocol.ts).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemResult {
    pub insert_id: String,
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis: Option<Value>,
}

/// `RenderResult.mp3` (shared/engine/protocol.ts `Mp3RenderInfo`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mp3RenderInfo {
    /// Rate of the MP3: the render rate, or 44.1 / 48 kHz when the render
    /// rate isn't one the encoder takes (32, 44.1, 48 kHz).
    pub sample_rate: u32,
    pub kbps: u32,
    /// Audio samples per channel in the file (at `sample_rate`).
    pub samples: u64,
    /// Encoder priming samples before the audio (672 with Windows' encoder).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder_delay: Option<u32>,
    /// Samples after the audio up to the end of the last MPEG frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_padding: Option<u32>,
    /// iTunes gapless info for an ID3v2 `COMM` frame (language `eng`,
    /// description `iTunSMPB`): `" 00000000 <delay> <padding> <samples> ..."`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub itun_smpb: Option<String>,
}

/// Where log lines go.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum OutMode {
    /// Engine protocol: logs become `log` events on stdout.
    Protocol,
    /// CLI modes: stdout is reserved for the result; logs go to stderr.
    Cli,
}

pub struct Out {
    mode: OutMode,
    lock: Mutex<()>,
}

impl Out {
    pub fn new(mode: OutMode) -> Self {
        Self { mode, lock: Mutex::new(()) }
    }

    pub fn line(&self, v: &Value) {
        let s = v.to_string();
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut so = std::io::stdout().lock();
        let _ = writeln!(so, "{s}");
        let _ = so.flush();
    }

    pub fn ok(&self, id: &Value, data: Value) {
        self.line(&json!({ "id": id, "ok": true, "data": data }));
    }

    pub fn err(&self, id: &Value, message: impl Into<String>) {
        self.line(&json!({ "id": id, "ok": false, "message": message.into() }));
    }

    pub fn event(&self, v: Value) {
        if self.mode == OutMode::Protocol {
            self.line(&v);
        }
    }

    pub fn log(&self, level: &str, message: impl Into<String>) {
        let message = message.into();
        match self.mode {
            OutMode::Protocol => {
                eprintln!("[{level}] {message}");
                self.line(&json!({ "event": "log", "level": level, "message": message }));
            }
            OutMode::Cli => eprintln!("[{level}] {message}"),
        }
    }
}
