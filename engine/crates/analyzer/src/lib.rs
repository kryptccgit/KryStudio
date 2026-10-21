pub mod protocol;
pub mod analyze;
pub mod separate;
pub mod transcribe;
pub mod fingerprint;
pub mod tts;
pub mod sing;
pub mod syllables;
pub mod runner;

pub mod audio;
pub mod basic_pitch;
pub mod chords;
pub mod drums;
pub mod features;
pub mod key;
pub mod loudness;
pub mod onnx;
pub mod lowline;
pub mod pitch;
pub mod sections;
pub mod tempo;
pub mod wav;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug)]
pub enum JobError {
    Cancelled,
    Failed(String),
}

impl From<String> for JobError {
    fn from(m: String) -> Self {
        JobError::Failed(m)
    }
}

impl From<&str> for JobError {
    fn from(m: &str) -> Self {
        JobError::Failed(m.to_string())
    }
}

#[derive(Clone)]
pub struct JobCtx {
    pub id: u64,
    cancel: Arc<AtomicBool>,
    emit: Arc<dyn Fn(protocol::Event) + Send + Sync>,
}

impl JobCtx {
    pub fn new(id: u64, cancel: Arc<AtomicBool>, emit: Arc<dyn Fn(protocol::Event) + Send + Sync>) -> Self {
        Self { id, cancel, emit }
    }

    pub fn detached() -> Self {
        Self::new(0, Arc::new(AtomicBool::new(false)), Arc::new(|_| {}))
    }

    pub fn progress(&self, stage: &str, fraction: f32) {
        (self.emit)(protocol::Event::Progress { id: self.id, stage: stage.to_string(), fraction });
    }

    pub fn log(&self, level: &str, message: impl Into<String>) {
        (self.emit)(protocol::Event::Log { level: level.to_string(), message: message.into() });
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn check(&self) -> Result<(), JobError> {
        if self.cancelled() {
            Err(JobError::Cancelled)
        } else {
            Ok(())
        }
    }
}
