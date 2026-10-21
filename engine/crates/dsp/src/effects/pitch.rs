use super::{frames, sane_sr, sanitize_block};
use crate::blocks::delay::DelayLine;
use crate::blocks::pitch::Yin;
use crate::blocks::{tc_coef, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

pub const NOTE_NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
pub const SCALES: [&str; 9] =
    ["Chromatic", "Major", "Minor", "Harmonic minor", "Major pentatonic", "Minor pentatonic", "Dorian", "Mixolydian", "Blues"];
const SCALE_STEPS: [&[u8]; 9] = [
    &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    &[0, 2, 4, 5, 7, 9, 11],
    &[0, 2, 3, 5, 7, 8, 10],
    &[0, 2, 3, 5, 7, 8, 11],
    &[0, 2, 4, 7, 9],
    &[0, 3, 5, 7, 10],
    &[0, 2, 3, 5, 7, 9, 10],
    &[0, 2, 4, 5, 7, 9, 10],
    &[0, 3, 5, 6, 7, 10],
];

param_table! {
    Root => choice("root", "Key", &NOTE_NAMES, 0, "Scale"),
    Scale => choice("scale", "Scale", &SCALES, 0, "Scale"),
    Speed => lin("speed", "Retune speed", 0.0, 500.0, 40.0, "ms", "Correction"),
    Humanize => lin("humanize", "Humanize", 0.0, 1.0, 0.2, "%", "Correction"),
    Amount => lin("amount", "Amount", 0.0, 1.0, 1.0, "%", "Correction"),
    Mix => lin("mix", "Mix", 0.0, 1.0, 1.0, "%", "Output"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.pitch",
        name: "Krypt Tune",
        kind: PluginKind::Effect,
        category: "Vocal",
        description: "Real-time pitch correction for monophonic vocals and instruments (60-1000 Hz). Snaps to the nearest \
                      note of the Key and Scale. Retune speed 0 ms gives the hard robotic effect; 30-80 ms sounds \
                      natural. Humanize keeps vibrato and expression; Amount scales the correction. Formant-friendly \
                      pitch-synchronous shifting. Latency about 15 ms (reported for delay compensation).",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

const FMIN: f32 = 60.0;
const FMAX: f32 = 1000.0;
const HYST: f32 = 0.1;
const FREE_S: f32 = 0.1;
const MAX_CORR: f32 = 3.0;
const NOTE_JUMP: f32 = 0.8;
const SELECT_S: f32 = 0.015;
const HUMANIZE_PER_S: f32 = 0.6;
const HELD_CAP_S: f32 = 0.5;

fn scale_mask(root: usize, scale: usize) -> u16 {
    let mut m = 0u16;
    for &s in SCALE_STEPS[scale.min(SCALE_STEPS.len() - 1)] {
        m |= 1 << ((root + s as usize) % 12);
    }
    m
}

pub fn snap_to_scale(p: f32, mask: u16) -> i32 {
    let c = p.round() as i32;
    let mut best = c;
    let mut best_d = f32::MAX;
    for k in -6..=6 {
        let m = c + k;
        if mask & (1 << m.rem_euclid(12)) != 0 {
            let d = (p - m as f32).abs();
            if d < best_d {
                best_d = d;
                best = m;
            }
        }
    }
    best
}

pub struct Pitch {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    sr: f32,
    yin: Yin,
    ring: [DelayLine; 2],
    mono: DelayLine,
    d0: usize,
    pmax: f64,
    p_uv: f64,
    lag: f64,
    old_lag: f64,
    xf: f32,
    xf_step: f32,
    corr: f32,
    corr_target: f32,
    corr_coef: f32,
    speed_ms: f32,
    period: f64,
    voiced: bool,
    p_sel: f32,
    sel_coef: f32,
    held_s: f32,
    hop_s: f32,
    target: i32,
    mask: u16,
    humanize: f32,
    amount: f32,
    mix: Smooth,
}

impl Pitch {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let pmax = sr as f64 / FMIN as f64;
        let d0 = (0.9 * pmax).ceil() as usize + 8;
        let cap = d0 + 2 * pmax as usize + 256;
        let yin = Yin::new(sr, FMIN, FMAX);
        let hop_s = yin.hop_samples() as f32 / sr;
        let mut p = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            yin,
            ring: [DelayLine::new(cap), DelayLine::new(cap)],
            mono: DelayLine::new(cap),
            d0,
            pmax,
            p_uv: 0.008 * sr as f64,
            lag: d0 as f64,
            old_lag: d0 as f64,
            xf: 1.0,
            xf_step: 0.01,
            corr: 0.0,
            corr_target: 0.0,
            corr_coef: 1.0,
            speed_ms: 40.0,
            period: 0.008 * sr as f64,
            voiced: false,
            p_sel: 60.0,
            sel_coef: 1.0 - (-hop_s / SELECT_S).exp(),
            held_s: 0.0,
            hop_s,
            target: 60,
            mask: 0xFFF,
            humanize: 0.2,
            amount: 1.0,
            mix: Smooth::with_time(1.0, 20.0, sr),
        };
        p.update();
        p.mix.reset(p.mix.target);
        p
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.mask = scale_mask(p.idx(P::Root as usize).min(11), p.idx(P::Scale as usize));
        self.speed_ms = p.get(P::Speed as usize);
        self.humanize = p.get(P::Humanize as usize);
        self.amount = p.get(P::Amount as usize);
        self.mix.set(p.get(P::Mix as usize));
        self.set_retune();
    }

    fn set_retune(&mut self) {
        let extra_s = self.humanize * HUMANIZE_PER_S * self.held_s.min(HELD_CAP_S);
        self.corr_coef = tc_coef(self.speed_ms / 3.0 + extra_s * 1000.0, self.sr);
    }

    fn on_estimate(&mut self) {
        let f = self.yin.freq;
        if !(f > 0.0 && self.yin.aperiodicity < 0.25) {
            self.voiced = false;
            self.corr_target = 0.0;
            self.held_s = 0.0;
            self.set_retune();
            return;
        }
        let p = 69.0 + 12.0 * (f / 440.0).log2();
        if !self.voiced || (p - self.p_sel).abs() > NOTE_JUMP {
            self.voiced = true;
            self.p_sel = p;
        } else {
            self.p_sel += (p - self.p_sel) * self.sel_coef;
        }
        let cand = snap_to_scale(self.p_sel, self.mask);
        let cur_ok = self.mask & (1 << self.target.rem_euclid(12)) != 0;
        let hyst = if self.held_s < FREE_S { 0.0 } else { HYST };
        if !cur_ok || (cand != self.target && (self.p_sel - cand as f32).abs() + hyst < (self.p_sel - self.target as f32).abs()) {
            self.target = cand;
            self.held_s = 0.0;
        } else {
            self.held_s += self.hop_s;
        }
        self.set_retune();
        self.corr_target = (self.amount * (self.target as f32 - p)).clamp(-MAX_CORR, MAX_CORR);
        self.period = (self.sr / f) as f64;
    }

    fn refine(&self, lag: f64, cand: f64, p: f64) -> f64 {
        let w = ((p * 0.5) as usize).clamp(16, 400).min((lag as usize).saturating_sub(2));
        let range = ((p * 0.125) as i64).clamp(2, 48);
        if w < 8 {
            return cand;
        }
        let a0 = lag.round() as i64;
        let c0 = cand.round() as i64;
        let cap = self.mono.capacity() as i64 - 4;
        let mut scores = [f32::MIN; 97];
        let mut best = 0i64;
        let mut best_score = f32::MIN;
        for delta in -range..=range {
            let c = c0 + delta;
            if c - (w as i64) < 1 || c >= cap {
                continue;
            }
            let (mut xy, mut yy) = (0.0f32, 1e-12f32);
            for k in 0..w as i64 {
                let a = self.mono.read((a0 - k).max(0) as usize);
                let b = self.mono.read((c - k) as usize);
                xy += a * b;
                yy += b * b;
            }
            let score = xy / yy.sqrt();
            scores[(delta + 48) as usize] = score;
            if score > best_score {
                best_score = score;
                best = delta;
            }
        }
        let mut frac = 0.0f64;
        if best > -range && best < range {
            let i = (best + 48) as usize;
            let (y0, y1, y2) = (scores[i - 1], scores[i], scores[i + 1]);
            if y0 > f32::MIN && y2 > f32::MIN {
                let den = y0 - 2.0 * y1 + y2;
                if den < 0.0 {
                    frac = (0.5 * (y0 - y2) / den).clamp(-0.5, 0.5) as f64;
                }
            }
        }
        lag + (c0 + best - a0) as f64 + frac
    }
}

impl Effect for Pitch {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Pitch::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        self.mix.reset(self.mix.target);
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn latency(&self) -> usize {
        self.d0
    }

    fn process(&mut self, ctx: &ProcessContext, mut buf: [&mut [f32]; 2], _sc: Option<[&[f32]; 2]>) {
        let n = frames(ctx, &buf);
        if self.pb.take_dirty() {
            self.update();
        }
        if self.fresh {
            self.fresh = false;
            self.mix.reset(self.mix.target);
        }
        let d0 = self.d0 as f64;
        let max_lag = self.ring[0].capacity() as f64 - 4.0;
        for i in 0..n {
            let (l, r) = (crate::blocks::finite(buf[0][i]), crate::blocks::finite(buf[1][i]));
            let m = 0.5 * (l + r);
            self.ring[0].push(l);
            self.ring[1].push(r);
            self.mono.push(m);
            if self.yin.push(m) {
                self.on_estimate();
            }
            self.corr += (self.corr_target - self.corr) * self.corr_coef;
            if self.corr.abs() < 1e-6 {
                self.corr = 0.0;
            }
            let fading = self.xf < 1.0;
            let rate = if self.corr == 0.0 && !fading {
                1.0 - ((d0 - self.lag) * 1e-4).clamp(-0.002, 0.002)
            } else {
                ((self.corr / 12.0) as f64).exp2()
            };
            self.lag += 1.0 - rate;
            self.old_lag += 1.0 - rate;
            if !fading {
                let p = if self.voiced { self.period.min(self.pmax) } else { self.p_uv };
                let jump = if self.lag < d0 - 0.5 * p {
                    Some(self.lag + p)
                } else if self.lag > d0 + 0.5 * p {
                    Some(self.lag - p)
                } else {
                    None
                };
                if let Some(cand) = jump {
                    let to = self.refine(self.lag, cand, p).clamp(1.0, max_lag);
                    self.old_lag = self.lag;
                    self.lag = to;
                    self.xf = 0.0;
                    self.xf_step = 1.0 / (p as f32).clamp(32.0, 0.012 * self.sr);
                }
            }
            self.lag = self.lag.clamp(1.0, max_lag);
            self.old_lag = self.old_lag.clamp(1.0, max_lag);
            let w = if self.xf < 1.0 { 0.5 - 0.5 * (std::f32::consts::PI * self.xf).cos() } else { 1.0 };
            let mix = self.mix.next();
            for ch in 0..2 {
                let mut y = self.ring[ch].read_f64(self.lag);
                if self.xf < 1.0 {
                    let o = self.ring[ch].read_f64(self.old_lag);
                    y = o + (y - o) * w;
                }
                buf[ch][i] = if mix >= 1.0 {
                    y
                } else {
                    let dry = self.ring[ch].read(self.d0);
                    dry + (y - dry) * mix
                };
            }
            if self.xf < 1.0 {
                self.xf = (self.xf + self.xf_step).min(1.0);
            }
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.ring.iter_mut().for_each(DelayLine::clear);
        self.mono.clear();
        self.yin.reset();
        self.lag = self.d0 as f64;
        self.old_lag = self.lag;
        self.xf = 1.0;
        self.corr = 0.0;
        self.corr_target = 0.0;
        self.voiced = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapping() {
        let chrom = scale_mask(0, 0);
        assert_eq!(snap_to_scale(69.4, chrom), 69);
        assert_eq!(snap_to_scale(69.6, chrom), 70);
        let c_major = scale_mask(0, 1);
        assert_eq!(snap_to_scale(70.3, c_major), 71);
        assert_eq!(snap_to_scale(70.0, scale_mask(9, 2)), 69, "A minor: A# → A (ties go down)");
        let e_blues = scale_mask(4, 8);
        assert_eq!(snap_to_scale(65.2, e_blues), 64, "F → E in E blues");
    }
}
