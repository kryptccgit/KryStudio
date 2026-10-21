//! Wire types. Mirror of shared/analyzer/protocol.ts — change both together
//! (and docs/ANALYZER_PROTOCOL.md). Times are seconds; JSON is camelCase.

use krypt_studio_dsp::analysis::{Analysis, Bands};
use serde::{Deserialize, Serialize};

// ── Requests ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeArgs {
    pub path: String,
    #[serde(default = "yes")]
    pub sections: bool,
    #[serde(default)]
    pub beat_model_dir: Option<String>,
    /// Also return drum hits from the same decode (library light pass).
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
    /// "auto" | "cpu" | "directml"
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

/// One `fingerprint` segment (seconds; clipped to the audio).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintSegment {
    pub start_sec: f64,
    pub end_sec: f64,
}

/// Wave 8a (research/15): timbre features of a file or of segments of it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintArgs {
    pub path: String,
    /// Absent (or empty) → the whole file, answered in `whole`.
    #[serde(default)]
    pub segments: Option<Vec<FingerprintSegment>>,
    /// Estimate the fundamental. Default true.
    #[serde(default)]
    pub pitch: Option<bool>,
    /// High-pass the audio at this frequency (Hz, 4th-order Butterworth) before measuring: hats or snares read
    /// from a drum stem where the kick's tail rings under them. Absent / 0 = no filter.
    #[serde(default)]
    pub highpass_hz: Option<f32>,
}

/// Krypt Voice (research/21): Kokoro-82M text → speech, mono 24 kHz WAV.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsArgs {
    pub text: String,
    /// Kokoro phoneme string; G2P (English) runs when absent.
    #[serde(default)]
    pub phonemes: Option<String>,
    pub voice: String,
    /// 0.5..2, default 1.
    #[serde(default)]
    pub speed: Option<f32>,
    pub out: String,
    pub model_dir: String,
}

/// One `sing` segment (seconds).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SingSegment {
    pub src_start_sec: f64,
    pub src_end_sec: f64,
    pub out_start_sec: f64,
    pub dur_sec: f64,
    pub midi: f64,
}

/// "Sing my notes": speech segments warped onto a melody.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SingArgs {
    pub path: String,
    pub out: String,
    pub segments: Vec<SingSegment>,
    /// 0..1 → ±0–50 cents at ~5.5 Hz. Default 0.
    #[serde(default)]
    pub vibrato: Option<f32>,
    /// Glide into each note, ms. Default 0.
    #[serde(default)]
    pub glide_ms: Option<f32>,
}

/// Syllable nuclei in speech.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyllablesArgs {
    pub path: String,
    #[serde(default)]
    pub expected: Option<u32>,
}

/// `extract`: decode any audio file and write it as a WAV (32-bit float, its own rate, mono or stereo) at `out`, so
/// an instrument built from it (an SFZ mapping regions onto the file) can sit next to it in the user's data.
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

// ── Responses / events ────────────────────────────────────────────────

/// One line per request: `{id, ok:true, data}` or `{id, ok:false, message, cancelled?}`.
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

// ── Results ───────────────────────────────────────────────────────────

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
    /// "C", "C#", "Db", ... (sharps for sharp keys, flats for flat keys).
    pub tonic: String,
    /// "major" | "minor"
    pub mode: String,
    /// parseKey-compatible: "F#m", "Eb".
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
    /// lufs[i]: 3 s short-term loudness centred on i × hop_sec.
    pub lufs: Vec<f32>,
}

/// Chord quality. `Sus` covers sus4 and sus2 (the root comes from the bass);
/// `Power` is a bare fifth.
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
    /// The wire name ("maj", "m7", "5", ...).
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
    /// Pitch class of the root, 0..11 (C = 0).
    pub root: u8,
    pub quality: ChordQuality,
    /// 0..1
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
    /// Share of the harmonic (chroma) energy per pitch class, C..B, summing to
    /// 1: what notes the file plays, for comparing two files' harmony
    /// directly (Auto Mashup's key fit). None when the file is silent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_profile: Option<Vec<f32>>,
    /// Transport scale: odd 16ths sit swing × half a 16th late (0 straight,
    /// ≈0.67 triplet feel, 1 max). None when off-beat 16ths are empty.
    pub swing: Option<f32>,
    pub sections: Vec<Section>,
    pub levels: Analysis,
    pub stereo: Stereo,
    pub energy: Energy,
    pub onset_rate: f32,
    /// Chord estimates over time; empty when the material is atonal.
    pub chords: Vec<ChordSpan>,
    /// Only when `AnalyzeArgs.drums`: drum hits on the whole file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drum_hits: Option<Vec<DrumHit>>,
    pub estimated: Vec<String>,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stem {
    /// "drums" | "bass" | "vocals" | "other" | "guitar" | "piano"
    pub name: String,
    pub path: String,
    pub peak_db: f32,
    pub rms_db: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemsResult {
    pub model: String,
    /// "cpu" | "directml"
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

/// shared/sound-match/types.ts `SoundFingerprint`. Every field is finite.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundFingerprint {
    /// Seconds measured (after trimming leading / trailing silence).
    pub length_sec: f32,
    /// Power-weighted spectral centroid of the whole sound (Hz).
    pub centroid_hz: f32,
    /// 85 % of the energy lies below this (Hz).
    pub rolloff_hz: f32,
    /// 0 pure tone .. 1 white noise.
    pub flatness: f32,
    /// 0 noise .. 1 perfectly periodic.
    pub harmonicity: f32,
    /// Fundamental (Hz) when harmonicity ≥ 0.4 (and `pitch`), else null.
    pub f0_hz: Option<f32>,
    pub attack_ms: f32,
    pub decay_ms: f32,
    /// Mean envelope over the second half relative to the peak, 0..1.
    pub sustain: f32,
    /// dB relative to the loudest band (≤ 0, floored at -90).
    pub bands: Bands,
    pub crest_db: f32,
    /// Side / mid energy, 0..1 (0 for mono).
    pub width: f32,
    pub peak_db: f32,
    pub rms_db: f32,
}

impl SoundFingerprint {
    /// A zeroed-but-valid fingerprint (empty or silent segment): lengthSec 0,
    /// levels at the -120 dB floor, f0 null.
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

/// `fingerprint` result: one per segment, or `whole` when no segments were given.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintResult {
    pub segments: Vec<SoundFingerprint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whole: Option<SoundFingerprint>,
}

/// `tts`: one word of the input with its time in the output (seconds).
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
    /// Per-word timing from the model's predicted durations (empty when unknown).
    pub words: Vec<WordTiming>,
    pub phonemes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SungSegment {
    /// Median f0 of the voiced part (Hz); None = unvoiced (stretched, not pitched).
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
