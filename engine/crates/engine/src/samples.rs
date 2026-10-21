pub use krypt_studio_dsp::decode::{decode_file, open_format, read_wav_root_key};
pub use krypt_studio_dsp::instruments::multisampler::load::is_sfz;
use krypt_studio_dsp::instruments::multisampler::load::{load_set, LoadOptions};
use krypt_studio_dsp::instruments::multisampler::MultiSampleSet;
use krypt_studio_dsp::SampleData;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use symphonia::core::formats::TrackType;

pub const PACK_SCHEME: &str = "pack:";

pub fn parse_pack_path(p: &str) -> Option<(&str, &str)> {
    let rest = p.strip_prefix(PACK_SCHEME)?;
    let slash = rest.find('/')?;
    if slash == 0 {
        return None;
    }
    let (id, inner) = (&rest[..slash], &rest[slash + 1..]);
    let b = id.as_bytes();
    let id_ok = (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-');
    if !id_ok || inner.is_empty() || inner.contains(['\\', ':']) || inner.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return None;
    }
    Some((id, inner))
}

pub fn resolve_path(p: &str, factory_dir: &Path, packs_dir: Option<&Path>, base_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(rel) = p.strip_prefix("factory:") {
        let mut out = factory_dir.to_path_buf();
        for part in rel.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".") {
            out.push(part);
        }
        return Ok(out);
    }
    if p.starts_with(PACK_SCHEME) {
        let Some((id, inner)) = parse_pack_path(p) else {
            return Err(format!("'{p}' is not a valid sound pack path (expected pack:<pack id>/<file>)"));
        };
        let Some(dir) = packs_dir else {
            return Err(format!("Sound pack {id} isn't installed or the packs folder is unknown (the engine was started without --packs-dir)"));
        };
        let mut out = dir.join(id);
        if !out.is_dir() {
            return Err(missing_pack_message(id));
        }
        for part in inner.split('/') {
            out.push(part);
        }
        return Ok(out);
    }
    let pb = PathBuf::from(p);
    if pb.is_relative() {
        if let Some(b) = base_dir {
            return Ok(b.join(pb));
        }
    }
    Ok(pb)
}

fn missing_pack_message(id: &str) -> String {
    format!("Sound pack {id} isn't installed: download it in Home > Sounds > Sound packs")
}

pub fn missing_pack_hint(path: &Path, packs_dir: Option<&Path>) -> Option<String> {
    let dir = packs_dir?;
    let rel = path.strip_prefix(dir).ok()?;
    let id = rel.components().next()?.as_os_str().to_string_lossy().into_owned();
    (!dir.join(&id).is_dir()).then(|| missing_pack_message(&id))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleInfo {
    pub path: String,
    pub frames: u64,
    pub sample_rate: u32,
    pub channels: u32,
    pub duration_sec: f64,
}

pub fn probe_info(path: &Path, display: &str) -> Result<SampleInfo, String> {
    if let Ok(format) = open_format(path) {
        let track = format.default_track(TrackType::Audio).ok_or_else(|| format!("No audio track in {}", path.display()))?;
        let params = track.codec_params.as_ref().and_then(|c| c.audio()).cloned();
        let sr = params.as_ref().and_then(|p| p.sample_rate).unwrap_or(0);
        let ch = params.as_ref().and_then(|p| p.channels.as_ref()).map(|c| c.count() as u32).unwrap_or(0);
        if let (Some(frames), true, true) = (track.num_frames, sr > 0, ch > 0) {
            return Ok(SampleInfo { path: display.to_string(), frames, sample_rate: sr, channels: ch, duration_sec: frames as f64 / sr as f64 });
        }
    }
    let d = decode_file(path)?;
    let frames = d.frames() as u64;
    Ok(SampleInfo {
        path: display.to_string(),
        frames,
        sample_rate: d.sample_rate as u32,
        channels: d.channels.len() as u32,
        duration_sec: frames as f64 / d.sample_rate as f64,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peaks {
    pub frames: u64,
    pub sample_rate: u32,
    pub channels: u32,
    pub data: Vec<f32>,
}

pub fn compute_peaks(d: &SampleData, buckets: usize) -> Peaks {
    let frames = d.frames();
    let buckets = buckets.clamp(1, 1_000_000);
    let nch = d.channels.len().max(1) as f32;
    let mut data = Vec::with_capacity(buckets * 2);
    for b in 0..buckets {
        let a = (b as u128 * frames as u128 / buckets as u128) as usize;
        let e = (((b + 1) as u128 * frames as u128 / buckets as u128) as usize).max(a + 1).min(frames);
        let (mut mn, mut mx) = (0f32, 0f32);
        let mut first = true;
        for i in a..e {
            let mut s = 0f32;
            for c in d.channels.iter() {
                s += c[i];
            }
            s /= nch;
            if first {
                mn = s;
                mx = s;
                first = false;
            } else {
                mn = mn.min(s);
                mx = mx.max(s);
            }
        }
        data.push(mn.clamp(-1.0, 1.0));
        data.push(mx.clamp(-1.0, 1.0));
    }
    Peaks { frames: frames as u64, sample_rate: d.sample_rate as u32, channels: d.channels.len() as u32, data }
}

enum Entry {
    Ok(Arc<SampleData>),
    Failed(String),
}

pub enum Lookup {
    Hit(Arc<SampleData>),
    Failed(String),
    Miss,
}

enum MultiEntry {
    Ok(Arc<MultiSampleSet>),
    Failed(String),
}

pub enum MultiLookup {
    Hit(Arc<MultiSampleSet>),
    Failed(String),
    Miss,
}

fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

#[derive(Default)]
pub struct SampleCache {
    map: Mutex<HashMap<PathBuf, (Option<SystemTime>, Entry)>>,
    peaks: Mutex<HashMap<(PathBuf, usize), (Option<SystemTime>, Arc<Peaks>)>>,
    multi: Mutex<HashMap<PathBuf, (Option<SystemTime>, MultiEntry)>>,
    pub variants: crate::variants::VariantCache,
}

impl SampleCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn lookup(&self, path: &Path) -> Lookup {
        let mt = mtime(path);
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(path) {
            Some((m, Entry::Ok(d))) if *m == mt => Lookup::Hit(d.clone()),
            Some((m, Entry::Failed(e))) if *m == mt => Lookup::Failed(e.clone()),
            _ => Lookup::Miss,
        }
    }

    pub fn load(&self, path: &Path) -> Result<Arc<SampleData>, String> {
        match self.lookup(path) {
            Lookup::Hit(d) => return Ok(d),
            Lookup::Failed(e) => return Err(e),
            Lookup::Miss => {}
        }
        let mt = mtime(path);
        let res = decode_file(path).map(Arc::new);
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        match &res {
            Ok(d) => {
                map.insert(path.to_path_buf(), (mt, Entry::Ok(d.clone())));
            }
            Err(e) => {
                map.insert(path.to_path_buf(), (mt, Entry::Failed(e.clone())));
            }
        }
        res
    }

    pub fn preload(&self, path: &Path) {
        if is_sfz(path) {
            let _ = self.load_multi(path);
        } else {
            let _ = self.load(path);
        }
    }

    pub fn lookup_multi(&self, path: &Path) -> MultiLookup {
        let mt = mtime(path);
        let map = self.multi.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(path) {
            Some((m, MultiEntry::Ok(d))) if *m == mt => MultiLookup::Hit(d.clone()),
            Some((m, MultiEntry::Failed(e))) if *m == mt => MultiLookup::Failed(e.clone()),
            _ => MultiLookup::Miss,
        }
    }

    pub fn load_multi(&self, path: &Path) -> Result<Arc<MultiSampleSet>, String> {
        match self.lookup_multi(path) {
            MultiLookup::Hit(d) => return Ok(d),
            MultiLookup::Failed(e) => return Err(e),
            MultiLookup::Miss => {}
        }
        let mt = mtime(path);
        let res = load_set(path, &LoadOptions::default()).map(Arc::new);
        let mut map = self.multi.lock().unwrap_or_else(|e| e.into_inner());
        match &res {
            Ok(d) => {
                map.insert(path.to_path_buf(), (mt, MultiEntry::Ok(d.clone())));
            }
            Err(e) => {
                map.insert(path.to_path_buf(), (mt, MultiEntry::Failed(e.clone())));
            }
        }
        res
    }

    pub fn get_or_decode(&self, path: &Path) -> Result<Arc<SampleData>, String> {
        match self.lookup(path) {
            Lookup::Hit(d) => Ok(d),
            _ => decode_file(path).map(Arc::new),
        }
    }

    pub fn prune(&self, keep: &std::collections::HashSet<PathBuf>) {
        {
            let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
            map.retain(|p, (_, e)| keep.contains(p) || matches!(e, Entry::Ok(d) if Arc::strong_count(d) > 1));
        }
        {
            let mut map = self.multi.lock().unwrap_or_else(|e| e.into_inner());
            map.retain(|p, (_, e)| keep.contains(p) || matches!(e, MultiEntry::Ok(d) if Arc::strong_count(d) > 1));
        }
        self.variants.trim();
    }

    pub fn mtime_of(path: &Path) -> Option<SystemTime> {
        mtime(path)
    }

    pub fn peaks(&self, path: &Path, buckets: usize) -> Result<Arc<Peaks>, String> {
        let mt = mtime(path);
        let key = (path.to_path_buf(), buckets);
        if let Some((m, p)) = self.peaks.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            if *m == mt {
                return Ok(p.clone());
            }
        }
        let d = self.get_or_decode(path)?;
        let p = Arc::new(compute_peaks(&d, buckets));
        let mut pk = self.peaks.lock().unwrap_or_else(|e| e.into_inner());
        if pk.len() > 512 {
            pk.clear();
        }
        pk.insert(key, (mt, p.clone()));
        Ok(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_wav(path: &Path, sr: u32, ch: u16, frames: usize) {
        let spec = hound::WavSpec { channels: ch, sample_rate: sr, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..frames {
            let v = ((i as f32 * 0.05).sin() * 16000.0) as i16;
            for _ in 0..ch {
                w.write_sample(v).unwrap();
            }
        }
        w.finalize().unwrap();
    }

    #[test]
    fn decode_probe_and_peaks() {
        let dir = std::env::temp_dir().join(format!("kse-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.wav");
        write_wav(&p, 44100, 2, 4410);
        let d = decode_file(&p).unwrap();
        assert_eq!(d.sample_rate, 44100.0);
        assert_eq!(d.channels.len(), 2);
        assert_eq!(d.frames(), 4410);
        assert!(d.channels[0].iter().any(|x| x.abs() > 0.3));
        let info = probe_info(&p, "t.wav").unwrap();
        assert_eq!(info.frames, 4410);
        assert_eq!(info.channels, 2);
        assert!((info.duration_sec - 0.1).abs() < 1e-6);
        let cache = SampleCache::new();
        let pk = cache.peaks(&p, 10).unwrap();
        assert_eq!(pk.data.len(), 20);
        assert!(pk.data.chunks(2).all(|c| c[0] <= c[1]));
        assert!(cache.load(&dir.join("missing.wav")).is_err());
        assert!(matches!(cache.lookup(&p), Lookup::Miss));
        let held = cache.load(&p).unwrap();
        cache.prune(&Default::default());
        assert!(matches!(cache.lookup(&p), Lookup::Hit(_)), "kept while an instrument holds it");
        drop(held);
        cache.prune(&Default::default());
        assert!(matches!(cache.lookup(&p), Lookup::Miss));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn probe_and_peaks_for_media_foundation_formats() {
        use krypt_studio_dsp::decode::{mf_encode, MfCodec};
        let dir = std::env::temp_dir().join(format!("kse-mf-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.m4a");
        let tone: Vec<f32> = (0..44_100).map(|i| 0.5 * (i as f32 * 0.1).sin()).collect();
        if let Err(e) = mf_encode(&p, &[tone.clone(), tone], 44_100, MfCodec::Aac) {
            eprintln!("SKIPPED: no AAC encoder on this Windows ({e})");
            return;
        }
        let info = probe_info(&p, "t.m4a").unwrap();
        assert_eq!((info.sample_rate, info.channels), (44_100, 2));
        assert!((info.duration_sec - 1.0).abs() < 0.1, "{}", info.duration_sec);
        let pk = SampleCache::new().peaks(&p, 8).unwrap();
        assert_eq!(pk.data.len(), 16);
        assert!(pk.data.chunks(2).any(|c| c[1] > 0.3));
        let bad = dir.join("bad.m4a");
        std::fs::write(&bad, b"not an mp4 at all").unwrap();
        assert!(probe_info(&bad, "bad.m4a").unwrap_err().contains("bad.m4a"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn factory_paths() {
        let f = Path::new("C:/kit");
        assert_eq!(resolve_path("factory:drums/kick.wav", f, None, None).unwrap(), Path::new("C:/kit").join("drums").join("kick.wav"));
        assert_eq!(resolve_path("factory:/drums\\808.wav", f, None, None).unwrap(), Path::new("C:/kit").join("drums").join("808.wav"));
        assert_eq!(resolve_path("C:/x/y.wav", f, None, None).unwrap(), PathBuf::from("C:/x/y.wav"));
        assert_eq!(resolve_path("rel/y.wav", f, None, Some(Path::new("C:/p"))).unwrap(), Path::new("C:/p").join("rel/y.wav"));
    }

    #[test]
    fn pack_paths() {
        assert_eq!(parse_pack_path("pack:grand-piano/krypt/grand.sfz"), Some(("grand-piano", "krypt/grand.sfz")));
        assert_eq!(parse_pack_path("pack:k9/a.sfz"), Some(("k9", "a.sfz")));
        for bad in [
            "pack:", "pack:/a.sfz", "pack:grand-piano", "pack:grand-piano/", "pack:Grand/a.sfz", "pack:-x/a.sfz", "pack:a_b/a.sfz",
            "pack:x/../y.sfz", "pack:x/a/../../y", "pack:x/./a.sfz", "pack:x//a.sfz", "pack:x/a/", "pack:x/..\\..\\evil.sfz", "pack:x/C:/evil.sfz",
            "factory:x/a.wav", "C:/x.sfz",
        ] {
            assert_eq!(parse_pack_path(bad), None, "{bad}");
        }
        let root = std::env::temp_dir().join(format!("kse-packs-{}", std::process::id()));
        let packs = root.join("packs");
        std::fs::create_dir_all(packs.join("kit").join("krypt")).unwrap();
        let f = Path::new("C:/factory");
        assert_eq!(resolve_path("pack:kit/krypt/kit.sfz", f, Some(&packs), None).unwrap(), packs.join("kit").join("krypt").join("kit.sfz"));
        let e = resolve_path("pack:kit/krypt/kit.sfz", f, None, None).unwrap_err();
        assert!(e.contains("Sound pack kit isn't installed or the packs folder is unknown"), "{e}");
        let e = resolve_path("pack:other/a.sfz", f, Some(&packs), None).unwrap_err();
        assert!(e.contains("Sound pack other isn't installed"), "{e}");
        let e = resolve_path("pack:kit/../kit/x.sfz", f, Some(&packs), None).unwrap_err();
        assert!(e.contains("not a valid sound pack path"), "{e}");
        assert_eq!(
            missing_pack_hint(&packs.join("other").join("a.sfz"), Some(&packs)).as_deref(),
            Some("Sound pack other isn't installed: download it in Home > Sounds > Sound packs")
        );
        assert_eq!(missing_pack_hint(&packs.join("kit").join("a.sfz"), Some(&packs)), None);
        assert_eq!(missing_pack_hint(Path::new("C:/elsewhere/a.sfz"), Some(&packs)), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
