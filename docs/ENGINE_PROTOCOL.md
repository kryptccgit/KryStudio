# Engine protocol and behaviour spec (v1)

`krypt-studio-engine.exe` is a Rust **sidecar process** spawned by Electron main
(`electron/engine/`). TypeScript types live in `shared/engine/protocol.ts`, and
the Rust side mirrors them with serde using `#[serde(rename_all = "camelCase")]`.
**Any breaking change bumps `PROTOCOL_VERSION` on both sides.**

## 1. Process model

- Main spawns the engine by **absolute path** with `windowsHide: true` and arguments `--parent-pid <pid> --factory-dir <abs dir> --packs-dir <userData/packs>`.
- **`factory:` sample paths** (for example `factory:drums/kick.wav`) are resolved by the ENGINE against `--factory-dir`. The default is `<exe dir>/../factory`, which matches the packaged `resources/bin/../factory`. **`pack:` sample paths** resolve against `--packs-dir` (§9). Every other sample path is absolute.
  - The engine exits by itself when its parent process dies: poll `OpenProcess` / `WaitForSingleObject` every 1 s.
  - Node's job object also kills it with the parent.
- The engine never writes anything to stdout except protocol JSON lines. Logs go to stderr, or to stdout as `log` events.
- The engine must **never crash on bad project data**. It logs a `warn` event and skips the offending entity. A panic inside a plugin should be caught where practical (`catch_unwind` around the control thread); the audio thread outputs silence instead of crashing.
- CLI modes (no stdin protocol):
  - `--dump-catalog` prints `{"version":1,"plugins":[...]}` to stdout and exits. The build script writes it to `shared/plugins/catalog.gen.json`.
  - `--gen-factory <dir>` writes the factory drum kit to `<dir>/drums/*.wav` and exits.
  - `--render <project.json> --out <file.wav|file.mp3> [--scope song|pattern] [--pattern <id>] [--format wav16|wav24|wav32f|mp3] [--mp3-kbps 128|192|256|320] [--analyze] [--stems] [--factory-dir <dir>] [--packs-dir <dir>]` renders offline headless. With `--stems`, `--out` is a folder (see "Stem export" in §6). The format defaults to `mp3` when `--out` ends in `.mp3`, `wav24` otherwise. It prints a `RenderResult` JSON object and exits; it is used by agents and CI golden tests.
  - `--version` prints the version.

## 2. Control channel (stdin and stdout, NDJSON)

| Direction | Shape |
|---|---|
| request | `{"id": <n>, "cmd": "<name>", ...params}` |
| response | `{"id": <n>, "ok": true, "data": {...}}` or `{"id": <n>, "ok": false, "message": "..."}` |
| event | `{"event": "<name>", ...}` (no id) |

Every request gets **exactly one** response.
- Long jobs (`render`) respond when they finish, and stream `renderProgress` events meanwhile.
- The control loop must keep answering other requests, including `ping`, during a render, so run renders on their own thread.
- A render reads the engine's model as of when the request arrives. Main therefore flushes `apply` diffs still in its ~8 ms coalescing window, and waits for their ack, before it sends `render` (`EngineBridge.sync`). An agent's write followed at once by `render_preview` hears the new notes.

### Commands

| cmd | params | data | notes |
|---|---|---|---|
| `hello` | `protocol` | `HelloData` | First request. Reject a mismatched protocol with `ok:false`. |
| `ping` | — | `{}` | Heartbeat. Main expects a reply within 2 s. |
| `listDevices` | — | `DeviceInfo[]` | WASAPI output devices (cpal). ASIO comes later behind a cargo feature. |
| `openDevice` | `deviceId?`, `bufferFrames?`, `sampleRate?` | `DeviceStatus` | `null` or absent means the system default. On failure, fall back to the default and report it in `message`. |
| `loadProject` | `version`, `project` | `{version}` | Full `Project` (shared/schema/project.ts). Sample paths are already absolute. |
| `apply` | `version`, `upserts[]`, `deletes[]` | `{version}` | Entity-level diff (shared/engine/projection.ts). Apply all of it, then ack. |
| `transport` | `action` (`play`/`stop`/`pause`/`toggle`) | `{playing}` | `stop` returns to the start (pattern start or song position 0). `pause` keeps the position. |
| `locate` | `tick` | `{}` | Song position (song mode) or position in the pattern (pattern mode). |
| `audition` | `channelId`, `key`, `vel`, `on` | `{}` | Live note on/off through the channel's full chain, even while stopped. Main sends these without awaiting. |
| `auditionOff` | — | `{}` | Release all audition notes. |
| `previewFile` | `path`, `gain?` | `{durationSec}` | Browser preview: decode and play straight to the output, bypassing the mixer. A new preview replaces the old one. |
| `stopPreview` | — | `{}` | |
| `render` | `job: RenderRequest` | `RenderResult` | Offline, faster than real time, using the same graph code. It doesn't touch the live device. |
| `cancelRender` | — | `{}` | |
| `analyzeFile` | `path` | `Analysis` | Decode and run `krypt_studio_dsp::analysis::analyze`. |
| `sampleInfo` | `path` | `SampleInfo` | Every command that takes an audio path decodes with `krypt_studio_dsp::decode`: wav/aiff/flac/mp3/ogg via symphonia everywhere, and m4a/mp4/aac/wma/ac3 … via Windows Media Foundation (the OS's codecs; unavailable on Windows N without the Media Feature Pack). The full list the app accepts is `shared/audio/formats.ts`. |
| `peaks` | `path`, `buckets` | `Peaks` | Min/max per bucket, mono-summed, for waveform drawing. Cache by path and mtime. |
| `catalog` | — | `{version, plugins}` | Same JSON as `--dump-catalog`. |
| `shutdown` | — | `{}` | Respond, then exit cleanly within 500 ms. |

### Events (engine to main)

`log {level, message}`, `device {status}` (device lost, changed or recovered), `renderProgress {progress 0..1}`, `xrun {count}`, `stretch {pending, channels}` (audio-clip channels whose time-stretched / pitched copy is still rendering; sent when the set changes, `pending: 0` when all are ready; §4 audio clips).

## 3. Telemetry channel (engine to renderer)

- The engine binds a WebSocket server on `127.0.0.1:0` (a random port) and generates a random 32-hex token.
- Both are reported in `hello.telemetry`, and main hands the renderer `ws://127.0.0.1:<port>/?token=<token>`.
- Reject connections without the token.
- Multiple clients are allowed (main window plus popouts).
- Push a `TelemetryFrame` (JSON text) about every 16 ms to every client. Include `spectrum` (64 log-spaced bins in dB, 20 Hz to 20 kHz, master) on every second frame.
- Meters carry **peak since the last frame** (linear) per insert id, plus `channels` activity per channel id.
- Optional `params` (`{ [ParamRef]: normalized 0..1 }`): live values of params the engine is driving (automation, MIDI). Not sent by engine v0.1. Until it is, the UI computes automated knob positions itself from the automation clips and the playhead (`src/live/automationFollow.ts`, same curve and hold rules as §4).
- The telemetry thread reads lock-free rings published by the audio thread and must never block it.
- Clients may send `{"t":"watch","slots":[...]}` up the socket to get per-slot scopes; frames also carry per-slot gain reduction (§15).

## 4. Musical semantics (must match the TypeScript side)

- **Time:** PPQ 960. One 16th step is 240 ticks. Seconds per tick = `60 / (bpm * 960)`. Tempo can change through `transport/bpm` automation, so recompute the tick-to-sample mapping per block.
- **Pattern length:** `pattern.length` if set; otherwise the end of the last note rounded up to a whole bar (bar = `960*4*num/den`), with a minimum of one bar. (`patternLength()` in project.ts.)
- **Pattern mode:** loop `transport.activePatternId` forever. When the active pattern changes during playback, switch at the next pattern loop boundary. Selecting while stopped takes effect immediately.
- **Song mode:** play playlist clips.
  - If `transport.loop.enabled`, loop `[loop.start, loop.end)`.
  - Otherwise loop the whole song: 0 to the end of the last clip, rounded up to a bar, with a minimum of one bar. FL loops the song too.
  - Muted clips and clips on muted tracks are silent. If any track is soloed, only soloed tracks play.
- **Pattern clips:** a clip plays its pattern's notes with source tick = `songTick - clip.start + clip.offset`.
  - The source **loops** the pattern when the clip is longer than the pattern.
  - Notes are cut at the clip end: a note-off is sent at the clip end.
- **Audio clips:** the clip's `channelId` channel (generator `krypt.audioclip`) plays its sample starting at source time `(songTick - clip.start + clip.offset)` converted to seconds at the current tempo.
  - `clip.gain` scales the clip, and `fadeIn` / `fadeOut` (ticks) apply linear fades.
  - If playback starts in the middle of a clip, start mid-sample.
  - **Time-stretch and pitch-shift** (wave 3A) are generator params of the `krypt.audioclip` channel, group "Stretch", set through the normal param commands and **not automatable**:

    | id | name | range | default | meaning |
    |---|---|---|---|---|
    | `pitch` | Pitch | −24..24 st (fractional) | 0 | Pitch shift in semitones; duration unchanged. |
    | `formant` | Keep formants | Off/On | On | Formant compensation while pitched (no effect at 0 st). |
    | `tempo_sync` | Follow tempo | Off/On | Off | Stretch the source tempo onto the project tempo. |
    | `src_bpm` | Source BPM | 0..999 | 0 = unknown | The sample's own tempo. Follow tempo needs it > 0 (otherwise a `warn` is logged once and the tempo factor is 1). |
    | `stretch` | Stretch | 0.25..4 (log) | 1 | Time multiplier: output duration ÷ input duration. |

    - **Ratio:** `ratio = stretch × (tempo_sync && src_bpm > 0 ? src_bpm / projectBpm : 1)`, clamped to 1/16..16. `projectBpm` is the document tempo (`transport.bpm`); tempo *automation* does not re-stretch (positions still follow the current tempo, as before).
    - **Identity** (ratio 1 and 0 st after quantization) plays the original sample through the unchanged code path: bit-identical to a clip without these params, and the stretcher never runs.
    - **Variants.** Otherwise the engine renders a stretched / pitched copy of the whole sample (Signalsmith Stretch, MIT, vendored in `engine/crates/stretch`) and hands it to the instrument as its sample, so the audio thread only ever plays plain buffers. The variant has exactly `round(frames × ratio)` frames at the sample's own rate and is time-aligned (stretcher latency compensated, 1 ms fade-in from 0, no pre-roll): an onset at source time `t` lands at `t × ratio`. Reverse plays the variant backwards; `gain` applies as usual.
    - **Timeline:** with a variant, the playback position is the position in seconds at project tempo (the same `(songTick - clip.start + clip.offset)` mapping), read from the variant buffer, which is already stretched. A tempo change gives tempo-synced clips a new ratio, hence a new variant.
    - **Cache:** keyed by sample identity (resolved path + file mtime), ratio (quantized to 1e‑9), pitch (0.001 st), the formant flag and the warp key (§11); shared by the live engine and renders. LRU-bounded at 1 GiB of sample data: variants an instrument still holds or the live project currently wants are never evicted (going over the cap with such variants logs one `warn`); evictions log `info`. Long material uses Signalsmith's cheaper preset (> 20 min); a variant longer than 30 minutes is refused with a `warn` and the clip stays silent.
    - **While a variant renders (live engine):** two worker threads render it; edits that make a job obsolete cancel it within ~0.5 s of audio. If only the pitch / formants changed (same timing), the clip keeps playing what it played before until the new variant is ready; if the timing changed, the clip is **silent** until it is ready (never audio at the wrong tempo). When it is ready the instrument is re-created and the clip **resumes mid-clip at the playhead** (`Batch::rechase`). Progress: `stretch` events (§2); completions log `info` ("Time-stretched … in N s"); failures log `warn` and leave the clip silent (it never falls back to the unstretched sample).
    - **Offline renders** (`render`, `--render`) render every needed variant first (in parallel, reusing the live cache) and only then render audio, so an export right after a param change contains the stretched audio. Cancelling the render also cancels variant rendering.
    - **Cost:** ~25–110× real time per stereo stem on one core (3-min 48 kHz stem: 1.6 s at 0.5×, 2.6 s at 0.8×, 3.7 s pitch-only, 4 s at 1.25×, 7.6 s at 2×, i7-10700K).
  - **Warp markers and warp modes** (Wave 12.2) live on the channel's generator (`generator.warp`, `shared/schema/warp.ts`). With 2 or more markers they define the timing at the project tempo and override `stretch` / `tempo_sync` / `src_bpm`; one marker shifts the Stretch timing; the mode picks the algorithm (`complex`, `tones`, `beats`, `texture`, `repitch`; `repitch` ignores `pitch`). A warped clip is a variant like a stretched one: its key adds the warp map (and the bpm when markers are used), so any change re-renders off the audio thread with the same `stretch` events, keep-playing / silence rules and offline-render wait. No markers + `complex` (or ratio 1, 0 st in any mode) is the identity / plain-stretch path, bit for bit. Details: §11.
  - **Slice markers** live on a `krypt.slicer` channel's generator (`generator.slices`, `shared/schema/slicer.ts`): slice N plays on key First key + N − 1 at its recorded pitch. Details: §16.
- **Automation clips:** while a clip is active, evaluate `automations[id]` at relative tick `songTick - clip.start + clip.offset`.
  - Use the curve in `shared/schema/automation.ts` (identical formula). Values are normalized 0..1 and mapped through the target's ParamSpec (`from_normalized`).
  - Apply at least every 32 samples (sub-block). After a clip ends, its last value **holds**.
  - Automation overrides the document value while it plays.
  - Targets use the ParamRef syntax (`shared/schema/params.ts`); unknown targets are ignored. Knobs inside racks have their own refs (§12, "Inner params").
- **Notes:**
  - Velocity maps to gain as `vel^1.6` (instruments receive raw `vel`; the curve lives in instruments).
  - Note pan combines with channel pan.
  - Pitch = `key + channel.pitch + fine/100`. For sample instruments, `rootKey` is the key that plays at the original pitch.
  - A slide note on a channel glides from the previously sounding note (`NoteExtras.slide`).
  - A note with `mute: true` (piano-roll mute tool) is never scheduled. It still counts towards the auto pattern length. `mute` and `color` (a 0..15 note colour group, UI/MIDI-export only) are optional; absent means `false` / `0`.
- **Swing:**
  - Notes whose start falls on an **odd 16th step** (`floor(tick/240) % 2 == 1`) are delayed by `swing * channel.swing * 240 * 0.5` ticks.
  - At most half a step; that maximum is reached only when both the global swing and the channel's swing share are at 1. The shift is applied at event generation.
- **Channels:**
  - `mute` silences new notes and lets tails ring.
  - `volume` is linear gain and `pan` is equal-power.
  - Channel output feeds `insertId`.
  - `poly.mono` + `glideMs` go to `Instrument::set_voice_mode`.
  - **Cut groups:** a new note on a channel whose `poly.cutGroup = g > 0` calls `choke()` on every channel (itself included) whose `poly.cutBy = g`, before triggering.
- **Mixer:**
  - Signal path per insert: sum of inputs (channels routed to it, plus routes from other inserts × send level), then FX slots in `slotOrder` (bypassed if `!enabled`), then wet/dry `mix`.
  - After the FX: stereo separation (−1 mono … +1 extra-wide M/S), phase invert, swap L/R, pan (balance), volume, mute. Then meter, then out to every `routes` target × level.
  - The master insert outputs to the device × `transport.masterVolume`.
  - **Solo:** if any insert is soloed, mute every insert that is not soloed AND does not feed a soloed insert. The master is never muted by solo.
  - Process inserts in topological order (routes and sidechains are edges). Ignore an edge that would form a cycle and log a `warn`.
  - **PDC:** compensate effect `latency()` along parallel paths. A simple per-insert delay line aligned to the maximum path latency into each summing point is acceptable in v1.
- **Unknown plugin ids** (third-party, not yet loaded) are silent pass-through. Log once.
- **Sparse params:** a missing key in `params` means the descriptor default.
- **Metronome:** when `transport.metronome && playing`, click on each beat (accent on bar starts) straight to the master output.
- **Transport stop:** `all_off()` on instruments, `reset()` on effects, and meters fall to 0.

## 5. Audio output

- Use cpal WASAPI shared mode. Open the default device at startup (or the device from `openDevice`).
- Hold f32 stereo internally; adapt to the device channel count by duplicating or dropping channels.
- **Real-time safety:**
  - The audio callback must never allocate, lock or block (use `assert_no_alloc` in debug builds).
  - Model changes arrive through an SPSC queue (`rtrb`) as prebuilt structures. Old structures go back on a retire queue and are dropped off the audio thread.
- Set **FTZ/DAZ** on the audio thread and register MMCSS "Pro Audio" (`audio_thread_priority` crate, or the `windows` crate).
- **Device loss** (unplug): emit a `device` event, then try to reopen the default device every 2 s.

## 6. Implementation notes (engine v0.1, as built)

These decisions were made during implementation and supersede the text above where they differ:

- **`applied` event:** emitted after a `loadProject` or `apply` reaches the audio thread, as `{"event":"applied","version":N}`. The response to `apply` acknowledges the control-thread model; this event acknowledges the audio thread.
- **`--no-audio`:** runs the full engine without opening a device (CI, headless agents). Telemetry still runs, with the transport driven by a timer.
- **`--render` extras:** `--start <tick> --end <tick> --sample-rate <hz> --tail <sec> --loops <n>`. The defaults are wav24 with a 2 s tail.
- **`RenderRequest.normalize`** (optional, default off; the Export dialog's "Normalize"): after rendering (tail included), both channels are scaled by one gain so the sample peak is exactly −0.1 dBFS (`NORMALIZE_TARGET_DB`). Near-silent renders (peak below −120 dBFS) are written unchanged. `peakDb`, `lufsIntegrated` and `analysis` describe the normalized audio. `loops` (pattern scope) is passed through from `RenderOptions.loops`.
- **MP3 export** (`format: "mp3"`, optional `mp3Kbps`: 128 | 192 | 256 | 320, default 320, ignored by the WAV formats; CLI `--format mp3 [--mp3-kbps N]`). Code: `engine/crates/dsp/src/mp3.rs`, with the Media Foundation plumbing in `dsp/src/decode.rs` (`mf::encode_mp3`).
  - **Encoder:** Windows' own MP3 encoder MFT (Windows 8 and later) behind a Media Foundation Sink Writer, so Krypt ships no MP3 codec (no LAME). Output is constant-bitrate MPEG-1 Layer III, stereo.
  - **Checked before rendering** (`render` answers `ok:false` before any audio is rendered): a bitrate outside the list fails with "MP3 bitrate 100 kbps is not supported: use 128, 192, 256 or 320". A Windows without the encoder fails with "MP3 export needs Windows' MP3 encoder, which is missing on Windows N editions without the Media Feature Pack." That check (Media Foundation loads and `MFTEnumEx` finds a PCM → MP3 audio encoder) is cached once it succeeds.
  - **Sample rate:** 32, 44.1 and 48 kHz renders are encoded as they are. Any other rate is resampled with the dsp's windowed sinc (`blocks::sinc::resample`): the 44.1 kHz family (22.05, 88.2, 176.4 kHz …) to 44.1 kHz, everything else to 48 kHz. Float → 16-bit uses TPDF dither.
  - **Result:** `durationSec`, `peakDb`, `lufsIntegrated` and `analysis` describe the float render (before encoding), exactly as a WAV render of the same job would. `RenderResult.mp3` (`Mp3RenderInfo`) reports `sampleRate`, `kbps`, `samples` (audio samples per channel), `encoderDelay`, `endPadding` and `itunSmpb`.
  - **File contents:** MPEG audio frames only: no ID3v1 or ID3v2 tag and no Xing / Info / LAME frame (CBR, so players get the duration from the size). Windows' MP3 sink itself writes a 431-byte ID3v2.3 tag at offset 0. That tag holds a `TFLT` frame ("MPG/3", UTF-16), a `COMM` frame (language `eng`, description `iTunSMPB`, ISO-8859-1 text), then zero padding. The engine strips it, so main can prepend its own ID3v2.3 tag. To keep gapless playback (iTunes / Apple Music, foobar2000), write `mp3.itunSmpb` back as that same `COMM` frame. The engine corrects its padding and sample-count fields for the real audio, because the sink counts the silent tail pad as audio.
  - **Timing:** Windows' encoder primes 672 samples (`encoderDelay`). Decoders that keep the standard 529-sample decoder delay (ffmpeg without gapless info, symphonia) start the audio 1201 samples late. Windows' decoder removes 528 of those samples, so it starts the audio 673 samples late.
  - **Tail pad:** when it is drained, the encoder drops some frames of its last input. How many depends on how the input reached it, so it varies with CPU load (usually up to about 3 frames, 4 or more seen on a busy machine), and inputs of 1152 samples or fewer produced no frames at all. So 6 frames (6912 samples) of silence follow the audio, and the engine checks every file: if the drain still cut into the audio it encodes again, and after 3 tries the render fails with a message instead of writing a truncated file. The file ends `endPadding` ≈ 2 to 8 frames (about 50 to 190 ms) after the audio.
  - **Atomic write:** the Sink Writer writes `<name>.mp3.enc.part`, which is copied without its tag to `<name>.mp3.part` and renamed over the target. A failed or cancelled export (`cancelRender` also stops the encode) leaves the previous file untouched and no temp files.
  - **Speed:** a 3-minute stereo song encodes in about 0.8 s (≈ 200× real time). The Sink Writer's own throttling is off, because it blocked every write for a timer tick and made the same encode take 4.5 s; the engine caps the writer's queue at 8 MiB of PCM instead. Resampling a 96 kHz render adds about 0.5 s.
- **Stem export** (`RenderRequest.stems: true`, Wave 8a; code `engine/crates/engine/src/render.rs` `run_stems`, tap in `core.rs` `process_stereo_tapped`).
  - **One pass.** The render runs once. After every 32-frame sub-block the engine copies each insert's **post-fader** output: after its effects, stereo separation, phase, swap, pan and volume (and mute, so a muted insert is silent), before it is summed into its targets. The master mix comes from the same pass and is sample-identical to a plain render of the same job.
  - **`path` is a folder.** It is created if missing; a path that is a file fails with "Stem export needs a folder, but … is a file", and an empty path with "Stem export needs a folder".
  - **Files.** One per insert, named `"NN <insert name>.<ext>"`, where NN (2 digits, more past 99) is the insert's position in the mixer (`insertOrder`, master excluded, 1-based, so it matches the mixer's numbers and skipped inserts leave gaps). The master mix is `"NN Master.<ext>"`, numbered after the last insert, so it sorts last. Names are made safe for Windows: `< > : " / \ | ? *` and control characters become `_`, whitespace collapses, trailing dots and spaces go, at most 60 characters; an empty name becomes `Insert NN`. Existing files with the same names are replaced.
  - **Which inserts.** By default every non-master insert whose peak reaches −96 dBFS somewhere in the range; all-silent ones are skipped (logged as `info`). `stemInserts` limits the export to those insert ids and writes them even when silent. An unknown id fails the job before rendering: "Can't export a stem for insert X: it is not in the mixer". The master mix is always written.
  - **Alignment.** Each stem is delayed by its plugin-delay-compensation offset (route delays plus the master chain's own latency), so every stem lines up sample-for-sample with the master file and stems feeding the master sum to it. Stems have the master's exact length (tail included).
  - **Formats.** wav16 / wav24 / wav32f through the same atomic writer as a plain render (`<name>.wav.part`, then rename); `mp3` uses the MP3 path above per file (`mp3Kbps` applies to all; `RenderResult.mp3` describes the master file).
  - **Over 0 dBFS.** Post-fader stems can peak above full scale before the master's limiter. WAV 16 / 24 and MP3 clip them; the engine then logs one `warn` naming each such stem and its peak ("… were clipped in wav24: Kick (+2.0 dB). Export as WAV 32-bit float …"). wav32f keeps them intact.
  - **`normalize`** scales every stem by the master's normalize gain, so the balance stays and the master peaks at −0.1 dBFS.
  - **Result.** `path` = the folder, `files` = every file written (Master last), `durationSec` / `peakDb` / `lufsIntegrated` / `analysis` describe the master mix. `stemResults[]` = `{insertId, name, path, analysis?}` in insert order with the master last (`insertId` = the master's id, `name` "Master"); `name` is the insert's own (unsanitised) name. `analysis` (the full `Analysis` per file) only with `analyze`.
  - **Memory.** Taps stay in memory up to 1 GiB in all (about 20 stereo stems × 3 min at 48 kHz). Beyond that they stream to hidden `.krypt-stem-<pid>-<slot>.f32.part` files in the folder and are read back one stem at a time.
  - **Cancel and failure.** `cancelRender` stops the pass or the file writing at the next stem. A cancelled or failed export deletes every file it wrote and every spill file, so the folder is left as it was. The error is "Render cancelled".
  - **Speed** (release, "Neon Fog" demo: 57 s, 11 inserts): the render pass with taps takes the same time as a plain render (≈6.2 s vs ≈6.5 s, within run-to-run noise). Writing the 12 WAV 24 files adds about 1 s, and `analyze` about 0.15 s per stem.
- **Solo:** a soloed insert also keeps every insert *downstream* of it (its routes to master) audible. Otherwise a soloed insert that routes through a bus would be silent.
- **Pan laws:** channel pan is equal-power with 0 dB in the centre (+3 dB at hard L/R). Insert pan is a linear balance.
- **Sampler pitch / root key:** the engine sends `pitch = key + channel.pitch + fine/100 + (sampleRootKey ?? 60) − channel.rootKey`. The document's `rootKey` always wins; a WAV `smpl` root key only shifts the base. Two sample instruments get no root shift: the Multisampler (SFZ regions map keys) and the Slicer (keys pick slices, §16).
- **Transport:** `toggle` = play/stop. `loadProject` stops and rewinds.
- **Preview and metronome** go through `masterVolume`.
- **Sample changes:** changing a channel's sample (or an audio clip's stretch variant) re-creates its instrument; it doesn't hot-swap. An audio-clip instrument re-created with new audio while playing (sample just loaded, variant ready) restarts the clips spanning the playhead mid-clip.
- **Not yet supported:** ASIO and exclusive mode (WASAPI shared ignores buffer sizes below the system period, 480 frames on most machines); disk streaming (samples are fully decoded into RAM, capped at 30 minutes); re-stretching audio clips under tempo automation (stretch follows the document tempo); delay compensation for sidechain inputs and for the dry path of partly-wet slots.

## 7. Live input: MIDI, recording, controller links

The engine owns every MIDI and audio-input device. Main denies Chromium's `midi` / `midiSysex` permissions in both the request and the check handler (`electron/system/permissions.ts`). On Windows 10, WinMM ports are single-client, so a renderer that opened them would lock the engine out. Engine code: `midi.rs` (parsing, devices), `record.rs` (shared state, timeline maths), `record_hooks.rs` (audio-thread hooks), `record_ctl.rs` (control thread), `input.rs` (audio input + WAV writer). Main: `electron/input/liveInput.ts`; take planning is in `shared/live/recording.ts`.

### Commands

| cmd | params | data | notes |
|---|---|---|---|
| `listMidiInputs` | — | `MidiInputInfo[]` | Rescans now. The engine also rescans every 2 s (hot-plug) and emits `midiInputs` when the list changes. |
| `setMidiInputs` | `autoEnable`, `enabled: {id: bool}` | `MidiInputInfo[]` | Main persists the policy in settings. Devices missing from `enabled` follow `autoEnable`. An enabled device that can't open reports `error`. |
| `setMidiTarget` | `channelId \| null` | `{resolved}` | The channel incoming notes play. It follows the UI selection and is re-resolved after every rebuild. |
| `listInputDevices` | — | `DeviceInfo[]` | WASAPI capture devices. |
| `setAudioInput` | `deviceId?`, `channels?` (0-based, 1 or 2), `monitor?`, `meter?` | `InputStatus` | The stream is open only while (armed and recording audio), monitoring, or `meter` (the Recording Studio's mic test: open for `inputPeak` only, not monitored, not recorded; main never persists it). |
| `setRecord` | `armed`, `midi`, `audio`, `countInBars` (0..4), `dir?`, `name?` | `RecordStatus` | Takes are written to `<dir>/<name> take N.wav`. |
| `recordStatus` | — | `RecordStatus` | |
| `debugMidiIn` | `bytes: number[]`, `device?` | `{messages}` | **Debug engine builds only.** Feeds raw bytes through the same path as a device, for smoke tests without hardware or loopMIDI. |
| `virtualMidiIn` | `device` (`"Krypt: …"`, ≤ 64 chars), `bytes` (1..64 whole note / CC messages: status 0x80..0xBF + 2 data bytes) | `{messages}` | Gamepads and keyboard pads (see *Virtual MIDI inputs*). Anything else is refused. |

### Events

- `midiInputs {inputs}`
- `midiCc {device, channel (0-based), cc, value}`: throttled to at most 100 Hz per (device, channel, cc); the last value of a burst always arrives.
- `recorded {take, final, mode, patternId, startTick, notes[], audioPending, audio?, error?, passes?}` (`RecordedTake`). Notes carry `pass`; `passes` is set for song-mode loop recordings (§13).
- `inputStatus {status}`: the input device was lost.

### Telemetry additions

- `midiIn`: a counter of MIDI messages received, for the activity LED.
- `rec`: `'countIn' | 'recording'`.
- `countIn`: beats left.
- `inputPeak [L, R]`: sent only while an input is open.
- `monitorPeak`: sent only while input monitoring is running (on, and the input and output share a sample rate): the peak of the input that actually reached the output since the last frame. 0 means monitoring is on but no input audio is arriving at the output.

### Timing

- **Live notes.** A MIDI message is stamped on arrival with the engine clock. It plays in the next audio block at frame `(arrival − previous block start) × sr`. That is a constant one-block delay with no block-sized jitter (`record::event_offset`).
- **What plays.** Note on/off play the target channel's full chain, transport running or not. Live events sort between sequenced note-offs and note-ons. A note-off always reaches the channel its note-on went to, even after a retarget.
- **Controllers.** Sustain (CC64) defers note-offs. CC120/123 release everything. Pitch bend and mod wheel are parsed but not applied yet (v1); other CCs only go to main.
- **Recorded MIDI tick.** It is the tick of the note's playback frame minus `(block frames + output latency) × ticks/frame`: what the player heard when they hit the key. If that falls before the loop start after the take has wrapped, it maps to the end of the previous pass; on the first pass it clamps to the loop start (`compensate_tick`). Durations use a monotonic take clock.
- **Audio takes.**
  - The audio thread publishes the heard-time window `[take start, take end)`: block start + output latency + offset.
  - The input callback writes input frame `i` (captured at `callback time − input latency + i/sr_in`) only inside that window. Input and output latency are both compensated.
  - If the stream opened after the take began, leading silence keeps frame 0 at the take start.
  - Frames go through a lock-free chunk ring to a writer thread: 32-bit float WAV, written as `.part`, then renamed.

### Recording behaviour (FL-like)

- **Arming.**
  - Arm + Play records. Arming while playing punches in; disarming punches out.
  - With `countInBars > 0`, Play first counts in on the metronome, which clicks even with the metronome off; then the transport starts from its position.
  - While armed, song mode without a loop region plays past the last clip instead of looping, so a take can extend the song.
- **Pattern mode.** Notes go into the looping pattern and overdub on every pass. The engine reports each pass (`final:false`) and the remainder on stop (`final:true`). Ticks wrap at the pattern length and durations are clamped so a take never lengthens the pattern.
- **Song mode (MIDI).**
  - If a clip of the active pattern covers the take's start, notes go into that pattern through the clip: `songTick − clip.start + clip.offset`, wrapped.
  - Otherwise main creates a new pattern, places its clip at the bar where recording started on the first free track (adding a track if none is free), and makes that pattern active.
- **Song mode over a loop region.** Each loop pass is a take: see §13 Takes.
- **Audio.** On the final report main runs `samples.add` + `playlist.addAudio` on the first track that is free over the clip's span (adding a track if needed). The clip goes at the take's start tick in song mode, and at bar 1 in pattern mode.
- **Undo, quantize, feedback.** Each take, including both its MIDI and audio halves, is ONE undo group (actor user). The optional quantize (`settings.recording.quantize`, ticks) snaps note starts. A silent or failed take is reported, never dropped.
- **Monitoring.** The input is mixed into the master bus (through `masterVolume`). This needs the input and output to run at the same sample rate, and is otherwise refused with a warning.

### Virtual MIDI inputs (gamepads and keyboard pads)

- **What.** Controller maps (`shared/live/controllers.ts`, `settings.controllers`) turn gamepad buttons, sticks and triggers (the renderer's Gamepad API: XInput / Xbox, DualSense / DualShock, Switch Pro, generic HID pads) and computer keys into note and CC messages. `src/input/controllers.ts` runs them and sends `virtualMidiIn` through main (`midi:virtualIn`, validated again there).
- **Same path as hardware.** The engine feeds the bytes into the MIDI sink under the map's device name: notes play the MIDI target and record, sustain works, CCs go to main as `midiCc` (controller links key on that device name) and the launcher grid filter applies. Virtual inputs are not listed by `listMidiInputs` and ignore the per-device enable policy (each map has its own switch).
- **Timing.** Pads are polled every 8 ms; a message is stamped when the engine reads it, so it plays one block later like any live note, plus the IPC hop (about 1 ms).
- **Releasing.** Unplugging a pad or hiding the app releases its held notes; a window blur releases the keyboard maps' keys. Commands (play, record arm …) run in the renderer and never reach the engine.

### Controller links (MIDI-learn)

- "Link to controller…" makes main wait up to 30 s for the next `midiCc`, then store `{id, device, channel, cc, paramRef, label, min?, max?}` in `settings.midi.mappings` (global, like FL "Remote control").
- One CC drives one parameter. Re-linking replaces the old link.
- Incoming CCs run `params.set {normalized: true}` with `coalesceKey midi:<paramRef>`, so one twist is one undo entry.

## 8. Third-party plugins: VST3 and CLAP (no VST2)

The engine never loads plugin code. `krypt-studio-pluginclient` (in the engine) spawns **one** `krypt-studio-pluginhost.exe --serve` per engine process and talks to it over the host's stdin/stdout (NDJSON). Audio crosses **shared memory**: one file mapping plus an auto-reset event pair per instance, one synchronous round trip per 32-frame sub-block (spin, then wait). A crash or hang only kills the host. The affected instances go silent, and the engine and app keep running.

- **Ids.** Plugins are `vst3:<32-hex CID>` or `clap:<plugin id>`. The stock factory returns None for them; the compile pass then creates a `RemoteInstrument` / `RemoteEffect` proxy (hooks in `compile.rs`, marked "Third-party hook").
- **Params.** Descriptors come from the Plugin Manager scan (`--scan`) and are registered with `plugins.register`. Param ids are the plugin's own ids as decimal strings. CLAP values are plain; VST3 values are normalized 0..1, or step indices for stepped params. Only params set in the document are sent at load; the plugin keeps its own values for the rest.
- **State.** `generator.state` / `slot.state` hold a base64 blob: the raw CLAP state, or `"KV3S"` + component + controller state for VST3. Main reads live states with `plugins.states` before every save and stores them with the `plugins.setStates` command. The engine passes the blob to the host when it creates the instance.
- **Loading is asynchronous.** A proxy outputs silence (instruments) or passes audio through (effects) until the host reports the plugin ready. Offline renders wait for loading.
- **Latency.** The host writes the plugin's latency into shared memory, and `refresh_latencies` picks it up for PDC.

### Commands

| cmd | args | reply |
|---|---|---|
| `plugins.configure` | `hostExe?`, `ownerHwnd?` (decimal string) | `{}` |
| `plugins.register` | `plugins: PluginDescriptor[]` (with `path`, `format`) | `{registered, errors}`. Entities whose plugin was unknown are retried. |
| `plugins.editor` | `key`, `open`, `title?`, `ownerHwnd?` | Opens or closes the plugin's native window: a top-level window **owned** by `ownerHwnd`. |
| `plugins.state` / `plugins.states` | `key` / `keys?` | `{state}` / `{states: {key: base64}, errors}` |
| `plugins.reload` | | Kills the host. Every third-party instance is re-created, with the document's state. |
| `plugins.status` | | `{hostPid, instances: [{key, pluginId, name, state, hasEditor}]}` |

`key` is the engine entity: a channel id, or `insertId/slotId`.

### Events

- `{"event":"plugin","kind":"crashed","keys","names","message","reloading"}`. The host crashed (instances silent until `plugins.reload`) or hung. On a hang the watchdog killed the host and, at most once a minute, reloads it automatically (`reloading:true`).
- `{"event":"plugin","kind":"loadFailed","key","pluginId","message"}`
- `{"event":"plugin","kind":"editor","key","open":false}` when the user closes the plugin window.
- `{"event":"plugin","kind":"param","key","paramId","value"}` when the user edits a control in the plugin's own window. Main coalesces these into `channels.setGenParams` / `mixer.setSlotParams`.

### Watchdog

- The host's UI thread answers a ping every 0.5 s. Two misses (3 s timeout, 60 s while a plugin is loading) kill the host.
- A `process()` call blocks the audio thread for at most 30 ms (10 s offline). After that the block is silent.
- An instance that stays busy for 2 s is flagged as hung, and the host is killed.
- CLI renders take `--plugins <scan-cache.json>` and `--plugin-host <exe>`.

## 9. Sound packs and Krypt Multisampler

Optional, user-downloaded multisampled instruments (research/12; contract in `shared/packs/types.ts`). Engine code: `dsp/src/instruments/multisampler/` (`sfz.rs` parser, `build.rs` + `load.rs` loading, `kernel.rs`, `mod.rs` playback) and `engine/src/samples.rs` (paths, cache).

### `pack:` paths and `--packs-dir`

- **Scheme.** `pack:<pack id>/<path inside the pack>`, e.g. `pack:grand-piano/grand.sfz`, resolves to `<packs dir>/<pack id>/<path>`. The id must match `[a-z0-9][a-z0-9-]*`. The inner path must be non-empty, with no empty, `.` or `..` segments. This mirrors `parsePackPath`, and the engine also refuses `\` and `:`.
- **`--packs-dir <dir>`.** Accepted in stdio mode and with `--render`. Main passes `userData/packs`. The folder may not exist yet (fresh install). Paths resolve lazily, only when a channel uses one.
- **Failures warn and never fail.** The channel stays silent and the project still loads or renders. The engine logs one `warn` per message:
  - no `--packs-dir`: "Sound pack `<id>` isn't installed or the packs folder is unknown …";
  - pack folder missing: "Sound pack `<id>` isn't installed: download it in Home > Sounds > Sound packs";
  - malformed path: "'…' is not a valid sound pack path".
- **Absolute paths.** Main may also resolve `pack:` itself and send absolute `.sfz` paths (stdio mode). A failed load under `--packs-dir` is reported with the same "isn't installed" sentence.
- **Retrying after an install.** Loads are cached by resolved path + file mtime, and a missing file is cached with no mtime. A `loadProject` after a pack install therefore reloads it, and the channel's instrument is re-created with the set.
- **Older engines.** An engine that predates this flag exits with `Unknown argument '--packs-dir'` on stderr (exit code 2), and main retries without the flag.

### `krypt.multisampler`

- **Sample.** The channel's sample is an `.sfz` file (`pack:`, absolute or project-relative). A plain audio file also works: it becomes one region across the keyboard, with root = the WAV `smpl` key or 60, like `krypt.sampler`. An `.sfz` on any other instrument warns and stays silent.
- **Loading (off the audio thread).**
  - The live engine loads on the sample-loader thread; offline renders load synchronously.
  - The file is parsed, then every distinct `sample` + `offset` + `end` range is decoded once with the dsp decoder (WAV / FLAC / OGG / MP3 / AIFF via symphonia, MF formats via Media Foundation).
  - Decoding runs on up to 8 threads and stops at `end`, so trimmed long samples cost only what they keep.
  - Samples are stored as i16 interleaved (mono or stereo) at their own rate, in one immutable `Arc<MultiSampleSet>`. It is cached by `.sfz` path + mtime and shared by every channel that uses it.
  - **RAM cap: 600 MB of decoded audio per instrument.** Over the cap, the instrument is refused with a `warn` that says so.
  - Missing or undecodable files only silence their regions (one `warn` lists them). No playable region at all → `warn`, silent channel.
  - An `info` log reports `Loaded <name>: N regions, N samples, X MB in N ms`. On an i7-10700K (release build), 200 regions / 146 MB of 24-bit 48 kHz WAV load in ~0.12 s from a warm disk cache.
- **SFZ subset** (= `SFZ_OPCODES`, plus `ampeg_delay`):
  - Headers: `<control>` (`default_path`), `<global>`, `<master>`, `<group>`, `<region>`. Inheritance runs global → master → group → region. A new `<global>` resets master and group; a new `<master>` resets group.
  - `#define $NAME value` is substituted in later lines. `//` and `/* */` comments are stripped.
  - Values run to the next `opcode=` or the end of the line, so sample paths may contain spaces. `\` becomes `/`.
  - Keys accept numbers or note names: `c4` = 60, `c#4` = `db4` = 61.
  - Aliases: `loopmode`, `loopstart`, `loopend`, `offby`, `pitch` (→ `tune`). `pitch_keycenter=sample` uses the file's root key.
  - Not supported, each with one `warn`: `#include`; other headers (`<curve>`, `<effect>` …, their opcodes are ignored); generator samples (`*sine`); any other opcode (ignored and counted, e.g. "ignored 3 unsupported opcodes (…)").
- **Playback** (audio thread: 128 preallocated voices, no allocation, locks or I/O):
  - **Region match:** key + velocity (`round(vel × 127)`, at least 1). `xfin_*` / `xfout_*` are equal-power velocity crossfades.
  - **Round robin:**
    - `seq_length` / `seq_position` use a counter per region that advances whenever the region is eligible.
    - `lorand` / `hirand` share one random number per note.
    - The `roundRobin` param Off always plays position 1 and the random value 0.
  - **Pitch:** `(key − pitch_keycenter) × pitch_keytrack/100 + transpose + tune/100 + (engine pitch − key)` semitones. The engine pitch carries channel pitch, note fine and the root-key shift. The instrument's `tune` / `fine` are added (smoothed).
    - The sample-rate ratio goes into the playback step.
    - Interpolation is the sampler's windowed sinc. When pitching up, the kernel comes from a precomputed per-semitone polyphase bank (same kernel, cutoff rounded down a semitone at most).
  - **Level:**
    - `volume`, `pan` (combined with note pan).
    - `amp_veltrack` × the `velSens` param on SFZ's square-law curve: gain = 1 − t·(1 − vel²).
  - **Envelope:**
    - DAHDSR from `ampeg_*`; the `attack` param (ms) is added and the `release` param scales `ampeg_release`. Releases are at least 5 ms (no clicks).
    - Samples cut short by `end=` fade over their last 100 ms (at most a tenth of the sample); natural ends get 2 ms.
  - **Loops:** `no_loop` (default), `one_shot` (note-off ignored), `loop_continuous`, `loop_sustain` (stops looping at note-off and plays out to the end). Loop points are file frames, so `loop_end` is inclusive.
  - **Chokes:** a starting region with `group = g` turns off every voice whose `off_by = g`. `off_mode=fast` fades over 5 ms (the default); `normal` uses the voice's own release.
  - **Release triggers:** `trigger=release` regions fire on note-off with the note-on's velocity. Their level is `releaseSamples` × 10^(−`rt_decay` × held seconds / 20). With `releaseSamples` 0 they are off.
  - **Voices:** a note's layers release together. Past 112 sounding voices the oldest released voice (then the oldest) is faded out over 5 ms. Mono mode fades the previous note over 2 ms; glide and slides are ignored. Live-MIDI sustain (CC64) defers note-offs in the engine (§7); there is no sustain opcode.
  - **Output:** `tone` is a gentle 12 dB/oct low-pass (Q 0.5, bypassed at ≥ 19.9 kHz). `width` blends M/S to mono at 0. `gain` is smoothed.
  - **Cost:** ~13–15 % of one core for 64 sounding voices at 48 kHz (i7-10700K, release build), pitched or not.
- **Params** (fixed ids; `%` params are fractions like everywhere else, the UI shows ×100):

  | id | range | default | notes |
  |---|---|---|---|
  | `gain` | −24..12 dB | 0 | |
  | `attack` | 0..2000 ms | 0 | added to `ampeg_attack` |
  | `release` | 0..4 (0..400 %) | 1 | scales `ampeg_release` |
  | `velSens` | 0..1 | 1 | scales `amp_veltrack` |
  | `tone` | 200..20000 Hz, log | 20000 | low-pass |
  | `tune` | −24..24 st, step 1 | 0 | |
  | `fine` | −100..100 ct | 0 | |
  | `releaseSamples` | 0..1 | 1 | level of `trigger=release` regions |
  | `width` | 0..1 | 1 | 0 = mono |
  | `roundRobin` | Off / On | On | |

## 10. Clip launcher

The Session view's engine half (research/16 §2.1). Engine code: `launcher.rs` (compiled program, slots, control-thread commands, telemetry), `launcher_hooks.rs` (the audio-thread state machine; a child of `core` like `record_hooks.rs`, call sites marked `launcher:`). Main sends the session as the `scene` / `launchClip` / `session` entities (`shared/engine/projection.ts`). The `session` value `{quantize, sceneOrder, clipIds}` prunes launch clips missing from `clipIds` and scenes missing from `sceneOrder`.

### Commands

| cmd | params | data | notes |
|---|---|---|---|
| `launch` | `clipId`, `release?` | `{}` | Queue the clip at its quantize boundary. While stopped: start the transport now (see below). `release` = key / button up (gate, repeat). Unknown id → `ok:false`. |
| `launchScene` | `sceneId` | `{}` | Every track's clip in that row launches; tracks that have launch clips but none in that row stop (global quantize). Tracks with an empty column are untouched. Scene tempo is main's doc edit. |
| `launchStop` | `trackId \| null` | `{}` | Stop one track (global quantize; overrides it even if it was playing the arrangement), or every track playing / queueing a launch clip. While stopped it only overrides. |
| `backToArrangement` | — | `{}` | Immediately: every launch clip stops, every override and queue is cleared. |
| `setLaunchRecord` | `on` | `{on}` | See launch recording. |
| `setLaunchGrid` | `device`, `channel`, `notes` | `{notes}` (count) | Replaces the grid map; `{}` turns it off. Keys are note numbers `"0".."127"` (else `ok:false`). `channel` is 0-based. |

Launch commands travel the normal command ring to the audio thread as stable slots (track / launch clip / scene slots survive rebuilds, like channel slots), so a `launch` right after the `apply` that created the clip works.

### Timing

- **Two clocks.** Arrangement events run on the transport position. Launch clips run on a monotonic launcher clock (ticks generated while playing): song-loop jumps, locates and pause/resume never restart them. Each clip carries its own elapsed ticks, chained exactly from event window to event window, so every pass start and note is generated once.
- **Quantize grid.** Song mode: the song bar grid from tick 0 (`1/16` … `8bars`, in the time signature), so after a loop jump the next grid point is wherever the song position reaches one. Pattern mode: ticks since the transport last started (play or resume). `none` (and a clip `quantize` of `none`) takes effect at the current frame. A clip without `quantize` uses the session's.
- **Launching while stopped** starts the transport from its position with no quantize wait. A pattern-mode document plays in song mode until the next stop (`mode_override`; telemetry reports `song`). A record count-in still runs first; the launch waits for it. Launching while the transport plays in pattern mode keeps pattern mode: launch clips play over the looping pattern.
- **Sample accuracy.** An event window is split at every launcher transition: notes before the boundary play, the old clip's and the arrangement's sounding notes on that track get their note-off on the boundary frame, the new clip starts on it. An unquantized launch starts on the current frame's tick (not half a frame early), so its loops stay on the frame grid.

### Playback

- **Pattern launch clips** play the pattern's notes on their own channels, exactly like playlist pattern clips (swing, slide, release, pan, mod, chokes, channel mute). Source position = `offset + (elapsed mod length)`; past the pattern length the source repeats the pattern. A note-off is capped at the end of its loop pass. Two clips playing the same pattern both sound.
- **Audio launch clips** trigger their `krypt.audioclip` channel through the playlist audio-clip path (`trigger_audio_clip`): sample position = `offset + position in the pass` at the current tempo, `gain`, the channel's stretch / warp variant, no fades. Every pass retriggers at `offset`. After a loop jump, locate or resume they restart mid-pass at the right position (chase).
- **`loop: false`** plays `length` ticks once, then stops the track (it stays overridden).
- **Muted tracks** (track mute, or another track soloed) run their launch clips silently.
- **Transport stop** stops every launch clip and clears queues; overrides stay. **Pause** keeps clips where they are.
- **Edits while playing** take effect live (pattern notes, length, offset). A playing or queued clip that disappears (deleted, moved to another track, pruned by `clipIds`) stops at once; a deleted track loses its launcher state.

### Override

- A track becomes overridden when a launch clip starts on it or a launcher stop takes effect on it (scene without a clip, `launchStop`, gate release, toggle, follow `stop`, end of a one-shot). Queuing alone does not override.
- While overridden, the track's playlist pattern and audio clips are silent (they are skipped at generation; sounding notes are released on the boundary). Automation clips keep playing.
- `backToArrangement` clears every override. Arrangement pattern notes resume with their next note; arrangement audio clips spanning the playhead restart mid-clip at the right offset (the same re-chase as a sample that finished loading).
- Overrides persist across transport stop; `loadProject` clears all launcher state.

### Launch modes

- **trigger:** note-off / `release` is ignored.
- **gate:** `release` stops the track at the clip's quantize step. Released before its launch boundary, the clip never plays. A gate clip launched by a scene plays like trigger.
- **toggle:** launching the clip that is playing (with nothing queued) queues a stop at its quantize step.
- **repeat:** while held, the clip restarts on every quantize step after it started; `release` cancels the pending restart and the clip keeps looping. With quantize `none` it never repeats.

### Follow actions

- Due `afterBars × bar` ticks after the clip started (exactly then, no quantize). A queued launch on the track suppresses it. At the end of a one-shot clip a due follow action wins over the plain stop.
- `chance` picks `action`, else `otherAction`. The draw is deterministic: splitmix64 of (FNV-1a of the clip id) ⊕ (transport start count ≪ 32 | decision number on that track since the start).
- `next` / `previous` walk the track's clips in scene order, skipping empty slots and wrapping. `first` / `last` of the track. `any` draws among all of the track's clips (may repeat). `other` draws among the others (with one clip it keeps looping). `again` restarts the clip, `stop` stops the track, `none` keeps looping.

### Launch recording

- `setLaunchRecord {on:true}`: while the transport plays in **song mode**, the audio thread logs a span per track: `{trackId, clipId, startTick, endTick, offset}` in song ticks, `offset` = the clip's source position at `startTick`.
- A span closes when the track switches clip or stops, at a song-loop jump or locate (a new span opens at the new position with the then-current source position), on a switch to pattern mode, and on stop / pause / switch-off. A span covers consecutive loop passes; main splits it at pass boundaries when the clip's loop (`offset`, `length`) differs from the source's natural loop.
- **Event policy:** one `launchRecorded {entries}` on transport stop, pause, or `setLaunchRecord {on:false}`, sent only if recording was on and the transport ran in song mode since the last event. `entries` may then be empty (the transport ran but nothing launched). Turning recording on and off without playing sends nothing.
- No allocation on the audio thread: spans go through a 4096-entry lock-free ring drained by the control loop (≤ 10 ms), which maps slots to ids.

### Grid controllers

- The MIDI driver thread checks each note-on / note-off against the map (`device` = a MIDI input id or `null` for any, `channel` 0-based or `null` for any). Matching notes are swallowed there: they never reach the MIDI target, the audio thread or a recording (the activity counter still counts them).
- Note-on → `{clipId}` launches, `{sceneId}` launches the scene, `{stopTrackId}` stops (null = all). Note-off (or note-on velocity 0) → `release` for clip pads; scene and stop pads ignore it. Ids resolve when the note arrives.
- The control loop forwards grid notes within 10 ms, so an unquantized grid launch can land up to 10 ms later than a UI launch. LED feedback and Launchpad side-button CCs: §14.

### Telemetry

`TelemetryFrame.launcher` is present while the project has launch clips: `playing {trackId: clipId}`, `queued {trackId: clipId | 'stop'}` (a repeat clip shows itself queued while held), `progress {clipId: 0..1}` (loop position), `overridden [trackId]`, `recording`.

### Offline render

Renders ignore the launcher: no launch commands reach a render core, and its launcher state starts empty. A render always plays the arrangement, never overrides.

## 11. Warp

Contract: `shared/schema/warp.ts` (Rust mirror `WarpMap` in `model_ext.rs`, on `Generator.warp` of `krypt.audioclip` channels). Engine code: `engine/src/warp.rs` (resolve, time map, beats / texture / repitch) and `engine/crates/stretch` `stretch_mapped` (complex / tones). A warped clip is a **variant** like any stretched clip (§4 audio clips): rendered off the audio thread, cached, `stretch` pending events, silence while a new timing renders, mid-clip resume, offline renders wait for it.

### Timing

The time map takes a source time `t` (seconds) to a variant time (seconds); the variant is played by the unchanged clip path (`(songTick − clip.start + clip.offset)` → seconds at the project tempo → variant frame), so variant second `x` is song beat `x × bpm / 60` from the clip's sample start.

- **2 or more markers:** `variant(t) = beatOf(t) × 60 / bpm`, with `beatOf` piecewise linear through the markers `(sec, beat)` and the first / last segment's rate continuing before / after the markers (exactly `secToBeat` of `warp.ts`). The Stretch params `stretch`, `tempo_sync` and `src_bpm` are ignored (and the missing-Source-BPM warning is not shown).
- **1 marker:** the Stretch ratio `r` (§4), shifted so the marker lands on its beat: `variant(t) = beat × 60 / bpm + (t − sec) × r`.
- **0 markers:** `variant(t) = t × r` (the pre-warp timing).
- **Start and length:** the variant starts at beat 0 (variant second 0 = the clip's sample start). Source audio that maps before 0 is dropped; a map whose source start maps after 0 leaves leading silence. The variant ends where the source end maps: `round(variant(fileLength) × sr)` frames at the sample's own rate (0 if that is before beat 0; longer than 30 minutes is refused with a `warn`, clip silent).
- **No-op markers** count as no markers: one marker at `sec × r = beat × 60 / bpm`, or all markers at `sec = beat × 60 / bpm` (the clip at its own tempo).
- **Invalid maps** (any `sec` / `beat` not strictly increasing, negative or non-finite, or more than 2048 markers) fall back to the Stretch timing, with one `warn` per channel ("… playing with the Stretch timing"); the mode still applies. An unknown mode plays as `complex`, an unknown `beatsSlice` as `transients`, each with a `warn`. Mode settings out of range are clamped to the contract's ranges.

### Identity

Bit-identical to a clip without `warp` (the stretcher never runs) when there are no (effective) markers and either the mode is `complex` or the Stretch ratio is 1 and the pitch is 0 st (0 st is implied in `repitch`). `complex` without markers is exactly the plain stretch variant (same cache entry).

### Variant key

Sample identity, Stretch ratio (forced to 1 with 2 or more markers), pitch (0 in `repitch`), formant flag, plus the warp key: mode, markers (quantized to 1e‑9 s / 1e‑9 beat), the project bpm (1e‑6; only with markers or a beats grid — without markers the tempo is already in the ratio) and the settings the mode uses (`beatsSlice` + `beatsFadeMs` for beats, `grainMs` + `flux` for texture; the others are ignored, so changing them never re-renders). **Timing** for the keep-playing rule (§4) = (ratio, marker hash): changing only the mode, pitch or mode settings keeps the current audio playing while the new variant renders; moving a marker or changing the tempo (with markers) silences the clip until the new timing is ready.

### Modes

All modes are deterministic (fixed seeds; the same map and audio give the same samples). The first 1 ms of every warped variant is a raised-cosine fade-in from 0.

| mode | algorithm | pitch | notes |
|---|---|---|---|
| `complex` | Signalsmith Stretch, 120 ms blocks / 30 ms hop (`config_for`, hop shrinking for strong speed-ups, as §4). ONE stretcher for the whole file; the in/out proportion of each `process` call follows the map and calls are split at every marker, so segments join without seams. | `pitch` + `formant` | Full mixes. |
| `tones` | Same, with 60 ms blocks / 12 ms hop (5× overlap). | `pitch` + `formant` | Vocals, bass, leads. Measured on a ±1 st vibrato voice and a 4-octave sine glide: 10 ms envelope wobble 1.5–4× lower than complex, level within ~7 %. No tonality limit (it detunes the high harmonics of pitched sounds, and measured no benefit). |
| `beats` | Slices at transients (default) or a grid. Each slice is copied at original speed to `variant(sliceStart)`, for at most its own length and never past the next slice's warped start, with a raised-cosine fade-out of `beatsFadeMs` (default 20, 0..200) ending where it stops. Gaps stay silent at slow tempos; slices are cut short at fast ones. | per slice: Signalsmith at ratio 1 (`pitch` + `formant`) | Drums. Onsets are sample-exact (same rise as the source, no pre-echo). |
| `texture` | Granular overlap-add: Hann grains of `grainMs` (default 80, 10..500), one every grain / 4 of output. A grain centred on variant frame `c` reads the source around `inverse(c) + (0.25 + 0.75 × flux) × grain × u`, `u` uniform in [−1, 1) from a fixed-seed generator (one draw per grain, in order). Even at `flux` 0 grains are decorrelated by ±¼ grain (at one fixed offset, overlapping grains comb-filter tonal material: −18 dB measured), and the sum is scaled by 1/√1.5 (power sum of the windows), so the level holds within ±2 dB on noise, tones and bass at any flux / ratio. | grain resampling (windowed sinc, anti-aliased), `formant` ignored | Pads, noise, ambience. |
| `repitch` | Varispeed: variant frame `o` reads the source at `inverse(o)` with windowed sinc (anti-aliased when faster), so the pitch follows the local speed like a turntable. | follows speed; the Stretch `pitch` is **ignored** | |

**Transients** (beats): 2.5 ms frames of the first difference of the mono mix; an onset is a frame ≥ 9 dB above the max of the 3 frames before (or ≥ 30 dB above the frame before: a sound after a short gap) and within 50 dB of the loudest frame, ≥ 40 ms after the previous onset. It is moved back to where the attack starts (first sample ≥ 20 % of the attack's peak, searching from one frame earlier) and then to the preceding zero crossing (≤ 1 ms). Slice 0 always starts at frame 0; a slice longer than 0.25 s of source is split evenly, so material without transients still follows the map. Transient slices fade in over 0.1 ms. **Grid** (`1/16`, `1/8`, `1/4`): slice starts at the source times that map to every grid line of the warped timeline (`k × 60 / bpm / division`), plus 0; grid slices fade in over 1 ms.

### Cost

30 s stereo 48 kHz, 17 markers, release build, i7-10700K, one core, ms of compute per second of output: complex 18 (21.6 at +3 st), tones 20.5 (27.5), beats 0.4 (23.8: pitch runs per slice), texture 8.6 (36.4: resampling faster than 1:1 uses the long sinc), repitch 2.4. Memory: the source plus one output buffer (beats + pitch: one slice at a time).

## 12. Racks and macros

Contract: `shared/schema/rack.ts` (Rust mirror `RackDef` in `model_ext.rs`). Engine code: `engine/src/rack.rs` (the composites) and `engine/src/rack_compile.rs` (planning, a child of `compile.rs`). Descriptors: `dsp/src/catalog.rs` `rack_descriptors()`.

### Devices

| id | kind | rack data | what |
|---|---|---|---|
| `krypt.rack` | instrument | `Generator.rack` (kind `instrument`) | chains of instrument + effects, picked per note by zone, summed |
| `krypt.drumrack` | instrument | `Generator.rack` (kind `drum`) | one chain per pad (zone `keyLo = keyHi`), plus choke groups |
| `krypt.fxrack` | effect | `FxSlot.rack` (kind `effect`) | the input split into every chain, chains summed |

- **Params.** Each has exactly `macro1`..`macro8` (0..1, default 0, unit `%`, group "Macros", automatable). Automation (`channel/<ch>/gen/macroN`, `insert/<i>/slot/<s>/macroN`), `params.set`, controller links and MIDI learn reach them unchanged.
- **Catalog.** The dsp factory can't create racks (the engine composes them), so they are not in dsp `descriptors()`. The engine's stock host lists them after the dsp plugins, so `--dump-catalog` and `catalog` include them. A `Session` always knows them, whatever the plugin host.
- **Kind.** The plugin type decides it. A `RackDef.kind` that disagrees warns, and the device plays as its own kind.
- **No rack data** = an empty rack. An empty instrument rack is silent; an empty FX rack passes audio through.

### Chains

- **Order and limits.** Chains play in `chainOrder`, then any chain missing from it by id. At most 128 chains (`MAX_RACK_CHAINS`) and 10 devices per chain (`MAX_FX_SLOTS`, in `deviceOrder`); extras are dropped with a warning.
- **Inner devices** are created through the same factories as channels and slots, with params clamped to the catalog spec. Samples resolve and load like channel samples: `factory:`, `pack:` and project-relative paths; `.sfz` only on the multisampler; async live, synchronous offline. Inner sample ids count as referenced, so the cache keeps them.
- **Skipped with a warning** (the rest of the rack plays):
  - racks inside racks;
  - third-party (`vst3:` / `clap:`) plugins;
  - `krypt.audioclip`;
  - unknown or wrong-kind plugins.
- **Also ignored.** An instrument on an effect-rack chain is ignored. Inner sidechains are not supported in v1: the device warns and runs without one.
- **Gain.** Chain `volume` is linear (1 = 0 dB, max 2). `pan` is a balance law: L × (1 − max(pan, 0)), R × (1 + min(pan, 0)). Gains ramp over each block.
- **Mute / solo** work inside the rack:
  - if any chain is soloed, the unsoloed ones are silent;
  - a muted chain is silent even when soloed;
  - a muted or solo-muted chain gets no new notes.
- **Devices** run in order, like an insert's slots. `enabled` false or `mix` 0 skips a device. A `mix` below 1 blends against a dry copy aligned to the device's latency.
- **NaN / Inf** from an inner plugin is replaced by silence, and that chain's devices are reset. NaN on the input is flushed. The output is always finite.

### Instrument and drum racks

- **Routing.** A note goes to every chain with an instrument whose zone holds it: `keyLo ≤ key ≤ keyHi` and `velLo ≤ vel ≤ velHi`, both inclusive. No `zone` = every note. Note-offs go to every chain, so a zone edit while a note is held never leaves it hanging.
- **Pitch:**
  - Instrument racks play like a channel with root key 60: a sampler chain plays its sample at its own root (WAV `smpl`, else 60) on key 60.
  - Drum pads play their instrument at its root on the zone's `keyLo`. A sample pad plays the sample unpitched on its own note; a synth pad (e.g. `krypt.kick808`) plays at C4 (60).
  - Other keys in a wider zone transpose from there.
  - The multisampler maps keys itself in instrument racks, and plays its C4 on drum pads.
- **Chokes** (drum racks only). A pad with `choke` g > 0 chokes every other pad with the same g just before it plays, through the instrument's `choke()` (a ~2 ms fade). The rack channel's own cut groups still choke the whole rack.
- **Forwarded to every chain:** voice mode (mono / glide), channel cut-group chokes, and transport stop (`all_off`, which also resets chain devices).
- **Sleeping.** A chain does no work while its instrument is idle. If the chain has devices or a PDC delay, it sleeps only after its output has been silent for 0.5 s. A chain holding an echo (`krypt.delay`, `krypt.tapeecho`, `krypt.grain`) never sleeps.
- **Latency.** Chains are delayed inside the rack to the longest chain's device latency (up to 8191 frames), so layers stay aligned. The rack reports that maximum as its `Instrument::latency()`, and the engine compensates it against every other channel (see "Instrument latency (PDC)" below).

### FX racks

- **Signal flow.** Every chain gets a copy of the input and runs its devices, and the chains are summed. A chain without devices passes the input (a parallel dry path).
- **Wet/dry.** The slot's `mix` stays the outer wet/dry, applied by the core around the whole rack.
- **Latency (PDC).** Shorter chains are delayed to the longest one inside the rack. The rack reports that maximum as its `latency()`, so insert PDC, `refresh_latencies` and stem alignment see it.
- **Sleeping.** The insert's FX chain may sleep (`quiet_frames`) only if every enabled inner device could: stock, and not an echo.

### Macros

- **Targets.** `RackDef.macros[i].maps` maps macro i+1 onto one of:
  - `{chainId, kind: 'instrument', param}`;
  - `{chainId, kind: 'device', deviceId, param}` (`param: 'mix'` = the device's wet/dry);
  - `{chainId, kind: 'chain', param: 'volume' | 'pan'}`.
- **Value.** inner = `from_normalized(spec, min + v·(max − min))`: the target's normalized 0..1 space, through its catalog `ParamSpec` scale (log, gain, linear, steps). `min > max` inverts the range.
- **Built-in target specs:** `mix` 0..1 linear; chain `volume` 0..2 `gain` (2·n³); chain `pan` −1..1 linear.
- **Conflicts.** With several maps on one target, the last in macro order wins (macro 1 → 8, then map id order within a macro). The losing maps move nothing. An unmapped target plays its own document value.
- **Bad maps.** A map whose target isn't in the rack warns once and is ignored.
- **When.** Macros are applied when they change (each automation sub-block, or a doc edit), not on a timer.

### Inner params (Wave 12.2b)

Every mappable target inside a rack is also a ParamRef, so `params.set`, `set_params`, automation clips, controller links and MIDI learn reach it. `<host>` is `channel/<ch>` (instrument and drum racks) or `insert/<i>/slot/<s>` (effect racks):

| ParamRef | target | spec |
|---|---|---|
| `<host>/rack/<chainId>/volume` | chain volume | 0..2 `gain`, default 1 (`RACK_CHAIN_VOLUME`) |
| `<host>/rack/<chainId>/pan` | chain pan | −1..1 linear |
| `<host>/rack/<chainId>/inst/<paramId>` | the chain instrument's param (instrument / drum racks only) | the instrument's catalog spec |
| `<host>/rack/<chainId>/dev/<deviceId>/<paramId>` | a device's param | the device's catalog spec |
| `<host>/rack/<chainId>/dev/<deviceId>/mix` | a device's wet / dry | 0..1 linear |

- **Parsing.** `parseParamRef` / `formatParamRef` round-trip these (TS `{scope: 'rack', host, target}` with `target` shaped like a macro target; Rust `ParamRef::Rack { host, chain, what }`). Empty segments, unknown tails and `inst` on an effect rack resolve to nothing.
- **Doc writes** (`setParamValue`) write the chain's `volume` / `pan`, the instrument's or device's `params`, or the device's `mix`, clamped to the spec. They reach the live rack as param-only edits (no rebuild).
- **Automation.** The compiler resolves the ref to the rack's target index (`rack_compile::RackTargets`) as `TargetKind::RackInst { ch_slot, target }` or `RackFx { fx_slot, target }`. The core writes the automated value with `set_param(rack::AUTO_BASE + target, plain)` (`AUTO_BASE = 2^24`, outside the flat vector, never diffed). That sets the target's **automation override**; `NaN` releases it. No rebuild, no click: the same O(1) path as a doc edit.
- **Macro vs automation: automation wins.** effective = override, else (macro ? macro value : base). While an automation clip holds a value for a param, a macro mapped onto it moves nothing, and doc edits of the knob change only the base underneath.
- **Release.** The override stays after the clip ends (automation holds its last value, §4). When the target leaves the program (its clip or automation is deleted or retargeted), the core releases it at the program swap (`Core::rack_auto_swap`), so the macro, or the document value, takes the knob back. A target that survives a rebuild keeps its override; it is re-sent to the (possibly new) rack instance.
- **Commands.** `rack.create` (wrap) moves automation of the wrapped instrument / effect onto the same knob inside the rack (`movedAutomation`). `rack.removeChain`, `rack.removeDevice` and an instrument change in `rack.setInstrument` unassign automation aimed at what went away (`clearedAutomation`). Replacing the rack itself (`rack.build`, `rack.sliceToPads` on its channel or slot) unassigns every inner ref.

### Edits without clicks

Everything a doc edit can change without changing the rack's **structure** lives in one flat param vector. It is diffed like any plugin's params and sent as `set_param(index, value)`:

| range | content |
|---|---|
| 0..8 | `macro1`..`macro8` (the descriptor params) |
| 8 + 7·c + f | chain c settings: mute, solo, keyLo, keyHi, velLo, velHi, choke |
| then 1 per device | device `enabled` (chain-major) |
| then 4 per target | base value (plain), macro (0 = none, 1..8), min, max |

Targets run chain-major: chain volume, chain pan, the instrument's params in descriptor order, then each device's `mix` and params.

- **Automation overrides** of inner params use `set_param(AUTO_BASE + target, v)` (see "Inner params"); those indices are not part of the vector.
- **Param-only edits** reach the live instance as `set_param`: inner params, `mix`, `enabled`, chain volume / pan / mute / solo / zone / choke, macro maps and macro values. Voices keep ringing, tails keep decaying, and nothing clicks. Edits apply eagerly, so `latency()` is right the moment the core asks.
- **Structural edits** re-create the whole rack: chains or devices added, removed or reordered; an instrument or device type changed; an inner sample changed or finished loading. The structure key is the kind plus, per chain, its id, instrument type and loaded sample (or multisample), and its devices' ids and types, in order.
- **Real time.** After construction nothing allocates, locks or does I/O. Chain buffers, PDC rings (8192 frames per chain) and dry buffers are preallocated in `new` / `prepare`. Inner devices are wrapped in `fxmix::LatencyAligned`, like slot effects.

### Instrument latency (PDC, Wave 12.2b)

- **Report.** `Instrument::latency()` (dsp `lib.rs`, default 0) is the delay between a note and its sound. Instrument racks report their longest chain's device latency (enabled devices with mix > 0). Third-party instruments report the plugin's latency (`pluginclient::instrument_latency`). Stock instruments report 0.
- **Refresh.** The compiler reads it when it creates the instrument. After a batch that installs instruments or changes their params, the core publishes each instrument's latency (`Shared::ch_latency`). `Session::refresh_latencies` (polled every 250 ms with the effects') rebuilds the program when one changed, e.g. a latent device inside a rack was enabled.
- **Compensation.** Per insert u, `in_lat[u]` = the largest latency among the channels that feed it directly. Each of those channels is delayed by `in_lat[u] − own latency` (`ChannelProg::pdc`, after the instrument and before the channel's gain). The insert's input then arrives at `in_lat[u]`, which seeds the insert PDC: `arrive[u]` starts at `in_lat[u]` instead of 0, the summed channel inputs are delayed by `arrive[u] − in_lat[u]`, and route delays follow as before. So a latent instrument stays sample-aligned with channels on the same insert and on other inserts, and stems line up (`stem_alignment` uses `InsertProg::in_lat`).
- **Sleep.** A delayed channel keeps running after its instrument goes idle until its delay line has played out.
- **Limits.** Per-channel delays are capped at `MAX_PDC` frames. The metronome is not delayed.

### Render

Offline renders (song, pattern, stems) build racks like the live engine, with samples loaded synchronously.

## 13. Takes (loop recording and comping)

Recording in song mode over a loop region turns every loop pass into a take (Wave 12.2b). The engine keeps **one continuous audio file** per recording and only reports where the passes are; everything else (take lanes, the comp, crossfades) is document data and ordinary clips, so the engine has no comp logic. Engine code: `record.rs` (`wrap_offset`, `note_pass`), `record_hooks.rs` (the wrap hook), `record_ctl.rs` (`take_passes`). Main: `shared/live/takes.ts` (planning), `electron/input/liveInput.ts` (finisher). Model and commands: `shared/schema/takes.ts`, `shared/commands/takes.ts`.

### What the engine reports

- **Pass boundaries.** When the transport wraps while recording, the audio thread computes the wrap's frame inside the sub-block (`wrap_offset`: the frames after the wrap are `(pos − loopStart) / ticksPerFrame`) and its heard time (`heard_ns`, as for the take start). It sends `Wrap {take, sec, lo, hi}`: `sec` = heard seconds since the take's first frame, which is exactly the offset into the audio take file (frame 0 = the take start; §7 Audio takes).
- **Pattern mode is unchanged:** a wrap still reports that pass's notes (`final: false`).
- **Song mode:** a wrap only records the boundary. The notes are reported once, at the end, each tagged with `pass` (0-based). A note played before a wrap in the same sub-block, or heard just before the downbeat (its latency-compensated tick wraps back to the end of the loop), belongs to the earlier pass (`note_pass`).
- **The `recorded` event** (song mode, at least one wrap) carries `passes: [{startTick, endTick, sec}]`, on every report of the take (the MIDI half and the audio half):
  - pass 0 starts at the take start (it can start mid-loop, or before the loop region); later passes start at the loop start;
  - each pass ends at the loop end, except the last, which ends where recording stopped: its heard length at the current tempo, capped at the loop end (`take_passes`);
  - `End {take, sec}` carries the take's heard length for that.
- Clocks: `sec` uses the engine clock (`midi::now_ns`) like the capture window, so it lines up with the file the input callback wrote. Tempo changes during a loop take are not modelled (the tempo at the end is used for the last pass).

### What main does

`electron/input/liveInput.ts`, inside the take's ONE undo group (§7):

- **Audio:** passes of at least one beat become takes (`shared/live/takes.ts`). With 2 or more, it runs `takes.createGroup` with the file and each pass's `sec`, on the first track free over the span (else a new "Recording" track). With one, the take is placed as before and its clip is trimmed to that pass.
- **MIDI:** passes with notes become takes (one pattern per pass, quantized like any recorded note). With fewer than 2, the notes go where §7 says (overdubbed into one pattern).

### The model

- A **take group** = one track + a span of song ticks. It holds:
  - its takes, in lane order;
  - the comp: sorted `[start, end) → takeId` segments (gaps are silence);
  - a crossfade length in ticks (default 20 ms).
- A **take** = a source (an Audio Clip channel or a pattern), `origin` (the song tick where source position 0 plays: `passStart − sec`), the range it was recorded over, and for audio `srcEnd` (where the file ends).
  - All the audio takes of a group play the same sample. Each has its own Audio Clip channel on one shared insert, because the engine keeps one clip envelope per channel and a crossfade needs two overlapping clips.
- **The comp is materialised as ordinary clips** on the group's track: one clip per segment, with `offset = clipStart − origin`.
  - At a boundary between two audio takes, the incoming clip starts early and the outgoing one ends late, both fading (`fadeIn` / `fadeOut`) over the crossfade.
  - The fade is centred when both takes have audio there. It is one-sided when one has none (a last pass that stopped at the boundary). It is capped at half of each segment.
  - Each comp edit rebuilds the group's clips (found by their take source on the track); no clip ids are stored.
- **Commands** (`takes.*`, one undo step each):
  - `createGroup`;
  - `select` (swipe-comp a range, or a whole take, by `takeId` or `pass`);
  - `setCrossfade`, `clearRange`;
  - `removeTake` (the latest other take fills its places), `moveTake`, `rename`;
  - `flatten` (keep the comp clips, drop the lanes and the unused takes).
- **Cleanup.** Removing the track drops its groups; removing a take's channel or pattern drops that take (`dropTakeRefs`). `checkIntegrity` checks the references and that comps are sorted and don't overlap.
- **MCP:** `comp_takes`.

## 14. MIDI out and clock

MIDI output ports, MIDI clock out, following an external clock (sync in) and grid-controller LEDs (Wave 12.2b). Engine code: `midi_out.rs` (ports, the sender thread), `clock.rs` (clock-out schedule, sync follower, shared state), `clock_hooks.rs` (audio-thread hooks, a child of `core` like `record_hooks.rs`, call sites marked `midi clock:`), `hardware_ctl.rs` (control thread, call sites in `control.rs` marked `hardware:`). Main: `electron/midi/hardware.ts`; LED maps in `shared/live/gridLeds.ts`, settings in `shared/live/midiOut.ts` (`Settings.midiOut`, `LaunchGridSettings.ledOutput`).

### Commands

| cmd | params | data | notes |
|---|---|---|---|
| `listMidiOutputs` | — | `MidiOutputInfo[]` | Rescans now. The engine also rescans every 2 s and emits `midiOutputs` when the list changes. Ids are port names (duplicates get " #2"), like inputs. |
| `setMidiOutputs` | `enabled: string[]` | `MidiOutputInfo[]` | Open exactly these; the rest close (after their `atClose` messages). Main sends the user's outputs ∪ the clock ports ∪ the grid-LED port. Outputs are never opened automatically. |
| `setMidiClock` | `ports: string[]`, `offsetMs?` | `{ports, open, offsetMs}` | Clock out to these ports (only open ones receive it). `offsetMs` −100..100 (+ = later). `ports: []` switches clock out off; ports leaving the set get a Stop (FC). |
| `midiSend` | `port`, `messages: number[][]`, `atClose?: number[][] \| null` | `{sent}` | Raw messages to an open port, written by the sender thread between clock pulses. Each message is validated (status byte first, data bytes < 128, SysEx F0 … F7 ≤ 1024 bytes). `atClose` replaces the messages sent right before the port closes (port disabled, engine exit); `[]` clears them. A port that isn't open → `ok:false`. |
| `setMidiSync` | `device: string \| null` | `{device}` | Follow the clock of this MIDI input id; null = internal clock. The input must be enabled (§7). |
| `setLaunchGrid` | … `cc?: boolean` | | §10. With `cc`, Control Changes whose number is mapped launch too (value > 0 = press, 0 = release): the Launchpad X / Mini MK3 / Pro MK3 send CCs from the scene column and the top row. Main sets it only for the Launchpad layout with a device chosen (a keyboard's sustain pedal must not launch). |

### Events

- `midiOutputs {outputs}`: the output list changed (hot-plug, open errors).
- `midiSync {running, bpm, lost?}`: the sync input started (`running: true`) or stopped the transport. `lost`: its clock stopped arriving while running (for more than max(0.5 s, 8 pulses)); the transport paused and a `warn` log says so.
- `launcherState {playing, queued, overridden, recording}`: `TelemetryFrame.launcher` without `progress`, sent when it changes (checked every control tick, ≤ 10 ms). Main turns it into grid LEDs.

### Telemetry

`sync {bpm, running, locked}` while a sync input is selected: `bpm` = the smoothed external tempo (0.01 bpm; null until two pulses arrived), `running` = between the master's Start / Continue and Stop, `locked` = the estimate has settled (≥ 24 pulses, no outliers). The frame's `bpm` is the tempo actually played (the external one, bent by the phase loop).

### Clock out

- **24 PPQ** on the played-tick clock: pulses are 40 ticks apart in ticks the transport actually played since it started, so loop wraps, pattern loops and tempo automation never disturb the train. Song-loop jumps are not signalled (set the same loop on the other device).
- **Start** (FA) when the transport starts at tick 0, with the first pulse at the same instant. Starting elsewhere sends **Song Position Pointer** (F2, in 16ths, rounded **up**) + **Continue** (FB); the first pulse is the one on that 16th, where the receiver starts. **Stop** (FC) on stop and pause. A **locate** while playing sends Stop + SPP + Continue (realigned); while stopped, SPP (rounded down). Turning clock out on mid-play joins at the next 16th.
- **Timing.** The audio thread stamps each message with the time its frame is heard: a smoothed block clock (callback time + the device's output latency, filtered against the sample clock with a 1/32 gain, resynced after jumps > 20 ms) plus the frame offset. Messages go through a 4096-entry lock-free ring to the `midi-clock` thread (MMCSS "Pro Audio"). It sleeps on Windows' high-resolution timer until a margin before the stamp (the margin adapts to the measured sleep overshoot, 0.2 to 3 ms) and spins the rest. Pulses are produced one output latency ahead of their send time, so the sender always has them early. Measured in the tests on an idle machine: median send error 0 µs, p99 under 50 µs. The USB MIDI driver adds its own 1 ms frame granularity. A negative offset larger than the output latency makes messages late: they are sent at once and counted (`warn` log).
- No allocation or locking on the audio thread. A full ring drops the message and counts it.

### Sync in

- The MIDI driver thread copies realtime bytes (F8 FA FB FC) and SPP (F2) from the sync input into a lock-free ring. Other inputs' clocks are ignored. midir no longer filters timing messages; the note parser still skips them. The audio thread drains the ring at every block.
- **Tempo.** Pulse arrival times feed a follower: the first 48 pulses are averaged (period = span / count), then a second-order delay-locked loop (0.5 Hz bandwidth) smooths the period and the pulse phase. Three outliers in a row (> 25 % of a period) or a gap restart the estimate, so a tempo change is followed within a few pulses. With ±1 ms uniform jitter the estimate stays within 0.1 bpm (tests).
- **Transport.** Start → locate 0 and run from the next pulse. Continue → run from the current position (or from an SPP sent before it) at the next pulse. SPP while stopped → locate; SPP while running → re-anchor at the next pulse. Stop → pause (the position is kept). A synced start never counts in. Stopping locally while synced waits for the master's next Start / Continue; playing locally while the master is stopped plays at the project tempo.
- **Phase.** While running, the transport plays at the external tempo times a correction of at most ±4 %. The correction closes the error between the master's position (pulses since the run started, extrapolated to the heard time of the sub-block) and the ticks played since the run started in about 0.5 s; errors above half a beat jump. With ±1 ms jitter the heard position stays within 1 tick (tests). At the run start the transport jumps ahead by the time the block will be heard after the anchoring pulse.
- **The doc tempo is not changed while synced.** The engine overrides the program tempo on the audio thread and restores the program's own value (or the newest tempo automation value) when sync stops. When the master stops (not on a loss), main writes the external tempo, rounded to 0.1 bpm, into the project as one user undo step "Tempo from external clock" if it differs by ≥ 0.05 bpm and `Settings.midiOut.syncWritesTempo` is on (the default). That keeps tempo-synced audio clips and the grid right after a synced session, without an undo entry per tempo wobble.
- Offline renders never attach the clock rings: renders ignore clock out and sync.

### Grid LEDs (main)

Main computes the LED map from the session (the 8×8 window of `shared/live/launchGrid.ts`) and `launcherState`, and sends only the controls that changed with `midiSend`. The output is `LaunchGridSettings.ledOutput` (null = no LEDs) or, by default, the one paired with the grid's input by name: the same name, else the same name ignoring case, "MIDIIN2 (x)" ↔ "MIDIOUT2 (x)" and In ↔ Out; with "any input", the single output that looks like the layout's device. The LED port is opened automatically, handed back (LEDs off, Live mode) before it changes, and everything is re-sent after an engine restart.

- **Launchpad X / Mini MK3 / Pro MK3** (programmer mode): on connect `F0 00 20 29 02 <0C X · 0D Mini MK3 · 0E Pro MK3> 0E 01 F7` (an unrecognised Launchpad name gets all three; the other models ignore it). `atClose` = every LED off + `… 0E 00 F7` (Live mode). Pads (notes 11..88): empty = off; clip = its colour on the nearest-hue palette entry (5 red, 9 orange, 13 yellow, 17 lime, 21 green, 29 / 33 mint, 37 sky, 41 / 45 blue, 49 violet, 53 magenta, 57 pink; greys → 3 white); queued = channel 2 flash from the clip colour to green; playing = channel 3 pulse green; recording = pulse red; stopping = flash the clip colour. Scene buttons (CC 89..19): dim white or the scene colour with clips, a flash to green when queued, green when the whole row plays. Stop all (CC 98): red while anything plays, dim red otherwise.
- **APC mini (mk1)**: pad velocity 0 off, 5 yellow (clip), 2 green blink (queued), 1 green (playing), 3 red (recording), 6 yellow blink (stopping). Scene buttons 82..89 and track buttons 64..71: 1 on (playing), 2 blink (queued / stopping).
- **Generic**: note-on velocity 127 for playing / queued pads, scenes and stop-all, 0 otherwise, on the grid's channel (channel 1 when "any").

## 15. Meters and scopes

Gain-reduction meters, the Krypt EQ's live spectrum and the Krypt Analyzer display (Wave 12.2b). Engine: `engine/crates/engine/src/meters.rs` (+ `krypt_studio_dsp::scope`). Renderer: `src/live/slotMeters.ts`, `src/live/telemetry.ts`, `src/panels/plugin/{EqCurve,AnalyzerDisplay,GrMeter}.tsx`, `src/panels/mixer/GrBar.tsx`.

### Gain reduction

- `Effect::meter() -> Option<f32>` (default `None`): dB (>= 0) the effect is turning the signal down right now. Reported by Krypt Comp, Glue (blended by its own Mix), Limiter, Squash (overall: band energy as set vs. as squashed; upward lift reads 0), Duck, Gate/Time (its volume engine, blended by its Mix) and Clipper (how far the driven input went over the ceiling). `shared/engine/meters.ts` `GR_PLUGINS` lists them for the UI. FX racks and VST3/CLAP report none.
- After each effect's block the core does `fetch_max` into one atomic per FX slot (no allocation, no locks).
- `TelemetryFrame.gr`: `{ "insertId/slotId": dB }`, 0.1 dB steps, **only slots that reduced since the last frame** (absent = 0). The UI applies the ballistics (instant attack, 40 dB/s fall, 1.5 s peak hold).

### Watched slots (scopes)

- A renderer window sends **up its telemetry socket** `{"t":"watch","slots":["insertId/slotId", ...],"reset"?:[...]}`. It replaces that connection's set; `[]` = none. The engine serves the union of all connections, at most 4 slots. A closed connection drops its set. `reset` restarts those slots' integrated loudness and true peak (they also restart whenever playback starts).
- The core copies each watched slot's output (after its slot mix; a bypassed slot passes its input; a sleeping chain writes silence) into a lock-free ring of atomics (16384 frames per tap). The telemetry thread reads it every frame into a `SlotScope`: EBU R128 via the `ebur128` crate, a 4096-point FFT, correlation over ~300 ms.
- `TelemetryFrame.scopes[key]` (`SlotScopeData`): `lufsM` (400 ms), `lufsS` (3 s), `lufsI` (gated, since the watch / play start), `truePeak` (dBTP, max over the same span), `correlation` (−1..1); null while silent. Every second frame also `spectrum` (96 log-spaced bins 20 Hz–20 kHz, dBFS, 0.1 dB steps; a full-scale sine reads ≈ 0) and `scope` (256 points of the mid channel spanning 1024 samples from a rising zero crossing).
- Bandwidth: a full snapshot is ≈ 2.3 KB, the others ≈ 0.1 KB, so ≈ 1.2 KB per frame (≈ 75 KB/s) per watched slot, only while its window is open. `gr` adds ≈ 15 bytes per reducing slot.

### Offline render

`RenderResult.gainReduction` (`SlotGainReduction[]`): per dynamics slot that reduced at all, `avgDb` (mean over the render), `maxDb`, `active` (share of the render reducing > 1 dB), sampled once per 512-frame block. MCP `render_preview` prints it as a `dynamics` line (and `data.dynamics`), naming idle dynamics slots "never reduced".

### Krypt EQ curve

The window draws the combined response with the engine's exact filter math (`src/panels/plugin/eqResponse.ts` mirrors `Svf::design` + `Svf::magnitude`; `test/meters.test.ts` checks it against the Rust test `combined_response_reference_values`). Handles: drag = frequency (+ gain), wheel = Q, double-click = band on / off, all through `mixer.setSlotParams` (one undo step per gesture).

## 16. Krypt Slicer

Contract: `shared/schema/slicer.ts` (Rust mirror `SliceMarker` in `model_ext.rs`, on `Generator.slices` of `krypt.slicer` channels; research/13 §8.5). Engine code: `dsp/src/instruments/slicer.rs`; `engine/src/compile.rs` builds the slice map.

- **Map.** `slices` is a list of `{id, sec, pitch?, reverse?, gain?}`. The compiler sorts it by `sec`, drops non-finite or negative starts and duplicates, clamps pitch (±48 st) and gain (0..4) and keeps at most 128 (`SliceSet::new`). No `slices` (or an empty list) = the whole sample is slice 1.
- **Delivery.** `Instrument::set_slices(Option<Arc<SliceSet>>)` (default: ignored), called off the audio thread right after `set_sample` when the instance is created. A changed map (moved marker, per-slice edit) re-creates the instance like a sample change; param edits stay `set_param`. Voices sounding at the swap stop.
- **Keys.** Slice N (1-based) plays on key `baseKey + N − 1` (the First key param, default 60). Other keys are silent. The channel's `rootKey` never shifts a slice (no root shift, §6): a slice sounds at its recorded pitch plus `channel.pitch`, the note's fine tune and its own `pitch`. Slides and mono legato don't bend a sounding slice.
- **Region.** Slice N runs from its `sec` to the next slice's `sec`, or to the sample's end with Play to = Sample end. Reverse (per slice, XOR the Reverse all param) plays it from the end back to the start, like the Sampler. A region edge inside the sample fades over End fade (0.1..200 ms, default 3); the sample's own edge just ends. `NoteExtras.sample_start` enters mid-slice with a 1 ms fade-in.
- **Trigger.** One-shot (default) plays to the region's end whatever the note length; Gate releases on note-off (Release). Cut previous (default on) chokes every sounding slice (2 ms) at the next note's offset, so a replayed loop never smears into itself.
- **Not in racks yet.** Rack chains have no slice map, so `rack.*` commands refuse `krypt.slicer` ("use Slice to pads").
