import type { DocHost } from '@shared/doc/DocHost';
import type { MainDeps } from '../mcp/types';
import { matchSounds, presetLookup } from '../sounds/fingerprints';
import { DEFAULT_CORE } from './core';
import { AudioProjectService } from './service';
import type { SoundMatcher } from './sounds';

export { AudioProjectService, OWNERSHIP_LINE, PipelineCancelled, pumps } from './service';
export type { Prepared, PrepareOptions, PipelineRun } from './service';

const SERVICES = new WeakMap<DocHost, AudioProjectService>();

export function defaultMatcher(deps: MainDeps): SoundMatcher {
  return async (fps, target) => {
    const r = await matchSounds(deps, fps, target, { limit: 5, preset: presetLookup(deps) });
    return r.ok ? { ok: true, matches: r.data ?? [] } : { ok: false, problem: r.message ?? 'Sound matching failed.' };
  };
}

export function audioProjectFor(deps: MainDeps): AudioProjectService {
  let s = SERVICES.get(deps.doc);
  if (!s) {
    s = new AudioProjectService({ deps, core: DEFAULT_CORE, matcher: defaultMatcher(deps) });
    SERVICES.set(deps.doc, s);
  }
  return s;
}

export function peekAudioProject(doc: DocHost): AudioProjectService | null {
  return SERVICES.get(doc) ?? null;
}

export function setAudioProject(doc: DocHost, s: AudioProjectService): void {
  SERVICES.set(doc, s);
}
