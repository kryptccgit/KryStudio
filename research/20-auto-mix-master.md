# Auto Mix / Auto Master (written 2026-10-14)

**User / community ask:** "a feature that will automatically mix your vocals or can master the song, and it will do it based off a prompt or presets."

**Today:** the pieces exist:
- 13 master chains and 6 vocal chains;
- AI agents with `review_song`, `match_mix`, `apply_chain`, `sidechain`, `tune_vocal`;
- Wave 12.2b gain-reduction metering in renders.

There is no one-click path that works without an AI agent.

**Contract:** `shared/automix/types.ts`, plus `KryptApi.automix` in `shared/types.ts`, the `automix*` channels and the preload/mock bindings. All of it is lead-written and already in the tree.

## How it works (automix-core)

### 1. Presets (`shared/automix/presets.ts`)

About 10–12 cards, each with a loudness target, a true-peak ceiling, a tonal target curve and character knobs. Base them on the existing playbook / genre mix targets and the factory master chains, so the numbers agree with `review_song`.

The cards:
- Streaming Clean (−14);
- Balanced (−11);
- Loud Trap / Drill (−8);
- Club / EDM (−8);
- Warm R&B (−11);
- Lo-fi (−13);
- Pop Polish (−9);
- Hip-Hop Punch (−9);
- Rock / Live (−10);
- Podcast / Voice (−16);
- Phonk Slam (−7).

**'auto'** picks one from the project genre (`meta.genre`) or the analysis.

### 2. Prompt → intent (`shared/automix/intent.ts`, pure)

**Keyword parser** (English, forgiving):
- louder / quieter;
- brighter / darker / airy;
- warmer;
- punchy / soft;
- wide / mono;
- bass;
- vocals up / forward / on top / buried;
- reverb / dry / space;
- harsh / sibilant / smooth;
- clean / natural / aggressive / crushed;
- genre words → preset;
- "−9 LUFS" / "spotify" / "club" → target.

**AI:** when the built-in agent has an API key (`electron/agent`) or an AI is reachable, ask it for an `AutoMixIntent` JSON. Use a strict schema, clamp every value, and keep a short timeout. Fall back to keywords. `source` says which was used, and `summary` echoes what was understood.

### 3. Measure (`electron/automix/*`)

Run an offline render of the scope:
- the engine render with `analyze` + `stems` for per-insert analysis;
- `gainReduction` per slot (Wave 12.2b).

Detect vocals from:
- channel / insert names;
- stem origin (`SampleRef.origin.stem === 'vocals'`);
- the `· Vocals` naming;
- audio channels whose analysis looks vocal.

Detect roles per insert (kick, snare/clap, hats, bass/808, keys/pads, lead, vocal, FX, bus) from names, plugins and the analysis.

### 4. Plan (`shared/automix/plan.ts`, pure, unit-tested)

The plan is turned into commands (`mixer.setInsert`, `mixer.addSlot`, `mixer.setSlotParams`, `mixer.setRoute`, `sidechain`, …) on Krypt-owned slots. Mark them so a re-run ADJUSTS them instead of stacking new ones, and with `keepUserFx` the user's own slots are never touched.

**vocals:**
- HP at 80–120 Hz;
- a mud cut if lowMid builds up;
- presence / air per brightness;
- de-ess (the new `krypt.deesser`);
- comp sized by the measured crest / GR;
- Krypt Tune only if the preset/prompt asks;
- level vs the beat to `vocalLevel`;
- reverb / delay sends per `vocalSpace` (reuse the factory send chains);
- carve the beat (an EQ dip or duck at 2–4 kHz on the busiest bed insert).

**mix:**
- gain staging: inserts to sensible relative levels by role, headroom −6 dB on the master before mastering;
- HP on non-bass roles;
- mud and harshness cuts where measured;
- comp on drums / bass by role;
- glue on the drum bus, if one exists, else on the master pre-limiter;
- bass vs kick: sidechain-duck the bass under the kick when their low bands collide;
- vocal space as above.

**master:**
- a chain from the preset (EQ tilt toward the tone target, Glue, Heat/saturation per warmth/punch, Imager with mono bass below 120 Hz per width);
- the limiter last, at the preset ceiling.

**full:** mix, then master.

### 5. Converge

Re-render after applying, and adjust:
- limiter input gain toward the LUFS target, ±0.5 LU;
- tone EQ toward the curve, within safe limits.

At most 3 passes. Never exceed the true-peak ceiling. Cap how loud it goes (crest-factor guard) and say so in `notes`.

### 6. Write

Everything goes into ONE history entry. Return its `entryId`, and `before` / `after` / `changes` / `notes`.
- **Cancel** before writing changes nothing.
- **Converging after writing:** passes 2–3 adjust within the same entry. Keep the group open across passes, or apply the delta as part of the same group; document which.

### 7. Master a file

`masterFile`:
1. Import the audio into a NEW project tab (`tabs` API: Audio → Project shows how).
2. Run `master`.
3. The UI then offers export (the existing export dialog), defaulting to WAV 24-bit + MP3 320.

### 8. New device: `krypt.deesser`

Krypt De-Esser (`engine/crates/dsp`):
- split-band, sidechain-filtered compression on 4–10 kHz;
- params: frequency, threshold, range, listen, mix;
- GR meter via `Effect::meter()`.

The lead regenerates the catalog at integration.

### 9. MCP

`auto_mix {mode, preset?, prompt?, target_lufs?, true_peak?, bars?, dry_run?}`: `dry_run` = measure + plan only. Agents can still fine-tune by hand afterwards.

## UI (automix-ui)

**Entry points:**
- Mixer toolbar "Auto Mix";
- an "Auto Master" button on the master strip;
- Tools ▸ Auto Mix…;
- Home ▸ Audio Tools "Master a song" card, which runs `masterFile`;
- the playlist audio-clip menu "Auto-mix this vocal" (vocals mode, pre-filled with that insert).

**Panel / dialog** (`src/automix/**`):
- mode tabs: Vocals / Mix / Master / Mix + Master;
- a preset grid (cards: name, LUFS, a little tone curve);
- a prompt box with examples and a live "understood as: …" line (debounced `understand`, showing AI vs keywords);
- options: target LUFS, true peak, keep my effects, scope (whole song / loudest part / bars);
- Run → progress → result:
  - before / after (LUFS, true peak, a tone curve overlay, vocal vs beat);
  - the "what changed" list;
  - an **A/B** toggle (`doc.toggleEntry(entryId)`) that plays at matched loudness if feasible (a temporary master trim, or note "louder always sounds better: compare at the same volume");
  - Keep / Undo;
  - "Export…" for a mastered file.

**Guides:** an "Auto Mix & Master" article with "Show me" anchors.

## Rules

As in `research/17-wave-12-2b.md` §4. Never "Auto-Tune" (say Krypt Tune). Krypt UI kit. Commands only. No silent failures. Typecheck + tests green.
