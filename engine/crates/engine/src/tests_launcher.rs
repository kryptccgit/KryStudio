use super::*;
use crate::launcher::{LaunchCmd, LaunchRecMsg, LauncherCtl, LauncherTel};
use crate::program::NONE;
use crate::protocol::{Out, OutMode};
use std::sync::atomic::Ordering::Relaxed as R;

const BAR: u64 = 96_000;
const BEAT: u64 = 24_000;

fn fr(ticks: f64) -> u64 {
    (ticks * 25.0).round() as u64
}

fn add_track(p: &mut Value, id: &str) {
    p["playlist"]["tracks"][id] = json!({ "id": id, "name": id, "color": "#000", "height": 44, "mute": false, "solo": false });
    p["playlist"]["trackOrder"].as_array_mut().unwrap().push(json!(id));
}

fn add_pattern(p: &mut Value, id: &str, ch: &str, notes: &[(f64, f64, u8)]) {
    if p["patterns"].get(id).is_none() {
        p["patterns"][id] = json!({ "id": id, "name": id, "color": "#fff", "length": null, "notes": {} });
        p["patternOrder"].as_array_mut().unwrap().push(json!(id));
    }
    for (i, &(tick, dur, key)) in notes.iter().enumerate() {
        add_note(p, id, ch, &format!("{id}-{i}"), tick, dur, key);
    }
}

fn session(p: &mut Value, scenes: &[&str], quantize: &str) {
    let mut sc = serde_json::Map::new();
    for s in scenes {
        sc.insert(s.to_string(), json!({ "id": s, "name": s, "color": null, "tempo": null }));
    }
    p["session"] = json!({ "scenes": sc, "sceneOrder": scenes, "clips": {}, "quantize": quantize });
}

fn lclip(p: &mut Value, id: &str, track: &str, scene: &str, extra: Value) {
    let mut c = json!({ "id": id, "trackId": track, "sceneId": scene, "kind": "pattern", "patternId": "pa", "color": null,
                        "length": 3840, "offset": 0, "loop": true, "launchMode": "trigger" });
    for (k, v) in extra.as_object().unwrap() {
        c[k] = v.clone();
    }
    p["session"]["clips"][id] = c;
}

fn extend_song(p: &mut Value, bars: f64) {
    add_clip(p, "zz-extend", "pattern", 0.0, bars * 3840.0, json!({ "patternId": "pa", "mute": true }));
}

fn proj(notes: &[(f64, f64, u8)]) -> Value {
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_pattern(&mut p, "pa", "c1", notes);
    extend_song(&mut p, 16.0);
    p
}

impl Live {
    fn clip(&self, id: &str) -> u32 {
        self.session.launcher.clip_slot(id).unwrap_or_else(|| panic!("no launch clip {id}"))
    }
    fn launch(&mut self, id: &str) {
        let clip = self.clip(id);
        self.send(Cmd::Launcher(LaunchCmd::Launch { clip, release: false }));
    }
    fn release(&mut self, id: &str) {
        let clip = self.clip(id);
        self.send(Cmd::Launcher(LaunchCmd::Launch { clip, release: true }));
    }
    fn scene(&mut self, id: &str) {
        let s = self.session.launcher.scene_slot(id).unwrap();
        self.send(Cmd::Launcher(LaunchCmd::Scene(s)));
    }
    fn run_to(&mut self, f: u64) {
        let done = FRAMES.with(|c| c.get());
        if f > done {
            self.run((f - done) as usize);
            FRAMES.with(|c| c.set(f));
        }
    }
    fn tel(&self) -> LauncherTel {
        crate::launcher::telemetry(&self.core.shared.launch, &self.session.names.launch).expect("launcher telemetry")
    }
    fn rebuild(&mut self) {
        self.session.version += 1;
        let b = self.session.build(false);
        self.send(Cmd::Batch(b));
    }
}

thread_local! {
    static FRAMES: Cell<u64> = const { Cell::new(0) };
}

fn fresh(p: &Value) -> Live {
    FRAMES.with(|c| c.set(0));
    Live::new(p)
}

fn ons_of(log: &[Rec], key: u8) -> Vec<u64> {
    log.iter().filter(|r| r.kind == "on" && r.key == key).map(|r| r.frame).collect()
}

fn on_keys(log: &[Rec]) -> Vec<(u8, u64)> {
    ons(log)
}

#[test]
fn launch_waits_for_its_quantize_boundary() {
    for (q, expect) in [("1bar", BAR), ("1/4", 2 * BEAT), ("none", 30_000)] {
        let mut p = proj(&[(0.0, 240.0, 60)]);
        session(&mut p, &["s1"], "1bar");
        lclip(&mut p, "l1", "t1", "s1", json!({ "quantize": q }));
        let mut live = fresh(&p);
        live.send(Cmd::Play);
        live.run_to(30_000);
        log_take();
        live.launch("l1");
        live.run_to(30_000 + 200_000);
        let o = ons_of(&log_take(), 60);
        assert_eq!(o.first().copied(), Some(expect), "quantize {q}: {o:?}");
        assert_eq!(o.get(1).copied(), Some(expect + BAR), "quantize {q}: the clip loops every 3840 ticks");
    }
    let mut p = proj(&[(0.0, 240.0, 60)]);
    session(&mut p, &["s1"], "1/2");
    lclip(&mut p, "l1", "t1", "s1", json!({}));
    let mut live = fresh(&p);
    live.send(Cmd::Play);
    live.run_to(30_000);
    log_take();
    live.launch("l1");
    live.run_to(60_000);
    assert_eq!(ons_of(&log_take(), 60), vec![48_000]);
}

#[test]
fn pattern_mode_quantizes_on_ticks_since_play_start() {
    let mut p = proj(&[(0.0, 100.0, 60)]);
    p["transport"]["mode"] = json!("pattern");
    add_pattern(&mut p, "pb", "c1", &[(0.0, 100.0, 72)]);
    session(&mut p, &["s1"], "1/4");
    lclip(&mut p, "l1", "t1", "s1", json!({ "patternId": "pb" }));
    let mut live = fresh(&p);
    live.send(Cmd::Play);
    live.run_to(30_000);
    live.send(Cmd::Pause);
    live.run_to(30_480);
    live.send(Cmd::Play);
    live.run_to(40_480);
    log_take();
    live.launch("l1");
    live.run_to(100_000);
    assert_eq!(ons_of(&log_take(), 72), vec![30_480 + BEAT]);
    assert!(!live.core.shared.song_mode.load(R), "launching while playing keeps pattern mode");
}

#[test]
fn launching_while_stopped_starts_song_mode_at_once() {
    let mut p = proj(&[(0.0, 240.0, 60)]);
    p["transport"]["mode"] = json!("pattern");
    session(&mut p, &["s1"], "4bars");
    lclip(&mut p, "l1", "t1", "s1", json!({}));
    let mut live = fresh(&p);
    live.run_to(4800);
    assert!(!live.core.shared.playing.load(R));
    live.launch("l1");
    live.run_to(4800 + 10_000);
    assert_eq!(on_keys(&log_take()), vec![(60, 4800)], "no quantize wait, and no pattern-mode playback");
    assert!(live.core.shared.playing.load(R));
    assert!(live.core.shared.song_mode.load(R), "the launcher plays in song mode");
    live.send(Cmd::Stop);
    live.run_to(4800 + 10_000 + 480);
    assert!(!live.core.shared.song_mode.load(R), "back to the document's pattern mode after stop");
}

#[test]
fn launch_clips_loop_from_their_offset() {
    let notes = [(0.0, 100.0, 60), (1920.0, 100.0, 62), (2880.0, 100.0, 64)];
    let mut p = proj(&notes);
    session(&mut p, &["s1", "s2"], "none");
    lclip(&mut p, "l1", "t1", "s1", json!({ "length": 1920, "offset": 960 }));
    lclip(&mut p, "l2", "t1", "s2", json!({ "length": 1920, "offset": 3000 }));
    let mut live = fresh(&p);
    live.launch("l1");
    live.run_to(130_000);
    assert_eq!(on_keys(&log_take()), vec![(62, 24_000), (62, 72_000), (62, 120_000)]);
    live.send(Cmd::Stop);
    live.run_to(130_080);
    log_take();
    live.launch("l2");
    live.run_to(130_080 + 80_000);
    assert_eq!(on_keys(&log_take()), vec![(60, 130_080 + fr(840.0)), (60, 130_080 + fr(840.0 + 1920.0))]);
}

#[test]
fn loop_off_plays_once_then_stops_the_track() {
    let mut p = proj(&[(0.0, 100.0, 60), (960.0, 100.0, 61), (1920.0, 100.0, 62)]);
    session(&mut p, &["s1"], "none");
    lclip(&mut p, "l1", "t1", "s1", json!({ "length": 1920, "loop": false }));
    let mut live = fresh(&p);
    live.launch("l1");
    live.run_to(300_000);
    assert_eq!(on_keys(&log_take()), vec![(60, 0), (61, 24_000)]);
    let t = live.tel();
    assert!(t.playing.is_empty(), "{:?}", t.playing);
    assert_eq!(t.overridden, vec!["t1".to_string()], "stopped from the launcher = still overridden");
    let slot = live.session.launcher.track_slot("t1").unwrap() as usize;
    assert_eq!(live.core.shared.launch.playing[slot].load(R), NONE);
}

#[test]
fn override_silences_the_arrangement_until_back_to_arrangement() {
    let mut p = proj(&[(0.0, 240.0, 60)]);
    add_pattern(&mut p, "pb", "c1", &[(0.0, 240.0, 72)]);
    add_pattern(&mut p, "pc", "c1", &[(0.0, 240.0, 50)]);
    add_track(&mut p, "t2");
    add_clip(&mut p, "a1", "pattern", 0.0, 8.0 * 3840.0, json!({ "patternId": "pa" }));
    add_clip(&mut p, "a2", "pattern", 0.0, 8.0 * 3840.0, json!({ "patternId": "pc", "trackId": "t2" }));
    session(&mut p, &["s1"], "1bar");
    lclip(&mut p, "l1", "t1", "s1", json!({ "patternId": "pb" }));
    let mut live = fresh(&p);
    live.send(Cmd::Play);
    live.run_to(9600);
    live.launch("l1");
    live.run_to(249_600);
    assert!(live.tel().overridden.contains(&"t1".to_string()));
    live.send(Cmd::Launcher(LaunchCmd::BackToArrangement));
    live.run_to(500_160);
    let log = log_take();
    assert_eq!(ons_of(&log, 60), vec![0, 3 * BAR, 4 * BAR, 5 * BAR], "t1's arrangement: silent while overridden, back from bar 4");
    assert_eq!(ons_of(&log, 72), vec![BAR, 2 * BAR], "the launch clip: from bar 2 until back to arrangement");
    assert_eq!(ons_of(&log, 50), vec![0, BAR, 2 * BAR, 3 * BAR, 4 * BAR, 5 * BAR], "other tracks keep playing");
    let t = live.tel();
    assert!(t.overridden.is_empty() && t.playing.is_empty());
}

#[test]
fn back_to_arrangement_resumes_audio_clips_mid_clip() {
    let mut p = proj(&[]);
    add_pattern(&mut p, "pb", "c1", &[(0.0, 240.0, 72)]);
    add_channel(&mut p, "ca", "krypt.audioclip", "i1");
    p["samples"]["s1"] = json!({ "id": "s1", "name": "x", "path": "does-not-exist.wav" });
    p["channels"]["ca"]["generator"]["sampleId"] = json!("s1");
    add_clip(&mut p, "k1", "audio", 0.0, 8.0 * 3840.0, json!({ "channelId": "ca" }));
    session(&mut p, &["s1"], "none");
    lclip(&mut p, "l1", "t1", "s1", json!({ "patternId": "pb" }));
    let mut live = fresh(&p);
    live.send(Cmd::Play);
    live.run_to(48_000);
    live.launch("l1");
    live.run_to(150_240);
    live.send(Cmd::Launcher(LaunchCmd::BackToArrangement));
    live.run_to(151_200);
    let log = log_take();
    let audio: Vec<(&str, u64, f64)> = log.iter().filter(|r| r.key == 60 && r.kind != "alloff").map(|r| (r.kind, r.frame, r.sample_start)).collect();
    assert_eq!(audio[0], ("on", 0, 0.0));
    assert_eq!((audio[1].0, audio[1].1), ("off", 48_000), "the override cuts the arrangement audio clip: {audio:?}");
    let on = audio[2];
    assert_eq!((on.0, on.1), ("on", 150_240), "{audio:?}");
    assert!((on.2 - 150_240.0 / 48_000.0).abs() < 1e-3, "resumes at the playhead: {}", on.2);
    assert_eq!(ons_of(&log, 72), vec![48_000, 48_000 + BAR]);
}

#[test]
fn scenes_launch_rows_and_stop_tracks_without_a_clip() {
    let mut p = proj(&[(0.0, 240.0, 60)]);
    add_pattern(&mut p, "pb", "c1", &[(0.0, 240.0, 62)]);
    add_pattern(&mut p, "pc", "c1", &[(0.0, 240.0, 50)]);
    add_pattern(&mut p, "pd", "c1", &[(0.0, 240.0, 52)]);
    add_track(&mut p, "t2");
    add_track(&mut p, "t3");
    add_clip(&mut p, "a2", "pattern", 0.0, 8.0 * 3840.0, json!({ "patternId": "pc", "trackId": "t2" }));
    add_clip(&mut p, "a3", "pattern", 0.0, 8.0 * 3840.0, json!({ "patternId": "pd", "trackId": "t3" }));
    session(&mut p, &["s1", "s2"], "1bar");
    lclip(&mut p, "l1", "t1", "s1", json!({}));
    lclip(&mut p, "l2", "t2", "s2", json!({ "patternId": "pb" }));
    let mut live = fresh(&p);
    live.send(Cmd::Play);
    live.run_to(9600);
    live.scene("s1");
    live.run_to(BAR + 9600);
    live.scene("s2");
    live.run_to(3 * BAR + 480);
    let log = log_take();
    assert_eq!(ons_of(&log, 60), vec![BAR], "s1: t1 plays l1 for one bar");
    assert_eq!(ons_of(&log, 50), vec![0], "s1: t2 has clips but none in s1, so it stops (overridden)");
    assert_eq!(ons_of(&log, 62), vec![2 * BAR, 3 * BAR], "s2: t2 plays l2");
    assert_eq!(ons_of(&log, 52), vec![0, BAR, 2 * BAR, 3 * BAR], "t3 has no launch clips: untouched");
}

fn follow(action: &str, chance: f64, other: &str, bars: f64) -> Value {
    json!({ "action": action, "chance": chance, "otherAction": other, "afterBars": bars })
}

#[test]
fn follow_next_skips_empty_slots_and_wraps() {
    let mut p = proj(&[(0.0, 240.0, 60)]);
    add_pattern(&mut p, "pc", "c1", &[(0.0, 240.0, 64)]);
    session(&mut p, &["s1", "s2", "s3"], "1bar");
    lclip(&mut p, "l1", "t1", "s1", json!({ "follow": follow("next", 1.0, "none", 1.0) }));
    lclip(&mut p, "l3", "t1", "s3", json!({ "patternId": "pc", "follow": follow("next", 1.0, "none", 1.0) }));
    let mut live = fresh(&p);
    live.launch("l1");
    live.run_to(4 * BAR + 480);
    assert_eq!(on_keys(&log_take()), vec![(60, 0), (64, BAR), (60, 2 * BAR), (64, 3 * BAR), (60, 4 * BAR)]);
}

fn three_clip_follow(action: &str) -> Value {
    let mut p = proj(&[(0.0, 100.0, 60)]);
    add_pattern(&mut p, "pb", "c1", &[(0.0, 100.0, 62)]);
    add_pattern(&mut p, "pc", "c1", &[(0.0, 100.0, 64)]);
    session(&mut p, &["s1", "s2", "s3"], "1bar");
    for (id, scene, pat) in [("l1", "s1", "pa"), ("l2", "s2", "pb"), ("l3", "s3", "pc")] {
        lclip(&mut p, id, "t1", scene, json!({ "patternId": pat, "length": 960, "follow": follow(action, 1.0, "none", 0.25) }));
    }
    p
}

fn follow_run(p: &Value, beats: u64) -> Vec<u8> {
    let mut live = fresh(p);
    live.launch("l1");
    live.run_to(beats * BEAT + 480);
    let o = on_keys(&log_take());
    for (i, (_, f)) in o.iter().enumerate() {
        assert_eq!(*f, i as u64 * BEAT, "one clip per beat: {o:?}");
    }
    o.into_iter().map(|(k, _)| k).collect()
}

#[test]
fn follow_other_never_repeats_and_draws_are_deterministic() {
    let p = three_clip_follow("other");
    let a = follow_run(&p, 40);
    assert_eq!(a.len(), 41);
    assert!(a.windows(2).all(|w| w[0] != w[1]), "'other' repeated a clip: {a:?}");
    for k in [60, 62, 64] {
        assert!(a.contains(&k), "{k} never played: {a:?}");
    }
    assert_eq!(follow_run(&p, 40), a, "same transport start, same clip ids → same choices");
    let any = follow_run(&three_clip_follow("any"), 60);
    assert!(any.windows(2).any(|w| w[0] == w[1]), "'any' never repeated in 60 draws: {any:?}");
}

#[test]
fn follow_chance_picks_action_or_other_action() {
    for (chance, expect) in [(0.0, vec![(60u8, 0u64)]), (1.0, vec![(60, 0), (62, BAR), (62, 2 * BAR)])] {
        let mut p = proj(&[(0.0, 100.0, 60)]);
        add_pattern(&mut p, "pb", "c1", &[(0.0, 100.0, 62)]);
        session(&mut p, &["s1", "s2"], "1bar");
        lclip(&mut p, "l1", "t1", "s1", json!({ "follow": follow("next", chance, "stop", 1.0) }));
        lclip(&mut p, "l2", "t1", "s2", json!({ "patternId": "pb" }));
        let mut live = fresh(&p);
        live.launch("l1");
        live.run_to(2 * BAR + 480);
        assert_eq!(on_keys(&log_take()), expect, "chance {chance}");
    }
}

#[test]
fn gate_clips_stop_on_release_at_the_quantize_step() {
    let sixteenths: Vec<(f64, f64, u8)> = (0..16).map(|i| (i as f64 * 240.0, 120.0, 60)).collect();
    let mut p = proj(&sixteenths);
    session(&mut p, &["s1"], "1bar");
    lclip(&mut p, "l1", "t1", "s1", json!({ "launchMode": "gate", "quantize": "1/4" }));
    let mut live = fresh(&p);
    live.launch("l1");
    live.run_to(30_240);
    live.release("l1");
    live.run_to(150_240);
    let o = ons_of(&log_take(), 60);
    assert_eq!(o, (0..8).map(|i| i * 6000).collect::<Vec<u64>>(), "held from 0, released at tick 1209 → stops at tick 1920");
    live.release("l1");
    live.launch("l1");
    live.run_to(150_720);
    live.release("l1");
    live.run_to(400_000);
    assert!(ons_of(&log_take(), 60).is_empty());
}

#[test]
fn toggle_clips_stop_when_launched_again() {
    let mut p = proj(&[(0.0, 100.0, 60)]);
    session(&mut p, &["s1"], "1bar");
    lclip(&mut p, "l1", "t1", "s1", json!({ "launchMode": "toggle" }));
    let mut live = fresh(&p);
    live.launch("l1");
    live.run_to(30_240);
    live.launch("l1");
    live.run_to(30_720);
    let t = live.tel();
    assert_eq!(t.queued.get("t1").map(String::as_str), Some("stop"));
    assert_eq!(t.playing.get("t1").map(String::as_str), Some("l1"));
    let pr = t.progress["l1"];
    assert!((pr - 30_720.0 / BAR as f32).abs() < 0.01, "progress {pr}");
    live.run_to(300_000);
    assert_eq!(ons_of(&log_take(), 60), vec![0]);
    live.launch("l1");
    live.run_to(400_000);
    assert_eq!(ons_of(&log_take(), 60), vec![4 * BAR], "launching a stopped toggle clip plays it again");
}

#[test]
fn repeat_clips_retrigger_every_step_while_held() {
    let mut p = proj(&[(0.0, 100.0, 60)]);
    session(&mut p, &["s1"], "1bar");
    lclip(&mut p, "l1", "t1", "s1", json!({ "launchMode": "repeat", "quantize": "1/4" }));
    let mut live = fresh(&p);
    live.send(Cmd::Play);
    live.run_to(9600);
    live.launch("l1");
    live.run_to(80_160);
    live.release("l1");
    live.run_to(170_080);
    assert_eq!(ons_of(&log_take(), 60), vec![BEAT, 2 * BEAT, 3 * BEAT, 3 * BEAT + BAR], "retriggers while held, then loops normally");
}

fn audio_proj() -> Value {
    let mut p = proj(&[(0.0, 100.0, 60), (3000.0, 100.0, 61)]);
    add_channel(&mut p, "ca", "krypt.audioclip", "i1");
    p["channels"]["ca"]["rootKey"] = json!(48);
    p["samples"]["s1"] = json!({ "id": "s1", "name": "x", "path": "does-not-exist.wav" });
    p["channels"]["ca"]["generator"]["sampleId"] = json!("s1");
    session(&mut p, &["s1", "s2"], "none");
    lclip(&mut p, "la", "t1", "s1", json!({ "kind": "audio", "channelId": "ca", "patternId": null, "offset": 480, "length": 1920, "gain": 0.5 }));
    add_track(&mut p, "t2");
    lclip(&mut p, "lp", "t2", "s1", json!({}));
    p
}

#[test]
fn audio_launch_clips_play_the_sample_from_their_offset() {
    let mut live = fresh(&audio_proj());
    live.launch("la");
    let buf = live.run(4800);
    FRAMES.with(|c| c.set(4800));
    assert!(near(buf[2 * 1000], DC1 * 0.5, 1e-4), "clip gain: {}", buf[2 * 1000]);
    live.run_to(100_000);
    let log = log_take();
    let on: Vec<(u64, f64)> = log.iter().filter(|r| r.kind == "on" && r.key == 48).map(|r| (r.frame, r.sample_start)).collect();
    assert_eq!(on.len(), 3, "{on:?}");
    for (i, (f, ss)) in on.iter().enumerate() {
        assert_eq!(*f, i as u64 * 48_000);
        assert!((ss - 0.25).abs() < 1e-9, "every pass restarts at the offset (480 ticks = 0.25 s): {ss}");
    }
}

#[test]
fn song_loop_jumps_do_not_restart_launch_clips() {
    let mut p = audio_proj();
    p["transport"]["loop"] = json!({ "enabled": true, "start": 0, "end": 2880 });
    let mut live = fresh(&p);
    live.launch("la");
    live.launch("lp");
    live.run_to(100_080);
    let log = log_take();
    let audio: Vec<(u64, f64)> = log.iter().filter(|r| r.kind == "on" && r.key == 48).map(|r| (r.frame, r.sample_start)).collect();
    assert_eq!(audio.iter().map(|a| a.0).collect::<Vec<_>>(), vec![0, 48_000, 72_000, 96_000], "{audio:?}");
    assert!((audio[2].1 - 0.75).abs() < 1e-6, "after the loop jump at tick 2880 it resumes 960 ticks into the pass: {}", audio[2].1);
    assert!((audio[3].1 - 0.25).abs() < 1e-9);
    assert_eq!(on_keys(&log).into_iter().filter(|k| k.0 != 48).collect::<Vec<_>>(), vec![(60, 0), (61, 75_000), (60, BAR)]);
}

fn spans(live: &Live, ctl: &mut LauncherCtl) -> Vec<Value> {
    ctl.drain_records(&live.session.names.launch)
}

#[test]
fn launch_recording_logs_spans_and_reports_on_stop() {
    let mut p = proj(&[(0.0, 100.0, 60)]);
    add_pattern(&mut p, "pb", "c1", &[(0.0, 100.0, 72)]);
    session(&mut p, &["s1", "s2"], "1bar");
    lclip(&mut p, "l1", "t1", "s1", json!({}));
    lclip(&mut p, "l2", "t1", "s2", json!({ "patternId": "pb" }));
    let mut live = fresh(&p);
    let mut ctl = LauncherCtl::new(&live.core.shared.launch, None);
    live.send(Cmd::Launcher(LaunchCmd::Record(true)));
    live.send(Cmd::Launcher(LaunchCmd::Record(false)));
    live.run_to(480);
    assert!(spans(&live, &mut ctl).is_empty());
    live.send(Cmd::Launcher(LaunchCmd::Record(true)));
    live.launch("l1");
    live.run_to(100_080);
    assert!(live.tel().recording);
    live.launch("l2");
    live.run_to(250_080);
    assert!(spans(&live, &mut ctl).is_empty(), "nothing until the transport stops");
    live.send(Cmd::Stop);
    live.run_to(250_560);
    let ev = spans(&live, &mut ctl);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["event"], "launchRecorded");
    let e = ev[0]["entries"].as_array().unwrap();
    assert_eq!(e.len(), 2, "{e:?}");
    assert_eq!((e[0]["trackId"].as_str(), e[0]["clipId"].as_str()), (Some("t1"), Some("l1")));
    assert_eq!((e[0]["startTick"].as_f64(), e[0]["endTick"].as_f64(), e[0]["offset"].as_f64()), (Some(0.0), Some(7680.0), Some(0.0)));
    assert_eq!((e[1]["clipId"].as_str(), e[1]["startTick"].as_f64(), e[1]["offset"].as_f64()), (Some("l2"), Some(7680.0), Some(0.0)));
    let end = e[1]["endTick"].as_f64().unwrap();
    assert!((end - (250_080.0 - 480.0) / 25.0).abs() < 0.1, "ends where the transport stopped (it started at frame 480): {end}");
    live.launch("l1");
    live.run_to(260_160);
    live.send(Cmd::Launcher(LaunchCmd::Record(false)));
    live.run_to(260_640);
    let ev = spans(&live, &mut ctl);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["entries"].as_array().unwrap().len(), 1);
    assert!(!live.tel().recording);
}

#[test]
fn launch_recording_runs_past_the_end_of_an_empty_song() {
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_pattern(&mut p, "pa", "c1", &[(0.0, 100.0, 60)]);
    session(&mut p, &["s1"], "1bar");
    lclip(&mut p, "l1", "t1", "s1", json!({}));
    let mut live = fresh(&p);
    let mut ctl = LauncherCtl::new(&live.core.shared.launch, None);
    live.send(Cmd::Launcher(LaunchCmd::Record(true)));
    live.launch("l1");
    live.run_to(250_080);
    live.send(Cmd::Stop);
    live.run_to(250_560);
    let ev = spans(&live, &mut ctl);
    let e = ev[0]["entries"].as_array().unwrap();
    assert_eq!(e.len(), 1, "one unbroken span: {e:?}");
    assert_eq!(e[0]["startTick"].as_f64(), Some(0.0));
    assert!(e[0]["endTick"].as_f64().unwrap() > 9000.0, "{}", e[0]["endTick"]);
}

#[test]
fn launch_recording_splits_spans_at_song_loop_jumps() {
    let mut p = proj(&[(0.0, 100.0, 60)]);
    p["transport"]["loop"] = json!({ "enabled": true, "start": 0, "end": 7680 });
    session(&mut p, &["s1"], "1bar");
    lclip(&mut p, "l1", "t1", "s1", json!({ "length": 5000 }));
    let mut live = fresh(&p);
    let mut ctl = LauncherCtl::new(&live.core.shared.launch, None);
    live.send(Cmd::Launcher(LaunchCmd::Record(true)));
    live.launch("l1");
    live.run_to(250_080);
    live.send(Cmd::Stop);
    live.run_to(250_560);
    let ev = spans(&live, &mut ctl);
    let e = ev[0]["entries"].as_array().unwrap();
    assert_eq!(e.len(), 2, "{e:?}");
    assert_eq!((e[0]["startTick"].as_f64(), e[0]["endTick"].as_f64(), e[0]["offset"].as_f64()), (Some(0.0), Some(7680.0), Some(0.0)));
    assert_eq!(e[1]["startTick"].as_f64(), Some(0.0));
    assert!((e[1]["offset"].as_f64().unwrap() - 2680.0).abs() < 1e-6, "the loop position at the jump: {}", e[1]["offset"]);
    assert!((e[1]["endTick"].as_f64().unwrap() - (10_003.2 - 7680.0)).abs() < 0.1, "{}", e[1]["endTick"]);
}

#[test]
fn grid_notes_are_swallowed_and_launch() {
    let mut p = proj(&[(0.0, 100.0, 60)]);
    session(&mut p, &["s1"], "none");
    lclip(&mut p, "l1", "t1", "s1", json!({}));
    let mut live = fresh(&p);
    let ends = attach_live(&mut live);
    live.core.shared.live.target_slot.store(live.session.channel_slot("c1").unwrap(), R);
    let mut ctl = LauncherCtl::new(&live.core.shared.launch, Some(ends.sink.clone()));
    let grid = json!({ "device": "Pads", "channel": 0, "notes": { "36": { "clipId": "l1" }, "37": { "stopTrackId": null } } });
    let r = ctl.command("setLaunchGrid", &grid, &live.session).unwrap().unwrap();
    assert_eq!(r.0["notes"], 2);
    assert!(ctl.command("setLaunchGrid", &json!({ "notes": { "200": { "clipId": "l1" } } }), &live.session).unwrap().is_err());
    let feed = |dev: &str, bytes: &[u8]| {
        let d: Arc<str> = Arc::from(dev);
        let mut rs = 0;
        ends.sink.feed_at(crate::midi::now_ns(), &d, bytes, &mut rs);
    };
    feed("Pads", &[0x90, 36, 100]);
    feed("Pads", &[0x90, 50, 100]);
    feed("Keys", &[0x90, 36, 100]);
    feed("Pads", &[0x91, 36, 100]);
    live.run_to(4800);
    let mut live_keys: Vec<u8> = on_keys(&log_take()).into_iter().map(|k| k.0).collect();
    live_keys.sort_unstable();
    assert_eq!(live_keys, vec![36, 36, 50], "the grid note never reached the MIDI target");
    let out = Out::new(OutMode::Cli);
    let clip = live.clip("l1");
    assert_eq!(ctl.tick(&live.session, &out), vec![LaunchCmd::Launch { clip, release: false }]);
    feed("Pads", &[0x80, 36, 0]);
    feed("Pads", &[0x90, 37, 0]);
    feed("Pads", &[0x90, 37, 90]);
    assert_eq!(ctl.tick(&live.session, &out), vec![LaunchCmd::Launch { clip, release: true }, LaunchCmd::Stop(NONE)]);
    live.send(Cmd::Launcher(LaunchCmd::Launch { clip, release: false }));
    live.run_to(9600);
    assert_eq!(on_keys(&log_take()), vec![(60, 4800)]);
    ctl.command("setLaunchGrid", &json!({ "device": null, "channel": null, "notes": {} }), &live.session).unwrap().unwrap();
    feed("Pads", &[0x90, 36, 100]);
    live.run_to(14_400);
    assert_eq!(ons_of(&log_take(), 36).len(), 1);
    assert!(ctl.tick(&live.session, &out).is_empty());
}

#[test]
fn session_entity_prunes_launch_clips_and_stops_them() {
    let mut p = proj(&[(0.0, 100.0, 60)]);
    session(&mut p, &["s1"], "none");
    lclip(&mut p, "l1", "t1", "s1", json!({}));
    let mut live = fresh(&p);
    live.launch("l1");
    live.run_to(BAR + 480);
    assert_eq!(ons_of(&log_take(), 60), vec![0, BAR]);
    let mut w = Warnings::default();
    live.session.model.upsert_entity("session", "", &json!({ "quantize": "1bar", "sceneOrder": ["s1"], "clipIds": [] }), &mut w);
    assert!(live.session.model.launch_clips.is_empty());
    live.rebuild();
    live.run_to(4 * BAR);
    assert!(ons_of(&log_take(), 60).is_empty(), "the removed clip stopped");
    assert!(crate::launcher::telemetry(&live.core.shared.launch, &live.session.names.launch).is_none(), "no launch clips → no launcher telemetry");
    assert!(live.session.launcher.clip_slot("l1").is_none());
}

#[test]
fn offline_render_ignores_the_launcher() {
    let mut p = proj(&[(0.0, 240.0, 60)]);
    add_clip(&mut p, "a1", "pattern", 0.0, 7680.0, json!({ "patternId": "pa" }));
    let plain = render_p(&p, RenderScope::Range { start_tick: 0.0, end_tick: 7680.0 }, 0.0);
    add_pattern(&mut p, "pb", "c1", &[(0.0, 3840.0, 72), (1920.0, 960.0, 74)]);
    session(&mut p, &["s1"], "none");
    lclip(&mut p, "l1", "t1", "s1", json!({ "patternId": "pb" }));
    let with = render_p(&p, RenderScope::Range { start_tick: 0.0, end_tick: 7680.0 }, 0.0);
    assert_eq!(plain.l, with.l);
    assert!(near(with.l[1000], DC1, 1e-5));
}

#[cfg(debug_assertions)]
#[test]
fn launcher_path_does_not_allocate() {
    let mut p = base(120.0, "song");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_channel(&mut p, "c1", "test.sine", "i1");
    let notes: Vec<(f64, f64, u8)> = (0..16).map(|i| (i as f64 * 240.0, 200.0, 48 + i as u8)).collect();
    add_pattern(&mut p, "pa", "c1", &notes);
    add_pattern(&mut p, "pb", "c1", &[(0.0, 900.0, 60), (960.0, 900.0, 64)]);
    p["transport"]["loop"] = json!({ "enabled": true, "start": 0, "end": 5760 });
    add_track(&mut p, "t2");
    add_clip(&mut p, "a1", "pattern", 0.0, 4.0 * 3840.0, json!({ "patternId": "pa" }));
    session(&mut p, &["s1", "s2", "s3"], "1/4");
    lclip(&mut p, "l1", "t1", "s1", json!({ "follow": follow("other", 0.5, "any", 0.5) }));
    lclip(&mut p, "l2", "t1", "s2", json!({ "patternId": "pb", "launchMode": "repeat", "length": 1920, "follow": follow("next", 1.0, "none", 1.0) }));
    lclip(&mut p, "l3", "t2", "s3", json!({ "patternId": "pb", "launchMode": "gate", "loop": false, "length": 1000 }));
    let mut live = Live::new(&p);
    let mut ctl = LauncherCtl::new(&live.core.shared.launch, None);
    let mut buf = vec![0f32; 480 * 2];
    crate::rt::no_alloc(|| live.core.process_interleaved(&mut buf, 2));
    let (c1, c2, c3) = (live.clip("l1"), live.clip("l2"), live.clip("l3"));
    let s2 = live.session.launcher.scene_slot("s2").unwrap();
    let before = assert_no_alloc::violation_count();
    live.send(Cmd::Launcher(LaunchCmd::Record(true)));
    live.send(Cmd::Play);
    for i in 0..1500u32 {
        let c = match i % 97 {
            5 => Some(LaunchCmd::Launch { clip: c1, release: false }),
            20 => Some(LaunchCmd::Launch { clip: c2, release: false }),
            40 => Some(LaunchCmd::Launch { clip: c2, release: true }),
            50 => Some(LaunchCmd::Launch { clip: c3, release: false }),
            60 => Some(LaunchCmd::Launch { clip: c3, release: true }),
            70 => Some(LaunchCmd::Scene(s2)),
            80 => Some(LaunchCmd::Stop(NONE)),
            90 if i % 3 == 0 => Some(LaunchCmd::BackToArrangement),
            _ => None,
        };
        if let Some(c) = c {
            live.send(Cmd::Launcher(c));
        }
        if i == 700 {
            live.send(Cmd::Locate(1000.0));
        }
        if i == 900 {
            live.send(Cmd::Pause);
            live.send(Cmd::Play);
        }
        crate::rt::no_alloc(|| live.core.process_interleaved(&mut buf, 2));
        if i % 100 == 0 {
            spans(&live, &mut ctl);
        }
    }
    live.send(Cmd::Stop);
    crate::rt::no_alloc(|| live.core.process_interleaved(&mut buf, 2));
    assert_eq!(assert_no_alloc::violation_count(), before, "the launcher allocated on the audio thread");
    assert!(!spans(&live, &mut ctl).is_empty(), "recording produced launchRecorded events");
    while let Ok(g) = live.grx.pop() {
        drop(g);
    }
}

#[test]
fn follow_targets_and_draws() {
    use crate::launcher::{decide, follow_target, FollowAction as A, FollowProg, FollowResult as F};
    let lane = [10, 20, 30];
    assert_eq!(follow_target(&lane, 30, A::Next, 0), F::Launch(10), "wraps");
    assert_eq!(follow_target(&lane, 10, A::Previous, 0), F::Launch(30));
    assert_eq!(follow_target(&lane, 20, A::First, 0), F::Launch(10));
    assert_eq!(follow_target(&lane, 20, A::Last, 0), F::Launch(30));
    assert_eq!(follow_target(&lane, 20, A::Again, 0), F::Launch(20));
    assert_eq!(follow_target(&lane, 20, A::Stop, 0), F::Stop);
    assert_eq!(follow_target(&lane, 20, A::None, 0), F::Keep);
    assert_eq!(follow_target(&[20], 20, A::Other, 7), F::Keep, "no other clip");
    for r in 0..50u64 {
        assert_ne!(follow_target(&lane, 20, A::Other, r), F::Launch(20));
    }
    let f = |chance| FollowProg { action: A::Next, other: A::Stop, chance, after: 3840.0 };
    for r in [0u64, 1, u64::MAX / 2, u64::MAX] {
        assert_eq!(decide(&f(1.0), r), A::Next);
        assert_eq!(decide(&f(0.0), r), A::Stop);
    }
    let _ = LaunchRecMsg::Flush;
}
