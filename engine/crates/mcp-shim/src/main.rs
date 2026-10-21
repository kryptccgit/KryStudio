//! krypt-studio-mcp — the stdio MCP server every agent client launches.
//!
//! It relays newline-delimited JSON-RPC between the client (stdin/stdout) and
//! the running Krypt Studio app (a per-user named pipe on Windows, a Unix domain
//! socket on macOS / Linux). See docs/MCP.md.
//!
//! - Reads `mcp.json` ({pipe, token, appExePath, appArgs}) from Electron's userData
//!   dir for productName "Krypt Studio" (`%APPDATA%\Krypt Studio` on Windows,
//!   `~/Library/Application Support/Krypt Studio` on macOS, `~/.config/Krypt Studio`
//!   on Linux), which the app rewrites at every start. Override with KRYPT_STUDIO_MCP_CONFIG.
//! - Handshake: the first line on the pipe is {"krypt":"hello","token":…}.
//! - App not running: discovery (initialize, server/discover, tools/list,
//!   prompts/list, resources/list) is answered from mcp-manifest.json; the
//!   first call that needs the app launches it (detached) and waits ~20 s,
//!   else returns a clear tool error. Background requests (subscriptions/listen)
//!   never launch it: they are acknowledged and held until the app connects.
//! - stdout carries only MCP messages; diagnostics go to stderr.

fn main() {
    shim::run();
}

#[cfg(windows)]
mod pipe {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::sync::atomic::{AtomicBool, Ordering};

    type Handle = *mut c_void;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const ERROR_IO_PENDING: u32 = 997;
    pub const ERROR_FILE_NOT_FOUND: u32 = 2;
    pub const ERROR_PIPE_BUSY: u32 = 231;
    const WAIT_TIMEOUT: u32 = 258;
    pub const INFINITE: u32 = 0xFFFF_FFFF;

    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        h_event: Handle,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(name: *const u16, access: u32, share: u32, sa: *mut c_void, disp: u32, flags: u32, template: Handle) -> Handle;
        fn ReadFile(h: Handle, buf: *mut u8, n: u32, read: *mut u32, ov: *mut Overlapped) -> i32;
        fn WriteFile(h: Handle, buf: *const u8, n: u32, written: *mut u32, ov: *mut Overlapped) -> i32;
        fn GetOverlappedResult(h: Handle, ov: *mut Overlapped, n: *mut u32, wait: i32) -> i32;
        fn CreateEventW(sa: *mut c_void, manual: i32, initial: i32, name: *const u16) -> Handle;
        fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
        fn CancelIoEx(h: Handle, ov: *mut Overlapped) -> i32;
        fn CloseHandle(h: Handle) -> i32;
        fn GetLastError() -> u32;
        fn WaitNamedPipeW(name: *const u16, timeout: u32) -> i32;
    }

    struct Event(Handle);
    impl Event {
        fn new() -> io::Result<Event> {
            let h = unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, std::ptr::null()) };
            if h.is_null() {
                Err(io::Error::last_os_error())
            } else {
                Ok(Event(h))
            }
        }
    }
    impl Drop for Event {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    /// A client end of a named pipe opened for overlapped I/O, so one thread can
    /// block in a read while another writes (synchronous pipe handles serialize).
    pub struct Pipe {
        h: Handle,
        shut: AtomicBool,
    }
    unsafe impl Send for Pipe {}
    unsafe impl Sync for Pipe {}

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    impl Pipe {
        /// Open the pipe. Err(raw os error) so callers can tell "not running" from "busy".
        pub fn open(name: &str) -> Result<Pipe, u32> {
            let w = wide(name);
            for attempt in 0..3 {
                let h = unsafe { CreateFileW(w.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, std::ptr::null_mut(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED, std::ptr::null_mut()) };
                if h != INVALID_HANDLE_VALUE {
                    return Ok(Pipe { h, shut: AtomicBool::new(false) });
                }
                let e = unsafe { GetLastError() };
                if e == ERROR_PIPE_BUSY && attempt < 2 {
                    unsafe { WaitNamedPipeW(w.as_ptr(), 2000) };
                    continue;
                }
                return Err(e);
            }
            Err(ERROR_PIPE_BUSY)
        }

        fn io(&self, write: bool, buf: *mut u8, len: usize, timeout: u32) -> io::Result<usize> {
            if self.shut.load(Ordering::SeqCst) {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "pipe shut down"));
            }
            let ev = Event::new()?;
            let mut ov = Overlapped { internal: 0, internal_high: 0, offset: 0, offset_high: 0, h_event: ev.0 };
            let mut n: u32 = 0;
            let len = len.min(u32::MAX as usize) as u32;
            let ok = unsafe {
                if write {
                    WriteFile(self.h, buf, len, &mut n, &mut ov)
                } else {
                    ReadFile(self.h, buf, len, &mut n, &mut ov)
                }
            };
            if ok == 0 {
                let e = unsafe { GetLastError() };
                if e != ERROR_IO_PENDING {
                    return Err(io::Error::from_raw_os_error(e as i32));
                }
                if unsafe { WaitForSingleObject(ev.0, timeout) } == WAIT_TIMEOUT {
                    unsafe {
                        CancelIoEx(self.h, &mut ov);
                        GetOverlappedResult(self.h, &mut ov, &mut n, 1);
                    }
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "pipe I/O timed out"));
                }
            }
            if unsafe { GetOverlappedResult(self.h, &mut ov, &mut n, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(n as usize)
        }

        pub fn read(&self, buf: &mut [u8], timeout: u32) -> io::Result<usize> {
            let n = self.io(false, buf.as_mut_ptr(), buf.len(), timeout)?;
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "pipe closed"));
            }
            Ok(n)
        }

        pub fn write_all(&self, mut data: &[u8]) -> io::Result<()> {
            while !data.is_empty() {
                let n = self.io(true, data.as_ptr() as *mut u8, data.len(), 30_000)?;
                if n == 0 {
                    return Err(io::Error::new(io::ErrorKind::WriteZero, "pipe write returned 0"));
                }
                data = &data[n..];
            }
            Ok(())
        }

        /// Cancel pending I/O so a blocked reader thread wakes up and exits.
        pub fn shutdown(&self) {
            self.shut.store(true, Ordering::SeqCst);
            unsafe { CancelIoEx(self.h, std::ptr::null_mut()) };
        }
    }

    impl Drop for Pipe {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.h) };
        }
    }
}

/// macOS / Linux: the app listens on a Unix domain socket (electron/mcp/index.ts pipeNameFor) with the same
/// newline-delimited protocol, so the shim needs the same four calls: open, read with a timeout, write, shutdown.
#[cfg(unix)]
mod pipe {
    use std::io::{self, Read, Write};
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    pub const ERROR_FILE_NOT_FOUND: u32 = 2;
    pub const INFINITE: u32 = 0xFFFF_FFFF;

    pub struct Pipe {
        s: UnixStream,
        shut: AtomicBool,
    }

    impl Pipe {
        /// Open the socket. Err(ERROR_FILE_NOT_FOUND) when nothing listens (no file, or a stale one).
        pub fn open(name: &str) -> Result<Pipe, u32> {
            match UnixStream::connect(name) {
                Ok(s) => Ok(Pipe { s, shut: AtomicBool::new(false) }),
                Err(e) if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused) => Err(ERROR_FILE_NOT_FOUND),
                Err(e) => Err(e.raw_os_error().unwrap_or(1) as u32),
            }
        }

        pub fn read(&self, buf: &mut [u8], timeout: u32) -> io::Result<usize> {
            if self.shut.load(Ordering::SeqCst) {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "pipe shut down"));
            }
            let t = if timeout == INFINITE { None } else { Some(Duration::from_millis(timeout.max(1) as u64)) };
            self.s.set_read_timeout(t)?;
            match (&self.s).read(buf) {
                Ok(0) => Err(io::Error::new(io::ErrorKind::UnexpectedEof, "pipe closed")),
                Ok(n) => Ok(n),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => Err(io::Error::new(io::ErrorKind::TimedOut, "pipe I/O timed out")),
                Err(e) => Err(e),
            }
        }

        pub fn write_all(&self, data: &[u8]) -> io::Result<()> {
            if self.shut.load(Ordering::SeqCst) {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "pipe shut down"));
            }
            self.s.set_write_timeout(Some(Duration::from_secs(30)))?;
            (&self.s).write_all(data)
        }

        /// Wake a blocked reader thread so it exits.
        pub fn shutdown(&self) {
            self.shut.store(true, Ordering::SeqCst);
            let _ = self.s.shutdown(Shutdown::Both);
        }
    }
}

mod shim {
    use super::pipe::{Pipe, ERROR_FILE_NOT_FOUND, INFINITE};
    use serde_json::{json, Value};
    use std::collections::{HashMap, HashSet};
    use std::io::{BufRead, Write};
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    const VERSION: &str = env!("CARGO_PKG_VERSION");
    const LAUNCH_WAIT: Duration = Duration::from_secs(20);
    const NOT_RUNNING: &str = "Krypt Studio isn't running — start it and retry.";
    const DISCOVERY: [&str; 6] = ["initialize", "server/discover", "tools/list", "prompts/list", "resources/list", "resources/templates/list"];
    /// Requests a client sends on its own, never because the user asked for
    /// something. They must not start the app: 2026 clients open
    /// `subscriptions/listen` at startup and re-open it seconds after the app
    /// quits, so launching for it reopened Krypt Studio every time it was closed.
    const BACKGROUND: [&str; 1] = ["subscriptions/listen"];
    const SUBSCRIPTION_ID: &str = "io.modelcontextprotocol/subscriptionId";

    fn log(msg: &str) {
        eprintln!("[krypt-studio-mcp] {msg}");
    }

    enum Event {
        Stdin(String),
        StdinEof,
        Pipe(u64, String),
        PipeClosed(u64),
    }

    struct Config {
        pipe: String,
        token: String,
        app_exe: Option<String>,
        app_args: Vec<String>,
    }

    struct Opts {
        config: PathBuf,
        client: String,
        launch: bool,
    }

    /// Electron's app.getPath('appData') on this OS (userData = appData/<productName>).
    fn app_data_dir() -> PathBuf {
        let home = || std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
        if cfg!(windows) {
            std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
        } else if cfg!(target_os = "macos") {
            home().join("Library").join("Application Support")
        } else {
            std::env::var_os("XDG_CONFIG_HOME").filter(|p| !p.is_empty()).map(PathBuf::from).unwrap_or_else(|| home().join(".config"))
        }
    }

    fn default_config_path() -> PathBuf {
        if let Ok(p) = std::env::var("KRYPT_STUDIO_MCP_CONFIG") {
            return PathBuf::from(p);
        }
        let appdata = app_data_dir();
        // Electron's app.getPath('userData') = <appData>/<productName>.
        let primary = appdata.join("Krypt Studio").join("mcp.json");
        if primary.exists() {
            return primary;
        }
        let alt = appdata.join("krypt-studio").join("mcp.json");
        if alt.exists() {
            alt
        } else {
            primary
        }
    }

    fn read_config(path: &PathBuf) -> Option<Config> {
        let text = std::fs::read_to_string(path).ok()?;
        let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
        Some(Config {
            pipe: v.get("pipe")?.as_str()?.to_string(),
            token: v.get("token")?.as_str()?.to_string(),
            app_exe: v.get("appExePath").and_then(|x| x.as_str()).map(String::from),
            app_args: v.get("appArgs").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default(),
        })
    }

    enum ConnectError {
        NotRunning,
        Failed(String),
    }

    struct Conn {
        pipe: Arc<Pipe>,
        gen: u64,
    }

    struct Shim {
        opts: Opts,
        tx: Sender<Event>,
        conn: Option<Conn>,
        gen: u64,
        /// Cached legacy `initialize` request, replayed after (re)connecting.
        init: Option<Value>,
        initialized: bool,
        /// Forwarded requests awaiting a response: id → method.
        pending: HashMap<String, (String, bool)>,
        /// Ids of replayed requests whose responses must not reach the client.
        swallow: HashSet<String>,
        replay_seq: u64,
        last_launch: Option<Instant>,
        /// Background requests held while the app is closed: (id key, line, modern).
        /// Handed to the app when something else connects to it.
        parked: Vec<(String, String, bool)>,
        /// Subscriptions we acknowledged offline; the app's own ack is dropped.
        acked: HashSet<String>,
    }

    fn write_stdout(line: &str) {
        let out = std::io::stdout();
        let mut o = out.lock();
        let _ = o.write_all(line.as_bytes());
        let _ = o.write_all(b"\n");
        let _ = o.flush();
    }

    fn send_json(v: &Value) {
        write_stdout(&v.to_string());
    }

    fn is_modern(msg: &Value) -> bool {
        msg.pointer("/params/_meta").and_then(|m| m.get("io.modelcontextprotocol/protocolVersion")).is_some()
    }

    fn tool_error(id: &Value, text: &str, modern: bool) -> Value {
        let mut result = json!({ "content": [{ "type": "text", "text": text }], "isError": true });
        if modern {
            result["resultType"] = json!("complete");
        }
        json!({ "jsonrpc": "2.0", "id": id, "result": result })
    }

    fn rpc_error(id: &Value, code: i64, text: &str) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": text } })
    }

    fn reply_failure(id: &Value, method: &str, modern: bool, text: &str) {
        if method == "tools/call" {
            send_json(&tool_error(id, text, modern));
        } else {
            send_json(&rpc_error(id, -32000, text));
        }
    }

    impl Shim {
        fn connect_once(&mut self) -> Result<(), ConnectError> {
            for attempt in 0..2 {
                let cfg = read_config(&self.opts.config).ok_or(ConnectError::NotRunning)?;
                let pipe = match Pipe::open(&cfg.pipe) {
                    Ok(p) => p,
                    Err(e) if e == ERROR_FILE_NOT_FOUND => return Err(ConnectError::NotRunning),
                    Err(e) => return Err(ConnectError::Failed(format!("can't open {} (os error {e})", cfg.pipe))),
                };
                let hello = json!({ "krypt": "hello", "v": 1, "token": cfg.token, "client": self.opts.client, "shimVersion": VERSION });
                pipe.write_all(format!("{hello}\n").as_bytes()).map_err(|e| ConnectError::Failed(e.to_string()))?;
                // Read the welcome line (bytes after it, if any, go to the reader).
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 4096];
                let deadline = Instant::now() + Duration::from_secs(5);
                let nl = loop {
                    if let Some(i) = buf.iter().position(|&b| b == b'\n') {
                        break i;
                    }
                    let left = deadline.saturating_duration_since(Instant::now()).as_millis() as u32;
                    if left == 0 {
                        return Err(ConnectError::Failed("no handshake reply from Krypt Studio".into()));
                    }
                    let n = pipe.read(&mut chunk, left).map_err(|e| ConnectError::Failed(format!("handshake: {e}")))?;
                    buf.extend_from_slice(&chunk[..n]);
                };
                let first: Value = serde_json::from_slice(&buf[..nl]).unwrap_or(Value::Null);
                if first.get("krypt").and_then(|k| k.as_str()) != Some("welcome") {
                    let code = first.get("code").and_then(|c| c.as_str()).unwrap_or("");
                    if code == "bad_token" && attempt == 0 {
                        std::thread::sleep(Duration::from_millis(300));
                        continue; // the app restarted and rotated the token: re-read mcp.json
                    }
                    let m = first.get("message").and_then(|c| c.as_str()).unwrap_or("handshake refused");
                    return Err(ConnectError::Failed(m.to_string()));
                }
                let rest = buf[nl + 1..].to_vec();
                self.attach(pipe, rest);
                return Ok(());
            }
            Err(ConnectError::Failed("handshake refused".into()))
        }

        fn attach(&mut self, pipe: Pipe, rest: Vec<u8>) {
            self.gen += 1;
            let gen = self.gen;
            let pipe = Arc::new(pipe);
            let reader = pipe.clone();
            let tx = self.tx.clone();
            std::thread::spawn(move || {
                let mut buf = rest;
                let mut chunk = vec![0u8; 64 * 1024];
                loop {
                    while let Some(i) = buf.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buf.drain(..=i).collect();
                        let s = String::from_utf8_lossy(&line[..line.len() - 1]).trim_end_matches('\r').to_string();
                        if !s.trim().is_empty() && tx.send(Event::Pipe(gen, s)).is_err() {
                            return;
                        }
                    }
                    match reader.read(&mut chunk, INFINITE) {
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        Err(_) => {
                            let _ = tx.send(Event::PipeClosed(gen));
                            return;
                        }
                    }
                }
            });
            self.conn = Some(Conn { pipe, gen });
            log("connected to Krypt Studio");
            // Legacy clients: replay the handshake the app hasn't seen on this connection.
            if let Some(init) = self.init.clone() {
                self.replay_seq += 1;
                let id = format!("krypt-shim-replay-{}", self.replay_seq);
                let mut msg = init;
                msg["id"] = json!(id);
                self.swallow.insert(json!(id).to_string());
                let _ = self.send_pipe(&msg.to_string());
                if self.initialized {
                    let _ = self.send_pipe(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
                }
            }
            for (key, line, modern) in std::mem::take(&mut self.parked) {
                let method = "subscriptions/listen".to_string();
                self.pending.insert(key.clone(), (method, modern));
                if !self.send_pipe(&line) {
                    self.pending.remove(&key);
                    self.acked.remove(&key);
                }
            }
        }

        /// Hold a background request while the app is closed. A listen gets the
        /// acknowledgement the app would send, narrowed to what it can deliver.
        fn park(&mut self, id: &Value, msg: &Value, line: String, modern: bool) {
            let key = id.to_string();
            if msg.get("method").and_then(|m| m.as_str()) == Some("subscriptions/listen") {
                let caps = self.offline_answer(msg, "server/discover").and_then(|d| d.get("capabilities").cloned()).unwrap_or(Value::Null);
                let wanted = msg.pointer("/params/notifications").cloned().unwrap_or(Value::Null);
                let mut honored = serde_json::Map::new();
                for (flag, cap) in [("toolsListChanged", "/tools/listChanged"), ("promptsListChanged", "/prompts/listChanged"), ("resourcesListChanged", "/resources/listChanged")] {
                    if wanted.get(flag) == Some(&json!(true)) && caps.pointer(cap) == Some(&json!(true)) {
                        honored.insert(flag.into(), json!(true));
                    }
                }
                if let (Some(uris), Some(true)) = (wanted.get("resourceSubscriptions"), caps.pointer("/resources/subscribe").and_then(|v| v.as_bool())) {
                    honored.insert("resourceSubscriptions".into(), uris.clone());
                }
                send_json(&json!({ "jsonrpc": "2.0", "method": "notifications/subscriptions/acknowledged", "params": { "_meta": { SUBSCRIPTION_ID: id }, "notifications": honored } }));
                self.acked.insert(key.clone());
            }
            self.parked.retain(|(k, _, _)| *k != key);
            self.parked.push((key, line, modern));
        }

        fn send_pipe(&mut self, line: &str) -> bool {
            let Some(c) = &self.conn else { return false };
            let mut data = Vec::with_capacity(line.len() + 1);
            data.extend_from_slice(line.as_bytes());
            data.push(b'\n');
            if c.pipe.write_all(&data).is_ok() {
                return true;
            }
            let gen = c.gen;
            self.disconnect(gen, "write failed");
            false
        }

        fn disconnect(&mut self, gen: u64, why: &str) {
            let Some(c) = &self.conn else { return };
            if c.gen != gen {
                return;
            }
            c.pipe.shutdown();
            self.conn = None;
            log(&format!("disconnected from Krypt Studio ({why})"));
            for (id, (method, modern)) in self.pending.drain() {
                let idv: Value = serde_json::from_str(&id).unwrap_or(Value::Null);
                reply_failure(&idv, &method, modern, "Krypt Studio closed while handling this request — reopen it and retry.");
            }
        }

        fn launch_app(&mut self) -> bool {
            if !self.opts.launch {
                return false;
            }
            if let Some(t) = self.last_launch {
                if t.elapsed() < Duration::from_secs(60) {
                    return false;
                }
            }
            let Some(cfg) = read_config(&self.opts.config) else { return false };
            let Some(exe) = cfg.app_exe.filter(|p| std::path::Path::new(p).exists()) else { return false };
            self.last_launch = Some(Instant::now());
            let command = || {
                let mut c = Command::new(&exe);
                c.args(&cfg.app_args).arg(format!("--launched-by-agent={}", self.opts.client)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                c
            };
            #[cfg(windows)]
            let spawned = {
                const DETACHED_PROCESS: u32 = 0x0000_0008;
                const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
                const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
                let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
                command().creation_flags(base | CREATE_BREAKAWAY_FROM_JOB).spawn().or_else(|_| command().creation_flags(base).spawn())
            };
            // macOS / Linux: its own process group, so the client stopping the shim doesn't take the app with it.
            #[cfg(unix)]
            let spawned = {
                use std::os::unix::process::CommandExt;
                command().process_group(0).spawn()
            };
            match spawned {
                Ok(_) => {
                    log(&format!("launched {exe}"));
                    true
                }
                Err(e) => {
                    log(&format!("couldn't launch {exe}: {e}"));
                    false
                }
            }
        }

        /// Connect, launching the app if needed. Sends MCP progress while waiting.
        fn ensure_app(&mut self, progress: Option<&Value>) -> Result<(), String> {
            if self.conn.is_some() {
                return Ok(());
            }
            match self.connect_once() {
                Ok(()) => return Ok(()),
                Err(ConnectError::Failed(m)) => return Err(format!("{NOT_RUNNING} ({m})")),
                Err(ConnectError::NotRunning) => {}
            }
            if !self.launch_app() {
                return Err(NOT_RUNNING.to_string());
            }
            let start = Instant::now();
            let mut tick = 0;
            while start.elapsed() < LAUNCH_WAIT {
                std::thread::sleep(Duration::from_millis(300));
                tick += 1;
                if let (Some(tok), true) = (progress, tick % 3 == 0) {
                    send_json(&json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": { "progressToken": tok, "progress": start.elapsed().as_secs(), "total": LAUNCH_WAIT.as_secs(), "message": "Starting Krypt Studio…" } }));
                }
                match self.connect_once() {
                    Ok(()) => return Ok(()),
                    Err(ConnectError::NotRunning) => continue,
                    Err(ConnectError::Failed(_)) => continue,
                }
            }
            Err(format!("{NOT_RUNNING} (it was launched but didn't open its agent connection within {} s)", LAUNCH_WAIT.as_secs()))
        }

        fn offline_answer(&self, msg: &Value, method: &str) -> Option<Value> {
            let dir = self.opts.config.parent()?.to_path_buf();
            let text = std::fs::read_to_string(dir.join("mcp-manifest.json")).ok()?;
            let manifest: Value = serde_json::from_str(&text).ok()?;
            let era = if is_modern(msg) { "modern" } else { "legacy" };
            let mut result = manifest.get(era)?.get(method)?.clone();
            if result.is_null() || result.get("error").is_some() {
                return None;
            }
            if method == "initialize" {
                let wanted = msg.pointer("/params/protocolVersion").and_then(|v| v.as_str()).unwrap_or("");
                let ok = manifest.get("legacyVersions").and_then(|v| v.as_array()).map(|a| a.iter().any(|x| x.as_str() == Some(wanted))).unwrap_or(false);
                if ok {
                    result["protocolVersion"] = json!(wanted);
                }
            }
            Some(result)
        }

        fn on_stdin(&mut self, line: String) {
            let msg: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => {
                    if self.conn.is_some() {
                        self.send_pipe(&line);
                    } else {
                        send_json(&rpc_error(&Value::Null, -32700, "Parse error"));
                    }
                    return;
                }
            };
            let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
            let id = msg.get("id").cloned();
            if method == "initialize" {
                self.init = Some(msg.clone());
            } else if method == "notifications/initialized" {
                self.initialized = true;
            }
            let modern = is_modern(&msg);
            if self.conn.is_some() {
                if let (Some(idv), false) = (&id, method.is_empty()) {
                    self.pending.insert(idv.to_string(), (method.clone(), modern));
                }
                if self.send_pipe(&line) {
                    return;
                }
                if let Some(idv) = &id {
                    self.pending.remove(&idv.to_string());
                }
            }
            // Offline (or the write just failed).
            if method == "notifications/cancelled" {
                if let Some(rid) = msg.pointer("/params/requestId") {
                    let key = rid.to_string();
                    self.parked.retain(|(k, _, _)| *k != key);
                    self.acked.remove(&key);
                }
            }
            let Some(idv) = id else { return };
            if method.is_empty() {
                return; // a response to a server request we can't route any more
            }
            if method == "ping" {
                send_json(&json!({ "jsonrpc": "2.0", "id": idv, "result": {} }));
                return;
            }
            if BACKGROUND.contains(&method.as_str()) {
                self.park(&idv, &msg, line, modern);
                return;
            }
            if DISCOVERY.contains(&method.as_str()) {
                if let Some(result) = self.offline_answer(&msg, &method) {
                    send_json(&json!({ "jsonrpc": "2.0", "id": idv, "result": result }));
                    return;
                }
            }
            let progress = msg.pointer("/params/_meta/progressToken").cloned();
            // An initialize we are about to forward must not also be replayed by attach().
            let held = if method == "initialize" { self.init.take() } else { None };
            let outcome = self.ensure_app(progress.as_ref());
            if held.is_some() {
                self.init = held;
            }
            match outcome {
                Ok(()) => {
                    self.pending.insert(idv.to_string(), (method.clone(), modern));
                    if !self.send_pipe(&line) {
                        self.pending.remove(&idv.to_string());
                        reply_failure(&idv, &method, modern, NOT_RUNNING);
                    }
                }
                Err(m) => reply_failure(&idv, &method, modern, &m),
            }
        }

        fn on_pipe(&mut self, gen: u64, line: String) {
            if self.conn.as_ref().map(|c| c.gen) != Some(gen) {
                return;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v.get("method").is_none() {
                    if let Some(id) = v.get("id") {
                        let key = id.to_string();
                        if self.swallow.remove(&key) {
                            return;
                        }
                        self.pending.remove(&key);
                        self.acked.remove(&key);
                    }
                } else if v.get("method").and_then(|m| m.as_str()) == Some("notifications/subscriptions/acknowledged") {
                    // Already acknowledged while the app was closed.
                    if let Some(sub) = v.pointer("/params/_meta").and_then(|m| m.get(SUBSCRIPTION_ID)) {
                        if self.acked.remove(&sub.to_string()) {
                            return;
                        }
                    }
                }
            }
            write_stdout(&line);
        }
    }

    fn parse_opts() -> Opts {
        let mut args = std::env::args().skip(1);
        let mut config = None;
        let mut client = std::env::var("KRYPT_MCP_CLIENT").unwrap_or_else(|_| "mcp-client".into());
        let mut launch = std::env::var("KRYPT_AUTOLAUNCH").map(|v| v != "0" && v.to_lowercase() != "false").unwrap_or(true);
        while let Some(a) = args.next() {
            match a.as_str() {
                "--version" | "-V" => {
                    println!("krypt-studio-mcp {VERSION}");
                    std::process::exit(0);
                }
                "--print-config-path" => {
                    println!("{}", default_config_path().display());
                    std::process::exit(0);
                }
                "--config" => config = args.next().map(PathBuf::from),
                "--client" => {
                    if let Some(c) = args.next() {
                        client = c;
                    }
                }
                "--no-launch" => launch = false,
                "--help" | "-h" => {
                    println!("krypt-studio-mcp {VERSION}: stdio MCP relay to Krypt Studio.\n  --client <name>   label shown in Krypt Studio\n  --config <path>   mcp.json (default: see --print-config-path)\n  --no-launch       never start Krypt Studio automatically\n  --print-config-path, --version");
                    std::process::exit(0);
                }
                other => log(&format!("ignoring unknown argument {other}")),
            }
        }
        Opts { config: config.unwrap_or_else(default_config_path), client, launch }
    }

    pub fn run() {
        let opts = parse_opts();
        let (tx, rx): (Sender<Event>, Receiver<Event>) = channel();
        let stdin_tx = tx.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            let mut lock = stdin.lock();
            let mut line = String::new();
            loop {
                line.clear();
                match lock.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        let _ = stdin_tx.send(Event::StdinEof);
                        return;
                    }
                    Ok(_) => {
                        let s = line.trim_end_matches(['\r', '\n']).to_string();
                        if !s.trim().is_empty() && stdin_tx.send(Event::Stdin(s)).is_err() {
                            return;
                        }
                    }
                }
            }
        });
        let mut shim = Shim { opts, tx, conn: None, gen: 0, init: None, initialized: false, pending: HashMap::new(), swallow: HashSet::new(), replay_seq: 0, last_launch: None, parked: Vec::new(), acked: HashSet::new() };
        match shim.connect_once() {
            Ok(()) => {}
            Err(ConnectError::NotRunning) => log("Krypt Studio isn't running; answering discovery offline until a tool needs it"),
            Err(ConnectError::Failed(m)) => log(&format!("couldn't connect yet: {m}")),
        }
        for ev in rx {
            match ev {
                Event::Stdin(line) => shim.on_stdin(line),
                Event::StdinEof => break,
                Event::Pipe(gen, line) => shim.on_pipe(gen, line),
                Event::PipeClosed(gen) => shim.disconnect(gen, "the app closed the connection"),
            }
        }
        if let Some(c) = shim.conn.take() {
            c.pipe.shutdown();
        }
    }
}
