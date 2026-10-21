use crate::features::{parabolic, power_spectrogram};
use crate::protocol::{ChordQuality, ChordSpan};
use crate::{JobCtx, JobError};

const KK_MAJOR: [f32; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR: [f32; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

pub struct Chroma {
    pub fps: f32,
    pub frames: Vec<[f32; 12]>,
    pub treble: Vec<[f32; 12]>,
    pub bass: Vec<[f32; 12]>,
    pub low: Vec<[f32; 12]>,
    pub tonality: Vec<f32>,
    pub treble_share: f32,
    pub tuning: f32,
}

impl Chroma {
    pub fn mean_between(&self, t0: f32, t1: f32) -> [f32; 12] {
        let a = ((t0 * self.fps).floor().max(0.0) as usize).min(self.frames.len());
        let b = ((t1 * self.fps).ceil().max(0.0) as usize).min(self.frames.len()).max(a + 1).min(self.frames.len());
        let mut m = [0f32; 12];
        for f in &self.frames[a..b] {
            for k in 0..12 {
                m[k] += f[k];
            }
        }
        normalize(&mut m);
        m
    }
}

pub fn normalize(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 1e-12 {
        for x in v.iter_mut() {
            *x /= n;
        }
    }
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let (mut ab, mut aa, mut bb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        ab += x * y;
        aa += x * x;
        bb += y * y;
    }
    if aa <= 1e-12 || bb <= 1e-12 {
        0.0
    } else {
        ab / (aa.sqrt() * bb.sqrt())
    }
}

fn temporal_median(mag: &[f32], frames: usize, bins: usize, half: usize) -> Vec<f32> {
    let mut out = vec![0f32; frames * bins];
    let mut win = Vec::with_capacity(2 * half + 1);
    for k in 0..bins {
        for t in 0..frames {
            win.clear();
            let a = t.saturating_sub(half);
            let b = (t + half + 1).min(frames);
            for s in a..b {
                win.push(mag[s * bins + k]);
            }
            let m = win.len() / 2;
            win.select_nth_unstable_by(m, |p, q| p.total_cmp(q));
            out[t * bins + k] = win[m];
        }
    }
    out
}

#[derive(Clone, Copy, Debug)]
pub struct Peak {
    pub f: f32,
    pub a: f32,
    pub main: bool,
}

fn merge_overlap(peaks: &mut Vec<Peak>, first_main: usize) {
    let mut drop = vec![false; peaks.len()];
    for m in first_main..peaks.len() {
        let pm = peaks[m];
        if pm.f >= LOW_SPLIT {
            continue;
        }
        let same: Vec<usize> = (0..first_main).filter(|&l| !drop[l] && (1200.0 * (peaks[l].f / pm.f).log2()).abs() < SAME_NOTE_CENTS).collect();
        if same.is_empty() {
            continue;
        }
        let lmax = same.iter().map(|&l| peaks[l].a).fold(0f32, f32::max);
        if pm.a >= lmax {
            for l in same {
                drop[l] = true;
            }
        } else {
            drop[m] = true;
        }
    }
    let mut i = 0;
    peaks.retain(|_| {
        let keep = !drop[i];
        i += 1;
        keep
    });
}

struct Band {
    bin_hz: f32,
    k_lo: usize,
    k_hi: usize,
    amp_scale: f32,
    abs_floor: f32,
    main: bool,
}

fn frame_peaks(row: &[f32], band: &Band, pre: &mut Vec<f64>, out: &mut Vec<Peak>) {
    let Band { bin_hz, k_lo, k_hi, amp_scale, abs_floor, .. } = *band;
    let n = row.len();
    pre.clear();
    pre.push(0.0);
    for &v in row {
        let last = *pre.last().unwrap();
        pre.push(last + ((v as f64) + 1e-12).ln());
    }
    let ratio = 10f32.powf(PEAK_OVER_FLOOR / 20.0);
    for k in k_lo.max(1)..=k_hi.min(n - 2) {
        let v = row[k];
        if !(v > row[k - 1] && v >= row[k + 1] && v > abs_floor) {
            continue;
        }
        let w = ((k as f32 * 0.12).round() as usize).max(3);
        let a = k.saturating_sub(w);
        let b = (k + w + 1).min(n);
        let gm = (((pre[b] - pre[a]) / (b - a) as f64).exp()) as f32;
        if v < gm * ratio {
            continue;
        }
        let off = parabolic((row[k - 1] + 1e-12).ln(), (v + 1e-12).ln(), (row[k + 1] + 1e-12).ln());
        out.push(Peak { f: (k as f32 + off) * bin_hz, a: v * amp_scale, main: band.main });
    }
}

const MAX_HARMONIC: usize = 16;

#[derive(Clone, Copy, Debug)]
pub struct Note {
    pub f: f32,
    pub a: f32,
    pub energy: f32,
    partials: [f32; MAX_HARMONIC + 1],
}

impl Note {
    fn new(p: &Peak) -> Self {
        let mut partials = [0f32; MAX_HARMONIC + 1];
        partials[1] = p.a;
        Note { f: p.f, a: p.a, energy: p.a * p.a, partials }
    }

    fn explains(&self, h: usize, a: f32) -> bool {
        if h.is_multiple_of(2) && h >= 4 && !(2..h).step_by(2).any(|j| self.partials[j] > 0.0) {
            return false;
        }
        let allowed = [h - 1, h.saturating_sub(2)]
            .iter()
            .filter(|&&j| j >= 1 && self.partials[j] > 0.0)
            .map(|&j| 1.5 * self.partials[j] * j as f32 / h as f32)
            .fold(0f32, f32::max);
        a <= allowed
    }
}

pub fn sieve(peaks: &mut [Peak]) -> Vec<Note> {
    peaks.sort_by(|a, b| a.f.total_cmp(&b.f));
    let mut notes: Vec<Note> = Vec::new();
    for p in peaks.iter() {
        let mut explained = false;
        for nt in notes.iter_mut() {
            let r = p.f / nt.f;
            let h = r.round();
            if !(2.0..=MAX_HARMONIC as f32).contains(&h) {
                continue;
            }
            let cents = 1200.0 * (r / h).log2();
            let hu = h as usize;
            if cents.abs() <= 20.0 + h && nt.explains(hu, p.a) {
                nt.energy += p.a * p.a;
                nt.partials[hu] = nt.partials[hu].max(p.a);
                explained = true;
                break;
            }
        }
        if !explained {
            notes.push(Note::new(p));
        }
    }
    notes
}

const BASS_SPLIT_MIDI: f32 = 48.0;
pub const LOW_NOTE_REL: f32 = 0.2;
const BASS_WEIGHT: f32 = 0.6;

pub const PEAK_OVER_FLOOR: f32 = 8.0;
pub const CHROMA_FMIN: f32 = 26.0;
const LOW_SPLIT: f32 = 220.0;
const MAIN_FMIN: f32 = 110.0;
const SAME_NOTE_CENTS: f32 = 40.0;
const TONALITY_FMIN: f32 = 220.0;
const CHROMA_FMAX: f32 = 5000.0;

pub fn chroma(x: &[f32], sr: f32, ctx: &JobCtx) -> Result<Chroma, JobError> {
    let n_fft = 8192;
    let hop = 2048;
    let bin_hz = sr / n_fft as f32;
    let max_bin = ((CHROMA_FMAX / bin_hz) as usize + 2).min(n_fft / 2);
    let spec = power_spectrogram(x, sr, n_fft, hop, max_bin, ctx)?;
    let (frames, bins, fps) = (spec.frames, spec.bins, spec.fps());
    ctx.check()?;
    let mut mag = spec.power;
    for v in mag.iter_mut() {
        *v = v.sqrt();
    }
    let harm = temporal_median(&mag, frames, bins, 4);
    drop(mag);
    ctx.check()?;
    const DEC: usize = 8;
    let xl = crate::audio::decimate(x, DEC);
    let lsr = sr / DEC as f32;
    let l_fft = 4096;
    let l_bin_hz = lsr / l_fft as f32;
    let l_max = ((LOW_SPLIT * 1.1 / l_bin_hz) as usize + 2).min(l_fft / 2);
    let lspec = power_spectrogram(&xl, lsr, l_fft, hop * 2 / DEC, l_max, ctx)?;
    let (lframes, lbins) = (lspec.frames, lspec.bins);
    let mut lmag = lspec.power;
    for v in lmag.iter_mut() {
        *v = v.sqrt();
    }
    let lharm = temporal_median(&lmag, lframes, lbins, 2);
    drop(lmag);
    ctx.check()?;
    let (scale, lscale) = (4.0 / n_fft as f32, 4.0 / l_fft as f32);
    let gmax = harm.iter().cloned().fold(0f32, f32::max) * scale;
    let lgmax = lharm.iter().cloned().fold(0f32, f32::max) * lscale;
    let abs_floor = gmax.max(lgmax) * 10f32.powf(-70.0 / 20.0);
    let (k_lo, k_hi) = ((MAIN_FMIN / bin_hz).ceil() as usize, bins - 2);
    let (lk_lo, lk_hi) = ((CHROMA_FMIN / l_bin_hz).floor() as usize, ((LOW_SPLIT / l_bin_hz).floor() as usize).min(lbins - 2));
    let k_ton = ((TONALITY_FMIN / bin_hz).ceil() as usize).clamp(k_lo, k_hi);
    let main_band = Band { bin_hz, k_lo, k_hi, amp_scale: scale, abs_floor: abs_floor / scale, main: true };
    let low_band = Band { bin_hz: l_bin_hz, k_lo: lk_lo, k_hi: lk_hi, amp_scale: lscale, abs_floor: abs_floor / lscale, main: false };
    let mut frame_notes: Vec<Vec<Note>> = Vec::with_capacity(frames);
    let mut tonality = Vec::with_capacity(frames);
    let mut pre = Vec::new();
    let mut peaks = Vec::new();
    for t in 0..frames {
        if t % 256 == 0 {
            ctx.check()?;
        }
        peaks.clear();
        let lt = t.div_ceil(2).min(lframes.saturating_sub(1));
        if lframes > 0 {
            frame_peaks(&lharm[lt * lbins..(lt + 1) * lbins], &low_band, &mut pre, &mut peaks);
        }
        let first_main = peaks.len();
        let row = &harm[t * bins..(t + 1) * bins];
        frame_peaks(row, &main_band, &mut pre, &mut peaks);
        merge_overlap(&mut peaks, first_main);
        let first_main = peaks.iter().position(|p| p.main).unwrap_or(peaks.len());
        let band_e: f32 = row[k_ton..=k_hi].iter().map(|v| v * v).sum();
        let peak_e: f32 = peaks[first_main..]
            .iter()
            .filter(|p| p.f >= TONALITY_FMIN)
            .map(|p| {
                let k = (p.f / bin_hz).round() as usize;
                row[k.saturating_sub(1)..(k + 2).min(row.len())].iter().map(|v| v * v).sum::<f32>()
            })
            .sum();
        tonality.push(if band_e > 0.0 { (peak_e / band_e).min(1.0) } else { 0.0 });
        frame_notes.push(sieve(&mut peaks));
    }
    let (mut cs, mut sn) = (0f64, 0f64);
    for n in frame_notes.iter().flatten().filter(|n| n.f > 100.0) {
        let m = 69.0 + 12.0 * (n.f as f64 / 440.0).log2();
        let a = 2.0 * std::f64::consts::PI * (m - m.round());
        let w = n.energy.sqrt() as f64;
        cs += w * a.cos();
        sn += w * a.sin();
    }
    let tuning = if cs.abs() + sn.abs() > 0.0 { (sn.atan2(cs) / (2.0 * std::f64::consts::PI)) as f32 } else { 0.0 };
    let mut bass = vec![[0f32; 12]; frames];
    let mut treble = vec![[0f32; 12]; frames];
    let mut low = vec![[0f32; 12]; frames];
    let (mut b_sum, mut t_sum) = (0f32, 0f32);
    for (t, notes) in frame_notes.iter().enumerate() {
        let midi = |n: &Note| 69.0 + 12.0 * (n.f / 440.0).log2() - tuning;
        let strongest = notes.iter().filter(|n| midi(n).round() >= BASS_SPLIT_MIDI).map(|n| n.energy.sqrt()).fold(0f32, f32::max);
        let mut low_done = false;
        for n in notes {
            let p = midi(n);
            let r = p.round();
            let dev = p - r;
            let pc = (r as i64).rem_euclid(12) as usize;
            let w = n.energy.sqrt() * (std::f32::consts::PI * dev).cos().powi(2);
            if !low_done && r >= BASS_SPLIT_MIDI && n.energy.sqrt() >= LOW_NOTE_REL * strongest {
                low[t][pc] += w;
                low_done = true;
            }
            if r < BASS_SPLIT_MIDI {
                bass[t][pc] += w;
                b_sum += w;
            } else {
                treble[t][pc] += w;
                t_sum += w;
            }
        }
    }
    let all = (b_sum + t_sum).max(1e-12);
    let wb = BASS_WEIGHT / b_sum.max(0.2 * all);
    let wt = 1.0 / t_sum.max(0.2 * all);
    let out: Vec<[f32; 12]> = (0..frames)
        .map(|t| {
            let mut c = [0f32; 12];
            for k in 0..12 {
                c[k] = wt * treble[t][k] + wb * bass[t][k];
            }
            c
        })
        .collect();
    for row in treble.iter_mut() {
        for v in row.iter_mut() {
            *v *= wt;
        }
    }
    let wl = 1.0 / all;
    for row in low.iter_mut().chain(bass.iter_mut()) {
        for v in row.iter_mut() {
            *v *= wl;
        }
    }
    Ok(Chroma { fps, frames: out, treble, bass, low, tonality, treble_share: if b_sum + t_sum > 0.0 { t_sum / all } else { 0.0 }, tuning })
}

#[derive(Debug, Clone)]
pub struct KeyGuess {
    pub tonic_pc: usize,
    pub minor: bool,
    pub confidence: f32,
    pub reranked: bool,
}

fn pearson(a: &[f32; 12], b: &[f32; 12]) -> f32 {
    let ma = a.iter().sum::<f32>() / 12.0;
    let mb = b.iter().sum::<f32>() / 12.0;
    let (mut ab, mut aa, mut bb) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        let (x, y) = (a[i] - ma, b[i] - mb);
        ab += x * y;
        aa += x * x;
        bb += y * y;
    }
    if aa <= 1e-12 || bb <= 1e-12 {
        0.0
    } else {
        ab / (aa * bb).sqrt()
    }
}

pub fn total_chroma(ch: &Chroma) -> [f32; 12] {
    let mut total = [0f32; 12];
    for f in &ch.frames {
        for k in 0..12 {
            total[k] += f[k];
        }
    }
    total
}

pub fn key_scores(ch: &Chroma) -> Vec<(usize, bool, f32)> {
    let total = total_chroma(ch);
    let mut scores: Vec<(usize, bool, f32)> = Vec::with_capacity(24);
    for tonic in 0..12 {
        for (minor, prof) in [(false, &KK_MAJOR), (true, &KK_MINOR)] {
            let mut rot = [0f32; 12];
            for i in 0..12 {
                rot[(i + tonic) % 12] = prof[i];
            }
            scores.push((tonic, minor, pearson(&total, &rot)));
        }
    }
    scores.sort_by(|a, b| b.2.total_cmp(&a.2));
    scores
}

pub fn detect_key(ch: &Chroma) -> Option<KeyGuess> {
    let total = total_chroma(ch);
    let sum: f32 = total.iter().sum();
    if sum.is_nan() || sum <= 1e-9 {
        return None;
    }
    let scores = key_scores(ch);
    if std::env::var_os("KRYPT_KEY_DEBUG").is_some() {
        let max = total.iter().cloned().fold(0f32, f32::max);
        let n: Vec<String> = total.iter().map(|v| format!("{:.2}", v / max)).collect();
        let top: Vec<String> = scores.iter().take(4).map(|s| format!("{}{} {:.3}", tonic_name(s.0, s.1), if s.1 { "m" } else { "" }, s.2)).collect();
        eprintln!("key debug: chroma C..B [{}] contrast {:.2} top {}", n.join(" "), contrast(&total), top.join(", "));
    }
    if !is_tonal(&total) {
        return None;
    }
    let (tonic, minor, r) = scores[0];
    let rel = if minor { (tonic + 3) % 12 } else { (tonic + 9) % 12 };
    let r2 = scores.iter().skip(1).find(|s| !(s.0 == rel && s.1 != minor)).map(|s| s.2).unwrap_or(0.0);
    if r < MIN_FIT {
        return None;
    }
    let margin = ((r - r2) / 0.1).clamp(0.0, 1.0);
    let confidence = (r * (0.6 + 0.4 * margin)).clamp(0.0, 1.0);
    Some(KeyGuess { tonic_pc: tonic, minor, confidence, reranked: false })
}

const RERANK_MARGIN: f32 = 0.15;
const RERANK_MAX: usize = 4;
const RERANK_MIN_SECS: f32 = 8.0;
const RERANK_MIN_SPANS: usize = 3;
const RERANK_MIN_CONFIDENCE: f32 = 0.3;
const W_PROFILE: f32 = 0.5;
const W_FUNCTION: f32 = 0.5;
const W_CADENCE: f32 = 0.15;
const W_FIRST: f32 = 0.05;
const W_BASS: f32 = 0.1;
const FIRST_MIN_SECS: f32 = 1.0;
const FIRST_MIN_CONFIDENCE: f32 = 0.5;
const RERANKED_CONFIDENCE: f32 = 0.8;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Triad {
    Maj,
    Min,
    Dim,
}

fn degree_weight(minor: bool, iv: usize, t: Triad) -> f32 {
    use Triad::*;
    if minor {
        match (iv, t) {
            (0, Min) => 1.0,
            (7, Maj) => 0.6,
            (7, Min) | (3, Maj) => 0.5,
            (5, Min) | (8, Maj) | (10, Maj) => 0.6,
            (5, Maj) => 0.35,
            (2, Dim) => 0.3,
            (11, Dim) => 0.25,
            (2, Min) => 0.2,
            (1, Maj) | (0, Maj) => 0.15,
            _ => 0.08,
        }
    } else {
        match (iv, t) {
            (0, Maj) => 1.0,
            (7, Maj) => 0.75,
            (5, Maj) => 0.7,
            (9, Min) => 0.6,
            (2, Min) => 0.5,
            (4, Min) => 0.4,
            (10, Maj) => 0.35,
            (11, Dim) | (2, Maj) | (5, Min) => 0.25,
            (4, Maj) | (8, Maj) => 0.2,
            (9, Maj) | (3, Maj) => 0.15,
            (0, Min) => 0.1,
            _ => 0.08,
        }
    }
}

pub fn chord_weight(tonic: usize, minor: bool, root: u8, q: ChordQuality) -> f32 {
    let iv = (root as usize % 12 + 12 - tonic % 12) % 12;
    let w = |t| degree_weight(minor, iv, t);
    match q {
        ChordQuality::Maj | ChordQuality::Maj7 | ChordQuality::Dom7 => w(Triad::Maj),
        ChordQuality::Min | ChordQuality::Min7 => w(Triad::Min),
        ChordQuality::Dim => w(Triad::Dim),
        ChordQuality::Sus | ChordQuality::Power => 0.8 * w(Triad::Maj).max(w(Triad::Min)),
    }
}

fn is_tonic_chord(s: &ChordSpan, tonic: usize, minor: bool) -> bool {
    s.root as usize % 12 == tonic % 12
        && match s.quality {
            ChordQuality::Min | ChordQuality::Min7 => minor,
            ChordQuality::Maj | ChordQuality::Maj7 => !minor,
            _ => false,
        }
}

pub fn detect_key_with_chords(ch: &Chroma, chords: &[ChordSpan], bass_share: &[f32; 12]) -> Option<KeyGuess> {
    let kk = detect_key(ch)?;
    let total: f32 = chords.iter().map(|c| c.end_sec - c.start_sec).sum();
    let mean_conf = chords.iter().map(|c| c.confidence * (c.end_sec - c.start_sec)).sum::<f32>() / total.max(1e-9);
    if std::env::var_os("KRYPT_KEY_DEBUG").is_some() {
        eprintln!("key debug: {total:.1} s of key-neutral chords, mean confidence {mean_conf:.2}");
    }
    if total < RERANK_MIN_SECS || chords.len() < RERANK_MIN_SPANS || mean_conf < RERANK_MIN_CONFIDENCE {
        return Some(kk);
    }
    let scores = key_scores(ch);
    let r0 = scores[0].2;
    let first = chords.iter().find(|c| c.end_sec - c.start_sec >= FIRST_MIN_SECS && c.confidence >= FIRST_MIN_CONFIDENCE);
    let changes: Vec<(&ChordSpan, &ChordSpan)> = chords.windows(2).filter(|w| w[1].start_sec - w[0].end_sec < 0.05).map(|w| (&w[0], &w[1])).collect();
    let mut ranked: Vec<(usize, bool, f32, f32)> = scores
        .iter()
        .take(RERANK_MAX)
        .filter(|s| s.2 >= r0 - RERANK_MARGIN)
        .map(|&(tonic, minor, r)| {
            let (mut num, mut den) = (0f32, 0f32);
            for c in chords {
                let w = (c.end_sec - c.start_sec) * (0.5 + 0.5 * c.confidence);
                num += w * chord_weight(tonic, minor, c.root, c.quality).ln();
                den += w;
            }
            let function = if den > 0.0 { num / den } else { 0.0 };
            let first_tonic = first.map(|c| is_tonic_chord(c, tonic, minor)).unwrap_or(false);
            let dominant = (tonic + 7) % 12;
            let cadences = changes.iter().filter(|(a, b)| a.root as usize % 12 == dominant && is_tonic_chord(b, tonic, minor)).count();
            let cadence = if changes.is_empty() { 0.0 } else { (4.0 * cadences as f32 / changes.len() as f32).min(1.0) };
            let score = W_PROFILE * r + W_FUNCTION * function + W_CADENCE * cadence + if first_tonic { W_FIRST } else { 0.0 } + W_BASS * bass_share[tonic];
            if std::env::var_os("KRYPT_KEY_DEBUG").is_some() {
                eprintln!("key debug:   {}{}: r {r:.3} function {function:.3} cadence {cadence:.2} ({cadences} of {}) first tonic {first_tonic} bass {:.2}", tonic_name(tonic, minor), if minor { "m" } else { "" }, changes.len(), bass_share[tonic]);
            }
            (tonic, minor, r, score)
        })
        .collect();
    ranked.sort_by(|a, b| b.3.total_cmp(&a.3));
    if std::env::var_os("KRYPT_KEY_DEBUG").is_some() {
        let mut by: Vec<(String, f32)> = Vec::new();
        for c in chords {
            let l = format!("{}{}", tonic_name(c.root as usize, false), c.quality.as_str());
            match by.iter_mut().find(|x| x.0 == l) {
                Some(x) => x.1 += c.end_sec - c.start_sec,
                None => by.push((l, c.end_sec - c.start_sec)),
            }
        }
        by.sort_by(|a, b| b.1.total_cmp(&a.1));
        let shown: Vec<String> = by.iter().take(8).map(|(l, t)| format!("{l} {t:.1}s")).collect();
        eprintln!("key debug: neutral chords {} (first {:?})", shown.join(", "), first.map(|c| format!("{}{}", tonic_name(c.root as usize, false), c.quality.as_str())));
        let s: Vec<String> = ranked.iter().map(|k| format!("{}{} r {:.3} → {:.3}", tonic_name(k.0, k.1), if k.1 { "m" } else { "" }, k.2, k.3)).collect();
        eprintln!("key debug: chord re-rank over {total:.1} s of chords: {}", s.join(", "));
    }
    let (tonic, minor, r, score) = ranked[0];
    if tonic == kk.tonic_pc && minor == kk.minor {
        return Some(kk);
    }
    let runner = ranked.get(1).map(|k| k.3).unwrap_or(score - 0.1);
    let margin = ((score - runner) / 0.1).clamp(0.0, 1.0);
    let confidence = (r * (0.6 + 0.4 * margin) * RERANKED_CONFIDENCE).clamp(0.0, 1.0);
    Some(KeyGuess { tonic_pc: tonic, minor, confidence, reranked: true })
}

pub fn contrast(total: &[f32; 12]) -> f32 {
    let max = total.iter().cloned().fold(0f32, f32::max);
    let mut sorted = *total;
    sorted.sort_by(|a, b| b.total_cmp(a));
    (sorted[..7].iter().sum::<f32>() / 7.0) / (sorted[7..].iter().sum::<f32>() / 5.0).max(max * 1e-6)
}

pub fn is_tonal(total: &[f32; 12]) -> bool {
    let sum: f32 = total.iter().sum();
    if !sum.is_finite() || sum <= 1e-9 {
        return false;
    }
    let max = total.iter().cloned().fold(0f32, f32::max);
    contrast(total) >= MIN_CONTRAST && total.iter().filter(|&&v| v >= 0.15 * max).count() >= 3
}

pub const MIN_CONTRAST: f32 = 1.8;
pub const MIN_FIT: f32 = 0.65;

pub fn tonic_name(pc: usize, minor: bool) -> &'static str {
    const MAJOR: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
    const MINOR: [&str; 12] = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];
    if minor {
        MINOR[pc % 12]
    } else {
        MAJOR[pc % 12]
    }
}

pub fn key_name(pc: usize, minor: bool) -> String {
    format!("{}{}", tonic_name(pc, minor), if minor { "m" } else { "" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_key_signatures() {
        assert_eq!(key_name(6, true), "F#m");
        assert_eq!(key_name(3, false), "Eb");
        assert_eq!(key_name(0, false), "C");
        assert_eq!(key_name(1, false), "Db");
        assert_eq!(key_name(1, true), "C#m");
        assert_eq!(key_name(8, true), "G#m");
        assert_eq!(key_name(10, true), "Bbm");
        assert_eq!(key_name(3, true), "Ebm");
    }

    fn saw_peaks(f0: f32, a: f32, n: usize) -> Vec<Peak> {
        (1..=n).map(|h| Peak { f: f0 * h as f32, a: a / h as f32, main: true }).collect()
    }

    #[test]
    fn sieve_counts_a_saw_stack_once() {
        let mut p = saw_peaks(110.0, 1.0, 16);
        let notes = sieve(&mut p);
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!((notes[0].f - 110.0).abs() < 0.01);
    }

    #[test]
    fn sieve_keeps_chord_tones_on_a_square_roots_series() {
        let f1 = 43.65;
        let mut p: Vec<Peak> = [1usize, 3, 5, 7, 9].iter().map(|&h| Peak { f: f1 * h as f32, a: 0.6 / h as f32, main: true }).collect();
        p.push(Peak { f: 261.63, a: 0.05, main: true });
        p.push(Peak { f: 311.13, a: 0.05, main: true });
        let notes = sieve(&mut p);
        let pitches: Vec<i32> = notes.iter().map(|n| (69.0 + 12.0 * (n.f / 440.0).log2()).round() as i32).collect();
        assert!(pitches.contains(&29) && pitches.contains(&60) && pitches.contains(&63), "{pitches:?}");
    }

    #[test]
    fn chord_function_weights() {
        use ChordQuality::*;
        let bbm = |root: u8, q| chord_weight(10, true, root, q);
        assert_eq!(bbm(10, Min7), 1.0);
        assert!(bbm(6, Maj7) >= 0.5 && bbm(8, Maj7) >= 0.5 && bbm(5, Min7) >= 0.5);
        assert!(chord_weight(5, true, 6, Maj7) < 0.2);
        let c = |root: u8, q| chord_weight(0, false, root, q);
        assert!(c(0, Maj) > c(7, Dom7) && c(7, Maj) > c(5, Maj) && c(5, Maj) > c(9, Min) && c(9, Min) > c(2, Min) && c(2, Min) > c(4, Min));
        assert!((c(7, Sus) - 0.8 * c(7, Maj)).abs() < 1e-6);
    }

    #[test]
    fn sieve_keeps_a_loud_fifth_over_a_quiet_root() {
        let mut p = saw_peaks(87.31, 0.3, 8);
        p.push(Peak { f: 261.63, a: 0.3, main: true });
        let notes = sieve(&mut p);
        assert_eq!(notes.len(), 2, "{notes:?}");
    }
}
