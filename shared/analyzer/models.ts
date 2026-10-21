// On-device ML models known to Krypt Studio (Model Manager).
//
// Licences follow research/04 §9: bundle only permissive code+weights;
// everything large is an opt-in download with its licence shown and every
// file SHA-256-verified before use. Bundled models live in
// resources/models/<id>/ (copied by scripts/engine-build.mjs); downloaded
// ones in userData/models/<id>/.

import type { StemName } from './protocol';

export type ModelTask = 'stems' | 'transcribe' | 'beats' | 'tts';

export interface ModelFile {
  /** File name inside the model directory. */
  name: string;
  /** Download URL (empty for bundled models). */
  url: string;
  /** Other URLs serving the identical file, tried in order when `url` fails (network, HTTP error or hash mismatch). */
  mirrors?: string[];
  /** Lowercase hex SHA-256 of the file. */
  sha256: string;
  bytes: number;
}

export interface ModelDef {
  id: string;
  name: string;
  task: ModelTask;
  description: string;
  license: {
    /** SPDX-ish name, e.g. 'MIT', 'Apache-2.0'. */
    name: string;
    url: string;
    /** Caveat shown before download (e.g. training-data terms). */
    notice?: string;
  };
  /** Ships in the installer; cannot be removed. */
  bundled: boolean;
  files: ModelFile[];
  /** The model a task uses when none is named. */
  default?: boolean;
  /** stems: what this model separates into. */
  stems?: StemName[];
  /** Shown in the UI, e.g. '~20 s per minute of audio on CPU, ~2 s on GPU'. */
  speed?: string;
}

// An entry with an empty sha256 is not installable; one with a sha256 but no
// url can only be installed from a folder (Model Manager → Install from folder).
export const MODEL_CATALOG: readonly ModelDef[] = [
  {
    id: 'basic-pitch',
    name: 'Basic Pitch',
    task: 'transcribe',
    description: 'Polyphonic audio → notes (Spotify). Tiny and faster than real time on any CPU.',
    // ICASSP 2022 model, ONNX as published in spotify/basic-pitch
    // (basic_pitch/saved_models/icassp_2022/nmp.onnx). Code and weights
    // Apache-2.0; LICENSE + NOTICE ship beside it.
    license: { name: 'Apache-2.0', url: 'https://github.com/spotify/basic-pitch/blob/main/LICENSE' },
    bundled: true,
    files: [{ name: 'nmp.onnx', url: '', sha256: '2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec', bytes: 230444 }],
    default: true,
    speed: '~1 s per minute of audio on CPU',
  },
  {
    // Beat This! (CPJKU, ISMIR 2024) "small1" checkpoint as ONNX from
    // danigb/beat-this-rs (models/), plus that project's log-mel front end.
    // Code and published weights MIT; LICENSE ships beside them.
    id: 'beat-this-small',
    name: 'Beat This! (small)',
    task: 'beats',
    description: 'Beat and downbeat tracking (JKU Linz). Used by audio analysis; without it, analysis falls back to DSP beat tracking.',
    license: {
      name: 'MIT',
      url: 'https://github.com/CPJKU/beat_this/blob/main/LICENSE',
      notice: 'Code and weights are MIT-licensed. Some of the training audio is copyrighted or under limited Creative Commons licences (per the Beat This! authors).',
    },
    bundled: true,
    files: [
      { name: 'beat_this_small.onnx', url: '', sha256: 'a5f8d39d989f31859454ba27afe61c5317ca95e4d9373e6853e5361b8937172f', bytes: 10555592 },
      { name: 'mel_spectrogram.onnx', url: '', sha256: 'fdd59e65c515331308e4c8841edf99972deca646bdf6197744c2a5b7755e3de9', bytes: 270742 },
    ],
    default: true,
    speed: '~2 s per minute of audio on CPU',
  },
  {
    // Meta's HT-Demucs v4 as the forward-only ONNX export published by the
    // WebNN project, pinned to one revision. Provenance, hashes and the
    // DirectML workarounds: scripts/models/README.md.
    id: 'htdemucs',
    name: 'HT-Demucs (4 stems)',
    task: 'stems',
    description: 'Splits a mix into drums, bass, vocals and other. Meta\'s Hybrid Transformer Demucs v4, the standard open separator.',
    license: {
      name: 'MIT',
      url: 'https://huggingface.co/webnn/stem-separator/blob/b56f9e66ceffca2401f83d2469dadaddd06e4994/LICENSE.md',
      notice:
        'Code and weights are MIT-licensed (Meta\'s HT-Demucs v4, converted to ONNX by the WebNN project). The weights were trained on MUSDB18-HQ plus 800 songs from Meta\'s catalogue. MUSDB18\'s terms are research-oriented, and the legal status of models trained on it is unsettled.',
    },
    bundled: false,
    files: [
      {
        name: 'htdemucs_fwd.onnx',
        url: 'https://huggingface.co/webnn/stem-separator/resolve/b56f9e66ceffca2401f83d2469dadaddd06e4994/onnx/htdemucs_fwd.onnx',
        sha256: '555f511fb653348a1c9495ab6b6091767d1920798f3fba68629a1fe5b135a45f',
        bytes: 2385507,
      },
      {
        // Must keep this exact name: the graph refers to it.
        name: 'htdemucs_fwd.onnx.data',
        url: 'https://huggingface.co/webnn/stem-separator/resolve/b56f9e66ceffca2401f83d2469dadaddd06e4994/onnx/htdemucs_fwd.onnx.data',
        sha256: '23a7c68669c041363caaef94641e961dc8c4e16b9891cb87f58f0e199a5e8820',
        bytes: 168361984,
      },
    ],
    default: true,
    stems: ['drums', 'bass', 'other', 'vocals'],
    speed: '~25 s per minute of audio on an 8-core CPU, ~6 s on a DirectX 12 GPU',
  },
  {
    // Krypt Voice local engine (research/21). Kokoro-82M v1.0 (hexgrad, Apache-2.0) as the ONNX
    // export published by onnx-community, pinned to one revision: the fp32 graph (3x faster than
    // the int8 one on CPU) plus the 28 English voice style tables. Files sit flat in the model
    // folder (<voice>.bin). The analyzer's G2P uses the CMU Pronouncing Dictionary built into
    // krypt-studio-analyzer.exe (BSD-style; no eSpeak / GPL). Hashes: scripts/models/README.md.
    id: 'kokoro',
    name: 'Kokoro (Krypt Voice)',
    task: 'tts',
    description: 'Text to speech on your own PC for Krypt Voice: 28 English voices (US and UK), offline and free. Also the voice behind "Sing my notes".',
    license: {
      name: 'Apache-2.0',
      url: 'https://huggingface.co/hexgrad/Kokoro-82M/blob/f3ff3571791e39611d31c381e3a41a3af07b4987/README.md',
      notice:
        'Weights and voices are Apache-2.0 (Kokoro-82M by hexgrad; ONNX conversion by onnx-community). Per its authors, Kokoro was trained only on permissive or non-copyrighted audio: public-domain and permissively licensed recordings plus synthetic speech from commercial TTS services. English only in Krypt Studio for now.',
    },
    bundled: false,
    files: [
      { name: 'model.onnx', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model.onnx', sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb', bytes: 325532232 },
      { name: 'af_heart.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_heart.bin', sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b', bytes: 522240 },
      { name: 'af_bella.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_bella.bin', sha256: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b', bytes: 522240 },
      { name: 'af_nicole.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_nicole.bin', sha256: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a', bytes: 522240 },
      { name: 'af_aoede.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_aoede.bin', sha256: '4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361', bytes: 522240 },
      { name: 'af_kore.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_kore.bin', sha256: '9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e', bytes: 522240 },
      { name: 'af_sarah.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_sarah.bin', sha256: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a', bytes: 522240 },
      { name: 'af_alloy.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_alloy.bin', sha256: 'c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45', bytes: 522240 },
      { name: 'af_nova.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_nova.bin', sha256: '18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f', bytes: 522240 },
      { name: 'af_sky.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_sky.bin', sha256: '4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9', bytes: 522240 },
      { name: 'af_jessica.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_jessica.bin', sha256: 'a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8', bytes: 522240 },
      { name: 'af_river.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_river.bin', sha256: '00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30', bytes: 522240 },
      { name: 'am_michael.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/am_michael.bin', sha256: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1', bytes: 522240 },
      { name: 'am_fenrir.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/am_fenrir.bin', sha256: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43', bytes: 522240 },
      { name: 'am_puck.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/am_puck.bin', sha256: 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0', bytes: 522240 },
      { name: 'am_echo.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/am_echo.bin', sha256: '3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3', bytes: 522240 },
      { name: 'am_eric.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/am_eric.bin', sha256: 'e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832', bytes: 522240 },
      { name: 'am_liam.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/am_liam.bin', sha256: '52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade', bytes: 522240 },
      { name: 'am_onyx.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/am_onyx.bin', sha256: 'da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6', bytes: 522240 },
      { name: 'am_adam.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/am_adam.bin', sha256: '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716', bytes: 522240 },
      { name: 'am_santa.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/am_santa.bin', sha256: '61150cf726ab6c5ed7a99f90a304f91f5a72c00c592e89ec94e5df11c319227a', bytes: 522240 },
      { name: 'bf_emma.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/bf_emma.bin', sha256: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73', bytes: 522240 },
      { name: 'bf_isabella.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/bf_isabella.bin', sha256: '3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f', bytes: 522240 },
      { name: 'bf_alice.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/bf_alice.bin', sha256: '08afa6ba24da61ea5e8efa139e5aadc938d83f0a6da5a900adaf763ac1da5573', bytes: 522240 },
      { name: 'bf_lily.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/bf_lily.bin', sha256: '5e0ee32ebe64a467124976b14e69590746f1c4ce41a12b587a50c862edfea335', bytes: 522240 },
      { name: 'bm_george.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/bm_george.bin', sha256: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc', bytes: 522240 },
      { name: 'bm_fable.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/bm_fable.bin', sha256: 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1', bytes: 522240 },
      { name: 'bm_lewis.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/bm_lewis.bin', sha256: 'b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97', bytes: 522240 },
      { name: 'bm_daniel.bin', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/bm_daniel.bin', sha256: '6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8', bytes: 522240 },
    ],
    default: true,
    speed: '~2.5x faster than real time on an 8-core CPU (a 4 s line in ~1.5 s)',
  },
];

/** The voices the `kokoro` package installs (`<voice>.bin`), best-rated first. a* = US English, b* = UK English. */
export const KOKORO_VOICES: ReadonlyArray<{ id: string; name: string; description: string }> = [
  { id: 'af_heart', name: 'Heart', description: 'US English · female · warm (best)' },
  { id: 'af_bella', name: 'Bella', description: 'US English · female · bright' },
  { id: 'af_nicole', name: 'Nicole', description: 'US English · female · soft, close' },
  { id: 'af_aoede', name: 'Aoede', description: 'US English · female' },
  { id: 'af_kore', name: 'Kore', description: 'US English · female' },
  { id: 'af_sarah', name: 'Sarah', description: 'US English · female' },
  { id: 'af_alloy', name: 'Alloy', description: 'US English · female' },
  { id: 'af_nova', name: 'Nova', description: 'US English · female' },
  { id: 'af_sky', name: 'Sky', description: 'US English · female' },
  { id: 'af_jessica', name: 'Jessica', description: 'US English · female' },
  { id: 'af_river', name: 'River', description: 'US English · female' },
  { id: 'am_michael', name: 'Michael', description: 'US English · male' },
  { id: 'am_fenrir', name: 'Fenrir', description: 'US English · male · deep' },
  { id: 'am_puck', name: 'Puck', description: 'US English · male · lively' },
  { id: 'am_echo', name: 'Echo', description: 'US English · male' },
  { id: 'am_eric', name: 'Eric', description: 'US English · male' },
  { id: 'am_liam', name: 'Liam', description: 'US English · male' },
  { id: 'am_onyx', name: 'Onyx', description: 'US English · male · low' },
  { id: 'am_adam', name: 'Adam', description: 'US English · male' },
  { id: 'am_santa', name: 'Santa', description: 'US English · male · jolly' },
  { id: 'bf_emma', name: 'Emma', description: 'UK English · female' },
  { id: 'bf_isabella', name: 'Isabella', description: 'UK English · female' },
  { id: 'bf_alice', name: 'Alice', description: 'UK English · female' },
  { id: 'bf_lily', name: 'Lily', description: 'UK English · female' },
  { id: 'bm_george', name: 'George', description: 'UK English · male' },
  { id: 'bm_fable', name: 'Fable', description: 'UK English · male' },
  { id: 'bm_lewis', name: 'Lewis', description: 'UK English · male' },
  { id: 'bm_daniel', name: 'Daniel', description: 'UK English · male' },
];

export function modelById(id: string): ModelDef | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

export function defaultModel(task: ModelTask): ModelDef | undefined {
  return MODEL_CATALOG.find((m) => m.task === task && m.default) ?? MODEL_CATALOG.find((m) => m.task === task);
}
