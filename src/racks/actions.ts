import { Boxes, Drum, Layers, Scissors } from 'lucide-react';
import type { AudioTarget, SliceToPadsOptions } from '@shared/types';
import { pluginById } from '@shared/plugins/catalog';
import { isRackPlugin } from '@shared/schema/rack';
import { dispatch, getProject } from '../doc/store';
import type { MenuItem } from '../components/Menu';
import { flashHint } from '../app/hints';
import { toast } from '../app/notify';
import { wm } from '../workspace/WindowManager';

export type RackTarget = { channelId: string } | { insertId: string; slotId: string };

export function rackArgs(t: RackTarget): Record<string, string> {
  return 'channelId' in t ? { channelId: t.channelId } : { insertId: t.insertId, slotId: t.slotId };
}

export async function wrapChannelInRack(channelId: string, kind: 'instrument' | 'drum' = 'instrument'): Promise<boolean> {
  const ch = getProject().channels[channelId];
  if (!ch) return false;
  const r = await dispatch<{ clearedAutomation?: number }>('rack.create', { channelId, kind });
  if (!r.ok) return false;
  const lost = r.data?.clearedAutomation ? ` (${r.data.clearedAutomation} automation clip${r.data.clearedAutomation === 1 ? '' : 's'} on its old knobs lost their target: map a macro instead)` : '';
  flashHint(`${ch.name} is now a ${kind === 'drum' ? 'drum rack' : 'rack'}: its sound is chain 1${lost}`, 'ok', 4000);
  wm.openPlugin({ kind: 'channel', channelId });
  return true;
}

export async function newEmptyRack(channelId: string, kind: 'instrument' | 'drum'): Promise<boolean> {
  const r = await dispatch('rack.create', { channelId, kind, wrap: false });
  if (r.ok) {
    flashHint(kind === 'drum' ? 'Empty drum rack: drop samples on its pads' : 'Empty rack: add a chain', 'ok');
    wm.openPlugin({ kind: 'channel', channelId });
  }
  return r.ok;
}

export async function wrapSlotInRack(insertId: string, slotId: string): Promise<boolean> {
  const slot = getProject().mixer.inserts[insertId]?.slots[slotId];
  if (!slot) return false;
  const r = await dispatch<{ droppedSidechain?: boolean }>('rack.create', { insertId, slotId });
  if (!r.ok) return false;
  flashHint(`${pluginById(slot.type)?.name ?? 'The effect'} is now chain 1 of an effect rack${r.data?.droppedSidechain ? ' (its sidechain input was removed: devices in racks have none yet)' : ''}`, 'ok', 4000);
  wm.openPlugin({ kind: 'slot', insertId, slotId });
  return true;
}

export async function addEffectRack(insertId: string): Promise<boolean> {
  const r = await dispatch<{ slotId: string }>('rack.create', { insertId, kind: 'effect' });
  if (r.ok && r.data) {
    flashHint('Added an empty effect rack: add parallel chains in its window', 'ok');
    wm.openPlugin({ kind: 'slot', insertId, slotId: r.data.slotId });
  }
  return r.ok;
}

let slicing = false;

export async function sliceToPads(source: AudioTarget, opts: SliceToPadsOptions = {}): Promise<boolean> {
  if (slicing) {
    toast.info('Already slicing: wait for it to finish');
    return false;
  }
  slicing = true;
  const off = window.krypt.racks.onSliceProgress((p) => {
    if (p.fraction < 1) flashHint(p.stage === 'analysing' ? 'Slice to pads: finding the hits…' : 'Slice to pads: building the drum rack…', 'info', 8000);
  });
  flashHint('Slice to pads: reading the audio…', 'info', 8000);
  try {
    const r = await window.krypt.racks.sliceToPads(source, opts);
    if (!r.ok || !r.data) {
      toast.error(r.message ?? 'Slicing failed');
      return false;
    }
    toast.success(r.message ?? 'Sliced');
    wm.openPlugin({ kind: 'channel', channelId: r.data.channelId });
    return true;
  } catch (e) {
    toast.error(`Slicing failed: ${(e as Error)?.message ?? String(e)}`);
    return false;
  } finally {
    off();
    slicing = false;
  }
}

export function sliceMenuItem(source: AudioTarget, extra: SliceToPadsOptions = {}): MenuItem {
  const go = (o: SliceToPadsOptions) => () => void sliceToPads(source, { ...extra, ...o });
  return {
    type: 'submenu',
    label: 'Slice to pads',
    icon: Scissors,
    items: [
      { type: 'header', label: 'A drum rack + a pattern replaying it' },
      { label: 'At the hits (up to 16 pads)', hint: 'The analyzer finds the transients; the strongest 16 become pads', onSelect: go({ mode: 'onsets', maxSlices: 16 }) },
      { label: 'At the hits (up to 8 pads)', onSelect: go({ mode: 'onsets', maxSlices: 8 }) },
      { type: 'separator' },
      { label: 'Every beat', onSelect: go({ mode: 'grid', division: 1, maxSlices: 64 }) },
      { label: 'Every 8th note', onSelect: go({ mode: 'grid', division: 0.5, maxSlices: 64 }) },
      { label: 'Every 16th note', onSelect: go({ mode: 'grid', division: 0.25, maxSlices: 64 }) },
      { type: 'separator' },
      { label: 'At the hits, each cuts the last', hint: 'Choke group 1 on every pad: a new slice stops the one playing', onSelect: go({ mode: 'onsets', maxSlices: 16, choke: 1 }) },
    ],
  };
}

export function channelRackItems(channelId: string): MenuItem[] {
  const p = getProject();
  const ch = p.channels[channelId];
  if (!ch) return [];
  const items: MenuItem[] = [];
  const type = ch.generator.type;
  const hasSample = !!(ch.generator.sampleId && p.samples[ch.generator.sampleId]);
  if (!isRackPlugin(type)) {
    const external = type.startsWith('vst3:') || type.startsWith('clap:');
    items.push({
      type: 'submenu',
      label: 'Wrap in rack',
      icon: Layers,
      disabled: external,
      items: [
        { type: 'header', label: 'Its sound becomes chain 1' },
        { label: 'Instrument rack', icon: Boxes, hint: 'Layer and split sounds by key and velocity, with 8 macros', disabled: type === 'krypt.audioclip', onSelect: () => void wrapChannelInRack(channelId, 'instrument') },
        { label: 'Drum rack', icon: Drum, hint: 'One sound per pad, with choke groups and 8 macros', disabled: type === 'krypt.audioclip', onSelect: () => void wrapChannelInRack(channelId, 'drum') },
        { type: 'separator' },
        { label: 'Replace with an empty rack', onSelect: () => void newEmptyRack(channelId, 'instrument') },
        { label: 'Replace with an empty drum rack', onSelect: () => void newEmptyRack(channelId, 'drum') },
      ],
    });
  }
  if (hasSample && (type === 'krypt.audioclip' || type === 'krypt.sampler')) items.push(sliceMenuItem({ channelId }));
  return items;
}

export function slotRackItems(insertId: string, slotId: string): MenuItem[] {
  const slot = getProject().mixer.inserts[insertId]?.slots[slotId];
  if (!slot || isRackPlugin(slot.type)) return [];
  const external = slot.type.startsWith('vst3:') || slot.type.startsWith('clap:');
  return [{ label: 'Wrap in effect rack', icon: Layers, disabled: external, hint: external ? "Third-party plugins can't go in racks yet" : 'Parallel chains with 8 macros; this effect becomes chain 1', onSelect: () => void wrapSlotInRack(insertId, slotId) }];
}
