use crate::compile::Session;
use crate::input::{take_path, AudioDone, InputManager};
use crate::midi::{now_ns, CcEv, CcThrottle, MidiInputInfo, MidiManager, MidiPolicy, MidiSink};
use crate::program::NONE;
use crate::protocol::Out;
use crate::record::{LiveCtlEnds, LiveShared, RecMsg};
use crossbeam_channel::Receiver;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering::*;
use std::sync::Arc;
use std::time::{Duration, Instant};

const AUDIO_TAKE_TIMEOUT: Duration = Duration::from_secs(8);

struct TakeAcc {
    take: u32,
    song: bool,
    start_tick: f64,
    pattern_id: Option<String>,
    audio: bool,
    notes: Vec<Value>,
    ended_at: Option<Instant>,
    wraps: Vec<f64>,
    loop_lo: f64,
    loop_hi: f64,
    passes: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pass {
    pub start_tick: f64,
    pub end_tick: f64,
    pub sec: f64,
}

pub fn take_passes(start_tick: f64, wraps: &[f64], lo: f64, hi: f64, len_sec: f64, bpm: f64) -> Vec<Pass> {
    let mut out = Vec::with_capacity(wraps.len() + 1);
    let mut starts = vec![(start_tick, 0.0)];
    starts.extend(wraps.iter().map(|&w| (lo, w)));
    for (i, &(t, sec)) in starts.iter().enumerate() {
        let end = if i + 1 < starts.len() {
            hi
        } else {
            (t + crate::time::seconds_to_ticks((len_sec - sec).max(0.0), bpm.clamp(10.0, 999.0))).min(hi)
        };
        out.push(Pass { start_tick: t, end_tick: end.max(t), sec });
    }
    out
}

pub struct LiveControl {
    out: Arc<Out>,
    live: Arc<LiveShared>,
    sink: Arc<MidiSink>,
    midi: MidiManager,
    cc_rx: Receiver<CcEv>,
    inputs_rx: Receiver<Vec<MidiInputInfo>>,
    rec_rx: rtrb::Consumer<RecMsg>,
    throttle: CcThrottle,
    input: InputManager,
    target_id: Option<String>,
    takes: Vec<TakeAcc>,
    armed: bool,
    rec_audio: bool,
    monitor: bool,
    meter: bool,
    in_device: Option<String>,
    in_channels: Vec<u16>,
    opened: Option<(Option<String>, Vec<u16>)>,
    record_dir: Option<PathBuf>,
    record_name: String,
    last_dropped: u32,
    monitor_rate_warned: bool,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(String::from)
}

fn b(v: &Value, k: &str) -> Option<bool> {
    v.get(k).and_then(|x| x.as_bool())
}

impl LiveControl {
    pub fn new(ends: LiveCtlEnds, out: Arc<Out>) -> LiveControl {
        let (inputs_tx, inputs_rx) = crossbeam_channel::unbounded();
        let midi = MidiManager::start(ends.sink.clone(), inputs_tx);
        let input = InputManager::start(ends.live.clone(), ends.win_rx, ends.mon_tx);
        LiveControl {
            out,
            live: ends.live,
            sink: ends.sink,
            midi,
            cc_rx: ends.cc_rx,
            inputs_rx,
            rec_rx: ends.rec_rx,
            throttle: CcThrottle::default(),
            input,
            target_id: None,
            takes: Vec::new(),
            armed: false,
            rec_audio: false,
            monitor: false,
            meter: false,
            in_device: None,
            in_channels: Vec::new(),
            opened: None,
            record_dir: None,
            record_name: "Recording".into(),
            last_dropped: 0,
            monitor_rate_warned: false,
        }
    }

    pub fn dispatch(&mut self, cmd: &str, v: &Value, session: &Session) -> Option<Result<Value, String>> {
        let r = match cmd {
            "listMidiInputs" => self.midi.rescan().map(|l| json!(l)),
            "setMidiInputs" => {
                let mut enabled = HashMap::new();
                if let Some(m) = v.get("enabled").and_then(|x| x.as_object()) {
                    for (k, val) in m {
                        if let Some(on) = val.as_bool() {
                            enabled.insert(k.clone(), on);
                        }
                    }
                }
                let policy = MidiPolicy { auto_enable: b(v, "autoEnable").unwrap_or(true), enabled };
                self.midi.set_policy(policy).map(|l| json!(l))
            }
            "setMidiTarget" => {
                self.target_id = s(v, "channelId").filter(|x| !x.is_empty());
                self.resolve_target(session);
                Ok(json!({ "resolved": self.live.target_slot.load(Relaxed) != NONE }))
            }
            "listInputDevices" => self.input.list().map(|l| json!(l)),
            "setAudioInput" => {
                if v.get("deviceId").is_some() {
                    self.in_device = s(v, "deviceId").filter(|x| !x.is_empty());
                }
                if let Some(chs) = v.get("channels").and_then(|x| x.as_array()) {
                    self.in_channels = chs.iter().filter_map(|c| c.as_u64()).filter(|c| *c < 64).map(|c| c as u16).take(2).collect();
                }
                if let Some(m) = b(v, "monitor") {
                    self.monitor = m;
                }
                if let Some(m) = b(v, "meter") {
                    self.meter = m;
                }
                self.apply_input(session, true);
                Ok(json!(self.input.status()))
            }
            "setRecord" => {
                self.armed = b(v, "armed").unwrap_or(self.armed);
                let midi = b(v, "midi").unwrap_or(true);
                self.rec_audio = b(v, "audio").unwrap_or(self.rec_audio);
                let bars = v.get("countInBars").and_then(|x| x.as_u64()).unwrap_or(0).min(4) as u32;
                if let Some(d) = s(v, "dir").filter(|x| !x.is_empty()) {
                    self.record_dir = Some(PathBuf::from(d));
                }
                if let Some(n) = s(v, "name") {
                    self.record_name = n;
                }
                self.live.rec_midi.store(midi, Relaxed);
                self.live.rec_audio.store(self.rec_audio, Relaxed);
                self.live.count_in_bars.store(bars, Relaxed);
                self.live.armed.store(self.armed, Relaxed);
                self.apply_input(session, false);
                Ok(self.record_status())
            }
            "recordStatus" => Ok(self.record_status()),
            "debugMidiIn" => self.debug_midi_in(v),
            "virtualMidiIn" => self.virtual_midi_in(v),
            _ => return None,
        };
        Some(r)
    }

    fn record_status(&self) -> Value {
        json!({
            "armed": self.armed,
            "state": match self.live.state.load(Relaxed) { 1 => "countIn", 2 => "recording", _ => "idle" },
            "input": self.input.status(),
        })
    }

    fn debug_midi_in(&self, v: &Value) -> Result<Value, String> {
        if !cfg!(debug_assertions) {
            return Err("debugMidiIn is only available in debug engine builds".into());
        }
        let Some(arr) = v.get("bytes").and_then(|x| x.as_array()) else {
            return Err("debugMidiIn needs 'bytes' (an array of 0..255)".into());
        };
        let bytes: Vec<u8> = arr.iter().filter_map(|x| x.as_u64()).map(|x| x.min(255) as u8).collect();
        let dev: Arc<str> = Arc::from(s(v, "device").unwrap_or_else(|| "Debug MIDI".into()).as_str());
        let before = self.live.midi_in.load(Relaxed);
        let mut running = 0u8;
        self.sink.feed(&dev, &bytes, &mut running);
        Ok(json!({ "messages": self.live.midi_in.load(Relaxed).wrapping_sub(before) }))
    }

    fn virtual_midi_in(&self, v: &Value) -> Result<Value, String> {
        let (dev, bytes) = virtual_midi(v)?;
        let before = self.live.midi_in.load(Relaxed);
        let mut running = 0u8;
        self.sink.feed(&dev, &bytes, &mut running);
        Ok(json!({ "messages": self.live.midi_in.load(Relaxed).wrapping_sub(before) }))
    }

    fn want_input(&self) -> bool {
        (self.armed && self.rec_audio) || self.monitor || self.meter
    }

    fn audio_pending(&self) -> bool {
        self.takes.iter().any(|t| t.audio) || self.live.state.load(Relaxed) == crate::record::STATE_RECORDING
    }

    fn apply_input(&mut self, session: &Session, force_reopen: bool) {
        let want = self.want_input();
        let cfg = (self.in_device.clone(), self.in_channels.clone());
        if want {
            let open = self.input.is_open();
            if !open || self.opened.as_ref() != Some(&cfg) || (force_reopen && !open) {
                if self.audio_pending() && open {
                } else {
                    let st = self.input.open(cfg.0.clone(), cfg.1.clone());
                    if st.open {
                        self.out.log("info", format!("Audio input: {} ({} Hz, channel{} {})", st.name.clone().unwrap_or_default(), st.sample_rate, if st.channels.len() > 1 { "s" } else { "" }, st.channels.iter().map(|c| (c + 1).to_string()).collect::<Vec<_>>().join("+")));
                    } else if let Some(m) = &st.message {
                        self.out.log("warn", m.clone());
                    }
                    self.opened = Some(cfg);
                    self.monitor_rate_warned = false;
                }
            }
        } else if self.input.is_open() && !self.audio_pending() {
            self.input.close();
            self.opened = None;
        }
        self.update_monitor(session);
    }

    fn update_monitor(&mut self, session: &Session) {
        let st = self.input.status();
        let rate_ok = st.open && (st.sample_rate as f32 - session.sr).abs() < 1.0;
        if self.monitor && st.open && !rate_ok && !self.monitor_rate_warned {
            self.monitor_rate_warned = true;
            self.out.log("warn", format!("Input monitoring is off: the input runs at {} Hz and the output at {} Hz. Set both devices to the same rate in Windows sound settings.", st.sample_rate, session.sr));
        }
        self.live.monitor.store(self.monitor && rate_ok, Relaxed);
    }

    fn resolve_target(&mut self, session: &Session) {
        let slot = match &self.target_id {
            Some(id) if session.model.channels.contains_key(id) => session.channel_slot(id).unwrap_or(NONE),
            _ => NONE,
        };
        if self.live.target_slot.load(Relaxed) != slot {
            self.live.target_slot.store(slot, Relaxed);
        }
    }

    pub fn tick(&mut self, session: &Session) {
        self.resolve_target(session);

        let now = now_ns();
        let mut ccs: Vec<CcEv> = Vec::new();
        while let Ok(ev) = self.cc_rx.try_recv() {
            if let Some(value) = self.throttle.offer(&ev, now) {
                ccs.push(CcEv { value, ..ev });
            }
        }
        ccs.extend(self.throttle.flush(now));
        for ev in ccs {
            self.out.event(json!({ "event": "midiCc", "device": &*ev.device, "channel": ev.ch, "cc": ev.cc, "value": ev.value }));
        }

        let mut latest = None;
        while let Ok(l) = self.inputs_rx.try_recv() {
            latest = Some(l);
        }
        if let Some(l) = latest {
            self.out.event(json!({ "event": "midiInputs", "inputs": l }));
        }

        while let Ok(m) = self.rec_rx.pop() {
            self.on_rec(m, session);
        }
        while let Ok(d) = self.input.done_rx.try_recv() {
            self.on_audio_done(d);
        }
        while let Ok(e) = self.input.err_rx.try_recv() {
            self.out.log("warn", format!("Audio input lost: {e}"));
            self.opened = None;
            self.live.monitor.store(false, Relaxed);
            self.out.event(json!({ "event": "inputStatus", "status": self.input.status() }));
        }
        let mut i = 0;
        while i < self.takes.len() {
            let t = &self.takes[i];
            if t.audio && t.ended_at.is_some_and(|e| e.elapsed() > AUDIO_TAKE_TIMEOUT) {
                let t = self.takes.remove(i);
                self.emit(&t, Vec::new(), true, false, Some(Value::Null), Some("The audio input stopped delivering, so the audio take was lost.".into()));
                continue;
            }
            i += 1;
        }
        if !self.want_input() && self.input.is_open() && !self.audio_pending() {
            self.input.close();
            self.opened = None;
            self.live.monitor.store(false, Relaxed);
        }
        let dropped = self.live.rt_dropped.load(Relaxed);
        if dropped != self.last_dropped {
            self.last_dropped = dropped;
            self.out.log("warn", format!("Live input queues overflowed ({dropped} events lost so far)"));
        }
    }

    fn channel_id(session: &Session, slot: u32) -> Option<String> {
        session.names.channels.iter().find(|(s, _)| *s == slot).map(|(_, id)| id.clone())
    }

    fn pattern_id(session: &Session, slot: u32) -> Option<String> {
        if slot == NONE {
            return None;
        }
        session.names.patterns.iter().find(|(s, _)| *s == slot).map(|(_, id)| id.clone())
    }

    fn on_rec(&mut self, m: RecMsg, session: &Session) {
        match m {
            RecMsg::Start { take, song, start_tick, pattern_slot, midi: _, audio } => {
                let audio = audio && self.input.is_open();
                if self.live.rec_audio.load(Relaxed) && !audio {
                    self.out.log("warn", "Audio recording is on but no audio input is open; recording MIDI only. Pick an input in Settings.");
                }
                if audio {
                    let dir = self.record_dir.clone().unwrap_or_else(|| std::env::temp_dir().join("Krypt Studio recordings"));
                    let path = take_path(&dir, &self.record_name, take);
                    self.input.begin_take(take, path);
                }
                self.takes.push(TakeAcc { take, song, start_tick, pattern_id: Self::pattern_id(session, pattern_slot), audio, notes: Vec::new(), ended_at: None, wraps: Vec::new(), loop_lo: 0.0, loop_hi: 0.0, passes: None });
            }
            RecMsg::Note { take, slot, pattern_slot, key, vel, tick, dur, pass } => {
                let Some(channel_id) = Self::channel_id(session, slot) else { return };
                let Some(t) = self.takes.iter_mut().find(|t| t.take == take) else { return };
                let pattern_id = if t.song { None } else { Self::pattern_id(session, pattern_slot) };
                t.notes.push(json!({ "channelId": channel_id, "patternId": pattern_id, "tick": tick, "dur": dur, "key": key, "vel": vel, "pass": pass }));
            }
            RecMsg::Wrap { take, sec, lo, hi } => {
                if let Some(i) = self.takes.iter().position(|t| t.take == take) {
                    if self.takes[i].song {
                        let t = &mut self.takes[i];
                        t.wraps.push(sec);
                        t.loop_lo = lo;
                        t.loop_hi = hi;
                    } else if !self.takes[i].notes.is_empty() {
                        let notes = std::mem::take(&mut self.takes[i].notes);
                        let t = &self.takes[i];
                        self.emit(t, notes, false, false, None, None);
                    }
                }
            }
            RecMsg::End { take, sec } => {
                if let Some(i) = self.takes.iter().position(|t| t.take == take) {
                    let notes = std::mem::take(&mut self.takes[i].notes);
                    self.takes[i].ended_at = Some(Instant::now());
                    let t = &mut self.takes[i];
                    if t.song && !t.wraps.is_empty() {
                        let ps = take_passes(t.start_tick, &t.wraps, t.loop_lo, t.loop_hi, sec, session.model.transport.bpm);
                        t.passes = Some(json!(ps.iter().map(|p| json!({ "startTick": p.start_tick, "endTick": p.end_tick, "sec": p.sec })).collect::<Vec<_>>()));
                    }
                    let audio = self.takes[i].audio;
                    let t = &self.takes[i];
                    self.emit(t, notes, !audio, audio, None, None);
                    if !audio {
                        self.takes.remove(i);
                    }
                }
            }
        }
    }

    fn on_audio_done(&mut self, d: AudioDone) {
        let Some(i) = self.takes.iter().position(|t| t.take == d.take && t.audio) else {
            if let Some(e) = d.error {
                self.out.log("warn", e);
            }
            return;
        };
        let t = self.takes.remove(i);
        if let Some(e) = &d.error {
            self.out.log("error", format!("Audio recording failed: {e}"));
            self.emit(&t, Vec::new(), true, false, Some(Value::Null), Some(e.clone()));
            return;
        }
        let audio = json!({
            "path": d.path,
            "frames": d.frames,
            "sampleRate": d.sample_rate,
            "channels": d.channels,
            "startTick": t.start_tick,
            "peak": d.peak,
        });
        self.emit(&t, Vec::new(), true, false, Some(audio), None);
    }

    fn emit(&self, t: &TakeAcc, notes: Vec<Value>, fin: bool, audio_pending: bool, audio: Option<Value>, error: Option<String>) {
        let mut ev = json!({
            "event": "recorded",
            "take": t.take,
            "final": fin,
            "mode": if t.song { "song" } else { "pattern" },
            "patternId": t.pattern_id,
            "startTick": t.start_tick,
            "notes": notes,
            "audioPending": audio_pending,
        });
        if let Some(a) = audio {
            ev["audio"] = a;
        }
        if let Some(p) = &t.passes {
            ev["passes"] = p.clone();
        }
        if let Some(e) = error {
            ev["error"] = json!(e);
        }
        self.out.event(ev);
    }

    pub fn shutdown(&mut self) {
        self.input.shutdown();
        self.midi.shutdown();
    }
}

const MAX_VIRTUAL_BYTES: usize = 192;

fn virtual_midi(v: &Value) -> Result<(Arc<str>, Vec<u8>), String> {
    let dev = s(v, "device").unwrap_or_default();
    if !dev.starts_with("Krypt: ") || dev.chars().count() > 64 {
        return Err("virtualMidiIn needs a 'device' named \"Krypt: …\" (at most 64 characters)".into());
    }
    let arr = v.get("bytes").and_then(|x| x.as_array()).ok_or("virtualMidiIn needs 'bytes' (an array of 0..255)")?;
    if arr.is_empty() || arr.len() > MAX_VIRTUAL_BYTES || arr.len() % 3 != 0 {
        return Err(format!("virtualMidiIn takes 1..{} whole 3-byte messages", MAX_VIRTUAL_BYTES / 3));
    }
    let mut bytes = Vec::with_capacity(arr.len());
    for (i, x) in arr.iter().enumerate() {
        let b = x.as_u64().filter(|b| *b <= 255).ok_or("virtualMidiIn bytes must be integers 0..255")? as u8;
        let ok = if i % 3 == 0 { (0x80..=0xBF).contains(&b) } else { b < 0x80 };
        if !ok {
            return Err("virtualMidiIn only carries note and CC messages (status 0x80..0xBF + two data bytes)".into());
        }
        bytes.push(b);
    }
    Ok((Arc::from(dev.as_str()), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_midi_accepts_whole_note_and_cc_messages_from_krypt_devices() {
        let (d, b) = virtual_midi(&json!({ "device": "Krypt: Pad", "bytes": [0x90, 36, 100, 0xB0, 74, 64] })).unwrap();
        assert_eq!((&*d, b), ("Krypt: Pad", vec![0x90, 36, 100, 0xB0, 74, 64]));
        for bad in [
            json!({ "device": "loopMIDI Port", "bytes": [0x90, 36, 100] }),
            json!({ "device": "Krypt: Pad", "bytes": [0x90, 36] }),
            json!({ "device": "Krypt: Pad", "bytes": [0xF0, 1, 2] }),
            json!({ "device": "Krypt: Pad", "bytes": [0xE0, 0, 64] }),
            json!({ "device": "Krypt: Pad", "bytes": [0x90, 200, 1] }),
            json!({ "device": "Krypt: Pad", "bytes": [] }),
            json!({ "device": "Krypt: Pad" }),
        ] {
            assert!(virtual_midi(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn looped_take_passes() {
        let ps = take_passes(5760.0, &[3.0, 7.0], 3840.0, 11520.0, 8.5, 120.0);
        assert_eq!(ps.len(), 3);
        assert_eq!(ps[0], Pass { start_tick: 5760.0, end_tick: 11520.0, sec: 0.0 });
        assert_eq!(ps[1], Pass { start_tick: 3840.0, end_tick: 11520.0, sec: 3.0 });
        assert!((ps[2].end_tick - (3840.0 + 1.5 * 1920.0)).abs() < 1e-6 && ps[2].sec == 7.0);
        let ps = take_passes(3840.0, &[4.0], 3840.0, 11520.0, 9.0, 120.0);
        assert_eq!(ps[1].end_tick, 11520.0);
        let ps = take_passes(3840.0, &[4.0], 3840.0, 11520.0, 3.99, 120.0);
        assert_eq!(ps[1].end_tick, 3840.0);
    }
}
