import { GUIDE_VIDEOS, guideVideoById, isVideoReady, type GuideVideo, type ReadyGuideVideo } from '@shared/guides/videos';

export const VIDEOS_ARTICLE = 'videos';

export type VideoBlockView = { kind: 'player'; video: ReadyGuideVideo } | { kind: 'hidden'; video: GuideVideo } | { kind: 'unknown'; id: string };

export function videoBlockView(id: string, list: GuideVideo[] = GUIDE_VIDEOS): VideoBlockView {
  const v = guideVideoById(id, list);
  if (!v) return { kind: 'unknown', id };
  return isVideoReady(v) ? { kind: 'player', video: v } : { kind: 'hidden', video: v };
}

export function videoIndex(list: GuideVideo[] = GUIDE_VIDEOS): { ready: ReadyGuideVideo[]; soon: GuideVideo[] } {
  return { ready: list.filter(isVideoReady), soon: list.filter((v) => !isVideoReady(v)) };
}

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
