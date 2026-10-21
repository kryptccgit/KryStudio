use crate::clock::ClockShared;
use crate::compile::Session;
use crate::core::Shared;
use crate::midi::MidiSink;
use crate::midi_out::{valid_message, MidiOutManager, MidiOutputInfo};
use crate::protocol::Out;
use crossbeam_channel::Receiver;
use serde_json::{json, Value};
use std::sync::atomic::Ordering::*;
use std::sync::Arc;

pub const HARDWARE_COMMANDS: [&str; 5] = ["listMidiOutputs", "setMidiOutputs", "setMidiClock", "midiSend", "setMidiSync"];

pub const MAX_OFFSET_MS: f64 = 100.0;

pub struct HardwareCtl {
    shared: Arc<ClockShared>,
    sink: Arc<MidiSink>,
    mgr: MidiOutManager,
    outputs_rx: Receiver<Vec<MidiOutputInfo>>,
    clock_ports: Vec<String>,
    offset_ms: f64,
    sync_device: Option<String>,
    last_running: bool,
    last_lost: u32,
    last_dropped: u32,
    last_late_log: u32,
    last_launcher: String,
}

fn strings(v: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in v.and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).filter(|x| !x.is_empty())).into_iter().flatten() {
        if !out.iter().any(|o| o == s) {
            out.push(s.to_string());
        }
    }
    out
}

fn messages(v: Option<&Value>) -> Result<Vec<Vec<u8>>, String> {
    let Some(arr) = v.and_then(|x| x.as_array()) else { return Ok(Vec::new()) };
    if arr.len() > 4096 {
        return Err("midiSend: at most 4096 messages per call".into());
    }
    let mut out = Vec::with_capacity(arr.len());
    for m in arr {
        let Some(bytes) = m.as_array() else { return Err("midiSend: each message is an array of bytes".into()) };
        let mut b = Vec::with_capacity(bytes.len());
        for x in bytes {
            match x.as_u64().filter(|n| *n <= 255) {
                Some(n) => b.push(n as u8),
                None => return Err("midiSend: bytes are integers 0..255".into()),
            }
        }
        valid_message(&b).map_err(|e| format!("midiSend: {e}"))?;
        out.push(b);
    }
    Ok(out)
}

impl HardwareCtl {
    pub fn new(shared: Arc<ClockShared>, sink: Arc<MidiSink>) -> HardwareCtl {
        let (tx, outputs_rx) = crossbeam_channel::unbounded();
        let mgr = MidiOutManager::start(shared.clone(), tx);
        if let Some(sync_tx) = shared.take_sync_tx() {
            sink.set_sync_ring(sync_tx);
        }
        HardwareCtl {
            shared,
            sink,
            mgr,
            outputs_rx,
            clock_ports: Vec::new(),
            offset_ms: 0.0,
            sync_device: None,
            last_running: false,
            last_lost: 0,
            last_dropped: 0,
            last_late_log: 0,
            last_launcher: String::new(),
        }
    }

    pub fn dispatch(&mut self, cmd: &str, v: &Value) -> Option<Result<Value, String>> {
        let r = match cmd {
            "listMidiOutputs" => self.mgr.rescan().map(|l| json!(l)),
            "setMidiOutputs" => {
                let ids = strings(v.get("enabled"));
                self.mgr.set_enabled(ids).map(|l| json!(l))
            }
            "setMidiClock" => {
                let ports = strings(v.get("ports"));
                let offset = v.get("offsetMs").and_then(|x| x.as_f64()).filter(|x| x.is_finite()).unwrap_or(self.offset_ms).clamp(-MAX_OFFSET_MS, MAX_OFFSET_MS);
                for p in self.clock_ports.iter().filter(|p| !ports.contains(p)) {
                    if self.mgr.is_open(p) {
                        self.mgr.send(p.clone(), vec![vec![crate::clock::MIDI_STOP]]);
                    }
                }
                self.offset_ms = offset;
                self.clock_ports = ports.clone();
                self.mgr.set_clock(ports.clone(), (offset * 1e6) as i64);
                self.shared.out_on.store(!ports.is_empty(), Relaxed);
                let open: Vec<&String> = ports.iter().filter(|p| self.mgr.is_open(p)).collect();
                Ok(json!({ "ports": ports, "open": open, "offsetMs": offset }))
            }
            "midiSend" => (|| {
                let port = v.get("port").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).ok_or("midiSend needs a 'port' (a MIDI output id)")?.to_string();
                let msgs = messages(v.get("messages"))?;
                let at_close = match v.get("atClose") {
                    Some(x) if !x.is_null() => Some(messages(Some(x))?),
                    _ => None,
                };
                if !self.mgr.is_open(&port) {
                    return Err(format!("MIDI output '{port}' isn't open"));
                }
                let n = msgs.len();
                if n > 0 {
                    self.mgr.send(port.clone(), msgs);
                }
                if let Some(m) = at_close {
                    self.mgr.at_close(port, m);
                }
                Ok(json!({ "sent": n }))
            })(),
            "setMidiSync" => {
                let device = v.get("device").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(String::from);
                self.sink.set_sync_device(device.clone());
                self.shared.sync_on.store(device.is_some(), Relaxed);
                self.sync_device = device.clone();
                Ok(json!({ "device": device }))
            }
            _ => return None,
        };
        Some(r)
    }

    pub fn tick(&mut self, session: &Session, core: &Shared, out: &Out) -> Option<bool> {
        let mut latest = None;
        while let Ok(l) = self.outputs_rx.try_recv() {
            latest = Some(l);
        }
        if let Some(l) = latest {
            out.event(json!({ "event": "midiOutputs", "outputs": l }));
        }
        let mut ret = None;
        let running = self.shared.sync_running.load(Relaxed);
        let lost = self.shared.sync_lost.load(Relaxed);
        if lost != self.last_lost {
            self.last_lost = lost;
            out.log("warn", format!("The external MIDI clock from {} stopped arriving, so playback paused.", self.sync_device.as_deref().unwrap_or("the sync input")));
            out.event(json!({ "event": "midiSync", "running": false, "bpm": Value::Null, "lost": true }));
            self.last_running = false;
            ret = Some(false);
        } else if running != self.last_running {
            self.last_running = running;
            out.event(json!({ "event": "midiSync", "running": running, "bpm": self.shared.bpm().map(|b| (b * 100.0).round() / 100.0) }));
            ret = Some(running);
        }
        let dropped = self.shared.out_dropped.load(Relaxed);
        if dropped != self.last_dropped {
            self.last_dropped = dropped;
            out.log("warn", format!("MIDI clock queue overflowed ({dropped} messages lost so far)"));
        }
        let late = self.shared.out_late.load(Relaxed);
        if late >= self.last_late_log.saturating_mul(2).max(16) {
            self.last_late_log = late;
            out.log("warn", format!("{late} MIDI clock messages left more than 1 ms late (a busy CPU, or a negative clock offset larger than the output latency)"));
        }
        let tel = crate::launcher::telemetry(&core.launch, &session.names.launch);
        let state = match &tel {
            Some(t) => json!({ "playing": t.playing, "queued": t.queued, "overridden": t.overridden, "recording": t.recording }),
            None => json!({ "playing": {}, "queued": {}, "overridden": [], "recording": false }),
        };
        let key = state.to_string();
        if key != self.last_launcher {
            self.last_launcher = key;
            let mut ev = state;
            ev["event"] = json!("launcherState");
            out.event(ev);
        }
        ret
    }

    pub fn shutdown(&self) {
        self.mgr.shutdown();
    }
}
