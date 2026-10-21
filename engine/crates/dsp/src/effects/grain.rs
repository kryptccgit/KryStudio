use std::sync::Arc;

use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};

use super::{frames, sane_sr, sanitize_block};
use crate::blocks::delay::DelayLine;
use crate::blocks::{flush, tanh_fast, Rng, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Mode => choice("mode", "Mode", &["Grain", "Spectral"], 0, "Grain"),
    Delay => logp("delay", "Delay", 1.0, 2000.0, 120.0, "ms", "Grain"),
    Size => logp("size", "Grain size", 10.0, 500.0, 90.0, "ms", "Grain"),
    Density => logp("density", "Density", 1.0, 100.0, 20.0, "Hz", "Grain"),
    Pitch => lin("pitch", "Pitch", -24.0, 24.0, 0.0, "st", "Grain"),
    Spray => lin("spray", "Spray", 0.0, 1.0, 0.2, "%", "Grain"),
    Reverse => lin("reverse", "Reverse chance", 0.0, 1.0, 0.0, "%", "Grain"),
    Feedback => lin("feedback", "Feedback", 0.0, 0.95, 0.2, "%", "Grain"),
    Freeze => toggle("freeze", "Freeze", false, "Grain"),
    Blur => lin("blur", "Blur (spectral)", 0.0, 1.0, 0.5, "%", "Spectral"),
    Mix => lin("mix", "Mix", 0.0, 1.0, 0.5, "%", "Output"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.grain",
        name: "Krypt Grain",
        kind: PluginKind::Effect,
        category: "Space",
        description: "Granular delay and freeze: chops the incoming audio into grains (Size, Density per second) read \
                      from Delay ms ago, re-pitched (Pitch, ±24 st), scattered in time and stereo (Spray), some played \
                      backwards (Reverse chance), with Feedback. Freeze holds the buffer for endless textures. Spectral \
                      mode instead smears the sound's spectrum over time (Blur) and Freeze holds a chord as a pad (2048 \
                      samples latency). Deterministic. Mix is built in (default 50%).",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

const BUF_SECONDS: f32 = 6.0;
const MAX_GRAINS: usize = 64;
const WIN_LEN: usize = 512;
const FFT_N: usize = 2048;
const HOP: usize = FFT_N / 4;
const BINS: usize = FFT_N / 2 + 1;
const FIFO_START: usize = FFT_N - HOP;
pub(crate) const SPECTRAL_LATENCY: usize = FFT_N;

#[derive(Clone, Copy, Default)]
struct Grain {
    active: bool,
    d: f64,
    dd: f64,
    win: f32,
    win_inc: f32,
    gl: f32,
    gr: f32,
}

struct Spectral {
    fft: Arc<dyn Fft<f32>>,
    ifft: Arc<dyn Fft<f32>>,
    scratch: Vec<Complex32>,
    buf: Vec<Complex32>,
    window: Vec<f32>,
    in_fifo: [Vec<f32>; 2],
    out_fifo: [Vec<f32>; 2],
    accum: [Vec<f32>; 2],
    rover: usize,
    mag: [Vec<f32>; 2],
    prev_in: [Vec<Complex32>; 2],
    phasor: [Vec<Complex32>; 2],
    rot: [Vec<Complex32>; 2],
    frozen: bool,
}

impl Spectral {
    fn new() -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_N);
        let ifft = planner.plan_fft_inverse(FFT_N);
        let scratch_len = fft.get_inplace_scratch_len().max(ifft.get_inplace_scratch_len());
        let window = (0..FFT_N).map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / FFT_N as f32).cos()).collect();
        let z = Complex32::new(0.0, 0.0);
        let one = Complex32::new(1.0, 0.0);
        Self {
            fft,
            ifft,
            scratch: vec![z; scratch_len],
            buf: vec![z; FFT_N],
            window,
            in_fifo: [vec![0.0; FFT_N], vec![0.0; FFT_N]],
            out_fifo: [vec![0.0; FFT_N], vec![0.0; FFT_N]],
            accum: [vec![0.0; 2 * FFT_N], vec![0.0; 2 * FFT_N]],
            rover: FIFO_START,
            mag: [vec![0.0; BINS], vec![0.0; BINS]],
            prev_in: [vec![z; BINS], vec![z; BINS]],
            phasor: [vec![one; BINS], vec![one; BINS]],
            rot: [vec![one; BINS], vec![one; BINS]],
            frozen: false,
        }
    }

    fn reset(&mut self) {
        let z = Complex32::new(0.0, 0.0);
        let one = Complex32::new(1.0, 0.0);
        for ch in 0..2 {
            self.in_fifo[ch].fill(0.0);
            self.out_fifo[ch].fill(0.0);
            self.accum[ch].fill(0.0);
            self.mag[ch].fill(0.0);
            self.prev_in[ch].fill(z);
            self.phasor[ch].fill(one);
            self.rot[ch].fill(one);
        }
        self.rover = FIFO_START;
        self.frozen = false;
    }

    #[inline]
    fn tick(&mut self, x: [f32; 2], smooth: f32, freeze: bool) -> [f32; 2] {
        let r = self.rover;
        let mut y = [0.0f32; 2];
        for ch in 0..2 {
            self.in_fifo[ch][r] = x[ch];
            y[ch] = self.out_fifo[ch][r - FIFO_START];
        }
        self.rover += 1;
        if self.rover >= FFT_N {
            self.rover = FIFO_START;
            self.frame(smooth, freeze);
        }
        y
    }

    fn frame(&mut self, smooth: f32, freeze: bool) {
        for i in 0..FFT_N {
            let w = self.window[i];
            self.buf[i] = Complex32::new(self.in_fifo[0][i] * w, self.in_fifo[1][i] * w);
        }
        self.fft.process_with_scratch(&mut self.buf, &mut self.scratch);
        let engage = freeze && !self.frozen;
        self.frozen = freeze;
        let n = FFT_N;
        const QUARTER: [Complex32; 4] =
            [Complex32::new(1.0, 0.0), Complex32::new(0.0, 1.0), Complex32::new(-1.0, 0.0), Complex32::new(0.0, -1.0)];
        let mut out = [Complex32::new(0.0, 0.0); 2];
        for k in 0..BINS {
            let a = self.buf[k];
            let b = self.buf[(n - k) % n].conj();
            let xs = [(a + b) * 0.5, Complex32::new(0.0, -0.5) * (a - b)];
            for ch in 0..2 {
                let xk = xs[ch];
                let m = xk.norm();
                if engage {
                    let r = xk * self.prev_in[ch][k].conj();
                    let rn = r.norm();
                    self.rot[ch][k] = if rn > 1e-20 { r / rn } else { QUARTER[k % 4] };
                }
                self.prev_in[ch][k] = xk;
                let p = if freeze {
                    let p = self.phasor[ch][k] * self.rot[ch][k];
                    let pn = p.norm();
                    if pn > 1e-6 {
                        p / pn
                    } else {
                        Complex32::new(1.0, 0.0)
                    }
                } else if m > 1e-20 {
                    xk / m
                } else {
                    self.phasor[ch][k] * QUARTER[k % 4]
                };
                self.phasor[ch][k] = p;
                if !freeze {
                    let s = &mut self.mag[ch][k];
                    *s = m + (*s - m) * smooth;
                    if *s < 1e-7 {
                        *s = 0.0;
                    }
                }
                out[ch] = p * self.mag[ch][k];
            }
            let i = Complex32::new(0.0, 1.0);
            self.buf[k] = out[0] + i * out[1];
            if k > 0 && k < n / 2 {
                self.buf[n - k] = out[0].conj() + i * out[1].conj();
            }
        }
        self.ifft.process_with_scratch(&mut self.buf, &mut self.scratch);
        let scale = 1.0 / (1.5 * n as f32);
        for i in 0..n {
            let w = self.window[i] * scale;
            self.accum[0][i] += self.buf[i].re * w;
            self.accum[1][i] += self.buf[i].im * w;
        }
        for ch in 0..2 {
            self.out_fifo[ch][..HOP].copy_from_slice(&self.accum[ch][..HOP]);
            for v in self.out_fifo[ch][..HOP].iter_mut() {
                *v = flush(*v);
            }
            self.accum[ch].copy_within(HOP..HOP + n, 0);
            self.in_fifo[ch].copy_within(HOP..n, 0);
        }
    }
}

pub struct GrainFx {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    sr: f32,
    spectral_mode: bool,
    lines: [DelayLine; 2],
    cap: f64,
    grains: [Grain; MAX_GRAINS],
    window: [f32; WIN_LEN + 1],
    until_next: f32,
    delay_s: f32,
    size_s: f32,
    density: f32,
    ratio: f64,
    spray: f32,
    reverse: f32,
    freeze: bool,
    fb: Smooth,
    norm: Smooth,
    mix: Smooth,
    smooth: f32,
    last_wet: [f32; 2],
    dry_line: [DelayLine; 2],
    spec: Spectral,
    rng: Rng,
}

const SEED: u32 = 0x6A41;

impl GrainFx {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let len = (BUF_SECONDS * sr) as usize;
        let mut window = [0.0f32; WIN_LEN + 1];
        for (i, w) in window.iter_mut().enumerate() {
            *w = 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / WIN_LEN as f32).cos();
        }
        let mut g = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            spectral_mode: false,
            lines: [DelayLine::new(len), DelayLine::new(len)],
            cap: 0.0,
            grains: [Grain::default(); MAX_GRAINS],
            window,
            until_next: 0.0,
            delay_s: 0.12,
            size_s: 0.09,
            density: 20.0,
            ratio: 1.0,
            spray: 0.2,
            reverse: 0.0,
            freeze: false,
            fb: Smooth::with_time(0.2, 20.0, sr),
            norm: Smooth::with_time(1.0, 50.0, sr),
            mix: Smooth::with_time(0.5, 15.0, sr),
            smooth: 0.0,
            last_wet: [0.0; 2],
            dry_line: [DelayLine::new(SPECTRAL_LATENCY + 4), DelayLine::new(SPECTRAL_LATENCY + 4)],
            spec: Spectral::new(),
            rng: Rng::new(SEED),
        };
        g.cap = (g.lines[0].capacity() as f64 - 8.0).max(16.0);
        g.update();
        g.snap();
        g
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.spectral_mode = p.idx(P::Mode as usize) == 1;
        self.delay_s = p.get(P::Delay as usize) * 0.001;
        self.size_s = p.get(P::Size as usize) * 0.001;
        self.density = p.get(P::Density as usize);
        self.ratio = (p.get(P::Pitch as usize) as f64 / 12.0).exp2();
        self.spray = p.get(P::Spray as usize);
        self.reverse = p.get(P::Reverse as usize);
        self.freeze = p.on(P::Freeze as usize);
        self.fb.set(p.get(P::Feedback as usize));
        self.mix.set(p.get(P::Mix as usize));
        let overlap = (self.density * self.size_s * 0.5).max(1.0);
        self.norm.set(overlap.powf(-(1.0 - 0.5 * self.spray)));
        let blur = p.get(P::Blur as usize);
        let t = 5.0 * blur * blur;
        self.smooth = if t < 1e-4 { 0.0 } else { (-(HOP as f32) / (t * self.sr)).exp() };
    }

    fn snap(&mut self) {
        self.fb.reset(self.fb.target);
        self.norm.reset(self.norm.target);
        self.mix.reset(self.mix.target);
    }

    fn spawn(&mut self) {
        let Some(slot) = self.grains.iter().position(|g| !g.active) else { return };
        let sr = self.sr as f64;
        let len = (self.size_s as f64 * sr).max(8.0);
        let rate = self.ratio;
        let rev = self.reverse > 0.0 && self.rng.unit() < self.reverse;
        let spray = self.spray;
        let mut d = (self.delay_s as f64 + 0.5 * spray as f64 * self.rng.unit() as f64) * sr;
        let head = if self.freeze { 0.0 } else { 1.0 };
        let dd = if rev { head + rate } else { head - rate };
        let end = d + dd * len;
        if end < 2.0 {
            d += 2.0 - end;
        }
        let end = d + dd * len;
        if d.max(end) > self.cap {
            d -= d.max(end) - self.cap;
        }
        let d = d.max(2.0);
        let pan = spray * self.rng.bipolar();
        let (gl, gr) = crate::blocks::pan_gains(pan);
        self.grains[slot] = Grain { active: true, d, dd, win: 0.0, win_inc: (WIN_LEN as f64 / len) as f32, gl, gr };
    }

    #[inline]
    fn grain_tick(&mut self, x: [f32; 2]) -> [f32; 2] {
        if self.until_next <= 0.0 {
            self.spawn();
            let jitter = 1.0 + 0.5 * self.spray * self.rng.bipolar();
            self.until_next += (self.sr / self.density) * jitter;
        }
        self.until_next -= 1.0;
        let mut y = [0.0f32; 2];
        for g in self.grains.iter_mut() {
            if !g.active {
                continue;
            }
            let pos = g.win;
            let i = pos as usize;
            let w = if i >= WIN_LEN { 0.0 } else { self.window[i] + (self.window[i + 1] - self.window[i]) * (pos - i as f32) };
            let a = self.lines[0].read_f64(g.d);
            let b = self.lines[1].read_f64(g.d);
            y[0] += a * w * g.gl;
            y[1] += b * w * g.gr;
            g.d += g.dd;
            g.win += g.win_inc;
            if g.win >= WIN_LEN as f32 || g.d < 0.0 {
                g.active = false;
            }
        }
        let norm = self.norm.next();
        let fb = self.fb.next();
        y[0] *= norm;
        y[1] *= norm;
        if !self.freeze {
            for ch in 0..2 {
                let w = x[ch] + fb * tanh_fast(self.last_wet[ch]);
                self.lines[ch].push(flush(w));
            }
        }
        self.last_wet = y;
        y
    }

    fn latency_for(spectral: bool) -> usize {
        if spectral {
            SPECTRAL_LATENCY
        } else {
            0
        }
    }
}

impl Effect for GrainFx {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = GrainFx::new(sample_rate, max_frames);
        for (i, v) in vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update();
        self.snap();
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
        if index == P::Mode as usize {
            self.spectral_mode = self.pb.idx(index) == 1;
        }
    }

    fn latency(&self) -> usize {
        Self::latency_for(self.spectral_mode)
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
        let lat = self.latency();
        for i in 0..n {
            let x = [crate::blocks::finite(buf[0][i]), crate::blocks::finite(buf[1][i])];
            let mix = self.mix.next();
            let wet = if self.spectral_mode { self.spec.tick(x, self.smooth, self.freeze) } else { self.grain_tick(x) };
            for ch in 0..2 {
                self.dry_line[ch].push(x[ch]);
                let dry = if lat == 0 { x[ch] } else { self.dry_line[ch].read(lat) };
                buf[ch][i] = if mix == 0.0 { dry } else { dry * (1.0 - mix) + wet[ch] * mix };
            }
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.lines.iter_mut().for_each(DelayLine::clear);
        self.dry_line.iter_mut().for_each(DelayLine::clear);
        self.grains = [Grain::default(); MAX_GRAINS];
        self.until_next = 0.0;
        self.last_wet = [0.0; 2];
        self.spec.reset();
        self.rng = Rng::new(SEED);
    }
}
