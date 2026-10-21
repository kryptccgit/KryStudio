// ──────────────────────────────────────────────────────────────────────
// Preset verbs shared by the preset bar, the preset browser, the Browser
// panel, the Mixer and Home. Loading a preset is ONE doc command (one undo
// step); every verb ends in a toast (failed dispatches are toasted by the
// app's dispatch error handler).
// ──────────────────────────────────────────────────────────────────────

import { pluginById } from '@shared/plugins/catalog';
import type { PresetSummary } from '@shared/sounds/types';
import { factoryPreset } from '@shared/sounds/factory';
import { dispatch, getProject } from '../doc/store';
import { getUi } from '../state/ui';
import { modal, toast } from '../app/notify';
import { wm } from '../workspace/WindowManager';
import { showHome } from '../home/store';
import { cycleList, cyclePreset, validatePresetName, withBrowserRoot } from './logic';
import { fetchPreset, loadFactorySamples, presetList, refreshSounds, requestBrowserReveal, useSounds } from './store';
import { packGate, usePacks } from './packs';
import { missingPackFor } from './packsLogic';

function insertLabel(insertId: string): string {
  const p = getProject();
  const ins = p.mixer.inserts[insertId];
  if (!ins) return 'the insert';
  return ins.isMaster ? 'the master' : ins.name;
}

/** Load an instrument preset onto a channel (replaces the instrument, its params, sample and, withFx, the insert effects). */
export async function loadPresetOnChannel(channelId: string, presetId: string, opts: { withFx?: boolean } = {}): Promise<boolean> {
  const ch = getProject().channels[channelId];
  if (!ch) {
    toast.error('That channel no longer exists');
    return false;
  }
  const got = await fetchPreset(presetId);
  if (!got.ok || !got.data) {
    toast.error(`Couldn't load the preset: ${got.message ?? 'not found'}`);
    return false;
  }
  const preset = got.data;
  if (preset.kind !== 'instrument') {
    toast.warn(`${preset.name} is an effect chain. Load it on a mixer insert instead.`);
    return false;
  }
  if (!(await packGate(preset))) return false;
  const withFx = opts.withFx ?? useSounds.getState().withFx;
  const r = await dispatch('presets.applyToChannel', { channelId, preset, withFx });
  if (r.ok) toast.success(`Loaded ${preset.name}${withFx && preset.fx?.length ? ' with its effects' : ''}`);
  return r.ok;
}

/** A new channel (on its own insert) playing a preset. */
export async function addPresetChannel(presetId: string, index?: number): Promise<string | null> {
  const got = await fetchPreset(presetId);
  if (!got.ok || !got.data) {
    toast.error(`Couldn't add the preset: ${got.message ?? 'not found'}`);
    return null;
  }
  const preset = got.data;
  if (preset.kind !== 'instrument') {
    toast.warn(`${preset.name} is an effect chain. Load it on a mixer insert instead.`);
    return null;
  }
  if (!(await packGate(preset))) return null;
  const withFx = useSounds.getState().withFx;
  const r = await dispatch<{ channelId: string; insertId: string }>('presets.addChannel', { preset, withFx, ...(index !== undefined ? { index } : {}) });
  if (!r.ok) return null;
  const id = r.data?.channelId ?? null;
  if (id) getUi().selectChannel(id);
  toast.success(`Added ${preset.name} to the Channel Rack`);
  return id;
}

/** Load an effect-chain preset onto a mixer insert: replace its effects, or add after them. */
export async function applyChainPreset(insertId: string, presetId: string, mode: 'replace' | 'append' = 'replace'): Promise<boolean> {
  if (!getProject().mixer.inserts[insertId]) {
    toast.error('That mixer insert no longer exists');
    return false;
  }
  const got = await fetchPreset(presetId);
  if (!got.ok || !got.data) {
    toast.error(`Couldn't load the chain: ${got.message ?? 'not found'}`);
    return false;
  }
  const preset = got.data;
  if (preset.kind !== 'chain') {
    toast.warn(`${preset.name} is an instrument preset. Load it on a channel instead.`);
    return false;
  }
  const r = await dispatch('presets.applyChain', { insertId, preset, mode });
  if (r.ok) toast.success(mode === 'append' ? `Added ${preset.name} to ${insertLabel(insertId)}` : `Loaded ${preset.name} on ${insertLabel(insertId)}`);
  return r.ok;
}

/** The preset bar's arrows: the previous / next preset of the channel's instrument. */
export async function stepPreset(channelId: string, dir: 1 | -1): Promise<void> {
  const ch = getProject().channels[channelId];
  if (!ch) return;
  // Presets whose sound pack isn't installed are stepped over (the preset browser offers their pack instead).
  const packs = usePacks.getState().state;
  const cache = useSounds.getState().cache;
  const current = ch.generator.preset?.id;
  const all = cycleList(presetList(), ch.generator.type);
  const list = all.filter((p) => p.id === current || !missingPackFor(p.id.startsWith('factory:') ? factoryPreset(p.id) : cache[p.id], packs));
  const next = cyclePreset(list, ch.generator.preset?.id, dir);
  if (!next && all.length) {
    toast.info(`The ${pluginById(ch.generator.type)?.name ?? 'instrument'} presets need a sound pack. Download one in Home ▸ Sounds.`, { action: { label: 'Sound packs', run: () => showHome('sounds') } });
    return;
  }
  if (!next) {
    toast.info(`No presets for ${pluginById(ch.generator.type)?.name ?? 'this instrument'} yet. Browse presets to pick one for another instrument.`);
    return;
  }
  await loadPresetOnChannel(channelId, next.id);
}

// ── Your presets ──────────────────────────────────────────────────────

export async function renameUserPreset(p: Pick<PresetSummary, 'id' | 'name' | 'source'>): Promise<void> {
  if (p.source !== 'user') {
    toast.warn('Factory presets can’t be renamed. Save a copy with Save preset… instead.');
    return;
  }
  const name = await modal.prompt({ title: 'Rename preset', initialValue: p.name, validate: validatePresetName });
  if (name === null) return;
  const next = name.trim();
  if (next === p.name) {
    toast.info('Name unchanged');
    return;
  }
  try {
    const r = await window.krypt.sounds.renameUser(p.id, next);
    if (r.ok) toast.success(`Renamed to ${r.data?.name ?? next}`);
    else toast.error(r.message || `Couldn't rename ${p.name}`);
  } catch (err) {
    toast.error(`Couldn't rename ${p.name}: ${(err as Error)?.message ?? err}`);
  }
}

export async function deleteUserPreset(p: Pick<PresetSummary, 'id' | 'name' | 'source'>): Promise<void> {
  if (p.source !== 'user') {
    toast.warn('Factory presets can’t be deleted.');
    return;
  }
  const ok = await modal.confirm({
    title: `Delete ${p.name}?`,
    message: 'The preset file is removed from your presets folder. Channels that already use it keep their sound. This can’t be undone.',
    confirmLabel: 'Delete preset',
    destructive: true,
  });
  if (!ok) return;
  try {
    const r = await window.krypt.sounds.deleteUser(p.id);
    if (r.ok) toast.success(`Deleted ${p.name}`);
    else toast.error(r.message || `Couldn't delete ${p.name}`);
  } catch (err) {
    toast.error(`Couldn't delete ${p.name}: ${(err as Error)?.message ?? err}`);
  }
}

export async function revealUserPresets(): Promise<void> {
  try {
    const r = await window.krypt.sounds.revealUserDir();
    if (!r.ok) toast.error(r.message || 'Couldn’t open the presets folder');
  } catch (err) {
    toast.error(`Couldn’t open the presets folder: ${(err as Error)?.message ?? err}`);
  }
}

/** Re-read presets and the factory index; errors toast, `success` (when given) toasts too. */
export async function reloadSounds(success?: string): Promise<void> {
  await Promise.all([refreshSounds(), loadFactorySamples()]);
  const { error, samplesError } = useSounds.getState();
  if (error) toast.error(`Couldn’t reload presets: ${error}`);
  else if (samplesError) toast.error(`Couldn’t read the factory sounds: ${samplesError}`);
  else if (success) toast.success(success);
}

// ── Navigation + folders ──────────────────────────────────────────────

/** Open the Browser at its Presets section. */
export function openPresetsInBrowser(): void {
  wm.open('browser');
  requestBrowserReveal('presets');
}

/** Add a folder to the Browser (settings.browserRoots, the path the Browser's own folder button writes). */
export async function addFolderToBrowser(path: string): Promise<boolean> {
  try {
    const s = await window.krypt.settings.get();
    const next = withBrowserRoot(s.browserRoots, path, `root_${Math.random().toString(36).slice(2, 10)}`);
    if (!next.added) {
      toast.info(`${next.name} is already in the Browser`);
      return true;
    }
    await window.krypt.settings.update({ browserRoots: next.roots });
    toast.success(`Added ${next.name} to the Browser. Agents can find and use its sounds now.`, {
      action: { label: 'Open the Browser', run: () => wm.open('browser') },
    });
    return true;
  } catch (err) {
    toast.error(`Couldn't add ${path} to the Browser: ${(err as Error)?.message ?? err}`);
    return false;
  }
}
