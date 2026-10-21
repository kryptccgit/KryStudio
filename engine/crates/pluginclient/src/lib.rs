//! krypt-studio-pluginclient — third-party VST3 / CLAP plugins for the
//! engine, hosted OUT OF PROCESS in `krypt-studio-pluginhost.exe`.
//!
//! The engine calls this crate only where the stock factory returns None
//! for a `vst3:` / `clap:` id (see the hooks in engine/src/compile.rs) and
//! from a handful of `plugins.*` protocol commands (control.rs). Everything
//! else — spawning and supervising the host, shared-memory audio, state,
//! editors, crash reporting — lives here (research/03 §2.3–2.8).
//!
//! Crash isolation: a plugin that crashes or hangs takes down only the host
//! process; its proxies go silent, an event reports it, and the engine and
//! the app keep running. `plugins.reload` brings everything back.

pub mod b64;
pub mod shm;

#[cfg(feature = "engine")]
mod api;
#[cfg(feature = "engine")]
pub mod manager;
#[cfg(feature = "engine")]
pub mod registry;
#[cfg(feature = "engine")]
mod remote;

#[cfg(feature = "engine")]
pub use api::*;
#[cfg(feature = "engine")]
pub use registry::{is_external_id, Format};
#[cfg(feature = "engine")]
pub use remote::{RemoteEffect, RemoteInstrument};
