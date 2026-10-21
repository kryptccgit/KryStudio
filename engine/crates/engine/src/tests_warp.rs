//! Warp markers + warp modes (warp.rs) through the whole engine, with the
//! real `krypt.audioclip`. Child of `tests_stretch` for its fixtures.

use super::*;
use crate::variants::VariantKey;
use crate::warp::{self, Mode};
use std::sync::atomic::AtomicBool;

const BEAT_TICKS: f64 = 960.0;

fn markers(list: &[(f64, f64)]) -> Value {
    Value::Array(list.iter().enumerate().map(|(i, &(sec, beat))| json!({ "id": format!("m{i}"), "sec": sec, "beat": beat })).collect())
}

/// Audio-clip song with a warp map on the channel (`warp` = Null: none).
fn warp_project(bpm: f64, path: &std::path::Path, params: Value, warp: Value, beats: f64) -> Value {
    let mut p = clip_project(bpm, path, params, beats * BEAT_TICKS);
    if !warp.is_null() {
        p["channels"]["ca"]["generator"]["warp"] = warp;
    }
    p
}

fn render_beats(p: &Value, cache: &Arc<SampleCache>, beats: f64) -> (Vec<f32>, Vec<String>) {
    render_range(p, cache, 0.0, beats * BEAT_TICKS)
}

/// First time (s) in [a, b) where |x| reaches half the window's peak.
fn half_peak_onset(x: &[f32], a: f64, b: f64) -> f64 {
    let (ia, ib) = (((a.max(0.0)) * SR) as usize, ((b * SR) as usize).min(x.len()));
    let pk = x[ia..ib].iter().fold(0f32, |m, v| m.max(v.abs()));
    (ia..ib).find(|&i| x[i].abs() >= 0.5 * pk).unwrap_or(ia) as f64 / SR
}

/// 10 % → 90 % rise time (s) of the 0.5 ms peak envelope around an onset in [a, b).
fn rise_time(x: &[f32], a: f64, b: f64) -> f64 {
    let w = (0.0005 * SR) as usize;
    let s = seg(x, a, b);
    let env: Vec<f32> = (0..s.len()).map(|i| s[i.saturating_sub(w)..=i].iter().fold(0f32, |m, v| m.max(v.abs()))).collect();
    let pk = env.iter().cloned().fold(0f32, f32::max);
    let t10 = env.iter().position(|v| *v >= 0.1 * pk).unwrap();
    let t90 = env.iter().position(|v| *v >= 0.9 * pk).unwrap();
    (t90 - t10) as f64 / SR
}

/// secToBeat of shared/schema/warp.ts (piecewise, edge segments extrapolate).
fn sec_to_beat(m: &[(f64, f64)], sec: f64) -> f64 {
    let mut i = 0;
    while i < m.len() - 2 && sec > m[i + 1].0 {
        i += 1;
    }
    let (a, b) = (m[i], m[i + 1]);
    a.1 + (sec - a.0) * (b.1 - a.1) / (b.0 - a.0)
}

fn bits_equal(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

// ── Timing ────────────────────────────────────────────────────────────────

#[test]
fn markers_place_clicks_on_their_beats_at_two_tempos() {
    let dir = tmp_dir("wtime");
    let path = dir.join("c.wav");
    let at = [0.3, 0.8, 1.55, 2.1, 2.6];
    let src = bursts(3.0, &at);
    write_wav(&path, &[src.clone(), src.clone()]);
    // Two segments with different rates (0.5 s → 1 beat, 1.3 s → 2 beats). Source
    // 0 maps to beat 0.4 (leading silence); the 2.6 s click is past the last
    // marker (extrapolated). The Stretch timing params are overridden.
    let m = [(0.3, 1.0), (0.8, 2.0), (2.1, 4.0)];
    let cache = Arc::new(SampleCache::new());
    // Where the source's half-peak sits inside each burst (attack shape).
    let delta: Vec<f64> = at.iter().map(|&t| half_peak_onset(&src, t - 0.005, t + 0.05) - t).collect();
    for bpm in [120.0, 75.0] {
        let spb = 60.0 / bpm;
        for (mode, tol) in [("beats", 0.001), ("repitch", 0.001), ("complex", 0.001), ("tones", 0.001)] {
            let p = warp_project(bpm, &path, json!({ "stretch": 3, "tempo_sync": 1, "src_bpm": 200 }), json!({ "mode": mode, "markers": markers(&m) }), 6.0);
            let (y, logs) = render_beats(&p, &cache, 6.0);
            assert!(logs.iter().any(|l| l.contains("Time-stretched")), "{logs:?}");
            assert!(rms(seg(&y, 0.0, 0.4 * spb - 0.08)) < 1e-4, "{mode} @ {bpm}: lead-in before beat 0.4 is silent");
            for (k, &t) in at.iter().enumerate() {
                let beat = sec_to_beat(&m, t);
                let want = beat * spb;
                let rate = if mode == "repitch" { 1.0 / (if t < 0.8 { 1.0 / 0.5 } else { 2.0 / 1.3 } * spb) } else { 1.0 };
                let got = half_peak_onset(&y, want - 0.02, want + 0.03) - delta[k] / rate;
                assert!((got - want).abs() <= tol, "{mode} @ {bpm} bpm: click at {t} s → {got:.5} s, want beat {beat:.4} = {want:.5} s");
            }
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn edges_extrapolate_and_audio_before_beat_zero_is_dropped() {
    let dir = tmp_dir("wedge");
    let path = dir.join("e.wav");
    let at = [0.2, 0.7, 1.2, 1.7, 2.2];
    write_wav(&path, &[bursts(2.5, &at)]);
    let cache = Arc::new(SampleCache::new());
    // Two markers in the middle: 0.5 s → 1 beat, at 60 bpm a 2× stretch.
    let m = [(0.7, 0.5), (1.2, 1.5)];
    let p = warp_project(60.0, &path, json!({}), json!({ "mode": "beats", "markers": markers(&m) }), 6.0);
    let (y, _) = render_beats(&p, &cache, 6.0);
    // 0.2 s maps to beat -0.5: before the variant start, dropped.
    assert!(rms(seg(&y, 0.0, 0.45)) < 1e-6, "audio before beat 0 is dropped");
    for &t in &at[1..] {
        let want = sec_to_beat(&m, t); // 60 bpm: 1 beat = 1 s
        let got = half_peak_onset(&y, want - 0.02, want + 0.03);
        assert!((got - want).abs() < 0.0015, "click at {t}: {got:.4} vs {want:.4}");
    }
    // The variant ends where the source end maps: beat 0.5 + (2.5 - 0.7) × 2 = 4.1.
    let end = last_sound(&y, 1e-4);
    assert!(end > 3.5 && end <= 4.1 + 1e-3, "ends at {end}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn one_marker_shifts_the_stretch_timing() {
    let dir = tmp_dir("wone");
    let path = dir.join("o.wav");
    let src = bursts(2.0, &[0.5]);
    write_wav(&path, std::slice::from_ref(&src));
    let delta = half_peak_onset(&src, 0.49, 0.55) - 0.5;
    let cache = Arc::new(SampleCache::new());
    // 120 bpm, stretch 1.5: source 0.5 s would land at 0.75 s; the marker pins it to beat 2 = 1.0 s.
    let p = warp_project(120.0, &path, json!({ "stretch": 1.5 }), json!({ "mode": "repitch", "markers": markers(&[(0.5, 2.0)]) }), 8.0);
    let (y, _) = render_beats(&p, &cache, 8.0);
    let c = half_peak_onset(&y, 0.9, 1.1) - delta * 1.5;
    assert!((c - 1.0).abs() < 0.001, "marker lands on its beat: {c}");
    // The rest keeps the stretch ratio: the variant is 2 s × 1.5 long, shifted by 0.25 s.
    let end = last_sound(&y, 1e-4);
    assert!(end > 1.1 && end <= 3.25 + 1e-3, "ends at {end}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn piecewise_segments_play_at_their_own_rates() {
    let dir = tmp_dir("wseg");
    let path = dir.join("s.wav");
    write_wav(&path, &[sine(440.0, 4.0, 0.5)]);
    let cache = Arc::new(SampleCache::new());
    // 120 bpm: [0, 1 s] → 4 beats (2 s: half speed), [1 s, 4 s] → 4 beats (2 s: 1.5× speed).
    let m = [(0.0, 0.0), (1.0, 4.0), (4.0, 8.0)];
    let p = warp_project(120.0, &path, json!({ "pitch": 7 }), json!({ "mode": "repitch", "markers": markers(&m) }), 8.0);
    let (y, _) = render_beats(&p, &cache, 8.0);
    let f1 = peak_hz(&y, 0.5);
    let f2 = peak_hz(&y, 2.5);
    assert!((f1 - 220.0).abs() < 3.0, "slow segment pitch {f1} (the Stretch pitch is ignored)");
    assert!((f2 - 660.0).abs() < 3.0, "fast segment pitch {f2}");
    // Complex keeps the pitch in both segments and applies the Stretch pitch.
    let p = warp_project(120.0, &path, json!({ "pitch": 12 }), json!({ "mode": "complex", "markers": markers(&m) }), 8.0);
    let (z, _) = render_beats(&p, &cache, 8.0);
    assert!((peak_hz(&z, 0.5) - 880.0).abs() < 4.0 && (peak_hz(&z, 2.5) - 880.0).abs() < 4.0);
    // No seam at the segment boundary (one stretcher): the level stays even around 2.0 s.
    let around: Vec<f64> = (0..8).map(|k| rms(seg(&z, 1.8 + k as f64 * 0.05, 1.85 + k as f64 * 0.05))).collect();
    let (lo, hi) = around.iter().fold((f64::MAX, 0f64), |(l, h), v| (l.min(*v), h.max(*v)));
    assert!(lo > 0.8 * hi, "level dips at the segment boundary: {around:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── Modes ─────────────────────────────────────────────────────────────────

#[test]
fn beats_keeps_transients_sharp_and_gaps_silent() {
    let dir = tmp_dir("wbeats");
    let path = dir.join("d.wav");
    let at: Vec<f64> = (0..8).map(|k| 0.1 + 0.25 * k as f64).collect();
    write_wav(&path, &[bursts(2.2, &at)]);
    let cache = Arc::new(SampleCache::new());
    // 2 s of source = 4 beats: at 60 bpm the beat is 1 s, so half speed.
    let m = [(0.0, 0.0), (2.0, 4.0)];
    let slow = |mode: &str| warp_project(60.0, &path, json!({}), json!({ "mode": mode, "markers": markers(&m) }), 5.0);
    let (b, _) = render_beats(&slow("beats"), &cache, 5.0);
    let (c, _) = render_beats(&slow("complex"), &cache, 5.0);
    let (orig, _) = render_beats(&warp_project(60.0, &path, json!({}), Value::Null, 5.0), &cache, 5.0);
    for &t in &at[1..7] {
        let o = 2.0 * t;
        let rs = rise_time(&orig, t - 0.02, t + 0.04);
        let rb = rise_time(&b, o - 0.02, o + 0.04);
        let (pb, pc) = (rms(seg(&b, o - 0.03, o - 0.0005)), rms(seg(&c, o - 0.03, o - 0.0005)));
        assert!((rb - rs).abs() < 0.0001, "beats rise at {o}: {:.3} ms vs the source's {:.3} ms", rb * 1e3, rs * 1e3);
        // Complex (phase vocoder) smears ~-37 dB of pre-echo ahead of each hit; beats has none.
        assert!(pb < 1e-6 && pc > 1e-3, "pre-echo before {o}: beats {pb:.2e}, complex {pc:.2e}");
        // The slice (0.25 s of source) ends at o + 0.25; the gap until o + 0.5 is silent.
        assert!(rms(seg(&b, o + 0.27, o + 0.49)) < 1e-6, "gap after {o} not silent");
    }
    // Fast (240 bpm: 2× speed): slices are cut at the next slice's start, no overlap smear.
    // Sustained notes (0.245 s of 1 kHz, then 5 ms of silence) at 2× speed.
    let notes_path = dir.join("n.wav");
    let notes: Vec<f32> = (0..(2.2 * SR) as usize)
        .map(|i| {
            let t = i as f64 / SR;
            let k = ((t - 0.1) / 0.25).floor();
            let u = t - 0.1 - 0.25 * k;
            if t >= 0.1 && u < 0.245 { (0.5 * (2.0 * PI * 1000.0 * u).sin()) as f32 } else { 0.0 }
        })
        .collect();
    write_wav(&notes_path, &[notes]);
    let fast = warp_project(240.0, &notes_path, json!({}), json!({ "mode": "beats", "beatsFadeMs": 5, "markers": markers(&m) }), 5.0);
    let (f, _) = render_beats(&fast, &cache, 5.0);
    for &t in &at[1..7] {
        let o = 0.5 * t;
        assert!(rise_time(&f, o - 0.01, o + 0.03) < 0.0005, "sharp onset at {o}");
        // Played at its original speed (1 kHz) and cut where the next slice starts
        // (125 ms later), faded over 5 ms, instead of running on under the next note.
        assert!(rms(seg(&f, o + 0.06, o + 0.1)) > 0.3, "note at {o}");
        assert!(rms(seg(&f, o + 0.1245, o + 0.1249)) < 0.03, "slice at {o} not cut: {}", rms(seg(&f, o + 0.1245, o + 0.1249)));
    }
    assert!((peak_hz(&f, 0.1) - 1000.0).abs() < 3.0, "beats never resamples");
    assert!(last_sound(&f, 1e-4) <= 1.1 + 1e-3, "2.2 s at 2× speed lasts 1.1 s");
    // Grid slicing at 1/8 also renders (and differs from transient slicing).
    let grid = warp_project(60.0, &path, json!({}), json!({ "mode": "beats", "beatsSlice": "1/8", "markers": markers(&m) }), 5.0);
    let (g, _) = render_beats(&grid, &cache, 5.0);
    assert!(g.iter().all(|v| v.is_finite()) && rms(&g) > 0.01 && !bits_equal(&g, &b));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn beats_pitch_shifts_each_slice() {
    let dir = tmp_dir("wbp");
    let path = dir.join("t.wav");
    // Two tonal notes with a sharp onset.
    let mut x = sine(440.0, 2.0, 0.5);
    for (i, v) in x.iter_mut().enumerate() {
        let t = (i as f64 / SR) % 1.0;
        *v *= (-(t / 0.4)).exp() as f32;
    }
    write_wav(&path, &[x]);
    let cache = Arc::new(SampleCache::new());
    let p = warp_project(120.0, &path, json!({ "pitch": 12 }), json!({ "mode": "beats", "markers": markers(&[(0.0, 0.0), (2.0, 4.0)]) }), 4.0);
    let (y, _) = render_beats(&p, &cache, 4.0);
    let f = peak_hz(&y, 0.05);
    assert!((f - 880.0).abs() < 5.0, "beats + pitch: {f}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn repitch_follows_the_speed() {
    let dir = tmp_dir("wrep");
    let path = dir.join("r.wav");
    write_wav(&path, &[sine(440.0, 3.0, 0.5)]);
    let cache = Arc::new(SampleCache::new());
    // No markers: the Stretch ratio is the speed. 0.5× length = 2× speed = an octave up.
    let p = warp_project(120.0, &path, json!({ "stretch": 0.5, "pitch": -12 }), json!({ "mode": "repitch", "markers": [] }), 4.0);
    let (y, _) = render_beats(&p, &cache, 4.0);
    assert!((peak_hz(&y, 0.1) - 880.0).abs() < 3.0, "repitch: {}", peak_hz(&y, 0.1));
    let end = last_sound(&y, 1e-3);
    assert!((end - 1.5).abs() < 0.01, "ends at {end}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn texture_is_finite_deterministic_and_follows_the_map() {
    let dir = tmp_dir("wtex");
    let path = dir.join("p.wav");
    let x: Vec<f32> = (0..(2.0 * SR) as usize)
        .map(|i| {
            let t = i as f64 / SR;
            (0.3 * (2.0 * PI * 220.0 * t).sin() + 0.2 * (2.0 * PI * 330.0 * t).sin()) as f32 * (((i * 7919) % 1000) as f32 / 5000.0 + 0.8)
        })
        .collect();
    write_wav(&path, &[x.clone(), x]);
    let tex = |flux: f64, grain: f64| json!({ "mode": "texture", "grainMs": grain, "flux": flux, "markers": markers(&[(0.0, 0.0), (2.0, 6.0)]) });
    let p = warp_project(120.0, &path, json!({ "pitch": 12 }), tex(0.5, 60.0), 7.0);
    let (a, _) = render_beats(&p, &Arc::new(SampleCache::new()), 7.0);
    let (b, _) = render_beats(&p, &Arc::new(SampleCache::new()), 7.0);
    assert!(bits_equal(&a, &b), "texture is deterministic");
    assert!(a.iter().all(|v| v.is_finite()));
    // 2 s → 6 beats = 3 s at 120 bpm, pitched up an octave by grain resampling.
    let end = last_sound(&a, 1e-3);
    assert!(end > 2.9 && end <= 3.0 + 1e-3, "ends at {end}");
    assert!(rms(seg(&a, 0.2, 2.8)) > 0.08, "level {}", rms(seg(&a, 0.2, 2.8)));
    // (the line is broadened by the 60 ms grains: ~1 / grain wide)
    assert!((peak_hz(&a, 0.5) - 440.0).abs() < 10.0, "texture pitch {}", peak_hz(&a, 0.5));
    let (c, _) = render_beats(&warp_project(120.0, &path, json!({ "pitch": 12 }), tex(0.0, 60.0), 7.0), &Arc::new(SampleCache::new()), 7.0);
    assert!(!bits_equal(&a, &c), "flux changes the output");
    // Level holds at any flux / ratio (grains are decorrelated and summed in power;
    // at a fixed grain offset a tone would comb-filter, -18 dB measured before).
    let noise: Vec<f32> = (0..(2.0 * SR) as usize)
        .map(|i| {
            let mut z = (i as u32).wrapping_mul(2654435761);
            z ^= z >> 13;
            ((z.wrapping_mul(1274126177) >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.5
        })
        .collect();
    for (name, sig) in [("noise", noise), ("tone", sine(220.0, 2.0, 0.3)), ("bass", sine(55.0, 2.0, 0.5))] {
        let pp = dir.join(format!("{name}.wav"));
        write_wav(&pp, std::slice::from_ref(&sig));
        for flux in [0.0, 1.0] {
            for end in [2.4, 8.0] {
                let w = json!({ "mode": "texture", "flux": flux, "markers": markers(&[(0.0, 0.0), (2.0, end)]) });
                let (d, _) = render_beats(&warp_project(120.0, &pp, json!({}), w, 9.0), &Arc::new(SampleCache::new()), 9.0);
                let db = 20.0 * (rms(seg(&d, 0.2, end * 0.5 - 0.2)) / rms(&sig)).log10();
                assert!(db.abs() < 2.0, "texture level {name}, flux {flux}, ×{}: {db:.2} dB", end / 4.0);
            }
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn tones_keeps_a_sung_glide_cleaner_than_complex() {
    let dir = tmp_dir("wtones");
    let path = dir.join("g.wav");
    // A sung-like glide: 196 → 392 Hz in 1.5 s with 5 harmonics and vibrato.
    let mut ph = 0.0f64;
    let x: Vec<f32> = (0..(2.0 * SR) as usize)
        .map(|i| {
            let t = i as f64 / SR;
            let f = 196.0 * 2f64.powf((t / 1.5).min(1.0)) * 2f64.powf((2.0 * PI * 5.5 * t).sin() * 0.5 / 12.0);
            ph += 2.0 * PI * f / SR;
            (0.4 * (1..=5).map(|k| (k as f64 * ph).sin() / k as f64).sum::<f64>() / 1.5) as f32
        })
        .collect();
    write_wav(&path, &[x]);
    let cache = Arc::new(SampleCache::new());
    let wobble = |y: &[f32]| {
        let env: Vec<f64> = seg(y, 0.3, 2.8).chunks_exact((0.01 * SR) as usize).map(rms).collect();
        let m = env.iter().sum::<f64>() / env.len() as f64;
        (env.iter().map(|e| (e - m).powi(2)).sum::<f64>() / env.len() as f64).sqrt() / m
    };
    let mk = |mode: &str| warp_project(120.0, &path, json!({ "pitch": 3 }), json!({ "mode": mode, "markers": markers(&[(0.0, 0.0), (2.0, 6.0)]) }), 7.0);
    let (t, _) = render_beats(&mk("tones"), &cache, 7.0);
    let (c, _) = render_beats(&mk("complex"), &cache, 7.0);
    let (wt, wc) = (wobble(&t), wobble(&c));
    assert!(wt < wc, "tones wobble {wt:.4} vs complex {wc:.4}");
    assert!(cache.variants.len() == 2, "tones and complex are distinct variants");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── Identity, fallback, keys ──────────────────────────────────────────────

#[test]
fn identity_warp_is_bit_identical_and_never_renders() {
    let dir = tmp_dir("wident");
    let path = dir.join("i.wav");
    let mut x = sine(330.0, 1.0, 0.4);
    for (i, v) in x.iter_mut().enumerate() {
        *v += 0.2 * (((i * 7919) % 1000) as f32 / 1000.0 - 0.5);
    }
    write_wav(&path, &[x.clone(), x]);
    let cache = Arc::new(SampleCache::new());
    let (plain, _) = render_beats(&warp_project(120.0, &path, json!({}), Value::Null, 3.0), &cache, 3.0);
    for w in [
        json!({ "mode": "complex", "markers": [] }),
        json!({ "mode": "beats", "markers": [] }),
        json!({ "mode": "texture", "markers": [], "flux": 1 }),
        json!({ "mode": "repitch", "markers": [] }),
        json!({ "mode": "tones", "markers": markers(&[(0.5, 1.0)]) }), // one marker at its natural place
        json!({ "mode": "beats", "markers": markers(&[(0.0, 0.0), (0.5, 1.0), (1.0, 2.0)]) }), // the native tempo
    ] {
        let (y, _) = render_beats(&warp_project(120.0, &path, json!({}), w.clone(), 3.0), &cache, 3.0);
        assert!(bits_equal(&plain, &y), "{w} changed the output");
    }
    // repitch ignores the pitch: ratio 1 + 5 st is still the original.
    let (y, _) = render_beats(&warp_project(120.0, &path, json!({ "pitch": 5 }), json!({ "mode": "repitch", "markers": [] }), 3.0), &cache, 3.0);
    assert!(bits_equal(&plain, &y));
    assert!(cache.variants.is_empty(), "nothing rendered at identity");
    // complex without markers is exactly the plain stretch variant (same cache entry).
    let (s1, _) = render_beats(&warp_project(120.0, &path, json!({ "stretch": 1.25 }), Value::Null, 3.0), &cache, 3.0);
    let (s2, _) = render_beats(&warp_project(120.0, &path, json!({ "stretch": 1.25 }), json!({ "mode": "complex", "markers": [] }), 3.0), &cache, 3.0);
    assert!(bits_equal(&s1, &s2));
    assert_eq!(cache.variants.len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn invalid_maps_warn_and_fall_back_to_the_stretch_params() {
    let dir = tmp_dir("winv");
    let path = dir.join("v.wav");
    write_wav(&path, &[bursts(2.0, &[0.1, 0.6, 1.1])]);
    let cache = Arc::new(SampleCache::new());
    let params = json!({ "stretch": 1.5 });
    let (want, _) = render_beats(&warp_project(120.0, &path, params.clone(), Value::Null, 8.0), &cache, 8.0);
    for bad in [
        markers(&[(0.0, 0.0), (1.0, 2.0), (0.5, 3.0)]), // sec goes back
        markers(&[(0.0, 0.0), (1.0, 2.0), (1.5, 2.0)]), // beat does not increase
        markers(&[(0.0, -1.0), (1.0, 2.0)]),            // negative beat
    ] {
        let (y, logs) = render_beats(&warp_project(120.0, &path, params.clone(), json!({ "mode": "complex", "markers": bad }), 8.0), &cache, 8.0);
        assert!(logs.iter().filter(|l| l.contains("Stretch timing")).count() == 1, "{logs:?}");
        assert!(bits_equal(&want, &y), "fallback = the Stretch params' render");
    }
    // Unknown mode: complex, with a warning.
    let (y, logs) = render_beats(&warp_project(120.0, &path, params.clone(), json!({ "mode": "elastic", "markers": [] }), 8.0), &cache, 8.0);
    assert!(logs.iter().any(|l| l.contains("unknown warp mode")), "{logs:?}");
    assert!(bits_equal(&want, &y));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn variant_key_follows_markers_mode_settings_and_tempo() {
    let p = std::path::Path::new("C:/x/a.wav");
    let map = |mode: &str, m: &[(f64, f64)], extra: Value| {
        let mut v = json!({ "mode": mode, "markers": markers(m) });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, x) in e {
                o.insert(k.clone(), x.clone());
            }
        }
        serde_json::from_value::<crate::model::WarpMap>(v).unwrap()
    };
    let key = |w: &crate::model::WarpMap, ratio: f64, semis: f64, bpm: f64| VariantKey::warped(p, None, ratio, semis, true, Some(w), bpm).0;
    let m = [(0.0, 0.0), (1.0, 3.0), (2.0, 5.0)];
    let a = key(&map("complex", &m, json!({})), 1.0, 0.0, 120.0);
    let moved = key(&map("complex", &[(0.0, 0.0), (1.1, 3.0), (2.0, 5.0)], json!({})), 1.0, 0.0, 120.0);
    assert_ne!(a, moved, "marker move → new variant");
    assert_ne!(a.timing(), moved.timing(), "...with new timing");
    let beats = key(&map("beats", &m, json!({})), 1.0, 0.0, 120.0);
    assert_ne!(a, beats, "mode change → new variant");
    assert_eq!(a.timing(), beats.timing(), "...with the same timing (keeps playing while it renders)");
    assert_ne!(a, key(&map("complex", &m, json!({})), 1.0, 0.0, 128.0), "tempo matters with markers");
    assert_eq!(a, key(&map("complex", &m, json!({})), 2.5, 0.0, 120.0), ">= 2 markers override the stretch ratio");
    assert_ne!(beats, key(&map("beats", &m, json!({ "beatsFadeMs": 5 })), 1.0, 0.0, 120.0), "beats settings matter");
    assert_eq!(a, key(&map("complex", &m, json!({ "beatsFadeMs": 5, "grainMs": 30 })), 1.0, 0.0, 120.0), "unused settings do not");
    let t = key(&map("texture", &[], json!({})), 1.5, 0.0, 120.0);
    assert_eq!(t, key(&map("texture", &[], json!({})), 1.5, 0.0, 90.0), "no markers: the tempo is already in the ratio");
    assert_ne!(t, key(&map("texture", &[], json!({ "grainMs": 120 })), 1.5, 0.0, 120.0));
    assert_eq!(t.timing(), VariantKey::new(p, None, 1.5, 0.0, true).timing());
    let r = key(&map("repitch", &m, json!({})), 1.0, 7.0, 120.0);
    assert_eq!(r.semitones(), 0.0, "repitch ignores pitch");
    assert!(r.describe().contains("warp repitch, 3 markers"), "{}", r.describe());
    assert_eq!(a.warp().unwrap().mode, Mode::Complex);
    // Resolve: invalid → no markers + warning; one marker at its natural place → none.
    let res = warp::resolve(Some(&map("complex", &[(1.0, 2.0), (0.5, 3.0)], json!({}))), 1.0, 0.0, 120.0);
    assert!(res.warning.is_some() && res.warp.unwrap().marker_count() == 0);
    let res = warp::resolve(Some(&map("tones", &[(1.0, 3.0)], json!({}))), 1.5, 0.0, 120.0);
    assert_eq!(res.warp.unwrap().marker_count(), 0, "1 s × 1.5 = 1.5 s = beat 3 at 120 bpm");
}

#[test]
fn live_marker_move_rerenders_and_mode_change_keeps_playing() {
    let dir = tmp_dir("wlive");
    let path = dir.join("l.wav");
    write_wav(&path, &[sine(200.0, 4.0, 0.5)]);
    let cache = Arc::new(SampleCache::new());
    let m = [(0.0, 0.0), (4.0, 6.0)];
    let p = warp_project(120.0, &path, json!({}), json!({ "mode": "complex", "markers": markers(&m) }), 16.0);
    let mut live = LiveClip::new(&p, cache);
    live.finish_jobs();
    live.rebuild(false);
    live.tx.push(Cmd::Play).ok();
    let a = live.run(24000);
    assert!(rms(&a[2400..]) > 0.2, "warped variant plays");
    // Mode change, same markers: same timing → the current variant keeps playing.
    live.session.model.channels.get_mut("ca").unwrap().generator.warp.as_mut().unwrap().mode = "tones".into();
    let (insts, _) = live.rebuild(false);
    assert_eq!(insts, 0, "instance kept while the new mode renders");
    assert_eq!(live.session.stretch_pending, vec!["ca".to_string()]);
    assert!(rms(&live.run(4800)) > 0.2);
    let first = live.jobs.try_recv().expect("job for the new mode");
    // Marker move: new timing → the pending job is cancelled, silence until ready.
    live.session.model.channels.get_mut("ca").unwrap().generator.warp.as_mut().unwrap().markers[1].beat = 7.0;
    let (insts, _) = live.rebuild(false);
    assert_eq!(insts, 1);
    assert!(first.cancel.load(std::sync::atomic::Ordering::Relaxed), "stale job cancelled");
    let second = live.jobs.try_recv().expect("job for the moved marker");
    assert_ne!(first.key.timing(), second.key.timing());
    let c = live.run(4800);
    assert!(rms(&c[480..]) < 1e-4, "silent while the new timing renders");
    live.session.variant_done(&first.key);
    let _ = crate::variants::run_job(&live.session.cache.variants, &second);
    live.session.variant_done(&second.key);
    let (_, rechase) = live.rebuild(false);
    assert_eq!(rechase.len(), 1);
    assert!(rms(&live.run(9600)[480..]) > 0.15, "resumes mid-clip");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── Performance ───────────────────────────────────────────────────────────

/// `CARGO_TARGET_DIR=engine/target-str cargo test --release -p krypt-studio-engine -- --ignored --nocapture warp_perf`
#[test]
#[ignore]
fn warp_perf_thirty_second_stereo() {
    let n = (30.0 * SR) as usize;
    let mut seed = 1u32;
    let (mut l, mut r) = (Vec::with_capacity(n), Vec::with_capacity(n));
    for i in 0..n {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let noise = (seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5;
        let t = i as f64 / SR;
        let hit = ((t * 4.0).fract() * 20.0).min(1.0).mul_add(-1.0, 1.0) as f32; // a click every 250 ms
        l.push((0.3 * (2.0 * PI * 110.0 * t).sin()) as f32 + 0.05 * noise + 0.5 * hit * noise);
        r.push((0.3 * (2.0 * PI * 165.0 * t).sin()) as f32 - 0.05 * noise + 0.5 * hit * noise);
    }
    let chans: Vec<&[f32]> = vec![&l, &r];
    // 30 s of 128 bpm material warped to 120 bpm with a marker per bar (16 markers, gentle drift).
    let mut m = Vec::new();
    for k in 0..=16 {
        let sec = k as f64 * 30.0 / 16.0;
        m.push((sec, k as f64 * 4.0 * (30.0 / 16.0) / (4.0 * 60.0 / 128.0) + if k % 2 == 1 { 0.1 } else { 0.0 }));
    }
    for mode in ["complex", "tones", "beats", "texture", "repitch"] {
        for semis in [0.0, 3.0] {
            let wm: crate::model::WarpMap = serde_json::from_value(json!({ "mode": mode, "markers": markers(&m) })).unwrap();
            let res = warp::resolve(Some(&wm), 1.0, semis, 120.0);
            let w = res.warp.unwrap();
            let t0 = std::time::Instant::now();
            let y = warp::render(&chans, SR, res.ratio, res.semitones, true, &w, 1800.0, &AtomicBool::new(false)).unwrap();
            let dt = t0.elapsed().as_secs_f64();
            let secs = y[0].len() as f64 / SR;
            println!("{mode:>8} {semis:+} st: {:.1} ms per second of output ({secs:.1} s in {dt:.2} s)", dt * 1e3 / secs);
        }
    }
}
