use super::{frames, sane_sr, sanitize_block};
use crate::blocks::crossover::Split3;
use crate::blocks::dynamics::Follower;
use crate::blocks::{db_to_gain, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Depth => lin("depth", "Depth", 0.0, 1.0, 1.0, "%", "Squash"),
    Time => lin("time", "Time", 0.0, 1.0, 0.5, "%", "Squash"),
    Upward => lin("upward", "Upward", 0.0, 1.0, 1.0, "%", "Squash"),
    Downward => lin("downward", "Downward", 0.0, 1.0, 1.0, "%", "Squash"),
    InGain => lin("inGain", "Input", -24.0, 24.0, 0.0, "dB", "Gain"),
    OutGain => lin("outGain", "Output", -24.0, 24.0, 0.0, "dB", "Gain"),
    LowGain => lin("lowGain", "Low", -12.0, 12.0, 0.0, "dB", "Bands"),
    MidGain => lin("midGain", "Mid", -12.0, 12.0, 0.0, "dB", "Bands"),
    HighGain => lin("highGain", "High", -12.0, 12.0, 0.0, "dB", "Bands"),
    LowFreq => logp("lowFreq", "Low/mid split", 40.0, 500.0, 88.0, "Hz", "Bands"),
    HighFreq => logp("highFreq", "Mid/high split", 1000.0, 10000.0, 2500.0, "Hz", "Bands"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.squash",
        name: "Krypt Squash",
        kind: PluginKind::Effect,
        category: "Dynamics",
        description: "Aggressive 3-band upward and downward compressor (multiband squash): squashes loud parts (10:1 above \
                      -24 dB) and pulls quiet detail up (4:1 below -36 dB, up to +30 dB) in each band. Depth is a \
                      phase-coherent parallel mix, Time scales attack/release, Upward/Downward scale each half. Band \
                      gains and split points shape the tone. Zero latency.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

const DOWN_T: f32 = -24.0;
const DOWN_R: f32 = 10.0;
const UP_T: f32 = -36.0;
const UP_R: f32 = 4.0;
const UP_MAX: f32 = 30.0;
const KNEE: f32 = 6.0;
const ATT_MS: [f32; 3] = [12.0, 5.0, 2.0];
const REL_MS: [f32; 3] = [140.0, 90.0, 60.0];

#[inline]
pub(crate) fn ott_curve(x: f32, up: f32, down: f32) -> f32 {
    let over = x - DOWN_T;
    let d = if over <= -KNEE * 0.5 {
        0.0
    } else if over < KNEE * 0.5 {
        let z = over + KNEE * 0.5;
        (1.0 / DOWN_R - 1.0) * z * z / (2.0 * KNEE)
    } else {
        (1.0 / DOWN_R - 1.0) * over
    };
    let under = UP_T - x;
    let mut u = if under > 0.0 { (under * (1.0 - 1.0 / UP_R)).min(UP_MAX) } else { 0.0 };
    u *= ((x + 90.0) / 10.0).clamp(0.0, 1.0);
    d * down + u * up
}

pub struct Squash {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    sr: f32,
    split: [Split3; 2],
    det: [Follower; 3],
    up: f32,
    down: f32,
    depth: Smooth,
    in_gain: Smooth,
    out_gain: Smooth,
    band_gain: [Smooth; 3],
    gr_db: f32,
}

impl Squash {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let sm = |v| Smooth::with_time(v, 15.0, sr);
        let mut o = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            split: [Split3::default(); 2],
            det: [Follower::default(); 3],
            up: 1.0,
            down: 1.0,
            depth: sm(1.0),
            in_gain: sm(1.0),
            out_gain: sm(1.0),
            band_gain: [sm(1.0); 3],
            gr_db: 0.0,
        };
        o.update();
        o.snap();
        o
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.depth.set(p.get(P::Depth as usize));
        self.up = p.get(P::Upward as usize);
        self.down = p.get(P::Downward as usize);
        let mult = 4f32.powf(2.0 * p.get(P::Time as usize) - 1.0);
        for b in 0..3 {
            self.det[b].set(ATT_MS[b] * mult, REL_MS[b] * mult, self.sr);
        }
        self.in_gain.set(db_to_gain(p.get(P::InGain as usize)));
        self.out_gain.set(db_to_gain(p.get(P::OutGain as usize)));
        self.band_gain[0].set(db_to_gain(p.get(P::LowGain as usize)));
        self.band_gain[1].set(db_to_gain(p.get(P::MidGain as usize)));
        self.band_gain[2].set(db_to_gain(p.get(P::HighGain as usize)));
        let (lo, hi) = (p.get(P::LowFreq as usize) as f64, p.get(P::HighFreq as usize) as f64);
        for s in self.split.iter_mut() {
            s.set(lo, hi, self.sr as f64);
        }
    }

    fn snap(&mut self) {
        for s in [&mut self.depth, &mut self.in_gain, &mut self.out_gain] {
            s.reset(s.target);
        }
        for s in self.band_gain.iter_mut() {
            s.reset(s.target);
        }
    }
}

impl Effect for Squash {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Squash::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        self.snap();
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn process(&mut self, ctx: &ProcessContext, mut buf: [&mut [f32]; 2], _sc: Option<[&[f32]; 2]>) {
        let n = frames(ctx, &buf);
        if self.pb.take_dirty() {
            self.update();
        }
        if self.fresh {
            self.fresh = false;
            self.snap();
        }
        let (mut e_dry, mut e_wet) = (0f32, 0f32);
        for i in 0..n {
            let gi = self.in_gain.next();
            let depth = self.depth.next();
            let go = self.out_gain.next();
            let mut bands = [[0.0f32; 3]; 2];
            for ch in 0..2 {
                let x = crate::blocks::finite(buf[ch][i]) * gi;
                let (l, m, h) = self.split[ch].split(x as f64);
                bands[ch] = [l as f32, m as f32, h as f32];
            }
            let mut out = [0.0f32; 2];
            let mut dry = [0.0f32; 2];
            for b in 0..3 {
                let lvl = bands[0][b].abs().max(bands[1][b].abs());
                let env = self.det[b].tick(lvl);
                let xdb = if env > 1e-9 { 20.0 * env.log10() } else { -180.0 };
                let g = db_to_gain(ott_curve(xdb, self.up, self.down));
                let bg = self.band_gain[b].next();
                let k = (1.0 + depth * (g - 1.0)) * bg;
                out[0] += bands[0][b] * k;
                out[1] += bands[1][b] * k;
                dry[0] += bands[0][b] * bg;
                dry[1] += bands[1][b] * bg;
            }
            e_dry += dry[0] * dry[0] + dry[1] * dry[1];
            e_wet += out[0] * out[0] + out[1] * out[1];
            buf[0][i] = out[0] * go;
            buf[1][i] = out[1] * go;
        }
        self.gr_db = if e_dry > 1e-12 && e_wet > 1e-20 && e_dry > e_wet { (10.0 * (e_dry / e_wet).log10()).min(60.0) } else { 0.0 };
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.split.iter_mut().for_each(Split3::reset);
        self.det.iter_mut().for_each(Follower::reset);
        self.gr_db = 0.0;
    }

    fn meter(&self) -> Option<f32> {
        Some(self.gr_db)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_shape() {
        assert!(ott_curve(0.0, 1.0, 1.0) < -20.0, "loud bands come down");
        assert!(ott_curve(-30.0, 1.0, 1.0).abs() < 1e-6, "between thresholds: untouched");
        assert!(ott_curve(-60.0, 1.0, 1.0) > 15.0, "quiet bands come up");
        assert_eq!(ott_curve(-150.0, 1.0, 1.0), 0.0, "silence is not lifted");
        assert_eq!(ott_curve(-60.0, 0.0, 1.0), 0.0);
        assert_eq!(ott_curve(0.0, 1.0, 0.0), 0.0);
    }
}
