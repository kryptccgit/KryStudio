import { packById } from '@shared/packs/catalog';
import { parsePackPath } from '@shared/packs/types';
import type { Preset } from '@shared/sounds/types';
import type { PacksAccess } from './service';

export function presetPackId(p: Preset): string | null {
  if (p.kind !== 'instrument') return null;
  if (p.requires) return p.requires;
  return (p.sample ? parsePackPath(p.sample)?.packId : null) ?? null;
}

export function packDisplayName(packs: Pick<PacksAccess, 'packName'> | undefined, id: string): string {
  return packs?.packName(id) ?? packById(id)?.name ?? id;
}

export function missingPack(packs: Pick<PacksAccess, 'isInstalled' | 'packName'> | undefined, p: Preset): { id: string; name: string } | null {
  const id = presetPackId(p);
  if (!id) return null;
  if (packs?.isInstalled(id)) return null;
  return { id, name: packDisplayName(packs, id) };
}

export function packPhrase(name: string): string {
  return /\bpack$/i.test(name.trim()) ? `the ${name.trim()}` : `the ${name.trim()} pack`;
}

export function needsPackText(name: string): string {
  return `needs ${packPhrase(name)} (download it in Home ▸ Sounds)`;
}
