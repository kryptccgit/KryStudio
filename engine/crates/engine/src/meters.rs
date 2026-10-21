use crate::program::{MAX_FX, NONE};
use krypt_studio_dsp::scope::{ScopeData, SlotScope};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::*};

pub const TAPS: usize = 4;
pub const TAP_FRAMES: usize = 16384;
const MASK: u64 = TAP_FRAMES as u64 - 1;

pub struct Tap {
    pub fx: AtomicU32,
    written: AtomicU64,
    l: Box<[AtomicU32]>,
    r: Box<[AtomicU32]>,
}

impl Tap {
    fn new() -> Self {
        let ring = || (0..TAP_FRAMES).map(|_| AtomicU32::new(0)).collect::<Vec<_>>().into_boxed_slice();
        Self { fx: AtomicU32::new(NONE), written: AtomicU64::new(0), l: ring(), r: ring() }
    }

    #[inline]
    fn push(&self, src: Option<(&[f32], &[f32])>, n: usize) {
        let w = self.written.load(Relaxed);
        for i in 0..n {
            let at = ((w + i as u64) & MASK) as usize;
            let (a, b) = match src {
                Some((l, r)) => (l[i], r[i]),
                None => (0.0, 0.0),
            };
            self.l[at].store(a.to_bits(), Relaxed);
            self.r[at].store(b.to_bits(), Relaxed);
        }
        self.written.store(w + n as u64, Release);
    }

    fn read(&self, from: &mut u64, l: &mut Vec<f32>, r: &mut Vec<f32>) {
        let w = self.written.load(Acquire);
        let start = (*from).max(w.saturating_sub(TAP_FRAMES as u64 / 2)).min(w);
        l.clear();
        r.clear();
        for k in start..w {
            let at = (k & MASK) as usize;
            l.push(f32::from_bits(self.l[at].load(Relaxed)));
            r.push(f32::from_bits(self.r[at].load(Relaxed)));
        }
        *from = w;
    }

    fn now(&self) -> u64 {
        self.written.load(Acquire)
    }
}

pub struct MeterShared {
    gr: Box<[AtomicU32]>,
    pub taps: [Tap; TAPS],
    pub watching: AtomicBool,
}

impl Default for MeterShared {
    fn default() -> Self {
        Self::new()
    }
}

impl MeterShared {
    pub fn new() -> Self {
        Self {
            gr: (0..MAX_FX).map(|_| AtomicU32::new(0)).collect::<Vec<_>>().into_boxed_slice(),
            taps: std::array::from_fn(|_| Tap::new()),
            watching: AtomicBool::new(false),
        }
    }

    #[inline]
    pub fn publish_gr(&self, fx: usize, db: Option<f32>) {
        if let (Some(db), Some(a)) = (db, self.gr.get(fx)) {
            if db > 0.0 && db.is_finite() {
                a.fetch_max(db.min(120.0).to_bits(), Relaxed);
            }
        }
    }

    pub fn take_gr(&self, fx: usize) -> f32 {
        self.gr.get(fx).map(|a| f32::from_bits(a.swap(0, Relaxed))).filter(|v| v.is_finite()).unwrap_or(0.0)
    }

    #[inline]
    pub fn tap(&self, fx: u32, src: Option<(&[f32], &[f32])>, n: usize) {
        if !self.watching.load(Relaxed) {
            return;
        }
        for t in &self.taps {
            if t.fx.load(Relaxed) == fx {
                t.push(src, n);
            }
        }
    }
}

pub fn collect_gr<'a>(m: &MeterShared, fx_names: &'a [(u32, String)]) -> Option<BTreeMap<&'a str, f32>> {
    let mut out = BTreeMap::new();
    for (slot, key) in fx_names {
        let v = m.take_gr(*slot as usize);
        let v = (v * 10.0).round() / 10.0;
        if v > 0.0 {
            out.insert(key.as_str(), v);
        }
    }
    (!out.is_empty()).then_some(out)
}

#[derive(serde::Deserialize)]
struct WatchMsg {
    t: String,
    #[serde(default)]
    slots: Vec<String>,
    #[serde(default)]
    reset: Vec<String>,
}

struct Watched {
    key: String,
    tap: usize,
    fx: u32,
    from: u64,
    scope: SlotScope,
}

#[derive(Default)]
pub struct Watcher {
    by_client: HashMap<String, Vec<String>>,
    resets: Vec<String>,
    active: Vec<Watched>,
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
}

impl Watcher {
    pub fn on_message(&mut self, client: &str, text: &str) -> bool {
        let Ok(m) = serde_json::from_str::<WatchMsg>(text) else { return false };
        if m.t != "watch" {
            return false;
        }
        let mut slots: Vec<String> = m.slots.into_iter().filter(|s| !s.is_empty() && s.len() <= 200).collect();
        slots.truncate(TAPS);
        self.by_client.insert(client.to_string(), slots);
        self.resets.extend(m.reset.into_iter().take(TAPS));
        true
    }

    pub fn drop_client(&mut self, client: &str) {
        self.by_client.remove(client);
    }

    pub fn wanted(&self) -> Vec<String> {
        let mut v: Vec<String> = self.by_client.values().flatten().cloned().collect();
        v.sort();
        v.dedup();
        v.truncate(TAPS);
        v
    }

    pub fn update(&mut self, m: &MeterShared, fx_names: &[(u32, String)], sample_rate: u32, restart: bool, full: bool) -> Option<BTreeMap<String, ScopeData>> {
        let wanted = self.wanted();
        let slot_of = |key: &str| fx_names.iter().find(|(_, k)| k == key).map(|(s, _)| *s);
        self.active.retain(|w| {
            let keep = wanted.contains(&w.key) && slot_of(&w.key) == Some(w.fx) && w.scope.sample_rate() == sample_rate.clamp(8000, 384_000);
            if !keep {
                m.taps[w.tap].fx.store(NONE, Relaxed);
            }
            keep
        });
        for key in &wanted {
            if self.active.iter().any(|w| &w.key == key) {
                continue;
            }
            let Some(fx) = slot_of(key) else { continue };
            let Some(tap) = (0..TAPS).find(|t| !self.active.iter().any(|w| w.tap == *t)) else { break };
            let from = m.taps[tap].now();
            m.taps[tap].fx.store(fx, Relaxed);
            self.active.push(Watched { key: key.clone(), tap, fx, from, scope: SlotScope::new(sample_rate) });
        }
        m.watching.store(!self.active.is_empty(), Relaxed);
        if self.active.is_empty() {
            self.resets.clear();
            return None;
        }
        let mut out = BTreeMap::new();
        let resets = std::mem::take(&mut self.resets);
        for w in self.active.iter_mut() {
            if restart || resets.contains(&w.key) {
                w.scope = SlotScope::new(sample_rate);
            }
            m.taps[w.tap].read(&mut w.from, &mut self.buf_l, &mut self.buf_r);
            w.scope.push(&self.buf_l, &self.buf_r);
            out.insert(w.key.clone(), w.scope.snapshot(full));
        }
        Some(out)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrStat {
    pub insert_id: String,
    pub slot_id: String,
    pub avg_db: f32,
    pub max_db: f32,
    pub active: f32,
}

#[derive(Default)]
pub struct GrAccum {
    slots: Vec<(u32, String, f64, f32, u32)>,
    blocks: u32,
}

impl GrAccum {
    pub fn new(fx_names: &[(u32, String)]) -> Self {
        Self { slots: fx_names.iter().map(|(s, k)| (*s, k.clone(), 0.0, 0.0, 0)).collect(), blocks: 0 }
    }

    pub fn sample(&mut self, m: &MeterShared) {
        self.blocks += 1;
        for (slot, _, sum, max, over) in self.slots.iter_mut() {
            let v = m.take_gr(*slot as usize);
            *sum += v as f64;
            *max = max.max(v);
            if v > 1.0 {
                *over += 1;
            }
        }
    }

    pub fn finish(self) -> Vec<GrStat> {
        let n = self.blocks.max(1) as f64;
        let r2 = |x: f64| ((x * 100.0).round() / 100.0) as f32;
        let mut v: Vec<GrStat> = self
            .slots
            .into_iter()
            .filter(|s| s.3 > 0.0)
            .map(|(_, key, sum, max, over)| {
                let (ins, slot) = key.split_once('/').unwrap_or((key.as_str(), ""));
                GrStat { insert_id: ins.to_string(), slot_id: slot.to_string(), avg_db: r2(sum / n), max_db: r2(max as f64), active: r2(over as f64 / n) }
            })
            .collect();
        v.sort_by(|a, b| (&a.insert_id, &a.slot_id).cmp(&(&b.insert_id, &b.slot_id)));
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gr_is_max_since_last_read_and_only_non_zero_is_sent() {
        let m = MeterShared::new();
        m.publish_gr(3, Some(2.0));
        m.publish_gr(3, Some(5.04));
        m.publish_gr(3, Some(1.0));
        m.publish_gr(4, Some(0.0));
        m.publish_gr(5, None);
        m.publish_gr(MAX_FX + 1, Some(9.0));
        let names = vec![(3, "ins/a".to_string()), (4, "ins/b".to_string()), (5, "ins/c".to_string())];
        let g = collect_gr(&m, &names).unwrap();
        assert_eq!(g.len(), 1);
        assert_eq!(g["ins/a"], 5.0);
        assert!(collect_gr(&m, &names).is_none(), "read resets");
    }

    #[test]
    fn watched_slot_streams_through_the_tap() {
        let m = MeterShared::new();
        let names = vec![(7, "ins1/eq".to_string()), (9, "ins1/an".to_string())];
        let mut w = Watcher::default();
        assert!(w.on_message("a", r#"{"t":"watch","slots":["ins1/an"]}"#));
        assert!(!w.on_message("a", r#"{"t":"other"}"#));
        assert!(w.on_message("a", r#"{"t":"watch","slots":["ins1/an"],"reset":["ins1/an"]}"#));
        assert!(!w.on_message("a", "garbage"));
        assert!(w.update(&m, &names, 48000, false, true).is_some());
        assert!(m.watching.load(Relaxed));
        let x: Vec<f32> = (0..28800).map(|i| 0.1 * (std::f32::consts::TAU * 997.0 * i as f32 / 48000.0).sin()).collect();
        let mut s = None;
        for part in x.chunks(4800) {
            for c in part.chunks(32) {
                m.tap(9, Some((c, c)), c.len());
                m.tap(7, None, c.len());
            }
            s = w.update(&m, &names, 48000, false, true);
        }
        let s = s.unwrap();
        let d = &s["ins1/an"];
        assert!((d.lufs_m.unwrap() + 20.0).abs() < 0.3, "{:?}", d.lufs_m);
        assert_eq!(d.spectrum.as_ref().unwrap().len(), krypt_studio_dsp::scope::SCOPE_BINS);
        let full = serde_json::to_string(d).unwrap().len();
        assert!(full < 3000, "{full} bytes");
        assert!(w.on_message("b", r#"{"t":"watch","slots":["ins1/eq","ins1/an"]}"#));
        let s = w.update(&m, &names, 48000, false, false).unwrap();
        assert_eq!(s.len(), 2);
        assert!(s["ins1/eq"].spectrum.is_none());
        w.drop_client("a");
        w.drop_client("b");
        assert!(w.update(&m, &names, 48000, false, true).is_none());
        assert!(!m.watching.load(Relaxed));
        assert!(m.taps.iter().all(|t| t.fx.load(Relaxed) == NONE));
    }

    #[test]
    fn render_accumulates_average_and_max() {
        let m = MeterShared::new();
        let names = vec![(1, "drums/comp".to_string()), (2, "drums/eq".to_string())];
        let mut acc = GrAccum::new(&names);
        for v in [0.0, 2.0, 4.0, 6.0] {
            m.publish_gr(1, Some(v));
            acc.sample(&m);
        }
        let s = acc.finish();
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].insert_id.as_str(), s[0].slot_id.as_str()), ("drums", "comp"));
        assert_eq!((s[0].avg_db, s[0].max_db, s[0].active), (3.0, 6.0, 0.75));
    }
}
