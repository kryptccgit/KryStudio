// Instruments built from the transcribed audio itself, so a converted pattern
// sounds like the original instead of like a stand-in synth.
//
// Every transcribed note (or drum hit) becomes one SFZ region on a copy of the
// source file (`source.wav` next to the .sfz): offset = the note's start, end =
// where the next note takes over. Regions of one key are told apart by
// VELOCITY: each gets its own slot 1..127 (quieter originals on lower slots),
// and the pattern note is written with exactly that velocity, so on playback
// every note plays its own original audio, i.e. the pattern re-creates the
// source. Edited notes still play real audio: a moved note keeps its slot, a
// transposed one plays the nearest key's region pitched (key ranges reach
// halfway to the next recorded key), a drawn one plays the recording nearest
// its velocity. amp_veltrack=0: loudness comes from the recording, the
// velocity only picks which recording.
// Pure (no I/O), tested in test/analyzer-from-source.test.ts.

export const SOURCE_WAV = 'source.wav';
/** Regions start this much before the note (the attack's first samples). */
export const PRE_SEC = 0.003;
/** A region may ring this long past its note when nothing follows. */
export const TAIL_SEC = 0.25;
/** …and this far into the next note (a short overlap so the hand-over has no gap). */
export const JOIN_SEC = 0.02;
const SLOTS = 127;

export interface SourceEvent {
  startSec: number;
  /** Where this event's audio must stop (the next event's start + JOIN_SEC, or its end + TAIL_SEC). */
  untilSec: number;
  key: number;
  /** 0..1, orders the velocity slots. */
  vel: number;
}

export interface SourceInstrument {
  /** The .sfz text (regions on SOURCE_WAV). */
  sfz: string;
  /** Per event (same order as given): the note velocity 0..1 that plays its own region. */
  vel: number[];
  regions: number;
}

/** Velocity slot of region i of m: spread over 1..127. */
export function slotOf(i: number, m: number): number {
  return m <= 1 ? 100 : 1 + Math.round((i * (SLOTS - 1)) / (m - 1));
}

/**
 * Mono lines: each note's audio runs to the next note's start (+ JOIN_SEC), or TAIL_SEC past its own end when the
 * next note is further away; never past the file.
 */
export function monoEvents(notes: Array<{ startSec: number; durSec: number; key: number; vel: number }>, fileSec: number): SourceEvent[] {
  const order = notes.map((_, i) => i).sort((a, b) => notes[a].startSec - notes[b].startSec);
  const out: SourceEvent[] = new Array(notes.length);
  order.forEach((i, k) => {
    const n = notes[i];
    const next = k + 1 < order.length ? notes[order[k + 1]].startSec : Infinity;
    const end = n.startSec + Math.max(0, n.durSec);
    const until = Math.min(fileSec, end + TAIL_SEC, next + JOIN_SEC);
    out[i] = { startSec: n.startSec, untilSec: Math.max(until, Math.min(fileSec, end)), key: n.key, vel: n.vel };
  });
  return out;
}

/**
 * More than 127 events on one key: 127 shared regions. With `features` (one timbre vector per event, e.g. band
 * levels), the regions are picked to cover the different sounds (farthest-point medoids, the longest slice first)
 * and every event plays the nearest-sounding one: a looped beat repeats near-identical hits, so this stays close to
 * the original (measured on a real drum stem: 93% of frames vs 77% sharing by loudness). Without features: velocity
 * bands, each played by its longest slice. Returns, per group, the event indices it covers and its region event.
 */
export function shareRegions(ids: number[], events: SourceEvent[], features?: Array<number[] | null>): Array<{ rep: number; members: number[] }> {
  const len = (i: number) => events[i].untilSec - events[i].startSec;
  if (ids.length <= SLOTS) return ids.map((i) => ({ rep: i, members: [i] }));
  const fv = features && ids.every((i) => Array.isArray(features[i]) && features[i]!.length) ? ids.map((i) => features[i]!) : null;
  if (!fv) {
    const sorted = [...ids].sort((a, b) => events[a].vel - events[b].vel || events[a].startSec - events[b].startSec);
    return Array.from({ length: SLOTS }, (_, g) => sorted.slice(Math.floor((g * sorted.length) / SLOTS), Math.floor(((g + 1) * sorted.length) / SLOTS))).map((members) => ({
      rep: members.reduce((a, b) => (len(b) > len(a) ? b : a)),
      members,
    }));
  }
  const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, v, k) => s + (v - (b[k] ?? 0)) ** 2, 0));
  let first = 0;
  ids.forEach((i, k) => {
    if (len(i) > len(ids[first])) first = k;
  });
  const chosen = [first];
  const d = fv.map((v) => dist(v, fv[first]));
  while (chosen.length < SLOTS) {
    let far = 0;
    for (let k = 1; k < d.length; k++) if (d[k] > d[far]) far = k;
    chosen.push(far);
    fv.forEach((v, k) => (d[k] = Math.min(d[k], dist(v, fv[far]))));
  }
  const groups = chosen.map((c) => ({ rep: ids[c], members: [] as number[] }));
  fv.forEach((v, k) => {
    let best = 0;
    for (let g = 1; g < chosen.length; g++) if (dist(v, fv[chosen[g]]) < dist(v, fv[chosen[best]])) best = g;
    groups[best].members.push(ids[k]);
  });
  return groups;
}

export function sourceInstrument(events: SourceEvent[], opts: { sampleRate: number; frames: number; name: string; features?: Array<number[] | null> }): SourceInstrument {
  const sr = opts.sampleRate;
  const last = Math.max(0, opts.frames - 1);
  const vel = new Array<number>(events.length).fill(100 / SLOTS);
  const byKey = new Map<number, number[]>();
  events.forEach((e, i) => {
    if (!(e.untilSec > e.startSec) || !Number.isFinite(e.startSec)) return;
    const list = byKey.get(e.key) ?? [];
    list.push(i);
    byKey.set(e.key, list);
  });
  const keys = [...byKey.keys()].sort((a, b) => a - b);
  const lines: string[] = [
    `// Krypt Studio: "${opts.name.replace(/[\r\n]/g, ' ')}" as an instrument. Each region is one note of the original;`,
    '// the note velocity picks it (amp_veltrack=0: the loudness is the recording\'s own).',
    '<global> amp_veltrack=0 ampeg_attack=0.001 ampeg_release=0.03 loop_mode=no_loop',
  ];
  let regions = 0;
  keys.forEach((key, ki) => {
    const lokey = ki === 0 ? 0 : Math.floor((keys[ki - 1] + key) / 2) + 1;
    const hikey = ki === keys.length - 1 ? 127 : Math.floor((key + keys[ki + 1]) / 2);
    // Regions (one per event, or 127 shared ones), quieter originals on lower slots.
    const groups = shareRegions(byKey.get(key)!, events, opts.features).sort((a, b) => events[a.rep].vel - events[b.rep].vel || events[a.rep].startSec - events[b.rep].startSec);
    const bands = groups.length;
    lines.push(`<group> lokey=${lokey} hikey=${hikey} pitch_keycenter=${key}`);
    groups.forEach(({ rep, members: g }, gi) => {
      const slot = slotOf(gi, bands);
      const lo = gi === 0 ? 1 : Math.floor((slotOf(gi - 1, bands) + slot) / 2) + 1;
      const hi = gi === bands - 1 ? SLOTS : Math.floor((slot + slotOf(gi + 1, bands)) / 2);
      const e = events[rep];
      const offset = Math.min(last, Math.max(0, Math.round((e.startSec - PRE_SEC) * sr)));
      const end = Math.min(last, Math.max(offset + 1, Math.round(e.untilSec * sr)));
      lines.push(`<region> sample=${SOURCE_WAV} lovel=${lo} hivel=${hi} offset=${offset} end=${end}`);
      regions++;
      for (const i of g) vel[i] = slot / SLOTS;
    });
  });
  return { sfz: lines.join('\n') + '\n', vel, regions };
}

/** Hits closer than this are one moment of the recording: the loudest keeps it. */
export const SAME_HIT_SEC = 0.015;
/** A drum slice never runs longer than this (a hit followed by a long silence). */
export const MAX_HIT_SEC = 2;

/**
 * Drums: hits sorted by time, simultaneous ones (within SAME_HIT_SEC) merged into the loudest (the slice already
 * holds all of them, so playing each would double it); each kept hit's slice runs to the next kept hit.
 */
export function drumEvents<R extends string>(hits: Array<{ timeSec: number; role: R; vel: number }>, fileSec: number): Array<{ role: R; event: SourceEvent }> {
  const sorted = hits.filter((h) => Number.isFinite(h.timeSec) && h.timeSec >= 0 && h.timeSec < fileSec).sort((a, b) => a.timeSec - b.timeSec);
  const kept: Array<{ timeSec: number; role: R; vel: number }> = [];
  let groupStart = -Infinity;
  for (const h of sorted) {
    const last = kept[kept.length - 1];
    if (last && h.timeSec - groupStart <= SAME_HIT_SEC) {
      if (h.vel > last.vel) kept[kept.length - 1] = { ...h, timeSec: last.timeSec };
      continue;
    }
    groupStart = h.timeSec;
    kept.push(h);
  }
  return kept.map((h, i) => {
    const next = i + 1 < kept.length ? kept[i + 1].timeSec - PRE_SEC : Infinity;
    const until = Math.min(fileSec, next, h.timeSec + MAX_HIT_SEC);
    return { role: h.role, event: { startSec: h.timeSec, untilSec: Math.max(until, h.timeSec + 0.005), key: 60, vel: h.vel } };
  });
}
