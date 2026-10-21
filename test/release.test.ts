// Release hygiene: the licence policy evaluator used by the CI gate, and the
// shipped demo project (resources/demos/*.kstudio) still opening cleanly
// against the current schema, catalog and command layer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, run } from './harness';
import { CATALOG } from '@shared/plugins/catalog';
import { findPlugin } from '@shared/schema/params';
import { decodeContainer } from '../electron/project/container';
import { validateProject } from '../electron/project/migrations';
import { isOfficialDestination, resolveClientContext } from '../electron/system/context';
// @ts-expect-error plain .mjs helper without type declarations
import { evaluateLicense, spdxDnf } from '../scripts/lib/deps.mjs';

// Bundled to test/.out/*.mjs by scripts/run-tests.mjs, so the repo root is two levels up.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('licence policy: permissive passes, copyleft fails, choices pick MIT', () => {
  for (const ok of ['MIT', 'Apache-2.0', 'MIT OR Apache-2.0', 'MIT/Apache-2.0', 'Zlib OR Apache-2.0 OR MIT', '(MIT OR Apache-2.0) AND Unicode-3.0', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'Apache-2.0 WITH LLVM-exception']) {
    assert.equal(evaluateLicense(ok).ok, true, ok);
  }
  for (const bad of ['GPL-3.0', 'GPL-2.0-or-later', 'AGPL-3.0-only', 'LGPL-2.1', 'SSPL-1.0', 'MIT AND GPL-3.0', 'UNLICENSED', '', 'CC-BY-NC-4.0']) {
    assert.equal(evaluateLicense(bad).ok, false, bad || '(empty)');
  }
  assert.deepEqual(evaluateLicense('MIT OR Apache-2.0 OR LGPL-2.1-or-later').chosen, ['MIT']);
  assert.deepEqual(evaluateLicense('GPL-3.0').denied, ['GPL-3.0']);
  assert.deepEqual(spdxDnf('(A OR B) AND C'), [['A', 'C'], ['B', 'C']]);
});

test('shipped demo projects open: valid schema, known plugins, factory samples only', () => {
  const dir = path.join(root, 'resources', 'demos');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.kstudio')) : [];
  assert.ok(files.length > 0, 'resources/demos has no .kstudio (run npm run make-demo)');
  for (const f of files) {
    const d = decodeContainer(new Uint8Array(fs.readFileSync(path.join(dir, f))));
    const p = validateProject(d.project, d.meta?.schemaVersion);
    for (const ch of Object.values(p.channels)) assert.ok(findPlugin(CATALOG, ch.generator.type), `${f}: unknown instrument ${ch.generator.type}`);
    for (const ins of Object.values(p.mixer.inserts)) for (const s of Object.values(ins.slots)) assert.ok(findPlugin(CATALOG, s.type), `${f}: unknown effect ${s.type}`);
    for (const s of Object.values(p.samples)) assert.match(s.path, /^factory:/, `${f}: demo uses a non-factory sample ${s.path}`);
    assert.equal(p.transport.mode, 'song');
    assert.ok(Object.keys(p.playlist.clips).length >= 20, `${f}: expected a full arrangement`);
    assert.ok(Object.keys(p.automations).length >= 1, `${f}: expected automation`);
  }
});

test('runtime identity is sealed (§9): payload edits without a re-seal would degrade the app', () => {
  const ctx = resolveClientContext();
  assert.equal(ctx.intact, true, 'electron/system/context.ts payloads no longer match LAYOUT_REV: re-seal them');
  assert.equal(ctx.productName, 'Krypt Studio');
  assert.match(ctx.clientId, /^[0-9]{17,20}$/);
  assert.ok(ctx.toolsUrl.startsWith('https://') && ctx.discordUrl.startsWith('https://'));
  assert.equal(isOfficialDestination(ctx.discordUrl), true);
  assert.equal(isOfficialDestination('https://example.com/'), false);
});

void run('release');
