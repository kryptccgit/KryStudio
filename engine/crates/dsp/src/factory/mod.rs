//! Factory sounds: Krypt-original samples synthesized by our own DSP (no
//! third-party sample licensing), written as 48 kHz WAVs plus a
//! machine-readable `index.json` (FactoryIndex in shared/sounds/types.ts).
//!
//! * `legacy` — the original 11-sample kit at `drums/*.wav`. Frozen: older
//!   projects reference these paths and must keep sounding the same.
//! * the library — ~160 mix-ready drum one-shots, 808s, transition FX,
//!   texture loops, bass one-shots and chord stabs in `drums/<kind>/`,
//!   `808/`, `fx/<kind>/`, `textures/` and `oneshots/<kind>/`.
//!
//! Mastering (`master`): DC / subsonic high pass, trailing-silence trim
//! (one-shots), click-free fades, true-peak normalisation (drums -1 dBFS,
//! FX and textures lower), mono where the sound is mono, 24-bit one-shots up
//! to 2 s and dithered 16-bit for everything longer or tempo-synced, plus a
//! `smpl` chunk with the root key on tonal samples. Everything written must
//! stay within `MAX_TOTAL_BYTES`.
//!
//! Tempo-synced files (risers, sweeps, swells, reverse cymbals, downlifters,
//! fills, 1-bar tape stops, texture loops) are written at 128 BPM and are
//! exactly `bars` bars long (90 000 samples per bar), so an audio clip with
//! tempo sync spans exactly that many bars at any project tempo. Risers /
//! uplifting sweeps / swells / reverse cymbals peak on their very last
//! sample; whooshes cross the listener in their last ~10 % and tape stops
//! halt on their last sample (all three are placed by their END); downlifters,
//! impacts and sub drops start with their transient on sample 0.
//!
//! Wave 7b (research/14 §2.1) recipes live in `transitions` (risers,
//! downlifters, swells, reverse cymbals, whooshes, tape stops), `hits`
//! (impacts, sub drops, zaps), `vox` (formant-synth vocal shots in
//! `oneshots/vox/`), `fills` and `ambient`, on the helpers in `kit`.
//!
//! Generation is deterministic (fixed seeds, fixed block sizes, results
//! assembled in list order), so two runs write identical bytes.

mod ambient;
mod drums;
mod fills;
mod fx;
mod hits;
mod index;
mod kit;
mod legacy;
mod library;
mod master;
mod perc;
mod stats;
mod synth;
mod textures;
mod tonal;
mod transitions;
mod vox;
#[cfg(test)]
mod tests;

use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

pub use index::IndexEntry;
pub use legacy::{generate_kit, render_kit, KIT_SAMPLE_RATE};
pub use stats::{table, SampleStat};

/// Tempo of every tempo-synced library file.
pub const LIBRARY_BPM: f64 = 128.0;
/// Samples per bar at `LIBRARY_BPM` and 48 kHz.
pub const SAMPLES_PER_BAR: usize = synth::BAR;
/// Size budget for everything `generate_factory` writes (bytes).
pub const MAX_TOTAL_BYTES: u64 = 80_000_000;
/// Top-level folders the library owns (stale `.wav` files in them are removed).
pub const LIBRARY_FOLDERS: [&str; 5] = ["drums", "808", "fx", "textures", "oneshots"];

/// Mirrors SAMPLE_KINDS in shared/sounds/types.ts (a test keeps them equal).
pub const SAMPLE_KINDS: [&str; 33] = [
    "kick",
    "snare",
    "clap",
    "hat",
    "openhat",
    "ride",
    "crash",
    "perc",
    "tom",
    "rim",
    "shaker",
    "snap",
    "808",
    "bass-oneshot",
    "stab-oneshot",
    "riser",
    "downlifter",
    "impact",
    "sweep-up",
    "sweep-down",
    "reverse-cymbal",
    "sub-drop",
    "noise",
    "texture",
    "fill",
    "whoosh",
    "tape-stop",
    "swell",
    "zap",
    "vox",
    "foley",
    "ambience",
    "retro",
];

/// Mirrors GENRE_IDS in shared/sounds/genres.ts (a test keeps them equal).
pub const GENRE_IDS: [&str; 18] = [
    "trap",
    "drill",
    "boom-bap",
    "lofi",
    "phonk",
    "rnb",
    "pop",
    "afrobeats",
    "reggaeton",
    "house",
    "deep-house",
    "tech-house",
    "techno",
    "edm",
    "future-bass",
    "dubstep",
    "dnb",
    "synthwave",
];

/// One written file.
#[derive(Clone, Debug)]
pub struct FactoryFile {
    /// Relative path with forward slashes ('drums/kick/punchy-club.wav').
    pub rel: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub legacy: bool,
    pub stat: SampleStat,
}

/// What `generate_factory` wrote.
#[derive(Clone, Debug)]
pub struct FactoryReport {
    pub dir: PathBuf,
    pub files: Vec<FactoryFile>,
    pub index_path: PathBuf,
    pub index: Vec<IndexEntry>,
    /// WAVs + index.json.
    pub total_bytes: u64,
    pub seconds: f64,
    /// Stale library WAVs from an older generation that were deleted.
    pub removed: Vec<PathBuf>,
}

impl FactoryReport {
    /// (top folder, files, bytes) in folder order.
    pub fn folder_counts(&self) -> Vec<(String, usize, u64)> {
        let mut out: Vec<(String, usize, u64)> = Vec::new();
        for f in &self.files {
            let top = f.rel.split('/').next().unwrap_or("").to_string();
            match out.iter_mut().find(|(k, _, _)| *k == top) {
                Some(e) => {
                    e.1 += 1;
                    e.2 += f.bytes;
                }
                None => out.push((top, 1, f.bytes)),
            }
        }
        out
    }

    /// Measurement table (per kind; `detail` adds one line per file).
    pub fn table(&self, detail: bool) -> String {
        let stats: Vec<SampleStat> = self.files.iter().map(|f| f.stat.clone()).collect();
        stats::table(&stats, detail)
    }
}

struct LegacyMeta {
    file: &'static str,
    name: &'static str,
    kind: &'static str,
    tags: &'static [&'static str],
    genres: &'static [&'static str],
    root: Option<u8>,
}

const LEGACY: [LegacyMeta; 11] = [
    LegacyMeta { file: "kick.wav", name: "Classic Kick", kind: "kick", tags: &["classic", "deep", "clean", "punchy"], genres: &[], root: None },
    LegacyMeta { file: "kick-2.wav", name: "Classic Kick 2", kind: "kick", tags: &["classic", "punchy", "hard", "short"], genres: &["house", "techno"], root: None },
    LegacyMeta { file: "snare.wav", name: "Classic Snare", kind: "snare", tags: &["classic", "bright"], genres: &[], root: None },
    LegacyMeta { file: "clap.wav", name: "Classic Clap", kind: "clap", tags: &["classic", "wide"], genres: &[], root: None },
    LegacyMeta { file: "hat-closed.wav", name: "Classic Closed Hat", kind: "hat", tags: &["classic", "short", "bright"], genres: &[], root: None },
    LegacyMeta { file: "hat-open.wav", name: "Classic Open Hat", kind: "openhat", tags: &["classic", "bright"], genres: &[], root: None },
    LegacyMeta { file: "rim.wav", name: "Classic Rim", kind: "rim", tags: &["classic", "short"], genres: &[], root: None },
    LegacyMeta { file: "perc.wav", name: "Classic Perc", kind: "perc", tags: &["classic", "metallic", "short"], genres: &[], root: None },
    LegacyMeta { file: "tom.wav", name: "Classic Tom", kind: "tom", tags: &["classic", "deep"], genres: &[], root: None },
    LegacyMeta { file: "crash.wav", name: "Classic Crash", kind: "crash", tags: &["classic", "bright", "long"], genres: &[], root: None },
    LegacyMeta { file: "808.wav", name: "Classic 808", kind: "808", tags: &["classic", "deep", "long"], genres: &["trap", "drill"], root: Some(36) },
];

/// Run `f(0..n)` on a small thread pool; results come back in index order
/// (so output never depends on scheduling). A panicking job becomes an Err.
fn parallel<T: Send>(n: usize, f: impl Fn(usize) -> T + Sync) -> Vec<Result<T, String>> {
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 12).min(n.max(1));
    let next = AtomicUsize::new(0);
    let slots: Mutex<Vec<Option<Result<T, String>>>> = Mutex::new((0..n).map(|_| None).collect());
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= n {
                    break;
                }
                let r = catch_unwind(AssertUnwindSafe(|| f(i))).map_err(|e| {
                    e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into())
                });
                slots.lock().unwrap_or_else(|p| p.into_inner())[i] = Some(r);
            });
        }
    });
    slots.into_inner().unwrap_or_else(|p| p.into_inner()).into_iter().map(|o| o.unwrap_or_else(|| Err("job did not run".into()))).collect()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension(format!("{}.tmp", path.extension().and_then(|e| e.to_str()).unwrap_or("")));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

fn rel_path(dir: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(dir.to_path_buf(), |p, s| p.join(s))
}

/// Render and write one library sample; returns the file record + index entry.
fn build_one(dir: &Path, spec: &library::Spec) -> io::Result<(FactoryFile, IndexEntry)> {
    let raw = (spec.render)();
    let ch = master::finish(raw, spec);
    let bytes = master::encode(&ch, spec.root, spec.bars.is_some(), &spec.rel);
    let path = rel_path(dir, &spec.rel);
    write_atomic(&path, &bytes)?;
    let frames = ch[0].len();
    let stat = stats::measure(&spec.rel, spec.kind, &ch, spec.root, bytes.len() as u64);
    let entry = IndexEntry {
        path: format!("factory:{}", spec.rel),
        name: spec.name.clone(),
        kind: spec.kind.to_string(),
        tags: spec.tags.iter().map(|s| s.to_string()).collect(),
        genres: spec.genres.iter().map(|s| s.to_string()).collect(),
        root_note: spec.root,
        length_sec: frames as f64 / synth::FS,
        channels: ch.len() as u8,
        bpm: spec.bars.map(|_| LIBRARY_BPM),
        bars: spec.bars,
        peak_db: spec.peak_db,
    };
    Ok((FactoryFile { rel: spec.rel.clone(), path, bytes: bytes.len() as u64, legacy: false, stat }, entry))
}

/// Delete `.wav` / `.tmp` files in the library folders that this generation did not write.
fn remove_stale(dir: &Path, keep: &std::collections::BTreeSet<PathBuf>) -> io::Result<Vec<PathBuf>> {
    fn walk(d: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
        for e in std::fs::read_dir(d)? {
            let p = e?.path();
            if p.is_dir() {
                walk(&p, out)?;
            } else {
                out.push(p);
            }
        }
        Ok(())
    }
    let mut removed = Vec::new();
    for top in LIBRARY_FOLDERS {
        let d = dir.join(top);
        if !d.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        walk(&d, &mut files)?;
        for p in files {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if (ext == "wav" || ext == "tmp") && !keep.contains(&p) {
                std::fs::remove_file(&p)?;
                removed.push(p);
            }
        }
    }
    Ok(removed)
}

/// Write the whole factory set into `dir`: the 11 legacy files (byte-identical
/// to `generate_kit`), the library, and `index.json` (FactoryIndex with
/// `generator`, e.g. "krypt-studio-engine 0.1.0").
pub fn generate_factory(dir: &Path, generator: &str) -> io::Result<FactoryReport> {
    let t0 = Instant::now();
    std::fs::create_dir_all(dir)?;
    let specs = library::specs();
    {
        let mut seen = std::collections::BTreeSet::new();
        for s in &specs {
            if !seen.insert(s.rel.clone()) {
                return Err(io::Error::other(format!("duplicate factory path {}", s.rel)));
            }
        }
    }

    // Legacy kit + library rendered in parallel (job 0 = the legacy kit).
    let results = parallel(specs.len() + 1, |i| -> io::Result<Vec<(FactoryFile, IndexEntry)>> {
        if i == 0 {
            let kit = render_kit();
            let paths = legacy::write_kit(dir, &kit)?;
            let mut out = Vec::new();
            for ((name, ch), path) in kit.iter().zip(paths) {
                let meta = LEGACY.iter().find(|m| m.file == *name).ok_or_else(|| io::Error::other(format!("no index metadata for legacy {name}")))?;
                let rel = format!("drums/{name}");
                let bytes = std::fs::metadata(&path)?.len();
                let stat = stats::measure(&rel, meta.kind, ch, meta.root, bytes);
                let entry = IndexEntry {
                    path: format!("factory:{rel}"),
                    name: meta.name.to_string(),
                    kind: meta.kind.to_string(),
                    tags: meta.tags.iter().map(|s| s.to_string()).collect(),
                    genres: meta.genres.iter().map(|s| s.to_string()).collect(),
                    root_note: meta.root,
                    length_sec: ch[0].len() as f64 / KIT_SAMPLE_RATE as f64,
                    channels: ch.len() as u8,
                    bpm: None,
                    bars: None,
                    peak_db: -1.0,
                };
                out.push((FactoryFile { rel, path, bytes, legacy: true, stat }, entry));
            }
            Ok(out)
        } else {
            build_one(dir, &specs[i - 1]).map(|x| vec![x])
        }
    });

    let mut files = Vec::new();
    let mut index = Vec::new();
    for (i, r) in results.into_iter().enumerate() {
        let what = if i == 0 { "the legacy kit".to_string() } else { specs[i - 1].rel.clone() };
        match r {
            Ok(Ok(v)) => {
                for (f, e) in v {
                    files.push(f);
                    index.push(e);
                }
            }
            Ok(Err(e)) => return Err(io::Error::new(e.kind(), format!("{what}: {e}"))),
            Err(p) => return Err(io::Error::other(format!("{what}: generator panicked: {p}"))),
        }
    }

    let json = index::to_json(generator, &index);
    let index_path = dir.join("index.json");
    write_atomic(&index_path, json.as_bytes())?;
    let keep: std::collections::BTreeSet<PathBuf> = files.iter().map(|f| f.path.clone()).collect();
    let removed = remove_stale(dir, &keep)?;
    let total_bytes = files.iter().map(|f| f.bytes).sum::<u64>() + json.len() as u64;
    Ok(FactoryReport { dir: dir.to_path_buf(), files, index_path, index, total_bytes, seconds: t0.elapsed().as_secs_f64(), removed })
}
