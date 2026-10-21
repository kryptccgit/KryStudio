//! CLAP hosting on top of clack-host (MIT OR Apache-2.0).
//!
//! Main-thread side: `ClapInstance` (instantiate, activate, state, GUI,
//! main-thread callbacks). Audio side: `ClapProc`, run by the instance's
//! real-time thread, translating the shared block into CLAP events/buffers.

use crate::audio::{AudioThread, Processor};
use crate::serve::{Hosted, LoadArgs};
use crate::{win, wire};
use clack_extensions::audio_ports::{AudioPortFlags, AudioPortInfoBuffer, AudioPortRescanFlags, HostAudioPorts, HostAudioPortsImpl, PluginAudioPorts};
use clack_extensions::gui::{GuiApiType, GuiConfiguration, GuiSize, HostGui, HostGuiImpl, PluginGui, Window as ClapWindow};
use clack_extensions::latency::{HostLatency, HostLatencyImpl, PluginLatency};
use clack_extensions::log::{HostLog, HostLogImpl, LogSeverity};
use clack_extensions::note_ports::{HostNotePorts, HostNotePortsImpl, NoteDialect, NoteDialects, NotePortInfoBuffer, NotePortRescanFlags, PluginNotePorts};
use clack_extensions::params::{HostParams, HostParamsImplMainThread, HostParamsImplShared, ParamClearFlags, ParamInfoBuffer, ParamInfoFlags, ParamRescanFlags, PluginParams};
use clack_extensions::state::{HostState, HostStateImpl, PluginState};
use clack_host::events::event_types::*;
use clack_host::events::{EventFlags, EventHeader, Match};
use clack_host::prelude::*;
use clack_host::utils::{BeatTime, SecondsTime};
use krypt_studio_pluginclient::shm::{ev, flag, Block, Channel, Ev};
use serde_json::{json, Value};
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering::*};
use std::sync::{Arc, Mutex};
use windows_sys::Win32::Foundation::HWND;

// ── Host handlers ────────────────────────────────────────────────────────

pub struct KryptClap;

impl HostHandlers for KryptClap {
    type Shared<'a> = ClapShared;
    type MainThread<'a> = ClapMain<'a>;
    type AudioProcessor<'a> = ();

    fn declare_extensions(builder: &mut HostExtensions<Self>, _shared: &Self::Shared<'_>) {
        builder
            .register::<HostLog>()
            .register::<HostGui>()
            .register::<HostParams>()
            .register::<HostState>()
            .register::<HostLatency>()
            .register::<HostAudioPorts>()
            .register::<HostNotePorts>();
    }
}

/// Flags plugin threads raise for the UI thread.
pub struct ClapShared {
    callback: AtomicBool,
    restart: AtomicBool,
    flush: AtomicBool,
    gui_closed: AtomicBool,
    resize: Mutex<Option<GuiSize>>,
    latency_changed: AtomicBool,
}

impl ClapShared {
    fn new() -> Self {
        ClapShared {
            callback: AtomicBool::new(false),
            restart: AtomicBool::new(false),
            flush: AtomicBool::new(false),
            gui_closed: AtomicBool::new(false),
            resize: Mutex::new(None),
            latency_changed: AtomicBool::new(false),
        }
    }
}

impl<'a> SharedHandler<'a> for ClapShared {
    fn request_restart(&self) {
        self.restart.store(true, Release);
        win::wake();
    }
    fn request_process(&self) {
        // The engine decides when to process; we're always active.
    }
    fn request_callback(&self) {
        self.callback.store(true, Release);
        win::wake();
    }
}

impl HostLogImpl for ClapShared {
    fn log(&self, severity: LogSeverity, message: &str) {
        if severity >= LogSeverity::Warning {
            eprintln!("[clap] [{severity}] {message}");
        }
    }
}

impl HostGuiImpl for ClapShared {
    fn resize_hints_changed(&self) {}
    fn request_resize(&self, new_size: GuiSize) -> Result<(), HostError> {
        *self.resize.lock().unwrap_or_else(|e| e.into_inner()) = Some(new_size);
        win::wake();
        Ok(())
    }
    fn request_show(&self) -> Result<(), HostError> {
        Ok(())
    }
    fn request_hide(&self) -> Result<(), HostError> {
        Ok(())
    }
    fn closed(&self, _was_destroyed: bool) {
        self.gui_closed.store(true, Release);
        win::wake();
    }
}

impl HostParamsImplShared for ClapShared {
    fn request_flush(&self) {
        self.flush.store(true, Release);
    }
}

pub struct ClapMain<'a> {
    shared: &'a ClapShared,
}

impl<'a> MainThreadHandler<'a> for ClapMain<'a> {}

impl HostParamsImplMainThread for ClapMain<'_> {
    fn rescan(&self, _flags: ParamRescanFlags) {}
    fn clear(&self, _param_id: ClapId, _flags: ParamClearFlags) {}
}

impl HostStateImpl for ClapMain<'_> {
    fn mark_dirty(&self) {}
}

impl HostLatencyImpl for ClapMain<'_> {
    fn changed(&self) {
        self.shared.latency_changed.store(true, Release);
    }
}

impl HostAudioPortsImpl for ClapMain<'_> {
    fn is_rescan_flag_supported(&self, _flag: AudioPortRescanFlags) -> bool {
        false
    }
    fn rescan(&self, _flags: AudioPortRescanFlags) {}
}

impl HostNotePortsImpl for ClapMain<'_> {
    fn supported_dialects(&self) -> NoteDialects {
        NoteDialects::CLAP | NoteDialects::MIDI
    }
    fn rescan(&self, _flags: NotePortRescanFlags) {}
}

pub fn host_info() -> HostInfo {
    HostInfo::new("Krypt Studio", "Krypt", "https://krypt.cc/tools/studio", env!("CARGO_PKG_VERSION")).expect("static host info")
}

pub fn new_instance(entry: &PluginEntry, plugin_id: &str) -> Result<PluginInstance<KryptClap>, String> {
    let cid = CString::new(plugin_id).map_err(|_| "bad plugin id")?;
    PluginInstance::<KryptClap>::new(|_| ClapShared::new(), |shared| ClapMain { shared }, entry, &cid, &host_info()).map_err(|e| format!("couldn't create the plugin: {e}"))
}

// ── Ports ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct Ports {
    /// Channel count per audio input port.
    pub inputs: Vec<u32>,
    pub main_in: Option<usize>,
    pub outputs: Vec<u32>,
    pub main_out: Option<usize>,
    pub note_inputs: u32,
    /// The plugin's first note port only speaks MIDI.
    pub midi_notes: bool,
}

pub fn discover_ports(h: &mut PluginMainThreadHandle, effect_default: bool) -> Ports {
    let mut p = Ports::default();
    match h.get_extension::<PluginAudioPorts>() {
        Some(ap) => {
            let mut buf = AudioPortInfoBuffer::new();
            for is_input in [true, false] {
                for i in 0..ap.count(h, is_input) {
                    let Some(info) = ap.get(h, i, is_input, &mut buf) else { continue };
                    let main = info.flags.contains(AudioPortFlags::IS_MAIN);
                    let list = if is_input { &mut p.inputs } else { &mut p.outputs };
                    list.push(info.channel_count.min(64));
                    let idx = list.len() - 1;
                    let slot = if is_input { &mut p.main_in } else { &mut p.main_out };
                    if main && slot.is_none() {
                        *slot = Some(idx);
                    }
                }
            }
            if p.main_in.is_none() && !p.inputs.is_empty() {
                p.main_in = Some(0);
            }
            if p.main_out.is_none() && !p.outputs.is_empty() {
                p.main_out = Some(0);
            }
        }
        None => {
            p.outputs = vec![2];
            p.main_out = Some(0);
            if effect_default {
                p.inputs = vec![2];
                p.main_in = Some(0);
            }
        }
    }
    if let Some(np) = h.get_extension::<PluginNotePorts>() {
        p.note_inputs = np.count(h, true);
        if p.note_inputs > 0 {
            let mut buf = NotePortInfoBuffer::new();
            if let Some(info) = np.get(h, 0, true, &mut buf) {
                let clap = info.supported_dialects.contains(NoteDialects::CLAP);
                let midi = info.supported_dialects.contains(NoteDialects::MIDI);
                p.midi_notes = midi && (!clap || info.preferred_dialect == Some(NoteDialect::Midi));
            }
        }
    }
    p
}

// ── Params (descriptor export, used by the scanner) ──────────────────────

fn cstr_lossy(b: &[u8]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end]).trim().to_string()
}

/// ParamSpec-shaped JSON for every visible, writable parameter.
pub fn describe_params(h: &mut PluginMainThreadHandle) -> Vec<Value> {
    let Some(params) = h.get_extension::<PluginParams>() else { return Vec::new() };
    let mut out = Vec::new();
    let mut buf = ParamInfoBuffer::new();
    let count = params.count(h).min(4096);
    for i in 0..count {
        let Some(info) = params.get_info(h, i, &mut buf) else { continue };
        if info.flags.intersects(ParamInfoFlags::IS_HIDDEN | ParamInfoFlags::IS_READONLY) {
            continue;
        }
        let id: u32 = info.id.get();
        let name = cstr_lossy(info.name);
        let module = cstr_lossy(info.module).trim_matches('/').to_string();
        let (min, max) = (info.min_value, info.max_value);
        if !(min.is_finite() && max.is_finite()) {
            continue;
        }
        let stepped = info.flags.contains(ParamInfoFlags::IS_STEPPED);
        let mut spec = json!({
            "id": id.to_string(),
            "name": if name.is_empty() { format!("Param {id}") } else { name },
            "min": min,
            "max": max,
            "default": info.default_value.clamp(min.min(max), max.max(min)),
            "unit": "",
            "scale": "linear",
            "automatable": info.flags.contains(ParamInfoFlags::IS_AUTOMATABLE),
        });
        if !module.is_empty() {
            spec["group"] = json!(module);
        }
        if stepped {
            spec["step"] = json!(1);
            let steps = (max - min).round();
            if info.flags.contains(ParamInfoFlags::IS_ENUM) && min == 0.0 && (1.0..=63.0).contains(&steps) {
                let mut labels = Vec::new();
                let mut tb = [0u8; 256];
                for k in 0..=(steps as u32) {
                    let t = params
                        .value_to_text(h, info.id, k as f64, &mut tb)
                        .map(|s| cstr_lossy(s))
                        .unwrap_or_else(|_| k.to_string());
                    labels.push(t);
                }
                spec["options"] = json!(labels);
            }
        }
        if info.flags.contains(ParamInfoFlags::IS_BYPASS) {
            spec["group"] = json!("Bypass");
        }
        out.push(spec);
    }
    out
}

pub fn gui_support(h: &mut PluginMainThreadHandle) -> Option<GuiConfiguration<'static>> {
    let gui = h.get_extension::<PluginGui>()?;
    let api = GuiApiType::default_for_current_platform()?;
    let embedded = GuiConfiguration { api_type: api, is_floating: false };
    if gui.is_api_supported(h, embedded) {
        return Some(embedded);
    }
    let floating = GuiConfiguration { api_type: api, is_floating: true };
    if gui.is_api_supported(h, floating) {
        return Some(floating);
    }
    None
}

// ── Audio side ───────────────────────────────────────────────────────────

struct ClapProc {
    proc: PluginAudioProcessor<KryptClap>,
    ports: Ports,
    max: usize,
    in_ports: AudioPorts,
    out_ports: AudioPorts,
    /// Zeroed buffers for every input channel we don't feed.
    scratch_in: Vec<f32>,
    /// Throw-away outputs for non-main ports / extra channels.
    scratch_out: Vec<f32>,
    mono: Vec<f32>,
    ev_in: EventBuffer,
    ev_out: EventBuffer,
    gui_params: rtrb::Producer<(u32, f64)>,
    params: Option<PluginParams>,
    steady: u64,
}

// SAFETY: PluginAudioProcessor is Send; the raw buffers are owned plain data.
unsafe impl Send for ClapProc {}

impl ClapProc {
    fn forward_output_params(&mut self) {
        for e in self.ev_out.iter() {
            if let Some(clack_host::events::spaces::CoreEventSpace::ParamValue(p)) = e.as_core_event() {
                if let Some(id) = p.param_id() {
                    let _ = self.gui_params.push((id.get(), p.value()));
                }
            }
        }
        self.ev_out.clear();
    }
}

impl Processor for ClapProc {
    fn started(&mut self) {
        if let Err(e) = self.proc.start_processing() {
            eprintln!("[clap] start_processing failed: {e}");
        }
    }

    fn stopping(&mut self) {
        let _ = self.proc.stop_processing();
    }

    fn idle(&mut self) {
        // Plugin GUI edits while the engine isn't calling process().
        let want = self.proc.access_shared_handler(|s| s.flush.swap(false, AcqRel));
        if let (true, Some(params)) = (want, self.params) {
            if let Ok(p) = self.proc.as_started_mut() {
                let mut out = OutputEvents::from_buffer(&mut self.ev_out);
                params.flush_active(&mut p.plugin_handle(), &InputEvents::empty(), &mut out);
            }
            self.forward_output_params();
        }
    }

    fn process(&mut self, blk: *mut Block, events: &[Ev]) -> Result<(), ()> {
        // SAFETY: the audio thread owns the block for this call (audio.rs).
        let b = unsafe { &mut *blk };
        let n = (b.frames as usize).min(self.max);
        if n == 0 {
            return Ok(());
        }
        let Ok(p) = self.proc.as_started_mut() else { return Err(()) };
        if b.flags & flag::RESET != 0 {
            p.reset();
        }
        // Events (already sorted by offset).
        self.ev_in.clear();
        let last = (n - 1) as u32;
        for e in events {
            let t = e.offset.min(last);
            let key = e.key.min(127) as u16;
            match e.kind {
                ev::NOTE_ON => {
                    if self.ports.midi_notes {
                        let vel = (e.value * 127.0).round().clamp(1.0, 127.0) as u8;
                        self.ev_in.push(&MidiEvent::new(t, 0, [0x90, key as u8, vel]));
                    } else {
                        let pckn = Pckn::new(0u16, 0u16, key, Match::All);
                        self.ev_in.push(&NoteOnEvent::new(t, pckn, e.value));
                        if e.aux != 0.0 {
                            self.ev_in.push(&NoteExpressionEvent::new(t, pckn, NoteExpressionType::Tuning, e.aux));
                        }
                    }
                }
                ev::NOTE_OFF => {
                    if self.ports.midi_notes {
                        self.ev_in.push(&MidiEvent::new(t, 0, [0x80, key as u8, 64]));
                    } else {
                        self.ev_in.push(&NoteOffEvent::new(t, Pckn::new(0u16, 0u16, key, Match::All), e.value));
                    }
                }
                ev::PARAM => {
                    if let Some(id) = ClapId::from_raw(e.id) {
                        self.ev_in.push(&ParamValueEvent::new(t, id, Pckn::match_all(), e.value));
                    }
                }
                ev::CHOKE | ev::ALL_OFF => {
                    if self.ports.midi_notes {
                        self.ev_in.push(&MidiEvent::new(t, 0, [0xB0, 123, 0]));
                    } else {
                        self.ev_in.push(&NoteChokeEvent::new(t, Pckn::match_all()));
                    }
                }
                _ => {}
            }
        }

        // Audio buffers: the main ports map straight onto the shared block.
        let inp = b.audio_in.as_mut_ptr() as *mut f32;
        let outp = b.audio_out.as_mut_ptr() as *mut f32;
        let stride = krypt_studio_pluginclient::shm::MAX_FRAMES;
        let max = self.max;
        let sin = self.scratch_in.as_mut_ptr();
        let sout = self.scratch_out.as_mut_ptr();
        let mono = self.mono.as_mut_ptr();
        // Mono main input: L+R mixdown.
        if let Some(mi) = self.ports.main_in {
            if self.ports.inputs[mi] == 1 {
                for i in 0..n {
                    // SAFETY: n ≤ max ≤ MAX_FRAMES; buffers sized accordingly.
                    unsafe { *mono.add(i) = 0.5 * (*inp.add(i) + *inp.add(stride + i)) };
                }
            }
        }
        let ports = &self.ports;
        let mut gch = 0usize;
        let ins = self.in_ports.with_input_buffers(ports.inputs.iter().enumerate().map(|(pi, &chs)| {
            let main = ports.main_in == Some(pi);
            let base = gch;
            gch += chs as usize;
            AudioPortBuffer {
                latency: 0,
                channels: AudioPortBufferType::f32_input_only((0..chs as usize).map(move |c| {
                    // SAFETY: every pointer targets a buffer of ≥ n frames that outlives the call.
                    let ptr = unsafe {
                        if main && chs == 1 {
                            mono
                        } else if main && c < 2 {
                            inp.add(c * stride)
                        } else {
                            let p = sin.add((base + c) * max);
                            std::ptr::write_bytes(p, 0, n);
                            p
                        }
                    };
                    InputChannel { buffer: unsafe { std::slice::from_raw_parts_mut(ptr, n) }, is_constant: false }
                })),
            }
        }));
        let mut gch = 0usize;
        let mut outs = self.out_ports.with_output_buffers(ports.outputs.iter().enumerate().map(|(pi, &chs)| {
            let main = ports.main_out == Some(pi);
            let base = gch;
            gch += chs as usize;
            AudioPortBuffer {
                latency: 0,
                channels: AudioPortBufferType::f32_output_only((0..chs as usize).map(move |c| {
                    // SAFETY: as above.
                    let ptr = unsafe { if main && c < 2 { outp.add(c * stride) } else { sout.add((base + c) * max) } };
                    unsafe { std::slice::from_raw_parts_mut(ptr, n) }
                })),
            }
        }));
        // Zero the outputs first: some plugins only add.
        // SAFETY: owned block.
        unsafe {
            std::ptr::write_bytes(outp, 0, n);
            std::ptr::write_bytes(outp.add(stride), 0, n);
        }
        let mut tflags = TransportFlags::HAS_TEMPO | TransportFlags::HAS_BEATS_TIMELINE | TransportFlags::HAS_SECONDS_TIMELINE | TransportFlags::HAS_TIME_SIGNATURE;
        if b.flags & flag::PLAYING != 0 {
            tflags |= TransportFlags::IS_PLAYING;
        }
        let bpm = if b.bpm.is_finite() && b.bpm > 0.0 { b.bpm } else { 120.0 };
        let beats = if b.beat_pos.is_finite() { b.beat_pos.max(0.0) } else { 0.0 };
        let bar = (beats / 4.0).floor();
        let transport = TransportEvent {
            header: EventHeader::new_core(0, EventFlags::empty()),
            flags: tflags,
            song_pos_beats: BeatTime::from_float(beats),
            song_pos_seconds: SecondsTime::from_float(beats * 60.0 / bpm),
            tempo: bpm,
            tempo_inc: 0.0,
            loop_start_beats: BeatTime::from_float(0.0),
            loop_end_beats: BeatTime::from_float(0.0),
            loop_start_seconds: SecondsTime::from_float(0.0),
            loop_end_seconds: SecondsTime::from_float(0.0),
            bar_start: BeatTime::from_float(bar * 4.0),
            bar_number: bar as i32,
            time_signature_numerator: 4,
            time_signature_denominator: 4,
        };
        let input_events = InputEvents::from_buffer(&self.ev_in);
        let mut output_events = OutputEvents::from_buffer(&mut self.ev_out);
        let r = p.process(&ins, &mut outs, &input_events, &mut output_events, Some(self.steady), Some(&transport));
        self.steady = self.steady.wrapping_add(n as u64);
        // Mono main output → both sides.
        if let Some(mo) = self.ports.main_out {
            if self.ports.outputs[mo] == 1 {
                // SAFETY: owned block.
                unsafe { std::ptr::copy_nonoverlapping(outp, outp.add(stride), n) };
            }
        } else {
            // No audio output at all (MIDI effect): silence.
            unsafe {
                std::ptr::write_bytes(outp, 0, n);
                std::ptr::write_bytes(outp.add(stride), 0, n);
            }
        }
        self.forward_output_params();
        match r {
            Ok(_) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

// ── Main-thread instance ─────────────────────────────────────────────────

struct Editor {
    container: Option<HWND>,
    resizable: bool,
}

pub struct ClapInstance {
    id: u64,
    name: String,
    instance: PluginInstance<KryptClap>,
    _entry: PluginEntry,
    chan: Arc<Channel>,
    audio: Option<AudioThread>,
    sr: f64,
    max_frames: u32,
    ports: Ports,
    params: Option<PluginParams>,
    state: Option<PluginState>,
    gui: Option<PluginGui>,
    gui_cfg: Option<GuiConfiguration<'static>>,
    latency: Option<PluginLatency>,
    gui_params: Option<rtrb::Consumer<(u32, f64)>>,
    editor: Option<Editor>,
}

impl ClapInstance {
    pub fn load(a: &LoadArgs) -> Result<ClapInstance, String> {
        // SAFETY: loading foreign code is what this process exists for; a
        // crash here takes down only the plugin host.
        let entry = unsafe { PluginEntry::load(&a.path) }.map_err(|e| format!("couldn't load {}: {e}", a.path))?;
        let name = {
            let f = entry.get_plugin_factory().ok_or("the file has no CLAP plugin factory")?;
            let d = f
                .plugin_descriptors()
                .find(|d| d.id().map(|i| i.to_bytes() == a.plugin_id.as_bytes()).unwrap_or(false))
                .ok_or_else(|| format!("plugin '{}' is no longer in {}", a.plugin_id, a.path))?;
            d.name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| a.plugin_id.clone())
        };
        let mut instance = new_instance(&entry, &a.plugin_id)?;
        let effect = a.kind != "instrument";
        let (ports, params, state, gui, latency, gui_cfg) = {
            let mut h = instance.plugin_handle();
            let ports = discover_ports(&mut h, effect);
            let gui_cfg = gui_support(&mut h);
            (ports, h.get_extension::<PluginParams>(), h.get_extension::<PluginState>(), h.get_extension::<PluginGui>(), h.get_extension::<PluginLatency>(), gui_cfg)
        };
        let mut me = ClapInstance {
            id: a.inst,
            name,
            instance,
            _entry: entry,
            chan: a.chan.clone(),
            audio: None,
            sr: a.sample_rate,
            max_frames: a.max_frames,
            ports,
            params,
            state,
            gui,
            gui_cfg,
            latency,
            gui_params: None,
            editor: None,
        };
        me.activate()?;
        Ok(me)
    }

    fn activate(&mut self) -> Result<(), String> {
        let cfg = PluginAudioConfiguration { sample_rate: self.sr, min_frames_count: 1, max_frames_count: self.max_frames };
        let stopped = self.instance.activate(|_, _| (), cfg).map_err(|e| format!("{} failed to activate: {e}", self.name))?;
        // `latency.changed` during activate is expected: we re-read it right here.
        self.instance.access_shared_handler(|s| s.latency_changed.store(false, Release));
        let lat = match self.latency {
            Some(l) => l.get(&mut self.instance.plugin_handle()),
            None => 0,
        };
        self.chan.map.block().latency.store(lat, Relaxed);
        let max = self.max_frames as usize;
        let ins: usize = self.ports.inputs.iter().map(|&c| c as usize).sum();
        let outs: usize = self.ports.outputs.iter().map(|&c| c as usize).sum();
        let (tx, rx) = rtrb::RingBuffer::new(1024);
        let proc = ClapProc {
            proc: stopped.into(),
            ports: self.ports.clone(),
            max,
            in_ports: AudioPorts::with_capacity(ins.max(1), self.ports.inputs.len().max(1)),
            out_ports: AudioPorts::with_capacity(outs.max(1), self.ports.outputs.len().max(1)),
            scratch_in: vec![0.0; ins.max(1) * max],
            scratch_out: vec![0.0; outs.max(1) * max],
            mono: vec![0.0; max],
            ev_in: EventBuffer::with_capacity(2048),
            ev_out: EventBuffer::with_capacity(1024),
            gui_params: tx,
            params: self.params,
            steady: 0,
        };
        let id = self.id;
        self.gui_params = Some(rx);
        self.audio = Some(AudioThread::spawn(
            &format!("clap-{id}"),
            self.chan.clone(),
            Box::new(proc),
            Box::new(move |msg| wire::event(json!({ "event": "pluginError", "inst": id, "message": msg }))),
        ));
        Ok(())
    }

    fn deactivate(&mut self) {
        if let Some(a) = self.audio.take() {
            drop(a.stop());
        }
        let _ = self.instance.try_deactivate();
    }

    fn handle(&mut self) -> PluginMainThreadHandle<'_> {
        self.instance.plugin_handle()
    }

    fn destroy_gui(&mut self) {
        if let Some(ed) = self.editor.take() {
            if let Some(gui) = self.gui {
                let mut h = self.instance.plugin_handle();
                let _ = gui.hide(&mut h);
                gui.destroy(&mut h);
            }
            if let Some(c) = ed.container {
                win::destroy(c);
            }
        }
    }
}

impl Hosted for ClapInstance {
    fn name(&self) -> &str {
        &self.name
    }

    fn has_editor(&self) -> bool {
        self.gui_cfg.is_some()
    }

    fn get_state(&mut self) -> Result<Vec<u8>, String> {
        let st = self.state.ok_or_else(|| format!("{} doesn't support saving its state", self.name))?;
        let mut data = Vec::new();
        st.save(&mut self.handle(), &mut data).map_err(|e| format!("{e}"))?;
        Ok(data)
    }

    fn set_state(&mut self, data: &[u8]) -> Result<(), String> {
        let st = self.state.ok_or_else(|| format!("{} doesn't support restoring state", self.name))?;
        let mut r = std::io::Cursor::new(data);
        st.load(&mut self.handle(), &mut r).map_err(|e| format!("{e}"))
    }

    fn open_editor(&mut self, owner: HWND, title: &str) -> Result<(), String> {
        if let Some(ed) = &self.editor {
            if let Some(c) = ed.container {
                win::show(c);
            }
            return Ok(());
        }
        let gui = self.gui.ok_or("no GUI")?;
        let cfg = self.gui_cfg.ok_or("no supported GUI API")?;
        let id = self.id;
        let mut h = self.instance.plugin_handle();
        gui.create(&mut h, cfg).map_err(|e| format!("the plugin couldn't create its editor: {e}"))?;
        if cfg.is_floating {
            if !owner.is_null() {
                // SAFETY: the owner HWND stays valid while the app runs.
                let _ = unsafe { gui.set_transient(&mut h, ClapWindow::from_win32_hwnd(owner as *mut core::ffi::c_void)) };
            }
            if let Ok(t) = CString::new(title) {
                gui.suggest_title(&mut h, &t);
            }
            if let Err(e) = gui.show(&mut h) {
                gui.destroy(&mut h);
                return Err(format!("the plugin couldn't show its editor: {e}"));
            }
            self.editor = Some(Editor { container: None, resizable: false });
            return Ok(());
        }
        let resizable = gui.can_resize(&mut h);
        let initial = gui.get_size(&mut h).unwrap_or(GuiSize { width: 640, height: 480 });
        let container = match win::create_container(owner, title, initial.width.max(64), initial.height.max(48), resizable, id) {
            Ok(c) => c,
            Err(e) => {
                gui.destroy(&mut h);
                return Err(e);
            }
        };
        let scale = win::scale(container);
        let size = if (scale - 1.0).abs() > 0.01 && gui.set_scale(&mut h, scale).is_ok() {
            gui.get_size(&mut h).unwrap_or(initial)
        } else {
            initial
        };
        win::set_client_size(container, size.width.max(64), size.height.max(48));
        // SAFETY: the container outlives the embedded GUI (destroyed after gui.destroy).
        if let Err(e) = unsafe { gui.set_parent(&mut h, ClapWindow::from_win32_hwnd(container as *mut core::ffi::c_void)) } {
            gui.destroy(&mut h);
            win::destroy(container);
            return Err(format!("the plugin couldn't attach its editor: {e}"));
        }
        let _ = gui.show(&mut h);
        win::show(container);
        self.editor = Some(Editor { container: Some(container), resizable });
        Ok(())
    }

    fn close_editor(&mut self) {
        self.destroy_gui();
    }

    fn editor_open(&self) -> bool {
        self.editor.is_some()
    }

    fn editor_resized(&mut self, w: u32, hgt: u32) {
        let Some(ed) = &self.editor else { return };
        if !ed.resizable || w == 0 || hgt == 0 {
            return;
        }
        let container = ed.container;
        let Some(gui) = self.gui else { return };
        let mut h = self.instance.plugin_handle();
        let want = GuiSize { width: w, height: hgt };
        let size = gui.adjust_size(&mut h, want).unwrap_or(want);
        let _ = gui.set_size(&mut h, size);
        if size != want {
            if let Some(c) = container {
                win::set_client_size(c, size.width, size.height);
            }
        }
    }

    fn set_sample_rate(&mut self, sr: f64) -> Result<(), String> {
        if (sr - self.sr).abs() < 0.5 {
            return Ok(());
        }
        self.deactivate();
        self.sr = sr;
        self.activate()
    }

    fn tick(&mut self) {
        let (cb, restart, closed, resize, lat) = self.instance.access_shared_handler(|s| {
            (
                s.callback.swap(false, AcqRel),
                s.restart.swap(false, AcqRel),
                s.gui_closed.swap(false, AcqRel),
                s.resize.lock().unwrap_or_else(|e| e.into_inner()).take(),
                s.latency_changed.swap(false, AcqRel),
            )
        });
        if cb {
            self.instance.call_on_main_thread_callback();
        }
        if let Some(rx) = self.gui_params.as_mut() {
            while let Ok((pid, value)) = rx.pop() {
                wire::event(json!({ "event": "param", "inst": self.id, "paramId": pid, "value": value }));
            }
        }
        if closed && self.editor.is_some() {
            // The plugin closed its own window.
            if let Some(ed) = self.editor.take() {
                if let Some(gui) = self.gui {
                    gui.destroy(&mut self.instance.plugin_handle());
                }
                if let Some(c) = ed.container {
                    win::destroy(c);
                }
            }
            wire::event(json!({ "event": "editorClosed", "inst": self.id }));
        }
        if let (Some(size), Some(ed)) = (resize, &self.editor) {
            if let Some(c) = ed.container {
                win::set_client_size(c, size.width, size.height);
            }
        }
        if let Some(ed) = &self.editor {
            if let Some(c) = ed.container {
                if !win::is_window(c) {
                    self.editor = None;
                }
            }
        }
        if restart {
            // Restart (e.g. latency change): re-activate between blocks.
            self.deactivate();
            if let Err(e) = self.activate() {
                wire::event(json!({ "event": "pluginError", "inst": self.id, "message": e }));
            }
        } else if lat && self.audio.is_some() {
            if let Some(l) = self.latency {
                let v = l.get(&mut self.instance.plugin_handle());
                self.chan.map.block().latency.store(v, Relaxed);
            }
        }
    }

    fn shutdown(&mut self) {
        self.destroy_gui();
        self.deactivate();
    }
}

impl Drop for ClapInstance {
    fn drop(&mut self) {
        self.destroy_gui();
        self.deactivate();
    }
}
