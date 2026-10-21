//! End to end: `krypt-studio-engine --render` of a project whose channel plays
//! a small generated SFZ kit through `pack:` paths and `--packs-dir`.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

const EXE: &str = env!("CARGO_BIN_EXE_krypt-studio-engine");

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ks-ms-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write_wav(path: &Path, sr: u32, ch: u16, f: impl Fn(usize) -> f32, frames: usize) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let spec = hound::WavSpec { channels: ch, sample_rate: sr, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..frames {
        let v = (f(i) * 32767.0) as i16;
        for _ in 0..ch {
            w.write_sample(v).unwrap();
        }
    }
    w.finalize().unwrap();
}

/// packs/test-kit/{krypt/kit.sfz, samples/*.wav}
fn make_pack(root: &Path) -> PathBuf {
    let packs = root.join("packs");
    let pack = packs.join("test-kit");
    // a C4 sine (44.1 kHz, stereo) and a short noise-free "kick" (a decaying 60 Hz sine)
    write_wav(&pack.join("samples").join("tone c4.wav"), 44_100, 2, |i| 0.5 * (std::f64::consts::TAU * 261.625_565_3 * i as f64 / 44_100.0).sin() as f32, 88_200);
    write_wav(
        &pack.join("samples").join("kick.wav"),
        48_000,
        1,
        |i| {
            let t = i as f64 / 48_000.0;
            (0.8 * (std::f64::consts::TAU * 60.0 * t).sin() * (-t * 8.0).exp()) as f32
        },
        24_000,
    );
    std::fs::create_dir_all(pack.join("krypt")).unwrap();
    std::fs::write(
        pack.join("krypt").join("kit.sfz"),
        "// generated test kit\n\
         <control> default_path=../samples/\n\
         <group> amp_veltrack=0 ampeg_release=0.05\n\
         <region> sample=tone c4.wav lokey=48 hikey=71 pitch_keycenter=c4\n\
         <region> sample=kick.wav key=36 loop_mode=one_shot\n",
    )
    .unwrap();
    packs
}

fn project(sample_path: &str) -> Value {
    let insert = |id: &str, master: bool| {
        json!({ "id": id, "name": id, "color": "#ffffff", "volume": 1, "pan": 0, "stereoSep": 0, "mute": false, "solo": false,
                "phaseInvert": false, "swapLR": false, "slots": {}, "slotOrder": [], "routes": {}, "isMaster": master })
    };
    let note = |id: &str, tick: f64, dur: f64, key: u8| {
        json!({ "id": id, "tick": tick, "dur": dur, "key": key, "vel": 0.9, "pan": 0, "release": 0.5, "fine": 0, "slide": false, "modX": 0.5, "modY": 0.5 })
    };
    json!({
        "schemaVersion": 1, "id": "prj",
        "meta": { "name": "t", "author": "", "genre": "", "notes": "", "createdAt": "" },
        "transport": { "bpm": 120, "timeSig": { "num": 4, "den": 4 }, "swing": 0, "mode": "pattern", "activePatternId": "pa",
                       "loop": { "enabled": false, "start": 0, "end": 0 }, "metronome": false, "masterVolume": 1 },
        "channels": { "ms": { "id": "ms", "name": "Piano", "color": "#fff",
            "generator": { "type": "krypt.multisampler", "params": {}, "sampleId": "s1" },
            "volume": 1, "pan": 0, "pitch": 0, "mute": false, "insertId": "m", "rootKey": 60, "swing": 1,
            "poly": { "mono": false, "glideMs": 0, "cutGroup": 0, "cutBy": 0 } } },
        "channelOrder": ["ms"],
        "patterns": { "pa": { "id": "pa", "name": "A", "color": "#fff", "length": 7680, "notes": { "ms": {
            // A4 for one second (beat 0..2 at 120 bpm), then the kick at beat 3
            "n1": note("n1", 0.0, 1920.0, 69),
            "n2": note("n2", 2880.0, 240.0, 36)
        } } } },
        "patternOrder": ["pa"],
        "playlist": { "tracks": { "t1": { "id": "t1", "name": "T", "color": "#000", "height": 44, "mute": false, "solo": false } },
                      "trackOrder": ["t1"], "clips": {}, "markers": {} },
        "automations": {},
        "mixer": { "inserts": { "m": insert("m", true) }, "insertOrder": ["m"], "masterId": "m" },
        "samples": { "s1": { "id": "s1", "name": "kit", "path": sample_path } }
    })
}

struct Run {
    ok: bool,
    stderr: String,
    left: Vec<f32>,
}

fn render(dir: &Path, sample_path: &str, packs: Option<&Path>) -> Run {
    let proj = dir.join("p.json");
    std::fs::write(&proj, serde_json::to_string(&project(sample_path)).unwrap()).unwrap();
    let out = dir.join("out.wav");
    let _ = std::fs::remove_file(&out);
    let mut cmd = Command::new(EXE);
    cmd.arg("--render").arg(&proj).arg("--out").arg(&out).args(["--scope", "pattern", "--format", "wav32f", "--sample-rate", "48000", "--tail", "0.5"]);
    if let Some(p) = packs {
        cmd.arg("--packs-dir").arg(p);
    }
    let o = cmd.output().expect("run engine");
    let stderr = String::from_utf8_lossy(&o.stderr).into_owned();
    let mut left = Vec::new();
    if o.status.success() {
        let mut r = hound::WavReader::open(&out).expect("open render");
        let ch = r.spec().channels as usize;
        let all: Vec<f32> = r.samples::<f32>().map(|s| s.unwrap()).collect();
        left = all.chunks(ch).map(|f| f[0]).collect();
    }
    Run { ok: o.status.success(), stderr, left }
}

fn freq(x: &[f32], sr: f64) -> f64 {
    let (mut first, mut last, mut n) = (None::<f64>, 0.0, 0usize);
    for i in 1..x.len() {
        if x[i - 1] < 0.0 && x[i] >= 0.0 {
            let t = (i - 1) as f64 + (-x[i - 1] / (x[i] - x[i - 1])) as f64;
            if first.is_none() {
                first = Some(t);
            } else {
                n += 1;
            }
            last = t;
        }
    }
    n as f64 / ((last - first.expect("crossings")) / sr)
}

fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

#[test]
fn renders_a_pack_sfz_kit_through_packs_dir() {
    let dir = temp("ok");
    let packs = make_pack(&dir);
    let r = render(&dir, "pack:test-kit/krypt/kit.sfz", Some(&packs));
    assert!(r.ok, "render failed: {}", r.stderr);
    assert!(r.stderr.contains("Loaded kit.sfz: 2 regions, 2 samples"), "load report: {}", r.stderr);
    let sr = 48_000.0;
    // A4 from a C4 sample (44.1 kHz source): 440 Hz
    let f = freq(&r.left[(0.2 * sr) as usize..(0.9 * sr) as usize], sr);
    assert!((f - 440.0).abs() < 0.5, "{f} Hz");
    assert!(peak(&r.left[..(0.9 * sr) as usize]) > 0.2);
    // released after 1 s (50 ms release): silence before the kick at 1.5 s
    assert!(peak(&r.left[(1.2 * sr) as usize..(1.45 * sr) as usize]) < 1e-3);
    // the kick (key 36, one-shot) at 1.5 s
    assert!(peak(&r.left[(1.5 * sr) as usize..(1.7 * sr) as usize]) > 0.2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn pack_paths_without_packs_dir_or_pack_warn_and_stay_silent() {
    let dir = temp("missing");
    let packs = make_pack(&dir);
    // no --packs-dir: the render still succeeds, silent, with a clear warning
    let r = render(&dir, "pack:test-kit/krypt/kit.sfz", None);
    assert!(r.ok, "{}", r.stderr);
    assert!(r.stderr.contains("Sound pack test-kit isn't installed or the packs folder is unknown"), "{}", r.stderr);
    assert!(peak(&r.left) < 1e-6);
    // a pack that isn't installed
    let r = render(&dir, "pack:grand-piano/krypt/grand.sfz", Some(&packs));
    assert!(r.ok, "{}", r.stderr);
    assert!(r.stderr.contains("Sound pack grand-piano isn't installed"), "{}", r.stderr);
    assert!(peak(&r.left) < 1e-6);
    // an absolute path to the .sfz works without --packs-dir
    let abs = packs.join("test-kit").join("krypt").join("kit.sfz");
    let r = render(&dir, &abs.to_string_lossy(), None);
    assert!(r.ok && peak(&r.left) > 0.2, "{}", r.stderr);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn usage_mentions_packs_dir() {
    let o = Command::new(EXE).arg("--help").output().unwrap();
    let s = String::from_utf8_lossy(&o.stdout);
    assert_eq!(s.matches("--packs-dir <dir>").count(), 2, "{s}");
}

/// Live-engine behaviour main relies on: a `--packs-dir` that doesn't exist yet
/// is fine, a missing pack only warns when used, and loading the project again
/// after the pack is installed brings the channel to life (failures are not
/// cached forever: the cache is keyed by file mtime). Covers both `pack:`
/// paths and the absolute paths main sends in stdio mode.
#[test]
fn a_pack_installed_later_plays_after_the_project_is_loaded_again() {
    use krypt_studio_dsp::{NoteExtras, ProcessContext};
    use krypt_studio_engine::compile::{SampleMode, Session};
    use krypt_studio_engine::model::{Model, Warnings};
    use krypt_studio_engine::plugins::PluginHost;
    use krypt_studio_engine::samples::SampleCache;
    use std::sync::Arc;

    let dir = temp("later");
    let packs = dir.join("packs"); // not created yet
    let abs = packs.join("test-kit").join("krypt").join("kit.sfz");
    for path in ["pack:test-kit/krypt/kit.sfz".to_string(), abs.to_string_lossy().into_owned()] {
        let _ = std::fs::remove_dir_all(&packs);
        let mut s = Session::new(PluginHost::stock(), 48_000.0, Arc::new(SampleCache::new()), dir.clone(), SampleMode::Sync);
        s.packs_dir = Some(packs.clone());
        let load = |s: &mut Session| {
            s.model = Model::from_project(&project(&path), &mut Warnings::default());
            s.version += 1;
            let b = s.build(true);
            let logs: Vec<String> = s.logs.drain(..).map(|(_, m)| m).collect();
            (b, logs)
        };
        let (_, logs) = load(&mut s);
        assert!(logs.iter().any(|m| m.contains("Sound pack test-kit isn't installed")), "{path}: {logs:?}");
        make_pack(&dir);
        let (mut b, logs) = load(&mut s);
        assert!(logs.iter().any(|m| m.contains("Loaded kit.sfz")), "{path}: {logs:?}");
        let inst = b.instruments.iter_mut().find_map(|(_, i)| i.as_mut()).expect("the channel's instrument is re-created");
        inst.note_on(0, 69, 69.0, 1.0, NoteExtras::default());
        let (mut l, mut r) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
        inst.process(&ProcessContext { sample_rate: 48_000.0, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: 4800 }, [&mut l, &mut r]);
        assert!(peak(&l) > 0.2, "{path}: plays after the install");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
