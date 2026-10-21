use std::fs::File;
use std::io::Read;
use std::path::Path;

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::SampleData;

pub const MAX_FRAMES: usize = 48_000 * 60 * 30;

pub const MF_EXTENSIONS: &[&str] = &["m4a", "m4b", "mp4", "m4v", "aac", "adts", "3gp", "3g2", "wma", "asf", "wmv", "mov", "ac3", "ec3", "amr"];

pub fn is_mf_extension(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).map(|e| MF_EXTENSIONS.iter().any(|m| m.eq_ignore_ascii_case(e))).unwrap_or(false)
}

pub fn open_format(path: &Path) -> Result<Box<dyn symphonia::core::formats::FormatReader>, String> {
    let file = File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| format!("Unsupported or corrupt audio file {}: {e}", path.display()))
}

pub fn decode_file(path: &Path) -> Result<SampleData, String> {
    decode_any(path)
}

#[cfg(all(windows, feature = "mediafoundation"))]
fn decode_any(path: &Path) -> Result<SampleData, String> {
    if is_mf_extension(path) {
        if let Err(e) = File::open(path) {
            return Err(format!("Cannot open {}: {e}", path.display()));
        }
        return match mf::decode(path) {
            Ok(d) => Ok(d),
            Err(mf_err) => decode_symphonia(path).map_err(|_| mf_err),
        };
    }
    match decode_symphonia(path) {
        Ok(d) => Ok(d),
        Err(e) if path.is_file() => mf::decode(path).map_err(|_| e),
        Err(e) => Err(e),
    }
}

#[cfg(not(all(windows, feature = "mediafoundation")))]
fn decode_any(path: &Path) -> Result<SampleData, String> {
    if is_mf_extension(path) && path.is_file() && open_format(path).is_err() {
        return Err(format!(
            "Unsupported audio file {}: .{} files need Windows Media Foundation, which this build doesn't include",
            path.display(),
            path.extension().and_then(|e| e.to_str()).unwrap_or("")
        ));
    }
    decode_symphonia(path)
}

pub fn decode_symphonia(path: &Path) -> Result<SampleData, String> {
    let mut format = open_format(path)?;
    let track = format.default_track(TrackType::Audio).ok_or_else(|| format!("No audio track in {}", path.display()))?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|c| c.audio())
        .ok_or_else(|| format!("No audio codec parameters in {}", path.display()))?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| format!("No decoder for {}: {e}", path.display()))?;
    let mut sample_rate = params.sample_rate.unwrap_or(0);
    let mut channels: Vec<Vec<f32>> = Vec::new();
    let mut scratch: Vec<Vec<f32>> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(SymError::ResetRequired) => break,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                if channels.first().map(|c| c.is_empty()).unwrap_or(true) {
                    return Err(format!("Failed to read {}: {e}", path.display()));
                }
                break;
            }
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                if sample_rate == 0 {
                    sample_rate = buf.spec().rate();
                }
                buf.copy_to_vecs_planar::<f32>(&mut scratch);
                if channels.len() < scratch.len() {
                    let have = channels.first().map(|c| c.len()).unwrap_or(0);
                    channels.resize_with(scratch.len(), || vec![0.0; have]);
                }
                for (dst, src) in channels.iter_mut().zip(scratch.iter()) {
                    dst.extend_from_slice(src);
                }
                if channels.first().map(|c| c.len()).unwrap_or(0) > MAX_FRAMES {
                    break;
                }
            }
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => {
                if channels.first().map(|c| c.is_empty()).unwrap_or(true) {
                    return Err(format!("Failed to decode {}: {e}", path.display()));
                }
                break;
            }
        }
    }
    if channels.is_empty() || sample_rate == 0 {
        return Err(format!("{} contains no decodable audio", path.display()));
    }
    let len = channels.iter().map(|c| c.len()).min().unwrap_or(0).min(MAX_FRAMES);
    for c in channels.iter_mut() {
        c.truncate(len);
    }
    if channels.len() > 2 {
        channels.truncate(2);
    }
    let root_key = read_wav_root_key(path);
    Ok(SampleData { sample_rate: sample_rate as f32, channels, root_key })
}

pub fn read_wav_root_key(path: &Path) -> Option<u8> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext != "wav" && ext != "wave" {
        return None;
    }
    let mut f = File::open(path).ok()?;
    let mut hdr = [0u8; 12];
    f.read_exact(&mut hdr).ok()?;
    if &hdr[0..4] != b"RIFF" || &hdr[8..12] != b"WAVE" {
        return None;
    }
    for _ in 0..64 {
        let mut ch = [0u8; 8];
        if f.read_exact(&mut ch).is_err() {
            return None;
        }
        let size = u32::from_le_bytes([ch[4], ch[5], ch[6], ch[7]]) as u64;
        if &ch[0..4] == b"smpl" {
            let mut body = [0u8; 16];
            f.read_exact(&mut body).ok()?;
            let unity = u32::from_le_bytes([body[12], body[13], body[14], body[15]]);
            return if unity <= 127 { Some(unity as u8) } else { None };
        }
        let skip = size + (size & 1);
        std::io::copy(&mut (&mut f).take(skip), &mut std::io::sink()).ok()?;
    }
    None
}

#[cfg(all(windows, feature = "mediafoundation"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MfCodec {
    Aac,
    Alac,
    Wma,
}

#[cfg(all(windows, feature = "mediafoundation"))]
pub fn mf_encode(path: &Path, channels: &[Vec<f32>], sample_rate: u32, codec: MfCodec) -> Result<(), String> {
    mf::encode(path, channels, sample_rate, codec)
}

#[cfg(all(windows, feature = "mediafoundation"))]
pub fn decode_mf(path: &Path) -> Result<SampleData, String> {
    mf::decode(path)
}

#[cfg(all(windows, feature = "mediafoundation"))]
pub(crate) mod mf {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::null_mut;
    use std::sync::OnceLock;

    use windows::core::{s, w, Interface, GUID, HRESULT, PCSTR, PCWSTR};
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::System::Variant::VT_UI8;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};

    use super::{MfCodec, MAX_FRAMES};
    use crate::SampleData;

    type RawFn = unsafe extern "system" fn() -> isize;
    type FnStartup = unsafe extern "system" fn(u32, u32) -> HRESULT;
    type FnShutdown = unsafe extern "system" fn() -> HRESULT;
    type FnOut = unsafe extern "system" fn(*mut *mut c_void) -> HRESULT;
    type FnSourceReader = unsafe extern "system" fn(PCWSTR, *mut c_void, *mut *mut c_void) -> HRESULT;
    type FnSinkWriter = unsafe extern "system" fn(PCWSTR, *mut c_void, *mut c_void, *mut *mut c_void) -> HRESULT;
    type FnMemoryBuffer = unsafe extern "system" fn(u32, *mut *mut c_void) -> HRESULT;
    type FnAudioTypes = unsafe extern "system" fn(*const GUID, u32, *mut c_void, *mut *mut c_void) -> HRESULT;
    type FnAttributes = unsafe extern "system" fn(*mut *mut c_void, u32) -> HRESULT;
    type FnTEnumEx = unsafe extern "system" fn(GUID, u32, *const MFT_REGISTER_TYPE_INFO, *const MFT_REGISTER_TYPE_INFO, *mut *mut *mut c_void, *mut u32) -> HRESULT;

    struct Api {
        startup: FnStartup,
        shutdown: FnShutdown,
        create_media_type: FnOut,
        create_sample: FnOut,
        create_memory_buffer: FnMemoryBuffer,
        source_reader: FnSourceReader,
        sink_writer: FnSinkWriter,
        create_attributes: FnAttributes,
        tenum_ex: Option<FnTEnumEx>,
        audio_types: Option<FnAudioTypes>,
    }

    const NOT_INSTALLED: &str = "this format needs Windows Media Foundation, which is not installed (on Windows N editions, install the Media Feature Pack)";

    fn api() -> Result<&'static Api, String> {
        static API: OnceLock<Result<Api, String>> = OnceLock::new();
        API.get_or_init(load).as_ref().map_err(|e| e.clone())
    }

    unsafe fn sym(m: HMODULE, name: PCSTR) -> Result<RawFn, String> {
        unsafe { GetProcAddress(m, name) }.ok_or_else(|| NOT_INSTALLED.to_string())
    }

    fn load() -> Result<Api, String> {
        unsafe {
            let plat = LoadLibraryExW(w!("mfplat.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).map_err(|_| NOT_INSTALLED.to_string())?;
            let rw = LoadLibraryExW(w!("mfreadwrite.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).map_err(|_| NOT_INSTALLED.to_string())?;
            let mf = LoadLibraryExW(w!("mf.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok();
            Ok(Api {
                startup: std::mem::transmute::<RawFn, FnStartup>(sym(plat, s!("MFStartup"))?),
                shutdown: std::mem::transmute::<RawFn, FnShutdown>(sym(plat, s!("MFShutdown"))?),
                create_media_type: std::mem::transmute::<RawFn, FnOut>(sym(plat, s!("MFCreateMediaType"))?),
                create_sample: std::mem::transmute::<RawFn, FnOut>(sym(plat, s!("MFCreateSample"))?),
                create_memory_buffer: std::mem::transmute::<RawFn, FnMemoryBuffer>(sym(plat, s!("MFCreateMemoryBuffer"))?),
                source_reader: std::mem::transmute::<RawFn, FnSourceReader>(sym(rw, s!("MFCreateSourceReaderFromURL"))?),
                sink_writer: std::mem::transmute::<RawFn, FnSinkWriter>(sym(rw, s!("MFCreateSinkWriterFromURL"))?),
                create_attributes: std::mem::transmute::<RawFn, FnAttributes>(sym(plat, s!("MFCreateAttributes"))?),
                tenum_ex: sym(plat, s!("MFTEnumEx")).ok().map(|f| std::mem::transmute::<RawFn, FnTEnumEx>(f)),
                audio_types: mf.and_then(|m| sym(m, s!("MFTranscodeGetAudioOutputAvailableTypes")).ok()).map(|f| std::mem::transmute::<RawFn, FnAudioTypes>(f)),
            })
        }
    }

    struct Session {
        api: &'static Api,
        com: bool,
    }

    impl Session {
        fn start() -> Result<Session, String> {
            let api = api()?;
            let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
            let hr = unsafe { (api.startup)(MF_VERSION, MFSTARTUP_LITE) };
            if hr.is_err() {
                if com {
                    unsafe { CoUninitialize() };
                }
                return Err(format!("Windows Media Foundation failed to start (0x{:08X})", hr.0 as u32));
            }
            Ok(Session { api, com })
        }
    }

    impl Drop for Session {
        fn drop(&mut self) {
            unsafe {
                let _ = (self.api.shutdown)();
                if self.com {
                    CoUninitialize();
                }
            }
        }
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    fn describe(path: &Path, hr: HRESULT) -> String {
        let p = path.display();
        let code = hr.0 as u32;
        match hr {
            MF_E_UNSUPPORTED_BYTESTREAM_TYPE | MF_E_INVALID_FILE_FORMAT | MF_E_INVALID_FORMAT | MF_E_UNSUPPORTED_FORMAT => {
                format!("Unsupported or corrupt audio file {p}: Windows can't read this file")
            }
            MF_E_INVALIDSTREAMNUMBER | MF_E_NO_MORE_TYPES => format!("No audio track in {p}"),
            MF_E_TOPO_CODEC_NOT_FOUND | MF_E_INVALIDMEDIATYPE => format!("No decoder for {p}: Windows has no codec installed for its audio format"),
            _ if code == 0x8007_0002 || code == 0x8007_0003 => format!("Cannot open {p}: the file does not exist"),
            _ if code == 0x8007_0005 || code == 0x8007_0020 => format!("Cannot open {p}: access denied, or the file is in use"),
            _ => {
                let msg = windows::core::Error::from_hresult(hr).message();
                let msg = msg.trim();
                if msg.is_empty() {
                    format!("Unsupported or corrupt audio file {p} (Media Foundation error 0x{code:08X})")
                } else {
                    format!("Unsupported or corrupt audio file {p} (Windows: {msg} 0x{code:08X})")
                }
            }
        }
    }

    fn err(path: &Path) -> impl Fn(windows::core::Error) -> String + '_ {
        move |e| describe(path, e.code())
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Sample {
        F32,
        F64,
        U8,
        I16,
        I24,
        I32,
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    struct Format {
        channels: usize,
        rate: u32,
        kind: Sample,
    }

    fn media_type(api: &Api) -> windows::core::Result<IMFMediaType> {
        let mut raw = null_mut();
        unsafe {
            (api.create_media_type)(&mut raw).ok()?;
            Ok(IMFMediaType::from_raw(raw))
        }
    }

    const FIRST_AUDIO: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
    const TAIL_PADDING_MAX: usize = 2 * 4096;

    fn current_format(reader: &IMFSourceReader) -> windows::core::Result<Format> {
        unsafe {
            let t = reader.GetCurrentMediaType(FIRST_AUDIO)?;
            let sub = t.GetGUID(&MF_MT_SUBTYPE)?;
            let channels = t.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS)? as usize;
            let rate = t.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)?;
            let bits = t.GetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE)?;
            let pcm = sub == MFAudioFormat_PCM;
            let kind = match (sub == MFAudioFormat_Float, pcm, bits) {
                (true, _, 32) => Sample::F32,
                (true, _, 64) => Sample::F64,
                (_, true, 8) => Sample::U8,
                (_, true, 16) => Sample::I16,
                (_, true, 24) => Sample::I24,
                (_, true, 32) => Sample::I32,
                _ => return Err(windows::core::Error::from_hresult(MF_E_INVALIDMEDIATYPE)),
            };
            Ok(Format { channels, rate, kind })
        }
    }

    fn stated_frames(reader: &IMFSourceReader, rate: u32) -> Option<usize> {
        unsafe {
            let mut pv = reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION).ok()?;
            let v = &pv.Anonymous.Anonymous;
            let hns = if v.vt == VT_UI8 { Some(v.Anonymous.uhVal) } else { None };
            let _ = PropVariantClear(&mut pv);
            hns.filter(|&h| h > 0).map(|h| ((h as u128 * rate as u128 + 5_000_000) / 10_000_000) as usize)
        }
    }

    fn configure(api: &Api, reader: &IMFSourceReader) -> windows::core::Result<Format> {
        unsafe {
            let _ = reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false);
            reader.SetStreamSelection(FIRST_AUDIO, true)?;
            let want = |sub: &GUID| -> windows::core::Result<()> {
                let t = media_type(api)?;
                t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
                t.SetGUID(&MF_MT_SUBTYPE, sub)?;
                reader.SetCurrentMediaType(FIRST_AUDIO, None, &t)
            };
            if want(&MFAudioFormat_Float).is_err() {
                want(&MFAudioFormat_PCM)?;
            }
        }
        current_format(reader)
    }

    fn append(bytes: &[u8], f: &Format, out: &mut [Vec<f32>]) {
        let width = match f.kind {
            Sample::F32 | Sample::I32 => 4,
            Sample::F64 => 8,
            Sample::U8 => 1,
            Sample::I16 => 2,
            Sample::I24 => 3,
        };
        let frame = width * f.channels.max(1);
        if f.kind == Sample::F32 {
            for fr in bytes.chunks_exact(frame) {
                for (c, dst) in out.iter_mut().enumerate() {
                    let o = c * 4;
                    dst.push(f32::from_le_bytes([fr[o], fr[o + 1], fr[o + 2], fr[o + 3]]));
                }
            }
            return;
        }
        for fr in bytes.chunks_exact(frame) {
            for (c, dst) in out.iter_mut().enumerate() {
                let b = &fr[c * width..(c + 1) * width];
                let v = match f.kind {
                    Sample::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
                    Sample::F64 => f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]) as f32,
                    Sample::U8 => (b[0] as f32 - 128.0) / 128.0,
                    Sample::I16 => i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0,
                    Sample::I24 => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
                    Sample::I32 => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
                };
                dst.push(v);
            }
        }
    }

    fn read_all(api: &Api, path: &Path) -> Result<SampleData, String> {
        let w = wide(path);
        let mut raw = null_mut();
        let hr = unsafe { (api.source_reader)(PCWSTR(w.as_ptr()), null_mut(), &mut raw) };
        if hr.is_err() || raw.is_null() {
            return Err(describe(path, hr));
        }
        let reader = unsafe { IMFSourceReader::from_raw(raw) };
        let mut fmt = configure(api, &reader).map_err(err(path))?;
        if fmt.channels == 0 || fmt.rate == 0 {
            return Err(format!("{} contains no decodable audio", path.display()));
        }
        let cap = stated_frames(&reader, fmt.rate).unwrap_or(0).min(fmt.rate as usize * 600) + TAIL_PADDING_MAX;
        let mut chans: Vec<Vec<f32>> = vec![Vec::with_capacity(cap); fmt.channels.min(2)];
        loop {
            let mut flags = 0u32;
            let mut sample: Option<IMFSample> = None;
            let r = unsafe { reader.ReadSample(FIRST_AUDIO, 0, None, Some(&mut flags), None, Some(&mut sample)) };
            let have = chans[0].len();
            if let Err(e) = r {
                if have == 0 {
                    return Err(describe(path, e.code()));
                }
                break;
            }
            if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
                if have == 0 {
                    return Err(format!("Failed to decode {}", path.display()));
                }
                break;
            }
            if flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32 != 0 {
                let nf = current_format(&reader).map_err(err(path))?;
                if have > 0 && (nf.channels.min(2) != chans.len() || nf.rate != fmt.rate) {
                    break;
                }
                if have == 0 {
                    chans = vec![Vec::new(); nf.channels.min(2)];
                }
                fmt = nf;
            }
            if let Some(s) = sample {
                unsafe {
                    let buf = s.ConvertToContiguousBuffer().map_err(err(path))?;
                    let mut ptr: *mut u8 = null_mut();
                    let mut len = 0u32;
                    buf.Lock(&mut ptr, None, Some(&mut len)).map_err(err(path))?;
                    if !ptr.is_null() && len > 0 {
                        append(std::slice::from_raw_parts(ptr, len as usize), &fmt, &mut chans);
                    }
                    let _ = buf.Unlock();
                }
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 || chans[0].len() > MAX_FRAMES {
                break;
            }
        }
        let mut len = chans.iter().map(|c| c.len()).min().unwrap_or(0).min(MAX_FRAMES);
        if len == 0 {
            return Err(format!("{} contains no decodable audio", path.display()));
        }
        if let Some(stated) = stated_frames(&reader, fmt.rate) {
            if stated < len && len - stated <= TAIL_PADDING_MAX {
                len = stated;
            }
        }
        for c in chans.iter_mut() {
            c.truncate(len);
        }
        Ok(SampleData { sample_rate: fmt.rate as f32, channels: chans, root_key: None })
    }

    pub fn decode(path: &Path) -> Result<SampleData, String> {
        let session = Session::start().map_err(|e| format!("Unsupported audio file {}: {e}", path.display()))?;
        read_all(session.api, path)
    }

    fn pcm_type(api: &Api, rate: u32, channels: u32) -> windows::core::Result<IMFMediaType> {
        let t = media_type(api)?;
        unsafe {
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
            t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
            t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels)?;
            t.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 2 * channels)?;
            t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 2 * channels * rate)?;
        }
        Ok(t)
    }

    fn output_type(api: &Api, codec: MfCodec, rate: u32, channels: u32) -> Result<IMFMediaType, String> {
        let s = |e: windows::core::Error| e.to_string();
        unsafe {
            match codec {
                MfCodec::Aac | MfCodec::Alac => {
                    let t = media_type(api).map_err(s)?;
                    let sub = if codec == MfCodec::Aac { MFAudioFormat_AAC } else { MFAudioFormat_ALAC };
                    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(s)?;
                    t.SetGUID(&MF_MT_SUBTYPE, &sub).map_err(s)?;
                    t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(s)?;
                    t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate).map_err(s)?;
                    t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels).map_err(s)?;
                    if codec == MfCodec::Aac {
                        t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 16_000).map_err(s)?;
                    }
                    Ok(t)
                }
                MfCodec::Wma => {
                    let f = api.audio_types.ok_or("mf.dll is not available")?;
                    let mut raw = null_mut();
                    f(&MFAudioFormat_WMAudioV8, MFT_ENUM_FLAG_ALL.0 as u32, null_mut(), &mut raw).ok().map_err(s)?;
                    let list = IMFCollection::from_raw(raw);
                    let n = list.GetElementCount().map_err(s)?;
                    let mut best: Option<(u32, IMFMediaType)> = None;
                    for i in 0..n {
                        let Ok(t) = list.GetElement(i).and_then(|u| u.cast::<IMFMediaType>()) else { continue };
                        let fits = t.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).ok() == Some(rate) && t.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).ok() == Some(channels) && t.GetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE).ok() == Some(16);
                        let bps = t.GetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND).unwrap_or(0);
                        if fits && best.as_ref().map(|b| bps > b.0).unwrap_or(true) {
                            best = Some((bps, t));
                        }
                    }
                    best.map(|b| b.1).ok_or_else(|| format!("no WMA encoder type for {rate} Hz, {channels} channels"))
                }
            }
        }
    }

    fn write_all(api: &Api, path: &Path, channels: &[Vec<f32>], rate: u32, codec: MfCodec) -> Result<(), String> {
        let s = |e: windows::core::Error| e.to_string();
        let ch = channels.len().clamp(1, 2) as u32;
        let frames = channels.iter().map(|c| c.len()).min().unwrap_or(0);
        let w = wide(path);
        let mut raw = null_mut();
        unsafe { (api.sink_writer)(PCWSTR(w.as_ptr()), null_mut(), null_mut(), &mut raw) }.ok().map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
        let writer = unsafe { IMFSinkWriter::from_raw(raw) };
        let out = output_type(api, codec, rate, ch)?;
        let input = pcm_type(api, rate, ch).map_err(s)?;
        unsafe {
            let stream = writer.AddStream(&out).map_err(|e| format!("{codec:?} encoder unavailable: {e}"))?;
            writer.SetInputMediaType(stream, &input, None).map_err(|e| format!("{codec:?} encoder rejects 16-bit PCM input: {e}"))?;
            writer.BeginWriting().map_err(s)?;
            let block = 4096usize;
            let mut at = 0usize;
            while at < frames {
                let n = block.min(frames - at);
                let bytes = n * ch as usize * 2;
                let mut braw = null_mut();
                (api.create_memory_buffer)(bytes as u32, &mut braw).ok().map_err(s)?;
                let buf = IMFMediaBuffer::from_raw(braw);
                let mut ptr: *mut u8 = null_mut();
                buf.Lock(&mut ptr, None, None).map_err(s)?;
                let dst = std::slice::from_raw_parts_mut(ptr, bytes);
                for i in 0..n {
                    for c in 0..ch as usize {
                        let v = channels[c.min(channels.len() - 1)][at + i];
                        let q = (v.clamp(-1.0, 1.0) * 32_767.0).round() as i16;
                        let o = (i * ch as usize + c) * 2;
                        dst[o..o + 2].copy_from_slice(&q.to_le_bytes());
                    }
                }
                let _ = buf.Unlock();
                buf.SetCurrentLength(bytes as u32).map_err(s)?;
                let mut sraw = null_mut();
                (api.create_sample)(&mut sraw).ok().map_err(s)?;
                let sample = IMFSample::from_raw(sraw);
                sample.AddBuffer(&buf).map_err(s)?;
                sample.SetSampleTime((at as i64) * 10_000_000 / rate as i64).map_err(s)?;
                sample.SetSampleDuration((n as i64) * 10_000_000 / rate as i64).map_err(s)?;
                writer.WriteSample(stream, &sample).map_err(s)?;
                at += n;
            }
            writer.Finalize().map_err(|e| format!("Finalizing {} failed: {e}", path.display()))?;
        }
        Ok(())
    }

    pub fn encode(path: &Path, channels: &[Vec<f32>], rate: u32, codec: MfCodec) -> Result<(), String> {
        if channels.is_empty() {
            return Err("nothing to encode".into());
        }
        let session = Session::start()?;
        write_all(session.api, path, channels, rate, codec)
    }

    pub enum Mp3Error {
        EncoderMissing,
        Cancelled,
        Other(String),
    }

    const MP3_BLOCK: usize = 16_384;
    const MP3_MAX_QUEUED: u32 = 8 << 20;

    fn mp3_output_type(api: &Api, rate: u32, kbps: u32) -> windows::core::Result<IMFMediaType> {
        let t = media_type(api)?;
        unsafe {
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_MP3)?;
            t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
            t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
            t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, kbps * 1000 / 8)?;
        }
        Ok(t)
    }

    fn mp3_setup_error(e: windows::core::Error) -> Mp3Error {
        match e.code() {
            MF_E_TOPO_CODEC_NOT_FOUND | MF_E_INVALIDMEDIATYPE | MF_E_UNSUPPORTED_FORMAT | MF_E_TRANSFORM_TYPE_NOT_SET => Mp3Error::EncoderMissing,
            c if c.0 as u32 == 0x8004_0154 => Mp3Error::EncoderMissing,
            c => Mp3Error::Other(format!("Windows' MP3 encoder could not be set up (0x{:08X})", c.0 as u32)),
        }
    }

    fn write_error(path: &Path, what: &str, e: windows::core::Error) -> Mp3Error {
        let p = path.display();
        let code = e.code().0 as u32;
        Mp3Error::Other(match code {
            0x8007_0003 => format!("Cannot write {p}: the folder does not exist"),
            0x8007_0005 | 0x8007_0020 => format!("Cannot write {p}: access denied, or the file is in use"),
            0x8007_0070 => format!("Cannot write {p}: the disk is full"),
            _ => {
                let msg = e.message();
                let msg = msg.trim();
                if msg.is_empty() {
                    format!("{what} {p} failed (Media Foundation error 0x{code:08X})")
                } else {
                    format!("{what} {p} failed (Windows: {msg} 0x{code:08X})")
                }
            }
        })
    }

    pub fn mp3_encoder_available() -> bool {
        static FOUND: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if FOUND.load(std::sync::atomic::Ordering::Relaxed) {
            return true;
        }
        let Ok(api) = api() else { return false };
        let Some(enum_ex) = api.tenum_ex else { return true };
        let Ok(_session) = Session::start() else { return true };
        let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Audio, guidSubtype: MFAudioFormat_PCM };
        let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Audio, guidSubtype: MFAudioFormat_MP3 };
        let mut list: *mut *mut c_void = null_mut();
        let mut n = 0u32;
        let hr = unsafe {
            let hr = enum_ex(MFT_CATEGORY_AUDIO_ENCODER, MFT_ENUM_FLAG_ALL.0 as u32, &input, &output, &mut list, &mut n);
            if !list.is_null() {
                for i in 0..n as usize {
                    let a = *list.add(i);
                    if !a.is_null() {
                        drop(IMFActivate::from_raw(a));
                    }
                }
                CoTaskMemFree(Some(list as *const c_void));
            }
            hr
        };
        let ok = hr.is_err() || n > 0;
        if ok {
            FOUND.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        ok
    }

    pub fn encode_mp3(path: &Path, rate: u32, kbps: u32, frames: usize, fill: &mut dyn FnMut(usize, &mut [i16]) -> bool) -> Result<(), Mp3Error> {
        if api().is_err() {
            return Err(Mp3Error::EncoderMissing);
        }
        let session = Session::start().map_err(Mp3Error::Other)?;
        let api = session.api;
        let s = |e: windows::core::Error| write_error(path, "Writing", e);
        unsafe {
            let mut araw = null_mut();
            (api.create_attributes)(&mut araw, 2).ok().map_err(s)?;
            let attrs = IMFAttributes::from_raw(araw);
            attrs.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MP3).map_err(s)?;
            attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1).map_err(s)?;
            let w = wide(path);
            let mut raw = null_mut();
            let hr = (api.sink_writer)(PCWSTR(w.as_ptr()), null_mut(), attrs.as_raw(), &mut raw);
            if hr.is_err() || raw.is_null() {
                let e = windows::core::Error::from_hresult(hr);
                return Err(match hr {
                    MF_E_UNSUPPORTED_BYTESTREAM_TYPE | MF_E_TOPO_CODEC_NOT_FOUND => Mp3Error::EncoderMissing,
                    _ => write_error(path, "Creating", e),
                });
            }
            let writer = IMFSinkWriter::from_raw(raw);
            let out = mp3_output_type(api, rate, kbps).map_err(s)?;
            let stream = writer.AddStream(&out).map_err(mp3_setup_error)?;
            let input = pcm_type(api, rate, 2).map_err(s)?;
            writer.SetInputMediaType(stream, &input, None).map_err(mp3_setup_error)?;
            writer.BeginWriting().map_err(mp3_setup_error)?;
            let hns = |f: usize| (f as u128 * 10_000_000 / rate as u128) as i64;
            let mut pcm = vec![0i16; MP3_BLOCK * 2];
            let mut at = 0usize;
            while at < frames {
                let n = MP3_BLOCK.min(frames - at);
                let bytes = n * 4;
                if !fill(at, &mut pcm[..n * 2]) {
                    return Err(Mp3Error::Cancelled);
                }
                let mut braw = null_mut();
                (api.create_memory_buffer)(bytes as u32, &mut braw).ok().map_err(s)?;
                let buf = IMFMediaBuffer::from_raw(braw);
                let mut ptr: *mut u8 = null_mut();
                buf.Lock(&mut ptr, None, None).map_err(s)?;
                std::ptr::copy_nonoverlapping(pcm.as_ptr() as *const u8, ptr, bytes);
                let _ = buf.Unlock();
                buf.SetCurrentLength(bytes as u32).map_err(s)?;
                let mut sraw = null_mut();
                (api.create_sample)(&mut sraw).ok().map_err(s)?;
                let sample = IMFSample::from_raw(sraw);
                sample.AddBuffer(&buf).map_err(s)?;
                sample.SetSampleTime(hns(at)).map_err(s)?;
                sample.SetSampleDuration(hns(at + n) - hns(at)).map_err(s)?;
                writer.WriteSample(stream, &sample).map_err(s)?;
                at += n;
                loop {
                    let mut st = MF_SINK_WRITER_STATISTICS { cb: std::mem::size_of::<MF_SINK_WRITER_STATISTICS>() as u32, ..Default::default() };
                    if writer.GetStatistics(stream, &mut st).is_err() || st.dwByteCountQueued <= MP3_MAX_QUEUED {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
            }
            writer.Finalize().map_err(|e| write_error(path, "Finishing", e))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wav::{write_wav, WavFormat};
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("krypt-decode-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn tone(hz: f32, sr: u32, secs: f32) -> Vec<Vec<f32>> {
        let n = (secs * sr as f32) as usize;
        let ch = |f: f32| (0..n).map(|i| 0.5 * (2.0 * std::f32::consts::PI * f * i as f32 / sr as f32).sin()).collect::<Vec<f32>>();
        vec![ch(hz), ch(hz * 1.5)]
    }

    fn freq(x: &[f32], sr: f32) -> f32 {
        let mid = &x[x.len() / 4..x.len() * 3 / 4];
        let crossings = mid.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        crossings as f32 * sr / mid.len() as f32
    }

    #[cfg_attr(not(all(windows, feature = "mediafoundation")), allow(dead_code))]
    fn rms(x: &[f32]) -> f32 {
        let mid = &x[x.len() / 4..x.len() * 3 / 4];
        (mid.iter().map(|v| v * v).sum::<f32>() / mid.len() as f32).sqrt()
    }

    #[test]
    fn wav_through_symphonia() {
        let dir = temp_dir("wav");
        let p = dir.join("t.wav");
        let t = tone(440.0, 48_000, 0.5);
        write_wav(&p, &[&t[0], &t[1]], 48_000, WavFormat::Pcm16).unwrap();
        let d = decode_file(&p).unwrap();
        assert_eq!((d.sample_rate, d.channels.len(), d.frames()), (48_000.0, 2, 24_000));
        assert!((freq(&d.channels[0], 48_000.0) - 440.0).abs() < 5.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_and_corrupt_files_fail_with_their_name() {
        let dir = temp_dir("bad");
        for name in ["nope.wav", "nope.m4a"] {
            let e = decode_file(&dir.join(name)).unwrap_err();
            assert!(e.contains(name) && e.starts_with("Cannot open"), "{e}");
        }
        for name in ["junk.wav", "junk.m4a", "junk.wma", "junk.bin"] {
            let p = dir.join(name);
            std::fs::write(&p, b"definitely not an audio file, just some bytes that go on for a while").unwrap();
            let e = decode_file(&p).unwrap_err();
            assert!(e.contains(name), "{e}");
            eprintln!("{name}: {e}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mf_extensions() {
        assert!(is_mf_extension(Path::new("a/b/song.M4A")));
        assert!(is_mf_extension(Path::new("x.wma")) && is_mf_extension(Path::new("x.aac")) && is_mf_extension(Path::new("x.mp4")));
        assert!(!is_mf_extension(Path::new("x.mp3")) && !is_mf_extension(Path::new("x.flac")) && !is_mf_extension(Path::new("noext")));
    }

    #[cfg(all(windows, feature = "mediafoundation"))]
    mod media_foundation {
        use super::*;

        fn encoded(dir: &Path, name: &str, codec: MfCodec, ch: &[Vec<f32>], sr: u32) -> Option<PathBuf> {
            let p = dir.join(name);
            match mf_encode(&p, ch, sr, codec) {
                Ok(()) => Some(p),
                Err(e) => {
                    eprintln!("SKIPPED {name}: Media Foundation can't encode {codec:?} here ({e})");
                    None
                }
            }
        }

        fn check_tone(d: &SampleData, sr: u32, secs: f32, what: &str) {
            assert_eq!(d.sample_rate, sr as f32, "{what}: rate");
            assert_eq!(d.channels.len(), 2, "{what}: channels");
            let want = (secs * sr as f32) as usize;
            assert!(d.frames() >= want - 1 && d.frames() <= want + 4096, "{what}: {} frames, want {want}", d.frames());
            assert!(d.channels[0].iter().skip(want + 2048).all(|v| v.abs() < 0.02), "{what}: the tail past the end is padding");
            assert!((freq(&d.channels[0], sr as f32) - 1000.0).abs() < 10.0, "{what}: left {} Hz", freq(&d.channels[0], sr as f32));
            assert!((freq(&d.channels[1], sr as f32) - 1500.0).abs() < 15.0, "{what}: right {} Hz", freq(&d.channels[1], sr as f32));
            assert!((rms(&d.channels[0]) - 0.5 / 2f32.sqrt()).abs() < 0.03, "{what}: rms {}", rms(&d.channels[0]));
        }

        #[test]
        fn aac_m4a_mp4_and_adts_decode() {
            let dir = temp_dir("aac");
            let (sr, secs) = (44_100, 2.0);
            let t = tone(1000.0, sr, secs);
            let mut any = false;
            for name in ["tone.m4a", "tone.mp4", "tone.aac"] {
                let Some(p) = encoded(&dir, name, MfCodec::Aac, &t, sr) else { continue };
                let d = decode_file(&p).unwrap_or_else(|e| panic!("{name}: {e}"));
                eprintln!("{name}: {} Hz, {} ch, {} frames", d.sample_rate, d.channels.len(), d.frames());
                check_tone(&d, sr, secs, name);
                any = true;
            }
            if !any {
                eprintln!("SKIPPED: no AAC encoder on this Windows");
            }
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn decoded_audio_is_sample_aligned() {
            let dir = temp_dir("align");
            let sr = 44_100u32;
            let at = sr as usize / 4;
            let x: Vec<f32> = (0..sr as usize).map(|i| if i >= at { 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * (i - at) as f32 / sr as f32).sin() } else { 0.0 }).collect();
            for (name, codec) in [("a.m4a", MfCodec::Aac), ("a.aac", MfCodec::Aac), ("a-alac.m4a", MfCodec::Alac), ("a.wma", MfCodec::Wma)] {
                let Some(p) = encoded(&dir, name, codec, &[x.clone(), x.clone()], sr) else { continue };
                let d = decode_file(&p).unwrap();
                let onset = d.channels[0].iter().position(|v| v.abs() > 0.05).unwrap();
                eprintln!("{name}: onset at {onset} (written at {at})");
                assert!((onset as i64 - at as i64).abs() <= 44, "{name}: onset {onset}, want {at} (±1 ms)");
            }
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        #[ignore]
        fn perf_three_minute_aac() {
            let dir = temp_dir("perf");
            let t = tone(1000.0, 44_100, 180.0);
            let Some(p) = encoded(&dir, "long.m4a", MfCodec::Aac, &t, 44_100) else { return };
            let t0 = std::time::Instant::now();
            let d = decode_file(&p).unwrap();
            eprintln!("PERF decode 3 min stereo AAC: {:.3} s ({} frames)", t0.elapsed().as_secs_f32(), d.frames());
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn alac_is_lossless_and_wma_decodes() {
            let dir = temp_dir("alac");
            let sr = 48_000;
            let t = tone(1000.0, sr, 1.0);
            if let Some(p) = encoded(&dir, "tone-alac.m4a", MfCodec::Alac, &t, sr) {
                let d = decode_file(&p).unwrap();
                assert_eq!((d.sample_rate, d.channels.len()), (sr as f32, 2));
                assert!(d.frames() >= t[0].len() && d.frames() <= t[0].len() + 4096, "{} frames", d.frames());
                let q = |v: f32| (v.clamp(-1.0, 1.0) * 32_767.0).round() / 32_768.0;
                let err = t[0].iter().zip(&d.channels[0]).map(|(a, b)| (q(*a) - b).abs()).fold(0f32, f32::max);
                assert!(err < 1e-6, "ALAC is lossless at 16 bits (max error {err})");
            }
            let t44 = tone(1000.0, 44_100, 2.0);
            if let Some(p) = encoded(&dir, "tone.wma", MfCodec::Wma, &t44, 44_100) {
                let d = decode_file(&p).unwrap();
                eprintln!("wma: {} Hz, {} ch, {} frames", d.sample_rate, d.channels.len(), d.frames());
                check_tone(&d, 44_100, 2.0, "tone.wma");
            }
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn fallbacks_corrupt_and_threads() {
            let dir = temp_dir("fallback");
            let sr = 44_100;
            let t = tone(1000.0, sr, 1.0);
            let Some(p) = encoded(&dir, "tone.m4a", MfCodec::Aac, &t, sr) else { return };
            let renamed = dir.join("tone.bin");
            std::fs::copy(&p, &renamed).unwrap();
            check_tone(&decode_file(&renamed).unwrap(), sr, 1.0, "tone.bin");
            let wav_as_m4a = dir.join("wave.m4a");
            write_wav(&wav_as_m4a, &[&t[0], &t[1]], sr, WavFormat::Pcm16).unwrap();
            assert_eq!(decode_file(&wav_as_m4a).unwrap().frames(), t[0].len());
            let bytes = std::fs::read(&p).unwrap();
            let cut = dir.join("cut.m4a");
            std::fs::write(&cut, &bytes[..bytes.len() / 3]).unwrap();
            match decode_file(&cut) {
                Ok(d) => assert!(d.frames() > 0),
                Err(e) => assert!(e.contains("cut.m4a"), "{e}"),
            }
            let mut junk = bytes[..64.min(bytes.len())].to_vec();
            junk.extend(std::iter::repeat_n(0xA5u8, 4096));
            let bad = dir.join("bad.m4a");
            std::fs::write(&bad, &junk).unwrap();
            let e = decode_file(&bad).unwrap_err();
            assert!(e.contains("bad.m4a"), "{e}");
            eprintln!("bad.m4a: {e}");
            let hs: Vec<_> = (0..4).map(|_| {
                let p = p.clone();
                std::thread::spawn(move || decode_file(&p).map(|d| d.frames()))
            }).collect();
            let n: Vec<usize> = hs.into_iter().map(|h| h.join().unwrap().unwrap()).collect();
            assert!(n.windows(2).all(|w| w[0] == w[1]), "{n:?}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
