//! krypt-studio-analyzer.exe — NDJSON over stdio (docs/ANALYZER_PROTOCOL.md).
//! stdout carries protocol lines only; diagnostics go to stderr.

use std::io::BufRead;
use std::sync::Arc;

use krypt_studio_analyzer::runner::{self, End, Real};

fn main() {
    // rten prints debug output to *stdout* when these are set; stdout is the
    // protocol channel, so never let an inherited variable switch them on.
    for var in ["RTEN_TIMING", "RTEN_INFER_SHAPES_DEBUG", "RTEN_OPTIMIZER_DEBUG"] {
        if std::env::var_os(var).is_some() {
            eprintln!("analyzer: ignoring {var} (it would write to the protocol stream)");
            std::env::remove_var(var);
        }
    }
    let stdin = std::io::stdin();
    let lines = stdin.lock().lines().map_while(Result::ok);
    let end = runner::serve(lines, runner::stdout_sink(), Arc::new(Real));
    if end == End::Eof {
        eprintln!("analyzer: stdin closed; exiting");
    }
    // Exit now even if a cancelled job is still unwinding on another thread.
    std::process::exit(0);
}
