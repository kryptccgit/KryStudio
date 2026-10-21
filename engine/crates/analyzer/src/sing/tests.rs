use super::*;
use crate::features::median;
use crate::protocol::SingSegment;

const SR: f64 = 24_000.0;

fn tone(secs: f64, f0: f64) -> Vec<f32> {
    (0..(secs * SR) as usize)
        .map(|i| {
            let t = i as f64 / SR;
            (1..=8).map(|h| (2.0 * std::f64::consts::PI * f0 * h as f64 * t).sin() / h as f64).sum::<f64>() as f32 * 0.25
        })
        .collect()
}

fn noise(secs: f64) -> Vec<f32> {
    let mut seed = 99u32;
    (0..(secs * SR) as usize)
        .map(|_| {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            ((seed >> 16) as f32 / 32768.0 - 1.0) * 0.3
        })
        .collect()
}

fn seg(src: (f64, f64), out: f64, dur: f64, midi: f64) -> SingSegment {
    SingSegment { src_start_sec: src.0, src_end_sec: src.1, out_start_sec: out, dur_sec: dur, midi }
}

fn cents(f: f64, target: f64) -> f64 {
    1200.0 * (f / target).log2()
}

fn envelope(y: &[f32]) -> Vec<f32> {
    y.chunks(48).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).sqrt()).collect()
}

fn note_f0(y: &[f32], a: f64, b: f64) -> f64 {
    let part = &y[(a * SR) as usize..(b * SR) as usize];
    let fr = voicing_track(part, SR as f32, 0.01);
    f64::from(median_f0(&fr, 3).expect("note is unvoiced"))
}

const NOTES: [(f64, f64, f64); 4] = [(0.2, 0.5, 60.0), (0.9, 0.3, 64.0), (1.4, 0.8, 67.0), (2.4, 0.25, 55.0)];

fn notes_segments() -> Vec<SingSegment> {
    NOTES.iter().enumerate().map(|(i, &(o, d, m))| seg((0.1 + 0.4 * i as f64, 0.5 + 0.4 * i as f64), o, d, m)).collect()
}

#[test]
fn pitches_and_places_each_note() {
    let x = tone(2.0, 180.0);
    let (y, segs) = render(&x, SR, &notes_segments(), 0.0, 0.0, &JobCtx::detached()).unwrap();
    assert_eq!(segs.len(), 4);
    let env = envelope(&y);
    for (s, &(o, d, m)) in segs.iter().zip(&NOTES) {
        let f0 = f64::from(s.f0_hz.expect("voiced"));
        assert!(cents(f0, 180.0).abs() < 10.0, "measured {f0}");
        assert!((f64::from(s.shift_st) - 12.0 * (midi_hz(m) / f0).log2()).abs() < 1e-3);
        let got = note_f0(&y, o + 0.05, o + d - 0.05);
        assert!(cents(got, midi_hz(m)).abs() < 20.0, "note {m}: {got:.2} Hz vs {:.2} Hz", midi_hz(m));
        let (fa, fb) = ((o * 500.0) as usize, ((o + d) * 500.0) as usize);
        let level = median(&env[fa + 10..fb - 10]);
        let from = fa.saturating_sub(25);
        let on = (from..fb).find(|&i| env[i] > 0.5 * level).unwrap() as f64 / 500.0;
        let off = (fa..(fb + 25).min(env.len())).rev().find(|&i| env[i] > 0.5 * level).unwrap() as f64 / 500.0 + 0.002;
        assert!((on - o).abs() <= 0.005, "note {m}: onset {on:.4} vs {o:.4}");
        assert!((off - (o + d)).abs() <= 0.005, "note {m}: offset {off:.4} vs {:.4}", o + d);
    }
    let rest = &y[(0.75 * SR) as usize..(0.85 * SR) as usize];
    assert!(rest.iter().all(|v| v.abs() < 1e-3));
    let peak = y.iter().fold(0f32, |m, v| m.max(v.abs()));
    assert!((peak - 0.891).abs() < 0.01, "{peak}");
}

#[test]
fn unvoiced_segments_pass_through_unpitched() {
    let mut x = noise(0.3);
    x.extend(tone(0.5, 200.0));
    let segs = [seg((0.0, 0.3), 0.0, 0.45, 72.0), seg((0.3, 0.8), 0.45, 0.5, 57.0)];
    let (y, r) = render(&x, SR, &segs, 0.0, 0.0, &JobCtx::detached()).unwrap();
    assert_eq!(r[0].f0_hz, None);
    assert_eq!(r[0].shift_st, 0.0);
    assert!(r[1].f0_hz.is_some());
    let part = &y[(0.02 * SR) as usize..(0.43 * SR) as usize];
    let rms = (part.iter().map(|v| v * v).sum::<f32>() / part.len() as f32).sqrt();
    assert!(rms > 0.05, "{rms}");
    assert_eq!(median_f0(&voicing_track(part, SR as f32, 0.01), 3), None);
    assert!(cents(note_f0(&y, 0.5, 0.9), midi_hz(57.0)).abs() < 20.0);
}

#[test]
fn deterministic() {
    let x = tone(2.0, 180.0);
    let a = render(&x, SR, &notes_segments(), 0.3, 0.04, &JobCtx::detached()).unwrap().0;
    let b = render(&x, SR, &notes_segments(), 0.3, 0.04, &JobCtx::detached()).unwrap().0;
    assert_eq!(a, b);
}

#[test]
fn vibrato_and_glide_move_the_pitch() {
    let x = tone(1.2, 180.0);
    let segs = [seg((0.0, 0.4), 0.0, 0.5, 60.0), seg((0.4, 1.0), 0.5, 1.5, 64.0)];
    let (y, _) = render(&x, SR, &segs, 1.0, 0.08, &JobCtx::detached()).unwrap();
    let part = &y[(1.4 * SR) as usize..(1.95 * SR) as usize];
    let f: Vec<f64> = voicing_track(part, SR as f32, 0.005).iter().filter_map(|v| v.f0).map(|f| cents(f64::from(f), midi_hz(64.0))).collect();
    let (lo, hi) = f.iter().fold((f64::MAX, f64::MIN), |(a, b), &c| (a.min(c), b.max(c)));
    assert!(hi > 30.0 && lo < -30.0 && hi < 80.0 && lo > -80.0, "vibrato range {lo:.0}..{hi:.0} cents");
    let mean = f.iter().sum::<f64>() / f.len() as f64;
    assert!(mean.abs() < 20.0, "mean {mean}");
    let start = note_f0(&y, 0.505, 0.54);
    assert!(cents(start, midi_hz(64.0)) < -100.0, "glide start {start:.1} Hz");
}

#[test]
fn touching_notes_join_without_clicks() {
    let x = tone(1.2, 180.0);
    let segs = [seg((0.0, 0.3), 0.0, 0.4, 62.0), seg((0.3, 0.6), 0.4, 0.4, 62.0), seg((0.6, 0.9), 0.8, 0.4, 65.0)];
    let (y, _) = render(&x, SR, &segs, 0.0, 0.0, &JobCtx::detached()).unwrap();
    let rms6 = |c: f64| {
        let w = &y[((c - 0.003) * SR) as usize..((c + 0.003) * SR) as usize];
        (w.iter().map(|v| v * v).sum::<f32>() / w.len() as f32).sqrt()
    };
    let level = median(&(0..100).map(|i| rms6(0.05 + 0.003 * i as f64)).collect::<Vec<_>>());
    for join in [0.4, 0.8] {
        for k in -10..=10 {
            let c = join + 0.001 * f64::from(k);
            assert!(rms6(c) > 0.5 * level, "dip at {c:.3} s: {} vs {level}", rms6(c));
        }
    }
}

#[test]
fn knots_keep_consonants_natural() {
    let (k, tail) = knots_for(1000, 100, 3000, Some((300, 800)));
    assert_eq!(k[0], (0.0, 0.0));
    assert_eq!(k[1], (300.0, 300.0));
    assert!((k[2].0 - 800.0).abs() < 1e-9 && (k[2].1 - 2800.0).abs() < 1e-9);
    assert_eq!(k[3], (1000.0, 3000.0));
    assert_eq!(tail, 1.0);
    let (k, _) = knots_for(1000, 0, 500, Some((300, 800)));
    assert_eq!(k, vec![(0.0, 0.0), (1000.0, 500.0)]);
    let (k, tail) = knots_for(1000, 0, 20_000, Some((450, 550)));
    assert!(tail > 1.0);
    assert!(((k[2].1 - k[1].1) / (k[2].0 - k[1].0) - MAX_VOWEL_RATIO).abs() < 1e-9);
}

#[test]
fn rejects_bad_segments() {
    let ctx = JobCtx::detached();
    let bad = |segs: Vec<SingSegment>| {
        let a = SingArgs { path: "x.wav".into(), out: "y.wav".into(), segments: segs, vibrato: None, glide_ms: None };
        match run(&a, &ctx) {
            Err(JobError::Failed(m)) => m,
            _ => "ok".into(),
        }
    };
    assert!(bad(vec![]).contains("no segments"));
    assert!(bad(vec![seg((1.0, 0.5), 0.0, 1.0, 60.0)]).contains("empty"));
    assert!(bad(vec![seg((0.0, 0.5), 0.0, 1.0, 200.0)]).contains("0..127"));
    assert!(bad(vec![seg((0.0, f64::NAN), 0.0, 1.0, 60.0)]).contains("not a number"));
}

#[test]
fn writes_a_wav_at_the_source_rate() {
    let dir = std::env::temp_dir().join(format!("krypt-sing-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("speech.wav");
    crate::wav::write_mono(src.to_str().unwrap(), &tone(1.0, 180.0), 24_000).unwrap();
    let out = dir.join("sung.wav");
    let a = SingArgs { path: src.to_string_lossy().into(), out: out.to_string_lossy().into(), segments: vec![seg((0.1, 0.6), 0.25, 1.0, 62.0)], vibrato: Some(0.2), glide_ms: Some(40.0) };
    let r = run(&a, &JobCtx::detached()).unwrap();
    let rd = hound::WavReader::open(&out).unwrap();
    assert_eq!(rd.spec().sample_rate, 24_000);
    assert_eq!(rd.spec().channels, 1);
    assert!((r.duration_sec - 1.254).abs() < 0.002, "{}", r.duration_sec);
    assert_eq!(r.segments.len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn speed_per_second_of_output() {
    let x = tone(4.0, 180.0);
    let segs: Vec<SingSegment> = (0..16).map(|i| seg((0.2 * i as f64, 0.2 * i as f64 + 0.2), 0.5 * i as f64, 0.5, 60.0 + (i % 5) as f64)).collect();
    let t = std::time::Instant::now();
    let (y, _) = render(&x, SR, &segs, 0.2, 0.04, &JobCtx::detached()).unwrap();
    eprintln!("sing: {:.1} s of output in {:.3} s", y.len() as f64 / SR, t.elapsed().as_secs_f64());
}
