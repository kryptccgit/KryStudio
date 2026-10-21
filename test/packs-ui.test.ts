import assert from 'node:assert/strict';
import { test, run } from './harness';
import type { PackEntryState, PacksState } from '@shared/packs/types';
import {
  isCancelled,
  missingPackFor,
  needsPackMessage,
  packActions,
  packInstalled,
  packMb,
  packName,
  packPhrase,
  packPill,
  packProgress,
  packSizeText,
  packsSummary,
  presetPackId,
} from '../src/sounds/packsLogic';
import { createMockPacks } from '../src/dev/mockPacks';

const MB = 1024 * 1024;

function entry(id: string, status: PackEntryState['status'], extra: Partial<PackEntryState> = {}): PackEntryState {
  return {
    id,
    name: id === 'grand' ? 'Grand Piano' : 'Drum Kit',
    description: '',
    author: 'Someone',
    licence: { spdx: 'CC0-1.0', name: 'CC0 1.0 Universal', url: 'https://example.com', attribution: 'Credit' },
    bytes: 312 * MB,
    ramMb: 239.6,
    contents: [],
    status,
    ...extra,
  };
}

const state = (...packs: PackEntryState[]): PacksState => ({ packs, dir: 'C:\\packs' });

test('presetPackId: requires, else the pack of a pack: sample; chains and plain presets need none', () => {
  assert.equal(presetPackId({ kind: 'instrument', requires: 'grand' }), 'grand');
  assert.equal(presetPackId({ kind: 'instrument', sample: 'pack:drums/krypt/kit.sfz' }), 'drums');
  assert.equal(presetPackId({ kind: 'instrument', sample: 'factory:drums/kick.wav' }), null);
  assert.equal(presetPackId({ kind: 'instrument', sample: 'pack:../x' }), null);
  assert.equal(presetPackId({ kind: 'chain' }), null);
  assert.equal(presetPackId(null), null);
});

test('missingPackFor / packInstalled / packName: installed and update play; unknown state counts as missing', () => {
  const grand = { kind: 'instrument' as const, requires: 'grand' };
  assert.deepEqual(missingPackFor(grand, state(entry('grand', 'available'))), { id: 'grand', name: 'Grand Piano' });
  assert.deepEqual(missingPackFor(grand, state(entry('grand', 'downloading'))), { id: 'grand', name: 'Grand Piano' });
  assert.deepEqual(missingPackFor(grand, state(entry('grand', 'failed'))), { id: 'grand', name: 'Grand Piano' });
  assert.equal(missingPackFor(grand, state(entry('grand', 'installed'))), null);
  assert.equal(missingPackFor(grand, state(entry('grand', 'update'))), null);
  assert.deepEqual(missingPackFor(grand, null), { id: 'grand', name: 'grand' });
  assert.equal(missingPackFor({ kind: 'instrument' }, null), null);
  assert.equal(packInstalled(state(entry('grand', 'update')), 'grand'), true);
  assert.equal(packInstalled(state(entry('grand', 'available')), 'grand'), false);
  assert.equal(packName(state(entry('grand', 'available')), 'grand'), 'Grand Piano');
  assert.equal(packName(null, 'nope'), 'nope');
});

test('sentences: "needs the … pack" never doubles "pack"', () => {
  assert.equal(packPhrase('Grand Piano'), 'the Grand Piano pack');
  assert.equal(packPhrase('Orchestra Pack'), 'the Orchestra Pack');
  assert.equal(needsPackMessage('Concert Grand', { name: 'Grand Piano' }), 'Concert Grand needs the Grand Piano pack. Download it in Home ▸ Sounds.');
  assert.equal(isCancelled('Grand Piano download cancelled. Files…'), true);
  assert.equal(isCancelled("Couldn't install Grand Piano: …"), false);
});

test('card text: sizes, RAM, status pill, progress', () => {
  assert.equal(packMb(312 * MB), '312 MB');
  assert.equal(packMb(2.5 * MB), '2.5 MB');
  assert.equal(packMb(1536 * MB), '1.5 GB');
  assert.equal(packMb(0), '0 MB');
  assert.equal(packSizeText(entry('grand', 'available')), '312 MB download · ~240 MB RAM per instrument');
  assert.deepEqual(packPill(entry('grand', 'available')), { text: 'Not downloaded', tone: 'neutral' });
  assert.deepEqual(packPill(entry('grand', 'installed')), { text: 'Installed', tone: 'live' });
  assert.deepEqual(packPill(entry('grand', 'update')), { text: 'Update available', tone: 'accent' });
  assert.deepEqual(packPill(entry('grand', 'failed')), { text: 'Download failed', tone: 'danger' });
  assert.deepEqual(packPill(entry('grand', 'downloading', { progress: { bytes: 78 * MB, total: 312 * MB } })), { text: 'Downloading 25%', tone: 'accent' });
  assert.deepEqual(packPill(entry('grand', 'downloading')), { text: 'Downloading…', tone: 'accent' });
  assert.deepEqual(packProgress(entry('grand', 'downloading', { progress: { bytes: 78 * MB, total: 312 * MB } })), { fraction: 0.25, text: '78 MB of 312 MB' });
  assert.deepEqual(packProgress(entry('grand', 'downloading', { progress: { bytes: 0, total: 0 } })), { fraction: -1, text: 'Starting…' });
  assert.equal(packProgress(entry('grand', 'installed')), null);
});

test('card buttons by status (the first is the main one)', () => {
  assert.deepEqual(packActions(entry('grand', 'available')), ['download']);
  assert.deepEqual(packActions(entry('grand', 'downloading')), ['cancel']);
  assert.deepEqual(packActions(entry('grand', 'installed')), ['reveal', 'remove']);
  assert.deepEqual(packActions(entry('grand', 'update')), ['update', 'reveal', 'remove']);
  assert.deepEqual(packActions(entry('grand', 'failed')), ['retry']);
});

test('header summary', () => {
  assert.equal(packsSummary(null), null);
  assert.equal(packsSummary(state()), null);
  assert.deepEqual(packsSummary(state(entry('grand', 'available'), entry('drums', 'failed'))), { text: 'None installed', tone: 'neutral' });
  assert.deepEqual(packsSummary(state(entry('grand', 'installed'), entry('drums', 'available'))), { text: '1 of 2 installed', tone: 'neutral' });
  assert.deepEqual(packsSummary(state(entry('grand', 'installed'), entry('drums', 'update'))), { text: '2 of 2 installed', tone: 'live' });
  assert.deepEqual(packsSummary(state(entry('grand', 'downloading'), entry('drums', 'installed'))), { text: 'Downloading 1 pack', tone: 'accent' });
});

test('browser mock: a download progresses over a few seconds, then installs; cancel, remove and a failure say so', async () => {
  const api = createMockPacks();
  const first = (await api.state()).packs[0];
  assert.ok(first, 'the mock always offers a pack (demo packs while the catalog is empty)');
  const seen: PacksState[] = [];
  const off = api.onState((s) => seen.push(s));
  const t0 = Date.now();
  const r = await api.install(first.id);
  assert.equal(r.ok, true, r.message);
  assert.ok(Date.now() - t0 >= 2000, 'simulated over a few seconds');
  assert.ok(seen.some((s) => s.packs[0].status === 'downloading' && (s.packs[0].progress?.bytes ?? 0) > 0));
  assert.equal((await api.state()).packs[0].status, 'installed');
  assert.equal((await api.reveal(first.id)).ok, true);
  const rm = await api.remove(first.id);
  assert.equal(rm.ok, true);
  assert.equal(rm.data?.packs[0].status, 'available');
  const p = api.install(first.id);
  await new Promise((res) => setTimeout(res, 400));
  assert.equal((await api.cancel(first.id)).ok, true);
  const c = await p;
  assert.equal(c.ok, false);
  assert.match(c.message ?? '', /cancelled/);
  assert.equal((await api.state()).packs[0].status, 'available');
  (globalThis as unknown as { __kryptMockPacks: { failNext(): void } }).__kryptMockPacks.failNext();
  const f = await api.install(first.id);
  assert.equal(f.ok, false);
  assert.match(f.message ?? '', /SHA-256 mismatch/);
  const fe = (await api.state()).packs[0];
  assert.equal(fe.status, 'failed');
  assert.match(fe.error ?? '', /samples\/C4v3\.flac/);
  off();
});

await run('packs-ui');
