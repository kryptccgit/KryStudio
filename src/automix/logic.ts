// ──────────────────────────────────────────────────────────────────────
// Auto Mix / Auto Master (research/20), the pure part of the dialog: the
// form and its reducer, form → AutoMixRequest / MasterFileRequest, the
// scope → bar range, the "Auto" preset guess, the effective loudness
// target, the prompt-intent chips, the tone-curve geometry (cards and the
// before / after / target overlay), the before / after rows, the honest
// A/B loudness note, the history-entry state for A/B, the progress stages
// and the failure messages, plus the reference song (research/23 §1): its
// state, the "Matching" line, the closeness line and the matched-loudness
// gap. No React, no window: test/automix-ui.test.ts.
// ──────────────────────────────────────────────────────────────────────

import type {
  AutoMixChange,
  AutoMixIntent,
  AutoMixMeasure,
  AutoMixMode,
  AutoMixOutcome,
  AutoMixPreset,
  AutoMixProgress,
  AutoMixRequest,
  AutoMixStage,
  MasterFileRequest,
  ReferenceMatch,
  ReferenceSound,
} from '@shared/automix/types';
import { GENRES, genreKey, type GenreId } from '@shared/sounds/genres';
import { REF_LUFS_RANGE, REF_TRUE_PEAK, closenessLine, isLimitedSource } from '@shared/automix/reference';

/** Where the result lands: the open project, or an audio file mastered in a new project tab (Home ▸ Audio Tools). */
export type AutoMixTarget = 'project' | 'file';

// ── Modes ─────────────────────────────────────────────────────────────

export const MODES: ReadonlyArray<{ id: AutoMixMode; label: string; body: string }> = [
  { id: 'vocals', label: 'Vocals', body: 'The vocal channels only: clean-up EQ, de-ess, compression, level against the beat, reverb and delay, and room for them in the beat.' },
  { id: 'mix', label: 'Mix', body: 'Every insert: gain staging, EQ and compression per part, bus glue, bass under the kick, and space for the vocals.' },
  { id: 'master', label: 'Master', body: 'The Master only: tone toward the target curve, glue, width with a mono low end, then loudness to the target and a true-peak ceiling.' },
  { id: 'full', label: 'Mix + Master', body: 'Mix first, then master: the whole song from the inserts to the final loudness.' },
];

export const MODE_LABEL: Record<AutoMixMode, string> = { vocals: 'Vocals', mix: 'Mix', master: 'Master', full: 'Mix + Master' };

/** Modes that touch the vocals (and so use the vocal inserts). */
export function modeUsesVocals(mode: AutoMixMode): boolean {
  return mode !== 'master';
}

/** Modes that set the final loudness (the target LUFS and true-peak controls only mean something there). */
export function modeSetsLoudness(mode: AutoMixMode): boolean {
  return mode === 'master' || mode === 'full';
}

// ── The form ──────────────────────────────────────────────────────────

/** loudest = the default range (the whole song, or its loudest 32 bars when it's long); song = all of it; bars = a range. */
export type Scope = 'loudest' | 'song' | 'bars';

export interface AutoMixForm {
  mode: AutoMixMode;
  /** 'auto' or a preset id. */
  preset: string;
  prompt: string;
  /** null = the preset's (or the prompt's) value. */
  targetLufs: number | null;
  truePeak: number | null;
  keepUserFx: boolean;
  scope: Scope;
  /** 1-based, inclusive (scope 'bars'). */
  barsFrom: number;
  barsTo: number;
  /** Inserts / channels treated as vocals (null = detected). */
  vocalInserts: string[] | null;
  /** What the vocal pick is called in the dialog ("Lead Vox"). */
  vocalLabel: string | null;
  /** Let the connected AI read the prompt (else the built-in keywords). */
  useAi: boolean;
}

export const LUFS_MIN = -20;
export const LUFS_MAX = -6;
export const TP_MIN = -3;
export const TP_MAX = -0.1;
export const BAR_MAX = 999;
/** The target shown before the presets load, and for Auto when nothing better is known. */
export const DEFAULT_LUFS = -11;
export const DEFAULT_TP = -1;

export const DEFAULT_FORM: AutoMixForm = {
  mode: 'full',
  preset: 'auto',
  prompt: '',
  targetLufs: null,
  truePeak: null,
  keepUserFx: true,
  scope: 'loudest',
  barsFrom: 1,
  barsTo: 16,
  vocalInserts: null,
  vocalLabel: null,
  useAi: true,
};

export type FormAction =
  | { type: 'set'; patch: Partial<Omit<AutoMixForm, 'vocalInserts' | 'vocalLabel'>> }
  | { type: 'setMode'; mode: AutoMixMode }
  /** A new preset brings its own loudness: overrides are dropped. */
  | { type: 'pickPreset'; id: string }
  | { type: 'setVocals'; inserts: string[] | null; label: string | null }
  | { type: 'reset' };

const roundTo = (v: number, step: number): number => Math.round(v / step) * step;

export function clampLufs(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_LUFS;
  return Math.max(LUFS_MIN, Math.min(LUFS_MAX, roundTo(v, 0.5)));
}

export function clampTruePeak(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_TP;
  return Math.max(TP_MIN, Math.min(TP_MAX, Math.round(v * 10) / 10));
}

export function clampBar(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(BAR_MAX, Math.round(v)));
}

export function formReducer(f: AutoMixForm, act: FormAction): AutoMixForm {
  switch (act.type) {
    case 'set': {
      const next = { ...f, ...act.patch };
      if (act.patch.targetLufs != null) next.targetLufs = clampLufs(act.patch.targetLufs);
      if (act.patch.truePeak != null) next.truePeak = clampTruePeak(act.patch.truePeak);
      if (act.patch.barsFrom != null) next.barsFrom = clampBar(act.patch.barsFrom);
      if (act.patch.barsTo != null) next.barsTo = clampBar(act.patch.barsTo);
      return next;
    }
    case 'setMode':
      return { ...f, mode: act.mode };
    case 'pickPreset':
      return f.preset === act.id ? f : { ...f, preset: act.id, targetLufs: null, truePeak: null };
    case 'setVocals':
      return { ...f, vocalInserts: act.inserts && act.inserts.length ? [...act.inserts] : null, vocalLabel: act.inserts && act.inserts.length ? act.label : null };
    case 'reset':
      return { ...DEFAULT_FORM };
  }
}

/** Why Run can't start (null = it can). */
export function formError(f: AutoMixForm): string | null {
  if (f.scope === 'bars' && f.barsTo < f.barsFrom) return 'The last bar must be after the first one';
  if (f.prompt.length > 500) return 'The prompt is too long: keep it under 500 characters';
  return null;
}

/** "9-16" (inclusive, 1-based) for the scope, or undefined for the default range. */
export function scopeBars(f: Pick<AutoMixForm, 'scope' | 'barsFrom' | 'barsTo'>, songBars: number | null): string | undefined {
  if (f.scope === 'bars') return `${clampBar(Math.min(f.barsFrom, f.barsTo))}-${clampBar(Math.max(f.barsFrom, f.barsTo))}`;
  if (f.scope === 'song' && songBars && songBars > 0) return `1-${Math.min(BAR_MAX, Math.ceil(songBars))}`;
  return undefined;
}

/** `reference`: the reference song's path (used by master / full only). */
export function buildRequest(f: AutoMixForm, songBars: number | null, reference?: string | null): AutoMixRequest {
  const req: AutoMixRequest = { mode: f.mode, preset: f.preset || 'auto', keepUserFx: f.keepUserFx, useAi: f.useAi ? 'auto' : 'never' };
  if (reference?.trim() && modeSetsLoudness(f.mode)) req.reference = reference.trim();
  const prompt = f.prompt.trim();
  if (prompt) req.prompt = prompt;
  if (f.targetLufs != null && modeSetsLoudness(f.mode)) req.targetLufs = clampLufs(f.targetLufs);
  if (f.truePeak != null && modeSetsLoudness(f.mode)) req.truePeak = clampTruePeak(f.truePeak);
  const bars = scopeBars(f, songBars);
  if (bars) req.bars = bars;
  if (f.vocalInserts?.length && modeUsesVocals(f.mode)) req.vocalInserts = [...f.vocalInserts];
  return req;
}

/**
 * Master a song: master the song the user chose in step ① (`path`, picked in the renderer; '' would make main open
 * a file dialog, which the dialog no longer does) with the form's preset / prompt / targets.
 */
export function buildMasterFileRequest(f: AutoMixForm, path: string, reference?: string | null): MasterFileRequest {
  const req: MasterFileRequest = { path: path.trim(), preset: f.preset || 'auto' };
  if (reference?.trim()) req.reference = reference.trim();
  const prompt = f.prompt.trim();
  if (prompt) req.prompt = prompt;
  if (f.targetLufs != null) req.targetLufs = clampLufs(f.targetLufs);
  if (f.truePeak != null) req.truePeak = clampTruePeak(f.truePeak);
  return req;
}

/** Song length in bars from the playlist's last clip end (null = an empty playlist). */
export function songBars(p: { playlist: { clips: Record<string, { start: number; length: number }> }; transport: { timeSig: { num: number; den: number } } }, ppq = 960): number | null {
  let end = 0;
  for (const c of Object.values(p.playlist.clips)) end = Math.max(end, c.start + c.length);
  const bar = ppq * (4 / Math.max(1, p.transport.timeSig.den)) * Math.max(1, p.transport.timeSig.num);
  return end > 0 && bar > 0 ? Math.ceil(end / bar) : null;
}

// ── Presets and the target ────────────────────────────────────────────

/** The project genre (free text, "Trap", "uk drill") → a genre id, through names and aliases. */
export function genreIdOf(text: string | null | undefined): GenreId | null {
  const k = genreKey(text ?? '');
  if (!k) return null;
  for (const g of GENRES) if (genreKey(g.id) === k || genreKey(g.name) === k || g.aliases.some((a) => genreKey(a) === k)) return g.id;
  for (const g of GENRES) if (k.includes(genreKey(g.id)) || k.includes(genreKey(g.name))) return g.id;
  return null;
}

/**
 * What "Auto" will most likely pick, for the card and the target slider: the first preset made for the project's
 * genre, else Balanced, else the first one. (The real pick also uses the analysis; the dialog says so.)
 */
export function autoPresetGuess(presets: readonly AutoMixPreset[], genre: string | null | undefined): AutoMixPreset | null {
  if (!presets.length) return null;
  const id = genreIdOf(genre);
  const hit = id ? presets.find((p) => p.genres.includes(id)) : undefined;
  return hit ?? presets.find((p) => /balanced/i.test(p.id) || /balanced/i.test(p.name)) ?? presets[0];
}

export function presetById(presets: readonly AutoMixPreset[], id: string): AutoMixPreset | null {
  return presets.find((p) => p.id === id) ?? null;
}

export interface EffectiveTarget {
  lufs: number;
  truePeak: number;
  /** Where the loudness comes from, for the hint under the slider. */
  from: 'you' | 'prompt' | 'reference' | 'preset' | 'auto' | 'default';
}

/** A reference's loudness as a target: clamped to the range a reference may set, on the slider's 0.5 steps. */
export function referenceLufs(lufs: number): number {
  return clampLufs(Math.max(REF_LUFS_RANGE.min, Math.min(REF_LUFS_RANGE.max, lufs)));
}

/**
 * The loudness the run aims at: your slider, else the prompt's ("-9 LUFS", "club"), else the reference song's
 * (clamped), else the preset's (Auto = its guess). With a reference the ceiling is −1 dBTP unless you set one.
 */
export function effectiveTarget(
  f: Pick<AutoMixForm, 'preset' | 'targetLufs' | 'truePeak'>,
  presets: readonly AutoMixPreset[],
  intent: AutoMixIntent | null,
  genre?: string | null,
  reference?: Pick<ReferenceSound, 'lufs'> | null,
): EffectiveTarget {
  const picked = f.preset === 'auto' ? autoPresetGuess(presets, genre) : presetById(presets, f.preset);
  const promptPreset = intent?.presetId ? presetById(presets, intent.presetId) : null;
  const base = promptPreset ?? picked;
  const truePeak = f.truePeak ?? (reference ? REF_TRUE_PEAK : (base?.truePeak ?? DEFAULT_TP));
  if (f.targetLufs != null) return { lufs: f.targetLufs, truePeak, from: 'you' };
  if (intent?.targetLufs != null && Number.isFinite(intent.targetLufs)) return { lufs: clampLufs(intent.targetLufs), truePeak, from: 'prompt' };
  if (reference && Number.isFinite(reference.lufs)) return { lufs: referenceLufs(reference.lufs + (intent?.louder ?? 0)), truePeak, from: 'reference' };
  if (promptPreset) return { lufs: promptPreset.targetLufs, truePeak, from: 'prompt' };
  if (picked) return { lufs: picked.targetLufs, truePeak, from: f.preset === 'auto' ? 'auto' : 'preset' };
  return { lufs: DEFAULT_LUFS, truePeak, from: 'default' };
}

export function targetHint(t: EffectiveTarget): string {
  switch (t.from) {
    case 'you':
      return 'Your setting';
    case 'prompt':
      return 'From your prompt';
    case 'reference':
      return 'From the reference song (−20 to −6 LUFS; the distortion guard can stop it sooner)';
    case 'preset':
      return "The preset's target";
    case 'auto':
      return "Auto's likely pick: the final one also listens to the song";
    default:
      return 'A safe middle: streaming services turn louder songs down';
  }
}

/** What the loudness is good for ("Spotify / YouTube" …), for the slider readout. */
export function loudnessUse(lufs: number): string {
  if (lufs <= -15) return 'Podcasts, voice, quiet streaming';
  if (lufs <= -12.5) return 'Streaming at its own level';
  if (lufs <= -10) return 'Balanced: streaming and playlists';
  if (lufs <= -8.5) return 'Loud: hip-hop, pop, release masters';
  return 'Very loud: club and trap, less punch';
}

// ── Prompt ────────────────────────────────────────────────────────────

export const EXAMPLE_PROMPTS: readonly string[] = ['vocals on top, not harsh', 'loud for the club', 'warm and wide'];

type IntentKey = 'louder' | 'brighter' | 'warmer' | 'punchier' | 'wider' | 'bassier' | 'vocalsForward' | 'vocalSpace' | 'lessHarsh' | 'cleaner';

const INTENT_WORDS: ReadonlyArray<[IntentKey, string, string]> = [
  ['louder', 'Louder', 'Quieter'],
  ['brighter', 'Brighter', 'Darker'],
  ['warmer', 'Warmer', 'Cooler'],
  ['punchier', 'Punchier', 'Softer'],
  ['wider', 'Wider', 'Narrower'],
  ['bassier', 'More bass', 'Less bass'],
  ['vocalsForward', 'Vocals up', 'Vocals down'],
  ['vocalSpace', 'More space', 'Drier'],
  ['lessHarsh', 'Less harsh', 'More bite'],
  ['cleaner', 'Cleaner', 'Grittier'],
];

export interface IntentChip {
  key: string;
  label: string;
  /** 1 or 2 (how strongly). */
  strength: number;
}

/** The understood intent as chips ("Louder ++", "Vocals up", "Preset: Club / EDM", "-8 LUFS"). */
export function intentChips(intent: AutoMixIntent | null, presets: readonly AutoMixPreset[] = []): IntentChip[] {
  if (!intent) return [];
  const out: IntentChip[] = [];
  if (intent.presetId) out.push({ key: 'preset', label: `Preset: ${presetById(presets, intent.presetId)?.name ?? intent.presetId}`, strength: 1 });
  if (intent.targetLufs != null && Number.isFinite(intent.targetLufs)) out.push({ key: 'lufs', label: fmtLufs(intent.targetLufs), strength: 1 });
  for (const [k, up, down] of INTENT_WORDS) {
    const v = intent[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.round(v) === 0) continue;
    const s = Math.min(2, Math.abs(Math.round(v)));
    out.push({ key: k, label: v > 0 ? up : down, strength: s });
  }
  return out;
}

export function sourceLabel(source: AutoMixIntent['source']): string {
  return source === 'ai' ? 'AI' : 'Keywords';
}

/** The line under the prompt ("Understood as: louder, brighter vocals"). */
export function understoodLine(intent: AutoMixIntent | null): string {
  if (!intent) return '';
  const s = intent.summary.trim();
  return s ? `Understood as: ${s}` : 'Understood as: no change from the preset';
}

/** Prompts this short aren't worth asking about. */
export function promptWorthUnderstanding(text: string): boolean {
  return text.trim().length >= 3;
}

// ── Tone curve geometry ───────────────────────────────────────────────

export type ToneKey = keyof AutoMixMeasure['tone'];

export const TONE_BANDS: ReadonlyArray<{ key: ToneKey; label: string; hz: number }> = [
  { key: 'sub', label: 'Sub', hz: 45 },
  { key: 'low', label: 'Low', hz: 110 },
  { key: 'lowMid', label: 'Low mid', hz: 320 },
  { key: 'mid', label: 'Mid', hz: 1000 },
  { key: 'highMid', label: 'High mid', hz: 3500 },
  { key: 'high', label: 'High', hz: 10000 },
];

const TONE_LO_HZ = 30;
const TONE_HI_HZ = 15000;

/** Log-frequency x for the curve (30 Hz .. 15 kHz across the width). */
export function toneX(hz: number, width: number): number {
  const f = Math.max(TONE_LO_HZ, Math.min(TONE_HI_HZ, hz));
  return (Math.log(f / TONE_LO_HZ) / Math.log(TONE_HI_HZ / TONE_LO_HZ)) * width;
}

/** dB → y: +range at the top, -range at the bottom, 0 dB in the middle (clamped). */
export function toneY(db: number, height: number, range: number): number {
  const d = Number.isFinite(db) ? Math.max(-range, Math.min(range, db)) : 0;
  return height / 2 - (d / range) * (height / 2);
}

/** The dB range that fits every curve (6, 12 or 18 dB). */
export function toneRange(...tones: Array<AutoMixMeasure['tone'] | null | undefined>): number {
  let m = 0;
  for (const t of tones) if (t) for (const b of TONE_BANDS) if (Number.isFinite(t[b.key])) m = Math.max(m, Math.abs(t[b.key]));
  return m <= 5.5 ? 6 : m <= 11 ? 12 : 18;
}

export function tonePoints(tone: AutoMixMeasure['tone'], width: number, height: number, range: number, pad = 0): Array<{ x: number; y: number }> {
  return TONE_BANDS.map((b) => ({ x: pad + toneX(b.hz, width - 2 * pad), y: toneY(tone[b.key], height, range) }));
}

const r1 = (v: number): string => String(Math.round(v * 10) / 10);

/** A smooth SVG path through the points (Catmull-Rom as cubic Béziers). */
export function smoothPath(pts: ReadonlyArray<{ x: number; y: number }>): string {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${r1(pts[0].x)} ${r1(pts[0].y)}`;
  let d = `M${r1(pts[0].x)} ${r1(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${r1(c1.x)} ${r1(c1.y)} ${r1(c2.x)} ${r1(c2.y)} ${r1(p2.x)} ${r1(p2.y)}`;
  }
  return d;
}

export function tonePath(tone: AutoMixMeasure['tone'], width: number, height: number, range: number, pad = 0): string {
  return smoothPath(tonePoints(tone, width, height, range, pad));
}

/** How far a tone is from the target, in dB on average over the bands (lower = closer). */
export function toneDistance(a: AutoMixMeasure['tone'], target: AutoMixMeasure['tone']): number {
  let sum = 0;
  for (const b of TONE_BANDS) sum += Math.abs((a[b.key] ?? 0) - (target[b.key] ?? 0));
  return sum / TONE_BANDS.length;
}

// ── Numbers ───────────────────────────────────────────────────────────

const MINUS = '−';

/** One decimal with a real minus sign ("−9.2"); "+" only with `signed`. */
export function fmtNum(v: number, signed = false, digits = 1): string {
  if (!Number.isFinite(v)) return '–';
  const r = Number(v.toFixed(digits));
  const s = Math.abs(r).toFixed(digits);
  if (r < 0) return `${MINUS}${s}`;
  return signed && r > 0 ? `+${s}` : s;
}

export function fmtLufs(v: number): string {
  return `${fmtNum(v)} LUFS`;
}

export function fmtTp(v: number): string {
  return `${fmtNum(v)} dBTP`;
}

export function fmtVocal(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return 'No vocal found';
  return `${fmtNum(v, true)} dB`;
}

export interface MeasureRow {
  key: 'lufs' | 'tp' | 'vocal' | 'lra';
  label: string;
  before: string;
  after: string;
  /** "+7.1 LU" ("" when there's nothing to compare). */
  delta: string;
  hint: string;
}

/** The before / after table (vocal vs beat only when vocals were found either time). */
export function measureRows(before: AutoMixMeasure, after: AutoMixMeasure): MeasureRow[] {
  const d = (a: number, b: number, unit: string): string => (Number.isFinite(a) && Number.isFinite(b) ? `${fmtNum(b - a, true)} ${unit}` : '');
  const rows: MeasureRow[] = [
    { key: 'lufs', label: 'Loudness (LUFS)', before: fmtLufs(before.lufs), after: fmtLufs(after.lufs), delta: d(before.lufs, after.lufs, 'LU'), hint: 'Integrated loudness: how loud the whole song feels' },
    { key: 'tp', label: 'Peak (no clipping below 0)', before: fmtTp(before.truePeak), after: fmtTp(after.truePeak), delta: d(before.truePeak, after.truePeak, 'dB'), hint: 'The highest peak, including the ones between samples (true peak). Below 0 means no clipping on any player' },
  ];
  if (before.vocalVsBeat != null || after.vocalVsBeat != null)
    rows.push({
      key: 'vocal',
      label: 'Vocal vs beat',
      before: fmtVocal(before.vocalVsBeat),
      after: fmtVocal(after.vocalVsBeat),
      delta: before.vocalVsBeat != null && after.vocalVsBeat != null ? d(before.vocalVsBeat, after.vocalVsBeat, 'dB') : '',
      hint: 'How much louder the vocal is than everything else (+ = on top)',
    });
  rows.push({ key: 'lra', label: 'Loudness range', before: `${fmtNum(before.lra)} LU`, after: `${fmtNum(after.lra)} LU`, delta: d(before.lra, after.lra, 'LU'), hint: 'How much the loudness moves between quiet and loud parts' });
  return rows;
}

/** How much louder the result is (dB; + = after is louder). */
export function loudnessGap(o: Pick<AutoMixOutcome, 'before' | 'after'>): number {
  const g = o.after.lufs - o.before.lufs;
  return Number.isFinite(g) ? g : 0;
}

/** The honest A/B line: louder always sounds better, so say how far to turn down for a fair listen. */
export function abNote(gap: number): string {
  const g = Math.abs(gap);
  if (g < 0.75) return 'Before and After are about as loud, so this is a fair comparison.';
  const db = fmtNum(g, false, g >= 3 ? 0 : 1);
  return gap > 0
    ? `After is ${db} dB louder, and louder always sounds better at first. For a fair comparison, turn your speakers down about ${db} dB while you listen to After.`
    : `After is ${db} dB quieter, and quieter always sounds worse at first. For a fair comparison, turn your speakers up about ${db} dB while you listen to After.`;
}

// ── A/B: the history entry ───────────────────────────────────────────

export type EntryState = 'live' | 'undone' | 'missing';

/** Whether the Auto Mix step is applied: the entry by id, or the entries of a group with that id (all undone = undone). */
export function entryState(history: ReadonlyArray<{ id: string; undone: boolean; groupId: string | null }>, entryId: string | null): EntryState {
  if (!entryId) return 'missing';
  const e = history.find((h) => h.id === entryId);
  if (e) return e.undone ? 'undone' : 'live';
  const group = history.filter((h) => h.groupId === entryId);
  if (!group.length) return 'missing';
  return group.every((h) => h.undone) ? 'undone' : 'live';
}

// ── The result ────────────────────────────────────────────────────────

/** Changes grouped by where they happened ("Vocals ▸ Krypt EQ" → "Vocals"), in first-seen order. */
export function groupChanges(changes: readonly AutoMixChange[]): Array<{ where: string; items: Array<{ device: string; what: string }> }> {
  const out: Array<{ where: string; items: Array<{ device: string; what: string }> }> = [];
  for (const c of changes) {
    const [where, ...rest] = c.target.split('▸').map((s) => s.trim());
    const key = where || c.target;
    let g = out.find((x) => x.where === key);
    if (!g) out.push((g = { where: key, items: [] }));
    g.items.push({ device: rest.join(' ▸ '), what: c.what });
  }
  return out;
}

export function doneToast(o: Pick<AutoMixOutcome, 'mode' | 'before' | 'after' | 'changes'>): string {
  const n = o.changes.length;
  return `Auto ${MODE_LABEL[o.mode]} done: ${fmtLufs(o.before.lufs)} → ${fmtLufs(o.after.lufs)}, ${n} change${n === 1 ? '' : 's'}`;
}

// ── The reference song ────────────────────────────────────────────────

export interface ReferenceState {
  status: 'idle' | 'busy' | 'ready' | 'failed';
  /** The picked file (kept while it's read, and after a failure so the row can say which). */
  path: string | null;
  sound: ReferenceSound | null;
  error: string | null;
}

export const NO_REFERENCE: ReferenceState = { status: 'idle', path: null, sound: null, error: null };

/** The path a run should use: a picked reference that didn't fail to read (the run reads a busy one itself). */
export function referencePath(r: ReferenceState): string | null {
  return r.path && r.status !== 'failed' ? r.path : null;
}

/** "Lose Yourself.mp3" from a path. */
export function fileLabel(p: string | null | undefined): string {
  return String(p ?? '').split(/[\\/]/).pop() || 'the song';
}

/** The preset grid's heading: "Preset" or "Matching: <reference>". */
export function presetHeading(r: ReferenceState): string {
  return r.status === 'ready' && r.sound ? `Matching: ${r.sound.name}` : 'Preset';
}

/** Under the preset grid when a reference is set. */
export const MATCHING_NOTE = "The reference sets the tone curve, loudness and width; the preset you pick adds its character on top (punch, warmth, glue). Krypt only measures the reference: none of its audio is used.";

/** The result's closeness line ("Closer to the reference by 2.3 dB …"). */
export function closenessText(m: Pick<ReferenceMatch, 'distanceBefore' | 'distanceAfter' | 'name'>, before?: { lufs?: number | null; truePeak?: number | null } | null): string {
  return closenessLine(m.distanceBefore, m.distanceAfter, `"${m.name}"`, { limitedSource: isLimitedSource(before) });
}

/** How the matched reference plays: dB it is turned (+ = up) so it is as loud as the result. */
export function referenceGain(afterLufs: number, refLufs: number): number {
  const g = afterLufs - refLufs;
  return Number.isFinite(g) ? Math.round(Math.max(-40, Math.min(12, g)) * 10) / 10 : 0;
}

/** The line under A/B with a reference. */
export function referenceAbNote(afterLufs: number, refLufs: number): string {
  const g = referenceGain(afterLufs, refLufs);
  if (Math.abs(g) < 0.3) return 'Reference plays from its start, at its own level: it is already as loud as your result.';
  return `Reference plays from its start, ${fmtNum(Math.abs(g))} dB ${g < 0 ? 'quieter' : 'louder'} than it is, so it is exactly as loud as your result and only the sound differs.`;
}

// ── Progress ──────────────────────────────────────────────────────────

export type JobPhase = 'idle' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';
export type StageState = 'pending' | 'active' | 'done' | 'failed' | 'stopped';

export const STAGES: ReadonlyArray<{ id: AutoMixStage; label: string }> = [
  { id: 'measuring', label: 'Rendering and measuring the song' },
  { id: 'understanding', label: 'Reading your prompt' },
  { id: 'planning', label: 'Planning the settings' },
  { id: 'applying', label: 'Setting the knobs' },
  { id: 'refining', label: 'Measuring again and fine-tuning' },
];

export function stageStates(phase: JobPhase, current: AutoMixStage | null): StageState[] {
  if (phase === 'done' || current === 'done') return STAGES.map(() => 'done');
  const at = current ? STAGES.findIndex((s) => s.id === current) : -1;
  const now: StageState = phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'stopped' : phase === 'running' || phase === 'cancelling' ? 'active' : 'pending';
  return STAGES.map((_, i) => {
    if (at < 0) return i === 0 && now !== 'pending' ? now : 'pending';
    if (i < at) return 'done';
    if (i === at) return now;
    return 'pending';
  });
}

/** 0..1 for the bar, or -1 (indeterminate). */
export function barFraction(phase: JobPhase, p: AutoMixProgress | null): number {
  if (phase === 'done') return 1;
  if (!p || !(p.fraction >= 0)) return -1;
  return Math.max(0, Math.min(1, p.fraction));
}

export function percentText(fraction: number): string {
  return fraction >= 0 ? `${Math.round(fraction * 100)} %` : '';
}

// ── Failures ──────────────────────────────────────────────────────────

export const NOT_AVAILABLE =
  "Auto Mix isn't available in this build yet: the mixing service didn't answer. Restart Krypt Studio after updating it, or mix by hand: Chains on any insert, or ask an agent to review the song.";

export function failureMessage(err: unknown, fallback = 'Auto Mix failed without saying why'): string {
  const m = typeof err === 'string' ? err : ((err as Error)?.message ?? String(err ?? ''));
  if (/no handler registered/i.test(m)) return NOT_AVAILABLE;
  const clean = m.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '').trim();
  return clean || fallback;
}

export function isCancelMessage(m: string | undefined): boolean {
  return /cancel/i.test(m ?? '');
}

/** The file dialog was closed (Master a song): nothing happened, which isn't a failure. */
export function isNoFileMessage(m: string | undefined): boolean {
  return /no (audio )?file|nothing (was )?chosen|no song chosen|dialog (was )?closed/i.test(m ?? '');
}

// ── Master a song: ① your song (research/23, the beginner flow) ───────

/** Step ①: the song to master, picked (or dropped) in the renderer and read with engine.sampleInfo. Nothing runs yet. */
export interface SongPick {
  status: 'idle' | 'busy' | 'ready' | 'failed';
  path: string | null;
  /** "3:24 · stereo · 44.1 kHz" once read. */
  summary: string | null;
  error: string | null;
}

export const NO_SONG: SongPick = { status: 'idle', path: null, summary: null, error: null };

/** "3:24" (or "1:02:03"). */
export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The line under the picked song: its length and format (cheap: no analysis). */
export function songSummary(info: { durationSec: number; sampleRate: number; channels: number }): string {
  const ch = info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : `${info.channels} channels`;
  const khz = info.sampleRate > 0 ? `${Number((info.sampleRate / 1000).toFixed(1))} kHz` : '';
  return [fmtDuration(info.durationSec), ch, khz].filter(Boolean).join(' · ');
}

/** The same file (Windows paths: case and slash direction don't matter). */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  const k = (p: string | null | undefined): string => String(p ?? '').trim().replace(/\//g, '\\').toLowerCase();
  return !!k(a) && k(a) === k(b);
}

export const SAME_AS_SONG = "That's your own song — pick a different one to match";
export const SAME_AS_ALBUM_SONG = "That's one of your album songs — pick a different one to match";

/** Why this reference can't be used for these songs (it is one of them), or null. */
export function referenceClash(refPath: string | null | undefined, songs: ReadonlyArray<string | null | undefined>, album = false): string | null {
  if (!refPath) return null;
  return songs.some((p) => samePath(p, refPath)) ? (album ? SAME_AS_ALBUM_SONG : SAME_AS_SONG) : null;
}

/** The reference a run uses: none when it failed, or when it is the song being mastered (the row says so). */
export function usableReference(r: ReferenceState, songs: ReadonlyArray<string | null | undefined>): string | null {
  const p = referencePath(r);
  return p && !referenceClash(p, songs) ? p : null;
}

/** Why "Master my song" can't start (null = it can): step ① first, then the form's own checks. */
export function masterRunBlocker(song: SongPick, f: AutoMixForm): string | null {
  if (song.status === 'busy') return 'Reading your song…';
  if (song.status !== 'ready' || !song.path) return song.status === 'failed' ? 'That song could not be read: choose another one' : 'Choose your song first';
  return formError(f);
}

// ── Master a song / an album: the working steps ───────────────────────

export type MasterStepId = 'open' | 'prompt' | 'reference' | 'measure' | 'plan' | 'apply' | 'check';

export interface MasterStep {
  id: MasterStepId;
  label: string;
}

/**
 * The steps the working view ticks through, in the order main reports them (electron/automix/service.ts masterFile →
 * run, and album.ts): open the song in a new tab, read the prompt, measure the reference, measure the song, plan,
 * set the chain, check the result (again per pass). Steps that don't apply (no prompt, no reference) are left out.
 */
export function masterSteps(o: { song: string; prompt: boolean; reference: boolean; album?: boolean }): MasterStep[] {
  const steps: MasterStep[] = [{ id: 'open', label: o.album ? 'Reading your songs' : `Opening "${o.song}" in a new tab` }];
  if (o.prompt) steps.push({ id: 'prompt', label: 'Reading what you typed' });
  if (o.reference) steps.push({ id: 'reference', label: 'Measuring the reference song' });
  steps.push(
    { id: 'measure', label: o.album ? 'Measuring each song (loudness and tone)' : 'Measuring your song (loudness and tone)' },
    { id: 'plan', label: o.album ? 'Planning the album' : 'Planning the sound' },
    { id: 'apply', label: 'Setting tone EQ → glue → width → loudness' },
    { id: 'check', label: 'Checking the result' },
  );
  return steps;
}

/** Which step a progress event belongs to (null = nothing reported yet: the song is being opened). */
export function masterStepOf(p: Pick<AutoMixProgress, 'stage' | 'message'> | null, album = false): MasterStepId | 'done' {
  if (!p) return 'open';
  switch (p.stage) {
    case 'understanding':
      return 'prompt';
    case 'measuring':
      if (/reference/i.test(p.message)) return 'reference';
      if (album && /^Reading "/.test(p.message)) return 'open';
      return 'measure';
    case 'planning':
      return 'plan';
    case 'applying':
      return 'apply';
    case 'refining':
      return 'check';
    default:
      return 'done';
  }
}

/** "pass 2" from "Refining (pass 2 of 3)…" / "Measuring the result (pass 1)…" ('' when it names none). */
export function passOf(message: string | null | undefined): string {
  const m = /pass (\d+)/i.exec(message ?? '');
  return m ? `pass ${m[1]}` : '';
}

/** Next to the active step: the song it is on ("Intro" (2 of 9)) and the pass, from main's message ('' = nothing to add). */
export function progressDetail(message: string | null | undefined): string {
  const song = /"[^"]+" \(\d+ of \d+/.exec(message ?? '')?.[0];
  return [song ? `${song})` : '', passOf(message)].filter(Boolean).join(' · ');
}

/** Each step's state: done before the current one, the current one active (or failed / stopped), the rest pending. */
export function masterStepStates(phase: JobPhase, steps: readonly MasterStep[], current: MasterStepId | 'done'): StageState[] {
  if (phase === 'done' || current === 'done') return steps.map(() => 'done');
  let at = steps.findIndex((s) => s.id === current);
  if (at < 0) at = 0;
  const now: StageState = phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'stopped' : phase === 'running' || phase === 'cancelling' ? 'active' : 'pending';
  return steps.map((_, i) => (i < at ? 'done' : i === at ? now : 'pending'));
}

// ── Master a song: the result headline ────────────────────────────────

/** "no clipping" when every peak stayed under 0 dBTP. */
export function clipWords(truePeak: number): string {
  return Number.isFinite(truePeak) && truePeak < 0 ? 'no clipping' : 'it peaks at 0 or above: see Details';
}

/** The big line on the result: what happened, in one sentence, with the numbers that matter. */
export function resultHeadline(o: Pick<AutoMixOutcome, 'mode' | 'before' | 'after' | 'entryId'>, target: AutoMixTarget, song: string | null): string {
  const nums = `${fmtNum(o.before.lufs)} → ${fmtNum(o.after.lufs)} LUFS, ${clipWords(o.after.truePeak)}`;
  if (target === 'file') {
    const name = `"${song || 'Your song'}"`;
    return o.entryId ? `Done! ${name} is mastered (${nums})` : `Done! ${name} already met the target, so nothing needed changing (${fmtNum(o.after.lufs)} LUFS)`;
  }
  return o.entryId ? `Done! Auto ${MODE_LABEL[o.mode]} finished (${nums})` : `Done! Your song already met the target, so nothing changed (${fmtNum(o.after.lufs)} LUFS)`;
}

/** Under the headline: where the result is, and what LUFS means. */
export function resultWhere(target: AutoMixTarget, song: string | null): string {
  return target === 'file'
    ? `It opened in a new tab called "${song || 'your song'}". Your original file is untouched. LUFS (loudness): closer to 0 is louder.`
    : 'Your project changed in one undo step. LUFS (loudness): closer to 0 is louder.';
}
