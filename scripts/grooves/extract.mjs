// Groove template extractor: Groove MIDI Dataset (GMD) → shared/grooves/templates.gen.ts
//
//   node scripts/grooves/extract.mjs <path-to-unzipped-groove-dir> [--out <file>] [--check]
//
// The GMD is by Google LLC (Magenta), CC BY 4.0: https://magenta.tensorflow.org/datasets/groove
// Download groove-v1.0.0-midionly.zip from that page and unzip it anywhere; pass the folder that
// holds info.csv. The dataset is read as untrusted data (paths are confined to that folder, only
// .mid files are opened, nothing from it is executed) and is never copied into the repo: only the
// aggregated per-style statistics below are written.
//
// Method (research/11-sound-sources.md §5 has the reasoning):
//  1. Use 4/4 BEAT performances only (no fills), mapped to 11 style templates (thin styles merged).
//  2. Instrument classes from the GM drum map GMD uses: kick, snare (incl. rim + cross-stick),
//     hihat (closed/open/pedal + ride), other (toms, crashes, anything else).
//  3. Per performance, remove its global offset: the median deviation of every hit that sits
//     on a quarter-note line (swing-independent), so a drummer who rides ahead of the click as a
//     whole doesn't skew the template.
//  4. Per template, estimate 8th and 16th swing (median beat phase of off-beat hits), build a
//     swung 16th grid from it and assign each hit to its nearest swung line. So a swung jazz "and"
//     counts as step 3 of the beat (+0.56 of a 16th), not as a late step 4.
//  5. Per (performance, bar, class, step) keep the hit closest to its line (flams / rolls don't
//     double count). Offsets are relative to the STRAIGHT grid in fractions of a 16th.
//  6. Per (template, class, step): trimmed mean (10 %) and robust spread (1.4826 × MAD) of the
//     offsets, trimmed-mean velocity relative to that performance's class median, and hit
//     probability = the mean over performances of (bars with a hit / bars). Each performance
//     contributes at most CAP hits per cell. Cells with fewer than MIN_HITS hits or fewer than
//     MIN_PERFS performances fall back: all classes at that step → the class at that beat
//     position → all classes at that beat position → neutral (0 offset, velocity 1).
//  7. Velocities are scaled per class so their hit-probability-weighted mean is 1 (they are
//     accents, not levels).
//
// Output is deterministic (sorted, rounded, no timestamps). --check exits 1 when the file on
// disk differs from what this run would write.

import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { readMidi } from './smf.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (!positional[0]) {
  console.error('usage: node scripts/grooves/extract.mjs <groove-dir-with-info.csv> [--out file] [--check]');
  process.exit(2);
}
const ROOT = realpathSync(path.resolve(positional[0]));
const OUT = path.resolve(opt('--out') ?? path.join(REPO, 'shared', 'grooves', 'templates.gen.ts'));

// ── Parameters ─────────────────────────────────────────────────────────
const MIN_HITS = 30; // hits per cell (after the per-performance cap)
const MIN_PERFS = 3; // performances per cell
const CAP = 64; // max hits one performance contributes to one cell
const MIN_TEMPLATE_PERFS = 4;
const MIN_PERF_HITS = 16;
const MIN_PERF_BARS = 2;

/** GM drum map as used by GMD (Roland TD-11 pitches, incl. the edge/rim extras 22 and 26). */
function classOf(key) {
  if (key === 35 || key === 36) return 'kick';
  if (key === 37 || key === 38 || key === 39 || key === 40) return 'snare';
  if ([22, 26, 42, 44, 46, 51, 53, 59].includes(key)) return 'hihat';
  return 'other';
}
const CLASSES = ['kick', 'snare', 'hihat', 'other'];

/** info.csv style (digits stripped, e.g. "funk/groove") → template id; first match wins. */
const STYLE_RULES = [
  [/^(blues|rock|neworleans)\/shuffle$|^funk\/purdieshuffle$/, 'shuffle'],
  [/^jazz\/(funk|fusion|linear)$|^neworleans\/(funk|secondline)$/, 'funk'],
  [/^neworleans\/chacha$|^afrocuban/, 'latin'],
  [/^gospel$/, 'soul'],
  [/^highlife$/, 'afrobeat'],
  [/^(punk|country)$/, 'rock'],
  [/^(hiphop|funk|soul|jazz|latin|reggae|afrobeat|rock|pop|dance)(\/|$)/, null], // own family
];
const TEMPLATE_INFO = {
  hiphop: { label: 'Hip hop', order: 0 },
  funk: { label: 'Funk', order: 1 },
  soul: { label: 'Soul', order: 2 },
  jazz: { label: 'Jazz', order: 3 },
  shuffle: { label: 'Shuffle', order: 4 },
  latin: { label: 'Latin', order: 5 },
  reggae: { label: 'Reggae', order: 6 },
  afrobeat: { label: 'Afrobeat', order: 7 },
  rock: { label: 'Rock', order: 8 },
  pop: { label: 'Pop', order: 9 },
  dance: { label: 'Dance', order: 10 },
};
function templateFor(style) {
  for (const [re, id] of STYLE_RULES) {
    const m = re.exec(style);
    if (m) return id ?? style.split('/')[0];
  }
  return null; // e.g. middleeastern (1 performance): no fitting family
}

// ── Small robust-stats helpers ─────────────────────────────────────────
const sorted = (xs) => [...xs].sort((a, b) => a - b);
function median(xs) {
  if (!xs.length) return NaN;
  const s = sorted(xs);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function trimmedMean(xs, trim = 0.1) {
  const s = sorted(xs);
  const k = Math.floor(s.length * trim);
  const core = s.slice(k, s.length - k);
  return core.reduce((a, b) => a + b, 0) / core.length;
}
const robustSd = (xs) => {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
};
/** Evenly spaced subsample of at most n items (deterministic). */
function cap(xs, n) {
  if (xs.length <= n) return xs;
  const out = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor((i * xs.length) / n)]);
  return out;
}
const num = (x, d) => {
  const v = Number(x.toFixed(d));
  return Object.is(v, -0) ? '0' : String(v);
};

// ── Read info.csv ──────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') cells.push(cur), (cur = '');
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const csvPath = path.join(ROOT, 'info.csv');
if (!existsSync(csvPath)) {
  console.error(`✖ no info.csv in ${ROOT} — pass the unzipped "groove" folder`);
  process.exit(1);
}
const rows = parseCsv(readFileSync(csvPath, 'utf8'));

/** Resolve a dataset-relative path, refusing anything that escapes ROOT or isn't a .mid. */
function datasetFile(rel) {
  const p = path.resolve(ROOT, rel);
  if (!p.startsWith(ROOT + path.sep) || !/\.midi?$/i.test(p)) throw new Error(`refusing path ${JSON.stringify(rel)}`);
  return p;
}

// ── Pass 1: performances → offset-corrected hits ───────────────────────
const perfs = []; // { id, template, drummer, bpm, hits: [{cls, q, vel}] }
const skipped = { notBeat44: 0, unmapped: 0, tiny: 0, unreadable: 0 };
for (const r of rows) {
  if (r.beat_type !== 'beat' || r.time_signature !== '4-4') {
    skipped.notBeat44++;
    continue;
  }
  const style = r.style.replace(/\d+$/, '');
  const template = templateFor(style);
  if (!template || !TEMPLATE_INFO[template]) {
    skipped.unmapped++;
    continue;
  }
  let midi;
  try {
    midi = readMidi(readFileSync(datasetFile(r.midi_filename)));
  } catch (e) {
    console.warn(`  skip ${r.midi_filename}: ${e.message}`);
    skipped.unreadable++;
    continue;
  }
  const q16 = midi.ppq / 4;
  const raw = midi.hits.map((h) => ({ cls: classOf(h.key), q: h.tick / q16, vel: h.vel }));
  if (raw.length < MIN_PERF_HITS || raw[raw.length - 1].q - raw[0].q < MIN_PERF_BARS * 16) {
    skipped.tiny++;
    continue;
  }
  const onQuarters = raw.filter((h) => Math.round(h.q) % 4 === 0).map((h) => h.q - Math.round(h.q));
  const globalOffset = onQuarters.length ? median(onQuarters) : 0;
  perfs.push({
    id: r.id,
    template,
    drummer: r.drummer,
    bpm: Number(r.bpm),
    globalOffset,
    hits: raw.map((h) => ({ ...h, q: h.q - globalOffset })),
  });
}

// ── Pass 2: per template ───────────────────────────────────────────────
const byTemplate = new Map();
for (const p of perfs) (byTemplate.get(p.template) ?? byTemplate.set(p.template, []).get(p.template)).push(p);

function estimateSwing(list) {
  const phases = [];
  for (const p of list) for (const h of p.hits) phases.push((((h.q / 4) % 1) + 1) % 1);
  const off8 = phases.filter((f) => f >= 0.4 && f <= 0.72);
  const r8 = off8.length >= 50 ? median(off8) : 0.5;
  const lo = phases.filter((f) => f >= 0.12 && f <= r8 - 0.1).map((f) => f / r8);
  const hi = phases.filter((f) => f >= r8 + 0.1 && f <= 0.88).map((f) => (f - r8) / (1 - r8));
  const both = [...lo, ...hi];
  const r16 = both.length >= 50 ? median(both) : 0.5;
  return { r8, r16 };
}

const templates = [];
for (const [id, list] of [...byTemplate].sort((a, b) => TEMPLATE_INFO[a[0]].order - TEMPLATE_INFO[b[0]].order)) {
  if (list.length < MIN_TEMPLATE_PERFS) throw new Error(`template ${id} has only ${list.length} performances; merge it into another style`);
  const { r8, r16 } = estimateSwing(list);
  // Swung 16th lines within one beat, in 16ths.
  const lines = [0, 4 * r8 * r16, 4 * r8, 4 * (r8 + (1 - r8) * r16)];

  // cell[cls][step] → { off: [[perf hits]], vel: [[...]], perfs: Set }
  const cells = Object.fromEntries([...CLASSES, 'all'].map((c) => [c, Array.from({ length: 16 }, () => ({ off: [], vel: [], perfs: new Set(), n: 0 }))]));
  const probSum = Object.fromEntries(CLASSES.map((c) => [c, new Array(16).fill(0)]));
  let bars = 0;
  let hitCount = 0;
  for (const p of list) {
    // Velocity reference: the class median in this performance (overall median if the class is rare).
    const all = p.hits.map((h) => h.vel);
    const allMed = median(all);
    const ref = Object.fromEntries(
      CLASSES.map((c) => {
        const v = p.hits.filter((h) => h.cls === c).map((h) => h.vel);
        return [c, v.length >= 8 ? median(v) : allMed];
      }),
    );
    // Assign hits to swung lines; keep the closest hit per (bar, step, class).
    const best = new Map(); // `${cls}|${k}` → { dist, off, vel }
    for (const h of p.hits) {
      const b0 = Math.floor(h.q / 4);
      let bestLine = null;
      for (const [beat, li] of [[b0, 0], [b0, 1], [b0, 2], [b0, 3], [b0 + 1, 0]]) {
        const pos = beat * 4 + lines[li];
        const d = Math.abs(h.q - pos);
        if (!bestLine || d < bestLine.d) bestLine = { d, k: beat * 4 + li };
      }
      if (bestLine.k < 0) continue;
      const key = `${h.cls}|${bestLine.k}`;
      const prev = best.get(key);
      if (!prev || bestLine.d < prev.dist) best.set(key, { dist: bestLine.d, cls: h.cls, k: bestLine.k, off: h.q - bestLine.k, vel: h.vel / ref[h.cls] });
    }
    const ks = [...best.values()].map((x) => x.k);
    const firstBar = Math.floor(Math.min(...ks) / 16);
    const lastBar = Math.floor(Math.max(...ks) / 16);
    const nBars = lastBar - firstBar + 1;
    bars += nBars;
    hitCount += p.hits.length;
    const per = Object.fromEntries([...CLASSES, 'all'].map((c) => [c, Array.from({ length: 16 }, () => ({ off: [], vel: [] }))]));
    const barsHit = Object.fromEntries(CLASSES.map((c) => [c, Array.from({ length: 16 }, () => new Set())]));
    for (const x of [...best.values()].sort((a, b) => a.k - b.k || a.cls.localeCompare(b.cls))) {
      const s = ((x.k % 16) + 16) % 16;
      for (const c of [x.cls, 'all']) {
        per[c][s].off.push(x.off);
        per[c][s].vel.push(x.vel);
      }
      barsHit[x.cls][s].add(Math.floor(x.k / 16));
    }
    for (const c of [...CLASSES, 'all']) {
      for (let s = 0; s < 16; s++) {
        const src = per[c][s];
        if (!src.off.length) continue;
        const cell = cells[c][s];
        cell.n += src.off.length;
        cell.perfs.add(p.id);
        cell.off.push(...cap(src.off, CAP));
        cell.vel.push(...cap(src.vel, CAP));
      }
    }
    for (const c of CLASSES) for (let s = 0; s < 16; s++) probSum[c][s] += barsHit[c][s].size / nBars;
  }

  // Pooled per beat position (s % 4) for the fallback chain.
  const pooled = (c, pos) => {
    const off = [];
    const vel = [];
    const ps = new Set();
    for (let s = pos; s < 16; s += 4) {
      off.push(...cells[c][s].off);
      vel.push(...cells[c][s].vel);
      for (const x of cells[c][s].perfs) ps.add(x);
    }
    return { off, vel, perfs: ps };
  };
  const enough = (cell) => cell.off.length >= MIN_HITS && cell.perfs.size >= MIN_PERFS;
  let fallbacks = 0;
  const classes = {};
  for (const c of CLASSES) {
    const out = { offset: [], spread: [], vel: [], prob: [], n: [] };
    for (let s = 0; s < 16; s++) {
      const chain = [cells[c][s], cells.all[s], pooled(c, s % 4), pooled('all', s % 4)];
      const src = chain.find(enough);
      if (src !== chain[0]) fallbacks++;
      out.offset.push(src ? trimmedMean(src.off) : 0);
      out.spread.push(src ? robustSd(src.off) : 0);
      out.vel.push(src ? trimmedMean(src.vel) : 1);
      out.prob.push(probSum[c][s] / list.length);
      out.n.push(cells[c][s].n);
    }
    const wsum = out.prob.reduce((a, b) => a + b, 0);
    const mean = wsum > 0 ? out.vel.reduce((a, v, s) => a + v * out.prob[s], 0) / wsum : 1;
    out.vel = out.vel.map((v) => v / mean);
    classes[c] = out;
  }
  const bpms = list.map((p) => p.bpm);
  const styles = [...new Set(rows.filter((r) => list.some((p) => p.id === r.id)).map((r) => r.style.replace(/\d+$/, '')))].sort();
  templates.push({
    id,
    label: TEMPLATE_INFO[id].label,
    styles,
    performances: list.length,
    drummers: new Set(list.map((p) => p.drummer)).size,
    bars,
    hits: hitCount,
    bpm: [Math.min(...bpms), Math.round(median(bpms)), Math.max(...bpms)],
    swing8: r8,
    swing16: r16,
    fallbacks,
    classes,
  });
}

// ── Emit ───────────────────────────────────────────────────────────────
const arr = (xs, d) => `[${xs.map((x) => num(x, d)).join(', ')}]`;
const lines = [];
lines.push('// GENERATED by scripts/grooves/extract.mjs from the Groove MIDI Dataset. Do not edit by hand:');
lines.push('// re-run `node scripts/grooves/extract.mjs <unzipped groove dir>` instead.');
lines.push('//');
lines.push('// Derived from the Groove MIDI Dataset by Google LLC (Magenta), CC BY 4.0');
lines.push('// https://magenta.tensorflow.org/datasets/groove · https://creativecommons.org/licenses/by/4.0/');
lines.push('// Gillick, Roberts, Engel, Eck, Bamman: "Learning to Groove with Inverse Sequence Transformations", ICML 2019.');
lines.push('// Changes: only aggregated per-style statistics are kept (mean / spread of timing per 16th step,');
lines.push('// relative velocity, hit probability, swing); no performance or MIDI file is reproduced.');
lines.push('//');
lines.push('// Template        performances  drummers  bars   swing 8th/16th');
for (const t of templates) lines.push(`//   ${t.id.padEnd(14)}${String(t.performances).padStart(6)}${String(t.drummers).padStart(12)}${String(t.bars).padStart(8)}   ${num(t.swing8, 3)} / ${num(t.swing16, 3)}`);
lines.push(`//   total         ${String(templates.reduce((a, t) => a + t.performances, 0)).padStart(6)} of ${rows.length} rows (4/4 beats only; fills, other metres and tiny takes skipped)`);
lines.push('');
lines.push("import type { GrooveTemplate } from './types';");
lines.push('');
lines.push("export const GROOVE_ATTRIBUTION = 'Derived from the Groove MIDI Dataset by Google LLC (Magenta), CC BY 4.0';");
lines.push('');
lines.push('export const GROOVE_TEMPLATES: readonly GrooveTemplate[] = [');
for (const t of templates) {
  lines.push('  {');
  lines.push(`    id: '${t.id}',`);
  lines.push(`    label: '${t.label}',`);
  lines.push(`    styles: [${t.styles.map((s) => `'${s}'`).join(', ')}],`);
  lines.push(`    performances: ${t.performances},`);
  lines.push(`    drummers: ${t.drummers},`);
  lines.push(`    bars: ${t.bars},`);
  lines.push(`    bpm: [${t.bpm.join(', ')}],`);
  lines.push(`    swing8: ${num(t.swing8, 3)},`);
  lines.push(`    swing16: ${num(t.swing16, 3)},`);
  lines.push('    classes: {');
  for (const c of CLASSES) {
    const k = t.classes[c];
    lines.push(`      ${c}: {`);
    lines.push(`        offset: ${arr(k.offset, 3)},`);
    lines.push(`        spread: ${arr(k.spread, 3)},`);
    lines.push(`        vel: ${arr(k.vel, 2)},`);
    lines.push(`        prob: ${arr(k.prob, 2)},`);
    lines.push(`        n: ${arr(k.n, 0)},`);
    lines.push('      },');
  }
  lines.push('    },');
  lines.push('  },');
}
lines.push('];');
lines.push('');
const text = lines.join('\n');

console.log(`GMD: ${rows.length} rows · ${perfs.length} performances used · skipped ${JSON.stringify(skipped)}`);
for (const t of templates) {
  console.log(
    `  ${t.id.padEnd(9)} ${String(t.performances).padStart(4)} perf ${String(t.drummers).padStart(2)} drummers ${String(t.bars).padStart(5)} bars  bpm ${t.bpm.join('/')}  swing8 ${num(t.swing8, 3)} swing16 ${num(t.swing16, 3)}  fallback cells ${t.fallbacks}/64  [${t.styles.join(' ')}]`,
  );
}

if (flag('--check')) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (cur !== text) {
    console.error(`✖ ${path.relative(REPO, OUT)} is out of date — re-run without --check`);
    process.exit(1);
  }
  console.log(`✔ ${path.relative(REPO, OUT)} is up to date`);
} else {
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, OUT);
  console.log(`✔ wrote ${path.relative(REPO, OUT)} (${(text.length / 1024).toFixed(1)} KB)`);
}
