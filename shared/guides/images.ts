import { GUIDE_VIDEO_ORIGIN } from './videos';

export const GUIDE_IMAGE_ROUTE = 'guide-images';
export const GUIDE_IMAGE_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.(webp|png|jpg)$/;

export const GUIDE_IMAGE_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
};

export function isGuideImageFile(file: string): boolean {
  return GUIDE_IMAGE_FILE.test(file);
}

export function guideImageUrl(file: string, origin = GUIDE_VIDEO_ORIGIN): string {
  return `${origin}/${GUIDE_IMAGE_ROUTE}/${encodeURIComponent(file)}`;
}
