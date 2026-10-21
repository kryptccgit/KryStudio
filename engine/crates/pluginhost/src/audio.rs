//! One real-time thread per hosted instance: wait for the engine's request
//! in shared memory, run the plugin, signal done. The format-specific part
//! is the `Processor` trait (CLAP / VST3).

use krypt_studio_pluginclient::shm::{self, Block, Channel, Ev, MAX_EVENTS};
use std::sync::atomic::{AtomicBool, Ordering::*};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

pub trait Processor: Send {
    /// [RT] Process the block the engine published. The host owns `blk`
    /// until it returns. `events` are the block's events sorted by offset.
    /// Err = the plugin failed this block (output is zeroed by the caller).
    fn process(&mut self, blk: *mut Block, events: &[Ev]) -> Result<(), ()>;
    /// Audio thread, while no request is pending (≈ every 50 ms).
    fn idle(&mut self) {}
    /// Audio thread, right after the thread starts / before it stops.
    fn started(&mut self) {}
    fn stopping(&mut self) {}
}

pub struct AudioThread {
    stop: Arc<AtomicBool>,
    chan: Arc<Channel>,
    handle: Option<JoinHandle<Box<dyn Processor>>>,
}

/// Raise this thread to MMCSS "Pro Audio" and flush denormals.
fn rt_setup() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{AvSetMmThreadCharacteristicsW, AvSetMmThreadPriority, AVRT_PRIORITY_HIGH};
        static NAME: [u16; 10] = [80, 114, 111, 32, 65, 117, 100, 105, 111, 0];
        let mut idx: u32 = 0;
        // SAFETY: NUL-terminated name, valid out pointer.
        let h = unsafe { AvSetMmThreadCharacteristicsW(NAME.as_ptr(), &mut idx) };
        if !h.is_null() {
            // SAFETY: h is the MMCSS handle just returned.
            unsafe { AvSetMmThreadPriority(h, AVRT_PRIORITY_HIGH) };
        }
    }
    #[cfg(target_arch = "x86_64")]
    #[allow(deprecated)]
    // SAFETY: setting MXCSR FTZ|DAZ bits on this thread.
    unsafe {
        use std::arch::x86_64::{_mm_getcsr, _mm_setcsr};
        _mm_setcsr(_mm_getcsr() | 0x8040);
    }
}

/// Insertion sort by offset (stable, allocation-free; event lists are short
/// and nearly sorted).
fn sort_events(ev: &mut [Ev]) {
    for i in 1..ev.len() {
        let mut j = i;
        while j > 0 && ev[j - 1].offset > ev[j].offset {
            ev.swap(j - 1, j);
            j -= 1;
        }
    }
}

impl AudioThread {
    pub fn spawn(name: &str, chan: Arc<Channel>, mut proc: Box<dyn Processor>, on_error: Box<dyn Fn(String) + Send>) -> AudioThread {
        let stop = Arc::new(AtomicBool::new(false));
        let st = stop.clone();
        let ch = chan.clone();
        let handle = std::thread::Builder::new()
            .name(format!("audio-{name}"))
            .stack_size(1 << 21)
            .spawn(move || {
                rt_setup();
                let blk = ch.map.raw();
                let b = ch.map.block();
                let mut events = vec![Ev::default(); MAX_EVENTS];
                proc.started();
                // Anything published but not completed yet is pending.
                let mut last = b.done_seq.load(Acquire);
                let mut failures = 0u32;
                loop {
                    if st.load(Acquire) || b.quit.load(Acquire) != 0 {
                        break;
                    }
                    let Some(seq) = ch.wait_request(last, Duration::from_millis(50)) else {
                        proc.idle();
                        continue;
                    };
                    last = seq;
                    if st.load(Acquire) || b.quit.load(Acquire) != 0 {
                        // Answer with silence so the engine isn't left waiting.
                        // SAFETY: we own the block until complete().
                        unsafe { zero_out(blk) };
                        ch.complete(seq);
                        break;
                    }
                    // SAFETY: between the request and complete() the host owns the block.
                    let n = unsafe {
                        let n = ((*blk).n_events as usize).min(MAX_EVENTS);
                        events[..n].copy_from_slice(&(&(*blk).events)[..n]);
                        n
                    };
                    sort_events(&mut events[..n]);
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| proc.process(blk, &events[..n])));
                    match r {
                        Ok(Ok(())) => failures = 0,
                        Ok(Err(())) => {
                            // SAFETY: as above.
                            unsafe {
                                zero_out(blk);
                                (*blk).status = 1;
                            }
                            failures += 1;
                        }
                        Err(_) => {
                            // SAFETY: as above.
                            unsafe { zero_out(blk) };
                            b.state.store(shm::state::DEAD, Release);
                            ch.complete(seq);
                            on_error("panicked while processing audio".into());
                            break;
                        }
                    }
                    b.processed.fetch_add(1, Relaxed);
                    ch.complete(seq);
                    if failures == 2000 {
                        on_error("keeps failing to process audio".into());
                    }
                }
                proc.stopping();
                let _ = b.state.compare_exchange(shm::state::READY, shm::state::PAUSED, AcqRel, Acquire);
                proc
            })
            .expect("spawn audio thread");
        // READY before the load reply goes out: requests published from now
        // on are picked up as soon as the thread waits (sequence numbers).
        let b = chan.map.block();
        if b.state.load(Acquire) != shm::state::DEAD {
            b.state.store(shm::state::READY, Release);
        }
        AudioThread { stop, chan, handle: Some(handle) }
    }

    /// Stop the thread and get the processor back (main thread).
    pub fn stop(mut self) -> Option<Box<dyn Processor>> {
        self.stop.store(true, Release);
        self.chan.req.set();
        self.handle.take().and_then(|h| h.join().ok())
    }
}

impl Drop for AudioThread {
    fn drop(&mut self) {
        if let Some(h) = self.handle.take() {
            self.stop.store(true, Release);
            self.chan.req.set();
            let _ = h.join();
        }
    }
}

/// # Safety
/// The caller must own the block (between request and completion).
pub unsafe fn zero_out(blk: *mut Block) {
    let n = ((*blk).frames as usize).min(shm::MAX_FRAMES);
    let out = &mut (*blk).audio_out;
    out[0][..n].fill(0.0);
    out[1][..n].fill(0.0);
}
