mod common;
use common::*;

use krypt_studio_dsp::{create_instrument, descriptor, descriptors, Instrument, NoteExtras, PluginKind};

fn make(id: &str) -> Box<dyn Instrument> {
    let mut i = create_instrument(id, SR, BLOCK).unwrap();
    if descriptor(id).unwrap().uses_sample == Some(true) {
        i.set_sample(Some(test_sample(44100.0, 0.6, None)));
    }
    i
}

fn instrument_ids() -> Vec<&'static str> {
    descriptors().into_iter().filter(|d| d.kind == PluginKind::Instrument).map(|d| d.id).collect()
}

#[test]
fn every_instrument_sounds_then_decays_to_silence() {
    for id in instrument_ids() {
        let mut inst = make(id);
        assert!(!inst.is_active(), "{id} active before notes");
        note(inst.as_mut(), 10, 60, 0.9);
        let (l, r) = render_inst(inst.as_mut(), (0.15 * SR) as usize);
        assert!(peak(&l) > 0.01 && peak(&r) > 0.01, "{id} silent: {}", peak(&l));
        assert!(l[..10].iter().all(|v| *v == 0.0), "{id} sounded before its offset");
        assert!(inst.activity() > 0.0, "{id} activity");
        inst.note_off(0, 60);
        let mut tail = (vec![], vec![]);
        for _ in 0..40 {
            tail = render_inst(inst.as_mut(), (0.1 * SR) as usize);
            assert!(tail.0.iter().chain(&tail.1).all(|v| v.is_finite()), "{id} non-finite");
            if !inst.is_active() {
                break;
            }
        }
        assert!(!inst.is_active(), "{id} never went idle");
        let (l, r) = render_inst(inst.as_mut(), 1024);
        assert_eq!(peak(&l).max(peak(&r)), 0.0, "{id} not silent after decay");
        let _ = tail;
    }
}

#[test]
fn choke_is_a_fast_clickless_fade() {
    for id in instrument_ids() {
        let mut inst = make(id);
        note(inst.as_mut(), 0, 60, 1.0);
        let (l, _) = render_inst(inst.as_mut(), (0.05 * SR) as usize);
        let before = peak(&l[l.len() - 256..]);
        assert!(before > 0.005, "{id} too quiet to test choke");
        inst.choke(0);
        let (l, _) = render_inst(inst.as_mut(), (0.01 * SR) as usize);
        let after3ms = (0.003 * SR) as usize;
        assert!(peak(&l[after3ms..]) == 0.0, "{id} still sounding 3 ms after choke");
        assert!(!inst.is_active(), "{id} active after choke");
        let max_step = l.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        assert!(max_step < before.max(0.05) * 0.8, "{id} choke click {max_step} vs level {before}");
    }
}

#[test]
fn all_off_is_immediate() {
    for id in instrument_ids() {
        let mut inst = make(id);
        note(inst.as_mut(), 0, 60, 1.0);
        render_inst(inst.as_mut(), 2048);
        inst.all_off();
        assert!(!inst.is_active(), "{id}");
        let (l, _) = render_inst(inst.as_mut(), 512);
        assert_eq!(peak(&l), 0.0, "{id}");
    }
}

#[test]
fn extreme_params_stay_finite() {
    let mut seed = 1u32;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (seed >> 8) as f32 / 16_777_216.0
    };
    for d in descriptors().into_iter().filter(|d| d.kind == PluginKind::Instrument) {
        for round in 0..24 {
            let mut inst = make(d.id);
            for (i, p) in d.params.iter().enumerate() {
                let v = match round {
                    0 => p.min,
                    1 => p.max,
                    2 => f32::NAN,
                    3 => 1e30,
                    _ => p.min + (p.max - p.min) * rnd(),
                };
                inst.set_param(i, v);
            }
            inst.set_voice_mode(round % 3 == 0, if round % 2 == 0 { 120.0 } else { 0.0 });
            for k in 0..12u8 {
                let extras = NoteExtras { pan: rnd() * 2.0 - 1.0, slide: k % 4 == 3, sample_start: (rnd() * 0.3) as f64, ..Default::default() };
                inst.note_on(k as usize * 7, k * 10, k as f32 * 10.0 + rnd(), rnd(), extras);
            }
            inst.note_on(3, 127, 200.0, 1.0, NoteExtras::default());
            inst.note_on(4, 0, -50.0, f32::INFINITY, NoteExtras::default());
            let (l, r) = render_inst(inst.as_mut(), 4096);
            for k in 0..12u8 {
                inst.note_off(0, k * 10);
            }
            let (l2, r2) = render_inst(inst.as_mut(), 4096);
            for v in l.iter().chain(&r).chain(&l2).chain(&r2) {
                assert!(v.is_finite() && v.abs() < 1000.0, "{} round {round}: {v}", d.id);
            }
        }
    }
}

#[test]
fn velocity_curve_is_vel_pow_1_6() {
    for id in ["krypt.triosc", "krypt.sampler", "krypt.drumsynth"] {
        let mut a = make(id);
        note(a.as_mut(), 0, 60, 1.0);
        let pa = peak(&render_inst(a.as_mut(), 4800).0);
        let mut b = make(id);
        note(b.as_mut(), 0, 60, 0.5);
        let pb = peak(&render_inst(b.as_mut(), 4800).0);
        let ratio = pb / pa;
        let expect = 0.5f32.powf(1.6);
        assert!((ratio - expect).abs() < 0.08, "{id}: {ratio} vs {expect}");
    }
}

#[test]
fn sampler_pitch_follows_keys_and_root() {
    let s = sine_sample(44100.0, 440.0, 1.0, None);
    let mut inst = create_instrument("krypt.sampler", SR, BLOCK).unwrap();
    inst.set_sample(Some(s.clone()));
    note(inst.as_mut(), 0, 60, 1.0);
    let (l, _) = render_inst(inst.as_mut(), 24000);
    let f = zc_freq(&l[1000..20000], SR);
    assert!((f - 440.0).abs() < 1.0, "root plays original pitch: {f}");
    inst.all_off();
    note(inst.as_mut(), 0, 72, 1.0);
    let (l, _) = render_inst(inst.as_mut(), 12000);
    let f = zc_freq(&l[500..10000], SR);
    assert!((f - 880.0).abs() < 2.0, "octave up: {f}");
    inst.all_off();
    note(inst.as_mut(), 0, 48, 1.0);
    let (l, _) = render_inst(inst.as_mut(), 40000);
    let f = zc_freq(&l[500..38000], SR);
    assert!((f - 220.0).abs() < 1.0, "octave down: {f}");
    let mut inst = create_instrument("krypt.sampler", SR, BLOCK).unwrap();
    inst.set_sample(Some(sine_sample(44100.0, 440.0, 1.0, Some(69))));
    note(inst.as_mut(), 0, 69, 1.0);
    let (l, _) = render_inst(inst.as_mut(), 24000);
    let f = zc_freq(&l[1000..20000], SR);
    assert!((f - 440.0).abs() < 1.0, "root_key 69: {f}");
    let mut inst = create_instrument("krypt.sampler", SR, BLOCK).unwrap();
    inst.set_sample(Some(s));
    inst.set_param(param("krypt.sampler", "keyTrack"), 0.0);
    note(inst.as_mut(), 0, 40, 1.0);
    let (l, _) = render_inst(inst.as_mut(), 24000);
    let f = zc_freq(&l[1000..20000], SR);
    assert!((f - 440.0).abs() < 1.0, "keyTrack off: {f}");
}

#[test]
fn sampler_one_shot_reverse_loop_and_start() {
    let s = test_sample(SR, 0.25, None);
    let mut inst = create_instrument("krypt.sampler", SR, BLOCK).unwrap();
    inst.set_sample(Some(s.clone()));
    note(inst.as_mut(), 0, 60, 1.0);
    render_inst(inst.as_mut(), 480);
    inst.note_off(0, 60);
    let (l, _) = render_inst(inst.as_mut(), 4800);
    assert!(peak(&l[4000..]) > 0.05, "one-shot cut by note-off");
    let mut inst = create_instrument("krypt.sampler", SR, BLOCK).unwrap();
    inst.set_sample(Some(s.clone()));
    inst.set_param(param("krypt.sampler", "oneShot"), 0.0);
    note(inst.as_mut(), 0, 60, 1.0);
    render_inst(inst.as_mut(), 480);
    inst.note_off(0, 60);
    let (l, _) = render_inst(inst.as_mut(), 4800);
    assert!(peak(&l[3000..]) < 1e-3, "release didn't end the note");
    let mut inst = create_instrument("krypt.sampler", SR, BLOCK).unwrap();
    inst.set_sample(Some(s.clone()));
    inst.set_param(param("krypt.sampler", "loop"), 1.0);
    note(inst.as_mut(), 0, 60, 1.0);
    let (l, _) = render_inst(inst.as_mut(), 48000);
    assert!(peak(&l[40000..]) > 0.01, "loop stopped");
    let mut inst = create_instrument("krypt.sampler", SR, BLOCK).unwrap();
    inst.set_sample(Some(s.clone()));
    inst.set_param(param("krypt.sampler", "reverse"), 1.0);
    note(inst.as_mut(), 0, 60, 1.0);
    let (l, _) = render_inst(inst.as_mut(), 12000);
    assert!(peak(&l[..1000]) < peak(&l[10000..11800]), "reverse not reversed");
    let mut inst = create_instrument("krypt.sampler", SR, BLOCK).unwrap();
    inst.set_sample(Some(s.clone()));
    inst.note_on(0, 60, 60.0, 1.0, NoteExtras { sample_start: 0.1, ..Default::default() });
    let (l, _) = render_inst(inst.as_mut(), 2000);
    let src = &s.channels[0];
    for i in 100..1000 {
        assert!((l[i] - src[4800 + i]).abs() < 1e-4, "sample_start offset wrong at {i}");
    }
}

#[test]
fn audioclip_plays_original_speed_from_offset() {
    let s = test_sample(SR, 0.5, None);
    let mut inst = create_instrument("krypt.audioclip", SR, BLOCK).unwrap();
    inst.set_sample(Some(s.clone()));
    inst.note_on(0, 80, 80.0, 1.0, NoteExtras { sample_start: 0.05, ..Default::default() });
    let (l, r) = render_inst(inst.as_mut(), 4000);
    for i in 100..3000 {
        assert!((l[i] - s.channels[0][2400 + i]).abs() < 1e-4, "L mismatch at {i}");
        assert!((r[i] - s.channels[1][2400 + i]).abs() < 1e-4, "R mismatch at {i}");
    }
    let mut inst = create_instrument("krypt.audioclip", SR, BLOCK).unwrap();
    inst.set_sample(Some(sine_sample(44100.0, 440.0, 1.0, None)));
    note(inst.as_mut(), 0, 30, 1.0);
    let (l, _) = render_inst(inst.as_mut(), 24000);
    assert!((zc_freq(&l[1000..20000], SR) - 440.0).abs() < 1.0);
}

#[test]
fn kick808_root_is_c2_and_mono_glide_slides() {
    let mut k = create_instrument("krypt.kick808", SR, BLOCK).unwrap();
    k.set_param(param("krypt.kick808", "punch"), 0.0);
    k.set_param(param("krypt.kick808", "drive"), 0.0);
    k.set_param(param("krypt.kick808", "click"), 0.0);
    k.set_param(param("krypt.kick808", "decay"), 4000.0);
    k.set_voice_mode(true, 50.0);
    note(k.as_mut(), 0, 36, 1.0);
    let (l, _) = render_inst(k.as_mut(), 24000);
    let f = zc_freq(&l[2000..24000], SR);
    assert!((f - 65.41).abs() < 1.0, "MIDI 36 should sound C2: {f}");
    note(k.as_mut(), 0, 43, 1.0);
    let (l, _) = render_inst(k.as_mut(), 24000);
    let f = zc_freq(&l[6000..24000], SR);
    assert!((f - 98.0).abs() < 1.5, "glided to G2: {f}");
    let env_before = peak(&l[..2000]);
    assert!(env_before < 1.0);
    let mut k = create_instrument("krypt.kick808", SR, BLOCK).unwrap();
    k.set_param(param("krypt.kick808", "punch"), 0.0);
    k.set_param(param("krypt.kick808", "decay"), 4000.0);
    note(k.as_mut(), 0, 36, 1.0);
    render_inst(k.as_mut(), 4800);
    k.note_off(0, 36);
    k.note_on(0, 48, 48.0, 1.0, NoteExtras { slide: true, ..Default::default() });
    let (l, _) = render_inst(k.as_mut(), 24000);
    let f = zc_freq(&l[8000..24000], SR);
    assert!((f - 130.8).abs() < 2.0, "slide to C3: {f}");
}

#[test]
fn triosc_mono_legato_returns_to_held_note() {
    let mut t = create_instrument("krypt.triosc", SR, BLOCK).unwrap();
    for (p, v) in [("osc1Shape", 0.0), ("osc2Level", 0.0), ("osc3Level", 0.0), ("unisonDetune", 0.0), ("drift", 0.0), ("cutoff", 20000.0), ("filterEnvAmount", 0.0)] {
        t.set_param(param("krypt.triosc", p), v);
    }
    t.set_voice_mode(true, 20.0);
    note(t.as_mut(), 0, 57, 1.0);
    let (l, _) = render_inst(t.as_mut(), 9600);
    assert!((zc_freq(&l[2000..], SR) - 220.0).abs() < 1.0);
    note(t.as_mut(), 0, 69, 1.0);
    let (l, _) = render_inst(t.as_mut(), 9600);
    assert!((zc_freq(&l[2400..], SR) - 440.0).abs() < 2.0);
    t.note_off(0, 69);
    let (l, _) = render_inst(t.as_mut(), 9600);
    assert!((zc_freq(&l[2400..], SR) - 220.0).abs() < 1.0);
    assert!(t.is_active());
}

#[test]
fn polyphony_limit_steals_without_runaway() {
    let mut t = create_instrument("krypt.triosc", SR, BLOCK).unwrap();
    for k in 0..64u8 {
        note(t.as_mut(), k as usize, 30 + k, 0.8);
    }
    let (l, _) = render_inst(t.as_mut(), 9600);
    assert!(l.iter().all(|v| v.is_finite()));
    assert!(peak(&l) < 40.0);
}

#[test]
fn note_pan_moves_the_image() {
    let mut t = create_instrument("krypt.drumsynth", SR, BLOCK).unwrap();
    t.note_on(0, 60, 60.0, 1.0, NoteExtras { pan: -1.0, ..Default::default() });
    let (l, r) = render_inst(t.as_mut(), 4800);
    assert!(peak(&l) > 0.1 && peak(&r) < 1e-6);
}

#[test]
fn mono_retrigger_crossfades_without_overshoot() {
    let mut k = create_instrument("krypt.kick808", SR, BLOCK).unwrap();
    note(k.as_mut(), 0, 60, 1.0);
    let single = peak(&render_inst(k.as_mut(), 9600).0);
    let mut k = create_instrument("krypt.kick808", SR, BLOCK).unwrap();
    k.set_voice_mode(true, 0.0);
    let mut worst = 0.0f32;
    for gap in [100usize, 600, 1700, 4100, 9000] {
        k.all_off();
        note(k.as_mut(), 0, 60, 1.0);
        render_inst(k.as_mut(), gap);
        k.note_off(0, 60);
        note(k.as_mut(), 0, 63, 1.0);
        worst = worst.max(peak(&render_inst(k.as_mut(), 9600).0));
    }
    assert!(worst <= single * 1.06, "retrigger overshoot {worst} vs single hit {single}");
}

#[test]
fn malformed_samples_never_panic() {
    use krypt_studio_dsp::SampleData;
    use std::sync::Arc;
    let bad = [
        SampleData { sample_rate: 44100.0, channels: vec![vec![0.5; 1000], vec![0.5; 10]], root_key: Some(200) },
        SampleData { sample_rate: 0.0, channels: vec![vec![0.5; 1000]], root_key: None },
        SampleData { sample_rate: f32::NAN, channels: vec![vec![0.5; 1000]], root_key: None },
        SampleData { sample_rate: 48000.0, channels: vec![], root_key: None },
        SampleData { sample_rate: 48000.0, channels: vec![vec![f32::NAN; 100], vec![1e30; 100]], root_key: None },
        SampleData { sample_rate: 8.0, channels: vec![vec![0.1; 3]], root_key: None },
    ];
    for id in ["krypt.sampler", "krypt.audioclip"] {
        for s in &bad {
            let mut inst = create_instrument(id, SR, BLOCK).unwrap();
            inst.set_sample(Some(Arc::new(SampleData { sample_rate: s.sample_rate, channels: s.channels.clone(), root_key: s.root_key })));
            for (k, start) in [(60u8, 0.0f64), (90, 0.001), (20, 5.0)] {
                inst.note_on(0, k, k as f32, 1.0, NoteExtras { sample_start: start, ..Default::default() });
            }
            let (l, r) = render_inst(inst.as_mut(), 4800);
            assert!(l.iter().chain(&r).all(|v| v.is_finite()), "{id}");
        }
    }
}
