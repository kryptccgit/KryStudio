// Channel Rack verbs shared by rows, the header, menus and drop targets.
// Multi-step verbs run inside withGroup so each is ONE undo entry.

import {
  Copy,
  Eraser,
  FolderInput,
  Headphones,
  ListFilter,
  MoveHorizontal,
  PaintBucket,
  Palette,
  Pencil,
  Piano,
  Plug,
  Replace,
  Route,
  Ruler,
  SlidersVertical,
  Trash2,
  VolumeX,
} from 'lucide-react';
import { createElement } from 'react';
import { dispatch, getProject, withGroup } from '../../doc/store';
import { INSTRUMENTS, pluginById } from '@shared/plugins/catalog';
import { PALETTE } from '@shared/schema/project';
import { TICKS_PER_STEP, ticksPerBeat } from '@shared/schema/time';
import { AUTO_GROUPS, autoGroup, channelGroup, groupNames, useRackView } from './groups';
import { closeMenu, ColorSwatches, type MenuItem } from '../../components/Menu';
import { flashHint } from '../../app/hints';
import { modal, toast } from '../../app/notify';
import { getUi } from '../../state/ui';
import { wm } from '../../workspace/WindowManager';
import { installedPickerItems, nativeEditorItems } from '../pluginManager/pickers';
import { channelEarsItems } from '../../ears/menus';
import { AUDIO_EXTENSIONS } from '@shared/audio/formats';
import { useSounds } from '../../sounds/store';
import { channelRackItems } from '../../racks/actions';

export const SAMPLE_MIME = 'application/x-krypt-sample';
export const CHANNEL_MIME = 'application/x-krypt-channel';

/** Instruments offered in the "+" picker (audio-clip channels are made by the playlist). */
export const PICKABLE_INSTRUMENTS = INSTRUMENTS.filter((p) => p.id !== 'krypt.audioclip');

export function sampleNameFromPath(path: string): string {
  return (path.split(/[\\/:]/).pop() ?? 'Sample').replace(/\.[a-z0-9]+$/i, '');
}

export async function addChannel(type: string, index?: number): Promise<string | null> {
  const r = await dispatch<{ id: string }>('channels.add', { type, index });
  if (!r.ok || !r.data) return null;
  getUi().selectChannel(r.data.id);
  flashHint(`Added ${getProject().channels[r.data.id]?.name ?? 'channel'} on its own mixer insert`, 'ok');
  return r.data.id;
}

/** A factory sound's display name from the sample index ("Punchy Club Kick"), else the file name. */
function displayName(path: string): string {
  const known = path.startsWith('factory:') ? useSounds.getState().samples?.find((x) => x.path === path)?.name : undefined;
  return known?.slice(0, 64) || sampleNameFromPath(path);
}

export async function addSampleChannel(path: string, index?: number): Promise<string | null> {
  const name = displayName(path);
  const id = await withGroup(`Add ${name}`, async (groupId) => {
    const s = await dispatch<{ id: string }>('samples.add', { path }, { groupId });
    if (!s.ok || !s.data) return null;
    const c = await dispatch<{ id: string }>('channels.add', { type: 'krypt.sampler', sampleId: s.data.id, name, index }, { groupId });
    return c.ok && c.data ? c.data.id : null;
  });
  if (id) {
    getUi().selectChannel(id);
    flashHint(`Added sampler "${name}"`, 'ok');
  }
  return id;
}

export async function replaceChannelSample(channelId: string, path: string): Promise<void> {
  const ch = getProject().channels[channelId];
  if (!ch) return;
  const name = sampleNameFromPath(path);
  const ok = await withGroup(`Load ${name}`, async (groupId) => {
    const s = await dispatch<{ id: string }>('samples.add', { path }, { groupId });
    if (!s.ok || !s.data) return false;
    // An audio file needs a plugin that plays one: the Multisampler plays .sfz instruments only.
    if (!pluginById(ch.generator.type)?.usesSample || ch.generator.type === 'krypt.multisampler') {
      const g = await dispatch('channels.setGenerator', { id: channelId, type: 'krypt.sampler' }, { groupId });
      if (!g.ok) return false;
    }
    const r = await dispatch('channels.setSample', { id: channelId, sampleId: s.data.id, rename: true }, { groupId });
    return r.ok;
  });
  if (ok) flashHint(`Loaded ${name} into ${ch.name}`, 'ok');
}

export async function routeToNewInsert(channelId: string): Promise<void> {
  const ch = getProject().channels[channelId];
  if (!ch) return;
  const id = await withGroup(`Route ${ch.name} to a new insert`, async (groupId) => {
    const ins = await dispatch<{ id: string }>('mixer.addInsert', { name: ch.name, color: ch.color }, { groupId });
    if (!ins.ok || !ins.data) return null;
    const r = await dispatch('channels.set', { id: channelId, insertId: ins.data.id }, { groupId });
    return r.ok ? ins.data.id : null;
  });
  if (id) {
    getUi().selectInsert(id);
    flashHint(`${ch.name} → new insert ${getProject().mixer.insertOrder.indexOf(id)}`, 'ok');
  }
}

export function insertLabel(insertId: string): string {
  const p = getProject();
  if (insertId === p.mixer.masterId) return 'M';
  const i = p.mixer.insertOrder.indexOf(insertId);
  return i < 0 ? '?' : String(i);
}

export function insertMenuItems(channelId: string): MenuItem[] {
  const p = getProject();
  const ch = p.channels[channelId];
  if (!ch) return [];
  const items: MenuItem[] = [{ type: 'header', label: `Route ${ch.name} to` }];
  p.mixer.insertOrder.forEach((id, i) => {
    const ins = p.mixer.inserts[id];
    items.push({
      label: ins.isMaster ? 'Master' : `${i} · ${ins.name}`,
      swatch: ins.color,
      checked: ch.insertId === id,
      onSelect: () => void dispatch('channels.set', { id: channelId, insertId: id }).then((r) => r.ok && flashHint(`${ch.name} → ${ins.name}`, 'ok')),
    });
  });
  items.push({ type: 'separator' }, { label: 'New insert', icon: Route, onSelect: () => void routeToNewInsert(channelId) });
  return items;
}

export function openInPianoRoll(channelId: string): void {
  getUi().selectChannel(channelId);
  wm.open('pianoRoll');
}

export async function renameChannel(channelId: string): Promise<void> {
  const ch = getProject().channels[channelId];
  if (!ch) return;
  const name = await modal.prompt({
    title: 'Rename channel',
    initialValue: ch.name,
    validate: (v) => (!v.trim() ? 'Name cannot be empty' : v.length > 64 ? 'At most 64 characters' : null),
  });
  if (name && name !== ch.name) await dispatch('channels.set', { id: channelId, name });
}

export async function deleteChannel(channelId: string): Promise<void> {
  const p = getProject();
  const ch = p.channels[channelId];
  if (!ch) return;
  const notes = Object.values(p.patterns).reduce((n, pat) => n + Object.keys(pat.notes[channelId] ?? {}).length, 0);
  const ok = await modal.confirm({
    title: `Delete ${ch.name}?`,
    message: notes
      ? `This removes the channel and its ${notes} note${notes === 1 ? '' : 's'} in every pattern. Its mixer insert is kept. You can undo this.`
      : 'Its mixer insert is kept. You can undo this.',
    confirmLabel: 'Delete channel',
    destructive: true,
  });
  if (!ok) return;
  const r = await dispatch('channels.remove', { ids: [channelId] });
  if (r.ok) flashHint(`Deleted ${ch.name}`, 'ok');
}

export function channelMenuItems(channelId: string, doc?: Document | null): MenuItem[] {
  const p = getProject();
  const ch = p.channels[channelId];
  if (!ch) return [];
  // Audio-clip / sampler channels with a sample: Detect tempo & key, Separate stems, Convert to pattern.
  const ears = channelEarsItems(channelId, doc);
  const patId = p.transport.activePatternId;
  const hasNotes = !!(patId && Object.keys(p.patterns[patId]?.notes[channelId] ?? {}).length);
  const gen = pluginById(ch.generator.type);
  return [
    { type: 'header', label: `${ch.name} · ${gen?.name ?? ch.generator.type}` },
    { label: 'Open plugin editor', icon: Plug, onSelect: () => wm.openPlugin({ kind: 'channel', channelId }) },
    ...nativeEditorItems(ch.generator.type, { channelId }),
    { label: 'Open in Piano Roll', icon: Piano, shortcut: 'F7', onSelect: () => openInPianoRoll(channelId) },
    { type: 'separator' },
    { label: 'Rename…', icon: Pencil, onSelect: () => void renameChannel(channelId) },
    {
      type: 'submenu',
      label: 'Color',
      icon: Palette,
      swatch: ch.color,
      items: [
        {
          type: 'custom',
          render: () =>
            createElement(ColorSwatches, {
              colors: PALETTE,
              current: ch.color,
              onPick: (color: string) => {
                closeMenu();
                void dispatch('channels.set', { id: channelId, color });
              },
            }),
        },
      ],
    },
    {
      type: 'submenu',
      label: 'Replace instrument',
      icon: Replace,
      items: [
        ...PICKABLE_INSTRUMENTS.map((d) => ({
          label: d.name,
          detail: d.category,
          checked: d.id === ch.generator.type,
          onSelect: () => void dispatch('channels.setGenerator', { id: channelId, type: d.id }).then((r) => r.ok && flashHint(`${ch.name} now plays ${d.name}`, 'ok')),
        })),
        ...installedPickerItems(
          'instrument',
          (d) => void dispatch('channels.setGenerator', { id: channelId, type: d.id }).then((r) => r.ok && flashHint(`${ch.name} now plays ${d.name}`, 'ok')),
          { current: ch.generator.type },
        ),
      ],
    },
    ...channelRackItems(channelId),
    { type: 'separator' },
    {
      label: 'Clone',
      icon: Copy,
      onSelect: () =>
        void dispatch<{ id: string }>('channels.clone', { id: channelId, withNotes: true }).then((r) => {
          if (r.ok && r.data) {
            getUi().selectChannel(r.data.id);
            flashHint(`Cloned ${ch.name}`, 'ok');
          }
        }),
    },
    { type: 'submenu', label: 'Route to mixer insert', icon: SlidersVertical, items: insertMenuItems(channelId) },
    { label: 'Route to a new insert', icon: Route, onSelect: () => void routeToNewInsert(channelId) },
    { type: 'separator' },
    { label: 'Solo', icon: Headphones, hint: 'Mute every other channel (again to unmute all)', onSelect: () => void dispatch('channels.solo', { id: channelId }) },
    { label: ch.mute ? 'Unmute' : 'Mute', icon: VolumeX, onSelect: () => void dispatch('channels.set', { id: channelId, mute: !ch.mute }) },
    {
      label: 'Clear notes in this pattern',
      icon: Eraser,
      disabled: !hasNotes,
      onSelect: () => patId && void dispatch('notes.clear', { patternId: patId, channelId }),
    },
    { type: 'separator' },
    { type: 'submenu', label: 'Fill', icon: PaintBucket, disabled: !patId, items: fillMenuItems(channelId) },
    { type: 'submenu', label: 'Shift steps', icon: MoveHorizontal, disabled: !patId || !hasNotes, items: shiftMenuItems(channelId) },
    { type: 'submenu', label: 'Pattern length', icon: Ruler, disabled: !patId, items: patternLengthItems() },
    { type: 'submenu', label: 'Filter group', icon: ListFilter, items: groupMenuItems(channelId) },
    ...(gen?.usesSample
      ? ([
          {
            label: 'Load sample…',
            icon: FolderInput,
            onSelect: () => void loadSampleDialog(channelId),
          },
        ] as MenuItem[])
      : []),
    ...(ears.length ? ([{ type: 'separator' }, ...ears] as MenuItem[]) : []),
    { type: 'separator' },
    { label: 'Delete…', icon: Trash2, danger: true, onSelect: () => void deleteChannel(channelId) },
  ];
}

// ── Step tools (Fill each N steps, shift / rotate) ──────────────────────

export async function fillSteps(channelId: string, every: number, offset = 0): Promise<void> {
  const p = getProject();
  const patternId = p.transport.activePatternId;
  const ch = p.channels[channelId];
  if (!patternId || !ch) return;
  const r = await dispatch<{ ids: string[]; removed: number }>('notes.fillSteps', { patternId, channelId, every, offset });
  if (r.ok && r.data) {
    const n = r.data.ids.length;
    flashHint(`${ch.name}: filled each ${every} step${every === 1 ? '' : 's'}${offset ? ` from step ${offset + 1}` : ''} · ${n} step${n === 1 ? '' : 's'} on`, 'ok');
  }
}

export function fillMenuItems(channelId: string): MenuItem[] {
  return [
    { type: 'header', label: 'Replaces the row steps' },
    { label: 'Fill each 2 steps', onSelect: () => void fillSteps(channelId, 2) },
    { label: 'Fill each 4 steps', onSelect: () => void fillSteps(channelId, 4) },
    { label: 'Fill each 8 steps', onSelect: () => void fillSteps(channelId, 8) },
    { type: 'separator' },
    { label: 'Fill each 2 steps, off-beat', hint: 'Steps 2, 4, 6…', onSelect: () => void fillSteps(channelId, 2, 1) },
    { label: 'Fill each 4 steps, from step 3', hint: 'Steps 3, 7, 11… (the off-beat 8ths)', onSelect: () => void fillSteps(channelId, 4, 2) },
    { label: 'Fill every step', onSelect: () => void fillSteps(channelId, 1) },
  ];
}

export async function shiftSteps(channelId: string, steps: number): Promise<void> {
  const p = getProject();
  const patternId = p.transport.activePatternId;
  const ch = p.channels[channelId];
  if (!patternId || !ch) return;
  if (!Object.keys(p.patterns[patternId]?.notes[channelId] ?? {}).length) {
    flashHint(`${ch.name} has no notes to shift in this pattern`, 'warn');
    return;
  }
  const r = await dispatch('notes.shiftSteps', { patternId, channelId, steps });
  if (r.ok) flashHint(`${ch.name}: shifted ${Math.abs(steps)} step${Math.abs(steps) === 1 ? '' : 's'} ${steps < 0 ? 'left' : 'right'} (wraps around)`, 'ok');
}

export function shiftMenuItems(channelId: string): MenuItem[] {
  const beat = Math.max(1, Math.round(ticksPerBeat(getProject().transport.timeSig) / TICKS_PER_STEP));
  return [
    { label: 'Left one step', onSelect: () => void shiftSteps(channelId, -1) },
    { label: 'Right one step', onSelect: () => void shiftSteps(channelId, 1) },
    { type: 'separator' },
    { label: 'Left one beat', onSelect: () => void shiftSteps(channelId, -beat) },
    { label: 'Right one beat', onSelect: () => void shiftSteps(channelId, beat) },
  ];
}

// ── Pattern length (steps per pattern) ─────────────────────────────────

export const STEP_LENGTHS = [8, 12, 16, 24, 32, 48, 64, 96, 128];

/** Set the active pattern's length in 16th steps (0 = auto: follows the notes). */
export async function setPatternSteps(steps: number): Promise<void> {
  const patternId = getProject().transport.activePatternId;
  if (!patternId) return;
  const r = await dispatch(
    'patterns.set',
    { id: patternId, length: steps ? steps * TICKS_PER_STEP : null },
    { label: steps ? `Pattern length ${steps} steps` : 'Pattern length auto' },
  );
  if (r.ok) flashHint(steps ? `Pattern length: ${steps} steps` : 'Pattern length: auto (follows the notes)', 'ok');
}

export async function customPatternSteps(): Promise<void> {
  const p = getProject();
  const pat = p.transport.activePatternId ? p.patterns[p.transport.activePatternId] : null;
  if (!pat) return;
  const cur = pat.length ? String(Math.round(pat.length / TICKS_PER_STEP)) : '16';
  const v = await modal.prompt({
    title: `Length of ${pat.name}`,
    message: 'Pattern length in 16th steps (16 = one 4/4 bar).',
    initialValue: cur,
    validate: (s) => (/^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 4096 ? null : 'Enter a whole number of steps from 1 to 4096'),
  });
  if (v) await setPatternSteps(Number(v));
}

export function patternLengthItems(): MenuItem[] {
  const p = getProject();
  const pat = p.transport.activePatternId ? p.patterns[p.transport.activePatternId] : null;
  const cur = pat?.length ? Math.round(pat.length / TICKS_PER_STEP) : 0;
  return [
    { type: 'header', label: pat ? `${pat.name} · ${cur ? `${cur} steps` : 'auto'}` : 'No pattern' },
    { label: 'Auto (follows the notes)', checked: cur === 0, onSelect: () => void setPatternSteps(0) },
    ...STEP_LENGTHS.map((n) => ({ label: `${n} steps`, checked: cur === n, onSelect: () => void setPatternSteps(n) })),
    { type: 'separator' },
    { label: 'Custom…', checked: cur > 0 && !STEP_LENGTHS.includes(cur), onSelect: () => void customPatternSteps() },
  ];
}

// ── Filter groups ──────────────────────────────────────────────────────

export async function setChannelGroup(channelId: string, group: string | null): Promise<void> {
  const ch = getProject().channels[channelId];
  if (!ch) return;
  const r = await dispatch('channels.set', { id: channelId, group }, { label: group ? `Group ${ch.name}: ${group}` : `Group ${ch.name}: automatic` });
  if (r.ok) flashHint(group ? `${ch.name} → filter group "${group}"` : `${ch.name} → automatic group (${autoGroup(ch)})`, 'ok');
}

export async function newChannelGroup(channelId: string): Promise<void> {
  const ch = getProject().channels[channelId];
  if (!ch) return;
  const name = await modal.prompt({
    title: 'New filter group',
    message: `Put ${ch.name} in a new Channel Rack filter group.`,
    placeholder: 'e.g. Vocals, FX, Leads',
    validate: (v) => (!v.trim() ? 'Name cannot be empty' : v.trim().length > 32 ? 'At most 32 characters' : v.trim() === 'All' ? '"All" is reserved' : null),
  });
  if (name) await setChannelGroup(channelId, name.trim());
}

export function groupMenuItems(channelId: string): MenuItem[] {
  const p = getProject();
  const ch = p.channels[channelId];
  if (!ch) return [];
  const names = groupNames(p);
  return [
    { type: 'header', label: `${ch.name} is in ${channelGroup(ch)}` },
    { label: `Automatic (${autoGroup(ch)})`, checked: !ch.group, onSelect: () => void setChannelGroup(channelId, null) },
    ...names.map((g) => ({
      label: g,
      detail: (AUTO_GROUPS as readonly string[]).includes(g) ? undefined : 'Custom group',
      checked: ch.group === g,
      onSelect: () => void setChannelGroup(channelId, g),
    })),
    { label: 'New group…', icon: Pencil, onSelect: () => void newChannelGroup(channelId) },
    { type: 'separator' },
    {
      label: `Show only ${channelGroup(ch)}`,
      icon: ListFilter,
      onSelect: () => {
        useRackView.getState().setFilter(channelGroup(ch));
        flashHint(`Channel Rack filter: ${channelGroup(ch)}`, 'ok');
      },
    },
  ];
}

export async function loadSampleDialog(channelId: string): Promise<void> {
  let paths: string[] | null = null;
  try {
    paths = await window.krypt.dialog.openFile({
      title: 'Load sample',
      filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS] }],
    });
  } catch (err) {
    toast.error(`Couldn't open the file dialog: ${(err as Error).message}`);
    return;
  }
  if (!paths || !paths.length) return;
  await replaceChannelSample(channelId, paths[0]);
}

export function instrumentPickerItems(index?: number): MenuItem[] {
  const groups = new Map<string, typeof PICKABLE_INSTRUMENTS>();
  for (const d of PICKABLE_INSTRUMENTS) {
    const list = groups.get(d.category) ?? [];
    list.push(d);
    groups.set(d.category, list);
  }
  const items: MenuItem[] = [];
  for (const [cat, list] of groups) {
    items.push({ type: 'header', label: `Stock · ${cat}` });
    for (const d of list) items.push({ label: d.name, detail: d.description, onSelect: () => void addChannel(d.id, index) });
  }
  // Third-party VST3 / CLAP instruments (Plugin Manager).
  items.push(...installedPickerItems('instrument', (d) => void addChannel(d.id, index)));
  return items;
}
