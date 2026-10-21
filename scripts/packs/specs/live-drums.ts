// Live drum kit: Virtuosity Drums by Versilian Studios and Karoryfer Samples (CC0 1.0), a jazz/club "house kit"
// recorded at Virtuosity Musical Instruments, Boston, played with sticks by Austin McMahon. 48 kHz / 24-bit FLAC
// (close mics mono, room/overhead mics stereo), pinned to a commit of the sfzinstruments repository.
//
// Two mixes from the same session, both ours:
// - "studio": each piece's close mic layered with the stereo overheads (kick mic + OH on the kick, snare mic + OH on
//   the snare, OH with a little snare-mic bleed on the hats, OH alone on cymbals and toms), the way the upstream
//   basic kit balances them by default (every mic at full level).
// - "lofi": the session's vintage "lofi" mic alone, a dark, compressed, roomy colour for lo-fi and boom bap.
// Articulations with many velocity layers and no round robins (snare 36, cross-stick 16, rimshot 12, toms 16) use
// neighbouring layers as round robins, so repeated hits at one velocity alternate instead of machine-gunning.

import type { BuildCtx, InstrumentSpec, Opcodes, PackSpec, SampleRef, SfzGroup } from '../lib';

const SHA = '9f04cf9a734527edfbb0a4eee1f674e45bbf71bc';

type Mic = 'kickmic' | 'snaremic' | 'oh' | 'lofi';

interface Artic {
  /** Upstream piece folder. */
  folder: string;
  /** Upstream articulation stem after the mic prefix, e.g. 'kick_snon'. */
  stem: string;
  layers: number;
  /** Round robins per layer upstream (0 = none: neighbouring layers become round robins, `rrFrom` per band). */
  rr: number;
  /** For rr articulations: velocity bands per layer (upstream). */
  bands?: [number, number][];
  /** For layer-only articulations: adjacent layers per band used as round robins. */
  rrFrom?: number;
}

const B4: [number, number][] = [[1, 31], [32, 63], [64, 95], [96, 127]];
const B3: [number, number][] = [[1, 42], [43, 85], [86, 127]];

const A = {
  kick: { folder: 'kick', stem: 'kick_snon', layers: 4, rr: 4, bands: B4 },
  snare: { folder: 'snare', stem: 'snare_center', layers: 36, rr: 0, rrFrom: 3 },
  rimshot: { folder: 'snare', stem: 'snare_rimshot', layers: 12, rr: 0, rrFrom: 2 },
  xstick: { folder: 'snare', stem: 'snare_crossstick', layers: 16, rr: 0, rrFrom: 2 },
  hhClosed: { folder: 'hh', stem: 'hh_closed', layers: 4, rr: 4, bands: B4 },
  hhPedal: { folder: 'hh', stem: 'hh_pedal', layers: 3, rr: 4, bands: [[1, 42], [43, 85], [86, 127]] },
  hhOpen: { folder: 'hh', stem: 'hh_open', layers: 4, rr: 3, bands: B4 },
  ride: { folder: 'ride', stem: 'ride_ride', layers: 3, rr: 4, bands: B3 },
  bell: { folder: 'ride', stem: 'ride_bell', layers: 3, rr: 3, bands: B3 },
  crash: { folder: 'crash', stem: 'crash_crash', layers: 3, rr: 4, bands: B3 },
  ltom: { folder: 'ltom', stem: 'ltom_center', layers: 16, rr: 0, rrFrom: 2 },
  htom: { folder: 'htom', stem: 'htom_center', layers: 16, rr: 0, rrFrom: 2 },
} satisfies Record<string, Artic>;
type ArticId = keyof typeof A;

/** Which mics (and at what level, dB) make up each articulation in a mix. */
type Mix = Record<ArticId, [Mic, number][]>;
const STUDIO: Mix = {
  kick: [['kickmic', 0], ['oh', 0]],
  snare: [['snaremic', 0], ['oh', 0]],
  rimshot: [['snaremic', 0], ['oh', 0]],
  xstick: [['snaremic', 0], ['oh', 0]],
  hhClosed: [['oh', 0], ['snaremic', -6]],
  hhPedal: [['oh', 0], ['snaremic', -6]],
  hhOpen: [['oh', 0], ['snaremic', -6]],
  ride: [['oh', 0]],
  bell: [['oh', 0]],
  crash: [['oh', 0]],
  ltom: [['oh', 0]],
  htom: [['oh', 0]],
};
const LOFI: Mix = Object.fromEntries(Object.keys(A).map((k) => [k, [['lofi', 0]]])) as unknown as Mix;

/**
 * Level per articulation (dB on every mic of it), measured with scripts/audition-presets.mjs --packs-dir so each
 * single-piece preset at gain 0 lands on its role's loudness target, which also balances the pieces inside the GM
 * kits. The session's mics hear the kit very differently (the vintage mic barely hears the kick but loves the hats),
 * hence the two columns. Rimshot follows the snare, the pedal hat the closed hat, the bell the ride.
 */
const LEVEL: Record<'studio' | 'lofi', Record<ArticId, number>> = {
  studio: { kick: 2, snare: 12.5, rimshot: 12.5, xstick: 7, hhClosed: 6, hhPedal: 6, hhOpen: 4, ride: 16.5, bell: 13.5, crash: 9, ltom: 7.5, htom: 3.5 },
  lofi: { kick: 19, snare: 6, rimshot: 6, xstick: -1, hhClosed: 1, hhPedal: 1, hhOpen: -4.5, ride: 8, bell: 5, crash: -3, ltom: 7, htom: 5 },
};
const leveled = (mix: Mix, level: Record<ArticId, number>): Mix =>
  Object.fromEntries(Object.entries(mix).map(([id, mics]) => [id, mics.map(([mic, v]) => [mic, Math.round((v + level[id as ArticId]) * 10) / 10])])) as unknown as Mix;
const STUDIO_MIX = leveled(STUDIO, LEVEL.studio);
const LOFI_MIX = leveled(LOFI, LEVEL.lofi);

const fileName = (mic: Mic, a: Artic, v: number, r: number) => `${mic}_${a.stem}_vl${v}${a.rr ? `_rr${r}` : ''}.flac`;
const packPath = (mic: Mic, a: Artic, v: number, r: number) => `samples/${mic}/${fileName(mic, a, v, r)}`;

/** Every file an articulation uses on one mic. */
function filesOf(mic: Mic, a: Artic): SampleRef[] {
  const out: SampleRef[] = [];
  for (let v = 1; v <= a.layers; v++) {
    for (let r = 1; r <= Math.max(1, a.rr); r++) out.push({ src: `Samples/${mic}/${a.folder}/${fileName(mic, a, v, r)}`, path: packPath(mic, a, v, r) });
  }
  return out;
}

/** Long cymbal and tom tails are trimmed (seconds kept, fade before the cut) to keep the kit's RAM modest. */
const TRIM: Partial<Record<ArticId, [number, number]>> = {
  hhOpen: [3.5, 1],
  crash: [5, 1.5],
  ride: [4.5, 1.5],
  bell: [4, 1.5],
  ltom: [2.5, 0.8],
  htom: [2.5, 0.8],
};

/** Regions (without key opcodes) for one articulation on one mic: velocity bands + round robins. */
function articRegions(ctx: BuildCtx, id: ArticId, mic: Mic, volume: number): Opcodes[] {
  const a: Artic = A[id];
  const out: Opcodes[] = [];
  const vol: Opcodes = volume ? { volume } : {};
  const trim = (sample: string): Opcodes => {
    const t = TRIM[id];
    if (!t) return {};
    const p = `samples/${sample}`;
    const f = ctx.facts(p);
    if (f.frames / f.rate <= t[0]) return {};
    return { end: ctx.endFor(p, t[0]), ampeg_hold: t[0] - t[1], ampeg_decay: t[1], ampeg_sustain: 0 };
  };
  if (a.rr) {
    a.bands!.forEach(([lo, hi], i) => {
      for (let r = 1; r <= a.rr; r++) {
        const sample = `${mic}/${fileName(mic, a, i + 1, r)}`;
        out.push({ sample, lovel: lo, hivel: hi, seq_length: a.rr, seq_position: r, ...vol, ...trim(sample) });
      }
    });
  } else {
    const per = a.rrFrom!;
    const nb = a.layers / per;
    for (let b = 0; b < nb; b++) {
      const lo = Math.floor((b * 127) / nb) + 1;
      const hi = Math.floor(((b + 1) * 127) / nb);
      for (let k = 0; k < per; k++) {
        const sample = `${mic}/${fileName(mic, a, b * per + k + 1, 0)}`;
        out.push({ sample, lovel: lo, hivel: hi, seq_length: per, seq_position: k + 1, ...vol, ...trim(sample) });
      }
    }
  }
  return out;
}

/** All mics of an articulation in a mix, placed on keys. */
function placed(ctx: BuildCtx, mix: Mix, id: ArticId, keys: Opcodes): Opcodes[] {
  return mix[id].flatMap(([mic, vol]) => articRegions(ctx, id, mic, vol).map((r) => ({ ...r, ...keys })));
}

/** Per-articulation level and envelope (amp_veltrack 0 where many layers already carry the dynamics). */
const FEEL: Record<ArticId, Opcodes> = {
  kick: { amp_veltrack: 30 },
  snare: { amp_veltrack: 0 },
  rimshot: { amp_veltrack: 0 },
  xstick: { amp_veltrack: 0 },
  hhClosed: { amp_veltrack: 30 },
  hhPedal: { amp_veltrack: 30 },
  hhOpen: { amp_veltrack: 30 },
  ride: { amp_veltrack: 30 },
  bell: { amp_veltrack: 30 },
  crash: { amp_veltrack: 30 },
  ltom: { amp_veltrack: 0 },
  htom: { amp_veltrack: 0 },
};

const GLOBAL: Opcodes = { loop_mode: 'one_shot', ampeg_attack: 0.001, ampeg_release: 0.08, off_mode: 'normal' };

/** The GM kit layout: 35/36 kick, 37 cross-stick, 38 snare, 40 rimshot, toms 41-50, hats 42/44/46, cymbals; kick on 60 too. */
function kit(path: string, mix: Mix, title: string): InstrumentSpec {
  const fixed = (k: number) => ({ lokey: k, hikey: k, pitch_keycenter: k, pitch_keytrack: 0 });
  return {
    path,
    keys: [35, 36, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 53, 57, 59, 60],
    build: (ctx) => {
      const g = (comment: string, id: ArticId, regions: Opcodes[], extra: Opcodes = {}): SfzGroup => ({ comment, opcodes: { ...FEEL[id], ...extra }, regions });
      return {
        title,
        control: { default_path: 'samples/' },
        global: GLOBAL,
        groups: [
          // the kick also answers on C4 (60), where step-sequencer steps land on a channel with the default root key
          g('kick (35, 36, and 60 for steps)', 'kick', [...placed(ctx, mix, 'kick', { lokey: 35, hikey: 36, pitch_keycenter: 36, pitch_keytrack: 0 }), ...placed(ctx, mix, 'kick', fixed(60))]),
          g('cross-stick (37)', 'xstick', placed(ctx, mix, 'xstick', fixed(37))),
          g('snare (38)', 'snare', placed(ctx, mix, 'snare', fixed(38))),
          g('rimshot (40)', 'rimshot', placed(ctx, mix, 'rimshot', fixed(40))),
          // GM toms sit between the hats: the low tom plays 41/43/45 (-2/0/+2 st), the high tom 47/48/50 (-1/0/+2 st)
          g('low tom (41, 43, 45)', 'ltom', [41, 43, 45].flatMap((k) => placed(ctx, mix, 'ltom', { lokey: k, hikey: k, pitch_keycenter: 43 }))),
          g('high tom (47, 48, 50)', 'htom', [47, 48, 50].flatMap((k) => placed(ctx, mix, 'htom', { lokey: k, hikey: k, pitch_keycenter: 48 }))),
          // hats: closed and pedal (group 1) choke the open hat (group 2)
          g('closed hat (42)', 'hhClosed', placed(ctx, mix, 'hhClosed', fixed(42)), { group: 1 }),
          g('pedal hat (44)', 'hhPedal', placed(ctx, mix, 'hhPedal', fixed(44)), { group: 1 }),
          g('open hat (46), choked by the closed and pedal hats', 'hhOpen', placed(ctx, mix, 'hhOpen', fixed(46)), { group: 2, off_by: 1 }),
          g('crash (49, 57)', 'crash', [...placed(ctx, mix, 'crash', fixed(49)), ...placed(ctx, mix, 'crash', fixed(57))]),
          g('ride (51, 59)', 'ride', [...placed(ctx, mix, 'ride', fixed(51)), ...placed(ctx, mix, 'ride', fixed(59))]),
          g('ride bell (53)', 'bell', placed(ctx, mix, 'bell', fixed(53))),
        ],
      };
    },
  };
}

/** One piece across the keyboard, its natural pitch on C4 (60): play it from a step-sequencer channel. */
function piece(path: string, mix: Mix, id: ArticId, title: string): InstrumentSpec {
  return {
    path,
    keys: { lo: 0, hi: 127 },
    build: (ctx) => ({
      title,
      control: { default_path: 'samples/' },
      global: GLOBAL,
      groups: [{ opcodes: FEEL[id], regions: placed(ctx, mix, id, { lokey: 0, hikey: 127, pitch_keycenter: 60 }) }],
    }),
  };
}

const credit = 'Virtuosity Drums (Versilian Studios and Karoryfer Samples, CC0)';
const STUDIO_PIECES: [string, ArticId, string][] = [
  ['kick.sfz', 'kick', 'Live kick: kick mic + overheads'],
  ['snare.sfz', 'snare', 'Live snare: snare mic + overheads, 36 layers as 12 bands x 3 round robins'],
  ['rim.sfz', 'xstick', 'Cross-stick (side stick): snare mic + overheads'],
  ['hat.sfz', 'hhClosed', 'Closed hi-hat: overheads + snare-mic bleed, 4 layers x 4 round robins'],
  ['openhat.sfz', 'hhOpen', 'Open hi-hat: overheads + snare-mic bleed'],
  ['ride.sfz', 'ride', 'Ride cymbal: overheads, 3 layers x 4 round robins'],
  ['crash.sfz', 'crash', 'Crash cymbal: overheads, 3 layers x 4 round robins'],
  ['tom-low.sfz', 'ltom', 'Low tom: overheads'],
  ['tom-high.sfz', 'htom', 'High tom: overheads'],
];
const LOFI_PIECES: [string, ArticId, string][] = [
  ['kick-lofi.sfz', 'kick', 'Lo-fi mic kick'],
  ['snare-lofi.sfz', 'snare', 'Lo-fi mic snare'],
  ['rim-lofi.sfz', 'xstick', 'Lo-fi mic cross-stick'],
  ['hat-lofi.sfz', 'hhClosed', 'Lo-fi mic closed hi-hat'],
  ['openhat-lofi.sfz', 'hhOpen', 'Lo-fi mic open hi-hat'],
  ['ride-lofi.sfz', 'ride', 'Lo-fi mic ride'],
  ['crash-lofi.sfz', 'crash', 'Lo-fi mic crash'],
  ['tom-low-lofi.sfz', 'ltom', 'Lo-fi mic low tom'],
  ['tom-high-lofi.sfz', 'htom', 'Lo-fi mic high tom'],
];

const samples: SampleRef[] = [];
{
  const seen = new Set<string>();
  for (const mix of [STUDIO, LOFI]) {
    for (const id of Object.keys(A) as ArticId[]) {
      for (const [mic] of mix[id]) {
        for (const s of filesOf(mic, A[id])) {
          if (!seen.has(s.path)) {
            seen.add(s.path);
            samples.push(s);
          }
        }
      }
    }
  }
}

export const LIVE_DRUMS: PackSpec = {
  id: 'live-drums',
  base: `https://raw.githubusercontent.com/sfzinstruments/virtuosity_drums/${SHA}/`,
  mirrors: [`https://cdn.jsdelivr.net/gh/sfzinstruments/virtuosity_drums@${SHA}/`],
  samples,
  instruments: [
    kit('kit.sfz', STUDIO_MIX, `Live drum kit, GM layout, close mics + overheads. Krypt Studio mapping of ${credit}.`),
    kit('kit-lofi.sfz', LOFI_MIX, `Live drum kit, GM layout, the vintage lo-fi mic alone. Krypt Studio mapping of ${credit}.`),
    ...STUDIO_PIECES.map(([p, id, t]) => piece(p, STUDIO_MIX, id, `${t}; natural pitch on C4. Krypt Studio mapping of ${credit}.`)),
    ...LOFI_PIECES.map(([p, id, t]) => piece(p, LOFI_MIX, id, `${t}; natural pitch on C4. Krypt Studio mapping of ${credit}.`)),
  ],
};
