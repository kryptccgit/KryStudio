import { createElement } from 'react';
import { ArrowLeft, ArrowRight, Layers, Palette, Pencil, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { EFFECTS, pluginById } from '@shared/plugins/catalog';
import { MAX_FX_SLOTS, PALETTE } from '@shared/schema/project';
import { dispatch, getProject, withGroup } from '../../doc/store';
import { closeMenu, ColorSwatches, type MenuItem } from '../../components/Menu';
import { flashHint } from '../../app/hints';
import { modal } from '../../app/notify';
import { getUi } from '../../state/ui';
import { wm } from '../../workspace/WindowManager';
import { installedPickerItems } from '../pluginManager/pickers';
import { openChainPicker } from '../../sounds/pickers';
import { openSaveChainDialog } from '../../sounds/SavePresetDialog';

export function insertNumber(insertId: string): string {
  const p = getProject();
  if (insertId === p.mixer.masterId) return 'M';
  return String(p.mixer.insertOrder.indexOf(insertId));
}

export async function addInsert(index?: number): Promise<void> {
  const r = await dispatch<{ id: string }>('mixer.addInsert', index !== undefined ? { index } : {});
  if (r.ok && r.data) {
    getUi().selectInsert(r.data.id);
    flashHint(`Added ${getProject().mixer.inserts[r.data.id]?.name ?? 'insert'}`, 'ok');
  }
}

export async function renameInsert(id: string): Promise<void> {
  const ins = getProject().mixer.inserts[id];
  if (!ins) return;
  const name = await modal.prompt({
    title: 'Rename insert',
    initialValue: ins.name,
    validate: (v) => (!v.trim() ? 'Name cannot be empty' : v.length > 64 ? 'At most 64 characters' : null),
  });
  if (name && name !== ins.name) await dispatch('mixer.setInsert', { id, name });
}

export async function removeInsert(id: string): Promise<void> {
  const p = getProject();
  const ins = p.mixer.inserts[id];
  if (!ins || ins.isMaster) return;
  const feeding = Object.values(p.channels).filter((c) => c.insertId === id).length;
  const ok = await modal.confirm({
    title: `Delete ${ins.name}?`,
    message: `${ins.slotOrder.length ? `Its ${ins.slotOrder.length} effect${ins.slotOrder.length === 1 ? '' : 's'} go with it. ` : ''}${
      feeding ? `${feeding} channel${feeding === 1 ? '' : 's'} will route to the master instead. ` : ''
    }You can undo this.`,
    confirmLabel: 'Delete insert',
    destructive: true,
  });
  if (!ok) return;
  const r = await dispatch('mixer.removeInsert', { id });
  if (r.ok) flashHint(`Deleted ${ins.name}`, 'ok');
}

export function effectPickerItems(insertId: string, index?: number): MenuItem[] {
  const ins = getProject().mixer.inserts[insertId];
  const full = !!ins && ins.slotOrder.length >= MAX_FX_SLOTS;
  const groups = new Map<string, typeof EFFECTS>();
  for (const d of EFFECTS) {
    const list = groups.get(d.category) ?? [];
    list.push(d);
    groups.set(d.category, list);
  }
  const items: MenuItem[] = [];
  if (full) items.push({ type: 'header', label: `This insert is full (${MAX_FX_SLOTS} effects)` });
  for (const [cat, list] of groups) {
    items.push({ type: 'header', label: `Stock · ${cat}` });
    for (const d of list)
      items.push({
        label: d.name,
        detail: d.description,
        disabled: full,
        onSelect: () => void addEffect(insertId, d.id, index),
      });
  }
  items.push(...installedPickerItems('effect', (d) => void addEffect(insertId, d.id, index), { disabled: full }));
  return items;
}

export async function addEffect(insertId: string, type: string, index?: number): Promise<void> {
  const r = await dispatch<{ id: string }>('mixer.addSlot', { insertId, type, index });
  if (r.ok && r.data) {
    const ins = getProject().mixer.inserts[insertId];
    flashHint(`${pluginById(type)?.name ?? type} added to ${ins?.name ?? 'insert'}`, 'ok');
    wm.openPlugin({ kind: 'slot', insertId, slotId: r.data.id });
  }
}

export async function removeEffect(insertId: string, slotId: string): Promise<void> {
  const slot = getProject().mixer.inserts[insertId]?.slots[slotId];
  const r = await dispatch('mixer.removeSlot', { insertId, slotId });
  if (r.ok) flashHint(`Removed ${pluginById(slot?.type ?? '')?.name ?? 'effect'}`, 'ok');
}

export async function replaceEffect(insertId: string, slotId: string, type: string): Promise<void> {
  const ins = getProject().mixer.inserts[insertId];
  if (!ins) return;
  const index = ins.slotOrder.indexOf(slotId);
  const newId = await withGroup('Replace effect', async (groupId) => {
    const rm = await dispatch('mixer.removeSlot', { insertId, slotId }, { groupId });
    if (!rm.ok) return null;
    const add = await dispatch<{ id: string }>('mixer.addSlot', { insertId, type, index }, { groupId });
    return add.ok && add.data ? add.data.id : null;
  });
  if (newId) {
    wm.closePluginsWhere((t) => t.kind === 'slot' && t.slotId === slotId);
    flashHint(`Replaced with ${pluginById(type)?.name ?? type}`, 'ok');
  }
}

export function insertMenuItems(id: string, doc?: Document | null): MenuItem[] {
  const p = getProject();
  const ins = p.mixer.inserts[id];
  if (!ins) return [];
  const i = p.mixer.insertOrder.indexOf(id);
  return [
    { type: 'header', label: ins.isMaster ? 'Master' : `Insert ${i} · ${ins.name}` },
    { label: 'Rename…', icon: Pencil, shortcut: 'Dbl-click', onSelect: () => void renameInsert(id) },
    {
      type: 'submenu',
      label: 'Color',
      icon: Palette,
      swatch: ins.color,
      items: [
        {
          type: 'custom',
          render: () =>
            createElement(ColorSwatches, {
              colors: PALETTE,
              current: ins.color,
              onPick: (color: string) => {
                closeMenu();
                void dispatch('mixer.setInsert', { id, color });
              },
            }),
        },
      ],
    },
    { label: 'Reset fader & pan', icon: RotateCcw, onSelect: () => void dispatch('mixer.setInsert', { id, volume: 1, pan: 0, stereoSep: 0 }) },
    { type: 'separator' },
    { label: 'Add effect', icon: Plus, type: 'submenu', items: effectPickerItems(id) } as MenuItem,
    { label: 'Load chain…', icon: Layers, hint: 'Load an effect-chain preset onto this insert (replace or append)', onSelect: () => openChainPicker(id, doc) },
    { label: 'Save chain as preset…', icon: Save, hint: 'Keep these effects and their settings as your own chain preset', onSelect: () => openSaveChainDialog(id, doc) },
    ...(!ins.isMaster
      ? ([
          { label: 'Move left', icon: ArrowLeft, disabled: i <= 1, onSelect: () => void dispatch('mixer.moveInsert', { id, toIndex: i - 1 }) },
          {
            label: 'Move right',
            icon: ArrowRight,
            disabled: i >= p.mixer.insertOrder.length - 1,
            onSelect: () => void dispatch('mixer.moveInsert', { id, toIndex: i + 1 }),
          },
          { type: 'separator' },
          { label: 'Insert new track here', icon: Plus, onSelect: () => void addInsert(i) },
          { label: 'Delete insert…', icon: Trash2, danger: true, onSelect: () => void removeInsert(id) },
        ] as MenuItem[])
      : []),
  ];
}
