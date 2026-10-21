// Sound packs: optional, user-downloaded multisampled instruments built from
// CC0 / public-domain libraries (research/11-sound-sources.md, research/
// 12-real-instruments.md). Nothing ships in the installer: the catalog
// (shared/packs/catalog.ts) lists every file with its URL, size and SHA-256;
// the user clicks Download, main verifies each file and writes our own SFZ
// mappings next to them in userData/packs/<id>/. Agents never download.
//
// Paths: a sample path 'pack:<packId>/<path inside the pack>' (e.g.
// 'pack:grand-piano/krypt/grand.sfz') resolves to userData/packs/<packId>/<path>
// in main (resolveSamplePath) and in the engine (--packs-dir). Projects store
// these portable paths; a project using a pack that isn't installed opens and
// says which pack to download.

import type { SampleKind } from '../sounds/types';
import type { GenreId } from '../sounds/genres';

/** One downloaded file of a pack. */
export interface PackFile {
  /** Path inside the pack dir, forward slashes, no '..' (e.g. 'samples/C4v8.flac'). For an archive: where it is downloaded to (deleted after extraction). */
  path: string;
  url: string;
  /** Fallback URLs with the same bytes (tried in order). */
  mirrors?: string[];
  /** Lower-case hex SHA-256 of the file's bytes. */
  sha256: string;
  bytes: number;
  /**
   * Wave 7b: the file is a ZIP the source only publishes as an archive (Kenney, OpenGameArt). After its own
   * SHA-256 checks out, only `members` are extracted (each checked by its own SHA-256 + size), then the archive is
   * deleted. Anything else in the ZIP is never written.
   */
  archive?: PackArchive;
}

export interface PackArchive {
  format: 'zip';
  members: PackArchiveMember[];
}

export interface PackArchiveMember {
  /** Entry name inside the ZIP, exactly as stored (forward slashes). */
  from: string;
  /** Path inside the pack dir it is written to (same rules as PackFile.path). */
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * Wave 7b: a one-shot / loop / FX sample a pack adds to the sound library. Installed pack samples show up next to
 * the factory samples everywhere: the Browser, find_samples, load_sample, get_playbook's picker and add_transition.
 * Same meaning as FactorySample (shared/sounds/types.ts); the path is 'pack:<packId>/<path in the pack>'.
 */
export interface PackSample {
  /** 'pack:<packId>/<path>', the path of a file (or archive member) of this pack. */
  path: string;
  /** Display name in our own words ("Rain On Window", "Cassette Click 2"), never a product name. */
  name: string;
  kind: SampleKind;
  tags: string[];
  genres: GenreId[];
  rootNote?: number;
  lengthSec: number;
  channels: 1 | 2;
  /** Tempo-synced loops/FX only: written at bpm and exactly `bars` long (see FactorySample). */
  bpm?: number;
  bars?: number;
  /** Measured peak (dBFS) of the file as shipped. */
  peakDb: number;
  /** Per-sound credit when it differs from the pack's (e.g. a hand-picked CC BY sound). */
  credit?: string;
}

/** An SFZ mapping WE wrote (only the opcodes krypt.multisampler supports), written into the pack dir at install. */
export interface PackSfz {
  /** Path inside the pack dir, e.g. 'krypt/grand-piano.sfz'. Sample paths inside are relative to this file. */
  path: string;
  text: string;
}

export interface PackLicence {
  /** SPDX id, or LicenseRef-PublicDomain for informal public-domain statements. */
  spdx: 'CC0-1.0' | 'LicenseRef-PublicDomain' | 'CC-BY-4.0';
  /** Human name shown before download ("CC0 1.0 Universal", "Public domain (author's statement, 2022)"). */
  name: string;
  /** Where the licence / statement lives. */
  url: string;
  /** Credit line we show and put in THIRD-PARTY-NOTICES even when not required. */
  attribution: string;
  /** For informal statements: the archived statement text, written to LICENSE.txt in the pack dir. */
  statement?: string;
}

export interface PackDef {
  /** Stable id, a-z0-9-. */
  id: string;
  name: string;
  /** Bump when files or mappings change (installed packs with an older version offer an update). */
  version: number;
  /** One or two sentences for the download card. */
  description: string;
  /** Who recorded it (credit). */
  author: string;
  homepage: string;
  licence: PackLicence;
  files: PackFile[];
  sfz: PackSfz[];
  /** Wave 7b: one-shots, loops and FX this pack adds to the sound library (sample packs; empty/absent for instrument-only packs). */
  samples?: PackSample[];
  /** Sum of files[].bytes. */
  bytes: number;
  /** Approximate RAM of the largest instrument when loaded, MB. */
  ramMb: number;
  /** What it adds, for the card ("Grand piano (4 velocity layers)", "Upright bass"). */
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
  /** While downloading. */
  progress?: { bytes: number; total: number };
  /** Why the last install failed, as a sentence. */
  error?: string;
}

export interface PacksState {
  packs: PackEntryState[];
  /** userData/packs */
  dir: string;
}

export const PACK_SCHEME = 'pack:';

/** 'pack:grand-piano/krypt/grand.sfz' → { packId: 'grand-piano', path: 'krypt/grand.sfz' }, or null. */
export function parsePackPath(p: string): { packId: string; path: string } | null {
  if (!p.startsWith(PACK_SCHEME)) return null;
  const rest = p.slice(PACK_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const packId = rest.slice(0, slash);
  const inner = rest.slice(slash + 1);
  // Same rules as the engine (samples.rs): no backslash or drive colon anywhere, no empty / . / .. segments.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(packId) || !inner || /[\\:]/.test(inner) || inner.split('/').some((s) => s === '..' || s === '' || s === '.')) return null;
  return { packId, path: inner };
}

/**
 * The SFZ opcodes krypt.multisampler understands (research/12 §3). Authored mappings use only these; the engine
 * ignores any other opcode and counts it in a load warning.
 */
export const SFZ_OPCODES = [
  // headers: <control> <global> <master> <group> <region>; #define $X value; no #include
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
