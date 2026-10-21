// Keys & mallets: vibraphone (soft and hard mallets), marimba, glockenspiel and kalimba from the Versilian
// Community Sample Library (VCSL) by Versilian Studios, CC0 1.0, pinned to a commit of github.com/sgossner/VCSL.
// WAV files; our mapping peak-normalises each velocity layer, skips leading silence and keeps whole notes.
// Note names follow VCSL's convention (C3 = MIDI 60); the kalimba's per-tine tuning offsets are the measured cents
// VCSL publishes with its own mapping (a fact about the recording), checked against our pitch estimates.

import { melodic, noteIn, safeName, velLayers, type InstrumentSpec, type Opcodes, type PackSpec, type SampleRef, type Zone } from '../lib';

const SHA = 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e';

interface Source {
  dir: string;
  packDir: string;
  files: string[];
}

const VIBES_SOFT: Source = {
  dir: 'Idiophones/Struck Idiophones/Vibraphone/Soft Mallets',
  packDir: 'vibes',
  files: ['A2', 'A4', 'B3', 'C3', 'C5', 'D4', 'E3', 'E5', 'F2', 'F4', 'G3'].flatMap((n) => [`Vibes_soft_${n}_v1_${n === 'C3' || n === 'E3' ? 'rr2' : 'rr1'}_Main.wav`, `Vibes_soft_${n}_v2_rr1_Main.wav`]),
};
const VIBES_HARD: Source = {
  dir: 'Idiophones/Struck Idiophones/Vibraphone/Hard Mallets',
  packDir: 'vibes-hard',
  files: ['A2', 'A4', 'B3', 'C3', 'C5', 'D4', 'E3', 'E5', 'F2', 'F4', 'G3'].flatMap((n) => [`Vibes_hard_${n}_v2_rr1_Main.wav`, `Vibes_hard_${n}_v3_rr1_Main.wav`]),
};
const MARIMBA: Source = {
  dir: 'Idiophones/Struck Idiophones/Marimba',
  packDir: 'marimba',
  // The soft F5 and C6 takes peak near -65 dBFS (barely recorded): the soft layer borrows the medium takes there.
  files: ['F1', 'C2', 'G2', 'B2', 'F3', 'C4', 'G4', 'B4', 'F5', 'C6'].flatMap((n) => ['soft', 'med', 'loud'].map((d) => `Marimba_hit_Outrigger_${n}_${d}_01.wav`)).filter((f) => !/_(F5|C6)_soft_/.test(f)),
};
const GLOCK: Source = {
  dir: 'Idiophones/Struck Idiophones/Glockenspiel',
  packDir: 'glock',
  files: [
    'glock_soft_G4_01.wav', 'glock_soft_C5_02.wav', 'glock_soft_G5_01.wav', 'glock_soft_C6_01.wav', 'glock_soft_G6_01.wav', 'glock_soft_C7_03.wav',
    'glock_medium_G4_01.wav', 'glock_medium_C5_01.wav', 'glock_medium_G5_01.wav', 'glock_medium_C6_01.wav', 'glock_medium_G6_01.wav', 'glock_medium_C7_01.wav',
    'glock_loud_G4_01.wav', 'glock_loud_C5_01.wav', 'glock_loud_G5_01.wav', 'glock_loud_C6_01.wav', 'glock_loud_G#6_01.wav', 'glock_loud_C7_01.wav',
  ],
};
/** Kalimba tines: file, MIDI root, tuning correction in cents (VCSL's measured values). */
const KALIMBA_TINES: [string, number, number][] = [
  ['G1_k12', 43, -9], ['G#1_k11', 44, 0], ['B1_k13', 47, 78], ['C#2_k10', 49, 24], ['D#2_k14', 51, -38], ['F2_k9alt', 53, -41],
  ['G2_k15', 55, -45], ['A#2_k8', 58, -54], ['C#3_k16', 61, 43], ['D#3_k7', 63, -49], ['F3_k17', 65, -39], ['G3_k6', 67, -16],
  ['A#3_k18', 70, -38], ['C#4_k5', 73, 0], ['D4_k19', 74, -18], ['D#4_k4', 75, -30], ['D#4_k20', 75, -19], ['F4_k21', 77, -34],
  ['F4_k3', 77, -20], ['G4_k22', 79, 0], ['A#4_k2', 82, -40], ['B4_k23', 83, 47], ['C#5_k24', 85, -57], ['E5_k25', 88, 0],
  ['F#5_k1', 90, 0], ['G#5_k26', 92, -11], ['C#6_k27', 97, -67],
];
const KALIMBA: Source = {
  dir: 'Idiophones/Plucked Idiophones/Kalimba, Tanzania',
  packDir: 'kalimba',
  files: KALIMBA_TINES.map(([t]) => `MBira3_pluck_Main_${t}_50_100_rr2.wav`),
};

const SOURCES = [VIBES_SOFT, VIBES_HARD, MARIMBA, GLOCK, KALIMBA];
const rel = (s: Source, f: string) => `${s.packDir}/${safeName(f)}`;
const samples: SampleRef[] = SOURCES.flatMap((s) => s.files.map((f) => ({ src: `${s.dir}/${f}`, path: `samples/${rel(s, f)}` })));

const NOTE = /_([A-G]#?\d)_/;
const credit = 'VCSL by Versilian Studios (CC0)';

function inst(path: string, title: string, keys: { lo: number; hi: number }, global: Opcodes, regions: (ctx: Parameters<InstrumentSpec['build']>[0]) => Opcodes[]): InstrumentSpec {
  return {
    path,
    keys,
    build: (ctx) => ({ title: `${title} Krypt Studio mapping of ${credit}.`, control: { default_path: 'samples/' }, global, groups: [{ opcodes: {}, regions: regions(ctx) }] }),
  };
}

function vibes(path: string, src: Source, layerOf: (f: string) => number, title: string): InstrumentSpec {
  const zones: Zone[] = src.files.map((f) => ({ sample: rel(src, f), root: noteIn(f, NOTE, 72), layer: layerOf(f) }));
  return inst(path, title, { lo: 48, hi: 96 }, { amp_veltrack: 55, ampeg_attack: 0.001, ampeg_release: 0.9 }, (ctx) =>
    melodic(ctx, zones, { lo: 48, hi: 96, layers: velLayers(2, 12, [-14, -3]), skipSilenceMs: 2, keep: () => 7, fade: 2 }),
  );
}

export const KEYS_MALLETS: PackSpec = {
  id: 'keys-mallets',
  base: `https://raw.githubusercontent.com/sgossner/VCSL/${SHA}/`,
  mirrors: [`https://cdn.jsdelivr.net/gh/sgossner/VCSL@${SHA}/`],
  samples,
  instruments: [
    vibes('vibraphone.sfz', VIBES_SOFT, (f) => (/_v1_/.test(f) ? 0 : 1), 'Vibraphone, soft mallets: 2 velocity layers crossfaded, damped on release.'),
    vibes('vibraphone-hard.sfz', VIBES_HARD, (f) => (/_v2_/.test(f) ? 0 : 1), 'Vibraphone, hard mallets: brighter attack, 2 velocity layers crossfaded.'),
    inst('marimba.sfz', 'Marimba (rosewood, outrigger mallets): 3 velocity layers crossfaded, rings out.', { lo: 36, hi: 100 }, { loop_mode: 'one_shot', amp_veltrack: 50, ampeg_attack: 0.001 }, (ctx) =>
      melodic(
        ctx,
        MARIMBA.files.map((f) => ({ sample: rel(MARIMBA, f), root: noteIn(f, NOTE, 72), layer: f.includes('_soft_') ? 0 : f.includes('_med_') ? 1 : 2 })),
        { lo: 36, hi: 100, layers: velLayers(3, 10, [-16, -9, -3]), skipSilenceMs: 2 },
      ),
    ),
    inst('glockenspiel.sfz', 'Glockenspiel: 3 velocity layers crossfaded, mapped an octave below sounding pitch like the score, rings out.', { lo: 64, hi: 100 }, { loop_mode: 'one_shot', amp_veltrack: 50, ampeg_attack: 0.001 }, (ctx) =>
      melodic(
        ctx,
        GLOCK.files.map((f) => ({ sample: rel(GLOCK, f), root: noteIn(f, NOTE, 60), layer: f.includes('_soft_') ? 0 : f.includes('_medium_') ? 1 : 2 })),
        { lo: 64, hi: 100, layers: velLayers(3, 10, [-16, -9, -3]), skipSilenceMs: 2, keep: () => 4, fade: 1.5 },
      ),
    ),
    inst('kalimba.sfz', 'Kalimba (Tanzanian, 27 tines, each retuned to the nearest semitone): rings out, two tines alternate on D#4 and F4.', { lo: 41, hi: 99 }, { loop_mode: 'one_shot', amp_veltrack: 70, ampeg_attack: 0.001 }, (ctx) =>
      melodic(
        ctx,
        KALIMBA_TINES.map(([, root, tune], i) => ({ sample: rel(KALIMBA, KALIMBA.files[i]), root, tune, layer: 0 })),
        { lo: 41, hi: 99, layers: [{ lovel: 1, hivel: 127, peakDb: -3 }], skipSilenceMs: 2 },
      ),
    ),
  ],
};
