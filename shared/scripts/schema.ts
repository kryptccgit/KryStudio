import { z } from 'zod';
import type { ProjectScript } from './types';
import { SCRIPT_ID_PREFIX, SCRIPT_LIMITS } from './types';

export const zProjectScript = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(SCRIPT_LIMITS.nameChars),
  code: z.string().max(SCRIPT_LIMITS.codeChars),
});

export const zProjectScripts = z.record(z.string(), zProjectScript);

export function checkScriptsIntegrity(scripts: Record<string, ProjectScript> | undefined): string[] {
  if (!scripts) return [];
  const errs: string[] = [];
  const ids = Object.keys(scripts);
  if (ids.length > SCRIPT_LIMITS.perProject) errs.push(`project has ${ids.length} scripts (max ${SCRIPT_LIMITS.perProject})`);
  for (const [id, s] of Object.entries(scripts)) {
    if (s.id !== id) errs.push(`script ${id} is stored under another id (${s.id})`);
    if (!id.startsWith(`${SCRIPT_ID_PREFIX}_`)) errs.push(`script id ${id} must start with ${SCRIPT_ID_PREFIX}_`);
  }
  return errs;
}
