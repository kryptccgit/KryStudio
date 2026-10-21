//! The plugin-host process: spawn, NDJSON control channel, watchdog and
//! crash handling. One host process (the "shared sandbox") serves every
//! third-party instance of this engine process; a crash or hang takes down
//! only the host, never the engine.
//!
//! Control channel = the host's stdin/stdout (one JSON object per line):
//!   request  {"id":7,"cmd":"load",...}   response {"id":7,"ok":true,"data":{...}}
//!   event    {"event":"param","inst":3,"id":12,"value":0.5}   (no id)
//! Audio never crosses this channel (see shm.rs).

use crate::shm::{self, Channel};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::*};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

pub const HOST_EXE: &str = "krypt-studio-pluginhost.exe";

type Reply = Box<dyn FnOnce(Result<Value, String>) + Send>;

enum Waiter {
    Chan(mpsc::Sender<Result<Value, String>>),
    Cb(Reply),
}

// ── Global state ─────────────────────────────────────────────────────────

struct Globals {
    host_exe: Mutex<Option<PathBuf>>,
    owner_hwnd: AtomicU64,
    conn: Mutex<Option<Arc<Conn>>>,
    events: Mutex<VecDeque<Value>>,
    reload: AtomicBool,
    retry: AtomicBool,
    last_auto_reload: Mutex<Option<Instant>>,
    live: Mutex<HashMap<String, Weak<Inst>>>,
    next_inst: AtomicU64,
    next_gen: AtomicU64,
}

fn g() -> &'static Globals {
    static G: OnceLock<Globals> = OnceLock::new();
    G.get_or_init(|| Globals {
        host_exe: Mutex::new(None),
        owner_hwnd: AtomicU64::new(0),
        conn: Mutex::new(None),
        events: Mutex::new(VecDeque::new()),
        reload: AtomicBool::new(false),
        retry: AtomicBool::new(false),
        last_auto_reload: Mutex::new(None),
        live: Mutex::new(HashMap::new()),
        next_inst: AtomicU64::new(1),
        next_gen: AtomicU64::new(1),
    })
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Queue an event for the engine to forward to Electron main.
pub fn push_event(v: Value) {
    let mut q = lock(&g().events);
    if q.len() < 4096 {
        q.push_back(v);
    }
}

pub fn drain_events() -> Vec<Value> {
    lock(&g().events).drain(..).collect()
}

pub fn request_reload() {
    g().reload.store(true, SeqCst);
}

pub fn take_reload_request() -> bool {
    g().reload.swap(false, SeqCst)
}

pub fn request_retry() {
    g().retry.store(true, SeqCst);
}

pub fn take_retry_request() -> bool {
    g().retry.swap(false, SeqCst)
}

pub fn set_host_exe(p: Option<PathBuf>) {
    *lock(&g().host_exe) = p;
}

pub fn set_owner_hwnd(h: u64) {
    g().owner_hwnd.store(h, Relaxed);
}

pub fn owner_hwnd() -> u64 {
    g().owner_hwnd.load(Relaxed)
}

fn resolve_host_exe() -> Result<PathBuf, String> {
    if let Some(p) = lock(&g().host_exe).clone() {
        return Ok(p);
    }
    if let Ok(p) = std::env::var("KRYPT_PLUGINHOST") {
        return Ok(PathBuf::from(p));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("engine exe has no folder")?;
    let cand = dir.join(HOST_EXE);
    if cand.is_file() {
        return Ok(cand);
    }
    Err(format!("The plugin host ({HOST_EXE}) was not found next to the engine. Rebuild the engine (npm run engine:build:debug)."))
}

// ── Instances ────────────────────────────────────────────────────────────

/// One hosted plugin instance, shared by its proxy and the manager.
pub struct Inst {
    pub id: u64,
    /// Entity key: channel id, or "insertId/slotId".
    pub key: String,
    pub plugin_id: String,
    pub name: String,
    pub conn: Arc<Conn>,
    pub chan: Channel,
    pub realtime: bool,
    pub dead: AtomicBool,
    /// Set by the proxy when the host stopped answering process() calls.
    pub hung: AtomicBool,
    pub has_editor: AtomicBool,
    load: Mutex<Option<Result<Value, String>>>,
    load_cv: Condvar,
}

impl Inst {
    /// Mark silent forever (host gone / plugin failed).
    pub fn kill(&self) {
        self.dead.store(true, SeqCst);
        self.chan.map.block().state.store(shm::state::DEAD, SeqCst);
    }

    pub fn is_dead(&self) -> bool {
        self.dead.load(Acquire)
    }

    /// Block until the host answered `load` (offline renders only).
    pub fn wait_loaded(&self, timeout: Duration) -> Result<(), String> {
        let t0 = Instant::now();
        let mut st = lock(&self.load);
        loop {
            match &*st {
                Some(Ok(_)) => return Ok(()),
                Some(Err(e)) => return Err(e.clone()),
                None => {}
            }
            let el = t0.elapsed();
            if el >= timeout {
                return Err(format!("{} took too long to load", self.name));
            }
            st = self.load_cv.wait_timeout(st, timeout - el).map(|(s, _)| s).unwrap_or_else(|e| e.into_inner().0);
        }
    }

    fn set_loaded(&self, r: Result<Value, String>) {
        *lock(&self.load) = Some(r);
        self.load_cv.notify_all();
    }

    pub fn latency(&self) -> usize {
        self.chan.map.block().latency.load(Relaxed) as usize
    }
}

impl Drop for Inst {
    fn drop(&mut self) {
        // Stop the host-side audio thread promptly, then free the instance.
        let b = self.chan.map.block();
        b.quit.store(1, SeqCst);
        self.chan.req.set();
        lock(&self.conn.insts).remove(&self.id);
        if self.conn.alive.load(Acquire) {
            self.conn.send_async("unload", json!({ "inst": self.id }), None);
        }
        if self.realtime {
            let mut live = lock(&g().live);
            if let Some(w) = live.get(&self.key) {
                if w.strong_count() == 0 {
                    live.remove(&self.key);
                }
            }
        }
    }
}

/// Live (real-time engine) instance for an entity key.
pub fn live_instance(key: &str) -> Option<Arc<Inst>> {
    lock(&g().live).get(key).and_then(|w| w.upgrade())
}

pub fn live_instances() -> Vec<Arc<Inst>> {
    lock(&g().live).values().filter_map(|w| w.upgrade()).collect()
}

pub struct LoadSpec<'a> {
    pub plugin_id: &'a str,
    pub key: &'a str,
    pub name: &'a str,
    pub format: &'a str,
    pub raw_id: &'a str,
    pub path: &'a str,
    pub kind: &'a str,
    pub sample_rate: f32,
    pub state: Option<&'a str>,
    pub realtime: bool,
}

/// Create the shared memory for a new instance and ask the host to load
/// it. Never blocks on the plugin (the proxy stays silent until READY).
pub fn start_instance(spec: LoadSpec) -> Result<Arc<Inst>, String> {
    let conn = ensure_conn()?;
    let id = g().next_inst.fetch_add(1, Relaxed);
    let base = format!("KryptStudioPlug-{}-{}-{id}", std::process::id(), conn.gen);
    let chan = Channel::create(&base)?;
    let inst = Arc::new(Inst {
        id,
        key: spec.key.to_string(),
        plugin_id: spec.plugin_id.to_string(),
        name: spec.name.to_string(),
        conn: conn.clone(),
        chan,
        realtime: spec.realtime,
        dead: AtomicBool::new(false),
        hung: AtomicBool::new(false),
        has_editor: AtomicBool::new(false),
        load: Mutex::new(None),
        load_cv: Condvar::new(),
    });
    lock(&conn.insts).insert(id, Arc::downgrade(&inst));
    if spec.realtime {
        lock(&g().live).insert(spec.key.to_string(), Arc::downgrade(&inst));
    }
    let args = json!({
        "inst": id,
        "shm": base,
        "format": spec.format,
        "pluginId": spec.raw_id,
        "path": spec.path,
        "kind": spec.kind,
        "sampleRate": spec.sample_rate,
        "maxFrames": shm::MAX_FRAMES,
        "state": spec.state,
        "realtime": spec.realtime,
    });
    conn.loading.fetch_add(1, SeqCst);
    let weak = Arc::downgrade(&inst);
    let key = spec.key.to_string();
    let name = spec.name.to_string();
    let plugin_id = spec.plugin_id.to_string();
    let realtime = spec.realtime;
    let c2 = conn.clone();
    conn.send_async(
        "load",
        args,
        Some(Box::new(move |r: Result<Value, String>| {
            c2.loading.fetch_sub(1, SeqCst);
            let Some(inst) = weak.upgrade() else { return };
            match &r {
                Ok(data) => {
                    let has_editor = data.get("hasEditor").and_then(|x| x.as_bool()).unwrap_or(false);
                    inst.has_editor.store(has_editor, Relaxed);
                }
                Err(e) => {
                    inst.chan.map.block().state.store(shm::state::FAILED, SeqCst);
                    inst.dead.store(true, SeqCst);
                    if realtime {
                        push_event(json!({ "event": "plugin", "kind": "loadFailed", "key": key, "pluginId": plugin_id, "message": format!("{name} failed to load: {e}") }));
                    }
                }
            }
            inst.set_loaded(r);
        })),
    );
    Ok(inst)
}

// ── Host connection ──────────────────────────────────────────────────────

pub struct Conn {
    pub gen: u64,
    pub pid: u32,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, Waiter>>,
    next_id: AtomicU64,
    pub alive: AtomicBool,
    /// Why we killed it ("reload", "hang", ...), if we did.
    killed: Mutex<Option<String>>,
    insts: Mutex<HashMap<u64, Weak<Inst>>>,
    loading: AtomicU32,
}

impl Conn {
    fn write_line(&self, v: &Value) -> Result<(), String> {
        let mut g = lock(&self.stdin);
        let Some(w) = g.as_mut() else { return Err("The plugin host is not running".into()) };
        let mut s = v.to_string();
        s.push('\n');
        w.write_all(s.as_bytes()).and_then(|_| w.flush()).map_err(|e| format!("Plugin host pipe: {e}"))
    }

    /// Fire a request; `reply` (if any) runs on the reader thread.
    pub fn send_async(&self, cmd: &str, args: Value, reply: Option<Reply>) {
        let id = self.next_id.fetch_add(1, Relaxed);
        let mut msg = args;
        if !msg.is_object() {
            msg = json!({});
        }
        msg["id"] = json!(id);
        msg["cmd"] = json!(cmd);
        if let Some(r) = reply {
            if !self.alive.load(Acquire) {
                r(Err("The plugin host is not running".into()));
                return;
            }
            lock(&self.pending).insert(id, Waiter::Cb(r));
        }
        if let Err(e) = self.write_line(&msg) {
            if let Some(Waiter::Cb(r)) = lock(&self.pending).remove(&id) {
                r(Err(e));
            }
        }
    }

    /// Blocking request (never call on the audio thread).
    pub fn request(&self, cmd: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        if !self.alive.load(Acquire) {
            return Err("The plugin host is not running".into());
        }
        let id = self.next_id.fetch_add(1, Relaxed);
        let (tx, rx) = mpsc::channel();
        lock(&self.pending).insert(id, Waiter::Chan(tx));
        let mut msg = args;
        if !msg.is_object() {
            msg = json!({});
        }
        msg["id"] = json!(id);
        msg["cmd"] = json!(cmd);
        if let Err(e) = self.write_line(&msg) {
            lock(&self.pending).remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                lock(&self.pending).remove(&id);
                Err(format!("The plugin host didn't answer '{cmd}' in time"))
            }
        }
    }

    pub fn kill(&self, reason: &str) {
        {
            let mut k = lock(&self.killed);
            if k.is_none() {
                *k = Some(reason.to_string());
            }
        }
        terminate_pid(self.pid);
    }

    fn inst(&self, id: u64) -> Option<Arc<Inst>> {
        lock(&self.insts).get(&id).and_then(|w| w.upgrade())
    }

    fn handle_line(self: &Arc<Self>, line: &str) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            eprintln!("[pluginhost:stdout] {}", line.chars().take(300).collect::<String>());
            return;
        };
        // Responses carry "id"; events carry "event" (and may have their own fields).
        if let Some(id) = v.get("id").and_then(|x| x.as_u64()).filter(|_| v.get("event").is_none()) {
            let r = if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
                Ok(v.get("data").cloned().unwrap_or(Value::Null))
            } else {
                Err(v.get("message").and_then(|x| x.as_str()).unwrap_or("Plugin host error").to_string())
            };
            let w = lock(&self.pending).remove(&id);
            match w {
                Some(Waiter::Chan(tx)) => {
                    let _ = tx.send(r);
                }
                Some(Waiter::Cb(cb)) => cb(r),
                None => {}
            }
            return;
        }
        let Some(ev) = v.get("event").and_then(|x| x.as_str()) else { return };
        let inst = v.get("inst").and_then(|x| x.as_u64()).and_then(|i| self.inst(i));
        match ev {
            "param" => {
                if let Some(inst) = inst.filter(|i| i.realtime) {
                    let pid = v.get("paramId").and_then(|x| x.as_u64()).unwrap_or(0);
                    let value = v.get("value").and_then(|x| x.as_f64()).unwrap_or(0.0);
                    push_event(json!({ "event": "plugin", "kind": "param", "key": inst.key, "paramId": pid.to_string(), "value": value }));
                }
            }
            "editorClosed" => {
                if let Some(inst) = inst.filter(|i| i.realtime) {
                    push_event(json!({ "event": "plugin", "kind": "editor", "key": inst.key, "open": false }));
                }
            }
            "pluginError" => {
                if let Some(inst) = inst {
                    inst.kill();
                    let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("stopped working").to_string();
                    if inst.realtime {
                        push_event(json!({ "event": "plugin", "kind": "crashed", "keys": [inst.key], "names": [inst.name], "message": format!("{} {msg}; it is silent until you reload plugins.", inst.name) }));
                    }
                }
            }
            "log" => {
                let level = v.get("level").and_then(|x| x.as_str()).unwrap_or("info");
                let message = v.get("message").and_then(|x| x.as_str()).unwrap_or("");
                eprintln!("[pluginhost] [{level}] {message}");
                if level == "warn" || level == "error" {
                    push_event(json!({ "event": "log", "level": level, "message": format!("Plugin host: {message}") }));
                }
            }
            _ => {}
        }
    }

    fn on_exit(self: &Arc<Self>, code: Option<i32>) {
        self.alive.store(false, SeqCst);
        *lock(&self.stdin) = None;
        let pending: Vec<Waiter> = lock(&self.pending).drain().map(|(_, w)| w).collect();
        for w in pending {
            match w {
                Waiter::Chan(tx) => {
                    let _ = tx.send(Err("The plugin host stopped".into()));
                }
                Waiter::Cb(cb) => cb(Err("The plugin host stopped".into())),
            }
        }
        let insts: Vec<Arc<Inst>> = lock(&self.insts).values().filter_map(|w| w.upgrade()).collect();
        let mut keys = Vec::new();
        let mut names = Vec::new();
        for i in &insts {
            let was_dead = i.is_dead();
            i.kill();
            i.set_loaded(Err("The plugin host stopped".into()));
            if i.realtime && !was_dead {
                keys.push(i.key.clone());
                names.push(i.name.clone());
            }
        }
        {
            let mut c = lock(&g().conn);
            if c.as_ref().map(|c| c.gen) == Some(self.gen) {
                *c = None;
            }
        }
        let killed = lock(&self.killed).clone();
        let code_s = code.map(|c| format!(" (exit code {:#x})", c as u32)).unwrap_or_default();
        eprintln!("[plugins] host pid {} exited{code_s}; reason {:?}", self.pid, killed);
        match killed.as_deref() {
            Some("reload") | Some("shutdown") => {}
            Some(reason) => {
                // Hang: kill + reload automatically (once a minute at most).
                let auto = {
                    let mut last = lock(&g().last_auto_reload);
                    let ok = last.map(|t| t.elapsed() > Duration::from_secs(60)).unwrap_or(true);
                    if ok {
                        *last = Some(Instant::now());
                    }
                    ok
                };
                if !keys.is_empty() {
                    let list = names.join(", ");
                    let msg = if auto {
                        format!("The plugin host {reason}; it was restarted and {list} reloaded.")
                    } else {
                        format!("The plugin host {reason} again; {list} stay silent. Use Reload plugins in the Plugin Manager.")
                    };
                    push_event(json!({ "event": "plugin", "kind": "crashed", "keys": keys, "names": names, "message": msg, "reloading": auto }));
                }
                if auto {
                    request_reload();
                }
            }
            None => {
                if !keys.is_empty() {
                    let list = names.join(", ");
                    push_event(json!({
                        "event": "plugin", "kind": "crashed", "keys": keys, "names": names, "reloading": false,
                        "message": format!("The plugin host crashed{code_s}. {list} {} silent; use Reload plugins in the Plugin Manager to bring {} back.",
                            if names.len() == 1 { "is" } else { "are" }, if names.len() == 1 { "it" } else { "them" }),
                    }));
                }
            }
        }
    }
}

#[cfg(windows)]
fn terminate_pid(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // SAFETY: plain Win32 calls with a checked handle.
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 0xDEAD);
            CloseHandle(h);
        }
    }
}

#[cfg(not(windows))]
fn terminate_pid(_pid: u32) {}

/// The running host, or a freshly spawned one.
fn ensure_conn() -> Result<Arc<Conn>, String> {
    let mut slot = lock(&g().conn);
    if let Some(c) = slot.as_ref() {
        if c.alive.load(Acquire) {
            return Ok(c.clone());
        }
    }
    let exe = resolve_host_exe()?;
    let c = spawn(&exe)?;
    *slot = Some(c.clone());
    Ok(c)
}

pub fn current_conn() -> Option<Arc<Conn>> {
    lock(&g().conn).clone().filter(|c| c.alive.load(Acquire))
}

fn spawn(exe: &std::path::Path) -> Result<Arc<Conn>, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--serve").arg("--parent-pid").arg(std::process::id().to_string());
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the plugin host ({}): {e}", exe.display()))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("plugin host has no stdout")?;
    let stderr = child.stderr.take();
    let gen = g().next_gen.fetch_add(1, Relaxed);
    let conn = Arc::new(Conn {
        gen,
        pid: child.id(),
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        alive: AtomicBool::new(true),
        killed: Mutex::new(None),
        insts: Mutex::new(HashMap::new()),
        loading: AtomicU32::new(0),
    });
    eprintln!("[plugins] started plugin host pid {} ({})", conn.pid, exe.display());

    // stdout reader → responses + events.
    {
        let c = conn.clone();
        let _ = std::thread::Builder::new().name("pluginhost-out".into()).spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) => {
                        let t = l.trim();
                        if !t.is_empty() {
                            c.handle_line(t);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
    // stderr → our stderr (Electron logs it at debug level).
    if let Some(err) = stderr {
        let _ = std::thread::Builder::new().name("pluginhost-err".into()).spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[pluginhost] {line}");
            }
        });
    }
    // Exit monitor.
    {
        let c = conn.clone();
        let _ = std::thread::Builder::new().name("pluginhost-wait".into()).spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            c.on_exit(code);
        });
    }
    // Watchdog: the host UI thread must answer pings; a hung audio thread
    // is flagged by the proxies. Either way: kill → crash path → reload.
    {
        let c = conn.clone();
        let _ = std::thread::Builder::new().name("pluginhost-watchdog".into()).spawn(move || {
            let mut misses = 0;
            while c.alive.load(Acquire) {
                std::thread::sleep(Duration::from_millis(500));
                if !c.alive.load(Acquire) {
                    break;
                }
                let hung = lock(&c.insts).values().filter_map(|w| w.upgrade()).any(|i| i.hung.load(Relaxed) && !i.is_dead());
                if hung {
                    eprintln!("[plugins] a plugin's audio processing hung; killing the plugin host");
                    c.kill("stopped processing audio (a plugin hung)");
                    break;
                }
                // Plugins may legitimately block the UI thread while loading.
                let timeout = if c.loading.load(SeqCst) > 0 { Duration::from_secs(60) } else { Duration::from_secs(3) };
                match c.request("ping", json!({}), timeout) {
                    Ok(_) => misses = 0,
                    Err(_) if !c.alive.load(Acquire) => break,
                    Err(_) => {
                        misses += 1;
                        if misses >= 2 {
                            eprintln!("[plugins] plugin host UI thread stopped responding; killing it");
                            c.kill("stopped responding (a plugin window hung)");
                            break;
                        }
                    }
                }
            }
        });
    }
    Ok(conn)
}

/// Kill the host on purpose (Reload plugins / shutdown). Instances die
/// silently; the caller re-creates them.
pub fn kill_host(reason: &str) {
    let c = lock(&g().conn).clone();
    if let Some(c) = c {
        c.kill(reason);
        // Wait briefly so the next spawn doesn't race the old process.
        let t0 = Instant::now();
        while c.alive.load(Acquire) && t0.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

pub fn status() -> Value {
    let c = lock(&g().conn).clone();
    let insts: Vec<Value> = live_instances()
        .iter()
        .map(|i| json!({ "key": i.key, "pluginId": i.plugin_id, "name": i.name, "state": match i.chan.map.block().state.load(Relaxed) {
            shm::state::READY => "ok", shm::state::LOADING => "loading", shm::state::PAUSED => "paused", shm::state::FAILED => "failed", _ => "crashed" }, "hasEditor": i.has_editor.load(Relaxed) }))
        .collect();
    json!({
        "hostPid": c.as_ref().filter(|c| c.alive.load(Acquire)).map(|c| c.pid),
        "instances": insts,
    })
}
