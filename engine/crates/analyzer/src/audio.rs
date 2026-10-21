//! Decoding + the shared front end every job uses: mono mixdown and a
//! band-limited resampler to the analysis rate (22 050 Hz, which is also what
//! Basic Pitch and Beat This! expect).

use std::path::Path;

use krypt_studio_dsp::SampleData;

use crate::JobError;

/// Analysis sample rate (Basic Pitch / Beat This! native rate).
pub const ANALYSIS_SR: u32 = 22_050;

/// Decode a file with the engine's decoder (symphonia: wav, aiff, flac, mp3,
/// ogg/vorbis; Windows Media Foundation: m4a, aac, mp4, alac, wma, ...).
/// Errors are the decoder's human sentences, which name the file.
pub fn load(path: &str) -> Result<SampleData, JobError> {
    if path.trim().is_empty() {
        return Err(JobError::Failed("No audio file was given".into()));
    }
    let p = Path::new(path);
    if !p.exists() {
        return Err(JobError::Failed(format!("Cannot open {path}: the file does not exist")));
    }
    let data = krypt_studio_dsp::decode::decode_file(p).map_err(JobError::Failed)?;
    if data.frames() == 0 {
        return Err(JobError::Failed(format!("{path} contains no audio")));
    }
    if !(data.sample_rate.is_finite() && data.sample_rate >= 1000.0) {
        return Err(JobError::Failed(format!("{path} has an unsupported sample rate ({} Hz)", data.sample_rate)));
    }
    Ok(data)
}

/// Average of the channels (non-finite samples become 0).
pub fn mono(channels: &[Vec<f32>]) -> Vec<f32> {
    match channels.len() {
        0 => Vec::new(),
        1 => channels[0].iter().map(|&x| if x.is_finite() { x } else { 0.0 }).collect(),
        _ => {
            let n = channels.iter().map(|c| c.len()).min().unwrap_or(0);
            let k = 1.0 / channels.len() as f32;
            (0..n)
                .map(|i| {
                    let s: f32 = channels.iter().map(|c| c[i]).sum::<f32>() * k;
                    if s.is_finite() {
                        s
                    } else {
                        0.0
                    }
                })
                .collect()
        }
    }
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

/// Zeroth-order modified Bessel function (Kaiser window).
fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let q = x * x / 4.0;
    for k in 1..64 {
        term *= q / (k as f64 * k as f64);
        sum += term;
        if term < sum * 1e-12 {
            break;
        }
    }
    sum
}

/// Windowed-sinc polyphase resampler (Kaiser β = 8.6, 16 zero crossings,
/// cutoff 0.97 × the lower Nyquist). Exact rational phases for integer rate
/// pairs with a reduced upsampling factor ≤ 4096 (every common rate pair);
/// otherwise phases are quantised to 1/4096 of a sample.
pub fn resample(x: &[f32], from_hz: f32, to_hz: u32) -> Vec<f32> {
    let from_i = from_hz.round() as u64;
    let to_i = to_hz as u64;
    if x.is_empty() || from_i == 0 || to_i == 0 {
        return Vec::new();
    }
    if from_i == to_i {
        return x.to_vec();
    }
    let g = gcd(from_i, to_i);
    let (mut l, mut m) = (to_i / g, from_i / g); // output n ↔ input n·m/l
    let exact = l <= 4096;
    if !exact {
        l = 4096;
        m = 0; // unused; position computed in f64 below
    }
    let ratio = to_i as f64 / from_i as f64; // out/in
    let fc = 0.5 * ratio.min(1.0) * 0.97; // cycles per input sample
    let zeros = 16.0;
    let half = (zeros / (2.0 * fc)).ceil() as usize; // half width in input samples
    let taps = 2 * half;
    let beta = 8.6;
    let i0b = bessel_i0(beta);
    // table[p][j] = h(p/l + half - 1 - j)
    let mut table = vec![0f32; l as usize * taps];
    for p in 0..l as usize {
        let frac = p as f64 / l as f64;
        let row = &mut table[p * taps..(p + 1) * taps];
        let mut sum = 0.0f64;
        for (j, t) in row.iter_mut().enumerate() {
            let xx = frac + half as f64 - 1.0 - j as f64;
            let u = xx / half as f64;
            let w = if u.abs() >= 1.0 { 0.0 } else { bessel_i0(beta * (1.0 - u * u).sqrt()) / i0b };
            let arg = 2.0 * fc * xx;
            let sinc = if arg.abs() < 1e-12 { 1.0 } else { (std::f64::consts::PI * arg).sin() / (std::f64::consts::PI * arg) };
            let h = 2.0 * fc * sinc * w;
            *t = h as f32;
            sum += h;
        }
        // Normalise DC gain per phase (removes tiny ripple between phases).
        if sum.abs() > 1e-9 {
            for t in row.iter_mut() {
                *t = (*t as f64 / sum) as f32;
            }
        }
    }
    let n_out = ((x.len() as f64) * ratio).ceil() as usize;
    let mut out = Vec::with_capacity(n_out);
    let len = x.len() as i64;
    for n in 0..n_out {
        let (i0, p) = if exact {
            let num = n as u64 * m;
            ((num / l) as i64, (num % l) as usize)
        } else {
            let t = n as f64 / ratio;
            let i0 = t.floor();
            let p = (((t - i0) * l as f64).round() as usize).min(l as usize - 1);
            (i0 as i64, p)
        };
        let start = i0 - half as i64 + 1;
        let row = &table[p * taps..(p + 1) * taps];
        let acc = if start >= 0 && start + taps as i64 <= len {
            let seg = &x[start as usize..start as usize + taps];
            seg.iter().zip(row).map(|(a, b)| a * b).sum::<f32>()
        } else {
            let mut acc = 0.0f32;
            for (j, &h) in row.iter().enumerate() {
                let k = start + j as i64;
                if k >= 0 && k < len {
                    acc += x[k as usize] * h;
                }
            }
            acc
        };
        out.push(acc);
    }
    out
}

/// Integer-factor decimation: Kaiser-windowed-sinc low-pass (cutoff 0.9 ×
/// the new Nyquist, 16 zero crossings), output sample j = input j·factor.
pub fn decimate(x: &[f32], factor: usize) -> Vec<f32> {
    if factor <= 1 {
        return x.to_vec();
    }
    let fc = 0.5 / factor as f64 * 0.9; // cycles per input sample
    let half = (16.0 / (2.0 * fc)).ceil() as i64;
    let beta = 8.6;
    let i0b = bessel_i0(beta);
    let mut h: Vec<f32> = (-half..=half)
        .map(|i| {
            let u = i as f64 / half as f64;
            let w = if u.abs() >= 1.0 { 0.0 } else { bessel_i0(beta * (1.0 - u * u).sqrt()) / i0b };
            let arg = 2.0 * fc * i as f64;
            let s = if arg.abs() < 1e-12 { 1.0 } else { (std::f64::consts::PI * arg).sin() / (std::f64::consts::PI * arg) };
            (2.0 * fc * s * w) as f32
        })
        .collect();
    let sum: f32 = h.iter().sum();
    for v in h.iter_mut() {
        *v /= sum;
    }
    let n_out = x.len().div_ceil(factor);
    let len = x.len() as i64;
    (0..n_out)
        .map(|j| {
            let c = (j * factor) as i64;
            let a = c - half;
            if a >= 0 && c + half < len {
                x[a as usize..=(c + half) as usize].iter().zip(&h).map(|(p, q)| p * q).sum()
            } else {
                h.iter().enumerate().map(|(i, &q)| {
                    let k = a + i as i64;
                    if k >= 0 && k < len { x[k as usize] * q } else { 0.0 }
                }).sum()
            }
        })
        .collect()
}

/// Mono at [`ANALYSIS_SR`] from decoded channels.
pub fn analysis_mono(data: &SampleData) -> Vec<f32> {
    let m = mono(&data.channels);
    resample(&m, data.sample_rate, ANALYSIS_SR)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(f: f32, sr: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f32::consts::PI * f * i as f32 / sr).sin()).collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn resample_keeps_passband_and_kills_aliases() {
        for &from in &[44_100.0f32, 48_000.0, 32_000.0, 96_000.0, 44_056.0] {
            let n = from as usize; // 1 s
            let y = resample(&sine(1000.0, from, n), from, ANALYSIS_SR);
            assert!((y.len() as i64 - 22_050).abs() <= 2, "{from}: len {}", y.len());
            let mid = &y[2000..y.len() - 2000];
            assert!((rms(mid) - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.01, "{from}: rms {}", rms(mid));
            // Phase/time check: compare with an ideal 1 kHz sine at 22 050.
            let ideal = sine(1000.0, 22_050.0, y.len());
            let err: f32 = mid.iter().zip(&ideal[2000..y.len() - 2000]).map(|(a, b)| (a - b) * (a - b)).sum::<f32>() / mid.len() as f32;
            assert!(err.sqrt() < 0.01, "{from}: waveform error {}", err.sqrt());
            // 15 kHz is above the new Nyquist: must vanish.
            let z = resample(&sine(15_000.0, from, n), from, ANALYSIS_SR);
            assert!(rms(&z[2000..z.len() - 2000]) < 0.01, "{from}: alias rms {}", rms(&z[2000..z.len() - 2000]));
        }
    }

    #[test]
    fn decimate_keeps_low_band_and_kills_highs() {
        let sr = 22_050.0;
        let y = decimate(&sine(100.0, sr, 22_050), 8);
        assert_eq!(y.len(), 2757);
        let mid = &y[300..y.len() - 300];
        assert!((rms(mid) - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.01, "{}", rms(mid));
        let z = decimate(&sine(3000.0, sr, 22_050), 8);
        assert!(rms(&z[300..z.len() - 300]) < 0.01);
    }
}
