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

export function resolvePackPath(p: string, packsDir: string): string {
  if (!isPack(p)) return p;
  const base = path.resolve(packsDir);
  const pp = parsePackPath(p);
  if (!pp || pp.path.split('/').some((seg) => /[\\:*?"<>|\u0000-\u001f]/.test(seg))) return base;
  const full = path.resolve(base, pp.packId, ...pp.path.split('/'));
  return full.startsWith(path.join(base, pp.packId) + path.sep) ? full : base;
}

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
  missing: string[];
  missingPacks: Array<{ id: string; name: string }>;
}

export function importedCopy(s: SampleRef, importsDir: string | undefined): string | null {
  if (!importsDir || !s.hash || !/^[a-f0-9]{64}$/i.test(s.hash)) return null;
  const ext = /\.([a-z0-9]{2,5})$/i.exec(s.path)?.[1]?.toLowerCase();
  return ext ? path.join(importsDir, `${s.hash.toLowerCase()}.${ext}`) : null;
}

export function relinkSamples(project: Project, projectFile: string | null, exists: (p: string) => boolean, opts: { importsDir?: string; packsDir?: string } = {}): RelinkReport {
  const relinked: string[] = [];
  const missing: string[] = [];
  const missingPacks: Array<{ id: string; name: string }> = [];
  const samples: Record<string, SampleRef> = {};
  const dir = projectFile ? path.dirname(projectFile) : null;
  for (const [id, s] of Object.entries(project.samples)) {
    if (isPack(s.path)) {
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

export function missingPacksText(packs: ReadonlyArray<{ name: string }>): string {
  if (!packs.length) return '';
  const names = packs.map((p) => p.name.trim().replace(/\s+pack$/i, ''));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `needs the ${list} sound pack${names.length === 1 ? '' : 's'}: download ${names.length === 1 ? 'it' : 'them'} in Home ▸ Sounds`;
}

export function resolveFactoryPath(p: string, factoryDir: string): string {
  if (!isFactory(p)) return p;
  const rel = p.slice(FACTORY_PREFIX.length).replace(/^[/\\]+/, '');
  const full = path.resolve(factoryDir, rel);
  const base = path.resolve(factoryDir);
  return full === base || full.startsWith(base + path.sep) ? full : base;
}
