import type { DocHost } from '@shared/doc/DocHost';
import type { MainDeps } from '../mcp/types';
import { MashupService } from './service';

export { MashupService, MashupCancelled, MASHUP_CHAINS, groupCtx } from './service';
export type { MashupInto, MashupRun } from './service';
export { cleanMashupRequest } from './request';

const SERVICES = new WeakMap<DocHost, MashupService>();

export function mashupFor(deps: MainDeps): MashupService {
  let s = SERVICES.get(deps.doc);
  if (!s) {
    s = new MashupService({ deps });
    SERVICES.set(deps.doc, s);
  }
  return s;
}

export function peekMashup(doc: DocHost): MashupService | undefined {
  return SERVICES.get(doc);
}

export function setMashup(doc: DocHost, s: MashupService): void {
  SERVICES.set(doc, s);
}
