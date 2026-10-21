// One AutoMixService per document: the IPC handlers (the Mixer's Auto Mix panel, Home ▸ Audio Tools ▸ Master a
// song) and the MCP tool auto_mix share it, so one run happens at a time and Cancel reaches it from either side.
// Tests register their own with setAutomix.

import type { DocHost } from '@shared/doc/DocHost';
import type { MainDeps } from '../mcp/types';
import { AutoMixService } from './service';

export { AutoMixService, AutoMixCancelled, MAX_PASSES } from './service';
export type { AutoMixInto, AutoMixRun } from './service';
export { cleanAlbumExportRequest, cleanAlbumRequest, cleanAutoMixRequest, cleanMasterFileRequest } from './request';
export { forgetReferences } from './reference';

const SERVICES = new WeakMap<DocHost, AutoMixService>();

/** The service for this document (made on first use). */
export function automixFor(deps: MainDeps): AutoMixService {
  let s = SERVICES.get(deps.doc);
  if (!s) {
    s = new AutoMixService({ deps });
    SERVICES.set(deps.doc, s);
  }
  return s;
}

/** The service for this document if one was made (the tab-switch guard). */
export function peekAutomix(doc: DocHost): AutoMixService | undefined {
  return SERVICES.get(doc);
}

/** Tests: use this service for the document. */
export function setAutomix(doc: DocHost, s: AutoMixService): void {
  SERVICES.set(doc, s);
}
