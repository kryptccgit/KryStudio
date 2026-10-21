use krypt_studio_dsp::{create_effect, create_instrument, descriptors, NoteExtras, PluginKind, ProcessContext, SampleData};
use std::sync::Arc;
use std::time::Instant;

fn main() {
    let sr = 48000.0;
    let block = 256;
    let secs = 10.0;
    let blocks = (secs * sr / block as f32) as usize;
    let sample = Arc::new(SampleData {
        sample_rate: 44100.0,
        channels: vec![(0..44100 * 2).map(|i| ((i as f32) * 0.0627).sin() * 0.5).collect(); 2],
        root_key: None,
    });
    for d in descriptors() {
        let (mut l, mut r) = (vec![0.0f32; block], vec![0.0f32; block]);
        let t0 = Instant::now();
        match d.kind {
            PluginKind::Instrument => {
                let mut inst = create_instrument(d.id, sr, block).unwrap();
                inst.set_sample(Some(sample.clone()));
                for b in 0..blocks {
                    if b % 94 == 0 {
                        for k in 0..4u8 {
                            inst.note_on(k as usize, 48 + k * 4, (48 + k * 4) as f32, 0.8, NoteExtras::default());
                        }
                    }
                    if b % 94 == 80 {
                        for k in 0..4u8 {
                            inst.note_off(0, 48 + k * 4);
                        }
                    }
                    let ctx = ProcessContext { sample_rate: sr, bpm: 128.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: block };
                    l.iter_mut().for_each(|v| *v = 0.0);
                    r.iter_mut().for_each(|v| *v = 0.0);
                    inst.process(&ctx, [&mut l, &mut r]);
                }
            }
            PluginKind::Effect => {
                let mut fx = create_effect(d.id, sr, block).unwrap();
                let mut s = 1u32;
                for b in 0..blocks {
                    for v in l.iter_mut().chain(r.iter_mut()) {
                        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
                        *v = ((s >> 8) as f32 / 16_777_216.0 - 0.5) * 0.5;
                    }
                    let ctx = ProcessContext { sample_rate: sr, bpm: 128.0, beats_per_bar: 4.0, playing: true, beat_pos: b as f64 * 0.1, frames: block };
                    fx.process(&ctx, [&mut l, &mut r], None);
                }
            }
        }
        let dt = t0.elapsed().as_secs_f32();
        println!("{:18} {:6.2}% of one core (x{:.0} realtime)", d.id, 100.0 * dt / secs, secs / dt);
    }
}
