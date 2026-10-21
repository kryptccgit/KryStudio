import assert from 'node:assert/strict';
import { test, run } from './harness';
import raw from '../shared/plugins/catalog.gen.json';
import type { ParamSpec, PluginCatalog } from '@shared/plugins/types';
import { clampToSpec } from '@shared/plugins/types';
import { PACKS, packById } from '@shared/packs/catalog';
import { PACK_NAMES } from '@shared/packs/names';
import { SFZ_OPCODES, parsePackPath, type PackSample } from '@shared/packs/types';
import { SAMPLE_KINDS } from '@shared/sounds/types';
import { GENRE_IDS } from '@shared/sounds/genres';
import { INSTRUMENT_PRESETS } from '@shared/sounds/factory/instruments';
import { PACK_PRESETS } from '@shared/sounds/factory/instruments/packs';
import { zInstrumentPreset } from '@shared/sounds/schema';
import * as GRAND from '@shared/packs/data/grand-piano.gen';
import * as UPRIGHT from '@shared/packs/data/upright-piano.gen';
import * as DRUMS from '@shared/packs/data/live-drums.gen';
import * as MALLETS from '@shared/packs/data/keys-mallets.gen';
import * as ORCH from '@shared/packs/data/orchestral.gen';
import * as FOLEY from '@shared/packs/data/foley-field.gen';
import * as HITS from '@shared/packs/data/hits-whooshes.gen';
import * as PERC from '@shared/packs/data/perc-extras.gen';
import * as RETRO from '@shared/packs/data/retro-game.gen';

type Gen = { COVERAGE: Record<string, { lo: number; hi: number } | number[]>; RAM_MB: Record<string, number>; AUDIO: Record<string, readonly [number, number, number]>; SAMPLES?: PackSample[] };
const GEN: Record<string, Gen> = {
  'grand-piano': GRAND,
  'upright-piano': UPRIGHT,
  'live-drums': DRUMS,
  'keys-mallets': MALLETS,
  orchestral: ORCH,
  'perc-extras': PERC,
  'hits-whooshes': HITS,
  'foley-field': FOLEY,
  'retro-game': RETRO,
};

const MAX_MB: Record<string, number> = { 'grand-piano': 300, 'upright-piano': 300, 'live-drums': 200, 'keys-mallets': 250, orchestral: 250, 'perc-extras': 150, 'hits-whooshes': 150, 'foley-field': 150, 'retro-game': 150 };
const SAMPLE_PACKS_MAX_MB = 400;
const GITHUB_RAW = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\/\S+$/;
const DIRECT_URL = /^https:\/\/(opengameart\.org\/sites\/default\/files\/|kenney\.nl\/media\/pages\/assets\/[a-z0-9-]+\/[0-9a-f]{10}-\d+\/)[^\s?#]+$/;
const isSamplePack = (p: { samples?: unknown[] }) => (p.samples?.length ?? 0) > 0;
const installed = (p: (typeof PACKS)[number]) => p.files.flatMap((f) => (f.archive ? f.archive.members.map((m) => m.path) : [f.path]));
const RAM_CAP_MB = 250;
const RESERVED_ROOT = new Set(['pack.json', 'license.txt', '.krypt-partial.json']);

interface Region {
  line: number;
  op: Record<string, string>;
}

function parseSfz(text: string): { regions: Region[]; opcodes: Set<string>; control: Record<string, string>; problems: string[] } {
  const problems: string[] = [];
  const opcodes = new Set<string>();
  const control: Record<string, string> = {};
  const regions: Region[] = [];
  let global: Record<string, string> = {};
  let master: Record<string, string> = {};
  let group: Record<string, string> = {};
  let header = '';
  let cur: Region | null = null;
  const lines = text.split('\n');
  lines.forEach((rawLine, i) => {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) return;
    if (/^#/.test(line)) problems.push(`line ${i + 1}: preprocessor directive "${line}" (no #include / #define in our mappings)`);
    for (const tok of line.match(/<[a-z]+>|[a-z_]+=\S+/g) ?? []) {
      if (tok.startsWith('<')) {
        if (cur) regions.push(cur);
        cur = null;
        header = tok;
        if (tok === '<global>') {
          global = {};
          master = {};
          group = {};
        } else if (tok === '<master>') {
          master = {};
          group = {};
        } else if (tok === '<group>') group = {};
        else if (tok === '<region>') cur = { line: i + 1, op: { ...global, ...master, ...group } };
        else if (tok !== '<control>') problems.push(`line ${i + 1}: unknown header ${tok}`);
        continue;
      }
      const eq = tok.indexOf('=');
      const k = tok.slice(0, eq);
      const v = tok.slice(eq + 1);
      opcodes.add(k);
      if (cur) cur.op[k] = v;
      else if (header === '<control>') control[k] = v;
      else if (header === '<global>') global[k] = v;
      else if (header === '<master>') master[k] = v;
      else if (header === '<group>') group[k] = v;
      else problems.push(`line ${i + 1}: opcode ${k} outside any header`);
    }
  });
  if (cur) regions.push(cur);
  return { regions, opcodes, control, problems };
}

const num = (r: Region, k: string, d: number) => (r.op[k] !== undefined ? Number(r.op[k]) : d);
const lokey = (r: Region) => num(r, 'lokey', 0);
const hikey = (r: Region) => num(r, 'hikey', 127);
const lovel = (r: Region) => num(r, 'lovel', 0);
const hivel = (r: Region) => num(r, 'hivel', 127);

function xfGain(r: Region, vel: number): number {
  let g = 1;
  if (r.op.xfin_lovel !== undefined) {
    const lo = num(r, 'xfin_lovel', 0);
    const hi = num(r, 'xfin_hivel', 0);
    g *= vel <= lo ? (hi > lo ? 0 : 1) : vel >= hi ? 1 : (vel - lo) / (hi - lo);
  }
  if (r.op.xfout_lovel !== undefined) {
    const lo = num(r, 'xfout_lovel', 127);
    const hi = num(r, 'xfout_hivel', 127);
    g *= vel >= hi ? (hi > lo ? 0 : 1) : vel <= lo ? 1 : (hi - vel) / (hi - lo);
  }
  return g;
}

function joinPath(sfzPath: string, rel: string): string {
  const parts = sfzPath.split('/').slice(0, -1);
  for (const s of rel.split('/')) {
    if (s === '..') parts.pop();
    else if (s !== '.' && s !== '') parts.push(s);
  }
  return parts.join('/');
}

const sample = (control: Record<string, string>, r: Region) => (control.default_path ?? '') + r.op.sample;

function pathProblems(p: string): string[] {
  const out: string[] = [];
  if (!p || p.startsWith('/') || p.includes('\\')) out.push('absolute or backslashed');
  if (/[:*?"<>|]/.test(p)) out.push('a character Windows forbids');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(p)) out.push('a control character');
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') out.push(`segment "${seg}"`);
    if (/[. ]$/.test(seg)) out.push(`segment "${seg}" ends with a dot or space`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(p)) out.push('characters outside A-Z a-z 0-9 . _ - /');
  if (!p.includes('/') && RESERVED_ROOT.has(p.toLowerCase())) out.push('a file name the installer reserves');
  return out;
}

test('3-9 packs with unique, valid ids, a version and a card', () => {
  assert.ok(PACKS.length >= 3 && PACKS.length <= 9, `${PACKS.length} packs`);
  const seen = new Set<string>();
  for (const p of PACKS) {
    assert.match(p.id, /^[a-z0-9][a-z0-9-]*$/, `bad id ${p.id}`);
    assert.ok(!seen.has(p.id), `duplicate id ${p.id}`);
    seen.add(p.id);
    assert.equal(packById(p.id), p);
    assert.ok(Number.isInteger(p.version) && p.version >= 1, `${p.id}: version`);
    assert.ok(p.name.trim() && p.author.trim(), `${p.id}: name / author`);
    assert.ok(p.description.length >= 40 && /[.!]$/.test(p.description), `${p.id}: description should be a full sentence`);
    assert.match(p.homepage, /^https?:\/\//, `${p.id}: homepage`);
    assert.ok(p.contents.length >= 1 && p.contents.every((c) => c.trim().length > 3), `${p.id}: contents`);
    assert.ok(GEN[p.id], `${p.id}: generated data is wired into this test`);
  }
});

test('licences: known SPDX id, https source, a credit line; informal public-domain statements are archived', () => {
  for (const p of PACKS) {
    const l = p.licence;
    assert.ok(['CC0-1.0', 'LicenseRef-PublicDomain', 'CC-BY-4.0'].includes(l.spdx), `${p.id}: spdx ${l.spdx}`);
    assert.ok(l.name.trim(), `${p.id}: licence name`);
    assert.match(l.url, /^https:\/\//, `${p.id}: licence url`);
    assert.ok(l.attribution.length > 20, `${p.id}: attribution`);
    if (l.spdx === 'LicenseRef-PublicDomain') {
      assert.ok(l.statement && /public domain/i.test(l.statement), `${p.id}: the informal statement must be archived in licence.statement`);
      assert.match(l.statement!, /web\.archive\.org\/web\/\d{14}\//, `${p.id}: the statement cites a pinned archive snapshot`);
    }
    const githubOnly = p.files.every((f) => GITHUB_RAW.test(f.url));
    if (l.spdx === 'CC0-1.0' && githubOnly) assert.match(l.url, /\/blob\/[0-9a-f]{40}\/LICENSE$/, `${p.id}: CC0 is evidenced by the LICENSE file at the pinned commit`);
    if (!githubOnly) {
      assert.ok(l.statement && /CC0/.test(l.statement), `${p.id}: licence.statement must quote each source's licence`);
      const pages = new Set(p.files.map((f) => (/opengameart\.org/.test(f.url) ? 'opengameart.org/content/' : /kenney\.nl/.test(f.url) ? 'kenney.nl/assets/' : 'github.com/')));
      for (const h of pages) assert.ok(l.statement!.includes(h), `${p.id}: the statement cites no ${h} source page`);
      assert.match(l.statement!, /read \d{4}-\d{2}-\d{2}/, `${p.id}: the statement says when each licence was read`);
    }
  }
});

test('bytes equal the sum of the files; downloads stay within their caps', () => {
  for (const p of PACKS) {
    assert.equal(p.bytes, p.files.reduce((a, f) => a + f.bytes, 0), `${p.id}: bytes`);
    assert.ok(p.bytes / 1e6 <= MAX_MB[p.id], `${p.id}: ${(p.bytes / 1e6).toFixed(0)} MB > ${MAX_MB[p.id]} MB`);
  }
  const samples = PACKS.filter(isSamplePack).reduce((a, p) => a + p.bytes, 0) / 1e6;
  assert.ok(samples <= SAMPLE_PACKS_MAX_MB, `sample packs total ${samples.toFixed(0)} MB > ${SAMPLE_PACKS_MAX_MB} MB`);
});

test('every file: commit-pinned https URL + mirrors, 64-hex sha256, bytes > 0, a safe unique path', () => {
  for (const p of PACKS) {
    const paths = new Set<string>();
    for (const f of p.files) {
      const where = `${p.id}/${f.path}`;
      if (GITHUB_RAW.test(f.url)) {
        assert.ok(f.mirrors?.length, `${where}: a mirror`);
        for (const m of f.mirrors ?? []) assert.match(m, /^https:\/\/cdn\.jsdelivr\.net\/gh\/[^/]+\/[^/@]+@[0-9a-f]{40}\/\S+$/, `${where}: mirror ${m}`);
      } else {
        assert.ok(isSamplePack(p), `${where}: url must be a raw GitHub URL pinned to a commit`);
        assert.match(f.url, DIRECT_URL, `${where}: ${f.url} is not a stable direct URL on an allowed host`);
        for (const m of f.mirrors ?? []) assert.match(m, /^https:\/\//, `${where}: mirror ${m}`);
      }
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${where}: sha256`);
      assert.ok(Number.isInteger(f.bytes) && f.bytes > 0, `${where}: bytes`);
      assert.deepEqual(pathProblems(f.path), [], `${where}`);
      assert.ok(parsePackPath(`pack:${p.id}/${f.path}`), `${where}: parsePackPath`);
      const key = f.path.toLowerCase();
      assert.ok(!paths.has(key), `${where}: duplicate path`);
      paths.add(key);
      if (f.archive) {
        assert.equal(f.archive.format, 'zip', `${where}: archive format`);
        assert.match(f.path, /\.zip$/, `${where}: an archive downloads to a .zip path`);
        assert.ok(f.archive.members.length > 0, `${where}: an archive lists the members it extracts`);
        const froms = new Set<string>();
        for (const m of f.archive.members) {
          const at = `${where} → ${m.from}`;
          assert.match(m.from, /^[\x20-\x7e]+$/, `${at}: entry name is not plain ASCII`);
          assert.ok(!m.from.startsWith('/') && !m.from.includes('\\') && !m.from.split('/').includes('..'), `${at}: unsafe entry name`);
          assert.ok(!froms.has(m.from), `${at}: listed twice`);
          froms.add(m.from);
          assert.match(m.sha256, /^[0-9a-f]{64}$/, `${at}: sha256`);
          assert.ok(Number.isInteger(m.bytes) && m.bytes > 0, `${at}: bytes`);
          assert.deepEqual(pathProblems(m.path), [], `${at}: ${m.path}`);
          assert.ok(parsePackPath(`pack:${p.id}/${m.path}`), `${at}: parsePackPath`);
          const mk = m.path.toLowerCase();
          assert.ok(!paths.has(mk), `${at}: ${m.path} duplicates another path in the pack`);
          paths.add(mk);
        }
      }
    }
    for (const s of p.sfz) {
      assert.deepEqual(pathProblems(s.path), [], `${p.id}/${s.path}`);
      assert.match(s.path, /\.sfz$/, `${p.id}/${s.path}: an .sfz`);
      assert.ok(!paths.has(s.path.toLowerCase()), `${p.id}/${s.path}: an SFZ path equals a file path`);
      paths.add(s.path.toLowerCase());
    }
  }
});

test('the generated audio facts cover exactly the files', () => {
  for (const p of PACKS) {
    const g = GEN[p.id];
    assert.deepEqual(Object.keys(g.AUDIO).sort(), installed(p).sort(), `${p.id}: AUDIO keys`);
    for (const [path, [rate, ch, frames]] of Object.entries(g.AUDIO)) assert.ok([44100, 48000, 88200, 96000].includes(rate) && (ch === 1 || ch === 2) && frames > 0, `${p.id}/${path}: facts`);
    assert.deepEqual(Object.keys(g.COVERAGE).sort(), p.sfz.map((s) => s.path).sort(), `${p.id}: COVERAGE keys`);
  }
});

test('every SFZ uses only the opcodes krypt.multisampler supports, with sane values', () => {
  const allowed = new Set<string>(SFZ_OPCODES);
  for (const p of PACKS) {
    for (const s of p.sfz) {
      const where = `${p.id}/${s.path}`;
      const r = parseSfz(s.text);
      assert.deepEqual(r.problems, [], where);
      assert.deepEqual([...r.opcodes].filter((o) => !allowed.has(o)), [], `${where}: opcodes outside SFZ_OPCODES`);
      assert.ok(r.regions.length > 0, `${where}: no regions`);
      for (const g of r.regions) {
        const at = `${where}:${g.line}`;
        assert.ok(g.op.sample, `${at}: region without sample`);
        assert.ok(lokey(g) >= 0 && lokey(g) <= hikey(g) && hikey(g) <= 127, `${at}: keys`);
        assert.ok(lovel(g) >= 0 && lovel(g) <= hivel(g) && hivel(g) <= 127, `${at}: velocities`);
        const kc = num(g, 'pitch_keycenter', 60);
        assert.ok(kc >= 0 && kc <= 127, `${at}: pitch_keycenter`);
        const v = num(g, 'volume', 0);
        assert.ok(v >= -60 && v <= 24, `${at}: volume ${v} (the engine clamps at +24 dB)`);
        if (g.op.loop_mode) assert.ok(['no_loop', 'one_shot', 'loop_continuous', 'loop_sustain'].includes(g.op.loop_mode), `${at}: loop_mode`);
        if (g.op.trigger) assert.ok(['attack', 'release'].includes(g.op.trigger), `${at}: trigger`);
        if (g.op.off_mode) assert.ok(['fast', 'normal'].includes(g.op.off_mode), `${at}: off_mode`);
        if (g.op.seq_length) assert.ok(num(g, 'seq_position', 1) >= 1 && num(g, 'seq_position', 1) <= num(g, 'seq_length', 1), `${at}: seq_position`);
        for (const k of ['ampeg_attack', 'ampeg_hold', 'ampeg_decay', 'ampeg_release']) assert.ok(num(g, k, 0) >= 0 && num(g, k, 0) <= 100, `${at}: ${k}`);
        const sus = num(g, 'ampeg_sustain', 100);
        assert.ok(sus >= 0 && sus <= 100, `${at}: ampeg_sustain`);
      }
    }
  }
});

test('every referenced sample is a file of the pack, every file is used, trims sit inside the files', () => {
  for (const p of PACKS) {
    if (isSamplePack(p)) continue;
    const files = new Set(p.files.map((f) => f.path));
    const audio = GEN[p.id].AUDIO;
    const used = new Set<string>();
    for (const s of p.sfz) {
      const r = parseSfz(s.text);
      for (const g of r.regions) {
        const path = joinPath(s.path, sample(r.control, g));
        assert.ok(files.has(path), `${p.id}/${s.path}:${g.line}: sample ${path} is not in the pack's files`);
        used.add(path);
        const frames = audio[path][2];
        const offset = num(g, 'offset', 0);
        const end = num(g, 'end', frames - 1);
        assert.ok(offset >= 0 && offset < end && end <= frames - 1, `${p.id}/${s.path}:${g.line}: offset ${offset} / end ${end} outside ${frames} frames`);
      }
    }
    assert.deepEqual([...files].filter((f) => !used.has(f)), [], `${p.id}: downloaded files no mapping uses`);
  }
});

test('mappings cover their playable keys at every velocity, with complete round-robin cycles', () => {
  for (const p of PACKS) {
    const cov = GEN[p.id].COVERAGE;
    for (const s of p.sfz) {
      const where = `${p.id}/${s.path}`;
      const attack = parseSfz(s.text).regions.filter((g) => (g.op.trigger ?? 'attack') === 'attack');
      const keys = keysOf(cov[s.path]);
      assert.ok(keys.length > 0, `${where}: no keys to cover`);
      const holes: string[] = [];
      for (const key of keys) {
        for (let vel = 1; vel <= 127; vel++) {
          const hit = attack.filter((g) => key >= lokey(g) && key <= hikey(g) && vel >= lovel(g) && vel <= hivel(g) && xfGain(g, vel) > 0);
          if (!hit.length) {
            holes.push(`key ${key} vel ${vel}`);
            continue;
          }
          const byLen = new Map<number, Set<number>>();
          for (const g of hit) {
            const L = num(g, 'seq_length', 1);
            (byLen.get(L) ?? byLen.set(L, new Set()).get(L)!).add(num(g, 'seq_position', 1));
          }
          for (const [L, pos] of byLen) for (let k = 1; k <= L; k++) if (!pos.has(k)) holes.push(`key ${key} vel ${vel}: round robin ${k}/${L} is silent`);
        }
      }
      assert.deepEqual(holes.slice(0, 5), [], `${where}: ${holes.length} hole(s)`);
    }
  }
});

function keysOf(c: { lo: number; hi: number } | number[]): number[] {
  return Array.isArray(c) ? c : Array.from({ length: c.hi - c.lo + 1 }, (_, i) => c.lo + i);
}

test('RAM: recomputed from the SFZ and the audio facts, each mapping under the cap, ramMb = the largest', () => {
  for (const p of PACKS) {
    const audio = GEN[p.id].AUDIO;
    let largest = 0;
    const recorded = Math.max(0, ...Object.values(GEN[p.id].RAM_MB));
    for (const s of p.sfz) {
      const r = parseSfz(s.text);
      const seen = new Map<string, number>();
      for (const g of r.regions) {
        const path = joinPath(s.path, sample(r.control, g));
        const frames = audio[path][2];
        const offset = num(g, 'offset', 0);
        const end = num(g, 'end', frames - 1);
        seen.set(`${path}|${offset}|${end}`, (end - offset + 1) * 4);
      }
      const mb = [...seen.values()].reduce((a, b) => a + b, 0) / 1e6;
      assert.ok(Math.abs(mb - GEN[p.id].RAM_MB[s.path]) < 0.2, `${p.id}/${s.path}: RAM ${mb.toFixed(1)} MB vs recorded ${GEN[p.id].RAM_MB[s.path]}`);
      assert.ok(mb <= RAM_CAP_MB, `${p.id}/${s.path}: ${mb.toFixed(0)} MB RAM > ${RAM_CAP_MB} MB`);
      largest = Math.max(largest, mb);
    }
    assert.equal(p.ramMb, Math.ceil(recorded), `${p.id}: ramMb is the largest mapping's RAM, rounded up`);
    assert.ok(p.ramMb >= largest - 0.2, `${p.id}: ramMb ${p.ramMb} < ${largest.toFixed(1)}`);
  }
});

const MULTISAMPLER_PARAMS: Pick<ParamSpec, 'id' | 'min' | 'max' | 'step'>[] = [
  { id: 'gain', min: -24, max: 12 },
  { id: 'attack', min: 0, max: 2000 },
  { id: 'release', min: 0, max: 4 },
  { id: 'velSens', min: 0, max: 1 },
  { id: 'tone', min: 200, max: 20000 },
  { id: 'tune', min: -24, max: 24, step: 1 },
  { id: 'fine', min: -100, max: 100 },
  { id: 'releaseSamples', min: 0, max: 1 },
  { id: 'width', min: 0, max: 1 },
  { id: 'roundRobin', min: 0, max: 1, step: 1 },
];

test('pack presets: schema-valid, require an existing pack and play one of its SFZ mappings', () => {
  assert.ok(PACK_PRESETS.length >= 10, `only ${PACK_PRESETS.length} pack presets`);
  const ids = new Set(INSTRUMENT_PRESETS.map((p) => p.id));
  for (const p of PACK_PRESETS) {
    assert.ok(ids.has(p.id), `${p.id} is registered in the instruments index`);
    const z = zInstrumentPreset.safeParse(p);
    assert.ok(z.success, `${p.id}: ${z.success ? '' : z.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    assert.equal(p.plugin, 'krypt.multisampler', `${p.id}: plugin`);
    assert.ok(p.requires, `${p.id}: requires`);
    const pack = packById(p.requires!);
    assert.ok(pack, `${p.id}: requires unknown pack ${p.requires}`);
    const pp = parsePackPath(p.sample ?? '');
    assert.ok(pp, `${p.id}: sample ${p.sample} is not a pack: path`);
    assert.equal(pp.packId, p.requires, `${p.id}: plays a different pack than it requires`);
    assert.ok(pack.sfz.some((s) => s.path === pp.path), `${p.id}: ${pp.path} is not one of ${pack.id}'s SFZ mappings`);
    const covered = new Set(keysOf(GEN[pack.id].COVERAGE[pp.path]));
    const [lo, hi] = p.range!;
    assert.ok(covered.has(lo) && covered.has(hi), `${p.id}: range ${lo}-${hi} outside what ${pp.path} maps`);
    for (const g of p.defaultFor ?? []) assert.ok(p.genres.includes(g), `${p.id}: default for ${g} but not in its genres`);
  }
  for (const p of INSTRUMENT_PRESETS) if (p.sample?.startsWith('pack:')) assert.equal(p.requires, parsePackPath(p.sample)?.packId, `${p.id}: plays ${p.sample} without requires`);
});

test('every instrument pack has presets, and every mapping is played by at least one preset', () => {
  for (const pack of PACKS) {
    if (!pack.sfz.length) continue;
    const played = new Set(PACK_PRESETS.filter((p) => p.requires === pack.id).map((p) => parsePackPath(p.sample!)!.path));
    assert.ok(played.size > 0, `${pack.id}: no presets`);
    assert.deepEqual(pack.sfz.map((s) => s.path).filter((s) => !played.has(s)), [], `${pack.id}: mappings no preset plays`);
  }
});

test('pack preset params are on-spec for krypt.multisampler (the engine catalog once it lists the plugin)', () => {
  const plugin = (raw as PluginCatalog).plugins.find((x) => x.id === 'krypt.multisampler');
  const specs = plugin ? plugin.params : (MULTISAMPLER_PARAMS as ParamSpec[]);
  if (plugin) assert.equal(plugin.usesSample, true, 'krypt.multisampler plays a sample (its SFZ)');
  const problems: string[] = [];
  for (const p of PACK_PRESETS) {
    assert.equal(typeof p.params.gain, 'number', `${p.id}: states its gain`);
    for (const [k, v] of Object.entries(p.params)) {
      const s = specs.find((x) => x.id === k);
      if (!s) problems.push(`${p.id}: no param "${k}"`);
      else if (plugin ? clampToSpec(s, v) !== v : v < s.min || v > s.max || (s.step ? Math.abs(v / s.step - Math.round(v / s.step)) > 1e-9 : false)) problems.push(`${p.id}: ${k} = ${v} off-spec (${s.min}..${s.max})`);
    }
  }
  assert.deepEqual(problems, []);
});

test('sample packs: 2-4 of them, no SFZ, every sample is a real file or archive member of its pack, every file is used', () => {
  const sp = PACKS.filter(isSamplePack);
  assert.ok(sp.length >= 2 && sp.length <= 4, `${sp.length} sample packs`);
  for (const p of sp) {
    assert.deepEqual(p.sfz, [], `${p.id}: a sample pack carries no SFZ mappings`);
    assert.equal(p.ramMb, 0, `${p.id}: ramMb`);
    assert.deepEqual(p.samples, GEN[p.id].SAMPLES, `${p.id}: samples come from the generated data`);
    const files = new Set(installed(p));
    const used = new Set<string>();
    for (const s of p.samples!) {
      const pp = parsePackPath(s.path);
      assert.ok(pp, `${p.id}: ${s.path} is not a pack: path`);
      assert.equal(pp.packId, p.id, `${s.path}: belongs to another pack`);
      assert.ok(files.has(pp.path), `${s.path}: no such file or archive member in ${p.id}`);
      assert.ok(!used.has(pp.path), `${s.path}: listed twice`);
      used.add(pp.path);
    }
    assert.deepEqual([...files].filter((f) => !used.has(f)), [], `${p.id}: downloaded files no sample uses`);
  }
});

test('sample packs: known kind, genres and tags, a plain-words name, facts that match the audio, a sane peak', () => {
  const kinds = new Set<string>(SAMPLE_KINDS);
  const genres = new Set<string>(GENRE_IDS);
  const NOT_A_NAME = /\b(kenney|junkala|vcsl|versilian|owlish|subspace|fl studio|fruity|image-line|splice|nintendo|sega|atari|mario|zelda|pac-?man|sfx|wav|ogg)\b/i;
  for (const p of PACKS.filter(isSamplePack)) {
    const audio = GEN[p.id].AUDIO;
    const names = new Set<string>();
    for (const s of p.samples!) {
      const at = `${p.id}: "${s.name}"`;
      assert.ok(kinds.has(s.kind), `${at}: kind ${s.kind}`);
      assert.ok(s.genres.length > 0 && s.genres.every((g) => genres.has(g)), `${at}: genres ${s.genres.join(',')}`);
      assert.ok(s.tags.length > 0 && s.tags.every((t) => /^[a-z0-9][a-z0-9-]*$/.test(t)), `${at}: tags`);
      assert.match(s.name, /^[A-Z][A-Za-z0-9 &'-]*$/, `${at}: a name in plain words`);
      assert.ok(!NOT_A_NAME.test(s.name), `${at}: a source, product or file name is not a sample name`);
      assert.ok(!names.has(s.name.toLowerCase()), `${at}: duplicate name`);
      names.add(s.name.toLowerCase());
      const [rate, ch, frames] = audio[parsePackPath(s.path)!.path];
      assert.equal(s.channels, ch, `${at}: channels`);
      assert.ok(Math.abs(s.lengthSec - frames / rate) < 0.001, `${at}: lengthSec ${s.lengthSec} vs ${frames / rate}`);
      assert.ok(s.lengthSec > 0.005 && s.lengthSec < 900, `${at}: length ${s.lengthSec} s`);
      assert.ok(Number.isFinite(s.peakDb) && s.peakDb <= 3 && s.peakDb >= -40, `${at}: peak ${s.peakDb} dBFS (clipped or far too quiet)`);
      assert.ok((s.bpm === undefined) === (s.bars === undefined), `${at}: bpm and bars go together`);
      if (s.bpm !== undefined) assert.ok(Math.abs((s.bars! * 4 * 60) / s.bpm - s.lengthSec) < 0.01, `${at}: a tempo-synced loop is exactly ${s.bars} bars at ${s.bpm} BPM`);
      if (s.rootNote !== undefined) assert.ok(Number.isInteger(s.rootNote) && s.rootNote >= 0 && s.rootNote <= 127, `${at}: rootNote`);
      if (s.credit !== undefined) assert.ok(s.credit.trim().length > 10, `${at}: credit`);
      assert.match(s.path, /\.(wav|flac|ogg|mp3)$/, `${at}: a format the engine decodes natively (symphonia)`);
    }
  }
});

test('PACK_NAMES (the light copy the renderer uses) matches the catalog exactly', () => {
  assert.deepEqual(PACK_NAMES, Object.fromEntries(PACKS.map((p) => [p.id, p.name])));
});

run('packs-catalog');
