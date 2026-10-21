use super::sfz::{LoopMode, OffMode, RegionDef, Trigger, KEYCENTER_FROM_SAMPLE};
use crate::SampleData;
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) const I16_SCALE: f32 = 1.0 / 32768.0;

#[derive(Debug, Clone)]
pub struct MsSample {
    pub data: Vec<i16>,
    pub channels: usize,
    pub frames: usize,
    pub sample_rate: f32,
    pub root_key: Option<u8>,
    pub tail_fade: usize,
}

#[inline]
pub(crate) fn to_i16(x: f32) -> i16 {
    if x.is_finite() {
        (x * 32767.0).round().clamp(-32768.0, 32767.0) as i16
    } else {
        0
    }
}

impl MsSample {
    pub fn from_planar(channels: &[&[f32]], sample_rate: f32, root_key: Option<u8>, trimmed: bool) -> Self {
        let ch = channels.len().clamp(1, 2);
        let frames = channels.iter().take(2).map(|c| c.len()).min().unwrap_or(0);
        let mut data = Vec::with_capacity(frames * ch);
        if channels.is_empty() {
            return Self { data, channels: 1, frames: 0, sample_rate, root_key, tail_fade: 1 };
        }
        for i in 0..frames {
            for c in channels.iter().take(ch) {
                data.push(to_i16(c[i]));
            }
        }
        let tail_fade = tail_fade_frames(frames, sample_rate, trimmed);
        Self { data, channels: ch, frames, sample_rate, root_key, tail_fade }
    }

    pub fn bytes(&self) -> usize {
        self.data.len() * std::mem::size_of::<i16>()
    }
}

pub(crate) fn tail_fade_frames(frames: usize, sample_rate: f32, trimmed: bool) -> usize {
    let sr = if sample_rate.is_finite() && sample_rate > 0.0 { sample_rate } else { 48000.0 };
    let ms = if trimmed { 100.0 } else { 2.0 };
    let want = (ms * 0.001 * sr) as usize;
    let cap = if trimmed { frames / 10 } else { frames / 4 };
    want.min(cap).max(1)
}

#[derive(Debug, Clone)]
pub struct Region {
    pub sample: u32,
    pub lokey: u8,
    pub hikey: u8,
    pub lovel: u8,
    pub hivel: u8,
    pub keycenter: f32,
    pub keytrack: f32,
    pub pitch_offset: f32,
    pub gain: f32,
    pub pan: f32,
    pub veltrack: f32,
    pub xfin_lo: f32,
    pub xfin_hi: f32,
    pub xfout_lo: f32,
    pub xfout_hi: f32,
    pub loop_mode: LoopMode,
    pub loop_start: usize,
    pub loop_end: usize,
    pub delay_ms: f32,
    pub attack_ms: f32,
    pub hold_ms: f32,
    pub decay_ms: f32,
    pub sustain: f32,
    pub release_ms: f32,
    pub trigger: Trigger,
    pub rt_decay: f32,
    pub seq_length: u32,
    pub seq_position: u32,
    pub lorand: f32,
    pub hirand: f32,
    pub group: i64,
    pub off_by: i64,
    pub off_mode: OffMode,
}

impl Region {
    pub fn from_def(d: &RegionDef, sample: u32, smp: &MsSample, offset: u64) -> Self {
        let key = |k: i32| k.clamp(0, 127) as u8;
        let keycenter = if d.pitch_keycenter == KEYCENTER_FROM_SAMPLE {
            smp.root_key.map(|k| k as f32).unwrap_or(60.0)
        } else {
            d.pitch_keycenter.clamp(-127.0, 254.0)
        };
        let loop_mode = d.loop_mode.unwrap_or(LoopMode::NoLoop);
        let frames = smp.frames;
        let ls = d.loop_start.map(|s| s.saturating_sub(offset) as usize).unwrap_or(0).min(frames);
        let le = d.loop_end.map(|e| (e + 1).saturating_sub(offset) as usize).unwrap_or(frames).min(frames);
        let (ls, le) = if le > ls + 1 { (ls, le) } else { (0, frames) };
        let secs = |s: f32| if s.is_finite() { s.clamp(0.0, 100.0) * 1000.0 } else { 0.0 };
        let (lokey, hikey) = (d.lokey, d.hikey);
        Self {
            sample,
            lokey: if lokey > 127 || hikey < 0 || lokey > hikey { 1 } else { key(lokey) },
            hikey: if lokey > 127 || hikey < 0 || lokey > hikey { 0 } else { key(hikey) },
            lovel: d.lovel.clamp(0, 127) as u8,
            hivel: d.hivel.clamp(0, 127) as u8,
            keycenter,
            keytrack: if d.pitch_keytrack.is_finite() { d.pitch_keytrack.clamp(-1200.0, 1200.0) / 100.0 } else { 1.0 },
            pitch_offset: d.transpose.clamp(-127, 127) as f32 + if d.tune.is_finite() { d.tune.clamp(-9600.0, 9600.0) / 100.0 } else { 0.0 },
            gain: crate::blocks::db_to_gain(if d.volume.is_finite() { d.volume.clamp(-144.0, 24.0) } else { 0.0 }),
            pan: if d.pan.is_finite() { d.pan.clamp(-100.0, 100.0) / 100.0 } else { 0.0 },
            veltrack: if d.amp_veltrack.is_finite() { d.amp_veltrack.clamp(-100.0, 100.0) / 100.0 } else { 1.0 },
            xfin_lo: d.xfin_lovel.clamp(0, 127) as f32,
            xfin_hi: d.xfin_hivel.clamp(0, 127) as f32,
            xfout_lo: d.xfout_lovel.clamp(0, 127) as f32,
            xfout_hi: d.xfout_hivel.clamp(0, 127) as f32,
            loop_mode,
            loop_start: ls,
            loop_end: le,
            delay_ms: secs(d.ampeg_delay),
            attack_ms: secs(d.ampeg_attack),
            hold_ms: secs(d.ampeg_hold),
            decay_ms: secs(d.ampeg_decay),
            sustain: if d.ampeg_sustain.is_finite() { d.ampeg_sustain.clamp(0.0, 100.0) / 100.0 } else { 1.0 },
            release_ms: secs(d.ampeg_release),
            trigger: d.trigger,
            rt_decay: if d.rt_decay.is_finite() { d.rt_decay.clamp(0.0, 200.0) } else { 0.0 },
            seq_length: d.seq_length.max(1),
            seq_position: d.seq_position.clamp(1, d.seq_length.max(1)),
            lorand: if d.lorand.is_finite() { d.lorand.clamp(0.0, 1.0) } else { 0.0 },
            hirand: if d.hirand.is_finite() { d.hirand.clamp(0.0, 1.0) } else { 1.0 },
            group: d.group,
            off_by: d.off_by,
            off_mode: d.off_mode,
        }
    }

    #[inline]
    pub fn vel_matches(&self, vel: u8) -> bool {
        vel >= self.lovel && vel <= self.hivel
    }

    #[inline]
    pub fn rand_matches(&self, r: f32) -> bool {
        r >= self.lorand && (r < self.hirand || (self.hirand >= 1.0 && r <= 1.0))
    }

    #[inline]
    pub fn xfade_gain(&self, vel: f32) -> f32 {
        let mut g = 1.0f32;
        if self.xfin_hi > self.xfin_lo {
            let x = ((vel - self.xfin_lo) / (self.xfin_hi - self.xfin_lo)).clamp(0.0, 1.0);
            g *= x.sqrt();
        }
        if self.xfout_hi > self.xfout_lo {
            let x = ((self.xfout_hi - vel) / (self.xfout_hi - self.xfout_lo)).clamp(0.0, 1.0);
            g *= x.sqrt();
        }
        g
    }
}

static NEXT_SET_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub struct MultiSampleSet {
    pub name: String,
    pub samples: Vec<MsSample>,
    pub regions: Vec<Region>,
    key_index: Vec<u32>,
    key_start: Vec<u32>,
    pub report: Vec<(&'static str, String)>,
    pub load_ms: f64,
    pub id: u64,
}

impl MultiSampleSet {
    pub fn new(name: String, samples: Vec<MsSample>, regions: Vec<Region>) -> Self {
        let mut key_start = Vec::with_capacity(129);
        let mut key_index = Vec::new();
        for k in 0..128u8 {
            key_start.push(key_index.len() as u32);
            for (i, r) in regions.iter().enumerate() {
                if r.lokey <= k && k <= r.hikey && (r.sample as usize) < samples.len() {
                    key_index.push(i as u32);
                }
            }
        }
        key_start.push(key_index.len() as u32);
        Self { name, samples, regions, key_index, key_start, report: Vec::new(), load_ms: 0.0, id: NEXT_SET_ID.fetch_add(1, Ordering::Relaxed) }
    }

    #[inline]
    pub fn regions_for_key(&self, key: u8) -> &[u32] {
        let k = key.min(127) as usize;
        let (a, b) = (self.key_start[k] as usize, self.key_start[k + 1] as usize);
        &self.key_index[a..b]
    }

    pub fn bytes(&self) -> usize {
        self.samples.iter().map(MsSample::bytes).sum()
    }

    pub fn from_sample_data(name: &str, sd: &SampleData) -> Self {
        let chans: Vec<&[f32]> = sd.channels.iter().take(2).map(|c| c.as_slice()).collect();
        let sr = if sd.sample_rate.is_finite() && sd.sample_rate > 0.0 { sd.sample_rate } else { 48000.0 };
        let smp = MsSample::from_planar(&chans, sr, sd.root_key, false);
        let def = RegionDef { pitch_keycenter: KEYCENTER_FROM_SAMPLE, lovel: 0, ..Default::default() };
        let region = Region::from_def(&def, 0, &smp, 0);
        Self::new(name.to_string(), vec![smp], vec![region])
    }
}
