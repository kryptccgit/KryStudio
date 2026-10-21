import fs from 'node:fs';
import path from 'node:path';
import type { Patch } from 'immer';
import type { Channel, MixerInsert, Pattern, Project } from '@shared/schema/project';
import type { ParamSpec, PluginCatalog, PluginDescriptor } from '@shared/plugins/types';
import { formatParam } from '@shared/plugins/types';
import { ticksPerBar, PPQ, type TimeSig } from '@shared/schema/time';
import { fail, type ToolCaller } from './types';
import type { MainDeps } from '../types';
import type { FileAccessMode, Settings } from '@shared/types';
import { AUDIO_FILE_RE } from '@shared/audio/formats';
import { packById } from '@shared/packs/catalog';
import { parsePackPath, PACK_SCHEME } from '@shared/packs/types';

export function safeName(s: string | null | undefined, max = 80): string {
  const clean = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9#]/g, '');
}

export function plural(n: number, w: string, pl = `${w}s`): string {
  return `${n} ${n === 1 ? w : pl}`;
}

function listNames(names: string[], max = 12): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown}, … (+${names.length - max})` : shown || '(none)';
}

export function gainToDb(g: number): number {
  return g <= 0 ? -Infinity : 20 * Math.log10(g);
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function fmtDb(g: number): string {
  const db = gainToDb(g);
  return db === -Infinity ? '-inf dB' : `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function fmtPan(p: number): string {
  if (Math.abs(p) < 0.005) return 'C';
  return `${Math.round(Math.abs(p) * 100)}${p < 0 ? 'L' : 'R'}`;
}

export function barTicksOf(p: Project): number {
  return ticksPerBar(p.transport.timeSig);
}

export function parsePosition(v: string | number, ts: TimeSig): number {
  const bar = ticksPerBar(ts);
  const step = PPQ / 4;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 1) fail(`bar ${v} must be >= 1 (bars are 1-based)`);
    return Math.round((v - 1) * bar);
  }
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(v);
  if (!m) fail(`position "${v}" must be "bar" or "bar.step" (1-based, 16th steps), e.g. "9" or "9.5"`);
  const b = Number(m[1]);
  const s = m[2] ? Number(m[2]) : 1;
  if (b < 1 || s < 1) fail(`position "${v}" is 1-based (bar >= 1, step >= 1)`);
  return (b - 1) * bar + (s - 1) * step;
}

export function parseBarRange(v: string, ts: TimeSig): { start: number; end: number; bars: number } {
  const bar = ticksPerBar(ts);
  const m = /^\s*(\d+)\s*(?:[-–:]\s*(\d+))?\s*$/.exec(v);
  if (!m) fail(`bar range "${v}" must look like "17-24" (inclusive, 1-based) or "5"`);
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (a < 1 || b < a) fail(`bar range "${v}" must be ascending and start at 1 or later`);
  return { start: (a - 1) * bar, end: b * bar, bars: b - a + 1 };
}

export function fmtPos(tick: number, ts: TimeSig): string {
  const bar = ticksPerBar(ts);
  const b = Math.floor(tick / bar) + 1;
  const rem = tick - (b - 1) * bar;
  const step = rem / (PPQ / 4) + 1;
  return Number.isInteger(step) ? (step === 1 ? `${b}` : `${b}.${step}`) : `${b}.${step.toFixed(2)}`;
}

export function fmtBars(ticks: number, ts: TimeSig): string {
  const b = ticks / ticksPerBar(ts);
  return Number.isInteger(b) ? plural(b, 'bar') : `${round(b, 2)} bars`;
}

const PLUGIN_ALIASES: Record<string, string> = {
  synth: 'krypt.triosc',
  triosc: 'krypt.triosc',
  osc: 'krypt.triosc',
  sampler: 'krypt.sampler',
  sample: 'krypt.sampler',
  '808': 'krypt.kick808',
  kick808: 'krypt.kick808',
  drumsynth: 'krypt.drumsynth',
  drum: 'krypt.drumsynth',
  drums: 'krypt.drumsynth',
  eq: 'krypt.eq',
  equalizer: 'krypt.eq',
  comp: 'krypt.comp',
  compressor: 'krypt.comp',
  limiter: 'krypt.limiter',
  clipper: 'krypt.clipper',
  reverb: 'krypt.reverb',
  verb: 'krypt.reverb',
  delay: 'krypt.delay',
  echo: 'krypt.delay',
  drive: 'krypt.drive',
  distortion: 'krypt.drive',
  saturation: 'krypt.drive',
  saturator: 'krypt.drive',
  bitcrusher: 'krypt.drive',
  filter: 'krypt.filter',
  duck: 'krypt.duck',
  ducker: 'krypt.duck',
  sidechain: 'krypt.duck',
  utility: 'krypt.utility',
  gain: 'krypt.utility',
  analyzer: 'krypt.analyzer',
  audioclip: 'krypt.audioclip',
  tapedelay: 'krypt.tapeecho',
  tapeecho: 'krypt.tapeecho',
  multibandsaturator: 'krypt.heat',
  multibanddistortion: 'krypt.heat',
  granular: 'krypt.grain',
  granulardelay: 'krypt.grain',
  spectral: 'krypt.grain',
  buscompressor: 'krypt.glue',
  buscomp: 'krypt.glue',
  gluecompressor: 'krypt.glue',
  gate: 'krypt.gate',
  gatetime: 'krypt.gate',
  timegate: 'krypt.gate',
  stutter: 'krypt.gate',
  glitch: 'krypt.gate',
  halftime: 'krypt.gate',
  tapestop: 'krypt.gate',
  trancegate: 'krypt.gate',
  deesser: 'krypt.deesser',
  deess: 'krypt.deesser',
  sibilance: 'krypt.deesser',
  rack: 'krypt.rack',
  instrumentrack: 'krypt.rack',
  drumrack: 'krypt.drumrack',
  slicer: 'krypt.slicer',
  loopslicer: 'krypt.slicer',
  chopper: 'krypt.slicer',
  chop: 'krypt.slicer',
  fxrack: 'krypt.fxrack',
  effectrack: 'krypt.fxrack',
};

export function findPluginRef(catalog: PluginCatalog, ref: string, kind?: 'instrument' | 'effect'): PluginDescriptor {
  const n = norm(ref);
  const pool = catalog.plugins.filter((p) => !kind || p.kind === kind);
  const hit =
    pool.find((p) => p.id === ref) ??
    pool.find((p) => norm(p.id) === n || norm(p.id.replace(/^krypt\./, '')) === n) ??
    pool.find((p) => norm(p.name) === n || norm(p.name.replace(/^Krypt /, '')) === n) ??
    pool.find((p) => p.id === PLUGIN_ALIASES[n]);
  if (!hit) fail(`Unknown ${kind ?? 'plugin'} "${safeName(ref)}". Available: ${listNames(pool.map((p) => p.id))}`);
  return hit;
}

export function pluginName(catalog: PluginCatalog, id: string): string {
  return catalog.plugins.find((p) => p.id === id)?.name ?? id;
}

export function parseParamValue(spec: ParamSpec, v: number | string | boolean): number {
  if (typeof v === 'boolean') return v ? Math.min(spec.max, Math.max(spec.min, 1)) : spec.min;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`${spec.name}: value must be a finite number`);
    return v;
  }
  const s = v.trim();
  if (spec.options) {
    const i = spec.options.findIndex((o) => o.toLowerCase() === s.toLowerCase());
    if (i >= 0) return i;
  }
  if (/^(on|true|yes)$/i.test(s)) return Math.min(spec.max, Math.max(spec.min, 1));
  if (/^(off|false|no)$/i.test(s)) return spec.min;
  const m = /^([+-]?\d*\.?\d+)\s*(khz|hz|db|ms|s|st|semitones?|ct|cents?|%|x|bpm|deg)?$/i.exec(s);
  if (!m) {
    const hint = spec.options ? `one of ${spec.options.join(', ')}` : `a number in ${spec.unit || 'plain units'} (${spec.min}..${spec.max})`;
    fail(`${spec.name}: can't read "${safeName(s, 30)}" — use ${hint}`);
  }
  const x = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  switch (unit) {
    case 'khz':
      return x * 1000;
    case 'hz':
      return x;
    case 'db':
      if (spec.scale === 'gain') return dbToGain(x);
      return x;
    case 'ms':
      return spec.unit === 's' ? x / 1000 : x;
    case 's':
      return spec.unit === 'ms' ? x * 1000 : x;
    case '%':
      if (spec.unit === '%' || (spec.min >= -1 && spec.max <= 2)) return x / 100;
      return spec.min + ((spec.max - spec.min) * x) / 100;
    default:
      return x;
  }
}

export function describeValue(spec: ParamSpec, v: number): string {
  return formatParam(spec, v);
}

const CHANNEL_ALIASES: string[][] = [
  ['kick', 'bd', 'bassdrum', 'kickdrum'],
  ['snare', 'sd', 'snr'],
  ['clap', 'cp', 'handclap', 'claps'],
  ['hat', 'hh', 'hihat', 'closedhat', 'chh', 'hats', 'closedhihat', 'hihats'],
  ['openhat', 'oh', 'ohh', 'openhihat'],
  ['808', 'bass808', 'sub808', '808bass', '808s'],
];

function aliasGroup(n: string): string[] | undefined {
  return CHANNEL_ALIASES.find((g) => g.includes(n));
}

export function tryFindChannel(p: Project, ref: string): { id: string } | { ambiguous: string[] } | null {
  if (p.channels[ref]) return { id: ref };
  const chans = p.channelOrder.map((id) => p.channels[id]);
  const exact = chans.filter((c) => c.name.toLowerCase() === ref.toLowerCase().trim());
  if (exact.length === 1) return { id: exact[0].id };
  if (exact.length > 1) return { ambiguous: exact.map((c) => `${c.name} (${c.id})`) };
  const n = norm(ref.replace(/^ch:/i, ''));
  if (!n) return null;
  const loose = chans.filter((c) => norm(c.name) === n);
  if (loose.length === 1) return { id: loose[0].id };
  if (loose.length > 1) return { ambiguous: loose.map((c) => `${c.name} (${c.id})`) };
  const g = aliasGroup(n);
  if (g) {
    const al = chans.filter((c) => g.includes(norm(c.name)));
    if (al.length === 1) return { id: al[0].id };
  }
  return null;
}

export function findChannel(p: Project, ref: string): Channel {
  const r = tryFindChannel(p, ref);
  if (r && 'id' in r) return p.channels[r.id];
  if (r && 'ambiguous' in r) fail(`"${safeName(ref)}" matches several channels: ${r.ambiguous.join(', ')}. Use the id.`);
  fail(`No channel "${safeName(ref)}". Channels: ${listNames(p.channelOrder.map((id) => safeName(p.channels[id].name)))}`);
}

export function findPattern(p: Project, ref: string | null | undefined): Pattern {
  if (ref === undefined || ref === null || ref === '' || /^(active|current|selected)$/i.test(ref)) {
    const id = p.transport.activePatternId;
    if (id && p.patterns[id]) return p.patterns[id];
    return p.patterns[p.patternOrder[0]];
  }
  if (p.patterns[ref]) return p.patterns[ref];
  const pats = p.patternOrder.map((id) => p.patterns[id]);
  const exact = pats.filter((x) => x.name.toLowerCase() === ref.toLowerCase().trim());
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) fail(`"${safeName(ref)}" matches several patterns: ${exact.map((x) => x.id).join(', ')}. Use the id.`);
  const n = norm(ref);
  const loose = pats.filter((x) => norm(x.name) === n);
  if (loose.length === 1) return loose[0];
  fail(`No pattern "${safeName(ref)}". Patterns: ${listNames(pats.map((x) => safeName(x.name)))}`);
}

export function tryFindPattern(p: Project, ref: string): Pattern | null {
  try {
    return findPattern(p, ref);
  } catch {
    return null;
  }
}

export function findInsert(p: Project, ref: string | number): MixerInsert {
  const ins = p.mixer.inserts;
  const asText = String(ref).trim();
  if (typeof ref === 'string') {
    const byName = p.mixer.insertOrder.filter((id) => ins[id].name.toLowerCase() === asText.toLowerCase());
    if (byName.length === 1) return ins[byName[0]];
    if (/^\d+$/.test(asText)) {
      const ch = tryFindChannel(p, asText);
      if (ch && 'id' in ch) return ins[p.channels[ch.id].insertId];
    }
  }
  if (typeof ref === 'number' || /^\d+$/.test(asText)) {
    const i = Number(ref);
    const id = p.mixer.insertOrder[i];
    if (id) return ins[id];
    fail(`Mixer index ${i} doesn't exist (0 = master, 1..${p.mixer.insertOrder.length - 1})`);
  }
  const r = String(ref).trim();
  if (ins[r]) return ins[r];
  if (/^(master|main|mst)$/i.test(r)) return ins[p.mixer.masterId];
  const list = p.mixer.insertOrder.map((id) => ins[id]);
  const exact = list.filter((x) => x.name.toLowerCase() === r.toLowerCase());
  if (exact.length === 1) return exact[0];
  const ch = tryFindChannel(p, r);
  if (ch && 'id' in ch) return ins[p.channels[ch.id].insertId];
  const n = norm(r);
  const loose = list.filter((x) => norm(x.name) === n);
  if (loose.length === 1) return loose[0];
  fail(`No mixer insert "${safeName(r)}". Inserts: ${listNames(list.map((x) => safeName(x.name)))} (or a channel name)`);
}

export function findTrack(p: Project, ref: string | number | undefined): string {
  const order = p.playlist.trackOrder;
  if (ref === undefined) fail('track is required');
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const i = Number(ref) - 1;
    if (order[i]) return order[i];
    fail(`Playlist track ${ref} doesn't exist (1..${order.length})`);
  }
  const r = String(ref);
  if (p.playlist.tracks[r]) return r;
  const hit = order.filter((id) => p.playlist.tracks[id].name.toLowerCase() === r.toLowerCase());
  if (hit.length === 1) return hit[0];
  fail(`No playlist track "${safeName(r)}" (use a 1-based number or a track name)`);
}

export function findSlot(ins: MixerInsert, ref: string | number, catalog: PluginCatalog): string {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const i = Number(ref) - 1;
    const id = ins.slotOrder[i];
    if (id) return id;
    fail(`${safeName(ins.name)} has ${plural(ins.slotOrder.length, 'effect')}; slot ${ref} doesn't exist (1-based)`);
  }
  const r = String(ref);
  if (ins.slots[r]) return r;
  let type: string | null = null;
  try {
    type = findPluginRef(catalog, r, 'effect').id;
  } catch {
    type = null;
  }
  const hit = ins.slotOrder.find((s) => ins.slots[s].type === type);
  if (hit) return hit;
  fail(`No effect "${safeName(r)}" on ${safeName(ins.name)}. Chain: ${listNames(ins.slotOrder.map((s, i) => `${i + 1}. ${pluginName(catalog, ins.slots[s].type)}`))}`);
}

export function idsFromPatches(patches: Patch[]): string[] {
  const out = new Set<string>();
  for (const p of patches) {
    const [a, b, c, d, e] = p.path.map(String);
    switch (a) {
      case 'channels':
        if (b) out.add(b);
        break;
      case 'patterns':
        if (b) out.add(b);
        break;
      case 'playlist':
        if ((b === 'clips' || b === 'tracks' || b === 'markers') && c) out.add(c);
        break;
      case 'automations':
        if (b) out.add(b);
        break;
      case 'mixer':
        if (b === 'inserts' && c) out.add(d === 'slots' && e ? e : c);
        break;
      case 'samples':
        if (b) out.add(b);
        break;
      case 'transport':
        out.add('transport');
        break;
      case 'meta':
        out.add('meta');
        break;
      case 'session':
        out.add((b === 'scenes' || b === 'clips') && c ? c : 'session');
        break;
      case 'scripts':
      case 'takeGroups':
        out.add(b || a);
        break;
      default:
        break;
    }
  }
  return [...out];
}

const KIND_BY_PREFIX: Record<string, string> = {
  ch: 'channel',
  pat: 'pattern',
  clip: 'clip',
  trk: 'track',
  ins: 'insert',
  fx: 'effect',
  smp: 'sample',
  aut: 'automation',
  mk: 'marker',
  scn: 'scene',
  lc: 'launchClip',
};

export function touchedFromIds(ids: string[]): Array<{ kind: string; id: string }> {
  return ids.map((id) => ({ kind: KIND_BY_PREFIX[id.split('_')[0]] ?? id, id }));
}

export const AUDIO_EXT = AUDIO_FILE_RE;
export const IMAGE_EXT = /\.(png|jpe?g)$/i;
export const MIDI_EXT = /\.(mid|midi|smf)$/i;

export type UserPathKind = 'audio' | 'folder' | 'audio-or-folder' | 'image' | 'midi';

export interface PathGrants {
  granted(real: string, isDir: boolean): boolean;
}

export function fileAccessMode(settings: Pick<Settings, 'mcp'>, via?: ToolCaller['via']): FileAccessMode {
  const m = settings.mcp.fileAccess ?? 'anywhere';
  return via === 'http' && m === 'anywhere' ? 'ask' : m;
}

export interface PathAccess {
  mode: FileAccessMode;
  roots: string[];
  grants?: PathGrants;
  projectFiles: string[];
}

export function projectFilePaths(deps: Pick<MainDeps, 'doc' | 'project'>): string[] {
  const out: string[] = [];
  for (const s of Object.values(deps.doc.project.samples)) {
    if (!s.path || s.path.startsWith('factory:')) continue;
    try {
      out.push(deps.project.resolveSamplePath(s.path));
    } catch {
    }
  }
  return out;
}

export function pathAccess(deps: MainDeps, caller?: Pick<ToolCaller, 'via'>): PathAccess {
  return { mode: fileAccessMode(deps.getSettings(), caller?.via), roots: deps.project.allowedRoots(), grants: deps.consent, projectFiles: projectFilePaths(deps) };
}

function toAccess(a: PathAccess | string[], grants?: PathGrants): PathAccess {
  return Array.isArray(a) ? { mode: grants ? 'ask' : 'browser', roots: a, grants, projectFiles: [] } : a;
}

const keyOf = (p: string): string => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');

function realKey(p: string): string | null {
  try {
    return keyOf(fs.realpathSync.native(p));
  } catch {
    return null;
  }
}

export function isProjectFile(real: string, files: string[]): boolean {
  if (!files.length) return false;
  const k = keyOf(real);
  for (const f of files) if (keyOf(f) === k || realKey(f) === k) return true;
  return false;
}

export function isDriveRoot(p: string): boolean {
  const r = path.resolve(p);
  return r.toLowerCase() === path.parse(r).root.toLowerCase();
}

export function accessAllows(acc: PathAccess, real: string, isDir: boolean): boolean {
  if (insideRoots(real, acc.roots, isDir)) return true;
  if (!isDir && isProjectFile(real, acc.projectFiles)) return true;
  if (acc.mode === 'anywhere') return !(isDir && isDriveRoot(real));
  if (acc.mode === 'ask') return !!acc.grants?.granted(real, isDir);
  return false;
}

export function outsideMessage(input: string, acc: PathAccess, what: 'file' | 'folder' = 'file'): string {
  const roots = acc.roots.length ? acc.roots.map((r) => safeName(r, 120)).join('; ') : 'none added yet';
  const setting = acc.mode === 'browser' ? ' (Settings ▸ Agents ▸ File access is set to "Browser folders only")' : '';
  return `"${safeName(input, 200)}" is outside the folders Krypt Studio lets agents read${setting}. Allowed: the factory kit, the files this project already uses, and the Browser folders (${roots}). Ask the user to add its ${what === 'folder' ? 'parent folder' : 'folder'} in the Browser panel${acc.mode === 'browser' ? ', or to set File access to "Anywhere" or "Ask me" in Settings ▸ Agents' : ''}.`;
}

export function unquotePath(s: string): string {
  const t = s.trim();
  const m = /^(["'“‘])(.*)(["'”’])$/.exec(t);
  return (m ? m[2] : t).trim();
}

export function looksLikePath(s: string): boolean {
  const t = unquotePath(s);
  return /^[A-Za-z]:[\\/]/.test(t) || /^[\\/]{2}/.test(t) || t.startsWith('factory:');
}

function isNetworkPath(s: string): boolean {
  return /^[\\/]{2}/.test(s);
}

export function realUserPath(input: string, kind: UserPathKind): { real: string; isDir: boolean } {
  const s = unquotePath(input);
  const what = kind === 'folder' ? 'folder' : 'file';
  if (isNetworkPath(s)) fail(`Network (UNC) and device paths are not allowed; use a local ${what} on this PC (opening a \\\\host\\share path would send your Windows login to that host)`);
  if (kind === 'image' || kind === 'midi') return realTypedFile(s, kind);
  if (!/^[A-Za-z]:[\\/]/.test(s)) fail(kind === 'folder' ? 'folder must be an absolute path, e.g. C:\\Music\\Dark Trap' : `Paths must be absolute (C:\\...\\kick.wav)${kind === 'audio' ? ' or "factory:drums/kick.wav"' : ''}`);
  if (s.slice(2).includes(':')) fail('Alternate data streams (file:stream) are not allowed');
  const wantsAudio = kind === 'audio' || (kind === 'audio-or-folder' && AUDIO_EXT.test(s));
  if (kind === 'audio' && !AUDIO_EXT.test(s)) fail(`"${safeName(path.basename(s))}" is not an audio file (wav, aiff, flac, mp3, ogg, m4a …)`);
  let real: string;
  try {
    real = fs.realpathSync.native(s);
  } catch {
    fail(`${kind === 'folder' ? 'Folder' : 'File'} not found: ${safeName(s, 200)}`);
  }
  if (isNetworkPath(real) || !/^[A-Za-z]:[\\/]/.test(real)) fail(`"${safeName(s, 200)}" leads to a network or device location, which agents can't read`);
  let isDir = false;
  try {
    isDir = fs.statSync(real).isDirectory();
  } catch {
    fail(`${kind === 'folder' ? 'Folder' : 'File'} not found: ${safeName(s, 200)}`);
  }
  if (kind === 'folder' && !isDir) fail(`Not a folder: ${safeName(s, 200)}`);
  if (wantsAudio) {
    if (isDir) fail(`Not a file: ${safeName(s, 200)}`);
    if (!AUDIO_EXT.test(real)) fail(`"${safeName(path.basename(s))}" is not an audio file (wav, aiff, flac, mp3, ogg, m4a …)`);
  } else if (kind === 'audio-or-folder' && !isDir) fail(`"${safeName(path.basename(s))}" is not an audio file or a folder`);
  return { real, isDir };
}

function realTypedFile(s: string, kind: 'image' | 'midi'): { real: string; isDir: boolean } {
  const ext = kind === 'image' ? IMAGE_EXT : MIDI_EXT;
  const notType = (p: string) => `"${safeName(path.basename(p))}" is not ${kind === 'image' ? 'a PNG or JPEG image' : 'a MIDI file (.mid)'}`;
  if (!/^[A-Za-z]:[\\/]/.test(s)) fail(kind === 'image' ? 'The image path must be absolute, e.g. C:\\Users\\me\\Pictures\\cover.jpg' : 'The MIDI file path must be absolute, e.g. C:\\Users\\me\\Music\\hook.mid');
  if (s.slice(2).includes(':')) fail('Alternate data streams (file:stream) are not allowed');
  if (!ext.test(s)) fail(notType(s));
  let real: string;
  try {
    real = fs.realpathSync.native(s);
  } catch {
    fail(`File not found: ${safeName(s, 200)}`);
  }
  if (isNetworkPath(real) || !/^[A-Za-z]:[\\/]/.test(real)) fail(`"${safeName(s, 200)}" leads to a network or device location, which agents can't read`);
  if (!ext.test(real)) fail(notType(s));
  let isFile = false;
  try {
    isFile = fs.statSync(real).isFile();
  } catch {
    fail(`File not found: ${safeName(s, 200)}`);
  }
  if (!isFile) fail(`Not a file: ${safeName(s, 200)}`);
  return { real, isDir: false };
}

export function insideRoots(real: string, roots: string[], allowRoot = false): boolean {
  return roots.some((root) => {
    let r: string;
    try {
      r = fs.realpathSync.native(root);
    } catch {
      return false;
    }
    const rel = path.relative(r.toLowerCase(), real.toLowerCase());
    return (rel === '' ? allowRoot : !rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

export function checkSamplePath(input: string, access: PathAccess | string[], resolveFactory: (p: string) => string, grants?: PathGrants): { docPath: string; abs: string } {
  const s = unquotePath(input);
  if (s.startsWith('factory:')) {
    const rel = s.slice('factory:'.length);
    if (!/^[\w\-./ ]+$/.test(rel) || rel.split(/[\\/]/).some((seg) => seg === '..') || rel.startsWith('/')) fail(`"${safeName(s)}" is not a valid factory sample path`);
    if (!AUDIO_EXT.test(rel)) fail(`"${safeName(s)}" is not an audio file (wav, aiff, flac, mp3, ogg)`);
    const abs = resolveFactory(s);
    if (abs && fs.existsSync(abs) === false) fail(`Factory sample "${safeName(s)}" doesn't exist. Use find_samples to list the factory kit.`);
    return { docPath: s, abs };
  }
  if (s.startsWith(PACK_SCHEME)) {
    const pp = parsePackPath(s);
    if (!pp) fail(`"${safeName(s)}" is not a valid sound-pack sample path (pack:<pack>/<file>)`);
    if (!AUDIO_EXT.test(pp.path)) fail(`"${safeName(s)}" is not an audio file (wav, aiff, flac, mp3, ogg)`);
    const abs = resolveFactory(s);
    if (!abs || !fs.existsSync(abs)) {
      const name = packById(pp.packId)?.name;
      fail(
        name
          ? `"${safeName(s)}" isn't on this PC: it needs the ${safeName(name, 60)} sound pack, which the user downloads in Home ▸ Sounds (you can't). Use find_samples for sounds that are installed.`
          : `There's no sound pack "${safeName(pp.packId, 40)}". Use find_samples for the installed sounds.`,
      );
    }
    return { docPath: s, abs };
  }
  const { real } = realUserPath(s, 'audio');
  const acc = toAccess(access, grants);
  if (!accessAllows(acc, real, false)) fail(outsideMessage(s, acc));
  return { docPath: real, abs: real };
}

export function agentSamplePath(deps: MainDeps, input: string, caller?: Pick<ToolCaller, 'via'>): { docPath: string; abs: string } {
  return checkSamplePath(input, pathAccess(deps, caller), (s) => deps.project.resolveSamplePath(s));
}

export function agentImagePath(deps: MainDeps, input: string, caller?: Pick<ToolCaller, 'via'>): string {
  const s = unquotePath(input);
  const { real } = realUserPath(s, 'image');
  const acc = pathAccess(deps, caller);
  if (!accessAllows(acc, real, false)) fail(outsideMessage(s, acc));
  return real;
}

export function agentMidiPath(deps: MainDeps, input: string, caller?: Pick<ToolCaller, 'via'>): string {
  const s = unquotePath(input);
  const { real } = realUserPath(s, 'midi');
  const acc = pathAccess(deps, caller);
  if (!accessAllows(acc, real, false)) fail(outsideMessage(s, acc));
  return real;
}

export { toAccess };
