//! Shared instrument machinery: a sample-accurate event queue and a generic
//! voice manager (polyphony limit with click-free stealing, mono legato +
//! glide, slide notes, cut-group chokes). Everything is preallocated.

// Per-sample index loops over parallel buffers are the clearest DSP style;
// smoothers expose `next()` deliberately (they are not iterators).
#![allow(clippy::needless_range_loop, clippy::should_implement_trait)]

pub mod audioclip;
pub mod drums;
pub mod drumsynth;
pub mod fm;
pub mod kick808;
pub mod multisampler;
pub mod sampler;
pub mod slicer;
#[cfg(test)]
mod sampler_legacy;
pub mod triosc;
#[cfg(test)]
mod triosc_legacy;
pub mod wavetable;

use crate::NoteExtras;

pub(crate) const MAX_EVENTS: usize = 1024;

/// Frames playable from a sample: the shortest of its first two channels
/// (SampleData promises equal lengths; never trust it on the audio thread).
#[inline]
pub(crate) fn usable_frames(s: &crate::SampleData) -> usize {
    s.channels.iter().take(2).map(|c| c.len()).min().unwrap_or(0)
}
/// Glide time used by slide notes when the channel has no glide time set.
pub(crate) const DEFAULT_SLIDE_MS: f32 = 70.0;
/// Choke / steal fade.
pub(crate) const CHOKE_MS: f32 = 2.0;

#[derive(Clone, Copy, Debug)]
pub(crate) struct NoteStart {
    pub key: u8,
    pub pitch: f32,
    pub vel: f32,
    pub extras: NoteExtras,
    /// The voice replaces one that is fading out (mono retrigger): fade in
    /// over the same CHOKE_MS so the handover is a crossfade, not a sum.
    pub xfade: bool,
}

#[derive(Clone, Copy, Debug)]
enum Ev {
    On(NoteStart),
    Off(u8),
    Choke,
}

#[derive(Clone, Copy, Debug)]
struct Event {
    offset: usize,
    seq: u32,
    ev: Ev,
}

/// A voice implementation. `Shared` holds the instrument-wide (smoothed) params.
pub(crate) trait Voice {
    type Shared;
    /// Start or retrigger. `glide_from`: start pitch to glide from, if any.
    fn start(&mut self, sh: &Self::Shared, n: &NoteStart, glide_from: Option<f32>, glide_ms: f32);
    /// Change pitch without retriggering (legato / slide).
    fn legato(&mut self, sh: &Self::Shared, pitch: f32, glide_ms: f32);
    /// Note off (may be ignored by one-shot voices).
    fn release(&mut self, sh: &Self::Shared);
    /// Fast (~2 ms) fade to silence.
    fn choke(&mut self);
    fn kill(&mut self);
    fn active(&self) -> bool;
    fn choking(&self) -> bool;
    #[allow(dead_code)]
    fn pitch(&self) -> f32;
    /// Render ADDING into l/r.
    fn render(&mut self, sh: &Self::Shared, l: &mut [f32], r: &mut [f32]);
    /// Called before each `render` with the span's first frame within the
    /// current `VoiceManager::render` call (song-locked modulation needs it).
    fn span_start(&mut self, _frame: usize) {}
}

#[derive(Clone, Copy, Debug, Default)]
struct Meta {
    key: u8,
    held: bool,
    order: u64,
}

pub(crate) struct VoiceManager<V: Voice> {
    pub voices: Vec<V>,
    meta: Vec<Meta>,
    max_poly: usize,
    pub mono: bool,
    pub glide_ms: f32,
    held: [(u8, f32); 32],
    n_held: usize,
    order: u64,
    events: Vec<Event>,
    seq: u32,
}

impl<V: Voice> VoiceManager<V> {
    /// `max_poly` sounding voices; a few spare slots let stolen voices fade.
    pub fn new(max_poly: usize, mut make: impl FnMut() -> V) -> Self {
        let cap = max_poly + 4;
        Self {
            voices: (0..cap).map(|_| make()).collect(),
            meta: vec![Meta::default(); cap],
            max_poly,
            mono: false,
            glide_ms: 0.0,
            held: [(0, 0.0); 32],
            n_held: 0,
            order: 0,
            events: Vec::with_capacity(MAX_EVENTS),
            seq: 0,
        }
    }

    fn queue(&mut self, offset: usize, ev: Ev) {
        if self.events.len() < MAX_EVENTS {
            self.seq = self.seq.wrapping_add(1);
            self.events.push(Event { offset, seq: self.seq, ev });
        }
    }

    pub fn note_on(&mut self, offset: usize, key: u8, pitch: f32, vel: f32, extras: NoteExtras) {
        let pitch = if pitch.is_finite() { pitch.clamp(-24.0, 160.0) } else { key as f32 };
        let vel = if vel.is_finite() { vel.clamp(0.0, 1.0) } else { 0.0 };
        self.queue(offset, Ev::On(NoteStart { key, pitch, vel, extras, xfade: false }));
    }

    pub fn note_off(&mut self, offset: usize, key: u8) {
        self.queue(offset, Ev::Off(key));
    }

    pub fn choke(&mut self, offset: usize) {
        self.queue(offset, Ev::Choke);
    }

    pub fn all_off(&mut self) {
        self.events.clear();
        for v in self.voices.iter_mut() {
            v.kill();
        }
        for m in self.meta.iter_mut() {
            m.held = false;
        }
        self.n_held = 0;
    }

    pub fn is_active(&self) -> bool {
        !self.events.is_empty() || self.voices.iter().any(|v| v.active())
    }

    pub fn set_voice_mode(&mut self, mono: bool, glide_ms: f32) {
        self.mono = mono;
        self.glide_ms = if glide_ms.is_finite() { glide_ms.clamp(0.0, 10_000.0) } else { 0.0 };
    }

    /// Render `l.len()` frames, applying queued events at their offsets.
    pub fn render(&mut self, sh: &V::Shared, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        if !self.events.is_empty() {
            self.events.sort_unstable_by_key(|e| (e.offset, e.seq));
        }
        let mut pos = 0usize;
        let mut consumed = 0usize;
        while consumed < self.events.len() {
            let e = self.events[consumed];
            if e.offset >= n {
                break;
            }
            if e.offset > pos {
                self.render_span(sh, pos, &mut l[pos..e.offset], &mut r[pos..e.offset]);
                pos = e.offset;
            }
            match e.ev {
                Ev::On(ns) => self.handle_on(sh, &ns),
                Ev::Off(k) => self.handle_off(sh, k),
                Ev::Choke => self.handle_choke(),
            }
            consumed += 1;
        }
        if pos < n {
            self.render_span(sh, pos, &mut l[pos..n], &mut r[pos..n]);
        }
        // keep future events (offset beyond this block), shifted
        if consumed > 0 {
            self.events.drain(..consumed);
        }
        for e in self.events.iter_mut() {
            e.offset -= n.min(e.offset);
        }
    }

    fn render_span(&mut self, sh: &V::Shared, at: usize, l: &mut [f32], r: &mut [f32]) {
        for v in self.voices.iter_mut() {
            if v.active() {
                v.span_start(at);
                v.render(sh, l, r);
            }
        }
    }

    fn next_order(&mut self) -> u64 {
        self.order += 1;
        self.order
    }

    fn push_held(&mut self, key: u8, pitch: f32) {
        self.remove_held(key);
        if self.n_held == self.held.len() {
            self.held.copy_within(1.., 0);
            self.n_held -= 1;
        }
        self.held[self.n_held] = (key, pitch);
        self.n_held += 1;
    }

    fn remove_held(&mut self, key: u8) {
        if let Some(i) = self.held[..self.n_held].iter().position(|&(k, _)| k == key) {
            self.held.copy_within(i + 1..self.n_held, i);
            self.n_held -= 1;
        }
    }

    /// Most recently started voice that is sounding and not fading out.
    fn newest_sounding(&self) -> Option<usize> {
        let mut best: Option<usize> = None;
        for (i, v) in self.voices.iter().enumerate() {
            if v.active() && !v.choking() && best.is_none_or(|b| self.meta[i].order > self.meta[b].order) {
                best = Some(i);
            }
        }
        best
    }

    fn free_slot(&mut self) -> usize {
        if let Some(i) = self.voices.iter().position(|v| !v.active()) {
            return i;
        }
        // all slots busy (only possible with many simultaneous chokes): take the oldest
        let mut oldest = 0;
        for i in 1..self.voices.len() {
            if self.meta[i].order < self.meta[oldest].order {
                oldest = i;
            }
        }
        self.voices[oldest].kill();
        oldest
    }

    fn handle_on(&mut self, sh: &V::Shared, n: &NoteStart) {
        let was_held = self.n_held > 0;
        self.push_held(n.key, n.pitch);
        let glide = self.glide_ms;

        // Slide note: glide the previously sounding note, no retrigger.
        if n.extras.slide {
            if let Some(i) = self.newest_sounding() {
                let gt = if glide > 0.0 { glide } else { DEFAULT_SLIDE_MS };
                self.voices[i].legato(sh, n.pitch, gt);
                let o = self.next_order();
                self.meta[i] = Meta { key: n.key, held: true, order: o };
                return;
            }
        }

        if self.mono {
            let cur = self.newest_sounding();
            if let (Some(i), true, true) = (cur, was_held, glide > 0.0) {
                // legato overlap: glide without retrigger
                self.voices[i].legato(sh, n.pitch, glide);
                let o = self.next_order();
                self.meta[i] = Meta { key: n.key, held: true, order: o };
                return;
            }
            let mut replaced = false;
            for v in self.voices.iter_mut() {
                if v.active() {
                    v.choke();
                    replaced = true;
                }
            }
            let slot = self.free_slot();
            let n = NoteStart { xfade: replaced, ..*n };
            self.voices[slot].start(sh, &n, None, 0.0);
            let o = self.next_order();
            self.meta[slot] = Meta { key: n.key, held: true, order: o };
            return;
        }

        // Poly: enforce the voice limit by fading the oldest (released first).
        loop {
            let sounding = self.voices.iter().filter(|v| v.active() && !v.choking()).count();
            if sounding < self.max_poly {
                break;
            }
            let mut victim: Option<usize> = None;
            for (i, v) in self.voices.iter().enumerate() {
                if !v.active() || v.choking() {
                    continue;
                }
                let better = match victim {
                    None => true,
                    Some(b) => {
                        let (mi, mb) = (&self.meta[i], &self.meta[b]);
                        (!mi.held && mb.held) || (mi.held == mb.held && mi.order < mb.order)
                    }
                };
                if better {
                    victim = Some(i);
                }
            }
            match victim {
                Some(i) => self.voices[i].choke(),
                None => break,
            }
        }
        let slot = self.free_slot();
        self.voices[slot].start(sh, n, None, 0.0);
        let o = self.next_order();
        self.meta[slot] = Meta { key: n.key, held: true, order: o };
    }

    fn handle_off(&mut self, sh: &V::Shared, key: u8) {
        self.remove_held(key);
        // the oldest held voice playing this key
        let mut target: Option<usize> = None;
        for (i, v) in self.voices.iter().enumerate() {
            let m = &self.meta[i];
            if v.active() && m.held && m.key == key && target.is_none_or(|t| m.order < self.meta[t].order) {
                target = Some(i);
            }
        }
        let Some(i) = target else { return };
        if self.mono && self.glide_ms > 0.0 && self.n_held > 0 {
            // return to the most recent still-held key (last-note priority)
            let (k2, p2) = self.held[self.n_held - 1];
            self.voices[i].legato(sh, p2, self.glide_ms);
            self.meta[i].key = k2;
            return;
        }
        self.meta[i].held = false;
        self.voices[i].release(sh);
    }

    fn handle_choke(&mut self) {
        for (v, m) in self.voices.iter_mut().zip(self.meta.iter_mut()) {
            if v.active() {
                v.choke();
            }
            m.held = false;
        }
        self.n_held = 0;
    }
}

/// Instrument-level output stage: gain smoothing, add into the engine's
/// buffers, peak tracking for the Channel Rack LED.
pub(crate) struct OutStage {
    pub mix_l: Vec<f32>,
    pub mix_r: Vec<f32>,
    pub gain: crate::blocks::Smooth,
    pub peak: f32,
    /// snap the gain smoother on the first block (params arrive after creation)
    pub fresh: bool,
}

impl OutStage {
    pub fn new(max_frames: usize, sr: f32) -> Self {
        let mut s = Self { mix_l: Vec::new(), mix_r: Vec::new(), gain: crate::blocks::Smooth::new(1.0), peak: 0.0, fresh: true };
        s.prepare(max_frames, sr);
        s
    }

    pub fn prepare(&mut self, max_frames: usize, sr: f32) {
        let n = max_frames.max(1);
        self.mix_l = vec![0.0; n];
        self.mix_r = vec![0.0; n];
        self.gain.set_time(15.0, sr);
        self.fresh = true;
    }

    pub fn chunk(&self) -> usize {
        self.mix_l.len()
    }

    /// Mix buffers [..n] → out (adding), applying the smoothed gain.
    pub fn emit(&mut self, out: &mut [&mut [f32]; 2], at: usize, n: usize) -> f32 {
        let mut pk = 0.0f32;
        let (ol, or) = out.split_at_mut(1);
        let ol = &mut ol[0][at..at + n];
        let or = &mut or[0][at..at + n];
        for i in 0..n {
            let g = self.gain.next();
            let l = crate::blocks::finite(self.mix_l[i] * g);
            let r = crate::blocks::finite(self.mix_r[i] * g);
            ol[i] += l;
            or[i] += r;
            pk = pk.max(l.abs()).max(r.abs());
        }
        pk
    }
}

/// Generic block loop for instruments built on `VoiceManager`.
macro_rules! instrument_process {
    ($self:ident, $ctx:ident, $out:ident) => {{
        let frames = $ctx.frames.min($out[0].len()).min($out[1].len());
        if $self.out.fresh {
            $self.out.fresh = false;
            $self.out.gain.reset($self.out.gain.target);
        }
        let mut at = 0usize;
        let mut peak = 0.0f32;
        while at < frames {
            let n = (frames - at).min($self.out.chunk());
            $self.out.mix_l[..n].iter_mut().for_each(|v| *v = 0.0);
            $self.out.mix_r[..n].iter_mut().for_each(|v| *v = 0.0);
            {
                let (ml, mr) = ($self.out.mix_l.as_mut_slice(), $self.out.mix_r.as_mut_slice());
                $self.vm.render(&$self.shared, &mut ml[..n], &mut mr[..n]);
            }
            peak = peak.max($self.out.emit(&mut $out, at, n));
            at += n;
        }
        $self.out.peak = peak;
    }};
}
pub(crate) use instrument_process;
