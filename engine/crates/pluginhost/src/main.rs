//! krypt-studio-pluginhost — runs third-party VST3 and CLAP plugins OUT OF
//! the audio engine's process, so a crashing or hanging plugin can never
//! take down the engine or the app (research/03 §2.3, §2.5).
//!
//!   krypt-studio-pluginhost --serve [--parent-pid <pid>]
//!       Host plugins for the engine: NDJSON control on stdin/stdout, audio
//!       through per-instance shared memory (see krypt-studio-pluginclient).
//!   krypt-studio-pluginhost --scan <file.vst3|file.clap>
//!       Describe the plugins in one file as JSON lines on stdout.
//!
//! VST2 is not supported (no licence is obtainable; research/03 §2.1).

#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod clap_host;
#[cfg(windows)]
mod scan;
#[cfg(windows)]
mod serve;
#[cfg(windows)]
mod vst3_com;
#[cfg(windows)]
mod vst3_host;
#[cfg(windows)]
mod win;
#[cfg(windows)]
mod wire;

const USAGE: &str = "krypt-studio-pluginhost — Krypt Studio plugin host (VST3 + CLAP)

USAGE:
  krypt-studio-pluginhost --serve [--parent-pid <pid>]
  krypt-studio-pluginhost --scan <file.vst3|file.clap>
  krypt-studio-pluginhost --version";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut serve = false;
    let mut scan: Option<String> = None;
    let mut parent: Option<u32> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--serve" => serve = true,
            "--scan" => scan = it.next().cloned(),
            "--parent-pid" => parent = it.next().and_then(|p| p.parse().ok()),
            "--version" | "-V" => {
                println!("krypt-studio-pluginhost {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--help" | "-h" => {
                println!("{USAGE}");
                return;
            }
            other => {
                eprintln!("Unknown argument '{other}'\n\n{USAGE}");
                std::process::exit(2);
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(p) = scan {
            std::process::exit(scan::run(&p));
        }
        if serve {
            std::process::exit(serve::run(parent));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (serve, scan, parent);
        eprintln!("Plugin hosting is only available on Windows.");
        std::process::exit(1);
    }
    #[allow(unreachable_code)]
    {
        eprintln!("{USAGE}");
        std::process::exit(2);
    }
}
