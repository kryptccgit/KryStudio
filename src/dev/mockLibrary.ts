// ──────────────────────────────────────────────────────────────────────
// Browser-mock reference library (npm run dev:web): window.krypt.library
// with fake but realistic data, so every Library panel / profile / focus /
// originality state can be exercised without Electron.
//
//   Collections: "Dark trap" (1,500 tracks: virtualisation, deep on, some
//   failed + missing, rich profile), "90s R&B" (180, light only: profile
//   without bass), "Lo-fi sketches" (24, mostly queued: thin profile with
//   caveats) and an empty "Ambient ideas".
//   Queue: runs (~1 track / 0.9 s) through the queued tracks, sometimes
//   failing one; pause / resume persist for the session.
//   Similar: deterministic scores. Originality: matches against the deep
//   tracks (remove "Dark trap" to see the "needs deep analysis" state).
//   Folder / file pickers add a batch of fake files.
//   devtools: window.__kryptMockLibrary (the in-memory db).
// ──────────────────────────────────────────────────────────────────────

import { USER, type DocHost } from '@shared/doc/DocHost';
import type { ActionResult, KryptApi } from '@shared/types';
import type {
  Collection,
  LibraryFocus,
  LibraryQueueState,
  LibraryState,
  LibraryTrack,
  OriginalityMatch,
  StyleProfile,
  TrackDetail,
  TrackQuery,
  TrackStatus,
} from '@shared/library/types';
import { fakeAnalysis } from './mockAnalyzer';

type LibraryApi = KryptApi['library'];

const ROOT = 'D:\\Music\\References';
const DB_PATH = 'C:\\Users\\you\\AppData\\Roaming\\Krypt Studio\\library\\library.db';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const ADJ = ['Midnight', 'Cold', 'Hollow', 'Neon', 'Velvet', 'Silent', 'Broken', 'Lucid', 'Static', 'Crimson', 'Ghost', 'Paper', 'Low', 'Glass', 'Faded', 'Iron', 'Smoke', 'Slow', 'Golden', 'Blue'];
const NOUN = ['Ritual', 'Signal', 'Avenue', 'Halo', 'Engine', 'Mirage', 'Orbit', 'Tide', 'Season', 'Echo', 'Vow', 'Motel', 'Garden', 'Pulse', 'Letters', 'Skyline', 'Fever', 'Room', 'Window', 'Hours'];
const SUFFIX = ['', '', '', '', ' (Bounce)', ' v2', ' final', ' (Instrumental)', ' demo', ' (Extended)'];
const EXT = ['wav', 'wav', 'mp3', 'flac', 'mp3'];

const MAJOR = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

interface Style {
  bpm: [number, number];
  minor: number;
  lufs: [number, number];
  len: [number, number];
}

const STYLES: Record<string, Style> = {
  dark: { bpm: [128, 162], minor: 0.86, lufs: [-10.5, -6.2], len: [120, 230] },
  rnb: { bpm: [62, 102], minor: 0.45, lufs: [-13.5, -9], len: [180, 290] },
  lofi: { bpm: [70, 92], minor: 0.55, lufs: [-16, -11.5], len: [90, 170] },
};

const FAIL_REASONS = [
  'Unsupported codec (ALAC in .m4a)',
  'The file is truncated: decoding stopped at 0:42',
  'No audio frames found (0 bytes of PCM)',
  'Unreadable header: not a valid FLAC stream',
];

function makeTrack(collectionId: string, folder: string, style: Style, i: number, seedBase: number, now: number): LibraryTrack {
  const r = rng(seedBase + i * 7919);
  const name = `${ADJ[Math.floor(r() * ADJ.length)]} ${NOUN[Math.floor(r() * NOUN.length)]}${SUFFIX[Math.floor(r() * SUFFIX.length)]}${r() < 0.3 ? ` ${Math.floor(r() * 90 + 10)}` : ''}`;
  const ext = EXT[Math.floor(r() * EXT.length)];
  const minor = r() < style.minor;
  const pc = Math.floor(r() * 12);
  const bpmRaw = style.bpm[0] + r() * (style.bpm[1] - style.bpm[0]);
  return {
    id: `${collectionId}-t${i}`,
    collectionId,
    path: `${folder}\\${name}.${ext}`,
    name,
    size: Math.round(3_000_000 + r() * 60_000_000),
    mtime: now - Math.round(r() * 3e10),
    status: 'pending',
    durationSec: style.len[0] + r() * (style.len[1] - style.len[0]),
    bpm: r() < 0.6 ? Math.round(bpmRaw) : Math.round(bpmRaw * 10) / 10,
    bpmConfidence: 0.55 + r() * 0.44,
    key: minor ? `${MINOR[pc]}m` : MAJOR[pc],
    keyConfidence: 0.4 + r() * 0.55,
    swing: r() < 0.4 ? Math.round(r() * 40) / 100 : 0,
    lufs: Math.round((style.lufs[0] + r() * (style.lufs[1] - style.lufs[0])) * 10) / 10,
    width: Math.round((0.25 + r() * 0.45) * 100) / 100,
    addedAt: now - Math.round(r() * 8.64e8),
    tags: [],
  };
}

/** Analysis fields only exist once a pass ran. */
function visible(t: LibraryTrack): LibraryTrack {
  const out: LibraryTrack = { ...t, tags: [...t.tags] };
  if (t.status === 'light' || t.status === 'deep' || t.status === 'missing') return out;
  for (const k of ['bpm', 'bpmConfidence', 'key', 'keyConfidence', 'swing', 'lufs', 'width', 'analyzedAt'] as const) delete out[k];
  if (t.status === 'failed') delete out.durationSec;
  return out;
}

// ── Profiles ──────────────────────────────────────────────────────────

const pct = (p10: number, p25: number, median: number, p75: number, p90: number) => ({ p10, p25, median, p75, p90 });

function grid(spec: Array<[number, number]>, base: number, seed: number): { prob: number[]; vel: number[] } {
  const r = rng(seed);
  const prob = Array.from({ length: 32 }, () => (r() < 0.5 ? base * r() : 0));
  for (const [step, p] of spec) prob[step] = p;
  const vel = prob.map((p) => (p > 0 ? Math.round((0.55 + 0.45 * Math.min(1, p + r() * 0.2)) * 100) / 100 : 0));
  return { prob: prob.map((p) => Math.round(p * 1000) / 1000), vel };
}

const every = (from: number, step: number, p: number, jitter = 0, seed = 1): Array<[number, number]> => {
  const r = rng(seed);
  const out: Array<[number, number]> = [];
  for (let s = from; s < 32; s += step) out.push([s, Math.max(0, Math.min(1, p + (r() - 0.5) * jitter))]);
  return out;
};

function darkProfile(c: Collection, now: number): StyleProfile {
  const analysed = c.counts.light + c.counts.deep;
  return {
    collectionId: c.id,
    name: c.name,
    tracks: c.counts.total,
    analysed,
    deep: c.counts.deep,
    updatedAt: now - 4 * 60_000,
    tempo: {
      bpm: pct(132, 138, 141, 146, 152),
      histogram: [
        { bpm: 128, count: 22 },
        { bpm: 132, count: 61 },
        { bpm: 136, count: 148 },
        { bpm: 140, count: 402 },
        { bpm: 144, count: 236 },
        { bpm: 148, count: 131 },
        { bpm: 152, count: 84 },
        { bpm: 156, count: 41 },
        { bpm: 160, count: 17 },
      ],
      halfTimeShare: 0.38,
    },
    swing: { median: 0.06, share: 0.21 },
    keys: {
      top: [
        { key: 'F#m', count: 214 },
        { key: 'Am', count: 176 },
        { key: 'C#m', count: 158 },
        { key: 'Gm', count: 141 },
        { key: 'Ebm', count: 104 },
        { key: 'Bbm', count: 88 },
        { key: 'Ab', count: 52 },
        { key: 'Db', count: 37 },
      ],
      minorShare: 0.86,
    },
    drums: {
      roles: {
        kick: grid([[0, 0.96], [6, 0.34], [12, 0.21], [14, 0.47], [20, 0.16], [22, 0.55], [28, 0.31], [30, 0.12]], 0.04, 11),
        snare: grid([[16, 0.97], [28, 0.14], [30, 0.11], [8, 0.06]], 0.02, 12),
        hat: grid([...every(0, 2, 0.9, 0.12, 3), ...every(1, 2, 0.19, 0.1, 4)], 0, 13),
        openhat: grid([[12, 0.24], [28, 0.31], [4, 0.07]], 0.02, 14),
        perc: grid([[10, 0.18], [26, 0.22], [18, 0.09]], 0.05, 15),
      },
      rollsPerBar: 0.42,
      tracks: analysed,
      source: 'mixed',
    },
    bass: {
      length: pct(0.25, 0.5, 1, 2, 3.5),
      degrees: [0.46, 0.02, 0.04, 0.12, 0.01, 0.06, 0.02, 0.14, 0.07, 0.01, 0.04, 0.01],
      kickAlign: 0.71,
      glide: 0.23,
      tracks: c.counts.deep,
    },
    harmony: {
      progressions: [
        { degrees: ['i', 'VI', 'III', 'VII'], count: 64 },
        { degrees: ['i', 'iv', 'VI', 'v'], count: 41 },
        { degrees: ['i', 'VI', 'iv', 'v'], count: 33 },
        { degrees: ['i', 'VII', 'VI', 'VII'], count: 27 },
        { degrees: ['i', 'i', 'VI', 'VII'], count: 19 },
        { degrees: ['i', 'iv'], count: 15 },
      ],
      changesPerBar: 0.5,
      tracks: Math.round(analysed * 0.83),
    },
    structure: {
      sectionBars: pct(4, 8, 8, 16, 16),
      forms: [
        { form: ['A', 'B', 'C', 'B', 'C', 'B'], count: 132 },
        { form: ['A', 'B', 'C', 'B', 'D', 'B'], count: 88 },
        { form: ['B', 'C', 'B', 'C', 'B'], count: 61 },
        { form: ['A', 'C', 'B', 'C', 'B', 'A'], count: 40 },
      ],
      energyShape: [0.35, 0.42, 0.78, 0.82, 0.62, 0.66, 0.85, 0.88, 0.6, 0.64, 0.9, 0.92, 0.86, 0.7, 0.48, 0.3],
      lengthSec: pct(128, 145, 162, 185, 210),
    },
    mix: {
      lufs: pct(-10.2, -9, -8.1, -7.2, -6.4),
      truePeakDb: pct(-1.2, -0.6, -0.2, 0.4, 0.9),
      width: pct(0.32, 0.4, 0.48, 0.55, 0.63),
      bands: { sub: 0, low: -2.1, lowMid: -7.8, mid: -9.4, highMid: -11.2, high: -14.6 },
    },
    examples: {
      drums: [
        'pattern "Dark trap · sampled" bars=2 grid=16 key=F#m',
        'kick   : x... .... ..x. .x.. | x... .... ..x. ..x.',
        'snare  : .... .... x... .... | .... .... x... ..o.',
        'hat/32 : (x.x.)*6 xxxx x.x. | (x.x.)*7 xxxx',
        'openhat: .... .... .... x... | .... .... .... ....',
      ].join('\n'),
      bass: ['pattern "Dark trap 808 · sampled" bars=2 grid=16 key=F#m', '808 {oct=1}: F#1:6 r:2 F#1:2 A1:2 r:4 | C#2:4 r:2 B1:2~ A1:4 r:4'].join('\n'),
    },
    caveats: [
      `Bass statistics come from the ${c.counts.deep} deep-analysed tracks only (${Math.round((100 * c.counts.deep) / Math.max(1, analysed))}% of the analysed ones).`,
      '38% of tracks read as either ~140 or ~70 BPM: the histogram uses the faster reading.',
    ],
  };
}

function rnbProfile(c: Collection, now: number): StyleProfile {
  const analysed = c.counts.light + c.counts.deep;
  return {
    collectionId: c.id,
    name: c.name,
    tracks: c.counts.total,
    analysed,
    deep: c.counts.deep,
    updatedAt: now - 3 * 3600_000,
    tempo: {
      bpm: pct(66, 72, 84, 92, 98),
      histogram: [
        { bpm: 64, count: 9 },
        { bpm: 68, count: 17 },
        { bpm: 72, count: 21 },
        { bpm: 76, count: 14 },
        { bpm: 80, count: 18 },
        { bpm: 84, count: 26 },
        { bpm: 88, count: 22 },
        { bpm: 92, count: 19 },
        { bpm: 96, count: 12 },
        { bpm: 100, count: 6 },
      ],
      halfTimeShare: 0.12,
    },
    swing: { median: 0.28, share: 0.62 },
    keys: {
      top: [
        { key: 'Eb', count: 19 },
        { key: 'Bbm', count: 17 },
        { key: 'Ab', count: 16 },
        { key: 'Fm', count: 15 },
        { key: 'Db', count: 13 },
        { key: 'Cm', count: 12 },
        { key: 'F', count: 10 },
        { key: 'Gm', count: 9 },
      ],
      minorShare: 0.44,
    },
    drums: {
      roles: {
        kick: grid([[0, 0.92], [10, 0.58], [20, 0.36], [22, 0.21]], 0.03, 21),
        snare: grid([[8, 0.93], [24, 0.94], [30, 0.12]], 0.02, 22),
        hat: grid([...every(0, 4, 0.82, 0.1, 5), ...every(2, 4, 0.31, 0.2, 6)], 0.01, 23),
        openhat: grid([[14, 0.12], [30, 0.16]], 0.01, 24),
        perc: grid([[6, 0.11], [18, 0.14], [26, 0.09]], 0.03, 25),
      },
      rollsPerBar: 0.03,
      tracks: analysed,
      source: 'mix',
    },
    bass: null,
    harmony: {
      progressions: [
        { degrees: ['IVmaj7', 'iii7', 'vi7', 'ii7'], count: 14 },
        { degrees: ['ii7', 'V7', 'Imaj7'], count: 12 },
        { degrees: ['vi7', 'ii7', 'V7', 'Imaj7'], count: 9 },
        { degrees: ['Imaj7', 'IVmaj7'], count: 8 },
      ],
      changesPerBar: 1.4,
      tracks: Math.round(analysed * 0.9),
    },
    structure: {
      sectionBars: pct(4, 8, 8, 8, 16),
      forms: [
        { form: ['A', 'B', 'C', 'B', 'C', 'D', 'C'], count: 41 },
        { form: ['A', 'B', 'C', 'B', 'C', 'C'], count: 33 },
        { form: ['B', 'C', 'B', 'C', 'D', 'C'], count: 18 },
      ],
      energyShape: [0.4, 0.5, 0.62, 0.74, 0.58, 0.66, 0.78, 0.8, 0.62, 0.7, 0.82, 0.86, 0.9, 0.78, 0.6, 0.38],
      lengthSec: pct(196, 218, 241, 262, 281),
    },
    mix: {
      lufs: pct(-13.1, -12.2, -11.1, -10.2, -9.4),
      truePeakDb: pct(-2.4, -1.6, -1.1, -0.6, -0.2),
      width: pct(0.38, 0.45, 0.52, 0.6, 0.68),
      bands: { sub: -4.2, low: 0, lowMid: -4.6, mid: -6.2, highMid: -9.8, high: -13.1 },
    },
    examples: {
      drums: [
        'pattern "90s R&B · sampled" bars=1 grid=16 key=Eb swing=28',
        'kick : x... .x.. ..x. .... ',
        'snare: .... x... .... x..o',
        'hat  : x.x. x.x. x.x. x.xx',
      ].join('\n'),
      bass: null,
    },
    caveats: [
      'Bass and melody statistics need deep analysis: none of these tracks is deep-analysed yet.',
      'The drum grid comes from the full mix (light pass): hats are estimated less reliably than kick and snare.',
      'Swing is strong in this collection; agents apply it as the pattern swing setting.',
    ],
  };
}

function thinProfile(c: Collection, now: number): StyleProfile {
  const analysed = c.counts.light + c.counts.deep;
  if (!analysed)
    return {
      collectionId: c.id,
      name: c.name,
      tracks: c.counts.total,
      analysed: 0,
      deep: 0,
      updatedAt: now,
      tempo: null,
      swing: null,
      keys: null,
      drums: null,
      bass: null,
      harmony: null,
      structure: null,
      mix: null,
      examples: { drums: null, bass: null },
      caveats: c.counts.total ? ['Nothing analysed yet: the profile fills in as the queue reaches this collection.'] : ['This collection is empty. Add a folder to build its profile.'],
    };
  return {
    collectionId: c.id,
    name: c.name,
    tracks: c.counts.total,
    analysed,
    deep: c.counts.deep,
    updatedAt: now - 60_000,
    tempo: {
      bpm: pct(72, 76, 82, 86, 90),
      histogram: [
        { bpm: 72, count: 1 },
        { bpm: 76, count: 2 },
        { bpm: 80, count: 1 },
        { bpm: 84, count: 2 },
        { bpm: 88, count: 1 },
      ],
      halfTimeShare: 0,
    },
    swing: { median: 0.34, share: 0.71 },
    keys: { top: [{ key: 'Dm', count: 2 }, { key: 'F', count: 2 }, { key: 'Am', count: 1 }, { key: 'C', count: 1 }], minorShare: 0.5 },
    drums: {
      roles: {
        kick: grid([[0, 0.8], [10, 0.4], [22, 0.3]], 0, 31),
        snare: grid([[8, 0.7], [24, 0.75]], 0, 32),
        hat: grid([...every(0, 4, 0.6, 0.3, 7)], 0, 33),
      },
      rollsPerBar: 0,
      tracks: analysed,
      source: 'mix',
    },
    bass: null,
    harmony: null,
    structure: null,
    mix: {
      lufs: pct(-15.8, -15, -13.9, -12.6, -11.8),
      truePeakDb: pct(-4.1, -3.2, -2.5, -1.9, -1.2),
      width: pct(0.3, 0.36, 0.44, 0.5, 0.57),
      bands: { sub: -8.4, low: 0, lowMid: -2.8, mid: -5.1, highMid: -10.9, high: -17.2 },
    },
    examples: { drums: ['pattern "Lo-fi · sampled" bars=1 grid=16 swing=34', 'kick : x... .... ..x. ....', 'snare: .... x... .... x...', 'hat  : x... x... x... x...'].join('\n'), bass: null },
    caveats: [
      `Only ${analysed} of ${c.counts.total} tracks are analysed: treat every number here as a rough sketch.`,
      'No chord estimates yet, so harmony is missing.',
      'Too few tracks with clear sections to describe the structure.',
      'Bass and melody statistics need deep analysis.',
    ],
  };
}

// ── The mock ──────────────────────────────────────────────────────────

export function createMockLibrary(host: DocHost, analyzer: KryptApi['analyzer']): LibraryApi {
  const now = Date.now();
  const collections: Collection[] = [];
  const tracks: LibraryTrack[] = [];
  let focus: LibraryFocus | null = null;
  const queue: LibraryQueueState = { running: true, paused: false, phase: 'light', done: 0, total: 0, current: null, etaSec: null };
  const SEC_PER_TRACK = 2.6;

  function addCollection(id: string, name: string, tags: string[], folder: string | null, deep: boolean): Collection {
    const c: Collection = { id, name, tags, createdAt: now - 86_400_000 * 9, folders: folder ? [folder] : [], deep, counts: { total: 0, pending: 0, light: 0, deep: 0, failed: 0, missing: 0 } };
    collections.push(c);
    return c;
  }

  function seed(c: Collection, style: Style, n: number, status: (i: number, r: () => number) => TrackStatus, seedBase: number): void {
    const folder = c.folders[0] ?? `${ROOT}\\${c.name}`;
    const r = rng(seedBase);
    for (let i = 0; i < n; i++) {
      const t = makeTrack(c.id, folder, style, i, seedBase, now);
      t.status = status(i, r);
      if (t.status !== 'pending') t.analyzedAt = now - Math.round(r() * 5e8);
      if (t.status === 'failed') t.error = FAIL_REASONS[i % FAIL_REASONS.length];
      if (t.status === 'missing') t.error = i % 2 ? 'Changed on disk since it was analysed (size differs). It is re-analysed on the next rescan.' : 'Not found at this path: moved, renamed or on a disconnected drive.';
      tracks.push(t);
    }
  }

  const dark = addCollection('c-dark', 'Dark trap', ['dark', 'trap', '140'], `${ROOT}\\Dark trap`, true);
  seed(dark, STYLES.dark, 1500, (i) => (i % 191 === 7 ? 'failed' : i % 397 === 11 ? 'missing' : i < 1180 ? (i % 8 === 0 ? 'deep' : 'light') : 'pending'), 101);
  const rnb = addCollection('c-rnb', '90s R&B', ['rnb', '90s', 'smooth'], `${ROOT}\\90s R&B`, false);
  seed(rnb, STYLES.rnb, 180, (i) => (i % 31 === 5 ? 'failed' : i % 61 === 9 ? 'missing' : 'light'), 202);
  const lofi = addCollection('c-lofi', 'Lo-fi sketches', ['lofi', 'chill'], `${ROOT}\\Lo-fi`, false);
  seed(lofi, STYLES.lofi, 24, (i) => (i < 7 ? 'light' : i === 7 ? 'failed' : 'pending'), 303);
  addCollection('c-ambient', 'Ambient ideas', ['ambient'], null, false);

  function recount(): void {
    for (const c of collections) c.counts = { total: 0, pending: 0, light: 0, deep: 0, failed: 0, missing: 0 };
    const byId = new Map(collections.map((c) => [c.id, c]));
    for (const t of tracks) {
      const c = byId.get(t.collectionId);
      if (!c) continue;
      c.counts.total++;
      c.counts[t.status]++;
    }
  }
  recount();
  // This "import session" started a while ago: part of the queue is done.
  const pendingAtStart = tracks.filter((t) => t.status === 'pending').length;
  queue.done = 820;
  queue.total = 820 + pendingAtStart;

  const subs = new Set<(s: LibraryState) => void>();
  const snapshot = (): LibraryState => ({
    collections: collections.map((c) => ({ ...c, tags: [...c.tags], folders: [...c.folders], counts: { ...c.counts } })),
    queue: { ...queue },
    focus: focus ? { ...focus } : null,
    dbPath: DB_PATH,
  });
  const emit = (): void => {
    const s = snapshot();
    subs.forEach((fn) => fn(s));
  };

  const nextPending = (): LibraryTrack | undefined => tracks.find((t) => t.status === 'pending');
  const nextDeep = (): LibraryTrack | undefined => {
    const deepCols = new Set(collections.filter((c) => c.deep).map((c) => c.id));
    return tracks.find((t) => t.status === 'light' && deepCols.has(t.collectionId));
  };
  let stemModel = false;
  const refreshStemModel = async (): Promise<void> => {
    try {
      const st = await analyzer.state();
      stemModel = st.models.some((m) => m.def.task === 'stems' && m.status === 'installed');
    } catch {
      stemModel = false;
    }
  };
  void refreshStemModel();
  analyzer.onState((st) => {
    stemModel = st.models.some((m) => m.def.task === 'stems' && m.status === 'installed');
  });

  const updateQueueMeta = (): void => {
    const pend = tracks.filter((t) => t.status === 'pending').length;
    const nxt = nextPending() ?? (stemModel ? nextDeep() : undefined);
    queue.phase = nextPending() ? 'light' : nxt ? 'deep' : null;
    queue.current = nxt?.path ?? null;
    queue.running = !queue.paused && !!nxt;
    if (!nxt) queue.done = queue.total;
    queue.etaSec = nxt ? Math.round(pend * SEC_PER_TRACK + (queue.phase === 'deep' ? 40 : 0)) : null;
  };
  updateQueueMeta();

  let tickN = 0;
  setInterval(() => {
    if (queue.paused) return;
    const t = nextPending() ?? (stemModel ? nextDeep() : undefined);
    if (!t) {
      if (queue.running) {
        updateQueueMeta();
        emit();
      }
      return;
    }
    tickN++;
    if (t.status === 'pending') {
      t.status = tickN % 37 === 0 ? 'failed' : 'light';
      if (t.status === 'failed') t.error = FAIL_REASONS[tickN % FAIL_REASONS.length];
    } else t.status = 'deep';
    t.analyzedAt = Date.now();
    queue.done = Math.min(queue.total, queue.done + 1);
    recount();
    updateQueueMeta();
    emit();
  }, 900);

  const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });
  const fail = (message: string): ActionResult<never> => ({ ok: false, message });
  const col = (id: string) => collections.find((c) => c.id === id);
  let addSeq = 0;

  function addFakeFiles(c: Collection, n: number, folder: string): { added: number; skipped: number } {
    const style = c.id === 'c-rnb' ? STYLES.rnb : c.id === 'c-lofi' ? STYLES.lofi : STYLES.dark;
    const base = 900 + ++addSeq * 1000;
    const r = rng(base);
    let added = 0;
    for (let i = 0; i < n; i++) {
      const t = makeTrack(c.id, folder, style, i, base, Date.now());
      t.id = `${c.id}-a${addSeq}-${i}`;
      t.addedAt = Date.now();
      if (tracks.some((x) => x.path === t.path && x.collectionId === c.id)) continue;
      tracks.push(t);
      added++;
    }
    queue.total += added;
    if (!queue.paused) queue.running = true;
    recount();
    updateQueueMeta();
    emit();
    return { added, skipped: Math.floor(r() * 3) };
  }

  function matches(q: TrackQuery, t: LibraryTrack): boolean {
    if (q.collectionId && t.collectionId !== q.collectionId) return false;
    if (q.status && t.status !== q.status) return false;
    const analysed = t.status === 'light' || t.status === 'deep' || t.status === 'missing';
    if ((q.bpmMin !== undefined || q.bpmMax !== undefined) && (!analysed || !t.bpm)) return false;
    if (q.bpmMin !== undefined && (t.bpm ?? 0) < q.bpmMin) return false;
    if (q.bpmMax !== undefined && (t.bpm ?? 0) > q.bpmMax) return false;
    if (q.key) {
      if (!analysed || !t.key) return false;
      if (q.key === 'minor' && !t.key.endsWith('m')) return false;
      if (q.key === 'major' && t.key.endsWith('m')) return false;
      if (q.key !== 'minor' && q.key !== 'major' && t.key !== q.key) return false;
    }
    if (q.text) {
      const s = q.text.toLowerCase();
      if (!t.name.toLowerCase().includes(s) && !t.path.toLowerCase().includes(s) && !t.tags.some((x) => x.toLowerCase().includes(s))) return false;
    }
    return true;
  }

  const sortVal = (t: LibraryTrack, k: NonNullable<TrackQuery['sort']>): number | string => {
    const analysed = t.status === 'light' || t.status === 'deep' || t.status === 'missing';
    switch (k) {
      case 'name':
        return t.name.toLowerCase();
      case 'bpm':
        return analysed ? (t.bpm ?? Infinity) : Infinity;
      case 'key':
        return analysed ? (t.key ?? '~') : '~';
      case 'added':
        return t.addedAt;
      case 'lufs':
        return analysed ? (t.lufs ?? Infinity) : Infinity;
      case 'duration':
        return t.status === 'failed' ? Infinity : (t.durationSec ?? Infinity);
    }
  };

  const api: LibraryApi = {
    state: async () => snapshot(),
    onState: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    createCollection: async (name, tags = []) => {
      await sleep(120);
      const n = name.trim();
      if (!n) return fail('A collection needs a name');
      if (collections.some((c) => c.name.toLowerCase() === n.toLowerCase())) return fail(`There is already a collection called ${n}`);
      const c = addCollection(`c-${Date.now().toString(36)}`, n, tags, null, false);
      c.createdAt = Date.now();
      emit();
      return ok({ ...c, counts: { ...c.counts } });
    },
    updateCollection: async (id, patch) => {
      await sleep(100);
      const c = col(id);
      if (!c) return fail('That collection no longer exists');
      if (patch.name !== undefined) c.name = patch.name.trim() || c.name;
      if (patch.tags) c.tags = [...patch.tags];
      if (focus?.collectionId === id) focus = { ...focus, name: c.name };
      emit();
      return ok({ ...c, counts: { ...c.counts } });
    },
    removeCollection: async (id) => {
      await sleep(150);
      const i = collections.findIndex((c) => c.id === id);
      if (i < 0) return fail('That collection no longer exists');
      collections.splice(i, 1);
      for (let j = tracks.length - 1; j >= 0; j--) if (tracks[j].collectionId === id) tracks.splice(j, 1);
      if (focus?.collectionId === id) focus = null;
      recount();
      updateQueueMeta();
      emit();
      return { ok: true };
    },
    addFolder: async (collectionId, path) => {
      await sleep(400);
      const c = col(collectionId);
      if (!c) return fail('That collection no longer exists');
      const folder = path || `${ROOT}\\New references ${addSeq + 1}`;
      if (!c.folders.includes(folder)) c.folders.push(folder);
      return ok(addFakeFiles(c, 40, folder));
    },
    addFiles: async (collectionId, paths) => {
      await sleep(250);
      const c = col(collectionId);
      if (!c) return fail('That collection no longer exists');
      return ok(addFakeFiles(c, paths?.length ?? 3, paths?.length ? (paths[0].split(/[\\/]/).slice(0, -1).join('\\') || ROOT) : `${ROOT}\\Loose files`));
    },
    removeTracks: async (ids) => {
      await sleep(120);
      const set = new Set(ids);
      for (let j = tracks.length - 1; j >= 0; j--) if (set.has(tracks[j].id)) tracks.splice(j, 1);
      recount();
      updateQueueMeta();
      emit();
      return { ok: true };
    },
    rescan: async (collectionId) => {
      await sleep(700);
      const c = col(collectionId);
      if (!c) return fail('That collection no longer exists');
      let changed = 0;
      for (const t of tracks)
        if (t.collectionId === c.id && t.status === 'missing' && changed < 1) {
          t.status = 'pending';
          t.error = undefined;
          changed++;
        }
      const missing = tracks.filter((t) => t.collectionId === c.id && t.status === 'missing').length;
      queue.total += changed;
      recount();
      updateQueueMeta();
      emit();
      return ok({ added: 0, changed, missing });
    },
    setDeep: async (collectionId, deep) => {
      await sleep(200);
      const c = col(collectionId);
      if (!c) return fail('That collection no longer exists');
      c.deep = deep;
      const queued = deep ? tracks.filter((t) => t.collectionId === c.id && t.status === 'light').length : 0;
      updateQueueMeta();
      emit();
      return ok({ queued });
    },
    estimateDeep: async (collectionId) => {
      await sleep(350);
      const c = col(collectionId);
      if (!c) return fail('That collection no longer exists');
      let device: 'cpu' | 'directml' = 'cpu';
      try {
        device = (await analyzer.state()).devices.includes('directml') ? 'directml' : 'cpu';
      } catch {
        /* cpu */
      }
      const n = tracks.filter((t) => t.collectionId === c.id && (t.status === 'light' || t.status === 'pending')).length;
      return ok({ tracks: n, seconds: n * (device === 'directml' ? 11 : 48), device });
    },
    setPaused: async (paused) => {
      queue.paused = paused;
      updateQueueMeta();
      emit();
      return { ok: true };
    },
    retryFailed: async (collectionId) => {
      await sleep(150);
      let queued = 0;
      for (const t of tracks)
        if (t.status === 'failed' && (!collectionId || t.collectionId === collectionId)) {
          t.status = 'pending';
          t.error = undefined;
          queued++;
        }
      queue.total += queued;
      recount();
      updateQueueMeta();
      emit();
      return ok({ queued });
    },
    query: async (q) => {
      await sleep(40 + Math.random() * 60);
      const list = tracks.filter((t) => matches(q, t));
      const k = q.sort ?? 'name';
      const dir = q.desc ? -1 : 1;
      // Unknown values (not analysed yet) sort last in both directions.
      const unknown = (v: number | string): boolean => v === Infinity || v === '~';
      list.sort((a, b) => {
        const va = sortVal(a, k);
        const vb = sortVal(b, k);
        if (unknown(va) !== unknown(vb)) return unknown(va) ? 1 : -1;
        if (va === vb) return a.name.localeCompare(b.name);
        return (va < vb ? -1 : 1) * dir;
      });
      const offset = Math.max(0, q.offset ?? 0);
      const limit = Math.max(1, Math.min(1000, q.limit ?? 200));
      return ok({ tracks: list.slice(offset, offset + limit).map(visible), total: list.length });
    },
    track: async (id) => {
      await sleep(60);
      const t = tracks.find((x) => x.id === id);
      if (!t) return fail('That track is no longer in the library');
      const analysed = t.status === 'light' || t.status === 'deep';
      const detail: TrackDetail = {
        ...visible(t),
        features: analysed ? { analysis: fakeAnalysis(t.path, t.durationSec ?? 180), drums: null, chords: [], lines: {}, vector: [] } : null,
      };
      return ok(detail);
    },
    profile: async (collectionId) => {
      await sleep(350 + Math.random() * 300);
      const c = col(collectionId);
      if (!c) return fail('That collection no longer exists');
      const t = Date.now();
      return ok(c.id === 'c-dark' ? darkProfile(c, t) : c.id === 'c-rnb' ? rnbProfile(c, t) : thinProfile(c, t));
    },
    similar: async (trackId, opts) => {
      await sleep(300);
      const t = tracks.find((x) => x.id === trackId);
      if (!t) return fail('That track is no longer in the library');
      const pool = tracks.filter((x) => x.id !== t.id && (x.status === 'light' || x.status === 'deep') && (!opts?.collectionId || x.collectionId === opts.collectionId));
      const r = rng(hashStr(trackId) + (opts?.collectionId ? 1 : 2));
      const picked: LibraryTrack[] = [];
      for (let i = 0; i < Math.min(opts?.limit ?? 20, pool.length); i++) picked.push(pool[Math.floor(r() * pool.length)]);
      const uniq = [...new Map(picked.map((x) => [x.id, x])).values()];
      let score = 0.93 + r() * 0.05;
      return ok(
        uniq.map((x) => {
          score = Math.max(0.41, score - r() * 0.05);
          return { track: visible(x), score: Math.round(score * 1000) / 1000 };
        }),
      );
    },
    checkOriginality: async (opts) => {
      await sleep(1100);
      const p = host.project;
      const refs = tracks.filter((t) => t.status === 'deep');
      // Lines = pattern × channel with notes (the mock fakes one when the project has none).
      const lines: Array<{ label: string; patternId: string; channelId: string }> = [];
      for (const pid of p.patternOrder) {
        if (opts?.patternId && pid !== opts.patternId) continue;
        const pat = p.patterns[pid];
        for (const [chId, notes] of Object.entries(pat.notes)) {
          if (Object.keys(notes).length && p.channels[chId]) lines.push({ label: `Pattern "${pat.name}" · ${p.channels[chId].name}`, patternId: pid, channelId: chId });
        }
      }
      if (!lines.length) {
        const pid = opts?.patternId ?? p.patternOrder[0];
        const chId = p.channelOrder[0];
        if (pid && chId) lines.push({ label: `Pattern "${p.patterns[pid]?.name ?? 'Pattern 1'}" · ${p.channels[chId]?.name ?? 'Channel'}`, patternId: pid, channelId: chId });
      }
      if (!refs.length)
        return ok({
          checkedLines: lines.length,
          references: 0,
          matches: [],
          summary: 'No deep-analysed references yet, so there is nothing to compare against.',
        });
      const r = rng(hashStr(lines.map((l) => l.patternId).join()) + refs.length);
      const found: OriginalityMatch[] = [];
      const want = opts?.patternId ? 1 : Math.min(3, lines.length + 2);
      for (let i = 0; i < want && lines.length; i++) {
        const l = lines[i % lines.length];
        const ref = refs[Math.floor(r() * refs.length)];
        found.push({
          line: l.label,
          patternId: l.patternId,
          channelId: l.channelId,
          trackId: ref.id,
          trackName: ref.name,
          stem: i % 2 ? 'vocals' : 'other',
          notes: 8 + Math.floor(r() * 7),
          atBar: 1 + Math.floor(r() * 12),
          refAtSec: 20 + r() * 120,
          similarity: Math.round((0.72 + r() * 0.26) * 100) / 100,
        });
      }
      const worst = found.reduce((a, b) => (b.similarity > a.similarity ? b : a), found[0]);
      return ok({
        checkedLines: lines.length,
        references: refs.length,
        matches: found,
        summary: found.length
          ? `${found.length === 1 ? 'One run' : `${found.length} runs`} of 8 or more notes closely follow a reference. The closest: ${worst.line}, bar ${worst.atBar}, matches "${worst.trackName}" (${Math.round(worst.similarity * 100)}%). Reshape those bars before you release. This is a production aid, not legal advice.`
          : 'No run of 8 or more notes matches a reference. This is a production aid, not legal advice.',
      });
    },
    setFocus: async (f) => {
      await sleep(120);
      if (!f) {
        focus = null;
        emit();
        return ok(null);
      }
      const c = col(f.collectionId);
      if (!c) return fail('That collection no longer exists');
      focus = { collectionId: c.id, name: c.name, brief: (f.brief ?? '').trim() };
      emit();
      return ok({ ...focus });
    },
    addToProject: async (trackId) => {
      await sleep(200);
      const t = tracks.find((x) => x.id === trackId);
      if (!t) return fail('That track is no longer in the library');
      if (t.status === 'missing') return fail(`${t.name} is missing on disk`);
      const p = host.project;
      const lane = p.playlist.trackOrder.find((id) => !Object.values(p.playlist.clips).some((c) => c.trackId === id)) ?? p.playlist.trackOrder[p.playlist.trackOrder.length - 1];
      if (!lane) return fail('The playlist has no tracks');
      const sr = 48000;
      const res = host.exec('playlist.addAudio', { path: t.path, name: t.name, trackId: lane, start: 0, frames: Math.round((t.durationSec ?? 180) * sr), sampleRate: sr, channels: 2 }, { actor: USER });
      if (!res.ok) return fail(res.message ?? "Couldn't add the clip");
      const d = res.data as { clipId: string; channelId: string };
      return ok({ clipId: d.clipId, channelId: d.channelId });
    },
  };

  (window as unknown as { __kryptMockLibrary?: unknown }).__kryptMockLibrary = { collections, tracks, queue, emit, recount, updateQueueMeta };
  return api;
}
