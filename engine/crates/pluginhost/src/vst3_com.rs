#![allow(non_snake_case)]

use std::cell::{Cell, RefCell, UnsafeCell};
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;
use vst3::Steinberg::Vst::IAttributeList_::AttrID;
use vst3::{Class, ComRef, ComWrapper, Interface};

pub fn copy_wstring(src: &str, dst: &mut [TChar]) {
    let mut len = 0;
    for (s, d) in src.encode_utf16().zip(dst.iter_mut()) {
        *d = s as TChar;
        len += 1;
    }
    if len < dst.len() {
        dst[len] = 0;
    } else if let Some(last) = dst.last_mut() {
        *last = 0;
    }
}

pub fn wstr(src: &[TChar]) -> String {
    let end = src.iter().position(|&c| c == 0).unwrap_or(src.len());
    String::from_utf16_lossy(&src[..end].iter().map(|&c| c as u16).collect::<Vec<u16>>()).trim().to_string()
}

pub fn cstr(src: &[c_char]) -> String {
    let end = src.iter().position(|&c| c == 0).unwrap_or(src.len());
    String::from_utf8_lossy(&src[..end].iter().map(|&c| c as u8).collect::<Vec<u8>>()).trim().to_string()
}

unsafe fn iid_eq(iid: *const TUID, want: &TUID) -> bool {
    !iid.is_null() && (*iid) == *want
}

fn tuid_of<I: Interface>() -> TUID {
    let g = I::IID;
    let mut t: TUID = [0; 16];
    for (i, b) in g.iter().enumerate() {
        t[i] = *b as c_char;
    }
    t
}

pub struct HostApp;

impl Class for HostApp {
    type Interfaces = (IHostApplication, IPlugInterfaceSupport);
}

impl IHostApplicationTrait for HostApp {
    unsafe fn getName(&self, name: *mut String128) -> tresult {
        if name.is_null() {
            return kInvalidArgument;
        }
        copy_wstring("Krypt Studio", &mut *name);
        kResultOk
    }

    unsafe fn createInstance(&self, _cid: *mut TUID, iid: *mut TUID, obj: *mut *mut c_void) -> tresult {
        if obj.is_null() {
            return kInvalidArgument;
        }
        if iid_eq(iid, &tuid_of::<IMessage>()) {
            let m = ComWrapper::new(HostMessage::new());
            if let Some(p) = m.to_com_ptr::<IMessage>() {
                *obj = p.into_raw() as *mut c_void;
                return kResultOk;
            }
        } else if iid_eq(iid, &tuid_of::<IAttributeList>()) {
            let a = ComWrapper::new(AttrList::default());
            if let Some(p) = a.to_com_ptr::<IAttributeList>() {
                *obj = p.into_raw() as *mut c_void;
                return kResultOk;
            }
        }
        *obj = std::ptr::null_mut();
        kResultFalse
    }
}

impl IPlugInterfaceSupportTrait for HostApp {
    unsafe fn isPlugInterfaceSupported(&self, iid: *const TUID) -> tresult {
        let supported = [
            tuid_of::<IComponentHandler>(),
            tuid_of::<IPlugFrame>(),
            tuid_of::<IMessage>(),
            tuid_of::<IAttributeList>(),
            tuid_of::<IPlugViewContentScaleSupport>(),
        ];
        if supported.iter().any(|s| iid_eq(iid, s)) {
            kResultTrue
        } else {
            kResultFalse
        }
    }
}

thread_local! {
    static HOST_APP: ComWrapper<HostApp> = ComWrapper::new(HostApp);
}

pub fn host_context() -> *mut FUnknown {
    HOST_APP.with(|h| h.as_com_ref::<IHostApplication>().map(|r| r.as_ptr() as *mut FUnknown).unwrap_or(std::ptr::null_mut()))
}

enum Attr {
    Int(i64),
    Float(f64),
    Str(Vec<TChar>),
    Bin(Vec<u8>),
}

#[derive(Default)]
pub struct AttrList {
    map: RefCell<HashMap<String, Attr>>,
}

impl Class for AttrList {
    type Interfaces = (IAttributeList,);
}

unsafe fn key(id: AttrID) -> Option<String> {
    if id.is_null() {
        None
    } else {
        Some(CStr::from_ptr(id).to_string_lossy().into_owned())
    }
}

impl IAttributeListTrait for AttrList {
    unsafe fn setInt(&self, id: AttrID, value: int64) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        self.map.borrow_mut().insert(k, Attr::Int(value));
        kResultOk
    }
    unsafe fn getInt(&self, id: AttrID, value: *mut int64) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        match self.map.borrow().get(&k) {
            Some(Attr::Int(v)) if !value.is_null() => {
                *value = *v;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setFloat(&self, id: AttrID, value: f64) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        self.map.borrow_mut().insert(k, Attr::Float(value));
        kResultOk
    }
    unsafe fn getFloat(&self, id: AttrID, value: *mut f64) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        match self.map.borrow().get(&k) {
            Some(Attr::Float(v)) if !value.is_null() => {
                *value = *v;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setString(&self, id: AttrID, string: *const TChar) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        let mut v = Vec::new();
        if !string.is_null() {
            let mut i = 0;
            while *string.add(i) != 0 && i < 1 << 16 {
                v.push(*string.add(i));
                i += 1;
            }
        }
        v.push(0);
        self.map.borrow_mut().insert(k, Attr::Str(v));
        kResultOk
    }
    unsafe fn getString(&self, id: AttrID, string: *mut TChar, size_in_bytes: uint32) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        match self.map.borrow().get(&k) {
            Some(Attr::Str(v)) if !string.is_null() => {
                let cap = (size_in_bytes as usize) / std::mem::size_of::<TChar>();
                if cap == 0 {
                    return kResultFalse;
                }
                let n = v.len().min(cap);
                std::ptr::copy_nonoverlapping(v.as_ptr(), string, n);
                *string.add(n - 1) = 0;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setBinary(&self, id: AttrID, data: *const c_void, size_in_bytes: uint32) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        let v = if data.is_null() { Vec::new() } else { std::slice::from_raw_parts(data as *const u8, size_in_bytes as usize).to_vec() };
        self.map.borrow_mut().insert(k, Attr::Bin(v));
        kResultOk
    }
    unsafe fn getBinary(&self, id: AttrID, data: *mut *const c_void, size_in_bytes: *mut uint32) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        match self.map.borrow().get(&k) {
            Some(Attr::Bin(v)) if !data.is_null() && !size_in_bytes.is_null() => {
                *data = v.as_ptr() as *const c_void;
                *size_in_bytes = v.len() as uint32;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
}

pub struct HostMessage {
    id: RefCell<Option<CString>>,
    attrs: ComWrapper<AttrList>,
}

impl HostMessage {
    fn new() -> Self {
        HostMessage { id: RefCell::new(None), attrs: ComWrapper::new(AttrList::default()) }
    }
}

impl Class for HostMessage {
    type Interfaces = (IMessage,);
}

impl IMessageTrait for HostMessage {
    unsafe fn getMessageID(&self) -> FIDString {
        self.id.borrow().as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null())
    }
    unsafe fn setMessageID(&self, id: FIDString) {
        *self.id.borrow_mut() = if id.is_null() { None } else { Some(CStr::from_ptr(id).to_owned()) };
    }
    unsafe fn getAttributes(&self) -> *mut IAttributeList {
        self.attrs.as_com_ref::<IAttributeList>().map(|r| r.as_ptr()).unwrap_or(std::ptr::null_mut())
    }
}

#[derive(Default)]
pub struct MemoryStream {
    pub data: RefCell<Vec<u8>>,
    pos: Cell<usize>,
}

impl MemoryStream {
    pub fn from_bytes(b: &[u8]) -> Self {
        MemoryStream { data: RefCell::new(b.to_vec()), pos: Cell::new(0) }
    }
}

impl Class for MemoryStream {
    type Interfaces = (IBStream,);
}

impl IBStreamTrait for MemoryStream {
    unsafe fn read(&self, buffer: *mut c_void, num_bytes: int32, num_read: *mut int32) -> tresult {
        if buffer.is_null() || num_bytes < 0 {
            return kInvalidArgument;
        }
        let d = self.data.borrow();
        let p = self.pos.get().min(d.len());
        let n = (num_bytes as usize).min(d.len() - p);
        std::ptr::copy_nonoverlapping(d.as_ptr().add(p), buffer as *mut u8, n);
        self.pos.set(p + n);
        if !num_read.is_null() {
            *num_read = n as int32;
        }
        kResultOk
    }
    unsafe fn write(&self, buffer: *mut c_void, num_bytes: int32, num_written: *mut int32) -> tresult {
        if buffer.is_null() || num_bytes < 0 {
            return kInvalidArgument;
        }
        let mut d = self.data.borrow_mut();
        let p = self.pos.get();
        let n = num_bytes as usize;
        if d.len() < p + n {
            d.resize(p + n, 0);
        }
        std::ptr::copy_nonoverlapping(buffer as *const u8, d.as_mut_ptr().add(p), n);
        self.pos.set(p + n);
        if !num_written.is_null() {
            *num_written = n as int32;
        }
        kResultOk
    }
    unsafe fn seek(&self, pos: int64, mode: int32, result: *mut int64) -> tresult {
        let len = self.data.borrow().len() as i64;
        let base = match mode as IBStream_::IStreamSeekMode {
            IBStream_::IStreamSeekMode_::kIBSeekSet => 0,
            IBStream_::IStreamSeekMode_::kIBSeekCur => self.pos.get() as i64,
            IBStream_::IStreamSeekMode_::kIBSeekEnd => len,
            _ => return kInvalidArgument,
        };
        let np = (base + pos).max(0);
        self.pos.set(np as usize);
        if !result.is_null() {
            *result = np;
        }
        kResultOk
    }
    unsafe fn tell(&self, pos: *mut int64) -> tresult {
        if pos.is_null() {
            return kInvalidArgument;
        }
        *pos = self.pos.get() as int64;
        kResultOk
    }
}

const QUEUE_POINTS: usize = 64;
const MAX_QUEUES: usize = 512;

pub struct ValueQueue {
    id: Cell<ParamID>,
    points: UnsafeCell<Vec<(int32, ParamValue)>>,
}

impl Class for ValueQueue {
    type Interfaces = (IParamValueQueue,);
}

impl IParamValueQueueTrait for ValueQueue {
    unsafe fn getParameterId(&self) -> ParamID {
        self.id.get()
    }
    unsafe fn getPointCount(&self) -> int32 {
        (*self.points.get()).len() as int32
    }
    unsafe fn getPoint(&self, index: int32, sample_offset: *mut int32, value: *mut ParamValue) -> tresult {
        let pts = &*self.points.get();
        match pts.get(index as usize) {
            Some(&(o, v)) => {
                if !sample_offset.is_null() {
                    *sample_offset = o;
                }
                if !value.is_null() {
                    *value = v;
                }
                kResultOk
            }
            None => kInvalidArgument,
        }
    }
    unsafe fn addPoint(&self, sample_offset: int32, value: ParamValue, index: *mut int32) -> tresult {
        let pts = &mut *self.points.get();
        if let Some(last) = pts.last_mut() {
            if last.0 == sample_offset {
                last.1 = value;
                if !index.is_null() {
                    *index = (pts.len() - 1) as int32;
                }
                return kResultOk;
            }
        }
        if pts.len() >= QUEUE_POINTS {
            return kResultFalse;
        }
        pts.push((sample_offset, value));
        if !index.is_null() {
            *index = (pts.len() - 1) as int32;
        }
        kResultOk
    }
}

pub struct ParamChanges {
    queues: Vec<ComWrapper<ValueQueue>>,
    used: Cell<usize>,
}

impl ParamChanges {
    pub fn new() -> Self {
        ParamChanges {
            queues: (0..MAX_QUEUES).map(|_| ComWrapper::new(ValueQueue { id: Cell::new(0), points: UnsafeCell::new(Vec::with_capacity(QUEUE_POINTS)) })).collect(),
            used: Cell::new(0),
        }
    }

    pub fn clear(&self) {
        for q in &self.queues[..self.used.get()] {
            unsafe { (*q.points.get()).clear() };
        }
        self.used.set(0);
    }

    fn queue_for(&self, id: ParamID) -> Option<usize> {
        let used = self.used.get();
        if let Some(i) = self.queues[..used].iter().position(|q| q.id.get() == id) {
            return Some(i);
        }
        if used >= self.queues.len() {
            return None;
        }
        self.queues[used].id.set(id);
        self.used.set(used + 1);
        Some(used)
    }

    pub fn add(&self, id: ParamID, offset: i32, value: f64) {
        if let Some(i) = self.queue_for(id) {
            unsafe {
                self.queues[i].addPoint(offset, value, std::ptr::null_mut());
            }
        }
    }

    pub fn for_each_last(&self, mut f: impl FnMut(ParamID, f64)) {
        for q in &self.queues[..self.used.get()] {
            let pts = unsafe { &*q.points.get() };
            if let Some(&(_, v)) = pts.last() {
                f(q.id.get(), v);
            }
        }
    }

}

impl Class for ParamChanges {
    type Interfaces = (IParameterChanges,);
}

impl IParameterChangesTrait for ParamChanges {
    unsafe fn getParameterCount(&self) -> int32 {
        self.used.get() as int32
    }
    unsafe fn getParameterData(&self, index: int32) -> *mut IParamValueQueue {
        match self.queues.get(index as usize).filter(|_| (index as usize) < self.used.get()) {
            Some(q) => q.as_com_ref::<IParamValueQueue>().map(|r| r.as_ptr()).unwrap_or(std::ptr::null_mut()),
            None => std::ptr::null_mut(),
        }
    }
    unsafe fn addParameterData(&self, id: *const ParamID, index: *mut int32) -> *mut IParamValueQueue {
        if id.is_null() {
            return std::ptr::null_mut();
        }
        match self.queue_for(*id) {
            Some(i) => {
                if !index.is_null() {
                    *index = i as int32;
                }
                self.queues[i].as_com_ref::<IParamValueQueue>().map(|r| r.as_ptr()).unwrap_or(std::ptr::null_mut())
            }
            None => std::ptr::null_mut(),
        }
    }
}

pub struct EventList {
    events: UnsafeCell<Vec<Event>>,
}

impl EventList {
    pub fn new() -> Self {
        EventList { events: UnsafeCell::new(Vec::with_capacity(2048)) }
    }
    pub fn clear(&self) {
        unsafe { (*self.events.get()).clear() }
    }
    pub fn push(&self, e: Event) {
        let v = unsafe { &mut *self.events.get() };
        if v.len() < v.capacity() {
            v.push(e);
        }
    }
}

impl Class for EventList {
    type Interfaces = (IEventList,);
}

impl IEventListTrait for EventList {
    unsafe fn getEventCount(&self) -> int32 {
        (&*self.events.get()).len() as int32
    }
    unsafe fn getEvent(&self, index: int32, e: *mut Event) -> tresult {
        let list = &*self.events.get();
        match list.get(index as usize) {
            Some(ev) if !e.is_null() => {
                *e = *ev;
                kResultOk
            }
            _ => kInvalidArgument,
        }
    }
    unsafe fn addEvent(&self, e: *mut Event) -> tresult {
        if e.is_null() {
            return kInvalidArgument;
        }
        let v = &mut *self.events.get();
        if v.len() >= v.capacity() {
            return kResultFalse;
        }
        v.push(*e);
        kResultOk
    }
}

pub struct ComponentHandler {
    pub edits: RefCell<Vec<(ParamID, f64)>>,
    pub restart: Cell<i32>,
}

impl Class for ComponentHandler {
    type Interfaces = (IComponentHandler,);
}

impl IComponentHandlerTrait for ComponentHandler {
    unsafe fn beginEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }
    unsafe fn performEdit(&self, id: ParamID, value: ParamValue) -> tresult {
        if let Ok(mut e) = self.edits.try_borrow_mut() {
            if e.len() < 4096 {
                e.push((id, value));
            }
        }
        crate::win::wake();
        kResultOk
    }
    unsafe fn endEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }
    unsafe fn restartComponent(&self, flags: int32) -> tresult {
        self.restart.set(self.restart.get() | flags);
        crate::win::wake();
        kResultOk
    }
}

pub struct PlugFrame {
    pub container: Cell<isize>,
}

impl Class for PlugFrame {
    type Interfaces = (IPlugFrame,);
}

impl IPlugFrameTrait for PlugFrame {
    unsafe fn resizeView(&self, view: *mut IPlugView, new_size: *mut ViewRect) -> tresult {
        if view.is_null() || new_size.is_null() {
            return kInvalidArgument;
        }
        let r = *new_size;
        let (w, h) = ((r.right - r.left).max(1) as u32, (r.bottom - r.top).max(1) as u32);
        let c = self.container.get();
        if c != 0 {
            crate::win::set_client_size(c as windows_sys::Win32::Foundation::HWND, w, h);
        }
        if let Some(v) = ComRef::from_raw(view) {
            let mut rr = r;
            v.onSize(&mut rr);
        }
        kResultTrue
    }
}
