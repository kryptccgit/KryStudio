// Tutorial videos: check resources/guides/videos against the manifest (shared/guides/videos.ts) and fill in each
// video's durationSec from its mp4 (the movie header), which is what makes it show up in the app.
//
//   node scripts/guide-videos.mjs           report: every manifest id, its files, mp4 length, manifest duration
//   node scripts/guide-videos.mjs --write   also write the measured durations into shared/guides/videos.ts
//
// A video needs all three files: <id>.mp4 (H.264/AAC), <id>.vtt (captions), <id>.jpg (poster). Ids with
// missing files are left at (or set back to) durationSec: null, so the app shows them as "Coming soon".
import { closeSync, existsSync, openSync, readFileSync, readSync, fstatSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'resources', 'guides', 'videos');
const manifestPath = path.join(root, 'shared', 'guides', 'videos.ts');
const write = process.argv.includes('--write');

/** Seconds from the mp4's moov/mvhd box, or null when it can't be read. */
function mp4Duration(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const read = (pos, len) => {
      const b = Buffer.alloc(len);
      readSync(fd, b, 0, len, pos);
      return b;
    };
    /** Find a child box of `type` between start and end; returns { body, end } or null. */
    const find = (type, start, end) => {
      let pos = start;
      while (pos + 8 <= end) {
        const h = read(pos, 16);
        let len = h.readUInt32BE(0);
        const t = h.toString('latin1', 4, 8);
        let header = 8;
        if (len === 1) {
          len = Number(h.readBigUInt64BE(8));
          header = 16;
        } else if (len === 0) len = end - pos;
        if (len < header) return null;
        if (t === type) return { body: pos + header, end: pos + len };
        pos += len;
      }
      return null;
    };
    const moov = find('moov', 0, size);
    if (!moov) return null;
    const mvhd = find('mvhd', moov.body, moov.end);
    if (!mvhd) return null;
    const b = read(mvhd.body, 32);
    const v = b.readUInt8(0);
    const timescale = v === 1 ? b.readUInt32BE(20) : b.readUInt32BE(12);
    const duration = v === 1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
    return timescale ? duration / timescale : null;
  } finally {
    closeSync(fd);
  }
}

let src = readFileSync(manifestPath, 'utf8');
const ids = [...src.matchAll(/^\s*id: '([a-z0-9-]+)',$/gm)].map((m) => m[1]);
const known = new Set(ids);
let problems = 0;

for (const id of ids) {
  const has = (ext) => existsSync(path.join(dir, `${id}.${ext}`));
  const files = { mp4: has('mp4'), vtt: has('vtt'), jpg: has('jpg') };
  const missing = Object.entries(files).filter(([, ok]) => !ok).map(([ext]) => ext);
  let secs = null;
  if (files.mp4) {
    try {
      secs = mp4Duration(path.join(dir, `${id}.mp4`));
    } catch (err) {
      console.error(`  ${id}: couldn't read the mp4 (${err.message})`);
    }
  }
  const value = missing.length === 0 && secs ? Math.round(secs) : null;
  const re = new RegExp(`(id: '${id}',[\\s\\S]*?durationSec: )(null|\\d+)`);
  const current = re.exec(src)?.[2] ?? '?';
  const status = missing.length === 3 ? 'not added' : missing.length ? `MISSING ${missing.join(', ')}` : secs ? `${secs.toFixed(1)} s` : 'UNREADABLE mp4';
  if (missing.length && missing.length < 3) problems++;
  console.log(`${id.padEnd(12)} ${status.padEnd(22)} manifest: ${current}${String(value) !== current ? ` → ${value}` : ''}`);
  if (write) src = src.replace(re, `$1${value}`);
}

for (const f of existsSync(dir) ? readdirSync(dir) : []) {
  const stem = f.replace(/\.[^.]+$/, '');
  if (!known.has(stem)) {
    console.log(`${f}: not in the manifest (add an entry to shared/guides/videos.ts, or remove the file)`);
    problems++;
  }
}

if (write) {
  writeFileSync(manifestPath, src);
  console.log(`\nWrote ${path.relative(root, manifestPath)}`);
}
if (problems) process.exitCode = 1;
