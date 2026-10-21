// Absolute locations of bundled content and native binaries.
//   dev:      <repo>/engine/target/{release,debug}/<exe> (newest wins), else <repo>/resources/bin
//   packaged: <resourcesPath>/resources/bin/<exe>   (electron-builder extraResources)

import { app } from 'electron';
import path from 'node:path';
import { exists, mtimeMs } from './files';

/** Executable suffix of the bundled native binaries on this OS. */
export const EXE_EXT = process.platform === 'win32' ? '.exe' : '';
export const ENGINE_EXE = `krypt-studio-engine${EXE_EXT}`;
export const SHIM_EXE = `krypt-studio-mcp${EXE_EXT}`;
/** On-device audio ML sidecar (docs/ANALYZER_PROTOCOL.md), spawned lazily. */
export const ANALYZER_EXE = `krypt-studio-analyzer${EXE_EXT}`;

/** Repo root in dev, app.asar dir when packaged. */
export function appRoot(): string {
  return app.isPackaged ? app.getAppPath() : path.resolve(app.getAppPath());
}

/** The `resources/` folder (krypt.ico, factory/, bin/). */
export function resourcesDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(appRoot(), 'resources');
}

export function factoryDir(): string {
  return path.join(resourcesDir(), 'factory');
}

/** Bundled demo projects (resources/demos, built by scripts/make-demo.ts). */
export function demosDir(): string {
  return path.join(resourcesDir(), 'demos');
}

/** Bundled tutorial videos (resources/guides/videos: <id>.mp4 / .vtt / .jpg, shared/guides/videos.ts). */
export function guideVideosDir(): string {
  return path.join(resourcesDir(), 'guides', 'videos');
}

/** Bundled guide screenshots (resources/guides/images: <name>.webp / .png / .jpg, shared/guides/images.ts). */
export function guideImagesDir(): string {
  return path.join(resourcesDir(), 'guides', 'images');
}

/** Vite's renderer output. */
export function distDir(): string {
  return path.join(appRoot(), 'dist');
}

/** Candidate locations for a native binary, best first. */
export function binaryCandidates(exe: string): string[] {
  if (app.isPackaged) return [path.join(resourcesDir(), 'bin', exe)];
  const target = path.join(appRoot(), 'engine', 'target');
  const built = [path.join(target, 'release', exe), path.join(target, 'debug', exe)].filter(exists).sort((a, b) => mtimeMs(b) - mtimeMs(a));
  return [...built, path.join(resourcesDir(), 'bin', exe)];
}

/** Absolute path of a native binary, or null if it hasn't been built. */
export function findBinary(exe: string): string | null {
  return binaryCandidates(exe).find(exists) ?? null;
}

/**
 * Parent folders of bundled ML models (<dir>/<model-id>/), best first.
 *   dev:      <repo>/resources/models
 *   packaged: <resourcesPath>/resources/models (extraResources), then <resourcesPath>/models
 */
export function bundledModelDirs(): string[] {
  const dirs = [path.join(resourcesDir(), 'models')];
  if (app.isPackaged) dirs.push(path.join(process.resourcesPath, 'models'));
  return dirs;
}

export function iconPath(): string {
  return path.join(resourcesDir(), process.platform === 'win32' ? 'krypt.ico' : 'krypt.png');
}

export function userDir(...parts: string[]): string {
  return path.join(app.getPath('userData'), ...parts);
}
