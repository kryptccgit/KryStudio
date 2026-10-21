//! MIDI input (research/07 §2, research/06 §6.3): the engine owns every
//! MIDI device. midir (WinMM backend) callbacks parse each message, stamp it
//! with the engine clock (`now_ns`) and hand it to:
//!   - the audio thread (notes, sustain, all-notes-off) through a lock-free
//!     rtrb ring; the core schedules them sample-accurately into the next
//!     block (see record_hooks.rs),
//!   - the control thread (CCs) for MIDI-learn / controller links, throttled
//!     to ≤100 Hz per (device, channel, cc).
//! A manager thread rescans ports every 2 s (hot-plug) and applies main's
//! enable policy. WinMM ports are single-client on Windows 10: a port another
//! app holds reports an error instead of failing the scan.

use crossbeam_channel::{Receiver, Sender};
use serde::Serialize;
use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::Ordering::*;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::record::LiveShared;

// ── Engine clock ─────────────────────────────────────────────────────────

static EPOCH: OnceLock<Instant> = OnceLock::new();

/// Start the engine clock (call once at startup, before any RT thread runs).
pub fn init_clock() {
    let _ = EPOCH.get_or_init(Instant::now);
}

/// [RT-safe] Engine monotonic clock in nanoseconds. Shared by the MIDI
/// callbacks, the audio callback and the audio-input callback.
#[inline]
pub fn now_ns() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

// ── Parsing ──────────────────────────────────────────────────────────────

/// A channel-voice message the engine cares about. Channels are 0-based.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MidiMsg {
    /// velocity 1..127 (a note-on with velocity 0 parses as `NoteOff`).
    NoteOn { ch: u8, key: u8, vel: u8 },
    NoteOff { ch: u8, key: u8 },
    Cc { ch: u8, cc: u8, value: u8 },
    /// -8192..8191 (0 = centre).
    PitchBend { ch: u8, value: i16 },
}

fn data_len(status: u8) -> usize {
    match status & 0xF0 {
        0xC0 | 0xD0 => 1,
        0x80 | 0x90 | 0xA0 | 0xB0 | 0xE0 => 2,
        _ => 0,
    }
}

fn decode(status: u8, d: &[u8]) -> Option<MidiMsg> {
    let ch = status & 0x0F;
    match status & 0xF0 {
        0x80 => Some(MidiMsg::NoteOff { ch, key: d[0] }),
        0x90 if d[1] == 0 => Some(MidiMsg::NoteOff { ch, key: d[0] }),
        0x90 => Some(MidiMsg::NoteOn { ch, key: d[0], vel: d[1] }),
        0xB0 => Some(MidiMsg::Cc { ch, cc: d[0], value: d[1] }),
        0xE0 => Some(MidiMsg::PitchBend { ch, value: (((d[1] as i16) << 7) | d[0] as i16) - 8192 }),
        _ => None, // aftertouch, program change, channel pressure: ignored
    }
}

/// Parse one complete message (what midir delivers per callback).
pub fn parse(bytes: &[u8]) -> Option<MidiMsg> {
    let mut rs = 0u8;
    let mut out = None;
    parse_stream(bytes, &mut rs, |m| {
        if out.is_none() {
            out = Some(m)
        }
    });
    out
}

/// Parse a byte stream with running status (several messages, realtime
/// bytes anywhere — even inside a message — and sysex skipped). `running`
/// carries the status byte across calls.
pub fn parse_stream(bytes: &[u8], running: &mut u8, mut emit: impl FnMut(MidiMsg)) {
    let mut data = [0u8; 2];
    let mut count = 0usize;
    let mut in_sysex = false;
    for &b in bytes {
        if b >= 0xF8 {
            continue; // realtime: never interrupts a message or running status
        }
        if b == 0xF0 {
            in_sysex = true;
            *running = 0;
            continue;
        }
        if b == 0xF7 {
            in_sysex = false;
            continue;
        }
        if b & 0x80 != 0 {
            in_sysex = false;
            count = 0;
            // System common (F1..F6) cancels running status; its data bytes are dropped.
            *running = if b >= 0xF0 { 0 } else { b };
            continue;
        }
        if in_sysex || *running == 0 {
            continue; // sysex payload or a stray data byte
        }
        let need = data_len(*running);
        if need == 0 {
            continue;
        }
        data[count] = b;
        count += 1;
        if count == need {
            count = 0;
            if let Some(m) = decode(*running, &data[..need]) {
                emit(m);
            }
        }
    }
}

/// A timestamped message for the audio thread (Copy: travels through rtrb).
#[derive(Clone, Copy, Debug)]
pub struct LiveEv {
    pub t_ns: u64,
    pub msg: MidiMsg,
}

/// A controller message for the control thread (MIDI-learn / links).
#[derive(Clone, Debug)]
pub struct CcEv {
    pub device: Arc<str>,
    pub ch: u8,
    pub cc: u8,
    pub value: u8,
}

// ── Clip launcher grid controllers (launcher.rs, `setLaunchGrid`) ────────

/// Which notes a grid controller sends to the launcher instead of the MIDI target.
pub struct GridFilter {
    /// MIDI input id; None = any enabled input.
    pub device: Option<String>,
    /// 0-based channel; None = any.
    pub channel: Option<u8>,
    pub keys: [bool; 128],
    pub tx: Sender<GridHit>,
    /// hardware: Control Changes with a mapped number count too (value > 0 =
    /// press). Launchpads send CCs from their top row and scene column.
    pub cc: bool,
}

/// A swallowed grid note (to the control thread).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GridHit {
    pub key: u8,
    pub on: bool,
}

// ── Sink: where every input (device or debugMidiIn) delivers ─────────────

pub struct MidiSink {
    rt: Mutex<rtrb::Producer<LiveEv>>,
    ctl: Sender<CcEv>,
    live: Arc<LiveShared>,
    grid: Mutex<Option<GridFilter>>,
    /// hardware: realtime bytes + SPP from the sync input go to the audio thread (clock.rs).
    sync: Mutex<SyncTap>,
}

/// hardware: where the sync input's clock messages go.
#[derive(Default)]
struct SyncTap {
    device: Option<String>,
    tx: Option<rtrb::Producer<crate::clock::SyncEv>>,
}

impl MidiSink {
    pub fn new(rt: rtrb::Producer<LiveEv>, ctl: Sender<CcEv>, live: Arc<LiveShared>) -> Self {
        Self { rt: Mutex::new(rt), ctl, live, grid: Mutex::new(None), sync: Mutex::new(SyncTap::default()) }
    }

    /// hardware: the ring the sync input's clock messages go into (clock.rs).
    pub fn set_sync_ring(&self, tx: rtrb::Producer<crate::clock::SyncEv>) {
        self.sync.lock().unwrap_or_else(|e| e.into_inner()).tx = Some(tx);
    }

    /// hardware: follow this MIDI input's clock (None = internal clock).
    pub fn set_sync_device(&self, device: Option<String>) {
        self.sync.lock().unwrap_or_else(|e| e.into_inner()).device = device;
    }

    /// hardware: clock / Start / Continue / Stop / SPP from the sync input.
    fn sync_take(&self, t_ns: u64, device: &str, bytes: &[u8]) {
        if !bytes.iter().any(|b| *b >= 0xF8 || *b == 0xF2) {
            return;
        }
        let mut tap = self.sync.lock().unwrap_or_else(|e| e.into_inner());
        if tap.device.as_deref() != Some(device) {
            return;
        }
        if let Some(tx) = tap.tx.as_mut() {
            crate::clock::scan_sync_bytes(t_ns, bytes, |e| {
                if tx.push(e).is_err() {
                    self.live.rt_dropped.fetch_add(1, Relaxed);
                }
            });
        }
    }

    /// Clip launcher: notes matching `g` launch instead of playing (None = off).
    pub fn set_grid(&self, g: Option<GridFilter>) {
        *self.grid.lock().unwrap_or_else(|e| e.into_inner()) = g;
    }

    /// A grid-controller note: hand it to the launcher and swallow it.
    fn grid_take(&self, device: &str, msg: MidiMsg) -> bool {
        let g = self.grid.lock().unwrap_or_else(|e| e.into_inner());
        let Some(g) = g.as_ref() else { return false };
        let (ch, key, on) = match msg {
            MidiMsg::NoteOn { ch, key, .. } => (ch, key, true),
            MidiMsg::NoteOff { ch, key } => (ch, key, false),
            MidiMsg::Cc { ch, cc, value } if g.cc => (ch, cc, value > 0), // hardware: Launchpad side buttons
            _ => return false,
        };
        if g.device.as_deref().is_some_and(|d| d != device) || g.channel.is_some_and(|c| c != ch) || !g.keys[key as usize & 127] {
            return false;
        }
        let _ = g.tx.send(GridHit { key, on });
        true
    }

    /// Called on the MIDI driver thread (not the audio thread): may lock.
    pub fn feed(&self, device: &Arc<str>, bytes: &[u8], running: &mut u8) {
        self.feed_at(now_ns(), device, bytes, running);
    }

    /// `feed` with an explicit arrival time (tests drive the clock).
    pub fn feed_at(&self, t_ns: u64, device: &Arc<str>, bytes: &[u8], running: &mut u8) {
        self.sync_take(t_ns, device, bytes); // hardware: MIDI clock sync
        parse_stream(bytes, running, |msg| {
            self.live.midi_in.fetch_add(1, Relaxed);
            if self.grid_take(device, msg) {
                return; // clip launcher grid: never reaches the MIDI target or a recording
            }
            let to_rt = match msg {
                MidiMsg::NoteOn { .. } | MidiMsg::NoteOff { .. } | MidiMsg::PitchBend { .. } => true,
                // Sustain pedal and all-notes-off / all-sound-off act on live notes.
                MidiMsg::Cc { cc, .. } => matches!(cc, 64 | 120 | 123),
            };
            if to_rt {
                let mut p = self.rt.lock().unwrap_or_else(|e| e.into_inner());
                if p.push(LiveEv { t_ns, msg }).is_err() {
                    self.live.rt_dropped.fetch_add(1, Relaxed);
                }
            }
            if let MidiMsg::Cc { ch, cc, value } = msg {
                let _ = self.ctl.send(CcEv { device: device.clone(), ch, cc, value });
            }
        });
    }
}

// ── CC throttle (≤100 Hz per controller, last value always delivered) ────

pub const CC_MIN_INTERVAL_NS: u64 = 10_000_000;

type CcKey = (Arc<str>, u8, u8);

#[derive(Default)]
pub struct CcThrottle {
    slots: HashMap<CcKey, (u64, Option<u8>)>,
}

impl CcThrottle {
    /// Offer a value at `now`: returns it if it may be sent right away,
    /// otherwise keeps it pending (the newest value wins).
    pub fn offer(&mut self, ev: &CcEv, now: u64) -> Option<u8> {
        let key = (ev.device.clone(), ev.ch, ev.cc);
        let slot = self.slots.entry(key).or_insert((0, None));
        if slot.0 == 0 || now.saturating_sub(slot.0) >= CC_MIN_INTERVAL_NS {
            *slot = (now, None);
            Some(ev.value)
        } else {
            slot.1 = Some(ev.value);
            None
        }
    }

    /// Pending values whose interval has elapsed.
    pub fn flush(&mut self, now: u64) -> Vec<CcEv> {
        let mut out = Vec::new();
        for ((device, ch, cc), slot) in self.slots.iter_mut() {
            if let Some(v) = slot.1 {
                if now.saturating_sub(slot.0) >= CC_MIN_INTERVAL_NS {
                    *slot = (now, None);
                    out.push(CcEv { device: device.clone(), ch: *ch, cc: *cc, value: v });
                }
            }
        }
        if self.slots.len() > 4096 {
            self.slots.retain(|_, s| s.1.is_some());
        }
        out
    }
}

// ── Device manager (midir) ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MidiInputInfo {
    /// Stable key (the port name; duplicates get " #2", " #3").
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct MidiPolicy {
    /// Devices missing from `enabled` are enabled when true (FL "auto accept").
    pub auto_enable: bool,
    pub enabled: HashMap<String, bool>,
}

impl MidiPolicy {
    pub fn wants(&self, id: &str) -> bool {
        self.enabled.get(id).copied().unwrap_or(self.auto_enable)
    }
}

enum MidiCmd {
    Policy(MidiPolicy, Sender<Vec<MidiInputInfo>>),
    Rescan(Sender<Vec<MidiInputInfo>>),
    Shutdown,
}

pub struct MidiManager {
    tx: Sender<MidiCmd>,
    list: Arc<Mutex<Vec<MidiInputInfo>>>,
}

/// Unique ids for a list of port names: "Keys", "Keys #2", ...
pub fn dedupe_names(names: &[String]) -> Vec<String> {
    let mut seen: HashMap<&str, u32> = HashMap::new();
    names
        .iter()
        .map(|n| {
            let c = seen.entry(n.as_str()).or_insert(0);
            *c += 1;
            if *c == 1 {
                n.clone()
            } else {
                format!("{n} #{c}")
            }
        })
        .collect()
}

struct Conn {
    _conn: midir::MidiInputConnection<()>,
}

struct MgrState {
    sink: Arc<MidiSink>,
    policy: MidiPolicy,
    conns: HashMap<String, Conn>,
    errors: HashMap<String, String>,
    list: Arc<Mutex<Vec<MidiInputInfo>>>,
    changed: Sender<Vec<MidiInputInfo>>,
}

impl MidiManager {
    /// Start the manager thread. `changed` receives the device list whenever
    /// it changes (hot-plug, enable/disable, open errors).
    pub fn start(sink: Arc<MidiSink>, changed: Sender<Vec<MidiInputInfo>>) -> MidiManager {
        let (tx, rx) = crossbeam_channel::unbounded();
        let list = Arc::new(Mutex::new(Vec::new()));
        let l2 = list.clone();
        let _ = std::thread::Builder::new().name("midi".into()).spawn(move || {
            let mut st = MgrState { sink, policy: MidiPolicy { auto_enable: true, enabled: HashMap::new() }, conns: HashMap::new(), errors: HashMap::new(), list: l2, changed };
            st.run(rx);
        });
        MidiManager { tx, list }
    }

    pub fn inputs(&self) -> Vec<MidiInputInfo> {
        self.list.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set_policy(&self, p: MidiPolicy) -> Result<Vec<MidiInputInfo>, String> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.tx.send(MidiCmd::Policy(p, tx)).map_err(|_| "MIDI thread is gone".to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Timed out opening MIDI inputs".to_string())
    }

    pub fn rescan(&self) -> Result<Vec<MidiInputInfo>, String> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.tx.send(MidiCmd::Rescan(tx)).map_err(|_| "MIDI thread is gone".to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Timed out scanning MIDI inputs".to_string())
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(MidiCmd::Shutdown);
    }
}

impl MgrState {
    fn run(&mut self, rx: Receiver<MidiCmd>) {
        self.scan();
        loop {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(MidiCmd::Policy(p, reply)) => {
                    self.policy = p;
                    self.errors.clear(); // retry devices that failed before
                    let _ = reply.send(self.scan());
                }
                Ok(MidiCmd::Rescan(reply)) => {
                    self.errors.clear();
                    let _ = reply.send(self.scan());
                }
                Ok(MidiCmd::Shutdown) | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    self.conns.clear();
                    return;
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    self.scan();
                }
            }
        }
    }

    /// Enumerate ports, open/close per policy, publish the list. midir is
    /// wrapped in catch_unwind: a misbehaving driver must not kill the thread.
    fn scan(&mut self) -> Vec<MidiInputInfo> {
        let ports = std::panic::catch_unwind(AssertUnwindSafe(list_ports)).unwrap_or_else(|_| Err("MIDI driver error while listing inputs".into()));
        let ports = match ports {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[midi] {e}");
                Vec::new()
            }
        };
        let ids = dedupe_names(&ports.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>());
        // Close connections whose port vanished or that the policy disabled.
        let keep: Vec<String> = ids.iter().filter(|id| self.policy.wants(id)).cloned().collect();
        self.conns.retain(|id, _| keep.contains(id));
        let mut list = Vec::with_capacity(ids.len());
        for (i, id) in ids.iter().enumerate() {
            let want = self.policy.wants(id);
            if want && !self.conns.contains_key(id) && !self.errors.contains_key(id) {
                let port_index = ports[i].1;
                let sink = self.sink.clone();
                let dev: Arc<str> = Arc::from(id.as_str());
                let res = std::panic::catch_unwind(AssertUnwindSafe(|| open_port(port_index, dev, sink))).unwrap_or_else(|_| Err("MIDI driver error".into()));
                match res {
                    Ok(c) => {
                        self.conns.insert(id.clone(), c);
                    }
                    Err(e) => {
                        self.errors.insert(id.clone(), e);
                    }
                }
            }
            let open = self.conns.contains_key(id);
            list.push(MidiInputInfo {
                id: id.clone(),
                name: ports[i].0.clone(),
                enabled: want,
                open,
                error: if want && !open { self.errors.get(id).cloned() } else { None },
            });
        }
        // Forget errors of unplugged devices so a re-plug retries.
        self.errors.retain(|id, _| ids.contains(id));
        let changed = {
            let mut cur = self.list.lock().unwrap_or_else(|e| e.into_inner());
            if *cur != list {
                *cur = list.clone();
                true
            } else {
                false
            }
        };
        if changed {
            let _ = self.changed.send(list.clone());
        }
        list
    }
}

/// (name, port index) of every MIDI input port.
fn list_ports() -> Result<Vec<(String, usize)>, String> {
    let mi = midir::MidiInput::new("Krypt Studio").map_err(|e| format!("MIDI unavailable: {e}"))?;
    let mut out = Vec::new();
    for (i, p) in mi.ports().iter().enumerate() {
        let name = mi.port_name(p).unwrap_or_else(|_| format!("MIDI input {}", i + 1));
        out.push((name, i));
    }
    Ok(out)
}

fn open_port(index: usize, dev: Arc<str>, sink: Arc<MidiSink>) -> Result<Conn, String> {
    let mut mi = midir::MidiInput::new("Krypt Studio").map_err(|e| format!("MIDI unavailable: {e}"))?;
    mi.ignore(midir::Ignore::SysexAndActiveSense); // hardware: clock bytes reach the sync input
    let ports = mi.ports();
    let port = ports.get(index).ok_or_else(|| "Device disappeared".to_string())?.clone();
    let conn = mi
        .connect(
            &port,
            "krypt-studio-in",
            move |_ts, bytes, _| {
                let mut running = 0u8; // midir delivers whole messages; never carry status across
                sink.feed(&dev, bytes, &mut running);
            },
            (),
        )
        .map_err(|e| {
            let k = e.kind();
            format!("Couldn't open it ({k}). Another app may be using it: close it, or use Windows 11 multi-client MIDI.")
        })?;
    Ok(Conn { _conn: conn })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_channel_voice_messages() {
        assert_eq!(parse(&[0x90, 60, 100]), Some(MidiMsg::NoteOn { ch: 0, key: 60, vel: 100 }));
        assert_eq!(parse(&[0x93, 61, 0]), Some(MidiMsg::NoteOff { ch: 3, key: 61 }), "note-on vel 0 = note-off");
        assert_eq!(parse(&[0x8F, 62, 64]), Some(MidiMsg::NoteOff { ch: 15, key: 62 }));
        assert_eq!(parse(&[0xB0, 74, 127]), Some(MidiMsg::Cc { ch: 0, cc: 74, value: 127 }));
        assert_eq!(parse(&[0xE0, 0x00, 0x40]), Some(MidiMsg::PitchBend { ch: 0, value: 0 }));
        assert_eq!(parse(&[0xE0, 0x7F, 0x7F]), Some(MidiMsg::PitchBend { ch: 0, value: 8191 }));
        assert_eq!(parse(&[0xE0, 0x00, 0x00]), Some(MidiMsg::PitchBend { ch: 0, value: -8192 }));
        // Ignored / malformed.
        assert_eq!(parse(&[0xC0, 5]), None, "program change is ignored");
        assert_eq!(parse(&[0xF8]), None, "clock");
        assert_eq!(parse(&[0xF0, 1, 2, 3, 0xF7]), None, "sysex");
        assert_eq!(parse(&[0x90, 60]), None, "truncated");
        assert_eq!(parse(&[60, 100]), None, "no status");
        assert_eq!(parse(&[]), None);
    }

    #[test]
    fn stream_parsing_handles_running_status_realtime_and_sysex() {
        let mut out = Vec::new();
        let mut rs = 0u8;
        // Note on, running-status note on (vel 0 → off), clock in the middle, sysex, CC.
        let bytes = [0x91, 60, 90, 60, 0xF8, 0, 0xF0, 0x7E, 0x01, 0xF7, 0xB1, 1, 64, 2, 70];
        parse_stream(&bytes, &mut rs, |m| out.push(m));
        assert_eq!(
            out,
            vec![
                MidiMsg::NoteOn { ch: 1, key: 60, vel: 90 },
                MidiMsg::NoteOff { ch: 1, key: 60 },
                MidiMsg::Cc { ch: 1, cc: 1, value: 64 },
                MidiMsg::Cc { ch: 1, cc: 2, value: 70 },
            ]
        );
        // Running status survives across calls; an interrupted message resyncs.
        out.clear();
        parse_stream(&[3, 10], &mut rs, |m| out.push(m));
        assert_eq!(out, vec![MidiMsg::Cc { ch: 1, cc: 3, value: 10 }]);
        out.clear();
        parse_stream(&[0x90, 64, 0x80, 64, 0], &mut rs, |m| out.push(m));
        assert_eq!(out, vec![MidiMsg::NoteOff { ch: 0, key: 64 }]);
    }

    #[test]
    fn cc_throttle_limits_rate_and_keeps_the_last_value() {
        let mut t = CcThrottle::default();
        let dev: Arc<str> = Arc::from("Keys");
        let ev = |v: u8| CcEv { device: dev.clone(), ch: 0, cc: 74, value: v };
        let ms = 1_000_000u64;
        assert_eq!(t.offer(&ev(1), 100 * ms), Some(1));
        assert_eq!(t.offer(&ev(2), 101 * ms), None);
        assert_eq!(t.offer(&ev(3), 105 * ms), None);
        assert!(t.flush(108 * ms).is_empty(), "interval not elapsed yet");
        let f = t.flush(111 * ms);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].value, 3, "newest pending value wins");
        assert!(t.flush(200 * ms).is_empty(), "nothing pending");
        assert_eq!(t.offer(&ev(4), 200 * ms), Some(4));
        // Another controller has its own budget.
        let other = CcEv { device: dev.clone(), ch: 0, cc: 1, value: 9 };
        assert_eq!(t.offer(&other, 201 * ms), Some(9));
        // 100 offers within 50 ms → at most 6 sends (one per 10 ms, incl. flushes).
        let mut t = CcThrottle::default();
        let mut sent = 0;
        for i in 0..100u64 {
            let now = 1000 * ms + i * ms / 2;
            if t.offer(&ev((i % 128) as u8), now).is_some() {
                sent += 1;
            }
            sent += t.flush(now).len();
        }
        assert!(sent <= 6, "sent {sent}");
    }

    #[test]
    fn duplicate_port_names_get_unique_ids() {
        let n = |s: &str| s.to_string();
        assert_eq!(dedupe_names(&[n("Keys"), n("Pads"), n("Keys"), n("Keys")]), vec![n("Keys"), n("Pads"), n("Keys #2"), n("Keys #3")]);
    }

    #[test]
    fn policy_defaults_to_auto_enable() {
        let mut p = MidiPolicy { auto_enable: true, enabled: HashMap::new() };
        assert!(p.wants("New device"));
        p.enabled.insert("Old".into(), false);
        assert!(!p.wants("Old"));
        p.auto_enable = false;
        assert!(!p.wants("New device"));
    }
}
