// Sample pool lookups for agents (delete_objects samples, load_sample relink):
// a sample by id, name, file name or path, and who uses it.

import type { Project, SampleRef } from '@shared/schema/project';
import { rackSampleIds } from '@shared/commands/racks';
import { fail } from './types';
import { norm, safeName } from './util';

const fileOf = (path: string): string => path.split(/[\\/:]/).pop() ?? path;

/** A pool sample by id, name, file name ("kick.wav") or path. Ambiguous names fail with the candidates. */
export function findSample(p: Project, ref: string): SampleRef {
  const r = ref.trim();
  if (p.samples[r]) return p.samples[r];
  const all = Object.values(p.samples);
  const byPath = all.filter((s) => s.path === r || norm(s.path) === norm(r));
  if (byPath.length === 1) return byPath[0];
  const byName = all.filter((s) => norm(s.name) === norm(r) || norm(fileOf(s.path)) === norm(r) || norm(fileOf(s.path).replace(/\.[a-z0-9]+$/i, '')) === norm(r));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) fail(`Several samples match "${safeName(r)}": ${byName.map((s) => `${s.id} (${safeName(s.path, 80)})`).join(', ')}. Pass the id.`);
  fail(`No sample "${safeName(r)}" in the project's sample pool.`);
}

/** Names of what plays a sample: channels (also inside instrument racks), or "an effect rack". */
export function sampleUsers(p: Project, id: string): string[] {
  const out: string[] = [];
  for (const ch of Object.values(p.channels)) {
    if (ch.generator.sampleId === id || Object.values(ch.generator.rack?.chains ?? {}).some((c) => c.instrument?.sampleId === id)) out.push(`"${safeName(ch.name)}"`);
  }
  if (!out.length && rackSampleIds(p).has(id)) out.push('an effect rack');
  return out;
}
