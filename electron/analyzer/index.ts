import { app } from 'electron';
import path from 'node:path';
import type { DocHost } from '@shared/doc/DocHost';
import type { SampleInfo } from '@shared/engine/protocol';
import type { ActionResult, AnalyzerState } from '@shared/types';
import { ANALYZER_EXE, bundledModelDirs, findBinary, resourcesDir } from '../system/paths';
import { mtimeMs } from '../system/files';
import { pruneDirs, shadowCopySync } from '../system/download';
import { AnalyzerSupervisor } from './supervisor';
import { ModelManager } from './models';
import { AnalyzerService } from './service';

export { AnalyzerService, userApply, type Apply, type RunOptions } from './service';
export { AnalyzerSupervisor } from './supervisor';
export { ModelManager } from './models';

export interface AnalyzerDeps {
  doc: DocHost;
  userDataDir: string;
  resolveSamplePath(p: string): string;
  sampleInfo?(absPath: string): Promise<ActionResult<SampleInfo>>;
  broadcast(state: AnalyzerState): void;
  pickFolder(title: string): Promise<string | null>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

const MISSING_DEV = 'The audio analyzer is not built yet. Run "npm run engine:build:debug" (it builds krypt-studio-analyzer.exe), then try again.';
const MISSING_PACKAGED = 'The audio analyzer (krypt-studio-analyzer.exe) is missing from this install. Reinstall Krypt Studio.';

function launchable(src: string): string {
  if (app.isPackaged) return src;
  const root = path.join(app.getPath('temp'), 'krypt-studio-analyzer-shadow');
  const dst = path.join(root, Math.trunc(mtimeMs(src)).toString(36), ANALYZER_EXE);
  try {
    shadowCopySync(src, dst, /\.dll$/i, [path.join(resourcesDir(), 'bin')]);
    void pruneDirs(root, 3);
    return dst;
  } catch {
    return src;
  }
}

export function createAnalyzer(deps: AnalyzerDeps): AnalyzerService {
  const supervisor = new AnalyzerSupervisor({
    resolveExe: () => {
      const src = findBinary(ANALYZER_EXE);
      return src ? launchable(src) : null;
    },
    exists: () => !!findBinary(ANALYZER_EXE),
    missingMessage: app.isPackaged ? MISSING_PACKAGED : MISSING_DEV,
    log: deps.log,
  });
  let service: AnalyzerService | null = null;
  const models = new ModelManager({
    bundledDirs: bundledModelDirs(),
    userModelsDir: path.join(deps.userDataDir, 'models'),
    log: deps.log,
    onChange: () => service?.notify(true),
    pickFolder: deps.pickFolder,
    bundledMissingMessage: app.isPackaged
      ? undefined
      : 'Bundled model files are not in resources/models yet. Run "npm run engine:build" (it stages bundled models), or use Install from folder.',
  });
  service = new AnalyzerService({
    doc: deps.doc,
    supervisor,
    models,
    userDataDir: deps.userDataDir,
    resolveSamplePath: deps.resolveSamplePath,
    sampleInfo: deps.sampleInfo,
    broadcast: deps.broadcast,
    log: deps.log,
  });
  return service;
}
