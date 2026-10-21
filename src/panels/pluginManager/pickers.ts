import { AppWindow, Blocks } from 'lucide-react';
import type { PluginDescriptor } from '@shared/plugins/types';
import type { PluginTarget } from '@shared/types';
import type { MenuItem } from '../../components/Menu';
import { wm } from '../../workspace/WindowManager';
import { externalPlugins, installedDetail, isExternalPluginId, openPluginEditor } from './store';
import { pluginById } from '@shared/plugins/catalog';

const FLAT_MAX = 20;

export function installedPickerItems(kind: 'instrument' | 'effect', onPick: (d: PluginDescriptor) => void, opts: { current?: string; disabled?: boolean; exclude?: string } = {}): MenuItem[] {
  const list = externalPlugins(kind).filter((d) => d.id !== opts.exclude);
  const what = kind === 'instrument' ? 'instruments' : 'effects';
  const items: MenuItem[] = [{ type: 'header', label: 'Installed · VST3 / CLAP' }];
  if (!list.length) {
    items.push({ label: `No VST3 / CLAP ${what} found`, detail: 'Open the Plugin Manager to scan or add folders', icon: Blocks, onSelect: () => wm.open('pluginManager') });
    return items;
  }
  const item = (d: PluginDescriptor): MenuItem => ({ label: d.name, detail: installedDetail(d), checked: d.id === opts.current, disabled: opts.disabled, onSelect: () => onPick(d) });
  if (list.length <= FLAT_MAX) {
    for (const d of list) items.push(item(d));
  } else {
    const byVendor = new Map<string, PluginDescriptor[]>();
    for (const d of list) {
      const v = d.vendor || 'Other';
      byVendor.set(v, [...(byVendor.get(v) ?? []), d]);
    }
    for (const [vendor, ds] of [...byVendor.entries()].sort((a, b) => a[0].localeCompare(b[0]))) items.push({ type: 'submenu', label: vendor, items: ds.map(item) });
  }
  items.push({ label: 'Plugin Manager…', icon: Blocks, onSelect: () => wm.open('pluginManager') });
  return items;
}

export function nativeEditorItems(type: string, target: PluginTarget): MenuItem[] {
  if (!isExternalPluginId(type)) return [];
  const d = pluginById(type);
  if (!d?.hasEditor) return [];
  return [{ label: 'Open plugin window', icon: AppWindow, hint: `${d.name}'s own editor window`, onSelect: () => void openPluginEditor(target) }];
}
