import type { Channel, MixerInsert, Project } from '../schema/project';
import type { PluginCatalog } from '../plugins/types';
import { findPlugin } from '../schema/params';
import { DEFAULT_CHANNEL_VOLUME } from '../schema/project';
import { CHAIN_ROLES, INSTRUMENT_ROLES, type ChainPreset, type ChainRole, type InstrumentPreset, type InstrumentRole, type PresetFx } from './types';
import { roleFromName } from './select';
import type { GenreId } from './genres';
import { rackToSpec } from './rackSpec';

export interface CaptureMeta {
  name: string;
  tags?: string[];
  genres?: GenreId[];
  description?: string;
  author?: string;
}

export function presetSlug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s || 'preset';
}

export function cleanTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    const c = String(t).toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 32);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= 24) break;
  }
  return out;
}

const round = (v: number): number => Math.round(v * 1e6) / 1e6;

export function sparseParams(catalog: PluginCatalog, type: string, params: Record<string, number>): Record<string, number> {
  const desc = findPlugin(catalog, type);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!Number.isFinite(v)) continue;
    const spec = desc?.params.find((p) => p.id === k);
    if (desc && !spec) continue;
    if (spec && Math.abs(v - spec.default) < 1e-9) continue;
    out[k] = round(v);
  }
  return out;
}

function fxOf(project: Project, catalog: PluginCatalog, ins: MixerInsert): PresetFx[] {
  return ins.slotOrder
    .map((sid) => ins.slots[sid])
    .filter((s) => !!s)
    .map((s) => {
      const desc = findPlugin(catalog, s.type);
      const fx: PresetFx = { type: s.type, params: sparseParams(catalog, s.type, s.params) };
      if (Math.abs(s.mix - (desc?.defaultMix ?? 1)) > 1e-9) fx.mix = round(s.mix);
      if (!s.enabled) fx.enabled = false;
      if (s.rack) fx.rack = rackToSpec(project, catalog, s.rack);
      return fx;
    });
}

const gainToDb = (g: number): number => (g <= 0 ? -60 : Math.max(-60, Math.min(12, 20 * Math.log10(g))));

export function guessInstrumentRole(ch: Channel): InstrumentRole {
  const fromId = /^(?:factory|user):([a-z0-9]+)\//.exec(ch.generator.preset?.id ?? '')?.[1];
  if (fromId && (INSTRUMENT_ROLES as readonly string[]).includes(fromId)) return fromId as InstrumentRole;
  const byName = roleFromName(ch.name) ?? (ch.generator.preset ? roleFromName(ch.generator.preset.name) : null);
  if (byName) return byName;
  switch (ch.generator.type) {
    case 'krypt.kick808':
      return '808';
    case 'krypt.drumsynth':
    case 'krypt.sampler':
      return 'perc';
    default:
      return 'keys';
  }
}

export function presetFromChannel(
  project: Project,
  catalog: PluginCatalog,
  channelId: string,
  meta: CaptureMeta & { role?: InstrumentRole; withFx?: boolean },
): InstrumentPreset {
  const ch = project.channels[channelId];
  if (!ch) throw new Error(`Channel ${channelId} not found`);
  if (ch.generator.type === 'krypt.audioclip') throw new Error(`"${ch.name}" plays an audio clip; only instrument channels can be saved as presets`);
  const name = meta.name.trim().slice(0, 64) || ch.name;
  const preset: InstrumentPreset = {
    kind: 'instrument',
    id: `user:${presetSlug(name)}`,
    name,
    plugin: ch.generator.type,
    params: sparseParams(catalog, ch.generator.type, ch.generator.params),
    role: meta.role ?? guessInstrumentRole(ch),
    tags: cleanTags(meta.tags),
    genres: [...new Set(meta.genres ?? [])],
    description: (meta.description ?? '').trim().slice(0, 300),
  };
  const sample = ch.generator.sampleId ? project.samples[ch.generator.sampleId] : undefined;
  const gen = findPlugin(catalog, ch.generator.type);
  if (sample && (gen ? gen.usesSample : true)) preset.sample = sample.path;
  if (ch.generator.rack) preset.rack = rackToSpec(project, catalog, ch.generator.rack);
  const channel: NonNullable<InstrumentPreset['channel']> = {};
  if (Math.abs(ch.volume - DEFAULT_CHANNEL_VOLUME) > 1e-6) channel.volumeDb = Math.round(gainToDb(ch.volume) * 10) / 10;
  if (Math.abs(ch.pan) > 1e-6) channel.pan = round(ch.pan);
  if (ch.poly.mono) channel.mono = true;
  if (ch.poly.glideMs) channel.glideMs = Math.min(2000, ch.poly.glideMs);
  const defaultRoot = ch.generator.type === 'krypt.kick808' ? 36 : 60;
  if (preset.sample || ch.rootKey !== defaultRoot) channel.rootKey = ch.rootKey;
  if (ch.poly.cutGroup) channel.cutGroup = Math.min(32, ch.poly.cutGroup);
  if (ch.poly.cutBy) channel.cutBy = Math.min(32, ch.poly.cutBy);
  if (Object.keys(channel).length) preset.channel = channel;
  if (meta.withFx !== false) {
    const ins = project.mixer.inserts[ch.insertId];
    const own = ins && !ins.isMaster && !project.channelOrder.some((id) => id !== ch.id && project.channels[id]?.insertId === ins.id);
    if (own) {
      const fx = fxOf(project, catalog, ins).slice(0, 12);
      if (fx.length) preset.fx = fx;
    }
  }
  if (meta.author) preset.author = meta.author.slice(0, 64);
  return preset;
}

export function guessChainRole(project: Project, insertId: string): ChainRole {
  const ins = project.mixer.inserts[insertId];
  if (!ins || ins.isMaster) return 'master';
  const n = ins.name.toLowerCase();
  if (/\b(reverb|verb|hall|room|plate|space)\b/.test(n)) return 'reverbSend';
  if (/\b(delay|echo)\b/.test(n)) return 'delaySend';
  if (/\b(drum ?bus|drums|drum group|perc bus)\b/.test(n)) return 'drumBus';
  if (/\b(vox|vocals?|voice)\b/.test(n)) return 'vocal';
  const feeding = project.channelOrder.map((id) => project.channels[id]).filter((c) => c?.insertId === insertId);
  const role = roleFromName(ins.name) ?? (feeding.length === 1 ? guessInstrumentRole(feeding[0]) : null);
  switch (role) {
    case 'kick':
    case 'snare':
    case 'clap':
    case 'hat':
    case 'openhat':
    case 'ride':
    case 'crash':
    case 'perc':
    case 'tom':
      return feeding.length > 1 ? 'drumBus' : 'drums';
    case '808':
    case 'sub':
    case 'bass':
      return 'bass';
    case 'lead':
    case 'pad':
    case 'keys':
    case 'pluck':
      return role;
    case 'piano':
    case 'bell':
    case 'chord':
    case 'stab':
      return 'keys';
    case 'arp':
      return 'pluck';
    case 'strings':
    case 'brass':
      return 'pad';
    case 'vox':
      return 'vocal';
    case 'fx':
    case 'texture':
      return 'transition';
    default:
      return 'character';
  }
}

export function chainFromInsert(project: Project, catalog: PluginCatalog, insertId: string, meta: CaptureMeta & { role?: ChainRole; targetLufs?: number }): ChainPreset {
  const id = insertId === 'master' ? project.mixer.masterId : insertId;
  const ins = project.mixer.inserts[id];
  if (!ins) throw new Error(`Insert ${insertId} not found`);
  const fx = fxOf(project, catalog, ins);
  if (!fx.length) throw new Error(`${ins.isMaster ? 'The master' : `"${ins.name}"`} has no effects to save`);
  const name = meta.name.trim().slice(0, 64) || ins.name;
  const role = meta.role && (CHAIN_ROLES as readonly string[]).includes(meta.role) ? meta.role : guessChainRole(project, id);
  const preset: ChainPreset = {
    kind: 'chain',
    id: `user:chain/${presetSlug(name)}`,
    name,
    role,
    fx: fx.slice(0, 12),
    tags: cleanTags(meta.tags),
    genres: [...new Set(meta.genres ?? [])],
    description: (meta.description ?? '').trim().slice(0, 300),
  };
  const insert: NonNullable<ChainPreset['insert']> = {};
  if (!ins.isMaster && Math.abs(ins.volume - 1) > 1e-6) insert.volumeDb = Math.round(gainToDb(ins.volume) * 10) / 10;
  if (Math.abs(ins.pan) > 1e-6) insert.pan = round(ins.pan);
  if (Math.abs(ins.stereoSep) > 1e-6) insert.stereoSep = round(ins.stereoSep);
  if (Object.keys(insert).length) preset.insert = insert;
  if (meta.targetLufs !== undefined) preset.targetLufs = meta.targetLufs;
  if (meta.author) preset.author = meta.author.slice(0, 64);
  return preset;
}
