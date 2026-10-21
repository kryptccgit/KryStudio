//! krypt.eq — 7-band parametric EQ on TPT SVFs (exact gain at the centre
//! frequency, stable under automation). Cuts are Butterworth cascades
//! (12/24/48 dB/oct). Parameters are smoothed; coefficients update every
//! 16 samples while moving.

use super::{frames, sane_sr, sanitize_block};
use crate::blocks::filters::{Svf, SvfMode, BUTTER_Q_2, BUTTER_Q_4, BUTTER_Q_8};
use crate::blocks::{db_to_gain, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

const SLOPES: [&str; 3] = ["12 dB/oct", "24 dB/oct", "48 dB/oct"];

param_table! {
    B1On => toggle("b1On", "On", false, "Low cut"),
    B1Freq => logp("b1Freq", "Freq", 20.0, 2000.0, 30.0, "Hz", "Low cut"),
    B1Slope => choice("b1Slope", "Slope", &SLOPES, 1, "Low cut"),
    B2On => toggle("b2On", "On", true, "Low shelf"),
    B2Freq => logp("b2Freq", "Freq", 20.0, 2000.0, 100.0, "Hz", "Low shelf"),
    B2Gain => lin("b2Gain", "Gain", -18.0, 18.0, 0.0, "dB", "Low shelf"),
    B2Q => logp("b2Q", "Q", 0.1, 4.0, 0.7, "", "Low shelf"),
    B3On => toggle("b3On", "On", true, "Peak 1"),
    B3Freq => logp("b3Freq", "Freq", 20.0, 20000.0, 400.0, "Hz", "Peak 1"),
    B3Gain => lin("b3Gain", "Gain", -18.0, 18.0, 0.0, "dB", "Peak 1"),
    B3Q => logp("b3Q", "Q", 0.1, 18.0, 1.0, "", "Peak 1"),
    B4On => toggle("b4On", "On", true, "Peak 2"),
    B4Freq => logp("b4Freq", "Freq", 20.0, 20000.0, 1500.0, "Hz", "Peak 2"),
    B4Gain => lin("b4Gain", "Gain", -18.0, 18.0, 0.0, "dB", "Peak 2"),
    B4Q => logp("b4Q", "Q", 0.1, 18.0, 1.0, "", "Peak 2"),
    B5On => toggle("b5On", "On", true, "Peak 3"),
    B5Freq => logp("b5Freq", "Freq", 20.0, 20000.0, 5000.0, "Hz", "Peak 3"),
    B5Gain => lin("b5Gain", "Gain", -18.0, 18.0, 0.0, "dB", "Peak 3"),
    B5Q => logp("b5Q", "Q", 0.1, 18.0, 1.0, "", "Peak 3"),
    B6On => toggle("b6On", "On", true, "High shelf"),
    B6Freq => logp("b6Freq", "Freq", 1000.0, 20000.0, 10000.0, "Hz", "High shelf"),
    B6Gain => lin("b6Gain", "Gain", -18.0, 18.0, 0.0, "dB", "High shelf"),
    B6Q => logp("b6Q", "Q", 0.1, 4.0, 0.7, "", "High shelf"),
    B7On => toggle("b7On", "On", false, "High cut"),
    B7Freq => logp("b7Freq", "Freq", 1000.0, 20000.0, 18000.0, "Hz", "High cut"),
    B7Slope => choice("b7Slope", "Slope", &SLOPES, 1, "High cut"),
    Output => lin("output", "Output", -24.0, 24.0, 0.0, "dB", "Output"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.eq",
        name: "Krypt EQ",
        kind: PluginKind::Effect,
        category: "EQ",
        description: "7-band parametric EQ: low cut, low shelf, 3 bells, high shelf, high cut (12/24/48 dB/oct). \
                      Analog-matched gain at each band's frequency, zero latency, smooth under automation.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

const CHUNK: usize = 16;

/// Smoothed band state (log2 frequency, dB gain, log2 Q).
#[derive(Clone, Copy)]
struct BandSm {
    lf: Smooth,
    db: Smooth,
    lq: Smooth,
}

impl BandSm {
    fn new(f: f32, db: f32, q: f32, sr: f32) -> Self {
        Self { lf: Smooth::with_time(f.log2(), 25.0, sr), db: Smooth::with_time(db, 25.0, sr), lq: Smooth::with_time(q.log2(), 25.0, sr) }
    }
    fn set(&mut self, f: f32, db: f32, q: f32) {
        self.lf.set(f.log2());
        self.db.set(db);
        self.lq.set(q.log2());
    }
    fn settled(&self) -> bool {
        self.lf.settled() && self.db.settled() && self.lq.settled()
    }
    fn advance(&mut self, n: usize) -> (f64, f64, f64) {
        (self.lf.advance(n).exp2() as f64, self.db.advance(n) as f64, self.lq.advance(n).exp2() as f64)
    }
}

pub struct Eq {
    pb: ParamBank<N_PARAMS>,
    /// snap smoothers on the first block after creation / prepare / reset
    fresh: bool,
    sr: f32,
    // [channel][section]
    lc: [[Svf; 4]; 2],
    hc: [[Svf; 4]; 2],
    bands: [[Svf; 5]; 2],
    lc_sm: BandSm,
    hc_sm: BandSm,
    band_sm: [BandSm; 5],
    lc_mix: Smooth,
    hc_mix: Smooth,
    lc_n: usize,
    hc_n: usize,
    out_gain: Smooth,
    dirty_coefs: bool,
}

const BAND_PARAMS: [(P, P, P, P); 5] = [
    (P::B2On, P::B2Freq, P::B2Gain, P::B2Q),
    (P::B3On, P::B3Freq, P::B3Gain, P::B3Q),
    (P::B4On, P::B4Freq, P::B4Gain, P::B4Q),
    (P::B5On, P::B5Freq, P::B5Gain, P::B5Q),
    (P::B6On, P::B6Freq, P::B6Gain, P::B6Q),
];
const BAND_MODES: [SvfMode; 5] = [SvfMode::LowShelf, SvfMode::Bell, SvfMode::Bell, SvfMode::Bell, SvfMode::HighShelf];

fn slope_sections(i: usize) -> (usize, &'static [f64]) {
    match i {
        0 => (1, &BUTTER_Q_2),
        1 => (2, &BUTTER_Q_4),
        _ => (4, &BUTTER_Q_8),
    }
}

impl Eq {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let mut e = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            lc: [[Svf::default(); 4]; 2],
            hc: [[Svf::default(); 4]; 2],
            bands: [[Svf::default(); 5]; 2],
            lc_sm: BandSm::new(30.0, 0.0, 0.707, sr),
            hc_sm: BandSm::new(18000.0, 0.0, 0.707, sr),
            band_sm: [BandSm::new(1000.0, 0.0, 1.0, sr); 5],
            lc_mix: Smooth::with_time(0.0, 10.0, sr),
            hc_mix: Smooth::with_time(0.0, 10.0, sr),
            lc_n: 2,
            hc_n: 2,
            out_gain: Smooth::with_time(1.0, 20.0, sr),
            dirty_coefs: true,
        };
        e.update(true);
        e.design_all();
        e
    }

    fn update(&mut self, snap: bool) {
        let p = &self.pb;
        self.lc_sm.set(p.get(P::B1Freq as usize), 0.0, 0.707);
        self.hc_sm.set(p.get(P::B7Freq as usize), 0.0, 0.707);
        self.lc_mix.set(if p.on(P::B1On as usize) { 1.0 } else { 0.0 });
        self.hc_mix.set(if p.on(P::B7On as usize) { 1.0 } else { 0.0 });
        self.lc_n = p.idx(P::B1Slope as usize).min(2);
        self.hc_n = p.idx(P::B7Slope as usize).min(2);
        for (b, &(on, f, g, q)) in BAND_PARAMS.iter().enumerate() {
            let db = if p.on(on as usize) { p.get(g as usize) } else { 0.0 };
            self.band_sm[b].set(p.get(f as usize), db, p.get(q as usize));
        }
        self.out_gain.set(db_to_gain(p.get(P::Output as usize)));
        if snap {
            for s in [&mut self.lc_sm, &mut self.hc_sm].into_iter().chain(self.band_sm.iter_mut()) {
                s.lf.reset(s.lf.target);
                s.db.reset(s.db.target);
                s.lq.reset(s.lq.target);
            }
            self.lc_mix.reset(self.lc_mix.target);
            self.hc_mix.reset(self.hc_mix.target);
            self.out_gain.reset(self.out_gain.target);
        }
        self.dirty_coefs = true;
    }

    fn design_all(&mut self) {
        let fs = self.sr as f64;
        let (n, qs) = slope_sections(self.lc_n);
        let (f, _, _) = self.lc_sm.advance(0);
        for ch in 0..2 {
            for (s, q) in qs.iter().enumerate().take(n) {
                self.lc[ch][s].design(SvfMode::Highpass, f, *q, 0.0, fs);
            }
        }
        let (n, qs) = slope_sections(self.hc_n);
        let (f, _, _) = self.hc_sm.advance(0);
        for ch in 0..2 {
            for (s, q) in qs.iter().enumerate().take(n) {
                self.hc[ch][s].design(SvfMode::Lowpass, f.min(fs * 0.49), *q, 0.0, fs);
            }
        }
        for b in 0..5 {
            let (f, db, q) = self.band_sm[b].advance(0);
            for ch in 0..2 {
                self.bands[ch][b].design(BAND_MODES[b], f.min(fs * 0.49), q, db, fs);
            }
        }
    }

    fn advance_and_design(&mut self, n: usize) {
        let fs = self.sr as f64;
        if !self.lc_sm.settled() || self.dirty_coefs {
            let (f, _, _) = self.lc_sm.advance(n);
            let (cnt, qs) = slope_sections(self.lc_n);
            for ch in 0..2 {
                for (s, q) in qs.iter().enumerate().take(cnt) {
                    self.lc[ch][s].design(SvfMode::Highpass, f, *q, 0.0, fs);
                }
            }
        }
        if !self.hc_sm.settled() || self.dirty_coefs {
            let (f, _, _) = self.hc_sm.advance(n);
            let (cnt, qs) = slope_sections(self.hc_n);
            for ch in 0..2 {
                for (s, q) in qs.iter().enumerate().take(cnt) {
                    self.hc[ch][s].design(SvfMode::Lowpass, f.min(fs * 0.49), *q, 0.0, fs);
                }
            }
        }
        for b in 0..5 {
            if !self.band_sm[b].settled() || self.dirty_coefs {
                let (f, db, q) = self.band_sm[b].advance(n);
                for ch in 0..2 {
                    self.bands[ch][b].design(BAND_MODES[b], f.min(fs * 0.49), q, db, fs);
                }
            }
        }
        self.dirty_coefs = false;
    }
}

impl Eq {
    fn snap(&mut self) {
        self.update(true);
        self.design_all();
    }
}

impl Effect for Eq {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let pb_vals: Vec<f32> = (0..N_PARAMS).map(|i| self.pb.get(i)).collect();
        *self = Eq::new(sample_rate, max_frames);
        for (i, v) in pb_vals.into_iter().enumerate() {
            self.pb.set(i, v);
        }
        self.update(true);
        self.design_all();
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn process(&mut self, ctx: &ProcessContext, mut buf: [&mut [f32]; 2], _sc: Option<[&[f32]; 2]>) {
        let n = frames(ctx, &buf);
        if self.pb.take_dirty() {
            self.update(false);
        }
        if self.fresh {
            self.fresh = false;
            self.snap();
        }
        let mut at = 0;
        while at < n {
            let m = (n - at).min(CHUNK);
            self.advance_and_design(m);
            let (lcn, _) = slope_sections(self.lc_n);
            let (hcn, _) = slope_sections(self.hc_n);
            let band_active: [bool; 5] = core::array::from_fn(|b| {
                let s = &self.band_sm[b];
                !(s.db.settled() && s.db.cur == 0.0)
            });
            // inactive bands hold no stale state for when they come back
            for (b, &on) in band_active.iter().enumerate() {
                if !on {
                    self.bands[0][b].reset();
                    self.bands[1][b].reset();
                }
            }
            if self.lc_mix.settled() && self.lc_mix.cur == 0.0 {
                self.lc.iter_mut().flatten().for_each(Svf::reset);
            }
            if self.hc_mix.settled() && self.hc_mix.cur == 0.0 {
                self.hc.iter_mut().flatten().for_each(Svf::reset);
            }
            for i in at..at + m {
                let lm = self.lc_mix.next();
                let hm = self.hc_mix.next();
                let g = self.out_gain.next();
                for ch in 0..2 {
                    let x = buf[ch][i] as f64;
                    let mut y = x;
                    if lm > 0.0 {
                        let mut f = y;
                        for s in 0..lcn {
                            f = self.lc[ch][s].tick(f);
                        }
                        y = y + (f - y) * lm as f64;
                    }
                    for b in 0..5 {
                        if band_active[b] {
                            y = self.bands[ch][b].tick(y);
                        }
                    }
                    if hm > 0.0 {
                        let mut f = y;
                        for s in 0..hcn {
                            f = self.hc[ch][s].tick(f);
                        }
                        y = y + (f - y) * hm as f64;
                    }
                    buf[ch][i] = (y as f32) * g;
                }
            }
            at += m;
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        for ch in 0..2 {
            self.lc[ch].iter_mut().for_each(Svf::reset);
            self.hc[ch].iter_mut().for_each(Svf::reset);
            self.bands[ch].iter_mut().for_each(Svf::reset);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::blocks::filters::{Svf, SvfMode, BUTTER_Q_8};

    #[test]
    fn butterworth8_analytic() {
        let fs = 48000.0;
        let mut db = 0.0;
        for q in BUTTER_Q_8 {
            let mut s = Svf::default();
            s.design(SvfMode::Highpass, 400.0, q, 0.0, fs);
            db += 20.0 * s.magnitude(100.0, fs).log10();
        }
        let ideal = -10.0 * (1.0f64 + 4f64.powi(16)).log10();
        assert!((db - ideal).abs() < 0.3, "{db} vs {ideal}");
    }

    /// The Krypt EQ window draws this response in TypeScript (src/panels/plugin/eqResponse.ts); its unit
    /// test (test/meters.test.ts) checks the same params and frequencies against these numbers.
    #[test]
    fn combined_response_reference_values() {
        use super::{Eq, P};
        use crate::{Effect, ProcessContext};
        let mut e = Eq::new(48000.0, 64);
        for (p, v) in [
            (P::B1On, 1.0), (P::B1Freq, 80.0), (P::B1Slope, 1.0),
            (P::B2Freq, 200.0), (P::B2Gain, 4.0), (P::B2Q, 0.7),
            (P::B3Freq, 400.0), (P::B3Gain, -6.0), (P::B3Q, 2.0),
            (P::B4Freq, 1500.0), (P::B4Gain, 3.0), (P::B4Q, 1.0),
            (P::B6Freq, 10000.0), (P::B6Gain, -3.0), (P::B6Q, 0.7),
            (P::B7On, 1.0), (P::B7Freq, 16000.0), (P::B7Slope, 0.0),
            (P::Output, 2.0),
        ] {
            e.set_param(p as usize, v);
        }
        let (mut l, mut r) = (vec![0.0f32; 64], vec![0.0f32; 64]);
        e.process(&ProcessContext { sample_rate: 48000.0, bpm: 120.0, beats_per_bar: 4.0, playing: false, beat_pos: 0.0, frames: 64 }, [&mut l, &mut r], None);
        let fs = 48000.0;
        let resp = |f: f64| {
            let mut db = 2.0;
            for s in e.lc[0].iter().take(2) {
                db += 20.0 * s.magnitude(f, fs).log10();
            }
            for s in e.bands[0].iter() {
                db += 20.0 * s.magnitude(f, fs).log10();
            }
            db += 20.0 * e.hc[0][0].magnitude(f, fs).log10();
            db
        };
        let want = [
            (30.0, REF_DB[0]), (80.0, REF_DB[1]), (200.0, REF_DB[2]), (400.0, REF_DB[3]), (1000.0, REF_DB[4]),
            (1500.0, REF_DB[5]), (5000.0, REF_DB[6]), (10000.0, REF_DB[7]), (16000.0, REF_DB[8]), (20000.0, REF_DB[9]),
        ];
        let got: Vec<f64> = want.iter().map(|(f, _)| resp(*f)).collect();
        for ((f, w), g) in want.iter().zip(&got) {
            assert!((g - w).abs() < 1e-3, "{f} Hz: {g} vs {w}");
        }
    }

    const REF_DB: [f64; 10] = [-28.091401, 2.813753, 3.418132, -3.510774, 3.427807, 4.871380, 2.138428, 0.385178, -3.876857, -14.522336];
}
