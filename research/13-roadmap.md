# 13: Roadmap after 0.1: parity, the AI lead, and "easiest all-in-one"

**Goal:** make Krypt Studio the program where anyone gets a good, finished song fastest, and where a working producer never hits a wall that sends them back to FL Studio, Ableton or Logic. We will not out-feature FL Studio's 25 years by count. We win on time-to-a-good-song, on AI that actually does the work, and on being free.

**Status at writing** (lead, 2026-10-14): Waves 1–6 are integrated. There are 72 MCP tools and 28 stock plugins (`shared/plugins/catalog.gen.json`), 182 instrument presets and 52 chain presets, 170 factory samples, 5 optional sound packs, 18 genre playbooks, the reference library, stem separation, Krypt Tune and "make something like this song". Typecheck and all 49 TS test files pass. Nothing has been through the real release path yet (see Wave 7).

**Order:** 7 Ship 0.1 → 8 No reason to go back → 9 Only Krypt does this → 10 Easiest all-in-one → 11 Mac. Waves 9 and 10 can overlap once 8's engine work lands.

**Rules that apply to every item** (from CLAUDE.md, `../kryptguidelines.md` and `research/05`):
- **Agent parity:** every new user action is a command in `shared/commands/*`, and also an MCP tool or an argument on an existing one. Agent edits stay undoable per actor.
- **No trade dress or borrowed names:** don't use "Edison", "Slicex", "Gross Beat", "FLEX", "Patcher", "Auto-Tune", "Session View" or "Performance Mode" as feature names. Copy the function, not the look.
- **MIT-compatible only:** no GPL, AGPL or LGPL code linked in. Prefer the OS's own codecs (Media Foundation), as the MP3 export already does.
- **No silent failures:** every action ends in a toast or `{ok, message}`.

Size: **S** = days, **M** = about a week for one agent, **L** = a multi-agent wave.

---

## Wave 7: Ship 0.1 (in progress)

Step 1 was done 2026-10-14: the flaky MP3 export, the silent catches and the stale guide text (see §7.1). What remains:

| # | Item | Owner | Notes |
|---|---|---|---|
| 7.2 | First commit, public GitHub repo, push | **User decision** | The repo has no commits, and `release.yml` only runs on a pushed `v*` tag. Decide whether `research/` and `spikes/` go public. |
| 7.3 | First CI run green | Lead | `ci.yml` and `release.yml` have never run. Expect cold-cache Rust build time, ORT/DirectML staging (`scripts/models/onnxruntime.mjs`) and the 60 min timeout to need tuning. |
| 7.4 | Fresh installer and a clean-machine test | Lead + user | The installer in `release/` dates from 2026-10-11 and predates Waves 3–6. Test it on a VM with no Node, Rust or VC++: install, first launch, the demo plays, MCP connects from Claude Code, a pack downloads, stems on DirectML, uninstall. Also test with Smart App Control on. |
| 7.5 | Real hardware | **User** | A real MIDI keyboard. Real third-party VST3/CLAP plugins (Dexed, TAL-NoiseMaker, Surge XT; hosting GPL plugins is fine, it isn't linking). |
| 7.6 | Packaged-path messages | Lead | Check in the installed build: `electron/mcp/clients.ts` placeholder shim path, the "Run npm run engine:build" texts, and `electron/analyzer/models.ts` "No download published yet". |
| 7.7 | Models mirror repo | **User decision** | `scripflipped/krypt-studio-models`, so model downloads don't hang on one Hugging Face revision. |
| 7.8 | Disk housekeeping | Lead, on a yes | Delete about 32 GB of stale `engine/target-*` folders. Only `engine/target` is used. |

### 7.1 Done 2026-10-14

- **MP3 export could lose its last frames under CPU load.** Windows' encoder drops a load-dependent amount of tail when drained. `TAIL_PAD` is now 6 frames, and `write_mp3` checks every file's frame count against `delay + audio + 529`. It re-encodes up to 3 times, then fails with a sentence. A stress run passed 40/40; before the fix 7/24 failed.
- **Silent catches fixed:**
  - a plugin scan now reports when the engine didn't take the plugin list;
  - shutdown failures and timeouts are logged;
  - Plugin Manager load errors toast;
  - the engine replies with an error if the render thread can't start (before, the UI waited until it timed out).
- **Test suite could hang forever:** `analyzer-supervisor` cancelled after a fixed 150 ms sleep, which raced a slow process start. The failing test then leaked its fake analyzer and the test process never exited.
  - The test now waits for the job to arrive and cleans up in `finally`. A stress run passed 30/30.
  - `test/harness.ts` exits if something is still open 3 s after the last test.
  - `scripts/run-tests.mjs` kills any file still running after 5 min.
  - Verified: 49/49 TS files and 324/324 Rust tests.
- **Guide and menu:** the stem export text in the guide is corrected. "Agent connections…" now opens the Connect tab and "Agent chat" the Chat tab (`useAgents.agentTab`).

---

## Wave 8: No reason to go back (parity)

These are the things a producer tries in the first week and leaves over. Ordered by how often each is a dealbreaker.

### 8.1 Stem export + render cancel (M)

> **Stem export done in Wave 8a (2026-10-14, `research/15`):** one render pass, a post-fader tap per insert plus Master, 32-bit float by default. Render cancel is still open.

- **Today:** the menu item is disabled (`src/app/TitleBar.tsx`), `file.exportStems` warns, `electron/ipc.ts` refuses `opts.stems`, and `engine/src/render.rs` returns "Stem export is not supported yet".
- **Engine:** add a render option `stems: 'inserts' | 'channels'`. In one offline pass, tap each selected insert post-fader (pre-master), write one file per tap through the existing atomic writer, and optionally print the master too. Name files `<song> - <insert name>.wav`.
- **Cancel:** the engine already has `cancelRender` and `RenderEnv.cancel`. Add a Cancel button to the render progress toast and dialog, and remove partial files.
- **MCP:** `export_audio { stems: true }`.
- **Guide:** remove the "Not available yet" line in `src/guides/articles.ts`.

### 8.2 Low-latency audio (M)
- **First, exclusive-mode WASAPI** (no licence needed). Expect about 3–10 ms round trip on most interfaces. It needs a device-format negotiation UI and a fallback to shared mode with a toast.
- **Then ASIO, only after the Steinberg agreement** (`research/00` §8). The SDK can't live in the MIT repo: fetch it at build time from a CI secret, and keep the open-source build working without it.
- **Measured latency compensation** for recording: a loopback test button in Settings ▸ Audio.

### 8.3 Controller feel (S)
- Pitch bend and the mod wheel to the instruments (the guide's "Not yet supported" in the live-input article), mapped to each stock instrument's pitch and a `modX` target. MIDI learn already exists as controller links.
- A record shortcut (R), with count-in.
- Tap tempo in the transport.

### 8.4 Audio editor (M–L)
A destructive editor window for one audio clip or sample, on the existing undo.
- **Edits:** select, trim, cut and paste, fade in and out, gain and normalize, reverse, silence, and DC removal.
- **Recording:** record straight into it.
- **Analysis:** a spectral view (read-only first), plus "detect tempo/key" from the Ears menu.
- **Commands:** `audio.edit` ops that write a new sample file (never overwrite the source) and swap the SampleRef, so undo is a ref swap.

### 8.5 Slicer and pads (M)
- **Krypt Slicer instrument:** chop a loop on transients, the beat grid or manual markers; one slice per key; a note sequence that replays the loop; per-slice pitch, reverse and envelope.
- **Pads view** (an earlier leftover): a 4×4 MPC-style grid for one-shots and slices, playable from the typing keyboard and from MIDI pads. It needs the multi-sample schema noted after Wave 2.
- **MCP:** `slice_sample`. Agents can then flip a sample (with the user's own audio, plus the originality rules).

### 8.6 Rhythm effects: "Krypt Glitch" (M)
- **What it does:** a tempo-synced time-and-volume effect with stutter, tape stop and start, half-time, reverse slices and volume gating patterns, plus a pattern editor and presets.
- **Engine:** a lookahead buffer of about 2 bars, sample-accurate against the transport.
- **Agents:** an obvious tool, `add_effect krypt.glitch` with a pattern preset name.

### 8.7 Workflow gaps (S each)
- **Collect project:** zip the `.kstudio` with every sample it uses (an earlier leftover; FL's "zipped loop package"). Also clean up `userData/imports`.
- **Live arpeggiator per channel:** today "arpeggiate" is only a destructive piano-roll tool.
- **Layer channels:** one note plays several channels.
- **Take lanes and comping** for vocal recording.
- **Bounce or freeze** a channel to audio.
- **Earlier follow-ups:**
  - the typing keyboard steals tool keys;
  - C4/C5 note naming is inconsistent;
  - `set_tempo` leaves stale free-running clip lengths;
  - agents can't move audio clips;
  - the shim's offline manifest lacks the Claude Code prompt variant.

### 8.8 Live and performance mode (L, can slip to after Wave 9)
- **Clip launching:** a grid of pattern and audio clips per track, launched quantized to the bar, with scenes.
- **Recording:** the performance is recorded into the playlist.
- **MIDI controllers:** launch-grid mapping.
- **Fit:** it sits naturally on the existing pattern model.

**Wave 8 done when:** a producer can record a vocal at low latency, comp and edit it, chop a sample onto pads, glitch the hats, export stems for a mix engineer and send the project as one file, without leaving Krypt Studio.

---

## Wave 9: Only Krypt does this (the AI lead)

### 9.1 AI singing (L, headline)
Follow `research/09-ai-vocals.md`.
1. **A vocal score editor plus `write_vocal`:** notes plus lyrics (phonemes) in the piano roll on a Vocal channel.
2. **The renderer:** a DiffSinger ONNX renderer that plays **user-imported** voicebanks, plus a built-in guide-vox synth, so it works with no download.
3. **A spike: "sing over this beat"** with ACE-Step, to see whether a full-song vocal pass is good enough.
4. **Krypt Voice:** a commissioned voice is a user decision (money plus a contract with the singer).

**Traps:**
- the DiffSinger community vocoder is non-commercial (and its repo is AGPL): don't bundle it, use a permissive vocoder or the voicebank's own;
- ORT 1.24.x can crash on session creation (OpenUtau pins 1.23);
- no voice cloning of real people.

### 9.2 Hum, beatbox or sing an idea and get it as a pattern (M)
- **Today:** `audio_to_pattern` exists (Basic Pitch).
- **Add a "Capture idea" button** in the piano roll and the channel rack: record from the mic, then transcribe.
  - In the piano roll the result goes to the selected instrument, snapped to the project key.
  - In the channel rack, beatboxing becomes kick, snare and hat steps using the analyzer's drum-hit classes.

### 9.3 "Fix my mix" (M)
- **The button:** `review_song` already scores the song and lists issues. Add a **Fix my mix** button (Mixer and Home) that applies the top fixes as one undo group:
  - gain staging;
  - sidechain on the bass;
  - low cut on non-bass parts;
  - bus and master chains from the genre playbook;
  - loudness to target.

  Then re-review and show a before/after A/B toggle.
- **Mastering assistant:** a master chain tuned to a reference track or a streaming target, with true-peak checks (already in the analyzer).

### 9.4 Explain what the AI did (S)
- **Plain sentences:** each agent group in History gets a plain-language summary ("Added a 4-bar riser before the drop, sidechained the bass to the kick").
- **One-click undo per group:** already possible.

**Wave 9 done when:** someone with no music training hums a melody, gets a sung hook with lyrics over a full beat, presses Fix my mix, and has something they'd post.

---

## Wave 10: Easiest all-in-one

### 10.1 The first five minutes (M)
- **First launch:**
  1. "What do you want to make?" offers genre cards and an optional drop zone for a reference song.
  2. The built-in agent builds a starter (playbook plus `study_reference`).
  3. A 3-step coach marks the play button, the pattern and the "change this" chat.
- **Skip:** always one click away.
- **Plus:** Ctrl+N version snapshots and a starter template gallery.

### 10.2 In-app agent as a first-class path (M)
- **Today:** the agent panel works with the user's own API key.
- **Same tools and playbooks:** it should get the same 72 tools, playbooks and one-prompt build order as MCP clients, so results match Claude Code's.
- **Voice input** (push-to-talk).
- **Suggestion chips:** "make the drums hit harder", "add a bridge", and so on.
- **Clear key setup:** where to get a key and what it costs. Nothing is sent anywhere without the key.

### 10.3 Video export for socials (M)
- **The video:** cover art (already generated) plus an audio-reactive visualizer, with the title and artist overlaid.
- **Encoding:** H.264/AAC MP4 through the Media Foundation Sink Writer, which the MP3 export already uses, so no ffmpeg (LGPL/GPL) is needed.
- **Presets:** 9:16 (TikTok, Reels, Shorts), 1:1 and 16:9, plus a 30-second "best part" picker that uses the section analysis.

### 10.4 Trust: signing and updates (S–M)
- **Code signing** with Azure Artifact Signing. **User decision:** LLC identity plus the account. Unsigned apps are blocked outright under Smart App Control.
- **Update check:** against GitHub Releases, with "update available" on Home and a one-click download. No silent installs.

### 10.5 Sound depth (ongoing)
- **More free packs:** CC0/PD packs per `research/11` (Karoryfer kits, more VSCO-2 CE, the VCSL percussion).
- **Factory drums:** more engine-synthesised drum kits per genre.
- **Commissioned kits:** later, a user decision.
- **Preset coverage:** fill the gaps that review_song flags most often.

---

## Wave 11: Mac (L)

FL Studio runs on Mac, and a large share of beatmakers use one.

| Area | Windows today | Mac plan | Risk |
|---|---|---|---|
| Audio I/O | WASAPI (cpal) | CoreAudio (cpal) | low |
| Plugins | VST3 + CLAP, out of process | VST3 + CLAP, plus AU v2/v3 (AU is the Mac norm) | medium: AU hosting is new code |
| Decode | symphonia + Media Foundation | symphonia + AudioToolbox | low |
| MP3 export | Media Foundation encoder | **No OS MP3 encoder on macOS.** LAME is LGPL, so find a permissive encoder or ship MP3 as Windows-only at first | **high** |
| ML | ORT + DirectML | ORT + CoreML EP | medium |
| MCP shim | named pipe | Unix socket | low |
| Packaging | NSIS, unsigned | dmg, **notarization needs an Apple Developer account ($99/yr)**: user decision | medium |

---

## Wave 12: Beat Ableton (written 2026-10-14)

**Where Ableton is:** Live 12.4.5 (August 2026).
- **Live 12:** scale-aware clips and MIDI effects, MIDI generators and transformations, Meld and Roar, Sound Similarity Search in the Browser.
- **12.3:** built-in Stem Separation (Suite only) and Splice in the Browser.
- **12.4:** Link Audio, plus the Auto Shift and Erosion effects.
- **Price:** about $99 / $439 / $749 (Intro / Standard / Suite), on Mac and Windows.

**Where we already lead:**
- free and MIT, no account;
- AI built in (80 MCP tools, per-agent undo);
- reference → song with a closeness score, and audio → editable project;
- free stem separation;
- the pattern / step-sequencer workflow;
- Guides with "Show me".

**Rule for everything below:** every new capability is also an MCP tool or an argument on one. That's the part Ableton can't easily copy.

### 12.1 Quick wins (started 2026-10-14)

- **"More like this"** (S–M):
  - Right-click any sound in the Browser (factory sample, pack sample, preset, a file in your folders) to get the closest sounds by timbre.
  - It uses the Wave 8a fingerprints (`resources/factory/fingerprints.json`, with packs and user files fingerprinted lazily).
  - MCP: `find_samples {like}` and `find_presets {like}`.
  - Ableton's Sound Similarity Search, for free.
- **MIDI generators in the piano roll** (M), scale-aware and seeded, so re-roll gives new takes:
  - **Rhythm:** Euclidean / density / accents.
  - **Chord stacks:** progressions by degree, voicings.
  - **Arpeggio:** from the chords under it.
  - **Melody:** contour, density, range and phrase length, in the key.
  - **Bassline:** follows the chords: roots, fifths, octaves, passing notes.

  Every generator is a `notes.generate` command and an MCP `generate_notes` tool, with "Variations" (4 seeds side by side) in the dialog.

### 12.2 The Ableton-parity wave (L)

**Status (2026-10-14): built and verified.** The plan and contracts are in `research/16-ableton-parity.md`.
- **Done:**
  - clip launcher;
  - warp markers and 5 modes;
  - instrument / drum / effect racks with 8 macros and variations;
  - slice to pads;
  - Krypt Heat, Tape Echo, Grain and Glue;
  - vocoder upgrade;
  - sampler `end`.
- **12.2b (2026-10-14, `research/17-wave-12-2b.md`): done.**
  - take lanes and comping;
  - MIDI out with grid LEDs and MIDI clock in and out;
  - automation inside racks, and instrument latency in PDC;
  - gain-reduction meters, the EQ curve and the Krypt Analyzer display;
  - time-signature UI, markers, clip fades and user templates;
  - Follow tempo on dropped loops;
  - TriOsc LFOs;
  - Krypt Script (sandboxed JS note devices, the first step of the 12.3 scripted devices);
  - tempo-synced "bar" divisions follow the meter.

- **Clip launcher:**
  - a grid of pattern and audio clips per track, quantized launch and scenes;
  - follow actions;
  - recording a performance into the playlist;
  - Launchpad / APC / generic grid mapping over MIDI.

  This replaces 8.8. Agents can build scenes and launch them for live sets.
- **Warp markers and warp modes:**
  - drag markers on audio clips;
  - modes Beats (transient-slicing), Tones (pitched / mono), Texture (granular) and Complex (the current Signalsmith stretch), plus Re-Pitch;
  - auto-warp from the analyzer's beats.
- **Racks and macros:**
  - instrument and effect racks with parallel chains, key / velocity zones, and 8 macro knobs with variations (snapshots);
  - agents can turn the macros (`set_macro`), and presets can be racks.
- **Drum rack, slicer and comping:** 8.5 (pads + Krypt Slicer, now with a drum rack: one pad per sample, each with its own chain), plus take lanes and comping (8.7).
- **More devices:**
  - a multiband saturator / "everything" distortion;
  - a tape echo with wow / flutter;
  - a granular / spectral device;
  - a vocoder upgrade;
  - a glue-style bus compressor.

### 12.3 The long play

- **Scripted devices (the Max for Live answer):**
  - a sandboxed JavaScript device API for MIDI effects, generators and control logic;
  - later audio, through a WASM DSP sandbox off the audio thread's hot path;
  - devices are shareable files, and **the AI can write them**.
- **Mac:** Wave 11.
- **Hardware:**
  - more controller scripts (Launchkey, MiniLab, APC);
  - MIDI clock in / out.
  - **Ableton Link can't ship as is:** its SDK is GPL-2.0-or-later, with a commercial licence from Ableton. A GPL library can't be linked into an MIT app, so Link needs that licence (user decision). MIDI clock sync is the licence-free route.

---

## Decisions needed from the user

1. Create the public GitHub repo, and whether `research/` and `spikes/` are in it (7.2).
2. Create the models mirror repo (7.7).
3. Code signing: Azure Artifact Signing with the LLC identity (10.4).
4. The Steinberg ASIO agreement (8.2). Exclusive WASAPI ships first either way.
5. A commissioned Krypt Voice (9.1).
6. An Apple Developer account for the Mac port (11).
7. An Ableton Link commercial licence, or MIDI clock only (12.3).
