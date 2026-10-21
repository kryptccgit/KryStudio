use crate::time::PPQ;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::*};
use std::sync::{Arc, Mutex};

pub const PULSE_TICKS: f64 = PPQ / 24.0;
pub const SPP_TICKS: f64 = PPQ / 4.0;
pub const SPP_MAX: u16 = 0x3FFF;
pub const CLOCK_RING: usize = 4096;
pub const SYNC_RING: usize = 2048;

pub const MIDI_CLOCK: u8 = 0xF8;
pub const MIDI_START: u8 = 0xFA;
pub const MIDI_CONTINUE: u8 = 0xFB;
pub const MIDI_STOP: u8 = 0xFC;
pub const MIDI_SPP: u8 = 0xF2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClockEv {
    pub t_ns: u64,
    pub len: u8,
    pub bytes: [u8; 3],
}

impl ClockEv {
    pub fn one(t_ns: u64, status: u8) -> Self {
        ClockEv { t_ns, len: 1, bytes: [status, 0, 0] }
    }
    pub fn spp(t_ns: u64, sixteenths: u16) -> Self {
        let s = sixteenths.min(SPP_MAX);
        ClockEv { t_ns, len: 3, bytes: [MIDI_SPP, (s & 0x7F) as u8, ((s >> 7) & 0x7F) as u8] }
    }
    pub fn msg(&self) -> &[u8] {
        &self.bytes[..self.len as usize]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyncEv {
    pub t_ns: u64,
    pub status: u8,
    pub spp: u16,
}

pub fn scan_sync_bytes(t_ns: u64, bytes: &[u8], mut f: impl FnMut(SyncEv)) {
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            MIDI_CLOCK | MIDI_START | MIDI_CONTINUE | MIDI_STOP => f(SyncEv { t_ns, status: b, spp: 0 }),
            MIDI_SPP => {
                if i + 2 < bytes.len() && bytes[i + 1] < 0x80 && bytes[i + 2] < 0x80 {
                    let v = bytes[i + 1] as u16 | ((bytes[i + 2] as u16) << 7);
                    f(SyncEv { t_ns, status: MIDI_SPP, spp: v });
                    i += 2;
                }
            }
            _ => {}
        }
        i += 1;
    }
}

pub struct ClockRtEnds {
    pub shared: Arc<ClockShared>,
    pub out_tx: rtrb::Producer<ClockEv>,
    pub sync_rx: rtrb::Consumer<SyncEv>,
}

pub struct ClockShared {
    pub out_on: AtomicBool,
    pub sync_on: AtomicBool,
    pub sync_bpm: AtomicU64,
    pub sync_running: AtomicBool,
    pub sync_locked: AtomicBool,
    pub sync_lost: AtomicU32,
    pub out_dropped: AtomicU32,
    pub out_sent: AtomicU64,
    pub out_late: AtomicU32,
    pub out_jitter_us: AtomicU32,
    rt: Mutex<Option<ClockRtEnds>>,
    out_rx: Mutex<Option<rtrb::Consumer<ClockEv>>>,
    sync_tx: Mutex<Option<rtrb::Producer<SyncEv>>>,
}

impl ClockShared {
    pub fn new() -> Arc<Self> {
        let (out_tx, out_rx) = rtrb::RingBuffer::new(CLOCK_RING);
        let (sync_tx, sync_rx) = rtrb::RingBuffer::new(SYNC_RING);
        let s = Arc::new(ClockShared {
            out_on: AtomicBool::new(false),
            sync_on: AtomicBool::new(false),
            sync_bpm: AtomicU64::new(0),
            sync_running: AtomicBool::new(false),
            sync_locked: AtomicBool::new(false),
            sync_lost: AtomicU32::new(0),
            out_dropped: AtomicU32::new(0),
            out_sent: AtomicU64::new(0),
            out_late: AtomicU32::new(0),
            out_jitter_us: AtomicU32::new(0),
            rt: Mutex::new(None),
            out_rx: Mutex::new(Some(out_rx)),
            sync_tx: Mutex::new(Some(sync_tx)),
        });
        *s.rt.lock().unwrap_or_else(|e| e.into_inner()) = Some(ClockRtEnds { shared: s.clone(), out_tx, sync_rx });
        s
    }

    pub fn take_rt(&self) -> Option<ClockRtEnds> {
        self.rt.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
    pub fn take_out_rx(&self) -> Option<rtrb::Consumer<ClockEv>> {
        self.out_rx.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
    pub fn take_sync_tx(&self) -> Option<rtrb::Producer<SyncEv>> {
        self.sync_tx.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    pub fn bpm(&self) -> Option<f64> {
        let b = f64::from_bits(self.sync_bpm.load(Relaxed));
        (b.is_finite() && b > 0.0).then_some(b)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncTel {
    pub bpm: Option<f64>,
    pub running: bool,
    pub locked: bool,
}

pub fn sync_telemetry(s: &ClockShared) -> Option<SyncTel> {
    if !s.sync_on.load(Relaxed) {
        return None;
    }
    Some(SyncTel { bpm: s.bpm().map(|b| (b * 100.0).round() / 100.0), running: s.sync_running.load(Relaxed), locked: s.sync_locked.load(Relaxed) })
}

#[derive(Clone, Copy, Debug, Default)]
pub struct BlockClock {
    t: f64,
    next: f64,
    init: bool,
}

const BLOCK_GAIN: f64 = 1.0 / 32.0;
const BLOCK_RESYNC_NS: f64 = 20e6;

impl BlockClock {
    pub fn update(&mut self, heard_ns: u64, frames: usize, sr: f64) -> f64 {
        let x = heard_ns as f64;
        if !self.init || (x - self.next).abs() > BLOCK_RESYNC_NS {
            self.t = x;
            self.init = true;
        } else {
            self.t = self.next + (x - self.next) * BLOCK_GAIN;
        }
        self.next = self.t + frames as f64 * 1e9 / sr.max(1.0);
        self.t
    }
    pub fn now(&self) -> f64 {
        self.t
    }
}

pub fn spp_start(pos: f64) -> (u16, f64) {
    let s = ((pos - 1e-6) / SPP_TICKS).ceil().max(0.0);
    let s = s.min(SPP_MAX as f64);
    let first = (s * SPP_TICKS - pos).max(0.0);
    (s as u16, first)
}

pub fn spp_at(pos: f64) -> u16 {
    (pos.max(0.0) / SPP_TICKS + 1e-6).floor().min(SPP_MAX as f64) as u16
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ClockOut {
    pub running: bool,
    next: f64,
    played: f64,
}

impl ClockOut {
    pub fn start(&mut self, pos: f64, t_ns: u64, emit: &mut impl FnMut(ClockEv)) {
        self.played = 0.0;
        if pos < 0.5 {
            emit(ClockEv::one(t_ns, MIDI_START));
            self.next = 0.0;
        } else {
            let (s, first) = spp_start(pos);
            emit(ClockEv::spp(t_ns, s));
            emit(ClockEv::one(t_ns, MIDI_CONTINUE));
            self.next = first;
        }
        self.running = true;
    }

    pub fn stop(&mut self, t_ns: u64, emit: &mut impl FnMut(ClockEv)) {
        if self.running {
            emit(ClockEv::one(t_ns, MIDI_STOP));
            self.running = false;
        }
    }

    pub fn locate(&mut self, pos: f64, t_ns: u64, emit: &mut impl FnMut(ClockEv)) {
        if self.running {
            emit(ClockEv::one(t_ns, MIDI_STOP));
            let (s, first) = spp_start(pos);
            emit(ClockEv::spp(t_ns, s));
            emit(ClockEv::one(t_ns, MIDI_CONTINUE));
            self.next = self.played + first;
        } else {
            emit(ClockEv::spp(t_ns, spp_at(pos)));
        }
    }

    pub fn advance(&mut self, ticks: f64, tpf: f64, t0_ns: f64, ns_per_frame: f64, emit: &mut impl FnMut(ClockEv)) {
        if !self.running || !(ticks > 0.0) || !(tpf > 0.0) {
            self.played += ticks.max(0.0);
            return;
        }
        let end = self.played + ticks;
        let mut guard = 0;
        while self.next < end - 1e-9 && guard < 256 {
            guard += 1;
            let frames = (self.next - self.played).max(0.0) / tpf;
            emit(ClockEv::one((t0_ns + frames * ns_per_frame).max(0.0) as u64, MIDI_CLOCK));
            self.next += PULSE_TICKS;
        }
        self.played = end;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncState {
    Stopped,
    Armed,
    Running,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SyncAction {
    None,
    Locate(f64),
    Run { pos: f64 },
    Pause,
}

const AVG_PULSES: u32 = 48;
const DLL_BW_HZ: f64 = 0.5;
const JUMP_FRACTION: f64 = 0.25;

#[derive(Clone, Copy, Debug)]
pub struct SyncFollower {
    pub state: SyncState,
    have: u32,
    first_t: f64,
    last_raw: f64,
    t0: f64,
    t1: f64,
    period: f64,
    misses: u32,
    pub pulses: u64,
    pending_pos: f64,
}

impl Default for SyncFollower {
    fn default() -> Self {
        SyncFollower { state: SyncState::Stopped, have: 0, first_t: 0.0, last_raw: 0.0, t0: 0.0, t1: 0.0, period: 0.0, misses: 0, pulses: 0, pending_pos: 0.0 }
    }
}

impl SyncFollower {
    pub fn reset(&mut self) {
        *self = SyncFollower::default();
    }

    pub fn bpm(&self) -> Option<f64> {
        (self.have >= 2 && self.period > 0.0).then(|| 60e9 / (24.0 * self.period))
    }

    pub fn locked(&self) -> bool {
        self.have >= 24 && self.misses == 0
    }

    pub fn period_ns(&self) -> f64 {
        self.period
    }

    pub fn last_pulse_ns(&self) -> f64 {
        self.last_raw
    }

    fn restart_estimate(&mut self, t: f64) {
        self.have = 1;
        self.first_t = t;
        self.t0 = t;
        self.t1 = t;
        self.misses = 0;
    }

    pub fn pulse(&mut self, t: f64) {
        let gap_limit = if self.period > 0.0 { (self.period * 6.0).max(60e6) } else { 500e6 };
        if self.have == 0 || t - self.last_raw > gap_limit || t < self.last_raw {
            self.restart_estimate(t);
            self.last_raw = t;
            return;
        }
        self.last_raw = t;
        self.have = self.have.saturating_add(1);
        if self.have <= AVG_PULSES {
            let p = (t - self.first_t) / (self.have - 1) as f64;
            if self.have > 3 && self.period > 0.0 && (p - self.period).abs() > self.period * JUMP_FRACTION {
                self.restart_estimate(t);
                return;
            }
            self.period = p;
            self.t0 = t;
            self.t1 = t + p;
            return;
        }
        let e = t - self.t1;
        if e.abs() > self.period * JUMP_FRACTION {
            self.misses += 1;
            if self.misses >= 3 {
                self.restart_estimate(t);
                return;
            }
        } else {
            self.misses = 0;
        }
        let w = std::f64::consts::TAU * DLL_BW_HZ * self.period * 1e-9;
        let b = std::f64::consts::SQRT_2 * w;
        let c = w * w;
        self.t0 = self.t1 + b * e;
        self.t1 = self.t0 + self.period;
        self.period += c * e;
    }

    pub fn expected_ticks(&self, t: f64) -> Option<f64> {
        if self.state != SyncState::Running || !(self.period > 0.0) {
            return None;
        }
        Some(PULSE_TICKS * (self.pulses as f64 + (t - self.t0) / self.period))
    }

    pub fn on_event(&mut self, ev: SyncEv, playing: bool) -> SyncAction {
        let t = ev.t_ns as f64;
        match ev.status {
            MIDI_CLOCK => {
                self.pulse(t);
                match self.state {
                    SyncState::Armed => {
                        self.state = SyncState::Running;
                        self.pulses = 0;
                        SyncAction::Run { pos: self.pending_pos }
                    }
                    SyncState::Running => {
                        self.pulses += 1;
                        SyncAction::None
                    }
                    SyncState::Stopped => SyncAction::None,
                }
            }
            MIDI_START => {
                self.pending_pos = 0.0;
                let was = self.state;
                self.state = SyncState::Armed;
                if was == SyncState::Running || playing {
                    SyncAction::Pause
                } else {
                    SyncAction::Locate(0.0)
                }
            }
            MIDI_CONTINUE => {
                if self.state != SyncState::Running {
                    self.state = SyncState::Armed;
                }
                SyncAction::None
            }
            MIDI_STOP => {
                let was = self.state;
                self.state = SyncState::Stopped;
                if was != SyncState::Stopped {
                    SyncAction::Pause
                } else {
                    SyncAction::None
                }
            }
            MIDI_SPP => {
                self.pending_pos = ev.spp as f64 * SPP_TICKS;
                if self.state == SyncState::Running {
                    self.state = SyncState::Armed;
                    SyncAction::None
                } else {
                    SyncAction::Locate(self.pending_pos)
                }
            }
            _ => SyncAction::None,
        }
    }

    pub fn set_pending_pos(&mut self, pos: f64) {
        self.pending_pos = pos;
    }

    pub fn lost(&self, now: f64) -> bool {
        if self.state == SyncState::Stopped || self.last_raw <= 0.0 {
            return false;
        }
        let limit = if self.period > 0.0 { (self.period * 8.0).max(500e6) } else { 2e9 };
        now - self.last_raw > limit
    }
}

pub fn phase_ratio(err_ticks: f64, bpm: f64) -> f64 {
    let tps = bpm * PPQ / 60.0;
    if !(tps > 0.0) || !err_ticks.is_finite() {
        return 1.0;
    }
    1.0 + (err_ticks / (tps * 0.5)).clamp(-0.04, 0.04)
}

pub const PHASE_JUMP_TICKS: f64 = PPQ / 2.0;

pub struct ClockRt {
    pub shared: Option<Arc<ClockShared>>,
    out_tx: Option<rtrb::Producer<ClockEv>>,
    sync_rx: Option<rtrb::Consumer<SyncEv>>,
    pub block: BlockClock,
    pub block_t: f64,
    pub ns_per_frame: f64,
    pub sub_base: usize,
    pub out: ClockOut,
    pub follow: SyncFollower,
    pub pt0: f64,
    pub advanced: bool,
    pub slave_ticks: f64,
    pub overriding: bool,
    pub saved_bpm: f64,
    pub last_override: f64,
    pub fake_now: Option<u64>,
}

impl Default for ClockRt {
    fn default() -> Self {
        Self::detached()
    }
}

impl ClockRt {
    pub fn detached() -> Self {
        ClockRt {
            shared: None,
            out_tx: None,
            sync_rx: None,
            block: BlockClock::default(),
            block_t: 0.0,
            ns_per_frame: 1e9 / 48000.0,
            sub_base: 0,
            out: ClockOut::default(),
            follow: SyncFollower::default(),
            pt0: 0.0,
            advanced: false,
            slave_ticks: 0.0,
            overriding: false,
            saved_bpm: 0.0,
            last_override: f64::NAN,
            fake_now: None,
        }
    }

    pub fn attach(&mut self, ends: ClockRtEnds) {
        self.shared = Some(ends.shared);
        self.out_tx = Some(ends.out_tx);
        self.sync_rx = Some(ends.sync_rx);
    }

    #[inline]
    pub fn attached(&self) -> bool {
        self.out_tx.is_some()
    }

    #[inline]
    pub fn out_on(&self) -> bool {
        self.shared.as_ref().is_some_and(|s| s.out_on.load(Relaxed))
    }

    #[inline]
    pub fn sync_on(&self) -> bool {
        self.shared.as_ref().is_some_and(|s| s.sync_on.load(Relaxed))
    }

    pub fn push(&mut self, ev: ClockEv) {
        if let Some(tx) = self.out_tx.as_mut() {
            if tx.push(ev).is_err() {
                if let Some(s) = &self.shared {
                    s.out_dropped.fetch_add(1, Relaxed);
                }
            }
        }
    }

    pub fn pop_sync(&mut self) -> Option<SyncEv> {
        self.sync_rx.as_mut().and_then(|rx| rx.pop().ok())
    }

    #[inline]
    pub fn heard_at(&self, off: usize) -> f64 {
        self.block_t + off as f64 * self.ns_per_frame
    }

    pub fn publish_sync(&self) {
        if let Some(s) = &self.shared {
            s.sync_bpm.store(self.follow.bpm().unwrap_or(0.0).to_bits(), Relaxed);
            s.sync_running.store(self.follow.state == SyncState::Running, Relaxed);
            s.sync_locked.store(self.follow.locked(), Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spp_values() {
        assert_eq!(spp_start(0.0), (0, 0.0));
        assert_eq!(spp_start(240.0), (1, 0.0));
        assert_eq!(spp_start(100.0), (1, 140.0));
        assert_eq!(spp_start(3840.0), (16, 0.0), "bar 2 = 16 sixteenths");
        assert_eq!(spp_at(479.0), 1);
        assert_eq!(spp_at(480.0), 2);
        assert_eq!(spp_start(1e12).0, SPP_MAX, "clamped to 14 bits");
        let e = ClockEv::spp(5, 200);
        assert_eq!(e.msg(), &[0xF2, 200 & 0x7F, 1]);
        let e = ClockEv::spp(5, 20000);
        assert_eq!(e.msg(), &[0xF2, 0x7F, 0x7F]);
    }

    #[test]
    fn pulses_every_40_ticks_at_exact_frames() {
        let tpf = 0.04;
        let npf = 1e9 / 48000.0;
        let mut out = ClockOut::default();
        let mut evs = Vec::new();
        out.start(0.0, 1_000_000, &mut |e| evs.push(e));
        assert_eq!(evs, vec![ClockEv::one(1_000_000, MIDI_START)]);
        evs.clear();
        let mut t0 = 1_000_000.0;
        for _ in 0..100 {
            out.advance(32.0 * tpf, tpf, t0, npf, &mut |e| evs.push(e));
            t0 += 32.0 * npf;
        }
        assert!(evs.iter().all(|e| e.msg() == [MIDI_CLOCK]));
        let ts: Vec<f64> = evs.iter().map(|e| e.t_ns as f64).collect();
        assert_eq!(ts.len(), 4);
        for (i, t) in ts.iter().enumerate() {
            let want = 1_000_000.0 + i as f64 * 1000.0 * npf;
            assert!((t - want).abs() < 2.0, "pulse {i} at {t}, want {want}");
        }
        evs.clear();
        out.stop(9, &mut |e| evs.push(e));
        out.stop(10, &mut |e| evs.push(e));
        assert_eq!(evs, vec![ClockEv::one(9, MIDI_STOP)]);
    }

    #[test]
    fn continue_from_mid_song_waits_for_the_next_sixteenth() {
        let mut out = ClockOut::default();
        let mut evs = Vec::new();
        out.start(1000.0, 0, &mut |e| evs.push(e));
        assert_eq!(evs[0], ClockEv::spp(0, 5));
        assert_eq!(evs[1], ClockEv::one(0, MIDI_CONTINUE));
        evs.clear();
        out.advance(300.0, 1.0, 0.0, 1000.0, &mut |e| evs.push(e));
        let ts: Vec<u64> = evs.iter().map(|e| e.t_ns).collect();
        assert_eq!(ts, vec![200_000, 240_000, 280_000]);
        evs.clear();
        out.locate(3850.0, 400_000, &mut |e| evs.push(e));
        assert_eq!(evs, vec![ClockEv::one(400_000, MIDI_STOP), ClockEv::spp(400_000, 17), ClockEv::one(400_000, MIDI_CONTINUE)]);
        evs.clear();
        out.advance(240.0, 1.0, 400_000.0, 1000.0, &mut |e| evs.push(e));
        assert_eq!(evs.iter().map(|e| e.t_ns).collect::<Vec<_>>(), vec![630_000]);
        out.stop(0, &mut |_| {});
        evs.clear();
        out.locate(960.0, 7, &mut |e| evs.push(e));
        assert_eq!(evs, vec![ClockEv::spp(7, 4)]);
    }

    #[test]
    fn pulses_follow_tempo_changes_and_loops() {
        let mut out = ClockOut::default();
        out.start(0.0, 0, &mut |_| {});
        let mut n = 0;
        let mut t0 = 0.0;
        for i in 0..60 {
            let tpf = if i < 30 { 1.0 } else { 2.0 };
            let frames = 32.0;
            out.advance(frames * tpf, tpf, t0, 1000.0, &mut |_| n += 1);
            t0 += frames * 1000.0;
        }
        assert_eq!(n, 72);
    }

    #[test]
    fn scans_realtime_and_spp_bytes() {
        let mut v = Vec::new();
        scan_sync_bytes(5, &[0x90, 60, 0xF8, 100, 0xFA, 0xF2, 0x10, 0x01, 0xFC, 0xFB, 0xF2, 0x01], |e| v.push(e));
        let st: Vec<(u8, u16)> = v.iter().map(|e| (e.status, e.spp)).collect();
        assert_eq!(st, vec![(0xF8, 0), (0xFA, 0), (0xF2, 0x10 | (1 << 7)), (0xFC, 0), (0xFB, 0)], "a truncated SPP is ignored");
    }

    fn jitter(seed: &mut u64, amp: f64) -> f64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        ((*seed % 20001) as f64 / 10000.0 - 1.0) * amp
    }

    #[test]
    fn tempo_estimate_from_jittered_clock() {
        let mut f = SyncFollower::default();
        let mut seed = 0x9E3779B97F4A7C15u64;
        let period = 60e9 / (24.0 * 123.0);
        let mut worst_after_lock: f64 = 0.0;
        for k in 0..(123.0 / 60.0 * 24.0 * 8.0) as u64 {
            let t = 1e9 + k as f64 * period + jitter(&mut seed, 1e6);
            f.pulse(t);
            if k > 24 * 6 {
                let b = f.bpm().unwrap();
                worst_after_lock = worst_after_lock.max((b - 123.0).abs());
            }
        }
        assert!(f.locked());
        eprintln!("sync tempo with ±1 ms jitter: worst {worst_after_lock:.4} bpm off after 3 s, final {:.4}", f.bpm().unwrap());
        assert!(worst_after_lock < 0.15, "tempo wobbles by {worst_after_lock} bpm after 3 s");
        assert!((f.bpm().unwrap() - 123.0).abs() < 0.05, "{}", f.bpm().unwrap());
        let start = 1e9 + 400.0 * period;
        let p2 = 60e9 / (24.0 * 90.0);
        let mut settled_at = None;
        for k in 0..24 * 8 {
            let t = start + k as f64 * p2 + jitter(&mut seed, 1e6);
            f.pulse(t);
            if settled_at.is_none() && f.bpm().is_some_and(|b| (b - 90.0).abs() < 0.5) {
                settled_at = Some(k);
            }
        }
        let k = settled_at.expect("followed the tempo change");
        eprintln!("tempo jump 123 → 90 bpm: within 0.5 bpm after {k} pulses");
        assert!(k <= 72, "took {k} pulses");
        assert!((f.bpm().unwrap() - 90.0).abs() < 0.1, "{}", f.bpm().unwrap());
    }

    #[test]
    fn transport_messages_drive_the_follower() {
        let mut f = SyncFollower::default();
        let p = 60e9 / (24.0 * 120.0);
        let ev = |t: f64, status: u8, spp: u16| SyncEv { t_ns: t as u64, status, spp };
        for k in 0..30 {
            assert_eq!(f.on_event(ev(k as f64 * p, MIDI_CLOCK, 0), false), SyncAction::None);
        }
        assert!((f.bpm().unwrap() - 120.0).abs() < 0.01);
        assert_eq!(f.on_event(ev(29.5 * p, MIDI_SPP, 8), false), SyncAction::Locate(1920.0));
        assert_eq!(f.on_event(ev(29.5 * p, MIDI_CONTINUE, 0), false), SyncAction::None);
        assert_eq!(f.state, SyncState::Armed);
        assert_eq!(f.on_event(ev(30.0 * p, MIDI_CLOCK, 0), false), SyncAction::Run { pos: 1920.0 });
        assert_eq!(f.state, SyncState::Running);
        for k in 31..55 {
            f.on_event(ev(k as f64 * p, MIDI_CLOCK, 0), true);
        }
        assert_eq!(f.pulses, 24);
        let e = f.expected_ticks(54.5 * p).unwrap();
        assert!((e - 24.5 * PULSE_TICKS).abs() < 2.0, "{e}");
        assert_eq!(f.on_event(ev(56.0 * p, MIDI_STOP, 0), true), SyncAction::Pause);
        assert_eq!(f.expected_ticks(57.0 * p), None);
        assert_eq!(f.on_event(ev(57.0 * p, MIDI_START, 0), false), SyncAction::Locate(0.0));
        assert_eq!(f.on_event(ev(58.0 * p, MIDI_CLOCK, 0), false), SyncAction::Run { pos: 0.0 });
        assert!(!f.lost(58.0 * p + 100e6));
        assert!(f.lost(58.0 * p + 600e6));
    }

    #[test]
    fn phase_ratio_is_bounded() {
        assert_eq!(phase_ratio(0.0, 120.0), 1.0);
        assert!(phase_ratio(10.0, 120.0) > 1.0);
        assert!(phase_ratio(-10.0, 120.0) < 1.0);
        assert_eq!(phase_ratio(1e6, 120.0), 1.04);
        assert_eq!(phase_ratio(-1e6, 120.0), 0.96);
        assert_eq!(phase_ratio(f64::NAN, 120.0), 1.0);
    }

    #[test]
    fn block_clock_smooths_callback_jitter() {
        let mut b = BlockClock::default();
        let mut seed = 42u64;
        let frames = 480;
        let period = 1e9 * frames as f64 / 48000.0;
        let mut worst: f64 = 0.0;
        for k in 0..2000u64 {
            let ideal = 5e9 + k as f64 * period;
            let t = b.update((ideal + 2e6 + jitter(&mut seed, 1e6)) as u64, frames, 48000.0);
            if k > 200 {
                worst = worst.max((t - (ideal + 2e6)).abs());
            }
        }
        assert!(worst < 250e3, "smoothed block time off by {worst} ns with ±1 ms callback jitter");
        let t = b.update(9e9 as u64, frames, 48000.0);
        assert_eq!(t, 9e9);
    }
}
