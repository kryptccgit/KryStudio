# Reference library

The reference library lets Krypt Studio learn a style from **your own songs**. You import folders of tracks into named collections ("Dark trap", "90s R&B"). Krypt analyses each one on your PC and keeps what it measured. It then sums a collection up as a **style profile** that the AI composes from. There is no model training: a profile is statistics plus a few example patterns sampled from them.

> **Only import music you own or have the rights to analyse:** your own productions, licensed material, public-domain or Creative Commons tracks. Krypt never downloads songs and never ships a reference library.

## What is stored, and where

Everything lives in one SQLite database: `%APPDATA%\Krypt Studio\library\library.sqlite` (Electron's `userData`).

| Stored | Not stored |
|---|---|
| Collections: name, tags, the folders you added, whether deep analysis is on | Audio. The library never copies, converts or keeps your files |
| One record per source file: its path, size and modified time, plus status and any error | Waveforms, spectrograms or embeddings that could rebuild the audio |
| Derived features: tempo and beat grid, key, swing, sections, loudness and band levels, stereo width, energy curve, chord estimates, a 32-step drum grid per role, a similarity vector | |
| Deep pass only: the transcribed bass, vocal and "other" lines as notes in beats, and short n-gram hashes of them for the originality check | Stems. They are written to `library\tmp\` for the track being analysed and deleted right after it, and again at every start |
| Cached style profiles, rebuilt when a collection changes | |

- **Local only.** Nothing is uploaded and there is no telemetry. The analyzer (`krypt-studio-analyzer.exe`) runs on your machine.
- **Records only.** Removing tracks or a whole collection deletes their records. Your files are never touched.
- **Start over** by quitting Krypt Studio and deleting the `library` folder.
- A database written by a newer Krypt Studio is left untouched, and the library reports why it can't open it. An unreadable database is renamed to `library.sqlite.corrupt-<time>` and a fresh one is started.

## Importing

Add a folder to a collection (it is scanned recursively) or add single files. Accepted formats: wav, aiff, flac, mp3 and ogg, plus m4a, aac, mp4, wma and alac through Windows Media Foundation. A file the analyzer can't decode is marked failed with its message. Hidden and system folders are skipped.

**Rescan** compares a collection's folders with the database:

- new files are queued;
- changed files (a different size or modified time) are analysed again;
- deleted files are marked **missing**;
- a missing file that comes back unchanged gets its old analysis back without being analysed again.

## The analysis queue

| Pass | What it does | Speed (3-minute track) |
|---|---|---|
| **Light** (every track) | `analyze` with sections and drum hits, using the bundled Beat This! model for beats. The drum hits become the per-role drum grid, the chords are converted to beats, and the similarity vector is computed | about 1 s on DSP only, about 5 s with the beat model |
| **Deep** (collections where you turn it on) | Separates stems with the installed stem model (HT-Demucs), then transcribes drums from the drum stem (replacing the mix grid), the bass and vocals as single lines, and "other" polyphonically when Basic Pitch is installed. A near-silent vocal stem is skipped. Then the lines and their hashes are stored and the stems deleted | about 7 s per audio minute on a DirectX 12 GPU, about 26 s on the CPU, plus a little for transcription |

- Two light jobs run at a time. Deep jobs run one at a time, after the light pass.
- The **fast scan** setting skips the beat model: about 3× faster, with rougher beats and downbeats (which feed the drum grids and the bar positions).
- Deep analysis needs a stem model from Model Manager. Krypt estimates the time first (tracks × length × your device's speed). You turn it on in the Library panel; an agent can turn it on with `library_deep` only when the stem model is **already installed** (it is refused otherwise, and agents never download models). The agent gets the same time estimate and should tell you; you can pause the queue or switch deep off at any time.
- The queue is **persistent**. Status lives in the database, so after a restart, pending work resumes a few seconds after start-up and finished tracks are never analysed again. **Pause** survives restarts too.
- A failure is recorded per file with the analyzer's message, and the queue moves on. **Retry failed** re-queues them. If the analyzer itself crashes, the file is retried, and it is only blamed after 3 crashes.
- Quitting cancels running jobs (they stay queued) and deletes temporary stems.

## Style profiles

A profile aggregates a collection's analysed tracks (`shared/library/profile.ts`):

- tempo percentiles and histogram, and the half-time share;
- swing;
- keys and the minor share;
- per-step hit probability and velocity for kick, snare, hat, open hat and perc, plus hat rolls per bar;
- bass note lengths, scale degrees, kick alignment and glides (deep tracks only);
- common chord-degree progressions and chord changes per bar;
- section lengths, common forms and the energy shape;
- loudness, true peak, width and band balance targets.

**Example drum and bass patterns** in KPN are *sampled from the probabilities* with a fixed seed. They are never copied from one track.

Limits:

- Everything is an estimate from on-device analysis. Chords and drum hits from the full mix are rough; deep analysis makes drums and bass much better.
- Each section needs data from at least 3 tracks (bass: 3 deep-analysed tracks); otherwise it is left out and `caveats` says why.
- A profile describes what the collection has in common. A very mixed collection gives a vague profile, so split it.

## Similar tracks

**Find similar** ranks tracks by a normalised feature vector: tempo, key, swing, loudness, band balance, width, onset density and drum density. It finds tracks with a similar feel, not similar melodies.

## Focus

Pick a collection as the **focus** and add an optional brief in your own words ("dark, sparse, lots of space"). The focus is saved in settings.

- **Krypt Agent panel:** the profile and your brief are attached to your message whenever they change.
- **MCP agents:**
  - `get_project` mentions the focus;
  - `get_style_profile` returns it;
  - the `focus` prompt builds a compose workflow around it;
  - `krypt://styles/<id>` serves any collection's profile;
  - `library_deep` turns on deep analysis for a collection when a stem model is installed (time estimate first, `estimate_only` for just the estimate).
- **Automatic originality check:** after an agent's `begin_edit … commit_edit` group, when the focused collection has deep-analysed tracks, the melodies written in that group are checked and close matches come back as a warning. The edit is never blocked.

## Originality check

`check_originality` (and `window.krypt.library.checkOriginality` in the UI) compares the project's melodic lines with the transcribed lines of every deep-analysed reference. A melodic line is every pattern × pitched channel with at least 5 notes and 3 distinct pitches; drum channels are excluded.

1. Each line is reduced to its top note per onset.
2. Every 5-note window is hashed by its pitch intervals plus rhythm classes, so the hash doesn't depend on the key or the tempo.
3. The hashes are looked up in the database to find candidate reference lines.
4. Each candidate is verified note by note.
5. A run of **8 or more** matching notes is reported, with the reference track, the stem, the bar in your pattern and the time in the reference.

Generic runs aren't flagged: repeated notes, trills, plain scale runs, one or two pitch classes. Drums and chord progressions are never flagged, because they are genre conventions.

Limits: quality is bounded by transcription accuracy, so misses happen. Only deep-analysed tracks can be checked.

- **Reliable:** lines that come out of a stem cleanly. That means bass and 808 lines, and lead vocals.
  - In testing, a copied 808 line transposed by a semitone was flagged in every reference containing it, with 94–96 % agreement and the right timestamps.
- **Weak:** soft lead synths buried under pads in the "other" stem. In testing, a bell lead under detuned-saw pads was mostly missed: the stem transcription returned the pad chords and only fragments of the bell. Such a melody can't be checked against that reference. **It is a production aid, not legal advice**, and it does not certify that anything is non-infringing.

## For developers

| Piece | Where |
|---|---|
| Types (the contract) | `shared/library/types.ts`; `window.krypt.library` in `shared/types.ts` |
| Pure maths: beat conversion, drum grid, profiles, similarity, originality | `shared/library/*.ts` |
| Database (node:sqlite, WAL, `PRAGMA user_version` migrations) | `electron/library/db.ts` |
| Queue, passes, queries, focus | `electron/library/service.ts` (Node only; tests use the fake analyzer) |
| IPC | `electron/ipc.ts` (`library:*` channels), `electron/preload.ts` |
| MCP tools | `electron/mcp/tools/library.ts` |

Tables:

- `collections` (with a `rev` that invalidates cached profiles);
- `tracks` (path, size, mtime, status, error, plus summary columns for fast filters: duration, bpm, key, key pitch class and mode, swing, LUFS, width);
- `features` (JSON with floats rounded to 4 decimals, the vector and its version);
- `line_hashes` (indexed by hash);
- `profiles`;
- `meta` (pause state, last known analyzer devices).

When `VECTOR_VERSION` changes, the vectors are recomputed from the stored features at start-up. The audio is not analysed again.
