//! krypt.multisampler — plays SFZ-mapped multisampled instruments (recorded
//! pianos, drum kits, orchestral sections from sound packs).
//!
//! Loading (sfz.rs parser, load.rs decoder) happens off the audio thread and
//! yields an immutable `Arc<MultiSampleSet>` (set.rs) handed over with
//! `Instrument::set_multisample`. A plain audio file given through
//! `set_sample` becomes a one-region set (played like krypt.sampler).
//!
//! Playback (all [RT]: preallocated voices, no allocation / locks / I/O):
//! region match on key + velocity with equal-power `xfin`/`xfout` crossfades,
//! round robin (`seq_length`/`seq_position` counted per region, plus
//! `lorand`/`hirand`), pitch from `pitch_keycenter`/`pitch_keytrack`/`tune`/
//! `transpose` with the sampler's windowed-sinc interpolation at the sample's
//! own rate, `volume`/`pan`/`amp_veltrack`, DAHDSR from `ampeg_*`, the four
//! loop modes, `group`/`off_by` chokes with `off_mode`, and `trigger=release`
//! regions fired on note-off and attenuated by `rt_decay` × held time.

#![allow(clippy::needless_range_loop)]

pub mod build;
mod kernel;
pub mod set;
pub mod sfz;
#[cfg(feature = "decode")]
pub mod load;

pub use set::{MsSample, MultiSampleSet, Region};
pub use sfz::{LoopMode, OffMode, Trigger};

use std::sync::Arc;

use super::sampler::sanitize_sr;
use super::{CHOKE_MS, MAX_EVENTS};
use crate::blocks::env::{Ahdsr, EnvParams};
use crate::blocks::filters::{svf_g, Svf};
use crate::blocks::sinc::{SincTable, MAX_TAPS};
use crate::blocks::{db_to_gain, finite, pan_gains, Rng, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Instrument, NoteExtras, PluginDescriptor, PluginKind, ProcessContext, SampleData};
use kernel::KernelBank;
use set::I16_SCALE;

pub const PLUGIN_ID: &str = "krypt.multisampler";

/// Voice slots (preallocated).
pub const MAX_VOICES: usize = 128;
/// Sounding voices before the oldest is stolen (the spare slots let stolen voices fade).
pub const MAX_POLY: usize = 112;
/// Regions one note-on can start.
const MAX_LAYERS: usize = 64;
/// Sub-block for param smoothing and event timing.
const SUB: usize = 32;
/// `off_mode=fast` and voice-steal fade.
pub const FAST_OFF_MS: f32 = 5.0;
/// Shortest release (no click when a region has `ampeg_release=0`).
pub const MIN_RELEASE_MS: f32 = 5.0;
/// Tone filter damping (Q 0.5: a gentle, non-resonant 12 dB/oct low-pass).
const TONE_K: f64 = 2.0;
/// Tone at or above this is bypassed.
const TONE_OPEN_HZ: f32 = 19_900.0;

param_table! {
    Gain => lin("gain", "Gain", -24.0, 12.0, 0.0, "dB", "Output"),
    Attack => lin("attack", "Attack", 0.0, 2000.0, 0.0, "ms", "Envelope"),
    Release => lin("release", "Release", 0.0, 4.0, 1.0, "%", "Envelope"),
    VelSens => lin("velSens", "Velocity sensitivity", 0.0, 1.0, 1.0, "%", "Playback"),
    Tone => logp("tone", "Tone", 200.0, 20000.0, 20000.0, "Hz", "Output"),
    Tune => stepped("tune", "Tune", -24.0, 24.0, 0.0, "st", 1.0, "Playback"),
    Fine => lin("fine", "Fine", -100.0, 100.0, 0.0, "ct", "Playback"),
    ReleaseSamples => lin("releaseSamples", "Release samples", 0.0, 1.0, 1.0, "%", "Playback"),
    Width => lin("width", "Width", 0.0, 1.0, 1.0, "%", "Output"),
    RoundRobin => toggle("roundRobin", "Round robin", true, "Playback"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: PLUGIN_ID,
        name: "Krypt Multisampler",
        kind: PluginKind::Instrument,
        category: "Sampler",
        description: "Plays real recorded multisampled instruments (grand piano, acoustic drum kits, strings, brass, winds, \
                      mallets) from downloadable sound packs. Its sample is an SFZ mapping ('pack:<id>/<file>.sfz'): velocity \
                      layers with crossfades, round robin, release samples, choke groups and loops come from the pack. Load a \
                      pack preset (find_presets) instead of building one; the pack must be installed (list_packs). Knobs: gain, \
                      attack, release, velocity sensitivity, tone, tune, width.",
        params: param_specs(),
        uses_sample: Some(true),
        sidechain: None,
        default_mix: None,
    }
}

// ── Voices ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
struct MsVoice {
    active: bool,
    sample: u32,
    key: u8,
    note_id: u64,
    order: u64,
    /// An attack voice whose note is still down.
    held: bool,
    /// Ignores note-off (`one_shot`, release-trigger voices).
    one_shot: bool,
    /// `loop_sustain`: stop looping at note-off.
    loop_sustain: bool,
    /// Wrapping at `loop_end` right now.
    looping: bool,
    loop_start: f64,
    loop_end: f64,
    frames: f64,
    pos: f64,
    /// Source frames per output frame before the instrument's tune.
    base_step: f64,
    gain: f32,
    pl: f32,
    pr: f32,
    env: Ahdsr,
    envp: EnvParams,
    region_release_ms: f32,
    /// Frames left in `ampeg_delay` (the sample already plays, silently).
    delay: u32,
    fading: bool,
    fade: f32,
    fade_step: f32,
    fadein: f32,
    fadein_step: f32,
    tail_start: f64,
    tail_inv: f32,
    off_by: i64,
    off_fast: bool,
}

impl MsVoice {
    fn new(sr: f32) -> Self {
        let mut env = Ahdsr::default();
        env.set_sr(sr);
        Self {
            active: false,
            sample: 0,
            key: 0,
            note_id: 0,
            order: 0,
            held: false,
            one_shot: false,
            loop_sustain: false,
            looping: false,
            loop_start: 0.0,
            loop_end: 0.0,
            frames: 0.0,
            pos: 0.0,
            base_step: 1.0,
            gain: 0.0,
            pl: 1.0,
            pr: 1.0,
            env,
            envp: EnvParams::default(),
            region_release_ms: MIN_RELEASE_MS,
            delay: 0,
            fading: false,
            fade: 1.0,
            fade_step: 1.0,
            fadein: 1.0,
            fadein_step: 1.0,
            tail_start: 0.0,
            tail_inv: 1.0,
            off_by: 0,
            off_fast: true,
        }
    }

    fn kill(&mut self) {
        self.active = false;
        self.fading = false;
        self.env.kill();
    }

    /// Fast fade to silence over `ms`.
    fn fade_out(&mut self, ms: f32, sr: f32) {
        let step = 1.0 / (ms * 0.001 * sr).max(1.0);
        if !self.fading || step > self.fade_step {
            self.fade_step = step;
        }
        self.fading = true;
        self.held = false;
    }

    /// Envelope release (note-off, `off_mode=normal`).
    fn release(&mut self, release_scale: f32) {
        self.held = false;
        if self.loop_sustain {
            self.looping = false;
        }
        if self.delay > 0 {
            // never became audible
            self.kill();
            return;
        }
        self.envp.release_ms = (self.region_release_ms * release_scale).max(MIN_RELEASE_MS);
        self.env.release(&self.envp);
    }

    /// Render ADDING into l/r. `tune_ratio` is the instrument-wide pitch factor.
    #[inline]
    fn render(&mut self, set: &MultiSampleSet, sinc: &SincTable, bank: &KernelBank, tune_ratio: f64, l: &mut [f32], r: &mut [f32]) {
        let Some(s) = set.samples.get(self.sample as usize) else {
            self.kill();
            return;
        };
        let data = s.data.as_slice();
        let ch = s.channels;
        let frames = s.frames as i64;
        let step = self.base_step * tune_ratio;
        // pitching up: the precomputed band (the step is constant over the span)
        let band = (step > 1.0).then(|| bank.band(step));
        let mut w = [0.0f32; MAX_TAPS];
        let mut pos = self.pos;
        for i in 0..l.len() {
            let wrap = if self.looping { Some((self.loop_start as i64, self.loop_end as i64)) } else { None };
            let (first, nt) = match band {
                Some(b) => b.weights(pos, &mut w),
                None => sinc.weights(pos, step, &mut w),
            };
            let (a, b) = read_i16(data, ch, frames, first, &w[..nt], wrap);
            pos += step;
            let mut finished = false;
            if self.looping {
                if pos >= self.loop_end {
                    let span = self.loop_end - self.loop_start;
                    pos = self.loop_start + (pos - self.loop_start).rem_euclid(span);
                }
            } else if pos >= self.frames {
                finished = true;
            }
            self.pos = pos;
            let e = if self.delay > 0 {
                self.delay -= 1;
                if self.delay == 0 {
                    self.env.trigger(&self.envp);
                    if !self.held && !self.one_shot {
                        self.env.release(&self.envp);
                    }
                }
                0.0
            } else {
                let e = self.env.next(&self.envp);
                if self.env.idle() {
                    finished = true;
                }
                e
            };
            let mut g = e * self.gain;
            if !self.looping && self.pos > self.tail_start {
                g *= ((self.frames - self.pos) as f32 * self.tail_inv).clamp(0.0, 1.0);
            }
            if self.fadein < 1.0 {
                self.fadein = (self.fadein + self.fadein_step).min(1.0);
                g *= self.fadein;
            }
            if self.fading {
                self.fade -= self.fade_step;
                if self.fade <= 0.0 {
                    self.fade = 0.0;
                    finished = true;
                }
                g *= self.fade;
            }
            l[i] += a * g * self.pl;
            r[i] += b * g * self.pr;
            if finished {
                self.kill();
                return;
            }
        }
    }
}

/// Windowed-sinc read from interleaved i16. Taps outside the sample read
/// silence; with `wrap` (looping), taps at or past the loop end wrap to the
/// loop start.
#[inline]
fn read_i16(data: &[i16], ch: usize, frames: i64, first: i64, w: &[f32], wrap: Option<(i64, i64)>) -> (f32, f32) {
    let n = w.len() as i64;
    let fast = first >= 0 && first + n <= frames && wrap.is_none_or(|(_, hi)| first + n <= hi);
    if ch >= 2 {
        let (mut al, mut ar) = (0.0f32, 0.0f32);
        if fast {
            let s = &data[(first as usize) * 2..((first + n) as usize) * 2];
            for (fr, wj) in s.as_chunks::<2>().0.iter().zip(w) {
                al += fr[0] as f32 * wj;
                ar += fr[1] as f32 * wj;
            }
        } else {
            for (j, wj) in w.iter().enumerate() {
                let k = map_tap(first + j as i64, wrap);
                if k >= 0 && k < frames {
                    let k = k as usize * 2;
                    al += data[k] as f32 * wj;
                    ar += data[k + 1] as f32 * wj;
                }
            }
        }
        (al * I16_SCALE, ar * I16_SCALE)
    } else {
        let mut acc = 0.0f32;
        if fast {
            let s = &data[first as usize..(first + n) as usize];
            for (x, wj) in s.iter().zip(w) {
                acc += *x as f32 * wj;
            }
        } else {
            for (j, wj) in w.iter().enumerate() {
                let k = map_tap(first + j as i64, wrap);
                if k >= 0 && k < frames {
                    acc += data[k as usize] as f32 * wj;
                }
            }
        }
        let v = acc * I16_SCALE;
        (v, v)
    }
}

#[inline]
fn map_tap(k: i64, wrap: Option<(i64, i64)>) -> i64 {
    match wrap {
        Some((lo, hi)) if k >= hi && hi > lo => lo + (k - lo).rem_euclid(hi - lo),
        _ => k,
    }
}

// ── Events ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
enum Ev {
    On { key: u8, pitch: f32, vel: f32, pan: f32 },
    Off(u8),
    Choke,
}

#[derive(Clone, Copy, Debug)]
struct Event {
    offset: usize,
    seq: u32,
    ev: Ev,
}

// ── Instrument ───────────────────────────────────────────────────────────

pub struct Multisampler {
    pb: ParamBank<N_PARAMS>,
    set: Option<Arc<MultiSampleSet>>,
    sinc: SincTable,
    /// Pitch-up kernels (process-wide; built here, never on the audio thread).
    bank: &'static KernelBank,
    voices: Vec<MsVoice>,
    /// Round-robin counter per region.
    seq_counters: Vec<u32>,
    events: Vec<Event>,
    ev_seq: u32,
    rng: Rng,
    /// Notes down per key, and the newest one's velocity / pitch / start (release triggers).
    key_held: [u16; 128],
    key_vel: [f32; 128],
    key_pitch: [f32; 128],
    key_on: [u64; 128],
    /// Frames rendered so far.
    clock: u64,
    order: u64,
    note_counter: u64,
    mono: bool,
    sr: f32,
    matched: [(u32, f32); MAX_LAYERS],
    // params
    attack_ms: f32,
    release_scale: f32,
    vel_sens: f32,
    rel_level: f32,
    round_robin: bool,
    gain: Smooth,
    tone: Smooth,
    tune: Smooth,
    width: Smooth,
    filt: [Svf; 2],
    tone_on: bool,
    fresh: bool,
    peak: f32,
}

impl Multisampler {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sanitize_sr(sample_rate);
        let mut s = Self {
            pb: ParamBank::new(&param_specs()),
            set: None,
            sinc: SincTable::new(),
            bank: kernel::bank(),
            voices: vec![MsVoice::new(sr); MAX_VOICES],
            seq_counters: Vec::new(),
            events: Vec::with_capacity(MAX_EVENTS),
            ev_seq: 0,
            rng: Rng::new(0x05EE_D5F2),
            key_held: [0; 128],
            key_vel: [0.0; 128],
            key_pitch: [0.0; 128],
            key_on: [0; 128],
            clock: 0,
            order: 0,
            note_counter: 0,
            mono: false,
            sr,
            matched: [(0, 0.0); MAX_LAYERS],
            attack_ms: 0.0,
            release_scale: 1.0,
            vel_sens: 1.0,
            rel_level: 1.0,
            round_robin: true,
            gain: Smooth::with_time(1.0, 15.0, sr),
            tone: Smooth::with_time(20000.0, 20.0, sr),
            tune: Smooth::with_time(0.0, 10.0, sr),
            width: Smooth::with_time(1.0, 20.0, sr),
            filt: [Svf::default(); 2],
            tone_on: false,
            fresh: true,
            peak: 0.0,
        };
        s.update();
        s
    }

    /// The loaded set (tests, diagnostics).
    pub fn set(&self) -> Option<&Arc<MultiSampleSet>> {
        self.set.as_ref()
    }

    /// Voices currently sounding (tests).
    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    /// Sample indices of the sounding voices, oldest first (tests).
    pub fn active_samples(&self) -> Vec<u32> {
        let mut v: Vec<(u64, u32)> = self.voices.iter().filter(|v| v.active && !v.fading).map(|v| (v.order, v.sample)).collect();
        v.sort();
        v.into_iter().map(|(_, s)| s).collect()
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.gain.set(db_to_gain(p.get(P::Gain as usize)));
        self.attack_ms = p.get(P::Attack as usize);
        self.release_scale = p.get(P::Release as usize);
        self.vel_sens = p.get(P::VelSens as usize);
        self.tone.set(p.get(P::Tone as usize));
        self.tune.set(p.get(P::Tune as usize) + p.get(P::Fine as usize) / 100.0);
        self.rel_level = p.get(P::ReleaseSamples as usize);
        self.width.set(p.get(P::Width as usize));
        self.round_robin = p.on(P::RoundRobin as usize);
    }

    fn queue(&mut self, offset: usize, ev: Ev) {
        if self.events.len() < MAX_EVENTS {
            self.ev_seq = self.ev_seq.wrapping_add(1);
            self.events.push(Event { offset, seq: self.ev_seq, ev });
        }
    }

    fn reset_keys(&mut self) {
        self.key_held = [0; 128];
    }

    /// Velocity → gain for a region's `amp_veltrack` (scaled by Velocity
    /// sensitivity): SFZ's square-law curve, 100 % = (vel)².
    #[inline]
    fn vel_gain(&self, veltrack: f32, vel: f32) -> f32 {
        let t = (veltrack * self.vel_sens).clamp(-1.0, 1.0);
        let c = vel * vel;
        if t >= 0.0 {
            1.0 - t * (1.0 - c)
        } else {
            1.0 + t * c
        }
    }

    /// Make room for one more voice; returns a free slot.
    fn alloc_voice(&mut self) -> usize {
        let sounding = self.voices.iter().filter(|v| v.active && !v.fading).count();
        if sounding >= MAX_POLY {
            // steal: released voices first, then the oldest
            let mut victim: Option<usize> = None;
            for (i, v) in self.voices.iter().enumerate() {
                if !v.active || v.fading {
                    continue;
                }
                let better = match victim {
                    None => true,
                    Some(b) => {
                        let vb = &self.voices[b];
                        (!v.held && vb.held) || (v.held == vb.held && v.order < vb.order)
                    }
                };
                if better {
                    victim = Some(i);
                }
            }
            if let Some(i) = victim {
                let sr = self.sr;
                self.voices[i].fade_out(FAST_OFF_MS, sr);
            }
        }
        if let Some(i) = self.voices.iter().position(|v| !v.active) {
            return i;
        }
        // every slot busy (mostly fading): reuse the oldest
        let mut oldest = 0;
        for i in 1..self.voices.len() {
            if self.voices[i].order < self.voices[oldest].order {
                oldest = i;
            }
        }
        self.voices[oldest].kill();
        oldest
    }

    /// Collect the regions a note starts into `self.matched` (advancing round-robin counters).
    fn match_regions(&mut self, set: &MultiSampleSet, key: u8, vel: f32, trigger: Trigger) -> usize {
        let v127 = (vel * 127.0).clamp(0.0, 127.0);
        let vint = (v127.round() as u8).max(1);
        let rnd = if self.round_robin { self.rng.unit() } else { 0.0 };
        let mut n = 0usize;
        for &ri in set.regions_for_key(key) {
            let reg = &set.regions[ri as usize];
            if reg.trigger != trigger || !reg.vel_matches(vint) || !reg.rand_matches(rnd) {
                continue;
            }
            if reg.seq_length > 1 {
                let Some(c) = self.seq_counters.get_mut(ri as usize) else { continue };
                let at = if self.round_robin { *c % reg.seq_length } else { 0 };
                if self.round_robin {
                    *c = c.wrapping_add(1);
                }
                if at + 1 != reg.seq_position {
                    continue;
                }
            }
            let xf = reg.xfade_gain(v127);
            if xf <= 0.0 {
                continue;
            }
            if n < MAX_LAYERS {
                self.matched[n] = (ri, xf);
                n += 1;
            }
        }
        n
    }

    /// `group` / `off_by`: every sounding voice whose `off_by` is the group of a
    /// starting region turns off (fast fade or its own release).
    fn apply_chokes(&mut self, set: &MultiSampleSet, n: usize) {
        for m in 0..n {
            let g = set.regions[self.matched[m].0 as usize].group;
            if g == 0 {
                continue;
            }
            let (sr, rs) = (self.sr, self.release_scale);
            for v in self.voices.iter_mut() {
                if v.active && !v.fading && v.off_by == g {
                    if v.off_fast {
                        v.fade_out(FAST_OFF_MS, sr);
                    } else {
                        v.one_shot = false;
                        v.release(rs);
                    }
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn start_voice(&mut self, set: &MultiSampleSet, ri: u32, key: u8, pitch: f32, vel: f32, pan: f32, xf: f32, extra: f32, note_id: u64, release_voice: bool, xfade_in: bool) {
        let reg = &set.regions[ri as usize];
        let Some(smp) = set.samples.get(reg.sample as usize) else { return };
        if smp.frames == 0 || smp.sample_rate <= 0.0 {
            return;
        }
        let slot = self.alloc_voice();
        let sr = self.sr;
        let semis = (key as f32 - reg.keycenter) * reg.keytrack + reg.pitch_offset + (pitch - key as f32);
        let gain = reg.gain * self.vel_gain(reg.veltrack, vel) * xf * extra;
        let (pl, pr) = pan_gains((reg.pan + pan).clamp(-1.0, 1.0));
        self.order += 1;
        let order = self.order;
        let attack_ms = reg.attack_ms + self.attack_ms;
        let release_ms = reg.release_ms;
        let v = &mut self.voices[slot];
        v.active = true;
        v.sample = reg.sample;
        v.key = key;
        v.note_id = note_id;
        v.order = order;
        v.held = !release_voice;
        v.one_shot = release_voice || reg.loop_mode == LoopMode::OneShot;
        let loops = !release_voice && matches!(reg.loop_mode, LoopMode::LoopContinuous | LoopMode::LoopSustain) && reg.loop_end > reg.loop_start + 1;
        v.loop_sustain = loops && reg.loop_mode == LoopMode::LoopSustain;
        v.looping = loops;
        v.loop_start = reg.loop_start as f64;
        v.loop_end = reg.loop_end as f64;
        v.frames = smp.frames as f64;
        v.pos = 0.0;
        v.base_step = (smp.sample_rate as f64 / sr as f64) * ((semis as f64) / 12.0).exp2();
        v.gain = finite(gain);
        v.pl = pl;
        v.pr = pr;
        v.envp = EnvParams {
            attack_ms,
            hold_ms: reg.hold_ms,
            decay_ms: reg.decay_ms.max(1.0),
            sustain: reg.sustain,
            release_ms: (release_ms * self.release_scale).max(MIN_RELEASE_MS),
        };
        v.region_release_ms = release_ms;
        v.env.kill();
        v.delay = (reg.delay_ms * 0.001 * sr) as u32;
        if v.delay == 0 {
            v.env.trigger(&v.envp);
        }
        v.fading = false;
        v.fade = 1.0;
        if xfade_in {
            v.fadein = 0.0;
            v.fadein_step = 1.0 / (CHOKE_MS * 0.001 * sr).max(1.0);
        } else {
            v.fadein = 1.0;
        }
        let tf = smp.tail_fade.max(1);
        v.tail_start = (smp.frames.saturating_sub(tf)) as f64;
        v.tail_inv = 1.0 / tf as f32;
        v.off_by = reg.off_by;
        v.off_fast = reg.off_mode == OffMode::Fast;
    }

    fn handle_on(&mut self, key: u8, pitch: f32, vel: f32, pan: f32) {
        let k = key.min(127) as usize;
        self.key_held[k] = self.key_held[k].saturating_add(1);
        self.key_vel[k] = vel;
        self.key_pitch[k] = pitch;
        self.key_on[k] = self.clock;
        self.note_counter += 1;
        let note_id = self.note_counter;
        let mut replaced = false;
        if self.mono {
            let sr = self.sr;
            for v in self.voices.iter_mut().filter(|v| v.active && !v.fading) {
                v.fade_out(CHOKE_MS, sr);
                replaced = true;
            }
        }
        // An Arc clone is an atomic increment: no allocation; never the last reference here.
        let Some(set) = self.set.clone() else { return };
        let n = self.match_regions(&set, key, vel, Trigger::Attack);
        self.apply_chokes(&set, n);
        for m in 0..n {
            let (ri, xf) = self.matched[m];
            self.start_voice(&set, ri, key, pitch, vel, pan, xf, 1.0, note_id, false, replaced);
        }
    }

    fn handle_off(&mut self, key: u8) {
        // release the oldest held note on this key (all of its layers)
        let mut target: Option<u64> = None;
        for v in self.voices.iter() {
            if v.active && v.held && v.key == key && target.is_none_or(|t| v.note_id < t) {
                target = Some(v.note_id);
            }
        }
        if let Some(id) = target {
            let rs = self.release_scale;
            for v in self.voices.iter_mut() {
                if v.active && v.held && v.note_id == id {
                    if v.one_shot {
                        v.held = false;
                    } else {
                        v.release(rs);
                    }
                }
            }
        }
        let k = key.min(127) as usize;
        if self.key_held[k] == 0 {
            return;
        }
        self.key_held[k] -= 1;
        if self.rel_level <= 0.0 {
            return;
        }
        let Some(set) = self.set.clone() else { return };
        let vel = self.key_vel[k];
        let pitch = self.key_pitch[k];
        let held_s = (self.clock.saturating_sub(self.key_on[k])) as f32 / self.sr;
        let n = self.match_regions(&set, key, vel, Trigger::Release);
        if n == 0 {
            return;
        }
        self.apply_chokes(&set, n);
        self.note_counter += 1;
        let note_id = self.note_counter;
        for m in 0..n {
            let (ri, xf) = self.matched[m];
            let atten = db_to_gain(-set.regions[ri as usize].rt_decay * held_s);
            self.start_voice(&set, ri, key, pitch, vel, 0.0, xf, self.rel_level * atten, note_id, true, false);
        }
    }

    fn handle_choke(&mut self) {
        let sr = self.sr;
        for v in self.voices.iter_mut().filter(|v| v.active) {
            v.fade_out(CHOKE_MS, sr);
        }
        self.reset_keys();
    }

    /// Render frames [a, b) (b - a <= SUB), ADDING into out. Returns the block peak.
    fn render_span(&mut self, out: &mut [&mut [f32]; 2], a: usize, b: usize) -> f32 {
        let n = b - a;
        let mut ml = [0.0f32; SUB];
        let mut mr = [0.0f32; SUB];
        let tune = self.tune.advance(n);
        let tune_ratio = ((tune as f64) / 12.0).exp2();
        if let Some(set) = self.set.as_deref() {
            let sinc = &self.sinc;
            let bank = self.bank;
            for v in self.voices.iter_mut() {
                if v.active {
                    v.render(set, sinc, bank, tune_ratio, &mut ml[..n], &mut mr[..n]);
                }
            }
        }
        // Tone: gentle 12 dB/oct low-pass, bypassed when fully open.
        let cut = self.tone.advance(n);
        if cut < TONE_OPEN_HZ {
            if !self.tone_on {
                self.filt = [Svf::default(); 2];
            }
            let g = svf_g(cut as f64, self.sr as f64);
            self.filt[0].set_gk(g, TONE_K);
            self.filt[1].set_gk(g, TONE_K);
            for i in 0..n {
                ml[i] = self.filt[0].tick3(ml[i] as f64).0 as f32;
                mr[i] = self.filt[1].tick3(mr[i] as f64).0 as f32;
            }
            self.tone_on = true;
        } else {
            self.tone_on = false;
        }
        let (ol, or) = out.split_at_mut(1);
        let ol = &mut ol[0][a..b];
        let or = &mut or[0][a..b];
        let mut pk = 0.0f32;
        for i in 0..n {
            let g = self.gain.next();
            let w = self.width.next();
            let (l, r) = (ml[i], mr[i]);
            let m = 0.5 * (l + r);
            let s = 0.5 * (l - r) * w;
            let lo = finite((m + s) * g);
            let ro = finite((m - s) * g);
            ol[i] += lo;
            or[i] += ro;
            pk = pk.max(lo.abs()).max(ro.abs());
        }
        pk
    }
}

impl Instrument for Multisampler {
    fn prepare(&mut self, sample_rate: f32, _max_frames: usize) {
        let sr = sanitize_sr(sample_rate);
        self.sr = sr;
        for v in self.voices.iter_mut() {
            *v = MsVoice::new(sr);
        }
        self.events.clear();
        self.reset_keys();
        self.gain.set_time(15.0, sr);
        self.tone.set_time(20.0, sr);
        self.tune.set_time(10.0, sr);
        self.width.set_time(20.0, sr);
        self.fresh = true;
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn set_sample(&mut self, sample: Option<Arc<SampleData>>) {
        let set = sample
            .filter(|s| super::usable_frames(s) > 0 && s.sample_rate.is_finite() && s.sample_rate > 0.0)
            .map(|s| Arc::new(MultiSampleSet::from_sample_data("sample", &s)));
        self.set_multisample(set);
    }

    fn set_multisample(&mut self, set: Option<Arc<MultiSampleSet>>) {
        self.all_off();
        self.seq_counters = vec![0; set.as_ref().map(|s| s.regions.len()).unwrap_or(0)];
        self.set = set;
    }

    fn set_voice_mode(&mut self, mono: bool, _glide_ms: f32) {
        self.mono = mono;
    }

    fn note_on(&mut self, offset: usize, key: u8, pitch: f32, velocity: f32, extras: NoteExtras) {
        let pitch = if pitch.is_finite() { pitch.clamp(-24.0, 160.0) } else { key as f32 };
        let vel = if velocity.is_finite() { velocity.clamp(0.0, 1.0) } else { 0.0 };
        let pan = if extras.pan.is_finite() { extras.pan.clamp(-1.0, 1.0) } else { 0.0 };
        self.queue(offset, Ev::On { key: key.min(127), pitch, vel, pan });
    }

    fn note_off(&mut self, offset: usize, key: u8) {
        self.queue(offset, Ev::Off(key.min(127)));
    }

    fn choke(&mut self, offset: usize) {
        self.queue(offset, Ev::Choke);
    }

    fn all_off(&mut self) {
        self.events.clear();
        for v in self.voices.iter_mut() {
            v.kill();
        }
        self.reset_keys();
    }

    fn process(&mut self, ctx: &ProcessContext, mut out: [&mut [f32]; 2]) {
        if self.pb.take_dirty() {
            self.update();
        }
        if self.fresh {
            self.fresh = false;
            for s in [&mut self.gain, &mut self.tone, &mut self.tune, &mut self.width] {
                let t = s.target;
                s.reset(t);
            }
        }
        let frames = ctx.frames.min(out[0].len()).min(out[1].len());
        if !self.events.is_empty() {
            self.events.sort_unstable_by_key(|e| (e.offset, e.seq));
        }
        let mut ei = 0usize;
        let mut pos = 0usize;
        let mut peak = 0.0f32;
        while pos < frames {
            while ei < self.events.len() && self.events[ei].offset <= pos {
                match self.events[ei].ev {
                    Ev::On { key, pitch, vel, pan } => self.handle_on(key, pitch, vel, pan),
                    Ev::Off(k) => self.handle_off(k),
                    Ev::Choke => self.handle_choke(),
                }
                ei += 1;
            }
            let mut end = (pos + SUB).min(frames);
            if let Some(e) = self.events.get(ei) {
                if e.offset < end {
                    end = e.offset;
                }
            }
            peak = peak.max(self.render_span(&mut out, pos, end));
            self.clock += (end - pos) as u64;
            pos = end;
        }
        if ei > 0 {
            self.events.drain(..ei);
        }
        for e in self.events.iter_mut() {
            e.offset -= frames.min(e.offset);
        }
        self.peak = peak;
    }

    fn activity(&self) -> f32 {
        self.peak.min(1.0)
    }

    fn is_active(&self) -> bool {
        !self.events.is_empty() || self.voices.iter().any(|v| v.active)
    }
}
