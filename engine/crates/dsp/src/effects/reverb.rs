use super::{frames, sane_sr, sanitize_block};
use crate::blocks::delay::{Allpass, DelayLine};
use crate::blocks::filters::{OnePole, Svf, SvfMode};
use crate::blocks::{Rng, Smooth, TAU};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Mode => choice("mode", "Mode", &["Room", "Hall", "Plate"], 1, "Reverb"),
    Size => lin("size", "Size", 0.0, 1.0, 0.6, "%", "Reverb"),
    Decay => logp("decay", "Decay", 0.1, 20.0, 2.2, "s", "Reverb"),
    Predelay => logp("predelay", "Pre-delay", 0.1, 250.0, 12.0, "ms", "Reverb"),
    Damping => logp("damping", "Damping", 1000.0, 20000.0, 7000.0, "Hz", "Reverb"),
    LowCut => logp("lowCut", "Low cut", 20.0, 1000.0, 120.0, "Hz", "Reverb"),
    Diffusion => lin("diffusion", "Diffusion", 0.0, 1.0, 0.75, "%", "Reverb"),
    Width => lin("width", "Width", 0.0, 1.0, 1.0, "%", "Reverb"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.reverb",
        name: "Krypt Reverb",
        kind: PluginKind::Effect,
        category: "Space",
        description: "Algorithmic reverb: Room and Hall (dense diffused feedback delay network) and Plate (classic plate \
                      tank). Outputs 100% wet; the slot's mix knob sets the blend (default 25%). Decay is RT60 in seconds; \
                      damping and low cut shape the tail.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(0.25),
    }
}

const N: usize = 8;
const MAX_SCALE: f32 = 1.45;

const HALL_MS: [f32; N] = [53.1, 61.7, 71.3, 79.9, 89.2, 97.3, 108.6, 117.4];
const ROOM_MS: [f32; N] = [17.3, 21.1, 24.7, 28.9, 32.2, 36.5, 41.1, 45.4];
const HALL_DIFF_MS: [f32; 4] = [6.0, 11.0, 19.0, 33.0];
const ROOM_DIFF_MS: [f32; 4] = [2.5, 4.5, 8.0, 14.0];

#[inline]
fn hadamard8(x: &mut [f32; N]) {
    let mut h = 1;
    while h < N {
        let mut i = 0;
        while i < N {
            for j in i..i + h {
                let a = x[j];
                let b = x[j + h];
                x[j] = a + b;
                x[j + h] = a - b;
            }
            i += 2 * h;
        }
        h *= 2;
    }
    let s = 1.0 / (N as f32).sqrt();
    for v in x.iter_mut() {
        *v *= s;
    }
}

struct DiffStage {
    lines: [DelayLine; N],
    frac: [f32; N],
    flip: [bool; N],
    len: [usize; N],
}

struct Fdn {
    diff: [DiffStage; 4],
    lines: [DelayLine; N],
    damp: [OnePole; N],
    base_len: [f32; N],
    gains: [f32; N],
    lfo: [f32; N],
    lfo_inc: [f32; N],
    mod_depth: f32,
    er_gain: f32,
    in_gain: f32,
}

impl Fdn {
    fn new(sr: f32, seed: u32) -> Self {
        let mut rng = Rng::new(seed);
        let max_diff = (HALL_DIFF_MS[3] * 0.001 * sr * MAX_SCALE) as usize + 8;
        let max_line = (HALL_MS[N - 1] * 0.001 * sr * MAX_SCALE) as usize + 64;
        let mk_stage = |rng: &mut Rng| DiffStage {
            lines: std::array::from_fn(|_| DelayLine::new(max_diff)),
            frac: std::array::from_fn(|c| (c as f32 + rng.unit()) / N as f32),
            flip: std::array::from_fn(|_| rng.unit() < 0.5),
            len: [1; N],
        };
        let diff = [mk_stage(&mut rng), mk_stage(&mut rng), mk_stage(&mut rng), mk_stage(&mut rng)];
        let lfo = std::array::from_fn(|i| i as f32 * 0.37);
        let lfo_inc = std::array::from_fn(|i| (0.31 + 0.13 * i as f32) / sr);
        Self {
            diff,
            lines: std::array::from_fn(|_| DelayLine::new(max_line)),
            damp: [OnePole::default(); N],
            base_len: [1000.0; N],
            gains: [0.5; N],
            lfo,
            lfo_inc,
            mod_depth: 0.0,
            er_gain: 0.3,
            in_gain: 0.5,
        }
    }

    fn configure(&mut self, hall: bool, size: f32, decay_s: f32, damping: f32, diffusion: f32, sr: f32) {
        let scale = if hall { 0.55 + 0.9 * size } else { 0.5 + 0.95 * size };
        let lens = if hall { &HALL_MS } else { &ROOM_MS };
        let dms = if hall { &HALL_DIFF_MS } else { &ROOM_DIFF_MS };
        let dscale = scale * (0.25 + 0.75 * diffusion);
        for (s, st) in self.diff.iter_mut().enumerate() {
            let stage_len = dms[s] * 0.001 * sr * dscale;
            for c in 0..N {
                st.len[c] = ((st.frac[c] * stage_len) as usize).clamp(1, st.lines[c].capacity() - 2);
            }
        }
        let mut gsum = 0.0;
        for i in 0..N {
            let len = (lens[i] * 0.001 * sr * scale).min(self.lines[i].capacity() as f32 - 40.0);
            self.base_len[i] = len;
            let g = 10f32.powf(-3.0 * len / (decay_s.max(0.05) * sr));
            self.gains[i] = g;
            gsum += g * g;
            self.damp[i].set(damping, sr);
        }
        self.mod_depth = if hall { 0.0006 * sr } else { 0.00025 * sr };
        self.er_gain = if hall { 0.25 } else { 0.55 };
        let gm = (gsum / N as f32).min(0.9999);
        self.in_gain = (1.0 - gm).powf(0.25) * 0.7;
    }

    fn clear(&mut self) {
        for st in self.diff.iter_mut() {
            st.lines.iter_mut().for_each(DelayLine::clear);
        }
        self.lines.iter_mut().for_each(DelayLine::clear);
        self.damp.iter_mut().for_each(OnePole::reset);
    }

    #[inline]
    fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        let mut x: [f32; N] = [l, r, l, r, -l, -r, l, -r];
        for st in self.diff.iter_mut() {
            for c in 0..N {
                st.lines[c].push(x[c]);
                let v = st.lines[c].read(st.len[c]);
                x[c] = if st.flip[c] { -v } else { v };
            }
            x.rotate_left(3);
            hadamard8(&mut x);
        }
        let mut d = [0.0f32; N];
        for i in 0..N {
            let m = if self.mod_depth > 0.0 && i < 4 {
                self.lfo[i] += self.lfo_inc[i];
                if self.lfo[i] >= 1.0 {
                    self.lfo[i] -= 1.0;
                }
                (self.lfo[i] * TAU).sin() * self.mod_depth
            } else {
                0.0
            };
            d[i] = self.lines[i].read_frac(self.base_len[i] + m);
        }
        let mut fb = [0.0f32; N];
        let mut sum = 0.0;
        for i in 0..N {
            fb[i] = self.damp[i].lp(d[i]) * self.gains[i];
            sum += fb[i];
        }
        let k = sum * (2.0 / N as f32);
        for i in 0..N {
            self.lines[i].push(crate::blocks::flush(fb[i] - k + x[i] * self.in_gain));
        }
        let late_l = d[0] - d[1] + d[2] - d[3] + d[4] - d[5] + d[6] - d[7];
        let late_r = d[0] + d[1] - d[2] - d[3] + d[4] + d[5] - d[6] - d[7];
        let er_l = x[0] + x[2] - x[5] - x[7];
        let er_r = x[1] + x[3] - x[4] - x[6];
        let s = 0.3535;
        (late_l * s + er_l * 0.5 * self.er_gain, late_r * s + er_r * 0.5 * self.er_gain)
    }
}

const DT_SR: f32 = 29761.0;
const DT_IN_AP: [f32; 4] = [142.0, 107.0, 379.0, 277.0];
const DT_IN_G: [f32; 4] = [0.75, 0.75, 0.625, 0.625];

struct Plate {
    in_lp: OnePole,
    in_ap: [Allpass; 4],
    ap_l1: Allpass,
    dl_l1: DelayLine,
    damp_l: OnePole,
    ap_l2: Allpass,
    dl_l2: DelayLine,
    ap_r1: Allpass,
    dl_r1: DelayLine,
    damp_r: OnePole,
    ap_r2: Allpass,
    dl_r2: DelayLine,
    len_ap_l1: f32,
    len_l1: usize,
    len_l2: usize,
    len_ap_r1: f32,
    len_r1: usize,
    len_r2: usize,
    g1_l: f32,
    g2_l: f32,
    g1_r: f32,
    g2_r: f32,
    excursion: f32,
    lfo: f32,
    lfo_inc: f32,
    taps_scale: f32,
    fb_l: f32,
    fb_r: f32,
}

impl Plate {
    fn new(sr: f32) -> Self {
        let k = sr / DT_SR;
        let mx = |n: f32| (n * k * MAX_SCALE) as usize + 64;
        let in_ap = std::array::from_fn(|i| Allpass::new((DT_IN_AP[i] * k) as usize + 4, DT_IN_AP[i] * k, DT_IN_G[i]));
        Self {
            in_lp: OnePole::default(),
            in_ap,
            ap_l1: Allpass::new(mx(672.0 + 40.0), 672.0 * k, -0.7),
            dl_l1: DelayLine::new(mx(4453.0)),
            damp_l: OnePole::default(),
            ap_l2: Allpass::new(mx(1800.0), 1800.0 * k, 0.5),
            dl_l2: DelayLine::new(mx(3720.0)),
            ap_r1: Allpass::new(mx(908.0 + 40.0), 908.0 * k, -0.7),
            dl_r1: DelayLine::new(mx(4217.0)),
            damp_r: OnePole::default(),
            ap_r2: Allpass::new(mx(2656.0), 2656.0 * k, 0.5),
            dl_r2: DelayLine::new(mx(3163.0)),
            len_ap_l1: 672.0 * k,
            len_l1: (4453.0 * k) as usize,
            len_l2: (3720.0 * k) as usize,
            len_ap_r1: 908.0 * k,
            len_r1: (4217.0 * k) as usize,
            len_r2: (3163.0 * k) as usize,
            g1_l: 0.5,
            g2_l: 0.5,
            g1_r: 0.5,
            g2_r: 0.5,
            excursion: 16.0 * k,
            lfo: 0.0,
            lfo_inc: 0.9 / sr,
            taps_scale: k,
            fb_l: 0.0,
            fb_r: 0.0,
        }
    }

    fn configure(&mut self, size: f32, decay_s: f32, damping: f32, diffusion: f32, sr: f32) {
        let k = sr / DT_SR;
        let scale = 0.45 + size;
        let s = k * scale;
        self.len_ap_l1 = 672.0 * s;
        self.len_l1 = (4453.0 * s) as usize;
        self.ap_l2.len = 1800.0 * s;
        self.len_l2 = (3720.0 * s) as usize;
        self.len_ap_r1 = 908.0 * s;
        self.len_r1 = (4217.0 * s) as usize;
        self.ap_r2.len = 2656.0 * s;
        self.len_r2 = (3163.0 * s) as usize;
        self.taps_scale = s;
        let t60 = decay_s.max(0.05) * sr;
        let g = |len: f32| 10f32.powf(-3.0 * len / t60);
        self.g1_l = g(self.len_ap_l1 + self.len_l1 as f32);
        self.g2_l = g(self.ap_l2.len + self.len_l2 as f32);
        self.g1_r = g(self.len_ap_r1 + self.len_r1 as f32);
        self.g2_r = g(self.ap_r2.len + self.len_r2 as f32);
        let dd2 = (0.15 + self.g2_l).clamp(0.25, 0.5);
        self.ap_l2.g = dd2;
        self.ap_r2.g = dd2;
        let dscale = (diffusion / 0.75).clamp(0.0, 1.2);
        for (i, ap) in self.in_ap.iter_mut().enumerate() {
            ap.g = (DT_IN_G[i] * dscale).min(0.85);
        }
        self.damp_l.set(damping, sr);
        self.damp_r.set(damping, sr);
        self.in_lp.set(14000.0f32.min(sr * 0.45), sr);
    }

    fn clear(&mut self) {
        self.in_ap.iter_mut().for_each(Allpass::clear);
        for ap in [&mut self.ap_l1, &mut self.ap_l2, &mut self.ap_r1, &mut self.ap_r2] {
            ap.clear();
        }
        for d in [&mut self.dl_l1, &mut self.dl_l2, &mut self.dl_r1, &mut self.dl_r2] {
            d.clear();
        }
        self.damp_l.reset();
        self.damp_r.reset();
        self.in_lp.reset();
        self.fb_l = 0.0;
        self.fb_r = 0.0;
    }

    #[inline]
    fn tap(d: &DelayLine, n: f32, s: f32) -> f32 {
        d.read((n * s) as usize)
    }

    #[inline]
    fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        let mut x = self.in_lp.lp((l + r) * 0.5);
        for ap in self.in_ap.iter_mut() {
            x = ap.tick(x);
        }
        self.lfo += self.lfo_inc;
        if self.lfo >= 1.0 {
            self.lfo -= 1.0;
        }
        let m = (self.lfo * TAU).sin() * self.excursion;
        let m2 = (self.lfo * TAU).cos() * self.excursion;
        let a = self.ap_l1.tick_mod(x + self.fb_r, self.len_ap_l1 + m);
        self.dl_l1.push(a);
        let b = self.dl_l1.read(self.len_l1);
        let b = self.damp_l.lp(b) * self.g1_l;
        let c = self.ap_l2.tick(b);
        self.dl_l2.push(c);
        let out_l = self.dl_l2.read(self.len_l2) * self.g2_l;
        let a = self.ap_r1.tick_mod(x + self.fb_l, self.len_ap_r1 + m2);
        self.dl_r1.push(a);
        let b = self.dl_r1.read(self.len_r1);
        let b = self.damp_r.lp(b) * self.g1_r;
        let c = self.ap_r2.tick(b);
        self.dl_r2.push(c);
        let out_r = self.dl_r2.read(self.len_r2) * self.g2_r;
        self.fb_l = crate::blocks::flush(out_l);
        self.fb_r = crate::blocks::flush(out_r);
        let s = self.taps_scale;
        let yl = Self::tap(&self.dl_r1, 266.0, s) + Self::tap(&self.dl_r1, 2974.0, s) - self.ap_r2.tap((1913.0 * s) as usize)
            + Self::tap(&self.dl_r2, 1996.0, s)
            - Self::tap(&self.dl_l1, 1990.0, s)
            - self.ap_l2.tap((187.0 * s) as usize)
            - Self::tap(&self.dl_l2, 1066.0, s);
        let yr = Self::tap(&self.dl_l1, 353.0, s) + Self::tap(&self.dl_l1, 3627.0, s) - self.ap_l2.tap((1228.0 * s) as usize)
            + Self::tap(&self.dl_l2, 2673.0, s)
            - Self::tap(&self.dl_r1, 2111.0, s)
            - self.ap_r2.tap((335.0 * s) as usize)
            - Self::tap(&self.dl_r2, 121.0, s);
        (yl * 0.6, yr * 0.6)
    }
}

pub struct Reverb {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    sr: f32,
    mode: usize,
    pre: [DelayLine; 2],
    pre_len: Smooth,
    hp: [Svf; 2],
    fdn: Fdn,
    plate: Plate,
    width: Smooth,
    fade: f32,
    pending: Option<usize>,
    plate_gain: f32,
}

impl Reverb {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let max_pre = (0.26 * sr) as usize + 8;
        let mut s = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            mode: 1,
            pre: [DelayLine::new(max_pre), DelayLine::new(max_pre)],
            pre_len: Smooth::with_time(12.0, 60.0, sr),
            hp: [Svf::default(); 2],
            fdn: Fdn::new(sr, 0xC0FFEE),
            plate: Plate::new(sr),
            width: Smooth::with_time(1.0, 20.0, sr),
            fade: 1.0,
            pending: None,
            plate_gain: 1.0,
        };
        s.mode = s.pb.idx(P::Mode as usize).min(2);
        s.update();
        s.pre_len.reset(s.pre_len.target);
        s.width.reset(s.width.target);
        s
    }

    fn update(&mut self) {
        let p = &self.pb;
        let mode = p.idx(P::Mode as usize).min(2);
        if mode != self.mode {
            self.pending = Some(mode);
        } else {
            self.pending = None;
        }
        self.configure();
        let p = &self.pb;
        let sr = self.sr;
        self.pre_len.set(p.get(P::Predelay as usize) * 0.001 * sr);
        let lc = p.get(P::LowCut as usize) as f64;
        for h in self.hp.iter_mut() {
            h.design(SvfMode::Highpass, lc, 0.707, 0.0, sr as f64);
        }
        self.width.set(p.get(P::Width as usize));
    }

    fn configure(&mut self) {
        let p = &self.pb;
        let sr = self.sr;
        let mode = self.mode;
        let size = p.get(P::Size as usize);
        let decay = p.get(P::Decay as usize);
        let damping = p.get(P::Damping as usize).min(sr * 0.45);
        let diffusion = p.get(P::Diffusion as usize);
        if mode == 2 {
            self.plate.configure(size, decay, damping, diffusion, sr);
            let g = 10f32.powf(-3.0 * (self.plate.len_l1 + self.plate.len_r1) as f32 / (decay.max(0.05) * sr));
            self.plate_gain = (1.0 - g * g).max(0.0001).powf(0.25) * 1.2;
        } else {
            self.fdn.configure(mode == 1, size, decay, damping, diffusion, sr);
        }
    }
}

impl Reverb {
    fn snap(&mut self) {
        self.pre_len.reset(self.pre_len.target);
        self.width.reset(self.width.target);
        if let Some(m) = self.pending.take() {
            self.mode = m;
            self.fdn.clear();
            self.plate.clear();
            self.configure();
        }
        self.fade = 1.0;
    }
}

impl Effect for Reverb {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Reverb::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.mode = self.pb.idx(P::Mode as usize).min(2);
        self.update();
        self.pending = None;
        self.pre_len.reset(self.pre_len.target);
        self.width.reset(self.width.target);
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
        let xf_step = 1.0 / (0.015 * self.sr);
        for i in 0..n {
            let (l, r) = (crate::blocks::finite(buf[0][i]), crate::blocks::finite(buf[1][i]));
            self.pre[0].push(l);
            self.pre[1].push(r);
            let pl = self.pre_len.next().max(0.0);
            let (l, r) = (self.pre[0].read_frac(pl.max(1.0)), self.pre[1].read_frac(pl.max(1.0)));
            let l = self.hp[0].tick(l as f64) as f32;
            let r = self.hp[1].tick(r as f64) as f32;
            let (wl, wr) = if self.mode == 2 {
                let (a, b) = self.plate.tick(l, r);
                (a * self.plate_gain, b * self.plate_gain)
            } else {
                self.fdn.tick(l, r)
            };
            if let Some(m) = self.pending {
                self.fade -= xf_step;
                if self.fade <= 0.0 {
                    self.fade = 0.0;
                    self.mode = m;
                    self.pending = None;
                    self.fdn.clear();
                    self.plate.clear();
                    self.configure();
                }
            } else if self.fade < 1.0 {
                self.fade = (self.fade + xf_step).min(1.0);
            }
            let (wl, wr) = (wl * self.fade, wr * self.fade);
            let w = self.width.next();
            let mid = 0.5 * (wl + wr);
            let side = 0.5 * (wl - wr) * w;
            buf[0][i] = mid + side;
            buf[1][i] = mid - side;
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.pre.iter_mut().for_each(DelayLine::clear);
        self.hp.iter_mut().for_each(Svf::reset);
        self.fdn.clear();
        self.plate.clear();
    }
}
