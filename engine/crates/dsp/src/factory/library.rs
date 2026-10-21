//! The library's sample list: one `Spec` per file (path, display name,
//! index metadata, mastering options and the recipe that renders it).

use super::synth::Chans;

pub(crate) type Render = Box<dyn Fn() -> Chans + Send + Sync>;

/// Per-file mastering options (see `master::finish`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Finish {
    /// Raised-cosine fade-in (ms). Small: transients stay on sample 0.
    pub fade_in_ms: f32,
    /// Fade-out at the (trimmed or exact) end (ms).
    pub fade_out_ms: f32,
    /// 2nd-order high pass that removes DC / subsonics (Hz).
    pub hp_hz: f32,
    /// Trailing material below this level (dB relative to the peak) is trimmed.
    pub trim_db: f32,
    /// Seamless loop: no filtering or fades (the recipe crossfaded the seam).
    pub looped: bool,
}

impl Default for Finish {
    fn default() -> Self {
        Self { fade_in_ms: 0.15, fade_out_ms: 8.0, hp_hz: 12.0, trim_db: -60.0, looped: false }
    }
}

pub(crate) struct Spec {
    /// Path relative to the factory dir, forward slashes ('drums/kick/punchy-club.wav').
    pub rel: String,
    pub name: String,
    pub kind: &'static str,
    pub tags: Vec<&'static str>,
    pub genres: Vec<&'static str>,
    pub root: Option<u8>,
    /// Tempo-synced at 128 BPM and exactly this many bars long.
    pub bars: Option<u32>,
    /// True-peak normalisation target (dBFS).
    pub peak_db: f32,
    pub fin: Finish,
    pub render: Render,
}

/// A one-shot normalised to -1 dBFS true peak.
pub(crate) fn spec(
    rel: impl Into<String>,
    name: impl Into<String>,
    kind: &'static str,
    tags: &[&'static str],
    genres: &[&'static str],
    render: impl Fn() -> Chans + Send + Sync + 'static,
) -> Spec {
    Spec {
        rel: rel.into(),
        name: name.into(),
        kind,
        tags: tags.to_vec(),
        genres: genres.to_vec(),
        root: None,
        bars: None,
        peak_db: -1.0,
        fin: Finish::default(),
        render: Box::new(render),
    }
}

impl Spec {
    pub fn root(mut self, note: u8) -> Self {
        self.root = Some(note);
        self
    }
    /// Tempo-synced: exactly `bars` bars at 128 BPM (no trimming).
    pub fn bars(mut self, bars: u32) -> Self {
        self.bars = Some(bars);
        self
    }
    pub fn peak(mut self, db: f32) -> Self {
        self.peak_db = db;
        self
    }
    pub fn fades(mut self, in_ms: f32, out_ms: f32) -> Self {
        self.fin.fade_in_ms = in_ms;
        self.fin.fade_out_ms = out_ms;
        self
    }
    pub fn hp(mut self, hz: f32) -> Self {
        self.fin.hp_hz = hz;
        self
    }
    pub fn trim(mut self, db: f32) -> Self {
        self.fin.trim_db = db;
        self
    }
    pub fn looped(mut self) -> Self {
        self.fin.looped = true;
        self
    }
}

/// Every library sample, in index order.
pub(crate) fn specs() -> Vec<Spec> {
    let mut v = Vec::new();
    v.extend(super::drums::specs());
    v.extend(super::perc::specs());
    v.extend(super::tonal::specs());
    v.extend(super::fx::specs());
    v.extend(super::textures::specs());
    // Wave 7b (research/14 §2.1)
    v.extend(super::transitions::specs());
    v.extend(super::hits::specs());
    v.extend(super::vox::specs());
    v.extend(super::fills::specs());
    v.extend(super::ambient::specs());
    v
}
