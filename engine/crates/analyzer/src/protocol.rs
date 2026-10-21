use krypt_studio_dsp::analysis::{Analysis, Bands};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeArgs {
    pub path: String,
    #[serde(default = "yes")]
    pub sections: bool,
    #[serde(default)]
    pub beat_model_dir: Option<String>,
    #[serde(default)]
    pub drums: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparateArgs {
    pub path: String,
    pub model: String,
    pub model_dir: String,
    pub out_dir: String,
    #[serde(default = "auto")]
    pub device: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscribeMode {
    Poly,
    Mono,
    Drums,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeArgs {
    pub path: String,
    pub mode: TranscribeMode,
    #[serde(default)]
    pub model_dir: Option<String>,
    #[serde(default)]
    pub onset_threshold: Option<f32>,
    #[serde(default)]
    pub frame_threshold: Option<f32>,
    #[serde(default)]
    pub min_note_ms: Option<f32>,
    #[serde(default)]
    pub min_key: Option<u8>,
    #[serde(default)]
    pub max_key: Option<u8>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintSegment {
    pub start_sec: f64,
    pub end_sec: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintArgs {
    pub path: String,
    #[serde(default)]
    pub segments: Option<Vec<FingerprintSegment>>,
    #[serde(default)]
    pub pitch: Option<bool>,
    #[serde(default)]
    pub highpass_hz: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsArgs {
    pub text: String,
    #[serde(default)]
    pub phonemes: Option<String>,
    pub voice: String,
    #[serde(default)]
    pub speed: Option<f32>,
    pub out: String,
    pub model_dir: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SingSegment {
    pub src_start_sec: f64,
    pub src_end_sec: f64,
    pub out_start_sec: f64,
    pub dur_sec: f64,
    pub midi: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SingArgs {
    pub path: String,
    pub out: String,
    pub segments: Vec<SingSegment>,
    #[serde(default)]
    pub vibrato: Option<f32>,
    #[serde(default)]
    pub glide_ms: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyllablesArgs {
    pub path: String,
    #[serde(default)]
    pub expected: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractArgs {
    pub path: String,
    pub out: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractResult {
    pub path: String,
    pub frames: u64,
    pub sample_rate: u32,
    pub channels: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelArgs {
    pub target: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
pub enum Request {
    Hello { id: u64 },
    Analyze { id: u64, args: AnalyzeArgs },
    Separate { id: u64, args: SeparateArgs },
    Transcribe { id: u64, args: TranscribeArgs },
    Fingerprint { id: u64, args: FingerprintArgs },
    Tts { id: u64, args: TtsArgs },
    Sing { id: u64, args: SingArgs },
    Syllables { id: u64, args: SyllablesArgs },
    Extract { id: u64, args: ExtractArgs },
    Cancel { id: u64, args: CancelArgs },
    Shutdown { id: u64 },
}

impl Request {
    pub fn id(&self) -> u64 {
        match self {
            Request::Hello { id }
            | Request::Analyze { id, .. }
            | Request::Separate { id, .. }
            | Request::Transcribe { id, .. }
            | Request::Fingerprint { id, .. }
            | Request::Tts { id, .. }
            | Request::Sing { id, .. }
            | Request::Syllables { id, .. }
            | Request::Extract { id, .. }
            | Request::Cancel { id, .. }
            | Request::Shutdown { id } => *id,
        }
    }
}

fn yes() -> bool {
    true
}

fn auto() -> String {
    "auto".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
}

impl Response {
    pub fn ok(id: u64, data: impl Serialize) -> Self {
        Self { id, ok: true, data: serde_json::to_value(data).ok(), message: None, cancelled: false }
    }

    pub fn fail(id: u64, message: impl Into<String>) -> Self {
        Self { id, ok: false, data: None, message: Some(message.into()), cancelled: false }
    }

    pub fn cancelled(id: u64) -> Self {
        Self { id, ok: false, data: None, message: Some("Cancelled".into()), cancelled: true }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum Event {
    Progress { id: u64, stage: String, fraction: f32 },
    Log { level: String, message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub version: String,
    pub devices: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tempo {
    pub bpm: f32,
    pub confidence: f32,
    pub alternatives: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Beats {
    pub times: Vec<f32>,
    pub downbeats: Vec<f32>,
    pub beats_per_bar: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    pub tonic: String,
    pub mode: String,
    pub name: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub start_sec: f32,
    pub end_sec: f32,
    pub label: String,
    pub lufs: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stereo {
    pub width: f32,
    pub correlation: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Energy {
    pub hop_sec: f32,
    pub lufs: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum ChordQuality {
    #[serde(rename = "maj")]
    Maj,
    #[serde(rename = "min")]
    Min,
    #[serde(rename = "7")]
    Dom7,
    #[serde(rename = "maj7")]
    Maj7,
    #[serde(rename = "m7")]
    Min7,
    #[serde(rename = "dim")]
    Dim,
    #[serde(rename = "sus")]
    Sus,
    #[serde(rename = "5")]
    Power,
}

impl ChordQuality {
    pub fn as_str(self) -> &'static str {
        match self {
            ChordQuality::Maj => "maj",
            ChordQuality::Min => "min",
            ChordQuality::Dom7 => "7",
            ChordQuality::Maj7 => "maj7",
            ChordQuality::Min7 => "m7",
            ChordQuality::Dim => "dim",
            ChordQuality::Sus => "sus",
            ChordQuality::Power => "5",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChordSpan {
    pub start_sec: f32,
    pub end_sec: f32,
    pub root: u8,
    pub quality: ChordQuality,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAnalysis {
    pub path: String,
    pub duration_sec: f32,
    pub sample_rate: u32,
    pub channels: u32,
    pub tempo: Option<Tempo>,
    pub beats: Option<Beats>,
    pub key: Option<Key>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_profile: Option<Vec<f32>>,
    pub swing: Option<f32>,
    pub sections: Vec<Section>,
    pub levels: Analysis,
    pub stereo: Stereo,
    pub energy: Energy,
    pub onset_rate: f32,
    pub chords: Vec<ChordSpan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drum_hits: Option<Vec<DrumHit>>,
    pub estimated: Vec<String>,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stem {
    pub name: String,
    pub path: String,
    pub peak_db: f32,
    pub rms_db: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemsResult {
    pub model: String,
    pub device: String,
    pub seconds: f32,
    pub stems: Vec<Stem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribedNote {
    pub start_sec: f32,
    pub dur_sec: f32,
    pub key: u8,
    pub vel: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cents: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DrumRole {
    Kick,
    Snare,
    Hat,
    Openhat,
    Perc,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrumHit {
    pub time_sec: f32,
    pub role: DrumRole,
    pub vel: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub mode: TranscribeMode,
    pub notes: Vec<TranscribedNote>,
    pub hits: Vec<DrumHit>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundFingerprint {
    pub length_sec: f32,
    pub centroid_hz: f32,
    pub rolloff_hz: f32,
    pub flatness: f32,
    pub harmonicity: f32,
    pub f0_hz: Option<f32>,
    pub attack_ms: f32,
    pub decay_ms: f32,
    pub sustain: f32,
    pub bands: Bands,
    pub crest_db: f32,
    pub width: f32,
    pub peak_db: f32,
    pub rms_db: f32,
}

impl SoundFingerprint {
    pub fn empty() -> Self {
        Self {
            length_sec: 0.0,
            centroid_hz: 0.0,
            rolloff_hz: 0.0,
            flatness: 0.0,
            harmonicity: 0.0,
            f0_hz: None,
            attack_ms: 0.0,
            decay_ms: 0.0,
            sustain: 0.0,
            bands: Bands::default(),
            crest_db: 0.0,
            width: 0.0,
            peak_db: -120.0,
            rms_db: -120.0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintResult {
    pub segments: Vec<SoundFingerprint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whole: Option<SoundFingerprint>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WordTiming {
    pub text: String,
    pub start_sec: f32,
    pub end_sec: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsResult {
    pub path: String,
    pub duration_sec: f32,
    pub sample_rate: u32,
    pub words: Vec<WordTiming>,
    pub phonemes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SungSegment {
    pub f0_hz: Option<f32>,
    pub shift_st: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SingResult {
    pub path: String,
    pub duration_sec: f32,
    pub segments: Vec<SungSegment>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Syllable {
    pub start_sec: f32,
    pub end_sec: f32,
    pub voiced: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyllablesResult {
    pub syllables: Vec<Syllable>,
}
