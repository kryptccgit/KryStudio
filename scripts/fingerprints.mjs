// Generate resources/factory/fingerprints.json (FingerprintIndex, shared/sound-match/types.ts): the timbre
// fingerprint of every factory instrument preset and every factory sample, so match_sounds can pick the sounds
// closest to a reference song (research/15 §3.2). GENERATED: never hand-edit the output.
//
//   node scripts/fingerprints.mjs [--engine <exe>] [--analyzer <exe>] [--jobs 8] [--packs-dir <dir>] [--keep-wav]
//   npm run fingerprints
//
// Presets: one tiny project per preset (its instrument, params, channel settings and FX chain on its own insert,
// master without a limiter) rendered by the engine's offline renderer at a role-appropriate note: bass / 808 / sub
// at C2 (MIDI 36), chord-ish roles (chord, stab) as a C-minor triad on C4, everything else at C4 (moved by octaves
// into the preset's range), held 1.5 s (measured over the held part only, like the reference's notes); drum
// presets one hit on C4 (measured whole). Full-kit presets (one
// channel = a GM kit) are skipped; presets that need a sound pack are rendered only with --packs-dir (the
// installed packs folder). Every render and every factory sample (resources/factory/index.json) is measured
// with the analyzer's `fingerprint` cmd. Entries: presets by id, then samples by path (deterministic).
//
// Defaults: the NEWEST build of each binary among engine/target/{release,debug} and resources/bin (the same
// rule the app uses in dev). Exit 1 when nothing could be measured or the analyzer has no `fingerprint` cmd; exit 2 on
// a missing binary. Writes atomically (tmp + rename).

import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'test', '.out');
const workDir = path.join(outDir, 'fingerprints');
const factoryDir = path.join(root, 'resources', 'factory');
const outFile = path.join(factoryDir, 'fingerprints.json');
const EXE = process.platform === 'win32' ? '.exe' : '';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const newest = (name) => {
  const xs = [
    path.join(root, 'engine', 'target', 'release', `${name}${EXE}`),
    path.join(root, 'engine', 'target', 'debug', `${name}${EXE}`),
    path.join(root, 'resources', 'bin', `${name}${EXE}`),
  ].filter((x) => existsSync(x));
  return xs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
};
const engineExe = opt('--engine', null) ?? newest('krypt-studio-engine');
const analyzerExe = opt('--analyzer', null) ?? newest('krypt-studio-analyzer');
const jobs = Math.max(1, Number(opt('--jobs', String(Math.min(8, os.cpus().length)))) || 4);
const packsDir = opt('--packs-dir', null);
const keepWav = flag('--keep-wav');

function die(msg, code = 1) {
  console.error(`✖ fingerprints: ${msg}`);
  process.exit(code);
}

if (!engineExe || !existsSync(engineExe)) die(`no engine at ${engineExe}. Build it first (npm run engine:build) or pass --engine.`, 2);
if (!analyzerExe || !existsSync(analyzerExe)) die('no krypt-studio-analyzer found (engine/target, resources/bin). Build it or pass --analyzer.', 2);
if (packsDir && !existsSync(packsDir)) die(`no packs folder at ${packsDir}.`, 2);
if (!existsSync(path.join(factoryDir, 'index.json'))) die('resources/factory/index.json is missing: generate the factory kit first (npm run engine:build).', 2);
mkdirSync(workDir, { recursive: true });
const started = Date.now();

// ── Bundle the TS sources we need ─────────────────────────────────────

const bundle = path.join(outDir, 'fingerprints.bundle.mjs');
await build({
  stdin: {
    contents: `
      export { INSTRUMENT_PRESETS } from './shared/sounds/factory/instruments';
      export { createDefaultProject, makeInsert, makeSlot, makeChannel, makePattern, makeSample } from './shared/schema/factory';
      export { CATALOG } from './shared/plugins/catalog';
      export { defaultNote } from './shared/schema/project';
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  alias: { '@shared': path.join(root, 'shared') },
  logLevel: 'error',
});
const M = await import(`file://${bundle.replace(/\\/g, '/')}?t=${Date.now()}`);

// ── Notes per role (PPQ 960, 120 BPM: a beat = 0.5 s) ─────────────────

const BPM = 120;
const HOLD = 2880; // 1.5 s
const HIT = 240; // a 16th: drums are one-shots
const BAR = 3840;
const DRUM_ROLES = new Set(['kick', 'snare', 'clap', 'hat', 'openhat', 'ride', 'crash', 'perc', 'tom']);
const LOW_ROLES = new Set(['bass', '808', 'sub']);
const CHORD_ROLES = new Set(['chord', 'stab']);
const CYMBAL_ROLES = new Set(['hat', 'openhat', 'ride', 'crash']);

/** A full drum kit on one channel (GM layout): not one sound. */
const isKit = (p) => p.role === 'kick' && ['snare', 'hat'].every((r) => (p.alsoRoles ?? []).includes(r));

/** Move `key` by octaves into the preset's range (closest octave; unchanged without a range or for drums). */
function intoRange(p, key, span = 0) {
  if (!p.range || DRUM_ROLES.has(p.role)) return key;
  const [lo, hi] = p.range;
  let best = key;
  let bestOut = Infinity;
  for (const shift of [0, 12, -12, 24, -24, 36, -36]) {
    const k = key + shift;
    const out = Math.max(0, lo - k) + Math.max(0, k + span - hi);
    if (out < bestOut) {
      best = k;
      bestOut = out;
    }
  }
  return best;
}

/** [tick, dur, key][] and the root note recorded in the index. */
function notesFor(p) {
  if (DRUM_ROLES.has(p.role)) return { root: 60, notes: [[0, HIT, 60]] };
  if (LOW_ROLES.has(p.role)) {
    const k = intoRange(p, 36);
    return { root: k, notes: [[0, HOLD, k]] };
  }
  if (CHORD_ROLES.has(p.role)) {
    const k = intoRange(p, 60, 7);
    return { root: k, notes: [0, 3, 7].map((i) => [0, HOLD, k + i]) };
  }
  const k = intoRange(p, 60);
  return { root: k, notes: [[0, HOLD, k]] };
}

const defaultMix = (type) => M.CATALOG.plugins.find((p) => p.id === type)?.defaultMix ?? 1;

function projectFor(preset, notes) {
  const proj = M.createDefaultProject(`Fingerprint ${preset.name}`);
  const master = proj.mixer.inserts[proj.mixer.masterId];
  master.slots = {};
  master.slotOrder = [];
  proj.mixer.inserts = { [master.id]: master };
  proj.mixer.insertOrder = [master.id];
  proj.channels = {};
  proj.channelOrder = [];
  proj.samples = {};
  const ins = M.makeInsert(preset.name, '#6366F1', master.id);
  for (const fx of preset.fx ?? []) {
    const slot = M.makeSlot(fx.type, fx.mix ?? defaultMix(fx.type), fx.params);
    slot.enabled = fx.enabled ?? true;
    ins.slots[slot.id] = slot;
    ins.slotOrder.push(slot.id);
  }
  proj.mixer.inserts[ins.id] = ins;
  proj.mixer.insertOrder.push(ins.id);
  let sampleId = null;
  if (preset.sample) {
    const s = M.makeSample(preset.sample);
    proj.samples[s.id] = s;
    sampleId = s.id;
  }
  const ch = M.makeChannel({ name: preset.name, type: preset.plugin, insertId: ins.id, color: '#6366F1', sampleId, params: preset.params });
  const c = preset.channel ?? {};
  if (c.volumeDb != null) ch.volume = 10 ** (c.volumeDb / 20);
  if (c.pan != null) ch.pan = c.pan;
  if (c.rootKey != null) ch.rootKey = c.rootKey;
  ch.poly = { mono: c.mono ?? false, glideMs: c.glideMs ?? 0, cutGroup: c.cutGroup ?? 0, cutBy: c.cutBy ?? 0 };
  proj.channels[ch.id] = ch;
  proj.channelOrder.push(ch.id);
  const pat = M.makePattern('Fingerprint', '#6366F1');
  pat.length = BAR;
  const map = {};
  notes.forEach(([tick, dur, key], i) => {
    const id = `n_${i}`;
    map[id] = M.defaultNote({ id, tick, dur, key: Math.max(0, Math.min(127, key)) });
  });
  pat.notes[ch.id] = map;
  proj.patterns = { [pat.id]: pat };
  proj.patternOrder = [pat.id];
  proj.transport.activePatternId = pat.id;
  proj.transport.bpm = BPM;
  proj.transport.mode = 'pattern';
  return proj;
}

function render(projectPath, wavPath) {
  return new Promise((resolve) => {
    const args = ['--render', projectPath, '--out', wavPath, '--scope', 'pattern', '--tail', '1.5', '--format', 'wav16', '--factory-dir', factoryDir];
    if (packsDir) args.push('--packs-dir', packsDir);
    const p = spawn(engineExe, args, { windowsHide: true });
    let err = '';
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ error: e.message }));
    p.on('close', (code) => resolve(code === 0 ? {} : { error: `engine exit ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}` }));
  });
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

// ── Analyzer (NDJSON over stdio) ──────────────────────────────────────

function startAnalyzer() {
  const p = spawn(analyzerExe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let seq = 0;
  let dead = null;
  let stderr = '';
  p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  readline.createInterface({ input: p.stdout }).on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof m?.id !== 'number' || m.event) return;
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    w(m);
  });
  const fail = (msg) => {
    dead = msg;
    for (const w of waiting.values()) w({ ok: false, message: msg });
    waiting.clear();
  };
  p.on('error', (e) => fail(`analyzer failed to start: ${e.message}`));
  p.on('exit', (code) => fail(`analyzer exited (${code}): ${stderr.trim().split('\n').slice(-2).join(' | ')}`));
  return {
    request(cmd, args) {
      if (dead) return Promise.resolve({ ok: false, message: dead });
      const id = ++seq;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        p.stdin.write(`${JSON.stringify(args === undefined ? { id, cmd } : { id, cmd, args })}\n`);
      });
    },
    stop() {
      try {
        p.stdin.write(`${JSON.stringify({ id: ++seq, cmd: 'shutdown' })}\n`);
        p.stdin.end();
      } catch {
        /* already gone */
      }
    },
  };
}

// ── Numbers: rounded so the file stays small and diffs stay readable ──

const sig = (x, d = 4) => (x === null || x === undefined ? x : Number.isFinite(x) ? Number(x.toPrecision(d)) : x);
function tidyFp(fp) {
  return {
    lengthSec: sig(fp.lengthSec),
    centroidHz: sig(fp.centroidHz),
    rolloffHz: sig(fp.rolloffHz),
    flatness: sig(fp.flatness, 3),
    harmonicity: sig(fp.harmonicity, 3),
    f0Hz: fp.f0Hz === null ? null : sig(fp.f0Hz),
    attackMs: sig(fp.attackMs, 3),
    decayMs: sig(fp.decayMs),
    sustain: sig(fp.sustain, 3),
    bands: Object.fromEntries(['sub', 'low', 'lowMid', 'mid', 'highMid', 'high'].map((k) => [k, sig(fp.bands?.[k], 3)])),
    crestDb: sig(fp.crestDb, 3),
    width: sig(fp.width, 3),
    peakDb: sig(fp.peakDb, 3),
    rmsDb: sig(fp.rmsDb, 3),
  };
}
const usable = (fp) =>
  fp && [fp.lengthSec, fp.centroidHz, fp.rolloffHz, fp.flatness, fp.harmonicity, fp.attackMs, fp.decayMs, fp.sustain, fp.crestDb, fp.width, fp.peakDb, fp.rmsDb].every(Number.isFinite) && fp.centroidHz > 0 && fp.rmsDb > -90 && fp.lengthSec > 0;

// ── Run ───────────────────────────────────────────────────────────────

const analyzer = startAnalyzer();
const hello = await analyzer.request('hello');
if (!hello.ok) die(`the analyzer didn't answer hello: ${hello.message}`);
const analyzerVersion = hello.data?.version ?? '?';
const engineVersion = spawnSync(engineExe, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() || 'krypt-studio-engine';

/** The whole file, or only `held` seconds from the start (a held note without its release tail). */
async function fingerprint(file, pitch, held) {
  const r = await analyzer.request('fingerprint', held ? { path: file, pitch, segments: [{ startSec: 0, endSec: held }] } : { path: file, pitch });
  if (!r.ok) return { error: r.message ?? 'fingerprint failed' };
  const fp = held ? r.data?.segments?.[0] : r.data?.whole;
  return usable(fp) ? { fp: tidyFp(fp) } : { error: 'silent or unmeasurable' };
}

// Probe: an analyzer without the cmd fails here with one clear line instead of 460 times.
const factoryIndex = JSON.parse(readFileSync(path.join(factoryDir, 'index.json'), 'utf8'));
const samples = (Array.isArray(factoryIndex.samples) ? factoryIndex.samples : []).filter((s) => typeof s?.path === 'string' && s.path.startsWith('factory:') && typeof s.kind === 'string');
const fileOf = (p) => path.join(factoryDir, ...p.replace(/^factory:/, '').split('/'));
if (samples.length) {
  const probe = await analyzer.request('fingerprint', { path: fileOf(samples[0].path), pitch: false });
  if (!probe.ok && /unknown|unsupported|not supported|invalid request|no such cmd/i.test(probe.message ?? '')) {
    analyzer.stop();
    die(`this analyzer (${analyzerVersion}, ${path.relative(root, analyzerExe)}) has no fingerprint cmd: ${probe.message}. Rebuild it (Wave 8a).`);
  }
}

const skipped = [];
const presets = M.INSTRUMENT_PRESETS.filter((p) => {
  if (isKit(p)) {
    skipped.push(`${p.id} (full kit)`);
    return false;
  }
  if (p.requires && !(packsDir && existsSync(path.join(packsDir, p.requires)))) {
    skipped.push(`${p.id} (needs the ${p.requires} pack)`);
    return false;
  }
  return true;
});
console.log(`Fingerprinting ${presets.length} preset(s) (${jobs} render jobs) and ${samples.length} factory sample(s) with ${path.relative(root, analyzerExe)} …`);

const failures = [];
const presetRows = await pool(presets, jobs, async (p) => {
  const slug = p.id.replace(/^factory:/, '').replace(/[^a-z0-9]+/gi, '_');
  const { root: note, notes } = notesFor(p);
  const projPath = path.join(workDir, `${slug}.json`);
  const wavPath = path.join(workDir, `${slug}.wav`);
  writeFileSync(projPath, JSON.stringify(projectFor(p, notes)));
  const r = await render(projPath, wavPath);
  rmSync(projPath, { force: true });
  if (r.error) {
    failures.push(`${p.id}: render failed (${r.error})`);
    return null;
  }
  // Tonal presets: the held note only (1.5 s, no release tail), the way match_sounds slices the reference's notes.
  const f = await fingerprint(wavPath, !CYMBAL_ROLES.has(p.role), DRUM_ROLES.has(p.role) ? undefined : HOLD / 1920);
  if (!keepWav) rmSync(wavPath, { force: true });
  if (f.error) {
    failures.push(`${p.id}: ${f.error}`);
    return null;
  }
  return { source: { kind: 'preset', id: p.id, role: p.role, note }, fp: f.fp };
});

const CYMBAL_KINDS = new Set(['hat', 'openhat', 'ride', 'crash', 'shaker', 'noise', 'riser', 'downlifter', 'sweep-up', 'sweep-down', 'reverse-cymbal', 'whoosh', 'texture', 'ambience']);
const sampleRows = await pool(samples, 2, async (s) => {
  const f = await fingerprint(fileOf(s.path), !CYMBAL_KINDS.has(s.kind));
  if (f.error) {
    failures.push(`${s.path}: ${f.error}`);
    return null;
  }
  return { source: { kind: 'sample', path: s.path, sampleKind: s.kind }, fp: f.fp };
});
analyzer.stop();

const entries = [
  ...presetRows.filter(Boolean).sort((a, b) => a.source.id.localeCompare(b.source.id)),
  ...sampleRows.filter(Boolean).sort((a, b) => a.source.path.localeCompare(b.source.path)),
];
if (!entries.length) die(`nothing could be measured.${failures.length ? ` First failure: ${failures[0]}` : ''}`);

const index = { version: 1, generator: `${analyzerVersion} / ${engineVersion} / ${presetRows.filter(Boolean).length} presets + ${sampleRows.filter(Boolean).length} samples`, entries };
const tmp = `${outFile}.tmp`;
writeFileSync(tmp, `${JSON.stringify(index, null, 0).replace(/\},\{"source"/g, '},\n{"source"')}\n`);
renameSync(tmp, outFile);
if (!keepWav) rmSync(workDir, { recursive: true, force: true });

const kb = (readFileSync(outFile).length / 1024).toFixed(0);
console.log(`✔ ${path.relative(root, outFile)}: ${entries.length} entries (${kb} KB) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (skipped.length) console.log(`  skipped ${skipped.length} preset(s): ${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? ' …' : ''}`);
for (const f of failures.slice(0, 20)) console.warn(`  ⚠ ${f}`);
if (failures.length > 20) console.warn(`  ⚠ … and ${failures.length - 20} more`);
process.exit(0);
