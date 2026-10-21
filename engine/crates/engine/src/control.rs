use crate::audio::{CoreCell, DeviceManager};
use crate::compile::{Names, SampleMode, Session};
use crate::core::{Cmd, Garbage, Preview, Shared};
use crate::model::{Model, Warnings};
use crate::plugins::{catalog_json, PluginHost};
use crate::protocol::{Out, RenderRequest, ENGINE_VERSION, PROTOCOL_VERSION};
use crate::render::{run_render, validate_request, RenderEnv};
use crate::samples::{probe_info, resolve_path, SampleCache};
use crate::telemetry::TelemetryInfo;
use crate::variants::{self, VariantJob, VariantKey, VariantOutcome};
use crossbeam_channel::{Receiver, Sender};
use krypt_studio_dsp::SampleData;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::BufRead;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering::*};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub enum Msg {
    Line(String),
    Eof,
    SampleLoaded(PathBuf),
    VariantDone(VariantKey, VariantOutcome),
    PreviewReady { id: Value, result: Result<Arc<SampleData>, String>, gain: f32 },
    RenderDone,
}

type Job = Box<dyn FnOnce() + Send>;

const VARIANT_WORKERS: usize = 2;

pub struct Engine {
    pub out: Arc<Out>,
    pub session: Session,
    cmd_tx: rtrb::Producer<Cmd>,
    backlog: VecDeque<Cmd>,
    garbage_rx: rtrb::Consumer<Garbage>,
    pub shared: Arc<Shared>,
    pub core: CoreCell,
    pub device: DeviceManager,
    pub telemetry: TelemetryInfo,
    pub names: Arc<Mutex<Names>>,
    host: PluginHost,
    cache: Arc<SampleCache>,
    factory_dir: PathBuf,
    packs_dir: Option<PathBuf>,
    playing: bool,
    render_cancel: Option<Arc<AtomicBool>>,
    internal_tx: Sender<Msg>,
    rx: Receiver<Msg>,
    jobs: Sender<Job>,
    samples_dirty: bool,
    last_stretch_pending: Vec<String>,
    last_applied: u64,
    last_xruns: u32,
    last_xrun_emit: Instant,
    last_latency_check: Instant,
    last_prune: Instant,
    fault_reported: bool,
    leak_reported: u32,
    pub live: crate::record_ctl::LiveControl,
    launcher: crate::launcher::LauncherCtl,
    hardware: crate::hardware_ctl::HardwareCtl,
}

pub struct EngineParts {
    pub out: Arc<Out>,
    pub host: PluginHost,
    pub cache: Arc<SampleCache>,
    pub factory_dir: PathBuf,
    pub packs_dir: Option<PathBuf>,
    pub shared: Arc<Shared>,
    pub core: CoreCell,
    pub cmd_tx: rtrb::Producer<Cmd>,
    pub garbage_rx: rtrb::Consumer<Garbage>,
    pub device: DeviceManager,
    pub telemetry: TelemetryInfo,
    pub names: Arc<Mutex<Names>>,
    pub live: crate::record::LiveCtlEnds,
}

impl Engine {
    pub fn new(p: EngineParts) -> Engine {
        let (internal_tx, rx) = crossbeam_channel::unbounded::<Msg>();
        let (loader_tx, loader_rx) = crossbeam_channel::unbounded::<PathBuf>();
        {
            let cache = p.cache.clone();
            let tx = internal_tx.clone();
            let _ = std::thread::Builder::new().name("sample-loader".into()).spawn(move || {
                while let Ok(path) = loader_rx.recv() {
                    cache.preload(&path);
                    let _ = tx.send(Msg::SampleLoaded(path));
                }
            });
        }
        let (jobs, jobs_rx) = crossbeam_channel::unbounded::<Job>();
        for i in 0..2 {
            let jr = jobs_rx.clone();
            let _ = std::thread::Builder::new().name(format!("worker-{i}")).spawn(move || {
                while let Ok(job) = jr.recv() {
                    let _ = std::panic::catch_unwind(AssertUnwindSafe(job));
                }
            });
        }
        let (variant_tx, variant_rx) = crossbeam_channel::unbounded::<VariantJob>();
        for i in 0..VARIANT_WORKERS {
            let rx = variant_rx.clone();
            let cache = p.cache.clone();
            let tx = internal_tx.clone();
            let _ = std::thread::Builder::new().name(format!("stretch-{i}")).spawn(move || {
                while let Ok(job) = rx.recv() {
                    let outcome = variants::run_job(&cache.variants, &job);
                    if tx.send(Msg::VariantDone(job.key, outcome)).is_err() {
                        return;
                    }
                }
            });
        }
        let sr = p.shared.sample_rate.load(Relaxed) as f32;
        let launcher = crate::launcher::LauncherCtl::new(&p.shared.launch, Some(p.live.sink.clone()));
        let hardware = crate::hardware_ctl::HardwareCtl::new(p.shared.clock.clone(), p.live.sink.clone());
        let live = crate::record_ctl::LiveControl::new(p.live, p.out.clone());
        let mut session = Session::new(p.host, sr, p.cache.clone(), p.factory_dir.clone(), SampleMode::Async(loader_tx));
        session.variant_tx = Some(variant_tx);
        session.packs_dir = p.packs_dir.clone();
        Engine {
            out: p.out,
            session,
            cmd_tx: p.cmd_tx,
            backlog: VecDeque::new(),
            garbage_rx: p.garbage_rx,
            shared: p.shared,
            core: p.core,
            device: p.device,
            telemetry: p.telemetry,
            names: p.names,
            host: p.host,
            cache: p.cache,
            factory_dir: p.factory_dir,
            packs_dir: p.packs_dir,
            playing: false,
            render_cancel: None,
            internal_tx,
            rx,
            jobs,
            samples_dirty: false,
            last_stretch_pending: Vec::new(),
            last_applied: 0,
            last_xruns: 0,
            last_xrun_emit: Instant::now(),
            last_latency_check: Instant::now(),
            last_prune: Instant::now(),
            fault_reported: false,
            leak_reported: 0,
            live,
            launcher,
            hardware,
        }
    }

    pub fn run(mut self) {
        let tx = self.internal_tx.clone();
        let _ = std::thread::Builder::new().name("stdin".into()).spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                match line {
                    Ok(l) => {
                        if tx.send(Msg::Line(l)).is_err() {
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(Msg::Eof);
        });
        loop {
            match self.rx.recv_timeout(Duration::from_millis(10)) {
                Ok(Msg::Line(l)) => {
                    let l = l.trim().to_string();
                    if !l.is_empty() {
                        self.handle_line(&l);
                    }
                }
                Ok(Msg::Eof) => {
                    eprintln!("[engine] stdin closed; exiting");
                    self.live.shutdown();
                    self.hardware.shutdown();
                    self.device.shutdown();
                    return;
                }
                Ok(Msg::SampleLoaded(p)) => {
                    self.session.sample_loaded(&p);
                    self.samples_dirty = true;
                }
                Ok(Msg::VariantDone(key, outcome)) => {
                    self.session.variant_done(&key);
                    match outcome {
                        VariantOutcome::Ready(secs) => {
                            if secs > 0.0 {
                                self.out.log("info", format!("Time-stretched {} in {secs:.2} s", key.describe()));
                            }
                            self.samples_dirty = true;
                        }
                        VariantOutcome::Failed(_) => self.samples_dirty = true,
                        VariantOutcome::Cancelled => {}
                    }
                }
                Ok(Msg::PreviewReady { id, result, gain }) => match result {
                    Ok(data) => {
                        let dur = data.frames() as f64 / data.sample_rate.max(1.0) as f64;
                        self.push(Cmd::Preview(Some(Box::new(Preview { data, pos: 0.0, gain }))));
                        self.out.ok(&id, json!({ "durationSec": dur }));
                    }
                    Err(e) => self.out.err(&id, e),
                },
                Ok(Msg::RenderDone) => self.render_cancel = None,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return,
            }
            self.tick();
        }
    }

    fn launch_push(&mut self, c: crate::launcher::LaunchCmd) {
        if matches!(c, crate::launcher::LaunchCmd::Launch { release: false, .. } | crate::launcher::LaunchCmd::Scene(_)) {
            self.playing = true;
        }
        self.push(Cmd::Launcher(c));
    }

    fn push(&mut self, c: Cmd) {
        if !self.backlog.is_empty() {
            self.backlog.push_back(c);
            return;
        }
        if let Err(rtrb::PushError::Full(c)) = self.cmd_tx.push(c) {
            self.backlog.push_back(c);
        }
    }

    fn rebuild(&mut self, reset: bool) {
        self.session.sr = self.shared.sample_rate.load(Relaxed).max(8000) as f32;
        let b = self.session.build(reset);
        *self.names.lock().unwrap_or_else(|e| e.into_inner()) = self.session.names.clone();
        self.flush_session_logs();
        self.push(Cmd::Batch(b));
        if self.session.stretch_pending != self.last_stretch_pending {
            self.last_stretch_pending = self.session.stretch_pending.clone();
            let channels = &self.last_stretch_pending;
            self.out.event(json!({ "event": "stretch", "pending": channels.len(), "channels": channels }));
        }
    }

    fn flush_session_logs(&mut self) {
        for (level, msg) in self.session.logs.drain(..) {
            self.out.log(level, msg);
        }
    }

    fn tick(&mut self) {
        while let Ok(g) = self.garbage_rx.pop() {
            drop(g);
        }
        self.live.tick(&self.session);
        for c in self.launcher.tick(&self.session, &self.out) {
            self.launch_push(c);
        }
        if let Some(p) = self.hardware.tick(&self.session, &self.shared, &self.out) {
            self.playing = p;
        }
        while let Some(c) = self.backlog.pop_front() {
            if let Err(rtrb::PushError::Full(c)) = self.cmd_tx.push(c) {
                self.backlog.push_front(c);
                break;
            }
        }
        let v = self.shared.applied_version.load(Acquire);
        if v != self.last_applied {
            self.last_applied = v;
            self.out.event(json!({ "event": "applied", "version": v }));
        }
        let x = self.shared.xruns.load(Relaxed);
        if x != self.last_xruns && self.last_xrun_emit.elapsed() >= Duration::from_millis(500) {
            self.last_xruns = x;
            self.last_xrun_emit = Instant::now();
            self.out.event(json!({ "event": "xrun", "count": x }));
        }
        if self.shared.faulted.load(Acquire) {
            if !self.fault_reported {
                self.fault_reported = true;
                self.out.log("error", "A plugin crashed on the audio thread; output is muted. Reload the project to recover.");
            }
        } else {
            self.fault_reported = false;
        }
        let leaked = self.shared.garbage_leaked.load(Relaxed);
        if leaked != self.leak_reported {
            self.leak_reported = leaked;
            self.out.log("warn", format!("Retire queue overflowed ({leaked} objects leaked)"));
        }
        if self.samples_dirty {
            self.samples_dirty = false;
            self.rebuild(false);
        }
        for e in krypt_studio_pluginclient::drain_events() {
            match e.get("event").and_then(|x| x.as_str()) {
                Some("log") => self.out.log(e.get("level").and_then(|x| x.as_str()).unwrap_or("info"), e.get("message").and_then(|x| x.as_str()).unwrap_or("")),
                _ => self.out.event(e),
            }
        }
        if krypt_studio_pluginclient::take_reload_request() {
            self.session.forget_plugins(true);
            self.rebuild(false);
        } else if krypt_studio_pluginclient::take_retry_request() && !self.session.model.master_id.is_empty() {
            self.session.forget_plugins(false);
            self.rebuild(false);
        }
        if self.last_prune.elapsed() >= Duration::from_secs(10) && self.render_cancel.is_none() {
            self.last_prune = Instant::now();
            self.cache.prune(&self.session.referenced_samples());
        }
        for (level, msg) in self.cache.variants.drain_logs() {
            self.out.log(level, msg);
        }
        if self.last_latency_check.elapsed() >= Duration::from_millis(250) {
            self.last_latency_check = Instant::now();
            if self.session.refresh_latencies(&self.shared) {
                self.rebuild(false);
            }
        }
    }

    fn handle_line(&mut self, line: &str) {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                self.out.err(&Value::Null, format!("Invalid JSON request: {e}"));
                return;
            }
        };
        let id = v.get("id").cloned().unwrap_or(Value::Null);
        let Some(cmd) = v.get("cmd").and_then(|c| c.as_str()).map(String::from) else {
            self.out.err(&id, "Request has no 'cmd'");
            return;
        };
        let res = std::panic::catch_unwind(AssertUnwindSafe(|| self.dispatch(&id, &cmd, &v)));
        if res.is_err() {
            self.out.err(&id, format!("Internal engine error while handling '{cmd}'"));
        }
    }

    fn path_param(&self, v: &Value) -> Option<Result<(String, PathBuf), String>> {
        let p = v.get("path")?.as_str()?.to_string();
        Some(resolve_path(&p, &self.factory_dir, self.packs_dir.as_deref(), None).map(|resolved| (p, resolved)))
    }

    fn spawn_job(&self, job: Job) {
        let _ = self.jobs.send(job);
    }

    fn dispatch(&mut self, id: &Value, cmd: &str, v: &Value) {
        match cmd {
            "hello" => {
                let proto = v.get("protocol").and_then(|p| p.as_u64()).unwrap_or(0);
                if proto != PROTOCOL_VERSION as u64 {
                    self.out.err(id, format!("Protocol mismatch: engine speaks v{PROTOCOL_VERSION}, client sent v{proto}"));
                    return;
                }
                let device = self.device.status();
                self.out.ok(
                    id,
                    json!({
                        "engineVersion": ENGINE_VERSION,
                        "protocol": PROTOCOL_VERSION,
                        "telemetry": { "port": self.telemetry.port, "token": self.telemetry.token },
                        "device": device,
                    }),
                );
            }
            "ping" => self.out.ok(id, json!({})),
            "listDevices" => match self.device.list() {
                Ok(d) => self.out.ok(id, json!(d)),
                Err(e) => self.out.err(id, e),
            },
            "openDevice" => {
                let dev = v.get("deviceId").and_then(|x| x.as_str()).map(String::from);
                let buf = v.get("bufferFrames").and_then(|x| x.as_u64()).map(|x| x.clamp(16, 16384) as u32);
                let sr = v.get("sampleRate").and_then(|x| x.as_f64()).map(|x| x.round() as u32);
                match self.device.open(dev, buf, sr) {
                    Ok(s) => {
                        self.session.sr = self.shared.sample_rate.load(Relaxed).max(8000) as f32;
                        self.out.ok(id, json!(s))
                    }
                    Err(e) => self.out.err(id, e),
                }
            }
            "loadProject" => {
                let version = v.get("version").and_then(|x| x.as_u64()).unwrap_or(0);
                let Some(project) = v.get("project").filter(|p| p.is_object()) else {
                    self.out.err(id, "loadProject needs a 'project' object");
                    return;
                };
                let mut w = Warnings::default();
                let model = Model::from_project(project, &mut w);
                self.session.take_warnings(&mut w);
                if self.shared.faulted.load(Acquire) {
                    self.session.forget_instances();
                }
                self.session.model = model;
                self.session.version = version;
                self.playing = false;
                self.rebuild(true);
                self.out.ok(id, json!({ "version": version }));
            }
            "apply" => {
                let version = v.get("version").and_then(|x| x.as_u64()).unwrap_or(self.session.version);
                let mut w = Warnings::default();
                if let Some(ups) = v.get("upserts").and_then(|x| x.as_array()) {
                    for u in ups {
                        let kind = u.get("kind").and_then(|x| x.as_str()).unwrap_or("");
                        let eid = u.get("id").and_then(|x| x.as_str()).unwrap_or("");
                        let value = u.get("value").unwrap_or(&Value::Null);
                        self.session.model.upsert_entity(kind, eid, value, &mut w);
                    }
                }
                if let Some(dels) = v.get("deletes").and_then(|x| x.as_array()) {
                    for d in dels {
                        let kind = d.get("kind").and_then(|x| x.as_str()).unwrap_or("");
                        let Some(eid) = d.get("id").and_then(|x| x.as_str()) else { continue };
                        self.session.model.delete_entity(kind, eid, &mut w);
                    }
                }
                self.session.take_warnings(&mut w);
                self.session.version = version;
                self.rebuild(false);
                self.out.ok(id, json!({ "version": version }));
            }
            "transport" => {
                let action = v.get("action").and_then(|x| x.as_str()).unwrap_or("");
                let c = match action {
                    "play" => {
                        self.playing = true;
                        Cmd::Play
                    }
                    "stop" => {
                        self.playing = false;
                        Cmd::Stop
                    }
                    "pause" => {
                        self.playing = false;
                        Cmd::Pause
                    }
                    "toggle" => {
                        self.playing = !self.playing;
                        if self.playing {
                            Cmd::Play
                        } else {
                            Cmd::Stop
                        }
                    }
                    other => {
                        self.out.err(id, format!("Unknown transport action '{other}' (play, stop, pause, toggle)"));
                        return;
                    }
                };
                self.push(c);
                self.out.ok(id, json!({ "playing": self.playing }));
            }
            "locate" => match v.get("tick").and_then(|x| x.as_f64()).filter(|t| t.is_finite()) {
                Some(t) => {
                    self.push(Cmd::Locate(t.max(0.0)));
                    self.out.ok(id, json!({}));
                }
                None => self.out.err(id, "locate needs a numeric 'tick'"),
            },
            "audition" => {
                let ch = v.get("channelId").and_then(|x| x.as_str()).unwrap_or("");
                let Some(slot) = self.session.channel_slot(ch).filter(|_| self.session.model.channels.contains_key(ch)) else {
                    self.out.err(id, format!("Unknown channel '{ch}'"));
                    return;
                };
                let key = v.get("key").and_then(|x| x.as_f64()).unwrap_or(60.0).round().clamp(0.0, 127.0) as u8;
                let vel = v.get("vel").and_then(|x| x.as_f64()).unwrap_or(0.78).clamp(0.0, 1.0) as f32;
                let on = v.get("on").and_then(|x| x.as_bool()).unwrap_or(true);
                self.push(if on { Cmd::NoteOn { slot, key, vel } } else { Cmd::NoteOff { slot, key } });
                self.out.ok(id, json!({}));
            }
            "auditionOff" => {
                self.push(Cmd::AuditionOff);
                self.out.ok(id, json!({}));
            }
            "previewFile" => {
                let (_, path) = match self.path_param(v) {
                    Some(Ok(x)) => x,
                    Some(Err(e)) => {
                        self.out.err(id, e);
                        return;
                    }
                    None => {
                        self.out.err(id, "previewFile needs a 'path'");
                        return;
                    }
                };
                let gain = v.get("gain").and_then(|x| x.as_f64()).unwrap_or(1.0).clamp(0.0, 4.0) as f32;
                let cache = self.cache.clone();
                let tx = self.internal_tx.clone();
                let id = id.clone();
                self.spawn_job(Box::new(move || {
                    let result = cache.get_or_decode(&path);
                    let _ = tx.send(Msg::PreviewReady { id, result, gain });
                }));
            }
            "stopPreview" => {
                self.push(Cmd::Preview(None));
                self.out.ok(id, json!({}));
            }
            "render" => {
                if self.render_cancel.is_some() {
                    self.out.err(id, "A render is already running");
                    return;
                }
                let job: RenderRequest = match v.get("job").map(|j| serde_json::from_value::<RenderRequest>(j.clone())) {
                    Some(Ok(j)) => j,
                    Some(Err(e)) => {
                        self.out.err(id, format!("Invalid render job: {e}"));
                        return;
                    }
                    None => {
                        self.out.err(id, "render needs a 'job'");
                        return;
                    }
                };
                if let Err(e) = validate_request(&job) {
                    self.out.err(id, e);
                    return;
                }
                let cancel = Arc::new(AtomicBool::new(false));
                self.render_cancel = Some(cancel.clone());
                let model = self.session.model.clone();
                let host = self.host;
                let cache = self.cache.clone();
                let factory_dir = self.factory_dir.clone();
                let packs_dir = self.packs_dir.clone();
                let out = self.out.clone();
                let tx = self.internal_tx.clone();
                let default_sr = self.shared.sample_rate.load(Relaxed).max(8000) as f64;
                let job_id = id.clone();
                let spawned = std::thread::Builder::new().name("render".into()).spawn(move || {
                    let out2 = out.clone();
                    let out3 = out.clone();
                    let mut progress = move |p: f64| out2.event(json!({ "event": "renderProgress", "progress": p }));
                    let mut log = move |level: &str, m: String| out3.log(level, m);
                    let mut env = RenderEnv {
                        host,
                        cache,
                        factory_dir,
                        packs_dir,
                        base_dir: None,
                        cancel,
                        default_sr,
                        progress: &mut progress,
                        log: &mut log,
                    };
                    let res = std::panic::catch_unwind(AssertUnwindSafe(|| run_render(&model, &job, &mut env)));
                    match res {
                        Ok(Ok(r)) => out.ok(&job_id, json!(r)),
                        Ok(Err(e)) => out.err(&job_id, e),
                        Err(_) => out.err(&job_id, "The render crashed (a plugin panicked)"),
                    }
                    let _ = tx.send(Msg::RenderDone);
                });
                if let Err(e) = spawned {
                    self.render_cancel = None;
                    self.out.err(id, format!("Couldn't start the render: {e}"));
                }
            }
            "cancelRender" => {
                if let Some(c) = &self.render_cancel {
                    c.store(true, Relaxed);
                }
                self.out.ok(id, json!({}));
            }
            "analyzeFile" => {
                let (_, path) = match self.path_param(v) {
                    Some(Ok(x)) => x,
                    Some(Err(e)) => {
                        self.out.err(id, e);
                        return;
                    }
                    None => {
                        self.out.err(id, "analyzeFile needs a 'path'");
                        return;
                    }
                };
                let cache = self.cache.clone();
                let out = self.out.clone();
                let id = id.clone();
                self.spawn_job(Box::new(move || match cache.get_or_decode(&path) {
                    Ok(d) => {
                        let l = d.channels.first().cloned().unwrap_or_default();
                        let r = d.channels.get(1).cloned().unwrap_or_else(|| l.clone());
                        let a = krypt_studio_dsp::analysis::analyze(&l, &r, d.sample_rate);
                        out.ok(&id, serde_json::to_value(&a).unwrap_or(Value::Null));
                    }
                    Err(e) => out.err(&id, e),
                }));
            }
            "sampleInfo" => {
                let (display, path) = match self.path_param(v) {
                    Some(Ok(x)) => x,
                    Some(Err(e)) => {
                        self.out.err(id, e);
                        return;
                    }
                    None => {
                        self.out.err(id, "sampleInfo needs a 'path'");
                        return;
                    }
                };
                let out = self.out.clone();
                let id = id.clone();
                self.spawn_job(Box::new(move || match probe_info(&path, &display) {
                    Ok(i) => out.ok(&id, json!(i)),
                    Err(e) => out.err(&id, e),
                }));
            }
            "peaks" => {
                let (_, path) = match self.path_param(v) {
                    Some(Ok(x)) => x,
                    Some(Err(e)) => {
                        self.out.err(id, e);
                        return;
                    }
                    None => {
                        self.out.err(id, "peaks needs a 'path'");
                        return;
                    }
                };
                let buckets = v.get("buckets").and_then(|x| x.as_u64()).unwrap_or(512).clamp(1, 1_000_000) as usize;
                let cache = self.cache.clone();
                let out = self.out.clone();
                let id = id.clone();
                self.spawn_job(Box::new(move || match cache.peaks(&path, buckets) {
                    Ok(p) => out.ok(&id, json!(*p)),
                    Err(e) => out.err(&id, e),
                }));
            }
            "catalog" => self.out.ok(id, catalog_json(&self.host)),
            other if other.starts_with("plugins.") => {
                let out = self.out.clone();
                let id = id.clone();
                krypt_studio_pluginclient::handle_command(
                    other,
                    v,
                    Box::new(move |r| match r {
                        Ok(d) => out.ok(&id, d),
                        Err(m) => out.err(&id, m),
                    }),
                );
            }
            "shutdown" => {
                self.out.ok(id, json!({}));
                self.live.shutdown();
                self.hardware.shutdown();
                self.device.shutdown();
                std::process::exit(0);
            }
            "launch" | "launchScene" | "launchStop" | "backToArrangement" | "setLaunchRecord" | "setLaunchGrid" => {
                match self.launcher.command(cmd, v, &self.session) {
                    Some(Ok((data, cmds))) => {
                        for c in cmds {
                            self.launch_push(c);
                        }
                        self.out.ok(id, data)
                    }
                    Some(Err(e)) => self.out.err(id, e),
                    None => self.out.err(id, format!("Unknown command '{cmd}'")),
                }
            }
            "listMidiOutputs" | "setMidiOutputs" | "setMidiClock" | "midiSend" | "setMidiSync" => match self.hardware.dispatch(cmd, v) {
                Some(Ok(data)) => self.out.ok(id, data),
                Some(Err(e)) => self.out.err(id, e),
                None => self.out.err(id, format!("Unknown command '{cmd}'")),
            },
            other => match self.live.dispatch(other, v, &self.session) {
                Some(Ok(data)) => self.out.ok(id, data),
                Some(Err(e)) => self.out.err(id, e),
                None => self.out.err(id, format!("Unknown command '{other}'")),
            },
        }
    }
}
