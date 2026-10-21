// Which presets need a sound pack, and whether it is installed. Presets for pack instruments carry
// `requires: <packId>` (shared/sounds/types.ts); a preset saved from a pack channel is recognised by its
// 'pack:<id>/…' sample. A preset whose pack isn't installed is kept out of agents' automatic picks
// (instruments.ts presetPlayable), flagged in find_presets, and refused by load_preset with needsPackText().

import { packById } from '@shared/packs/catalog';
import { parsePackPath } from '@shared/packs/types';
import type { Preset } from '@shared/sounds/types';
import type { PacksAccess } from './service';

/** The pack a preset needs, or null. */
export function presetPackId(p: Preset): string | null {
  if (p.kind !== 'instrument') return null;
  if (p.requires) return p.requires;
  return (p.sample ? parsePackPath(p.sample)?.packId : null) ?? null;
}

/** A pack's display name: the service's catalog, else the shared catalog, else the id. */
export function packDisplayName(packs: Pick<PacksAccess, 'packName'> | undefined, id: string): string {
  return packs?.packName(id) ?? packById(id)?.name ?? id;
}

/**
 * The pack a preset needs that isn't installed, or null (no pack needed, or installed). Without a packs service
 * (not wired, tests) nothing counts as installed: a pack instrument can't play without its files.
 */
export function missingPack(packs: Pick<PacksAccess, 'isInstalled' | 'packName'> | undefined, p: Preset): { id: string; name: string } | null {
  const id = presetPackId(p);
  if (!id) return null;
  if (packs?.isInstalled(id)) return null;
  return { id, name: packDisplayName(packs, id) };
}

/** "the Grand Piano pack" (a name that already ends in "pack" isn't doubled). */
export function packPhrase(name: string): string {
  return /\bpack$/i.test(name.trim()) ? `the ${name.trim()}` : `the ${name.trim()} pack`;
}

/** 'needs the Grand Piano pack (download it in Home ▸ Sounds)'. */
export function needsPackText(name: string): string {
  return `needs ${packPhrase(name)} (download it in Home ▸ Sounds)`;
}
