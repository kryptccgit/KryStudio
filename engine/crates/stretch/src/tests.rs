use super::*;
use rustfft::{num_complex::Complex, FftPlanner};
use std::f64::consts::PI;

const SR: f64 = 48000.0;

fn run(input: &[Vec<f32>], ratio: f64, semis: f64, formant: bool) -> Vec<Vec<f32>> {
    let refs: Vec<&[f32]> = input.iter().map(|c| &c[..]).collect();
    let s = StretchSettings { time_ratio: ratio, semitones: semis, keep_formants: formant };
    stretch_planar(&refs, SR, &s, &AtomicBool::new(false)).expect("stretch")
}

fn sine(freq: f64, secs: f64, amp: f64) -> Vec<f32> {
    let n = (secs * SR) as usize;
    (0..n).map(|i| (amp * (2.0 * PI * freq * i as f64 / SR).sin()) as f32).collect()
}

/// Tonal bursts (1 kHz, 1 ms attack, 40 ms decay) every `period` seconds, first at `first`.
fn bursts(secs: f64, first: f64, period: f64) -> (Vec<f32>, Vec<f64>) {
    let n = (secs * SR) as usize;
    let mut x = vec![0f32; n];
    let mut onsets = Vec::new();
    let mut t = first;
    while t + 0.1 < secs {
        let s0 = (t * SR) as usize;
        onsets.push(s0 as f64 / SR);
        for k in 0..(0.08 * SR) as usize {
            let tt = k as f64 / SR;
            let env = (tt / 0.001).min(1.0) * (-tt / 0.012).exp();
            x[s0 + k] += (0.8 * env * (2.0 * PI * 1000.0 * tt).sin()) as f32;
        }
        t += period;
    }
    (x, onsets)
}

/// Energy-weighted centre time (s) of x within [a, b) seconds.
fn centroid(x: &[f32], a: f64, b: f64) -> f64 {
    let (ia, ib) = ((a * SR) as usize, ((b * SR) as usize).min(x.len()));
    let (mut num, mut den) = (0.0, 0.0);
    for (i, v) in x.iter().enumerate().take(ib).skip(ia) {
        let e = (*v as f64) * (*v as f64);
        num += e * i as f64;
        den += e;
    }
    num / den.max(1e-30) / SR
}

/// First time (s) in [a, b) where |x| reaches half the window's peak.
fn half_peak_onset(x: &[f32], a: f64, b: f64) -> f64 {
    let (ia, ib) = ((a * SR) as usize, ((b * SR) as usize).min(x.len()));
    let pk = x[ia..ib].iter().fold(0f32, |m, v| m.max(v.abs()));
    let i = (ia..ib).find(|&i| x[i].abs() >= 0.5 * pk).unwrap();
    i as f64 / SR
}

fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt()
}

/// Magnitude spectrum (Hann) of x[a..a+n].
fn spectrum(x: &[f32], a: usize, n: usize) -> Vec<f64> {
    let mut buf: Vec<Complex<f64>> = (0..n)
        .map(|i| {
            let w = 0.5 - 0.5 * (2.0 * PI * i as f64 / n as f64).cos();
            Complex::new(x[a + i] as f64 * w, 0.0)
        })
        .collect();
    FftPlanner::new().plan_fft_forward(n).process(&mut buf);
    buf[..n / 2].iter().map(|c| c.norm()).collect()
}

fn peak_hz(x: &[f32]) -> f64 {
    let n = 1 << 15;
    let a = (x.len() - n) / 2;
    let s = spectrum(x, a, n);
    let k = (1..s.len()).max_by(|&i, &j| s[i].total_cmp(&s[j])).unwrap();
    k as f64 * SR / n as f64
}

fn band_energy(s: &[f64], n: usize, lo: f64, hi: f64) -> f64 {
    let bin = SR / n as f64;
    s.iter().enumerate().filter(|(k, _)| (*k as f64 * bin) >= lo && (*k as f64 * bin) < hi).map(|(_, m)| m * m).sum()
}

#[test]
fn output_length_is_exactly_ratio_times_input() {
    for &n in &[1usize, 100, 1000, 4800, 48000, 123_457] {
        for &r in &[0.25, 0.5, 0.8, 1.0, 1.25, 2.0, 3.7, 4.0] {
            let x = [sine(220.0, n as f64 / SR, 0.5)];
            let x = vec![x[0][..n.min(x[0].len())].to_vec()];
            let n = x[0].len();
            let y = run(&x, r, 0.0, true);
            assert_eq!(y[0].len(), output_frames(n, r), "n={n} ratio={r}");
        }
    }
    // pitch-only keeps the length; stereo stays stereo
    let x = vec![sine(300.0, 1.0, 0.5), sine(450.0, 1.0, 0.5)];
    let y = run(&x, 1.0, 5.0, true);
    assert_eq!(y.len(), 2);
    assert_eq!(y[0].len(), x[0].len());
    assert_eq!(y[1].len(), x[1].len());
}

#[test]
fn stretch_2x_doubles_duration_and_onset_times() {
    let (x, onsets) = bursts(4.0, 0.25, 0.5);
    let y = run(std::slice::from_ref(&x), 2.0, 0.0, true);
    assert_eq!(y[0].len(), 2 * x.len());
    for &t in &onsets {
        let ci = centroid(&x, t - 0.05, t + 0.2);
        let co = centroid(&y[0], 2.0 * t - 0.1, 2.0 * t + 0.4);
        assert!((co - 2.0 * ci).abs() < 0.004, "burst at {t}: centroid {co:.4} vs 2x {:.4}", 2.0 * ci);
        let oi = half_peak_onset(&x, t - 0.05, t + 0.2);
        let oo = half_peak_onset(&y[0], 2.0 * t - 0.1, 2.0 * t + 0.4);
        assert!((oo - 2.0 * oi).abs() < 0.012, "burst at {t}: onset {oo:.4} vs 2x {:.4}", 2.0 * oi);
    }
    // compressing keeps the grid too
    let y = run(std::slice::from_ref(&x), 0.5, 0.0, true);
    for &t in &onsets[..onsets.len() - 1] {
        let ci = centroid(&x, t - 0.05, t + 0.2);
        let co = centroid(&y[0], 0.5 * t - 0.025, 0.5 * t + 0.1);
        assert!((co - 0.5 * ci).abs() < 0.004, "0.5x burst at {t}: centroid {co:.4} vs {:.4}", 0.5 * ci);
    }
}

#[test]
fn pitch_up_an_octave_doubles_the_dominant_frequency() {
    let x = sine(440.0, 2.0, 0.5);
    let y = run(std::slice::from_ref(&x), 1.0, 12.0, true);
    assert_eq!(y[0].len(), x.len(), "duration unchanged");
    let (fi, fo) = (peak_hz(&x), peak_hz(&y[0]));
    assert!((fi - 440.0).abs() < 2.0, "{fi}");
    assert!((fo - 880.0).abs() < 4.0, "pitched peak {fo} Hz");
    // fractional and downward shifts
    let y = run(std::slice::from_ref(&x), 1.0, -7.5, false);
    let want = 440.0 * 2f64.powf(-7.5 / 12.0);
    assert!((peak_hz(&y[0]) - want).abs() < 4.0, "{} vs {want}", peak_hz(&y[0]));
    // stretch + pitch together
    let y = run(std::slice::from_ref(&x), 1.5, 12.0, true);
    assert_eq!(y[0].len(), output_frames(x.len(), 1.5));
    assert!((peak_hz(&y[0]) - 880.0).abs() < 4.0);
}

#[test]
fn level_is_preserved() {
    let x = sine(330.0, 2.0, 0.5);
    for &(r, s) in &[(1.5, 0.0), (0.75, 0.0), (1.0, 3.0), (2.0, -5.0)] {
        let y = run(std::slice::from_ref(&x), r, s, true);
        let n = y[0].len();
        let (a, b) = (rms(&x[x.len() / 4..3 * x.len() / 4]), rms(&y[0][n / 4..3 * n / 4]));
        let db = 20.0 * (b / a).log10();
        assert!(db.abs() < 1.5, "ratio {r} semis {s}: level {db:.2} dB");
    }
}

/// A sung-vowel stand-in: 120 Hz pulse train through a resonance at 800 Hz.
fn vowel(secs: f64) -> Vec<f32> {
    let n = (secs * SR) as usize;
    let (f, q) = (800.0 / SR, 8.0);
    let w = 2.0 * PI * f;
    let (alpha, cw) = (w.sin() / (2.0 * q), w.cos());
    let (b0, a0, a1, a2) = (alpha, 1.0 + alpha, -2.0 * cw, 1.0 - alpha);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    let period = SR / 120.0;
    (0..n)
        .map(|i| {
            let x0 = if (i as f64 % period) < 1.0 { 1.0 } else { 0.0 };
            let y0 = (b0 * x0 - b0 * x2 - a1 * y1 - a2 * y2) / a0;
            x2 = x1;
            x1 = x0;
            y2 = y1;
            y1 = y0;
            (y0 * 0.5) as f32
        })
        .collect()
}

#[test]
fn keep_formants_holds_the_spectral_envelope() {
    let x = vowel(2.0);
    let on = run(std::slice::from_ref(&x), 1.0, 12.0, true);
    let off = run(std::slice::from_ref(&x), 1.0, 12.0, false);
    let diff = rms(&on[0].iter().zip(&off[0]).map(|(a, b)| a - b).collect::<Vec<_>>());
    assert!(diff > 0.2 * rms(&off[0]), "formant flag must change the output ({diff})");
    let n = 1 << 15;
    let a = (x.len() - n) / 2;
    let (s_on, s_off) = (spectrum(&on[0], a, n), spectrum(&off[0], a, n));
    let low = |s: &[f64]| band_energy(s, n, 600.0, 1000.0);
    let high = |s: &[f64]| band_energy(s, n, 1400.0, 1900.0);
    // formants shifted with the pitch: the resonance moved up an octave
    assert!(high(&s_off) > 2.0 * low(&s_off), "off: high {} low {}", high(&s_off), low(&s_off));
    // compensated: the resonance stays near 800 Hz
    assert!(low(&s_on) > high(&s_on), "on: low {} high {}", low(&s_on), high(&s_on));
}

#[test]
fn starts_without_a_click_or_preroll() {
    for &r in &[1.0, 1.3, 0.7, 0.5, 2.5] {
        let semis = if r == 1.0 { 4.0 } else { 0.0 };
        // Material that fades in (most real starts): the output start is as smooth as the steady state.
        let mut x = sine(200.0, 1.0, 0.8);
        for (i, v) in x.iter_mut().take(240).enumerate() {
            *v *= i as f32 / 240.0;
        }
        let y = run(std::slice::from_ref(&x), r, semis, true);
        let slope = |s: &[f32]| s.windows(2).fold(0f32, |m, w| m.max((w[1] - w[0]).abs()));
        let steady = slope(&y[0][y[0].len() / 2..y[0].len() / 2 + 4800]);
        let start = slope(&y[0][..960]);
        assert!(start <= 1.5 * steady, "ratio {r}: start slope {start} vs steady {steady}");
        // Sound is there from the very start: no output-latency pre-roll of silence.
        assert!(rms(&y[0][240..2400]) > 0.25, "ratio {r}: silent start");
        // Abrupt material (full-scale cosine: a step from silence): the output
        // begins at 0 and the start stays within +1.6 dB of the steady state.
        let x: Vec<f32> = (0..48000).map(|i| (0.8 * (2.0 * PI * 200.0 * i as f64 / SR).cos()) as f32).collect();
        let y = run(std::slice::from_ref(&x), r, semis, true);
        assert_eq!(y[0][0], 0.0, "ratio {r}: first sample");
        let peak = |s: &[f32]| s.iter().fold(0f32, |m, v| m.max(v.abs()));
        let (pk, steady) = (peak(&y[0][..2400]), peak(&y[0][y[0].len() / 2..y[0].len() / 2 + 9600]));
        assert!(pk <= 1.2 * steady, "ratio {r}: start peak {pk} vs steady {steady}");
        assert!(slope(&y[0][..960]) <= 1.5 * steady * (2.0 * PI * 200.0 * 2f64.powf(semis / 12.0) / SR) as f32, "ratio {r}: start slope");
    }
}

#[test]
fn silent_gaps_do_not_glitch_the_next_onset() {
    // 3 s of digital silence between bursts: several chunks' worth.
    let mut x = vec![0f32; (8.0 * SR) as usize];
    let (b, _) = bursts(0.5, 0.05, 1.0);
    x[..b.len()].copy_from_slice(&b);
    let s0 = (5.0 * SR) as usize;
    x[s0..s0 + b.len()].copy_from_slice(&b);
    let y = run(std::slice::from_ref(&x), 1.5, 0.0, true);
    let ci = centroid(&x, 4.9, 5.3);
    let co = centroid(&y[0], 1.5 * 4.9, 1.5 * 5.3);
    assert!((co - 1.5 * ci).abs() < 0.004, "after silence: {co:.4} vs {:.4}", 1.5 * ci);
    let (a, b2) = (rms(&x[s0..s0 + 4800]), rms(&y[0][(1.5 * 5.05 * SR) as usize - 2400..(1.5 * 5.05 * SR) as usize + 2400]));
    assert!(b2 > 0.3 * a, "onset after silence lost energy: {b2} vs {a}");
}

#[test]
fn deterministic_and_cancellable() {
    let x = vec![sine(250.0, 1.0, 0.5), sine(375.0, 1.0, 0.5)];
    // > 2x stretch randomises phases: still identical run to run
    let a = run(&x, 3.0, 2.0, true);
    let b = run(&x, 3.0, 2.0, true);
    assert_eq!(a, b);
    let refs: Vec<&[f32]> = x.iter().map(|c| &c[..]).collect();
    let r = stretch_planar(&refs, SR, &StretchSettings { time_ratio: 2.0, semitones: 0.0, keep_formants: true }, &AtomicBool::new(true));
    assert_eq!(r, Err(StretchError::Cancelled));
}

#[test]
fn bad_arguments_are_errors_not_panics() {
    let x = sine(250.0, 0.1, 0.5);
    let c = AtomicBool::new(false);
    let s = |r: f64, st: f64| StretchSettings { time_ratio: r, semitones: st, keep_formants: true };
    assert!(stretch_planar(&[&x[..]], SR, &s(0.0, 0.0), &c).is_err());
    assert!(stretch_planar(&[&x[..]], SR, &s(f64::NAN, 0.0), &c).is_err());
    assert!(stretch_planar(&[&x[..]], SR, &s(1.0, 99.0), &c).is_err());
    assert!(stretch_planar(&[], SR, &s(1.0, 0.0), &c).is_err());
    assert!(stretch_planar(&[&x[..], &x[..10]], SR, &s(1.0, 0.0), &c).is_err());
    assert_eq!(stretch_planar(&[&[][..]], SR, &s(2.0, 0.0), &c).unwrap(), vec![Vec::<f32>::new()]);
}

/// `cargo test -p krypt-studio-stretch --release -- --ignored --nocapture perf`
#[test]
#[ignore]
fn perf_three_minute_stereo_stem() {
    let n = (180.0 * SR) as usize;
    let mut l = Vec::with_capacity(n);
    let mut r = Vec::with_capacity(n);
    let mut seed = 1u32;
    for i in 0..n {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let noise = (seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5;
        let t = i as f64 / SR;
        l.push((0.3 * (2.0 * PI * 110.0 * t).sin()) as f32 + 0.05 * noise);
        r.push((0.3 * (2.0 * PI * 165.0 * t).sin()) as f32 - 0.05 * noise);
    }
    for &(ratio, semis) in &[(1.0, 3.0), (1.25, 0.0), (0.8, 0.0), (2.0, -12.0), (0.5, 0.0)] {
        let t0 = std::time::Instant::now();
        let y = run(&[l.clone(), r.clone()], ratio, semis, true);
        let dt = t0.elapsed().as_secs_f64();
        println!("3-min stereo stem, ratio {ratio}, {semis:+} st: {dt:.2} s ({:.0}x real time)", 180.0 / dt);
        assert_eq!(y[0].len(), output_frames(n, ratio));
    }
}

// ── Piecewise maps (stretch_mapped) ───────────────────────────────────────

/// Exponential sine glide f0 → f1 over `secs` (phase-continuous).
fn glide(f0: f64, f1: f64, secs: f64, amp: f64) -> Vec<f32> {
    let n = (secs * SR) as usize;
    let mut ph = 0.0f64;
    (0..n)
        .map(|i| {
            let f = f0 * (f1 / f0).powf(i as f64 / n as f64);
            ph += 2.0 * PI * f / SR;
            (amp * ph.sin()) as f32
        })
        .collect()
}

/// Mean share of each STFT frame's energy within ±3 bins of its peak
/// (1.0 = a single clean partial). 2048-point Hann, hop 512, frames in [a, b) s.
fn purity(x: &[f32], a: f64, b: f64) -> f64 {
    let n = 2048;
    let fft = FftPlanner::new().plan_fft_forward(n);
    let (mut sum, mut cnt) = (0.0, 0);
    let mut i = (a * SR) as usize;
    while i + n <= ((b * SR) as usize).min(x.len()) {
        let mut buf: Vec<Complex<f64>> =
            (0..n).map(|k| Complex::new(x[i + k] as f64 * (0.5 - 0.5 * (2.0 * PI * k as f64 / n as f64).cos()), 0.0)).collect();
        fft.process(&mut buf);
        let p: Vec<f64> = buf[..n / 2].iter().map(|c| c.norm_sqr()).collect();
        let tot: f64 = p.iter().sum();
        if tot > 1e-6 {
            let k = (1..n / 2).max_by(|&u, &v| p[u].total_cmp(&p[v])).unwrap();
            let near: f64 = p[k.saturating_sub(3)..(k + 4).min(n / 2)].iter().sum();
            sum += near / tot;
            cnt += 1;
        }
        i += 512;
    }
    sum / cnt.max(1) as f64
}

fn mapped(input: &[Vec<f32>], knots: &[(f64, f64)], n_out: usize, semis: f64, profile: Profile) -> Vec<Vec<f32>> {
    let refs: Vec<&[f32]> = input.iter().map(|c| &c[..]).collect();
    stretch_mapped(&refs, SR, knots, n_out, semis, true, profile, &AtomicBool::new(false)).expect("mapped")
}

/// Harmonic "voice" (6 partials, 1/k) at 250 Hz with ±1 st vibrato at 5.5 Hz.
fn vibrato_voice(secs: f64, amp: f64) -> Vec<f32> {
    let n = (secs * SR) as usize;
    let mut ph = 0.0f64;
    (0..n)
        .map(|i| {
            let t = i as f64 / SR;
            let f = 250.0 * 2f64.powf((2.0 * PI * 5.5 * t).sin() / 12.0);
            ph += 2.0 * PI * f / SR;
            (amp * (1..=6).map(|k| (k as f64 * ph).sin() / k as f64).sum::<f64>() / 1.5) as f32
        })
        .collect()
}

/// (std / mean of the 10 ms RMS envelope, mean envelope) over [a, b) s.
fn wobble(x: &[f32], a: f64, b: f64) -> (f64, f64) {
    let w = (0.01 * SR) as usize;
    let env: Vec<f64> = x[(a * SR) as usize..((b * SR) as usize).min(x.len())].chunks_exact(w).map(rms).collect();
    let m = env.iter().sum::<f64>() / env.len() as f64;
    let v = env.iter().map(|e| (e - m).powi(2)).sum::<f64>() / env.len() as f64;
    (v.sqrt() / m, m)
}

fn tones_vs_complex(x: &[f32], ratio: f64, semis: f64) -> ((f64, f64), (f64, f64)) {
    let n_out = (x.len() as f64 * ratio) as usize;
    let knots = [(0.0, 0.0), (x.len() as f64, x.len() as f64 * ratio)];
    let (_, m0) = wobble(x, 0.1, x.len() as f64 / SR - 0.1);
    let d = n_out as f64 / SR;
    let run = |p: Profile| {
        let y = mapped(&[x.to_vec()], &knots, n_out, semis, p);
        assert_eq!(y[0].len(), n_out);
        let (w, m) = wobble(&y[0], 0.2, d - 0.2);
        (w, m / m0)
    };
    (run(Profile::Tones), run(Profile::Complex))
}

#[test]
fn tones_profile_keeps_a_vibrato_voice_steady() {
    // A sung-like note: 250 Hz, 6 harmonics, ±1 st vibrato at 5.5 Hz.
    let x = vibrato_voice(3.0, 0.5);
    for &(ratio, semis) in &[(1.5, 3.0), (0.7, -5.0), (2.0, -12.0)] {
        let ((wt, lt), (wc, lc)) = tones_vs_complex(&x, ratio, semis);
        assert!(wt < 0.9 * wc, "×{ratio} {semis:+} st: tones wobble {wt:.4} vs complex {wc:.4}");
        assert!((lt - 1.0).abs() < 0.08, "×{ratio} {semis:+} st: tones level {lt:.3} (complex {lc:.3})");
    }
}

#[test]
fn tones_profile_keeps_a_sine_glide_clean() {
    // Four octaves in 1.5 s: Complex smears the moving partial.
    let x = glide(110.0, 1760.0, 1.5, 0.5);
    for &(ratio, semis) in &[(1.5, 0.0), (1.5, 3.0), (0.7, -5.0)] {
        let ((wt, lt), (wc, lc)) = tones_vs_complex(&x, ratio, semis);
        assert!(wt < 0.025 && wt < wc, "×{ratio} {semis:+} st: tones wobble {wt:.4} vs complex {wc:.4}");
        assert!(lt >= lc - 0.005 && lt > 0.9, "×{ratio} {semis:+} st: tones level {lt:.3} vs complex {lc:.3}");
        let y = mapped(&[x.clone()], &[(0.0, 0.0), (x.len() as f64, x.len() as f64 * ratio)], (x.len() as f64 * ratio) as usize, semis, Profile::Tones);
        assert!(purity(&y[0], 0.2, y[0].len() as f64 / SR - 0.2) > 0.99, "one clean partial");
    }
}

#[test]
fn uniform_map_matches_stretch_planar_bit_for_bit() {
    let (x, _) = bursts(2.0, 0.1, 0.25);
    let y: Vec<f32> = x.iter().zip(sine(220.0, 2.0, 0.2)).map(|(a, b)| a + b).collect();
    for &(ratio, semis) in &[(1.25, 0.0), (0.8, 3.0)] {
        let a = run(&[y.clone()], ratio, semis, true);
        let n_out = output_frames(y.len(), ratio);
        let b = mapped(&[y.clone()], &[(0.0, 0.0), (y.len() as f64, n_out as f64)], n_out, semis, Profile::Complex);
        assert!(a[0].iter().zip(&b[0]).all(|(u, v)| u.to_bits() == v.to_bits()), "×{ratio}");
    }
}

#[test]
fn piecewise_map_places_onsets_on_the_knots() {
    // Bursts every 0.25 s; first second at 2× (slow), the rest at 0.5×, plus a
    // 0.1 s lead-in of silence (the map starts before input frame 0).
    let (x, onsets) = bursts(2.0, 0.05, 0.25);
    let knots = [(0.0, 0.1 * SR), (1.0 * SR, 2.1 * SR), (2.0 * SR, 2.6 * SR)];
    let n_out = (2.6 * SR) as usize;
    let y = mapped(&[x.clone(), x.clone()], &knots, n_out, 0.0, Profile::Complex);
    assert_eq!(y[0].len(), n_out);
    let first = y[0].iter().position(|v| v.abs() > 1e-4).unwrap_or(0) as f64 / SR;
    // (pre-echo of the 120 ms window at 2× reaches ~140 ms ahead of the 0.2 s onset, at -80 dB)
    assert!(first > 0.05, "lead-in is silent until {first}");
    for &t in &onsets {
        let want = map_in_to_out(&knots, t * SR) / SR;
        let got = half_peak_onset(&y[0], want - 0.03, want + 0.03);
        assert!((got - want).abs() < 0.004, "onset {t}: at {got:.4}, want {want:.4}");
    }
    // Deterministic, and both channels match (same input).
    let z = mapped(&[x.clone(), x.clone()], &knots, n_out, 0.0, Profile::Complex);
    assert!(y == z, "deterministic");
    let d = y[0].iter().zip(&y[1]).fold(0f32, |m, (a, b)| m.max((a - b).abs()));
    assert!(d < 1e-3, "same input, same channel output: max diff {d}");
    // A map that starts inside the input skips the head; bad maps are errors.
    let late = mapped(&[x.clone()], &[(0.5 * SR, 0.0), (1.5 * SR, SR)], SR as usize, 0.0, Profile::Tones);
    let got = half_peak_onset(&late[0], 0.0, 0.2);
    assert!((got - (onsets[2] - 0.5)).abs() < 0.004, "skipped head: first onset at {got}");
    let c = AtomicBool::new(false);
    assert!(stretch_mapped(&[&x[..]], SR, &[(0.0, 0.0), (0.0, 1.0)], 10, 0.0, true, Profile::Complex, &c).is_err());
    assert!(stretch_mapped(&[&x[..]], SR, &[(0.0, 0.0)], 10, 0.0, true, Profile::Complex, &c).is_err());
    assert!(stretch_mapped(&[&x[..]], SR, &[(0.0, 0.0), (1.0, 1.0)], 0, 0.0, true, Profile::Complex, &c).unwrap()[0].is_empty());
}

// ── Pitch curves (stretch_mapped_curve, Krypt Voice "sing") ─────────────

/// Instantaneous frequency of a sine from upward zero crossings: (time s, Hz).
fn zero_cross_freq(x: &[f32]) -> Vec<(f64, f64)> {
    let mut ups = Vec::new();
    for i in 1..x.len() {
        if x[i - 1] < 0.0 && x[i] >= 0.0 {
            let f = x[i - 1] as f64 / (x[i - 1] as f64 - x[i] as f64);
            ups.push((i - 1) as f64 + f);
        }
    }
    ups.windows(2).map(|w| (0.5 * (w[0] + w[1]) / SR, SR / (w[1] - w[0]))).collect()
}

fn curved(input: &[f32], knots: &[(f64, f64)], n_out: usize, curve: &(dyn Fn(usize) -> f64 + Sync)) -> Vec<f32> {
    stretch_mapped_curve(&[input], SR, knots, n_out, curve, true, Profile::Tones, &AtomicBool::new(false)).expect("curved").remove(0)
}

#[test]
fn curve_step_lands_on_time() {
    let x = sine(220.0, 1.5, 0.3);
    let n = x.len();
    let step = (0.75 * SR) as usize;
    for (ratio, label) in [(1.0, "1×"), (1.6, "1.6×")] {
        let n_out = (n as f64 * ratio) as usize;
        let at = (step as f64 * ratio) as usize;
        let y = curved(&x, &[(0.0, 0.0), (n as f64, n_out as f64)], n_out, &|o| if o < at { 0.0 } else { 7.0 });
        let f = zero_cross_freq(&y);
        let mid = 220.0 * 2f64.powf(3.5 / 12.0);
        let t = f.iter().find(|(t, hz)| *t > 0.3 * ratio && *hz > mid).map(|p| p.0).unwrap();
        let want = at as f64 / SR;
        eprintln!("{label}: step heard at {t:.4} s, set at {want:.4} s");
        assert!((t - want).abs() < 0.015, "{label}: step heard at {t:.4} s, want {want:.4}");
        // Both sides settle on their pitch.
        let before: Vec<f64> = f.iter().filter(|p| p.0 > want - 0.25 && p.0 < want - 0.05).map(|p| p.1).collect();
        let after: Vec<f64> = f.iter().filter(|p| p.0 > want + 0.05 && p.0 < want + 0.25).map(|p| p.1).collect();
        let avg = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        assert!((1200.0 * (avg(&before) / 220.0).log2()).abs() < 10.0);
        assert!((1200.0 * (avg(&after) / (220.0 * 2f64.powf(7.0 / 12.0))).log2()).abs() < 10.0);
    }
}

#[test]
fn constant_curve_matches_constant_shift() {
    let x = vibrato_voice(1.0, 0.3);
    let n = x.len();
    let knots = [(0.0, 0.0), (n as f64, 1.3 * n as f64)];
    let n_out = (1.3 * n as f64) as usize;
    let a = mapped(std::slice::from_ref(&x), &knots, n_out, 3.0, Profile::Tones).remove(0);
    let b = curved(&x, &knots, n_out, &|_| 3.0);
    // Not bit-identical (one process() call per hop instead of per 0.5 s), but within -40 dB of the signal.
    let d = a.iter().zip(&b).fold(0f32, |m, (u, v)| m.max((u - v).abs()));
    assert!(d < 0.01 * 0.3 * 6.0, "max diff {d}");
    // Deterministic.
    assert_eq!(b, curved(&x, &knots, n_out, &|_| 3.0));
}

#[test]
fn curve_follows_a_vibrato() {
    // A steady sine given ±50 cents at 5.5 Hz by the curve.
    let x = sine(300.0, 1.0, 0.3);
    let n = x.len();
    let y = curved(&x, &[(0.0, 0.0), (n as f64, n as f64)], n, &|o| 0.5 * (2.0 * PI * 5.5 * o as f64 / SR).sin());
    let c: Vec<f64> = zero_cross_freq(&y).iter().filter(|p| p.0 > 0.2 && p.0 < 0.9).map(|p| 1200.0 * (p.1 / 300.0).log2()).collect();
    let (lo, hi) = c.iter().fold((f64::MAX, f64::MIN), |(a, b), &v| (a.min(v), b.max(v)));
    assert!(hi > 35.0 && hi < 70.0 && lo < -35.0 && lo > -70.0, "range {lo:.0}..{hi:.0}");
}
