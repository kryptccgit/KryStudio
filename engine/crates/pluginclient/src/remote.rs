//! `RemoteInstrument` / `RemoteEffect`: the dsp traits, proxied to the
//! plugin host. Every [RT] method here is allocation-free and lock-free:
//! events go into a preallocated local list and cross to the host in the
//! shared block of the next process() call (one synchronous round trip).

use crate::manager::Inst;
use crate::shm::{self, ev, flag, Ev, MAX_EVENTS, MAX_FRAMES};
use krypt_studio_dsp::{Effect, Instrument, NoteExtras, ProcessContext};
use serde_json::json;
use std::sync::atomic::Ordering::*;
use std::sync::Arc;
use std::time::Duration;

/// Live engine: how long one call may block the audio thread before we
/// give up on this block (the host is then "busy" until it answers).
const RT_DEADLINE: Duration = Duration::from_millis(30);
/// Offline render: plugins may be slow, nobody is listening.
const OFFLINE_DEADLINE: Duration = Duration::from_secs(10);
/// A host that stays busy this long is hung (the watchdog kills it).
const HUNG_AFTER_SEC: f32 = 2.0;

pub(crate) struct Core {
    pub inst: Arc<Inst>,
    param_ids: Arc<[u32]>,
    /// Latest value per descriptor param not yet sent (NaN = none).
    pending: Vec<f32>,
    any_pending: bool,
    events: Vec<Ev>,
    seq: u32,
    inflight: bool,
    /// set_param calls before the first process() are the engine's full
    /// default sweep: ignore them (initial values come from `initial`).
    armed: bool,
    busy_frames: f32,
    deadline: Duration,
    reset: bool,
    sr: f32,
    pub peak: f32,
}

impl Core {
    pub fn new(inst: Arc<Inst>, param_ids: Arc<[u32]>, initial: &[(usize, f32)], sr: f32, realtime: bool) -> Core {
        let mut pending = vec![f32::NAN; param_ids.len()];
        let mut any = false;
        for &(i, v) in initial {
            if let Some(p) = pending.get_mut(i) {
                *p = v;
                any = true;
            }
        }
        Core {
            inst,
            param_ids,
            pending,
            any_pending: any,
            events: Vec::with_capacity(MAX_EVENTS),
            seq: 0,
            inflight: false,
            armed: false,
            busy_frames: 0.0,
            deadline: if realtime { RT_DEADLINE } else { OFFLINE_DEADLINE },
            reset: false,
            sr,
            peak: 0.0,
        }
    }

    #[inline]
    fn push(&mut self, e: Ev) {
        if self.events.len() < MAX_EVENTS {
            self.events.push(e);
        }
    }

    #[inline]
    pub fn set_param(&mut self, index: usize, value: f32) {
        if !self.armed {
            return;
        }
        if let Some(p) = self.pending.get_mut(index) {
            *p = value;
            self.any_pending = true;
        }
    }

    pub fn prepare(&mut self, sr: f32) {
        if (sr - self.sr).abs() > 0.5 {
            self.sr = sr;
            if self.inst.conn.alive.load(Acquire) {
                self.inst.conn.send_async("setSampleRate", json!({ "inst": self.inst.id, "sampleRate": sr }), None);
            }
        }
    }

    fn state(&self) -> u32 {
        if self.inst.is_dead() {
            return shm::state::DEAD;
        }
        self.inst.chan.map.block().state.load(Acquire)
    }

    /// [RT] One round trip. `input` (effects) is copied into the block;
    /// on success the plugin's output is in the block's `audio_out`.
    /// Returns false when there is no output for this block.
    fn exchange(&mut self, ctx: &ProcessContext, input: Option<(&[f32], &[f32])>, n: usize) -> bool {
        self.armed = true;
        let chan = &self.inst.chan;
        if self.inflight {
            if chan.is_done(self.seq) {
                self.inflight = false; // stale block: drop its output
            } else {
                self.busy_frames += n as f32;
                if self.busy_frames > HUNG_AFTER_SEC * self.sr.max(8000.0) {
                    self.inst.hung.store(true, Relaxed);
                }
                self.events.clear();
                return false;
            }
        }
        let p = chan.map.raw();
        // SAFETY: not in flight → the client owns the block's plain fields.
        unsafe {
            let mut k = 0usize;
            for e in self.events.iter() {
                if k >= MAX_EVENTS {
                    break;
                }
                (*p).events[k] = *e;
                k += 1;
            }
            if self.any_pending {
                for (i, v) in self.pending.iter_mut().enumerate() {
                    if !v.is_nan() && k < MAX_EVENTS {
                        (*p).events[k] = Ev { kind: ev::PARAM, offset: 0, key: 0, id: self.param_ids[i], value: *v as f64, aux: 0.0 };
                        k += 1;
                        *v = f32::NAN;
                    }
                }
                self.any_pending = false;
            }
            (*p).n_events = k as u32;
            (*p).frames = n as u32;
            (*p).flags = if ctx.playing { flag::PLAYING } else { 0 } | if self.reset { flag::RESET } else { 0 };
            (*p).sample_rate = ctx.sample_rate as f64;
            (*p).bpm = ctx.bpm;
            (*p).beat_pos = ctx.beat_pos;
            (*p).status = 0;
            let ain = &mut (*p).audio_in;
            match input {
                Some((l, r)) => {
                    ain[0][..n].copy_from_slice(&l[..n]);
                    ain[1][..n].copy_from_slice(&r[..n]);
                }
                None => {
                    ain[0][..n].fill(0.0);
                    ain[1][..n].fill(0.0);
                }
            }
        }
        self.events.clear();
        self.reset = false;
        self.seq = self.seq.wrapping_add(1);
        chan.publish(self.seq);
        if chan.wait_done(self.seq, self.deadline) {
            self.busy_frames = 0.0;
            true
        } else {
            self.inflight = true;
            self.busy_frames += n as f32;
            false
        }
    }

    /// [RT] Read output channel `c` of the last completed block.
    #[inline]
    fn out(&self, c: usize, n: usize) -> &[f32] {
        // SAFETY: done → the client owns the block; the slice dies before the next publish.
        unsafe { &(&(*self.inst.chan.map.raw()).audio_out)[c][..n] }
    }
}

// ── Instrument ───────────────────────────────────────────────────────────

pub struct RemoteInstrument {
    core: Core,
    /// Key actually sent to the plugin for each engine key (pitch offsets).
    sent: [u8; 128],
    held: [bool; 128],
    held_count: u32,
    silent_frames: f32,
}

impl RemoteInstrument {
    pub(crate) fn new(core: Core) -> Self {
        RemoteInstrument { core, sent: [0; 128], held: [false; 128], held_count: 0, silent_frames: f32::MAX }
    }

    fn release_all(&mut self) {
        self.held = [false; 128];
        self.held_count = 0;
    }
}

impl Instrument for RemoteInstrument {
    fn prepare(&mut self, sample_rate: f32, _max_frames: usize) {
        self.core.prepare(sample_rate);
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.core.set_param(index, value);
    }

    fn note_on(&mut self, offset: usize, key: u8, pitch: f32, velocity: f32, _extras: NoteExtras) {
        let k = (key as usize).min(127);
        let target = pitch.round().clamp(0.0, 127.0);
        if self.held[k] {
            // Retrigger: release the previous voice for this key first.
            self.core.push(Ev { kind: ev::NOTE_OFF, offset: offset as u32, key: self.sent[k] as u32, id: 0, value: 0.5, aux: 0.0 });
        } else {
            self.held[k] = true;
            self.held_count += 1;
        }
        self.sent[k] = target as u8;
        self.silent_frames = 0.0;
        self.core.push(Ev { kind: ev::NOTE_ON, offset: offset as u32, key: target as u32, id: 0, value: velocity.clamp(0.0, 1.0) as f64, aux: (pitch - target) as f64 });
    }

    fn note_off(&mut self, offset: usize, key: u8) {
        let k = (key as usize).min(127);
        if !self.held[k] {
            return;
        }
        self.held[k] = false;
        self.held_count = self.held_count.saturating_sub(1);
        self.core.push(Ev { kind: ev::NOTE_OFF, offset: offset as u32, key: self.sent[k] as u32, id: 0, value: 0.5, aux: 0.0 });
    }

    fn choke(&mut self, offset: usize) {
        self.release_all();
        self.core.push(Ev { kind: ev::CHOKE, offset: offset as u32, key: 0, id: 0, value: 0.0, aux: 0.0 });
    }

    fn all_off(&mut self) {
        self.release_all();
        self.core.push(Ev { kind: ev::ALL_OFF, offset: 0, key: 0, id: 0, value: 0.0, aux: 0.0 });
    }

    fn process(&mut self, ctx: &ProcessContext, out: [&mut [f32]; 2]) {
        let n = ctx.frames.min(MAX_FRAMES).min(out[0].len()).min(out[1].len());
        let st = self.core.state();
        if st != shm::state::READY {
            self.core.events.clear();
            if st != shm::state::LOADING && st != shm::state::PAUSED {
                self.release_all();
            }
            self.core.peak = 0.0;
            return;
        }
        if !self.core.exchange(ctx, None, n) {
            self.core.peak = 0.0;
            return;
        }
        let [l, r] = out;
        let mut pk = 0f32;
        let (ol, or) = (self.core.out(0, n), self.core.out(1, n));
        for i in 0..n {
            let (a, b) = (ol[i], or[i]);
            // Never let a misbehaving plugin poison the mix with NaN/inf.
            let (a, b) = (if a.is_finite() { a } else { 0.0 }, if b.is_finite() { b } else { 0.0 });
            l[i] += a;
            r[i] += b;
            pk = pk.max(a.abs()).max(b.abs());
        }
        self.core.peak = pk;
        if pk > 1e-5 {
            self.silent_frames = 0.0;
        } else {
            self.silent_frames += n as f32;
        }
    }

    fn activity(&self) -> f32 {
        self.core.peak.min(1.0)
    }

    fn is_active(&self) -> bool {
        // Keep processing while notes are held and for a few seconds of tail.
        self.held_count > 0 || self.silent_frames < 3.0 * self.core.sr.max(8000.0) || !self.core.events.is_empty()
    }

    /// The plugin's reported latency (instrument PDC, docs/ENGINE_PROTOCOL.md §12).
    fn latency(&self) -> usize {
        self.core.inst.latency()
    }
}

// ── Effect ───────────────────────────────────────────────────────────────

pub struct RemoteEffect {
    core: Core,
}

impl RemoteEffect {
    pub(crate) fn new(core: Core) -> Self {
        RemoteEffect { core }
    }
}

impl Effect for RemoteEffect {
    fn prepare(&mut self, sample_rate: f32, _max_frames: usize) {
        self.core.prepare(sample_rate);
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.core.set_param(index, value);
    }

    fn process(&mut self, ctx: &ProcessContext, buf: [&mut [f32]; 2], _sidechain: Option<[&[f32]; 2]>) {
        let n = ctx.frames.min(MAX_FRAMES).min(buf[0].len()).min(buf[1].len());
        let [l, r] = buf;
        match self.core.state() {
            shm::state::READY => {}
            // Still loading / failed to load: pass audio through (like a missing stock effect).
            shm::state::LOADING | shm::state::FAILED | shm::state::PAUSED => {
                self.core.events.clear();
                return;
            }
            // Crashed: silence.
            _ => {
                l[..n].fill(0.0);
                r[..n].fill(0.0);
                return;
            }
        }
        if !self.core.exchange(ctx, Some((&l[..n], &r[..n])), n) {
            l[..n].fill(0.0);
            r[..n].fill(0.0);
            return;
        }
        let (ol, or) = (self.core.out(0, n), self.core.out(1, n));
        for i in 0..n {
            l[i] = if ol[i].is_finite() { ol[i] } else { 0.0 };
            r[i] = if or[i].is_finite() { or[i] } else { 0.0 };
        }
    }

    fn latency(&self) -> usize {
        self.core.inst.latency()
    }

    fn reset(&mut self) {
        self.core.reset = true;
    }
}
