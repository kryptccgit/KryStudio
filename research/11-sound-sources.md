# 11: Sound sources: what we can legally gather

Status: **research + one shipped piece** (groove templates, §5). Written 2026-10-12 for Wave 4 (`research/10`).

The user asked us to "gather all you can" to make AI-made music better. This report is the legal version of that
request. It lists what audio and data we could bundle in an MIT app, what only looks free, which datasets help,
and what users can bring themselves. The stance is the same as `08 §1`: we use reference memory, not training.
We ship nothing derived from songs we don't own, and we never train a model on anyone's music.

**Method.**
- Every licence below was read on a **primary source**: the project's licence page or LICENSE file, the dataset's
  official page, or the site's terms.
- Quotes are verbatim; nothing was taken from blog summaries.
- Entries marked *partial* or *unverified* say why.
- Checked 2026-10-12. Terms change, so re-check each source before acting on it.
- This is not legal advice.

---

## 0. TL;DR

1. **Shipped now:** 11 **groove templates** from Magenta's **Groove MIDI Dataset**, by Google LLC under CC BY 4.0.
   - They hold the timing and accents of real drummers per 16th step, per instrument and per style.
   - They are exposed as piano roll *Tools ▸ Groove*, the `notes.groove` command and the `transform_notes` op
     `groove`.
   - Only aggregated statistics ship. The attribution is in `THIRD-PARTY-NOTICES.md` → *Datasets*.
2. **Bundleable audio exists, and it is real recorded material:**
   - **CC0:** VSCO-2 CE, VCSL and the Karoryfer free libraries, which include several acoustic drum kits.
   - **Public domain since 2022:** Salamander Grand Piano and Salamander Drumkit.
   - **No-restrictions statement:** the University of Iowa MIS.
   - **Hand-picked Freesound sounds:** CC0, or CC BY with credits.

   All of this is optional content, and it conflicts with today's rule that factory material is Krypt-original
   and synthesised. **Decisions D1 and D2** cover it.
3. **Not bundleable**, even when it says "free" or "royalty-free":
   - Splice, LANDR, Looperman, 99Sounds, MusicRadar and the Philharmonia samples all forbid redistribution as
     samples.
   - Every NC or research-only dataset is out: MAESTRO, MedleyDB, MUSDB18 and the drum-transcription sets.
   - Datasets built from copyrighted songs are out whatever their own licence says: Lakh MIDI, Slakh2100, POP909,
     Chordonomicon and the Weimar Jazz Database.
4. **NSynth** is CC BY 4.0, but it is 16 kHz audio sampled from commercial libraries. It is not usable as
   instruments.
5. **The biggest legal "gather" is the user's own material.**
   - Browser folders feed `find_samples`, and the reference library feeds style profiles.
   - Both already work. They need better guidance, not more data.

---

## 1. Rules applied

| Question | Rule |
|---|---|
| What does "bundle" mean? | Shipping the file inside the installer or the repo, in a form a user can load as a sample or instrument. That is *redistribution as samples*, the right most "free" packs withhold. |
| NC licences? | Out. An MIT app may be forked and sold, so non-commercial content can't travel with it. |
| GPL? | Out (CLAUDE.md hard rule). This also excludes GPL sample sets such as the FreePats GM bank and the Nottingham MIDI set. |
| "Royalty-free" packs? | They license *you* to use the sounds in *your music*. That is not a licence to redistribute them in another product. |
| Datasets of songs? | A dataset licence covers the compilation. It cannot clear the underlying compositions or recordings. |
| Attribution? | CC BY needs credit, the licence link and a note of changes (CC BY 4.0 §3(a)). We credit public-domain sources anyway, as a courtesy. |
| Names | Source names may appear in credits. Preset and sample *names* still follow `10`'s naming rule: no product names. |

---

## 2. (a) Audio we could bundle

| Source | Licence (primary source) | Attribution | As samples | Quality / caveats |
|---|---|---|---|---|
| **VSCO-2 Community Edition** (Versilian Studios), [github.com/sgossner/VSCO-2-CE](https://github.com/sgossner/VSCO-2-CE) | **CC0 1.0**: the [LICENSE](https://raw.githubusercontent.com/sgossner/VSCO-2-CE/master/LICENSE) file begins "CC0 1.0 Universal" | None required | Allowed | Orchestral multisamples (strings, brass, winds, percussion) in SFZ. The README states no sample rate or bit depth. |
| **VCSL** (Versilian Community Sample Library), [github.com/sgossner/VCSL](https://github.com/sgossner/VCSL) | **CC0**: "This collection is under a Creative Commons 0 license." LICENSE file in the repo root | None | Allowed | Organised by instrument family. "About 20-75 MB in raw .wav format" per instrument. |
| **Karoryfer Samples** free libraries, [shop.karoryfer.com/pages/free-samples](https://shop.karoryfer.com/pages/free-samples) | **CC0**: "All our free sample libraries are under a Creative Commons Zero license." Exception: "Only Marie Ork has a different license". | None | Allowed | Real acoustic drums: Big Rusty Drums, Unruly Drums, Swirly Drums, Frankensnare, Virtuosity Drums, The Hat With The Phat (cymbals), Gogodze Phu (percussion). The page warns "Older downloads may include a less permissive license", so take current copies from the official GitHub mirrors (`sfzinstruments/karoryfer.*`, CC0 LICENSE files per the research pass). |
| **Salamander Drumkit** (Alexander Holm), [rytmenpinne…/salamander-drumkit](https://rytmenpinne.wordpress.com/sounds-and-such/salamander-drumkit/) | **Public domain**: "As of 4.3.2022, this is now public domain!" Earlier copies were CC BY-SA 3.0 (per a mirror README; *partial*). | Not required; credit anyway | Allowed (use post-2022 copies) | The author warns the sample ends "are not necesearly -inf dB wich makes slight pops and clicks", so tails need a fade. Mapped for LinuxSampler. |
| **Salamander Grand Piano** (Alexander Holm), [rytmenpinne…/salamander-grandpiano](https://rytmenpinne.wordpress.com/sounds-and-such/salamander-grandpiano/) | **Public domain**: the page carries the same statement, "As of 4.3.2022, this is now public domain!". Earlier CC BY 3.0 (per archive.org, *partial*). | Not required; credit anyway | Allowed | Widely used free sampled grand piano. The page states no specs (rate, layers, size), so verify them on download. The public-domain statement is informal, not the CC0 legal tool, so **archive a copy** of the page with the files. |
| **University of Iowa MIS**, [theremin.music.uiowa.edu/MIS.html](https://theremin.music.uiowa.edu/MIS.html) | Permission statement, not a formal licence: "may be downloaded and used for any projects, without restrictions" | Not required; credit as courtesy | Allowed | Pre-2011 recordings are 16/44.1 mono chromatic scales and need slicing. 2011 onward they are 24/96 stereo. Orchestral, so of little use for beats. |
| **FreePats**, [freepats.zenvoid.org](https://freepats.zenvoid.org/) | **Licensed per instrument** (*research pass*). The GM set is "GNU General Public License version 3 or later, with a special exception" → **out**. Upright Piano KW is CC0. MuldjordKit drums are CC BY 4.0. | Per item | CC0 / CC BY items only | Check each instrument page. |
| **Freesound**, [freesound.org](https://freesound.org/help/faq/) | **Licensed per sound:** CC0, CC BY 4.0 or CC BY-NC 4.0, plus legacy Sampling+ and some older 3.0 versions. | CC BY: credit per sound | **CC0 and CC BY only, picked by hand** | See the Freesound terms below the table. Quality varies per upload. |
| **OpenGameArt** CC0 assets, [opengameart.org/content/faq](https://opengameart.org/content/faq); **Kenney**, [kenney.nl/support](https://kenney.nl/support) | Per asset (OGA: CC0 / CC BY / CC BY-SA / GPL…). Kenney: "all game assets on the asset pages are public domain licensed (CC0)" (*research pass*) | None for CC0 | Allowed (CC0) | Game and UI sound effects. Little musical value, but possibly fine for UI sounds. |
| **NSynth** (Magenta), [magenta.tensorflow.org/datasets/nsynth](https://magenta.tensorflow.org/datasets/nsynth) | **CC BY 4.0**: "made available by Google Inc. under a Creative Commons Attribution 4.0 International (CC BY 4.0) license" | Google Inc. | Licence allows it | **Not useful as instruments.** The notes are "four second, monophonic 16kHz audio snippets", so nothing above 8 kHz. 305,979 notes from 1,006 instruments taken from "commercial sample libraries", which is a provenance smell even with Google's grant. Fine for analysis and research; don't ship it as sounds. |

**Freesound terms.** These bind how we may *collect* sounds, separately from each sound's licence:
- **API terms** ([tos_api](https://freesound.org/help/tos_api/)):
  - "Do not make full copies of the database."
  - §4(f) bans scraping and building "similar databases".
  - §4(a) bans distributing Content outside your application.
  - §3: "Terms for commercial use of the API will be negotiated on a case by case basis with UPF."
- **Website terms** (*research pass*): no commercial use of the portal "unless otherwise agreed in writing".
- **What this means for us:**
  - A small, hand-picked CC0 set is fine. Download each sound individually and keep a manifest of id, author,
    licence and URL.
  - A bulk API harvest, or an in-app Freesound browser, needs the lead's decision and probably UPF's agreement
    (**D3**).

**Also seen, not recommended:**
- The Meadowlark factory library is CC0 per its README but tiny so far.
- Hydrogen's "Audiophob" kit is CC0 only per a Debian packaging record (*partial*).

---

## 3. (b) Looks free, but NOT bundleable

| Source | Why not (primary-source quote) |
|---|---|
| **Splice** ([terms](https://splice.com/terms), §II 3.1.1.3, *research pass*) | You may not "(a) sublicense the Sounds in isolation as sound effects, loops, or as source material for any other form of sample" or "(d) redistribute Sounds in new sample packs". (h) also bans AI training. |
| **LANDR** ([terms](https://www.landr.com/terms-of-service), *research pass*) | You may not "(iii) use any Sample for the creation of a sound or sample library or as a sound or sample library or part thereof". |
| **Looperman** ([terms](https://www.looperman.com/help/terms)) | Loops may be used only in "new and original recordings of new and original musical and/or lyrical compositions". The licence is "non-transferable", and you may not "use our content for the training or improvement of any algorithm". |
| **99Sounds** ([licence](https://99sounds.org/license/), *research pass*) | "You do not have the right to sell or redistribute (even for free) the audio files". |
| **MusicRadar SampleRadar** (*partial*: search snippet only, the article body was unreachable) | "all we ask is that you don't re-distribute them". |
| **Cymatics free packs** (*unverified*: the licence page returned 404) | Assume the industry-standard ban on redistribution as samples. |
| **Philharmonia Orchestra samples** ([page](https://philharmonia.co.uk/resources/sound-samples/)) | "The only restriction is that they must not be sold or made available 'as is' (i.e. as samples or as a sampler instrument)." |
| **Sonatina Symphonic Orchestra** ([github.com/peastman/sso](https://github.com/peastman/sso), *research pass*) | CC **Sampling Plus 1.0**, a retired licence that allows whole-work redistribution only non-commercially. Partly built from Philharmonia samples. |
| **FreePats GM bank** | GPL-3.0-or-later (with an exception). Excluded by the GPL rule. |
| **MAESTRO** ([page](https://magenta.tensorflow.org/datasets/maestro)) | "Creative Commons Attribution Non-Commercial Share-Alike 4.0". |
| **MedleyDB** ([zenodo 1649325](https://zenodo.org/records/1649325)) | CC BY-NC-SA 4.0, "offered free of charge for non-commercial research use only". |
| **MUSDB18** ([sigsep](https://sigsep.github.io/datasets/musdb.html)) | "the tracks can only be used for academic purposes". |
| **Drum-transcription sets** | All NC or research-only, which also confirms `08`'s ADTOF note: ENST-Drums ("No commercial use is possible"), MDB Drums (CC BY-NC-SA 4.0), IDMT-SMT-Drums (CC BY-NC-ND 4.0), ADTOF (CC BY-NC-SA 4.0). |
| **FMA** ([github.com/mdeff/fma](https://github.com/mdeff/fma)) | "We do not hold the copyright on the audio and distribute it under the license chosen by the artist". Per-track licences include NC and ND. |
| **FSD50K** ([zenodo 4060432](https://zenodo.org/records/4060432)) | "Each clip has its own license as defined by the clip uploader in Freesound". A CC0/CC BY subset exists, but it is sound events, not musical material. |
| **Lakh MIDI** ([colinraffel.com/projects/lmd](https://colinraffel.com/projects/lmd/)) | CC BY 4.0 covers the compilation, but the files "were scraped from publicly-available sources on the internet". Mostly transcriptions of copyrighted songs. |
| **Slakh2100** ([zenodo 4599666](https://zenodo.org/records/4599666)) | CC BY 4.0, but rendered from Lakh MIDI, so it inherits the same problem. |
| **POP909** | The repository is MIT, but its content is "piano arrangements of 909 popular songs". MIT can't clear the songs. |
| **Chordonomicon** | Apache-2.0 / MIT on GitHub / Hugging Face, but its paper says "We leveraged web scraping techniques to extract song chord data from the Ultimate Guitar (UG) platform." |
| **Weimar Jazz Database** ([jazzomat](https://jazzomat.hfm-weimar.de/download/download.html)) | ODbL covers the database; the solos are transcribed from commercial recordings. |
| **The Session data** ([LICENSE.md](https://github.com/adactio/TheSession-data/blob/main/LICENSE.md)) | ODbL plus a content licence that says "You may not use, adapt, modify, or process the material in any way with Large Language Models." That is incompatible with an AI-agent DAW. |
| **Nottingham folk set** (jukedeck, *research pass*) | "released under the GNU GPLv3 license". |

---

## 4. (c) MIDI / groove / performance datasets

| Dataset | Licence | What it is | Good for |
|---|---|---|---|
| **Groove MIDI Dataset (GMD)**, [magenta.tensorflow.org/datasets/groove](https://magenta.tensorflow.org/datasets/groove) | **CC BY 4.0**: "made available by Google LLC under a Creative Commons Attribution 4.0 International (CC BY 4.0) License". The `LICENSE` file inside the zip says the same. | "about 13.6 hours, 1,150 MIDI files, and over 22,000 measures of drumming" by 10 drummers, "more than 80% of duration coming from hired professionals". Recorded on a Roland TD-11 e-kit "along with a metronome". Labelled beat or fill, style and BPM. | **Feel:** per-step timing, accents and swing per style (shipped, §5). **Priors:** per-step hit probabilities per style, also in the templates. Citation: Gillick, Roberts, Engel, Eck, Bamman, *Learning to Groove with Inverse Sequence Transformations*, ICML 2019. |
| **Expanded GMD (E-GMD)**, [magenta.tensorflow.org/datasets/e-gmd](https://magenta.tensorflow.org/datasets/e-gmd) | **CC BY 4.0**, same wording as GMD | "444 hours of audio from 43 drum kits", 45,537 sequences, recorded at "44.1kHz and 24 bits". MIDI-only download is 103 MB; the full set is 90 GB. The page notes that "errors in the recording process … resulted in unusable tracks". | Little extra for grooves: the page itself recommends GMD for symbolic use. The audio is renders of one hardware module's kits, so **don't** cut one-shots from it. |
| JSB Chorales ([czhuang/JSB-Chorales-dataset](https://github.com/czhuang/JSB-Chorales-dataset)) | *Unverified*: no LICENSE file. Bach himself is public domain. | Four-part chorales | Not needed: re-derive from a public-domain edition if voice-leading data is ever wanted. |
| When in Rome ([MarkGotham/When-in-Rome](https://github.com/MarkGotham/When-in-Rome), *research pass*) | New analyses are CC BY-SA (version not stated); imported ones keep their source licence | Roman-numeral analyses of public-domain classical works | Share-alike data. Not needed, because `shared/music/theory` generates progressions from rules. |

The useful symbolic data for beats is GMD. Melody and harmony datasets are either song-derived (§3) or add
nothing over theory rules, so **don't gather those**.

---

## 5. Shipped: groove templates from GMD

**Files:**
- `scripts/grooves/smf.mjs`: a small SMF reader, cross-checked against `shared/midi/smf.ts` on all 1,150 files
  with 0 mismatches.
- `scripts/grooves/extract.mjs`: the extractor.
- `shared/grooves/templates.gen.ts`: generated, 30 KB.
- `shared/grooves/apply.ts`: the pure `applyGroove`.
- `shared/grooves/types.ts`.

**Regenerating.** Download `groove-v1.0.0-midionly.zip` (3.1 MB; MD5 matches Google Storage's `x-goog-hash`), unzip
it, then:

```
node scripts/grooves/extract.mjs <unzipped groove dir> [--check]
```

The dataset is never committed. The extractor treats it as untrusted data: it opens only `.mid` paths inside the
given folder and executes nothing.

**Method.**
1. **Input:** 4/4 *beat* performances only. Fills, other metres and tiny takes (under 16 hits or under 2 bars) are
   skipped.
2. **Classes:** GMD's Roland pitches are mapped to four classes:
   - kick (35/36);
   - snare (37/38/39/40);
   - hihat: closed, open, pedal and ride (22/26/42/44/46/51/53/59);
   - other: toms, crashes and anything else.
3. **Bar alignment:** tick 0 is assumed to be the downbeat, which the data supports. A strong backbeat on 2 and 4
   shows up in 48/53 funk, 26/28 soul and 31/34 hip hop takes; the rest are half-time grooves or fragments.
4. **Global offset:** each performance's offset is removed. It is the median deviation of hits on quarter-note
   lines, which swing doesn't affect.
5. **Swung grid:** swing is estimated per style (the median phase of off-beat hits). Hits are then assigned to a
   **swung** 16th grid, so a swung "and" counts as step 3 of the beat at +0.5 of a 16th, not as a late step 4.
6. **Per cell** (template × class × step):
   - **Timing:** the 10 % trimmed mean and robust spread (1.4826 × MAD) of the offset, in fractions of a 16th.
   - **Velocity:** the trimmed-mean velocity relative to that performance's class median, then normalised so the
     probability-weighted mean is 1.
   - **Hit probability:** the mean over performances of (bars with a hit ÷ bars).
   - Each performance contributes at most 64 hits per cell.
   - A cell needs ≥ 30 hits from ≥ 3 performances. Otherwise it falls back, in order: to all classes at that
     step, then the class at that beat position, then everything at that beat position.

| Template | Performances | Drummers | Bars | Swing 8th / 16th | Merged GMD styles |
|---|---|---|---|---|---|
| hiphop | 32 | 5 | 874 | 0.502 / 0.515 | hiphop |
| funk | 69 | 4 | 3,511 | 0.500 / 0.537 | funk, jazz-funk/fusion/linear, New Orleans funk/second line |
| soul | 29 | 4 | 697 | 0.496 / 0.542 | soul, motown, gospel |
| jazz | 37 | 5 | 1,765 | 0.569 / 0.483 | jazz, swing, march, klezmer |
| shuffle | 9 | 5 | 551 | 0.617 / 0.500 | blues/rock/New Orleans shuffles, Purdie shuffle |
| latin | 56 | 4 | 4,433 | 0.504 / 0.471 | latin, Brazilian, Afro-Cuban, cha-cha |
| reggae | 4 | 2 | 287 | 0.521 / 0.452 | reggae (**light evidence**) |
| afrobeat | 15 | 2 | 1,137 | 0.496 / 0.525 | afrobeat, highlife |
| rock | 169 | 9 | 6,600 | 0.506 / 0.498 | rock, punk, country, indie, prog… |
| pop | 15 | 4 | 321 | 0.494 / 0.519 | pop |
| dance | 7 | 2 | 554 | 0.500 / 0.513 | disco, breakbeat (**light evidence**) |

All 442 performances are used. "middleeastern" (1 take) has no family and was dropped.

**Applying (`applyGroove`):**
- **Timing:** a note on a 16th step moves by `amount` × that step's offset for its class, and keeps its own small
  deviation.
- **Re-applying:** a note already sitting on its grooved position doesn't move, so applying twice doesn't stack
  timing. Velocity shaping does compound.
- **Off-grid notes** (triplets, rolls) ride along with their nearest step.
- **Bounds:** notes never leave the pattern, and velocities stay within MIDI 1..127.
- **Instrument class** comes from the channel name via `roleFromName`: kick → kick; snare/clap → snare;
  hat/openhat/ride → hihat; everything else → other.

**Limits:**
- GMD is live drumming on an e-kit. "hiphop" means drummers playing hip hop beats (close to boom-bap), not
  programmed trap. GMD has no trap, drill, house or EDM templates.
- reggae and dance rest on 2 drummers each.
- The jazz swing estimate (0.569) mixes medium swing with march and fast tunes.
- Templates are 4/4. In other metres the steps wrap per bar.

---

## 6. (d) What users can bring themselves

Users can bring material we can never ship: their purchased packs and their own music. For their own projects
this is fully legal, because royalty-free packs license exactly this use.

- **Browser folders.**
  - The user adds sample folders in the Browser (`settings.browserRoots`).
  - Agents search them with `find_samples` (factory kit plus Browser folders), which sounds-core is making smarter
    this wave.
  - Agents load sounds with `load_sample`. With File access set to "Ask me", a file outside those folders is
    asked about first.
  - If no folders are set, `find_samples` says "The user has no Browser folders yet". That line is the cue for
    agents to suggest adding them.
- **Reference library** (Wave 3).
  - `library_import` analyses a folder of the user's music into a collection: features, stems and transcriptions,
    stored as derived data.
  - `get_style_profile`, `search_references`, `read_reference` and `compare_to_reference` give agents grounded
    statistics.
  - `check_originality` guards against copying.
  - This is the legal path to "learn from the music I like".
- **Gap:** neither path is mentioned at the moment a user asks for "better sounds". Two fixes:
  - **Onboarding:** a guide article or Home tip: "Point Krypt at your sample packs and your music folder".
  - **Agent prompt:** when `find_samples` returns only factory results, suggest adding a Browser folder; when the
    user names a reference artist, suggest `library_import` on their own copies.

  These belong to the ui-sounds and craft-tools owners (§8).

---

## 7. (e) Recommendations, ranked by value for AI-made beats

1. **Use the groove templates everywhere drums are written** (done in the data; the wiring is requested in §8).
   - The playbooks should name a template per genre: hiphop for boom-bap and lo-fi, soul for R&B, funk, dance for
     disco and house, shuffle for blues and swing, latin, afrobeat, rock and pop.
   - The one-prompt workflow should run `transform_notes {op: "groove"}` on drums, bass and keys. Agents keep
     drums sounding "programmed" today, so this is cheap and audible.
2. **Use GMD hit probabilities as drum priors.** The `prob` arrays are a per-style, per-step "how often is there a
   kick here" map. `get_playbook` or `review_song` could use them to flag stiff, unidiomatic grids. That is a small
   code change with no new data.
3. **Real acoustic drums as optional content** *(needs D1, D2)*:
   - Karoryfer CC0 kits (Big Rusty, Unruly, Swirly, Frankensnare, The Hat With The Phat);
   - the Salamander Drumkit (public domain).

   These are the biggest audible gain for live genres (soul, funk, rock, jazz), which our synthesised kit can't
   match.
4. **A real piano** *(D1, D2)*: Salamander Grand Piano (public domain) or Upright Piano KW (CC0). Keys are in almost
   every pop or R&B prompt.
5. **Orchestral and mallets** *(D1, D2)*: VSCO-2 CE and VCSL (CC0) for strings, brass, bells and percussion in
   cinematic and pop work.
6. **Hand-picked Freesound CC0 one-shots and textures** *(D3)*: foley, vinyl and room textures, field recordings.
   Keep a per-sound manifest. Lower priority, because rust-sounds already synthesises transition material this
   wave.
7. **Don't:**
   - NSynth as instruments;
   - any royalty-free commercial pack;
   - NC, research-only or song-derived datasets;
   - The Session;
   - Freesound bulk harvesting.

## 8. Decisions and requests

**Decisions for the lead and the user:**
- **D1. May factory content include third-party CC0 / public-domain recordings?** `10` says factory material is
  Krypt-original and synthesised. Allowing items 3–5 means a new content category with credits in
  `THIRD-PARTY-NOTICES.md`.
- **D2. Installer, or optional download?** Multisampled pianos and kits are large. VCSL alone is 20–75 MB per
  instrument raw. Suggestion: a "content packs" downloader that reuses the model-manager pattern from `08 §2.2`
  (manifest with URL, SHA-256, licence text, licence shown before download), with nothing added to the installer.
- **D3. Freesound.** A hand-curated CC0 set is fine. An in-app Freesound search needs an API key and, per its terms,
  "commercial use … negotiated … with UPF". Decide whether to pursue that.
- **D4. Credit public-domain items anyway** (recommended). Archive a copy of each informal public-domain or
  permission page (Salamander, Iowa) next to the files.

**Requests for other owners** (I did not edit these files):
- **playbooks** (`shared/playbooks/*.ts`): add a groove template id per genre, and a step in each playbook: "apply
  `transform_notes {op:'groove', template}` to drums, then bass/keys".
- **craft-tools** (`electron/mcp/prompts.ts`, SERVER_INSTRUCTIONS, `docs/MCP.md`):
  - mention the `groove` op in the one-prompt workflow;
  - add `groove` to the `transform_notes` row in `docs/MCP.md`;
  - suggest Browser folders and `library_import` when the user asks for "better sounds" or names a reference.
- **ui-sounds** (`src/guides/**`): add one paragraph to the new article on bringing your own packs and music.
- **lead:** decide D1–D4 at integration.
