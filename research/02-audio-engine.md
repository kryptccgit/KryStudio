# KryptStudio Research 02: Real-Time Audio Engine Architecture

- **Date:** 2026-10-11
- **Track:** 2 of 7 (audio engine)
- **Status:** Recommendation, ready for spikes
- **Scope:** Engine architecture, process and thread model, engine internals, dependencies, spike plan, risks. Plugin-format UX, MCP tool design, stock-plugin DSP and UI are out of scope. Other tracks cover them; this report only notes where they touch the engine.

---

## 0. TL;DR

**Recommendation: (b2). Build a native Rust engine as a sidecar process (`krypt-engine.exe`) under the unchanged Electron house stack.**

1. **Processes.**
   - Electron's main process owns the authoritative project model, undo, the MCP server and an engine supervisor.
   - The Rust sidecar owns audio I/O, the DSP graph and plugins.
   - They talk over a named-pipe control channel (length-prefixed MessagePack).
   - The engine streams meters, playhead and scope data at 60 Hz straight to the renderer over a token-protected localhost WebSocket. This keeps the Electron main thread out of the animation path.
2. **Threads in the engine.**
   - An ASIO or WASAPI callback thread, registered with MMCSS "Pro Audio".
   - A worker pool of N-1 threads that runs the compiled mixer DAG in parallel.
   - A non-real-time control thread that applies model diffs, compiles graphs and loads plugins.
   - Disk-streaming and loader threads, plus a telemetry thread.
   - UI→audio traffic only crosses lock-free SPSC queues (`rtrb`), and retired objects are freed off the audio thread.
3. **Audio I/O.**
   - Use ASIO via `cpal`'s `asio` feature. This needs Steinberg's ASIO SDK under its **proprietary licence**, not the GPLv3 option.
   - Add our own WASAPI backends for exclusive mode (`wasapi` crate) and IAudioClient3 low-latency shared mode (`windows` crate).
   - Plain `cpal` WASAPI shared mode is the fallback. On the dev machine it is fixed at 480-frame (10 ms) callbacks whatever buffer size you ask for.
4. **Build the DAW core ourselves.** The parts are the graph compiler, scheduler, PDC, tempo map and sequencer. Use proven crates for I/O, real-time plumbing, decoding, resampling and FFT. No Rust crate is a DAW engine:
   - Firewheel explicitly says it is not one and is single-threaded.
   - Meadowlark is AGPL and incomplete.
   - Read Tracktion's published graph design docs for ideas; don't copy their GPL code.
5. **Why not the alternatives.**
   - **Web Audio:** about 10 ms base plus about 32 ms output latency measured in Chrome 154 on this machine, no ASIO, no VST/CLAP, and one real-time thread.
   - **In-process napi addon:** a crash in the engine or a plugin takes down the whole app.
   - **JUCE / Tracktion:** AGPL/GPL, or a proprietary licence that conflicts with "free + MIT".
   - **Tauri:** no audio advantage once the engine is a sidecar, and it breaks the house stack.
6. **Licensing tailwinds.** The VST 3 SDK has been **MIT since 3.8** (Oct 2025; repo is now at v3.8.1) and CLAP is MIT, so plugin hosting is legally clean. For time-stretch, use **signalsmith-stretch (MIT)** by default and treat Bungee (MPL-2.0) as optional. Rubber Band (GPL) is out.

The same `krypt-engine.exe` doubles as a **headless renderer** (`--render`) for MCP agents and CI golden tests. That is a big reason to prefer the sidecar.

---

## 1. Requirements the engine must meet

| # | Requirement | Why it matters for KryptStudio |
|---|---|---|
| R1 | 64–256-frame buffers at 44.1/48 kHz on Windows (ASIO and WASAPI exclusive) with no xruns under UI load | FL Studio users expect ASIO and live playing of instruments |
| R2 | Host third-party VST3 and CLAP instruments and effects, with editors | An FL-style workflow is unusable without plugins |
| R3 | Mixer with 100+ insert tracks, 10 FX slots each, sends, sidechains, multi-core | FL's Mixer model |
| R4 | Sample-accurate notes and automation; tempo map; swing; pattern and song modes | Channel Rack, Piano Roll and Playlist semantics |
| R5 | Plugin delay compensation that stays correct across sends and nested buses | Professional mixing correctness |
| R6 | Sample playback with time-stretch and pitch-shift; disk streaming of long audio | Audio clips and samplers |
| R7 | Offline faster-than-real-time render and stems | Export, and agent "render and analyse" loops |
| R8 | 60 fps meters, scope and playhead | UI feel |
| R9 | The UI survives engine or plugin crashes | Plugins crash; users lose work |
| R10 | The UI and an MCP agent both mutate the project concurrently | Core product differentiator |
| R11 | All bundled code is MIT-compatible; no GPL/AGPL linked in | House rule |
| R12 | Fits the Krypt stack: no C++ compile at `npm install`, native modules handled per kryptguidelines §4.1/§6 | House rule (`kryptguidelines.md` §4.1 "Hard rule") |

---

## 2. Evidence: Windows latency, with numbers

### 2.1 Measured on the dev machine (this research, 2026-10-11)

Machine: i7-10700K (8C/16T), Windows 10 22H2 (19045). The default output is a USB "Arctis Nova Pro Wireless" headset. Probes are in the scratchpad (`cpalprobe`, `ac3probe`, `bench/`) and can be reused for Spike 1.

| Probe | Result |
|---|---|
| `cpal 0.18.2` WASAPI shared, `BufferSize::Default` | Callbacks of **480 frames (10.00 ms)**, p50 interval 10.00 ms, p99 10.83 ms. The first callback was 1056 frames (prefill). |
| `cpal 0.18.2` WASAPI shared, `BufferSize::Fixed(128 / 256 / 480)` | **Still 480 frames.** The device reports `buffer_size: Range { min: 480, max: 480 }`. cpal only uses `IAudioClient` shared mode (source checked: no `IAudioClient3`, no exclusive mode). |
| `IAudioClient3::GetSharedModeEnginePeriod`: USB headset, NVIDIA HDMI, Steam virtual devices | min = default = max = **480 frames (10 ms)**. No low-latency shared mode. |
| `IAudioClient3::GetSharedModeEnginePeriod`: onboard "High Definition Audio Device" (S/PDIF, Microsoft inbox driver) | min **128 frames (2.67 ms)**, fundamental 32, default 480. This matches Microsoft's documentation. |
| `GetDevicePeriod` minimum (exclusive mode) | **3.00 ms** on all endpoints (2.67 ms on the HDAudio one) |
| Chrome 154 `AudioContext({latencyHint:'interactive'})` on the default device | **baseLatency 10.00 ms + outputLatency 32.00 ms** (about 42 ms output-only). `'playback'` gives baseLatency 20 ms. |
| Node 24 ↔ Node 24 named pipe RTT (`\\.\pipe\…`), 64 B | p50 **24 µs**, p90 34 µs, p99 93 µs, p99.9 176 µs, max 1.55 ms |
| Same, 4 KB (a meter frame) | p50 28 µs, p99 115 µs, p99.9 202 µs |
| Same, 64 KB (a scope or waveform chunk) | p50 63 µs, p99 227 µs, p99.9 590 µs |

**Conclusions:**
- (1) WASAPI shared mode through cpal cannot go below 10 ms periods on typical USB and HDMI devices, so we need ASIO and WASAPI exclusive.
- (2) Low-latency shared mode is driver-dependent. Here only the inbox HDAudio endpoint offers it.
- (3) Chromium's audio path is at least 10 ms base plus device output latency. Web Audio can't reach "play a VST live" territory.
- (4) Cross-process IPC costs tens of microseconds. It is irrelevant next to a 16.7 ms UI frame or a 1.33–5.33 ms audio block.

### 2.2 Published figures

| Source | Figure |
|---|---|
| Microsoft, "Low Latency Audio" | Windows 10+ apps default to **10 ms** buffers unless they opt in through IAudioClient3 or AudioGraph. The inbox HDAudio driver supports **128 samples (2.66 ms) to 480 samples (10 ms)**. The audio engine's own latency dropped from about 12 ms (float, Win 8.1) to **1.3 ms**. If one app requests small buffers, every app on that endpoint and mode switches to them. |
| miniaudio discussion #1084 (field reports) | WASAPI shared round trip of **83 ms / 93 ms** on Realtek laptops. Exclusive both ways on an older Realtek: **4–5 ms @ 64 frames**. Low-latency shared stayed at 480 frames on a Realtek laptop and reached 336 frames on a Thunderbolt-dock USB device. Exclusive mode at very small buffers distorted after minutes on several devices; MMCSS "Pro Audio" reduced but did not eliminate glitches. A MOTU M2 glitched every 1–2 minutes, worse on Win11 24H2. |
| Jeff Kaufman, "AudioWorklet latency: Firefox vs Chrome" (2020, macOS) | Echo loop: **Chrome 124 ms (77–163 ms)**, Firefox 62 ms, REAPER 15 ms. With `latencyHint: 0` and the getUserMedia DSP disabled: **Chrome 19–41 ms** (varying), Firefox 14 ms, REAPER 11 ms. |
| Chromium blink-dev, "Configurable render quantum" | `renderSizeHint` ships in **Chrome 153**. Until then the AudioWorklet quantum is fixed at 128 frames, and the `"hardware"` hint currently returns 128. Electron 44 is on Chromium 152, so it is not yet available in Electron stable. |
| mozilla/cubeb PR #740 | Firefox's IAudioClient3 path was rolled back in an emergency after field problems. The re-enable PR (opened 2023) is **still open** as of Sept 2026. This shows how hard low-latency shared mode is to ship broadly. |
| ASIO (arithmetic) | @48 kHz: 64 frames = 1.33 ms, 128 = 2.67 ms, 256 = 5.33 ms per buffer. Real round-trip latency adds converter and driver safety buffers. Typical good USB interfaces land around 5–10 ms RTL at 64–128 frames; this is from domain knowledge, so **Spike 1 must measure it**. |

---

## 3. Options analysed

### 3.1 (a) Pure Web Audio + AudioWorklet + WASM DSP inside Electron

**How it would work.** One `AudioContext` lives in the renderer. The engine runs as Rust→WASM in an `AudioWorkletProcessor`, and UI↔worklet traffic uses `SharedArrayBuffer` ring buffers. `OfflineAudioContext` handles bounces.

**What openDAW shows is possible** (AGPL-3.0, active, 2.2k★, pushed 2026-10-10):
- Its default engine is a **Rust→WASM `engine.wasm`** inside an AudioWorklet. It dynamically links **27 device side-modules** (~2 KB each) into shared memory and a function table.
- There is also a TypeScript engine fallback.
- The authoritative "box graph" lives on the main thread and is mirrored into the worklet through a sync protocol. "The audio thread never reads main thread state directly."
- Telemetry flows back through a lock-free `LiveStream`.
- Offline rendering runs in a worker, time-stretch analysis runs in a worker (`stretch_wasm`), and collaboration uses yjs.
- Its README asks for help **wrapping it with Tauri** for a desktop app.

It is architecturally excellent, and we can learn patterns from it, but **we cannot reuse any of its code**: AGPL.

**Hard limits on Windows:**
- **Latency:** Chromium uses WASAPI shared mode. We measured `baseLatency` 10 ms plus `outputLatency` 32 ms (Chrome 154). The tracking issue "Chrome does not use Windows low latency audio features" was never resolved, and there is no exclusive mode or IAudioClient3 path. Input through `getUserMedia` adds its own buffering, so live monitoring round trip is typically 40–100+ ms.
- **No ASIO.** Users can't pick their interface's ASIO driver or buffer size. Multichannel interface I/O is very limited.
- **No VST3/CLAP hosting.** A renderer cannot load native DLLs. We would need a native sidecar for plugins anyway, which brings back option (b) with extra latency.
- **One real-time thread per AudioContext.** Spreading mixer DSP across cores means Workers plus SAB. Chrome's own design-pattern article warns the synchronisation is "loose" and that under load "the stream may see duplicated or dropped audio".
- **GC and jank.** Any JS in the worklet risks GC pauses. WASM avoids that, but WASM compilation and instantiation must stay off the main thread; kryptguidelines §4.1 calls this the "WASM-in-Electron trap".
- **Fixed 128-frame quantum** until `renderSizeHint` lands (Chrome 153+).
- **Lifetime coupling.** A renderer reload or crash kills audio.

**Verdict:** fine for a browser demo or future web edition. It can't meet R1, R2, R3 or R9. Keep the engine core portable so a future WASM/AudioWorklet build stays possible, as openDAW and Firewheel both show.

### 3.2 (b) Native Rust engine

#### (b1) In-process napi-rs addon (`napi` 3.14.2, MIT)

- **Pros:** lowest-overhead calls (a JS→Rust call is about 1 µs) and one process to ship. It fits the house rule: prebuilt `.node` + Vite `external` + electron-builder `asarUnpack`. The audio thread is a native thread, so V8 GC does not touch it.
- **Cons:**
  - Any engine panic-abort, access violation or **third-party plugin crash kills the Electron main process**, and with it the window, model and MCP server. That fails R9.
  - Plugin editor windows need a Win32 message loop and HWND parenting inside Electron's main process, which is fragile.
  - No headless reuse without building a second binary.
  - The engine shares the process's memory and handle budget with Chromium.
- **Where napi still helps:** optional later "thin client" addons, such as mapping a shared-memory region for zero-copy waveform peaks. That is an optimisation, not the architecture.

#### (b2) Sidecar process (recommended)

- **Pros:**
  - **Crash isolation:** the UI survives and the engine restarts from the model snapshot.
  - Its own Win32 message loop thread hosts plugin editors.
  - Its own process priority and power-throttling settings.
  - The same binary is a **CLI renderer** for MCP agents and CI.
  - The engine is testable without Electron.
  - It is shell-agnostic (Electron today, Tauri or web later).
  - No native module in the Electron build at all: the exe ships via `extraResources`.
- **Cons:**
  - We need an IPC protocol, versioning and a supervisor.
  - Each control hop costs about 25–100 µs (measured), which is negligible.
  - Two representations of state (TS model and Rust render model) need sync discipline (§6.11).
  - The exe must be code-signed to avoid SmartScreen and AV friction.

#### Rust crate evaluation (verified on crates.io and GitHub, 2026-10-11)

**Audio I/O**

| Crate | Version (date) | License | Assessment |
|---|---|---|---|
| `cpal` | 0.18.2 (2026-08-16) | Apache-2.0 | The standard; active (7.9M recent downloads). **WASAPI shared-only** (exclusive-mode PR #1368 still open). Its WASAPI backend ignores `BufferSize::Fixed` below the engine period (measured). **ASIO** comes behind the `asio` feature through `asio-sys` 0.4.0. 0.18 added driver-reported latency in timestamps, `kAsioBufferSizeChange` and `kAsioResetRequest` handling, duplex fixes, and a `realtime` feature that promotes threads via `audio_thread_priority`. Breaking API churn between minors means we wrap it behind our own trait. |
| `asio-sys` | 0.4.0 (2026-08-16) | Apache-2.0 (crate) + Steinberg ASIO SDK | Downloads the ASIO SDK at build time unless `CPAL_ASIO_DIR` is set. Needs **libclang** for bindgen. The SDK (2.3.4) is **dual GPLv3 / proprietary** since Oct 2025. For an MIT product, **sign Steinberg's proprietary ASIO licence agreement**; the GPLv3 option would make our shipped binary GPL. Ship ASIO only in official builds (cargo feature). |
| `wasapi` (HEnquist) | 0.25.0 (2026-10-01) | MIT | Safe WASAPI wrapper with **shared and exclusive** modes, event-driven and polled timing, device notifications, and exclusive-format probing. Actively maintained; used by CamillaDSP. No IAudioClient3 wrapper, but we can call `IAudioClient3` through `windows` 0.62 directly (done in `ac3probe`, about 40 lines). |
| `windows` | 0.62.2 (2025-10-06) | MIT/Apache-2.0 | Microsoft's bindings. Used for IAudioClient3, MMCSS (`AvSetMmThreadCharacteristicsW`), power throttling, named pipes and file mappings. |
| `rtaudio` (Meadowlark bindings to RtAudio 6) | 0.8.1 (2026-10-06) | MIT | Alternative backend with **native duplex**. The README says this is "the main reason to use this over CPAL". Needs CMake at cargo build. Keep it as plan B if cpal ASIO duplex disappoints. |
| `interflow` | n/a (GitHub, pushed 2026-08) | MIT | Opinionated I/O with duplex, but ASIO is unchecked in its README. Not ready. |
| `audio_thread_priority` (Mozilla) | 0.38.0 (2026-09-17) | MPL-2.0 | MMCSS/RT promotion; used by Firefox and cpal's `realtime` feature. MPL is fine unmodified, or call `windows` APIs directly. |

**Real-time safety and lock-free plumbing**

| Crate | Version (date) | License | Assessment |
|---|---|---|---|
| `rtrb` | 0.4.0 (2026-08-17) | MIT/Apache-2.0 | **Primary SPSC queue** (commands, retire queue, telemetry). Wait-free and allocation-free after construction. Active. |
| `ringbuf` | 0.5.3 (2026-10-08) | MIT/Apache-2.0 | Alternative SPSC with direct slice access. Good for audio-sample rings (scope taps, recording). Active. |
| `basedrop` | 0.1.3 (2025-10-29) | MIT/Apache-2.0 | `Shared`/`Owned` smart pointers with deferred collection on a non-RT thread. Small but alive. Optional: a hand-written retire queue over `rtrb` is about 50 lines and clearer. |
| `assert_no_alloc` | 1.1.2 (2021-08-03) | BSD-1-Clause | Global-allocator guard that aborts or warns on allocation inside `assert_no_alloc(|| …)`. "Finished" rather than stale (1.3M recent downloads). **Works on Windows.** Use it in debug and CI builds around the audio callback and worker jobs. |
| `rtsan-standalone` | 0.3.0 (2025-09-27) | Apache-2.0 | LLVM RealtimeSanitizer: `#[nonblocking]` catches malloc, locks and syscalls at runtime. **Linux, macOS and iOS only**, so run the engine-core tests on a Linux CI runner. |
| `no_denormals` | 0.3.0 (2025-09-11) | MIT | Sets FTZ/DAZ per thread. Call it on the audio thread and every worker. |
| `triple_buffer` | 9.0.0 (2026-02-22) | MPL-2.0 | Latest-value handoff (e.g., transport snapshot). Optional. |
| `arc-swap` | 1.9.2 | MIT/Apache-2.0 | Non-RT config sharing. Don't let the audio thread drop the last `Arc`. |

**Graph and DSP**

| Crate | Version (date) | License | Assessment |
|---|---|---|---|
| `firewheel` (BillyDM) | 0.14.0 (2026-09-05) | MIT/Apache-2.0 | Well-engineered game audio graph: DAG compile to schedule, no mutexes, silence flags, musical clock, sampler, delay-compensation node, CPAL and RtAudio backends. Its README and design doc say it **"does NOT aim to be a complete DAW engine"**. They list **multi-threaded graph processing, VST/VST3 hosting and plugin GUIs as non-goals**, and the project is being upstreamed into **Bevy**. **Don't build on it.** Read its design doc; borrowing small nodes is fine (permissive). |
| `fundsp` | 0.23.0 (2026-01-07) | MIT/Apache-2.0 | Expressive DSP combinator library (oscillators, filters, envelopes, reverbs). Good for **prototyping stock synths and FX** and for Spike 3 dummy loads. Pre-build networks off-thread and keep allocation out of `process`. |
| `dasp` | 0.11.0 (**2020-05-29**) | MIT/Apache-2.0 | No release in 6 years. **Avoid as a dependency**; use `audioadapter` 5.0.0 (MIT/Apache, 2026-07) or our own buffer types. |
| `knyst` | 0.5.1 (**2024-11-25**) | MIT/Apache-2.0 | Stale (123 recent downloads). **Avoid.** |
| `web-audio-api` (+ `node-web-audio-api`) | 1.7.0 (2026-08-08) | MIT (+ BSD-3) | Native Web Audio semantics on cpal. It inherits Web Audio's model (no PDC, single render thread) and cpal's WASAPI-shared limits. **Not a DAW engine.** |
| `rustfft` / `realfft` | 6.4.1 / 3.5.0 | MIT/Apache / MIT | Spectrum analysers, convolution, scope decimation. |
| `ebur128` | 0.1.10 (2024-10) | MIT | LUFS and true-peak, for meters and the agent's "analyse render" tool. |
| `midir` / `wmidi` / `midly` | 0.11.1 / 4.0.11 / 0.5.3 | MIT / MIT / Unlicense | MIDI device I/O, message types, SMF import and export. |
| `clack-host` | 0.2.0 (2026-09-12) | MIT/Apache-2.0 | Safe CLAP hosting in Rust. CLAP itself is MIT (1.2.10). |
| `vst3` (coupler-rs) | 0.3.0 (2025-12-07) | MIT/Apache-2.0 | VST3 COM bindings. The **VST 3 SDK is MIT since 3.8** (repo at v3.8.1, LICENSE "MIT, © 2026 Steinberg"). |

**Disk streaming, decoding and resampling**

| Crate | Version (date) | License | Assessment |
|---|---|---|---|
| `symphonia` | 0.6.1 (2026-08-13) | **MPL-2.0** | Pure-Rust demux and decode (WAV, FLAC, MP3, OGG/Vorbis, AAC/ALAC…). Very active (8.4M recent downloads). MPL-2.0 is file-level copyleft: fine to link into an MIT app if we don't modify it, or publish changes to its files; ship the notice. |
| `creek` | 1.2.3 (2025-09-22) | MIT/Apache-2.0 | Real-time-safe **disk streaming** with pre-cached starts and seek caches (Meadowlark, Codeberg). Maintained but low churn. Use it for long audio clips and recordings playback. |
| `symphonium` | 0.13.0 (2026-08-28) | MIT/Apache-2.0 | Convenience loader (symphonia + resampling) used by Firewheel. Optional. |
| `rubato` | 5.0.1 (2026-10-01) | MIT/Apache-2.0 | High-quality sync and async (sinc/FFT) sample-rate conversion. Very active. Use it at load and stream time for SR mismatches. |
| `hound` | 3.5.1 (2023-09-25) | Apache-2.0 | WAV read and write. Stable. Use it for bounce output and recording files. |

### 3.3 (c) C++ with JUCE 9 or Tracktion Engine

- **JUCE** (current **9.0.3**, 2026-09-28) is dual-licensed **AGPLv3 / commercial JUCE 9 EULA**:
  - **Starter** is free up to **$20k** revenue (trailing 12 months, including affiliates).
  - **Indie** is $800 perpetual or $40/month, up to $300k.
  - **Pro** is $3,500 perpetual or $175/month, with no limit.
  - EULA §1.17 forbids distributing the framework "on its own", and §2.3 forbids making it subject to source-disclosure licences.
- **Tracktion Engine** (3.5.0, active) is dual **GPL-3.0-or-later / commercial**:
  - Every distributor *also* needs a JUCE licence.
  - Its time-stretch relies on élastique or Rubber Band (external commercial licences) or SoundTouch (LGPL).
  - Feature-wise it is the closest thing to "DAW engine in a box": multi-CPU graph, "perfect PDC", tempo curves, step clips with groove templates, clip launching, rendering and plugin hosting.
- **What this means for an MIT app:**
  - Under AGPL/GPL, the distributed KryptStudio binary becomes AGPL/GPL. That **fails R11**.
  - Under commercial licences, the repo can't vendor JUCE or Tracktion. Every contributor and forker must accept the proprietary EULA, and any fork with more than $20k revenue must pay. "Free and MIT" becomes nominal only, so this **also fails R11**, plus cost and vendor lock-in.
- C++ *without* JUCE is viable: RtAudio (MIT-like), PortAudio (MIT), miniaudio (public domain / MIT-0), VST3 SDK (MIT), CLAP (MIT), choc (ISC), signalsmith (MIT). But it gives no advantage over Rust for a team that already has Rust 1.98 and wants memory safety in the engine.
- **Verdict:** disqualified on licence. Tracktion's engine docs (`modules/tracktion_graph/docs/*`) are still worth *reading* for PDC and multithreading design rationale. Don't copy their code.

### 3.4 (d) Tauri v2 instead of Electron

- Tauri 2.12.3 (2026-10-10) is MIT/Apache-2.0. On Windows it renders with **WebView2 (Chromium/Edge)**, so the **Web Audio limits are identical** to Electron's.
- Its real advantages are a smaller installer and an in-process Rust backend. In-process has the same crash-coupling problem as (b1), and Tauri supports sidecars (`bundle.externalBin` + `shell` plugin), so it gains nothing over Electron + sidecar.
- **Costs:**
  - It deviates from the house stack: preload/contextBridge patterns, `koffi`, `uiohook-napi`, electron-builder/NSIS installer conventions and all the hard-won gotchas in kryptguidelines §5–§7.
  - The evergreen WebView2 runtime varies per machine.
  - Node-based MCP SDK tooling would need a separate Node sidecar anyway.
- **Verdict: stay on Electron.** Because the engine is a sidecar with a shell-agnostic protocol, moving to Tauri later stays cheap if installer size ever becomes a priority.

---

## 4. Decision matrix

Scores run from 1 (poor) to 5 (excellent). Weighted total is out of a maximum of 165. **The licence criterion is a gate:** options that fail R11 are disqualified whatever their score.

| Criterion (weight) | A: Web Audio + WASM | B1: Rust napi in-proc | **B2: Rust sidecar** | C1: JUCE/Tracktion AGPL/GPL | C2: JUCE/Tracktion commercial | D: Tauri + Rust in-proc |
|---|---|---|---|---|---|---|
| Windows latency: ASIO, WASAPI excl. (5) | 1 | 5 | **5** | 5 | 5 | 5 |
| VST3/CLAP hosting + editors (4) | 1 | 3 | **5** | 5 | 5 | 3 |
| Multi-core DSP (3) | 2 | 5 | **5** | 5 | 5 | 5 |
| Crash isolation, UI survives (4) | 2 | 1 | **4** (5 with plugin sandboxes) | 4 (if sidecar) | 4 | 1 |
| Licence fit, MIT (5) **[gate]** | 5 | 5 | **5** | 1 (FAIL) | 2 (FAIL) | 5 |
| House-stack fit and velocity (3) | 5 | 4 | **4** | 2 | 2 | 1 |
| Headless render, MCP, CI testability (3) | 3 | 3 | **5** | 4 | 4 | 3 |
| Ready-made DAW building blocks (3) | 3 | 3 | **3** | 5 | 5 | 3 |
| Effort, inverse (3) | 4 | 3 | **2** | 4 | 4 | 3 |
| **Weighted total** | **93** | **120** | **143** | 126 (gated out) | 131 (gated out) | 111 |

B2's main weakness is effort: we write the DAW core ourselves. The spikes in §8 exist to retire that risk early.

---

## 5. Recommended architecture

### 5.1 Process, thread and data-flow diagram

```
┌──────────────────────────────── KryptStudio (Electron 44 / Chromium 152 / Node 24) ────────────────────────────────┐
│                                                                                                                     │
│  RENDERER (React 18 + Zustand + canvas/WebGL)                 MAIN PROCESS (Node)                                   │
│  ┌──────────────────────────────────────────┐   ipc invoke   ┌──────────────────────────────────────────────────┐   │
│  │ Channel Rack · Piano Roll · Playlist ·   │ ── ops ──────▶ │ ProjectHost  (AUTHORITATIVE MODEL)               │   │
│  │ Mixer · Browser                          │                │  · op log, validation, undo/redo, version N      │   │
│  │ Zustand mirror of model (patches @ ver)  │ ◀─ patches ─── │  · emits patches → renderer                      │   │
│  │ rAF playhead extrapolation + meters      │                │  · RenderModelCompiler: patches → engine diffs   │   │
│  └───────────────▲──────────────────────────┘                │ MCP server (agent tools) ──▶ same op API         │   │
│                  │                                           │ EngineSupervisor (electron/system/engine.ts)     │   │
│                  │ TELEMETRY: WebSocket 127.0.0.1:<rand>     │  · spawn abs path, watchdog, restart+resnapshot  │   │
│                  │ binary frames @60 Hz, session token,      └───────────────────────┬──────────────────────────┘   │
│                  │ subscriptions (which meters/scopes)                               │ CONTROL: named pipe          │
└──────────────────┼───────────────────────────────────────────────────────────────────┼──────────────────────────────┘
                   │                                                                   │ \\.\pipe\krypt-engine-<pid>-<nonce>
                   │                                                                   │ u32 len + MessagePack (ts-rs types)
┌──────────────────┴───────────────────────── krypt-engine.exe (Rust, sidecar) ───────┴──────────────────────────────┐
│                                                                                                                     │
│  TELEMETRY THREAD (non-RT, ~60–120 Hz)          CONTROL THREAD (non-RT)                  PLUGIN UI THREAD           │
│  · drain meter/scope rings, FFT, decimate       · apply render-model diffs (ver N)       · Win32 message loop       │
│  · pack frame {pos, qpc, appliedVer, meters…}   · compile graph → Schedule (toposort,     · VST3/CLAP editors       │
│        ▲                                          buffer alloc, PDC, task DAG)                                     │
│        │ rtrb (meters, scope taps, xrun/cpu)    · instantiate/prepare nodes & plugins                               │
│        │                                        · drop retired objects                                              │
│  DISK/LOADER THREADS                                   │  ▲                                                         │
│  · creek streams, symphonia decode,                    │  │ rtrb RETIRE queue (old schedules, buffers, nodes)       │
│    rubato SRC, stretch-cache renders                   ▼  │                                                         │
│        │ creek RT-safe read handles            rtrb CMD queue (SPSC, fixed-size enums + boxed payloads)              │
│        ▼                                               ▼                                                            │
│  ┌──────────────── AUDIO CALLBACK THREAD (ASIO driver thread | WASAPI event thread; MMCSS "Pro Audio") ──────────┐  │
│  │ 1 drain ≤K cmds  2 swap Schedule if pending  3 transport+tempo map → tick range, loop/sub-block split          │  │
│  │ 4 event gen: patterns/clips/automation → per-node sample-offset event lists (swing applied here)              │  │
│  │ 5 run task DAG ──────────────────────┐   6 master out, meters → rtrb   7 publish atomics (pos, appliedVer)    │  │
│  └──────────────────────────────────────┼───────────────────────────────────────────────────────────────────────┘  │
│        WORKER POOL (N-1 threads, MMCSS, FTZ/DAZ, spin→WaitOnAddress) pulls ready nodes from lock-free ready queue  │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
          │ phase 2: per-plugin sandboxes  krypt-pluginhost.exe  (shared-memory audio buffers + event-pair sync)
          ▼
   krypt-engine.exe --render <snapshot> --range … --out …   (same code, offline driver; used by MCP agent + CI)
```

### 5.2 Responsibilities

| Component | Owns | Never does |
|---|---|---|
| **ProjectHost** (main, TS; pure logic in `shared/`) | The authoritative project model, op validation, undo/redo, persistence and the version counter. It is the single writer: UI and MCP ops are serialised through one queue. | DSP, timing-critical work |
| **RenderModelCompiler** (main, TS) | Maps model patches to engine-level entity upserts and deletes, plus fast-path param messages. | Sample-domain maths (engine does that) |
| **EngineSupervisor** (`electron/system/engine.ts`, the only OS-touching code per §4.3) | Spawns `process.resourcesPath/engine/krypt-engine.exe` by **absolute path** with `windowsHide:true`. Handles handshake, heartbeat watchdog, exponential-backoff restart, full resnapshot and crash-dump collection. | Business logic |
| **Engine control thread** | Holds a mirror of the render model. Compiles schedules, loads plugins, owns the device lifecycle and renders. | Touching the audio thread except through queues and atomics |
| **Audio callback + workers** | Process blocks. | Anything in §6.1's forbidden list |
| **Telemetry thread** | Turns RT rings into UI frames and handles per-widget subscriptions. | Blocking the RT side; it only reads rings |

### 5.3 IPC protocol

- **Control channel (main ↔ engine).**
  - A Windows named pipe: Rust side `interprocess` 2.4.5 (0BSD/Apache-2.0), Node side `net`. The pipe name includes the parent PID and a random nonce, and the first message carries a 128-bit token.
  - Framing is `u32` length + **MessagePack** (`rmp-serde` 1.3.1 MIT ↔ `@msgpack/msgpack` 3.1.3 ISC).
  - Message types are defined once in Rust and **generated into `shared/engine-protocol.ts` with `ts-rs` 12.0.1 (MIT)**, so channel drift is caught by `tsc` (kryptguidelines §4.4).
  - Request/response correlation uses `id`, and errors are returned as `{ok:false, message}`, never thrown (§4.3 rule 4).
- **Telemetry channel (engine → renderer).** A WebSocket on `127.0.0.1:<random>` (`tungstenite` 0.30, MIT/Apache) with binary frames. The token and port reach the renderer via `window.krypt.engine.telemetryEndpoint()`, and CSP allows `connect-src ws://127.0.0.1:*`. The renderer receives frames even when the main thread is busy (saving, MCP calls, big diffs).
- **Message classes:**
  - **Model:** `Hello{protocolVersion, token}`, `Snapshot{modelVersion, entities[]}`, `ApplyBatch{modelVersion, upserts[], deletes[]}` → `Applied{modelVersion}`.
  - **Fast path:** `SetParam{node, param, value, rampMs?}`, `Audition{noteOn/off, channel}`, `Transport{play|stop|locate|loop|record|tempoTap}`.
  - **Device:** `ListDevices`, `OpenDevice{backend: Asio|WasapiExclusive|WasapiLowLatency|WasapiShared, id, sr, frames}` → `DeviceStatus{actualFrames, inLatency, outLatency}`.
  - **Jobs:** `RenderJob{range, stems, format, path, realtimeSafePlugins}` → `RenderProgress` / `RenderDone{path, lufs, peak}`.
  - **Plugins:** `ScanPlugins`, `OpenEditor{node}`, `GetState{node}` → `StateChunk{node, bytes}` (persisted into the model for crash recovery and save).
- **Measured cost:** Node↔Node pipe RTT p50 24 µs and p99 93 µs for 64 B; a 4 KB frame has p99 115 µs. The Rust side will be faster. Knob drags at 120 Hz cost less than 1% of one core.

### 5.4 Packaging (fits kryptguidelines)

- `cargo build --release -p krypt-engine` runs as a **pre-`dist` build step**, never at `npm install`, so the "no C++ compile at npm install" rule holds. CI caches it.
- electron-builder uses `"extraResources": [{ "from": "engine/target/release/krypt-engine.exe", "to": "engine/" }]` (outside ASAR, so no `asarUnpack` is needed).
- Sign `krypt-engine.exe` and the installer.
- For dev under `vite-plugin-electron`, the supervisor spawns `engine/target/debug/krypt-engine.exe` and supports `--attach` to an engine started from a debugger.
- ASIO builds need libclang (VS "C++ Clang tools" or LLVM) on the build machine and `CPAL_ASIO_DIR` pointing at the SDK. Contributor builds without the `asio` feature need neither.

---

## 6. Engine internals

### 6.1 Audio-thread rules (applies to the callback **and** worker jobs)

**Forbidden:**
- Heap allocation or free, including `Vec::push` beyond capacity, `Box::new`, `String`/`format!`, and dropping an `Arc`, `Box` or `Vec` that frees.
- Mutexes, `RwLock`, condvars, channels that may block, and `println!` or logging.
- File, network or registry I/O; COM calls into non-RT objects; anything waiting on another thread, except the purpose-built worker-pool join.
- Unbounded loops or recursion; `unwrap`/`expect` that can panic; lazy statics or `thread_local!` first-touch.
- Denormals: set FTZ/DAZ with `no_denormals` on every RT thread.

**Required:**
- Preallocate for `max_block` (1024) and max voices per instrument.
- Pre-touch buffers so there are no page faults; `VirtualLock` the RT arena optionally.
- Bounded per-block work, and bounded command drain (≤K commands per block).
- Atomics use explicit `Acquire`/`Release`.
- Hand every retired object back via the retire queue.

**Thread setup:**
- Call `AvSetMmThreadCharacteristicsW(L"Pro Audio")` (and `AvSetMmThreadPriority` high) on the callback (if the driver hasn't) and on every worker.
- Opt the process out of EcoQoS: `SetProcessInformation(ProcessPowerThrottling, ControlMask=EXECUTION_SPEED|IGNORE_TIMER_RESOLUTION, StateMask=0)`. Microsoft documents that Windows 11 may ignore timer-resolution requests and infer QoS for non-visible processes, and a sidecar has no window.

**Enforcement:**
- `assert_no_alloc` wraps the callback and each job in debug/CI builds on Windows.
- `rtsan-standalone` `#[nonblocking]` marks engine-core functions, exercised by a Linux CI job (RTSan isn't available on Windows).
- `#![deny(clippy::unwrap_used, clippy::expect_used)]` in RT crates.
- A per-block deadline histogram (QPC) reported in telemetry.
- A soak test of 30 minutes at 64 frames.

### 6.2 Lock-free command path (UI → engine)

1. The **UI or agent op** reaches ProjectHost (single writer). That yields version N+1 and patches, which the RenderModelCompiler turns into an `ApplyBatch{N+1}` sent over the pipe.
2. The **engine control thread** mirrors the render model. It does all heavy work off-RT:
   - builds new pattern event indices,
   - builds a new `Schedule` when the topology changes,
   - instantiates and `prepare()`s new nodes and plugins,
   - pre-allocates buffers.
3. It pushes **one** `Cmd::Batch(Box<PreparedBatch>)` into the `rtrb` **CMD queue**, so edits in one batch become audible in the same block. Firewheel uses the same "flush as a group" rule.
4. At the start of the next block, the **audio thread** pops the batch, swaps pointers (schedule, pattern indices, clip lists), sends note-offs for voices whose source notes disappeared, stores `applied_version = N+1` in an atomic, and pushes the **old** objects into the **RETIRE queue**.
5. The control thread drops the retired objects. Optionally, `basedrop` `Owned`/`Shared` automates step 4–5.

**Parameter fast path.** Each node has a preallocated `[AtomicU32]` of target values (f32 bits) plus a "dirty" bitset. Knob drags write atomics (last-writer-wins, naturally coalescing), and the node smooths to the target with a 5–20 ms ramp. This avoids queue floods. Automation playback and recording use the event path instead (§6.5).

**Capacity.** CMD and RETIRE queues have 1024 slots. If the queue is full, the control thread holds the batch and retries next tick; it never blocks the RT side.

### 6.3 Graph compilation and multi-core scheduling of mixer inserts

**Compile on the control thread** whenever routing, slots or channel assignment change:

1. **Nodes:**
   - Channel Rack generators: samplers, synths, plugin instruments.
   - Per-channel processing: volume, pan, pitch.
   - Mixer insert strips, each a node *group* holding its chain of FX slots.
   - Sends and sidechain taps, and the master.
   - Audio-clip and automation sources feed in as events, not nodes.
2. **Validate:** cycle detection (reject feedback routing with a UI error), channel-count matching.
3. **Topological order** (Kahn's algorithm).
4. **Buffer allocation:** interval colouring over the order, so buffers are reused once all their consumers have run (cache-friendly, small arena).
5. **PDC insertion** (§6.4).
6. **Task DAG:** group chains so tasks are coarse enough. Make each mixer insert strip one task (FX run serially inside it), plus one task per instrument channel and per send target. FL-style mixers parallelise per track, so tasks that are too fine add sync overhead.
7. **Emit `Schedule`:** flat arrays of tasks, dependency counts, successor lists, buffer indices and delay-line descriptors. No pointer chasing, no allocation at run time.

**Run time (each block):**
- Reset `remaining_deps[i]` from the template with a `memcpy` of atomics.
- Push root tasks onto a lock-free MPMC ready queue (a bounded array with an atomic head and tail; capacity equals the task count, so there is no allocation).
- The callback thread and N-1 workers pop and run tasks. On completion they decrement successors' counters, and any task that reaches 0 goes onto the queue.
- The callback thread returns when the master task completes.

**Waking workers:**
- Spin with `spin_loop()` for about 20–50 µs, then park on `WaitOnAddress` (cheaper than events).
- Wake with `WakeByAddressAll` at block start.
- Measure wake latency in Spike 3. If p99 wake exceeds about 100 µs, keep workers spinning while transport plays.
- Default thread count is physical cores − 1, with a user setting. On hybrid Intel CPUs (12th gen+), consider `SetThreadSelectedCpuSets` to keep RT workers on P-cores.

**Smart-disable / silence optimisation (FL "Smart disable").** A node whose inputs are all silent, and whose reported tail has expired, skips `process()` and marks its outputs silent. This is Firewheel's silence-mask idea applied to plugins via CLAP `tail` / VST3 `getTailSamples`.

**Phase 2: anticipative processing** (as REAPER does; described from domain knowledge, not re-verified). Tracks without live input render ahead on workers in larger chunks into per-track FIFOs. Only record-armed or monitored tracks run at the device buffer size. This is a big CPU win at 64-frame buffers, but it needs invalidation on edits. Defer until after v1.

**Tracktion's graph-rewrite notes** document the failure mode to avoid. Old "source-time shifting" PDC broke with send→return→send chains, and per-track double-buffered sends added a block of latency. Use explicit **delay nodes on lagging branches** instead.

### 6.4 Plugin delay compensation (PDC)

- Each node reports `latency_samples`:
  - CLAP `latency` extension, or VST3 `IAudioProcessor::getLatencySamples`.
  - Internal look-ahead (limiters, linear-phase EQ, the stretch engine's `inputLatency + outputLatency`).
- **Compile pass, in topological order:** `arrive[n] = max over inputs i (arrive[i] + lat[i])`. For each input edge whose `arrive[i] + lat[i] < arrive[n]`, insert a **delay line** of the difference on that edge (preallocated ring). This covers sends, sidechain inputs (the sidechain is aligned to the main input), nested buses and parallel FX.
- **Total latency** `L = arrive[master] + lat[master]`.
  - Displayed and audible playhead = `render_pos − L − device_output_latency`.
  - Transport start pre-rolls `L` samples so the first transient isn't lost. Tracktion's notes mention hearing material from 0.2 s instead of 0 when this is skipped.
- **Automation alignment.** A plugin at upstream path latency `arrive[n]` sees audio from timeline time `t − arrive[n]`, so its automation and MIDI are evaluated at `t − arrive[n]`. The event generator handles this per node at no extra cost.
- **Runtime latency changes** (a plugin calls `latency.changed` / `restartComponent(kLatencyChanged)`): recompile off-thread and swap at a block boundary. A short click is acceptable; offer "Constrain PDC while recording".
- **Recording and monitoring.** Live-input paths can bypass compensation ("low-latency monitoring"). Recorded audio is offset by input latency plus `L` when written, so it lands on the grid.
- **Null test** (Spike 3): send an impulse through N parallel paths with different latencies, sum and invert. The residual must be below −140 dBFS.

### 6.5 Sample-accurate automation and MIDI events

- **Event model (CLAP-like, used internally for all nodes).** Each node gets a sorted, preallocated slice of `Event{offset_in_block: u32, kind}`. Kinds are note on/off/choke, note expression, param value, param modulation, MIDI CC/pitch bend and transport. CLAP's own header defines `uint32_t time; // sample offset within the buffer`, so external CLAP plugins receive this directly. VST3 receives `IEventList` and `IParameterChanges` with per-point sample offsets.
- **Sources:**
  - Pattern notes (Channel Rack steps, Piano Roll) and Playlist pattern clips are stored as **ticks** (960 PPQ, integer), sorted, with an interval index per pattern.
  - Automation clips are breakpoints in ticks with curve types.
  - Live MIDI comes from `midir` with timestamps.
- **Per-block event generation** (§6.6 provides the tick↔sample mapping): for each active sequence, binary-search the block's tick range and emit events with `offset = sample_of(tick) − block_start` (rounded consistently). Loops and pattern wraps split the block into sub-ranges.
- **Automation.** For internal DSP nodes, emit a value **per 16–32-sample sub-block** and the node ramps linearly within it, which bounds zipper noise and cost. Step changes land exactly on their sample. For external plugins, emit param events at curve breakpoints, plus at most one point every 32–64 samples on curves.
- **Live MIDI input.** Map `midir` µs timestamps to stream time using the correlation (QPC ↔ device sample clock) from cpal/WASAPI/ASIO timestamps. Either play "ASAP" at offset 0 (lowest latency) or apply jitter correction, scheduling at `ts + one block`. Make it a user option, as Bitwig and REAPER do.

### 6.6 Tempo map, transport and swing

- **Time bases:** `Tick = i64` at 960 PPQ (divisible by 3 for triplets; FL uses 96 by default and up to 960 PPQ). `SamplePos = i64` since transport zero. Seconds come from `f64` (`SamplePos / sr`).
- **Tempo map:** a sorted list of segments `{start_tick, bpm_start, bpm_end, shape: Step|Linear}` with **precomputed cumulative sample positions** at segment starts.
  - `tick→sample` is a binary search plus closed form. Constant segments are linear; linear-BPM ramps use `t = (60/(PPQ·k))·ln(bpm(τ)/bpm_0)`, with `k` the BPM slope per tick.
  - `sample→tick` is the inverse.
  - Conversions are exact to within 1 sample over hours. Spike 3 asserts this with a property test against numeric integration.
  - Time signatures only affect the bar and beat grid (UI and quantise), not timing.
- **Transport state machine:** Stopped / Playing / Recording / Pre-roll, in **Pattern mode** (loop the current pattern) or **Song mode** (Playlist, loop region).
  - `locate()` flushes voices (all-notes-off, sampler voice release) and re-seeks the creek streams. Seeks use creek caches, so playback starts instantly where pre-cached.
  - For each block, compute `[tick0, tick1)` from the tempo map. If a loop end or pattern end falls inside, process sub-blocks.
  - Tempo changes take effect at block granularity (sample-accurate within a block via sub-block splits at tempo events).
- **Swing (FL-style global swing, per-channel swing mix):**
  - Swing maps straight 16th-grid positions to swung ones. Within every pair of 16ths (length `2s`), a note at phase `p∈[0,2s)` moves to `p' = p·(1+a)` for `p<s` and `s(1+a) + (p−s)(1−a)` for `p≥s`, where `a = swing·0.5·channel_swing_mix`.
  - The mapping is monotonic and piecewise-linear. Note *lengths* follow the same mapping on their end points.
  - It is applied **at event-generation time**, not baked into stored notes. A swing-knob change is then instant and lossless, and so is "agent changed swing to 55%".
  - Groove templates (phase 2) generalise this to a lookup table of offsets plus velocity scales.

### 6.7 Sample playback, disk streaming, time-stretch and pitch-shift

- **One-shots and Channel Rack samplers.**
  - Fully decoded into RAM by loader threads (`symphonia` decode → `rubato` SRC to engine rate → `Arc<[f32]>` handed over via the CMD batch).
  - Voices use preallocated pools with cubic-Hermite (draft) or 16-tap windowed-sinc (HQ) interpolation for pitch.
  - Loop points, ADSR, choke groups and reverse are engine-native.
- **Long audio clips.** `creek` read streams (RT-safe `read()`, cached starts for instant play, seek caches at clip starts and loop points). If the cache misses, output silence and count an "underrun" in telemetry; never block. Recording uses a write ring → writer thread → `hound`/WAV (RF64 for files over 4 GB, phase 2).
- **Time-stretch and pitch-shift engines** (behind a `Stretcher` trait so we can swap):

| Library | Licence | Notes | Decision |
|---|---|---|---|
| **signalsmith-stretch** (C++11 header-only; Rust crate `signalsmith-stretch` 0.1.3; repo active 2026-09) | **MIT** | Polyphonic phase-vocoder. Best for ratios **0.75–1.5×** (per its README); wide pitch range. Reports `inputLatency`/`outputLatency`. Optional `splitComputation` spreads FFT spikes at the cost of one interval of extra latency. Tracktion bundles it. | **Default** |
| **Bungee** (C++, Parabola Research; repo active 2026-10) | **MPL-2.0** | Granular API, about 100 grains/s. Continuously variable speed including **zero and negative** (scrub, reverse). "Bungee Pro" is commercial. The `bungee-rs` bindings are archived, so we would maintain our own. | Optional "Smooth / scrub" mode; MPL is acceptable if unmodified |
| **timestretch** (pure Rust) | MIT | 0.15.0 (2026-09), very new (25★). DJ/EDM-oriented keylock with WCET-gated real-time engine, beat tracking, CI quality gates against Rubber Band. | Watch list; evaluate in Spike 3 |
| `pitch_shift` | MIT | Simple; quality unproven | No |
| SoundTouch (`soundtouch` crate 0.5.4) | **LGPL-2.1** | Needs dynamic linking and relinkability obligations | Avoid |
| **Rubber Band** (`rubberband` crate) | **GPL-2.0+** / commercial | Best-in-class quality, but GPL | **Excluded** |
| Audacity's StaffPad TimeAndPitch | Part of the GPL Audacity tree, no separate licence header | | **Excluded** |
| élastique (zplane) | Commercial | | No |

- **Stretch strategy:**
  - **Static stretch** (clip warped to project tempo, unchanged): render it in the background into a **stretch cache** (RAM, or disk for long clips) and play it like normal audio. Real-time CPU drops to plain streaming.
  - **Dynamic stretch** (tempo automation, live pitch knobs, scrubbing): run in real time per clip with preallocated stretchers. Account for the stretcher's latency in PDC (§6.4) or with clip pre-roll.
  - Pitch-only changes on short samples use resampling (FL "Resample" mode).

### 6.8 Offline (faster-than-real-time) render and bounce

- An **offline driver** replaces the device. The control thread runs `process(block)` in a loop with no deadline. Block size is configurable (default 512).
- The **worker pool is still used**, so multi-core rendering is often 10–100× real-time on light projects.
- Plugins are told `offline`: VST3 `processMode = kOffline`, CLAP `render` extension `CLAP_RENDER_OFFLINE`. That lets them enable HQ modes.
- creek switches to **blocking reads** (`block_until_ready`), so a render never has cache misses. Live inputs are muted.
- **Tail handling:** keep rendering until all outputs stay below −120 dBFS for 1 s or a user max tail is reached.
- **Outputs:** master, stems (per insert, tapped post-fader), or selected tracks.
- **Telemetry:** progress events, plus a summary computed on the fly: peak, true-peak and integrated LUFS via `ebur128`. **This summary is what MCP agents need** ("render bars 1–9, tell me LUFS and peak").
- **Isolation:** agent and CI renders run in a **separate** `krypt-engine.exe --render` process fed the same snapshot. Live playback is never disturbed, and a render crash can't kill the session.
- **Determinism:** two renders of the same snapshot must be bit-identical, excluding plugins that use randomness. Spike 3 checks this.

### 6.9 Metering, scope and playhead data at 60 fps

- **On the audio thread** (cheap): each meter point accumulates block peak (abs-max) and sum-of-squares per channel into a **preallocated per-point slot**. At block end it pushes one `MeterSample{point, peakL, peakR, msL, msR, frames}` into an `rtrb` ring (or uses `fetch_max` on atomics; positive IEEE floats order like `u32`).
  - Each scope or spectrum **tap the UI subscribed to** gets an `ringbuf` sample ring. Unsubscribed taps cost nothing.
  - Atomics publish `render_pos`, `qpc_at_block_start`, `applied_version`, callback CPU time and xrun count.
- **Telemetry thread** (timer at 60–120 Hz):
  - Drains the rings and computes RMS/peak-hold and LUFS-short per subscribed meter.
  - Runs FFTs (`realfft`) for spectrum taps and decimates scopes (min/max per pixel column), so the UI receives exactly what it draws.
  - Sends **one binary frame**: `{seq, qpc, render_pos, tick, playing, loop, tempo, L_total, out_latency, applied_version, cpu, xruns, meters[], taps[]}`.
  - Size is roughly 128 meters × 16 B, about 2 KB plus taps. At 60 Hz that is about 150 KB/s, trivial (4 KB pipe RTT p50 is 28 µs).
- **UI:** on each `requestAnimationFrame`, extrapolate the audible position: `pos = render_pos + (now_qpc − qpc)·sr − L_total − out_latency`. Converge gently on each new frame (no snapping) and convert to ticks with a renderer copy of the tempo map. Meters do ballistics (decay) on the UI side, so 60 fps animation stays smooth even if one telemetry frame is late.

### 6.10 Engine crash isolation

- **Level 1 (v1): engine sidecar.**
  - The supervisor detects `exit`, a missed heartbeat (watchdog: control thread pings every 250 ms; 2 s silence means a hung engine), or a pipe EOF.
  - It then (1) collects the minidump, using `crash-handler` 0.8.1 + `minidumper` 0.11.0 (MIT/Apache) from an out-of-process monitor thread; (2) toasts "Audio engine restarted"; (3) respawns with backoff of 0.5 s, 1 s, 2 s and so on, capped at 5 tries per minute; (4) sends `Snapshot{N}` plus the last plugin `StateChunk`s; (5) restores the transport position.
  - The user loses at most the plugin-internal state changed since the last state poll. State is polled every 10 s and on every editor close.
- **Level 1b: auto-quarantine.** If a crash recurs in the same plugin (from the faulting module in the dump), disable that plugin instance on restart and tell the user.
- **Level 2 (phase 2): plugin sandboxes.** `krypt-pluginhost.exe` processes host one plugin, one vendor, or all third-party plugins, per user setting (Bitwig-style modes; from domain knowledge, not re-verified).
  - Audio and events cross via shared memory (`CreateFileMappingW`) with a pair of auto-reset events, or `WaitOnAddress` cross-process via shared memory.
  - Each hop costs roughly 10–50 µs plus scheduling jitter. Spike 4 must measure it.
  - A crash there only silences that plugin.
- **Panics:** `panic = "unwind"` in release. The callback and every job are wrapped in `catch_unwind` (allocation-free path), which on panic outputs silence, sets a "node faulted" flag and bypasses the node. A plugin access violation can't be caught in-process, which is why sandboxes are the end state.

### 6.11 State sync: UI and MCP agent mutate the model; the engine consumes snapshots and diffs

**Principle: one writer, derived engine state.**

1. **Authoritative model in ProjectHost** (main process, TypeScript, pure logic in `shared/`), stored as normalised entities by stable ID:
   - Channel, Pattern, Note, PlaylistTrack, PlaylistClip (pattern, audio or automation), AutomationClip, MixerTrack, Slot, Route/Send, TempoMap, Transport settings, Swing.
   - Plugin state blobs.
2. **Ops, not state writes.**
   - Clients submit typed ops such as `addNote`, `moveClip`, `setParam` and `routeTrack`: the UI through `window.krypt.project.apply(ops)`, the MCP agent through tools that call the same function.
   - ProjectHost validates and applies each **transaction** atomically, producing **forward and inverse patches** and `version++`.
   - Undo groups by origin (`user` / `agent:<session>`), so "Undo agent's last change" is one step.
   - Conflicts: ops on deleted or changed entities fail validation and return `{ok:false}` to *that* client. No CRDT is needed with a single authority.
   - If real-time multi-user collaboration ever becomes a goal, ops map onto **Loro** (1.16.2, MIT) or Yjs, as openDAW does with yjs.
3. **Renderer.** Zustand holds a mirror updated from patches with version tags. Drags are optimistic: apply locally, send ops, reconcile on the echoed version.
4. **Engine.**
   - The RenderModelCompiler converts patches into **entity-level upserts and deletes** of the *render model*, an engine-oriented, UI-free projection (no colours, names or view state) generated from Rust types via ts-rs.
   - The engine control thread **compiles incrementally**:
     - A pattern change rebuilds only that pattern's index.
     - A tempo change rebuilds only the tempo map. Events are stored in ticks, so note lists need no recompile.
     - A routing change rebuilds the schedule.
     - A param change is either a fast-path atomic or an automation update.
   - **Snapshot** is used on engine start or restart, project load, and on demand. **Diffs** are used otherwise.
5. **Consistency checks.**
   - The engine acks `Applied{N}`, and telemetry carries `applied_version`. The UI and agent know when an edit is *audible*; MCP tools can `await applied(N)` before rendering or analysing.
   - Every 5 s, and after a restart, ProjectHost sends the hash of the render model and the engine compares its own. On a mismatch it requests a full snapshot and logs a bug.
6. **Rate limiting.** Agents can submit thousands of ops. ProjectHost coalesces patches per 8 ms tick into one `ApplyBatch`, which keeps the engine's CMD queue to one batch per tick.

### 6.12 Plugin hosting notes (engine-facing; details belong to the plugin track)

- **Formats:**
  - **CLAP** via `clack-host` 0.2.0. The thread model and events map 1:1 onto §6.5.
  - **VST3** via `vst3` 0.3.0 bindings. The SDK is MIT, so the hosting helpers in `public.sdk` can be used.
  - No VST2: Steinberg has not relicensed VST2.
- **Scanning** happens in a throwaway `krypt-engine.exe --scan <path>` process per plugin, with a timeout. Scans that crash or hang are blacklisted, never touching the live engine.
- **Plugin editors** live on the engine's UI thread. Their HWNDs are top-level tool windows owned by the Electron window (the owner HWND is passed in at open), giving FL-style floating windows. Embedding into the DOM isn't feasible, so we don't try.

---

## 7. Dependency list (engine)

All versions and dates were checked on crates.io, npm and GitHub on 2026-10-11. **Status key:** *Active* = release or commits in the last 3 months; *Stable* = mature, infrequent releases; *Stale* = no release for 18 months or more.

| Purpose | Package | Version (released) | Licence | Status | Notes |
|---|---|---|---|---|---|
| Device I/O (ASIO + shared fallback) | `cpal` | 0.18.2 (2026-08-16) | Apache-2.0 | Active | Wrap behind `krypt-audio-io` trait. Features: `asio`, `realtime`. |
| ASIO bindings | `asio-sys` | 0.4.0 (2026-08-16) | Apache-2.0 | Active | + **ASIO SDK 2.3.4: sign Steinberg proprietary licence**; needs libclang |
| WASAPI exclusive | `wasapi` | 0.25.0 (2026-10-01) | MIT | Active | |
| Win32 (IAudioClient3, MMCSS, QoS, pipes, shm) | `windows` | 0.62.2 (2025-10-06) | MIT/Apache-2.0 | Active (Microsoft) | Same version cpal pins |
| Duplex plan B | `rtaudio` | 0.8.1 (2026-10-06) | MIT | Active | CMake at cargo build |
| RT priority (optional) | `audio_thread_priority` | 0.38.0 (2026-09-17) | MPL-2.0 | Active (Mozilla) | Or direct `windows` calls |
| SPSC queues | `rtrb` | 0.4.0 (2026-08-17) | MIT/Apache-2.0 | Active | Commands, retire, meters |
| Sample rings | `ringbuf` | 0.5.3 (2026-10-08) | MIT/Apache-2.0 | Active | Scope taps, recording |
| Deferred drop (optional) | `basedrop` | 0.1.3 (2025-10-29) | MIT/Apache-2.0 | Stable/low activity | |
| Alloc guard (debug) | `assert_no_alloc` | 1.1.2 (2021-08-03) | BSD-1-Clause | Stable (finished) | Works on Windows |
| RT sanitizer (Linux CI) | `rtsan-standalone` | 0.3.0 (2025-09-27) | Apache-2.0 | Active | Linux/macOS only |
| Denormals | `no_denormals` | 0.3.0 (2025-09-11) | MIT | Stable | |
| DSP building blocks | `fundsp` | 0.23.0 (2026-01-07) | MIT/Apache-2.0 | Active | Stock FX and synth prototyping |
| Buffer adapters | `audioadapter` | 5.0.0 (2026-07-31) | MIT/Apache-2.0 | Active | Instead of `dasp` (stale since 2020) |
| FFT | `rustfft` / `realfft` | 6.4.1 / 3.5.0 | MIT/Apache-2.0 / MIT | Stable | |
| Loudness | `ebur128` | 0.1.10 (2024-10-26) | MIT | Stable | |
| Decode | `symphonia` | 0.6.1 (2026-08-13) | **MPL-2.0** | Active | Unmodified, so OK; include notice |
| Disk streaming | `creek` | 1.2.3 (2025-09-22) | MIT/Apache-2.0 | Maintained (low churn) | Codeberg/Meadowlark |
| Resampling | `rubato` | 5.0.1 (2026-10-01) | MIT/Apache-2.0 | Active | |
| WAV write | `hound` | 3.5.1 (2023-09-25) | Apache-2.0 | Stable | |
| Time-stretch (default) | `signalsmith-stretch` (crate) + upstream C++ | 0.1.3 (2025-09-18) / upstream 2026-09 | MIT | Active upstream | Compiles C++ via `cc` at cargo build (MSVC) |
| Time-stretch (optional) | Bungee (C++) | main (2026-10-08) | **MPL-2.0** | Active | Own bindings (bungee-rs archived) |
| MIDI I/O / types / files | `midir` / `wmidi` / `midly` | 0.11.1 / 4.0.11 / 0.5.3 | MIT / MIT / Unlicense | Active / Active / Stable | |
| CLAP hosting | `clack-host` (+ `clack-extensions`) | 0.2.0 (2026-09-12) | MIT/Apache-2.0 | Active | CLAP 1.2.10 is MIT |
| VST3 hosting | `vst3` | 0.3.0 (2025-12-07) | MIT/Apache-2.0 | Active | VST3 SDK 3.8.1 is MIT |
| Named pipes | `interprocess` | 2.4.5 (2026-10-10) | 0BSD/Apache-2.0 | Active | |
| Telemetry WebSocket | `tungstenite` | 0.30.0 (2026-07-11) | MIT/Apache-2.0 | Active | Sync API on the telemetry thread; no tokio needed |
| Wire format | `rmp-serde` + `serde` | 1.3.1 / 1.0.229 | MIT / MIT/Apache-2.0 | Stable / Active | |
| TS type generation | `ts-rs` | 12.0.1 (2026-01-31) | MIT | Active | Feeds `shared/engine-protocol.ts` |
| Crash dumps | `crash-handler` + `minidumper` | 0.8.1 / 0.11.0 | MIT/Apache-2.0 | Active (Embark) | |
| Non-RT channels | `crossbeam-channel` | 0.5.17 | MIT/Apache-2.0 | Active | Control and loader threads only |
| **Node side** | `@msgpack/msgpack` | 3.1.3 | ISC | Active | |
| Node side (optional, later) | `napi` / `@napi-rs/cli` | 3.14.2 / 3.10.8 | MIT | Active | Only for zero-copy shm helpers |
| Shell | `electron` / `electron-builder` / `vite-plugin-electron` | 44.7.0 / 26.15.3 / 1.1.2 | MIT | Active | Electron 44 = Chromium 152, Node 24.21 |

**Explicitly rejected:**
- `dasp` (stale since 2020), `knyst` (stale since 2024-11), `shared_memory` (stale since 2022; use `windows` directly).
- `firewheel` as the core (not a DAW engine, single-threaded; fine to read).
- **GPL/AGPL:** Rubber Band, Audacity code, Meadowlark (AGPL), openDAW (AGPL), Tracktion (GPL), JUCE (AGPL), LMMS, Surge.
- **LGPL:** SoundTouch.

---

## 8. Spike plan (first three prototypes)

### Spike 1: "Windows I/O and RT core" (about 1.5–2 weeks)

**Build:** a `krypt-engine` CLI with a `krypt-audio-io` crate exposing four backends:
- ASIO (cpal `asio`),
- WASAPI exclusive (`wasapi`),
- WASAPI low-latency shared (IAudioClient3 via `windows`),
- WASAPI shared (cpal).

It also needs:
- MMCSS, the EcoQoS opt-out and FTZ/DAZ.
- `assert_no_alloc` in debug.
- A callback deadline histogram, and xrun detection by QPC.
- Device-change and unplug recovery.
- A 16-step drum pattern (in-RAM samples) at 140 BPM with a 64-voice sine stress mode.
- Loopback RTL measurement: output an impulse and detect it on input, through a cable or the interface's loopback channel.

**Success criteria:**
1. **ASIO at 64 frames / 48 kHz** on a USB interface (Focusrite or Behringer class) runs **30 min with 0 xruns**. During the run, an Electron window spins a 60 fps canvas plus a 100 ms main-thread busy loop every second. **p99.9 callback time is under 50% of the budget.**
2. **WASAPI exclusive at 3 ms** and **IAudioClient3 at 128 frames** on the dev machine's HDAudio endpoint. The engine falls back cleanly to shared 10 ms on the USB headset, and the UI reports actual buffer and latency.
3. **Measured RTL table** per backend and device committed to `research/`.
4. **Zero allocations** flagged on the audio thread over the whole run.
5. Unplugging and replugging the device, or changing the sample rate in the control panel, recovers in under 2 s without a crash. The ASIO `kAsioResetRequest` path is exercised.
6. **Licensing:** the Steinberg ASIO proprietary agreement is submitted; an ASIO-less build compiles without libclang or the SDK.

### Spike 2: "Electron ↔ sidecar loop, state sync, crash restart" (about 2 weeks)

**Build:**
- A house-stack Electron app with ProjectHost (op log, undo, version) and a Zustand mirror.
- An MCP stub server with tools `add_note`, `set_swing`, `set_param` and `render_bars`.
- EngineSupervisor, the named-pipe control channel (ts-rs types), and the WebSocket telemetry channel.
- UI: an 8×16 Channel Rack step grid, 8 mixer meters with peak-hold, a playhead, and swing and tempo knobs.

**Success criteria:**
1. **Click-to-audible ≤ 1 block + 2 ms** at 128 frames, measured from UI event `performance.now()` to the engine's `Applied{N}` block QPC, mapped through a common QPC clock exposed by both.
2. **Meters and playhead hold a steady 60 fps.** Playhead extrapolation error against the engine's audible position is **under 1 ms RMS**, even with the main thread blocked for 200 ms (telemetry bypasses main).
3. **Kill -9 the engine mid-playback:** the UI stays responsive, the engine is back **with state and transport restored in under 1.5 s**, and no model data is lost.
4. **Concurrency soak:** the agent stub fires 1,000 random ops/s for 60 s while a scripted UI drags notes. The final ProjectHost render-model hash **equals** the engine hash, there are 0 validation crashes, and every rejected op returns `{ok:false}` to its own client.
5. Main-thread long tasks are never over 50 ms due to engine traffic.
6. Packaged with electron-builder; `npm install` triggers no native compile.

### Spike 3: "Graph compiler, multi-core, PDC, automation, offline render, stretch" (about 2–3 weeks)

**Build:**
- The compiler (toposort, buffer colouring, PDC delay insertion, task DAG) and the worker pool (spin → `WaitOnAddress`).
- 100 mixer tracks × 4 inserts using fundsp dummy FX with configurable CPU cost and latency, plus sends, a sidechain and nested buses.
- Tempo map with linear ramps; swing; sample-accurate automation.
- Offline renderer.
- 16 stereo audio clips through signalsmith-stretch at 0.8–1.25×, with an A/B against Bungee and `timestretch`.

**Success criteria:**
1. **Scaling on the i7-10700K (8C/16T)**, heavy project: **≥ 5× speedup vs 1 thread at 256 frames, ≥ 3× at 64 frames**. Scheduler overhead per block is **under 50 µs**, and worker wake p99 is under 100 µs (else spin while playing).
2. **PDC null test**: an impulse through parallel paths with latencies {0, 64, 1000, 4097} samples, including send→return→send chains and a sidechain, aligns with a residual under −140 dBFS. Automation step events land on the exact sample even with 4,097 samples of upstream latency.
3. The **tempo-map property test** (10k random maps) shows tick↔sample round-trip error ≤ 1 sample over 1 h.
4. **Offline render** is bit-identical across 2 runs, matches the real-time capture (deterministic nodes), and runs **≥ 20× real time** for a 16-track light project.
5. Adding or removing tracks and slots **during playback** causes no glitch, with 0 audio-thread allocations, and the retire queue drains.
6. **Stretch**: 16 real-time stretched stereo clips at 128 frames use under 30% of one core (otherwise the stretch cache becomes mandatory). A subjective quality note is recorded.

**Next, Spike 4 (plugin track):** VST3 + CLAP hosting through `vst3`/`clack-host` in-engine, then an out-of-process sandbox prototype. Measure per-hop cost at 64 frames.

---

## 9. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **Building a DAW core from scratch** (graph, PDC, sequencer, stretch integration) takes longer than planned. No Rust DAW engine exists to adopt. | High | High | Staged scope; Spikes 1–3 first; borrow *designs* (Tracktion graph docs, CLAP semantics, Firewheel); keep the node API small |
| 2 | **Windows driver variance:** USB devices stuck at 10 ms shared (measured here); exclusive-mode distortion on some Realtek parts; flaky ASIO drivers (MOTU reports) | High | Medium | Four backends with auto-probe; clear latency readout; recommend ASIO; device-specific quirk table; fallbacks |
| 3 | **ASIO licensing and build friction:** proprietary agreement admin, the SDK can't live in the repo, and libclang is needed | Medium | Medium | Cargo feature, so official builds only; document contributor builds without ASIO; never use the GPLv3 option |
| 4 | **Multithread jitter on Windows:** worker wake latency, E-cores on hybrid CPUs, EcoQoS/timer throttling for a windowless process | Medium | High | MMCSS on all RT threads, the QoS opt-out, spin-while-playing, CPU-set pinning to P-cores, configurable thread count; measure in Spike 3 |
| 5 | **Third-party plugin crashes** take down the engine (v1) | High | Medium | Supervisor auto-restart with snapshot and periodic plugin-state polling (v1); quarantine; plugin sandboxes (phase 2) |
| 6 | **State divergence** between the TS model and the Rust render model | Medium | High | Generated types (ts-rs), versioned acks, periodic hash checks with auto-resnapshot, property-based soak tests (Spike 2) |
| 7 | **Main-process congestion** (MCP + model + saves) delays control messages | Medium | Low/Med | Telemetry bypasses main; patch coalescing; move ProjectHost into a `utilityProcess` later if long tasks exceed 50 ms |
| 8 | **Time-stretch quality** below FL's élastique-class expectations | Medium | Medium | Pluggable `Stretcher`; signalsmith is the default; Bungee as an option; stretch cache; evaluate the pure-Rust `timestretch` |
| 9 | **Licence contamination** by accidental GPL/LGPL code or a misread MPL obligation | Low | High | `cargo-deny` licence allowlist in CI (MIT, Apache-2.0, BSD, ISC, Zlib, 0BSD, Unlicense, MPL-2.0 for listed crates only); THIRD_PARTY_NOTICES generation |
| 10 | **AV and SmartScreen** flag an unsigned sidecar exe, or AV hooks add latency | Medium | Medium | Code-sign the exe and installer; ship from `resources/engine/`; document AV exclusions for performance |
| 11 | **Rust audio crate API churn** (cpal 0.17→0.18 broke APIs) | Medium | Low | Pin exact versions; isolate behind our own traits; upgrade deliberately |
| 12 | **Web edition later** is harder if the engine leans on OS APIs | Low | Low | Keep `engine-core` (graph, sequencer, DSP) free of OS/thread deps, as Firewheel and openDAW do; OS bits live in `engine-host` |
| 13 | **Exclusive modes** (ASIO / WASAPI-excl) silence other apps (browser, Discord), which surprises users | High | Low | UX: explain in device settings; "release audio device when KryptStudio is in background" option |

---

## 10. Hand-offs to other research tracks

- **Plugin hosting track:** VST3 SDK 3.8.1 is MIT and CLAP 1.2.10 is MIT. Recommend `clack-host` and `vst3`, scanning in a throwaway process, and sandbox modes (§6.10, §6.12). VST2 is not relicensed.
- **MCP track:**
  - Agents should call the same ProjectHost op API and await `applied(version)`.
  - Renders should use `krypt-engine --render` in a separate process returning LUFS and peak.
  - Undo grouping by agent session.
  - Rate-limit and coalesce ops (§6.11).
- **UI track:** telemetry frame format and subscription model (§6.9); playhead extrapolation; drags apply optimistically, then reconcile by version.
- **Project-format track:** ticks at 960 PPQ; tempo map segments; plugin state blobs persisted in the model; the render model is a projection, not the file format.

## 11. Limitations of this research

- The shared web-search budget ran out partway through. The REAPER anticipative-FX and Bitwig sandbox-mode descriptions are from domain knowledge and were not re-verified here.
- "Typical ASIO RTL 5–10 ms" is an estimate that Spike 1 must replace with measurements.
- The Chromium tracker pages for issues 41357523 and 40629664 render client-side, so only their titles and status metadata could be read.
- Chrome's measured `outputLatency` for non-`interactive` hints read 0 under headless virtual time; only the `interactive` value (32 ms) is trustworthy.

---

## 12. Sources

**Measured locally (2026-10-11)**
- Probes (`cpalprobe` with cpal 0.18.2, `ac3probe` with windows 0.62.2 IAudioClient3, `bench/pipe_rtt.mjs`, `bench/latency.html` in Chrome 154): scratchpad of this research session. Spike 1 can reuse them.

**Windows audio and latency**
- Microsoft, Low Latency Audio: https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/low-latency-audio
- Microsoft, SetProcessInformation / power throttling: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation
- miniaudio "Windows Audio Latency" discussion #1084: https://github.com/mackron/miniaudio/discussions/1084
- mozilla/cubeb PR #740 (IAudioClient3): https://github.com/mozilla/cubeb/pull/740
- Chromium issue "Chrome does not use Windows low latency audio features": https://issues.chromium.org/issues/41357523
- Chromium issue "Low latency audio processing (< 20 ms) on Chrome / Windows 10": https://issues.chromium.org/issues/40629664
- Jeff Kaufman, AudioWorklet latency Firefox vs Chrome: https://jefftk.com/p/audioworklet-latency-firefox-vs-chrome
- Chromium blink-dev, Intent to Ship: configurable render quantum (`renderSizeHint`): https://groups.google.com/a/chromium.org/g/blink-dev/c/i4c1unRSmcE
- Chrome, Audio Worklet design patterns: https://developer.chrome.com/blog/audio-worklet-design-pattern
- web.dev, audio output latency: https://web.dev/articles/audio-output-latency

**Web DAWs**
- openDAW repo (AGPL-3.0) and runtime topology: https://github.com/andremichelle/openDAW and https://github.com/andremichelle/openDAW/blob/main/introduction.md
- Elementary Audio (MIT): https://github.com/elemaudio/elementary
- web-audio-api-rs (MIT): https://github.com/orottier/web-audio-api-rs ; node-web-audio-api (BSD-3): https://github.com/ircam-ismm/node-web-audio-api

**Rust crates and repos**
- cpal CHANGELOG: https://github.com/RustAudio/cpal/blob/master/CHANGELOG.md ; WASAPI exclusive PR #1368: https://github.com/RustAudio/cpal/pull/1368 ; crate: https://crates.io/crates/cpal ; asio-sys: https://docs.rs/crate/asio-sys/0.4.0
- wasapi-rs: https://github.com/HEnquist/wasapi-rs
- rtaudio-rs: https://codeberg.org/Meadowlark/rtaudio-rs
- interflow: https://github.com/SolarLiner/interflow
- Firewheel README and design doc: https://github.com/BillyDM/firewheel and https://github.com/BillyDM/firewheel/blob/main/DESIGN_DOC.md
- bevy_seedling: https://github.com/CorvusPrudens/bevy_seedling
- Meadowlark (AGPL, incomplete): https://github.com/MeadowlarkDAW/Meadowlark
- fundsp: https://github.com/SamiPerttu/fundsp ; dasp: https://github.com/RustAudio/dasp ; knyst: https://github.com/ErikNatanael/knyst
- rtrb: https://github.com/mgeier/rtrb ; ringbuf: https://github.com/agerasev/ringbuf ; basedrop: https://github.com/micahrj/basedrop
- assert_no_alloc: https://github.com/Windfisch/rust-assert-no-alloc ; rtsan-standalone-rs: https://github.com/realtime-sanitizer/rtsan-standalone-rs
- audio_thread_priority: https://github.com/mozilla/audio_thread_priority
- symphonia: https://github.com/pdeljanov/Symphonia ; creek: https://codeberg.org/Meadowlark/creek ; rubato: https://github.com/HEnquist/rubato ; symphonium: https://codeberg.org/Meadowlark/symphonium
- clack: https://github.com/prokopyl/clack ; vst3-rs: https://github.com/coupler-rs/vst3-rs ; nih-plug (ISC, plugin side): https://github.com/robbert-vdh/nih-plug
- napi-rs v3 announcement: https://napi.rs/blog/announce-v3
- crates.io API, used for every version, date and licence in §7: https://crates.io/api/v1/crates/<name>

**Time-stretch**
- signalsmith-stretch: https://github.com/Signalsmith-Audio/signalsmith-stretch ; Rust crate: https://github.com/colinmarc/signalsmith-stretch-rs
- Bungee: https://github.com/bungee-audio-stretch/bungee ; bungee-rs (archived): https://github.com/emuell/bungee-rs
- timestretch-rs: https://github.com/robmorgan/timestretch-rs
- Rubber Band (GPL): https://github.com/breakfastquay/rubberband
- Audacity StaffPad TimeAndPitch (in the GPL tree): https://github.com/audacity/audacity/tree/master/au3/libraries/au3-time-and-pitch

**Licensing (Steinberg, JUCE, Tracktion)**
- heise, Steinberg releases ASIO and VST under open-source licences: https://www.heise.de/en/news/Steinberg-Releases-ASIO-and-VST-Audio-Interfaces-Under-Open-Source-Licenses-10963451.html
- Sonicstate, VST 3 now under MIT: https://sonicstate.com/news/2025/10/30/vst-3-now-available-under-mit-license
- VST3 SDK (MIT): https://github.com/steinbergmedia/vst3sdk
- ASIO (Wikipedia, dual licence note): https://en.wikipedia.org/wiki/Audio_Stream_Input/Output
- Steinberg forum, submitting the proprietary ASIO SDK licence agreement: https://forums.steinberg.net/t/where-do-i-submit-the-proprietary-asio-sdk-license-agreement/1035889
- CLAP (MIT), events header: https://github.com/free-audio/clap/blob/main/include/clap/events.h
- JUCE licence file: https://github.com/juce-framework/JUCE/blob/master/LICENSE.md ; JUCE 9 EULA: https://juce.com/legal/juce-9-licence/ ; tiers: https://juce.com/get-juce/
- Tracktion Engine licence, features and graph docs: https://github.com/Tracktion/tracktion_engine/blob/develop/LICENSE.md , https://github.com/Tracktion/tracktion_engine/blob/develop/FEATURES.md , https://github.com/Tracktion/tracktion_engine/tree/develop/modules/tracktion_graph/docs

**Shells**
- Electron releases (44.7.0 = Chromium 152, Node 24.21): https://releases.electronjs.org/
- Electron utilityProcess: https://www.electronjs.org/docs/latest/api/utility-process
- Tauri v2 sidecars: https://v2.tauri.app/develop/sidecar/

**Further reading (not re-reviewed for this report)**
- HAW Hamburg thesis, "Browser-based Engine Prototype for a DAW": https://reposit.haw-hamburg.de/bitstream/20.500.12738/16337/1/BA_Browser-based%20Engine%20Prototype%20for%20a%20Digital%20Audio%20Workstation.pdf
- Ross Bencina, "Real-time audio programming 101: time waits for nothing": http://www.rossbencina.com/code/real-time-audio-programming-101-time-waits-for-nothing
