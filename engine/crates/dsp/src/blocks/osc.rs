//! Band-limited oscillators: PolyBLEP (Välimäki & Huovilainen 2007) for
//! steps, PolyBLAMP (Esqueda, Välimäki, Bilbao 2016) for slope corners.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Sine,
    Triangle,
    Saw,
    Square,
    Pulse25,
    Noise,
}

impl Shape {
    pub fn from_index(i: usize) -> Self {
        match i {
            0 => Shape::Sine,
            1 => Shape::Triangle,
            2 => Shape::Saw,
            3 => Shape::Square,
            4 => Shape::Pulse25,
            _ => Shape::Noise,
        }
    }
}

/// 2-point polynomial BLEP residual for a unit step at phase 0.
#[inline]
pub fn poly_blep(t: f64, dt: f64) -> f64 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

/// 2-point polynomial BLAMP residual for a unit slope change at phase 0
/// (in units of one sample of slope).
#[inline]
pub fn poly_blamp(t: f64, dt: f64) -> f64 {
    if t < dt {
        let x = t / dt - 1.0;
        -(x * x * x) / 3.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt + 1.0;
        (x * x * x) / 3.0
    } else {
        0.0
    }
}

#[inline]
fn wrap(t: f64) -> f64 {
    t - t.floor()
}

/// Evaluate a band-limited waveform at phase `t` (0..1) with increment `dt`.
/// Noise is handled by the caller.
#[inline]
pub fn blep_wave(shape: Shape, t: f64, dt: f64) -> f64 {
    let dt = dt.clamp(1e-9, 0.5);
    match shape {
        Shape::Sine => (t * std::f64::consts::TAU).sin(),
        Shape::Saw => 2.0 * t - 1.0 - poly_blep(t, dt),
        Shape::Square => {
            let naive = if t < 0.5 { 1.0 } else { -1.0 };
            naive + poly_blep(t, dt) - poly_blep(wrap(t + 0.5), dt)
        }
        Shape::Pulse25 => {
            let d = 0.25;
            let naive = if t < d { 1.0 } else { -1.0 };
            // remove the DC of a 25% pulse (mean = 2d-1 = -0.5)
            naive + poly_blep(t, dt) - poly_blep(wrap(t + 1.0 - d), dt) + 0.5
        }
        Shape::Triangle => {
            // -1 at t=0 rising to +1 at t=0.5; slope ±4 per cycle
            let naive = 1.0 - 4.0 * (t - 0.5).abs();
            // slope change of +8/cycle at t=0 and -8/cycle at t=0.5 → 8*dt per
            // sample; poly_blamp is 2x the unit residual, hence 4*dt.
            naive + 4.0 * dt * (poly_blamp(t, dt) - poly_blamp(wrap(t + 0.5), dt))
        }
        Shape::Noise => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Energy outside harmonic bins (aliasing) via a naive DFT on harmonics grid.
    fn alias_energy(shape: Shape, f: f64, fs: f64, corrected: bool) -> f64 {
        let n = 8192;
        let dt = f / fs;
        let mut t = 0.0;
        let mut x = vec![0.0f64; n];
        for v in x.iter_mut() {
            *v = if corrected {
                blep_wave(shape, t, dt)
            } else {
                match shape {
                    Shape::Triangle => 1.0 - 4.0 * (t - 0.5).abs(),
                    Shape::Saw => 2.0 * t - 1.0,
                    _ => unreachable!(),
                }
            };
            t = wrap(t + dt);
        }
        // Goertzel at several inharmonic frequencies between harmonics in the low band
        let mut e = 0.0;
        for k in 1..40 {
            let fa = (k as f64 + 0.5) * f * 0.25 + 37.0;
            if fa > fs * 0.45 {
                break;
            }
            let w = 2.0 * std::f64::consts::PI * fa / fs;
            let (mut re, mut im) = (0.0, 0.0);
            for (i, v) in x.iter().enumerate() {
                let hann = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos();
                re += v * hann * (w * i as f64).cos();
                im -= v * hann * (w * i as f64).sin();
            }
            e += re * re + im * im;
        }
        e
    }

    #[test]
    fn blep_reduces_aliasing() {
        for shape in [Shape::Saw, Shape::Triangle] {
            let naive = alias_energy(shape, 3517.0, 48000.0, false);
            let bl = alias_energy(shape, 3517.0, 48000.0, true);
            assert!(bl < naive * 0.5, "{shape:?}: {bl} vs naive {naive}");
        }
    }

    #[test]
    fn waveforms_bounded() {
        for shape in [Shape::Sine, Shape::Triangle, Shape::Saw, Shape::Square, Shape::Pulse25] {
            let mut t = 0.0;
            let dt = 0.0371;
            for _ in 0..10000 {
                let v = blep_wave(shape, t, dt);
                assert!(v.abs() < 1.6, "{shape:?} {v}");
                t = wrap(t + dt);
            }
        }
    }
}
