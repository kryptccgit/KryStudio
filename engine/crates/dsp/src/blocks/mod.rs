//! Small DSP building blocks shared by every instrument and effect.
//! All written from first principles / published papers (see THIRD-PARTY.md).

// Per-sample index loops over parallel buffers are the clearest DSP style;
// smoothers expose `next()` deliberately (they are not iterators).
#![allow(clippy::needless_range_loop, clippy::should_implement_trait)]

pub mod crossover;
pub mod delay;
pub mod dynamics;
pub mod env;
pub mod filters;
pub mod lfo;
pub mod osc;
pub mod oversample;
pub mod pitch;
pub mod sinc;
pub mod truepeak;

pub const PI: f32 = std::f32::consts::PI;
pub const TAU: f32 = std::f32::consts::TAU;

/// dB → linear gain.
#[inline]
pub fn db_to_gain(db: f32) -> f32 {
    (db * 0.115_129_255).exp()
}

/// Linear gain → dB (floored at -240 dB).
#[inline]
pub fn gain_to_db(g: f32) -> f32 {
    if g <= 1e-12 {
        -240.0
    } else {
        20.0 * g.log10()
    }
}

/// Fractional MIDI note → Hz (A4 = 69 = 440 Hz).
#[inline]
pub fn midi_to_hz(p: f32) -> f32 {
    440.0 * ((p - 69.0) * (1.0 / 12.0)).exp2()
}

#[inline]
pub fn semis_to_ratio(s: f32) -> f32 {
    (s * (1.0 / 12.0)).exp2()
}

/// Velocity curve shared by every instrument (ENGINE_PROTOCOL §4).
#[inline]
pub fn vel_gain(v: f32) -> f32 {
    if v.is_finite() {
        v.clamp(0.0, 1.0).powf(1.6)
    } else {
        0.0
    }
}

/// Equal-power pan, normalized so the centre is unity on both sides.
#[inline]
pub fn pan_gains(pan: f32) -> (f32, f32) {
    let p = if pan.is_finite() { pan.clamp(-1.0, 1.0) } else { 0.0 };
    let a = (p + 1.0) * (PI * 0.25);
    (a.cos() * std::f32::consts::SQRT_2, a.sin() * std::f32::consts::SQRT_2)
}

/// Flush tiny values to zero (denormal guard for feedback paths).
#[inline]
pub fn flush(x: f32) -> f32 {
    if x.abs() < 1e-20 {
        0.0
    } else {
        x
    }
}

#[inline]
pub fn flush64(x: f64) -> f64 {
    if x.abs() < 1e-30 {
        0.0
    } else {
        x
    }
}

/// Replace NaN/inf with 0 (last line of defence on outputs).
#[inline]
pub fn finite(x: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

/// One-pole smoothing coefficient for a time constant in ms.
#[inline]
pub fn tc_coef(ms: f32, sr: f32) -> f32 {
    let n = (ms * 0.001 * sr).max(1e-3);
    1.0 - (-1.0 / n).exp()
}

/// Fast rational tanh approximation (accurate to ~1e-4, exact limits ±1).
#[inline]
pub fn tanh_fast(x: f32) -> f32 {
    let x = x.clamp(-5.0, 5.0);
    let x2 = x * x;
    let n = x * (135135.0 + x2 * (17325.0 + x2 * (378.0 + x2)));
    let d = 135135.0 + x2 * (62370.0 + x2 * (3150.0 + x2 * 28.0));
    (n / d).clamp(-1.0, 1.0)
}

/// Small, fast, deterministic PRNG (xorshift32).
#[derive(Clone, Copy, Debug)]
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self(seed.max(1).wrapping_mul(0x9E37_79B9) | 1)
    }
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// Uniform 0..1.
    #[inline]
    pub fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
    /// Uniform -1..1 (white noise).
    #[inline]
    pub fn bipolar(&mut self) -> f32 {
        self.unit() * 2.0 - 1.0
    }
}

/// One-pole parameter smoother (no zipper noise). Snaps when settled.
#[derive(Clone, Copy, Debug)]
pub struct Smooth {
    pub cur: f32,
    pub target: f32,
    coef: f32,
}

impl Smooth {
    pub fn new(v: f32) -> Self {
        Self { cur: v, target: v, coef: 0.01 }
    }
    pub fn with_time(v: f32, ms: f32, sr: f32) -> Self {
        let mut s = Self::new(v);
        s.set_time(ms, sr);
        s
    }
    pub fn set_time(&mut self, ms: f32, sr: f32) {
        self.coef = tc_coef(ms, sr);
    }
    #[inline]
    pub fn set(&mut self, t: f32) {
        if t.is_finite() {
            self.target = t;
        }
    }
    #[inline]
    pub fn reset(&mut self, v: f32) {
        self.cur = v;
        self.target = v;
    }
    #[inline]
    pub fn next(&mut self) -> f32 {
        let d = self.target - self.cur;
        if d.abs() <= 1e-5 * (1.0 + self.target.abs()) {
            self.cur = self.target;
        } else {
            self.cur += d * self.coef;
        }
        self.cur
    }
    /// Advance `n` samples at once (block-rate smoothing).
    #[inline]
    pub fn advance(&mut self, n: usize) -> f32 {
        let k = (1.0 - self.coef).powi(n as i32);
        self.cur = self.target + (self.cur - self.target) * k;
        if (self.target - self.cur).abs() <= 1e-5 * (1.0 + self.target.abs()) {
            self.cur = self.target;
        }
        self.cur
    }
    #[inline]
    pub fn settled(&self) -> bool {
        self.cur == self.target
    }
}

/// Linear pitch glide in semitones (constant-time portamento).
#[derive(Clone, Copy, Debug, Default)]
pub struct Glide {
    pub cur: f32,
    target: f32,
    step: f32,
    remaining: u32,
}

impl Glide {
    pub fn jump(&mut self, p: f32) {
        self.cur = p;
        self.target = p;
        self.remaining = 0;
    }
    pub fn to(&mut self, p: f32, ms: f32, sr: f32) {
        let n = (ms.max(0.0) * 0.001 * sr) as u32;
        if n == 0 {
            self.jump(p);
        } else {
            self.target = p;
            self.remaining = n;
            self.step = (p - self.cur) / n as f32;
        }
    }
    #[inline]
    pub fn next(&mut self) -> f32 {
        if self.remaining > 0 {
            self.remaining -= 1;
            self.cur = if self.remaining == 0 { self.target } else { self.cur + self.step };
        }
        self.cur
    }
    #[inline]
    pub fn gliding(&self) -> bool {
        self.remaining > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tanh_fast_close() {
        let mut x = -6.0f32;
        while x < 6.0 {
            assert!((tanh_fast(x) - x.tanh()).abs() < 2e-4, "x={x}");
            x += 0.01;
        }
    }

    #[test]
    fn pan_law_unity_centre() {
        let (l, r) = pan_gains(0.0);
        assert!((l - 1.0).abs() < 1e-6 && (r - 1.0).abs() < 1e-6);
        let (l, r) = pan_gains(1.0);
        assert!(l.abs() < 1e-6 && (r - std::f32::consts::SQRT_2).abs() < 1e-5);
    }
}
