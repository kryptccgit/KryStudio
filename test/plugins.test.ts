import assert from 'node:assert/strict';
import { test, run } from './harness';
import { DocHost, USER, SYSTEM } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG, EFFECTS, INSTRUMENTS, catalogVersion, externalPlugins, isExternalPluginId, onCatalogChanged, pluginById, registerExternalPlugins } from '@shared/plugins/catalog';
import type { PluginDescriptor } from '@shared/plugins/types';
import { getParamValue, paramSpecFor } from '@shared/schema/params';
import { projectPatches } from '@shared/engine/projection';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, newSession, type ToolCaller } from '../electron/mcp/tools';

const SINE: PluginDescriptor = {
  id: 'clap:cc.krypt.test.sine',
  name: 'Krypt Test Sine',
  kind: 'instrument',
  category: 'Synth',
  description: 'Krypt (test) · CLAP',
  format: 'clap',
  vendor: 'Krypt (test)',
  path: 'C:/plugins/krypt-test.clap',
  hasEditor: false,
  params: [
    { id: '1', name: 'Level', min: 0, max: 1, default: 0.5, unit: '', scale: 'linear', group: 'Output' },
    { id: '2', name: 'Waveform', min: 0, max: 2, default: 0, unit: '', scale: 'linear', step: 1, options: ['Sine', 'Square', 'Saw'] },
  ],
};

const GAIN: PluginDescriptor = {
  id: 'vst3:5059524B54545345545647334741494E',
  name: 'Krypt Test VST3 Gain',
  kind: 'effect',
  category: 'Effect',
  description: 'Krypt (test) · VST3',
  format: 'vst3',
  vendor: 'Krypt (test)',
  path: 'C:/plugins/KryptTestGain.vst3',
  hasEditor: true,
  params: [{ id: '0', name: 'Gain', min: 0, max: 1, default: 1, unit: '', scale: 'linear' }],
};

const stockCount = CATALOG.plugins.length;
const instrumentsBefore = INSTRUMENTS.length;

test('registerExternalPlugins mutates CATALOG in place, additively', () => {
  const ref = CATALOG.plugins;
  const v0 = catalogVersion();
  let notified = 0;
  const off = onCatalogChanged(() => notified++);
  assert.equal(registerExternalPlugins([SINE, GAIN]), 2);
  assert.equal(CATALOG.plugins, ref, 'same array object (DocHost/MCP share it)');
  assert.equal(CATALOG.plugins.length, stockCount + 2);
  assert.equal(pluginById(SINE.id)?.name, 'Krypt Test Sine');
  assert.ok(catalogVersion() > v0);
  assert.equal(notified, 1);
  assert.equal(registerExternalPlugins([SINE, GAIN]), 0);
  assert.equal(registerExternalPlugins([{ ...SINE, id: 'krypt.triosc' }, { ...SINE, id: 'nope' } as PluginDescriptor]), 0);
  assert.equal(INSTRUMENTS.length, instrumentsBefore);
  assert.ok(!EFFECTS.some((e) => isExternalPluginId(e.id)));
  assert.deepEqual(
    externalPlugins('instrument').map((d) => d.id),
    [SINE.id],
  );
  assert.equal(registerExternalPlugins([{ ...SINE, name: 'Krypt Test Sine 2' }]), 1);
  assert.equal(pluginById(SINE.id)?.name, 'Krypt Test Sine 2');
  registerExternalPlugins([SINE]);
  off();
});

function fresh() {
  registerExternalPlugins([SINE, GAIN]);
  return new DocHost(createDefaultProject('Plugins'), CATALOG, { strict: true });
}

test('channels.add / mixer.addSlot accept installed plugins; kinds are checked', () => {
  const host = fresh();
  const r = host.exec<{ id: string; insertId: string }>('channels.add', { type: SINE.id, params: { '1': 2 } }, { actor: USER });
  assert.equal(r.ok, true, r.message);
  const ch = host.project.channels[r.data!.id];
  assert.equal(ch.generator.type, SINE.id);
  assert.equal(ch.generator.params['1'], 1, 'clamped to the plugin range');
  assert.equal(ch.name, 'Test Sine');
  const fx = host.exec<{ id: string }>('mixer.addSlot', { insertId: r.data!.insertId, type: GAIN.id, params: { '0': 0.5 } }, { actor: USER });
  assert.equal(fx.ok, true, fx.message);
  assert.equal(host.exec('mixer.addSlot', { insertId: r.data!.insertId, type: SINE.id }, { actor: USER }).ok, false);
  assert.equal(host.exec('channels.add', { type: GAIN.id }, { actor: USER }).ok, false);
  const ref = `channel/${ch.id}/gen/2`;
  assert.equal(paramSpecFor(host.project, CATALOG, ref)?.options?.[2], 'Saw');
  assert.equal(host.exec('params.set', { ref, value: 2 }, { actor: USER }).ok, true);
  assert.equal(getParamValue(host.project, CATALOG, ref), 2);
  assert.equal(host.exec('channels.setGenParams', { id: ch.id, params: { nope: 1 } }, { actor: USER }).ok, false);
});

test('plugins.setStates stores blobs without history; the engine projection carries them', () => {
  const host = fresh();
  const r = host.exec<{ id: string; insertId: string }>('channels.add', { type: SINE.id }, { actor: USER });
  const fx = host.exec<{ id: string }>('mixer.addSlot', { insertId: r.data!.insertId, type: GAIN.id }, { actor: USER });
  const histBefore = host.getHistory().length;
  const patches: unknown[] = [];
  host.subscribe((c) => c.kind === 'exec' && patches.push(...c.patches));
  const key = `${r.data!.insertId}/${fx.data!.id}`;
  const x = host.exec<{ updated: number }>('plugins.setStates', { states: { [r.data!.id]: 'S1NJTg==', [key]: 'S1YzUw==', ghost: 'AAAA' } }, { actor: SYSTEM });
  assert.equal(x.ok, true, x.message);
  assert.equal(x.data!.updated, 2);
  assert.equal(host.project.channels[r.data!.id].generator.state, 'S1NJTg==');
  assert.equal(host.project.mixer.inserts[r.data!.insertId].slots[fx.data!.id].state, 'S1YzUw==');
  assert.equal(host.getHistory().length, histBefore, 'not an undo step');
  const v = host.version;
  host.exec('plugins.setStates', { states: { [r.data!.id]: 'S1NJTg==' } }, { actor: SYSTEM });
  assert.equal(host.version, v);
  const diff = projectPatches(host.project, patches as never, (s) => s);
  const ch = diff.upserts.find((u) => u.kind === 'channel');
  assert.equal((ch?.value as { generator: { state?: string } }).generator.state, 'S1NJTg==');
  host.exec('channels.setGenerator', { id: r.data!.id, type: 'krypt.triosc' }, { actor: USER });
  assert.equal(host.project.channels[r.data!.id].generator.state, undefined);
});

function mcp() {
  const doc = fresh();
  const deps = {
    doc,
    broadcast: () => {},
    log: () => {},
    getSettings: () => ({ mcp: { requireConsentForDestructive: false } }),
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 't', name: 'Test' }, session: newSession(), via: 'test' };
  return { doc, call: (name: string, args: unknown = {}) => callTool(deps, caller, name, args) };
}

test('MCP list_plugins / describe_plugin / add_channel / add_effect see installed plugins', async () => {
  const { doc, call } = mcp();
  const all = await call('list_plugins');
  assert.equal(all.ok, true, all.message);
  const rows = (all.data as { plugins: Array<{ id: string; installed?: boolean; format?: string; vendor?: string }> }).plugins;
  const sine = rows.find((p) => p.id === SINE.id);
  assert.ok(sine?.installed && sine.format === 'clap' && sine.vendor === 'Krypt (test)');
  const inst = await call('list_plugins', { source: 'installed' });
  assert.deepEqual(
    (inst.data as { plugins: Array<{ id: string }> }).plugins.map((p) => p.id).sort(),
    [GAIN.id, SINE.id].sort(),
  );
  const stock = await call('list_plugins', { source: 'stock' });
  assert.ok((stock.data as { plugins: Array<{ id: string }> }).plugins.every((p) => !isExternalPluginId(p.id)));
  const d = await call('describe_plugin', { plugin: GAIN.id });
  assert.equal(d.ok, true, d.message);
  assert.match(String((d as { text?: string }).text), /Third-party VST3 plugin/);
  const add = await call('add_channel', { name: 'Sine', instrument: SINE.id });
  assert.equal(add.ok, true, add.message);
  const ch = Object.values(doc.project.channels).find((c) => c.name === 'Sine');
  assert.equal(ch?.generator.type, SINE.id);
  const fx = await call('add_effect', { insert: 'Sine', effect: 'Krypt Test VST3 Gain' });
  assert.equal(fx.ok, true, fx.message);
  const set = await call('set_params', { channel: 'Sine', params: { Level: 0.25 } });
  assert.equal(set.ok, true, set.message);
  assert.equal(doc.project.channels[ch!.id].generator.params['1'], 0.25);
});

void run('plugins');
