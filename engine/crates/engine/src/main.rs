use krypt_studio_engine::audio::DeviceManager;
use krypt_studio_engine::compile::Names;
use krypt_studio_engine::control::{Engine, EngineParts};
use krypt_studio_engine::core::{Core, Shared};
use krypt_studio_engine::model::{Model, Warnings};
use krypt_studio_engine::plugins::{catalog_text, PluginHost};
use krypt_studio_engine::protocol::{Out, OutMode, RenderRequest, RenderScope, ENGINE_VERSION};
use krypt_studio_engine::render::{run_render, RenderEnv};
use krypt_studio_engine::rt::{self, TryCell};
use krypt_studio_engine::samples::SampleCache;
use krypt_studio_engine::{telemetry, watchdog};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

const USAGE: &str = "krypt-studio-engine — Krypt Studio audio engine

USAGE:
  krypt-studio-engine [--parent-pid <pid>] [--factory-dir <dir>] [--packs-dir <dir>] [--no-audio]
      Run the NDJSON stdio protocol (docs/ENGINE_PROTOCOL.md).
      --packs-dir: the installed sound packs (userData/packs); `pack:<id>/<path>` samples resolve there.
  krypt-studio-engine --dump-catalog
  krypt-studio-engine --gen-factory <dir>
      Write the factory sounds (legacy kit, library, index.json); prints a JSON summary.
  krypt-studio-engine --render <project.json> --out <file.wav|file.mp3> [--scope song|pattern|range]
      [--pattern <id>] [--start <tick> --end <tick>] [--format wav16|wav24|wav32f|mp3]
      [--mp3-kbps 128|192|256|320] [--sample-rate <hz>] [--tail <sec>] [--loops <n>] [--analyze] [--stems]
      [--factory-dir <dir>] [--packs-dir <dir>] [--plugins <scan-cache.json>] [--plugin-host <krypt-studio-pluginhost.exe>]
      The format defaults to mp3 for an --out ending in .mp3, wav24 otherwise.
  krypt-studio-engine --version";

#[derive(Default)]
struct Args {
    version: bool,
    help: bool,
    dump_catalog: bool,
    gen_factory: Option<String>,
    render: Option<String>,
    out: Option<String>,
    scope: Option<String>,
    pattern: Option<String>,
    start: Option<f64>,
    end: Option<f64>,
    format: Option<String>,
    mp3_kbps: Option<f64>,
    sample_rate: Option<f64>,
    tail: Option<f64>,
    loops: Option<f64>,
    analyze: bool,
    stems: bool,
    parent_pid: Option<u32>,
    factory_dir: Option<String>,
    packs_dir: Option<String>,
    no_audio: bool,
    plugins: Option<String>,
    plugin_host: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    fn val(it: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
        it.next().ok_or_else(|| format!("{flag} needs a value"))
    }
    fn num(it: &mut impl Iterator<Item = String>, flag: &str) -> Result<f64, String> {
        let v = val(it, flag)?;
        v.parse::<f64>().map_err(|_| format!("{flag}: '{v}' is not a number"))
    }
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--version" | "-V" => a.version = true,
            "--help" | "-h" => a.help = true,
            "--dump-catalog" => a.dump_catalog = true,
            "--gen-factory" => a.gen_factory = Some(val(&mut it, &arg)?),
            "--render" => a.render = Some(val(&mut it, &arg)?),
            "--out" => a.out = Some(val(&mut it, &arg)?),
            "--scope" => a.scope = Some(val(&mut it, &arg)?),
            "--pattern" => a.pattern = Some(val(&mut it, &arg)?),
            "--start" => a.start = Some(num(&mut it, &arg)?),
            "--end" => a.end = Some(num(&mut it, &arg)?),
            "--format" => a.format = Some(val(&mut it, &arg)?),
            "--mp3-kbps" => a.mp3_kbps = Some(num(&mut it, &arg)?),
            "--sample-rate" => a.sample_rate = Some(num(&mut it, &arg)?),
            "--tail" => a.tail = Some(num(&mut it, &arg)?),
            "--loops" => a.loops = Some(num(&mut it, &arg)?),
            "--analyze" => a.analyze = true,
            "--stems" => a.stems = true,
            "--parent-pid" => {
                let v = val(&mut it, &arg)?;
                a.parent_pid = Some(v.parse().map_err(|_| format!("--parent-pid: '{v}' is not a pid"))?);
            }
            "--factory-dir" => a.factory_dir = Some(val(&mut it, &arg)?),
            "--packs-dir" => a.packs_dir = Some(val(&mut it, &arg)?),
            "--no-audio" => a.no_audio = true,
            "--plugins" => a.plugins = Some(val(&mut it, &arg)?),
            "--plugin-host" => a.plugin_host = Some(val(&mut it, &arg)?),
            other => return Err(format!("Unknown argument '{other}'\n\n{USAGE}")),
        }
    }
    Ok(a)
}

fn default_factory_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("..").join("factory")))
        .unwrap_or_else(|| PathBuf::from("factory"))
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    if args.help {
        println!("{USAGE}");
        return;
    }
    if args.version {
        println!("krypt-studio-engine {ENGINE_VERSION}");
        return;
    }
    let host = PluginHost::stock();
    let factory_dir = args.factory_dir.as_ref().map(PathBuf::from).unwrap_or_else(default_factory_dir);

    if args.dump_catalog {
        println!("{}", catalog_text(&host));
        return;
    }
    if let Some(dir) = &args.gen_factory {
        let generator = format!("krypt-studio-engine {ENGINE_VERSION}");
        match krypt_studio_dsp::factory::generate_factory(Path::new(dir), &generator) {
            Ok(rep) => {
                let verbose = std::env::var("KRYPT_FACTORY_VERBOSE").is_ok_and(|v| v == "1");
                eprint!("{}", rep.table(verbose));
                let list: Vec<String> = rep.files.iter().map(|f| f.path.display().to_string()).collect();
                let folders: serde_json::Map<String, serde_json::Value> = rep
                    .folder_counts()
                    .into_iter()
                    .map(|(k, n, b)| (k, serde_json::json!({ "files": n, "bytes": b })))
                    .collect();
                let mb = rep.total_bytes as f64 / (1024.0 * 1024.0);
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "dir": dir,
                        "index": rep.index_path.display().to_string(),
                        "count": rep.files.len(),
                        "folders": folders,
                        "totalBytes": rep.total_bytes,
                        "totalMb": (mb * 100.0).round() / 100.0,
                        "seconds": (rep.seconds * 10.0).round() / 10.0,
                        "removed": rep.removed.len(),
                        "files": list,
                    })
                );
            }
            Err(e) => {
                eprintln!("Failed to generate the factory sounds in {dir}: {e}");
                std::process::exit(1);
            }
        }
        return;
    }
    if let Some(p) = &args.plugin_host {
        krypt_studio_pluginclient::manager::set_host_exe(Some(PathBuf::from(p)));
    }
    if let Some(f) = &args.plugins {
        match krypt_studio_pluginclient::register_file(Path::new(f)) {
            Ok(n) => eprintln!("[info] registered {n} third-party plugins from {f}"),
            Err(e) => eprintln!("[warn] {e}"),
        }
    }
    if let Some(project) = &args.render {
        std::process::exit(cli_render(&args, project, host, factory_dir));
    }
    run_engine(&args, host, factory_dir);
}

fn cli_render(args: &Args, project: &str, host: PluginHost, factory_dir: PathBuf) -> i32 {
    let Some(out_path) = args.out.clone() else {
        eprintln!("--render needs --out <file.wav|file.mp3>");
        return 2;
    };
    let text = match std::fs::read_to_string(project) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Cannot read {project}: {e}");
            return 1;
        }
    };
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{project} is not valid JSON: {e}");
            return 1;
        }
    };
    let mut w = Warnings::default();
    let model = Model::from_project(&v, &mut w);
    for m in w.drain_messages() {
        eprintln!("[warn] {m}");
    }
    let scope = match args.scope.as_deref().unwrap_or(if args.start.is_some() { "range" } else { "song" }) {
        "song" => RenderScope::Song,
        "pattern" => RenderScope::Pattern { pattern_id: args.pattern.clone() },
        "range" => match (args.start, args.end) {
            (Some(s), Some(e)) => RenderScope::Range { start_tick: s, end_tick: e },
            _ => {
                eprintln!("--scope range needs --start <tick> and --end <tick>");
                return 2;
            }
        },
        other => {
            eprintln!("Unknown --scope '{other}' (song, pattern or range)");
            return 2;
        }
    };
    let out_abs = std::path::absolute(&out_path).map(|p| p.display().to_string()).unwrap_or(out_path);
    let is_mp3 = !args.stems && Path::new(&out_abs).extension().is_some_and(|e| e.eq_ignore_ascii_case("mp3"));
    let req = RenderRequest {
        path: out_abs,
        scope,
        format: args.format.clone().unwrap_or_else(|| if is_mp3 { "mp3" } else { "wav24" }.into()),
        sample_rate: args.sample_rate,
        tail_sec: args.tail,
        analyze: Some(args.analyze),
        stems: args.stems.then_some(true),
        stem_inserts: None,
        loops: args.loops,
        normalize: None,
        mp3_kbps: args.mp3_kbps,
    };
    let base_dir = Path::new(project).parent().map(|p| p.to_path_buf());
    let mut progress = |_p: f64| {};
    let mut log = |level: &str, m: String| eprintln!("[{level}] {m}");
    let mut env = RenderEnv {
        host,
        cache: Arc::new(SampleCache::new()),
        factory_dir,
        packs_dir: args.packs_dir.as_ref().map(PathBuf::from),
        base_dir,
        cancel: Arc::new(AtomicBool::new(false)),
        default_sr: 48000.0,
        progress: &mut progress,
        log: &mut log,
    };
    let t = std::time::Instant::now();
    match run_render(&model, &req, &mut env) {
        Ok(r) => {
            eprintln!("[info] rendered {:.2} s of audio in {:.2} s", r.duration_sec, t.elapsed().as_secs_f64());
            println!("{}", serde_json::to_string(&r).unwrap_or_default());
            0
        }
        Err(e) => {
            eprintln!("Render failed: {e}");
            1
        }
    }
}

fn run_engine(args: &Args, host: PluginHost, factory_dir: PathBuf) {
    let out = Arc::new(Out::new(OutMode::Protocol));
    rt::disable_power_throttling();
    if let Some(pid) = args.parent_pid {
        watchdog::spawn_parent_watchdog(pid, out.clone());
    }
    let shared = Arc::new(Shared::new());
    let (cmd_tx, cmd_rx) = rtrb::RingBuffer::new(1024);
    let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(4096);
    let (spec_tx, spec_rx) = rtrb::RingBuffer::new(1 << 15);
    let mut core = Core::new(48000.0, shared.clone(), Some(cmd_rx), Some(garbage_tx), Some(spec_tx));
    krypt_studio_engine::midi::init_clock();
    let (live_rt, live_ctl) = krypt_studio_engine::record::live_channels(shared.live.clone());
    core.live.attach(live_rt);
    if let Some(ends) = shared.clock.take_rt() {
        core.clock.attach(ends);
    }
    let core = Arc::new(TryCell::new(core));
    let names = Arc::new(Mutex::new(Names::default()));
    let telemetry = match telemetry::start(shared.clone(), names.clone(), spec_rx, out.clone()) {
        Ok(t) => t,
        Err(e) => {
            out.log("error", format!("Telemetry server failed to start: {e}"));
            telemetry::TelemetryInfo { port: 0, token: String::new() }
        }
    };
    let device = DeviceManager::start(core.clone(), out.clone(), !args.no_audio);
    let engine = Engine::new(EngineParts {
        out: out.clone(),
        host,
        cache: Arc::new(SampleCache::new()),
        factory_dir,
        packs_dir: args.packs_dir.as_ref().map(PathBuf::from),
        shared,
        core,
        cmd_tx,
        garbage_rx,
        device,
        telemetry,
        names,
        live: live_ctl,
    });
    engine.run();
}
