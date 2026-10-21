// What the Guides do with a tutorial video (pure; tested in test/guide-videos.test.ts). The manifest and the stream
// URLs are in shared/guides/videos.ts; the player is ./VideoPlayer.tsx.

import { GUIDE_VIDEOS, guideVideoById, isVideoReady, type GuideVideo, type ReadyGuideVideo } from '@shared/guides/videos';

/** The article holding the Videos index ({{videos}}): Help ▸ Video tutorials opens it. */
export const VIDEOS_ARTICLE = 'videos';

/**
 * How a {{video:<id>}} block renders: a player for a shipped video, nothing for one that isn't shipped yet (never a
 * broken player), a visible problem note for an id that isn't in the manifest (test/guides.test.ts keeps those out
 * of the real articles).
 */
export type VideoBlockView = { kind: 'player'; video: ReadyGuideVideo } | { kind: 'hidden'; video: GuideVideo } | { kind: 'unknown'; id: string };

export function videoBlockView(id: string, list: GuideVideo[] = GUIDE_VIDEOS): VideoBlockView {
  const v = guideVideoById(id, list);
  if (!v) return { kind: 'unknown', id };
  return isVideoReady(v) ? { kind: 'player', video: v } : { kind: 'hidden', video: v };
}

/** The Videos index: shipped videos first (manifest order), then the "Coming soon" ones. */
export function videoIndex(list: GuideVideo[] = GUIDE_VIDEOS): { ready: ReadyGuideVideo[]; soon: GuideVideo[] } {
  return { ready: list.filter(isVideoReady), soon: list.filter((v) => !isVideoReady(v)) };
}

/** A sentence for a <video> that failed (MediaError.code), so the player never fails silently. */
export function mediaErrorMessage(code: number | null | undefined): string {
  switch (code) {
    case 1:
      return 'Playback was stopped before the video loaded.';
    case 2:
      return "The video couldn't be read from the app's files.";
    case 3:
      return "The video file is damaged and couldn't be decoded.";
    case 4:
      return "The video file is missing or isn't a format this app can play.";
    default:
      return "The video couldn't be played.";
  }
}
