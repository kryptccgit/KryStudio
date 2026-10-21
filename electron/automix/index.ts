import type { DocHost } from '@shared/doc/DocHost';
import type { MainDeps } from '../mcp/types';
import { AutoMixService } from './service';

export { AutoMixService, AutoMixCancelled, MAX_PASSES } from './service';
export type { AutoMixInto, AutoMixRun } from './service';
export { cleanAlbumExportRequest, cleanAlbumRequest, cleanAutoMixRequest, cleanMasterFileRequest } from './request';
export { forgetReferences } from './reference';

const SERVICES = new WeakMap<DocHost, AutoMixService>();

export function automixFor(deps: MainDeps): AutoMixService {
  let s = SERVICES.get(deps.doc);
  if (!s) {
    s = new AutoMixService({ deps });
    SERVICES.set(deps.doc, s);
  }
  return s;
}

export function peekAutomix(doc: DocHost): AutoMixService | undefined {
  return SERVICES.get(doc);
}

export function setAutomix(doc: DocHost, s: AutoMixService): void {
  SERVICES.set(doc, s);
}
