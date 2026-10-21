import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, run } from './harness';
import { engineNeeded, ENGINE_PARK_MS, HIDDEN_ARG, launchedHidden, syncStartWithWindows } from '../electron/system/background';
import { DEFAULT_SETTINGS, mergeSettings } from '../electron/system/settings-store';

function repoRoot(): string {
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      if (statSync(path.join(dir, 'package.json')).isFile()) return dir;
    } catch {
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const read = (rel: string): string => readFileSync(path.join(repoRoot(), rel), 'utf8');

test('the startup flag', () => {
  assert.equal(HIDDEN_ARG, '--hidden');
  assert.equal(launchedHidden(['Krypt Studio.exe', '--hidden']), true);
  assert.equal(launchedHidden(['Krypt Studio.exe', 'C:/song.kstudio']), false);
});

test('the engine runs while the window is open, an agent is connected or an export renders; pauses otherwise', () => {
  assert.equal(engineNeeded({ windowVisible: true, agents: 0, rendering: false }), true);
  assert.equal(engineNeeded({ windowVisible: false, agents: 1, rendering: false }), true);
  assert.equal(engineNeeded({ windowVisible: false, agents: 0, rendering: true }), true);
  assert.equal(engineNeeded({ windowVisible: false, agents: 0, rendering: false }), false);
  assert.ok(ENGINE_PARK_MS >= 30_000, 'a quick hide / show must not restart the engine');
});

test('Start with Windows defaults on, survives a merge, and turning it off sticks', () => {
  assert.equal(DEFAULT_SETTINGS.ui.startWithWindows, true);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, {}).ui.startWithWindows, true);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { ui: { scale: 1, showHints: true } }).ui.startWithWindows, true, 'older settings files');
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { ui: { ...DEFAULT_SETTINGS.ui, startWithWindows: false } }).ui.startWithWindows, false);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, {}).ui.trayNoticeShown, false);
  assert.deepEqual(syncStartWithWindows(true, 'Krypt Studio'), { ok: true });
});

test('the installer adds the startup entry on install and removes it on uninstall, under the app’s value name', () => {
  const nsh = read('build/installer.nsh');
  const install = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macroend', nsh.indexOf('!macro customInstall')));
  const uninstall = nsh.slice(nsh.indexOf('!macro customUnInstall'));
  assert.match(install, /WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "\$\{PRODUCT_NAME\}" '"\$INSTDIR\\\$\{APP_FILENAME\}\.exe" --hidden'/);
  assert.match(install, /\$\{ifNot\} \$\{isUpdated\}/, 'an update keeps the user’s choice');
  assert.match(uninstall, /DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "\$\{PRODUCT_NAME\}"/);
  const main = read('electron/main.ts');
  assert.match(main, /syncStartWithWindows\([^)]*ctx\.productName\)/, 'the app manages the same value (the product name)');
});

test('closing the window hides to the tray; File ▸ Exit and the tray Quit really quit', () => {
  const main = read('electron/main.ts');
  assert.match(main, /if \(!quitting\) \{\s*e\.preventDefault\(\);\s*hideToTray\(win\);/);
  assert.match(main, /app\.on\('before-quit', \(\) => \{\s*quitting = true;/);
  assert.match(main, /quit: quitApp/);
  assert.match(read('electron/ipc.ts'), /if \(action === 'quit'\) return void d\.quit\(\);/);
  assert.match(read('src/app/TitleBar.tsx'), /label: 'Exit'.*window\('quit'\)/);
});

void run('background');
