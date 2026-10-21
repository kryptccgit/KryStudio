import type { AutoMixPreset } from './types';
import { resolveGenre, genreInText } from '../sounds/genres';

export const AUTO_MIX_PRESETS: readonly AutoMixPreset[] = [
  {
    id: 'streaming-clean',
    name: 'Streaming Clean',
    description: 'Natural and dynamic at the streaming reference level (-14 LUFS)',
    targetLufs: -14,
    truePeak: -1,
    tone: { sub: 4, low: 6.5, lowMid: -1, mid: 0, highMid: -5, high: -8 },
    punch: 0.45,
    warmth: 0.35,
    brightness: 0.5,
    width: 0.5,
    vocalLevel: 0,
    vocalSpace: 0.35,
    genres: [],
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'A modern, even mix that is loud without being squashed (-11 LUFS)',
    targetLufs: -11,
    truePeak: -1,
    tone: { sub: 4, low: 6.5, lowMid: -1, mid: 0, highMid: -5, high: -8 },
    punch: 0.5,
    warmth: 0.45,
    brightness: 0.5,
    width: 0.6,
    vocalLevel: -0.5,
    vocalSpace: 0.45,
    genres: ['synthwave'],
  },
  {
    id: 'loud-trap',
    name: 'Loud Trap / Drill',
    description: 'Hard-hitting 808s and kick, dry vocals on top (-8 LUFS)',
    targetLufs: -8,
    truePeak: -1,
    tone: { sub: 8, low: 7, lowMid: -2, mid: 0, highMid: -5, high: -8.5 },
    punch: 0.8,
    warmth: 0.4,
    brightness: 0.55,
    width: 0.55,
    vocalLevel: 0.5,
    vocalSpace: 0.25,
    genres: ['trap', 'drill'],
  },
  {
    id: 'club-edm',
    name: 'Club / EDM',
    description: 'Big, bright and wide with a mono low end for the club (-8 LUFS)',
    targetLufs: -8,
    truePeak: -1,
    tone: { sub: 6, low: 6.5, lowMid: -2, mid: 0, highMid: -4, high: -6 },
    punch: 0.75,
    warmth: 0.35,
    brightness: 0.65,
    width: 0.75,
    vocalLevel: -2,
    vocalSpace: 0.55,
    genres: ['edm', 'house', 'deep-house', 'tech-house', 'techno', 'future-bass', 'dubstep', 'dnb'],
  },
  {
    id: 'warm-rnb',
    name: 'Warm R&B',
    description: 'Smooth, warm and silky with a soft top and lush vocals (-11 LUFS)',
    targetLufs: -11,
    truePeak: -1,
    tone: { sub: 4, low: 6.5, lowMid: -0.5, mid: 0, highMid: -5.5, high: -10.5 },
    punch: 0.4,
    warmth: 0.75,
    brightness: 0.35,
    width: 0.6,
    vocalLevel: -0.5,
    vocalSpace: 0.6,
    genres: ['rnb'],
  },
  {
    id: 'lofi',
    name: 'Lo-fi',
    description: 'Dusty, warm and quiet on purpose, the top rolled off (-13 LUFS)',
    targetLufs: -13,
    truePeak: -1,
    tone: { sub: 2.5, low: 7, lowMid: 0.5, mid: 0, highMid: -7, high: -14 },
    punch: 0.3,
    warmth: 0.85,
    brightness: 0.2,
    width: 0.45,
    vocalLevel: -3,
    vocalSpace: 0.5,
    genres: ['lofi'],
  },
  {
    id: 'pop-polish',
    name: 'Pop Polish',
    description: 'Clean, bright radio sound with the vocal in front (-9 LUFS)',
    targetLufs: -9,
    truePeak: -1,
    tone: { sub: 3.5, low: 6.5, lowMid: -1.5, mid: 0, highMid: -5, high: -7.5 },
    punch: 0.6,
    warmth: 0.35,
    brightness: 0.7,
    width: 0.65,
    vocalLevel: 0.5,
    vocalSpace: 0.45,
    genres: ['pop', 'afrobeats', 'reggaeton'],
  },
  {
    id: 'hiphop-punch',
    name: 'Hip-Hop Punch',
    description: 'Breathing drums that crack, warm low end, upfront rap (-9 LUFS)',
    targetLufs: -9,
    truePeak: -1,
    tone: { sub: 4, low: 7, lowMid: -0.5, mid: 0, highMid: -5.5, high: -10 },
    punch: 0.75,
    warmth: 0.6,
    brightness: 0.4,
    width: 0.45,
    vocalLevel: 0.5,
    vocalSpace: 0.25,
    genres: ['boom-bap'],
  },
  {
    id: 'rock-live',
    name: 'Rock / Live',
    description: 'Open, punchy and natural for bands and live takes (-10 LUFS)',
    targetLufs: -10,
    truePeak: -1,
    tone: { sub: 0, low: 5, lowMid: 0, mid: 0, highMid: -3.5, high: -8 },
    punch: 0.65,
    warmth: 0.5,
    brightness: 0.5,
    width: 0.6,
    vocalLevel: -1,
    vocalSpace: 0.4,
    genres: [],
  },
  {
    id: 'podcast-voice',
    name: 'Podcast / Voice',
    description: 'Clear, even speech with music under it (-16 LUFS)',
    targetLufs: -16,
    truePeak: -1,
    tone: { sub: -10, low: 2, lowMid: 0, mid: 0, highMid: -4, high: -10 },
    punch: 0.3,
    warmth: 0.4,
    brightness: 0.5,
    width: 0.3,
    vocalLevel: 10,
    vocalSpace: 0.05,
    genres: [],
  },
  {
    id: 'phonk-slam',
    name: 'Phonk Slam',
    description: 'Saturated, slammed and gritty on purpose (-7 LUFS)',
    targetLufs: -7,
    truePeak: -1,
    tone: { sub: 8, low: 7, lowMid: -0.5, mid: 0, highMid: -5, high: -8 },
    punch: 0.85,
    warmth: 0.7,
    brightness: 0.5,
    width: 0.5,
    vocalLevel: -2,
    vocalSpace: 0.2,
    genres: ['phonk'],
  },
];

export const DEFAULT_PRESET_ID = 'balanced';

export function presetById(id: string | null | undefined): AutoMixPreset | null {
  if (!id) return null;
  const k = id.trim().toLowerCase();
  return AUTO_MIX_PRESETS.find((p) => p.id === k) ?? AUTO_MIX_PRESETS.find((p) => p.name.toLowerCase() === k) ?? null;
}

export function presetForGenre(genre: string | null | undefined): AutoMixPreset | null {
  if (!genre?.trim()) return null;
  const id = resolveGenre(genre) ?? genreInText(genre);
  if (!id) return null;
  return AUTO_MIX_PRESETS.find((p) => (p.genres as string[]).includes(id)) ?? null;
}

export function autoPreset(genre: string | null | undefined, hint?: { lufs?: number | null; subVsMid?: number | null; highVsMid?: number | null } | null): { preset: AutoMixPreset; why: string } {
  const g = presetForGenre(genre);
  if (g) return { preset: g, why: `the project's genre (${String(genre).trim().slice(0, 40)})` };
  const lufs = hint?.lufs ?? null;
  const sub = hint?.subVsMid ?? null;
  const high = hint?.highVsMid ?? null;
  if (lufs !== null && Number.isFinite(lufs) && lufs > -60) {
    if (sub !== null && sub > 9 && lufs > -12) return { preset: presetById('loud-trap')!, why: 'the analysis (a heavy sub and an already loud mix)' };
    if (high !== null && high < -15 && lufs < -14) return { preset: presetById('lofi')!, why: 'the analysis (a quiet mix with a dark top)' };
  }
  return { preset: presetById(DEFAULT_PRESET_ID)!, why: 'no genre is set, so the balanced card' };
}

export const AUTO_LOUDEST_LUFS = -7;

export function autoKeepsLoudness(cardLufs: number, songLufs: number | null | undefined): { lufs: number; note: string } | null {
  if (typeof songLufs !== 'number' || !Number.isFinite(songLufs) || songLufs <= cardLufs + 0.5) return null;
  const lufs = Math.round(Math.min(songLufs, AUTO_LOUDEST_LUFS) * 10) / 10;
  const fmt = (v: number) => (v < 0 ? `−${Math.abs(v).toFixed(1)}` : v.toFixed(1));
  return { lufs, note: `Already loud (${fmt(songLufs)} LUFS, louder than this style's ${fmt(cardLufs)}): Auto keeps it at ${fmt(lufs)} LUFS instead of turning it down. To aim lower (streaming apps turn loud songs down anyway), pick a style yourself.` };
}
