// ZIP members for sound packs (research/14 §2.3): some CC0 sources (Kenney, OpenGameArt) only publish ZIP archives.
// After the archive's own SHA-256 checked out (service.ts), only the catalog's listed members are extracted, each
// streamed through fflate's Inflate (MIT) into a temp file, hashed on the way, and renamed into place only when its
// size and SHA-256 match. Nothing else in the archive is ever written. The central directory is read from the end of
// the file (so data-descriptor entries and ZIP64 archives work) and each member is read straight from its offset, so
// memory stays at one chunk, never the whole archive.
//
// Every failure is an Error whose message is a sentence; a cancel is DownloadCancelled. Node-only.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { Inflate, strFromU8 } from 'fflate';
import { writeFileAtomicWith } from '../system/files';
import { DownloadCancelled } from '../system/download';

/** One entry of the archive's central directory. */
export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** A member to extract: its exact entry name, where it goes and what it must be. */
export interface ZipExtract {
  from: string;
  dest: string;
  sha256: string;
  bytes: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const CHUNK = 1 << 20;
/** A central directory bigger than this isn't a sound pack. */
const MAX_DIRECTORY = 64 * 1024 * 1024;

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 0x100000000;

async function readAt(fh: fsp.FileHandle, pos: number, len: number): Promise<Uint8Array> {
  const buf = new Uint8Array(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (!bytesRead) throw new Error('the archive ends early (it is truncated)');
    got += bytesRead;
  }
  return buf;
}

/** Entry names are UTF-8 when the flag says so; otherwise plain ASCII (any other byte is read as Latin-1). */
function entryName(bytes: Uint8Array, flags: number): string {
  return flags & 0x800 ? strFromU8(bytes) : strFromU8(bytes, true);
}

/** The central directory: entry name → entry (the first of duplicate names wins). */
export async function readZipDirectory(fh: fsp.FileHandle): Promise<Map<string, ZipEntry>> {
  const size = (await fh.stat()).size;
  if (size < 22) throw new Error("it isn't a ZIP archive (too small)");
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let at = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (u32(tail, i) === SIG_EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error("it isn't a ZIP archive (no end-of-directory record)");
  if (u16(tail, at + 4) !== 0 || u16(tail, at + 6) !== 0) throw new Error("it is a multi-part (spanned) ZIP, which Krypt Studio can't read");
  let count = u16(tail, at + 10);
  let dirSize = u32(tail, at + 12);
  let dirOffset = u32(tail, at + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    // ZIP64: the locator sits right before the classic record.
    const locAt = size - tailLen + at - 20;
    if (locAt < 0) throw new Error('its ZIP64 directory locator is missing');
    const loc = await readAt(fh, locAt, 20);
    if (u32(loc, 0) !== SIG_LOC64) throw new Error('its ZIP64 directory locator is missing');
    const rec = await readAt(fh, u64(loc, 8), 56);
    if (u32(rec, 0) !== SIG_EOCD64) throw new Error('its ZIP64 directory record is damaged');
    count = u64(rec, 32);
    dirSize = u64(rec, 40);
    dirOffset = u64(rec, 48);
  }
  if (dirSize > MAX_DIRECTORY || dirOffset + dirSize > size) throw new Error('its directory is damaged');
  const dir = await readAt(fh, dirOffset, dirSize);
  const out = new Map<string, ZipEntry>();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || u32(dir, p) !== SIG_CEN) throw new Error('its directory is damaged');
    const flags = u16(dir, p + 8);
    const method = u16(dir, p + 10);
    let compressedSize = u32(dir, p + 20);
    let usize = u32(dir, p + 24);
    const nameLen = u16(dir, p + 28);
    const extraLen = u16(dir, p + 30);
    const commentLen = u16(dir, p + 32);
    let localOffset = u32(dir, p + 42);
    const name = entryName(dir.subarray(p + 46, p + 46 + nameLen), flags);
    // ZIP64 extra field: the 64-bit values, in order, for the fields that were 0xFFFFFFFF.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = u16(dir, e);
      const len = u16(dir, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        const stop = e + 4 + len;
        if (usize === 0xffffffff && q + 8 <= stop) {
          usize = u64(dir, q);
          q += 8;
        }
        if (compressedSize === 0xffffffff && q + 8 <= stop) {
          compressedSize = u64(dir, q);
          q += 8;
        }
        if (localOffset === 0xffffffff && q + 8 <= stop) localOffset = u64(dir, q);
      }
      e += 4 + len;
    }
    if (!out.has(name)) out.set(name, { name, flags, method, compressedSize, size: usize, localOffset });
    p = extraEnd + commentLen;
  }
  return out;
}

/**
 * Stream one member into `dest` (temp file + rename), checking size and SHA-256 on the way. Throws a sentence on any
 * mismatch or damage (the destination is left untouched), DownloadCancelled when `signal` aborts.
 */
async function extractOne(fh: fsp.FileHandle, entry: ZipEntry, want: ZipExtract, signal?: AbortSignal): Promise<void> {
  if (entry.flags & 0x1) throw new Error(`${want.from} is encrypted`);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${want.from} uses a compression method Krypt Studio can't read (method ${entry.method})`);
  if (entry.size !== want.bytes) throw new Error(`${want.from} has the wrong size in the archive (${entry.size} bytes, expected ${want.bytes})`);
  const head = await readAt(fh, entry.localOffset, 30);
  if (u32(head, 0) !== SIG_LOC) throw new Error(`${want.from}: the archive is damaged (bad local header)`);
  let pos = entry.localOffset + 30 + u16(head, 26) + u16(head, 28);
  const end = pos + entry.compressedSize;

  await writeFileAtomicWith(want.dest, async (out) => {
    const hash = crypto.createHash('sha256');
    let written = 0;
    let pending: Uint8Array[] = [];
    const take = (data: Uint8Array): void => {
      written += data.length;
      // Never write more than the catalog says (a damaged or hostile archive can't fill the disk).
      if (written > want.bytes) throw new Error(`${want.from} is bigger than the catalog says (more than ${want.bytes} bytes)`);
      hash.update(data);
      pending.push(data);
    };
    const inflate = entry.method === 8 ? new Inflate((data) => take(data)) : null;
    if (entry.compressedSize === 0 && inflate) inflate.push(new Uint8Array(0), true);
    while (pos < end) {
      if (signal?.aborted) throw new DownloadCancelled();
      const n = Math.min(CHUNK, end - pos);
      const chunk = await readAt(fh, pos, n);
      pos += n;
      try {
        if (inflate) inflate.push(chunk, pos >= end);
        else take(chunk);
      } catch (err) {
        if (err instanceof Error && /bigger than the catalog/.test(err.message)) throw err;
        throw new Error(`${want.from} is damaged in the archive (${(err as Error)?.message ?? err})`);
      }
      for (const d of pending) await out.write(d);
      pending = [];
    }
    if (signal?.aborted) throw new DownloadCancelled();
    if (written !== want.bytes) throw new Error(`${want.from} has the wrong size (${written} bytes, expected ${want.bytes})`);
    const got = hash.digest('hex');
    if (got !== want.sha256.toLowerCase()) throw new Error(`${want.from} failed verification (SHA-256 mismatch): the archive's contents don't match the catalog`);
  });
}

/**
 * Extract exactly `members` from the ZIP at `zipPath`. Every listed name must be in the archive (checked before
 * anything is written). `done(m)` lets the caller skip members already in place (resume). Unlisted entries are never
 * read. Throws a sentence, or DownloadCancelled.
 */
export async function extractZipMembers(zipPath: string, members: readonly ZipExtract[], opts: { signal?: AbortSignal; done?(m: ZipExtract): Promise<boolean> } = {}): Promise<void> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(zipPath, 'r');
  } catch (err) {
    throw new Error(`couldn't open the archive (${(err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? err})`);
  }
  try {
    const dir = await readZipDirectory(fh);
    const missing = members.filter((m) => !dir.has(m.from));
    if (missing.length) {
      const names = missing.slice(0, 3).map((m) => `"${m.from.slice(0, 120)}"`).join(', ');
      throw new Error(`the archive doesn't contain ${names}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}; it changed on the server`);
    }
    for (const m of members) {
      if (opts.signal?.aborted) throw new DownloadCancelled();
      if (opts.done && (await opts.done(m))) continue;
      await extractOne(fh, dir.get(m.from)!, m, opts.signal);
    }
  } finally {
    await fh.close().catch(() => {});
  }
}
