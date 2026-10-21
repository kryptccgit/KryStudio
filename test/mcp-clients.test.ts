// Connect Claude Code also adds ONE permission rule (mcp__krypt-studio) so
// Claude Code stops asking before every Krypt Studio tool call. The merge must
// keep everything else in the user's settings, be idempotent, keep a .bak and
// never touch a file it can't parse. Uses temp files only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { allowClaudeCodeTools, CLAUDE_CODE_ALLOW_RULE } from '../electron/mcp/clients';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-clients-'));
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('the rule matches every tool of the krypt-studio server', () => {
  assert.equal(CLAUDE_CODE_ALLOW_RULE, 'mcp__krypt-studio');
});

test('creates the settings file when there is none', () => {
  const f = path.join(dir, 'fresh', 'settings.json');
  const r = allowClaudeCodeTools(f);
  assert.deepEqual(r, { changed: true, backup: null });
  assert.deepEqual(read(f), { permissions: { allow: ['mcp__krypt-studio'] } });
});

test('merges into existing settings, keeping every other key and rule, with a backup', () => {
  const f = path.join(dir, 'settings.json');
  const before = { model: 'opus', theme: 'dark', permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)'], defaultMode: 'default' } };
  fs.writeFileSync(f, JSON.stringify(before, null, 2));
  const r = allowClaudeCodeTools(f);
  assert.equal(r.changed, true);
  assert.equal(r.backup, `${f}.bak`);
  assert.deepEqual(read(`${f}.bak`), before);
  assert.deepEqual(read(f), { ...before, permissions: { ...before.permissions, allow: ['Bash(npm test)', 'mcp__krypt-studio'] } });
});

test('idempotent: a second run (or a wildcard rule already there) changes nothing', () => {
  const f = path.join(dir, 'settings.json');
  const text = fs.readFileSync(f, 'utf8');
  assert.deepEqual(allowClaudeCodeTools(f), { changed: false, backup: null });
  assert.equal(fs.readFileSync(f, 'utf8'), text);
  const w = path.join(dir, 'wild.json');
  fs.writeFileSync(w, JSON.stringify({ permissions: { allow: ['mcp__krypt-studio__*'] } }));
  assert.deepEqual(allowClaudeCodeTools(w), { changed: false, backup: null });
});

test('a settings file that is not plain JSON is left alone with a clear message', () => {
  const f = path.join(dir, 'broken.json');
  fs.writeFileSync(f, '{ "model": "opus", // comment\n}');
  assert.throws(() => allowClaudeCodeTools(f), /isn't plain JSON.*not touching it.*permissions\.allow/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{ "model": "opus", // comment\n}');
  assert.equal(fs.existsSync(`${f}.bak`), false);
});

void run('mcp-clients').finally(() => fs.rmSync(dir, { recursive: true, force: true }));
