// ──────────────────────────────────────────────────────────────────────
// Annotated screenshots for the Guides (pure; no window, no fs). The files
// live flat in resources/guides/images/ as <name>.webp / .png / .jpg, ship
// as electron-builder extraResources (outside the asar) and are served
// read-only from app://bundle/guide-images/<file> (electron/system/
// guide-images.ts). An article shows one with {{image:<file>|<caption>}}
// (src/guides/markup.ts); test/guide-images.test.ts checks that every
// image an article names exists and that every file is used.
// ──────────────────────────────────────────────────────────────────────

import { GUIDE_VIDEO_ORIGIN } from './videos';

/** The path segment the app:// protocol serves the images folder under. */
export const GUIDE_IMAGE_ROUTE = 'guide-images';
/** Files the protocol will serve: <name>.<webp|png|jpg>, nothing else (no folders, no other types). */
export const GUIDE_IMAGE_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.(webp|png|jpg)$/;

export const GUIDE_IMAGE_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
};

export function isGuideImageFile(file: string): boolean {
  return GUIDE_IMAGE_FILE.test(file);
}

/** Where the renderer loads a guide image from (same origin as the packaged renderer). */
export function guideImageUrl(file: string, origin = GUIDE_VIDEO_ORIGIN): string {
  return `${origin}/${GUIDE_IMAGE_ROUTE}/${encodeURIComponent(file)}`;
}
