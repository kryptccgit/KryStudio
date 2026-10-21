# Research prototypes (2026-10-11)

Throwaway code written by the research agents, kept as the starting point for the Phase 0 spikes.
See `../../research/00-SYNTHESIS.md` §6.

| Folder | What it is | Report |
|---|---|---|
| `hello-sine/` | A Rust sidecar (`cpal` WASAPI, 48 kHz) with a JSON command loop, plus `engineSupervisor.ts` (spawn, restart, Job Object cleanup). It builds with `cargo build --release` from `engine/`. | 07 §7 |
| `kpn/` | A prototype parser for KPN (Krypt Pattern Notation), with examples: `node kpn/kpn.mjs kpn/ex1.kpn` | 04 §10 |
| `cpalprobe/` | Measures the buffer and callback sizes that cpal's WASAPI path actually delivers | 02 §2.1 |
| `ac3probe/` | An IAudioClient3 low-latency shared-mode probe | 02 §2.1 |
| `latency-bench/` | A Chrome Web Audio latency page and a Node named-pipe round-trip benchmark | 02 §2.1, §5.3 |

Build products (`target/`) are not committed. Set `CARGO_TARGET_DIR` outside the repo, or add a `.gitignore`, before building.
