//! krypt.multisampler: SFZ parsing, region selection, velocity crossfades,
//! round robin, choke groups, release triggers, loop modes, pitch accuracy,
//! loading (offset/end, missing files, RAM cap) and real-time safety.

mod common;
use common::*;

use std::sync::Arc;

use assert_no_alloc::assert_no_alloc;
use krypt_studio_dsp::instruments::multisampler::build::from_sfz_text;
use krypt_studio_dsp::instruments::multisampler::sfz::{self, LoopMode, OffMode, Trigger, KEYCENTER_FROM_SAMPLE};
use krypt_studio_dsp::instruments::multisampler::{MsSample, MultiSampleSet, Multisampler, PLUGIN_ID};
use krypt_studio_dsp::{create_instrument, descriptor, Instrument, NoteExtras, ProcessContext};

// The checking allocator exists in debug builds only (release: a no-op pass).
#[cfg(debug_assertions)]
#[global_allocator]
static A: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;

// ── helpers ──────────────────────────────────────────────────────────────

fn sine(hz: f64, sr: f32, secs: f32, amp: f32) -> Vec<f32> {
    let n = (secs * sr) as usize;
    (0..n).map(|i| (amp as f64 * (std::f64::consts::TAU * hz * i as f64 / sr as f64).sin()) as f32).collect()
}

fn mono(hz: f64, sr: f32, secs: f32) -> MsSample {
    let s = sine(hz, sr, secs, 0.5);
    MsSample::from_planar(&[&s], sr, None, false)
}

fn dc(level: f32, frames: usize) -> MsSample {
    let s = vec![level; frames];
    MsSample::from_planar(&[&s], SR, None, false)
}

/// A set from SFZ text; every sample name maps to `make(name)`.
fn set_from(text: &str, make: impl Fn(&str) -> Option<MsSample>) -> Arc<MultiSampleSet> {
    Arc::new(from_sfz_text("test.sfz", text, make).expect("set"))
}

fn ms(set: &Arc<MultiSampleSet>) -> Multisampler {
    let mut m = Multisampler::new(SR, BLOCK);
    m.set_multisample(Some(set.clone()));
    m
}

fn param(m: &mut Multisampler, id: &str, v: f32) {
    let i = descriptor(PLUGIN_ID).unwrap().param_index(id).unwrap();
    m.set_param(i, v);
}

fn run(m: &mut dyn Instrument, frames: usize) -> (Vec<f32>, Vec<f32>) {
    render_inst(m, frames)
}

fn on(m: &mut dyn Instrument, key: u8, vel: f32) {
    m.note_on(0, key, key as f32, vel, NoteExtras::default());
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

fn db(x: f32) -> f32 {
    20.0 * x.max(1e-12).log10()
}

/// Frequency from interpolated rising zero crossings.
fn freq(x: &[f32], sr: f32) -> f64 {
    let mut first: Option<f64> = None;
    let mut last = 0.0f64;
    let mut n = 0usize;
    for i in 1..x.len() {
        if x[i - 1] < 0.0 && x[i] >= 0.0 {
            let t = (i - 1) as f64 + (-x[i - 1] / (x[i] - x[i - 1])) as f64;
            if first.is_none() {
                first = Some(t);
            } else {
                n += 1;
            }
            last = t;
        }
    }
    let f = first.expect("no zero crossing");
    n as f64 / ((last - f) / sr as f64)
}

// ── parsing ──────────────────────────────────────────────────────────────

const PARSE_TEXT: &str = r#"
// A header comment
/* a block
   comment <region> sample=nope.wav */
#define $VEL 64
#define $DIR samples dir
<control> default_path=$DIR/
<global> volume=-6 amp_veltrack=50
<master> pan=10
<group> lovel=1 hivel=$VEL ampeg_release=0.3
<region> sample=Piano C4 soft.wav key=c4 tune=5
<region> sample=Piano D#4 soft.wav lokey=d#4 hikey=eb4 pitch_keycenter=63 volume=-3 // tail comment
<group> lovel=65 hivel=127
<region> sample=loud.wav lokey=c4 hikey=g4 pitch_keycenter=e4 bogus_opcode=1 amp_velcurve_1=0.5 bogus_opcode=2
#include "other.sfz"
<curve> v000=0 v127=1
<region> sample=sub\x.wav trigger=release rt_decay=6 seq_length=2 seq_position=2 lorand=0.5 hirand=1 group=3 off_by=4 off_mode=normal loopmode=loop_sustain loop_start=100 loop_end=200 offset=10 end=1000 /* inline */ pitch_keycenter=sample
"#;

#[test]
fn parser_inheritance_defines_names_comments_and_unknown_opcodes() {
    let p = sfz::parse(PARSE_TEXT);
    assert_eq!(p.regions.len(), 4, "{:?}", p.regions);
    let r0 = &p.regions[0];
    assert_eq!(r0.sample, "samples dir/Piano C4 soft.wav");
    assert_eq!((r0.lokey, r0.hikey, r0.pitch_keycenter), (60, 60, 60.0));
    assert_eq!(r0.tune, 5.0);
    assert_eq!(r0.volume, -6.0, "global");
    assert_eq!(r0.amp_veltrack, 50.0);
    assert_eq!(r0.pan, 10.0, "master");
    assert_eq!((r0.lovel, r0.hivel), (1, 64), "group + #define");
    assert_eq!(r0.ampeg_release, 0.3);
    let r1 = &p.regions[1];
    assert_eq!(r1.sample, "samples dir/Piano D#4 soft.wav", "a sample path with spaces and #");
    assert_eq!((r1.lokey, r1.hikey, r1.pitch_keycenter), (63, 63, 63.0), "d#4 / eb4 note names");
    assert_eq!(r1.volume, -3.0, "region overrides global");
    let r2 = &p.regions[2];
    assert_eq!((r2.lovel, r2.hivel), (65, 127), "a new <group> replaces the old one");
    assert_eq!(r2.ampeg_release, 0.0, "group opcodes don't leak into the next group");
    assert_eq!((r2.lokey, r2.hikey, r2.pitch_keycenter), (60, 67, 64.0));
    assert_eq!(r2.pan, 10.0, "master still applies");
    let r3 = &p.regions[3];
    assert_eq!(r3.sample, "samples dir/sub/x.wav", "backslashes become slashes");
    assert_eq!(r3.trigger, Trigger::Release);
    assert_eq!((r3.rt_decay, r3.seq_length, r3.seq_position), (6.0, 2, 2));
    assert_eq!((r3.lorand, r3.hirand), (0.5, 1.0));
    assert_eq!((r3.group, r3.off_by, r3.off_mode), (3, 4, OffMode::Normal));
    assert_eq!(r3.loop_mode, Some(LoopMode::LoopSustain), "loopmode alias");
    assert_eq!((r3.loop_start, r3.loop_end, r3.offset, r3.end), (Some(100), Some(200), 10, Some(1000)));
    assert_eq!(r3.pitch_keycenter, KEYCENTER_FROM_SAMPLE);
    // unknown opcodes: counted (3 occurrences, 2 names), one warning; <curve> contents are not counted
    assert_eq!(p.unknown_count, 3);
    assert_eq!(p.unknown_names, ["bogus_opcode", "amp_velcurve_1"]);
    let w = p.unknown_warning().unwrap();
    assert!(w.contains("ignored 3 unsupported opcodes") && w.contains("bogus_opcode") && w.contains("amp_velcurve_1"), "{w}");
    assert!(p.warnings.iter().any(|w| w.contains("#include is not supported") && w.contains("other.sfz")), "{:?}", p.warnings);
    assert!(p.warnings.iter().any(|w| w.contains("<curve>")), "{:?}", p.warnings);
    // the commented-out region never appears
    assert!(p.regions.iter().all(|r| !r.sample.contains("nope")));
}

#[test]
fn parser_edge_cases() {
    // headers and opcodes on one line, numbers as keys, `key` then an override
    let p = sfz::parse("<group>key=40<region>sample=a.wav pitch_keycenter=41 <region> sample=b.wav hikey=45");
    assert_eq!(p.regions.len(), 2);
    assert_eq!((p.regions[0].lokey, p.regions[0].hikey, p.regions[0].pitch_keycenter), (40, 40, 41.0));
    assert_eq!((p.regions[1].lokey, p.regions[1].hikey), (40, 45));
    // a region without a sample is skipped with a warning; a bad value warns and keeps the default
    let p = sfz::parse("<region> key=60\n<region> sample=a.wav lokey=zz volume=loud");
    assert_eq!(p.regions.len(), 1);
    assert_eq!(p.regions[0].lokey, 0);
    assert_eq!(p.regions[0].volume, 0.0);
    assert!(p.warnings.iter().any(|w| w.contains("without sample")));
    assert!(p.warnings.iter().any(|w| w.contains("lokey=zz")));
    assert!(p.warnings.iter().any(|w| w.contains("volume=loud")));
    // a later #define wins; defines expand inside other defines
    let p = sfz::parse("#define $K 50\n#define $K 52\n#define $HI $K\n<region> sample=a.wav lokey=$K hikey=$HI");
    assert_eq!((p.regions[0].lokey, p.regions[0].hikey), (52, 52));
    // a sample path running to the end of the line
    let p = sfz::parse("<region> lokey=1 sample=My Drums/Kick Hard 01.flac");
    assert_eq!(p.regions[0].sample, "My Drums/Kick Hard 01.flac");
    // an empty file: nothing, no panic
    assert!(sfz::parse("").regions.is_empty());
    assert!(from_sfz_text("e.sfz", "// nothing", |_| None).unwrap_err().contains("no playable <region>"));
}

// ── region selection ─────────────────────────────────────────────────────

const XFADE: &str = "
<group> amp_veltrack=0 hikey=69
<region> sample=soft.wav lovel=1 hivel=90 xfout_lovel=60 xfout_hivel=90
<region> sample=loud.wav lovel=60 hivel=127 xfin_lovel=60 xfin_hivel=90
<region> sample=other.wav lokey=70 hikey=80 amp_veltrack=0
";

fn xfade_set() -> Arc<MultiSampleSet> {
    set_from(XFADE, |name| {
        Some(match name {
            "soft.wav" => mono(300.0, SR, 2.0),
            "loud.wav" => mono(470.0, SR, 2.0),
            _ => mono(1000.0, SR, 2.0),
        })
    })
}

#[test]
fn region_selection_by_key_and_velocity() {
    let set = xfade_set();
    assert_eq!(set.regions.len(), 3);
    // sample indices follow first use: soft 0, loud 1, other 2
    let cases: [(u8, f32, &[u32]); 6] = [(60, 40.0, &[0]), (60, 75.0, &[0, 1]), (60, 120.0, &[1]), (75, 100.0, &[2]), (69, 127.0, &[1]), (100, 100.0, &[])];
    for (key, vel, want) in cases {
        let mut m = ms(&set);
        on(&mut m, key, vel / 127.0);
        let (l, _) = run(&mut m, 256);
        let mut got = m.active_samples();
        got.sort();
        assert_eq!(got, want, "key {key} vel {vel}");
        if want.is_empty() {
            assert!(l.iter().all(|v| *v == 0.0), "no region: silence");
        }
    }
    // xfade gains: equal power across the crossfade zone
    let (soft, loud) = (&set.regions[0], &set.regions[1]);
    for v in [60.0f32, 65.0, 75.0, 82.0, 90.0] {
        let p = soft.xfade_gain(v).powi(2) + loud.xfade_gain(v).powi(2);
        assert!((p - 1.0).abs() < 1e-5, "power at {v}: {p}");
    }
    assert!((soft.xfade_gain(75.0) - 0.5f32.sqrt()).abs() < 1e-6);
    assert_eq!(loud.xfade_gain(60.0), 0.0);
    assert_eq!(soft.xfade_gain(40.0), 1.0);
}

#[test]
fn velocity_crossfade_keeps_the_level_constant() {
    let set = xfade_set();
    let mut levels = Vec::new();
    for vel in [30.0f32, 66.0, 75.0, 84.0, 110.0] {
        let mut m = ms(&set);
        on(&mut m, 60, vel / 127.0);
        let (l, _) = run(&mut m, 24_000);
        levels.push(db(rms(&l[2000..])));
    }
    let (lo, hi) = levels.iter().fold((f32::MAX, f32::MIN), |(a, b), &x| (a.min(x), b.max(x)));
    assert!(hi - lo < 0.3, "equal-power crossfade, levels {levels:?}");
}

#[test]
fn amp_veltrack_and_velocity_sensitivity() {
    let set = set_from("<region> sample=a.wav", |_| Some(mono(440.0, SR, 1.0)));
    let level = |vel: f32, sens: f32| {
        let mut m = ms(&set);
        param(&mut m, "velSens", sens);
        on(&mut m, 60, vel);
        let (l, _) = run(&mut m, 9600);
        rms(&l[1000..])
    };
    // amp_veltrack 100 %: (vel)² → -12 dB at half velocity
    let d = db(level(0.5, 1.0)) - db(level(1.0, 1.0));
    assert!((d + 12.04).abs() < 0.2, "{d}");
    // velocity sensitivity 0: no velocity → level
    let d = db(level(0.5, 0.0)) - db(level(1.0, 0.0));
    assert!(d.abs() < 0.05, "{d}");
}

// ── round robin ──────────────────────────────────────────────────────────

const RR: &str = "
<group> key=60 seq_length=3
<region> sample=a.wav seq_position=1
<region> sample=b.wav seq_position=2
<region> sample=c.wav seq_position=3
<group> key=62
<region> sample=r1.wav lorand=0 hirand=0.5
<region> sample=r2.wav lorand=0.5 hirand=1
";

fn started(m: &mut Multisampler, key: u8) -> u32 {
    on(m, key, 0.8);
    run(m, 64);
    let s = *m.active_samples().last().expect("a voice");
    m.note_off(0, key);
    run(m, 4800); // let the 5 ms release finish
    s
}

#[test]
fn round_robin_cycles_and_can_be_switched_off() {
    let set = set_from(RR, |_| Some(mono(220.0, SR, 1.0)));
    let mut m = ms(&set);
    let seq: Vec<u32> = (0..7).map(|_| started(&mut m, 60)).collect();
    assert_eq!(seq, [0, 1, 2, 0, 1, 2, 0], "seq_length/seq_position cycle");
    // random round robin: both halves are used
    let mut counts = [0usize; 2];
    for _ in 0..200 {
        let s = started(&mut m, 62);
        counts[(s - 3) as usize] += 1;
    }
    assert!(counts[0] > 60 && counts[1] > 60, "lorand/hirand {counts:?}");
    // Round robin Off: always the first position / the first random slot
    let mut m = ms(&set);
    param(&mut m, "roundRobin", 0.0);
    let seq: Vec<u32> = (0..4).map(|_| started(&mut m, 60)).collect();
    assert_eq!(seq, [0, 0, 0, 0]);
    assert!((0..20).all(|_| started(&mut m, 62) == 3));
}

// ── choke groups ─────────────────────────────────────────────────────────

const CHOKE: &str = "
<region> sample=open.wav key=46 group=1 off_by=2 loop_mode=one_shot
<region> sample=closed.wav key=42 group=2 loop_mode=one_shot
<region> sample=ride.wav key=51 group=3 off_by=4 off_mode=normal ampeg_release=0.5 loop_mode=one_shot
<region> sample=stop.wav key=50 group=4 loop_mode=one_shot
<region> sample=self.wav key=53 group=5 off_by=5 loop_mode=one_shot
";

#[test]
fn choke_groups_fast_and_normal() {
    let set = set_from(CHOKE, |_| Some(mono(500.0, SR, 3.0)));
    // closed hat chokes the open hat within ~5 ms
    let mut m = ms(&set);
    on(&mut m, 46, 0.9);
    run(&mut m, 4800);
    assert_eq!(m.active_samples(), [0]);
    on(&mut m, 42, 0.9);
    run(&mut m, 32);
    assert_eq!(m.active_samples(), [1], "open hat is fading");
    run(&mut m, 480); // 10 ms
    assert_eq!(m.active_voices(), 1, "open hat gone after the fast fade");
    // off_mode=normal: the choked region releases over its ampeg_release
    let mut m = ms(&set);
    on(&mut m, 51, 0.9);
    run(&mut m, 4800);
    on(&mut m, 50, 0.9);
    run(&mut m, 4800); // 100 ms into a 500 ms release
    assert_eq!(m.active_voices(), 2, "still releasing");
    run(&mut m, 48_000);
    assert_eq!(m.active_samples(), [3], "release finished");
    // a region choking its own group: a new hit cuts the previous one
    let mut m = ms(&set);
    on(&mut m, 53, 0.9);
    run(&mut m, 2400);
    on(&mut m, 53, 0.9);
    run(&mut m, 960);
    assert_eq!(m.active_voices(), 1);
    // regions without a group never choke anything
    let mut m = ms(&set);
    on(&mut m, 46, 0.9);
    on(&mut m, 51, 0.9);
    run(&mut m, 960);
    assert_eq!(m.active_voices(), 2);
}

// ── release triggers ─────────────────────────────────────────────────────

const REL: &str = "
<region> sample=sus.wav key=60 volume=-144 ampeg_release=0.01
<region> sample=rel.wav key=60 trigger=release rt_decay=6
";

fn release_level(hold_s: f32, rel_param: f32) -> (f32, usize) {
    let set = set_from(REL, |n| Some(if n == "sus.wav" { mono(200.0, SR, 5.0) } else { mono(700.0, SR, 1.0) }));
    let mut m = ms(&set);
    param(&mut m, "releaseSamples", rel_param);
    on(&mut m, 60, 1.0);
    run(&mut m, (hold_s * SR) as usize);
    let held = m.active_voices();
    m.note_off(0, 60);
    let (l, _) = run(&mut m, 4800);
    (rms(&l[480..]), held)
}

#[test]
fn release_triggers_fire_on_note_off_and_decay_with_hold_time() {
    let (short, held) = release_level(0.1, 1.0);
    assert_eq!(held, 1, "only the attack region plays while held");
    assert!(short > 0.05, "the release sample plays at note-off ({short})");
    let (long, _) = release_level(2.1, 1.0);
    let d = db(long) - db(short);
    assert!((d + 12.0).abs() < 0.3, "rt_decay 6 dB/s over 2 s: {d}");
    // Release samples param: level, and 0 = off
    let (half, _) = release_level(0.1, 0.5);
    assert!((db(half) - db(short) + 6.02).abs() < 0.2);
    let (none, _) = release_level(0.1, 0.0);
    assert!(none < 1e-6, "{none}");
    // no note-on, no release trigger
    let set = set_from(REL, |_| Some(mono(700.0, SR, 1.0)));
    let mut m = ms(&set);
    m.note_off(0, 60);
    let (l, _) = run(&mut m, 960);
    assert!(l.iter().all(|v| *v == 0.0));
}

// ── loop modes ───────────────────────────────────────────────────────────

fn loop_set(mode: &str) -> Arc<MultiSampleSet> {
    let text = format!("<region> sample=a.wav loop_mode={mode} loop_start=200 loop_end=799 ampeg_release=0.002");
    set_from(&text, |_| Some(dc(0.5, 1000)))
}

fn hold_then_release(mode: &str, hold: usize, after: usize) -> (bool, bool, Vec<f32>) {
    let set = loop_set(mode);
    let mut m = ms(&set);
    on(&mut m, 60, 1.0);
    let (l1, _) = run(&mut m, hold);
    let active_while_held = m.active_voices() == 1;
    m.note_off(0, 60);
    let (l2, _) = run(&mut m, after);
    let active_after = m.active_voices() == 1;
    let mut l = l1;
    l.extend(l2);
    (active_while_held, active_after, l)
}

#[test]
fn loop_modes() {
    // no_loop: stops at the sample end even while held
    let (held, _, l) = hold_then_release("no_loop", 3000, 100);
    assert!(!held, "no_loop ends with the sample");
    assert!(l[500].abs() > 0.1 && l[1500] == 0.0);
    // one_shot: note-off is ignored; plays to the end
    let (_, after, l) = hold_then_release("one_shot", 100, 500);
    assert!(after, "one_shot keeps playing after note-off");
    assert!(l[550].abs() > 0.1);
    let (_, after, _) = hold_then_release("one_shot", 100, 1000);
    assert!(!after, "and ends with the sample");
    // loop_continuous: loops while held (10x the sample length), releases on note-off
    let (held, after, l) = hold_then_release("loop_continuous", 10_000, 960);
    assert!(held && !after);
    assert!(l[9_000].abs() > 0.1, "still sounding after 9 sample lengths");
    // loop_sustain: loops while held, then plays out past loop_end to the sample end
    let set = loop_set("loop_sustain");
    let mut m = ms(&set);
    param(&mut m, "release", 4.0); // a long release: the sample end must stop it
    on(&mut m, 60, 1.0);
    run(&mut m, 5_000);
    assert_eq!(m.active_voices(), 1, "looping while held");
    m.note_off(0, 60);
    run(&mut m, 990);
    assert_eq!(m.active_voices(), 0, "played out to the end after note-off");
}

#[test]
fn trimmed_samples_fade_at_their_end() {
    // end= cuts a loud sample short: the last 100 ms fade out instead of clicking
    let set = set_from("<region> sample=a.wav end=23999", |_| Some(dc(0.5, 96_000)));
    assert_eq!(set.samples[0].frames, 24_000);
    let mut m = ms(&set);
    on(&mut m, 60, 1.0);
    let (l, _) = run(&mut m, 30_000);
    assert!(l[10_000] > 0.4);
    assert!(l[23_990].abs() < 0.01, "faded at the trim point: {}", l[23_990]);
    assert!(l[22_000] < l[20_000] && l[22_000] > 0.05);
}

// ── pitch ────────────────────────────────────────────────────────────────

fn pitch_of(text: &str, sample_sr: f32, key: u8, setup: impl Fn(&mut Multisampler)) -> f64 {
    let set = set_from(text, |_| Some(mono(261.625_565_3, sample_sr, 3.0)));
    let mut m = ms(&set);
    setup(&mut m);
    on(&mut m, key, 1.0);
    let (l, _) = run(&mut m, (1.5 * SR) as usize);
    freq(&l[(0.25 * SR) as usize..], SR)
}

#[test]
fn pitch_accuracy() {
    // a C4 sine (44.1 kHz) played at A4 at 48 kHz is 440 Hz
    let f = pitch_of("<region> sample=c4.wav pitch_keycenter=c4", 44_100.0, 69, |_| {});
    assert!((f - 440.0).abs() < 0.5, "{f}");
    // same rate as the engine
    let f = pitch_of("<region> sample=c4.wav pitch_keycenter=60", SR, 69, |_| {});
    assert!((f - 440.0).abs() < 0.5, "{f}");
    // transpose, tune (cents), pitch_keytrack
    let f = pitch_of("<region> sample=c4.wav pitch_keycenter=60 transpose=-12", 44_100.0, 69, |_| {});
    assert!((f - 220.0).abs() < 0.3, "{f}");
    let f = pitch_of("<region> sample=c4.wav pitch_keycenter=60 tune=100", 44_100.0, 69, |_| {});
    assert!((f - 466.164).abs() < 0.5, "{f}");
    let f = pitch_of("<region> sample=c4.wav pitch_keycenter=60 pitch_keytrack=0", 44_100.0, 69, |_| {});
    assert!((f - 261.626).abs() < 0.3, "{f}");
    // the instrument's Tune / Fine
    let f = pitch_of("<region> sample=c4.wav pitch_keycenter=60", 44_100.0, 69, |m| param(m, "tune", 12.0));
    assert!((f - 880.0).abs() < 1.0, "{f}");
    let f = pitch_of("<region> sample=c4.wav pitch_keycenter=60", 44_100.0, 69, |m| param(m, "fine", -100.0));
    assert!((f - 415.305).abs() < 0.5, "{f}");
    // the engine's pitch offset (channel pitch / note fine) on top of the key
    let set = set_from("<region> sample=c4.wav pitch_keycenter=60", |_| Some(mono(261.625_565_3, 44_100.0, 3.0)));
    let mut m = ms(&set);
    m.note_on(0, 69, 69.5, 1.0, NoteExtras::default());
    let (l, _) = run(&mut m, 48_000);
    let f = freq(&l[12_000..], SR);
    assert!((f - 440.0 * 2f64.powf(0.5 / 12.0)).abs() < 0.5, "{f}");
}

#[test]
fn plain_sample_plays_like_the_sampler() {
    // set_sample: one region across the keyboard, the file's root key (57) plays as is
    let mut m = create_instrument(PLUGIN_ID, SR, BLOCK).unwrap();
    m.set_sample(Some(sine_sample(SR, 220.0, 2.0, Some(57))));
    m.note_on(0, 57, 57.0, 1.0, NoteExtras::default());
    let (l, _) = run(m.as_mut(), 24_000);
    let f = freq(&l[2000..], SR);
    assert!((f - 220.0).abs() < 0.3, "{f}");
}

// ── tone / width / gain ──────────────────────────────────────────────────

#[test]
fn tone_width_and_gain() {
    let left = sine(3000.0, SR, 1.0, 0.5);
    let right = sine(3000.0, SR, 1.0, 0.1);
    let set = set_from("<region> sample=a.wav amp_veltrack=0", |_| Some(MsSample::from_planar(&[&left, &right], SR, None, false)));
    let render = |f: &dyn Fn(&mut Multisampler)| {
        let mut m = ms(&set);
        f(&mut m);
        on(&mut m, 60, 1.0);
        run(&mut m, 24_000)
    };
    let (l0, r0) = render(&|_| {});
    let (l1, _) = render(&|m| param(m, "tone", 500.0));
    assert!(db(rms(&l1[4000..])) - db(rms(&l0[4000..])) < -12.0, "tone low-passes 3 kHz");
    let (l2, r2) = render(&|m| param(m, "width", 0.0));
    let diff: f32 = l2[4000..].iter().zip(&r2[4000..]).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
    assert!(diff < 1e-5, "width 0 = mono");
    assert!(db(rms(&l0[4000..])) - db(rms(&r0[4000..])) > 10.0, "width 100 % keeps the stereo image");
    let (l3, _) = render(&|m| param(m, "gain", -12.0));
    assert!((db(rms(&l3[4000..])) - db(rms(&l0[4000..])) + 12.0).abs() < 0.1);
}

// ── polyphony and voice stealing ─────────────────────────────────────────

#[test]
fn polyphony_limit_steals_released_then_oldest() {
    use krypt_studio_dsp::instruments::multisampler::{MAX_POLY, MAX_VOICES};
    let set = set_from("<region> sample=a.wav loop_mode=loop_continuous ampeg_release=1", |_| Some(mono(110.0, SR, 1.0)));
    let mut m = ms(&set);
    for k in 0..(MAX_POLY as u8 + 20) {
        m.note_on(0, 20 + k % 100, 40.0, 0.5, NoteExtras::default());
        run(&mut m, 64);
        assert!(m.active_samples().len() <= MAX_POLY, "sounding voices are capped");
    }
    assert!(m.active_voices() <= MAX_VOICES);
    let (l, r) = run(&mut m, 512);
    assert!(l.iter().chain(&r).all(|v| v.is_finite()));
    // stolen voices fade (5 ms) instead of stopping dead: after 10 ms only MAX_POLY remain
    run(&mut m, 480);
    assert_eq!(m.active_voices(), MAX_POLY);
}

// ── loading (files) ──────────────────────────────────────────────────────

#[cfg(feature = "decode")]
mod files {
    use super::*;
    use krypt_studio_dsp::instruments::multisampler::load::{load_set, LoadOptions};
    use krypt_studio_dsp::wav::{write_wav, WavFormat};
    use std::path::{Path, PathBuf};

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ks-ms-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("samples")).unwrap();
        d
    }

    fn wav(dir: &Path, name: &str, secs: f32, stereo: bool) {
        let s = sine(330.0, 44_100.0, secs, 0.5);
        let ch: Vec<&[f32]> = if stereo { vec![&s, &s] } else { vec![&s] };
        write_wav(&dir.join("samples").join(name), &ch, 44_100, WavFormat::Pcm16).unwrap();
    }

    #[test]
    fn loads_ranges_reports_missing_files_and_honours_the_ram_cap() {
        let dir = temp("load");
        for i in 0..4 {
            wav(&dir, &format!("note {i}.wav"), 1.0, true);
        }
        wav(&dir, "mono.wav", 0.5, false);
        let sfz = dir.join("kit.sfz");
        std::fs::write(
            &sfz,
            "<control> default_path=samples/\n\
             <region> sample=note 0.wav key=60\n\
             <region> sample=note 1.wav key=61\n\
             <region> sample=note 2.wav key=62 offset=1000 end=1999\n\
             <region> sample=note 3.wav key=63\n\
             <region> sample=note 3.wav key=64 trigger=release\n\
             <region> sample=mono.wav key=65\n\
             <region> sample=gone.wav key=66\n\
             <region> sample=note 0.wav key=67 fancy_opcode=1\n",
        )
        .unwrap();
        let set = load_set(&sfz, &LoadOptions::default()).expect("loads");
        assert_eq!(set.regions.len(), 7, "the missing file's region is dropped, the rest play");
        assert_eq!(set.samples.len(), 5, "shared files are decoded once");
        let ranged = &set.samples[set.regions[2].sample as usize];
        assert_eq!(ranged.frames, 1000, "offset/end keep only that range");
        assert_eq!((ranged.channels, ranged.sample_rate), (2, 44_100.0));
        assert_eq!(set.samples[set.regions[5].sample as usize].channels, 1);
        let report: Vec<&str> = set.report.iter().map(|(_, m)| m.as_str()).collect();
        assert!(report[0].starts_with("Loaded kit.sfz: 7 regions, 1 silent, 5 samples"), "{report:?}");
        assert!(report.iter().any(|m| m.contains("missing (samples/gone.wav)")), "{report:?}");
        assert!(report.iter().any(|m| m.contains("ignored 1 unsupported opcode (fancy_opcode)")), "{report:?}");
        // RAM: 4 stereo seconds at 44.1 kHz (minus the trimmed one) + mono ≈ 0.6 MB; a 0.5 MB cap refuses
        let e = load_set(&sfz, &LoadOptions { ram_cap_bytes: 500_000, threads: 2 }).unwrap_err();
        assert!(e.contains("needs more than") && e.contains("RAM"), "{e}");
        // every sample missing → an error naming one
        std::fs::write(&sfz, "<region> sample=nothing.wav").unwrap();
        let e = load_set(&sfz, &LoadOptions::default()).unwrap_err();
        assert!(e.contains("nothing.wav is missing"), "{e}");
        // a missing .sfz
        assert!(load_set(&dir.join("nope.sfz"), &LoadOptions::default()).unwrap_err().contains("Cannot open"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "perf report: cargo test --release -p krypt-studio-dsp --features decode --test multisampler -- --ignored --nocapture"]
    fn load_perf_200_regions() {
        let dir = temp("perf");
        // 200 regions: 50 notes x 4 velocity layers, 6 s stereo 48 kHz FLAC-free WAVs trimmed to 4 s
        let s = sine(220.0, 48_000.0, 6.0, 0.3);
        let mut text = String::from("<control> default_path=samples/\n");
        for i in 0..200 {
            let name = format!("n{i:03}.wav");
            write_wav(&dir.join("samples").join(&name), &[&s, &s], 48_000, WavFormat::Pcm24).unwrap();
            text.push_str(&format!("<region> sample={name} key={} lovel={} hivel={} end=191999\n", 30 + i / 4, (i % 4) * 32 + 1, (i % 4) * 32 + 32));
        }
        let sfz = dir.join("big.sfz");
        std::fs::write(&sfz, text).unwrap();
        let t = std::time::Instant::now();
        let set = Arc::new(load_set(&sfz, &LoadOptions::default()).unwrap());
        println!("{} | wall {:.0} ms | {:.1} MB", set.report[0].1, t.elapsed().as_secs_f64() * 1000.0, set.bytes() as f64 / 1048576.0);
        // playback: 64 voices (pitched: sinc kernel per sample), 3 s at 48 kHz, all sounding
        let mut m = ms(&set);
        for k in 0..64u8 {
            m.note_on(0, 30 + k % 50, 30.3 + (k % 50) as f32, 0.2 + (k % 4) as f32 * 0.25, NoteExtras::default());
        }
        let t = std::time::Instant::now();
        let (l, _) = run(&mut m, 144_000);
        let active = m.active_voices();
        let secs = t.elapsed().as_secs_f64();
        println!("64 voices: {active} active, 3 s of audio in {:.2} s ({:.0}x real time, {:.1} % of one core)", secs, 3.0 / secs, secs / 3.0 * 100.0);
        assert!(l.iter().all(|v| v.is_finite()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ── real-time safety ─────────────────────────────────────────────────────

const RT_SET: &str = "
<global> ampeg_attack=0.002 ampeg_release=0.05
<group> lokey=30 hikey=90 seq_length=2
<region> sample=a.wav seq_position=1 lovel=1 hivel=90 xfout_lovel=60 xfout_hivel=90
<region> sample=b.wav seq_position=2 lovel=1 hivel=90 xfout_lovel=60 xfout_hivel=90 group=1 off_by=1
<region> sample=c.wav lovel=60 hivel=127 xfin_lovel=60 xfin_hivel=90 loop_mode=loop_sustain loop_start=100 loop_end=4000 ampeg_delay=0.01
<group> lokey=30 hikey=90
<region> sample=r.wav trigger=release rt_decay=3 lorand=0 hirand=0.6
<region> sample=r2.wav trigger=release lorand=0.6 hirand=1 loop_mode=one_shot
<region> sample=l.wav loop_mode=loop_continuous group=2 off_by=1 off_mode=normal
";

#[test]
fn multisampler_does_not_allocate_on_the_audio_thread() {
    let set = set_from(RT_SET, |n| Some(if n == "c.wav" { mono(150.0, 44_100.0, 0.3) } else { mono(300.0, 48_000.0, 0.2) }));
    let mut inst = create_instrument(PLUGIN_ID, SR, BLOCK).unwrap();
    inst.set_multisample(Some(set));
    let d = descriptor(PLUGIN_ID).unwrap();
    let ranges: Vec<(f32, f32)> = d.params.iter().map(|p| (p.min, p.max)).collect();
    let (mut l, mut r) = (vec![0.0f32; BLOCK], vec![0.0f32; BLOCK]);
    assert_no_alloc(|| {
        for round in 0..200usize {
            for (i, (lo, hi)) in ranges.iter().enumerate() {
                let t = ((round * 7 + i * 3) % 11) as f32 / 10.0;
                inst.set_param(i, lo + (hi - lo) * t);
            }
            inst.set_voice_mode(round % 9 == 0, 0.0);
            for k in 0..8u8 {
                let key = 30 + ((round * 5 + k as usize * 7) % 60) as u8;
                let ex = NoteExtras { pan: 0.2, ..Default::default() };
                inst.note_on(k as usize * 13, key, key as f32 + 0.3, ((round + k as usize) % 10) as f32 / 9.0, ex);
            }
            for k in 0..5u8 {
                inst.note_off(120 + k as usize, 30 + ((round * 5 + k as usize * 7) % 60) as u8);
            }
            if round % 17 == 0 {
                inst.choke(40);
            }
            inst.note_on(BLOCK + 3, 64, 64.0, 0.7, NoteExtras::default());
            let ctx = ProcessContext { sample_rate: SR, bpm: 120.0, beats_per_bar: 4.0, playing: true, beat_pos: round as f64, frames: BLOCK };
            l.iter_mut().for_each(|v| *v = 0.0);
            r.iter_mut().for_each(|v| *v = 0.0);
            inst.process(&ctx, [&mut l, &mut r]);
            let _ = inst.activity();
            let _ = inst.is_active();
            if round == 150 {
                inst.all_off();
            }
        }
    });
    assert!(l.iter().chain(&r).all(|v| v.is_finite()));
}

// ── contract ─────────────────────────────────────────────────────────────

/// research/12 §2 fixes the param ids and their order.
#[test]
fn params_match_the_contract() {
    let d = descriptor(PLUGIN_ID).unwrap();
    let ids: Vec<&str> = d.params.iter().map(|p| p.id).collect();
    assert_eq!(ids, ["gain", "attack", "release", "velSens", "tone", "tune", "fine", "releaseSamples", "width", "roundRobin"]);
    assert_eq!(d.uses_sample, Some(true));
    assert_eq!(d.name, "Krypt Multisampler");
    let spec = |id: &str| d.params.iter().find(|p| p.id == id).unwrap().clone();
    // '%' params are fractions in this codebase (UI shows v × 100 %): release 0..400 %, the rest 0..100 %.
    assert_eq!((spec("release").min, spec("release").max, spec("release").default), (0.0, 4.0, 1.0));
    for id in ["velSens", "releaseSamples", "width"] {
        assert_eq!((spec(id).min, spec(id).max, spec(id).default, spec(id).unit), (0.0, 1.0, 1.0, "%"), "{id}");
    }
    assert_eq!((spec("gain").min, spec("gain").max), (-24.0, 12.0));
    assert_eq!((spec("attack").min, spec("attack").max, spec("attack").unit), (0.0, 2000.0, "ms"));
    assert_eq!((spec("tone").min, spec("tone").max, spec("tone").default, spec("tone").scale), (200.0, 20000.0, 20000.0, "log"));
    assert_eq!((spec("tune").min, spec("tune").max, spec("tune").unit), (-24.0, 24.0, "st"));
    assert_eq!((spec("fine").min, spec("fine").max, spec("fine").unit), (-100.0, 100.0, "ct"));
    assert_eq!(spec("roundRobin").options.as_deref(), Some(&["Off", "On"][..]));
    assert_eq!(spec("roundRobin").default, 1.0);
}

#[test]
#[ignore = "perf: cargo test --release -p krypt-studio-dsp --test multisampler bench_paths -- --ignored --nocapture"]
fn bench_paths() {
    for (label, sr, offset) in [("48k src, +0.3 st (step 1.017)", 48_000.0f32, 0.3f32), ("44.1k src, +0.3 st (step 0.935)", 44_100.0, 0.3), ("48k src, 0 st (step 1)", 48_000.0, 0.0), ("48k src, +5 st (step 1.33)", 48_000.0, 5.0)] {
        let set = set_from("<region> sample=a.wav pitch_keycenter=60 loop_mode=loop_continuous", |_| {
            let s = sine(220.0, sr, 4.0, 0.3);
            Some(MsSample::from_planar(&[&s, &s], sr, None, false))
        });
        let mut m = ms(&set);
        for k in 0..64u8 {
            m.note_on(0, 60, 60.0 + offset, 0.8, NoteExtras::default());
            let _ = k;
        }
        let t = std::time::Instant::now();
        run(&mut m, 144_000);
        let secs = t.elapsed().as_secs_f64();
        println!("{label}: 64 voices ({} active) {:.1} % of one core", m.active_voices(), secs / 3.0 * 100.0);
    }
}
