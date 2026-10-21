use crate::compile::Names;
use crate::core::Shared;
use crate::program::NONE;
use crate::protocol::Out;
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use serde::Serialize;
use std::collections::BTreeMap;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::Ordering::*;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

pub const FFT_SIZE: usize = 2048;
pub const SPECTRUM_BINS: usize = 64;
const FRAME_MS: u64 = 16;

pub struct TelemetryInfo {
    pub port: u16,
    pub token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Frame<'a> {
    t: &'static str,
    playing: bool,
    tick: f64,
    sec: f64,
    bpm: f64,
    mode: &'static str,
    pattern_id: Option<&'a str>,
    clock_ms: f64,
    meters: BTreeMap<&'a str, [f32; 2]>,
    channels: BTreeMap<&'a str, f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    spectrum: Option<Vec<f32>>,
    cpu: f32,
    xruns: u32,
    applied_version: u64,
    midi_in: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    rec: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    count_in: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_peak: Option<[f32; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    monitor_peak: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    launcher: Option<crate::launcher::LauncherTel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sync: Option<crate::clock::SyncTel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gr: Option<BTreeMap<&'a str, f32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scopes: Option<BTreeMap<String, krypt_studio_dsp::scope::ScopeData>>,
}

pub struct Spectrum {
    fft: Arc<dyn Fft<f32>>,
    hist: Vec<f32>,
    pos: usize,
    window: Vec<f32>,
    buf: Vec<Complex<f32>>,
}

impl Default for Spectrum {
    fn default() -> Self {
        Self::new()
    }
}

impl Spectrum {
    pub fn new() -> Self {
        let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
        let window = (0..FFT_SIZE).map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / FFT_SIZE as f32).cos()).collect();
        Self { fft, hist: vec![0.0; FFT_SIZE], pos: 0, window, buf: vec![Complex::new(0.0, 0.0); FFT_SIZE] }
    }

    pub fn push(&mut self, x: f32) {
        self.hist[self.pos] = if x.is_finite() { x } else { 0.0 };
        self.pos = (self.pos + 1) % FFT_SIZE;
    }

    pub fn compute(&mut self, sr: f32) -> Vec<f32> {
        for i in 0..FFT_SIZE {
            let s = self.hist[(self.pos + i) % FFT_SIZE];
            self.buf[i] = Complex::new(s * self.window[i], 0.0);
        }
        self.fft.process(&mut self.buf);
        let norm = 2.0 / (FFT_SIZE as f32 * 0.5);
        let half = FFT_SIZE / 2;
        let mags: Vec<f32> = self.buf[..=half].iter().map(|c| c.norm() * norm).collect();
        let bin_hz = sr / FFT_SIZE as f32;
        let (f0, f1) = (20f32, 20_000f32);
        let ratio = f1 / f0;
        let mut out = Vec::with_capacity(SPECTRUM_BINS);
        for b in 0..SPECTRUM_BINS {
            let lo = f0 * ratio.powf(b as f32 / SPECTRUM_BINS as f32);
            let hi = f0 * ratio.powf((b + 1) as f32 / SPECTRUM_BINS as f32);
            let k0 = (lo / bin_hz).ceil() as usize;
            let k1 = ((hi / bin_hz).floor() as usize).min(half);
            let mag = if k0 <= k1 && k0 <= half {
                mags[k0..=k1].iter().fold(0f32, |a, &m| a.max(m))
            } else {
                let k = ((lo * hi).sqrt() / bin_hz).min(half as f32);
                let i = k.floor() as usize;
                let j = (i + 1).min(half);
                let t = k - i as f32;
                mags[i] * (1.0 - t) + mags[j] * t
            };
            let db = 20.0 * mag.max(1e-9).log10();
            out.push(db.clamp(-120.0, 6.0));
        }
        out
    }
}

type Clients = Arc<Mutex<Vec<WebSocket<TcpStream>>>>;

fn random_token() -> String {
    let mut b = [0u8; 16];
    if getrandom::fill(&mut b).is_err() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let x = t ^ ((std::process::id() as u128) << 64);
        b.copy_from_slice(&x.to_le_bytes());
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn token_ok(req: &Request, token: &str) -> bool {
    let Some(q) = req.uri().query() else { return false };
    q.split('&').any(|kv| {
        let mut it = kv.splitn(2, '=');
        it.next() == Some("token") && it.next().map(|v| v.as_bytes().len() == token.len() && constant_eq(v.as_bytes(), token.as_bytes())).unwrap_or(false)
    })
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn start(shared: Arc<Shared>, names: Arc<Mutex<Names>>, spec_rx: rtrb::Consumer<f32>, out: Arc<Out>) -> std::io::Result<TelemetryInfo> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let token = random_token();
    let clients: Clients = Arc::new(Mutex::new(Vec::new()));

    {
        let clients = clients.clone();
        let token = token.clone();
        let out = out.clone();
        std::thread::Builder::new().name("telemetry-accept".into()).spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let clients = clients.clone();
                let token = token.clone();
                let out = out.clone();
                let _ = std::thread::Builder::new().name("telemetry-handshake".into()).spawn(move || {
                    let _ = stream.set_nodelay(true);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
                    let cb = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
                        if token_ok(req, &token) {
                            Ok(resp)
                        } else {
                            let mut e = ErrorResponse::new(Some("invalid telemetry token".into()));
                            *e.status_mut() = tungstenite::http::StatusCode::UNAUTHORIZED;
                            Err(e)
                        }
                    };
                    let cfg = WebSocketConfig::default().max_write_buffer_size(4 << 20);
                    match tungstenite::accept_hdr_with_config(stream, cb, Some(cfg)) {
                        Ok(ws) => {
                            if ws.get_ref().set_nonblocking(true).is_ok() {
                                clients.lock().unwrap_or_else(|e| e.into_inner()).push(ws);
                            }
                        }
                        Err(e) => {
                            eprintln!("[telemetry] rejected connection: {e}");
                            let _ = &out;
                        }
                    }
                });
            }
        })?;
    }

    std::thread::Builder::new().name("telemetry-frames".into()).spawn(move || frame_loop(shared, names, spec_rx, clients))?;
    Ok(TelemetryInfo { port, token })
}

fn frame_loop(shared: Arc<Shared>, names: Arc<Mutex<Names>>, mut spec_rx: rtrb::Consumer<f32>, clients: Clients) {
    let t0 = Instant::now();
    let mut spectrum = Spectrum::new();
    let mut frame_no: u64 = 0;
    let mut next = Instant::now();
    let mut watcher = crate::meters::Watcher::default();
    let mut was_playing = false;
    loop {
        next += Duration::from_millis(FRAME_MS);
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now;
        }
        frame_no += 1;
        while let Ok(x) = spec_rx.pop() {
            spectrum.push(x);
        }
        let n = names.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mut meters = BTreeMap::new();
        for (slot, id) in &n.inserts {
            let s = *slot as usize;
            if s < shared.ins_peak.len() {
                let l = f32::from_bits(shared.ins_peak[s][0].swap(0, Relaxed));
                let r = f32::from_bits(shared.ins_peak[s][1].swap(0, Relaxed));
                meters.insert(id.as_str(), [finite(l), finite(r)]);
            }
        }
        let mut channels = BTreeMap::new();
        for (slot, id) in &n.channels {
            let s = *slot as usize;
            if s < shared.ch_act.len() {
                let a = f32::from_bits(shared.ch_act[s].swap(0, Relaxed));
                channels.insert(id.as_str(), finite(a).clamp(0.0, 1.0));
            }
        }
        let mut cl = clients.lock().unwrap_or_else(|e| e.into_inner());
        if cl.is_empty() {
            continue;
        }
        let song = shared.song_mode.load(Relaxed);
        let pslot = shared.pattern_slot.load(Relaxed);
        let pattern_id = if song || pslot == NONE { None } else { n.patterns.iter().find(|(s, _)| *s == pslot).map(|(_, id)| id.as_str()) };
        let sr = shared.sample_rate.load(Relaxed).max(8000) as f32;
        let playing_now = shared.playing.load(Relaxed);
        let scopes = watcher.update(&shared.meters, &n.fx, sr as u32, playing_now && !was_playing, frame_no % 2 == 0);
        was_playing = playing_now;
        let frame = Frame {
            t: "frame",
            playing: shared.playing.load(Relaxed),
            tick: finite64(f64::from_bits(shared.tick.load(Relaxed))),
            sec: finite64(f64::from_bits(shared.sec.load(Relaxed))),
            bpm: finite64(f64::from_bits(shared.bpm.load(Relaxed))),
            mode: if song { "song" } else { "pattern" },
            pattern_id,
            clock_ms: t0.elapsed().as_secs_f64() * 1000.0,
            meters,
            channels,
            spectrum: if frame_no % 2 == 0 { Some(spectrum.compute(sr)) } else { None },
            cpu: finite(f32::from_bits(shared.cpu.load(Relaxed))).clamp(0.0, 1.0),
            xruns: shared.xruns.load(Relaxed),
            applied_version: shared.applied_version.load(Relaxed),
            midi_in: shared.live.midi_in.load(Relaxed),
            rec: match shared.live.state.load(Relaxed) {
                crate::record::STATE_COUNT_IN => Some("countIn"),
                crate::record::STATE_RECORDING => Some("recording"),
                _ => None,
            },
            count_in: Some(shared.live.count_in_beats.load(Relaxed)).filter(|_| shared.live.state.load(Relaxed) == crate::record::STATE_COUNT_IN),
            launcher: crate::launcher::telemetry(&shared.launch, &n.launch),
            sync: crate::clock::sync_telemetry(&shared.clock),
            input_peak: if shared.live.input_open.load(Relaxed) {
                Some([finite(f32::from_bits(shared.live.input_peak[0].swap(0, Relaxed))), finite(f32::from_bits(shared.live.input_peak[1].swap(0, Relaxed)))])
            } else {
                None
            },
            monitor_peak: if shared.live.monitor.load(Relaxed) { Some(finite(f32::from_bits(shared.live.monitor_peak.swap(0, Relaxed)))) } else { None },
            gr: crate::meters::collect_gr(&shared.meters, &n.fx),
            scopes,
        };
        let Ok(text) = serde_json::to_string(&frame) else { continue };
        cl.retain_mut(|ws| {
            let peer = ws.get_ref().peer_addr().map(|a| a.to_string()).unwrap_or_default();
            loop {
                match ws.read() {
                    Ok(Message::Text(t)) => {
                        watcher.on_message(&peer, t.as_str());
                    }
                    Ok(_) => continue,
                    Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => {
                        watcher.drop_client(&peer);
                        return false;
                    }
                }
            }
            match ws.write(Message::text(text.clone())) {
                Ok(()) => {}
                Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(tungstenite::Error::WriteBufferFull(_)) | Err(_) => {
                    watcher.drop_client(&peer);
                    return false;
                }
            }
            match ws.flush() {
                Ok(()) => true,
                Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock => true,
                Err(_) => {
                    watcher.drop_client(&peer);
                    false
                }
            }
        });
    }
}

fn finite(x: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

fn finite64(x: f64) -> f64 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spectrum_peaks_at_tone() {
        let mut s = Spectrum::new();
        let sr = 48000.0;
        for i in 0..FFT_SIZE {
            s.push((std::f32::consts::TAU * 1000.0 * i as f32 / sr).sin());
        }
        let bins = s.compute(sr);
        assert_eq!(bins.len(), SPECTRUM_BINS);
        let (imax, vmax) = bins.iter().enumerate().fold((0, -999f32), |a, (i, &v)| if v > a.1 { (i, v) } else { a });
        assert!((35..=37).contains(&imax), "peak bin {imax}");
        assert!(vmax > -3.0 && vmax < 1.0, "peak level {vmax}");
        assert!(bins[5] < -40.0);
    }

    #[test]
    fn token_check() {
        let req = Request::builder().uri("/?token=abc123").body(()).unwrap();
        assert!(token_ok(&req, "abc123"));
        assert!(!token_ok(&req, "abc124"));
        let req = Request::builder().uri("/").body(()).unwrap();
        assert!(!token_ok(&req, "abc123"));
    }
}
