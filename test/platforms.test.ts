// Windows, macOS and Linux builds: the MCP endpoint name on each OS, the native binary names, and the packaging
// and release config that ships all three (package.json build, .github/workflows/release.yml).
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { pipeNameFor } from '../electron/mcp/endpoint';
import { ENGINE_EXE, EXE_EXT, SHIM_EXE } from '../electron/system/paths';

function repoRoot(): string {
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      if (statSync(path.join(dir, 'package.json')).isFile()) return dir;
    } catch {
      /* keep climbing */
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const read = (rel: string): string => readFileSync(path.join(repoRoot(), rel), 'utf8');

test('MCP endpoint: a named pipe on Windows, a short Unix socket elsewhere', () => {
  assert.equal(pipeNameFor('Some User', undefined, 'win32'), '\\\\.\\pipe\\krypt-studio-mcp-some-user');
  for (const platform of ['darwin', 'linux'] as const) {
    const p = pipeNameFor('Some User', 'dev', platform);
    assert.ok(p.startsWith('/') || /^[A-Za-z]:\//.test(p), `${platform}: absolute path, got ${p}`);
    assert.ok(p.endsWith('/krypt-studio-mcp-some-user-dev.sock'), p);
    assert.ok(!p.includes('\\'), `${platform}: forward slashes only, got ${p}`);
    // macOS caps sun_path at 104 bytes; the per-user temp dir is ~50.
    assert.ok(Buffer.byteLength(path.posix.basename(p)) < 50, p);
  }
  // Linux never falls back to the shared /tmp, where another user could claim the path first.
  const saved = process.env.XDG_RUNTIME_DIR;
  try {
    delete process.env.XDG_RUNTIME_DIR;
    assert.equal(pipeNameFor('u', undefined, 'linux'), path.posix.join(os.homedir().replace(/\\/g, '/'), '.krypt-studio', 'krypt-studio-mcp-u.sock'));
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    assert.equal(pipeNameFor('u', undefined, 'linux'), '/run/user/1000/krypt-studio-mcp-u.sock');
  } finally {
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved;
  }
});

test('native binary names follow the OS', () => {
  assert.equal(EXE_EXT, process.platform === 'win32' ? '.exe' : '');
  assert.equal(ENGINE_EXE, `krypt-studio-engine${EXE_EXT}`);
  assert.equal(SHIM_EXE, `krypt-studio-mcp${EXE_EXT}`);
});

test('packaging ships Windows, macOS and Linux with their binaries', () => {
  const pkg = JSON.parse(read('package.json'));
  const b = pkg.build;
  assert.ok(!/--win\b/.test(pkg.scripts.dist), 'dist builds for the host OS');
  assert.equal(b.win.target[0].target, 'nsis');
  assert.equal(b.mac.target[0].target, 'dmg');
  assert.deepEqual(b.linux.target.map((t: { target: string }) => t.target), ['AppImage', 'deb']);
  assert.match(b.mac.extendInfo.NSMicrophoneUsageDescription, /microphone/i, 'macOS needs a reason to record');
  assert.equal(b.afterPack, './scripts/mac-adhoc-sign.cjs');
  const filter: string[] = b.extraResources[0].filter;
  for (const f of ['bin/*.exe', 'bin/*.dll', 'bin/krypt-studio-engine', 'bin/krypt-studio-mcp', 'bin/krypt-studio-analyzer', 'bin/*.dylib', 'bin/*.so']) {
    assert.ok(filter.includes(f), `extraResources ships ${f}`);
  }
  for (const p of ['win', 'mac', 'linux']) assert.equal(b[p].fileAssociations[0].ext, 'kstudio', `${p} opens .kstudio files`);
});

test('the release builds all three and publishes once', () => {
  const yml = read('.github/workflows/release.yml');
  for (const os of ['windows-latest', 'macos-latest', 'ubuntu-latest']) assert.ok(yml.includes(`os: ${os}`), os);
  assert.match(yml, /needs: build/);
  for (const ext of ['exe', 'dmg', 'AppImage', 'deb']) assert.ok(yml.includes(`release/*.${ext}`), ext);
  assert.match(yml, /libasound2-dev/);
});

run('platforms');
