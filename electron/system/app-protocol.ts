import { net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isFile } from './files';
import { guideVideoResponse } from './guide-videos';
import { guideImageResponse } from './guide-images';
import { GUIDE_VIDEO_ROUTE } from '@shared/guides/videos';
import { GUIDE_IMAGE_ROUTE } from '@shared/guides/images';

export const APP_SCHEME = 'app';
export const APP_HOST = 'bundle';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true, corsEnabled: true },
    },
  ]);
}

export function serveAppScheme(root: string, videosRoot?: string, imagesRoot?: string): void {
  const base = path.resolve(root);
  const videoPrefix = `${GUIDE_VIDEO_ROUTE}/`;
  const imagePrefix = `${GUIDE_IMAGE_ROUTE}/`;
  protocol.handle(APP_SCHEME, async (req) => {
    try {
      const url = new URL(req.url);
      if (url.host !== APP_HOST) return new Response('not found', { status: 404 });
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!rel) rel = 'index.html';
      if (rel.startsWith(videoPrefix)) {
        if (!videosRoot) return new Response('not found', { status: 404 });
        return guideVideoResponse(rel.slice(videoPrefix.length), videosRoot, req.method, req.headers.get('range'));
      }
      if (rel.startsWith(imagePrefix)) {
        if (!imagesRoot) return new Response('not found', { status: 404 });
        return guideImageResponse(rel.slice(imagePrefix.length), imagesRoot, req.method);
      }
      const file = path.resolve(base, rel);
      if (file !== base && !file.startsWith(base + path.sep)) return new Response('forbidden', { status: 403 });
      if (!isFile(file)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('error', { status: 500 });
    }
  });
}
