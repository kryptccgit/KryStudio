pub mod audio;
pub mod automation;
pub mod clock;
pub mod compile;
pub mod control;
pub mod core;
pub mod fxmix;
pub mod hardware_ctl;
pub mod input;
pub mod launcher;
pub mod meters;
pub mod midi;
pub mod midi_out;
pub mod model;
pub mod model_ext;
pub mod params;
pub mod plugins;
pub mod program;
pub mod protocol;
pub mod rack;
pub mod record;
pub mod record_ctl;
pub mod render;
pub mod rt;
pub mod samples;
pub mod telemetry;
pub mod time;
pub mod variants;
pub mod warp;
pub mod watchdog;

#[cfg(test)]
mod tests;

#[cfg(debug_assertions)]
#[global_allocator]
static ALLOC_GUARD: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;
