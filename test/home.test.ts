import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, run } from './harness';
import type { AnalyzerState, EngineStatus, McpStatus, PluginManagerState } from '@shared/types';
import type { Collection, LibraryState } from '@shared/library/types';
import { CATALOG } from '@shared/plugins/catalog';
import { MODEL_CATALOG } from '@shared/analyzer/models';
import {
  HOME_ACTION_IDS,
  TIPS,
  agentsPill,
  audioToolsPill,
  recordingPill,
  guidesPill,
  isFirstRun,
  isHomeActionId,
  libraryPill,
  masterCardActions,
  pluginsPill,
  projectsPill,
  settingsPill,
  shapeRecent,
  shouldOpenHome,
  splitProjectPath,
  studioPill,
  tipAt,
} from '../src/home/logic';
import { ARTICLES, DEFAULT_ARTICLE, GUIDE_GROUPS, PLUGIN_NOTES, articleById } from '../src/guides/articles';
import { blockInlines, guideActionIds, inlineText, parseGuide, parseInline, type GuideBlock } from '../src/guides/markup';

const blockText = (b: GuideBlock): string => ('text' in b ? inlineText(b.text) : '');
import { buildShortcutSections, fallbackLabel } from '../src/guides/shortcuts';
import { DEFAULT_KEYMAP, applyKeymapOverrides, findKeyConflicts, isBareCombo } from '../src/input/keymap';

const mcp = (over: Partial<McpStatus> = {}): McpStatus => ({ enabled: true, pipeName: 'p', http: { enabled: false, url: null }, clients: [], shimPath: null, ...over });
const client = (name: string) => ({ clientId: name.toLowerCase(), name, connectedAt: 1, calls: 0 });

const collection = (id: string, total: number): Collection => ({
  id,
  name: id,
  tags: [],
  createdAt: 0,
  folders: [],
  deep: false,
  counts: { total, pending: 0, light: total, deep: 0, failed: 0, missing: 0 },
});
const lib = (over: Partial<LibraryState> = {}): LibraryState => ({
  collections: [],
  queue: { running: false, paused: false, phase: null, done: 0, total: 0, current: null, etaSec: null },
  focus: null,
  dbPath: 'x',
  ...over,
});

const analyzer = (over: Partial<AnalyzerState> = {}): AnalyzerState => ({
  available: true,
  running: true,
  pid: 1,
  version: '1',
  devices: [],
  models: MODEL_CATALOG.map((def) => ({ def, status: def.bundled ? 'installed' : 'available' })),
  jobs: [],
  modelsDir: 'm',
  ...over,
});

const plugins = (over: Partial<PluginManagerState> = {}): PluginManagerState => ({
  plugins: [],
  files: [],
  blocked: [],
  folders: [],
  scanning: false,
  progress: null,
  lastScanAt: null,
  vst2Found: 0,
  hostAvailable: true,
  hostPid: null,
  instances: [],
  ...over,
});

const engine = (state: EngineStatus['state'], device: Partial<NonNullable<EngineStatus['device']>> | null = null): EngineStatus => ({
  state,
  device: device ? { open: false, id: null, name: null, backend: 'wasapi', sampleRate: 48000, bufferFrames: 256, outputLatencyMs: 10, ...device } : null,
  engineVersion: '1',
  restarts: 0,
});

test('studio pill: project name, unsaved dot, recovered warning; nothing without a name', () => {
  assert.deepEqual(studioPill({ name: 'Neon Fog', dirty: false }), { text: 'Neon Fog', tone: 'neutral', dot: false, hint: 'Neon Fog is open' });
  const dirty = studioPill({ name: 'Neon Fog', dirty: true });
  assert.equal(dirty?.dot, true);
  assert.match(dirty?.hint ?? '', /unsaved/);
  assert.equal(studioPill({ name: 'X', dirty: true, recovered: true })?.tone, 'warn');
  assert.equal(studioPill({ name: '  ', dirty: false }), null);
  assert.equal(studioPill({ name: null, dirty: false }), null);
  const long = studioPill({ name: 'A very long project name that keeps going on', dirty: false });
  assert.ok((long?.text.length ?? 0) <= 28 && long?.text.endsWith('…'));
});

test('projects pill: "N recent", nothing when empty or unknown', () => {
  assert.equal(projectsPill(null), null);
  assert.equal(projectsPill([]), null);
  assert.equal(projectsPill(['a', 'b', 'c'])?.text, '3 recent');
});

test('agents pill: unknown → nothing, kill switch, not connected, connected clients', () => {
  assert.equal(agentsPill(null), null);
  assert.deepEqual(agentsPill(mcp({ enabled: false }))?.text, 'Agents off');
  assert.equal(agentsPill(mcp({ enabled: false }))?.tone, 'warn');
  assert.equal(agentsPill(mcp())?.text, 'Not connected');
  assert.equal(agentsPill(mcp())?.tone, 'neutral');
  const one = agentsPill(mcp({ clients: [client('Claude Code')] }));
  assert.equal(one?.text, 'Claude Code connected');
  assert.equal(one?.tone, 'live');
  assert.equal(agentsPill(mcp({ clients: [client('Claude Code'), client('Cursor'), client('VS Code')] }))?.text, 'Claude Code + 2 more');
});

test('library pill: focus first, then queue progress, then track count, else Empty', () => {
  assert.equal(libraryPill(null), null);
  assert.equal(libraryPill(lib())?.text, 'Empty');
  assert.equal(libraryPill(lib({ collections: [collection('a', 0)] }))?.text, 'Empty');
  assert.equal(libraryPill(lib({ collections: [collection('a', 1000), collection('b', 500)] }))?.text, '1,500 tracks');
  assert.equal(libraryPill(lib({ collections: [collection('a', 1)] }))?.text, '1 track');
  const q = lib({ collections: [collection('a', 40)], queue: { running: true, paused: false, phase: 'light', done: 2, total: 40, current: null, etaSec: null } });
  assert.equal(libraryPill(q)?.text, 'Analysing 3 of 40');
  assert.equal(libraryPill(q)?.tone, 'live');
  const f = libraryPill(lib({ ...q, focus: { collectionId: 'a', name: 'Dark trap', brief: '' } }));
  assert.equal(f?.text, 'Focus: Dark trap');
  assert.equal(f?.tone, 'accent');
});

test('audio tools pill: missing analyzer, jobs, GPU only when known, installed model count', () => {
  assert.equal(audioToolsPill(null), null);
  assert.equal(audioToolsPill(analyzer({ available: false }))?.text, 'Analyzer missing');
  const bundled = MODEL_CATALOG.filter((m) => m.bundled).length;
  assert.equal(audioToolsPill(analyzer())?.text, `${bundled} model${bundled === 1 ? '' : 's'}`, 'devices unknown: say nothing about them');
  assert.equal(audioToolsPill(analyzer({ devices: ['cpu', 'directml'] }))?.text, `GPU · ${bundled} models`);
  assert.equal(audioToolsPill(analyzer({ devices: ['cpu'] }))?.text, `CPU · ${bundled} models`);
  const job = { id: 'j', kind: 'separate' as const, label: 'Separating "Loop"', stage: 'separating', fraction: 0.42, startedAt: 0 };
  assert.equal(audioToolsPill(analyzer({ jobs: [job] }))?.text, 'Separating stems 42%');
  assert.equal(audioToolsPill(analyzer({ jobs: [{ ...job, fraction: -1 }] }))?.text, 'Separating stems…');
  assert.equal(audioToolsPill(analyzer({ jobs: [job, job] }))?.text, '2 jobs running');
});

test('plugins pill: scanning progress, plugin count, stock only', () => {
  assert.equal(pluginsPill(null), null);
  assert.equal(pluginsPill(plugins())?.text, 'Stock only');
  assert.equal(pluginsPill(plugins({ scanning: true, progress: { done: 3, total: 10, current: null } }))?.text, 'Scanning 3/10');
  assert.equal(pluginsPill(plugins({ scanning: true }))?.text, 'Scanning…');
  const d = { id: 'vst3:x', name: 'X', kind: 'effect' as const, category: 'Fx', description: '', params: [] };
  assert.equal(pluginsPill(plugins({ plugins: [d, { ...d, id: 'vst3:y' }] }))?.text, '2 plugins');
});

test('guides pill only for first-run users; a returning (welcome-seen) user is not first-run', () => {
  assert.equal(guidesPill(true)?.text, 'Start here');
  assert.equal(guidesPill(false), null);
  assert.equal(isFirstRun({ guidesSeen: false, welcomeSeen: false }), true);
  assert.equal(isFirstRun({ guidesSeen: true, welcomeSeen: false }), false);
  assert.equal(isFirstRun({ guidesSeen: false, welcomeSeen: true }), false);
});

test('recording pill: armed wins, then the open mic, then a ready vocal setup, else nothing', () => {
  assert.equal(recordingPill(false, null, false), null);
  assert.deepEqual([recordingPill(true, { open: true, name: 'USB Mic' }, true)?.text, recordingPill(true, null, false)?.tone], ['Armed', 'danger']);
  assert.equal(recordingPill(false, { open: true, name: 'Focusrite USB Audio (2- Scarlett Solo)' }, true)?.text, 'Mic: Focusrite USB Audio…');
  assert.equal(recordingPill(false, { open: false, name: 'USB Mic' }, true)?.text, 'Vocals ready');
});

test('settings pill: device name when open, "No audio device", engine states', () => {
  assert.equal(settingsPill(null), null);
  assert.equal(settingsPill(engine('running', { open: true, name: 'Speakers (Realtek)' }))?.text, 'Speakers (Realtek)');
  assert.equal(settingsPill(engine('running', { open: true, name: 'Speakers (Realtek)' }))?.tone, 'live');
  assert.equal(settingsPill(engine('running', { open: false }))?.text, 'No audio device');
  assert.equal(settingsPill(engine('running'))?.text, 'No audio device');
  assert.equal(settingsPill(engine('starting'))?.text, 'Engine starting');
  assert.equal(settingsPill(engine('restarting'))?.tone, 'warn');
  assert.equal(settingsPill(engine('failed'))?.tone, 'danger');
  assert.equal(settingsPill(engine('stopped'))?.text, 'Engine stopped');
});

test('splitProjectPath: name without .kstudio, parent folder', () => {
  assert.deepEqual(splitProjectPath('C:\\Beats\\Neon Fog.kstudio'), { name: 'Neon Fog', folder: 'C:\\Beats' });
  assert.deepEqual(splitProjectPath('D:/x/y/Song.KSTUDIO'), { name: 'Song', folder: 'D:/x/y' });
  assert.deepEqual(splitProjectPath('Loose.kstudio'), { name: 'Loose', folder: '' });
});

test('shapeRecent: de-duplicates case-insensitively, drops the open project, caps, attaches last-opened', () => {
  const recent = ['C:\\A\\One.kstudio', 'c:\\a\\one.KSTUDIO', 'C:/A/Two.kstudio', 'C:\\A\\Three.kstudio', '', 'C:\\A\\Four.kstudio'];
  const all = shapeRecent(recent, { limit: 10 });
  assert.deepEqual(
    all.map((r) => r.name),
    ['One', 'Two', 'Three', 'Four'],
  );
  const noCurrent = shapeRecent(recent, { currentPath: 'C:\\A\\TWO.kstudio', limit: 10 });
  assert.deepEqual(
    noCurrent.map((r) => r.name),
    ['One', 'Three', 'Four'],
    'forward and back slashes are the same path',
  );
  assert.equal(shapeRecent(recent, { limit: 2 }).length, 2);
  const withTimes = shapeRecent(recent, { openedAt: { 'c:\\a\\three.kstudio': 1234, 'c:\\a\\one.kstudio': Number.NaN } });
  assert.equal(withTimes.find((r) => r.name === 'Three')?.lastOpened, 1234);
  assert.equal(withTimes.find((r) => r.name === 'One')?.lastOpened, null, 'a bad timestamp is unknown, not 1970');
  assert.deepEqual(shapeRecent(null), []);
  assert.deepEqual(shapeRecent(['x.kstudio'], { limit: 0 }), []);
});

test('open to Home: on by default, off when the setting is off, never when launched with a file', () => {
  assert.equal(shouldOpenHome({ openToHome: undefined, openedWithFile: false }), true, 'older settings files lack the field');
  assert.equal(shouldOpenHome({ openToHome: true, openedWithFile: false }), true);
  assert.equal(shouldOpenHome({ openToHome: false, openedWithFile: false }), false);
  assert.equal(shouldOpenHome({ openToHome: true, openedWithFile: true }), false, 'file association / second instance / drop → the Studio');
  assert.equal(shouldOpenHome({ openToHome: undefined, openedWithFile: true }), false);
});

test('tips rotate and wrap; every tip is unique and short', () => {
  assert.ok(TIPS.length >= 8);
  assert.equal(new Set(TIPS).size, TIPS.length);
  assert.equal(tipAt(0), TIPS[0]);
  assert.equal(tipAt(TIPS.length), TIPS[0]);
  assert.equal(tipAt(TIPS.length + 3), TIPS[3]);
  assert.equal(tipAt(-1), TIPS[TIPS.length - 1]);
  assert.equal(tipAt(5, []), '');
  for (const t of TIPS) assert.ok(t.length <= 130, `tip too long for one line: ${t}`);
});

test('bare combos (blocked on Home) vs shortcuts that keep working', () => {
  for (const k of ['Space', 'L', 'Shift+M', 'NumpadAdd', 'Enter']) assert.equal(isBareCombo(k), true, k);
  for (const k of ['Ctrl+S', 'Ctrl+Shift+H', 'Alt+F8', 'F1', 'F5', 'F11', 'Alt+Q']) assert.equal(isBareCombo(k), false, k);
});

test('Home and Guides shortcuts are bound and clash with nothing', () => {
  const map = applyKeymapOverrides(DEFAULT_KEYMAP, null);
  const home = map.find((b) => b.command === 'view.home');
  const guides = map.find((b) => b.command === 'help.guides');
  assert.equal(home?.keys, 'Ctrl+Shift+H');
  assert.equal(guides?.keys, 'F1');
  for (const b of [home!, guides!]) assert.deepEqual(findKeyConflicts(map, b.keys, b.command, b.context), [], b.keys);
});

test('inline markup: bold, code, keys, action links, plain text', () => {
  const runs = parseInline('Press [[Ctrl+S]] to **save** the `.kstudio`, then [[action:library|open the Library]].');
  assert.deepEqual(
    runs.map((r) => r.t),
    ['text', 'kbd', 'text', 'b', 'text', 'code', 'text', 'action', 'text'],
  );
  assert.deepEqual(runs[7], { t: 'action', id: 'library', label: 'open the Library' });
  assert.equal(inlineText(runs), 'Press Ctrl+S to save the .kstudio, then open the Library.');
  assert.deepEqual(parseInline('plain'), [{ t: 'text', v: 'plain' }]);
});

test('block markup: headings, paragraphs, lists with continuations, steps, tables, callouts, buttons, generated blocks', () => {
  const src = `
Intro line one
continues here.

## First part

- one
  still one
- two

1. step a
2. step b

| Key | Does |
|---|---|
| [[F5]] | Playlist |

> a tip
> on two lines

!> careful

[[action:studio|Go]] [[action:mixer|Mixer]]

{{shortcuts}}

{{catalog:effect}}
### Small heading
`;
  const b = parseGuide(src);
  assert.deepEqual(
    b.map((x) => x.type),
    ['p', 'h2', 'ul', 'ol', 'table', 'tip', 'warn', 'actions', 'shortcuts', 'catalog', 'h3'],
  );
  assert.equal(blockText(b[0]), 'Intro line one continues here.');
  assert.equal((b[1] as { anchor: string }).anchor, 'first-part');
  const ul = b[2] as { items: Array<Parameters<typeof inlineText>[0]> };
  assert.deepEqual(ul.items.map(inlineText), ['one still one', 'two']);
  const table = b[4] as { head: unknown[]; rows: unknown[][] };
  assert.equal(table.head.length, 2);
  assert.equal(table.rows.length, 1, 'the |---| separator row is skipped');
  assert.equal(blockText(b[5]), 'a tip on two lines');
  assert.deepEqual((b[7] as { items: unknown }).items, [
    { id: 'studio', label: 'Go' },
    { id: 'mixer', label: 'Mixer' },
  ]);
  assert.equal((b[9] as { kind: string }).kind, 'effect');
  assert.deepEqual(guideActionIds(b), ['studio', 'mixer']);
});

test('guides: unique ids, known groups, a default article, every one parses into real content', () => {
  const ids = ARTICLES.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate guide id');
  assert.ok(articleById(DEFAULT_ARTICLE));
  assert.equal(articleById('nope'), undefined);
  for (const a of ARTICLES) {
    assert.ok(GUIDE_GROUPS.includes(a.group), `${a.id}: unknown group ${a.group}`);
    assert.ok(a.title.trim() && a.summary.trim(), `${a.id}: title and summary`);
    const blocks = parseGuide(a.body);
    assert.ok(blocks.length >= 3, `${a.id}: too short`);
    assert.ok(blocks.some((b) => b.type === 'h2' || b.type === 'shortcuts'), `${a.id}: no sections`);
    for (const r of blockInlines(blocks)) {
      if (r.t !== 'text') continue;
      assert.ok(!/\[\[|\]\]|\*\*|\{\{/.test(r.v), `${a.id}: stray markup in "${r.v.slice(0, 60)}"`);
    }
  }
  for (const g of GUIDE_GROUPS) assert.ok(ARTICLES.some((a) => a.group === g), `empty group ${g}`);
});

test('guides: every deep link runs a real Home action', () => {
  const linked = new Set<string>();
  for (const a of ARTICLES) {
    for (const id of guideActionIds(parseGuide(a.body))) {
      assert.ok(isHomeActionId(id), `${a.id} links to unknown action "${id}"`);
      linked.add(id);
    }
  }
  assert.ok(linked.size >= 10, 'guides should link into the app');
  assert.equal(new Set(HOME_ACTION_IDS).size, HOME_ACTION_IDS.length);
});

test('guides: the requested articles all exist', () => {
  for (const id of ['getting-started', 'channel-rack', 'piano-roll', 'playlist', 'mixer', 'recording', 'ai-agents', 'audio-tools', 'vocals', 'reference-library', 'sounds-presets', 'sounds-plugins', 'exporting', 'shortcuts', 'troubleshooting']) {
    assert.ok(articleById(id), `missing guide ${id}`);
  }
  assert.ok(parseGuide(articleById('shortcuts')!.body).some((b) => b.type === 'shortcuts'), 'the shortcuts guide is generated from the keymap');
  assert.ok(parseGuide(articleById('mixer')!.body).some((b) => b.type === 'catalog'), 'the mixer guide lists the stock effects from the catalog');
});

test('every stock plugin in the generated catalog has a friendly guide line, and no line is stale', () => {
  const stock = CATALOG.plugins.filter((p) => p.id.startsWith('krypt.'));
  for (const p of stock) assert.ok(PLUGIN_NOTES[p.id], `PLUGIN_NOTES is missing ${p.id} (${p.name})`);
  for (const id of Object.keys(PLUGIN_NOTES)) assert.ok(stock.some((p) => p.id === id), `PLUGIN_NOTES has a stale id ${id}`);
});

test('shortcuts table: every default binding appears once per command, combos merged, editors separated', () => {
  const labels: Record<string, string> = { 'edit.redo': 'Redo', 'transport.togglePlay': 'Play / stop', 'view.home': 'Home' };
  const sections = buildShortcutSections(applyKeymapOverrides(DEFAULT_KEYMAP, null), (c) => labels[c]);
  const rows = sections.flatMap((s) => s.rows);
  for (const b of DEFAULT_KEYMAP) assert.ok(rows.some((r) => r.command === b.command), `missing ${b.command}`);
  const redo = rows.filter((r) => r.command === 'edit.redo');
  assert.equal(redo.length, 1);
  assert.deepEqual(redo[0].keys, ['Ctrl+Y', 'Ctrl+Shift+Z']);
  assert.equal(rows.find((r) => r.command === 'transport.togglePlay')?.label, 'Play / stop');
  assert.equal(rows.find((r) => r.command === 'pianoRoll.quickChop')?.label, 'Quick chop', 'falls back to a readable label');
  assert.equal(rows.find((r) => r.command === 'pattern.next')?.keys[0], 'Num +');
  assert.equal(sections[0].title, 'Playback');
  assert.ok(sections.some((s) => s.title.startsWith('Piano roll')));
  assert.ok(sections.find((s) => s.title === 'Windows and views')?.rows.some((r) => r.command === 'view.home'));
  const custom = buildShortcutSections(applyKeymapOverrides(DEFAULT_KEYMAP, { 'transport.panic': [], 'file.save': ['Ctrl+Alt+S'] }), () => undefined).flatMap((s) => s.rows);
  assert.equal(custom.some((r) => r.command === 'transport.panic'), false);
  assert.deepEqual(custom.find((r) => r.command === 'file.save')?.keys, ['Ctrl+Alt+S']);
  assert.equal(fallbackLabel('view.toggle.channelRack'), 'Channel rack');
});

const src = (f: string): string => readFileSync(path.resolve(process.cwd(), 'src', f), 'utf8');

test('Master your music: Master a song always; Master an album only once its action is registered', () => {
  const { song, album } = masterCardActions();
  assert.equal(song, 'masterSong');
  assert.ok(isHomeActionId(song));
  assert.equal(album, (HOME_ACTION_IDS as readonly string[]).includes('masterAlbum') ? 'masterAlbum' : null);
});

test('Home under the title: the Discord and free-tools links, then straight to the card grid', () => {
  const home = src('home/HomeView.tsx');
  const order = ['onClick={ext(LINKS.discord)}', 'onClick={ext(LINKS.tools)}', '<nav aria-label="Home"'].map((t) => home.indexOf(t));
  assert.ok(order.every((i) => i > 0), 'all three are on the Home screen');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'Discord, free tools, then the card grid');
  assert.ok(!/<QuickstartCard \/>|<TourCard \/>|<MasterCard \/>/.test(home), 'no featured panels under the title');
  assert.match(home, /Join the Discord/);
  assert.match(home, /More free tools/);
});

test('First install: a welcome window with the overview video and the Discord / free-tools links, once', () => {
  const home = src('home/HomeView.tsx');
  assert.match(home, /maybeShowWelcome\(\)/, 'Home offers it when it opens');
  const welcome = src('home/WelcomeDialog.tsx');
  assert.match(welcome, /QUICKSTART_VIDEO/);
  assert.match(welcome, /quickstartCardVisible\(/, 'first install only: never for returning users or after it was seen');
  assert.match(welcome, /onClose: \(\) => dismissQuickstart\(\)/, 'closing it marks it seen');
  assert.match(welcome, /<VideoPlayer video=\{video\} onEnded=/);
  assert.ok(!/autoPlay/.test(welcome), 'it waits for a click before it talks');
  assert.match(welcome, /LINKS\.discord/);
  assert.match(welcome, /LINKS\.tools/);
  assert.match(welcome, /Help ▸ Video tutorials/);
});

test('Mastering lives on Home ▸ Audio Tools: Master a song… and the guarded Master an album…', () => {
  const card = src('home/screens/AudioToolsScreen.tsx');
  assert.match(card, /data-guide="home\.masterSong"/);
  assert.match(card, /runHomeAction\(song\)/);
  assert.match(card, /\{album && \(/, 'the album button is guarded');
  assert.match(card, /Master a song…/);
  assert.match(card, /Master an album…/);
  assert.ok(!/Auto-?Tune/i.test(card));
  assert.ok(articleById('step-master'), 'the How it works guide exists');
});

void run('home');
