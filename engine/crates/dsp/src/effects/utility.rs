use super::{frames, sane_sr, sanitize_block};
use crate::blocks::filters::DcBlock;
use crate::blocks::{db_to_gain, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Gain => lin("gain", "Gain", -48.0, 24.0, 0.0, "dB", "Utility"),
    Pan => lin("pan", "Pan", -1.0, 1.0, 0.0, "", "Utility"),
    Width => lin("width", "Width", 0.0, 2.0, 1.0, "%", "Utility"),
    Mono => toggle("mono", "Mono", false, "Utility"),
    InvertL => toggle("invertL", "Invert L", false, "Utility"),
    InvertR => toggle("invertR", "Invert R", false, "Utility"),
    DcFilter => toggle("dcFilter", "DC filter", false, "Utility"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.utility",
        name: "Krypt Utility",
        kind: PluginKind::Effect,
        category: "Utility",
        description: "Gain, balance pan, stereo width (0 = mono, 1 = unchanged, 2 = extra wide), mono sum, per-channel \
                      polarity and a 5 Hz DC filter. All moves are click-free.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

pub struct Utility {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    gain: Smooth,
    gl: Smooth,
    gr: Smooth,
    width: Smooth,
    pol_l: Smooth,
    pol_r: Smooth,
    dc_mix: Smooth,
    dc: [DcBlock; 2],
}

impl Utility {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let sm = |v| Smooth::with_time(v, 8.0, sr);
        let mut u = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            gain: sm(1.0),
            gl: sm(1.0),
            gr: sm(1.0),
            width: sm(1.0),
            pol_l: sm(1.0),
            pol_r: sm(1.0),
            dc_mix: sm(0.0),
            dc: [DcBlock::new(5.0, sr); 2],
        };
        u.update();
        for s in [&mut u.gain, &mut u.gl, &mut u.gr, &mut u.width, &mut u.pol_l, &mut u.pol_r, &mut u.dc_mix] {
            s.reset(s.target);
        }
        u
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.gain.set(db_to_gain(p.get(P::Gain as usize)));
        let pan = p.get(P::Pan as usize);
        let half_pi = std::f32::consts::FRAC_PI_2;
        self.gl.set(if pan > 0.0 { (pan * half_pi).cos() } else { 1.0 });
        self.gr.set(if pan < 0.0 { (-pan * half_pi).cos() } else { 1.0 });
        let w = if p.on(P::Mono as usize) { 0.0 } else { p.get(P::Width as usize) };
        self.width.set(w);
        self.pol_l.set(if p.on(P::InvertL as usize) { -1.0 } else { 1.0 });
        self.pol_r.set(if p.on(P::InvertR as usize) { -1.0 } else { 1.0 });
        self.dc_mix.set(if p.on(P::DcFilter as usize) { 1.0 } else { 0.0 });
    }
}

impl Utility {
    fn snap(&mut self) {
        for s in [&mut self.gain, &mut self.gl, &mut self.gr, &mut self.width, &mut self.pol_l, &mut self.pol_r, &mut self.dc_mix] {
            s.reset(s.target);
        }
    }
}

impl Effect for Utility {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Utility::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
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
            let (mut l, mut r) = (crate::blocks::finite(buf[0][i]), crate::blocks::finite(buf[1][i]));
            let dm = self.dc_mix.next();
            let (fl, fr) = (self.dc[0].tick(l), self.dc[1].tick(r));
            if dm > 0.0 {
                l += (fl - l) * dm;
                r += (fr - r) * dm;
            }
            let w = self.width.next();
            let m = 0.5 * (l + r);
            let s = 0.5 * (l - r) * w;
            let g = self.gain.next();
            l = (m + s) * self.pol_l.next() * self.gl.next() * g;
            r = (m - s) * self.pol_r.next() * self.gr.next() * g;
            buf[0][i] = l;
            buf[1][i] = r;
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.dc.iter_mut().for_each(DcBlock::reset);
    }
}
