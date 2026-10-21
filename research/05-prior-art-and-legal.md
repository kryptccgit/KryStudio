# 05 — Prior Art, Fork-vs-Build, Interchange Formats & Legal

> KryptStudio kickoff research, topic 5 of 7. Researched **2026-10-11**.
> Repo facts (license, last push, stars, releases, 90-day commit counts) were pulled live from the
> GitHub REST API, the Codeberg API, crates.io and the npm registry on that date. Legal and SDK facts come
> from primary sources where they were reachable: the Steinberg press release PDF, the SDK READMEs and
> LICENSE files, and Microsoft Learn. Items marked **(unverified)** could not be re-checked because the
> session's web-search budget ran out or the site was unreachable. **Not legal advice.** Run the checklist
> in section 10 past a lawyer before a public 1.0.

---

## 0. TL;DR

1. **There is no permissively licensed, mature DAW to fork.** Nothing plays the role OpenCut played for KryptEditor.
   - Every serious open DAW is GPL or AGPL: LMMS, Ardour, Zrythm, Qtractor, MusE, Helio, Bespoke, Meadowlark and openDAW.
   - Some of those are also offered under a commercial dual license (Tracktion Engine, openDAW, JUCE).
   - The only MIT/Apache "DAWs" are toys, days or weeks old.
2. **Verdict: build fresh, and borrow libraries plus selected MIT components.**
   - The best concrete borrow is **Signal** (`ryohey/signal`, MIT, React + TypeScript + Electron, 2.4k stars, active). It has a WebGL piano roll, arrange, tempo, velocity and event-list editors, and MIDI file I/O. Use it the way KryptEditor used OpenCut, but for the MIDI-editing quarter of the app only.
   - The Rust engine is assembled from MIT/Apache crates, several of them spin-offs of the stalled Meadowlark project: creek, symphonium, Firewheel ideas, plus cpal, clack, `vst3`, rubato and signalsmith-stretch.
3. **The SDK picture changed in October 2025, mostly in our favour.**
   - **The VST3 SDK is MIT** as of VST 3.8 (29 Oct 2025). Hosting VST3 in an MIT app is now trivial.
   - **ASIO is dual-licensed**: the free proprietary agreement, which Steinberg must countersign, or GPLv3 (since 15 Oct 2025). The GPLv3 route does **not** help an MIT binary.
   - Plan: ship WASAPI first, and add ASIO under the proprietary agreement with the SDK kept out of the repo.
4. **Name it "Krypt Studio", not "KryptStudio".** House guide §12 forbids the run-together form. No conflicting audio product named "Krypt Studio" was found. A formal USPTO/EUIPO register search is still a to-do.
5. **FLP import is legally feasible as a clean-room, best-effort feature.** File formats are not protected by copyright (CJEU *SAS v WPL*, 2012).
   - PyFLP is **GPL-3.0**: read its docs for facts, never port its code.
   - Native FL plugin states such as Sytrus or Harmor cannot be imported.
6. **Interchange to build first:**
   - **DAWproject** (MIT; Bitwig, Studio One, Cubase 14, Nuendo 14, openDAW).
   - Standard MIDI files.
   - SF2 (rustysynth, MIT) and an SFZ subset.
7. **Distribution:**
   - EV certificates no longer bypass SmartScreen (since 2024), and certificates issued from 1 Mar 2026 last at most 460 days.
   - The cheapest clean routes are the Microsoft Store as MSIX (free, no warnings), SignPath Foundation (free for OSS, but SignPath becomes the publisher of record), or Azure Artifact Signing (about $9.99/month; individuals in the US or Canada only).
8. **Competitive context:**
   - **FL Studio 2026's "Gopher" assistant can now perform production tasks** inside a project.
   - Community MCP bridges already exist for FL Studio (67 tools), REAPER (up to 176 tools) and Ableton (3.2k stars).
   - KryptStudio's edge must be an MCP-native document model (transactions, undo, headless render), not a bolt-on.

---

## 1. Comparison table — open-source and source-available DAWs

Activity is measured on 2026-10-11. "90d commits" counts default-branch commits since 2026-07-11, capped at 100 by the API.

| Project | License | Stack | Last push / latest release | 90d commits | Stars | Reusable under MIT? |
|---|---|---|---|---|---|---|
| **LMMS** | GPL-2.0-or-later | C++, Qt | push 2026-09-27; **1.3.0-alpha.2 (2026-09-06)**, last stable 1.2.2 (2020-07) | 35 | 10.5k | Ideas only |
| **Zrythm** | AGPL-3.0-or-later + §7 trademark terms | C++23, Qt/QML, **JUCE** | push 2026-10-04; **v2.0.0-alpha.6 (2026-10-04)** | 100+ | 3.2k | Ideas only |
| **Ardour** | GPL-2.0-or-later (+ plugin clarification) | C++, own GTK2 fork (YTK), Lua | push 2026-10-10; **9.8 (2026-08-20)** | 100+ | 5.3k | Ideas only |
| **Qtractor** | GPL-2.0 | C++, Qt; Linux (JACK/ALSA) | push 2026-10-10; v1.6.4 (2026-09-05) | 70 | 0.6k | Ideas only |
| **MuSE** | GPL-2.0 | C++, Qt; Linux | push 2026-09-07; rolling "latest" build; last formal tag 2018 | 17 | 0.8k | Ideas only |
| **Tracktion Engine** | GPL-3.0-or-later **or commercial** | C++20, JUCE module, own `tracktion_graph` | push 2026-10-09; v3.2.0 (2025-05-15) | 100+ | 1.5k | No (GPL or paid) |
| **Tracktion Waveform Free** | Proprietary freeware | Built on Tracktion Engine | 13.5 (Aug 2025) | n/a | n/a | No |
| **Meadowlark** | AGPL-3.0 (relicensed 2025-04-18) | Rust | **moved to Codeberg 2025-09-21; no commits since** | 0 | 1.5k | DAW: no. **Spin-off crates: yes** (below) |
| **Helio** | GPL-3.0 | C++, JUCE; desktop + mobile | push 2026-10-11; 3.18 (2026-09-11) | 22 | 3.6k | Ideas only |
| **Bespoke Synth** | GPL-3.0 | C++, JUCE; modular | push 2026-10-08; v1.3.0 (2024-12-22) | 22 | 4.7k | Ideas only |
| **generic-daw** | GPL-3.0 | Rust, iced 0.15 | created 2024-08; push 2026-10-11 | active | 161 | Ideas only |
| **chipbox** | **No license file** (all rights reserved) | Rust, node graph, Vello | push 2026-04-24 | — | 137 | **No** |
| **tripplyons/daw** | MIT | Rust, iced; VST3/AU; macOS/Linux | **created 2026-09-27** | — | 3 | Yes, but too young to matter |
| **AAADAW** | Apache-2.0 | Rust, iced, SQLite | **created 2026-10-01** | — | 0 | Yes, but too young to matter |
| **openDAW** (web) | **AGPL-3.0-or-later or commercial** | TypeScript + Rust→WASM in AudioWorklet | created 2025-02; push 2026-10-10 | 100+ | 2.3k | Ideas only |
| **GridSound** (web) | AGPL-3.0 | JavaScript | push 2026-10-05 | — | 1.9k | Ideas only |
| **Signal** (web/Electron MIDI sequencer) | **MIT** | TypeScript, React, jotai, WebGL, Electron | push 2026-10-10 | active | 2.4k | **Yes: the best borrow candidate** |
| **waveform-playlist** (web) | **MIT** | TypeScript, canvas | push 2026-10-06 | — | 1.7k | Yes (audio-track editor reference) |
| Audiotool (web) | Proprietary; **Nexus SDK Apache-2.0** | Browser, multiplayer | Nexus push 2026-09-26 (pre-1.0) | — | — | SDK patterns only |
| BandLab / Soundtrap (web) | Proprietary | Browser + mobile | — | — | — | No |
| WAM 2.0 (web plugin standard) | MIT (npm `@webaudiomodules/api` 2.0.0-alpha.6) | JS/WASM | api repo last push 2023-03; sdk 2024-07 | ~0 | 0.2k | Yes, but low activity |

---

## 2. Project notes — desktop open source

### LMMS (the FL-like one)
- **License and stack:** GPL-2.0-or-later. C++ with a Qt widget UI and an XML project format (`.mmp`/`.mmpz`).
- **Release gap:** after 1.2.2 (2020-07) there was no stable release for six years. 1.3.0-alpha.1 shipped 2020-11, then **alpha.2 on 2026-09-06**. Its notes describe "over 5 years of work… 932 commits… 65 contributors", with ARM64 builds, detachable windows, microtonality, the SlicerT and LOMM plugins, and in-piano-roll pitch bends. 32-bit builds were dropped. There are 1,471 open issues and PRs.
- **Architecture debt, verified in code:** `AudioEngine::requestChangeInModel()` is documented as *"Block until a change in model can be done (i.e. wait for audio thread)"*. It is used in 13 files: Song, Track, Mixer, Clip, EffectChain and others. Every model edit from the UI takes a global lock that waits on the audio thread. That is the classic glitch and jank source, and the reverse of a lock-free design. LMMS also leans on global singletons (`Engine::…`), and its plugin hosting goes partly through Carla (GPL).
- **FLP:** LMMS currently ships only `MidiImport` and `HydrogenImport`. Older versions had an FLP importer, which was later dropped **(unverified)**. The lesson: an FLP importer is a maintenance treadmill, so scope it tightly.
- **Lessons:**
  - Keep `main` releasable and ship small stable releases.
  - Make UI→engine edits lock-free from day one (command queue plus double-buffered snapshots).
  - A volunteer project with a huge backlog stalls when nobody owns releases.
  - The FL-style workflow (pattern-based beat making on Windows) is under-served by open source. That gap is KryptStudio's opening.

### Zrythm
- **License:** AGPL-3.0-or-later plus Section 7 additional terms. Modified versions may not use the Zrythm name or logo.
- **Rewrite:** v2 is a **ground-up rewrite** in C++23 with Qt/QML and **JUCE**; v1 was C/GTK. The v1 features that are not yet ported are listed in the README. It is still alpha (alpha.6 on 2026-10-04) after years of work. Commit velocity is high, but it is essentially one developer.
- **Lessons:**
  - Changing the UI toolkit mid-life cost years.
  - The AGPL plus trademark clause shows that **trademark, not copyright, is what protects a brand in a free project**. We should do the same for "Krypt" (section 9.1).

### Ardour
- **License and stack:** GPL-2.0-or-later, with an explicit **"Plugin Clarification"**: hosts and plugins built on third-party APIs such as VST, AU, LV2 or CLAP are not derivative works of each other. C++ on its own GTK2 fork (`libs/tk/ytk`), with Lua scripting. 9.8 shipped 2026-08-20; 100+ commits in 90 days.
- **Sustainability:** 20+ years old, funded through pay-what-you-want binaries and subscriptions, with a commercial derivative (Harrison Mixbus).
- **On plugin sandboxing**, Ardour publishes the counter-argument to Bitwig ([ardour.org/plugins-in-process.html](https://ardour.org/plugins-in-process.html)):
  - At least two context switches per sandboxed plugin per block, about 30 µs each.
  - A 128-track × 3-plugin session needs 256–768 switches, or **7.7–23 ms per block**.
  - At 48 kHz with a 64-sample buffer, the budget is about 1.3 ms.
- **Lessons:**
  - Sustainability needs a funding model even for free software.
  - Default to in-process plugins, and make isolation opt-in for specific plugins.

### Qtractor and MuSE
- Both are C++/Qt, GPL-2 and **Linux-first** (JACK/ALSA).
- Qtractor is healthy (70 commits in 90 days, v1.6.4 on 2026-09-05) but is a solo maintainer's project.
- MuSE is in maintenance mode: 17 commits in 90 days, with the last formal GitHub tag in 2018.
- **Lesson:** Linux-first audio stacks never captured Windows beat-makers. Being Windows-first is a real differentiator.

### Tracktion Engine and Waveform
- **License and stack:** **GPL-3.0-or-later or commercial**, with paid tiers. A C++20 JUCE module containing its own `tracktion_graph` audio-graph module, a benchmark suite run in CI, and an `EngineInPluginDemo` that runs the whole engine inside a plugin. v3.2.0 shipped 2025-05-15; 100+ commits in 90 days.
- **Waveform Free 13.5** (Aug 2025) is closed-source freeware with no track, plugin or export limits. It competes directly with us for "free Windows DAW".
- **Not usable:** GPL/commercial, and JUCE itself is now **AGPLv3 or commercial** (the JUCE LICENSE references the "JUCE 9 licence").
- **Ideas to take:**
  - The "Edit" document model.
  - Graph benchmarks run in CI.
  - A headless engine, or the engine running inside a plugin.

### Meadowlark (Rust) — why it stalled, and what it spun off
- **Status:**
  - The GitHub README says "This project has moved to Codeberg".
  - On Codeberg, the last commits are "relicense to AGPLv3" (2025-04-18) and then "moved to Codeberg" (2025-09-21). Nothing since.
  - Nearly every GitHub repo in the org was **archived on 2025-09-22**.
  - The engine (Dropseed, AGPL) was split out and was last touched 2025-11-10.
  - A public design journal exists (`meadowlark-journal`, CC BY-NC-4.0), covering timekeeping and plugin design docs.
- **Why it stalled.** This is our inference from the repo record. The author has not published a post-mortem that we found.
  1. **Yak-shaving.** Because the Rust audio and GUI ecosystem lacked the pieces, the author built a GUI toolkit (Yarrow, plus rootvg), a plugin-host engine (Dropseed), disk streaming (creek), file loading (symphonium), audio I/O bindings (rtaudio-rs), resampling and interleaving crates, and more. The DAW itself never reached usability.
  2. **Rewrites.** The `old` and `dev-(old)` branches are preserved.
  3. **A solo core developer.**
  4. **Pivot to where demand is.** BillyDM's **Firewheel** (MIT/Apache, 0.14.0, 2026-09) is "planned to be upstreamed into the Bevy game engine where it will become the default audio engine". Its README cites "feature creep" and maintenance burden.
- **Firewheel explicitly is not a DAW engine.** From its design doc: "the needs of game audio engine and DAW audio engine are in conflict… in a DAW the state is tied to the state of the transport and the host is allowed to discard user-generated parameter events." Read that paragraph before designing our parameter and automation path.
- **Reusable spin-offs** (license per crates.io, 2026-10-11):

| Crate | License | Status | Use for us |
|---|---|---|---|
| `creek` | MIT OR Apache-2.0 | 1.2.3, 2025-09 (stable) | Real-time-safe disk streaming with cache plus look-ahead buffers |
| `symphonium` | MIT OR Apache-2.0 | 0.13.0, 2026-08 (active) | Load audio files into RAM (wraps Symphonia) |
| `firewheel` | MIT OR Apache-2.0 | 0.14.0, 2026-09 (active, Bevy-bound) | Reference for graph compilation, sampler, silence optimisation and stream fault tolerance; cherry-pick code |
| `rtaudio-rs`, `fixed-resample`, `fast-interleave` | MIT | Active on Codeberg | Utilities |
| `meadowlark-factory-library` | CC0-1.0 | Archived | Factory content we can ship |
| Yarrow (GUI) | Apache-2.0 | Last commits Oct 2025 | Not needed (we use React) |

- **The lesson for us:** a native GUI toolkit in Rust was the swamp. We avoid it by using Electron + React for the UI and **only** building the engine natively.

### Helio
- **License and stack:** GPL-3.0, C++/JUCE, desktop and mobile; 3.18 shipped 2026-09-11. A sketching-oriented sequencer.
- **Ideas worth taking:**
  - **Built-in version control:** "save points… any saved revision can be restored", designed for keeping several variations of a sketch.
  - **A command palette with modes:** `/` projects, `:` move notes to track, `@` timeline events, `!` chord compiler.
  - **"Orchestra pit":** instruments set up once, globally, so switching projects is fast.

### Bespoke Synth
- **License and stack:** GPL-3.0, C++/JUCE, a modular patching canvas. Hosts VST, VST3 and LV2, and supports **Python live coding**. v1.3.0 shipped 2024-12.
- **Idea:** let scripts generate or transform notes live. Our version would use sandboxed JS rather than Python, which is a natural fit for agents.

### Newer Rust DAWs (2024–2026)
- **generic-daw** (GPL-3.0, iced): the most active Rust DAW, but copyleft.
- **chipbox:** has **no license**, so it cannot be used at all.
- **tripplyons/daw** (MIT, iced, VST3/AU) and **AAADAW** (Apache-2.0): created in the last two weeks; not a foundation.
- **Takeaway:** in 2026 there is still no mature Rust DAW. The Rust *library* ecosystem is now good enough to assemble an engine (section 6.3).

---

## 3. Project notes — web DAWs

### openDAW (André Michelle)
- **License:** **AGPL-3.0-or-later or a commercial license.** The README has a dual-licensing table; contact andre.michelle@opendaw.org. The npm SDK (`@opendaw/studio-sdk`, `@opendaw/lib-*`) is also AGPL. The ported CTAG compressor is "excluded in commercial license".
- **Activity:** created 2025-02, 2.3k stars, 100+ commits in 90 days. Public newsletter and meetups.
- **Architecture** (from `introduction.md`) — the best-documented modern DAW design we found:
  - A turborepo npm workspace for TypeScript plus a **cargo workspace compiled to WASM**: the engine and every stock device are Rust cdylibs exposed as an AudioWorklet processor.
  - Strict layering: `config → lib/* (DAW-agnostic) → studio/* (domain) → app/*`.
  - **`lib-box`:** "typed records with addressable fields, pointer fields form the edges. Transactional editing with undo, an update protocol, and `sync-source`/`sync-target` for mirroring a graph across threads or peers."
  - **`lib-box-forge`:** a code generator that writes both **TS classes and a Rust registry** from one schema.
  - **`LiveStream`:** lock-free telemetry from the audio thread to the UI.
  - OPFS storage.
  - A homebrew JSX runtime with no virtual DOM. Performance was chosen over React.
  - `lib-dawproject` for DAWproject read/write.
  - `lib-inference`: onnxruntime-web for tempo detection, stem separation and audio-to-MIDI ("basic pitch").
  - Hosts **WebCLAP** plugins (CLAP compiled to WASM).
  - Scriptable devices in JavaScript: Apparat (instrument), Spielwerk (MIDI FX), Werkstatt (audio FX).
- **Contribution policy:** "AI-assisted code is fine, but every contributor must understand every line… document your process in `/plans`."
- **Reusable under MIT: no code at all.** Even the commercial license would not make our code MIT-redistributable. We take **ideas** only (section 7). Contributors who have read openDAW's code should still not transcribe it.

### Audiotool
- Closed source, browser-based and multiplayer.
- Its **Nexus SDK** (`@audiotool/nexus`, **Apache-2.0**, pre-1.0, "expect breaking changes") lets JS/TS programs edit live projects. The pattern:
  - `nexus.modify(t => t.create("noteTrack", {...}))` transactions.
  - Typed entities that reference each other through `.location` pointers.
  - Queries such as `queryEntities.ofTypes(...)` and `pointedToBy`.
  - `events.onCreate(type, handler)`.
  - OAuth app registration.
- **This is the closest existing precedent to "a DAW controllable by agents"**, and its shape (transactions over a typed entity graph) is exactly what our MCP layer should expose.

### BandLab and Soundtrap
- **BandLab:** a free cloud DAW funded by other businesses. It bought Cakewalk/SONAR's IP in 2018 and gave it away as "Cakewalk by BandLab". In 2023 it announced the SONAR name would return and be **"no longer freeware"** (Wikipedia).
  - **Opportunity:** the long-time "free full Windows DAW" slot was vacated. Today's free Windows options are Waveform Free (closed) and LMMS (stalled releases).
- **Soundtrap:** founded in Stockholm in 2012, acquired by Spotify in 2017, and **sold back to its founders in 2023**. Browser DAW with collaboration and education focus.
- **Lessons from both:**
  - Collaboration and "it just opens" matter more than feature depth for beginners.
  - Free products need a sustainable story. Ours is the Krypt suite and community, not monetisation.

### The WAM (Web Audio Modules) ecosystem
- **WAM 2.0 is MIT** (npm `@webaudiomodules/api` 2.0.0-alpha.6, `@webaudiomodules/sdk` 0.0.12), but development is near-dormant: the api repo was last pushed 2023-03 and the sdk 2024-07.
- **WebCLAP** (`free-audio/web-clap`, MIT, last push 2025-11) is the newer direction, and openDAW hosts it.
- **For us:** irrelevant for v1, which has a native engine. If we ever run plugins in the renderer, prefer WebCLAP over WAM.

### Signal (MIDI sequencer) — the strongest permissive borrow
- **License:** MIT, 2016–present, 2.4k stars, pushed 2026-10-10.
- **Stack:** React, jotai and WebGL (`@ryohey/webgl-react`, MIT), with an **Electron shell already in the repo**. Firebase is used for cloud features, which we strip out.
- **Packages:**
  - Editors: `pianoroll-editor`, `arrange-editor`, `tempo-editor`, `velocity-editor`, `control-editor`, `event-list-editor`, `ruler-editor`.
  - Domain and playback: `core` (domain engine) and `player` (scheduling).
  - Infrastructure: `observable`, `geometry`, `dialog-hooks`.
  - Separately: `midifile-ts` (MIT) and `wavelet` (an SF2 AudioWorklet player, MIT).
- **Design rules** (from `ARCHITECTURE.md`):
  - "Each mutation runs in a transaction: one change, one notification."
  - Logic is curried `(args) => (context) => result`.
  - Leaf canvas components read high-churn data via focused hooks; never prop-drill notes.
- **Limits:** it is deliberately **not** a DAW. It has no audio tracks and no effects. So it covers MIDI editing only.

---

## 4. Closed-source references (architecture lessons only)

| Product | State (2026) | Lessons to take |
|---|---|---|
| **Bitwig Studio** | **6.0 shipped 2026-03-11**: automation clips, clip aliases, project key signature, reworked automation editing | <ul><li>**Plugin hosting modes:** within the engine, "Together" (the default), "By manufacturer", "By plug-in", and "Individually". The user chooses the crash-isolation versus memory trade-off.</li><li>**The Grid** (modular), and a unified modulator system that works on any parameter.</li><li>Co-created **CLAP** (with u-he) and **DAWproject** (with PreSonus).</li><li>An open controller API.</li></ul> |
| **REAPER** | v7.x, builds into the 7.7x range in 2026 (Wikipedia lists 7.74, June 2026) | <ul><li>A tiny, fast install.</li><li>**Everything is an action** in a searchable action list, with user macro "custom actions".</li><li>ReaScript (Lua/EEL2/Python), JSFX text-source plugins, and a human-readable text project format (.RPP).</li><li>Anticipative (render-ahead) FX processing **(general knowledge, not re-verified)**.</li><li>The most MCP bridges of any DAW (e.g. TwelveTake `reaper-mcp`, MIT, 176 tools).</li></ul> |
| **Renoise** | **3.5 (2025)**, 3.5.4 (2025-11-19) | <ul><li>A keyboard-first tracker, a Lua tool API and ecosystem, and **phrase scripting** (3.5).</li><li>Native microtuning.</li><li>Proof that a niche, keyboard-driven workflow can sustain a paid indie DAW for 20 years.</li></ul> |
| **Ableton Live** | Live 12.x | <ul><li>The Session view clip launcher, warping, and Max for Live.</li><li>**Ableton Link is GPL-2.0-or-later or proprietary** (`Ableton/link` LICENSE), so it is not MIT-compatible without a separate license from Ableton.</li><li>`ahujasid/ableton-mcp` (MIT, 3.2k stars) shows the demand for agent control.</li></ul> |
| **FL Studio** (the UX north star) | **FL Studio 2025** (July 2025): Loop Starter, dynamic mixer tracks (up to 500), the **Gopher** assistant. **FL Studio 2026**: Gopher "can now carry out production tasks inside your project" | <ul><li>Channel rack and step sequencer, patterns placed in a playlist, a best-in-class piano roll, flexible mixer routing, and lifetime free updates.</li><li>**Competitive threat:** Image-Line is shipping first-party agentic features.</li><li>`rosasynthesiz/flstudio-mcp` (MIT, 67 tools) drives FL through its Python MIDI-scripting API.</li><li>Our pitch must be "**the DAW designed around agents**": a full-fidelity document model, transactional and undoable agent edits, headless rendering, and determinism. Not "an assistant panel".</li></ul> |

---

## 5. Why DAW projects stall — the pattern

| Failure mode | Seen in | Our countermeasure |
|---|---|---|
| Building foundations instead of the product (GUI toolkit, audio I/O, file loaders) | Meadowlark | UI on Electron/React per the house stack. Engine assembled from existing crates. Write only the glue and the DSP that matters. |
| Toolkit or framework rewrite mid-life | Zrythm (GTK → Qt/JUCE), Meadowlark (multiple rewrites) | Commit to Electron + React + TS for UI (house guide §4) and Rust for the engine, and don't re-litigate. |
| Global locks and shared mutable state between UI and audio | LMMS (`requestChangeInModel`) | Lock-free command queue (`rtrb`), immutable snapshots swapped atomically, `assert_no_alloc` on the audio thread in debug builds. |
| Unreleasable trunk; years between stables | LMMS (2020→2026) | Monthly releases, feature flags, and a "stable" vs "insider" channel. |
| Bus factor of one | Meadowlark, Zrythm, Qtractor, Helio | Architecture docs from day one (openDAW-style `introduction.md`), MCP/test harnesses that let agents help, and small modules. |
| Linux-first audio stack | Qtractor, MuSE, early Ardour | Windows-first (WASAPI, then ASIO), with cross-platform later. |
| Scope creep before an MVP | Firewheel's own README; most hobby DAWs | Ship the FL-core loop first: step sequencer → piano roll → playlist → mixer → render. |

---

## 6. Fork vs build — the verdict

### 6.1 Verdict
**Build fresh. Do not fork any DAW.** Borrow at three levels:

1. **Vendor MIT TypeScript components from Signal** for the MIDI editors. This is the KryptEditor/OpenCut pattern applied to one subsystem.
2. **Depend on MIT/Apache/ISC/MPL-2.0 libraries** for the engine (Rust) and for formats.
3. **Copy ideas, never code**, from GPL/AGPL projects (section 7).

### 6.2 Why there is no OpenCut-equivalent
- **Licensing.** Every complete open DAW is GPL or AGPL (LMMS, Ardour, Zrythm, Qtractor, MuSE, Helio, Bespoke, Meadowlark, generic-daw, GridSound, openDAW), or GPL plus commercial (Tracktion Engine, JUCE). Forking any of them makes KryptStudio GPL/AGPL, which breaks the house "MIT" non-negotiable (guide §13).
- **Stack mismatch.** They are C++ with Qt, GTK or JUCE. The house stack is Electron + React + TS, and has a **"no C++ toolchain compile at `npm install`"** rule (guide §4.1). Even a permissive C++ DAW would be a poor fit.
- **The permissive Rust DAWs are 2–3 weeks old** (tripplyons/daw, AAADAW), and chipbox has no license.
- **openDAW** is the closest architectural match: TS UI plus a Rust/WASM engine. It is AGPL, and its commercial license still would not let us publish under MIT.

### 6.3 Concrete borrow list (all MIT-compatible)

**UI and editing layer (TypeScript)**

| Component | License | Plan |
|---|---|---|
| Signal: `pianoroll-editor`, `arrange-editor`, `velocity-editor`, `tempo-editor`, `control-editor`, `ruler-editor`, `core`, `player`, `observable`, `geometry` | MIT | **1-week spike:** vendor into `src/editors/`, re-skin from Emotion to Tailwind/Krypt tokens, replace Firebase repositories with local files, keep `THIRD-PARTY-NOTICES.md` attribution. If coupling is too high, keep only the patterns (WebGL rendering, transaction-per-mutation domain layer). |
| `@ryohey/webgl-react` | MIT | 2D WebGL rendering for piano roll and playlist |
| `midifile-ts` (Signal) / `@tonejs/midi` / `midi-file` | MIT | Standard MIDI file read/write in the renderer |
| `waveform-playlist` | MIT | Reference for audio-track editing UX: fades, cues, peaks rendering |
| `SpessaSynth` | Apache-2.0 | Optional TS SF2/DLS synth for in-renderer preview |
| `onnxruntime-web` (already used by KryptEditor) | MIT | Stem separation, tempo detection and audio-to-MIDI, following openDAW's idea. Check each **model's** license separately. |

**Engine (Rust)** — shipped as **prebuilt** binaries (a sidecar process or a `napi-rs` addon), so nothing compiles at install time.

| Concern | Crate | License |
|---|---|---|
| Audio I/O (WASAPI; ASIO behind a feature flag) | `cpal` 0.18 | Apache-2.0 |
| Real-time comms | `rtrb` (SPSC ring buffer), `basedrop` (deferred dealloc), `assert_no_alloc` | MIT/Apache, BSD-1-Clause |
| Disk streaming | `creek` | MIT/Apache |
| Decode | `symphonia` (MPL-2.0, file-level copyleft; fine unmodified, note it in the notices), `symphonium` | MPL-2.0 / MIT-Apache |
| WAV write | `hound` | Apache-2.0 |
| Resampling | `rubato` 5.0 | MIT/Apache |
| Time-stretch / pitch-shift | `signalsmith-stretch` (Rust bindings to Signalsmith Stretch) | MIT. **Avoid** Rubber Band (GPL), élastique (proprietary). |
| Stock DSP building blocks | `fundsp` | MIT/Apache |
| SF2 | `rustysynth` | MIT |
| SFZ | Own subset in Rust (opcode spec is public), or `sfizz` (BSD-2, C++, quieter since 2025-03) built as a prebuilt plugin | — |
| CLAP hosting | `clack-host` 0.2 | MIT/Apache |
| VST3 hosting | `vst3` crate 0.3 (coupler-rs) + the now-MIT VST3 SDK | MIT/Apache + MIT |
| MIDI device I/O | `midir` | MIT |
| MIDI file | `midly` | Unlicense |
| Graph design reference | Firewheel (MIT/Apache) and Tracktion `tracktion_graph` (GPL, **read only for ideas**) | — |
| Node bindings | `napi-rs` | MIT |
| Future Windows MIDI 2.0 | Microsoft **Windows MIDI Services** (MIT, "In-box Preview 10", 2026-10-04) | MIT |

**Explicitly avoid**, because of licensing:
- **AGPL:** JUCE (AGPL/commercial), openDAW packages, Zrythm, Meadowlark/Dropseed.
- **GPL:** Tracktion Engine (GPL/commercial), Rubber Band, Carla, LMMS/Surge DSP code (Surge XT and `sst-basic-blocks` are GPL-3), PyFLP, the VeSTige header, Ableton Link (GPL-2+) unless separately licensed, and the GPLv3 build of the ASIO SDK.
- **LGPL** (libsndfile, FluidSynth): only acceptable as dynamically linked, replaceable DLLs with notices. Prefer the Rust alternatives above.

---

## 7. "Steal these ideas" (ideas, not code)

1. **One typed, transactional document graph as the single source of truth.** Every edit is a transaction with undo, and it is mirrored to the engine and to peers or agents. (openDAW `lib-box`, Audiotool Nexus `modify(t => …)`, Signal's "one change, one notification".) **MCP tools should map 1:1 onto these transactions, with one undo group per agent call.**
2. **One schema → generated TS types, Rust structs, and MCP tool JSON-schemas** (openDAW `lib-box-forge`). This kills drift between UI, engine and agent API.
3. **Lock-free telemetry stream from engine to UI** for meters, playhead and scopes (openDAW `LiveStream`).
4. **Everything is a named command** in one registry, reachable from shortcut, palette, MIDI controller and MCP (REAPER action list; Helio command palette). Custom macro actions are just saved command sequences that an agent can also author.
5. **Built-in version control / save points** (Helio). Every agent session auto-creates a checkpoint and branch. The user can diff ("agent added 3 clips, changed 12 notes") and revert in one click. This is huge for trust in AI edits.
6. **Command palette with modes** (Helio `/ : @ !`), including a chord "compiler" mode.
7. **User-selectable plugin isolation** (Bitwig modes), but **default in-process** (Ardour's context-switch math), with auto-quarantine of a plugin that crashed the scan or the engine.
8. **Scriptable devices** (openDAW Apparat/Spielwerk/Werkstatt, Bespoke Python live coding, Renoise phrase scripting). A sandboxed JS "note generator / MIDI FX" device is the safest way to let agents write musical logic.
9. **Headless engine mode** (openDAW-headless, Tracktion EngineInPluginDemo). Render a project to WAV with no UI, for CI golden-file tests and for agents.
10. **Engine-side silence optimisation and device-loss fault tolerance** (Firewheel): skip silent nodes, and survive headphones being unplugged.
11. **Disk streaming with loop-point caches plus look-ahead** (creek design) for big sample libraries.
12. **Clip aliases and automation clips** (Bitwig 6). **Unified modulation:** any modulator to any parameter (Bitwig).
13. **Plain-text, diff-friendly project format** (REAPER .RPP): a JSON or YAML project plus a media folder, friendly to git, agents and recovery.
14. **Microtuning designed in from day one**, so note pitch is not hard-wired to 12-TET (LMMS 1.3, Renoise 3.5).
15. **Dynamic mixer size**: no fixed insert count (FL Studio 2025 raised it to 500).
16. **Detachable, multi-monitor windows** (LMMS 1.3).
17. **On-device ML helpers:** stems, tempo, audio→MIDI via ONNX (openDAW `lib-inference`), opt-in downloads, as in KryptEditor.
18. **The FL core loop, implemented from observed behaviour:**
    - The step sequencer channel rack.
    - Patterns as clips in a playlist.
    - Ghost notes.
    - Piano-roll tools: chop, strum, arpeggiate, quantize, scale highlighting.
    - Slide and porta notes.
    - Per-channel mixer routing.
19. **CC0 factory content** (Meadowlark factory library is CC0) so presets and samples carry no licensing baggage.
20. **An AI-assisted contribution policy** (openDAW): contributors must understand every line, and document the AI process in `/plans`.
21. **Architecture map for newcomers** (openDAW `introduction.md`, Signal `ARCHITECTURE.md`), from day one.
22. **Collaboration-ready sync** (openDAW sync-source/target, Audiotool multiplayer). Not v1, but the transaction log should make it possible later.

---

## 8. Interchange formats

### 8.1 DAWproject
- **License:** **MIT** (`bitwig/dawproject`, 1.0k stars). The format is "version 1.0 and stable". The repo was last pushed 2025-07, so it is quiet but frozen.
- **Format:** a ZIP container holding `project.xml` and `metadata.xml` (UTF-8), with XSD schemas (`Project.xsd`, `MetaData.xsd`).
  - Covers tracks, clips, audio and note timelines, note expressions, tempo and time-signature automation, sends, plugin parameter automation, generic EQ/compressor/gate/limiter, and clip-launcher scenes.
  - **Plugin state is always embedded.**
- **Reference implementation:** Java only (Gradle, JRE 16+). There is **no official TS or Rust library**: generate types from the XSD and write our own reader and writer. openDAW's `lib-dawproject` exists but is AGPL, so don't look at it while implementing.
- **Adoption (verified):**
  - Bitwig Studio.
  - PreSonus Studio One 6.5+ (Professional / Studio One+).
  - **Steinberg Cubase 14** (Nov 2024) and Nuendo 14 (early 2025).
  - openDAW.
  - "Fender Studio" is also reported by one source **(unverified)**.
- **Not supported:** Ableton, Pro Tools. **FL Studio: no evidence of support found.** REAPER only through a community converter.
- **Recommendation:** make DAWproject our **primary interchange format** for both import and export. It is the escape hatch that makes "try Krypt Studio, keep your work" credible with Bitwig, Studio One and Cubase users.

### 8.2 MIDI files and devices
- **Renderer (TS):** `midifile-ts` (MIT), `@tonejs/midi` (MIT; last push 2023 but stable), `midi-file` (MIT).
- **Engine (Rust):** `midly` (Unlicense, 0.5.3, stable since 2023) for SMF; `midir` (MIT, active) for live device I/O.
- **Future:** Windows MIDI Services (MIT, Microsoft; MIDI 2.0 / UMP) is still in "In-box Preview 10" (2026-10-04). Plan an adapter, but don't depend on it for v1. VST 3.8 improved MIDI 2.0 support.

### 8.3 FLP import (FL Studio projects)

**What is documented.** There is no official Image-Line specification that we found. The best public description is PyFLP's docs:
- A binary file with an `FLhd` header chunk (format version, channel count, PPQ) and an `FLdt` data chunk of **events**.
- Event IDs 0–63 carry a 1-byte value, 64–127 a 2-byte value, 128–191 a 4-byte value, and 192–255 a varint length plus a payload (strings and structs).
- The format "evolved from a MIDI-like design", and IDs change across FL versions.
- Other parsers: FLPFile (PyPI, older); `ekkx/flparser` (.NET, beta, based on andrewrk's node-flp) **(licenses unverified)**.

**PyFLP status:**
- **GPL-3.0.** The license changed within the project's first week in 2021; PyPI 1.1.1 onward is GPL-3, so there is no usable MIT version.
- Last release v2.2.1 (2023-06-05), "maintenance: 2023" badge, last repo push 2026-02-16, 39 open issues.
- **We cannot vendor or port it.** We can read its docs and observe its *results* to learn facts about the format.

**Legality:**
- **EU:** *SAS Institute v World Programming* (CJEU C-406/10, 2 May 2012). A program's functionality, programming language and **data file formats are not protected by copyright**, and a licensee may observe, study and test a program to learn its underlying ideas.
- **US:** reverse engineering for interoperability is supported by case law (*Sega v. Accolade*, 1992) and by DMCA §1201(f) **(not re-verified this session)**. FLP files are not DRM-encrypted, so §1201 anti-circumvention is not implicated.
- **EULA:** FL Studio's EULA likely restricts decompiling the *application* **(EULA text not retrievable)**. Parsing files that *users* created is not decompiling FL Studio. **Never** disassemble FL Studio binaries to learn the format.
- **Demo projects:** don't use Image-Line's bundled demo projects as test fixtures in the repo. They are copyrighted songs. Build fixtures by authoring our own projects in a legitimately licensed FL Studio.

**Feasible scope** — call it "FL project import (beta), best-effort, with a report of what was skipped":
- ✅ Tempo, time signature, patterns (notes with velocity, pan, pitch, slide), channel-rack step sequences, playlist arrangement (pattern and audio clips), Sampler channels (sample paths, basic envelope), and mixer insert routing with volume and pan.
- ⚠️ Automation clips, and third-party VST/VST3 plugin chunks (these may round-trip into the same plugin).
- ❌ Native FL plugin states (Sytrus, Harmor, FLEX, FPC and others are opaque) → create a placeholder device plus a note in the import report.
- **Fallback path:** FL Studio exports MIDI and stems natively, so document that for users.

**Clean-room process:** see section 9.2. Use a two-person rule. A "reader" studies PyFLP's docs and output, plus our own test files, and writes a neutral spec of facts (event ID → meaning). An "implementer" writes the TS/Rust parser **without ever viewing PyFLP source**.

### 8.4 Samples, SF2 and SFZ
- **Decode:**
  - WAV/AIFF via `symphonia` or `hound`.
  - FLAC via `symphonia`, or libFLAC (BSD-3).
  - **MP3** via `symphonia` or `minimp3` (CC0). Patents have expired (section 9.3).
  - Ogg Vorbis via `symphonia`. libvorbis is BSD-3.
  - Opus via libopus (BSD-3).
  - **AAC/M4A:** prefer **Windows Media Foundation** (OS-licensed) over shipping our own decoder (section 9.3).
- **Encode / export:** WAV (`hound`), FLAC (libFLAC), Opus/Vorbis (BSD), and MP3. For MP3 use the Windows Media Foundation encoder **(verify availability in a spike)**, or LAME (**LGPL**) as a separately shipped DLL. Don't ship an AAC encoder.
- **SF2:**
  - `rustysynth` (MIT, Rust, active).
  - TinySoundFont (MIT, C).
  - SpessaSynth (Apache-2.0, TS).
  - `wavelet` (MIT, AudioWorklet).
  - The `soundfont2` npm package (MIT; openDAW uses it).
  - FluidSynth is LGPL-2.1, so dynamic linking only. Avoid it.
- **SFZ:** `sfizz` (BSD-2, C++) is permissive but has been quiet since 2025-03. Options: ship sfizz as a prebuilt plugin, or implement an SFZ v1 subset (regions, key and velocity ranges, loop modes, envelopes) in Rust from the public opcode reference. **Recommend the Rust subset** for v1.
- **Presets:** VST3 `.vstpreset` (format is in the now-MIT SDK) and CLAP state. VST2 FXP/FXB only if VST2 is ever added (section 9.4).

---

## 9. Legal and licensing

### 9.1 Name, trademarks and trade dress

**Product name**
- House guide §12 says **"Product name `Krypt <Tool>` (space, title case)… Never `KryptMacro`"**.
- So the product is **"Krypt Studio"**: npm and exe `krypt-studio`, appId `cc.krypt.studio`, repo `krypt-net/krypt-studio`, Discord app name "Krypt Studio". The folder can stay `KryptStudio`, matching the KryptEditor precedent (folder `KryptEditor`, productName "Krypt Editor").

**Conflict search** (web, 2026-10-11):
- **No** audio or DAW product named "Krypt Studio", "KryptStudio" or "Krypt Studios" turned up.
- Near-misses, all assessed as low risk:
  - **"Crypt" by Vitling**: a free supersaw synth (VST3/AU). Different spelling and product class, but phonetically close.
  - **"The Crypt Studio"**: a London recording studio (a service, different spelling).
  - **"Krypt"**: an old freeware plugin by "Kriminal" (KVR, around 2008), and an old Reaktor ensemble.
  - **Krotos Studio**: sound-design software, dissimilar name.
- **Not done:** formal trademark register searches (USPTO, EUIPO TMview, UKIPO) in Classes 9 and 42 for "KRYPT" and "KRYPT STUDIO". **Do this before launch.**
- "Studio" is descriptive in DAW names (Bitwig Studio, Studio One, FL Studio, Android Studio), so it carries no exclusivity on its own.

**Trademark is our real anti-rebrand tool**
- MIT grants no trademark rights, but it does let anyone fork and rebrand the *code*. House guide §9's "friction" measures are the soft layer.
- The hard layer is **registering "KRYPT" for the suite** and adding a **`TRADEMARKS.md`** policy: forks must drop the Krypt name and logo. Zrythm's AGPL §7 clause is the model, but for MIT it goes in a separate policy document, not the license.

**Image-Line marks and trade dress**
- Image-Line owns the "FL Studio" mark and related marks. It obtained "FruityLoops" in Europe, but when it applied in the US, Kellogg's challenged it. Image-Line renamed to FL Studio rather than "fight them in court for 5 years" (Image-Line company history).
- **Do not use:**
  - "FL", "Fruity", "FruityLoops" or "Loops"-style combos in our naming.
  - Image-Line plugin names (Sytrus, Harmor, Gross Beat, Edison, Slicex, FPC, Vocodex, Patcher and so on).
  - Their fruit logo, skins, icons, colour schemes, sounds or presets, or any "official/compatible" badge.
- **OK, as nominative use:**
  - "Imports FL Studio project files (.flp)".
  - Factual comparisons.
  - The footer line *"FL Studio is a trademark of Image-Line Software. Krypt Studio is not affiliated with or endorsed by Image-Line."*
- **Trade dress:** the Krypt design system (void black, indigo→purple→pink gradient, Chakra Petch, glass cards) is already clearly distinct from FL's look. Keep it.
  - Do not reproduce FL's window chrome, toolbar arrangement or iconography pixel-for-pixel.
  - Prefer our own names for FL-specific terms, for example "Step Rack" rather than "Channel Rack" and "Arrangement" rather than "Playlist". Generic terms are fine: "piano roll", "step sequencer", "mixer".

### 9.2 Clean-room practice for cloning UX

**The law, in brief**
- **US:** in *Lotus v. Borland* (1st Cir. 1995), a menu command hierarchy was held to be an uncopyrightable "method of operation". The Supreme Court affirmed only by an evenly divided court, so it set no national precedent.
- **EU:** *SAS v WPL* (CJEU 2012) holds that functionality and file formats are not protected.
- **Still protected everywhere:** code, graphics, icons, sounds, presets, demo songs, manual text and screenshots, and possibly distinctive trade dress.

**The process to adopt**
1. **Behavioural specs in our own words**, written from public sources: the manual read for understanding, videos, and our own hands-on use. No copy-pasted Image-Line text or screenshots in the repo.
2. **No decompiling or disassembling** FL Studio (or any closed DAW). No leaked code or material.
3. **All assets are original or CC0.** Keep a provenance file for every sample, preset, icon and font.
4. **A DCO sign-off on every commit**, plus a CONTRIBUTING attestation: "I have not copied code from GPL/AGPL/proprietary projects; AI-generated code was reviewed and is understood". The second clause follows openDAW's policy.
5. **A two-person rule for format work** (FLP): the reader writes the spec and the implementer codes it; keep the spec and the observation log in `docs/formats/flp/`.
6. **The same rule for GPL/AGPL DAWs** (LMMS, openDAW, Zrythm): studying them is fine, transcribing them is not. When porting an *algorithm*, implement it from the paper or spec, not from their source.

### 9.3 Patents

| Area | Status | Policy |
|---|---|---|
| **MP3** | **Free.** The last US patent (6,009,399) expired 2017-04-16; Fraunhofer and Technicolor ended licensing 2017-04-23. | Decode and encode freely. |
| **AAC** | **Mixed.** The AAC-LC core (1997–98) is widely considered expired; Fedora ships `fdk-aac-free` after Red Hat legal review. HE-AAC (SBR, PS) features still have live patents. The **Via LA AAC pool is active and "evergreen"** (HONOR joined in early 2026). | **Decode via Windows Media Foundation** (Microsoft carries the license), or AAC-LC only via symphonia. **Do not ship an AAC encoder.** Export FLAC, Opus, MP3 and WAV instead. |
| Opus, Vorbis, FLAC | Royalty-free | Use freely. |
| **Polyphonic note editing** (Melodyne "DNA") | **Celemony US 8,022,286**: priority 2008-03-07; **adjusted expiry 2029-06-15** (Google Patents, assumed status). It claims note-object detection and separate editing of notes in polyphonic recordings. | **Do not build Melodyne-style polyphonic note editing before mid-2029.** Monophonic pitch correction is fine. The original 1998 Antares Auto-Tune patent is past its 20-year term **(not re-verified)**. |
| Time-stretching | Products such as élastique are proprietary; core phase-vocoder and WSOLA techniques are decades old. | Use `signalsmith-stretch` (MIT). Don't port proprietary or GPL implementations. |
| Clip launching, warping, step sequencing | No blocking patents surfaced in searches (not exhaustive). | Normal care. Run a freedom-to-operate check if a company ever commercialises this. |

### 9.4 SDK and API licensing (verified status, October 2026)

| SDK / API | License now | Implication for an MIT app |
|---|---|---|
| **VST 3 SDK** | **MIT** since **VST 3.8 (press release 29 Oct 2025)**. The repo LICENSE reads "MIT License, Copyright (c) 2026 Steinberg". The README says "Licensing under GPLv3 and the Steinberg proprietary license is no longer available". VSTGUI and the VST3 C API are BSD-3-style. | ✅ Host VST3 freely, with no agreement to sign. **The trademark rules still apply:** "VST" name and logo use is optional, but if used, the logo must be unaltered and appear only in product contexts (splash, about box, docs), and **"VST" may not appear in a product name**. |
| **VST 2** | Not relicensed. Steinberg stopped licensing the VST2 SDK to new developers in 2018 (general knowledge), and in 2018 issued a GitHub DMCA against the VeSTige `aeffectx.h` header. A clean-room **BSD-3** header exists (`Xaymar/vst2sdk`, used by DPF). | ❌ **Skip VST2 in v1.** VST3 and CLAP cover modern plugins. Revisit with counsel; Xaymar's header is the only permissive route, and Steinberg has been litigious before. |
| **ASIO SDK** (2.3.4) | **Dual:** a proprietary agreement (free, but **"before publishing a proprietary application, I need to obtain a copy of the License Agreement signed by Steinberg"**, per the Steinberg forum, June 2026) **or GPLv3**, added 15 Oct 2025 alongside Steinberg's OBS partnership. | ⚠️ **GPLv3 path:** the combined engine binary becomes GPLv3, so it is not MIT. **Proprietary path:** compatible with MIT source if the SDK stays **out of the repo** and CI downloads it at build time (as cpal's `asio-sys` does). The shipped binary then contains a non-MIT component, and SignPath Foundation's "no proprietary code" rule may block free signing of that binary. **Third path:** `azo` (MIT clean-room Rust ASIO host, 4 stars) is too immature, so watch it. **Plan:** WASAPI at launch; ASIO via the signed proprietary agreement in a separately built engine binary. Document it in NOTICES. |
| **CLAP** | MIT (`free-audio/clap`) | ✅ First-class. `clack-host` is MIT/Apache. |
| **ARA** (Celemony) | **Apache-2.0** (ARA_API, ARA_Library) | ✅ Possible later for Melodyne-style plugin integration. |
| **LV2** | ISC | ✅, but not needed on Windows. |
| **Ableton Link** | **GPL-2.0-or-later** (`Ableton/link` LICENSE), plus a proprietary option from Ableton **(terms unverified)** | ⚠️ Request the proprietary license, or run Link in a separate GPL sidecar process (it only exchanges timing messages, so the context-switch cost is tolerable), or skip it. |
| **JUCE** | AGPLv3 or commercial ("JUCE 9 licence") | ❌ Avoid. |
| **Windows MIDI Services** | MIT (Microsoft) | ✅ When it leaves preview. |

### 9.5 GPL contamination: what crosses which boundary

The FSF GPL FAQ entries "GPLPlugins", "NFUseGPLPlugins" and "MereAggregation" set out the doctrine. gnu.org refused connections from this environment, so the wording was not re-quoted. In short:
- Separate programs communicating via pipes, sockets or the command line are normally an **aggregate**.
- Code that shares an address space and makes function calls is normally **one combined program**.

| Scenario | Risk | Rule |
|---|---|---|
| A user installs a GPL plugin (e.g. Surge XT) and Krypt Studio loads it | **None for us.** No distribution happens. MIT is GPL-compatible anyway, and Ardour's "Plugin Clarification" states the community consensus that host and plugin under a third-party API are not derivatives. | Allowed. |
| **We bundle** a GPL plugin in our installer | Mere aggregation if it is a separate file loaded via a standard API, but we must then meet the GPL for that component (license text plus a source offer). | Prefer an **optional download** from inside the app; if bundled, ship the source link and license. |
| Linking a GPL/AGPL library into our engine or renderer (Rubber Band, JUCE, openDAW SDK, PyFLP, VeSTige, the ASIO GPL build) | **Contaminates** the binary: the distributed combination must be GPL/AGPL. | ❌ Never. Enforce with CI (section 10). |
| LGPL library (libsndfile, FluidSynth, LAME) | OK only if dynamically linked, user-replaceable, with notices. Rust static linking makes this awkward. | Prefer the permissive alternatives. If unavoidable, use a separate DLL. |
| MPL-2.0 (symphonia) | File-level copyleft only: modified MPL files must be published. | OK. Note it in THIRD-PARTY-NOTICES, as KryptEditor did for mediabunny. |
| A GPL component we really need (Ableton Link, the ASIO GPL build) | — | Put it in a **separate executable** speaking a documented, generic IPC protocol. Publish that executable's source under GPL; the MIT app stays MIT. **Caveat:** per-buffer audio across processes costs about 30 µs per switch (Ardour's numbers). That is fine for Link, but not for an ASIO data path. |
| Krypt §9 "lightweight protection" (obfuscation, integrity checks) | Fine for our own MIT code. Must not obstruct source availability of GPL/MPL components. SignPath needs builds reproducible from the repo (obfuscation in CI is fine). | Apply only to Krypt-owned modules. |
| AI model weights (stems, audio→MIDI) | Weights carry their own licenses, which may be non-commercial (KryptEditor ships a CC-BY-NC TTS model). | List every model and its license in the notices; prefer MIT/Apache weights. |

### 9.6 Distribution: unsigned installers and SmartScreen

Per Microsoft Learn, *Code signing options for Windows app developers*, updated 2026-08-29:

| Option | Cost | SmartScreen | Notes |
|---|---|---|---|
| **Unsigned** | Free | **"Strong SmartScreen block; enterprises may block entirely"** | Violates house guide §11/§13 ("single signed .exe"). ❌ |
| **Microsoft Store, MSIX** | Free | **No warnings.** Microsoft re-signs. | electron-builder has an `appx` target. **Spike needed:** plugin scanning, sidecar engine and ASIO COM access under MSIX containment. |
| Microsoft Store, MSI/EXE | Your own certificate | No prompts during Store install | We must sign it ourselves. |
| **Azure Artifact Signing** (formerly Trusted Signing) | **About $9.99/month** | Reputation builds over time | **Individuals: US and Canada only**; organisations: US, Canada, EU, UK. CI-friendly, no hardware token. |
| OV certificate | $150–300/year | Same as Artifact Signing | Private key on an HSM or token (CA/B rule since June 2023). |
| EV certificate | $400+/year | **Same as OV since 2024: no more instant bypass** | Not worth the premium. |
| **SignPath Foundation** | **Free for OSS** | OV-level; reputation builds | **Requirements:** an OSI license with no commercial dual-licensing, **no proprietary components**, an automated build verified against the repo, a published code-signing policy, and active maintenance. **Downside:** the Foundation is the publisher of record, so the certificate name is not "Krypt". |

- **Certificate lifetime:** CA/B Forum ballot **CSC-31** caps publicly trusted code-signing certificates at **460 days for certificates issued from 2026-03-01**. Budget for renewal roughly every 15 months.
- **Reputation:** reputation accrues to the publisher identity and builds per file, so keep **one consistent signing identity**. Expect the first releases to warn.
- **Mitigations:**
  - Ship from GitHub Releases plus a winget manifest.
  - Submit each release to the Microsoft Defender false-positive portal.
  - Explain the warning honestly on the download page (Krypt voice: blunt).
- **Recommendation:** use the **Microsoft Store (MSIX) as the main channel if the spike passes**, plus a signed NSIS build for power users.
  - If the publisher is a US/Canada individual or a qualifying organisation, sign with Azure Artifact Signing.
  - Otherwise use SignPath. This is only possible if the ASIO binary is built separately, or if ASIO goes through the proprietary route in a separately signed package.

---

## 10. Legal checklist (before the first public build)

**Naming and branding**
- [ ] Product name "Krypt Studio" everywhere (productName, Discord app, installer, window title). `krypt-studio`, `cc.krypt.studio`.
- [ ] USPTO, EUIPO (TMview) and UKIPO searches for KRYPT / KRYPT STUDIO in Classes 9 and 42. Consider filing "KRYPT" for the suite.
- [ ] Add `TRADEMARKS.md` (forks must rebrand) and link it from the README and About page.
- [ ] Image-Line disclaimer in the About page and on the FLP-import screen. No FL, Fruity or Image-Line plugin names, logos, skins or sounds anywhere.
- [ ] VST trademark: if we show "VST3 compatible", use the unaltered logo in the About page and docs only. Never put "VST" in a product or feature name.

**Licenses and dependencies**
- [ ] CI license gate: `cargo-deny` (Rust) and `license-checker --production` (npm), with a deny-list of GPL-*, AGPL-* and SSPL and an allow-list of MIT, Apache-2.0, BSD-*, ISC, Zlib, Unlicense, CC0, MPL-2.0 and 0BSD. LGPL needs manual approval.
- [ ] `THIRD-PARTY-NOTICES.md` in KryptEditor's format, listing every bundled library, the MPL-2.0 source pointers (symphonia), every **model** license, and the Signal attribution (MIT notice retained in vendored files).
- [ ] VST3 SDK MIT notice included in the binary's notices.
- [ ] ASIO: sign Steinberg's proprietary agreement and receive the countersigned copy **before** shipping an ASIO-enabled binary. SDK fetched at CI, never committed. Follow the ASIO logo and usage guidelines.
- [ ] No VST2 in v1. No Ableton Link unless separately licensed or sidecar-isolated.
- [ ] If any GPL plugin is offered, deliver it as an optional download with its license and source link.

**Clean room and IP hygiene**
- [ ] `CONTRIBUTING.md` with DCO sign-off, a no-copying attestation, and an AI-code-understood clause.
- [ ] `docs/formats/flp/` holding the clean-room spec, observation log and reader/implementer roles. Fixtures are our own projects only.
- [ ] Provenance log for all factory content (prefer CC0 and originals).
- [ ] No Melodyne-style polyphonic note editing before the 2029-06 expiry of US 8,022,286.
- [ ] Codecs: decode AAC only via Media Foundation (or AAC-LC); no AAC encoder; MP3 is OK.

**Distribution and privacy**
- [ ] Code-signing route chosen (Store MSIX, Artifact Signing or SignPath); certificate renewal is on the calendar (460-day maximum).
- [ ] Published code-signing policy page (needed for SignPath; good practice anyway).
- [ ] No telemetry (house rule). Any MCP network listener is **off by default**, bound to localhost, with a per-session token. This is a security item for the MCP research topic, flagged here because an exposed control port is a liability.
- [ ] A user EULA is not needed (MIT), but state "no warranty" in the About page and installer.

---

## 11. Sources

**Repos and registries** (queried via the GitHub API, the Codeberg API, crates.io and npm on 2026-10-11)
- LMMS — https://github.com/LMMS/lmms · 1.3.0-alpha.2 release notes: https://github.com/LMMS/lmms/releases/tag/v1.3.0-alpha.2 · `include/AudioEngine.h`
- Zrythm — https://github.com/zrythm/zrythm (LICENSES/LicenseRef-ZrythmLicense.txt, releases)
- Ardour — https://github.com/Ardour/ardour (COPYING with the Plugin Clarification) · https://ardour.org/plugins-in-process.html
- Qtractor — https://github.com/rncbc/qtractor · MuSE — https://github.com/muse-sequencer/muse
- Tracktion Engine — https://github.com/Tracktion/tracktion_engine (LICENSE.md) · Waveform Free 13.5: https://mixdownmag.com.au/news/tracktion-releases-waveform-free-13-5-the-only-truly-unrestricted-free-daw
- Meadowlark — https://github.com/MeadowlarkDAW/Meadowlark · https://codeberg.org/Meadowlark/Meadowlark · https://codeberg.org/Meadowlark/meadowlark-journal · https://codeberg.org/Meadowlark/creek · https://codeberg.org/Meadowlark/symphonium · https://zff.dev/Meadowlark/Dropseed
- Firewheel — https://github.com/BillyDM/Firewheel (README, DESIGN_DOC.md)
- Helio — https://github.com/helio-fm/helio-sequencer (Docs/getting-started.md, Docs/command-palette.md)
- Bespoke — https://github.com/BespokeSynth/BespokeSynth
- generic-daw — https://github.com/generic-daw/generic-daw · chipbox — https://github.com/chipnertkj/chipbox · tripplyons/daw — https://github.com/tripplyons/daw · AAADAW — https://github.com/mumu-lhl/AAADAW
- openDAW — https://github.com/andremichelle/openDAW (README dual-license table, introduction.md) · newsletter https://buttondown.com/opendaw
- GridSound — https://github.com/gridsound/daw
- Signal — https://github.com/ryohey/signal (ARCHITECTURE.md) · https://github.com/ryohey/midifile-ts · https://github.com/ryohey/wavelet · https://github.com/ryohey/webgl-react
- waveform-playlist — https://github.com/naomiaro/waveform-playlist
- Audiotool Nexus — https://github.com/audiotool/nexus · https://developer.audiotool.com/js-package-documentation/
- WAM — https://github.com/webaudiomodules/api · https://www.npmjs.com/package/@webaudiomodules/api · WebCLAP https://github.com/free-audio/web-clap
- Soundtrap — https://en.wikipedia.org/wiki/Soundtrap · BandLab — https://en.wikipedia.org/wiki/BandLab_Technologies · Cakewalk/SONAR — https://en.wikipedia.org/wiki/Cakewalk_Sonar
- Bitwig hosting modes — https://bitwig.com/support/technical_support/what-is-plug-in-crash-protection-26 · Bitwig 6 — https://www.soundonsound.com/news/bitwig-studio-6-launches · https://synthanatomy.com/2026/03/bitwig-studio-6.html
- REAPER — https://en.wikipedia.org/wiki/REAPER · Renoise 3.5 — https://sonicstate.com/news/2025/07/08/renoise-35-released/ · https://en.wikipedia.org/wiki/Renoise
- FL Studio 2025 — https://mixdownmag.com.au/news/announcing-fl-studio-2025/ · FL Studio 2026 Gopher — https://routenote.com/blog/fl-studio-2026-gopher-ai-production-assistant/
- MCP bridges — https://github.com/rosasynthesiz/flstudio-mcp · https://github.com/TwelveTake-Studios/reaper-mcp · https://github.com/ahujasid/ableton-mcp · https://github.com/uisato/ableton-mcp-extended
- Rust crates — https://crates.io/crates/cpal · /clack-host · /vst3 · /midir · /midly · /symphonia · /rubato · /creek · /firewheel · /fundsp · /rtrb · /basedrop · /assert_no_alloc · /hound · /rustysynth · /symphonium · /signalsmith-stretch
- Other libs — https://github.com/Signalsmith-Audio/signalsmith-stretch · https://github.com/sinshu/rustysynth · https://github.com/sfztools/sfizz · https://github.com/spessasus/SpessaSynth · https://github.com/schellingb/TinySoundFont · https://github.com/libsndfile/libsndfile · https://github.com/FluidSynth/fluidsynth · https://github.com/breakfastquay/rubberband · https://github.com/juce-framework/JUCE (LICENSE.md) · https://github.com/microsoft/MIDI · https://github.com/napi-rs/napi-rs
- Ableton Link — https://github.com/Ableton/link (LICENSE.md)
- ARA — https://github.com/Celemony/ARA_API

**Steinberg / VST / ASIO**
- VST 3.8 MIT press release (29 Oct 2025) — https://ocl-steinberg-live.steinberg.net/_storage/asset/819253/storage/master/Press%20Release%20-%202025-10-29%20-%20VST%203.8%20-%20EN.pdf
- VST3 SDK LICENSE and README (license and trademark sections) — https://github.com/steinbergmedia/vst3sdk
- ASIO dual licensing — https://heise.de/-10963451 · https://en.wikipedia.org/wiki/Audio_Stream_Input/Output · OBS partnership PR (15 Oct 2025): https://ocl-steinberg-live.steinberg.net/_storage/asset/808575/storage/master/Press%20Release%20-%202025-10-15%20-%20OBS%20Partnership-%20EN.pdf
- Proprietary ASIO agreement procedure — https://forums.steinberg.net/t/where-do-i-submit-the-proprietary-asio-sdk-license-agreement/1035889
- ASIO SDK 2.3.4 mirror (dual-license README) — https://zff.dev/rubiefawn/asiosdk
- cpal `asio-sys` (downloads the SDK at build time) — https://github.com/RustAudio/cpal/tree/master/asio-sys
- azo (MIT clean-room ASIO) — https://github.com/LastExceed/azo
- VST2 clean-room header — https://github.com/Xaymar/vst2sdk · VeSTige DMCA (2018) — https://lists.linuxaudio.org/archives/linux-audio-dev/2018-June/037132.html · DPF note — https://git.kx.studio/DISTRHO/DPF/commit/f9924e0e8152d7895a84f2b3d0b5ae556169cc10
- Coverage — https://sonicstate.com/news/2025/10/30/vst-3-now-available-under-mit-license · https://cdm.link/open-steinberg-vst3-and-asio/ · https://discuss.pixls.us/t/vst3-becomes-open-source-asio-goes-gpl-compatible/53917

**Interchange**
- DAWproject — https://github.com/bitwig/dawproject · Cubase 14 adoption — https://www.production-expert.com/production-expert-1/steinberg-joins-dawproject-support-can-avid-ignore-it · Studio One — https://support.presonus.com/hc/en-us/articles/19743606863629-Introducing-DAW-Project · Bitwig/PreSonus launch — https://www.bitwig.com/stories/bitwig-and-presonus-are-making-it-easy-to-share-projects-between-programs-271/
- PyFLP — https://github.com/demberto/PyFLP · format docs: https://pyflp.readthedocs.io/en/latest/architecture/flp-format.html · FLPFile — https://pypi.org/project/FLPFile/ · flparser — https://github.com/ekkx/flparser

**Legal**
- Image-Line history (FruityLoops / Kellogg's) — https://www.image-line.com/company-history
- *Lotus v. Borland* — https://en.wikipedia.org/wiki/Lotus_Development_Corp._v._Borland_International,_Inc.
- *SAS v World Programming* (CJEU C-406/10) — https://en.wikipedia.org/wiki/SAS_Institute_Inc_v_World_Programming_Ltd
- FSF GPL FAQ (plugins, aggregation; **not re-fetched, gnu.org unreachable**) — https://www.gnu.org/licenses/gpl-faq.html#GPLPlugins · #NFUseGPLPlugins · #MereAggregation
- MP3 patent expiry — https://gigazine.net/gsc_news/en/20170502-mp3-licensing-program-finished · https://512pixels.net/2017/05/the-mp3-isnt-dead/
- AAC pool — https://via-la.com/via-licensing-alliance-welcomes-honor-as-advanced-audio-coding-patent-pool-licensee/ · fdk-aac-free / Fedora — https://en.wikipedia.org/wiki/Fraunhofer_FDK_AAC · https://lists.fedorahosted.org/archives/list/package-review@lists.fedoraproject.org/2019/6/?page=44
- Celemony DNA patent — https://patents.google.com/patent/US8022286
- Trademark near-misses — https://rekkerd.org/vitling-releases-crypt-free-supersaw-synthesizer-plugin/ · https://www.kvraudio.com/forum/viewtopic.php?t=228333 · https://www.allstudios.co.uk/?p=2195

**Distribution**
- Microsoft Learn, code signing options (updated 2026-08-29) — https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- EV no longer bypasses SmartScreen — https://www.todesktop.com/blog/posts/windows-apps-psa-ev-certs-do-not-grant-immediate-reputation-anymore
- 460-day certificate cap (CSC-31, effective 2026-03-01) — https://www.digicert.com/blog/understanding-the-new-code-signing-certificate-validity-change · https://www.globalsign.com/en/blog/code-signing-validity-changes
- SignPath Foundation — https://signpath.org/terms · https://about.signpath.io/product/open-source

**House context**
- The Krypt house engineering guidelines, kept outside this repository (§4 stack, §12 naming, §13 MIT/signed)
- KryptEditor's `THIRD-PARTY-NOTICES.md`, a sibling Krypt project (OpenCut/MIT attribution precedent)
