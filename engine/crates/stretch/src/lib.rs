//! krypt-studio-stretch — offline time-stretch and pitch-shift of whole
//! buffers with **Signalsmith Stretch** (MIT, © Geraint Luff / Signalsmith
//! Audio Ltd; vendored header-only C++ under `vendor/` with its LICENSE
//! files, compiled by build.rs through a 12-function C shim).
//!
//! Vendored upstream versions: signalsmith-stretch 1.3.1
//! (https://github.com/Signalsmith-Audio/signalsmith-stretch) and its
//! dependency Signalsmith Linear `fft.h` + `stft.h`
//! (https://github.com/Signalsmith-Audio/linear), as pinned by the
//! `signalsmith-stretch` crate 0.1.3 (git c4d0cbd). Rubber Band (GPL) is
//! never used.
//!
//! NOT real-time code: `stretch_planar` allocates and takes ~ms per second
//! of audio. The engine runs it on worker threads and plays the result as a
//! plain buffer.
//!
//! Output contract (`stretch_planar`):
//! - exactly `output_frames(input_frames, ratio)` frames per channel;
//! - time-aligned with the input: an onset at input frame `t` lands at
//!   output frame `t × ratio` (the stretcher's input/output latency is
//!   compensated as in upstream's `exact()`), so stretched clips stay on the
//!   grid and start without pre-roll silence or clicks (the first 1 ms is
//!   a raised-cosine fade-in from 0);
//! - deterministic: fixed-seed RNG (phase randomisation above 2× stretch),
//!   so the same input + settings always produce the same samples.

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

/// Most channels a buffer may have (the shim's pointer arrays live on the stack).
pub const MAX_CHANNELS: usize = 8;
/// Accepted time ratios (output duration ÷ input duration).
pub const MIN_RATIO: f64 = 0.0625;
pub const MAX_RATIO: f64 = 16.0;
/// Accepted pitch shift range in semitones.
pub const MAX_SEMITONES: f64 = 48.0;
/// RNG seed for the stretcher's phase randomisation (determinism).
const SEED: c_long = 0x4b53_5452; // "KSTR"

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StretchSettings {
    /// Output duration ÷ input duration (2.0 = twice as long, half speed).
    pub time_ratio: f64,
    /// Pitch shift in semitones (fractional allowed).
    pub semitones: f64,
    /// Formant compensation while pitch-shifting ("keep formants").
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
    /// The cancel flag was raised; no output.
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

/// Output length for `input_frames` at `ratio` (what `stretch_planar` returns).
pub fn output_frames(input_frames: usize, ratio: f64) -> usize {
    (input_frames as f64 * ratio).round().max(0.0) as usize
}

/// Signalsmith configuration for a job: (block, interval) in samples.
///
/// Block = 120 ms and hop = 30 ms is upstream's `presetDefault` (its sweet
/// spot is 0.75×–1.5×, and pitch-only jobs). For strong speed-ups the
/// output hop shrinks to `ratio × block / 2`, so consecutive analysis
/// windows still overlap in the input (no input audio is skipped between
/// windows; at the default hop that happens below 0.5×). The hop never
/// drops below block/16. Upstream's `presetCheaper` (100 ms / 40 ms) is
/// used for inputs longer than 20 minutes to bound worst-case compute.
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
        // SAFETY: `h` came from kss_create and is destroyed exactly once.
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
        // SAFETY: plain C call; null is handled.
        let h = unsafe { kss_create(to_int(channels)?, to_int(block)?, to_int(interval)?, 0, SEED) };
        if h.is_null() {
            return Err(StretchError::Failed("could not create the time-stretcher (out of memory?)".into()));
        }
        Ok(Self { h, channels })
    }
    fn input_latency(&self) -> usize {
        // SAFETY: valid handle.
        unsafe { kss_input_latency(self.h) }.max(0) as usize
    }
    fn output_latency(&self) -> usize {
        // SAFETY: valid handle.
        unsafe { kss_output_latency(self.h) }.max(0) as usize
    }
    #[allow(dead_code)]
    fn block(&self) -> usize {
        // SAFETY: valid handle.
        unsafe { kss_block_samples(self.h) }.max(0) as usize
    }
    #[allow(dead_code)]
    fn interval(&self) -> usize {
        // SAFETY: valid handle.
        unsafe { kss_interval_samples(self.h) }.max(0) as usize
    }
    fn set_pitch(&mut self, semitones: f64, keep_formants: bool) -> Result<(), StretchError> {
        // SAFETY: valid handle.
        check(unsafe { kss_set_transpose_semitones(self.h, semitones as f32, 0.0) }, "setTransposeSemitones")?;
        let compensate = keep_formants && semitones != 0.0;
        // Formant base 0 = let the stretcher estimate the fundamental.
        check(unsafe { kss_set_formant(self.h, 1.0, compensate as c_int, 0.0) }, "setFormantFactor")
    }
    /// Pitch for a time-varying curve: formant compensation stays on (toggling
    /// it as the curve crosses 0 would click).
    fn set_pitch_curved(&mut self, semitones: f64, keep_formants: bool) -> Result<(), StretchError> {
        // SAFETY: valid handle.
        check(unsafe { kss_set_transpose_semitones(self.h, semitones as f32, 0.0) }, "setTransposeSemitones")?;
        check(unsafe { kss_set_formant(self.h, 1.0, keep_formants as c_int, 0.0) }, "setFormantFactor")
    }
    fn seek(&mut self, input: &[&[f32]], rate: f64) -> Result<(), StretchError> {
        let ptrs = in_ptrs(input);
        let n = input.first().map_or(0, |c| c.len());
        // SAFETY: `channels` pointers, each valid for `n` reads.
        check(unsafe { kss_seek(self.h, ptrs.as_ptr(), to_int(n)?, rate) }, "seek")
    }
    fn process(&mut self, input: &[&[f32]], output: &mut [&mut [f32]]) -> Result<(), StretchError> {
        let ip = in_ptrs(input);
        let op = out_ptrs(output);
        let ni = input.first().map_or(0, |c| c.len());
        let no = output.first().map_or(0, |c| c.len());
        // SAFETY: `channels` input pointers valid for `ni` reads, output pointers valid for `no` writes.
        check(unsafe { kss_process(self.h, ip.as_ptr(), to_int(ni)?, op.as_ptr(), to_int(no)?) }, "process")
    }
    fn flush(&mut self, output: &mut [&mut [f32]]) -> Result<(), StretchError> {
        let op = out_ptrs(output);
        let no = output.first().map_or(0, |c| c.len());
        // SAFETY: `channels` output pointers valid for `no` writes.
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

/// The input as the stretcher's main pass sees it: virtual frame `v` is real
/// frame `v + shift` (stretch_planar: shift = the input latency, the first
/// `lat` frames went in through `seek`), zero outside the real input.
struct Virtual<'a> {
    input: &'a [&'a [f32]],
    shift: isize,
}

impl Virtual<'_> {
    fn real_len(&self) -> usize {
        self.input[0].len()
    }
    /// Real range of virtual [a, b), clamped to the input.
    fn real(&self, a: usize, b: usize) -> (usize, usize) {
        let len = self.real_len() as isize;
        let ra = (a as isize + self.shift).clamp(0, len) as usize;
        let rb = (b as isize + self.shift).clamp(0, len) as usize;
        (ra, rb.max(ra))
    }
    /// Frames [a, b) of the virtual input: borrowed when fully inside the
    /// real input, else copied (zero-padded) into `scratch`.
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
    /// True if frames [a, b) are digital silence for the stretcher (it then
    /// takes a shortcut that is only safe for ONE silent call in a row).
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
    /// First virtual frame >= `from` that is not (near) zero in any channel.
    fn next_sound(&self, from: usize) -> Option<usize> {
        let (start, _) = self.real(from, from);
        (start..self.real_len())
            .find(|&i| self.input.iter().any(|c| c[i].abs() > 1e-7))
            .map(|i| ((i as isize - self.shift).max(from as isize)) as usize)
    }
}

/// Output frames handed to one `process` call (cancellation granularity).
const CHUNK_OUT_SECONDS: f64 = 0.5;
/// `stretch_mapped_curve`: the curve is sampled this many hops ahead of the
/// chunk start (latency-compensated); calibrated by `curve_step_lands_on_time`.
const CURVE_LEAD: usize = 2;
/// Raised-cosine fade-in at the very start of the output (de-click).
const START_FADE_SECONDS: f64 = 0.001;

/// Time-stretch and/or pitch-shift planar audio. See the crate docs for the
/// output contract. `cancel` is polled between ~0.5 s chunks.
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

    // upstream exact() needs >= 2 output latencies of output: pad short
    // material with trailing silence and trim afterwards.
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

    // 1. Pre-roll: the first `lat_in` input frames, so processing time 0 is input frame 0.
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

    // 2. Main pass in chunks with a constant in/out proportion. A chunk of
    //    pure digital silence is stretched to reach the next sound, because
    //    two silent process() calls in a row make Signalsmith skip ahead
    //    without updating its read offset (a glitch on the next onset).
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

    // 3. Latency compensation: drop the `lat_out` frames of pre-roll
    //    (output from before input frame 0), flush the final `lat_out`
    //    frames into the tail, and fade in over 1 ms so the first sample is
    //    0. Upstream exact() instead folds the pre-roll back (subtracting
    //    its mirror image); measured here that overshoots sustained material
    //    by up to +4 dB at speed-ups and leaves a step on full-scale starts,
    //    while dropping it keeps the attack within ~1 dB and never clicks.
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

// ── Piecewise time maps (warp markers, Wave 12.2) ───────────────────────

/// Signalsmith tuning for a warp mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Profile {
    /// Full mixes: `config_for` (120 ms blocks, 30 ms hop), no tonality limit.
    Complex,
    /// Monophonic pitched material (vocals, bass, leads): `config_tones`.
    Tones,
}

/// "Tones" (block, hop) in samples: 60 ms blocks, 12 ms hop (5× overlap;
/// Complex is 120 / 30 ms). A shorter window follows pitch movement (glides,
/// vibrato, sung notes) instead of smearing it, and one voice has no dense
/// low partials that would need the longer window's resolution. Measured
/// (tests `tones_profile_*`): on a ±1 st vibrato voice and a fast sine
/// glide the 10 ms envelope wobble drops 1.5–4× against Complex and the
/// level holds within ~7 %. No tonality limit: pitched mono material is
/// harmonic up high, and a limit detunes those partials (it measured no
/// benefit here). The hop shrinks for strong speed-ups like `config_for`.
pub fn config_tones(sample_rate: f64, ratio: f64) -> (usize, usize) {
    let sr = if sample_rate.is_finite() && sample_rate >= 1000.0 { sample_rate } else { 48000.0 };
    let block = (0.06 * sr).round().max(64.0);
    let hop = (0.012 * sr).min(ratio * block * 0.5).max(block / 16.0).round();
    (block as usize, hop as usize)
}

/// Output frame → input frame through a piecewise-linear map given as
/// knots `(input frame, output frame)` (both strictly increasing, >= 2);
/// outside the knots the first / last segment's slope continues (the
/// segment search matches shared/schema/warp.ts `beatToSec`).
pub fn map_out_to_in(knots: &[(f64, f64)], o: f64) -> f64 {
    let i = knots[1..knots.len() - 1].partition_point(|k| k.1 < o);
    let (a, b) = (knots[i], knots[i + 1]);
    a.0 + (o - a.1) * (b.0 - a.0) / (b.1 - a.1)
}

/// Input frame → output frame (inverse of `map_out_to_in`).
pub fn map_in_to_out(knots: &[(f64, f64)], x: f64) -> f64 {
    let i = knots[1..knots.len() - 1].partition_point(|k| k.0 < x);
    let (a, b) = (knots[i], knots[i + 1]);
    a.1 + (x - a.0) * (b.1 - a.1) / (b.0 - a.0)
}

/// Check a knot list: >= 2 knots, finite, strictly increasing in both.
pub fn valid_knots(knots: &[(f64, f64)]) -> bool {
    knots.len() >= 2
        && knots.iter().all(|(a, b)| a.is_finite() && b.is_finite())
        && knots.windows(2).all(|w| w[1].0 > w[0].0 && w[1].1 > w[0].1)
}

/// Time-stretch (and pitch-shift) planar audio along a piecewise-linear time
/// map with ONE Signalsmith instance, so segments join without seams: the
/// in/out proportion changes between `process` calls, which are split at
/// every knot. Output frame `o` (0..`n_out`) carries the input around
/// `map_out_to_in(knots, o)`; input before frame 0 or past the end is
/// silence. Same latency compensation, start fade, determinism and
/// silence handling as `stretch_planar`. Segment slopes are not limited to
/// MIN_RATIO..MAX_RATIO (block / hop are configured for the steepest
/// speed-up, clamped to that range).
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
    // Steepest speed-up among the segments.
    let min_ratio = knots.windows(2).map(|w| (w[1].1 - w[0].1) / (w[1].0 - w[0].0)).fold(f64::INFINITY, f64::min).clamp(MIN_RATIO, MAX_RATIO);
    let (block, interval) = match profile {
        Profile::Complex => config_for(sample_rate, min_ratio, n_in),
        Profile::Tones => config_tones(sample_rate, min_ratio),
    };
    mapped_with(input, sample_rate, knots, out, n_out, semitones, keep_formants, (block, interval), None, cancel)
}

/// Pitch curve for [`stretch_mapped_curve`]: output frame → semitones.
pub type PitchCurve<'a> = &'a (dyn Fn(usize) -> f64 + Sync);

/// [`stretch_mapped`] with a pitch shift that follows `curve` (output frame →
/// semitones, within ±MAX_SEMITONES) instead of a constant: the transpose is
/// updated before every hop of output (~12 ms with `Profile::Tones`), so
/// glides, vibrato and per-frame pitch correction keep the formants. The
/// curve is sampled at the output frame each hop's synthesis lands on
/// (latency compensated), so a step at frame `f` is heard at `f` give or
/// take one hop. Same output contract as `stretch_mapped`.
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

/// `stretch_mapped` with an explicit (block, hop) configuration.
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
    // exact() needs >= 2 output latencies of output: render longer, trim later.
    let len_out = n_out.max(2 * lat_out + interval);
    let mut buf: Vec<Vec<f32>> = if len_out == n_out { out } else { (0..ch).map(|_| vec![0.0f32; len_out]).collect() };

    // Virtual input: frame v = real frame s0 + lat_in + v, so output 0 ↔ input map_out_to_in(0).
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
    // Knots as output frames: chunk boundaries (each process call has one slope).
    let mut cuts: Vec<usize> = knots.iter().map(|k| k.1.round()).filter(|o| *o > 0.0 && *o < len_out as f64).map(|o| o as usize).collect();
    cuts.dedup();

    // 1. Pre-roll: real [s0, s0 + lat_in), zero-padded.
    {
        let pre_virt = Virtual { input, shift: s0 };
        let mut scratch: Vec<Vec<f32>> = vec![Vec::new(); ch];
        let pre = pre_virt.chunk(0, lat_in, &mut scratch);
        let rate0 = (knots[1].0 - knots[0].0) / (knots[1].1 - knots[0].1);
        st.seek(&pre, rate0)?;
    }
    let virt = Virtual { input, shift: s0 + lat_in as isize };

    // 2. Main pass (as stretch_planar); chunks also end at every knot.
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
            // This call's synthesis is heard about one output latency later (after the trim below).
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

    // 3. Latency compensation + start fade (as stretch_planar).
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
