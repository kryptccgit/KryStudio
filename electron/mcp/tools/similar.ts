import type { SimilarQuery, SimilarResult, SimilarSource } from '@shared/types';
import type { MainDeps } from '../types';
import { findSimilar, similarDepsFor, type SimilarDeps } from '../../sounds/similar';
import { fail, ToolFailure, type RunCtx, type ToolCaller } from './types';
import { agentSamplePath, AUDIO_EXT, safeName, unquotePath } from './util';
import { soundLibrary } from './instruments';

export function likeSource(deps: MainDeps, like: string): SimilarSource {
  const s = unquotePath(like);
  if (!s) fail('like is empty: pass a sample path (factory:… / pack:… / an audio file) or an instrument preset id.');
  if (s.startsWith('pack:') || (s.startsWith('factory:') && AUDIO_EXT.test(s)) || /^[A-Za-z]:[\\/]/.test(s) || /^[\\/]{2}/.test(s)) return { kind: 'sample', path: s };
  const presets = soundLibrary(deps).presets;
  const p = presets.find((x) => x.id === s) ?? presets.find((x) => x.name.toLowerCase() === s.toLowerCase());
  if (p && p.kind === 'chain') fail(`"${safeName(p.name, 60)}" is an effect chain; like compares instrument sounds and samples.`);
  if (p) return { kind: 'preset', id: p.id };
  if (/^(factory|user):/.test(s)) return { kind: 'preset', id: s };
  fail(`like "${safeName(s, 80)}" isn't a sample path or a preset: pass a path from find_samples (factory:… / pack:…), an absolute audio file path, or a preset id from find_presets.`);
}

export async function similarForAgent(deps: MainDeps, caller: ToolCaller, ctx: RunCtx | undefined, like: string, q: SimilarQuery, classify?: SimilarDeps['classify']): Promise<SimilarResult & { message: string }> {
  const source = likeSource(deps, like);
  const userFile: SimilarDeps['userFile'] = (p) => {
    try {
      return { abs: agentSamplePath(deps, p, caller).abs };
    } catch (e) {
      return { error: e instanceof ToolFailure ? e.message : `Can't read "${safeName(p, 120)}": ${(e as Error).message}` };
    }
  };
  const r = await findSimilar(similarDepsFor(deps, userFile, classify), source, q, {
    signal: ctx?.signal,
    maxNewPackSamples: 48,
    onMeasured: ctx?.progress ? (done, total) => ctx.progress!(total ? done / total : -1, `Measuring installed pack sounds (${done} of ${total})`) : undefined,
  });
  if (!r.ok || !r.data) fail(r.message ?? "Couldn't find sounds like that.");
  return { ...r.data, message: r.message ?? '' };
}

export function similarWarnings(r: SimilarResult): string[] {
  const out = [...r.notes];
  if (r.pending) out.push(`${r.pending} installed pack sound(s) of this kind are still being measured: call again with the same like to include them.`);
  return out;
}

export function likeKindText(r: SimilarResult): string {
  if (!r.source.kind) return '';
  return r.source.inferred ? ` (sounds like a ${r.source.kind})` : ` (${r.source.kind})`;
}
