//! Automation curve evaluation — the IDENTICAL formula to
//! shared/schema/automation.ts (golden-tested below):
//!   t = (tick - a) / (b - a)
//!   shape(t, τ) = τ == 0 ? t : t ^ (2 ^ (-3τ))
//!   value = va + (vb - va) * shape(t, τ)
//! Before the first point: first value. After the last point: last value.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub tick: f64,
    pub value: f64,
    pub tension: f64,
}

#[inline]
pub fn shape_curve(t: f64, tension: f64) -> f64 {
    if tension == 0.0 {
        t
    } else {
        t.powf(2f64.powf(-3.0 * tension))
    }
}

/// Sort like `sortPoints()` (tick, then id).
pub fn sort_points(points: &mut [(f64, String, f64, f64)]) {
    points.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.1.cmp(&b.1)));
}

/// Normalized 0..1 value at `tick` (points must be sorted). [RT]
pub fn eval(sorted: &[Point], tick: f64) -> f64 {
    let n = sorted.len();
    if n == 0 {
        return 0.0;
    }
    if tick <= sorted[0].tick {
        return sorted[0].value;
    }
    let last = sorted[n - 1];
    if tick >= last.tick {
        return last.value;
    }
    let (mut lo, mut hi) = (0usize, n - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1;
        if sorted[mid].tick <= tick {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let a = sorted[lo];
    let b = sorted[hi];
    let span = b.tick - a.tick;
    if span <= 0.0 {
        return b.value;
    }
    let t = (tick - a.tick) / span;
    a.value + (b.value - a.value) * shape_curve(t, a.tension)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Golden values produced by running the TS formula in Node 24
    // (shapeCurve / evalAutomation from shared/schema/automation.ts).
    #[test]
    fn golden_shape() {
        let cases = [
            (0.5, 0.4, 0.73955262660743015),
            (0.25, -0.7, 0.0026236887539450898),
            (0.9, 1.0, 0.98691628136600151),
            (0.1, -1.0, 1.0000000000000005e-8),
            (0.333, 0.123, 0.42679515745214619),
        ];
        for (t, te, want) in cases {
            let got = shape_curve(t, te);
            assert!((got - want).abs() <= want.abs() * 1e-12 + 1e-20, "shape({t},{te}) = {got}, want {want}");
        }
        assert_eq!(shape_curve(0.37, 0.0), 0.37);
    }

    #[test]
    fn golden_eval() {
        let pts = [
            Point { tick: 0.0, value: 0.35, tension: 0.0 },
            Point { tick: 15360.0, value: 0.85, tension: 0.4 },
            Point { tick: 23040.0, value: 0.6, tension: 0.0 },
        ];
        let cases = [
            (-5.0, 0.34999999999999998),
            (0.0, 0.34999999999999998),
            (1000.0, 0.38255208333333329),
            (7680.0, 0.59999999999999998),
            (15359.0, 0.84996744791666656),
            (15360.0, 0.84999999999999998),
            (17000.0, 0.72233249509907593),
            (19200.0, 0.66511184334814244),
            (23039.0, 0.60001416963821730),
            (23040.0, 0.59999999999999998),
            (30000.0, 0.59999999999999998),
        ];
        for (tick, want) in cases {
            let got = eval(&pts, tick);
            assert!((got - want).abs() < 1e-14, "eval({tick}) = {got}, want {want}");
        }
        assert_eq!(eval(&[], 5.0), 0.0);
        // Coincident points: value of the later one.
        let dup = [
            Point { tick: 0.0, value: 0.0, tension: 0.0 },
            Point { tick: 100.0, value: 0.2, tension: 0.0 },
            Point { tick: 100.0, value: 0.9, tension: 0.0 },
            Point { tick: 200.0, value: 1.0, tension: 0.0 },
        ];
        assert!((eval(&dup, 150.0) - 0.95).abs() < 1e-12);
    }
}
