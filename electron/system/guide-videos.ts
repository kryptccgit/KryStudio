import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { GUIDE_VIDEO_FILE } from '@shared/guides/videos';

const TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  vtt: 'text/vtt; charset=utf-8',
  jpg: 'image/jpeg',
};

export type ByteRange = { start: number; end: number };

export function parseRange(header: string | null | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
}

export async function guideVideoResponse(name: string, root: string, method = 'GET', rangeHeader: string | null = null): Promise<Response> {
  try {
    if (method !== 'GET' && method !== 'HEAD') return text(405, 'method not allowed');
    const m = GUIDE_VIDEO_FILE.exec(name);
    if (!m) return text(404, 'not found');
    const base = path.resolve(root);
    const file = path.resolve(base, name);
    if (path.dirname(file) !== base) return text(403, 'forbidden');
    let size: number;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return text(404, 'not found');
      size = st.size;
    } catch {
      return text(404, 'not found');
    }
    const headers: Record<string, string> = {
      'Content-Type': TYPES[m[2]],
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    };
    const range = parseRange(rangeHeader, size);
    if (range === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const length = size === 0 ? 0 : end - start + 1;
    headers['Content-Length'] = String(length);
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    const status = range ? 206 : 200;
    if (method === 'HEAD' || length === 0) return new Response(null, { status, headers });
    const stream = fs.createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers });
  } catch (err) {
    return text(500, `error: ${(err as Error)?.message ?? err}`);
  }
}
