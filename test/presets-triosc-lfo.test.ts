import assert from 'node:assert/strict';
import { test, run } from './harness';
import raw from '../shared/plugins/catalog.gen.json';
import type { ParamSpec, PluginCatalog, PluginDescriptor } from '@shared/plugins/types';
import { clampToSpec } from '@shared/plugins/types';
import { INSTRUMENT_PRESETS } from '@shared/sounds/factory/instruments';
import { TDIV, TRIOSC_LFO_PRESETS, TRI_LFO_OFF } from '@shared/sounds/factory/instruments/trioscLfo';
import { zInstrumentPreset } from '@shared/sounds/schema';
import { GENRE_IDS } from '@shared/sounds/genres';
import { INSTRUMENT_ROLES } from '@shared/sounds/types';
import { pickPreset } from '@shared/sounds/select';
import { MAX_FX_SLOTS } from '@shared/schema/project';

const CATALOG = raw as PluginCatalog;
const byId = new Map<string, PluginDescriptor>(CATALOG.plugins.map((p) => [p.id, p]));
const TRI = byId.get('krypt.triosc')!;
const REGENERATED = TRI.params.some((p) => p.id === 'lfo1Amount');

const SHAPES = ['Sine', 'Triangle', 'Saw up', 'Saw down', 'Square', 'Sample & hold', 'Smooth random'];
const DESTS = ['Pitch', 'Filter cutoff', 'Amp (tremolo)', 'Pan', 'Detune spread', 'Osc 1/2 mix'];
const DIVS = ['1/32T', '1/32', '1/32D', '1/16T', '1/16', '1/16D', '1/8T', '1/8', '1/8D', '1/4T', '1/4', '1/4D', '1/2T', '1/2', '1/2D', '1 bar', '2 bars', '4 bars', '8 bars'];
const choice = (id: string, name: string, options: string[], def: number, group: string): ParamSpec => ({ id, name, min: 0, max: options.length - 1, default: def, unit: '', scale: 'linear', step: 1, options, group });
const SPEC_MIRROR: ParamSpec[] = ([1, 2] as const).flatMap((n) => {
  const g = `LFO ${n}`;
  return [
    choice(`lfo${n}Shape`, 'Shape', SHAPES, 0, g),
    choice(`lfo${n}Dest`, 'Destination', DESTS, n === 1 ? 0 : 1, g),
    { id: `lfo${n}Amount`, name: 'Amount', min: -1, max: 1, default: 0, unit: '%', scale: 'linear', group: g },
    choice(`lfo${n}Sync`, 'Tempo sync', ['Off', 'On'], 0, g),
    { id: `lfo${n}Rate`, name: 'Rate (free)', min: 0.02, max: 40, default: 5, unit: 'Hz', scale: 'log', group: g },
    choice(`lfo${n}Division`, 'Rate (sync)', DIVS, 10, g),
    choice(`lfo${n}Retrig`, 'Retrigger', ['Off', 'On'], 0, g),
    { id: `lfo${n}Fade`, name: 'Fade in', min: 0, max: 5000, default: 0, unit: 'ms', scale: 'linear', group: g },
  ] as ParamSpec[];
});

const triSpecs = (): ParamSpec[] => (REGENERATED ? TRI.params : [...TRI.params, ...SPEC_MIRROR]);

function paramProblems(where: string, specs: ParamSpec[], params: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    const spec = specs.find((s) => s.id === k);
    if (!spec) out.push(`${where}: no param "${k}"`);
    else if (!Number.isFinite(v) || clampToSpec(spec, v) !== v) out.push(`${where}: ${k} = ${v} is off-spec (range ${spec.min}..${spec.max}${spec.step ? ` step ${spec.step}` : ''})`);
  }
  return out;
}

test('six or more TriOsc presets, each using at least one LFO', () => {
  assert.ok(TRIOSC_LFO_PRESETS.length >= 6);
  for (const p of TRIOSC_LFO_PRESETS) {
    assert.equal(p.plugin, 'krypt.triosc', p.id);
    assert.ok(p.params.lfo1Amount !== 0 || p.params.lfo2Amount !== 0, `${p.id}: no LFO in use`);
    assert.ok(p.tags.includes('lfo'), `${p.id}: tag it 'lfo' so find_presets finds the set`);
  }
  const uses = (dest: number, pred: (p: Record<string, number>, n: 1 | 2) => boolean = () => true) =>
    TRIOSC_LFO_PRESETS.some((p) => ([1, 2] as const).some((n) => p.params[`lfo${n}Amount`] !== 0 && p.params[`lfo${n}Dest`] === dest && pred(p.params, n)));
  assert.ok(uses(1, (p, n) => p[`lfo${n}Sync`] === 1 && p[`lfo${n}Division`] === TDIV['1/8']), 'wobble 1/8');
  assert.ok(uses(2, (p, n) => p[`lfo${n}Sync`] === 1 && p[`lfo${n}Shape`] === 4), 'amp gate');
  assert.ok(uses(0, (p, n) => p[`lfo${n}Fade`] > 0 && p[`lfo${n}Retrig`] === 1), 'vibrato with fade-in');
  assert.ok(uses(0, (p, n) => p[`lfo${n}Shape`] === 5), 'sample & hold');
  assert.ok(uses(3), 'auto-pan');
  assert.ok(uses(1, (p, n) => p[`lfo${n}Division`] >= TDIV['1bar']), 'slow filter sweep');
});

test('presets pass the schema, carry the full TriOsc param set and stay on-spec', () => {
  const problems: string[] = [];
  const all = triSpecs();
  for (const p of TRIOSC_LFO_PRESETS) {
    const r = zInstrumentPreset.safeParse(p);
    assert.ok(r.success, `${p.id}: ${r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    problems.push(...paramProblems(p.id, all, p.params));
    for (const s of all) if (!(s.id in p.params)) problems.push(`${p.id}: does not state ${s.id}`);
    assert.equal(typeof p.params.gain, 'number');
    assert.ok((p.fx ?? []).length <= MAX_FX_SLOTS);
    (p.fx ?? []).forEach((f, i) => {
      const plugin = byId.get(f.type);
      assert.ok(plugin && plugin.kind === 'effect', `${p.id} fx ${i}: ${f.type}`);
      problems.push(...paramProblems(`${p.id} fx ${i}`, plugin.params, f.params));
    });
  }
  assert.deepEqual(problems, []);
  for (const s of SPEC_MIRROR) assert.equal(TRI_LFO_OFF[s.id], s.default, s.id);
});

test('ids, names, roles, genres and chains follow the factory rules', () => {
  const ids = new Set(INSTRUMENT_PRESETS.map((p) => p.id));
  const names = new Set(INSTRUMENT_PRESETS.map((p) => `${p.role}:${p.name.toLowerCase()}`));
  for (const p of TRIOSC_LFO_PRESETS) {
    if (!REGENERATED || !INSTRUMENT_PRESETS.includes(p)) {
      assert.ok(!ids.has(p.id), `${p.id} already exists`);
      assert.ok(!names.has(`${p.role}:${p.name.toLowerCase()}`), `${p.name} already used in ${p.role}`);
    }
    assert.match(p.id, /^factory:([a-z0-9]+)\/([a-z0-9][a-z0-9-]*)$/);
    assert.ok((INSTRUMENT_ROLES as readonly string[]).includes(p.role));
    for (const g of p.genres) assert.ok((GENRE_IDS as readonly string[]).includes(g), `${p.id}: ${g}`);
    assert.ok(p.description.length >= 40 && /[.!]$/.test(p.description), p.id);
    const cut = Math.max(...(p.fx ?? []).filter((f) => f.type === 'krypt.eq' && f.params.b1On === 1).map((f) => f.params.b1Freq));
    if (p.role === 'bass') {
      assert.ok(cut >= 20 && cut <= 60, `${p.id}: low cut ${cut}`);
      assert.equal(p.channel?.mono, true, `${p.id}: bass is mono`);
    } else assert.ok(cut >= 50, `${p.id}: low cut ${cut}`);
    assert.ok(p.range && p.range[0] <= p.range[1]);
  }
});

test('adding them changes no role + genre default pick (playbooks keep their sounds)', () => {
  const merged = [...INSTRUMENT_PRESETS.filter((p) => !TRIOSC_LFO_PRESETS.includes(p)), ...TRIOSC_LFO_PRESETS];
  const before = INSTRUMENT_PRESETS.filter((p) => !TRIOSC_LFO_PRESETS.includes(p));
  for (const role of INSTRUMENT_ROLES) {
    for (const g of GENRE_IDS) {
      const a = pickPreset(before, role, g)?.id;
      const b = pickPreset(merged, role, g)?.id;
      assert.equal(b, a, `${role} for ${g}: ${a} would become ${b}`);
    }
  }
});

test('once the catalog is regenerated: the mirror matches it and the presets are merged', () => {
  if (!REGENERATED) return;
  for (const m of SPEC_MIRROR) {
    const s = TRI.params.find((p) => p.id === m.id);
    assert.ok(s, `catalog lacks ${m.id}`);
    for (const f of ['min', 'max', 'default', 'step', 'unit', 'scale', 'group'] as const) assert.equal(s[f], m[f], `${m.id}.${f}`);
    assert.deepEqual(s.options, m.options, `${m.id}.options`);
  }
  for (const p of TRIOSC_LFO_PRESETS) {
    assert.ok(INSTRUMENT_PRESETS.some((x) => x.id === p.id), `${p.id}: add ...TRIOSC_LFO_PRESETS to ALL in shared/sounds/factory/instruments/index.ts`);
  }
});

run('presets-triosc-lfo');
