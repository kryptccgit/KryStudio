// Project tabs in the renderer (research/19-project-tabs.md): tab-strip sizing, drag-reorder index math,
// keyboard tab navigation, closed-tab times, the tab shortcuts in the keymap, and the panel-close undo
// ordering (Ctrl+Z reopens a panel closed after the last user edit).
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { dropIndex, moveTab, newestClosedAt, othersOf, stepTabId, tabForDigit, tabHint, tabLayout, trackClosedTimes, TAB_MAX_W, TAB_MIN_W } from '../src/app/tabs/logic';
import { ClosedPanels, MAX_CLOSED_PANELS, decideUndo, dockNeighbour, newestUserEditAt, pickReopen, type ClosedPanel } from '../src/workspace/closedPanels';
import { DEFAULT_KEYMAP, applyKeymapOverrides, bindingFor, eventToKeys, findKeyConflicts, keysForCommand, setKeymap } from '../src/input/keymap';
import { buildShortcutSections } from '../src/guides/shortcuts';

const tabs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, title: `Beat ${i + 1}`, path: null, dirty: false }));

// ── Strip sizing ──────────────────────────────────────────────────────

test('tabs are as wide as fits, shrink to the minimum, then the strip scrolls', () => {
  assert.deepEqual(tabLayout(2, 1000), { width: TAB_MAX_W, scroll: false });
  assert.deepEqual(tabLayout(5, 700), { width: 140, scroll: false });
  assert.deepEqual(tabLayout(7, 7 * TAB_MIN_W), { width: TAB_MIN_W, scroll: false });
  assert.deepEqual(tabLayout(8, 7 * TAB_MIN_W), { width: TAB_MIN_W, scroll: true });
  assert.deepEqual(tabLayout(3, 0), { width: TAB_MIN_W, scroll: true });
  assert.equal(tabLayout(0, 500).scroll, false);
});

// ── Reorder ───────────────────────────────────────────────────────────

test('drop index counts the other tabs left of the pointer (the final index)', () => {
  const mids = [50, 150, 250, 350];
  assert.equal(dropIndex(mids, 260, 0), 2); // first tab dragged past the third
  assert.equal(dropIndex(mids, 40, 3), 0); // last tab dragged to the front
  assert.equal(dropIndex(mids, 160, 1), 1); // wiggle in place: no move
  assert.equal(dropIndex(mids, 999, 1), 3);
  assert.deepEqual(moveTab(tabs(4), 't1', dropIndex(mids, 260, 0)).map((t) => t.id), ['t2', 't3', 't1', 't4']);
  assert.deepEqual(moveTab(tabs(4), 't4', 0).map((t) => t.id), ['t4', 't1', 't2', 't3']);
  assert.deepEqual(moveTab(tabs(3), 't2', 99).map((t) => t.id), ['t1', 't3', 't2']); // clamped
  assert.deepEqual(moveTab(tabs(2), 'nope', 0).map((t) => t.id), ['t1', 't2']);
});

// ── Keyboard navigation ───────────────────────────────────────────────

test('Ctrl+Tab / Ctrl+Shift+Tab wrap around; one tab has nowhere to go', () => {
  const s = { tabs: tabs(3), activeId: 't3' };
  assert.equal(stepTabId(s, 1), 't1');
  assert.equal(stepTabId(s, -1), 't2');
  assert.equal(stepTabId({ tabs: tabs(3), activeId: 't1' }, -1), 't3');
  assert.equal(stepTabId({ tabs: tabs(1), activeId: 't1' }, 1), null);
  assert.equal(stepTabId({ tabs: tabs(2), activeId: 'gone' }, 1), 't2'); // unknown active: from the first
});

test('Ctrl+1…8 go to that tab, Ctrl+9 to the last, a missing tab is skipped', () => {
  const t = tabs(4);
  assert.equal(tabForDigit(t, 1), 't1');
  assert.equal(tabForDigit(t, 4), 't4');
  assert.equal(tabForDigit(t, 5), null);
  assert.equal(tabForDigit(t, 9), 't4');
  assert.equal(tabForDigit(tabs(12), 9), 't12');
  assert.equal(tabForDigit(tabs(12), 8), 't8');
  assert.equal(tabForDigit(t, 0), null);
  assert.equal(tabForDigit([], 9), null);
  assert.deepEqual(othersOf(t, 't2'), ['t1', 't3', 't4']);
});

test('closed-tab times: old ones count as 0, new ones get now, reopened ones are forgotten', () => {
  let m = trackClosedTimes(null, ['a', 'b'], 1000);
  assert.deepEqual([...m], [['a', 0], ['b', 0]]);
  m = trackClosedTimes(m, ['c', 'a', 'b'], 2000);
  assert.equal(m.get('c'), 2000);
  assert.equal(m.get('a'), 0);
  assert.equal(newestClosedAt(m), 2000);
  m = trackClosedTimes(m, ['a', 'b'], 3000); // c reopened
  assert.equal(m.has('c'), false);
  assert.equal(newestClosedAt(m), 0);
  assert.equal(newestClosedAt(new Map()), null);
});

test('tab hints say what the tab is and how to close it', () => {
  const h = tabHint({ id: 'x', title: 'Night Drive', path: 'C:\\beats\\Night Drive.kstudio', dirty: true, busy: 'Building the mashup…' }, true, 'Ctrl+W');
  assert.match(h, /Night Drive · C:\\beats/);
  assert.match(h, /unsaved changes · Building the mashup/);
  assert.match(h, /Ctrl\+W closes/);
  assert.match(tabHint({ id: 'y', title: 'Untitled', path: null, dirty: false }, false), /not saved yet\. Click to switch/);
});

// ── Shortcuts ─────────────────────────────────────────────────────────

test('tab shortcuts are bound, Ctrl+T stays the typing piano, and no default combo does two things', () => {
  const map = applyKeymapOverrides(DEFAULT_KEYMAP, null);
  setKeymap(map);
  assert.equal(bindingFor('Ctrl+N')?.command, 'file.new');
  assert.equal(bindingFor('Ctrl+Tab')?.command, 'tabs.next');
  assert.equal(bindingFor('Ctrl+Shift+Tab')?.command, 'tabs.prev');
  assert.equal(bindingFor('Ctrl+W')?.command, 'tabs.close');
  assert.equal(bindingFor('Ctrl+Shift+T')?.command, 'tabs.reopenClosed');
  assert.equal(bindingFor('Ctrl+T')?.command, 'input.toggleTypingPiano');
  for (let n = 1; n <= 9; n++) assert.deepEqual(keysForCommand(map, `tabs.goto${n}`), [`Ctrl+${n}`]);
  assert.equal(bindingFor('Ctrl+Z')?.command, 'edit.undo');
  for (const b of map) {
    const hard = findKeyConflicts(map, b.keys, b.command, b.context).filter((c) => c.kind === 'same-scope');
    assert.deepEqual(hard.map((c) => c.binding.command), [], `${b.keys} (${b.command}) collides`);
  }
});

test('the key events produce the bound combos (Ctrl+digit by physical key, Ctrl+Shift+Tab)', () => {
  const ev = (o: Partial<KeyboardEvent>) => ({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...o }) as KeyboardEvent;
  assert.equal(eventToKeys(ev({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Tab');
  assert.equal(eventToKeys(ev({ key: '&', code: 'Digit1', ctrlKey: true })), 'Ctrl+1'); // AZERTY's 1 key
  assert.equal(eventToKeys(ev({ key: 'w', code: 'KeyW', ctrlKey: true })), 'Ctrl+W');
  assert.equal(eventToKeys(ev({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+T');
});

test('the shortcuts guide lists the tab shortcuts in their own Project tabs section', () => {
  const labels: Record<string, string> = { 'tabs.next': 'Next tab', 'tabs.goto9': 'Go to the last tab' };
  const sections = buildShortcutSections(applyKeymapOverrides(DEFAULT_KEYMAP, null), (c) => labels[c]);
  const s = sections.find((x) => x.title === 'Project tabs');
  assert.ok(s, 'no Project tabs section');
  assert.deepEqual(
    s.rows.map((r) => r.command),
    ['tabs.next', 'tabs.prev', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `tabs.goto${n}`), 'tabs.close', 'tabs.reopenClosed'],
  );
  assert.deepEqual(s.rows.find((r) => r.command === 'tabs.goto9')?.keys, ['Ctrl+9']);
  assert.ok(sections.find((x) => x.title === 'Files')?.rows.some((r) => r.command === 'file.new'));
});

// ── Panel-close undo ──────────────────────────────────────────────────

const rec = (id: string, at: number, extra: Partial<ClosedPanel> = {}): ClosedPanel => ({ id, kind: 'channelRack', placement: { mode: 'floating', bounds: { x: 10, y: 20, width: 800, height: 330 } }, at, ...extra });

test('Ctrl+Z reopens the panel only when its close is newer than the last user edit', () => {
  assert.equal(decideUndo(null, 100), 'doc');
  assert.equal(decideUndo(null, null), 'doc');
  assert.equal(decideUndo(200, null), 'panel');
  assert.equal(decideUndo(200, 100), 'panel');
  assert.equal(decideUndo(100, 200), 'doc');
  assert.equal(decideUndo(150, 150), 'panel'); // same instant: the visible thing comes back
});

test('the last user edit is the newest live entry of the user, not agents, not undone ones', () => {
  const h = [
    { actorKey: 'user', undone: false, time: 100 },
    { actorKey: 'agent:claude', undone: false, time: 400 },
    { actorKey: 'user', undone: true, time: 300 },
    { actorKey: 'user', undone: false, time: 200 },
  ];
  assert.equal(newestUserEditAt(h), 200);
  assert.equal(newestUserEditAt([{ actorKey: 'agent:x', undone: false, time: 5 }]), null);
  assert.equal(newestUserEditAt([]), null);
});

test('interleaved closes and edits unwind newest first', () => {
  // edit @100, close Channel Rack @200, edit @300, close Mixer @400
  const closed = new ClosedPanels();
  const history = [
    { actorKey: 'user', undone: false, time: 100 },
    { actorKey: 'user', undone: false, time: 300 },
  ];
  closed.push(rec('channelRack', 200));
  closed.push(rec('mixer', 400, { kind: 'mixer', placement: { mode: 'docked', neighbour: 'playlist', direction: 'below', size: 330 } }));
  const step = (): string => {
    const p = closed.newest();
    if (decideUndo(p?.at ?? null, newestUserEditAt(history)) === 'panel') return `reopen ${closed.pop()!.id}`;
    const e = [...history].reverse().find((x) => !x.undone);
    if (!e) return 'nothing';
    e.undone = true;
    return `undo @${e.time}`;
  };
  assert.deepEqual([step(), step(), step(), step(), step()], ['reopen mixer', 'undo @300', 'reopen channelRack', 'undo @100', 'nothing']);
});

test('closed panels: one record per panel, capped, prunable', () => {
  const c = new ClosedPanels();
  c.push(rec('channelRack', 1));
  c.push(rec('mixer', 2, { kind: 'mixer' }));
  c.push(rec('channelRack', 3));
  assert.equal(c.size, 2);
  assert.equal(c.newest()?.id, 'channelRack');
  assert.equal(c.newest()?.at, 3);
  c.drop('channelRack'); // opened again with F6
  assert.equal(c.newest()?.id, 'mixer');
  for (let i = 0; i < MAX_CLOSED_PANELS + 5; i++) c.push(rec(`plugin:ch:c${i}`, 10 + i, { kind: 'plugin', target: { kind: 'channel', channelId: `c${i}` } }));
  assert.equal(c.size, MAX_CLOSED_PANELS);
  // a tab switch: plugin windows of channels the new project lacks are forgotten
  const alive = new Set(['c24']);
  const n = c.prune((r) => r.kind === 'plugin' && r.target?.kind === 'channel' && !alive.has(r.target.channelId));
  assert.equal(n, MAX_CLOSED_PANELS - 1);
  assert.equal(c.newest()?.id, 'plugin:ch:c24');
});

test('a plugin window whose channel is gone is skipped, not forgotten (undoing the delete brings it back)', () => {
  const c = new ClosedPanels();
  c.push(rec('channelRack', 100));
  c.push(rec('plugin:ch:lead', 200, { kind: 'plugin', target: { kind: 'channel', channelId: 'lead' } }));
  const channels = new Set<string>(); // the user deleted "lead" after closing its window
  const alive = (r: ClosedPanel): boolean => r.kind !== 'plugin' || (r.target?.kind === 'channel' && channels.has(r.target.channelId));
  assert.equal(c.newestWhere(alive)?.id, 'channelRack');
  channels.add('lead'); // Ctrl+Z restored the channel
  assert.equal(c.newestWhere(alive)?.id, 'plugin:ch:lead');
  assert.equal(c.size, 2);
});

test('Ctrl+Shift+T reopens whichever was closed last, a panel or a tab', () => {
  assert.equal(pickReopen(null, null), null);
  assert.equal(pickReopen(5, null), 'panel');
  assert.equal(pickReopen(null, 5), 'tab');
  assert.equal(pickReopen(10, 5), 'panel');
  assert.equal(pickReopen(5, 10), 'tab');
});

test('a docked panel alone in its group comes back beside the neighbour sharing the longest edge', () => {
  // Playlist fills the top, Mixer below it, Browser on the left of both.
  const browser = { left: 0, top: 0, right: 240, bottom: 700 };
  const playlist = { left: 240, top: 0, right: 1200, bottom: 370 };
  const mixer = { left: 240, top: 370, right: 1200, bottom: 700 };
  assert.deepEqual(dockNeighbour(mixer, [{ id: 'browser', rect: browser }, { id: 'playlist', rect: playlist }]), { id: 'playlist', direction: 'below', size: 330 });
  assert.deepEqual(dockNeighbour(browser, [{ id: 'playlist', rect: playlist }, { id: 'mixer', rect: mixer }]), { id: 'playlist', direction: 'left', size: 240 });
  const agents = { left: 1200, top: 0, right: 1580, bottom: 700 };
  assert.deepEqual(dockNeighbour(agents, [{ id: 'playlist', rect: playlist }, { id: 'mixer', rect: mixer }]), { id: 'playlist', direction: 'right', size: 380 });
  // a corner touch is not an edge
  assert.equal(dockNeighbour({ left: 1200, top: 700, right: 1400, bottom: 900 }, [{ id: 'mixer', rect: mixer }]), null);
  assert.equal(dockNeighbour(mixer, []), null);
});

void run('tabs-ui');
