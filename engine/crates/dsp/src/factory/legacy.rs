//! The original 11-sample procedural kit (`drums/*.wav`). Every older project
//! points at these paths, so the recipes below are frozen: changing a single
//! number here changes how saved songs sound. New sounds go into the library
//! (`super::library`), never here. Written as 48 kHz / 24-bit WAVs, each
//! normalized to -1 dBFS true peak.

use std::io;
use std::path::{Path, PathBuf};

use crate::effects::reverb::Reverb;
use crate::instruments::drums::{render, DrumKind, DrumParams};
use crate::instruments::kick808::{param_index, Kick808};
use crate::wav::{write_wav, WavFormat};
use crate::{Effect, ProcessContext};

pub const KIT_SAMPLE_RATE: u32 = 48_000;
const PEAK_DB: f32 = -1.0;

fn p(tune: f32, decay_ms: f32, tone: f32, snap: f32, drive: f32) -> DrumParams {
    DrumParams { tune, decay_ms, tone, snap, drive }
}

/// Partially decorrelated stereo pair from two renders (width 0..1).
fn stereo_pair(a: &[f32], b: &[f32], width: f32) -> Vec<Vec<f32>> {
    let n = a.len().max(b.len());
    let get = |v: &[f32], i: usize| v.get(i).copied().unwrap_or(0.0);
    let (wa, wb) = (1.0 - 0.5 * width, 0.5 * width);
    let l = (0..n).map(|i| wa * get(a, i) + wb * get(b, i)).collect();
    let r = (0..n).map(|i| wb * get(a, i) + wa * get(b, i)).collect();
    vec![l, r]
}

/// Add a reverb send (`wet` 0..1) to a mono or stereo sound, extending it by `tail_s`.
fn with_reverb(ch: Vec<Vec<f32>>, params: &[(&str, f32)], wet: f32, tail_s: f32) -> Vec<Vec<f32>> {
    let sr = KIT_SAMPLE_RATE as f32;
    let n = ch[0].len() + (tail_s * sr) as usize;
    let get = |c: &Vec<f32>, i: usize| c.get(i).copied().unwrap_or(0.0);
    let dry_l: Vec<f32> = (0..n).map(|i| get(&ch[0], i)).collect();
    let dry_r: Vec<f32> = (0..n).map(|i| get(ch.get(1).unwrap_or(&ch[0]), i)).collect();
    let mut rv = Reverb::new(sr, 512);
    let desc = crate::effects::reverb::descriptor();
    for (id, v) in params {
        if let Some(i) = desc.param_index(id) {
            rv.set_param(i, *v);
        }
    }
    let (mut wl, mut wr) = (dry_l.clone(), dry_r.clone());
    let mut at = 0;
    while at < n {
        let m = (n - at).min(512);
        let ctx = ProcessContext { sample_rate: sr, bpm: 120.0, beats_per_bar: 4.0, playing: false, beat_pos: 0.0, frames: m };
        rv.process(&ctx, [&mut wl[at..at + m], &mut wr[at..at + m]], None);
        at += m;
    }
    let l = (0..n).map(|i| dry_l[i] + wet * wl[i]).collect();
    let r = (0..n).map(|i| dry_r[i] + wet * wr[i]).collect();
    vec![l, r]
}

/// Trim trailing near-silence, fade the last 5 ms, normalize so the larger of
/// sample peak and true peak sits at `PEAK_DB` (no inter-sample overs).
fn master(mut ch: Vec<Vec<f32>>) -> Vec<Vec<f32>> {
    let sr = KIT_SAMPLE_RATE as f32;
    let peak = ch.iter().map(|c| crate::blocks::truepeak::true_peak(c)).fold(0.0f32, f32::max);
    if peak <= 0.0 {
        return ch;
    }
    // trim below -80 dB relative to the peak
    let thr = peak * 1e-4;
    let last = ch.iter().map(|c| c.iter().rposition(|v| v.abs() > thr).unwrap_or(0)).max().unwrap_or(0);
    let len = (last + 1 + (0.005 * sr) as usize).min(ch[0].len());
    for c in ch.iter_mut() {
        c.truncate(len);
    }
    let fade = ((0.005 * sr) as usize).min(len);
    let g = 10f32.powf(PEAK_DB / 20.0) / peak;
    for c in ch.iter_mut() {
        let n = c.len();
        for (i, v) in c.iter_mut().enumerate() {
            *v *= g;
            if i + fade >= n {
                *v *= (n - i) as f32 / fade as f32;
            }
        }
    }
    ch
}

/// Every factory sample: (file name, channels).
pub fn render_kit() -> Vec<(&'static str, Vec<Vec<f32>>)> {
    let sr = KIT_SAMPLE_RATE as f32;
    let mono = |v: Vec<f32>| vec![v];
    let mut kit: Vec<(&'static str, Vec<Vec<f32>>)> = Vec::new();

    // Kick: deep, clean, punchy — ~47 Hz body, knock sweep, short click.
    kit.push(("kick.wav", mono(render(DrumKind::Kick, p(0.0, 300.0, 0.55, 0.55, 0.35), sr, 11))));
    // Kick 2: tighter, higher, more knock and drive (house / techno).
    kit.push(("kick-2.wav", mono(render(DrumKind::Kick, p(2.5, 220.0, 0.85, 0.8, 0.6), sr, 12))));
    // Snare: body + bright wires, small room.
    let sn = render(DrumKind::Snare, p(0.0, 220.0, 0.6, 0.65, 0.3), sr, 13);
    kit.push((
        "snare.wav",
        with_reverb(
            vec![sn],
            &[("mode", 0.0), ("size", 0.3), ("decay", 0.7), ("predelay", 4.0), ("damping", 9000.0), ("lowCut", 250.0), ("diffusion", 0.85)],
            0.16,
            0.6,
        ),
    ));
    // Clap: four bursts, slightly different per side, short plate.
    let ca = render(DrumKind::Clap, p(0.0, 210.0, 0.5, 0.5, 0.2), sr, 21);
    let cb = render(DrumKind::Clap, p(0.0, 210.0, 0.5, 0.5, 0.2), sr, 22);
    kit.push((
        "clap.wav",
        with_reverb(
            stereo_pair(&ca, &cb, 0.5),
            &[("mode", 2.0), ("size", 0.35), ("decay", 1.0), ("predelay", 8.0), ("damping", 8000.0), ("lowCut", 300.0)],
            0.2,
            0.8,
        ),
    ));
    // Hats: crisp, metallic + noise.
    kit.push(("hat-closed.wav", mono(render(DrumKind::ClosedHat, p(0.0, 300.0, 0.6, 0.55, 0.05), sr, 31))));
    let oa = render(DrumKind::OpenHat, p(0.0, 260.0, 0.6, 0.5, 0.05), sr, 32);
    let ob = render(DrumKind::OpenHat, p(0.0, 260.0, 0.6, 0.5, 0.05), sr, 33);
    kit.push(("hat-open.wav", stereo_pair(&oa, &ob, 0.2)));
    kit.push(("rim.wav", mono(render(DrumKind::Rim, p(0.0, 250.0, 0.5, 0.5, 0.3), sr, 41))));
    kit.push(("perc.wav", mono(render(DrumKind::Perc, p(0.0, 250.0, 0.5, 0.4, 0.1), sr, 42))));
    kit.push(("tom.wav", mono(render(DrumKind::Tom, p(-2.0, 300.0, 0.5, 0.4, 0.15), sr, 43))));
    let xa = render(DrumKind::Crash, p(0.0, 320.0, 0.5, 0.5, 0.05), sr, 51);
    let xb = render(DrumKind::Crash, p(0.3, 320.0, 0.5, 0.5, 0.05), sr, 52);
    kit.push(("crash.wav", stereo_pair(&xa, &xb, 0.6)));
    // 808 at C2 (MIDI 36, 65.4 Hz), long decay with drive for small speakers.
    let ix = |id: &str| param_index(id).unwrap_or(usize::MAX);
    let b808 = Kick808::render_note(
        sr,
        36.0,
        &[
            (ix("decay"), 1600.0),
            (ix("punch"), 20.0),
            (ix("punchDecay"), 45.0),
            (ix("click"), 0.12),
            (ix("drive"), 0.45),
            (ix("tone"), 5000.0),
            (ix("gain"), 0.0),
        ],
        1.8,
    );
    kit.push(("808.wav", mono(b808)));

    kit.into_iter().map(|(n, c)| (n, master(c))).collect()
}

/// Write the factory kit WAVs into `dir` (creates `dir/drums/*.wav`):
/// kick, kick-2, snare, clap, hat-closed, hat-open, rim, perc, tom, crash, 808.
/// Returns the written paths.
pub fn generate_kit(dir: &Path) -> io::Result<Vec<PathBuf>> {
    write_kit(dir, &render_kit())
}

/// Write rendered kit samples to `dir/drums/<name>` (24-bit, as always).
pub(crate) fn write_kit(dir: &Path, kit: &[(&'static str, Vec<Vec<f32>>)]) -> io::Result<Vec<PathBuf>> {
    let drums = dir.join("drums");
    std::fs::create_dir_all(&drums)?;
    let mut out = Vec::new();
    for (name, ch) in kit {
        let path = drums.join(name);
        let refs: Vec<&[f32]> = ch.iter().map(|c| c.as_slice()).collect();
        write_wav(&path, &refs, KIT_SAMPLE_RATE, WavFormat::Pcm24)?;
        out.push(path);
    }
    Ok(out)
}
