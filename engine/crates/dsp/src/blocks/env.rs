#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Idle,
    Attack,
    Hold,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Copy, Debug)]
pub struct EnvParams {
    pub attack_ms: f32,
    pub hold_ms: f32,
    pub decay_ms: f32,
    pub sustain: f32,
    pub release_ms: f32,
}

impl Default for EnvParams {
    fn default() -> Self {
        Self { attack_ms: 1.0, hold_ms: 0.0, decay_ms: 300.0, sustain: 1.0, release_ms: 50.0 }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Ahdsr {
    pub stage: Stage,
    pub value: f32,
    sr: f32,
    coef: f32,
    over: f32,
    target: f32,
    counter: u32,
    sustain: f32,
}

impl Default for Ahdsr {
    fn default() -> Self {
        Self { stage: Stage::Idle, value: 0.0, sr: 48000.0, coef: 0.0, over: 0.0, target: 0.0, counter: 0, sustain: 1.0 }
    }
}

const ATTACK_RATIO: f32 = 0.3;
const DECAY_RATIO: f32 = 0.001;

impl Ahdsr {
    pub fn set_sr(&mut self, sr: f32) {
        self.sr = sr;
    }

    #[inline]
    fn samples(&self, ms: f32) -> f32 {
        (ms * 0.001 * self.sr).max(1.0)
    }

    fn segment(&mut self, target: f32, n: f32, ratio: f32) {
        let range = (target - self.value).abs().max(1e-6);
        let dir = if target >= self.value { 1.0 } else { -1.0 };
        self.over = target + dir * ratio * range;
        self.target = target;
        let a = (self.value - self.over).abs().max(1e-12);
        let b = (target - self.over).abs().max(1e-12);
        self.coef = (-(a / b).ln() / n).exp();
    }

    pub fn trigger(&mut self, p: &EnvParams) {
        self.sustain = p.sustain.clamp(0.0, 1.0);
        self.stage = Stage::Attack;
        let n = self.samples(p.attack_ms);
        if self.value >= 0.999 {
            self.value = 1.0;
            self.enter_hold(p);
        } else {
            self.segment(1.0, n, ATTACK_RATIO);
        }
    }

    fn enter_hold(&mut self, p: &EnvParams) {
        self.value = 1.0;
        if p.hold_ms > 0.05 {
            self.stage = Stage::Hold;
            self.counter = self.samples(p.hold_ms) as u32;
        } else {
            self.enter_decay(p);
        }
    }

    fn enter_decay(&mut self, p: &EnvParams) {
        self.sustain = p.sustain.clamp(0.0, 1.0);
        if self.sustain >= 0.9999 {
            self.stage = Stage::Sustain;
            self.value = 1.0;
            return;
        }
        self.stage = Stage::Decay;
        let n = self.samples(p.decay_ms);
        self.segment(self.sustain, n, DECAY_RATIO);
    }

    pub fn release(&mut self, p: &EnvParams) {
        if self.stage == Stage::Idle || self.stage == Stage::Release {
            return;
        }
        self.stage = Stage::Release;
        let n = self.samples(p.release_ms);
        self.segment(0.0, n, DECAY_RATIO);
    }

    pub fn kill(&mut self) {
        self.stage = Stage::Idle;
        self.value = 0.0;
    }

    #[inline]
    pub fn idle(&self) -> bool {
        self.stage == Stage::Idle
    }

    #[inline]
    pub fn next(&mut self, p: &EnvParams) -> f32 {
        match self.stage {
            Stage::Idle => 0.0,
            Stage::Attack => {
                self.value = self.over + (self.value - self.over) * self.coef;
                if self.value >= 1.0 {
                    self.enter_hold(p);
                }
                self.value
            }
            Stage::Hold => {
                if self.counter == 0 {
                    self.enter_decay(p);
                } else {
                    self.counter -= 1;
                }
                self.value
            }
            Stage::Decay => {
                self.value = self.over + (self.value - self.over) * self.coef;
                if self.value <= self.target {
                    self.value = self.target;
                    if self.target <= 0.0 {
                        self.stage = Stage::Idle;
                    } else {
                        self.stage = Stage::Sustain;
                    }
                }
                self.value
            }
            Stage::Sustain => {
                let s = p.sustain.clamp(0.0, 1.0);
                self.value += (s - self.value) * 0.002;
                if self.value <= 1e-5 && s <= 0.0 {
                    self.kill();
                }
                self.value
            }
            Stage::Release => {
                self.value = self.over + (self.value - self.over) * self.coef;
                if self.value <= 0.0 {
                    self.kill();
                }
                self.value
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ExpDecay {
    pub value: f32,
    coef: f32,
}

impl ExpDecay {
    pub fn trigger(&mut self, ms: f32, db: f32, sr: f32) {
        self.value = 1.0;
        self.set_time(ms, db, sr);
    }
    pub fn set_time(&mut self, ms: f32, db: f32, sr: f32) {
        let n = (ms * 0.001 * sr).max(1.0);
        self.coef = (-(db / 20.0) * std::f32::consts::LN_10 / n).exp();
    }
    #[inline]
    pub fn next(&mut self) -> f32 {
        let v = self.value;
        self.value = super::flush(self.value * self.coef);
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stages_hit_their_times() {
        let sr = 48000.0;
        let p = EnvParams { attack_ms: 10.0, hold_ms: 5.0, decay_ms: 100.0, sustain: 0.5, release_ms: 200.0 };
        let mut e = Ahdsr::default();
        e.set_sr(sr);
        e.trigger(&p);
        let mut n = 0;
        while e.stage == Stage::Attack {
            e.next(&p);
            n += 1;
        }
        assert!((n as f32 - 480.0).abs() <= 2.0, "attack took {n}");
        while e.stage != Stage::Sustain {
            e.next(&p);
        }
        assert!((e.value - 0.5).abs() < 1e-3);
        e.release(&p);
        let mut n = 0;
        while !e.idle() {
            e.next(&p);
            n += 1;
        }
        assert!((n as f32 - 9600.0).abs() <= 3.0, "release took {n}");
    }
}
