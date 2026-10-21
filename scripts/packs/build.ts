import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analyzeWav, probeAudio } from './audio.mjs';
import { assertSafePath, isSamplePack, ramMb, renderSfz, samplesOf, urlFor, type AudioFacts, type PackSpec } from './lib';
import { buildSamples, checkSamples, renderSamples, summarize } from './samples';
import { SPECS } from './specs';

const root = path.resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const which = args[0];
const cacheRoot = opt('--cache');
const check = flag('--check');
const checkMirrors = flag('--mirrors');

function fail(msg: string): never {
  console.error(`✖ packs: ${msg}`);
  process.exit(1);
}

if (!which || !cacheRoot) fail('usage: build.ts <packId|all> --cache <scratch dir> [--check [--mirrors]]');
const cacheAbs = path.resolve(cacheRoot);
if (cacheAbs.startsWith(root + path.sep)) fail('--cache must be outside the repository (downloads are never committed)');
const specs = which === 'all' ? SPECS : SPECS.filter((s) => s.id === which);
if (!specs.length) fail(`unknown pack "${which}" (have: ${SPECS.map((s) => s.id).join(', ')})`);

async function fetchBytes(url: string, tries = 6): Promise<Uint8Array> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((res) => setTimeout(res, 2000 * 2 ** i));
    }
  }
  throw new Error(`${url}: ${(last as Error)?.message ?? last}`);
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
        if (++done % 25 === 0 || done === items.length) process.stdout.write(`  ${done}/${items.length}\r`);
      }
    }),
  );
  process.stdout.write('\n');
  return out;
}

interface Measured {
  path: string;
  src: string;
  sha256: string;
  bytes: number;
  facts: AudioFacts;
}

async function measure(spec: PackSpec, s: { src: string; path: string }): Promise<Measured> {
  const file = path.join(cacheAbs, spec.id, ...s.path.split('/'));
  let bytes: Uint8Array;
  if (existsSync(file)) bytes = new Uint8Array(readFileSync(file));
  else {
    bytes = await fetchBytes(urlFor(spec.base, s.src));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.part`, bytes);
    renameSync(`${file}.part`, file);
  }
  const head = probeAudio(bytes.subarray(0, 65536), bytes.length) as AudioFacts;
  const facts: AudioFacts = { ...head };
  if (head.format === 'wav') {
    const a = analyzeWav(bytes);
    if (a) {
      facts.peakDb = Math.round(a.peakDb * 100) / 100;
      facts.midi = a.midi === null ? null : Math.round(a.midi * 100) / 100;
      facts.onset = a.onset;
    }
  }
  return { path: s.path, src: s.src, sha256: sha256(bytes), bytes: bytes.length, facts };
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function render(spec: PackSpec) {
  return async (): Promise<{ text: string; files: Measured[]; ram: Record<string, number>; sfz: { path: string; text: string }[] }> => {
    for (const s of spec.samples) assertSafePath(s.path);
    const dupe = spec.samples.find((s, i) => spec.samples.findIndex((t) => t.path === s.path) !== i);
    if (dupe) throw new Error(`${spec.id}: duplicate pack path ${dupe.path}`);
    console.log(`${spec.id}: ${spec.samples.length} files`);
    const files = await pool(spec.samples, 8, (s) => measure(spec, s));
    writeFileSync(path.join(cacheAbs, `${spec.id}.facts.json`), JSON.stringify(Object.fromEntries(files.map((f) => [f.path, f.facts])), null, 1));
    const byPath = new Map(files.map((f) => [f.path, f]));
    const facts = (p: string) => {
      const f = byPath.get(p);
      if (!f) throw new Error(`${spec.id}: a mapping uses "${p}", which is not in the spec's samples`);
      return f.facts;
    };
    const ctx = {
      facts,
      endFor: (p: string, seconds: number) => {
        const f = facts(p);
        return Math.min(f.frames - 1, Math.round(seconds * f.rate));
      },
    };
    const used = new Set<string>();
    const sfz: { path: string; text: string }[] = [];
    const ram: Record<string, number> = {};
    for (const inst of spec.instruments) {
      assertSafePath(inst.path);
      const doc = inst.build(ctx);
      const dir = path.posix.dirname(inst.path);
      for (const s of samplesOf(doc)) {
        const p = dir === '.' ? s : path.posix.join(dir, s);
        facts(p);
        used.add(p);
      }
      ram[inst.path] = Math.round(ramMb(doc, (s) => facts(dir === '.' ? s : path.posix.join(dir, s))) * 10) / 10;
      sfz.push({ path: inst.path, text: renderSfz(doc) });
    }
    const unused = spec.samples.filter((s) => !used.has(s.path));
    if (unused.length) throw new Error(`${spec.id}: ${unused.length} downloaded file(s) no mapping uses, e.g. ${unused[0].path}`);
    const coverage = Object.fromEntries(spec.instruments.map((i) => [i.path, i.keys]));
    const total = files.reduce((a, f) => a + f.bytes, 0);
    const L: string[] = [];
    L.push(
      `// GENERATED by scripts/packs/build.ts from scripts/packs/specs/${spec.id}.ts — do not edit by hand.`,
      `// Regenerate: node scripts/run-script.mjs scripts/packs/build.ts ${spec.id} --cache <scratch dir>`,
      `// Verify:     node scripts/run-script.mjs scripts/packs/build.ts ${spec.id} --cache <scratch dir> --check`,
      '',
      "import type { PackFile, PackSfz } from '../types';",
      '',
      `const RAW = ${q(spec.base)};`,
      ...spec.mirrors.map((m, i) => `const MIRROR${i + 1} = ${q(m)};`),
      `const f = (path: string, src: string, sha256: string, bytes: number): PackFile => ({ path, url: RAW + src, mirrors: [${spec.mirrors.map((_, i) => `MIRROR${i + 1} + src`).join(', ')}], sha256, bytes });`,
      '',
      `/** ${files.length} files, ${(total / 1e6).toFixed(1)} MB. Upstream path (URL-encoded) per pack path. */`,
      'export const FILES: PackFile[] = [',
      ...files.map((x) => `  f(${q(x.path)}, ${q(x.src.split('/').map(encodeURIComponent).join('/'))}, '${x.sha256}', ${x.bytes}),`),
      '];',
      '',
      '/** Our SFZ mappings (written into the pack dir at install). */',
      'export const SFZ: PackSfz[] = [',
      ...sfz.map((s) => `  {\n    path: ${q(s.path)},\n    text: \`${esc(s.text)}\`,\n  },`),
      '];',
      '',
      '/** Keys each mapping covers without holes (test/packs-catalog.test.ts checks it). */',
      `export const COVERAGE: Record<string, { lo: number; hi: number } | number[]> = ${JSON.stringify(coverage)};`,
      '',
      '/** RAM per mapping in MB: every (sample, offset, end) as 16-bit stereo at the file rate. */',
      `export const RAM_MB: Record<string, number> = ${JSON.stringify(ram)};`,
      '',
      '/** Audio facts per file, [rate, channels, frames]: lets the test recompute RAM from the SFZ text. */',
      'export const AUDIO: Record<string, readonly [number, number, number]> = {',
      ...files.map((x) => `  ${q(x.path)}: [${x.facts.rate}, ${x.facts.channels}, ${x.facts.frames}],`),
      '};',
      '',
    );
    return { text: L.join('\n'), files, ram, sfz };
  };
}

async function checkPack(spec: PackSpec, rendered: string) {
  const outFile = path.join(root, 'shared', 'packs', 'data', `${spec.id}.gen.ts`);
  if (!existsSync(outFile)) fail(`${spec.id}: ${path.relative(root, outFile)} does not exist; build it first`);
  const committed = readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n');
  if (committed !== rendered) fail(`${spec.id}: ${path.relative(root, outFile)} is out of date with the spec / cached files (rebuild it)`);
  const rows = [...committed.matchAll(/^ {2}f\('([^']+)', '([^']+)', '([0-9a-f]{64})', (\d+)\),$/gm)].map((m) => ({ path: m[1], src: m[2], sha: m[3], bytes: Number(m[4]) }));
  console.log(`${spec.id}: re-downloading ${rows.length} files${checkMirrors ? ` (+ ${spec.mirrors.length} mirror(s) each)` : ''}`);
  const bad: string[] = [];
  await pool(rows, 4, async (r) => {
    const urls = [spec.base + r.src, ...(checkMirrors ? spec.mirrors.map((m) => m + r.src) : [])];
    for (const u of urls) {
      try {
        const b = await fetchBytes(u);
        if (b.length !== r.bytes || sha256(b) !== r.sha) bad.push(`${r.path} from ${u}: got ${b.length} bytes, sha ${sha256(b).slice(0, 12)}…`);
      } catch (e) {
        bad.push(`${r.path}: ${(e as Error).message}`);
      }
    }
  });
  if (bad.length) fail(`${spec.id}: ${bad.length} mismatch(es):\n  ${bad.join('\n  ')}`);
  console.log(`✔ ${spec.id}: every file matches its pinned SHA-256 and size`);
}

for (const spec of specs) {
  if (isSamplePack(spec)) {
    const built = await buildSamples(spec, cacheAbs, { fetchBytes, pool });
    const text = renderSamples(spec, built);
    const outFile = path.join(root, 'shared', 'packs', 'data', `${spec.id}.gen.ts`);
    if (check) {
      if (!existsSync(outFile)) fail(`${spec.id}: ${path.relative(root, outFile)} does not exist; build it first`);
      if (readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n') !== text) fail(`${spec.id}: ${path.relative(root, outFile)} is out of date with the spec / cached files (rebuild it)`);
      console.log(`${spec.id}: re-downloading ${built.files.length} file(s)${checkMirrors ? ' (+ mirrors)' : ''}`);
      const bad = await checkSamples(spec, built, { fetchBytes, pool }, checkMirrors);
      if (bad.length) fail(`${spec.id}: ${bad.length} mismatch(es):\n  ${bad.join('\n  ')}`);
      console.log(`✔ ${spec.id}: every file matches its pinned SHA-256 and size`);
      continue;
    }
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(`${outFile}.tmp`, text);
    renameSync(`${outFile}.tmp`, outFile);
    summarize(spec, built);
    continue;
  }
  const r = await render(spec)();
  if (check) {
    await checkPack(spec, r.text);
    continue;
  }
  const outDir = path.join(root, 'shared', 'packs', 'data');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${spec.id}.gen.ts`);
  writeFileSync(`${outFile}.tmp`, r.text);
  renameSync(`${outFile}.tmp`, outFile);
  const total = r.files.reduce((a, f) => a + f.bytes, 0);
  console.log(`✔ ${spec.id}: ${r.files.length} files, ${(total / 1e6).toFixed(1)} MB download; RAM ${Object.entries(r.ram).map(([k, v]) => `${k} ${v} MB`).join(', ')}`);
  const rates = new Map<string, number>();
  for (const f of r.files) {
    const k = `${f.facts.format} ${f.facts.rate} Hz ${f.facts.bits}-bit ${f.facts.channels}ch`;
    rates.set(k, (rates.get(k) ?? 0) + 1);
  }
  console.log(`  formats: ${[...rates].map(([k, n]) => `${n}× ${k}`).join('; ')}`);
}
