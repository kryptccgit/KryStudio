use super::{frames, sane_sr, sanitize_block};
use crate::blocks::crossover::{Split3, Split3Allpass};
use crate::blocks::{db_to_gain, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    LowWidth => lin("lowWidth", "Low width", 0.0, 2.0, 1.0, "%", "Width"),
    MidWidth => lin("midWidth", "Mid width", 0.0, 2.0, 1.0, "%", "Width"),
    HighWidth => lin("highWidth", "High width", 0.0, 2.0, 1.0, "%", "Width"),
    LowFreq => logp("lowFreq", "Low/mid split", 40.0, 1000.0, 200.0, "Hz", "Bands"),
    HighFreq => logp("highFreq", "Mid/high split", 1000.0, 16000.0, 4000.0, "Hz", "Bands"),
    Output => lin("output", "Output", -12.0, 12.0, 0.0, "dB", "Output"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.imager",
        name: "Krypt Imager",
        kind: PluginKind::Effect,
        category: "Stereo",
        description: "Multiband stereo width: low, mid and high bands each from 0% (mono) through 100% (unchanged) to 200% \
                      (extra wide). Low width 0% gives mono-compatible bass. Linkwitz-Riley crossovers keep mid and side \
                      phase-aligned, so the magnitude is flat at default. Zero latency.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

pub struct Imager {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    sr: f32,
    split: Split3,
    ap: Split3Allpass,
    width: [Smooth; 3],
    out: Smooth,
}

impl Imager {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let sm = |v| Smooth::with_time(v, 15.0, sr);
        let mut im = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            split: Split3::default(),
            ap: Split3Allpass::default(),
            width: [sm(1.0); 3],
            out: sm(1.0),
        };
        im.update();
        im.snap();
        im
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.width[0].set(p.get(P::LowWidth as usize));
        self.width[1].set(p.get(P::MidWidth as usize));
        self.width[2].set(p.get(P::HighWidth as usize));
        self.out.set(db_to_gain(p.get(P::Output as usize)));
        let (lo, hi) = (p.get(P::LowFreq as usize) as f64, p.get(P::HighFreq as usize) as f64);
        self.split.set(lo, hi, self.sr as f64);
        self.ap.set(lo, hi, self.sr as f64);
    }

    fn snap(&mut self) {
        for w in self.width.iter_mut() {
            w.reset(w.target);
        }
        self.out.reset(self.out.target);
    }
}

impl Effect for Imager {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Imager::new(sample_rate, max_frames);
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
        for i in 0..n {
            let (l, r) = (crate::blocks::finite(buf[0][i]) as f64, crate::blocks::finite(buf[1][i]) as f64);
            let m = self.ap.tick(0.5 * (l + r));
            let (sl, sm, sh) = self.split.split(0.5 * (l - r));
            let (w0, w1, w2) = (self.width[0].next() as f64, self.width[1].next() as f64, self.width[2].next() as f64);
            let s = sl * w0 + sm * w1 + sh * w2;
            let g = self.out.next();
            buf[0][i] = ((m + s) as f32) * g;
            buf[1][i] = ((m - s) as f32) * g;
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.split.reset();
        self.ap.reset();
    }
}
