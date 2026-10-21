import { z } from 'zod';
import type { MainDeps } from '../types';
import type { FxSlot, MixerInsert, Project } from '@shared/schema/project';
import type { Analysis } from '@shared/engine/protocol';
import type { StemName } from '@shared/analyzer/protocol';
import { ticksPerBar } from '@shared/schema/time';
import { defineTool, fail, type RunCtx } from './types';
import { dbToGain, gainToDb, round, safeName } from './util';
import { audibleSongEnd, renderAndAnalyse, type StemRender } from './hearing';
import { audibleReferenceClips, projectReference, type StudiedReference } from './reference';
import { collectHeard, sectionsOf } from './craftReview';
import { balanceDiff, groupLevelsOf, insertGroups, PART_GROUPS, type GroupLevels, type PartGroup } from './closeness';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");
const j = (v: unknown): string => JSON.stringify(v);
const r1 = (n: number): number => Math.round(n * 10) / 10;
const sgn = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? `${n > 0 ? '+' : ''}${r1(n)}` : '?');
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export const MATCH_EQ_CAP_DB = 6;
export const MATCH_EQ_BANDS = [
  { band: 'sub', p: 'b2', hz: 55, q: 0.7 },
  { band: 'low', p: 'b3', hz: 130, q: 0.9 },
  { band: 'lowMid', p: 'b4', hz: 350, q: 1 },
  { band: 'highMid', p: 'b5', hz: 3500, q: 0.8 },
  { band: 'high', p: 'b6', hz: 9000, q: 0.7 },
] as const;
type MatchBand = (typeof MATCH_EQ_BANDS)[number]['band'];

export function isMatchEq(slot: FxSlot | undefined): boolean {
  if (!slot || slot.type !== 'krypt.eq') return false;
  return MATCH_EQ_BANDS.every((b) => Math.abs((slot.params[`${b.p}Freq`] ?? -1) - b.hz) < 0.5);
}

export function matchEqParams(gains: Partial<Record<MatchBand, number>> = {}): Record<string, number> {
  const out: Record<string, number> = { b1On: 0, b7On: 0, output: 0 };
  for (const b of MATCH_EQ_BANDS) {
    out[`${b.p}On`] = 1;
    out[`${b.p}Freq`] = b.hz;
    out[`${b.p}Q`] = b.q;
    out[`${b.p}Gain`] = clampEq(gains[b.band] ?? 0);
  }
  return out;
}

const clampEq = (g: number): number => Math.round(Math.max(-MATCH_EQ_CAP_DB, Math.min(MATCH_EQ_CAP_DB, g)) * 10) / 10;

export function nextEqGains(current: Partial<Record<MatchBand, number>>, diff: Partial<Record<string, number>>): Record<MatchBand, number> {
  const out = {} as Record<MatchBand, number>;
  for (const b of MATCH_EQ_BANDS) {
    const cur = current[b.band] ?? 0;
    const d = diff[b.band];
    out[b.band] = isNum(d) && Math.abs(d) >= 0.5 ? clampEq(cur - 0.8 * d) : clampEq(cur);
  }
  return out;
}

const STEM_GROUP: Record<StemName, PartGroup> = { drums: 'drums', bass: 'bass', vocals: 'vocals', other: 'other', guitar: 'other', piano: 'other' };

export function stemGroupLevels(levels: Partial<Record<StemName, number | null>>): GroupLevels {
  const acc: Partial<Record<PartGroup, number>> = {};
  for (const [name, db] of Object.entries(levels) as Array<[StemName, number | null]>) {
    const g = STEM_GROUP[name];
    if (!g || !isNum(db) || db < -60) continue;
    acc[g] = (acc[g] ?? 0) + Math.pow(10, db / 10);
  }
  return Object.fromEntries(Object.entries(acc).map(([g, p]) => [g, r1(10 * Math.log10(p!))])) as GroupLevels;
}

export function curveLevel(curve: readonly number[], hop: number, t0: number, t1: number): number | null {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, Math.floor(t0 / hop)); i < Math.min(curve.length, Math.ceil(t1 / hop)); i++) {
    const v = curve[i];
    if (!isNum(v) || v <= -70) continue;
    sum += Math.pow(10, v / 10);
    n++;
  }
  return n ? r1(10 * Math.log10(sum / n)) : null;
}

async function referenceStemFiles(deps: MainDeps, ref: StudiedReference): Promise<{ stems: Partial<Record<StemName, { path: string; rmsDb: number }>> } | { problem: string }> {
  const an = deps.analyzer;
  if (!an?.stemFiles) return { problem: "this build can't read the reference's stems" };
  try {
    const r = await an.stemFiles({ channelId: ref.track.channel.id }, { cachedOnly: true });
    if (!r.ok) return { problem: r.message ?? 'reading its stems failed' };
    if (!r.data) return { problem: `the reference has no stems yet (${r.message ?? 'not separated'}; study_reference separates it when a stem model is installed)` };
    return { stems: r.data.stems };
  } catch (e) {
    return { problem: (e as Error)?.message ?? String(e) };
  }
}

export async function referenceBalance(deps: MainDeps, ref: StudiedReference, stems: StemRender[] | null, stemsProblem?: string): Promise<{ levels: { project: GroupLevels; reference: GroupLevels } | null; note?: string }> {
  if (!stems?.length) return { levels: null, note: `per-part balance not measured: ${stemsProblem ?? 'the render has no stems'}` };
  const files = await referenceStemFiles(deps, ref);
  if ('problem' in files) return { levels: null, note: `per-part balance not measured: ${files.problem}` };
  const reference = stemGroupLevels(Object.fromEntries(Object.entries(files.stems).map(([k, v]) => [k, v?.rmsDb ?? null])));
  const groups = insertGroups(deps.doc.project, new Set([ref.track.channel.id]));
  const project = groupLevelsOf(
    stems.map((s) => ({ insertId: s.insertId, db: s.analysis?.rmsDb ?? null })),
    groups,
  );
  return { levels: { project, reference } };
}

export interface MixMeasure {
  lufs: number | null;
  width: number | null;
  bands: Partial<Record<string, number>>;
  groups: GroupLevels;
  stems: boolean;
}

export function measureOf(a: Analysis, stems: StemRender[] | null, groups: ReadonlyMap<string, PartGroup>): MixMeasure {
  const bands: Partial<Record<string, number>> = {};
  if (isNum(a.bands?.mid)) for (const b of MATCH_EQ_BANDS) if (isNum(a.bands[b.band])) bands[b.band] = r1(a.bands[b.band] - a.bands.mid);
  return {
    lufs: isNum(a.lufsIntegrated) && a.lufsIntegrated > -70 ? r1(a.lufsIntegrated) : null,
    width: isNum(a.stereoWidth) ? round(a.stereoWidth, 3) : null,
    bands,
    groups: stems?.length ? groupLevelsOf(stems.map((s) => ({ insertId: s.insertId, db: s.analysis?.lufsIntegrated ?? null })), groups) : {},
    stems: !!stems?.length,
  };
}

export interface MixTargets {
  lufs: number | null;
  width: number | null;
  bands: Partial<Record<string, number>>;
  loudGroups: GroupLevels | null;
  quietGroups: GroupLevels | null;
}

export function mixGaps(loud: MixMeasure, quiet: MixMeasure | null, t: MixTargets): { balance: GroupLevels; bands: Partial<Record<string, number>>; width: number | null; lufs: number | null } {
  const lb = t.loudGroups ? balanceDiff(loud.groups, t.loudGroups) : {};
  const qb = quiet && t.quietGroups ? balanceDiff(quiet.groups, t.quietGroups) : {};
  const balance: GroupLevels = {};
  for (const g of PART_GROUPS) {
    const a = lb[g];
    const b = qb[g];
    if (isNum(a) && isNum(b)) balance[g] = r1(0.7 * a + 0.3 * b);
    else if (isNum(a)) balance[g] = a;
  }
  const bands: Partial<Record<string, number>> = {};
  for (const b of MATCH_EQ_BANDS) if (isNum(loud.bands[b.band]) && isNum(t.bands[b.band])) bands[b.band] = r1(loud.bands[b.band]! - t.bands[b.band]!);
  return {
    balance,
    bands,
    width: isNum(loud.width) && isNum(t.width) ? round(loud.width - t.width, 3) : null,
    lufs: isNum(loud.lufs) && isNum(t.lufs) ? r1(loud.lufs - t.lufs) : null,
  };
}

const MAX_SECTION_BARS = 16;

export function pickSections(p: Project, section?: string): { loud: { label: string; bars: string }; quiet: { label: string; bars: string } | null } {
  const barTicks = ticksPerBar(p.transport.timeSig);
  const end = audibleSongEnd(p);
  if (end <= 0) fail('Nothing of yours plays in the song yet: arrange your patterns first, then match_mix.');
  const range = { start: 0, end };
  const heard = collectHeard(p, 0, end);
  const secs = sectionsOf(p, range, heard).filter((s) => s.end - s.start >= barTicks);
  const span = (s: { start: number; end: number }) => {
    const a = Math.floor(s.start / barTicks) + 1;
    const b = Math.min(Math.ceil(s.end / barTicks), a + MAX_SECTION_BARS - 1);
    return `${a}-${b}`;
  };
  const density = (s: { start: number; end: number }) => {
    const bs = heard.bars.slice(Math.floor(s.start / barTicks), Math.ceil(s.end / barTicks));
    return bs.length ? bs.reduce((x, b) => x + b.channels.size + b.audio, 0) / bs.length : 0;
  };
  let loud: { label: string; bars: string } | null = null;
  if (section?.trim()) {
    const t = section.trim();
    if (/^\d+(\s*[-–:]\s*\d+)?$/.test(t)) {
      const [a, b] = t.split(/\s*[-–:]\s*/).map(Number);
      const last = b ?? a;
      if (last < a) fail(`section "${safeName(t, 20)}" must be an ascending bar range like "33-48".`);
      loud = { label: `bars ${a}-${Math.min(last, a + MAX_SECTION_BARS - 1)}`, bars: `${a}-${Math.min(last, a + MAX_SECTION_BARS - 1)}` };
    } else {
      const hit = secs.find((s) => s.name.toLowerCase() === t.toLowerCase()) ?? secs.find((s) => s.name.toLowerCase().startsWith(t.toLowerCase()));
      if (!hit) fail(`No section named "${safeName(t, 40)}". Sections: ${secs.map((s) => s.name || span(s)).join(', ') || 'none'}. Or pass a bar range like "33-48".`);
      loud = { label: `${hit.name} (bars ${span(hit)})`, bars: span(hit) };
    }
  }
  const ranked = secs.map((s) => ({ s, d: density(s) })).filter((x) => x.d > 0);
  if (!ranked.length && !loud) fail('Nothing audible to match: arrange your patterns first.');
  const top = ranked.slice().sort((x, y) => y.d - x.d || y.s.end - y.s.start - (x.s.end - x.s.start))[0];
  if (!loud) loud = { label: `${top.s.name || 'the fullest section'} (bars ${span(top.s)})`, bars: span(top.s) };
  const low = ranked.filter((x) => span(x.s) !== loud!.bars && x.s.end - x.s.start >= 2 * barTicks).sort((x, y) => x.d - y.d)[0];
  const quiet = low && top && low.d < top.d * 0.8 ? { label: `${low.s.name || 'the thinnest section'} (bars ${span(low.s)})`, bars: span(low.s) } : null;
  return { loud, quiet };
}

function masterOf(deps: MainDeps): MixerInsert {
  const p = deps.doc.project;
  return p.mixer.inserts[p.mixer.masterId];
}

function slotIndex(ins: MixerInsert, type: string): number {
  return ins.slotOrder.findIndex((s) => ins.slots[s]?.type === type);
}

function ensureMatchEq(deps: MainDeps, ctx: RunCtx): { id: string; created: boolean } {
  const m = masterOf(deps);
  const found = m.slotOrder.find((s) => isMatchEq(m.slots[s]));
  if (found) return { id: found, created: false };
  const lim = slotIndex(m, 'krypt.limiter');
  if (m.slotOrder.length >= 10) fail('The master already holds 10 effects, so the Match EQ has no room: remove one (set_effect / delete_objects), then match_mix again.');
  const id = ctx.exec<{ id: string }>('mixer.addSlot', { insertId: m.id, type: 'krypt.eq', index: lim >= 0 ? lim : undefined, params: matchEqParams() }).id;
  return { id, created: true };
}

function ensureMasterFx(deps: MainDeps, ctx: RunCtx, type: string, params: Record<string, number>): { id: string; created: boolean } {
  const m = masterOf(deps);
  const found = m.slotOrder.find((s) => m.slots[s]?.type === type && m.slots[s].enabled);
  if (found) return { id: found, created: false };
  if (m.slotOrder.length >= 10) fail(`The master already holds 10 effects, so there is no room for ${type === 'krypt.limiter' ? 'a limiter' : 'an imager'}: remove one, then match_mix again.`);
  const lim = type === 'krypt.limiter' ? -1 : slotIndex(m, 'krypt.limiter');
  const id = ctx.exec<{ id: string }>('mixer.addSlot', { insertId: m.id, type, index: lim >= 0 ? lim : undefined, params }).id;
  return { id, created: true };
}

interface RoundChanges {
  volumes: Array<{ insert: string; fromDb: number; toDb: number }>;
  eq: Record<string, number> | null;
  width: { from: number; to: number } | null;
  limiter: { from: number; to: number } | null;
}

function applyRound(deps: MainDeps, ctx: RunCtx, gaps: ReturnType<typeof mixGaps>, groups: ReadonlyMap<string, PartGroup>, created: Set<string>): RoundChanges {
  const ch: RoundChanges = { volumes: [], eq: null, width: null, limiter: null };
  for (const g of PART_GROUPS) {
    const d = gaps.balance[g];
    if (!isNum(d) || Math.abs(d) < 0.75) continue;
    const delta = Math.max(-6, Math.min(6, -d));
    for (const [insId, grp] of groups) {
      if (grp !== g) continue;
      const ins = deps.doc.project.mixer.inserts[insId];
      if (!ins) continue;
      const from = gainToDb(ins.volume);
      const to = Math.max(-40, Math.min(6, (Number.isFinite(from) ? from : -40) + delta));
      if (Math.abs(to - from) < 0.05) continue;
      ctx.exec('mixer.setInsert', { id: insId, volume: Math.min(2, dbToGain(to)) });
      ch.volumes.push({ insert: ins.name, fromDb: r1(from), toDb: r1(to) });
    }
  }
  if (Object.values(gaps.bands).some((d) => isNum(d) && Math.abs(d) >= 0.5)) {
    const eq = ensureMatchEq(deps, ctx);
    if (eq.created) created.add('Match EQ');
    const slot = masterOf(deps).slots[eq.id];
    const cur = Object.fromEntries(MATCH_EQ_BANDS.map((b) => [b.band, slot.params[`${b.p}Gain`] ?? 0])) as Record<MatchBand, number>;
    const next = nextEqGains(cur, gaps.bands);
    const params: Record<string, number> = {};
    for (const b of MATCH_EQ_BANDS) if (Math.abs(next[b.band] - cur[b.band]) >= 0.05) params[`${b.p}Gain`] = next[b.band];
    if (Object.keys(params).length) {
      ctx.exec('mixer.setSlotParams', { insertId: masterOf(deps).id, slotId: eq.id, params });
      if (!slot.enabled) ctx.exec('mixer.setSlot', { insertId: masterOf(deps).id, slotId: eq.id, enabled: true });
      ch.eq = next;
    }
  }
  if (isNum(gaps.width) && Math.abs(gaps.width) >= 0.03) {
    const im = ensureMasterFx(deps, ctx, 'krypt.imager', {});
    if (im.created) created.add('Imager');
    const slot = masterOf(deps).slots[im.id];
    const cur = slot.params.midWidth ?? 1;
    const step = Math.max(-0.4, Math.min(0.4, -gaps.width * 1.5));
    const to = Math.round(Math.max(0.3, Math.min(1.8, cur + step)) * 100) / 100;
    if (Math.abs(to - cur) >= 0.01) {
      ctx.exec('mixer.setSlotParams', { insertId: masterOf(deps).id, slotId: im.id, params: { midWidth: to, highWidth: to } });
      ch.width = { from: cur, to };
    }
  }
  if (isNum(gaps.lufs) && Math.abs(gaps.lufs) >= 0.5) {
    const lim = ensureMasterFx(deps, ctx, 'krypt.limiter', { ceiling: -1 });
    if (lim.created) created.add('Limiter');
    const slot = masterOf(deps).slots[lim.id];
    const cur = slot.params.inputGain ?? 0;
    const to = Math.round(Math.max(0, Math.min(24, cur - gaps.lufs)) * 10) / 10;
    if (Math.abs(to - cur) >= 0.05) {
      ctx.exec('mixer.setSlotParams', { insertId: masterOf(deps).id, slotId: lim.id, params: { inputGain: to } });
      ch.limiter = { from: cur, to };
    }
  }
  return ch;
}

function meanAbs(x: Partial<Record<string, number>>): number | null {
  const v = Object.values(x).filter(isNum);
  return v.length ? r1(v.reduce((s, d) => s + Math.abs(d), 0) / v.length) : null;
}

export const matchMix = defineTool({
  name: 'match_mix',
  title: 'Match the mix to the reference',
  kind: 'write',
  description:
    'Brings the mix toward the studied reference (study_reference) in measured rounds: renders the loudest section (and a quiet one) with a file per insert, compares each part group (drums / bass / other / vocals, from channel names and roles) with the reference stems and sets the insert volumes; compares the master\'s tonal balance with the reference and sets a dedicated "Match EQ" on the master (a Krypt EQ at 55 Hz / 130 Hz / 350 Hz / 3.5 kHz / 9 kHz; re-runs update the same one; gains capped at ±6 dB); matches the stereo width with a master imager and the loudness with the limiter\'s input gain. Repeats for `rounds` (1-3) and reports before → after per dimension. All of it is ONE undo step. Run it after the parts are written and arranged, then review_song. Example: {"rounds":2} · {"section":"Drop 1"}',
  input: z.object({
    rounds: z.number().int().min(1).max(3).default(2).describe('Measure-and-adjust rounds (1-3).'),
    section: z.string().max(40).optional().describe('The section to match on: a marker name ("Drop 1") or a bar range "33-48". Default: the fullest section (and the thinnest one for the balance).'),
    change_label: zLabel,
  }),
  summarize: (a) => `${a.rounds ?? 2} round${(a.rounds ?? 2) === 1 ? '' : 's'}${a.section ? ` on ${safeName(a.section, 20)}` : ''}`,
  async run(deps, _c, a, ctx) {
    const warnings: string[] = [];
    const ref = await projectReference(deps, undefined, null, ctx, warnings);
    if (!ref) fail(`No studied reference to match: study_reference {"file":"<the song>"} first${warnings.length ? ` (${warnings.join(' ')})` : ''}.`);
    if (audibleReferenceClips(deps.doc.project, ref.track.channel)) {
      const n = safeName(ref.track.channel.name, 64);
      fail(`The reference "${n}" isn't muted, so it would play in the renders and be matched against itself. Mute it first: set_channel ${j({ channel: n, mute: true })}, then match_mix again.`);
    }
    const rounds = a.rounds ?? 2;
    const picked = pickSections(deps.doc.project, a.section);
    const refAn = ref.analysis;

    const secs = (refAn.sections ?? []).filter((s) => s.endSec - s.startSec >= 4 && isNum(s.lufs));
    const loudRef = secs.length ? secs.reduce((x, y) => (y.lufs > x.lufs ? y : x)) : null;
    const quietRef = secs.length > 1 ? secs.filter((s) => s !== loudRef).reduce((x, y) => (y.lufs < x.lufs ? y : x)) : null;
    const notes: string[] = [];
    let loudGroups: GroupLevels | null = null;
    let quietGroups: GroupLevels | null = null;
    const files = await referenceStemFiles(deps, ref);
    if ('problem' in files) notes.push(`Per-part balance skipped: ${files.problem}.`);
    else {
      const loud: Partial<Record<StemName, number | null>> = {};
      const quiet: Partial<Record<StemName, number | null>> = {};
      let fellBack = false;
      for (const [name, f] of Object.entries(files.stems) as Array<[StemName, { path: string; rmsDb: number } | undefined]>) {
        if (!f) continue;
        const an = deps.analyzer ? await deps.analyzer.analyze({ path: f.path }, { signal: ctx.signal }).catch(() => null) : null;
        const curve = an?.ok ? an.data?.energy : undefined;
        if (curve?.lufs?.length && loudRef) {
          loud[name] = curveLevel(curve.lufs, curve.hopSec || 0.5, loudRef.startSec, loudRef.endSec) ?? -80;
          if (quietRef) quiet[name] = curveLevel(curve.lufs, curve.hopSec || 0.5, quietRef.startSec, quietRef.endSec) ?? -80;
        } else {
          loud[name] = f.rmsDb;
          fellBack = true;
        }
      }
      loudGroups = stemGroupLevels(loud);
      quietGroups = quietRef && !fellBack ? stemGroupLevels(quiet) : null;
      if (fellBack) notes.push("The reference stems' levels are whole-song averages (their per-section loudness couldn't be read).");
    }
    const targets: MixTargets = {
      lufs: loudRef ? r1(loudRef.lufs) : ref.brief.mix.lufs,
      width: ref.brief.mix.width,
      bands: (ref.brief.mix.bandsVsMid ?? {}) as Partial<Record<string, number>>,
      loudGroups,
      quietGroups,
    };

    const groups = insertGroups(deps.doc.project, new Set([ref.track.channel.id]));
    let wantStems = !!loudGroups && Object.keys(loudGroups).length >= 2;
    if (loudGroups && !wantStems) notes.push('Per-part balance skipped: the reference stems hold fewer than two audible parts.');
    const created = new Set<string>();
    const measure = async (bars: string, label: string): Promise<MixMeasure> => {
      ctx.progress?.(-1, `rendering ${label}`);
      const out = await renderAndAnalyse(deps, { scope: 'bars', bars }, { maxBars: 64, prefix: 'mixmatch', stems: wantStems });
      if (!out.ok) fail(`The render of ${label} failed: ${out.error}. Nothing was changed.`);
      if (!out.raw) fail(`The render of ${label} came back without loudness or spectrum analysis, so there is nothing to match. Update / rebuild Krypt Studio's engine.`);
      if (wantStems && !out.stems?.length) {
        wantStems = false;
        notes.push(`Per-part balance skipped: ${out.stemsProblem ?? 'the render had no stems'}; matched on the full mix only.`);
      }
      return measureOf(out.raw, out.stems ?? null, groups);
    };

    const t0 = Date.now();
    const history: Array<ReturnType<typeof mixGaps>> = [];
    const changes: RoundChanges[] = [];
    let loudM = await measure(picked.loud.bars, picked.loud.label);
    let quietM = picked.quiet && wantStems ? await measure(picked.quiet.bars, picked.quiet.label) : null;
    for (let i = 0; i < rounds; i++) {
      const gaps = mixGaps(loudM, quietM, targets);
      history.push(gaps);
      changes.push(applyRound(deps, ctx, gaps, groups, created));
      loudM = await measure(picked.loud.bars, picked.loud.label);
      quietM = picked.quiet && wantStems ? await measure(picked.quiet.bars, picked.quiet.label) : null;
    }
    const final = mixGaps(loudM, quietM, targets);
    history.push(final);
    const ms = Date.now() - t0;

    const first = history[0];
    const L: string[] = [];
    L.push(`match_mix — ${rounds} round${rounds === 1 ? '' : 's'} on ${picked.loud.label}${picked.quiet && Object.keys(first.balance).length ? ` (+ ${picked.quiet.label} for the balance)` : ''} against "${safeName(ref.brief.name, 60)}"${loudRef ? ` (its loudest section ${r1(loudRef.startSec)}-${r1(loudRef.endSec)} s)` : ''}`);
    const balKeys = PART_GROUPS.filter((g) => isNum(first.balance[g]) || isNum(final.balance[g]));
    if (balKeys.length) L.push(`balance vs the reference (dB, each part against the rest): ${balKeys.map((g) => `${g} ${sgn(first.balance[g])} → ${sgn(final.balance[g])}`).join(' · ')}`);
    const bandKeys = MATCH_EQ_BANDS.map((b) => b.band).filter((k) => isNum(first.bands[k]) || isNum(final.bands[k]));
    if (bandKeys.length) L.push(`bands vs the reference (dB, relative to the mids): ${bandKeys.map((k) => `${k} ${sgn(first.bands[k])} → ${sgn(final.bands[k])}`).join(' · ')}`);
    if (isNum(first.width) || isNum(final.width)) L.push(`width: ${sgn(first.width)} → ${sgn(final.width)} vs the reference's ${targets.width ?? '?'}`);
    if (isNum(first.lufs) || isNum(final.lufs)) L.push(`loudness: ${sgn(first.lufs)} → ${sgn(final.lufs)} LU vs the reference's ${targets.lufs ?? '?'} LUFS (its loudest section)`);
    changes.forEach((c, i) => {
      const parts: string[] = [];
      if (c.volumes.length) parts.push(`volumes ${c.volumes.map((v) => `${safeName(v.insert, 24)} ${sgn(v.fromDb)}→${sgn(v.toDb)} dB`).join(', ')}`);
      if (c.eq) parts.push(`Match EQ ${MATCH_EQ_BANDS.map((b) => `${b.hz >= 1000 ? `${b.hz / 1000}k` : b.hz} ${sgn(c.eq![b.band])}`).join(' ')} dB`);
      if (c.width) parts.push(`imager width ${Math.round(c.width.from * 100)}% → ${Math.round(c.width.to * 100)}%`);
      if (c.limiter) parts.push(`limiter input ${sgn(c.limiter.from)} → ${sgn(c.limiter.to)} dB`);
      L.push(`round ${i + 1}: ${parts.join(' · ') || 'nothing to adjust (already within tolerance)'}`);
    });
    if (created.size) L.push(`Added on the master: ${[...created].join(', ')}.`);
    for (const n of notes) L.push(n);
    L.push('Undo: one step (undo_last). NEXT: review_song to see the closeness score.');
    const changed = changes.some((c) => c.volumes.length || c.eq || c.width || c.limiter);
    const before = [meanAbs(first.balance), meanAbs(first.bands)];
    const after = [meanAbs(final.balance), meanAbs(final.bands)];
    const summary = [
      before[0] !== null ? `balance ${before[0]} → ${after[0]} dB off` : null,
      before[1] !== null ? `bands ${before[1]} → ${after[1]} dB off` : null,
      isNum(first.lufs) ? `loudness ${sgn(first.lufs)} → ${sgn(final.lufs)} LU` : null,
    ]
      .filter(Boolean)
      .join(', ');
    if (!changed) fail(`No change: the mix is already within tolerance of the reference (${summary || 'nothing measurable'}).`);
    return {
      ok: true,
      message: `Matched the mix to "${safeName(ref.brief.name, 60)}" in ${rounds} round${rounds === 1 ? '' : 's'}: ${summary}${notes.length ? ` (${notes[0]})` : ''}.`,
      changed: [],
      text: L.join('\n'),
      warnings: warnings.length ? warnings : undefined,
      data: { rounds, section: picked, before: first, after: final, history, changes, targets, stems: wantStems, ms },
    };
  },
});

export const MATCH_MIX_TOOLS = [matchMix];
