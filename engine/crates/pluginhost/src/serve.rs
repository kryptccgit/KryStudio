use crate::win;
use crate::wire;
use krypt_studio_pluginclient::{b64, shm::Channel};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::io::BufRead;
use std::sync::{Arc, Mutex};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{DefWindowProcW, WM_TIMER};

pub struct LoadArgs {
    pub inst: u64,
    pub chan: Arc<Channel>,
    pub path: String,
    pub plugin_id: String,
    pub kind: String,
    pub sample_rate: f64,
    pub max_frames: u32,
    pub realtime: bool,
}

pub trait Hosted {
    fn name(&self) -> &str;
    fn has_editor(&self) -> bool;
    fn get_state(&mut self) -> Result<Vec<u8>, String>;
    fn set_state(&mut self, data: &[u8]) -> Result<(), String>;
    fn open_editor(&mut self, owner: HWND, title: &str) -> Result<(), String>;
    fn close_editor(&mut self);
    fn editor_open(&self) -> bool;
    fn editor_resized(&mut self, _w: u32, _h: u32) {}
    fn set_sample_rate(&mut self, sr: f64) -> Result<(), String>;
    fn tick(&mut self);
    fn shutdown(&mut self);
}

struct Server {
    insts: BTreeMap<u64, Box<dyn Hosted>>,
}

enum Action {
    EditorClosed(u64),
    EditorResized(u64, u32, u32),
}

static CMDS: Mutex<VecDeque<Value>> = Mutex::new(VecDeque::new());

thread_local! {
    static SERVER: RefCell<Option<Server>> = const { RefCell::new(None) };
    static ACTIONS: RefCell<VecDeque<Action>> = const { RefCell::new(VecDeque::new()) };
}

fn id_of(v: &Value) -> Value {
    v.get("id").cloned().unwrap_or(Value::Null)
}

fn inst_of(v: &Value) -> u64 {
    v.get("inst").and_then(|x| x.as_u64()).unwrap_or(0)
}

impl Server {
    fn dispatch(&mut self, v: Value) {
        let id = id_of(&v);
        let cmd = v.get("cmd").and_then(|c| c.as_str()).unwrap_or("").to_string();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.run(&cmd, &v)));
        match r {
            Ok(Ok(data)) => wire::ok(&id, data),
            Ok(Err(e)) => wire::err(&id, e),
            Err(_) => wire::err(&id, format!("The plugin host hit an internal error during '{cmd}'")),
        }
    }

    fn get(&mut self, inst: u64) -> Result<&mut Box<dyn Hosted>, String> {
        self.insts.get_mut(&inst).ok_or_else(|| format!("No plugin instance {inst}"))
    }

    fn run(&mut self, cmd: &str, v: &Value) -> Result<Value, String> {
        match cmd {
            "hello" => Ok(json!({ "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id() })),
            "ping" => Ok(json!({})),
            "load" => self.load(v),
            "unload" => {
                if let Some(mut h) = self.insts.remove(&inst_of(v)) {
                    h.shutdown();
                }
                Ok(json!({}))
            }
            "getState" => {
                let data = self.get(inst_of(v))?.get_state()?;
                Ok(json!({ "state": b64::encode(&data), "bytes": data.len() }))
            }
            "setState" => {
                let s = v.get("state").and_then(|x| x.as_str()).ok_or("setState needs 'state'")?;
                let data = b64::decode(s)?;
                self.get(inst_of(v))?.set_state(&data)?;
                Ok(json!({}))
            }
            "openEditor" => {
                let owner = v.get("owner").and_then(|x| x.as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| x.as_u64())).unwrap_or(0);
                let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("Plugin").to_string();
                let h = self.get(inst_of(v))?;
                if !h.has_editor() {
                    return Err(format!("{} has no editor window; use the parameter panel", h.name()));
                }
                h.open_editor(owner as usize as HWND, &title)?;
                Ok(json!({ "open": true }))
            }
            "closeEditor" => {
                self.get(inst_of(v))?.close_editor();
                Ok(json!({ "open": false }))
            }
            "setSampleRate" => {
                let sr = v.get("sampleRate").and_then(|x| x.as_f64()).filter(|s| *s >= 8000.0).ok_or("bad sampleRate")?;
                self.get(inst_of(v))?.set_sample_rate(sr)?;
                Ok(json!({}))
            }
            "shutdown" => {
                self.shutdown_all();
                win::quit();
                Ok(json!({}))
            }
            other => Err(format!("Unknown host command '{other}'")),
        }
    }

    fn load(&mut self, v: &Value) -> Result<Value, String> {
        let inst = inst_of(v);
        if inst == 0 || self.insts.contains_key(&inst) {
            return Err(format!("Bad instance id {inst}"));
        }
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let shm_name = s("shm");
        let chan = Arc::new(Channel::open(&shm_name)?);
        let args = LoadArgs {
            inst,
            chan: chan.clone(),
            path: s("path"),
            plugin_id: s("pluginId"),
            kind: s("kind"),
            sample_rate: v.get("sampleRate").and_then(|x| x.as_f64()).unwrap_or(48000.0).max(8000.0),
            max_frames: v.get("maxFrames").and_then(|x| x.as_u64()).unwrap_or(1024).clamp(32, 8192) as u32,
            realtime: v.get("realtime").and_then(|x| x.as_bool()).unwrap_or(true),
        };
        let state = match v.get("state").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
            Some(s) => Some(b64::decode(s).map_err(|e| format!("Saved plugin state is corrupt: {e}"))?),
            None => None,
        };
        let mut hosted: Box<dyn Hosted> = match s("format").as_str() {
            "clap" => Box::new(crate::clap_host::ClapInstance::load(&args)?),
            "vst3" => Box::new(crate::vst3_host::Vst3Instance::load(&args)?),
            f => return Err(format!("Unsupported plugin format '{f}'")),
        };
        let mut warn = None;
        if let Some(data) = state {
            eprintln!("restoring {} bytes of state into {}", data.len(), hosted.name());
            if let Err(e) = hosted.set_state(&data) {
                warn = Some(format!("{} couldn't restore its saved state: {e}", hosted.name()));
            }
        }
        let has_editor = hosted.has_editor();
        let latency = chan.map.block().latency.load(std::sync::atomic::Ordering::Relaxed);
        if let Some(w) = &warn {
            wire::log("warn", w.clone());
        }
        self.insts.insert(inst, hosted);
        Ok(json!({ "hasEditor": has_editor, "latency": latency, "warning": warn }))
    }

    fn pump(&mut self) {
        loop {
            let next = CMDS.lock().unwrap_or_else(|e| e.into_inner()).pop_front();
            match next {
                Some(c) => self.dispatch(c),
                None => break,
            }
        }
        loop {
            let a = ACTIONS.with(|q| q.borrow_mut().pop_front());
            match a {
                Some(Action::EditorClosed(i)) => {
                    if let Some(h) = self.insts.get_mut(&i) {
                        if h.editor_open() {
                            h.close_editor();
                            wire::event(json!({ "event": "editorClosed", "inst": i }));
                        }
                    }
                }
                Some(Action::EditorResized(i, w, h)) => {
                    if let Some(x) = self.insts.get_mut(&i) {
                        x.editor_resized(w, h);
                    }
                }
                None => break,
            }
        }
        for h in self.insts.values_mut() {
            let was_open = h.editor_open();
            h.tick();
            if was_open && !h.editor_open() {
            }
        }
    }

    fn shutdown_all(&mut self) {
        let insts = std::mem::take(&mut self.insts);
        for (_, mut h) in insts {
            h.shutdown();
        }
    }
}

fn answer_pings_only() {
    let mut q = CMDS.lock().unwrap_or_else(|e| e.into_inner());
    q.retain(|v| {
        if v.get("cmd").and_then(|c| c.as_str()) == Some("ping") {
            wire::ok(&id_of(v), json!({}));
            false
        } else {
            true
        }
    });
}

fn pump() {
    SERVER.with(|s| match s.try_borrow_mut() {
        Ok(mut g) => {
            if let Some(srv) = g.as_mut() {
                srv.pump();
            }
        }
        Err(_) => answer_pings_only(),
    });
}

unsafe extern "system" fn msg_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        win::WM_APP_WAKE | WM_TIMER => {
            pump();
            0
        }
        win::WM_APP_CLOSE => {
            ACTIONS.with(|q| q.borrow_mut().push_back(Action::EditorClosed(wp as u64)));
            pump();
            0
        }
        win::WM_APP_RESIZED => {
            let (w, h) = ((lp as u32) & 0xFFFF, ((lp as u32) >> 16) & 0xFFFF);
            ACTIONS.with(|q| q.borrow_mut().push_back(Action::EditorResized(wp as u64, w, h)));
            pump();
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

fn spawn_parent_watchdog(pid: u32) {
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};
    let h = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if h.is_null() {
        eprintln!("[pluginhost] parent {pid} is not running; exiting");
        std::process::exit(0);
    }
    let h = h as usize;
    let _ = std::thread::Builder::new().name("parent-watchdog".into()).spawn(move || {
        let r = unsafe { WaitForSingleObject(h as windows_sys::Win32::Foundation::HANDLE, INFINITE) };
        if r == WAIT_OBJECT_0 {
            eprintln!("[pluginhost] engine {pid} exited; exiting");
            std::process::exit(0);
        }
    });
}

pub fn run(parent_pid: Option<u32>) -> i32 {
    win::init_dpi();
    unsafe {
        windows_sys::Win32::System::Ole::OleInitialize(std::ptr::null());
    }
    if let Some(pid) = parent_pid {
        spawn_parent_watchdog(pid);
    }
    if let Err(e) = win::create_message_window(Some(msg_proc)) {
        eprintln!("[pluginhost] {e}");
        return 1;
    }
    SERVER.with(|s| *s.borrow_mut() = Some(Server { insts: BTreeMap::new() }));
    let _ = std::thread::Builder::new().name("stdin".into()).spawn(|| {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(l) = line else { break };
            let t = l.trim();
            if t.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(t) {
                Ok(v) => {
                    CMDS.lock().unwrap_or_else(|e| e.into_inner()).push_back(v);
                    win::wake();
                }
                Err(e) => wire::err(&Value::Null, format!("Invalid JSON: {e}")),
            }
        }
        CMDS.lock().unwrap_or_else(|e| e.into_inner()).push_back(json!({ "cmd": "shutdown" }));
        win::wake();
        std::thread::sleep(std::time::Duration::from_secs(5));
        std::process::exit(0);
    });
    win::run_loop();
    SERVER.with(|s| {
        if let Ok(mut g) = s.try_borrow_mut() {
            if let Some(srv) = g.as_mut() {
                srv.shutdown_all();
            }
        }
    });
    0
}
