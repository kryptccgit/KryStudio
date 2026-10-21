//! stdout = the control channel back to the engine (one JSON object per
//! line). stderr is free-form diagnostics.

use serde_json::{json, Value};
use std::io::Write;
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());

pub fn send(v: &Value) {
    let s = v.to_string();
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut so = std::io::stdout().lock();
    let _ = writeln!(so, "{s}");
    let _ = so.flush();
}

pub fn ok(id: &Value, data: Value) {
    send(&json!({ "id": id, "ok": true, "data": data }));
}

pub fn err(id: &Value, message: impl Into<String>) {
    send(&json!({ "id": id, "ok": false, "message": message.into() }));
}

pub fn event(v: Value) {
    send(&v);
}

pub fn log(level: &str, message: impl Into<String>) {
    let m = message.into();
    eprintln!("[{level}] {m}");
    send(&json!({ "event": "log", "level": level, "message": m }));
}
