use super::{frames, sane_sr, sanitize_block};
use crate::blocks::dynamics::Follower;
use crate::blocks::{db_to_gain, tc_coef, Smooth};
use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    Attack => lin("attack", "Attack", -1.0, 1.0, 0.0, "%", "Transient"),
    Sustain => lin("sustain", "Sustain", -1.0, 1.0, 0.0, "%", "Transient"),
    AttackWindow => logp("attackWindow", "Attack window", 2.0, 60.0, 15.0, "ms", "Transient"),
    SustainWindow => logp("sustainWindow", "Sustain window", 20.0, 1000.0, 200.0, "ms", "Transient"),
    Output => lin("output", "Output", -24.0, 12.0, 0.0, "dB", "Transient"),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.transient",
        name: "Krypt Transient",
        kind: PluginKind::Effect,
        category: "Dynamics",
        description: "Transient shaper: Attack boosts (+) or softens (-) the start of every hit, Sustain lifts or shortens \
                      the tail. Works at any input level (no threshold). Attack window sets how long the onset counts as \
                      attack; Sustain window sets how long tails are tracked. Up to about +18/-30 dB. Zero latency.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

const SCALE: f32 = 0.6;
const FLOOR_DB: f32 = -80.0;

pub struct Transient {
    pb: ParamBank<N_PARAMS>,
    fresh: bool,
    sr: f32,
    fast: Follower,
    slow: Follower,
    hold: Follower,
    short: Follower,
    attack: f32,
    sustain: f32,
    gain_db: f32,
    gain_coef: f32,
    out: Smooth,
}

impl Transient {
    pub fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let sr = sane_sr(sample_rate);
        let mut t = Self {
            pb: ParamBank::new(&param_specs()),
            fresh: true,
            sr,
            fast: Follower::new(0.1, 30.0, sr),
            slow: Follower::new(15.0, 30.0, sr),
            hold: Follower::new(0.1, 200.0, sr),
            short: Follower::new(0.1, 20.0, sr),
            attack: 0.0,
            sustain: 0.0,
            gain_db: 0.0,
            gain_coef: tc_coef(1.0, sr),
            out: Smooth::with_time(1.0, 15.0, sr),
        };
        t.update();
        t.out.reset(t.out.target);
        t
    }

    fn update(&mut self) {
        let p = &self.pb;
        self.attack = p.get(P::Attack as usize);
        self.sustain = p.get(P::Sustain as usize);
        let aw = p.get(P::AttackWindow as usize);
        let sw = p.get(P::SustainWindow as usize);
        self.fast.set(0.1, 2.0 * aw + 10.0, self.sr);
        self.slow.set(aw, 2.0 * aw + 10.0, self.sr);
        self.hold.set(0.1, sw, self.sr);
        self.short.set(0.1, (0.1 * sw).clamp(5.0, 40.0), self.sr);
        self.out.set(db_to_gain(p.get(P::Output as usize)));
    }
}

#[inline]
fn db(x: f32) -> f32 {
    if x > 1e-9 {
        20.0 * x.log10()
    } else {
        -180.0
    }
}

impl Effect for Transient {
    fn prepare(&mut self, sample_rate: f32, _max_frames: usize) {
        self.sr = sane_sr(sample_rate);
        self.gain_coef = tc_coef(1.0, self.sr);
        self.out.set_time(15.0, self.sr);
        self.update();
        self.reset();
    }

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn process(&mut self, ctx: &ProcessContext, mut buf: [&mut [f32]; 2], _sc: Option<[&[f32]; 2]>) {
        let n = frames(ctx, &buf);
        if self.pb.take_dirty() {
            self.update();
        }
        if self.fresh {
            self.fresh = false;
            self.out.reset(self.out.target);
        }
        for i in 0..n {
            let (l, r) = (crate::blocks::finite(buf[0][i]), crate::blocks::finite(buf[1][i]));
            let lvl = l.abs().max(r.abs());
            let f = self.fast.tick(lvl);
            let s = self.slow.tick(lvl);
            let h = self.hold.tick(lvl);
            let sh = self.short.tick(lvl);
            let target = if db(h) > FLOOR_DB {
                let att = (db(f) - db(s)).max(0.0);
                let sus = (db(h) - db(sh)).clamp(0.0, 60.0);
                (SCALE * (self.attack * att + self.sustain * sus)).clamp(-30.0, 18.0)
            } else {
                0.0
            };
            self.gain_db += (target - self.gain_db) * self.gain_coef;
            let g = db_to_gain(self.gain_db) * self.out.next();
            buf[0][i] = l * g;
            buf[1][i] = r * g;
        }
        sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {
        self.fresh = true;
        self.fast.reset();
        self.slow.reset();
        self.hold.reset();
        self.short.reset();
        self.gain_db = 0.0;
    }
}
