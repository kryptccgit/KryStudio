// Krypt Script (Wave 12.2b): the header parser, the QuickJS sandbox limits
// (an endless loop is killed, a huge allocation is refused, no require /
// process / fetch / timers / Date), determinism, strict output validation,
// every factory script, the commands (scripts.save / scripts.remove /
// notes.applyScript as one undo step), the user library and the MCP tools
// write_script / run_script against a real DocHost.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity, zProject, type Note } from '@shared/schema/project';
import type { Settings } from '@shared/types';
import { defaultParams, describeParams, parseScriptHeader, resolveParams } from '@shared/scripts/header';
import { cleanScriptOutput } from '@shared/scripts/output';
import { sampleContext } from '@shared/scripts/sample';
import { FACTORY_SCRIPTS, NEW_SCRIPT_TEMPLATE } from '@shared/scripts/factory';
import { SCRIPT_LIMITS } from '@shared/scripts/types';
import { runSandboxed } from '../electron/scripts/sandbox';
import { cleanRunRequest, ScriptService, slugify } from '../electron/scripts/service';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, getTool, newSession, type ToolCaller } from '../electron/mcp/tools';

const BAR = 3840;
const HEAD = '// @name T\n// @kind generator\n';

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `krypt-scripts-${tag}-`));
}

function rig(tag = 'rig') {
  const doc = new DocHost(createDefaultProject('Scripts'), CATALOG, { strict: true });
  const userDataDir = tmpDir(tag);
  const settings = { mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false } } as unknown as Settings;
  const deps = {
    doc,
    engine: {
      request: async () => ({ ok: true, data: {} }),
      status: () => ({ state: 'running', device: null, engineVersion: '0.1.0', restarts: 0 }),
      onStatus: () => () => {},
      onEvent: () => () => {},
      telemetryUrl: () => null,
    },
    project: { status: () => ({ path: null, name: 'Scripts', dirty: false, lastSavedAt: null, recovered: false }), resolveSamplePath: (p: string) => p, renderDir: () => os.tmpdir(), allowedRoots: () => [] },
    getSettings: () => settings,
    updateSettings: () => settings,
    broadcast: () => {},
    userDataDir,
    appExePath: process.execPath,
    shimExePath: null,
    log: () => {},
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'script-agent', name: 'Script Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  const pat = doc.project.transport.activePatternId!;
  const chId = (name: string) => doc.project.channelOrder.find((id) => doc.project.channels[id].name === name)!;
  const notes = (name: string): Note[] => Object.values(doc.project.patterns[pat].notes[chId(name)] ?? {}).sort((a, b) => a.tick - b.tick || a.key - b.key);
  const svc = new ScriptService({ userDataDir, project: () => doc.project });
  const exec = <T = any>(cmd: string, args: unknown): T => {
    const r = doc.exec<T>(cmd, args, { actor: USER });
    if (!r.ok) throw new Error(r.message);
    return r.data as T;
  };
  /** Am, F, C, G chords (one bar each) on Keys. */
  const writeChords = () => {
    const chords = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
    exec('notes.add', { patternId: pat, channelId: chId('Keys'), notes: chords.flatMap((ks, b) => ks.map((key) => ({ tick: b * BAR, dur: BAR, key, vel: 0.8 }))) });
  };
  return { doc, deps, call, pat, chId, notes, svc, exec, writeChords, userDataDir };
}

const sig = (ns: Array<{ tick: number; key: number; dur: number; vel: number }>) => ns.map((n) => `${n.tick}:${n.key}:${n.dur}:${n.vel}`).join(' ');

// ── Header ────────────────────────────────────────────────────────────

test('header: name, kind, description and number / choice / toggle params', () => {
  const h = parseScriptHeader(
    [
      '// @name Test device',
      '// @kind transform',
      '// @description Line one.',
      '// @description Line two.',
      '// @param amount number 0.5 0..1 step 0.05 "Amount"',
      '// @param pitch number 0 -12..12',
      '// @param style choice up up|down|random "Style"',
      '// @param on toggle off',
      'function run({ notes }) { return notes; }',
    ].join('\n'),
  );
  assert.equal(h.ok, true, JSON.stringify(h.issues));
  const hd = h.header!;
  assert.equal(hd.name, 'Test device');
  assert.equal(hd.kind, 'transform');
  assert.equal(hd.description, 'Line one. Line two.');
  assert.deepEqual(hd.params[0], { id: 'amount', type: 'number', label: 'Amount', default: 0.5, min: 0, max: 1, step: 0.05 });
  assert.deepEqual(hd.params[1], { id: 'pitch', type: 'number', label: 'Pitch', default: 0, min: -12, max: 12, step: 1 });
  assert.deepEqual(hd.params[2], { id: 'style', type: 'choice', label: 'Style', default: 'up', options: ['up', 'down', 'random'] });
  assert.deepEqual(hd.params[3], { id: 'on', type: 'toggle', label: 'On', default: false });
  assert.deepEqual(defaultParams(hd), { amount: 0.5, pitch: 0, style: 'up', on: false });
  assert.match(describeParams(hd), /amount 0\.\.1 \(default 0\.5\); pitch -12\.\.12/);
});

test('header: every problem names its line', () => {
  const h = parseScriptHeader(['// @name X', '// @kind sideways', '// @param 9x number 1 0..2', '// @param d number 5 0..1', '// @param c choice z a|b', '// @param t toggle maybe', '// @colour red', 'const x = 1;'].join('\n'));
  assert.equal(h.ok, false);
  const lines = h.issues.map((i) => i.line);
  for (const l of [2, 3, 4, 5, 6, 7]) assert.ok(lines.includes(l), `line ${l} reported: ${JSON.stringify(h.issues)}`);
  assert.ok(h.issues.some((i) => /function run/.test(i.message)));
  const none = parseScriptHeader('function run() { return []; }');
  assert.ok(none.issues.some((i) => /needs a name/.test(i.message)) && none.issues.some((i) => /needs a kind/.test(i.message)));
  assert.equal(parseScriptHeader('').ok, false);
  assert.match(parseScriptHeader(`${HEAD}${'x'.repeat(SCRIPT_LIMITS.codeChars)}`).issues[0].message, /too long/);
});

test('params: clamped and snapped; strict mode refuses unknown names and wrong types', () => {
  const h = parseScriptHeader(`${HEAD}// @param n number 4 1..8 step 1\n// @param c choice a a|b\n// @param t toggle on\nfunction run(){return []}`).header!;
  const r = resolveParams(h, { n: 99.4, c: 'b', t: false }, true);
  assert.deepEqual(r, { ok: true, params: { n: 8, c: 'b', t: false } });
  assert.deepEqual(resolveParams(h, { n: 2.6 }, true), { ok: true, params: { n: 3, c: 'a', t: true } });
  const bad = resolveParams(h, { nope: 1 }, true);
  assert.equal(bad.ok, false);
  assert.match((bad as { message: string }).message, /no param "nope".*n, c, t/);
  assert.equal(resolveParams(h, { c: 'z' }, true).ok, false);
  assert.deepEqual(resolveParams(h, { c: 'z', nope: 1 }, false), { ok: true, params: { n: 4, c: 'a', t: true } }, 'lenient: defaults');
});

// ── Sandbox ───────────────────────────────────────────────────────────

test('sandbox: an endless loop is killed by the CPU deadline', async () => {
  const t0 = Date.now();
  const r = await runSandboxed(`${HEAD}function run() { while (true) {} }`, {});
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, 'timeout');
  assert.match((r as { message: string }).message, /longer than 200 ms/);
  assert.ok(Date.now() - t0 < 2000, `stopped quickly (${Date.now() - t0} ms)`);
  // top-level code is limited too
  const top = await runSandboxed(`${HEAD}for(;;){}\nfunction run(){return []}`, {});
  assert.equal((top as { kind: string }).kind, 'timeout');
});

test('sandbox: a huge allocation is refused, runaway recursion is stopped, and the next run still works', async () => {
  const big = await runSandboxed(`${HEAD}function run() { const a = []; for (let i = 0; i < 1e9; i++) a.push({ i, s: 'xxxxxxxxxxxxxxxxxxxxxxxx' + i }); return a; }`, {});
  assert.equal(big.ok, false);
  assert.ok(['memory', 'timeout'].includes((big as { kind: string }).kind), (big as { message: string }).message);
  const buf = await runSandboxed(`${HEAD}function run() { return new Array(1e9).fill(1); }`, {});
  assert.equal(buf.ok, false);
  const str = await runSandboxed(`${HEAD}function run() { let s = 'x'; for (;;) s += s; }`, {});
  assert.equal((str as { kind: string }).kind, 'memory');
  const rec = await runSandboxed(`${HEAD}function f(n) { return f(n + 1) + 1; }\nfunction run() { return f(0); }`, {});
  assert.equal((rec as { kind: string }).kind, 'memory');
  assert.match((rec as { message: string }).message, /Stack overflow/);
  const after = await runSandboxed(`${HEAD}function run() { return [{ tick: 0, dur: 10, key: 60, vel: 0.5 }]; }`, {});
  assert.equal(after.ok, true, 'a fresh run after the failures');
});

test('sandbox: no require, import, process, fetch, timers, Date or host objects', async () => {
  const r = await runSandboxed(
    `${HEAD}function run() { return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof setInterval, typeof Date, typeof XMLHttpRequest, typeof WebAssembly, typeof Buffer, typeof module, typeof globalThis.std, typeof globalThis.os, typeof Promise]; }`,
    {},
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual((r as { value: unknown }).value, Array(13).fill('undefined'));
  const req = await runSandboxed(`${HEAD}function run() { return require('fs'); }`, {});
  assert.equal(req.ok, false);
  assert.match((req as { message: string }).message, /require/);
  const imp = await runSandboxed(`${HEAD}import fs from 'fs';\nfunction run() { return []; }`, {});
  assert.equal(imp.ok, false, 'import declarations are a syntax error in a script');
  const dyn = await runSandboxed(`${HEAD}function run() { import('fs'); return []; }`, {});
  assert.equal(dyn.ok, false, 'dynamic import fails');
  const ok = await runSandboxed(`${HEAD}function run() { return [{ tick: 0, dur: 1, key: 60, vel: 1 }]; }`, {});
  assert.equal(ok.ok, true, 'the module recovers after a teardown failure');
});

test('sandbox: syntax and runtime errors carry the script line', async () => {
  const syn = await runSandboxed(`${HEAD}\nfunction run( {\n  return [];\n}\n`, {});
  assert.equal(syn.ok, false);
  assert.equal((syn as { kind: string }).kind, 'syntax');
  assert.ok((syn as { line: number }).line >= 4, `line ${(syn as { line: number }).line}`);
  const rt = await runSandboxed(`${HEAD}\nfunction run() {\n  const x = 1;\n  return foo.bar;\n}\n`, {});
  assert.equal((rt as { kind: string }).kind, 'runtime');
  assert.equal((rt as { line: number }).line, 6);
  assert.match((rt as { message: string }).message, /ReferenceError: 'foo' is not defined/);
  const norun = await runSandboxed(`${HEAD}function go() {}`, {});
  assert.match((norun as { message: string }).message, /needs a function run/);
  const circ = await runSandboxed(`${HEAD}function run() { const a = {}; a.a = a; return [a]; }`, {});
  assert.match((circ as { message: string }).message, /plain data/);
});

test('sandbox: deterministic: rand and Math.random are seeded; console.log is captured', async () => {
  const code = `${HEAD}function run({ rand, seed }) { console.log('seed', seed, { a: 1 }); return [rand(), rand.int(1, 6), Math.random(), rand.pick(['a', 'b', 'c'])]; }`;
  const a = await runSandboxed(code, { seed: 7, scaleSteps: [0], key: 0, chords: [] });
  const b = await runSandboxed(code, { seed: 7, scaleSteps: [0], key: 0, chords: [] });
  const c = await runSandboxed(code, { seed: 8, scaleSteps: [0], key: 0, chords: [] });
  assert.equal(a.ok && b.ok && c.ok, true);
  assert.deepEqual((a as { value: unknown }).value, (b as { value: unknown }).value);
  assert.notDeepEqual((a as { value: unknown }).value, (c as { value: unknown }).value);
  assert.deepEqual((a as { logs: string[] }).logs, ['seed 7 {"a":1}']);
});

test('sandbox: helpers: degree, snap, inScale, euclid, chordAt in A minor', async () => {
  const ctx = sampleContext(parseScriptHeader(NEW_SCRIPT_TEMPLATE).header!, {});
  const r2 = await runSandboxed(`${HEAD}function run(c) { return [c.degree(0), c.degree(2, 3), c.degree(7), c.degree(-1), c.snap(61), c.inScale(60), c.inScale(61), c.euclid(3, 8, 0).map(Number).join(''), c.chordAt(3840).name]; }`, ctx);
  assert.deepEqual((r2 as { value: unknown }).value, [69, 60, 81, 67, 60, true, false, '10010010', 'F']);
});

// ── Output validation ────────────────────────────────────────────────

test('output: strict shape, clamped ranges, at most 4096 notes', () => {
  const ok = cleanScriptOutput([{ tick: -5, dur: 0, key: 200, vel: 100, pan: 3, color: 99.6, slide: true, extra: 'ignored' }, { tick: 10.6, dur: 20.2, key: 59.5 }]);
  assert.equal(ok.ok, true);
  const n = (ok as { notes: any[] }).notes;
  assert.deepEqual(n[0], { tick: 0, dur: 1, key: 127, vel: Math.round((100 / 127) * 1000) / 1000, pan: 1, slide: true, color: 15 });
  assert.deepEqual(n[1], { tick: 11, dur: 20, key: 60, vel: 0.78 });
  assert.deepEqual(cleanScriptOutput({ notes: [] }), { ok: true, notes: [] });
  const nan = cleanScriptOutput([{ tick: 0, dur: 1, key: 60 }, { tick: NaN, dur: 1, key: 60 }]);
  assert.equal(nan.ok, false);
  assert.match((nan as { message: string }).message, /Note 1 .*tick/);
  const str = cleanScriptOutput([{ tick: '0', dur: 1, key: 60 }]);
  assert.match((str as { message: string }).message, /tick must be a number/);
  assert.match((cleanScriptOutput([5]) as { message: string }).message, /not a note object/);
  assert.match((cleanScriptOutput('nope') as { message: string }).message, /must return an array/);
  assert.match((cleanScriptOutput(undefined) as { message: string }).message, /returned nothing/);
  const many = cleanScriptOutput(Array.from({ length: 4097 }, (_, i) => ({ tick: i, dur: 1, key: 60 })));
  assert.match((many as { message: string }).message, /4097 notes; the limit is 4096/);
  assert.equal(cleanScriptOutput(Array.from({ length: 4096 }, (_, i) => ({ tick: i, dur: 1, key: 60 }))).ok, true);
});

// ── Factory scripts ───────────────────────────────────────────────────

test('factory: 6+ scripts, valid headers, each one produces valid notes on the sample context (default params, 3 seeds)', async () => {
  assert.ok(FACTORY_SCRIPTS.length >= 6);
  assert.equal(new Set(FACTORY_SCRIPTS.map((s) => s.id)).size, FACTORY_SCRIPTS.length);
  const kinds = new Set<string>();
  for (const s of [...FACTORY_SCRIPTS, { id: 'template', code: NEW_SCRIPT_TEMPLATE }]) {
    const h = parseScriptHeader(s.code);
    assert.equal(h.ok, true, `${s.id}: ${JSON.stringify(h.issues)}`);
    assert.ok(h.header!.description.length > 30, `${s.id} describes itself`);
    kinds.add(h.header!.kind);
    for (const seed of [1, 2, 3]) {
      const r = await runSandboxed(s.code, sampleContext(h.header!, defaultParams(h.header!), seed));
      assert.equal(r.ok, true, `${s.id} seed ${seed}: ${JSON.stringify(r)}`);
      const out = cleanScriptOutput((r as { value: unknown }).value);
      assert.equal(out.ok, true, `${s.id}: ${JSON.stringify(out)}`);
      assert.ok((out as { notes: unknown[] }).notes.length > 0, `${s.id} returns notes`);
      assert.ok((r as { ms: number }).ms < 200);
    }
  }
  assert.deepEqual([...kinds].sort(), ['generator', 'transform']);
});

test('factory: every param extreme still gives valid notes', async () => {
  for (const s of FACTORY_SCRIPTS) {
    const h = parseScriptHeader(s.code).header!;
    for (const pick of ['min', 'max'] as const) {
      const params = defaultParams(h);
      for (const p of h.params) {
        if (p.type === 'number') params[p.id] = pick === 'min' ? p.min : p.max;
        else if (p.type === 'choice') params[p.id] = pick === 'min' ? p.options[0] : p.options[p.options.length - 1];
        else params[p.id] = pick === 'max';
      }
      const r = await runSandboxed(s.code, sampleContext(h, params, 5));
      assert.equal(r.ok, true, `${s.id} ${pick}: ${JSON.stringify(r)}`);
      assert.equal(cleanScriptOutput((r as { value: unknown }).value).ok, true, `${s.id} ${pick}`);
    }
  }
});

// ── Service + commands on a real project ─────────────────────────────

test('service: Markov melody stays in the key; same seed = same plan; preview gives 4 variations', async () => {
  const { svc, pat, chId } = rig('melody');
  const req = { script: { id: 'factory:markov-melody' }, patternId: pat, channelId: chId('Keys'), range: { fromBar: 1, bars: 4 }, seed: 11, key: { root: 9, scale: 'minor' } };
  const a = await svc.prepare(req);
  assert.equal(a.ok, true, a.message);
  const scale = [0, 2, 3, 5, 7, 8, 10];
  for (const n of a.data!.plan.notes) assert.ok(scale.includes((n.key - 9 + 120) % 12), `${n.key} in A minor`);
  assert.ok(a.data!.plan.notes.every((n) => n.tick >= 0 && n.tick < 4 * BAR));
  assert.equal(a.data!.plan.keyName, 'A minor');
  const b = await svc.prepare(req);
  assert.equal(sig(a.data!.plan.notes), sig(b.data!.plan.notes));
  const v = await svc.previews(req, [11, 12, 13, 14]);
  assert.equal(v.length, 4);
  assert.ok(v.every((x) => x.ok));
  assert.equal(sig(v[0].data!.notes), sig(a.data!.plan.notes));
  assert.equal(new Set(v.map((x) => sig(x.data!.notes))).size, 4, 'four different takes');
});

test('service + notes.applyScript: a transform replaces the notes it got, ONE undo step; the same take again is "No change"', async () => {
  const { svc, doc, pat, chId, notes, writeChords } = rig('apply');
  writeChords();
  const before = sig(notes('Keys'));
  const req = { script: { id: 'factory:arpeggiator' }, patternId: pat, channelId: chId('Keys'), params: { pattern: 'up', rate: '8th' }, seed: 1 };
  const hist = doc.getHistory().length;
  const r = await svc.apply(req, (cmd, args) => {
    const x = doc.exec(cmd, args, { actor: USER });
    if (!x.ok) throw new Error(x.message);
    return x.data as never;
  });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message!, /Arpeggiator: 32 notes in bars 1–4, replacing 12/);
  assert.equal(notes('Keys').length, 32, '4 bars of 8ths');
  assert.deepEqual(notes('Keys').slice(0, 3).map((n) => n.key), [57, 60, 64]);
  assert.equal(doc.getHistory().length, hist + 1, 'one history entry');
  const again = await svc.prepare({ ...req });
  assert.equal(again.ok, true, 'an arp of the arp is a new result');
  doc.undo(USER);
  assert.equal(sig(notes('Keys')), before, 'undo restores the chords');
  // identical output → No change
  const same = await svc.prepare({ script: { code: `// @name Same\n// @kind transform\nfunction run({ notes }) { return notes; }` }, patternId: pat, channelId: chId('Keys'), seed: 1 });
  assert.equal(same.ok, false);
  assert.match(same.message!, /^No change:/);
});

test('service: generator merge vs replace, bars, notes outside the bars dropped, selection replaced', async () => {
  const { svc, pat, chId, exec, notes } = rig('gen');
  const hat = chId('Hat');
  exec('notes.add', { patternId: pat, channelId: hat, notes: [{ tick: 0, dur: 240, key: 60 }, { tick: 5 * BAR, dur: 240, key: 60 }] });
  const code = `// @name Outside\n// @kind generator\nfunction run({ start, end, rootKey }) { return [{ tick: start - 10, dur: 10, key: rootKey }, { tick: start + 480, dur: 99999, key: rootKey, vel: 0.5 }, { tick: end, dur: 10, key: rootKey }]; }`;
  const p = await svc.prepare({ script: { code }, patternId: pat, channelId: hat, range: { fromBar: 2, bars: 1 }, seed: 1 });
  assert.equal(p.ok, true, p.message);
  assert.equal(p.data!.plan.notes.length, 1);
  assert.equal(p.data!.plan.dropped, 2);
  assert.equal(p.data!.plan.notes[0].dur, BAR - 480, 'clamped to the bars');
  assert.deepEqual(p.data!.plan.remove, []);
  const m = await svc.prepare({ script: { code }, patternId: pat, channelId: hat, range: { fromBar: 1, bars: 1 }, mode: 'merge', seed: 1 });
  assert.equal(m.data!.plan.remove.length, 0);
  const rep = await svc.prepare({ script: { code }, patternId: pat, channelId: hat, range: { fromBar: 1, bars: 1 }, seed: 1 });
  assert.equal(rep.data!.plan.remove.length, 1, 'replace removes the channel notes in bar 1');
  const ids = notes('Hat').map((n) => n.id);
  const sel = await svc.prepare({ script: { code }, patternId: pat, channelId: hat, ids: [ids[1]], seed: 1 });
  assert.deepEqual(sel.data!.plan.remove, [ids[1]]);
  assert.equal(sel.data!.plan.range.fromBar, 6, 'the selection\'s bar');
  const empty = await svc.prepare({ script: { code: '// @name E\n// @kind transform\nfunction run(){return []}' }, patternId: pat, channelId: chId('808'), seed: 1 });
  assert.match(empty.message!, /"808" has no notes in bars 1–6 to transform/);
  const thrower = await svc.prepare({ script: { code: '// @name Boom\n// @kind generator\n\nfunction run() {\n  throw new Error("nope");\n}' }, patternId: pat, channelId: hat, seed: 1 });
  assert.match(thrower.message!, /"Boom" line 5: Error: nope/);
  assert.match((await svc.prepare({ script: { id: 'factory:nope' }, patternId: pat, channelId: hat, seed: 1 })).message!, /No script "factory:nope"/);
  assert.match((await svc.prepare({ script: { id: 'factory:ratchet' }, patternId: pat, channelId: hat, params: { bogus: 1 }, seed: 1 }, { strict: true })).message!, /no param "bogus"/);
});

test('commands: scripts.save / scripts.remove keep scripts in the project (zod + integrity), one undo step each', () => {
  const { doc, exec } = rig('cmds');
  const code = FACTORY_SCRIPTS[0].code;
  const r = exec<{ id: string; created: boolean; name: string }>('scripts.save', { code });
  assert.equal(r.created, true);
  assert.match(r.id, /^scr_/);
  assert.equal(doc.project.scripts![r.id].name, 'Euclid with probability');
  const same = doc.exec('scripts.save', { code }, { actor: USER });
  assert.equal(same.ok, false);
  assert.match(same.message!, /^No change:/);
  const upd = exec<{ id: string; created: boolean }>('scripts.save', { code: code.replace('0.85', '0.5') });
  assert.equal(upd.id, r.id, 'same name = update');
  assert.equal(upd.created, false);
  const renamed = exec<{ id: string }>('scripts.save', { code, name: 'Hats' });
  assert.notEqual(renamed.id, r.id);
  const bad = doc.exec('scripts.save', { code: '// @name X\n// @kind nope\nfunction run(){}' }, { actor: USER });
  assert.equal(bad.ok, false);
  assert.match(bad.message!, /Line 2: @kind must be/);
  // round trip through the load-time schema
  const parsed = zProject.parse(JSON.parse(JSON.stringify(doc.project)));
  assert.equal(Object.keys(parsed.scripts ?? {}).length, 2);
  assert.deepEqual(checkIntegrity(parsed), []);
  assert.ok(checkIntegrity({ ...parsed, scripts: { scr_x: { id: 'scr_y', name: 'a', code: '' } } }).some((e) => /another id/.test(e)));
  exec('scripts.remove', { id: renamed.id });
  exec('scripts.remove', { id: r.id });
  assert.equal(doc.project.scripts, undefined, 'the record goes when empty');
  doc.undo(USER);
  assert.equal(Object.keys(doc.project.scripts!).length, 1);
});

test('library: save (atomic, slugged), list, find by name, update, remove; project scripts listed too', async () => {
  const { svc, exec, userDataDir } = rig('lib');
  const code = NEW_SCRIPT_TEMPLATE;
  const s = await svc.saveToLibrary(code, 'My Fifths!');
  assert.equal(s.ok, true, s.message);
  assert.equal(s.data!.id, 'user:my-fifths');
  assert.ok(fs.existsSync(path.join(userDataDir, 'scripts', 'my-fifths.js')));
  assert.match(fs.readFileSync(path.join(userDataDir, 'scripts', 'my-fifths.js'), 'utf8'), /^\/\/ @name My Fifths!/);
  const again = await svc.saveToLibrary(code, 'My Fifths!');
  assert.match(again.message!, /^No change:/);
  exec('scripts.save', { code: FACTORY_SCRIPTS[1].code });
  const cat = await svc.catalog();
  assert.equal(cat.user.length, 1);
  assert.equal(cat.project.length, 1);
  assert.equal(cat.factory.length, FACTORY_SCRIPTS.length);
  assert.equal((await svc.find('my fifths!'))?.id, 'user:my-fifths');
  assert.equal((await svc.find('Markov melody'))?.source, 'project', 'the project copy wins by name');
  assert.equal((await svc.find('factory:ratchet'))?.name, 'Ratchet');
  fs.writeFileSync(path.join(userDataDir, 'scripts', 'broken.js'), '// @name Broken\nfunction run(){}');
  const broken = (await svc.userScripts()).find((x) => x.id === 'user:broken')!;
  assert.equal(broken.header, null);
  assert.ok(broken.issues.length > 0);
  assert.equal((await svc.removeFromLibrary('user:my-fifths')).ok, true);
  assert.equal((await svc.removeFromLibrary('user:../../x')).ok, false);
  assert.equal((await svc.removeFromLibrary('factory:ratchet')).ok, false);
  assert.equal(slugify('  Ünïcode — Device  '), 'unicode-device');
});

test('check: header issues and syntax errors together; trial run catches runtime errors with lines', async () => {
  const { svc } = rig('check');
  const c = await svc.check('// @name X\n// @kind nope\nfunction run( {');
  assert.equal(c.ok, false);
  assert.ok(c.issues.some((i) => i.line === 2));
  assert.ok(c.issues.some((i) => /Syntax error/.test(i.message)));
  const trial = await svc.check('// @name T\n// @kind transform\nfunction run({ notes }) {\n  return notes.map((n) => n.nope.x);\n}', { trial: true });
  assert.equal(trial.ok, false);
  assert.equal(trial.issues[0].line, 4);
  assert.match(trial.issues[0].message, /test run/);
  assert.equal((await svc.check(NEW_SCRIPT_TEMPLATE, { trial: true })).ok, true);
});

test('IPC payloads: cleanRunRequest checks every field', () => {
  assert.equal(cleanRunRequest(null), null);
  assert.equal(cleanRunRequest({ script: {}, patternId: 'p', channelId: 'c' }), null);
  const r = cleanRunRequest({ script: { id: 'factory:ratchet' }, patternId: 'p', channelId: 'c', ids: ['a', 5], range: { fromBar: 0, bars: 2 }, mode: 'x', seed: -1, key: { root: 3, scale: 'minor' }, params: [1] })!;
  assert.deepEqual(r, { script: { id: 'factory:ratchet' }, patternId: 'p', channelId: 'c', ids: ['a'], range: undefined, mode: 'replace', params: undefined, seed: 1, key: { root: 3, scale: 'minor' } });
});

// ── MCP ───────────────────────────────────────────────────────────────

test('MCP write_script: line-numbered errors, nothing saved; then saved in the project (one undo) or the library', async () => {
  const { call, doc, userDataDir } = rig('mcp-write');
  assert.equal(getTool('write_script')!.kind, 'write');
  assert.match(getTool('write_script')!.description, /function run\(ctx\)/);
  const bad = await call('write_script', { code: '// @name Up a fifth\n// @kind transform\n\nfunction run({ notes }) {\n  return notes.map((n) => ({ ...n, key: n.key + undefinedThing }));\n}' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Line 5: On a test run .*ReferenceError: 'undefinedThing' is not defined/);
  assert.equal(doc.project.scripts, undefined);
  const hdr = await call('write_script', { code: '// @kind transform\nfunction run({ notes }) { return notes; }' });
  assert.match(hdr.message, /Line 1: The header needs a name/);
  assert.match(hdr.message, /Header syntax:/);
  const good = await call('write_script', { code: NEW_SCRIPT_TEMPLATE, change_label: 'Add a fifths device' });
  assert.equal(good.ok, true, good.message);
  assert.match(good.message, /Saved "My device" \(transform; interval -24\.\.24 \(default 7\); keep on\|off \(default on\)\) in the project as scr_/);
  assert.equal(Object.keys(doc.project.scripts ?? {}).length, 1);
  const same = await call('write_script', { code: NEW_SCRIPT_TEMPLATE });
  assert.equal(same.ok, false);
  assert.match(same.message, /^No change:/);
  const lib = await call('write_script', { code: NEW_SCRIPT_TEMPLATE, where: 'library', name: 'Fifths' });
  assert.equal(lib.ok, true, lib.message);
  assert.match(lib.message, /in the user's script library as user:fifths/);
  assert.ok(fs.existsSync(path.join(userDataDir, 'scripts', 'fifths.js')));
});

test('MCP run_script: dry run returns KPN and changes nothing; a run is one undo step; same seed again = No change', async () => {
  const { call, notes, writeChords, doc } = rig('mcp-run');
  writeChords();
  const before = sig(notes('Keys'));
  const dry = await call('run_script', { script: 'Arpeggiator', channel: 'Keys', params: { pattern: 'upDown', rate: '16th', octaves: 2 }, seed: 4, dry_run: true });
  assert.equal(dry.ok, true, dry.message);
  assert.match(dry.message, /Dry run of "Arpeggiator" on Keys .*64 notes in bars 1–4, would replace 12, (A minor|C major), seed 4/);
  assert.match(dry.text ?? '', /pattern/);
  assert.match(dry.text ?? '', /Keys/);
  assert.equal(sig(notes('Keys')), before, 'dry run changed nothing');
  assert.deepEqual(dry.changed, []);
  const wet = await call('run_script', { script: 'factory:arpeggiator', channel: 'Keys', params: { pattern: 'upDown', rate: '16th', octaves: 2 }, seed: 4 });
  assert.equal(wet.ok, true, wet.message);
  assert.match(wet.message, /"Arpeggiator" on Keys in "Pattern 1": 64 notes in bars 1–4, replacing 12, (A minor|C major), seed 4/);
  assert.equal(notes('Keys').length, 64);
  const bad = await call('run_script', { script: 'Arpeggiator', channel: 'Keys', params: { speed: 2 } });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /no param "speed"/);
  const missing = await call('run_script', { script: 'Nope', channel: 'Keys' });
  assert.match(missing.message, /No script "Nope". Scripts: .*"Ratchet"/);
  assert.equal((await call('undo_last')).ok, true);
  assert.equal(sig(notes('Keys')), before, 'undo_last drops the whole run');
  const gen = await call('run_script', { script: 'Euclid with probability', channel: 'Hat', params: { pulses: 7, chance: 1 }, bars: '1-2', seed: 3 });
  assert.equal(gen.ok, true, gen.message);
  assert.equal(notes('Hat').length, 14);
  const again = await call('run_script', { script: 'Euclid with probability', channel: 'Hat', params: { pulses: 7, chance: 1 }, bars: '1-2', seed: 3 });
  assert.equal(again.ok, false);
  assert.match(again.message, /^No change:/);
  assert.ok(doc.getHistory().length >= 2);
});

await run('scripts');
