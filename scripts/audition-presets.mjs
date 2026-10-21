import { build } from 'esbuild';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'test', '.out');
const workDir = path.join(outDir, 'audition');
const exe = path.join(root, 'resources', 'bin', process.platform === 'win32' ? 'krypt-studio-engine.exe' : 'krypt-studio-engine');
const factoryDir = path.join(root, 'resources', 'factory');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const VALUE_OPTS = new Set(['--jobs', '--packs-dir']);
const filterText = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_OPTS.has(argv[i - 1])));
const jobs = Math.max(1, Number(opt('--jobs', String(Math.min(8, os.cpus().length)))) || 4);
const keepWav = flag('--keep-wav');
const packsDir = opt('--packs-dir', null);
if (packsDir && !existsSync(packsDir)) {
  console.error(`No packs folder at ${packsDir}.`);
  process.exit(2);
}

if (!existsSync(exe)) {
  console.error(`No engine at ${exe}. Build it first (npm run engine:build).`);
  process.exit(2);
}
mkdirSync(workDir, { recursive: true });

const bundle = path.join(outDir, 'audition-presets.bundle.mjs');
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

const Q = 960;
const E = 480;
const S = 240;
const BAR = 3840;
const chord = (tick, dur, keys) => keys.map((k) => [tick, dur, k]);
const AM7 = [57, 60, 64, 67];
const FMAJ7 = [53, 57, 60, 64];
const PH = {
  sustain: { bars: 4, notes: [...chord(0, 2 * BAR - 60, AM7), ...chord(2 * BAR, 2 * BAR - 60, FMAJ7)] },
  chords: {
    bars: 2,
    notes: [
      ...chord(0, 2 * Q - 60, [57, 60, 64, 69]),
      ...chord(2 * Q, 2 * Q - 60, [53, 57, 60, 65]),
      ...chord(BAR, 2 * Q - 60, [55, 60, 64, 67]),
      ...chord(BAR + 2 * Q, 2 * Q - 60, [55, 59, 62, 67]),
    ],
  },
  stabs: {
    bars: 2,
    notes: [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => chord(i * Q + E, S, i < 4 ? [57, 60, 64] : [53, 57, 60])),
  },
  melody: {
    bars: 2,
    notes: [
      [0, E, 76], [E, E, 74], [Q, Q, 72], [2 * Q, E, 69], [2 * Q + E, E, 72], [3 * Q, Q, 74],
      [BAR, E, 76], [BAR + E, E, 79], [BAR + Q, Q, 77], [BAR + 2 * Q, E, 76], [BAR + 2 * Q + E, E, 74], [BAR + 3 * Q, Q, 72],
    ].map(([t, d, k]) => [t, d - 30, k]),
  },
  pluck: {
    bars: 2,
    notes: [69, 72, 76, 72, 69, 72, 76, 79, 65, 69, 72, 69, 65, 69, 72, 76].map((k, i) => [i * E, 400, k]),
  },
  arp: {
    bars: 2,
    notes: [57, 60, 64, 69, 72, 69, 64, 60, 57, 60, 64, 69, 72, 69, 64, 60, 53, 57, 60, 65, 69, 65, 60, 57, 53, 57, 60, 65, 69, 65, 60, 57].map((k, i) => [i * S, 200, k]),
  },
  bass: {
    bars: 2,
    notes: [
      [0, E, 33], [E, S, 33], [Q, E, 45], [Q + E, E, 33], [2 * Q, E, 36], [2 * Q + E, E, 38], [3 * Q, Q, 40],
      [BAR, E, 29], [BAR + E, E, 29], [BAR + Q, E, 41], [BAR + Q + E, E, 29], [BAR + 2 * Q, E, 31], [BAR + 2 * Q + E, E, 31], [BAR + 3 * Q, Q, 28],
    ].map(([t, d, k]) => [t, d - 40, k]),
  },
  sub: { bars: 4, notes: [[0, 2 * Q - 40, 33], [2 * Q, 2 * Q - 40, 29], [BAR, 2 * Q - 40, 31], [BAR + 2 * Q, 2 * Q - 40, 28], [2 * BAR, BAR - 40, 33], [3 * BAR, BAR - 40, 28]] },
  808: { bars: 2, notes: [[0, Q + E, 33], [Q + E, E, 33], [2 * Q, 2 * Q, 36], [BAR, Q + E, 29], [BAR + Q + E, E, 31], [BAR + 2 * Q, 2 * Q, 28]] },
  kick: { bars: 2, notes: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i * Q, S, 60]) },
  backbeat: { bars: 2, notes: [1, 3, 5, 7].map((i) => [i * Q, S, 60]) },
  hat: { bars: 2, notes: Array.from({ length: 16 }, (_, i) => [i * E, S / 2, 60]) },
  openhat: { bars: 2, notes: Array.from({ length: 8 }, (_, i) => [i * Q + E, E, 60]) },
  ride: { bars: 2, notes: Array.from({ length: 8 }, (_, i) => [i * Q, S, 60]) },
  crash: { bars: 2, notes: [[0, S, 60]] },
  perc: { bars: 2, notes: [0, 3, 6, 10, 12, 16, 19, 22, 26, 28].map((s) => [s * S, S, 60]) },
  tom: { bars: 2, notes: [[0, S, 60], [3 * S, S, 60], [6 * S, S, 55], [Q * 2, S, 53], [BAR, S, 60], [BAR + 3 * S, S, 57], [BAR + 6 * S, S, 55], [BAR + 2 * Q, S, 52]] },
  kit: {
    bars: 2,
    notes: [
      ...[0, 2 * Q, BAR, BAR + 2 * Q + E].map((t) => [t, S, 36]),
      ...[Q, 3 * Q, BAR + Q, BAR + 3 * Q].map((t) => [t, S, 38]),
      ...Array.from({ length: 15 }, (_, i) => [i * E, S / 2, 42]),
      [15 * E, E, 46],
    ],
  },
  fx: { bars: 4, notes: [[0, 2 * BAR - 60, 60], [2 * BAR, Q, 72], [2 * BAR + 2 * Q, Q, 67], [3 * BAR, Q, 64]] },
  texture: { bars: 4, notes: [[0, 4 * BAR - 60, 45], [0, 4 * BAR - 60, 57]] },
};

const PHRASE_BY_ROLE = {
  lead: 'melody', pluck: 'pluck', pad: 'sustain', keys: 'chords', piano: 'chords', bell: 'melody', arp: 'arp', stab: 'stabs', chord: 'chords',
  strings: 'sustain', brass: 'chords', vox: 'melody', bass: 'bass', sub: 'sub', 808: '808',
  kick: 'kick', snare: 'backbeat', clap: 'backbeat', hat: 'hat', openhat: 'openhat', ride: 'ride', crash: 'crash', perc: 'perc', tom: 'tom',
  fx: 'fx', texture: 'texture',
};

const isKit = (p) => p.role === 'kick' && ['snare', 'hat'].every((r) => (p.alsoRoles ?? []).includes(r));

function phraseFor(p) {
  if (isKit(p)) return 'kit';
  if (p.role === 'brass' && p.tags.includes('short')) return 'stabs';
  if (p.role === 'vox' && p.alsoRoles?.includes('pad')) return 'sustain';
  if (p.role === 'strings' && p.alsoRoles?.includes('pluck')) return 'pluck';
  if (p.role === 'strings' && p.tags.includes('short')) return 'stabs';
  if (p.role === 'fx' && p.tags.includes('short')) return 'perc';
  return PHRASE_BY_ROLE[p.role] ?? 'melody';
}

const DRUM_ROLES = new Set(['kick', 'snare', 'clap', 'hat', 'openhat', 'ride', 'crash', 'perc', 'tom']);

function transposeFor(preset, notes) {
  if (!preset.range || DRUM_ROLES.has(preset.role)) return 0;
  const [lo, hi] = preset.range;
  let best = { shift: 0, out: Infinity };
  for (const shift of [0, 12, -12, 24, -24, 36, -36]) {
    const out = notes.filter(([, , k]) => k + shift < lo || k + shift > hi).length;
    if (out < best.out) best = { shift, out };
  }
  return best.shift;
}

const TARGET = {
  808: -14, bass: -17, sub: -14,
  kick: -16, snare: -19, clap: -19, hat: -26, openhat: -23, ride: -25, crash: -24, perc: -25, tom: -19,
  lead: -17, pluck: -24, arp: -27, bell: -21, keys: -22, piano: -22, chord: -20, stab: -28, strings: -23, brass: -19, vox: -20,
  pad: -23, fx: -20, texture: -28,
};
const TARGET_BY_PHRASE = { 'strings:stabs': -28, 'strings:pluck': -24, 'vox:sustain': -23, 'fx:perc': -22, 'brass:stabs': -28, 'kick:kit': -15 };
const targetFor = (role, phrase) => TARGET_BY_PHRASE[`${role}:${phrase}`] ?? TARGET[role];
const WINDOW = 2;

const MELODIC = new Set(['lead', 'pluck', 'pad', 'keys', 'piano', 'bell', 'arp', 'stab', 'chord', 'strings', 'brass', 'vox', 'texture']);
const NO_SUB = new Set([...MELODIC, 'snare', 'clap', 'hat', 'openhat', 'ride', 'crash', 'perc']);
const CYMBALS = new Set(['hat', 'openhat', 'ride', 'crash']);

const defaultMix = (type) => M.CATALOG.plugins.find((p) => p.id === type)?.defaultMix ?? 1;

function projectFor(preset) {
  const proj = M.createDefaultProject(`Audition ${preset.name}`);
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

  const phrase = PH[phraseFor(preset)];
  const tr = transposeFor(preset, phrase.notes);
  const pat = M.makePattern('Audition', '#6366F1');
  pat.length = phrase.bars * BAR;
  const notes = {};
  phrase.notes.forEach(([tick, dur, key], i) => {
    const id = `n_${i}`;
    notes[id] = M.defaultNote({ id, tick, dur, key: Math.min(127, key + tr) });
  });
  pat.notes[ch.id] = notes;
  proj.patterns = { [pat.id]: pat };
  proj.patternOrder = [pat.id];
  proj.transport.activePatternId = pat.id;
  proj.transport.bpm = 120;
  proj.transport.mode = 'pattern';
  return { proj, phrase: phraseFor(preset), transpose: tr };
}

function render(projectPath, wavPath) {
  return new Promise((resolve) => {
    const args = ['--render', projectPath, '--out', wavPath, '--scope', 'pattern', '--analyze', '--tail', '2', '--format', 'wav16', '--factory-dir', factoryDir];
    if (packsDir) args.push('--packs-dir', packsDir);
    const p = spawn(exe, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) return resolve({ error: `engine exit ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}` });
      try {
        const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
        const r = JSON.parse(line);
        const warn = err.split('\n').filter((l) => l.includes('[warn]')).map((l) => l.trim());
        resolve({ result: r, warn });
      } catch (e) {
        resolve({ error: `unreadable engine output: ${e.message}` });
      }
    });
  });
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

const r1 = (x) => Math.round(x * 10) / 10;

const CHORD_PHRASES = new Set(['sustain', 'chords', 'stabs', 'texture']);

function check(preset, a, phrase) {
  const flags = [];
  const notes = [];
  const role = preset.role;
  if (a.lufsIntegrated <= -60 || a.peakDb <= -60) flags.push('silent');
  const tpMax = preset.requires ? -1 : -0.5;
  if (a.truePeakDb > tpMax) flags.push(`true peak ${r1(a.truePeakDb)} dBTP > ${tpMax}`);
  const t = targetFor(role, phrase);
  if (t != null && Math.abs(a.lufsIntegrated - t) > WINDOW) flags.push(`loudness ${r1(a.lufsIntegrated)} LUFS outside ${t - WINDOW}..${t + WINDOW}`);
  const b = a.bands;
  const maxBand = Math.max(b.sub, b.low, b.lowMid, b.mid, b.highMid, b.high);
  if (NO_SUB.has(role) && b.sub > maxBand - 24) flags.push(`sub energy (sub ${r1(b.sub - maxBand)} dB vs loudest band)`);
  if (CYMBALS.has(role) && b.low > maxBand - 18) flags.push(`low energy in a cymbal (low ${r1(b.low - maxBand)} dB)`);
  const mud = CHORD_PHRASES.has(phrase) ? 12 : 6;
  if (MELODIC.has(role) && b.lowMid - b.mid > mud) flags.push(`muddy (lowMid ${r1(b.lowMid - b.mid)} dB over mid, limit ${mud})`);
  if (MELODIC.has(role) && role !== 'texture' && b.highMid - b.mid > 6) flags.push(`harsh (highMid ${r1(b.highMid - b.mid)} dB over mid)`);
  if (a.stereoCorrelation < 0) flags.push(`mono-incompatible (correlation ${a.stereoCorrelation.toFixed(2)})`);
  else if (a.stereoCorrelation < 0.2) notes.push(`very wide (correlation ${a.stereoCorrelation.toFixed(2)})`);
  if ((role === 'bass' || role === 'sub' || role === '808') && preset.channel?.mono && a.stereoCorrelation < 0.9) notes.push(`mono bass with correlation ${a.stereoCorrelation.toFixed(2)}`);
  if (a.clipping) flags.push('clipping');
  return { flags, notes };
}

const ref = (role, file, extra = {}) => ({
  id: `ref:${role}`, name: `Factory ${file}`, role, plugin: 'krypt.sampler', params: {}, sample: `factory:drums/${file}`, tags: [], genres: [], description: '', ...extra,
});
const REFS = [
  ref('kick', 'kick.wav'),
  ref('snare', 'snare.wav'),
  ref('clap', 'clap.wav'),
  ref('hat', 'hat-closed.wav'),
  ref('openhat', 'hat-open.wav'),
  ref('perc', 'perc.wav'),
  ref('crash', 'crash.wav'),
];

const skipped = [];
const all = M.INSTRUMENT_PRESETS.filter((p) => {
  if (!p.requires) return true;
  const ok = !!packsDir && existsSync(path.join(packsDir, p.requires));
  if (!ok) skipped.push(p);
  return ok;
});
const packsOnly = flag('--packs-only');
const presets = all.filter((p) => (!filterText || p.id.includes(filterText)) && (!packsOnly || p.requires));
if (skipped.length) console.log(`Skipping ${skipped.length} pack preset(s): ${packsDir ? `packs not installed in ${packsDir}` : 'pass --packs-dir <dir> to render them'} (${[...new Set(skipped.map((p) => p.requires))].join(', ')}).`);
const partial = !!filterText || packsOnly;
const withRefs = flag('--refs') || !partial;
if (!presets.length) {
  console.error(`No preset id contains "${filterText}".`);
  process.exit(2);
}
console.log(`Auditioning ${presets.length} preset(s) with ${jobs} job(s) …`);
const t0 = Date.now();

const rows = await pool(withRefs ? [...presets, ...REFS] : presets, jobs, async (p) => {
  const slug = p.id.replace(/^factory:/, '').replace(/[^a-z0-9]+/gi, '_');
  const { proj, phrase, transpose } = projectFor(p);
  const projPath = path.join(workDir, `${slug}.json`);
  const wavPath = path.join(workDir, `${slug}.wav`);
  writeFileSync(projPath, JSON.stringify(proj));
  const r = await render(projPath, wavPath);
  if (!keepWav) rmSync(wavPath, { force: true });
  rmSync(projPath, { force: true });
  if (r.error) return { id: p.id, name: p.name, role: p.role, plugin: p.plugin, phrase, error: r.error, flags: [`render failed: ${r.error}`], notes: [] };
  const a = r.result.analysis;
  const { flags, notes } = p.id.startsWith('ref:') ? { flags: [], notes: [] } : check(p, a, phrase);
  if (r.warn.length) notes.push(...r.warn);
  const gain = p.params.gain;
  const target = targetFor(p.role, phrase);
  const suggestedGainDb = target != null && typeof gain === 'number' ? Math.round((gain + (target - a.lufsIntegrated)) * 2) / 2 : null;
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    plugin: p.plugin,
    phrase,
    transpose,
    lufs: r1(a.lufsIntegrated),
    lufsShortMax: r1(a.lufsShortTermMax),
    truePeak: r1(a.truePeakDb),
    peak: r1(a.peakDb),
    crest: r1(a.crestDb),
    correlation: Math.round(a.stereoCorrelation * 100) / 100,
    width: Math.round(a.stereoWidth * 100) / 100,
    centroidHz: Math.round(a.spectralCentroidHz),
    bands: Object.fromEntries(Object.entries(a.bands).map(([k, v]) => [k, r1(v)])),
    energy: (a.energyCurve ?? []).map(r1),
    target,
    gain,
    suggestedGainDb,
    flags,
    notes,
  };
});

const refRows = rows.filter((r) => r.id.startsWith('ref:'));
rows.splice(0, rows.length, ...rows.filter((r) => !r.id.startsWith('ref:')));
const byRole = new Map();
for (const r of rows) {
  if (!byRole.has(r.role)) byRole.set(r.role, []);
  byRole.get(r.role).push(r);
}
const flagged = rows.filter((r) => r.flags.length);
const roleSummary = [...byRole.entries()].map(([role, rs]) => {
  const ok = rs.filter((r) => r.lufs != null);
  const l = ok.map((r) => r.lufs).sort((a, b) => a - b);
  const d = ok.map((r) => r.lufs - r.target).sort((a, b) => a - b);
  return {
    role,
    count: rs.length,
    target: TARGET[role],
    min: l[0],
    median: l[Math.floor(l.length / 2)],
    max: l[l.length - 1],
    offsetMin: r1(d[0]),
    offsetMax: r1(d[d.length - 1]),
    spread: r1(d[d.length - 1] - d[0]),
    maxTruePeak: Math.max(...ok.map((r) => r.truePeak)),
    flagged: rs.filter((r) => r.flags.length).length,
  };
});

const md = [];
md.push('# Factory preset audition');
md.push('');
md.push(`Rendered ${rows.length} preset(s) with \`${path.relative(root, exe)}\` on ${new Date().toISOString()} (120 BPM, velocity 0.78, default channel volume, no master limiter, 2 s tail).`);
if (skipped.length) md.push('', `Not rendered: ${skipped.length} pack preset(s) whose pack was not in --packs-dir (${[...new Set(skipped.map((p) => p.requires))].join(', ')}).`);
md.push('');
md.push(`**${flagged.length ? `${flagged.length} flagged` : 'Clean: nothing flagged'}.** Loudness window: role target ± ${WINDOW} LU.`);
md.push('');
md.push('| Role | Presets | Target LUFS | Min | Median | Max | Offset from target (LU) | Spread (LU) | Max true peak | Flagged |');
md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const s of roleSummary)
  md.push(`| ${s.role} | ${s.count} | ${s.target ?? '–'} | ${s.min} | ${s.median} | ${s.max} | ${s.offsetMin}..${s.offsetMax} | ${s.spread} | ${s.maxTruePeak} | ${s.flagged} |`);
md.push('');
if (refRows.length) {
  md.push('Reference: the legacy factory kit samples at default sampler settings, same phrases.');
  md.push('');
  md.push('| Sample | Role | LUFS | True peak |');
  md.push('|---|---|---:|---:|');
  for (const r of refRows) md.push(`| ${r.name.replace('Factory ', '')} | ${r.role} | ${r.lufs ?? r.error} | ${r.truePeak ?? '–'} |`);
  md.push('');
}
if (flagged.length) {
  md.push('## Flagged');
  md.push('');
  for (const r of flagged) md.push(`- \`${r.id}\` (${r.name}): ${r.flags.join('; ')}`);
  md.push('');
}
md.push('## All presets');
for (const [role, rs] of byRole) {
  md.push('');
  md.push(`### ${role}`);
  md.push('');
  md.push('| Preset | Plugin | LUFS | TP | Corr | Width | Sub | Low | LoMid | Mid | HiMid | High | Centroid | Notes |');
  md.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const r of rs) {
    if (r.error) {
      md.push(`| ${r.name} | ${r.plugin} | – | – | – | – | – | – | – | – | – | – | – | ${r.error} |`);
      continue;
    }
    const b = r.bands;
    const n = [...r.flags.map((f) => `**${f}**`), ...r.notes].join('; ');
    md.push(`| ${r.name} | ${r.plugin.replace('krypt.', '')} | ${r.lufs} | ${r.truePeak} | ${r.correlation} | ${r.width} | ${b.sub} | ${b.low} | ${b.lowMid} | ${b.mid} | ${b.highMid} | ${b.high} | ${r.centroidHz} | ${n} |`);
  }
}
md.push('');

const base = partial ? 'presets-audition.partial' : 'presets-audition';
writeFileSync(path.join(outDir, `${base}.md`), md.join('\n'));
writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), targets: TARGET, window: WINDOW, roles: roleSummary, references: refRows, presets: rows }, null, 2));

for (const r of refRows) console.log(`  ref ${r.role.padEnd(8)} ${r.name.padEnd(24)} LUFS ${r.lufs}  TP ${r.truePeak}`);
for (const s of roleSummary)
  console.log(`  ${s.role.padEnd(8)} ${String(s.count).padStart(3)}  target ${String(s.target).padStart(4)}  LUFS ${s.min}..${s.max}  offset ${s.offsetMin}..${s.offsetMax} (spread ${s.spread})  TP max ${s.maxTruePeak}${s.flagged ? `  ${s.flagged} flagged` : ''}`);
for (const r of flagged) console.log(`  FLAG ${r.id}: ${r.flags.join('; ')}`);
console.log(`${flagged.length ? `${flagged.length} flagged` : 'clean'} · ${rows.length} rendered in ${((Date.now() - t0) / 1000).toFixed(1)} s · report: ${path.relative(root, path.join(outDir, `${base}.md`))}`);
process.exit(flagged.length ? 1 : 0);
