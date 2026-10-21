//! Audio input for recording and monitoring: a cpal input stream (WASAPI
//! shared) owned by its own thread. The input callback:
//!   - meters the selected channels (telemetry `inputPeak`),
//!   - feeds the monitor ring (the core mixes it into the master bus),
//!   - copies frames that fall inside the take's capture window (heard-time
//!     range published by the audio thread, see record.rs) into a chunk ring.
//! A writer thread drains the chunks into `<dir>/<name> take N.wav` (32-bit
//! float, written as `.part` and renamed when complete) and reports the take.

use crate::midi::now_ns;
use crate::protocol::DeviceInfo;
use crate::record::{CapWin, LiveShared};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{Receiver, Sender};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering::*};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const CHUNK_FLOATS: usize = 1024;
const CHUNK_RING: usize = 512;
/// Never pad more than this much leading silence (stream opened late).
const MAX_PAD_SEC: f64 = 10.0;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InputStatus {
    pub open: bool,
    pub device_id: Option<String>,
    pub name: Option<String>,
    pub sample_rate: u32,
    /// Selected device channels (0-based) recorded / monitored.
    pub channels: Vec<u16>,
    pub device_channels: u16,
    pub latency_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl InputStatus {
    fn closed(message: Option<String>) -> Self {
        Self { open: false, device_id: None, name: None, sample_rate: 0, channels: Vec::new(), device_channels: 0, latency_ms: 0.0, message }
    }
}

/// A finished (or failed) audio take.
#[derive(Debug, Clone)]
pub struct AudioDone {
    pub take: u32,
    pub path: String,
    pub frames: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub peak: f32,
    pub error: Option<String>,
}

#[derive(Clone, Copy)]
pub struct Chunk {
    pub take: u32,
    pub len: u16,
    pub end: bool,
    pub data: [f32; CHUNK_FLOATS],
}

impl Chunk {
    fn empty(take: u32) -> Self {
        Chunk { take, len: 0, end: false, data: [0.0; CHUNK_FLOATS] }
    }
}

/// Frames `[a, b)` of a buffer whose frame 0 was captured at `t0_ns` that lie
/// inside the heard-time window `[from_ns, until_ns)` (`u64::MAX` = open).
pub fn capture_range(t0_ns: u64, ns_per_frame: f64, frames: usize, from_ns: u64, until_ns: u64) -> (usize, usize) {
    let idx = |t: u64| -> usize {
        if t <= t0_ns {
            0
        } else {
            (((t - t0_ns) as f64 / ns_per_frame).ceil() as usize).min(frames)
        }
    };
    let a = idx(from_ns);
    let b = if until_ns == u64::MAX { frames } else { idx(until_ns) };
    (a, b.max(a))
}

// ── Device listing ───────────────────────────────────────────────────────

fn device_id(d: &cpal::Device) -> Option<String> {
    d.id().ok().map(|i| i.to_string())
}

pub fn list_input_devices() -> Result<Vec<DeviceInfo>, String> {
    let host = cpal::default_host();
    let default_id = host.default_input_device().and_then(|d| device_id(&d));
    let devs = host.input_devices().map_err(|e| format!("Cannot enumerate audio inputs: {e}"))?;
    let mut out = Vec::new();
    for d in devs {
        let Some(id) = device_id(&d) else { continue };
        let Ok(cfg) = d.default_input_config() else { continue };
        out.push(DeviceInfo {
            is_default: default_id.as_deref() == Some(id.as_str()),
            id,
            name: d.to_string(),
            backend: "wasapi",
            channels: cfg.channels(),
            sample_rates: vec![cfg.sample_rate()],
        });
    }
    Ok(out)
}

// ── Manager (control side) ───────────────────────────────────────────────

enum InCmd {
    List(Sender<Result<Vec<DeviceInfo>, String>>),
    Open { id: Option<String>, channels: Vec<u16>, reply: Sender<InputStatus> },
    Close(Sender<InputStatus>),
    BeginTake { take: u32, path: PathBuf },
    StreamError(String),
    Shutdown(Sender<()>),
}

pub struct InputManager {
    tx: Sender<InCmd>,
    status: Arc<Mutex<InputStatus>>,
    /// Finished takes (writer thread → control thread).
    pub done_rx: Receiver<AudioDone>,
    /// Stream errors / losses (input thread → control thread).
    pub err_rx: Receiver<String>,
}

impl InputManager {
    pub fn start(live: Arc<LiveShared>, win_rx: rtrb::Consumer<CapWin>, mon_tx: rtrb::Producer<f32>) -> InputManager {
        let (tx, rx) = crossbeam_channel::unbounded();
        let (done_tx, done_rx) = crossbeam_channel::unbounded();
        let (err_tx, err_rx) = crossbeam_channel::unbounded();
        let status = Arc::new(Mutex::new(InputStatus::closed(None)));
        let st = InState {
            live,
            win_rx: Arc::new(Mutex::new(win_rx)),
            mon_tx: Arc::new(Mutex::new(mon_tx)),
            stream: None,
            writer: None,
            done_tx,
            err_tx,
            status: status.clone(),
            self_tx: tx.clone(),
            lat_us: Arc::new(AtomicU32::new(0)),
        };
        let _ = std::thread::Builder::new().name("audio-input".into()).spawn(move || {
            let mut st = st;
            st.run(rx);
        });
        InputManager { tx, status, done_rx, err_rx }
    }

    pub fn status(&self) -> InputStatus {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn is_open(&self) -> bool {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).open
    }

    pub fn list(&self) -> Result<Vec<DeviceInfo>, String> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.tx.send(InCmd::List(tx)).map_err(|_| "Audio input thread is gone".to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Timed out listing audio inputs".to_string())?
    }

    pub fn open(&self, id: Option<String>, channels: Vec<u16>) -> InputStatus {
        let (tx, rx) = crossbeam_channel::bounded(1);
        if self.tx.send(InCmd::Open { id, channels, reply: tx }).is_err() {
            return InputStatus::closed(Some("Audio input thread is gone".into()));
        }
        rx.recv_timeout(Duration::from_secs(10)).unwrap_or_else(|_| InputStatus::closed(Some("Timed out opening the audio input".into())))
    }

    pub fn close(&self) -> InputStatus {
        let (tx, rx) = crossbeam_channel::bounded(1);
        if self.tx.send(InCmd::Close(tx)).is_err() {
            return InputStatus::closed(None);
        }
        rx.recv_timeout(Duration::from_secs(5)).unwrap_or_else(|_| InputStatus::closed(None))
    }

    pub fn begin_take(&self, take: u32, path: PathBuf) {
        let _ = self.tx.send(InCmd::BeginTake { take, path });
    }

    pub fn shutdown(&self) {
        let (tx, rx) = crossbeam_channel::bounded(1);
        if self.tx.send(InCmd::Shutdown(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_millis(1500));
        }
    }
}

enum WCmd {
    Begin { take: u32, path: PathBuf },
    Close,
}

struct WriterHandle {
    tx: Sender<WCmd>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl WriterHandle {
    fn close(mut self) {
        let _ = self.tx.send(WCmd::Close);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

struct InState {
    live: Arc<LiveShared>,
    win_rx: Arc<Mutex<rtrb::Consumer<CapWin>>>,
    mon_tx: Arc<Mutex<rtrb::Producer<f32>>>,
    stream: Option<cpal::Stream>,
    writer: Option<WriterHandle>,
    done_tx: Sender<AudioDone>,
    err_tx: Sender<String>,
    status: Arc<Mutex<InputStatus>>,
    self_tx: Sender<InCmd>,
    lat_us: Arc<AtomicU32>,
}

impl InState {
    fn run(&mut self, rx: Receiver<InCmd>) {
        loop {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(InCmd::List(reply)) => {
                    let _ = reply.send(list_input_devices());
                }
                Ok(InCmd::Open { id, channels, reply }) => {
                    let s = self.open(id, channels);
                    let _ = reply.send(s);
                }
                Ok(InCmd::Close(reply)) => {
                    self.close();
                    let s = InputStatus::closed(None);
                    self.set_status(s.clone());
                    let _ = reply.send(s);
                }
                Ok(InCmd::BeginTake { take, path }) => {
                    if let Some(w) = &self.writer {
                        let _ = w.tx.send(WCmd::Begin { take, path });
                    } else {
                        let _ = self.done_tx.send(AudioDone {
                            take,
                            path: path.display().to_string(),
                            frames: 0,
                            sample_rate: 0,
                            channels: 0,
                            peak: 0.0,
                            error: Some("No audio input is open, so nothing was recorded. Pick an input in Settings.".into()),
                        });
                    }
                }
                Ok(InCmd::StreamError(m)) => {
                    self.close();
                    let s = InputStatus::closed(Some(format!("Audio input lost: {m}")));
                    self.set_status(s);
                    let _ = self.err_tx.send(m);
                }
                Ok(InCmd::Shutdown(reply)) => {
                    self.close();
                    let _ = reply.send(());
                    return;
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    let lat = self.lat_us.load(Relaxed);
                    let mut s = self.status.lock().unwrap_or_else(|e| e.into_inner());
                    if s.open && lat > 0 {
                        s.latency_ms = lat as f64 / 1000.0;
                    }
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    self.close();
                    return;
                }
            }
        }
    }

    fn set_status(&self, s: InputStatus) {
        self.live.input_open.store(s.open, Relaxed);
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = s;
    }

    fn close(&mut self) {
        self.stream = None; // stops the callback first
        if let Some(w) = self.writer.take() {
            w.close(); // finalizes a take that was still open
        }
        self.live.input_open.store(false, Relaxed);
    }

    fn open(&mut self, id: Option<String>, channels: Vec<u16>) -> InputStatus {
        self.close();
        let s = match self.build(id.as_deref(), &channels) {
            Ok(s) => s,
            Err(e) => InputStatus::closed(Some(format!("Couldn't open the audio input: {e}"))),
        };
        self.set_status(s.clone());
        s
    }

    fn build(&mut self, id: Option<&str>, want: &[u16]) -> Result<InputStatus, String> {
        let host = cpal::default_host();
        let device = match id {
            Some(want_id) => {
                let devs = host.input_devices().map_err(|e| e.to_string())?;
                let mut found = None;
                for d in devs {
                    if device_id(&d).as_deref() == Some(want_id) || d.to_string() == want_id {
                        found = Some(d);
                        break;
                    }
                }
                found.ok_or_else(|| format!("input '{want_id}' not found"))?
            }
            None => host.default_input_device().ok_or_else(|| "no default input device (is a microphone connected and allowed in Windows privacy settings?)".to_string())?,
        };
        let supported = device.default_input_config().map_err(|e| e.to_string())?;
        let dev_ch = supported.channels().max(1);
        let sr = supported.sample_rate();
        let mut sel: Vec<u16> = want.iter().copied().filter(|c| *c < dev_ch).take(2).collect();
        if sel.is_empty() {
            sel = if dev_ch >= 2 { vec![0, 1] } else { vec![0] };
        }
        let (chunk_tx, chunk_rx) = rtrb::RingBuffer::<Chunk>::new(CHUNK_RING);
        let cap = CapState::new(self.live.clone(), self.win_rx.clone(), self.mon_tx.clone(), chunk_tx, &sel, dev_ch as usize, sr as f64, self.lat_us.clone());
        let config = cpal::StreamConfig { channels: dev_ch, sample_rate: sr, buffer_size: cpal::BufferSize::Default };
        let tx = self.self_tx.clone();
        let err_cb = move |err: cpal::Error| {
            use cpal::ErrorKind as K;
            let kind = err.kind();
            if kind == K::Xrun {
                return;
            }
            if matches!(kind, K::DeviceNotAvailable | K::StreamInvalidated | K::BackendError | K::HostUnavailable) {
                let _ = tx.send(InCmd::StreamError(err.to_string()));
            }
        };
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => {
                let mut cap = cap;
                device
                    .build_input_stream::<f32, _, _>(config, move |data: &[f32], info: &cpal::InputCallbackInfo| cap.on_data(data, latency_ns(info)), err_cb, None)
                    .map_err(|e| format!("cannot open input stream: {e}"))?
            }
            cpal::SampleFormat::I16 => {
                let mut cap = cap;
                let mut scratch: Vec<f32> = Vec::with_capacity(1 << 16);
                device
                    .build_input_stream::<i16, _, _>(
                        config,
                        move |data: &[i16], info: &cpal::InputCallbackInfo| {
                            scratch.clear();
                            scratch.extend(data.iter().map(|s| *s as f32 / 32768.0));
                            cap.on_data(&scratch, latency_ns(info));
                        },
                        err_cb,
                        None,
                    )
                    .map_err(|e| format!("cannot open input stream: {e}"))?
            }
            cpal::SampleFormat::I32 => {
                let mut cap = cap;
                let mut scratch: Vec<f32> = Vec::with_capacity(1 << 16);
                device
                    .build_input_stream::<i32, _, _>(
                        config,
                        move |data: &[i32], info: &cpal::InputCallbackInfo| {
                            scratch.clear();
                            scratch.extend(data.iter().map(|s| *s as f32 / 2_147_483_648.0));
                            cap.on_data(&scratch, latency_ns(info));
                        },
                        err_cb,
                        None,
                    )
                    .map_err(|e| format!("cannot open input stream: {e}"))?
            }
            other => return Err(format!("unsupported input sample format {other:?}")),
        };
        stream.play().map_err(|e| format!("cannot start input stream: {e}"))?;
        let (wtx, wrx) = crossbeam_channel::unbounded();
        let done_tx = self.done_tx.clone();
        let nch = sel.len() as u16;
        let join = std::thread::Builder::new()
            .name("input-writer".into())
            .spawn(move || writer_loop(chunk_rx, wrx, done_tx, sr, nch))
            .map_err(|e| format!("cannot start the writer thread: {e}"))?;
        self.writer = Some(WriterHandle { tx: wtx, join: Some(join) });
        self.stream = Some(stream);
        self.lat_us.store(0, Relaxed);
        Ok(InputStatus {
            open: true,
            device_id: device_id(&device),
            name: Some(device.to_string()),
            sample_rate: sr,
            channels: sel,
            device_channels: dev_ch,
            latency_ms: 0.0,
            message: None,
        })
    }
}

fn latency_ns(info: &cpal::InputCallbackInfo) -> u64 {
    let ts = info.timestamp();
    ts.callback.duration_since(ts.capture).as_nanos().min(u64::MAX as u128) as u64
}

// ── Input callback ───────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
struct Window {
    take: u32,
    from: u64,
    until: u64,
    started: bool,
}

struct CapState {
    live: Arc<LiveShared>,
    win_rx: Arc<Mutex<rtrb::Consumer<CapWin>>>,
    mon_tx: Arc<Mutex<rtrb::Producer<f32>>>,
    chunk_tx: rtrb::Producer<Chunk>,
    sel: [usize; 2],
    nsel: usize,
    dev_ch: usize,
    ns_per_frame: f64,
    /// Capture windows in order: [0] is current.
    wins: [Option<Window>; 8],
    chunk: Chunk,
    lat_us: Arc<AtomicU32>,
}

impl CapState {
    #[allow(clippy::too_many_arguments)]
    fn new(
        live: Arc<LiveShared>,
        win_rx: Arc<Mutex<rtrb::Consumer<CapWin>>>,
        mon_tx: Arc<Mutex<rtrb::Producer<f32>>>,
        chunk_tx: rtrb::Producer<Chunk>,
        sel: &[u16],
        dev_ch: usize,
        sr: f64,
        lat_us: Arc<AtomicU32>,
    ) -> Self {
        let s0 = sel.first().copied().unwrap_or(0) as usize;
        let s1 = sel.get(1).copied().map(|x| x as usize).unwrap_or(s0);
        CapState {
            live,
            win_rx,
            mon_tx,
            chunk_tx,
            sel: [s0, s1],
            nsel: sel.len().clamp(1, 2),
            dev_ch: dev_ch.max(1),
            ns_per_frame: 1e9 / sr.max(1.0),
            wins: [None; 8],
            chunk: Chunk::empty(0),
            lat_us,
        }
    }

    fn pull_windows(&mut self) {
        let Ok(mut rx) = self.win_rx.try_lock() else { return };
        while let Ok(m) = rx.pop() {
            match m {
                CapWin::Begin { take, from_ns } => {
                    if let Some(slot) = self.wins.iter_mut().find(|w| w.is_none()) {
                        *slot = Some(Window { take, from: from_ns, until: u64::MAX, started: false });
                    } else {
                        self.live.rt_dropped.fetch_add(1, Relaxed);
                    }
                }
                CapWin::End { take, until_ns } => {
                    if let Some(w) = self.wins.iter_mut().flatten().find(|w| w.take == take) {
                        w.until = until_ns;
                    }
                }
            }
        }
    }

    fn pop_window(&mut self) {
        for i in 0..self.wins.len() - 1 {
            self.wins[i] = self.wins[i + 1];
        }
        let last = self.wins.len() - 1;
        self.wins[last] = None;
    }

    fn push_sample(&mut self, take: u32, v: f32) {
        if self.chunk.take != take || self.chunk.len as usize >= CHUNK_FLOATS {
            self.flush(false);
            self.chunk.take = take;
        }
        let i = self.chunk.len as usize;
        self.chunk.data[i] = v;
        self.chunk.len += 1;
    }

    fn flush(&mut self, end: bool) {
        if self.chunk.len == 0 && !end {
            return;
        }
        self.chunk.end = end;
        if self.chunk_tx.push(self.chunk).is_err() {
            self.live.rt_dropped.fetch_add(1, Relaxed);
        }
        self.chunk.len = 0;
        self.chunk.end = false;
    }

    fn on_data(&mut self, data: &[f32], lat_ns: u64) {
        let dch = self.dev_ch;
        let frames = data.len() / dch;
        if frames == 0 {
            return;
        }
        self.lat_us.store((lat_ns / 1000).min(u32::MAX as u64) as u32, Relaxed);
        let t0 = now_ns().saturating_sub(lat_ns);
        let (s0, s1) = (self.sel[0], self.sel[1]);
        // Meter.
        let (mut pl, mut pr) = (0f32, 0f32);
        for f in 0..frames {
            pl = pl.max(data[f * dch + s0].abs());
            pr = pr.max(data[f * dch + s1].abs());
        }
        if pl.is_finite() && pr.is_finite() {
            self.live.input_peak[0].fetch_max(pl.min(4.0).to_bits(), Relaxed);
            self.live.input_peak[1].fetch_max(pr.min(4.0).to_bits(), Relaxed);
        }
        // Monitor (stereo: a mono selection is duplicated).
        if self.live.monitor.load(Relaxed) {
            if let Ok(mut tx) = self.mon_tx.try_lock() {
                if tx.slots() >= frames * 2 {
                    for f in 0..frames {
                        let _ = tx.push(data[f * dch + s0]);
                        let _ = tx.push(data[f * dch + s1]);
                    }
                }
            }
        }
        // Capture.
        self.pull_windows();
        let npf = self.ns_per_frame;
        let end_t = t0 + (frames as f64 * npf) as u64;
        let mut i = 0usize;
        while let Some(mut w) = self.wins[0] {
            let (a, b) = capture_range(t0, npf, frames, w.from, w.until);
            let a = a.max(i);
            if !w.started && b > a {
                w.started = true;
                // The stream started after the take did: pad so frame 0 stays at the take start.
                if a == 0 && t0 > w.from {
                    let pad = (((t0 - w.from) as f64 / npf).round()).min(MAX_PAD_SEC * 1e9 / npf) as usize;
                    for _ in 0..pad * self.nsel {
                        self.push_sample(w.take, 0.0);
                    }
                }
                self.wins[0] = Some(w);
            }
            for f in a..b {
                self.push_sample(w.take, data[f * dch + s0]);
                if self.nsel > 1 {
                    self.push_sample(w.take, data[f * dch + s1]);
                }
            }
            if w.until != u64::MAX && end_t >= w.until {
                self.chunk.take = w.take;
                self.flush(true);
                self.pop_window();
                i = b;
                continue;
            }
            break;
        }
        // Keep latency low: hand partial chunks over at the end of every callback.
        if self.chunk.len > 0 {
            self.flush(false);
        }
    }
}

// ── Writer thread ────────────────────────────────────────────────────────

struct Active {
    take: u32,
    part: PathBuf,
    path: PathBuf,
    writer: Option<hound::WavWriter<std::io::BufWriter<std::fs::File>>>,
    frames: u64,
    samples: u64,
    peak: f32,
    error: Option<String>,
}

fn open_writer(take: u32, path: PathBuf, sr: u32, nch: u16) -> Active {
    let part = path.with_extension("wav.part");
    let spec = hound::WavSpec { channels: nch, sample_rate: sr, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match hound::WavWriter::create(&part, spec) {
        Ok(w) => Active { take, part, path, writer: Some(w), frames: 0, samples: 0, peak: 0.0, error: None },
        Err(e) => Active { take, part, path: path.clone(), writer: None, frames: 0, samples: 0, peak: 0.0, error: Some(format!("Couldn't create {}: {e}", path.display())) },
    }
}

fn finish(mut a: Active, sr: u32, nch: u16, done: &Sender<AudioDone>, note: Option<&str>) {
    let mut error = a.error.take();
    if let Some(w) = a.writer.take() {
        match w.finalize() {
            Ok(()) => {
                if let Err(e) = std::fs::rename(&a.part, &a.path) {
                    error = Some(format!("Couldn't save {}: {e}", a.path.display()));
                }
            }
            Err(e) => error = Some(format!("Couldn't finish writing {}: {e}", a.path.display())),
        }
    }
    if error.is_none() {
        if let Some(n) = note {
            eprintln!("[input] take {}: {n}", a.take);
        }
    }
    let _ = done.send(AudioDone { take: a.take, path: a.path.display().to_string(), frames: a.frames, sample_rate: sr, channels: nch, peak: a.peak, error });
}

fn writer_loop(mut rx: rtrb::Consumer<Chunk>, cmd: Receiver<WCmd>, done: Sender<AudioDone>, sr: u32, nch: u16) {
    let mut paths: HashMap<u32, PathBuf> = HashMap::new();
    let mut cur: Option<Active> = None;
    let mut closing = false;
    let mut waiting_since: Option<Instant> = None;
    loop {
        while let Ok(c) = cmd.try_recv() {
            match c {
                WCmd::Begin { take, path } => {
                    paths.insert(take, path);
                }
                WCmd::Close => closing = true,
            }
        }
        let Ok(chunk) = rx.peek().map(|c| *c) else {
            if closing {
                if let Some(a) = cur.take() {
                    finish(a, sr, nch, &done, Some("input closed before the take ended"));
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(4));
            continue;
        };
        if cur.as_ref().map(|a| a.take) != Some(chunk.take) {
            if let Some(a) = cur.take() {
                finish(a, sr, nch, &done, Some("take ended without its end marker"));
            }
            match paths.remove(&chunk.take) {
                Some(p) => {
                    waiting_since = None;
                    cur = Some(open_writer(chunk.take, p, sr, nch));
                }
                None if closing => {
                    let _ = rx.pop();
                    continue;
                }
                None => {
                    // The control thread names the file when it sees the take start.
                    let since = *waiting_since.get_or_insert_with(Instant::now);
                    if since.elapsed() < Duration::from_secs(3) {
                        match cmd.recv_timeout(Duration::from_millis(20)) {
                            Ok(WCmd::Begin { take, path }) => {
                                paths.insert(take, path);
                            }
                            Ok(WCmd::Close) => closing = true,
                            Err(_) => {}
                        }
                        continue;
                    }
                    waiting_since = None;
                    let fallback = std::env::temp_dir().join("Krypt Studio recordings").join(format!("take {}.wav", chunk.take));
                    cur = Some(open_writer(chunk.take, fallback, sr, nch));
                }
            }
        }
        let _ = rx.pop();
        if let Some(a) = cur.as_mut() {
            let n = chunk.len as usize;
            if let Some(w) = a.writer.as_mut() {
                for &s in &chunk.data[..n] {
                    if w.write_sample(s).is_err() {
                        a.error = Some(format!("Disk write failed for {}", a.path.display()));
                        a.writer = None;
                        break;
                    }
                    let m = s.abs();
                    if m.is_finite() && m > a.peak {
                        a.peak = m;
                    }
                }
            }
            a.samples += n as u64;
            a.frames = a.samples / nch.max(1) as u64;
            if chunk.end {
                if let Some(a) = cur.take() {
                    finish(a, sr, nch, &done, None);
                }
            }
        }
    }
}

/// `<dir>/<name> take <n>.wav`, made unique with " (2)", " (3)"...
pub fn take_path(dir: &Path, name: &str, take: u32) -> PathBuf {
    let clean: String = name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let base = if clean.trim().is_empty() { "Recording".to_string() } else { clean.trim().to_string() };
    let mut p = dir.join(format!("{base} take {take}.wav"));
    let mut i = 2;
    while p.exists() || p.with_extension("wav.part").exists() {
        p = dir.join(format!("{base} take {take} ({i}).wav"));
        i += 1;
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_range_selects_the_heard_window() {
        let npf = 1e9 / 48000.0; // ≈ 20833 ns per frame
        let t0 = 1_000_000_000u64;
        // Window opens 10 frames into the buffer, still open.
        let from = t0 + (10.0 * npf) as u64;
        assert_eq!(capture_range(t0, npf, 480, from, u64::MAX), (10, 480));
        // Window opened earlier: everything.
        assert_eq!(capture_range(t0, npf, 480, t0 - 5, u64::MAX), (0, 480));
        // Window not open yet.
        assert_eq!(capture_range(t0, npf, 480, t0 + (1000.0 * npf) as u64, u64::MAX), (480, 480));
        // Window closes at frame 100.
        let until = t0 + (100.0 * npf) as u64;
        assert_eq!(capture_range(t0, npf, 480, t0 - 5, until), (0, 100));
        // Already closed.
        assert_eq!(capture_range(t0, npf, 480, t0 - 1000, t0 - 10), (0, 0));
    }

    fn cap_for_test(sel: &[u16], dev_ch: usize) -> (CapState, rtrb::Producer<CapWin>, rtrb::Consumer<Chunk>, Arc<LiveShared>) {
        let live = Arc::new(LiveShared::new());
        let (wtx, wrx) = rtrb::RingBuffer::new(8);
        let (mtx, _mrx) = rtrb::RingBuffer::new(1024);
        let (ctx, crx) = rtrb::RingBuffer::new(64);
        let cap = CapState::new(live.clone(), Arc::new(Mutex::new(wrx)), Arc::new(Mutex::new(mtx)), ctx, sel, dev_ch, 48000.0, Arc::new(AtomicU32::new(0)));
        (cap, wtx, crx, live)
    }

    fn drain(rx: &mut rtrb::Consumer<Chunk>) -> (Vec<f32>, usize) {
        let mut v = Vec::new();
        let mut ends = 0;
        while let Ok(c) = rx.pop() {
            v.extend_from_slice(&c.data[..c.len as usize]);
            if c.end {
                ends += 1;
            }
        }
        (v, ends)
    }

    #[test]
    fn input_callback_captures_only_inside_the_window() {
        crate::midi::init_clock();
        // Stereo device, record channel 2 only (mono take).
        let (mut cap, mut wtx, mut crx, live) = cap_for_test(&[1], 2);
        let data: Vec<f32> = (0..960).map(|i| if i % 2 == 1 { 0.5 } else { -0.25 }).collect(); // 480 frames
        // No window: nothing captured, but the meter moves.
        cap.on_data(&data, 0);
        assert_eq!(drain(&mut crx).0.len(), 0);
        assert!(f32::from_bits(live.input_peak[0].load(Relaxed)) > 0.49);
        // A window that started long ago and ends long ago → empty take with an end marker.
        let now = now_ns();
        wtx.push(CapWin::Begin { take: 1, from_ns: now.saturating_sub(10_000_000_000) }).unwrap();
        wtx.push(CapWin::End { take: 1, until_ns: now.saturating_sub(9_000_000_000) }).unwrap();
        cap.on_data(&data, 0);
        let (_, ends) = drain(&mut crx);
        assert_eq!(ends, 1);
        // An open window from "now - 1 s": the whole buffer is captured, channel 2 only.
        let now = now_ns();
        wtx.push(CapWin::Begin { take: 2, from_ns: now.saturating_sub(1_000) }).unwrap();
        cap.on_data(&data, 0);
        let (v, ends) = drain(&mut crx);
        assert_eq!(ends, 0);
        // The whole buffer (channel 2 only), after at most a few frames of alignment padding.
        assert!(v.len() >= 480, "{}", v.len());
        let pad = v.len() - 480;
        assert!(v[..pad].iter().all(|x| *x == 0.0) && v[pad..].iter().all(|x| *x == 0.5));
        // End it in the past → the next callback only emits the end marker.
        wtx.push(CapWin::End { take: 2, until_ns: now }).unwrap();
        cap.on_data(&data, 0);
        let (v, ends) = drain(&mut crx);
        assert_eq!((v.len(), ends), (0, 1));
    }

    #[test]
    fn late_stream_pads_leading_silence() {
        crate::midi::init_clock();
        while now_ns() < 50_000_000 {
            std::thread::sleep(Duration::from_millis(5)); // the clock must be past the window start
        }
        let (mut cap, mut wtx, mut crx, _live) = cap_for_test(&[0, 1], 2);
        let now = now_ns();
        // The take began 10 ms before this buffer was captured → 480 frames of padding.
        wtx.push(CapWin::Begin { take: 7, from_ns: now - 10_000_000 }).unwrap();
        let data = vec![1.0f32; 96]; // 48 stereo frames
        cap.on_data(&data, 0);
        let (v, _) = drain(&mut crx);
        let frames = v.len() / 2;
        assert!((525..=800).contains(&frames), "{frames}");
        assert!(v[..2 * 470].iter().all(|x| *x == 0.0));
        assert!(v[v.len() - 2..].iter().all(|x| *x == 1.0));
    }

    #[test]
    fn writer_produces_a_wav_per_take() {
        let dir = std::env::temp_dir().join(format!("krypt-rec-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let (mut tx, rx) = rtrb::RingBuffer::<Chunk>::new(16);
        let (ctx, crx) = crossbeam_channel::unbounded();
        let (dtx, drx) = crossbeam_channel::unbounded();
        let path = take_path(&dir, "Song: one", 3);
        assert!(path.file_name().unwrap().to_string_lossy().starts_with("Song_ one take 3"));
        ctx.send(WCmd::Begin { take: 3, path: path.clone() }).unwrap();
        let h = std::thread::spawn(move || writer_loop(rx, crx, dtx, 48000, 2));
        let mut c = Chunk::empty(3);
        for i in 0..200 {
            c.data[i] = if i % 2 == 0 { 0.5 } else { -0.75 };
        }
        c.len = 200;
        tx.push(c).unwrap();
        let mut e = Chunk::empty(3);
        e.end = true;
        tx.push(e).unwrap();
        let d = drx.recv_timeout(Duration::from_secs(5)).expect("take reported");
        assert!(d.error.is_none(), "{:?}", d.error);
        assert_eq!((d.take, d.frames, d.channels, d.sample_rate), (3, 100, 2, 48000));
        assert!((d.peak - 0.75).abs() < 1e-6);
        let r = hound::WavReader::open(&path).expect("wav exists");
        assert_eq!(r.spec().channels, 2);
        assert_eq!(r.len(), 200);
        ctx.send(WCmd::Close).unwrap();
        h.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
