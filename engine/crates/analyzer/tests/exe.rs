//! End to end: spawn the built krypt-studio-analyzer exe and speak NDJSON.

mod common;

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use common::*;
use serde_json::{json, Value};

#[test]
fn exe_speaks_the_protocol() {
    let dir = temp_dir("exe");
    let wav = dir.join("groove.wav");
    let x = groove(120.0, 6, "x... .... x... ....", ".... x... .... x...", "x.x. x.x. x.x. x.x.", 0.0, 0.3);
    write_wav(&wav, &[x.clone(), x], 44_100);
    let mel = dir.join("melody.wav");
    let mut m = silence(2.5);
    for (i, k) in [60.0, 64.0, 67.0].iter().enumerate() {
        add(&mut m, 0.3 + i as f32 * 0.6, &tone(midi_hz(*k), 0.5, &[0.3]), 0.4);
    }
    write_wav(&mel, &[m], 44_100);

    let mut child = Command::new(env!("CARGO_BIN_EXE_krypt-studio-analyzer"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn analyzer");
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut send = |v: Value| {
        writeln!(stdin, "{v}").unwrap();
        stdin.flush().unwrap();
    };
    let mut events = 0;
    let mut pending: std::collections::HashMap<u64, Value> = Default::default();
    let mut wait = |id: u64, secs: u64| -> Value {
        if let Some(v) = pending.remove(&id) {
            return v;
        }
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            let line = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).unwrap_or_else(|_| panic!("no response for {id}"));
            let v: Value = serde_json::from_str(&line).unwrap_or_else(|e| panic!("stdout line is not JSON: {line} ({e})"));
            if v.get("event").is_some() {
                events += 1;
                continue;
            }
            let got = v["id"].as_u64().unwrap();
            if got == id {
                return v;
            }
            pending.insert(got, v);
        }
    };

    send(json!({"id": 1, "cmd": "hello"}));
    let r = wait(1, 10);
    assert_eq!(r["ok"], json!(true), "{r}");
    assert!(r["data"]["devices"].as_array().unwrap().contains(&json!("cpu")));

    send(json!({"id": 2, "cmd": "analyze", "args": {"path": wav.to_string_lossy(), "sections": true}}));
    send(json!({"id": 3, "cmd": "transcribe", "args": {"path": mel.to_string_lossy(), "mode": "mono"}}));
    let a = wait(2, 60);
    assert_eq!(a["ok"], json!(true), "{a}");
    let bpm = a["data"]["tempo"]["bpm"].as_f64().unwrap();
    assert!((bpm - 120.0).abs() <= 1.0, "bpm {bpm}");
    assert_eq!(a["data"]["channels"], json!(2));
    let t = wait(3, 60);
    assert_eq!(t["ok"], json!(true), "{t}");
    let keys: Vec<u64> = t["data"]["notes"].as_array().unwrap().iter().map(|n| n["key"].as_u64().unwrap()).collect();
    assert_eq!(keys, vec![60, 64, 67]);
    assert_eq!(t["data"]["source"], json!("pyin"));

    send(json!({"id": 4, "cmd": "transcribe", "args": {"path": mel.to_string_lossy(), "mode": "poly", "modelDir": model_dir("basic-pitch").to_string_lossy()}}));
    let p = wait(4, 60);
    assert_eq!(p["ok"], json!(true), "{p}");
    assert!(p["data"]["notes"].as_array().unwrap().iter().any(|n| n["key"] == json!(64)));

    send(json!({"id": 5, "cmd": "analyze", "args": {"path": dir.join("missing.wav").to_string_lossy()}}));
    let e = wait(5, 10);
    assert_eq!(e["ok"], json!(false));
    assert!(e["message"].as_str().unwrap().contains("missing.wav"));

    send(json!("this is not a request object"));
    let b = wait(0, 10);
    assert!(b["message"].as_str().unwrap().starts_with("Bad request"));

    send(json!({"id": 6, "cmd": "cancel", "args": {"target": 2}}));
    assert_eq!(wait(6, 10)["message"], json!("No such job"));

    send(json!({"id": 7, "cmd": "shutdown"}));
    assert_eq!(wait(7, 10)["ok"], json!(true));
    assert!(events > 0, "no progress events");
    let t0 = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(t0.elapsed() < Duration::from_secs(3), "analyzer did not exit after shutdown");
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Krypt Voice commands over the wire: `syllables`, `sing`, and `tts` without a model.
#[test]
fn exe_voice_commands() {
    let dir = temp_dir("exe-voice");
    let speech = dir.join("babas.wav");
    let mut m = silence(1.6);
    for i in 0..4 {
        add(&mut m, 0.15 + i as f32 * 0.35, &tone(180.0, 0.22, &[0.3, 0.15, 0.1]), 0.5);
    }
    write_wav(&speech, &[m], 44_100);
    let sung = dir.join("sung.wav");

    let mut child = Command::new(env!("CARGO_BIN_EXE_krypt-studio-analyzer")).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().expect("spawn analyzer");
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok);
    let mut call = |v: Value| -> Value {
        writeln!(stdin, "{v}").unwrap();
        stdin.flush().unwrap();
        loop {
            let line = lines.next().expect("analyzer closed stdout");
            let r: Value = serde_json::from_str(&line).unwrap();
            if r.get("event").is_none() {
                return r;
            }
        }
    };

    let s = call(json!({"id": 1, "cmd": "syllables", "args": {"path": speech.to_string_lossy(), "expected": 4}}));
    assert_eq!(s["ok"], json!(true), "{s}");
    let syl = s["data"]["syllables"].as_array().unwrap().clone();
    assert_eq!(syl.len(), 4, "{s}");
    assert!(syl.iter().all(|x| x["voiced"] == json!(true)));

    let segments: Vec<Value> = syl
        .iter()
        .enumerate()
        .map(|(i, x)| json!({"srcStartSec": x["startSec"], "srcEndSec": x["endSec"], "outStartSec": 0.5 * i as f64, "durSec": 0.45, "midi": 60 + 2 * i}))
        .collect();
    let r = call(json!({"id": 2, "cmd": "sing", "args": {"path": speech.to_string_lossy(), "out": sung.to_string_lossy(), "segments": segments, "vibrato": 0.2, "glideMs": 40}}));
    assert_eq!(r["ok"], json!(true), "{r}");
    assert!(sung.is_file());
    let segs = r["data"]["segments"].as_array().unwrap();
    assert_eq!(segs.len(), 4);
    assert!(segs.iter().all(|x| x["f0Hz"].as_f64().is_some_and(|f| (f - 180.0).abs() < 3.0)), "{r}");

    let t = call(json!({"id": 3, "cmd": "tts", "args": {"text": "hi", "voice": "af_heart", "out": dir.join("t.wav").to_string_lossy(), "modelDir": dir.join("no-model").to_string_lossy()}}));
    assert_eq!(t["ok"], json!(false));
    assert!(t["message"].as_str().unwrap().contains("Model Manager"), "{t}");

    assert_eq!(call(json!({"id": 4, "cmd": "shutdown"}))["ok"], json!(true));
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
}
