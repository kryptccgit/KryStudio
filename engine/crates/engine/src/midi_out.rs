use crate::clock::{ClockEv, ClockShared};
use crate::midi::{dedupe_names, now_ns};
use crossbeam_channel::{Receiver, Sender};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::Ordering::*;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub trait OutPort: Send {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String>;
}

struct MidirPort(midir::MidiOutputConnection);

impl OutPort for MidirPort {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.0.send(bytes).map_err(|e| e.to_string())
    }
}

pub type Ports = Arc<Mutex<Vec<(String, Box<dyn OutPort>)>>>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MidiOutputInfo {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn valid_message(m: &[u8]) -> Result<(), String> {
    let Some(&st) = m.first() else { return Err("an empty MIDI message".into()) };
    if st < 0x80 {
        return Err(format!("MIDI message starts with a data byte ({st})"));
    }
    if st == 0xF0 {
        if m.len() < 3 || m[m.len() - 1] != 0xF7 || m[1..m.len() - 1].iter().any(|b| *b >= 0x80) {
            return Err("SysEx must be F0, data bytes 0..127, F7".into());
        }
        if m.len() > 1024 {
            return Err("SysEx longer than 1024 bytes".into());
        }
        return Ok(());
    }
    let need = match st & 0xF0 {
        0x80 | 0x90 | 0xA0 | 0xB0 | 0xE0 => 3,
        0xC0 | 0xD0 => 2,
        _ => match st {
            0xF2 => 3,
            0xF1 | 0xF3 => 2,
            _ => 1,
        },
    };
    if m.len() != need || m[1..].iter().any(|b| *b >= 0x80) {
        return Err(format!("malformed MIDI message {m:02X?}"));
    }
    Ok(())
}

pub enum SendCmd {
    Bytes { port: String, msgs: Vec<Vec<u8>> },
    Clock { ports: Vec<String>, offset_ns: i64 },
    Shutdown,
}

pub struct Waiter {
    overshoot: f64,
}

impl Default for Waiter {
    fn default() -> Self {
        Waiter { overshoot: 1_000_000.0 }
    }
}

impl Waiter {
    pub fn margin_ns(&self) -> u64 {
        (self.overshoot + 150_000.0).clamp(200_000.0, 3_000_000.0) as u64
    }

    pub fn sleep_toward(&mut self, deadline: u64, max: Duration) -> bool {
        let now = now_ns();
        let m = self.margin_ns();
        if deadline <= now + m {
            return true;
        }
        let want = Duration::from_nanos((deadline - now - m).min(max.as_nanos() as u64));
        let t0 = now_ns();
        std::thread::sleep(want);
        let over = now_ns().saturating_sub(t0).saturating_sub(want.as_nanos() as u64) as f64;
        self.overshoot = if over > self.overshoot { over } else { self.overshoot * 0.995 + over * 0.005 };
        false
    }

    pub fn spin_until(deadline: u64) {
        while now_ns() < deadline {
            std::hint::spin_loop();
        }
    }
}

struct Sender_ {
    ports: Ports,
    clock_rx: Option<rtrb::Consumer<ClockEv>>,
    clock_ports: Vec<String>,
    offset_ns: i64,
    shared: Arc<ClockShared>,
    waiter: Waiter,
    errors: HashMap<String, u32>,
    jitter_max_ns: u64,
    jitter_window_start: u64,
    trace: Option<Arc<Mutex<Vec<(u64, u64)>>>>,
}

const LATE_NS: u64 = 1_000_000;

impl Sender_ {
    fn due(&self, ev: &ClockEv) -> u64 {
        (ev.t_ns as i64 + self.offset_ns).max(0) as u64
    }

    fn write(&mut self, port: &str, msg: &[u8]) {
        let r = {
            let mut ps = self.ports.lock().unwrap_or_else(|e| e.into_inner());
            match ps.iter_mut().find(|(id, _)| id == port) {
                Some((_, p)) => std::panic::catch_unwind(AssertUnwindSafe(|| p.send(msg))).unwrap_or_else(|_| Err("driver panic".into())),
                None => Err("not open".into()),
            }
        };
        if let Err(e) = r {
            let n = self.errors.entry(port.to_string()).or_insert(0);
            *n += 1;
            if *n == 1 || *n % 1000 == 0 {
                eprintln!("[midi-out] {port}: {e}");
            }
        }
    }

    fn service_clock(&mut self) {
        loop {
            let Some(rx) = self.clock_rx.as_mut() else { return };
            let Ok(ev) = rx.peek().copied() else { return };
            let due = self.due(&ev);
            let now = now_ns();
            if due > now + self.waiter.margin_ns() {
                return;
            }
            Waiter::spin_until(due);
            if let Some(rx) = self.clock_rx.as_mut() {
                let _ = rx.pop();
            }
            if self.clock_ports.is_empty() {
                continue;
            }
            let sent = now_ns();
            for i in 0..self.clock_ports.len() {
                let p = std::mem::take(&mut self.clock_ports[i]);
                self.write(&p, ev.msg());
                self.clock_ports[i] = p;
            }
            let err = sent.abs_diff(due);
            if sent > due + LATE_NS {
                self.shared.out_late.fetch_add(1, Relaxed);
            }
            self.shared.out_sent.fetch_add(1, Relaxed);
            if sent.saturating_sub(self.jitter_window_start) > 2_000_000_000 {
                self.jitter_window_start = sent;
                self.shared.out_jitter_us.store((self.jitter_max_ns / 1000) as u32, Relaxed);
                self.jitter_max_ns = 0;
            }
            self.jitter_max_ns = self.jitter_max_ns.max(err);
            if let Some(tr) = &self.trace {
                tr.lock().unwrap_or_else(|e| e.into_inner()).push((due, sent));
            }
        }
    }

    fn next_due(&mut self) -> Option<u64> {
        let rx = self.clock_rx.as_mut()?;
        rx.peek().ok().copied().map(|e| self.due(&e))
    }

    fn handle(&mut self, c: SendCmd) -> bool {
        match c {
            SendCmd::Bytes { port, msgs } => {
                for m in msgs {
                    self.service_clock();
                    self.write(&port, &m);
                }
            }
            SendCmd::Clock { ports, offset_ns } => {
                self.clock_ports = ports;
                self.offset_ns = offset_ns;
                if self.clock_ports.is_empty() {
                    if let Some(rx) = self.clock_rx.as_mut() {
                        while rx.pop().is_ok() {}
                    }
                }
            }
            SendCmd::Shutdown => return false,
        }
        true
    }

    fn run(&mut self, rx: Receiver<SendCmd>) {
        if !crate::rt::mmcss_pro_audio() {
            eprintln!("[midi-out] MMCSS registration refused; clock runs at normal priority");
        }
        loop {
            while let Ok(c) = rx.try_recv() {
                if !self.handle(c) {
                    return;
                }
            }
            self.service_clock();
            if self.clock_ports.is_empty() && self.clock_rx.as_mut().is_none_or(|r| r.is_empty()) {
                match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(c) => {
                        if !self.handle(c) {
                            return;
                        }
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return,
                }
                continue;
            }
            let deadline = self.next_due().unwrap_or(now_ns() + 1_000_000);
            if self.waiter.sleep_toward(deadline, Duration::from_millis(1)) {
                self.service_clock();
            }
        }
    }
}

enum MgrCmd {
    Enable(Vec<String>, Sender<Vec<MidiOutputInfo>>),
    Rescan(Sender<Vec<MidiOutputInfo>>),
    AtClose(String, Vec<Vec<u8>>),
    Shutdown,
}

pub type Opener = Box<dyn Fn(usize, &str) -> Result<Box<dyn OutPort>, String> + Send>;
pub type Lister = Box<dyn Fn() -> Result<Vec<(String, usize)>, String> + Send>;

pub struct MidiOutManager {
    tx: Sender<MgrCmd>,
    send_tx: Sender<SendCmd>,
    list: Arc<Mutex<Vec<MidiOutputInfo>>>,
    ports: Ports,
}

struct MgrState {
    lister: Lister,
    opener: Opener,
    enabled: HashSet<String>,
    ports: Ports,
    errors: HashMap<String, String>,
    at_close: HashMap<String, Vec<Vec<u8>>>,
    list: Arc<Mutex<Vec<MidiOutputInfo>>>,
    changed: Sender<Vec<MidiOutputInfo>>,
}

impl MidiOutManager {
    pub fn start(shared: Arc<ClockShared>, changed: Sender<Vec<MidiOutputInfo>>) -> MidiOutManager {
        Self::start_with(shared, changed, Box::new(list_ports), Box::new(open_port), None)
    }

    pub fn start_with(shared: Arc<ClockShared>, changed: Sender<Vec<MidiOutputInfo>>, lister: Lister, opener: Opener, trace: Option<Arc<Mutex<Vec<(u64, u64)>>>>) -> MidiOutManager {
        let ports: Ports = Arc::new(Mutex::new(Vec::new()));
        let list = Arc::new(Mutex::new(Vec::new()));
        let (send_tx, send_rx) = crossbeam_channel::unbounded();
        {
            let mut s = Sender_ {
                ports: ports.clone(),
                clock_rx: shared.take_out_rx(),
                clock_ports: Vec::new(),
                offset_ns: 0,
                shared: shared.clone(),
                waiter: Waiter::default(),
                errors: HashMap::new(),
                jitter_max_ns: 0,
                jitter_window_start: 0,
                trace,
            };
            let _ = std::thread::Builder::new().name("midi-clock".into()).spawn(move || s.run(send_rx));
        }
        let (tx, rx) = crossbeam_channel::unbounded();
        {
            let mut st = MgrState { lister, opener, enabled: HashSet::new(), ports: ports.clone(), errors: HashMap::new(), at_close: HashMap::new(), list: list.clone(), changed };
            let _ = std::thread::Builder::new().name("midi-out".into()).spawn(move || st.run(rx));
        }
        MidiOutManager { tx, send_tx, list, ports }
    }

    pub fn outputs(&self) -> Vec<MidiOutputInfo> {
        self.list.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn is_open(&self, id: &str) -> bool {
        self.ports.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|(p, _)| p == id)
    }

    pub fn set_enabled(&self, ids: Vec<String>) -> Result<Vec<MidiOutputInfo>, String> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.tx.send(MgrCmd::Enable(ids, tx)).map_err(|_| "MIDI output thread is gone".to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Timed out opening MIDI outputs".to_string())
    }

    pub fn rescan(&self) -> Result<Vec<MidiOutputInfo>, String> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.tx.send(MgrCmd::Rescan(tx)).map_err(|_| "MIDI output thread is gone".to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Timed out scanning MIDI outputs".to_string())
    }

    pub fn send(&self, port: String, msgs: Vec<Vec<u8>>) {
        let _ = self.send_tx.send(SendCmd::Bytes { port, msgs });
    }

    pub fn set_clock(&self, ports: Vec<String>, offset_ns: i64) {
        let _ = self.send_tx.send(SendCmd::Clock { ports, offset_ns });
    }

    pub fn at_close(&self, port: String, msgs: Vec<Vec<u8>>) {
        let _ = self.tx.send(MgrCmd::AtClose(port, msgs));
    }

    pub fn shutdown(&self) {
        let _ = self.send_tx.send(SendCmd::Shutdown);
        let (tx, rx) = crossbeam_channel::bounded::<Vec<MidiOutputInfo>>(1);
        if self.tx.send(MgrCmd::Enable(Vec::new(), tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_millis(1500));
        }
        let _ = self.tx.send(MgrCmd::Shutdown);
    }
}

impl MgrState {
    fn run(&mut self, rx: Receiver<MgrCmd>) {
        self.scan();
        loop {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(MgrCmd::Enable(ids, reply)) => {
                    self.enabled = ids.into_iter().collect();
                    self.errors.clear();
                    let _ = reply.send(self.scan());
                }
                Ok(MgrCmd::Rescan(reply)) => {
                    self.errors.clear();
                    let _ = reply.send(self.scan());
                }
                Ok(MgrCmd::AtClose(port, msgs)) => {
                    if msgs.is_empty() {
                        self.at_close.remove(&port);
                    } else {
                        self.at_close.insert(port, msgs);
                    }
                }
                Ok(MgrCmd::Shutdown) | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    self.enabled.clear();
                    self.close_unwanted(&[]);
                    return;
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    self.scan();
                }
            }
        }
    }

    fn close_unwanted(&mut self, present: &[String]) {
        let mut ps = self.ports.lock().unwrap_or_else(|e| e.into_inner());
        let mut i = 0;
        while i < ps.len() {
            let id = ps[i].0.clone();
            if self.enabled.contains(&id) && present.contains(&id) {
                i += 1;
                continue;
            }
            let (_, mut p) = ps.remove(i);
            if let Some(msgs) = self.at_close.remove(&id) {
                for m in msgs {
                    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| p.send(&m)));
                }
            }
            drop(p);
        }
    }

    fn scan(&mut self) -> Vec<MidiOutputInfo> {
        let ports = std::panic::catch_unwind(AssertUnwindSafe(|| (self.lister)())).unwrap_or_else(|_| Err("MIDI driver error while listing outputs".into()));
        let ports = match ports {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[midi-out] {e}");
                Vec::new()
            }
        };
        let ids = dedupe_names(&ports.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>());
        self.close_unwanted(&ids);
        let mut list = Vec::with_capacity(ids.len());
        for (i, id) in ids.iter().enumerate() {
            let want = self.enabled.contains(id);
            let open_now = self.ports.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|(p, _)| p == id);
            if want && !open_now && !self.errors.contains_key(id) {
                let idx = ports[i].1;
                let res = std::panic::catch_unwind(AssertUnwindSafe(|| (self.opener)(idx, id))).unwrap_or_else(|_| Err("MIDI driver error".into()));
                match res {
                    Ok(p) => self.ports.lock().unwrap_or_else(|e| e.into_inner()).push((id.clone(), p)),
                    Err(e) => {
                        self.errors.insert(id.clone(), e);
                    }
                }
            }
            let open = self.ports.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|(p, _)| p == id);
            list.push(MidiOutputInfo { id: id.clone(), name: ports[i].0.clone(), enabled: want, open, error: if want && !open { self.errors.get(id).cloned() } else { None } });
        }
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

fn list_ports() -> Result<Vec<(String, usize)>, String> {
    let mo = midir::MidiOutput::new("Krypt Studio").map_err(|e| format!("MIDI unavailable: {e}"))?;
    let mut out = Vec::new();
    for (i, p) in mo.ports().iter().enumerate() {
        let name = mo.port_name(p).unwrap_or_else(|_| format!("MIDI output {}", i + 1));
        out.push((name, i));
    }
    Ok(out)
}

fn open_port(index: usize, _id: &str) -> Result<Box<dyn OutPort>, String> {
    let mo = midir::MidiOutput::new("Krypt Studio").map_err(|e| format!("MIDI unavailable: {e}"))?;
    let ports = mo.ports();
    let port = ports.get(index).ok_or_else(|| "Device disappeared".to_string())?.clone();
    let conn = mo.connect(&port, "krypt-studio-out").map_err(|e| {
        let k = e.kind();
        format!("Couldn't open it ({k}). Another app may be using it: close it, or use Windows 11 multi-client MIDI.")
    })?;
    Ok(Box::new(MidirPort(conn)))
}

#[derive(Clone, Default)]
pub struct RecordingPort {
    pub log: Arc<Mutex<Vec<(u64, Vec<u8>)>>>,
}

impl OutPort for RecordingPort {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.log.lock().unwrap_or_else(|e| e.into_inner()).push((now_ns(), bytes.to_vec()));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::{MIDI_CLOCK, MIDI_START};

    fn rig(names: &[&str]) -> (MidiOutManager, HashMap<String, RecordingPort>, Arc<ClockShared>, rtrb::Producer<ClockEv>, Receiver<Vec<MidiOutputInfo>>, Arc<Mutex<Vec<(u64, u64)>>>) {
        crate::midi::init_clock();
        let shared = ClockShared::new();
        let ends = shared.take_rt().unwrap();
        let sinks: HashMap<String, RecordingPort> = names.iter().map(|n| (n.to_string(), RecordingPort::default())).collect();
        let names_v: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        let s2 = sinks.clone();
        let (ctx, crx) = crossbeam_channel::unbounded();
        let trace = Arc::new(Mutex::new(Vec::new()));
        let m = MidiOutManager::start_with(
            shared.clone(),
            ctx,
            Box::new(move || Ok(names_v.iter().cloned().enumerate().map(|(i, n)| (n, i)).collect())),
            Box::new(move |_i, id| match s2.get(id) {
                Some(p) => Ok(Box::new(p.clone()) as Box<dyn OutPort>),
                None => Err("no such sink".into()),
            }),
            Some(trace.clone()),
        );
        (m, sinks, shared, ends.out_tx, crx, trace)
    }

    #[test]
    fn validates_messages() {
        assert!(valid_message(&[0x90, 60, 127]).is_ok());
        assert!(valid_message(&[0xF8]).is_ok());
        assert!(valid_message(&[0xF0, 0, 0x20, 0x29, 2, 0x0C, 0x0E, 1, 0xF7]).is_ok());
        assert!(valid_message(&[0xF2, 1, 2]).is_ok());
        assert!(valid_message(&[]).is_err());
        assert!(valid_message(&[60, 1]).is_err());
        assert!(valid_message(&[0x90, 60]).is_err());
        assert!(valid_message(&[0x90, 60, 200]).is_err());
        assert!(valid_message(&[0xF0, 1, 2]).is_err(), "unterminated SysEx");
    }

    #[test]
    fn enable_opens_ports_and_sends_bytes() {
        let (m, sinks, _shared, _tx, crx, _) = rig(&["Pads", "Synth"]);
        let l = m.set_enabled(vec!["Pads".into()]).unwrap();
        assert_eq!(l.iter().map(|o| (o.id.as_str(), o.enabled, o.open)).collect::<Vec<_>>(), vec![("Pads", true, true), ("Synth", false, false)]);
        assert!(crx.try_iter().last().is_some(), "list change reported");
        m.send("Pads".into(), vec![vec![0x90, 11, 5], vec![0x91, 11, 21]]);
        m.at_close("Pads".into(), vec![vec![0xB0, 0, 0]]);
        let t0 = std::time::Instant::now();
        while sinks["Pads"].log.lock().unwrap().len() < 2 && t0.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(2));
        }
        let got: Vec<Vec<u8>> = sinks["Pads"].log.lock().unwrap().iter().map(|(_, b)| b.clone()).collect();
        assert_eq!(got, vec![vec![0x90, 11, 5], vec![0x91, 11, 21]]);
        let l = m.set_enabled(vec![]).unwrap();
        assert!(!l[0].open);
        assert_eq!(sinks["Pads"].log.lock().unwrap().last().unwrap().1, vec![0xB0, 0, 0]);
        m.shutdown();
    }

    #[test]
    fn clock_sender_timing() {
        let (m, sinks, shared, mut tx, _crx, trace) = rig(&["Clock"]);
        m.set_enabled(vec!["Clock".into()]).unwrap();
        m.set_clock(vec!["Clock".into()], 0);
        std::thread::sleep(Duration::from_millis(20));
        let period = 1e9 / 48.0;
        let start = now_ns() + 15_000_000;
        tx.push(ClockEv::one(start, MIDI_START)).unwrap();
        let n = 96u64;
        let mut k = 0u64;
        while k < n {
            let t = start + (k as f64 * period) as u64;
            if t > now_ns() + 15_000_000 {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            tx.push(ClockEv::one(t, MIDI_CLOCK)).unwrap();
            k += 1;
        }
        let t0 = std::time::Instant::now();
        while sinks["Clock"].log.lock().unwrap().len() < (n + 1) as usize && t0.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(5));
        }
        let log = sinks["Clock"].log.lock().unwrap().clone();
        assert_eq!(log.len(), (n + 1) as usize);
        assert_eq!(log[0].1, vec![MIDI_START]);
        assert!(log[1..].iter().all(|(_, b)| b == &vec![MIDI_CLOCK]));
        let tr = trace.lock().unwrap().clone();
        let mut errs: Vec<u64> = tr.iter().map(|(due, sent)| sent.abs_diff(*due)).collect();
        errs.sort_unstable();
        let p50 = errs[errs.len() / 2];
        let p99 = errs[errs.len() * 99 / 100];
        let max = *errs.last().unwrap();
        eprintln!("clock sender error over {} events: median {} µs, p99 {} µs, max {} µs", errs.len(), p50 / 1000, p99 / 1000, max / 1000);
        assert!(p50 < 500_000, "median send error {p50} ns");
        assert!(shared.out_sent.load(Relaxed) >= n);
        m.set_clock(vec!["Clock".into()], 5_000_000);
        std::thread::sleep(Duration::from_millis(20));
        let t = now_ns() + 10_000_000;
        tx.push(ClockEv::one(t, MIDI_CLOCK)).unwrap();
        let t0 = std::time::Instant::now();
        while sinks["Clock"].log.lock().unwrap().len() < (n + 2) as usize && t0.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(2));
        }
        let sent = sinks["Clock"].log.lock().unwrap().last().unwrap().0;
        assert!(sent >= t + 5_000_000, "offset applied");
        m.shutdown();
    }
}
