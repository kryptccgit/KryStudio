// Browser-preview Auto Mix (window.krypt.automix without the desktop app): canned presets, a small keyword reader
// for the live "Understood as" line, and a run that walks through the stages with progress and returns a believable
// before / after. The run makes ONE real history entry (a master-fader nudge in the in-page DocHost), so the A/B
// switch, Keep and Undo can be tried and screenshotted. Master a song returns "no file" (the preview has no dialog).

import type { KryptApi } from '@shared/types';
import { USER, type DocHost } from '@shared/doc/DocHost';
import type { AlbumOutcome, AlbumRequest, AutoMixIntent, AutoMixMeasure, AutoMixOutcome, AutoMixPreset, AutoMixProgress, AutoMixRequest, ReferenceSound } from '@shared/automix/types';
import { referenceSummary, songNameFromPath } from '@shared/automix/reference';
import { albumName } from '@shared/automix/album';

const P = (id: string, name: string, description: string, targetLufs: number, truePeak: number, tone: AutoMixPreset['tone'], k: Partial<AutoMixPreset>, genres: string[]): AutoMixPreset => ({
  id,
  name,
  description,
  targetLufs,
  truePeak,
  tone,
  punch: 0.5,
  warmth: 0.5,
  brightness: 0.5,
  width: 0.5,
  vocalLevel: 1,
  vocalSpace: 0.4,
  genres,
  ...k,
});

const PRESETS: AutoMixPreset[] = [
  P('streaming-clean', 'Streaming Clean', 'Open and dynamic at the level streaming services play at', -14, -1, { sub: -2, low: 0, lowMid: -1, mid: 0, highMid: 0.5, high: 1 }, { punch: 0.4 }, ['pop', 'rnb']),
  P('balanced', 'Balanced', 'A safe all-rounder: clear, full and moderately loud', -11, -1, { sub: 0, low: 1, lowMid: -1, mid: 0, highMid: 0.5, high: 1 }, {}, []),
  P('loud-trap', 'Loud Trap / Drill', 'Heavy 808, crisp hats, vocals on top: loud and punchy', -8, -0.5, { sub: 4, low: 2, lowMid: -2, mid: 0, highMid: 1, high: 2.5 }, { punch: 0.8 }, ['trap', 'drill']),
  P('club-edm', 'Club / EDM', 'Big low end and a wide top for big speakers', -8, -0.5, { sub: 3, low: 2.5, lowMid: -1.5, mid: 0, highMid: 1, high: 2 }, { width: 0.8 }, ['edm', 'house', 'tech-house', 'techno', 'dubstep', 'dnb', 'future-bass']),
  P('warm-rnb', 'Warm R&B', 'Smooth top, round low mids, the vocal close and intimate', -11, -1, { sub: 1, low: 1.5, lowMid: 0.5, mid: 0, highMid: -1, high: -0.5 }, { warmth: 0.85, vocalSpace: 0.6 }, ['rnb']),
  P('lofi', 'Lo-fi', 'Dark, soft and warm: tape-like, nothing sharp', -13, -1.5, { sub: 0, low: 1.5, lowMid: 1, mid: 0, highMid: -2.5, high: -5 }, { warmth: 0.9, brightness: 0.2 }, ['lofi']),
  P('pop-polish', 'Pop Polish', 'Bright, glossy and loud, vocals front and centre', -9, -1, { sub: 0.5, low: 1, lowMid: -1.5, mid: 0, highMid: 1.5, high: 3 }, { brightness: 0.8, vocalLevel: 2 }, ['pop', 'afrobeats', 'reggaeton']),
  P('hiphop-punch', 'Hip-Hop Punch', 'Hard drums and a solid low end, the vocal clear on top', -9, -1, { sub: 2, low: 2, lowMid: -1.5, mid: 0.5, highMid: 1, high: 1 }, { punch: 0.85 }, ['boom-bap']),
  P('rock-live', 'Rock / Live', 'Natural dynamics, mids that bite, a real-room feel', -10, -1, { sub: -1, low: 1, lowMid: 0, mid: 1, highMid: 1, high: 0.5 }, { punch: 0.6 }, []),
  P('podcast-voice', 'Podcast / Voice', 'Clear speech, no rumble, steady level', -16, -1, { sub: -8, low: -3, lowMid: -1, mid: 0.5, highMid: 1.5, high: 0 }, { vocalLevel: 4, vocalSpace: 0.05 }, []),
  P('phonk-slam', 'Phonk Slam', 'Distorted cowbells and 808 slammed right up to the ceiling', -7, -0.3, { sub: 5, low: 3, lowMid: -1, mid: 0.5, highMid: 2, high: 1.5 }, { punch: 0.9, warmth: 0.7 }, ['phonk']),
];

/** A rough English reader, enough for the preview's "Understood as" line. */
function readPrompt(text: string): AutoMixIntent {
  const t = text.toLowerCase();
  const i: AutoMixIntent = { summary: '', source: 'keywords' };
  const said: string[] = [];
  const has = (re: RegExp): boolean => re.test(t);
  if (has(/club|festival|edm/)) (i.presetId = 'club-edm'), said.push('club preset');
  if (has(/spotify|streaming/)) (i.targetLufs = -14), said.push('streaming loud (−14 LUFS)');
  const lufs = /(-|−)?\s*(\d{1,2}(?:\.\d)?)\s*lufs/.exec(t);
  if (lufs) (i.targetLufs = -Math.abs(Number(lufs[2]))), said.push(`${i.targetLufs} LUFS`);
  if (has(/\bloud(er)?\b|slam/)) (i.louder = has(/very|really|super/) ? 2 : 1), said.push('louder');
  if (has(/quiet|soft(er)?\b/)) (i.louder = -1), said.push('quieter');
  if (has(/bright|air|crisp/)) (i.brighter = 1), said.push('brighter');
  if (has(/dark|dull/)) (i.brighter = -1), said.push('darker');
  if (has(/warm/)) (i.warmer = 1), said.push('warmer');
  if (has(/punch/)) (i.punchier = 1), said.push('punchier');
  if (has(/wide|width|stereo/)) (i.wider = 1), said.push('wider');
  if (has(/mono|narrow/)) (i.wider = -1), said.push('narrower');
  if (has(/bass|808|low end/)) (i.bassier = 1), said.push('more bass');
  if (has(/vocals? (on top|up|forward|loud)|on top/)) (i.vocalsForward = 1), said.push('vocals forward');
  if (has(/buried|vocals? (down|back)/)) (i.vocalsForward = -1), said.push('vocals back');
  if (has(/reverb|space|roomy/)) (i.vocalSpace = 1), said.push('more space');
  if (has(/\bdry\b/)) (i.vocalSpace = -1), said.push('drier');
  if (has(/harsh|sibilan|smooth/)) (i.lessHarsh = 1), said.push('less harsh');
  if (has(/clean|natural/)) (i.cleaner = 1), said.push('cleaner');
  if (has(/gritty|aggressive|crushed|dirty/)) (i.cleaner = -1), said.push('grittier');
  i.summary = said.join(', ');
  return i;
}

const measure = (lufs: number, tp: number, lra: number, tone: AutoMixMeasure['tone'], vocal: number | null): AutoMixMeasure => ({ lufs, truePeak: tp, lra, tone, correlation: 0.62, vocalVsBeat: vocal });

export function createMockAutomix(host: DocHost): KryptApi['automix'] {
  const listeners = new Set<(p: AutoMixProgress) => void>();
  let cancelled = false;
  const emit = (p: AutoMixProgress): void => listeners.forEach((cb) => cb(p));
  const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

  const outcome = (req: AutoMixRequest): AutoMixOutcome => {
    const genre = host.project.meta.genre.toLowerCase();
    const preset = (req.preset && req.preset !== 'auto' ? PRESETS.find((p) => p.id === req.preset) : PRESETS.find((p) => p.genres.some((g) => genre.includes(g)))) ?? PRESETS[1];
    const intent = req.prompt ? readPrompt(req.prompt) : null;
    const target = req.targetLufs ?? intent?.targetLufs ?? (intent?.presetId ? PRESETS.find((p) => p.id === intent.presetId)!.targetLufs : preset.targetLufs);
    const loud = req.mode === 'master' || req.mode === 'full';
    const before = measure(-17.8, -3.4, 7.9, { sub: -1.5, low: 3.2, lowMid: 2.4, mid: 0, highMid: -1.8, high: -3.6 }, req.mode === 'master' ? null : -1.2);
    const after = measure(
      loud ? target + 0.2 : -18.6,
      loud ? (req.truePeak ?? preset.truePeak) - 0.2 : -6.1,
      loud ? 5.1 : 7.2,
      { sub: preset.tone.sub * 0.8, low: preset.tone.low + 0.4, lowMid: preset.tone.lowMid + 0.6, mid: 0, highMid: preset.tone.highMid - 0.3, high: preset.tone.high - 0.6 },
      req.mode === 'master' ? null : preset.vocalLevel + 0.6,
    );
    const changes =
      req.mode === 'vocals'
        ? [
            { target: 'Vocals ▸ Krypt EQ', what: 'high-pass at 100 Hz, cut 2.5 dB at 320 Hz (mud), +2 dB presence at 4 kHz' },
            { target: 'Vocals ▸ Krypt De-Esser', what: 'added at 6.8 kHz, about 4 dB of reduction on the "s" sounds' },
            { target: 'Vocals ▸ Krypt Comp', what: 'ratio 3:1, about 5 dB of gain reduction' },
            { target: 'Vocals ▸ Volume', what: '+2.1 dB, to sit 1 dB over the beat' },
            { target: 'Keys ▸ Krypt EQ', what: 'dip 2 dB at 3 kHz to make room for the vocal' },
          ]
        : [
            ...(req.mode !== 'master'
              ? [
                  { target: 'Kick ▸ Volume', what: '−1.5 dB (gain staging)' },
                  { target: '808 ▸ Krypt Comp', what: 'sidechained to the kick: ducks 3 dB under each hit' },
                  { target: 'Keys ▸ Krypt EQ', what: 'high-pass at 180 Hz, cut 2 dB at 400 Hz (mud)' },
                  { target: 'Hat ▸ Krypt EQ', what: 'cut 1.5 dB at 7 kHz (harsh)' },
                ]
              : []),
            ...(loud
              ? [
                  { target: 'Master ▸ Krypt EQ', what: 'tilt toward the target: −1.5 dB at 300 Hz, +1.5 dB shelf at 10 kHz' },
                  { target: 'Master ▸ Krypt Glue', what: '2:1, about 2 dB of glue' },
                  { target: 'Master ▸ Krypt Imager', what: 'mono below 120 Hz, width 115 %' },
                  { target: 'Master ▸ Krypt Limiter', what: `input +${(target + 17.8).toFixed(1)} dB to reach ${target} LUFS, ceiling ${req.truePeak ?? preset.truePeak} dBTP` },
                ]
              : [{ target: 'Master ▸ Volume', what: 'left 6 dB of headroom for mastering' }]),
          ];
    return {
      mode: req.mode,
      preset: { id: preset.id, name: preset.name },
      intent,
      before,
      after,
      changes,
      entryId: null,
      passes: loud ? 3 : 2,
      notes: ['Browser preview: the numbers are made up and only the master fader moved.', ...(target > -8 ? [`Loudness capped near ${target} LUFS: more would distort.`] : [])],
    };
  };

  return {
    presets: async () => {
      await wait(250);
      return PRESETS;
    },
    understand: async (prompt) => {
      await wait(350);
      return { ok: true, data: readPrompt(prompt) };
    },
    run: async (req) => {
      cancelled = false;
      const stages: AutoMixProgress['stage'][] = ['measuring', ...(req.prompt ? (['understanding'] as const) : []), 'planning', 'applying', 'refining'];
      for (let i = 0; i < stages.length; i++) {
        if (cancelled) return { ok: false, message: 'Cancelled' };
        emit({ stage: stages[i], fraction: i / stages.length, message: `Browser preview: ${stages[i]}…` });
        await wait(650);
      }
      if (cancelled) return { ok: false, message: 'Cancelled' };
      const o = outcome(req);
      // One real history entry, so A/B, Keep and Undo work in the preview.
      const master = host.project.mixer.masterId;
      const vol = host.project.mixer.inserts[master]?.volume ?? 1;
      const r = host.exec('mixer.setInsert', { id: master, volume: Math.max(0, Math.min(2, vol * 0.85)) }, { actor: USER, label: `Auto ${req.mode === 'full' ? 'Mix + Master' : req.mode}` });
      if (r.ok) o.entryId = host.getHistory().at(-1)?.id ?? null;
      emit({ stage: 'done', fraction: 1, message: 'Done' });
      return { ok: true, data: o };
    },
    masterFile: async () => ({ ok: false, message: "The browser preview can't open audio files: Master a song works in the desktop app." }),
    analyzeReference: async (path) => {
      await wait(600);
      const tone = { sub: 6, low: 7, lowMid: -1.5, mid: 0, highMid: -2.5, high: -5 };
      const sound: ReferenceSound = { path, name: songNameFromPath(path), lufs: -9.2, truePeak: -0.8, tone, width: 0.27, correlation: 0.55, crestDb: 8.4, durationSec: 201, summary: '', cached: false };
      sound.summary = referenceSummary(sound);
      return { ok: true, message: `Reference "${sound.name}": ${sound.summary} (browser preview: made-up numbers).`, data: sound };
    },
    playReference: async () => ({ ok: false, message: 'The browser preview has no audio engine: the reference plays in the desktop app.' }),
    masterAlbum: async (req: AlbumRequest) => {
      cancelled = false;
      const n = req.paths.length;
      for (let i = 0; i < n * 2; i++) {
        if (cancelled) return { ok: false, message: 'Cancelled: nothing was mastered.' };
        emit({ stage: i < n ? 'measuring' : 'applying', fraction: i / (n * 2), message: `Browser preview: ${i < n ? 'measuring' : 'setting'} "${songNameFromPath(req.paths[i % n])}"…` });
        await wait(350);
      }
      const names = req.paths.map(songNameFromPath);
      const target = req.targetLufs ?? -11;
      const bar = 3840;
      let at = 0;
      const songs = names.map((name, i) => {
        const len = 64 * bar + i * 8 * bar;
        const start = at;
        at += len + 2 * bar;
        const lufs = -16 - (i % 3) * 1.5;
        return {
          name,
          path: req.paths[i],
          trackId: `t${i}`,
          insertId: `ins${i}`,
          startTick: start,
          endTick: start + len,
          bars: `${start / bar + 1}-${(start + len) / bar}`,
          targetLufs: req.keepDynamics === false ? target : target - (i % 3) * 1.5,
          before: measure(lufs, -2.5, 7, { sub: 4, low: 6, lowMid: 0, mid: 0, highMid: -6, high: -10 }, null),
          after: measure(req.keepDynamics === false ? target + 0.2 : target - (i % 3) * 1.5 + 0.2, -1.2, 5.5, { sub: 4.5, low: 6.4, lowMid: -0.8, mid: 0, highMid: -5, high: -8.2 }, null),
          targetTone: { sub: 4, low: 6.5, lowMid: -1, mid: 0, highMid: -5, high: -8 },
          changes: [
            { target: `${name} ▸ Krypt EQ`, what: 'tone: +1.5 dB at 10 kHz, −1 dB at 350 Hz (mud)' },
            { target: `${name} ▸ Krypt Limiter`, what: `input +5 dB to reach ${target} LUFS, ceiling −1.1 dBTP (true peak)` },
          ],
          notes: [],
        };
      });
      const master = host.project.mixer.masterId;
      const vol = host.project.mixer.inserts[master]?.volume ?? 1;
      const r = host.exec('mixer.setInsert', { id: master, volume: Math.max(0, Math.min(2, vol * 0.9)) }, { actor: USER, label: 'Album mastering (preview)' });
      const o: AlbumOutcome = {
        name: albumName(names),
        preset: { id: 'balanced', name: 'Balanced' },
        intent: null,
        reference: null,
        targetLufs: target,
        truePeak: req.truePeak ?? -1,
        keepDynamics: req.keepDynamics !== false,
        curve: { sub: 4, low: 6.5, lowMid: -1, mid: 0, highMid: -5, high: -8 },
        songs,
        entryId: r.ok ? (host.getHistory().at(-1)?.id ?? null) : null,
        passes: 2,
        notes: ['Browser preview: the numbers are made up and only the master fader moved.'],
      };
      emit({ stage: 'done', fraction: 1, message: 'Done' });
      return { ok: true, message: `Mastered ${n} songs (browser preview).`, data: o };
    },
    exportAlbum: async () => ({ ok: false, message: 'The browser preview has no audio engine: Export all works in the desktop app.' }),
    cancel: async () => {
      cancelled = true;
      return { ok: true };
    },
    onProgress: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
