// One AudioProjectService per document: the IPC handlers (File ▸ Open audio
// as project) and the MCP tools (audio_to_project, build_from_reference)
// share it, so one conversion runs at a time and Cancel reaches it from
// either side. Tests register their own (fake cores) with setAudioProject.

import type { DocHost } from '@shared/doc/DocHost';
import type { MainDeps } from '../mcp/types';
import { matchSounds, presetLookup } from '../sounds/fingerprints';
import { DEFAULT_CORE } from './core';
import { AudioProjectService } from './service';
import type { SoundMatcher } from './sounds';

export { AudioProjectService, OWNERSHIP_LINE, PipelineCancelled, pumps } from './service';
export type { Prepared, PrepareOptions, PipelineRun } from './service';

const SERVICES = new WeakMap<DocHost, AudioProjectService>();

/** match-core over the factory fingerprint index (+ installed pack samples). */
export function defaultMatcher(deps: MainDeps): SoundMatcher {
  return async (fps, target) => {
    const r = await matchSounds(deps, fps, target, { limit: 5, preset: presetLookup(deps) });
    return r.ok ? { ok: true, matches: r.data ?? [] } : { ok: false, problem: r.message ?? 'Sound matching failed.' };
  };
}

/** The service for this document (made on first use with the shipped cores). */
export function audioProjectFor(deps: MainDeps): AudioProjectService {
  let s = SERVICES.get(deps.doc);
  if (!s) {
    s = new AudioProjectService({ deps, core: DEFAULT_CORE, matcher: defaultMatcher(deps) });
    SERVICES.set(deps.doc, s);
  }
  return s;
}

/** The document's service if one was made (the project tabs read its busy label), without making one. */
export function peekAudioProject(doc: DocHost): AudioProjectService | null {
  return SERVICES.get(doc) ?? null;
}

/** Tests: use this service for the document. */
export function setAudioProject(doc: DocHost, s: AudioProjectService): void {
  SERVICES.set(doc, s);
}
