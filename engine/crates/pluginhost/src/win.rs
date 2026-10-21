//! Win32 plumbing for the host's UI thread: the hidden message window that
//! drives the server, the message loop, and plugin editor containers —
//! top-level windows OWNED by the Electron main window (research/03 §2.6.3
//! option A): they float above it, minimize with it and have no taskbar
//! button. Container messages are forwarded to the server as posted
//! messages, never handled re-entrantly.

#![allow(clippy::missing_safety_doc)]

use std::sync::atomic::{AtomicIsize, Ordering::*};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
use windows_sys::Win32::Graphics::Gdi::{CreateSolidBrush, FillRect, HBRUSH};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

pub const WM_APP_WAKE: u32 = WM_APP + 1;
/// wParam = instance id: the user closed an editor container.
pub const WM_APP_CLOSE: u32 = WM_APP + 2;
/// wParam = instance id, lParam = MAKELONG(width, height): container resized by the user.
pub const WM_APP_RESIZED: u32 = WM_APP + 3;
pub const TIMER_ID: usize = 1;

static MSG_HWND: AtomicIsize = AtomicIsize::new(0);

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn msg_hwnd() -> HWND {
    MSG_HWND.load(Acquire) as HWND
}

/// Wake the UI thread (any thread).
pub fn wake() {
    let h = msg_hwnd();
    if !h.is_null() {
        // SAFETY: posting to our own window; harmless if it is gone.
        unsafe { PostMessageW(h, WM_APP_WAKE, 0, 0) };
    }
}

fn hinstance() -> windows_sys::Win32::Foundation::HINSTANCE {
    // SAFETY: the exe's own module handle.
    unsafe { GetModuleHandleW(std::ptr::null()) }
}

/// Create the hidden message-only window that receives wake-ups and the timer.
pub fn create_message_window(proc: WNDPROC) -> Result<HWND, String> {
    let class = wide("KryptStudioPluginHostMsg");
    // SAFETY: plain Win32 class registration + window creation.
    unsafe {
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: proc,
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance(),
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        RegisterClassW(&wc);
        let h = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 0, 0, HWND_MESSAGE, std::ptr::null_mut(), hinstance(), std::ptr::null());
        if h.is_null() {
            return Err(format!("CreateWindowEx (message window) failed: {}", std::io::Error::last_os_error()));
        }
        MSG_HWND.store(h as isize, Release);
        SetTimer(h, TIMER_ID, 15, None);
        Ok(h)
    }
}

/// Standard message loop; returns on WM_QUIT.
pub fn run_loop() {
    // SAFETY: standard Win32 message pump on the thread that owns our windows.
    unsafe {
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

pub fn quit() {
    // SAFETY: posts WM_QUIT to the calling (UI) thread.
    unsafe { PostQuitMessage(0) };
}

// ── Editor containers ────────────────────────────────────────────────────

static BG_BRUSH: AtomicIsize = AtomicIsize::new(0);

unsafe extern "system" fn container_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let inst = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as usize;
    match msg {
        WM_CLOSE => {
            // The server detaches the plugin view first, then destroys us.
            PostMessageW(msg_hwnd(), WM_APP_CLOSE, inst, 0);
            0
        }
        WM_SIZE => {
            if wp as u32 != SIZE_MINIMIZED {
                PostMessageW(msg_hwnd(), WM_APP_RESIZED, inst, lp);
            }
            0
        }
        WM_ERASEBKGND => {
            let mut r: RECT = std::mem::zeroed();
            GetClientRect(hwnd, &mut r);
            let dc = wp as windows_sys::Win32::Graphics::Gdi::HDC;
            let b = BG_BRUSH.load(Relaxed) as HBRUSH;
            if !b.is_null() {
                FillRect(dc, &r, b);
            }
            1
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

fn container_class() -> Vec<u16> {
    let class = wide("KryptStudioPluginEditor");
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: class registration with a static window procedure.
        unsafe {
            // #0A0A0F (Krypt void) as COLORREF 0x00BBGGRR.
            BG_BRUSH.store(CreateSolidBrush(0x000F_0A0A) as isize, Relaxed);
            let name = wide("KryptStudioPluginEditor");
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(container_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinstance(),
                hIcon: std::ptr::null_mut(),
                hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: name.as_ptr(),
            };
            RegisterClassW(&wc);
        }
    });
    class
}

fn style(resizable: bool) -> u32 {
    let mut s = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_CLIPCHILDREN;
    if resizable {
        s |= WS_THICKFRAME | WS_MAXIMIZEBOX;
    }
    s
}

/// A top-level editor container owned by `owner` (the Electron window),
/// sized so its CLIENT area is `w`×`h` physical pixels. Hidden until `show`.
pub fn create_container(owner: HWND, title: &str, w: u32, h: u32, resizable: bool, inst: u64) -> Result<HWND, String> {
    let class = container_class();
    let t = wide(title);
    let st = style(resizable);
    let ex = 0u32; // no taskbar button: owned windows don't get one
    // SAFETY: plain window creation; `owner` may be null (unowned fallback).
    unsafe {
        let mut r = RECT { left: 0, top: 0, right: w as i32, bottom: h as i32 };
        AdjustWindowRectEx(&mut r, st, 0, ex);
        let (ww, wh) = (r.right - r.left, r.bottom - r.top);
        // Centre over the owner (or the primary screen).
        let (mut x, mut y) = (CW_USEDEFAULT, CW_USEDEFAULT);
        if !owner.is_null() {
            let mut or: RECT = std::mem::zeroed();
            if GetWindowRect(owner, &mut or) != 0 {
                x = or.left + ((or.right - or.left) - ww).max(0) / 2;
                y = or.top + ((or.bottom - or.top) - wh).max(0) / 3;
            }
        }
        let hwnd = CreateWindowExW(ex, class.as_ptr(), t.as_ptr(), st, x, y, ww, wh, owner, std::ptr::null_mut(), hinstance(), std::ptr::null());
        if hwnd.is_null() {
            return Err(format!("Couldn't create the editor window: {}", std::io::Error::last_os_error()));
        }
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, inst as isize);
        // Dark caption to match the Krypt void (DWMWA_USE_IMMERSIVE_DARK_MODE = 20).
        let on: i32 = 1;
        DwmSetWindowAttribute(hwnd, 20, &on as *const i32 as *const core::ffi::c_void, 4);
        Ok(hwnd)
    }
}

pub fn show(hwnd: HWND) {
    // SAFETY: valid window.
    unsafe {
        ShowWindow(hwnd, SW_SHOWNORMAL);
        SetForegroundWindow(hwnd);
    }
}

pub fn destroy(hwnd: HWND) {
    // SAFETY: our own window (no-op if already gone).
    unsafe {
        if IsWindow(hwnd) != 0 {
            DestroyWindow(hwnd);
        }
    }
}

pub fn is_window(hwnd: HWND) -> bool {
    // SAFETY: IsWindow accepts any value.
    !hwnd.is_null() && unsafe { IsWindow(hwnd) != 0 }
}

/// Resize so the client area is `w`×`h`.
pub fn set_client_size(hwnd: HWND, w: u32, h: u32) {
    // SAFETY: valid window.
    unsafe {
        let st = GetWindowLongW(hwnd, GWL_STYLE) as u32;
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        let mut r = RECT { left: 0, top: 0, right: w as i32, bottom: h as i32 };
        AdjustWindowRectEx(&mut r, st, 0, ex);
        SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, r.right - r.left, r.bottom - r.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

/// DPI scale factor of a window (1.0 = 96 dpi).
pub fn scale(hwnd: HWND) -> f64 {
    // SAFETY: valid window; 0 on failure.
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        1.0
    } else {
        dpi as f64 / 96.0
    }
}

/// Make the host per-monitor DPI aware (plugins get told the scale).
pub fn init_dpi() {
    use windows_sys::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    // SAFETY: process-wide setting, called once at startup.
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}
