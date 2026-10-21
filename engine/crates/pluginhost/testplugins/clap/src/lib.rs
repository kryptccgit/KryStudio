//! Krypt Studio test CLAP bundle (NOT shipped; used by the plugin-host
//! end-to-end tests). Structure follows the MIT/Apache clack-plugin
//! examples.
//!
//! - `cc.krypt.test.gain`  stereo gain effect. Params: 1 Gain (0..2, ×),
//!   98 Hang (spins forever in process when on), 99 Crash (aborts the
//!   process when on). State = gain. Win32 GUI: click/drag sets the gain
//!   (reported to the host as output param events).
//! - `cc.krypt.test.sine`  polyphonic sine/square/saw instrument. Params:
//!   1 Level (0..1), 2 Waveform (enum). State = both.

#![allow(clippy::missing_safety_doc)]

use clack_extensions::audio_ports::*;
use clack_extensions::gui::*;
use clack_extensions::note_ports::*;
use clack_extensions::params::*;
use clack_extensions::state::{PluginState, PluginStateImpl};
use clack_plugin::events::spaces::CoreEventSpace;
use clack_plugin::entry::prelude::*;
use clack_plugin::events::event_types::ParamValueEvent;
use clack_plugin::prelude::*;
use clack_plugin::stream::{InputStream, OutputStream};
use std::cell::Cell;
use std::ffi::CStr;
use std::fmt::Write as _;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::*};
use std::sync::Arc;

pub struct AtomicF32(AtomicU32);
impl AtomicF32 {
    pub fn new(v: f32) -> Self {
        Self(AtomicU32::new(v.to_bits()))
    }
    pub fn get(&self) -> f32 {
        f32::from_bits(self.0.load(Relaxed))
    }
    pub fn set(&self, v: f32) {
        self.0.store(v.to_bits(), Relaxed)
    }
}

// ═════════════════════════════ Gain ═════════════════════════════════════

const P_GAIN: u32 = 1;
const P_HANG: u32 = 98;
const P_CRASH: u32 = 99;

pub struct GainParams {
    gain: AtomicF32,
    hang: AtomicBool,
    crash: AtomicBool,
    /// Set by the GUI: report the gain to the host on the next process.
    gui_changed: AtomicBool,
}

impl GainParams {
    fn set(&self, id: u32, v: f64) {
        match id {
            P_GAIN => self.gain.set((v as f32).clamp(0.0, 2.0)),
            P_HANG => self.hang.store(v >= 0.5, Relaxed),
            P_CRASH => self.crash.store(v >= 0.5, Relaxed),
            _ => {}
        }
    }
    fn handle(&self, e: &UnknownEvent) {
        if let Some(CoreEventSpace::ParamValue(p)) = e.as_core_event() {
            if let Some(id) = p.param_id() {
                self.set(id.get(), p.value());
            }
        }
    }
}

pub struct GainPlugin;

pub struct GainShared {
    params: Arc<GainParams>,
}
impl PluginShared<'_> for GainShared {}

pub struct GainMain<'a> {
    shared: &'a GainShared,
    gui: Cell<Option<gui::GuiWindow>>,
}
impl<'a> PluginMainThread<'a, GainShared> for GainMain<'a> {}

impl Plugin for GainPlugin {
    type AudioProcessor<'a> = GainAudio<'a>;
    type Shared<'a> = GainShared;
    type MainThread<'a> = GainMain<'a>;

    fn declare_extensions(builder: &mut PluginExtensions<Self>, _shared: Option<&GainShared>) {
        builder.register::<PluginAudioPorts>().register::<PluginParams>().register::<PluginState>().register::<PluginGui>();
    }
}

pub struct GainAudio<'a> {
    shared: &'a GainShared,
}

impl<'a> PluginAudioProcessor<'a, GainShared, GainMain<'a>> for GainAudio<'a> {
    fn activate(_host: HostAudioProcessorHandle<'a>, _main: &GainMain<'a>, shared: &'a GainShared, _cfg: PluginAudioConfiguration) -> Result<Self, PluginError> {
        Ok(Self { shared })
    }

    fn process(&mut self, _process: Process, mut audio: Audio, events: Events) -> Result<ProcessStatus, PluginError> {
        let params = &self.shared.params;
        if params.gui_changed.swap(false, AcqRel) {
            let _ = events.output.try_push(ParamValueEvent::new(0, ClapId::new(P_GAIN), Pckn::match_all(), params.gain.get() as f64));
        }
        let mut port = audio.port_pair(0).ok_or(PluginError::Message("no ports"))?;
        let mut chans = port.channels()?.into_f32().ok_or(PluginError::Message("expected f32"))?;
        let total = chans.frames_count() as usize;
        for batch in events.input.batch() {
            for e in batch.events() {
                params.handle(e);
            }
            if params.crash.load(Relaxed) {
                // Deliberate crash for the host's crash-isolation tests.
                std::process::abort();
            }
            while params.hang.load(Relaxed) {
                std::hint::spin_loop();
            }
            let g = params.gain.get();
            let range = batch.first_sample().min(total)..batch.next_batch_first_sample().unwrap_or(total).min(total);
            for pair in chans.iter_mut() {
                match pair {
                    ChannelPair::InPlace(b) => b[range.clone()].iter_mut().for_each(|s| *s *= g),
                    ChannelPair::InputOutput(i, o) => {
                        for k in range.clone() {
                            o[k] = i[k] * g;
                        }
                    }
                    ChannelPair::OutputOnly(o) => o[range.clone()].fill(0.0),
                    ChannelPair::InputOnly(_) => {}
                }
            }
        }
        Ok(ProcessStatus::ContinueIfNotQuiet)
    }
}

impl PluginAudioProcessorParams for GainAudio<'_> {
    fn flush(&mut self, input: &InputEvents, output: &mut OutputEvents) {
        for e in input {
            self.shared.params.handle(e);
        }
        if self.shared.params.gui_changed.swap(false, AcqRel) {
            let _ = output.try_push(ParamValueEvent::new(0, ClapId::new(P_GAIN), Pckn::match_all(), self.shared.params.gain.get() as f64));
        }
    }
}

impl PluginAudioPortsImpl for GainMain<'_> {
    fn count(&self, _is_input: bool) -> u32 {
        1
    }
    fn get(&self, index: u32, _is_input: bool, writer: &mut AudioPortInfoWriter) {
        if index == 0 {
            writer.set(&AudioPortInfo {
                id: ClapId::new(0),
                name: b"main",
                channel_count: 2,
                flags: AudioPortFlags::IS_MAIN,
                port_type: Some(AudioPortType::STEREO),
                in_place_pair: None,
            });
        }
    }
}

impl PluginMainThreadParams for GainMain<'_> {
    fn count(&self) -> u32 {
        3
    }
    fn get_info(&self, index: u32, info: &mut ParamInfoWriter) {
        let (id, name, max, def, flags): (u32, &[u8], f64, f64, ParamInfoFlags) = match index {
            0 => (P_GAIN, b"Gain", 2.0, 1.0, ParamInfoFlags::IS_AUTOMATABLE),
            1 => (P_HANG, b"Hang (test)", 1.0, 0.0, ParamInfoFlags::IS_STEPPED),
            2 => (P_CRASH, b"Crash (test)", 1.0, 0.0, ParamInfoFlags::IS_STEPPED),
            _ => return,
        };
        info.set(&ParamInfo { id: id.into(), flags, cookie: Default::default(), name, module: b"", min_value: 0.0, max_value: max, default_value: def });
    }
    fn get_value(&self, id: ClapId) -> Option<f64> {
        let p = &self.shared.params;
        match id.get() {
            P_GAIN => Some(p.gain.get() as f64),
            P_HANG => Some(p.hang.load(Relaxed) as u8 as f64),
            P_CRASH => Some(p.crash.load(Relaxed) as u8 as f64),
            _ => None,
        }
    }
    fn value_to_text(&self, id: ClapId, value: f64, w: &mut ParamDisplayWriter) -> std::fmt::Result {
        match id.get() {
            P_GAIN => write!(w, "{:.2} x", value),
            P_HANG | P_CRASH => write!(w, "{}", if value >= 0.5 { "On" } else { "Off" }),
            _ => Err(std::fmt::Error),
        }
    }
    fn text_to_value(&self, _id: ClapId, text: &CStr) -> Option<f64> {
        text.to_str().ok()?.trim().trim_end_matches('x').trim().parse().ok()
    }
    fn flush(&self, input: &InputEvents, _output: &mut OutputEvents) {
        for e in input {
            self.shared.params.handle(e);
        }
    }
}

impl PluginStateImpl for GainMain<'_> {
    fn save(&self, output: &mut OutputStream) -> Result<(), PluginError> {
        output.write_all(b"KGAN")?;
        output.write_all(&self.shared.params.gain.get().to_le_bytes())?;
        Ok(())
    }
    fn load(&self, input: &mut InputStream) -> Result<(), PluginError> {
        let mut b = [0u8; 8];
        input.read_exact(&mut b)?;
        if &b[..4] != b"KGAN" {
            return Err(PluginError::Message("not a Krypt Test Gain state"));
        }
        self.shared.params.gain.set(f32::from_le_bytes([b[4], b[5], b[6], b[7]]).clamp(0.0, 2.0));
        Ok(())
    }
}

impl PluginGuiImpl for GainMain<'_> {
    fn is_api_supported(&self, cfg: GuiConfiguration) -> bool {
        Some(cfg.api_type) == GuiApiType::default_for_current_platform() && !cfg.is_floating
    }
    fn get_preferred_api(&self) -> Option<GuiConfiguration<'_>> {
        Some(GuiConfiguration { api_type: GuiApiType::default_for_current_platform()?, is_floating: false })
    }
    fn create(&self, cfg: GuiConfiguration) -> Result<(), PluginError> {
        if cfg.is_floating {
            return Err(PluginError::Message("floating windows are not supported"));
        }
        Ok(())
    }
    fn destroy(&self) {
        if let Some(w) = self.gui.take() {
            w.close();
        }
    }
    fn set_scale(&self, _scale: f64) -> Result<(), PluginError> {
        Ok(())
    }
    fn get_size(&self) -> Option<GuiSize> {
        Some(GuiSize { width: gui::W, height: gui::H })
    }
    fn set_size(&self, _size: GuiSize) -> Result<(), PluginError> {
        Ok(())
    }
    fn set_parent(&self, window: Window) -> Result<(), PluginError> {
        let parent = window.as_win32_hwnd().ok_or(PluginError::Message("not a Win32 window"))?;
        let w = gui::GuiWindow::open(parent, self.shared.params.clone()).ok_or(PluginError::Message("CreateWindow failed"))?;
        if let Some(old) = self.gui.replace(Some(w)) {
            old.close();
        }
        Ok(())
    }
    fn set_transient(&self, _window: Window) -> Result<(), PluginError> {
        Ok(())
    }
    fn show(&self) -> Result<(), PluginError> {
        Ok(())
    }
    fn hide(&self) -> Result<(), PluginError> {
        Ok(())
    }
}

mod gui {
    //! A tiny GDI editor: a bar showing the gain; click/drag to set it.
    use super::GainParams;
    use std::sync::atomic::Ordering::*;
    use std::sync::Arc;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    pub const W: u32 = 360;
    pub const H: u32 = 140;

    pub struct GuiWindow(HWND);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn params(hwnd: HWND) -> Option<&'static GainParams> {
        let p = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const GainParams;
        if p.is_null() {
            None
        } else {
            Some(&*p)
        }
    }

    unsafe fn set_from_x(hwnd: HWND, x: i32) {
        if let Some(p) = params(hwnd) {
            let mut r: RECT = std::mem::zeroed();
            GetClientRect(hwnd, &mut r);
            let t = ((x - 20) as f32 / (r.right - 40).max(1) as f32).clamp(0.0, 1.0);
            p.gain.set(t * 2.0);
            p.gui_changed.store(true, Release);
            InvalidateRect(hwnd, std::ptr::null(), 0);
        }
    }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            WM_TIMER => {
                InvalidateRect(hwnd, std::ptr::null(), 0);
                0
            }
            WM_LBUTTONDOWN => {
                SetCapture(hwnd);
                set_from_x(hwnd, (lp & 0xFFFF) as i16 as i32);
                0
            }
            WM_MOUSEMOVE => {
                if wp & 0x0001 != 0 {
                    set_from_x(hwnd, (lp & 0xFFFF) as i16 as i32);
                }
                0
            }
            WM_LBUTTONUP => {
                ReleaseCapture();
                0
            }
            WM_PAINT => {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let dc = BeginPaint(hwnd, &mut ps);
                let mut r: RECT = std::mem::zeroed();
                GetClientRect(hwnd, &mut r);
                let bg = CreateSolidBrush(0x0019_1214);
                FillRect(dc, &r, bg);
                DeleteObject(bg as _);
                let g = params(hwnd).map(|p| p.gain.get()).unwrap_or(1.0);
                let track = RECT { left: 20, top: 70, right: r.right - 20, bottom: 100 };
                let tb = CreateSolidBrush(0x0030_2828);
                FillRect(dc, &track, tb);
                DeleteObject(tb as _);
                let fill = RECT { left: 20, top: 70, right: 20 + ((track.right - 20) as f32 * (g / 2.0)) as i32, bottom: 100 };
                let fb = CreateSolidBrush(0x00F7_5C8B); // indigo-ish
                FillRect(dc, &fill, fb);
                DeleteObject(fb as _);
                SetBkMode(dc, TRANSPARENT as _);
                SetTextColor(dc, 0x00FF_FFFF);
                let t = wide(&format!("Krypt Test Gain   {:.2} x", g));
                TextOutW(dc, 20, 30, t.as_ptr(), (t.len() - 1) as i32);
                EndPaint(hwnd, &ps);
                0
            }
            WM_DESTROY => {
                KillTimer(hwnd, 1);
                let p = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) as *const GainParams;
                if !p.is_null() {
                    drop(Arc::from_raw(p));
                }
                0
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }

    impl GuiWindow {
        pub fn open(parent: *mut core::ffi::c_void, params: Arc<GainParams>) -> Option<GuiWindow> {
            unsafe {
                let class = wide("KryptTestGainGui");
                let hinst = GetModuleHandleW(std::ptr::null());
                let wc = WNDCLASSW {
                    style: CS_HREDRAW | CS_VREDRAW,
                    lpfnWndProc: Some(proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: hinst,
                    hIcon: std::ptr::null_mut(),
                    hCursor: LoadCursorW(std::ptr::null_mut(), IDC_HAND),
                    hbrBackground: std::ptr::null_mut(),
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: class.as_ptr(),
                };
                RegisterClassW(&wc);
                let hwnd = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), WS_CHILD | WS_VISIBLE, 0, 0, W as i32, H as i32, parent as HWND, std::ptr::null_mut(), hinst, std::ptr::null());
                if hwnd.is_null() {
                    return None;
                }
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, Arc::into_raw(params) as isize);
                SetTimer(hwnd, 1, 100, None);
                Some(GuiWindow(hwnd))
            }
        }

        pub fn close(self) {
            unsafe {
                DestroyWindow(self.0);
            }
        }
    }
}

// ═════════════════════════════ Sine ═════════════════════════════════════

const P_LEVEL: u32 = 1;
const P_WAVE: u32 = 2;

pub struct SineParams {
    level: AtomicF32,
    wave: AtomicU32,
}

impl SineParams {
    fn handle(&self, e: &UnknownEvent) {
        if let Some(CoreEventSpace::ParamValue(p)) = e.as_core_event() {
            match p.param_id().map(|i| i.get()) {
                Some(P_LEVEL) => self.level.set((p.value() as f32).clamp(0.0, 1.0)),
                Some(P_WAVE) => self.wave.store((p.value().round() as u32).min(2), Relaxed),
                _ => {}
            }
        }
    }
}

pub struct SinePlugin;
pub struct SineShared {
    params: SineParams,
}
impl PluginShared<'_> for SineShared {}
pub struct SineMain<'a> {
    shared: &'a SineShared,
}
impl<'a> PluginMainThread<'a, SineShared> for SineMain<'a> {}

impl Plugin for SinePlugin {
    type AudioProcessor<'a> = SineAudio<'a>;
    type Shared<'a> = SineShared;
    type MainThread<'a> = SineMain<'a>;

    fn declare_extensions(builder: &mut PluginExtensions<Self>, _shared: Option<&SineShared>) {
        builder.register::<PluginAudioPorts>().register::<PluginNotePorts>().register::<PluginParams>().register::<PluginState>();
    }
}

#[derive(Clone, Copy, Default)]
struct Voice {
    key: i16,
    phase: f32,
    inc: f32,
    amp: f32,
    /// 1 while held, decays after release.
    env: f32,
    releasing: bool,
}

pub struct SineAudio<'a> {
    shared: &'a SineShared,
    voices: [Voice; 16],
    sr: f32,
}

impl SineAudio<'_> {
    fn note_on(&mut self, key: i16, vel: f32) {
        let slot = self.voices.iter().position(|v| v.env <= 0.0).unwrap_or(0);
        let f = 440.0 * 2f32.powf((key as f32 - 69.0) / 12.0);
        self.voices[slot] = Voice { key, phase: 0.0, inc: f / self.sr, amp: vel, env: 1.0, releasing: false };
    }
    fn note_off(&mut self, key: i16) {
        for v in self.voices.iter_mut() {
            if v.key == key && v.env > 0.0 {
                v.releasing = true;
            }
        }
    }
}

impl<'a> PluginAudioProcessor<'a, SineShared, SineMain<'a>> for SineAudio<'a> {
    fn activate(_host: HostAudioProcessorHandle<'a>, _main: &SineMain<'a>, shared: &'a SineShared, cfg: PluginAudioConfiguration) -> Result<Self, PluginError> {
        Ok(Self { shared, voices: [Voice::default(); 16], sr: cfg.sample_rate as f32 })
    }

    fn process(&mut self, _process: Process, mut audio: Audio, events: Events) -> Result<ProcessStatus, PluginError> {
        let mut port = audio.output_port(0).ok_or(PluginError::Message("no output"))?;
        let mut chans = port.channels()?.into_f32().ok_or(PluginError::Message("expected f32"))?;
        let n = chans.frames_count() as usize;
        let mut buf = [0f32; 4096];
        let n = n.min(buf.len());
        for batch in events.input.batch() {
            for e in batch.events() {
                match e.as_core_event() {
                    Some(CoreEventSpace::NoteOn(ev)) => {
                        if let Some(k) = ev.pckn().key.into_specific() {
                            self.note_on(k as i16, ev.velocity() as f32);
                        }
                    }
                    Some(CoreEventSpace::NoteOff(ev)) => {
                        if let Some(k) = ev.pckn().key.into_specific() {
                            self.note_off(k as i16);
                        }
                    }
                    Some(CoreEventSpace::NoteChoke(_)) => self.voices.iter_mut().for_each(|v| v.releasing = true),
                    _ => self.shared.params.handle(e),
                }
            }
            let level = self.shared.params.level.get();
            let wave = self.shared.params.wave.load(Relaxed);
            let rel = 1.0 / (0.01 * self.sr);
            for i in batch.first_sample()..batch.next_batch_first_sample().unwrap_or(n) {
                if i >= n {
                    break;
                }
                let mut s = 0.0;
                for v in self.voices.iter_mut() {
                    if v.env <= 0.0 {
                        continue;
                    }
                    let x = match wave {
                        1 => if v.phase < 0.5 { 1.0 } else { -1.0 },
                        2 => 2.0 * v.phase - 1.0,
                        _ => (v.phase * std::f32::consts::TAU).sin(),
                    };
                    s += x * v.amp * v.env;
                    v.phase = (v.phase + v.inc).fract();
                    if v.releasing {
                        v.env -= rel;
                    }
                }
                buf[i] = s * level;
            }
        }
        for c in 0..chans.channel_count() {
            if let Some(ch) = chans.channel_mut(c) {
                let m = ch.len().min(n);
                ch[..m].copy_from_slice(&buf[..m]);
            }
        }
        Ok(if self.voices.iter().any(|v| v.env > 0.0) { ProcessStatus::Continue } else { ProcessStatus::Sleep })
    }
}

impl PluginAudioProcessorParams for SineAudio<'_> {
    fn flush(&mut self, input: &InputEvents, _output: &mut OutputEvents) {
        for e in input {
            self.shared.params.handle(e);
        }
    }
}

impl PluginAudioPortsImpl for SineMain<'_> {
    fn count(&self, is_input: bool) -> u32 {
        if is_input { 0 } else { 1 }
    }
    fn get(&self, index: u32, is_input: bool, writer: &mut AudioPortInfoWriter) {
        if !is_input && index == 0 {
            writer.set(&AudioPortInfo { id: ClapId::new(1), name: b"main", channel_count: 2, flags: AudioPortFlags::IS_MAIN, port_type: Some(AudioPortType::STEREO), in_place_pair: None });
        }
    }
}

impl PluginNotePortsImpl for SineMain<'_> {
    fn count(&self, is_input: bool) -> u32 {
        if is_input { 1 } else { 0 }
    }
    fn get(&self, index: u32, is_input: bool, writer: &mut NotePortInfoWriter) {
        if is_input && index == 0 {
            writer.set(&NotePortInfo { id: ClapId::new(1), name: b"notes", preferred_dialect: Some(NoteDialect::Clap), supported_dialects: NoteDialects::CLAP });
        }
    }
}

impl PluginMainThreadParams for SineMain<'_> {
    fn count(&self) -> u32 {
        2
    }
    fn get_info(&self, index: u32, info: &mut ParamInfoWriter) {
        match index {
            0 => info.set(&ParamInfo { id: P_LEVEL.into(), flags: ParamInfoFlags::IS_AUTOMATABLE, cookie: Default::default(), name: b"Level", module: b"Output", min_value: 0.0, max_value: 1.0, default_value: 0.5 }),
            1 => info.set(&ParamInfo { id: P_WAVE.into(), flags: ParamInfoFlags::IS_AUTOMATABLE | ParamInfoFlags::IS_STEPPED | ParamInfoFlags::IS_ENUM, cookie: Default::default(), name: b"Waveform", module: b"Oscillator", min_value: 0.0, max_value: 2.0, default_value: 0.0 }),
            _ => {}
        }
    }
    fn get_value(&self, id: ClapId) -> Option<f64> {
        match id.get() {
            P_LEVEL => Some(self.shared.params.level.get() as f64),
            P_WAVE => Some(self.shared.params.wave.load(Relaxed) as f64),
            _ => None,
        }
    }
    fn value_to_text(&self, id: ClapId, value: f64, w: &mut ParamDisplayWriter) -> std::fmt::Result {
        match id.get() {
            P_LEVEL => write!(w, "{:.0} %", value * 100.0),
            P_WAVE => write!(w, "{}", ["Sine", "Square", "Saw"][(value.round() as usize).min(2)]),
            _ => Err(std::fmt::Error),
        }
    }
    fn text_to_value(&self, _id: ClapId, _text: &CStr) -> Option<f64> {
        None
    }
    fn flush(&self, input: &InputEvents, _output: &mut OutputEvents) {
        for e in input {
            self.shared.params.handle(e);
        }
    }
}

impl PluginStateImpl for SineMain<'_> {
    fn save(&self, output: &mut OutputStream) -> Result<(), PluginError> {
        output.write_all(b"KSIN")?;
        output.write_all(&self.shared.params.level.get().to_le_bytes())?;
        output.write_all(&self.shared.params.wave.load(Relaxed).to_le_bytes())?;
        Ok(())
    }
    fn load(&self, input: &mut InputStream) -> Result<(), PluginError> {
        let mut b = [0u8; 12];
        input.read_exact(&mut b)?;
        if &b[..4] != b"KSIN" {
            return Err(PluginError::Message("not a Krypt Test Sine state"));
        }
        self.shared.params.level.set(f32::from_le_bytes([b[4], b[5], b[6], b[7]]).clamp(0.0, 1.0));
        self.shared.params.wave.store(u32::from_le_bytes([b[8], b[9], b[10], b[11]]).min(2), Relaxed);
        Ok(())
    }
}

// ═════════════════════════════ Entry ════════════════════════════════════

pub struct TestFactory {
    gain: PluginDescriptor,
    sine: PluginDescriptor,
}

impl PluginFactoryImpl for TestFactory {
    fn plugin_count(&self) -> u32 {
        2
    }
    fn plugin_descriptor(&self, index: u32) -> Option<&PluginDescriptor> {
        match index {
            0 => Some(&self.gain),
            1 => Some(&self.sine),
            _ => None,
        }
    }
    fn create_plugin<'a>(&'a self, host_info: HostInfo<'a>, plugin_id: &CStr) -> Option<PluginInstance<'a>> {
        if plugin_id == self.gain.id().unwrap_or_default() {
            Some(PluginInstance::new::<GainPlugin>(
                host_info,
                &self.gain,
                |_| {
                    Ok(GainShared {
                        params: Arc::new(GainParams { gain: AtomicF32::new(1.0), hang: AtomicBool::new(false), crash: AtomicBool::new(false), gui_changed: AtomicBool::new(false) }),
                    })
                },
                |_, shared| Ok(GainMain { shared, gui: Cell::new(None) }),
            ))
        } else if plugin_id == self.sine.id().unwrap_or_default() {
            Some(PluginInstance::new::<SinePlugin>(
                host_info,
                &self.sine,
                |_| Ok(SineShared { params: SineParams { level: AtomicF32::new(0.5), wave: AtomicU32::new(0) } }),
                |_, shared| Ok(SineMain { shared }),
            ))
        } else {
            None
        }
    }
}

pub struct TestEntry {
    factory: PluginFactoryWrapper<TestFactory>,
}

impl Entry for TestEntry {
    fn new(_bundle_path: Option<&CStr>) -> Result<Self, EntryLoadError> {
        use clack_plugin::plugin::features::*;
        Ok(Self {
            factory: PluginFactoryWrapper::new(TestFactory {
                gain: PluginDescriptor::new("cc.krypt.test.gain", "Krypt Test Gain").with_vendor("Krypt (test)").with_version("1.0.0").with_features([AUDIO_EFFECT, UTILITY, STEREO]),
                sine: PluginDescriptor::new("cc.krypt.test.sine", "Krypt Test Sine").with_vendor("Krypt (test)").with_version("1.0.0").with_features([INSTRUMENT, SYNTHESIZER, STEREO]),
            }),
        })
    }
    fn declare_factories<'a>(&'a self, builder: &mut EntryFactories<'a>) {
        builder.register_factory(&self.factory);
    }
}

clack_export_entry!(TestEntry);
