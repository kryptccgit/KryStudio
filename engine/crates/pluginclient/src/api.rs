//! The engine-facing API (re-exported at the crate root).

use crate::{manager, registry, remote, shm};
use crate::registry::is_external_id;
use crate::remote::{RemoteEffect, RemoteInstrument};
use krypt_studio_dsp::{Effect, Instrument, PluginDescriptor};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Descriptor of a registered third-party plugin (None for stock ids).
pub fn descriptor(id: &str) -> Option<Arc<PluginDescriptor>> {
    registry::descriptor(id)
}

/// Register descriptors from a scan-cache file (`--plugins` for CLI renders).
pub fn register_file(path: &std::path::Path) -> Result<usize, String> {
    registry::register_file(path)
}

/// Engine events to forward to Electron main (crashes, editor closed,
/// GUI param edits, load failures). Drained by the control loop.
pub fn drain_events() -> Vec<Value> {
    manager::drain_events()
}

/// True once after the host was restarted (or `plugins.reload`): the engine
/// should drop and re-create every third-party instance.
pub fn take_reload_request() -> bool {
    manager::take_reload_request()
}

/// True once after new descriptors were registered: the engine should retry
/// entities whose plugin was unknown so far.
pub fn take_retry_request() -> bool {
    manager::take_retry_request()
}

/// Latency reported by the live effect for an entity key ("insertId/slotId").
pub fn effect_latency(key: &str) -> Option<usize> {
    manager::live_instance(key).map(|i| i.latency())
}

/// Latency reported by the live instrument of a channel (entity key = the channel id).
pub fn instrument_latency(key: &str) -> Option<usize> {
    manager::live_instance(key).map(|i| i.latency())
}

fn initial_params(entry: &registry::Entry, params: &BTreeMap<String, f64>) -> Vec<(usize, f32)> {
    entry
        .desc
        .params
        .iter()
        .enumerate()
        .filter_map(|(i, spec)| params.get(spec.id).map(|v| (i, krypt_studio_dsp::clamp_to_spec(spec, *v as f32))))
        .collect()
}

fn start(id: &str, key: &str, state: Option<&str>, params: &BTreeMap<String, f64>, sr: f32, realtime: bool, want: &str) -> Option<remote::Core> {
    let entry = registry::entry(id)?;
    let kind = match entry.desc.kind {
        krypt_studio_dsp::PluginKind::Instrument => "instrument",
        krypt_studio_dsp::PluginKind::Effect => "effect",
    };
    if kind != want {
        manager::push_event(json!({ "event": "log", "level": "warn", "message": format!("{} is an {kind}, not an {want}", entry.desc.name) }));
        return None;
    }
    let spec = manager::LoadSpec {
        plugin_id: id,
        key,
        name: entry.desc.name,
        format: entry.format.as_str(),
        raw_id: &entry.raw_id,
        path: &entry.path,
        kind,
        sample_rate: sr,
        state: state.filter(|s| !s.is_empty()),
        realtime,
    };
    let inst = match manager::start_instance(spec) {
        Ok(i) => i,
        Err(e) => {
            if realtime {
                manager::push_event(json!({ "event": "plugin", "kind": "loadFailed", "key": key, "pluginId": id, "message": format!("{} couldn't load: {e}", entry.desc.name) }));
            } else {
                eprintln!("[plugins] {} couldn't load: {e}", entry.desc.name);
            }
            return None;
        }
    };
    if !realtime {
        // Offline renders wait for the plugin so the first bars aren't silent.
        if let Err(e) = inst.wait_loaded(Duration::from_secs(60)) {
            eprintln!("[plugins] {}: {e}", entry.desc.name);
        }
    }
    let init = initial_params(&entry, params);
    Some(remote::Core::new(inst, entry.param_ids.clone(), &init, sr, realtime))
}

/// Hook for `create_instrument` returning None: a remote proxy for a
/// registered `vst3:` / `clap:` instrument. `key` is the channel id;
/// `state` the base64 blob from `generator.state`; `params` the sparse doc
/// params (the plugin keeps its own values for the rest). `realtime` is
/// false for offline renders (which then wait for the plugin to load).
pub fn create_instrument(id: &str, key: &str, state: Option<&str>, params: &BTreeMap<String, f64>, sr: f32, realtime: bool) -> Option<Box<dyn Instrument>> {
    if !is_external_id(id) {
        return None;
    }
    let core = start(id, key, state, params, sr, realtime, "instrument")?;
    Some(Box::new(RemoteInstrument::new(core)))
}

/// Same for effects; `key` is "insertId/slotId".
pub fn create_effect(id: &str, key: &str, state: Option<&str>, params: &BTreeMap<String, f64>, sr: f32, realtime: bool) -> Option<Box<dyn Effect>> {
    if !is_external_id(id) {
        return None;
    }
    let core = start(id, key, state, params, sr, realtime, "effect")?;
    Some(Box::new(RemoteEffect::new(core)))
}

type Reply = Box<dyn FnOnce(Result<Value, String>) + Send>;

fn on_worker(f: impl FnOnce() + Send + 'static) {
    let _ = std::thread::Builder::new().name("plugins-cmd".into()).spawn(f);
}

/// `plugins.*` protocol commands. `reply` may run on another thread.
///
///   plugins.configure {hostExe?, ownerHwnd?}
///   plugins.register  {plugins:[descriptor…]}         → {registered, errors}
///   plugins.editor    {key, open, title?, ownerHwnd?}
///   plugins.states    {keys?}                          → {states:{key: base64}}
///   plugins.state     {key}                            → {state}
///   plugins.reload    {}                               (kills the host; the engine re-creates instances)
///   plugins.status    {}                               → {hostPid, instances:[…]}
pub fn handle_command(cmd: &str, v: &Value, reply: Reply) {
    match cmd {
        "plugins.configure" => {
            if let Some(p) = v.get("hostExe").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
                manager::set_host_exe(Some(PathBuf::from(p)));
            }
            if let Some(h) = hwnd_arg(v) {
                manager::set_owner_hwnd(h);
            }
            reply(Ok(json!({})));
        }
        "plugins.register" => {
            let (n, errs) = registry::register_json(v.get("plugins").unwrap_or(&Value::Null));
            // Channels whose plugin just became known must be (re)built.
            manager::request_retry();
            reply(Ok(json!({ "registered": n, "errors": errs })));
        }
        "plugins.editor" => {
            let key = v.get("key").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let open = v.get("open").and_then(|x| x.as_bool()).unwrap_or(true);
            let Some(inst) = manager::live_instance(&key) else {
                reply(Err("That plugin isn't loaded in the engine (yet)".into()));
                return;
            };
            if inst.is_dead() {
                reply(Err(format!("{} is not running (it crashed or failed to load). Use Reload plugins.", inst.name)));
                return;
            }
            let owner = hwnd_arg(v).unwrap_or_else(manager::owner_hwnd);
            let title = v.get("title").and_then(|x| x.as_str()).unwrap_or(&inst.name).to_string();
            let args = json!({ "inst": inst.id, "owner": owner.to_string(), "title": title });
            let conn = inst.conn.clone();
            conn.send_async(if open { "openEditor" } else { "closeEditor" }, args, Some(reply));
        }
        "plugins.state" => {
            let key = v.get("key").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let Some(inst) = manager::live_instance(&key) else {
                reply(Err("That plugin isn't loaded in the engine".into()));
                return;
            };
            on_worker(move || {
                let r = inst.conn.request("getState", json!({ "inst": inst.id }), Duration::from_secs(10));
                reply(r);
            });
        }
        "plugins.states" => {
            let only: Option<Vec<String>> = v.get("keys").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).collect());
            let insts: Vec<_> = manager::live_instances().into_iter().filter(|i| !i.is_dead()).filter(|i| only.as_ref().map(|o| o.contains(&i.key)).unwrap_or(true)).collect();
            on_worker(move || {
                let mut states = serde_json::Map::new();
                let mut errors = Vec::new();
                for i in insts {
                    if i.chan.map.block().state.load(std::sync::atomic::Ordering::Acquire) != shm::state::READY {
                        continue;
                    }
                    match i.conn.request("getState", json!({ "inst": i.id }), Duration::from_secs(10)) {
                        Ok(d) => {
                            if let Some(s) = d.get("state").and_then(|x| x.as_str()) {
                                states.insert(i.key.clone(), json!(s));
                            }
                        }
                        Err(e) => errors.push(format!("{}: {e}", i.name)),
                    }
                }
                reply(Ok(json!({ "states": states, "errors": errors })));
            });
        }
        "plugins.reload" => {
            on_worker(move || {
                manager::kill_host("reload");
                manager::request_reload();
                reply(Ok(json!({})));
            });
        }
        "plugins.status" => reply(Ok(manager::status())),
        other => reply(Err(format!("Unknown command '{other}'"))),
    }
}

fn hwnd_arg(v: &Value) -> Option<u64> {
    let h = v.get("ownerHwnd")?;
    h.as_u64().or_else(|| h.as_str().and_then(|s| s.parse::<u64>().ok()))
}
