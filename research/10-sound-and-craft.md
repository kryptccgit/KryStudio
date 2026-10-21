# 10: Sound & Craft (Wave 4)

**Goal:** one plain-language prompt ("make an EDM song like this") produces a track that sounds finished, with no clean-up work. The next prompt edits it.

## Why the output needs so much work today

We diagnosed this on 2026-10-12. The notes the agents write are usually fine; everything around the notes is not:

1. **No presets exist.**
   - A channel an agent creates by name gets one of 5 hard-coded TriOsc patches (`electron/mcp/tools/instruments.ts`).
   - Krypt Wave (unison, wavetables) and Krypt FM are never chosen by default.
   - Every sound is designed from raw knobs on every song, by a model that cannot hear.
2. **11 factory samples:** one kick, one snare and so on. Every beat sounds the same.
3. **No transition material:** no risers, impacts, sweeps or reverse cymbals. EDM and pop lean on these.
4. **Style cards are thin.** The 9 cards in `electron/mcp/prompts.ts` are a few lines each, and none of them include a mix, sounds or a section-by-section plan.
5. **"Render and listen" is optional.**
   - `render_preview` and `compare_to_reference` exist, but no workflow requires them.
   - Nothing checks the arrangement: transitions, static loops, energy contrast.

## Why not "mass-gather music and fine-tune"?

- **The composer is the user's Claude.** We can't fine-tune it, and it doesn't learn between sessions.
- **Training our own model on downloaded music is off the table.** The labels sued Suno and Udio over exactly this, and an MIT project must not ship weights like that.
- **The legal "gather" already exists:** the reference library, fed with the user's own music folder.

So this wave raises quality through:
- better raw material: presets and samples;
- proven structure: playbooks;
- a mandatory self-review loop.

## Pieces and owners

All contracts were written by the lead before the agents started, so don't change their shape; additive fields are fine:
- `shared/sounds/{types,genres,schema,select}.ts`
- `shared/playbooks/types.ts`
- `shared/commands/presets.ts` (args only)
- the `window.krypt.sounds` section of `shared/types.ts`
- `electron/sounds/types.ts`

Agents share one tree with no worktrees. Edit only the files you own. If you need a change in a file someone else owns, write it into your final report instead.

| Agent | Owns | Delivers |
|---|---|---|
| **rust-sounds** | `engine/crates/dsp/src/factory.rs` (+ a new `factory/` module dir), `engine/crates/engine/src/main.rs` (only the `--gen-factory` path), the factory part of `scripts/engine-build.mjs` | ~200 Krypt-original samples + `resources/factory/index.json` |
| **sounds-core** | `shared/commands/presets.ts` (run bodies), `electron/sounds/**` (except types.ts), `electron/mcp/tools/presets.ts`, `electron/mcp/tools/instruments.ts`, the `find_samples` part of `electron/mcp/tools/discovery.ts`, the sounds IPC handlers in `electron/ipc.ts`, the wiring in `electron/main.ts`, `test/sounds-*.test.ts` | Preset service, commands, 4 MCP tools, default sounds by role and genre, smarter `find_samples` |
| **sound-designer** | `shared/sounds/factory/instruments/**`, `scripts/audition-presets.mjs`, `test/presets-factory.test.ts` | ~160 instrument presets, auditioned through the engine |
| **playbooks** | `shared/playbooks/*.ts` (except types.ts), `shared/sounds/factory/chains.ts`, `test/playbooks.test.ts` | 18 genre playbooks + ~30 chain presets |
| **craft-tools** | `electron/mcp/tools/craft.ts`, `electron/mcp/prompts.ts`, `electron/mcp/server.ts` (prompt registration only), a helper export in `electron/mcp/tools/hearing.ts`, `docs/MCP.md`, `test/craft-*.test.ts` | `get_playbook`, `review_song`, `add_transition`; one-prompt workflow in the prompts + SERVER_INSTRUCTIONS |
| **ui-sounds** | `src/sounds/**` (new), preset UI in `src/panels/plugin/PluginPanel.tsx`, `src/panels/mixer/**`, `src/panels/browser/Browser.tsx`, `src/home/**` Sounds screen, `src/guides/**` (one new article), `src/dev/mockSounds.ts`, `test/sounds-ui.test.ts` | Preset picker, Browser Presets / Sounds, Save preset, Home Sounds screen |
| **gather** | `research/11-sound-sources.md`, `scripts/grooves/**`, `shared/grooves/**`, the groove op in `shared/commands/noteTools.ts` + the `transform_notes` / piano-roll wiring that op needs, `test/grooves.test.ts`, the datasets section of `scripts/gen-notices.mjs` | Licence-checked source report; groove templates from the Groove MIDI Dataset (CC BY 4.0); a `groove` note op |

Final MCP tool names: `find_presets`, `load_preset`, `save_preset`, `apply_chain` (sounds-core) and `get_playbook`, `review_song`, `add_transition` (craft-tools). That takes the count from 63 to **70**. The lead updates the count assertions in `test/mcp-tools.test.ts` and `test/vocals.test.ts`, plus the README and docs headings, at integration. Until then, those count assertions are expected to fail.

## Key rules for every agent

- **Licensing:** MIT-compatible only. No GPL/AGPL code, no NC data.
- **Factory material is Krypt-original:**
  - samples are synthesised by our own engine;
  - presets are designed by us;
  - patterns are original idioms, never a known song's riff.
- **Names:**
  - no other products' names or trademarks, e.g. no "909", "TR-", "Serum", "Sylenth", "Nexus", "Auto-Tune", "OTT", "LinnDrum", "Splice";
  - generic words are fine: 808, supersaw, reese, pluck, stab;
  - never put artist names in presets, playbook targets or samples.
- **Presets ask by role.** Playbooks and tools ask for a ROLE + genre + tags and resolve it with `shared/sounds/select.ts`. Never hard-code a preset id outside the preset data.
- **No silent failures:** every tool and UI action ends in a sentence the user can read.
- **Before calling work done:** `npm run typecheck` and `node scripts/run-tests.mjs` must pass, except the 63→70 count assertions.
- **Don't disturb the user's running app:**
  - never run `npm run build`, `npm run engine:build` or `npm run dev`;
  - never kill electron or engine processes.
  - Rust agents use `cargo build` / `cargo test` from the repo root (`--manifest-path engine/Cargo.toml`); the lead runs the release build.

## Integration (lead)

- Release engine build, then factory generation.
- Count updates, `gen-notices`, docs.
- A full e2e in an isolated instance: `/krypt-studio:beat` EDM from one prompt, run through `review_song`, then exported.
