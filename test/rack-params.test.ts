import assert from 'node:assert/strict';
import { test, run } from './harness';
import { installRackFixtures } from './rack-fixtures';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity, type Project } from '@shared/schema/project';
import { formatParamRef, getParamValue, paramLabel, paramSpecFor, parseParamRef, rackParamRef, setParamValue, type ParsedParamRef } from '@shared/schema/params';
import { innerRefBase, rackIntegrity } from '@shared/commands/racks';
import type { Settings } from '@shared/types';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';

installRackFixtures();

function host() {
  const doc = new DocHost(createDefaultProject('T'), CATALOG, { strict: true });
  const ok = <T = any>(cmd: string, args: unknown): T => {
    const r = doc.exec<T>(cmd, args, { actor: USER });
    assert.equal(r.ok, true, `${cmd}: ${r.message}`);
    return r.data as T;
  };
  const sound = () => {
    assert.deepEqual(checkIntegrity(doc.project), []);
    assert.deepEqual(rackIntegrity(doc.project), []);
  };
  return { doc, ok, sound };
}

function racks() {
  const h = host();
  const ch = h.ok<{ id: string }>('channels.add', { type: 'krypt.triosc', name: 'Rack Keys', params: { cutoff: 1200 } }).id;
  const { chainId } = h.ok<{ chainId: string }>('rack.create', { channelId: ch, kind: 'instrument' });
  const { deviceId } = h.ok<{ deviceId: string }>('rack.addDevice', { channelId: ch, chainId, type: 'krypt.delay', params: { feedback: 0.5 }, mix: 0.4 });
  const insertId = h.doc.project.channels[ch].insertId;
  const { slotId } = h.ok<{ slotId: string }>('rack.create', { insertId });
  const { chainId: fxChain } = h.ok<{ chainId: string }>('rack.addChain', { insertId, slotId, name: 'Wet', devices: [{ type: 'krypt.reverb', mix: 0.6 }] });
  const fxDev = h.doc.project.mixer.inserts[insertId].slots[slotId].rack!.chains[fxChain].deviceOrder[0];
  const chHost = { kind: 'channel' as const, channelId: ch };
  const fxHost = { kind: 'slot' as const, insertId, slotId };
  return { ...h, ch, chainId, deviceId, insertId, slotId, fxChain, fxDev, chHost, fxHost };
}

test('parse / format round-trip every ParamRef form, including refs inside racks', () => {
  const refs = [
    'transport/bpm',
    'channel/c1/volume',
    'channel/c1/gen/cutoff',
    'insert/i1/stereoSep',
    'insert/i1/slot/s1/mix',
    'insert/i1/slot/s1/threshold',
    'insert/i1/route/i2',
    'channel/c1/rack/k1/volume',
    'channel/c1/rack/k1/pan',
    'channel/c1/rack/k1/inst/cutoff',
    'channel/c1/rack/k1/dev/d1/feedback',
    'channel/c1/rack/k1/dev/d1/mix',
    'insert/i1/slot/s1/rack/k1/volume',
    'insert/i1/slot/s1/rack/k1/dev/d1/size',
    'insert/i1/slot/s1/rack/k1/inst/cutoff',
  ];
  for (const r of refs) {
    const parsed = parseParamRef(r);
    assert.ok(parsed, r);
    assert.equal(formatParamRef(parsed), r);
  }
  assert.deepEqual(parseParamRef('channel/c1/rack/k1/dev/d1/mix'), { scope: 'rack', host: { kind: 'channel', channelId: 'c1' }, target: { chainId: 'k1', kind: 'device', deviceId: 'd1', param: 'mix' } });
  assert.deepEqual(parseParamRef('insert/i1/slot/s1/rack/k1/pan'), { scope: 'rack', host: { kind: 'slot', insertId: 'i1', slotId: 's1' }, target: { chainId: 'k1', kind: 'chain', param: 'pan' } });
  for (const bad of [
    'channel/c1/rack/k1/gain',
    'channel/c1/rack/k1',
    'channel/c1/rack/k1/inst',
    'channel/c1/rack/k1/inst/',
    'channel/c1/rack//volume',
    'channel/c1/rack/k1/dev/d1',
    'channel/c1/rack/k1/dev/d1/x/y',
    'insert/i1/slot/s1/rack/k1/inst/a/b',
    'insert/i1/rack/k1/volume',
  ]) {
    assert.equal(parseParamRef(bad), null, bad);
  }
  const t = { chainId: 'k', kind: 'device', deviceId: 'd', param: 'mix' } as const;
  assert.equal(rackParamRef({ kind: 'slot', insertId: 'i', slotId: 's' }, t), 'insert/i/slot/s/rack/k/dev/d/mix');
  const p: ParsedParamRef = { scope: 'rack', host: { kind: 'channel', channelId: 'c' }, target: { chainId: 'k', kind: 'instrument', param: 'cutoff' } };
  assert.equal(formatParamRef(p), 'channel/c/rack/k/inst/cutoff');
  assert.equal(innerRefBase({ refPrefix: 'channel/c/gen/' }), 'channel/c/rack/');
  assert.equal(innerRefBase({ refPrefix: 'insert/i/slot/s/' }), 'insert/i/slot/s/rack/');
});

test('spec / get / set for every scope inside instrument and effect racks', () => {
  const { doc, ch, chainId, deviceId, fxChain, fxDev, chHost, fxHost } = racks();
  const p = structuredClone(doc.project) as Project;
  const at = (h: typeof chHost | typeof fxHost, target: Parameters<typeof rackParamRef>[1]) => rackParamRef(h, target);
  const cases: Array<[string, string, number, number, number]> = [
    [at(chHost, { chainId, kind: 'chain', param: 'volume' }), 'Chain volume', 1, 3, 2],
    [at(chHost, { chainId, kind: 'chain', param: 'pan' }), 'Chain pan', 0, -0.25, -0.25],
    [at(chHost, { chainId, kind: 'instrument', param: 'cutoff' }), 'Cutoff', 1200, 50000, 20000],
    [at(chHost, { chainId, kind: 'device', deviceId, param: 'feedback' }), 'Feedback', 0.5, 0.7, 0.7],
    [at(chHost, { chainId, kind: 'device', deviceId, param: 'mix' }), 'Mix', 0.4, 0.9, 0.9],
    [at(fxHost, { chainId: fxChain, kind: 'chain', param: 'volume' }), 'Chain volume', 1, 0.5, 0.5],
    [at(fxHost, { chainId: fxChain, kind: 'device', deviceId: fxDev, param: 'mix' }), 'Mix', 0.6, -1, 0],
    [at(fxHost, { chainId: fxChain, kind: 'device', deviceId: fxDev, param: 'size' }), 'Size', CATALOG.plugins.find((d) => d.id === 'krypt.reverb')!.params.find((s) => s.id === 'size')!.default, 0.9, 0.9],
  ];
  for (const [ref, name, cur, set, want] of cases) {
    const spec = paramSpecFor(p, CATALOG, ref);
    assert.ok(spec, ref);
    assert.equal(spec.name, name, ref);
    assert.equal(getParamValue(p, CATALOG, ref), cur, ref);
    assert.equal(setParamValue(p, CATALOG, ref, set), null, ref);
    assert.equal(getParamValue(p, CATALOG, ref), want, ref);
  }
  const chain = p.channels[ch].generator.rack!.chains[chainId];
  assert.equal(chain.volume, 2);
  assert.equal(chain.instrument!.params.cutoff, 20000);
  assert.equal(chain.devices[deviceId].mix, 0.9);
  assert.equal(paramLabel(p, CATALOG, at(chHost, { chainId, kind: 'instrument', param: 'cutoff' })), `${chain.name} · Cutoff`);
  assert.equal(paramLabel(p, CATALOG, `channel/${ch}/volume`), 'Volume');
  const none = [
    at(chHost, { chainId: 'nope', kind: 'chain', param: 'volume' }),
    at(chHost, { chainId, kind: 'instrument', param: 'nope' }),
    at(chHost, { chainId, kind: 'device', deviceId: 'nope', param: 'mix' }),
    at(chHost, { chainId, kind: 'device', deviceId, param: 'nope' }),
    at(fxHost, { chainId: fxChain, kind: 'instrument', param: 'cutoff' }),
    at({ kind: 'channel', channelId: 'nope' }, { chainId, kind: 'chain', param: 'pan' }),
    at({ kind: 'slot', insertId: fxHost.insertId, slotId: 'nope' }, { chainId: fxChain, kind: 'chain', param: 'pan' }),
  ];
  for (const ref of none) {
    assert.equal(paramSpecFor(p, CATALOG, ref), null, ref);
    assert.equal(getParamValue(p, CATALOG, ref), null, ref);
    assert.match(setParamValue(p, CATALOG, ref, 1) ?? '', /does not exist/, ref);
  }
  const q = structuredClone(p) as Project;
  q.channels[ch].generator.type = 'krypt.triosc';
  assert.equal(paramSpecFor(q, CATALOG, at(chHost, { chainId, kind: 'chain', param: 'pan' })), null);
});

test('params.set and automation.create on inner params, each one undo step', () => {
  const { doc, ok, ch, chainId, deviceId, sound } = racks();
  const cutoff = `channel/${ch}/rack/${chainId}/inst/cutoff`;
  const before = JSON.stringify(doc.project);
  const r = ok<{ value: number }>('params.set', { ref: cutoff, value: 0.5, normalized: true });
  assert.ok(Math.abs(r.value - 20 * Math.sqrt(1000)) < 1e-6, `normalized 0.5 on a log knob: ${r.value}`);
  assert.equal(doc.project.channels[ch].generator.rack!.chains[chainId].instrument!.params.cutoff, r.value);
  ok('params.set', { ref: `channel/${ch}/rack/${chainId}/dev/${deviceId}/mix`, value: 0.25 });
  assert.equal(doc.project.channels[ch].generator.rack!.chains[chainId].devices[deviceId].mix, 0.25);
  sound();
  assert.equal(doc.undo(USER).ok, true);
  assert.equal(doc.undo(USER).ok, true);
  assert.equal(JSON.stringify(doc.project), before);
  const bad = doc.exec('params.set', { ref: `channel/${ch}/rack/nope/volume`, value: 1 }, { actor: USER });
  assert.equal(bad.ok, false);
  assert.match(bad.message ?? '', /does not exist/);

  const trackId = doc.project.playlist.trackOrder[0];
  const a = ok<{ automationId: string; clipId: string }>('automation.create', { target: cutoff, trackId, start: 0 });
  const aut = doc.project.automations[a.automationId];
  const chainName = doc.project.channels[ch].generator.rack!.chains[chainId].name;
  assert.equal(aut.target, cutoff);
  assert.equal(aut.name, `${chainName} · Cutoff automation`);
  const pts = Object.values(aut.points);
  const n = Math.log(1200 / 20) / Math.log(1000);
  assert.ok(pts.every((pt) => Math.abs(pt.value - n) < 1e-9), 'flat at the knob position');
  assert.equal(doc.project.playlist.clips[a.clipId].automationId, a.automationId);
  ok('automation.set', { id: a.automationId, target: `channel/${ch}/rack/${chainId}/pan` });
  const badTarget = doc.exec('automation.set', { id: a.automationId, target: `channel/${ch}/rack/${chainId}/inst/nope` }, { actor: USER });
  assert.equal(badTarget.ok, false);
  sound();
  assert.equal(doc.undo(USER).ok, true);
  assert.equal(doc.undo(USER).ok, true);
  assert.equal(doc.project.automations[a.automationId], undefined, 'undo removes the automation and its clip');
  assert.equal(JSON.stringify(doc.project), before);
});

test('wrapping in a rack moves automation inside; removing chains / devices / instruments unassigns it', () => {
  const h = host();
  const ch = h.ok<{ id: string }>('channels.add', { type: 'krypt.triosc', name: 'Lead' }).id;
  const insertId = h.doc.project.channels[ch].insertId;
  const sid = h.ok<{ id: string }>('mixer.addSlot', { insertId, type: 'krypt.delay' }).id;
  const a1 = h.ok<{ automationId: string }>('automation.create', { target: `channel/${ch}/gen/cutoff` }).automationId;
  const a2 = h.ok<{ automationId: string }>('automation.create', { target: `insert/${insertId}/slot/${sid}/feedback` }).automationId;
  const a3 = h.ok<{ automationId: string }>('automation.create', { target: `insert/${insertId}/slot/${sid}/mix` }).automationId;
  const a4 = h.ok<{ automationId: string }>('automation.create', { target: `channel/${ch}/volume` }).automationId;
  const w1 = h.ok<{ chainId: string; movedAutomation: number; clearedAutomation: number }>('rack.create', { channelId: ch });
  assert.equal(w1.movedAutomation, 1);
  assert.equal(w1.clearedAutomation, 0);
  const aut = (id: string) => h.doc.project.automations[id].target;
  assert.equal(aut(a1), `channel/${ch}/rack/${w1.chainId}/inst/cutoff`);
  assert.equal(aut(a4), `channel/${ch}/volume`, 'the channel fader is not inside the rack');
  const w2 = h.ok<{ chainId: string; movedAutomation: number }>('rack.create', { insertId, slotId: sid });
  assert.equal(w2.movedAutomation, 2);
  const dev = h.doc.project.mixer.inserts[insertId].slots[sid].rack!.chains[w2.chainId].deviceOrder[0];
  assert.equal(aut(a2), `insert/${insertId}/slot/${sid}/rack/${w2.chainId}/dev/${dev}/feedback`);
  assert.equal(aut(a3), `insert/${insertId}/slot/${sid}/rack/${w2.chainId}/dev/${dev}/mix`);
  for (const id of [a1, a2, a3]) assert.ok(paramSpecFor(h.doc.project, CATALOG, aut(id)!), `${aut(id)} resolves`);
  h.sound();

  const keep = h.ok<{ automationId: string }>('automation.create', { target: `channel/${ch}/rack/${w1.chainId}/pan` }).automationId;
  const r = h.ok<{ clearedAutomation: number }>('rack.setInstrument', { channelId: ch, chainId: w1.chainId, type: 'krypt.kick808' });
  const kickHasCutoff = CATALOG.plugins.find((d) => d.id === 'krypt.kick808')!.params.some((s) => s.id === 'cutoff');
  assert.equal(r.clearedAutomation, kickHasCutoff ? 0 : 1);
  assert.equal(aut(a1), kickHasCutoff ? `channel/${ch}/rack/${w1.chainId}/inst/cutoff` : null);
  assert.equal(aut(keep), `channel/${ch}/rack/${w1.chainId}/pan`);
  const rd = h.ok<{ clearedAutomation: number }>('rack.removeDevice', { insertId, slotId: sid, chainId: w2.chainId, deviceId: dev });
  assert.equal(rd.clearedAutomation, 2);
  assert.equal(aut(a2), null);
  const rc = h.ok<{ clearedAutomation: number }>('rack.removeChain', { channelId: ch, chainId: w1.chainId });
  assert.equal(rc.clearedAutomation, 1);
  assert.equal(aut(keep), null);
  h.sound();
  const k2 = h.ok<{ chainId: string }>('rack.addChain', { channelId: ch, name: 'B', instrument: { type: 'krypt.triosc' } }).chainId;
  const inner = h.ok<{ automationId: string }>('automation.create', { target: `channel/${ch}/rack/${k2}/volume` }).automationId;
  h.ok('rack.build', { channelId: ch, spec: { kind: 'instrument', chains: [{ name: 'New', instrument: { plugin: 'krypt.triosc', params: {} } }] } });
  assert.equal(aut(inner), null);
  h.sound();
});

function rig() {
  const r = racks();
  const deps = {
    doc: r.doc,
    engine: { status: () => ({ state: 'running' }), onStatus: () => () => {}, onEvent: () => () => {} },
    project: { status: () => ({ path: null, name: 'Test', dirty: false, lastSavedAt: null, recovered: false }) },
    getSettings: () => ({}) as Settings,
    updateSettings: () => ({}) as Settings,
    broadcast: () => {},
    userDataDir: '.',
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'test-agent', name: 'Test Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  return { ...r, call };
}

test('MCP set_params and add_automation reach knobs inside racks (chain + device, or inner ParamRefs)', async () => {
  const { doc, call, ch, chainId, deviceId, insertId, slotId, fxChain, fxDev } = rig();
  const rack = () => doc.project.channels[ch].generator.rack!.chains[chainId];
  const chainName = rack().name;
  let r = await call('set_params', { channel: 'Rack Keys', chain: chainName, params: { cutoff: '2kHz', volume: 0.5, pan: -0.5 } });
  assert.equal(r.ok, true, r.message);
  assert.equal(rack().instrument!.params.cutoff, 2000);
  assert.equal(rack().volume, 0.5);
  assert.equal(rack().pan, -0.5);
  r = await call('set_params', { channel: 'Rack Keys', chain: 1, device: 'delay', params: { feedback: '60%', mix: '30%' } });
  assert.equal(r.ok, true, r.message);
  assert.ok(Math.abs(rack().devices[deviceId].params.feedback - 0.6) < 1e-9);
  assert.ok(Math.abs(rack().devices[deviceId].mix - 0.3) < 1e-9);
  const fxRef = `insert/${insertId}/slot/${slotId}/rack/${fxChain}/dev/${fxDev}/mix`;
  r = await call('set_params', { params: { [fxRef]: '50%' } });
  assert.equal(r.ok, true, r.message);
  assert.equal(doc.project.mixer.inserts[insertId].slots[slotId].rack!.chains[fxChain].devices[fxDev].mix, 0.5);
  r = await call('set_params', { insert: insertId, effect: 1, chain: 'Wet', device: 1, params: { mix: '20%' } });
  assert.equal(r.ok, true, r.message);
  assert.equal(doc.project.mixer.inserts[insertId].slots[slotId].rack!.chains[fxChain].devices[fxDev].mix, 0.2);
  r = await call('set_params', { channel: 'Rack Keys', chain: 'Nope', params: { cutoff: 100 } });
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /no chain "Nope".*1\./);
  r = await call('set_params', { channel: 'Rack Keys', chain: 1, device: 'chorus', params: { mix: 1 } });
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /no device "chorus"/);
  r = await call('set_params', { chain: 1, params: { cutoff: 100 } });
  assert.equal(r.ok, false);

  r = await call('add_automation', { channel: 'Rack Keys', chain: chainName, param: 'cutoff', bars: '1-4', from: '300Hz', to: '8kHz', curve: 'exp' });
  assert.equal(r.ok, true, r.message);
  const ref = `channel/${ch}/rack/${chainId}/inst/cutoff`;
  const auts = Object.values(doc.project.automations).filter((a) => a.target === ref);
  assert.equal(auts.length, 1);
  assert.equal((r.data as { ref: string }).ref, ref);
  r = await call('add_automation', { insert: insertId, effect: 1, chain: 1, device: 'reverb', param: 'mix', bars: '5-8', from: 0, to: 1 });
  assert.equal(r.ok, true, r.message);
  assert.ok(Object.values(doc.project.automations).some((a) => a.target === fxRef));
  r = await call('add_automation', { ref: `channel/${ch}/rack/${chainId}/dev/${deviceId}/feedback`, bars: '1-2', from: 0, to: 0.9 });
  assert.equal(r.ok, true, r.message);
  assert.equal(checkIntegrity(doc.project).length, 0);
});

void run('rack-params');
