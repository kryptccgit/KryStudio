use crate::automation::Point;
use krypt_studio_dsp::{Effect, Instrument, ParamSpec};

pub const SUB: usize = 32;
pub const PREPARE_MAX: usize = 1024;
pub const MAX_CHANNELS: usize = 1024;
pub const MAX_INSERTS: usize = 256;
pub const MAX_FX: usize = 4096;
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
    pub insert_slot: u32,
    pub volume: f32,
    pub pan: f32,
    pub pitch: f32,
    pub mute: bool,
    pub root_shift: f32,
    pub root_key: u8,
    pub swing: f32,
    pub chokes: Vec<u32>,
    pub latency: usize,
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
    pub notes: Vec<NoteProg>,
}

#[derive(Debug, Clone, Copy)]
pub struct PatternClipProg {
    pub start: f64,
    pub end: f64,
    pub offset: f64,
    pub pattern_slot: u32,
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
    Gen {
        ch_slot: u32,
        index: usize,
    },
    InsVolume(usize),
    InsPan(usize),
    InsSep(usize),
    SlotMix {
        ins: usize,
        fx: usize,
    },
    SlotParam {
        fx_slot: u32,
        index: usize,
    },
    Route {
        ins: usize,
        route: usize,
    },
    RackInst {
        ch_slot: u32,
        target: usize,
    },
    RackFx {
        fx_slot: u32,
        target: usize,
    },
}

#[derive(Debug, Clone)]
pub struct AutoTarget {
    pub kind: TargetKind,
    pub spec: ParamSpec,
    pub doc: f32,
    pub held: Option<f32>,
    pub carry: Option<usize>,
}

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
    pub mute: bool,
    pub phase: bool,
    pub swap: bool,
    pub is_master: bool,
    pub fx: Vec<FxProg>,
    pub routes: Vec<RouteProg>,
    pub chan_delay: Option<DelayLine>,
    pub in_lat: usize,
    pub quiet_frames: u32,
}

#[derive(Debug, Clone)]
pub struct Program {
    pub version: u64,
    pub transport: TransportProg,
    pub song_end: f64,
    pub channels: Vec<ChannelProg>,
    pub chan_index: Vec<u32>,
    pub patterns: Vec<Option<PatternProg>>,
    pub pattern_clips: Vec<PatternClipProg>,
    pub max_pattern_clip_len: f64,
    pub audio_clips: Vec<AudioClipProg>,
    pub max_audio_clip_len: f64,
    pub auto_clips: Vec<AutoClipProg>,
    pub targets: Vec<AutoTarget>,
    pub inserts: Vec<InsertProg>,
    pub master: Option<usize>,
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

pub struct Batch {
    pub version: u64,
    pub reset: bool,
    pub program: Option<Box<Program>>,
    pub instruments: Vec<(u32, Option<Box<dyn Instrument>>)>,
    pub effects: Vec<(u32, Option<Box<dyn Effect>>)>,
    pub inst_params: Vec<(u32, usize, f32)>,
    pub fx_params: Vec<(u32, usize, f32)>,
    pub voice: Vec<(u32, bool, f32)>,
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
