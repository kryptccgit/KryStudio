use crate::model::Pattern;

pub const PPQ: f64 = 960.0;
pub const TICKS_PER_STEP: f64 = 240.0;

#[inline]
pub fn ticks_per_frame(bpm: f64, sample_rate: f64) -> f64 {
    bpm * PPQ / (60.0 * sample_rate)
}

#[inline]
pub fn ticks_to_seconds(ticks: f64, bpm: f64) -> f64 {
    (ticks / PPQ) * (60.0 / bpm)
}

#[inline]
pub fn seconds_to_ticks(seconds: f64, bpm: f64) -> f64 {
    seconds * bpm * PPQ / 60.0
}

#[inline]
pub fn ticks_to_frames(ticks: f64, bpm: f64, sample_rate: f64) -> f64 {
    ticks_to_seconds(ticks, bpm) * sample_rate
}

#[inline]
pub fn beat_ticks(den: f64) -> f64 {
    PPQ * 4.0 / sanitize_den(den)
}

#[inline]
pub fn bar_ticks(num: f64, den: f64) -> f64 {
    beat_ticks(den) * sanitize_num(num)
}

fn sanitize_num(n: f64) -> f64 {
    if n.is_finite() && n >= 1.0 {
        n.round()
    } else {
        4.0
    }
}

fn sanitize_den(d: f64) -> f64 {
    if d.is_finite() && d >= 1.0 {
        d.round()
    } else {
        4.0
    }
}

pub fn pattern_length(p: &Pattern, num: f64, den: f64) -> f64 {
    let bar = bar_ticks(num, den);
    if let Some(l) = p.length {
        if l > 0.0 {
            return l;
        }
    }
    let mut end: f64 = 0.0;
    for notes in p.notes.values() {
        for n in notes {
            end = end.max(n.tick + n.dur);
        }
    }
    bar.max((end / bar).ceil() * bar)
}

#[inline]
pub fn swing_offset(tick: f64, swing: f64, channel_swing: f64) -> f64 {
    let step = (tick / TICKS_PER_STEP).floor() as i64;
    if step.rem_euclid(2) == 1 {
        swing.clamp(0.0, 1.0) * channel_swing.clamp(0.0, 1.0) * TICKS_PER_STEP * 0.5
    } else {
        0.0
    }
}

pub const MAX_SWING_TICKS: f64 = TICKS_PER_STEP * 0.5;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Note;
    use std::collections::BTreeMap;

    #[test]
    fn tick_sample_math() {
        let tpf = ticks_per_frame(120.0, 48000.0);
        assert!((tpf - 0.04).abs() < 1e-12);
        assert!((ticks_to_seconds(960.0, 120.0) - 0.5).abs() < 1e-12);
        assert!((ticks_to_frames(960.0, 120.0, 48000.0) - 24000.0).abs() < 1e-9);
        assert!((seconds_to_ticks(0.5, 120.0) - 960.0).abs() < 1e-9);
        assert!((ticks_to_seconds(240.0, 140.0) - 60.0 / 140.0 / 4.0).abs() < 1e-12);
        for bpm in [60.0, 97.3, 140.0, 999.0] {
            let t = 12345.678;
            assert!((seconds_to_ticks(ticks_to_seconds(t, bpm), bpm) - t).abs() < 1e-9);
        }
    }

    fn pat(len: Option<f64>, notes: &[(f64, f64)]) -> Pattern {
        let mut m = BTreeMap::new();
        m.insert(
            "c".to_string(),
            notes
                .iter()
                .map(|(t, d)| Note { tick: *t, dur: *d, ..Default::default() })
                .collect::<Vec<_>>(),
        );
        Pattern { id: "p".into(), length: len, notes: m }
    }

    #[test]
    fn pattern_length_rules() {
        assert_eq!(pattern_length(&pat(None, &[]), 4.0, 4.0), 3840.0);
        assert_eq!(pattern_length(&pat(None, &[(0.0, 240.0), (3600.0, 240.0)]), 4.0, 4.0), 3840.0);
        assert_eq!(pattern_length(&pat(None, &[(3700.0, 240.0)]), 4.0, 4.0), 7680.0);
        assert_eq!(pattern_length(&pat(Some(1000.0), &[(3700.0, 240.0)]), 4.0, 4.0), 1000.0);
        assert_eq!(pattern_length(&pat(None, &[(2900.0, 10.0)]), 3.0, 4.0), 5760.0);
        assert_eq!(bar_ticks(7.0, 8.0), 3360.0);
    }

    #[test]
    fn swing_rules() {
        assert_eq!(swing_offset(0.0, 1.0, 1.0), 0.0);
        assert_eq!(swing_offset(240.0, 1.0, 1.0), 120.0);
        assert_eq!(swing_offset(480.0, 1.0, 1.0), 0.0);
        assert_eq!(swing_offset(720.0, 0.5, 1.0), 60.0);
        assert_eq!(swing_offset(720.0, 0.5, 0.5), 30.0);
        assert_eq!(swing_offset(300.0, 1.0, 1.0), 120.0);
        assert_eq!(swing_offset(479.0, 1.0, 0.0), 0.0);
        assert!(swing_offset(240.0, 1.0, 1.0) <= MAX_SWING_TICKS);
    }
}
