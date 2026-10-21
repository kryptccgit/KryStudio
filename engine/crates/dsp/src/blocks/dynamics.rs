//! Envelope followers for dynamics processors (transient shaper, Squash,
//! vocoder): rectified input, one-pole attack/release smoothing.

use super::tc_coef;

#[derive(Clone, Copy, Debug)]
pub struct Follower {
    pub env: f32,
    att: f32,
    rel: f32,
}

impl Default for Follower {
    fn default() -> Self {
        Self { env: 0.0, att: 1.0, rel: 0.01 }
    }
}

impl Follower {
    pub fn new(attack_ms: f32, release_ms: f32, sr: f32) -> Self {
        let mut f = Self::default();
        f.set(attack_ms, release_ms, sr);
        f
    }

    pub fn set(&mut self, attack_ms: f32, release_ms: f32, sr: f32) {
        self.att = tc_coef(attack_ms, sr);
        self.rel = tc_coef(release_ms, sr);
    }

    /// Feed a non-negative level (e.g. |x|); returns the envelope.
    #[inline]
    pub fn tick(&mut self, level: f32) -> f32 {
        let c = if level > self.env { self.att } else { self.rel };
        self.env += (level - self.env) * c;
        if self.env < 1e-12 {
            self.env = 0.0;
        }
        self.env
    }

    pub fn reset(&mut self) {
        self.env = 0.0;
    }
}
