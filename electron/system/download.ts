import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?(received: number, total: number): void;
  expectedBytes?: number;
  stallMs?: number;
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
}

export class DownloadCancelled extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'DownloadCancelled';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 80);
  }
}

export function checkDownloadUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`"${url.slice(0, 120)}" is not a valid download address`);
  }
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) return;
  throw new Error(`Refusing to download over ${u.protocol.replace(':', '')}: model files are only fetched over HTTPS (${u.host})`);
}

export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
  checkDownloadUrl(url);
  if (opts.signal?.aborted) throw new DownloadCancelled();
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const ctrl = new AbortController();
  let stalled = false;
  const onAbort = (): void => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const stallMs = opts.stallMs ?? 60_000;
  let stallTimer: NodeJS.Timeout | null = null;
  const arm = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, stallMs);
  };

  const hash = crypto.createHash('sha256');
  let received = 0;
  let out: fs.WriteStream | null = null;
  try {
    arm();
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'KryptStudio-ModelManager' } });
    } catch (err) {
      if (opts.signal?.aborted) throw new DownloadCancelled();
      if (stalled) throw new Error(`${hostOf(url)} didn't respond for ${Math.round(stallMs / 1000)} s`);
      throw new Error(`Couldn't reach ${hostOf(url)}: ${(err as Error)?.message ?? err}. Check your internet connection.`);
    }
    if (!res.ok || !res.body) {
      throw new Error(`Download failed: ${hostOf(url)} answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    }
    const lenHeader = Number(res.headers.get('content-length'));
    const total = Number.isFinite(lenHeader) && lenHeader > 0 ? lenHeader : opts.expectedBytes ?? 0;
    opts.onProgress?.(0, total);

    out = fs.createWriteStream(dest);
    const ws = out;
    const writeErr = new Promise<never>((_, reject) => ws.once('error', reject));
    writeErr.catch(() => {});
    const body = Readable.fromWeb(res.body as unknown as NodeWebStream<Uint8Array>);
    try {
      for await (const chunk of body as AsyncIterable<Buffer>) {
        arm();
        hash.update(chunk);
        received += chunk.length;
        if (!ws.write(chunk)) await Promise.race([new Promise<void>((r) => ws.once('drain', () => r())), writeErr]);
        opts.onProgress?.(received, Math.max(total, received));
      }
    } catch (err) {
      if (opts.signal?.aborted) throw new DownloadCancelled();
      if (stalled) throw new Error(`The download from ${hostOf(url)} stalled (no data for ${Math.round(stallMs / 1000)} s)`);
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOSPC') throw new Error(`The disk is full; couldn't write ${path.basename(dest)}`);
      throw new Error(`The download from ${hostOf(url)} was interrupted: ${(err as Error)?.message ?? err}`);
    }
    await Promise.race([new Promise<void>((r) => ws.end(r)), writeErr]);
    out = null;
    if (lenHeader > 0 && !res.headers.get('content-encoding') && received < lenHeader) {
      throw new Error(`The download from ${hostOf(url)} ended early (${received} of ${lenHeader} bytes)`);
    }
    return { bytes: received, sha256: hash.digest('hex') };
  } catch (err) {
    if (out) out.destroy();
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw err;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const rs = fs.createReadStream(file);
  for await (const chunk of rs as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export interface FileStat {
  size: number;
  mtimeMs: number;
}

export async function statFile(p: string): Promise<FileStat | null> {
  try {
    const s = await fsp.stat(p);
    return s.isFile() ? { size: s.size, mtimeMs: Math.trunc(s.mtimeMs) } : null;
  } catch {
    return null;
  }
}

export function statFileSync(p: string): FileStat | null {
  try {
    const s = fs.statSync(p);
    return s.isFile() ? { size: s.size, mtimeMs: Math.trunc(s.mtimeMs) } : null;
  } catch {
    return null;
  }
}

export async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

export async function removeDir(p: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rm(p, { recursive: true, force: true });
      return;
    } catch (err) {
      last = err;
      await sleep(60 * (i + 1));
    }
  }
  throw last;
}

export async function renameDir(from: string, to: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      await sleep(60 * (i + 1));
    }
  }
  throw last;
}

export async function copyInto(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
}

export async function makeDir(p: string): Promise<string> {
  await fsp.mkdir(p, { recursive: true });
  return p;
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function shadowCopySync(src: string, dst: string, siblings?: RegExp, siblingDirs: string[] = []): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  if (!siblings) return;
  for (const dir of [path.dirname(src), ...siblingDirs]) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!siblings.test(name)) continue;
      const from = path.join(dir, name);
      const to = path.join(path.dirname(dst), name);
      try {
        if (fs.statSync(from).isFile() && !fs.existsSync(to)) fs.copyFileSync(from, to);
      } catch {
      }
    }
  }
}

export async function pruneDirs(dir: string, keep: number): Promise<void> {
  try {
    const names = await fsp.readdir(dir);
    const stats = (
      await Promise.all(
        names.map(async (n) => {
          try {
            const s = await fsp.stat(path.join(dir, n));
            return s.isDirectory() ? { n, t: s.mtimeMs } : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter((x): x is { n: string; t: number } => !!x);
    stats.sort((a, b) => b.t - a.t);
    for (const s of stats.slice(keep)) await fsp.rm(path.join(dir, s.n), { recursive: true, force: true }).catch(() => {});
  } catch {
  }
}
