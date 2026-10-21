//! Sample-rate conversion to and from the model's fixed rate, with rubato's
//! synchronous FFT resampler (MIT). Both directions are delay-compensated so
//! stems line up sample-exactly with the source.

use audioadapter_buffers::direct::SequentialSliceOfVecs;
use rubato::{Fft, FixedSync, Indexing, Resampler};

const CHUNK: usize = 4096;

fn new_fft(from: u32, to: u32, channels: usize) -> Result<Fft<f32>, String> {
    Fft::<f32>::new(from as usize, to as usize, CHUNK, 1, channels, FixedSync::Input)
        .map_err(|e| format!("Cannot resample {from} Hz → {to} Hz: {e}"))
}

/// Converts whole planar buffers; output length is `ceil(len × to / from)`.
/// (Not rubato's `process_all_into_buffer`: it leaves the resampler delay in
/// place when the input is shorter than one chunk.)
pub fn resample_all(input: &[Vec<f32>], from: u32, to: u32) -> Result<Vec<Vec<f32>>, String> {
    let channels = input.len();
    let len = input.first().map_or(0, Vec::len);
    let target = (len as u64 * u64::from(to)).div_ceil(u64::from(from)) as usize;
    let mut out: Vec<Vec<f32>> = (0..channels).map(|_| Vec::with_capacity(target + 2 * CHUNK)).collect();
    let mut rs = StreamResampler::new(from, to, channels)?;
    let mut emit = |b: &[&[f32]]| {
        for (o, s) in out.iter_mut().zip(b) {
            o.extend_from_slice(s);
        }
        Ok(())
    };
    // Fed in blocks so the resampler never holds a second full copy.
    const BLOCK: usize = 1 << 16;
    for start in (0..len).step_by(BLOCK) {
        let end = (start + BLOCK).min(len);
        let views: Vec<&[f32]> = input.iter().map(|c| &c[start..end]).collect();
        rs.push(&views, &mut emit)?;
    }
    rs.finish(target, &mut emit)?;
    for c in &mut out {
        c.truncate(target);
        c.shrink_to_fit();
    }
    Ok(out)
}

/// Streaming conversion: push planar blocks of any size, get converted
/// blocks back through a callback (resampler delay already removed).
pub struct StreamResampler {
    rs: Fft<f32>,
    pending: Vec<Vec<f32>>,
    out: Vec<Vec<f32>>,
    skip: usize,
    emitted: usize,
}

pub type Emit<'a> = dyn FnMut(&[&[f32]]) -> Result<(), String> + 'a;

impl StreamResampler {
    pub fn new(from: u32, to: u32, channels: usize) -> Result<Self, String> {
        let rs = new_fft(from, to, channels)?;
        let out = vec![vec![0f32; rs.output_frames_max()]; channels];
        let skip = rs.output_delay();
        Ok(Self { rs, pending: vec![Vec::new(); channels], out, skip, emitted: 0 })
    }

    pub fn push(&mut self, input: &[&[f32]], emit: &mut Emit<'_>) -> Result<(), String> {
        for (p, i) in self.pending.iter_mut().zip(input) {
            p.extend_from_slice(i);
        }
        let need = self.rs.input_frames_next();
        let have = self.pending[0].len();
        let mut consumed = 0;
        while have - consumed >= need {
            consumed += self.process(consumed, have, emit)?;
        }
        for p in &mut self.pending {
            p.drain(..consumed);
        }
        Ok(())
    }

    /// Converts what is left (zero-padded) and keeps pumping silence until at
    /// least `min_total` frames were emitted over the stream's whole life.
    pub fn finish(&mut self, min_total: usize, emit: &mut Emit<'_>) -> Result<(), String> {
        let need = self.rs.input_frames_next();
        let mut guard = 0;
        while !self.pending[0].is_empty() || self.emitted < min_total {
            for p in &mut self.pending {
                p.resize(need, 0.0);
            }
            self.process(0, need, emit)?;
            for p in &mut self.pending {
                p.clear();
            }
            guard += 1;
            if guard > 64 {
                return Err("Resampler did not flush".into());
            }
        }
        Ok(())
    }

    fn process(&mut self, offset: usize, have: usize, emit: &mut Emit<'_>) -> Result<usize, String> {
        let channels = self.pending.len();
        let cap = self.out[0].len();
        let (nin, nout) = {
            let ia = SequentialSliceOfVecs::new(&self.pending[..], channels, have).map_err(|e| e.to_string())?;
            let mut oa = SequentialSliceOfVecs::new_mut(&mut self.out[..], channels, cap).map_err(|e| e.to_string())?;
            let idx = Indexing { input_offset: offset, output_offset: 0, partial_len: None, active_channels_mask: None };
            self.rs.process_into_buffer(&ia, &mut oa, Some(&idx)).map_err(|e| format!("Resampling failed: {e}"))?
        };
        let s = self.skip.min(nout);
        self.skip -= s;
        if nout > s {
            let views: Vec<&[f32]> = self.out.iter().map(|o| &o[s..nout]).collect();
            emit(&views)?;
            self.emitted += nout - s;
        }
        Ok(nin)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(len: usize, rate: f32, hz: f32) -> Vec<f32> {
        (0..len).map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / rate).sin() * 0.5).collect()
    }

    #[test]
    fn whole_buffer_length_and_alignment() {
        let src = vec![tone(48_000, 48_000.0, 440.0)];
        let out = resample_all(&src, 48_000, 44_100).unwrap();
        assert_eq!(out[0].len(), 44_100);
        // Delay-compensated: the 44.1 kHz copy matches an ideal 440 Hz tone.
        let ideal = tone(44_100, 44_100.0, 440.0);
        let err = out[0][2000..42_000].iter().zip(&ideal[2000..42_000]).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(err < 1e-3, "error {err}");
    }

    #[test]
    fn short_input_is_not_swallowed_by_the_delay() {
        // 100 samples at 22.05 kHz → 200 at 44.1 kHz, carrying the signal.
        let src = vec![tone(100, 22_050.0, 500.0)];
        let out = resample_all(&src, 22_050, 44_100).unwrap();
        assert_eq!(out[0].len(), 200);
        let ideal = tone(200, 44_100.0, 500.0);
        let err = out[0][40..160].iter().zip(&ideal[40..160]).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(err < 0.05, "error {err}");
    }

    #[test]
    fn streaming_round_trip_matches_source() {
        let len = 96_123;
        let src = tone(len, 48_000.0, 1000.0);
        let mid = resample_all(std::slice::from_ref(&src), 48_000, 44_100).unwrap();
        let mut rs = StreamResampler::new(44_100, 48_000, 1).unwrap();
        let mut back = Vec::new();
        // Odd block sizes on purpose.
        for block in mid[0].chunks(7_777) {
            rs.push(&[block], &mut |b: &[&[f32]]| {
                back.extend_from_slice(b[0]);
                Ok(())
            })
            .unwrap();
        }
        rs.finish(len, &mut |b: &[&[f32]]| {
            back.extend_from_slice(b[0]);
            Ok(())
        })
        .unwrap();
        assert!(back.len() >= len);
        let err = back[3000..len - 3000].iter().zip(&src[3000..len - 3000]).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(err < 2e-3, "round-trip error {err}");
    }
}
