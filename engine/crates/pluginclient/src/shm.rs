use std::sync::atomic::{AtomicU32, Ordering::*};
use std::time::{Duration, Instant};

pub const SHM_MAGIC: u32 = 0x4B53_504C;
pub const SHM_VERSION: u32 = 1;
pub const MAX_FRAMES: usize = 1024;
pub const MAX_EVENTS: usize = 1024;

pub mod state {
    pub const LOADING: u32 = 0;
    pub const READY: u32 = 1;
    pub const PAUSED: u32 = 2;
    pub const DEAD: u32 = 3;
    pub const FAILED: u32 = 4;
}

pub mod ev {
    pub const NOTE_ON: u32 = 1;
    pub const NOTE_OFF: u32 = 2;
    pub const PARAM: u32 = 3;
    pub const CHOKE: u32 = 4;
    pub const ALL_OFF: u32 = 5;
}

pub mod flag {
    pub const PLAYING: u32 = 1;
    pub const RESET: u32 = 2;
}

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Ev {
    pub kind: u32,
    pub offset: u32,
    pub key: u32,
    pub id: u32,
    pub value: f64,
    pub aux: f64,
}

#[repr(C)]
pub struct Block {
    pub magic: u32,
    pub version: u32,
    pub req_seq: AtomicU32,
    pub done_seq: AtomicU32,
    pub host_waiting: AtomicU32,
    pub client_waiting: AtomicU32,
    pub latency: AtomicU32,
    pub state: AtomicU32,
    pub quit: AtomicU32,
    pub processed: AtomicU32,
    pub frames: u32,
    pub flags: u32,
    pub sample_rate: f64,
    pub bpm: f64,
    pub beat_pos: f64,
    pub n_events: u32,
    pub status: u32,
    pub events: [Ev; MAX_EVENTS],
    pub audio_in: [[f32; MAX_FRAMES]; 2],
    pub audio_out: [[f32; MAX_FRAMES]; 2],
}

pub const BLOCK_SIZE: usize = std::mem::size_of::<Block>();

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

pub struct Event {
    #[cfg(windows)]
    h: sys::HANDLE,
}

unsafe impl Send for Event {}
unsafe impl Sync for Event {}

impl Event {
    #[cfg(windows)]
    pub fn create(name: &str) -> Result<Event, String> {
        let w = wide(name);
        let h = unsafe { sys::CreateEventW(std::ptr::null(), 0, 0, w.as_ptr()) };
        if h.is_null() {
            return Err(format!("CreateEvent({name}) failed: {}", std::io::Error::last_os_error()));
        }
        Ok(Event { h })
    }

    #[cfg(windows)]
    pub fn open(name: &str) -> Result<Event, String> {
        let w = wide(name);
        let h = unsafe { sys::OpenEventW(sys::EVENT_ALL_ACCESS, 0, w.as_ptr()) };
        if h.is_null() {
            return Err(format!("OpenEvent({name}) failed: {}", std::io::Error::last_os_error()));
        }
        Ok(Event { h })
    }

    #[inline]
    pub fn set(&self) {
        #[cfg(windows)]
        unsafe {
            sys::SetEvent(self.h);
        }
    }

    #[inline]
    pub fn wait(&self, ms: u32) -> bool {
        #[cfg(windows)]
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
        unsafe {
            sys::CloseHandle(self.h);
        }
    }
}

pub struct Mapping {
    #[cfg(windows)]
    h: sys::HANDLE,
    ptr: *mut Block,
}

unsafe impl Send for Mapping {}
unsafe impl Sync for Mapping {}

impl Mapping {
    #[cfg(windows)]
    pub fn create(name: &str) -> Result<Mapping, String> {
        let w = wide(name);
        let size = BLOCK_SIZE as u64;
        let h = unsafe { sys::CreateFileMappingW(sys::INVALID_HANDLE_VALUE, std::ptr::null(), sys::PAGE_READWRITE, (size >> 32) as u32, size as u32, w.as_ptr()) };
        if h.is_null() {
            return Err(format!("CreateFileMapping failed: {}", std::io::Error::last_os_error()));
        }
        let view = unsafe { sys::MapViewOfFile(h, sys::FILE_MAP_ALL_ACCESS, 0, 0, BLOCK_SIZE) };
        if view.Value.is_null() {
            let e = std::io::Error::last_os_error();
            unsafe { sys::CloseHandle(h) };
            return Err(format!("MapViewOfFile failed: {e}"));
        }
        let ptr = view.Value as *mut Block;
        unsafe {
            (*ptr).magic = SHM_MAGIC;
            (*ptr).version = SHM_VERSION;
        }
        Ok(Mapping { h, ptr })
    }

    #[cfg(windows)]
    pub fn open(name: &str) -> Result<Mapping, String> {
        let w = wide(name);
        let h = unsafe { sys::OpenFileMappingW(sys::FILE_MAP_ALL_ACCESS, 0, w.as_ptr()) };
        if h.is_null() {
            return Err(format!("OpenFileMapping({name}) failed: {}", std::io::Error::last_os_error()));
        }
        let view = unsafe { sys::MapViewOfFile(h, sys::FILE_MAP_ALL_ACCESS, 0, 0, BLOCK_SIZE) };
        if view.Value.is_null() {
            let e = std::io::Error::last_os_error();
            unsafe { sys::CloseHandle(h) };
            return Err(format!("MapViewOfFile failed: {e}"));
        }
        let m = Mapping { h, ptr: view.Value as *mut Block };
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

    #[inline]
    pub fn block(&self) -> &Block {
        unsafe { &*self.ptr }
    }

    #[inline]
    pub fn raw(&self) -> *mut Block {
        self.ptr
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            sys::UnmapViewOfFile(sys::MEMORY_MAPPED_VIEW_ADDRESS { Value: self.ptr as *mut core::ffi::c_void });
            sys::CloseHandle(self.h);
        }
    }
}

pub struct Channel {
    pub map: Mapping,
    pub req: Event,
    pub done: Event,
}

pub const CLIENT_SPIN: Duration = Duration::from_micros(400);
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

    #[inline]
    pub fn publish(&self, seq: u32) {
        let b = self.map.block();
        b.req_seq.store(seq, SeqCst);
        if b.host_waiting.load(SeqCst) != 0 {
            self.req.set();
        }
    }

    #[inline]
    pub fn is_done(&self, seq: u32) -> bool {
        self.map.block().done_seq.load(Acquire) == seq
    }

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
            unsafe {
                (*p).frames = 32;
                for i in 0..32 {
                    (*p).audio_in[0][i] = seq as f32;
                }
            }
            client.publish(seq);
            assert!(client.wait_done(seq, Duration::from_secs(2)), "request {seq} timed out");
            unsafe { assert_eq!((*p).audio_out[0][31], seq as f32 * 2.0) };
        }
        t.join().unwrap();
    }
}
