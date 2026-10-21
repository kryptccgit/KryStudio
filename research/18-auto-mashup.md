# Auto Mashup (written 2026-10-14)

**User ask:** "can we do some form of auto mashup between two songs too, in audio tools".

**Today:** a mashup is an AI-agent workflow, the `mashup` MCP prompt: import, `separate_stems`, `match_clip`, `tune_vocal`, arrange by hand.

**Goal:** a built-in, one-step mashup that anyone can run from **Home ▸ Audio Tools** and agents can run as one tool (`auto_mashup`). The result is an editable project, made as ONE undo step.

**Contract:** `shared/mashup/types.ts`, plus `KryptApi.mashup` in `shared/types.ts`, the `mashup*` channels and the preload/mock bindings. All of it is lead-written and already in the tree.

## Pipeline (builder)

1. **Read both songs.** Import if `path`, reuse the clip if `clipId`. Use the analyzer's `analyze` for tempo with alternatives, key with confidence, beats/downbeats, sections and energy. Reuse what `electron/audioProject` and `electron/vocals` already do; don't duplicate it.
2. **Stems** (HT-Demucs, when installed): reuse stems already separated for that sample (`SampleRef.origin`). `vocalOverBeat` and `stemBlend` need stems unless the song is already an a cappella or an instrumental (detect from vocal presence). Without a model, `check` reports a problem that tells the user to install it in the Model Manager. `backAndForth` works without stems.
3. **Plan** (pure: `shared/mashup/plan.ts`, unit-tested):
   - **Roles** (`vocalFrom: 'auto'`): try both directions and score each by:
     - vocal presence of the donor;
     - the instrumental's lack of vocals, or stems being available;
     - tempo stretch cost (with half/double readings);
     - key cost.
   - **Key:** reuse `shared/music/keymatch.ts`:
     - the smallest semitone move;
     - relative major/minor counts as 0;
     - Camelot neighbours (±1) count as compatible with a small cost;
     - `anchor` decides who moves; `middle` splits the move.
     - Prefer ≤ ±3 st on vocals and say so above that.
   - **Tempo:** take the target from the anchor, with the reading that stretches least. Note a stretch outside ×0.85–×1.18 as audible.
   - **Grid:** auto-warp both sources to the project grid from their beats/downbeats (the Wave 12.2 warp: `audio.autoWarp`, or warp markers per bar). Use mode `tones` for vocals and `beats` for drums, and `complex` for other material.
   - **Structure:**
     - map the donor's vocal phrases onto the bed's sections, on 4/8-bar phrase boundaries;
     - the hook/chorus (highest-energy vocal section) goes over the bed's highest-energy section (drop/chorus);
     - verses go over lower-energy sections;
     - an instrumental intro (4–8 bars), a break and an outro;
     - target length: `bars`.
   - **`backAndForth`:** alternate 8/16-bar sections of A and B (best-energy sections first) on the shared grid, with crossfades or transitions at each switch.
4. **Build**, as ONE undo group:
   - audio clips per section (`add_clip`-style commands with offsets);
   - markers per section;
   - song mode.
   - **Mix:**
     - a vocal chain: HP EQ, comp, Krypt Tune per `tune`, and a reverb/delay send from the factory chains;
     - carve the bed under the vocal: sidechain duck or an EQ dip 300 Hz–3 kHz on the bed's Other/Bass, using the existing `sidechain` / `apply_chain` paths;
     - a master chain;
     - transitions at each boundary (`add_transition` logic).
   - New project (default) or the open one.
5. **Report:** `MashupOutcome` with an honest `notes` list and the rights note.

`check` runs steps 1–3, with no edits and no stem separation unless the stems already exist. It must be fast: about 10 s per song for analysis. It may then estimate vocal presence from the mix.

## Ownership

| Agent | Owns |
|---|---|
| mashup-core | `shared/mashup/plan.ts` (+ helpers), `electron/mashup/**`, the IPC handlers in `electron/ipc.ts` (`mashup*`), main wiring, MCP `auto_mashup` (`electron/mcp/tools/mashup.ts`: `{a, b}` paths or clip names, all `MashupRequest` options, `dry_run` = check), the `mashup` prompt updated to call `auto_mashup` first, docs/MCP.md + tool counts, tests `test/mashup*.test.ts` (planner + service with the fake analyzer). |
| mashup-ui | Home ▸ Audio Tools featured "Auto Mashup" card + the mashup dialog (`src/mashup/**`): two song pickers (file, project clip, or a reference-library track if easy), a compatibility readout (score, reasons, suggestions, problems with a Model Manager link), style picker (with a per-stem A/B/off grid for stemBlend), options (anchor, tempo readings, tune, length, new project), the plan preview (sections timeline), Build with progress + Cancel, the result toast ("Open Studio"); Tools ▸ Auto Mashup… and the playlist audio-clip menu "Mashup with…"; the Guides article "Auto Mashup" (+ update "Vocals & mashups"), with "Show me" anchors. |

**Rules** are as in `research/17-wave-12-2b.md` §4:
- no building or killing the user's app;
- MIT dependencies only;
- no silent failures;
- the Krypt UI kit;
- commands only;
- typecheck + tests green;
- reports under 450 words.
