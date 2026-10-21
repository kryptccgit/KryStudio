import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { SAMPLE_KINDS } from '@shared/sounds/types';
import { GENRE_IDS } from '@shared/sounds/genres';
import { probeAudio } from './audio.mjs';
import { assertSafePath, extOf, urlFor, type SampleDef, type SamplePackSpec, type SampleSource } from './lib';

const OK_EXT = new Set(['.wav', '.flac', '.ogg', '.mp3']);
const ASCII_NAME = /^[\x20-\x7e]+$/;

export interface Fetcher {
  fetchBytes(url: string): Promise<Uint8Array>;
  pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]>;
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

interface Facts {
  rate: number;
  channels: number;
  frames: number;
  peakDb: number;
  codec: string;
}

function measureFile(file: string, bytes: Uint8Array): Facts {
  const ext = extOf(file);
  if (ext === '.wav') probeAudio(bytes.subarray(0, 65536), bytes.length);
  const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels,codec_name', '-of', 'json', file], { encoding: 'utf8' });
  if (pr.error) throw new Error(`ffprobe is needed to measure sample packs (${pr.error.message}); install ffmpeg and put it on PATH`);
  const st = JSON.parse(pr.stdout).streams?.[0];
  if (!st) throw new Error(`${file}: no audio stream`);
  const rate = Number(st.sample_rate);
  const channels = Number(st.channels);
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], { maxBuffer: 1 << 30 });
  if (dec.status !== 0) throw new Error(`${file}: ffmpeg could not decode it: ${dec.stderr}`);
  const b = dec.stdout as Buffer;
  const x = new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }
  const frames = Math.floor(x.length / channels);
  return { rate, channels, frames, peakDb: peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : -120, codec: st.codec_name };
}

interface Built {
  files: { path: string; url: string; mirrors?: string[]; sha256: string; bytes: number; members?: { from: string; path: string; sha256: string; bytes: number }[] }[];
  samples: (SampleDef & { facts: Facts })[];
}

function validate(spec: SamplePackSpec) {
  const seen = new Set<string>();
  const names = new Set<string>();
  for (const s of spec.samples) {
    assertSafePath(s.path);
    const src = spec.sources[s.from];
    if (!src) throw new Error(`${spec.id}: sample "${s.name}" uses unknown source "${s.from}"`);
    if (src.type !== 'url' && !s.src) throw new Error(`${spec.id}: sample "${s.name}" needs src (its ${src.type} path)`);
    if (src.type === 'zip' && !ASCII_NAME.test(s.src!)) throw new Error(`${spec.id}: member "${s.src}" is not plain ASCII`);
    const ext = extOf(src.type === 'url' ? src.url : s.src!);
    if (!OK_EXT.has(ext)) throw new Error(`${spec.id}: ${s.src ?? src.url} is ${ext}; sample packs use WAV, FLAC, OGG or MP3`);
    if (extOf(s.path) !== ext) throw new Error(`${spec.id}: ${s.path} must keep the upstream extension ${ext}`);
    const key = s.path.toLowerCase();
    if (seen.has(key)) throw new Error(`${spec.id}: duplicate pack path ${s.path}`);
    seen.add(key);
    if (names.has(s.name.toLowerCase())) throw new Error(`${spec.id}: duplicate sample name "${s.name}"`);
    names.add(s.name.toLowerCase());
    if (!(SAMPLE_KINDS as readonly string[]).includes(s.kind)) throw new Error(`${spec.id}: "${s.name}" has unknown kind ${s.kind}`);
    for (const g of s.genres) if (!(GENRE_IDS as readonly string[]).includes(g)) throw new Error(`${spec.id}: "${s.name}" has unknown genre ${g}`);
    if (!s.genres.length) throw new Error(`${spec.id}: "${s.name}" needs at least one genre`);
  }
  for (const [k, src] of Object.entries(spec.sources)) {
    if (!spec.samples.some((s) => s.from === k)) throw new Error(`${spec.id}: source "${k}" is not used by any sample`);
    if (src.type === 'zip') assertSafePath(src.path);
    if (src.type === 'url' && spec.samples.filter((s) => s.from === k).length !== 1) throw new Error(`${spec.id}: url source "${k}" must back exactly one sample`);
  }
}

export async function buildSamples(spec: SamplePackSpec, cacheAbs: string, f: Fetcher): Promise<Built> {
  validate(spec);
  const dir = path.join(cacheAbs, spec.id);
  const cached = async (rel: string, url: string): Promise<Uint8Array> => {
    const file = path.join(dir, ...rel.split('/'));
    if (existsSync(file)) return new Uint8Array(readFileSync(file));
    const bytes = await f.fetchBytes(url);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.part`, bytes);
    renameSync(`${file}.part`, file);
    return bytes;
  };
  const files: Built['files'] = [];
  const out: Built['samples'] = [];
  const byPath = new Map<string, Facts>();
  const measureInto = (s: SampleDef, bytes: Uint8Array) => {
    const file = path.join(dir, ...s.path.split('/'));
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    const facts = measureFile(file, bytes);
    byPath.set(s.path, facts);
    return { sha256: sha256(bytes), bytes: bytes.length };
  };

  for (const [key, src] of Object.entries(spec.sources)) {
    const mine = spec.samples.filter((s) => s.from === key);
    if (src.type === 'zip') {
      console.log(`${spec.id}: ${key}: archive with ${mine.length} member(s)`);
      const zip = await cached(src.path, src.url);
      const want = new Set(mine.map((s) => s.src!));
      const entries = unzipSync(zip, { filter: (e) => want.has(e.name) });
      const members = mine.map((s) => {
        const b = entries[s.src!];
        if (!b) throw new Error(`${spec.id}: ${src.url} has no entry "${s.src}"`);
        return { from: s.src!, path: s.path, ...measureInto(s, b) };
      });
      files.push({ path: src.path, url: src.url, ...(src.mirrors?.length ? { mirrors: src.mirrors } : {}), sha256: sha256(zip), bytes: zip.length, members });
    } else if (src.type === 'url') {
      const s = mine[0];
      const b = await cached(s.path, src.url);
      files.push({ path: s.path, url: src.url, ...(src.mirrors?.length ? { mirrors: src.mirrors } : {}), ...measureInto(s, b) });
    } else {
      console.log(`${spec.id}: ${key}: ${mine.length} file(s)`);
      const rows = await f.pool(mine, 8, async (s) => {
        const b = await cached(s.path, urlFor(src.base, s.src!));
        return { s, b };
      });
      for (const { s, b } of rows) {
        const enc = s.src!.split('/').map(encodeURIComponent).join('/');
        files.push({ path: s.path, url: src.base + enc, mirrors: src.mirrors.map((m) => m + enc), ...measureInto(s, b) });
      }
    }
  }
  for (const s of spec.samples) out.push({ ...s, facts: byPath.get(s.path)! });
  const bySha = new Map<string, string>();
  for (const x of files) {
    for (const r of x.members ?? [x]) {
      if (!byPath.has(r.path)) continue;
      const other = bySha.get(r.sha256);
      if (other) throw new Error(`${spec.id}: ${r.path} has the same bytes as ${other}; keep one`);
      bySha.set(r.sha256, r.path);
    }
  }
  return { files, samples: out };
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const arr = (a: string[]) => `[${a.map(q).join(', ')}]`;

export function renderSamples(spec: SamplePackSpec, b: Built): string {
  const total = b.files.reduce((a, x) => a + x.bytes, 0);
  const L: string[] = [];
  const srcName = (s: SampleSource) => (s.type === 'zip' ? s.path : s.type);
  L.push(
    `// GENERATED by scripts/packs/build.ts from scripts/packs/specs/${spec.id}.ts — do not edit by hand.`,
    `// Regenerate: node scripts/run-script.mjs scripts/packs/build.ts ${spec.id} --cache <scratch dir>`,
    `// Verify:     node scripts/run-script.mjs scripts/packs/build.ts ${spec.id} --cache <scratch dir> --check`,
    `// Sources: ${Object.values(spec.sources).map(srcName).join(', ')}.`,
    '',
    "import type { PackFile, PackSample, PackSfz } from '../types';",
    '',
    `/** ${b.files.length} download(s), ${(total / 1e6).toFixed(1)} MB. Archives list the members extracted at install. */`,
    'export const FILES: PackFile[] = [',
  );
  for (const x of b.files) {
    const head = `path: ${q(x.path)}, url: ${q(x.url)}${x.mirrors ? `, mirrors: ${arr(x.mirrors)}` : ''}, sha256: '${x.sha256}', bytes: ${x.bytes}`;
    if (!x.members) {
      L.push(`  { ${head} },`);
      continue;
    }
    L.push(`  {`, `    ${head},`, `    archive: {`, `      format: 'zip',`, `      members: [`);
    for (const m of x.members) L.push(`        { from: ${q(m.from)}, path: ${q(m.path)}, sha256: '${m.sha256}', bytes: ${m.bytes} },`);
    L.push(`      ],`, `    },`, `  },`);
  }
  L.push('];', '', '/** Sample packs carry no SFZ mappings. */', 'export const SFZ: PackSfz[] = [];', '');
  L.push(`/** ${b.samples.length} samples added to the sound library when the pack is installed. */`, 'export const SAMPLES: PackSample[] = [');
  for (const s of b.samples) {
    const parts = [
      `path: ${q(`pack:${spec.id}/${s.path}`)}`,
      `name: ${q(s.name)}`,
      `kind: ${q(s.kind)}`,
      `tags: ${arr(s.tags)}`,
      `genres: ${arr(s.genres)}`,
      ...(s.rootNote !== undefined ? [`rootNote: ${s.rootNote}`] : []),
      `lengthSec: ${Math.round((s.facts.frames / s.facts.rate) * 1000) / 1000}`,
      `channels: ${s.facts.channels}`,
      ...(s.bpm !== undefined ? [`bpm: ${s.bpm}`, `bars: ${s.bars}`] : []),
      `peakDb: ${s.facts.peakDb}`,
      ...(s.credit ? [`credit: ${q(s.credit)}`] : []),
    ];
    L.push(`  { ${parts.join(', ')} },`);
  }
  L.push('];', '');
  L.push(
    '/** No instruments to keep in RAM: a sample pack\'s ramMb is 0 (samples load one at a time, like factory samples). */',
    'export const RAM_MB: Record<string, number> = {};',
    '',
    '/** Sample packs map no keys. */',
    'export const COVERAGE: Record<string, { lo: number; hi: number } | number[]> = {};',
    '',
    '/** Audio facts per sample file (pack path), [rate, channels, frames]. */',
    'export const AUDIO: Record<string, readonly [number, number, number]> = {',
    ...b.samples.map((s) => `  ${q(s.path)}: [${s.facts.rate}, ${s.facts.channels}, ${s.facts.frames}],`),
    '};',
    '',
  );
  return L.join('\n');
}

export function summarize(spec: SamplePackSpec, b: Built): void {
  const total = b.files.reduce((a, x) => a + x.bytes, 0);
  const kinds = new Map<string, number>();
  for (const s of b.samples) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  const fmts = new Map<string, number>();
  for (const s of b.samples) {
    const k = `${s.facts.codec} ${s.facts.rate} Hz ${s.facts.channels}ch`;
    fmts.set(k, (fmts.get(k) ?? 0) + 1);
  }
  console.log(`✔ ${spec.id}: ${b.samples.length} samples in ${b.files.length} download(s), ${(total / 1e6).toFixed(1)} MB`);
  console.log(`  kinds: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`  formats: ${[...fmts].map(([k, n]) => `${n}× ${k}`).join('; ')}`);
  const loud = b.samples.filter((s) => s.facts.peakDb > 0.5).map((s) => `${s.name} (${s.facts.peakDb} dB)`);
  if (loud.length) console.log(`  ⚠ decoded peaks above 0 dBFS: ${loud.join(', ')}`);
  const quiet = b.samples.filter((s) => s.facts.peakDb < -36).map((s) => `${s.name} (${s.facts.peakDb} dB)`);
  if (quiet.length) console.log(`  ⚠ very quiet: ${quiet.join(', ')}`);
}

export async function checkSamples(spec: SamplePackSpec, b: Built, f: Fetcher, mirrors: boolean): Promise<string[]> {
  const bad: string[] = [];
  await f.pool(b.files, 4, async (x) => {
    for (const u of [x.url, ...(mirrors ? (x.mirrors ?? []) : [])]) {
      try {
        const got = await f.fetchBytes(u);
        if (got.length !== x.bytes || sha256(got) !== x.sha256) {
          bad.push(`${x.path} from ${u}: got ${got.length} bytes, sha ${sha256(got).slice(0, 12)}…`);
          continue;
        }
        if (x.members) {
          const want = new Set(x.members.map((m) => m.from));
          const e = unzipSync(got, { filter: (z) => want.has(z.name) });
          for (const m of x.members) if (!e[m.from] || sha256(e[m.from]) !== m.sha256 || e[m.from].length !== m.bytes) bad.push(`${x.path}: member ${m.from} differs`);
        }
      } catch (err) {
        bad.push(`${x.path}: ${(err as Error).message}`);
      }
    }
  });
  return bad;
}
