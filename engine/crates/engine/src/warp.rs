use crate::model_ext::WarpMap;
use krypt_studio_dsp::blocks::sinc::{apply, SincTable, MAX_TAPS};
use krypt_studio_stretch::{map_in_to_out, map_out_to_in, stretch_mapped, stretch_planar, Profile, StretchError, StretchSettings, MAX_SEMITONES};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};

pub const MAX_WARP_MARKERS: usize = 2048;
pub const DEFAULT_BEATS_FADE_MS: f64 = 20.0;
pub const DEFAULT_GRAIN_MS: f64 = 80.0;
pub const DEFAULT_FLUX: f64 = 0.2;
const POS_SCALE: f64 = 1e9;
const BPM_SCALE: f64 = 1e6;
const MS_SCALE: f64 = 100.0;
const FLUX_SCALE: f64 = 1e4;
const MAX_POS: f64 = 1e7;
const MAX_SLICE_S: f64 = 0.25;
const FADE_IN_TRANSIENT_S: f64 = 0.0001;
const FADE_IN_GRID_S: f64 = 0.001;
const START_FADE_S: f64 = 0.001;
const GRAIN_OVERLAP: usize = 4;
const TEXTURE_SEED: u64 = 0x4b53_5458_5452_0001;
const TEXTURE_MIN_JITTER: f64 = 0.25;
const TEXTURE_GAIN: f32 = 0.816_496_6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Mode {
    Complex,
    Tones,
    Beats,
    Texture,
    Repitch,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "complex" => Mode::Complex,
            "tones" => Mode::Tones,
            "beats" => Mode::Beats,
            "texture" => Mode::Texture,
            "repitch" => Mode::Repitch,
            _ => return None,
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Mode::Complex => "complex",
            Mode::Tones => "tones",
            Mode::Beats => "beats",
            Mode::Texture => "texture",
            Mode::Repitch => "repitch",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Slice {
    Transients,
    Grid(u8),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WarpKey {
    pub mode: Mode,
    markers: Vec<(i64, i64)>,
    bpm_q: i64,
    slice: Slice,
    fade_q: i64,
    grain_q: i64,
    flux_q: i64,
}

impl WarpKey {
    pub fn marker_count(&self) -> usize {
        self.markers.len()
    }
    pub fn overrides_stretch(&self) -> bool {
        self.markers.len() >= 2
    }
    pub fn bpm(&self) -> f64 {
        self.bpm_q as f64 / BPM_SCALE
    }
    pub fn slice(&self) -> Slice {
        self.slice
    }
    pub fn beats_fade_ms(&self) -> f64 {
        self.fade_q as f64 / MS_SCALE
    }
    pub fn grain_ms(&self) -> f64 {
        self.grain_q as f64 / MS_SCALE
    }
    pub fn flux(&self) -> f64 {
        self.flux_q as f64 / FLUX_SCALE
    }
    pub fn markers(&self) -> Vec<(f64, f64)> {
        self.markers.iter().map(|&(s, b)| (s as f64 / POS_SCALE, b as f64 / POS_SCALE)).collect()
    }
    pub fn timing_hash(&self) -> u64 {
        if self.markers.is_empty() {
            return 0;
        }
        let mut h = DefaultHasher::new();
        self.markers.hash(&mut h);
        self.bpm_q.hash(&mut h);
        h.finish() | 1
    }
    pub fn knots(&self, ratio: f64, sr: f64) -> Vec<(f64, f64)> {
        let m = self.markers();
        let spb = 60.0 / self.bpm().max(1e-6);
        match m.len() {
            0 => vec![(0.0, 0.0), (sr, ratio * sr)],
            1 => {
                let (s, b) = m[0];
                vec![(s * sr, b * spb * sr), ((s + 1.0) * sr, (b * spb + ratio) * sr)]
            }
            _ => m.iter().map(|&(s, b)| (s * sr, b * spb * sr)).collect(),
        }
    }
    pub fn describe(&self) -> String {
        let mut s = format!("warp {}", self.mode.name());
        if !self.markers.is_empty() {
            s.push_str(&format!(", {} marker{} @ {:.2} bpm", self.markers.len(), if self.markers.len() == 1 { "" } else { "s" }, self.bpm()));
        }
        s
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub warp: Option<WarpKey>,
    pub ratio: f64,
    pub semitones: f64,
    pub warning: Option<String>,
}

fn q(v: f64, scale: f64) -> i64 {
    (v * scale).round() as i64
}

fn setting(v: Option<f64>, default: f64, lo: f64, hi: f64) -> f64 {
    v.filter(|x| x.is_finite()).unwrap_or(default).clamp(lo, hi)
}

pub fn resolve(map: Option<&WarpMap>, ratio: f64, semitones: f64, bpm: f64) -> Resolved {
    let Some(m) = map else {
        return Resolved { warp: None, ratio, semitones, warning: None };
    };
    let mut warning: Option<String> = None;
    let mode = Mode::parse(&m.mode).unwrap_or_else(|| {
        warning = Some(format!("unknown warp mode '{}'; using complex", m.mode));
        Mode::Complex
    });
    let mut markers: Vec<(i64, i64)> = Vec::new();
    if m.markers.len() > MAX_WARP_MARKERS {
        warning = Some(format!("{} warp markers is more than the {MAX_WARP_MARKERS} allowed; playing with the Stretch timing", m.markers.len()));
    } else if m.markers.iter().any(|k| !(k.sec.is_finite() && k.beat.is_finite() && (0.0..MAX_POS).contains(&k.sec) && (0.0..MAX_POS).contains(&k.beat))) {
        warning = Some("a warp marker has a negative or invalid position; playing with the Stretch timing".into());
    } else {
        markers = m.markers.iter().map(|k| (q(k.sec, POS_SCALE), q(k.beat, POS_SCALE))).collect();
        if !markers.windows(2).all(|w| w[1].0 > w[0].0 && w[1].1 > w[0].1) {
            markers.clear();
            warning = Some(
                "its warp markers are out of order (each marker needs a later source time AND a later beat than the one before); \
                 playing with the Stretch timing"
                    .into(),
            );
        }
    }
    let bpm = if bpm.is_finite() && bpm > 0.0 { bpm.clamp(10.0, 999.0) } else { 140.0 };
    let mut ratio = ratio;
    match markers.len() {
        0 => {}
        1 => {
            let (s, b) = (markers[0].0 as f64 / POS_SCALE, markers[0].1 as f64 / POS_SCALE);
            if (b * 60.0 / bpm - s * ratio).abs() < 1e-6 {
                markers.clear();
            }
        }
        _ => {
            ratio = 1.0;
            if markers.iter().all(|&(s, b)| ((b as f64 / POS_SCALE) * 60.0 / bpm - s as f64 / POS_SCALE).abs() < 1e-6) {
                markers.clear();
            }
        }
    }
    let slice = match m.beats_slice.as_deref() {
        None | Some("transients") => Slice::Transients,
        Some("1/16") => Slice::Grid(4),
        Some("1/8") => Slice::Grid(2),
        Some("1/4") => Slice::Grid(1),
        Some(other) => {
            warning = Some(format!("unknown beats slicing '{other}'; using transients"));
            Slice::Transients
        }
    };
    let beats = mode == Mode::Beats;
    let texture = mode == Mode::Texture;
    let slice = if beats { slice } else { Slice::Transients };
    let needs_bpm = !markers.is_empty() || matches!(slice, Slice::Grid(_));
    let warp = WarpKey {
        mode,
        markers,
        bpm_q: if needs_bpm { q(bpm, BPM_SCALE) } else { 0 },
        slice,
        fade_q: if beats { q(setting(m.beats_fade_ms, DEFAULT_BEATS_FADE_MS, 0.0, 200.0), MS_SCALE) } else { 0 },
        grain_q: if texture { q(setting(m.grain_ms, DEFAULT_GRAIN_MS, 10.0, 500.0), MS_SCALE) } else { 0 },
        flux_q: if texture { q(setting(m.flux, DEFAULT_FLUX, 0.0, 1.0), FLUX_SCALE) } else { 0 },
    };
    let semitones = if mode == Mode::Repitch { 0.0 } else { semitones };
    Resolved { warp: Some(warp), ratio, semitones, warning }
}

#[allow(clippy::too_many_arguments)]
pub fn render(
    input: &[&[f32]],
    sr: f64,
    ratio: f64,
    semitones: f64,
    keep_formants: bool,
    w: &WarpKey,
    max_seconds: f64,
    cancel: &AtomicBool,
) -> Result<Vec<Vec<f32>>, StretchError> {
    let ch = input.len();
    if ch == 0 || !(sr.is_finite() && sr > 0.0) {
        return Err(StretchError::Failed("cannot warp audio without channels or sample rate".into()));
    }
    let n_in = input[0].len();
    if !semitones.is_finite() || semitones.abs() > MAX_SEMITONES {
        return Err(StretchError::Failed(format!("pitch shift {semitones} st is outside ±{MAX_SEMITONES}")));
    }
    let knots = w.knots(ratio, sr);
    let end = map_in_to_out(&knots, n_in as f64).round();
    if !end.is_finite() || end > max_seconds * sr {
        return Err(StretchError::Failed(format!(
            "the warped result would be longer than {} minutes; check the warp markers",
            max_seconds / 60.0
        )));
    }
    let n_out = end.max(0.0) as usize;
    if n_out == 0 || n_in == 0 {
        return Ok(vec![Vec::new(); ch]);
    }
    let mut out = match w.mode {
        Mode::Complex => return stretch_mapped(input, sr, &knots, n_out, semitones, keep_formants, Profile::Complex, cancel),
        Mode::Tones => return stretch_mapped(input, sr, &knots, n_out, semitones, keep_formants, Profile::Tones, cancel),
        Mode::Beats => beats(input, sr, &knots, n_out, semitones, keep_formants, w, cancel)?,
        Mode::Texture => texture(input, sr, &knots, n_out, semitones, w, cancel)?,
        Mode::Repitch => repitch(input, &knots, n_out, cancel)?,
    };
    let fade = ((START_FADE_S * sr) as usize).clamp(1, n_out);
    for c in out.iter_mut() {
        for (i, x) in c.iter_mut().take(fade).enumerate() {
            *x *= (0.5 - 0.5 * (std::f64::consts::PI * i as f64 / fade as f64).cos()) as f32;
        }
        for x in c.iter_mut() {
            if !x.is_finite() {
                *x = 0.0;
            }
        }
    }
    Ok(out)
}

fn zeros(ch: usize, n: usize) -> Result<Vec<Vec<f32>>, StretchError> {
    let mut out = Vec::with_capacity(ch);
    for _ in 0..ch {
        let mut v: Vec<f32> = Vec::new();
        v.try_reserve_exact(n).map_err(|_| StretchError::Failed("not enough memory for the warped audio".into()))?;
        v.resize(n, 0.0);
        out.push(v);
    }
    Ok(out)
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), StretchError> {
    if cancel.load(Ordering::Relaxed) {
        Err(StretchError::Cancelled)
    } else {
        Ok(())
    }
}

pub fn transients(input: &[&[f32]], sr: f64) -> Vec<usize> {
    let n = input.first().map_or(0, |c| c.len());
    let mut out = vec![0usize];
    if n < 4 {
        return out;
    }
    let inv = 1.0 / input.len() as f32;
    let mono: Vec<f32> = (0..n).map(|i| input.iter().map(|c| c[i]).sum::<f32>() * inv).collect();
    let h = ((sr * 0.0025).round() as usize).max(16);
    let nf = n.div_ceil(h);
    let lv: Vec<f64> = (0..nf)
        .map(|f| {
            let (a, b) = ((f * h).max(1), ((f + 1) * h).min(n));
            let e: f64 = (a..b).map(|i| ((mono[i] - mono[i - 1]) as f64).powi(2)).sum();
            10.0 * (e + 1e-20).log10()
        })
        .collect();
    let lmax = lv.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let min_gap = (0.04 * sr) as usize;
    let back = ((0.001 * sr) as usize).max(1);
    for f in 1..nf {
        let prev = lv[f.saturating_sub(3)..f].iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        if lv[f] < lmax - 50.0 || (lv[f] - prev < 9.0 && lv[f] - lv[f - 1] < 30.0) {
            continue;
        }
        let start = f * h;
        let w_end = (start + 2 * h).min(n);
        let peak = mono[start..w_end].iter().fold(0f32, |m, v| m.max(v.abs()));
        let lo = start.saturating_sub(h);
        let mut i = (lo..w_end).find(|&i| mono[i].abs() >= 0.2 * peak).unwrap_or(start);
        let stop = i.saturating_sub(back);
        while i > stop && mono[i - 1] != 0.0 && (mono[i - 1] > 0.0) == (mono[i] > 0.0) {
            i -= 1;
        }
        if i >= out[out.len() - 1] + min_gap {
            out.push(i);
        }
    }
    out
}

fn slice_points(input: &[&[f32]], sr: f64, knots: &[(f64, f64)], w: &WarpKey) -> Vec<usize> {
    let n_in = input[0].len();
    let mut pts = match w.slice {
        Slice::Transients => {
            let t = transients(input, sr);
            let max_len = ((MAX_SLICE_S * sr) as usize).max(1);
            let mut pts = Vec::with_capacity(t.len());
            for (k, &a) in t.iter().enumerate() {
                let b = t.get(k + 1).copied().unwrap_or(n_in);
                let parts = (b - a).div_ceil(max_len).max(1);
                for j in 0..parts {
                    pts.push(a + (b - a) * j / parts);
                }
            }
            pts
        }
        Slice::Grid(div) => {
            let step = 60.0 / w.bpm().max(1e-6) / div.max(1) as f64 * sr;
            let (lo, hi) = (map_in_to_out(knots, 0.0), map_in_to_out(knots, n_in as f64));
            let mut pts = vec![0usize];
            let mut k = (lo / step).ceil();
            while k * step < hi {
                let x = map_out_to_in(knots, k * step).round();
                if x > 0.0 && x < n_in as f64 {
                    pts.push(x as usize);
                }
                k += 1.0;
            }
            pts
        }
    };
    pts.sort_unstable();
    pts.dedup();
    pts
}

#[allow(clippy::too_many_arguments)]
fn beats(
    input: &[&[f32]],
    sr: f64,
    knots: &[(f64, f64)],
    n_out: usize,
    semitones: f64,
    keep_formants: bool,
    w: &WarpKey,
    cancel: &AtomicBool,
) -> Result<Vec<Vec<f32>>, StretchError> {
    let n_in = input[0].len();
    let mut out = zeros(input.len(), n_out)?;
    let pts = slice_points(input, sr, knots, w);
    let fade_out = (w.beats_fade_ms() * 0.001 * sr).round() as usize;
    let fade_in = (if matches!(w.slice, Slice::Grid(_)) { FADE_IN_GRID_S } else { FADE_IN_TRANSIENT_S } * sr).round() as usize;
    let pitch = semitones != 0.0;
    let settings = StretchSettings { time_ratio: 1.0, semitones, keep_formants };
    for (k, &a) in pts.iter().enumerate() {
        check_cancel(cancel)?;
        let b = pts.get(k + 1).copied().unwrap_or(n_in);
        let oa = map_in_to_out(knots, a as f64).round() as i64;
        let ob = map_in_to_out(knots, b as f64).round() as i64;
        let len = ((b - a) as i64).min(ob - oa);
        if len <= 0 || oa >= n_out as i64 {
            continue;
        }
        let len = len as usize;
        let skip = (-oa).max(0) as usize;
        if skip >= len {
            continue;
        }
        let pitched;
        let piece: Vec<&[f32]> = if pitch {
            let src: Vec<&[f32]> = input.iter().map(|c| &c[a..a + len]).collect();
            pitched = stretch_planar(&src, sr, &settings, cancel)?;
            pitched.iter().map(|c| &c[..]).collect()
        } else {
            input.iter().map(|c| &c[a..a + len]).collect()
        };
        let fo = fade_out.min(len);
        let fi = fade_in.min(len / 2);
        for i in skip..len {
            let o = oa + i as i64;
            if o >= n_out as i64 {
                break;
            }
            let mut g = 1.0f64;
            if i < fi {
                g *= 0.5 - 0.5 * (std::f64::consts::PI * i as f64 / fi as f64).cos();
            }
            if fo > 0 && i >= len - fo {
                g *= 0.5 + 0.5 * (std::f64::consts::PI * (i + fo + 1 - len) as f64 / fo as f64).cos();
            }
            let g = g as f32;
            for (oc, pc) in out.iter_mut().zip(&piece) {
                oc[o as usize] += pc[i] * g;
            }
        }
    }
    Ok(out)
}

struct SplitMix(u64);

impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn bipolar(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 52) as f64 - 1.0
    }
}

fn texture(
    input: &[&[f32]],
    sr: f64,
    knots: &[(f64, f64)],
    n_out: usize,
    semitones: f64,
    w: &WarpKey,
    cancel: &AtomicBool,
) -> Result<Vec<Vec<f32>>, StretchError> {
    let n_in = input[0].len() as f64;
    let mut out = zeros(input.len(), n_out)?;
    let n = ((((w.grain_ms() * 0.001 * sr) / GRAIN_OVERLAP as f64).round() as usize).max(4)) * GRAIN_OVERLAP;
    let hop = n / GRAIN_OVERLAP;
    let half = (n / 2) as i64;
    let win: Vec<f32> = (0..n).map(|k| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * k as f64 / n as f64).cos()) as f32).collect();
    let step = 2f64.powf(semitones / 12.0);
    let jitter = (TEXTURE_MIN_JITTER + (1.0 - TEXTURE_MIN_JITTER) * w.flux()) * n as f64;
    let table = SincTable::new();
    let mut wts = [0f32; MAX_TAPS];
    let mut rng = SplitMix(TEXTURE_SEED);
    let pad = MAX_TAPS as f64 + n as f64 * step;
    let first = -(half / hop as i64) - 1;
    let last = (n_out as i64 + half) / hop as i64 + 1;
    for j in first..=last {
        if j % 256 == 0 {
            check_cancel(cancel)?;
        }
        let c = j * hop as i64;
        let u = rng.bipolar();
        let centre = map_out_to_in(knots, c as f64) + jitter * u;
        if centre + pad < 0.0 || centre - pad > n_in {
            continue;
        }
        let k0 = (-(c - half)).max(0) as usize;
        let k1 = ((n_out as i64 - (c - half)).max(0) as usize).min(n);
        for (k, wk) in win.iter().enumerate().take(k1).skip(k0) {
            let pos = centre + (k as f64 - half as f64) * step;
            let (f, taps) = table.weights(pos, step, &mut wts);
            let o = (c - half + k as i64) as usize;
            let g = wk * TEXTURE_GAIN;
            for (oc, ic) in out.iter_mut().zip(input) {
                oc[o] += apply(ic, f, &wts[..taps], None) * g;
            }
        }
    }
    Ok(out)
}

fn repitch(input: &[&[f32]], knots: &[(f64, f64)], n_out: usize, cancel: &AtomicBool) -> Result<Vec<Vec<f32>>, StretchError> {
    let mut out = zeros(input.len(), n_out)?;
    let table = SincTable::new();
    let mut wts = [0f32; MAX_TAPS];
    let nk = knots.len();
    let mut seg = knots[1..nk - 1].partition_point(|k| k.1 < 0.0);
    for o in 0..n_out {
        if o % 65536 == 0 {
            check_cancel(cancel)?;
        }
        let of = o as f64;
        while seg + 2 < nk && of > knots[seg + 1].1 {
            seg += 1;
        }
        let (a, b) = (knots[seg], knots[seg + 1]);
        let slope = (b.0 - a.0) / (b.1 - a.1);
        let pos = a.0 + (of - a.1) * slope;
        let (f, taps) = table.weights(pos, slope, &mut wts);
        for (oc, ic) in out.iter_mut().zip(input) {
            oc[o] = apply(ic, f, &wts[..taps], None);
        }
    }
    Ok(out)
}
