import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, run } from './harness';
import { EVENT, INVOKE } from '../electron/channels';
import { LibraryService } from '../electron/library/service';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

function block(src: string, start: RegExp): string {
  const m = start.exec(src);
  assert.ok(m, `no ${start}`);
  let depth = 0;
  let i = m.index + m[0].length - 1;
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(from, i + 1);
}

const contract = block(read('shared/types.ts'), /\n {2}library: \{/);
const METHODS = [...contract.matchAll(/^ {4}(\w+)\(/gm)].map((m) => m[1]);

test('contract: window.krypt.library has the expected methods', () => {
  assert.deepEqual(METHODS, [
    'state',
    'onState',
    'createCollection',
    'updateCollection',
    'removeCollection',
    'addFolder',
    'addFiles',
    'removeTracks',
    'rescan',
    'setDeep',
    'estimateDeep',
    'setPaused',
    'retryFailed',
    'query',
    'track',
    'profile',
    'similar',
    'checkOriginality',
    'setFocus',
    'addToProject',
  ]);
});

test('every method has a channel, a preload binding, a handler and a service method', () => {
  const preload = block(read('electron/preload.ts'), /\n {2}library: \{/);
  const ipc = read('electron/ipc.ts');
  const invoke = INVOKE as Record<string, string>;
  for (const m of METHODS) {
    assert.match(preload, new RegExp(`\\n {4}${m}: \\(`), `preload binds ${m}`);
    if (m === 'onState') {
      assert.equal(EVENT.libraryState, 'library:state');
      assert.match(preload, /onState: \(cb\) => sub\(EVENT\.libraryState, cb\)/);
      continue;
    }
    const key = `library${m[0].toUpperCase()}${m.slice(1)}`;
    assert.equal(invoke[key], m === 'state' ? 'library:getState' : `library:${m}`, `INVOKE.${key}`);
    assert.match(preload, new RegExp(`${m}: \\([^)]*\\) => invoke\\(INVOKE\\.${key}[,)]`), `preload ${m} → INVOKE.${key}`);
    assert.match(ipc, new RegExp(`handle\\(INVOKE\\.${key},`), `ipc.ts handles INVOKE.${key}`);
    assert.equal(typeof (LibraryService.prototype as unknown as Record<string, unknown>)[m], 'function', `LibraryService.${m}`);
  }
  const channels = Object.values(invoke).filter((c) => c.startsWith('library:'));
  assert.equal(channels.length, METHODS.length - 1, 'no stray library channels');
  assert.equal(new Set(Object.values(invoke)).size, Object.values(invoke).length, 'channel names are unique');
});

test('main wires the library after the analyzer and stops it before the analyzer', () => {
  const main = read('electron/main.ts');
  assert.ok(main.indexOf('createAnalyzer(') < main.indexOf('createLibrary('), 'created after the analyzer');
  assert.match(main, /analyzerReady\.then\(\(\) => lib\.start\(\)\)/);
  assert.match(main, /lib\.stop\(\)[^\n]*\.then\(\(\) => ears\?\.stop\(\)\)/);
  assert.match(main, /library: lib,\n {2}\}\);/, 'passed to registerIpc');
});

void run('library ipc');
