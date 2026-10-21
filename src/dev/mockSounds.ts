// Browser-only mock of window.krypt.sounds: factory presets from shared
// data, user presets in memory (Save preset… / Save chain… build them from
// the in-page document like main does), a few fake factory samples (a
// tonal 808, a 4-bar riser…) and fake "found on this PC" folders that know
// which ones are already in the Browser. Devtools: __kryptMockSounds.
// emitState() / .clearUser().

import type { KryptApi, SavePresetMeta, SimilarItem, SimilarResult, SoundsState } from '@shared/types';
import type { Project } from '@shared/schema/project';
import { FACTORY_PRESETS, factoryPreset } from '@shared/sounds/factory';
import { summarizePreset, type ChainPreset, type ChainRole, type FactorySample, type InstrumentPreset, type InstrumentRole, type Preset, type PresetFx } from '@shared/sounds/types';
import { zChainPreset, zInstrumentPreset } from '@shared/sounds/schema';
import { roleFromName } from '@shared/sounds/select';

/** A Windows path from parts (no backslash escaping to get wrong). */
const win = (...parts: string[]): string => parts.join('\\');

const USER_DIR = win('C:', 'Users', 'you', 'AppData', 'Roaming', 'Krypt Studio', 'presets');

const FAKE_SAMPLES: FactorySample[] = [
  { path: 'factory:drums/kick.wav', name: 'Punchy Kick', kind: 'kick', tags: ['punchy'], genres: ['trap', 'house'], lengthSec: 0.42, channels: 1, peakDb: -0.3 },
  { path: 'factory:drums/kick-2.wav', name: 'Deep Kick', kind: 'kick', tags: ['deep'], genres: [], lengthSec: 0.6, channels: 1, peakDb: -0.3 },
  { path: 'factory:drums/snare.wav', name: 'Crack Snare', kind: 'snare', tags: ['bright'], genres: ['trap'], lengthSec: 0.3, channels: 1, peakDb: -0.5 },
  { path: 'factory:drums/clap.wav', name: 'Wide Clap', kind: 'clap', tags: ['wide'], genres: ['house', 'edm'], lengthSec: 0.35, channels: 2, peakDb: -0.5 },
  { path: 'factory:drums/hat-closed.wav', name: 'Tight Hat', kind: 'hat', tags: ['short'], genres: [], lengthSec: 0.08, channels: 1, peakDb: -1 },
  { path: 'factory:drums/hat-open.wav', name: 'Open Hat', kind: 'openhat', tags: [], genres: [], lengthSec: 0.5, channels: 1, peakDb: -1 },
  { path: 'factory:drums/808.wav', name: 'Long 808', kind: '808', tags: ['long', 'deep'], genres: ['trap', 'drill'], rootNote: 36, lengthSec: 2.4, channels: 1, peakDb: -0.3 },
  { path: 'factory:oneshots/stab-minor.wav', name: 'Minor Stab', kind: 'stab-oneshot', tags: ['dark'], genres: ['techno'], rootNote: 57, lengthSec: 0.9, channels: 2, peakDb: -1 },
  { path: 'factory:fx/riser-noise-4bar.wav', name: 'Noise Riser 4 bars', kind: 'riser', tags: ['big'], genres: ['edm'], bpm: 128, bars: 4, lengthSec: 7.5, channels: 2, peakDb: -1 },
  { path: 'factory:fx/reverse-cymbal-1bar.wav', name: 'Reverse Cymbal 1 bar', kind: 'reverse-cymbal', tags: [], genres: [], bpm: 128, bars: 1, lengthSec: 1.875, channels: 2, peakDb: -1 },
  { path: 'factory:fx/impact-boom.wav', name: 'Boom Impact', kind: 'impact', tags: ['big', 'deep'], genres: ['edm', 'dubstep'], lengthSec: 3.2, channels: 2, peakDb: -0.5 },
  { path: 'factory:textures/vinyl.wav', name: 'Vinyl Crackle', kind: 'texture', tags: ['lofi', 'vintage'], genres: ['lofi'], bpm: 90, bars: 8, lengthSec: 21.3, channels: 2, peakDb: -12 },
];

const FAKE_FOLDERS = [
  { path: win('C:', 'Users', 'you', 'Documents', 'Samples'), audioFiles: 1240 },
  { path: win('C:', 'Users', 'you', 'Downloads', 'Free Drum Pack Vol 2'), audioFiles: 186 },
  { path: win('D:', 'Music', 'One Shots'), audioFiles: 58 },
];

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'preset';

const clampDb = (lin: number): number => Math.max(-60, Math.min(12, lin > 0 ? 20 * Math.log10(lin) : -60));

function slotsToFx(p: Project, insertId: string): PresetFx[] {
  const ins = p.mixer.inserts[insertId];
  if (!ins) return [];
  return ins.slotOrder.map((sid) => {
    const s = ins.slots[sid];
    return { type: s.type, params: { ...s.params }, mix: s.mix, enabled: s.enabled };
  });
}

export function createMockSounds(): KryptApi['sounds'] {
  const user = new Map<string, Preset>();
  const subs = new Set<(s: SoundsState) => void>();
  const all = (): Preset[] => [...FACTORY_PRESETS, ...user.values()];
  const state = (): SoundsState => ({ presets: all().map(summarizePreset), factoryCount: FACTORY_PRESETS.length, userCount: user.size, userDir: USER_DIR });
  const emit = (): void => {
    const s = state();
    subs.forEach((fn) => fn(s));
  };
  const uniqueId = (prefix: string, name: string): string => {
    const base = `${prefix}${slug(name)}`;
    let id = base;
    for (let n = 2; user.has(id); n++) id = `${base}-${n}`;
    return id;
  };
  const project = async (): Promise<Project> => (await window.krypt.doc.snapshot()).project;
  const meta = (m: SavePresetMeta) => ({
    name: m.name.trim().slice(0, 64),
    tags: (m.tags ?? []).map((t) => t.toLowerCase()).slice(0, 24),
    genres: m.genres ?? [],
    description: (m.description ?? '').slice(0, 300),
    author: 'You',
  });

  (window as any).__kryptMockSounds = {
    emitState: emit,
    clearUser: () => {
      user.clear();
      emit();
    },
  };

  return {
    state: async () => state(),
    onState: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    get: async (id) => {
      const p = factoryPreset(id) ?? user.get(id);
      return p ? { ok: true, data: p } : { ok: false, message: `No preset ${id}` };
    },
    saveChannel: async (channelId, m) => {
      const p = await project();
      const ch = p.channels[channelId];
      if (!ch) return { ok: false, message: 'That channel no longer exists' };
      if (!m.name?.trim()) return { ok: false, message: 'The preset needs a name' };
      const ins = p.mixer.inserts[ch.insertId];
      const fx = m.withFx && ins && !ins.isMaster ? slotsToFx(p, ch.insertId) : [];
      const sample = ch.generator.sampleId ? p.samples[ch.generator.sampleId]?.path : undefined;
      const role: InstrumentRole = m.role ?? roleFromName(m.name) ?? roleFromName(ch.name) ?? 'lead';
      const preset: InstrumentPreset = {
        kind: 'instrument',
        id: uniqueId('user:', m.name),
        plugin: ch.generator.type,
        params: { ...ch.generator.params },
        ...(sample ? { sample } : {}),
        channel: { volumeDb: clampDb(ch.volume), pan: ch.pan, mono: ch.poly.mono, glideMs: ch.poly.glideMs, rootKey: ch.rootKey, cutGroup: ch.poly.cutGroup, cutBy: ch.poly.cutBy },
        ...(fx.length ? { fx } : {}),
        role,
        ...meta(m),
      };
      const v = zInstrumentPreset.safeParse(preset);
      if (!v.success) return { ok: false, message: `Couldn't save: ${v.error.issues[0]?.message ?? 'invalid preset'}` };
      user.set(preset.id, preset);
      emit();
      return { ok: true, message: `Saved ${preset.name}`, data: summarizePreset(preset) };
    },
    saveChain: async (insertId, m) => {
      const p = await project();
      const ins = p.mixer.inserts[insertId];
      if (!ins) return { ok: false, message: 'That mixer insert no longer exists' };
      const fx = slotsToFx(p, insertId);
      if (!fx.length) return { ok: false, message: `${ins.isMaster ? 'The master' : ins.name} has no effects to save` };
      const role: ChainRole = m.role;
      const preset: ChainPreset = {
        kind: 'chain',
        id: uniqueId('user:chain/', m.name),
        role,
        fx,
        insert: { volumeDb: clampDb(ins.volume), pan: ins.pan, stereoSep: ins.stereoSep },
        ...meta(m),
      };
      const v = zChainPreset.safeParse(preset);
      if (!v.success) return { ok: false, message: `Couldn't save: ${v.error.issues[0]?.message ?? 'invalid chain'}` };
      user.set(preset.id, preset);
      emit();
      return { ok: true, message: `Saved ${preset.name}`, data: summarizePreset(preset) };
    },
    renameUser: async (id, name) => {
      const p = user.get(id);
      if (!p) return { ok: false, message: 'Only your own presets can be renamed' };
      if (!name.trim()) return { ok: false, message: 'The preset needs a name' };
      const next = { ...p, name: name.trim().slice(0, 64) } as Preset;
      user.set(id, next);
      emit();
      return { ok: true, data: summarizePreset(next) };
    },
    deleteUser: async (id) => {
      if (!user.delete(id)) return { ok: false, message: 'Only your own presets can be deleted' };
      emit();
      return { ok: true };
    },
    revealUserDir: async () => ({ ok: false, message: `Browser mock: the real app opens ${USER_DIR}` }),
    factorySamples: async () => FAKE_SAMPLES,
    // "More like this": no fingerprints in the browser, so neighbours are faked from the same kind / role, with a
    // first answer that still has pack sounds "being measured" (the Browser asks again).
    similar: async (source, q = {}) => {
      await new Promise((r) => setTimeout(r, 250));
      const isPreset = source.kind === 'preset';
      const preset = isPreset ? (factoryPreset(source.id) ?? user.get(source.id)) : undefined;
      if (isPreset && (!preset || preset.kind !== 'instrument')) return { ok: false, message: `There's no instrument preset "${source.id}".` };
      const sample = !isPreset ? FAKE_SAMPLES.find((x) => x.path === source.path) : undefined;
      const kind: string | null = preset && preset.kind === 'instrument' ? preset.role : (sample?.kind ?? null);
      const name = preset?.name ?? sample?.name ?? (source.kind === 'sample' ? source.path.split(/[\\/:]/).pop() : '') ?? 'sound';
      const same = (k: string) => q.scope === 'any' || !kind || k === kind;
      const why = ['darker, shorter tail', 'brighter, punchier', 'close on brightness and length', 'more sub, longer tail', 'noisier, snappier attack'];
      const items: SimilarItem[] = [];
      if (q.want !== 'presets')
        for (const x of FAKE_SAMPLES) if (x.path !== (source.kind === 'sample' ? source.path : '') && same(x.kind)) items.push({ type: 'sample', path: x.path, kind: x.kind, origin: 'factory', name: x.name, percent: 0, why: '', sameKind: x.kind === kind, ...(x.rootNote !== undefined ? { rootNote: x.rootNote } : {}), ...(x.bars !== undefined ? { bars: x.bars } : {}) });
      if (q.want !== 'samples')
        for (const p of all()) if (p.kind === 'instrument' && p.id !== (isPreset ? source.id : '') && same(p.role)) items.push({ type: 'preset', id: p.id, role: p.role, plugin: p.plugin, origin: p.id.startsWith('user:') ? 'user' : 'factory', name: p.name, percent: 0, why: '', sameKind: p.role === kind });
      const shown = items.slice(0, Math.min(q.limit ?? 40, 40)).map((x, i) => ({ ...x, percent: Math.max(35, 96 - i * 4), why: why[i % why.length] }));
      const first = !(window as any).__kryptMockSimilarSeen;
      (window as any).__kryptMockSimilarSeen = true;
      const data: SimilarResult = { source: { name, kind, inferred: !kind }, scope: q.scope === 'any' ? 'any' : 'same', items: shown, pending: first ? 12 : 0, measured: first ? 0 : 12, notes: [] };
      return { ok: true, message: `${shown.length} sounds like "${name}" (browser mock)`, data };
    },
    suggestSampleFolders: async () => {
      const roots = (await window.krypt.settings.get()).browserRoots.map((r) => r.path.toLowerCase());
      return FAKE_FOLDERS.map((f) => ({ ...f, inBrowser: roots.includes(f.path.toLowerCase()) }));
    },
  };
}
