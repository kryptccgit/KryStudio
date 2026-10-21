use crate::key::{self, Chroma};
use crate::protocol::{Beats, ChordQuality, ChordSpan};

struct Template {
    quality: ChordQuality,
    intervals: &'static [usize],
    prior: f32,
}

const TEMPLATES: [Template; 9] = [
    Template { quality: ChordQuality::Maj, intervals: &[0, 4, 7], prior: 0.0 },
    Template { quality: ChordQuality::Min, intervals: &[0, 3, 7], prior: 0.0 },
    Template { quality: ChordQuality::Dom7, intervals: &[0, 4, 7, 10], prior: -0.02 },
    Template { quality: ChordQuality::Maj7, intervals: &[0, 4, 7, 11], prior: -0.02 },
    Template { quality: ChordQuality::Min7, intervals: &[0, 3, 7, 10], prior: -0.02 },
    Template { quality: ChordQuality::Dim, intervals: &[0, 3, 6], prior: -0.05 },
    Template { quality: ChordQuality::Sus, intervals: &[0, 5, 7], prior: -0.05 },
    Template { quality: ChordQuality::Sus, intervals: &[0, 2, 7], prior: -0.05 },
    Template { quality: ChordQuality::Power, intervals: &[0, 7], prior: -0.04 },
];

const N_STATES: usize = 12 * TEMPLATES.len();

const KEY_BONUS: f32 = 0.04;
const BASS_WEIGHT: f32 = 0.5;
const BASS_OTHER_TONE: f32 = 0.4;
const KAPPA: f32 = 12.0;
const COST_DOWNBEAT: f32 = 0.8;
const COST_HALF_BAR: f32 = 1.6;
const COST_BEAT: f32 = 2.6;
const COST_FREE: f32 = 1.6;
const MIN_REL_ENERGY: f32 = 0.03;
const MIN_FIT: f32 = 0.6;
const MIN_TREBLE_SHARE: f32 = 0.15;
const MIN_TONALITY: f32 = 0.15;
const SMEAR_RATIO: f32 = 0.5;
const FREE_STEP: f32 = 0.5;

struct Grid {
    bounds: Vec<f32>,
    cost: Vec<f32>,
    period: f32,
}

fn median(mut v: Vec<f32>) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

fn grid(beats: Option<&Beats>, duration: f32) -> Grid {
    let free = || {
        let steps = (duration / FREE_STEP).round().max(1.0) as usize;
        let mut bounds: Vec<f32> = (0..steps).map(|i| i as f32 * FREE_STEP).collect();
        bounds.push(duration);
        let cost = vec![COST_FREE; steps];
        Grid { bounds, cost, period: FREE_STEP }
    };
    let Some(b) = beats.filter(|b| b.times.len() >= 4) else {
        return free();
    };
    let period = median(b.times.windows(2).map(|w| w[1] - w[0]).collect());
    if period.is_nan() || period <= 0.1 {
        return free();
    }
    let bpb = b.beats_per_bar.max(1) as usize;
    let mut pts: Vec<(f32, f32)> = Vec::with_capacity(b.times.len() + 16);
    let mut since_down: Option<usize> = None;
    for &t in &b.times {
        let is_down = b.downbeats.iter().any(|&d| (d - t).abs() < 0.002);
        since_down = if is_down { Some(0) } else { since_down.map(|k| k + 1) };
        let cost = match since_down {
            Some(0) => COST_DOWNBEAT,
            Some(k) if bpb >= 4 && bpb.is_multiple_of(2) && k % bpb == bpb / 2 => COST_HALF_BAR,
            Some(_) => COST_BEAT,
            None => COST_FREE,
        };
        pts.push((t, cost));
    }
    let mut filled: Vec<(f32, f32)> = Vec::with_capacity(pts.len() + 16);
    for (i, &p) in pts.iter().enumerate() {
        if i > 0 {
            let prev = pts[i - 1].0;
            let gap = p.0 - prev;
            if gap > 1.5 * period {
                let k = (gap / period).round().max(2.0) as usize;
                for j in 1..k {
                    filled.push((prev + gap * j as f32 / k as f32, COST_FREE));
                }
            }
        }
        filled.push(p);
    }
    let mut head: Vec<(f32, f32)> = Vec::new();
    let mut t = filled[0].0 - period;
    while t > 0.3 * period {
        head.push((t, COST_FREE));
        t -= period;
    }
    head.reverse();
    let mut all = head;
    all.extend(filled);
    let mut t = all.last().unwrap().0 + period;
    while t < duration - 0.3 * period {
        all.push((t, COST_FREE));
        t += period;
    }
    if all[0].0 <= 0.3 * period {
        all[0].0 = 0.0;
    } else {
        all.insert(0, (0.0, COST_FREE));
    }
    all.retain(|p| p.0 < duration);
    let mut bounds: Vec<f32> = all.iter().map(|p| p.0).collect();
    let cost: Vec<f32> = all.iter().map(|p| p.1).collect();
    bounds.push(duration);
    Grid { bounds, cost, period }
}

struct Segment {
    t0: f32,
    t1: f32,
    treble: [f32; 12],
    bass: [f32; 12],
    low: [f32; 12],
    tonality: f32,
}

fn segment(ch: &Chroma, t0: f32, t1: f32) -> Segment {
    let n = ch.treble.len();
    let mut treble = [0f32; 12];
    let mut bass = [0f32; 12];
    let mut low = [0f32; 12];
    if n == 0 {
        return Segment { t0, t1, treble, bass, low, tonality: 0.0 };
    }
    let a = ((t0 * ch.fps).ceil().max(0.0) as usize).min(n);
    let b = ((t1 * ch.fps).ceil().max(0.0) as usize).min(n);
    let (a, b) = if b > a { (a, b) } else {
        let c = (((t0 + t1) * 0.5 * ch.fps).round().max(0.0) as usize).min(n - 1);
        (c, c + 1)
    };
    let mut tonality = 0f32;
    for f in a..b {
        let fb = bass_frame(&ch.bass[f]);
        for k in 0..12 {
            treble[k] += ch.treble[f][k];
            bass[k] += fb[k];
            low[k] += ch.low[f][k];
        }
        tonality += ch.tonality.get(f).copied().unwrap_or(0.0);
    }
    let inv = 1.0 / (b - a) as f32;
    for v in treble.iter_mut().chain(bass.iter_mut()).chain(low.iter_mut()) {
        *v *= inv;
    }
    Segment { t0, t1, treble, bass, low, tonality: tonality * inv }
}

fn bass_frame(b: &[f32; 12]) -> [f32; 12] {
    let mut out = *b;
    let mut idx: [usize; 12] = std::array::from_fn(|k| k);
    idx.sort_by(|&x, &y| b[y].total_cmp(&b[x]));
    let (p, q) = (idx[0], idx[1]);
    let adjacent = (p + 1) % 12 == q || (q + 1) % 12 == p;
    if b[p] > 0.0 && adjacent && b[q] >= SMEAR_RATIO * b[p] {
        out[p] = 0.0;
        out[q] = 0.0;
    }
    out
}

fn bass_evidence(segs: &[Segment]) -> Vec<[f32; 12]> {
    let tot: Vec<f32> = segs.iter().map(|s| s.bass.iter().sum::<f32>()).collect();
    let mut sorted = tot.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let p90 = sorted.get(((sorted.len() as f32 - 1.0) * 0.9).round() as usize).copied().unwrap_or(0.0);
    let active: Vec<&Segment> = segs.iter().zip(&tot).filter(|(_, &t)| t > 0.1 * p90 && t > 0.0).map(|(s, _)| s).collect();
    let mut base = [0f32; 12];
    for (k, b) in base.iter_mut().enumerate() {
        *b = median(active.iter().map(|s| s.bass[k]).collect());
    }
    segs.iter()
        .map(|s| {
            let b: [f32; 12] = std::array::from_fn(|k| (s.bass[k] - base[k]).max(0.0));
            let (eb, el) = (b.iter().sum::<f32>(), s.low.iter().sum::<f32>());
            let alpha = if eb <= 1e-12 { 0.0 } else if el <= 1e-12 { 1.0 } else { ((eb / el - 0.25) / 0.5).clamp(0.0, 1.0) };
            std::array::from_fn(|k| {
                let bk = if eb > 1e-12 { b[k] / eb } else { 0.0 };
                let lk = if el > 1e-12 { s.low[k] / el } else { 0.0 };
                alpha * bk + (1.0 - alpha) * lk
            })
        })
        .collect()
}

fn scale_mask(tonic: usize, minor: bool) -> u16 {
    let steps: &[usize] = if minor { &[0, 2, 3, 5, 7, 8, 10, 11] } else { &[0, 2, 4, 5, 7, 9, 10, 11] };
    steps.iter().fold(0u16, |m, &s| m | 1 << ((tonic + s) % 12))
}

fn scores(seg: &Segment, lw: &[f32; 12], scale: u16) -> Vec<(f32, f32)> {
    let mut tn = seg.treble;
    key::normalize(&mut tn);
    let mut out = Vec::with_capacity(N_STATES);
    for root in 0..12 {
        for tpl in TEMPLATES.iter() {
            let mut fit = 0f32;
            let mut bass = 0f32;
            for (j, &iv) in tpl.intervals.iter().enumerate() {
                let pc = (root + iv) % 12;
                fit += tn[pc];
                bass += if j == 0 { lw[pc] } else { BASS_OTHER_TONE * lw[pc] };
            }
            let cos = fit / (tpl.intervals.len() as f32).sqrt();
            let diatonic = scale != 0 && tpl.intervals.iter().take(3).all(|&iv| scale & (1 << ((root + iv) % 12)) != 0);
            let key_bonus = if diatonic { KEY_BONUS } else { 0.0 };
            out.push((cos + BASS_WEIGHT * bass + tpl.prior + key_bonus, cos));
        }
    }
    out
}

fn state(s: usize) -> (u8, ChordQuality) {
    ((s / TEMPLATES.len()) as u8, TEMPLATES[s % TEMPLATES.len()].quality)
}

fn viterbi(emis: &[Vec<f32>], cost: &[f32]) -> Vec<usize> {
    let n = emis.len();
    if n == 0 {
        return Vec::new();
    }
    let mut delta = emis[0].clone();
    let mut back: Vec<Vec<u16>> = Vec::with_capacity(n);
    back.push((0..N_STATES as u16).collect());
    for i in 1..n {
        let (best, arg) = delta.iter().enumerate().fold((f32::MIN, 0usize), |acc, (s, &v)| if v > acc.0 { (v, s) } else { acc });
        let change = best - cost[i];
        let mut bk = vec![0u16; N_STATES];
        let mut next = vec![0f32; N_STATES];
        for s in 0..N_STATES {
            let (v, from) = if delta[s] >= change { (delta[s], s) } else { (change, arg) };
            next[s] = v + emis[i][s];
            bk[s] = from as u16;
        }
        delta = next;
        back.push(bk);
    }
    let mut s = delta.iter().enumerate().fold((f32::MIN, 0usize), |acc, (s, &v)| if v > acc.0 { (v, s) } else { acc }).1;
    let mut path = vec![0usize; n];
    for i in (0..n).rev() {
        path[i] = s;
        s = back[i][s] as usize;
    }
    path
}

pub fn estimate(ch: &Chroma, beats: Option<&Beats>, key: Option<(usize, bool)>, duration: f32) -> Vec<ChordSpan> {
    estimate_full(ch, beats, key, duration).spans
}

pub struct ChordEstimate {
    pub spans: Vec<ChordSpan>,
    pub bass_share: [f32; 12],
}

pub fn estimate_full(ch: &Chroma, beats: Option<&Beats>, key: Option<(usize, bool)>, duration: f32) -> ChordEstimate {
    let none = || ChordEstimate { spans: Vec::new(), bass_share: [0.0; 12] };
    if ch.treble.is_empty() || duration.is_nan() || duration <= 0.0 {
        return none();
    }
    if !key::is_tonal(&key::total_chroma(ch)) || ch.treble_share < MIN_TREBLE_SHARE {
        return none();
    }
    let g = grid(beats, duration);
    let segs: Vec<Segment> = g.bounds.windows(2).map(|w| segment(ch, w[0], w[1])).collect();
    let energy: Vec<f32> = segs.iter().map(|s| s.treble.iter().sum::<f32>()).collect();
    let mut nz: Vec<f32> = energy.iter().copied().filter(|&e| e > 0.0).collect();
    if nz.is_empty() {
        return none();
    }
    nz.sort_by(|a, b| a.total_cmp(b));
    let e_ref = nz[((nz.len() - 1) as f32 * 0.75).round() as usize];
    let ev = bass_evidence(&segs);
    let scale = key.map(|(t, m)| scale_mask(t, m)).unwrap_or(0);
    let sc: Vec<Vec<(f32, f32)>> = segs.iter().zip(&ev).map(|(s, e)| scores(s, e, scale)).collect();
    let tonal: Vec<bool> = (0..segs.len())
        .map(|i| {
            let best_cos = sc[i].iter().map(|s| s.1).fold(0f32, f32::max);
            energy[i] >= MIN_REL_ENERGY * e_ref && best_cos >= MIN_FIT && segs[i].tonality >= MIN_TONALITY
        })
        .collect();
    let debug = std::env::var_os("KRYPT_CHORD_DEBUG").is_some();
    if debug {
        let mut t: Vec<f32> = segs.iter().map(|s| s.tonality).collect();
        t.sort_by(|a, b| a.total_cmp(b));
        eprintln!("chord debug: tonality p10 {:.3} p50 {:.3} p90 {:.3}, treble share {:.2}, {} of {} segments tonal", t[t.len() / 10], t[t.len() / 2], t[t.len() * 9 / 10], ch.treble_share, tonal.iter().filter(|&&x| x).count(), segs.len());
        for (k, sg) in segs.iter().enumerate().filter(|(k, _)| !tonal[*k]) {
            eprintln!("chord debug: {:7.2}-{:7.2} not tonal: energy {:.2} of ref, best fit {:.2}, tonality {:.2}", sg.t0, sg.t1, energy[k] / e_ref, sc[k].iter().map(|s| s.1).fold(0f32, f32::max), sg.tonality);
        }
    }
    let mut bass_share = [0f32; 12];
    for (k, sg) in segs.iter().enumerate().filter(|(k, _)| tonal[*k]) {
        for (pc, b) in bass_share.iter_mut().enumerate() {
            *b += ev[k][pc] * (sg.t1 - sg.t0);
        }
    }
    let bsum: f32 = bass_share.iter().sum();
    if bsum > 1e-9 {
        for b in bass_share.iter_mut() {
            *b /= bsum;
        }
    }
    let mut spans: Vec<ChordSpan> = Vec::new();
    let mut i = 0;
    while i < segs.len() {
        if !tonal[i] {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < segs.len() && tonal[j] {
            j += 1;
        }
        let emis: Vec<Vec<f32>> = (i..j)
            .map(|k| {
                let w = ((segs[k].t1 - segs[k].t0) / g.period).clamp(0.5, 2.0);
                sc[k].iter().map(|s| KAPPA * w * s.0).collect()
            })
            .collect();
        let path = viterbi(&emis, &g.cost[i..j]);
        let conf: Vec<f32> = path
            .iter()
            .enumerate()
            .map(|(o, &s)| {
                let row = &sc[i + o];
                let m = row.iter().map(|r| r.0).fold(f32::MIN, f32::max);
                let z: f32 = row.iter().map(|r| (KAPPA * (r.0 - m)).exp()).sum();
                let p = (KAPPA * (row[s].0 - m)).exp() / z;
                let fit = ((row[s].1 - 0.5) / 0.4).clamp(0.0, 1.0);
                p.sqrt() * fit
            })
            .collect();
        if debug {
            for (o, &s) in path.iter().enumerate() {
                let k = i + o;
                let (r, q) = state(s);
                let mut top: Vec<(usize, f32)> = sc[k].iter().map(|x| x.0).enumerate().collect();
                top.sort_by(|a, b| b.1.total_cmp(&a.1));
                let tops: Vec<String> = top.iter().take(3).map(|&(s2, v)| {
                    let (r2, q2) = state(s2);
                    format!("{}{} {:.2}", NOTE[r2 as usize], q2.as_str(), v)
                }).collect();
                let bass: Vec<String> = ev[k].iter().enumerate().filter(|(_, &v)| v >= 0.15).map(|(p, v)| format!("{}{:.0}", NOTE[p], v * 100.0)).collect();
                eprintln!("chord debug: {:7.2}-{:7.2} {}{} conf {:.2} ton {:.2} bass [{}] | {}", segs[k].t0, segs[k].t1, NOTE[r as usize], q.as_str(), conf[o], segs[k].tonality, bass.join(" "), tops.join(", "));
            }
        }
        let mut a = 0;
        while a < path.len() {
            let mut b = a + 1;
            while b < path.len() && state(path[b]) == state(path[a]) {
                b += 1;
            }
            let (root, quality) = state(path[a]);
            let (t0, t1) = (segs[i + a].t0, segs[i + b - 1].t1);
            let wsum: f32 = (a..b).map(|k| segs[i + k].t1 - segs[i + k].t0).sum::<f32>().max(1e-9);
            let c: f32 = (a..b).map(|k| conf[k] * (segs[i + k].t1 - segs[i + k].t0)).sum::<f32>() / wsum;
            spans.push(ChordSpan { start_sec: crate::analyze::ms(t0), end_sec: crate::analyze::ms(t1), root, quality, confidence: (c.clamp(0.0, 1.0) * 100.0).round() / 100.0 });
            a = b;
        }
        i = j;
    }
    ChordEstimate { spans, bass_share }
}

pub const NOTE: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

#[cfg(test)]
mod tests {
    use super::*;

    fn chroma_of(segments: &[(&[usize], usize, f32)], fps: f32) -> Chroma {
        let mut treble = Vec::new();
        let mut low = Vec::new();
        for &(pcs, bass, secs) in segments {
            for _ in 0..(secs * fps).round() as usize {
                let mut t = [0f32; 12];
                for &p in pcs {
                    t[p] += 1.0;
                }
                let mut l = [0f32; 12];
                l[bass] = 1.0;
                treble.push(t);
                low.push(l);
            }
        }
        let frames: Vec<[f32; 12]> = treble.iter().zip(&low).map(|(t, l)| std::array::from_fn(|k| t[k] + 0.6 * l[k])).collect();
        let tonality = vec![0.8; treble.len()];
        Chroma { fps, frames, treble, bass: low.clone(), low, tonality, tuning: 0.0, treble_share: 0.8 }
    }

    fn label(s: &ChordSpan) -> String {
        format!("{}{}", NOTE[s.root as usize], s.quality.as_str())
    }

    #[test]
    fn templates_and_bass_pick_the_root() {
        let ch = chroma_of(&[(&[5, 8, 0, 3, 7], 5, 2.0), (&[3, 7, 10, 2, 5], 3, 2.0), (&[0, 4, 7], 0, 2.0), (&[9, 0, 4], 9, 2.0)], 10.0);
        let spans = estimate(&ch, None, None, 8.0);
        let labels: Vec<String> = spans.iter().map(label).collect();
        assert_eq!(labels, vec!["Fm7", "D#maj7", "Cmaj", "Amin"], "{spans:?}");
        assert!((spans[1].start_sec - 2.0).abs() < 0.51 && (spans[3].end_sec - 8.0).abs() < 1e-3, "{spans:?}");
    }

    #[test]
    fn viterbi_ignores_one_off_flicker() {
        let ch = chroma_of(&[(&[0, 4, 7], 0, 2.0), (&[4, 7, 11], 0, 0.5), (&[0, 4, 7], 0, 1.5)], 10.0);
        let spans = estimate(&ch, None, None, 4.0);
        assert_eq!(spans.len(), 1, "{spans:?}");
        assert_eq!(label(&spans[0]), "Cmaj");
    }

    #[test]
    fn grid_fills_gaps_and_ends() {
        let b = Beats { times: vec![1.0, 1.5, 2.0, 2.5, 4.0, 4.5], downbeats: vec![1.0, 4.0], beats_per_bar: 4 };
        let g = grid(Some(&b), 6.0);
        assert_eq!(g.bounds[0], 0.0);
        assert_eq!(*g.bounds.last().unwrap(), 6.0);
        let want = [0.0f32, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0];
        assert_eq!(g.bounds.len(), want.len(), "{:?}", g.bounds);
        for (a, b) in g.bounds.iter().zip(want) {
            assert!((a - b).abs() < 1e-4, "{:?}", g.bounds);
        }
        assert_eq!(g.cost[2], COST_DOWNBEAT);
        assert_eq!(g.cost[4], COST_HALF_BAR);
        assert_eq!(g.cost[3], COST_BEAT);
    }
}
