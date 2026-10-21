import assert from 'node:assert/strict';
import { test, run } from './harness';
import { pluginById } from '@shared/plugins/catalog';
import { clampToSpec } from '@shared/plugins/types';
import {
  GATE_CUSTOM_PATTERN,
  GATE_STEP_CODES,
  GATE_STEP_DIVS,
  GATE_STEP_MODES,
  GATE_STEP_PARAM_IDS,
  GATE_STEP_PRESETS,
  findGateStepPreset,
  gateStepParams,
  gateStepPresetParams,
  parseGateSteps,
  printGateSteps,
  readGateSteps,
} from '@shared/plugins/gateSteps';

const gate = pluginById('krypt.gate')!;
const spec = (id: string) => gate.params.find((p) => p.id === id)!;

test('mirrors the engine: pattern option, step modes, divisions and the Steps param group', () => {
  assert.equal(spec('pattern').options![GATE_CUSTOM_PATTERN], 'Custom steps');
  assert.deepEqual(spec('s1').options, [...GATE_STEP_MODES]);
  assert.deepEqual(spec('s16').options, [...GATE_STEP_MODES]);
  assert.deepEqual(spec('stepDiv').options, [...GATE_STEP_DIVS]);
  assert.equal(GATE_STEP_CODES.length, GATE_STEP_MODES.length);
  assert.deepEqual(
    gate.params.filter((p) => p.group === 'Steps').map((p) => p.id),
    [...GATE_STEP_PARAM_IDS],
  );
});

test('parse: division, codes, levels, mutes, separators; print is canonical and round-trips', () => {
  const r = parseGateSteps('1/8 p r2 R4:25 | . V:100, rp h s u r3');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.div, 2);
  assert.deepEqual(
    r.value.steps.map((s) => [s.mode, s.level]),
    [[0, 1], [1, 1], [3, 0.25], [0, 0], [6, 1], [4, 1], [5, 1], [7, 1], [8, 1], [2, 1]],
  );
  const text = printGateSteps(r.value);
  assert.equal(text, '1/8 P R2 R4:25 . V RP H S U R3');
  const again = parseGateSteps(text);
  assert.ok(again.ok && printGateSteps(again.value) === text);
  const plain = parseGateSteps('P P');
  assert.ok(plain.ok && plain.value.div === 1, 'default division 1/16');
});

test('parse: human errors, never throws', () => {
  const cases: Array<[string, RegExp]> = [
    ['', /No steps/],
    ['1/16', /No steps/],
    ['1/12 P', /Unknown step length "1\/12"/],
    ['P X P', /Step 2 "X"/],
    ['P P:150', /level must be 0 to 100/],
    [Array(17).fill('P').join(' '), /17 steps is too many/],
  ];
  for (const [text, re] of cases) {
    const r = parseGateSteps(text);
    assert.equal(r.ok, false, text);
    if (!r.ok) assert.match(r.message, re, text);
  }
});

test('params: switch to Custom steps, write all 16 steps, read back sparse params with defaults', () => {
  const r = parseGateSteps('1/4 R4 . H');
  assert.ok(r.ok);
  if (!r.ok) return;
  const p = gateStepParams(r.value);
  assert.equal(p.pattern, GATE_CUSTOM_PATTERN);
  assert.equal(p.stepDiv, 3);
  assert.equal(p.stepCount, 3);
  assert.equal(Object.keys(p).length, 3 + 32);
  assert.equal(p.s16, 0);
  assert.equal(p.g16, 1);
  for (const [k, v] of Object.entries(p)) assert.equal(clampToSpec(spec(k), v), v, `${k} is inside its spec`);
  assert.equal(printGateSteps(readGateSteps(p)), '1/4 R4 . H');
  assert.equal(printGateSteps(readGateSteps({})), '1/16 ' + Array(16).fill('P').join(' '));
  assert.equal(readGateSteps({ stepCount: 99, s1: 42, g1: -3 }).steps.length, 16, 'out-of-range values are clamped');
});

test('presets: unique ids and names, valid text, found by id or name', () => {
  assert.ok(GATE_STEP_PRESETS.length >= 8);
  assert.equal(new Set(GATE_STEP_PRESETS.map((p) => p.id)).size, GATE_STEP_PRESETS.length);
  assert.equal(new Set(GATE_STEP_PRESETS.map((p) => p.name)).size, GATE_STEP_PRESETS.length);
  for (const p of GATE_STEP_PRESETS) {
    const params = gateStepPresetParams(p);
    assert.equal(params.pattern, GATE_CUSTOM_PATTERN, p.id);
    assert.ok(p.description.length > 10, p.id);
    assert.equal(findGateStepPreset(p.name), p);
    assert.equal(findGateStepPreset(p.id), p);
  }
  assert.equal(findGateStepPreset('tape stop END')?.id, 'tape-stop-end');
  assert.equal(findGateStepPreset('P P P'), undefined);
});

await run('gate-steps');
