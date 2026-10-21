// Reference library wiring (Electron side): the service over the analyzer's
// shared sidecar + Model Manager, with native folder / file pickers.
// main.ts creates it after the analyzer and stops it before the analyzer.

import type { DocHost } from '@shared/doc/DocHost';
import type { SampleInfo } from '@shared/engine/protocol';
import type { LibraryState } from '@shared/library/types';
import type { ActionResult, Settings } from '@shared/types';
import type { AnalyzerService } from '../analyzer';
import { backendFrom, LibraryService } from './service';

export { LibraryService, LIBRARY_AUDIO_EXTENSIONS, isLibraryAudio } from './service';

export interface LibraryWiring {
  doc: DocHost;
  userDataDir: string;
  analyzer: AnalyzerService | null;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  sampleInfo?(absPath: string): Promise<ActionResult<SampleInfo>>;
  pickFolder(title: string): Promise<string | null>;
  pickFiles(title: string, extensions: readonly string[]): Promise<string[] | null>;
  broadcast(state: LibraryState): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export function createLibrary(w: LibraryWiring): LibraryService {
  const shared = w.analyzer?.shared() ?? null;
  return new LibraryService({
    userDataDir: w.userDataDir,
    doc: w.doc,
    backend: shared ? backendFrom(shared.supervisor, shared.models) : null,
    getSettings: w.getSettings,
    updateSettings: w.updateSettings,
    sampleInfo: w.sampleInfo,
    pickFolder: w.pickFolder,
    pickFiles: w.pickFiles,
    broadcast: w.broadcast,
    log: w.log,
  });
}
