// The .kstudio container: a zip (fflate) holding
//   project.json   the normalized document
//   meta.json      { format, appVersion, schemaVersion, savedAt, projectId }
//   recovery.json  (autosave snapshots only) crash-recovery bookkeeping
//   cover-<hash>.jpg|png  the cover image meta.cover names (stored, not
//                  deflated: JPEG / PNG are compressed already). Only the
//                  entry project.json references is extracted on open.
// Plain .json project files are accepted on open too (fixtures, agents).

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { COVER_FILE_RE, type Project } from '@shared/schema/project';

export const FORMAT_ID = 'krypt-studio-project';

export interface ContainerMeta {
  format: string;
  appVersion: string;
  schemaVersion: number;
  savedAt: string;
  projectId: string;
}

export interface Decoded {
  project: unknown;
  meta: Partial<ContainerMeta> | null;
  extra: Record<string, unknown>;
  /** Binary entries the project references (its cover), by entry name. */
  assets: Record<string, Uint8Array>;
}

export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

export function encodeContainer(project: Project, appVersion: string, extra: Record<string, unknown> = {}, assets: Record<string, Uint8Array> = {}): Uint8Array {
  const meta: ContainerMeta = {
    format: FORMAT_ID,
    appVersion,
    schemaVersion: project.schemaVersion,
    savedAt: new Date().toISOString(),
    projectId: project.id,
  };
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    'meta.json': strToU8(JSON.stringify(meta, null, 2)),
    'project.json': strToU8(JSON.stringify(project)),
  };
  for (const [name, value] of Object.entries(extra)) files[`${name}.json`] = strToU8(JSON.stringify(value));
  for (const [name, bytes] of Object.entries(assets)) {
    if (!COVER_FILE_RE.test(name)) throw new ProjectFileError(`Can't store "${name}" in a project file`);
    files[name] = [bytes, { level: 0 }];
  }
  return zipSync(files, { level: 6, mtime: new Date() });
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ProjectFileError(`${what} is not valid JSON (${(err as Error).message})`);
  }
}

export function decodeContainer(bytes: Uint8Array): Decoded {
  // Plain JSON project (starts with "{" after optional BOM / whitespace).
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) i++;
  if (bytes[i] === 0x7b) return { project: parseJson(strFromU8(bytes.subarray(i)), 'The project file'), meta: null, extra: {}, assets: {} };

  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new ProjectFileError("This isn't a Krypt Studio project (not a .kstudio archive).");
  let files: Record<string, Uint8Array>;
  try {
    // JSON entries first; binary entries are extracted only when project.json references them (below).
    files = unzipSync(bytes, { filter: (f) => f.name.endsWith('.json') });
  } catch (err) {
    throw new ProjectFileError(`The project archive is damaged (${(err as Error).message}).`);
  }
  const pj = files['project.json'];
  if (!pj) throw new ProjectFileError('The project archive has no project.json; it may be damaged.');
  const meta = files['meta.json'] ? (parseJson(strFromU8(files['meta.json']), 'meta.json') as Partial<ContainerMeta>) : null;
  if (meta && meta.format && meta.format !== FORMAT_ID) throw new ProjectFileError(`Unknown project format "${meta.format}".`);
  const extra: Record<string, unknown> = {};
  for (const [name, data] of Object.entries(files)) {
    if (name === 'project.json' || name === 'meta.json' || !name.endsWith('.json')) continue;
    try {
      extra[name.slice(0, -5)] = JSON.parse(strFromU8(data));
    } catch {
      /* optional side files never block opening */
    }
  }
  const project = parseJson(strFromU8(pj), 'project.json');
  const assets: Record<string, Uint8Array> = {};
  const cover = (project as { meta?: { cover?: { file?: unknown } } } | null)?.meta?.cover?.file;
  if (typeof cover === 'string' && COVER_FILE_RE.test(cover)) {
    try {
      const hit = unzipSync(bytes, { filter: (f) => f.name === cover })[cover];
      if (hit) assets[cover] = hit;
    } catch {
      /* a damaged cover never blocks opening: the project opens without it */
    }
  }
  return { project, meta, extra, assets };
}
