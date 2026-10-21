use super::*;
use crate::render::{run_stems, stem_file_name, STEM_MEM_BUDGET};
use std::path::PathBuf;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("kse-stems-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn job(dir: &std::path::Path, format: &str, analyze: bool) -> RenderRequest {
    RenderRequest {
        path: dir.display().to_string(),
        scope: PATTERN,
        format: format.into(),
        sample_rate: Some(48000.0),
        tail_sec: Some(0.0),
        analyze: Some(analyze),
        stems: Some(true),
        stem_inserts: None,
        loops: None,
        normalize: None,
        mp3_kbps: None,
    }
}

fn stems_run(model: &Model, req: &RenderRequest, budget: usize, cancel: Arc<AtomicBool>, cancel_at: Option<f64>) -> Result<crate::protocol::RenderResult, String> {
    let c2 = cancel.clone();
    let mut progress = move |p: f64| {
        if cancel_at.is_some_and(|at| p >= at) {
            c2.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    };
    let mut log = |_l: &str, m: String| eprintln!("{m}");
    let mut env = RenderEnv {
        host: test_host(),
        cache: Arc::new(SampleCache::new()),
        factory_dir: ".".into(),
        packs_dir: None,
        base_dir: None,
        cancel,
        default_sr: 48000.0,
        progress: &mut progress,
        log: &mut log,
    };
    run_stems(model, req, &mut env, budget)
}

fn read_f32(path: &str) -> (Vec<f32>, Vec<f32>) {
    let mut rd = hound::WavReader::open(path).unwrap();
    let s: Vec<f32> = rd.samples::<f32>().map(|x| x.unwrap()).collect();
    (s.iter().step_by(2).cloned().collect(), s.iter().skip(1).step_by(2).cloned().collect())
}

fn names(dir: &std::path::Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    v.sort();
    v
}

fn stems_project() -> Value {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_insert(&mut p, "i2", json!({ "m": 1 }));
    add_insert(&mut p, "i3", json!({ "m": 1 }));
    add_insert(&mut p, "bus", json!({ "m": 1 }));
    add_insert(&mut p, "i4", json!({ "bus": 1 }));
    p["mixer"]["inserts"]["i1"]["name"] = json!("Lead: \"A\"/B?");
    p["mixer"]["inserts"]["i2"]["volume"] = json!(0.5);
    p["mixer"]["inserts"]["i2"]["pan"] = json!(-0.5);
    p["mixer"]["inserts"]["bus"]["name"] = json!("Drum Bus");
    add_channel(&mut p, "c1", "test.sine", "i1");
    add_channel(&mut p, "c2", "test.sine", "i2");
    add_channel(&mut p, "c4", "test.dc", "i4");
    add_note(&mut p, "pa", "c1", "a", 0.0, 3840.0, 69);
    add_note(&mut p, "pa", "c2", "b", 960.0, 1920.0, 76);
    add_note(&mut p, "pa", "c4", "c", 1920.0, 480.0, 60);
    p
}

fn model_of(p: &Value) -> Model {
    let mut w = Warnings::default();
    Model::from_project(p, &mut w)
}

#[test]
fn stems_write_each_insert_and_master_in_one_pass() {
    let p = stems_project();
    let model = model_of(&p);
    let dir = tmp("basic");
    let r = stems_run(&model, &job(&dir, "wav32f", true), STEM_MEM_BUDGET, Arc::new(AtomicBool::new(false)), None).expect("stems");
    assert_eq!(names(&dir), vec!["01 Lead_ _A__B_.wav", "02 i2.wav", "04 Drum Bus.wav", "05 i4.wav", "06 Master.wav"]);
    let sr = r.stem_results.as_ref().unwrap();
    let ids: Vec<&str> = sr.iter().map(|s| s.insert_id.as_str()).collect();
    assert_eq!(ids, vec!["i1", "i2", "bus", "i4", "m"]);
    assert_eq!(sr[0].name, "Lead: \"A\"/B?");
    assert_eq!(sr.last().unwrap().name, "Master");
    assert!(sr.iter().all(|s| s.analysis.is_some()));
    assert_eq!(r.files.len(), 5);
    assert_eq!(r.path, dir.display().to_string());
    assert!(r.analysis.is_some());
    let plain = render_p(&p, PATTERN, 0.0);
    let (ml, mr) = read_f32(&sr[4].path);
    assert_eq!(ml, plain.l);
    assert_eq!(mr, plain.r);
    let (l1, _) = read_f32(&sr[0].path);
    let (l2, r2) = read_f32(&sr[1].path);
    let pk = |x: &[f32]| x.iter().fold(0f32, |m, v| m.max(v.abs()));
    assert!((pk(&r2) / pk(&l2) - 0.5).abs() < 0.01, "pan: L {} R {}", pk(&l2), pk(&r2));
    assert!(pk(&l1) > 0.1);
    let (lb, rb) = read_f32(&sr[2].path);
    let (_, r1) = read_f32(&sr[0].path);
    for i in (0..ml.len()).step_by(97) {
        assert!((l1[i] + l2[i] + lb[i] - ml[i]).abs() < 1e-5, "L {i}");
        assert!((r1[i] + r2[i] + rb[i] - mr[i]).abs() < 1e-5, "R {i}");
    }
    let (l4, _) = read_f32(&sr[3].path);
    assert_eq!(l4, lb, "the bus carries only i4");
    let a1 = sr[0].analysis.as_ref().unwrap();
    let a4 = sr[3].analysis.as_ref().unwrap();
    assert!(a1["peakDb"].as_f64().unwrap() > a4["peakDb"].as_f64().unwrap() - 40.0);
    assert!(a1["durationSec"].as_f64().unwrap() > 1.9);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stem_inserts_filter_and_unknown_ids() {
    let model = model_of(&stems_project());
    let dir = tmp("filter");
    let mut req = job(&dir, "wav16", false);
    req.stem_inserts = Some(vec!["i3".into(), "i2".into()]);
    let r = stems_run(&model, &req, STEM_MEM_BUDGET, Arc::new(AtomicBool::new(false)), None).expect("stems");
    assert_eq!(names(&dir), vec!["02 i2.wav", "03 i3.wav", "06 Master.wav"]);
    let sr = r.stem_results.unwrap();
    assert!(sr.iter().all(|s| s.analysis.is_none()));
    let rd = hound::WavReader::open(&sr[1].path).unwrap();
    assert_eq!(rd.spec().bits_per_sample, 16);
    let _ = std::fs::remove_dir_all(&dir);
    req.stem_inserts = Some(vec!["nope".into()]);
    let e = stems_run(&model, &req, STEM_MEM_BUDGET, Arc::new(AtomicBool::new(false)), None).unwrap_err();
    assert!(e.contains("nope") && e.contains("not in the mixer"), "{e}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stems_line_up_with_the_master_under_delay_compensation() {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    add_insert(&mut p, "i2", json!({ "m": 1 }));
    add_slot(&mut p, "i1", "s1", "test.latency", None);
    add_slot(&mut p, "m", "s2", "test.latency", None);
    add_channel(&mut p, "c1", "test.dc", "i1");
    add_channel(&mut p, "c2", "test.dc", "i2");
    add_note(&mut p, "pa", "c1", "a", 960.0, 480.0, 60);
    add_note(&mut p, "pa", "c2", "b", 960.0, 960.0, 60);
    let model = model_of(&p);
    for budget in [STEM_MEM_BUDGET, 0] {
        let dir = tmp(&format!("pdc-{budget}"));
        let r = stems_run(&model, &job(&dir, "wav32f", false), budget, Arc::new(AtomicBool::new(false)), None).expect("stems");
        let sr = r.stem_results.unwrap();
        let (l1, _) = read_f32(&sr[0].path);
        let (l2, _) = read_f32(&sr[1].path);
        let (lm, _) = read_f32(&sr[2].path);
        assert_eq!(l1.len(), lm.len());
        assert_eq!(l2.len(), lm.len());
        let start = 24000 + 2 * LAT;
        assert_eq!(l1[start - 1], 0.0, "budget {budget}");
        assert_eq!(l2[start - 1], 0.0, "budget {budget}");
        assert!(near(l1[start], DC1, 1e-5) && near(l2[start], DC1, 1e-5), "budget {budget}: {} {}", l1[start], l2[start]);
        for i in 0..lm.len() {
            assert!((l1[i] + l2[i] - lm[i]).abs() < 1e-6, "budget {budget}: frame {i}: {} + {} vs {}", l1[i], l2[i], lm[i]);
        }
        assert!(names(&dir).iter().all(|n| !n.ends_with(".part")), "{:?}", names(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[test]
fn stems_normalize_keeps_the_balance() {
    let model = model_of(&stems_project());
    let dir = tmp("norm");
    let mut req = job(&dir, "wav32f", false);
    req.normalize = Some(true);
    let r = stems_run(&model, &req, STEM_MEM_BUDGET, Arc::new(AtomicBool::new(false)), None).expect("stems");
    assert!((r.peak_db - NORMALIZE_TARGET_DB).abs() < 0.01);
    let sr = r.stem_results.unwrap();
    let (l1, _) = read_f32(&sr[0].path);
    let (l2, _) = read_f32(&sr[1].path);
    let (lb, _) = read_f32(&sr[2].path);
    let (lm, _) = read_f32(&sr[4].path);
    for i in (0..lm.len()).step_by(101) {
        assert!((l1[i] + l2[i] + lb[i] - lm[i]).abs() < 1e-5);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cancelled_stems_leave_no_files() {
    let model = model_of(&stems_project());
    for at in [0.05, 0.75] {
        let dir = tmp(&format!("cancel-{at}"));
        let e = stems_run(&model, &job(&dir, "wav24", true), STEM_MEM_BUDGET, Arc::new(AtomicBool::new(false)), Some(at)).unwrap_err();
        assert_eq!(e, "Render cancelled");
        assert!(names(&dir).is_empty(), "{at}: {:?}", names(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
    let dir = tmp("cancel-spill");
    let e = stems_run(&model, &job(&dir, "wav24", false), 0, Arc::new(AtomicBool::new(false)), Some(0.05)).unwrap_err();
    assert_eq!(e, "Render cancelled");
    assert!(names(&dir).is_empty(), "{:?}", names(&dir));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stems_through_run_render_and_errors() {
    let model = model_of(&stems_project());
    let dir = tmp("run");
    let r = run_job(&model, &job(&dir, "wav24", false)).expect("stems via run_render");
    assert_eq!(r.stem_results.as_ref().unwrap().len(), 5);
    let file = dir.join("01 Lead_ _A__B_.wav");
    let e = run_job(&model, &job(&file, "wav24", false)).unwrap_err();
    assert!(e.contains("needs a folder"), "{e}");
    let e = run_job(&model, &job(std::path::Path::new(""), "wav24", false)).unwrap_err();
    assert_eq!(e, "Stem export needs a folder");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn mp3_stems_use_the_mp3_path() {
    if !mp3_encoder() {
        return;
    }
    let model = model_of(&stems_project());
    let dir = tmp("mp3");
    let mut req = job(&dir, "mp3", true);
    req.mp3_kbps = Some(192.0);
    let r = run_job(&model, &req).expect("mp3 stems");
    assert_eq!(names(&dir), vec!["01 Lead_ _A__B_.mp3", "02 i2.mp3", "04 Drum Bus.mp3", "05 i4.mp3", "06 Master.mp3"]);
    assert_eq!(r.mp3.as_ref().unwrap().kbps, 192);
    for s in r.stem_results.unwrap() {
        assert!(std::fs::metadata(&s.path).unwrap().len() > 1000, "{}", s.path);
        assert!(s.analysis.is_some());
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stem_file_names_are_safe_on_windows() {
    assert_eq!(stem_file_name(1, "Kick", "Insert 1"), "01 Kick");
    assert_eq!(stem_file_name(12, "a<b>c:d\"e/f\\g|h?i*j", "x"), "12 a_b_c_d_e_f_g_h_i_j");
    assert_eq!(stem_file_name(3, "  Lead   Synth.. ", "x"), "03 Lead Synth");
    assert_eq!(stem_file_name(4, "", "Insert 4"), "04 Insert 4");
    assert_eq!(stem_file_name(5, "???", "Insert 5"), "05 Insert 5");
    assert_eq!(stem_file_name(6, "tab\there", "x"), "06 tab_here");
    assert_eq!(stem_file_name(7, &"x".repeat(100), "x").len(), 63);
    assert_eq!(stem_file_name(120, "CON", "x"), "120 CON");
}

#[test]
fn stems_timing_on_the_beat_fixture() {
    let p = beat_json();
    let model = model_of(&p);
    let dir = tmp("timing");
    let mut req = job(&dir, "wav32f", false);
    req.scope = RenderScope::Song;
    let t = std::time::Instant::now();
    let _plain = render_p(&p, RenderScope::Song, 0.0);
    let plain = t.elapsed().as_secs_f64();
    let t = std::time::Instant::now();
    let r = stems_run(&model, &req, STEM_MEM_BUDGET, Arc::new(AtomicBool::new(false)), None).expect("stems");
    let stems = t.elapsed().as_secs_f64();
    eprintln!("beat.json (test plugins): plain render {plain:.3} s, stems ({} files, written) {stems:.3} s", r.files.len());
    assert_eq!(r.files.len(), 7);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stems_over_full_scale_warn_in_integer_formats() {
    let mut p = stems_project();
    p["mixer"]["inserts"]["i4"]["volume"] = json!(4.0);
    add_note(&mut p, "pa", "c4", "c2", 1920.0, 480.0, 62);
    add_note(&mut p, "pa", "c4", "c3", 1920.0, 480.0, 64);
    p["transport"]["masterVolume"] = json!(0.2);
    let model = model_of(&p);
    for (fmt, warns) in [("wav24", true), ("wav32f", false)] {
        let dir = tmp(&format!("clip-{fmt}"));
        let mut logs: Vec<(String, String)> = Vec::new();
        let mut progress = |_p: f64| {};
        let mut log = |l: &str, m: String| logs.push((l.to_string(), m));
        let mut env = RenderEnv {
            host: test_host(),
            cache: Arc::new(SampleCache::new()),
            factory_dir: ".".into(),
            packs_dir: None,
            base_dir: None,
            cancel: Arc::new(AtomicBool::new(false)),
            default_sr: 48000.0,
            progress: &mut progress,
            log: &mut log,
        };
        run_stems(&model, &job(&dir, fmt, false), &mut env, STEM_MEM_BUDGET).expect("stems");
        let w = logs.iter().find(|(l, m)| l == "warn" && m.contains("clipped"));
        assert_eq!(w.is_some(), warns, "{fmt}: {logs:?}");
        if let Some((_, m)) = w {
            assert!(m.contains("i4 (+7.4 dB)") && m.contains("Drum Bus") && !m.contains("Lead") && !m.contains("i2"), "{m}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
