//! krypt-engine "hello sine" sidecar.
//! Protocol: one JSON object per line on stdin -> one JSON reply per line on stdout.
//! stdin EOF (parent died or closed the pipe) => clean exit.

use std::io::{self, BufRead, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::Relaxed};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{OutputCallbackInfo, SampleFormat, StreamConfig};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Cmd {
    Play,
    Stop,
    SetFreq { hz: f32 },
    SetGain { gain: f32 },
    Shutdown,
}

struct Shared {
    playing: AtomicBool,
    freq: AtomicU32, // f32 bits
    gain: AtomicU32, // f32 bits
}

fn reply(out: &mut impl Write, v: serde_json::Value) {
    // Ignore write errors: if stdout is gone, stdin EOF will end us shortly.
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn main() {
    let mut out = io::stdout().lock();
    if let Err(e) = run(&mut out) {
        reply(&mut out, json!({ "event": "fatal", "message": e.to_string() }));
        std::process::exit(2);
    }
}

fn run(out: &mut impl Write) -> Result<(), Box<dyn std::error::Error>> {
    let shared = Arc::new(Shared {
        playing: AtomicBool::new(false),
        freq: AtomicU32::new(440.0f32.to_bits()),
        gain: AtomicU32::new(0.2f32.to_bits()),
    });

    let host = cpal::default_host(); // WASAPI shared mode on Windows
    let device = host.default_output_device().ok_or("no default output device")?;
    let supported = device.default_output_config()?;
    if supported.sample_format() != SampleFormat::F32 {
        return Err(format!("unexpected mix format {:?}", supported.sample_format()).into());
    }
    let config: StreamConfig = supported.into();
    let sr = config.sample_rate as f32;
    let ch = config.channels as usize;

    let s = Arc::clone(&shared);
    let mut phase = 0.0f32;
    let stream = device.build_output_stream(
        config,
        move |data: &mut [f32], _: &OutputCallbackInfo| {
            // Real-time thread: no allocation, no locks, no I/O.
            let playing = s.playing.load(Relaxed);
            let inc = f32::from_bits(s.freq.load(Relaxed)) / sr;
            let gain = f32::from_bits(s.gain.load(Relaxed));
            for frame in data.chunks_mut(ch) {
                let v = if playing { (phase * std::f32::consts::TAU).sin() * gain } else { 0.0 };
                phase += inc;
                if phase >= 1.0 {
                    phase -= 1.0;
                }
                frame.fill(v);
            }
        },
        |err| eprintln!("stream error: {err}"), // stderr is logged by Electron main
        None,
    )?;
    stream.play()?;

    reply(out, json!({ "event": "ready", "sampleRate": sr, "channels": ch, "device": device.id()?.to_string() }));

    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                reply(out, json!({ "id": null, "ok": false, "message": e.to_string() }));
                continue;
            }
        };
        let id = v.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let cmd: Cmd = match serde_json::from_value(v) {
            Ok(c) => c,
            Err(e) => {
                reply(out, json!({ "id": id, "ok": false, "message": e.to_string() }));
                continue;
            }
        };
        match cmd {
            Cmd::Play => shared.playing.store(true, Relaxed),
            Cmd::Stop => shared.playing.store(false, Relaxed),
            Cmd::SetFreq { hz } => shared.freq.store(hz.clamp(20.0, 20_000.0).to_bits(), Relaxed),
            Cmd::SetGain { gain } => shared.gain.store(gain.clamp(0.0, 1.0).to_bits(), Relaxed),
            Cmd::Shutdown => {
                reply(out, json!({ "id": id, "ok": true }));
                return Ok(());
            }
        }
        reply(out, json!({ "id": id, "ok": true }));
    }
    Ok(()) // stdin closed: parent is gone
}
