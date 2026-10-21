use crate::automation;
use crate::program::*;
use crate::time::{
    bar_ticks, beat_ticks, swing_offset, ticks_per_frame, ticks_to_seconds, MAX_SWING_TICKS, PPQ,
};
use krypt_studio_dsp::{
    from_normalized, Effect, Instrument, NoteExtras, ProcessContext, SampleData,
};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::*};
use std::sync::Arc;

#[path = "record_hooks.rs"]
mod record_hooks;

#[path = "launcher_hooks.rs"]
mod launcher_hooks;

#[path = "clock_hooks.rs"]
mod clock_hooks;

pub enum Cmd {
    Batch(Box<Batch>),
    Play,
    Stop,
    Pause,
    Toggle,
    Locate(f64),
    NoteOn { slot: u32, key: u8, vel: f32 },
    NoteOff { slot: u32, key: u8 },
    AuditionOff,
    Preview(Option<Box<Preview>>),
    Launcher(crate::launcher::LaunchCmd),
}

pub enum Garbage {
    Program(Box<Program>),
    Batch(Box<Batch>),
    Instrument(Box<dyn Instrument>),
    Effect(Box<dyn Effect>),
    Preview(Box<Preview>),
}

pub struct Preview {
    pub data: Arc<SampleData>,
    pub pos: f64,
    pub gain: f32,
}

pub struct Shared {
    pub playing: AtomicBool,
    pub tick: AtomicU64,
    pub sec: AtomicU64,
    pub bpm: AtomicU64,
    pub song_mode: AtomicBool,
    pub pattern_slot: AtomicU32,
    pub applied_version: AtomicU64,
    pub cpu: AtomicU32,
    pub xruns: AtomicU32,
    pub faulted: AtomicBool,
    pub garbage_leaked: AtomicU32,
    pub events_dropped: AtomicU32,
    pub ins_peak: Vec<[AtomicU32; 2]>,
    pub ch_act: Vec<AtomicU32>,
    pub fx_latency: Vec<AtomicU32>,
    pub meters: crate::meters::MeterShared,
    pub ch_latency: Vec<AtomicU32>,
    pub buffer_frames: AtomicU32,
    pub out_latency_us: AtomicU32,
    pub sample_rate: AtomicU32,
    pub callbacks: AtomicU64,
    pub live: Arc<crate::record::LiveShared>,
    pub launch: crate::launcher::LaunchShared,
    pub clock: Arc<crate::clock::ClockShared>,
}

impl Shared {
    pub fn new() -> Self {
        Self {
            playing: AtomicBool::new(false),
            tick: AtomicU64::new(0f64.to_bits()),
            sec: AtomicU64::new(0f64.to_bits()),
            bpm: AtomicU64::new(140f64.to_bits()),
            song_mode: AtomicBool::new(false),
            pattern_slot: AtomicU32::new(NONE),
            applied_version: AtomicU64::new(0),
            cpu: AtomicU32::new(0),
            xruns: AtomicU32::new(0),
            faulted: AtomicBool::new(false),
            garbage_leaked: AtomicU32::new(0),
            events_dropped: AtomicU32::new(0),
            ins_peak: (0..MAX_INSERTS)
                .map(|_| [AtomicU32::new(0), AtomicU32::new(0)])
                .collect(),
            ch_act: (0..MAX_CHANNELS).map(|_| AtomicU32::new(0)).collect(),
            fx_latency: (0..MAX_FX).map(|_| AtomicU32::new(0)).collect(),
            meters: crate::meters::MeterShared::new(),
            ch_latency: (0..MAX_CHANNELS).map(|_| AtomicU32::new(0)).collect(),
            buffer_frames: AtomicU32::new(0),
            out_latency_us: AtomicU32::new(0),
            sample_rate: AtomicU32::new(48000),
            callbacks: AtomicU64::new(0),
            live: Arc::new(crate::record::LiveShared::new()),
            launch: crate::launcher::LaunchShared::new(),
            clock: crate::clock::ClockShared::new(),
        }
    }
}

impl Default for Shared {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy)]
struct ClipEnv {
    start: f64,
    end: f64,
    gain: f32,
    fade_in: f64,
    fade_out: f64,
}

impl ClipEnv {
    #[inline]
    fn at(&self, tick: f64) -> f32 {
        let mut g = self.gain;
        if self.fade_in > 0.0 {
            g *= ((tick - self.start) / self.fade_in).clamp(0.0, 1.0) as f32;
        }
        if self.fade_out > 0.0 {
            g *= ((self.end - tick) / self.fade_out).clamp(0.0, 1.0) as f32;
        }
        g
    }
}

struct ChanRt {
    l: [f32; SUB],
    r: [f32; SUB],
    gl: f32,
    gr: f32,
    clip: Option<ClipEnv>,
    kick: bool,
    fresh: bool,
    rechase: bool,
    pdc_tail: u32,
}

impl ChanRt {
    fn new() -> Self {
        Self {
            l: [0.0; SUB],
            r: [0.0; SUB],
            gl: 0.0,
            gr: 0.0,
            clip: None,
            kick: false,
            fresh: true,
            rechase: false,
            pdc_tail: 0,
        }
    }
}

struct InsRt {
    ch_l: [f32; SUB],
    ch_r: [f32; SUB],
    in_l: [f32; SUB],
    in_r: [f32; SUB],
    out_l: [f32; SUB],
    out_r: [f32; SUB],
    gl: f32,
    gr: f32,
    fresh: bool,
    quiet: u32,
}

impl InsRt {
    fn new() -> Self {
        Self {
            ch_l: [0.0; SUB],
            ch_r: [0.0; SUB],
            in_l: [0.0; SUB],
            in_r: [0.0; SUB],
            out_l: [0.0; SUB],
            out_r: [0.0; SUB],
            gl: 0.0,
            gr: 0.0,
            fresh: true,
            quiet: 0,
        }
    }
}

#[derive(Clone, Copy)]
struct PendingOff {
    slot: u32,
    key: u8,
    tick: f64,
    owner: u32,
}

#[derive(Clone, Copy)]
enum EvKind {
    Off {
        slot: u32,
        key: u8,
    },
    On {
        slot: u32,
        key: u8,
        pitch: f32,
        vel: f32,
        extras: NoteExtras,
    },
}

#[derive(Clone, Copy)]
struct Ev {
    offset: u32,
    order: u8,
    seq: u32,
    kind: EvKind,
}

#[derive(Default)]
struct Click {
    phase: f32,
    inc: f32,
    remaining: u32,
    total: u32,
    amp: f32,
    start: Option<usize>,
    pending_accent: bool,
}

const MAX_EVENTS: usize = 8192;
const MAX_PENDING_OFFS: usize = 8192;
const MAX_AUDITION: usize = 512;
const MAX_CMDS_PER_BLOCK: usize = 512;

pub struct Core {
    pub sr: f32,
    cmd_rx: Option<rtrb::Consumer<Cmd>>,
    garbage_tx: Option<rtrb::Producer<Garbage>>,
    pub shared: Arc<Shared>,
    spec_tx: Option<rtrb::Producer<f32>>,
    program: Box<Program>,
    instruments: Vec<Option<Box<dyn Instrument>>>,
    effects: Vec<Option<Box<dyn Effect>>>,
    chan_rt: Vec<ChanRt>,
    ins_rt: Vec<InsRt>,
    playing: bool,
    pos: f64,
    gen_cursor: f64,
    cur_pattern: u32,
    pending_pattern: u32,
    sec: f64,
    need_chase: bool,
    pending_rechase: bool,
    played_ticks: f64,
    limit: Option<f64>,
    finished: bool,
    finished_at: Option<u64>,
    frame_counter: u64,
    render_mode: bool,
    mode_override: Option<bool>,
    pending_offs: Vec<PendingOff>,
    events: Vec<Ev>,
    seq: u32,
    audition: Vec<(u32, u8)>,
    preview: Option<Box<Preview>>,
    click: Click,
    master_l: [f32; SUB],
    master_r: [f32; SUB],
    dry_l: [f32; SUB],
    dry_r: [f32; SUB],
    sc_l: [f32; SUB],
    sc_r: [f32; SUB],
    master_gain: f32,
    pub faulted: bool,
    pub live: crate::record::LiveRt,
    launch: crate::launcher::LaunchRt,
    pub clock: crate::clock::ClockRt,
}

impl Core {
    pub fn new(
        sr: f32,
        shared: Arc<Shared>,
        cmd_rx: Option<rtrb::Consumer<Cmd>>,
        garbage_tx: Option<rtrb::Producer<Garbage>>,
        spec_tx: Option<rtrb::Producer<f32>>,
    ) -> Self {
        let launch = crate::launcher::LaunchRt::new(shared.launch.take_rec_tx());
        Self {
            sr,
            cmd_rx,
            garbage_tx,
            shared,
            spec_tx,
            program: Box::new(Program::empty()),
            instruments: (0..MAX_CHANNELS).map(|_| None).collect(),
            effects: (0..MAX_FX).map(|_| None).collect(),
            chan_rt: (0..MAX_CHANNELS).map(|_| ChanRt::new()).collect(),
            ins_rt: (0..MAX_INSERTS).map(|_| InsRt::new()).collect(),
            playing: false,
            pos: 0.0,
            gen_cursor: 0.0,
            cur_pattern: NONE,
            pending_pattern: NONE,
            sec: 0.0,
            need_chase: false,
            pending_rechase: false,
            played_ticks: 0.0,
            limit: None,
            finished: false,
            finished_at: None,
            frame_counter: 0,
            render_mode: false,
            mode_override: None,
            pending_offs: Vec::with_capacity(MAX_PENDING_OFFS),
            events: Vec::with_capacity(MAX_EVENTS),
            seq: 0,
            audition: Vec::with_capacity(MAX_AUDITION),
            preview: None,
            click: Click::default(),
            master_l: [0.0; SUB],
            master_r: [0.0; SUB],
            dry_l: [0.0; SUB],
            dry_r: [0.0; SUB],
            sc_l: [0.0; SUB],
            sc_r: [0.0; SUB],
            master_gain: 1.0,
            faulted: false,
            live: crate::record::LiveRt::new(Arc::new(crate::record::LiveShared::new())),
            launch,
            clock: crate::clock::ClockRt::detached(),
        }
    }

    pub fn set_sample_rate(&mut self, sr: f32) {
        if (sr - self.sr).abs() < 0.5 {
            return;
        }
        self.sr = sr;
        for inst in self.instruments.iter_mut().flatten() {
            inst.prepare(sr, PREPARE_MAX);
        }
        for fx in self.effects.iter_mut().flatten() {
            fx.prepare(sr, PREPARE_MAX);
        }
        for ins in self.program.inserts.iter_mut() {
            if let Some(d) = ins.chan_delay.as_mut() {
                d.clear();
            }
            for r in ins.routes.iter_mut() {
                if let Some(d) = r.delay.as_mut() {
                    d.clear();
                }
            }
        }
        for ch in self.program.channels.iter_mut() {
            if let Some(d) = ch.pdc.as_mut() {
                d.clear();
            }
        }
        if let Some(p) = self.preview.take() {
            drop(p);
        }
    }

    pub fn start_render(
        &mut self,
        song_mode: bool,
        start_tick: f64,
        pattern_slot: u32,
        limit_ticks: f64,
    ) {
        self.render_mode = true;
        self.mode_override = Some(song_mode);
        self.cur_pattern = pattern_slot;
        self.pending_pattern = NONE;
        self.pos = start_tick.max(0.0);
        self.gen_cursor = self.pos;
        self.limit = Some(limit_ticks.max(0.0));
        self.played_ticks = 0.0;
        self.finished = false;
        self.finished_at = None;
        self.frame_counter = 0;
        self.playing = true;
        self.need_chase = true;
        self.sec = 0.0;
    }

    pub fn finished(&self) -> bool {
        self.finished
    }

    pub fn finished_at(&self) -> Option<u64> {
        self.finished_at
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    pub fn position(&self) -> f64 {
        self.pos
    }

    pub fn apply_batch_now(&mut self, b: Box<Batch>) {
        self.apply_batch(b);
    }

    pub fn clear_fault(&mut self) {
        self.faulted = false;
        self.shared.faulted.store(false, Release);
    }

    pub fn process_interleaved(&mut self, out: &mut [f32], channels: usize) {
        let channels = channels.max(1);
        self.live_block(out.len() / channels);
        self.clock_block(out.len() / channels);
        self.drain_commands();
        let frames = out.len() / channels;
        let mut done = 0;
        while done < frames {
            let n = SUB.min(frames - done);
            self.run_sub(n);
            for i in 0..n {
                let (l, r) = (self.master_l[i], self.master_r[i]);
                let base = (done + i) * channels;
                if channels == 1 {
                    out[base] = 0.5 * (l + r);
                } else {
                    out[base] = l;
                    out[base + 1] = r;
                    for c in 2..channels {
                        out[base + c] = 0.0;
                    }
                }
            }
            done += n;
        }
        for x in out[frames * channels..].iter_mut() {
            *x = 0.0;
        }
        self.publish();
    }

    pub fn process_stereo(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.live_block(l.len().min(r.len()));
        self.clock_block(l.len().min(r.len()));
        self.drain_commands();
        let frames = l.len().min(r.len());
        let mut done = 0;
        while done < frames {
            let n = SUB.min(frames - done);
            self.run_sub(n);
            l[done..done + n].copy_from_slice(&self.master_l[..n]);
            r[done..done + n].copy_from_slice(&self.master_r[..n]);
            done += n;
        }
        self.publish();
    }

    pub fn process_stereo_tapped(&mut self, l: &mut [f32], r: &mut [f32], taps: &[u32], sink: &mut dyn FnMut(usize, &[f32], &[f32])) {
        const ZERO: [f32; SUB] = [0.0; SUB];
        self.live_block(l.len().min(r.len()));
        self.clock_block(l.len().min(r.len()));
        self.drain_commands();
        let frames = l.len().min(r.len());
        let mut done = 0;
        while done < frames {
            let n = SUB.min(frames - done);
            self.run_sub(n);
            l[done..done + n].copy_from_slice(&self.master_l[..n]);
            r[done..done + n].copy_from_slice(&self.master_r[..n]);
            for (i, &slot) in taps.iter().enumerate() {
                match self.ins_rt.get(slot as usize) {
                    Some(rt) if !self.faulted => sink(i, &rt.out_l[..n], &rt.out_r[..n]),
                    _ => sink(i, &ZERO[..n], &ZERO[..n]),
                }
            }
            done += n;
        }
        self.publish();
    }

    pub fn stem_alignment(&self) -> Vec<(u32, usize)> {
        let mut arrive = vec![0usize; MAX_INSERTS];
        let mut out = vec![0usize; MAX_INSERTS];
        for ins in self.program.inserts.iter() {
            let u = ins.slot as usize;
            if u >= MAX_INSERTS {
                continue;
            }
            let lat: usize = ins
                .fx
                .iter()
                .filter(|f| f.enabled)
                .filter_map(|f| self.effects.get(f.slot as usize).and_then(|e| e.as_ref()))
                .map(|e| e.latency())
                .sum();
            arrive[u] = arrive[u].max(ins.in_lat);
            out[u] = arrive[u] + lat;
            for route in ins.routes.iter() {
                let v = route.target_slot as usize;
                if v < MAX_INSERTS {
                    arrive[v] = arrive[v].max(out[u]);
                }
            }
        }
        let master_out = self.program.master.and_then(|m| self.program.inserts.get(m)).map(|m| out[(m.slot as usize).min(MAX_INSERTS - 1)]).unwrap_or(0);
        self.program
            .inserts
            .iter()
            .filter(|i| (i.slot as usize) < MAX_INSERTS)
            .map(|i| (i.slot, master_out.saturating_sub(out[i.slot as usize])))
            .collect()
    }

    fn publish(&self) {
        let s = &self.shared;
        s.playing.store(self.playing, Relaxed);
        s.tick.store(self.pos.to_bits(), Relaxed);
        s.sec.store(self.sec.to_bits(), Relaxed);
        s.bpm.store(self.program.transport.bpm.to_bits(), Relaxed);
        let song = self.song_mode();
        s.song_mode.store(song, Relaxed);
        s.pattern_slot
            .store(if song { NONE } else { self.cur_pattern }, Relaxed);
        self.launch_publish();
    }

    #[inline]
    fn song_mode(&self) -> bool {
        self.mode_override
            .unwrap_or(self.program.transport.song_mode)
    }

    fn retire(&mut self, g: Garbage) {
        match self.garbage_tx.as_mut() {
            Some(tx) => {
                if let Err(rtrb::PushError::Full(g)) = tx.push(g) {
                    std::mem::forget(g);
                    self.shared.garbage_leaked.fetch_add(1, Relaxed);
                }
            }
            None => drop(g),
        }
    }

    fn drain_commands(&mut self) {
        for _ in 0..MAX_CMDS_PER_BLOCK {
            let cmd = match self.cmd_rx.as_mut() {
                Some(rx) => match rx.pop() {
                    Ok(c) => c,
                    Err(_) => break,
                },
                None => break,
            };
            self.handle(cmd);
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Batch(b) => self.apply_batch(b),
            Cmd::Play => self.play(),
            Cmd::Stop => self.stop(),
            Cmd::Pause => self.pause(),
            Cmd::Toggle => {
                if self.playing {
                    self.stop()
                } else {
                    self.play()
                }
            }
            Cmd::Locate(t) => self.locate(t),
            Cmd::NoteOn { slot, key, vel } => self.audition_on(slot, key, vel),
            Cmd::NoteOff { slot, key } => {
                if let Some(Some(i)) = self.instruments.get_mut(slot as usize) {
                    i.note_off(0, key);
                }
                if let Some(p) = self
                    .audition
                    .iter()
                    .position(|&(s, k)| s == slot && k == key)
                {
                    self.audition.swap_remove(p);
                }
            }
            Cmd::AuditionOff => {
                while let Some((slot, key)) = self.audition.pop() {
                    if let Some(Some(i)) = self.instruments.get_mut(slot as usize) {
                        i.note_off(0, key);
                    }
                }
            }
            Cmd::Preview(p) => {
                if let Some(old) = std::mem::replace(&mut self.preview, p) {
                    self.retire(Garbage::Preview(old));
                }
            }
            Cmd::Launcher(c) => self.launch_cmd(c),
        }
    }

    fn audition_on(&mut self, slot: u32, key: u8, vel: f32) {
        let Some(ch) = self.program.channel(slot) else {
            return;
        };
        if ch.mute {
            return;
        }
        let pitch = key as f32 + ch.root_shift + ch.pitch;
        for &c in ch.chokes.iter() {
            if let Some(Some(i)) = self.instruments.get_mut(c as usize) {
                i.choke(0);
            }
        }
        if let Some(Some(i)) = self.instruments.get_mut(slot as usize) {
            i.note_on(0, key, pitch, vel.clamp(0.0, 1.0), NoteExtras::default());
            self.chan_rt[slot as usize].kick = true;
            if self.audition.len() < MAX_AUDITION {
                self.audition.push((slot, key));
            }
        }
    }

    fn play(&mut self) {
        if self.playing || self.live_intercept_play() {
            return;
        }
        self.playing = true;
        self.sec = 0.0;
        self.played_ticks = 0.0;
        self.need_chase = true;
        self.gen_cursor = self.pos;
        self.launch_play_started();
        if !self.song_mode() {
            if self.pending_pattern != NONE {
                self.cur_pattern = self.pending_pattern;
                self.pending_pattern = NONE;
            }
            if self.cur_pattern == NONE {
                self.cur_pattern = self.program.transport.active_pattern;
            }
        }
        self.clock_started();
    }

    fn stop(&mut self) {
        self.clock_stopped();
        self.live_transport_stopped();
        self.launch_transport_stopped();
        self.flush_offs(0);
        for inst in self.instruments.iter_mut().flatten() {
            inst.all_off();
        }
        for fx in self.effects.iter_mut().flatten() {
            fx.reset();
        }
        for ins in self.program.inserts.iter_mut() {
            if let Some(d) = ins.chan_delay.as_mut() {
                d.clear();
            }
            for r in ins.routes.iter_mut() {
                if let Some(d) = r.delay.as_mut() {
                    d.clear();
                }
            }
        }
        for ch in self.program.channels.iter_mut() {
            if let Some(d) = ch.pdc.as_mut() {
                d.clear();
            }
        }
        for c in self.program.auto_clips.iter_mut() {
            c.active = false;
        }
        for ch in self.program.channels.iter() {
            self.chan_rt[ch.slot as usize].clip = None;
        }
        self.audition.clear();
        self.click.remaining = 0;
        self.click.start = None;
        self.playing = false;
        self.pos = 0.0;
        self.gen_cursor = self.pos;
        self.sec = 0.0;
        self.played_ticks = 0.0;
        self.cur_pattern = self.program.transport.active_pattern;
        self.pending_pattern = NONE;
    }

    fn pause(&mut self) {
        self.live_transport_stopped();
        self.launch_paused();
        if !self.playing {
            return;
        }
        self.clock_stopped();
        self.flush_offs(0);
        self.playing = false;
        self.click.remaining = 0;
    }

    fn locate(&mut self, tick: f64) {
        if !tick.is_finite() {
            return;
        }
        self.flush_offs(0);
        self.pos = tick.max(0.0);
        self.gen_cursor = self.pos;
        self.need_chase = true;
        for c in self.program.auto_clips.iter_mut() {
            c.active = false;
        }
        self.clock_located();
    }

    fn flush_offs(&mut self, offset: usize) {
        while let Some(o) = self.pending_offs.pop() {
            if let Some(Some(i)) = self.instruments.get_mut(o.slot as usize) {
                i.note_off(offset, o.key);
            }
        }
    }

    fn apply_batch(&mut self, mut b: Box<Batch>) {
        let mut installed_fx = false;
        let installed_inst = !b.instruments.is_empty();
        for (slot, inst) in b.instruments.drain(..) {
            let s = slot as usize;
            if s >= MAX_CHANNELS {
                if let Some(i) = inst {
                    self.retire(Garbage::Instrument(i));
                }
                continue;
            }
            if let Some(old) = self.instruments[s].take() {
                self.retire(Garbage::Instrument(old));
            }
            self.instruments[s] = inst;
            let rt = &mut self.chan_rt[s];
            rt.clip = None;
            rt.kick = false;
            rt.fresh = true;
        }
        for &slot in b.rechase.iter() {
            if let Some(rt) = self.chan_rt.get_mut(slot as usize) {
                rt.rechase = true;
                self.pending_rechase = true;
            }
        }
        for (slot, fx) in b.effects.drain(..) {
            let s = slot as usize;
            if s >= MAX_FX {
                if let Some(f) = fx {
                    self.retire(Garbage::Effect(f));
                }
                continue;
            }
            if let Some(old) = self.effects[s].take() {
                self.retire(Garbage::Effect(old));
            }
            self.effects[s] = fx;
            installed_fx = true;
        }
        for &(slot, idx, v) in b.inst_params.iter() {
            if let Some(Some(i)) = self.instruments.get_mut(slot as usize) {
                i.set_param(idx, v);
            }
        }
        for &(slot, idx, v) in b.fx_params.iter() {
            if let Some(Some(f)) = self.effects.get_mut(slot as usize) {
                f.set_param(idx, v);
            }
        }
        for &(slot, mono, glide) in b.voice.iter() {
            if let Some(Some(i)) = self.instruments.get_mut(slot as usize) {
                i.set_voice_mode(mono, glide);
            }
        }
        let had_params = !b.fx_params.is_empty();
        if let Some(mut p) = b.program.take() {
            self.carry_over(&mut p);
            let old_song = self.song_mode();
            let old = std::mem::replace(&mut self.program, p);
            self.after_swap(old_song, &old);
            self.mark_fresh(&old);
            self.rack_auto_swap(&old);
            self.retire(Garbage::Program(old));
        }
        if installed_inst || !b.inst_params.is_empty() {
            for ch in self.program.channels.iter() {
                if let Some(Some(i)) = self.instruments.get(ch.slot as usize) {
                    self.shared.ch_latency[ch.slot as usize].store(i.latency() as u32, Relaxed);
                }
            }
        }
        if installed_fx || had_params {
            for ins in self.program.inserts.iter() {
                for fx in ins.fx.iter() {
                    if let Some(Some(e)) = self.effects.get(fx.slot as usize) {
                        self.shared.fx_latency[fx.slot as usize].store(e.latency() as u32, Relaxed);
                    }
                }
            }
        }
        if b.reset {
            self.stop();
            self.clear_fault();
        }
        self.launch_applied(b.reset);
        self.shared.applied_version.store(b.version, Release);
        self.retire(Garbage::Batch(b));
    }

    fn rack_auto_swap(&mut self, old: &Program) {
        for (j, ot) in old.targets.iter().enumerate() {
            if !is_rack_target(ot.kind) || ot.held.is_none() {
                continue;
            }
            if self.program.targets.iter().any(|t| t.carry == Some(j) && t.kind == ot.kind) {
                continue;
            }
            self.write_rack(ot.kind, f32::NAN);
        }
        for i in 0..self.program.targets.len() {
            let (kind, held) = (self.program.targets[i].kind, self.program.targets[i].held);
            if let (true, Some(h)) = (is_rack_target(kind), held) {
                self.write_rack(kind, h);
            }
        }
    }

    fn write_rack(&mut self, kind: TargetKind, v: f32) {
        match kind {
            TargetKind::RackInst { ch_slot, target } => {
                if let Some(Some(i)) = self.instruments.get_mut(ch_slot as usize) {
                    i.set_param(crate::rack::AUTO_BASE + target, v);
                }
            }
            TargetKind::RackFx { fx_slot, target } => {
                if let Some(Some(e)) = self.effects.get_mut(fx_slot as usize) {
                    e.set_param(crate::rack::AUTO_BASE + target, v);
                }
            }
            _ => {}
        }
    }

    fn carry_over(&mut self, new: &mut Program) {
        let old = &mut self.program;
        for i in 0..new.targets.len() {
            let Some(j) = new.targets[i].carry else {
                continue;
            };
            let Some(ot) = old.targets.get(j) else {
                continue;
            };
            if let Some(h) = ot.held {
                if ot.doc == new.targets[i].doc {
                    new.targets[i].held = Some(h);
                    write_builtin(new, i, h);
                }
            }
        }
        for nc in new.channels.iter_mut() {
            let Some(nd) = nc.pdc.as_mut() else { continue };
            if let Some(od) = old.channels.iter_mut().find(|o| o.slot == nc.slot).and_then(|o| o.pdc.as_mut()) {
                if nd.len() == od.len() {
                    std::mem::swap(nd, od);
                }
            }
        }
        for ni in new.inserts.iter_mut() {
            let has_delay = ni.chan_delay.is_some() || ni.routes.iter().any(|r| r.delay.is_some());
            if !has_delay {
                continue;
            }
            let Some(oi) = old.inserts.iter_mut().find(|o| o.slot == ni.slot) else {
                continue;
            };
            if let (Some(nd), Some(od)) = (ni.chan_delay.as_mut(), oi.chan_delay.as_mut()) {
                if nd.len() == od.len() {
                    std::mem::swap(nd, od);
                }
            }
            for nr in ni.routes.iter_mut() {
                let Some(nd) = nr.delay.as_mut() else {
                    continue;
                };
                if let Some(or) = oi
                    .routes
                    .iter_mut()
                    .find(|r| r.target_slot == nr.target_slot)
                {
                    if let Some(od) = or.delay.as_mut() {
                        if nd.len() == od.len() {
                            std::mem::swap(nd, od);
                        }
                    }
                }
            }
        }
        for nc in new.auto_clips.iter_mut() {
            if let Some(oc) = old
                .auto_clips
                .iter()
                .find(|o| o.start == nc.start && o.end == nc.end && o.target_ref_eq(nc))
            {
                nc.active = oc.active;
            }
        }
    }

    fn mark_fresh(&mut self, old: &Program) {
        for ch in self.program.channels.iter() {
            if old.channel(ch.slot).is_none() {
                self.chan_rt[ch.slot as usize].fresh = true;
            }
        }
        for ins in self.program.inserts.iter() {
            if !old.inserts.iter().any(|o| o.slot == ins.slot) {
                if let Some(rt) = self.ins_rt.get_mut(ins.slot as usize) {
                    rt.fresh = true;
                }
            }
        }
    }

    fn after_swap(&mut self, old_song: bool, old: &Program) {
        let new_song = self.song_mode();
        if self.render_mode {
            return;
        }
        if old_song != new_song {
            self.flush_offs(0);
            self.pos = 0.0;
            self.gen_cursor = self.pos;
            self.need_chase = true;
            self.cur_pattern = self.program.transport.active_pattern;
            self.pending_pattern = NONE;
            return;
        }
        if !new_song {
            let active = self.program.transport.active_pattern;
            if self.playing {
                if active != self.cur_pattern {
                    if self.program.pattern(self.cur_pattern).is_none() {
                        self.flush_offs(0);
                        self.cur_pattern = active;
                        self.pos = 0.0;
                        self.gen_cursor = self.pos;
                    } else {
                        self.pending_pattern = active;
                    }
                } else {
                    self.pending_pattern = NONE;
                }
            } else {
                self.cur_pattern = active;
                self.pending_pattern = NONE;
            }
        }
        for ch in old.channels.iter() {
            if self.program.channel(ch.slot).is_none() {
                self.chan_rt[ch.slot as usize].clip = None;
            }
        }
    }

    fn run_sub(&mut self, n: usize) {
        if self.faulted {
            self.master_l[..n].fill(0.0);
            self.master_r[..n].fill(0.0);
            return;
        }
        for ins in self.program.inserts.iter() {
            let rt = &mut self.ins_rt[ins.slot as usize];
            rt.ch_l[..n].fill(0.0);
            rt.ch_r[..n].fill(0.0);
            rt.in_l[..n].fill(0.0);
            rt.in_r[..n].fill(0.0);
        }
        self.master_l[..n].fill(0.0);
        self.master_r[..n].fill(0.0);
        self.events.clear();
        self.seq = 0;

        let beat_pos = self.pos / PPQ;
        if self.playing {
            self.eval_automation();
            self.clock_pre_advance();
            let bpm = self.program.transport.bpm.clamp(10.0, 999.0);
            let tpf = ticks_per_frame(bpm, self.sr as f64);
            self.advance(n, tpf);
            self.sec += n as f64 / self.sr as f64;
        }
        self.clock_sub(n);
        self.live_sub(n);
        self.dispatch_events();

        let ctx = ProcessContext {
            sample_rate: self.sr,
            bpm: self.program.transport.bpm,
            beats_per_bar: 4.0 * self.program.transport.num / self.program.transport.den.max(1.0),
            playing: self.playing,
            beat_pos,
            frames: n,
        };
        self.process_channels(n, &ctx);
        for i in 0..self.program.inserts.len() {
            self.process_insert(i, n, &ctx);
        }
        self.finish_master(n);
        self.frame_counter += n as u64;
    }

    fn loop_bounds(&self) -> (f64, f64) {
        let t = &self.program.transport;
        let bar = bar_ticks(t.num, t.den);
        if self.song_mode() {
            if self.render_mode {
                return (0.0, f64::INFINITY);
            }
            if t.loop_on && t.loop_end > t.loop_start + 1.0 {
                (t.loop_start.max(0.0), t.loop_end)
            } else if self.live_extends_song() || self.launch_extends_song() {
                (0.0, f64::INFINITY)
            } else {
                (0.0, self.program.song_end.max(bar))
            }
        } else {
            let len = self
                .program
                .pattern(self.cur_pattern)
                .map(|p| p.len)
                .unwrap_or(bar);
            (0.0, if len >= 1.0 { len } else { bar })
        }
    }

    fn wrap(&mut self, lo: f64, offset: usize, overshoot: f64) {
        self.flush_offs(offset);
        if !self.song_mode() && self.pending_pattern != NONE {
            self.cur_pattern = self.pending_pattern;
            self.pending_pattern = NONE;
        }
        self.pos = lo + overshoot;
        self.gen_cursor = lo;
        self.need_chase = true;
    }

    fn advance(&mut self, n: usize, tpf: f64) {
        let half = 0.5 * tpf;
        let mut f = 0usize;
        let mut guard = 0;
        while f < n && self.playing && guard < 64 {
            guard += 1;
            let (lo, hi) = self.loop_bounds();
            if self.pos >= hi {
                self.wrap(lo, f, 0.0);
                continue;
            }
            if self.need_chase {
                self.need_chase = false;
                self.clear_rechase();
                let at = self.gen_cursor;
                self.chase(at, f);
            } else if self.pending_rechase {
                let at = self.gen_cursor;
                self.rechase(at, f);
            }
            let frames_left = n - f;
            let start = self.pos;
            let mut seg_end = start + frames_left as f64 * tpf;
            let mut boundary = 0u8;
            if seg_end >= hi {
                seg_end = hi;
                boundary = 1;
            }
            if let Some(limit) = self.limit {
                let lim_pos = start + (limit - self.played_ticks).max(0.0);
                if lim_pos <= seg_end {
                    seg_end = lim_pos;
                    boundary = 2;
                }
            }
            let seg_frames = if boundary == 0 {
                frames_left
            } else {
                (((seg_end - start) / tpf).round() as usize).min(frames_left)
            };
            let win_end = if boundary == 0 {
                seg_end - half
            } else {
                seg_end
            };
            let from = self.gen_cursor.min(win_end);
            self.launch_gen(from, win_end, start, f, n, tpf);
            self.gen_cursor = win_end;
            let covered = seg_frames as f64 * tpf;
            self.played_ticks += if boundary == 0 {
                covered
            } else {
                seg_end - start
            };
            f += seg_frames;
            match boundary {
                0 => {
                    self.pos = start + covered;
                    break;
                }
                2 => {
                    self.pos = seg_end;
                    self.flush_offs(f.min(n - 1));
                    self.playing = false;
                    self.finished = true;
                    self.finished_at = Some(self.frame_counter + f.min(n) as u64);
                    break;
                }
                _ => {
                    let overshoot = start + covered - hi;
                    self.wrap(lo, f.min(n - 1), overshoot);
                }
            }
        }
    }

    #[inline]
    fn push_event(&mut self, offset: u32, order: u8, kind: EvKind) -> bool {
        if self.events.len() >= MAX_EVENTS {
            self.shared.events_dropped.fetch_add(1, Relaxed);
            return false;
        }
        self.seq = self.seq.wrapping_add(1);
        self.events.push(Ev {
            offset,
            order,
            seq: self.seq,
            kind,
        });
        true
    }

    #[inline]
    fn emit_note(
        &mut self,
        offset: u32,
        slot: u32,
        key: u8,
        pitch: f32,
        vel: f32,
        extras: NoteExtras,
        off_tick: f64,
        owner: u32,
    ) {
        if self.pending_offs.len() >= MAX_PENDING_OFFS {
            self.shared.events_dropped.fetch_add(1, Relaxed);
            return;
        }
        if self.push_event(
            offset,
            2,
            EvKind::On {
                slot,
                key,
                pitch,
                vel,
                extras,
            },
        ) {
            self.pending_offs.push(PendingOff {
                slot,
                key,
                tick: off_tick,
                owner,
            });
        }
    }

    fn gen_events(&mut self, from: f64, to: f64, base: f64, f: usize, n: usize, tpf: f64) {
        if to <= from {
            return;
        }
        let off = |t: f64| -> u32 {
            let x = f as f64 + ((t - base) / tpf).round();
            x.clamp(f as f64, (n - 1) as f64) as u32
        };

        let mut i = 0;
        while i < self.pending_offs.len() {
            let o = self.pending_offs[i];
            if o.tick < to {
                self.pending_offs.swap_remove(i);
                self.push_event(
                    off(o.tick),
                    0,
                    EvKind::Off {
                        slot: o.slot,
                        key: o.key,
                    },
                );
            } else {
                i += 1;
            }
        }

        let swing = self.program.transport.swing;
        if self.song_mode() {
            let pc_count = self.program.pattern_clips.len();
            let lo_start = from - self.program.max_pattern_clip_len;
            let mut ci = self
                .program
                .pattern_clips
                .partition_point(|c| c.start < lo_start);
            while ci < pc_count {
                let clip = self.program.pattern_clips[ci];
                ci += 1;
                if clip.start >= to {
                    break;
                }
                if clip.end <= from || self.launch_silenced(clip.track) {
                    continue;
                }
                let wa = from.max(clip.start);
                let wb = to.min(clip.end);
                if wb <= wa {
                    continue;
                }
                let Some(pat) = self.program.pattern(clip.pattern_slot) else {
                    continue;
                };
                let len = pat.len;
                if len < 1.0 {
                    continue;
                }
                let sa = wa - clip.start + clip.offset;
                let sb = wb - clip.start + clip.offset;
                let k0 = ((sa - MAX_SWING_TICKS) / len).floor().max(0.0) as i64;
                let k1 = (sb / len).floor() as i64;
                let mut k = k0;
                while k <= k1 {
                    let kb = k as f64 * len;
                    let la = sa - kb;
                    let lb = sb - kb;
                    let ns = &self.program.patterns[clip.pattern_slot as usize]
                        .as_ref()
                        .map(|p| &p.notes[..])
                        .unwrap_or(&[]);
                    let mut ni = ns.partition_point(|x| x.tick < la - MAX_SWING_TICKS);
                    let ncount = ns.len();
                    while ni < ncount {
                        let note = self.program.patterns[clip.pattern_slot as usize]
                            .as_ref()
                            .map(|p| p.notes[ni]);
                        ni += 1;
                        let Some(note) = note else { break };
                        if note.tick >= lb {
                            break;
                        }
                        if note.tick >= len {
                            break;
                        }
                        let Some(ch) = self.program.channel(note.ch_slot) else {
                            continue;
                        };
                        let sw = note.tick + swing_offset(note.tick, swing, ch.swing as f64);
                        if sw < la || sw >= lb {
                            continue;
                        }
                        let song_t = sw + kb - clip.offset + clip.start;
                        let off_tick = (song_t + note.dur.max(1.0)).min(clip.end);
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
                        self.emit_note(
                            off(song_t),
                            note.ch_slot,
                            note.key,
                            pitch,
                            note.vel,
                            extras,
                            off_tick,
                            clip.track,
                        );
                    }
                    k += 1;
                }
            }
            let ac_count = self.program.audio_clips.len();
            let mut ai = self.program.audio_clips.partition_point(|c| c.start < from);
            while ai < ac_count {
                let clip = self.program.audio_clips[ai];
                ai += 1;
                if clip.start >= to {
                    break;
                }
                self.trigger_audio_clip(&clip, clip.start, off(clip.start));
            }
        } else {
            let slot = self.cur_pattern;
            let (len, count) = match self.program.pattern(slot) {
                Some(p) => (p.len, p.notes.len()),
                None => (0.0, 0),
            };
            if count > 0 {
                let mut ni = self.program.patterns[slot as usize]
                    .as_ref()
                    .map(|p| p.notes.partition_point(|x| x.tick < from - MAX_SWING_TICKS))
                    .unwrap_or(count);
                while ni < count {
                    let note = self.program.patterns[slot as usize]
                        .as_ref()
                        .map(|p| p.notes[ni]);
                    ni += 1;
                    let Some(note) = note else { break };
                    if note.tick >= to || note.tick >= len {
                        break;
                    }
                    let Some(ch) = self.program.channel(note.ch_slot) else {
                        continue;
                    };
                    let sw = note.tick + swing_offset(note.tick, swing, ch.swing as f64);
                    if sw < from || sw >= to {
                        continue;
                    }
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
                    self.emit_note(
                        off(sw),
                        note.ch_slot,
                        note.key,
                        pitch,
                        note.vel,
                        extras,
                        sw + note.dur.max(1.0),
                        NONE,
                    );
                }
            }
        }

        if self.program.transport.metronome {
            let beat = beat_ticks(self.program.transport.den);
            let bar = bar_ticks(self.program.transport.num, self.program.transport.den);
            let mut b = (from / beat).ceil() * beat;
            while b < to {
                let accent = (b / bar - (b / bar).round()).abs() < 1e-9;
                self.click.start = Some(off(b) as usize);
                self.click.pending_accent = accent;
                b += beat;
            }
        }
    }

    fn trigger_audio_clip(&mut self, clip: &AudioClipProg, at_tick: f64, offset: u32) {
        if self.launch_silenced(clip.track) {
            return;
        }
        let Some(ch) = self.program.channel(clip.ch_slot) else {
            return;
        };
        let src_ticks = (at_tick - clip.start + clip.offset).max(0.0);
        let sample_start =
            ticks_to_seconds(src_ticks, self.program.transport.bpm.clamp(10.0, 999.0));
        let pitch = clip.key as f32 + ch.root_shift + ch.pitch;
        let extras = NoteExtras {
            sample_start,
            ..NoteExtras::default()
        };
        let env = ClipEnv {
            start: clip.start,
            end: clip.end,
            gain: clip.gain,
            fade_in: clip.fade_in,
            fade_out: clip.fade_out,
        };
        self.chan_rt[clip.ch_slot as usize].clip = Some(env);
        self.emit_note(offset, clip.ch_slot, clip.key, pitch, 1.0, extras, clip.end, clip.track);
    }

    fn chase(&mut self, at: f64, f: usize) {
        self.launch_chase(at, f);
        if !self.song_mode() {
            return;
        }
        let lo_start = at - self.program.max_audio_clip_len;
        let count = self.program.audio_clips.len();
        let mut ai = self
            .program
            .audio_clips
            .partition_point(|c| c.start < lo_start);
        while ai < count {
            let clip = self.program.audio_clips[ai];
            ai += 1;
            if clip.start >= at {
                break;
            }
            if clip.end > at {
                self.trigger_audio_clip(&clip, at, f as u32);
            }
        }
    }

    fn rechase(&mut self, at: f64, f: usize) {
        if self.song_mode() {
            let lo_start = at - self.program.max_audio_clip_len;
            let count = self.program.audio_clips.len();
            let mut ai = self
                .program
                .audio_clips
                .partition_point(|c| c.start < lo_start);
            while ai < count {
                let clip = self.program.audio_clips[ai];
                ai += 1;
                if clip.start >= at {
                    break;
                }
                if clip.end > at && self.chan_rt[clip.ch_slot as usize].rechase {
                    self.trigger_audio_clip(&clip, at, f as u32);
                }
            }
        }
        self.clear_rechase();
    }

    fn clear_rechase(&mut self) {
        if self.pending_rechase {
            self.pending_rechase = false;
            for rt in self.chan_rt.iter_mut() {
                rt.rechase = false;
            }
        }
    }

    fn eval_automation(&mut self) {
        if !self.song_mode() || self.program.auto_clips.is_empty() {
            return;
        }
        let pos = self.pos;
        for ci in 0..self.program.auto_clips.len() {
            let (active_now, was, rel_now, rel_end, target) = {
                let c = &self.program.auto_clips[ci];
                (
                    pos >= c.start && pos < c.end,
                    c.active,
                    pos - c.start + c.offset,
                    c.end - c.start + c.offset,
                    c.target,
                )
            };
            let v = if active_now {
                Some(automation::eval(
                    &self.program.auto_clips[ci].points,
                    rel_now,
                ))
            } else if was {
                Some(automation::eval(
                    &self.program.auto_clips[ci].points,
                    rel_end,
                ))
            } else {
                None
            };
            self.program.auto_clips[ci].active = active_now;
            if let Some(v) = v {
                self.apply_target(target, v);
            }
        }
    }

    fn apply_target(&mut self, ti: usize, norm: f64) {
        let Some(t) = self.program.targets.get(ti) else {
            return;
        };
        let v = from_normalized(&t.spec, norm as f32);
        if t.held == Some(v) {
            return;
        }
        let kind = t.kind;
        self.program.targets[ti].held = Some(v);
        match kind {
            TargetKind::Gen { ch_slot, index } => {
                if let Some(Some(i)) = self.instruments.get_mut(ch_slot as usize) {
                    i.set_param(index, v);
                }
            }
            TargetKind::SlotParam { fx_slot, index } => {
                if let Some(Some(e)) = self.effects.get_mut(fx_slot as usize) {
                    e.set_param(index, v);
                }
            }
            TargetKind::RackInst { .. } | TargetKind::RackFx { .. } => self.write_rack(kind, v),
            _ => write_builtin(&mut self.program, ti, v),
        }
    }

    fn dispatch_events(&mut self) {
        if self.events.is_empty() {
            return;
        }
        self.events
            .sort_unstable_by_key(|e| (e.offset, e.order, e.seq));
        for idx in 0..self.events.len() {
            let ev = self.events[idx];
            let off = ev.offset as usize;
            match ev.kind {
                EvKind::Off { slot, key } => {
                    if let Some(Some(i)) = self.instruments.get_mut(slot as usize) {
                        i.note_off(off, key);
                    }
                }
                EvKind::On {
                    slot,
                    key,
                    pitch,
                    vel,
                    extras,
                } => {
                    let Some(ch) = self.program.channel(slot) else {
                        continue;
                    };
                    if ch.mute {
                        continue;
                    }
                    let ci = self.program.chan_index[slot as usize] as usize;
                    for k in 0..self.program.channels[ci].chokes.len() {
                        let c = self.program.channels[ci].chokes[k] as usize;
                        if let Some(Some(i)) = self.instruments.get_mut(c) {
                            i.choke(off);
                        }
                    }
                    if let Some(Some(i)) = self.instruments.get_mut(slot as usize) {
                        i.note_on(off, key, pitch, vel, extras);
                        self.chan_rt[slot as usize].kick = true;
                    }
                }
            }
        }
        self.events.clear();
    }

    fn process_channels(&mut self, n: usize, ctx: &ProcessContext) {
        let tick_a = self.pos;
        let playing = self.playing;
        for ci in 0..self.program.channels.len() {
            let (slot, ins_slot, vol, pan) = {
                let c = &self.program.channels[ci];
                (c.slot as usize, c.insert_slot, c.volume, c.pan)
            };
            let rt = &mut self.chan_rt[slot];
            let theta = (pan.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
            let mut tl = vol * theta.cos().max(0.0) * std::f32::consts::SQRT_2;
            let mut tr = vol * theta.sin().max(0.0) * std::f32::consts::SQRT_2;
            if let Some(env) = rt.clip {
                let g = if playing { env.at(tick_a) } else { env.gain };
                tl *= g;
                tr *= g;
            }
            let Some(inst) = self.instruments[slot].as_mut() else {
                rt.gl = tl;
                rt.gr = tr;
                continue;
            };
            let active = rt.kick || inst.is_active();
            let pdc = self.program.channels[ci].pdc.as_mut();
            if !active && !(pdc.is_some() && rt.pdc_tail > 0) {
                rt.gl = tl;
                rt.gr = tr;
                rt.fresh = false;
                continue;
            }
            rt.kick = false;
            rt.l[..n].fill(0.0);
            rt.r[..n].fill(0.0);
            if active {
                inst.process(ctx, [&mut rt.l[..n], &mut rt.r[..n]]);
            }
            if let Some(d) = pdc {
                d.process(&mut rt.l[..n], &mut rt.r[..n]);
                rt.pdc_tail = if active { d.len() as u32 } else { rt.pdc_tail.saturating_sub(n as u32) };
            }

            let mut pk = 0f32;
            for i in 0..n {
                pk = pk.max(rt.l[i].abs()).max(rt.r[i].abs());
            }
            if pk.is_finite() {
                self.shared.ch_act[slot].fetch_max(pk.min(1.0).to_bits(), Relaxed);
            }
            if rt.fresh {
                rt.gl = tl;
                rt.gr = tr;
                rt.fresh = false;
            }
            let (gl0, gr0) = (rt.gl, rt.gr);
            rt.gl = tl;
            rt.gr = tr;
            if ins_slot == NONE {
                continue;
            }
            let inv = 1.0 / n as f32;
            let (l, r) = (&rt.l, &rt.r);
            let ins = &mut self.ins_rt[ins_slot as usize];
            for i in 0..n {
                let a = (i + 1) as f32 * inv;
                let gl = gl0 + (tl - gl0) * a;
                let gr = gr0 + (tr - gr0) * a;
                ins.ch_l[i] += l[i] * gl;
                ins.ch_r[i] += r[i] * gr;
            }
        }
    }

    fn process_insert(&mut self, idx: usize, n: usize, ctx: &ProcessContext) {
        let slot = self.program.inserts[idx].slot as usize;
        {
            let ins = &mut self.program.inserts[idx];
            let rt = &mut self.ins_rt[slot];
            if let Some(d) = ins.chan_delay.as_mut() {
                d.process(&mut rt.ch_l[..n], &mut rt.ch_r[..n]);
            }
            for i in 0..n {
                rt.out_l[i] = rt.ch_l[i] + rt.in_l[i];
                rt.out_r[i] = rt.ch_r[i] + rt.in_r[i];
            }
        }
        let quiet_need = self.program.inserts[idx].quiet_frames;
        let in_silent = quiet_need > 0 && {
            let rt = &self.ins_rt[slot];
            is_silent(&rt.out_l[..n]) && is_silent(&rt.out_r[..n])
        };
        if in_silent && self.ins_rt[slot].quiet >= quiet_need {
            let rt = &mut self.ins_rt[slot];
            rt.out_l[..n].fill(0.0);
            rt.out_r[..n].fill(0.0);
            for fx in self.program.inserts[idx].fx.iter() {
                self.shared.meters.tap(fx.slot, None, n);
            }
        } else {
            for k in 0..self.program.inserts[idx].fx.len() {
                let (fx_slot, enabled, mix, sc) = {
                    let fx = &self.program.inserts[idx].fx[k];
                    (
                        fx.slot as usize,
                        fx.enabled,
                        fx.mix.clamp(0.0, 1.0),
                        fx.sidechain,
                    )
                };
                if !enabled || mix <= 0.0 {
                    let rt = &self.ins_rt[slot];
                    self.shared.meters.tap(fx_slot as u32, Some((&rt.out_l[..n], &rt.out_r[..n])), n);
                    continue;
                }
                let Some(effect) = self.effects.get_mut(fx_slot).and_then(|e| e.as_mut()) else {
                    let rt = &self.ins_rt[slot];
                    self.shared.meters.tap(fx_slot as u32, Some((&rt.out_l[..n], &rt.out_r[..n])), n);
                    continue;
                };
                let has_sc = sc != NONE && (sc as usize) < MAX_INSERTS;
                if has_sc {
                    self.sc_l[..n].copy_from_slice(&self.ins_rt[sc as usize].out_l[..n]);
                    self.sc_r[..n].copy_from_slice(&self.ins_rt[sc as usize].out_r[..n]);
                }
                let rt = &mut self.ins_rt[slot];
                if mix < 1.0 {
                    self.dry_l[..n].copy_from_slice(&rt.out_l[..n]);
                    self.dry_r[..n].copy_from_slice(&rt.out_r[..n]);
                    effect.align_dry([&mut self.dry_l[..n], &mut self.dry_r[..n]]);
                }
                let side = if has_sc {
                    Some([&self.sc_l[..n], &self.sc_r[..n]])
                } else {
                    None
                };
                effect.process(ctx, [&mut rt.out_l[..n], &mut rt.out_r[..n]], side);
                if mix < 1.0 {
                    let d = 1.0 - mix;
                    for i in 0..n {
                        rt.out_l[i] = self.dry_l[i] * d + rt.out_l[i] * mix;
                        rt.out_r[i] = self.dry_r[i] * d + rt.out_r[i] * mix;
                    }
                }
                self.shared.meters.publish_gr(fx_slot, effect.meter());
                self.shared.meters.tap(fx_slot as u32, Some((&rt.out_l[..n], &rt.out_r[..n])), n);
            }
            let rt = &mut self.ins_rt[slot];
            rt.quiet = if in_silent && is_silent(&rt.out_l[..n]) && is_silent(&rt.out_r[..n]) {
                rt.quiet.saturating_add(n as u32)
            } else {
                0
            };
        }
        let (sep, phase, swap, pan, vol, mute, is_master) = {
            let p = &self.program.inserts[idx];
            (p.sep, p.phase, p.swap, p.pan, p.volume, p.mute, p.is_master)
        };
        let rt = &mut self.ins_rt[slot];
        if sep != 0.0 {
            let sg = 1.0 + sep.clamp(-1.0, 1.0);
            for i in 0..n {
                let m = 0.5 * (rt.out_l[i] + rt.out_r[i]);
                let s = 0.5 * (rt.out_l[i] - rt.out_r[i]) * sg;
                rt.out_l[i] = m + s;
                rt.out_r[i] = m - s;
            }
        }
        if phase {
            for i in 0..n {
                rt.out_l[i] = -rt.out_l[i];
                rt.out_r[i] = -rt.out_r[i];
            }
        }
        if swap {
            for i in 0..n {
                std::mem::swap(&mut rt.out_l[i], &mut rt.out_r[i]);
            }
        }
        let p = pan.clamp(-1.0, 1.0);
        let (mut tl, mut tr) = (vol * (1.0 - p.max(0.0)), vol * (1.0 + p.min(0.0)));
        if mute {
            tl = 0.0;
            tr = 0.0;
        }
        if rt.fresh {
            rt.gl = tl;
            rt.gr = tr;
            rt.fresh = false;
        }
        let (gl0, gr0) = (rt.gl, rt.gr);
        let inv = 1.0 / n as f32;
        let (mut pl, mut pr) = (0f32, 0f32);
        for i in 0..n {
            let a = (i + 1) as f32 * inv;
            let l = rt.out_l[i] * (gl0 + (tl - gl0) * a);
            let r = rt.out_r[i] * (gr0 + (tr - gr0) * a);
            let l = if l.is_finite() { l } else { 0.0 };
            let r = if r.is_finite() { r } else { 0.0 };
            rt.out_l[i] = l;
            rt.out_r[i] = r;
            pl = pl.max(l.abs());
            pr = pr.max(r.abs());
        }
        rt.gl = tl;
        rt.gr = tr;
        if slot < MAX_INSERTS {
            self.shared.ins_peak[slot][0].fetch_max(pl.to_bits(), Relaxed);
            self.shared.ins_peak[slot][1].fetch_max(pr.to_bits(), Relaxed);
        }
        let mut ol = [0f32; SUB];
        let mut or = [0f32; SUB];
        ol[..n].copy_from_slice(&rt.out_l[..n]);
        or[..n].copy_from_slice(&rt.out_r[..n]);
        if is_master {
            for i in 0..n {
                self.master_l[i] += ol[i];
                self.master_r[i] += or[i];
            }
            return;
        }
        for k in 0..self.program.inserts[idx].routes.len() {
            let route = &mut self.program.inserts[idx].routes[k];
            let target = route.target_slot as usize;
            let level = route.level;
            if target >= MAX_INSERTS || (level == 0.0 && route.delay.is_none()) {
                continue;
            }
            match route.delay.as_mut() {
                Some(d) => {
                    let mut tl = [0f32; SUB];
                    let mut tr = [0f32; SUB];
                    for i in 0..n {
                        tl[i] = ol[i] * level;
                        tr[i] = or[i] * level;
                    }
                    d.process(&mut tl[..n], &mut tr[..n]);
                    let t = &mut self.ins_rt[target];
                    for i in 0..n {
                        t.in_l[i] += tl[i];
                        t.in_r[i] += tr[i];
                    }
                }
                None => {
                    let t = &mut self.ins_rt[target];
                    for i in 0..n {
                        t.in_l[i] += ol[i] * level;
                        t.in_r[i] += or[i] * level;
                    }
                }
            }
        }
    }

    fn finish_master(&mut self, n: usize) {
        if let Some(tx) = self.spec_tx.as_mut() {
            if tx.slots() >= n {
                for i in 0..n {
                    let _ = tx.push(0.5 * (self.master_l[i] + self.master_r[i]));
                }
            }
        }
        if !self.playing && !self.live_counting_in() {
            self.click.start = None;
        }
        if let Some(start) = self.click.start.take() {
            let accent = self.click.pending_accent;
            let freq = if accent { 1760.0 } else { 1320.0 };
            self.click.inc = freq / self.sr;
            self.click.phase = 0.0;
            self.click.total = (0.03 * self.sr) as u32;
            self.click.remaining = self.click.total;
            self.click.amp = if accent { 0.45 } else { 0.28 };
            self.render_click(start, n);
        } else if self.click.remaining > 0 {
            self.render_click(0, n);
        }
        let mut done = false;
        if let Some(p) = self.preview.as_mut() {
            let data = &p.data;
            let frames = data.frames();
            let step = data.sample_rate as f64 / self.sr as f64;
            let chans = data.channels.len();
            if frames < 2 || chans == 0 || !(step > 0.0) {
                done = true;
            } else {
                for i in 0..n {
                    let idx = p.pos as usize;
                    if idx + 1 >= frames {
                        done = true;
                        break;
                    }
                    let fr = (p.pos - idx as f64) as f32;
                    let c0 = &data.channels[0];
                    let l = c0[idx] + (c0[idx + 1] - c0[idx]) * fr;
                    let r = if chans > 1 {
                        let c1 = &data.channels[1];
                        c1[idx] + (c1[idx + 1] - c1[idx]) * fr
                    } else {
                        l
                    };
                    self.master_l[i] += l * p.gain;
                    self.master_r[i] += r * p.gain;
                    p.pos += step;
                }
            }
        }
        if done {
            if let Some(p) = self.preview.take() {
                self.retire(Garbage::Preview(p));
            }
        }
        let target = self.program.transport.master_volume.max(0.0);
        let g0 = self.master_gain;
        let inv = 1.0 / n as f32;
        for i in 0..n {
            let g = g0 + (target - g0) * ((i + 1) as f32 * inv);
            let l = self.master_l[i] * g;
            let r = self.master_r[i] * g;
            self.master_l[i] = if l.is_finite() { l } else { 0.0 };
            self.master_r[i] = if r.is_finite() { r } else { 0.0 };
        }
        self.master_gain = target;
    }

    fn render_click(&mut self, start: usize, n: usize) {
        let c = &mut self.click;
        for i in start..n {
            if c.remaining == 0 {
                break;
            }
            let env = c.remaining as f32 / c.total.max(1) as f32;
            let s = (c.phase * std::f32::consts::TAU).sin() * c.amp * env * env;
            self.master_l[i] += s;
            self.master_r[i] += s;
            c.phase += c.inc;
            if c.phase >= 1.0 {
                c.phase -= 1.0;
            }
            c.remaining -= 1;
        }
    }
}

impl AutoClipProg {
    fn target_ref_eq(&self, other: &AutoClipProg) -> bool {
        self.points.len() == other.points.len() && self.offset == other.offset
    }
}

fn write_builtin(p: &mut Program, ti: usize, v: f32) {
    let Some(t) = p.targets.get(ti) else { return };
    match t.kind {
        TargetKind::Bpm => p.transport.bpm = v as f64,
        TargetKind::Swing => p.transport.swing = v as f64,
        TargetKind::MasterVolume => p.transport.master_volume = v,
        TargetKind::ChanVolume(i) => {
            if let Some(c) = p.channels.get_mut(i) {
                c.volume = v
            }
        }
        TargetKind::ChanPan(i) => {
            if let Some(c) = p.channels.get_mut(i) {
                c.pan = v
            }
        }
        TargetKind::ChanPitch(i) => {
            if let Some(c) = p.channels.get_mut(i) {
                c.pitch = v
            }
        }
        TargetKind::InsVolume(i) => {
            if let Some(x) = p.inserts.get_mut(i) {
                x.volume = v
            }
        }
        TargetKind::InsPan(i) => {
            if let Some(x) = p.inserts.get_mut(i) {
                x.pan = v
            }
        }
        TargetKind::InsSep(i) => {
            if let Some(x) = p.inserts.get_mut(i) {
                x.sep = v
            }
        }
        TargetKind::SlotMix { ins, fx } => {
            if let Some(f) = p.inserts.get_mut(ins).and_then(|x| x.fx.get_mut(fx)) {
                f.mix = v
            }
        }
        TargetKind::Route { ins, route } => {
            if let Some(r) = p.inserts.get_mut(ins).and_then(|x| x.routes.get_mut(route)) {
                r.level = v
            }
        }
        TargetKind::Gen { .. } | TargetKind::SlotParam { .. } | TargetKind::RackInst { .. } | TargetKind::RackFx { .. } => {}
    }
}

#[inline]
fn is_rack_target(k: TargetKind) -> bool {
    matches!(k, TargetKind::RackInst { .. } | TargetKind::RackFx { .. })
}

#[inline]
fn is_silent(x: &[f32]) -> bool {
    x.iter().all(|v| v.abs() < 1e-7)
}
