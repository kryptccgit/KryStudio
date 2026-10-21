use std::os::raw::{c_double, c_float, c_int, c_long};
use std::sync::atomic::{AtomicBool, Ordering};

#[repr(C)]
struct KssHandle {
    _private: [u8; 0],
}

extern "C" {
    fn kss_create(channels: c_int, block_samples: c_int, interval_samples: c_int, split_computation: c_int, seed: c_long) -> *mut KssHandle;
    fn kss_destroy(h: *mut KssHandle);
    fn kss_block_samples(h: *const KssHandle) -> c_int;
    fn kss_interval_samples(h: *const KssHandle) -> c_int;
    fn kss_input_latency(h: *const KssHandle) -> c_int;
    fn kss_output_latency(h: *const KssHandle) -> c_int;
    fn kss_set_transpose_semitones(h: *mut KssHandle, semitones: c_float, tonality_limit: c_float) -> c_int;
    fn kss_set_formant(h: *mut KssHandle, factor: c_float, compensate_pitch: c_int, base_freq: c_float) -> c_int;
    fn kss_seek(h: *mut KssHandle, input: *const *const c_float, input_samples: c_int, playback_rate: c_double) -> c_int;
    fn kss_process(h: *mut KssHandle, input: *const *const c_float, input_samples: c_int, output: *const *mut c_float, output_samples: c_int) -> c_int;
    fn kss_flush(h: *mut KssHandle, output: *const *mut c_float, output_samples: c_int) -> c_int;
}

pub const MAX_CHANNELS: usize = 8;
pub const MIN_RATIO: f64 = 0.0625;
pub const MAX_RATIO: f64 = 16.0;
pub const MAX_SEMITONES: f64 = 48.0;
const SEED: c_long = 0x4b53_5452;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StretchSettings {
    pub time_ratio: f64,
    pub semitones: f64,
    pub keep_formants: bool,
}

impl StretchSettings {
    pub fn identity() -> Self {
        Self { time_ratio: 1.0, semitones: 0.0, keep_formants: true }
    }
    pub fn is_identity(&self) -> bool {
        self.time_ratio == 1.0 && self.semitones == 0.0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum StretchError {
    Cancelled,
    Failed(String),
}

impl std::fmt::Display for StretchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StretchError::Cancelled => write!(f, "time-stretch cancelled"),
            StretchError::Failed(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for StretchError {}

pub fn output_frames(input_frames: usize, ratio: f64) -> usize {
    (input_frames as f64 * ratio).round().max(0.0) as usize
}

pub fn config_for(sample_rate: f64, ratio: f64, input_frames: usize) -> (usize, usize) {
    let sr = if sample_rate.is_finite() && sample_rate >= 1000.0 { sample_rate } else { 48000.0 };
    let long = input_frames as f64 > 20.0 * 60.0 * sr;
    let (block_s, hop_s) = if long { (0.10, 0.04) } else { (0.12, 0.03) };
    let block = (block_s * sr).round().max(64.0);
    let hop = (hop_s * sr).min(ratio * block * 0.5).max(block / 16.0).round();
    (block as usize, hop as usize)
}

struct Stretcher {
    h: *mut KssHandle,
    channels: usize,
}

impl Drop for Stretcher {
    fn drop(&mut self) {
        unsafe { kss_destroy(self.h) }
    }
}

fn check(rc: c_int, what: &str) -> Result<(), StretchError> {
    if rc == 0 {
        Ok(())
    } else {
        Err(StretchError::Failed(format!("Signalsmith Stretch failed in {what} (out of memory?)")))
    }
}

fn to_int(n: usize) -> Result<c_int, StretchError> {
    c_int::try_from(n).map_err(|_| StretchError::Failed("time-stretch chunk too large".into()))
}

impl Stretcher {
    fn new(channels: usize, block: usize, interval: usize) -> Result<Self, StretchError> {
        let h = unsafe { kss_create(to_int(channels)?, to_int(block)?, to_int(interval)?, 0, SEED) };
        if h.is_null() {
            return Err(StretchError::Failed("could not create the time-stretcher (out of memory?)".into()));
        }
        Ok(Self { h, channels })
    }
    fn input_latency(&self) -> usize {
        unsafe { kss_input_latency(self.h) }.max(0) as usize
    }
    fn output_latency(&self) -> usize {
        unsafe { kss_output_latency(self.h) }.max(0) as usize
    }
    #[allow(dead_code)]
    fn block(&self) -> usize {
        unsafe { kss_block_samples(self.h) }.max(0) as usize
    }
    #[allow(dead_code)]
    fn interval(&self) -> usize {
        unsafe { kss_interval_samples(self.h) }.max(0) as usize
    }
    fn set_pitch(&mut self, semitones: f64, keep_formants: bool) -> Result<(), StretchError> {
        check(unsafe { kss_set_transpose_semitones(self.h, semitones as f32, 0.0) }, "setTransposeSemitones")?;
        let compensate = keep_formants && semitones != 0.0;
        check(unsafe { kss_set_formant(self.h, 1.0, compensate as c_int, 0.0) }, "setFormantFactor")
    }
    fn set_pitch_curved(&mut self, semitones: f64, keep_formants: bool) -> Result<(), StretchError> {
        check(unsafe { kss_set_transpose_semitones(self.h, semitones as f32, 0.0) }, "setTransposeSemitones")?;
        check(unsafe { kss_set_formant(self.h, 1.0, keep_formants as c_int, 0.0) }, "setFormantFactor")
    }
    fn seek(&mut self, input: &[&[f32]], rate: f64) -> Result<(), StretchError> {
        let ptrs = in_ptrs(input);
        let n = input.first().map_or(0, |c| c.len());
        check(unsafe { kss_seek(self.h, ptrs.as_ptr(), to_int(n)?, rate) }, "seek")
    }
    fn process(&mut self, input: &[&[f32]], output: &mut [&mut [f32]]) -> Result<(), StretchError> {
        let ip = in_ptrs(input);
        let op = out_ptrs(output);
        let ni = input.first().map_or(0, |c| c.len());
        let no = output.first().map_or(0, |c| c.len());
        check(unsafe { kss_process(self.h, ip.as_ptr(), to_int(ni)?, op.as_ptr(), to_int(no)?) }, "process")
    }
    fn flush(&mut self, output: &mut [&mut [f32]]) -> Result<(), StretchError> {
        let op = out_ptrs(output);
        let no = output.first().map_or(0, |c| c.len());
        check(unsafe { kss_flush(self.h, op.as_ptr(), to_int(no)?) }, "flush")
    }
}

fn in_ptrs(b: &[&[f32]]) -> [*const f32; MAX_CHANNELS] {
    let mut p = [std::ptr::null(); MAX_CHANNELS];
    for (i, c) in b.iter().take(MAX_CHANNELS).enumerate() {
        p[i] = c.as_ptr();
    }
    p
}

fn out_ptrs(b: &mut [&mut [f32]]) -> [*mut f32; MAX_CHANNELS] {
    let mut p = [std::ptr::null_mut(); MAX_CHANNELS];
    for (i, c) in b.iter_mut().take(MAX_CHANNELS).enumerate() {
        p[i] = c.as_mut_ptr();
    }
    p
}

struct Virtual<'a> {
    input: &'a [&'a [f32]],
    shift: isize,
}

impl Virtual<'_> {
    fn real_len(&self) -> usize {
        self.input[0].len()
    }
    fn real(&self, a: usize, b: usize) -> (usize, usize) {
        let len = self.real_len() as isize;
        let ra = (a as isize + self.shift).clamp(0, len) as usize;
        let rb = (b as isize + self.shift).clamp(0, len) as usize;
        (ra, rb.max(ra))
    }
    fn chunk<'s>(&'s self, a: usize, b: usize, scratch: &'s mut [Vec<f32>]) -> Vec<&'s [f32]> {
        let (ra, rb) = (a as isize + self.shift, b as isize + self.shift);
        if ra >= 0 && rb <= self.real_len() as isize {
            return self.input.iter().map(|c| &c[ra as usize..rb as usize]).collect();
        }
        for (k, c) in self.input.iter().enumerate() {
            let s = &mut scratch[k];
            s.clear();
            s.resize(b - a, 0.0);
            let (ca, cb) = (ra.max(0), rb.min(c.len() as isize));
            if cb > ca {
                let off = (ca - ra) as usize;
                s[off..off + (cb - ca) as usize].copy_from_slice(&c[ca as usize..cb as usize]);
            }
        }
        scratch.iter().map(|v| &v[..]).collect()
    }
    fn silent(&self, a: usize, b: usize) -> bool {
        let (ra, rb) = self.real(a, b);
        let mut e = 0.0f64;
        for c in self.input {
            for &x in &c[ra..rb] {
                e += (x as f64) * (x as f64);
            }
        }
        e < 1e-12
    }
    fn next_sound(&self, from: usize) -> Option<usize> {
        let (start, _) = self.real(from, from);
        (start..self.real_len())
            .find(|&i| self.input.iter().any(|c| c[i].abs() > 1e-7))
            .map(|i| ((i as isize - self.shift).max(from as isize)) as usize)
    }
}

const CHUNK_OUT_SECONDS: f64 = 0.5;
const CURVE_LEAD: usize = 2;
const START_FADE_SECONDS: f64 = 0.001;

pub fn stretch_planar(input: &[&[f32]], sample_rate: f64, settings: &StretchSettings, cancel: &AtomicBool) -> Result<Vec<Vec<f32>>, StretchError> {
    let ch = input.len();
    if ch == 0 || ch > MAX_CHANNELS {
        return Err(StretchError::Failed(format!("cannot time-stretch audio with {ch} channels (1..{MAX_CHANNELS})")));
    }
    let n_in = input[0].len();
    if input.iter().any(|c| c.len() != n_in) {
        return Err(StretchError::Failed("time-stretch input channels differ in length".into()));
    }
    let ratio = settings.time_ratio;
    if !ratio.is_finite() || !(MIN_RATIO..=MAX_RATIO).contains(&ratio) {
        return Err(StretchError::Failed(format!("time ratio {ratio} is outside {MIN_RATIO}..{MAX_RATIO}")));
    }
    let semis = settings.semitones;
    if !semis.is_finite() || semis.abs() > MAX_SEMITONES {
        return Err(StretchError::Failed(format!("pitch shift {semis} st is outside ±{MAX_SEMITONES}")));
    }
    let n_out = output_frames(n_in, ratio);
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(ch);
    for _ in 0..ch {
        let mut v: Vec<f32> = Vec::new();
        v.try_reserve_exact(n_out).map_err(|_| StretchError::Failed("not enough memory for the stretched audio".into()))?;
        v.resize(n_out, 0.0);
        out.push(v);
    }
    if n_out == 0 || n_in == 0 {
        return Ok(out);
    }

    let (block, interval) = config_for(sample_rate, ratio, n_in);
    let mut st = Stretcher::new(ch, block, interval)?;
    debug_assert_eq!(st.channels, ch);
    st.set_pitch(semis, settings.keep_formants)?;
    let lat_in = st.input_latency();
    let lat_out = st.output_latency();

    let (len_in, len_out) = if n_out < 2 * lat_out + interval {
        let lo = 2 * lat_out + interval;
        ((((lo as f64) / ratio).ceil() as usize).max(n_in), lo)
    } else {
        (n_in, n_out)
    };
    let mut buf: Vec<Vec<f32>> = if len_out == n_out {
        out
    } else {
        (0..ch).map(|_| vec![0.0f32; len_out]).collect()
    };
    let rate = len_in as f64 / len_out as f64;

    let virt = Virtual { input, shift: lat_in as isize };
    {
        let mut scratch: Vec<Vec<f32>> = vec![Vec::new(); ch];
        let pre: Vec<&[f32]> = if n_in >= lat_in {
            input.iter().map(|c| &c[..lat_in]).collect()
        } else {
            for (k, c) in input.iter().enumerate() {
                scratch[k] = c.to_vec();
                scratch[k].resize(lat_in, 0.0);
            }
            scratch.iter().map(|v| &v[..]).collect()
        };
        st.seek(&pre, rate)?;
    }

    let chunk_out = ((CHUNK_OUT_SECONDS * sample_rate.max(1000.0)) as usize).max(4 * interval);
    let map_in = |o: usize| -> usize {
        if o >= len_out {
            len_in
        } else {
            ((o as f64) * len_in as f64 / len_out as f64).round() as usize
        }
    };
    let mut scratch: Vec<Vec<f32>> = vec![Vec::new(); ch];
    let (mut o0, mut i0) = (0usize, 0usize);
    while o0 < len_out {
        if cancel.load(Ordering::Relaxed) {
            return Err(StretchError::Cancelled);
        }
        let mut o1 = (o0 + chunk_out).min(len_out);
        let mut i1 = map_in(o1);
        if o1 < len_out && virt.silent(i0, i1) {
            match virt.next_sound(i1) {
                Some(j) => {
                    let want = ((j + 1) as f64 * len_out as f64 / len_in as f64).ceil() as usize;
                    o1 = want.clamp(o1, len_out);
                }
                None => o1 = len_out,
            }
            i1 = map_in(o1);
        }
        let inp = virt.chunk(i0, i1, &mut scratch);
        let mut outs: Vec<&mut [f32]> = buf.iter_mut().map(|c| &mut c[o0..o1]).collect();
        st.process(&inp, &mut outs)?;
        o0 = o1;
        i0 = i1;
    }
    debug_assert_eq!(i0, len_in);

    for c in buf.iter_mut() {
        c.copy_within(lat_out.., 0);
    }
    {
        let mut tails: Vec<&mut [f32]> = buf.iter_mut().map(|c| &mut c[len_out - lat_out..]).collect();
        for t in tails.iter_mut() {
            t.fill(0.0);
        }
        st.flush(&mut tails)?;
    }

    let fade = ((START_FADE_SECONDS * sample_rate) as usize).clamp(1, len_out);
    for c in buf.iter_mut() {
        for (i, x) in c.iter_mut().take(fade).enumerate() {
            *x *= (0.5 - 0.5 * (std::f64::consts::PI * i as f64 / fade as f64).cos()) as f32;
        }
        for x in c.iter_mut() {
            if !x.is_finite() {
                *x = 0.0;
            }
        }
    }
    if buf[0].len() != n_out {
        for c in buf.iter_mut() {
            c.truncate(n_out);
            c.shrink_to_fit();
        }
    }
    Ok(buf)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Profile {
    Complex,
    Tones,
}

pub fn config_tones(sample_rate: f64, ratio: f64) -> (usize, usize) {
    let sr = if sample_rate.is_finite() && sample_rate >= 1000.0 { sample_rate } else { 48000.0 };
    let block = (0.06 * sr).round().max(64.0);
    let hop = (0.012 * sr).min(ratio * block * 0.5).max(block / 16.0).round();
    (block as usize, hop as usize)
}

pub fn map_out_to_in(knots: &[(f64, f64)], o: f64) -> f64 {
    let i = knots[1..knots.len() - 1].partition_point(|k| k.1 < o);
    let (a, b) = (knots[i], knots[i + 1]);
    a.0 + (o - a.1) * (b.0 - a.0) / (b.1 - a.1)
}

pub fn map_in_to_out(knots: &[(f64, f64)], x: f64) -> f64 {
    let i = knots[1..knots.len() - 1].partition_point(|k| k.0 < x);
    let (a, b) = (knots[i], knots[i + 1]);
    a.1 + (x - a.0) * (b.1 - a.1) / (b.0 - a.0)
}

pub fn valid_knots(knots: &[(f64, f64)]) -> bool {
    knots.len() >= 2
        && knots.iter().all(|(a, b)| a.is_finite() && b.is_finite())
        && knots.windows(2).all(|w| w[1].0 > w[0].0 && w[1].1 > w[0].1)
}

#[allow(clippy::too_many_arguments)]
pub fn stretch_mapped(
    input: &[&[f32]],
    sample_rate: f64,
    knots: &[(f64, f64)],
    n_out: usize,
    semitones: f64,
    keep_formants: bool,
    profile: Profile,
    cancel: &AtomicBool,
) -> Result<Vec<Vec<f32>>, StretchError> {
    let ch = input.len();
    if ch == 0 || ch > MAX_CHANNELS {
        return Err(StretchError::Failed(format!("cannot time-stretch audio with {ch} channels (1..{MAX_CHANNELS})")));
    }
    let n_in = input[0].len();
    if input.iter().any(|c| c.len() != n_in) {
        return Err(StretchError::Failed("time-stretch input channels differ in length".into()));
    }
    if !valid_knots(knots) {
        return Err(StretchError::Failed("the warp map is not strictly increasing".into()));
    }
    if !semitones.is_finite() || semitones.abs() > MAX_SEMITONES {
        return Err(StretchError::Failed(format!("pitch shift {semitones} st is outside ±{MAX_SEMITONES}")));
    }
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(ch);
    for _ in 0..ch {
        let mut v: Vec<f32> = Vec::new();
        v.try_reserve_exact(n_out).map_err(|_| StretchError::Failed("not enough memory for the stretched audio".into()))?;
        v.resize(n_out, 0.0);
        out.push(v);
    }
    if n_out == 0 || n_in == 0 {
        return Ok(out);
    }
    let min_ratio = knots.windows(2).map(|w| (w[1].1 - w[0].1) / (w[1].0 - w[0].0)).fold(f64::INFINITY, f64::min).clamp(MIN_RATIO, MAX_RATIO);
    let (block, interval) = match profile {
        Profile::Complex => config_for(sample_rate, min_ratio, n_in),
        Profile::Tones => config_tones(sample_rate, min_ratio),
    };
    mapped_with(input, sample_rate, knots, out, n_out, semitones, keep_formants, (block, interval), None, cancel)
}

pub type PitchCurve<'a> = &'a (dyn Fn(usize) -> f64 + Sync);

#[allow(clippy::too_many_arguments)]
pub fn stretch_mapped_curve(
    input: &[&[f32]],
    sample_rate: f64,
    knots: &[(f64, f64)],
    n_out: usize,
    curve: PitchCurve<'_>,
    keep_formants: bool,
    profile: Profile,
    cancel: &AtomicBool,
) -> Result<Vec<Vec<f32>>, StretchError> {
    let ch = input.len();
    if ch == 0 || ch > MAX_CHANNELS {
        return Err(StretchError::Failed(format!("cannot time-stretch audio with {ch} channels (1..{MAX_CHANNELS})")));
    }
    let n_in = input[0].len();
    if input.iter().any(|c| c.len() != n_in) {
        return Err(StretchError::Failed("time-stretch input channels differ in length".into()));
    }
    if !valid_knots(knots) {
        return Err(StretchError::Failed("the warp map is not strictly increasing".into()));
    }
    let out: Vec<Vec<f32>> = (0..ch).map(|_| vec![0.0f32; n_out]).collect();
    if n_out == 0 || n_in == 0 {
        return Ok(out);
    }
    let min_ratio = knots.windows(2).map(|w| (w[1].1 - w[0].1) / (w[1].0 - w[0].0)).fold(f64::INFINITY, f64::min).clamp(MIN_RATIO, MAX_RATIO);
    let (block, interval) = match profile {
        Profile::Complex => config_for(sample_rate, min_ratio, n_in),
        Profile::Tones => config_tones(sample_rate, min_ratio),
    };
    let first = curve(0);
    let clamp = |v: f64| if v.is_finite() { v.clamp(-MAX_SEMITONES, MAX_SEMITONES) } else { 0.0 };
    let curve_c = |o: usize| clamp(curve(o));
    mapped_with(input, sample_rate, knots, out, n_out, clamp(first), keep_formants, (block, interval), Some(&curve_c), cancel)
}

#[allow(clippy::too_many_arguments)]
fn mapped_with(
    input: &[&[f32]],
    sample_rate: f64,
    knots: &[(f64, f64)],
    out: Vec<Vec<f32>>,
    n_out: usize,
    semitones: f64,
    keep_formants: bool,
    (block, interval): (usize, usize),
    curve: Option<&(dyn Fn(usize) -> f64 + Sync)>,
    cancel: &AtomicBool,
) -> Result<Vec<Vec<f32>>, StretchError> {
    let ch = input.len();
    let mut st = Stretcher::new(ch, block, interval)?;
    if curve.is_some() {
        st.set_pitch_curved(semitones, keep_formants)?;
    } else {
        st.set_pitch(semitones, keep_formants)?;
    }
    let lat_in = st.input_latency();
    let lat_out = st.output_latency();
    let len_out = n_out.max(2 * lat_out + interval);
    let mut buf: Vec<Vec<f32>> = if len_out == n_out { out } else { (0..ch).map(|_| vec![0.0f32; len_out]).collect() };

    let s0 = map_out_to_in(knots, 0.0).round();
    let in_end = map_out_to_in(knots, len_out as f64).round();
    if !s0.is_finite() || !in_end.is_finite() || s0.abs() > 1e15 || in_end.abs() > 1e15 {
        return Err(StretchError::Failed("the warp map is out of range".into()));
    }
    let s0 = s0 as isize;
    let len_in = (in_end as isize - s0).max(0) as usize;
    let map_in = |o: usize| -> usize {
        if o >= len_out {
            len_in
        } else {
            (map_out_to_in(knots, o as f64).round() as isize - s0).clamp(0, len_in as isize) as usize
        }
    };
    let map_out = |v: usize| -> usize {
        let o = map_in_to_out(knots, (v as isize + s0) as f64).ceil();
        if o.is_finite() {
            o.clamp(0.0, len_out as f64) as usize
        } else {
            len_out
        }
    };
    let mut cuts: Vec<usize> = knots.iter().map(|k| k.1.round()).filter(|o| *o > 0.0 && *o < len_out as f64).map(|o| o as usize).collect();
    cuts.dedup();

    {
        let pre_virt = Virtual { input, shift: s0 };
        let mut scratch: Vec<Vec<f32>> = vec![Vec::new(); ch];
        let pre = pre_virt.chunk(0, lat_in, &mut scratch);
        let rate0 = (knots[1].0 - knots[0].0) / (knots[1].1 - knots[0].1);
        st.seek(&pre, rate0)?;
    }
    let virt = Virtual { input, shift: s0 + lat_in as isize };

    let chunk_out = ((CHUNK_OUT_SECONDS * sample_rate.max(1000.0)) as usize).max(4 * interval);
    let mut scratch: Vec<Vec<f32>> = vec![Vec::new(); ch];
    let (mut o0, mut i0) = (0usize, 0usize);
    let mut next_cut = 0usize;
    while o0 < len_out {
        if cancel.load(Ordering::Relaxed) {
            return Err(StretchError::Cancelled);
        }
        while next_cut < cuts.len() && cuts[next_cut] <= o0 {
            next_cut += 1;
        }
        let limit = cuts.get(next_cut).copied().unwrap_or(len_out);
        let step = if curve.is_some() { interval } else { chunk_out };
        let mut o1 = (o0 + step).min(limit).min(len_out);
        if let Some(c) = curve {
            st.set_pitch_curved(c((o0 + CURVE_LEAD * interval).saturating_sub(lat_out)), keep_formants)?;
        }
        let mut i1 = map_in(o1).max(i0);
        if o1 < len_out && virt.silent(i0, i1) {
            o1 = match virt.next_sound(i1) {
                Some(j) => map_out(j + 1).clamp(o1, len_out),
                None => len_out,
            };
            i1 = map_in(o1).max(i0);
        }
        let inp = virt.chunk(i0, i1, &mut scratch);
        let mut outs: Vec<&mut [f32]> = buf.iter_mut().map(|c| &mut c[o0..o1]).collect();
        st.process(&inp, &mut outs)?;
        o0 = o1;
        i0 = i1;
    }

    for c in buf.iter_mut() {
        c.copy_within(lat_out.., 0);
    }
    {
        let mut tails: Vec<&mut [f32]> = buf.iter_mut().map(|c| &mut c[len_out - lat_out..]).collect();
        for t in tails.iter_mut() {
            t.fill(0.0);
        }
        st.flush(&mut tails)?;
    }
    let fade = ((START_FADE_SECONDS * sample_rate) as usize).clamp(1, len_out);
    for c in buf.iter_mut() {
        for (i, x) in c.iter_mut().take(fade).enumerate() {
            *x *= (0.5 - 0.5 * (std::f64::consts::PI * i as f64 / fade as f64).cos()) as f32;
        }
        for x in c.iter_mut() {
            if !x.is_finite() {
                *x = 0.0;
            }
        }
    }
    if buf[0].len() != n_out {
        for c in buf.iter_mut() {
            c.truncate(n_out);
            c.shrink_to_fit();
        }
    }
    Ok(buf)
}

#[cfg(test)]
mod tests;
