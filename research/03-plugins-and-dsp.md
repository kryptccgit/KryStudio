# 03 - Plugin Hosting and Stock DSP

| | |
|---|---|
| Project | KryptStudio (see naming note) |
| Topic | Third-party plugin hosting (Part A) and our own stock instruments and effects (Part B) |
| Date | 2026-10-11 |
| Status | Research, before any prototype |
| Depends on | 01/02 engine research (Rust engine assumed), MCP research |

> **Naming note.** `kryptguidelines.md` section 12 says product names are `Krypt <Tool>` with a space, and lists run-together forms like `KryptMacro` under "Never". Under that rule the product is **Krypt Studio**, the exe and npm name is `krypt-studio`, and the app ID is `cc.krypt.studio`. This doc says "KryptStudio" only because the brief does. Process names below use the kebab form.

> **How this was verified.** Every license and version below was checked on 2026-10-11 against a primary or near-primary source (repo LICENSE/README, crates.io API, vendor docs or press release), unless it is marked *(memory, re-verify)*. The session's shared web-search budget ran out partway through. The remaining checks were done by fetching known primary URLs directly. Engineering estimates are labelled as estimates.

---

## 0. Decisions at a glance

1. **Formats: VST3 and CLAP at launch. No VST2.** Steinberg no longer issues VST2 licences. The only clean-room VST2 header (FST) is GPL-3.0-or-later. No AU, AAX or LV2 on Windows.
2. **The VST3 SDK is MIT now.** VST 3.8.0 (2025-10-20) moved it to MIT, and 3.8.1 (2026-08-11) is current. The README says GPLv3 and the proprietary licence "is no longer available". Because of this, the Rust `vst3` crate (MIT OR Apache-2.0) now ships pre-generated bindings. The old GPL problem for Rust VST3 code is gone, as long as we avoid `vst3-sys`, which is still GPLv3.
3. **The ASIO SDK has been dual-licensed, proprietary or GPLv3, since 2025-10-15.** We have to take the **proprietary** option, because the GPLv3 option makes the shipped binary GPL. The SDK must not go into the MIT repo; CI fetches it.
4. **All third-party plugins run out of process**, in `krypt-studio-pluginhost.exe`, written in Rust: `clack-host` for CLAP and the `vst3` crate for VST3. The default mode is one shared sandbox, and any plugin can be switched to its own process. IPC is synchronous within the same audio cycle over shared memory, so it **adds no latency**. The cost is CPU time for context switches, plus RAM.
5. **A separate scanner process** keeps a cache, a crash journal ("dead man's pedal") and a blocklist. VST3 plugins that ship `moduleinfo.json` take a fast path that never loads the binary.
6. **Plugin GUIs: native top-level windows created by the plugin-host process and *owned* by the Electron BrowserWindow's HWND.** These are floating windows in the style of Bitwig and REAPER. We do not dock native windows inside the web UI at launch. Every plugin also gets a React generic parameter editor, and that editor is the surface MCP agents use.
7. **Stock plugins are framework-free Rust DSP crates, run as engine-internal nodes with React UIs.** Exporting them later as CLAP/VST3 goes through `nice-plug` (ISC, now on the MIT `vst3` crate) or `clack-plugin` plus `clap-wrapper` (MIT). Don't start on `nih-plug`: it is in maintenance mode and its VST3 bindings are GPLv3.
8. **Build stock DSP on** Airwindows, Signalsmith DSP and Stretch, DaisySP (core only), Cycfi Q, fundsp, CloudSeedCore, msfa (Apache-2.0 DX7 engine), Mutable Instruments' STM32 code, rustysynth and AKWF waveforms.
   **Avoid** synfx-dsp (it is **GPL-3.0-or-later**, not permissive as the brief assumed), most of `sst-*`, the chowdsp DSP modules, Rubber Band, FluidSynth/oxisynth, and the GPL reverbs inside Faust's libraries.

---

## 1. Licensing table

### 1.1 SDKs, host libraries, plugin frameworks

| Component | Version / status (checked 2026-10-11) | License | Usable in MIT KryptStudio? | Notes |
|---|---|---|---|---|
| **VST3 SDK** (Steinberg) | 3.8.1, released 2026-08-11. 3.8.0 (2025-10-20) was the release that relicensed it | **MIT** | **Yes** | README: "VST 3 SDK is under MIT license… Licensing under GPLv3 and the Steinberg proprietary license is no longer available." 3.8 added IMidiLearn2/IMidiMapping2. 3.8.1 added ITransportControl and MIDI 2.0 note-expression IDs. The "VST" name and logo are still trademarks, so follow Steinberg's logo rules. |
| **ASIO SDK** (Steinberg) | 2.3.4 | **Dual: proprietary or GPLv3** (since 2025-10-15) | **Yes, proprietary option only** | GPLv3 would force the whole shipped binary to GPL. Under the proprietary licence we redistribute only binaries. Keep the SDK out of the public repo and download it in CI, the way cpal's `asio-sys` does. I could not read the proprietary agreement PDF itself, so legal should read it before 1.0. |
| **VST2 SDK** | Discontinued. Steinberg grants no new licences and says a licence is needed even for internal use | Proprietary | **No** | The clean-room header **FST** is GPL-3.0-or-later and unusable for us. The "VeSTige" header (LMMS) is GPL *(memory)*. VST3's `moduleinfo.json` "Compatibility" field lets a VST3 replace a VST2 class ID, which helps project migration. |
| **CLAP** (free-audio/clap) | 1.2.10 is the newest ChangeLog entry (no dates shown). Wikipedia lists 1.2.6, 2025-03-11, as a stable release | **MIT** | **Yes** | Recent drafts: `webview` (1.2.7), `background-*`, `param-origin`, `transport-control` (1.2.9), `param-hovered` (1.2.10). |
| **`vst3` crate** (coupler-rs/vst3-rs) | 0.3.0, 2025-12-07 | **MIT OR Apache-2.0** | **Yes** | Since 0.3.0, bindings are pre-generated and shipped in the crate, so there's no libclang or SDK at build time. It is raw and unsafe: `ComPtr`, `ComRef`, `ComWrapper` and a `Class` trait. It has no host helpers. |
| **`vst3-sys`** (RustAudio) | Maintained | **GPLv3** | **No** | Declares itself a derivative of the old GPL SDK. Superseded for our purposes. |
| **clack** (`clack-host`, `clack-plugin`, `clack-extensions`) | 0.2.0, 2026-09-12. First crates.io release 0.1.0 on 2026-05-03 | **MIT OR Apache-2.0** | **Yes** | Safe wrappers. Covers "all the standard and stable CLAP extensions". The cpal host example opens floating or embedded GUIs. Pre-1.0, so expect API churn. |
| **nih-plug** (robbert-vdh) | **Maintenance mode** | ISC framework, but its **VST3 bindings are GPLv3** (vst3-sys) | **No** for VST3 export | Its README points to the community fork. |
| **nice-plug** (community fork, codeberg BillyDM/nih-plug) | 0.4.2, 2026-09-14. Its README calls it "experimental" | **ISC** | **Yes** | Depends on `vst3 ^0.3.0` (MIT), not vst3-sys, so the GPL issue is fixed. Plus `clap-sys ^0.5`. Has egui/iced/vizia adapters and standalone builds. |
| **clap-wrapper** (free-audio) | Active, no tagged releases | **MIT** | **Yes** | Wraps a CLAP plugin as VST3, AUv2, AUv3, AAX or a standalone app. You supply the VST3 SDK path (MIT now). AAX SDK is GPL3 or commercial, which we don't need. |
| **clap-host** (free-audio reference host, C++/Qt) | Active | **MIT** | Yes, as reference code | We wouldn't ship Qt. |
| **clap-validator** | Active | **MIT** | Yes (CI) | Validator plus multi-process fuzzer. |
| **pluginval** (Tracktion) | Active | **GPLv3** | **CI tool only, never shipped** | Runs headless in CI and exits 0/1. Tests VST/AU/VST3 but not CLAP. |
| **JUCE** | JUCE 9 licence is current | **AGPLv3 or commercial** (Starter is free up to $20k/yr revenue) | **No** | Under AGPL the whole app becomes AGPL. A commercial licence isn't MIT-compatible for forks. |
| **Tracktion Engine, Carla** | — | GPL / commercial *(memory, re-verify)* | **No** | Carla's bridge design is still worth studying. |
| **iPlug2** | Active (iPlug2OOS recommended for new projects) | zlib-like (WDL) | Yes | A C++ plugin framework, not a host. |
| **DPF** (DISTRHO) | Active | **ISC** | Yes | A C++ plugin framework covering VST2/VST3/CLAP/LV2. |
| **visage** (VitalAudio) | Active | **MIT** | Yes | GPU C++ UI library (D3D11 on Windows). Usable for native GUIs on exported plugins. |
| **wry** (Tauri) | Active | **MIT OR Apache-2.0** | Yes | WebView2 on Windows. Basis for web GUIs in exported plugins. |
| **nih-plug-webview** | Experimental. Windows support is "unverified" in its README | **ISC** | Yes, but not production-ready | — |

### 1.2 DSP libraries, sample players and content

| Library | Lang | Version / status | License (verified) | OK? | What we take |
|---|---|---|---|---|---|
| **Airwindows** | C++ | Repo is read-only and doesn't take PRs. Hundreds of plugins (site category counts: "Innovative (269)", "Filter (67)", "Reverb (50)") | **MIT** | **Yes** | Character effects (saturation, consoles, tape, clippers, reverbs), ported per plugin. |
| **airwin2rack / Airwindows Consolidated** registry | C++ | Active, ships CLAP/VST3/AU/LV2 | `src`, `libs/airwindows` and the registry are **MIT**. The JUCE/VST3/Rack builds pull in **GPL3** | Registry only | A uniform registry and docs for all Airwindows effects. Don't use `src-juce` or `src-rack` builds. |
| **Signalsmith DSP** | C++ header-only | v1.x | **MIT** | **Yes** | Delay lines, FFT, filters, envelopes, spectral tools, rates. |
| **Signalsmith Stretch** + `signalsmith-stretch` crate | C++ / Rust | crate 0.1.3, 2025-09-18 | **MIT** (both) | **Yes** | Polyphonic time-stretch and pitch-shift with formant shift and compensation. Used for audio clips, the slicer, pitch correction and Gross-Beat-like effects. |
| **DaisySP** | C++ | Active | **MIT**. The `DaisySP-LGPL` submodule is **LGPL** | Core only | Oscillators, ADSR, drum models (analog bass/snare, hi-hat), Karplus-Strong, modal, phaser, wavefolder, decimator, overdrive, granular player. |
| **Cycfi Q** | C++20 | v1.5.4 stable, v1.6 in development | **MIT** | **Yes** | BACF pitch detection ("sub-cent accuracy"), Moog/OTA ladders, SVF, peak/RMS envelope followers, compressor/expander/AGC, FM including a DX7 emulation. |
| **fundsp** | Rust | 0.23.0, 2026-01-07 | **MIT OR Apache-2.0** | **Yes** | Prototyping graph, PolyBLEP/wavetable oscillators, Simper SVF, Moog ladder, FDN reverbs. The backend is real-time safe once `allocate()` has run. |
| **valib** | Rust | Small project | Library in `src` is **MIT**. Plugins and examples are **GPLv3** | `src` only | VA biquad/SVF/ladder, saturators, oversampling. |
| **synfx-dsp** | Rust | 0.5.6, 2024-01-04 | **GPL-3.0-or-later** | **No** | The brief listed it as a candidate, but it's copyleft. |
| **Faust** | DSL compiles to C++/Rust | Active | Compiler: **GPL** per Wikipedia; COPYING headers show LGPL-2.1-or-later on some files. **Libraries: per-function licences.** For example, `reverbs.lib` has `jpverb`, `greyhole` and `valhallaSupermassive` as MIT; JOS functions such as `zita_rev1` and `dattorro_rev` as STK-4.3 (MIT-style); GRAME freeverb as LGPL with exception; **`vital_rev` and `kb_rom_rev1` as GPL-3.0-only**. Architecture files are per-file, and some carry a "FAUST exception" | **Yes as a build-time tool**, with a licence audit per function | Generated code follows the licences of the library functions you used. CI must audit every `declare license` in the generated code. |
| **Cmajor** | DSL | Active | **GPLv3+ or commercial.** "Generated C++ [from your own Cmajor code] is yours to use however you wish" | Codegen only, never embed the JIT | Low priority. |
| **sfizz** (SFZ sampler) | C++ | **Archived 2026-06-21, read-only** | **BSD-2-Clause**. Deps: abseil (Apache-2.0), hiir (WTFPL), KissFFT (BSD-3), pugixml (MIT), dr_libs (MIT-0), faust-libraries (STK/LGPL-variant). libsndfile is optional and LGPL, so skip it | Yes, but unmaintained | SFZ playback through its C API. We'd vendor and maintain our own fork, or write a Rust SFZ subset. |
| **FluidSynth** | C | Active | **LGPL-2.1** | Avoid | See section 3.2.4. |
| **oxisynth** (Rust FluidSynth port) | Rust | 0.1.0, 2025-05-25 | **LGPL-2.1** | Avoid | Static linking in Rust makes LGPL compliance awkward. |
| **rustysynth** | Rust | 1.3.7, 2026-10-01 | **MIT** | **Yes** | SF2 player and MIDI file playback, pure Rust, no dependencies. |
| **TinySoundFont** | C single header | Active (no-AI-contributions policy) | **MIT** | Yes (fallback) | SF2. |
| **CloudSeed / CloudSeedCore** | C# / C++ | Development moved to Ghost Note Audio | **MIT** | **Yes** | Lush algorithmic "huge space" reverb. Check CloudSeedCore's LICENSE file at vendoring time. |
| **Mutable Instruments eurorack** | C++ | Frozen | **STM32 code MIT. AVR code GPL-3.0.** Hardware CC-BY-SA-3.0 | STM32 modules only (confirm per folder) | Plaits macro-oscillator, Rings resonator, Elements, Clouds granular, Braids, Warps. |
| **music-synthesizer-for-android (msfa)** | C++ | Archived 2023-01-27 | **Apache-2.0** | **Yes** (keep NOTICE) | DX7-compatible FM core. Dexed's README: msfa "stays on the Apache 2.0 license". |
| **ymfm** (Aaron Giles) | C++ | Stable | **BSD-3-Clause** | Yes | OPL/OPL2/OPL3/OPN/OPM chip FM. For a retro "chip" mode. |
| **chowdsp_utils** | C++ | Active | **Per module.** Core, math, SIMD, buffers and serialization are BSD. **Filters, EQ, compressor, reverb, waveshapers and sources are GPLv3** | BSD modules only | SIMD and math helpers. The DSP modules are off-limits. |
| **sst-basic-blocks** (Surge) | C++ | Active | **GPL-3.0** overall. Only `LanczosResampler.h`, `HilbertTransform.h` and `EllipticBlepOscillators.h` are MIT | Those 3 headers only | Lanczos resampler, Hilbert transform, elliptic-BLEP oscillators. |
| **Bungee** (Parabola) | C++ | 2.4.x | **MPL-2.0** (file-level copyleft) | OK if its files stay unmodified MPL | An alternative time-stretcher. |
| **Rubber Band** | C++ | — | **GPL-2.0-or-later** or commercial | **No** | — |
| **pitch-estimate**, **pyin**, **pyin-rs** | Rust | Small crates | **MIT** | Yes (re-verify each at adoption) | MPM/YIN/pYIN pitch detection. |
| **rustfft** | Rust | 6.4.1 | MIT OR Apache-2.0 | Yes | FFT for analyzers, convolution, vocoder. |
| **rubato** | Rust | 5.0.1, 2026-10-01 | MIT OR Apache-2.0 | Yes | Sample-rate conversion. |
| **ebur128** | Rust | 0.1.10, 2024-10-26 | **MIT** | Yes | EBU R128 / LUFS metering. |
| **AKWF waveforms** | Content | — | **CC0-1.0** | **Yes** | About 4,300 single-cycle waves for 3xOsc and wavetable factory content. |

### 1.3 Popular open-source synths and effects we cannot reuse (copyleft)

| Project | License | Verified? | Clean-room lessons (ideas and UX only, never code) |
|---|---|---|---|
| **Surge XT** | GPL-3.0 | Yes | Scene/oscillator/FX architecture. Modulation-routing UX. Its `.wt` wavetable file layout is a documented interop format worth supporting. |
| **Vital** | GPL-3.0. Also bans use of the "Vital"/"Tytel" names for marketing, and its presets can't be redistributed | Yes | Wavetable editor UX, spectral and phase warp modes, drag-to-modulate UX. |
| **Dexed** | GPL-3.0 (but its **msfa engine is Apache-2.0**, which we can use) | Yes | DX7 cartridge (sysex) import. Six-operator algorithm display. |
| **Odin 2** | GPL-3.0 | Yes | Range of filter models (ladder, diode, SEM, Korg-35-style) and the patch-browser UX. |
| **Helm** | GPL-3.0 | Yes | A simple, readable subtractive layout. Good model for our 3xOsc++. |
| **OB-Xd** | GPL-3.0 (source up to 2.11) | Yes | Oberheim-style voice architecture and voice variation ("slop"). |
| **Vaporizer2** | GPL-3.0 | Yes | Wavetable plus multi-oscillator hybrid design. |
| **ZynAddSubFX** | GPL-2.0-or-later | Yes | PADsynth. The algorithm is published by its author, so it can be implemented from the description, not the code. |
| **Dragonfly Reverb** | GPL-3.0 (built on Freeverb3) | Yes | Room/hall/plate preset taxonomy. |
| **synfx-dsp / HexoSynth** | GPL-3.0-or-later | Yes | — |
| **chowdsp DSP modules** | GPL-3.0 | Yes | Waveshaper ADAA approach (also in public papers). |
| **Rubber Band** | GPL-2.0-or-later / commercial | Yes | — |
| LMMS (includes TripleOscillator, a 3xOsc clone), Ardour, Zrythm, Cardinal, Geonkick, x42 | GPL family | *(memory, re-verify)* | LMMS TripleOscillator is the closest open 3xOsc reference, so do not read its code. |
| LSP, Calf | LGPL family | *(memory, re-verify)* | — |

**Clean-room process.** Anyone who reads GPL source writes behaviour specs only: parameter lists, ranges, UX descriptions. Implementers never see that source. AI coding agents must never be given GPL source as context. Keep a provenance log per stock plugin: algorithm references and papers used. Add `cargo-deny` licence checks plus SPDX headers in CI.

---

## 2. Part A - Hosting third-party plugins

### 2.1 Format status and scope

| Format | Launch? | Why |
|---|---|---|
| VST3 | **Yes** | The dominant format on Windows, and the SDK is MIT since 3.8. |
| CLAP | **Yes** | MIT. Cleanest API: float-native parameters, sample-accurate events, per-note modulation, explicit thread rules. Native floating-window support (`set_transient`) suits an Electron host well. |
| VST2 | **No** | No licence obtainable, and clean-room headers are GPL. **This is a real product risk for FL users**, who own many legacy VST2 freebies. Revisit only with legal advice. |
| 32-bit plugins | Later (P3) | The out-of-process design makes a 32-bit `pluginhost-x86.exe` a natural extension, like FL's `ilbridge.exe`. |
| AU / AAX / LV2 | No | AU is macOS only. AAX requires Avid signing. LV2 has little Windows presence. |

Windows search paths:
- **VST3**, in priority order: `%LOCALAPPDATA%\Programs\Common\VST3\`, `C:\Program Files\Common Files\VST3\`, `C:\Program Files (x86)\Common Files\VST3\` (32-bit), `$APPFOLDER\VST3\`. Higher-priority locations win for the same processor UID.
- **CLAP**: `%COMMONPROGRAMFILES%\CLAP`, `%LOCALAPPDATA%\Programs\Common\CLAP`, plus the `CLAP_PATH` environment variable (`;`-separated, searched recursively). The spec says hosts *must* honour `CLAP_PATH`.
- User-added folders on top of both.

### 2.2 Host implementation options

| Option | Lang | License | Fit | Verdict |
|---|---|---|---|---|
| `clack-host` | Rust | MIT/Apache | Safe, complete CLAP host API with a GUI example (floating and embedded) | **Use for CLAP** |
| `vst3` crate (coupler-rs) + our own safe host layer | Rust | MIT/Apache | Raw COM bindings. We write the host side ourselves: IHostApplication, IComponentHandler(2), IPlugFrame, IConnectionPoint wiring, IBStream, IParameterChanges/IParamValueQueue, IEventList, IAttributeList/IMessage, IPlugInterfaceSupport. **Estimate: 2-4k lines of careful unsafe Rust.** The SDK hosting helpers are MIT now, so porting their logic is allowed with attribution | **Use for VST3** |
| VST3 SDK hosting helpers (`public.sdk/source/vst/hosting/*`, the EditorHost/AudioHost samples) | C++ | MIT | Mature, matches the validator | **Fallback.** If the Rust VST3 layer stalls, write the plugin host's VST3 side in C++ against these helpers. The plugin host is a separate exe, so its language is independent of the engine's. |
| clap-host (reference) | C++/Qt | MIT | Reference only | Read it, don't ship it. |
| JUCE `AudioPluginFormatManager` | C++ | AGPL/commercial | Best-in-class, but incompatible | **No** |
| Tracktion Engine, Carla | C++ | GPL | — | **No** |
| `vst-js` (node addon) | C++ | no LICENSE file shown, "extremely experimental", macOS only | — | **No** |

**Language note.** `kryptguidelines` forbids compiling C++ *at `npm install`*. The engine, plugin host and scanner are prebuilt executables built in CI and shipped by the installer, so C++ inside them, if we ever need it, doesn't break that rule.

### 2.3 Recommended hosting architecture

```
+----------------------------- Electron: Krypt Studio ------------------------------+
| Renderer (React): rack, mixer, piano roll, playlist, Plugin Manager,              |
|   generic param editors, analyzers (WebGL)          [never touches plugins]       |
|        |  window.krypt.*  (contextBridge, typed, one ipc.ts)                      |
| Main: electron/system/engine.ts  MCP server  window registry                      |
|        |  BrowserWindow.getNativeWindowHandle() -> HWND as u64 -> engine          |
+--------|--------------------------------------------------------------------------+
         | control: named pipe (msgpack)   telemetry: shared-mem rings (meters, FFT)
+--------v--------------------------------------------------------------------------+
| krypt-studio-engine.exe (Rust)                                                    |
|  audio I/O (WASAPI / ASIO) -> graph scheduler -> stock DSP nodes (in-process)     |
|  PluginProxy nodes --------------+   plugin DB, scan cache, blocklist             |
|  PDC: sums node latencies        |   (%APPDATA%\Krypt Studio\plugins\*)           |
+----------------------------------|------------------------------------------------+
     spawn + supervise            | per block: shared memory + kernel events
          |                       |   (synchronous: request -> process -> done)
+---------v-------------------+  +v--------------------------+  +-------------------+
| krypt-studio-pluginhost.exe |  | krypt-studio-pluginhost   |  | krypt-studio-     |
| mode: SHARED sandbox        |  | mode: ISOLATED (1 inst.)  |  | scanner.exe       |
|  RT thread (MMCSS Pro Audio)|  |  e.g. a crash-prone synth |  | one file per run, |
|  UI thread = plugin main    |  |                           |  | JSON -> stdout,   |
|   thread: editors as OWNED  |  |                           |  | killed on timeout |
|   top-level windows (owner =|  |                           |  +-------------------+
|   Electron HWND)            |  |                           |
+-----------------------------+  +---------------------------+
```

Key properties:
- **Stock plugins never leave the engine.** No IPC, no HWNDs, and their UIs are React.
- **The engine is a separate process from Electron**, so a crash in the UI or the engine doesn't take down the other. This doc assumes the engine research lands there. If the engine instead becomes a Node native addon inside Electron main, sandboxing third-party plugins becomes *more* important, not less.
- **The plugin host owns two kinds of thread.** The **UI/main thread** runs a Win32 message loop, because VST3 and CLAP require plugin main-thread calls such as `IPlugView`, `IEditController` and CLAP `[main-thread]` on it. The **real-time thread** is registered with MMCSS ("Pro Audio") and runs `process()`.
- **The engine supervises every plugin host.** It handles heartbeats, a per-block deadline, crash detection and respawn.

### 2.4 Plugin scanning

**Process model.** The engine spawns `krypt-studio-scanner.exe <path>`, once per plugin file or in small batches with a journal. The scanner prints a JSON array of descriptors to stdout and exits. The engine kills it after a timeout: 30 s by default, configurable, because some plugins run first-launch activation or decompression.

**Fast paths.**
- **VST3 `moduleinfo.json`** (SDK 3.7.5+; in `Contents/Resources/` since 3.7.8) lists class IDs, names, vendor, version, categories, flags, SDK version and VST2-replacement "Compatibility" IDs as JSON5, **without loading the binary**. It's optional, so many plugins lack it. When it's present, take the descriptor from JSON and do a real load on first instantiate. As JUCE users found, passing a JSON scan doesn't prove the plugin will load.
- **CLAP**: load the DLL, call `clap_entry.init(path)`, then `get_factory(CLAP_PLUGIN_FACTORY_ID)`, read descriptors, then `deinit()`. The spec requires `init` to be fast and forbids GUIs during it, but it is still foreign code, so it runs in the scanner. Also query `clap.preset-discovery-factory` when present to index presets.

**Cache** (`%APPDATA%\Krypt Studio\plugins\cache.json`, or SQLite; written atomically per guidelines section 5.9):

```jsonc
{
  "key": { "path": "C:/Program Files/Common Files/VST3/Foo.vst3",
           "binary": "Contents/x86_64-win/Foo.vst3", "size": 18234112, "mtime": 1759999999 },
  "format": "vst3",                    // or "clap"
  "status": "ok",                      // ok | failed | timeout | blocked
  "classes": [{
    "id": "ABCDEF01...",               // VST3 CID (32 hex) or CLAP id string
    "name": "Foo Comp", "vendor": "Foo Audio", "version": "1.4.2",
    "kind": "effect",                  // instrument | effect | note-effect | analyzer
    "categories": ["Fx", "Dynamics"],  // VST3 subCategories / CLAP features
    "ioSummary": "2in/2out + sidechain",
    "sdk": "VST 3.7.12", "fromModuleInfo": true
  }],
  "scannedAt": "2026-10-11T12:00:00Z", "scannerVersion": 1
}
```

**Blocklist and crash journal.**
1. Before scanning file X, append X to `scan-journal.txt`. On clean exit, remove it.
2. If the scanner crashes or times out, X is the culprit. A crash goes straight to the blocklist with the reason, and the Plugin Manager shows it with a "Retry" button. A timeout is marked `timeout` but not auto-blocked.
3. The same journal pattern guards **instantiation** in the plugin host. A plugin that crashes at load N times (N = 2) is auto-blocked, and the user sees a toast with the reason. Per guidelines section 11.1, there are no silent failures.
4. The blocklist is user-editable in the Plugin Manager and stored separately from the cache, so "rescan all" doesn't wipe it.

**Rescan policy.** At startup, run an incremental background rescan: only files whose `(size, mtime)` changed, plus new files. It must not block the UI, and progress shows in the TopBar's progress bar. Offer a manual "Full rescan". A "Verify" action instantiates each plugin in a throwaway host and runs a short `process()` (an FL-style "verify plugins").

**Plugin Manager UI** (FL users expect one): favourites, user categories, per-plugin settings (hosting mode, DPI mode, keep-focus, manual latency offset), scan status and reasons.

### 2.5 Out-of-process sandboxing and crash protection

**What others do.**
- **Bitwig** has five modes: *Within Bitwig*, *Together* (one process for all plugins, separate from the engine), *By manufacturer*, *By plug-in* (instances of the same plugin share a process) and *Individually* (each instance alone, "maximum isolation at the cost of more computing resources"). There's a per-plugin "always run individually" override. After a crash, the device shows a notice with **Reload Plug-in** or **Reload All**, and audio may keep playing.
- **REAPER** has Native, Separate process (all bridged plugins share one) and Dedicated process (one per plugin). A REAPER blog admin reports no noticeable added latency for 64-bit plugins in a dedicated process. That's anecdotal.
- **FL Studio** has "Make bridged" (runs in `ilbridge.exe`) and "External window" for bridged editors. Its manual warns that bridged plugins steal keyboard focus.

**Our modes:**

| Mode | Processes | Use |
|---|---|---|
| In-engine | 0 extra | **Stock plugins only.** Optionally a power-user opt-in for trusted third-party plugins. |
| **Shared sandbox** (default) | 1 | All third-party plugins. A crash kills only the sandbox, and the engine and UI survive. |
| By vendor | 1 per vendor | Plugins that talk between instances (shared memory/statics), e.g. a vendor's analyzer and its EQ. |
| Isolated | 1 per instance | A per-plugin override, auto-suggested after a crash. |

**Per-block IPC design (synchronous, zero added latency).**
1. Each plugin-host process maps one shared-memory section, created with `CreateFileMapping`. It holds, per hosted instance: input/output audio buffers sized for the max block × channels; an input event list (note events, parameter changes with sample offsets, transport); an output event list (parameter gestures from the plugin GUI, MIDI out); and a status word.
2. The engine's graph scheduler reaches a *run* of consecutive sandboxed nodes that live in the same process. It writes inputs, signals a kernel event (or semaphore), and waits on a "done" event. Use spin-then-block: spin briefly on an atomic in shared memory, then fall back to the kernel wait.
3. The plugin host's RT thread runs `process()` for that run in graph order and signals done.
4. **Deadline.** If done hasn't arrived by roughly 1.5× the block period, the engine outputs silence for those nodes for this block and marks them "late". Repeated lateness, or a dead process, puts them in the crashed state.

**Costs.**

| Cost | Size | Notes |
|---|---|---|
| Added audio latency | **0** in synchronous mode. **+1 block** in an optional "pipelined" mode (more robust against jitter, and reported to PDC) | — |
| CPU per round trip | **Estimate:** single to low double-digit µs per wake on modern Windows. Old Linux JACK data is about 50 µs per context switch on 2001 hardware. **Must be benchmarked (spike 2)** | At 64 samples/48 kHz the budget is 1.33 ms. One or two round trips per block are cheap. A track that alternates stock → sandboxed → stock → sandboxed needs several *serial* round trips. The scheduler should batch adjacent sandboxed nodes and run independent tracks in parallel. |
| RAM | Per process: runtime plus each plugin's own data | Isolated mode × 50 instances adds up, and Bitwig calls it the most memory-intensive mode. |
| Complexity | **High** | Shared-memory protocol, supervision and respawn, state recovery, cross-process windows (section 2.6), MMCSS, and debugging across processes. **Estimate: the single largest chunk of hosting work.** |

**State recovery after a crash.** The engine keeps the last good state blob per instance: VST3 `IComponent::getState` plus controller `getState`, or CLAP `state.save`. It refreshes the blob on every parameter gesture end (debounced), every 30 s, and on project save. **Reload Plug-in** respawns the process, re-instantiates the plugin, restores that blob, re-applies the automation position and reopens the editor if it was open.

**Hang detection.** The UI thread of each plugin host answers a heartbeat every 500 ms. If it misses 2 s while an editor is open, React shows "Plugin window not responding", with a **Kill and reload** action. The RT thread is unaffected by UI hangs. If the RT thread itself hangs, the deadline logic catches it.

### 2.6 Embedding plugin editor GUIs when the UI is Electron (deep dive)

#### 2.6.1 The constraints

- **VST3 has no floating mode.** `IEditController::createView("editor")` → `isPlatformTypeSupported(kPlatformTypeHWND)` → `setFrame(IPlugFrame*)` → `attached(parentHWND, kPlatformTypeHWND)`. Size changes go through `IPlugFrame::resizeView` and `onSize`/`checkSizeConstraint`. On close, call `removed()` *before* destroying the parent window. Everything happens on the plugin's main thread, **in the process that loaded the plugin.**
- **CLAP supports both modes.** `gui.is_api_supported(CLAP_WINDOW_API_WIN32, is_floating)`. Embedded mode uses `set_parent`, which the spec says embeds via `SetParent`. **Floating mode uses `set_transient(window)`: "Set the plugin floating window to stay above the given window."** That's tailor-made for an Electron host. Win32 sizes are physical pixels. `set_scale` overrides the scale factor.
- **Cross-process window relationships are legal but dangerous.** Raymond Chen: it is "technically legal", but it "implicitly attaches the input queues" of the threads involved, transitively, and becomes "near-impossible to manage" if one side doesn't know about it. The same applies to **owner/owned** relationships, not just parent/child: "a parent/child or owner/owned relationship crosses a thread boundary". With attached queues, "if one thread stops pumping messages, the other stalls too."
- **Precedent for the danger.** Firefox's out-of-process windowed plugins (Flash) hit exactly this. A hung plugin-container froze the browser window. Detaching the queues broke fullscreen focus, and bug 818059 ended WONTFIX.
- **Precedent that it works.** Unity documents `-parentHWND` for embedding its player cross-process into another app's window. Chromium's own GPU-process surface window lives on a dedicated "Window owner thread", and its code notes that when the *browser process* destroys its window, Windows destroys the child windows too. FL Studio embeds bridged plugin editors from `ilbridge.exe` inside its own UI.
- **Electron gives us the HWND but no foreign-view API.** `win.getNativeWindowHandle()` returns a Buffer holding the HWND, and `win.hookWindowMessage` is available on Windows. Electron's `BaseWindow`/`View`/`WebContentsView` compose *web* views only. I found no supported way to put a foreign HWND into Electron's view tree.
- **Airspace.** A native child HWND inside a BrowserWindow paints *over* Chromium's composited content. No HTML (menus, tooltips, modals, the piano roll) can draw on top of it, and HTML scrolling or clipping doesn't apply to it. *This is the standard behaviour of native child windows over GPU-composited surfaces. Verify it in spike 1.*
- **DPI.** Electron is per-monitor-v2 aware, and many plugins aren't. Mixing DPI awareness inside one window tree needs `SetThreadDpiHostingBehavior(DPI_HOSTING_BEHAVIOR_MIXED)` *on the thread that creates the parent* (Windows 10 1803+). For a parent inside Electron's process, we don't control that thread.
- **Keyboard.** A focused plugin window takes keys, so Space-to-play dies. FL ships a per-plugin "Keep focus" option for this reason.

#### 2.6.2 Options compared

| # | Approach | Crash/hang isolation | Look and integration | Effort | Verdict |
|---|---|---|---|---|---|
| **A** | **Owned top-level window from the plugin host.** The host creates a container with `CreateWindowEx(hWndParent = Electron HWND, no WS_CHILD)`, so the owner is Electron and the plugin attaches inside. CLAP floating-only plugins get `set_transient(ElectronHWND)` | Crashes are isolated. A UI hang can stall Electron input through the attached queue, so the watchdog kills the host | Floats above the main window, minimizes with it, has no taskbar button, and gets a dark caption via DWM. Standard DAW behaviour | Medium | **Default.** |
| **B** | **Unowned top-level window plus manual z-order.** `WS_EX_TOOLWINDOW` (no taskbar). Re-raise above the main window on Electron `focus`/`restore` events and hide on `minimize` | Full isolation, no queue attachment | Z-order glitches (the window can briefly fall behind) | Low | **Per-plugin fallback** ("Detached window", like FL's "External window"). |
| C | **Docked cross-process child.** The plugin's container is `SetParent`-ed into the BrowserWindow, positioned over a React placeholder (ResizeObserver → IPC → `SetWindowPos`) | Queue attachment with Electron's UI thread | Airspace: hide the plugin while any HTML overlay is open. No clipping or scroll, and fragile mixed DPI | High | **Later, experimental only.** |
| D | **Per-plugin frameless Electron BrowserWindow** (Krypt-styled HTML header) with the plugin as a cross-process child below it | Same as C | Best branding, since our React wrapper controls sit in the header. Header menus must use `Menu.popup` (native) to avoid airspace. About one renderer process per open editor (RAM) | High | Maybe in v2 for branding. Prototype after A ships. |
| E | **Offscreen capture into `<canvas>`** (PrintWindow / Windows.Graphics.Capture) plus synthetic input | Isolated | Laggy. GPU-rendered plugins capture poorly. Input fidelity (drag, wheel, text, IME) is bad | High | **Reject** for interaction. **Keep** for thumbnails and MCP agent screenshots. |
| F | **Host plugins inside Electron main** through a native addon | None. A crash kills the UI | — | Medium | **Reject.** |
| G | **React generic parameter editor** | n/a | Native Krypt look, works for every plugin, needs no HWND | Low | **Always.** It's also the MCP surface. |
| H | **CLAP `webview` draft extension.** The plugin provides a URI and resources, and the host renders them in its own webview. Messages go `postMessage` ↔ `clap_plugin_webview.receive` / `clap_host_webview.send` | Plugin UI runs in our renderer sandbox. Plugin logic stays in the host process | **Perfect fit for Electron.** No HWND, no airspace | Medium | **Adopt when the extension leaves draft.** Use it for our own exported plugins first. |

#### 2.6.3 Recommended implementation (Option A)

1. Electron main calls `getNativeWindowHandle()`, reads it as a little-endian u64 and sends it to the engine, which forwards it to every plugin host. Resend it whenever the main BrowserWindow is recreated.
2. To open an editor, the engine sends `OpenEditor{instance, ownerHwnd, dpiMode, savedRect}` to the plugin host's UI thread.
3. The plugin host:
   - Picks the DPI context for this plugin (see below) with `SetThreadDpiAwarenessContext`. It also sets `SetThreadDpiHostingBehavior(MIXED)` just for the container creation, then restores it.
   - Creates a container with `WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX` (plus `WS_THICKFRAME` if the plugin can resize), passing the owner HWND as `hWndParent`. It sets `DWMWA_USE_IMMERSIVE_DARK_MODE` for a dark caption that matches the Krypt void. The title is `"<Track> - <Plugin>"`.
   - VST3: `createView` → `setFrame` → `attached(container)` → size the container from `getSize`. Honour `canResize` / `checkSizeConstraint`. Apply `IPlugViewContentScaleSupport::setContentScaleFactor` when the plugin is DPI-aware.
   - CLAP: if `is_api_supported(WIN32, false)`, embed with `create(WIN32,false)` → `set_scale` → `get_size` → `set_parent(container)` → `show`. Otherwise use floating mode: `create(WIN32,true)` → `set_transient(ownerHwnd)` → `suggest_title` → `show`.
4. **Wrapper controls stay in React.** Presets, bypass, A/B, sidechain routing, latency offset, DPI mode and "Keep focus" live in a React plugin-wrapper panel in the main window, like FL's wrapper header. The native window is just caption plus plugin, which keeps the native code small.
5. **Persistence.** Save each instance's window rect, and its open/closed state, in the project. Secondary monitors can have **negative coordinates**, so use an explicit `placed` flag, never `x < 0` (guidelines section 6).
6. **DPI modes**, set per plugin and stored in the plugin DB:
   - *Auto*: per-monitor-v2 if the plugin advertises scaling (VST3 `IPlugViewContentScaleSupport`, or a CLAP `set_scale` that succeeds), else system-aware.
   - *Plugin scales*.
   - *Windows scales*: an unaware context, where DWM bitmap-stretches the window. Blurry, but the right size. This is FL's "DPI aware" switch, inverted.
7. **Keyboard.** In the plugin host message loop, before dispatching, check a small host-shortcut table: Space, Ctrl+S, Ctrl+Z/Y, window toggles. Forward a match to the engine and Electron *unless* the focused HWND is a text-entry control (class `Edit` or `RichEdit*`, or an IME composition is active). Per plugin, "Keep focus" bounces focus back to the main window after mouse-up. Expect a long tail of plugin-specific quirks.
8. **Teardown.** VST3: `removed()` → release the view → destroy the container. CLAP: `hide` → `destroy`. If the plugin closes its own floating window, CLAP sends `host_gui.closed(was_destroyed)`, so mirror that state into React.
9. **Hang watchdog.** See section 2.5. Because of queue attachment, a hung plugin UI thread can freeze input in Electron main. Kill and reload is the reliable cure: killing the process destroys its windows and detaches the queues. Keep a hard rule: **no blocking cross-process sends from Electron main to plugin windows.** Use `PostMessage` only, never `SendMessage`.
10. **Agent screenshots (optional).** `PrintWindow(container, PW_RENDERFULLCONTENT)` → PNG → MCP `plugin.screenshot`. Read-only, for multimodal agents.

### 2.7 Parameters, automation, presets and PDC

**Unified parameter model.** The engine normalizes VST3 and CLAP into one descriptor:

| Field | VST3 source | CLAP source |
|---|---|---|
| `id` (stable u32) | `ParameterInfo.id` (ParamID) | `clap_param_info.id` ("must never change") |
| `name`, `group` | `title`, `unitId` → `IUnitInfo` path | `name`, `module` ("/"-separated) |
| range / default | normalized 0..1 + `stepCount` + `defaultNormalizedValue` | plain `min_value`/`max_value`/`default_value` (doubles) |
| text ↔ value | `getParamStringByValue` / `getParamValueByString` (3.8.1's validator now round-trip tests these) | `value_to_text` / `text_to_value` |
| flags | `kCanAutomate`, `kIsReadOnly`, `kIsHidden`, `kIsList`, `kIsBypass`, `kIsProgramChange`, `kIsWrapAround` | `IS_AUTOMATABLE`, `IS_READONLY`, `IS_HIDDEN`, `IS_ENUM`, `IS_STEPPED`, `IS_BYPASS`, `IS_PERIODIC`, `IS_MODULATABLE(_PER_NOTE_ID/KEY/…)`, `REQUIRES_PROCESS` |
| change notifications | `IComponentHandler::restartComponent(kParamValuesChanged / kParamTitlesChanged / kLatencyChanged / kIoChanged / kReloadComponent)` | `host_params.rescan(VALUES / TEXT / INFO / ALL)`. `ALL` only while deactivated |

**Automation.**
- Sample-accurate. VST3 uses `IParameterChanges`/`IParamValueQueue` points with sample offsets in `ProcessData`. CLAP uses `CLAP_EVENT_PARAM_VALUE` events with `time` offsets.
- CLAP adds non-destructive **modulation** (`CLAP_EVENT_PARAM_MOD`) on top of the automated value. Map FL-style "automation clips" to value events and our LFO/envelope modulators to MOD where supported.
- GUI-originated changes: VST3 `beginEdit`/`performEdit`/`endEdit` on IComponentHandler. CLAP `PARAM_GESTURE_BEGIN/END` plus output `PARAM_VALUE` events. These drive "record automation" and touch/latch. Honour CLAP's `CLAP_EVENT_DONT_RECORD` flag on CC-driven changes.
- **VST3 has no MIDI CC events.** The host must translate CC, pitch bend and aftertouch into parameters via `IMidiMapping` (`IMidiMapping2` since 3.8). CLAP takes raw MIDI or MIDI 2 note-port events.
- When the plugin is inactive, apply parameter sets through CLAP `params.flush()`, or through VST3 `IEditController::setParamNormalized` plus the next `process()` queue.

**Presets and state.**
- **Project state** is opaque blobs. VST3 stores component and controller state via `getState`, restored with `setState` plus `setComponentState`. CLAP uses `state.save`/`load`, plus `state-context` to tell preset, project and duplicate apart. Store them base64 in the project file with format and plugin ID.
- **`.vstpreset`**: read and write it. The layout is header `'VST3'` + version + 32-byte ASCII class ID + chunk-list offset, a data area, then a `'List'` chunk index (component, controller, program data and meta-info chunks; see `Vst::PresetFile`). Scan the standard locations: `Documents\VST3 Presets\$COMPANY\$PLUGIN`, `%APPDATA%\VST3 Presets\…`, `%PROGRAMDATA%\VST3 Presets\…`, `$APPFOLDER\VST3 Presets\…`.
- **`.fxp`/`.fxb`** are VST2 formats. Without VST2 hosting, we only pass `.fxp` to VST3 plugins that import it through their own UI. We don't parse it at launch.
- **CLAP**: `clap.preset-discovery-factory` indexes the plugin's own preset files, and `preset-load` asks the plugin to load one by location and key.
- **Our own format** `.kpreset`: a JSON header (plugin ID, format, name, tags, author) plus the base64 state blob. It powers a unified FL-style preset browser across stock and third-party plugins.

**PDC (plugin delay compensation).**
- VST3: `IAudioProcessor::getLatencySamples()`. On `restartComponent(kLatencyChanged)`, the host deactivates, re-queries, then reactivates (`setProcessing(false)` → `setActive(false/true)`).
- CLAP: `latency.get()`. The plugin may report changes only during `activate` or via `request_restart`.
- Tails: VST3 `getTailSamples` (`kInfiniteTail`), CLAP `tail.get`. These drive smart-disable and offline render tails.
- The engine aligns every graph path to the maximum path latency. Each instance gets a **manual latency offset**, because FL has one for plugins that misreport. Sandbox pipelined mode adds +1 block per sandbox hop, and the proxy must report that. Synchronous mode adds nothing.

### 2.8 Exposing plugin parameters to MCP agents

**Principles.**
1. **Agents talk to the engine's parameter model, never to plugin GUIs.** Every agent write goes through the same command bus as the UI, so it is undoable, appears in the React editor, and can be recorded as automation if the agent asks.
2. **Address parameters by stable ID** (VST3 ParamID or CLAP `clap_id`), with names for discovery. Never by index.
3. **Accept values three ways:** `normalized` (0..1), `plain` (the plugin's units), and `text` ("-6 dB", "1/8 D"), the last via `getParamValueByString` / `text_to_value`. Always **read back** the resulting value and display string.
4. **Big plugins have thousands of parameters.** Offer search, paging and curated subsets: CLAP `remote-controls` pages, VST3 unit groups, and our own semantic metadata for stock plugins.
5. **Safety.** Agents can instantiate only plugins that were scanned and aren't blocklisted. They never pass DLL paths. Hidden or read-only parameters aren't writable. Rate-limit and coalesce bursts into one undo step per tool call.

**Tool sketch** (names illustrative; align with the MCP research doc):

```jsonc
// discovery
plugins.search      { query?, kind?: "instrument"|"effect", format?, vendor? }
                    -> [{ pluginId, name, vendor, format, categories, status }]
plugin.insert       { target: { track | mixerInsert | channel }, pluginId, slot? } -> { instanceId }
plugin.describe     { instanceId } -> { name, vendor, io, latencySamples, tailSamples,
                                        hasEditor, sandbox, paramCount, pages: [{name, paramIds}] }
// parameters
plugin.params.list  { instanceId, search?, group?, page?, pageSize? = 50 }
                    -> [{ id, name, group, value: { normalized, plain, text },
                          range: { min, max, default, steps?, enumLabels? }, unit?,
                          flags: ["automatable","modulatable","bypass",...] }]
plugin.params.set   { instanceId, changes: [{ id, value, as: "normalized"|"plain"|"text" }],
                      options?: { gesture: true, recordAutomation: false, rampMs?: 0 } }
                    -> [{ id, applied: { normalized, plain, text }, clamped: bool }]
plugin.params.get   { instanceId, ids: [..] }
// automation
automation.write    { instanceId, paramId, points: [{ ppq, value, as, curve? }], replaceRange? }
// state and presets
plugin.state.snapshot { instanceId } -> { snapshotId }    // cheap A/B for agent experiments
plugin.state.restore  { instanceId, snapshotId }
plugin.presets.list / plugin.presets.load / plugin.presets.save
plugin.bypass       { instanceId, on }
plugin.editor.open / plugin.editor.close / plugin.screenshot { instanceId } -> image/png
```

**Stock plugins get first-class semantics.** Each parameter declares `unit` ("Hz", "dB", "ms", "%", "semitones"), `scale` ("log", "linear"), a `role` ("filter.cutoff", "env.amp.attack") and a one-line `doc`. That lets agents reason ("make the bass brighter" → raise `filter.cutoff`) without guessing from names. This is a real differentiator over FL, where agents would be blind.

---

## 3. Part B - Stock plugins

### 3.1 Framework decision: engine-internal nodes vs plugin framework

| Criterion | Engine-internal nodes (Rust trait) | Real plugins via nice-plug / clack-plugin |
|---|---|---|
| CPU / latency | Zero overhead, no IPC | Hosted like third-party, or in-process |
| Engine features | Direct access: sample-accurate automation, tempo, sidechain buses, per-note modulation, rich MCP metadata | Limited to what VST3/CLAP express |
| GUI | **React in the main window**, Krypt look per guidelines section 3, no HWND or airspace problems | Native toolkit (egui/vizia/visage) or experimental webview. Inconsistent look, plus the section 2.6 problems for our own plugins |
| Usable in other DAWs | No | Yes (marketing value) |
| Maturity | Ours to build | nice-plug is "experimental" and nih-plug is in maintenance mode. clack is pre-1.0 |

**Recommendation: a hybrid, internal first.**
- Write all DSP as **framework-free crates** (`krypt-dsp-*`) behind one small interface: `prepare(sample_rate, max_block)`, `process(&mut ctx)`, `reset()`, a static `ParamSpec` table (id, name, unit, range, scale, role, doc), and serde state.
- **Engine adapter (P0):** the engine's node trait wraps the DSP crate directly. The React UI is generated from `ParamSpec`, with custom panels for the flagship plugins.
- **Export adapter (P3, optional):** a thin adapter crate builds CLAP with `clack-plugin` and VST3 with `clap-wrapper`, or both through `nice-plug`. The GUI is a webview (wry/WebView2) that reuses the same React panels over a message bridge, which is the same shape as CLAP's `webview` extension. Ship Krypt instruments as free VST3/CLAP for other DAWs later, which also advertises Krypt.
- **C++ sources** (Airwindows, Signalsmith, DaisySP, Q, CloudSeedCore, msfa, Mutable) are either **ported to Rust** or **compiled through `cc`/`cxx` in the engine's cargo build**. That happens in CI, never at `npm install`. Airwindows plugins are small per-sample loops, so port them. Large, well-tested libraries are better wrapped: Signalsmith Stretch already has an MIT Rust wrapper, and CloudSeedCore and msfa are candidates for wrapping.
- **Real-time safety audit** for any imported code: no allocation, locks or I/O in `process()`. fundsp needs `allocate()` before RT use. Run a CI test under an allocation-failing global allocator in the RT path.

### 3.2 What to take from each permissive source

1. **Airwindows (MIT).** Port selectively for "character". Saturation and density, console summing, tape, clippers, de-essers and Airwindows-style reverbs map naturally onto distortion, limiter, reverb and channel-strip roles. Use the airwin2rack MIT registry and docs to pick candidates. Airwindows plugins have abstract A/B/C parameters, so we add proper names, units and docs.
2. **Signalsmith DSP and Stretch (MIT).** Delay lines with interpolation for delay, chorus and flanger. FFT and spectral helpers for analyzers and the vocoder. Stretch handles audio-clip time-stretch, Slicex-style stretching, pitch-correction resynthesis and Gross-Beat-like pitch effects.
3. **DaisySP (MIT core).** Oscillators, ADSR, drum synthesis models for an FPC "synth kit" mode, modal and Karplus-Strong voices, phaser, wavefolder, decimator. **Exclude the `DaisySP-LGPL` submodule.**
4. **SF2 / SFZ.**
   - **SF2:** use **rustysynth (MIT)** for an FL "Fruity SoundFont Player" equivalent.
   - **SFZ:** sfizz (BSD-2) is the best SFZ engine but was archived on 2026-06-21. Either vendor a fork and own its maintenance, or write a Rust SFZ subset (regions, velocity/key ranges, round-robin, envelopes, filters) on our sampler voice engine. **Recommend the Rust subset**, with sfizz as the behavioural reference.
   - **FluidSynth (LGPL-2.1)** would be legal only as a separately shipped DLL that users can replace, plus a licence notice and source offer. Rust static linking makes that awkward. rustysynth makes it unnecessary, so avoid it.
5. **Cycfi Q (MIT).** BACF pitch detection is the core of the pitch-correction plugin and the vocoder's voiced/unvoiced logic. Also ladder filters, envelope followers and dynamics. Its README mentions an FM/DX7 emulation, which we can cross-check against msfa.
6. **fundsp (MIT/Apache).** Prototyping and reference implementations (SVF, ladder, FDN reverb). Some production use is fine after the RT audit.
7. **CloudSeedCore (MIT).** The "big lush" reverb mode.
8. **msfa (Apache-2.0).** DX7-compatible FM core for the FM synth, including DX7 cartridge import. Keep the Apache NOTICE file.
9. **Mutable Instruments STM32 code (MIT).** Plaits macro-oscillator models (VA, waveshaping, FM, granular formant, harmonic, wavetable, chords, speech, noise, physical models) can power a "Krypt Macro-osc" or extra 3xOsc shapes. Rings and Elements give resonator voices, Clouds gives granular. **Confirm each module folder is in the STM32 (MIT) group, not AVR (GPL).**
10. **ymfm (BSD-3).** An optional "chip FM" engine (OPL/OPN) inside the FM synth.
11. **Faust (build-time only).** Good for fast DSP iteration. It can emit Rust or C++. CI must fail on any non-permissive `declare license` in the generated code (`vital_rev` and `kb_rom_rev1` are GPL-3.0-only).
12. **Papers and algorithms** (not copyrightable; implement from the publication):
    - RBJ Audio EQ Cookbook biquads, and Vicanek's matched second-order filters for analog-like high-frequency response
    - Simper/Cytomic SVF
    - Zavalishin's *The Art of VA Filter Design*
    - Giannoulis/Massberg/Reiss compressor design (JAES 2012)
    - ITU-R BS.1770 true-peak and loudness (or use the `ebur128` crate, MIT)
    - Antiderivative antialiasing (ADAA) for waveshapers
    - Jot FDN reverbs, the Dattorro plate, PolyBLEP/minBLEP oscillators, the PADsynth description, spectral-flux onset detection, YIN/pYIN/MPM pitch detection, PSOLA

### 3.3 Stock plugin roster

Working names only, pending branding. **Don't reuse FL trademarks** (Gross Beat, Sytrus, Slicex, etc.) in product copy. Priorities: **P0** = first public alpha, **P1** = beta, **P2** = 1.x, **P3** = later.

#### Instruments

| Krypt (working name) | FL equivalent | Built from | Pri | Notes |
|---|---|---|---|---|
| **Krypt Sampler** (also the audio-clip player) | Channel Sampler, Audio Clip | Own Rust voice engine (ADSR, SVF, pitch/glide). `rubato` (MIT/Apache) or our own polyphase/sinc interpolation. **Signalsmith Stretch** for stretch modes. Decoding comes from the engine/file-I/O research | **P0** | Everything else builds on it: pads, slicer, SF2/SFZ. |
| **Krypt TriOsc** | 3xOsc | Own Rust: 3 oscillators (sine/tri/saw/square/noise/custom single-cycle from **AKWF CC0**), coarse/fine/detune, phase offset, stereo, osc 2/3 → PM/FM/RM like 3xOsc. PolyBLEP or elliptic-BLEP (sst-basic-blocks' MIT header, or Signalsmith's elliptic-blep; **verify that licence**). Simper SVF. DaisySP-style ADSR | **P0** | The default instrument for new patterns, so it must be instant to load and CPU-cheap. |
| **Krypt Pads** | FPC | Sampler voices × 16 pads, velocity layers, round-robin, choke groups, per-pad outputs to the mixer, GM mapping, kit import (folders, SFZ subset). Optional **synth-drum pads** from DaisySP drum models | **P0** (sample pads), P1 (synth pads) | Needs CC0 or self-made factory kits. |
| **Krypt Slicer** | Slicex / Fruity Slicer | Spectral-flux onset detection (own), slice-to-key, per-slice pitch/reverse/envelope, **Signalsmith Stretch**, "export slices to piano roll" | **P1** | — |
| **Krypt FM** | Sytrus | 6-operator matrix FM (any routing, feedback), operator waveshapes, per-operator envelopes, filter section. Core from **msfa (Apache-2.0)** plus our own matrix layer. DX7 cartridge import. Optional ymfm chip mode | **P1/P2** | Sytrus-level depth is a big UI job, so ship a simpler UI first. |
| **Krypt Wave** | (FL has no direct twin; the market reference is Serum/Vital) | Own Rust wavetable engine: mip-mapped band-limited tables via `rustfft`, morphing, unison, warp modes designed clean-room. Import WAV wavetables and Surge `.wt` (documented format). AKWF factory tables. Filters via valib/fundsp-style SVF and ladder | **P2** | **Do not look at Vital/Surge code.** UX ideas only. |
| *(bonus)* **Krypt SoundFont** | Fruity SoundFont Player | **rustysynth (MIT)** | P2 | Cheap win for GM files and lo-fi producers. |
| *(bonus)* **Krypt Macro-osc** | — | Mutable Plaits models (MIT, STM32) | P3 | Huge sound palette for little UI work. |

#### Effects

| Krypt (working name) | FL equivalent | Built from | Pri | Notes |
|---|---|---|---|---|
| **Krypt EQ** | Parametric EQ 2 | 7-8 bands: RBJ or Vicanek matched biquads, SVF for modulated bands, live spectrum overlay. Linear-phase mode (FFT FIR) later | **P0** | Most-used mixer effect. |
| **Krypt Comp** | Fruity Compressor / Limiter (comp section) | Feed-forward VCA design (Giannoulis et al.), peak/RMS detectors (own or Q envelope followers), soft knee, lookahead (reports latency), **sidechain input**, auto-makeup | **P0** | — |
| **Krypt Limiter / Maximizer** | Fruity Limiter, Maximus | Lookahead brickwall + **true-peak** (4× oversampled ISP detection), ceiling, release auto. Clipper mode (Airwindows-style). Multiband "Maximus-like" with Linkwitz-Riley crossovers plus OTT-style up/down compression | **P0** (single-band), P2 (multiband) | Master-bus default. |
| **Krypt Reverb** | Fruity Reeverb 2 | Modes: FDN hall/room (own Jot FDN or fundsp reference), **Dattorro plate** (from the paper; Faust's `dattorro_rev` is STK-4.3 if we want codegen), **Cloud** (**CloudSeedCore MIT**), plus Airwindows reverbs as "character" | **P0** | Convolution mode (partitioned FFT plus IRs with clear licences) at P2. |
| **Krypt Delay** | Fruity Delay 3 | Signalsmith delay lines, tempo sync, ping-pong, feedback filters, modulation, ducking, saturation in the loop | **P0** | — |
| **Krypt Drive** | Blood Overdrive, Fast Dist, Distructor | Waveshapers with **ADAA** and oversampling (own halfband/polyphase; hiir is WTFPL; valib's MIT oversampler), bitcrush/decimate (DaisySP), Airwindows saturators, wavefolder (DaisySP) | **P0** | — |
| **Krypt Filter** | Fruity Filter, Love Philter (later) | Multimode SVF, ladder, comb. Envelope follower and LFO and tempo-synced shapes | **P0** | Love-Philter-style drawn envelopes reuse the gate editor. |
| **Krypt Duck / Sidechain** | Fruity Peak Controller, Fruity Limiter sidechain, LFOTool-style | **Engine-level sidechain routing** (needs mixer support, plus VST3 aux buses / CLAP non-main audio ports for third-party plugins), plus a ducker that is either envelope-drawn (triggered by beat or MIDI) or follows the sidechain level | **P0** | EDM producers expect this on day one. |
| **Krypt Analyzer** | Wave Candy, Fruity Spectroman | Spectrum (`rustfft`), oscilloscope, vectorscope/correlation, **LUFS/true-peak** (`ebur128` MIT). The engine streams decimated frames over shared-memory rings and React renders with WebGL | **P0** | Cheap, and also feeds EQ overlays and MCP "analyze mix" tools. |
| **Krypt Mod FX** | Fruity Chorus, Flanger, Phaser | Modulated delays (Signalsmith), allpass-chain phaser (DaisySP or own), stereo spread | **P1** | — |
| **Krypt Gate/Time** | Gross Beat | Two engines. **Volume**: a drawn envelope sequencer, zero latency. **Time**: a ring buffer of the last few bars with drawn read-position curves (stutter, half-speed, tape stop, reverse). Optional Signalsmith Stretch for pitch-preserving slow-downs. Slots selectable by MIDI notes | **P1** | Look-back only, so time effects can't look ahead without added latency. A signature FL workflow, so give it high polish. |
| **Krypt Vocoder** | Vocodex, Fruity Vocoder | Filterbank vocoder (8-100 bands, Q filters plus envelope followers) and an FFT mode (Signalsmith spectral). Carrier from the sidechain or an internal saw/noise, with unvoiced detection via Q pitch/energy | **P2** | Depends on sidechain routing. |
| **Krypt Tune** | Pitcher (real-time); Newtone is offline | Real time: Q BACF or MPM/YIN detection → scale snap with speed/humanize → **Signalsmith Stretch** pitch shift with formant compensation (PSOLA path for low latency later). Offline Newtone-like note editor at P3 | **P2** (real time), P3 (offline editor) | Hard to make sound good. Budget for tuning time. |

### 3.4 Factory content

- **Waveforms:** AKWF (CC0-1.0). **Drum kits and one-shots:** make our own, or use strictly CC0 sources with a provenance log. Licences on "free sample packs" are often non-redistributable.
- **Presets:** made in-house. Never port Vital, Surge or Dexed factory banks. Vital's README explicitly forbids redistributing its presets.

---

## 4. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Cross-process owned windows attach input queues.** A hung plugin UI freezes Electron input | Medium | High | Heartbeat watchdog, Kill and reload, no `SendMessage` from Electron, per-plugin fallback to unowned windows (Option B), spike 1 against real plugins. |
| R2 | **No VST2.** FL users' legacy VST2 freebies won't load | High | Medium-High | Clear messaging in the Plugin Manager ("VST2 not supported, look for a VST3/CLAP version"). Use moduleinfo `Compatibility` to auto-map VST2 IDs in imported projects later. Revisit legally if ever possible. |
| R3 | **Sandbox CPU overhead** at small buffers with many plugins | Medium | Medium | Batch adjacent sandboxed nodes, parallel tracks, shared-sandbox default, spin-then-block, optional in-engine mode for trusted plugins, benchmark in spike 2. |
| R4 | **Plugins that misbehave out of process**: copy protection, inter-instance communication, plugins that assume same-process hosts | Medium | Medium | By-vendor mode, an in-engine opt-in, a compatibility notes DB. |
| R5 | **DPI chaos** (blurry, mis-sized or clipped editors) | High | Medium | Per-plugin DPI mode (Auto / Plugin scales / Windows scales), mixed hosting behaviour in the host, a persisted per-plugin override. |
| R6 | **Rust VST3 host is raw unsafe COM.** Bugs mean crashes | Medium | Medium | Crashes stay in the sandbox. Port logic from the MIT SDK helpers. Test against the SDK validator, `clap-validator` and `pluginval` (GPL, used only in CI). C++ fallback for the VST3 side. |
| R7 | **Ecosystem churn**: clack and nice-plug pre-1.0, `vst3` crate 0.x, sfizz archived, nih-plug in maintenance | High | Low-Medium | Pin versions. Keep wrappers thin. Own the internal-node path. Write the SFZ subset in Rust. |
| R8 | **Licence contamination** from mixed-licence repos (sst-basic-blocks, chowdsp_utils, valib plugins, DaisySP-LGPL, Faust per-function GPL, Mutable AVR, Airwindows Consolidated JUCE builds) | Medium | High | `cargo-deny` licence allowlist, SPDX headers, a vendoring checklist per file, a Faust `declare license` CI gate, the clean-room process in section 1.3. |
| R9 | **AI agents reproducing GPL code** (Surge/Vital/LMMS) while building stock plugins | Medium | High | Never give GPL source as context. Provenance logs. Review similarity on suspicious code. |
| R10 | **ASIO SDK terms**: proprietary agreement obligations, can't commit the SDK | Low | Medium | Fetch the SDK in CI. Legal reads the agreement PDF before 1.0. WASAPI exclusive mode as the non-ASIO low-latency path (engine doc). |
| R11 | **Trademarks**: "VST" logo rules, FL product names, "Vital" naming bans | Low | Medium | Follow Steinberg's logo guidelines. Use our own product names. |
| R12 | **Keyboard focus** problems (Space doesn't play while a plugin is focused) | High | Low-Medium | Shortcut forwarding in the host message loop, per-plugin "Keep focus". |
| R13 | **CLAP webview is still a draft.** API may change | Medium | Low | Use it only behind a feature flag. The core plan doesn't depend on it. |
| R14 | **Third-party DSP that isn't real-time safe** (allocations in `process`) | Medium | Medium | RT-safety CI test with an allocation-trapping allocator. Audit before adopting. |
| R15 | **Scope.** Six instruments and fourteen effects is a lot for v1 | High | Medium | Strict P0 list (sampler, TriOsc, pads, EQ, comp, limiter, reverb, delay, drive, filter, duck, analyzer). Generated React UIs from `ParamSpec` for everything except the flagships. |

---

## 5. Recommended spikes (before committing)

1. **Plugin editor windows.** A Rust plugin host loads 10 real plugins: free, popular, a mix of JUCE, iPlug and custom GUIs, some GPU-rendered. Open each as an owned window of a dummy Electron BrowserWindow. Measure focus, z-order, minimize/restore, DPI on mixed-DPI dual monitors, and a forced UI hang (does Electron input freeze, and does Kill recover it?). Repeat with Option B.
2. **IPC microbenchmark.** Measure shared memory plus kernel-event round trips on Windows 10 at 32/64/128/256-sample blocks: 1, 4 and 16 sandboxed nodes, serial versus batched, with MMCSS. This gives numbers for section 2.5.
3. **Scanner.** Scan a 300-plugin folder with moduleinfo fast paths, journal and blocklist, and measure cold and warm scan times.
4. **VST3 host layer in Rust.** A minimal host on the `vst3` crate that passes the SDK validator's host-side expectations with 3 plugins (single-component, split-controller, instrument). Decide Rust versus C++ for the VST3 side from the result.
5. **Stock DSP pipeline.** Port 3 Airwindows effects plus TriOsc to the `krypt-dsp` trait, generate React UIs from `ParamSpec`, expose them through MCP `plugin.params.*`, and run the RT-safety test.

---

## 6. Sources

**SDK licensing and status**
- VST3 SDK repo (MIT statement): https://github.com/steinbergmedia/vst3sdk
- VST 3.8.0 release notes (2025-10-20, MIT): https://forums.steinberg.net/t/vst-3-8-0-sdk-released/1011988
- VST 3.8.1 release notes (2026-08-11): https://forums.steinberg.net/t/vst-3-8-1-sdk-released/1038865
- Steinberg press release VST 3.8 (2025-10-29): https://ocl-steinberg-live.steinberg.net/_storage/asset/819253/storage/master/Press%20Release%20-%202025-10-29%20-%20VST%203.8%20-%20EN.pdf
- Sonicstate coverage: https://sonicstate.com/news/2025/10/30/vst-3-now-available-under-mit-license
- Steinberg press release ASIO dual licensing / OBS (2025-10-15): https://ocl-steinberg-live.steinberg.net/_storage/asset/808575/storage/master/Press%20Release%20-%202025-10-15%20-%20OBS%20Partnership-%20EN.pdf
- ASIO SDK 2.3.4 mirror (README "Dual Licensing"): https://codeberg.org/rubiefawn/asiosdk
- MSYS2 asiosdk package (2.3.4, GPL-3.0-only option): https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-asiosdk
- heise coverage: https://heise.de/-10963451
- Steinberg forum on VST2 licences: https://forums.steinberg.net/t/permission-to-develop-vst2-host-that-will-never-be-distributed/202042
- FST (clean-room VST2 header, GPL-3.0+): https://sources.debian.org/src/fst/0.177.0-1/README.md
- CLAP repo: https://github.com/free-audio/clap
- CLAP changelog: https://raw.githubusercontent.com/free-audio/clap/main/ChangeLog.md
- CLAP entry.h (search paths, init rules): https://raw.githubusercontent.com/free-audio/clap/main/include/clap/entry.h
- CLAP gui.h: https://raw.githubusercontent.com/free-audio/clap/main/include/clap/ext/gui.h
- CLAP params.h: https://raw.githubusercontent.com/free-audio/clap/main/include/clap/ext/params.h
- CLAP webview draft: https://raw.githubusercontent.com/free-audio/clap/main/include/clap/ext/draft/webview.h
- CLAP on Wikipedia: https://en.wikipedia.org/wiki/CLever_Audio_Plug-in

**VST3 technical docs**
- moduleinfo.json: https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical+Documentation/VST+Module+Architecture/ModuleInfo-JSON.html
- Plugin locations: https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical+Documentation/Locations+Format/Plugin+Locations.html
- Preset format: https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical+Documentation/Locations+Format/Preset+Format.html
- Preset locations: https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical+Documentation/Locations+Format/Preset+Locations.html
- vstpresetfile.h: https://github.com/steinbergmedia/vst3_public_sdk/blob/master/source/vst/vstpresetfile.h
- JUCE forum on moduleinfo fast scan: https://forum.juce.com/t/descriptionlister-finddescriptionsfast/68147 and https://forum.juce.com/t/bug-hosting-and-scanning-vst3/61813

**Rust and C++ host/plugin libraries**
- vst3-rs: https://github.com/coupler-rs/vst3-rs ; crate: https://crates.io/crates/vst3 ; docs: https://docs.rs/vst3 ; author's post on 0.3.0: https://micahjohnston.com/posts/vst3
- vst3-sys (GPLv3): https://github.com/RustAudio/vst3-sys
- clack: https://github.com/prokopyl/clack ; https://crates.io/crates/clack-host ; https://crates.io/crates/clack-plugin ; cpal host example: https://github.com/prokopyl/clack/tree/main/host/examples/cpal
- nih-plug: https://github.com/robbert-vdh/nih-plug ; nice-plug: https://codeberg.org/BillyDM/nih-plug ; https://docs.rs/crate/nice-plug/latest
- clap-host: https://github.com/free-audio/clap-host ; clap-wrapper: https://github.com/free-audio/clap-wrapper ; clap-validator: https://github.com/free-audio/clap-validator
- pluginval: https://github.com/Tracktion/pluginval
- JUCE licensing: https://juce.com/get-juce/
- iPlug2: https://github.com/iPlug2/iPlug2 ; DPF: https://github.com/DISTRHO/DPF ; visage: https://github.com/VitalAudio/visage
- wry: https://github.com/tauri-apps/wry ; nih-plug-webview: https://github.com/maxjvh/nih-plug-webview
- vst-js: https://github.com/ramirezd42/vst-js

**Sandboxing and hosting behaviour in other DAWs**
- Bitwig user guide, plug-in hosting modes: https://bitwig.com/userguide/latest/vst_plug-in_handling_and_options
- Bitwig hosting/crash protection: https://www.bitwig.com/en/19/plugin-hosting-video.html ; https://bitwig.com/support/technical_support/what-is-plug-in-crash-protection-26
- REAPER dedicated process: https://reaper.blog/2012/02/run-plugin-as-dedicated-process/
- FL Studio plugin wrapper manual: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/wrapper.htm
- PyFLP (FL "Make bridged" semantics): https://pyflp.readthedocs.io/en/v2.0.0/reference/plugins/vst.html
- JACK IPC overhead discussions: https://lists.linuxaudio.org/archives/linux-audio-dev/2006-June/016090.html ; https://ccrma.stanford.edu/mirrors/lalists/lad/2001/Nov/0255.html

**Windows and Electron windowing**
- Raymond Chen, cross-process parent/owner windows: https://devblogs.microsoft.com/oldnewthing/20130412-00/?p=4683
- Raymond Chen, attached input queues: https://devblogs.microsoft.com/oldnewthing/20130604-00/?p=4173 ; https://devblogs.microsoft.com/oldnewthing/20130607-00/?p=4143
- Mozilla bug 818059 (plugin input queues): https://bugzilla.mozilla.org/show_bug.cgi?id=818059
- Chromium child_window_win.cc: https://chromium.googlesource.com/chromium/src/+/main/ui/gl/child_window_win.cc
- Unity `-parentHWND`: https://docs.unity3d.com/Manual/PlayerCommandLineArguments.html
- SetThreadDpiHostingBehavior: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddpihostingbehavior
- Electron BrowserWindow API: https://www.electronjs.org/docs/latest/api/browser-window ; BaseWindow: https://electronjs.org/docs/latest/api/base-window

**DSP libraries and content**
- Airwindows: https://github.com/airwindows/airwindows ; https://www.airwindows.com/ ; airwin2rack: https://github.com/baconpaul/airwin2rack
- DaisySP: https://github.com/electro-smith/DaisySP
- Signalsmith DSP: https://github.com/Signalsmith-Audio/dsp ; Stretch: https://github.com/Signalsmith-Audio/signalsmith-stretch ; Rust crate: https://crates.io/crates/signalsmith-stretch
- Cycfi Q: https://github.com/cycfi/q
- fundsp: https://github.com/SamiPerttu/fundsp ; https://crates.io/crates/fundsp
- valib: https://github.com/SolarLiner/valib
- synfx-dsp (GPL-3.0+): https://crates.io/crates/synfx-dsp
- Faust: https://github.com/grame-cncm/faust ; COPYING: https://raw.githubusercontent.com/grame-cncm/faust/master-dev/COPYING.txt ; https://en.wikipedia.org/wiki/FAUST_(programming_language) ; faustlibraries: https://github.com/grame-cncm/faustlibraries ; reverbs.lib: https://raw.githubusercontent.com/grame-cncm/faustlibraries/master/reverbs.lib
- Cmajor licence: https://raw.githubusercontent.com/cmajor-lang/cmajor/main/LICENSE.md
- sfizz (archived): https://github.com/sfztools/sfizz
- FluidSynth: https://github.com/FluidSynth/fluidsynth ; oxisynth: https://crates.io/crates/oxisynth
- rustysynth: https://github.com/sinshu/rustysynth ; https://crates.io/crates/rustysynth
- TinySoundFont: https://github.com/schellingb/TinySoundFont
- CloudSeed: https://github.com/ValdemarOrn/CloudSeed (core: https://github.com/GhostNoteAudio/CloudSeedCore)
- Mutable Instruments: https://github.com/pichenettes/eurorack
- msfa: https://github.com/google/music-synthesizer-for-android ; Dexed: https://github.com/asb2m10/dexed
- ymfm: https://github.com/aaronsgiles/ymfm
- chowdsp_utils: https://github.com/Chowdhury-DSP/chowdsp_utils
- sst-basic-blocks: https://github.com/surge-synthesizer/sst-basic-blocks ; Surge: https://github.com/surge-synthesizer/surge
- Vital: https://github.com/mtytel/vital ; Helm: https://github.com/mtytel/helm ; Odin 2 licence: https://raw.githubusercontent.com/TheWaveWarden/odin2/master/LICENSE
- OB-Xd: https://github.com/reales/OB-Xd ; Vaporizer2: https://github.com/VASTDynamics/Vaporizer2 ; ZynAddSubFX: https://github.com/zynaddsubfx/zynaddsubfx ; Dragonfly: https://github.com/michaelwillis/dragonfly-reverb
- AKWF (CC0-1.0): https://github.com/KristofferKarlAxelEkstrand/AKWF-FREE ; https://pandabunnytech.itch.io/akwf-for-smpltrek
- rustfft: https://crates.io/crates/rustfft ; rubato: https://crates.io/crates/rubato ; ebur128: https://crates.io/crates/ebur128
- Pitch crates: https://libraries.io/cargo/pitch-estimate ; https://lib.rs/crates/pyin ; https://lib.rs/crates/pyin-rs
- Bungee (MPL-2.0): https://bungee.parabolaresearch.com/ ; vcpkg manifest: https://api.pgxn.org/src/pg_stat_ch/pg_stat_ch-0.3.7/third_party/vcpkg/ports/bungee/vcpkg.json
- Rubber Band licence (vcpkg manifest): https://api.pgxn.org/src/pg_stat_ch/pg_stat_ch-0.3.7/third_party/vcpkg/ports/rubberband/vcpkg.json
