use super::synth::Chans;

pub(crate) type Render = Box<dyn Fn() -> Chans + Send + Sync>;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Finish {
    pub fade_in_ms: f32,
    pub fade_out_ms: f32,
    pub hp_hz: f32,
    pub trim_db: f32,
    pub looped: bool,
}

impl Default for Finish {
    fn default() -> Self {
        Self { fade_in_ms: 0.15, fade_out_ms: 8.0, hp_hz: 12.0, trim_db: -60.0, looped: false }
    }
}

pub(crate) struct Spec {
    pub rel: String,
    pub name: String,
    pub kind: &'static str,
    pub tags: Vec<&'static str>,
    pub genres: Vec<&'static str>,
    pub root: Option<u8>,
    pub bars: Option<u32>,
    pub peak_db: f32,
    pub fin: Finish,
    pub render: Render,
}

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

pub(crate) fn specs() -> Vec<Spec> {
    let mut v = Vec::new();
    v.extend(super::drums::specs());
    v.extend(super::perc::specs());
    v.extend(super::tonal::specs());
    v.extend(super::fx::specs());
    v.extend(super::textures::specs());
    v.extend(super::transitions::specs());
    v.extend(super::hits::specs());
    v.extend(super::vox::specs());
    v.extend(super::fills::specs());
    v.extend(super::ambient::specs());
    v
}
