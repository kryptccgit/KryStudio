//! Render a short musical phrase through every stock instrument and effect
//! (plus the factory kit) into WAV files, for listening tests.
//!
//!   cargo run --release -p krypt-studio-dsp --example render_all -- <out-dir>
//!
//! Effects use the FX-slot wet/dry rule: out = dry·(1-mix) + wet·mix, with
//! the descriptor's defaultMix unless a preset says otherwise.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use krypt_studio_dsp::blocks::filters::{Svf, SvfMode};
use krypt_studio_dsp::blocks::osc::{blep_wave, Shape};
use krypt_studio_dsp::factory::{generate_kit, render_kit};
use krypt_studio_dsp::wav::{write_wav, WavFormat};
use krypt_studio_dsp::{create_effect, create_instrument, descriptor, Effect, Instrument, NoteExtras, ProcessContext, SampleData};

const SR: f32 = 48000.0;
const BPM: f64 = 120.0;
const BLOCK: usize = 256;

/// (beat, length in beats, key, velocity, slide)
type Note = (f64, f64, u8, f32, bool);

fn frames(beats: f64) -> usize {
    (beats * 60.0 / BPM * SR as f64).round() as usize
}

fn set(inst: &mut dyn Instrument, id: &str, params: &[(&str, f32)]) {
    let d = descriptor(id).unwrap();
    for (p, v) in params {
        inst.set_param(d.param_index(p).unwrap_or_else(|| panic!("{id}.{p}")), *v);
    }
}

/// Render notes through an instrument with sample-accurate events.
fn play(inst: &mut dyn Instrument, notes: &[Note], beats: f64) -> (Vec<f32>, Vec<f32>) {
    let n = frames(beats);
    let mut ev: Vec<(usize, bool, u8, f32, bool)> = Vec::new();
    for &(b, len, key, vel, slide) in notes {
        ev.push((frames(b), true, key, vel, slide));
        ev.push((frames(b + len), false, key, 0.0, false));
    }
    ev.sort_by_key(|e| (e.0, e.1)); // note-offs before note-ons on the same frame
    let (mut l, mut r) = (vec![0.0f32; n], vec![0.0f32; n]);
    let (mut at, mut ei) = (0usize, 0usize);
    while at < n {
        let m = (n - at).min(BLOCK);
        while ei < ev.len() && ev[ei].0 < at + m {
            let (f, on, key, vel, slide) = ev[ei];
            if on {
                inst.note_on(f - at, key, key as f32, vel, NoteExtras { slide, ..Default::default() });
            } else {
                inst.note_off(f - at, key);
            }
            ei += 1;
        }
        let ctx = ProcessContext { sample_rate: SR, bpm: BPM, beats_per_bar: 4.0, playing: true, beat_pos: at as f64 / frames(1.0) as f64, frames: m };
        inst.process(&ctx, [&mut l[at..at + m], &mut r[at..at + m]]);
        at += m;
    }
    (l, r)
}

fn write(dir: &Path, name: &str, l: &[f32], r: &[f32]) {
    let peak = l.iter().chain(r).fold(0.0f32, |m, v| m.max(v.abs()));
    // only scale down if a render would clip
    let g = if peak > 0.98 { 0.98 / peak } else { 1.0 };
    let l: Vec<f32> = l.iter().map(|v| v * g).collect();
    let r: Vec<f32> = r.iter().map(|v| v * g).collect();
    let p = dir.join(name);
    write_wav(&p, &[&l, &r], SR as u32, WavFormat::Pcm24).expect("write wav");
    println!("  {:44} peak {:6.1} dBFS{}", name, 20.0 * peak.max(1e-9).log10(), if g < 1.0 { " (scaled to avoid clipping)" } else { "" });
}

fn mixdown(parts: &[(&[f32], &[f32], f32)]) -> (Vec<f32>, Vec<f32>) {
    let n = parts.iter().map(|p| p.0.len()).max().unwrap_or(0);
    let (mut l, mut r) = (vec![0.0f32; n], vec![0.0f32; n]);
    for (pl, pr, g) in parts {
        for i in 0..pl.len() {
            l[i] += pl[i] * g;
            r[i] += pr[i] * g;
        }
    }
    (l, r)
}

fn sample(ch: &[Vec<f32>]) -> Arc<SampleData> {
    Arc::new(SampleData { sample_rate: SR, channels: ch.to_vec(), root_key: None })
}

/// A synthetic "singer" for the vocal effects: a band-limited glottal buzz
/// through three moving formants (a different vowel per note), noise
/// consonants, portamento and vibrato. `cents` detunes each note.
fn synth_voice(notes: &[(f64, f64, u8)], cents: &[f32], beats: f64) -> Vec<f32> {
    const VOWELS: [(f64, f64); 5] = [(730.0, 1090.0), (530.0, 1840.0), (280.0, 2250.0), (570.0, 840.0), (320.0, 900.0)];
    let n = frames(beats);
    let sr = SR as f64;
    let mut out = vec![0.0f32; n];
    let (mut f1, mut f2, mut f3) = (Svf::default(), Svf::default(), Svf::default());
    let mut tilt = 0.0f64;
    let (mut ph, mut pitch) = (0.0f64, notes[0].2 as f64 + cents[0] as f64 * 0.01);
    let mut hiss = Svf::default();
    hiss.design(SvfMode::Highpass, 4500.0, 0.7, 0.0, sr);
    let mut seed = 0x2468_ace1u32;
    for (i, o) in out.iter_mut().enumerate() {
        let beat = i as f64 / frames(1.0) as f64;
        let Some(k) = notes.iter().position(|&(b, len, _)| beat >= b && beat < b + len) else { continue };
        let (b, len, key) = notes[k];
        let t = (beat - b) * 60.0 / BPM; // seconds into the note
        let target = key as f64 + cents[k % cents.len()] as f64 * 0.01;
        pitch += (target - pitch) * (1.0 - (-1.0 / (0.035 * sr)).exp());
        let vib = if t > 0.15 { 0.18 * (std::f64::consts::TAU * 5.5 * t).sin() * ((t - 0.15) * 4.0).min(1.0) } else { 0.0 };
        let f0 = 440.0 * ((pitch + vib - 69.0) / 12.0).exp2();
        let dt = f0 / sr;
        let buzz = blep_wave(Shape::Saw, ph, dt);
        ph = (ph + dt).fract();
        tilt += (buzz - tilt) * 0.18; // glottal spectral tilt
        let (va, vb) = (VOWELS[k % 5], VOWELS[(k + 1) % 5]);
        let m = (t / (len * 60.0 / BPM)).clamp(0.0, 1.0) * 0.4;
        f1.design(SvfMode::Bandpass, va.0 + (vb.0 - va.0) * m, 6.0, 0.0, sr);
        f2.design(SvfMode::Bandpass, va.1 + (vb.1 - va.1) * m, 8.0, 0.0, sr);
        f3.design(SvfMode::Bandpass, 2800.0, 10.0, 0.0, sr);
        let voiced = f1.tick(tilt) + 0.6 * f2.tick(tilt) + 0.25 * f3.tick(tilt);
        let note_len = len * 60.0 / BPM;
        let env = (t / 0.03).min(1.0) * ((note_len - t) / 0.08).clamp(0.0, 1.0);
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let nz = (seed >> 8) as f64 / 8_388_608.0 - 1.0;
        let s = if k % 4 == 2 && t < 0.07 { hiss.tick(nz) * 0.25 * (1.0 - t / 0.07) } else { 0.0 };
        *o = ((voiced * 0.9 * env + s) * 0.8) as f32;
    }
    out
}

/// Run an effect over a stereo signal in blocks with an optional sidechain;
/// `each_block(fx, frame)` may change params before a block (automation).
fn run_effect(fx: &mut dyn Effect, l: &mut [f32], r: &mut [f32], sc: Option<(&[f32], &[f32])>, mut each_block: impl FnMut(&mut dyn Effect, usize)) {
    let n = l.len();
    let mut at = 0;
    while at < n {
        let m = (n - at).min(BLOCK);
        each_block(fx, at);
        let ctx = ProcessContext { sample_rate: SR, bpm: BPM, beats_per_bar: 4.0, playing: true, beat_pos: at as f64 / frames(1.0) as f64, frames: m };
        let side = sc.map(|(a, b)| [&a[at..at + m], &b[at..at + m]]);
        fx.process(&ctx, [&mut l[at..at + m], &mut r[at..at + m]], side);
        at += m;
    }
}

fn fx_param(fx: &mut dyn Effect, id: &str, p: &str, v: f32) {
    let d = descriptor(id).unwrap();
    fx.set_param(d.param_index(p).unwrap_or_else(|| panic!("{id}.{p}")), v);
}

fn main() {
    let out = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| "render-out".into()));
    let inst_dir = out.join("instruments");
    let fx_dir = out.join("effects");
    std::fs::create_dir_all(&inst_dir).unwrap();
    std::fs::create_dir_all(&fx_dir).unwrap();

    let kit_paths = generate_kit(&out.join("factory")).expect("factory kit");
    println!("factory kit: {} files in {}", kit_paths.len(), out.join("factory").join("drums").display());
    let kit: HashMap<&str, Vec<Vec<f32>>> = render_kit().into_iter().collect();

    println!("instruments:");
    // sampler: a 2-bar beat from the factory kit
    let pattern: [(&str, &[f64]); 5] = [
        ("kick.wav", &[0.0, 1.5, 2.5, 4.0, 5.5, 6.75]),
        ("clap.wav", &[1.0, 3.0, 5.0, 7.0]),
        ("snare.wav", &[3.75, 7.5]),
        ("hat-closed.wav", &[0.0, 0.5, 1.0, 1.5, 2.0, 2.25, 2.5, 3.0, 4.0, 4.5, 5.0, 5.5, 6.0, 6.25, 6.5, 6.75, 7.0]),
        ("hat-open.wav", &[3.5, 7.5]),
    ];
    let mut beat_parts = Vec::new();
    for (name, beats) in pattern {
        let mut s = create_instrument("krypt.sampler", SR, BLOCK).unwrap();
        s.set_sample(Some(sample(&kit[name])));
        let vel = if name.starts_with("hat") { 0.75 } else { 0.95 };
        let notes: Vec<Note> = beats.iter().map(|&b| (b, 0.25, 60, vel, false)).collect();
        beat_parts.push(play(s.as_mut(), &notes, 8.0));
    }
    let parts: Vec<(&[f32], &[f32], f32)> = beat_parts.iter().map(|(l, r)| (l.as_slice(), r.as_slice(), 0.6)).collect();
    let (beat_l, beat_r) = mixdown(&parts);
    write(&inst_dir, "sampler-factory-beat.wav", &beat_l, &beat_r);

    // sampler: the factory 808 as a pitched, mono bassline
    let mut s = create_instrument("krypt.sampler", SR, BLOCK).unwrap();
    s.set_sample(Some(sample(&kit["808.wav"])));
    s.set_voice_mode(true, 0.0);
    let bass: Vec<Note> = vec![(0.0, 1.5, 36, 1.0, false), (1.5, 1.0, 39, 0.9, false), (2.5, 1.5, 65, 0.9, false), (4.0, 2.0, 43, 1.0, false), (6.0, 2.0, 34, 1.0, false)];
    let (l, r) = play(s.as_mut(), &bass, 8.0);
    write(&inst_dir, "sampler-808-melody.wav", &l, &r);

    // sampler: reverse + resonant filter + pitch envelope
    let mut s = create_instrument("krypt.sampler", SR, BLOCK).unwrap();
    s.set_sample(Some(sample(&kit["clap.wav"])));
    set(s.as_mut(), "krypt.sampler", &[("reverse", 1.0), ("cutoff", 3000.0), ("reso", 0.4), ("pitchEnvAmount", -12.0), ("pitchEnvDecay", 300.0)]);
    let (l, r) = play(s.as_mut(), &[(0.0, 1.0, 60, 1.0, false), (2.0, 1.0, 67, 1.0, false), (4.0, 1.0, 55, 1.0, false)], 6.0);
    write(&inst_dir, "sampler-reverse-filter-penv.wav", &l, &r);

    // audio clip: the beat as an audio clip, forwards and reversed
    for (name, rev) in [("audioclip.wav", 0.0), ("audioclip-reverse.wav", 1.0)] {
        let mut c = create_instrument("krypt.audioclip", SR, BLOCK).unwrap();
        c.set_sample(Some(sample(&[beat_l.clone(), beat_r.clone()])));
        set(c.as_mut(), "krypt.audioclip", &[("reverse", rev)]);
        let (l, r) = play(c.as_mut(), &[(0.0, 8.0, 36, 1.0, false)], 8.0);
        write(&inst_dir, name, &l, &r);
    }

    // TriOsc: default patch chords, a plucky arp, a mono glide lead
    let chords: Vec<Note> = [[60u8, 63, 67], [56, 60, 63], [51, 55, 58], [58, 62, 65]]
        .iter()
        .enumerate()
        .flat_map(|(i, ch)| ch.iter().map(move |&k| (i as f64 * 2.0, 1.8, k, 0.8, false)))
        .collect();
    let mut t = create_instrument("krypt.triosc", SR, BLOCK).unwrap();
    let (cl, cr) = play(t.as_mut(), &chords, 8.5);
    write(&inst_dir, "triosc-chords.wav", &cl, &cr);
    let mut t = create_instrument("krypt.triosc", SR, BLOCK).unwrap();
    set(
        t.as_mut(),
        "krypt.triosc",
        &[("ampSustain", 0.0), ("ampDecay", 350.0), ("cutoff", 900.0), ("reso", 0.45), ("filterEnvAmount", 0.6), ("filterEnvDecay", 180.0), ("osc3Level", 0.0)],
    );
    let arp: Vec<Note> = (0..32).map(|i| (i as f64 * 0.25, 0.2, [60u8, 67, 72, 75, 63, 70, 74, 79][i % 8], if i % 4 == 0 { 1.0 } else { 0.6 }, false)).collect();
    let (l, r) = play(t.as_mut(), &arp, 8.5);
    write(&inst_dir, "triosc-pluck-arp.wav", &l, &r);
    let mut t = create_instrument("krypt.triosc", SR, BLOCK).unwrap();
    t.set_voice_mode(true, 90.0);
    set(t.as_mut(), "krypt.triosc", &[("osc1Shape", 3.0), ("osc2Shape", 2.0), ("unisonDetune", 0.35), ("cutoff", 3000.0)]);
    let lead: Vec<Note> = vec![(0.0, 1.2, 48, 0.9, false), (1.0, 1.2, 75, 0.9, false), (2.0, 2.2, 79, 0.9, false), (4.0, 1.0, 77, 0.9, false), (4.75, 3.0, 75, 0.9, false)];
    let (l, r) = play(t.as_mut(), &lead, 8.5);
    write(&inst_dir, "triosc-mono-glide-lead.wav", &l, &r);

    // 808: overlapping notes glide (mono + 60 ms), plus a slide note
    let mut k = create_instrument("krypt.kick808", SR, BLOCK).unwrap();
    k.set_voice_mode(true, 60.0);
    set(k.as_mut(), "krypt.kick808", &[("decay", 1400.0)]);
    let line: Vec<Note> = vec![
        (0.0, 1.0, 36, 1.0, false),
        (1.5, 0.5, 36, 0.9, false),
        (2.0, 1.6, 39, 1.0, false),
        (3.5, 0.5, 43, 1.0, false), // overlaps the previous note → glides up
        (4.0, 1.5, 36, 1.0, false),
        (5.0, 1.0, 48, 1.0, true), // slide note → glides an octave up
        (6.5, 1.0, 34, 1.0, false),
    ];
    let (bl, br) = play(k.as_mut(), &line, 8.5);
    write(&inst_dir, "kick808-bassline.wav", &bl, &br);

    // DrumSynth: every voice on its own, then a beat
    let ds = descriptor("krypt.drumsynth").unwrap();
    let voices = ds.params[0].options.clone().unwrap();
    let mut ds_parts = Vec::new();
    for (vi, vname) in voices.iter().enumerate() {
        let mut d = create_instrument("krypt.drumsynth", SR, BLOCK).unwrap();
        d.set_param(0, vi as f32);
        let notes: Vec<Note> = (0..4).map(|i| (i as f64, 0.25, if i == 3 { 65 } else { 60 }, [1.0, 0.7, 0.85, 1.0][i], false)).collect();
        let (l, r) = play(d.as_mut(), &notes, 4.5);
        write(&inst_dir, &format!("drumsynth-{}.wav", vname.to_lowercase().replace(' ', "-")), &l, &r);
        let beat: Option<Vec<f64>> = match vi {
            0 => Some(vec![0.0, 1.5, 2.5, 4.0, 5.5, 6.75]),
            2 => Some(vec![1.0, 3.0, 5.0, 7.0]),
            3 => Some((0..16).map(|i| i as f64 * 0.5).collect()),
            4 => Some(vec![3.5, 7.5]),
            _ => None,
        };
        if let Some(b) = beat {
            let mut d = create_instrument("krypt.drumsynth", SR, BLOCK).unwrap();
            d.set_param(0, vi as f32);
            let notes: Vec<Note> = b.iter().map(|&x| (x, 0.25, 60, 0.9, false)).collect();
            ds_parts.push(play(d.as_mut(), &notes, 8.0));
        }
    }
    let parts: Vec<(&[f32], &[f32], f32)> = ds_parts.iter().map(|(l, r)| (l.as_slice(), r.as_slice(), 0.6)).collect();
    let (dl, dr) = mixdown(&parts);
    write(&inst_dir, "drumsynth-beat.wav", &dl, &dr);

    // Krypt FM: the default e-piano, then bells, bass, pad and organ patches
    let mut f = create_instrument("krypt.fm", SR, BLOCK).unwrap();
    let (l, r) = play(f.as_mut(), &chords, 8.5);
    write(&inst_dir, "fm-epiano-chords.wav", &l, &r);
    let bells: Vec<Note> = [(0.0, 79u8), (0.5, 84), (1.0, 86), (1.5, 91), (2.5, 88), (3.0, 84), (4.0, 79), (4.5, 86), (5.0, 84), (6.0, 72)]
        .iter()
        .map(|&(b, k)| (b, 0.4, k, 0.85, false))
        .collect();
    let mut f = create_instrument("krypt.fm", SR, BLOCK).unwrap();
    set(
        f.as_mut(),
        "krypt.fm",
        &[
            ("op1Decay", 5000.0), ("op1Release", 2500.0), ("op1Level", 0.85),
            ("op2Ratio", 3.5), ("op2Level", 0.68), ("op2Decay", 3000.0), ("op2Sustain", 0.0), ("op2Release", 2000.0),
            ("op3Ratio", 2.0), ("op3Detune", 7.0), ("op3Level", 0.6), ("op3Decay", 2500.0), ("op3Release", 2000.0),
            ("op4Ratio", 7.0), ("op4Fine", 0.27), ("op4Level", 0.58), ("op4Decay", 900.0), ("op4Release", 900.0),
        ],
    );
    let (l, r) = play(f.as_mut(), &bells, 8.5);
    write(&inst_dir, "fm-bells.wav", &l, &r);
    let mut f = create_instrument("krypt.fm", SR, BLOCK).unwrap();
    f.set_voice_mode(true, 35.0);
    set(
        f.as_mut(),
        "krypt.fm",
        &[
            ("algorithm", 0.0), ("feedback", 0.55), ("gain", -3.0),
            ("op1Level", 0.9), ("op1Decay", 900.0), ("op1Sustain", 0.6), ("op1Release", 70.0), ("op1Vel", 0.5),
            ("op2Level", 0.74), ("op2Decay", 260.0), ("op2Sustain", 0.3), ("op2Release", 70.0),
            ("op3Ratio", 1.0), ("op3Level", 0.6), ("op3Decay", 120.0), ("op3Sustain", 0.1),
            ("op4Ratio", 1.0), ("op4Level", 0.62), ("op4Decay", 300.0), ("op4Sustain", 0.4),
            ("cutoff", 2500.0), ("filterEnvAmount", 0.35), ("filterEnvDecay", 250.0),
        ],
    );
    let (l, r) = play(f.as_mut(), &line, 8.5);
    write(&inst_dir, "fm-bass.wav", &l, &r);
    let mut f = create_instrument("krypt.fm", SR, BLOCK).unwrap();
    set(
        f.as_mut(),
        "krypt.fm",
        &[
            ("algorithm", 6.0), ("vibrato", 8.0), ("vibratoRate", 4.5),
            ("op1Detune", -7.0), ("op1Attack", 500.0), ("op1Sustain", 0.9), ("op1Release", 1800.0), ("op1Level", 0.8),
            ("op2Ratio", 2.0), ("op2Detune", 6.0), ("op2Level", 0.62), ("op2Attack", 900.0), ("op2Sustain", 0.9), ("op2Release", 1800.0),
            ("op3Detune", 9.0), ("op3Level", 0.78), ("op3Attack", 700.0), ("op3Sustain", 0.9), ("op3Release", 1800.0),
            ("op4Level", 0.55), ("op4Attack", 1500.0), ("op4Decay", 3000.0), ("op4Sustain", 0.5), ("op4Release", 1800.0),
            ("cutoff", 5000.0),
        ],
    );
    let pad: Vec<Note> = chords.iter().map(|&(b, _, k, _, _)| (b, 2.0, k, 0.7, false)).collect();
    let (l, r) = play(f.as_mut(), &pad, 10.0);
    write(&inst_dir, "fm-pad.wav", &l, &r);
    let mut f = create_instrument("krypt.fm", SR, BLOCK).unwrap();
    set(
        f.as_mut(),
        "krypt.fm",
        &[
            ("algorithm", 7.0), ("vibrato", 6.0), ("vibratoRate", 6.5),
            ("op1Ratio", 0.5), ("op2Ratio", 1.0), ("op3Ratio", 2.0), ("op4Ratio", 3.0),
            ("op1Level", 0.85), ("op2Level", 0.9), ("op3Level", 0.8), ("op4Level", 0.72),
            ("op1Sustain", 1.0), ("op2Sustain", 1.0), ("op3Sustain", 1.0), ("op4Sustain", 1.0),
            ("op1Release", 60.0), ("op2Release", 60.0), ("op3Release", 60.0), ("op4Release", 60.0),
            ("op1Vel", 0.0), ("op2Vel", 0.0), ("op3Vel", 0.0), ("op4Vel", 0.0), ("op4Attack", 4.0),
        ],
    );
    let (l, r) = play(f.as_mut(), &chords, 8.5);
    write(&inst_dir, "fm-organ.wav", &l, &r);

    // Krypt Wave: default, supersaw, PWM pad, formant lead, digital bass, harmonic sweep
    let mut w = create_instrument("krypt.wavetable", SR, BLOCK).unwrap();
    let (l, r) = play(w.as_mut(), &chords, 8.5);
    write(&inst_dir, "wave-default-chords.wav", &l, &r);
    let mut w = create_instrument("krypt.wavetable", SR, BLOCK).unwrap();
    set(w.as_mut(), "krypt.wavetable", &[("unison", 8.0), ("detune", 0.45), ("spread", 1.0), ("cutoff", 7000.0), ("ampAttack", 8.0), ("ampRelease", 500.0), ("subLevel", 0.3)]);
    let (l, r) = play(w.as_mut(), &chords, 8.5);
    write(&inst_dir, "wave-supersaw.wav", &l, &r);
    let mut w = create_instrument("krypt.wavetable", SR, BLOCK).unwrap();
    set(
        w.as_mut(),
        "krypt.wavetable",
        &[("table", 1.0), ("position", 0.2), ("lfoToPosition", 0.7), ("lfoRate", 0.35), ("lfoShape", 0.0), ("unison", 4.0), ("detune", 0.2), ("ampAttack", 400.0), ("ampRelease", 1500.0), ("cutoff", 4000.0), ("modToCutoff", 0.0)],
    );
    let (l, r) = play(w.as_mut(), &pad, 10.0);
    write(&inst_dir, "wave-pwm-pad.wav", &l, &r);
    let mut w = create_instrument("krypt.wavetable", SR, BLOCK).unwrap();
    w.set_voice_mode(true, 80.0);
    set(
        w.as_mut(),
        "krypt.wavetable",
        &[("table", 2.0), ("position", 0.0), ("modToPosition", 0.9), ("modDecay", 1200.0), ("modSustain", 0.3), ("unison", 2.0), ("detune", 0.15), ("lfoToPitch", 18.0), ("lfoRate", 5.0), ("lfoShape", 0.0), ("cutoff", 12000.0)],
    );
    let (l, r) = play(w.as_mut(), &lead, 8.5);
    write(&inst_dir, "wave-formant-lead.wav", &l, &r);
    let mut w = create_instrument("krypt.wavetable", SR, BLOCK).unwrap();
    w.set_voice_mode(true, 30.0);
    set(
        w.as_mut(),
        "krypt.wavetable",
        &[("table", 4.0), ("position", 0.35), ("unison", 1.0), ("subLevel", 0.8), ("cutoff", 900.0), ("reso", 0.35), ("modToCutoff", 0.55), ("modDecay", 220.0), ("ampRelease", 60.0), ("gain", -3.0)],
    );
    let (l, r) = play(w.as_mut(), &line, 8.5);
    write(&inst_dir, "wave-digital-bass.wav", &l, &r);
    let mut w = create_instrument("krypt.wavetable", SR, BLOCK).unwrap();
    set(
        w.as_mut(),
        "krypt.wavetable",
        &[("table", 3.0), ("position", 0.0), ("lfoToPosition", 1.0), ("lfoSync", 1.0), ("lfoDivision", 12.0), ("lfoShape", 1.0), ("unison", 3.0), ("cutoff", 16000.0)],
    );
    let (l, r) = play(w.as_mut(), &chords, 8.5);
    write(&inst_dir, "wave-harmonic-sweep.wav", &l, &r);

    // effects: beat + chords + 808 as the source; the kick feeds sidechains
    println!("effects:");
    let n = beat_l.len().min(cl.len()).min(bl.len());
    let (src_l, src_r) = mixdown(&[(&beat_l[..n], &beat_r[..n], 0.8), (&cl[..n], &cr[..n], 0.6), (&bl[..n], &br[..n], 0.5)]);
    write(&fx_dir, "_source.wav", &src_l, &src_r);
    let (kick_l, kick_r) = (&beat_parts[0].0[..n], &beat_parts[0].1[..n]);
    type Preset<'a> = (&'a str, &'a str, Vec<(&'a str, f32)>, Option<f32>);
    let presets: Vec<Preset> = vec![
        ("krypt.eq", "default", vec![], None),
        ("krypt.eq", "smile", vec![("b1On", 1.0), ("b1Freq", 35.0), ("b2Gain", 4.0), ("b4Gain", -4.0), ("b4Q", 0.7), ("b6Gain", 5.0), ("b7On", 1.0), ("b7Freq", 17000.0)], None),
        ("krypt.comp", "default", vec![], None),
        ("krypt.comp", "heavy", vec![("threshold", -30.0), ("ratio", 10.0), ("attack", 3.0), ("release", 80.0)], None),
        ("krypt.comp", "kick-sidechain", vec![("useSidechain", 1.0), ("threshold", -30.0), ("ratio", 8.0), ("attack", 1.0), ("release", 150.0), ("autoMakeup", 0.0)], None),
        ("krypt.limiter", "default", vec![], None),
        ("krypt.limiter", "plus12dB", vec![("inputGain", 12.0), ("ceiling", -1.0)], None),
        ("krypt.clipper", "plus9dB", vec![("drive", 9.0)], None),
        ("krypt.clipper", "plus9dB-hard-4x", vec![("drive", 9.0), ("softness", 0.0), ("oversample", 2.0)], None),
        ("krypt.reverb", "room", vec![("mode", 0.0), ("decay", 0.9)], Some(0.3)),
        ("krypt.reverb", "hall", vec![("mode", 1.0)], Some(0.3)),
        ("krypt.reverb", "plate", vec![("mode", 2.0), ("decay", 1.8)], Some(0.3)),
        ("krypt.reverb", "hall-100pct-wet-long", vec![("mode", 1.0), ("decay", 8.0), ("size", 1.0)], Some(1.0)),
        ("krypt.delay", "default", vec![], None),
        ("krypt.delay", "dotted-eighth-wet", vec![("division", 7.0), ("feedback", 0.6), ("modDepth", 0.4)], Some(0.5)),
        ("krypt.drive", "tape", vec![("mode", 0.0), ("drive", 12.0)], None),
        ("krypt.drive", "tube", vec![("mode", 1.0), ("drive", 12.0)], None),
        ("krypt.drive", "hard", vec![("mode", 2.0), ("drive", 12.0)], None),
        ("krypt.drive", "fold", vec![("mode", 3.0), ("drive", 15.0)], None),
        ("krypt.drive", "bitcrush", vec![("mode", 4.0), ("drive", 3.0), ("bits", 6.0), ("downsample", 4.0)], None),
        ("krypt.filter", "lp24-bar-sweep", vec![("type", 1.0), ("cutoff", 1200.0), ("reso", 0.5), ("lfoDepth", 0.7), ("lfoDivision", 12.0), ("lfoShape", 1.0)], None),
        ("krypt.filter", "hp24-16th-saw", vec![("type", 3.0), ("cutoff", 600.0), ("reso", 0.3), ("lfoDepth", 0.6), ("lfoDivision", 3.0), ("lfoShape", 3.0)], None),
        ("krypt.duck", "quarter-pump", vec![], None),
        ("krypt.duck", "kick-follow", vec![("mode", 1.0)], None),
        ("krypt.utility", "wide", vec![("width", 2.0)], None),
        ("krypt.utility", "mono", vec![("mono", 1.0)], None),
        ("krypt.analyzer", "passthrough", vec![], None),
        ("krypt.chorus", "default", vec![], None),
        ("krypt.chorus", "ensemble-6", vec![("voices", 6.0), ("depth", 0.6), ("rate", 0.4), ("spread", 1.0)], None),
        ("krypt.flanger", "default", vec![], None),
        ("krypt.flanger", "through-zero-bar-sync", vec![("throughZero", 1.0), ("sync", 1.0), ("division", 13.0), ("depth", 1.0), ("feedback", 0.3)], None),
        ("krypt.phaser", "default", vec![], None),
        ("krypt.phaser", "12-stage-half-note", vec![("stages", 12.0), ("sync", 1.0), ("division", 11.0), ("feedback", 0.7), ("depth", 0.9)], None),
        ("krypt.gate", "half-time", vec![("pattern", 0.0)], None),
        ("krypt.gate", "stutter-1-8", vec![("pattern", 1.0)], None),
        ("krypt.gate", "stutter-1-16", vec![("pattern", 2.0)], None),
        ("krypt.gate", "triplet-chops", vec![("pattern", 3.0)], None),
        ("krypt.gate", "tape-stop", vec![("pattern", 4.0)], None),
        ("krypt.gate", "reverse-1-4", vec![("pattern", 5.0)], None),
        ("krypt.gate", "scratch", vec![("pattern", 6.0)], None),
        ("krypt.gate", "gate-1-8", vec![("pattern", 7.0)], None),
        ("krypt.gate", "gate-trance", vec![("pattern", 8.0)], None),
        ("krypt.gate", "gate-3-3-2", vec![("pattern", 9.0)], None),
        ("krypt.transient", "punch", vec![("attack", 0.8), ("sustain", -0.3)], None),
        ("krypt.transient", "long-tails", vec![("sustain", 0.8)], None),
        ("krypt.squash", "default", vec![], None),
        ("krypt.squash", "depth-40", vec![("depth", 0.4)], None),
        ("krypt.imager", "mono-bass-wide-top", vec![("lowWidth", 0.0), ("highWidth", 1.8)], None),
    ];
    for (id, name, params, mix) in presets {
        let d = descriptor(id).unwrap();
        let mut fx = create_effect(id, SR, BLOCK).unwrap();
        for (p, v) in &params {
            fx.set_param(d.param_index(p).unwrap_or_else(|| panic!("{id}.{p}")), *v);
        }
        let mix = mix.or(d.default_mix).unwrap_or(1.0);
        let (mut l, mut r) = (src_l.clone(), src_r.clone());
        let mut at = 0;
        while at < n {
            let m = (n - at).min(BLOCK);
            let ctx = ProcessContext { sample_rate: SR, bpm: BPM, beats_per_bar: 4.0, playing: true, beat_pos: at as f64 / frames(1.0) as f64, frames: m };
            let sc = if d.sidechain == Some(true) { Some([&kick_l[at..at + m], &kick_r[at..at + m]]) } else { None };
            fx.process(&ctx, [&mut l[at..at + m], &mut r[at..at + m]], sc);
            at += m;
        }
        // wet/dry like an FX slot, with the dry path delayed by the reported latency
        let lat = fx.latency();
        if mix < 1.0 {
            for i in 0..n {
                let dry = |s: &[f32]| if i >= lat { s[i - lat] } else { 0.0 };
                l[i] = dry(&src_l) * (1.0 - mix) + l[i] * mix;
                r[i] = dry(&src_r) * (1.0 - mix) + r[i] * mix;
            }
        }
        write(&fx_dir, &format!("{}-{}.wav", id.trim_start_matches("krypt."), name), &l, &r);
    }

    // vocal chain demos on a synthetic, slightly out-of-tune "singer"
    let melody: Vec<(f64, f64, u8)> = [60u8, 63, 65, 67, 67, 65, 63, 60].iter().enumerate().map(|(i, &k)| (i as f64, 0.95, k)).collect();
    let voice = synth_voice(&melody, &[35.0, -30.0, 25.0, -40.0, 15.0, -25.0, 30.0, -20.0], 8.0);
    write(&fx_dir, "_voice-off-key.wav", &voice, &voice);
    for (name, params) in [
        ("pitch-hard-tune-c-minor", vec![("root", 0.0f32), ("scale", 2.0), ("speed", 0.0), ("humanize", 0.0)]),
        ("pitch-natural-c-minor", vec![("root", 0.0), ("scale", 2.0), ("speed", 60.0), ("humanize", 0.5)]),
    ] {
        let mut fx = create_effect("krypt.pitch", SR, BLOCK).unwrap();
        for (p, v) in params {
            fx_param(fx.as_mut(), "krypt.pitch", p, v);
        }
        let lat = fx.latency();
        let mut l = voice.clone();
        l.extend(std::iter::repeat_n(0.0, lat));
        let mut r = l.clone();
        run_effect(fx.as_mut(), &mut l, &mut r, None, |_, _| {});
        // latency-compensated, like the engine's PDC
        write(&fx_dir, &format!("{name}.wav"), &l[lat..], &r[lat..]);
    }
    // vocoder: TriOsc chords as the carrier, the singer as the voice
    let nv = voice.len().min(cl.len());
    let (mut l, mut r) = (cl[..nv].to_vec(), cr[..nv].to_vec());
    let mut fx = create_effect("krypt.vocoder", SR, BLOCK).unwrap();
    fx_param(fx.as_mut(), "krypt.vocoder", "bands", 24.0);
    run_effect(fx.as_mut(), &mut l, &mut r, Some((&voice[..nv], &voice[..nv])), |_, _| {});
    write(&fx_dir, "vocoder-chords-carrier.wav", &l, &r);
    // no sidechain: the singer is the input, the internal saw the carrier
    let (mut l, mut r) = (voice.clone(), voice.clone());
    let mut fx = create_effect("krypt.vocoder", SR, BLOCK).unwrap();
    fx_param(fx.as_mut(), "krypt.vocoder", "carrierNote", 43.0);
    run_effect(fx.as_mut(), &mut l, &mut r, None, |_, _| {});
    write(&fx_dir, "vocoder-internal-saw.wav", &l, &r);
    // Gate/Time on automation: a 1/16 stutter only on beats 4 and 8 of the beat
    let (mut l, mut r) = (beat_l[..n].to_vec(), beat_r[..n].to_vec());
    let mut fx = create_effect("krypt.gate", SR, BLOCK).unwrap();
    fx_param(fx.as_mut(), "krypt.gate", "trigger", 1.0);
    fx_param(fx.as_mut(), "krypt.gate", "pattern", 2.0);
    run_effect(fx.as_mut(), &mut l, &mut r, None, |fx, at| {
        let beat = at as f64 / frames(1.0) as f64;
        let on = (3.0..4.0).contains(&beat) || (7.0..8.0).contains(&beat);
        fx_param(fx, "krypt.gate", "active", if on { 1.0 } else { 0.0 });
    });
    write(&fx_dir, "gate-automated-stutter-fills.wav", &l, &r);
    println!("done → {}", out.display());
}
