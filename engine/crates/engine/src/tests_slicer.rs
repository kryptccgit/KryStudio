use super::*;

const CUT: usize = 2400;

fn slicer_project(slices: Value, root_key: u8, key: u8) -> Value {
    let mut p = base(120.0, "pattern");
    add_insert(&mut p, "i1", json!({ "m": 1 }));
    p["samples"]["kick"] = json!({ "id": "kick", "name": "kick", "path": "factory:drums/kick.wav", "durationSec": 1, "sampleRate": 48000, "channels": 1 });
    add_channel(&mut p, "s", "krypt.slicer", "i1");
    p["channels"]["s"]["generator"]["sampleId"] = json!("kick");
    p["channels"]["s"]["rootKey"] = json!(root_key);
    if !slices.is_null() {
        p["channels"]["s"]["generator"]["slices"] = slices;
    }
    add_note(&mut p, "pa", "s", "n", 0.0, 960.0, key);
    p
}

fn two() -> Value {
    json!([{ "id": "a", "sec": 0 }, { "id": "b", "sec": 0.05 }])
}

fn render(p: &Value) -> Rendered {
    let o = render_with(p, PluginHost::stock(), factory_dir(), PATTERN);
    assert!(o.warnings.iter().all(|w| !w.contains("missing") && !w.contains("not available")), "{:?}", o.warnings);
    o
}

fn peak(o: &Rendered, a: usize, b: usize) -> f32 {
    o.l[a..b].iter().chain(&o.r[a..b]).fold(0f32, |m, v| m.max(v.abs()))
}

#[test]
fn slicer_channel_plays_the_slices_of_its_generator() {
    let first = render(&slicer_project(two(), 60, 60));
    assert!(peak(&first, 0, CUT - 200) > 0.05, "slice 1 silent");
    assert!(peak(&first, CUT + 10, first.l.len()) == 0.0, "slice 1 played past slice 2's start");
    let whole = render(&slicer_project(Value::Null, 60, 60));
    assert!(peak(&whole, CUT + 200, 2 * CUT) > 1e-3, "the whole sample stopped early");
    let second = render(&slicer_project(two(), 60, 61));
    let diff = (100..CUT).fold(0f32, |m, i| m.max((second.l[i] - whole.l[i + CUT]).abs()));
    assert!(peak(&second, 0, CUT) > 1e-3 && diff < 1e-5, "slice 2 differs from the kick at 50 ms by {diff}");
    let low_root = render(&slicer_project(two(), 48, 60));
    assert!(first.l == low_root.l, "root key changed the slice");
    assert!(peak(&render(&slicer_project(two(), 60, 62)), 0, CUT) == 0.0);
}

#[test]
fn a_slice_edit_recreates_the_slicer_and_a_param_edit_does_not() {
    let p = slicer_project(two(), 60, 60);
    let mut s = Session::new(PluginHost::stock(), 48000.0, Arc::new(SampleCache::new()), factory_dir(), SampleMode::Sync);
    let mut w = Warnings::default();
    s.model = Model::from_project(&p, &mut w);
    s.version = 1;
    assert_eq!(s.build(false).instruments.len(), 1);

    let rebuilt = |s: &mut Session, f: &dyn Fn(&mut crate::model::Generator)| {
        f(&mut s.model.channels.get_mut("s").unwrap().generator);
        s.version += 1;
        let b = s.build(false);
        (b.instruments.len(), b.inst_params.len())
    };
    let (n, params) = rebuilt(&mut s, &|g| {
        g.params.insert("gain".into(), -6.0);
    });
    assert_eq!((n, params > 0), (0, true), "a param edit reaches the instance as set_param");
    assert_eq!(rebuilt(&mut s, &|g| g.slices.as_mut().unwrap()[1].sec = 0.08).0, 1, "a moved marker re-creates the slicer");
    assert_eq!(rebuilt(&mut s, &|g| g.slices.as_mut().unwrap()[0].reverse = Some(true)).0, 1, "a per-slice edit re-creates it");
    let (n, _) = rebuilt(&mut s, &|g| {
        g.params.insert("cut".into(), 0.0);
    });
    assert_eq!(n, 0, "unchanged slices keep the instance");
}
