use super::*;
use crate::launcher::*;

const EPS: f64 = 1e-7;
const RELEASE_ORDER: u8 = 2;

#[inline]
fn frame_at(t: f64, base: f64, f: usize, n: usize, tpf: f64) -> u32 {
    let x = f as f64 + ((t - base) / tpf).round();
    x.clamp(f as f64, (n - 1) as f64) as u32
}

impl Core {
    #[inline]
    pub(super) fn launch_silenced(&self, owner: u32) -> bool {
        owner & LAUNCH_OWNER == 0 && (owner as usize) < MAX_TRACKS && self.launch.tracks[owner as usize].overridden
    }

    #[inline]
    fn launch_active(&self) -> bool {
        !self.program.launcher.clips.is_empty() || self.launch.rec_on
    }

    pub(super) fn launch_cmd(&mut self, c: LaunchCmd) {
        if self.render_mode {
            return;
        }
        match c {
            LaunchCmd::Launch { clip, release: true } => self.launch_release(clip),
            LaunchCmd::Launch { clip, release: false } => {
                if self.launch_queue_clip(clip, false) {
                    self.launch_ensure_playing();
                }
            }
            LaunchCmd::Scene(s) => {
                let Some(row) = self.program.launcher.scene_row(s) else { return };
                let gq = self.program.launcher.global_quant;
                for li in 0..self.program.launcher.lanes.len() {
                    let (track, found, empty) = {
                        let lane = &self.program.launcher.lanes[li];
                        let found = lane.clips.iter().copied().find(|&c| self.program.launcher.clip(c).is_some_and(|x| x.row == row));
                        (lane.track, found, lane.clips.is_empty())
                    };
                    match found {
                        Some(c) => {
                            self.launch_queue_clip(c, true);
                        }
                        None if !empty => self.launch_queue_stop(track, gq),
                        None => {}
                    }
                }
                self.launch_ensure_playing();
            }
            LaunchCmd::Stop(t) => {
                let gq = self.program.launcher.global_quant;
                if t == NONE {
                    for i in 0..MAX_TRACKS {
                        let st = self.launch.tracks[i];
                        if st.playing != NONE || (st.queued != NONE && st.queued != Q_STOP) {
                            self.launch_queue_stop(i as u32, gq);
                        }
                    }
                } else {
                    self.launch_queue_stop(t, gq);
                }
                if !self.playing {
                    for st in self.launch.tracks.iter_mut() {
                        if st.queued == Q_STOP {
                            st.queued = NONE;
                            st.overridden = true;
                        }
                    }
                }
            }
            LaunchCmd::BackToArrangement => self.launch_back(),
            LaunchCmd::Record(on) => {
                if on {
                    if !self.launch.rec_on {
                        self.launch.rec_on = true;
                        self.launch.rec_ran = false;
                    }
                } else if self.launch.rec_on {
                    self.launch_flush_record();
                    self.launch.rec_on = false;
                }
            }
        }
    }

    fn launch_queue_clip(&mut self, slot: u32, from_scene: bool) -> bool {
        let Some(c) = self.program.launcher.clip(slot).copied() else { return false };
        let tr = c.track as usize;
        if tr >= MAX_TRACKS {
            return false;
        }
        let immediate = !self.playing;
        let st = &mut self.launch.tracks[tr];
        if c.mode == LaunchMode::Toggle && !from_scene && st.playing == slot && st.queued == NONE {
            st.queued = Q_STOP;
        } else {
            st.queued = slot;
            st.held = !from_scene && matches!(c.mode, LaunchMode::Gate | LaunchMode::Repeat);
        }
        st.q_ticks = c.quant;
        st.q_immediate = immediate;
        st.q_after = f64::NEG_INFINITY;
        true
    }

    fn launch_queue_stop(&mut self, track: u32, q: f64) {
        let Some(st) = self.launch.tracks.get_mut(track as usize) else { return };
        st.queued = Q_STOP;
        st.q_ticks = q;
        st.q_immediate = !self.playing;
        st.q_after = f64::NEG_INFINITY;
        st.held = false;
    }

    fn launch_release(&mut self, slot: u32) {
        let Some(c) = self.program.launcher.clip(slot).copied() else { return };
        let Some(st) = self.launch.tracks.get_mut(c.track as usize) else { return };
        match c.mode {
            LaunchMode::Gate => {
                if st.queued == slot {
                    st.queued = NONE;
                } else if st.playing == slot && st.held && st.queued == NONE {
                    st.queued = Q_STOP;
                    st.q_ticks = c.quant;
                    st.q_immediate = !self.playing;
                    st.q_after = f64::NEG_INFINITY;
                }
                st.held = false;
            }
            LaunchMode::Repeat => {
                if st.queued == slot && st.q_after > f64::NEG_INFINITY {
                    st.queued = NONE;
                }
                st.held = false;
            }
            _ => {}
        }
    }

    fn launch_ensure_playing(&mut self) {
        if self.playing {
            return;
        }
        if !self.song_mode() {
            self.mode_override = Some(true);
            self.launch.forced_song = true;
        }
        self.play();
    }

    fn launch_back(&mut self) {
        let at = self.launch.last_to;
        let mut any_rechase = false;
        for t in 0..MAX_TRACKS {
            let st = self.launch.tracks[t];
            if st.idle() {
                continue;
            }
            if st.playing != NONE {
                self.launch_release_now(t as u32 | LAUNCH_OWNER);
            }
            self.launch_close_span(t, at);
            let rechase = st.overridden;
            any_rechase |= rechase;
            self.launch.tracks[t] = TrackRt { rechase, follow_n: st.follow_n, ..TrackRt::default() };
        }
        if any_rechase && self.playing && self.song_mode() {
            let pos = self.gen_cursor;
            for i in 0..self.program.audio_clips.len() {
                let c = self.program.audio_clips[i];
                let tr = c.track as usize;
                if tr < MAX_TRACKS && self.launch.tracks[tr].rechase && c.start < pos && c.end > pos {
                    if let Some(rt) = self.chan_rt.get_mut(c.ch_slot as usize) {
                        rt.rechase = true;
                        self.pending_rechase = true;
                    }
                }
            }
        }
        for st in self.launch.tracks.iter_mut() {
            st.rechase = false;
        }
    }

    pub(super) fn launch_play_started(&mut self) {
        if self.render_mode {
            return;
        }
        self.launch.starts = self.launch.starts.wrapping_add(1);
        self.launch.play_start_c = self.launch.clock;
        self.launch.last_valid = false;
        for st in self.launch.tracks.iter_mut() {
            st.follow_n = 0;
        }
    }

    pub(super) fn launch_transport_stopped(&mut self) {
        if self.render_mode {
            return;
        }
        self.launch_flush_record();
        for st in self.launch.tracks.iter_mut() {
            *st = TrackRt { overridden: st.overridden, ..TrackRt::default() };
        }
        if self.launch.forced_song {
            self.launch.forced_song = false;
            self.mode_override = None;
        }
        self.launch.last_valid = false;
    }

    #[inline]
    pub(super) fn launch_extends_song(&self) -> bool {
        self.launch.rec_on
    }

    pub(super) fn launch_paused(&mut self) {
        if self.render_mode || !self.playing {
            return;
        }
        self.launch_flush_record();
        self.launch.last_valid = false;
    }

    pub(super) fn launch_applied(&mut self, reset: bool) {
        if self.render_mode {
            return;
        }
        if reset {
            for st in self.launch.tracks.iter_mut() {
                *st = TrackRt::default();
            }
            self.launch.rec_on = false;
            self.launch.rec_ran = false;
            return;
        }
        let at = self.launch.last_to;
        for t in 0..MAX_TRACKS {
            let st = self.launch.tracks[t];
            if st.idle() {
                continue;
            }
            if self.program.launcher.lane(t as u32).is_none() {
                if st.playing != NONE {
                    self.launch_release_now(t as u32 | LAUNCH_OWNER);
                }
                self.launch_close_span(t, at);
                self.launch.tracks[t] = TrackRt::default();
                continue;
            }
            let lp = &self.program.launcher;
            let gone = |s: u32| lp.clip(s).map_or(true, |c| c.track as usize != t);
            let (play_gone, queue_gone) = (st.playing != NONE && gone(st.playing), st.queued != NONE && st.queued != Q_STOP && gone(st.queued));
            if play_gone {
                self.launch_release_now(t as u32 | LAUNCH_OWNER);
                self.launch_close_span(t, at);
                let s = &mut self.launch.tracks[t];
                s.playing = NONE;
                s.follow_c = f64::INFINITY;
            }
            if queue_gone {
                self.launch.tracks[t].queued = NONE;
            }
        }
    }

    pub(super) fn launch_publish(&self) {
        let s = &self.shared.launch;
        let lp = &self.program.launcher;
        s.any.store(!lp.clips.is_empty(), Relaxed);
        s.recording.store(self.launch.rec_on, Relaxed);
        if lp.clips.is_empty() {
            return;
        }
        for lane in lp.lanes.iter() {
            let i = lane.track as usize;
            if i >= MAX_TRACKS {
                continue;
            }
            let st = &self.launch.tracks[i];
            s.playing[i].store(st.playing, Relaxed);
            s.queued[i].store(st.queued, Relaxed);
            s.overridden[i].store(st.overridden, Relaxed);
            let pr = match lp.clip(st.playing) {
                Some(c) => {
                    let e = st.gen_e.max(0.0);
                    if c.looping {
                        e.rem_euclid(c.length) / c.length
                    } else {
                        (e / c.length).min(1.0)
                    }
                }
                None => 0.0,
            };
            s.progress[i].store((pr as f32).to_bits(), Relaxed);
        }
    }

    pub(super) fn launch_gen(&mut self, from: f64, to: f64, base: f64, f: usize, n: usize, tpf: f64) {
        if self.render_mode || !self.launch_active() {
            self.gen_events(from, to, base, f, n, tpf);
            self.launch.clock += (to - from).max(0.0);
            self.launch.last_to = to;
            self.launch.last_valid = true;
            return;
        }
        let song = self.song_mode();
        if self.launch.rec_on {
            let jumped = self.launch.last_valid && (from - self.launch.last_to).abs() > 1e-6;
            if jumped || !song {
                let at = self.launch.last_to;
                self.launch_close_spans(at);
            }
            if song {
                self.launch.rec_ran = true;
            }
        }
        let mut a = from;
        let mut steps = 0;
        loop {
            if self.launch.rec_on && song {
                self.launch_open_spans(a);
            }
            let tn = if steps < MAX_STEPS { self.launch_scan(a, to, base, song) } else { to };
            self.gen_events(a, tn, base, f, n, tpf);
            self.launch_notes(a, tn, base, f, n, tpf);
            self.launch.clock += (tn - a).max(0.0);
            if tn >= to {
                break;
            }
            self.launch_apply(tn, song, frame_at(tn, base, f, n, tpf));
            a = tn;
            steps += 1;
        }
        self.launch.last_to = to;
        self.launch.last_valid = true;
    }

    fn launch_boundary(&self, a: f64, q: f64, after: f64, song: bool) -> f64 {
        let ca = self.launch.clock;
        let mut t = if song {
            ((a - EPS) / q).ceil() * q
        } else {
            let rc = ca - self.launch.play_start_c;
            a + (((rc - EPS) / q).ceil() * q - rc)
        };
        if t < a {
            t = a;
        }
        let mut guard = 0;
        while ca + (t - a) <= after + EPS && guard < 1_000_000 {
            t += q;
            guard += 1;
        }
        t
    }

    fn launch_scan(&mut self, a: f64, b: f64, base: f64, song: bool) -> f64 {
        let ca = self.launch.clock;
        let now = a.max(base).min(b);
        let mut tmin = b;
        for li in 0..self.program.launcher.lanes.len() {
            let tr = self.program.launcher.lanes[li].track as usize;
            if tr >= MAX_TRACKS {
                continue;
            }
            let st = self.launch.tracks[tr];
            let (mut t, mut kind) = (f64::INFINITY, K_NONE);
            if st.queued != NONE {
                t = if st.q_immediate || st.q_ticks <= 0.0 { now } else { self.launch_boundary(a, st.q_ticks, st.q_after, song) };
                kind = K_QUEUE;
            }
            if let Some(c) = self.program.launcher.clip(st.playing) {
                if st.queued == NONE && st.follow_c.is_finite() {
                    let tf = a + (st.follow_c - ca).max(0.0);
                    if tf < t {
                        t = tf;
                        kind = K_FOLLOW;
                    }
                }
                if !c.looping {
                    let te = a + (c.length - st.gen_e).max(0.0);
                    if te < t - EPS {
                        t = te;
                        kind = K_END;
                    }
                }
            }
            let s = &mut self.launch.tracks[tr];
            s.next_t = t;
            s.next_kind = kind;
            if t < tmin {
                tmin = t;
            }
        }
        tmin.max(a)
    }

    fn launch_apply(&mut self, tn: f64, song: bool, off: u32) {
        for li in 0..self.program.launcher.lanes.len() {
            let tr = self.program.launcher.lanes[li].track as usize;
            if tr >= MAX_TRACKS {
                continue;
            }
            let st = self.launch.tracks[tr];
            if !(st.next_t <= tn + EPS) {
                continue;
            }
            self.launch.tracks[tr].next_t = f64::INFINITY;
            match st.next_kind {
                K_QUEUE => {
                    self.launch.tracks[tr].queued = NONE;
                    if st.queued == Q_STOP {
                        self.launch_stop_track(tr, tn, off);
                    } else {
                        self.launch_start(tr, st.queued, tn, off, song);
                    }
                }
                K_END => self.launch_stop_track(tr, tn, off),
                K_FOLLOW => self.launch_follow(tr, tn, off, song),
                _ => {}
            }
        }
    }

    fn launch_start(&mut self, tr: usize, slot: u32, tn: f64, off: u32, song: bool) {
        let Some(c) = self.program.launcher.clip(slot).copied() else { return };
        self.launch_release_at(tr, off);
        self.launch_close_span(tr, tn);
        let clock = self.launch.clock;
        let rec = self.launch.rec_on && song;
        let st = &mut self.launch.tracks[tr];
        st.playing = slot;
        st.gen_e = 0.0;
        st.overridden = true;
        st.follow_c = c.follow.map_or(f64::INFINITY, |fp| clock + fp.after);
        if c.mode == LaunchMode::Repeat && st.held && c.quant > 0.0 {
            st.queued = slot;
            st.q_ticks = c.quant;
            st.q_immediate = false;
            st.q_after = clock;
        }
        if rec {
            st.rec_open = true;
            st.rec_clip = slot;
            st.rec_start = tn;
            st.rec_offset = c.offset;
        }
    }

    fn launch_stop_track(&mut self, tr: usize, tn: f64, off: u32) {
        self.launch_release_at(tr, off);
        self.launch_close_span(tr, tn);
        let st = &mut self.launch.tracks[tr];
        st.playing = NONE;
        st.follow_c = f64::INFINITY;
        st.overridden = true;
        st.held = false;
    }

    fn launch_follow(&mut self, tr: usize, tn: f64, off: u32, song: bool) {
        let st = self.launch.tracks[tr];
        let Some(c) = self.program.launcher.clip(st.playing).copied() else { return };
        let Some(fp) = c.follow else {
            self.launch.tracks[tr].follow_c = f64::INFINITY;
            return;
        };
        let r = follow_rng(c.seed, self.launch.starts, st.follow_n);
        self.launch.tracks[tr].follow_n = st.follow_n.wrapping_add(1);
        let action = decide(&fp, r);
        let res = match self.program.launcher.lane(tr as u32) {
            Some(lane) => follow_target(&lane.clips, st.playing, action, splitmix(r)),
            None => FollowResult::Keep,
        };
        match res {
            FollowResult::Keep => self.launch.tracks[tr].follow_c = f64::INFINITY,
            FollowResult::Stop => self.launch_stop_track(tr, tn, off),
            FollowResult::Launch(s) => self.launch_start(tr, s, tn, off, song),
        }
    }

    fn launch_release_at(&mut self, tr: usize, off: u32) {
        let (a, l) = (tr as u32, tr as u32 | LAUNCH_OWNER);
        let mut i = 0;
        while i < self.pending_offs.len() {
            let o = self.pending_offs[i];
            if o.owner == a || o.owner == l {
                self.pending_offs.swap_remove(i);
                self.push_event(off, RELEASE_ORDER, EvKind::Off { slot: o.slot, key: o.key });
            } else {
                i += 1;
            }
        }
    }

    fn launch_release_now(&mut self, owner: u32) {
        let mut i = 0;
        while i < self.pending_offs.len() {
            let o = self.pending_offs[i];
            if o.owner == owner {
                self.pending_offs.swap_remove(i);
                if let Some(Some(inst)) = self.instruments.get_mut(o.slot as usize) {
                    inst.note_off(0, o.key);
                }
            } else {
                i += 1;
            }
        }
    }

    fn launch_notes(&mut self, a: f64, b: f64, base: f64, f: usize, n: usize, tpf: f64) {
        if b <= a {
            return;
        }
        for li in 0..self.program.launcher.lanes.len() {
            let (tr, muted) = {
                let l = &self.program.launcher.lanes[li];
                (l.track as usize, l.muted)
            };
            if tr >= MAX_TRACKS {
                continue;
            }
            let st = self.launch.tracks[tr];
            let Some(c) = self.program.launcher.clip(st.playing).copied() else { continue };
            let ea = st.gen_e;
            let mut eb = ea + (b - a);
            self.launch.tracks[tr].gen_e = eb;
            let len = c.length;
            if !c.looping {
                eb = eb.min(len);
            }
            if muted || eb <= ea {
                continue;
            }
            let owner = tr as u32 | LAUNCH_OWNER;
            let mut k = (ea / len).floor();
            let mut steps = 0;
            while k * len < eb && steps < MAX_STEPS {
                let pass = k * len;
                let la = (ea - pass).max(0.0);
                let lb = (eb - pass).min(len);
                if lb > la {
                    let t_pass = a + (pass - ea);
                    if c.is_audio() {
                        if pass >= ea {
                            let at = t_pass.max(a);
                            self.launch_audio(&c, owner, t_pass, at, frame_at(at, base, f, n, tpf));
                        }
                    } else {
                        let shift = t_pass - c.offset;
                        self.launch_pattern_notes(c.pattern_slot, owner, c.offset + la, c.offset + lb, shift, t_pass + len, base, f, n, tpf);
                    }
                }
                k += 1.0;
                steps += 1;
            }
        }
    }

    fn launch_audio(&mut self, c: &LaunchClipProg, owner: u32, pass_start: f64, at: f64, offset: u32) {
        let clip = AudioClipProg {
            start: pass_start,
            end: pass_start + c.length,
            offset: c.offset,
            ch_slot: c.ch_slot,
            key: c.key,
            gain: c.gain,
            fade_in: 0.0,
            fade_out: 0.0,
            track: owner,
            ..Default::default()
        };
        self.trigger_audio_clip(&clip, at, offset);
    }

    #[allow(clippy::too_many_arguments)]
    fn launch_pattern_notes(&mut self, pslot: u32, owner: u32, sa: f64, sb: f64, shift: f64, cap: f64, base: f64, f: usize, n: usize, tpf: f64) {
        let (len, count) = match self.program.pattern(pslot) {
            Some(p) => (p.len, p.notes.len()),
            None => return,
        };
        if len < 1.0 || count == 0 {
            return;
        }
        let swing = self.program.transport.swing;
        let k0 = ((sa - MAX_SWING_TICKS) / len).floor().max(0.0) as i64;
        let k1 = (sb / len).floor() as i64;
        let mut k = k0;
        while k <= k1 && k - k0 < MAX_STEPS as i64 {
            let kb = k as f64 * len;
            let (la, lb) = (sa - kb, sb - kb);
            let mut ni = self.program.patterns[pslot as usize].as_ref().map(|p| p.notes.partition_point(|x| x.tick < la - MAX_SWING_TICKS)).unwrap_or(count);
            while ni < count {
                let Some(note) = self.program.patterns[pslot as usize].as_ref().map(|p| p.notes[ni]) else { break };
                ni += 1;
                if note.tick >= lb || note.tick >= len {
                    break;
                }
                let Some(ch) = self.program.channel(note.ch_slot) else { continue };
                let sw = note.tick + swing_offset(note.tick, swing, ch.swing as f64);
                if sw < la || sw >= lb {
                    continue;
                }
                let song_t = sw + kb + shift;
                let off_tick = (song_t + note.dur.max(1.0)).min(cap);
                let pitch = note.key as f32 + ch.root_shift + ch.pitch + note.fine / 100.0;
                let extras = NoteExtras {
                    pan: note.pan,
                    fine: note.fine,
                    mod_x: note.mod_x,
                    mod_y: note.mod_y,
                    slide: note.slide,
                    release: note.release,
                    sample_start: 0.0,
                };
                self.emit_note(frame_at(song_t, base, f, n, tpf), note.ch_slot, note.key, pitch, note.vel, extras, off_tick, owner);
            }
            k += 1;
        }
    }

    pub(super) fn launch_chase(&mut self, at: f64, f: usize) {
        if self.render_mode || self.program.launcher.clips.is_empty() {
            return;
        }
        for li in 0..self.program.launcher.lanes.len() {
            let (tr, muted) = {
                let l = &self.program.launcher.lanes[li];
                (l.track as usize, l.muted)
            };
            if muted || tr >= MAX_TRACKS {
                continue;
            }
            let st = self.launch.tracks[tr];
            let Some(c) = self.program.launcher.clip(st.playing).copied() else { continue };
            if !c.is_audio() {
                continue;
            }
            let e = st.gen_e.max(0.0);
            if !c.looping && e >= c.length {
                continue;
            }
            let inpass = if c.looping { e.rem_euclid(c.length) } else { e };
            if inpass > EPS && c.length - inpass > EPS {
                self.launch_audio(&c, tr as u32 | LAUNCH_OWNER, at - inpass, at, f as u32);
            }
        }
    }

    fn launch_close_span(&mut self, tr: usize, t: f64) {
        let st = self.launch.tracks[tr];
        if !st.rec_open {
            return;
        }
        self.launch.tracks[tr].rec_open = false;
        if t > st.rec_start + 1e-6 {
            self.launch.push_rec(LaunchRecMsg::Span { track: tr as u32, clip: st.rec_clip, start: st.rec_start, end: t, offset: st.rec_offset });
        }
    }

    fn launch_close_spans(&mut self, t: f64) {
        for tr in 0..MAX_TRACKS {
            if self.launch.tracks[tr].rec_open {
                self.launch_close_span(tr, t);
            }
        }
    }

    fn launch_open_spans(&mut self, a: f64) {
        for li in 0..self.program.launcher.lanes.len() {
            let tr = self.program.launcher.lanes[li].track as usize;
            if tr >= MAX_TRACKS {
                continue;
            }
            let st = self.launch.tracks[tr];
            if st.rec_open {
                continue;
            }
            let Some(c) = self.program.launcher.clip(st.playing).copied() else { continue };
            let s = &mut self.launch.tracks[tr];
            s.rec_open = true;
            s.rec_clip = st.playing;
            s.rec_start = a;
            s.rec_offset = c.source_pos(st.gen_e);
        }
    }

    fn launch_flush_record(&mut self) {
        if !self.launch.rec_on {
            return;
        }
        let at = self.launch.last_to;
        self.launch_close_spans(at);
        if self.launch.rec_ran {
            self.launch.push_rec(LaunchRecMsg::Flush);
            self.launch.rec_ran = false;
        }
    }
}
