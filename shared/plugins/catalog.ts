import raw from './catalog.gen.json';
import type { PluginCatalog, PluginDescriptor } from './types';

export const CATALOG = raw as PluginCatalog;

export function pluginById(id: string): PluginDescriptor | undefined {
  return CATALOG.plugins.find((p) => p.id === id);
}

export const INSTRUMENTS = CATALOG.plugins.filter((p) => p.kind === 'instrument');
export const EFFECTS = CATALOG.plugins.filter((p) => p.kind === 'effect');

const STOCK_IDS = new Set(CATALOG.plugins.map((p) => p.id));
const catalogListeners = new Set<() => void>();
let catalogRev = 0;

export function isExternalPluginId(id: string): boolean {
  return id.startsWith('vst3:') || id.startsWith('clap:');
}

export function registerExternalPlugins(descs: PluginDescriptor[]): number {
  let changed = 0;
  for (const d of descs) {
    if (!d || typeof d.id !== 'string' || !isExternalPluginId(d.id) || STOCK_IDS.has(d.id) || !Array.isArray(d.params)) continue;
    const i = CATALOG.plugins.findIndex((p) => p.id === d.id);
    if (i >= 0) {
      if (JSON.stringify(CATALOG.plugins[i]) === JSON.stringify(d)) continue;
      CATALOG.plugins[i] = d;
    } else CATALOG.plugins.push(d);
    changed++;
  }
  if (changed) {
    catalogRev++;
    for (const fn of catalogListeners) {
      try {
        fn();
      } catch {
      }
    }
  }
  return changed;
}

export function externalPlugins(kind?: 'instrument' | 'effect'): PluginDescriptor[] {
  return CATALOG.plugins.filter((p) => isExternalPluginId(p.id) && (!kind || p.kind === kind)).sort((a, b) => a.name.localeCompare(b.name));
}

export function onCatalogChanged(fn: () => void): () => void {
  catalogListeners.add(fn);
  return () => {
    catalogListeners.delete(fn);
  };
}

export function catalogVersion(): number {
  return catalogRev;
}
