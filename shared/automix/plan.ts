import type { FxSlot, MixerInsert, Project } from '../schema/project';
import type { PluginCatalog } from '../plugins/types';
import type { SlotGainReduction } from '../engine/protocol';
import type { AutoMixChange, AutoMixIntent, AutoMixMode, AutoMixPreset } from './types';
import { AUTO_SENDS, BANDS, type Band, type Bands, type InsertInfo } from './roles';
import { planTune } from '../vocals/plan';

const VOCAL_FADER_MAX = 3;

export type KryptKind = 'eq' | 'comp' | 'deesser' | 'glue' | 'heat' | 'imager' | 'clipper' | 'limiter' | 'duck';

export const KIND_TYPE: Record<KryptKind, string> = {
  eq: 'krypt.eq',
  comp: 'krypt.comp',
  deesser: 'krypt.deesser',
  glue: 'krypt.glue',
  heat: 'krypt.heat',
  imager: 'krypt.imager',
  clipper: 'krypt.clipper',
  limiter: 'krypt.limiter',
  duck: 'krypt.duck',
};

export const MARK: Record<KryptKind, { param: string; value: number }> = {
  eq: { param: 'b7Freq', value: 19990 },
  comp: { param: 'knee', value: 5.95 },
  deesser: { param: 'mix', value: 0.995 },
  glue: { param: 'range', value: 39.5 },
  heat: { param: 'lowFreq', value: 199.5 },
  imager: { param: 'highFreq', value: 3999.5 },
  clipper: { param: 'softness', value: 0.451 },
  limiter: { param: 'release', value: 0.5 },
  duck: { param: 'curve', value: 0.505 },
};

export function isKryptSlot(slot: FxSlot | undefined, kind?: KryptKind): boolean {
  if (!slot) return false;
  const kinds = kind ? [kind] : (Object.keys(KIND_TYPE) as KryptKind[]);
  return kinds.some((k) => {
    if (slot.type !== KIND_TYPE[k]) return false;
    const v = slot.params[MARK[k].param];
    if (typeof v !== 'number') return false;
    if (k === 'limiter') return Math.abs(v - Math.floor(v) - 0.5) < 0.01;
    if (k === 'eq' && (slot.params.b7On ?? 0) !== 0) return false;
    return Math.abs(v - MARK[k].value) < 1e-3;
  });
}

export function findKryptSlot(ins: MixerInsert | undefined, kind: KryptKind, keepUserFx: boolean): string | null {
  if (!ins) return null;
  const own = ins.slotOrder.find((s) => isKryptSlot(ins.slots[s], kind));
  if (own) return own;
  if (keepUserFx) return null;
  return ins.slotOrder.find((s) => ins.slots[s]?.type === KIND_TYPE[kind] && !isKryptSlot(ins.slots[s])) ?? null;
}

const markParams = (kind: KryptKind, release?: number): Record<string, number> => {
  if (kind === 'limiter') return { release: Math.floor(release ?? 60) + 0.5 };
  if (kind === 'eq') return { b7On: 0, b7Freq: MARK.eq.value };
  return { [MARK[kind].param]: MARK[kind].value };
};

export function masterDrive(p: Project, keepUserFx: boolean, insertId?: string): number {
  const m = p.mixer.inserts[insertId ?? p.mixer.masterId];
  if (!m) return 0;
  const lim = findKryptSlot(m, 'limiter', keepUserFx);
  const eq = findKryptSlot(m, 'eq', keepUserFx);
  return (lim ? (m.slots[lim].params.inputGain ?? 0) : 0) + (eq ? (m.slots[eq].params.output ?? 0) : 0);
}

const ORDER: KryptKind[] = ['duck', 'eq', 'deesser', 'comp', 'glue', 'heat', 'imager', 'clipper', 'limiter'];

export interface InsertMeasure {
  lufs: number | null;
  peakDb: number | null;
  crestDb: number | null;
  bands: Bands | null;
  centroidHz?: number | null;
}

export interface MasterMeasure {
  lufs: number;
  truePeak: number;
  peakDb: number | null;
  crestDb: number | null;
  lra: number;
  tone: Bands;
  correlation: number;
  width?: number | null;
}

export interface PlanMeasure {
  master: MasterMeasure;
  inserts: Record<string, InsertMeasure>;
  gr: SlotGainReduction[];
}

export interface PlanInput {
  mode: AutoMixMode;
  preset: AutoMixPreset;
  intent: AutoMixIntent | null;
  target: { lufs: number; truePeak: number };
  keepUserFx: boolean;
  project: Project;
  catalog: PluginCatalog;
  measure: PlanMeasure;
  roles: Record<string, InsertInfo>;
  pass: number;
  loudHistory?: Array<{ drive: number; lufs: number }>;
  tune?: { style: 'natural' | 'pop' | 'hard'; key: { root: number; scale: number; name: string } | null } | null;
  masterInsertId?: string;
  tone?: Bands | null;
  widthTarget?: number | null;
}

export type PlanOp =
  | { op: 'slot'; key: string; insertId: string; kind: KryptKind; params: Record<string, number>; enabled?: boolean; mix?: number; sidechainFrom?: string | null; place?: 'first'; target: string; what: string }
  | { op: 'disable'; key: string; insertId: string; kind: KryptKind; target: string; what: string }
  | { op: 'volume'; key: string; insertId: string; db: number; target: string; what: string }
  | { op: 'send'; key: string; from: string; send: 'reverb' | 'delay'; chainId: string; levelDb: number | null; target: string; what: string }
  | { op: 'tune'; key: string; insertId: string; style: 'natural' | 'pop' | 'hard'; root: number; scale: number; target: string; what: string };

export interface Plan {
  ops: PlanOp[];
  notes: string[];
  converged: boolean;
  vocalVsBeat: number | null;
  vocalTarget: number | null;
  drive: number | null;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const r1 = (x: number): number => Math.round(x * 10) / 10;
const r05 = (x: number): number => Math.round(x * 2) / 2;
export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => (g > 1e-6 ? 20 * Math.log10(g) : -120);
const sgn = (x: number): string => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(r1(x))}`;
const hz = (f: number): string => (f >= 1000 ? `${r1(f / 1000)} kHz` : `${Math.round(f)} Hz`);
const powerSum = (dbs: number[]): number | null => {
  const v = dbs.filter((d) => isNum(d) && d > -70);
  return v.length ? 10 * Math.log10(v.reduce((s, d) => s + Math.pow(10, d / 10), 0)) : null;
};
const iv = (i: AutoMixIntent | null, k: keyof AutoMixIntent): number => {
  const v = i?.[k];
  return typeof v === 'number' ? v : 0;
};

function grOf(m: PlanMeasure, insertId: string, slotId: string | null): SlotGainReduction | null {
  if (!slotId) return null;
  return m.gr.find((g) => g.insertId === insertId && g.slotId === slotId) ?? null;
}

function feedback(cur: number, measured: number, target: number, opts: { dead: number; k: number; lo: number; hi: number }): number {
  const dev = measured - target;
  if (Math.abs(dev) <= opts.dead) return clamp(cur, opts.lo, opts.hi);
  return r05(clamp(cur - opts.k * (dev - Math.sign(dev) * (opts.dead * 0.5)), opts.lo, opts.hi));
}

function thresholdFromGr(cur: number, gr: SlotGainReduction | null, targetGr: number, lo: number, hi: number): number {
  if (!gr || !isNum(gr.avgDb)) return cur;
  const working = isNum(gr.active) && gr.active > 0.02 ? Math.min(gr.avgDb / gr.active, isNum(gr.maxDb) ? gr.maxDb : Infinity) : gr.avgDb;
  const d = working - targetGr;
  if (Math.abs(d) < 0.6) return cur;
  return r05(clamp(cur + clamp(d * 0.8, -6, 6), lo, hi));
}

const rel = (b: Bands | null, k: Band): number | null => (b && isNum(b[k]) && isNum(b.mid) ? b[k] - b.mid : null);

interface Ctx {
  in: PlanInput;
  ops: PlanOp[];
  notes: string[];
  p: Project;
}

function insName(c: Ctx, id: string): string {
  const ins = c.p.mixer.inserts[id];
  return ins?.isMaster ? 'Master' : (ins?.name ?? id);
}

function pluginName(c: Ctx, kind: KryptKind): string {
  return c.in.catalog.plugins.find((x) => x.id === KIND_TYPE[kind])?.name ?? KIND_TYPE[kind];
}

function has(c: Ctx, kind: KryptKind): boolean {
  return c.in.catalog.plugins.some((x) => x.id === KIND_TYPE[kind]);
}

function cur(c: Ctx, insertId: string, kind: KryptKind): { slotId: string | null; params: Record<string, number> } {
  const ins = c.p.mixer.inserts[insertId];
  const id = findKryptSlot(ins, kind, c.in.keepUserFx);
  return { slotId: id, params: id ? { ...ins!.slots[id].params } : {} };
}

function plannedMove(c: Ctx, id: string): number {
  const op = c.ops.find((o) => o.op === 'volume' && o.insertId === id) as Extract<PlanOp, { op: 'volume' }> | undefined;
  const ins = c.p.mixer.inserts[id];
  return op && ins ? op.db - gainToDb(ins.volume) : 0;
}

function plannedMasterShift(c: Ctx): number {
  const top = Object.values(c.in.roles).filter((r) => r.topLevel && r.role !== 'send');
  const now: number[] = [];
  const next: number[] = [];
  for (const r of top) {
    const l = c.in.measure.inserts[r.id]?.lufs;
    if (!isNum(l)) continue;
    now.push(l);
    next.push(l + plannedMove(c, r.id));
  }
  const a = powerSum(now);
  const b = powerSum(next);
  return a !== null && b !== null ? b - a : 0;
}

function slot(c: Ctx, insertId: string, kind: KryptKind, params: Record<string, number>, what: string, extra: Partial<Extract<PlanOp, { op: 'slot' }>> = {}): void {
  if (!has(c, kind)) return;
  c.ops.push({ op: 'slot', key: `${insertId}/${kind}`, insertId, kind, params, target: `${insName(c, insertId)} ▸ ${pluginName(c, kind)}`, what, ...extra });
}

export function vocalVsBeat(m: PlanMeasure, roles: Record<string, InsertInfo>): { vocal: number; beat: number; delta: number } | null {
  const all = Object.values(roles);
  const vocals = all.filter((r) => r.vocal);
  if (!vocals.length) return null;
  const vocal = powerSum(vocals.map((r) => m.inserts[r.id]?.lufs ?? Number.NaN));
  const beat = powerSum(all.filter((r) => !r.vocal && r.topLevel && r.role !== 'send').map((r) => m.inserts[r.id]?.lufs ?? Number.NaN));
  if (vocal === null || beat === null) return null;
  return { vocal: r1(vocal), beat: r1(beat), delta: r1(vocal - beat) };
}

function planVocals(c: Ctx): { delta: number | null; target: number | null } {
  const { preset, intent, measure } = c.in;
  const vocals = Object.values(c.in.roles).filter((r) => r.vocal);
  if (!vocals.length) return { delta: null, target: null };
  const bright = preset.brightness;
  const lh = iv(intent, 'lessHarsh');
  const vf = iv(intent, 'vocalsForward');
  const br = iv(intent, 'brighter');
  const punch = clamp(preset.punch + 0.15 * iv(intent, 'punchier'), 0, 1);
  const rap = ['loud-trap', 'hiphop-punch', 'phonk-slam'].includes(preset.id);
  for (const v of vocals) {
    const m = measure.inserts[v.id];
    const ins = c.p.mixer.inserts[v.id];
    if (!ins) continue;
    const volDb = gainToDb(ins.volume);
    const eq = cur(c, v.id, 'eq');
    const tdead = eq.slotId ? 2.5 : 1.5;
    const tk = eq.slotId ? 0.4 : 0.6;
    const hp = preset.id === 'podcast-voice' ? 80 : rap ? 90 : 100;
    const t = { lowMid: -1, highMid: -4 + 2 * bright + br - lh, high: -11 + 4 * bright + 1.5 * br - lh };
    const g3 = rel(m?.bands ?? null, 'lowMid');
    const g4 = rel(m?.bands ?? null, 'highMid');
    const g6 = rel(m?.bands ?? null, 'high');
    const p: Record<string, number> = { b1On: 1, b1Freq: hp, b1Slope: 1, b2On: 0, b3On: 1, b3Freq: 300, b3Q: 1.2, b4On: 1, b4Freq: 3000, b4Q: 0.8, b6On: 1, b6Freq: 12000, b6Q: 0.7, ...markParams('eq') };
    p.b3Gain = g3 === null ? (eq.params.b3Gain ?? -1.5) : feedback(eq.params.b3Gain ?? 0, g3, t.lowMid, { dead: tdead, k: tk, lo: -5, hi: 1 });
    p.b4Gain = g4 === null ? (eq.params.b4Gain ?? r05(clamp(0.5 + 1.5 * bright + 0.75 * br, -3, 4))) : feedback(eq.params.b4Gain ?? 0, g4, t.highMid, { dead: tdead, k: tk, lo: -3, hi: 4 });
    p.b6Gain = g6 === null ? (eq.params.b6Gain ?? r05(clamp(1 + 3 * bright + br - 0.75 * lh, -2, 5))) : feedback(eq.params.b6Gain ?? 0, g6, t.high, { dead: tdead, k: tk, lo: -3, hi: 5 });
    const deess = has(c, 'deesser');
    if (deess) Object.assign(p, { b5On: 0 });
    else Object.assign(p, { b5On: 1, b5Freq: 7000, b5Q: 4, b5Gain: r05(clamp(-(2 + lh), -4, -1)) });
    const parts = [`high-pass ${hp} Hz`, p.b3Gain ? `${sgn(p.b3Gain)} dB at 300 Hz${p.b3Gain < 0 ? ' (mud)' : ''}` : '', p.b4Gain ? `presence ${sgn(p.b4Gain)} dB at 3 kHz` : '', p.b6Gain ? `air ${sgn(p.b6Gain)} dB` : '', deess ? '' : `${sgn(p.b5Gain)} dB at 7 kHz (sibilance)`];
    slot(c, v.id, 'eq', p, parts.filter(Boolean).join(', '));
    if (deess) {
      const de = cur(c, v.id, 'deesser');
      const range = r05(clamp(6 + 2 * lh, 3, 12));
      const targetMax = clamp(4 + lh, 2, 8);
      let thr = de.params.threshold;
      if (!isNum(thr)) thr = clamp(r05((m?.lufs ?? -20) - volDb - 6 - 2 * lh), -50, -12);
      else {
        const gr = grOf(measure, v.id, de.slotId);
        if (gr && isNum(gr.maxDb) && Math.abs(gr.maxDb - targetMax) > 1) thr = r05(clamp(thr + clamp((gr.maxDb - targetMax) * 0.8, -6, 6), -60, -6));
      }
      slot(c, v.id, 'deesser', { frequency: bright > 0.6 ? 7000 : 6500, threshold: thr, range, listen: 0, ...markParams('deesser') }, `de-ess above ${hz(bright > 0.6 ? 7000 : 6500)}, threshold ${r1(thr)} dB, up to ${range} dB`);
    }
    const crest = m?.crestDb ?? 14;
    const ratio = (crest >= 18 ? 4 : crest >= 14 ? 3 : 2.5) + (punch > 0.7 ? 1 : 0);
    const attack = punch > 0.7 ? 3 : 8;
    const release = Math.round(80 + 60 * (1 - punch));
    const cp = cur(c, v.id, 'comp');
    const grTarget = clamp(2 + (crest - 10) * 0.25 + punch, 2, 6);
    let thr = cp.params.threshold;
    if (!isNum(thr)) thr = clamp(r05((m?.peakDb ?? -6) - volDb - (6 + Math.max(0, crest - 12) * 0.5)), -50, -6);
    else thr = thresholdFromGr(thr, grOf(measure, v.id, cp.slotId), grTarget, -60, 0);
    slot(c, v.id, 'comp', { threshold: thr, ratio, attack, release, autoMakeup: 1, detector: 1, useSidechain: 0, ...markParams('comp') }, `${ratio}:1, threshold ${r1(thr)} dB (about ${r1(grTarget)} dB of reduction), ${attack} ms attack`);
    if (c.in.tune) {
      if (!c.in.tune.key) c.notes.push(`Krypt Tune was asked for, but the song's key couldn't be read: tune "${v.name}" with Krypt Tune and a key (tune_vocal).`);
      else if (!c.in.keepUserFx || !ins.slotOrder.some((s) => ins.slots[s]?.type === 'krypt.pitch')) {
        c.ops.push({ op: 'tune', key: `${v.id}/tune`, insertId: v.id, style: c.in.tune.style, root: c.in.tune.key.root, scale: c.in.tune.key.scale, target: `${v.name} ▸ Krypt Tune`, what: `${c.in.tune.style} correction in ${c.in.tune.key.name}` });
      } else c.notes.push(`"${v.name}" already has Krypt Tune: left as it is.`);
    }
    const space = clamp(preset.vocalSpace + 0.2 * iv(intent, 'vocalSpace'), 0, 1);
    if (space < 0.1) {
      c.ops.push({ op: 'send', key: `${v.id}/send/reverb`, from: v.id, send: 'reverb', chainId: '', levelDb: null, target: `${v.name} ▸ ${AUTO_SENDS.reverb}`, what: 'no reverb send (dry)' });
      c.ops.push({ op: 'send', key: `${v.id}/send/delay`, from: v.id, send: 'delay', chainId: '', levelDb: null, target: `${v.name} ▸ ${AUTO_SENDS.delay}`, what: 'no delay send (dry)' });
    } else {
      const rv = r05(-26 + 14 * space);
      const dl = r05(-30 + 12 * space);
      c.ops.push({ op: 'send', key: `${v.id}/send/reverb`, from: v.id, send: 'reverb', chainId: space >= 0.5 ? 'factory:chain/reverb-send/hall' : 'factory:chain/reverb-send/plate', levelDb: rv, target: `${v.name} ▸ ${AUTO_SENDS.reverb}`, what: `send ${rv} dB to the ${space >= 0.5 ? 'hall' : 'plate'}` });
      c.ops.push({ op: 'send', key: `${v.id}/send/delay`, from: v.id, send: 'delay', chainId: 'factory:chain/delay-send/dotted-eighth', levelDb: dl, target: `${v.name} ▸ ${AUTO_SENDS.delay}`, what: `send ${dl} dB to a dotted-eighth delay` });
    }
  }
  const vb = vocalVsBeat(measure, c.in.roles);
  const target = r1(preset.vocalLevel + 1.5 * vf);
  if (!vb) {
    if (!Object.keys(measure.inserts).length) c.notes.push("The vocal level wasn't balanced: this engine build can't render a file per insert.");
    return { delta: null, target };
  }
  const dev = vb.delta - target;
  if (Math.abs(dev) > 0.75) {
    const move = clamp(-dev, -6, 6);
    let excess = 0;
    for (const v of vocals) {
      const ins = c.p.mixer.inserts[v.id];
      if (!ins) continue;
      const from = gainToDb(ins.volume);
      let to = r1(clamp(from + move, -40, 6));
      if (move > 0 && to > VOCAL_FADER_MAX) {
        excess = Math.max(excess, to - Math.max(from, VOCAL_FADER_MAX));
        to = r1(Math.max(from, VOCAL_FADER_MAX));
      }
      if (Math.abs(to - from) < 0.05) continue;
      c.ops.push({ op: 'volume', key: `${v.id}/volume`, insertId: v.id, db: to, target: `${v.name} ▸ Volume`, what: `${sgn(to)} dB (vocal ${sgn(r1(vb.delta + (to - from) + excess))} dB against the beat, target ${sgn(target)})` });
    }
    excess = r05(excess);
    if (excess >= 0.5) {
      const bed = Object.values(c.in.roles).filter((r) => !r.vocal && r.topLevel && r.role !== 'send' && c.p.mixer.inserts[r.id]);
      for (const r of bed) {
        const from = gainToDb(c.p.mixer.inserts[r.id].volume);
        const to = r1(clamp(from - excess, -40, 6));
        c.ops.push({ op: 'volume', key: `${r.id}/volume`, insertId: r.id, db: to, target: `${r.name} ▸ Volume`, what: `${sgn(to)} dB (the beat down ${excess} dB so the vocal sits on top)` });
      }
      if (bed.length) c.notes.push(`The beat came down ${excess} dB instead of pushing the vocal past +${VOCAL_FADER_MAX} dB on its fader.`);
    }
  }
  const bed = Object.values(c.in.roles)
    .filter((r) => !r.vocal && ['keys', 'lead', 'other'].includes(r.role) && measure.inserts[r.id]?.bands)
    .map((r) => {
      const b = measure.inserts[r.id].bands!;
      return { r, e: powerSum([b.mid, b.highMid]) ?? -120 };
    })
    .sort((a, b) => b.e - a.e)[0];
  if (bed && bed.e > -60) {
    const dip = r05(clamp(-(1.5 + 0.75 * Math.max(0, vf)), -3.5, -1));
    slot(c, bed.r.id, 'eq', { b4On: 1, b4Freq: 2800, b4Q: 1, b4Gain: dip, ...markParams('eq') }, `${sgn(dip)} dB at 2.8 kHz (room for the vocal)`);
  }
  return { delta: vb.delta, target };
}

const HP_BY_ROLE: Partial<Record<string, number>> = { hats: 300, perc: 200, snare: 120, keys: 150, lead: 150, fx: 150 };
const LEVEL_BY_ROLE: Partial<Record<string, number>> = { bass: -1, snare: -1.5, hats: -9, perc: -10, keys: -7, lead: -4, fx: -12 };
const COMP_BY_ROLE: Partial<Record<string, { ratio: number; attack: number; release: number; gr: number; depth: number }>> = {
  kick: { ratio: 4, attack: 10, release: 80, gr: 2, depth: 6 },
  snare: { ratio: 4, attack: 5, release: 100, gr: 2.5, depth: 6 },
  bass: { ratio: 3, attack: 20, release: 120, gr: 3, depth: 5 },
};

function planMix(c: Ctx): void {
  const { preset, intent, measure, roles } = c.in;
  const bassier = iv(intent, 'bassier');
  const punch = clamp(preset.punch + 0.15 * iv(intent, 'punchier'), 0, 1);
  const masterHarsh = measure.master.tone.highMid - (preset.tone.highMid - iv(intent, 'lessHarsh'));
  const list = Object.values(roles).filter((r) => !r.vocal && r.role !== 'bus' && r.role !== 'send');
  const harshest = masterHarsh > 2 ? list.filter((r) => r.role !== 'hats' && measure.inserts[r.id]?.bands).sort((a, b) => (measure.inserts[b.id].bands!.highMid ?? -120) - (measure.inserts[a.id].bands!.highMid ?? -120))[0] : undefined;
  for (const r of list) {
    const m = measure.inserts[r.id];
    const ins = c.p.mixer.inserts[r.id];
    if (!ins || !m) continue;
    const volDb = gainToDb(ins.volume);
    const eq = cur(c, r.id, 'eq');
    const p: Record<string, number> = {};
    const parts: string[] = [];
    const hpf = HP_BY_ROLE[r.role];
    if (hpf) {
      Object.assign(p, { b1On: 1, b1Freq: hpf, b1Slope: 0 });
      parts.push(`high-pass ${hz(hpf)}`);
    }
    const lm = rel(m.bands, 'lowMid');
    if (lm !== null && r.role !== 'kick' && r.role !== 'bass') {
      const g = feedback(eq.params.b3Gain ?? 0, lm, 1, { dead: 1.5, k: 0.6, lo: -5, hi: 0 });
      if (g !== (eq.params.b3Gain ?? 0) || eq.slotId) Object.assign(p, { b3On: 1, b3Freq: 300, b3Q: 1, b3Gain: g });
      if (g < 0) parts.push(`${sgn(g)} dB at 300 Hz (mud)`);
    }
    const hm = rel(m.bands, 'highMid');
    if (hm !== null && r.role !== 'hats') {
      const target = r === harshest ? -2 - masterHarsh : -2;
      const g = feedback(eq.params.b5Gain ?? 0, hm, target, { dead: 1.5, k: 0.6, lo: -4, hi: 0 });
      if (g !== (eq.params.b5Gain ?? 0) || eq.slotId) Object.assign(p, { b5On: 1, b5Freq: 3500, b5Q: 1, b5Gain: g });
      if (g < 0) parts.push(`${sgn(g)} dB at 3.5 kHz (harshness)`);
    }
    if (Object.keys(p).length && (parts.length || eq.slotId)) slot(c, r.id, 'eq', { ...p, ...markParams('eq') }, parts.join(', ') || 'flat');
    const cr = COMP_BY_ROLE[r.role];
    if (cr) {
      const cp = cur(c, r.id, 'comp');
      let thr = cp.params.threshold;
      if (!isNum(thr)) thr = clamp(r05((m.peakDb ?? -6) - volDb - cr.depth), -50, -3);
      else thr = thresholdFromGr(thr, grOf(measure, r.id, cp.slotId), cr.gr, -60, 0);
      slot(c, r.id, 'comp', { threshold: thr, ratio: cr.ratio, attack: cr.attack + (punch > 0.7 ? 5 : 0), release: cr.release, autoMakeup: 1, detector: r.role === 'bass' ? 1 : 0, useSidechain: 0, ...markParams('comp') }, `${cr.ratio}:1 at ${r1(thr)} dB (about ${cr.gr} dB of reduction)`);
    }
  }
  const ref = list.find((r) => r.role === 'kick' && isNum(measure.inserts[r.id]?.lufs)) ?? list.filter((r) => ['bass', 'snare'].includes(r.role) && isNum(measure.inserts[r.id]?.lufs)).sort((a, b) => measure.inserts[b.id].lufs! - measure.inserts[a.id].lufs!)[0];
  const moved = new Map<string, number>();
  if (ref) {
    const refL = measure.inserts[ref.id].lufs!;
    for (const r of list) {
      if (r === ref) continue;
      const want = LEVEL_BY_ROLE[r.role];
      const l = measure.inserts[r.id]?.lufs;
      if (want === undefined || !isNum(l)) continue;
      const target = want + (r.role === 'bass' ? 1.5 * bassier : 0);
      const dev = l - refL - target;
      if (Math.abs(dev) <= 3) continue;
      const move = clamp(-(dev - Math.sign(dev) * 2), -4, 4);
      moved.set(r.id, move);
    }
  }
  const top = Object.values(roles).filter((r) => r.topLevel && r.role !== 'send');
  const sum = powerSum(top.map((r) => (measure.inserts[r.id]?.lufs ?? Number.NaN) + (moved.get(r.id) ?? 0) + plannedMove(c, r.id)));
  const master = c.p.mixer.inserts[c.p.mixer.masterId];
  const masterLimiter = master.slotOrder.some((s) => master.slots[s]?.type === 'krypt.limiter' && master.slots[s].enabled);
  let trim = 0;
  if (sum !== null && c.in.mode === 'full') {
    if (sum > -13) trim = -(sum + 16);
    else if (sum < -26) trim = clamp(-20 - sum, 0, 6);
  } else if (c.in.mode === 'mix' && !masterLimiter && measure.master.truePeak > -1) trim = -(measure.master.truePeak + 2);
  trim = r05(trim);
  if (trim !== 0) c.notes.push(`Gain staging: every track ${sgn(trim)} dB so the master has ${c.in.mode === 'full' ? 'headroom before the master chain' : 'room and stops clipping'}.`);
  for (const r of list.concat(Object.values(roles).filter((x) => x.vocal || x.role === 'bus'))) {
    const move = (moved.get(r.id) ?? 0) + (r.topLevel || moved.has(r.id) ? (r.topLevel ? trim : 0) : 0);
    if (Math.abs(move) < 0.05) continue;
    const ins = c.p.mixer.inserts[r.id];
    if (!ins) continue;
    const from = gainToDb(ins.volume);
    const prior = c.ops.find((o) => o.op === 'volume' && o.insertId === r.id) as Extract<PlanOp, { op: 'volume' }> | undefined;
    const to = r1(clamp((prior ? prior.db : from) + move, -40, 6));
    if (prior) {
      prior.db = to;
      prior.what = `${sgn(to)} dB (${prior.what.replace(/^[^(]*\(/, '').replace(/\)$/, '')}, with the headroom trim)`;
      continue;
    }
    if (Math.abs(to - from) < 0.05) continue;
    c.ops.push({ op: 'volume', key: `${r.id}/volume`, insertId: r.id, db: to, target: `${r.name} ▸ Volume`, what: `${sgn(to)} dB${moved.has(r.id) ? ` (${r.role} level against the ${ref?.role ?? 'kick'})` : ' (headroom)'}` });
  }
  const bus = Object.values(roles).find((r) => r.drumBus);
  if (bus) {
    const m = measure.inserts[bus.id];
    const g = cur(c, bus.id, 'glue');
    let thr = g.params.threshold;
    const volDb = gainToDb(c.p.mixer.inserts[bus.id].volume);
    if (!isNum(thr)) thr = clamp(r05((m?.peakDb ?? -6) - volDb - 8), -40, 0);
    else thr = thresholdFromGr(thr, grOf(measure, bus.id, g.slotId), 2, -40, 0);
    slot(c, bus.id, 'glue', { threshold: thr, ratio: 0, attack: punch > 0.6 ? 4 : 3, release: 4, makeup: 2, scHpf: 3, useSidechain: 0, mix: 1, ...markParams('glue') }, `2:1 glue at ${r1(thr)} dB, sidechain high-pass 120 Hz`);
  }
  const kick = list.find((r) => r.role === 'kick');
  const bass = list.find((r) => r.role === 'bass');
  if (kick && bass) {
    const kb = measure.inserts[kick.id]?.bands;
    const bb = measure.inserts[bass.id]?.bands;
    const kl = kb ? powerSum([kb.sub, kb.low]) : null;
    const bl = bb ? powerSum([bb.sub, bb.low]) : null;
    const bIns = c.p.mixer.inserts[bass.id];
    const userSc = bIns.slotOrder.some((s) => bIns.slots[s]?.sidechainFrom === kick.id && !isKryptSlot(bIns.slots[s], 'duck'));
    if (kl !== null && bl !== null && kl > -50 && bl > -50 && Math.abs(kl - bl) < 10) {
      if (userSc) c.notes.push(`"${bass.name}" already ducks under "${kick.name}": your sidechain was left as it is.`);
      else {
        const depth = r1(clamp(0.25 + 0.35 * punch + 0.05 * Math.max(0, bassier), 0.2, 0.7));
        const release = Math.round(100 + 80 * (1 - punch));
        slot(c, bass.id, 'duck', { mode: 1, depth, release, attack: 1, ...markParams('duck') }, `ducks ${Math.round(depth * 100)}% under "${kick.name}" (their lows collide), ${release} ms release`, { sidechainFrom: kick.id, place: 'first' });
      }
    }
  }
}

const MASTER_EQ: Array<{ band: Exclude<Band, 'mid'>; p: string; hz: number; q: number }> = [
  { band: 'sub', p: 'b2', hz: 60, q: 0.7 },
  { band: 'low', p: 'b3', hz: 150, q: 0.8 },
  { band: 'lowMid', p: 'b4', hz: 350, q: 1 },
  { band: 'highMid', p: 'b5', hz: 3500, q: 0.8 },
  { band: 'high', p: 'b6', hz: 10000, q: 0.7 },
];

export function toneTarget(preset: AutoMixPreset, intent: AutoMixIntent | null): Bands {
  const br = iv(intent, 'brighter');
  const bs = iv(intent, 'bassier');
  const w = iv(intent, 'warmer');
  const lh = iv(intent, 'lessHarsh');
  const t = preset.tone;
  return {
    sub: t.sub + 1.5 * bs,
    low: t.low + bs + 0.5 * w,
    lowMid: t.lowMid + 0.5 * w,
    mid: 0,
    highMid: t.highMid + 0.75 * br - lh,
    high: t.high + 1.5 * br - 0.5 * w - 0.5 * lh,
  };
}

export function maxLimiterGr(preset: AutoMixPreset, intent: AutoMixIntent | null): number {
  const aggressive = iv(intent, 'cleaner') < 0 || preset.id === 'phonk-slam';
  return iv(intent, 'cleaner') > 0 ? 2.5 : aggressive ? 5 : preset.targetLufs >= -9 ? 4 : 3;
}

export function widthFactor(measured: number, target: number): number {
  const s = clamp(measured, 0.005, 0.95);
  const t = clamp(target, 0.005, 0.95);
  return clamp(Math.sqrt((t / (1 - t)) / (s / (1 - s))), 0.5, 1.6);
}

function planMaster(c: Ctx): number | null {
  const { preset, intent, measure, target } = c.in;
  const mid = c.in.masterInsertId && c.p.mixer.inserts[c.in.masterInsertId] ? c.in.masterInsertId : c.p.mixer.masterId;
  const where = insName(c, mid);
  const mm = measure.master;
  const punch = clamp(preset.punch + 0.15 * iv(intent, 'punchier'), 0, 1);
  const cleaner = iv(intent, 'cleaner');
  const eq = cur(c, mid, 'eq');
  const lim = cur(c, mid, 'limiter');
  const driveNow = (lim.params.inputGain ?? 0) + (eq.params.output ?? 0);
  const hist = (c.in.loudHistory ?? []).filter((h) => isNum(h.drive) && isNum(h.lufs));
  let drive = driveNow;
  const need = target.lufs - (mm.lufs + plannedMasterShift(c));
  if (Math.abs(need) > 0.5 || c.in.pass === 1) {
    let slope = 1;
    if (hist.length >= 2) {
      const [a, b] = hist.slice(-2);
      const s = Math.abs(b.drive - a.drive) > 0.2 ? (b.lufs - a.lufs) / (b.drive - a.drive) : Number.NaN;
      if (s >= 0.25 && s <= 1.2) slope = s;
    }
    drive = driveNow + need / slope;
  }
  const grL = grOf(measure, mid, lim.slotId);
  const maxGr = maxLimiterGr(preset, intent);
  let capped = false;
  if (grL && isNum(grL.avgDb) && drive > driveNow) {
    if (grL.avgDb > maxGr + 1.5) {
      drive = driveNow - (grL.avgDb - maxGr);
      capped = true;
    } else if (grL.avgDb >= maxGr || (isNum(mm.crestDb) && mm.crestDb < 5)) {
      drive = driveNow;
      capped = true;
    }
  }
  if (capped) c.notes.push(`Loudness capped at ${r1(mm.lufs)} LUFS: reaching ${target.lufs} would distort (the limiter already works ${r1(grL?.avgDb ?? 0)} dB on average${isNum(mm.crestDb) ? `, crest ${r1(mm.crestDb)} dB` : ''}).`);
  drive = r1(clamp(drive, -12, 24));
  const inputGain = Math.max(0, drive);
  const trim = Math.min(0, drive);
  const tt = c.in.tone ?? toneTarget(preset, intent);
  const p: Record<string, number> = { b1On: 1, b1Freq: 25, b1Slope: 1, output: r1(trim), ...markParams('eq') };
  const parts: string[] = [];
  for (const b of MASTER_EQ) {
    const now = eq.params[`${b.p}Gain`] ?? 0;
    const g = isNum(mm.tone[b.band]) ? feedback(now, mm.tone[b.band], tt[b.band], { dead: 1.5, k: 0.6, lo: -4, hi: 4 }) : now;
    Object.assign(p, { [`${b.p}On`]: 1, [`${b.p}Freq`]: b.hz, [`${b.p}Q`]: b.q, [`${b.p}Gain`]: g });
    if (g) parts.push(`${sgn(g)} dB at ${hz(b.hz)}${b.band === 'highMid' && g < 0 ? ' (harshness)' : b.band === 'lowMid' && g < 0 ? ' (mud)' : ''}`);
  }
  if (trim < 0) parts.push(`trim ${sgn(trim)} dB (to come down to ${target.lufs} LUFS)`);
  slot(c, mid, 'eq', p, parts.length ? `tone: ${parts.join(', ')}` : 'sub-sonic cut at 25 Hz, tone already on the curve');
  const g = cur(c, mid, 'glue');
  const grTarget = r1(1 + 1.5 * (1 - punch));
  let thr = g.params.threshold;
  if (!isNum(thr)) thr = clamp(r05((mm.peakDb ?? -1) + trim - 9 + 3 * punch), -30, -3);
  else thr = thresholdFromGr(thr, grOf(measure, mid, g.slotId), grTarget, -40, 0);
  slot(c, mid, 'glue', { threshold: thr, ratio: 0, attack: punch >= 0.6 ? 5 : 4, release: 4, makeup: 0, scHpf: preset.tone.sub >= 6 ? 3 : 2, useSidechain: 0, mix: 1, ...markParams('glue') }, `2:1 glue, ${punch >= 0.6 ? 30 : 10} ms attack, threshold ${r1(thr)} dB (about ${grTarget} dB)`);
  const want = preset.warmth + 0.25 * iv(intent, 'warmer') - 0.3 * cleaner;
  const heat = cur(c, mid, 'heat');
  if ((want > 0.6 || cleaner <= -1) && cleaner <= 0) {
    const w = clamp(want - 0.5, 0, 0.6);
    const lowDrive = r1(2 + 6 * w + (cleaner < 0 ? 2 : 0));
    slot(c, mid, 'heat', { highFreq: 2500, lowDrive, midDrive: r1(1 + 4 * w), highDrive: r1(0.5 + 2 * w), lowShape: 2, midShape: 1, highShape: 0, oversample: 1, mix: r1(0.2 + 0.4 * w), output: r1(-lowDrive * 0.25), ...markParams('heat') }, `warmth: tape low drive ${lowDrive} dB, ${Math.round((0.2 + 0.4 * w) * 100)}% blend`);
  } else if (heat.slotId && isKryptSlot(c.p.mixer.inserts[mid].slots[heat.slotId], 'heat') && c.p.mixer.inserts[mid].slots[heat.slotId].enabled) {
    c.ops.push({ op: 'disable', key: `${mid}/heat`, insertId: mid, kind: 'heat', target: `${where} ▸ ${pluginName(c, 'heat')}`, what: 'bypassed (a clean master was asked for)' });
  }
  const wide = iv(intent, 'wider');
  let midW = r1(clamp(1 + 0.2 * (preset.width - 0.5) + 0.08 * wide, 0.7, 1.3));
  let highW = r1(clamp(1 + 0.4 * (preset.width - 0.5) + 0.12 * wide, 0.7, 1.4));
  let widthWhy = '';
  const wt = c.in.widthTarget;
  if (isNum(wt) && isNum(mm.width)) {
    const im = cur(c, mid, 'imager');
    const m0 = isNum(im.params.midWidth) && im.slotId ? im.params.midWidth : 1;
    const h0 = isNum(im.params.highWidth) && im.slotId ? im.params.highWidth : 1;
    if (Math.abs(mm.width - wt) > 0.02) {
      const f = Math.pow(widthFactor(mm.width, wt), 0.8);
      midW = Math.round(clamp(m0 * f, 0.85, 1.3) * 100) / 100;
      highW = Math.round(clamp(h0 * f, 0.85, 1.4) * 100) / 100;
      if (m0 * f < 0.85 || h0 * f < 0.85) c.notes.push(`The reference is much narrower than ${mid === c.p.mixer.masterId ? 'your song' : `"${where}"`}: the width is only eased (85% at least), so your stereo image stays.`);
    } else {
      midW = m0;
      highW = h0;
    }
    widthWhy = ` (toward the reference's width ${Math.round(wt * 100)}%, now ${Math.round(mm.width * 100)}%)`;
  }
  if (isNum(mm.correlation) && mm.correlation < 0.2) {
    midW = Math.min(midW, 0.9);
    highW = Math.min(highW, 0.9);
    c.notes.push(`${mid === c.p.mixer.masterId ? 'The mix' : `"${where}"`} is very wide (correlation ${r1(mm.correlation)}): the imager narrows it to stay mono-safe.`);
  }
  slot(c, mid, 'imager', { lowWidth: 0, lowFreq: 120, midWidth: midW, highWidth: highW, output: 0, ...markParams('imager') }, `mono below 120 Hz, mids ${Math.round(midW * 100)}%, highs ${Math.round(highW * 100)}%${widthWhy}`);
  const clip = cur(c, mid, 'clipper');
  if (target.lufs >= -9.5 && (punch >= 0.6 || cleaner < 0) && cleaner <= 0) {
    const d = r1(clamp(1 + 2.5 * punch + (cleaner < 0 ? 1.5 : 0) + (target.lufs + 9) * 0.5, 0, 5));
    slot(c, mid, 'clipper', { drive: d, ceiling: target.truePeak, oversample: 2, ...markParams('clipper') }, `soft clip ${d} dB into ${target.truePeak} dB`);
  } else if (clip.slotId && isKryptSlot(c.p.mixer.inserts[mid].slots[clip.slotId], 'clipper') && c.p.mixer.inserts[mid].slots[clip.slotId].enabled) {
    c.ops.push({ op: 'disable', key: `${mid}/clipper`, insertId: mid, kind: 'clipper', target: `${where} ▸ ${pluginName(c, 'clipper')}`, what: 'bypassed (not needed at this loudness)' });
  }
  let ceiling = isNum(lim.params.ceiling) && lim.slotId ? lim.params.ceiling : r1(target.truePeak - 0.1);
  if (lim.slotId && mm.truePeak > target.truePeak + 0.05) ceiling = r1(ceiling - (mm.truePeak - target.truePeak) - 0.1);
  ceiling = clamp(Math.min(ceiling, target.truePeak - 0.1), -6, 0);
  const release = Math.round(30 + 60 * (1 - punch));
  slot(c, mid, 'limiter', { inputGain: r1(inputGain), ceiling: r1(ceiling), truePeak: 1, ...markParams('limiter', release) }, `input ${sgn(inputGain)} dB to reach ${target.lufs} LUFS, ceiling ${r1(ceiling)} dBTP (true peak)`);
  return drive;
}

export function meetsTargets(input: Pick<PlanInput, 'mode' | 'target' | 'measure' | 'roles' | 'preset' | 'intent'>): { ok: boolean; why: string[] } {
  const why: string[] = [];
  const m = input.measure.master;
  if (input.mode === 'master' || input.mode === 'full') {
    if (Math.abs(m.lufs - input.target.lufs) > 0.5) why.push(`loudness ${r1(m.lufs)} vs ${input.target.lufs} LUFS`);
    if (m.truePeak > input.target.truePeak + 0.05) why.push(`true peak ${r1(m.truePeak)} over ${input.target.truePeak} dBTP`);
  }
  if (input.mode !== 'master') {
    const vb = vocalVsBeat(input.measure, input.roles);
    const t = input.preset.vocalLevel + 1.5 * iv(input.intent, 'vocalsForward');
    if (vb && Math.abs(vb.delta - t) > 1) why.push(`vocal ${sgn(vb.delta)} dB vs the beat (target ${sgn(t)})`);
  }
  return { ok: why.length === 0, why };
}

export function planAutoMix(input: PlanInput): Plan {
  const c: Ctx = { in: input, ops: [], notes: [], p: input.project };
  const met = meetsTargets(input);
  let delta: number | null = null;
  let vtarget: number | null = null;
  let drive: number | null = null;
  if (input.mode === 'vocals' || input.mode === 'mix' || input.mode === 'full') {
    const v = planVocals(c);
    delta = v.delta;
    vtarget = v.target;
  }
  if (input.mode === 'mix' || input.mode === 'full') planMix(c);
  if (input.mode === 'master' || input.mode === 'full') drive = planMaster(c);
  if (input.mode === 'mix' && !Object.values(input.roles).some((r) => r.drumBus)) {
    const m = c.p.mixer.inserts[c.p.mixer.masterId];
    if (!m.slotOrder.some((s) => m.slots[s]?.type === 'krypt.glue' && !isKryptSlot(m.slots[s]))) {
      const g = cur(c, m.id, 'glue');
      let thr = g.params.threshold;
      if (!isNum(thr)) thr = clamp(r05((input.measure.master.peakDb ?? -1) - 9), -30, -3);
      else thr = thresholdFromGr(thr, grOf(input.measure, m.id, g.slotId), 1.5, -40, 0);
      slot(c, m.id, 'glue', { threshold: thr, ratio: 0, attack: 5, release: 4, makeup: 0, scHpf: 3, useSidechain: 0, mix: 1, ...markParams('glue') }, `2:1 glue at ${r1(thr)} dB (no drum bus, so on the master)`);
    }
  }
  const capped = c.notes.some((n) => n.startsWith('Loudness capped')) && input.measure.master.truePeak <= input.target.truePeak + 0.05;
  return { ops: c.ops, notes: c.notes, converged: met.ok || capped, vocalVsBeat: delta, vocalTarget: vtarget, drive };
}

export interface ApplyIO {
  project(): Project;
  catalog: PluginCatalog;
  exec<T = unknown>(cmd: string, args: unknown): T;
  chain(id: string): { fx: Array<{ type: string; params: Record<string, number>; mix?: number }>; insert?: { volumeDb?: number } } | null;
}

export interface ApplyResult {
  changes: Map<string, AutoMixChange>;
  notes: string[];
  edits: number;
}

const same = (a: number | undefined, b: number): boolean => typeof a === 'number' && Math.abs(a - b) < 0.005;

function placeIndex(ins: MixerInsert, kind: KryptKind): number {
  const later = ORDER.slice(ORDER.indexOf(kind) + 1);
  const idx = ins.slotOrder.findIndex((s) => later.some((k) => isKryptSlot(ins.slots[s], k)));
  if (idx >= 0) return idx;
  if (ins.isMaster && kind !== 'limiter') {
    const userLim = ins.slotOrder.findIndex((s) => ins.slots[s]?.type === 'krypt.limiter' && !isKryptSlot(ins.slots[s]));
    if (userLim >= 0) return userLim;
  }
  return ins.slotOrder.length;
}

export function applyPlan(plan: Plan, io: ApplyIO, opts: { keepUserFx: boolean }): ApplyResult {
  const changes = new Map<string, AutoMixChange>();
  const notes: string[] = [];
  let edits = 0;
  const ex = <T>(cmd: string, args: unknown): T => {
    edits++;
    return io.exec<T>(cmd, args);
  };
  for (const op of plan.ops) {
    const p = io.project();
    if (op.op === 'slot') {
      const ins = p.mixer.inserts[op.insertId];
      if (!ins) continue;
      let id = findKryptSlot(ins, op.kind, opts.keepUserFx);
      let changed = false;
      if (!id) {
        if (ins.slotOrder.length >= 10) {
          notes.push(`${op.target} skipped: "${ins.isMaster ? 'Master' : ins.name}" already holds 10 effects.`);
          continue;
        }
        const index = op.place === 'first' ? 0 : placeIndex(ins, op.kind);
        id = ex<{ id: string }>('mixer.addSlot', { insertId: op.insertId, type: KIND_TYPE[op.kind], index, params: op.params, ...(op.mix !== undefined ? { mix: op.mix } : {}) }).id;
        changed = true;
      } else {
        const slotNow = ins.slots[id];
        const diff: Record<string, number> = {};
        for (const [k, v] of Object.entries(op.params)) if (!same(slotNow.params[k], v)) diff[k] = v;
        if (Object.keys(diff).length) {
          ex('mixer.setSlotParams', { insertId: op.insertId, slotId: id, params: diff });
          changed = true;
        }
        if (!slotNow.enabled || (op.mix !== undefined && !same(slotNow.mix, op.mix))) {
          ex('mixer.setSlot', { insertId: op.insertId, slotId: id, enabled: true, ...(op.mix !== undefined ? { mix: op.mix } : {}) });
          changed = true;
        }
      }
      if (op.sidechainFrom !== undefined && io.project().mixer.inserts[op.insertId].slots[id].sidechainFrom !== op.sidechainFrom) {
        ex('mixer.setSlot', { insertId: op.insertId, slotId: id, sidechainFrom: op.sidechainFrom });
        changed = true;
      }
      if (changed) changes.set(op.key, { target: op.target, what: op.what });
    } else if (op.op === 'disable') {
      const ins = p.mixer.inserts[op.insertId];
      const id = ins ? ins.slotOrder.find((s) => isKryptSlot(ins.slots[s], op.kind)) : undefined;
      if (id && ins!.slots[id].enabled) {
        ex('mixer.setSlot', { insertId: op.insertId, slotId: id, enabled: false });
        changes.set(op.key, { target: op.target, what: op.what });
      }
    } else if (op.op === 'volume') {
      const ins = p.mixer.inserts[op.insertId];
      if (!ins) continue;
      const g = Math.min(2, dbToGain(op.db));
      if (Math.abs(ins.volume - g) < 1e-4) continue;
      ex('mixer.setInsert', { id: op.insertId, volume: g });
      changes.set(op.key, { target: op.target, what: op.what });
    } else if (op.op === 'send') {
      const name = AUTO_SENDS[op.send];
      let sendId = p.mixer.insertOrder.find((i) => p.mixer.inserts[i]?.name === name) ?? null;
      const from = p.mixer.inserts[op.from];
      if (!from) continue;
      if (op.levelDb === null) {
        if (sendId && from.routes[sendId] !== undefined) {
          ex('mixer.setRoute', { from: op.from, to: sendId, level: null });
          changes.set(op.key, { target: op.target, what: op.what });
        }
        continue;
      }
      if (!sendId) {
        const ch = io.chain(op.chainId);
        if (!ch) {
          notes.push(`${op.target} skipped: the factory send chain is missing.`);
          continue;
        }
        sendId = ex<{ id: string }>('mixer.addInsert', { name }).id;
        for (const fx of ch.fx) if (io.catalog.plugins.some((x) => x.id === fx.type)) ex('mixer.addSlot', { insertId: sendId, type: fx.type, params: fx.params, ...(fx.mix !== undefined ? { mix: fx.mix } : {}) });
        if (ch.insert?.volumeDb !== undefined) ex('mixer.setInsert', { id: sendId, volume: Math.min(2, dbToGain(ch.insert.volumeDb)) });
        changes.set(`send/${op.send}`, { target: name, what: `new send return (${op.chainId.split('/').pop()?.replace(/-/g, ' ')})` });
      }
      const level = Math.min(2, dbToGain(op.levelDb));
      if (!same(io.project().mixer.inserts[op.from].routes[sendId], level)) {
        ex('mixer.setRoute', { from: op.from, to: sendId, level });
        changes.set(op.key, { target: op.target, what: op.what });
      }
    } else if (op.op === 'tune') {
      const ins = p.mixer.inserts[op.insertId];
      if (!ins) continue;
      if (!io.catalog.plugins.some((x) => x.id === 'krypt.pitch')) {
        notes.push('This build has no Krypt Tune, so the vocal is not pitch-corrected.');
        continue;
      }
      if (opts.keepUserFx && ins.slotOrder.some((s) => ins.slots[s]?.type === 'krypt.pitch')) continue;
      try {
        const tp = planTune(p, op.insertId, { root: op.root, scale: op.scale, label: op.what }, op.style);
        let changed = false;
        for (const s of tp.steps) {
          if (s.cmd === 'mixer.setSlotParams') {
            const slotNow = ins.slots[(s.args as { slotId: string }).slotId];
            const prm = (s.args as { params: Record<string, number> }).params;
            if (slotNow && Object.entries(prm).every(([k, v]) => same(slotNow.params[k], v))) continue;
          }
          ex(s.cmd, s.args);
          changed = true;
        }
        if (changed) changes.set(op.key, { target: op.target, what: op.what });
      } catch (e) {
        notes.push(`Krypt Tune skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  const p = io.project();
  const limited = new Set<string>([p.mixer.masterId]);
  for (const op of plan.ops) if (op.op === 'slot' && op.kind === 'limiter') limited.add(op.insertId);
  for (const id of limited) {
    const m = io.project().mixer.inserts[id];
    if (!m) continue;
    const lim = m.slotOrder.find((s) => isKryptSlot(m.slots[s], 'limiter'));
    if (lim && m.slotOrder[m.slotOrder.length - 1] !== lim) ex('mixer.moveSlot', { insertId: m.id, slotId: lim, toIndex: m.slotOrder.length - 1 });
  }
  return { changes, notes, edits };
}

export function toneOf(bands: Partial<Bands> | undefined | null): Bands {
  const mid = bands?.mid;
  const out = { sub: 0, low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 } as Bands;
  if (!bands || !isNum(mid)) return out;
  for (const k of BANDS) out[k] = isNum(bands[k]) ? r1(bands[k]! - mid) : 0;
  return out;
}
