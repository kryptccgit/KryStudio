// Third-party plugin state in the renderer: the Plugin Manager snapshot from
// main, registration of installed VST3/CLAP descriptors into the shared
// CATALOG (so pickers, the param panel and ParamRefs see them), and the
// actions behind the Plugin Manager / editor buttons (every one gives
// visible feedback).

import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { catalogVersion, externalPlugins, isExternalPluginId, onCatalogChanged, registerExternalPlugins } from '@shared/plugins/catalog';
import type { PluginDescriptor } from '@shared/plugins/types';
import type { ActionResult, PluginManagerState, PluginTarget } from '@shared/types';
import { report, toast } from '../../app/notify';

export { externalPlugins, isExternalPluginId };

interface PluginStore {
  state: PluginManagerState | null;
  /** A long action in flight (label for the UI). */
  busy: string | null;
}

export const usePluginManager = create<PluginStore>(() => ({ state: null, busy: null }));

function apply(s: PluginManagerState | null | undefined): void {
  if (!s || !Array.isArray(s.plugins)) return;
  registerExternalPlugins(s.plugins);
  usePluginManager.setState({ state: s });
}

let installed = false;

/** Boot: fetch the installed plugins and follow every change from main. */
export function installPluginSync(): void {
  if (installed) return;
  installed = true;
  const api = window.krypt?.plugins;
  if (!api) return;
  api
    .state()
    .then(apply)
    .catch((err) => toast.error(`Couldn't load your installed plugins: ${(err as Error)?.message ?? err}`));
  api.onState(apply);
}

/** Re-render when third-party plugins are (re)registered. */
export function useCatalogVersion(): number {
  return useSyncExternalStore(onCatalogChanged, catalogVersion);
}

/** "VST3" / "CLAP" (or null for stock plugins). */
export function formatLabel(d: Pick<PluginDescriptor, 'format' | 'id'> | undefined | null): string | null {
  if (!d) return null;
  if (d.format) return d.format.toUpperCase();
  if (d.id.startsWith('vst3:')) return 'VST3';
  if (d.id.startsWith('clap:')) return 'CLAP';
  return null;
}

/** Picker detail line for an installed plugin: "Vendor · VST3 · Category". */
export function installedDetail(d: PluginDescriptor): string {
  return [d.vendor || null, formatLabel(d), d.category && d.category !== 'Effect' && d.category !== 'Instrument' ? d.category : null].filter(Boolean).join(' · ');
}

async function run(label: string, fn: () => Promise<ActionResult<PluginManagerState>>, success = true): Promise<boolean> {
  usePluginManager.setState({ busy: label });
  try {
    const r = await fn();
    if (r.data) apply(r.data);
    return report(r, success && r.ok ? r.message : undefined);
  } catch (err) {
    toast.error(`${label} failed: ${(err as Error)?.message ?? err}`);
    return false;
  } finally {
    usePluginManager.setState({ busy: null });
  }
}

export const rescanPlugins = (full = false): Promise<boolean> => run(full ? 'Full rescan' : 'Rescan', () => window.krypt.plugins.rescan({ full }));
export const addPluginFolder = (): Promise<boolean> => run('Add folder', () => window.krypt.plugins.addFolder());
export const removePluginFolder = (p: string): Promise<boolean> => run('Remove folder', () => window.krypt.plugins.removeFolder(p));
export const unblockPlugin = (p?: string): Promise<boolean> => run(p ? 'Retry' : 'Reset blocklist', () => window.krypt.plugins.unblock(p));

export async function reloadPlugins(): Promise<boolean> {
  try {
    return report(await window.krypt.plugins.reload(), 'Plugin host restarted; reloading plugins');
  } catch (err) {
    toast.error(`Reload failed: ${(err as Error)?.message ?? err}`);
    return false;
  }
}

/** Open (or close) a third-party plugin's own window, owned by the main window. */
export async function openPluginEditor(target: PluginTarget, open = true): Promise<boolean> {
  try {
    return report(await window.krypt.plugins.openEditor(target, open));
  } catch (err) {
    toast.error(`Couldn't open the plugin window: ${(err as Error)?.message ?? err}`);
    return false;
  }
}
