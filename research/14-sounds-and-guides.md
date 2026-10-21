# 14: Wave 7b, more sounds and transitions + the full Guides panel

**Goal:** many more transitions and sound effects (risers, downlifters, whooshes, tape stops, swells, impacts, zaps, vocal shots, foley, ambience, retro game sounds), so songs, beats and agent builds have movement between sections. Then a Guides panel that teaches music and the app, docked beside your work.

**Decisions** (user, 2026-10-14):
- **Sources: "Synth + CC0 packs".**
  - Engine-made transitions and FX ship in the installer, inside the factory library.
  - Recorded **CC0 / public-domain** sound effects become optional **sample packs**. They are downloaded from their original sites, pinned by URL + SHA-256 + size, with nothing new in the installer.
  - No Freesound, since it needs a login and its API terms rule out this use (research/11 D3). No new hosting repo.
- **Guides: "Dockable panel + big library".**
  - Guides open as a dockable panel beside the work, as well as on Home.
  - About 20 new articles on music basics, arrangement and transitions, mixing and mastering, genres, the AI, a glossary and an FAQ.
  - "Show me" buttons highlight the real UI.

**Rules** (CLAUDE.md, `research/11` §1, `research/05`):
- **Licences:**
  - Only **CC0 1.0** or a clear **public-domain** dedication, read on the primary source and archived (`PackLicence.statement`) when informal.
  - CC BY only with a per-sound `credit`. No NC, no "royalty-free" packs, nothing GPL, no "free for use in your music" licences (those forbid redistribution).
  - The ban list in `research/11` §3 stands: Splice, LANDR, Looperman, 99Sounds, MusicRadar, Cymatics, Pixabay, Mixkit, Zapsplat, the BBC Sound Effects archive (RemArc licence, non-commercial) and Sonniss GDC bundles (no redistribution as a library).
- **Names:** sample names are our own words. No product, artist or brand names.
- **No silent failures:** every action ends in a toast or `{ok, message}`. Agents get every new capability (existing tools grow, no new tool is needed).

---

## 1. Contracts (written by the lead; don't change their shape)

- **`shared/sounds/types.ts` `SAMPLE_KINDS`** gains `whoosh`, `tape-stop`, `swell`, `zap`, `vox`, `foley`, `ambience` and `retro`.
  - The Rust mirror `SAMPLE_KINDS` in `engine/crates/dsp/src/factory/mod.rs` must match (a test checks this; rust-fx updates it).
  - The labels are in `src/sounds/logic.ts` `SAMPLE_KIND_LABELS` (done).
- **`shared/packs/types.ts`:**
  - `PackFile.archive?: PackArchive` is a ZIP whose listed `members` are extracted, each verified by SHA-256 + size. Nothing else is written, and the archive is deleted afterwards.
  - `PackSample` is a FactorySample-shaped entry with `path: 'pack:<id>/<path>'` and an optional per-sound `credit`.
  - `PackDef.samples?: PackSample[]`.
- **`src/guides/library/{basics,mixing,genres,workflow,ai,reference}.ts`:** one `GuideArticle[]` per file, appended to `ARTICLES` after the original articles (`src/guides/library/index.ts`).
  - `GuideGroup` gains `Music basics`, `Mixing` and `Genres`.
  - `GuideIcon` gains `music`, `drum`, `chords`, `sliders`, `sparkles`, `book`, `flame`, `headphones`, `layers` and `zap` (mapped in GuidesView).
- **`src/guides/anchors.ts` `GUIDE_ANCHORS`:** the "Show me" targets. Each is an element with `data-guide="<anchor>"`, plus the panel to open first.

## 2. Sounds

### 2.1 Engine-made transitions and FX (rust-fx, in the installer)

These go into the factory library (`engine/crates/dsp/src/factory/fx.rs`, `textures.rs` and new files), following the existing rules in `factory/mod.rs`: deterministic generation, mastering, `index.json` entries with kind, tags, genres, `bpm`/`bars` for tempo-synced files, and risers and swells **ending** on their last sample.

**Targets:** about 80–110 new files. Variety matters more than count.

| Kind | Examples |
|---|---|
| riser | noise, synth-pitch, filtered-saw, snare-build-plus-noise, "tension" with a rising sub, at 1, 2, 4 and 8 bars |
| downlifter | noise-down, pitch-fall, filtered fall, 1/2/4 bars |
| swell | reverse-reverb swells (pad, vocal-like, metallic), volume swells, 1/2 bars |
| reverse-cymbal | more lengths and colours |
| whoosh | short, long, dark, bright and stereo pass-by |
| tape-stop | tape stop and vinyl stop as one-shots (½ and 1 bar) |
| impact | boom, cinematic hit, layered clap-impact, "thud", reverse-into-hit |
| sub-drop | more pitches and lengths |
| zap | laser down and up, blip, glitch burst, bitcrush stab, radio tune |
| vox | formant-synth "ah/oh/hey"-style shots, breath noise, vocoder blips (synth, no recorded voice) |
| texture / noise | vinyl crackle loops, tape hiss, rain-like noise, wind, room tone, radio static |
| fill | more snare rolls and tom fills at 1/2 bars, in several genres' feels |

- **Budget:** `MAX_TOTAL_BYTES` goes from 45 MB to **80 MB**. Prefer mono where it's mono, and keep 16-bit for long files.
- **Determinism:** two runs must still write identical bytes.
- **Old paths:** existing files keep their paths, because projects reference them.

### 2.2 Recorded CC0 sample packs (gather-sfx: research + specs + data)

**Find, verify and pin** recorded CC0 / public-domain sound effects with **stable direct URLs**:
- commit-pinned GitHub raw plus a jsDelivr mirror, as in the existing packs;
- or a stable direct file or ZIP URL on the source's own site (OpenGameArt `sites/default/files/…`, Kenney asset ZIPs, `upload.wikimedia.org`, `archive.org/download/…`).

**Candidates to check first:**
- Kenney audio packs (CC0): impacts, interface, sci-fi and digital audio;
- OpenGameArt items that are CC0 *only* (e.g. Juhani Junkala's 8-bit sound effects pack, CC0 foley and ambience);
- Wikimedia Commons audio marked CC0 or public domain;
- archive.org items with an explicit CC0 / public-domain mark;
- VCSL percussion and FX folders (CC0, already a source);
- any CC0 drum-machine or foley sets on GitHub.

**Record for each source:** the licence quote, the URL and the date read, in `research/14` §5.

**Pack ideas** (2–4 packs, each about 10–150 MB):
- **Foley & Textures:** vinyl, tape, room, rain, city, paper, glass, cassette;
- **Impacts & Whooshes:** recorded hits, swishes, slams;
- **Retro Game:** 8-bit blips, jumps, coins, power-ups;
- **Percussion Extras:** found percussion, shakers, claps.

Only what the sources really offer.

**Build and wiring:**
- Specs live in `scripts/packs/specs/<id>.ts` and are built by `scripts/packs/build.ts` into `shared/packs/data/<id>.gen.ts`. The build script gains ZIP members and samples.
- The packs are added to `PACKS` in `shared/packs/catalog.ts`.
- Each `PackSample` gets kind, tags, genres, length, channels and a measured peak.
- Trimming and normalising are **not** possible on files we don't host, so ship them as they are. The engine and sampler handle gain, and an `index` `peakDb` lets the picker set the level.

### 2.3 App support (sounds-app)

- **Install** (`electron/packs/**`):
  - ZIP extraction with a permissive library such as `fflate` (MIT). Add it to THIRD-PARTY-NOTICES via `npm run notices`.
  - Verify each member, write atomically, delete the archive, and report any error as a sentence.
- **Library:** installed packs' `samples` join the factory index everywhere:
  - `electron/sounds/**` (`find_samples`, the `chooseInstrument` / picker, `load_sample` with `pack:` paths);
  - `get_playbook`'s sample choice (prefer factory ties unless the pack is installed and fits better);
  - the Browser gets a **Sound packs** section;
  - Home ▸ Sounds pack cards show "adds N sounds: risers, foley …".
- **Agents:**
  - `add_transition` gains kinds `whoosh`, `tape-stop` and `swell` (align end), and uses pack samples when installed.
  - `list_packs` lists sample counts by kind.
  - Prompt text and `docs/MCP.md` mention the new transition kinds.
- **Tests:** ZIP extraction (good, bad hash, extra members ignored, path traversal refused), pack samples merged into search, and add_transition picking the new kinds.

## 3. Guides

### 3.1 Panel and markup (guides-ui)

- **Dockable panel:** a new singleton panel `guides` (`src/workspace/panels.ts` PANELS, right dock, about 440 wide; registered with the WindowManager like `history`). It is in the View menu.
  - **F1** and Help ▸ Guides open the **panel** when the Studio is showing, and the Home guides screen when Home is up.
  - The same article view renders in both (refactor `GuidesView` into a reusable body plus a sidebar). Narrow widths use the existing narrow picker.
- **New markup** (`src/guides/markup.ts`, documented in its header, tested):
  - `[[show:<anchor>|Label]]` (inline, or a button row on its own line): opens `GUIDE_ANCHORS[anchor].panel`, scrolls `[data-guide="<anchor>"]` into view and pulses a highlight ring (gradient accent, about 2.5 s). If the element can't be found, a toast names it ("Open a pattern first: the step grid isn't on screen").
  - `[[guide:<articleId>|Label]]` (inline): a link to another article (optionally `articleId#anchor` for a heading).
  - `{{playbook:<genreId>}}`: a fact card built **live from `shared/playbooks`** (tempo range, swing, key/mode habits, drum pattern summary, structure and section lengths, mix targets), so genre guides never drift from what the AI actually does.
  - `{{kinds}}`: the sample kinds table with counts from the installed library (factory + packs).
- **Anchors:** put `data-guide` on the real elements for every id in `GUIDE_ANCHORS`. Attribute-only edits in other owners' files are allowed.
- **Search:** title, summary, headings **and body text**, with a match snippet.
- **Sidebar:** groups in `GUIDE_GROUPS` order, collapsible. "Related" links at the end of each article, from the `[[guide:…]]` links it contains.
- **Tests:** `test/guides.test.ts` covers the parser (show / guide / playbook / kinds), that every `show` anchor exists in `GUIDE_ANCHORS`, that every `GUIDE_ANCHORS` id appears as `data-guide="…"` somewhere under `src/`, that every `guide:` link resolves, that every `playbook:` id is a playbook, and that every article has a known group and icon.

### 3.2 Content (guides-content-1, guides-content-2)

**House style** (match the existing articles in `src/guides/articles.ts`):
- Plain language with short paragraphs. Numbered steps for doing things, tables for comparisons, `>` tips and `!>` heads-ups.
- Second person ("you"). No hype. Every label, key, menu path and limit **checked against the code**. Never promise something the app doesn't do; if it's missing, say so plainly.
- Each article is 400–1200 words, with an `id`, title, one-line summary, group and icon.
- Use `[[show:…]]` where a reader would wonder "where is that?", and `[[action:…]]` for Home actions that exist (`src/home/actions.ts`).
- Music facts are general knowledge, written fresh: no copying from websites or books, and **no song or artist examples** that tie to copyrighted melodies. Genre history may name a genre's origins in one sentence at most.

**guides-content-1** (`basics.ts`, `mixing.ts`, `genres.ts`):

*Music basics:*
- Rhythm and tempo: BPM, bars, beats, steps, swing, half-time, triplets;
- Keys and scales: major and minor, the modes producers use, how to pick a key, the piano roll scale highlight;
- Chords and progressions: triads, sevenths, common progressions by roman numerals, voicing, inversions;
- Melodies and hooks: motif, repetition, call and response, rhythm first, range;
- Bass and 808s: root notes, glides, key and tuning, sub vs mid;
- Drum programming: kick and snare placement per feel, hats, ghost notes, velocity, groove;
- Sound design basics: oscillators, filters, envelopes, LFOs, using the stock synths.

*Mixing:*
- Levels and gain staging;
- EQ (cut before boost, the frequency map);
- Compression and sidechain;
- Space: reverb, delay, sends;
- Mastering and loudness (LUFS, true peak, what review_song checks).

*Genres:* one article per family, each with `{{playbook:…}}` cards:
- Trap and drill;
- Hip-hop, boom bap and lo-fi;
- House, techno and EDM;
- Pop, R&B and afrobeats;
- any remaining playbooks in a "More genres" article.

**guides-content-2** (`workflow.ts`, `ai.ts`, `reference.ts`, plus accuracy fixes to the existing articles in `articles.ts`):

*Making songs in Krypt Studio:*
- Song structure and arrangement: sections, energy, 4- and 8-bar phrases, the playlist, markers;
- **Transitions:** every new kind from §2, how to place them (end-aligned vs start-aligned), automation sweeps, drops and silence;
- Sound packs and your own samples: downloading packs, the Browser, folders, credits;
- Sampling and chopping with the tools that exist today;
- A workflow tips and speed article: shortcuts, templates, typing keyboard.

*AI:*
- Getting great results from the AI: prompts that work, iterating, references, undo and revert per agent edit, style focus, originality checks;
- What the AI can and can't do. Every claim must match the real MCP tools (`docs/MCP.md`, `electron/mcp/tools/*`).

*Reference:*
- Glossary: about 80 terms, alphabetical, one line each, linking to articles;
- FAQ: free? MIT? offline? files location, sharing projects, using my beats commercially (the user owns their music; packs are CC0), why SmartScreen warns, getting help.

**Also:** fix anything in the existing articles that the new work makes stale (getting-started, sounds-presets, exporting), and update `docs/MCP.md` links if a guide is referenced there.

---

## 4. Ownership

| Agent | Owns (only these files) |
|---|---|
| **rust-fx** | `engine/crates/dsp/src/factory/**`; regenerating `resources/factory/**` (via `cargo run -p krypt-studio-engine -- --gen-factory resources/factory` or `npm run engine:build`) |
| **gather-sfx** | `scripts/packs/**`, `shared/packs/data/*.gen.ts` (new ones), the new entries in `shared/packs/catalog.ts`, `research/14` §5 |
| **sounds-app** | `electron/packs/**`, `electron/sounds/**`, `electron/mcp/tools/{craft,craftRecipe,discovery}.ts`, `electron/mcp/prompts.ts`, `docs/MCP.md`, the Browser (`src/panels/browser/**`), Home ▸ Sounds (`src/home/screens/**` sound pack parts), `src/sounds/**`, `package.json` deps, tests for these |
| **guides-ui** | `src/guides/{GuidesView,markup,anchors,shortcuts}.tsx?` plus new UI files under `src/guides/`, `src/workspace/{panels,WindowManager,Workspace}.ts*`, the help commands in `src/app/actions.ts`, the View and Help menus in `src/app/TitleBar.tsx`, `src/home/store.ts` openGuides routing, `data-guide` attributes anywhere, `test/guides.test.ts`, `test/home.test.ts` |
| **guides-content-1** | `src/guides/library/{basics,mixing,genres}.ts` |
| **guides-content-2** | `src/guides/library/{workflow,ai,reference}.ts`, article bodies in `src/guides/articles.ts` (not its types and exports) |

**Shared files** (`shared/types.ts`, `shared/packs/types.ts`, `shared/sounds/types.ts`): ask the lead.

**Shared tree:** the repo has no commits, so there are no worktrees. Run `npm run typecheck && npm test` before reporting. Another agent's half-finished file may break the run: name it, don't fix it.

## 5. Sources (gather-sfx fills this in)

All licences were read on the primary source on **2026-10-14** (asset page, plus the licence file inside the download where there is one). Every file is pinned by URL + SHA-256 + size in `shared/packs/data/<id>.gen.ts`, and `--check --mirrors` re-downloaded all of them byte-identically the same day. Each pack's `licence.statement` archives the quotes below.

**What shipped** (four sample packs, 879 samples, 258.6 MB in total, nothing in the installer):

| Pack | Samples | Download | Kinds | Hosting |
|---|---|---|---|---|
| `perc-extras` Percussion Extras | 138 | 44.3 MB, 138 files | perc 95, shaker 26, clap 12, fill 5 | GitHub, commit-pinned, plus jsDelivr |
| `hits-whooshes` Hits & Whooshes | 94 | 99.5 MB, 47 files (3 ZIPs) | impact 29, crash 15, whoosh 14, zap 13, texture 9, perc 8, fill 3, noise 2, ride 1 | GitHub + Kenney ZIPs + OpenGameArt |
| `foley-field` Foley & Field Recordings | 224 | 90.1 MB, 30 files (11 ZIPs) | foley 206, ambience 10, texture 3, snap 3, shaker 2 | Kenney ZIPs + OpenGameArt |
| `retro-game` Retro Game FX | 423 | 24.7 MB, 4 ZIPs | retro 257, impact 85, zap 46, vox 31, downlifter 2, noise 1, whoosh 1 | OpenGameArt ZIP + Kenney ZIPs |

**Sources used**

| Source | Primary-source licence (verbatim) | What we took, and why |
|---|---|---|
| **VCSL**, Versilian Studios: [github.com/sgossner/VCSL](https://github.com/sgossner/VCSL) at commit `c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e`. This is the newest commit, and the same one Keys & Mallets uses. | `LICENSE` at that commit begins "CC0 1.0 Universal". README: "This collection is under a Creative Commons 0 license." | Hand percussion (claps, shakers, cabasa, tambourines, cajon, bongos, congas, darbuka, frame drums, claves, woodblock, log drums, cowbells, agogo, brake drum, guiro, vibraslap, ratchet, slapstick), whistles and concert snare rolls → `perc-extras`. Clash and suspended cymbals, cymbal crescendos and rolls, gongs, concert bass drum, anvil, mark trees, bell tree, wine glass and siren whistle → `hits-whooshes`. These are clean studio recordings. Takes peaking below about −36 dBFS (the softest velocity layers, the ocean drum and finger cymbals) were left out. |
| **Kenney** asset packs: [Impact Sounds](https://kenney.nl/assets/impact-sounds), [Casino Audio](https://kenney.nl/assets/casino-audio), [RPG Audio](https://kenney.nl/assets/rpg-audio), [UI Audio](https://kenney.nl/assets/ui-audio), [Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds), [Digital Audio](https://kenney.nl/assets/digital-audio), [Voiceover Pack](https://kenney.nl/assets/voiceover-pack), [Voiceover Pack: Fighter](https://kenney.nl/assets/voiceover-pack-fighter) | Each page: "License: Creative Commons CC0". `License.txt` in each ZIP: "License: (Creative Commons Zero, CC0) http://creativecommons.org/publicdomain/zero/1.0/ … This content is free to use in personal, educational and commercial projects." The voiceover packs say "License (Creative Commons Zero, CC0)". | Downloaded as the site's direct ZIP (`kenney.nl/media/pages/assets/<slug>/<hash>-<time>/kenney_<slug>.zip`), with only the listed members extracted. Took the cards, chips and dice; books, cloth, doors, leather and metal; full-bandwidth impacts (glass heavy, plates, tin, pick, plank, footsteps); recorded switch clicks; punches and low thuds; sci-fi blasts, sub booms, lasers and airlock swishes; synth zaps; and arcade-announcer and voice shots ("fight", "ready", "go", "round one", counts). The voiceover `Credits.txt` names the hired voice actors, and Kenney released the pack as CC0. |
| **Juhani Junkala** (SubspaceAudio), "The Essential Retro Video Game Sound Effects Collection [512 sounds]": [opengameart.org/content/512-sound-effects-8-bit-style](https://opengameart.org/content/512-sound-effects-8-bit-style) | Page: "License(s): CC0". `INFO.txt` in the ZIP: "These sound effects have been released under CC0 creative commons license. You can do anything you want with these sounds." | 346 of the 512 sounds (44.1 kHz 16-bit mono WAV): coins, power-ups, jumps and landings, falls, portals, blips, menus, hits, errors, chip alarms, lasers and explosions. Left out: death screams, guns, footsteps, ladders, vehicles and doors (not musical), plus two byte-identical takes. |
| **OpenGameArt**, CC0-only entries, each the uploader's own recording: [Keyboard Soundpack #1](https://opengameart.org/content/keyboard-soundpack-1-typing-and-single-keystrokes) (unicaegames), [87 Clickety Clips](https://opengameart.org/content/87-clickety-clips) (OwlishMedia), [Various Paper Sound Effects](https://opengameart.org/content/various-paper-sound-effects) (Luckius), [10 Book Page Flips](https://opengameart.org/content/10-book-page-flips) (StarNinjas), [Ticking clock.](https://opengameart.org/content/ticking-clock) (bart), [Rain (loopable)](https://opengameart.org/content/rain-loopable) (Ylmir), [The Shop](https://opengameart.org/content/the-shop) (LEGIT Audio), [Tape Recorder Opening and Closing](https://opengameart.org/content/tape-recorder-opening-and-closing-sound-effects) (Spring Spring), [Metal Impact Sounds](https://opengameart.org/content/metal-impact-sounds) (BMacZero), [Glass Break](https://opengameart.org/content/glass-break) (Till Behrend), [Snap of the fingers](https://opengameart.org/content/snap-of-the-fingers-sounds) (Vinrax), [Scorcher's Foley Sounds](https://opengameart.org/content/scorchers-foley-sounds) (scorcher24), [Fabric Rustling](https://opengameart.org/content/fabric-rustling) (Iochi Glaucus), [Fireplace Sound loop](https://opengameart.org/content/fireplace-sound-loop) (PagDev), [AMB Rain Loop 2](https://opengameart.org/content/amb-rain-loop-2), [AMB Morning Sounds](https://opengameart.org/content/amb-morning-sounds-perfect-loop) and [AMB Outside 1](https://opengameart.org/content/amb-outside-1) (Kresiek The Furry), [Rain + Long Thunder](https://opengameart.org/content/rain-long-thunder) (WuxiaScrub), [High traffic road sounds](https://opengameart.org/content/high-traffic-road-sounds) (IgnasD), [Applause in a large hall or church](https://opengameart.org/content/applause-in-a-large-hall-or-church) (eXpl0it3r), [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack) (artisticdude), [Muffled Distant Explosion](https://opengameart.org/content/muffled-distant-explosion) (NenadSimic) | Each page lists exactly one licence: "License(s): CC0". Informal notes on the pages agree: the keyboard pack's readme says "Free to use however you like.", and Luckius writes "It would be great if you credit me but this is not mandatory." | Direct `opengameart.org/sites/default/files/…` URLs (single files or ZIPs with listed members). Took keys and typing, clicks, paper, book flips, clock ticks, tape deck open and close, metal and glass hits, finger snaps, cloth, swishes and a distant boom. For ambience: a 12-minute rain field recording (GoPro, 48 kHz), rain loops, rain with thunder, a busy road, morning birds, evening outdoors, applause in a hall, a fireplace and two fridge-hum room tones (96 kHz 24-bit). |

**Measured, not just listened to** (`scripts/packs/samples.ts` uses ffmpeg as a dev tool; scratch analysis covered peak, clip runs, 50 ms RMS floor, −60 dB bandwidth edge and envelope fingerprints):
- **Rejected for quality:**
  - Takes whose decoded peak clips (runs of samples at full scale): Kenney RPG pots, book places and door closes, UI switches 16/18/23/31/32, two book flips, a dice shake.
  - Kenney Impact sets low-passed below about 7 kHz: wood, soft "generic", light and medium glass, wooden footsteps. Only the "Low Thud" set, which is meant to be low, was kept.
  - An 8 kHz radio-noise recording. A wind bed with a 1.3 kHz bandwidth and bag noise.
  - Byte-identical or near-identical takes (two carpet steps, two long chip explosions, coin clusters 5 and 6). The build fails on any two samples with the same SHA-256.
  - The very quiet VCSL takes.
- **Kinds, honestly:**
  - The VCSL cymbal and bass-drum crescendos peak about a third of the way in and then ring out. They are not end-aligned, so they are filed as `crash` and `fill` rather than `swell`.
  - Recorded whooshes are scarce under CC0: 12 short swishes, 2 airlock swishes and one chip launch.
  - Nothing is tempo-synced (`bpm`/`bars` absent), because no source loop is exactly a whole number of bars.
- **Slight overs:** 8 Kenney Ogg files decode up to +1.6 dBFS (Vorbis overshoot, no clip runs). `peakDb` records this, so the level can be set.

**Rejected sources**

| Source | Why |
|---|---|
| Freesound | D3: needs a login, and the API terms rule out this use. We also left out the OpenGameArt items that are re-uploads from Freesound (e.g. "Beach Ocean Waves"). |
| archive.org "CC0" sound-effect items (Red Library, SSE Library, Gold Tape, iMovie and DVD sound effects …) | The CC0 mark is set by the uploader, who plainly isn't the rights holder of these commercial libraries. Provenance fails. |
| Wikimedia Commons | Almost every field recording in the categories we checked is CC BY-SA (out). The CC0/PD audio is spoken-word pronunciations or archival music (phonograph cylinders), not sound effects. |
| OpenGameArt items with several licences or none-CC0 (e.g. "Wierd Whooshes": CC-BY, GPL, CC0 … together; "Rain on Window Loop": CC-BY + CC0; HaelDB "Random Sounds Samples": OGA-BY + CC0) | Rule: CC0 only. |
| OpenGameArt `.7z` uploads (bamboo swishes, rustling leaves 24/96, workshop, krank sounds, hits and punches) | The installer extracts ZIP only. |
| OwlishMedia "Sound Effects Pack" (OpenGameArt, CC0, 142 MB ZIP) | Legal, but the whole 142 MB archive would be downloaded for the ~40 files worth keeping. Deferred. |
| bretbernhoft "General Household" / "Rumbling" / "Static" sets (OpenGameArt, CC0) | 40–90 MB per file (4-minute 96 kHz WAVs) we can't trim. |
| rubberduck "100 CC0 SFX" packs, Ogrebane wood and metal (AIFF) | Phone recordings with a high noise floor, or digital-silence padding. The good ones overlap Kenney. |
| Kenney Interface Sounds, Music Jingles | Designed UI tones and melodic jingles; not useful in beats. |
| Banned list (research/11 §3): Splice, LANDR, Looperman, 99Sounds, MusicRadar, Cymatics, Pixabay, Mixkit, Zapsplat, BBC Sound Effects, Sonniss | Not considered. |

**For the installer (sounds-app):**
- **Archives:** `PackFile.archive` is always `format: 'zip'`, method store or deflate (fflate). Member names are matched exactly as fflate decodes them. Every listed `from` is plain ASCII; names include spaces, brackets and commas (e.g. `The Essential Retro … [512 sounds] By Juhani Junkala/General Sounds/Coins/sfx_coin_single1.wav`). Some ZIPs also carry `__MACOSX/` and `.DS_Store` entries, which must be ignored.
- **One archive in two packs:** `kenney_impact-sounds.zip` is used by both `foley-field` and `hits-whooshes`, and each pack downloads its own copy to `downloads/impact-sounds.zip`.
- **Formats:** 48 kHz and 96 kHz files, 24-bit and 32-bit-int / float WAV, and Ogg Vorbis all occur.

## 6. Integration checklist (lead)

- [ ] `npm run engine:build`: factory regenerates within budget; deterministic; the index validates
- [ ] Pack catalog test plus a real download of every new pack in an isolated profile
- [ ] add_transition e2e: a playbook build uses the new kinds; review_song still ≥ previous score
- [ ] Guides: every show anchor highlights in the real app (CDP screenshot pass); F1 panel and Home both work
- [ ] THIRD-PARTY-NOTICES regenerated (`npm run notices`), license check passes
- [ ] `npm run typecheck && npm test` and the full `cargo test`
