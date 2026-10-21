//! Audio-thread data: the compiled `Program` (rebuilt off-thread on every
//! edit and swapped in at a block boundary) and the `Batch` that carries it,
//! together with new/removed plugin instances and parameter updates.

use crate::automation::Point;
use krypt_studio_dsp::{Effect, Instrument, ParamSpec};

/// Frames per engine sub-block: automation is applied at this granularity,
/// tempo changes take effect at sub-block boundaries.
pub const SUB: usize = 32;
/// max_frames handed to plugins' prepare/create.
pub const PREPARE_MAX: usize = 1024;
pub const MAX_CHANNELS: usize = 1024;
pub const MAX_INSERTS: usize = 256;
pub const MAX_FX: usize = 4096;
/// Longest PDC delay line (frames).
pub const MAX_PDC: usize = 1 << 17;
pub const NONE: u32 = u32::MAX;

#[derive(Debug, Clone)]
pub struct TransportProg {
    pub bpm: f64,
    pub swing: f64,
    pub master_volume: f32,
    pub num: f64,
    pub den: f64,
    pub song_mode: bool,
    /// Pattern slot played in pattern mode.
    pub active_pattern: u32,
    pub loop_on: bool,
    pub loop_start: f64,
    pub loop_end: f64,
    pub metronome: bool,
}

impl Default for TransportProg {
    fn default() -> Self {
        Self {
            bpm: 140.0,
            swing: 0.0,
            master_volume: 1.0,
            num: 4.0,
            den: 4.0,
            song_mode: false,
            active_pattern: NONE,
            loop_on: false,
            loop_start: 0.0,
            loop_end: 0.0,
            metronome: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChannelProg {
    pub slot: u32,
    /// Insert slot this channel feeds (NONE = nowhere).
    pub insert_slot: u32,
    pub volume: f32,
    pub pan: f32,
    pub pitch: f32,
    pub mute: bool,
    /// Added to the note pitch: (60 - rootKey) for sample instruments, else 0.
    pub root_shift: f32,
    pub root_key: u8,
    pub swing: f32,
    /// Channel slots to choke before this channel triggers (cut groups).
    pub chokes: Vec<u32>,
    /// The instrument's own latency (frames; instrument racks, third-party plugins).
    pub latency: usize,
    /// Instrument PDC: delays this channel so it lines up with the most latent
    /// instrument on its insert (None = no delay).
    pub pdc: Option<DelayLine>,
}

#[derive(Debug, Clone, Copy)]
pub struct NoteProg {
    pub ch_slot: u32,
    pub tick: f64,
    pub dur: f64,
    pub key: u8,
    pub vel: f32,
    pub pan: f32,
    pub release: f32,
    pub fine: f32,
    pub slide: bool,
    pub mod_x: f32,
    pub mod_y: f32,
}

#[derive(Debug, Clone)]
pub struct PatternProg {
    pub len: f64,
    /// Sorted by tick.
    pub notes: Vec<NoteProg>,
}

#[derive(Debug, Clone, Copy)]
pub struct PatternClipProg {
    pub start: f64,
    pub end: f64,
    pub offset: f64,
    pub pattern_slot: u32,
    /// Playlist track slot (launcher.rs; NONE = none). Overridden tracks are silent.
    pub track: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct AudioClipProg {
    pub start: f64,
    pub end: f64,
    pub offset: f64,
    pub ch_slot: u32,
    pub key: u8,
    pub gain: f32,
    pub fade_in: f64,
    pub fade_out: f64,
    /// Playlist track slot (launcher.rs; NONE = none; | LAUNCH_OWNER = a launch clip).
    pub track: u32,
}

impl Default for AudioClipProg {
    fn default() -> Self {
        Self { start: 0.0, end: 0.0, offset: 0.0, ch_slot: NONE, key: 60, gain: 1.0, fade_in: 0.0, fade_out: 0.0, track: NONE }
    }
}

#[derive(Debug, Clone)]
pub struct AutoClipProg {
    pub start: f64,
    pub end: f64,
    pub offset: f64,
    pub target: usize,
    pub points: Vec<Point>,
    /// Runtime: was active during the previous evaluation.
    pub active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TargetKind {
    Bpm,
    Swing,
    MasterVolume,
    ChanVolume(usize),
    ChanPan(usize),
    ChanPitch(usize),
    /// Instrument param (channel slot, param index).
    Gen {
        ch_slot: u32,
        index: usize,
    },
    InsVolume(usize),
    InsPan(usize),
    InsSep(usize),
    /// Wet/dry of an FX slot (insert index, fx index within the insert).
    SlotMix {
        ins: usize,
        fx: usize,
    },
    /// Effect param (fx slot, param index).
    SlotParam {
        fx_slot: u32,
        index: usize,
    },
    /// Send level (insert index, route index within the insert).
    Route {
        ins: usize,
        route: usize,
    },
    /// A param inside an instrument / drum rack (channel slot, rack target index):
    /// written as `set_param(rack::AUTO_BASE + target, v)`, an override that wins over macros.
    RackInst {
        ch_slot: u32,
        target: usize,
    },
    /// A param inside an effect rack (fx slot, rack target index), same as RackInst.
    RackFx {
        fx_slot: u32,
        target: usize,
    },
}

#[derive(Debug, Clone)]
pub struct AutoTarget {
    pub kind: TargetKind,
    pub spec: ParamSpec,
    /// Document (un-automated) plain value.
    pub doc: f32,
    /// Runtime: last automated plain value (holds after the clip ends).
    pub held: Option<f32>,
    /// Index of the same target in the previous program (carry the held value).
    pub carry: Option<usize>,
}

/// Fixed-length stereo delay (plugin delay compensation).
#[derive(Debug, Clone)]
pub struct DelayLine {
    pub l: Vec<f32>,
    pub r: Vec<f32>,
    pub pos: usize,
}

impl DelayLine {
    pub fn new(frames: usize) -> Self {
        Self {
            l: vec![0.0; frames],
            r: vec![0.0; frames],
            pos: 0,
        }
    }
    pub fn len(&self) -> usize {
        self.l.len()
    }
    pub fn is_empty(&self) -> bool {
        self.l.is_empty()
    }
    /// [RT] Delay `l`/`r` in place.
    #[inline]
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = self.l.len();
        if n == 0 {
            return;
        }
        for i in 0..l.len().min(r.len()) {
            let (ol, or) = (self.l[self.pos], self.r[self.pos]);
            self.l[self.pos] = l[i];
            self.r[self.pos] = r[i];
            l[i] = ol;
            r[i] = or;
            self.pos += 1;
            if self.pos >= n {
                self.pos = 0;
            }
        }
    }
    pub fn clear(&mut self) {
        self.l.iter_mut().for_each(|x| *x = 0.0);
        self.r.iter_mut().for_each(|x| *x = 0.0);
        self.pos = 0;
    }
}

#[derive(Debug, Clone)]
pub struct FxProg {
    pub slot: u32,
    pub enabled: bool,
    pub mix: f32,
    /// Insert slot whose post-fader signal feeds the sidechain (if accepted).
    pub sidechain: u32,
}

#[derive(Debug, Clone)]
pub struct RouteProg {
    pub target_slot: u32,
    pub level: f32,
    pub delay: Option<DelayLine>,
}

#[derive(Debug, Clone)]
pub struct InsertProg {
    pub slot: u32,
    pub volume: f32,
    pub pan: f32,
    pub sep: f32,
    /// Own mute OR muted by solo.
    pub mute: bool,
    pub phase: bool,
    pub swap: bool,
    pub is_master: bool,
    pub fx: Vec<FxProg>,
    pub routes: Vec<RouteProg>,
    /// PDC for the summed direct channel inputs.
    pub chan_delay: Option<DelayLine>,
    /// Latency (frames) at which the direct channel inputs arrive after their
    /// own instrument PDC: the largest instrument latency among them.
    pub in_lat: usize,
    /// Frames of silence in AND out after which the FX chain may be skipped until
    /// input returns (0 = never). Only chains of stock effects whose output can't
    /// come back after a silent gap (no echo delay, no third-party plugins).
    pub quiet_frames: u32,
}

#[derive(Debug, Clone)]
pub struct Program {
    pub version: u64,
    pub transport: TransportProg,
    /// End of the song (last clip end rounded up to a bar, min 1 bar).
    pub song_end: f64,
    pub channels: Vec<ChannelProg>,
    /// Channel slot → index into `channels` (NONE if absent). len = MAX_CHANNELS.
    pub chan_index: Vec<u32>,
    /// By pattern slot.
    pub patterns: Vec<Option<PatternProg>>,
    /// Sorted by start.
    pub pattern_clips: Vec<PatternClipProg>,
    pub max_pattern_clip_len: f64,
    /// Sorted by start.
    pub audio_clips: Vec<AudioClipProg>,
    pub max_audio_clip_len: f64,
    /// Sorted by start.
    pub auto_clips: Vec<AutoClipProg>,
    pub targets: Vec<AutoTarget>,
    /// Topological order.
    pub inserts: Vec<InsertProg>,
    /// Index into `inserts`.
    pub master: Option<usize>,
    /// Clip launcher (launcher.rs): scenes, launch clips, lanes.
    pub launcher: crate::launcher::LauncherProg,
}

impl Program {
    pub fn empty() -> Self {
        Self {
            version: 0,
            transport: TransportProg::default(),
            song_end: 3840.0,
            channels: Vec::new(),
            chan_index: vec![NONE; MAX_CHANNELS],
            patterns: Vec::new(),
            pattern_clips: Vec::new(),
            max_pattern_clip_len: 0.0,
            audio_clips: Vec::new(),
            max_audio_clip_len: 0.0,
            auto_clips: Vec::new(),
            targets: Vec::new(),
            inserts: Vec::new(),
            master: None,
            launcher: crate::launcher::LauncherProg::empty(),
        }
    }

    #[inline]
    pub fn channel(&self, slot: u32) -> Option<&ChannelProg> {
        let i = *self.chan_index.get(slot as usize)?;
        if i == NONE {
            None
        } else {
            self.channels.get(i as usize)
        }
    }

    #[inline]
    pub fn pattern(&self, slot: u32) -> Option<&PatternProg> {
        if slot == NONE {
            return None;
        }
        self.patterns.get(slot as usize).and_then(|p| p.as_ref())
    }
}

/// One atomic model change for the audio thread.
pub struct Batch {
    pub version: u64,
    /// loadProject: stop the transport and rewind.
    pub reset: bool,
    pub program: Option<Box<Program>>,
    /// (channel slot, new instance or None to remove).
    pub instruments: Vec<(u32, Option<Box<dyn Instrument>>)>,
    /// (fx slot, new instance or None to remove).
    pub effects: Vec<(u32, Option<Box<dyn Effect>>)>,
    /// (channel slot, param index, plain value).
    pub inst_params: Vec<(u32, usize, f32)>,
    pub fx_params: Vec<(u32, usize, f32)>,
    /// (channel slot, mono, glide ms).
    pub voice: Vec<(u32, bool, f32)>,
    /// Channel slots whose (re-created) audio-clip instrument should restart
    /// the clips spanning the playhead mid-clip (a time-stretched variant or a
    /// sample just became ready while playing).
    pub rechase: Vec<u32>,
}

impl Batch {
    pub fn new(version: u64) -> Self {
        Self {
            version,
            reset: false,
            program: None,
            instruments: Vec::new(),
            effects: Vec::new(),
            inst_params: Vec::new(),
            fx_params: Vec::new(),
            voice: Vec::new(),
            rechase: Vec::new(),
        }
    }
}
