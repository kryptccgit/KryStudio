// Dependency inventory shared by scripts/gen-notices.mjs and
// scripts/license-check.mjs. Two sources of truth:
//
//   npm   package-lock.json + node_modules: production dependencies, plus the
//         devDependencies the app source actually imports (they get bundled
//         into the renderer / main by Vite), plus the Electron runtime.
//   cargo `cargo metadata --filter-platform x86_64-pc-windows-msvc`: every
//         crate reachable from the engine workspace members, classified as
//         runtime (linked into a shipped exe), build-time (build scripts and
//         proc-macros) or dev-only (tests/benches; never shipped).
//
// Pure Node, no dependencies, so it runs right after `npm ci` in CI.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..', '..');
export const WIN_TARGET = 'x86_64-pc-windows-msvc';
/** Every target a release ships for (.github/workflows/release.yml): notices and the licence gate cover their union. */
export const SHIP_TARGETS = [WIN_TARGET, 'aarch64-apple-darwin', 'x86_64-unknown-linux-gnu'];

// ── SPDX ──────────────────────────────────────────────────────────────

/** Licences we accept without review (research/05 §10). */
export const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-1-Clause',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'ISC',
  'Zlib',
  'Unlicense',
  'CC0-1.0',
  'BSL-1.0',
  'MPL-2.0', // file-level copyleft; used unmodified, flagged in the notices
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'BlueOak-1.0.0',
  'Python-2.0',
  'OFL-1.1',
]);

/** Copyleft or source-available licences that are never accepted without an explicit approval. */
export const DENIED = /^(AGPL|GPL|LGPL|SSPL|EUPL|OSL|RPL|CPAL|Sleepycat|BUSL|Elastic|CC-BY-NC|CC-BY-SA|Commons-Clause)/i;

/** Preference when a package offers a choice (lower = preferred). */
const PREFERENCE = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'ISC', 'Zlib', '0BSD', 'MIT-0', 'Unlicense', 'CC0-1.0', 'BSL-1.0', 'BSD-1-Clause', 'Unicode-3.0', 'Unicode-DFS-2016', 'BlueOak-1.0.0', 'Python-2.0', 'MPL-2.0'];

function tokenize(expr) {
  return String(expr)
    .replace(/\//g, ' OR ') // legacy "MIT/Apache-2.0"
    .replace(/[()]/g, (m) => ` ${m} `)
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Parse an SPDX expression into disjunctive normal form: an array of
 * alternatives, each an array of licence ids that must ALL be honoured.
 * "WITH <exception>" is folded into the licence id (e.g. "Apache-2.0 WITH LLVM-exception").
 */
export function spdxDnf(expr) {
  const toks = tokenize(expr);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  function primary() {
    const t = next();
    if (t === undefined) throw new Error(`unexpected end of licence expression "${expr}"`);
    if (t === '(') {
      const v = orExpr();
      if (next() !== ')') throw new Error(`unbalanced parentheses in "${expr}"`);
      return v;
    }
    let id = t;
    if (peek() && peek().toUpperCase() === 'WITH') {
      next();
      id = `${id} WITH ${next()}`;
    }
    return [[id]];
  }
  function andExpr() {
    let left = primary();
    while (peek() && peek().toUpperCase() === 'AND') {
      next();
      const right = primary();
      const out = [];
      for (const a of left) for (const b of right) out.push([...a, ...b]);
      left = out;
    }
    return left;
  }
  function orExpr() {
    let left = andExpr();
    while (peek() && peek().toUpperCase() === 'OR') {
      next();
      left = [...left, ...andExpr()];
    }
    return left;
  }
  const out = orExpr();
  if (i !== toks.length) throw new Error(`could not parse licence expression "${expr}"`);
  return out;
}

const baseId = (id) => id.replace(/\s+WITH\s+.*$/i, '').replace(/\+$/, '');
const isAllowedId = (id) => ALLOWED.has(baseId(id)) || /^Apache-2\.0 WITH LLVM-exception$/i.test(id);

/**
 * Evaluate a licence expression against the allowlist.
 * → { ok, chosen: string[] | null, denied: string[], unknown: string[] }
 */
export function evaluateLicense(expr) {
  if (!expr || /^(UNLICENSED|NONE|NOASSERTION|UNKNOWN)$/i.test(String(expr).trim())) return { ok: false, chosen: null, denied: [], unknown: [String(expr || 'none')] };
  let dnf;
  try {
    dnf = spdxDnf(expr);
  } catch (e) {
    return { ok: false, chosen: null, denied: [], unknown: [`${expr} (${e.message})`] };
  }
  const score = (alt) => alt.reduce((s, id) => s + (PREFERENCE.indexOf(baseId(id)) + 1 || 99), 0);
  const okAlts = dnf.filter((alt) => alt.every(isAllowedId)).sort((a, b) => score(a) - score(b));
  if (okAlts.length) return { ok: true, chosen: okAlts[0], denied: [], unknown: [] };
  const ids = [...new Set(dnf.flat())];
  return { ok: false, chosen: null, denied: ids.filter((id) => DENIED.test(id)), unknown: ids.filter((id) => !DENIED.test(id) && !isAllowedId(id)) };
}

// ── Licence files on disk ─────────────────────────────────────────────

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense|notice|copyright|ofl)([-._].*)?$/i;

/** Licence-ish files in a package directory (top level only), sorted. */
export function licenseFiles(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => LICENSE_FILE.test(n) && !/\.(rs|js|ts|mjs|cjs|json|html|py|sh|toml|yml|yaml)$/i.test(n))
    .filter((n) => {
      try {
        return statSync(path.join(dir, n)).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b))
    .map((n) => ({ name: n, text: readFileSync(path.join(dir, n), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '').trim() }));
}

/** Classify a licence text by its content. */
export function classifyText(text) {
  if (/Apache License\s*\n?\s*Version 2\.0/i.test(text) && /TERMS AND CONDITIONS FOR USE/i.test(text)) return 'Apache-2.0';
  if (/Mozilla Public License,?\s*(Version|v\.)\s*2\.0/i.test(text) && /1\.\s*Definitions/i.test(text)) return 'MPL-2.0';
  if (/This is free and unencumbered software released into the public domain/i.test(text)) return 'Unlicense';
  if (/Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/zlib License|This software is provided 'as-is'/i.test(text)) return 'Zlib';
  if (/Redistribution and use in source and binary forms/i.test(text)) return 'BSD';
  if (/Permission to use, copy, modify, and\/or distribute this software/i.test(text)) return 'ISC';
  if (/UNICODE LICENSE|Unicode, Inc\./i.test(text)) return 'Unicode';
  if (/SIL OPEN FONT LICENSE/i.test(text)) return 'OFL-1.1';
  if (/^\s*NOTICE|^notice/i.test(text)) return 'NOTICE';
  return 'other';
}

// ── npm ───────────────────────────────────────────────────────────────

/** Packages that ship as a tool output, not as code: list them, don't walk their deps. */
const LEAF_ROOTS = new Set(['electron', 'tailwindcss']);

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function repoUrl(pj) {
  let r = pj.repository;
  if (r && typeof r === 'object') r = r.url;
  if (typeof r !== 'string' || !r) return pj.homepage || '';
  r = r.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
  if (/^github:/.test(r)) r = `https://github.com/${r.slice(7)}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) r = `https://github.com/${r}`;
  return r;
}

function npmLicense(pj, lockEntry) {
  if (lockEntry?.license) return lockEntry.license;
  if (typeof pj.license === 'string') return pj.license;
  if (pj.license && typeof pj.license === 'object' && pj.license.type) return pj.license.type;
  if (Array.isArray(pj.licenses)) return pj.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
  return '';
}

/** Bare module specifiers imported anywhere under the given folders. */
function importedPackages(dirs) {
  const out = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"./][^'"]*)['"]/g;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p);
      } else if (/\.(m?[jt]sx?|css)$/.test(e.name)) {
        const text = readFileSync(p, 'utf8');
        for (const m of text.matchAll(re)) {
          const spec = m[1];
          if (spec.startsWith('node:') || spec.startsWith('@shared')) continue;
          const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          out.add(name);
        }
      }
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return out;
}

/**
 * npm packages that end up in the installed app.
 * → [{ name, version, license, repository, dir, reason }]
 */
export function npmShipped() {
  const pkg = readJson(path.join(root, 'package.json'));
  const lock = readJson(path.join(root, 'package-lock.json'));
  const entries = lock.packages ?? {};
  const prod = Object.keys(pkg.dependencies ?? {});
  const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
  const imported = [...importedPackages(['src', 'shared', 'electron'])].filter((n) => dev.has(n) && !n.startsWith('@types/') && !LEAF_ROOTS.has(n));
  const extra = ['electron', ...(existsSync(path.join(root, 'tailwind.config.js')) ? ['tailwindcss'] : [])];

  const resolve = (fromKey, name) => {
    let base = fromKey;
    for (;;) {
      const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (entries[key]) return key;
      if (!base) return null;
      const idx = base.lastIndexOf('/node_modules/');
      base = idx === -1 ? '' : base.slice(0, idx);
    }
  };

  const seen = new Map();
  const visit = (key, reason) => {
    if (!key || seen.has(key)) return;
    const e = entries[key];
    if (!e || e.link) return;
    seen.set(key, reason);
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (LEAF_ROOTS.has(name)) return;
    const deps = { ...(e.dependencies ?? {}), ...(e.optionalDependencies ?? {}), ...(e.peerDependencies ?? {}) };
    for (const d of Object.keys(deps)) visit(resolve(key, d), reason);
  };
  for (const n of prod) visit(resolve('', n), 'production dependency');
  for (const n of imported) visit(resolve('', n), 'bundled into the app by Vite');
  for (const n of extra) visit(resolve('', n), n === 'electron' ? 'application runtime' : 'CSS generated at build time');

  const out = [];
  for (const [key, reason] of seen) {
    const dir = path.join(root, key);
    if (!existsSync(path.join(dir, 'package.json'))) continue; // optional dep not installed on this platform
    const pj = readJson(path.join(dir, 'package.json'));
    out.push({ name: pj.name, version: pj.version, license: npmLicense(pj, entries[key]), repository: repoUrl(pj), dir, reason });
  }
  // One row per name@version (the same package can be installed at several paths).
  const uniq = new Map();
  for (const p of out) if (!uniq.has(`${p.name}@${p.version}`)) uniq.set(`${p.name}@${p.version}`, p);
  return [...uniq.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Every package in the lockfile (dev included) with its declared licence: for the dev-tool warning pass. */
export function npmAll() {
  const lock = readJson(path.join(root, 'package-lock.json'));
  const out = [];
  for (const [key, e] of Object.entries(lock.packages ?? {})) {
    if (!key || e.link) continue;
    const name = e.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    let license = e.license ?? '';
    if (!license) {
      try {
        license = npmLicense(readJson(path.join(root, key, 'package.json')), null);
      } catch {
        /* not installed */
      }
    }
    out.push({ name, version: e.version, license, dev: !!e.dev, optional: !!e.optional });
  }
  return out;
}

// ── cargo ─────────────────────────────────────────────────────────────

export function cargoMetadata() {
  const manifest = path.join(root, 'engine', 'Cargo.toml');
  const base = ['metadata', '--format-version', '1', '--manifest-path', manifest, ...SHIP_TARGETS.flatMap((t) => ['--filter-platform', t]), '--locked'];
  const attempts = process.env.CI ? [base] : [[...base, '--offline'], base];
  let last = null;
  for (const args of attempts) {
    const r = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    if (r.error) throw new Error(r.error.code === 'ENOENT' ? "'cargo' was not found. Install the Rust toolchain (https://rustup.rs)." : r.error.message);
    if (r.status === 0) return JSON.parse(r.stdout);
    last = r.stderr?.trim();
  }
  throw new Error(`cargo metadata failed:\n${last}`);
}

/**
 * Every third-party crate the engine workspace pulls in for Windows, macOS or Linux.
 * → { members: [{name, version}], crates: [{ name, version, license, repository, dir, use: 'runtime'|'build'|'dev', usedBy: string[] }] }
 */
export function cargoCrates(meta = cargoMetadata()) {
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const members = new Set(meta.workspace_members);
  const isProcMacro = (id) => pkgs.get(id)?.targets?.some((t) => t.kind.includes('proc-macro'));
  const rank = { runtime: 0, build: 1, dev: 2 };
  const use = new Map(); // id → 'runtime' | 'build' | 'dev'
  const usedBy = new Map(); // id → Set(member names) that need it to build (dev deps excluded)

  for (const mid of members) {
    const name = pkgs.get(mid).name;
    const seen = new Set();
    const stack = [mid];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      if (id !== mid) {
        const by = usedBy.get(id) ?? new Set();
        by.add(name);
        usedBy.set(id, by);
      }
      for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some((k) => k.kind !== 'dev')) stack.push(dep.pkg);
    }
  }

  const walk = (id, mode) => {
    const prev = use.get(id);
    if (prev !== undefined && rank[prev] <= rank[mode]) return;
    use.set(id, mode);
    const node = nodes.get(id);
    if (!node) return;
    for (const dep of node.deps) {
      const kinds = dep.dep_kinds.map((k) => k.kind);
      let childMode = null;
      for (const k of kinds) {
        let m;
        if (k === 'dev') m = members.has(id) ? 'dev' : null;
        else if (k === 'build') m = mode === 'dev' ? 'dev' : 'build';
        else m = mode === 'runtime' && isProcMacro(dep.pkg) ? 'build' : mode;
        if (m && (childMode === null || rank[m] < rank[childMode])) childMode = m;
      }
      if (childMode) walk(dep.pkg, childMode);
    }
  };
  for (const id of members) walk(id, 'runtime');

  const crates = [];
  for (const [id, mode] of use) {
    if (members.has(id)) continue;
    const p = pkgs.get(id);
    crates.push({
      name: p.name,
      version: p.version,
      license: p.license ?? (p.license_file ? `see ${p.license_file}` : ''),
      repository: p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`,
      dir: path.dirname(p.manifest_path),
      use: mode,
      usedBy: [...(usedBy.get(id) ?? [])].sort(),
    });
  }
  crates.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return { members: [...members].map((id) => ({ name: pkgs.get(id).name, version: pkgs.get(id).version, dir: path.dirname(pkgs.get(id).manifest_path) })), crates };
}
