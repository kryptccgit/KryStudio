import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import type { ActionResult, PackSamplesInfo } from '@shared/types';
import type { PacksState } from '@shared/packs/types';
import type { Preset, PresetSummary } from '@shared/sounds/types';
import { factoryPreset } from '@shared/sounds/factory';
import { modal, report, toast } from '../app/notify';
import { showHome } from '../home/store';
import { isCancelled, missingPackFor, needsPackMessage, packMb, packName } from './packsLogic';
import { useSounds } from './store';

interface PacksStore {
  state: PacksState | null;
  error: string | null;
  busy: Record<string, 'install' | 'remove'>;
  highlight: { id: string; nonce: number } | null;
  samples: PackSamplesInfo | null;
  samplesError: string | null;
}

export const usePacks = create<PacksStore>(() => ({ state: null, error: null, busy: {}, highlight: null, samples: null, samplesError: null }));

let installedSig: string | null = null;

function apply(s: PacksState | null | undefined): void {
  if (!s || !Array.isArray(s.packs)) return;
  usePacks.setState({ state: s, error: null });
  const sig = s.packs
    .filter((p) => p.status === 'installed' || p.status === 'update')
    .map((p) => `${p.id}:${p.status}`)
    .join('|');
  if (sig !== installedSig) {
    installedSig = sig;
    void refreshPackSamples();
  }
}

export async function refreshPackSamples(): Promise<string | null> {
  try {
    const r = await window.krypt.packs.samples();
    usePacks.setState({ samples: r && Array.isArray(r.packs) && Array.isArray(r.samples) ? r : { packs: [], samples: [] }, samplesError: null });
    return null;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    usePacks.setState((s) => ({ samples: s.samples ?? { packs: [], samples: [] }, samplesError: message }));
    return message;
  }
}

function setBusy(id: string, what: 'install' | 'remove' | null): void {
  usePacks.setState((st) => {
    const busy = { ...st.busy };
    if (what) busy[id] = what;
    else delete busy[id];
    return { busy };
  });
}

export async function refreshPacks(): Promise<void> {
  try {
    apply(await window.krypt.packs.state());
  } catch (err) {
    usePacks.setState({ error: (err as Error)?.message ?? String(err) });
  }
}

let started = false;

export function ensurePacks(): void {
  if (started) return;
  started = true;
  try {
    window.krypt.packs.onState(apply);
  } catch (err) {
    usePacks.setState({ error: (err as Error)?.message ?? String(err) });
  }
  void refreshPacks();
}

export function useEnsurePacks(): void {
  useEffect(() => ensurePacks(), []);
}

export function useMissingPack(): (p: Pick<PresetSummary, 'id' | 'kind'>) => { id: string; name: string } | null {
  useEnsurePacks();
  const state = usePacks((s) => s.state);
  const cache = useSounds((s) => s.cache);
  return useCallback((p) => (p.kind === 'instrument' ? missingPackFor(p.id.startsWith('factory:') ? factoryPreset(p.id) : cache[p.id], state) : null), [state, cache]);
}

async function call<T>(label: string, fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, message: `${label} failed: ${(err as Error)?.message ?? String(err)}` };
  }
}

export async function installPack(id: string): Promise<boolean> {
  const st = usePacks.getState().state;
  const e = st?.packs.find((p) => p.id === id);
  const name = packName(st, id);
  setBusy(id, 'install');
  toast.info(`${e?.status === 'update' ? 'Updating' : 'Downloading'} ${name}${e ? ` (${packMb(e.bytes)})` : ''}. Progress shows on its card in Home ▸ Sounds.`);
  const r = await call('Download', () => window.krypt.packs.install(id));
  setBusy(id, null);
  if (r.data) apply(r.data);
  if (!r.ok && isCancelled(r.message)) return false;
  return report(r, r.message || `Installed ${name}`);
}

export async function cancelPackDownload(id: string): Promise<void> {
  const name = packName(usePacks.getState().state, id);
  const r = await call('Cancel', () => window.krypt.packs.cancel(id));
  if (report(r)) toast.info(`${name} download cancelled. Files that finished are kept, so Download continues where it stopped.`);
}

export async function removePack(id: string): Promise<boolean> {
  const st = usePacks.getState().state;
  const e = st?.packs.find((p) => p.id === id);
  const name = packName(st, id);
  const ok = await modal.confirm({
    title: `Remove ${name}?`,
    message: `Deletes its files${e ? ` (${packMb(e.bytes)})` : ''} from this PC. Channels that use it go silent until you download it again; your projects keep their notes and settings.`,
    confirmLabel: 'Remove pack',
    destructive: true,
  });
  if (!ok) return false;
  setBusy(id, 'remove');
  const r = await call('Remove', () => window.krypt.packs.remove(id));
  setBusy(id, null);
  if (r.data) apply(r.data);
  return report(r, r.message || `Removed ${name}`);
}

export async function revealPack(id: string): Promise<void> {
  report(await call('Open folder', () => window.krypt.packs.reveal(id)));
}

export async function openPackLink(url: string): Promise<void> {
  report(await call('Open link', () => window.krypt.app.openExternal(url)));
}

export function showPackInHome(id: string): void {
  showHome('sounds');
  usePacks.setState({ highlight: { id, nonce: Date.now() } });
}

export async function packGate(preset: Pick<Preset, 'kind' | 'name'> & { requires?: string; sample?: string }): Promise<boolean> {
  if (!missingPackFor(preset, { packs: [], dir: '' })) return true;
  ensurePacks();
  if (!usePacks.getState().state) await refreshPacks();
  const miss = missingPackFor(preset, usePacks.getState().state);
  if (!miss) return true;
  toast.warn(needsPackMessage(preset.name, miss), { action: { label: 'Get the pack', run: () => showPackInHome(miss.id) } });
  return false;
}
