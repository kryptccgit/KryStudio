use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::protocol::{AnalyzeArgs, Event, FingerprintArgs, HelloResult, Request, Response, SeparateArgs, SingArgs, SyllablesArgs, TranscribeArgs, TtsArgs, ExtractArgs};
use crate::{JobCtx, JobError};

pub const LIGHT_SLOTS: usize = 2;
pub const HEAVY_SLOTS: usize = 1;
pub const SHUTDOWN_GRACE: Duration = Duration::from_millis(1500);

pub type Sink = Arc<dyn Fn(String) + Send + Sync>;

pub enum Job {
    Analyze(AnalyzeArgs),
    Separate(SeparateArgs),
    Transcribe(TranscribeArgs),
    Fingerprint(FingerprintArgs),
    Tts(TtsArgs),
    Sing(SingArgs),
    Syllables(SyllablesArgs),
    Extract(ExtractArgs),
}

impl Job {
    pub fn name(&self) -> &'static str {
        match self {
            Job::Analyze(_) => "analyze",
            Job::Separate(_) => "separate",
            Job::Transcribe(_) => "transcribe",
            Job::Fingerprint(_) => "fingerprint",
            Job::Tts(_) => "tts",
            Job::Sing(_) => "sing",
            Job::Syllables(_) => "syllables",
            Job::Extract(_) => "extract",
        }
    }

    fn heavy(&self) -> bool {
        matches!(self, Job::Separate(_))
    }
}

pub trait Handler: Send + Sync + 'static {
    fn devices(&self) -> Vec<String>;
    fn run(&self, job: &Job, ctx: &JobCtx) -> Result<Value, JobError>;
}

pub struct Real;

fn to_value<T: serde::Serialize>(name: &str, r: Result<T, JobError>) -> Result<Value, JobError> {
    let v = r?;
    serde_json::to_value(v).map_err(|e| JobError::Failed(format!("Internal error in {name}: result could not be encoded ({e})")))
}

impl Handler for Real {
    fn devices(&self) -> Vec<String> {
        crate::separate::devices()
    }

    fn run(&self, job: &Job, ctx: &JobCtx) -> Result<Value, JobError> {
        match job {
            Job::Analyze(a) => to_value("analyze", crate::analyze::run(a, ctx)),
            Job::Separate(a) => to_value("separate", crate::separate::run(a, ctx)),
            Job::Transcribe(a) => to_value("transcribe", crate::transcribe::run(a, ctx)),
            Job::Fingerprint(a) => to_value("fingerprint", crate::fingerprint::run(a, ctx)),
            Job::Tts(a) => to_value("tts", crate::tts::run(a, ctx)),
            Job::Sing(a) => to_value("sing", crate::sing::run(a, ctx)),
            Job::Syllables(a) => to_value("syllables", crate::syllables::run(a, ctx)),
            Job::Extract(a) => to_value("extract", crate::wav::extract(a, ctx)),
        }
    }
}

struct Slots {
    cap: usize,
    used: Mutex<usize>,
    cv: Condvar,
}

impl Slots {
    fn new(cap: usize) -> Self {
        Self { cap, used: Mutex::new(0), cv: Condvar::new() }
    }

    fn acquire(&self, cancel: &AtomicBool) -> bool {
        let mut u = self.used.lock().unwrap_or_else(|p| p.into_inner());
        while *u >= self.cap {
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            u = self.cv.wait_timeout(u, Duration::from_millis(25)).unwrap_or_else(|p| p.into_inner()).0;
        }
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        *u += 1;
        true
    }

    fn release(&self) {
        let mut u = self.used.lock().unwrap_or_else(|p| p.into_inner());
        *u = u.saturating_sub(1);
        self.cv.notify_all();
    }
}

fn panic_message(p: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".into()
    }
}

struct Shared {
    sink: Sink,
    handler: Arc<dyn Handler>,
    jobs: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    light: Slots,
    heavy: Slots,
    hellos: AtomicUsize,
}

impl Shared {
    fn send<T: serde::Serialize>(&self, v: &T) {
        match serde_json::to_string(v) {
            Ok(s) => (self.sink)(s),
            Err(e) => eprintln!("analyzer: could not encode a protocol line: {e}"),
        }
    }

    fn jobs(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Arc<AtomicBool>>> {
        self.jobs.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn cancel_all_and_wait(&self) {
        for f in self.jobs().values() {
            f.store(true, Ordering::Relaxed);
        }
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while (!self.jobs().is_empty() || self.hellos.load(Ordering::SeqCst) > 0) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn response_from(id: u64, name: &str, r: thread::Result<Result<Value, JobError>>) -> Response {
    match r {
        Ok(Ok(v)) => Response { id, ok: true, data: Some(v), message: None, cancelled: false },
        Ok(Err(JobError::Cancelled)) => Response::cancelled(id),
        Ok(Err(JobError::Failed(m))) => Response::fail(id, m),
        Err(p) => Response::fail(id, format!("Internal error in {name}: {}", panic_message(&*p))),
    }
}

fn start_job(sh: &Arc<Shared>, id: u64, job: Job) {
    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = sh.jobs();
        if jobs.contains_key(&id) {
            drop(jobs);
            sh.send(&Response::fail(id, format!("Job id {id} is already running")));
            return;
        }
        jobs.insert(id, flag.clone());
    }
    let sh2 = sh.clone();
    let spawned = thread::Builder::new().name(format!("{}-{id}", job.name())).stack_size(16 << 20).spawn(move || {
        let sh = sh2;
        let name = job.name();
        let slots = if job.heavy() { &sh.heavy } else { &sh.light };
        let resp = if !slots.acquire(&flag) {
            Response::cancelled(id)
        } else {
            let emit_sh = sh.clone();
            let emit: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(move |e: Event| emit_sh.send(&e));
            let ctx = JobCtx::new(id, flag.clone(), emit);
            let r = catch_unwind(AssertUnwindSafe(|| sh.handler.run(&job, &ctx)));
            slots.release();
            response_from(id, name, r)
        };
        sh.jobs().remove(&id);
        sh.send(&resp);
    });
    if let Err(e) = spawned {
        sh.jobs().remove(&id);
        sh.send(&Response::fail(id, format!("Cannot start the job: {e}")));
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum End {
    Shutdown,
    Eof,
}

pub fn serve(lines: impl Iterator<Item = String>, sink: Sink, handler: Arc<dyn Handler>) -> End {
    let sh = Arc::new(Shared { sink, handler, jobs: Mutex::new(HashMap::new()), light: Slots::new(LIGHT_SLOTS), heavy: Slots::new(HEAVY_SLOTS), hellos: AtomicUsize::new(0) });
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                let id = serde_json::from_str::<Value>(line).ok().and_then(|v| v.get("id")?.as_u64()).unwrap_or(0);
                sh.send(&Response::fail(id, format!("Bad request: {e}")));
                continue;
            }
        };
        match req {
            Request::Hello { id } => {
                let sh2 = sh.clone();
                sh.hellos.fetch_add(1, Ordering::SeqCst);
                let spawned = thread::Builder::new().name("hello".into()).spawn(move || {
                    let r = catch_unwind(AssertUnwindSafe(|| sh2.handler.devices()));
                    let resp = match r {
                        Ok(devices) => Response::ok(id, HelloResult { version: env!("CARGO_PKG_VERSION").into(), devices }),
                        Err(p) => Response::fail(id, format!("Internal error in hello: {}", panic_message(&*p))),
                    };
                    sh2.send(&resp);
                    sh2.hellos.fetch_sub(1, Ordering::SeqCst);
                });
                if let Err(e) = spawned {
                    sh.hellos.fetch_sub(1, Ordering::SeqCst);
                    sh.send(&Response::fail(id, format!("Cannot answer hello: {e}")));
                }
            }
            Request::Cancel { id, args } => {
                let found = sh.jobs().get(&args.target).cloned();
                match found {
                    Some(flag) => {
                        flag.store(true, Ordering::Relaxed);
                        sh.light.cv.notify_all();
                        sh.heavy.cv.notify_all();
                        sh.send(&Response::ok(id, ()));
                    }
                    None => sh.send(&Response::fail(id, "No such job")),
                }
            }
            Request::Shutdown { id } => {
                sh.cancel_all_and_wait();
                sh.send(&Response::ok(id, ()));
                return End::Shutdown;
            }
            Request::Analyze { id, args } => start_job(&sh, id, Job::Analyze(args)),
            Request::Separate { id, args } => start_job(&sh, id, Job::Separate(args)),
            Request::Transcribe { id, args } => start_job(&sh, id, Job::Transcribe(args)),
            Request::Fingerprint { id, args } => start_job(&sh, id, Job::Fingerprint(args)),
            Request::Tts { id, args } => start_job(&sh, id, Job::Tts(args)),
            Request::Sing { id, args } => start_job(&sh, id, Job::Sing(args)),
            Request::Syllables { id, args } => start_job(&sh, id, Job::Syllables(args)),
            Request::Extract { id, args } => start_job(&sh, id, Job::Extract(args)),
        }
    }
    sh.cancel_all_and_wait();
    End::Eof
}

pub fn stdout_sink() -> Sink {
    use std::io::Write;
    let lock = Arc::new(Mutex::new(()));
    Arc::new(move |line: String| {
        let _g = lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut out = std::io::stdout().lock();
        let mut buf = line.into_bytes();
        buf.push(b'\n');
        if out.write_all(&buf).and_then(|_| out.flush()).is_err() {
        }
    })
}
