// The playbook registry: one file per genre (shared/playbooks/<id>.ts).
// test/playbooks.test.ts validates every playbook (parts referenced by
// sections exist, KPN parses, targets are sane, every role resolves to a
// factory preset or sample).

import { resolveGenre, type GenreId } from '../sounds/genres';
import type { Playbook } from './types';
import { TRAP } from './trap';
import { DRILL } from './drill';
import { BOOM_BAP } from './boom-bap';
import { LOFI } from './lofi';
import { PHONK } from './phonk';
import { RNB } from './rnb';
import { POP } from './pop';
import { AFROBEATS } from './afrobeats';
import { REGGAETON } from './reggaeton';
import { HOUSE } from './house';
import { DEEP_HOUSE } from './deep-house';
import { TECH_HOUSE } from './tech-house';
import { TECHNO } from './techno';
import { EDM } from './edm';
import { FUTURE_BASS } from './future-bass';
import { DUBSTEP } from './dubstep';
import { DNB } from './dnb';
import { SYNTHWAVE } from './synthwave';

export type { Playbook, PlaybookGroove } from './types';

export const PLAYBOOKS: readonly Playbook[] = [
  TRAP,
  DRILL,
  BOOM_BAP,
  LOFI,
  PHONK,
  RNB,
  POP,
  AFROBEATS,
  REGGAETON,
  HOUSE,
  DEEP_HOUSE,
  TECH_HOUSE,
  TECHNO,
  EDM,
  FUTURE_BASS,
  DUBSTEP,
  DNB,
  SYNTHWAVE,
];

const BY_ID = new Map<GenreId, Playbook>(PLAYBOOKS.map((p) => [p.id, p]));

/** The playbook for a genre id or alias, or null. */
export function playbookFor(genre: string | null | undefined): Playbook | null {
  const id = resolveGenre(genre);
  return id ? (BY_ID.get(id) ?? null) : null;
}

export function listPlaybooks(): readonly Playbook[] {
  return PLAYBOOKS;
}
