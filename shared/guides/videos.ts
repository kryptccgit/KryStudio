// ──────────────────────────────────────────────────────────────────────
// Tutorial videos bundled with the app (pure data + helpers; no window, no
// fs). The files live in resources/guides/videos/ as <id>.mp4 (H.264/AAC),
// <id>.vtt (captions) and <id>.jpg (poster), ship as electron-builder
// extraResources (outside the asar) and stream from
// app://bundle/guide-videos/<file> (electron/system/guide-videos.ts, with
// range requests so seeking works).
//
// A video is READY when `durationSec` is set. Until then it never renders a
// player: articles skip its {{video:<id>}} block and the Videos index shows
// it as "Coming soon". To add a recording: copy the three files in, then
// `node scripts/guide-videos.mjs --write` fills durationSec from the mp4
// (test/guide-videos.test.ts checks the files and the manifest agree).
// ──────────────────────────────────────────────────────────────────────

export interface GuideVideo {
  /** File stem: resources/guides/videos/<id>.mp4 / .vtt / .jpg */
  id: string;
  title: string;
  /** One line under the title on the cards. */
  description: string;
  /** Length in whole seconds; null = not recorded / not shipped yet (no player, "Coming soon"). */
  durationSec: number | null;
  /** The guide article the video belongs to (src/guides/articles.ts ids). */
  article: string;
}

export type ReadyGuideVideo = GuideVideo & { durationSec: number };

/** The path segment the app:// protocol serves the videos folder under. */
export const GUIDE_VIDEO_ROUTE = 'guide-videos';
/** Same origin as the packaged renderer (CSP 'self'); in dev the protocol still answers, with CORS headers. */
export const GUIDE_VIDEO_ORIGIN = 'app://bundle';
/** Files the protocol will serve: <id>.<ext>, nothing else (no folders, no other types). */
export const GUIDE_VIDEO_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.(mp4|vtt|jpg)$/;

/** The video Home offers new users ("Watch the N-minute overview"). */
export const QUICKSTART_VIDEO = 'overview';
export const PLAYBACK_RATES = [1, 1.25, 1.5] as const;
/** Required by the narration voice's licence: shown in the Videos index and on About. */
export const VIDEO_CREDIT = 'Tutorial narration voice: ElevenLabs.';

export const GUIDE_VIDEOS: GuideVideo[] = [
  {
    id: 'overview',
    title: 'Start here: the Krypt Studio overview',
    description: 'The keys and windows, connecting an AI agent, a whole song made with AI, then the guides and audio tools.',
    durationSec: 183,
    article: 'getting-started',
  },
  {
    id: 'quickstart',
    title: 'Quickstart: your first beat',
    description: 'Program a pattern, play it, paint it into the song, Auto Mix it and export.',
    durationSec: 55,
    article: 'getting-started',
  },
  {
    id: 'piano-roll',
    title: 'The Piano Roll',
    description: 'Draw and edit notes, chords and scales, and quantize them.',
    durationSec: 53,
    article: 'piano-roll',
  },
  {
    id: 'sounds',
    title: 'Sounds & the Browser',
    description: 'Find sounds and presets, load them onto channels and save your own.',
    durationSec: 48,
    article: 'sounds-presets',
  },
  {
    id: 'mixer',
    title: 'The Mixer',
    description: 'Inserts, effect slots, routing and sidechain.',
    durationSec: 42,
    article: 'mixer',
  },
  {
    id: 'arrange',
    title: 'Arranging a song',
    description: 'Turn your loops into a whole song on the Playlist.',
    durationSec: 46,
    article: 'playlist',
  },
  {
    id: 'session',
    title: 'The Session view',
    description: 'Launch clips and scenes live, then record the jam into the song.',
    durationSec: 47,
    article: 'session-view',
  },
  {
    id: 'racks',
    title: 'Racks and macros',
    description: 'Layer sounds, build a drum rack and run effects in parallel.',
    durationSec: 53,
    article: 'racks',
  },
  {
    id: 'ai-agents',
    title: 'AI agents',
    description: 'Connect an agent, ask in plain words, and undo anything it did.',
    durationSec: 43,
    article: 'ai-agents',
  },
  {
    id: 'audio-tools',
    title: 'Audio tools',
    description: 'Tempo and key, stems, audio to notes and vocal tuning, all on your PC.',
    durationSec: 35,
    article: 'audio-tools',
  },
  {
    id: 'mashup',
    title: 'Auto Mashup',
    description: 'Two songs into one mashup, on one tempo and key.',
    durationSec: 44,
    article: 'auto-mashup',
  },
  {
    id: 'automix',
    title: 'Auto Mix & Master',
    description: 'One button for the vocals, the mix or the master, with an honest before and after.',
    durationSec: 59,
    article: 'auto-mix',
  },
  {
    id: 'voice',
    title: 'Krypt Voice',
    description: 'Type it and a voice says it in your song, or sings it on your melody.',
    durationSec: 56,
    article: 'krypt-voice',
  },
];

export function guideVideoById(id: string | null | undefined, list: GuideVideo[] = GUIDE_VIDEOS): GuideVideo | undefined {
  return id ? list.find((v) => v.id === id) : undefined;
}

export function isVideoReady(v: GuideVideo | undefined | null): v is ReadyGuideVideo {
  return !!v && typeof v.durationSec === 'number' && Number.isFinite(v.durationSec) && v.durationSec > 0;
}

/** 'ready' = has a player; 'soon' = in the manifest but not shipped yet; 'unknown' = not in the manifest. */
export function videoStatus(id: string, list: GuideVideo[] = GUIDE_VIDEOS): 'ready' | 'soon' | 'unknown' {
  const v = guideVideoById(id, list);
  return !v ? 'unknown' : isVideoReady(v) ? 'ready' : 'soon';
}

export function readyVideos(list: GuideVideo[] = GUIDE_VIDEOS): ReadyGuideVideo[] {
  return list.filter(isVideoReady);
}

/** Stream URLs of a video's three files. */
export function videoUrls(id: string, origin = GUIDE_VIDEO_ORIGIN): { src: string; captions: string; poster: string } {
  const base = `${origin}/${GUIDE_VIDEO_ROUTE}/${encodeURIComponent(id)}`;
  return { src: `${base}.mp4`, captions: `${base}.vtt`, poster: `${base}.jpg` };
}

/** 56 → "0:56", 754 → "12:34". Unknown → "". */
export function fmtVideoDuration(sec: number | null | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "1-minute", "3-minute" for a "Watch the N-minute overview" label (rounded, at least 1). */
export function minutesLabel(sec: number): string {
  return `${Math.max(1, Math.round(sec / 60))}-minute`;
}
