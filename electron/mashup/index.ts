// One MashupService per document: the IPC handlers (Home ▸ Audio Tools) and
// the MCP tool auto_mashup share it, so one build runs at a time and Cancel
// reaches it from either side. Tests register their own with setMashup.

import type { DocHost } from '@shared/doc/DocHost';
import type { MainDeps } from '../mcp/types';
import { MashupService } from './service';

export { MashupService, MashupCancelled, MASHUP_CHAINS, groupCtx } from './service';
export type { MashupInto, MashupRun } from './service';
export { cleanMashupRequest } from './request';

const SERVICES = new WeakMap<DocHost, MashupService>();

/** The service for this document (made on first use). */
export function mashupFor(deps: MainDeps): MashupService {
  let s = SERVICES.get(deps.doc);
  if (!s) {
    s = new MashupService({ deps });
    SERVICES.set(deps.doc, s);
  }
  return s;
}

/** The service for this document if one was made (tab-switch guard: a build keeps writing after its new tab opens). */
export function peekMashup(doc: DocHost): MashupService | undefined {
  return SERVICES.get(doc);
}

/** Tests: use this service for the document. */
export function setMashup(doc: DocHost, s: MashupService): void {
  SERVICES.set(doc, s);
}
