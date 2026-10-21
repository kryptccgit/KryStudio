use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use krypt_studio_analyzer::runner::{serve, End, Handler, Job, Sink};
use krypt_studio_analyzer::{JobCtx, JobError};
use serde_json::{json, Value};

#[derive(Default)]
struct Fake {
    light_now: AtomicUsize,
    light_max: AtomicUsize,
    heavy_now: AtomicUsize,
    heavy_max: AtomicUsize,
}

impl Handler for Fake {
    fn devices(&self) -> Vec<String> {
        thread::sleep(Duration::from_millis(100));
        vec!["cpu".into()]
    }

    fn run(&self, job: &Job, ctx: &JobCtx) -> Result<Value, JobError> {
        let (path, heavy) = match job {
            Job::Analyze(a) => (a.path.clone(), false),
            Job::Transcribe(a) => (a.path.clone(), false),
            Job::Separate(a) => (a.path.clone(), true),
            Job::Fingerprint(a) => (a.path.clone(), false),
            Job::Tts(a) => (a.text.clone(), false),
            Job::Sing(a) => (a.path.clone(), false),
            Job::Syllables(a) => (a.path.clone(), false),
            Job::Extract(a) => (a.path.clone(), false),
        };
        let (now, max) = if heavy { (&self.heavy_now, &self.heavy_max) } else { (&self.light_now, &self.light_max) };
        let c = now.fetch_add(1, Ordering::SeqCst) + 1;
        max.fetch_max(c, Ordering::SeqCst);
        struct Dec<'a>(&'a AtomicUsize);
        impl Drop for Dec<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let _d = Dec(now);
        if path == "panic" {
            panic!("boom");
        }
        if path == "fail" {
            return Err(JobError::Failed("Cannot open fail.wav: the file does not exist".into()));
        }
        let ms: u64 = path.strip_prefix("sleep:").and_then(|v| v.parse().ok()).unwrap_or(0);
        let t = Instant::now();
        while t.elapsed() < Duration::from_millis(ms) {
            ctx.check()?;
            ctx.progress("analyzing", t.elapsed().as_millis() as f32 / ms as f32);
            thread::sleep(Duration::from_millis(5));
        }
        Ok(json!({ "slept": ms }))
    }
}

struct Harness {
    tx: Option<Sender<String>>,
    rx: Receiver<String>,
    done: thread::JoinHandle<End>,
    fake: Arc<Fake>,
    lines: Arc<Mutex<Vec<String>>>,
    pending: Mutex<std::collections::HashMap<u64, Value>>,
}

impl Harness {
    fn new() -> Self {
        let (tx, in_rx) = channel::<String>();
        let (out_tx, rx) = channel::<String>();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let l2 = lines.clone();
        let out_tx = Mutex::new(out_tx);
        let sink: Sink = Arc::new(move |line: String| {
            l2.lock().unwrap().push(line.clone());
            let _ = out_tx.lock().unwrap().send(line);
        });
        let fake = Arc::new(Fake::default());
        let f2: Arc<dyn Handler> = fake.clone();
        let done = thread::spawn(move || serve(in_rx.into_iter(), sink, f2));
        Harness { tx: Some(tx), rx, done, fake, lines, pending: Mutex::new(Default::default()) }
    }

    fn send(&self, v: Value) {
        self.tx.as_ref().unwrap().send(v.to_string()).unwrap();
    }

    fn send_raw(&self, s: &str) {
        self.tx.as_ref().unwrap().send(s.to_string()).unwrap();
    }

    fn response(&self, id: u64, timeout: Duration) -> Value {
        if let Some(v) = self.pending.lock().unwrap().remove(&id) {
            return v;
        }
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = self.rx.recv_timeout(left).unwrap_or_else(|_| panic!("no response for id {id} within {timeout:?}; lines: {:?}", self.lines.lock().unwrap()));
            let v: Value = serde_json::from_str(&line).unwrap_or_else(|e| panic!("not JSON: {line} ({e})"));
            if v.get("event").is_some() {
                continue;
            }
            let got = v["id"].as_u64().unwrap();
            if got == id {
                return v;
            }
            self.pending.lock().unwrap().entry(got).or_insert(v);
        }
    }
}

fn analyze(id: u64, path: &str) -> Value {
    json!({"id": id, "cmd": "analyze", "args": {"path": path}})
}

#[test]
fn hello_is_immediate_while_jobs_run() {
    let h = Harness::new();
    h.send(analyze(1, "sleep:800"));
    h.send(analyze(2, "sleep:800"));
    h.send(analyze(3, "sleep:800"));
    let t = Instant::now();
    h.send(json!({"id": 4, "cmd": "hello"}));
    let r = h.response(4, Duration::from_millis(500));
    assert!(t.elapsed() < Duration::from_millis(300), "hello took {:?}", t.elapsed());
    assert_eq!(r["ok"], json!(true));
    assert_eq!(r["data"]["devices"], json!(["cpu"]));
    assert!(r["data"]["version"].is_string());
    h.send(json!({"id": 5, "cmd": "shutdown"}));
    for id in [1, 2, 3] {
        assert_eq!(h.response(id, Duration::from_secs(2))["cancelled"], json!(true));
    }
    assert_eq!(h.response(5, Duration::from_secs(3))["ok"], json!(true));
    assert_eq!(h.done.join().unwrap(), End::Shutdown);
}

#[test]
fn two_light_jobs_in_parallel_and_separate_serialised() {
    let h = Harness::new();
    let t = Instant::now();
    h.send(analyze(1, "sleep:300"));
    h.send(json!({"id": 2, "cmd": "transcribe", "args": {"path": "sleep:300", "mode": "mono"}}));
    h.send(analyze(3, "sleep:300"));
    let sep = |id: u64| json!({"id": id, "cmd": "separate", "args": {"path": "sleep:200", "model": "htdemucs", "modelDir": "x", "outDir": "y"}});
    h.send(sep(4));
    h.send(sep(5));
    for id in 1..=5 {
        let r = h.response(id, Duration::from_secs(5));
        assert_eq!(r["ok"], json!(true), "{r}");
    }
    let el = t.elapsed();
    assert_eq!(h.fake.light_max.load(Ordering::SeqCst), 2, "light jobs must run 2 at a time");
    assert_eq!(h.fake.heavy_max.load(Ordering::SeqCst), 1, "separate must be serialised");
    assert!(el < Duration::from_millis(850), "took {el:?}");
    drop(h.tx);
    assert_eq!(h.done.join().unwrap(), End::Eof);
}

#[test]
fn cancel_running_queued_unknown_and_finished() {
    let mut h = Harness::new();
    h.send(analyze(1, "sleep:5000"));
    h.send(analyze(2, "sleep:5000"));
    h.send(analyze(3, "sleep:5000"));
    thread::sleep(Duration::from_millis(100));
    let t = Instant::now();
    h.send(json!({"id": 10, "cmd": "cancel", "args": {"target": 1}}));
    assert_eq!(h.response(10, Duration::from_millis(500))["ok"], json!(true));
    let r = h.response(1, Duration::from_secs(1));
    assert_eq!(r["ok"], json!(false));
    assert_eq!(r["cancelled"], json!(true));
    assert_eq!(r["message"], json!("Cancelled"));
    assert!(t.elapsed() < Duration::from_millis(500));
    h.send(json!({"id": 11, "cmd": "cancel", "args": {"target": 3}}));
    h.send(json!({"id": 12, "cmd": "cancel", "args": {"target": 2}}));
    assert_eq!(h.response(3, Duration::from_secs(1))["cancelled"], json!(true));
    assert_eq!(h.response(2, Duration::from_secs(1))["cancelled"], json!(true));
    h.send(json!({"id": 13, "cmd": "cancel", "args": {"target": 999}}));
    let r = h.response(13, Duration::from_millis(500));
    assert_eq!(r["ok"], json!(false));
    assert_eq!(r["message"], json!("No such job"));
    h.send(json!({"id": 14, "cmd": "cancel", "args": {"target": 1}}));
    assert_eq!(h.response(14, Duration::from_millis(500))["message"], json!("No such job"));
    h.send(analyze(20, "sleep:3000"));
    h.send(analyze(21, "sleep:3000"));
    h.send(analyze(22, "sleep:3000"));
    thread::sleep(Duration::from_millis(50));
    h.send(json!({"id": 23, "cmd": "cancel", "args": {"target": 22}}));
    let t = Instant::now();
    assert_eq!(h.response(22, Duration::from_secs(1))["cancelled"], json!(true));
    assert!(t.elapsed() < Duration::from_millis(300));
    h.tx.take();
    assert_eq!(h.done.join().unwrap(), End::Eof);
}

#[test]
fn errors_bad_requests_and_panics() {
    let h = Harness::new();
    h.send(analyze(1, "fail"));
    let r = h.response(1, Duration::from_secs(1));
    assert_eq!(r["ok"], json!(false));
    assert!(r["message"].as_str().unwrap().contains("fail.wav"));
    assert!(r.get("cancelled").is_none());
    h.send(analyze(2, "panic"));
    let r = h.response(2, Duration::from_secs(1));
    assert_eq!(r["ok"], json!(false));
    assert_eq!(r["message"], json!("Internal error in analyze: boom"));
    h.send(analyze(3, "sleep:10"));
    assert_eq!(h.response(3, Duration::from_secs(1))["ok"], json!(true));
    h.send(json!({"id": 4, "cmd": "frobnicate"}));
    let r = h.response(4, Duration::from_secs(1));
    assert_eq!(r["ok"], json!(false));
    assert!(r["message"].as_str().unwrap().starts_with("Bad request"));
    h.send(json!({"id": 5, "cmd": "analyze", "args": {}}));
    assert!(h.response(5, Duration::from_secs(1))["message"].as_str().unwrap().contains("path"));
    h.send(json!({"id": 6, "cmd": "transcribe", "args": {"path": "x", "mode": "kazoo"}}));
    assert_eq!(h.response(6, Duration::from_secs(1))["ok"], json!(false));
    h.send_raw("{not json");
    assert!(h.response(0, Duration::from_secs(1))["message"].as_str().unwrap().starts_with("Bad request"));
    h.send_raw("   ");
    h.send(analyze(7, "sleep:300"));
    h.send(analyze(7, "sleep:300"));
    let r = h.response(7, Duration::from_secs(1));
    assert_eq!(r["message"], json!("Job id 7 is already running"));
    assert_eq!(h.response(7, Duration::from_secs(2))["ok"], json!(true));
    h.send(json!({"id": 8, "cmd": "shutdown"}));
    assert_eq!(h.response(8, Duration::from_secs(2))["ok"], json!(true));
    assert_eq!(h.done.join().unwrap(), End::Shutdown);
}

#[test]
fn lines_are_whole_json_objects_and_events_carry_ids() {
    let h = Harness::new();
    for id in 1..=6 {
        h.send(analyze(id, "sleep:150"));
    }
    for id in 1..=6 {
        h.response(id, Duration::from_secs(3));
    }
    h.send(json!({"id": 9, "cmd": "shutdown"}));
    h.response(9, Duration::from_secs(2));
    h.done.join().unwrap();
    let lines = h.lines.lock().unwrap();
    let mut progress = 0;
    let mut responses = std::collections::HashMap::new();
    for l in lines.iter() {
        assert!(!l.contains('\n'), "embedded newline: {l}");
        let v: Value = serde_json::from_str(l).unwrap_or_else(|e| panic!("bad line {l}: {e}"));
        if v["event"] == json!("progress") {
            progress += 1;
            let id = v["id"].as_u64().unwrap();
            assert!((1..=6).contains(&id));
            assert_eq!(v["stage"], json!("analyzing"));
            let f = v["fraction"].as_f64().unwrap();
            assert!((0.0..=1.0).contains(&f) || f == -1.0);
        } else {
            *responses.entry(v["id"].as_u64().unwrap()).or_insert(0) += 1;
        }
    }
    assert!(progress > 10);
    for id in [1, 2, 3, 4, 5, 6, 9] {
        assert_eq!(responses.get(&id), Some(&1), "id {id}");
    }
}

#[test]
fn shutdown_right_after_hello_still_answers_hello() {
    let h = Harness::new();
    h.send(json!({"id": 1, "cmd": "hello"}));
    h.send(json!({"id": 2, "cmd": "shutdown"}));
    assert_eq!(h.done.join().unwrap(), End::Shutdown);
    let lines = h.lines.lock().unwrap();
    let ids: Vec<u64> = lines.iter().map(|l| serde_json::from_str::<Value>(l).unwrap()["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, vec![1, 2], "hello must be answered before shutdown: {lines:?}");
}
