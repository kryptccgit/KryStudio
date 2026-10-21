//! Tonal one-shots: 808s (rendered by krypt.kick808 at C2 = MIDI 36, then
//! coloured with krypt.drive), bass one-shots and chord stabs played on the
//! stock synths (TriOsc, Wave, FM). Every file is tuned to C; its true MIDI
//! root goes into the index (`rootNote`) and the WAV `smpl` chunk.

use super::library::{spec, Spec};
use super::synth::*;
use crate::instruments::kick808::{param_index, Kick808};

/// The 808 root: C2 (65.41 Hz), the same pitch krypt.kick808 plays at MIDI 36.
pub(crate) const ROOT_808: u8 = 36;

#[derive(Clone, Copy)]
struct K8 {
    decay: f32,
    punch: f32,
    punch_ms: f32,
    click: f32,
    drive: f32,
    tone: f32,
}

fn k808(p: K8) -> Vec<f32> {
    let ix = |id: &str| param_index(id).unwrap_or_else(|| panic!("krypt.kick808 has no param {id}"));
    Kick808::render_note(
        SR,
        ROOT_808 as f32,
        &[(ix("decay"), p.decay), (ix("punch"), p.punch), (ix("punchDecay"), p.punch_ms), (ix("click"), p.click), (ix("drive"), p.drive), (ix("tone"), p.tone), (ix("gain"), 0.0)],
        p.decay / 1000.0 + 0.05,
    )
}

/// krypt.drive on a mono signal (mode: 0 Tape, 1 Tube, 2 Hard, 3 Fold, 4 Bitcrush).
fn drv(x: &mut Vec<f32>, mode: f32, drive_db: f32, tone: f32) {
    normalize(x, 0.9);
    effect_mono("krypt.drive", &[("mode", mode), ("drive", drive_db), ("tone", tone), ("output", 0.0)], x, 0.0);
}

fn eights() -> Vec<Spec> {
    let s = |rel: &str, name: &str, tags: &[&'static str], genres: &[&'static str], f: fn() -> Vec<f32>| spec(rel, name, "808", tags, genres, move || vec![f()]).root(ROOT_808).hp(18.0);
    vec![
        s("808/clean.wav", "Clean 808", &["clean", "deep", "long"], &["trap", "drill", "rnb", "pop"], || {
            k808(K8 { decay: 1800.0, punch: 14.0, punch_ms: 35.0, click: 0.05, drive: 0.15, tone: 9000.0 })
        }),
        s("808/long.wav", "Long 808", &["long", "deep", "big"], &["trap", "drill", "phonk"], || k808(K8 { decay: 3800.0, punch: 12.0, punch_ms: 40.0, click: 0.06, drive: 0.3, tone: 7000.0 })),
        s("808/short-punchy.wav", "Short Punchy 808", &["short", "punchy", "hard"], &["trap", "drill", "pop", "afrobeats"], || {
            k808(K8 { decay: 650.0, punch: 30.0, punch_ms: 55.0, click: 0.35, drive: 0.55, tone: 9000.0 })
        }),
        s("808/distorted.wav", "Distorted 808", &["distorted", "aggressive", "dirty", "hard"], &["trap", "phonk", "drill"], || {
            let mut x = k808(K8 { decay: 2000.0, punch: 22.0, punch_ms: 45.0, click: 0.15, drive: 0.6, tone: 9000.0 });
            drv(&mut x, 1.0, 20.0, 6000.0);
            lp(&mut x, 7000.0);
            x
        }),
        s("808/gritty.wav", "Gritty 808", &["gritty", "dirty", "distorted"], &["trap", "phonk", "dubstep"], || {
            let x = k808(K8 { decay: 1800.0, punch: 18.0, punch_ms: 40.0, click: 0.1, drive: 0.4, tone: 9000.0 });
            let mut fold = x.clone();
            drv(&mut fold, 3.0, 12.0, 5000.0);
            let mut out = x;
            normalize(&mut out, 0.9);
            for (o, f) in out.iter_mut().zip(&fold) {
                *o = 0.65 * *o + 0.45 * f;
            }
            lp(&mut out, 6000.0);
            out
        }),
        s("808/round.wav", "Round 808", &["soft", "warm", "clean", "deep"], &["rnb", "lofi", "pop"], || {
            let mut x = k808(K8 { decay: 1600.0, punch: 8.0, punch_ms: 30.0, click: 0.0, drive: 0.1, tone: 1500.0 });
            drv(&mut x, 1.0, 4.0, 2500.0);
            x
        }),
        s("808/drill-punch.wav", "Drill Punch 808", &["punchy", "hard", "long"], &["drill", "trap"], || {
            k808(K8 { decay: 2400.0, punch: 26.0, punch_ms: 70.0, click: 0.25, drive: 0.5, tone: 8000.0 })
        }),
        s("808/phonk-blown.wav", "Blown Phonk 808", &["distorted", "aggressive", "lofi", "dirty"], &["phonk"], || {
            let mut x = k808(K8 { decay: 2000.0, punch: 20.0, punch_ms: 40.0, click: 0.2, drive: 0.8, tone: 9000.0 });
            drv(&mut x, 0.0, 24.0, 4500.0);
            lp(&mut x, 4200.0);
            x
        }),
        s("808/boomy.wav", "Boomy 808", &["big", "deep", "warm", "long"], &["trap", "reggaeton", "rnb", "future-bass"], || {
            let mut x = k808(K8 { decay: 2600.0, punch: 10.0, punch_ms: 50.0, click: 0.05, drive: 0.35, tone: 4000.0 });
            eq(&mut x, LowShelf, 90.0, 0.7, 3.0);
            x
        }),
        s("808/trap-classic.wav", "Classic Trap 808", &["punchy", "deep", "modern"], &["trap"], || {
            k808(K8 { decay: 1500.0, punch: 24.0, punch_ms: 40.0, click: 0.18, drive: 0.4, tone: 7000.0 })
        }),
        s("808/sub-pure.wav", "Pure Sub 808", &["clean", "deep", "soft", "mono"], &["rnb", "pop", "afrobeats", "future-bass", "dubstep"], || {
            k808(K8 { decay: 2000.0, punch: 6.0, punch_ms: 25.0, click: 0.0, drive: 0.0, tone: 2000.0 })
        }),
    ]
}

/// MIDI notes of a chord on C4.
const CM7: [f32; 4] = [60.0, 63.0, 67.0, 70.0];

fn basses() -> Vec<Spec> {
    vec![
        spec("oneshots/bass/reese.wav", "Reese Bass (C)", "bass-oneshot", &["dark", "detuned", "gritty", "wide"], &["dnb", "dubstep", "techno"], || {
            let mut c = play(
                "krypt.triosc",
                &[
                    ("osc1Shape", 2.0),
                    ("osc2Shape", 2.0),
                    ("osc2Fine", 18.0),
                    ("osc2Level", 0.8),
                    ("osc3Shape", 0.0),
                    ("osc3Coarse", -12.0),
                    ("osc3Level", 0.45),
                    ("unisonDetune", 0.35),
                    ("drift", 0.0),
                    ("gain", 0.0),
                    ("ampAttack", 2.0),
                    ("ampDecay", 400.0),
                    ("ampSustain", 0.85),
                    ("ampRelease", 150.0),
                    ("cutoff", 900.0),
                    ("reso", 0.2),
                    ("filterEnvAmount", 0.1),
                ],
                &[36.0],
                1.0,
                1.3,
                1.6,
            );
            for x in c.iter_mut() {
                normalize(x, 0.9);
            }
            let (mut l, mut r) = (c[0].clone(), c[1].clone());
            effect("krypt.drive", &[("mode", 0.0), ("drive", 8.0), ("tone", 5000.0)], &mut l, &mut r, 0.0);
            vec![l, r]
        })
        .root(36),
        spec("oneshots/bass/acid-pluck.wav", "Acid Pluck Bass (C)", "bass-oneshot", &["bright", "short", "gritty", "retro"], &["techno", "house", "tech-house"], || {
            let c = play(
                "krypt.triosc",
                &[
                    ("osc1Shape", 2.0),
                    ("osc2Level", 0.0),
                    ("osc3Level", 0.0),
                    ("unisonDetune", 0.0),
                    ("drift", 0.0),
                    ("gain", 0.0),
                    ("ampAttack", 1.0),
                    ("ampDecay", 300.0),
                    ("ampSustain", 0.3),
                    ("ampRelease", 80.0),
                    ("cutoff", 380.0),
                    ("reso", 0.82),
                    ("filterEnvAmount", 0.75),
                    ("filterEnvDecay", 180.0),
                    ("filterEnvSustain", 0.0),
                ],
                &[36.0],
                1.0,
                0.25,
                0.55,
            );
            let mut x = mono_sum(&c);
            drv(&mut x, 0.0, 10.0, 9000.0);
            vec![x]
        })
        .root(36),
        spec("oneshots/bass/fm-pluck.wav", "FM Pluck Bass (C)", "bass-oneshot", &["punchy", "clean", "short", "modern"], &["house", "pop", "future-bass", "afrobeats"], || {
            let c = play(
                "krypt.fm",
                &[
                    ("algorithm", 4.0),
                    ("op1Ratio", 1.0),
                    ("op1Level", 0.9),
                    ("op1Decay", 500.0),
                    ("op1Sustain", 0.25),
                    ("op1Release", 120.0),
                    ("op2Ratio", 1.0),
                    ("op2Level", 0.5),
                    ("op2Decay", 180.0),
                    ("op2Sustain", 0.0),
                    ("op3Ratio", 0.5),
                    ("op3Level", 0.5),
                    ("op3Decay", 600.0),
                    ("op3Sustain", 0.3),
                    ("op3Detune", 0.0),
                    ("op4Ratio", 1.0),
                    ("op4Level", 0.2),
                    ("op4Decay", 80.0),
                ],
                &[48.0],
                1.0,
                0.4,
                0.75,
            );
            vec![mono_sum(&c)]
        })
        .root(36),
    ]
}

fn stabs() -> Vec<Spec> {
    vec![
        spec("oneshots/stab/house-organ.wav", "House Organ Stab (Cm7)", "stab-oneshot", &["bright", "short", "retro", "punchy"], &["house", "deep-house", "tech-house"], || {
            let c = play(
                "krypt.fm",
                &[
                    ("algorithm", 7.0),
                    ("op1Ratio", 1.0),
                    ("op1Level", 0.8),
                    ("op1Decay", 380.0),
                    ("op1Sustain", 0.0),
                    ("op1Release", 90.0),
                    ("op2Ratio", 2.0),
                    ("op2Level", 0.55),
                    ("op2Decay", 340.0),
                    ("op2Sustain", 0.0),
                    ("op2Release", 90.0),
                    ("op3Ratio", 3.0),
                    ("op3Level", 0.4),
                    ("op3Decay", 300.0),
                    ("op3Sustain", 0.0),
                    ("op3Release", 90.0),
                    ("op3Detune", 0.0),
                    ("op4Ratio", 8.0),
                    ("op4Level", 0.2),
                    ("op4Decay", 18.0),
                    ("op4Sustain", 0.0),
                ],
                &CM7,
                0.9,
                0.3,
                0.6,
            );
            let mut x = mono_sum(&c);
            drv(&mut x, 0.0, 6.0, 9000.0);
            reverb(&vec![x], &rev(2.0, 0.4, 0.9).pre(10.0).low(300.0), 0.18, 0.8)
        })
        .root(60),
        spec("oneshots/stab/minor-supersaw.wav", "Minor Supersaw Stab (Cm)", "stab-oneshot", &["big", "wide", "bright", "detuned"], &["edm", "future-bass", "techno", "dubstep"], || {
            let c = play(
                "krypt.wavetable",
                &[
                    ("table", 0.0),
                    ("position", 0.667),
                    ("unison", 8.0),
                    ("detune", 0.35),
                    ("spread", 0.9),
                    ("cutoff", 6000.0),
                    ("reso", 0.1),
                    ("filterKeyTrack", 0.3),
                    ("ampAttack", 1.0),
                    ("ampDecay", 500.0),
                    ("ampSustain", 0.0),
                    ("ampRelease", 200.0),
                    ("modAttack", 0.1),
                    ("modDecay", 250.0),
                    ("modToCutoff", 0.3),
                    ("gain", 0.0),
                ],
                &[48.0, 60.0, 63.0, 67.0, 72.0],
                0.9,
                0.35,
                0.9,
            );
            reverb(&c, &rev(1.0, 0.7, 1.5).pre(15.0).low(300.0), 0.2, 1.1)
        })
        .root(60),
        spec("oneshots/stab/dub-chord.wav", "Dub Chord Stab (Cm9)", "stab-oneshot", &["deep", "dark", "wide", "evolving"], &["techno", "deep-house", "dubstep"], || {
            let c = play(
                "krypt.triosc",
                &[
                    ("osc1Shape", 2.0),
                    ("osc2Shape", 3.0),
                    ("osc2Fine", 6.0),
                    ("osc2Level", 0.5),
                    ("osc3Level", 0.0),
                    ("unisonDetune", 0.15),
                    ("drift", 0.0),
                    ("gain", 0.0),
                    ("ampAttack", 1.0),
                    ("ampDecay", 250.0),
                    ("ampSustain", 0.0),
                    ("ampRelease", 100.0),
                    ("cutoff", 900.0),
                    ("reso", 0.3),
                    ("filterEnvAmount", 0.4),
                    ("filterEnvDecay", 150.0),
                    ("filterEnvSustain", 0.0),
                ],
                &[60.0, 63.0, 67.0, 70.0, 74.0],
                0.9,
                0.2,
                0.4,
            );
            let mut dl = c[0].clone();
            let mut dr = c[1].clone();
            effect(
                "krypt.delay",
                &[("sync", 1.0), ("division", 7.0), ("feedback", 0.45), ("pingPong", 1.0), ("lowCut", 300.0), ("highCut", 3500.0), ("modDepth", 0.15)],
                &mut dl,
                &mut dr,
                2.0,
            );
            let mut out = c;
            add_ch(&mut out, &vec![dl, dr], 0.5, 0);
            even(&mut out);
            reverb(&out, &rev(1.0, 0.8, 1.8).pre(20.0).low(250.0).damp(5000.0), 0.25, 0.9)
        })
        .root(60)
        .trim(-60.0),
        spec("oneshots/stab/future-chord.wav", "Future Bass Chord (Cmaj9)", "stab-oneshot", &["wide", "bright", "emotional", "euphoric", "detuned"], &["future-bass", "edm", "pop"], || {
            let c = play(
                "krypt.wavetable",
                &[
                    ("table", 0.0),
                    ("position", 0.667),
                    ("unison", 7.0),
                    ("detune", 0.4),
                    ("spread", 1.0),
                    ("cutoff", 7000.0),
                    ("reso", 0.1),
                    ("ampAttack", 8.0),
                    ("ampDecay", 900.0),
                    ("ampSustain", 0.5),
                    ("ampRelease", 300.0),
                    ("modToCutoff", 0.15),
                    ("gain", 0.0),
                ],
                &[48.0, 60.0, 64.0, 67.0, 71.0, 74.0],
                0.85,
                0.9,
                1.5,
            );
            let (mut l, mut r) = (c[0].clone(), c[1].clone());
            effect("krypt.chorus", &[("voices", 3.0), ("rate", 0.5), ("depth", 0.4), ("mix", 0.4)], &mut l, &mut r, 0.0);
            reverb(&vec![l, r], &rev(1.0, 0.75, 1.8).pre(20.0).low(300.0), 0.22, 1.1)
        })
        .root(60),
        spec("oneshots/stab/synth-brass.wav", "Synth Brass Stab (C)", "stab-oneshot", &["bright", "big", "retro", "punchy"], &["synthwave", "pop", "edm"], || {
            let c = play(
                "krypt.triosc",
                &[
                    ("osc1Shape", 2.0),
                    ("osc1Fine", -8.0),
                    ("osc2Shape", 2.0),
                    ("osc2Fine", 8.0),
                    ("osc2Level", 0.8),
                    ("osc3Shape", 2.0),
                    ("osc3Coarse", -12.0),
                    ("osc3Level", 0.3),
                    ("unisonDetune", 0.2),
                    ("drift", 0.0),
                    ("gain", 0.0),
                    ("ampAttack", 8.0),
                    ("ampDecay", 400.0),
                    ("ampSustain", 0.5),
                    ("ampRelease", 150.0),
                    ("cutoff", 700.0),
                    ("reso", 0.2),
                    ("filterEnvAmount", 0.55),
                    ("filterEnvAttack", 15.0),
                    ("filterEnvDecay", 300.0),
                    ("filterEnvSustain", 0.3),
                ],
                &[60.0, 64.0, 67.0, 72.0],
                0.9,
                0.35,
                0.8,
            );
            reverb(&c, &rev(2.0, 0.5, 1.1).pre(12.0).low(250.0), 0.16, 0.8)
        })
        .root(60),
    ]
}

pub(crate) fn specs() -> Vec<Spec> {
    let mut v = eights();
    v.extend(basses());
    v.extend(stabs());
    v
}
