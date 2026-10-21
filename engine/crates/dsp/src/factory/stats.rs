//! Objective measurements of every written sample (we cannot listen, so we
//! measure): length, levels, spectral centroid, decay time, DC, and the
//! fundamental of tonal one-shots. Printed as a per-kind table.

use super::synth::{Chans, SR};
use crate::analysis::analyze;
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct SampleStat {
    pub rel: String,
    pub kind: String,
    pub len_s: f32,
    pub channels: usize,
    /// Sample peak (dBFS).
    pub peak_db: f32,
    pub true_peak_db: f32,
    pub rms_db: f32,
    /// RMS of the first 100 ms (the hit itself, without the tail).
    pub rms100_db: f32,
    /// Band levels (dB): sub <60, low 60-250, lowMid 250-500, mid 500-2k, highMid 2-6k, high 6-20k.
    pub bands: [f32; 6],
    pub centroid_hz: f32,
    /// Time from the loudest 5 ms window until the level is 20 dB below it.
    pub t20_ms: f32,
    /// Where the loudest 5 ms window sits, 0..1 of the length (risers ≈ 1).
    pub peak_pos: f32,
    /// |mean| / peak.
    pub dc: f32,
    /// Measured fundamental for tonal samples.
    pub f0_hz: Option<f32>,
    pub bytes: u64,
}

fn env5(x: &[f32]) -> Vec<f32> {
    x.chunks(240).map(|c| c.iter().fold(0.0f32, |m, v| m.max(v.abs()))).collect()
}

/// Fundamental by normalised autocorrelation over `win` (30-1000 Hz).
pub(crate) fn f0_of(x: &[f32]) -> Option<f32> {
    if x.len() < 4800 {
        return None;
    }
    let (lo, hi) = ((SR / 1000.0) as usize, (SR / 30.0) as usize);
    let n = x.len() - hi;
    let e0: f64 = x[..n].iter().map(|v| (*v as f64).powi(2)).sum();
    if e0 <= 1e-12 {
        return None;
    }
    let r = |lag: usize| -> f64 {
        let mut s = 0.0f64;
        let mut e1 = 0.0f64;
        for i in 0..n {
            s += x[i] as f64 * x[i + lag] as f64;
            e1 += (x[i + lag] as f64).powi(2);
        }
        s / (e0 * e1).sqrt().max(1e-12)
    };
    let vals: Vec<f64> = (lo..=hi).map(r).collect();
    let best = vals.iter().cloned().fold(f64::MIN, f64::max);
    // first lag that gets within 3% of the best (prefers the true period over multiples)
    let k = vals.iter().position(|v| *v >= best * 0.97)?;
    // walk to the local maximum
    let mut k = k;
    while k + 1 < vals.len() && vals[k + 1] > vals[k] {
        k += 1;
    }
    let lag = (lo + k) as f64;
    let (a, b, c) = (
        if k > 0 { vals[k - 1] } else { vals[k] },
        vals[k],
        if k + 1 < vals.len() { vals[k + 1] } else { vals[k] },
    );
    let den = a - 2.0 * b + c;
    let off = if den.abs() > 1e-12 { 0.5 * (a - c) / den } else { 0.0 };
    Some((SR as f64 / (lag + off)) as f32)
}

pub(crate) fn measure(rel: &str, kind: &str, ch: &Chans, root: Option<u8>, bytes: u64) -> SampleStat {
    let l = &ch[0];
    let r = ch.get(1).unwrap_or(&ch[0]);
    let a = analyze(l, r, SR);
    let mono: Vec<f32> = if ch.len() == 2 { l.iter().zip(r).map(|(a, b)| 0.5 * (a + b)).collect() } else { l.clone() };
    let env = env5(&mono);
    let (ip, pk) = env.iter().enumerate().fold((0, 0.0f32), |(bi, bv), (i, v)| if *v > bv { (i, *v) } else { (bi, bv) });
    let t20 = env[ip..].iter().position(|v| *v < pk * 0.1).map(|k| k as f32 * 5.0).unwrap_or((env.len() - ip) as f32 * 5.0);
    let peak = ch.iter().flat_map(|c| c.iter()).fold(0.0f32, |m, v| m.max(v.abs()));
    let mean = mono.iter().map(|v| *v as f64).sum::<f64>() / mono.len().max(1) as f64;
    let head = &mono[..mono.len().min((0.1 * SR) as usize)];
    let rms100 = (head.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / head.len().max(1) as f64).sqrt() as f32;
    let f0 = root.and_then(|_| {
        // skip the attack / pitch sweep, measure the body
        let s = (0.12 * SR) as usize;
        let e = (s + (0.25 * SR) as usize).min(mono.len());
        if e > s + 4800 {
            f0_of(&mono[s..e])
        } else {
            None
        }
    });
    SampleStat {
        rel: rel.to_string(),
        kind: kind.to_string(),
        len_s: l.len() as f32 / SR,
        channels: ch.len(),
        peak_db: 20.0 * peak.max(1e-9).log10(),
        true_peak_db: a.true_peak_db,
        rms_db: a.rms_db,
        rms100_db: 20.0 * rms100.max(1e-9).log10(),
        bands: [a.bands.sub, a.bands.low, a.bands.low_mid, a.bands.mid, a.bands.high_mid, a.bands.high],
        centroid_hz: a.spectral_centroid_hz,
        t20_ms: t20,
        peak_pos: ip as f32 / env.len().max(1) as f32,
        dc: (mean.abs() as f32) / peak.max(1e-9),
        f0_hz: f0,
        bytes,
    }
}

/// Per-kind summary table (and, with `detail`, one line per file).
pub fn table(stats: &[SampleStat], detail: bool) -> String {
    let mut by: BTreeMap<&str, Vec<&SampleStat>> = BTreeMap::new();
    for s in stats {
        by.entry(s.kind.as_str()).or_default().push(s);
    }
    let mut o = String::new();
    o.push_str(&format!(
        "{:<15} {:>3} {:>7} {:>7} {:>22} {:>8} {:>7} {:>7} {:>6} {:>6}\n",
        "kind", "n", "len s", "MB", "centroid min/avg/max", "t20 ms", "rms dB", "rms100", "maxTP", "peak@"
    ));
    for (k, v) in &by {
        let n = v.len() as f32;
        let avg = |f: &dyn Fn(&SampleStat) -> f32| v.iter().map(|s| f(s)).sum::<f32>() / n;
        let cmin = v.iter().map(|s| s.centroid_hz).fold(f32::MAX, f32::min);
        let cmax = v.iter().map(|s| s.centroid_hz).fold(0.0, f32::max);
        let mb = v.iter().map(|s| s.bytes).sum::<u64>() as f32 / 1_048_576.0;
        o.push_str(&format!(
            "{:<15} {:>3} {:>7.2} {:>7.2} {:>6.0}/{:>6.0}/{:>6.0}   {:>8.0} {:>7.1} {:>7.1} {:>6.2} {:>6.2}\n",
            k,
            v.len(),
            avg(&|s| s.len_s),
            mb,
            cmin,
            avg(&|s| s.centroid_hz),
            cmax,
            avg(&|s| s.t20_ms),
            avg(&|s| s.rms_db),
            avg(&|s| s.rms100_db),
            v.iter().map(|s| s.true_peak_db).fold(f32::MIN, f32::max),
            avg(&|s| s.peak_pos),
        ));
    }
    let tonal: Vec<&SampleStat> = stats.iter().filter(|s| s.f0_hz.is_some()).collect();
    if !tonal.is_empty() {
        o.push_str("tonal f0: ");
        let parts: Vec<String> = tonal
            .iter()
            .map(|s| format!("{} {:.1} Hz", s.rel.rsplit('/').next().unwrap_or(&s.rel), s.f0_hz.unwrap_or(0.0)))
            .collect();
        o.push_str(&parts.join(", "));
        o.push('\n');
    }
    if detail {
        for s in stats {
            o.push_str(&format!(
                "  {:<48} {:>6.3}s {}ch {:>4}K tp {:>5.1} rms {:>6.1} r100 {:>6.1} cen {:>6.0} t20 {:>5.0} pk@{:.2} dc {:.4} bands {}{}\n",
                s.rel,
                s.len_s,
                s.channels,
                s.bytes / 1024,
                s.true_peak_db,
                s.rms_db,
                s.rms100_db,
                s.centroid_hz,
                s.t20_ms,
                s.peak_pos,
                s.dc,
                s.bands.iter().map(|b| format!("{b:.0}")).collect::<Vec<_>>().join("/"),
                s.f0_hz.map(|f| format!(" f0 {f:.1}")).unwrap_or_default()
            ));
        }
    }
    o
}
