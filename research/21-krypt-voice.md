# Krypt Voice: speech + "Sing my notes" (written 2026-10-14)

**User ask:** "check out Fish voice AI, let's see if we can rope that in to do free voice AI in app … we can [Krypt Tune] voices to songs, it's a good option for vocals."

## Research summary

**Fish Audio:**
- **Code:** the fish-speech code is Apache-2.0.
- **Weights:** the open weights (S1-mini …) are **CC-BY-NC-SA-4.0** (non-commercial), with a paid commercial licence. We can't bundle them in an MIT app, and running them needs PyTorch + a GPU.
- **Cloud API:** S2.1 Pro has a **free developer tier** (`s2.1-pro-free`):
  - free access ends **"Aug 31 / Nov 30, 2026"** (their page states both);
  - fair use;
  - cloning;
  - 83 languages;
  - REST `POST https://api.fish.audio/v1/tts`, `Authorization: Bearer <key>`;
  - requests "may be used to improve model quality".

  Paid is $15 per 1M UTF-8 bytes.

**Kokoro-82M:**
- **Apache-2.0**, 54 voices across 8 languages, ONNX builds exist.
- Verify the ONNX repo's licence and the G2P path before shipping.
- **NO espeak-ng (GPL)**: use a permissive dictionary G2P (CMUdict) + letter-to-sound rules for English.

## Design

### Engines

**local (default, offline, free):** Kokoro in the analyzer sidecar (ONNX Runtime, already there for HT-Demucs).
- A Model Manager entry (`task: 'tts'`) downloads the model + voices (+ the G2P dictionary if not embedded).
- English first; others say "use the Fish engine" until their G2P is permissive and solid.

**fish (opt-in):** the user's own API key, stored with Electron safeStorage like the agent key.
- Verify it with a tiny request.
- Every Fish action is labelled **Cloud**: "your text (and, for your voice, your recording) is sent to Fish Audio".
- No key means a clear message plus the link to get a free key.
- Free-tier end, quota or 401 errors become human messages.

**Voices:**
- Kokoro presets;
- Fish's OFFICIAL / default voices only (no community library: impersonation risk);
- **my voice**: a clone of the user's own voice ONLY, from an in-app recording that starts with `CONSENT_LINE`:
  - recorded live through the existing audio-input recorder, never an uploaded file;
  - the consent line is checked with Fish Transcribe or local ASR if available, else at least a confirmation checkbox, plus the recording must be live from the mic;
  - stored as a private Fish model; `removeMyVoice` deletes it there and here.

### speak (`SpeakRequest`)

1. Render to `userData/voice/<hash>.wav` (cached by text + voice + speed).
2. Import it as an audio clip on a new track (or the given track / bar), with Follow tempo OFF.
3. Krypt Tune optional.
4. Preview = audition only.

### sing ("Sing my notes", `SingRequest`)

1. **Notes:** the melody notes of the pattern + channel in the bar range, sorted, monophonic (the highest note at a time).
2. **Syllables:** split the lyrics into syllables with a pure English syllabifier (vowel groups plus rules, and the `-` / `_` markup for melisma). One syllable per note; extra notes extend the previous syllable; extra syllables merge into the last note, with a note saying so.
3. **Speak** the lyrics line by line (better prosody), with `tts` locally or Fish.
4. **Find the syllables in the audio:**
   - Kokoro word timings when available;
   - else the analyzer's `syllables` cmd (energy / voicing nuclei aiming for the expected count);
   - else equal splits.
5. **Render** with the analyzer's `sing` cmd: each syllable segment is stretched to its note's length at the project tempo and pitched to its MIDI note (median f0 → note, formants kept), with glide + vibrato and crossfades.
6. **Place** the result as one audio clip aligned to the pattern's first note, then add Krypt Tune (`hard` by default) in the song's key. The mapping is returned so the UI can show which syllable sits on which note.

### MCP

- `generate_voice {text, voice?, engine?, speed?, at?, track?, tune?}`;
- `sing_notes {pattern, channel, lyrics, voice?, bars?, tune?, octave?}`;
- `list_voices`.

Agents never set the Fish key or clone voices.

## Agents

| Agent | Owns |
|---|---|
| voice-local | **Rust** `engine/crates/analyzer`: the `tts` (Kokoro ONNX, G2P), `sing` and `syllables` commands per `shared/analyzer/protocol.ts`, plus tests. The Model Manager entry in `shared/analyzer/models.ts` (licence, URLs, sha256 from the official ONNX repo). `docs/ANALYZER_PROTOCOL.md`. `CARGO_TARGET_DIR=engine/target-ana`. |
| voice-app | **TS main**: `electron/voice/*` (VoiceService: local via the analyzer supervisor, the Fish client, key storage, voice list, clone / remove, cache, import as clips, the sing pipeline), pure `shared/voice/{syllables,singplan}.ts` (+ tests), IPC `voice*`, MCP tools (+ counts / docs), the tab-switch guard while rendering. |
| voice-ui | **Renderer**: the Krypt Voice panel / dialog (`src/voice/**`: text, voice picker with Local / Cloud / My voice groups, tag chips for Fish, speed, Preview / Add to song, progress), "Sing my notes" in the piano roll (lyrics box, syllable → note preview on the roll, voice, octave, tune, Preview / Add), Settings ▸ Voice (Fish key with the privacy note, model status), the "Record my voice" consent dialog (uses the existing recorder), Home ▸ Audio Tools card, Tools ▸ Krypt Voice…, the Guides article. |

## Rules

As in `research/17-wave-12-2b.md` §4:
- MIT-compatible only (NO espeak-ng / GPL G2P, no NC weights bundled);
- never "Auto-Tune" (say Krypt Tune);
- no silent failures;
- the Krypt UI kit;
- commands only;
- no cloning of anyone but the user;
- the Cloud label on every Fish path.
