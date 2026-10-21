# krypt-studio-dsp: third-party code, algorithms and credits

No third-party source code is copied into this crate. Every DSP routine was written from scratch from the published papers and specifications listed below. No GPL or LGPL code was consulted, including Surge, Vital, Dexed, LMMS, chowdsp, synfx-dsp, `sst-*` and the GPL Faust reverbs.

## Rust dependencies

| Crate | Licence | Used for |
|---|---|---|
| [`ebur128`](https://crates.io/crates/ebur128) | MIT | EBU R128 / ITU-R BS.1770 loudness in `analysis.rs`: integrated, short-term and loudness range |
| [`rustfft`](https://crates.io/crates/rustfft) | MIT OR Apache-2.0 | FFTs for band energies, spectral centroid and onset detection in `analysis.rs`; building the band-limited wavetable mip levels in `instruments/wavetable.rs` (off the audio thread) |
| [`serde`](https://crates.io/crates/serde) | MIT OR Apache-2.0 | Serializing the plugin catalog and analysis results |
| [`assert_no_alloc`](https://crates.io/crates/assert_no_alloc) (dev only) | BSD-1-Clause | Tests that prove no allocation happens on the audio thread |
| [`serde_json`](https://crates.io/crates/serde_json) (dev only) | MIT OR Apache-2.0 | Seed-catalog comparison test |

## Algorithms and references (implemented from the publications)

- **State-variable filters, EQ bells and shelves, cut cascades.** Andrew Simper (Cytomic), *Linear Trapezoidal Integrated SVF* (2013), and Vadim Zavalishin, *The Art of VA Filter Design*. Butterworth section Qs come from the standard pole formula. The RBJ *Audio EQ Cookbook* is the reference for the shelf and bell definitions.
- **Band-limited oscillators.**
  - V. Välimäki and A. Huovilainen, *Antialiasing Oscillators in Subtractive Synthesis* (2007), for PolyBLEP.
  - F. Esqueda, V. Välimäki and S. Bilbao, *Rounding Corners with BLAMP* (DAFx 2016), for PolyBLAMP.
- **Antiderivative anti-aliasing for the waveshapers.** J. Parker, V. Zavalishin and E. Le Bivic, *Reducing the Aliasing of Nonlinear Waveshaping Using Continuous-Time Convolution* (DAFx 2016).
- **Compressor.** D. Giannoulis, M. Massberg and J. D. Reiss, *Digital Dynamic Range Compressor Design: A Tutorial and Analysis* (JAES 2012): soft-knee gain computer and smooth branching detector.
- **True peak.** ITU-R BS.1770-4, Annex 2: 4× oversampled peak detection. Two interpolators are designed here:
  - a Kaiser-windowed sinc;
  - a 48-tap Hann-windowed sinc, the conventional design used by common R128 meters.
- **Plate reverb.** Jon Dattorro, *Effect Design Part 1: Reverberator and Other Filters* (JAES 1997). This crate uses the tank topology, delay lengths and output-tap table from the paper. Gains are derived from RT60.
- **Room and hall reverb.**
  - J.-M. Jot and A. Chaigne, *Digital Delay Networks for Designing Artificial Reverberators* (AES 1991), for the FDN with a Householder matrix and per-line T60 gains.
  - The multichannel Hadamard diffuser follows the idea in Geraint Luff's talk *Let's Write a Reverb* (ADC 2021). The concept only is used; no code.
- **Halfband oversampling and windowed-sinc resampling.** Kaiser window design (J. F. Kaiser, 1974). Standard polyphase decomposition.
- **Lookahead limiter.** A sliding-window minimum followed by a moving-average attack ramp. This is the standard brickwall construction, written from first principles; the proof sketch is in `effects/limiter.rs`.
- **Drum synthesis.** Generic analog drum-machine topologies described in public circuit analyses:
  - sine body with an exponential pitch sweep;
  - multi-burst clap;
  - six-square metallic hats and cymbal at the classic 808 oscillator frequencies;
  - damped resonances for rim and tom.

  All parameters and voicings are our own.
- **Tempo estimation.** Spectral-flux onset detection and autocorrelation (for example, Dixon 2006 and Ellis 2007), plus our own comb weighting and tempo prior.

### Wave 2 plugins

- **Chorus, flanger, phaser** (`effects/chorus.rs`, `flanger.rs`, `phaser.rs`). Modulated fractional delay lines and first-order allpass cascades as described in J. O. Smith III, *Physical Audio Signal Processing* (CCRMA, online book), chapters on flanging, chorus and phasing. The allpass stages use the TPT one-pole from Zavalishin. Through-zero flanging follows the tape-flanging principle (a fixed delayed dry reference that the swept tap passes through). Voice layouts, sweep laws and ranges are our own.
- **Crossovers** (`blocks/crossover.rs`, used by Squash and the imager). S. H. Linkwitz, *Active Crossover Networks for Noncoincident Drivers* (JAES 1976) and the Linkwitz–Riley alignment: LR4 low + high sum to a 2nd-order allpass, which the 3-band tree compensates.
- **Pitch detection** (`blocks/pitch.rs`). A. de Cheveigné and H. Kawahara, *YIN, a fundamental frequency estimator for speech and music* (JASA 111(4), 2002): difference function, cumulative-mean normalization, absolute threshold, parabolic interpolation.
- **Pitch shifting in Krypt Tune** (`effects/pitch.rs`). Our own pitch-synchronous delay-line splice shifter. The splice point is chosen by cross-correlation in the manner of WSOLA (W. Verhelst and M. Roelands, *An overlap-add technique based on waveform similarity (WSOLA) for high quality time-scale modification of speech*, ICASSP 1993), and splicing by whole pitch periods follows the PSOLA principle (E. Moulines and F. Charpentier, *Pitch-synchronous waveform processing techniques for text-to-speech synthesis using diphones*, Speech Communication 9, 1990). No GPL pitch shifter (e.g. Rubber Band) was consulted.
- **FM synthesis** (`instruments/fm.rs`). J. M. Chowning, *The Synthesis of Complex Audio Spectra by Means of Frequency Modulation* (JAES 21(7), 1973). The eight 4-operator topologies are the conventional published set; operator self-feedback averages the last two outputs, the classic stabilization. Levels, tapers, envelopes and the default patches are our own. No code from msfa or any DX emulator was ported.
- **Wavetables** (`instruments/wavetable.rs`). Per-octave mip-mapping by FFT harmonic truncation (the standard band-limited wavetable technique; see e.g. T. Stilson and J. O. Smith, *Alias-Free Digital Synthesis of Classic Analog Waveforms*, ICMC 1996, for the aliasing rationale). All factory tables are generated from our own harmonic recipes; the vowel formant frequencies are the classic averages from G. E. Peterson and H. L. Barney, *Control Methods Used in a Study of the Vowels* (JASA 1952). No Vital or Surge code, tables or presets were looked at.
- **Vocoder** (`effects/vocoder.rs`). The channel vocoder of H. Dudley, *The Vocoder* (Bell Laboratories Record, 1939): matched band-pass banks with envelope followers. The carrier normalization and spectral flattening are our own.
- **Transient shaper** (`effects/transient.rs`). Differential envelope detection (a fast and a slow follower per stage), a generic technique; constants are our own.
- **Squash multiband compressor** (`effects/squash.rs`). Gain computers after Giannoulis, Massberg and Reiss (above), applied upward and downward per band. The "OTT" multiband upward/downward idea is used for its function only; thresholds, ratios and times are our own.
- **Gate/Time** (`effects/gate.rs`). A look-back ring buffer read along tempo-locked lag curves, with crossfaded read-head jumps. Pattern shapes (stutters, half-time, tape stop, reverse, scratch, gates) are our own.

## Permissive sources permitted by the project but not used yet

The project's licence policy (see `research/03-plugins-and-dsp.md`) also permits these sources. They are not vendored or ported in this version: Airwindows (MIT), Signalsmith DSP and Signalsmith Stretch (MIT), DaisySP core (MIT), Cycfi Q (MIT), fundsp (MIT/Apache-2.0), CloudSeedCore (MIT) and msfa (Apache-2.0). If code from any of them is ported later, credit it here together with its licence text.

## Factory content

The factory drum kit (`factory::generate_kit`) is synthesized at build time by this crate's own DSP. It contains no recorded or third-party samples. The Krypt Wave factory wavetables are generated at run time from this crate's own harmonic recipes; they contain no third-party waveforms (AKWF and similar sets are not used).
