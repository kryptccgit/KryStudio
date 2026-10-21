//! Exit when the parent (Electron main) dies: poll the process handle every 1 s.

use crate::protocol::Out;
use std::sync::Arc;

pub fn spawn_parent_watchdog(pid: u32, out: Arc<Out>) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        // SAFETY: plain Win32 calls with checked handles.
        let h = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if h.is_null() {
            let err = unsafe { GetLastError() };
            if err == ERROR_INVALID_PARAMETER {
                eprintln!("[engine] parent process {pid} is not running; exiting");
                std::process::exit(0);
            }
            out.log("warn", format!("Cannot watch parent process {pid} (error {err}); relying on stdin EOF"));
            return;
        }
        let h = h as usize;
        let _ = std::thread::Builder::new().name("parent-watchdog".into()).spawn(move || {
            let h = h as windows_sys::Win32::Foundation::HANDLE;
            loop {
                let r = unsafe { WaitForSingleObject(h, 1000) };
                if r == WAIT_OBJECT_0 {
                    eprintln!("[engine] parent process {pid} exited; exiting");
                    unsafe { CloseHandle(h) };
                    std::process::exit(0);
                }
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, out);
    }
}
