use crate::midi::{CcEv, LiveEv, MidiMsg, MidiSink};
use crate::program::NONE;
use crate::time::{bar_ticks, beat_ticks};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering::*};
use std::sync::Arc;

pub const STATE_IDLE: u8 = 0;
pub const STATE_COUNT_IN: u8 = 1;
pub const STATE_RECORDING: u8 = 2;

pub struct LiveShared {
    pub target_slot: AtomicU32,
    pub armed: AtomicBool,
    pub rec_midi: AtomicBool,
    pub rec_audio: AtomicBool,
    pub count_in_bars: AtomicU32,
    pub monitor: AtomicBool,
    pub midi_in: AtomicU32,
    pub state: AtomicU8,
    pub count_in_beats: AtomicU32,
    pub input_peak: [AtomicU32; 2],
    pub monitor_peak: AtomicU32,
    pub input_open: AtomicBool,
    pub rt_dropped: AtomicU32,
}

impl LiveShared {
    pub fn new() -> Self {
        Self {
            target_slot: AtomicU32::new(NONE),
            armed: AtomicBool::new(false),
            rec_midi: AtomicBool::new(true),
            rec_audio: AtomicBool::new(false),
            count_in_bars: AtomicU32::new(0),
            monitor: AtomicBool::new(false),
            midi_in: AtomicU32::new(0),
            state: AtomicU8::new(STATE_IDLE),
            count_in_beats: AtomicU32::new(0),
            input_peak: [AtomicU32::new(0), AtomicU32::new(0)],
            monitor_peak: AtomicU32::new(0),
            input_open: AtomicBool::new(false),
            rt_dropped: AtomicU32::new(0),
        }
    }
}

impl Default for LiveShared {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug)]
pub enum RecMsg {
    Start { take: u32, song: bool, start_tick: f64, pattern_slot: u32, midi: bool, audio: bool },
    Note { take: u32, slot: u32, pattern_slot: u32, key: u8, vel: f32, tick: f64, dur: f64, pass: u32 },
    Wrap { take: u32, sec: f64, lo: f64, hi: f64 },
    End { take: u32, sec: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CapWin {
    Begin { take: u32, from_ns: u64 },
    End { take: u32, until_ns: u64 },
}

pub const MIDI_RING: usize = 4096;
pub const REC_RING: usize = 16384;
pub const WIN_RING: usize = 64;
pub const MON_RING: usize = 32768;

pub struct LiveRtEnds {
    pub live: Arc<LiveShared>,
    pub midi_rx: rtrb::Consumer<LiveEv>,
    pub rec_tx: rtrb::Producer<RecMsg>,
    pub win_tx: rtrb::Producer<CapWin>,
    pub mon_rx: rtrb::Consumer<f32>,
}

pub struct LiveCtlEnds {
    pub live: Arc<LiveShared>,
    pub sink: Arc<MidiSink>,
    pub cc_rx: crossbeam_channel::Receiver<CcEv>,
    pub rec_rx: rtrb::Consumer<RecMsg>,
    pub win_rx: rtrb::Consumer<CapWin>,
    pub mon_tx: rtrb::Producer<f32>,
}

pub fn live_channels(live: Arc<LiveShared>) -> (LiveRtEnds, LiveCtlEnds) {
    let (midi_tx, midi_rx) = rtrb::RingBuffer::new(MIDI_RING);
    let (rec_tx, rec_rx) = rtrb::RingBuffer::new(REC_RING);
    let (win_tx, win_rx) = rtrb::RingBuffer::new(WIN_RING);
    let (mon_tx, mon_rx) = rtrb::RingBuffer::new(MON_RING);
    let (cc_tx, cc_rx) = crossbeam_channel::unbounded();
    let sink = Arc::new(MidiSink::new(midi_tx, cc_tx, live.clone()));
    (LiveRtEnds { live: live.clone(), midi_rx, rec_tx, win_tx, mon_rx }, LiveCtlEnds { live, sink, cc_rx, rec_rx, win_rx, mon_tx })
}

pub const MAX_BLOCK_EVENTS: usize = 1024;

#[derive(Clone, Copy, Debug)]
pub struct Pending {
    pub off: u32,
    pub msg: MidiMsg,
}

#[derive(Clone, Copy, Default)]
pub struct OpenNote {
    pub on: bool,
    pub slot: u32,
    pub pattern_slot: u32,
    pub vel: f32,
    pub tick: f64,
    pub abs: f64,
    pub pass: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RecState {
    Idle,
    CountIn,
    Recording,
}

pub struct LiveRt {
    pub live: Arc<LiveShared>,
    pub midi_rx: Option<rtrb::Consumer<LiveEv>>,
    pub rec_tx: Option<rtrb::Producer<RecMsg>>,
    pub win_tx: Option<rtrb::Producer<CapWin>>,
    pub mon_rx: Option<rtrb::Consumer<f32>>,
    pub block_t_ns: u64,
    pub prev_block_t_ns: u64,
    pub block_frames: usize,
    pub sub_base: usize,
    pub pending: Vec<Pending>,
    pub pend_idx: usize,
    pub held: [u32; 128],
    pub sustain: bool,
    pub sustained: [bool; 128],
    pub state: RecState,
    pub take: u32,
    pub song: bool,
    pub rec_midi: bool,
    pub rec_audio: bool,
    pub abs_ticks: f64,
    pub last_pos: f64,
    pub wrapped: bool,
    pub pass: u32,
    pub take_from_ns: u64,
    pub open: [OpenNote; 128],
    pub ci_total: f64,
    pub ci_elapsed: f64,
    pub ci_beat: f64,
    pub ci_per_bar: u32,
    pub ci_next: u32,
    pub bypass_intercept: bool,
    pub mon_starved: bool,
}

impl LiveRt {
    pub fn new(live: Arc<LiveShared>) -> Self {
        Self {
            live,
            midi_rx: None,
            rec_tx: None,
            win_tx: None,
            mon_rx: None,
            block_t_ns: 0,
            prev_block_t_ns: 0,
            block_frames: 0,
            sub_base: 0,
            pending: Vec::with_capacity(MAX_BLOCK_EVENTS),
            pend_idx: 0,
            held: [NONE; 128],
            sustain: false,
            sustained: [false; 128],
            state: RecState::Idle,
            take: 0,
            song: false,
            rec_midi: true,
            rec_audio: false,
            abs_ticks: 0.0,
            last_pos: 0.0,
            wrapped: false,
            pass: 0,
            take_from_ns: 0,
            open: [OpenNote::default(); 128],
            ci_total: 0.0,
            ci_elapsed: 0.0,
            ci_beat: 0.0,
            ci_per_bar: 4,
            ci_next: 0,
            bypass_intercept: false,
            mon_starved: true,
        }
    }

    pub fn attach(&mut self, ends: LiveRtEnds) {
        self.live = ends.live;
        self.midi_rx = Some(ends.midi_rx);
        self.rec_tx = Some(ends.rec_tx);
        self.win_tx = Some(ends.win_tx);
        self.mon_rx = Some(ends.mon_rx);
    }

    #[inline]
    pub fn attached(&self) -> bool {
        self.midi_rx.is_some()
    }

    pub fn begin_block(&mut self, now: u64, frames: usize, sr: f64) {
        self.prev_block_t_ns = if self.block_t_ns == 0 { now } else { self.block_t_ns };
        self.block_t_ns = now;
        self.block_frames = frames;
        self.sub_base = 0;
        self.pending.clear();
        self.pend_idx = 0;
        let Some(rx) = self.midi_rx.as_mut() else { return };
        while let Ok(ev) = rx.pop() {
            if self.pending.len() >= MAX_BLOCK_EVENTS {
                self.live.rt_dropped.fetch_add(1, Relaxed);
                continue;
            }
            let off = event_offset(ev.t_ns, self.prev_block_t_ns, sr, frames);
            let mut i = self.pending.len();
            self.pending.push(Pending { off, msg: ev.msg });
            while i > 0 && self.pending[i - 1].off > off {
                self.pending.swap(i - 1, i);
                i -= 1;
            }
        }
    }

    pub fn publish_state(&self) {
        let s = match self.state {
            RecState::Idle => STATE_IDLE,
            RecState::CountIn => STATE_COUNT_IN,
            RecState::Recording => STATE_RECORDING,
        };
        self.live.state.store(s, Relaxed);
    }

    pub fn start_count_in(&mut self, total: f64, beat: f64, per_bar: u32) {
        self.state = RecState::CountIn;
        self.ci_total = total;
        self.ci_beat = beat.max(1.0);
        self.ci_per_bar = per_bar.max(1);
        self.ci_elapsed = 0.0;
        self.ci_next = 0;
        self.live.count_in_beats.store((total / self.ci_beat).ceil() as u32, Relaxed);
        self.publish_state();
    }

    pub fn cancel_count_in(&mut self) {
        self.state = RecState::Idle;
        self.live.count_in_beats.store(0, Relaxed);
        self.publish_state();
    }

    pub fn count_in_step(&mut self, n: usize) -> (Option<(usize, bool)>, bool) {
        let a = self.ci_elapsed;
        let b = a + n as f64;
        let mut click = None;
        let bf = self.ci_next as f64 * self.ci_beat;
        if bf < b && bf < self.ci_total - 0.5 {
            let off = ((bf - a).max(0.0).round() as usize).min(n.saturating_sub(1));
            click = Some((off, self.ci_next % self.ci_per_bar == 0));
            self.ci_next += 1;
        }
        self.ci_elapsed = b;
        let left = ((self.ci_total - b) / self.ci_beat).ceil().max(0.0) as u32;
        self.live.count_in_beats.store(left, Relaxed);
        (click, b >= self.ci_total)
    }

    pub fn push_rec(&mut self, m: RecMsg) {
        if let Some(tx) = self.rec_tx.as_mut() {
            if tx.push(m).is_err() {
                self.live.rt_dropped.fetch_add(1, Relaxed);
            }
        }
    }

    pub fn push_win(&mut self, w: CapWin) {
        if let Some(tx) = self.win_tx.as_mut() {
            if tx.push(w).is_err() {
                self.live.rt_dropped.fetch_add(1, Relaxed);
            }
        }
    }
}

#[inline]
pub fn event_offset(t_ns: u64, prev_block_ns: u64, sr: f64, frames: usize) -> u32 {
    if frames == 0 {
        return 0;
    }
    let dt = t_ns.saturating_sub(prev_block_ns) as f64 * 1e-9;
    let f = (dt * sr).round();
    f.clamp(0.0, (frames - 1) as f64) as u32
}

#[inline]
pub fn heard_ns(block_ns: u64, out_latency_ns: u64, off: usize, sr: f64) -> u64 {
    block_ns + out_latency_ns + (off as f64 * 1e9 / sr.max(1.0)) as u64
}

#[inline]
pub fn pos_before(pos_end: f64, back_ticks: f64, lo: f64, hi: f64) -> f64 {
    let p = pos_end - back_ticks;
    if p < lo && hi.is_finite() && hi > lo {
        p + (hi - lo)
    } else {
        p
    }
}

#[inline]
pub fn compensate_tick(tick: f64, comp_ticks: f64, lo: f64, hi: f64, wrapped: bool) -> f64 {
    let x = tick - comp_ticks.max(0.0);
    if x >= lo {
        return x;
    }
    let span = hi - lo;
    if wrapped && span.is_finite() && span > 0.0 {
        lo + (x - lo).rem_euclid(span)
    } else {
        lo
    }
}

#[inline]
pub fn wrap_offset(pos_end: f64, lo: f64, n: usize, tpf: f64) -> usize {
    let after = ((pos_end - lo) / tpf.max(1e-12)).round();
    let after = if after.is_finite() { after.max(0.0) as usize } else { 0 };
    n.saturating_sub(after.min(n))
}

#[inline]
pub fn note_pass(pass: u32, pos_end: f64, played_tick: f64, recorded_tick: f64) -> u32 {
    let mut p = pass;
    if played_tick > pos_end + 1e-9 {
        p = p.saturating_sub(1);
    }
    if recorded_tick > played_tick + 1e-9 {
        p = p.saturating_sub(1);
    }
    p
}

pub fn count_in_frames(bars: u32, num: f64, den: f64, ticks_per_frame: f64) -> (f64, f64, u32) {
    let tpf = ticks_per_frame.max(1e-9);
    let bar = bar_ticks(num, den);
    let beat = beat_ticks(den);
    let per_bar = (bar / beat).round().max(1.0) as u32;
    (bars as f64 * bar / tpf, beat / tpf, per_bar)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::ticks_per_frame;

    #[test]
    fn events_are_scheduled_one_block_late_without_jitter() {
        let sr = 48000.0;
        let ms = 1_000_000u64;
        assert_eq!(event_offset(100 * ms, 100 * ms, sr, 480), 0);
        assert_eq!(event_offset(105 * ms, 100 * ms, sr, 480), 240, "5 ms into the previous block → frame 240");
        assert_eq!(event_offset(100 * ms + 20_833, 100 * ms, sr, 480), 1, "~1 frame");
        assert_eq!(event_offset(99 * ms, 100 * ms, sr, 480), 0, "older than the previous block → frame 0");
        assert_eq!(event_offset(130 * ms, 100 * ms, sr, 480), 479, "late callback → clamp to the last frame");
        assert_eq!(event_offset(130 * ms, 100 * ms, sr, 0), 0);
        let a = event_offset(102 * ms, 100 * ms, sr, 480);
        let b = event_offset(103 * ms, 100 * ms, sr, 480);
        assert_eq!(b - a, 48);
    }

    #[test]
    fn heard_time_adds_output_latency_and_offset() {
        let ms = 1_000_000u64;
        assert_eq!(heard_ns(1000 * ms, 20 * ms, 0, 48000.0), 1020 * ms);
        assert_eq!(heard_ns(1000 * ms, 20 * ms, 480, 48000.0), 1030 * ms);
    }

    #[test]
    fn ticks_from_sample_time_and_loop_wrap() {
        let tpf = ticks_per_frame(120.0, 48000.0);
        let t = pos_before(1281.28, 24.0 * tpf, 0.0, 3840.0);
        assert!((t - 1280.32).abs() < 1e-9);
        let t = pos_before(0.4, 20.0 * tpf, 0.0, 3840.0);
        assert!((t - 3839.6).abs() < 1e-9, "{t}");
        assert!((pos_before(10.0, 4.0, 0.0, f64::INFINITY) - 6.0).abs() < 1e-12);
    }

    #[test]
    fn latency_compensation_and_wrap_back() {
        let tpf = ticks_per_frame(120.0, 48000.0);
        let comp = (480.0 + 0.020 * 48000.0) * tpf;
        assert!((comp - 57.6).abs() < 1e-9);
        assert!((compensate_tick(1017.6, comp, 0.0, 3840.0, false) - 960.0).abs() < 1e-9);
        assert!(compensate_tick(57.6, comp, 0.0, 3840.0, true).abs() < 1e-9);
        assert!((compensate_tick(40.0, comp, 0.0, 3840.0, true) - (3840.0 - 17.6)).abs() < 1e-9);
        assert_eq!(compensate_tick(40.0, comp, 0.0, 3840.0, false), 0.0);
        assert!((compensate_tick(1930.0, 57.6, 1920.0, 5760.0, true) - (5760.0 - 47.6)).abs() < 1e-9);
        assert_eq!(compensate_tick(10.0, 57.6, 0.0, f64::INFINITY, true), 0.0);
        assert!((compensate_tick(15360.0, 57.6, 0.0, f64::INFINITY, true) - 15302.4).abs() < 1e-9);
    }

    #[test]
    fn take_pass_boundaries() {
        let tpf = ticks_per_frame(120.0, 48000.0);
        assert_eq!(wrap_offset(1920.4, 1920.0, 32, tpf), 22);
        assert_eq!(wrap_offset(1920.0, 1920.0, 32, tpf), 32);
        assert_eq!(wrap_offset(1930.0, 1920.0, 32, tpf), 0);
        assert_eq!(note_pass(1, 12.0, 10.0, 3830.0), 0);
        assert_eq!(note_pass(1, 120.0, 100.0, 80.0), 1);
        assert_eq!(note_pass(0, 12.0, 10.0, 0.0), 0);
        assert_eq!(note_pass(2, 1921.0, 5755.0, 5740.0), 1);
    }

    #[test]
    fn count_in_lengths() {
        let tpf = ticks_per_frame(120.0, 48000.0);
        let (total, beat, per_bar) = count_in_frames(1, 4.0, 4.0, tpf);
        assert!((total - 96000.0).abs() < 1e-6 && (beat - 24000.0).abs() < 1e-6 && per_bar == 4);
        let (total, beat, per_bar) = count_in_frames(2, 6.0, 8.0, tpf);
        assert!((total - 2.0 * 2880.0 / tpf).abs() < 1e-6 && (beat - 480.0 / tpf).abs() < 1e-6 && per_bar == 6);
    }

    #[test]
    fn count_in_clicks_every_beat_with_bar_accents() {
        let tpf = ticks_per_frame(120.0, 48000.0);
        let (total, beat, per_bar) = count_in_frames(1, 4.0, 4.0, tpf);
        let mut rt = LiveRt::new(Arc::new(LiveShared::new()));
        rt.start_count_in(total, beat, per_bar);
        assert_eq!(rt.live.count_in_beats.load(Relaxed), 4);
        let mut clicks = Vec::new();
        let mut frame = 0usize;
        loop {
            let (c, done) = rt.count_in_step(32);
            if let Some((off, accent)) = c {
                clicks.push((frame + off, accent));
            }
            frame += 32;
            if done {
                break;
            }
        }
        assert_eq!(clicks, vec![(0, true), (24000, false), (48000, false), (72000, false)]);
        assert_eq!(frame, 96000, "ends exactly after one bar");
        assert_eq!(rt.live.count_in_beats.load(Relaxed), 0);
    }

    #[test]
    fn block_events_are_sorted_and_bounded() {
        let live = Arc::new(LiveShared::new());
        let (rt_ends, ctl) = live_channels(live.clone());
        let mut rt = LiveRt::new(live.clone());
        rt.attach(rt_ends);
        let ms = 1_000_000u64;
        rt.begin_block(100 * ms, 480, 48000.0);
        let dev: Arc<str> = Arc::from("test");
        let mut rs = 0;
        crate::midi::init_clock();
        ctl.sink.feed(&dev, &[0x90, 60, 100], &mut rs);
        ctl.sink.feed(&dev, &[0x80, 60, 0], &mut rs);
        ctl.sink.feed(&dev, &[0xB0, 74, 3], &mut rs);
        let now = crate::midi::now_ns();
        rt.begin_block(now + 5 * ms, 480, 48000.0);
        assert_eq!(rt.pending.len(), 2, "notes go to the audio thread, CC 74 does not");
        assert!(matches!(rt.pending[0].msg, MidiMsg::NoteOn { key: 60, .. }));
        assert!(matches!(rt.pending[1].msg, MidiMsg::NoteOff { key: 60, .. }));
        assert!(rt.pending[0].off <= rt.pending[1].off);
        assert_eq!(ctl.cc_rx.try_iter().count(), 1);
        assert_eq!(live.midi_in.load(Relaxed), 3);
    }
}
