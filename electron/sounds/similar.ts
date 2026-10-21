// ──────────────────────────────────────────────────────────────────────
// "More like this" in main (research/13 §12.1): resolve a sound the user
// (Browser right-click → window.krypt.sounds.similar) or an agent
// (find_samples / find_presets {like}) points at to a timbre fingerprint,
// then rank the library around it (shared/sound-match/similar.ts).
// Node-only, no Electron import.
//
//   findSimilar(d: SimilarDeps, source: SimilarSource, q?: SimilarQuery, run?) → Promise<ActionResult<SimilarResult>>
//
// Source → fingerprint:
//   preset id        the factory index (presets are rendered by the engine at build time); a user preset that plays
//                    one sample is measured from that sample; other user presets can't be compared yet (a sentence)
//   'factory:…'      the factory index, else measured through the analyzer
//   'pack:<id>/…'    the pack cache (userData/analysis/fingerprints-packs.json), measured on first use
//   absolute file    only where the caller's file-access rule allows it (the Browser folders for the UI, the agent
//                    File access policy for MCP); measured through the analyzer (cached per file by the analyzer)
// Candidates: the factory index (presets + samples that can play here) + installed pack samples, which are
// measured lazily: at most `maxNewPackSamples` (default 24) per call; `pending` says how many are left, so the
// caller asks again (the Browser does it automatically, showing progress; agents are told to ask again).
// ──────────────────────────────────────────────────────────────────────

import path from 'node:path';
import type { ActionResult, SimilarItem, SimilarQuery, SimilarResult, SimilarSource } from '@shared/types';
import { AUDIO_EXTENSIONS, isAudioFile } from '@shared/audio/formats';
import { isInside } from '../system/files';
import { statFileSync } from '../system/download';
import { SAMPLE_KINDS, type FactorySample, type InstrumentPreset, type SampleKind } from '@shared/sounds/types';
import type { FingerprintEntry, FingerprintSource, SoundFingerprint } from '@shared/sound-match/types';
import { usableFingerprint } from '@shared/sound-match/features';
import { inferSampleKind, rankSimilar, similarKinds, type SimilarKind } from '@shared/sound-match/similar';
import type { MainDeps } from '../mcp/types';
import type { RunOptions } from '../analyzer/service';
import { fingerprintServiceFor, playableSource, presetLookup, type FingerprintFn, type FingerprintService } from './fingerprints';

export interface SimilarDeps {
  svc: FingerprintService;
  /** Instrument presets (user + factory). */
  preset(id: string): InstrumentPreset | undefined;
  /** Whether a candidate can play here (its pack is installed, its file is on disk). */
  playable(s: FingerprintSource): boolean;
  /** Factory + installed pack samples (names, kinds, root notes). */
  samples(): readonly FactorySample[];
  resolveSamplePath(p: string): string;
  /** The analyzer's fingerprint cmd; absent = only the index and the pack cache. */
  fingerprint?: FingerprintFn;
  /** The caller's file-access rule for an absolute user file: the path to read, or a sentence why not. */
  userFile(p: string): { abs: string } | { error: string };
  /** The kind a user file's name / folders suggest (find_samples' classifier); anything not a sample kind is ignored. */
  classify?(p: string): string | null;
}

export interface SimilarRunOptions extends RunOptions {
  /** New pack samples measured per call at most (default 24; 0 = cached ones only). */
  maxNewPackSamples?: number;
  /** Pack-sample measuring progress (done of this call's batch). */
  onMeasured?(done: number, total: number): void;
}

export const SIMILAR_INDEX_MISSING =
  '"More like this" needs the factory sound fingerprints (resources/factory/fingerprints.json), which are missing. In a development checkout, run npm run fingerprints (or npm run engine:build). Installed copies of Krypt Studio ship with them: reinstall to restore the file.';

const KINDS: ReadonlySet<string> = new Set(SAMPLE_KINDS);
const baseName = (p: string): string => (p.split(/[\\/:]/).pop() ?? p).replace(/\.[a-z0-9]+$/i, '');

interface Resolved {
  fp: SoundFingerprint;
  kind: SimilarKind;
  name: string;
  /** The library entry it is (excluded from the results); null for a user file. */
  self: FingerprintSource | null;
  inferred: boolean;
}

/** Measure an audio file through the analyzer (whole file, pitch on). */
async function measure(d: SimilarDeps, abs: string, name: string, run?: RunOptions): Promise<ActionResult<SoundFingerprint>> {
  if (!d.fingerprint) return { ok: false, message: `"${name}" can't be measured in this session: the audio analyzer isn't available (see the log).` };
  try {
    const r = await d.fingerprint(abs, undefined, { pitch: true }, run);
    if (!r.ok) return { ok: false, message: `Couldn't measure "${name}": ${r.message ?? 'the analyzer failed'}` };
    const fp = r.data?.whole;
    if (!usableFingerprint(fp)) return { ok: false, message: `"${name}" is silent or too short to compare.` };
    return { ok: true, data: fp };
  } catch (e) {
    return { ok: false, message: `Couldn't measure "${name}": ${(e as Error).message}` };
  }
}

async function resolveSource(d: SimilarDeps, source: SimilarSource, index: readonly FingerprintEntry[], run?: RunOptions): Promise<ActionResult<Resolved>> {
  if (source.kind === 'preset') {
    const id = source.id.trim();
    const p = d.preset(id);
    const hit = index.find((e) => e.source.kind === 'preset' && e.source.id === id);
    if (!p && !hit) return { ok: false, message: `There's no instrument preset "${id.slice(0, 80)}".` };
    const name = p?.name ?? id;
    const role = p?.role ?? (hit!.source as Extract<FingerprintSource, { kind: 'preset' }>).role;
    if (hit) return { ok: true, data: { fp: hit.fp, kind: { kind: 'preset', role }, name, self: hit.source, inferred: false } };
    // A preset the index doesn't know (yours): a one-sample preset sounds like its sample.
    if (p?.sample && p.plugin === 'krypt.sampler') {
      let abs = '';
      try {
        abs = d.resolveSamplePath(p.sample);
      } catch {
        abs = '';
      }
      const m = abs ? await measure(d, abs, name, run) : { ok: false, message: `The sample of "${name}" isn't on this PC.` };
      if (!m.ok || !m.data) return { ok: false, message: m.message };
      return { ok: true, data: { fp: m.data, kind: { kind: 'preset', role }, name, self: { kind: 'preset', id, role, note: 60 }, inferred: false } };
    }
    return {
      ok: false,
      message: `"${name}" hasn't been measured: "More like this" knows the factory presets and presets that play one sample. Try it on the factory preset you started from, or on a sample.`,
    };
  }

  const p = source.path.trim();
  if (p.startsWith('factory:') || p.startsWith('pack:')) {
    const meta = d.samples().find((x) => x.path === p);
    const name = meta?.name ?? baseName(p);
    const hit = index.find((e) => e.source.kind === 'sample' && e.source.path === p);
    if (hit && hit.source.kind === 'sample') return { ok: true, data: { fp: hit.fp, kind: { kind: 'sample', sampleKind: hit.source.sampleKind }, name, self: hit.source, inferred: false } };
    if (p.startsWith('pack:')) {
      if (!meta) return { ok: false, message: `"${name}" isn't in an installed sound pack (download the pack in Home ▸ Sounds first).` };
      const r = await d.svc.packFingerprint(p, meta.kind, run);
      if (!r.fp) return { ok: false, message: `"${name}" ${r.problem ?? "couldn't be measured"}.` };
      return { ok: true, data: { fp: r.fp, kind: { kind: 'sample', sampleKind: meta.kind }, name, self: { kind: 'sample', path: p, sampleKind: meta.kind }, inferred: false } };
    }
    // A factory sound the index doesn't list (a newer kit): measure it.
    let abs = '';
    try {
      abs = d.resolveSamplePath(p);
    } catch {
      abs = '';
    }
    if (!abs) return { ok: false, message: `Factory sound "${name}" isn't on this PC.` };
    const m = await measure(d, abs, name, run);
    if (!m.ok || !m.data) return { ok: false, message: m.message };
    const kind = meta?.kind ?? null;
    return { ok: true, data: { fp: m.data, kind: { kind: 'sample', sampleKind: kind }, name, self: kind ? { kind: 'sample', path: p, sampleKind: kind } : null, inferred: false } };
  }

  // A file of the user's own.
  const access = d.userFile(p);
  if ('error' in access) return { ok: false, message: access.error };
  const name = baseName(access.abs);
  const m = await measure(d, access.abs, name, run);
  if (!m.ok || !m.data) return { ok: false, message: m.message };
  let named: string | null = null;
  try {
    // The file name and its two closest folders ("Kicks/Hard 01.wav").
    named = d.classify?.(access.abs.split(/[\\/]/).slice(-3).join('/')) ?? null;
  } catch {
    named = null;
  }
  if (named && KINDS.has(named)) return { ok: true, data: { fp: m.data, kind: { kind: 'sample', sampleKind: named as SampleKind }, name, self: null, inferred: false } };
  const guess = inferSampleKind(m.data, index);
  return { ok: true, data: { fp: m.data, kind: { kind: 'sample', sampleKind: guess?.kind ?? null }, name, self: null, inferred: !!guess } };
}

/** "More like this": see the top of this file. Never throws. */
export async function findSimilar(d: SimilarDeps, source: SimilarSource, q: SimilarQuery = {}, run: SimilarRunOptions = {}): Promise<ActionResult<SimilarResult>> {
  try {
    const { index, problem } = d.svc.index();
    if (!index) return { ok: false, message: problem && !/missing/.test(problem) ? problem : SIMILAR_INDEX_MISSING };
    const scope = q.scope === 'any' ? 'any' : 'same';
    const want = q.want === 'samples' || q.want === 'presets' ? q.want : 'all';
    const limit = Math.max(1, Math.min(100, Math.floor(Number.isFinite(q.limit) ? q.limit! : 40)));
    const src = await resolveSource(d, source, index.entries, run);
    if (!src.ok || !src.data) return { ok: false, message: src.message ?? "Couldn't measure that sound." };
    if (run.signal?.aborted) return { ok: false, message: '"More like this" was cancelled.' };
    const { fp, kind, name, self, inferred } = src.data;
    const effScope = kind.kind === 'sample' && !kind.sampleKind ? 'any' : scope;

    // Candidates: the factory index + installed pack samples of the kinds searched (measured lazily).
    let candidates: FingerprintEntry[] = index.entries;
    const notes: string[] = [];
    let pending = 0;
    let measured = 0;
    if (want !== 'presets') {
      const kinds = effScope === 'same' ? similarKinds(kind).kinds : [...SAMPLE_KINDS];
      const p = await d.svc.packEntries(kinds, { max: run.maxNewPackSamples ?? 24, run, onMeasured: run.onMeasured });
      if (p.entries.length) candidates = [...candidates, ...p.entries];
      pending = p.pending;
      measured = p.measured;
      if (p.problem) notes.push(p.problem);
    }
    const hits = rankSimilar(fp, kind, candidates, { scope: effScope, want, limit, exclude: self, allow: d.playable, preset: d.preset });

    const byPath = new Map(d.samples().map((x) => [x.path, x]));
    const items: SimilarItem[] = [];
    for (const h of hits) {
      const common = { percent: Math.round(h.similarity * 100), why: h.why, sameKind: h.relation !== 'other' };
      if (h.source.kind === 'sample') {
        const meta = byPath.get(h.source.path);
        items.push({
          type: 'sample',
          path: h.source.path,
          kind: h.source.sampleKind,
          origin: h.source.path.startsWith('pack:') ? 'pack' : 'factory',
          name: meta?.name ?? baseName(h.source.path),
          ...(meta?.rootNote !== undefined ? { rootNote: meta.rootNote } : {}),
          ...(meta?.bars !== undefined ? { bars: meta.bars } : {}),
          ...common,
        });
      } else {
        const p = d.preset(h.source.id);
        if (!p) continue;
        items.push({ type: 'preset', id: p.id, role: p.role, plugin: p.plugin, origin: p.id.startsWith('user:') ? 'user' : 'factory', name: p.name, ...common });
      }
    }
    const kindWord = kind.kind === 'preset' ? kind.role : kind.sampleKind;
    const message = items.length
      ? `${items.length} sound${items.length === 1 ? '' : 's'} like "${name}"${pending ? ` (${pending} more pack sound${pending === 1 ? '' : 's'} being measured)` : ''}.`
      : effScope === 'same' && kindWord
        ? `No other ${kindWord} sounds to compare "${name}" with${pending ? ` yet (${pending} pack sound${pending === 1 ? '' : 's'} still being measured)` : ''}. Try any kind.`
        : `Nothing in the library to compare "${name}" with.`;
    return { ok: true, message, data: { source: { name, kind: kindWord ?? null, inferred }, scope: effScope, items, pending, measured, notes } };
  } catch (e) {
    return { ok: false, message: `"More like this" failed: ${(e as Error).message}` };
  }
}

/**
 * The Browser's file rule for "More like this" from the UI: an absolute audio file inside one of the Browser's
 * folders (the same rule as browser.list), that is still there. Network / device paths are refused.
 */
export function browserFileAccess(roots: () => readonly string[]): SimilarDeps['userFile'] {
  return (p) => {
    const name = path.basename(p) || p;
    if (!path.isAbsolute(p) || /^[\\/]{2}/.test(p)) return { error: `"${name}" isn't a sound in the Browser.` };
    if (!isAudioFile(p)) return { error: `"${name}" isn't an audio file Krypt Studio can read (${AUDIO_EXTENSIONS.join(', ')}).` };
    if (!roots().some((r) => isInside(r, p))) return { error: `"${name}" isn't in a Browser folder. Add its folder with "Add folder" first.` };
    if (!statFileSync(p)) return { error: `"${name}" isn't there any more (moved or deleted?).` };
    return { abs: p };
  };
}

/** SimilarDeps over MainDeps (the factory index, pack cache and analyzer of this session) with a file-access rule. */
export function similarDepsFor(deps: MainDeps, userFile: SimilarDeps['userFile'], classify?: SimilarDeps['classify']): SimilarDeps {
  const preset = presetLookup(deps);
  return {
    svc: fingerprintServiceFor(deps),
    preset,
    playable: playableSource(deps, preset),
    samples: () => {
      try {
        return deps.sounds?.factoryIndex()?.samples ?? [];
      } catch {
        return [];
      }
    },
    resolveSamplePath: (p) => deps.project.resolveSamplePath(p),
    fingerprint: deps.analyzer?.fingerprint ? (abs, segs, o, r) => deps.analyzer!.fingerprint!(abs, segs, o, r) : undefined,
    userFile,
    classify,
  };
}

