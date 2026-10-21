# Mastering upgrades (2026-10-15)

**User request (relayed from a fan):** "AI mastering would blow up, other sites charge $25/month."

"Master a song" already exists:
- **Entry points:** Home ▸ Audio Tools; Tools ▸ Master a song.
- **Code:** `electron/automix/service.ts` `masterFile` → `run({ mode: 'master' })`, with `shared/automix/plan.ts` `planMaster` and the presets in `shared/automix/presets.ts`.

The user said "build all 3" of the upgrades below.

## 1. Reference matching ("Make it sound like this song")

**User flow:** in Master a song (and Auto Mix master / full mode on a project), an optional **Reference song** row:
- pick a file, or drag one in;
- the app analyzes the song and shows its loudness / tone summary;
- the preset grid then reads "Matching: <reference>" (a preset can still add intent on top).

**Analysis:**
- Reuse the reference analysis: `electron/analyzer/service.ts` `analyze()`, and `shared/reference/brief.ts`, which builds `mix.lufs` / `truePeakDb` / `bandsVsMid` / `width` / `contrastLu`.
- Prefer a cached / light path; a short loudness + spectrum pass is enough. Never hold the user longer than needed, and show progress.

**Target:**
- the reference's tone curve (bands relative to the mids) replaces the preset curve;
- target LUFS = the reference's integrated LUFS, clamped to the existing safe range;
- the existing distortion / crest guard still wins (the note explains it, e.g. "the reference is −6 LUFS; your song distorts past −8.5, stopped there");
- width follows the reference's width (mono low end kept);
- the true-peak ceiling stays at −1 dBTP unless the user sets it.

**Result view:**
- the tone overlay shows reference vs before vs after;
- "Closer to the reference by N dB" (mean absolute band difference, before → after);
- an A/B that can also play the **reference, loudness-matched**, so loudness doesn't fool the ear.

**Elsewhere:**
- MCP `auto_mix` gains `reference: <path>`, plus a master-a-file path.
- Never copies the reference's audio into the output; it's only measured.

## 2. Album mastering ("Master an album")

**Picking songs:** pick 2–20 songs (multi-file dialog / drop), reorder them, and pick one preset (or a reference) for the whole album.

**Suggested design** (the agent may improve it; justify it in the report):
- One new project tab, "Album: <first song> + N".
- Each song sits on its own track and insert, placed back to back with a 2-bar gap and a marker per song.
- **Each song's insert gets its own mastering chain** (tone EQ, glue, width, limiter). The master bus keeps only a safety true-peak limiter.

**Album consistency:**
- Every song is measured.
- Tone: each song moves toward (preset or reference curve) + a share of the album's average deviation, so songs sound like one record and not 12 different EQs.
- Loudness: the loud songs and the quiet songs (ballads, intros) keep their relative level when the user picks **"Keep the album's dynamics"** (the default: the loudest song hits the target, the others keep their offset, capped at −4 LU). Otherwise each song hits the target.

**Iteration:** reuse the measure / plan / apply loop per insert, rendering each song's range. Keep it reasonably fast: render each song once per pass, max 2–3 passes.

**Result:**
- one row per song: before / after LUFS, true peak, changes, an A/B per song;
- Keep / Undo for the whole album (one undo group);
- **Export all:** pick a folder, then one file per song (`<name> (mastered).wav` / `.mp3`) rendered from its range. Show progress, one toast at the end, and open the folder.

**Limits and MCP:**
- Cancel works at any point.
- Memory: never decode all 20 songs into RAM at once if avoidable.
- MCP: `auto_mix` (or a new `master_album` tool) with `paths[]`.

## 3. Discoverability + teaching

- **Home:** "Master a song" becomes a top-level, featured Home entry (a featured card under the quickstart / tour cards, or a top-grid card). It has two buttons: **Master a song…** and **Master an album…**, plus "Make it sound like a song you love" copy.
- **Guides:** a beginner guide "Master your song (step by step)" in the Start-here section, with annotated screenshots. Also update the Auto Mix article.
- **Tour:** optional, a short tour "Master a song", if cheap with the tours engine.
- **Video:** "Master a song" (decided later: ElevenLabs needs a new key; the alternative is local Kokoro narration).

## Rules

As always:
- MIT deps only; no new deps unless essential and permissive;
- no silent failures; Krypt UI kit;
- every mutation through `shared/commands`;
- `npm run typecheck && npm test` green;
- Rust changes only if needed (then `cargo test` with your own `CARGO_TARGET_DIR`).

Never say "Auto-Tune". Don't name competitor products (LANDR, Ozone, …) in user-facing text.
