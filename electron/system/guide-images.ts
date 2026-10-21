// The Guides' annotated screenshots (resources/guides/images, shared/guides/images.ts)
// served read-only under app://bundle/guide-images/<name>.<webp|png|jpg> by the
// app:// handler (./app-protocol.ts). Same rules as the tutorial videos
// (./guide-videos.ts): only flat file names matching GUIDE_IMAGE_FILE, no
// folders, no other types, never outside the folder. Images are small, so no
// range requests. CORS is open for the dev renderer (http://localhost).

import fsp from 'node:fs/promises';
import path from 'node:path';
import { GUIDE_IMAGE_FILE, GUIDE_IMAGE_TYPES } from '@shared/guides/images';

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
}

/**
 * Answer a request for `name` (the path after guide-images/, already URL-decoded) from `root`.
 * Never throws: problems become 4xx / 5xx responses (the guide shows its own "image missing" note).
 */
export async function guideImageResponse(name: string, root: string, method = 'GET'): Promise<Response> {
  try {
    if (method !== 'GET' && method !== 'HEAD') return text(405, 'method not allowed');
    const m = GUIDE_IMAGE_FILE.exec(name);
    if (!m) return text(404, 'not found');
    const base = path.resolve(root);
    const file = path.resolve(base, name);
    if (path.dirname(file) !== base) return text(403, 'forbidden');
    let data: Buffer;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return text(404, 'not found');
      data = method === 'HEAD' ? Buffer.alloc(0) : await fsp.readFile(file);
      const headers = {
        'Content-Type': GUIDE_IMAGE_TYPES[m[2]],
        'Content-Length': String(st.size),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      };
      return new Response(method === 'HEAD' ? null : new Uint8Array(data), { status: 200, headers });
    } catch {
      return text(404, 'not found');
    }
  } catch (err) {
    return text(500, `error: ${(err as Error)?.message ?? err}`);
  }
}
