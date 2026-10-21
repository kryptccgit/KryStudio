use super::*;
use crate::instruments::triosc_legacy;
use crate::Instrument;

const SR: f32 = 48000.0;
const BLOCK: usize = 128;

fn idx(id: &str) -> usize {
    descriptor().param_index(id).unwrap_or_else(|| panic!("no param {id}"))
}

fn set_all(inst: &mut dyn Instrument, d: &PluginDescriptor, params: &[(&str, f32)]) {
    for (id, v) in params {
        inst.set_param(d.param_index(id).unwrap_or_else(|| panic!("no param {id}")), *v);
    }
}

fn clean(extra: &[(&str, f32)]) -> TriOsc {
    let mut t = TriOsc::new(SR, BLOCK);
    let base: &[(&str, f32)] = &[
        ("osc1Shape", 0.0),
        ("osc1Level", 0.8),
        ("osc2Level", 0.0),
        ("osc3Level", 0.0),
        ("unisonDetune", 0.0),
        ("drift", 0.0),
        ("cutoff", 20000.0),
        ("reso", 0.0),
        ("filterEnvAmount", 0.0),
        ("filterKeyTrack", 0.0),
        ("ampAttack", 0.1),
        ("ampSustain", 1.0),
        ("gain", 0.0),
    ];
    set_all(&mut t, &descriptor(), base);
    set_all(&mut t, &descriptor(), extra);
    t
}

#[derive(Clone, Copy)]
enum Ev {
    On(u8, f32, f32),
    Off(u8),
}

struct Song {
    bpm: f64,
    beat: f64,
    playing: bool,
}

impl Song {
    fn at(bpm: f64, beat: f64) -> Self {
        Self { bpm, beat, playing: true }
    }
}

fn render(inst: &mut dyn Instrument, frames: usize, song: &mut Song, events: &[(usize, Ev)]) -> (Vec<f32>, Vec<f32>) {
    let mut l = vec![0.0f32; frames];
    let mut r = vec![0.0f32; frames];
    let mut at = 0;
    while at < frames {
        let n = (frames - at).min(BLOCK);
        for &(f, e) in events.iter().filter(|(f, _)| *f >= at && *f < at + n) {
            match e {
                Ev::On(k, v, pan) => inst.note_on(f - at, k, k as f32, v, NoteExtras { pan, ..Default::default() }),
                Ev::Off(k) => inst.note_off(f - at, k),
            }
        }
        let ctx = ProcessContext { sample_rate: SR, bpm: song.bpm, beats_per_bar: 4.0, playing: song.playing, beat_pos: song.beat, frames: n };
        inst.process(&ctx, [&mut l[at..at + n], &mut r[at..at + n]]);
        if song.playing {
            song.beat += n as f64 * song.bpm / 60.0 / SR as f64;
        }
        at += n;
    }
    (l, r)
}

fn secs(s: f64) -> usize {
    (s * SR as f64).round() as usize
}

fn envelope(x: &[f32]) -> Vec<f32> {
    x.chunks(48).map(|c| c.iter().fold(0.0f32, |m, v| m.max(v.abs()))).collect()
}

fn env_period(env: &[f32], skip_ms: usize) -> (f64, usize) {
    let e = &env[skip_ms..env.len() - 1];
    let (lo, hi) = e.iter().fold((f32::MAX, 0.0f32), |(a, b), v| (a.min(*v), b.max(*v)));
    let mid = 0.5 * (lo + hi);
    let mut xs = vec![];
    for i in 1..e.len() {
        if e[i - 1] < mid && e[i] >= mid {
            let t = (mid - e[i - 1]) / (e[i] - e[i - 1]);
            xs.push((i - 1) as f64 + t as f64);
        }
    }
    assert!(xs.len() >= 3, "too few LFO cycles: {}", xs.len());
    ((xs[xs.len() - 1] - xs[0]) / (xs.len() - 1) as f64 * 0.001, xs.len())
}

fn freq(x: &[f32]) -> f64 {
    let mut xs = vec![];
    for i in 1..x.len() {
        if x[i - 1] < 0.0 && x[i] >= 0.0 {
            xs.push((i - 1) as f64 + (-x[i - 1] / (x[i] - x[i - 1])) as f64);
        }
    }
    assert!(xs.len() >= 3, "no tone");
    (xs.len() - 1) as f64 / (xs[xs.len() - 1] - xs[0]) * SR as f64
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

fn win(x: &[f32], from: f64, to: f64) -> &[f32] {
    &x[secs(from)..secs(to)]
}

#[test]
fn existing_patches_are_bit_identical_to_the_pre_lfo_synth() {
    type Patch = (&'static [(&'static str, f32)], bool, f32);
    let patches: [Patch; 5] = [
        (&[], false, 0.0),
        (
            &[
                ("gain", -9.5),
                ("osc2Fine", 7.0),
                ("osc2Level", 0.7),
                ("osc3Shape", 1.0),
                ("osc3Coarse", 12.0),
                ("osc3Level", 0.25),
                ("unisonDetune", 0.25),
                ("drift", 0.4),
                ("cutoff", 1800.0),
                ("reso", 0.1),
                ("filterEnvAmount", 0.15),
                ("filterEnvAttack", 400.0),
                ("filterEnvDecay", 1200.0),
                ("ampAttack", 500.0),
                ("ampSustain", 1.0),
                ("ampRelease", 1400.0),
            ],
            false,
            0.0,
        ),
        (
            &[("gain", -8.0), ("osc2Level", 0.0), ("osc3Level", 0.0), ("drift", 0.05), ("cutoff", 380.0), ("reso", 0.78), ("filterEnvAmount", 0.65), ("filterEnvDecay", 180.0), ("filterEnvSustain", 0.0), ("ampRelease", 50.0)],
            true,
            70.0,
        ),
        (
            &[
                ("gain", 1.5),
                ("osc2Fine", 9.0),
                ("osc2Level", 0.7),
                ("osc3Shape", 3.0),
                ("osc3Level", 0.35),
                ("unisonDetune", 0.12),
                ("drift", 0.35),
                ("cutoff", 3200.0),
                ("reso", 0.22),
                ("filterEnvSustain", 0.35),
                ("ampSustain", 0.85),
            ],
            true,
            45.0,
        ),
        (
            &[("osc2Shape", 5.0), ("osc2Level", 0.5), ("osc3Shape", 4.0), ("filterType", 2.0), ("reso", 0.6), ("drift", 1.0), ("unisonDetune", 0.8)],
            false,
            0.0,
        ),
    ];
    let events: &[(usize, Ev)] = &[
        (10, Ev::On(48, 0.9, 0.0)),
        (300, Ev::On(55, 0.6, -0.4)),
        (301, Ev::On(60, 0.8, 0.5)),
        (secs(0.3), Ev::Off(55)),
        (secs(0.35), Ev::On(64, 1.0, 0.0)),
        (secs(0.5), Ev::Off(48)),
        (secs(0.6), Ev::Off(60)),
        (secs(0.7), Ev::Off(64)),
        (secs(0.8), Ev::On(36, 0.7, 0.0)),
        (secs(1.0), Ev::Off(36)),
    ];
    let (dn, dl) = (descriptor(), triosc_legacy::descriptor());
    for (i, (patch, mono, glide)) in patches.iter().enumerate() {
        let mut new = TriOsc::new(SR, BLOCK);
        let mut old = triosc_legacy::TriOsc::new(SR, BLOCK);
        set_all(&mut new, &dn, patch);
        set_all(&mut old, &dl, patch);
        new.set_voice_mode(*mono, *glide);
        old.set_voice_mode(*mono, *glide);
        let (a, b) = (render(&mut new, secs(1.6), &mut Song::at(128.0, 0.0), events), render(&mut old, secs(1.6), &mut Song::at(128.0, 0.0), events));
        let peak = a.0.iter().chain(&a.1).fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak > 0.01, "patch {i} silent");
        let diff = a.0.iter().zip(&b.0).chain(a.1.iter().zip(&b.1)).fold(0.0f32, |m, (x, y)| m.max((x - y).abs()));
        assert!(diff <= peak * 1e-6, "patch {i}: differs by {diff} (peak {peak}), above -120 dB");
        assert_eq!(diff, 0.0, "patch {i}: not bit-identical ({diff})");
    }
}

fn tremolo_period(extra: &[(&str, f32)], bpm: f64, seconds: f64) -> f64 {
    let mut p = vec![("lfo1Dest", 2.0), ("lfo1Amount", 1.0), ("lfo1Shape", 0.0)];
    p.extend_from_slice(extra);
    let mut t = clean(&p);
    let (l, _) = render(&mut t, secs(seconds), &mut Song::at(bpm, 0.0), &[(0, Ev::On(84, 1.0, 0.0))]);
    env_period(&envelope(&l), 30).0
}

#[test]
fn free_rate_in_hz_is_accurate() {
    for hz in [0.5f32, 4.0, 11.0] {
        let p = tremolo_period(&[("lfo1Rate", hz)], 120.0, 1.0 + 4.0 / hz as f64);
        let want = 1.0 / hz as f64;
        assert!((p / want - 1.0).abs() < 0.01, "{hz} Hz: period {p} s, want {want}");
    }
}

#[test]
fn synced_rates_follow_the_tempo() {
    for (bpm, div) in [(120.0, 7usize), (140.0, 9), (100.0, 5), (174.0, 4), (90.0, 13), (150.0, 15)] {
        let beats = LFO_DIV_BEATS[div];
        let want = beats * 60.0 / bpm;
        let p = tremolo_period(&[("lfo1Sync", 1.0), ("lfo1Division", div as f32)], bpm, 0.1 + want * 5.0);
        assert!((p / want - 1.0).abs() < 0.01, "{} at {bpm} bpm: period {p} s, want {want}", LFO_DIVISIONS[div]);
    }
    assert_eq!(LFO_DIVISIONS.len(), LFO_DIV_BEATS.len());
    assert_eq!(LFO_DIV_BEATS[1], 0.125);
    assert_eq!(LFO_DIV_BEATS[18], 32.0);
    for (i, name) in LFO_DIVISIONS.iter().enumerate() {
        let straight = LFO_DIVISIONS.iter().position(|n| *n == name.trim_end_matches(['T', 'D']));
        if let (Some(s), true) = (straight, name.ends_with('T') || name.ends_with('D')) {
            let k = if name.ends_with('T') { 2.0 / 3.0 } else { 1.5 };
            assert!((LFO_DIV_BEATS[i] - LFO_DIV_BEATS[s] * k).abs() < 1e-12, "{name}");
        }
    }
}

fn first_dip(l: &[f32], from: usize) -> usize {
    let env = envelope(l);
    let pk = env.iter().fold(0.0f32, |m, v| m.max(*v));
    let w = env.iter().enumerate().skip(from / 48 + 2).find(|(_, v)| **v < pk * 0.5).unwrap().0;
    w * 48
}

#[test]
fn free_lfo_is_locked_to_the_song_and_retrigger_restarts_per_note() {
    let base = [("lfo1Dest", 2.0), ("lfo1Amount", 1.0), ("lfo1Shape", 4.0), ("lfo1Sync", 1.0), ("lfo1Division", 10.0)];
    let start = secs(0.1);
    let mut free = clean(&base);
    let (l, _) = render(&mut free, secs(1.0), &mut Song::at(120.0, 0.0), &[(start, Ev::On(84, 1.0, 0.0))]);
    let d = first_dip(&l, start);
    assert!((d as f64 / SR as f64 - 0.25).abs() < 0.003, "song-locked dip at {} s, want 0.25", d as f64 / SR as f64);
    let mut free = clean(&base);
    let (l, _) = render(&mut free, secs(1.0), &mut Song::at(120.0, 0.25), &[(secs(0.05), Ev::On(84, 1.0, 0.0))]);
    let d = first_dip(&l, secs(0.05));
    assert!((d as f64 / SR as f64 - 0.125).abs() < 0.003, "song-locked dip at {} s, want 0.125", d as f64 / SR as f64);

    let mut p = base.to_vec();
    p.push(("lfo1Retrig", 1.0));
    let mut re = clean(&p);
    let (l, _) = render(&mut re, secs(1.0), &mut Song::at(120.0, 0.0), &[(start, Ev::On(84, 1.0, 0.0))]);
    let d = first_dip(&l, start);
    assert!(((d - start) as f64 / SR as f64 - 0.25).abs() < 0.003, "retriggered dip {} s after the note", (d - start) as f64 / SR as f64);
}

#[test]
fn song_locked_lfos_render_deterministically() {
    for extra in [vec![("lfo1Shape", 0.0), ("lfo1Rate", 3.3)], vec![("lfo1Shape", 5.0), ("lfo1Sync", 1.0), ("lfo1Division", 4.0)], vec![("lfo1Shape", 6.0), ("lfo1Rate", 7.0)]] {
        let mut p = vec![("lfo1Dest", 0.0), ("lfo1Amount", 0.3), ("lfo2Dest", 3.0), ("lfo2Amount", 0.8), ("lfo2Rate", 1.7)];
        p.extend(extra);
        let notes = [(100, Ev::On(60, 0.8, 0.0)), (secs(0.4), Ev::On(67, 0.8, 0.0)), (secs(0.9), Ev::Off(60)), (secs(1.0), Ev::Off(67))];
        let mut a = clean(&p);
        let ra = render(&mut a, secs(1.5), &mut Song::at(120.0, 0.0), &notes);
        let mut b = clean(&p);
        let mut stopped = Song { bpm: 120.0, beat: 0.0, playing: false };
        render(&mut b, secs(0.77), &mut stopped, &[(5, Ev::On(50, 1.0, 0.0)), (secs(0.5), Ev::Off(50))]);
        render(&mut b, secs(1.0), &mut stopped, &[]);
        assert!(!b.is_active());
        let rb = render(&mut b, secs(1.5), &mut Song::at(120.0, 0.0), &notes);
        assert_eq!(ra, rb, "free LFO render depends on what happened before playback ({p:?})");
    }
}

#[test]
fn fade_in_ramps_the_depth() {
    let mut t = clean(&[("lfo1Dest", 2.0), ("lfo1Amount", 1.0), ("lfo1Rate", 8.0), ("lfo1Retrig", 1.0), ("lfo1Fade", 1000.0)]);
    let (l, _) = render(&mut t, secs(1.5), &mut Song::at(120.0, 0.0), &[(0, Ev::On(84, 1.0, 0.0))]);
    let env = envelope(&l);
    let depth = |a: usize, b: usize| {
        let (lo, hi) = env[a..b].iter().fold((f32::MAX, 0.0f32), |(x, y), v| (x.min(*v), y.max(*v)));
        1.0 - lo / hi
    };
    let early = depth(5, 130);
    let mid = depth(440, 565);
    let late = depth(1100, 1475);
    assert!(early < 0.15, "early tremolo depth {early}");
    assert!(mid > 0.35 && mid < 0.65, "half-way depth {mid}");
    assert!(late > 0.95, "late depth {late}");
}

fn square(dest: f32, amount: f32, extra: &[(&str, f32)]) -> TriOsc {
    let mut p = vec![("lfo1Dest", dest), ("lfo1Amount", amount), ("lfo1Shape", 4.0), ("lfo1Rate", 2.0), ("lfo1Retrig", 1.0)];
    p.extend_from_slice(extra);
    clean(&p)
}

#[test]
fn pitch_lfo_moves_the_fundamental() {
    let mut t = square(0.0, 1.0 / 12.0, &[]);
    let (l, _) = render(&mut t, secs(0.5), &mut Song::at(120.0, 0.0), &[(0, Ev::On(69, 1.0, 0.0))]);
    let hi = freq(win(&l, 0.03, 0.22));
    let lo = freq(win(&l, 0.28, 0.47));
    assert!((hi / 440.0 - 2f64.powf(1.0 / 12.0)).abs() < 0.003, "up: {hi} Hz");
    assert!((lo / 440.0 - 2f64.powf(-1.0 / 12.0)).abs() < 0.003, "down: {lo} Hz");
    let mut t = square(0.0, 1.0, &[]);
    let (l, _) = render(&mut t, secs(0.5), &mut Song::at(120.0, 0.0), &[(0, Ev::On(57, 1.0, 0.0))]);
    assert!((freq(win(&l, 0.03, 0.22)) / 440.0 - 1.0).abs() < 0.003);
    assert!((freq(win(&l, 0.28, 0.47)) / 110.0 - 1.0).abs() < 0.003);
}

#[test]
fn cutoff_lfo_moves_the_brightness() {
    let bright = |x: &[f32]| {
        let d: Vec<f32> = x.windows(2).map(|w| w[1] - w[0]).collect();
        rms(&d) / rms(x)
    };
    let mut t = square(1.0, 1.0, &[("osc1Shape", 2.0), ("cutoff", 600.0)]);
    let (l, _) = render(&mut t, secs(0.5), &mut Song::at(120.0, 0.0), &[(0, Ev::On(45, 1.0, 0.0))]);
    let (hi, lo) = (bright(win(&l, 0.05, 0.22)), bright(win(&l, 0.3, 0.47)));
    assert!(hi > lo * 3.0, "cutoff LFO: bright {hi} vs dark {lo}");
}

#[test]
fn amp_lfo_is_a_tremolo_and_negative_amounts_invert_it() {
    for (amount, first_loud) in [(1.0f32, true), (-1.0, false), (0.5, true)] {
        let mut t = square(2.0, amount, &[]);
        let (l, _) = render(&mut t, secs(0.5), &mut Song::at(120.0, 0.0), &[(0, Ev::On(84, 1.0, 0.0))]);
        let (a, b) = (rms(win(&l, 0.03, 0.22)), rms(win(&l, 0.28, 0.47)));
        let (loud, quiet) = if first_loud { (a, b) } else { (b, a) };
        let want = 1.0 - amount.abs();
        assert!((quiet / loud - want).abs() < 0.02, "amount {amount}: quiet/loud {}", quiet / loud);
    }
}

#[test]
fn pan_lfo_swings_left_and_right() {
    let mut t = square(3.0, 1.0, &[]);
    let (l, r) = render(&mut t, secs(0.5), &mut Song::at(120.0, 0.0), &[(0, Ev::On(72, 1.0, 0.0))]);
    let (l1, r1) = (rms(win(&l, 0.03, 0.22)), rms(win(&r, 0.03, 0.22)));
    let (l2, r2) = (rms(win(&l, 0.28, 0.47)), rms(win(&r, 0.28, 0.47)));
    assert!(r1 > 0.1 && l1 < r1 * 0.01, "first half should be hard right: {l1} / {r1}");
    assert!(l2 > 0.1 && r2 < l2 * 0.01, "second half should be hard left: {l2} / {r2}");
}

#[test]
fn detune_lfo_spreads_the_unison_pair() {
    let wobble = |amount: f32| {
        let mut t = square(4.0, amount, &[("lfo1Rate", 0.5)]);
        let (l, _) = render(&mut t, secs(1.0), &mut Song::at(120.0, 0.0), &[(0, Ev::On(84, 1.0, 0.0))]);
        let env = envelope(win(&l, 0.1, 0.9));
        let mean = env.iter().sum::<f32>() / env.len() as f32;
        (env.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / env.len() as f32).sqrt() / mean
    };
    let (still, beating) = (wobble(0.0), wobble(1.0));
    assert!(still < 0.01, "no detune should not beat: {still}");
    assert!(beating > 0.2, "detune LFO should make the pair beat: {beating}");
}

#[test]
fn mix_lfo_crossfades_osc_1_and_2() {
    let mut t = square(5.0, 1.0, &[("osc2Shape", 0.0), ("osc2Coarse", 12.0), ("osc2Fine", 0.0), ("osc2Level", 0.8)]);
    let (l, _) = render(&mut t, secs(0.5), &mut Song::at(120.0, 0.0), &[(0, Ev::On(57, 1.0, 0.0))]);
    let hi = freq(win(&l, 0.03, 0.22));
    let lo = freq(win(&l, 0.28, 0.47));
    assert!((hi / 440.0 - 1.0).abs() < 0.005, "positive half = osc 2 only: {hi}");
    assert!((lo / 220.0 - 1.0).abs() < 0.005, "negative half = osc 1 only: {lo}");
}

#[test]
fn two_lfos_stack_on_different_destinations() {
    let mut t = clean(&[
        ("lfo1Dest", 3.0),
        ("lfo1Amount", 1.0),
        ("lfo1Shape", 4.0),
        ("lfo1Rate", 2.0),
        ("lfo1Retrig", 1.0),
        ("lfo2Dest", 0.0),
        ("lfo2Amount", 1.0),
        ("lfo2Shape", 4.0),
        ("lfo2Rate", 2.0),
        ("lfo2Retrig", 1.0),
    ]);
    let (l, r) = render(&mut t, secs(0.5), &mut Song::at(120.0, 0.0), &[(0, Ev::On(57, 1.0, 0.0))]);
    assert!((freq(win(&r, 0.03, 0.22)) / 440.0 - 1.0).abs() < 0.003);
    assert!((freq(win(&l, 0.28, 0.47)) / 110.0 - 1.0).abs() < 0.003);
}

#[test]
fn random_shapes_are_deterministic_held_and_smooth() {
    for n in -3i64..200 {
        let c = n as f64;
        let a = lfo_value(5, c + 0.01, 7);
        assert_eq!(a, lfo_value(5, c + 0.99, 7));
        assert!((-1.0..1.0).contains(&a));
        let s0 = lfo_value(6, c + 1.0 - 1e-6, 7);
        let s1 = lfo_value(6, c + 1.0, 7);
        assert!((s0 - s1).abs() < 1e-4, "smooth random jumps at {n}");
        assert_eq!(lfo_value(6, c, 7), lfo_value(5, c, 7));
    }
    let distinct = (0..64).map(|n| lfo_value(5, n as f64, 7).to_bits()).collect::<std::collections::HashSet<_>>();
    assert!(distinct.len() > 60, "S&H values repeat");
    let mean = (0..4096).map(|n| lfo_value(5, n as f64, 9) as f64).sum::<f64>() / 4096.0;
    assert!(mean.abs() < 0.05, "S&H is biased: {mean}");
}

#[test]
fn sample_and_hold_pitch_steps_on_the_grid() {
    let mut t = clean(&[("lfo1Dest", 0.0), ("lfo1Amount", 0.25), ("lfo1Shape", 5.0), ("lfo1Sync", 1.0), ("lfo1Division", 4.0)]);
    let (l, _) = render(&mut t, secs(1.0), &mut Song::at(120.0, 0.0), &[(0, Ev::On(69, 1.0, 0.0))]);
    let mut steps = vec![];
    for s in 0..8 {
        let t0 = s as f64 * 0.125;
        let a = freq(win(&l, t0 + 0.01, t0 + 0.06));
        let b = freq(win(&l, t0 + 0.065, t0 + 0.115));
        assert!((a / b - 1.0).abs() < 0.003, "step {s} not held: {a} vs {b}");
        steps.push(a);
    }
    let moved = steps.windows(2).filter(|w| (w[0] / w[1] - 1.0).abs() > 0.01).count();
    assert!(moved >= 5, "S&H barely moves: {steps:?}");
    assert!(steps.iter().all(|f| *f > 440.0 * 0.70 && *f < 440.0 * 1.42), "S&H beyond ±3 st: {steps:?}");
}

#[test]
fn amount_changes_are_smoothed() {
    let mut t = square(2.0, 0.0, &[("lfo1Rate", 0.5)]);
    let mut song = Song::at(120.0, 0.0);
    let (a, _) = render(&mut t, secs(1.2), &mut song, &[(0, Ev::On(84, 1.0, 0.0))]);
    t.set_param(idx("lfo1Amount"), 1.0);
    let (b, _) = render(&mut t, secs(0.2), &mut song, &[]);
    let before = envelope(&a[a.len() - 4800..]).iter().fold(0.0f32, |m, v| m.max(*v));
    let env = envelope(&b);
    assert!(env[1] > before * 0.85, "gain dropped instantly: {} → {}", before, env[1]);
    assert!(env[150] < before * 0.02, "tremolo never engaged: {}", env[150]);
    let max_step = env.windows(2).map(|w| (w[0] - w[1]).abs()).fold(0.0f32, f32::max);
    assert!(max_step < before * 0.1, "gain changes {max_step} per ms (zipper)");
}

#[test]
fn every_lfo_param_is_off_by_default() {
    let d = descriptor();
    for p in d.params.iter().filter(|p| p.id.starts_with("lfo")) {
        if p.id.ends_with("Amount") || p.id.ends_with("Fade") || p.id.ends_with("Sync") || p.id.ends_with("Retrig") {
            assert_eq!(p.default, 0.0, "{}", p.id);
        }
    }
    assert_eq!(d.params.iter().filter(|p| p.id.starts_with("lfo")).count(), 16);
    assert_eq!(d.param_index("lfo1Shape"), Some(triosc_legacy::descriptor().params.len()));
}

#[test]
#[ignore]
fn triosc_cpu_8_voices_128_frames() {
    let patch: &[(&str, f32)] = &[("osc2Level", 0.6), ("osc3Level", 0.4), ("unisonDetune", 0.3), ("drift", 0.3), ("ampSustain", 1.0)];
    let lfos: &[(&str, f32)] = &[("lfo1Dest", 0.0), ("lfo1Amount", 0.05), ("lfo1Shape", 6.0), ("lfo2Dest", 1.0), ("lfo2Amount", 0.5), ("lfo2Sync", 1.0)];
    for (name, on) in [("LFOs off", false), ("both LFOs on", true)] {
        let mut t = TriOsc::new(SR, BLOCK);
        set_all(&mut t, &descriptor(), patch);
        if on {
            set_all(&mut t, &descriptor(), lfos);
        }
        for k in 0..8u8 {
            t.note_on(0, 48 + k * 3, (48 + k * 3) as f32, 0.8, NoteExtras::default());
        }
        let (mut l, mut r) = (vec![0.0f32; BLOCK], vec![0.0f32; BLOCK]);
        let blocks = 20_000;
        let t0 = std::time::Instant::now();
        for b in 0..blocks {
            let ctx = ProcessContext { sample_rate: SR, bpm: 128.0, beats_per_bar: 4.0, playing: true, beat_pos: b as f64 * BLOCK as f64 * 128.0 / 60.0 / SR as f64, frames: BLOCK };
            t.process(&ctx, [&mut l, &mut r]);
        }
        let ns = t0.elapsed().as_nanos() as f64 / blocks as f64;
        let budget = BLOCK as f64 / SR as f64 * 1e9;
        println!("TriOsc {name}: {:.1} µs per 128-frame block, 8 voices ({:.2} % of real time)", ns / 1000.0, ns / budget * 100.0);
    }
}
