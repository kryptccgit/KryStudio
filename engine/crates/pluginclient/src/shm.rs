//! Shared-memory audio exchange between the engine (client) and the plugin
//! host: ONE file mapping + an auto-reset event pair per plugin instance.
//!
//! One process() call is one synchronous round trip inside the engine's
//! sub-block:
//!
//!   client: write events/audio → req_seq = n → (SetEvent(req) if the host sleeps)
//!   host:   sees req_seq == n → runs the plugin → done_seq = n → (SetEvent(done) if the client sleeps)
//!   client: spins briefly on done_seq, then waits on `done` with a deadline.
//!
//! Both sides spin first and only fall back to the kernel event, flagging
//! `*_waiting` so the other side knows a SetEvent is needed (Dekker-style
//! with SeqCst, so a wake-up is never lost; stale signals are harmless
//! because every wait re-checks the sequence numbers).
//!
//! The client CREATES the mapping and events (it owns them, so a dead host
//! never leaves the engine with a dangling view); the host OPENS them by name.

use std::sync::atomic::{AtomicU32, Ordering::*};
use std::time::{Duration, Instant};

pub const SHM_MAGIC: u32 = 0x4B53_504C; // "KSPL"
pub const SHM_VERSION: u32 = 1;
/// Max frames per process() call (the engine's PREPARE_MAX).
pub const MAX_FRAMES: usize = 1024;
/// Max input events per process() call.
pub const MAX_EVENTS: usize = 1024;

/// Instance state word (host writes READY/PAUSED, the client writes DEAD).
pub mod state {
    pub const LOADING: u32 = 0;
    pub const READY: u32 = 1;
    /// Audio thread stopped (reactivation / unload): the client outputs silence.
    pub const PAUSED: u32 = 2;
    /// Host process gone or plugin crashed: silence forever.
    pub const DEAD: u32 = 3;
    pub const FAILED: u32 = 4;
}

/// Event kinds in `Block::events`.
pub mod ev {
    /// key, value = velocity 0..1, aux = tuning in semitones.
    pub const NOTE_ON: u32 = 1;
    /// key, value = release velocity.
    pub const NOTE_OFF: u32 = 2;
    /// id = plugin param id, value = PLAIN value (as in the descriptor).
    pub const PARAM: u32 = 3;
    /// Fast-release every voice (cut groups).
    pub const CHOKE: u32 = 4;
    /// Kill every voice now (transport stop / panic).
    pub const ALL_OFF: u32 = 5;
}

/// `Block::flags` bits.
pub mod flag {
    pub const PLAYING: u32 = 1;
    /// Clear tails before processing (transport stop / locate).
    pub const RESET: u32 = 2;
}

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Ev {
    pub kind: u32,
    /// Frame offset inside the block.
    pub offset: u32,
    pub key: u32,
    pub id: u32,
    pub value: f64,
    pub aux: f64,
}

/// The mapped layout. Plain (non-atomic) fields are only touched through
/// raw pointers by the side that currently owns the block (client before
/// publishing `req_seq`, host between seeing it and publishing `done_seq`).
#[repr(C)]
pub struct Block {
    pub magic: u32,
    pub version: u32,
    pub req_seq: AtomicU32,
    pub done_seq: AtomicU32,
    pub host_waiting: AtomicU32,
    pub client_waiting: AtomicU32,
    /// Latency in samples reported by the plugin (host writes).
    pub latency: AtomicU32,
    pub state: AtomicU32,
    /// Ask the host audio thread to exit (unload).
    pub quit: AtomicU32,
    /// Incremented by the host audio thread every time it processes.
    pub processed: AtomicU32,
    // ── per-call inputs (client → host) ──
    pub frames: u32,
    pub flags: u32,
    pub sample_rate: f64,
    pub bpm: f64,
    pub beat_pos: f64,
    pub n_events: u32,
    /// Host → client: 0 ok, 1 = the plugin returned an error for this block.
    pub status: u32,
    pub events: [Ev; MAX_EVENTS],
    pub audio_in: [[f32; MAX_FRAMES]; 2],
    pub audio_out: [[f32; MAX_FRAMES]; 2],
}

pub const BLOCK_SIZE: usize = std::mem::size_of::<Block>();

/// Kernel object names for an instance (session-local namespace).
pub fn names(base: &str) -> (String, String, String) {
    (format!("Local\\{base}"), format!("Local\\{base}-req"), format!("Local\\{base}-done"))
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
mod sys {
    pub use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
    pub use windows_sys::Win32::System::Memory::{
        CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
    };
    pub use windows_sys::Win32::System::Threading::{CreateEventW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_ALL_ACCESS};
}

/// An auto-reset Win32 event.
pub struct Event {
    #[cfg(windows)]
    h: sys::HANDLE,
}

// SAFETY: event handles are process-wide kernel objects, usable from any thread.
unsafe impl Send for Event {}
unsafe impl Sync for Event {}

impl Event {
    #[cfg(windows)]
    pub fn create(name: &str) -> Result<Event, String> {
        let w = wide(name);
        // SAFETY: valid NUL-terminated name; null security attributes.
        let h = unsafe { sys::CreateEventW(std::ptr::null(), 0, 0, w.as_ptr()) };
        if h.is_null() {
            return Err(format!("CreateEvent({name}) failed: {}", std::io::Error::last_os_error()));
        }
        Ok(Event { h })
    }

    #[cfg(windows)]
    pub fn open(name: &str) -> Result<Event, String> {
        let w = wide(name);
        // SAFETY: valid NUL-terminated name.
        let h = unsafe { sys::OpenEventW(sys::EVENT_ALL_ACCESS, 0, w.as_ptr()) };
        if h.is_null() {
            return Err(format!("OpenEvent({name}) failed: {}", std::io::Error::last_os_error()));
        }
        Ok(Event { h })
    }

    /// [RT-safe] One syscall.
    #[inline]
    pub fn set(&self) {
        #[cfg(windows)]
        // SAFETY: valid handle owned by self.
        unsafe {
            sys::SetEvent(self.h);
        }
    }

    /// Wait up to `ms` milliseconds; true if signalled.
    #[inline]
    pub fn wait(&self, ms: u32) -> bool {
        #[cfg(windows)]
        // SAFETY: valid handle owned by self.
        unsafe {
            sys::WaitForSingleObject(self.h, ms) == sys::WAIT_OBJECT_0
        }
        #[cfg(not(windows))]
        {
            let _ = ms;
            false
        }
    }

    #[cfg(not(windows))]
    pub fn create(_name: &str) -> Result<Event, String> {
        Err("plugin hosting is only available on Windows".into())
    }
    #[cfg(not(windows))]
    pub fn open(_name: &str) -> Result<Event, String> {
        Err("plugin hosting is only available on Windows".into())
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        #[cfg(windows)]
        // SAFETY: we own the handle.
        unsafe {
            sys::CloseHandle(self.h);
        }
    }
}

/// A mapped `Block`.
pub struct Mapping {
    #[cfg(windows)]
    h: sys::HANDLE,
    ptr: *mut Block,
}

// SAFETY: the view is plain shared memory; synchronization is the protocol above.
unsafe impl Send for Mapping {}
unsafe impl Sync for Mapping {}

impl Mapping {
    /// Client side: create + zero + stamp the header.
    #[cfg(windows)]
    pub fn create(name: &str) -> Result<Mapping, String> {
        let w = wide(name);
        let size = BLOCK_SIZE as u64;
        // SAFETY: pagefile-backed mapping with a valid name.
        let h = unsafe { sys::CreateFileMappingW(sys::INVALID_HANDLE_VALUE, std::ptr::null(), sys::PAGE_READWRITE, (size >> 32) as u32, size as u32, w.as_ptr()) };
        if h.is_null() {
            return Err(format!("CreateFileMapping failed: {}", std::io::Error::last_os_error()));
        }
        // SAFETY: h is a valid mapping handle of at least BLOCK_SIZE bytes.
        let view = unsafe { sys::MapViewOfFile(h, sys::FILE_MAP_ALL_ACCESS, 0, 0, BLOCK_SIZE) };
        if view.Value.is_null() {
            let e = std::io::Error::last_os_error();
            // SAFETY: we own h.
            unsafe { sys::CloseHandle(h) };
            return Err(format!("MapViewOfFile failed: {e}"));
        }
        let ptr = view.Value as *mut Block;
        // Fresh pagefile mappings are zero-filled (all-zero is a valid Block).
        // SAFETY: ptr points to BLOCK_SIZE writable bytes we own.
        unsafe {
            (*ptr).magic = SHM_MAGIC;
            (*ptr).version = SHM_VERSION;
        }
        Ok(Mapping { h, ptr })
    }

    /// Host side: open an existing mapping and check the header.
    #[cfg(windows)]
    pub fn open(name: &str) -> Result<Mapping, String> {
        let w = wide(name);
        // SAFETY: valid name.
        let h = unsafe { sys::OpenFileMappingW(sys::FILE_MAP_ALL_ACCESS, 0, w.as_ptr()) };
        if h.is_null() {
            return Err(format!("OpenFileMapping({name}) failed: {}", std::io::Error::last_os_error()));
        }
        // SAFETY: valid mapping handle.
        let view = unsafe { sys::MapViewOfFile(h, sys::FILE_MAP_ALL_ACCESS, 0, 0, BLOCK_SIZE) };
        if view.Value.is_null() {
            let e = std::io::Error::last_os_error();
            // SAFETY: we own h.
            unsafe { sys::CloseHandle(h) };
            return Err(format!("MapViewOfFile failed: {e}"));
        }
        let m = Mapping { h, ptr: view.Value as *mut Block };
        // SAFETY: mapped BLOCK_SIZE bytes.
        let (magic, version) = unsafe { ((*m.ptr).magic, (*m.ptr).version) };
        if magic != SHM_MAGIC || version != SHM_VERSION {
            return Err(format!("Shared memory version mismatch (magic {magic:#x}, version {version})"));
        }
        Ok(m)
    }

    #[cfg(not(windows))]
    pub fn create(_name: &str) -> Result<Mapping, String> {
        Err("plugin hosting is only available on Windows".into())
    }
    #[cfg(not(windows))]
    pub fn open(_name: &str) -> Result<Mapping, String> {
        Err("plugin hosting is only available on Windows".into())
    }

    /// Shared view for the atomics.
    #[inline]
    pub fn block(&self) -> &Block {
        // SAFETY: valid for the life of the mapping; atomics are Sync.
        unsafe { &*self.ptr }
    }

    /// Raw pointer for the plain fields (see the ownership rule on `Block`).
    #[inline]
    pub fn raw(&self) -> *mut Block {
        self.ptr
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        #[cfg(windows)]
        // SAFETY: we own the view and the handle.
        unsafe {
            sys::UnmapViewOfFile(sys::MEMORY_MAPPED_VIEW_ADDRESS { Value: self.ptr as *mut core::ffi::c_void });
            sys::CloseHandle(self.h);
        }
    }
}

/// Everything one side needs to talk about one instance.
pub struct Channel {
    pub map: Mapping,
    pub req: Event,
    pub done: Event,
}

/// Client spin budget before blocking on `done` (the audio thread has
/// nothing else to do while the plugin runs, and most blocks take < 100 µs).
pub const CLIENT_SPIN: Duration = Duration::from_micros(400);
/// Host spin budget after a block: the engine processes 32-frame sub-blocks
/// back to back inside one device callback, so the next request is close.
pub const HOST_SPIN: Duration = Duration::from_micros(250);

impl Channel {
    pub fn create(base: &str) -> Result<Channel, String> {
        let (m, r, d) = names(base);
        Ok(Channel { map: Mapping::create(&m)?, req: Event::create(&r)?, done: Event::create(&d)? })
    }

    pub fn open(base: &str) -> Result<Channel, String> {
        let (m, r, d) = names(base);
        Ok(Channel { map: Mapping::open(&m)?, req: Event::open(&r)?, done: Event::open(&d)? })
    }

    // ── client ──────────────────────────────────────────────────────────

    /// [RT] Publish request `seq` (inputs must already be written).
    #[inline]
    pub fn publish(&self, seq: u32) {
        let b = self.map.block();
        b.req_seq.store(seq, SeqCst);
        if b.host_waiting.load(SeqCst) != 0 {
            self.req.set();
        }
    }

    /// [RT] Is request `seq` done?
    #[inline]
    pub fn is_done(&self, seq: u32) -> bool {
        self.map.block().done_seq.load(Acquire) == seq
    }

    /// [RT] Spin, then block until `seq` is done or `deadline` passes.
    pub fn wait_done(&self, seq: u32, deadline: Duration) -> bool {
        let b = self.map.block();
        let t0 = Instant::now();
        let spin = CLIENT_SPIN.min(deadline);
        loop {
            if b.done_seq.load(Acquire) == seq {
                return true;
            }
            if t0.elapsed() >= spin {
                break;
            }
            std::hint::spin_loop();
        }
        loop {
            b.client_waiting.store(1, SeqCst);
            if b.done_seq.load(SeqCst) == seq {
                b.client_waiting.store(0, Relaxed);
                return true;
            }
            let el = t0.elapsed();
            if el >= deadline {
                b.client_waiting.store(0, Relaxed);
                return false;
            }
            let ms = ((deadline - el).as_micros().div_ceil(1000)).clamp(1, u32::MAX as u128) as u32;
            self.done.wait(ms);
            b.client_waiting.store(0, Relaxed);
        }
    }

    // ── host ────────────────────────────────────────────────────────────

    /// Host audio thread: wait for a request newer than `last`. Returns the
    /// new sequence number, or None after `idle` without one (so the caller
    /// can check its quit / flush flags).
    pub fn wait_request(&self, last: u32, idle: Duration) -> Option<u32> {
        let b = self.map.block();
        let t0 = Instant::now();
        loop {
            let s = b.req_seq.load(Acquire);
            if s != last {
                return Some(s);
            }
            if t0.elapsed() >= HOST_SPIN {
                break;
            }
            std::hint::spin_loop();
        }
        b.host_waiting.store(1, SeqCst);
        let s = b.req_seq.load(SeqCst);
        if s != last {
            b.host_waiting.store(0, Relaxed);
            return Some(s);
        }
        self.req.wait(idle.as_millis().clamp(1, u32::MAX as u128) as u32);
        b.host_waiting.store(0, Relaxed);
        let s = b.req_seq.load(Acquire);
        if s != last {
            Some(s)
        } else {
            None
        }
    }

    /// Host audio thread: mark `seq` done (outputs must already be written).
    #[inline]
    pub fn complete(&self, seq: u32) {
        let b = self.map.block();
        b.done_seq.store(seq, SeqCst);
        if b.client_waiting.load(SeqCst) != 0 {
            self.done.set();
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn round_trip_between_threads() {
        let base = format!("KryptStudioTest-{}-rt", std::process::id());
        let client = Arc::new(Channel::create(&base).unwrap());
        let host = Channel::open(&base).unwrap();
        let t = std::thread::spawn(move || {
            let mut last = 0;
            let mut n = 0;
            while n < 2000 {
                if let Some(s) = host.wait_request(last, Duration::from_millis(50)) {
                    last = s;
                    let p = host.map.raw();
                    // SAFETY: the host owns the block between request and completion.
                    unsafe {
                        let f = (*p).frames as usize;
                        for i in 0..f {
                            (*p).audio_out[0][i] = (*p).audio_in[0][i] * 2.0;
                        }
                    }
                    host.complete(s);
                    n += 1;
                }
            }
        });
        let p = client.map.raw();
        for seq in 1..=2000u32 {
            // SAFETY: the client owns the block before publishing.
            unsafe {
                (*p).frames = 32;
                for i in 0..32 {
                    (*p).audio_in[0][i] = seq as f32;
                }
            }
            client.publish(seq);
            assert!(client.wait_done(seq, Duration::from_secs(2)), "request {seq} timed out");
            // SAFETY: done → the client owns the block again.
            unsafe { assert_eq!((*p).audio_out[0][31], seq as f32 * 2.0) };
        }
        t.join().unwrap();
    }
}
