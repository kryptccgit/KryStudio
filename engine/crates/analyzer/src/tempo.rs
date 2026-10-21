use crate::features::{autocorr, lerp_at, mean, median, moving_average, parabolic, std_dev};

pub const PRIOR_CENTER_BPM: f32 = 115.0;
pub const PRIOR_SIGMA_OCT: f32 = 1.1;
pub const MIN_BPM: f32 = 40.0;
pub const MAX_BPM: f32 = 250.0;

#[derive(Debug, Clone)]
pub struct TempoEstimate {
    pub bpm: f32,
    pub confidence: f32,
    pub alternatives: Vec<f32>,
}

fn prior(bpm: f32) -> f32 {
    let o = (bpm / PRIOR_CENTER_BPM).log2() / PRIOR_SIGMA_OCT;
    (-0.5 * o * o).exp()
}

fn envelope_acf(env: &[f32], fps: f32, max_lag: usize) -> Vec<f32> {
    let trend = moving_average(env, (fps * 1.0) as usize);
    let d: Vec<f32> = env.iter().zip(&trend).map(|(a, b)| a - b).collect();
    let mut acf = autocorr(&d, max_lag);
    let n = env.len() as f32;
    let a0 = acf[0].max(1e-12);
    for (l, v) in acf.iter_mut().enumerate() {
        let unbias = n / (n - l as f32).max(n * 0.25);
        *v = *v / a0 * unbias;
    }
    acf
}

fn comb(acf: &[f32], lag: f32, k_max: usize) -> f32 {
    let mut s = 0.0;
    let mut w = 0.0;
    for k in 1..=k_max {
        let l = lag * k as f32;
        if l >= (acf.len() - 1) as f32 {
            break;
        }
        s += lerp_at(acf, l);
        w += 1.0;
    }
    if w > 0.0 {
        s / w
    } else {
        0.0
    }
}

pub fn estimate_tempo(env: &[f32], fps: f32, onsets: usize) -> Option<TempoEstimate> {
    if env.len() < (fps * 4.0) as usize || std_dev(env) < 1e-6 {
        return None;
    }
    if (onsets as f32) < 0.75 * env.len() as f32 / fps {
        return None;
    }
    let max_lag = ((60.0 * fps / MIN_BPM) * 4.0).ceil() as usize + 2;
    let acf = envelope_acf(env, fps, max_lag.min(env.len() - 1));
    let mut grid = Vec::new();
    let mut b = MIN_BPM;
    while b <= MAX_BPM {
        grid.push(b);
        b += 0.5;
    }
    let raw: Vec<f32> = grid.iter().map(|&b| comb(&acf, 60.0 * fps / b, 4)).collect();
    let scored: Vec<f32> = grid.iter().zip(&raw).map(|(&b, &c)| c.max(0.0) * prior(b)).collect();
    let (bi, _) = scored.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1))?;
    let mut best = grid[bi];
    let mut best_s = f32::MIN;
    let mut f = grid[bi] - 1.0;
    while f <= grid[bi] + 1.0 {
        let s = comb(&acf, 60.0 * fps / f, 8);
        if s > best_s {
            best_s = s;
            best = f;
        }
        f += 0.02;
    }
    let peak = raw[bi];
    let background = median(&raw);
    let confidence = ((peak - background) / (1.0 - background).max(1e-3)).clamp(0.0, 1.0);
    if confidence < 0.06 || peak <= 0.0 {
        return None;
    }
    let mut alts: Vec<(f32, f32)> = Vec::new();
    for cand in [best * 0.5, best * 2.0] {
        if (MIN_BPM * 0.9..=MAX_BPM * 1.1).contains(&cand) {
            let s = comb(&acf, 60.0 * fps / cand, 4).max(0.0) * prior(cand);
            alts.push((cand, s));
        }
    }
    alts.sort_by(|a, b| b.1.total_cmp(&a.1));
    Some(TempoEstimate { bpm: best, confidence, alternatives: alts.into_iter().map(|a| a.0).collect() })
}

pub fn track_beats(env: &[f32], period: f32, tightness: f32) -> Vec<f32> {
    let n = env.len();
    if n < 4 || period.is_nan() || period <= 2.0 {
        return Vec::new();
    }
    let sd = std_dev(env).max(1e-9);
    let norm: Vec<f32> = env.iter().map(|v| v / sd).collect();
    let half = period.round() as i64;
    let sigma = (period / 32.0).max(0.5);
    let win: Vec<f32> = (-half..=half).map(|k| (-0.5 * (k as f32 / sigma).powi(2)).exp()).collect();
    let mut local = vec![0f32; n];
    for (i, l) in local.iter_mut().enumerate() {
        let mut s = 0.0;
        for (j, w) in win.iter().enumerate() {
            let k = i as i64 + j as i64 - half;
            if k >= 0 && (k as usize) < n && *w > 1e-4 {
                s += norm[k as usize] * w;
            }
        }
        *l = s;
    }
    let lmax = local.iter().cloned().fold(0.0f32, f32::max);
    let lo = (period * 0.5).round() as usize;
    let hi = (period * 2.0).round() as usize;
    let mut cum = vec![0f32; n];
    let mut back = vec![-1i64; n];
    let mut first = true;
    for i in 0..n {
        let mut best = f32::MIN;
        let mut arg = -1i64;
        if i >= lo {
            let from = i.saturating_sub(hi);
            for (tau, &c) in cum.iter().enumerate().take(i - lo + 1).skip(from) {
                let d = (i - tau) as f32 / period;
                let s = c - tightness * d.ln().powi(2);
                if s > best {
                    best = s;
                    arg = tau as i64;
                }
            }
        }
        if arg < 0 {
            best = 0.0;
        }
        cum[i] = local[i] + best.max(0.0);
        if first && local[i] < 0.01 * lmax {
            back[i] = -1;
        } else {
            back[i] = arg;
            first = false;
        }
    }
    let maxima: Vec<usize> = (1..n.saturating_sub(1)).filter(|&i| cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]).collect();
    if maxima.is_empty() {
        return Vec::new();
    }
    let med = median(&maxima.iter().map(|&i| cum[i]).collect::<Vec<_>>());
    let last = *maxima.iter().rev().find(|&&i| cum[i] >= 0.5 * med).unwrap_or(maxima.last().unwrap());
    let mut beats = Vec::new();
    let mut i = last as i64;
    while i >= 0 {
        beats.push(i as usize);
        i = back[i as usize];
    }
    beats.reverse();
    let rms = (beats.iter().map(|&b| local[b] * local[b]).sum::<f32>() / beats.len() as f32).sqrt();
    let th = 0.5 * rms;
    let start = beats.iter().position(|&b| local[b] >= th).unwrap_or(0);
    let end = beats.iter().rposition(|&b| local[b] >= th).map(|e| e + 1).unwrap_or(beats.len());
    let beats = &beats[start..end.max(start)];
    beats
        .iter()
        .map(|&b| {
            let a = b.saturating_sub(2);
            let z = (b + 2).min(n - 1);
            let mut m = b;
            for k in a..=z {
                if env[k] > env[m] {
                    m = k;
                }
            }
            if m > 0 && m + 1 < n {
                m as f32 + parabolic(env[m - 1], env[m], env[m + 1])
            } else {
                m as f32
            }
        })
        .collect()
}

pub fn bpm_from_beats(times: &[f32]) -> Option<f32> {
    if times.len() < 4 {
        return None;
    }
    let ibis: Vec<f32> = times.windows(2).map(|w| w[1] - w[0]).filter(|d| *d > 0.0).collect();
    let med = median(&ibis);
    if med <= 0.0 {
        return None;
    }
    let mut idx = Vec::with_capacity(times.len());
    let mut k = 0f64;
    idx.push(0f64);
    for w in times.windows(2) {
        k += ((w[1] - w[0]) / med).round().max(1.0) as f64;
        idx.push(k);
    }
    let n = times.len() as f64;
    let mx = idx.iter().sum::<f64>() / n;
    let my = times.iter().map(|&t| t as f64).sum::<f64>() / n;
    let mut sxy = 0.0;
    let mut sxx = 0.0;
    for (x, &y) in idx.iter().zip(times) {
        sxy += (x - mx) * (y as f64 - my);
        sxx += (x - mx) * (x - mx);
    }
    if sxx <= 0.0 {
        return Some(60.0 / med);
    }
    let slope = sxy / sxx;
    let resid = (idx.iter().zip(times).map(|(x, &y)| (y as f64 - (my + slope * (x - mx))).powi(2)).sum::<f64>() / n).sqrt();
    if slope > 0.0 && resid < 0.025 {
        Some((60.0 / slope) as f32)
    } else {
        Some(60.0 / med)
    }
}

pub fn regularize_beats(beats: &[f32], period: f32, onsets: &[f32], duration: f32) -> Vec<f32> {
    if beats.len() < 2 || period.is_nan() || period <= 0.05 {
        return beats.to_vec();
    }
    let mut out: Vec<f32> = Vec::with_capacity(beats.len() * 2);
    out.push(beats[0]);
    for w in beats.windows(2) {
        let gap = w[1] - w[0];
        let k = (gap / period).round();
        if (2.0..=64.0).contains(&k) && (gap - k * period).abs() <= 0.2 * period {
            let step = gap / k;
            for j in 1..k as usize {
                out.push(w[0] + step * j as f32);
            }
        }
        out.push(w[1]);
    }
    let supported = |t: f32| -> bool {
        let i = onsets.partition_point(|&o| o < t - 0.06);
        i < onsets.len() && onsets[i] <= t + 0.06
    };
    let extend = |from: f32, dir: f32| -> Vec<f32> {
        let mut ext = Vec::new();
        let mut kept = 0;
        let mut misses = 0;
        let mut t = from + dir * period;
        while t >= -0.02 && t <= duration - 0.02 {
            ext.push(t.max(0.0));
            if supported(t) {
                kept = ext.len();
                misses = 0;
            } else {
                misses += 1;
                if misses >= 4 {
                    break;
                }
            }
            t += dir * period;
        }
        ext.truncate(kept);
        ext
    };
    let mut head = extend(out[0], -1.0);
    head.reverse();
    let tail = extend(*out.last().unwrap(), 1.0);
    head.extend(out);
    head.extend(tail);
    head
}

pub fn smooth_beats(times: &[f32], half: usize) -> Vec<f32> {
    let n = times.len();
    if n < 3 {
        return times.to_vec();
    }
    (0..n)
        .map(|i| {
            let a = i.saturating_sub(half);
            let b = (i + half + 1).min(n);
            let m = (b - a) as f64;
            let mx = (a..b).map(|j| j as f64).sum::<f64>() / m;
            let my = times[a..b].iter().map(|&t| t as f64).sum::<f64>() / m;
            let (mut sxy, mut sxx) = (0.0, 0.0);
            for (j, &t) in times.iter().enumerate().take(b).skip(a) {
                sxy += (j as f64 - mx) * (t as f64 - my);
                sxx += (j as f64 - mx).powi(2);
            }
            let slope = if sxx > 0.0 { sxy / sxx } else { 0.0 };
            (my + slope * (i as f64 - mx)) as f32
        })
        .collect()
}

pub fn downbeats_dsp(beats_frames: &[f32], low: &[f32], env: &[f32], change: &[f32]) -> (Vec<usize>, u32) {
    let nb = beats_frames.len();
    if nb < 4 {
        return (if nb > 0 { vec![0] } else { vec![] }, 4);
    }
    let at = |x: &[f32], f: f32| -> f32 {
        let c = f.round() as i64;
        let mut m = 0f32;
        for k in c - 2..=c + 2 {
            if k >= 0 && (k as usize) < x.len() {
                m = m.max(x[k as usize]);
            }
        }
        m
    };
    let norm = |v: Vec<f32>| -> Vec<f32> {
        let m = mean(&v);
        let s = std_dev(&v).max(1e-9);
        v.into_iter().map(|x| (x - m) / s).collect()
    };
    let lo = norm(beats_frames.iter().map(|&b| at(low, b)).collect());
    let br = norm(beats_frames.iter().map(|&b| at(env, b)).collect());
    let ch = norm((0..nb).map(|i| change.get(i).copied().unwrap_or(0.0)).collect());
    let score: Vec<f32> = (0..nb).map(|i| 1.0 * lo[i] + 1.0 * ch[i] + 0.3 * br[i]).collect();
    let best_for = |m: usize| -> (usize, f32) {
        let mut best = (0usize, f32::MIN);
        for phase in 0..m {
            let on: Vec<f32> = (phase..nb).step_by(m).map(|i| score[i]).collect();
            let s = mean(&on);
            if s > best.1 {
                best = (phase, s);
            }
        }
        best
    };
    let (p4, s4) = best_for(4);
    let (p3, s3) = best_for(3);
    let (phase, m) = if s3 > s4 * 1.35 && s3 > 0.5 { (p3, 3) } else { (p4, 4) };
    ((phase..nb).step_by(m).collect(), m as u32)
}

pub fn beats_per_bar(beats: &[f32], downbeats: &[f32]) -> u32 {
    let mut counts = [0u32; 8];
    for w in downbeats.windows(2) {
        let c = beats.iter().filter(|&&b| b >= w[0] - 1e-3 && b < w[1] - 1e-3).count();
        if (2..=7).contains(&c) {
            counts[c] += 1;
        }
    }
    let (best, n) = counts.iter().enumerate().max_by_key(|(_, &n)| n).map(|(i, &n)| (i, n)).unwrap_or((4, 0));
    if n == 0 {
        4
    } else {
        best as u32
    }
}

pub fn swing(env: &[f32], fps: f32, beats_frames: &[f32]) -> Option<f32> {
    if beats_frames.len() < 8 {
        return None;
    }
    const BINS: usize = 192;
    let mut prof = vec![0f32; BINS];
    let mut count = 0;
    for w in beats_frames.windows(2) {
        let (a, b) = (w[0], w[1]);
        let len = b - a;
        if !(len > fps * 0.2 && len < fps * 2.0) {
            continue;
        }
        for (k, p) in prof.iter_mut().enumerate() {
            *p += lerp_at(env, a + len * k as f32 / BINS as f32);
        }
        count += 1;
    }
    if count < 6 {
        return None;
    }
    let sm: Vec<f32> = (0..BINS).map(|k| (prof[(k + BINS - 1) % BINS] + 2.0 * prof[k] + prof[(k + 1) % BINS]) / 4.0).collect();
    let base = median(&sm);
    let g = |j: i64| sm[j.rem_euclid(BINS as i64) as usize];
    let peak_in = |lo: f32, hi: f32| -> Option<(f32, f32)> {
        let a = (lo * BINS as f32).floor() as i64;
        let z = (hi * BINS as f32).ceil() as i64;
        let mut best: Option<(i64, f32)> = None;
        for k in a + 1..z {
            let v = g(k);
            if v >= g(k - 1) && v > g(k + 1) && best.map(|b| v > b.1).unwrap_or(true) {
                best = Some((k, v));
            }
        }
        best.map(|(k, v)| ((k as f32 + parabolic(g(k - 1), v, g(k + 1))) / BINS as f32, v))
    };
    let (Some((e0, h0)), Some((e2, h2))) = (peak_in(-0.07, 0.07), peak_in(0.43, 0.57)) else {
        return None;
    };
    let even_h = ((h0 - base) + (h2 - base)) * 0.5;
    if even_h <= 0.0 {
        return None;
    }
    let o1 = peak_in(0.18, 0.42).filter(|p| p.1 - base >= 0.08 * even_h);
    let o3 = peak_in(0.68, 0.92).filter(|p| p.1 - base >= 0.08 * even_h);
    let odd_h = [o1, o3].iter().flatten().map(|p| p.1 - base).fold(0f32, f32::max);
    let t32 = [peak_in(0.08, 0.17), peak_in(0.58, 0.67)].iter().flatten().map(|p| p.1 - base).fold(0f32, f32::max);
    if odd_h > 0.0 && t32 >= 0.5 * odd_h {
        return None;
    }
    let mut num = 0.0;
    let mut den = 0.0;
    if let Some((o, h)) = o1 {
        num += ((o - e0) * 4.0 - 1.0) * (h - base);
        den += h - base;
    }
    if let Some((o, h)) = o3 {
        num += ((o - e2) * 4.0 - 1.0) * (h - base);
        den += h - base;
    }
    if den <= 0.0 {
        return None;
    }
    let d = num / den;
    let s = (d / 0.5).clamp(0.0, 1.0);
    Some(if s < 0.03 { 0.0 } else { s })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bpm_fit_handles_missing_beats() {
        let t: Vec<f32> = (0..40).filter(|i| i % 7 != 3).map(|i| 0.25 + i as f32 * 0.5).collect();
        let b = bpm_from_beats(&t).unwrap();
        assert!((b - 120.0).abs() < 0.01, "{b}");
    }

    #[test]
    fn beats_per_bar_counts() {
        let beats: Vec<f32> = (0..24).map(|i| i as f32 * 0.5).collect();
        let down: Vec<f32> = (0..8).map(|i| i as f32 * 1.5).collect();
        assert_eq!(beats_per_bar(&beats, &down), 3);
    }

    #[test]
    fn smoothing_removes_jitter_and_keeps_tempo_changes() {
        let jitter = [0.02f32, -0.03, 0.01, 0.025, -0.02, 0.0, -0.015, 0.03];
        let t: Vec<f32> = (0..40).map(|i| i as f32 * 0.5 + jitter[i % 8]).collect();
        let s = smooth_beats(&t, 4);
        for (i, v) in s.iter().enumerate().skip(4).take(32) {
            assert!((v - i as f32 * 0.5).abs() < 0.012, "{i}: {v}");
        }
        let g = regularize_beats(&[0.0, 0.5, 1.5, 2.0, 4.0, 4.5], 0.5, &[], 10.0);
        assert_eq!(g.len(), 10, "{g:?}");
    }
}
