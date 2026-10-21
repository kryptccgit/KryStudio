import { PACK_NAMES } from '@shared/packs/names';
import { parsePackPath, type PackEntryState, type PacksState } from '@shared/packs/types';
import type { Preset } from '@shared/sounds/types';
import { sampleKindLabel } from './logic';

export type PackTone = 'neutral' | 'live' | 'accent' | 'warn' | 'danger';
export type PackAction = 'download' | 'cancel' | 'update' | 'retry' | 'remove' | 'reveal';

export function presetPackId(p: Pick<Preset, 'kind'> & { requires?: string; sample?: string } | null | undefined): string | null {
  if (!p || p.kind !== 'instrument') return null;
  if (p.requires) return p.requires;
  return (p.sample ? parsePackPath(p.sample)?.packId : null) ?? null;
}

export function packInstalled(state: PacksState | null | undefined, id: string): boolean {
  const e = state?.packs.find((x) => x.id === id);
  return e?.status === 'installed' || e?.status === 'update';
}

export function packName(state: PacksState | null | undefined, id: string): string {
  return state?.packs.find((x) => x.id === id)?.name ?? PACK_NAMES[id] ?? id;
}

export function missingPackFor(p: Parameters<typeof presetPackId>[0], state: PacksState | null | undefined): { id: string; name: string } | null {
  const id = presetPackId(p);
  if (!id || packInstalled(state, id)) return null;
  return { id, name: packName(state, id) };
}

export function packPhrase(name: string): string {
  const n = name.trim();
  return /\bpack$/i.test(n) ? `the ${n}` : `the ${n} pack`;
}

export function needsPackMessage(presetName: string, pack: { name: string }): string {
  return `${presetName} needs ${packPhrase(pack.name)}. Download it in Home ▸ Sounds.`;
}

export function packMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  return `${Math.max(0.1, mb).toFixed(1)} MB`;
}

export function packSizeText(e: Pick<PackEntryState, 'bytes' | 'ramMb'>): string {
  return `${packMb(e.bytes)} download · ~${Math.round(e.ramMb)} MB RAM per instrument`;
}

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

export function packProgress(e: Pick<PackEntryState, 'status' | 'progress'>): { fraction: number; text: string } | null {
  if (e.status !== 'downloading') return null;
  const bytes = e.progress?.bytes ?? 0;
  const total = e.progress?.total ?? 0;
  if (!(total > 0)) return { fraction: -1, text: bytes > 0 ? `${packMb(bytes)} so far` : 'Starting…' };
  const fraction = Math.max(0, Math.min(1, bytes / total));
  return { fraction, text: `${packMb(bytes)} of ${packMb(total)}` };
}

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

export function packsSummary(state: PacksState | null | undefined): { text: string; tone: PackTone } | null {
  if (!state || !state.packs.length) return null;
  const installed = state.packs.filter((p) => p.status === 'installed' || p.status === 'update').length;
  const downloading = state.packs.filter((p) => p.status === 'downloading').length;
  if (downloading) return { text: `Downloading ${downloading} pack${downloading === 1 ? '' : 's'}`, tone: 'accent' };
  if (!installed) return { text: 'None installed', tone: 'neutral' };
  return { text: `${installed} of ${state.packs.length} installed`, tone: installed === state.packs.length ? 'live' : 'neutral' };
}

export function isCancelled(message: string | undefined): boolean {
  return /\bcancel/i.test(message ?? '');
}

export function packSoundsText(info: { count: number; byKind: Partial<Record<string, number>> } | null | undefined, max = 3): string | null {
  if (!info || !(info.count > 0)) return null;
  const kinds = Object.entries(info.byKind)
    .filter((e): e is [string, number] => (e[1] ?? 0) > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => sampleKindLabel(k).toLowerCase());
  const shown = kinds.slice(0, max).join(', ');
  return `Adds ${info.count} sound${info.count === 1 ? '' : 's'}${shown ? `: ${shown}${kinds.length > max ? '…' : ''}` : ''}`;
}
