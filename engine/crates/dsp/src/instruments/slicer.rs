use std::sync::Arc;

use super::sampler::{reso_to_k, sanitize_sr, svf_typed};
use super::{instrument_process, usable_frames, NoteStart, OutStage, Voice, VoiceManager, CHOKE_MS};
use crate::blocks::env::{Ahdsr, EnvParams};
use crate::blocks::filters::{svf_g, Svf};
use crate::blocks::sinc::{apply, SincTable, MAX_TAPS};
use crate::blocks::{db_to_gain, pan_gains, vel_gain, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Instrument, NoteExtras, PluginDescriptor, PluginKind, ProcessContext, SampleData};

pub const PLUGIN_ID: &str = "krypt.slicer";
pub const MAX_SLICES: usize = 128;

param_table! {
    BaseKey => stepped("baseKey", "First key", 0.0, 127.0, 60.0, "", 1.0, "Slices"),
    Trigger => choice("trigger", "Trigger", &["One-shot", "Gate"], 0, "Slices"),
    PlayTo => choice("playTo", "Play to", &["Slice end", "Sample end"], 0, "Slices"),
    Cut => toggle("cut", "Cut previous", true, "Slices"),
    Reverse => toggle("reverse", "Reverse all", false, "Slices"),
    Gain => lin("gain", "Gain", -24.0, 24.0, 0.0, "dB", "Slices"),
    Attack => logp("attack", "Attack", 0.1, 2000.0, 0.5, "ms", "Envelope"),
    Release => logp("release", "Release", 1.0, 5000.0, 30.0, "ms", "Envelope"),
    Fade => logp("fade", "End fade", 0.1, 200.0, 3.0, "ms", "Envelope"),
    FilterType => choice("filterType", "Type", &["Low pass", "High pass", "Band pass", "Notch"], 0, "Filter"),
    Cutoff => logp("cutoff", "Cutoff", 20.0, 20000.0, 20000.0, "Hz", "Filter"),
    Reso => lin("reso", "Resonance", 0.0, 1.0, 0.0, "%", "Filter"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: PLUGIN_ID,
        name: "Krypt Slicer",
        kind: PluginKind::Instrument,
        category: "Sampler",
        description: "Loop slicer: chops one sample into slices (at its hits, on a beat grid or by hand) and plays slice N on \
                      key First key + N - 1 at its recorded pitch, so a break replays at any tempo and rearranges note by \
                      note. Per-slice pitch, reverse and gain; one-shot or gate; Cut previous chokes the sounding slice. \
                      Slice markers live on the channel (slicer.* commands).",
        params: param_specs(),
        uses_sample: Some(true),
        sidechain: None,
        default_mix: None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Slice {
    pub start_sec: f64,
    pub pitch: f32,
    pub reverse: bool,
    pub gain: f32,
}

impl Slice {
    pub fn at(start_sec: f64) -> Self {
        Self { start_sec, pitch: 0.0, reverse: false, gain: 1.0 }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SliceSet {
    slices: Vec<Slice>,
}

impl SliceSet {
    pub fn new(slices: impl IntoIterator<Item = Slice>) -> Self {
        let mut v: Vec<Slice> = slices
            .into_iter()
            .filter(|s| s.start_sec.is_finite() && s.start_sec >= 0.0)
            .map(|s| Slice {
                start_sec: s.start_sec,
                pitch: if s.pitch.is_finite() { s.pitch.clamp(-48.0, 48.0) } else { 0.0 },
                reverse: s.reverse,
                gain: if s.gain.is_finite() { s.gain.clamp(0.0, 4.0) } else { 1.0 },
            })
            .collect();
        v.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));
        v.dedup_by(|b, a| (b.start_sec - a.start_sec).abs() < 1e-9);
        v.truncate(MAX_SLICES);
        Self { slices: v }
    }

    pub fn slices(&self) -> &[Slice] {
        &self.slices
    }

    pub fn len(&self) -> usize {
        self.slices.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slices.is_empty()
    }
}

pub(crate) struct SlicerShared {
    sample: Option<Arc<SampleData>>,
    slices: Option<Arc<SliceSet>>,
    sinc: SincTable,
    base_key: u8,
    gate: bool,
    to_end: bool,
    reverse: bool,
    env: EnvParams,
    fade_ms: f32,
    ftype: usize,
    cutoff: f32,
    reso: f32,
}

fn slice_region(sh: &SlicerShared, s: &SampleData, idx: usize) -> Option<(f64, f64, f32, bool, f32)> {
    let len = usable_frames(s) as f64;
    let at = |sec: f64| (sec * s.sample_rate as f64).round().clamp(0.0, len);
    let (lo, hi, sl) = match sh.slices.as_deref().filter(|set| !set.is_empty()) {
        None => (idx == 0).then_some((0.0, len, Slice::at(0.0)))?,
        Some(set) => {
            let sl = *set.slices.get(idx)?;
            let hi = if sh.to_end { len } else { set.slices.get(idx + 1).map_or(len, |n| at(n.start_sec)) };
            (at(sl.start_sec), hi, sl)
        }
    };
    (hi > lo).then_some((lo, hi, sl.pitch, sl.reverse != sh.reverse, sl.gain))
}

pub(crate) struct SlicerVoice {
    active: bool,
    pos: f64,
    dir: f64,
    lo: f64,
    hi: f64,
    step: f64,
    gain: f32,
    pl: f32,
    pr: f32,
    env: Ahdsr,
    filt: [Svf; 2],
    cut_s: Smooth,
    res_s: Smooth,
    coef_count: u32,
    mod_x: f32,
    mod_y: f32,
    fade: f32,
    fade_step: f32,
    choking: bool,
    fadein: f32,
    fadein_step: f32,
    pitch: f32,
    sr: f32,
}

impl SlicerVoice {
    fn new(sr: f32) -> Self {
        let mut env = Ahdsr::default();
        env.set_sr(sr);
        Self {
            active: false,
            pos: 0.0,
            dir: 1.0,
            lo: 0.0,
            hi: 0.0,
            step: 1.0,
            gain: 0.0,
            pl: 1.0,
            pr: 1.0,
            env,
            filt: [Svf::default(); 2],
            cut_s: Smooth::with_time(20000.0, 10.0, sr),
            res_s: Smooth::with_time(0.0, 10.0, sr),
            coef_count: 0,
            mod_x: 0.5,
            mod_y: 0.5,
            fade: 1.0,
            fade_step: 1.0 / (CHOKE_MS * 0.001 * sr),
            choking: false,
            fadein: 1.0,
            fadein_step: 1.0,
            pitch: 60.0,
            sr,
        }
    }

    fn filter_targets(&self, sh: &SlicerShared) -> (f32, f32) {
        let cut = sh.cutoff * ((self.mod_x - 0.5) * 4.0).exp2();
        let res = (sh.reso + (self.mod_y - 0.5) * 0.5).clamp(0.0, 1.0);
        (cut.clamp(20.0, 20000.0), res)
    }
}

impl Voice for SlicerVoice {
    type Shared = SlicerShared;

    fn start(&mut self, sh: &SlicerShared, n: &NoteStart, _glide_from: Option<f32>, _glide_ms: f32) {
        self.active = false;
        let Some(s) = sh.sample.as_ref() else { return };
        if n.key < sh.base_key || s.sample_rate <= 0.0 || usable_frames(s) == 0 {
            return;
        }
        let Some((lo, hi, semis, reverse, gain)) = slice_region(sh, s, (n.key - sh.base_key) as usize) else { return };
        let extra = n.extras.sample_start.max(0.0) * s.sample_rate as f64;
        self.pos = if reverse { hi - 1.0 - extra } else { lo + extra };
        if self.pos < lo - 1.0 || self.pos >= hi {
            return;
        }
        let shift = (n.pitch - n.key as f32) + semis;
        self.step = s.sample_rate as f64 / self.sr as f64 * (shift as f64 / 12.0).exp2();
        self.dir = if reverse { -1.0 } else { 1.0 };
        (self.lo, self.hi) = (lo, hi);
        self.pitch = n.pitch;
        self.gain = vel_gain(n.vel) * gain;
        (self.pl, self.pr) = pan_gains(n.extras.pan);
        self.mod_x = n.extras.mod_x;
        self.mod_y = n.extras.mod_y;
        self.env.kill();
        self.env.trigger(&sh.env);
        self.filt = [Svf::default(); 2];
        let (c, r) = self.filter_targets(sh);
        self.cut_s.reset(c);
        self.res_s.reset(r);
        self.coef_count = 0;
        self.fade = 1.0;
        self.choking = false;
        if n.xfade {
            self.fadein = 0.0;
            self.fadein_step = 1.0 / (CHOKE_MS * 0.001 * self.sr);
        } else if extra > 0.5 {
            self.fadein = 0.0;
            self.fadein_step = 1.0 / (0.001 * self.sr);
        } else {
            self.fadein = 1.0;
        }
        self.active = true;
    }

    fn legato(&mut self, _sh: &SlicerShared, _pitch: f32, _glide_ms: f32) {}

    fn release(&mut self, sh: &SlicerShared) {
        if sh.gate {
            self.env.release(&sh.env);
        }
    }

    fn choke(&mut self) {
        self.choking = true;
    }

    fn kill(&mut self) {
        self.active = false;
        self.choking = false;
        self.env.kill();
    }

    fn active(&self) -> bool {
        self.active
    }

    fn choking(&self) -> bool {
        self.choking
    }

    fn pitch(&self) -> f32 {
        self.pitch
    }

    fn render(&mut self, sh: &SlicerShared, l: &mut [f32], r: &mut [f32]) {
        let Some(s) = sh.sample.as_ref() else {
            self.kill();
            return;
        };
        let len = usable_frames(s);
        let ch0 = &s.channels[0][..len];
        let ch1 = if s.channels.len() > 1 { Some(&s.channels[1][..len]) } else { None };
        let mut w = [0.0f32; MAX_TAPS];
        let (lo, hi, step) = (self.lo, self.hi, self.step);
        let edge_fade = if self.dir > 0.0 { hi < len as f64 } else { lo > 0.0 };
        let fade_len = (sh.fade_ms.max(0.1) * 0.001 * self.sr) as f64;
        let (ct, rt) = self.filter_targets(sh);
        self.cut_s.set(ct);
        self.res_s.set(rt);
        let filter_on = !(sh.ftype == 0 && ct >= 19_500.0 && rt < 0.02);
        for i in 0..l.len() {
            let (mut a, mut b);
            if self.pos.fract() == 0.0 && step == 1.0 && self.pos >= 0.0 && (self.pos as usize) < len {
                let k = self.pos as usize;
                a = ch0[k];
                b = ch1.map_or(a, |c| c[k]);
            } else {
                let (first, nt) = sh.sinc.weights(self.pos, step, &mut w);
                a = apply(ch0, first, &w[..nt], None);
                b = match ch1 {
                    Some(c) => apply(c, first, &w[..nt], None),
                    None => a,
                };
            }
            let mut g = self.env.next(&sh.env) * self.gain;
            if edge_fade {
                let dist = if self.dir > 0.0 { hi - self.pos } else { self.pos - lo };
                g *= (dist / (step * fade_len).max(1e-9)).clamp(0.0, 1.0) as f32;
            }
            self.pos += self.dir * step;
            let mut finished = self.pos >= hi || self.pos < lo - 1.0 || self.env.idle();
            if filter_on {
                if self.coef_count == 0 {
                    let c = self.cut_s.advance(16);
                    let rs = self.res_s.advance(16);
                    let gg = svf_g(c as f64, self.sr as f64);
                    let k = reso_to_k(rs);
                    self.filt[0].set_gk(gg, k);
                    self.filt[1].set_gk(gg, k);
                    self.coef_count = 16;
                }
                self.coef_count -= 1;
                a = svf_typed(&mut self.filt[0], sh.ftype, a as f64) as f32;
                b = svf_typed(&mut self.filt[1], sh.ftype, b as f64) as f32;
            }
            if self.fadein < 1.0 {
                self.fadein = (self.fadein + self.fadein_step).min(1.0);
                g *= self.fadein;
            }
            if self.choking {
                self.fade -= self.fade_step;
                if self.fade <= 0.0 {
                    finished = true;
                    self.fade = 0.0;
                }
                g *= self.fade;
            }
            l[i] += a * g * self.pl;
            r[i] += b * g * self.pr;
            if finished {
                self.kill();
                return;
            }
        }
    }
}

pub struct Slicer {
    pb: ParamBank<N_PARAMS>,
    shared: SlicerShared,
    vm: VoiceManager<SlicerVoice>,
    out: OutStage,
    cut: bool,
}

impl Slicer {
    pub fn new(sample_rate: f32, max_frames: usize) -> Self {
        let sr = sanitize_sr(sample_rate);
        let shared = SlicerShared {
            sample: None,
            slices: None,
            sinc: SincTable::new(),
            base_key: 60,
            gate: false,
            to_end: false,
            reverse: false,
            env: EnvParams::default(),
            fade_ms: 3.0,
            ftype: 0,
            cutoff: 20000.0,
            reso: 0.0,
        };
        let mut s = Self {
            pb: ParamBank::new(&param_specs()),
            shared,
            vm: VoiceManager::new(32, || SlicerVoice::new(sr)),
            out: OutStage::new(max_frames, sr),
            cut: true,
        };
        s.update();
        s.out.gain.reset(s.out.gain.target);
        s
    }

    fn update(&mut self) {
        let p = &self.pb;
        let sh = &mut self.shared;
        sh.base_key = p.get(P::BaseKey as usize).round().clamp(0.0, 127.0) as u8;
        sh.gate = p.idx(P::Trigger as usize) == 1;
        sh.to_end = p.idx(P::PlayTo as usize) == 1;
        sh.reverse = p.on(P::Reverse as usize);
        sh.env = EnvParams { attack_ms: p.get(P::Attack as usize), hold_ms: 0.0, decay_ms: 1000.0, sustain: 1.0, release_ms: p.get(P::Release as usize) };
        sh.fade_ms = p.get(P::Fade as usize);
        sh.ftype = p.idx(P::FilterType as usize).min(3);
        sh.cutoff = p.get(P::Cutoff as usize);
        sh.reso = p.get(P::Reso as usize);
        self.cut = p.on(P::Cut as usize);
        self.out.gain.set(db_to_gain(p.get(P::Gain as usize)));
    }
}

impl Instrument for Slicer {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        let sr = sanitize_sr(sample_rate);
        self.vm.all_off();
        for v in self.vm.voices.iter_mut() {
            *v = SlicerVoice::new(sr);
        }
        self.out.prepare(max_frames, sr);
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn set_sample(&mut self, sample: Option<Arc<SampleData>>) {
        self.vm.all_off();
        self.shared.sample = sample.filter(|s| usable_frames(s) > 0 && s.sample_rate.is_finite() && s.sample_rate > 0.0);
    }

    fn set_slices(&mut self, slices: Option<Arc<SliceSet>>) {
        self.vm.all_off();
        self.shared.slices = slices;
    }

    fn note_on(&mut self, offset: usize, key: u8, pitch: f32, velocity: f32, extras: NoteExtras) {
        if self.pb.take_dirty() {
            self.update();
        }
        if self.cut {
            self.vm.choke(offset);
        }
        self.vm.note_on(offset, key, pitch, velocity, extras);
    }

    fn note_off(&mut self, offset: usize, key: u8) {
        self.vm.note_off(offset, key);
    }

    fn choke(&mut self, offset: usize) {
        self.vm.choke(offset);
    }

    fn all_off(&mut self) {
        self.vm.all_off();
    }

    fn process(&mut self, ctx: &ProcessContext, mut out: [&mut [f32]; 2]) {
        if self.pb.take_dirty() {
            self.update();
        }
        instrument_process!(self, ctx, out);
    }

    fn activity(&self) -> f32 {
        self.out.peak.min(1.0)
    }

    fn is_active(&self) -> bool {
        self.vm.is_active()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48000.0;
    const LEN: usize = 48000;

    fn ramp() -> Arc<SampleData> {
        let c: Vec<f32> = (0..LEN).map(|i| i as f32 / LEN as f32).collect();
        Arc::new(SampleData { sample_rate: SR, channels: vec![c.clone(), c], root_key: None })
    }

    fn pid(id: &str) -> usize {
        param_specs().iter().position(|p| p.id == id).unwrap()
    }

    fn slicer(params: &[(&str, f32)], slices: &[Slice]) -> Slicer {
        let mut s = Slicer::new(SR, 256);
        s.set_sample(Some(ramp()));
        if !slices.is_empty() {
            s.set_slices(Some(Arc::new(SliceSet::new(slices.iter().copied()))));
        }
        for (id, v) in params {
            s.set_param(pid(id), *v);
        }
        s
    }

    fn render(inst: &mut dyn Instrument, frames: usize, notes: &[(usize, u8, Option<usize>)]) -> Vec<f32> {
        let (mut l, mut r) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        let mut at = 0;
        while at < frames {
            let n = (frames - at).min(256);
            for &(t, key, off) in notes {
                if t >= at && t < at + n {
                    inst.note_on(t - at, key, key as f32, 1.0, NoteExtras::default());
                }
                if let Some(o) = off.filter(|o| *o >= at && *o < at + n) {
                    inst.note_off(o - at, key);
                }
            }
            let ctx = ProcessContext { sample_rate: SR, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: 0.0, frames: n };
            inst.process(&ctx, [&mut l[at..at + n], &mut r[at..at + n]]);
            at += n;
        }
        l
    }

    fn where_(v: f32) -> f32 {
        v / vel_gain(1.0)
    }

    const FOUR: [f64; 4] = [0.0, 0.25, 0.5, 0.75];

    fn four() -> Vec<Slice> {
        FOUR.iter().map(|&t| Slice::at(t)).collect()
    }

    #[test]
    fn each_key_plays_its_slice_and_stops_at_the_next() {
        for (i, start) in FOUR.iter().enumerate() {
            let mut s = slicer(&[], &four());
            let out = render(&mut s, 24000, &[(0, 60 + i as u8, None)]);
            assert!((where_(out[100]) - (*start as f32 + 100.0 / LEN as f32)).abs() < 2e-3, "slice {i} reads at {}", where_(out[100]));
            assert!(out[11000].abs() > 0.05, "slice {i} cut short");
            assert!(out[12000..].iter().all(|v| *v == 0.0), "slice {i} played past its end");
        }
    }

    #[test]
    fn keys_outside_the_slices_are_silent() {
        let mut s = slicer(&[], &four());
        let out = render(&mut s, 4000, &[(0, 59, None), (0, 64, None), (0, 127, None)]);
        assert!(out.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn no_slices_plays_the_whole_sample_on_the_first_key() {
        let mut s = slicer(&[("baseKey", 36.0)], &[]);
        let out = render(&mut s, LEN + 1000, &[(0, 36, None)]);
        assert!(where_(out[LEN - 200]) > 0.98, "{}", where_(out[LEN - 200]));
        let mut s = slicer(&[("baseKey", 36.0)], &[]);
        assert!(render(&mut s, 2000, &[(0, 37, None)]).iter().all(|v| *v == 0.0));
    }

    #[test]
    fn reverse_plays_the_slice_backwards() {
        let mut sl = four();
        sl[1].reverse = true;
        let mut s = slicer(&[], &sl);
        let out = render(&mut s, 24000, &[(0, 61, None)]);
        assert!((where_(out[100]) - (0.5 - 101.0 / LEN as f32)).abs() < 2e-3, "{}", where_(out[100]));
        assert!(out[12000..].iter().all(|v| *v == 0.0));
        let mut s = slicer(&[("reverse", 1.0)], &sl);
        let out = render(&mut s, 2000, &[(0, 61, None)]);
        assert!((where_(out[100]) - (0.25 + 100.0 / LEN as f32)).abs() < 2e-3);
    }

    #[test]
    fn slice_pitch_speeds_it_up() {
        let mut sl = four();
        sl[0].pitch = 12.0;
        let mut s = slicer(&[], &sl);
        let out = render(&mut s, 12000, &[(0, 60, None)]);
        assert!(out[5500].abs() > 0.05);
        assert!(out[6100..].iter().all(|v| *v == 0.0), "octave-up slice too long");
    }

    #[test]
    fn slice_gain_scales_it() {
        let mut sl = four();
        sl[2].gain = 0.5;
        let mut s = slicer(&[], &sl);
        let out = render(&mut s, 2000, &[(0, 62, None)]);
        assert!((where_(out[100]) - 0.5 * (0.5 + 100.0 / LEN as f32)).abs() < 2e-3);
    }

    #[test]
    fn play_to_sample_end_runs_on() {
        let mut s = slicer(&[("playTo", 1.0)], &four());
        let out = render(&mut s, LEN, &[(0, 61, None)]);
        assert!(where_(out[30000]) > 0.8, "stopped at the slice end");
    }

    #[test]
    fn cut_previous_chokes_the_sounding_slice() {
        let notes = [(0usize, 60u8, None), (2000, 62, None)];
        let mut cut = slicer(&[], &four());
        let a = render(&mut cut, 6000, &notes);
        let mut layered = slicer(&[("cut", 0.0)], &four());
        let b = render(&mut layered, 6000, &notes);
        let slice3 = |f: usize| 0.5 + (f - 2000) as f32 / LEN as f32;
        assert!((where_(a[4000]) - slice3(4000)).abs() < 2e-3, "cut: {}", where_(a[4000]));
        assert!((where_(b[4000]) - slice3(4000) - 4000.0 / LEN as f32).abs() < 2e-3, "layered: {}", where_(b[4000]));
    }

    #[test]
    fn gate_releases_on_note_off_and_one_shot_does_not() {
        let mut gate = slicer(&[("trigger", 1.0), ("release", 1.0)], &four());
        let g = render(&mut gate, 8000, &[(0, 60, Some(2000))]);
        assert!(g[3000..].iter().all(|v| v.abs() < 1e-3), "gate kept playing after note off");
        let mut shot = slicer(&[], &four());
        let o = render(&mut shot, 8000, &[(0, 60, Some(2000))]);
        assert!(o[7000].abs() > 0.05, "one-shot stopped at note off");
    }

    #[test]
    fn slice_set_cleans_its_input() {
        let set = SliceSet::new([Slice::at(0.5), Slice::at(f64::NAN), Slice::at(-1.0), Slice::at(0.1), Slice::at(0.5), Slice { pitch: 99.0, ..Slice::at(0.2) }]);
        let starts: Vec<f64> = set.slices().iter().map(|s| s.start_sec).collect();
        assert_eq!(starts, vec![0.1, 0.2, 0.5]);
        assert_eq!(set.slices()[1].pitch, 48.0);
        assert_eq!(SliceSet::new((0..300).map(|i| Slice::at(i as f64))).len(), MAX_SLICES);
    }
}
