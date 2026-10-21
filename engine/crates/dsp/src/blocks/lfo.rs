//! LFO shapes and a tempo-aware phase source shared by the modulation
//! effects and synths. A synced phase is derived from the song position
//! while the transport plays, so it lands on the same point of the bar on
//! every pass; otherwise it free-runs.

use super::TAU;
use crate::ProcessContext;

/// LFO shape names (index = shape id).
pub const LFO_SHAPES: [&str; 5] = ["Sine", "Triangle", "Saw up", "Saw down", "Square"];

/// Bipolar (-1..1) LFO value for a phase in cycles (0..1).
#[inline]
pub fn shape(kind: usize, phase: f64) -> f32 {
    let t = phase as f32;
    match kind {
        0 => (t * TAU).sin(),
        1 => 1.0 - 4.0 * (t - 0.5).abs(),
        2 => 2.0 * t - 1.0,
        3 => 1.0 - 2.0 * t,
        _ => {
            if t < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
    }
}

/// Tempo guard: non-finite or absurd tempos fall back to 120 bpm.
#[inline]
pub fn sane_bpm(bpm: f64) -> f64 {
    if bpm.is_finite() && bpm >= 1.0 {
        bpm.min(999.0)
    } else {
        120.0
    }
}

/// Phase accumulator in cycles. Call `begin` once per block, then `next`
/// once per sample.
#[derive(Clone, Copy, Debug, Default)]
pub struct TempoPhase {
    pub phase: f64,
    inc: f64,
    locked: bool,
    beat: f64,
    beat_inc: f64,
    div: f64,
}

impl TempoPhase {
    /// `div_beats`: cycle length in beats when synced; `rate_hz` otherwise.
    pub fn begin(&mut self, ctx: &ProcessContext, sr: f32, sync: bool, div_beats: f64, rate_hz: f32) {
        let bps = sane_bpm(ctx.bpm) / 60.0 / sr as f64;
        self.div = if div_beats.is_finite() { div_beats.max(1e-6) } else { 1.0 };
        self.locked = sync && ctx.playing && ctx.beat_pos.is_finite();
        self.beat = if ctx.beat_pos.is_finite() { ctx.beat_pos } else { 0.0 };
        self.beat_inc = bps;
        let rate = if rate_hz.is_finite() { rate_hz.max(0.0) as f64 } else { 0.0 };
        self.inc = if sync { bps / self.div } else { rate / sr as f64 };
    }

    #[inline]
    pub fn next(&mut self) -> f64 {
        if self.locked {
            self.phase = (self.beat / self.div).rem_euclid(1.0);
            self.beat += self.beat_inc;
        } else {
            self.phase += self.inc;
            if self.phase >= 1.0 {
                self.phase -= self.phase.floor();
            }
        }
        self.phase
    }

    pub fn reset(&mut self) {
        self.phase = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locked_phase_follows_beats() {
        let ctx = ProcessContext { sample_rate: 48000.0, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 3.5, frames: 64 };
        let mut p = TempoPhase::default();
        p.begin(&ctx, 48000.0, true, 1.0, 1.0);
        assert!((p.next() - 0.5).abs() < 1e-9);
        // free-running when stopped
        let ctx = ProcessContext { playing: false, ..ctx };
        let mut p = TempoPhase::default();
        p.begin(&ctx, 48000.0, false, 1.0, 480.0);
        for _ in 0..100 {
            p.next();
        }
        assert!((p.phase - 0.0).abs() < 1e-9 || (p.phase - 1.0).abs() < 1e-9);
    }
}
