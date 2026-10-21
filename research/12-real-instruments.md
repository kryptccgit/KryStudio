# 12: Real instruments (Wave 5): sound packs + Krypt Multisampler

**Goal:** real sampled piano, acoustic drums, strings, mallets and keys, so pop, R&B, lo-fi, soul and cinematic prompts sound recorded rather than synthesised. Our synth approximations of piano, e-piano, strings and flute work in chords but are weak when exposed (Wave 4 sound-designer report).

**Decisions** (lead, 2026-10-12; the user authorised "if it makes it better, do it — MIT, no selling"):
- **D1: yes.** Third-party **CC0 / public-domain** recordings may ship as content, credited in THIRD-PARTY-NOTICES and in each pack's LICENSE.txt.
- **D2: optional downloads, never in the installer.** The user clicks Download and agents never download, the same as for models. Each file is pinned by URL + SHA-256 + size.
- **D3: no Freesound integration.** Its API terms rule out bulk use.
- **D4: credit public-domain items anyway**, and archive the informal statement text inside the pack (`PackLicence.statement`).

Sources are in `research/11-sound-sources.md` §2(a): VSCO-2 CE (CC0), VCSL (CC0), the Karoryfer free kits (CC0, from the `sfzinstruments` GitHub mirrors), Salamander Grand Piano + Drumkit (public domain since 4.3.2022), and Upright Piano KW (CC0, to verify).

## 1. Contracts (written by the lead, don't change their shape)

- **`shared/packs/types.ts`:** PackDef, PackFile, PackSfz, PackLicence, PacksState, the `pack:` path scheme (`parsePackPath`) and `SFZ_OPCODES`, the subset the engine plays.
- **`shared/packs/catalog.ts`:** `PACKS` (filled by packs-content).
- **InstrumentPreset gains `requires?: string`,** a pack id (`shared/sounds/types.ts` + schema). Presets for pack instruments use plugin `krypt.multisampler` and `sample: 'pack:<id>/<…>.sfz'`.
- **`window.krypt.packs`** in `shared/types.ts`: state, onState, install, cancel, remove, reveal. IPC channel names are in `electron/channels.ts`; the preload is wired.
- **New MCP tool `list_packs`** (read), which brings the count to **71**. It lists the packs, their status and the instruments they add. Agents tell the user what to download and never download.

## 2. Krypt Multisampler (engine)

New stock instrument id **`krypt.multisampler`**, name "Krypt Multisampler", `usesSample: true`. Its `generator.sampleId` points at a SampleRef whose path is an `.sfz` file (`pack:…`, an absolute path, or a project-relative path).

**Params** (ids are fixed by this contract; `%` params are plain fractions per the house rule, as everywhere in the catalog):

| id | range | default | notes |
|---|---|---|---|
| `gain` | -24..12 dB | 0 | |
| `attack` | 0..2000 ms | 0 | added to region attack |
| `release` | 0..4 (shown as 0..400 %) | 1 | scales region `ampeg_release` |
| `velSens` | 0..1 (shown as %) | 1 | scales `amp_veltrack` |
| `tone` | 200..20000 Hz, log | 20000 | low-pass |
| `tune` | -24..24 st | 0 | |
| `fine` | -100..100 ct | 0 | |
| `releaseSamples` | 0..1 (shown as %) | 1 | level of `trigger=release` regions |
| `width` | 0..1 (shown as %) | 1 | 0 = mono |
| `roundRobin` | Off \| On | On | |

**Loading** happens off the audio thread:
- Parse the SFZ subset. `#define $X v` is supported; `#include` is not; unknown opcodes are ignored and counted in one warning.
- Decode every region's sample with `dsp::decode` (WAV / FLAC / OGG …) from `offset` to `end` (frames), so authored mappings control RAM.
- Store samples as i16 interleaved in an `Arc`. The sample-rate ratio goes into the playback increment.
- Report the load time, the region count and RAM.
- A missing pack or file means an engine warning that names the pack. The channel stays silent and the project still loads.

**Playback:**
- Per voice: region selection by key, velocity, round robin (`seq_length` / `seq_position`, `lorand` / `hirand`), velocity crossfades (`xfin` / `xfout`), `group` + `off_by` choke, `loop_mode` (`no_loop`, `one_shot`, `loop_continuous`, `loop_sustain`), DAHDSR, release-trigger regions with `rt_decay`, and pitch with high-quality interpolation (reuse the sampler's).
- The sustain pedal is out of scope for v1. Agents write note lengths.
- No allocation on the audio thread: voices are preallocated and the sample data is an `Arc` swapped in by the control thread.

**Path resolution:** `pack:<id>/<path>` resolves against a packs dir, passed to the engine as `--packs-dir <dir>` (CLI render and stdio mode). Main passes `userData/packs`. `samples.rs` `resolve_path` handles the scheme next to `factory:`.

**Tests:**
- SFZ parsing (headers, inheritance, defines, unknown-opcode count);
- region selection;
- round robin;
- crossfades;
- choke groups;
- release triggers;
- the RAM cap honoured;
- pitch accuracy;
- no allocation on the RT path (`tests/rt_alloc.rs` pattern);
- a CLI render of a tiny generated SFZ kit.

## 3. Packs (content)

The packs-content author picks 3–5 packs with the highest value for beats, keeping each download modest:
- a **grand piano**: Salamander, 4–5 velocity layers, every minor third, release samples optional, ≤ ~300 MB;
- an **acoustic drum kit**: one Karoryfer CC0 kit or the Salamander Drumkit, one mic mix, ≤ ~200 MB;
- **orchestral essentials**: VSCO-2 CE strings ensemble sustain + staccato, a brass section, flute, harp, glockenspiel, timpani;
- **keys & mallets**: VCSL or VSCO-2 CE: vibraphone, marimba, celesta, music box; an upright or electric piano only if CC0.

For each pack:
- **Licence:** verify it from the primary source, at a pinned upstream revision. Prefer GitHub at a pinned commit, through raw or LFS media URLs. Check whether files are Git LFS objects and use `media.githubusercontent.com` URLs when they are.
- **Manifest:** list only the files our mapping uses. Download them once to compute SHA-256 and sizes; do that in the session scratchpad, never inside the repo.
- **Mapping:** write our own SFZ using only `SFZ_OPCODES`, with `end=` trims that keep RAM under about 250 MB per instrument (`ramMb`).
- **Presets:** add `krypt.multisampler` presets with `requires: <packId>` (role, genres, `defaultFor` where the real instrument should win once installed, e.g. piano in lofi / rnb / pop). Put them in `shared/sounds/factory/instruments/packs.ts`, registered in the instruments index.
- **Tests and notices:** add `test/packs-catalog.test.ts`, and credits in `scripts/gen-notices.mjs`.

## 4. Packs app (main + UI)

**`electron/packs/**` service:**
- Download per file into `userData/packs/<id>.partial/`, with progress events, cancel and per-file resume (skip files whose hash already matches), trying mirrors in order.
- Verify SHA-256 and write the SFZs and LICENSE.txt. Rename atomically to `userData/packs/<id>/` and write `pack.json` (`{id, version, installedAt}`).
- `remove` deletes only that pack's directory.
- Report `update` when the installed version is older than the catalog's.
- Wire it in `main.ts` and `ipc.ts`.
- **Path resolution:** main resolves `pack:` paths in `ProjectService.resolveSamplePath` (and its friends) and starts the engine with `--packs-dir` (see `electron/engine/*` launch args).

**Sounds service:**
- presets whose `requires` pack isn't installed are kept out of agents' defaults (`chooseInstrument`, `get_playbook`) and are listed as "needs the <pack> pack";
- `find_presets` shows them with that note;
- `load_preset` on one says which pack to download.

**MCP:** `list_packs` (read).

**UI:**
- **Home ▸ Sounds:** a "Sound packs" section: a card per pack with size, RAM, licence (shown before download), contents, Download / Cancel / Remove, and progress.
- **Preset browser:** pack presets show a small "Download pack" affordance when the pack is missing.
- **Guides:** a paragraph in the Sounds & presets guide.

**Tests:** service with a local HTTP fixture server (hash mismatch, resume, cancel, atomic install), path resolution, preset gating, and the tool.

## 5. Ownership (Wave 5)

| Agent | Owns |
|---|---|
| **rust-multisampler** | `engine/crates/dsp/src/instruments/multisampler/**` (new) + its catalog registration (`dsp/src/catalog.rs`, `instruments/mod.rs`), `engine/crates/engine/src/samples.rs` (`pack:` resolution), the `--packs-dir` arg in `engine/crates/engine/src/main.rs` (+ wherever stdio mode builds its env), `docs/ENGINE_PROTOCOL.md` (a note), `shared/plugins/catalog.gen.json` (regenerated with the debug engine `--dump-catalog`), Rust tests |
| **packs-content** | `shared/packs/catalog.ts` (+ `shared/packs/data/**`), `shared/sounds/factory/instruments/packs.ts` + one line in `instruments/index.ts`, `test/packs-catalog.test.ts`, `scripts/packs/**` (manifest tooling), the pack credits in `scripts/gen-notices.mjs` |
| **packs-app** | `electron/packs/**`, the packs parts of `electron/main.ts` / `ipc.ts` / `electron/engine/*` launch args / `electron/project/service.ts` `resolveSamplePath`, `electron/sounds/service.ts` (gating only), `electron/mcp/tools/packs.ts` (new; register in `tools/index.ts`), `electron/mcp/tools/instruments.ts` + `craftRecipe.ts` (gating only), `src/home/**` (Sound packs section), `src/sounds/**` (pack affordance), `src/dev/mockPacks.ts`, `src/guides/articles.ts` (one paragraph), `docs/MCP.md` (`list_packs` row; the lead fixes counts), `test/packs-*.test.ts` except catalog |

The rules from `research/10-sound-and-craft.md` ("Key rules for every agent") apply unchanged.
