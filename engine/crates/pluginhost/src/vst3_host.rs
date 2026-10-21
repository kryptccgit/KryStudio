//! VST3 hosting on the `vst3` crate (MIT OR Apache-2.0 bindings generated
//! from the MIT VST 3.8 SDK; NOT vst3-sys, which is GPL). We write the host
//! side ourselves (research/03 §2.2): module loading, class discovery,
//! component/controller wiring, bus setup, processing, state and editors.

#![allow(non_snake_case)]

use crate::audio::{AudioThread, Processor};
use crate::serve::{Hosted, LoadArgs};
use crate::vst3_com::*;
use crate::{win, wire};
use krypt_studio_pluginclient::shm::{ev, flag, Block, Channel, Ev, MAX_FRAMES};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::Ordering::*;
use std::sync::Arc;
use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;
use vst3::{ComPtr, ComWrapper};
use windows_sys::Win32::Foundation::{HMODULE, HWND};
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};

const AUDIO_MODULE_CLASS: &str = "Audio Module Class";

// ── Modules ──────────────────────────────────────────────────────────────

pub struct Module {
    _lib: HMODULE,
    pub factory: ComPtr<IPluginFactory>,
}

thread_local! {
    /// Loaded modules stay loaded for the life of the host (many plugins
    /// misbehave when unloaded and reloaded).
    static MODULES: RefCell<HashMap<PathBuf, Rc<Module>>> = RefCell::new(HashMap::new());
}

/// The DLL inside a `.vst3` bundle folder, or the file itself.
pub fn binary_path(path: &Path) -> Result<PathBuf, String> {
    if path.is_dir() {
        let stem = path.file_stem().ok_or("bad bundle name")?.to_string_lossy().into_owned();
        let bin = path.join("Contents").join("x86_64-win").join(format!("{stem}.vst3"));
        if bin.is_file() {
            return Ok(bin);
        }
        // Some bundles name the inner binary differently: take the only .vst3 there.
        let dir = path.join("Contents").join("x86_64-win");
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().map(|x| x.eq_ignore_ascii_case("vst3")).unwrap_or(false) && p.is_file() {
                    return Ok(p);
                }
            }
        }
        if path.join("Contents").join("x86-win").is_dir() {
            return Err("this is a 32-bit VST3; Krypt Studio hosts 64-bit plugins only".into());
        }
        return Err(format!("no 64-bit binary inside {}", path.display()));
    }
    Ok(path.to_path_buf())
}

pub fn load_module(path: &Path) -> Result<Rc<Module>, String> {
    let bin = binary_path(path)?;
    if let Some(m) = MODULES.with(|m| m.borrow().get(&bin).cloned()) {
        return Ok(m);
    }
    let w = win::wide(&bin.to_string_lossy());
    // SAFETY: loading foreign code is this process's job; crashes stay here.
    let lib = unsafe { LoadLibraryExW(w.as_ptr(), std::ptr::null_mut(), LOAD_WITH_ALTERED_SEARCH_PATH) };
    if lib.is_null() {
        return Err(format!("couldn't load {}: {}", bin.display(), std::io::Error::last_os_error()));
    }
    // SAFETY: optional/required exports with their documented signatures.
    unsafe {
        if let Some(init) = GetProcAddress(lib, c"InitDll".as_ptr() as *const u8) {
            let init: extern "system" fn() -> bool = std::mem::transmute(init);
            if !init() {
                return Err("the plugin's InitDll failed".into());
            }
        }
        let Some(gpf) = GetProcAddress(lib, c"GetPluginFactory".as_ptr() as *const u8) else {
            return Err("not a VST3 module (no GetPluginFactory)".into());
        };
        let gpf: extern "system" fn() -> *mut IPluginFactory = std::mem::transmute(gpf);
        let factory = ComPtr::from_raw(gpf()).ok_or("GetPluginFactory returned nothing")?;
        if let Some(f3) = factory.cast::<IPluginFactory3>() {
            f3.setHostContext(host_context());
        }
        let m = Rc::new(Module { _lib: lib, factory });
        MODULES.with(|mm| mm.borrow_mut().insert(bin, m.clone()));
        Ok(m)
    }
}

pub fn cid_hex(cid: &TUID) -> String {
    cid.iter().map(|b| format!("{:02X}", *b as u8)).collect()
}

pub fn parse_cid(hex: &str) -> Option<TUID> {
    let h: Vec<u8> = hex.bytes().filter(|c| c.is_ascii_hexdigit()).collect();
    if h.len() != 32 {
        return None;
    }
    let mut t: TUID = [0; 16];
    for i in 0..16 {
        let s = std::str::from_utf8(&h[i * 2..i * 2 + 2]).ok()?;
        t[i] = u8::from_str_radix(s, 16).ok()? as std::ffi::c_char;
    }
    Some(t)
}

pub struct ClassInfo {
    pub cid: TUID,
    pub name: String,
    pub vendor: String,
    pub version: String,
    pub sub_categories: Vec<String>,
}

pub fn audio_classes(m: &Module) -> Vec<ClassInfo> {
    let f = &m.factory;
    let mut out = Vec::new();
    // SAFETY: plain factory queries into zeroed out-structs.
    unsafe {
        let mut fi: PFactoryInfo = std::mem::zeroed();
        let fvendor = if f.getFactoryInfo(&mut fi) == kResultOk { cstr(&fi.vendor) } else { String::new() };
        let f2 = f.cast::<IPluginFactory2>();
        for i in 0..f.countClasses() {
            if let Some(f2) = &f2 {
                let mut ci: PClassInfo2 = std::mem::zeroed();
                if f2.getClassInfo2(i, &mut ci) == kResultOk {
                    if cstr(&ci.category) != AUDIO_MODULE_CLASS {
                        continue;
                    }
                    let vendor = cstr(&ci.vendor);
                    out.push(ClassInfo {
                        cid: ci.cid,
                        name: cstr(&ci.name),
                        vendor: if vendor.is_empty() { fvendor.clone() } else { vendor },
                        version: cstr(&ci.version),
                        sub_categories: cstr(&ci.subCategories).split('|').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
                    });
                    continue;
                }
            }
            let mut ci: PClassInfo = std::mem::zeroed();
            if f.getClassInfo(i, &mut ci) != kResultOk || cstr(&ci.category) != AUDIO_MODULE_CLASS {
                continue;
            }
            out.push(ClassInfo { cid: ci.cid, name: cstr(&ci.name), vendor: fvendor.clone(), version: String::new(), sub_categories: Vec::new() });
        }
    }
    out
}

// ── Component + controller wiring ────────────────────────────────────────

pub struct Plugin {
    pub component: ComPtr<IComponent>,
    pub controller: Option<ComPtr<IEditController>>,
    separate: bool,
    connections: Option<(ComPtr<IConnectionPoint>, ComPtr<IConnectionPoint>)>,
}

impl Plugin {
    pub fn create(m: &Module, cid: &TUID) -> Result<Plugin, String> {
        // SAFETY: COM calls following the SDK's hosting sequence.
        unsafe {
            let mut obj: *mut c_void = std::ptr::null_mut();
            let iid = vst3_iid::<IComponent>();
            if m.factory.createInstance(cid.as_ptr(), iid.as_ptr(), &mut obj) != kResultOk || obj.is_null() {
                return Err("the factory couldn't create the component".into());
            }
            let component = ComPtr::from_raw(obj as *mut IComponent).ok_or("null component")?;
            if component.initialize(host_context()) != kResultOk {
                return Err("the component failed to initialize".into());
            }
            let (controller, separate) = match component.cast::<IEditController>() {
                Some(c) => (Some(c), false),
                None => {
                    let mut ccid: TUID = [0; 16];
                    let mut ctl = None;
                    if component.getControllerClassId(&mut ccid) == kResultOk && ccid.iter().any(|&b| b != 0) {
                        let mut o: *mut c_void = std::ptr::null_mut();
                        let iid = vst3_iid::<IEditController>();
                        if m.factory.createInstance(ccid.as_ptr(), iid.as_ptr(), &mut o) == kResultOk && !o.is_null() {
                            if let Some(c) = ComPtr::from_raw(o as *mut IEditController) {
                                if c.initialize(host_context()) == kResultOk {
                                    ctl = Some(c);
                                }
                            }
                        }
                    }
                    (ctl, true)
                }
            };
            let mut p = Plugin { component, controller, separate, connections: None };
            if p.separate {
                if let (Some(a), Some(b)) = (p.component.cast::<IConnectionPoint>(), p.controller.as_ref().and_then(|c| c.cast::<IConnectionPoint>())) {
                    a.connect(b.as_ptr());
                    b.connect(a.as_ptr());
                    p.connections = Some((a, b));
                }
            }
            // Sync the controller with the processor's default state.
            if let Some(ctl) = &p.controller {
                let s = ComWrapper::new(MemoryStream::default());
                if let Some(sp) = s.to_com_ptr::<IBStream>() {
                    if p.component.getState(sp.as_ptr()) == kResultOk {
                        s.seek(0, IBStream_::IStreamSeekMode_::kIBSeekSet as i32, std::ptr::null_mut());
                        ctl.setComponentState(sp.as_ptr());
                    }
                }
            }
            Ok(p)
        }
    }

    pub fn has_editor(&self) -> bool {
        let Some(ctl) = &self.controller else { return false };
        // SAFETY: createView returns an AddRef'd view (or null) that we release.
        unsafe {
            let v = ctl.createView(c"editor".as_ptr());
            match ComPtr::from_raw(v) {
                Some(view) => view.isPlatformTypeSupported(kPlatformTypeHWND) == kResultTrue,
                None => false,
            }
        }
    }

    /// (input buses, output buses, event input buses)
    pub fn bus_counts(&self) -> (i32, i32, i32) {
        // SAFETY: plain queries.
        unsafe {
            (
                self.component.getBusCount(MediaTypes_::kAudio as MediaType, BusDirections_::kInput as BusDirection),
                self.component.getBusCount(MediaTypes_::kAudio as MediaType, BusDirections_::kOutput as BusDirection),
                self.component.getBusCount(MediaTypes_::kEvent as MediaType, BusDirections_::kInput as BusDirection),
            )
        }
    }

    /// ParamSpec-shaped JSON for visible, writable params + per-param step counts.
    pub fn describe_params(&self) -> (Vec<Value>, Vec<(u32, i32)>) {
        let mut out = Vec::new();
        let mut steps = Vec::new();
        let Some(ctl) = &self.controller else { return (out, steps) };
        // SAFETY: plain queries into zeroed structs.
        unsafe {
            let n = ctl.getParameterCount().clamp(0, 4096);
            for i in 0..n {
                let mut pi: ParameterInfo = std::mem::zeroed();
                if ctl.getParameterInfo(i, &mut pi) != kResultOk {
                    continue;
                }
                steps.push((pi.id, pi.stepCount.max(0)));
                let f = pi.flags;
                if f & (ParameterInfo_::ParameterFlags_::kIsHidden | ParameterInfo_::ParameterFlags_::kIsReadOnly) != 0 {
                    continue;
                }
                let mut name = wstr(&pi.title);
                if name.is_empty() {
                    name = format!("Param {}", pi.id);
                }
                let sc = pi.stepCount.max(0);
                let def = pi.defaultNormalizedValue.clamp(0.0, 1.0);
                let mut spec = if sc > 0 {
                    json!({ "id": pi.id.to_string(), "name": name, "min": 0, "max": sc, "default": (def * sc as f64).round(), "unit": "", "scale": "linear", "step": 1 })
                } else {
                    json!({ "id": pi.id.to_string(), "name": name, "min": 0, "max": 1, "default": def, "unit": "", "scale": "linear" })
                };
                spec["automatable"] = json!(f & ParameterInfo_::ParameterFlags_::kCanAutomate != 0);
                if f & ParameterInfo_::ParameterFlags_::kIsBypass != 0 {
                    spec["group"] = json!("Bypass");
                }
                if sc > 0 && sc <= 63 && f & ParameterInfo_::ParameterFlags_::kIsList != 0 {
                    let mut labels = Vec::new();
                    for k in 0..=sc {
                        let mut s: String128 = [0; 128];
                        let t = if ctl.getParamStringByValue(pi.id, k as f64 / sc as f64, &mut s) == kResultOk { wstr(&s) } else { k.to_string() };
                        labels.push(t);
                    }
                    spec["options"] = json!(labels);
                }
                out.push(spec);
            }
        }
        steps.sort();
        (out, steps)
    }
}

impl Drop for Plugin {
    fn drop(&mut self) {
        // SAFETY: SDK teardown order: disconnect, terminate controller, terminate component.
        unsafe {
            if let Some((a, b)) = self.connections.take() {
                a.disconnect(b.as_ptr());
                b.disconnect(a.as_ptr());
            }
            if let Some(c) = &self.controller {
                c.setComponentHandler(std::ptr::null_mut());
                if self.separate {
                    c.terminate();
                }
            }
            self.controller = None;
            self.component.terminate();
        }
    }
}

fn vst3_iid<I: vst3::Interface>() -> TUID {
    let g = I::IID;
    let mut t: TUID = [0; 16];
    for (i, b) in g.iter().enumerate() {
        t[i] = *b as std::ffi::c_char;
    }
    t
}

fn arrangement_channels(a: SpeakerArrangement) -> usize {
    (a as u64).count_ones() as usize
}

// ── Audio side ───────────────────────────────────────────────────────────

struct Bus {
    channels: usize,
    main: bool,
}

struct Vst3Proc {
    proc: ComPtr<IAudioProcessor>,
    ins: Vec<Bus>,
    outs: Vec<Bus>,
    in_bufs: Vec<AudioBusBuffers>,
    out_bufs: Vec<AudioBusBuffers>,
    in_ptrs: Vec<*mut f32>,
    out_ptrs: Vec<*mut f32>,
    scratch_in: Vec<f32>,
    scratch_out: Vec<f32>,
    mono: Vec<f32>,
    max: usize,
    params_in: ComWrapper<ParamChanges>,
    params_out: ComWrapper<ParamChanges>,
    events: ComWrapper<EventList>,
    has_events: bool,
    held: [bool; 128],
    steps: Arc<Vec<(u32, i32)>>,
    /// GUI edits → processor.
    from_ui: rtrb::Consumer<(u32, f64)>,
    /// Engine/processor values → controller (UI thread).
    to_ui: rtrb::Producer<(u32, f64)>,
    ctx: ProcessContext,
    mode: i32,
    samples: i64,
}

// SAFETY: moved to the audio thread once; every COM object inside is then
// used only from that thread.
unsafe impl Send for Vst3Proc {}

impl Vst3Proc {
    fn steps_of(&self, id: u32) -> i32 {
        match self.steps.binary_search_by_key(&id, |s| s.0) {
            Ok(i) => self.steps[i].1,
            Err(_) => 0,
        }
    }
}

impl Processor for Vst3Proc {
    fn started(&mut self) {
        // SAFETY: SDK: setProcessing(true) before the first process call.
        unsafe { self.proc.setProcessing(1) };
    }

    fn stopping(&mut self) {
        // SAFETY: matching setProcessing(false).
        unsafe { self.proc.setProcessing(0) };
    }

    fn process(&mut self, blk: *mut Block, events: &[Ev]) -> Result<(), ()> {
        // SAFETY: the audio thread owns the block for this call.
        let b = unsafe { &mut *blk };
        let n = (b.frames as usize).min(self.max);
        if n == 0 {
            return Ok(());
        }
        self.params_in.clear();
        self.params_out.clear();
        self.events.clear();
        while let Ok((id, v)) = self.from_ui.pop() {
            self.params_in.add(id, 0, v);
        }
        let last = (n - 1) as i32;
        let note = |kind: u16, offset: i32, key: u32, vel: f64, tuning: f64| -> Event {
            // SAFETY: plain-old-data union init.
            let mut e: Event = unsafe { std::mem::zeroed() };
            e.busIndex = 0;
            e.sampleOffset = offset;
            e.r#type = kind;
            if kind == Event_::EventTypes_::kNoteOnEvent as u16 {
                e.__field0.noteOn = NoteOnEvent { channel: 0, pitch: key as i16, tuning: (tuning * 100.0) as f32, velocity: vel as f32, length: 0, noteId: -1 };
            } else {
                e.__field0.noteOff = NoteOffEvent { channel: 0, pitch: key as i16, velocity: vel as f32, noteId: -1, tuning: 0.0 };
            }
            e
        };
        for e in events {
            let t = (e.offset as i32).min(last);
            match e.kind {
                ev::PARAM => {
                    let sc = self.steps_of(e.id);
                    let norm = if sc > 0 { (e.value / sc as f64).clamp(0.0, 1.0) } else { e.value.clamp(0.0, 1.0) };
                    self.params_in.add(e.id, t, norm);
                    let _ = self.to_ui.push((e.id, norm));
                }
                ev::NOTE_ON if self.has_events => {
                    let k = e.key.min(127);
                    self.held[k as usize] = true;
                    self.events.push(note(Event_::EventTypes_::kNoteOnEvent as u16, t, k, e.value, e.aux));
                }
                ev::NOTE_OFF if self.has_events => {
                    let k = e.key.min(127);
                    self.held[k as usize] = false;
                    self.events.push(note(Event_::EventTypes_::kNoteOffEvent as u16, t, k, e.value, 0.0));
                }
                ev::CHOKE | ev::ALL_OFF if self.has_events => {
                    for k in 0..128u32 {
                        if self.held[k as usize] {
                            self.held[k as usize] = false;
                            self.events.push(note(Event_::EventTypes_::kNoteOffEvent as u16, t, k, 0.0, 0.0));
                        }
                    }
                }
                _ => {}
            }
        }
        // Audio: main buses map onto the shared block, the rest onto scratch.
        let stride = MAX_FRAMES;
        let inp = b.audio_in.as_mut_ptr() as *mut f32;
        let outp = b.audio_out.as_mut_ptr() as *mut f32;
        let mut k = 0;
        for (bi, bus) in self.ins.iter().enumerate() {
            let start = k;
            for c in 0..bus.channels {
                // SAFETY: buffers sized for max frames.
                let p = unsafe {
                    if bus.main && bus.channels == 1 {
                        for i in 0..n {
                            *self.mono.as_mut_ptr().add(i) = 0.5 * (*inp.add(i) + *inp.add(stride + i));
                        }
                        self.mono.as_mut_ptr()
                    } else if bus.main && c < 2 {
                        inp.add(c * stride)
                    } else {
                        let p = self.scratch_in.as_mut_ptr().add(k * self.max);
                        std::ptr::write_bytes(p, 0, n);
                        p
                    }
                };
                self.in_ptrs[k] = p;
                k += 1;
            }
            self.in_bufs[bi].numChannels = bus.channels as i32;
            self.in_bufs[bi].silenceFlags = 0;
            // SAFETY: points into in_ptrs, which outlives the call.
            self.in_bufs[bi].__field0.channelBuffers32 = unsafe { self.in_ptrs.as_mut_ptr().add(start) };
        }
        let mut k = 0;
        for (bi, bus) in self.outs.iter().enumerate() {
            let start = k;
            for c in 0..bus.channels {
                // SAFETY: as above.
                let p = unsafe { if bus.main && c < 2 { outp.add(c * stride) } else { self.scratch_out.as_mut_ptr().add(k * self.max) } };
                // SAFETY: zero before processing (some plugins only add).
                unsafe { std::ptr::write_bytes(p, 0, n) };
                self.out_ptrs[k] = p;
                k += 1;
            }
            self.out_bufs[bi].numChannels = bus.channels as i32;
            self.out_bufs[bi].silenceFlags = 0;
            // SAFETY: as above.
            self.out_bufs[bi].__field0.channelBuffers32 = unsafe { self.out_ptrs.as_mut_ptr().add(start) };
        }
        let playing = b.flags & flag::PLAYING != 0;
        let bpm = if b.bpm.is_finite() && b.bpm > 0.0 { b.bpm } else { 120.0 };
        let beats = if b.beat_pos.is_finite() { b.beat_pos.max(0.0) } else { 0.0 };
        use ProcessContext_::StatesAndFlags_ as SF;
        self.ctx.state = (SF::kTempoValid | SF::kProjectTimeMusicValid | SF::kTimeSigValid | SF::kBarPositionValid | if playing { SF::kPlaying } else { 0 }) as u32;
        self.ctx.sampleRate = b.sample_rate;
        self.ctx.tempo = bpm;
        self.ctx.projectTimeMusic = beats;
        self.ctx.barPositionMusic = (beats / 4.0).floor() * 4.0;
        self.ctx.timeSigNumerator = 4;
        self.ctx.timeSigDenominator = 4;
        self.ctx.projectTimeSamples = (beats * 60.0 / bpm * b.sample_rate) as i64;
        self.ctx.continousTimeSamples = self.samples;
        let mut data = ProcessData {
            processMode: self.mode,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            numSamples: n as i32,
            numInputs: self.in_bufs.len() as i32,
            numOutputs: self.out_bufs.len() as i32,
            inputs: if self.in_bufs.is_empty() { std::ptr::null_mut() } else { self.in_bufs.as_mut_ptr() },
            outputs: if self.out_bufs.is_empty() { std::ptr::null_mut() } else { self.out_bufs.as_mut_ptr() },
            inputParameterChanges: self.params_in.as_com_ref::<IParameterChanges>().map(|r| r.as_ptr()).unwrap_or(std::ptr::null_mut()),
            outputParameterChanges: self.params_out.as_com_ref::<IParameterChanges>().map(|r| r.as_ptr()).unwrap_or(std::ptr::null_mut()),
            inputEvents: if self.has_events { self.events.as_com_ref::<IEventList>().map(|r| r.as_ptr()).unwrap_or(std::ptr::null_mut()) } else { std::ptr::null_mut() },
            outputEvents: std::ptr::null_mut(),
            processContext: &mut self.ctx,
        };
        // SAFETY: every pointer in `data` is valid for this call.
        let r = unsafe { self.proc.process(&mut data) };
        self.samples += n as i64;
        if let Some(mo) = self.outs.iter().position(|o| o.main) {
            if self.outs[mo].channels == 1 {
                // SAFETY: owned block.
                unsafe { std::ptr::copy_nonoverlapping(outp, outp.add(stride), n) };
            }
        }
        let to_ui = &mut self.to_ui;
        self.params_out.for_each_last(|id, v| {
            let _ = to_ui.push((id, v));
        });
        if r == kResultOk {
            Ok(())
        } else {
            Err(())
        }
    }
}

// ── Main-thread instance ─────────────────────────────────────────────────

struct Editor {
    view: ComPtr<IPlugView>,
    container: HWND,
    resizable: bool,
}

pub struct Vst3Instance {
    id: u64,
    name: String,
    plugin: Plugin,
    processor: ComPtr<IAudioProcessor>,
    handler: ComWrapper<ComponentHandler>,
    frame: ComWrapper<PlugFrame>,
    chan: Arc<Channel>,
    audio: Option<AudioThread>,
    sr: f64,
    max_frames: u32,
    realtime: bool,
    steps: Arc<Vec<(u32, i32)>>,
    from_ui_tx: Option<rtrb::Producer<(u32, f64)>>,
    to_ui_rx: Option<rtrb::Consumer<(u32, f64)>>,
    has_editor: bool,
    editor: Option<Editor>,
    active: Cell<bool>,
}

impl Vst3Instance {
    pub fn load(a: &LoadArgs) -> Result<Vst3Instance, String> {
        let m = load_module(Path::new(&a.path))?;
        let cid = parse_cid(&a.plugin_id).ok_or_else(|| format!("bad VST3 class id '{}'", a.plugin_id))?;
        let name = audio_classes(&m).into_iter().find(|c| c.cid == cid).map(|c| c.name).ok_or_else(|| format!("class {} is no longer in {}", a.plugin_id, a.path))?;
        let plugin = Plugin::create(&m, &cid)?;
        let processor = plugin.component.cast::<IAudioProcessor>().ok_or("the component is not an audio processor")?;
        let handler = ComWrapper::new(ComponentHandler { edits: RefCell::new(Vec::new()), restart: Cell::new(0) });
        if let Some(ctl) = &plugin.controller {
            if let Some(h) = handler.as_com_ref::<IComponentHandler>() {
                // SAFETY: the handler outlives the controller (we own both).
                unsafe { ctl.setComponentHandler(h.as_ptr()) };
            }
        }
        let (_, steps) = plugin.describe_params();
        let has_editor = plugin.has_editor();
        let mut me = Vst3Instance {
            id: a.inst,
            name,
            plugin,
            processor,
            handler,
            frame: ComWrapper::new(PlugFrame { container: Cell::new(0) }),
            chan: a.chan.clone(),
            audio: None,
            sr: a.sample_rate,
            max_frames: a.max_frames.min(MAX_FRAMES as u32),
            realtime: a.realtime,
            steps: Arc::new(steps),
            from_ui_tx: None,
            to_ui_rx: None,
            has_editor,
            editor: None,
            active: Cell::new(false),
        };
        me.activate()?;
        Ok(me)
    }

    fn activate(&mut self) -> Result<(), String> {
        let comp = &self.plugin.component;
        let proc = &self.processor;
        let (nin, nout, nev) = self.plugin.bus_counts();
        let mut ins = Vec::new();
        let mut outs = Vec::new();
        // SAFETY: SDK activation sequence: buses → arrangements → setupProcessing → setActive.
        unsafe {
            let mut in_arr: Vec<SpeakerArrangement> = Vec::new();
            let mut out_arr: Vec<SpeakerArrangement> = Vec::new();
            for (dir, count, list, arr) in [(BusDirections_::kInput, nin, &mut ins, &mut in_arr), (BusDirections_::kOutput, nout, &mut outs, &mut out_arr)] {
                for i in 0..count {
                    let mut bi: BusInfo = std::mem::zeroed();
                    comp.getBusInfo(MediaTypes_::kAudio as MediaType, dir as BusDirection, i, &mut bi);
                    let main = bi.busType == BusTypes_::kMain as BusType && !list.iter().any(|b: &Bus| b.main);
                    comp.activateBus(MediaTypes_::kAudio as MediaType, dir as BusDirection, i, if main { 1 } else { 0 });
                    let mut a: SpeakerArrangement = 0;
                    proc.getBusArrangement(dir as BusDirection, i, &mut a);
                    if main {
                        a = SpeakerArr::kStereo;
                    }
                    arr.push(a);
                    list.push(Bus { channels: 0, main });
                }
            }
            for i in 0..nev.min(1) {
                comp.activateBus(MediaTypes_::kEvent as MediaType, BusDirections_::kInput as BusDirection, i, 1);
            }
            let r = proc.setBusArrangements(
                if in_arr.is_empty() { std::ptr::null_mut() } else { in_arr.as_mut_ptr() },
                in_arr.len() as i32,
                if out_arr.is_empty() { std::ptr::null_mut() } else { out_arr.as_mut_ptr() },
                out_arr.len() as i32,
            );
            // Whatever was accepted (stereo, or the plugin's own choice), use it.
            let _ = r;
            for (i, b) in ins.iter_mut().enumerate() {
                let mut a: SpeakerArrangement = 0;
                proc.getBusArrangement(BusDirections_::kInput as BusDirection, i as i32, &mut a);
                b.channels = arrangement_channels(a).max(if b.main { 1 } else { 0 }).min(64);
            }
            for (i, b) in outs.iter_mut().enumerate() {
                let mut a: SpeakerArrangement = 0;
                proc.getBusArrangement(BusDirections_::kOutput as BusDirection, i as i32, &mut a);
                b.channels = arrangement_channels(a).max(if b.main { 1 } else { 0 }).min(64);
            }
            if proc.canProcessSampleSize(SymbolicSampleSizes_::kSample32 as i32) != kResultOk {
                return Err(format!("{} can't process 32-bit float audio", self.name));
            }
            let mode = if self.realtime { ProcessModes_::kRealtime } else { ProcessModes_::kOffline } as i32;
            let mut setup = ProcessSetup { processMode: mode, symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32, maxSamplesPerBlock: self.max_frames as i32, sampleRate: self.sr };
            if proc.setupProcessing(&mut setup) != kResultOk {
                return Err(format!("{} rejected the processing setup ({} Hz)", self.name, self.sr));
            }
            if comp.setActive(1) != kResultOk {
                return Err(format!("{} failed to activate", self.name));
            }
            self.active.set(true);
            self.chan.map.block().latency.store(proc.getLatencySamples(), Relaxed);
            let max = self.max_frames as usize;
            let tin: usize = ins.iter().map(|b| b.channels).sum();
            let tout: usize = outs.iter().map(|b| b.channels).sum();
            let (ftx, frx) = rtrb::RingBuffer::new(1024);
            let (ttx, trx) = rtrb::RingBuffer::new(4096);
            let nin_b = ins.len();
            let nout_b = outs.len();
            let p = Vst3Proc {
                proc: proc.clone(),
                ins,
                outs,
                in_bufs: vec![std::mem::zeroed(); nin_b],
                out_bufs: vec![std::mem::zeroed(); nout_b],
                in_ptrs: vec![std::ptr::null_mut(); tin.max(1)],
                out_ptrs: vec![std::ptr::null_mut(); tout.max(1)],
                scratch_in: vec![0.0; tin.max(1) * max],
                scratch_out: vec![0.0; tout.max(1) * max],
                mono: vec![0.0; max],
                max,
                params_in: ComWrapper::new(ParamChanges::new()),
                params_out: ComWrapper::new(ParamChanges::new()),
                events: ComWrapper::new(EventList::new()),
                has_events: nev > 0,
                held: [false; 128],
                steps: self.steps.clone(),
                from_ui: frx,
                to_ui: ttx,
                ctx: std::mem::zeroed(),
                mode,
                samples: 0,
            };
            self.from_ui_tx = Some(ftx);
            self.to_ui_rx = Some(trx);
            let id = self.id;
            self.audio = Some(AudioThread::spawn(
                &format!("vst3-{id}"),
                self.chan.clone(),
                Box::new(p),
                Box::new(move |msg| wire::event(json!({ "event": "pluginError", "inst": id, "message": msg }))),
            ));
        }
        Ok(())
    }

    fn deactivate(&mut self) {
        if let Some(a) = self.audio.take() {
            drop(a.stop());
        }
        if self.active.replace(false) {
            // SAFETY: matching setActive(true).
            unsafe { self.plugin.component.setActive(0) };
        }
    }

    fn close_view(&mut self) {
        if let Some(ed) = self.editor.take() {
            // SAFETY: SDK teardown: removed() before destroying the parent.
            unsafe {
                ed.view.setFrame(std::ptr::null_mut());
                ed.view.removed();
            }
            drop(ed.view);
            self.frame.container.set(0);
            win::destroy(ed.container);
        }
    }

    fn steps_of(&self, id: u32) -> i32 {
        match self.steps.binary_search_by_key(&id, |s| s.0) {
            Ok(i) => self.steps[i].1,
            Err(_) => 0,
        }
    }
}

impl Hosted for Vst3Instance {
    fn name(&self) -> &str {
        &self.name
    }

    fn has_editor(&self) -> bool {
        self.has_editor
    }

    fn get_state(&mut self) -> Result<Vec<u8>, String> {
        // Blob: "KV3S" + u32 len + component state + u32 len + controller state.
        let cs = ComWrapper::new(MemoryStream::default());
        let ks = ComWrapper::new(MemoryStream::default());
        // SAFETY: plain state calls with our streams.
        unsafe {
            let p = cs.to_com_ptr::<IBStream>().ok_or("stream")?;
            if self.plugin.component.getState(p.as_ptr()) != kResultOk {
                return Err(format!("{} couldn't save its state", self.name));
            }
            if let (Some(ctl), Some(kp)) = (&self.plugin.controller, ks.to_com_ptr::<IBStream>()) {
                if self.plugin.separate {
                    ctl.getState(kp.as_ptr());
                }
            }
        }
        let c = cs.data.borrow();
        let k = ks.data.borrow();
        let mut out = Vec::with_capacity(12 + c.len() + k.len());
        out.extend_from_slice(b"KV3S");
        out.extend_from_slice(&(c.len() as u32).to_le_bytes());
        out.extend_from_slice(&c);
        out.extend_from_slice(&(k.len() as u32).to_le_bytes());
        out.extend_from_slice(&k);
        Ok(out)
    }

    fn set_state(&mut self, data: &[u8]) -> Result<(), String> {
        let (c, k) = if data.len() >= 8 && &data[..4] == b"KV3S" {
            let cl = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
            let c = data.get(8..8 + cl).ok_or("truncated VST3 state")?;
            let rest = &data[8 + cl..];
            let k = if rest.len() >= 4 {
                let kl = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
                rest.get(4..4 + kl).unwrap_or(&[])
            } else {
                &[]
            };
            (c, k)
        } else {
            (data, &[][..])
        };
        // SAFETY: SDK restore order: component.setState, controller.setComponentState, controller.setState.
        unsafe {
            let cs = ComWrapper::new(MemoryStream::from_bytes(c));
            let p = cs.to_com_ptr::<IBStream>().ok_or("stream")?;
            if self.plugin.component.setState(p.as_ptr()) != kResultOk {
                return Err(format!("{} rejected the saved state", self.name));
            }
            if let Some(ctl) = &self.plugin.controller {
                cs.seek(0, IBStream_::IStreamSeekMode_::kIBSeekSet as i32, std::ptr::null_mut());
                ctl.setComponentState(p.as_ptr());
                if !k.is_empty() && self.plugin.separate {
                    let ks = ComWrapper::new(MemoryStream::from_bytes(k));
                    if let Some(kp) = ks.to_com_ptr::<IBStream>() {
                        ctl.setState(kp.as_ptr());
                    }
                }
            }
        }
        Ok(())
    }

    fn open_editor(&mut self, owner: HWND, title: &str) -> Result<(), String> {
        if let Some(ed) = &self.editor {
            win::show(ed.container);
            return Ok(());
        }
        let ctl = self.plugin.controller.as_ref().ok_or("no edit controller")?;
        // SAFETY: SDK editor sequence: createView → isPlatformTypeSupported → setFrame → attached.
        unsafe {
            let view = ComPtr::from_raw(ctl.createView(c"editor".as_ptr())).ok_or_else(|| format!("{} has no editor", self.name))?;
            if view.isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue {
                return Err(format!("{}'s editor doesn't support Windows (HWND)", self.name));
            }
            let mut r: ViewRect = std::mem::zeroed();
            view.getSize(&mut r);
            let (w, h) = ((r.right - r.left).max(64) as u32, (r.bottom - r.top).max(48) as u32);
            let resizable = view.canResize() == kResultTrue;
            let container = win::create_container(owner, title, w, h, resizable, self.id)?;
            if let Some(cs) = view.cast::<IPlugViewContentScaleSupport>() {
                let s = win::scale(container);
                if (s - 1.0).abs() > 0.01 {
                    cs.setContentScaleFactor(s as f32);
                    let mut r2: ViewRect = std::mem::zeroed();
                    if view.getSize(&mut r2) == kResultOk && r2.right > r2.left {
                        r = r2;
                    }
                }
            }
            win::set_client_size(container, (r.right - r.left).max(64) as u32, (r.bottom - r.top).max(48) as u32);
            self.frame.container.set(container as isize);
            if let Some(fp) = self.frame.as_com_ref::<IPlugFrame>() {
                view.setFrame(fp.as_ptr());
            }
            if view.attached(container as *mut c_void, kPlatformTypeHWND) != kResultOk {
                view.setFrame(std::ptr::null_mut());
                self.frame.container.set(0);
                win::destroy(container);
                return Err(format!("{} couldn't attach its editor", self.name));
            }
            win::show(container);
            self.editor = Some(Editor { view, container, resizable });
        }
        Ok(())
    }

    fn close_editor(&mut self) {
        self.close_view();
    }

    fn editor_open(&self) -> bool {
        self.editor.is_some()
    }

    fn editor_resized(&mut self, w: u32, h: u32) {
        let Some(ed) = &self.editor else { return };
        if !ed.resizable || w == 0 || h == 0 {
            return;
        }
        // SAFETY: view is attached; standard size negotiation.
        unsafe {
            let mut cur: ViewRect = std::mem::zeroed();
            ed.view.getSize(&mut cur);
            if (cur.right - cur.left) as u32 == w && (cur.bottom - cur.top) as u32 == h {
                return;
            }
            let mut r = ViewRect { left: 0, top: 0, right: w as i32, bottom: h as i32 };
            ed.view.checkSizeConstraint(&mut r);
            ed.view.onSize(&mut r);
            let (nw, nh) = ((r.right - r.left) as u32, (r.bottom - r.top) as u32);
            if nw != w || nh != h {
                win::set_client_size(ed.container, nw, nh);
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
        // Plugin GUI edits → processor (next block) + engine (doc sync).
        let edits: Vec<(u32, f64)> = self.handler.edits.borrow_mut().drain(..).collect();
        for (id, v) in edits {
            if let Some(tx) = self.from_ui_tx.as_mut() {
                let _ = tx.push((id, v));
            }
            let sc = self.steps_of(id);
            let plain = if sc > 0 { (v * sc as f64).round() } else { v };
            wire::event(json!({ "event": "param", "inst": self.id, "paramId": id, "value": plain }));
        }
        // Engine automation / processor output → controller (keeps the GUI in sync).
        if let (Some(rx), Some(ctl)) = (self.to_ui_rx.as_mut(), self.plugin.controller.as_ref()) {
            while let Ok((id, v)) = rx.pop() {
                // SAFETY: UI-thread controller call.
                unsafe { ctl.setParamNormalized(id, v) };
            }
        }
        if let Some(ed) = &self.editor {
            if !win::is_window(ed.container) {
                // The container vanished (owner destroyed): detach.
                self.close_view();
            }
        }
        let flags = self.handler.restart.replace(0);
        if flags != 0 {
            use RestartFlags_::*;
            if flags & (kLatencyChanged | kReloadComponent | kIoChanged) as i32 != 0 {
                self.deactivate();
                if let Err(e) = self.activate() {
                    wire::event(json!({ "event": "pluginError", "inst": self.id, "message": e }));
                }
            }
        }
    }

    fn shutdown(&mut self) {
        self.close_view();
        self.deactivate();
    }
}

impl Drop for Vst3Instance {
    fn drop(&mut self) {
        self.close_view();
        self.deactivate();
        if let Some(ctl) = &self.plugin.controller {
            // SAFETY: detach our handler before the controller goes away.
            unsafe { ctl.setComponentHandler(std::ptr::null_mut()) };
        }
    }
}

// ── Scanning ─────────────────────────────────────────────────────────────

/// moduleinfo.json is JSON5-ish: strip comments and trailing commas.
fn json5_lite(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let b: Vec<char> = src.chars().collect();
    let mut i = 0;
    let mut in_str = false;
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < b.len() {
                out.push(b[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
        } else if c == '/' && i + 1 < b.len() && b[i + 1] == '/' {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && i + 1 < b.len() && b[i + 1] == '*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else if c == ',' {
            // Drop a trailing comma before } or ].
            let mut j = i + 1;
            while j < b.len() && b[j].is_whitespace() {
                j += 1;
            }
            if j < b.len() && (b[j] == '}' || b[j] == ']') {
                i += 1;
            } else {
                out.push(c);
                i += 1;
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

fn kind_from(sub: &[String], ins: i32, events: i32) -> &'static str {
    if sub.iter().any(|s| s.eq_ignore_ascii_case("Instrument")) {
        "instrument"
    } else if sub.iter().any(|s| s.eq_ignore_ascii_case("Fx")) {
        "effect"
    } else if ins == 0 && events > 0 {
        "instrument"
    } else {
        "effect"
    }
}

fn desc_json(path: &str, cid: &str, name: &str, vendor: &str, version: &str, sub: &[String], kind: &str, params: Vec<Value>, has_editor: bool, from_mi: bool) -> Value {
    json!({
        "id": format!("vst3:{cid}"),
        "name": if name.is_empty() { cid } else { name },
        "vendor": vendor,
        "version": version,
        "kind": kind,
        "category": crate::scan::category_from(sub, kind == "instrument"),
        "description": format!("{} · VST3", if vendor.is_empty() { "Third-party" } else { vendor }),
        "features": sub,
        "format": "vst3",
        "path": path,
        "params": params,
        "hasEditor": has_editor,
        "fromModuleInfo": from_mi,
    })
}

/// moduleinfo.json fast path (no code loaded).
fn from_moduleinfo(path: &Path) -> Option<Vec<Value>> {
    if !path.is_dir() {
        return None;
    }
    let cands = [path.join("Contents").join("Resources").join("moduleinfo.json"), path.join("Contents").join("moduleinfo.json")];
    let file = cands.iter().find(|p| p.is_file())?;
    let text = std::fs::read_to_string(file).ok()?;
    let v: Value = serde_json::from_str(&json5_lite(&text)).ok()?;
    let fvendor = v.pointer("/Factory Info/Vendor").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut out = Vec::new();
    for c in v.get("Classes")?.as_array()? {
        if c.get("Category").and_then(|x| x.as_str()) != Some(AUDIO_MODULE_CLASS) {
            continue;
        }
        let cid: String = c.get("CID").and_then(|x| x.as_str()).unwrap_or("").chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_uppercase();
        if cid.len() != 32 {
            continue;
        }
        let sub: Vec<String> = match c.get("Sub Categories") {
            Some(Value::Array(a)) => a.iter().filter_map(|s| s.as_str().map(String::from)).collect(),
            Some(Value::String(s)) => s.split('|').map(String::from).collect(),
            _ => Vec::new(),
        };
        let vendor = c.get("Vendor").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| fvendor.clone());
        let name = c.get("Name").and_then(|x| x.as_str()).unwrap_or("");
        let version = c.get("Version").and_then(|x| x.as_str()).unwrap_or("");
        let kind = kind_from(&sub, 1, 0);
        out.push(desc_json(&path.to_string_lossy(), &cid, name, &vendor, version, &sub, kind, Vec::new(), false, true));
    }
    Some(out)
}

/// `--scan` for a .vst3: emit the moduleinfo result first (if any), then
/// load the module to read parameters/editor/bus layout.
pub fn scan(path: &str, emit: &mut dyn FnMut(Value)) -> Result<Vec<Value>, String> {
    let p = Path::new(path);
    if let Some(mi) = from_moduleinfo(p) {
        if !mi.is_empty() {
            emit(json!({ "ok": true, "format": "vst3", "path": path, "partial": true, "plugins": mi }));
        }
    }
    let m = load_module(p)?;
    let mut out = Vec::new();
    for c in audio_classes(&m) {
        let cid = cid_hex(&c.cid);
        match Plugin::create(&m, &c.cid) {
            Ok(pl) => {
                let (ins, _outs, evs) = pl.bus_counts();
                let kind = kind_from(&c.sub_categories, ins, evs);
                let (params, _) = pl.describe_params();
                let ed = pl.has_editor();
                out.push(desc_json(path, &cid, &c.name, &c.vendor, &c.version, &c.sub_categories, kind, params, ed, false));
            }
            Err(e) => {
                let mut d = desc_json(path, &cid, &c.name, &c.vendor, &c.version, &c.sub_categories, kind_from(&c.sub_categories, 1, 0), Vec::new(), false, false);
                d["message"] = json!(e);
                out.push(d);
            }
        }
    }
    if out.is_empty() {
        return Err("no audio plugins in this VST3 module".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn json5_lite_strips_comments_and_trailing_commas() {
        let s = r#"{ // c
          "a": [1, 2, ], /* x */ "b": "//not a comment", }"#;
        let v: serde_json::Value = serde_json::from_str(&super::json5_lite(s)).unwrap();
        assert_eq!(v["a"][1], 2);
        assert_eq!(v["b"], "//not a comment");
    }

    #[test]
    fn cid_round_trip() {
        let t = super::parse_cid("4B5259505454455354564733474149AA").unwrap();
        assert_eq!(super::cid_hex(&t), "4B5259505454455354564733474149AA");
    }
}
