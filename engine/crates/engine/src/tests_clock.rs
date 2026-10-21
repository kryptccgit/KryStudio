//! MIDI clock out + external sync through the live core (clock.rs, clock_hooks.rs).
//! Child of `tests` for its project builders. The audio thread's clock is
//! faked (`ClockRt::fake_now`): blocks of 480 frames = exactly 10 ms.

use super::*;
use crate::clock::{ClockEv, SyncEv, MIDI_CLOCK, MIDI_CONTINUE, MIDI_SPP, MIDI_START, MIDI_STOP};
use std::sync::atomic::Ordering::Relaxed as R;

const T0: u64 = 1_000_000_000;
const BLOCK: usize = 480;
const BLOCK_NS: u64 = 10_000_000;

struct Rig {
    core: Core,
    tx: rtrb::Producer<Cmd>,
    grx: rtrb::Consumer<Garbage>,
    session: Session,
    shared: Arc<Shared>,
    out_rx: rtrb::Consumer<ClockEv>,
    sync_tx: rtrb::Producer<SyncEv>,
    now: u64,
}

impl Rig {
    fn new(p: &Value) -> Rig {
        let shared = Arc::new(Shared::new());
        let (mut tx, rx) = rtrb::RingBuffer::new(64);
        let (gtx, grx) = rtrb::RingBuffer::new(1024);
        let mut core = Core::new(48000.0, shared.clone(), Some(rx), Some(gtx), None);
        core.clock.attach(shared.clock.take_rt().unwrap());
        core.clock.fake_now = Some(T0);
        let out_rx = shared.clock.take_out_rx().unwrap();
        let sync_tx = shared.clock.take_sync_tx().unwrap();
        let mut session = Session::new(test_host(), 48000.0, Arc::new(SampleCache::new()), ".".into(), SampleMode::Sync);
        let mut w = Warnings::default();
        session.model = Model::from_project(p, &mut w);
        session.version = 1;
        let b = session.build(true);
        assert!(tx.push(Cmd::Batch(b)).is_ok());
        Rig { core, tx, grx, session, shared, out_rx, sync_tx, now: T0 }
    }

    fn send(&mut self, c: Cmd) {
        assert!(self.tx.push(c).is_ok());
    }

    /// One 10 ms block at `self.now`, then advance the fake clock.
    fn block(&mut self) {
        let mut buf = vec![0f32; BLOCK * 2];
        self.core.clock.fake_now = Some(self.now);
        self.core.process_interleaved(&mut buf, 2);
        self.now += BLOCK_NS;
        while let Ok(g) = self.grx.pop() {
            drop(g);
        }
    }

    fn events(&mut self) -> Vec<ClockEv> {
        let mut v = Vec::new();
        while let Ok(e) = self.out_rx.pop() {
            v.push(e);
        }
        v
    }

    fn bpm(&self) -> f64 {
        f64::from_bits(self.shared.bpm.load(R))
    }

    fn playing(&self) -> bool {
        self.shared.playing.load(R)
    }

    fn tick(&self) -> f64 {
        f64::from_bits(self.shared.tick.load(R))
    }
}

fn pulses(evs: &[ClockEv]) -> Vec<u64> {
    evs.iter().filter(|e| e.msg() == [MIDI_CLOCK]).map(|e| e.t_ns).collect()
}

#[test]
fn clock_out_follows_the_transport() {
    let mut r = Rig::new(&base(120.0, "song"));
    r.block();
    assert!(r.events().is_empty(), "clock out is off by default");
    r.shared.clock.out_on.store(true, R);
    r.send(Cmd::Play);
    // 3 s: the empty song loops every bar (2 s), the pulse train must not notice.
    for _ in 0..300 {
        r.block();
    }
    let evs = r.events();
    assert_eq!(evs[0], ClockEv::one(T0 + BLOCK_NS, MIDI_START), "Start on the first played frame");
    let ps = pulses(&evs);
    assert_eq!(ps.len(), 144, "24 per beat × 2 beats per second × 3 s");
    assert_eq!(ps[0], T0 + BLOCK_NS, "the first pulse goes with Start");
    let period = 1e9 / 48.0;
    for (i, w) in ps.windows(2).enumerate() {
        let d = (w[1] - w[0]) as f64;
        assert!((d - period).abs() < 25_000.0, "interval {i}: {d} ns (want {period})");
    }
    // Locate while playing: Stop, SPP 5, Continue; the next pulse lands on tick 1200.
    r.send(Cmd::Locate(1000.0));
    r.block();
    let t_loc = r.now - BLOCK_NS;
    let evs = r.events();
    assert_eq!(&evs[..3], &[ClockEv::one(t_loc, MIDI_STOP), ClockEv::spp(t_loc, 5), ClockEv::one(t_loc, MIDI_CONTINUE)]);
    for _ in 0..20 {
        r.block();
    }
    let ps = pulses(&r.events());
    let want = t_loc as f64 + 200.0 / 0.04 * (1e9 / 48000.0);
    assert!((ps[0] as f64 - want).abs() < 25_000.0, "first pulse after the locate at {} (want {want})", ps[0]);
    // A tempo change (60 bpm) halves the pulse rate.
    r.session.model.transport.bpm = 60.0;
    r.session.version = 2;
    let b = r.session.build(false);
    r.send(Cmd::Batch(b));
    r.block();
    r.events();
    for _ in 0..100 {
        r.block();
    }
    let ps = pulses(&r.events());
    assert_eq!(ps.len(), 24, "one beat per second at 60 bpm");
    // Stop: one Stop message; nothing more while stopped.
    r.send(Cmd::Stop);
    r.block();
    let evs = r.events();
    assert_eq!(evs.iter().filter(|e| e.msg() == [MIDI_STOP]).count(), 1);
    for _ in 0..10 {
        r.block();
    }
    assert!(r.events().is_empty());
    // Locate while stopped: SPP only; play from there: SPP + Continue.
    r.send(Cmd::Locate(3840.0));
    r.block();
    assert_eq!(r.events().iter().map(|e| e.msg().to_vec()).collect::<Vec<_>>(), vec![vec![MIDI_SPP, 16, 0]]);
    r.send(Cmd::Play);
    r.block();
    let evs = r.events();
    assert_eq!(evs[0].msg(), &[MIDI_SPP, 16, 0]);
    assert_eq!(evs[1].msg(), &[MIDI_CONTINUE]);
    assert_eq!(evs[2].msg(), &[MIDI_CLOCK]);
}

#[test]
fn clock_out_includes_output_latency() {
    let mut r = Rig::new(&base(120.0, "song"));
    r.shared.out_latency_us.store(12_000, R);
    r.shared.clock.out_on.store(true, R);
    r.send(Cmd::Play);
    r.block();
    let evs = r.events();
    assert_eq!(evs[0].t_ns, T0 + 12_000_000, "stamped when the first frame is heard");
}

/// The master's pulse train: 24 per beat at `bpm`, from `from` (ns); pushes
/// every pulse that has "arrived" by the rig's clock.
struct Master {
    period: f64,
    next_k: u64,
    from: f64,
    jitter: f64,
    seed: u64,
}

impl Master {
    fn new(bpm: f64, from: u64) -> Self {
        Master { period: 60e9 / (24.0 * bpm), next_k: 0, from: from as f64, jitter: 0.0, seed: 7 }
    }
    fn t(&self, k: u64) -> f64 {
        self.from + k as f64 * self.period
    }
    fn feed(&mut self, r: &mut Rig, until: u64) {
        while self.t(self.next_k) <= until as f64 {
            self.seed ^= self.seed << 13;
            self.seed ^= self.seed >> 7;
            self.seed ^= self.seed << 17;
            let j = ((self.seed % 2001) as f64 / 1000.0 - 1.0) * self.jitter;
            let t = (self.t(self.next_k) + j).max(0.0) as u64;
            r.sync_tx.push(SyncEv { t_ns: t, status: MIDI_CLOCK, spp: 0 }).unwrap();
            self.next_k += 1;
        }
    }
}

fn sync_status(r: &mut Rig, status: u8, spp: u16) {
    let t = r.now;
    r.sync_tx.push(SyncEv { t_ns: t, status, spp }).unwrap();
}

/// Run `n` blocks, feeding the master's clock before each.
fn run_synced(r: &mut Rig, m: &mut Master, n: usize) {
    for _ in 0..n {
        let now = r.now;
        m.feed(r, now);
        r.block();
    }
}

#[test]
fn follows_an_external_clock() {
    let mut p = base(140.0, "song");
    add_clip(&mut p, "long", "pattern", 0.0, 16.0 * 3840.0, json!({ "patternId": "pa", "mute": true })); // a 16-bar song
    let mut r = Rig::new(&p);
    r.shared.clock.sync_on.store(true, R);
    let mut m = Master::new(100.0, T0);
    // The master's clock runs while stopped: tempo known, transport idle.
    run_synced(&mut r, &mut m, 100);
    assert!(!r.playing());
    let tel = crate::clock::sync_telemetry(&r.shared.clock).unwrap();
    assert!((tel.bpm.unwrap() - 100.0).abs() < 0.05, "{tel:?}");
    assert!(!tel.running);
    // Start: the transport runs from 0 on the next pulse, at the external tempo.
    sync_status(&mut r, MIDI_START, 0);
    let k_start = m.next_k;
    run_synced(&mut r, &mut m, 3);
    assert!(r.playing());
    assert!(r.shared.clock.sync_running.load(R));
    // 4 s later the heard position matches the master's within a few ticks.
    run_synced(&mut r, &mut m, 400);
    assert!((r.bpm() - 100.0).abs() < 4.5, "plays near the external tempo: {}", r.bpm());
    let heard = r.now; // the end of the last block (slave_ticks includes it; no output latency here)
    let master_ticks = (heard as f64 - m.t(k_start)) / m.period * 40.0;
    let err = master_ticks - r.core.clock.slave_ticks;
    assert!(err.abs() < 6.0, "phase error {err} ticks");
    // The doc tempo is untouched; Stop pauses and restores it.
    sync_status(&mut r, MIDI_STOP, 0);
    run_synced(&mut r, &mut m, 2);
    assert!(!r.playing());
    assert!(!r.shared.clock.sync_running.load(R));
    assert!((r.bpm() - 140.0).abs() < 1e-9, "doc tempo back: {}", r.bpm());
    let paused_at = r.tick();
    assert!(paused_at > 0.0, "Stop pauses (keeps the position)");
    // SPP + Continue: runs from bar 2.
    sync_status(&mut r, MIDI_SPP, 16);
    sync_status(&mut r, MIDI_CONTINUE, 0);
    run_synced(&mut r, &mut m, 1);
    run_synced(&mut r, &mut m, 2);
    assert!(r.playing());
    assert!(r.tick() >= 3840.0 && r.tick() < 3840.0 + 200.0, "continued from the SPP: {}", r.tick());
    // The master vanishes: playback pauses within ~0.5 s and the loss is counted.
    for _ in 0..80 {
        r.block();
    }
    assert!(!r.playing());
    assert_eq!(r.shared.clock.sync_lost.load(R), 1);
}

#[test]
fn sync_with_jittered_clock_stays_in_phase() {
    let mut r = Rig::new(&base(120.0, "song"));
    r.shared.clock.sync_on.store(true, R);
    let mut m = Master::new(128.0, T0);
    m.jitter = 1e6; // ±1 ms per pulse (USB MIDI)
    run_synced(&mut r, &mut m, 150);
    sync_status(&mut r, MIDI_START, 0);
    let k_start = m.next_k;
    run_synced(&mut r, &mut m, 300);
    let mut worst: f64 = 0.0;
    for _ in 0..500 {
        run_synced(&mut r, &mut m, 1);
        let heard = r.now;
        let master_ticks = (heard as f64 - m.t(k_start)) / m.period * 40.0;
        worst = worst.max((master_ticks - r.core.clock.slave_ticks).abs());
    }
    // 1 ms at 128 bpm ≈ 2 ticks.
    eprintln!("synced to a ±1 ms jittered 128 bpm clock: worst phase error {worst:.2} ticks over 5 s");
    assert!(worst < 8.0, "phase error {worst} ticks");
    let tel = crate::clock::sync_telemetry(&r.shared.clock).unwrap();
    assert!(tel.locked && (tel.bpm.unwrap() - 128.0).abs() < 0.1, "{tel:?}");
}

#[cfg(debug_assertions)]
#[test]
fn clock_path_does_not_allocate() {
    let mut r = Rig::new(&base(120.0, "song"));
    r.shared.clock.out_on.store(true, R);
    r.shared.clock.sync_on.store(true, R);
    let mut m = Master::new(110.0, T0);
    m.jitter = 5e5;
    let mut buf = vec![0f32; BLOCK * 2];
    let before = assert_no_alloc::violation_count();
    let mut step = |r: &mut Rig, m: &mut Master| {
        let now = r.now;
        m.feed(r, now);
        r.core.clock.fake_now = Some(now);
        crate::rt::no_alloc(|| r.core.process_interleaved(&mut buf, 2));
        r.now += BLOCK_NS;
        while r.out_rx.pop().is_ok() {}
    };
    for _ in 0..50 {
        step(&mut r, &mut m);
    }
    sync_status(&mut r, MIDI_START, 0);
    for _ in 0..200 {
        step(&mut r, &mut m);
    }
    r.send(Cmd::Locate(2000.0));
    sync_status(&mut r, MIDI_SPP, 4);
    for _ in 0..20 {
        step(&mut r, &mut m);
    }
    sync_status(&mut r, MIDI_STOP, 0);
    step(&mut r, &mut m);
    r.send(Cmd::Play);
    step(&mut r, &mut m);
    r.send(Cmd::Stop);
    step(&mut r, &mut m);
    assert_eq!(assert_no_alloc::violation_count(), before, "the clock path allocated");
    while let Ok(g) = r.grx.pop() {
        drop(g);
    }
}

#[test]
fn offline_render_core_has_no_clock() {
    // A core without attached clock rings (renders) ignores the switches.
    let shared = Arc::new(Shared::new());
    shared.clock.out_on.store(true, R);
    let mut core = Core::new(48000.0, shared.clone(), None, None, None);
    assert!(!core.clock.attached());
    let mut buf = vec![0f32; 960];
    core.process_interleaved(&mut buf, 2);
    let mut rx = shared.clock.take_out_rx().unwrap();
    assert!(rx.pop().is_err());
}

#[test]
fn sync_input_and_grid_ccs_through_the_midi_sink() {
    use crate::midi::{GridFilter, GridHit};
    let live = Arc::new(crate::record::LiveShared::new());
    let (_rt, ctl) = crate::record::live_channels(live);
    let sink = ctl.sink;
    let (tx, mut rx) = rtrb::RingBuffer::<SyncEv>::new(64);
    sink.set_sync_ring(tx);
    let clock: Arc<str> = Arc::from("Clock In");
    let other: Arc<str> = Arc::from("Keys");
    let mut rs = 0u8;
    // Nothing is followed until a sync device is chosen.
    sink.feed_at(5, &clock, &[0xF8], &mut rs);
    assert!(rx.pop().is_err());
    sink.set_sync_device(Some("Clock In".into()));
    sink.feed_at(6, &clock, &[0xFA], &mut rs);
    sink.feed_at(7, &clock, &[0xF8], &mut rs);
    sink.feed_at(8, &clock, &[0xF2, 4, 0], &mut rs);
    sink.feed_at(9, &other, &[0xF8], &mut rs); // another device's clock is ignored
    let got: Vec<(u64, u8, u16)> = std::iter::from_fn(|| rx.pop().ok()).map(|e| (e.t_ns, e.status, e.spp)).collect();
    assert_eq!(got, vec![(6, MIDI_START, 0), (7, MIDI_CLOCK, 0), (8, MIDI_SPP, 4)]);
    // Launchpad side buttons send CCs: with `cc` they launch like notes (value 0 = release).
    let (htx, hrx) = crossbeam_channel::unbounded();
    let mut keys = [false; 128];
    keys[89] = true;
    sink.set_grid(Some(GridFilter { device: Some("Pad".into()), channel: None, keys, tx: htx, cc: true }));
    let pad: Arc<str> = Arc::from("Pad");
    sink.feed_at(10, &pad, &[0xB0, 89, 127], &mut rs);
    sink.feed_at(11, &pad, &[0xB0, 89, 0], &mut rs);
    sink.feed_at(12, &pad, &[0xB0, 90, 127], &mut rs); // unmapped: a normal CC
    assert_eq!(hrx.try_iter().collect::<Vec<_>>(), vec![GridHit { key: 89, on: true }, GridHit { key: 89, on: false }]);
}

#[test]
fn hardware_commands() {
    crate::midi::init_clock();
    let shared = crate::clock::ClockShared::new();
    let live = Arc::new(crate::record::LiveShared::new());
    let (_rt, ctl) = crate::record::live_channels(live);
    let mut hw = crate::hardware_ctl::HardwareCtl::new(shared.clone(), ctl.sink.clone());
    let r = hw.dispatch("setMidiClock", &json!({ "ports": ["A", "A", "B"], "offsetMs": 500 })).unwrap().unwrap();
    assert_eq!(r["ports"], json!(["A", "B"]));
    assert_eq!(r["offsetMs"], json!(100.0), "clamped to ±100 ms");
    assert_eq!(r["open"], json!([]), "neither port exists here");
    assert!(shared.out_on.load(R));
    hw.dispatch("setMidiClock", &json!({ "ports": [] })).unwrap().unwrap();
    assert!(!shared.out_on.load(R));
    let e = hw.dispatch("midiSend", &json!({ "port": "Nope", "messages": [[0x90, 1, 2]] })).unwrap().unwrap_err();
    assert_eq!(e, "MIDI output 'Nope' isn't open");
    let e = hw.dispatch("midiSend", &json!({ "port": "Nope", "messages": [[0x90, 1]] })).unwrap().unwrap_err();
    assert!(e.starts_with("midiSend: malformed"), "{e}");
    let r = hw.dispatch("setMidiSync", &json!({ "device": "Clock In" })).unwrap().unwrap();
    assert_eq!(r["device"], json!("Clock In"));
    assert!(shared.sync_on.load(R));
    hw.dispatch("setMidiSync", &json!({ "device": null })).unwrap().unwrap();
    assert!(!shared.sync_on.load(R));
    assert!(hw.dispatch("launch", &json!({})).is_none(), "not a hardware command");
    let outs = hw.dispatch("listMidiOutputs", &json!({})).unwrap().unwrap();
    assert!(outs.is_array());
    hw.shutdown();
}
