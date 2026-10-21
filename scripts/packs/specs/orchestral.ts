import { melodic, noteIn, safeName, velLayers, type BuildCtx, type InstrumentSpec, type LayerSpec, type Opcodes, type PackSpec, type SampleRef, type Zone } from '../lib';

const SHA = '440300901dfe9275fd84e0b7763af1f8443ae62e';

interface Section {
  dir: string;
  packDir: string;
  files: string[];
  layer: (f: string) => number;
  c4: number;
}

const NOTE = /_([A-G]#?\d)_/;
const NOTE_END = /_([A-G]#?\d)_(?:mf|f|mp)\.wav$/;
const vl = (f: string) => Number(/_v(\d)/.exec(f)![1]);
const notes = (s: string) => s.split(' ');

const VLN_SUS: Section = {
  dir: 'Strings/Violin Section/susVib',
  packDir: 'violins-sus',
  files: notes('G2 A2 B2 D3 F#3 A3 C4 E4 G4 B4 D5').flatMap((n) => [`VlnEns_susVib_${n}_v1.wav`, `VlnEns_susVib_${n}_v2.wav`]),
  layer: (f) => vl(f) - 1,
  c4: 72,
};
const VC_SUS: Section = {
  dir: 'Strings/Cello Section/susvib',
  packDir: 'celli-sus',
  files: ['susvib_C1_v1_1.wav', 'susvib_C1_v3_1.wav', 'susvib_E1_v1_1.wav', 'susvib_E1_v1_2.wav', 'susvib_E1_v3_1.wav', 'susvib_G1_v1_1.wav', 'susvib_G1_v3_1.wav', 'susvib_B1_v1_1.wav', 'susvib_B1_v3_1.wav', 'susvib_D2_v1_1.wav', 'susvib_D2_v3_1.wav', 'susvib_F2_v1_1.wav', 'susvib_F2_v3_1.wav'],
  layer: (f) => (vl(f) === 1 ? 0 : 1),
  c4: 72,
};
const VLN_SPIC: Section = {
  dir: 'Strings/Violin Section/Spic',
  packDir: 'violins-spic',
  files: notes('G2 A2 B2 D3 F#3 A3 C4 E4 G4 B4 D5').flatMap((n) => ['v1_rr1', 'v1_rr2', 'v2_rr1', 'v2_rr2'].map((x) => `VlnEns_Spic_${n}_${x}.wav`)),
  layer: (f) => vl(f) - 1,
  c4: 72,
};
const VC_SPIC: Section = {
  dir: 'Strings/Cello Section/spic',
  packDir: 'celli-spic',
  files: notes('C1 E1 G1 B1 D2 F2').flatMap((n) => ['v1_RR1', 'v1_RR2', 'v2_RR1', 'v2_RR2'].map((x) => `spic_${n}_${x}.wav`)),
  layer: (f) => vl(f) - 1,
  c4: 72,
};
const VLN_PIZZ: Section = {
  dir: 'Strings/Violin Section/Pizz',
  packDir: 'violins-pizz',
  files: notes('G2 A2 B2 D3 F#3 A3 C4 E4 G4 B4 D5').flatMap((n) => ['v1_rr1', 'v1_rr2', 'v2_rr1', 'v2_rr2'].map((x) => `VlnEns_Pizz_${n}_${x}.wav`)),
  layer: (f) => vl(f) - 1,
  c4: 72,
};
const TPT: Section = {
  dir: 'Brass/Trumpet/stac',
  packDir: 'trumpet-stac',
  files: notes('C3 D#3 F3 G3 A#3 D4 F4 A4 C5').flatMap((n) => ['v1_rr1', 'v1_rr2', 'v2_rr1', 'v2_rr2', 'v3_rr1', 'v3_rr2'].map((x) => `Sum_SHTrumpet_stac_${n}_${x}.wav`)),
  layer: (f) => vl(f) - 1,
  c4: 72,
};
const HORN: Section = {
  dir: 'Brass/F Horn/stac',
  packDir: 'horn-stac',
  files: ['D2', 'F2', 'A2', 'C3', 'D4'].flatMap((n) => ['v1_rr1', 'v1_rr2', 'v2_rr1', 'v2_rr2', 'v3_rr1', 'v3_rr2'].map((x) => `MOHorn_stac_${n}_${x}.wav`)),
  layer: (f) => vl(f) - 1,
  c4: 72,
};
const TBN: Section = {
  dir: 'Brass/Tenor Trombone/stac',
  packDir: 'trombone-stac',
  files: [
    ...notes('A#0 F1 A#1 F2 D3').flatMap((n) => ['v1_rr1', 'v1_rr2', 'v2_rr1', 'v2_rr2', 'v3_rr1', 'v3_rr2', 'v4_rr1', 'v4_rr2'].map((x) => `tenortbn_stac_${n}_${x}.wav`)),
    ...['v1_rr1', 'v1_rr2', 'v2_rr1', 'v2_rr2', 'v3_rr1', 'v3_rr2', 'v4_rr1', 'v4_r2'].map((x) => `tenortbn_stac_A#2_${x}.wav`),
  ],
  layer: (f) => vl(f) - 1,
  c4: 72,
};
const FLUTE: Section = {
  dir: 'Woodwinds/Flute/susvib',
  packDir: 'flute',
  files: ['C3', 'E3', 'A3', 'C4', 'E4', 'A4', 'C5', 'E5', 'A5', 'C6'].map((n) => `LDFlute_susvib_${n}_v1_1.wav`).concat(['C4', 'E4', 'E5'].map((n) => `LDFlute_susvib_${n}_v1_2.wav`)),
  layer: (f) => (f.endsWith('_2.wav') ? 1 : 0),
  c4: 72,
};
const HARP: Section = {
  dir: 'Strings/Harp',
  packDir: 'harp',
  files: ['E1_f', 'B1_mf', 'D2_mf', 'F2_mf', 'A2_mf', 'C3_mf', 'E3_mf', 'G3_mf', 'B3_mf', 'D4_mf', 'F4_mf', 'A4_mf', 'C5_mf', 'E5_mf', 'G5_mf', 'B5_mf', 'D6_mf', 'F6_mf', 'A6_mf', 'B6_mf', 'D7_f', 'F7_f'].map((n) => `KSHarp_${n}.wav`),
  layer: () => 0,
  c4: 60,
};

const SECTIONS = [VLN_SUS, VC_SUS, VLN_SPIC, VC_SPIC, VLN_PIZZ, TPT, HORN, TBN, FLUTE, HARP];
const rel = (s: Section, f: string) => `${s.packDir}/${safeName(f)}`;
const samples: SampleRef[] = SECTIONS.flatMap((s) => s.files.map((f) => ({ src: `${s.dir}/${f}`, path: `samples/${rel(s, f)}` })));

function zonesOf(s: Section, re = NOTE): Zone[] {
  return s.files.map((f) => ({ sample: rel(s, f), root: noteIn(f, re, s.c4), layer: s.layer(f) }));
}

const credit = 'VS Chamber Orchestra 2: Community Edition by Versilian Studios (CC0)';

function orchestral(path: string, title: string, keys: { lo: number; hi: number }, global: Opcodes, parts: { zones: Zone[]; lo: number; hi: number; layers: LayerSpec[]; volume?: number; keep?: (r: number) => number; fade?: number }[]): InstrumentSpec {
  return {
    path,
    keys,
    build: (ctx: BuildCtx) => ({
      title: `${title} Krypt Studio mapping of ${credit}.`,
      control: { default_path: 'samples/' },
      global,
      groups: parts.map((p) => ({
        opcodes: {},
        regions: melodic(ctx, p.zones, { lo: p.lo, hi: p.hi, layers: p.volume ? p.layers.map((l) => ({ ...l, peakDb: (l.peakDb ?? 0) + p.volume! })) : p.layers, skipSilenceMs: 3, keep: p.keep, fade: p.fade }),
      })),
    }),
  };
}

const SUS2 = velLayers(2, 14, [-9, -3]);
const SHORT2 = velLayers(2, 0, [-8, -2]);

export const ORCHESTRAL: PackSpec = {
  id: 'orchestral',
  base: `https://raw.githubusercontent.com/sgossner/VSCO-2-CE/${SHA}/`,
  mirrors: [`https://cdn.jsdelivr.net/gh/sgossner/VSCO-2-CE@${SHA}/`],
  samples,
  instruments: [
    orchestral('strings.sfz', 'String ensemble, sustained with vibrato: cello section below G3, violin section from G3; 2 dynamics crossfaded by velocity.', { lo: 24, hi: 96 }, { amp_veltrack: 35, ampeg_attack: 0.03, ampeg_release: 0.6 }, [
      { zones: zonesOf(VC_SUS), lo: 24, hi: 54, layers: SUS2 },
      { zones: zonesOf(VLN_SUS), lo: 55, hi: 96, layers: SUS2 },
    ]),
    orchestral('strings-staccato.sfz', 'String ensemble spiccato: cello section below G3, violin section from G3; 2 dynamics x 2 round robins.', { lo: 24, hi: 96 }, { loop_mode: 'one_shot', amp_veltrack: 45, ampeg_attack: 0.001 }, [
      { zones: zonesOf(VC_SPIC), lo: 24, hi: 54, layers: SHORT2 },
      { zones: zonesOf(VLN_SPIC), lo: 55, hi: 96, layers: SHORT2 },
    ]),
    orchestral('strings-pizzicato.sfz', 'Violin section pizzicato: 2 dynamics x 2 round robins, stretched down to C3.', { lo: 48, hi: 96 }, { loop_mode: 'one_shot', amp_veltrack: 45, ampeg_attack: 0.001 }, [
      { zones: zonesOf(VLN_PIZZ), lo: 48, hi: 96, layers: SHORT2, keep: () => 2.5, fade: 0.8 },
    ]),
    orchestral('brass-stabs.sfz', 'Brass section stabs: trombone (A#1-D4), horn (D3-D5) and trumpet (C4-E6) staccato layered where they overlap, with round robins.', { lo: 34, hi: 88 }, { loop_mode: 'one_shot', amp_veltrack: 45, ampeg_attack: 0.001 }, [
      { zones: zonesOf(TBN), lo: 34, hi: 62, layers: velLayers(4, 0, [-12, -8, -5, -2]), volume: -3 },
      { zones: zonesOf(HORN), lo: 50, hi: 74, layers: velLayers(3, 0, [-10, -6, -2]), volume: -3 },
      { zones: zonesOf(TPT), lo: 60, hi: 88, layers: velLayers(3, 0, [-14, -8, -2]), volume: -3 },
    ]),
    orchestral('flute.sfz', 'Flute, sustained with vibrato: soft and full takes crossfaded by velocity where both exist.', { lo: 58, hi: 98 }, { amp_veltrack: 40, ampeg_attack: 0.02, ampeg_release: 0.35 }, [
      { zones: zonesOf(FLUTE), lo: 58, hi: 98, layers: velLayers(2, 12, [-6, -2]) },
    ]),
    orchestral('harp.sfz', 'Concert harp, plucked: rings out, one dynamic.', { lo: 28, hi: 103 }, { loop_mode: 'one_shot', amp_veltrack: 60, ampeg_attack: 0.001 }, [
      { zones: zonesOf(HARP, NOTE_END), lo: 28, hi: 103, layers: [{ lovel: 1, hivel: 127, peakDb: -12 }], keep: (r) => (r < 48 ? 6 : r < 72 ? 4.5 : 3), fade: 1.2 },
    ]),
  ],
};
