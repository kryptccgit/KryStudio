# 07: Windows audio/MIDI I/O, media formats, and shipping the native engine

> **KryptStudio research, agent 7 of 7.** Researched on 2026-10-11 on the dev box (Windows 10 Home 19045,
> Node 24.18, npm 11.16, Rust 1.98 MSVC, VS Build Tools 2022 17.14).
> Scope: the Windows platform and packaging side of the native Rust engine, for **both** integration
> options (napi-rs in-process addon vs sidecar `.exe`). Agent 6 owns the final architecture call; this
> doc gives the Windows evidence.
>
> **Evidence tags:** **[V]** checked against an official or primary source today. **[M]** measured or
> built on the dev box today. **[E]** an estimate or practitioner rule of thumb that I could not
> verify from a primary source today (the shared web-search budget ran out mid-research). Treat
> **[E]** numbers as planning ranges to re-measure, not facts.

---

## 0. TL;DR: decisions this doc recommends

1. **Ship v1 on WASAPI only. Add ASIO behind a feature flag after a license decision.** cpal 0.18.2
   gives WASAPI shared mode today with no SDK, no LLVM and no license paperwork **[V][M]**.
2. **ASIO licensing changed in Oct 2025, but the change doesn't help an MIT app.** The Steinberg ASIO
   SDK is now dual-licensed: free proprietary (signed agreement) **or GPLv3** **[V]**. GPLv3 can't be
   linked into an MIT binary under house rules. So ASIO means **signing Steinberg's free
   proprietary agreement**. That in turn rules out SignPath Foundation's free OSS signing, which
   bans proprietary components **[V]**.
3. **Low-latency WASAPI needs our own backend.** cpal only does shared mode via `IAudioClient`. It has
   no exclusive mode and no `IAudioClient3` **[V: source + changelog]**. Plan a Phase-2 backend on the
   `windows` crate: `IAudioClient3` small-period shared mode, exclusive mode and
   `IMMNotificationClient`. The inbox HDAudio driver goes down to **128 frames (2.66 ms @ 48 kHz)** in
   shared mode **[V]**.
4. **From the Windows/packaging side, the sidecar `.exe` wins.** It isolates crashes from
   third-party in-process DLLs (ASIO drivers, later VST3). It also gives a Windows-friendly dev loop
   (shadow-copy plus hot restart; a loaded `.node` can never be unloaded). It has no asar/Rollup/ABI
   concerns. And it dies with Electron automatically: libuv puts non-detached children in a
   kill-on-close Job Object **[V: libuv source][M: tested, including force-kill]**.
5. **No zero-copy shared memory into Electron.** Electron 21+ has the V8 memory cage, and
   `koffi.view()` throws in Electron **[V]**. Use stdio/named-pipe messages for control and meters.
   Shared memory only works with a copy.
6. **Windows MIDI Services is Windows 11 only** (24H2/25H2, GA Feb 2026) **[V]**. It makes WinMM
   multi-client with no app changes. On **Windows 10 (the dev box), WinMM ports stay single-client**.
   Never let Chromium's Web MIDI (WinMM backend **[V]**) and the engine fight over ports.
7. **Decode with symphonia** (MPL-2.0; MP3/AAC/ALAC/AIFF are opt-in features) **[V]**. **Encode MP3
   with Windows Media Foundation's built-in encoder** (no LGPL baggage) **[V]**. FLAC via `flacenc`,
   Vorbis via `vorbis_rs`, Opus via `opus` + `ogg`, and WAV via `hound` plus our own `smpl`/`acid`
   chunk writer.
8. **Static CRT is mandatory, and there's a trap.** Default Rust MSVC binaries import
   `VCRUNTIME140.dll` **[M]**. Put `+crt-static` in a **repo-root** `.cargo/config.toml`, because
   `cargo build --manifest-path engine/Cargo.toml` from the repo root **ignores** `engine/.cargo/` **[M]**.
9. **Signing:** Azure **Artifact Signing** (ex-Trusted Signing; GA Jan 2026) costs **$9.99/mo**. Only
   **US/Canada individuals** are eligible (orgs: US/CA/EU/UK and more) **[V]**. Sign **every** PE
   (installer, app exe, engine exe, `.node`). EV no longer buys instant SmartScreen reputation **[V]**.

---

## 1. Audio I/O on Windows

### 1.1 The paths

| Path | What it is | Who can share the device | Notes |
|---|---|---|---|
| **WASAPI shared (`IAudioClient`)** | Every app mixes through the Windows audio engine at the endpoint's mix format | Everyone | Default 10 ms engine period. Windows SRC if formats differ. cpal 0.18 uses this, event-driven, with `AUTOCONVERTPCM` on output **[V: cpal source]** |
| **WASAPI shared low-latency (`IAudioClient3`)** | Same engine, but the app asks for a smaller period via `InitializeSharedAudioStream` | Everyone, **and all clients on that endpoint+mode switch to the small period** **[V]** | Needs driver support. The period must be a multiple of the "fundamental period" between min and max **[V]** |
| **WASAPI exclusive** | App writes straight to the driver's buffer, bypassing the engine and APOs | **Nobody else.** It blocks browsers, Discord and system sounds on that endpoint **[V]** | Must use a format the hardware accepts. Can be disabled per device by the user |
| **ASIO** | Third-party driver DLL (COM) loaded **into our process**; app talks to the driver directly | Driver-dependent; most are effectively single-client **[E]** | The pro path. Needs the vendor driver, or a universal one (ASIO4ALL/FlexASIO) |

Windows 10 cut audio-engine latency to about 1.3 ms render and about 0 ms capture. Drivers can now
declare small buffers instead of the old fixed 10 ms. Apps only get them if they ask, through
`IAudioClient3` or AudioGraph **[V: MS "Low Latency Audio"]**.

### 1.2 `IAudioClient3`: what buffer sizes are realistic

- The **inbox HDAudio driver** supports **128 to 480 samples (2.66 to 10 ms @ 48 kHz)** **[V]**. To
  test, swap the OEM driver for "High Definition Audio Device" in Device Manager **[V]**.
- **Third-party/OEM drivers** must declare `DEVPKEY_KsAudio_PacketSize_Constraints2` (Win10 1607+).
  Microsoft's own example shows a 2 ms absolute minimum and 128 frames in default mode **[V]**. Many
  OEM codec drivers just report min = default = 10 ms, so there's no gain **[E]**. Always query
  `GetSharedModeEnginePeriod` and show the real minimum in the UI.
- If another app already runs the engine at a different small period, you get
  `AUDCLNT_E_ENGINE_PERIODICITY_LOCKED`. Call `GetCurrentSharedModeEnginePeriod` and adopt that period **[V]**.
- Below a threshold buffer size, Windows enters a special low-latency resource mode. It protects the
  audio engine thread, registered driver resources, and app work items on the **Real-Time Work Queue**
  tagged "Audio"/"ProAudio" **[V]**. Microsoft recommends RTWQ over raw threads for WASAPI apps **[V]**.
- Trade-off: smaller periods mean more CPU wake-ups and power. Offer a mode toggle: "Low latency" vs
  "Stable (10 ms)".

**Crate reality check [V: cpal 0.18.2 source + CHANGELOG, wasapi 0.25 docs]:**

| Crate | Shared | Exclusive | `IAudioClient3` | Device notifications | MMCSS |
|---|---|---|---|---|---|
| `cpal` 0.18.2 (Apache-2.0) | yes, event-driven | **no** | **no** | internal `IMMNotificationClient` to reroute *default* streams (0.18) | `realtime` feature calls `audio_thread_priority`, task **"Audio"** (not "Pro Audio") |
| `wasapi` 0.25.0 (MIT) | yes | **yes** | **no** (not exposed) | yes (`DeviceEventCallbacks`) | no helper |
| `windows` 0.62 (MIT/Apache) | raw COM: `IAudioClient3`, `IMMNotificationClient`, `Avrt` | all | **yes** | yes | yes |

**Plan:** start with cpal for the hello-sine/v0. Write `engine/src/backend/wasapi_ll.rs` on `windows`
for `IAudioClient3` and exclusive mode (roughly 800 to 1200 lines **[E]**). Keep cpal's `asio`
feature for ASIO.

### 1.3 ASIO

**License status (verify-before-ship item):**
- **15 Oct 2025:** Steinberg moved ASIO "from a sole proprietary license option to a dual licensing
  model", adding **GPLv3** next to the proprietary license. This was tied to the OBS partnership **[V]**.
  The SDK README: "Developers can choose between… proprietary ASIO SDK license… [or] GPL Version 3…
  Both options grant access to the same SDK" **[V: SDK 2.3.4 README mirror]**.
- The proprietary license is **free of charge, but the agreement must be signed** **[V: Wikipedia]**.
  A Steinberg dev points submitters to `steinberg.net/developers/prorietary-sdk/` (sic) **[V]**. That
  page is JS-rendered and wouldn't read; get the exact submission steps from it manually.
- The ASIO name/logo is trademark-controlled under **both** licenses. No "ASIO" in product names.
  Logo use follows the Steinberg usage guidelines **[V]**.
- **Separately:** the **VST 3 SDK moved to MIT in v3.8 (Oct 2025)** **[V]**. That's good news for the
  plugin-hosting agent and doesn't affect ASIO.

**What this means for KryptStudio (MIT, no GPL linking):**
- GPLv3 ASIO would make the engine binary GPLv3, which is out under house rules.
- So: **sign the free proprietary agreement before shipping an ASIO build.** Never commit the SDK to
  the repo; cpal downloads it at build time (below). Credit "ASIO is a trademark and software of
  Steinberg Media Technologies GmbH" in the licenses screen.
- Knock-on effect: **SignPath Foundation** (free OSS signing) requires every component to be OSI-licensed
  with no proprietary code **[V]**. An ASIO-enabled build won't qualify, so plan on Artifact Signing.

**Building cpal with ASIO [V: cpal 0.18.2 docs + CHANGELOG]:**
1. `cpal = { version = "0.18.2", features = ["asio"] }`, then `cpal::host_from_id(cpal::HostId::Asio)`.
2. **SDK:** the `asio-sys` build script (0.4/0.5, Apache-2.0) checks `CPAL_ASIO_DIR`. If that's
   unset, it uses `%TEMP%\asio_sdk`. If that's missing too, it **downloads the SDK from
   steinberg.net/asiosdk**. For CI reproducibility, pin `CPAL_ASIO_DIR` to a cached SDK copy.
3. **LLVM/libclang for bindgen:** install LLVM (`winget install LLVM.LLVM`), then
   `setx LIBCLANG_PATH "C:\Program Files\LLVM\bin"`. **The dev box has no LLVM today** **[M]**. The
   GitHub `windows-2025` image ships **LLVM 20.1.8** **[V]**.
4. The build script assumes Visual Studio and runs `vcvarsall.bat` for host/target. If detection
   fails, run `vcvarsall.bat amd64` manually.
5. Testing without hardware: install ASIO4ALL (enable its "offline" option), per the cpal docs.
6. cpal 0.17/0.18 fixed real ASIO pain: `kAsioResetRequest` handling, `kAsioResyncRequest` and
   sample-rate changes mapped to `ErrorKind::StreamInvalidated`, `kAsioBufferSizeChange` resizing,
   `kAsioLatenciesChanged`, overload reporting, and non-conformant drivers (FL Studio ASIO). **Use
   cpal ≥ 0.18.2.**

**Users without an interface:**

| Driver | License | How it works | Use it for |
|---|---|---|---|
| **ASIO4ALL** 2.16 (Jun 2024; 2.17 betas exist) | Freeware, proprietary. Bundling/resale restricted **[V weak]** | WDM Kernel Streaming, **exclusive**. Other apps go silent | Link to it, **never bundle** |
| **FlexASIO** | MIT for its own code. The ASIO parts fall under Steinberg's terms **[V]** | PortAudio → WASAPI shared/exclusive, KS, MME, DirectSound. **Default backend DirectSound, 20 ms buffer** **[V]** | Link, don't bundle. Tell users to set the WASAPI backend in `FlexASIO.toml` |
| Our own WASAPI low-latency mode | n/a | `IAudioClient3` | **The real answer:** most "no interface" users don't need ASIO at all |

### 1.4 Device switching, sample-rate changes, hot-plug

- **Unplug or reconfigure → `AUDCLNT_E_DEVICE_INVALIDATED` (0x88890004).** Recovery: release
  `IAudioClient` and friends, re-get the endpoint, re-activate **[V: MS "Recovering from an
  Invalid-Device Error"]**. A shared session can also be disconnected *so that another app can take
  exclusive mode*. Register `IAudioSessionEvents::OnSessionDisconnected` to learn why **[V]**.
- **Default device follows:** cpal 0.18 reroutes default-device streams. The 0.18.2 changelog flip-flops
  on whether it reports `DeviceChanged` **[V]**, so don't depend on that event. For an explicitly
  chosen device, persist its **endpoint ID** (cpal `device.id()` prints `wasapi:{0.0.0.00000000}.{guid}`
  **[M]**) and fall back to the friendly name.
- **Sample rate:** in shared mode the engine runs at the **Windows mix format**
  (Sound control panel → Advanced → Default Format). The app can't change it. Either resample the
  project to the device rate (rubato) or let Windows SRC it (`AUTOCONVERTPCM`, lower quality). Exclusive
  and ASIO set the hardware rate. A user changing the default format mid-session invalidates the stream.
- **ASIO has no hot-plug API.** A yanked USB interface may send `kAsioResetRequest` or just stop
  calling back. Add a **watchdog**: no callback for more than about 4 buffer periods means device lost.
  Then tear down, re-enumerate and toast.
- **Engine rule:** a stream rebuild must never lose transport or project state. The engine owns the
  "device lost → rebuild → resume" state machine. The UI only shows status.

### 1.5 Latency table

Buffer math is exact. Converter and driver overheads are typical ranges **[E]**. Re-measure on real
hardware with a loopback cable and Oblique Audio's RTL Utility before quoting any number to users.

| Path (48 kHz) | Period / buffer | Buffer time | Output latency | Round-trip (in→out) | Other apps keep sound? |
|---|---|---|---|---|---|
| WASAPI shared, default (`IAudioClient`, cpal 0.18) | 480 frames | 10 ms **[V]** | ~15–30 ms **[E]** | ~25–50 ms **[E]** | Yes |
| WASAPI shared, `IAudioClient3`, inbox HDAudio min | 128 frames | 2.67 ms **[V]** | ~5–8 ms **[E]** | ~8–15 ms **[E]** | Yes (they also switch to small periods) |
| WASAPI exclusive, event-driven, onboard HDA | ~3 ms typical device min **[E]** | ~3 ms | ~5–10 ms **[E]** | ~10–20 ms **[E]** | **No** |
| ASIO, decent USB interface | 64 frames | 1.33 ms | ~2.5–4 ms **[E]** | ~4–8 ms **[E]** | Driver-dependent |
| ASIO, decent USB interface | 128 frames | 2.67 ms | ~4–6 ms **[E]** | ~6–11 ms **[E]** | Driver-dependent |
| ASIO, decent USB interface | 256 frames | 5.33 ms | ~7–9 ms **[E]** | ~12–18 ms **[E]** | Driver-dependent |
| ASIO4ALL on onboard audio (KS) | 256–512 frames | 5.3–10.7 ms | ~8–15 ms **[E]** | ~15–30 ms **[E]** | **No** (KS exclusive) |
| FlexASIO, default config | 20 ms (DirectSound) **[V]** | 20 ms | ~40+ ms **[E]** | ~60–100 ms **[E]** | Yes |
| Bluetooth A2DP headphones (SBC/AAC) | codec + radio buffering | — | **~100–300 ms [E]** | n/a (mic falls back to HFP) | Yes |

Rules: **never monitor recording over Bluetooth**; show a warning banner when the output endpoint is
Bluetooth. Compensate the drawn playhead with the stream's reported latency (cpal 0.18 timestamps
include hardware latency **[V]**).

### 1.6 Thread priority (MMCSS), power and timers

- **MMCSS:** call `AvSetMmThreadCharacteristicsW(L"Pro Audio", &idx)` on the engine's render
  thread, and `AvRevertMmThreadCharacteristics` when done **[V]**. The "Pro Audio" task maps to the
  **High** category, **priority 23–26** **[V]**. `SystemResponsiveness` (HKLM, default 20)
  reserves 20% CPU for low-priority work **[V]**. Don't ask users to edit HKLM (house rule: prefer HKCU,
  avoid admin). cpal's `realtime` feature uses task **"Audio"** via `audio_thread_priority` (MPL-2.0)
  **[M: source]**. Fine for v0; our own backend should use "Pro Audio".
- **ASIO:** the **driver owns the callback thread** and sets its priority. Don't fight it.
- **EcoQoS / power throttling (Win11):** processes Windows decides are *playing audio* get HighQoS
  **[V]**. For engine worker threads (disk streaming, plugin pool), opt out explicitly with
  `SetThreadInformation(ThreadPowerThrottling)` / `SetProcessInformation(ProcessPowerThrottling)`
  using `ControlMask` set and `StateMask = 0` **[V]**.
- **Timers:** since **Win10 2004**, `timeBeginPeriod` is **per-process**, not global **[V]**. On Win11,
  Windows may *ignore* it for windows that are minimized/occluded **and non-audible** **[V]**. The
  engine is event-driven (WASAPI event / ASIO callback), so it doesn't need timer resolution. Never
  schedule musical events from `Sleep()` or JS timers.
- **CPU scaling:** laptops on "Best power efficiency" or battery saver park cores and clock down,
  causing xruns at small buffers **[E]**. Detect battery saver (`GetSystemPowerStatus`) and suggest
  "Best performance" in a banner. On Intel hybrid CPUs, Windows 10 has no hybrid-aware scheduler, so
  audio threads can land on E-cores **[E]**. Don't hard-pin affinity; MMCSS plus no EcoQoS is the
  supported lever.
- **Keep the PC awake while it matters:** Electron
  `powerSaveBlocker.start('prevent-app-suspension')` (documented for "playing audio") **only while**
  playing, recording or exporting **[V]**.

---

## 2. MIDI on Windows

### 2.1 WinMM legacy vs Windows MIDI Services

| | Windows 10 (dev box) | Windows 11 24H2/25H2 with Windows MIDI Services |
|---|---|---|
| Status | WinMM + WinRT MIDI 1.0. **No MIDI Services** (rollout targets in-support Win11 only) **[V]** | In-box, phased rollout from **Feb 2026** **[V]** |
| Multi-client | **No**: a port opened by one app is unavailable to others (driver-dependent) **[E, long-standing]** | **"Every MIDI 1.0 port and MIDI 2.0 endpoint is multi-client, regardless of the driver or API used"**, with no app update needed **[V]** |
| Virtual/loopback ports | None built in. Users install **loopMIDI** (freeware) **[E]** | **Built-in loopback endpoints**, usable from any API incl. Web MIDI **[V]** |
| MIDI 2.0 / UMP, sub-µs timestamps, scheduled send | No | Via the **Windows MIDI Services App SDK** (separate runtime install; WinRT-style API) **[V]** |
| BLE MIDI | WinRT BLE MIDI 1.0 | "On our backlog" as of Feb 2026 **[V]** |
| Network MIDI 2.0 | No | Preview only **[V]** |

Windows 10 consumer support ended Oct 2025. Microsoft's ESU page says consumer ESU runs to
**12 Oct 2027** **[V]**, though press coverage said Oct 2026. Either way, **Win10 users will
never get MIDI Services**, so the engine must handle single-client WinMM gracefully. **The dev
box can't test MIDI Services; get a Win11 24H2 test machine/VM.**

### 2.2 Crates

| Crate | Version (2026-10) | License | Role | Windows notes |
|---|---|---|---|---|
| `midir` | 0.11.1 (2026-10-10) | MIT | Live MIDI I/O | WinMM backend; `winrt` feature for WinRT. **No virtual ports on Windows** **[V]**. No MIDI Services/UMP backend. On Win11 it gets multi-client "for free" through WinMM |
| `wmidi` | 4.0.11 | MIT | Allocation-free message parse/encode, `no_std` | No MIDI 2.0/MPE helpers **[V]** |
| `midly` | 0.5.3 (2023-01) | **Unlicense** | `.mid` read/write, live-event parse | Stable but quiet upstream **[V]** |

MIDI 2.0/UMP on Win11 means binding the App SDK's WinRT types via `windows` metadata. That's Phase 3,
Win11-only, and optional.

### 2.3 Web MIDI in Electron as a fallback

- Electron gates it via `session.setPermissionRequestHandler` / `setPermissionCheckHandler`
  permissions **`midi`** and **`midiSysex`** **[V]**.
- Chromium on Windows uses the **WinMM backend**. The WinRT backend (`kMidiManagerWinrt`) is
  **disabled by default** **[V: Chromium source]**.
- **Gotcha:** on Windows 10, if the renderer calls `requestMIDIAccess()`, Chromium opens the WinMM
  ports, and the native engine can no longer open them (single-client). **Recommendation: deny
  `midi`/`midiSysex` by default.** Do all MIDI in the engine. Keep Web MIDI only as an explicit
  "compat mode" toggle that stops native MIDI first.

### 2.4 Clock/sync and MPE

- **MIDI clock out:** 0xF8 at 24 PPQN, plus Start 0xFA / Continue 0xFB / Stop 0xFC and Song Position 0xF2.
  Generate ticks **from the audio callback's sample clock**. Hand them to a dedicated MIDI-out thread
  with target timestamps. WinMM has no scheduled send, so expect about ±1 ms jitter **[E]**. On Win11
  the App SDK offers scheduled sends with sub-µs timestamps **[V]**.
- **MIDI clock in:** smooth the incoming tick period (e.g. a PLL or moving average over 24 to 96 ticks)
  before slaving tempo. Raw WinMM timestamps are ms-resolution.
- **MPE (MIDI 1.0 convention):** zones with a master channel plus member channels, per-note pitch bend
  (default ±48 st on members), CC74 "slide" and channel pressure, configured via the MPE RPN. midir
  passes raw bytes, so MPE is pure engine logic: a voice allocator keyed by channel. MIDI 2.0 per-note
  controllers are a Win11/App SDK future item.

---

## 3. Media formats

### 3.1 Decoding: symphonia 0.6.1 (MPL-2.0) [V: README]

| Format/codec | Status | Default feature? | KryptStudio note |
|---|---|---|---|
| WAV (PCM/float/ADPCM) | Excellent | yes | Primary |
| AIFF | Great | **no** (`aiff`) | Enable |
| FLAC | Excellent | yes | |
| MP3 (MP1/2/3) | Excellent | **no** (`mp3`/`mpa`) | Enable |
| OGG Vorbis | Excellent | yes | |
| **Opus** | **"Not rated"** (new in 0.6) | yes | Test it. Fallback: `symphonia-adapter-libopus` (MIT/Apache + libopus BSD-3) |
| M4A: AAC-LC / ALAC in ISO-MP4 | Great / Great | **no** (`aac`, `alac`, `isomp4`) | Symphonia ships only royalty-free codecs by default **[V]**. For AAC, consider decoding via **Media Foundation** (OS-licensed); I couldn't verify AAC patent status today |
| WavPack, CAF, MKV/WebM | various | mixed | Nice to have |

- 0.6 is a big **breaking** rewrite: timing moved into track metadata, `AudioDecoder` /
  `make_audio_decoder()`. MSRV is 1.85 **[V]**. Don't copy pre-0.6 tutorials.
- **MPL-2.0** is file-level copyleft: we can ship it in an MIT app. If we **modify** symphonia files,
  those files' source must be published. Keep it as an unmodified crates.io dependency and list it in
  notices.

### 3.2 Encoding and export

| Target | Choice | License | Notes |
|---|---|---|---|
| WAV 16/24/32-int/32f | `hound` 3.5.1 | Apache-2.0 | No `smpl`/`acid`/`cue `/`bext` writing and no RF64 (>4 GB). Write those chunks with our own small RIFF writer. Float WAV needs `cbSize` and a `fact` chunk **[V: McGill WAVE spec]** |
| FLAC | `flacenc` 0.5.1 | Apache-2.0 | Pure Rust |
| **MP3** | **Windows Media Foundation MP3 encoder** (`CLSID_MP3ACMCodecWrapper`) | OS component | Win8+. **16-bit PCM input only**, 32/44.1/48 kHz, CBR 32–320 kbps **[V]**. Dither to 16-bit first. **Missing on Windows "N" editions** without the Media Feature Pack, so detect and explain |
| MP3 (fallback) | LAME as a **separate, runtime-loaded** `libmp3lame.dll` | LGPL | Dynamic linking is LAME's own recommendation. Credit LAME, ship the LGPL text, publish any modifications. **LAME's decoder (mpglib) is GPL**, so build with the decoder disabled **[V: LAME license FAQ]**. ✗ Don't use `mp3lame-encoder`/`mp3lame-sys` (LGPL-3.0, static) or `shine-rs` (LGPL-2.0) |
| OGG Vorbis | `vorbis_rs` 0.5.6 | BSD-3-Clause | Compiles C via `cc` at *engine build* time (dev/CI only) |
| Opus | `opus` 0.4.0 (MIT/Apache, libopus BSD-3) + `ogg` 0.9.2 (BSD-3) | permissive | Opus is 48 kHz-native, so resample first. Pure-Rust `opus-rs` 0.1.x (BSD-3) is young |
| AAC/M4A (optional) | Media Foundation AAC encoder | OS component | Same N-edition caveat |

### 3.3 DSP for export

- **Sample-rate conversion:** `rubato` 5.0.1 (MIT OR Apache-2.0). Async sinc for arbitrary ratios, FFT
  for fixed ratios. Use it for project↔device rate and export rate conversion.
- **Dithering:** write it ourselves. TPDF (sum of two uniform randoms, ±1 LSB) when reducing to 16 or
  24-bit, with optional noise shaping. Never dither float exports. It's about 20 lines and no crate is
  needed.
- **Loudness:** `ebur128` 0.1.10 (MIT) for integrated/short-term/momentary LUFS, LRA and true-peak.
  Show it on the export dialog and the master meter.
- **Tags on export:** `lofty` 0.25.4 (MIT OR Apache-2.0) for ID3v2/Vorbis comments/MP4 atoms.

### 3.4 Loops and sample metadata

- **WAV `smpl` chunk:** manufacturer, product, sample period, **MIDI unity note (root key)**, pitch
  fraction, SMPTE format/offset, loop count and sampler-data size, then 6×u32 loop records (cue id,
  type 0=fwd/1=alt/2=back, start, end, fraction, play count) **[V: libsndfile `wav.c` used as a format
  reference only; libsndfile is LGPL, don't link it]**.
- **ACID `acid` chunk:** `flags` u32 (0x01 one-shot, 0x02 root-note valid, 0x04 stretch, 0x08
  disk-based), root note u16, 2 unknown fields, **beats u32, meter denominator u16, numerator u16,
  tempo f32** **[V: same reference]**. Read it to auto-set root key, BPM and loop length on import.
  **Write** it on "Export loop".
- Also read `inst` (root key/gain/ranges), `cue `/`LIST adtl` (markers) and `bext` (BWF). symphonia
  reads RIFF INFO tags; the chunks above need our own RIFF walker (about 200 lines).
- **REX2 (.rx2/.rex/.rcy):** decoding needs Reason Studios' proprietary **REX Shared Library** (closed
  DLL). I couldn't read the current terms because the dev site is JS-rendered. **Defer.** It can never
  be MIT-bundled; at most it could be an optional user-installed DLL later. Workaround for users: export
  slices from ReCycle as WAV + MIDI.
- **Apple Loops (AIFF/CAF with tempo metadata):** low priority.

---

## 4. Building and shipping the native engine

### 4.1 napi-rs addon vs sidecar: the Windows/packaging view

| Concern | napi-rs v3 addon in Electron main | Sidecar `krypt-engine.exe` |
|---|---|---|
| **ABI** | Node-API is ABI-stable. On Windows, `napi-sys` resolves Node-API symbols **at runtime from the host process** (`libloading`) rather than linking `node.lib` **[V: napi-sys source]**. One `.node` per target (`win32-x64-msvc`) should survive Electron upgrades. Verify with a CI smoke test. (Electron's docs still say "usually rebuild" for classic `node-gyp`/NAN modules **[V]**) | None. Any Electron version works |
| **Bundling** | Rollup `external` + `asarUnpack`/`extraResources` (house uiohook pattern) | `extraResources` only. Spawn by absolute path (`process.resourcesPath`), per house rule §5.1 |
| **Crash blast radius** | **ASIO drivers are third-party DLLs loaded into our process.** A buggy driver (or later a VST3 plugin) takes down **Electron main**, the MCP server and unsaved UI state | Engine dies alone. Main restarts it in about 250 ms and re-sends project state **[M: supervisor test]** |
| **Kill on app exit** | Automatic (same process) | Automatic: libuv assigns **non-detached** children to a Job Object with `KILL_ON_JOB_CLOSE` **[V: libuv `process.c`]**. **Verified with normal exit *and* `Stop-Process -Force` of the parent [M].** `detached: true` escapes it **[M]** |
| **Dev loop on Windows** | A loaded `.node` is locked and **can't be unloaded**, so every Rust change means restarting Electron | `cargo build` can't overwrite a running exe (**os error 5 [M]**). Fix: run a **shadow copy**, then hot-restart only the engine. Renderer and main keep running |
| **Priority/QoS** | Shares Electron's process (priority class, EcoQoS decisions) | Own process: own priority class, MMCSS and EcoQoS. It's the "audible" process |
| **COM** | Audio APIs must not run on the JS thread. Chromium owns its COM apartment. cpal inits STA per thread and tolerates `RPC_E_CHANGED_MODE` **[M: source]**; our own WASAPI code must use a dedicated engine thread | We own every thread |
| **Signing/AV** | `.node` must be signed (it's a PE) | One more PE to sign. New unsigned exes attract Defender ML detections **[E]** |
| **Volume Mixer / Task Manager** | Shows as Krypt Studio | Shows `krypt-engine.exe` unless we embed a version resource (FileDescription + icon) and call `IAudioSessionControl::SetDisplayName/SetIconPath` |
| **House rule "no C++ compile at npm install"** | OK if `.node` is prebuilt in CI and `npm install` never runs cargo | Same |

**Middle option worth knowing:** load the napi addon inside an Electron **`utilityProcess`**. That
gives crash isolation and Electron-managed lifecycle without a second exe, but the dev-loop `.node` lock
and asar/Rollup work remain. **My Windows-side recommendation: sidecar.** The rest of this section and
the recipe assume it, with a napi appendix.

### 4.2 Sidecar lifecycle

- **Spawn:** `child_process.spawn(absPath, [], { windowsHide: true, stdio: 'pipe' })`, **never
  `detached`**. The path comes from `process.resourcesPath` in packaged builds (house §5.1 lesson:
  packaged Electron has a stripped PATH).
- **Death of the parent:** handled twice. (1) libuv's job object kills the engine, even on hard kill
  **[M]**. (2) The engine exits on **stdin EOF** **[M]**. No koffi Job Object code is needed. (If we
  ever spawn with `detached`, add `win32job` (MIT/Apache) *inside* the engine, or a parent-PID
  watchdog.)
- **Crash restart:** exponential backoff (250/500/1000 ms). After **4 crashes in 60 s**, stop and
  show a red banner with "Restart engine" **[M: implemented and tested]**.
- **Crash diagnostics:** libuv's job also sets `JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION` **[V]**,
  so a crashing engine shows **no WER dialog**, and you shouldn't expect WER dumps **[E]**. Log the
  exit code. Add an in-engine minidump writer later (evaluate EmbarkStudios `crash-handler`/`minidumper`
  and check their licenses). Keep PDBs from CI as release artifacts.
- **Shutdown:** `shutdown` RPC, then close stdin, then kill after 1.5 s. `stop()` must await the
  `exit` event so a following `start()` can't race **[M: bug found and fixed in the recipe]**.

### 4.3 IPC and shared memory

- **Control plane:** line-delimited JSON over **stdio** for v0 (zero deps, EOF = parent gone). Move to
  a **named pipe** when traffic grows. Node `net` speaks `\\.\pipe\…` natively; on the Rust side use
  `interprocess` 2.4.5 (0BSD OR Apache-2.0). Use msgpack/bincode framing for meters.
- **Meters/scopes:** 30–60 Hz snapshots of a few KB are trivial over a pipe. **Don't start with shared
  memory.**
- **Named file mapping (when needed, e.g. big waveform/spectrogram buffers):**
  - Engine: `CreateFileMappingW(INVALID_HANDLE_VALUE, …, PAGE_READWRITE, 0, size, L"Local\\KryptStudio-<pid>-<nonce>")`.
    Use the `Local\` (per-session) namespace, since `Global\` needs `SeCreateGlobalPrivilege`. Use an
    unguessable name passed via argv. Protect readers with a seqlock (version counter before/after).
  - Electron: there's no built-in. koffi (MIT, 3.3.3) can call `OpenFileMappingW` / `MapViewOfFile`,
    **but `koffi.view(ptr, len)` (zero-copy ArrayBuffer) "will trigger an exception" in Electron**
    **[V: koffi docs]**. The cause is Electron's **V8 memory cage**: "ArrayBuffers which point to external
    ("off-heap") memory are no longer allowed" **[V: Electron blog]**. So **read by copying** into a
    pre-allocated `Buffer` (koffi call to `RtlMoveMemory(buf, ptr, len)`, or a napi helper using
    `napi_create_buffer_copy`).
  - Do this in **main or a utilityProcess**, never the renderer. Forward to the renderer with
    `MessagePort` transfers.

### 4.4 Dev workflow: Rust watch + Vite HMR

- **cargo-watch is on "life support"**. Its maintainer recommends **Bacon or Watchexec** **[V]**. Use
  **`watchexec-cli` 2.8.0 (Apache-2.0)**: `cargo install --locked watchexec-cli`. Bacon 3.26.0 is
  **AGPL-3.0**: fine as a never-bundled personal dev tool, but keep it out of repo scripts.
- `npm run dev` = `concurrently -k` (MIT, 10.0.6) of:
  - `watchexec -w engine -e rs,toml -- cargo build` (dev profile), and
  - `vite` (vite-plugin-electron 1.1.2 restarts main on main changes; HMR for the renderer).
- In dev, `electron/system/engine.ts` **spawns a shadow copy** of `target/debug/krypt-engine.exe` and
  `fs.watch`es the original. When cargo writes a new exe, it does `stop()` → `start()` and the
  renderer gets an `engine:reloaded` event to re-push project state. The result is engine hot reload
  with no Electron restart.
- **Debug-build Rust DSP will crackle.** Set `[profile.dev] opt-level = 1` and
  `[profile.dev.package."*"] opt-level = 3`.
- **Contributors who only touch UI** shouldn't need Rust. Add `npm run engine:fetch` to pull the
  latest CI-built engine artifact. `npm install` must **never** trigger cargo (no postinstall), per
  the house "no compile at install" rule.

### 4.5 CI: GitHub Actions

- `windows-latest` moved to **Windows Server 2025** (Sept 2025) **[V]**. The image moved to **VS 2026**
  over 8–15 Jun 2026 **[V]**, but the image readme I fetched still lists VS 2022 17.14. **Pin
  `runs-on: windows-2025` and print `cl`/`link` versions.** The image ships Rust 1.99, LLVM 20.1.8,
  Node 22 (24 cached) and CMake 3.31 **[V]**. There's no NSIS, but electron-builder downloads its own.
- **Runners have no audio endpoint [E].** `default_output_device()` returns `None`, so the engine needs
  an `--offline`/null backend for tests and export rendering anyway.
- **`RUSTFLAGS` env overrides `.cargo/config.toml` rustflags** **[M]**. If CI sets `RUSTFLAGS: -D warnings`,
  you silently lose `+crt-static`. Include it there too, or use `[lints]` instead.

```yaml
# .github/workflows/build.yml (sketch)
name: build
on: [push, pull_request]
jobs:
  windows:
    runs-on: windows-2025
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 24, cache: npm }
      - run: rustup toolchain install stable --profile minimal && rustup default stable
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: engine }
      - run: npm ci                      # must not invoke cargo
      - run: cargo test --locked --manifest-path engine/Cargo.toml
      - run: npm run engine:build        # release, crt-static via repo-root .cargo/config.toml
      - name: Assert static CRT
        shell: pwsh
        run: if (Select-String -Path engine/target/release/krypt-engine.exe -Pattern 'VCRUNTIME140' -SimpleMatch -Quiet) { throw 'engine imports VCRUNTIME140.dll' }
      - run: npm run typecheck && npm run build
      - run: npx electron-builder --win --publish never
        # env: AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET once signing is set up
      - uses: actions/upload-artifact@v4
        with: { name: installer, path: "release/*.exe" }
      - uses: actions/upload-artifact@v4
        with: { name: engine-pdb, path: engine/target/release/*.pdb }
```

(Action major versions are from memory. Bump to the current majors when creating the workflow.)

### 4.6 Code signing, SmartScreen, Defender

- **Unsigned:** downloaded installers carry Mark-of-the-Web, so users see SmartScreen's "Windows
  protected your PC" and have to click "More info → Run anyway" **[E, standard behavior]**. **Windows
  11 Smart App Control**, where enabled, can block unsigned/unknown apps with no override **[E]**. Test
  on a clean Win11 VM.
- **EV is no longer a shortcut:** "since 2024 [EV] no longer earns SmartScreen reputation
  immediately… Microsoft treats EV and OV… the same" **[V: electron-builder docs]**.
- **Azure Artifact Signing** (renamed from Trusted Signing; GA Jan 2026):
  - **$9.99/mo Basic** (5,000 signatures, 1 cert profile). **$99.99/mo Premium** (100k sigs, 10
    profiles). Overage about $0.005/signature. **Billing starts at account creation** **[V]**.
  - **Individuals: US/Canada only.** Organizations: US, CA, EU, UK and more (AU, NZ, JP, KR, SG, CH, NO,
    IL per the current quickstart) **[V]**. Needs a pay-as-you-go Azure subscription, not a sponsored
    one **[V]**.
  - Certificates live **3 days**, so **always timestamp** **[V]**. Reputation still builds over time
    **[V]**.
  - electron-builder 26.x: `win.azureSignOptions { publisherName, endpoint, certificateProfileName,
    codeSigningAccountName }` plus `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET`. v27 (beta) switches to
    `signtool /dlib` **[V]**.
- **SignPath Foundation** (free for OSS): requires OSI licenses for **all** components and no
  proprietary code **[V]**. Viable only for a non-ASIO build.
- **Sign every PE:** NSIS installer, uninstaller, `Krypt Studio.exe`, `krypt-engine.exe`, and any
  `.node`/`.dll`. electron-builder "signs every executable and installer it produces" **[V]**. For
  `extraResources` binaries, **verify** with `Get-AuthenticodeSignature` and add `win.signExts` (marked
  deprecated in newer docs **[V]**) or a custom `sign` hook if needed.
- **Defender false positives:** new, low-prevalence, unsigned exes that spawn processes and open pipes
  are prime candidates for `Wacatac.*!ml` ML detections **[E]**. Mitigations: sign; **never** UPX/pack
  the engine; before each release, submit installer and engine to Microsoft's file-submission portal
  (WDSI) as "incorrectly detected" **[E: portal URL from memory, below]**. We ship **no kernel
  drivers**. ASIO drivers come from vendors; never bundle ASIO4ALL or FlexASIO installers.

### 4.7 Installer size budget

- Baseline: **Krypt Macro's NSIS installer is 104 MB** **[M]**. The **Electron 44.7.0 win32-x64 zip
  is 158 MB** **[V: GitHub release asset]**. Expect a KryptStudio core installer of about
  **110–140 MB** **[E]**.
- Engine: **~0.47 MB** for hello-sine (static CRT, release) **[M]**. With symphonia, rubato and encoders,
  expect **3–10 MB** **[E]**.
- **Budget: core installer ≤ 160 MB.** Factory samples/presets ship as **separate content packs**
  (downloaded in-app or a second installer). Never ship PDBs in the installer; upload them as CI
  artifacts.

---

## 5. Performance and system gotchas (audio-specific)

1. **Denormals.** Set FTZ/DAZ (MXCSR bits 0x8040) **per audio callback**, scoped. Rust deprecated
   `_mm_setcsr` in 1.75 and calls changing MXCSR UB unless done in inline asm that restores state
   **[V]**. Use **`no_denormals` 0.3.0 (MIT)**, an inline-asm RAII guard **[V]**, at the top of every
   callback, *including* ASIO's driver-owned thread. Belt and braces: add a 1e-20 DC offset in
   feedback paths (reverb/filters).
2. **Electron background throttling.** `backgroundThrottling` (default `true`) throttles renderer
   timers and animations when hidden. Setting it `false` on one webContents un-throttles the whole
   window **[V]**. **Keep it on.** No musical timing lives in JS; the engine owns the clock and the
   renderer only draws snapshots.
3. **Chromium's own audio stack.** Any `AudioContext`, `<audio>` or notification sound in the renderer
   opens a separate WASAPI shared stream on the default device. With the engine in **exclusive or
   ASIO4ALL** mode, that renderer audio fails. With Chromium holding the device, the engine's
   exclusive open fails (`AUDCLNT_E_DEVICE_IN_USE`). **Rule: the renderer never plays audio.**
   Previews and UI clicks go through the engine.
4. **Exclusive mode blocks everything else** on that endpoint, including browser, Discord and system
   sounds **[V]**. Users can forbid it ("Allow applications to take exclusive control of this
   device"), which gives `AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED`. Default to shared low-latency and make
   exclusive an explicit, explained opt-in.
5. **Communications ducking.** When Discord or Teams opens a "communications" stream, Windows by
   default lowers other sounds by up to 80%. Opt the engine session out with
   `IAudioSessionControl2::SetDuckingPreference(TRUE)` **[E]**.
6. **Bluetooth.** A2DP adds about 100–300 ms **[E]**. Opening the headset mic switches to HFP:
   mono, telephone quality, and a *different* endpoint. Detect Bluetooth endpoints and warn.
7. **USB interfaces.** The in-box class-compliant USB Audio 2.0 driver is WASAPI-only, with no ASIO
   **[E]**. Vendor ASIO drivers are often single-client and may lock the sample rate globally. USB
   selective suspend, unpowered hubs and front-panel ports cause dropouts. DPC spikes from
   Wi-Fi/GPU/ACPI drivers cause crackles **[E]**. Point users at LatencyMon, and log xrun counts with
   timestamps so support can correlate.
8. **The audible process is the sidecar.** Windows exempts audio-playing processes from EcoQoS
   **[V]**. With a sidecar, Electron main is "silent" and may be throttled when minimized on Win11.
   That's fine, since nothing timing-critical lives there. The MCP server tolerates jitter.

---

## 6. Crate and library table (licenses verified on crates.io/npm 2026-10-11 unless noted)

| Purpose | Library | Version | License | MIT-app OK? |
|---|---|---|---|---|
| Audio I/O (WASAPI shared, ASIO) | `cpal` | 0.18.2 | Apache-2.0 | ✓ |
| ↳ RT priority (cpal `realtime`) | `audio_thread_priority` | 0.35.x | MPL-2.0 | ✓ (unmodified) |
| ↳ ASIO bindings | `asio-sys` | 0.4/0.5 | Apache-2.0 | ✓ |
| ↳ **ASIO SDK** | Steinberg ASIO SDK 2.3.4 | — | **Proprietary (free, signed) or GPLv3** | ⚠ proprietary path only |
| WASAPI exclusive + notifications | `wasapi` | 0.25.0 | MIT | ✓ |
| Raw Win32/COM (IAudioClient3, MF, Avrt) | `windows` / `windows-sys` | 0.62.2 / 0.61.2 | MIT OR Apache-2.0 | ✓ |
| MIDI I/O | `midir` | 0.11.1 | MIT | ✓ |
| MIDI messages | `wmidi` | 4.0.11 | MIT | ✓ |
| SMF files | `midly` | 0.5.3 | Unlicense | ✓ |
| Decode | `symphonia` | 0.6.1 | MPL-2.0 | ✓ (unmodified) |
| Opus decode fallback | `symphonia-adapter-libopus` | 0.3.0 | MIT OR Apache-2.0 (+ libopus BSD-3) | ✓ |
| WAV write | `hound` | 3.5.1 | Apache-2.0 | ✓ |
| FLAC encode | `flacenc` | 0.5.1 | Apache-2.0 | ✓ |
| Vorbis encode | `vorbis_rs` | 0.5.6 | BSD-3-Clause | ✓ |
| Opus encode | `opus` | 0.4.0 | MIT/Apache-2.0 (+ libopus BSD-3) | ✓ |
| Opus encode (pure Rust, young) | `opus-rs` | 0.1.37 | BSD-3-Clause | ✓ |
| Ogg container | `ogg` | 0.9.2 | BSD-3-Clause | ✓ |
| MP3 encode | Windows Media Foundation | OS | OS component | ✓ |
| MP3 encode (avoid) | `mp3lame-encoder` / `mp3lame-sys` | 0.2.5 / 0.1.11 | LGPL-3.0 | ✗ (static) |
| MP3 encode (avoid) | `shine-rs` | 0.1.5 | LGPL-2.0 | ✗ |
| MP3 encode (fallback) | LAME `libmp3lame.dll`, runtime-loaded | 3.100 | LGPL (decoder part GPL) | ⚠ separate DLL, decoder off |
| Resampling | `rubato` | 5.0.1 | MIT OR Apache-2.0 | ✓ |
| Loudness | `ebur128` | 0.1.10 | MIT | ✓ |
| Tags | `lofty` | 0.25.4 | MIT OR Apache-2.0 | ✓ |
| Denormals | `no_denormals` | 0.3.0 | MIT | ✓ |
| RT SPSC ring | `rtrb` / `ringbuf` | 0.4.0 / 0.5.3 | MIT OR Apache-2.0 | ✓ |
| RT-safe drop | `basedrop` | 0.1.3 | MIT/Apache-2.0 | ✓ |
| Triple buffer | `triple_buffer` | 9.0.0 | MPL-2.0 | ✓ (unmodified) |
| Alloc checker (debug) | `assert_no_alloc` | 1.1.2 | BSD-1-Clause | ✓ |
| Disk streaming | `creek` | 1.2.3 | MIT OR Apache-2.0 | ✓ |
| Named pipes / local sockets | `interprocess` | 2.4.5 | 0BSD OR Apache-2.0 | ✓ |
| Job objects (only if detached) | `win32job` | 2.0.3 | MIT OR Apache-2.0 | ✓ |
| Thread priority (generic) | `thread-priority` | 3.1.1 | MIT | ✓ |
| Shared memory (stale, 2022) | `shared_memory` | 0.12.4 | MIT OR Apache-2.0 | ✓ (prefer raw `windows`) |
| PCM helpers (stale, 2020) | `dasp` | 0.11.0 | MIT OR Apache-2.0 | ✓ |
| JSON | `serde` / `serde_json` | 1.x / 1.0.152 | MIT OR Apache-2.0 | ✓ |
| Node addon (if napi path) | `napi` / `napi-derive` / `@napi-rs/cli` | 3.14.2 / 3.6.12 / 3.10.8 | MIT | ✓ |
| Win32 FFI from JS | `koffi` | 3.3.3 | MIT | ✓ |
| Shell | `electron` | 44.7.0 (Node 24, M152) | MIT | ✓ |
| Packaging | `electron-builder` / `vite-plugin-electron` | 26.15.3 / 1.1.2 | MIT | ✓ |
| Dev runner | `concurrently` | 10.0.6 | MIT | ✓ (dev) |
| Rust watch | `watchexec-cli` | 2.8.0 | Apache-2.0 | ✓ (dev tool) |
| Rust watch (alt) | `bacon` | 3.26.0 | **AGPL-3.0** | dev-only, never bundled |
| Rust watch (legacy) | `cargo-watch` | 8.5.3 | CC0-1.0 | life support, skip |
| Universal ASIO | ASIO4ALL 2.16 | — | Freeware, proprietary | link only |
| Universal ASIO | FlexASIO | — | MIT (own code) + Steinberg terms | link only |
| REX2 loops | REX Shared Library | — | Proprietary | ✗ defer |
| Format reference only | libsndfile | — | LGPL-2.1 | ✗ don't link |
| Plugin SDK (FYI) | VST 3 SDK | 3.8 | **MIT** (since Oct 2025) | ✓ |

Add `cargo-deny` with an allow-list (MIT, Apache-2.0, BSD-*, ISC, Unlicense, 0BSD, Zlib, MPL-2.0,
CC0-1.0, BSD-1-Clause) so CI **fails on GPL/AGPL/LGPL** in the engine's dependency graph.

---

## 7. "Hello sine" recipe: sidecar engine in the Krypt pipeline

**Status: steps 1–4 and the supervisor were built and run on the dev box today [M].** The release exe
is 466 KB with static CRT. It opened WASAPI shared at 48 kHz stereo, and the RPC, error correlation,
crash→restart, stop→start and stdin-EOF exit all worked with no orphan processes. The tests ran
**silently** (gain 0, never `play`). The Electron glue in steps 5–8 follows house patterns but wasn't
run inside Electron today.

### Step 0: Prerequisites (dev box already has these)
Rust stable MSVC (1.98 ✓), VS Build Tools 2022 C++ workload ✓, Node 24 ✓. For dev:
`cargo install --locked watchexec-cli`.

### Step 1: Layout
```
KryptStudio/
├── .cargo/config.toml          # REPO ROOT: crt-static (engine/.cargo is ignored with --manifest-path!)
├── engine/
│   ├── Cargo.toml
│   └── src/main.rs
├── electron/system/
│   ├── engineSupervisor.ts     # pure Node: spawn, RPC, restart (no 'electron' import, unit-testable)
│   └── engine.ts               # Electron glue: paths, dev shadow-copy + hot restart, broadcast
└── ...                         # house §4.2 layout
```

### Step 2: `.cargo/config.toml` (repo root) and `engine/Cargo.toml`
```toml
# .cargo/config.toml
[target.x86_64-pc-windows-msvc]
rustflags = ["-C", "target-feature=+crt-static"]   # no VCRUNTIME140.dll on users' PCs
```
```toml
# engine/Cargo.toml
[package]
name = "krypt-engine"
version = "0.1.0"
edition = "2024"
license = "MIT"
publish = false

[dependencies]
cpal = { version = "0.18.2", features = ["realtime"] } # Apache-2.0; realtime pulls audio_thread_priority (MPL-2.0)
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.dev]
opt-level = 1                 # debug DSP at opt-level 0 crackles
[profile.dev.package."*"]
opt-level = 3

[profile.release]
lto = "thin"
codegen-units = 1
panic = "abort"               # a panic kills the sidecar; Electron main restarts it
debug = "line-tables-only"    # keep the PDB for symbolication (CI artifact, not shipped)
```

### Step 3: `engine/src/main.rs`
```rust
//! krypt-engine "hello sine" sidecar.
//! Protocol: one JSON object per line on stdin -> one JSON reply per line on stdout.
//! stdin EOF (parent died or closed the pipe) => clean exit.

use std::io::{self, BufRead, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::Relaxed};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{OutputCallbackInfo, SampleFormat, StreamConfig};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum Cmd {
    Play,
    Stop,
    SetFreq { hz: f32 },
    SetGain { gain: f32 },
    Shutdown,
}

struct Shared {
    playing: AtomicBool,
    freq: AtomicU32, // f32 bits
    gain: AtomicU32, // f32 bits
}

fn reply(out: &mut impl Write, v: serde_json::Value) {
    // Ignore write errors: if stdout is gone, stdin EOF will end us shortly.
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn main() {
    let mut out = io::stdout().lock();
    if let Err(e) = run(&mut out) {
        reply(&mut out, json!({ "event": "fatal", "message": e.to_string() }));
        std::process::exit(2);
    }
}

fn run(out: &mut impl Write) -> Result<(), Box<dyn std::error::Error>> {
    let shared = Arc::new(Shared {
        playing: AtomicBool::new(false),
        freq: AtomicU32::new(440.0f32.to_bits()),
        gain: AtomicU32::new(0.2f32.to_bits()),
    });

    let host = cpal::default_host(); // WASAPI shared mode on Windows
    let device = host.default_output_device().ok_or("no default output device")?;
    let supported = device.default_output_config()?;
    if supported.sample_format() != SampleFormat::F32 {
        return Err(format!("unexpected mix format {:?}", supported.sample_format()).into());
    }
    let config: StreamConfig = supported.into();
    let sr = config.sample_rate as f32;
    let ch = config.channels as usize;

    let s = Arc::clone(&shared);
    let mut phase = 0.0f32;
    let stream = device.build_output_stream(
        config,
        move |data: &mut [f32], _: &OutputCallbackInfo| {
            // Real-time thread: no allocation, no locks, no I/O.
            let playing = s.playing.load(Relaxed);
            let inc = f32::from_bits(s.freq.load(Relaxed)) / sr;
            let gain = f32::from_bits(s.gain.load(Relaxed));
            for frame in data.chunks_mut(ch) {
                let v = if playing { (phase * std::f32::consts::TAU).sin() * gain } else { 0.0 };
                phase += inc;
                if phase >= 1.0 {
                    phase -= 1.0;
                }
                frame.fill(v);
            }
        },
        |err| eprintln!("stream error: {err}"), // stderr is logged by Electron main
        None,
    )?;
    stream.play()?;

    reply(out, json!({ "event": "ready", "sampleRate": sr, "channels": ch, "device": device.id()?.to_string() }));

    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                reply(out, json!({ "id": null, "ok": false, "message": e.to_string() }));
                continue;
            }
        };
        let id = v.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let cmd: Cmd = match serde_json::from_value(v) {
            Ok(c) => c,
            Err(e) => {
                reply(out, json!({ "id": id, "ok": false, "message": e.to_string() }));
                continue;
            }
        };
        match cmd {
            Cmd::Play => shared.playing.store(true, Relaxed),
            Cmd::Stop => shared.playing.store(false, Relaxed),
            Cmd::SetFreq { hz } => shared.freq.store(hz.clamp(20.0, 20_000.0).to_bits(), Relaxed),
            Cmd::SetGain { gain } => shared.gain.store(gain.clamp(0.0, 1.0).to_bits(), Relaxed),
            Cmd::Shutdown => {
                reply(out, json!({ "id": id, "ok": true }));
                return Ok(());
            }
        }
        reply(out, json!({ "id": id, "ok": true }));
    }
    Ok(()) // stdin closed: parent is gone
}
```

### Step 4: Build and smoke test (PowerShell, silent)
```powershell
cargo build --release --manifest-path engine/Cargo.toml   # from repo root; root .cargo/config.toml applies
'{"id":1,"cmd":"setGain","gain":0}','{"id":2,"cmd":"bogus"}','{"id":3,"cmd":"shutdown"}' |
  .\engine\target\release\krypt-engine.exe
# {"channels":2,"device":"wasapi:{0.0.0.00000000}.{…}","event":"ready","sampleRate":48000.0}
# {"id":1,"ok":true}
# {"id":2,"message":"unknown variant `bogus`, expected one of `play`, …","ok":false}
# {"id":3,"ok":true}
Select-String -Path .\engine\target\release\krypt-engine.exe -Pattern VCRUNTIME140 -SimpleMatch -Quiet  # must be False
```

### Step 5: `electron/system/engineSupervisor.ts` (tested under Node 24 type-stripping [M])
```ts
// electron/system/engineSupervisor.ts: pure Node, no 'electron' import (unit-testable).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';

export type Result<T = unknown> = { ok: boolean; message: string; data?: T };
export type EngineEvent = { event: string; [k: string]: unknown };
type Pending = { resolve: (r: Result) => void; timer: NodeJS.Timeout };

export class EngineSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private crashTimes: number[] = [];
  private stopping = false;
  private resolveExe: () => string;
  private onEvent: (ev: EngineEvent) => void;
  private log: (line: string) => void;

  constructor(resolveExe: () => string, onEvent: (ev: EngineEvent) => void,
              log: (line: string) => void = () => {}) {
    this.resolveExe = resolveExe; this.onEvent = onEvent; this.log = log;
  }

  start(): Result {
    if (this.child) return { ok: true, message: 'Engine already running' };
    let exe: string;
    try { exe = this.resolveExe(); }
    catch (e) { return { ok: false, message: `Engine path error: ${(e as Error).message}` }; }
    if (!fs.existsSync(exe)) return { ok: false, message: `Engine binary missing: ${exe}` };
    this.stopping = false;
    // NOT detached: libuv puts the child in a kill-on-close Job Object,
    // so the engine dies with us even if Electron is force-killed.
    const child = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (l) => this.onLine(l));
    createInterface({ input: child.stderr }).on('line', (l) => this.log(`[engine] ${l}`));
    child.on('error', (e) => this.log(`[engine] spawn error: ${e.message}`));
    child.on('exit', (code, signal) => this.onExit(code, signal));
    return { ok: true, message: 'Engine started' };
  }

  request(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 2000): Promise<Result> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.resolve({ ok: false, message: 'Audio engine is not running' });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, message: `Engine timed out on "${cmd}"` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  /** Graceful stop; resolves only after the process has exited (so start() can follow). */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    await this.request('shutdown', {}, 1000);
    child.stdin.end(); // EOF also makes the engine exit
    const killTimer = setTimeout(() => child.kill(), 1500);
    await exited;
    clearTimeout(killTimer);
  }

  private onLine(line: string): void {
    let msg: { id?: number | null; ok?: boolean; message?: string; event?: string };
    try { msg = JSON.parse(line); } catch { this.log(`[engine] bad line: ${line}`); return; }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve({ ok: !!msg.ok, message: msg.message ?? (msg.ok ? 'OK' : 'Engine error'), data: msg });
    } else if (msg.event) {
      this.onEvent(msg as EngineEvent);
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, message: 'Audio engine exited' }); }
    this.pending.clear();
    if (this.stopping) return;
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < 60_000).concat(now);
    this.onEvent({ event: 'crashed', code, signal, count: this.crashTimes.length });
    if (this.crashTimes.length > 3) {
      this.onEvent({ event: 'gaveUp', message: 'Audio engine crashed 4 times in 60 s' });
      return;
    }
    const delay = 250 * 2 ** (this.crashTimes.length - 1); // 250, 500, 1000 ms
    setTimeout(() => {
      const r = this.start();
      this.onEvent({ event: r.ok ? 'restarted' : 'restartFailed', message: r.message });
    }, delay);
  }
}
```
Measured test sequence: start → setGain → setFreq → bogus (correlated error) → kill child →
auto-restart → stop → start → stop. Events: `ready, crashed, restarted, ready, ready`. No orphans.

### Step 6: `electron/system/engine.ts` (Electron glue)
```ts
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { EngineSupervisor, type EngineEvent, type Result } from './engineSupervisor';

const EXE = 'krypt-engine.exe';

function builtExe(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'engine', EXE)                // extraResources
    : path.join(app.getAppPath(), 'engine', 'target', 'debug', EXE); // watchexec dev build
}

// Dev only: run a shadow copy so `cargo build` can overwrite the original (os error 5 otherwise).
function launchPath(): string {
  const src = builtExe();
  if (app.isPackaged) return src;
  const dir = path.join(app.getPath('temp'), 'krypt-engine-shadow');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `krypt-engine-${Math.trunc(fs.statSync(src).mtimeMs)}.exe`);
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  return dst;
}

function broadcast(ev: EngineEvent): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('engine:event', ev); // house §6
}

export const engine = new EngineSupervisor(launchPath, broadcast, (l) => console.log(l));

export function initEngine(): Result {
  const r = engine.start();
  if (!app.isPackaged) watchDevBuild();
  // On quit nothing else is needed: stdin EOF + libuv's job object end the engine.
  return r;
}

function watchDevBuild(): void {
  const dir = path.dirname(builtExe());
  if (!fs.existsSync(dir)) return;
  let t: NodeJS.Timeout | undefined;
  fs.watch(dir, (_e, file) => {
    if (file !== EXE) return;
    clearTimeout(t);
    t = setTimeout(async () => {
      await engine.stop();
      broadcast({ event: 'reloaded', message: engine.start().message }); // renderer re-pushes state
    }, 400);
  });
}
```
Call `initEngine()` from `main.ts` after `app.whenReady()` and toast a failed `Result`.

### Step 7: IPC (house §4.3/§4.4: one `ipc.ts`, typed preload, cleanup-returning subscriptions)
```ts
// electron/ipc.ts
ipcMain.handle('engine:play',    () => engine.request('play'));
ipcMain.handle('engine:stop',    () => engine.request('stop'));
ipcMain.handle('engine:setFreq', (_e, hz: number) => engine.request('setFreq', { hz }));

// electron/preload.ts  (inside contextBridge.exposeInMainWorld('krypt', { ... }))
engine: {
  play:    () => ipcRenderer.invoke('engine:play'),
  stop:    () => ipcRenderer.invoke('engine:stop'),
  setFreq: (hz: number) => ipcRenderer.invoke('engine:setFreq', hz),
  onEvent: (cb: (ev: EngineEvent) => void) => {
    const h = (_: unknown, ev: EngineEvent) => cb(ev);
    ipcRenderer.on('engine:event', h);
    return () => ipcRenderer.removeListener('engine:event', h);
  },
},
```
Put `Result` and `EngineEvent` in `shared/types.ts` and declare them in `global.d.ts`. The renderer
calls `window.krypt.engine.play()` and toasts `message`.

### Step 8: `package.json` (extends house §7.1)
```json
{
  "scripts": {
    "engine:build": "cargo build --release --locked --manifest-path engine/Cargo.toml",
    "engine:watch": "watchexec -w engine -e rs,toml -- cargo build --manifest-path engine/Cargo.toml",
    "dev": "concurrently -k -n engine,app \"npm:engine:watch\" \"vite\"",
    "dist": "npm run engine:build && npm run build && electron-builder"
  },
  "build": {
    "extraResources": [
      { "from": "engine/target/release/krypt-engine.exe", "to": "engine/krypt-engine.exe" }
    ]
  }
}
```
Run every cargo command **from the repo root** so the root `.cargo/config.toml` applies. Vite needs no
config change for the sidecar (nothing native is imported).

### Step 9: Dist and verify
`npm run dist`, install, then: play the sine, quit, and check that Task Manager shows no
`krypt-engine.exe`. Kill the engine in Task Manager and confirm it comes back. Run
`Get-AuthenticodeSignature` on every exe once signing is set up. Then run the §8 checklist.

### Appendix: the napi-rs variant (if agent 6 picks in-process)
- `engine-napi/Cargo.toml`: `[lib] crate-type = ["cdylib"]`, `napi = "3"`, `napi-derive = "3"`,
  `[build-dependencies] napi-build`, and `build.rs` → `napi_build::setup()`. Choose the Node-API level
  for Electron 44 (Node 24). napi-rs v3 needs **Rust ≥ 1.88** **[V]**.
- `cpal::Stream` must live on a **dedicated engine thread** that owns it. The `#[napi]` class sends
  commands over an `rtrb`/channel. Meter events go back via a (v3, rewritten) `ThreadsafeFunction` at
  ≤ 60 Hz. Never call into JS from the audio callback.
- Build: `npx @napi-rs/cli build --platform --release` (CLI 3.10.8; `napi new` templates are
  yarn/pnpm-only **[V]**, so hand-roll the npm config, and check `napi build --help` for v3 flags).
  Output: `<name>.win32-x64-msvc.node`.
- Vite: `rollupOptions.external: [/\.node$/]`. Load with `createRequire(import.meta.url)(absPath)`,
  where `absPath` = `process.resourcesPath/engine/...` when packaged.
- Package: put the `.node` in `extraResources` (preferred) or `asarUnpack: ["**/*.node"]`.
- CI smoke: `ELECTRON_RUN_AS_NODE=1 npx electron -e "require('./native/krypt_engine.win32-x64-msvc.node')"`.
- Dev loop: every engine rebuild means **restarting Electron**. A loaded `.node` can't be unloaded,
  and the locked file can't be overwritten (shadow-copy helps with the lock, not the unload).

---

## 8. Packaging checklist: proposed §14.4 "Audio / native-engine tools: add"

- [ ] Engine binaries import **no `VCRUNTIME140.dll`** (CI assertion). `+crt-static` sits in the **repo-root** `.cargo/config.toml`, and no CI `RUSTFLAGS` overrides it
- [ ] Engine spawned by **absolute path** (`process.resourcesPath` when packaged), `windowsHide: true`, **never `detached`**
- [ ] Quit normally **and** kill `Krypt Studio.exe` in Task Manager: `krypt-engine.exe` is gone within 1 s
- [ ] Kill `krypt-engine.exe` mid-playback: it restarts within about 1 s, project state is re-sent, and a toast appears. Four crashes in 60 s give the "Engine stopped / Restart" banner, not a loop
- [ ] Unplug the USB interface mid-playback: "device lost" toast, no hang, re-select works after replug. Change the default device **and** the default format in Sound control panel while playing: the stream recovers
- [ ] Exclusive mode: browser/Discord silence is explained in the UI. When another app holds the device exclusively, a clear toast appears (`AUDCLNT_E_DEVICE_IN_USE`). With "Allow exclusive control" off, the app falls back to shared
- [ ] Low-latency shared mode shows the **real** driver minimum period (`GetSharedModeEnginePeriod`), not a hard-coded list
- [ ] 30 min playback at the smallest offered buffer with a YouTube video playing: engine xrun counter = 0. Minimized for 10 min: no dropouts
- [ ] The renderer never creates an `AudioContext`/`<audio>`. `midi`/`midiSysex` permissions are denied by default
- [ ] Bluetooth output selected: latency warning shown. Battery saver on: performance hint shown
- [ ] Volume Mixer and Task Manager show **"Krypt Studio Audio Engine"** with the Krypt icon (version resource + session display name)
- [ ] `powerSaveBlocker` active **only** while playing, recording or exporting
- [ ] MIDI on **Win10**: a port held by another app shows a toast with no crash; virtual-port test via loopMIDI. On **Win11 24H2+**: same port open in KryptStudio **and** another app at once
- [ ] ASIO build only: Steinberg proprietary agreement signed and filed. "ASIO is a trademark and software of Steinberg Media Technologies GmbH" in Licenses. No "ASIO" in product names. Tested with a vendor driver, ASIO4ALL and FlexASIO. Driver panel buffer change handled. SDK not committed to the repo
- [ ] Export round-trip: WAV 16/24/32f (16-bit dithered), FLAC, MP3 (MF), OGG, Opus re-imported via symphonia. LUFS matches a reference within 0.1 LU. `smpl`/`acid` root key and tempo survive
- [ ] On a Windows **N** edition (or with MF unavailable), MP3/AAC export shows "install the Media Feature Pack". It never fails silently
- [ ] `cargo deny check licenses` passes (no GPL/AGPL/LGPL-static). `THIRD_PARTY_NOTICES` generated for Rust and npm, including MPL-2.0 entries (symphonia, audio_thread_priority) with source links
- [ ] **Every PE signed and timestamped** (installer, uninstaller, app exe, engine exe, any `.node`/`.dll`), verified with `Get-AuthenticodeSignature` over `release\win-unpacked`
- [ ] Clean **Win11 VM** with Smart App Control on, and a clean Win10 VM: install, launch, sine plays. Defender full scan of the installer and install dir is clean. Release binaries submitted to Microsoft for FP pre-clearance
- [ ] Installer ≤ 160 MB. No PDBs and no sample content in the core installer
- [ ] Uninstall leaves no engine process, no shadow copies and no `%TEMP%\krypt-engine-shadow` (dev-only path, never used when packaged)

---

## 9. Failure signatures (house style)

| Symptom | Root cause | Fix |
|---|---|---|
| Clean PC: "The code execution cannot proceed because VCRUNTIME140.dll was not found" (engine) | Rust MSVC links the CRT dynamically by default **[M]**. `engine/.cargo/config.toml` is ignored when cargo runs from the repo root with `--manifest-path` **[M]**, and `RUSTFLAGS` env overrides config rustflags **[M]** | `+crt-static` in the **repo-root** `.cargo/config.toml`, plus a CI grep for `VCRUNTIME140` |
| `failed to remove file …\krypt-engine.exe … Access is denied. (os error 5)` during `engine:watch` | Windows locks a running exe **[M]** | Dev supervisor spawns a **shadow copy** and restarts on rebuild |
| `spawn krypt-engine.exe ENOENT` in packaged build | Bare name or dev path; packaged PATH is stripped (house §5.1) | `path.join(process.resourcesPath,'engine','krypt-engine.exe')` + `extraResources` |
| Orphan `krypt-engine.exe` after quit | Spawned with `detached: true`, which escapes libuv's kill-on-close job **[M]** | Never `detached`. The engine also exits on stdin EOF |
| Engine vanishes: no WER dialog, no dump | libuv job sets `DIE_ON_UNHANDLED_EXCEPTION` **[V]** | Log exit code/stderr, add an in-engine minidump writer, keep PDBs |
| Engine timed out on every request after a stop→start | `start()` ran before the old child's `exit` fired ("already running") | `stop()` awaits `exit` (fixed in recipe) |
| Packaged app: `Cannot find module …\*.node` (napi variant) | `.node` inside asar or bundled by Rollup | `rollupOptions.external` + `extraResources`/`asarUnpack` (uiohook lesson) |
| Electron crashes or throws on `koffi.view()` / external `ArrayBuffer` | V8 memory cage forbids off-heap ArrayBuffers **[V]** | Copy into a `Buffer` (`RtlMoveMemory` via koffi, or `napi_create_buffer_copy`) |
| `AUDCLNT_E_DEVICE_INVALIDATED` (0x88890004) after unplug or format change | Endpoint removed or reconfigured **[V]** | Release all WASAPI objects, re-enumerate, re-activate, resume transport |
| `AUDCLNT_E_DEVICE_IN_USE` (0x8889000A) | Another app (or our own renderer's Chromium audio) holds the endpoint in exclusive mode, or holds it while we request exclusive | Toast which app/mode. Renderer never plays audio. Offer shared low-latency |
| `AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED` (0x8889000E) | User unchecked "Allow applications to take exclusive control" | Fall back to shared + explain |
| `AUDCLNT_E_ENGINE_PERIODICITY_LOCKED` | Another app already runs the engine at a different small period **[V]** | `GetCurrentSharedModeEnginePeriod` and adopt it |
| "Low latency" option shows only 10 ms | OEM driver doesn't declare small packet sizes **[V]** | Show the real min. Suggest the inbox HDAudio driver, ASIO, or an interface |
| Browser/Discord go silent while KryptStudio runs | Exclusive WASAPI or ASIO4ALL (KS exclusive) | Expected. Say so in the UI. Default to shared low-latency |
| Volume drops ~80% when a Discord call starts | Windows communications ducking **[E]** | `IAudioSessionControl2::SetDuckingPreference(TRUE)` |
| CPU spikes or crackles on reverb/filter tails and silence | Denormals | `no_denormals` guard in every callback (incl. the ASIO thread) + tiny DC offset in feedback |
| Crackles only in `npm run dev` | Rust debug build DSP | `[profile.dev] opt-level=1`, deps at 3 |
| Crackles when minimized or on battery | EcoQoS/power plan/E-cores **[V/E]** | Opt engine threads out of power throttling. MMCSS "Pro Audio". Battery-saver banner |
| ASIO build: `Unable to find libclang` / bindgen panic | LLVM missing (dev box has none **[M]**) or `LIBCLANG_PATH` unset | `winget install LLVM.LLVM`; `setx LIBCLANG_PATH "C:\Program Files\LLVM\bin"`; run from a VS dev prompt if vcvars isn't found |
| ASIO driver list empty | cpal built without `asio`, or host not selected | `features=["asio"]` + `host_from_id(HostId::Asio)` |
| ASIO "driver could not be initialized" while another DAW is open | Most ASIO drivers are single-client **[E]** | Toast "close other audio apps or pick WASAPI" |
| MIDI keyboard works in another app but not KryptStudio (Win10) | WinMM single-client. Another app, or **our own renderer's Web MIDI**, holds the port **[V: Chromium uses WinMM]** | Deny `midi` permission. Toast the conflict. Win11 24H2+ MIDI Services is multi-client |
| No virtual MIDI ports offered on Windows | midir can't create virtual ports on Windows **[V]** | loopMIDI on Win10. MIDI Services loopback endpoints on Win11 |
| MP3 export: class not registered / codec not found | Windows N edition without the Media Feature Pack | Detect and show an install hint. LAME DLL fallback later |
| CI engine tests panic "no default output device" | Hosted runners have no audio endpoint **[E]** | `--offline`/null backend for tests and export |
| SmartScreen "Windows protected your PC", or Smart App Control block | Unsigned or low-reputation binaries | Artifact Signing ($9.99/mo, US/CA individuals) + timestamp. Reputation builds over time |
| Defender quarantines `krypt-engine.exe` (`…!ml`) | New, unsigned, low-prevalence exe that spawns processes and opens pipes **[E]** | Sign everything, no packers, submit for FP review before release |
| Volume Mixer shows "krypt-engine.exe" with a blank icon | No version resource or session display name | Embed FileDescription and icon. `SetDisplayName`/`SetIconPath` on the session |

---

## 10. Open items and what I couldn't verify (budget ran out)

- **Measured round-trip latencies** for each path (all **[E]** above). Do a one-day measurement pass
  with a loopback cable on the dev box plus one USB interface.
- The exact **Steinberg proprietary ASIO submission process** (page is JS-rendered). A human should
  read `steinberg.net/developers/` and file the agreement before any ASIO build ships.
- **REX Shared Library** current terms (dev site is JS-rendered).
- **AAC patent status.** Prefer Media Foundation for AAC decode/encode to sidestep it.
- Whether electron-builder 26.x signs `extraResources` executables automatically (verify with
  `Get-AuthenticodeSignature`).
- Smart App Control behavior with Artifact Signing certificates on a fresh Win11 install.
- Whether `utilityProcess` gets any background priority demotion from Chromium (relevant only to
  the napi-in-utilityProcess hybrid).

---

## 11. Sources

**Microsoft (audio, MIDI, scheduling, power, signing)**
- Low Latency Audio (Windows drivers): https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/low-latency-audio
- IAudioClient3: https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nn-audioclient-iaudioclient3
- GetCurrentSharedModeEnginePeriod: https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient3-getcurrentsharedmodeengineperiod
- windows-rs IAudioClient3: https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Media/Audio/struct.IAudioClient3.html
- Recovering from an Invalid-Device Error: https://learn.microsoft.com/en-us/windows/win32/coreaudio/recovering-from-an-invalid-device-error
- MMCSS: https://learn.microsoft.com/en-us/windows/win32/procthread/multimedia-class-scheduler-service
- AvSetMmThreadCharacteristicsW: https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avsetmmthreadcharacteristicsw
- SetProcessInformation: https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation
- SetThreadInformation: https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-setthreadinformation
- timeBeginPeriod: https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod
- Quality of Service (EcoQoS): https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/ProcThread/quality-of-service.md
- MF MP3 Audio Encoder: https://learn.microsoft.com/en-us/windows/win32/medfound/mp3-audio-encoder
- Windows MIDI Services GA blog (2026-02-17): https://blogs.windows.com/windowsexperience/2026/02/17/making-music-with-midi-just-got-a-real-boost-in-windows-11/
- Windows MIDI Services customer preview: https://devblogs.microsoft.com/windows-music-dev/announcing-windows-midi-services-customer-preview-1/
- MIDI.org on Windows 11 MIDI 2.0: https://midi.org/midi-2-0-coming-to-windows-11
- heise (24H2/25H2 only): https://heise.de/-11181074
- SonicState (Win10 users excluded): https://sonicstate.com/news/2026/04/02/windows11-midi-updates-add-20-multi-clients/
- Windows 10 ESU: https://www.microsoft.com/en-us/windows/extended-security-updates
- Artifact Signing quickstart (eligibility): https://learn.microsoft.com/azure/artifact-signing/quickstart
- Artifact Signing pricing: https://azure.microsoft.com/en-us/pricing/details/artifact-signing/
- DevClass on Artifact Signing GA/pricing: https://devclass.com/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/
- IT Writing hands-on (3-day certs, $9.99): https://www.itwriting.com/blog/?p=12462
- Code signing options for Windows apps: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- Defender false-positive submission (URL from memory, not re-verified today): https://www.microsoft.com/en-us/wdsi/filesubmission

**Steinberg / ASIO**
- Steinberg press release, 2025-10-15: https://ocl-steinberg-live.steinberg.net/_storage/asset/808575/storage/master/Press%20Release%20-%202025-10-15%20-%20OBS%20Partnership-%20EN.pdf
- Recording Magazine: https://www.recordingmag.com/news/new-asio-open-source-license-paves-way-for-obs-partnership/
- heise (ASIO GPLv3 variant, VST 3.8 MIT): https://heise.de/-10963451
- Wikipedia ASIO (free, signed agreement): https://en.wikipedia.org/wiki/Audio_Stream_Input/Output
- ASIO SDK 2.3.4 README mirror (dual licensing/trademark text; unofficial): https://zff.dev/rubiefawn/asiosdk
- Steinberg forum, proprietary agreement submission: https://forums.steinberg.net/t/where-do-i-submit-the-proprietary-asio-sdk-license-agreement/1035889
- FlexASIO: https://github.com/dechamps/FlexASIO (README, LICENSE.txt)
- ASIO4ALL 2.16: https://asio4all.org/version-2-16-released/
- Steinberg vst3sdk (MIT): https://github.com/steinbergmedia/vst3sdk

**Rust crates**
- cpal 0.18.2 docs: https://docs.rs/crate/cpal/latest. Changelog: https://github.com/RustAudio/cpal/blob/master/CHANGELOG.md. Source read: `src/host/wasapi/{stream,device}.rs`, `src/host/com.rs`
- asio-sys: https://docs.rs/crate/asio-sys/0.4.0
- audio_thread_priority (Windows MMCSS "Audio"): https://github.com/mozilla/audio_thread_priority/blob/master/src/rt_win.rs
- wasapi: https://docs.rs/crate/wasapi/latest and https://docs.rs/wasapi/latest/wasapi/struct.AudioClient.html
- midir: https://docs.rs/crate/midir/latest. midly: https://docs.rs/crate/midly/latest. wmidi: https://docs.rs/crate/wmidi/latest
- Symphonia: https://github.com/pdeljanov/Symphonia. 0.6 overview: https://heise.de/-11294999
- `_mm_setcsr` deprecation: https://doc.rust-lang.org/core/arch/x86_64/fn._mm_setcsr.html. no_denormals: https://docs.rs/no_denormals
- cargo-watch status: https://docs.rs/cargo-watch
- napi-sys dynamic symbol loading: https://codebrowser.dev/slint/crates/napi_sys/src/lib.rs.html
- Licenses and versions: crates.io API, `https://crates.io/api/v1/crates/<name>` (queried 2026-10-11)

**Electron / Node / Chromium**
- Native modules in Electron: https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
- V8 memory cage: https://www.electronjs.org/blog/v8-memory-cage
- koffi external buffers: https://koffi.dev/pointers
- Electron versions: https://endoflife.date/electron
- session permissions (midi/midiSysex): https://github.com/electron/electron/blob/main/docs/api/session.md
- webPreferences.backgroundThrottling: https://github.com/electron/electron/blob/main/docs/api/structures/web-preferences.md
- utilityProcess: https://github.com/electron/electron/blob/main/docs/api/utility-process.md
- powerSaveBlocker: https://electronjs.org/docs/latest/api/power-save-blocker
- libuv Windows process/job object: https://github.com/libuv/libuv/blob/v1.x/src/win/process.c
- Chromium Web MIDI features (WinRT off by default): https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/midi/midi_features.cc
- napi-rs getting started: https://napi.rs/docs/introduction/getting-started. v2→v3: https://napi.rs/docs/more/v2-v3-migration-guide
- electron-builder Windows signing: https://www.electron.build/docs/features/code-signing/code-signing-win
- electron-builder WindowsConfiguration (signExts): https://www.electron.build/docs/api/app-builder-lib.Interface.WindowsConfiguration
- SignPath Foundation terms: https://signpath.org/terms

**CI**
- windows-latest → Server 2025: https://github.blog/changelog/2025-07-31-github-actions-new-apis-and-windows-latest-migration-notice/
- VS 2026 image migration: https://github.blog/changelog/2026-05-14-github-actions-upcoming-image-migrations
- Windows 2025 image contents: https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md

**Formats**
- WAVE format notes (fact chunk, extensible): https://www.mmsp.ece.mcgill.ca/Documents/AudioFormats/WAVE/WAVE.html
- libsndfile `wav.c` (smpl/acid layout reference only): https://github.com/libsndfile/libsndfile/blob/master/src/wav.c
- LAME license FAQ (mirror): https://git.stg.centos.org/source-git/lame/blob/7bd683b8c4e7d3e82281cdedbf944aac0c8d6119/f/LICENSE

**Measured locally (2026-10-11, dev box):** hello-sine sidecar build (cpal 0.18.2, 466 KB static-CRT
exe vs 364 KB dynamic with `VCRUNTIME140.dll` + `api-ms-win-crt-*` imports). `--manifest-path` ignoring
`engine/.cargo/config.toml`. Cargo `os error 5` on a running exe. Node 24.18 non-detached child killed
on parent exit and on `Stop-Process -Force`, while the detached child survived. Supervisor
RPC/crash-restart/stop-start test. Krypt Macro installer = 104 MB.
