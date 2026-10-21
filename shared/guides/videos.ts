export interface GuideVideo {
  id: string;
  title: string;
  description: string;
  durationSec: number | null;
  article: string;
}

export type ReadyGuideVideo = GuideVideo & { durationSec: number };

export const GUIDE_VIDEO_ROUTE = 'guide-videos';
export const GUIDE_VIDEO_ORIGIN = 'app://bundle';
export const GUIDE_VIDEO_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.(mp4|vtt|jpg)$/;

export const QUICKSTART_VIDEO = 'overview';
export const PLAYBACK_RATES = [1, 1.25, 1.5] as const;
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

export function videoStatus(id: string, list: GuideVideo[] = GUIDE_VIDEOS): 'ready' | 'soon' | 'unknown' {
  const v = guideVideoById(id, list);
  return !v ? 'unknown' : isVideoReady(v) ? 'ready' : 'soon';
}

export function readyVideos(list: GuideVideo[] = GUIDE_VIDEOS): ReadyGuideVideo[] {
  return list.filter(isVideoReady);
}

export function videoUrls(id: string, origin = GUIDE_VIDEO_ORIGIN): { src: string; captions: string; poster: string } {
  const base = `${origin}/${GUIDE_VIDEO_ROUTE}/${encodeURIComponent(id)}`;
  return { src: `${base}.mp4`, captions: `${base}.vtt`, poster: `${base}.jpg` };
}

export function fmtVideoDuration(sec: number | null | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function minutesLabel(sec: number): string {
  return `${Math.max(1, Math.round(sec / 60))}-minute`;
}
