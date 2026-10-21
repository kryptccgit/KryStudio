use crate::ParamSpec;

macro_rules! param_table {
    ($($var:ident => $spec:expr),* $(,)?) => {
        #[allow(dead_code)]
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        #[repr(usize)]
        pub(crate) enum P { $($var),* }
        pub(crate) const N_PARAMS: usize = [$(P::$var),*].len();
        pub(crate) fn param_specs() -> Vec<crate::ParamSpec> {
            #[allow(unused_imports)]
            use crate::params::*;
            vec![$($spec),*]
        }
    };
}
pub(crate) use param_table;

#[allow(clippy::too_many_arguments)]
fn base(id: &'static str, name: &'static str, min: f32, max: f32, default: f32, unit: &'static str, scale: &'static str, group: &'static str) -> ParamSpec {
    ParamSpec { id, name, min, max, default, unit, scale, step: None, options: None, group: Some(group), automatable: None }
}

pub(crate) fn lin(id: &'static str, name: &'static str, min: f32, max: f32, default: f32, unit: &'static str, group: &'static str) -> ParamSpec {
    base(id, name, min, max, default, unit, "linear", group)
}

pub(crate) fn logp(id: &'static str, name: &'static str, min: f32, max: f32, default: f32, unit: &'static str, group: &'static str) -> ParamSpec {
    base(id, name, min, max, default, unit, "log", group)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn stepped(id: &'static str, name: &'static str, min: f32, max: f32, default: f32, unit: &'static str, step: f32, group: &'static str) -> ParamSpec {
    let mut s = base(id, name, min, max, default, unit, "linear", group);
    s.step = Some(step);
    s
}

pub(crate) fn toggle(id: &'static str, name: &'static str, on: bool, group: &'static str) -> ParamSpec {
    choice(id, name, &["Off", "On"], on as usize, group)
}

pub(crate) fn choice(id: &'static str, name: &'static str, options: &[&'static str], default: usize, group: &'static str) -> ParamSpec {
    let mut s = base(id, name, 0.0, (options.len() - 1) as f32, default as f32, "", "linear", group);
    s.step = Some(1.0);
    s.options = Some(options.to_vec());
    s
}

pub(crate) fn not_automatable(mut s: ParamSpec) -> ParamSpec {
    s.automatable = Some(false);
    s
}

pub(crate) const SYNC_DIVISIONS: [&str; 15] =
    ["1/64", "1/32", "1/16T", "1/16", "1/16D", "1/8T", "1/8", "1/8D", "1/4T", "1/4", "1/4D", "1/2", "1 bar", "2 bars", "4 bars"];
pub(crate) const SYNC_BEATS: [f64; 15] =
    [1.0 / 16.0, 1.0 / 8.0, 1.0 / 6.0, 0.25, 0.375, 1.0 / 3.0, 0.5, 0.75, 2.0 / 3.0, 1.0, 1.5, 2.0, 4.0, 8.0, 16.0];

pub(crate) fn sync_beats(idx: usize, beats_per_bar: f64) -> f64 {
    let i = idx.min(SYNC_BEATS.len() - 1);
    let bpb = if beats_per_bar.is_finite() && beats_per_bar > 0.0 { beats_per_bar } else { 4.0 };
    if i >= 12 { SYNC_BEATS[i] / 4.0 * bpb } else { SYNC_BEATS[i] }
}

pub(crate) struct ParamBank<const N: usize> {
    v: [f32; N],
    lo: [f32; N],
    hi: [f32; N],
    step: [f32; N],
    dirty: bool,
}

impl<const N: usize> ParamBank<N> {
    pub fn new(specs: &[ParamSpec]) -> Self {
        debug_assert_eq!(specs.len(), N, "param table / bank size mismatch");
        let mut b = Self { v: [0.0; N], lo: [0.0; N], hi: [0.0; N], step: [0.0; N], dirty: true };
        for (i, s) in specs.iter().take(N).enumerate() {
            b.v[i] = s.default;
            b.lo[i] = s.min;
            b.hi[i] = s.max;
            b.step[i] = s.step.unwrap_or(0.0);
        }
        b
    }

    #[inline]
    pub fn set(&mut self, i: usize, x: f32) {
        if i >= N || !x.is_finite() {
            return;
        }
        let mut x = x.clamp(self.lo[i], self.hi[i]);
        let st = self.step[i];
        if st > 0.0 {
            x = (((x - self.lo[i]) / st).round() * st + self.lo[i]).clamp(self.lo[i], self.hi[i]);
        }
        if self.v[i] != x {
            self.v[i] = x;
            self.dirty = true;
        }
    }

    #[inline]
    pub fn get(&self, i: usize) -> f32 {
        self.v[i]
    }

    #[inline]
    pub fn idx(&self, i: usize) -> usize {
        self.v[i].max(0.0).round() as usize
    }

    #[inline]
    pub fn on(&self, i: usize) -> bool {
        self.v[i] >= 0.5
    }

    #[inline]
    pub fn take_dirty(&mut self) -> bool {
        std::mem::replace(&mut self.dirty, false)
    }
}

#[cfg(test)]
mod sync_tests {
    #[test]
    fn sync_bars_follow_the_time_signature() {
        use super::sync_beats;
        assert_eq!(sync_beats(9, 3.0), 1.0, "1/4 is always a quarter note");
        assert_eq!(sync_beats(12, 4.0), 4.0, "1 bar of 4/4");
        assert_eq!(sync_beats(12, 3.0), 3.0, "1 bar of 3/4 or 6/8");
        assert_eq!(sync_beats(14, 3.5), 14.0, "4 bars of 7/8");
        assert_eq!(sync_beats(13, f64::NAN), 8.0, "bad meter falls back to 4/4");
    }
}
