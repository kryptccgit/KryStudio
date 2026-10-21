import type { AlbumOutcome, AlbumRequest, AlbumSong, AlbumExportRequest, AutoMixMeasure } from '@shared/automix/types';
import { AUDIO_FILE_RE } from '@shared/audio/formats';
import { ALBUM_MAX_SONGS, ALBUM_MIN_SONGS, albumAverageTone } from '@shared/automix/album';
import { songNameFromPath } from '@shared/automix/reference';
import { clampLufs, clampTruePeak, clipWords, fmtLufs, fmtNum, fmtTp } from './logic';

export interface AlbumForm {
  songs: string[];
  preset: string;
  prompt: string;
  targetLufs: number | null;
  truePeak: number | null;
  keepDynamics: boolean;
  useAi: boolean;
}

export const DEFAULT_ALBUM_FORM: AlbumForm = { songs: [], preset: 'auto', prompt: '', targetLufs: null, truePeak: null, keepDynamics: true, useAi: true };

export interface AddResult {
  songs: string[];
  added: number;
  duplicates: number;
  notAudio: number;
  overCap: number;
}

const key = (p: string): string => p.trim().replace(/\//g, '\\').toLowerCase();

export function addSongs(list: readonly string[], paths: readonly string[]): AddResult {
  const out = [...list];
  const seen = new Set(out.map(key));
  let added = 0;
  let duplicates = 0;
  let notAudio = 0;
  let overCap = 0;
  for (const raw of paths) {
    const p = String(raw ?? '').trim();
    if (!p) continue;
    if (!AUDIO_FILE_RE.test(p)) {
      notAudio++;
      continue;
    }
    if (seen.has(key(p))) {
      duplicates++;
      continue;
    }
    if (out.length >= ALBUM_MAX_SONGS) {
      overCap++;
      continue;
    }
    out.push(p);
    seen.add(key(p));
    added++;
  }
  return { songs: out, added, duplicates, notAudio, overCap };
}

export function addMessage(r: AddResult): string {
  const parts: string[] = [];
  if (r.duplicates) parts.push(`${r.duplicates} already in the list`);
  if (r.notAudio) parts.push(`${r.notAudio} not audio`);
  if (r.overCap) parts.push(`${r.overCap} over the ${ALBUM_MAX_SONGS}-song limit`);
  return parts.length ? `Skipped ${parts.join(', ')}.` : '';
}

export function moveSong(list: readonly string[], from: number, to: number): string[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const t = Math.max(0, Math.min(out.length - 1, to));
  if (t === from) return out;
  const [x] = out.splice(from, 1);
  out.splice(t, 0, x);
  return out;
}

export function removeSong(list: readonly string[], index: number): string[] {
  return list.filter((_, i) => i !== index);
}

export type AlbumFormAction =
  | { type: 'set'; patch: Partial<Omit<AlbumForm, 'songs'>> }
  | { type: 'setSongs'; songs: string[] }
  | { type: 'pickPreset'; id: string }
  | { type: 'reset' };

export function albumFormReducer(f: AlbumForm, act: AlbumFormAction): AlbumForm {
  switch (act.type) {
    case 'set': {
      const next = { ...f, ...act.patch };
      if (act.patch.targetLufs != null) next.targetLufs = clampLufs(act.patch.targetLufs);
      if (act.patch.truePeak != null) next.truePeak = clampTruePeak(act.patch.truePeak);
      return next;
    }
    case 'setSongs':
      return { ...f, songs: act.songs.slice(0, ALBUM_MAX_SONGS) };
    case 'pickPreset':
      return f.preset === act.id ? f : { ...f, preset: act.id, targetLufs: null, truePeak: null };
    case 'reset':
      return { ...DEFAULT_ALBUM_FORM };
  }
}

export function albumFormError(f: AlbumForm): string | null {
  if (f.songs.length < ALBUM_MIN_SONGS) return f.songs.length ? 'Add at least one more song: an album needs 2 or more' : `Choose your songs first (${ALBUM_MIN_SONGS} to ${ALBUM_MAX_SONGS})`;
  if (f.songs.length > ALBUM_MAX_SONGS) return `At most ${ALBUM_MAX_SONGS} songs: remove ${f.songs.length - ALBUM_MAX_SONGS}`;
  if (f.prompt.length > 500) return 'The prompt is too long: keep it under 500 characters';
  return null;
}

export function buildAlbumRequest(f: AlbumForm, reference?: string | null): AlbumRequest {
  const req: AlbumRequest = { paths: [...f.songs], preset: f.preset || 'auto', keepDynamics: f.keepDynamics, useAi: f.useAi ? 'auto' : 'never' };
  const prompt = f.prompt.trim();
  if (prompt) req.prompt = prompt;
  if (f.targetLufs != null) req.targetLufs = clampLufs(f.targetLufs);
  if (f.truePeak != null) req.truePeak = clampTruePeak(f.truePeak);
  if (reference?.trim()) req.reference = reference.trim();
  return req;
}

export function trackNumber(i: number): string {
  return String(i + 1).padStart(2, '0');
}

export function songLabel(p: string): string {
  return songNameFromPath(p);
}

export interface SongRow {
  index: number;
  name: string;
  before: string;
  after: string;
  aim: string;
  delta: string;
  truePeak: string;
  changes: number;
  warn: boolean;
  why: string;
}

export function songRows(o: Pick<AlbumOutcome, 'songs' | 'truePeak'>): SongRow[] {
  return o.songs.map((s: AlbumSong, i) => {
    const off = Math.abs(s.after.lufs - s.targetLufs) > 0.5;
    const over = s.after.truePeak > o.truePeak + 0.05;
    return {
      index: i,
      name: s.name,
      before: fmtLufs(s.before.lufs),
      after: fmtLufs(s.after.lufs),
      aim: fmtLufs(s.targetLufs),
      delta: `${fmtNum(s.after.lufs - s.before.lufs, true)} LU`,
      truePeak: fmtTp(s.after.truePeak),
      changes: s.changes.length,
      warn: off || over,
      why: over ? `Peak over the ${fmtTp(o.truePeak)} limit (true peak)` : off ? `${fmtNum(s.after.lufs - s.targetLufs, true)} LU from what it aimed at${s.notes.length ? `: ${s.notes[0]}` : ''}` : 'On target',
    };
  });
}

export function albumTones(o: Pick<AlbumOutcome, 'songs'>): { before: AutoMixMeasure['tone']; after: AutoMixMeasure['tone'] } {
  return { before: albumAverageTone(o.songs.map((s) => s.before.tone)), after: albumAverageTone(o.songs.map((s) => s.after.tone)) };
}

export function loudestAfter(o: Pick<AlbumOutcome, 'songs'>): number {
  return o.songs.length ? Math.max(...o.songs.map((s) => s.after.lufs)) : -14;
}

export function albumResultHeadline(o: Pick<AlbumOutcome, 'songs' | 'entryId'>): string {
  const n = o.songs.length;
  if (!n) return 'Done, but no songs came back';
  const before = Math.max(...o.songs.map((s) => s.before.lufs));
  const after = Math.max(...o.songs.map((s) => s.after.lufs));
  const peak = Math.max(...o.songs.map((s) => s.after.truePeak));
  if (!o.entryId) return `Done! Your ${n} songs already met the target, so nothing needed changing`;
  return `Done! Your ${n} songs are mastered as one album (loudest ${fmtNum(before)} → ${fmtNum(after)} LUFS, ${clipWords(peak)})`;
}

export function albumResultWhere(o: Pick<AlbumOutcome, 'name'>): string {
  return `They opened in a new tab called "${o.name}", one after another. Your original files are untouched. LUFS (loudness): closer to 0 is louder.`;
}

export function albumHeadline(o: Pick<AlbumOutcome, 'targetLufs' | 'truePeak' | 'keepDynamics' | 'songs' | 'passes'>): string {
  return `${o.songs.length} songs · ${fmtLufs(o.targetLufs)} ${o.keepDynamics ? "for the loudest, keeping the album's dynamics" : 'for every song'} · peak limit ${fmtTp(o.truePeak)} · ${o.passes} pass${o.passes === 1 ? '' : 'es'}`;
}

export type AlbumExportFormat = AlbumExportRequest['format'];

export const EXPORT_FORMATS: ReadonlyArray<{ value: AlbumExportFormat; label: string; title: string }> = [
  { value: 'wav24', label: '24-bit WAV', title: 'Lossless, for distributors and archiving (the default)' },
  { value: 'wav16', label: '16-bit WAV', title: 'CD quality' },
  { value: 'mp3', label: 'MP3 320', title: "MP3 at 320 kbps through Windows' own encoder" },
];

export function buildExportRequest(o: Pick<AlbumOutcome, 'songs'>, format: AlbumExportFormat): AlbumExportRequest {
  return { folder: '', format, ...(format === 'mp3' ? { mp3Kbps: 320 } : {}), songs: o.songs.map((s) => ({ name: s.name, startTick: s.startTick, endTick: s.endTick })) };
}
