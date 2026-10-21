// Tab shortcuts as app commands (keymap ids in src/input/keymap.ts):
//   tabs.next / tabs.prev        Ctrl+Tab / Ctrl+Shift+Tab
//   tabs.goto1 … tabs.goto9      Ctrl+1 … Ctrl+8, Ctrl+9 = the last tab
//   tabs.close                   Ctrl+W
//   tabs.reopenClosed            Ctrl+Shift+T: the newest closed thing, a tab or a panel
// File ▸ New tab stays `file.new` (Ctrl+N) so users' custom bindings keep working.

import { registerCommands } from '../../input/commands';
import { shortcutFor } from '../../input/keymap';
import { flashHint } from '../hints';
import { lastPanelClosedAt, installPanelUndo, reopenClosedPanel } from '../../workspace/panelUndo';
import { pickReopen } from '../../workspace/closedPanels';
import { stepTabId, tabForDigit } from './logic';
import { closeTab, getTabs, installTabsFeed, lastTabClosedAt, reopenClosedTab, switchTab } from './store';

function stepTab(dir: 1 | -1): void {
  const s = getTabs();
  const id = s ? stepTabId(s, dir) : null;
  if (!id) {
    const k = shortcutFor('file.new');
    flashHint(`Only one project is open${k ? `: ${k} opens a new tab` : ''}`, 'warn');
    return;
  }
  void switchTab(id);
}

function gotoTab(n: number): void {
  const s = getTabs();
  const id = s ? tabForDigit(s.tabs, n) : null;
  if (!id) {
    flashHint(`There's no tab ${n}`, 'warn', 1400);
    return;
  }
  void switchTab(id);
}

function closeActive(): void {
  const id = getTabs()?.activeId;
  if (id) void closeTab(id);
}

/** Ctrl+Shift+T: whichever went last, a project tab or a panel. */
function reopenLast(): void {
  const pick = pickReopen(lastPanelClosedAt(), lastTabClosedAt());
  if (pick === 'panel') {
    const r = reopenClosedPanel();
    if (r) flashHint(`Reopened ${r.title}`, 'ok');
    else flashHint("Couldn't reopen the panel", 'warn');
  } else if (pick === 'tab') void reopenClosedTab();
  else flashHint('Nothing closed to reopen', 'warn');
}

let installed = false;

/** Boot: the tab feed, panel-close undo and the tab commands. */
export function installTabs(): void {
  if (installed) return;
  installed = true;
  installTabsFeed();
  installPanelUndo();
  registerCommands([
    { id: 'tabs.next', label: 'Next tab', run: () => stepTab(1) },
    { id: 'tabs.prev', label: 'Previous tab', run: () => stepTab(-1) },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: `tabs.goto${n}`, label: n === 9 ? 'Go to the last tab' : `Go to tab ${n}`, run: () => gotoTab(n) })),
    { id: 'tabs.close', label: 'Close tab', run: closeActive },
    { id: 'tabs.reopenClosed', label: 'Reopen closed tab or panel', run: reopenLast },
  ]);
}
