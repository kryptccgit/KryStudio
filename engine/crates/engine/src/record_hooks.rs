//! Live MIDI input + recording hooks into the real-time core. Declared as a
//! child module of `core` (core.rs: `#[path = "record_hooks.rs"] mod
//! record_hooks;`) so it can drive the sequencer's private state; core.rs
//! only carries the call sites, each marked `// live input:`.
//!
//! [RT] Everything here runs on the audio thread: no allocation, no locks.
//! Offline renders never attach the live queues, so every hook is a no-op
//! there (`self.live.attached()` is false).

use super::*;
use crate::midi::{now_ns, MidiMsg};
use crate::record::{
    compensate_tick, count_in_frames, heard_ns, note_pass, pos_before, wrap_offset, CapWin,
    OpenNote, RecMsg, RecState,
};

/// Live events sort between sequenced note-offs (0) and note-ons (2); among
/// themselves they keep arrival order (Ev::seq).
const LIVE_ORDER: u8 = 1;
/// Monitor: refill to this many frames after an underrun, drop above MAX.
const MON_PRIME: usize = 768;
const MON_MAX: usize = 4096;

impl Core {
    /// [RT] Hook: start of every device block, before commands are drained.
    pub(super) fn live_block(&mut self, frames: usize) {
        if self.live.attached() {
            self.live.begin_block(now_ns(), frames, self.sr as f64);
        }
    }

    /// [RT] Hook (top of `play`): with record armed and a count-in set, count
    /// in on the metronome first; the transport starts when it ends.
    pub(super) fn live_intercept_play(&mut self) -> bool {
        if !self.live.attached() || self.render_mode || self.playing {
            return false;
        }
        if self.live.bypass_intercept {
            self.live.bypass_intercept = false;
            return false;
        }
        if self.live.state == RecState::CountIn {
            return true;
        }
        let bars = self.live.live.count_in_bars.load(Relaxed).min(4);
        if bars == 0 || !self.live.live.armed.load(Relaxed) {
            return false;
        }
        let t = &self.program.transport;
        let tpf = ticks_per_frame(t.bpm.clamp(10.0, 999.0), self.sr as f64);
        let (total, beat, per_bar) = count_in_frames(bars, t.num, t.den, tpf);
        self.live.start_count_in(total, beat, per_bar);
        true
    }

    /// [RT] Hook (top of `stop` / `pause`): cancel a count-in, end the take.
    pub(super) fn live_transport_stopped(&mut self) {
        if !self.live.attached() {
            return;
        }
        match self.live.state {
            RecState::CountIn => self.live.cancel_count_in(),
            RecState::Recording => self.live_end_take(0),
            RecState::Idle => {}
        }
    }

    /// Hook (`loop_bounds`): while record is armed, song mode without a loop
    /// region keeps playing past the last clip (FL), so a take can extend the song.
    #[inline]
    pub(super) fn live_extends_song(&self) -> bool {
        self.live.attached() && self.live.live.armed.load(Relaxed)
    }

    /// Hook (`finish_master`): the count-in clicks while the transport is stopped.
    #[inline]
    pub(super) fn live_counting_in(&self) -> bool {
        self.live.state == RecState::CountIn
    }

    /// [RT] Hook: after the sequencer advanced this sub-block (`self.pos` is
    /// its END position) and before its events are dispatched.
    pub(super) fn live_sub(&mut self, n: usize) {
        if !self.live.attached() || n == 0 {
            return;
        }
        let sr = self.sr as f64;
        let tpf = ticks_per_frame(self.program.transport.bpm.clamp(10.0, 999.0), sr);
        let base = self.live.sub_base;
        // Whether the transport advanced during THIS sub-block (a play() issued
        // below by the count-in only takes effect from the next one).
        let playing = self.playing && !self.render_mode;

        // 1. Count-in: metronome clicks; the transport starts after the last beat.
        if self.live.state == RecState::CountIn {
            let (click, done) = self.live.count_in_step(n);
            if let Some((off, accent)) = click {
                self.click.start = Some(off);
                self.click.pending_accent = accent;
            }
            if done {
                self.live.cancel_count_in();
                self.live.bypass_intercept = true;
                self.play(); // takes effect from the next sub-block
            }
        }

        // 2. Take start / end (arm while playing = punch in, disarm = punch out).
        let armed = self.live.live.armed.load(Relaxed);
        let (lo, hi) = self.loop_bounds();
        if self.live.state == RecState::Recording && !(armed && playing) {
            self.live_end_take(base);
        }
        if self.live.state == RecState::Idle && armed && playing {
            let start = pos_before(self.pos, n as f64 * tpf, lo, hi);
            self.live_begin_take(start, base);
        }
        if self.live.state == RecState::Recording {
            if self.pos + 1e-9 < self.live.last_pos {
                self.live.wrapped = true;
                self.live.pass += 1;
                let take = self.live.take;
                // Takes (docs §13): when, in heard time since the take began, the wrap happened.
                let off = base + wrap_offset(self.pos, lo, n, tpf);
                let at = heard_ns(self.live.block_t_ns, self.out_latency_ns(), off, self.sr as f64);
                let sec = at.saturating_sub(self.live.take_from_ns) as f64 * 1e-9;
                self.live.push_rec(RecMsg::Wrap { take, sec, lo, hi });
            }
            self.live.last_pos = self.pos;
        }

        // 3. MIDI events that fall into this sub-block.
        while self.live.pend_idx < self.live.pending.len() {
            let p = self.live.pending[self.live.pend_idx];
            if p.off as usize >= base + n {
                break;
            }
            self.live.pend_idx += 1;
            let off = (p.off as usize).saturating_sub(base).min(n - 1);
            self.live_event(off, p.msg, n, tpf, lo, hi);
        }

        // 4. Input monitoring straight into the master bus.
        self.live_monitor(n);

        if self.live.state == RecState::Recording {
            self.live.abs_ticks += n as f64 * tpf;
        }
        self.live.sub_base += n;
    }

    fn out_latency_ns(&self) -> u64 {
        self.shared.out_latency_us.load(Relaxed) as u64 * 1000
    }

    fn live_begin_take(&mut self, start_tick: f64, base: usize) {
        let l = &self.live.live;
        let midi = l.rec_midi.load(Relaxed);
        let audio = l.rec_audio.load(Relaxed);
        let song = self.song_mode();
        let take = self.live.take.wrapping_add(1).max(1);
        let from_ns = heard_ns(
            self.live.block_t_ns,
            self.out_latency_ns(),
            base,
            self.sr as f64,
        );
        let r = &mut self.live;
        r.take = take;
        r.state = RecState::Recording;
        r.song = song;
        r.rec_midi = midi;
        r.rec_audio = audio;
        r.abs_ticks = 0.0;
        r.last_pos = self.pos;
        r.wrapped = false;
        r.pass = 0;
        r.take_from_ns = from_ns;
        for o in r.open.iter_mut() {
            o.on = false;
        }
        r.publish_state();
        let pattern_slot = if song { NONE } else { self.cur_pattern };
        r.push_rec(RecMsg::Start {
            take,
            song,
            start_tick,
            pattern_slot,
            midi,
            audio,
        });
        if audio {
            r.push_win(CapWin::Begin { take, from_ns });
        }
    }

    /// End the take at frame `off` of the current block (sub-block start).
    fn live_end_take(&mut self, off: usize) {
        let until_ns = heard_ns(
            self.live.block_t_ns,
            self.out_latency_ns(),
            off,
            self.sr as f64,
        );
        let take = self.live.take;
        // Notes still held end here.
        for k in 0..128u8 {
            self.live_close_note(k, 0.0);
        }
        let r = &mut self.live;
        let sec = until_ns.saturating_sub(r.take_from_ns) as f64 * 1e-9;
        r.push_rec(RecMsg::End { take, sec });
        if r.rec_audio {
            r.push_win(CapWin::End { take, until_ns });
        }
        r.state = RecState::Idle;
        r.publish_state();
    }

    /// Close a recorded note `extra_ticks` after the current sub-block start.
    fn live_close_note(&mut self, key: u8, extra_ticks: f64) {
        let k = key as usize & 127;
        let o = self.live.open[k];
        if !o.on {
            return;
        }
        self.live.open[k].on = false;
        let dur = (self.live.abs_ticks + extra_ticks - o.abs).max(1.0);
        let take = self.live.take;
        self.live.push_rec(RecMsg::Note {
            take,
            slot: o.slot,
            pattern_slot: o.pattern_slot,
            key,
            vel: o.vel,
            tick: o.tick,
            dur,
            pass: o.pass,
        });
    }

    fn live_event(&mut self, off: usize, msg: MidiMsg, n: usize, tpf: f64, lo: f64, hi: f64) {
        match msg {
            MidiMsg::NoteOn { key, vel, .. } => {
                let k = key as usize & 127;
                if self.live.held[k] != NONE {
                    self.live_release(off, key, tpf); // same key again: retrigger
                }
                let slot = self.live.live.target_slot.load(Relaxed);
                let Some(ch) = self.program.channel(slot) else {
                    return;
                };
                let pitch = key as f32 + ch.root_shift + ch.pitch;
                let v = (vel as f32 / 127.0).clamp(0.0, 1.0);
                if !self.push_event(
                    off as u32,
                    LIVE_ORDER,
                    EvKind::On {
                        slot,
                        key,
                        pitch,
                        vel: v,
                        extras: NoteExtras::default(),
                    },
                ) {
                    return;
                }
                self.live.held[k] = slot;
                self.live.sustained[k] = false;
                if self.live.state == RecState::Recording && self.live.rec_midi {
                    let at = pos_before(self.pos, (n - off) as f64 * tpf, lo, hi);
                    let lat_frames = self.live.block_frames as f64
                        + self.out_latency_ns() as f64 * 1e-9 * self.sr as f64;
                    let tick = compensate_tick(at, lat_frames * tpf, lo, hi, self.live.wrapped);
                    let pattern_slot = if self.live.song {
                        NONE
                    } else {
                        self.cur_pattern
                    };
                    self.live.open[k] = OpenNote {
                        on: true,
                        slot,
                        pattern_slot,
                        vel: v,
                        tick,
                        abs: self.live.abs_ticks + off as f64 * tpf,
                        pass: note_pass(self.live.pass, self.pos, at, tick),
                    };
                }
            }
            MidiMsg::NoteOff { key, .. } => {
                let k = key as usize & 127;
                if self.live.sustain && self.live.held[k] != NONE {
                    self.live.sustained[k] = true;
                } else {
                    self.live_release(off, key, tpf);
                }
            }
            MidiMsg::Cc { cc: 64, value, .. } => {
                let down = value >= 64;
                if self.live.sustain && !down {
                    for k in 0..128u8 {
                        if self.live.sustained[k as usize] {
                            self.live_release(off, k, tpf);
                        }
                    }
                }
                self.live.sustain = down;
            }
            MidiMsg::Cc { cc: 120 | 123, .. } => {
                for k in 0..128u8 {
                    self.live_release(off, k, tpf);
                }
                self.live.sustain = false;
            }
            MidiMsg::Cc { .. } | MidiMsg::PitchBend { .. } => {}
        }
    }

    fn live_release(&mut self, off: usize, key: u8, tpf: f64) {
        let k = key as usize & 127;
        let slot = self.live.held[k];
        if slot == NONE {
            return;
        }
        self.live.held[k] = NONE;
        self.live.sustained[k] = false;
        self.push_event(off as u32, LIVE_ORDER, EvKind::Off { slot, key });
        self.live_close_note(key, off as f64 * tpf);
    }

    fn live_monitor(&mut self, n: usize) {
        let on = self.live.live.monitor.load(Relaxed);
        let Some(rx) = self.live.mon_rx.as_mut() else {
            return;
        };
        let avail = rx.slots() / 2;
        if !on {
            if avail > 0 {
                if let Ok(c) = rx.read_chunk(avail * 2) {
                    c.commit_all();
                }
            }
            self.live.mon_starved = true;
            return;
        }
        // Keep the monitor latency bounded (input and output clocks drift).
        if avail > MON_MAX {
            if let Ok(c) = rx.read_chunk((avail - MON_PRIME) * 2) {
                c.commit_all();
            }
        }
        let avail = rx.slots() / 2;
        if self.live.mon_starved {
            if avail < MON_PRIME {
                return;
            }
            self.live.mon_starved = false;
        }
        let frames = avail.min(n);
        if let Ok(c) = rx.read_chunk(frames * 2) {
            let (a, b) = c.as_slices();
            let mut peak = 0f32;
            for i in 0..frames {
                let li = i * 2;
                let l = if li < a.len() { a[li] } else { b[li - a.len()] };
                let ri = li + 1;
                let r = if ri < a.len() { a[ri] } else { b[ri - a.len()] };
                self.master_l[i] += l;
                self.master_r[i] += r;
                peak = peak.max(l.abs()).max(r.abs());
            }
            c.commit_all();
            if peak.is_finite() {
                self.live.live.monitor_peak.fetch_max(peak.min(4.0).to_bits(), Relaxed);
            }
        }
        if frames < n {
            self.live.mon_starved = true;
        }
    }
}
