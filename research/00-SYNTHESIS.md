# 00 — Krypt Studio: Research Synthesis & Build Plan

> This document combines the seven research reports in this folder (01–07, about 600 KB, with sources
> cited inside each), produced on 2026-10-11.
> **This file holds the decisions. The numbered reports hold the evidence.** Where reports disagreed,
> §3 records how the conflict was resolved.

| # | Report | One-line takeaway |
|---|---|---|
| 01 | [FL feature map](01-fl-feature-map.md) | FL 2026.1.7 is the target. P0 means "one full beat, start to finish". FL already ships an agent ("Gopher Control"), so our edge has to be depth, not novelty. |
| 02 | [Audio engine](02-audio-engine.md) | A Rust **sidecar** engine. Web Audio measured about 42 ms on this PC with no ASIO or plugins, which rules it out. JUCE and Tracktion fail the license check. |
| 03 | [Plugins & DSP](03-plugins-and-dsp.md) | VST3 (now MIT) and CLAP, out-of-process. No VST2. Plugin editors are owned native windows. Stock DSP comes from Airwindows, Signalsmith and friends. |
| 04 | [MCP & agents](04-mcp-agents.md) | MCP spec 2026-07-28 via TS SDK v2, a Rust stdio shim and a named pipe, about 40 mid-level tools, the **KPN** note notation, and agents that "hear" through `render_preview` analysis. |
| 05 | [Prior art & legal](05-prior-art-and-legal.md) | Build fresh. Every mature DAW is GPL or AGPL. Borrow from Signal (MIT). Use DAWproject (MIT) for interchange. The product name is **"Krypt Studio"**. |
| 06 | [UI architecture](06-ui-architecture.md) | Layered Canvas2D editors, dockview windowing, one DocHost in main, patch-based undo with per-actor groups, and a `.kstudio` zip project file. |
| 07 | [Windows I/O & packaging](07-windows-io-and-packaging.md) | v1 runs on WASAPI, with ASIO added after the license is signed. Static CRT. The sidecar dies with Electron through a Job Object. The hello-sine sidecar was proven on this machine. |

---

## 1. The verdict in one paragraph

Krypt Studio is a **standard Krypt Electron app plus three small native executables**, all written in Rust:

- `krypt-studio-engine.exe` runs audio, DSP and the mixer graph. It also renders headless.
- `krypt-studio-pluginhost.exe` runs sandboxed VST3/CLAP plugins.
- `krypt-studio-mcp.exe` is a stdio relay that agent clients launch.

The **Electron main process owns the single source of truth**: the project document, undo history and the command bus. **The UI and AI agents call the exact same commands**, which is what makes "revert everything the AI just did" a single click.

We build the DAW core ourselves, because no permissive one exists. We assemble it from MIT/Apache crates and keep GPL and AGPL code out entirely.

The differentiator is not "an AI in a DAW", since FL shipped Gopher Control in July 2026. It is **an agent-first host**:
- every edit is undoable,
- agents write music in a notation that is compact for language models (KPN),
- agents can render and analyze what they made,
- and any MCP client can drive it, including Claude Code, Claude Desktop, Cursor and the built-in panel.

---

## 2. Locked decisions

| Area | Decision | Source |
|---|---|---|
| Product name | **Krypt Studio**. npm/exe `krypt-studio`, appId `cc.krypt.studio`, project file `.kstudio`. Never "KryptStudio" in user-facing text (house §12). | 05 §9.1 |
| Shell | House stack unchanged: Electron **44.x**, React 18, TS, Vite + vite-plugin-electron, Tailwind, Zustand, lucide, electron-builder/NSIS, discord-rpc. Do **not** move to Tauri. | 02 §3.4 |
| Audio engine | A **Rust sidecar process**, not a napi addon. Crash isolation, hot rebuild without restarting Electron, and the same binary serves as `--render` for agents and CI. | 02, 07 §4.1 |
| Audio I/O | **v1: WASAPI.** That means cpal shared mode, then our own `windows`-crate backend for IAudioClient3 low-latency shared mode (down to 128 frames) and exclusive mode. **ASIO** sits behind a cargo feature and ships only after Steinberg countersigns the free *proprietary* agreement. Never take the GPLv3 option. | 02, 07 |
| Engine internals | Audio callback with MMCSS. Worker pool runs a compiled mixer DAG. `rtrb` SPSC queues. Retire queue for deallocation. PDC. Sample-accurate events. A PPQ tick tempo map. Swing is applied at event generation. | 02 §6 |
| Source of truth | One **DocHost** in Electron main: normalized schema, zod validation, commands, then patches plus inverse patches, then history. Renderers are replicas, and the engine is a *projection* that receives versioned diffs. **No CRDT in v1.** | 06 §4, 02 §6.11, 04 §6 |
| Undo | Transactions tagged with an actor (user / agent:<client> / engine). A gesture is one group, and an agent turn is one group. Per-actor undo and an AI History panel. Ctrl+Z steps back; it does not toggle the way FL's does. | 06 §4.4, 04 §6.1, 01 §7 |
| UI → engine | A **named pipe** carrying `u32` length plus MessagePack, with types generated from Rust by `ts-rs` into `shared/engine-protocol.gen.ts`. | 02 §5.3 |
| Engine → UI telemetry | A **WebSocket on 127.0.0.1 with a token, direct to the renderer**, carrying 60 Hz binary frames. It bypasses main, so saves and MCP calls can't stall the meters. There is no zero-copy shared memory, because Electron's V8 memory cage blocks it. | 02 §5.3, 07 §4.3 |
| Editors | **Layered Canvas2D** (grid, content, overlay). One rAF loop per OS window. Painters sit behind an interface so WebGL2 can be swapped in. The playhead is a compositor-only DOM element fed by a non-React transport store. | 06 §1 |
| Windowing | **dockview** (MIT core) behind our own `WindowManager` facade, giving FL-style float, dock and detach. Serve the renderer from an `app://` scheme so popouts are same-origin. | 06 §2 |
| Controls | Custom `Knob`, `Fader`, `Slider` and `StepButton` built on one `useParamDrag` hook (FL feel: fine modifier, reset, typed entry, right-click param menu), bound to a `ParamRef`. | 06 §3 |
| Plugins | VST3 (SDK is **MIT since 3.8**) and CLAP (MIT). **No VST2.** Out-of-process in `krypt-studio-pluginhost.exe`: one shared sandbox by default, with an optional per-plugin process. A scanner process keeps a cache and a blocklist. | 03 §0 |
| Plugin GUIs | Native top-level windows **owned** by the Electron HWND, plus a hung-UI watchdog with kill and reload. Every plugin also gets a React generic parameter panel, which is the surface agents use. | 03 §2.6 |
| Stock DSP | Framework-free Rust crates running as engine nodes, with React UIs generated from `ParamSpec`. Exporting them as standalone CLAP/VST3 comes later via nice-plug or clack-plugin. **Not nih-plug** (maintenance mode, GPL VST3 bindings). | 03 §3.1 |
| Time-stretch | **signalsmith-stretch (MIT)** behind a `Stretcher` trait. Bungee (MPL-2.0) is optional. Rubber Band (GPL) is out. | 02, 03 |
| Files / decode / export | Decode: symphonia (MPL-2.0, unmodified). Write WAV with hound plus our own smpl/acid chunks, FLAC with flacenc, MP3 with **Windows Media Foundation** (no LAME), Opus/Vorbis via permissive crates. | 07 §3 |
| MIDI | **The engine owns all devices** (midir). Deny Chromium's `midi` permission: on Windows 10, WinMM ports are single-client. Windows MIDI Services is Windows 11 only. Files go through `midly`. | 06 §6.3, 07 §2 |
| Project format | `.kstudio` zip (`project.json`, `ui.json`, `plugins/*.bin`, optional `samples/`). Atomic writes, an NDJSON op journal for crash recovery, integer `schemaVersion` with migrations, and a relink dialog for missing samples. | 06 §4.6 |
| Interchange | **DAWproject** (MIT) import/export as P1. MIDI import/export at P0. `.flp` import is P3, clean-room only (never PyFLP code). | 05 §8 |
| MCP | Spec **2026-07-28**, while still serving 2025-11-25 clients. TS SDK v2 (`@modelcontextprotocol/server`) runs inside Electron main, with the same `shared/commands` registry as the UI. Primary transport is the **Rust stdio shim to a per-user named pipe**. HTTP on localhost is opt-in only. Ship a `.mcpb` bundle for Claude Desktop. | 04 §0 |
| Agent notation | **KPN (Krypt Pattern Notation)**: FL-style step grids for drums plus note tokens with bar checks. 7–12× smaller than the equivalent JSON, with precise per-bar error messages. The prototype parser is saved in `spikes/research-prototypes/kpn/`. | 04 §10 |
| Agent hearing | `render_preview` runs an offline render and returns LUFS, true peak, band balance, masking, harmony and an energy curve, plus an optional spectrogram PNG. `ask_user` sets up an A/B audition so the human makes the taste calls. | 04 §6.5 |
| Built-in agent | `@anthropic-ai/sdk` in main, with the key stored via `safeStorage`. Default `claude-opus-5-5`, with a picker for Sonnet, Haiku and Fable 5.x. Prompt caching. Local models use the same path through Ollama's Anthropic-compatible endpoint, with a lite tool set. | 04 §8 |
| On-device ML | Inference runs in the Rust sidecar via `ort`/`rten`. Bundled: Basic Pitch, Beat This!, stratum-dsp, ebur128. Optional downloads: HTDemucs/RoFormer stems and ACE-Step 1.5. **Avoid** Essentia, aubio and libKeyFinder (copyleft), and MusicGen (non-commercial weights). | 04 §9 |

---

## 3. Conflicts between reports, and how they were resolved

| Topic | Disagreement | Resolution |
|---|---|---|
| ASIO timing | 02 assumes ASIO via cpal from Spike 1. 07 says ship v1 WASAPI-only. | **v1 ships WASAPI only.** Spike 1 may test ASIO locally (the dev box needs libclang; nothing is distributed). The public ASIO build waits for the countersigned Steinberg agreement. |
| Plugin process model | 02 says plugins load in-engine in v1 and move to a sandbox in phase 2. 03 says out-of-process from day one. | **Out-of-process from the first plugin release (P1).** Plugin crashes are the top real-world DAW crash cause, and FL has no sandboxing, so this is a selling point. The IPC microbenchmark (Spike 4) can still demote trusted plugins to in-engine. |
| MCP shim language | 06's folder tree has a TS `mcp/` stdio package. 04 recommends a ~1 MB Rust shim. | **Rust shim** (`engine/crates/mcp-shim`). It needs no Node runtime for clients and can launch the app. Tool *definitions* stay in TS (`shared/commands` + `electron/mcp/`). |
| Telemetry path | 06 fans telemetry out via main to MessagePorts. 02 sends it engine → renderer over a WebSocket. | **Direct WebSocket** (02). The main thread is the congestion risk, so keep it out of the 60 Hz path. |
| Piano roll origin | 05 suggests vendoring Signal's WebGL editors. 06 recommends our own Canvas2D painters. | **Our own painters** on our own DocHost schema. Signal (MIT) is **reference plus selective vendoring**, for its MIDI file I/O and interaction details, with attribution kept. A 2–3 day look at Signal happens inside Spike 2, not a 1-week vendoring spike. |
| Product name | The brief and the folder say "KryptStudio". | **"Krypt Studio"** in all user-facing text. The repo folder can stay. |
| React version | Signal and the wider ecosystem are moving to React 19. House rule is 18. | **Stay on 18** (KryptEditor's UI kit is 18). Revisit if dockview or another key library drops 18. |

---

## 4. Architecture at a glance

```
 Claude Code / Claude Desktop / Cursor / ...          Built-in Agent Panel (Anthropic SDK, Opus 5.5)
            │ stdio                                                │
   krypt-studio-mcp.exe (Rust shim) ── named pipe ──┐              │
                                                    ▼              ▼
┌──────────────────────── Electron MAIN (Node) ────────────────────────────────┐
│  MCP server (SDK v2) ──┐                                                     │
│  IPC from UI ──────────┼──▶ COMMAND BUS ──▶ DocHost (authoritative project)  │
│                        │     shared/commands   · zod validate · patches      │
│                        │                       · history (actor groups)      │
│                        │                       · journal + autosave          │
│  EngineBridge ◀── render-model diffs (versioned) ◀──┘                        │
│  EngineSupervisor: spawn abs path · heartbeat · restart + resnapshot         │
└──────┬─────────────────────────────┬─────────────────────────────────────────┘
       │ patches (IPC)               │ named pipe: u32 + MessagePack (ts-rs types)
       ▼                             ▼
┌─ RENDERER(S) ───────────────┐   ┌─ krypt-studio-engine.exe (Rust) ──────────────┐
│ Zustand replica of doc      │   │ control thread: apply diffs, compile graph    │
│ dockview workspace          │   │ audio thread (MMCSS) + worker pool: DAG, PDC  │
│ Canvas2D painters, rAF loop │◀──│ telemetry thread ── WS 127.0.0.1 + token ─────┼─▶ meters/playhead
│ React chrome + controls     │   │ disk/decoder/stretch threads · ML (ort)       │
└─────────────────────────────┘   │ --render mode (headless, agents + CI)         │
                                  └───────────────┬───────────────────────────────┘
                                                  │ shared memory + events (same cycle)
                                   krypt-studio-pluginhost.exe (VST3/CLAP sandbox; owned editor windows)
```

## 5. Repository layout (target)

This uses 06 §7 as the base, with the §3 resolutions applied:

```
KryptStudio/
├── electron/            main.ts · preload.ts · ipc.ts (ALL handlers) · windows/ · dochost/ · project/
│                        engine/ (bridge, supervisor) · mcp/ (server + tool wiring) · agent/ (built-in panel)
│                        system/ (ONLY OS-touching code: spawn, files, dialogs, discord, appProtocol)
├── shared/              schema/ (zod + migrations) · commands/ (UI + MCP share these) · kpn/ (parser+printer)
│                        engine-protocol.gen.ts (generated) · keymap.ts · types.ts
├── src/                 workspace/ (dockview) · panels/{channelRack,pianoRoll,playlist,mixer,browser,...}
│                        render/ (frameLoop, painters) · live/ (non-React stores) · controls/ · doc/ · workers/
├── engine/              Cargo workspace: crates/{core, graph, io, dsp, sampler, host-clap, host-vst3,
│                        pluginhost, protocol, render, ml, mcp-shim}  ← built by `npm run engine:build`, never at install
├── .cargo/config.toml   +crt-static (MUST be repo-root; see 07 §0.8)
├── resources/           icons · bin/ (built exes, via extraResources) · factory content (CC0/own only)
├── spikes/              research-prototypes/ (hello-sine, kpn, cpalprobe, ac3probe, latency-bench) + spike work
├── research/            these reports
└── test/                node:assert + esbuild harness (KryptEditor pattern) · engine golden renders
```

**Copy from KryptEditor on day one** (paths in 06 §8.1):
- the UI kit and Tailwind tokens,
- the toast and modal providers,
- atomic writes and protected save paths,
- autosave with backups,
- broadcast-to-all-windows,
- the typed IPC contract, CSP and the test harness.

**Adapt** its timeline drag logic: cursor-anchored zoom, auto-scroll, snapping, marquee select and multi-move. **Don't** carry over its DOM-per-clip timeline or its per-clip waveform canvases.

---

## 6. Roadmap

Effort labels follow 01's scale: S ≤ 1 week, M 1–4 weeks, L 1–3 months, XL more than 3 months. These are estimates for one experienced developer. Agent-assisted development changes the calendar but not the order.

### Phase 0 — De-risking spikes (do these before writing product code)

| Spike | Proves | Pass criteria (abridged; full lists in the reports) |
|---|---|---|
| **S1 Windows I/O + RT core** (02 §8) | A glitch-free audio thread on real Windows devices | 30 min, 0 xruns, with Electron hammering the CPU. Measured RTL table per backend. Zero allocations on the audio thread. Device unplug recovers in under 2 s. |
| **S2 Electron ↔ sidecar loop** (02 §8, 07 §7) | The DocHost → diff → engine loop, telemetry and crash restart | Click-to-audible ≤ 1 block + 2 ms. 60 fps meters with main blocked for 200 ms. `kill -9` of the engine restores in under 1.5 s with no data lost. 1,000 agent ops/s soak with matching hashes. |
| **S3 Graph / PDC / render / stretch** (02 §8) | That multi-core mixing and delay compensation work | ≥ 5× scaling at 256 frames. PDC null test residual below −140 dBFS. Offline render bit-identical and ≥ 20× real time. Topology edits during playback cause no glitches. |
| **S4 Plugin host + owned windows** (03 §5) | That out-of-process hosting is viable | IPC cost per hop at 64 frames. 10 real plugins open as owned windows. A hung plugin UI doesn't freeze Electron input. DPI behaves sanely. |
| **S5 Agent loop** (04 §11 P0) | That an LLM can make a beat through KPN and MCP | Claude Code connects through the shim. A scripted prompt ("2-bar boom-bap, 90 bpm, D minor") produces a valid pattern with fewer than 2 parse errors, and one undo removes it. |

Already proven during research:
- the hello-sine sidecar opens WASAPI at 48 kHz, answers commands, restarts after a crash and leaves no orphan processes;
- the KPN parser works on the examples;
- the latency probes measured this PC.

### Phase 1 — "First Beat" alpha (01 P0)

Includes:
- **Engine:** transport, tempo, pattern/song mode, the sampler, and the full P0 stock set:
  - instruments: TriOsc, Pads, 808;
  - effects: EQ, Comp, Limiter/Clipper, Reverb, Delay, Drive, Filter, Duck/Sidechain, Analyzer.
- **Editors:** Channel Rack and step sequencer (swing, per-step velocity and pan), patterns, piano roll (draw, paint, slice, scale highlighting, velocity lane, quantize), and a playlist with pattern, audio and basic automation clips.
- **Mixer:** dynamic inserts, buses, FX slots and meters.
- **Browser:** preview and drag-and-drop.
- **Input:** typing keyboard and MIDI, with basic recording.
- **Export:** WAV, MP3 and MIDI.
- **Project:** `.kstudio` files with autosave and recovery.
- **Agents:** the MCP shim, about 15 core tools, KPN, the AI History panel with revert, a consent sheet and kill switch, and a Connections page.
- **House non-negotiables:** Discord RPC, the krypt.cc links, the dark Krypt look, and no silent failures.

### Phase 2 — Producer-ready beta (01 P1)

- VST3/CLAP hosting with the sandbox and scanner.
- Time-stretch and tempo-following audio clips.
- Audio recording with latency compensation.
- DAWproject import/export.
- The full MCP tool catalog, `render_preview` with analysis, the built-in agent panel with cost meter, and the `.mcpb` bundle.
- Stock plugins: Slicer, Gate/Time (our Gross Beat-style effect), Mod FX.
- ASIO, once the license is signed.
- Low-latency and exclusive WASAPI backends.
- Code signing.

### Phase 3 — FL parity (01 P2)

- Take lanes and comping.
- Freeze/bounce in place.
- A Patcher-style modular routing environment.
- FM and wavetable synths, vocoder, real-time tune.
- Stem separation and audio-to-MIDI. **Pulled forward as Wave 3** together with reference memory, style focus and vocals: see `08-ears-references-vocals.md`.
- Multi-agent roles (producer, sound designer, mix, master).
- `ask_user` A/B auditions.
- Opt-in HTTP MCP.
- A performance mode.

### Phase 4 — Beyond (01 P3)

- A Newtone-class pitch editor. Monophonic only until the Celemony patent expires in 2029.
- Clean-room `.flp` import.
- MCP Apps inline piano-roll previews.
- Optional generative models such as ACE-Step.
- Collaboration via CRDT; the op format is already compatible.

---

## 7. Guardrails (CI-enforced from the first commit)

1. **License gate:**
   - `cargo-deny` and `license-checker --production`.
   - Allowed: MIT, Apache-2.0, BSD-*, ISC, Zlib, 0BSD, Unlicense, CC0, and MPL-2.0 for listed crates only.
   - Denied: GPL-*, AGPL-*, SSPL. LGPL needs manual sign-off.
2. **Never put GPL/AGPL source in an agent's context** while it is writing our code (Surge, Vital, LMMS, openDAW, PyFLP, Tracktion). Keep provenance logs for vendored files and factory content.
3. **Static CRT** (`+crt-static`) in a **repo-root** `.cargo/config.toml`.
4. **Audio-thread rules:** `assert_no_alloc` in debug builds, plus an RT-safety test on every DSP node.
5. **Golden renders:** `krypt-studio-engine --render` on fixture projects must be bit-identical across runs. This doubles as an MCP regression test.
6. **No FL trade dress:** no Image-Line, "Fruity" or FL plugin names, skins or sounds. Copy the function, not the look (01 §9, 05 §9).

---

## 8. Decisions that need **you**

1. **ASIO agreement.** Do you want to sign Steinberg's free proprietary ASIO agreement? It's required for ASIO in an MIT app. It also rules out SignPath's free open-source code signing.
2. **Code signing route:** Azure Artifact Signing ($9.99/mo; individuals must be in the US or Canada), Microsoft Store MSIX (free and no SmartScreen warnings, but Store packaging), or ship unsigned like the other Krypt tools for now.
3. **Scope of "full FL features".** Phase 1 → 3 is a long road, and the report sizes several items as XL (over 3 months each). Do you agree with "First Beat alpha" as the first public milestone?
4. **Trademark search** for KRYPT / KRYPT STUDIO (Classes 9 and 42) before public launch. The reports found no conflicting audio product, but no formal search was done.
5. **The built-in agent's billing model.** Bring-your-own API key (as recommended), or a Krypt-hosted proxy? A proxy adds cost and violates nothing, but the house rule is no telemetry.

## 9. Top risks

| Risk | Mitigation |
|---|---|
| Building the DAW core from scratch is the biggest schedule risk (no Rust DAW engine to adopt) | Spikes S1–S3 first. Small node API. Borrow *designs* (Tracktion graph docs, Firewheel, CLAP semantics). |
| Windows driver variance: many USB devices are stuck at 10 ms in shared mode | Four I/O backends with auto-probing. Honest latency readout in the UI. Recommend ASIO or exclusive mode. |
| A hung plugin UI freezes Electron input (owned windows share input queues across processes) | Watchdog with kill and reload. Per-plugin fallback to unowned windows. Tested in S4. |
| The DocHost model and the engine's projection drift apart | Generated types, versioned acks, periodic hash checks with auto-resnapshot, and soak tests. |
| Main-process congestion (MCP + saves + diffs) | Telemetry bypasses main. Patch coalescing. Move DocHost to a `utilityProcess` if long tasks exceed 50 ms. |
| No VST2 annoys FL users with old freeware | Clear Plugin Manager messaging, and auto-map VST2 IDs via moduleinfo later. |
| Agents reporting success for edits that didn't happen (the most common music-MCP bug) | Every tool returns `{ok, message}` plus the changed object revisions; nothing is ever silent (house §11). |

## 10. Research gaps (marked "(unverified)" in the reports)

- The shared web-search quota ran out during research. Several items were completed from primary sources fetched directly; a few remain from memory, and the reports say which.
- The latency numbers in 07's table are buffer maths plus estimates. 02's numbers *were* measured on this machine. S1 produces the real RTL table.
- Not yet checked: Steinberg's ASIO agreement procedure, REX SDK terms, AAC patent status, whether electron-builder signs `extraResources` exes, the exact FL typing-keyboard key map, and FL's mouse-wheel-on-knob behaviour.
