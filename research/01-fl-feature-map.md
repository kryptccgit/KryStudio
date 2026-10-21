# 01: FL Studio Feature Map and Tiered Roadmap for KryptStudio

- **Research date:** 2026-10-11
- **Scope:** Current FL Studio (2026.1.x), its windows, workflows, stock plugins, AI and cloud features, why people love it, what they complain about, and the legal and IP limits on copying it.
- **Status:** Draft v1, for the KryptStudio kickoff.
- **Method:** Mostly the official Image-Line online manual and release notes, plus reviews and Image-Line forum threads. The shared web-search budget for this session ran out partway through. A few items rely on prior knowledge, and each of those is marked **(unverified)**. Re-check them before relying on them.
- **Naming note:** The house guide (§12 of `kryptguidelines.md`) uses the pattern `Krypt <Tool>` with a space. Under that rule the product would be **"Krypt Studio"**, with exe name `krypt-studio` and app ID `cc.krypt.studio`. This doc says "KryptStudio" or "KS" because that is the working name in the brief.

---

## 0. TL;DR

**FL Studio today.** The current line is FL Studio 2026, released 7 Jul 2026. The latest maintenance build is 2026.1.7, dated 28 Sep / 1 Oct 2026. It comes in four paid editions (Fruity, Producer, Signature, All Plugins) and includes lifetime free updates. That policy has run for 28 years. Image-Line also sells an FL Cloud subscription (Free / Plus / Pro) for sounds, AI mastering, cloud plugins, backups and distribution. The AI features have grown quickly:
- Stem separation (21.2, Oct 2023)
- An AI chord progression tool (2024)
- Gopher, a chat assistant (2025.1)
- Gopher writing Piano roll scripts (2025.2)
- Gopher performing some actions inside the project, an experimental feature (2026)
- "Remix a song", which loads a track and separates its stems (2026)
- A chord detection panel (2026)

Sources: [What's New 2026](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new.htm), [What's New 2025](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new_25.htm), [2026.1.7 forum post](https://forum.image-line.com/viewtopic.php?p=2076291).

**P0 headline (MVP: one beat, start to finish):**
1. Native audio engine: transport, tempo, Pattern/Song mode, sample-accurate scheduling, WASAPI/ASIO. **XL**
2. Our own open project format (JSON plus assets, with a zipped bundle option), real multi-level undo/redo, and autosave.
3. Step sequencer rack: channels with volume, pan, mute, solo and mixer target. 16 steps by default (1–512), click to set, right-click to clear, drag to paint. Per-step velocity and pan. Global swing plus per-channel swing.
4. Patterns: create, clone and select them; one pattern can drive many clips.
5. Piano roll:
   - Draw, paint, select, delete and slice notes.
   - New notes reuse the last note length.
   - Snap, with Alt to bypass it.
   - Velocity lane and scale highlighting.
   - Quick quantize; copy, paste, duplicate and transpose.
   - Preview notes on click; MIDI import and export.
6. Playlist: pattern clips, audio clips (trim, gain, fades), basic automation clips, loop selection and a pattern picker.
7. Mixer: dynamic inserts plus a master; channel-to-insert and insert-to-bus routing; volume, pan, mute and solo; FX slots you can bypass and reorder; peak meters.
8. Stock instruments: Sampler (ADSR, root note, mono/glide, cut groups), an 808/kick synth and a 3-oscillator synth.
9. Stock effects: EQ, compressor, limiter, soft clipper, reverb, delay, filter, drive and utility.
10. Browser: folders, search, click to preview, and drag samples anywhere.
11. Typing-keyboard and MIDI input, with basic recording into a pattern.
12. Render to WAV (16/24/32-bit float), MP3 and MIDI.
13. **One command bus shared by the UI and MCP.** Every P0 action can be called by an agent, and agent edits undo as one step.

**Biggest XL items:**
- The real-time engine, including plugin delay compensation (PDC) and multithreading
- VST3/CLAP hosting in a sandboxed process, plus a plugin scanner (P1)
- Time-stretch and pitch-shift for audio clips, plus re-stretching under tempo automation (P1)
- Audio recording with latency compensation, then take lanes and comping (P1/P2)
- A modular routing environment like Patcher (P2)
- On-device stem separation (P2)
- A preset player with content packs, like FLEX (P2; most of the cost is content)
- A Newtone-class pitch editor (P3)
- Harmor-class resynthesis (P3)
- `.flp` import (P3: big, and legally sensitive)

**Surprises:** see §8.

**Legend**
- **Tiers:** **P0** = MVP, enough to make a full beat. **P1** = producer-ready. **P2** = FL parity. **P3** = nice-to-have or skip.
- **Complexity (one experienced developer, assuming the dependencies exist):** **S** ≤ 1 week. **M** 1–4 weeks. **L** 1–3 months. **XL** more than 3 months, or research-grade.
- **Dependency tags:**
  - `ENG` needs the native audio engine.
  - `HOST` needs third-party plugin hosting (VST3/CLAP).
  - `DSP` needs our own DSP code.
  - `ML` needs on-device model inference.
  - `CONTENT` needs samples or presets that we create or license.
  - `NET` needs network or cloud services.

---

## 1. FL Studio in October 2026

### 1.1 Release timeline (recent)

| Version | Date | Headline changes |
|---|---|---|
| 21.0 | 6 Dec 2022 | Themes. Audio clip fades and gain. Playlist [+] button adds Instrument/Audio tracks. Browser tags, favourites and boolean search. Per-project data folders. New plugins: LuxeVerb, Vintage Phaser, Multiband Delay, VFX Sequencer. [src](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new_21.htm) |
| 21.1 | 8 Aug 2023 | Waveforms coloured by frequency. External MIDI clock sync. Snap to scale. **Python Piano roll scripting.** Hyper Chorus. [src](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new_21.htm) |
| 21.2 | 26 Oct 2023 | **FL Cloud**: Sounds tab, AI mastering, DistroKid distribution. **Stem separation** into 4 stems. **Kepler**, a Juno-6 recreation. Fruity Edition now allows up to 8 audio clips. [src](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new_21.htm), [DJ Mag](https://djmag.com/tech/fl-studio-212-stem-separation-and-ai-mastering-now-available), [MusicRadar](https://www.musicradar.com/news/fl-studio-update-21) |
| 2024 (24.1) | 26 Jun 2024 | **CLAP support.** AI Chord Progression tool. Note repeat. Kepler Exo, Low Lifter, Spreader. Welcome window. [src](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new_24.htm) |
| 2024.2 | 28 Nov 2024 | **Ghost notes from overlapping pattern clips.** Snap incoming MIDI to scale. "Delay audio output" low-latency monitoring. Transporter. Vector UIs and plugin scaling. [src](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new_24.htm) |
| 2025 (25.1) | ~Jul 2025 | **Gopher** (Q&A over the manual). **Mixer goes dynamic, 125 → 500 inserts.** Unroute. Undo for track deletion. Per-clip stretch, pitch and reverse. **AI Deverb.** **Loop Starter.** Emphasis. FL Studio Mobile Rack. VFX Script. [src](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new_25.htm) |
| 2025.2 | 25 Nov 2025 | Gopher writes Piano roll scripts. Samples load on multiple threads. Channel Sampler loop points. Extract Stems can send each stem to its own Mixer track. **Patcherize.** Emphasizer (all editions). Fruity Slicer 2. Sidechain input on Fruity Compressor. [src](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new_25.htm) |
| 2026 (26.1) | 7 Jul 2026 | **FL Cloud project backups** (500 MB / 5 GB / 1 TB). **Audio Logger.** **Chord Detection panel.** Chord Stamp voice-leading modes. User key labels. **"Remix a song"** (stem-separated). **FLEX engine rebuild** (up to 50% less CPU). Gross Beat MIDI slot triggers. **Transmitter.** Audio clip normalise and pan. **Gopher can control some FL and plugin features.** MIDI-scripting additions: swing, pattern length, a new MCU script. [src](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new.htm) |
| 2026.1.1–.7 | 13 Jul – 28 Sep 2026 | Maintenance releases. 2026.1.5 adds 24-bit disk recording. 2026.1.6 lets the export dialog render Master and Current alongside split tracks and adds a notification when a MIDI controller connects. [src](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new.htm), [forum](https://forum.image-line.com/viewtopic.php?p=2076291) |

### 1.2 Editions, price and business model

| Edition | What it adds | Counts (FX / Instr / Audio editors) | Typical price |
|---|---|---|---|
| Fruity | Piano roll, Mixer, full arrangement, automation clips, time signatures, MIDI, VST2/VST3/AU/**CLAP** support, Gopher, Chord Generator, Loop Starter, Remote. **No audio recording.** Audio clips capped at 8 (since 21.2). | 53 / 23 / 0 | $99 |
| Producer | **Audio recording, Stem Separation\*, Denoising**, Edison, Newtime, Sytrus, Kepler, Slicex, Maximus, Vocodex, etc. | 59 / 27 / 2 | $199 |
| Signature | Gross Beat, Pitcher, Newtone, Harmless, DirectWave Full, Vintage Chorus/Phaser, Low Lifter, Hardcore, Video Player | 65 / 29 / 3 | $299 |
| All Plugins | Harmor, Transistor Bass, Sakura, Kepler Exo, Emphasis, LuxeVerb, Transporter, Transmitter, etc. | 71 / 39 / 3 | $499 |

- Image-Line's own pages show only "From $99". The per-edition prices above come from third-party guides ([audeobox](https://www.audeobox.com/learn/fl-studio/fl-studio-pricing-which-edition/)) and should be treated as **(unverified)**.
- Edition features and counts: [Compare editions](https://www.image-line.com/fl-studio/compare-editions), [Pricing](https://www.image-line.com/fl-studio/pricing).
- \***Image-Line's own pages disagree on Stem Separation.** The compare page lists it as Producer and up. The pricing page lists it in all editions.
- **Lifetime Free Updates:** "28 years and going strong." Some new synths and effects are added only to specific editions. Owners can also unlock legacy versions. [Image-Line](https://www.image-line.com/fl-studio/lifetime-free-updates)
- **Rent-to-Own Plus:** 12 monthly payments, then you own the license. FL Cloud is included while the plan runs. [Buy page](https://www.image-line.com/fl-studio/buy-now)
- **FL Cloud plans** ([FL Cloud](https://www.image-line.com/fl-cloud)):
  - **Free:** starter sample library, 10 plugins, 500 MB storage.
  - **Plus:** more than 2M sounds, full Loop Starter, 18 plugins, 5 GB, AI mastering.
  - **Pro:** everything in Plus, plus 90+ plugins, 1 TB, every FLEX pack, and DistroKid distribution.
  - The page shows no prices. A 2024 forum post quoted Plus at $79.99/yr list ([forum](https://forum.image-line.com/viewtopic.php?p=1953892), **dated**).

### 1.3 AI and cloud feature inventory

| Feature | Since | What it does | Limits observed |
|---|---|---|---|
| Stem separation | 21.2 | Splits an audio clip into Drums, Bass, Instruments and Vocals (up to 4 stems). Since 2025.2 it can send each stem to its own Mixer track. | Quality depends on the source ([MusicTech review](https://musictech.net/reviews/digital-audio-workstations/fl-studio-21-2-review/)) |
| AI mastering | 21.2 | Cloud mastering from the Export menu, with genre presets. Since 2024 it has manual refinement controls. | Requires FL Cloud Plus |
| AI Chord Progression tool | 2024 | Generates chord progressions in the Piano roll. Phrasing and scaling were added in 2025.2; previews and chord nudging in 2026. | |
| Gopher | 2025.1 → 2026 | 2025.1: Q&A built on the manual and knowledge base. 2025.2: writes Piano roll scripts. 2026: experimental control of "some FL Studio and plugin features" and writes VFX scripts. | In The Verge's hands-on test (reported via [RouteNote](https://routenote.com/blog/fl-studio-2026-gopher-ai-production-assistant/) and [ainauten](https://news.ainauten.com/en/story/fl-studio-2026-turns-its-ai-chatbot-into-your-assistant-engineer)) it **could not draw automation, write melodies or chords, or pick plugin presets.** MusicTech found it slow ([review](https://musictech.com/reviews/digital-audio-workstations/fl-studio-2025-review)). |
| Deverb (AI) | 2025.1 | Audio Clip menu and Edison tool, with General and Vocal modes | |
| Loop Starter | 2025.1 | Builds loops by genre and key from FL Cloud content (6 more genres in 2025.2) | Needs cloud content |
| Find similar samples | 2025.2 | Sample-similarity search in the Sounds tab | Probably embedding-based (unverified) |
| Chord detection | 2026 | Detects chords from MIDI, the typing keyboard and Piano roll selections (up to 10 notes) | |
| Remix a song | 2026 | One click loads a song and separates its stems into the Playlist | |
| FL Cloud backups and plugins | 2026 / 2024 | Cloud project backups. Cloud plugins are free for all customers (2024). | Subscription tiers |

---

## 2. Core windows and workflows: tiered feature matrix

Each table row gives: the FL behaviour, then **Tier / Complexity / Dependencies**, and a KS note (the place to beat FL is marked **Beat FL**).

### 2.1 Global, transport and project

| ID | Feature (FL behaviour) | Tier | Cx | Deps | KS note |
|---|---|---|---|---|---|
| G01 | Transport: Play/Stop (Space), Record (R), **Pattern/Song mode toggle (L)**, song position, loop | P0 | M | ENG | Keep the L toggle. It is central to the pattern workflow. |
| G02 | Tempo in BPM with decimals; tap tempo | P0 | S | ENG | |
| G03 | Tempo automation (tempo automation clip; "Restretch" for audio) | P1 | M | ENG, DSP | Becomes L once audio clips must follow tempo. |
| G04 | Time signatures: per project, **per pattern**, and as Playlist markers ([Playlist](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm)) | P0 (project) / P1 (changes) | M | ENG | |
| G05 | PPQ: the project default is **96**, changed in F11 settings ([Playlist](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm)) | P0 | S | ENG | **Beat FL:** use one fixed high-resolution timebase (e.g. 960 PPQ or float beats) that users never have to configure. Users complain about zoom and resolution being tied to PPQ. |
| G06 | Metronome and count-in | P0 | S | ENG | |
| G07 | Undo: **Ctrl+Z toggles undo/redo of the last edit. Ctrl+Alt+Z steps back through history.** History list in the Browser. ([manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_shortcuts.htm), [Edit menu](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/menu_edit.htm)) | P0 | M | — | **Beat FL:** standard multi-level Ctrl+Z / Ctrl+Y and a History panel. An agent's edits group into one named, undoable transaction. |
| G08 | Save (Ctrl+S); **Save new version (Ctrl+N)**; auto backups in the Browser; project data folder (21.0) | P0 (save/load, autosave) / P1 (versions) | M | — | Ctrl+N version snapshots are much loved. Keep them. |
| G09 | Zipped project with samples | P1 | S | — | Our bundle format should zip natively. |
| G10 | Templates; Welcome window with recent projects and creative tools (2024, redesigned 2025.2) | P1 | S | — | |
| G11 | Project info (title, author, genre, URL) in F11 | P2 | S | — | Also gives agents context. |
| G12 | Floating and detachable windows, multi-monitor, Ctrl+Shift+H to arrange; window toggles F5 Playlist / F6 Rack / F7 Piano roll / F8 Plugin Picker / F9 Mixer / F10 MIDI settings / F11 song info / F12 close all ([shortcuts](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_shortcuts.htm)) | P1 | M | — | Electron makes multiple windows costly. Use a docking layout plus pop-outs. **Beat FL:** real docking (users say FL "lacks a true dockable UI"). |
| G13 | Typing keyboard to piano (Ctrl+T) | P0 | S | — | |
| G14 | **Hint bar** (a context help line for whatever control is under the mouse) | P1 | S | — | Cheap. Also feeds agent and accessibility text. |
| G15 | Themes (21.0) | P2 | S | — | The Krypt theme is the default. |
| G16 | Audio settings: device, buffer, sample rate; FL's own ASIO driver | P0 | M | ENG | |
| G17 | CPU and memory meters; Plugin Performance Monitor | P1 | M | ENG | |
| G18 | External MIDI clock sync (21.1) | P3 | M | ENG | |
| G19 | ReWire | P3 (skip) | — | — | Obsolete. |
| G20 | FL Studio as a VST/AU plugin inside other DAWs | P3 | XL | ENG | |
| G21 | Command palette | — | — | — | **Beat FL** (P1, S): FL buries features in deep right-click menus. A palette is also how agents discover commands. |

### 2.2 Channel Rack and step sequencer

Sources: [Channel Rack](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/channelrack.htm).

| ID | Feature (FL behaviour) | Tier | Cx | Deps | KS note |
|---|---|---|---|---|---|
| CR01 | Channel rows: mute LED, pan knob, volume knob, mixer-track number, channel button, then step buttons or a mini piano-roll preview. Channel types: sampler, instrument plugin, audio clip, automation clip, layer. | P0 | M | ENG | Do not copy the exact row layout (see §9). Rack channel volume and pan act before the mixer. |
| CR02 | Step grid: a step is a 16th note; default 16 steps; pattern length is Auto or fixed **1–512 steps (max 64 bars in 4/4)**. Left-click sets a step, right-click clears it, drag paints. | P0 | M | ENG | Our hard limit can be higher; past 512 steps the piano roll should take over. |
| CR03 | **Steps are zero-length notes that share storage with Piano roll notes.** Shift+D discards lengths and Shift+Q quantizes, turning notes back into steps. | P0 | M | — | A data-model decision: one note store for both views. |
| CR04 | **Graph editor** (Ctrl+K) per step: note pitch, velocity, release, fine pitch ±100 c, pan, Mod X, Mod Y, Shift (timing offset), Rep (note repeat). Ctrl scales all columns; right-drag ramps values. | P0 (velocity, pan) / P1 (others) | M | — | |
| CR05 | **Swing:** global 0–100%, with a per-channel swing mix; both must be above 0 for swing to apply; option to truncate swung notes. | P0 | S | ENG | A core part of how FL "feels". |
| CR06 | Fill every 2/4/8 steps, advanced fill, rotate left/right | P1 | S | — | |
| CR07 | Per-channel advanced looping (step/beat/bar), ghost loop steps, "Burn to pattern" | P2 | M | — | |
| CR08 | Filter groups (display filters, PgUp/PgDn), zip/unzip, sort by colour/name/type, group, colour gradient | P1 | S | — | |
| CR09 | Insert, Replace, Clone, Delete channel; drag a sample onto the rack to create a channel, or onto a channel to replace its sample | P0 | S | — | |
| CR10 | Ctrl+click previews a channel; number keys 1–0 mute the first 10 channels; Ctrl+number solos | P0 | S | — | |
| CR11 | Channel selection sets the live MIDI target; "receive notes from" a controller | P1 | S | — | |
| CR12 | **Patterns:** selector, Numpad +/− and 1–9, F4 for the next empty pattern, clone, rename, colour, length, per-pattern time signature | P0 | M | — | |
| CR13 | Assign selected channels to free mixer tracks (Ctrl+L) | P0 | S | — | Consider assigning automatically by default. |
| CR14 | Layer channels: stack, split children, random (round-robin), crossfade | P2 | M | ENG | |
| CR15 | Burn MIDI: capture arpeggiator or plugin MIDI output into a pattern | P2 | M | HOST | |
| CR16 | Loop Starter (cloud loop generator) | P3 | L | CONTENT, NET | Replace with an agent "start me a beat" flow over MCP. |
| CR17 | Patcherize a channel; Sort by Type; Replace from favourites or the plugin database | P2–P3 | S–M | HOST | |
| CR18 | Audio and automation clips as rack channels (legacy FL structure) | P3 (skip) | — | — | Keep clips only in the Playlist. This is a frequent source of confusion. |

### 2.3 Channel settings (sampler, instrument, miscellaneous, wrapper)

| ID | Feature | Tier | Cx | Deps | KS note |
|---|---|---|---|---|---|
| CS01 | Sampler: load sample, root note, keyboard range, reverse, normalise, fade in/out, declick modes, trim, loop modes (incl. ping-pong), stretch modes, keep on disk, loop start/end (2025.2) | P0 (basic) / P1 | M | ENG, DSP | |
| CS02 | Envelopes and LFOs per target: Volume, Pan, Mod X (cutoff), Mod Y (resonance), Pitch. AHDSR, tempo-synced LFOs. | P1 | M | DSP | |
| CS03 | Channel filter types | P1 | S | DSP | |
| CS04 | **Polyphony:** max voices, **mono**, **portamento/slide**, **Cut / Cut-by groups** (hi-hat choke, 808 cut-self) | P0 | S | ENG | Essential for 808s and hats. |
| CS05 | Arpeggiator (direction, range, time, gate, chord), time settings (swing, shift, gate) | P1 | M | ENG | |
| CS06 | Miscellaneous: pitch-bend range, **echo delay** (feedback with pitch and pan per echo), levels adjust, channel swing | P2 | M | ENG | |
| CS07 | **Mod X / Mod Y:** two generic per-note modulation targets | P1 | S | ENG | Map to per-note expressions (CLAP note expressions / MPE). |
| CS08 | Plugin Wrapper: processing options (smart disable, threaded, fixed buffer), MIDI in/out ports, multiple outputs, presets (.fst), browse/automate parameters, bridged or separate-process modes **(unverified details)** | P1 | L | HOST | **Beat FL:** sandbox every third-party plugin out of process by default. Forum users ask for "plugin sandboxing so a crashing VST doesn't take down the DAW" ([forum](https://forum.image-line.com/viewtopic.php?p=2053513)). |

### 2.4 Piano roll

Sources: [Piano roll](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm), [Piano roll menu](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll_menu.htm).

| ID | Feature (FL behaviour) | Tier | Cx | Deps | KS note |
|---|---|---|---|---|---|
| PR01 | Tools by key: Draw **P**, Paint **B**, Paint drum sequencer **N**, Delete **D**, Mute **T**, Interpolate **I**, Slice **C**, Select **E**, Zoom **Z**, Play selected **Y** | P0 (P/B/D/E/C) / P1 (T/Y/I/N) | M | — | Single-letter tools suit keyboard-first users and agents. |
| PR02 | **Feel details:** new notes take the last-used note length **(unverified, but widely known)**; right-click deletes; Alt bypasses snap; notes sound on click; Alt+wheel sets velocity (Ctrl+Alt+wheel for fine steps); Shift+arrows nudge by snap, Alt+arrows by pixel | P0 | M | ENG | This is **the** reason people love the FL piano roll. See §6. |
| PR03 | Note properties: velocity, release velocity, pan, Mod X, Mod Y, fine pitch, **16 colour groups (mappable to MIDI channels)**, slide flag, porta flag, start and length in bar:step:tick. Double-click opens the properties dialog. | P0 (velocity) / P1 (others) | M | ENG | |
| PR04 | Event editor lanes below the grid: velocity, pan, release, Mod X/Y, pitch, any automatable parameter, MIDI CC. Shift+F cycles lanes; Shift+click sets a uniform value; Alt+click resets. | P0 (velocity) / P1 | M | ENG | |
| PR05 | Snap options: Main, Line, Cell, none, Steps 1/6–1, Beats 1/6–1, Bar, Events, Markers | P0 | M | — | |
| PR06 | **Scale highlighting**, **snap to scale**, **snap incoming MIDI to scale** (2024.2), **user key labels** with presets (2026), keyboard styles | P0 (highlight) / P1 (snap) / P2 (labels) | S–M | — | Key and scale awareness is also an important agent tool. |
| PR07 | **Ghost notes:** solid ghosts from other channels in the pattern; outlined ghosts from overlapping pattern clips (2024.2). Alt+V toggles; Ctrl+Alt+V makes ghosts editable. | P1 | M | — | |
| PR08 | **Slide notes (S)** and **Portamento (O)**. Slides take the note length and glide neighbouring notes. They work by colour group and **only on native instruments.** | P1 | M | ENG, DSP | Trap 808 glides depend on this. Every KS instrument must support slides. |
| PR09 | Stamp (chords, scales, percussion presets); **Chord Stamp** with top-down and bottom-up voice leading (2026) | P1 (stamp) / P2 (voice leading) | S–M | — | |
| PR10 | Quantize: quick quantize (Ctrl+Q), quantize start times (Shift+Q), Quantizer dialog (Alt+Q); Quick legato (Ctrl+L); Articulate (Alt+L) | P0 (quick) / P1 | M | — | |
| PR11 | Tools menu: Quick chop / Chop (Ctrl+U / Alt+U), Glue (Ctrl+G), Arpeggiate (Alt+A), Strum (Alt+S), Flam (Alt+F), Claw machine (Alt+W), Limit key range (Alt+K), Flip (Alt+Y), Randomize (Alt+R), Scale levels (Alt+X), LFO (Alt+O) | P1 (chop, glue, arp, strum, flip, randomize, limit) / P2 (claw, LFO, scale levels, flam) | S each | — | Each one is a clean, testable MCP tool. |
| PR12 | **Riff Machine** (Alt+E), a generative riff tool | P2 | M | — | Agent generation over MCP covers this better. |
| PR13 | Chord Progression tool (Alt+P), AI-powered (2024); Chord Detection panel (2026) | P2 | M | (ML optional) | Rule-based chord detection is S–M. |
| PR14 | **Python Piano roll scripting** (21.1+); Gopher writes these scripts (2025.2) | P2 | L | — | KS: a sandboxed JS/TS or Python script API plus MCP. |
| PR15 | Edit: copy/paste/duplicate (Ctrl+B); transpose (Shift+Up/Down, Ctrl+Up/Down for octaves); rotate; insert/delete space; trim selection; mute/unmute | P0 (copy/paste/dup/transpose) / P1 | S–M | — | |
| PR16 | Select: all, invert (Shift+I), by colour, odd (swung) notes, muted, overlapping, stacked, random; magic lasso; select time around selection; group notes (Shift+G) | P1 | S–M | — | |
| PR17 | Stretch handle for selections; resize notes from the left | P1 | S | — | |
| PR18 | MIDI import (Ctrl+M) and export (Shift+Ctrl+M); MIDI clipboard; `.fsc` score presets; **export score as PDF sheet music** | P0 (MIDI) / P3 (PDF) | S–M | — | |
| PR19 | Background waveform (Alt+N) | P2 | S | — | |
| PR20 | Time markers, key markers and time signatures inside a pattern | P2 | S | — | |
| PR21 | Note repeat (2024) | P2 | S | ENG | |
| PR22 | Score logger: keeps the last ~3 minutes of played notes to dump into a pattern ([Recording](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/recording.htm)) | P1 | S | ENG | Cheap, and users love it. |
| PR23 | One channel per Piano roll; others appear only as ghosts. "Target channel" switches the edited channel. | — | — | — | **Beat FL** (P1, M): edit several channels at once. |

### 2.5 Playlist (arrangement)

Sources: [Playlist](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm).

| ID | Feature (FL behaviour) | Tier | Cx | Deps | KS note |
|---|---|---|---|---|---|
| PL01 | Clip tracks **not bound to mixer tracks**. Any clip type can go on any track, and overlapping clips show with transparency. 500 tracks **(unverified)**. Can be detached to another monitor. | P0 | M | — | Keep the freedom, and also offer instrument and audio tracks (PL10). |
| PL02 | **Pattern clips:** paint patterns (B), resize or crop, **Make unique**, split by channel **(unverified wording)**, Merge pattern clips (Ctrl+G), chop, colour by pattern or channel, per-clip time signature | P0 (place, resize, unique) / P1 (split) / P2 (merge, chop) | M | — | This is FL's signature. See §6. |
| PL03 | **Audio clips:** drag from the Browser; trim, fades and auto crossfades; gain; pitch (keys 7/8 = ±1 semitone); reverse (9); per-clip stretch modes (Realtime, Elastique, Special, Legacy, Resample); Fit to tempo; normalise and pan (2026); chop to bars or beats; tempo detection; zero-crossing snap; send to Edison | P0 (place, trim, gain, fades) / P1 (pitch, reverse, crossfade, stretch) / P2 (chop, detect) | M → XL | ENG, DSP | Stretching is the XL part. Candidate library: **Signalsmith Stretch, MIT** ([repo](https://github.com/Signalsmith-Audio/signalsmith-stretch)). |
| PL04 | **Automation clips:** right-click any control → Create automation clip; point editing in Step or Slide mode with curve types; articulator tools (Scale, Normalize, Flip, Smooth, LFO, analyse audio) | P0 (basic) / P1 (curves, LFO) | M | ENG | |
| PL05 | Tools: Draw (P), Paint (B), Delete (D), Mute (T), **Slip (S, Shift+S for ripple)**, Slice (C; vertical by default since 2025.1, Left-Shift for diagonal), Select (E), Zoom (Shift+Z), Playback (Y) | P0 (P/B/D/C/E) / P1 (S/T) | M | — | |
| PL06 | Time selection: loop playback over the selection, insert or delete time, render the selection | P0 (loop) / P1 | S–M | ENG | |
| PL07 | Markers with actions: start, loop, marker loop, skip, pause, time signature, start/stop recording; add in batches; live-mode marker jumps quantized to beats or bars | P1 (basic) / P2 (actions) | M | ENG | |
| PL08 | Time signature changes on a selection or from a point (Shift+Alt+T) | P1 | M | ENG | |
| PL09 | Tempo automation, plus restretching audio when tempo changes | P1 | L | ENG, DSP | |
| PL10 | Track modes: Unassigned / **Audio track / Instrument track**, linking channel, Playlist track and mixer 1:1 | P1 | M | — | Make instrument and audio tracks the beginner default. |
| PL11 | Track header: rename, colour, icon, mute, solo, lock, **group with track above** (collapse/expand), consolidate, clone; resize all tracks 33–200% | P0 (basic) / P1 (groups) / P2 (consolidate) | S–M | — | |
| PL12 | Clip grouping (Shift+G) | P2 | S | — | |
| PL13 | **Multiple arrangements:** clone, rename, merge | P2 | M | — | Useful for agents: "try an alternate arrangement". |
| PL14 | **Performance mode** (Ctrl+P): launch clips per track; markers trigger columns; record a performance into the Playlist | P2 | L | ENG | |
| PL15 | **Picker panel** (Alt+P): lists patterns, audio and automation; drag to place; select unused; quick render / render as audio clip / render and replace | P0 (pattern list) / P1 (renders) | S–M | ENG | |
| PL16 | Consolidate or bounce; export all Playlist tracks or groups | P1 | M | ENG | |
| PL17 | Extract stems (AI) and Deverb from the audio clip menu | P2 / P3 | L | ML | |
| PL18 | Audio tracks with input, monitor and arm controls | P1 | M | ENG | |
| PL19 | Frequency-coloured waveforms (21.1); ghost notes inside pattern clips | P2 | S | — | |
| PL20 | Take lanes and swipe comping | — | — | — | **Beat FL** (P2, L). See §7. |

### 2.6 Mixer

Sources: [Mixer](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/mixer.htm).

| ID | Feature (FL behaviour) | Tier | Cx | Deps | KS note |
|---|---|---|---|---|---|
| MX01 | **500 insert tracks**, created dynamically since 2025.1 (was 125), plus **Master** and a **Current** utility track; 3 docks; 8 layout sizes | P0 (dynamic inserts + master) | M | ENG | Skip the Current track (P3). |
| MX02 | Routing: unset channels go to Master. Each track has one stereo input and output. Any insert can be a send; the send level knob appears on the destination. **Post-fader by default; pre-fader needs Fruity Send.** Feedback loops are prevented. Ctrl+L / Ctrl+Shift+L route channels. | P0 (insert → master/bus) / P1 (send knobs, pre/post) | M | ENG | Add a built-in pre/post switch on sends. |
| MX03 | **Sidechain:** route to a track "sidechain only" at 0% send; plugins with sidechain inputs select it (Fruity Limiter; Fruity Compressor since 2025.2) | P1 | M | ENG, HOST | **Beat FL:** an explicit "sidechain from" picker on each plugin, plus a routing inspector. Users report sidechain links "disappear and are hard to find". |
| MX04 | **10 FX slots per track**, each with an on/off switch and mix (FX level) control; reorder with the wheel; slot menu (presets, spare-state flip, smart disable, threaded processing); **Patcherize** for more | P0 (slots, bypass, reorder) / P1 (mix knob) | M | ENG | **Beat FL:** unlimited slots. |
| MX05 | Built-in per-track **3-band parametric EQ** | P1 | S | DSP | |
| MX06 | Volume fader (after FX), pan (circular pan law), **phase invert, swap L/R, stereo separation** | P0 (volume, pan) / P1 (others) | S | DSP | |
| MX07 | **Track delay / PDC:** automatic plugin delay compensation plus a manual sample offset | P1 | L | ENG, HOST | Required once any plugin adds latency (lookahead limiters, linear-phase EQ). |
| MX08 | Mute, solo (Ctrl/right-click), solo with routed tracks (Alt), lock; multi-select for grouped fader moves; rename and colour (F2); docking; meter-waveform view | P0 (mute, solo, rename, colour) / P1 | S–M | — | |
| MX09 | Arm and disk recording (16/24/32-bit since 2026.1.x); input selection; "Delay audio output" low-latency monitoring (2024.2) | P1 | L | ENG | |
| MX10 | Peak meters only (no LUFS) | P0 (peak) | S | DSP | **Beat FL** (P1, M): LUFS, true-peak and phase correlation on the master. All are on the forum wish list ([forum](https://forum.image-line.com/viewtopic.php?p=2053513)). |
| MX11 | Mixer track presets; insert one or many tracks or from a preset list (2025.1); unroute; trim unused tracks | P1–P2 | S | — | |
| MX12 | Multi-output instruments feeding several inserts | P1 | M | HOST | |
| MX13 | Surround outputs (5.1 / 7.1 over ASIO pairs) | P3 | M | ENG | |
| MX14 | Freeze, VCA faders, mix snapshots, hidden tracks, input/output trim (FL has none of these) | — | — | — | **Beat FL** (P2, M–L each). See §7. |

### 2.7 Browser, Plugin Picker and plugin management

| ID | Feature | Tier | Cx | Deps | KS note |
|---|---|---|---|---|---|
| BR01 | File browser: folder tree, click to preview, drag to rack, Playlist or sampler, search, favourites, **tags and boolean search (21.0)**, inline waveforms (2026), Project data folder, Backups, History | P0 (tree, preview, drag, search) / P1 (tags, favourites) | M | ENG | |
| BR02 | Sounds tab (FL Cloud library); "Find similar samples" (2025.2) | P2 (local similarity) / P3 (cloud) | L | ML, NET | Local audio embeddings let agents "find a darker snare". |
| BR03 | Presets tab (renamed from Library in 2025.1); Plugin database | P1 | M | — | |
| BR04 | **Plugin Picker (F8):** visual grid of plugins for drag and drop | P1 | S | — | |
| BR05 | **Plugin Manager:** VST/VST3/AU/CLAP scan, verify, rescan, Waves re-verification option (2026) | P1 | L | HOST | **Beat FL:** incremental background scans in a separate process. Users complain about slow rescans. |
| BR06 | Project browser (tree of channels, patterns and automation) | P2 | M | — | An agent's "project outline" view should be just as good. |

### 2.8 Edison, Patcher, Event Editor and internal controllers

| ID | Feature | Tier | Cx | Deps | KS note |
|---|---|---|---|---|---|
| ED01 | **Edison** wave editor and recorder: record on play or on input; destructive edits in 32-bit float in RAM; regions and downbeat markers; send to Playlist or Sampler. Tools: noise removal, declipper, **Deverb**, vocal denoiser, EQ, convolution reverb, blur, claw machine, time-stretch/pitch-shift, tune loop, drum slicing, scripts. ([Edison](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/Edison.htm)) | P1 (basic clip editor) / P2 (tools) / P3 (AI repair) | M → L | ENG, DSP | KS: a non-destructive clip editor docked under the Playlist. |
| PA01 | **Patcher:** modular graph of instruments and effects. Audio, parameter and event links; parallel columns run multithreaded; automatic latency compensation; Control Surface tabs for custom UIs; VFX note modules (Color Mapper, Envelope, Key Mapper, Keyboard Splitter, Level Scaler, Sequencer, Script); Patcherize ([Patcher](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/Patcher.htm)) | P2 | XL | ENG, HOST | Build the engine graph so Patcher can come later. |
| EV01 | Event Editor (per-pattern automation events) | P2 | M | — | KS: fold into Piano roll lanes; do not keep a second automation system. |
| IC01 | Internal controllers: Envelope, Keyboard, Peak (audio follower), Formula (math), X-Y, X-Y-Z, Voltage (CV out). "Link to controller" with mapping formulas. | P1 (LFO, envelope follower) / P2 (formula, XY) / P3 (CV) | M–L | ENG | KS: one modulation system. |
| AU01 | Automation recording: knob moves go into pattern events or clips; record filter set by right-clicking Record | P1 | M | ENG | |

### 2.9 Recording

| ID | Feature | Tier | Cx | Deps | KS note |
|---|---|---|---|---|---|
| RC01 | Live play from a MIDI keyboard, typing keyboard or touch keyboard | P0 | S | ENG | |
| RC02 | MIDI note recording into a pattern: overdub/replace, loop record, count-in, step entry, blend **(details unverified)** | P0 (overdub + count-in) / P1 | M | ENG | **Beat FL:** draw the recording live as it happens. MusicTech: "Nothing appears in the Playlist during recording" ([review](https://musictech.com/reviews/digital-audio-workstations/fl-studio-2025-review)). |
| RC03 | Audio recording: arm a mixer track, pick an input, record to Playlist audio clips and/or Edison; auto-group takes; latency compensation; ASIO required on Windows | P1 | L | ENG | **Beat FL:** one-click record on Playlist audio tracks. |
| RC04 | Takes, punch in/out, pre- and post-roll, comping | P2 | L | ENG | Forum users ask for swipe-comp take lanes and Pro Tools-style quick punch ([forum](https://forum.image-line.com/viewtopic.php?p=2058791)). |
| RC05 | Score logger (3 minutes of notes); **Audio Logger** (2026, always records the Master) | P1 (score) / P2 (audio) | S / M | ENG | |
| RC06 | Recording Performance-mode clip triggers | P3 | M | ENG | |

### 2.10 MIDI controllers, Remote and scripting

| ID | Feature | Tier | Cx | Deps | KS note |
|---|---|---|---|---|---|
| MC01 | MIDI settings: enable inputs and outputs, controller type, generic controller mode, new-controller notification (2026.1.6) | P0 | M | ENG | |
| MC02 | **Link to controller** (MIDI learn) per control, with mapping formulas; **Multilink** (link many controls at once) | P1 | M | ENG | |
| MC03 | Pre-configured controller scripts (Akai Fire, MCU, etc.) | P3 | L | ENG | Community-driven. |
| MC04 | **MIDI scripting (Python):** device scripts in `Settings\Hardware\<device>\device_<name>.py`; modules transport, mixer, channels, patterns, playlist, arrangement, ui, plugins, general, device, launchMapPages; callbacks such as `OnMidiMsg`, `OnRefresh`, `OnIdle` ([MIDI scripting](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/midi_scripting.htm)) | P2 | L | ENG | **This is FL's real agent surface.** Every FL MCP server we found goes through it (§8). KS: an MCP server plus a JS/TS script API over the same command bus. |
| MC05 | **FL Studio Remote** (phone/tablet app; v2 in 2025.1; per-project layouts and a pad mode that runs Python scripts in 2025.2) | P2 | L | NET | KS: a browser-based LAN remote is cheap with web tech. |
| MC06 | MIDI Out plugin (hardware synths, program changes 2026); MIDI clock out | P2 | M | ENG | |
| MC07 | MPE input to plugins **(unverified detail)** | P2 | M | HOST | |

### 2.11 Render, export and file formats

Sources: [Export dialog](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/fformats_save_export.htm), [Project formats](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/fformats_project.htm), [Other formats](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/fformats_other.htm).

| ID | Feature | Tier | Cx | Deps | KS note |
|---|---|---|---|---|---|
| EX01 | Export (Ctrl+R) of a Song or Pattern. **Tail:** leave remainder / wrap remainder (for seamless loops) / cut remainder. | P0 (song/pattern, leave/cut) / P1 (wrap) | M | ENG | Wrap remainder is beloved by loop makers. |
| EX02 | Formats: WAV 16/24/32-bit float; MP3 up to 320 kb/s; OGG up to 450 kb/s; FLAC 16/24-bit with level 0–8; M4A; WavPack | P0 (WAV, MP3) / P1 (FLAC, OGG) | S–M | — | Check encoder licences before shipping. |
| EX03 | Quality: resampling (Linear, 6-point Hermite, 16–512-point Sinc); "HQ for all plugins"; disable max polyphony; dithering (16-bit and MP3) | P1 | M | ENG, DSP | |
| EX04 | **Split mixer tracks** (stems), including Master and Current (2026.1.6); trim PDC silence; enable insert/master FX; stereo or mono modes | P1 | M | ENG | |
| EX05 | Metadata: Playlist, loop and note markers; tempo in the WAV | P2 | S | — | |
| EX06 | MIDI export (requires "Prepare for MIDI export") | P0 | S | — | |
| EX07 | Mastering via FL Cloud; SoundCloud upload; DistroKid | P3 (skip) | — | NET | An agent-driven local mastering chain could be P2. |
| EX08 | **Project formats:** `.flp` (native; **does not contain samples**); `.zip` (flp plus samples and presets, excluding third-party plugin samples); `.fst` (channel/plugin state); `.fsc` (score); `.fpr` (humanize presets); `.fnv` (envelope presets); backups folder | P0 (own format) / P3 (`.flp` import) | M / XL | — | KS: an open JSON schema plus a zipped bundle with samples. See §9 for `.flp`. |
| EX09 | Import: WAV, MP3, FLAC, OGG, AIFF; MIDI; ReCycle REX; SF2; BeatSlicer grid | P0 (WAV, MP3, FLAC, MIDI) / P2 (SF2, REX) | S–M | — | |

### 2.12 Gaps and misc (P3 / skip list)

Video Player and ZGameEditor Visualizer (video export), FL Chan (Fruity Dance), Fruity Vibrator, Razer Chroma lighting, Fruity LSD (Windows GM synth), Big Clock, Speech Synthesizer, Scratcher with DVS, ReWire, FL as a plugin, surround, Hardcore guitar FX, SynthMaker (legacy). All P3 or skip.

---

## 3. Tier roll-up

### P0: MVP (make and export one full beat)
- **Engine** (XL): transport, tempo, Pattern/Song mode, sample-accurate MIDI/event scheduling, sampler and synth voices, insert/bus/master mixing, WASAPI (ASIO when possible), offline render.
- **Project:** open JSON format plus assets, save and load, autosave, Ctrl+N version snapshots, real multi-level undo.
- **Rack:** channels (volume, pan, mute, solo, mixer target), 16–512 steps, click/right-click/paint editing, Graph editor velocity and pan, global and per-channel swing, number-key mute, Ctrl+click preview, drag sample to create a channel.
- **Patterns:** create, clone, select (Numpad, F4), length, colour.
- **Piano roll:** draw/paint/select/delete/slice; last note length; snap with Alt bypass; preview on click; velocity lane and Alt+wheel; scale highlighting; copy/paste/duplicate/transpose; quick quantize; MIDI import and export.
- **Playlist:** tracks, paint pattern clips, Make unique, audio clips (trim, gain, fades), basic automation clips, loop selection, pattern picker.
- **Mixer:** dynamic inserts, master, routing to master and buses, volume, pan, mute, solo, FX slots (bypass, reorder), peak meters.
- **Instruments:** Sampler (with mono/glide and cut groups), 808/kick synth, 3-oscillator subtractive synth.
- **Effects:** parametric EQ, compressor, limiter, soft clipper, reverb, delay, filter, drive/bitcrush, utility, spectrum/peak meter.
- **Browser:** folders, search, preview, drag.
- **Input:** typing keyboard, MIDI keyboard, basic note recording with count-in and metronome.
- **Export:** WAV, MP3, MIDI; song or pattern; leave or cut tail.
- **MCP:** every item above callable through the shared command bus.

### P1: Producer-ready
- **Plugin hosting:** VST3 and CLAP hosting (sandboxed), plugin scanner and picker, PDC, multi-output plugins, sidechain routing with send knobs and pre/post switch.
- **Rack and Piano roll:** ghost notes; slide and portamento notes; stamp; full Quantizer and chop/glue/strum/arp/flip/randomize/limit; Graph editor (all lanes); channel envelopes, LFOs and arpeggiator; filter groups; score logger; multi-channel Piano roll editing.
- **Audio clips and arrangement:** pitch, reverse, crossfades, **time-stretch and tempo-sync**, tempo automation with restretch, time-signature changes, markers, track groups, instrument and audio track modes.
- **Recording:** audio recording, live drawing of recordings, automation recording, MIDI learn and multilink.
- **Mixing:** stem export, FLAC/OGG, dithering, wrap remainder; LUFS, true-peak and correlation meters; built-in track EQ; phase, swap and stereo separation.
- **Stock plugins:** a hero polysynth, drum pads, slicer, keys, modulation FX, maximizer/multiband, volume shaper, transient shaper, stereo tools, modulators, a basic clip editor.
- **UI:** docking layout, hint bar, command palette, templates, Welcome screen, project notes panel.

### P2: FL parity
Patcher-class modular graph; Performance mode; multiple arrangements; take lanes and comping; punch in/out; Edison tools; Riff-Machine-style generator; chord progression tool and detection; Piano roll scripting; claw/LFO/scale-levels tools; Layer channels; Burn MIDI; channel echo; Event Editor equivalent folded into lanes; marker actions; consolidate; stem separation (local ML); similar-sample search; FM synth, acid bass, multisampler (SFZ/SF2), granular, pluck, drum synth, ROMpler pack format, Gross-Beat-style time FX, Pitcher-style tuning, vocoder, convolver, freq/pitch shifter, low enhancer, tuner; MIDI Out; Remote (web); MPE; freeze; VCA; mix snapshots; hidden tracks; export metadata; themes.

### P3: Nice-to-have or skip
`.flp` import, additive/resynthesis synth (Harmor class), physical modelling, Newtone-class pitch editor, AI Deverb/denoise, cloud mastering and distribution, cloud sounds, Loop Starter content, controller script library, FL-as-plugin, surround, external clock sync, PDF score export, video/visualizer, Speech synth, scratch/DVS, lighting and joke plugins, ReWire.

---

## 4. FL Studio stock plugin catalog (by edition, one line each)

Edition data comes from [Compare editions](https://www.image-line.com/fl-studio/compare-editions). Descriptions are from the [Effects index](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/effects_plugins.htm), the [manual TOC](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/Index_Frame_Left.html) and the release notes. Descriptions marked (u) are from prior knowledge and **unverified** this session.

### 4.1 Instruments / generators

**All editions (Fruity, 23 counted)**

| Plugin | What it does |
|---|---|
| 3x OSC | Classic three-oscillator subtractive synth (u). |
| Autogun | Preset-only synth whose presets are picked by number from a huge numbered set, based on Ogun (u). |
| BassDrum | Two-layer kick drum synthesizer (vector UI in 2025.1). |
| BeepMap | Turns images into sound (u). |
| BooBass | Simple bass guitar emulation (u). |
| Channel Sampler | FL's default sample-playback channel (loop points and preview added in 2025.2). |
| DirectWave Player | Play-only version of the DirectWave sampler (u). |
| Drumpad | Physically modelled drums and percussion (u). |
| FLEX | Preset player with downloadable packs (engine rebuilt in 2026, up to 50% less CPU). |
| FL Keys | Sampled piano and keys player (u). |
| Fruity DrumSynth Live | Synthesizes drum sounds (u). |
| Fruity DX10 | FM synth modelled on 1980s FM instruments (u). |
| Fruity Granulizer | Granular sample player (full plugin since 2025.1). |
| Fruity Kick | Simple pitch-sweep kick synth (u). |
| FPC (Fruity Pad Controller) | MPC-style pad drum sampler with layers (dropping several samples creates layers, 2026). |
| Fruity Slicer / Fruity Slicer 2 | Beat slicer that maps slices to notes (Slicer 2 added 2025.2). |
| GMS (Groove Machine Synth) | Synth ported from FL Studio Mobile (u). |
| MiniSynth | Compact subtractive synth (u). |
| Plucked! | Karplus-Strong plucked-string synth (u). |
| SimSynth | Classic three-oscillator analog-style synth (u). |
| Speech Synthesizer | Text-to-speech (Windows only). |
| Wave Traveller | Turntable-style scratch sample player (u). |

The **utility generators** in all editions are FL Studio Mobile Rack (Mobile instruments and FX; SoundFont Player and Note Arpeggiator inside it since 2026), MIDI Out, Fruity Keyboard Controller, Fruity Envelope Controller, Fruity Voltage Controller and Control Surface. **Legacy or misc** (manual only): Dashboard, Fruity Dance (FL Chan), Fruity Layer, Fruity Vibrator, FL Slayer, Wasp, Wasp XT, ReWire, SynthMaker.

| Edition | Plugin | What it does |
|---|---|---|
| Producer and up (+4) | Kepler | Recreation of the Roland Juno-6 ([Image-Line](https://www.image-line.com/fl-studio-news/fl-studio-21-2-whats-new/), [MusicRadar](https://www.musicradar.com/news/fl-studio-update-21)) |
| Producer and up | Slicex | Advanced loop slicer and sampler with wave editor and articulation (u) |
| Producer and up | SoundFont Player | Plays SF2 banks |
| Producer and up | Sytrus | Hybrid FM, RM and subtractive synth (u) |
| Signature and up (+2) | DirectWave (full) | Multisample sampler and editor (Shift+click multi-select of zones, 2026) |
| Signature and up | Harmless | Additive synth that works like a subtractive one (u) |
| All Plugins (+10) | Drumaxx | Physically modelled drum synth |
| All Plugins | Harmor | Additive and subtractive synth with image and audio resynthesis (u) |
| All Plugins | Kepler Exo | Lo-fi synth inspired by the Juno and Jupiter ([gearnews](https://gearnews.com/fl-studio-daw-software)) |
| All Plugins | Morphine | Additive synth with morphing and resynthesis |
| All Plugins | Ogun | Additive synth for metallic and ambient timbres (u) |
| All Plugins | Poizone | Easy subtractive synth (u) |
| All Plugins | Sakura | Physically modelled string synth (u) |
| All Plugins | Sawer | Vintage-style subtractive synth (u) |
| All Plugins | Toxic Biohazard | Hybrid FM and subtractive synth with a sequencer |
| All Plugins | Transistor Bass | TB-303-style acid bass synth with a sequencer (u) |

### 4.2 Effects

**All editions (Fruity, 53 counted)**

| Plugin(s) | What it does |
|---|---|
| Fruity Limiter | Single-band limiter, compressor and gate with sidechain ducking (manual: "maximizer, compressor and limiter"). |
| Fruity Compressor | Controls peaks and thickens sound (sidechain input since 2025.2). |
| Fruity Multiband Compressor | Three-band compression. |
| Fruity Soft Clipper | Easy soft limiter. |
| Soundgoodizer | One-knob "shine" maximizer with A/B/C/D modes, based on Maximus (u). |
| Emphasizer | Lite version of the Emphasis mastering limiter (2025.2). |
| Fruity Parametric EQ / EQ 2 | Seven-band parametric EQs; EQ 2 has a spectrum display. |
| EQUO | Graphic EQ. |
| Fruity Filter | Easy multimode filter. |
| Fruity Love Philter | Advanced filter with envelopes. |
| Fruity Delay 2 / Delay 3 / Delay Bank | Filtered echo; tempo-synced, modulated delay; multi-tap delays with filtering. |
| Fruity Reeverb 2 | Algorithmic room reverb. |
| Fruity Convolver | Convolution reverb, which also works as a linear-phase EQ. |
| Fruity Chorus / Flanger / Flangus / Phaser | Modulation effects. |
| Fruity Fast Dist / Blood Overdrive / WaveShaper / Squeeze | Distortion, overdrive, drawable waveshaping, bit and sample reduction. |
| Distructor | Multi-model distortion and multi-effect. |
| Effector | Twelve performance effects. |
| Frequency Splitter | Splits audio into 2 or 3 bands. |
| Fruity Balance / PanOMatic / Stereo Enhancer / Stereo Shaper | Balance, auto-pan, stereo widening, mid/side shaping. |
| Fruity Send | Pre-fader send from any point in the FX chain. |
| Fruity Vocoder | Classic vocoder. |
| Fruity Scratcher | Turntable scratch simulation (DVS support in 2024.2). |
| Tuner | Instrument tuner. |
| Patcher | Modular host for chains of instruments and effects. |
| VFX Script / Sequencer / Envelope / Key Mapper / Keyboard Splitter / Level Scaler / Color Mapper | Note-processing modules for Patcher only (Script runs Python). |
| Formula / Peak / X-Y / X-Y-Z Controllers; Control Surface | Generate modulation and control: math formulas, audio follower, 2D/3D pads, custom control panels. |
| Fruity NoteBook / NoteBook 2 / HTML NoteBook | Project notes synced to playback. |
| Fruity LSD | Plays the Windows built-in GM synth. |
| Razer Chroma | Drives keyboard RGB lighting. |
| Legacy, in the manual only | Fruity 7 Band EQ, Bass Boost, Center (removes DC offset), Delay 1, Fast LP, Free Filter, Mute 2, Phase Inverter, Reeverb 1, Fruity Wrapper. |

**Producer and up (+6):**
- Frequency Shifter: dissonant, metallic or modulated shifts.
- Hyper Chorus: extreme chorus (21.1).
- Maximus: multiband (3 bands plus master) maximizer, compressor and limiter.
- Multiband Delay: a separate delay per frequency band.
- Spreader: mono-compatible stereo enhancer.
- Vocodex: advanced vocoder.

**Signature and up (+6):**
- **Gross Beat:** time and volume manipulation (stutter, half-time, tape stop, scratch, gating) through drawable, slot-based envelopes. MIDI slot triggering since 2026.
- Hardcore: multi-effect guitar rack with 11 effects.
- Low Lifter: adds low-frequency harmonics.
- **Pitcher:** real-time pitch correction and harmonizer.
- Vintage Chorus: Juno-6-style chorus.
- Vintage Phaser: phaser modelled on a classic stompbox.

**All Plugins (+6):**
- Emphasis: multi-stage mastering limiter (2025.1).
- LuxeVerb: advanced algorithmic reverb.
- Pitch Shifter: pitch and formant shifting.
- Transient Processor: attack and release shaping.
- Transporter: automatic relooping and retriggering (2024.2).
- Transmitter: splits transients from sustain for separate processing (2026).

**Audio editors:**
- Edison (Producer and up): wave editor and recorder.
- Newtime (Producer and up): time warping.
- Newtone (Signature and up): Melodyne-style pitch and time editor.

**Video and visual:**
- All editions: Fruity Big Clock, Fruity dB Meter, Fruity Spectroman, Wave Candy (scope and spectrum), ZGameEditor Visualizer.
- Signature and up: Fruity Video Player.

---

## 5. KryptStudio stock-plugin plan (FL plugin → KS equivalent)

Names are **working names only**. No Image-Line names, no "Fruity" prefix, and no name patterns that echo FL's. Final names follow the brand rules in §9.

### 5.1 Instruments

| KS working name | Replaces (FL) | Prio | Cx | Notes |
|---|---|---|---|---|
| **KS Sampler** | Channel Sampler, sampler channel settings, DirectWave Player, Wave Traveller (in part) | **P0** | M | `ENG DSP`. Root note, ADSR on volume/pitch/filter, filter, reverse, loop, mono/glide, cut groups, slide notes. The default channel type. |
| **KS 808** | BassDrum, Fruity Kick, BooBass (role) | **P0** | S | Sine/triangle pitch-sweep kick plus a sustained 808 with glide, drive and click layer. Must respond to slide notes. |
| **KS Tri** (3-osc) | 3x OSC, SimSynth, MiniSynth, GMS | **P0** | M | 3 oscillators plus noise, 1 filter, 2 envelopes, 1 LFO, unison. Simple parameters suit agents. |
| KS Pads | FPC, Drumpad (role) | P1 | M | 16+ pads, layers, velocity zones, round-robin, choke groups, kit presets. |
| KS Slice | Fruity Slicer, Slicer 2, Slicex | P1 | M | Transient detection, slices mapped to notes, per-slice pitch and envelope, write the slice pattern. |
| KS Poly (hero synth) | Kepler, Kepler Exo, Poizone, Sawer, the Toxic Biohazard subtractive role | P1 | L | Virtual-analog plus wavetable, 2 filters, mod matrix, built-in chorus, MPE-ready. **Do not bundle GPL synths (Vital, Surge XT) in-process.** Recommend them as optional free third-party plugins instead. |
| KS Keys | FL Keys | P1 | M + CONTENT | Piano/EP from CC0 or permissively licensed sample sets. Check each licence. |
| KS Acid | Transistor Bass | P2 | M | 303-style mono with accent and slide; uses Piano roll slides. |
| KS FM | Sytrus, Fruity DX10, Toxic Biohazard (FM role) | P2 | L | 4–6 operator FM with a matrix. |
| KS Multisampler | DirectWave full, SoundFont Player | P2 | L | SFZ and SF2 import. Check the licences of candidate libraries (e.g. sfizz, TinySoundFont); **unverified this session**. |
| KS Grain | Fruity Granulizer | P2 | M | |
| KS Pluck | Plucked! | P2 | S | |
| KS DrumSynth | Fruity DrumSynth Live, Drumpad, Drumaxx | P2 | M | |
| KS ROM (preset player plus open pack format) | FLEX | P2 | XL (mostly content) | Packs carry tags, so agents can choose presets by description. Gopher cannot pick presets; this is our gap to fill. |
| KS Layer | Fruity Layer channel | P2 | M | |
| KS MIDI Out | MIDI Out | P2 | S | |
| KS Additive / Resynth | Harmor, Harmless, Morphine, Ogun, BeepMap, Autogun | P3 | XL | |
| KS Physical | Sakura, Drumaxx (modelling) | P3 | L | |
| skip | Speech Synthesizer, FL Slayer, Wasp/XT, Fruity Dance, Vibrator, Mobile Rack, ReWire, Dashboard (becomes the KS macro panel) | P3 / skip | — | |

### 5.2 Effects and tools

| KS working name | Replaces (FL) | Prio | Cx | Notes |
|---|---|---|---|---|
| **KS EQ** | Parametric EQ 2, Parametric EQ, EQUO, 7 Band EQ, Bass Boost | **P0** | M | 8-band parametric with analyzer. Mid/side in P1. |
| **KS Comp** | Fruity Compressor | **P0** | M | Sidechain input in P1. |
| **KS Limiter** | Fruity Limiter, Emphasizer | **P0** | M | Zero-latency mode in P0. The lookahead mode needs PDC (P1). |
| **KS Clip** | Fruity Soft Clipper | **P0** | S | A trap and drill staple. |
| **KS Verb** | Reeverb 2, LuxeVerb (lite) | **P0** | M | Algorithmic (FDN). |
| **KS Delay** | Delay 3, Delay 2, Delay Bank | **P0** | M | Tempo sync, ping-pong, filter, modulation. |
| **KS Filter** | Fruity Filter, Fast LP, Free Filter | **P0** | S | Love Philter-style envelopes in P2. |
| **KS Drive** | Fast Dist, Blood Overdrive, WaveShaper, Squeeze, Distructor | **P0** | S–M | Saturation, bitcrush, drawable shaper (P1). |
| **KS Utility** | Balance, Phase Inverter, Center, Mute 2, PanOMatic | **P0** | S | |
| **KS Meter** | dB Meter, Wave Candy, Spectroman | **P0** (peak, spectrum) / P1 (LUFS, true-peak, correlation, scope) | S–M | **Beat FL** with LUFS. |
| KS Mod | Chorus, Flanger, Flangus, Phaser, Vintage Chorus/Phaser, Hyper Chorus | P1 | M | |
| KS Stereo | Stereo Enhancer, Stereo Shaper, Spreader | P1 | S | |
| KS Maximizer | Maximus, Multiband Compressor, Emphasis, Soundgoodizer (as a one-knob preset mode) | P1 | L | |
| KS Shaper (volume) | The volume half of Gross Beat; sidechain-pump use of the Peak Controller | P1 | M | Tempo-synced drawable volume curves. |
| KS Transient | Transient Processor, Transmitter | P1 | S–M | |
| KS Notes | NoteBook 1/2, HTML NoteBook | P1 | S | Project notes **that agents read and write**. |
| KS Modulators | Formula, Peak, X-Y, X-Y-Z, Envelope and Keyboard controllers | P1 (LFO, envelope follower) / P2 (XY, formula) | M–L | Part of the single modulation system. |
| KS Clip Editor | Edison | P1 (basic) / P2 (tools) | M–L | Non-destructive. |
| KS Glitch (time) | The time half of Gross Beat, Transporter, Effector, Scratcher | P2 | L | |
| KS Tune | Pitcher | P2 | L | Real-time pitch correction. |
| KS Warp | Newtime | P2 | L | Folded into audio-clip warp markers. |
| KS Vocoder | Fruity Vocoder, Vocodex | P2 | M | |
| KS Convolver | Fruity Convolver | P2 | M | Ship CC0 impulse responses. |
| KS Shift | Frequency Shifter, Pitch Shifter | P2 | M | |
| KS Low Lift | Low Lifter | P2 | M | |
| KS Split | Frequency Splitter, Multiband Delay | P2 | S | Or built from the graph. |
| KS Tuner | Tuner | P2 | S | |
| KS Graph | Patcher, VFX modules, Control Surface, Dashboard | P2 / P3 | XL | |
| KS Pitch Editor | Newtone | P3 | XL | |
| skip | Hardcore, LSD, Razer Chroma, Big Clock, Video Player, ZGE Visualizer, SynthMaker; Fruity Send (becomes a built-in pre/post send) | P3 / skip | — | |

---

## 6. Why people love FL: the signature features we have to get right

1. **Step sequencer speed.** Reviewers and guides keep saying the Channel Rack lets you "sketch beat ideas faster than any other DAW" ([audeobox](https://www.audeobox.com/learn/fl-studio/)). FL's distinctive "sequencer-centred workflow" is the first pro in MusicTech's review ([MusicTech](https://musictech.com/reviews/digital-audio-workstations/fl-studio-2025-review)).
   - **Feel spec for KS:**
     - A new project opens with a drum kit already in the rack.
     - Toggling a step is audible on the next pass, with no stutter or glitch.
     - Left-click sets, right-click clears, drag paints. Ctrl+click previews a channel. Number keys mute.
     - Swing is one knob.
     - **Target: a 4-bar kick/snare/hat loop in under 30 seconds from launch.**
2. **Piano roll feel.** It is widely called "one of the best piano rolls of any DAW", with ghost notes, Chord Stamp, strum, slide notes and scale highlighting usually cited ([audeobox](https://www.audeobox.com/learn/fl-studio/how-to-use-the-piano-roll-in-fl-studio/)). MusicTech praises its "superb MIDI editing".
   - **Feel spec for KS:**
     - New notes reuse the last length.
     - Notes sound on click.
     - Alt bypasses snap.
     - Single-letter tools, right-click deletes, Alt+wheel sets velocity.
     - Ghost notes and scale lanes.
     - Slide notes that every stock instrument respects.
     - Smooth 60–120 Hz zoom and scroll (FL supports >120 Hz displays since 2025.1).
3. **Pattern-based arranging.** A pattern is a reusable block, and editing it updates every clip that uses it. You paint patterns across the Playlist, and Playlist tracks are not tied to mixer tracks. "Make unique" forks a copy, and L flips between pattern and song.
   - **Keep the model.** Also show an instance-count badge on clips and offer an optional "auto-make-unique on edit", because FL newcomers are confused by shared patterns.
4. **Lifetime free updates** ([Image-Line](https://www.image-line.com/fl-studio/lifetime-free-updates)). This is FL's biggest loyalty driver. **KS beats it outright:** free, MIT, every feature, no editions, no subscription.
   - FL still gates audio recording, Edison and stem separation by edition (the compare page says Producer and up).
   - Gross Beat and Pitcher need Signature ($299 (u)).
   - Sounds, mastering and 90+ plugins sit behind FL Cloud Plus or Pro.
5. **Generous stock instruments for beginners.** "Strong foundation, especially for new producers" ([MusicTech](https://musictech.com/reviews/digital-audio-workstations/fl-studio-2025-review)).
6. **Discoverability:** the hint bar, everything draggable, and right-click menus everywhere.
7. **Identity and community:** FL is the reference DAW for hip-hop, trap, EDM and grime. 9th Wonder and Soulja Boy's "Crank That" are famous examples ([Wikipedia](https://en.wikipedia.org/wiki/FL_Studio)). Production Expert's 2025 survey is skewed towards Pro Tools and post-production users, so do not use it to judge FL's reach among beatmakers ([Production Expert](https://www.production-expert.com/production-expert-1/2025-daw-survey-the-results)).

---

## 7. Pain points: where KS can beat FL

| Pain point | Evidence | KS answer | Tier |
|---|---|---|---|
| Recording setup is manual. MIDI recording shows nothing while it records, and clips land in unexpected places. | MusicTech 2025: recording "almost broke my brain" ([review](https://musictech.com/reviews/digital-audio-workstations/fl-studio-2025-review)) | One-click arm on tracks; recordings drawn live; a predictable landing position | P0 (MIDI) / P1 (audio) |
| No take lanes, swipe comping, quick punch, or pre/post-roll; takes are grouped per input rather than per loop | Forum, Oct 2025 – May 2026 ([1](https://forum.image-line.com/viewtopic.php?p=2029224), [2](https://forum.image-line.com/viewtopic.php?p=2053513), [3](https://forum.image-line.com/viewtopic.php?p=2058791)) | Take lanes plus swipe comping, punch, pre/post-roll | P2 |
| No track freeze or pre-render | [forum](https://forum.image-line.com/viewtopic.php?p=2029224) | Freeze/unfreeze; render-in-place | P1 / P2 |
| Routing and sidechain are hard to learn and fragile | Forum and aggregator summaries ([rfp.wiki](https://www.rfp.wiki/vendors/fl-studio/reason)) | Routing graph view, a "sidechain from" picker on plugins, and an inspector that agents can explain | P1 |
| "Around five" overlapping automation and routing systems (clips, pattern events, recorded events, controllers, remote links, Patcher) | Image-Line forum complaints that came up in searches ([e.g.](https://forum.image-line.com/viewtopic.php?p=2046923), [e.g.](https://forum.image-line.com/viewtopic.php?p=2026509)); exact thread attribution not verified | **One** automation model (lanes and clips) and **one** modulation system | P0 design |
| Ctrl+Z toggles instead of stepping back | [manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_shortcuts.htm) | Standard multi-level undo | P0 |
| No ARA. Staff said it is "on the list" (Nov 2024), and users link it to a multi-year engine rewrite. | [forum](https://forum.image-line.com/viewtopic.php?p=1979721), [forum](https://forum.image-line.com/viewtopic.php?p=1986092) | P3. Design the clip engine so ARA2 is possible later; check the ARA SDK licence. | P3 |
| No LUFS, true-peak or correlation meters; no VCA, mix snapshots, hidden tracks, input/output trim or plugin sandboxing | [forum](https://forum.image-line.com/viewtopic.php?p=2053513) | Meters in P1, sandboxing in P1, the rest in P2 | P1–P2 |
| Slow plugin rescans | Forum complaint | Background incremental scanning in a separate process | P1 |
| No true dockable UI; features buried in right-click menus; theme fatigue | Forum and G2 ([G2](https://www.g2.com/survey_responses/fl-studio-review-4850838)) | Docking layout and command palette | P1 |
| Native instruments have no MIDI in/out ports; FL uses its own "voices" model | Forum complaint | Every instrument takes standard note events; MIDI out from any track | P2 |
| Resolution and zoom tied to PPQ | Forum complaint | Fixed high-resolution timebase | P0 |
| Rigid for non-grid music (ambient, live playing) | MusicTech | Free-time recording, tempo track, warp markers | P2 |
| Gopher is slow and limited (no melodies, automation or presets), and an assistant that "hides its moves" gets annoying | [RouteNote](https://routenote.com/blog/fl-studio-2026-gopher-ai-production-assistant/), [ainauten](https://news.ainauten.com/en/story/fl-studio-2026-turns-its-ai-chatbot-into-your-assistant-engineer) | MCP-first. Agent edits appear as visible, reviewable diffs and undo as one step. The full surface covers notes, automation, presets, routing and render. | P0 |
| Edition paywalls and subscription creep | §1.2 | Free and complete | — |

---

## 8. Surprising findings

1. **Image-Line is going agentic, but only partway.** Gopher grew from a Q&A bot (2025.1) to writing Piano roll scripts (2025.2) to experimental in-project control (2026). Hands-on reports say it **still can't write melodies or chords, draw automation, or pick presets**. Those are exactly the jobs KS's MCP surface should do well.
2. **At least five community FL Studio MCP servers already exist.** Examples: [rosasynthesiz/flstudio-mcp](https://github.com/rosasynthesiz/flstudio-mcp) (MIT, 67 tools), [alansork/fl-studio-mcp](https://glama.ai/mcp/servers/alansork/fl-studio-mcp), [kaupau/flai-mcp](https://glama.ai/mcp/servers/kaupau/flai-mcp), and [purahmanian/flstudio-mcp-mac](https://claudemarketplaces.com/mcp/purahmanian/flstudio-mcp-mac).
   - All of them work around FL through the MIDI-scripting API, virtual MIDI ports (loopMIDI or IAC) and a Piano roll script that the user has to arm by hand.
   - By rosasynthesiz's own account, **FL's API cannot load plugins, load audio files or render.**
   - Demand for agent control of a DAW is real, and an MCP server built into the DAW, with no workarounds, is a clear advantage.
3. **FL's mixer only went dynamic, from 125 to 500 inserts, in mid-2025**, and it still has **10 FX slots per track**. Image-Line's answer for more slots is "use Patcher" or Patcherize.
4. **Hard limits and quirks are still there:** 512 steps per pattern, default PPQ 96, Ctrl+Z toggling, slides only on native instruments, and only one channel editable per Piano roll.
5. **Image-Line's own pages disagree on edition gating.** Stem Separation is "Producer and up" on the compare page and "all editions" on the pricing page.
6. **Fruity Edition has allowed only up to 8 audio clips since 21.2** and cannot record audio. A free, complete KS is a sharp contrast to that entry tier.
7. **`.flp` keeps changing.** The upstream PyFLP parser has been unmaintained since mid-2023 and cannot read files saved by FL 24 and later. A GPL-3 fork ([Meowrium/PyFLP](https://github.com/Meowrium/PyFLP)) patches it for FL 26. For example, FL 26 changed event `0xAC` to use a varint length, and Playlist item records now come in 32, 60, 80 or 88 bytes. An `.flp` importer would be a maintenance treadmill and would bring GPL into an MIT project (see §9).
8. **FL's richest automation API is its Python MIDI-scripting layer.** Its modules (transport, mixer, channels, patterns, playlist, arrangement, plugins, ui, general) are a useful checklist for our MCP tool groups. We should cover what it lacks: loading plugins and samples, rendering, and analysis.
9. **House naming:** the guide's `Krypt <Tool>` rule gives **"Krypt Studio"**, not "KryptStudio".

---

## 9. Legal and IP caution

*This is research for engineering, not legal advice. Image-Line NV is a Belgian (Ghent) company, so EU law applies as well as US law. Have counsel review before the public 1.0 release.*

### 9.1 Trademarks: never use these as our names
- **Marks to avoid:**
  - "FL Studio" (US filings by Image Line NV: serial 79002388, filed 2003; serial 86596929, filed 2015; registration status not verified ([Justia](https://trademarks.justia.com/owners/image-line-nv-4234145)))
  - "Image-Line" and its logos
  - "FruityLoops" and the "Fruity" prefix. The product was renamed FL Studio after Kellogg's objected to the US trademark application ([Wikipedia](https://en.wikipedia.org/wiki/FL_Studio)).
- **Treat every Image-Line product and plugin name as a mark**, registered or not: Sytrus, Harmor, Harmless, Gross Beat, Maximus, Soundgoodizer, Edison, Newtone, Newtime, Pitcher, Vocodex, FLEX, FPC, Slicex, DirectWave, Transistor Bass, Kepler, Sakura, Ogun, Morphine, Poizone, Toxic Biohazard, Drumaxx, Emphasis, LuxeVerb, Transporter, Transmitter, Gopher, FL Cloud, Loop Starter, FL Chan, Patcher, and so on.
- **Do not use them in:** product, plugin or preset names, menu labels, file extensions (never write `.flp`, `.fst` or `.fsc` for our own files), app-store keywords, domains, or logos.
- **FL-coined UI terms: give them our own names.**
  - Avoid: "Channel Rack", "Plugin Picker", "Picker panel", "Riff Machine", "Chord Stamp", "Multilink", "Patcherize", "Loop Starter", "Graph editor" as a feature name, "Hint bar" (borderline).
  - Fine to use (generic): piano roll, step sequencer, pattern, playlist/arranger, mixer, browser, ghost notes, slide notes, swing, sidechain, automation clip.
- **Comparisons:** factual, nominative statements are fine in docs, such as "imports MIDI exported from FL Studio" or "familiar to FL Studio users". Add a line: *"FL Studio is a trademark of Image Line NV. Krypt Studio is not affiliated with or endorsed by Image-Line."* Never use their logo or imply partnership. EU comparative-advertising rules ([Directive 2006/114/EC](https://eur-lex.europa.eu/eli/dir/2006/114/oj), not fetched this session) allow only objective comparisons that don't mislead.

### 9.2 Trade dress and UI: copy the function, not the look
- **EU:** a GUI is not protected as a "computer program", but **can be protected by copyright as a work** if it is the author's own intellectual creation. CJEU *BSA*, C-393/09 ([Fieldfisher](https://www.fieldfisher.com/en/insights/graphical-user-interfaces-can-be-protected-by-copyright-rules-european-court)).
- **US:** trade dress protects a look that is distinctive and non-functional. **Functional features cannot be protected** (*TrafFix v. Marketing Displays*, 2001 ([Wikipedia](https://en.wikipedia.org/wiki/TrafFix_Devices,_Inc._v._Marketing_Displays,_Inc.))). Menu-command hierarchies were held to be an uncopyrightable "method of operation" (*Lotus v. Borland*, 1st Cir. 1995, affirmed by an equally divided Supreme Court in 1996 ([Wikipedia](https://en.wikipedia.org/wiki/Lotus_Development_Corp._v._Borland_International,_Inc.))).
- Image-Line's own support page says users "must not use Image-Line logos, fonts, or visual style in ways that could mislead" ([KB](https://support.image-line.com/action/knowledgebase/?ans=41)).
- **Do not copy verbatim:**
  - FL's colour theme
  - Icons, the fruit logo, FL Chan
  - Knob, fader and step-button graphics
  - The exact Channel Rack row layout and proportions
  - Toolbar and transport panel layout
  - Welcome window
  - **Any plugin GUI.** Examples: Gross Beat's slot list plus envelope grid, Sytrus's matrix layout, Parametric EQ 2's look, FPC's pad panel, Harmor's panels.
  - Hint-bar and menu wording, manual and tutorial text, screenshots in our marketing
- **Safe to reproduce:** workflows and behaviours. That includes the step grid concept, pattern-as-reference arranging, single-letter tool keys, F-key window toggles, slide notes and ghost notes.
  - Keyboard shortcuts are functional. An "FL-style keymap" is low risk, but give the preset a neutral name (e.g. "Pattern workflow").
  - The Krypt house look (dark neon, Chakra Petch, indigo→purple→pink) already sets us visibly apart. Use it everywhere.
- **Patents:** none from Image-Line turned up in this research. That is **not** a clearance; run a proper patent search before 1.0.

### 9.3 Content: never ship or derive from FL assets
- The [EULA](https://www.image-line.com/image-line-software-eula/), Art. 12.1, forbids reusing Image-Line content as a sound library for any synth or sample library, and forbids redistributing demo songs.
- The [support KB](https://support.image-line.com/action/knowledgebase/?ans=41) says: "You may not isolate or sell FL Studio's built-in sounds or create sample packs from them."
- **Rules for KS:**
  - No FL samples, presets, FLEX packs, FL Cloud sounds, demo projects or impulse responses.
  - No copying factory preset parameter values.
  - No training models on FL content.
  - Do not paste FL manual text into our docs or agent prompts. Manuals are protected; *SAS v WPL* ([PDF](https://www.ippt.eu/sites/ippt/files/2012/IPPT20120502_ECJ_SAS_Institute_v_WPL.pdf)).
  - All KS content must be CC0, original, or clearly licensed for redistribution under our terms.

### 9.4 The `.flp` format
- **Facts:**
  - `.flp` is a binary event stream (TLV-style records; see the [PyFLP docs](https://pyflp.readthedocs.io/)) and holds no samples.
  - Image-Line plugin states inside it are proprietary blobs. Even a perfect importer would recover only notes, patterns, arrangement, mixer routing, automation, sample paths and the opaque state chunks of third-party plugins.
  - The format changes from version to version (§8.7).
- **EU law:**
  - The **format of data files is not protected as an expression of a computer program**, and a lawful user may observe, study and test how a program works (*SAS Institute v WPL*, C-406/10, 2 May 2012 ([Fieldfisher](https://www.fieldfisher.com/en/insights/sas-institute-inc-v-world-programming-limited))).
  - The Software Directive 2009/24/EC, **Art. 6**, allows decompilation that is indispensable for interoperability, under strict conditions. **Art. 8** voids contract terms that conflict with it ([Art. 6](https://www.legislation.gov.uk/eudr/2009/24/article/6), [full text](https://www.legislation.gov.uk/eudr/2009/24/body/adopted?view=plain)).
- **The contract:** the Image-Line EULA **Art. 11.1** says users may not "reverse engineer, decompile, disassemble or create derivative works from the Products" ([EULA](https://www.image-line.com/image-line-software-eula/)). US courts have enforced anti-reverse-engineering clauses in contracts **(unverified case law; ask counsel)**.
- **Clean-room rules (if we ever build the importer):**
  1. **Never** decompile, disassemble, debug or inspect FL Studio binaries or memory. Never use cracked copies.
  2. **Do not vendor PyFLP or LMMS code.** Both are GPL ([PyFLP fork](https://github.com/Meowrium/PyFLP); LMMS listed an FLP importer ([README](https://github.com/fxiangyi/lmms/blob/master/README.md))). GPL code cannot go into our MIT core.
  3. **Option A: clean-room spec.** Team A may study public material and black-box `.flp` files made with a legally licensed FL. It writes a **prose spec of facts** (record IDs, field layouts), with no code. Team B, who has never seen the GPL sources, implements from that spec under MIT. Keep logs.
  4. **Option B: separate converter.** Ship an optional **separate GPL-3 converter process** (built on the PyFLP fork) that turns `.flp` into KS JSON through files or the command line. This is usually "mere aggregation" under the [GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation) (not fetched this session). Distribute it separately and label it unofficial.
  5. **Default interop path (no risk):** FL users export **MIDI** and **split-mixer-track stems** (both are built into FL's export dialog). KS imports both well, ideally with an agent that rebuilds patterns from the MIDI.
  6. Tier: **P3**. Revisit after 1.0 if there is demand.

### 9.5 Licences we must not break (pointers for the engine and plugin researchers)
- GPL code cannot sit inside the MIT core: Vital, Surge XT, Rubber Band, LMMS, PyFLP.
- Candidates that are MIT:
  - **Signalsmith Stretch** for time-stretch ([repo](https://github.com/Signalsmith-Audio/signalsmith-stretch))
  - **Demucs** code for stem separation ([repo](https://github.com/facebookresearch/demucs)). The repo is **archived**, and the **licence of the pretrained weights is not stated**. Verify it, or train our own.

---

## 10. Sources

**Image-Line, official**
- What's New 2026: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new.htm
- What's New 2025: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new_25.htm
- What's New 2024: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new_24.htm
- What's New 21: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_new_21.htm
- FL Studio 21.2 news: https://www.image-line.com/fl-studio-news/fl-studio-21-2-whats-new/
- 2026.1.7 release thread: https://forum.image-line.com/viewtopic.php?p=2076291
- Compare editions: https://www.image-line.com/fl-studio/compare-editions
- Pricing: https://www.image-line.com/fl-studio/pricing
- Buy now: https://www.image-line.com/fl-studio/buy-now
- FL Cloud: https://www.image-line.com/fl-cloud
- Lifetime free updates: https://www.image-line.com/fl-studio/lifetime-free-updates
- Manual TOC: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/Index_Frame_Left.html
- Effects index: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/effects_plugins.htm
- Channel Rack: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/channelrack.htm
- Piano roll: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm
- Piano roll menu: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll_menu.htm
- Playlist: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm
- Mixer: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/mixer.htm
- Recording: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/recording.htm
- MIDI scripting: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/midi_scripting.htm
- Export: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/fformats_save_export.htm
- Save formats: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/fformats_save.htm
- Project formats: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/fformats_project.htm
- Other formats: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/fformats_other.htm
- Shortcuts: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_shortcuts.htm
- Edit menu: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/menu_edit.htm
- Edison: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/Edison.htm
- Patcher: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/Patcher.htm
- EULA: https://www.image-line.com/image-line-software-eula/
- Support KB (content and branding): https://support.image-line.com/action/knowledgebase/?ans=41

**Press and reviews**
- MusicTech FL 2025 review: https://musictech.com/reviews/digital-audio-workstations/fl-studio-2025-review
- MusicTech FL 21.2 review: https://musictech.net/reviews/digital-audio-workstations/fl-studio-21-2-review/
- MusicTech 21.2 news: https://musictech.com/news/gear/fl-studio-21-2-update-stem-separation-cloud-royalty-free-library
- DJ Mag 21.2: https://djmag.com/tech/fl-studio-212-stem-separation-and-ai-mastering-now-available
- MusicRadar (Kepler): https://www.musicradar.com/news/fl-studio-update-21
- gearnews (Kepler Exo): https://gearnews.com/fl-studio-daw-software
- RouteNote (Gopher 2026): https://routenote.com/blog/fl-studio-2026-gopher-ai-production-assistant/
- ainauten (Gopher 2026): https://news.ainauten.com/en/story/fl-studio-2026-turns-its-ai-chatbot-into-your-assistant-engineer
- AlternativeTo (Gopher 2025): https://alternativeto.net/news/2025/7/fl-studio-2025-introduces-gopher-an-ai-powered-assistant-for-answering-all-your-questions/
- Motion Media (FL 2026): https://www.motionmedia.com/mm-blog/fl-studio-2026-update
- Production Expert 2025 DAW survey: https://www.production-expert.com/production-expert-1/2025-daw-survey-the-results
- Wikipedia, FL Studio: https://en.wikipedia.org/wiki/FL_Studio
- audeobox (pricing and piano roll guides; third party): https://www.audeobox.com/learn/fl-studio/fl-studio-pricing-which-edition/ and https://www.audeobox.com/learn/fl-studio/how-to-use-the-piano-roll-in-fl-studio/
- G2 review: https://www.g2.com/survey_responses/fl-studio-review-4850838
- rfp.wiki (aggregator, low weight): https://www.rfp.wiki/vendors/fl-studio/reason

**Image-Line forum (user requests and complaints)**
- Industry-standard features: https://forum.image-line.com/viewtopic.php?p=2029224
- Recording and mixing: https://forum.image-line.com/viewtopic.php?p=2053513
- Quick punch: https://forum.image-line.com/viewtopic.php?p=2058791
- ARA: https://forum.image-line.com/viewtopic.php?p=1979721
- Engine rewrite: https://forum.image-line.com/viewtopic.php?p=1986092
- FL Cloud price (2024): https://forum.image-line.com/viewtopic.php?p=1953892
- Misc complaints: https://forum.image-line.com/viewtopic.php?p=2046923 and https://forum.image-line.com/viewtopic.php?p=2026509

**MCP and interop**
- https://github.com/rosasynthesiz/flstudio-mcp
- https://glama.ai/mcp/servers/alansork/fl-studio-mcp
- https://glama.ai/mcp/servers/kaupau/flai-mcp
- https://claudemarketplaces.com/mcp/purahmanian/flstudio-mcp-mac
- https://github.com/Meowrium/PyFLP
- https://pyflp.readthedocs.io/
- https://github.com/fxiangyi/lmms/blob/master/README.md
- https://github.com/Signalsmith-Audio/signalsmith-stretch
- https://github.com/facebookresearch/demucs

**Law**
- Justia (Image Line NV marks): https://trademarks.justia.com/owners/image-line-nv-4234145
- SAS v WPL (C-406/10): https://www.fieldfisher.com/en/insights/sas-institute-inc-v-world-programming-limited and https://www.ippt.eu/sites/ippt/files/2012/IPPT20120502_ECJ_SAS_Institute_v_WPL.pdf
- BSA (C-393/09): https://www.fieldfisher.com/en/insights/graphical-user-interfaces-can-be-protected-by-copyright-rules-european-court
- Software Directive: https://www.legislation.gov.uk/eudr/2009/24/article/6 and https://www.legislation.gov.uk/eudr/2009/24/body/adopted?view=plain
- Lotus v Borland: https://en.wikipedia.org/wiki/Lotus_Development_Corp._v._Borland_International,_Inc.
- TrafFix: https://en.wikipedia.org/wiki/TrafFix_Devices,_Inc._v._Marketing_Displays,_Inc.
- GPL FAQ: https://www.gnu.org/licenses/gpl-faq.html#MereAggregation (not fetched)
- Directive 2006/114/EC: https://eur-lex.europa.eu/eli/dir/2006/114/oj (not fetched)
