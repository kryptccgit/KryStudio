import type { ParamSpec } from '@shared/plugins/types';
import { GENRES, type GenreId } from '@shared/sounds/genres';
import { roleFromName } from '@shared/sounds/select';
import { CHAIN_ROLES, INSTRUMENT_ROLES, SAMPLE_KINDS, type ChainRole, type FactorySample, type InstrumentPreset, type InstrumentRole, type PresetSummary, type SampleKind } from '@shared/sounds/types';
import { noteName } from '@shared/music/theory';

export const INSTRUMENT_ROLE_LABELS: Record<InstrumentRole, string> = {
  kick: 'Kicks',
  snare: 'Snares',
  clap: 'Claps',
  hat: 'Hats',
  openhat: 'Open hats',
  ride: 'Rides',
  crash: 'Crashes',
  perc: 'Percussion',
  tom: 'Toms',
  '808': '808s',
  sub: 'Sub bass',
  bass: 'Bass',
  lead: 'Leads',
  pluck: 'Plucks',
  pad: 'Pads',
  keys: 'Keys',
  piano: 'Pianos',
  bell: 'Bells',
  arp: 'Arps',
  stab: 'Stabs',
  chord: 'Chords',
  strings: 'Strings',
  brass: 'Brass',
  vox: 'Vox',
  fx: 'FX',
  texture: 'Textures',
};

export const INSTRUMENT_ROLE_NAMES: Record<InstrumentRole, string> = {
  kick: 'Kick',
  snare: 'Snare',
  clap: 'Clap',
  hat: 'Hat',
  openhat: 'Open hat',
  ride: 'Ride',
  crash: 'Crash',
  perc: 'Percussion',
  tom: 'Tom',
  '808': '808',
  sub: 'Sub bass',
  bass: 'Bass',
  lead: 'Lead',
  pluck: 'Pluck',
  pad: 'Pad',
  keys: 'Keys',
  piano: 'Piano',
  bell: 'Bell',
  arp: 'Arp',
  stab: 'Stab',
  chord: 'Chords',
  strings: 'Strings',
  brass: 'Brass',
  vox: 'Vox',
  fx: 'FX',
  texture: 'Texture',
};

export const CHAIN_ROLE_LABELS: Record<ChainRole, string> = {
  master: 'Master',
  drumBus: 'Drum bus',
  drums: 'Drums',
  bass: 'Bass',
  lead: 'Lead',
  pad: 'Pad',
  keys: 'Keys',
  pluck: 'Pluck',
  vocal: 'Vocal',
  reverbSend: 'Reverb send',
  delaySend: 'Delay send',
  character: 'Character',
  transition: 'Transitions',
};

export const SAMPLE_KIND_LABELS: Record<SampleKind, string> = {
  kick: 'Kicks',
  snare: 'Snares',
  clap: 'Claps',
  hat: 'Hats',
  openhat: 'Open hats',
  ride: 'Rides',
  crash: 'Crashes',
  perc: 'Percussion',
  tom: 'Toms',
  rim: 'Rims',
  shaker: 'Shakers',
  snap: 'Snaps',
  '808': '808s',
  'bass-oneshot': 'Bass one-shots',
  'stab-oneshot': 'Stab one-shots',
  riser: 'Risers',
  downlifter: 'Downlifters',
  impact: 'Impacts',
  'sweep-up': 'Sweeps up',
  'sweep-down': 'Sweeps down',
  'reverse-cymbal': 'Reverse cymbals',
  'sub-drop': 'Sub drops',
  noise: 'Noise',
  texture: 'Textures',
  fill: 'Fills',
  whoosh: 'Whooshes',
  'tape-stop': 'Tape stops',
  swell: 'Swells',
  zap: 'Zaps & glitches',
  vox: 'Vocal shots',
  foley: 'Foley',
  ambience: 'Ambience',
  retro: 'Retro game',
};

export function roleLabel(role: string, kind: PresetSummary['kind'] = 'instrument'): string {
  if (kind === 'chain') return CHAIN_ROLE_LABELS[role as ChainRole] ?? role;
  return INSTRUMENT_ROLE_LABELS[role as InstrumentRole] ?? role;
}

export function sampleKindLabel(kind: string): string {
  return SAMPLE_KIND_LABELS[kind as SampleKind] ?? kind;
}

const GENRE_NAME = new Map<string, string>(GENRES.map((g) => [g.id, g.name]));

export function genreName(id: string): string {
  return GENRE_NAME.get(id) ?? id;
}

function pluginWords(plugin: string | undefined): string {
  return (plugin ?? '').replace(/^krypt\./, '').replace(/[._:-]+/g, ' ');
}

export interface PresetFilter {
  kind?: PresetSummary['kind'];
  text?: string;
  genre?: GenreId | null;
  tags?: readonly string[];
  source?: 'all' | 'factory' | 'user';
  plugin?: string | null;
}

export function searchWords(text: string | undefined): string[] {
  return (text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9#&]+/)
    .filter(Boolean);
}

function hayOf(p: PresetSummary): string {
  return [p.name, p.description, p.tags.join(' '), p.role, roleLabel(p.role, p.kind), pluginWords(p.plugin), p.genres.join(' '), p.genres.map(genreName).join(' '), p.kind === 'chain' ? 'chain effects fx' : '']
    .join(' ')
    .toLowerCase();
}

export function presetMatches(p: PresetSummary, f: PresetFilter): boolean {
  if (f.kind && p.kind !== f.kind) return false;
  if (f.source && f.source !== 'all' && p.source !== f.source) return false;
  if (f.plugin && p.plugin !== f.plugin) return false;
  if (f.genre && !p.genres.includes(f.genre)) return false;
  if (f.tags?.length) {
    const have = new Set(p.tags.map((t) => t.toLowerCase()));
    if (!f.tags.every((t) => have.has(t.toLowerCase()))) return false;
  }
  const words = searchWords(f.text);
  if (words.length) {
    const hay = hayOf(p);
    if (!words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

export function comparePresets(a: PresetSummary, b: PresetSummary): number {
  if (a.source !== b.source) return a.source === 'user' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

export interface PresetGroup {
  role: string;
  label: string;
  presets: PresetSummary[];
}

export function chainRoleOrder(isMaster: boolean): ChainRole[] {
  const rest = CHAIN_ROLES.filter((r) => r !== 'master');
  return isMaster ? ['master', ...rest] : [...rest, 'master'];
}

export function defaultRoleOrder(kind: PresetSummary['kind']): readonly string[] {
  return kind === 'chain' ? chainRoleOrder(false) : INSTRUMENT_ROLES;
}

export function groupPresets(presets: readonly PresetSummary[], f: PresetFilter, roleOrder?: readonly string[]): PresetGroup[] {
  const kind = f.kind ?? 'instrument';
  const order = roleOrder ?? defaultRoleOrder(kind);
  const by = new Map<string, PresetSummary[]>();
  for (const p of presets) {
    if (!presetMatches(p, f)) continue;
    const list = by.get(p.role) ?? [];
    list.push(p);
    by.set(p.role, list);
  }
  const rank = (r: string): number => {
    const i = order.indexOf(r);
    return i < 0 ? order.length : i;
  };
  return [...by.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([role, list]) => ({ role, label: roleLabel(role, list[0]?.kind ?? kind), presets: list.sort(comparePresets) }));
}

export function tagCounts(presets: readonly PresetSummary[]): Array<{ tag: string; count: number }> {
  const m = new Map<string, number>();
  for (const p of presets) for (const t of p.tags) m.set(t.toLowerCase(), (m.get(t.toLowerCase()) ?? 0) + 1);
  return [...m.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function cycleList(presets: readonly PresetSummary[], plugin: string): PresetSummary[] {
  return groupPresets(presets, { kind: 'instrument', plugin }).flatMap((g) => g.presets);
}

export function cyclePreset(list: readonly PresetSummary[], currentId: string | null | undefined, dir: 1 | -1): PresetSummary | null {
  const n = list.length;
  if (!n) return null;
  const i = currentId ? list.findIndex((p) => p.id === currentId) : -1;
  if (i < 0) return dir > 0 ? list[0] : list[n - 1];
  return list[(i + dir + n) % n];
}

export interface ChannelSound {
  type: string;
  params: Record<string, number>;
  samplePath: string | null;
}

function settle(v: number, s: ParamSpec | undefined): number {
  if (!s) return v;
  let x = Math.min(s.max, Math.max(s.min, v));
  if (s.step && s.step > 0) x = s.min + Math.round((x - s.min) / s.step) * s.step;
  return x;
}

export function changedParams(cur: ChannelSound, preset: InstrumentPreset, specs?: readonly ParamSpec[]): string[] {
  const out: string[] = [];
  const ids = specs ? specs.map((s) => s.id) : [...new Set([...Object.keys(cur.params), ...Object.keys(preset.params)])];
  const specById = new Map((specs ?? []).map((s) => [s.id, s]));
  for (const id of ids) {
    const s = specById.get(id);
    const a = cur.params[id] ?? s?.default;
    const b = preset.params[id] ?? s?.default;
    if (a === undefined && b === undefined) continue;
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) {
      if (a !== b) out.push(id);
      continue;
    }
    const x = settle(a, s);
    const y = settle(b, s);
    const tol = s ? Math.max(1e-6, Math.abs(s.max - s.min) * 1e-5) : Math.max(1e-6, Math.max(Math.abs(x), Math.abs(y)) * 1e-6);
    if (Math.abs(x - y) > tol) out.push(id);
  }
  return out;
}

export function isPresetModified(cur: ChannelSound, preset: InstrumentPreset, specs?: readonly ParamSpec[]): boolean {
  if (cur.type !== preset.plugin) return true;
  if (preset.sample !== undefined && cur.samplePath !== preset.sample) return true;
  return changedParams(cur, preset, specs).length > 0;
}

export function modifiedHint(cur: ChannelSound, preset: InstrumentPreset, specs?: readonly ParamSpec[]): string {
  if (cur.type !== preset.plugin) return `Changed: the instrument is no longer the one ${preset.name} uses`;
  const parts: string[] = [];
  const n = changedParams(cur, preset, specs).length;
  if (n) parts.push(`${n} setting${n === 1 ? '' : 's'}`);
  if (preset.sample !== undefined && cur.samplePath !== preset.sample) parts.push('the sample');
  return parts.length ? `Changed since you loaded ${preset.name}: ${parts.join(' and ')}. Save preset… keeps it.` : `${preset.name}, as loaded`;
}

export const PRESET_MIME = 'application/x-krypt-preset';

export interface PresetDrag {
  id: string;
  kind: PresetSummary['kind'];
  name: string;
}

export function encodePresetDrag(p: Pick<PresetSummary, 'id' | 'kind' | 'name'>): string {
  return JSON.stringify({ id: p.id, kind: p.kind, name: p.name });
}

export function decodePresetDrag(raw: string | null | undefined): PresetDrag | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<PresetDrag>;
    if (!o || typeof o.id !== 'string' || !/^(factory|user):\S+$/.test(o.id)) return null;
    if (o.kind !== 'instrument' && o.kind !== 'chain') return null;
    return { id: o.id, kind: o.kind, name: typeof o.name === 'string' && o.name ? o.name : o.id };
  } catch {
    return null;
  }
}

export function sampleDetail(s: Pick<FactorySample, 'rootNote' | 'bars'>): string {
  const parts: string[] = [];
  if (s.rootNote !== undefined && Number.isFinite(s.rootNote)) parts.push(noteName(Math.round(s.rootNote)));
  if (s.bars !== undefined && Number.isFinite(s.bars) && s.bars > 0) parts.push(`${s.bars} bar${s.bars === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export interface SampleGroup {
  kind: string;
  label: string;
  samples: FactorySample[];
}

export function sampleMatches(s: FactorySample, text: string): boolean {
  const words = searchWords(text);
  if (!words.length) return true;
  const hay = `${s.name} ${s.kind} ${sampleKindLabel(s.kind)} ${s.tags.join(' ')} ${s.genres.join(' ')} ${s.genres.map(genreName).join(' ')}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function groupFactorySamples(samples: readonly FactorySample[], text = ''): SampleGroup[] {
  const by = new Map<string, FactorySample[]>();
  for (const s of samples) {
    if (!sampleMatches(s, text)) continue;
    const list = by.get(s.kind) ?? [];
    list.push(s);
    by.set(s.kind, list);
  }
  const order: readonly string[] = SAMPLE_KINDS;
  const rank = (k: string): number => {
    const i = order.indexOf(k);
    return i < 0 ? order.length : i;
  };
  return [...by.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([kind, list]) => ({ kind, label: sampleKindLabel(kind), samples: list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.path.localeCompare(b.path)) }));
}

export function parseTagList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,;\n]+/)) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 32).trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 24) break;
  }
  return out;
}

export function validatePresetName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'The preset needs a name';
  if (n.length > 64) return 'At most 64 characters';
  return null;
}

export interface SaveDefaults {
  name: string;
  role: InstrumentRole;
  tags: string[];
  genres: GenreId[];
  description: string;
}

export function presetSaveDefaults(channelName: string, preset?: Pick<InstrumentPreset, 'id' | 'name' | 'role' | 'tags' | 'genres' | 'description'> | null): SaveDefaults {
  if (preset) {
    const mine = preset.id.startsWith('user:');
    return {
      name: (mine ? preset.name : `My ${preset.name}`).slice(0, 64),
      role: preset.role,
      tags: [...preset.tags],
      genres: [...preset.genres],
      description: preset.description,
    };
  }
  return { name: channelName.slice(0, 64), role: roleFromName(channelName) ?? 'lead', tags: [], genres: [], description: '' };
}

export function guessChainRole(insertName: string, isMaster: boolean): ChainRole {
  if (isMaster) return 'master';
  const n = insertName.toLowerCase();
  if (/\b(reverb|verb|hall|room|plate|space)\b/.test(n)) return 'reverbSend';
  if (/\b(delay|echo)\b/.test(n)) return 'delaySend';
  if (/\b(drum|drums|beat)\b.*\bbus\b|\bdrum ?bus\b|\bdrums\b/.test(n)) return 'drumBus';
  if (/\b(vocal|vocals|vox|voice|chorus vox)\b/.test(n)) return 'vocal';
  if (/\b(riser|transition|sweep|uplifter)\b/.test(n)) return 'transition';
  const role = roleFromName(insertName);
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
      return 'drums';
    case '808':
    case 'sub':
    case 'bass':
      return 'bass';
    case 'lead':
      return 'lead';
    case 'pad':
    case 'strings':
      return 'pad';
    case 'pluck':
    case 'arp':
      return 'pluck';
    case 'keys':
    case 'piano':
    case 'bell':
    case 'chord':
    case 'stab':
    case 'brass':
      return 'keys';
    case 'vox':
      return 'vocal';
    case 'fx':
      return 'transition';
    default:
      return 'character';
  }
}

export interface SoundsCounts {
  factoryPresets: number;
  userPresets: number;
  instrumentPresets: number;
  chainPresets: number;
  factorySamples: number;
}

export function soundsCounts(presets: readonly PresetSummary[], samples: readonly FactorySample[] | null): SoundsCounts {
  let factoryPresets = 0;
  let userPresets = 0;
  let instrumentPresets = 0;
  let chainPresets = 0;
  for (const p of presets) {
    if (p.source === 'user') userPresets++;
    else factoryPresets++;
    if (p.kind === 'chain') chainPresets++;
    else instrumentPresets++;
  }
  return { factoryPresets, userPresets, instrumentPresets, chainPresets, factorySamples: samples?.length ?? 0 };
}

export function folderName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function pathKey(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export function withBrowserRoot(
  roots: ReadonlyArray<{ id: string; name: string; path: string }>,
  path: string,
  id: string,
): { roots: Array<{ id: string; name: string; path: string }>; added: boolean; name: string } {
  const key = pathKey(path);
  const existing = roots.find((r) => pathKey(r.path) === key);
  if (existing) return { roots: [...roots], added: false, name: existing.name };
  const name = folderName(path);
  return { roots: [...roots, { id, name, path }], added: true, name };
}
