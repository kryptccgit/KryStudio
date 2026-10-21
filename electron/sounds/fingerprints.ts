import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ActionResult } from '@shared/types';
import type { InstrumentPreset, SampleKind } from '@shared/sounds/types';
import { INSTRUMENT_ROLES, SAMPLE_KINDS } from '@shared/sounds/types';
import type { FingerprintEntry, FingerprintIndex, FingerprintSource, MatchTarget, SoundFingerprint, SoundMatch } from '@shared/sound-match/types';
import { rankMatches, sampleKindsFor } from '@shared/sound-match/match';
import { usableFingerprint } from '@shared/sound-match/features';
import { FACTORY_PRESETS } from '@shared/sounds/factory';
import { writeFileAtomic } from '../system/files';
import { readJson, statFile } from '../system/download';
import { missingPack } from '../packs/gating';
import type { MainDeps } from '../mcp/types';
import type { FingerprintResult, RunOptions } from '../analyzer/service';

const zNum = z.number().finite();
export const zSoundFingerprint = z.object({
  lengthSec: zNum.min(0),
  centroidHz: zNum.min(0),
  rolloffHz: zNum.min(0),
  flatness: zNum.min(0).max(1.0001),
  harmonicity: zNum.min(0).max(1.0001),
  f0Hz: zNum.positive().nullable(),
  attackMs: zNum.min(0),
  decayMs: zNum.min(0),
  sustain: zNum.min(0).max(1.5),
  bands: z.object({ sub: zNum, low: zNum, lowMid: zNum, mid: zNum, highMid: zNum, high: zNum }),
  crestDb: zNum,
  width: zNum.min(0).max(1.5),
  peakDb: zNum,
  rmsDb: zNum,
});

const zSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), id: z.string().min(1).max(200), role: z.enum(INSTRUMENT_ROLES), note: z.number().int().min(0).max(127) }),
  z.object({ kind: z.literal('sample'), path: z.string().min(1).max(400).regex(/^(factory|pack):[^\\]+$/), sampleKind: z.enum(SAMPLE_KINDS) }),
]);

const zEntry = z.object({ source: zSource, fp: zSoundFingerprint });
const zIndexTop = z.object({ version: z.literal(1), generator: z.string().max(300), entries: z.array(z.unknown()) });

export function parseFingerprintIndex(raw: unknown): { index: FingerprintIndex | null; skipped: number; error?: string } {
  const top = zIndexTop.safeParse(raw);
  if (!top.success) {
    const i = top.error.issues[0];
    return { index: null, skipped: 0, error: `${i?.path.join('.') || 'index'}: ${i?.message ?? 'invalid'}` };
  }
  const entries: FingerprintEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const e of top.data.entries) {
    const r = zEntry.safeParse(e);
    const key = r.success ? (r.data.source.kind === 'preset' ? `p:${r.data.source.id}` : `s:${r.data.source.path}`) : '';
    if (!r.success || seen.has(key) || !usableFingerprint(r.data.fp as SoundFingerprint)) {
      skipped++;
      continue;
    }
    seen.add(key);
    entries.push(r.data as FingerprintEntry);
  }
  return { index: { version: 1, generator: top.data.generator, entries }, skipped };
}

interface PackCacheEntry {
  path: string;
  sampleKind: SampleKind;
  size: number;
  mtimeMs: number;
  fp: SoundFingerprint | null;
}

interface PackCacheFile {
  version: 1;
  entries: PackCacheEntry[];
}

const zPackCache = z.object({
  version: z.literal(1),
  entries: z.array(
    z.object({
      path: z.string().min(1).max(400),
      sampleKind: z.enum(SAMPLE_KINDS),
      size: z.number().int().min(0),
      mtimeMs: z.number().finite(),
      fp: zSoundFingerprint.nullable(),
    }),
  ),
});

export type FingerprintFn = (absPath: string, segments?: Array<{ startSec: number; endSec: number }>, opts?: { pitch?: boolean }, run?: RunOptions) => Promise<ActionResult<FingerprintResult>>;

export interface FingerprintServiceDeps {
  indexFile: string;
  userDataDir: string;
  fingerprint?: FingerprintFn;
  packSamples(): Array<{ path: string; kind: SampleKind }>;
  resolveSamplePath(p: string): string;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface MatchSoundsOptions {
  limit?: number;
  levelOffsetDb?: number;
  includePacks?: boolean;
  allow?: (s: FingerprintSource) => boolean;
  preset?: (id: string) => InstrumentPreset | undefined;
  run?: RunOptions;
  maxNewPackSamples?: number;
}

const INDEX_MISSING =
  "Sound matching isn't available: the factory fingerprint index (resources/factory/fingerprints.json) is missing. It is generated with the engine (npm run fingerprints, or npm run engine:build); until then pick sounds with find_presets / find_samples.";

export class FingerprintService {
  private key = '';
  private cached: { index: FingerprintIndex | null; problem?: string } = { index: null, problem: INDEX_MISSING };
  private packs: PackCacheFile | null = null;
  private packsLoad: Promise<PackCacheFile> | null = null;
  private readonly packFile: string;

  constructor(private readonly deps: FingerprintServiceDeps) {
    this.packFile = path.join(deps.userDataDir, 'analysis', 'fingerprints-packs.json');
  }

  index(): { index: FingerprintIndex | null; problem?: string } {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.deps.indexFile);
    } catch {
      this.key = 'missing';
      this.cached = { index: null, problem: INDEX_MISSING };
      return this.cached;
    }
    const k = `${st.mtimeMs}:${st.size}`;
    if (k === this.key) return this.cached;
    this.key = k;
    try {
      const r = parseFingerprintIndex(JSON.parse(fs.readFileSync(this.deps.indexFile, 'utf8')));
      if (!r.index) {
        this.cached = { index: null, problem: `Sound matching isn't available: the fingerprint index is not valid (${r.error}). Regenerate it with npm run fingerprints.` };
        this.deps.log('warn', `[sounds] ${this.cached.problem}`);
      } else {
        if (r.skipped) this.deps.log('warn', `[sounds] Fingerprint index: skipped ${r.skipped} malformed entr${r.skipped === 1 ? 'y' : 'ies'}.`);
        this.cached = { index: r.index };
      }
    } catch (e) {
      this.cached = { index: null, problem: `Sound matching isn't available: couldn't read the fingerprint index (${(e as Error).message}).` };
      this.deps.log('warn', `[sounds] ${this.cached.problem}`);
    }
    return this.cached;
  }

  private async loadPacks(): Promise<PackCacheFile> {
    if (this.packs) return this.packs;
    if (!this.packsLoad) {
      this.packsLoad = (async () => {
        const raw = await readJson<unknown>(this.packFile);
        const r = raw === null ? null : zPackCache.safeParse(raw);
        if (r && !r.success) this.deps.log('warn', `[sounds] ${this.packFile} is not valid; pack samples will be measured again.`);
        this.packs = r?.success ? (r.data as PackCacheFile) : { version: 1, entries: [] };
        return this.packs;
      })().finally(() => (this.packsLoad = null));
    }
    return this.packsLoad;
  }

  async packEntries(kinds: readonly SampleKind[], opts: { max?: number; run?: RunOptions; onMeasured?: (done: number, total: number) => void } = {}): Promise<{ entries: FingerprintEntry[]; measured: number; pending: number; problem?: string }> {
    if (!kinds.length) return { entries: [], measured: 0, pending: 0 };
    let samples: Array<{ path: string; kind: SampleKind }>;
    try {
      samples = this.deps.packSamples().filter((s) => s.path.startsWith('pack:') && kinds.includes(s.kind));
    } catch (e) {
      return { entries: [], measured: 0, pending: 0, problem: `Couldn't list the installed pack samples: ${(e as Error).message}` };
    }
    if (!samples.length) return { entries: [], measured: 0, pending: 0 };
    const cache = await this.loadPacks();
    const byPath = new Map(cache.entries.map((e) => [e.path, e]));
    const entries: FingerprintEntry[] = [];
    const todo: Array<{ s: { path: string; kind: SampleKind }; abs: string; size: number; mtimeMs: number }> = [];
    for (const s of samples) {
      const abs = this.deps.resolveSamplePath(s.path);
      const st = abs ? await statFile(abs) : null;
      if (!st) continue;
      const hit = byPath.get(s.path);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
        if (hit.fp) entries.push({ source: { kind: 'sample', path: s.path, sampleKind: s.kind }, fp: hit.fp });
        continue;
      }
      todo.push({ s, abs, size: st.size, mtimeMs: st.mtimeMs });
    }
    if (!todo.length) return { entries, measured: 0, pending: 0 };
    if (!this.deps.fingerprint) return { entries, measured: 0, pending: todo.length, problem: `${todo.length} pack sample(s) can't be measured in this session (no audio analyzer).` };
    const max = Math.max(0, Math.floor(opts.max ?? 48));
    const batch = todo.slice(0, max);
    let measured = 0;
    let failed = 0;
    let problem: string | undefined;
    for (const t of batch) {
      if (opts.run?.signal?.aborted) break;
      let fp: SoundFingerprint | null = null;
      try {
        const r = await this.deps.fingerprint(t.abs, undefined, { pitch: true }, opts.run);
        if (!r.ok) {
          if (/unknown|not supported|unexpected|cancel|not available|isn't running/i.test(r.message ?? '')) {
            problem = `Pack samples couldn't be measured: ${r.message}`;
            break;
          }
          failed++;
        } else fp = r.data?.whole && usableFingerprint(r.data.whole) ? r.data.whole : null;
      } catch (e) {
        problem = `Pack samples couldn't be measured: ${(e as Error).message}`;
        break;
      }
      measured++;
      const entry: PackCacheEntry = { path: t.s.path, sampleKind: t.s.kind, size: t.size, mtimeMs: t.mtimeMs, fp };
      byPath.set(t.s.path, entry);
      if (fp) entries.push({ source: { kind: 'sample', path: t.s.path, sampleKind: t.s.kind }, fp });
      opts.onMeasured?.(measured, batch.length);
    }
    if (measured) {
      cache.entries = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
      await this.savePacks(cache);
    }
    if (failed) this.deps.log('warn', `[sounds] ${failed} pack sample(s) couldn't be measured; they are skipped until they change.`);
    return { entries, measured, pending: todo.length - measured, ...(problem ? { problem } : {}) };
  }

  private async savePacks(cache: PackCacheFile): Promise<void> {
    try {
      const raw = await readJson<unknown>(this.packFile);
      const disk = raw === null ? null : zPackCache.safeParse(raw);
      if (disk?.success) {
        const ours = new Set(cache.entries.map((e) => e.path));
        const theirs = (disk.data as PackCacheFile).entries.filter((e) => !ours.has(e.path));
        if (theirs.length) cache.entries = [...cache.entries, ...theirs].sort((a, b) => a.path.localeCompare(b.path));
      }
      await writeFileAtomic(this.packFile, JSON.stringify(cache));
    } catch (e) {
      this.deps.log('warn', `[sounds] Couldn't save the pack fingerprint cache: ${(e as Error).message}`);
    }
  }

  async packFingerprint(p: string, kind: SampleKind, run?: RunOptions): Promise<{ fp: SoundFingerprint | null; problem?: string }> {
    let abs = '';
    try {
      abs = this.deps.resolveSamplePath(p);
    } catch {
      abs = '';
    }
    const st = abs ? await statFile(abs) : null;
    if (!st) return { fp: null, problem: "isn't on this PC (is its sound pack installed?)" };
    const cache = await this.loadPacks();
    const hit = cache.entries.find((e) => e.path === p);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.fp ? { fp: hit.fp } : { fp: null, problem: "couldn't be measured (the analyzer couldn't read it)" };
    if (!this.deps.fingerprint) return { fp: null, problem: "can't be measured in this session (no audio analyzer)" };
    let fp: SoundFingerprint | null = null;
    try {
      const r = await this.deps.fingerprint(abs, undefined, { pitch: true }, run);
      if (!r.ok) return { fp: null, problem: `couldn't be measured: ${r.message ?? 'the analyzer failed'}` };
      fp = r.data?.whole && usableFingerprint(r.data.whole) ? r.data.whole : null;
    } catch (e) {
      return { fp: null, problem: `couldn't be measured: ${(e as Error).message}` };
    }
    cache.entries = [...cache.entries.filter((e) => e.path !== p), { path: p, sampleKind: kind, size: st.size, mtimeMs: st.mtimeMs, fp }].sort((a, b) => a.path.localeCompare(b.path));
    await this.savePacks(cache);
    return fp ? { fp } : { fp: null, problem: 'is silent or too short to compare' };
  }

  fingerprintOf(source: FingerprintSource): SoundFingerprint | null {
    if (source.kind === 'sample' && source.path.startsWith('pack:')) return this.packs?.entries.find((e) => e.path === source.path)?.fp ?? null;
    const idx = this.index().index;
    const hit = idx?.entries.find((e) => (source.kind === 'preset' ? e.source.kind === 'preset' && e.source.id === source.id : e.source.kind === 'sample' && e.source.path === source.path));
    return hit?.fp ?? null;
  }

  async match(targetFps: readonly SoundFingerprint[], target: MatchTarget, opts: MatchSoundsOptions & { isAllowed?: (s: FingerprintSource) => boolean } = {}): Promise<ActionResult<SoundMatch[]> & { notes?: string[] }> {
    const { index, problem } = this.index();
    if (!index) return { ok: false, message: problem ?? INDEX_MISSING };
    const usable = targetFps.filter(usableFingerprint);
    if (!usable.length) return { ok: false, message: `Nothing to match the ${target.role} against: the reference part has no measurable sound (silent or too short).` };
    const notes: string[] = [];
    let candidates: FingerprintEntry[] = index.entries;
    if (opts.includePacks !== false) {
      const kinds = sampleKindsFor(target);
      const p = await this.packEntries(kinds, { max: opts.maxNewPackSamples, run: opts.run });
      if (p.entries.length) candidates = [...candidates, ...p.entries];
      if (p.problem) notes.push(p.problem);
      else if (p.pending) notes.push(`${p.pending} installed pack sample(s) are still being measured; ask again to include them.`);
    }
    const allow = (s: FingerprintSource) => (opts.isAllowed ? opts.isAllowed(s) : true) && (opts.allow ? opts.allow(s) : true);
    const matches = rankMatches(usable, candidates, target, { limit: Math.min(20, opts.limit ?? 3), levelOffsetDb: opts.levelOffsetDb, preset: opts.preset, allow });
    const n = usable.length;
    return {
      ok: true,
      message: matches.length
        ? `Best match for the ${target.role} (${n} measurement${n === 1 ? '' : 's'}): ${matches[0].source.kind === 'preset' ? matches[0].source.id : matches[0].source.path} (${Math.round(matches[0].similarity * 100)}%).`
        : `No ${target.role} sound in the library is eligible to match (none of its kind is installed).`,
      data: matches,
      ...(notes.length ? { notes } : {}),
    };
  }
}

const SERVICES = new WeakMap<object, FingerprintService>();

export function fingerprintServiceFor(deps: MainDeps): FingerprintService {
  let s = SERVICES.get(deps);
  if (!s) {
    s = new FingerprintService({
      indexFile: deps.project.resolveSamplePath('factory:fingerprints.json'),
      userDataDir: deps.userDataDir,
      fingerprint: deps.analyzer?.fingerprint ? (abs, segs, o, run) => deps.analyzer!.fingerprint!(abs, segs, o, run) : undefined,
      packSamples: () => (deps.sounds?.factoryIndex()?.samples ?? []).filter((x) => x.path.startsWith('pack:')).map((x) => ({ path: x.path, kind: x.kind })),
      resolveSamplePath: (p) => deps.project.resolveSamplePath(p),
      log: (level, m) => deps.log(level, m),
    });
    SERVICES.set(deps, s);
  }
  return s;
}

export function presetLookup(deps: MainDeps): (id: string) => InstrumentPreset | undefined {
  return (id) => {
    let p = null as ReturnType<NonNullable<MainDeps['sounds']>['preset']> | null;
    try {
      p = deps.sounds?.preset(id) ?? null;
    } catch {
      p = null;
    }
    p ??= FACTORY_PRESETS.find((x) => x.id === id) ?? null;
    return p && p.kind === 'instrument' ? p : undefined;
  };
}

export function playableSource(deps: MainDeps, lookup = presetLookup(deps)): (s: FingerprintSource) => boolean {
  const exists = new Map<string, boolean>();
  const onDisk = (p: string) => {
    let v = exists.get(p);
    if (v === undefined) {
      try {
        v = fs.existsSync(deps.project.resolveSamplePath(p));
      } catch {
        v = false;
      }
      exists.set(p, v);
    }
    return v;
  };
  return (s) => {
    if (s.kind === 'sample') return onDisk(s.path);
    const p = lookup(s.id);
    if (!p || missingPack(deps.packs, p)) return false;
    return !p.sample || onDisk(p.sample);
  };
}

export async function matchSounds(deps: MainDeps, targetFps: readonly SoundFingerprint[], target: MatchTarget, opts: MatchSoundsOptions = {}): Promise<ActionResult<SoundMatch[]> & { notes?: string[] }> {
  const lookup = opts.preset ?? presetLookup(deps);
  return fingerprintServiceFor(deps).match(targetFps, target, { ...opts, preset: lookup, isAllowed: playableSource(deps, lookup) });
}
