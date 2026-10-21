// Grand piano: Salamander Grand Piano V3 by Alexander Holm (public domain since 4 March 2022; the author's
// statement is archived in shared/packs/catalog.ts). Files come from the sfzinstruments mirror of V3 (48 kHz /
// 24-bit stereo FLAC, two AKG C414 in AB above the strings), pinned to a commit.
//
// Upstream: 16 velocity layers sampled every minor third from A0 (A0, C1, D#1, F#1 … A7, C8) plus a chromatic
// key-release (hammer / damper) sample per key. We use 5 of the 16 layers, every minor third, plus the release
// samples: about 230 MB to download, and trims that keep the loaded instrument near 210 MB.

import { keySplits, type InstrumentSpec, type Opcodes, type PackSpec, type SampleRef, type SfzGroup } from '../lib';

const SHA = '3382bf9496bba2486f5ab0de55a264d1dfc38404';

/** Sampled notes (scientific pitch, C4 = 60) → MIDI. */
const NOTES: [string, number][] = [];
{
  const names = ['A', 'C', 'D#', 'F#'];
  for (let midi = 21, i = 0; midi <= 108; midi += 3, i++) {
    const name = names[i % 4];
    const octave = Math.floor((midi - 12) / 12);
    NOTES.push([`${name}${octave}`, midi]);
  }
}

/** Upstream layer → our velocity band (hard switches; timbre comes from the layer, loudness also from amp_veltrack). */
const LAYERS: { v: number; lovel: number; hivel: number }[] = [
  { v: 3, lovel: 1, hivel: 40 },
  { v: 6, lovel: 41, hivel: 64 },
  { v: 9, lovel: 65, hivel: 88 },
  { v: 12, lovel: 89, hivel: 108 },
  { v: 15, lovel: 109, hivel: 127 },
];
const SOFT_LAYERS: { v: number; lovel: number; hivel: number }[] = [
  { v: 3, lovel: 1, hivel: 80 },
  { v: 6, lovel: 81, hivel: 127 },
];

const safe = (name: string) => name.replace('#', 's');
const notePath = (name: string, v: number) => `samples/${safe(name)}v${v}.flac`;
const relPath = (k: number) => `samples/rel${k - 20}.flac`;

/** Seconds kept per note: long bass strings ring longest. */
function keepSeconds(midi: number): number {
  if (midi < 36) return 12;
  if (midi < 48) return 10;
  if (midi < 60) return 8.5;
  if (midi < 72) return 7;
  if (midi < 84) return 5.5;
  if (midi < 96) return 4;
  return 3;
}
const FADE = 1.2;
/** Strings from F#6 up have no dampers: they ring after the key is released. */
const UNDAMPED_FROM = 90;

const samples: SampleRef[] = [];
for (const L of LAYERS) for (const [name] of NOTES) samples.push({ src: `Samples/${name}v${L.v}.flac`, path: notePath(name, L.v) });
for (let k = 21; k <= 108; k++) samples.push({ src: `Samples/rel${k - 20}.flac`, path: relPath(k) });

function piano(path: string, title: string, layers: typeof LAYERS, veltrack: number, release: number): InstrumentSpec {
  return {
    path,
    keys: { lo: 21, hi: 108 },
    build: (ctx) => {
      const splits = keySplits(
        NOTES.map(([, m]) => m),
        21,
        108,
      );
      const groups: SfzGroup[] = layers.map((L) => ({
        comment: `velocity ${L.lovel}-${L.hivel}: upstream layer v${L.v}`,
        opcodes: { lovel: L.lovel, hivel: L.hivel },
        regions: splits.map((s) => {
          const [name] = NOTES.find(([, m]) => m === s.root)!;
          const p = notePath(name, L.v);
          const f = ctx.facts(p);
          const keep = keepSeconds(s.root);
          const r: Opcodes = { sample: p.slice('samples/'.length), lokey: s.lokey, hikey: s.hikey, pitch_keycenter: s.root };
          if (f.frames / f.rate > keep) {
            r.end = ctx.endFor(p, keep);
            r.ampeg_hold = keep - FADE;
            r.ampeg_decay = FADE;
            r.ampeg_sustain = 0;
          }
          if (s.root >= UNDAMPED_FROM) r.ampeg_release = 2.5;
          return r;
        }),
      }));
      groups.push({
        comment: 'key release: the damper and hammer noise, one sample per key, quieter the longer the note was held',
        opcodes: { trigger: 'release', volume: -33, amp_veltrack: 80, rt_decay: 2, ampeg_attack: 0.002, ampeg_release: 0.2 },
        regions: Array.from({ length: 88 }, (_, i) => {
          const k = 21 + i;
          return { sample: relPath(k).slice('samples/'.length), lokey: k, hikey: k, pitch_keycenter: k };
        }),
      });
      return {
        title,
        control: { default_path: 'samples/' },
        global: { amp_veltrack: veltrack, ampeg_attack: 0.002, ampeg_release: release },
        groups,
      };
    },
  };
}

export const GRAND_PIANO: PackSpec = {
  id: 'grand-piano',
  base: `https://raw.githubusercontent.com/sfzinstruments/SalamanderGrandPiano/${SHA}/`,
  mirrors: [`https://cdn.jsdelivr.net/gh/sfzinstruments/SalamanderGrandPiano@${SHA}/`],
  samples,
  instruments: [
    piano('grand.sfz', 'Grand piano: 5 velocity layers every minor third + key-release noise. Krypt Studio mapping of Salamander Grand Piano V3 (Alexander Holm, public domain).', LAYERS, 65, 0.6),
    piano('soft-grand.sfz', 'Soft grand: the two softest layers only, for mellow chords. Krypt Studio mapping of Salamander Grand Piano V3 (Alexander Holm, public domain).', SOFT_LAYERS, 45, 0.5),
  ],
};
