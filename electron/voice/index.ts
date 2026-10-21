// Krypt Voice wiring (electron/main.ts): the Fish Audio key encrypted with Electron safeStorage (DPAPI) in
// userData/fish-key.bin, like the agent key (electron/agent/key.ts). The key is never logged, broadcast, returned or
// written in plain text. The service itself (./service.ts) is Node-only.

import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { ActionResult } from '@shared/types';
import { removeFileSync, writeFileAtomicSync } from '../system/files';
import { VoiceService, type VoiceDeps } from './service';

export { VoiceService } from './service';
export const FISH_KEY_FILE = 'fish-key.bin';

/** safeStorage-backed secret store for the Fish key. */
export function fishKeyStore(userDataDir: string): VoiceDeps['secrets'] {
  const file = path.join(userDataDir, FISH_KEY_FILE);
  return {
    read(): string | null {
      try {
        if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return null;
        return safeStorage.decryptString(fs.readFileSync(file)) || null;
      } catch {
        return null;
      }
    },
    write(key: string | null): ActionResult {
      try {
        if (key === null) {
          removeFileSync(file);
          return { ok: true };
        }
        if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: "Your system's secure storage (Windows DPAPI, the macOS Keychain or a Linux keyring) isn't available, so the Fish key was not saved (Krypt Studio never stores it in plain text)." };
        writeFileAtomicSync(file, safeStorage.encryptString(key));
        return { ok: true };
      } catch (err) {
        return { ok: false, message: `Couldn't save the Fish key: ${(err as Error)?.message ?? err}` };
      }
    },
  };
}

export function createVoice(deps: Omit<VoiceDeps, 'secrets'> & { secrets?: VoiceDeps['secrets'] }): VoiceService {
  return new VoiceService({ ...deps, secrets: deps.secrets ?? fishKeyStore(deps.userDataDir) });
}
