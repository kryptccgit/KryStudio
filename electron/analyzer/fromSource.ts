export const SOURCE_WAV = 'source.wav';
export const PRE_SEC = 0.003;
export const TAIL_SEC = 0.25;
export const JOIN_SEC = 0.02;
const SLOTS = 127;

export interface SourceEvent {
  startSec: number;
  untilSec: number;
  key: number;
  vel: number;
}

export interface SourceInstrument {
  sfz: string;
  vel: number[];
  regions: number;
}

export function slotOf(i: number, m: number): number {
  return m <= 1 ? 100 : 1 + Math.round((i * (SLOTS - 1)) / (m - 1));
}

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

export const SAME_HIT_SEC = 0.015;
export const MAX_HIT_SEC = 2;

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
