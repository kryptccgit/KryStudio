// Upright piano: sampled by Simon Dalzell (Ivy Audio) for Versilian Studios' VS Chamber Orchestra 2: Community
// Edition (CC0 1.0), pinned to a commit of github.com/sgossner/VSCO-2-CE. Three dynamics, every major third from A0
// (the upstream MappingChart.txt: file index n sounds at MIDI 21 + 2n, the last file at 108). WAV files; our mapping
// peak-normalises each dynamic, skips leading silence and trims the long bass notes with a fade.

import { melodic, type InstrumentSpec, type PackSpec, type SampleRef, type Zone } from '../lib';

const SHA = '440300901dfe9275fd84e0b7763af1f8443ae62e';
const INDICES = Array.from({ length: 23 }, (_, i) => i * 2); // 000, 002 … 044
const rootOf = (n: number) => (n === 44 ? 108 : 21 + 2 * n);
const file = (dyn: number, n: number) => `Player_dyn${dyn}_rr1_${String(n).padStart(3, '0')}.wav`;

const samples: SampleRef[] = [];
const zones: Zone[] = [];
for (const dyn of [1, 2, 3]) {
  for (const n of INDICES) {
    const f = file(dyn, n);
    samples.push({ src: `Keys/Upright Piano/${f}`, path: `samples/${f}` });
    zones.push({ sample: f, root: rootOf(n), layer: dyn - 1 });
  }
}

function keepSeconds(root: number): number {
  if (root < 36) return 16;
  if (root < 48) return 14;
  if (root < 60) return 12;
  if (root < 72) return 10;
  if (root < 84) return 8;
  if (root < 96) return 6;
  return 4;
}

const credit = 'the VSCO 2 Community Edition upright piano (Simon Dalzell / Ivy Audio for Versilian Studios, CC0)';

function upright(path: string, title: string, layers: { lovel: number; hivel: number; peakDb: number; from: number }[], veltrack: number): InstrumentSpec {
  return {
    path,
    keys: { lo: 21, hi: 108 },
    build: (ctx) => ({
      title: `${title} Krypt Studio mapping of ${credit}.`,
      control: { default_path: 'samples/' },
      global: { amp_veltrack: veltrack, ampeg_attack: 0.002, ampeg_release: 0.45 },
      groups: [
        {
          opcodes: {},
          regions: melodic(
            ctx,
            zones.filter((z) => layers.some((l) => l.from === z.layer)).map((z) => ({ ...z, layer: layers.findIndex((l) => l.from === z.layer) })),
            { lo: 21, hi: 108, layers, keep: keepSeconds, fade: 1.2, skipSilenceMs: 3 },
          ),
        },
      ],
    }),
  };
}

export const UPRIGHT_PIANO: PackSpec = {
  id: 'upright-piano',
  base: `https://raw.githubusercontent.com/sgossner/VSCO-2-CE/${SHA}/`,
  mirrors: [`https://cdn.jsdelivr.net/gh/sgossner/VSCO-2-CE@${SHA}/`],
  samples,
  instruments: [
    upright(
      'upright.sfz',
      'Upright piano: 3 dynamics every major third.',
      [
        { lovel: 1, hivel: 56, peakDb: -16, from: 0 },
        { lovel: 57, hivel: 100, peakDb: -6, from: 1 },
        { lovel: 101, hivel: 127, peakDb: -1.5, from: 2 },
      ],
      55,
    ),
    upright('upright-soft.sfz', 'Soft upright: the quietest dynamic only, for felt-like lo-fi chords.', [{ lovel: 1, hivel: 127, peakDb: -12, from: 0 }], 40),
  ],
};
