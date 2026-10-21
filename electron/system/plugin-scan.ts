// ──────────────────────────────────────────────────────────────────────
// Third-party plugin discovery: the standard VST3 / CLAP folders, the
// candidate files in them, and ONE throwaway scanner process per file
// (`krypt-studio-pluginhost.exe --scan <file>`), killed on timeout. A plugin
// that crashes or hangs while being scanned only kills that process
// (research/03 §2.4). No VST2: .dll files in VST2 folders are only counted
// so the Plugin Manager can explain why they don't show up.
// ──────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { PluginDescriptor } from '@shared/plugins/types';

export type PluginFormat = 'vst3' | 'clap';

export interface PluginCandidate {
  path: string;
  format: PluginFormat;
  /** Size + mtime of the binary (bundle: the inner DLL) — the cache key. */
  size: number;
  mtime: number;
}

export type ScanOutcome =
  | { kind: 'ok'; plugins: PluginDescriptor[] }
  | { kind: 'failed'; message: string; plugins: PluginDescriptor[] }
  | { kind: 'crashed'; message: string; plugins: PluginDescriptor[] }
  | { kind: 'timeout'; message: string; plugins: PluginDescriptor[] };

const env = (k: string): string | undefined => process.env[k] || undefined;

/** Standard folders, highest priority first (research/03 §2.1). */
export function standardPluginFolders(): Array<{ path: string; formats: PluginFormat[] }> {
  const out: Array<{ path: string; formats: PluginFormat[] }> = [];
  if (process.platform !== 'win32') return out; // plugin hosting is Windows-only for now (electron/plugins/index.ts)
  const local = env('LOCALAPPDATA');
  const common = env('CommonProgramFiles') ?? env('COMMONPROGRAMFILES') ?? 'C:\\Program Files\\Common Files';
  if (local) out.push({ path: path.join(local, 'Programs', 'Common', 'VST3'), formats: ['vst3'] });
  out.push({ path: path.join(common, 'VST3'), formats: ['vst3'] });
  out.push({ path: path.join(common, 'CLAP'), formats: ['clap'] });
  if (local) out.push({ path: path.join(local, 'Programs', 'Common', 'CLAP'), formats: ['clap'] });
  // The CLAP spec says hosts must honour CLAP_PATH (';'-separated).
  for (const p of (env('CLAP_PATH') ?? '').split(';').map((s) => s.trim()).filter(Boolean)) out.push({ path: p, formats: ['clap'] });
  return out;
}

/** Where VST2 plugins usually live (counted only; VST2 can't be hosted). */
export function vst2Folders(): string[] {
  if (process.platform !== 'win32') return [];
  const pf = env('ProgramFiles') ?? 'C:\\Program Files';
  const common = env('CommonProgramFiles') ?? 'C:\\Program Files\\Common Files';
  return [path.join(pf, 'VSTPlugins'), path.join(pf, 'Steinberg', 'VSTPlugins'), path.join(common, 'VST2'), path.join(common, 'Steinberg', 'VST2')];
}

export async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function statKey(p: string, isDir: boolean): Promise<{ size: number; mtime: number }> {
  try {
    if (isDir) {
      // A bundle: key on the 64-bit binary inside (that's what changes on update).
      const stem = path.basename(p, path.extname(p));
      const bin = path.join(p, 'Contents', 'x86_64-win', `${stem}.vst3`);
      try {
        const s = await fsp.stat(bin);
        return { size: s.size, mtime: Math.trunc(s.mtimeMs) };
      } catch {
        const s = await fsp.stat(p);
        return { size: 0, mtime: Math.trunc(s.mtimeMs) };
      }
    }
    const s = await fsp.stat(p);
    return { size: s.size, mtime: Math.trunc(s.mtimeMs) };
  } catch {
    return { size: 0, mtime: 0 };
  }
}

/** Every .vst3 (file or bundle folder) and .clap under `root` (bounded depth). */
export async function findCandidates(root: string, formats: PluginFormat[], depth = 6): Promise<PluginCandidate[]> {
  const out: PluginCandidate[] = [];
  const walk = async (dir: string, d: number): Promise<void> => {
    if (d < 0) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const ext = path.extname(e.name).toLowerCase();
      const isDir = e.isDirectory();
      if (ext === '.vst3' && formats.includes('vst3')) {
        out.push({ path: p, format: 'vst3', ...(await statKey(p, isDir)) });
      } else if (ext === '.clap' && formats.includes('clap') && e.isFile()) {
        out.push({ path: p, format: 'clap', ...(await statKey(p, false)) });
      } else if (isDir && !e.isSymbolicLink()) {
        await walk(p, d - 1);
      }
    }
  };
  await walk(root, depth);
  return out;
}

/** .dll files in the VST2 folders (depth 3). */
export async function countVst2(folders: string[]): Promise<number> {
  let n = 0;
  const walk = async (dir: string, d: number): Promise<void> => {
    if (d < 0) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.dll')) n++;
      else if (e.isDirectory()) await walk(path.join(dir, e.name), d - 1);
    }
  };
  for (const f of folders) await walk(f, 3);
  return n;
}

/**
 * Run `<hostExe> --scan <file>` and parse its JSON lines (the last complete
 * line wins; a VST3 may first print a moduleinfo.json-only line).
 */
export function runScanner(hostExe: string, file: string, timeoutMs = 30_000): Promise<ScanOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hostExe, ['--scan', file], { cwd: path.dirname(hostExe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ kind: 'failed', message: `Couldn't start the scanner: ${(err as Error).message}`, plugins: [] });
      return;
    }
    let out = '';
    let errTail = '';
    let done = false;
    child.stdout?.on('data', (b: Buffer) => {
      if (out.length < 32 * 1024 * 1024) out += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      errTail = (errTail + b.toString('utf8')).slice(-600);
    });
    const parse = (): { final: any | null; partial: PluginDescriptor[] } => {
      let final: any = null;
      let partial: PluginDescriptor[] = [];
      for (const line of out.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const v = JSON.parse(t);
          if (v && v.partial) partial = Array.isArray(v.plugins) ? v.plugins : [];
          else final = v;
        } catch {
          /* a torn last line from a crash */
        }
      }
      return { final, partial };
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* gone */
      }
      resolve({ kind: 'timeout', message: `Scanning took longer than ${Math.round(timeoutMs / 1000)} s`, plugins: parse().partial });
    }, timeoutMs);
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ kind: 'failed', message: `Couldn't run the scanner: ${err.message}`, plugins: [] });
    });
    child.on('close', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const { final, partial } = parse();
      if (code === 0 && final) {
        if (final.ok) resolve({ kind: 'ok', plugins: Array.isArray(final.plugins) ? final.plugins : [] });
        else resolve({ kind: 'failed', message: String(final.message ?? 'Scan failed'), plugins: partial });
        return;
      }
      const hex = typeof code === 'number' ? `0x${(code >>> 0).toString(16).toUpperCase()}` : String(signal ?? 'unknown');
      const why = errTail.trim().split(/\r?\n/).pop() ?? '';
      resolve({ kind: 'crashed', message: `Crashed while being scanned (exit ${hex})${why ? `: ${why.slice(0, 200)}` : ''}`, plugins: partial });
    });
  });
}
