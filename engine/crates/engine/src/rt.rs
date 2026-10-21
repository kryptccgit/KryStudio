use std::cell::UnsafeCell;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub struct TryCell<T> {
    busy: AtomicBool,
    value: UnsafeCell<T>,
}

unsafe impl<T: Send> Sync for TryCell<T> {}
unsafe impl<T: Send> Send for TryCell<T> {}

pub struct TryGuard<'a, T> {
    cell: &'a TryCell<T>,
}

impl<T> TryCell<T> {
    pub fn new(v: T) -> Self {
        Self { busy: AtomicBool::new(false), value: UnsafeCell::new(v) }
    }

    #[inline]
    pub fn try_borrow(&self) -> Option<TryGuard<'_, T>> {
        if self.busy.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed).is_ok() {
            Some(TryGuard { cell: self })
        } else {
            None
        }
    }

    pub fn borrow_blocking(&self) -> TryGuard<'_, T> {
        loop {
            if let Some(g) = self.try_borrow() {
                return g;
            }
            std::thread::sleep(Duration::from_micros(250));
        }
    }
}

impl<T> Deref for TryGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        unsafe { &*self.cell.value.get() }
    }
}

impl<T> DerefMut for TryGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        unsafe { &mut *self.cell.value.get() }
    }
}

impl<T> Drop for TryGuard<'_, T> {
    fn drop(&mut self) {
        self.cell.busy.store(false, Ordering::Release);
    }
}

pub fn enable_ftz_daz() {
    #[cfg(target_arch = "x86_64")]
    #[allow(deprecated)]
    unsafe {
        use std::arch::x86_64::{_mm_getcsr, _mm_setcsr};
        _mm_setcsr(_mm_getcsr() | 0x8040);
    }
}

pub fn mmcss_pro_audio() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{AvSetMmThreadCharacteristicsW, AvSetMmThreadPriority, AVRT_PRIORITY_HIGH};
        static NAME: [u16; 10] = [80, 114, 111, 32, 65, 117, 100, 105, 111, 0];
        let mut idx: u32 = 0;
        let h = unsafe { AvSetMmThreadCharacteristicsW(NAME.as_ptr(), &mut idx) };
        if h.is_null() {
            return false;
        }
        unsafe { AvSetMmThreadPriority(h, AVRT_PRIORITY_HIGH) };
        true
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn disable_power_throttling() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentProcess, ProcessPowerThrottling, SetProcessInformation, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION, PROCESS_POWER_THROTTLING_STATE,
        };
        let state = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION,
            StateMask: 0,
        };
        SetProcessInformation(
            GetCurrentProcess(),
            ProcessPowerThrottling,
            &state as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        );
    }
}

#[inline]
pub fn no_alloc<T, F: FnOnce() -> T>(f: F) -> T {
    assert_no_alloc::assert_no_alloc(f)
}
