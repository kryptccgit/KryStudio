# Wave 12.2: Ableton parity (written 2026-10-14)

Roadmap: `research/13-roadmap.md` § Wave 12.2. This wave builds:
- the clip launcher (Session view);
- warp markers and warp modes;
- racks with macros, plus the drum rack and the slicer;
- five new or upgraded devices.

Take lanes and comping (8.7) move to Wave 12.2b. They touch the recorder and the playlist, which this wave already has three agents in.

**Rule for the whole wave:** every capability is also an MCP tool or an argument on one, and every mutation is a `shared/commands` command.

## 1. Agents

| Agent | Area | Cargo target dir |
|---|---|---|
| launcher-engine | Rust: launcher playback, quantize, follow actions, launch recording, MIDI grid intercept | `engine/target-rec` |
| launcher-app | TS: `session.*` commands, MCP tools, main/IPC, launch-record capture, grid layouts | — |
| launcher-ui | React: the Session view panel | — |
| warp-engine | Rust: warp maps and the 5 warp modes in the variant renderer | `engine/target-str` |
| warp-app | TS + React: warp commands, auto-warp, MCP `warp_clip`, the marker editor | — |
| racks-engine | Rust: `krypt.rack` / `krypt.drumrack` / `krypt.fxrack` with macros | `engine/target-plug` |
| racks-app | TS + React: rack commands, macros/variations, presets as racks, slice-to-pads, MCP, rack + pad UI | — |
| devices | Rust dsp: Heat, Tape Echo, Grain, Glue, a vocoder upgrade, and a sampler `end` param | `engine/target-dsp2` |

## 2. Contracts (written by the lead, already in the tree)

These files are the contract. Read them and implement exactly; if one is wrong, report it, don't silently diverge.
- `shared/schema/launcher.ts`;
- `shared/schema/warp.ts`;
- `shared/schema/rack.ts`;
- the additions in `shared/schema/project.ts`: `Generator.warp`, `Generator.rack`, `FxSlot.rack`, `Project.session`, and the zod and integrity checks;
- `shared/engine/protocol.ts`: the entity kinds `scene` / `launchClip` / `session`, the launcher cmds, the `launchRecorded` event, `TelemetryFrame.launcher`;
- `shared/engine/projection.ts`: the session entities;
- `shared/types.ts`: `KryptApi.session` and `LaunchGridSettings`, plus `electron/channels.ts` (the `session*` channels) and the preload bindings;
- Rust: `engine/crates/engine/src/model_ext.rs`, plus `Model.{scenes, launch_clips, session}`, `Generator.{warp, rack}` and `FxSlot.rack` in `model.rs`.

All schema additions are optional, so a project with none of them is unchanged and needs no migration.

### 2.1 Clip launcher

**Grid.** The grid has one column per playlist track and one row per scene.
- A `LaunchClip` is a pattern or an audio-clip channel, with:
  - a loop length and offset;
  - a launch mode (trigger / gate / toggle / repeat);
  - an optional per-clip quantize and follow rule.
- There is at most one clip per slot.

**Launching** (engine):
- A launch takes effect at the next quantize boundary.
- Quantize grid: song mode uses the song timeline (bars from tick 0); pattern mode uses ticks since play started.
- The clip loops from its `offset` for `length` ticks, or plays once when `loop: false`, after which the track stops.
- Launching while the transport is stopped starts the transport in song mode from the current position, with no quantize wait.
- A pattern launch clip plays that pattern's notes on their own channels, as pattern clips do. An audio launch clip triggers its `krypt.audioclip` channel the way playlist audio clips do, including the stretch/warp variant.
- If two launch clips on different tracks play the same pattern, both sound. That is the same as two playlist clips.

**Override.** While a track plays a launch clip (or after it was stopped from the launcher), that track's arrangement clips are silent: the track is "overridden". `backToArrangement` clears every override.

**Follow actions** run after `afterBars` bars:
- `chance` picks between `action` and `otherAction`.
- The RNG is deterministic per transport start, seeded from the clip id.
- next / previous skip empty slots and wrap. `any` may pick the same clip again; `other` never does.

**Scenes.** `launchScene` launches each track's clip in that row and stops tracks with none. Main applies `Scene.tempo` as a doc edit through `transport.setBpm`.

**Launch recording:**
- With `setLaunchRecord {on}` and the transport playing in song mode, the engine logs `LaunchRecordEntry` spans.
- On stop or switch-off it emits `launchRecorded`.
- main runs `session.capture` (one undo group) to write them into the playlist:
  - the track's existing clips in that span are removed, clipped or split;
  - new pattern or audio clips are placed with the right offset.

**Telemetry.** `TelemetryFrame.launcher` (only when launch clips exist) carries:
- `playing` / `queued` / `progress` / `overridden` / `recording`.

**Grid controllers:**
- main turns `LaunchGridSettings` into a `setLaunchGrid` note map (the layouts are in `shared/types.ts`).
- The engine swallows matching note-ons and note-offs from that device and channel, so they don't play the MIDI target, and launches instead.
- There is no LED feedback in v1: the engine has no MIDI out. Say so in the UI.

**Offline render** ignores the launcher and always renders the arrangement.

**Commands** (`shared/commands/session.ts`, launcher-app):
- `session.addScene`, `session.removeScene`, `session.setScene` (name / color / tempo), `session.moveScene`;
- `session.setClip` (create or replace a slot from `{patternId}` or `{channelId}`; defaults: length = the pattern length, or the audio clip's length at the current tempo, rounded up to a bar; loop on; trigger; color null);
- `session.updateClip`, `session.removeClip`, `session.moveClip` (`copy` flag);
- `session.setQuantize`;
- `session.fromArrangement` (one scene per section between markers, or every N bars without markers; each track's clip at that time becomes its slot);
- `session.scenesToSong` (a scene order with bars each, written into the playlist);
- `session.capture` (`LaunchRecordEntry[]`).

Deleting a track, pattern or audio channel also removes the launch clips that reference it, through hooks in those commands.

**MCP:**
- `build_session`: scenes with clips by track and pattern/channel name; or `fromArrangement`; quantize; follow rules.
- `launch`: `{scene | clip | stop | backToArrangement | record}`.
- `get_project` mentions the session (scenes, clip count).

### 2.2 Warp

`Generator.warp` on `krypt.audioclip` channels is described in `shared/schema/warp.ts`: the semantics, the modes, and marker ordering.

**Engine:**
- The variant key includes the warp map, so any change re-renders off the audio thread, as stretch does today.
- With 2 or more markers, the markers define the piecewise timing at the current project bpm, and they override `stretch` / `tempo_sync` / `src_bpm`.
- **Modes:**
  - `complex` = today's Signalsmith path;
  - `tones` = Signalsmith with settings for monophonic pitched material;
  - `beats` = transient (or grid) slices: each plays at original speed from its warped start, cut with a `beatsFadeMs` fade, so the gaps are silent at slow tempos and slices are cut short at fast ones;
  - `texture` = granular overlap-add, with `grainMs` and `flux` random position jitter;
  - `repitch` = varispeed resample, where the pitch follows the speed and the Stretch group's pitch is ignored.
- Identity (no warp, or ratio 1 / 0 st in complex) must stay bit-identical to today.
- A warp map that isn't valid (not strictly increasing) falls back to the Stretch params, with a warning.

**Commands** (`shared/commands/warp.ts`, warp-app):
- `audio.setWarpMode`;
- `audio.addWarpMarker`, `audio.moveWarpMarker`, `audio.removeWarpMarker`, `audio.clearWarp`;
- `audio.autoWarp`. Args: beat times in seconds plus an optional downbeat index. It writes one marker per bar, or per beat with `{every: 'beat'}`, and picks a mode: drums → beats, a single voice → tones, else complex. The caller passes `{hint}`, which comes from the analyzer.

Commands do no I/O. main runs the analyzer's beat tracking and passes the times in.

**MCP:** `warp_clip {clip, mode?, auto?: true, markers?: [{sec, beat}], clear?}`.

**UI:** warp markers on the audio clip waveform (the clip's channel / plugin panel waveform and the playlist clip), with:
- drag to move;
- double-click to add;
- right-click to remove;
- a mode picker;
- an "Auto-warp" button that shows progress and toasts the result.

### 2.3 Racks, macros, drum rack, slicer

The data is in `shared/schema/rack.ts`.

**Plugin ids:**
- `krypt.rack` (instrument), `krypt.drumrack` (drum) and `krypt.fxrack` (effect slot) are stock catalog entries.
- Each has params `macro1`..`macro8` (0..1, default 0, automatable, group "Macros"). That way automation, `set_params`, controller links and MIDI learn reach macros unchanged.

**Engine:**
- An instrument or drum rack routes each note to every chain whose zone contains the key and velocity, sums the chains (volume and pan), and runs each chain's devices.
- Drum-rack chokes: a pad cuts other pads in the same choke group > 0.
- An effect rack splits its input into every chain and sums the outputs. The slot's `mix` is the rack's wet/dry.
- Solo works within a rack: any soloed chain mutes the unsoloed ones.
- **Macros:** each block, a macro value maps onto its targets in normalized space, through the catalog `ParamSpec` scale.
- Doc edits to inner params or macros must not re-instantiate the rack or click. Structural changes (chains or devices added or removed) may rebuild.
- Stock devices only. A third-party or nested rack inside a rack is skipped, with a warning.
- Inner samples load like channel samples.
- Offline render, stems and PDC all work.

**Commands** (`shared/commands/racks.ts`, racks-app):
- `rack.create` (wrap a channel's current instrument + nothing, or a slot's effect, into a rack; or a new empty rack);
- `rack.addChain`, `rack.removeChain`, `rack.setChain` (name / volume / pan / mute / solo / zone / choke), `rack.moveChain`;
- `rack.setInstrument`;
- `rack.addDevice`, `rack.removeDevice`, `rack.moveDevice`;
- `rack.setDeviceParams`, `rack.setInstrumentParams`;
- `rack.mapMacro`, `rack.unmapMacro`, `rack.renameMacro`;
- `rack.storeVariation`, `rack.recallVariation`, `rack.removeVariation`;
- `rack.randomizeMacros`, seeded;
- `rack.drumPad` (set a pad's sample by note);
- `rack.sliceToPads`. Args: a sample plus slice times. It builds a drum rack with one pad per slice (sampler with `start`/`end` normalized), and optionally a pattern that replays the loop. Slice times come from the analyzer onsets, a grid, or manual times. The command is pure; main computes the onsets.
- Macros are set through the normal param path, `channel/<ch>/gen/macroN` or `insert/<i>/slot/<s>/macroN`.

**Presets:** a channel preset or effect preset may contain a rack; `save_preset` / `load_preset` round-trip it. Factory rack presets: at least 4 (a layered keys rack, a drum kit rack, a "lo-fi" fx rack with macros, a vocal chain fx rack).

**MCP:**
- `build_rack` (build one in one call: chains, instruments by preset/plugin, devices, zones, macro maps);
- `set_macro` (by macro name or index; also variations);
- `slice_to_pads` (sample or audio clip → drum rack + pattern).

**UI:**
- the rack editor: a chain list with volume / pan / mute / solo / zone, and per chain its instrument + devices with knobs; 8 macro knobs with names, map by right-click on any inner knob → "Map to macro N"; variations;
- the drum-rack 4×4 pad view: drop samples on pads, click to audition, choke group, per-pad chain;
- "Slice to pads" from an audio clip / browser sample context menu.

### 2.4 Devices (stock, `engine/crates/dsp`)

| id | Name | What |
|---|---|---|
| `krypt.heat` | Krypt Heat | Multiband (3-band, Linkwitz-Riley crossovers) saturator. Per band: drive, shape (soft, tube, tape, hard, fold, rectify, bitcrush), level; plus mix and output. Oversampled. |
| `krypt.tapeecho` | Krypt Tape Echo | Tape delay. Tempo sync, feedback with saturation, wow and flutter (modulated read head), age (band-limit + noise), ping-pong, freeze. |
| `krypt.grain` | Krypt Grain | Granular / spectral. Grain delay and freeze: grain size, density, pitch, spray, reverse chance, feedback; a spectral blur / smear mode. |
| `krypt.glue` | Krypt Glue | VCA-style bus compressor. Ratio 2/4/10, attack 0.1–30 ms, release 0.1–1.2 s + auto, threshold, makeup, sidechain HPF, range, mix. Sidechain input like Krypt Comp. |
| `krypt.vocoder` | (upgrade) | More bands (up to 40), formant shift, a built-in carrier synth (saw / noise / chord from MIDI is NOT possible on an insert, so saw + noise at a set pitch), unvoiced/sibilance pass-through, band release. Keep its id and old params, and keep old projects sounding the same at default values. |
| `krypt.sampler` | (`end` param) | `end` 0..1, default 1, so slices can stop. |

Rules for the devices:
- no allocation, locks or I/O on the audio thread;
- denormal-safe;
- NaN guard;
- a latency report if there is lookahead;
- a reset on transport stop;
- `quiet_frames` eligibility set correctly (tails!).

Each gets catalog descriptors with descriptions, a few factory presets in the existing effect-preset location, and tests: impulse/sine sanity, finite output, bypass/mix identity at 0, CPU budget per 128-frame block.

## 3. Ownership (who edits what)

**Shared contract files** (§2) are owned by the lead. To change one, ask in your report. Small additive helper functions in them are OK if the other side needs them; say so.

**Rust files edited by more than one engine agent:**
- `compile.rs`, `core.rs`, `control.rs`, `protocol.rs`, `telemetry.rs`, `tests.rs`;
- `docs/ENGINE_PROTOCOL.md`: launcher = new §10, warp = in §4 audio clips + §11, racks = §12.

Rules for those files:
- keep your edits small and localized;
- put your logic in your own new module (`launcher.rs`, `warp.rs` / in variants, `rack.rs`);
- re-read the file right before each edit (others edit concurrently);
- never reformat a file;
- never revert or "fix" others' code. Report it instead.

**Shared TS files:**
- `shared/commands/registry.ts`, `electron/mcp/tools/index.ts`, `src/workspace/panels.ts`, `src/guides/articles.ts`, `electron/ipc.ts`: append-only, small edits.
- `shared/schema/params.ts`: racks-app only.
- `shared/sounds/*` presets: racks-app only.
- The devices agent owns `engine/crates/dsp/**`, except `dsp/src/catalog*` rack entries, which belong to racks-engine (coordinate by appending).

**Generated file:** `shared/plugins/catalog.gen.json` is GENERATED. Never hand-edit it. The lead regenerates it at integration. Until then, TS tests that need the new plugins use a fixture catalog.

## 4. Rules for every agent

- Read `CLAUDE.md`, `../kryptguidelines.md` (UI agents) and this file first.
- **Hard rules:**
  - MIT-compatible dependencies only;
  - no GPL code or ports (no Ableton or FL trade dress or names: "Session view" and "Drum rack" are generic terms; never "Simpler", "Max for Live", "Push");
  - no silent failures (toasts, `{ok, message}`);
  - Krypt UI kit: Chakra Petch, `bg-krypt-void`, `border-white/10`, lucide icons, gradient as accent only;
  - every mutation goes through a command.
- **Never** run `npm run build`, `npm run engine:build`, `npm run dist` or `npm run dev`. The user's app and MCP shims are running.
  - Build Rust only with your own `CARGO_TARGET_DIR` (§1), from the repo root: `CARGO_TARGET_DIR=engine/target-xxx cargo test --manifest-path engine/Cargo.toml -p <crate>`.
  - Never kill processes.
- Before you finish, run `npm run typecheck && npm test` (TS), or your crate's tests (Rust). Other agents work at the same time, so a failure in someone else's file is reported, not fixed.
- **Report** (under 450 words):
  - what you built;
  - the exact test counts;
  - deviations from the contract;
  - what the other agents or the lead must know;
  - anything untested.
