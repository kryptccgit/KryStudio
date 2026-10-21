// ──────────────────────────────────────────────────────────────────────
// Sound-pack logic for the renderer, with no React and no window access
// (unit-tested in test/packs-ui.test.ts): which preset needs which pack,
// whether it is installed, and the words, sizes, progress and buttons of a
// pack card in Home ▸ Sounds.
// ──────────────────────────────────────────────────────────────────────

import { PACK_NAMES } from '@shared/packs/names';
import { parsePackPath, type PackEntryState, type PacksState } from '@shared/packs/types';
import type { Preset } from '@shared/sounds/types';
import { sampleKindLabel } from './logic';

export type PackTone = 'neutral' | 'live' | 'accent' | 'warn' | 'danger';
export type PackAction = 'download' | 'cancel' | 'update' | 'retry' | 'remove' | 'reveal';

/** The pack a preset needs (its `requires`, or the pack of a 'pack:<id>/…' sample), or null. */
export function presetPackId(p: Pick<Preset, 'kind'> & { requires?: string; sample?: string } | null | undefined): string | null {
  if (!p || p.kind !== 'instrument') return null;
  if (p.requires) return p.requires;
  return (p.sample ? parsePackPath(p.sample)?.packId : null) ?? null;
}

/** Installed (an older version with an update offered still plays). */
export function packInstalled(state: PacksState | null | undefined, id: string): boolean {
  const e = state?.packs.find((x) => x.id === id);
  return e?.status === 'installed' || e?.status === 'update';
}

/** A pack's name: from main's state, else the bundled catalog, else the id. */
export function packName(state: PacksState | null | undefined, id: string): string {
  return state?.packs.find((x) => x.id === id)?.name ?? PACK_NAMES[id] ?? id;
}

/** The pack a preset needs that isn't installed ({id, name}), or null. Unknown state counts as not installed. */
export function missingPackFor(p: Parameters<typeof presetPackId>[0], state: PacksState | null | undefined): { id: string; name: string } | null {
  const id = presetPackId(p);
  if (!id || packInstalled(state, id)) return null;
  return { id, name: packName(state, id) };
}

/** "the Grand Piano pack" (a name ending in "pack" isn't doubled). */
export function packPhrase(name: string): string {
  const n = name.trim();
  return /\bpack$/i.test(n) ? `the ${n}` : `the ${n} pack`;
}

/** Toast / tooltip for a preset whose pack is missing. */
export function needsPackMessage(presetName: string, pack: { name: string }): string {
  return `${presetName} needs ${packPhrase(pack.name)}. Download it in Home ▸ Sounds.`;
}

/** '312 MB' / '1.2 GB'. */
export function packMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  return `${Math.max(0.1, mb).toFixed(1)} MB`;
}

/** Size line of a card: "312 MB download · ~240 MB RAM per instrument". */
export function packSizeText(e: Pick<PackEntryState, 'bytes' | 'ramMb'>): string {
  return `${packMb(e.bytes)} download · ~${Math.round(e.ramMb)} MB RAM per instrument`;
}

/** The status pill of a card. */
export function packPill(e: Pick<PackEntryState, 'status' | 'progress'>): { text: string; tone: PackTone } {
  switch (e.status) {
    case 'installed':
      return { text: 'Installed', tone: 'live' };
    case 'update':
      return { text: 'Update available', tone: 'accent' };
    case 'downloading': {
      const p = packProgress(e);
      return { text: p && p.fraction >= 0 ? `Downloading ${Math.round(p.fraction * 100)}%` : 'Downloading…', tone: 'accent' };
    }
    case 'failed':
      return { text: 'Download failed', tone: 'danger' };
    default:
      return { text: 'Not downloaded', tone: 'neutral' };
  }
}

/** Progress of a downloading pack: fraction 0..1 (-1 when the size isn't known) + "120 MB of 312 MB". */
export function packProgress(e: Pick<PackEntryState, 'status' | 'progress'>): { fraction: number; text: string } | null {
  if (e.status !== 'downloading') return null;
  const bytes = e.progress?.bytes ?? 0;
  const total = e.progress?.total ?? 0;
  if (!(total > 0)) return { fraction: -1, text: bytes > 0 ? `${packMb(bytes)} so far` : 'Starting…' };
  const fraction = Math.max(0, Math.min(1, bytes / total));
  return { fraction, text: `${packMb(bytes)} of ${packMb(total)}` };
}

/** The buttons a card shows, in order (the first is the primary one). */
export function packActions(e: Pick<PackEntryState, 'status'>): PackAction[] {
  switch (e.status) {
    case 'downloading':
      return ['cancel'];
    case 'installed':
      return ['reveal', 'remove'];
    case 'update':
      return ['update', 'reveal', 'remove'];
    case 'failed':
      return ['retry'];
    default:
      return ['download'];
  }
}

/** Header pill: "2 of 4 installed" / "No packs installed" (null while unknown or when none are offered). */
export function packsSummary(state: PacksState | null | undefined): { text: string; tone: PackTone } | null {
  if (!state || !state.packs.length) return null;
  const installed = state.packs.filter((p) => p.status === 'installed' || p.status === 'update').length;
  const downloading = state.packs.filter((p) => p.status === 'downloading').length;
  if (downloading) return { text: `Downloading ${downloading} pack${downloading === 1 ? '' : 's'}`, tone: 'accent' };
  if (!installed) return { text: 'None installed', tone: 'neutral' };
  return { text: `${installed} of ${state.packs.length} installed`, tone: installed === state.packs.length ? 'live' : 'neutral' };
}

/** A settled install whose message says it was cancelled (the Cancel click already said so). */
export function isCancelled(message: string | undefined): boolean {
  return /\bcancel/i.test(message ?? '');
}

/**
 * A sample pack's card line: "Adds 140 sounds: foley, ambience, impacts…" (the biggest kinds first, lower-case
 * labels), or null for a pack that adds no samples.
 */
export function packSoundsText(info: { count: number; byKind: Partial<Record<string, number>> } | null | undefined, max = 3): string | null {
  if (!info || !(info.count > 0)) return null;
  const kinds = Object.entries(info.byKind)
    .filter((e): e is [string, number] => (e[1] ?? 0) > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => sampleKindLabel(k).toLowerCase());
  const shown = kinds.slice(0, max).join(', ');
  return `Adds ${info.count} sound${info.count === 1 ? '' : 's'}${shown ? `: ${shown}${kinds.length > max ? '…' : ''}` : ''}`;
}
