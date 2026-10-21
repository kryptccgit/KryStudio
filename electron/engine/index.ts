import { app } from 'electron';
import path from 'node:path';
import type { DocHost } from '@shared/doc/DocHost';
import { EngineSupervisor } from './supervisor';
import { EngineBridge } from './bridge';
import { ENGINE_EXE, EXE_EXT, factoryDir, findBinary } from '../system/paths';
import { copyIfNewerSync, mtimeMs, pruneDir } from '../system/files';
import type { LogLevel } from '../system/logger';

export { EngineSupervisor } from './supervisor';
export { EngineBridge } from './bridge';

export interface EngineDeps {
  doc: DocHost;
  audioSettings(): { deviceId: string | null; bufferFrames: number; sampleRate: number };
  resolveSamplePath(p: string): string;
  log(level: LogLevel | 'debug', m: string): void;
  packsDir?: string;
  beforeLoad?(): Promise<void>;
}

const MISSING_DEV = 'Audio engine not built yet. Run "npm run engine:build:debug"; it starts automatically when the build finishes.';
const MISSING_PACKAGED = `The audio engine (${ENGINE_EXE}) is missing from this install. Reinstall Krypt Studio.`;

function launchable(src: string): string {
  if (app.isPackaged) return src;
  const dir = path.join(app.getPath('temp'), 'krypt-studio-engine-shadow');
  const dst = path.join(dir, `krypt-studio-engine-${Math.trunc(mtimeMs(src)).toString(36)}${EXE_EXT}`);
  copyIfNewerSync(src, dst);
  void pruneDir(dir, 3, /^krypt-studio-engine-[0-9a-z]+(\.exe)?$/i);
  return dst;
}

export function createEngine(deps: EngineDeps): { engine: EngineSupervisor; bridge: EngineBridge } {
  let bridge: EngineBridge | null = null;
  const engine = new EngineSupervisor({
    resolveExe: () => {
      const src = findBinary(ENGINE_EXE);
      return src ? launchable(src) : null;
    },
    missingMessage: app.isPackaged ? MISSING_PACKAGED : MISSING_DEV,
    factoryDir: factoryDir(),
    packsDir: deps.packsDir,
    audioSettings: deps.audioSettings,
    loadProject: async () => {
      if (deps.beforeLoad) await deps.beforeLoad().catch((err) => deps.log('warn', `Engine pre-load step failed: ${(err as Error)?.message ?? err}`));
      return bridge ? bridge.load() : { ok: false, message: 'Engine bridge not ready' };
    },
    syncDoc: () => (bridge ? bridge.sync() : Promise.resolve()),
    log: (level, m) => deps.log(level, m),
  });
  bridge = new EngineBridge(deps.doc, engine, deps.resolveSamplePath, deps.log);

  if (!app.isPackaged) {
    engine.watchForBinary();
    const key = (): string => {
      const p = findBinary(ENGINE_EXE);
      return p ? `${p}|${mtimeMs(p)}` : '';
    };
    let applied = key();
    let candidate = '';
    setInterval(() => {
      const k = key();
      if (k === applied) {
        candidate = '';
        return;
      }
      if (k !== candidate) {
        candidate = k;
        return;
      }
      const hadOne = applied !== '';
      applied = k;
      candidate = '';
      if (k && hadOne) {
        deps.log('info', 'New engine build detected; restarting the audio engine.');
        void engine.restart();
      }
    }, 2000).unref();
  }
  return { engine, bridge };
}
