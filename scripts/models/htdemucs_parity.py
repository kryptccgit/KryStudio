"""Compare Krypt Studio's HT-Demucs stems with the PyTorch reference.

The analyzer runs the published forward-only ONNX graph and does the STFT,
chunking and normalisation in Rust (engine/crates/analyzer/src/separate/).
This script runs the original model the way demucs' own CLI does with
`--shifts 0` (no random time shift, so the result is deterministic) and
prints how closely each stem agrees.

Setup (once, outside the repo; torch has no wheels for every Python):
    uv venv --python 3.12 .venv-demucs
    uv pip install --python .venv-demucs torch --index-url https://download.pytorch.org/whl/cpu
    uv pip install --python .venv-demucs numpy soundfile einops julius pyyaml openunmix dora-search
    uv pip install --python .venv-demucs --no-deps demucs==4.0.1

Usage:
    python htdemucs_parity.py <mix.wav (44.1 kHz)> <analyzer stem dir> [<ref out dir>]

The first run downloads Meta's checkpoint 955717e8-8726e21a.th (80 MB) into
the torch hub cache. Measured agreement (2026-10-11, 20 s test mix): 84-97 dB
per stem on CPU and 96-128 dB on DirectML, i.e. float rounding only.
"""
import os
import sys

import numpy as np
import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model


def reference(mix_path: str, out_dir: str) -> None:
    model = get_model("htdemucs")
    model.eval()
    wav, sr = sf.read(mix_path, dtype="float32", always_2d=True)
    if sr != 44100:
        sys.exit(f"{mix_path}: {sr} Hz; use a 44.1 kHz file so both sides skip resampling")
    wav = torch.from_numpy(wav.T.copy())
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    ref = wav.mean(0)  # demucs/separate.py
    mean, std = ref.mean(), ref.std()
    with torch.no_grad():
        out = apply_model(model, ((wav - mean) / std)[None], shifts=0, split=True, overlap=0.25)[0]
    out = out * std + mean
    os.makedirs(out_dir, exist_ok=True)
    for i, name in enumerate(model.sources):
        sf.write(os.path.join(out_dir, f"{name}.wav"), out[i].numpy().T, sr, subtype="FLOAT")


def compare(ref_dir: str, est_dir: str) -> None:
    for stem in ("drums", "bass", "other", "vocals"):
        r, _ = sf.read(os.path.join(ref_dir, f"{stem}.wav"), dtype="float64", always_2d=True)
        e, _ = sf.read(os.path.join(est_dir, f"{stem}.wav"), dtype="float64", always_2d=True)
        if r.shape != e.shape:
            sys.exit(f"{stem}: shape {e.shape} differs from the reference {r.shape}")
        err = np.sum((r - e) ** 2)
        agreement = 10 * np.log10(np.sum(r**2) / max(err, 1e-30))
        print(f"{stem:7s} agreement {agreement:6.1f} dB   max |diff| {np.abs(r - e).max():.2e}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    mix, est = sys.argv[1], sys.argv[2]
    ref_out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(est, "_torch_reference")
    reference(mix, ref_out)
    compare(ref_out, est)
