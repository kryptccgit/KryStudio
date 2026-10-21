import type { SampleKind } from '../sounds/types';
import type { GenreId } from '../sounds/genres';

export interface PackFile {
  path: string;
  url: string;
  mirrors?: string[];
  sha256: string;
  bytes: number;
  archive?: PackArchive;
}

export interface PackArchive {
  format: 'zip';
  members: PackArchiveMember[];
}

export interface PackArchiveMember {
  from: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface PackSample {
  path: string;
  name: string;
  kind: SampleKind;
  tags: string[];
  genres: GenreId[];
  rootNote?: number;
  lengthSec: number;
  channels: 1 | 2;
  bpm?: number;
  bars?: number;
  peakDb: number;
  credit?: string;
}

export interface PackSfz {
  path: string;
  text: string;
}

export interface PackLicence {
  /** SPDX id, or LicenseRef-PublicDomain for informal public-domain statements. */
  spdx: 'CC0-1.0' | 'LicenseRef-PublicDomain' | 'CC-BY-4.0';
  name: string;
  url: string;
  attribution: string;
  statement?: string;
}

export interface PackDef {
  id: string;
  name: string;
  version: number;
  description: string;
  author: string;
  homepage: string;
  licence: PackLicence;
  files: PackFile[];
  sfz: PackSfz[];
  samples?: PackSample[];
  bytes: number;
  ramMb: number;
  contents: string[];
}

export type PackStatus = 'available' | 'downloading' | 'installed' | 'update' | 'failed';

export interface PackEntryState {
  id: string;
  name: string;
  description: string;
  author: string;
  licence: PackLicence;
  bytes: number;
  ramMb: number;
  contents: string[];
  status: PackStatus;
  progress?: { bytes: number; total: number };
  error?: string;
}

export interface PacksState {
  packs: PackEntryState[];
  dir: string;
}

export const PACK_SCHEME = 'pack:';

export function parsePackPath(p: string): { packId: string; path: string } | null {
  if (!p.startsWith(PACK_SCHEME)) return null;
  const rest = p.slice(PACK_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const packId = rest.slice(0, slash);
  const inner = rest.slice(slash + 1);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(packId) || !inner || /[\\:]/.test(inner) || inner.split('/').some((s) => s === '..' || s === '' || s === '.')) return null;
  return { packId, path: inner };
}

export const SFZ_OPCODES = [
  'default_path',
  'sample',
  'key',
  'lokey',
  'hikey',
  'pitch_keycenter',
  'pitch_keytrack',
  'lovel',
  'hivel',
  'xfin_lovel',
  'xfin_hivel',
  'xfout_lovel',
  'xfout_hivel',
  'amp_veltrack',
  'volume',
  'pan',
  'tune',
  'transpose',
  'offset',
  'end',
  'loop_mode',
  'loop_start',
  'loop_end',
  'ampeg_attack',
  'ampeg_hold',
  'ampeg_decay',
  'ampeg_sustain',
  'ampeg_release',
  'trigger',
  'rt_decay',
  'seq_length',
  'seq_position',
  'lorand',
  'hirand',
  'group',
  'off_by',
  'off_mode',
] as const;
