// window.krypt.scripts in the browser mock (npm run dev:web). Scripts only ever run in the desktop app's main
// process (the QuickJS sandbox), never in a page, so the mock lists them and checks headers but can't run them.

import type { DocHost } from '@shared/doc/DocHost';
import type { KryptApi } from '@shared/types';
import { FACTORY_SCRIPTS } from '@shared/scripts/factory';
import { parseScriptHeader } from '@shared/scripts/header';
import type { ScriptInfo } from '@shared/scripts/types';

const NO_SANDBOX = 'Scripts run in the desktop app (in its sandbox); the browser preview can only edit them.';

function info(id: string, source: ScriptInfo['source'], code: string, name: string): ScriptInfo {
  const h = parseScriptHeader(code);
  return { id, source, name: h.ok ? h.header.name : name, code, header: h.ok ? h.header : null, issues: h.issues };
}

export function createMockScripts(host: DocHost): KryptApi['scripts'] {
  return {
    list: async () => ({
      factory: FACTORY_SCRIPTS.map((s) => info(s.id, 'factory', s.code, s.id)),
      user: [],
      project: Object.values(host.project.scripts ?? {}).map((s) => ({ ...info(s.id, 'project', s.code, s.name), name: s.name })),
      libraryDir: '',
    }),
    check: async (code) => {
      const h = parseScriptHeader(code);
      return h.ok ? { ok: true, header: h.header, issues: [] } : { ok: false, header: null, issues: h.issues };
    },
    preview: async (_req, seeds) => seeds.map(() => ({ ok: false, message: NO_SANDBOX })),
    apply: async () => ({ ok: false, message: NO_SANDBOX }),
    saveToLibrary: async () => ({ ok: false, message: 'The script library is on disk: use the desktop app, or save the script into the project.' }),
    removeFromLibrary: async () => ({ ok: false, message: 'The script library needs the desktop app.' }),
    revealLibrary: async () => ({ ok: false, message: 'The script library needs the desktop app.' }),
  };
}
