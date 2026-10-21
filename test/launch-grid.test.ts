// Grid controllers for the clip launcher (shared/live/launchGrid.ts): settings
// validation and the setLaunchGrid note maps for each layout.
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { DEFAULT_LAUNCH_GRID, gridLayout, launchGridMap, launchGridSettings, mergeLaunchGrid } from '@shared/live/launchGrid';
import type { LaunchGridSettings } from '@shared/types';

/** 3 tracks used, 2 scenes; clips at (T1, S1) and (T3, S2). */
function rig() {
  const host = new DocHost(createDefaultProject('Grid'), CATALOG, { strict: true });
  const ex = <T = any>(cmd: string, args: unknown): T => {
    const r = host.exec<T>(cmd, args, { actor: USER });
    assert.equal(r.ok, true, `${cmd}: ${r.message}`);
    return r.data as T;
  };
  const p0 = host.project;
  const pat = p0.transport.activePatternId!;
  const t = p0.playlist.trackOrder;
  const s1 = ex<{ id: string }>('session.addScene', {}).id;
  const s2 = ex<{ id: string }>('session.addScene', {}).id;
  const a = ex<{ id: string }>('session.setClip', { trackId: t[0], sceneId: s1, patternId: pat }).id;
  const b = ex<{ id: string }>('session.setClip', { trackId: t[2], sceneId: s2, patternId: pat }).id;
  return { host, ex, t, s1, s2, a, b };
}

const on = (patch: Partial<LaunchGridSettings> = {}): LaunchGridSettings => ({ ...DEFAULT_LAUNCH_GRID, enabled: true, ...patch });

test('settings: defaults and field-by-field validation of untrusted input', () => {
  assert.deepEqual(launchGridSettings(undefined), DEFAULT_LAUNCH_GRID);
  assert.deepEqual(launchGridSettings({ launchGrid: { ...DEFAULT_LAUNCH_GRID, layout: 'apc-mini' } }).layout, 'apc-mini');
  const m = mergeLaunchGrid(DEFAULT_LAUNCH_GRID, { enabled: true, device: 'Launchpad X', channel: 99, layout: 'nope', baseNote: 200, trackOffset: -3, sceneOffset: 2.6 });
  assert.deepEqual(m, { enabled: true, device: 'Launchpad X', channel: 15, layout: 'launchpad', baseNote: 127, trackOffset: 0, sceneOffset: 3 });
  assert.deepEqual(mergeLaunchGrid(m, { device: '', channel: null }), { ...m, device: null, channel: null });
  assert.deepEqual(mergeLaunchGrid(m, undefined), m);
  assert.deepEqual(mergeLaunchGrid(m, 'garbage'), m);
  assert.equal(mergeLaunchGrid(undefined, { layout: 'generic' }).layout, 'generic');
});

test('disabled = an empty map (the grid is off)', () => {
  const { host } = rig();
  assert.deepEqual(launchGridMap(host.project, DEFAULT_LAUNCH_GRID), { device: null, channel: null, notes: {} });
});

test('launchpad: first scene on the top row (81..), scene buttons 89 → 19, empty slots stop their track, 98 stops all', () => {
  const { host, t, s1, s2, a, b } = rig();
  const m = launchGridMap(host.project, on({ device: 'LPX', channel: 0 }));
  assert.equal(m.device, 'LPX');
  assert.equal(m.channel, 0);
  assert.deepEqual(m.notes['81'], { clipId: a });
  assert.deepEqual(m.notes['82'], { stopTrackId: t[1] });
  assert.deepEqual(m.notes['83'], { stopTrackId: t[2] });
  assert.deepEqual(m.notes['73'], { clipId: b });
  assert.deepEqual(m.notes['71'], { stopTrackId: t[0] });
  assert.deepEqual(m.notes['89'], { sceneId: s1 });
  assert.deepEqual(m.notes['79'], { sceneId: s2 });
  assert.equal(m.notes['69'], undefined, 'no third scene');
  assert.equal(m.notes['61'], undefined);
  assert.deepEqual(m.notes['98'], { stopTrackId: null });
  // 16 default tracks: the 8 visible columns per scene + 2 scene buttons + stop all
  assert.equal(Object.keys(m.notes).length, 8 * 2 + 2 + 1);
  assert.equal(gridLayout('launchpad').pad(7, 7), 18);
  assert.equal(gridLayout('launchpad').scene(7), 19);
});

test('apc-mini: bottom-left 0 (first scene = 56..63), scene buttons 82.., track buttons 64..71 stop, Shift (98) stops all', () => {
  const { host, t, s1, s2, a, b } = rig();
  const m = launchGridMap(host.project, on({ layout: 'apc-mini' }));
  assert.deepEqual(m.notes['56'], { clipId: a });
  assert.deepEqual(m.notes['50'], { clipId: b });
  assert.deepEqual(m.notes['48'], { stopTrackId: t[0] });
  assert.deepEqual(m.notes['82'], { sceneId: s1 });
  assert.deepEqual(m.notes['83'], { sceneId: s2 });
  assert.deepEqual(m.notes['64'], { stopTrackId: t[0] });
  assert.deepEqual(m.notes['71'], { stopTrackId: t[7] });
  assert.deepEqual(m.notes['98'], { stopTrackId: null });
});

test('generic: baseNote + row × 8 + column, scenes at +64, stop all at +72; notes past 127 are dropped', () => {
  const { host, s1, a, b } = rig();
  let m = launchGridMap(host.project, on({ layout: 'generic', baseNote: 36 }));
  assert.deepEqual(m.notes['36'], { clipId: a });
  assert.deepEqual(m.notes['46'], { clipId: b });
  assert.deepEqual(m.notes['100'], { sceneId: s1 });
  assert.deepEqual(m.notes['108'], { stopTrackId: null });
  m = launchGridMap(host.project, on({ layout: 'generic', baseNote: 100 }));
  assert.deepEqual(m.notes['100'], { clipId: a });
  assert.equal(m.notes['164'], undefined);
  assert.ok(Object.keys(m.notes).every((n) => Number(n) <= 127));
});

test('offsets scroll the 8×8 window over tracks and scenes', () => {
  const { host, ex, t, s2, b } = rig();
  let m = launchGridMap(host.project, on({ trackOffset: 2 }));
  assert.deepEqual(m.notes['71'], { clipId: b }, 'track 3 is now the first column');
  assert.deepEqual(m.notes['81'], { stopTrackId: t[2] });
  m = launchGridMap(host.project, on({ sceneOffset: 1 }));
  assert.deepEqual(m.notes['89'], { sceneId: s2 });
  assert.deepEqual(m.notes['83'], { clipId: b });
  // with no scenes in view only stop-all remains
  m = launchGridMap(host.project, on({ sceneOffset: 5 }));
  assert.deepEqual(Object.keys(m.notes), ['98']);
  void ex;
});

await run('launch grid');
