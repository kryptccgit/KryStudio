//! Audio output: cpal (WASAPI shared mode on Windows). A dedicated device
//! thread owns the stream, rebuilds it on device loss (retry every 2 s) and
//! falls back to a "null driver" that keeps the core running in real time
//! without a device, so transport and telemetry keep working.

use crate::core::Core;
use crate::protocol::{DeviceInfo, DeviceStatus, Out};
use crate::rt::{self, TryCell};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{Receiver, Sender};
use serde_json::json;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering::*};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub type CoreCell = Arc<TryCell<Core>>;

enum DevCmd {
    List(Sender<Result<Vec<DeviceInfo>, String>>),
    Open { id: Option<String>, buffer: Option<u32>, rate: Option<u32>, reply: Sender<DeviceStatus> },
    StreamError { message: String, fatal: bool },
    Shutdown(Sender<()>),
}

#[derive(Clone)]
pub struct DeviceManager {
    tx: Sender<DevCmd>,
    pub status: Arc<Mutex<DeviceStatus>>,
}

impl DeviceManager {
    /// Start the device thread and open the default device (or the null driver).
    pub fn start(core: CoreCell, out: Arc<Out>, use_device: bool) -> DeviceManager {
        let (tx, rx) = crossbeam_channel::unbounded();
        let status = Arc::new(Mutex::new(DeviceStatus::closed(48000, Some("Starting".into()))));
        let mgr = DeviceManager { tx: tx.clone(), status: status.clone() };
        let (ready_tx, ready_rx) = crossbeam_channel::bounded(1);
        let _ = std::thread::Builder::new().name("device".into()).spawn(move || {
            let mut st = DevState { core, out, tx, status, stream: None, null: None, want_id: None, want_buffer: None, want_rate: None, lost: false, use_device };
            let s = st.open(None, None, None, false);
            let _ = ready_tx.send(s);
            st.run(rx);
        });
        let _ = ready_rx.recv_timeout(Duration::from_secs(5));
        mgr
    }

    pub fn status(&self) -> DeviceStatus {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn list(&self) -> Result<Vec<DeviceInfo>, String> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.tx.send(DevCmd::List(tx)).map_err(|_| "Device thread is gone".to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Timed out listing audio devices".to_string())?
    }

    pub fn open(&self, id: Option<String>, buffer: Option<u32>, rate: Option<u32>) -> Result<DeviceStatus, String> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.tx.send(DevCmd::Open { id, buffer, rate, reply: tx }).map_err(|_| "Device thread is gone".to_string())?;
        rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "Timed out opening the audio device".to_string())
    }

    pub fn shutdown(&self) {
        let (tx, rx) = crossbeam_channel::bounded(1);
        if self.tx.send(DevCmd::Shutdown(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_millis(300));
        }
    }
}

struct NullDriver {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl NullDriver {
    fn start(core: CoreCell, sr: u32) -> NullDriver {
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        let handle = std::thread::Builder::new()
            .name("null-audio".into())
            .spawn(move || {
                rt::enable_ftz_daz();
                const BLOCK: usize = 512;
                let mut l = vec![0f32; BLOCK];
                let mut r = vec![0f32; BLOCK];
                let period = Duration::from_secs_f64(BLOCK as f64 / sr.max(8000) as f64);
                let mut next = Instant::now();
                while !s2.load(Acquire) {
                    if let Some(mut c) = core.try_borrow() {
                        let shared = c.shared.clone();
                        if !c.faulted {
                            let res = std::panic::catch_unwind(AssertUnwindSafe(|| rt::no_alloc(|| c.process_stereo(&mut l, &mut r))));
                            if res.is_err() {
                                c.faulted = true;
                                shared.faulted.store(true, Release);
                            }
                        }
                        shared.callbacks.fetch_add(1, Relaxed);
                    }
                    next += period;
                    let now = Instant::now();
                    if next > now {
                        std::thread::sleep(next - now);
                    } else {
                        next = now;
                    }
                }
            })
            .ok();
        NullDriver { stop, handle }
    }
}

impl Drop for NullDriver {
    fn drop(&mut self) {
        self.stop.store(true, Release);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

struct DevState {
    core: CoreCell,
    out: Arc<Out>,
    tx: Sender<DevCmd>,
    status: Arc<Mutex<DeviceStatus>>,
    stream: Option<cpal::Stream>,
    null: Option<NullDriver>,
    want_id: Option<String>,
    want_buffer: Option<u32>,
    want_rate: Option<u32>,
    lost: bool,
    use_device: bool,
}

const COMMON_RATES: [u32; 8] = [22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000];

fn device_name(d: &cpal::Device) -> String {
    d.to_string()
}

fn device_id(d: &cpal::Device) -> Option<String> {
    d.id().ok().map(|i| i.to_string())
}

pub fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    let host = cpal::default_host();
    let default_id = host.default_output_device().and_then(|d| device_id(&d));
    let devs = host.output_devices().map_err(|e| format!("Cannot enumerate audio devices: {e}"))?;
    let mut out = Vec::new();
    for d in devs {
        let Some(id) = device_id(&d) else { continue };
        let channels = d.default_output_config().map(|c| c.channels()).unwrap_or(2);
        let mut rates: Vec<u32> = Vec::new();
        if let Ok(cfgs) = d.supported_output_configs() {
            for c in cfgs {
                for r in COMMON_RATES {
                    if r >= c.min_sample_rate() && r <= c.max_sample_rate() && !rates.contains(&r) {
                        rates.push(r);
                    }
                }
                if !COMMON_RATES.contains(&c.max_sample_rate()) && !rates.contains(&c.max_sample_rate()) {
                    rates.push(c.max_sample_rate());
                }
            }
        }
        if let Ok(def) = d.default_output_config() {
            if !rates.contains(&def.sample_rate()) {
                rates.push(def.sample_rate());
            }
        }
        rates.sort_unstable();
        out.push(DeviceInfo { is_default: default_id.as_deref() == Some(id.as_str()), id, name: device_name(&d), backend: "wasapi", channels, sample_rates: rates });
    }
    Ok(out)
}

impl DevState {
    fn set_status(&self, s: &DeviceStatus) {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = s.clone();
    }

    fn emit(&self, s: &DeviceStatus) {
        self.out.event(json!({ "event": "device", "status": s }));
    }

    fn run(&mut self, rx: Receiver<DevCmd>) {
        loop {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(DevCmd::List(reply)) => {
                    let _ = reply.send(list_devices());
                }
                Ok(DevCmd::Open { id, buffer, rate, reply }) => {
                    let s = self.open(id, buffer, rate, true);
                    let _ = reply.send(s);
                }
                Ok(DevCmd::StreamError { message, fatal }) => {
                    if fatal && self.stream.is_some() {
                        self.stream = None;
                        self.lost = true;
                        let sr = self.core_sr();
                        self.null = Some(NullDriver::start(self.core.clone(), sr));
                        let s = DeviceStatus::closed(sr, Some(format!("Audio device lost ({message}); retrying every 2 s")));
                        self.set_status(&s);
                        self.emit(&s);
                        self.out.log("warn", format!("Audio device lost: {message}"));
                        // A changed default device can usually be reopened right away.
                        self.try_recover();
                    } else if !fatal {
                        self.out.log("debug", format!("Audio stream: {message}"));
                    }
                }
                Ok(DevCmd::Shutdown(reply)) => {
                    self.stream = None;
                    self.null = None;
                    let _ = reply.send(());
                    return;
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    if self.lost {
                        self.try_recover();
                    }
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn core_sr(&self) -> u32 {
        self.core.borrow_blocking().sr as u32
    }

    fn try_recover(&mut self) {
        let want = self.want_id.clone();
        match self.build(want.as_deref(), self.want_buffer, self.want_rate).or_else(|e| {
            if want.is_some() {
                self.build(None, self.want_buffer, self.want_rate).map_err(|e2| format!("{e}; default device: {e2}"))
            } else {
                Err(e)
            }
        }) {
            Ok((stream, mut s)) => {
                self.null = None;
                self.stream = Some(stream);
                self.lost = false;
                s.message = Some("Audio device recovered".into());
                self.set_status(&s);
                self.emit(&s);
                self.out.log("info", format!("Audio output recovered on {}", s.name.clone().unwrap_or_default()));
            }
            Err(_) => {}
        }
    }

    /// Open a device (None = system default). On failure fall back to the
    /// default, then to the null driver. Always returns the resulting status.
    fn open(&mut self, id: Option<String>, buffer: Option<u32>, rate: Option<u32>, emit: bool) -> DeviceStatus {
        self.want_id = id.clone();
        self.want_buffer = buffer;
        self.want_rate = rate;
        // Release the current stream / null driver first (exclusive drivers, same device).
        self.stream = None;
        self.null = None;
        if !self.use_device {
            let sr = rate.unwrap_or(48000);
            self.prepare_core(sr);
            self.null = Some(NullDriver::start(self.core.clone(), sr));
            let s = DeviceStatus::closed(sr, Some("Audio output disabled (--no-audio); running the null driver".into()));
            self.set_status(&s);
            return s;
        }
        let res = match self.build(id.as_deref(), buffer, rate) {
            Ok(x) => Ok(x),
            Err(e) if id.is_some() || rate.is_some() || buffer.is_some() => match self.build(None, None, None) {
                Ok((st, mut s)) => {
                    s.message = Some(format!("Could not open the requested device ({e}); using the system default"));
                    Ok((st, s))
                }
                Err(e2) => Err(format!("{e}; default device: {e2}")),
            },
            Err(e) => Err(e),
        };
        let s = match res {
            Ok((stream, s)) => {
                self.null = None;
                self.stream = Some(stream);
                self.lost = false;
                s
            }
            Err(e) => {
                let sr = self.core_sr().max(8000);
                self.null = Some(NullDriver::start(self.core.clone(), sr));
                self.lost = true;
                self.out.log("error", format!("No audio output device could be opened: {e}"));
                DeviceStatus::closed(sr, Some(format!("No audio output device could be opened: {e}. Retrying every 2 s.")))
            }
        };
        self.set_status(&s);
        if emit {
            self.emit(&s);
        }
        s
    }

    fn prepare_core(&self, sr: u32) {
        let mut c = self.core.borrow_blocking();
        c.set_sample_rate(sr as f32);
        c.shared.sample_rate.store(sr, Relaxed);
    }

    fn build(&mut self, id: Option<&str>, buffer: Option<u32>, rate: Option<u32>) -> Result<(cpal::Stream, DeviceStatus), String> {
        let host = cpal::default_host();
        let device = match id {
            Some(want) => {
                let devs = host.output_devices().map_err(|e| e.to_string())?;
                let mut found = None;
                for d in devs {
                    if device_id(&d).as_deref() == Some(want) || device_name(&d) == want {
                        found = Some(d);
                        break;
                    }
                }
                found.ok_or_else(|| format!("device '{want}' not found"))?
            }
            None => host.default_output_device().ok_or_else(|| "no default output device".to_string())?,
        };
        let supported = device.default_output_config().map_err(|e| e.to_string())?;
        let channels = supported.channels().max(1);
        let mut sr = supported.sample_rate();
        if let Some(r) = rate {
            if let Ok(mut cfgs) = device.supported_output_configs() {
                if cfgs.any(|c| c.channels() == channels && r >= c.min_sample_rate() && r <= c.max_sample_rate()) {
                    sr = r;
                }
            }
        }
        let buffer_size = match (buffer, supported.buffer_size()) {
            (Some(b), cpal::SupportedBufferSize::Range { min, max }) => cpal::BufferSize::Fixed(b.clamp(*min, *max)),
            (Some(b), cpal::SupportedBufferSize::Unknown) => cpal::BufferSize::Fixed(b),
            (None, _) => cpal::BufferSize::Default,
        };
        self.null = None; // stop the null driver before re-preparing
        self.prepare_core(sr);
        let stream = match self.build_stream(&device, cpal::StreamConfig { channels, sample_rate: sr, buffer_size }) {
            Ok(s) => s,
            Err(e) if buffer_size != cpal::BufferSize::Default => {
                eprintln!("[device] fixed buffer refused ({e}); using the default buffer size");
                self.build_stream(&device, cpal::StreamConfig { channels, sample_rate: sr, buffer_size: cpal::BufferSize::Default })?
            }
            Err(e) => return Err(e),
        };
        stream.play().map_err(|e| format!("cannot start stream: {e}"))?;
        // Wait briefly for the first callbacks to learn the real period/latency.
        let shared = self.core.borrow_blocking().shared.clone();
        let start_cb = shared.callbacks.load(Relaxed);
        let t = Instant::now();
        while shared.callbacks.load(Relaxed) < start_cb + 2 && t.elapsed() < Duration::from_millis(400) {
            std::thread::sleep(Duration::from_millis(5));
        }
        let frames = shared.buffer_frames.load(Relaxed);
        let lat_us = shared.out_latency_us.load(Relaxed);
        let status = DeviceStatus {
            open: true,
            id: device_id(&device),
            name: Some(device_name(&device)),
            backend: Some("wasapi".into()),
            sample_rate: sr,
            buffer_frames: frames,
            output_latency_ms: if lat_us > 0 { lat_us as f64 / 1000.0 } else { frames as f64 * 1000.0 / sr as f64 },
            message: None,
        };
        Ok((stream, status))
    }

    fn build_stream(&self, device: &cpal::Device, config: cpal::StreamConfig) -> Result<cpal::Stream, String> {
        let core = self.core.clone();
        let shared = core.borrow_blocking().shared.clone();
        let channels = config.channels as usize;
        let sr = config.sample_rate as f64;
        let mut first = true;
        let mut warmup = 8u32;
        let mut last_cb: Option<cpal::StreamInstant> = None;
        let mut cpu_avg = 0f32;
        let data_cb = move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
            if first {
                first = false;
                rt::enable_ftz_daz();
                if !rt::mmcss_pro_audio() {
                    eprintln!("[device] MMCSS 'Pro Audio' registration refused");
                }
            }
            let t0 = Instant::now();
            let frames = data.len() / channels.max(1);
            rt::no_alloc(|| match core.try_borrow() {
                Some(mut c) => {
                    if c.faulted {
                        data.fill(0.0);
                    } else {
                        let res = std::panic::catch_unwind(AssertUnwindSafe(|| c.process_interleaved(data, channels)));
                        if res.is_err() {
                            c.faulted = true;
                            shared.faulted.store(true, Release);
                            data.fill(0.0);
                        }
                    }
                }
                None => data.fill(0.0),
            });
            let ts = info.timestamp();
            let lat = ts.playback.duration_since(ts.callback);
            shared.out_latency_us.store(lat.as_micros().min(u32::MAX as u128) as u32, Relaxed);
            shared.buffer_frames.store(frames as u32, Relaxed);
            let period = frames as f64 / sr;
            // Stream start-up callbacks are irregular: don't count them as xruns.
            if warmup > 0 {
                warmup -= 1;
            } else if let Some(prev) = last_cb {
                let gap = ts.callback.duration_since(prev).as_secs_f64();
                if period > 0.0 && gap > period * 1.8 + 0.002 {
                    shared.xruns.fetch_add(1, Relaxed);
                }
            }
            last_cb = Some(ts.callback);
            if period > 0.0 {
                let load = (t0.elapsed().as_secs_f64() / period) as f32;
                if load > 1.0 && warmup == 0 {
                    shared.xruns.fetch_add(1, Relaxed);
                }
                cpu_avg = cpu_avg * 0.9 + load.min(2.0) * 0.1;
                shared.cpu.store(cpu_avg.to_bits(), Relaxed);
            }
            shared.callbacks.fetch_add(1, Relaxed);
        };
        let tx = self.tx.clone();
        let shared2 = self.core.borrow_blocking().shared.clone();
        let err_cb = move |err: cpal::Error| {
            use cpal::ErrorKind as K;
            let kind = err.kind();
            if kind == K::Xrun {
                shared2.xruns.fetch_add(1, Relaxed);
                return;
            }
            let fatal = matches!(kind, K::DeviceNotAvailable | K::StreamInvalidated | K::BackendError | K::HostUnavailable);
            let _ = tx.send(DevCmd::StreamError { message: err.to_string(), fatal });
        };
        device.build_output_stream::<f32, _, _>(config, data_cb, err_cb, None).map_err(|e| format!("cannot open output stream: {e}"))
    }
}
