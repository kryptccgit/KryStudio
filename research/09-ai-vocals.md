# 09 — AI vocals: singing over a beat

> Research report #9. Written 2026-10-11. Follows **08 §5** (the vocals design) and **04 §9.4 / §9.6** (model
> licences), and corrects both where §1 says so. Every licence below was read on that day, from a LICENSE
> file, a Hugging Face card or API tag, a release NOTICE, or a vendor's terms. Numbers in brackets point to
> §7. "Unverified" means no primary source confirmed it. Statements labelled *Krypt estimate* are ours and have
> no source.
>
> **Verdicts follow 04 §9:**
> - **Ship:** bundle it.
> - **Optional:** a Model Manager download that shows the licence and verifies a SHA-256.
> - **Gate:** optional, and the user accepts third-party terms first. **Every cloud connector is Gate + BYO
>   key** and is never bundled.
> - **Avoid:** don't ship or link it.
>
> Not legal advice. The voice-commission contract in §6.2 needs a lawyer.

---

## 0. TL;DR

1. **There is still no English singing voice we could ship.**
   - We found no English DiffSinger or NNSVS voice under CC0, CC-BY, MIT or Apache that allows both
     redistribution and commercial output.
   - The best one, Hoshino Hanami, allows commercial songs but forbids re-uploading the voicebank [57].
   - So 08 §9.1 stands: **a default voice means commissioning one.**
2. **DiffSinger has a trap.**
   - The community vocoder that nearly every DiffSinger voicebank depends on is **CC BY-NC-SA 4.0**, and its
     repo is **AGPL-3.0** [33][34].
   - openvpi says the licence binds the *weights* (redistribution and fine-tuning), not the audio that flows
     through them, and that it "cannot provide commercial license" [36].
   - So: never bundle or mirror it, and never fine-tune it. Our own voice needs our own vocoder.
3. **ACE-Step 1.5 can, on paper, sing over a given instrumental, but it is not note-exact.**
   - The route is the `lego` task with track `vocals`, on the **base DiTs only** [6][15].
   - Official docs never show it for vocals. It has had two output-breaking bugs: #311, fixed in March, and
     #1286, closed "not planned" in September [9][10][11].
   - Whether it returns a stem or a full mix is undocumented [24].
   - It is MIT/MIT and runs on 8 GB GPUs via acestep.cpp with Vulkan [23][24].
   - **Verdict: Optional and experimental, behind a spike.**
4. **New since 04: SoulX-Singer** (Feb 2026).
   - Code and weights are **Apache-2.0** [46][47].
   - It supports English and takes **MIDI notes + lyrics** plus a short voice prompt [46].
   - It is PyTorch only, 2.8 GB, 24 kHz output, and its training data is not named.
   - Verdict: **evaluate.** A commissioned singer's consented prompt could drive it with no voicebank training
     at all.
5. **Ranked routes (§6.1):**
   1. Vocal score editor + DiffSinger provider with user-imported voicebanks. **Ships first.**
   2. ACE-Step "Sing over this beat" (experimental).
   3. A commissioned Krypt voice, trained with DiffSinger on permissive data plus our own vocoder.
   4. SoulX-Singer (evaluate).
   5. Voice conversion of the user's own voice (later).
   6. BYO-key cloud connectors: Mureka, MusicGPT, ElevenLabs.
6. **Cloud reality:**
   - Suno and Udio have **no public API**. Suno's ToS bans robots and scraping; Udio downloads are still off
     [103][105][106].
   - MiniMax closed its paid music API to new users on 20 Aug 2026 [110].
   - Lyria takes no audio input [109].
   - Only **Mureka** and **MusicGPT** document "sing these lyrics over my uploaded track" [112][113].
7. **Runtime risk: OpenUtau rolled DirectML back to 1.23.0** on 2026-09-24. The 1.24.x DirectML build "can kill
   the process natively while an InferenceSession is being created" [43]. Krypt's analyzer ships exactly that
   build, 1.24.4 (`engine/crates/analyzer/Cargo.toml`). Switching voices means creating a new session, so test
   this before Wave 3D (§6.3).

---

## 1. Corrections to 04 and 08

| Where | Said | Now |
|---|---|---|
| 04 §9.6, 08 §5.2 | DiffSinger: "Apache-2.0 / MIT code; each voicebank has its own terms" | True, but the shared vocoder is CC BY-NC-SA 4.0 and its repo AGPL-3.0 [33][34]. A voicebank's permissive terms do **not** cover its `nsf_hifigan`/`pc_nsf_hifigan` dependency (Hanami ships its vocoder under NC-SA [57]). |
| 08 §5.2 provider 2 | ACE-Step "add layer" may sing over our instrumental | Only on base and xl-base. Vocals are undocumented, two bugs are on record, and stem vs mix is undocumented. See §2. |
| 04 §9.4 | ACE-Step 1.5: Optional | Still holds for the DiTs and LMs. New: the official Chinese-New-Year LoRA is OpenRAIL-M and says "commercial use is prohibited" [19]. The org's **ACE-Step-DAW is AGPL-3.0** [21]. Half the community LoRAs have no licence tag [20]. |
| 04 §9.4 | DiffRhythm: Gate (Stability VAE) | **DiffRhythm 2** (Nov 2025) is Apache-2.0 for code *and* weights [55]. It makes full songs from lyrics plus a reference WAV; it does not sing over a beat. Optional, low priority. |
| 04 §9.6 | RVC: "weights of unknown provenance" | The official base `pretrained_v2` is MIT-tagged [71], and the README says it was trained on ~50 h of VCTK [70], which is CC BY 4.0 [72]. The unknowns are community voice models, ContentVec's weights and RMVPE's training data (§4.1). |
| 04 §9.1 | DirectML 1.24 is the last release | It is also the build OpenUtau rolled back from because of native crashes [43]. |
| 08 §9.3 | No cloud provider offers note-exact singing | Still true. Mureka accepts a **MIDI melody** (5–60 s), but not combined with its other controls [112]. |

---

## 2. ACE-Step 1.5 and 1.5 XL, as of 2026-10-11

There is no 1.6 or 2.0. The newest models are the XL diffusers repos, created 2026-06-01 [18].

### 2.1 Tasks and exact inputs

`TASK_TYPES_TURBO = text2music, repaint, cover, cover-nofsq`; `TASK_TYPES_BASE` adds `extract, lego,
complete` [6].

The track names are `vocals, backing_vocals, drums, bass, guitar, keyboard, percussion, strings, synth, fx,
brass, woodwinds` [6].

| Task | Models | Inputs | Use for "vocals over my beat" |
|---|---|---|---|
| text2music | all | caption and/or lyrics; bpm, key/scale, time signature, duration, `vocal_language` [3] | Whole song. Ignores our beat. |
| cover | all | `src_audio` and caption (required); `audio_cover_strength` 0–1; optional lyrics "for new vocals" [3] | Re-synthesises the whole track following the source's "melodic structure" [4]. Our instrumental is *regenerated*, not kept. Separate the vocals afterwards and lay them over the original; alignment is unverified. |
| repaint | all | `src_audio`, `repainting_start/end` (3–90 s), caption. A "change lyrics" mode keeps melody and orchestration [4] | Fix one line of an ACE-Step vocal. |
| **lego** | **base, xl-base only** [15][17] | `src_audio`, the instruction "Generate the {TRACK} track based on the audio context:", caption, repaint window [3][6]. Lyrics are not an official lego input. acestep.cpp passes caption and lyrics "verbatim to the DiT" [24]. | **The only direct route.** `TRACK = vocals` (or `backing_vocals`). |
| extract | base, xl-base | `src_audio` + "Extract the {TRACK} track from the audio:" [6] | Pull a vocal stem out of a lego or cover result (an alternative to Mel-RoFormer). |
| complete | base, xl-base | One stem as `src_audio`, plus the tracks to add and a caption [3] | The reverse direction: a sung or hummed vocal in, a backing track out [4]. |

sft and turbo do Text2Music, Cover, Repaint and reference audio, but not lego, extract or complete [16].

**Lego and vocals, the record so far:**
- **#311 (Feb 2026):** lego with "vocals" gave "complete mungled nonsense" [9]. It was closed after **PR #810**
  (merged 2026-03-11), "Fix lego mode: source audio latents silenced before reaching DiT" [10].
- **#1286 (Aug 2026):** for lego and complete, the LM's codes "silently pre-empt real source-audio
  conditioning". An interim fix (#1287) skips the LM for these tasks. The issue was closed **"not planned"** on
  2026-09-19 [11].
- **Consequence:** Krypt must run lego **without the LM stage.**
- **No official demo** shows lego producing vocals.

### 2.2 Lyrics plus melody, MIDI or notes

- **There is no MIDI or note conditioning.**
  - Issue #926 asked to "generate vocal/instrument only tracks from a midi melody". It was closed "not
    planned" [12].
- **Melody can only be steered with audio:**
  - cover's `src_audio` gives "melodic structure control" [4];
  - repaint's "change lyrics" mode keeps the melody [4];
  - "LM Codes Hints" take 5 Hz semantic codes "for controlling melodic structure without uploading source
    audio" [5].
- `reference_audio` is a "Global reference for timbre or style" [4], not a melody.
- **Spike idea, undocumented:** render the KPN melody as a guide tone and use it as cover's `src_audio`
  together with the lyrics.
- **Conclusion:** it is not note-exact, and we cannot place syllables.

### 2.3 Stem or mix

Undocumented. acestep.cpp says it is "model-dependent and unverified in this codebase" [24]. Plan: always run
`extract(vocals)` (or Mel-RoFormer, 04 §9.3) on the result, then null-test it against the source instrumental.

### 2.4 English quality

- **Claims:** "strict adherence to prompts across 50+ languages" [1]. `VALID_LANGUAGES` lists 50 codes [6].
- **The paper:**
  - its test prompts are bilingual Chinese/English, with no per-language results;
  - its future work says "we plan to refine precise lyric alignment" [13].
- **The Tutorial:** vowel extension is "unstable, sometimes ignored or mispronounced" [4].
- **Issues:** no English-specific pronunciation issue was found (#450 concerns French) [13].
- **Verdict:** English quality is **unverified**. It must be judged by ear in the spike.

### 2.5 Hardware, Windows and acestep.cpp

**Hardware**
- **VRAM:**
  - "≥4GB for DiT-only mode; ≥6GB for LLM+DiT" [8];
  - 8–12 GB gets the 0.6B LM; 20–24 GB the 4B LM [7].
- **XL:** ≥12 GB with offload and INT8, ≥16 GB with offload, ≥20 GB without [17].
- **Speed:** "under 2 seconds per full song on an A100 and under 10 seconds on an RTX 3090" [1]. Those are
  turbo figures; base runs more diffusion steps (number unverified).
- **CPU:** works, but is "significantly slower" [8].

**Official Windows path**
- A portable 7z with embedded Python that needs **CUDA 12.8**.
- AMD through ROCm 7.2; Intel XPU tested only on an iGPU.
- **No DirectML** [8].

**acestep.cpp**
- **Licence and status:**
  - **MIT** ("Copyright (c) 2023-2026 The acestep.cpp authors") [25].
  - C++17 on GGML; last push 2026-10-07 [23].
- **Backends:** CPU, CUDA, ROCm, Metal, Vulkan [23].
- **Tasks:** all seven, through JSON and HTTP. lego, extract and complete have no dedicated CLI flag [24].
- **LoRA:** PEFT and ComfyUI formats [23].
- **Defaults** "target 8 GB consumer cards" [24].
- **Binaries:**
  - no GitHub releases [23];
  - Windows builds (`ace-server.exe`, `ace-synth.exe`, ggml-vulkan/cuda DLLs) sit on the author's server,
    dated 2026-10-07 [27].
  - **We should build it ourselves in CI from a pinned commit.**

**GGUF sizes** [26]

| File | Size |
|---|---|
| 2B DiT | Q8 2.4 GB / Q4_K_M 1.4 GB |
| XL DiT | Q8 5.0 GB / Q4_K_M 2.8 GB |
| LM 0.6B / 1.7B / 4B | Q8 677 MB / 1.9 GB / 4.2 GB |
| Text encoder | 748 MB |
| VAE | 322 MB |

A lego-only install (base Q8 + text encoder + VAE, no LM) is about **3.5 GB**.

**Reference design:** the official **acestep.vst3** (MIT, JUCE, built on acestep.cpp) does text2music, cover,
repaint and lego. It is build-only [22].

### 2.6 Licences, including the LoRA ecosystem

| Component | Licence | Verdict |
|---|---|---|
| ACE-Step-1.5 code | MIT, "Copyright (c) 2026 ACEStep", no extra clauses [2] | Reference only (we run acestep.cpp, not Python) |
| DiTs (turbo, base, sft, XL base/sft/turbo), LMs 0.6B/4B, captioner, transcriber | MIT on every HF tag [18]. The cards say "You can strictly use the generated music for commercial purposes" [15]. | **Optional** |
| LM 1.7B standalone card | Returned 401. A copy sits inside the MIT `Ace-Step1.5` bundle [14]. | Optional (via the bundle) |
| Training data | The cards say "Licensed Data", "Royalty-Free / No-Copyright Data" and synthetic MIDI-to-audio. The paper gives volumes (~20M pairs, 6M stem-separated tracks) but no sources [13][14]. | Disclose in the Model Manager |
| acestep.cpp | MIT [25] | **Optional** (we build it) |
| acestep.vst3 | MIT [22] | Reference |
| **ACE-Step-DAW** (official org) | **AGPL-3.0** [21] | **Avoid** (never paste from it) |
| ACE-Step-v1.5 Chinese-New-Year LoRA | **CreativeML OpenRAIL-M**; "commercial use is prohibited" [19] | **Avoid** |
| ACE-Step-v1 chinese-rap LoRA | Apache-2.0, but for v1 only [28] | n/a |
| Community LoRAs | We sampled 221 HF repos through the API on 2026-10-11 [20]: **105 have no licence tag**, 88 MIT, 21 Apache-2.0, 2 CC-BY-NC-4.0, 2 "other", 1 OpenRAIL-M, 1 CC-BY-4.0, 1 "unknown" | **Gate per LoRA.** Import only with a user licence attestation. Never catalogue untagged LoRAs. |

---

## 3. Note-exact singing synthesis (lyrics + notes → voice)

### 3.1 Engines and models

| Model | Code | Weights | English | Input | Runtime | Verdict |
|---|---|---|---|---|---|---|
| **DiffSinger** (openvpi) | Apache-2.0 [30] | No official base acoustic or variance models are named [31] | Yes; `ds_cmudict-07b` dictionary [31] | Phoneme and note score | "DiffSinger uses ONNX as the deployment format": acoustic, variance and vocoder exports [32]. OpenUtau (MIT) renders it [41][42]. | **Ship the engine** as our Rust port; voices are user-supplied |
| openvpi community vocoders (NSF-HiFiGAN, PC-NSF-HiFiGAN 2025-02) | Repo **AGPL-3.0** [33] | **CC BY-NC-SA 4.0** [34][35]. The NOTICE forbids charging for redistribution and requires the full acknowledgement list. "We cannot provide commercial license" [36]. | — | mel → 44.1 kHz | ONNX inside `.oudep` [34] | **Gate**: the user downloads from openvpi. Never mirror it, never fine-tune it. |
| openvpi **SingingVocoders** (training code) | MIT [37] | Train your own | — | — | — | **Ship** (tooling) |
| NVIDIA **BigVGAN v2** 44 kHz / 128-band / 512x | MIT | **MIT**, 122M parameters. Trained on speech, environmental sounds and instruments; singing is not stated. fmax 22050 [44] | — | mel → wave | PyTorch; ONNX export is ours to do | **Optional** (a vocoder candidate for our own voice) |
| NNSVS / ENUNU | MIT [45][64] | The registry lists only `yoko` models, with no licence; last push 2023-10 [45] | Unverified | Score | — | Avoid (stale) |
| **SoulX-Singer** | **Apache-2.0** [46] | **Apache-2.0**: "free to use the codes and model weights" [46][47]. `model.pt` is 2.8 GB; 24 kHz, 128 mels [47]. Trained on "42,000+ hours" of data whose sources are not named [46][48]. | **Yes** (Mandarin, English, Cantonese) [46] | "Score-conditioned (MIDI notes)" or F0, plus lyrics (English G2P via `g2p_en`), plus a **voice prompt** wav with metadata [46] | PyTorch only; the example uses CUDA fp16 | **Optional (evaluate)** |
| YingMusic-Singer-Plus | CC BY 4.0, **plus `LICENSE-STABILITY`** for the Stable Audio 2 VAE [49] | cc-by-4.0, 0.7B | zh, en | A melody *singing clip* + new lyrics + an optional timbre reference [49] | PyTorch | **Gate** (Stability Community terms) |
| Vevo2 / Vevo1.5 (Amphion) | MIT | **CC BY-NC-ND 4.0** [50] | Yes | Text + reference | — | **Avoid** |
| TCSinger | MIT [51] | MIT tag; training-data provenance unverified | zh, en | Phonemes + notes + prompt; NVIDIA CUDA [51] | — | Watch |
| TechSinger | **No LICENSE file** [52] | MIT tag, but trained on GTSinger + M4Singer, both NC [52] | zh, en | — | — | **Avoid** |
| StyleSinger | MIT [53] | MIT | **Chinese only** [53] | — | — | Avoid (no English) |
| SongGeneration / LeVo (Tencent) | Custom: "only for academic, research and education purposes"; no "commercial or production purposes" [54] | Same | — | Lyrics → full song | — | **Avoid** |
| DiffRhythm 2 | Apache-2.0, code **and** weights [55] | — | Unverified | Lyrics + reference WAV → full song | — | Optional, low priority (doesn't sing over a beat) |
| InspireMusic | Apache-2.0 [56] | Unverified | — | Text or audio prompt; lyrics not mentioned | — | Not a singer |
| Synthesizer V, ACE Studio | Proprietary, note-level, no cloud API (Synth V has in-app JS/Lua scripting only) [115][116] | — | — | — | — | Product references only |

### 3.2 English voicebanks people actually use

| Voice | Terms | Can Krypt bundle it? | Commercial songs? |
|---|---|---|---|
| **Hoshino Hanami** (Lotte V; EN + 7 languages) | "Use this voicebank for any creative purpose, even commercially. Prior permission is not necessary" (credit required). "Do NOT reupload the original voicebank elsewhere." Its vocoder is CC BY-NC-SA 4.0 [57]. | **No** | Yes |
| TIGER | Commercial use "By purchase of license"; "Derivatives of any sort are forbidden" [58] | No | Paid |
| Miyo | Commercial use "By purchase of license" [58] | No | Paid |
| Canary | Commercial use "with permission" [58] | No | Ask |
| Laru Mine | "You may not redistribute the voicebank" [58] | No | — |
| Namine Ritsu (Japanese only) | Commercial use and redistribution allowed [59]; her dataset bars base models and transfer learning [58] | n/a (no English) | — |

**Bottom line:** voicebanks are **import-only.** Krypt shows each bank's own terms (and its vocoder's) at
import time, and records the user's acceptance.

### 3.3 Datasets we could legally train on

| Dataset | Licence | English | Use for a Krypt voice |
|---|---|---|---|
| **ACV-001** (male), **ACV-002** | CC BY-SA 4.0. It "only applies to direct use of the dataset and models mainly featuring the voice of ACV-00x, and does not apply to models trained via parallel training. Models trained using ACV-00x as supplementary data can follow its own license." [60] | Yes, ARPAbet, with DiffSinger `.ds` files. ACV-001 warns its English slur data is partly faulty [60]. | **Supplementary speakers** in multi-speaker training. Don't ship their speaker embeddings. |
| Project AI❤dol (Lotte V) | CC BY-SA 4.0, but "do not publicly release any model featuring this voice without prior permission" [61] | Yes, 1 h 45 min, non-native singer | Ask first |
| **VocalSet** / Annotated-VocalSet | **CC BY 4.0**: 10.1 h, 20 singers; annotations add notes, MIDI and lyrics [62] | Vowels, scales, excerpts | Vocoder and pitch training (with attribution) |
| NUS-48E | Doubtful: the Zenodo copy says CC BY 4.0 with creator "None"; MakeDiffSinger lists "Custom ToS" [39] | Yes | Avoid |
| GTSinger, M4Singer, CSD, Opencpop, ACE-Opencpop/KiSing, Alex Floarea 2.0 | NC variants (BY-NC, BY-NC-SA, BY-NC-ND) [39][63] | Some | **Avoid** |

---

## 4. Voice conversion (the user sings or hums → a target voice)

### 4.1 Shared building blocks: the hidden licence questions

| Block | Code | Weights | Note |
|---|---|---|---|
| ContentVec (RVC's content encoder) | MIT [73] | **No licence stated** for the weights [73] | Gate |
| HuBERT base (fairseq) | MIT | HF `facebook/hubert-base-ls960`: apache-2.0, LibriSpeech [75] | Permissive alternative to ContentVec |
| WavLM (used by kNN-VC, FreeVC and MeanVC speaker embeddings) | `unilm` MIT | The HF card points to UniSpeech's LICENSE, which is **CC BY-SA 3.0** [76] | ShareAlike risk |
| RMVPE (f0) | Dream-High: Apache-2.0. The yxlllc fork has no LICENSE [74]. | yxlllc's training data includes "m4singer-based vocoder synthesis data" (M4Singer is NC) [74] | Prefer **pyin**, which we already ship |

### 4.2 Models

| Model | Code | Weights | Singing / real time / ONNX | Verdict |
|---|---|---|---|---|
| **RVC** WebUI | MIT [70] | HF `lj1995/VoiceConversionWebUI` MIT [71]; base trained on "nearly 50 hours of high quality audio from the VCTK open source dataset" [70] (VCTK is CC BY 4.0 [72]) | Yes. 170 ms end-to-end (90 ms with ASIO). DirectML on Windows; `rmvpe.onnx` is provided. "RVCv3" is not released [70]. | **Optional, later** (own voice only; attribute VCTK; swap RMVPE for pyin) |
| **Applio** | MIT, covering "source code and model weights" (it was CC BY-NC until the 2024-05-24 relicense) [77] | Official models trained on public datasets such as VCTK [77] | RVC-based; "no longer receive frequent updates" [77] | Optional, later |
| **DDSP-SVC** | MIT [80] | Uses ContentVec/HubertSoft + RMVPE + NSF-HiFiGAN [80] | Real-time singing GUI; `export_onnx.py` [80] | Optional, later (vocoder licence applies) |
| SoulX-Singer-SVC | Apache-2.0 [46] | Apache-2.0; `model-svc.pt` 2.79 GB [47] | Zero-shot, offline | Evaluate (alongside §3.1) |
| Beatrice 2 | Trainer and its pretrained models MIT [85] | Trained partly on ReazonSpeech: CDLA-Sharing, "SOLELY FOR THE PURPOSE OF JAPANESE COPYRIGHT ACT ARTICLE 30-4" [85] | ~50 ms, CPU, singing is a stated goal [85] | Gate |
| MeanVC2 | Apache-2.0 [86] | Apache-2.0; uses WavLM embeddings [86] | 18M parameters, CPU real time; **speech only** [86] | Watch |
| Chatterbox VC / OpenVoice v2 | MIT [87][88] | MIT; sources of training data not named | Speech; built-in watermark (PerTh / wavmark) [87][88] | Not for singing |
| kNN-VC / FreeVC | MIT [89] | Depend on WavLM [89] | Speech | Avoid (WavLM BY-SA) |
| w-okada voice-changer | MIT [90] | Hosts RVC and Beatrice models | Real-time client; ONNX edition [90] | Reference |
| HQ-SVC | **No LICENSE in repo**; HF apache-2.0 [92] | — | — | Watch |
| LeapSVC | MIT, but **ships no SVC weights** because its base was trained on GTSinger (NC) [91] | — | — | Reference |
| **so-vits-svc** | **AGPL-3.0**, archived [78] | — | — | **Avoid** |
| **Diff-SVC** | **AGPL-3.0** [81] | — | — | **Avoid** |
| **Seed-VC** | **GPL-3.0** code *and* HF weights, archived [82] | — | — | **Avoid** |
| **YingMusic-SVC** | MIT, but "built upon" Seed-VC (GPL-3.0) | **CC BY-NC 4.0** [83] | — | **Avoid** |
| **Vevo / Vevo2** | MIT | **CC BY-NC / BY-NC-ND** [84][50] | — | **Avoid** |
| so-vits-svc-fork | MIT and Apache texts; ONNX export "currently not working"; maintenance only [79] | — | — | Avoid (stale) |

### 4.3 Consent safeguards in practice, and the law

**What products do**

| Product | Safeguard |
|---|---|
| ElevenLabs | Professional cloning is your own voice only, verified by reading "verification lines" aloud. "No-go voices" block "prominent public figures" [96]. |
| Resemble AI | Speaker verification matches the consenting person to the dataset voice, plus the PerTh watermark [97]. |
| Dreamtonics Vocoflex | KYC identity verification, plus a watermark with "a user-unique license ID" [98]. |
| Kits.ai | Users warrant "all rights… consents"; impersonation is banned. No verification step is described [99]. |

**What the law says**

- **Tennessee ELVIS Act (2024).**
  - "Voice" includes a "simulation".
  - §47-25-1105(a)(3) creates liability for distributing a *tool* whose "primary purpose or function" is
    producing an individual's voice without authorisation [100].
- **NO FAKES Act (US).**
  - Reintroduced on 20 May 2026 and advanced by Senate Judiciary in June 2026 [101].
  - It is **not law**. Its current status is unverified (congress.gov was unreachable).
- **EU AI Act Article 50 (applies from 2 Aug 2026).**
  - Synthetic audio must be marked "in a machine-readable format and detectable".
  - Deepfakes must be disclosed, with a lighter form allowed for evidently artistic works.
  - Systems already on the market before that date have a marking grace period to 2 Dec 2026.
  - These points come from secondary sources [102].

**What Krypt implements** (extends 08 §1 "Voice likeness")

1. **Licence gate:** only MIT, Apache or CC-BY weights, per the tables above.
2. **Own voice only.** Conversion targets are trained from the user's own recordings. A consent attestation is
   stored in the voice model's manifest.
3. **Spoken verification phrase.** Before training, the user reads randomised lines, and we compare speakers
   (the ElevenLabs/Resemble pattern) [96][97].
4. **Refuse named-artist voices.** No public-figure names in model names or prompts, which also keeps us away
   from ELVIS "primary purpose" exposure [100]. This applies to voices only, not musical style (08 §1).
5. **Mark every AI vocal render.**
   - Clip provenance in the project.
   - A **C2PA** manifest on export: `c2pa-rs`, MIT/Apache, supports WAV/MP3/FLAC [95].
   - An optional **AudioSeal** watermark (code and weights MIT) [93].

---

## 5. Cloud BYO-key connectors (never bundled)

| Provider | Official API | Your lyrics | Over **your** instrumental? Stem? | Melody control | Output rights | Price | Verdict |
|---|---|---|---|---|---|---|---|
| **Mureka** | Yes [112] | ≤5,000 chars | **Yes**: `POST /v1/track/generate`, `generate_type:"Vocals"` on an uploaded audio, with a start/end window and `vocal_gender`. Stem or mix unstated; `/v1/song/stem` separates [112]. | **`melody_id` from mp3/m4a/MIDI** (5–60 s), not combinable with other controls [112] | The API agreement says "you… own all Output"; no training on customer content; the service may be embedded in "Customer Applications" [112] | Prepaid top-ups; per-song price unverified | **Gate (BYO key)**, the first to build |
| **MusicGPT** | Yes [113] | ≤5,000 chars | **Yes**: `POST /v1/sing_over_instrumental`, ≤4 min input, two takes as MP3+WAV plus timestamped lyrics. Mix or stem unstated [113]. | No | Paid plans get "full commercial rights", **but MusicGPT takes a perpetual licence over uploads, including for training** [113] | $0.05–0.14 per song [113] | **Gate (BYO key)**, with an upload warning |
| **ElevenLabs Eleven Music** | Yes: `POST /v1/music` (`music_v1`, `v2`, `v2_5`) [107] | Yes, via composition plans | Partial: upload → `song_id` → inpainting, where chunks keep audio or condition on ≤30 s of it. "Add vocals to my instrumental" is not documented. A stem-separation endpoint exists [107]. | Tempo and key as text only | You retain output; no artist names or voice imitation; the Free tier has no API [108] | $0.15/min [108] | **Gate (BYO key)**, after a test |
| Google Lyria 3 / 3.5 | Yes (Gemini API) [109] | Yes, with section tags | **No audio input** (text plus up to 10 images); no stems [109] | No | Google claims no ownership; SynthID watermark; paid tier for EEA/UK/CH apps [109] | $0.08 per song [109] | Not for this feature |
| MiniMax Music | Yes, but the paid API is **"no longer available to new users" from 20 Aug 2026**; free endpoints are being discontinued [110] | — | `music-cover` regenerates the whole song; it is not an overlay | — | — | Was $0.15 per track | **Avoid** |
| Suno | **No public API**; an invite-only partner programme was reported in July 2026 (secondary) [103] | In the app | In the app: "Add Vocals" (beta, Pro/Premier) and stems [104] | — | ToS bans "robots, scraping"; the Free tier is non-commercial [105] | n/a | **Avoid** (no unofficial wrappers) |
| Udio | No official API | — | Downloads disabled since 29 Oct 2025 [106], still off in Oct 2026 (secondary) [106] | — | — | — | **Avoid** |
| Stability Stable Audio 2.5/3 | Yes | — | It "does not produce intelligible vocals" [111] | — | — | — | Not for vocals |
| Kits.ai | Yes, in beta: voice conversion only; its TTS was removed in Sept 2025 [114] | No | Converts an existing vocal | — | "commercial and non-commercial" [114] | Unverified | Gate (later, as a conversion connector) |

**Connector rules** (they inherit 04 §7):
- **Keys:** stored with `safeStorage`.
- **Uploads:** every upload needs an explicit confirm dialog naming the provider and its training terms. We
  only ever send **local bounces the user owns**; MusicGPT also accepts YouTube URLs, and Krypt never will.
- **Results:** they land as normal audio clips through a command, so they are undoable and carry provenance
  and a cloud-provider tag.

---

## 6. Recommendation for Krypt Studio

### 6.1 Ranked routes

| # | Route | Verdict | Why | Gating work |
|---|---|---|---|---|
| **1 — ships first** | **Vocal score editor + `write_vocal` + DiffSinger provider** with user-imported OpenUtau-format voicebanks | Engine **Ship**; voicebanks and vocoder **Gate** (user-supplied) | It is note-exact, so the agent's KPN melody and lyrics are exactly what gets sung. It is deterministic, runs on ONNX on CPU or DirectML, and has a readable MIT reference in OpenUtau [41][42]. Krypt redistributes nothing. | `VocalPart` schema (08 §7); G2P from CMUdict; a Rust port of the DiffSinger pipeline; a DirectML 1.24 crash test |
| 2 | **"Sing over this beat" (experimental)**: ACE-Step 1.5 **base** `lego(vocals)` via acestep.cpp | **Optional** | It is the only local MIT/MIT way to get AI vocals over the user's beat with no voicebank. It is not note-exact, and quality and reliability are unverified (§2). | A 2-week spike: lego without the LM; stem vs mix; English intelligibility by ear; the 8 GB Vulkan path |
| 3 | **Commission the "Krypt Voice"**: DiffSinger trained on commissioned audio, with ACV-001/002 as supplementary speakers and **our own vocoder** | **Ship** (first-use download) | It is the only way to have a default singer in the box. The same consented recordings also serve routes 4 and 5. | §6.2: budget, contract, about 2–3 months elapsed (*Krypt estimate*) |
| 4 | **SoulX-Singer** as a second score renderer | **Optional (evaluate)** | Apache/Apache, English, takes notes + lyrics, and needs only a short consented prompt instead of a trained voicebank [46]. | ONNX export (flow matching + vocoder) or a GGML port; quality at 24 kHz; training data undisclosed; prompts restricted to the Krypt voice or the user's verified own voice |
| 5 | **Voice conversion** of the user's own voice (RVC, Applio or DDSP-SVC family) | **Optional, later** | Code MIT, base weights MIT on VCTK [70][71][77]. Useful for "sing it yourself, sound like the Krypt voice". | ContentVec licence → prefer HuBERT (Apache); pyin instead of RMVPE; the §4.3 safeguards |
| 6 | **Cloud connectors**: Mureka, then MusicGPT, then ElevenLabs | **Gate (BYO key)** | Mureka and MusicGPT are the only ones that document lyrics over an uploaded track; Mureka also takes a MIDI melody [112][113]. | Per-provider terms screen and upload consent |

Also **Ship**: a tiny non-ML **"guide vox"** in `engine/crates/dsp`, a formant/vowel synth that follows a
`VocalPart`. With it, `write_vocal` is audible on a fresh install, before any voice is installed. This is a
Krypt suggestion with no external dependency.

### 6.2 What commissioning a Krypt voice involves

**Data**
- **How much:**
  - Community DiffSinger commissions ask for **≥30 min** of singing per language [66].
  - The released "Miyo" bank used about **65 min** [67].
  - The original DiffSinger single-singer dataset was **5.89 h** [65].
  - *Krypt estimate:* plan **2–3 h of finished, dry English singing** from one singer. Parallel multi-speaker
    training with ACV-001/002 [60] then fills phoneme coverage.
- **What to record:**
  - About 25–40 songs or excerpts **written for the session**, so no third-party songs end up in the dataset.
  - Full range, soft to belt dynamics, sustained vowels, breaths, plus a scales and vowels set for the vocoder.
- **Format:** 48 kHz / 24-bit, dry, mono, one mic and room, no tuning or effects [66].

**Labelling: the dominant labour**
- `transcriptions.csv` with `ph_seq`/`ph_dur` [31], built with the MakeDiffSinger pipelines (BSD-3-Clause)
  [38] and SOFA forced alignment (MIT) [40], then corrected by hand.
- Note labels for the variance and pitch models.

**Training**
- **Models:** acoustic + variance (duration, pitch, variance) + vocoder.
- **Compute:** the DiffSinger paper reports 16 h warm-up + 12 h main training on one V100 for 5.89 h of data
  [65]. A cloud RTX 4090 costs $0.34–0.89/h [68].
- *Krypt estimate:* tens of dollars per full run, low hundreds with iterations. That is days of GPU time
  against **weeks** of labelling.
- **Vocoder:** train NSF-HiFiGAN with **SingingVocoders (MIT)** [37] on the commissioned audio plus VocalSet
  (CC BY 4.0, credited) [62]. Or adopt **BigVGAN v2 (MIT)** [44] and train the acoustic model on its mel
  config, which has fmax 22050 against openvpi's 16000.
- **Never** fine-tune the openvpi vocoder: a fine-tune is an adaptation of NC-SA weights [34][36].

**Contract checklist** (for a lawyer to draft)
- **Consent:**
  - Explicit, written, informed consent to record, train AI voice models and distribute them in a free app.
  - The 2024 SAG-AFTRA Sound Recordings Code requires "clear and conspicuous consent", "minimum compensation
    requirements" and "specific details of intended use" for digital voice replicas [69]. Meet that bar even
    with a non-union singer, and check union status.
- **Scope:**
  - Any synthesis technology (DiffSinger, a SoulX prompt, a conversion target), worldwide and perpetual.
  - Users may use the outputs commercially, royalty-free.
  - Say plainly that copies already distributed cannot be recalled if the singer later withdraws, and what
    happens to future distribution.
- **Identity:**
  - A fictional voice name.
  - Whether the singer is credited.
  - No marketing that uses the singer's own name unless agreed.
- **Use limits:** a voice licence shipped with the weights (separate from Krypt's MIT code) that forbids
  impersonating the singer and deceptive use.
- **Money and warranties:**
  - A flat buyout, since the app is free and there is no royalty base.
  - The singer warrants the performances are their own.
- **Data:**
  - Who keeps the raw recordings, and how they are secured.
  - Whether we publish the dataset. Publishing helps the community, but lets anyone train the voice.

### 6.3 How it plugs into the architecture

**Provider interface.** Split 08 §5.2's `(score, voice, settings) → audio` into two kinds:

- **`ScoreRenderer`** `(VocalPart, voice, settings) → audio`.
  - Note-exact.
  - Implementations: DiffSinger, Krypt Voice, later SoulX-Singer.
- **`TakeGenerator`** `(instrumental bounce, lyrics, caption, window, seed) → audio take`.
  - Not note-exact.
  - Implementations: ACE-Step `lego`, Mureka, MusicGPT.

**Analyzer jobs** (`krypt-studio-analyzer.exe`, 08 §2.1)

| Job | What it does |
|---|---|
| `vocal.render` | DiffSinger ONNX in-process via `ort`, mirroring OpenUtau's pipeline: phonemes → linguistic → duration → pitch → variance → acoustic (shallow-diffusion depth) → vocoder [42]. |
| `vocal.generate` | Supervises an acestep.cpp child process. Use its JSON request mode; if `ace-server` is used, bind 127.0.0.1 on a random port with a token (04 §7; its binding is unverified). |
| `vocal.extract` | ACE-Step `extract`, or the existing Mel-RoFormer path. |
| `vocal.transcribe` | pyin → note blobs, turning an ACE-Step or cloud take into a `VocalPart` so it can be **re-rendered note-exactly** or corrected with Krypt Tune (`engine/crates/dsp/src/effects/pitch.rs`). |

**DirectML.** The analyzer pins Microsoft.ML.OnnxRuntime.DirectML **1.24.4**, which OpenUtau rolled back from
for native crashes on session creation [43].
- The supervisor should treat a crash during session creation as "retry this model on the CPU execution
  provider and remember that".
- Alternatively, test the 1.23.0 DLL with `ort`'s `api-23` feature.

**Model Manager** (`shared/analyzer/models.ts` already enforces a SHA-256 for every file)

| Entry | How it is handled |
|---|---|
| ACE-Step GGUFs | Base Q8, text encoder and VAE, pinned to an HF revision. The acestep.cpp runtime is built in our CI. The training-data disclosure from §2.6 is shown. |
| Krypt Voice | Ship (downloaded on first use). |
| Voicebanks | "Import from folder/zip". Krypt hashes at import, stores the bank's own terms, and requires the user's acceptance. Never catalogued. |
| openvpi vocoder | A **Gate** entry pointing at openvpi's own release URL with a pinned hash and the NC-SA text. Never mirrored. |
| LoRAs | Import with a licence attestation. |

**Document and undo**
- `VocalPart` and its migration are per 08 §7.
- Every rendered or generated take enters as an audio clip through a command, so it sits in the agent's undo
  group.
- Provenance is `{provider, modelId, licence, seed, lyricsHash}` plus an "AI vocal" flag. That flag drives the
  C2PA manifest on export (§4.3).

**MCP** (08 §6)
- **Existing tools:**
  - `write_vocal` (KPN with syllables);
  - `render_vocal` (a `ScoreRenderer`; it errors visibly if no voice is installed).
- **New tools:**
  - `sing_over` (a `TakeGenerator`; long-running, so it reports progress; marked experimental);
  - `vocal_to_score` (transcribe a take into a `VocalPart`);
  - later, `convert_voice` (own voice only).
- `list_models` gains voices and their licences.

### 6.4 GPL and non-commercial traps, called out

**Copyleft code** (never link it, never paste from it)
- openvpi/vocoders repo (AGPL-3.0) [33]
- ACE-Step-DAW (AGPL-3.0) [21]
- so-vits-svc and Diff-SVC (AGPL-3.0) [78][81]
- Seed-VC, code and weights (GPL-3.0) [82]
- YingMusic-SVC, which is built on Seed-VC [83]
- Remember also eSpeak NG (GPL-3.0), which sits behind Kokoro's phonemizer (04 §9.6). **Use CMUdict for G2P.**

**Non-commercial or restricted weights and data**
- openvpi community vocoders (CC BY-NC-SA) [34]
- Vevo / Vevo2 [84][50]
- YingMusic-SVC (CC BY-NC) [83]
- The ACE-Step Chinese-New-Year LoRA (OpenRAIL-M, no commercial use) [19]
- SongGeneration/LeVo (academic only) [54]
- TechSinger (trained on NC data) [52]
- GTSinger, M4Singer, Opencpop, CSD and ACE-KiSing data [39][63]
- Any RMVPE checkpoint trained on M4Singer-derived data [74]

**Gated, not free**
- YingMusic-Singer-Plus (Stability VAE terms) [49]
- Beatrice 2 (ReazonSpeech data terms) [85]
- ContentVec weights (no licence stated) [73]
- WavLM (CC BY-SA 3.0 per its card) [76]
- Every user-imported voicebank and LoRA

### 6.5 Decisions for the owner

1. **Commission the Krypt Voice?** This is the only shippable default singer. It costs a singer fee plus an AI
   buyout plus labelling time; compute is minor (§6.2).
2. **Ship ACE-Step "Sing over this beat" as experimental** if the spike clears a bar of intelligible English and
   staying in key and tempo with the beat in most takes?
3. **Allow cloud connectors (Mureka and MusicGPT) as BYO-key Gate features?** MusicGPT's training-licence clause
   needs a clear warning.

---

## 7. Sources

All checked 2026-10-11. GitHub licence and activity data also came from `api.github.com/repos/<owner>/<repo>`.

**ACE-Step**
1. https://github.com/ace-step/ACE-Step-1.5 (README)
2. https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/main/LICENSE
3. https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/INFERENCE.md
4. https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/main/docs/en/Tutorial.md
5. https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/main/docs/en/GRADIO_GUIDE.md
6. https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/main/acestep/constants.py
7. https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/main/docs/en/GPU_COMPATIBILITY.md
8. https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/main/docs/en/INSTALL.md
9. https://github.com/ace-step/ACE-Step-1.5/issues/311
10. https://github.com/ace-step/ACE-Step-1.5/pull/810
11. https://github.com/ace-step/ACE-Step-1.5/issues/1286
12. https://github.com/ace-step/ACE-Step-1.5/issues/926
13. https://arxiv.org/abs/2602.00744 (paper); https://github.com/ace-step/ACE-Step-1.5/issues/450
14. https://huggingface.co/ACE-Step/Ace-Step1.5 (and /tree/main)
15. https://huggingface.co/ACE-Step/acestep-v15-base
16. https://huggingface.co/ACE-Step/acestep-v15-sft
17. https://huggingface.co/ACE-Step/acestep-v15-xl-base
18. https://huggingface.co/api/models?author=ACE-Step&limit=50
19. https://huggingface.co/ACE-Step/ACE-Step-v1.5-chinese-new-year-LoRA
20. https://huggingface.co/api/models?search=acestep%20lora&limit=100 (plus the queries "ace-step lora", "acestep-v15", "ace-step-1.5"; 221 non-official repos deduplicated)
21. https://github.com/ace-step/ACE-Step-DAW
22. https://github.com/ace-step/acestep.vst3
23. https://github.com/ServeurpersoCom/acestep.cpp
24. https://raw.githubusercontent.com/ServeurpersoCom/acestep.cpp/master/docs/ARCHITECTURE.md
25. https://raw.githubusercontent.com/ServeurpersoCom/acestep.cpp/master/LICENSE
26. https://huggingface.co/Serveurperso/ACE-Step-1.5-GGUF
27. https://www.serveurperso.com/temp/acestep.cpp-win64/build/Release/
28. https://huggingface.co/ACE-Step/ACE-Step-v1-chinese-rap-LoRA

**Singing synthesis**

30. https://github.com/openvpi/DiffSinger
31. https://github.com/openvpi/DiffSinger/blob/main/docs/BestPractices.md
32. https://github.com/openvpi/DiffSinger/blob/main/docs/GettingStarted.md
33. https://github.com/openvpi/vocoders (repo licence)
34. https://github.com/openvpi/vocoders/releases, plus `NOTICE.txt` and `STATEMENTS.txt` inside `pc_nsf_hifigan_44.1k_hop512_128bin_2025.02.zip`
35. https://openvpi.github.io/vocoders/
36. https://github.com/openvpi/vocoders/issues/4#issuecomment-5978151355; https://github.com/openvpi/DiffSinger/issues/336#issuecomment-5978146210
37. https://github.com/openvpi/SingingVocoders
38. https://github.com/openvpi/MakeDiffSinger
39. https://github.com/openvpi/MakeDiffSinger/wiki/Public-Datasets
40. https://github.com/qiuqiao/SOFA
41. https://github.com/openutau/OpenUtau
42. https://github.com/openutau/OpenUtau/blob/master/OpenUtau.Core/DiffSinger/DiffSingerConfig.cs
43. https://github.com/openutau/OpenUtau/commit/9a2bc125d242a2a687dc18267e3e770bdba7fb9b (the DirectML pin to 1.23.0, 2026-09-24)
44. https://huggingface.co/nvidia/bigvgan_v2_44khz_128band_512x
45. https://github.com/nnsvs/nnsvs; https://github.com/nnsvs/nnsvs/blob/master/nnsvs/pretrained/__init__.py
46. https://github.com/Soul-AILab/SoulX-Singer (README, LICENSE, `preprocess/tools/g2p.py`)
47. https://huggingface.co/Soul-AILab/SoulX-Singer (tag, file list, `config.yaml`)
48. https://arxiv.org/abs/2602.07803
49. https://github.com/ASLP-lab/YingMusic-Singer-Plus (README, LICENSE, LICENSE-STABILITY)
50. https://huggingface.co/amphion/Vevo2; https://huggingface.co/amphion/Vevo1.5
51. https://github.com/AaronZ345/TCSinger
52. https://github.com/gwx314/TechSinger; https://arxiv.org/html/2502.12572v1
53. https://github.com/AaronZ345/StyleSinger
54. https://huggingface.co/spaces/tencent/SongGeneration/blob/main/LICENSE
55. https://github.com/ASLP-lab/DiffRhythm2; https://huggingface.co/ASLP-lab/DiffRhythm2
56. https://github.com/FunAudioLLM/InspireMusic
57. https://diffsinger.miraheze.org/wiki/Hanami_Hoshino; https://github.com/lottev1991/LotteV-Voicebank-Update-Repo (LICENSE-voicebank, LICENSE-vocoder, ToU_EN.md)
58. https://diffsinger.miraheze.org/wiki/TIGER, /Miyo, /Canary, /Laru_Mine, /Ritsu_Namine
59. https://www.canon-voice.com/terms/
60. https://github.com/Archivoice/ACV-001; https://github.com/Archivoice/ACV-002
61. https://github.com/lottev1991/Project-AIdol-Public-English-Dataset
62. https://zenodo.org/records/1193957 (VocalSet); https://zenodo.org/records/7061507 (Annotated-VocalSet)
63. https://github.com/AaronZ345/GTSinger/blob/main/dataset_license.md; https://github.com/M4Singer/M4Singer/blob/master/dataset_license.md; https://wenet-e2e.github.io/opencpop/liscense/; https://zenodo.org/records/4785016; https://arxiv.org/html/2401.17619v2
64. https://github.com/oatsu-gh/ENUNU

**Commissioning**

65. https://ar5iv.labs.arxiv.org/html/2105.02446 (DiffSinger paper: "1 NVIDIA V100", 16 h + 12 h, PopCS 5.89 h)
66. https://sites.google.com/view/utadroids/commissions/diffsinger-voicebank
67. https://diffsinger.miraheze.org/wiki/Miyo
68. https://www.runpod.io/pricing
69. https://completemusicupdate.com/sag-aftra-says-clear-and-conspicuous-consent-required-for-vocal-clones-as-part-of-groundbreaking-new-agreement-with-labels/ (trade press on the 2024 SAG-AFTRA Sound Recordings Code)

**Voice conversion, safeguards and law**

70. https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI; https://raw.githubusercontent.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/main/docs/en/README.en.md
71. https://huggingface.co/lj1995/VoiceConversionWebUI (and /tree/main/pretrained_v2)
72. https://huggingface.co/datasets/CSTR-Edinburgh/vctk
73. https://github.com/auspicious3000/contentvec
74. https://github.com/yxlllc/RMVPE; https://github.com/Dream-High/RMVPE
75. https://huggingface.co/facebook/hubert-base-ls960; https://github.com/facebookresearch/fairseq/blob/main/LICENSE
76. https://huggingface.co/microsoft/wavlm-large; https://raw.githubusercontent.com/microsoft/UniSpeech/main/LICENSE
77. https://github.com/IAHispano/Applio (README, LICENSE, commit history of LICENSE, TERMS_OF_USE.md)
78. https://github.com/svc-develop-team/so-vits-svc
79. https://github.com/voicepaw/so-vits-svc-fork
80. https://github.com/yxlllc/DDSP-SVC
81. https://github.com/prophesier/diff-svc
82. https://github.com/Plachtaa/seed-vc; https://huggingface.co/Plachta/Seed-VC
83. https://github.com/GiantAILab/YingMusic-SVC; https://huggingface.co/GiantAILab/YingMusic-SVC
84. https://huggingface.co/amphion/Vevo
85. https://huggingface.co/fierce-cats/beatrice-trainer; https://prj-beatrice.com/; https://huggingface.co/datasets/reazon-research/reazonspeech
86. https://github.com/ASLP-lab/MeanVC2; https://huggingface.co/ASLP-lab/MeanVC2
87. https://github.com/resemble-ai/chatterbox; https://github.com/resemble-ai/Perth
88. https://github.com/myshell-ai/OpenVoice
89. https://github.com/bshall/knn-vc; https://github.com/OlaWod/FreeVC
90. https://github.com/w-okada/voice-changer
91. https://github.com/ayutaz/LeapSVC
92. https://github.com/ShawnPi233/HQ-SVC; https://huggingface.co/shawnpi/HQ-SVC
93. https://github.com/facebookresearch/audioseal; https://huggingface.co/facebook/audioseal
94. https://github.com/resemble-ai/Perth
95. https://github.com/contentauth/c2pa-rs (docs/supported-formats.md)
96. https://elevenlabs.io/docs/product-guides/voices/voice-cloning/professional-voice-cloning; https://elevenlabs.io/docs/help-center/legal/what-are-no-go-voices
97. https://www.resemble.ai/our-commitment-to-consent
98. https://dreamtonics.rockpaperscissors.biz/dispatch/pu/29346
99. https://www.kits.ai/terms-of-service
100. https://www.capitol.tn.gov/Bills/113/Bill/HB2091.pdf (Tennessee ELVIS Act)
101. https://www.hklaw.com/en/insights/publications/2026/06/senate-judiciary-committee-advances-legislation-to-protect-name; https://www.bytebacklaw.com/2026/08/a-federal-shift-in-ai-and-the-right-of-publicity-no-fakes-act-advances-in-congress/ (secondary)
102. https://artificialintelligenceact.eu/article/50/; https://www.bakerbotts.com/thought-leadership/publications/2026/september/eu-ai-act-article-50-transparency-obligations-go-live (secondary)

**Cloud**

103. https://www.digitalmusicnews.com/2026/07/03/suno-is-opening-an-api-partner-program/ (secondary)
104. https://help.suno.com/en/articles/6882817; https://help.suno.com/en/articles/13925185
105. https://suno.com/terms; https://suno.com/blog/introducing-v6; https://suno.com/blog/suno-updates-tos
106. https://www.udio.com/blog/a-new-era; https://www.musegen.ai/blog/udio-review-2026 (secondary)
107. https://elevenlabs.io/docs/api-reference/music/compose; https://elevenlabs.io/docs/eleven-api/guides/how-to/music/composition-plans.md; https://elevenlabs.io/docs/api-reference/music/upload.md; https://elevenlabs.io/docs/eleven-api/guides/how-to/music/inpainting.md; https://elevenlabs.io/docs/api-reference/music/separate-stems
108. https://elevenlabs.io/music-terms; https://elevenlabs.io/pricing/api
109. https://ai.google.dev/gemini-api/docs/music-generation; https://ai.google.dev/gemini-api/docs/pricing; https://ai.google.dev/gemini-api/terms
110. https://platform.minimax.io/docs/guides/pricing-paygo
111. https://stability.ai/explainers/ai-music-stems-and-audio-inpainting-generating-parts-instead-of-finished-songs
112. https://platform.mureka.ai/docs/ (embedded OpenAPI spec: `TrackGenerateReq`, `SongStemReq`; files upload); https://platform.mureka.ai/service_terms.pdf; https://platform.mureka.ai/docs/en/faq.html
113. https://docs.musicgpt.com/api-documentation/conversions/sing_over_instrumental.md; https://docs.musicgpt.com/api-documentation/index/pricing.md; https://musicgpt.com/terms-of-service
114. https://kits.ai/api; https://docs.kits.ai/api-reference/introduction/quick-start
115. https://acestudio.ai/; https://acestudio.ai/pricing/
116. https://resource.dreamtonics.com/scripting/

**Krypt Studio (this repo)**
- `engine/crates/analyzer/Cargo.toml`: `ort` 2.0.0-rc.13 with `api-24`, loading Microsoft.ML.OnnxRuntime.DirectML 1.24.4.
- `shared/analyzer/models.ts`: the model catalog, with a SHA-256 for every file.
- `engine/crates/dsp/src/effects/pitch.rs`: Krypt Tune.
