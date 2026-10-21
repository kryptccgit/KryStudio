//! MIDI clock out + external sync hooks into the real-time core (clock.rs).
//! Declared as a child module of `core` (like record_hooks.rs) so it can
//! drive the transport; core.rs only carries the call sites, each marked
//! `// midi clock:`.
//!
//! [RT] Everything here runs on the audio thread: no allocation, no locks.
//! Offline renders never attach the clock rings, so every hook is a no-op
//! there (`self.clock.attached()` is false).

use super::*;
use crate::clock::{phase_ratio, SyncAction, SyncState, MIDI_CONTINUE, PHASE_JUMP_TICKS};
use crate::midi::now_ns;

impl Core {
    /// [RT] Hook: start of every device block (after `live_block`, before the
    /// command ring): stamp the block, follow the sync input.
    pub(super) fn clock_block(&mut self, frames: usize) {
        if !self.clock.attached() {
            return;
        }
        let sr = self.sr as f64;
        let lat = self.shared.out_latency_us.load(Relaxed) as u64 * 1000;
        let now = self.clock.fake_now.unwrap_or_else(now_ns);
        self.clock.block_t = self.clock.block.update(now + lat, frames, sr);
        self.clock.ns_per_frame = 1e9 / sr.max(1.0);
        self.clock.sub_base = 0;
        if self.clock.sync_on() {
            // The user stopped locally: wait for the master's next Start / Continue.
            if self.clock.follow.state == SyncState::Running && !self.playing {
                self.clock.follow.state = SyncState::Stopped;
            }
            let mut guard = 0;
            while let Some(ev) = self.clock.pop_sync() {
                guard += 1;
                if guard > 4096 {
                    break;
                }
                if ev.status == MIDI_CONTINUE && self.clock.follow.state != SyncState::Running {
                    // Continue resumes from where the transport is (an SPP before it already located there).
                    let p = self.pos;
                    self.clock.follow.set_pending_pos(p);
                }
                let act = self.clock.follow.on_event(ev, self.playing);
                self.clock_sync_action(act);
            }
            if self.clock.follow.lost(now as f64) {
                self.clock.follow.reset();
                if let Some(s) = &self.clock.shared {
                    s.sync_lost.fetch_add(1, Relaxed);
                }
                if self.playing {
                    self.pause();
                }
            }
        } else if self.clock.follow.state != SyncState::Stopped || self.clock.follow.bpm().is_some() {
            self.clock.follow.reset();
        }
        self.clock.publish_sync();
        self.clock_apply_tempo();
    }

    fn clock_sync_action(&mut self, act: SyncAction) {
        match act {
            SyncAction::None => {}
            SyncAction::Locate(p) => self.locate(p),
            SyncAction::Pause => self.pause(),
            SyncAction::Run { pos } => {
                // Where the master is by the time this block is heard (the anchor pulse arrived earlier).
                let lead = self.clock.follow.expected_ticks(self.clock.block_t).unwrap_or(0.0).clamp(0.0, PPQ * 4.0);
                self.locate(pos + lead);
                self.clock.slave_ticks = lead;
                if !self.playing {
                    self.live.bypass_intercept = self.live.attached(); // a synced start never counts in
                    self.play();
                }
            }
        }
    }

    /// Sync running: play at the external tempo, bent (±4 %) to close the phase
    /// error; a large error jumps. Otherwise restore the program's own tempo.
    fn clock_apply_tempo(&mut self) {
        let ext = if self.clock.sync_on() && self.clock.follow.state == SyncState::Running { self.clock.follow.bpm() } else { None };
        match ext {
            Some(ext) => {
                let mut ratio = 1.0;
                let t = self.clock.heard_at(self.clock.sub_base);
                if let Some(exp) = self.clock.follow.expected_ticks(t) {
                    let err = exp - self.clock.slave_ticks;
                    if err.abs() > PHASE_JUMP_TICKS && self.playing {
                        let p = self.pos + err;
                        self.locate(p);
                        self.clock.slave_ticks += err;
                    } else {
                        ratio = phase_ratio(err, ext);
                    }
                }
                let cur = self.program.transport.bpm;
                if !self.clock.overriding || (cur - self.clock.last_override).abs() > 1e-9 {
                    self.clock.saved_bpm = cur; // a new program / tempo automation value
                }
                let b = (ext * ratio).clamp(10.0, 999.0);
                self.program.transport.bpm = b;
                self.clock.last_override = b;
                self.clock.overriding = true;
            }
            None => {
                if self.clock.overriding {
                    if (self.program.transport.bpm - self.clock.last_override).abs() <= 1e-9 {
                        self.program.transport.bpm = self.clock.saved_bpm;
                    }
                    self.clock.overriding = false;
                }
            }
        }
    }

    /// [RT] Hook (`run_sub`, playing, after automation, before `advance`).
    pub(super) fn clock_pre_advance(&mut self) {
        if !self.clock.attached() {
            return;
        }
        self.clock_apply_tempo();
        self.clock.pt0 = self.played_ticks;
        self.clock.advanced = true;
    }

    /// [RT] Hook (`run_sub`, after the sequencer advanced): pulses of this sub-block.
    pub(super) fn clock_sub(&mut self, n: usize) {
        if !self.clock.attached() {
            return;
        }
        let out_on = self.clock.out_on();
        if self.clock.advanced {
            self.clock.advanced = false;
            let ticks = (self.played_ticks - self.clock.pt0).max(0.0);
            self.clock.slave_ticks += ticks;
            if out_on && self.clock.out.running {
                let tpf = ticks_per_frame(self.program.transport.bpm.clamp(10.0, 999.0), self.sr as f64);
                let t0 = self.clock.heard_at(self.clock.sub_base);
                let npf = self.clock.ns_per_frame;
                let mut out = self.clock.out;
                out.advance(ticks, tpf, t0, npf, &mut |e| self.clock.push(e));
                self.clock.out = out;
            }
        }
        self.clock.sub_base += n;
        // Clock out switched on / off mid-play: join at the next 16th, or stop the slaves.
        let t = self.clock.heard_at(self.clock.sub_base) as u64;
        if out_on && self.playing && !self.clock.out.running {
            let mut out = self.clock.out;
            let p = self.pos;
            out.start(p, t, &mut |e| self.clock.push(e));
            self.clock.out = out;
        } else if !out_on && self.clock.out.running {
            self.clock.out.running = false; // the control thread sent Stop to the ports it removed
        }
    }

    /// [RT] Hook (end of `play`).
    pub(super) fn clock_started(&mut self) {
        if !self.clock.attached() || !self.clock.out_on() || !self.playing {
            return;
        }
        let t = self.clock.heard_at(self.clock.sub_base) as u64;
        let mut out = self.clock.out;
        let p = self.pos;
        out.start(p, t, &mut |e| self.clock.push(e));
        self.clock.out = out;
    }

    /// [RT] Hook (`stop`, and `pause` while playing).
    pub(super) fn clock_stopped(&mut self) {
        if !self.clock.attached() || !self.clock.out.running {
            return;
        }
        let t = self.clock.heard_at(self.clock.sub_base) as u64;
        let mut out = self.clock.out;
        out.stop(t, &mut |e| self.clock.push(e));
        self.clock.out = out;
    }

    /// [RT] Hook (end of `locate`): Song Position Pointer.
    pub(super) fn clock_located(&mut self) {
        if !self.clock.attached() || !self.clock.out_on() {
            return;
        }
        let t = self.clock.heard_at(self.clock.sub_base) as u64;
        let mut out = self.clock.out;
        let p = self.pos;
        out.locate(p, t, &mut |e| self.clock.push(e));
        self.clock.out = out;
    }
}
