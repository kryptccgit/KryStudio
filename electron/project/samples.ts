// Sample path bookkeeping. Saved projects carry BOTH the absolute path and
// a path relative to the project file, so a project folder that moved (or
// was copied to another PC with the same layout) relinks on open.
// 'factory:...' paths are bundled content and 'pack:<id>/...' paths point
// into a downloaded sound pack (userData/packs/<id>/): both are portable and
// never rewritten.

import path from 'node:path';
import type { Project, SampleRef } from '@shared/schema/project';
import { packById } from '@shared/packs/catalog';
import { PACK_SCHEME, parsePackPath } from '@shared/packs/types';

export const FACTORY_PREFIX = 'factory:';

export function isFactory(p: string): boolean {
  return p.startsWith(FACTORY_PREFIX);
}

export function isPack(p: string): boolean {
  return p.startsWith(PACK_SCHEME);
}

/**
 * 'pack:grand-piano/krypt/grand.sfz' → <packsDir>/grand-piano/krypt/grand.sfz. An unsafe pack path ('..', bad id,
 * a drive or a stream name) never escapes the packs folder: it resolves to the folder itself, which no sample
 * loader accepts.
 */
export function resolvePackPath(p: string, packsDir: string): string {
  if (!isPack(p)) return p;
  const base = path.resolve(packsDir);
  const pp = parsePackPath(p);
  if (!pp || pp.path.split('/').some((seg) => /[\\:*?"<>|\u0000-\u001f]/.test(seg))) return base;
  const full = path.resolve(base, pp.packId, ...pp.path.split('/'));
  return full.startsWith(path.join(base, pp.packId) + path.sep) ? full : base;
}

/** Copy of the project with relPath set for every absolute sample path (forward slashes). */
export function withRelativePaths(project: Project, projectFile: string): Project {
  const dir = path.dirname(projectFile);
  const samples: Record<string, SampleRef> = {};
  let changed = false;
  for (const [id, s] of Object.entries(project.samples)) {
    if (isFactory(s.path) || !path.isAbsolute(s.path)) {
      samples[id] = s;
      continue;
    }
    const rel = path.relative(dir, s.path);
    const relPath = !rel || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join('/');
    if (relPath !== s.relPath) changed = true;
    const next: SampleRef = { ...s };
    if (relPath) next.relPath = relPath;
    else delete next.relPath;
    samples[id] = next;
  }
  return changed ? { ...project, samples } : project;
}

export interface RelinkReport {
  project: Project;
  relinked: string[];
  /** Missing samples (not counting those of a pack that isn't installed: see missingPacks). */
  missing: string[];
  /** Sound packs the project uses that aren't installed (or are missing files), each once. */
  missingPacks: Array<{ id: string; name: string }>;
}

/**
 * Where an uploaded file (import_audio) lives in THIS profile: imports are named by their content hash, so a
 * project saved by another Windows user / profile (a different userData path) finds its copy here.
 */
export function importedCopy(s: SampleRef, importsDir: string | undefined): string | null {
  if (!importsDir || !s.hash || !/^[a-f0-9]{64}$/i.test(s.hash)) return null;
  const ext = /\.([a-z0-9]{2,5})$/i.exec(s.path)?.[1]?.toLowerCase();
  return ext ? path.join(importsDir, `${s.hash.toLowerCase()}.${ext}`) : null;
}

/**
 * On open: absolute path missing but relPath (from the project folder) exists → use it; else, for an uploaded
 * file (content-hash named), the same file in this profile's imports folder.
 */
export function relinkSamples(project: Project, projectFile: string | null, exists: (p: string) => boolean, opts: { importsDir?: string; packsDir?: string } = {}): RelinkReport {
  const relinked: string[] = [];
  const missing: string[] = [];
  const missingPacks: Array<{ id: string; name: string }> = [];
  const samples: Record<string, SampleRef> = {};
  const dir = projectFile ? path.dirname(projectFile) : null;
  for (const [id, s] of Object.entries(project.samples)) {
    if (isPack(s.path)) {
      // Portable: kept as is. Without a packs folder to check, it is assumed present (like factory:).
      samples[id] = s;
      if (opts.packsDir && !exists(resolvePackPath(s.path, opts.packsDir))) {
        const packId = parsePackPath(s.path)?.packId;
        if (packId && !missingPacks.some((m) => m.id === packId)) missingPacks.push({ id: packId, name: packById(packId)?.name ?? packId });
        else if (!packId) missing.push(s.name || s.path);
      }
      continue;
    }
    if (isFactory(s.path) || exists(s.path)) {
      samples[id] = s;
      continue;
    }
    const rel = dir && s.relPath ? path.resolve(dir, s.relPath.split('/').join(path.sep)) : null;
    const imported = importedCopy(s, opts.importsDir);
    const candidate = rel && exists(rel) ? rel : imported && exists(imported) ? imported : null;
    if (candidate) {
      samples[id] = { ...s, path: candidate };
      relinked.push(s.name);
    } else {
      samples[id] = s;
      missing.push(s.name || path.basename(s.path));
    }
  }
  return { project: relinked.length ? { ...project, samples } : project, relinked, missing, missingPacks };
}

/** "needs the Grand Piano pack: download it in Home ▸ Sounds" (one or several packs). */
export function missingPacksText(packs: ReadonlyArray<{ name: string }>): string {
  if (!packs.length) return '';
  const names = packs.map((p) => p.name.trim().replace(/\s+pack$/i, ''));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `needs the ${list} sound pack${names.length === 1 ? '' : 's'}: download ${names.length === 1 ? 'it' : 'them'} in Home ▸ Sounds`;
}

/** 'factory:drums/kick.wav' → <factoryDir>/drums/kick.wav (never escapes the factory dir). */
export function resolveFactoryPath(p: string, factoryDir: string): string {
  if (!isFactory(p)) return p;
  const rel = p.slice(FACTORY_PREFIX.length).replace(/^[/\\]+/, '');
  const full = path.resolve(factoryDir, rel);
  const base = path.resolve(factoryDir);
  return full === base || full.startsWith(base + path.sep) ? full : base;
}
