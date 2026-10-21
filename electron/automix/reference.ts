import path from 'node:path';
import type { ActionResult } from '@shared/types';
import type { Analysis } from '@shared/engine/protocol';
import type { ReferenceSound } from '@shared/automix/types';
import { isAudioFile } from '@shared/audio/formats';
import { referenceSoundOf, songNameFromPath } from '@shared/automix/reference';
import { readJson, sha256Text, statFile } from '../system/download';
import { writeFileAtomic } from '../system/files';
import type { MainDeps } from '../mcp/types';

const CACHE_VERSION = 1;
const MEMO = new Map<string, ReferenceSound>();

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function forgetReferences(): void {
  MEMO.clear();
}

export async function readReference(deps: MainDeps, rawPath: string, opts: { signal?: AbortSignal } = {}): Promise<ActionResult<ReferenceSound>> {
  const abs = String(rawPath ?? '').trim();
  const name = songNameFromPath(abs);
  if (!abs) return { ok: false, message: 'Pick a reference song (an audio file).' };
  if (!path.isAbsolute(abs) || !isAudioFile(abs)) return { ok: false, message: `"${path.basename(abs).slice(0, 80)}" isn't an audio file Krypt Studio can read (wav, flac, mp3, ogg, aiff, m4a …).` };
  const st = await statFile(abs);
  if (!st) return { ok: false, message: `"${name}" wasn't found (moved or deleted?).` };
  const key = sha256Text(`${path.resolve(abs).toLowerCase()}|${st.size}|${st.mtimeMs}`).slice(0, 32);
  const memo = MEMO.get(key);
  if (memo) return { ok: true, message: `Reference "${name}": ${memo.summary} (cached).`, data: { ...memo, path: abs, cached: true } };
  const file = path.join(deps.userDataDir, 'analysis', `ref-${key}.json`);
  const disk = await readJson<{ v: number; sound: ReferenceSound }>(file);
  if (disk?.v === CACHE_VERSION && disk.sound && typeof disk.sound.lufs === 'number') {
    MEMO.set(key, disk.sound);
    return { ok: true, message: `Reference "${name}": ${disk.sound.summary} (cached).`, data: { ...disk.sound, path: abs, name, cached: true } };
  }
  let analysis: Analysis | null = null;
  if (deps.analyzer) {
    const prior = await deps.analyzer.analyze({ path: abs }, { cachedOnly: true }).catch(() => null);
    if (prior?.ok && prior.data?.levels) analysis = { ...prior.data.levels, stereoWidth: prior.data.levels.stereoWidth ?? prior.data.stereo?.width };
  }
  if (opts.signal?.aborted) return { ok: false, message: 'Cancelled: nothing was changed.' };
  if (!analysis) {
    const r = await deps.engine.analyzeFile(abs).catch((e) => ({ ok: false as const, message: errText(e), data: undefined }));
    if (!r.ok || !r.data) return { ok: false, message: `Couldn't measure "${name}": ${r.message ?? 'the engine returned no analysis'}.` };
    analysis = r.data;
  }
  if (opts.signal?.aborted) return { ok: false, message: 'Cancelled: nothing was changed.' };
  const sound = referenceSoundOf(analysis, { path: abs, name, cached: false });
  if (typeof sound === 'string') return { ok: false, message: `"${name}" can't be a reference: ${sound}.` };
  MEMO.set(key, sound);
  await writeFileAtomic(file, JSON.stringify({ v: CACHE_VERSION, sound })).catch((e) => deps.log('warn', `Couldn't cache the reference reading of "${name}": ${errText(e)}`));
  return { ok: true, message: `Reference "${name}": ${sound.summary}.`, data: sound };
}
