use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use ort::environment::Environment;
use ort::ep;
use ort::logging::LogLevel;
use ort::session::Session;

#[cfg(windows)]
pub const DYLIB: &str = "onnxruntime.dll";
#[cfg(target_os = "macos")]
pub const DYLIB: &str = "libonnxruntime.dylib";
#[cfg(all(unix, not(target_os = "macos")))]
pub const DYLIB: &str = "libonnxruntime.so";
const DIRECTML_DLL: &str = "DirectML.dll";
const SIDE_BY_SIDE: &[&str] = &["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll", DIRECTML_DLL];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Cpu,
    DirectMl,
}

impl Device {
    pub fn id(self) -> &'static str {
        match self {
            Device::Cpu => "cpu",
            Device::DirectMl => "directml",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Device::Cpu => "CPU",
            Device::DirectMl => "DirectML",
        }
    }
}

pub struct Runtime {
    pub dylib: PathBuf,
    has_directml_dll: bool,
}

static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();
static DIRECTML: OnceLock<Result<(), String>> = OnceLock::new();

pub fn default_dylib_path() -> PathBuf {
    let beside_exe = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(DYLIB))).unwrap_or_else(|| PathBuf::from(DYLIB));
    if beside_exe.is_file() {
        return beside_exe;
    }
    std::env::var_os("ORT_DYLIB_PATH").filter(|p| !p.is_empty()).map(PathBuf::from).unwrap_or(beside_exe)
}

pub fn runtime() -> Result<&'static Runtime, String> {
    runtime_from(&default_dylib_path())
}

pub fn runtime_from(path: &Path) -> Result<&'static Runtime, String> {
    RUNTIME.get_or_init(|| guard("loading ONNX Runtime", || init(path))).as_ref().map_err(Clone::clone)
}

fn init(path: &Path) -> Result<Runtime, String> {
    if !path.is_file() {
        return Err(format!(
            "ONNX Runtime is missing ({} not found). Stem separation needs it; reinstall Krypt Studio to restore it.",
            path.display()
        ));
    }
    let dir = path.parent().unwrap_or(Path::new("."));
    for name in SIDE_BY_SIDE {
        let p = dir.join(name);
        if p.is_file() {
            match unsafe { libloading::Library::new(&p) } {
                Ok(lib) => std::mem::forget(lib),
                Err(e) => eprintln!("[separate] could not pre-load {}: {e}", p.display()),
            }
        }
    }
    let builder = ort::init_from(path).map_err(|e| format!("ONNX Runtime ({}) could not be loaded: {e}", path.display()))?;
    builder
        .with_name("krypt-studio-analyzer")
        .with_telemetry(false)
        .with_logger(Arc::new(|level, _category, _id, location, message| {
            if level >= LogLevel::Warning {
                eprintln!("[onnxruntime {level:?}] {message} ({location})");
            }
        }))
        .commit();
    let env = Environment::current().map_err(|e| format!("ONNX Runtime ({}) did not initialise: {e}", path.display()))?;
    env.set_log_level(if std::env::var_os("ORT_LOG").is_some() { LogLevel::Verbose } else { LogLevel::Warning });
    Ok(Runtime { dylib: path.to_path_buf(), has_directml_dll: dir.join(DIRECTML_DLL).is_file() })
}

pub fn directml() -> Result<(), String> {
    DIRECTML
        .get_or_init(|| {
            let rt = runtime()?;
            if !rt.has_directml_dll {
                return Err(format!("{DIRECTML_DLL} is not installed next to {}", rt.dylib.display()));
            }
            if ep::directml::api().is_none() {
                return Err("this ONNX Runtime build has no DirectML support".into());
            }
            guard("probing DirectML", || {
                let b = Session::builder().map_err(|e| e.to_string())?;
                b.with_execution_providers([directml_ep()]).map_err(|e| e.to_string())?;
                Ok(())
            })
        })
        .clone()
}

pub(crate) fn directml_ep() -> ep::ExecutionProviderDispatch {
    ep::DirectML::default()
        .with_device_filter(ep::directml::DeviceFilter::Gpu)
        .with_performance_preference(ep::directml::PerformancePreference::HighPerformance)
        .build()
        .error_on_failure()
}

pub fn session(model: &[u8], weights_dir: &Path, device: Device) -> Result<Session, String> {
    runtime()?;
    if device == Device::DirectMl {
        directml()?;
    }
    let dir = weights_dir.to_str().ok_or_else(|| format!("Model folder path is not valid Unicode: {}", weights_dir.display()))?;
    guard("creating the inference session", || {
        let e = |e: ort::Error<ort::session::builder::SessionBuilder>| e.to_string();
        let mut b = Session::builder()
            .map_err(|e| e.to_string())?
            .with_config_entry("session.model_external_initializers_file_folder_path", dir)
            .map_err(e)?
            .with_memory_pattern(false)
            .map_err(e)?;
        let cpu = ep::CPU::default().with_arena_allocator(false).build();
        if device == Device::Cpu {
            b = b.with_execution_providers([cpu]).map_err(e)?;
        } else {
            b = b
                .with_config_entry("ep.dml.disable_graph_fusion", "1")
                .map_err(e)?
                .with_parallel_execution(false)
                .map_err(e)?
                .with_execution_providers([directml_ep(), cpu])
                .map_err(e)?;
        }
        b.commit_from_memory(model).map_err(|e| e.to_string())
    })
}

pub(crate) fn guard<T>(what: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(p) => {
            let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            Err(format!("Internal error while {what}: {msg}"))
        }
    }
}
