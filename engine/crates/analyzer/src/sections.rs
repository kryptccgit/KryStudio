use crate::features::{mean, std_dev};
use crate::key::{cosine, Chroma};

pub struct SegInput<'a> {
    pub grid: &'a [f32],
    pub bars: &'a [f32],
    pub frames_per_bar: usize,
    pub chroma: &'a Chroma,
    pub band_db: &'a [Vec<f32>],
    pub band_fps: f32,
    pub duration: f32,
}

pub fn segment(inp: &SegInput) -> Vec<(f32, f32, String)> {
    let g = inp.grid;
    let dur = inp.duration;
    let whole = || vec![(0.0, dur, "A".to_string())];
    if g.len() < 3 * inp.frames_per_bar * 4 || dur < 20.0 {
        return whole();
    }
    let n = g.len() - 1;
    let nbands = inp.band_db.first().map(|r| r.len()).unwrap_or(0);
    let mut chroma_f: Vec<[f32; 12]> = Vec::with_capacity(n);
    let mut timbre: Vec<Vec<f32>> = Vec::with_capacity(n);
    for i in 0..n {
        chroma_f.push(inp.chroma.mean_between(g[i], g[i + 1]));
        let a = ((g[i] * inp.band_fps) as usize).min(inp.band_db.len().saturating_sub(1));
        let b = ((g[i + 1] * inp.band_fps).ceil() as usize).min(inp.band_db.len()).max(a + 1);
        let mut t = vec![0f32; nbands];
        for row in &inp.band_db[a..b] {
            for (k, v) in row.iter().enumerate() {
                t[k] += v;
            }
        }
        for v in t.iter_mut() {
            *v /= (b - a) as f32;
        }
        timbre.push(t);
    }
    for k in 0..nbands {
        let col: Vec<f32> = timbre.iter().map(|t| t[k]).collect();
        let (m, s) = (mean(&col), std_dev(&col).max(1e-3));
        for t in timbre.iter_mut() {
            t[k] = (t[k] - m) / s;
        }
    }
    let smooth = |i: usize| -> (Vec<f32>, Vec<f32>) {
        let a = i.saturating_sub(1);
        let b = (i + 2).min(n);
        let mut c = vec![0f32; 12];
        let mut t = vec![0f32; nbands];
        for j in a..b {
            for k in 0..12 {
                c[k] += chroma_f[j][k];
            }
            for k in 0..nbands {
                t[k] += timbre[j][k];
            }
        }
        (c, t)
    };
    let feats: Vec<(Vec<f32>, Vec<f32>)> = (0..n).map(smooth).collect();
    let mut ssm = vec![0f32; n * n];
    for i in 0..n {
        for j in i..n {
            let s = 0.5 * cosine(&feats[i].0, &feats[j].0) + 0.5 * (0.5 + 0.5 * cosine(&feats[i].1, &feats[j].1));
            ssm[i * n + j] = s;
            ssm[j * n + i] = s;
        }
    }
    let k = (inp.frames_per_bar * 4).min(n / 4).max(2) as i64;
    let mut nov = vec![0f32; n];
    for (i, nv) in nov.iter_mut().enumerate() {
        let mut s = 0.0;
        for u in -k..k {
            for v in -k..k {
                let (a, b) = (i as i64 + u, i as i64 + v);
                if a < 0 || b < 0 || a >= n as i64 || b >= n as i64 {
                    continue;
                }
                let sign = if (u < 0) == (v < 0) { 1.0 } else { -1.0 };
                let gu = (u as f32 + 0.5) / k as f32;
                let gv = (v as f32 + 0.5) / k as f32;
                let w = (-2.0 * (gu * gu + gv * gv)).exp();
                s += sign * w * ssm[a as usize * n + b as usize];
            }
        }
        *nv = s.max(0.0);
    }
    let thr = mean(&nov) + 0.5 * std_dev(&nov);
    let min_dist = (inp.frames_per_bar * 4).max(4);
    let mut cand: Vec<usize> = (1..n - 1)
        .filter(|&i| {
            let a = i.saturating_sub(min_dist / 2);
            let b = (i + min_dist / 2 + 1).min(n);
            nov[i] > thr && (a..b).all(|j| nov[j] <= nov[i])
        })
        .collect();
    cand.sort_by(|&a, &b| nov[b].total_cmp(&nov[a]));
    let mut bounds: Vec<usize> = Vec::new();
    for c in cand {
        if c < min_dist || n - c < min_dist {
            continue;
        }
        if bounds.iter().all(|&b| (b as i64 - c as i64).unsigned_abs() as usize >= min_dist) {
            bounds.push(c);
        }
    }
    bounds.sort_unstable();
    let bar_len = if inp.bars.len() >= 2 { (inp.bars[inp.bars.len() - 1] - inp.bars[0]) / (inp.bars.len() - 1) as f32 } else { 0.0 };
    let mut times: Vec<f32> = bounds
        .iter()
        .map(|&b| {
            let t = g[b];
            if bar_len > 0.0 {
                if let Some(&bt) = inp.bars.iter().min_by(|x, y| (*x - t).abs().total_cmp(&(*y - t).abs())) {
                    if (bt - t).abs() <= bar_len * 0.5 {
                        return bt;
                    }
                }
            }
            t
        })
        .collect();
    times.dedup_by(|a, b| (*a - *b).abs() < 1e-3);
    let mut edges = vec![0.0f32];
    edges.extend(times.into_iter().filter(|&t| t > 1.0 && t < dur - 1.0));
    edges.push(dur);
    let frame_of = |t: f32| -> usize { g.partition_point(|&x| x <= t).saturating_sub(1).min(n - 1) };
    let segs: Vec<(usize, usize)> = edges.windows(2).map(|w| (frame_of(w[0]), frame_of(w[1] - 1e-3) + 1)).collect();
    let block_sim = |a: (usize, usize), b: (usize, usize)| -> f32 {
        let mut s = 0.0;
        let mut c = 0;
        for i in a.0..a.1.min(n) {
            for j in b.0..b.1.min(n) {
                s += ssm[i * n + j];
                c += 1;
            }
        }
        if c == 0 {
            0.0
        } else {
            s / c as f32
        }
    };
    let self_sim: Vec<f32> = segs.iter().map(|&s| block_sim(s, s)).collect();
    let mut labels: Vec<usize> = Vec::with_capacity(segs.len());
    let mut next = 0usize;
    for i in 0..segs.len() {
        let mut best: Option<(usize, f32)> = None;
        for j in 0..i {
            let s = block_sim(segs[i], segs[j]);
            let rel = s / self_sim[i].min(self_sim[j]).max(1e-6);
            if best.map(|b| rel > b.1).unwrap_or(true) {
                best = Some((j, rel));
            }
        }
        match best {
            Some((j, rel)) if rel >= 0.93 => labels.push(labels[j]),
            _ => {
                labels.push(next);
                next += 1;
            }
        }
    }
    edges.windows(2).zip(labels).map(|(w, l)| (w[0], w[1], label_name(l))).collect()
}

pub fn label_name(i: usize) -> String {
    let letters = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if i < 26 {
        (letters[i] as char).to_string()
    } else {
        format!("{}{}", letters[(i / 26 - 1) % 26] as char, letters[i % 26] as char)
    }
}
