use krypt_studio_dsp::{NoteExtras, ProcessContext};
use krypt_studio_pluginclient as pc;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn env() -> Option<(String, String)> {
    Some((std::env::var("KRYPT_PLUGINHOST").ok()?, std::env::var("KRYPT_TEST_CLAP").ok()?))
}

fn setup() -> Option<()> {
    let (host, clap) = env()?;
    pc::manager::set_host_exe(Some(host.clone().into()));
    let out = std::process::Command::new(&host).arg("--scan").arg(&clap).output().expect("run scanner");
    let text = String::from_utf8_lossy(&out.stdout);
    let last: Value = serde_json::from_str(text.lines().last().expect("scan output")).expect("scan json");
    assert_eq!(last["ok"], json!(true), "scan failed: {last}");
    let (n, errs) = pc::registry::register_json(&last["plugins"]);
    assert!(errs.is_empty(), "{errs:?}");
    assert_eq!(n, 2);
    Some(())
}

fn ctx(frames: usize) -> ProcessContext {
    ProcessContext { sample_rate: 48000.0, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames }
}

fn cmd(c: &str, v: Value) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel();
    pc::handle_command(c, &v, Box::new(move |r| tx.send(r).unwrap()));
    rx.recv_timeout(Duration::from_secs(20)).expect("command reply")
}

fn wait_ready(e: &mut dyn FnMut() -> bool) {
    let t0 = Instant::now();
    while !e() {
        assert!(t0.elapsed() < Duration::from_secs(20), "plugin never became ready");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn clap_end_to_end() {
    if setup().is_none() {
        eprintln!("skipped: set KRYPT_PLUGINHOST and KRYPT_TEST_CLAP");
        return;
    }

    let mut params = BTreeMap::new();
    params.insert("1".to_string(), 0.5);
    let mut fx = pc::create_effect("clap:cc.krypt.test.gain", "ins1/slot1", None, &params, 48000.0, false).expect("gain");
    let mut l = vec![0.8f32; 32];
    let mut r = vec![-0.4f32; 32];
    fx.process(&ctx(32), [&mut l, &mut r], None);
    assert!((l[31] - 0.4).abs() < 1e-6 && (r[31] + 0.2).abs() < 1e-6, "gain 0.5 → got {} {}", l[31], r[31]);
    fx.set_param(0, 2.0);
    let mut l = vec![0.25f32; 32];
    let mut r = vec![0.25f32; 32];
    fx.process(&ctx(32), [&mut l, &mut r], None);
    assert!((l[0] - 0.5).abs() < 1e-6, "gain 2 → {}", l[0]);
    drop(fx);

    let mut inst = pc::create_instrument("clap:cc.krypt.test.sine", "ch-sine", None, &BTreeMap::new(), 48000.0, true).expect("sine");
    let mut ready = false;
    let mut silent = true;
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(10) && silent {
        if !ready {
            inst.note_on(0, 69, 69.0, 1.0, NoteExtras::default());
            ready = true;
        }
        let (mut a, mut b) = (vec![0f32; 32], vec![0f32; 32]);
        inst.process(&ctx(32), [&mut a, &mut b]);
        if a.iter().any(|x| x.abs() > 0.01) {
            silent = false;
        } else {
            ready = false;
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    assert!(!silent, "the sine never produced audio");

    let mut fx = pc::create_effect("clap:cc.krypt.test.gain", "ins2/slot1", None, &BTreeMap::new(), 48000.0, true).expect("gain live");
    wait_ready(&mut || pc::manager::live_instance("ins2/slot1").map(|i| i.chan.map.block().state.load(std::sync::atomic::Ordering::Acquire) == pc::shm::state::READY).unwrap_or(false));
    let (mut a, mut b) = (vec![1f32; 32], vec![1f32; 32]);
    fx.process(&ctx(32), [&mut a, &mut b], None);
    fx.set_param(0, 0.25);
    fx.process(&ctx(32), [&mut a, &mut b], None);
    let st = cmd("plugins.state", json!({ "key": "ins2/slot1" })).expect("state");
    let blob = st["state"].as_str().expect("state string").to_string();
    let bytes = pc::b64::decode(&blob).unwrap();
    assert_eq!(&bytes[..4], b"KGAN");
    eprintln!("saved gain = {}", f32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]));
    let all = cmd("plugins.states", json!({})).expect("states");
    assert!(all["states"]["ins2/slot1"].is_string(), "{all}");
    let mut fx2 = pc::create_effect("clap:cc.krypt.test.gain", "ins3/slot1", Some(&blob), &BTreeMap::new(), 48000.0, false).expect("restored");
    let (mut a, mut b) = (vec![1f32; 32], vec![1f32; 32]);
    fx2.process(&ctx(32), [&mut a, &mut b], None);
    assert!((a[0] - 0.25).abs() < 1e-6, "restored gain → {}", a[0]);

    vst3_checks();

    let s = cmd("plugins.status", json!({})).unwrap();
    assert!(s["hostPid"].is_u64(), "{s}");

    let _ = pc::drain_events();
    fx.set_param(2, 1.0);
    let (mut a, mut b) = (vec![1f32; 32], vec![1f32; 32]);
    fx.process(&ctx(32), [&mut a, &mut b], None);
    let t0 = Instant::now();
    let mut crashed = None;
    while t0.elapsed() < Duration::from_secs(10) && crashed.is_none() {
        crashed = pc::drain_events().into_iter().find(|e| e["kind"] == json!("crashed"));
        std::thread::sleep(Duration::from_millis(20));
    }
    let crashed = crashed.expect("a crash event");
    eprintln!("crash event: {crashed}");
    assert!(crashed["message"].as_str().unwrap().contains("Krypt Test Gain"));
    let (mut a, mut b) = (vec![1f32; 32], vec![1f32; 32]);
    let t = Instant::now();
    fx.process(&ctx(32), [&mut a, &mut b], None);
    assert!(t.elapsed() < Duration::from_millis(5));
    assert!(a.iter().all(|x| *x == 0.0), "a crashed effect must be silent");
    let (mut a, mut b) = (vec![0f32; 32], vec![0f32; 32]);
    inst.process(&ctx(32), [&mut a, &mut b]);
    assert!(a.iter().all(|x| *x == 0.0));

    cmd("plugins.reload", json!({})).unwrap();
    assert!(pc::take_reload_request());
    let mut fx3 = pc::create_effect("clap:cc.krypt.test.gain", "ins4/slot1", Some(&blob), &BTreeMap::new(), 48000.0, false).expect("after reload");
    let (mut a, mut b) = (vec![1f32; 32], vec![1f32; 32]);
    fx3.process(&ctx(32), [&mut a, &mut b], None);
    assert!((a[0] - 0.25).abs() < 1e-6, "after reload → {}", a[0]);
    drop(fx3);

    let _ = pc::drain_events();
    let _ = pc::take_reload_request();
    let mut fx4 = pc::create_effect("clap:cc.krypt.test.gain", "ins5/slot1", None, &BTreeMap::new(), 48000.0, true).expect("gain for hang");
    wait_ready(&mut || pc::manager::live_instance("ins5/slot1").map(|i| i.chan.map.block().state.load(std::sync::atomic::Ordering::Acquire) == pc::shm::state::READY).unwrap_or(false));
    let (mut a, mut b) = (vec![1f32; 32], vec![1f32; 32]);
    fx4.process(&ctx(32), [&mut a, &mut b], None);
    fx4.set_param(1, 1.0);
    let t0 = Instant::now();
    let mut hung = None;
    let mut worst = Duration::ZERO;
    while t0.elapsed() < Duration::from_secs(15) && hung.is_none() {
        let (mut a, mut b) = (vec![1f32; 32], vec![1f32; 32]);
        let t = Instant::now();
        fx4.process(&ctx(32), [&mut a, &mut b], None);
        worst = worst.max(t.elapsed());
        hung = pc::drain_events().into_iter().find(|e| e["kind"] == json!("crashed"));
        std::thread::sleep(Duration::from_micros(660));
    }
    let hung = hung.expect("the watchdog should report the hang");
    eprintln!("hang event: {hung} (worst process() call {worst:?})");
    assert_eq!(hung["reloading"], json!(true));
    assert!(worst < Duration::from_millis(60), "a hung plugin must not block the engine for long ({worst:?})");
    assert!(pc::take_reload_request(), "a hang triggers an automatic reload");
}

fn vst3_checks() {
    let Ok(bundle) = std::env::var("KRYPT_TEST_VST3") else {
        eprintln!("VST3 checks skipped: set KRYPT_TEST_VST3");
        return;
    };
    let host = std::env::var("KRYPT_PLUGINHOST").unwrap();
    let out = std::process::Command::new(&host).arg("--scan").arg(&bundle).output().expect("run scanner");
    let text = String::from_utf8_lossy(&out.stdout);
    let lines: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    assert_eq!(lines.len(), 2, "moduleinfo line + full line expected: {text}");
    assert_eq!(lines[0]["plugins"][0]["fromModuleInfo"], json!(true));
    assert_eq!(lines[0]["plugins"][0]["kind"], json!("effect"));
    let full = &lines[1];
    assert_eq!(full["plugins"][0]["id"], lines[0]["plugins"][0]["id"], "moduleinfo CID must match the loaded class");
    assert_eq!(full["plugins"][0]["params"][0]["name"], json!("Gain"));
    let (n, errs) = pc::registry::register_json(&full["plugins"]);
    assert!(errs.is_empty() && n == 1, "{errs:?}");
    let id = full["plugins"][0]["id"].as_str().unwrap().to_string();

    let mut params = BTreeMap::new();
    params.insert("0".to_string(), 0.5);
    let mut fx = pc::create_effect(&id, "vins/s", None, &params, 48000.0, false).expect("vst3 gain");
    let (mut a, mut b) = (vec![0.8f32; 32], vec![0.8f32; 32]);
    fx.process(&ctx(32), [&mut a, &mut b], None);
    assert!((a[31] - 0.4).abs() < 1e-6, "vst3 gain 0.5 → {}", a[31]);
    drop(fx);

    let _fx = {
        let mut fx = pc::create_effect(&id, "vins/live", None, &BTreeMap::new(), 48000.0, true).expect("vst3 live");
        wait_ready(&mut || pc::manager::live_instance("vins/live").map(|i| i.chan.map.block().state.load(std::sync::atomic::Ordering::Acquire) == pc::shm::state::READY).unwrap_or(false));
        let (mut a, mut b) = (vec![1f32; 32], vec![1f32; 32]);
        fx.process(&ctx(32), [&mut a, &mut b], None);
        fx.set_param(0, 0.25);
        fx.process(&ctx(32), [&mut a, &mut b], None);
        assert!((a[0] - 0.25).abs() < 1e-6, "vst3 live gain → {}", a[0]);
        fx
    };
    let st = cmd("plugins.state", json!({ "key": "vins/live" })).expect("vst3 state");
    let blob = st["state"].as_str().unwrap().to_string();
    assert_eq!(&pc::b64::decode(&blob).unwrap()[..4], b"KV3S");
    let mut fx2 = pc::create_effect(&id, "vins/restored", Some(&blob), &BTreeMap::new(), 48000.0, false).expect("vst3 restored");
    let (mut a, mut b) = (vec![1f32; 32], vec![1f32; 32]);
    fx2.process(&ctx(32), [&mut a, &mut b], None);
    assert!((a[0] - 0.25).abs() < 1e-6, "vst3 restored gain → {}", a[0]);
    eprintln!("VST3 checks passed ({id})");
}
