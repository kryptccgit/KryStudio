import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, run } from './harness';
import type { Project } from '@shared/schema/project';
import { TOURS, TOUR_ORDER, tourById } from '../src/tours/tours';
import {
  EMPTY_MEMORY,
  actOf,
  drumRows,
  isStepDone,
  moveIndex,
  noteFinished,
  noteStarted,
  parseMemory,
  patternClipCount,
  placeCard,
  recoveryFor,
  shouldOfferFirstTour,
  stepsFor,
  textOf,
  tourCardVisible,
} from '../src/tours/logic';
import type { TourCtx, TourSnapshot, TourStep } from '../src/tours/types';
import { GUIDE_ANCHORS, isGuideAnchor } from '../src/guides/anchors';
import { HOME_ACTION_IDS } from '../src/home/logic';

const snap = (over: Partial<TourSnapshot> = {}): TourSnapshot => ({
  homeOpen: false,
  homeScreen: 'home',
  open: ['playlist', 'browser', 'mixer', 'channelRack'],
  visible: ['playlist', 'browser', 'mixer', 'channelRack'],
  playing: false,
  mode: 'pattern',
  bpm: 140,
  projectId: 'prj_a',
  tabCount: 1,
  kick: { id: 'ch_kick', name: 'Kick', steps: 0 },
  clap: { id: 'ch_clap', name: 'Clap', steps: 0 },
  patternClips: 0,
  dirty: false,
  savedPath: null,
  exportOpen: false,
  master: { open: false, songPicked: false, phase: 'idle', ab: 'after', verdict: 'open' },
  agentTab: 'chat',
  mcpClientIds: [],
  mcpClientNames: [],
  installedClients: [],
  hasApiKey: false,
  chatSent: 0,
  keys: [],
  assisted: false,
  ...over,
});

function step(tourId: keyof typeof TOURS, id: string, c: TourCtx = {}): TourStep {
  const s = stepsFor(TOURS[tourId], c).find((x) => x.id === id);
  assert.ok(s, `no step ${tourId}/${id}`);
  return s!;
}

const done = (st: TourStep, s: TourSnapshot, base: TourSnapshot = snap(), c: TourCtx = {}): boolean => isStepDone(st, s, base, c);

test('the five tours are listed in order and found by id', () => {
  assert.deepEqual(TOUR_ORDER, ['first-beat', 'windows', 'song', 'ai', 'master']);
  for (const id of TOUR_ORDER) assert.equal(tourById(id)?.id, id);
  assert.equal(tourById('nope'), undefined);
  assert.deepEqual(
    stepsFor(TOURS['first-beat'], {}).map((s) => s.id),
    ['new-project', 'channel-rack', 'kick', 'play', 'stop', 'clap', 'tempo', 'save', 'next'],
  );
  assert.deepEqual(
    stepsFor(TOURS.song, {}).map((s) => s.id),
    ['mode', 'playlist', 'paint', 'play-song', 'stop-song', 'export', 'export-go'],
  );
});

test('tour 2 opens and closes every window with its key, then teaches Ctrl+Z, Home and Reset layout', () => {
  const ids = stepsFor(TOURS.windows, {}).map((s) => s.id);
  for (const k of ['channelRack', 'pianoRoll', 'playlist', 'mixer', 'browser', 'session']) {
    assert.ok(ids.indexOf(`open-${k}`) >= 0 && ids.indexOf(`close-${k}`) === ids.indexOf(`open-${k}`) + 1, k);
  }
  assert.deepEqual(ids.slice(-7), ['open-guides', 'close-guides', 'lost', 'home', 'leave-home', 'reset', 'end']);
  const keys = Object.fromEntries(stepsFor(TOURS.windows, {}).filter((s) => s.id.startsWith('open-')).map((s) => [s.id, s.keys]));
  assert.deepEqual(keys, { 'open-channelRack': 'F6', 'open-pianoRoll': 'F7', 'open-playlist': 'F5', 'open-mixer': 'F9', 'open-browser': 'Alt+F8', 'open-session': 'F3', 'open-guides': 'F1' });
});

test('tour 4 starts with a chooser and follows only the chosen path', () => {
  const ai = TOURS.ai;
  assert.deepEqual(stepsFor(ai, {}).map((s) => s.id), ['choose']);
  assert.equal(stepsFor(ai, {})[0].choices?.length, 5);
  for (const choice of ['claude-code', 'claude-desktop', 'cursor', 'vscode'] as const) {
    assert.deepEqual(stepsFor(ai, { choice }).map((s) => s.id), ['choose', 'agents-open', 'connect-tab', 'install', 'restart', 'ask', 'safety'], choice);
  }
  assert.deepEqual(stepsFor(ai, { choice: 'api-key' }).map((s) => s.id), ['choose', 'get-key', 'agents-chat', 'paste-key', 'first-message', 'safety']);
  assert.match(textOf(step('ai', 'install', { choice: 'cursor' }).title, { choice: 'cursor' }), /Cursor/);
  assert.match(textOf(step('ai', 'restart', { choice: 'claude-desktop' }).text, { choice: 'claude-desktop' }), /Claude Desktop/);
  assert.match(textOf(step('ai', 'restart', { choice: 'claude-code' }).title, { choice: 'claude-code' }), /session/);
  const key = step('ai', 'get-key', { choice: 'api-key' });
  assert.equal(key.links?.[0].url, 'https://console.anthropic.com/');
  assert.ok(key.notes?.some((n) => /money|costs/i.test(textOf(n, {}))));
  assert.ok(step('ai', 'choose').notes?.some((n) => /Claude plan/.test(textOf(n, {}))));
});

test('every step is well formed: read/choose wait for a click, the rest advance by themselves', () => {
  for (const id of TOUR_ORDER) {
    for (const c of [{}, { choice: 'claude-code' }, { choice: 'api-key' }] as TourCtx[]) {
      const steps = stepsFor(TOURS[id], c);
      assert.equal(new Set(steps.map((s) => s.id)).size, steps.length, `${id}: duplicate step ids`);
      for (const s of steps) {
        const where = `${id}/${s.id}`;
        assert.ok(textOf(s.title, c).length > 0 && textOf(s.text, c).length > 0, `${where}: empty text`);
        assert.ok(textOf(s.text, c).length <= 260, `${where}: keep it to two short sentences`);
        if (s.do === 'read' || s.do === 'choose') assert.equal(s.done, undefined, `${where}: a ${s.do} step advances by its button`);
        else assert.equal(typeof s.done, 'function', `${where}: needs a done predicate`);
        if (s.do === 'key') assert.ok(s.keys, `${where}: a key step names its key`);
        if (s.do === 'key') assert.ok(textOf(s.text, c).includes(`[[${s.keys}]]`), `${where}: show the key as [[${s.keys}]]`);
      }
      if (steps.length > 1 || id !== 'ai') assert.equal(steps[steps.length - 1].do, 'read', `${id}: ends on a read card`);
    }
  }
});

test('moveIndex: clamps at the start, null past the end', () => {
  assert.equal(moveIndex(0, -1, 5), 0);
  assert.equal(moveIndex(2, 1, 5), 3);
  assert.equal(moveIndex(4, 1, 5), null);
});

test('tour 1 done predicates', () => {
  const base = snap();
  assert.equal(done(step('first-beat', 'new-project'), snap(), base), false);
  assert.equal(done(step('first-beat', 'new-project'), snap({ projectId: 'prj_b' }), base), true);
  assert.equal(done(step('first-beat', 'new-project'), snap({ tabCount: 2 }), base), true);

  const kick = step('first-beat', 'kick');
  assert.equal(done(kick, snap({ kick: { id: 'k', name: 'Kick', steps: 3 } })), false);
  assert.equal(done(kick, snap({ kick: { id: 'k', name: 'Kick', steps: 4 } })), true);
  assert.equal(done(kick, snap({ kick: null })), false);
  assert.equal(kick.progress?.(snap({ kick: { id: 'k', name: 'Kick', steps: 2 } }), base, {}), 'Kick: 2 of 4 boxes lit');

  assert.equal(done(step('first-beat', 'play'), snap({ playing: true })), true);
  assert.equal(done(step('first-beat', 'play'), snap()), false);
  assert.equal(done(step('first-beat', 'stop'), snap({ playing: true })), false);
  assert.equal(done(step('first-beat', 'stop'), snap()), true);

  const clap = step('first-beat', 'clap');
  const clapBase = snap({ clap: { id: 'c', name: 'Clap', steps: 1 } });
  assert.equal(done(clap, snap({ clap: { id: 'c', name: 'Clap', steps: 2 } }), clapBase), false, 'two NEW boxes');
  assert.equal(done(clap, snap({ clap: { id: 'c', name: 'Clap', steps: 3 } }), clapBase), true);

  assert.equal(done(step('first-beat', 'tempo'), snap({ bpm: 140 }), base), false);
  assert.equal(done(step('first-beat', 'tempo'), snap({ bpm: 120 }), base), true);

  const save = step('first-beat', 'save');
  const dirty = snap({ dirty: true });
  assert.equal(done(save, snap({ dirty: true, savedPath: null }), dirty), false);
  assert.equal(done(save, snap({ dirty: true, savedPath: 'C:\\beat.kstudio' }), dirty), false, 'still unsaved');
  assert.equal(done(save, snap({ dirty: false, savedPath: 'C:\\beat.kstudio' }), dirty), true);
  assert.equal(done(save, snap({ savedPath: 'C:\\old.kstudio' }), snap({ savedPath: 'C:\\old.kstudio' })), false, 'already saved before: needs a save');
});

test('tour 2 done predicates: the key must open it, closing means gone', () => {
  const open = step('windows', 'open-mixer');
  const hidden = snap({ open: [], visible: [] });
  assert.equal(done(open, snap({ open: ['mixer'], visible: ['mixer'] }), hidden), true, 'was closed, now open');
  const already = snap({ visible: ['mixer'], open: ['mixer'] });
  assert.equal(done(open, already, already), false, 'already open: waits for the key');
  assert.equal(done(open, snap({ visible: ['mixer'], open: ['mixer'], keys: ['F9'] }), already), true);
  assert.equal(done(open, snap({ visible: ['mixer'], open: ['mixer'], assisted: true }), already), true, 'do it for me');
  assert.equal(done(step('windows', 'close-mixer'), snap({ open: ['playlist'] })), true);
  assert.equal(done(step('windows', 'close-mixer'), snap({ open: ['mixer'], visible: [] })), false, 'behind another tab is still open');
  assert.equal(done(step('windows', 'lost'), snap({ open: ['guides'] }), snap({ open: [] })), true);
  assert.equal(done(step('windows', 'lost'), snap({ open: [] }), snap({ open: [] })), false);
  assert.equal(done(step('windows', 'home'), snap({ homeOpen: true })), true);
  assert.equal(done(step('windows', 'leave-home'), snap({ homeOpen: true })), false);
  assert.equal(done(step('windows', 'reset'), snap({ open: ['guides'] })), false);
  assert.equal(done(step('windows', 'reset'), snap()), true);
  assert.ok(step('windows', 'home').keepEsc && step('windows', 'leave-home').keepEsc, 'Esc goes to Home on the Home steps');
});

test('tour 3 done predicates', () => {
  assert.equal(done(step('song', 'mode'), snap({ mode: 'song' })), true);
  assert.equal(done(step('song', 'mode'), snap()), false);
  const paint = step('song', 'paint');
  assert.equal(done(paint, snap({ patternClips: 1 }), snap()), true);
  assert.equal(done(paint, snap({ patternClips: 3 }), snap({ patternClips: 3 })), false, 'needs a new block');
  assert.equal(done(paint, snap({ patternClips: 4 }), snap({ patternClips: 3 })), true);
  assert.equal(done(step('song', 'play-song'), snap({ playing: true })), true);
  assert.equal(done(step('song', 'export'), snap({ exportOpen: true })), true);
  assert.equal(done(step('song', 'export'), snap()), false);
});

test('tour 4 done predicates', () => {
  const cc: TourCtx = { choice: 'claude-desktop' };
  assert.equal(done(step('ai', 'agents-open', cc), snap({ visible: ['agent'] }), snap(), cc), true);
  assert.equal(done(step('ai', 'connect-tab', cc), snap({ visible: ['agent'], agentTab: 'chat' }), snap(), cc), false);
  assert.equal(done(step('ai', 'connect-tab', cc), snap({ visible: ['agent'], agentTab: 'connect' }), snap(), cc), true);
  const install = step('ai', 'install', cc);
  assert.equal(done(install, snap({ installedClients: ['cursor'] }), snap(), cc), false, 'another client');
  assert.equal(done(install, snap({ installedClients: ['claude-desktop'] }), snap(), cc), true);
  assert.equal(done(install, snap({ mcpClientIds: ['c1'] }), snap(), cc), true, 'set up by hand and already connected');
  const ask = step('ai', 'ask', cc);
  assert.equal(done(ask, snap({ mcpClientIds: ['old'] }), snap({ mcpClientIds: ['old'] }), cc), false);
  assert.equal(done(ask, snap({ mcpClientIds: ['old', 'new'], mcpClientNames: ['A', 'Claude'] }), snap({ mcpClientIds: ['old'] }), cc), true);
  assert.equal(ask.progress?.(snap({ mcpClientNames: ['Claude'] }), snap(), cc), 'Connected: Claude');
  assert.equal(ask.act, undefined, "can't type in another app for you");

  const key: TourCtx = { choice: 'api-key' };
  assert.equal(done(step('ai', 'agents-chat', key), snap({ visible: ['agent'], agentTab: 'chat' }), snap(), key), true);
  assert.equal(done(step('ai', 'paste-key', key), snap({ hasApiKey: true }), snap(), key), true);
  assert.equal(done(step('ai', 'first-message', key), snap({ chatSent: 1 }), snap(), key), true);
  assert.equal(done(step('ai', 'first-message', key), snap({ chatSent: 2 }), snap({ chatSent: 2 }), key), false);
});

test('a throwing predicate never advances', () => {
  const bad: TourStep = { id: 'x', do: 'click', title: 't', text: 't', done: () => { throw new Error('boom'); } };
  assert.equal(isStepDone(bad, snap(), snap(), {}), false);
  assert.equal(isStepDone({ id: 'r', do: 'read', title: 't', text: 't' }, snap(), snap(), {}), false);
});

test('"Do it for me" actions are real: commands exist, panels exist, steps hit the right rows', () => {
  const actionsSrc = readFileSync(path.join(SRC, 'app', 'actions.ts'), 'utf8');
  const commandExists = (id: string): boolean => actionsSrc.includes(`id: '${id}'`) || /^view\.toggle\./.test(id);
  for (const id of TOUR_ORDER) {
    for (const c of [{}, { choice: 'cursor' }, { choice: 'api-key' }] as TourCtx[]) {
      for (const s of stepsFor(TOURS[id], c)) {
        for (const a of [actOf(s, c), s.onEnter ?? null]) {
          if (!a) continue;
          if (a.kind === 'command') assert.ok(commandExists(a.id), `${id}/${s.id}: unknown command ${a.id}`);
          if (a.kind === 'open' || a.kind === 'close') assert.ok(['channelRack', 'pianoRoll', 'playlist', 'mixer', 'browser', 'session', 'guides', 'agent'].includes(a.panel), `${id}/${s.id}: ${a.panel}`);
        }
        if (s.command) assert.ok(commandExists(s.command), `${id}/${s.id}: unknown command ${s.command}`);
      }
    }
  }
  assert.deepEqual(actOf(step('first-beat', 'kick'), {}), { kind: 'steps', row: 'kick', steps: [0, 4, 8, 12] });
  assert.deepEqual(actOf(step('ai', 'install', { choice: 'vscode' }), { choice: 'vscode' }), { kind: 'installClient' });
});

function project(channels: string[], steps: Record<string, number[]>, clips = 0): Project {
  const ch = Object.fromEntries(channels.map((n, i) => [`ch${i}`, { id: `ch${i}`, name: n }]));
  const notes: Record<string, Record<string, { id: string; tick: number }>> = {};
  channels.forEach((n, i) => {
    const list = steps[n] ?? [];
    notes[`ch${i}`] = Object.fromEntries(list.map((t, j) => [`n${j}`, { id: `n${j}`, tick: t }]));
  });
  const clipMap = Object.fromEntries(Array.from({ length: clips }, (_, i) => [`cl${i}`, { id: `cl${i}`, kind: 'pattern' }]));
  return {
    channels: ch,
    channelOrder: Object.keys(ch),
    patterns: { p1: { id: 'p1', notes } },
    transport: { activePatternId: 'p1' },
    playlist: { clips: { ...clipMap, a1: { id: 'a1', kind: 'audio' } } },
  } as unknown as Project;
}

test('drumRows: the Kick and Clap rows by name, with fallbacks; steps count distinct boxes', () => {
  const p = project(['Hat', 'Big Kick', 'Snare', 'Clap'], { 'Big Kick': [0, 960, 1920, 1920, 100], Clap: [960] });
  const r = drumRows(p);
  assert.deepEqual(r.kick, { id: 'ch1', name: 'Big Kick', steps: 3 }, 'two notes on one box count once; off-grid notes do not count');
  assert.deepEqual(r.clap, { id: 'ch3', name: 'Clap', steps: 1 });
  assert.equal(drumRows(project(['Snare', 'Bass'], {})).clap?.name, 'Bass', 'no kick: the first row is the kick, the next the clap');
  assert.equal(drumRows(project(['Kick', 'Snare'], {})).clap?.name, 'Snare');
  assert.deepEqual(drumRows(project([], {})), { kick: null, clap: null });
  assert.deepEqual(drumRows(null), { kick: null, clap: null });
  assert.equal(patternClipCount(project(['Kick'], {}, 3)), 3, 'audio clips do not count');
});

test('recovery: Home covering the Studio comes first, except for title-bar targets', () => {
  const kick = step('first-beat', 'kick');
  assert.equal(recoveryFor(kick, 'ok', snap(), {}), null);
  assert.deepEqual(recoveryFor(kick, 'covered', snap({ homeOpen: true }), {})?.action, { kind: 'leaveHome' });
  const save = step('first-beat', 'save');
  assert.notDeepEqual(recoveryFor(save, 'missing', snap({ homeOpen: true }), {})?.action, { kind: 'leaveHome' });
  assert.equal(recoveryFor({ id: 'r', do: 'read', title: 't', text: 't' }, 'missing', snap(), {}), null, 'anchorless steps never need it');
});

test('recovery: a closed panel is opened, named with its key', () => {
  const r = recoveryFor(step('first-beat', 'channel-rack'), 'missing', snap({ visible: [] }), {});
  assert.deepEqual(r?.action, { kind: 'open', panel: 'channelRack' });
  assert.match(r!.message, /Channel Rack is closed/);
  assert.match(r!.message, /\[\[F6\]\]/);
  assert.deepEqual(recoveryFor(step('song', 'paint'), 'missing', snap({ visible: [] }), {})?.action, { kind: 'open', panel: 'playlist' });
  const tab = recoveryFor(step('ai', 'install', { choice: 'cursor' }), 'missing', snap({ visible: [] }), { choice: 'cursor' });
  assert.deepEqual(tab?.action, { kind: 'open', panel: 'agent' });
  assert.match(tab!.message, /AI button/);
});

test("recovery: a step's own advice, a detached window, something on top, else reset the layout", () => {
  const kick = step('first-beat', 'kick');
  assert.deepEqual(recoveryFor(kick, 'missing', snap({ kick: null }), {})?.action, { kind: 'command', id: 'file.new' }, 'no drum rows: start a new project');
  const cc: TourCtx = { choice: 'cursor' };
  assert.deepEqual(recoveryFor(step('ai', 'install', cc), 'missing', snap({ visible: ['agent'] }), cc)?.action, { kind: 'agentTab', tab: 'connect' });
  assert.deepEqual(recoveryFor(step('ai', 'paste-key', { choice: 'api-key' }), 'missing', snap({ visible: ['agent'] }), { choice: 'api-key' })?.action, { kind: 'agentTab', tab: 'chat' });
  assert.deepEqual(recoveryFor(step('first-beat', 'channel-rack'), 'elsewhere', snap(), {})?.action, { kind: 'resetLayout' });
  assert.deepEqual(recoveryFor(step('first-beat', 'channel-rack'), 'covered', snap(), {})?.action, { kind: 'open', panel: 'channelRack' });
  assert.deepEqual(recoveryFor(step('first-beat', 'play'), 'missing', snap(), {})?.action, { kind: 'resetLayout' });
});

test('placeCard: below, above, beside, else over; always inside the window', () => {
  const view = { width: 1280, height: 800 };
  const card = { width: 460, height: 300 };
  const inside = (p: { left: number; top: number }, v = view): void => {
    assert.ok(p.left >= 12 && p.left + card.width <= v.width - 12 + 0.01, `x ${p.left}`);
    assert.ok(p.top >= 0 && p.top + card.height <= v.height, `y ${p.top}`);
  };
  const top = placeCard({ left: 20, top: 10, width: 40, height: 24 }, card, view);
  assert.equal(top.side, 'below');
  inside(top);
  const bottom = placeCard({ left: 1200, top: 760, width: 60, height: 30 }, card, view);
  assert.equal(bottom.side, 'above');
  inside(bottom);
  assert.equal(placeCard({ left: 20, top: 100, width: 300, height: 600 }, card, view).side, 'right');
  assert.equal(placeCard({ left: 800, top: 100, width: 460, height: 600 }, card, view).side, 'left');
  const huge = placeCard({ left: 0, top: 0, width: 1280, height: 800 }, card, view);
  assert.equal(huge.side, 'over');
  inside(huge);
  const tiny = { width: 500, height: 360 };
  inside(placeCard({ left: 100, top: 100, width: 50, height: 50 }, { width: 476, height: 300 }, tiny), tiny);
});

test('the first tour is offered once, never to someone who already took a tour, never without storage', () => {
  const ok = { storageOk: true, active: false };
  assert.equal(shouldOfferFirstTour(EMPTY_MEMORY, ok), true);
  assert.equal(shouldOfferFirstTour({ ...EMPTY_MEMORY, offered: true }, ok), false, 'once');
  assert.equal(shouldOfferFirstTour(noteStarted(EMPTY_MEMORY, 'ai'), ok), false);
  assert.equal(shouldOfferFirstTour(EMPTY_MEMORY, { storageOk: false, active: false }), false, "can't remember the answer: don't nag");
  assert.equal(shouldOfferFirstTour(EMPTY_MEMORY, { storageOk: true, active: true }), false);
  const stored = JSON.stringify({ ...EMPTY_MEMORY, offered: true });
  assert.equal(shouldOfferFirstTour(parseMemory(stored), ok), false);
});

test('tour memory: parsing junk, started / finished, the Home card', () => {
  assert.deepEqual(parseMemory(null), EMPTY_MEMORY);
  assert.deepEqual(parseMemory('{nope'), EMPTY_MEMORY);
  assert.deepEqual(parseMemory('42'), EMPTY_MEMORY);
  assert.deepEqual(parseMemory(JSON.stringify({ offered: 'yes', started: ['ai', 'bogus', 7], finished: 'x' })), { offered: false, started: ['ai'], finished: [], cardHidden: false });
  const m = noteFinished(noteStarted(noteStarted(EMPTY_MEMORY, 'song'), 'song'), 'song');
  assert.deepEqual(m.started, ['song']);
  assert.deepEqual(noteFinished(m, 'song').finished, ['song']);
  assert.equal(tourCardVisible(EMPTY_MEMORY), true);
  assert.equal(tourCardVisible(noteFinished(EMPTY_MEMORY, 'first-beat')), false);
  assert.equal(tourCardVisible({ ...EMPTY_MEMORY, cardHidden: true }), false);
  assert.equal(tourCardVisible(noteFinished(EMPTY_MEMORY, 'song')), true);
});

const SRC = path.resolve(process.cwd(), 'src');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

test('every guide anchor a tour uses is registered, and the data-tour hooks are on real elements', () => {
  for (const id of TOUR_ORDER) {
    for (const c of [{}, { choice: 'claude-code' }, { choice: 'api-key' }] as TourCtx[]) {
      for (const s of stepsFor(TOURS[id], c)) if (s.anchor?.guide) assert.ok(isGuideAnchor(s.anchor.guide), `${id}/${s.id}: ${s.anchor.guide}`);
    }
  }
  for (const a of ['titlebar.home', 'titlebar.view', 'playlist.grid', 'agent.status', 'agent.apiKey'] as const) assert.ok(GUIDE_ANCHORS[a], a);
  const all = sources(SRC)
    .filter((f) => !f.includes(`${path.sep}tours${path.sep}`))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  for (const hook of ['data-tour-steps=', 'data-tour-panel=', 'data-tour-tab=', 'data-tour-client=']) assert.ok(all.includes(hook), `${hook} is set somewhere in src/`);
  assert.equal(step('first-beat', 'kick').anchor?.selector?.(snap(), {}), '[data-tour-steps="ch_kick"]');
  assert.equal(step('first-beat', 'kick').anchor?.selector?.(snap({ kick: null }), {}), null);
  assert.equal(step('ai', 'install', { choice: 'vscode' }).anchor?.selector?.(snap(), { choice: 'vscode' }), '[data-tour-client="vscode"]');
});

test('guides and Home can start every tour', () => {
  for (const id of ['tours', 'tourFirstBeat', 'tourWindows', 'tourSong', 'tourAi', 'tourMaster']) assert.ok((HOME_ACTION_IDS as readonly string[]).includes(id), id);
});

const mastering = (over: Partial<TourSnapshot['master']> = {}): TourSnapshot['master'] => ({ open: true, songPicked: false, phase: 'idle', ab: 'after', verdict: 'open', ...over });

test('tour 5 walks Home ▸ Audio Tools ▸ Master a song… ▸ your song ▸ style ▸ Master my song ▸ wait ▸ Before / After ▸ Keep ▸ Export', () => {
  assert.deepEqual(
    stepsFor(TOURS.master, {}).map((s) => s.id),
    ['home', 'tools', 'open', 'song', 'style', 'run', 'wait', 'compare', 'keep', 'export', 'export-go'],
  );
  assert.ok(done(step('master', 'home'), snap({ homeOpen: true })));
  assert.ok(!done(step('master', 'home'), snap()));
  assert.ok(!done(step('master', 'tools'), snap({ homeOpen: true })));
  assert.ok(done(step('master', 'tools'), snap({ homeOpen: true, homeScreen: 'audio' })));
  assert.deepEqual(actOf(step('master', 'tools'), {}), { kind: 'showHome', screen: 'audio' });
  assert.ok(!done(step('master', 'open'), snap({ homeOpen: true })));
  assert.ok(done(step('master', 'open'), snap({ homeOpen: true, master: mastering() })));
  assert.deepEqual(actOf(step('master', 'open'), {}), { kind: 'masterSong' });
  assert.equal(step('master', 'open').anchor?.chrome, true);
  assert.deepEqual(recoveryFor(step('master', 'open'), 'missing', snap({ homeOpen: true }), {})?.action, { kind: 'showHome', screen: 'audio' });
  assert.equal(recoveryFor(step('master', 'open'), 'ok', snap({ homeOpen: true }), {}), null);
  assert.ok(!done(step('master', 'song'), snap({ master: mastering() })));
  assert.ok(done(step('master', 'song'), snap({ master: mastering({ songPicked: true }) })));
  assert.equal(step('master', 'song').anchor?.guide, 'automix.song');
  assert.ok(!done(step('master', 'run'), snap({ master: mastering({ songPicked: true }) })), 'picking the song is not running it');
  assert.ok(done(step('master', 'run'), snap({ master: mastering({ songPicked: true, phase: 'running' }) })));
  assert.ok(!done(step('master', 'wait'), snap({ master: mastering({ phase: 'running' }) })));
  assert.ok(done(step('master', 'wait'), snap({ master: mastering({ phase: 'done' }) })));
  assert.match(step('master', 'wait').progress!(snap({ master: mastering({ phase: 'idle' }) }), snap(), {}) ?? '', /hasn't started/);
  assert.match(step('master', 'wait').progress!(snap({ master: mastering({ phase: 'failed' }) }), snap(), {}) ?? '', /didn't finish/);
  const after = snap({ master: mastering({ phase: 'done' }) });
  assert.ok(!done(step('master', 'compare'), after, after));
  assert.ok(done(step('master', 'compare'), snap({ master: mastering({ phase: 'done', ab: 'before' }) }), after));
  assert.ok(!done(step('master', 'keep'), after));
  assert.ok(done(step('master', 'keep'), snap({ master: mastering({ phase: 'done', verdict: 'kept' }) })));
  assert.ok(done(step('master', 'export'), snap({ exportOpen: true })));
  for (const id of ['style', 'run']) assert.equal(step('master', id).anchor?.guide, 'automix.run');
  assert.equal(step('master', 'compare').anchor?.guide, 'automix.ab');
  assert.match(step('master', 'keep').anchor?.selector?.(snap(), {}) ?? '', /aria-label="Master a song"\] \[data-autofocus\]/);
});

test('tour 5 uses the dialog’s real labels and the Audio Tools cards that exist', () => {
  const dialog = readFileSync(path.join(SRC, 'automix', 'AutoMixDialog.tsx'), 'utf8');
  assert.match(dialog, /Choose your song…/);
  assert.match(dialog, /Master my song/);
  assert.match(dialog, /Pick a reference song…/);
  assert.match(dialog, /data-guide="automix\.song"/);
  assert.match(dialog, /'Master a song'/);
  assert.match(dialog, /data-guide="automix\.run"/);
  assert.match(dialog, /data-guide="automix\.ab"/);
  assert.match(dialog, /data-autofocus onClick=\{\(\) => void keepResult\(\)\}/, 'Keep is the result’s default button');
  const card = readFileSync(path.join(SRC, 'home', 'screens', 'AudioToolsScreen.tsx'), 'utf8');
  assert.match(card, /data-guide="home\.masterSong"/);
  assert.match(card, /Master a song…/);
  assert.ok(isGuideAnchor('home.masterSong'));
  assert.ok(isGuideAnchor('home.audioTools'));
  assert.match(readFileSync(path.join(SRC, 'home', 'HomeView.tsx'), 'utf8'), /'home\.audioTools'/, 'the Audio Tools card carries the anchor');
});

void run('tours');
