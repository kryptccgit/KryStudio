import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { USER, type DocHost } from '@shared/doc/DocHost';
import type { ActionResult, SavePresetMeta, Settings, SoundsState } from '@shared/types';
import { zPreset } from '@shared/sounds/schema';
import { CHAIN_ROLES, INSTRUMENT_ROLES, summarizePreset, type ChainPreset, type ChainRole, type FactoryIndex, type FactorySample, type InstrumentPreset, type InstrumentRole, type Preset, type PresetSummary } from '@shared/sounds/types';
import { GENRE_IDS, resolveGenre, type GenreId } from '@shared/sounds/genres';
import { FACTORY_PRESETS } from '@shared/sounds/factory';
import { chainFromInsert, cleanTags, presetFromChannel, presetSlug } from '@shared/sounds/capture';
import { isAudioFile } from '@shared/audio/formats';
import { parsePackPath, type PackSample } from '@shared/packs/types';
import { describeFsError, ensureDir, writeFileAtomicSync } from '../system/files';
import { factoryIndexReader, type IndexReader } from './factoryIndex';
import type { SoundsAccess } from './types';

export interface SoundsServiceDeps {
  doc: Pick<DocHost, 'project' | 'catalog' | 'exec'>;
  userDataDir: string;
  factoryDir: string;
  getSettings(): Pick<Settings, 'browserRoots'>;
  broadcast(state: SoundsState): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  packSamples?: () => readonly PackSample[];
  factoryPresets?: readonly Preset[];
  profileDirs?: () => string[];
  now?: () => number;
}

export interface SampleFolderSuggestion {
  path: string;
  audioFiles: number;
  inBrowser: boolean;
}

const SAMPLE_DIR_RE = /(sample|pack|kit|loop|one[\s_-]?shot|drum|808|sounds?\b|stems?\b|splice|producer|beats?\b)/i;
const KNOWN_LIBRARY_DIRS = [
  ['Documents', 'Samples'],
  ['Music', 'Samples'],
  ['Desktop', 'Samples'],
  ['Documents', 'Splice', 'Samples'],
  ['Music', 'Splice', 'Samples'],
];
const SKIP_DIR = /^(\.|\$|node_modules$|appdata$|system volume information$|windows$|program files)/i;
const MIN_AUDIO_FILES = 20;
const SCAN_BUDGET_MS = 2000;
const COUNT_CAP = 10_000;
const MAX_SUGGESTIONS = 12;
const USER_RESCAN_MS = 1000;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function fileStem(id: string): string {
  return id.replace(/^user:/, '').replace(/\//g, '.');
}

function cleanName(s: unknown, max = 64): string {
  const c = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return c.length > max ? c.slice(0, max).trim() : c;
}

export function cleanMeta(raw: unknown): SavePresetMeta & { role?: string; withFx?: boolean; author?: string; targetLufs?: number } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const genres: GenreId[] = [];
  for (const g of Array.isArray(o.genres) ? o.genres : []) {
    const id = typeof g === 'string' ? ((GENRE_IDS as readonly string[]).includes(g) ? (g as GenreId) : resolveGenre(g)) : null;
    if (id && !genres.includes(id)) genres.push(id);
  }
  return {
    name: cleanName(o.name),
    tags: cleanTags(Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : []),
    genres,
    description: typeof o.description === 'string' ? cleanName(o.description, 300) : undefined,
    role: typeof o.role === 'string' ? o.role : undefined,
    withFx: typeof o.withFx === 'boolean' ? o.withFx : undefined,
    author: typeof o.author === 'string' && o.author.trim() ? cleanName(o.author, 64) : undefined,
    targetLufs: typeof o.targetLufs === 'number' && Number.isFinite(o.targetLufs) ? Math.min(-3, Math.max(-30, o.targetLufs)) : undefined,
  };
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function inside(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export class SoundsService implements SoundsAccess {
  private readonly factory: readonly Preset[];
  private readonly factoryById: Map<string, Preset>;
  private user = new Map<string, { preset: Preset; file: string }>();
  private userSig = '';
  private lastUserCheck = -Infinity;
  private all: Preset[] | null = null;
  private readonly index: IndexReader;
  private readonly now: () => number;

  constructor(private readonly deps: SoundsServiceDeps) {
    this.factory = deps.factoryPresets ?? FACTORY_PRESETS;
    this.factoryById = new Map(this.factory.map((p) => [p.id, p]));
    this.now = deps.now ?? (() => Date.now());
    this.index = factoryIndexReader(deps.factoryDir, (level, m) => deps.log(level, m));
    this.refreshUser(true);
  }

  presets(): readonly Preset[] {
    this.refreshUser();
    if (!this.all) this.all = [...this.factory, ...[...this.user.values()].map((u) => u.preset)];
    return this.all;
  }

  preset(id: string): Preset | undefined {
    this.refreshUser();
    return this.factoryById.get(id) ?? this.user.get(id)?.preset;
  }

  factoryIndex(): FactoryIndex | null {
    const factory = this.index.read();
    let packs: readonly PackSample[] = [];
    try {
      packs = this.deps.packSamples?.() ?? [];
    } catch (e) {
      this.deps.log('warn', `[sounds] couldn't list the sound packs' samples: ${errText(e)}`);
    }
    if (!packs.length) return factory;
    const seen = new Set((factory?.samples ?? []).map((x) => x.path));
    const extra: FactorySample[] = [];
    for (const x of packs) {
      if (seen.has(x.path)) continue;
      seen.add(x.path);
      extra.push(x);
    }
    if (!extra.length) return factory;
    return { version: 1, generator: factory?.generator ?? 'sound packs', samples: [...(factory?.samples ?? []), ...extra] };
  }

  saveUser(p: InstrumentPreset | ChainPreset): ActionResult<PresetSummary> {
    const name = cleanName(p?.name);
    if (!name) return { ok: false, message: 'Give the preset a name.' };
    this.refreshUser();
    const slug = presetSlug(name);
    const prefix = p.kind === 'chain' ? 'user:chain/' : 'user:';
    let id = `${prefix}${slug}`;
    for (let n = 2; this.user.has(id) || fs.existsSync(this.fileFor(id)); n++) id = `${prefix}${slug.slice(0, 44)}-${n}`;
    const packId = p.kind === 'instrument' && !p.requires && p.sample ? parsePackPath(p.sample)?.packId : undefined;
    const candidate = { ...p, id, name, ...(packId ? { requires: packId } : {}) };
    const v = zPreset.safeParse(candidate);
    if (!v.success) {
      const i = v.error.issues[0];
      return { ok: false, message: `Couldn't save "${name}": ${i?.path.length ? `${i.path.join('.')}: ` : ''}${i?.message ?? 'invalid preset'}.` };
    }
    const file = this.fileFor(id);
    try {
      writeFileAtomicSync(file, `${JSON.stringify(v.data, null, 2)}\n`);
    } catch (e) {
      return { ok: false, message: `Couldn't save "${name}": ${describeFsError(e, file)}` };
    }
    this.user.set(id, { preset: v.data as Preset, file });
    this.changed();
    const what = p.kind === 'chain' ? 'chain preset' : 'preset';
    return { ok: true, message: `Saved ${what} "${name}" to your presets.`, data: summarizePreset(v.data as Preset) };
  }

  deleteUser(id: string): ActionResult {
    if (this.factoryById.has(id)) return { ok: false, message: "Factory presets can't be deleted." };
    this.refreshUser();
    const u = this.user.get(id);
    if (!u) return { ok: false, message: 'That preset is no longer in your presets.' };
    try {
      fs.rmSync(u.file, { force: true });
    } catch (e) {
      return { ok: false, message: `Couldn't delete "${u.preset.name}": ${describeFsError(e, u.file)}` };
    }
    this.user.delete(id);
    this.changed();
    return { ok: true, message: `Deleted preset "${u.preset.name}".` };
  }

  state(): SoundsState {
    const presets = this.presets();
    return { presets: presets.map(summarizePreset), factoryCount: this.factory.length, userCount: this.user.size, userDir: this.userDir() };
  }

  get(id: string): ActionResult<Preset> {
    const p = this.preset(String(id ?? ''));
    return p ? { ok: true, data: p } : { ok: false, message: 'That preset no longer exists.' };
  }

  saveChannel(channelId: string, rawMeta: unknown): ActionResult<PresetSummary> {
    const meta = cleanMeta(rawMeta);
    const ch = this.deps.doc.project.channels[channelId];
    if (!ch) return { ok: false, message: 'That channel no longer exists.' };
    if (meta.role !== undefined && !(INSTRUMENT_ROLES as readonly string[]).includes(meta.role)) {
      return { ok: false, message: `"${cleanName(meta.role, 20)}" isn't an instrument role. Use one of: ${INSTRUMENT_ROLES.join(', ')}.` };
    }
    let preset: InstrumentPreset;
    try {
      preset = presetFromChannel(this.deps.doc.project, this.deps.doc.catalog, channelId, {
        ...meta,
        name: meta.name || ch.name,
        role: meta.role as InstrumentRole | undefined,
      });
    } catch (e) {
      return { ok: false, message: errText(e) };
    }
    const r = this.saveUser(preset);
    if (r.ok && r.data) {
      const m = this.deps.doc.exec('presets.markChannel', { channelId, preset: { id: r.data.id, name: r.data.name } }, { actor: USER });
      if (!m.ok) this.deps.log('warn', `[sounds] saved "${r.data.name}" but couldn't label the channel with it: ${m.message}`);
    }
    return r;
  }

  saveChain(insertId: string, rawMeta: unknown): ActionResult<PresetSummary> {
    const meta = cleanMeta(rawMeta);
    const p = this.deps.doc.project;
    const ins = p.mixer.inserts[insertId === 'master' ? p.mixer.masterId : insertId];
    if (!ins) return { ok: false, message: 'That mixer insert no longer exists.' };
    if (meta.role !== undefined && !(CHAIN_ROLES as readonly string[]).includes(meta.role)) {
      return { ok: false, message: `"${cleanName(meta.role, 20)}" isn't a chain role. Use one of: ${CHAIN_ROLES.join(', ')}.` };
    }
    let preset: ChainPreset;
    try {
      preset = chainFromInsert(p, this.deps.doc.catalog, ins.id, { ...meta, name: meta.name || (ins.isMaster ? 'Master chain' : ins.name), role: meta.role as ChainRole | undefined });
    } catch (e) {
      return { ok: false, message: errText(e) };
    }
    return this.saveUser(preset);
  }

  renameUser(id: string, rawName: unknown): ActionResult<PresetSummary> {
    if (this.factoryById.has(id)) return { ok: false, message: "Factory presets can't be renamed; save a copy under your own name instead." };
    this.refreshUser();
    const u = this.user.get(id);
    if (!u) return { ok: false, message: 'That preset is no longer in your presets.' };
    const name = cleanName(rawName);
    if (!name) return { ok: false, message: 'Give the preset a name.' };
    const next = { ...u.preset, name } as Preset;
    try {
      writeFileAtomicSync(u.file, `${JSON.stringify(next, null, 2)}\n`);
    } catch (e) {
      return { ok: false, message: `Couldn't rename "${u.preset.name}": ${describeFsError(e, u.file)}` };
    }
    this.user.set(id, { preset: next, file: u.file });
    this.changed();
    return { ok: true, message: `Renamed "${u.preset.name}" to "${name}".`, data: summarizePreset(next) };
  }

  userDir(): string {
    return path.join(this.deps.userDataDir, 'presets');
  }

  ensureUserDir(): string {
    return ensureDir(this.userDir());
  }

  factorySamples(): FactorySample[] {
    return this.index.read()?.samples ?? [];
  }

  reload(): void {
    this.refreshUser(true);
  }

  async suggestSampleFolders(): Promise<SampleFolderSuggestion[]> {
    const deadline = this.now() + SCAN_BUDGET_MS;
    const late = () => this.now() > deadline;
    const home = os.homedir();
    const parents = (this.deps.profileDirs?.() ?? ['Documents', 'Music', 'Desktop', 'Downloads'].map((d) => path.join(home, d))).filter((d) => !!d && !isDriveRoot(d));
    const candidates: string[] = [];
    const add = (p: string) => {
      if (!isDriveRoot(p) && !candidates.some((c) => samePath(c, p))) candidates.push(p);
    };
    const parentHome = (p: string) => path.dirname(path.resolve(p));
    for (const rel of KNOWN_LIBRARY_DIRS) {
      for (const base of new Set(parents.map(parentHome))) {
        const p = path.join(base, ...rel);
        if (isDirSafe(p)) add(p);
      }
    }
    for (const parent of parents) {
      if (late()) break;
      for (const child of await subdirs(parent)) {
        if (late()) break;
        if (SAMPLE_DIR_RE.test(path.basename(child))) {
          add(child);
          continue;
        }
        for (const grand of await subdirs(child)) if (SAMPLE_DIR_RE.test(path.basename(grand))) add(grand);
      }
    }
    candidates.sort((a, b) => a.length - b.length);
    const roots = this.deps.getSettings().browserRoots.map((r) => r.path);
    const out: SampleFolderSuggestion[] = [];
    for (const c of candidates) {
      if (late()) break;
      if (out.some((o) => inside(o.path, c))) continue;
      const audioFiles = await countAudio(c, late);
      if (audioFiles < MIN_AUDIO_FILES) continue;
      out.push({ path: c, audioFiles, inBrowser: roots.some((r) => inside(r, c)) });
    }
    return out.sort((a, b) => Number(a.inBrowser) - Number(b.inBrowser) || b.audioFiles - a.audioFiles).slice(0, MAX_SUGGESTIONS);
  }

  private fileFor(id: string): string {
    return path.join(this.userDir(), `${fileStem(id)}.json`);
  }

  private changed(): void {
    this.all = null;
    this.userSig = this.signature();
    try {
      this.deps.broadcast(this.state());
    } catch {
    }
  }

  private signature(): string {
    let names: string[];
    try {
      names = fs.readdirSync(this.userDir()).filter((n) => n.toLowerCase().endsWith('.json'));
    } catch {
      return '';
    }
    return names
      .sort()
      .map((n) => {
        try {
          const st = fs.statSync(path.join(this.userDir(), n));
          return `${n}:${st.mtimeMs}:${st.size}`;
        } catch {
          return n;
        }
      })
      .join('|');
  }

  private refreshUser(force = false): void {
    const t = this.now();
    if (!force && t - this.lastUserCheck < USER_RESCAN_MS) return;
    this.lastUserCheck = t;
    const sig = this.signature();
    if (!force && sig === this.userSig) return;
    const next = new Map<string, { preset: Preset; file: string }>();
    const dir = this.userDir();
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json'));
    } catch {
      names = [];
    }
    for (const n of names.sort()) {
      const file = path.join(dir, n);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        this.deps.log('warn', `Skipped user preset ${n}: not readable JSON (${errText(e)}).`);
        continue;
      }
      const v = zPreset.safeParse(raw);
      if (!v.success) {
        const i = v.error.issues[0];
        this.deps.log('warn', `Skipped user preset ${n}: ${i?.path.length ? `${i.path.join('.')}: ` : ''}${i?.message ?? 'invalid'}.`);
        continue;
      }
      const p = v.data as Preset;
      if (!p.id.startsWith('user:')) {
        this.deps.log('warn', `Skipped user preset ${n}: its id "${p.id}" isn't a user id (user:…).`);
        continue;
      }
      if (next.has(p.id)) {
        this.deps.log('warn', `Skipped user preset ${n}: another file already has the id "${p.id}".`);
        continue;
      }
      next.set(p.id, { preset: p, file });
    }
    const before = this.userSig;
    this.user = next;
    this.userSig = sig;
    this.all = null;
    if (before !== sig && !force) {
      try {
        this.deps.broadcast(this.state());
      } catch {
      }
    }
  }
}

function isDriveRoot(p: string): boolean {
  const r = path.resolve(p);
  return path.parse(r).root.toLowerCase() === r.toLowerCase() || /^[a-z]:\\?$/i.test(r);
}

function isDirSafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIR.test(e.name)).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function countAudio(root: string, late: () => boolean): Promise<number> {
  let n = 0;
  const stack = [root];
  while (stack.length && n < COUNT_CAP && !late()) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink() || SKIP_DIR.test(e.name)) continue;
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
      else if (e.isFile() && isAudioFile(e.name)) n++;
    }
  }
  return n;
}
