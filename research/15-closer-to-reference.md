# 15: Wave 8a, much closer to a reference + any audio → an editable project

**Goals** (user, 2026-10-14):
1. "Make something like this song" should come out **much** closer to the uploaded reference.
2. Anyone can open a WAV, MP3, M4A or FLAC and get an **editable `.kstudio`**: stems split, drums, bass, chords and lead as patterns, vocals as audio. They can change anything.

## 0. Why the last attempt missed (the log of 2026-10-14 09:18–09:42, reference "lemezia 2")

1. **Tempo.** `study_reference` read **143 BPM, C minor**, which is correct: 227 s ≈ 135 bars. The agent then **set 175 BPM**. Nothing stopped it.
2. **It skipped the reference loop.** It never called `get_playbook` (which follows the reference), `review_song` or `compare_to_reference`, so it got no feedback.
3. **Sounds were picked by genre name**, not by what the reference sounds like (Rumble Bass, Rolling Arp, Dub Chord).
4. **Drums were written from scratch.** The analyzer had 1,935 drum hits of the reference, and no tool turns them into patterns. The agent applied a generic "dance" groove instead.
5. **The mix was matched by guesswork.** There is no loop that renders, compares and adjusts.

**Fix strategy:** make the right path **one deterministic tool call** (`build_from_reference`) instead of 100 agent calls, then give the agent closeness numbers to push up.

## 1. The line (copyright)

**Follow closely (style):**
- tempo, key, swing;
- the **drum programming** (rhythm and velocities, transcribed from the drum stem);
- the **chord progression** per section;
- the bass **rhythm** (pitches follow the chord roots and fifths);
- section lengths, energy curve and arrangement, transitions;
- the **sound palette** (closest matching sounds) and the mix balance.

**Never copy:**
- the reference's melody, hook, lyrics, its exact bassline and its audio. Its stems are never used as samples in a new song.

The agent writes an **original** top line. `check_originality` compares it with the reference's transcribed melody (vocal + other stems).

**The user's own song (`mine: true`):** the user says it's theirs, and library songs are the user's own by definition. Exact bass and melody may be kept.

**`audio_to_project` is a conversion, not a new song:** it transcribes everything. For songs the user doesn't own, the result is for practice and remix study. The UI and the tool result say plainly: "If this isn't your song, don't release the result."

## 2. Contracts (lead; don't change their shape without asking)

- **`shared/analyzer/protocol.ts` `FingerprintArgs`, plus the analyzer cmd `fingerprint`:** returns `{ segments: SoundFingerprint[], whole?: SoundFingerprint }`. Mirror it in `engine/crates/analyzer/src/protocol.rs` and `docs/ANALYZER_PROTOCOL.md`. `AnalyzerJobCmd` includes `'fingerprint'`.
- **`shared/sound-match/types.ts`:**
  - `SoundFingerprint` (centroid, rolloff, flatness, harmonicity, f0, attack, decay, sustain, 6 bands rel. loudest, crest, width, peak, rms);
  - `FingerprintIndex` (`resources/factory/fingerprints.json`, GENERATED);
  - `MatchTarget`;
  - `SoundMatch` (similarity, why, tweaks).
- **`shared/transcription/types.ts`:** `SongTranscription` (bpm, key, swing, first downbeat, sections with `sameAs` pattern reuse, chords, parts with grid notes, stems, notes), `TranscriptionMode` `'exact' | 'style'`, `TranscriptionOptions`.
- **`shared/engine/protocol.ts` `RenderRequest.stems`:**
  - Now real: one pass, post-fader tap per insert, plus Master.
  - `stemInserts?: string[]`.
  - `RenderResult.stemResults[]`, each with its own `analysis` when `analyze`.
  - Mirror it in Rust and `docs/ENGINE_PROTOCOL.md`.
- **`shared/types.ts` `window.krypt.audioProject`:** `open(path?, opts)`, `cancel()` and `onProgress(cb)`, with `AudioProjectOptions`, `AudioProjectProgress` and `AudioProjectOutcome`.
  - Channels: `audioProject:open`, `audioProject:cancel` and the event `audioProject:progress` (`electron/channels.ts`).
  - The preload is wired; the IPC handlers belong to the builder.

## 3. The pieces

### 3.1 Analyzer fingerprints + engine stems (rust-a8)

- **`fingerprint` cmd** (analyzer crate, reusing `dsp` analysis blocks): decode (incl. Media Foundation formats), optionally slice segments, trim silence, then compute the `SoundFingerprint` fields exactly as documented in the TS type.
  - Pitch uses YIN or autocorrelation on the steady part.
  - Fast: under 5 ms per 0.5 s segment.
  - Tests: sine (f0, harmonicity ~1, flatness ~0), white noise (flatness ~1), kick-like (sub band loudest, short decay), stereo width.
- **Engine render `stems`:**
  - Tap each insert's post-fader output in the offline render, write one file per insert plus "Master", and analyse each.
  - `stemInserts` filter. Skip inserts that stay silent over the range, unless named in `stemInserts`.
  - Atomic writes, cancel support, and remove "Stem export is not supported yet" and its test.
  - MP3 stems use the existing MP3 path when format is mp3.
- **Optional, if time allows:** a cleaner `transcribe` mono for bass stems (octave-error guard, sub-bass pitch below 60 Hz).

### 3.2 Sound matching (match-core)

- **`shared/sound-match/match.ts`** (pure):
  - **Similarity:** a weighted distance per target kind.
    - Kick: sub/low bands, decay, f0, click (highMid), crest.
    - Snare / clap: centroid, flatness, decay, mid/highMid.
    - Hats: centroid, rolloff, decay.
    - Bass: f0 register, harmonicity, bands sub..lowMid, flatness (distortion), sustain.
    - Chords / pads: centroid, attack, sustain, width.
    - Lead: centroid, attack, harmonicity, width.
  - **`why` sentences** and **`tweaks`:**
    - cutoff toward the centroid ratio (for presets whose plugin has `cutoff`);
    - decay / release toward decayMs;
    - drive toward flatness;
    - channel pitch for samples toward f0;
    - gainDb.

    Tweak names must exist on the preset's plugin (`shared/plugins/catalog.gen.json`), and values are clamped to the spec.
- **`scripts/fingerprints.mjs`:**
  - Render every instrument preset through the engine at a role-appropriate note (bass/808 at C2, keys/pads/leads at C4, chord roles as a triad, using `scripts/audition-presets.mjs` techniques).
  - Fingerprint every factory sample.
  - Write `resources/factory/fingerprints.json` (deterministic order).
  - Hook it into `scripts/engine-build.mjs` as a warn-only step after the factory, plus `npm run fingerprints`.
- **Runtime:**
  - `electron/sounds/fingerprints.ts` loads the index.
  - Installed pack samples are fingerprinted lazily through the analyzer and cached in `userData/analysis/fingerprints-packs.json`.
  - `matchSounds(target fingerprint(s), target, opts)` returns `SoundMatch[]`.
- **MCP tool `match_sounds`:**
  - It matches the project's channels (by role) to the reference.
  - It returns the best 3 per part with why and tweaks, and with `apply: true` it loads the best one and applies its tweaks as one undo group.

### 3.3 Transcription core (transcribe-core, pure TS)

**`shared/transcription/*.ts` builds `SongTranscription` from:**
- `AudioAnalysis` (tempo, beats, downbeats, sections, chords, energy);
- drum-stem hits (`DrumHit[]`, or mix hits as a fallback);
- the bass-stem mono notes, the other-stem poly notes, and the vocal-stem mono notes (melody shape only, never written in 'style').

**It handles:**
- **Grid:**
  - Bar 1 is the first downbeat; pickup before it is dropped or shifted.
  - Beat-synchronous mapping, so tempo drift in live recordings stays on the grid: map each onset through the beat times, not one constant BPM.
  - Quantize (`grid`) with `feel` micro-timing kept.
- **Drums:** a channel per role found. Velocities are normalised per role; flams / double detections are merged; hits are capped at 32nds.
- **Bass:**
  - mono, legato cleanup, octave-error fixes against the chord roots;
  - in 'style' (not mine): keep the onsets and durations, with pitches = chord root, or the fifth / octave where the reference moves (contour class), in a register near the reference.
- **Chords:**
  - The chord timeline is snapped to beats and merged.
  - 'exact' voices them from the poly notes where they agree, else root-position voicing in the reference register.
  - 'style' voices fresh (close voicing around C4) with the same changes.
- **Lead ('exact' only):**
  - the other stem's top line;
  - plus `melodyShape` stats for 'style': median key, range, notes per bar, share of 16ths / 8ths / long notes, phrase length in bars, rests ratio, and steps vs leaps.
- **Sections:**
  - From the analysis sections at the chosen tempo reading, with names from `SectionKind` heuristics (energy + position: Intro, Verse, Build, Drop / Chorus, Break, Outro), numbered.
  - `sameAs` dedupe: same label and drum + chord similarity ≥ 0.85 reuse a pattern.
- **Per-section pattern notes** for every part (what the builder writes).
- **Tests:** synthetic analyses (4-on-the-floor at 128, half-time trap at 140 with rolls, a live-tempo drift), plus "style never contains the vocal or lead notes".

### 3.4 Builders + tools (builder)

**`electron/audioProject/**` service**, used by IPC `audioProject:*` and the MCP tools:

1. Analyze, with drums.
2. Separate (HT-Demucs, cached; without the model, drums come from the mix, bass and chords from mix-poly with a plain note).
3. Transcribe the stems: drums hits, bass mono with `maxKey` 60, other poly, vocals mono.
4. Fingerprint the stem segments (kick hits, snare hits, bass notes, chord spans, lead notes).
5. `transcription-core`, then `match-core`.
6. Write the project through commands in **one undo group**:
   - tempo, key, swing;
   - channels with matched sounds plus tweaks;
   - a pattern per section (reused by `sameAs`);
   - playlist arrangement and markers;
   - with `keepStems`, stems as **muted** audio tracks, tempo-synced and lined up;
   - vocals as an unmuted audio track;
   - mixer inserts named per part, the bass sidechained to the kick when the reference pumps.

**Progress events** use `AudioProjectStage`. Cancel works at any stage and leaves nothing half-written.

**UI open = a NEW project:** use the same "save changes?" flow as File ▸ New. Title = file name.

**MCP `audio_to_project {path, keep_stems?, factor?, parts?}`:**
- File consent works as for `import_audio`.
- It writes into a new project only when the current one has no unsaved changes. Otherwise it refuses with "Save or close the current project first (or ask me to add it to this one with into: 'current')".
- `into: 'current'` adds the parts to the current project.

**MCP `build_from_reference {genre?, mine?, factor?, parts?, keep_reference?}`:**
- It uses the studied reference (the "Reference: …" channel); without one it asks for `study_reference` first.
- 'style' mode writes the **whole instrumental bed** (drums, chords, bass, pad if the reference has one, arrangement, markers, transitions at boundaries from the playbook kinds, bus / master chains from the genre playbook, sidechain, levels from the reference stem loudness) as one undo group.
- It creates an empty matched **Lead** channel and returns `melodyShape` with the instruction: write an ORIGINAL melody with this shape, then `check_originality`, then `match_mix`, then `review_song`.

**Reference lock:** while a reference is studied, `set_tempo` refuses a tempo more than 3% off the reference reading (×0.5, ×1 or ×2) unless `override: true`. It explains why.

**Text:**
- `study_reference`'s result ends with "NEXT: build_from_reference".
- The `like` prompt and SERVER_INSTRUCTIONS are updated (still ≤ 2048 characters).
- `docs/MCP.md` is updated.

### 3.5 Closeness + mix matching (review-mix)

- **`review_song` with a reference** gains `closeness`: 0–100 overall plus a per-dimension score, a measured value and a fix for each:
  - tempo (exact = 100);
  - key;
  - groove (per-role 16th-step histogram cosine vs the reference drum stem);
  - harmony (chord progression similarity per section);
  - arrangement (energy-curve correlation, section boundaries within 1 bar);
  - sounds (fingerprint similarity per part, via the stems render);
  - mix (bands vs mid, width, LUFS, per-part loudness balance from `stemResults` vs the reference stems).

  The top fixes are ranked. Keep the existing review issues.
- **MCP `match_mix {rounds? 1-3, section?}`:**
  1. Render the loudest section (and one quiet one) with `stems`.
  2. Compare per-part loudness with the reference stems (drums / bass / other / vocals → our inserts by role) and set insert volumes.
  3. Compare the master bands and width, and set a dedicated "Match EQ" (Krypt EQ, gains capped at ±6 dB) and imager on the master.
  4. Match LUFS with the limiter gain.
  5. Repeat for the given rounds, reporting before → after per dimension.

  It is one undo group.
- **`check_originality`:** also compares against the reference's vocal / other stem transcription (melody intervals + rhythm), not only the library.

### 3.6 UI + guides (ui-a8)

- **Entry points:**
  - **File ▸ Open audio as project…** (Ctrl+Shift+O, if it's free in the keymap);
  - Home ▸ Audio Tools "Audio → Project" card;
  - Home ▸ Projects "From an audio file";
  - dropping an audio file on Home offers "Open as project" or "Use as a reference for the AI".
- **Progress modal:** the 5 stages, the current message and a fraction, with Cancel. It ends in a summary: BPM, key, bars, parts, matched sounds, limits, "Open stems track" and a short Undo note. The ownership note appears once per session.
- **Stem export:** File ▸ Export ▸ "Stems into a folder" is enabled again (`src/app/TitleBar.tsx`, `actions.ts`, `electron/ipc.ts` refusal removed, export dialog option). Files go to the chosen folder.
- **Guides:**
  - new article `audio-to-project` ("Turn a song into a project");
  - update `ai-results` (the reference flow: `build_from_reference`, closeness, `match_mix`);
  - fix `exporting` (stems now available);
  - add glossary entries.

## 4. Ownership

| Agent | Owns |
|---|---|
| **rust-a8** | `engine/crates/analyzer/**`, `engine/crates/engine/src/{render.rs,control.rs,protocol.rs,tests.rs}` (render parts), `engine/crates/dsp/src/analysis.rs` (if shared feature code goes there), `docs/ANALYZER_PROTOCOL.md`, `docs/ENGINE_PROTOCOL.md` |
| **match-core** | `shared/sound-match/**` (not types.ts), `scripts/fingerprints.mjs`, the fingerprint step in `scripts/engine-build.mjs`, `package.json` script, `electron/sounds/fingerprints.ts`, the `match_sounds` tool (new `electron/mcp/tools/match.ts`), tests |
| **transcribe-core** | `shared/transcription/**` (not types.ts), tests |
| **builder** | `electron/audioProject/**`, `electron/ipc.ts` audioProject handlers, `electron/analyzer/service.ts` additions (fingerprint, cached stem paths), `electron/mcp/tools/{reference,ears,arrange}.ts` (set_tempo lock wherever set_tempo lives), the new `audio_to_project` / `build_from_reference` tools, `electron/mcp/{prompts,server}.ts` text, `docs/MCP.md`, tests |
| **review-mix** | `electron/mcp/tools/{craftReview,craft,library}.ts` review / closeness / originality parts, a new `match_mix` tool (in `electron/mcp/tools/mix.ts` or a new file), tests |
| **ui-a8** | `src/app/{TitleBar,actions,ExportDialog}.tsx?`, new `src/audioProject/**`, Home screens (`src/home/screens/**`, drop handling), the `electron/ipc.ts` stems refusal line only, `src/guides/library/*.ts` + `articles.ts` bodies for the guide updates, `test/guides.test.ts` if needed |

**Shared files:**
- `shared/types.ts`, the `shared/*/types.ts` contracts and `electron/channels.ts`: ask the lead.
- `electron/mcp/tools/index.ts` (tool registration): builder, match-core and review-mix each add their own lines only.

**Rules:**
- The repo has no commits, so everyone shares the tree.
- Run `npm run typecheck && npm test` (and `cargo test` for Rust) before reporting. Name other agents' failures; don't fix them.
- **Don't run `npm run build`, `npm run engine:build` or `npm run dist`, and never kill processes:** the user's dev app and MCP shims are running and hold `resources/bin`.
- Rust builds use `engine/target` (rust-a8 only). Others needing a fresh analyzer use `CARGO_TARGET_DIR=engine/target-a8` builds of the analyzer crate.

## 5. Integration checklist (lead)

- [ ] Rebuild the engine and analyzer (when the user closes the app), plus `npm run fingerprints`
- [ ] audio_to_project on 3 real songs, the demo renders "Neon Fog" and "Night Drive" plus the user's "lemezia 2":
  - tempo, key and sections right;
  - drums per section match the stem hits (≥ 90% onset F1);
  - the project plays;
  - undo removes it all
- [ ] build_from_reference on "lemezia 2": tempo locked at 143, closeness ≥ 75, originality OK; an A/B listen of the renders by the user
- [ ] match_mix moves band / LUFS deltas toward 0 in ≤ 2 rounds
- [ ] Stem export from the UI writes one file per insert plus Master
- [ ] Guides tests, full `npm test`, full `cargo test`
