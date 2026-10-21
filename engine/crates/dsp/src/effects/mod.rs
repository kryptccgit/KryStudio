#![allow(clippy::needless_range_loop, clippy::should_implement_trait)]

pub mod analyzer;
pub mod chorus;
pub mod clipper;
pub mod comp;
pub mod deesser;
pub mod delay;
pub mod drive;
pub mod eq;
pub mod filter;
pub mod flanger;
pub mod gate;
pub mod glue;
pub mod grain;
pub mod heat;
pub mod imager;
pub mod limiter;
pub mod phaser;
pub mod pitch;
pub mod reverb;
pub mod squash;
pub mod tapeecho;
pub mod duck;
pub mod transient;
pub mod utility;
pub mod vocoder;
#[cfg(test)]
mod vocoder_legacy;
#[cfg(test)]
mod meter_tests;

use crate::ProcessContext;

#[inline]
pub(crate) fn frames(ctx: &ProcessContext, buf: &[&mut [f32]; 2]) -> usize {
    ctx.frames.min(buf[0].len()).min(buf[1].len())
}

#[inline]
pub(crate) fn sane_sr(sr: f32) -> f32 {
    crate::instruments::sampler::sanitize_sr(sr)
}

#[inline]
pub(crate) fn sanitize_block(buf: &mut [&mut [f32]; 2], n: usize) {
    for ch in buf.iter_mut() {
        for v in ch[..n].iter_mut() {
            if !v.is_finite() {
                *v = 0.0;
            }
        }
    }
}
