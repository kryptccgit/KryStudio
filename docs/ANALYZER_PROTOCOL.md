# Analyzer protocol (Electron main ⇄ `krypt-studio-analyzer.exe`)

The analyzer is Krypt Studio's on-device audio ML sidecar. Design rationale: `research/08-ears-references-vocals.md`
§2. It runs out of process, for the same reason plugins do. Inference allocates freely, loads GPU drivers and can
run for minutes, so it must never share a process with the audio engine or freeze Electron main.

- **Types:** `shared/analyzer/protocol.ts` (TS) and `engine/crates/analyzer/src/protocol.rs` (Rust). Change both
  together.
- **Models:** `shared/analyzer/models.ts`, which drives the Model Manager.

## Process

- Main spawns it on first use (`electron/system/sidecar.ts`: absolute path, hidden, piped stdio, never detached)
  and restarts it on crash. No arguments are required; every path arrives inside a job.
- **stdout carries protocol lines only:** one JSON object per line. stderr is free-form diagnostics, which main
  logs.
- The analyzer reads no settings and writes only where a job tells it to (`outDir`, `out`).
- Main resolves every input path, and verifies each model's files (SHA-256 from the catalog) before naming its
  `modelDir`.

## Messages

**Requests (main → analyzer).** Every request has a numeric `id`, unique per process lifetime.

```json
{"id":1,"cmd":"hello"}
{"id":2,"cmd":"analyze","args":{"path":"C:\\...\\loop.wav","sections":true,"beatModelDir":"C:\\...\\beat-this-small","drums":true}}
{"id":3,"cmd":"separate","args":{"path":"...","model":"htdemucs","modelDir":"...","outDir":"...","device":"auto"}}
{"id":4,"cmd":"transcribe","args":{"path":"...","mode":"poly","modelDir":"...\\basic-pitch"}}
{"id":5,"cmd":"tts","args":{"text":"Hello world.","voice":"af_heart","speed":1,"out":"C:\\...\\line.wav","modelDir":"C:\\...\\models\\kokoro"}}
{"id":6,"cmd":"syllables","args":{"path":"...\\line.wav","expected":3}}
{"id":7,"cmd":"sing","args":{"path":"...\\line.wav","out":"...\\sung.wav","vibrato":0.2,"glideMs":40,"segments":[{"srcStartSec":0.08,"srcEndSec":0.31,"outStartSec":0,"durSec":0.5,"midi":60}]}}
{"id":8,"cmd":"extract","args":{"path":"C:\\...\\stem.mp3","out":"C:\\...\\instruments\\<key>\\source.wav"}}
{"id":9,"cmd":"cancel","args":{"target":3}}
{"id":10,"cmd":"shutdown"}
```

**Responses (analyzer → main).** Each request gets **exactly one** response line with its `id`:

```json
{"id":2,"ok":true,"data":{ /* AudioAnalysis */ }}
{"id":3,"ok":false,"message":"Cancelled","cancelled":true}
{"id":4,"ok":false,"message":"Basic Pitch model not found in C:\\...\\basic-pitch (nmp.onnx)"}
```

**Events.** Any number may arrive before a response:

```json
{"event":"progress","id":3,"stage":"separating","fraction":0.42}
{"event":"log","level":"warn","message":"DirectML failed to initialise (…); using CPU"}
```

- `fraction` is 0..1, or -1 when indeterminate.
- `stage` is a short lowercase word that the UI shows as is: `decoding`, `analyzing`, `separating`, `writing`,
  `transcribing`, `fingerprinting`, `phonemes`, `speaking`, `syllables`, `singing`.

## Semantics

- **Jobs run concurrently.**
  - `separate` is serialised: one at a time, because each holds a large model and the GPU.
  - `analyze`, `transcribe`, `fingerprint`, `tts`, `sing`, `syllables` and `extract` run in parallel, up to 2 at once (two
    `tts` jobs share one loaded Kokoro model and take turns on it).
  - `hello` and `cancel` are answered immediately, even while jobs run.
- **Cancel.**
  - `cancel` answers `{ok:true}` straight away.
  - The target job stops at its next checkpoint (between chunks; at most about a second of work) and answers
    `{ok:false, cancelled:true}`.
  - Cancelling an unknown or finished id is `{ok:false, message:"No such job"}`.
  - A cancelled `separate` deletes any partial stem files it wrote.
- **Errors** are human sentences that name the file or model, e.g. "Cannot open …", "Unsupported or corrupt audio
  file …" or "HT-Demucs needs 4 GB of free memory". Main shows them in a toast verbatim. The analyzer **never
  panics a job silently**: a caught panic becomes `{ok:false, message:"Internal error in <job>: …"}`.
- **Decoding** uses `krypt_studio_dsp::decode`, the same decoder as the engine. It keeps at most 2 channels at the
  file's native rate (at most 30 min at 48 kHz). Jobs resample internally to whatever rate their model needs.
  - **symphonia** (MPL-2.0, royalty-free formats only): wav, aiff, flac, mp3, ogg/vorbis.
  - **Windows Media Foundation** (dsp feature `mediafoundation`, on for the engine and the analyzer): the operating
    system's own licensed decoders, so Krypt ships no codec code for m4a / mp4 / aac (ADTS) / ALAC / wma / asf,
    plus 3gp, mov, ac3 / ec3 and amr where Windows has a decoder.
  - **Order.** Files with one of those extensions go to Media Foundation first, and to symphonia if that fails (a
    misnamed wav or mp3). Everything else goes to symphonia first and falls back to Media Foundation when symphonia
    can't read it (an unusual mp3, an m4a with the wrong extension).
  - **Media Foundation details.**
    - It runs on any worker thread: each decode initialises COM (MTA) and Media Foundation for its own thread and
      undoes both afterwards. A thread that is already a COM STA is used as it is.
    - The DLLs (`mfplat`, `mfreadwrite`) are loaded from System32 at run time, never import-linked. On a Windows
      "N" edition without the Media Feature Pack the exes still start, and only those formats fail: "Unsupported
      audio file …: this format needs Windows Media Foundation, which is not installed (on Windows N editions,
      install the Media Feature Pack)".
    - Media Foundation removes the encoder delay, so decoded audio is sample-aligned with the original (checked
      for AAC, ADTS, ALAC and WMA). The tail is cut to the length the container states. Media Foundation's own
      encoder states the packet-padded length, so such files can end up to one packet (≤ 4096 frames) of silence
      longer.
    - Errors are sentences that name the file: "Unsupported or corrupt audio file …: Windows can't read this file",
      "No audio track in …", "No decoder for …: Windows has no codec installed for its audio format".
  - The engine's `sampleInfo` probes with symphonia when it can. For Media Foundation formats it decodes the whole
    file to get the length. A 3-minute stereo AAC file decodes in about 0.3 s (release build).
- **Shutdown** cancels running jobs, answers, and exits. Main kills the process if it's still alive 2 s later.

## Results

Exact shapes are in `shared/analyzer/protocol.ts`. All times are **seconds** from the start of the file; main
converts them to ticks.

| cmd | data | Notes |
|---|---|---|
| `hello` | `HelloResult {version, devices}` | `devices` lists what initialised, e.g. `["cpu","directml"]` |
| `analyze` | `AudioAnalysis` | `tempo`/`beats`/`key` are `null` when not confidently detected; `chords` is `[]` when there is no key (atonal material, drums, a bass line alone). `drumHits` is present only with `drums: true`. `estimated` lists the estimate fields (`tempo`, `beats`, `key`, `chords`, `swing`, `sections`, `drumHits`). `levels` is the engine's `Analysis` (render loudness/bands). |
| `separate` | `StemsResult` | Writes `<outDir>/<stem>.wav` (32-bit float, source rate, stereo). Stem lengths equal the source's. |
| `transcribe` | `TranscriptionResult` | `poly`/`mono` fill `notes`; `drums` fills `hits` with roles kick/snare/hat/openhat/perc |
| `fingerprint` | `{segments: SoundFingerprint[], whole?: SoundFingerprint}` | With `segments`: one fingerprint per segment, in order, and no `whole`. Without segments (or `[]`): `segments: []` and `whole`. See "Sound fingerprints". |
| `tts` | `TtsResult {path, durationSec, sampleRate, words, phonemes}` | Writes `out` (mono 32-bit float, 24 kHz). `words`: per input word, seconds in the output. See "Text to speech". |
| `syllables` | `SyllablesResult {syllables: [{startSec, endSec, voiced}]}` | In time order, non-overlapping. See "Syllables". |
| `sing` | `SingResult {path, durationSec, segments: [{f0Hz, shiftSt}]}` | Writes `out` (mono 32-bit float, the source rate). One entry per segment, in order. See "Sing". |
| `extract` | `ExtractResult {path, frames, sampleRate, channels}` | Decodes `path` (any format the engine reads) and writes `out` as a WAV: 32-bit float, the file's own rate, its first 2 channels, via `<out>.partial` + rename. Main uses it for instruments made of transcribed audio (`electron/analyzer/fromSource.ts`: an SFZ whose regions are the notes, on this copy). |

## Audio analysis

`analyze` code: `engine/crates/analyzer/src/{analyze,tempo,key,chords,sections,loudness,features}.rs`. Everything runs
on a 22 050 Hz mono mix, except levels, loudness and stereo, which use the file's own channels and rate. The file is
decoded once per call; `drums: true` adds drum hits from the same mono mix (the library light pass makes one
`analyze` call per file).

- **Measured** (deterministic, never in `estimated`):
  - `levels`: the engine's render analysis (`krypt_studio_dsp::analysis`).
  - `stereo.width` = side/mid energy, clamped to 0..1 (uncorrelated L/R ≈ 1). `stereo.correlation` = `levels`'.
  - `energy`: 3 s K-weighted loudness centred on `i × 0.5 s` (BS.1770, mono measured as dual-mono like `levels`).
  - Section `lufs`: gated integrated loudness of the section.
  - `onsetRate`: onsets per second. Onsets come from log-band spectral flux plus a summed-power rise in three
    regions (< 150 Hz, 150 Hz–5 kHz, > 5 kHz), so hats count too.
- **Tempo.** Autocorrelation of the onset envelope, scored by a comb over 4 multiples of each period and a
  log-normal tempo prior (centre 115 BPM, σ 1.1 octaves). `alternatives` holds the half and double readings, most
  plausible first. `tempo` is `null` when there are fewer than 0.75 onsets per second or no clear periodicity
  (pads, speech, noise, slow chord changes).
- **Beats and downbeats.**
  - With `beatModelDir`: Beat This! small (MIT) runs on rten while the DSP front end runs. `tempo.bpm` is the
    least-squares fit of the model's beats; `confidence` mixes the model's beat probability with interval
    regularity. A 2-beat bar reading is regrouped into 4/4. If the model can't load, analysis falls back to DSP,
    sends a `log` warning, and notes it in `sources`.
    Beat This! can fall to half time for a stretch, typically a sparse intro. So the grid is regularised at the tracked
    tempo:
    - gaps that are a whole number of beats are filled;
    - the grid is extended into sparse edges while predicted beats keep landing on onsets;
    - beats are smoothed over ±4 beats, which removes the model's 20 ms frame jitter;
    - downbeats take one consistent bar phase, the most common one among the model's.
  - Without it: a dynamic-programming tracker (Ellis 2007) on the onset envelope, extended into sparse edges the same
    way. Downbeats are a rough heuristic: the bar phase (4, or 3 when clearly better) whose beats carry the strongest
    low-band onsets and harmonic changes.
  - `beats.downbeats` is always a subset of `beats.times`.
  - On the demo "Neon Fog" with the model: 128 beats over its 32 bars, within ±17 ms of the true grid, and every
    downbeat on a bar line.
- **Key.**
  - Chroma comes from the harmonic, transient-free spectrum (a per-bin temporal median), in two analyses:
    - 110 Hz–5 kHz at 2.7 Hz resolution (372 ms window);
    - 26–220 Hz at 0.67 Hz resolution (1.5 s window) from a ×8-decimated signal, so 808 and sub-bass fundamentals
      resolve to the semitone.
    - Between 110 and 220 Hz both run, and each note keeps the stronger of its two readings (peaks within 40 cents
      are the same note). The long window can lose a C3–A3 chord tone under a kick's or an 808's smear; the short
      one can under-read a sustained low voice.
  - Per frame:
    - Tonal peaks must stand 8 dB above a local constant-Q floor, so dense hats raise their own floor.
    - A harmonic sieve credits each peak to the lower note whose partial series it continues: h − 1 or h − 2 seen,
      no louder than that partial scaled by j/h, within 20 + h cents, and even partials ≥ 4 only on series that have
      even partials. So a detuned saw or square stack counts once, at its fundamental, while a chord tone survives.
    - Notes are weighted by linear amplitude, including their partials.
  - Bass (< C3) and treble chroma are each normalised over the file and then combined, with the bass at 0.6. A loud
    808 can't drown the harmony, and the roots still count.
  - Correlated with the Krumhansl–Kessler profiles after a tuning estimate. `null` when the best correlation is
    below 0.65, when the chroma is flat (top-7 vs bottom-5 pitch classes < 1.8, e.g. drums alone), or when fewer
    than 3 pitch classes carry weight. `confidence` drops when a non-relative key fits almost as well.
  - **Re-ranked by the chords** when keys nearly tie.
    - Profiles see pitch content only. Keys that share a scale (Bb dorian, F aeolian, Ab major) tie or flip on
      register and timbre. A pitched kick that doesn't move with the song is enough: the demo transposed up 5
      semitones read Fm 0.68 against Bbm 0.57.
    - So the candidates within 0.15 of the best fit (at most 4) are re-ranked with key-neutral chords: the chord
      stage run without its key bonus, so it can't just confirm the first guess.
    - Each candidate's score adds up:
      - 0.5 × its profile fit;
      - 0.5 × the mean log "how usual is this chord in this key" weight over the chord time (a harmonic-function
        prior: tonic 1, then V / IV / vi … in major and VI / VII / iv / v … in minor, bII 0.15, foreign chords
        0.08);
      - 0.15 × the share of chord changes that are dominant → tonic (V–I, v–i), where one change in four counts
        fully;
      - 0.05 when the first confident chord is its tonic chord;
      - 0.1 × the bass share on its tonic.
    - It applies only with at least 8 s and 3 spans of chords at a mean confidence of 0.3 or more.
    - A key chosen over the profile's first choice reports confidence × 0.8, scaled again by its margin, and
      `sources` says so.
    - Results:
      - The transposed demo (Bbm9 – Gbmaj7 – Abmaj9 – Fm7 at 142 BPM) now reads Bbm 0.41.
      - The synthetic loop at −3 semitones moves from Am to Dm.
      - Neon Fog (Fm 0.89) and its stems are unchanged.
    - About 2 ms per file, chords included.
  - Names follow key signatures (`F#m`, `Eb`, `Db`, `G#m`, `Bbm`) and parse with `parseKey`.
  - Known limit: a loud bass with strong upper partials can absorb quiet chord tones that sit exactly on its series
    (the 5th / 9th at 3·F, 6·F, 9·F). Progressions that are near-ties between two keys on pitch content alone, like
    i–VI–VII–v, can then flip.
  - `KRYPT_KEY_DEBUG=1` prints the chroma, the top keys and the re-ranking evidence per candidate to stderr.
- **Pitch profile** (`pitchProfile`, every call): the whole-file key chroma (bass and treble balanced, as the key
  reads it) as 12 shares C..B summing to 1, rounded to 0.001; absent when the file is silent.
  - Auto Mashup compares the vocal stem's profile with the instrumental's (bass + other stems), shifted −6..+6
    semitones: what the vocal actually sings against what the beat actually plays, instead of two key labels.
- **Chords** (`chords`, every call). Code: `chords.rs`.
  - **Grid.** The beats, with gaps and the file's ends filled at the beat period. Without a beat, a 0.5 s grid.
  - **Per segment**, from the key chroma's notes (partials already credited to their fundamentals):
    - the treble chroma (notes from C3 up): which pitch classes sound;
    - bass evidence: the bass register below C3, with percussive smear removed. When a frame's two strongest bass
      pitch classes are a semitone apart and alike in strength, that is a kick's pitch sweep, so both are dropped.
      Each pitch class's median over the bass-active segments is also removed: a kick or a drone that plays
      throughout is not a bass line. Where the bass register is quiet, the lowest treble note (the harmony's own
      bass voice) stands in.
  - **Templates.** maj, min, 7, maj7, m7, dim, sus4, sus2 and the bare fifth (`5`), in all 12 roots.
    - The score is the cosine between the treble chroma and the template, plus 0.5 × the bass term. The bass term
      is 1 for the bass on the root and 0.4 for the bass on another chord tone (an inversion).
    - So the bass decides between chords that share most notes: Fm7 or Abmaj7 under Fm9, Ebmaj7 or Gm7 under Ebmaj9.
    - Small priors favour triads, and chords whose triad is diatonic in the detected key get +0.04. The key's scale
      is major plus its ♭7, or natural minor plus its raised 7th.
  - **Smoothing.** Viterbi over the segments. A chord change costs 0.8 nats on a downbeat, 1.6 on the half bar
    and 2.6 on other beats (scores × 12 per beat), so melody notes don't make chords flicker.
  - **Spans.** Equal neighbours merge. `quality` is `maj`, `min`, `7`, `maj7`, `m7`, `dim`, `sus` (sus4 or sus2,
    with the root from the bass) or `5`. Extended chords read as their closest 7th: a 9th as m7 or maj7.
  - **What is left out.**
    - Stretches that aren't harmony: treble energy under 3 % of the file's 75th-percentile segment, no template
      fitting at 0.6 or better, or tonality under 0.15 (the share of the 220 Hz–5 kHz harmonic spectrum that sits
      in tonal peaks; noise reads about 0, pads 0.8 or more).
    - Whole files: no chords without a key (a drum stem's pitched kick and tuned rolls pass the chroma tests but
      not the profile fit), or when the treble holds under 15 % of the note energy (a bass line alone; music
      measured 29 % and up).
  - **`confidence`** is the mean over the span of √(posterior of the chosen chord among all 108) × the template fit.
  - **Accuracy**, time-weighted, root correct:
    - Synthetic detuned-saw pads with a sub-octave square, with and without drums, detuned up to ±20 cents:
      - the i9–VImaj7–VIImaj9–v7 loop: 0.93–0.98;
      - I–vi–IV–V triads with a square bass and drums: 1.00, also from an AAC (.m4a) copy;
      - ii7–V7–Imaj7–VI7 without a beat: 1.00;
      - two chords per bar: 0.99.
    - The exact quality is right wherever the root is, except one F bar of the I–vi–IV–V test read as Fmaj7 (0.91).
    - The demo "Neon Fog": 0.83 with DSP beats and 0.81 with the beat model, the 7th qualities (m7 / maj7) right
      wherever the root is. 28 of 32 bars read Fm7 – Dbmaj7 – Ebmaj7 – Cm7 (27 with the beat model). The misses are:
      - two bars under the master filter sweep of the build;
      - two Ebmaj9 bars under the 808, read as Gm7 (its upper four notes): a kick on G/Ab masks the Eb and absorbs
        the pad's Eb3 as its 3rd partial;
      - the last bar, inside the master fade, with the beat model.
  - **Known limits.**
    - The 1.5 s low window smears bass notes across fast changes (≥ 2 per bar).
    - A loud kick can still hide a quiet bass.
    - Heavily filtered or distorted material reads the partials the filter leaves.
  - **Diagnostics.** `KRYPT_CHORD_DEBUG=1` prints every segment's reading, its bass evidence and the top three
    candidates to stderr.
- **Drum hits** (`drumHits`, only with `drums: true`).
  - The same algorithm and defaults as `transcribe` mode `drums` (hit sensitivity 0.3), run on the analysis mono mix
    on its own thread, so the cost hides behind the DSP front end.
  - The result is identical to a `transcribe` 'drums' call on the same file.
  - Roles are best on a drum stem. On a full mix, 808 / bass attacks can add kicks.
- **Swing.** Beat-synchronous onset profile (broadband plus > 5 kHz). It measures how late the odd 16ths sit
  relative to the even ones, expressed on the transport scale (odd 16ths late by `swing × half a 16th`: 0
  straight, ≈0.67 triplet feel, 1 maximum). `null` without beats, when the off-beat 16ths are empty, or when hits sit
  on a 32nd grid (hat rolls, or 16ths under a half-time reading), where straight 32nds would read as swing. The
  resolution is about ±0.05: the demo's transport swing of 0.08 reads 0.09 at its 140 BPM reading.
- **Sections.** Beat-synchronous chroma + timbre (log-band) features → self-similarity → Foote novelty (≈4-bar
  kernel, ≥ 4 bars apart) → boundaries snapped to downbeats. Labels: a section reuses an earlier letter when its
  similarity to it is ≥ 93 % of their self-similarity. Files under 20 s are a single `A`. With no beats, a 0.5 s grid
  is used.
- **Progress:** `decoding` (-1), then `analyzing` 0..1. With the beat model the fraction follows the model's chunks.
- **Speed** (release, i7-10700K): a 3-minute stereo 44.1 kHz file takes 1.2 s DSP-only and 5.1 s with the beat model
  (the model runs at about 1.6 s per minute of audio on rten, in parallel with the DSP). Chords add about 1 ms.
  `drums: true` runs in parallel with the DSP front end. `KRYPT_ANALYZER_TIMING=1` prints stage timings to stderr.

## Transcription

Code: `engine/crates/analyzer/src/{transcribe,basic_pitch,pitch,drums}.rs`. Input is decoded, mixed to mono and
resampled to 22 050 Hz. `minKey`/`maxKey` (inclusive) filter the result; they never narrow the pitch search, so an
out-of-range note is dropped, not folded into range.

| Mode | Method | `onsetThreshold` (default) | `frameThreshold` (default) | Speed (3 min, release) |
|---|---|---|---|---|
| `poly` | Basic Pitch `nmp.onnx` on rten. 2 s windows, 30-frame overlap, as in the Apache-2.0 reference; note creation is ported from it (onsets + frames + melodia trick). `cents` = mean contour offset from the key's centre bin. | onset activation (0.5) | frame activation (0.3) | 3.3 s (55× real time) |
| `mono` | pYIN-style: YIN thresholds with a Beta(2,18) prior, sparse Viterbi over candidates + unvoiced. Notes split at pitch changes (> 0.7 semitone) and at loudness re-attacks; boundaries next to silence are refined on a 2.9 ms energy envelope. `cents` = mean deviation. | re-attack sensitivity (0.5; 3 + 9 × t dB) | voicing probability (0.3) | 0.5 s (390×) |
| `drums` | Onsets from broadband flux, > 5 kHz flux and region rises (low / body / crack / air). The roles come from where the energy rise sits: kick (low ≥ 30 %), hat/open hat (air ≥ 50 %; open when it rings > 120 ms), snare (body + crack that keeps ringing), perc (a dry crack-led click such as a rim, or other). Coinciding kick+hat and kick+snare give two hits. Hats under louder hits are continued from the hat stream (see below). `vel` = √(rise / role max). | hit sensitivity (0.3) | — | 0.15 s |

- `minNoteMs` defaults to 60 ms. In `poly` it is rounded to model frames (11.6 ms), as in the reference.
- **Bass (`mono`, Wave 8a).** The pitch search reaches down to 26 Hz, so 808s and sub-bass down to A0 (27.5 Hz) are found. Re-attacks are measured on a peak-hold of the 2.9 ms envelope over 1.25 periods of the note's pitch: a low note with a weak or missing fundamental swings > 10 dB every cycle, and used to be chopped into fragments that were then dropped. No octave-error guard was added: on synthetic 808 / weak-fundamental / missing-fundamental / square bass lines (A0..E2) the pYIN path already returns the right octave.
- **Low lines (`mono`, `lowline.rs`).** When the pYIN notes' duration-weighted median key is G3 or lower, the notes come from a second reader built for fast bass lines. pYIN's 93 ms window hears two notes around every change of a fast line, goes unvoiced and leaves a 40-90 ms hole on each side; on a real HT-Demucs bass stem only 58% of the sounding time was covered. The low-line reader takes the dominant partial 25..400 Hz every 10 ms (186 ms spectrum, sub-octave check at 30%), with the octave from pYIN wherever pYIN has a confident reading of the same pitch class. It takes the level as RMS over max(10 ms, 2.5 periods of the partial), and counts a frame as sounding only if a 5 ms envelope is up within ±10 ms. Notes split where the partial moves > 0.7 semitone for 30 ms (an octave-only move must be confirmed by pYIN within 150 ms, else it is the peak flickering onto a harmonic) or at re-attacks. Fragments shorter than the minimum note join their touching neighbour instead of being dropped. Edges next to silence snap to a 5 ms envelope crossing of the note level − 15 dB. On the same stem: 98% covered, and replaying each note's own audio matches the stem on 98% of frames.
- **Drums (Wave 8a recall fix).**
  - A region's rise counts only when it is an attack in dB over the level just before the onset (low ≥ 6 dB, body
    ≥ 3, crack / air ≥ 2). A kick or 808 that still rings swells by a dB or two under the next hat; measured as a
    linear increase, that swell outweighed the hat, and a 16th hat after a kick came out as a kick.
  - A kick over a still-ringing kick or 808 is found from its body attack (the low band hardly rises).
  - Snare or clap on a kick: the crack band (0.8–5 kHz) rises past the kick's own click (1.3 × the track's
    low-quartile crack / low ratio for kicks) and still holds its rise 35–58 ms later (≥ −10 dB). A crack-led hit
    whose rise is gone by then (< −14 dB) is a rim or stick: perc. A clap's later bursts (< 50 ms, < 6.5 dB) are the
    same hit.
  - Hats under louder hits. A kick, clap or snare masks a hat on it (its own click and noise are as loud as the hat,
    and a bus limiter ducks the hat), so the measured rise can't show it. Between two detected hats, a hat grid is
    walked across the gap: the local hat period (the most common interval between hats within 3 s, counting
    intervals that skip one hat), else the three hats on one side when the hats go on past the other side. Each
    step repeats the interval from two steps back (straight and swung streams both continue). The gap is filled
    only when every step lands on an onset with some air-band rise (≥ 10 % of a typical hat's); a step with no
    onset is a break and adds nothing. Hats only on the offbeats stay on the offbeats.
  - Onsets also come from the > 5 kHz band flux (a closed hat that chokes an open hat or lands in a crash's ring
    barely moves the summed power), and the broadband flux floor is 2.2 (× the sensitivity scale) so the strokes of
    a dense snare roll count. Clear attacks (≥ 15 dB) in quiet passages count down to −50 dB under the loudest hit.
  - Measured (±50 ms, per role F1 / P / R). Neon Fog HT-Demucs drum stem: kick 0.88 → 1.00 (P 0.78 → 1.00), snare
    or clap 0.66 → 0.84 (R 0.59 → 0.72), hats 0.69 → 0.92 (R 0.53 → 0.87, P 1.00 → 0.99). Engine renders of the
    same kit (house 124, boom-bap 90, offbeat-hat and hat-gap grooves): drums-only hats 0.36–0.99 → 0.63–1.00,
    full mixes kick 0.39–0.63 → 0.77–0.92, snare 0.08–0.75 → 0.81–1.00, hats 0.16–0.58 → 0.61–1.00.
- **Known limits.** Basic Pitch can add quiet notes on strong upper partials, like octaves or twelfths. Drums work
  best on a drum stem. A hat under a snare or kick is inferred, not heard: where only every other hat is visible
  (offbeat hats, quarter-note hats between snares) none is added, and a hat on a hit off that stream (a roll stroke
  under a kick) is missed. A closed hat that chokes an open hat at the same level stays inaudible. On a full mix,
  808 / bass attacks can still add kicks.
- **Errors.** `poly` with no `modelDir`: "Polyphonic transcription needs the Basic Pitch model, but no model
  directory was given". With a missing file: "Basic Pitch model not found in <dir> (nmp.onnx)". A threshold outside
  0..1 or a bad key range is rejected by name.

## Sound fingerprints

Code: `engine/crates/analyzer/src/fingerprint.rs` (Wave 8a, research/15 §3.1). The type is `SoundFingerprint` in
`shared/sound-match/types.ts`; match-core compares fingerprints with each other, never with the engine's `Analysis`.

- **Input.** The file is decoded once (any format the decoder reads, Media Foundation ones included) at its own
  rate; every segment is a slice of it. Segments are clipped to the audio (a negative start becomes 0). A segment
  that is empty after clipping (past the end, `endSec ≤ startSec`) or silent gives a zeroed fingerprint:
  `lengthSec` 0, `peakDb`/`rmsDb` -120, `f0Hz` null, everything else 0. A non-finite time fails the job ("Segment
  3 has an invalid time …"); at most 200 000 segments.
- **Trim.** Leading and trailing samples below -60 dBFS (either channel) are dropped. A sound whose peak is below
  -20 dBFS trims 40 dB under its own peak instead, so quiet stems still measure. `lengthSec` is what remains.
- **Fields, as built:**

  | Field | Definition |
  |---|---|
  | `peakDb`, `rmsDb` | Sample peak and RMS of both channels (a full-scale sine is -3 dB RMS), floor -120. |
  | `crestDb` | `peakDb − rmsDb`. |
  | `width` | Side energy / mid energy, clamped to 0..1 (L/R uncorrelated ≈ 1, out of phase = 1). 0 for mono and dual-mono files. |
  | `attackMs` | Start → the first 5 ms RMS window (1 ms hop) within 1 dB of the loudest window. |
  | `decayMs` | On a 20 ms centred RMS envelope: from its peak (first window within 1 dB of the max) to the first window 20 dB under the max. A sound that never falls 20 dB reports the time to its end. Capped at `lengthSec`. |
  | `sustain` | Mean of the 20 ms envelope over the second half ÷ its max, 0..1. |
  | `centroidHz` | Power-weighted centroid of the summed power spectrum, 20 Hz..20 kHz. Hann STFT, ≈85 ms frames (4096 at 44.1/48 kHz), 50 % overlap. Power-weighted reads lower than the engine's magnitude-weighted `spectralCentroidHz`. |
  | `rolloffHz` | Where 85 % of that summed power lies below. |
  | `flatness` | Per frame, the geometric ÷ arithmetic mean of the power spectrum over 20 Hz..16 kHz, multiplied by e^γ (≈1.78) so white noise reads ≈ 1 (a single periodogram's raw ratio for noise is e^−γ); clamped to 1; energy-weighted over the frames. A sine reads ≈ 0. |
  | `bands` | Summed power in the engine's `Analysis` band edges (sub 20-60, low 60-250, lowMid 250-500, mid 500-2k, highMid 2k-6k, high 6k-20k) in dB relative to the loudest band (that one is 0), floor -90. |
  | `harmonicity` | YIN on the steady part (5 ms after the attack → the last 20 ms window above -20 dB; at most the middle 12 s), decimated to ≈11-12 kHz, lags for 27.5 Hz..2 kHz, up to 16 frames. Per frame 1 − the CMNDF value at the chosen lag (first dip under 0.15, else the global minimum), energy-weighted. Sine ≈ 1, white noise ≈ 0.15. |
  | `f0Hz` | Energy-weighted median of the frames whose CMNDF dip is < 0.3, only when `harmonicity ≥ 0.4` and `pitch` isn't false; else null. Chords report their common periodicity (A minor triad → ≈55 Hz), not a note. |

- **Progress:** `fingerprinting` 0..1, for 32 segments or more (about 100 events). Cancel is checked every 16
  segments.
- **Speed:** about 1.3 ms per 0.5 s stereo segment at 48 kHz (release), decode not included.

## Stem separation

`separate` runs HT-Demucs v4 through ONNX Runtime. Code: `engine/crates/analyzer/src/separate/`. Model and DLL
provenance: `scripts/models/README.md`.

- **Model `htdemucs`.** Meta's Hybrid Transformer Demucs v4 (MIT code and weights), as the forward-only ONNX export
  that the WebNN project publishes (`webnn/stem-separator`, MIT, pinned revision). `modelDir` holds two files:
  - `htdemucs_fwd.onnx`: the graph, 2.4 MB.
  - `htdemucs_fwd.onnx.data`: fp32 weights, 168 MB.

  The graph refers to the weights by file name, so both names must stay as they are. URLs and SHA-256 hashes are in
  `shared/analyzer/models.ts`.
- **Pipeline.**
  - Decode, make stereo (mono is duplicated), and resample to 44.1 kHz with rubato's FFT resampler,
    delay-compensated.
  - Normalise by the mono mix's mean and std, as demucs `separate.py` does.
  - Split into 7.8 s segments (343,980 samples) with 25 % overlap and demucs' triangular transition weights. There are
    no random time shifts, so the output is deterministic.
  - Run the STFT/iSTFT in Rust around the graph (n_fft 4096, hop 1024). It matches `torch.stft` within 1e-4.
  - De-normalise, resample back, and write the stems.
  - Against the PyTorch reference (demucs 4.0.1, `--shifts 0`), each stem agrees to 84–97 dB on CPU and 96–128 dB on DirectML. Check it with
    `scripts/models/htdemucs_parity.py`.
- **Output.** `drums`, `bass`, `other`, `vocals`, in that order. Each is 32-bit float stereo at the source rate, with
  exactly the source's length in frames. Files are written as `<stem>.wav.partial` and renamed only when all four are
  done. A cancel or failure removes everything the job wrote.
- **Progress.**
  - `decoding` (-1).
  - `separating`: -1 while the model loads, then 0..1, one step per segment.
  - `writing` (-1).
  - A final `info` log gives the time split (model load, inference, STFT, iSTFT).
- **Devices.**
  - `auto` uses DirectML when it initialises. Otherwise it logs `warn` "DirectML failed to initialise (…); using the
    CPU" and runs on the CPU. If DirectML fails mid-job, the job continues on the CPU, also with a `warn` log.
    `StemsResult.device` names the device that finished the job.
  - `directml` fails if DirectML is unavailable: "DirectML is not available (…). Choose CPU or Auto for stem
    separation."
  - `cpu` always uses the CPU.
  - `hello.devices` lists `directml` only when `DirectML.dll` is installed and a DirectML GPU device can be created.
    The probe runs once per process, on the first `hello`, and takes about 0.25 s.
- **Cancel.** It is checked between segments. A segment that is running is aborted through ONNX Runtime's
  terminate flag, so a job stops within about 0.5 s.
- **Speed and memory.** Release build on an i7-10700K (8 cores) and an RTX 3080 (10 GB). Memory does not grow with
  song length beyond the decoded audio.

  | Device | Per minute of audio | 6-minute song | Peak RAM |
  |---|---|---|---|
  | DirectML | ~6–7 s, including ~1 s to load the model | 37–40 s | 0.8 GB |
  | CPU | ~26 s | 156 s | 2.6 GB |

  ONNX Runtime's CPU memory arena is disabled. With it, peak RAM was 4.8 GB for about 10 % more speed.
- **Runtime DLLs.** They sit next to the exe. `scripts/models/onnxruntime.mjs` stages them, called from
  `scripts/engine-build.mjs`. The installer must ship `resources/bin/*.dll` and the licence `.txt` files beside them.

  | DLL | Source | Licence |
  |---|---|---|
  | `onnxruntime.dll` | NuGet Microsoft.ML.OnnxRuntime.DirectML 1.24.4 (the last DirectML build) | MIT |
  | `DirectML.dll` | NuGet Microsoft.AI.DirectML 1.15.4 | Microsoft licence, redistributable with an app. Optional. |
  | `vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll`, `msvcp140_1.dll` | VC++ redist from Visual Studio / Build Tools | Microsoft VC++ redistributable |

  - The analyzer opens `onnxruntime.dll` at run time and never links it (`ort` with `load-dynamic`, C API 24). When the
    DLL is missing, the analyzer still starts and only `separate` fails: "Stem separation is unavailable: ONNX Runtime
    is missing (… not found)…".
  - Without `DirectML.dll`, only the CPU is offered.
  - `ORT_DYLIB_PATH` names the DLL when none sits next to the exe, for dev and tests. A shipped copy always wins. The
    DLLs beside it are pre-loaded by absolute path, so the older inbox `System32\DirectML.dll` is never used.
  - ONNX Runtime warnings go to stderr.
- **DirectML workarounds.** Both are applied at load time, so the downloaded file stays byte-identical.
  - The exporter wrote `output_padding=[0]` on 1-D `ConvTranspose` nodes. DirectML rejects that ("The parameter is
    incorrect"), so the analyzer strips the attribute. Zero is the default, so the maths does not change.
  - DirectML's graph fusion miscomputes this graph, so it is disabled (`ep.dml.disable_graph_fusion`).

## Text to speech

`tts` is Krypt Voice's local engine (research/21): Kokoro-82M through ONNX Runtime. Code:
`engine/crates/analyzer/src/tts/`. Model provenance: `scripts/models/README.md`.

- **Model `kokoro`.** Kokoro-82M v1.0 (hexgrad, Apache-2.0 weights and voices) as the ONNX export that
  onnx-community publishes (Apache-2.0, pinned revision). `modelDir` holds `model.onnx` (fp32, 326 MB) and one
  `<voice>.bin` per voice (510 × 256 float32 style rows, 0.5 MB each), all flat. The analyzer also accepts
  `model_quantized.onnx` and `voices/<voice>.bin` (a copy of the Hugging Face repo), for development.
- **Voices.** The 28 English voices: `af_heart` (the best), `af_bella`, `af_nicole`, `af_aoede`, `af_kore`,
  `af_sarah`, `af_alloy`, `af_nova`, `af_sky`, `af_jessica`, `af_river`, `am_michael`, `am_fenrir`, `am_puck`,
  `am_echo`, `am_eric`, `am_liam`, `am_onyx`, `am_adam`, `am_santa` (US), and `bf_emma`, `bf_isabella`, `bf_alice`,
  `bf_lily`, `bm_george`, `bm_fable`, `bm_lewis`, `bm_daniel` (UK; they get the US pronunciation). `KOKORO_VOICES`
  in `shared/analyzer/models.ts` lists them with names. A `local:` prefix on the id is accepted.
- **G2P (text → phonemes), English, no GPL code (no eSpeak).** `g2p.rs`:
  - Text normalisation: sentences (split at `. ! ? …` and line breaks, not after abbreviations or initials); numbers,
    years ("1999" → nineteen ninety-nine), ordinals, decimals, money (`$5.50`), percentages, `&`, and common
    abbreviations (Dr., Mr., feat.) become words. Hyphenated words and letter/digit mixes ("4ever") are split.
  - Each word: a short table of unstressed function words ("the" → ðə, or ði before a vowel), then the **CMU
    Pronouncing Dictionary** (126k words, BSD-style licence, compiled into the exe), then suffix rules against the
    dictionary (plurals, -ed, -ing, -er, -ly, dropped g "vibin'", un-/re- prefixes) and two-word compounds
    ("beatmaker"), spelled-out acronyms ("DJ"), and finally letter-to-sound rules (`lts.rs`) for unknown words.
  - ARPAbet → Kokoro's US phoneme set (hexgrad/misaki): diphthongs as `A I O W Y`, `ɜɹ`/`əɹ` for ER, the US flap
    `ɾ` ("water"), stress marks `ˈ ˌ` before the vowel.
  - With `phonemes`, the caller's Kokoro phoneme string is used as is (any installed voice); the G2P is skipped.
- **Inference.** One run per sentence (sentences over 400 tokens split at punctuation, else at a space); each is
  padded with token 0 at both ends and uses the voice's style row for its token count. `speed` 0.5..2 goes to the
  model. Silence at the edges of each sentence is trimmed (30 ms kept); sentences join with 0.22 s pauses (0.12 s
  after a clause split). The result is scaled down only if it would clip. Deterministic.
- **Word timings.** The export has only a `waveform` output. At load time the analyzer appends a graph output for
  the predicted per-token durations (the graph's only `Round` → `Clip`), in memory, so the downloaded file stays
  byte-identical. One duration frame is exactly 600 samples (25 ms at 24 kHz). `words` lists every input word as
  written (e.g. "$5.50") with its start and end in the output; it is empty for a model without that tensor.
- **Device.** CPU only: ONNX Runtime 1.24's DirectML EP rejects Kokoro's grouped upsampling `ConvTranspose`
  ("The parameter is incorrect"). The model loads once per process (~1.2 s) and is reused while the file is
  unchanged.
- **Speed.** fp32 on an i7-10700K: ~0.37 × real time (a 4 s line in ~1.5 s), plus the first load. The int8 export
  is 3× slower on the CPU.
- **Errors.**
  - "The local engine speaks English only, and 'jf_alpha' is not an English voice. Pick an English voice (af_…,
    am_…, bf_…, bm_…) or use the Fish engine (Cloud) for other languages."
  - "Kokoro is not installed in … (no model file). Install "Kokoro (Krypt Voice)" from the Model Manager."
  - "The voice 'x' is not installed with Kokoro (no x.bin in …). Reinstall Kokoro from the Model Manager."
  - "Nothing to say: the text is empty" or "… has no words Krypt Voice can pronounce"; "Speed 3 is out of range
    (0.5 to 2)"; "'…' is not a Kokoro voice id (e.g. af_heart)"; "Krypt Voice (local) is unavailable: ONNX
    Runtime is missing …".
- **Progress:** `phonemes` (-1), `speaking` 0..1 per sentence, `writing` (-1). A final `info` log gives the
  load / inference split.

## Syllables

`syllables` finds syllable nuclei in speech, so lyrics can be mapped onto notes. Code:
`engine/crates/analyzer/src/syllables.rs`.

- Per 5 ms frame: energy in 250 Hz–4 kHz (25 ms window) and YIN voicing (30 ms window on a 12 kHz copy, 60–700 Hz).
  Nucleus strength = energy × (0.25 + 0.75 × periodicity), smoothed over ±20 ms.
- Nuclei are strength peaks at least 70 ms apart. With `expected`, the `expected` most prominent peaks are kept;
  when fewer are found, the longest syllables are split in half until the count matches (`syllables.length ==
  expected` unless the audio is silent). Without it, peaks that stand at least 12 % above their valleys are kept.
- Boundaries are at the strength minimum between two nuclei. A pause (≥ 120 ms, 40 dB under the loudest frame)
  ends one syllable, and the next starts after it. The first starts at the speech onset, the last ends at the
  offset. `voiced` = at least a third of its frames are periodic.
- `expected` above 2000 is an error. Silent audio gives `[]`.

## Sing

`sing` renders speech onto a melody ("Sing my notes"). Code: `engine/crates/analyzer/src/sing.rs`, with
`krypt-studio-stretch` (Signalsmith Stretch, `stretch_mapped_curve`).

- **Per segment** (`[srcStartSec, srcEndSec)` of `path` → `durSec` at `outStartSec`, key `midi`):
  1. f0: YIN every 10 ms over the segment, then the median over the voiced frames. Fewer than 3 voiced frames →
     `f0Hz: null`: the segment is stretched but never pitched (`shiftSt` 0).
  2. Time: stretched to `durSec` with formants kept (Tones profile). When the note is longer than the syllable,
     the consonants around the voiced part keep their speed and the vowel takes the stretch (up to 8×; beyond
     that the consonants stretch too). Shortening is uniform.
  3. Pitch, as a curve the stretcher follows every ~12 ms: `shiftSt` = 12 × log2(key Hz / f0), minus the
     speech's own smoothed pitch contour (so a gliding spoken syllable becomes a level note on its key), plus
     a glide into the note (`glideMs`, from the previous note when that one is voiced and ends < 60 ms before;
     raised-cosine, at most half the note) and vibrato (`vibrato` 0..1 → ±0–50 cents at 5.5 Hz, starting after
     35 % of the note but at least 0.12 s in, and fading in over 0.25 s).
  4. 8 ms equal-power crossfades centred on the note's start and end. Each note is rendered with 40 ms of source
     pre-roll (dropped) and 4 ms past its end, so touching notes join without gaps or clicks.
- **Mix.** Notes are summed in place; gaps are silence. The output lasts until the last note's end + 4 ms and is
  scaled so its peak is −1 dBFS (gain at most +12 dB). Deterministic.
- **Limits.** At most 5000 segments and 1800 s of output. Times must be finite, `srcEndSec > srcStartSec`,
  `durSec > 0`, `outStartSec ≥ 0`, `midi` 0..127 (errors name the segment: "Segment 3: …"). A segment past the
  end of the file is a rest.
- **Accuracy.** On a steady synthetic voice, notes land within ±20 cents and start / end within ±5 ms of
  `outStartSec` / `+durSec` (tests). On real speech a note's median is typically within ~25 cents (up to ~70 on
  creaky phrase ends); Krypt Tune runs on the result.
- **Speed.** ~15 ms per second of output (test build), decode not included.
- **Progress:** `decoding` (-1), `singing` 0..1 per segment, `writing` (-1).

## How main uses it

- **Model directories:**
  - Bundled models live in `resources/models/<id>/`; in dev, the repo's `resources/models/<id>/`.
  - Downloads live in `userData/models/<id>/`. A download goes to `<id>.partial/` and is renamed only after every
    file's SHA-256 matches.
- **Caches:**
  - Analyses: `userData/analysis/<sampleHash>.json`.
  - Stems: `userData/stems/<sampleHash>-<model>/`.
  - A cache hit skips the analyzer entirely.
- **Results enter the project as ordinary commands** (one undo group per user action or MCP call):
  - **Stems** become new samples (`SampleRef.origin = {kind:'stem', parentSampleId, stem, model}`). Each gets an
    audio-clip channel that copies the source channel's generator params (so stretch, pitch and tempo-sync play
    identically), and a playlist track under the source clip's track with a clip aligned to the source clip.
  - **Transcriptions** become a new pattern. Seconds become ticks through the source clip's effective tempo, which
    is `src_bpm` when the clip is tempo-synced, else the project tempo.
  - **Drum roles** map to channels named Kick, Snare, Hat, Open Hat and Perc. These are created from the factory
    kit when missing.
