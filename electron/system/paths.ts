import { app } from 'electron';
import path from 'node:path';
import { exists, mtimeMs } from './files';

export const EXE_EXT = process.platform === 'win32' ? '.exe' : '';
export const ENGINE_EXE = `krypt-studio-engine${EXE_EXT}`;
export const SHIM_EXE = `krypt-studio-mcp${EXE_EXT}`;
export const ANALYZER_EXE = `krypt-studio-analyzer${EXE_EXT}`;

export function appRoot(): string {
  return app.isPackaged ? app.getAppPath() : path.resolve(app.getAppPath());
}

export function resourcesDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(appRoot(), 'resources');
}

export function factoryDir(): string {
  return path.join(resourcesDir(), 'factory');
}

export function demosDir(): string {
  return path.join(resourcesDir(), 'demos');
}

export function guideVideosDir(): string {
  return path.join(resourcesDir(), 'guides', 'videos');
}

export function guideImagesDir(): string {
  return path.join(resourcesDir(), 'guides', 'images');
}

export function distDir(): string {
  return path.join(appRoot(), 'dist');
}

export function binaryCandidates(exe: string): string[] {
  if (app.isPackaged) return [path.join(resourcesDir(), 'bin', exe)];
  const target = path.join(appRoot(), 'engine', 'target');
  const built = [path.join(target, 'release', exe), path.join(target, 'debug', exe)].filter(exists).sort((a, b) => mtimeMs(b) - mtimeMs(a));
  return [...built, path.join(resourcesDir(), 'bin', exe)];
}

export function findBinary(exe: string): string | null {
  return binaryCandidates(exe).find(exists) ?? null;
}

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
