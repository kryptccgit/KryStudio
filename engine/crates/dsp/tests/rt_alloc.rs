mod common;
use common::*;

use assert_no_alloc::assert_no_alloc;
use krypt_studio_dsp::{create_effect, create_instrument, descriptor, descriptors, NoteExtras, PluginKind, ProcessContext};

#[cfg(debug_assertions)]
#[global_allocator]
static A: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;

#[test]
fn instruments_do_not_allocate_on_the_audio_thread() {
    for d in descriptors().into_iter().filter(|d| d.kind == PluginKind::Instrument) {
        let mut inst = create_instrument(d.id, SR, BLOCK).unwrap();
        if descriptor(d.id).unwrap().uses_sample == Some(true) {
            inst.set_sample(Some(test_sample(44100.0, 0.5, Some(57))));
        }
        let (mut l, mut r) = (vec![0.0f32; BLOCK], vec![0.0f32; BLOCK]);
        let ranges: Vec<(f32, f32)> = d.params.iter().map(|p| (p.min, p.max)).collect();
        assert_no_alloc(|| {
            for round in 0..40usize {
                for (i, (lo, hi)) in ranges.iter().enumerate() {
                    let t = ((round * 7 + i * 3) % 11) as f32 / 10.0;
                    inst.set_param(i, lo + (hi - lo) * t);
                }
                inst.set_voice_mode(round % 5 == 0, (round % 3) as f32 * 40.0);
                for k in 0..6u8 {
                    let ex = NoteExtras { slide: k == 5, pan: 0.3, sample_start: 0.01 * k as f64, ..Default::default() };
                    inst.note_on(k as usize * 9, 48 + k * 3 + round as u8 % 12, 50.0 + k as f32, 0.8, ex);
                }
                if round % 7 == 0 {
                    inst.choke(17);
                }
                for k in 0..3u8 {
                    inst.note_off(100 + k as usize, 48 + k * 3 + round as u8 % 12);
                }
                inst.note_on(BLOCK + 10, 70, 70.0, 0.5, NoteExtras::default());
                let ctx = ProcessContext { sample_rate: SR, bpm: 128.0, beats_per_bar: 4.0, playing: true, beat_pos: round as f64, frames: BLOCK };
                inst.process(&ctx, [&mut l, &mut r]);
                let _ = inst.activity();
                let _ = inst.is_active();
                if round == 39 {
                    inst.all_off();
                }
            }
        });
        assert!(l.iter().chain(&r).all(|v| v.is_finite()), "{}", d.id);
    }
}

#[test]
fn effects_do_not_allocate_on_the_audio_thread() {
    for d in descriptors().into_iter().filter(|d| d.kind == PluginKind::Effect) {
        let mut fx = create_effect(d.id, SR, BLOCK).unwrap();
        let mut l = noise(BLOCK, 1, 0.8);
        let mut r = noise(BLOCK, 2, 0.8);
        let scl = noise(BLOCK, 3, 0.8);
        let scr = noise(BLOCK, 4, 0.8);
        let ranges: Vec<(f32, f32)> = d.params.iter().map(|p| (p.min, p.max)).collect();
        assert_no_alloc(|| {
            for round in 0..60usize {
                for (i, (lo, hi)) in ranges.iter().enumerate() {
                    let t = ((round * 5 + i * 3) % 9) as f32 / 8.0;
                    fx.set_param(i, lo + (hi - lo) * t);
                }
                let ctx = ProcessContext { sample_rate: SR, bpm: 90.0 + round as f64, beats_per_bar: 4.0, playing: round % 4 != 0, beat_pos: round as f64 * 0.37, frames: BLOCK };
                let sc = if round % 2 == 0 { Some([scl.as_slice(), scr.as_slice()]) } else { None };
                fx.process(&ctx, [&mut l, &mut r], sc);
                let _ = fx.latency();
                if round % 13 == 0 {
                    fx.reset();
                }
            }
        });
        assert!(l.iter().chain(&r).all(|v| v.is_finite()), "{}", d.id);
    }
}
