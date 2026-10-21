use crate::audio;
use crate::features::{median, parabolic};
use crate::protocol::{Syllable, SyllablesArgs, SyllablesResult};
use crate::{JobCtx, JobError};

pub const TRACK_SR: u32 = 12_000;
pub const FMIN: f32 = 60.0;
pub const FMAX: f32 = 700.0;
const YIN_WIN: f32 = 0.03;
pub const VOICED_APER: f32 = 0.25;

const HOP_SEC: f32 = 0.005;
const MIN_SPACING_SEC: f32 = 0.07;
const PAUSE_SEC: f32 = 0.12;
const SILENCE_DB: f32 = 40.0;
pub const MAX_SYLLABLES: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VoiceFrame {
    pub f0: Option<f32>,
    pub aper: f32,
    pub rms: f32,
}

pub fn voicing_track(x: &[f32], sr: f32, hop_sec: f32) -> Vec<VoiceFrame> {
    let y = if (sr.round() as u32) == TRACK_SR { x.to_vec() } else { audio::resample(x, sr, TRACK_SR) };
    let fs = TRACK_SR as f32;
    let hop = ((hop_sec * fs).round() as usize).max(1);
    let w = (YIN_WIN * fs) as usize;
    let tau_min = (fs / FMAX).floor() as usize;
    let tau_max = (fs / FMIN).ceil() as usize;
    let n_frames = if y.is_empty() { 0 } else { y.len() / hop + 1 };
    let span = w + tau_max;
    let mut frames = Vec::with_capacity(n_frames);
    let mut buf = vec![0f32; span];
    let mut d = vec![0f32; tau_max + 2];
    let mut rms_all = Vec::with_capacity(n_frames);
    for t in 0..n_frames {
        let start = (t * hop) as isize - (w / 2) as isize;
        for (j, v) in buf.iter_mut().enumerate() {
            let k = start + j as isize;
            *v = if k >= 0 && (k as usize) < y.len() { y[k as usize] } else { 0.0 };
        }
        let e: f32 = buf[..w].iter().map(|v| v * v).sum::<f32>() / w as f32;
        rms_all.push(e.sqrt());
    }
    let loudest = rms_all.iter().fold(0f32, |m, v| m.max(*v));
    let gate = (loudest * 1e-3).max(1e-5);
    for t in 0..n_frames {
        let rms = rms_all[t];
        if rms < gate {
            frames.push(VoiceFrame { f0: None, aper: 1.0, rms });
            continue;
        }
        let start = (t * hop) as isize - (w / 2) as isize;
        for (j, v) in buf.iter_mut().enumerate() {
            let k = start + j as isize;
            *v = if k >= 0 && (k as usize) < y.len() { y[k as usize] } else { 0.0 };
        }
        d[0] = 0.0;
        for tau in 1..=tau_max {
            let mut s = 0f32;
            for j in 0..w {
                let diff = buf[j] - buf[j + tau];
                s += diff * diff;
            }
            d[tau] = s;
        }
        let mut run = 0f32;
        for tau in 1..=tau_max {
            run += d[tau];
            d[tau] = if run > 0.0 { d[tau] * tau as f32 / run } else { 1.0 };
        }
        d[0] = 1.0;
        let mut best = None;
        let mut tau = tau_min.max(2);
        while tau < tau_max {
            if d[tau] < 0.15 {
                while tau + 1 < tau_max && d[tau + 1] < d[tau] {
                    tau += 1;
                }
                best = Some(tau);
                break;
            }
            tau += 1;
        }
        let tau = best.unwrap_or_else(|| (tau_min.max(2)..tau_max).min_by(|&a, &b| d[a].total_cmp(&d[b])).unwrap_or(tau_min));
        let aper = d[tau].clamp(0.0, 1.0);
        let off = if tau > 1 && tau < tau_max { parabolic(d[tau - 1], d[tau], d[tau + 1]) } else { 0.0 };
        let f0 = fs / (tau as f32 + off);
        frames.push(VoiceFrame { f0: (aper < VOICED_APER).then_some(f0), aper, rms });
    }
    frames
}

pub fn median_f0(frames: &[VoiceFrame], min_frames: usize) -> Option<f32> {
    let f: Vec<f32> = frames.iter().filter_map(|v| v.f0).collect();
    (f.len() >= min_frames.max(1)).then(|| median(&f))
}

fn band(x: &[f32], sr: f32, lo: f32, hi: f32) -> Vec<f32> {
    let a_hp = (-2.0 * std::f32::consts::PI * lo / sr).exp();
    let a_lp = (-2.0 * std::f32::consts::PI * hi / sr).exp();
    let (mut hp_y, mut hp_x, mut lp) = (0f32, 0f32, 0f32);
    let mut out = Vec::with_capacity(x.len());
    for &v in x {
        hp_y = a_hp * (hp_y + v - hp_x);
        hp_x = v;
        lp = (1.0 - a_lp) * hp_y + a_lp * lp;
        out.push(lp);
    }
    out
}

fn smooth(x: &[f32], radius: usize) -> Vec<f32> {
    let n = x.len();
    let mut pre = vec![0f64; n + 1];
    for i in 0..n {
        pre[i + 1] = pre[i] + f64::from(x[i]);
    }
    (0..n)
        .map(|i| {
            let a = i.saturating_sub(radius);
            let b = (i + radius + 1).min(n);
            ((pre[b] - pre[a]) / (b - a) as f64) as f32
        })
        .collect()
}

pub fn detect(x: &[f32], sr: f32, expected: Option<usize>, ctx: &JobCtx) -> Result<Vec<Syllable>, JobError> {
    let voice = voicing_track(x, sr, HOP_SEC);
    ctx.check()?;
    let hop = (HOP_SEC * sr).round().max(1.0) as usize;
    let b = band(x, sr, 250.0, 4000.0);
    let half_win = (0.0125 * sr) as isize;
    let n = voice.len();
    let mut energy = vec![0f32; n];
    for (t, e) in energy.iter_mut().enumerate() {
        let c = (t * hop) as isize;
        let (a, z) = ((c - half_win).max(0) as usize, ((c + half_win) as usize).min(b.len()));
        if z > a {
            *e = (b[a..z].iter().map(|v| v * v).sum::<f32>() / (z - a) as f32).sqrt();
        }
    }
    let loud = energy.iter().fold(0f32, |m, v| m.max(*v));
    if loud <= 1e-6 {
        return Ok(Vec::new());
    }
    let silent_thr = loud * 10f32.powf(-SILENCE_DB / 20.0);
    let strength_raw: Vec<f32> = energy.iter().zip(&voice).map(|(e, v)| e / loud * (0.25 + 0.75 * (1.0 - v.aper).clamp(0.0, 1.0))).collect();
    let s = smooth(&strength_raw, 4);
    let silent: Vec<bool> = energy.iter().map(|&e| e < silent_thr).collect();

    let mut peaks: Vec<usize> = (1..n.saturating_sub(1)).filter(|&t| s[t] > s[t - 1] && s[t] >= s[t + 1] && !silent[t] && s[t] > 0.02).collect();
    let min_gap = (MIN_SPACING_SEC / HOP_SEC) as usize;
    let mut by_height = peaks.clone();
    by_height.sort_by(|&a, &b| s[b].total_cmp(&s[a]).then(a.cmp(&b)));
    let mut kept: Vec<usize> = Vec::new();
    for p in by_height {
        if kept.iter().all(|&k| k.abs_diff(p) >= min_gap) {
            kept.push(p);
        }
    }
    kept.sort_unstable();
    peaks = kept;
    let valley = |a: usize, b: usize| (a..=b).map(|t| s[t]).fold(f32::INFINITY, f32::min);
    let prom: Vec<f32> = (0..peaks.len())
        .map(|i| {
            let p = peaks[i];
            let l = if i > 0 { valley(peaks[i - 1], p) } else { valley(0, p) };
            let r = if i + 1 < peaks.len() { valley(p, peaks[i + 1]) } else { valley(p, n - 1) };
            s[p] - l.max(r)
        })
        .collect();
    let mut chosen: Vec<usize> = match expected {
        Some(k) if k > 0 => {
            let mut idx: Vec<usize> = (0..peaks.len()).collect();
            idx.sort_by(|&a, &b| prom[b].total_cmp(&prom[a]).then(a.cmp(&b)));
            idx.truncate(k);
            idx.into_iter().map(|i| peaks[i]).collect()
        }
        _ => (0..peaks.len()).filter(|&i| prom[i] >= 0.12 * s[peaks[i]] && prom[i] > 0.01).map(|i| peaks[i]).collect(),
    };
    chosen.sort_unstable();
    if chosen.is_empty() {
        return Ok(Vec::new());
    }

    let first_sound = silent.iter().position(|&q| !q).unwrap_or(0);
    let last_sound = silent.iter().rposition(|&q| !q).unwrap_or(n - 1);
    let pause_frames = (PAUSE_SEC / HOP_SEC) as usize;
    let mut segs: Vec<(usize, usize)> = Vec::with_capacity(chosen.len());
    let mut start = first_sound.min(chosen[0]);
    for i in 0..chosen.len() {
        let end = if i + 1 < chosen.len() {
            let (a, b) = (chosen[i], chosen[i + 1]);
            let mut run = 0;
            let mut pause: Option<(usize, usize)> = None;
            for t in a..=b {
                if silent[t] {
                    run += 1;
                    if run >= pause_frames {
                        pause = Some((t + 1 - run, t));
                    }
                } else {
                    if let Some(p) = pause {
                        pause = Some((p.0, t));
                        break;
                    }
                    run = 0;
                }
            }
            if let Some((ps, pe)) = pause {
                segs.push((start, ps));
                start = pe;
                continue;
            }
            (a..=b).min_by(|&x, &y| s[x].total_cmp(&s[y])).unwrap_or(a)
        } else {
            last_sound.max(chosen[i]) + 1
        };
        segs.push((start, end));
        start = end;
    }
    if let Some(k) = expected {
        let k = k.min(MAX_SYLLABLES);
        while segs.len() < k {
            let (i, _) = segs.iter().enumerate().max_by_key(|(_, (a, b))| b - a).unwrap_or((0, &(0, 0)));
            let (a, b) = segs[i];
            if b - a < 2 {
                break;
            }
            let mid = (a + b) / 2;
            segs[i] = (a, mid);
            segs.insert(i + 1, (mid, b));
        }
    }
    let to_sec = |f: usize| (f as f32 * HOP_SEC).min(x.len() as f32 / sr);
    Ok(segs
        .into_iter()
        .filter(|(a, b)| b > a)
        .map(|(a, b)| {
            let v = &voice[a..b.min(n)];
            let voiced = v.iter().filter(|f| f.f0.is_some()).count() * 3 >= v.len().max(1);
            Syllable { start_sec: to_sec(a), end_sec: to_sec(b), voiced }
        })
        .collect())
}

pub fn run(args: &SyllablesArgs, ctx: &JobCtx) -> Result<SyllablesResult, JobError> {
    ctx.progress("decoding", -1.0);
    let data = audio::load(&args.path)?;
    let x = audio::mono(&data.channels);
    ctx.check()?;
    ctx.progress("syllables", -1.0);
    let expected = args.expected.map(|e| e as usize).filter(|&e| e > 0);
    if expected.is_some_and(|e| e > MAX_SYLLABLES) {
        return Err(JobError::Failed(format!("Too many syllables expected (at most {MAX_SYLLABLES})")));
    }
    let syllables = detect(&x, data.sample_rate, expected, ctx)?;
    Ok(SyllablesResult { syllables })
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn babas(count: usize, sr: f32, vowel: f32, gap: f32) -> Vec<f32> {
        let mut x = vec![0f32; (0.1 * sr) as usize];
        let mut seed = 12345u32;
        for _ in 0..count {
            for _ in 0..(0.012 * sr) as usize {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                x.push(((seed >> 16) as f32 / 32768.0 - 1.0) * 0.15);
            }
            let n = (vowel * sr) as usize;
            for i in 0..n {
                let t = i as f32 / sr;
                let env = (std::f32::consts::PI * i as f32 / n as f32).sin().powf(0.7);
                let v: f32 = (1..8).map(|h| (2.0 * std::f32::consts::PI * 150.0 * h as f32 * t).sin() / h as f32).sum();
                x.push(0.3 * env * v);
            }
            x.extend(std::iter::repeat_n(0.0, (gap * sr) as usize));
        }
        x
    }

    #[test]
    fn counts_ba_ba_ba() {
        let ctx = JobCtx::detached();
        for (count, gap) in [(3, 0.06), (5, 0.03), (8, 0.0)] {
            let x = babas(count, 24_000.0, 0.16, gap);
            let s = detect(&x, 24_000.0, None, &ctx).unwrap();
            assert_eq!(s.len(), count, "count {count} gap {gap}: {s:?}");
            assert!(s.iter().all(|q| q.voiced), "{s:?}");
            for w in s.windows(2) {
                assert!(w[0].end_sec <= w[1].start_sec + 1e-6, "{s:?}");
            }
            assert_eq!(detect(&x, 24_000.0, Some(count), &ctx).unwrap().len(), count);
        }
    }

    #[test]
    fn aims_for_expected() {
        let ctx = JobCtx::detached();
        let x = babas(4, 44_100.0, 0.2, 0.05);
        assert_eq!(detect(&x, 44_100.0, Some(2), &ctx).unwrap().len(), 2);
        let more = detect(&x, 44_100.0, Some(7), &ctx).unwrap();
        assert_eq!(more.len(), 7);
        for w in more.windows(2) {
            assert!(w[0].end_sec <= w[1].start_sec + 1e-6);
        }
        assert!(detect(&vec![0.0; 24_000], 24_000.0, Some(3), &ctx).unwrap().is_empty());
    }

    #[test]
    fn yin_finds_the_pitch() {
        let sr = 24_000.0;
        let x: Vec<f32> = (0..(0.5 * sr) as usize).map(|i| (2.0 * std::f32::consts::PI * 220.0 * i as f32 / sr).sin() * 0.5).collect();
        let f = median_f0(&voicing_track(&x, sr, 0.01), 5).unwrap();
        assert!((1200.0 * (f / 220.0).log2()).abs() < 5.0, "{f}");
        let mut seed = 1u32;
        let noise: Vec<f32> = (0..12_000)
            .map(|_| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                (seed >> 16) as f32 / 32768.0 - 1.0
            })
            .collect();
        assert_eq!(median_f0(&voicing_track(&noise, sr, 0.01), 5), None);
    }
}
