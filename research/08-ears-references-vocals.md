# 08 — Wave 3 design: ears, reference memory, vocals

Status: **proposal**, written 2026-10-11 from the user's product direction. That direction: make reference-based
learning, genre/style focus, AI vocals and stem separation headline features. It builds on the licence tables
in **04 §9**, which were checked on the same day. That report is the source for every "Ship / Optional / Avoid"
verdict below. Nothing here has been built yet.

---

## 0. TL;DR

1. **Reference memory, not model training.** Krypt analyses audio that the user supplies, stores *derived
   features* in a local database, and hands the agent grounded statistics and examples. No generative model is
   trained on anyone's library, and none needs to be.
2. **Stems and transcription are the foundation, not a side feature.** Studying a reference means separating it
   first: drums come from the drum stem, the 808 from the bass stem, the topline from the vocal stem. So Wave 3
   starts with **Ears**: the analyzer sidecar, the model manager, stems, audio→MIDI and time-stretch.
3. **"Genre focus" lives in the harness as a *style profile*.** A profile aggregates statistics over a tagged
   collection: tempo, swing, per-step drum probabilities, 808 behaviour, harmony, structure and mix targets. The
   agent reads a profile, composes something original in KPN, and an **originality check** flags melodies that
   sit too close to a reference.
4. **The vocals have three tiers of difficulty.**
   - **Recording and correction** can be built now with permissive pieces only.
   - **AI singing** gets a full vocal editor plus a *voice provider* interface, but **we can't ship a default
     voice we don't own**. Users import voicebanks; a Krypt voice of our own would have to be commissioned.
   - **Voice conversion** is deferred, and is limited to the user's own voice or a voice they have licensed.
5. **All ML runs in a new out-of-process `krypt-studio-analyzer.exe`.** It is never in the Electron main process
   and never in the audio engine, for the same reason as the plugin host: a 1 GB model or a GPU-driver crash must
   not stop playback.

---

## 1. Principles

| Rule | What it means in practice |
|---|---|
| User-supplied audio only | Krypt never downloads songs and never ships a reference library. The UI asks users to import material they own or that is licensed, public-domain or Creative Commons; it does not police them. We can ship a small demo collection made from our own factory content. |
| Store features, not audio | The library keeps a path and a content hash for each source file, plus the analysis: features, transcribed MIDI and stem *file paths* (stems are cached under userData and can be purged). Deleting a source removes its record. |
| Estimates are labelled | Every ML-derived value carries a confidence. MCP tool output says "estimated" wherever §2.3 says so, so the agent knows when to trust its ears and when to check by listening (`render_preview`). |
| Licences per 04 §9 | Bundle only *Ship* models. *Optional* models arrive through the model manager, which shows the licence and verifies a SHA-256. Never bundle voicebanks or weights of unknown provenance. Never link GPL code: eSpeak NG, aubio, Essentia and friends are out. |
| Voice likeness | No cloning of real people. Conversion targets are the user's own voice or a voicebank whose terms allow it, with an explicit consent checkbox stored alongside the model. "Make it sound like <artist>" style requests are refused for **voices**; musical *style* is fine. |
| Not legal advice | The originality check is a production aid ("this hook matches bars 9–12 of X"). It does not certify that something is non-infringing, and the UI says so. |

---

## 2. Architecture

### 2.1 The analyzer sidecar

- **New crate** `engine/crates/analyzer` produces the binary `krypt-studio-analyzer.exe`.
  - It speaks NDJSON over stdio like the engine, supervised from `electron/analyzer/` with the same
    restart-and-report pattern.
  - It runs **jobs**, not requests: `{job, kind, input}` produces `progress`, `result` and `error` events.
    Jobs can be cancelled and are kept in a resumable queue on disk, because a 5,000-track import must survive
    an app restart.
- **Runtime:** `rten` for the tiny bundled models (Basic Pitch, Beat This! small) and `ort` + DirectML for the
  large optional ones (HTDemucs, RoFormer). DirectML runs on any DX12 GPU; WinML migration is tracked in 04 §9.1.
- **Why not inside the engine?** Three reasons:
  - Inference allocates freely and can take minutes; the audio thread must never wait on it.
  - ORT pulls in native DLLs and GPU drivers, which can crash. The engine only *plays* the results: stem WAVs,
    MIDI and stretched audio.
- **The analyzer owns the library database:** `userData/library/library.sqlite` via `rusqlite` with its bundled
  SQLite (public domain). Main queries it through the analyzer protocol, so there is exactly one writer.

### 2.2 Model manager

- Files live in `userData/models/<model-id>/`, alongside a `manifest.json`: url, sha256, size, licence text and
  link, task, and runtime (rten/ort).
- The UI panel lists installed and available models, shows each licence before download, and lets the user
  delete a model.
- Each task falls back gracefully when its model isn't installed. For example, `separate_stems` without a model
  fails visibly with "Install a stem model (Model Manager)". It never fails silently.
- An `htdemucs` download is roughly 80 MB; the full fine-tuned `htdemucs_ft` is four times that.

### 2.3 What can be measured vs estimated

| Tier | Features | Source |
|---|---|---|
| **Measured** (deterministic) | Loudness (LUFS, LRA, true peak), band balance, stereo width and correlation, crest factor, onset density, duration | Existing `dsp/analysis.rs` plus `ebur128` |
| **Estimated, good** | BPM, beat and downbeat grid, key, 4-stem separation, monophonic pitch (vocals, 808), polyphonic notes from a *clean stem* | stratum-dsp, Beat This!, HTDemucs, pyin, Basic Pitch |
| **Estimated, rough** | Chords (BTC export or chroma templates), section boundaries (self-similarity novelty, our own DSP), drum hits from the drum stem (band-split onsets, our own DSP, since ADTOF is non-commercial), swing amount | Mixed |
| **Not attempted** | "Instrument identity" labels, "mood" or "energy" as words. Energy is reported as numbers (loudness and onset-density curves); the agent can name it. | — |

---

## 3. Wave 3A — Ears

| Feature | Implementation | Models (04 §9 verdict) |
|---|---|---|
| Decode any audio | symphonia (already a dependency); add Media Foundation MP3/AAC later | — |
| `analyze_audio` | Tempo, beats, key, sections, loudness, spectrum, swing; returned as text plus JSON | stratum-dsp (Ship), Beat This! small (Ship) |
| Stem separation | Clip menu → "Separate stems" creates 4 audio clips on new tracks, routed to new mixer inserts. Stems are cached per source hash. | HTDemucs ONNX (Optional, default). MDX-Net as a light fallback, RoFormer for best vocals. |
| Audio → MIDI | Clip menu → "Convert to pattern". Polyphonic via Basic Pitch; monophonic lines via pyin; drums via band-split onsets → Kick/Snare/Hat channels | Basic Pitch (Ship), pyin (Ship) |
| Time-stretch and pitch | Audio clips follow the project tempo; per-clip semitone shift with formant preservation | signalsmith-stretch (MIT, C++ via the `signalsmith-stretch` or `ssstretch` crate; confirm formant API) |

**Compute reality.** The numbers are from 04 §9.3; library sizes are the user's example.

| Job | Per 3-min track | 5,000 tracks |
|---|---|---|
| Light pass (decode, BPM, key, beats, loudness, spectrum) | ~1 s (decode-bound; stratum-dsp alone is ~0.2 s) | ~1–2 h on CPU |
| Stems (HTDemucs) | ~63 s CPU / ~6 s GPU (DirectML) | ~3.5 days CPU / ~8 h GPU |
| Transcription of stems | Faster than real time | Hours |

So a library import runs the **light pass on everything**, and stems plus transcription run **on demand, or as
an opt-in "deep analysis" over a whole collection** that shows its time estimate up front.

---

## 4. Wave 3B — Reference memory and genre focus

### 4.1 Library and collections

- "Import folder" adds the tracks to a **collection** that the user names and tags (e.g. "Dark trap",
  "90s R&B").
- Each track record holds:
  - its source path and hash;
  - its light-pass features;
  - optionally, stem paths and transcriptions per stem (in KPN/MIDI);
  - chord estimates, section map and user tags.
- **Search:** filter by tempo, key, tags and features, plus nearest-neighbour over a normalised feature vector.
  Brute-force cosine is fine at 10k tracks, so no vector database is needed. LAION-CLAP audio embeddings are an
  optional later layer for "sounds like" text search; their weights are Apache-2.0 per 04 §9.7.

### 4.2 Style profiles

A **style profile** is computed by aggregating a collection; no training is involved. It contains:

- **Tempo and feel:** a BPM histogram, half-time likelihood, and the swing distribution.
- **Drums:** per-role step probabilities on a 16- or 32-step grid (kick, snare/clap, hat, open hat, perc),
  hat-roll frequency and rate (1/32, triplet), and velocity contours.
- **808 and bass:** note-length distribution, glide frequency, intervals relative to the key root, and
  rhythmic alignment with the kick.
- **Harmony:** mode distribution, chord-degree bigrams (relative, so transposition-free), and harmonic rhythm.
- **Structure:** the usual section sequence and lengths in bars, plus the energy curve across sections.
- **Mix targets:** LUFS, band balance and width percentiles.

The agent gets a profile as compact text plus **synthesised example grids**: patterns *sampled from the
probabilities*, never copied from one track. That is what "learn the typical drum arrangements" means
concretely, and the result is inspectable. The user can open a profile and see exactly what the AI is leaning on.

### 4.3 Focus in the harness

- **Agent panel:** a "Focus" picker selects a collection's style profile plus an optional user-written brief
  ("dark, sparse, lots of space"). The profile is injected into the agent's context, and the focus is recorded on
  what it writes as provenance.
- **MCP:**
  - prompt `focus` (argument: collection);
  - resource `krypt://styles/<id>`;
  - tool `get_style_profile`.
- External agents get exactly the same grounding as the built-in agent.

### 4.4 Originality check

- **What is compared:** the project's melodic lines (lead, vocal, 808 pitch sequence) against the transcriptions
  in the library, using transposition-invariant interval n-grams plus duration ratios.
- **When it flags:** when a run of ≥ N notes matches (default 8, tunable), it reports the reference track and
  bars.
- **Drums and chords are not flagged on their own.** They are genre conventions; a I–V–vi–IV progression is not
  a copy.
- **When it runs:** automatically on `commit_edit` whenever a focus is active, and on demand via
  `check_originality`.
- **Limits:** quality is bounded by transcription accuracy, so false negatives happen. The UI says it is an aid,
  not a guarantee.

---

## 5. Vocals

### 5.1 Wave 3C — Recording and correction (permissive only, buildable now)

- **Recording:** reuse Wave 2 recording. Takes stack per clip; the original take is always kept, and every edit
  below is a non-destructive edit list on the clip.
- **Pitch track and tuning editor:**
  - pyin gives the f0 curve, which is segmented into note blobs drawn over the waveform.
  - The user or agent can set the snap-to-scale amount, correction speed (retune), and drift and vibrato keep.
  - **Monophonic only.** Polyphonic note editing is covered by the Celemony patent until 2029 (synthesis,
    Phase 4).
- **Rendering:** signalsmith-stretch pitch shift with formant compensation, applied per blob with crossfades.
- **Timing:** align blob onsets to the grid or to a reference take (stretch).
- **Denoise:** DeepFilterNet (Rust `libDF`, MIT/Apache-2.0 per upstream; it was not in 04's tables, so verify the
  LICENSE files before shipping). It is trained on speech, so evaluate it on singing before making it a default.
- **Harmonies and doubles:**
  - Harmonies are pitch-shifted copies that follow the project key and chords. The project chords come from the
    notes symbolically, so they are exact.
  - Doubles use small detune and timing offsets.
  - Each harmony or double is its own clip, so it can be mixed separately.

### 5.2 Wave 3D — Vocal score editor and AI singing

- **Schema:** a `VocalPart` on a channel contains notes with:
  - a lyric syllable and phonemes (editable, auto-filled by G2P);
  - per-note expression: a pitch curve (portamento in/out), vibrato (depth/rate/onset), breathiness, tension
    and dynamics;
  - breath events between phrases.
- **KPN extension:** syllables attach to notes, e.g. `Vox: F4:2"I" G4:2"need" A4:4"you"~`. The agent writes
  lyrics and melody in one block; expression lanes use the existing `levels` machinery.
- **G2P:** CMUdict-based (BSD-style licence) English dictionary plus a rules fallback. **Not eSpeak NG**, which
  is GPL-3.0.
- **Voice provider interface:** `(score, voice, settings) → audio`, run in the analyzer.
  - **Provider 1 — DiffSinger voicebanks (ONNX).** Users import a voicebank they have obtained; Krypt shows its
    terms and never bundles one (04 §9.6). This gives note-exact control, which is exactly what this editor
    expresses. Quality depends on the voicebank, and English DiffSinger voicebanks are scarce. Each sets its own
    terms: some allow commercial songs but forbid redistribution.
  - **Provider 2 — ACE-Step 1.5 (MIT/MIT), to evaluate.** It generates expressive sung vocals from lyrics, and its
    multi-track ("add layer") mode may be able to sing over our instrumental. It is *not* note-exact and needs a
    GPU (acestep.cpp, Vulkan). The useful version would be "melody-guided" generation, which is unverified.
- **A default voice:** the only clean way to ship one is to **commission an original Krypt voice**. That means
  paying a singer under a written agreement covering consent, rights and permitted uses, recording a dataset,
  and training a DiffSinger voice. It is a budget and business decision, not an engineering one.

### 5.3 Later — Voice conversion

- **What:** convert a user's own performance into a target voice while keeping its melody, timing and
  expression.
- **Code:** RVC is MIT, but published weights are of unknown provenance and often imitate real people.
- **Scope, if built:** target voices are only the user's own (trained from their recordings) or a voicebank whose
  terms allow conversion, with a consent attestation. No bundled weights.
- **When:** after everything above.

---

## 6. Draft MCP surface

| Tool | Kind | Purpose |
|---|---|---|
| `analyze_audio` | read | Tempo, beats, key, sections, loudness and spectrum for an audio clip or file (estimates labelled) |
| `separate_stems` | write | Split an audio clip into stems on new tracks |
| `audio_to_pattern` | write | Transcribe a clip or stem into a pattern (polyphonic, monophonic or drums) |
| `stretch_clip` | write | Tempo-follow, stretch and pitch an audio clip |
| `library_import` / `library_status` | write / read | Queue a folder into a collection; read progress |
| `search_references` | read | Find tracks by features, tags or similarity |
| `read_reference` | read | One track's analysis, section map and stem transcriptions (KPN) |
| `get_style_profile` | read | A collection's aggregated profile plus sampled example grids |
| `check_originality` | read | Compare the project's melodic lines against the library |
| `tune_vocal` | write | Pitch/timing correction parameters on a vocal clip |
| `add_harmony` | write | Harmony or double clips that follow the key and chords |
| `write_vocal` | write | Lyrics, melody and expression for a `VocalPart` (KPN with syllables) |
| `render_vocal` | write | Render a `VocalPart` through an installed voice provider |
| `list_models` | read | Installed and available models and voices, with licences |

Plus the prompt `focus` and resources `krypt://styles/<id>` and `krypt://library/<collection>`.

---

## 7. Schema changes (each needs a migration and a test)

- **Audio clips:** `stretch {mode, ratio | followTempo}`, `pitch {semitones, formant}`, `source {kind: 'stem',
  parentHash, stem}`, and a `vocalEdits` list (blobs, correction, timing).
- **Channels:** a `VocalPart` (5.2) on a new `vocal` channel kind.
- **Patterns and clips:** an optional `provenance {focus?: collectionId, tool}` to support "what did the AI lean
  on".
- **Library data is not part of the project file.** Projects reference collections by id only, so a project can
  be shared without the library.

---

## 8. Order

1. **3A Ears:** analyzer sidecar, model manager, `analyze_audio`, stems, audio→pattern, time-stretch.
   Everything else depends on it.
2. **3B Reference memory:** library and collections, light and deep passes, style profiles, focus in the agent
   panel and MCP, originality check.
3. **3C Vocal recording and correction:** pitch editor, tuning, timing, denoise, harmonies.
4. **3D Vocal score and AI singing:** `VocalPart`, KPN lyrics, G2P, provider interface, DiffSinger import, then an
   ACE-Step evaluation.
5. **Later:** voice conversion (5.3), LAION-CLAP "sounds like" search, chord-model upgrade.

## 9. Open decisions for the owner

1. **A commissioned Krypt voice.** Is it in scope, and on what budget? It is the only route to a default singer
   that ships in the box.
2. **A demo collection.** Should we ship one built from factory content so the focus and originality features
   work on first run, or ship nothing at all?
3. **Cloud voice providers (BYO key).** Should they be allowed alongside local ones? None found so far offers
   note-exact singing; revisit when one does.
