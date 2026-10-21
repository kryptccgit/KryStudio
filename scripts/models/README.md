# scripts/models

Build-time helpers for the analyzer's on-device ML models and their runtime.

| File | What |
|---|---|
| `onnxruntime.mjs` | Downloads (SHA-256 pinned) and stages the ONNX Runtime DLLs next to `krypt-studio-analyzer.exe`. Called by `scripts/engine-build.mjs`; also runs standalone: `node scripts/models/onnxruntime.mjs --out <dir>`. |
| `htdemucs_parity.py` | Dev check: compares the analyzer's HT-Demucs stems with the PyTorch reference (see its docstring for setup). |
| `cmudict.mjs` | Rebuilds `engine/crates/analyzer/data/cmudict.txt.deflate` (the CMU Pronouncing Dictionary compiled into the analyzer for Krypt Voice's G2P) and its licence file, from cmusphinx/cmudict at a pinned commit, SHA-256 checked: `node scripts/models/cmudict.mjs`. |

## HT-Demucs (`htdemucs`)

We use the published **forward-only ONNX export** from the WebNN project, unchanged:

- Repo: <https://huggingface.co/webnn/stem-separator>, pinned to revision
  `b56f9e66ceffca2401f83d2469dadaddd06e4994`.
- Licence: MIT for the conversion (`LICENSE.md` in the repo) and for Meta's code and weights
  (facebookresearch/demucs). Source checkpoint: `htdemucs` v4, `955717e8-8726e21a.th`.
- Training data: MUSDB18-HQ plus 800 songs from Meta's catalogue. The catalog entry
  (`shared/analyzer/models.ts`) shows this as the licence notice.

| File | Bytes | SHA-256 |
|---|---|---|
| `htdemucs_fwd.onnx` | 2,385,507 | `555f511fb653348a1c9495ab6b6091767d1920798f3fba68629a1fe5b135a45f` |
| `htdemucs_fwd.onnx.data` | 168,361,984 | `23a7c68669c041363caaef94641e961dc8c4e16b9891cb87f58f0e199a5e8820` |

The graph holds only `HTDemucs.fwd(x, xt)`. The analyzer does the rest in Rust (STFT/iSTFT,
normalisation, chunking with overlap-add, resampling); see `engine/crates/analyzer/src/separate/`.

Two load-time workarounds make it run on DirectML (both are in the analyzer, so the file stays
byte-identical and its hash still verifies):

1. The exporter wrote `output_padding=[0]` on the 1-D `ConvTranspose` nodes. DirectML rejects
   that ("The parameter is incorrect"), so the analyzer strips all-zero `output_padding` before
   creating the session. This has no effect on the maths: zero is the default.
2. DirectML's graph fusion computes this graph wrongly (outputs off by about 1e5), so the
   DirectML session sets `ep.dml.disable_graph_fusion=1`. Per-node DirectML kernels are exact,
   and just as fast here.

Mirrors: a catalog file can list `mirrors` (identical bytes, tried in order when the primary URL fails, every one SHA-256-verified). None are published yet; a Krypt-hosted copy (e.g. a GitHub release) only needs its URLs added to the `htdemucs` entry in `shared/analyzer/models.ts`.

Other published exports we checked (2026-10-11):

- `StemSplitio/htdemucs-onnx` (MIT, STFT inside the graph as convolutions, 166–316 MB). It runs
  out of GPU memory on DirectML (10 GB card), and is slower on CPU.
- `smank/htdemucs-onnx` (MIT, Mixxx GSoC export, STFT inside the graph, 304 MB). Not needed.

## ONNX Runtime DLLs (staged by `onnxruntime.mjs`)

| DLL | Source | Licence |
|---|---|---|
| `onnxruntime.dll` | NuGet `Microsoft.ML.OnnxRuntime.DirectML` 1.24.4 | MIT (+ `onnxruntime-ThirdPartyNotices.txt`) |
| `DirectML.dll` | NuGet `Microsoft.AI.DirectML` 1.15.4 | Microsoft Software License Terms (redistributable with an app; not open source). Shipped by default: GPU separation is ~4× faster. `KRYPT_NO_DIRECTML=1` builds a CPU-only package. |
| `vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll`, `msvcp140_1.dll` | The VC++ redist folder of the local Visual Studio or Build Tools | Microsoft Visual C++ Redistributable (app-local "Distributable Code") |

1.24.4 is the last ONNX Runtime with a DirectML build; Microsoft moved new Windows GPU work to
WinML. The `ort` crate is pinned to the matching C API (`api-24`). Unlike our own exes,
`onnxruntime.dll` uses the dynamic VC++ runtime, which is why the four CRT DLLs ship app-local.

## Kokoro (`kokoro`, Krypt Voice)

Text to speech for Krypt Voice's local engine (research/21). We use the published ONNX export, unchanged:

- Repo: <https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX>, pinned to revision
  `1939ad2a8e416c0acfeecc08a694d14ef25f2231`. Its model card says Apache-2.0.
- Upstream: Kokoro-82M v1.0 by hexgrad, <https://huggingface.co/hexgrad/Kokoro-82M> (revision
  `f3ff3571791e39611d31c381e3a41a3af07b4987`): Apache-2.0 weights; the voices are part of the same repo and
  licence. Per the authors, it was trained only on permissive or non-copyrighted audio (public domain,
  Apache/MIT-licensed recordings, and synthetic speech from closed commercial TTS models). The catalog notice says so.
- Files (flat in the model folder): `onnx/model.onnx` (fp32), saved as `model.onnx`, plus the 28 English voices
  `voices/<id>.bin` saved as `<id>.bin`. The SHA-256 of every file equals the Hugging Face LFS object id and was
  re-checked on download; all 29 are listed in `shared/analyzer/models.ts`.

| File | Bytes | SHA-256 |
|---|---|---|
| `model.onnx` | 325,532,232 | `8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb` |
| `af_heart.bin` (one of the 28 voices, all the same size) | 522,240 | `d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b` |

Why fp32: on an i7-10700K it runs at ~0.37× real time, while `model_quantized.onnx` (int8, 92 MB) runs at ~1.1×
(dynamic quantisation is slow in ONNX Runtime's CPU EP). `model_fp16.onnx` keeps the durations in float16 (the
analyzer exposes them as float32). DirectML can't run either graph (ONNX Runtime 1.24 rejects the grouped
upsampling `ConvTranspose`), so `tts` runs on the CPU.

Load-time change (the file stays byte-identical): the analyzer appends a graph output for the predicted durations
(the `Round` → `Clip` tensor) so it can return word timings.

G2P: no eSpeak (GPL). English text goes through the CMU Pronouncing Dictionary (BSD-style, compiled into the exe,
see `cmudict.mjs`), then suffix / compound rules and Krypt's own letter-to-sound rules, then a mapping onto the
misaki US phoneme set Kokoro was trained on (`engine/crates/analyzer/src/tts/g2p.rs`).
