import type {
  MashupAnchor,
  MashupCheck,
  MashupOutcome,
  MashupPlanSummary,
  MashupProgress,
  MashupRequest,
  MashupSongReading,
  MashupSource,
  MashupStage,
  MashupStem,
  MashupStyle,
  StemPick,
} from '@shared/mashup/types';

export type Song = 'a' | 'b';
export type TempoFactor = 1 | 0.5 | 2;
export type TuneChoice = NonNullable<MashupRequest['tune']>;

export const SONG_LABEL: Record<Song, string> = { a: 'A', b: 'B' };

export interface SongSlot {
  kind: 'file' | 'library' | 'clip';
  name: string;
  path?: string;
  clipId?: string;
  detail?: string;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function fileSlot(path: string, kind: 'file' | 'library' = 'file', name?: string): SongSlot {
  return { kind, path, name: name || fileName(path).replace(/\.[^.]+$/, '') || fileName(path), detail: kind === 'library' ? 'Reference library' : path };
}

export function clipSlot(clipId: string, name: string, detail?: string): SongSlot {
  return { kind: 'clip', clipId, name, detail: detail ?? 'Audio clip in this project' };
}

export function sourceOf(slot: SongSlot): MashupSource {
  return slot.kind === 'clip' ? { clipId: slot.clipId ?? '' } : { path: slot.path ?? '' };
}

export function sameSource(a: SongSlot | null, b: SongSlot | null): boolean {
  if (!a || !b) return false;
  if (a.kind === 'clip' || b.kind === 'clip') return a.kind === b.kind && a.clipId === b.clipId;
  return !!a.path && (a.path ?? '').toLowerCase() === (b.path ?? '').toLowerCase();
}

export interface MashupForm {
  a: SongSlot | null;
  b: SongSlot | null;
  style: MashupStyle;
  vocalFrom: 'a' | 'b' | 'auto';
  stems: StemPick;
  anchor: MashupAnchor | 'auto';
  tune: TuneChoice;
  bars: number | null;
  newProject: boolean;
  transitions: boolean;
  factorA: TempoFactor;
  factorB: TempoFactor;
}

export const STEMS: readonly MashupStem[] = ['vocals', 'drums', 'bass', 'other'];
export const STEM_LABEL: Record<MashupStem, string> = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other' };

export const DEFAULT_STEMS: StemPick = { vocals: 'a', drums: 'b', bass: 'b', other: 'b' };

export const BARS_MIN = 8;
export const BARS_MAX = 128;

export const DEFAULT_FORM: MashupForm = {
  a: null,
  b: null,
  style: 'vocalOverBeat',
  vocalFrom: 'auto',
  stems: { ...DEFAULT_STEMS },
  anchor: 'auto',
  tune: 'natural',
  bars: null,
  newProject: true,
  transitions: true,
  factorA: 1,
  factorB: 1,
};

export type FormOptions = Omit<MashupForm, 'a' | 'b' | 'stems'>;

export type FormAction =
  | { type: 'setSlot'; song: Song; slot: SongSlot | null }
  | { type: 'swap' }
  | { type: 'set'; patch: Partial<FormOptions> }
  | { type: 'setStem'; stem: MashupStem; pick: Song | null }
  | { type: 'reset' };

const flip = <T>(v: T): T => (v === 'a' ? ('b' as T) : v === 'b' ? ('a' as T) : v);

export function clampBars(n: number): number {
  if (!Number.isFinite(n)) return BARS_MIN;
  return Math.max(BARS_MIN, Math.min(BARS_MAX, Math.round(n)));
}

export function formReducer(f: MashupForm, act: FormAction): MashupForm {
  switch (act.type) {
    case 'setSlot': {
      const factor = act.song === 'a' ? { factorA: 1 as TempoFactor } : { factorB: 1 as TempoFactor };
      return { ...f, [act.song]: act.slot, ...factor };
    }
    case 'swap':
      return {
        ...f,
        a: f.b,
        b: f.a,
        factorA: f.factorB,
        factorB: f.factorA,
        vocalFrom: flip(f.vocalFrom),
        stems: { vocals: flip(f.stems.vocals), drums: flip(f.stems.drums), bass: flip(f.stems.bass), other: flip(f.stems.other) },
      };
    case 'set': {
      const patch = { ...act.patch };
      if (patch.bars !== undefined && patch.bars !== null) patch.bars = clampBars(patch.bars);
      return { ...f, ...patch };
    }
    case 'setStem':
      return { ...f, stems: { ...f.stems, [act.stem]: act.pick } };
    case 'reset':
      return { ...DEFAULT_FORM, stems: { ...DEFAULT_STEMS } };
  }
}

export function formError(f: MashupForm): string | null {
  if (!f.a && !f.b) return 'Pick two songs';
  if (!f.a) return 'Pick song A';
  if (!f.b) return 'Pick song B';
  if (sameSource(f.a, f.b)) return 'Pick two different songs';
  if (f.style === 'stemBlend') {
    const picks = STEMS.map((s) => f.stems[s]).filter((p): p is Song => p !== null);
    if (!picks.length) return 'Pick at least one stem in the grid';
    if (!picks.includes('a') || !picks.includes('b')) return 'Use at least one stem from each song: otherwise it is just one song';
  }
  return null;
}

export function buildRequest(f: MashupForm): MashupRequest | null {
  if (formError(f) || !f.a || !f.b) return null;
  const req: MashupRequest = { a: sourceOf(f.a), b: sourceOf(f.b), style: f.style, ...(f.anchor !== 'auto' ? { anchor: f.anchor } : {}), newProject: f.newProject, transitions: f.transitions };
  if (f.style === 'vocalOverBeat') req.vocalFrom = f.vocalFrom;
  if (f.style === 'stemBlend') req.stems = { ...f.stems };
  if (f.style !== 'backAndForth') req.tune = f.tune;
  if (f.factorA !== 1) req.factorA = f.factorA;
  if (f.factorB !== 1) req.factorB = f.factorB;
  if (f.bars !== null) req.bars = clampBars(f.bars);
  return req;
}

export function requestKey(req: MashupRequest | null): string | null {
  if (!req) return null;
  const order = ['a', 'b', 'style', 'vocalFrom', 'stems', 'anchor', 'bpm', 'key', 'factorA', 'factorB', 'tune', 'bars', 'newProject', 'transitions'] as const;
  const out: Record<string, unknown> = {};
  for (const k of order) if (req[k] !== undefined) out[k] = k === 'stems' && req.stems ? STEMS.map((s) => req.stems![s] ?? '-').join('') : req[k];
  return JSON.stringify(out);
}

export function fmtBpm(bpm: number | null | undefined): string {
  if (bpm === null || bpm === undefined || !Number.isFinite(bpm) || bpm <= 0) return '?';
  return Math.abs(bpm - Math.round(bpm)) < 0.05 ? String(Math.round(bpm)) : bpm.toFixed(1);
}

export interface TempoChip {
  factor: TempoFactor;
  bpm: number;
  label: string;
  title: string;
  active: boolean;
}

export function tempoChips(r: Pick<MashupSongReading, 'bpm' | 'bpmAlternatives'>, factor: TempoFactor): TempoChip[] {
  if (r.bpm === null || !(r.bpm > 0)) return [];
  const chips: TempoChip[] = [{ factor: 1, bpm: r.bpm, label: fmtBpm(r.bpm), title: 'As detected', active: factor === 1 }];
  for (const alt of r.bpmAlternatives ?? []) {
    if (!(alt > 0)) continue;
    const ratio = alt / r.bpm;
    const f: TempoFactor | null = Math.abs(ratio - 0.5) < 0.08 ? 0.5 : Math.abs(ratio - 2) < 0.3 ? 2 : null;
    if (f === null || chips.some((c) => c.factor === f)) continue;
    chips.push({ factor: f, bpm: alt, label: fmtBpm(alt), title: f === 0.5 ? 'Half time' : 'Double time', active: factor === f });
  }
  if (factor !== 1 && !chips.some((c) => c.factor === factor)) {
    const bpm = r.bpm * factor;
    chips.push({ factor, bpm, label: fmtBpm(bpm), title: factor === 0.5 ? 'Half time' : 'Double time', active: true });
  }
  return chips.sort((x, y) => x.bpm - y.bpm);
}

export function vocalLabel(presence: number): string {
  if (!Number.isFinite(presence)) return 'Not clear';
  if (presence >= 0.45) return 'Vocal through most of it';
  if (presence >= 0.15) return 'Some vocal';
  return 'Instrumental (little or no vocal)';
}

export function keyLabel(r: Pick<MashupSongReading, 'key' | 'keyConfidence'>): string {
  if (!r.key) return 'Not clear';
  return r.keyConfidence < 0.4 ? `${r.key} (unsure)` : r.key;
}

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type ScoreTone = 'good' | 'ok' | 'poor';

export function scoreTone(score: number): ScoreTone {
  return score >= 70 ? 'good' : score >= 45 ? 'ok' : 'poor';
}

export function scoreLabel(score: number): string {
  const t = scoreTone(score);
  return t === 'good' ? 'These fit well' : t === 'ok' ? 'Workable, with some stretching or pitching' : 'A hard match: expect audible changes';
}

export function ringDash(score: number, r: number): { dash: number; gap: number } {
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0)) / 100;
  return { dash: c * f, gap: c * (1 - f) };
}

export function fmtSt(semitones: number): string {
  const r = Math.round(semitones * 10) / 10;
  const n = Number.isInteger(r) ? String(Math.abs(r)) : Math.abs(r).toFixed(1);
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${n} st`;
}

export function fmtStretch(stretch: number): string {
  return `×${stretch.toFixed(2)}`;
}

export function stretchAudible(stretch: number): boolean {
  return stretch < 0.85 || stretch > 1.18;
}

export function fmtShift(s: { stretch: number; semitones: number }): string {
  const parts: string[] = [];
  if (Math.abs(s.semitones) >= 0.05) parts.push(fmtSt(s.semitones));
  if (Number.isFinite(s.stretch) && Math.abs(s.stretch - 1) >= 0.005) parts.push(fmtStretch(s.stretch));
  return parts.join(', ');
}

export function songRole(plan: Pick<MashupPlanSummary, 'style' | 'vocalFrom'>, song: Song, stems?: StemPick): string {
  if (plan.style === 'vocalOverBeat' && plan.vocalFrom) return plan.vocalFrom === song ? 'vocal' : 'beat';
  if (plan.style === 'stemBlend' && stems) {
    const mine = STEMS.filter((s) => stems[s] === song).map((s) => STEM_LABEL[s].toLowerCase());
    if (mine.length) return mine.join(' + ');
  }
  return `song ${SONG_LABEL[song]}`;
}

export function shiftLabel(plan: MashupPlanSummary, song: Song, stems?: StemPick): string {
  const s = fmtShift(song === 'a' ? plan.shiftA : plan.shiftB);
  return s ? `${songRole(plan, song, stems)} ${s}` : '';
}

export function planLine(plan: Pick<MashupPlanSummary, 'bpm' | 'key' | 'bars'>): string {
  return [`${fmtBpm(plan.bpm)} BPM`, plan.key ?? 'key not clear', `${plan.bars} bars`].join(' · ');
}

function nameKey(name: string | undefined): string {
  return (name ?? '').replace(/…$/, '').slice(0, 20).trim().toLowerCase();
}

export function usesSongs(uses: string, names?: { a?: string; b?: string }): { a: boolean; b: boolean } {
  const both = /\bboth\b/i.test(uses);
  const low = uses.toLowerCase();
  const by = (song: Song): boolean => {
    const k = nameKey(names?.[song]);
    return k.length >= 2 && low.includes(k);
  };
  return { a: both || /\bA\b/.test(uses) || by('a'), b: both || /\bB\b/.test(uses) || by('b') };
}

export interface TimelineBlock {
  key: string;
  name: string;
  uses: string;
  firstBar: number;
  bars: number;
  left: number;
  width: number;
  tone: 'a' | 'b' | 'both' | 'none';
  shift: string;
}

export function timelineLayout(plan: MashupPlanSummary, stems?: StemPick, names?: { a?: string; b?: string }): { total: number; blocks: TimelineBlock[]; ticks: number[] } {
  const secs = (plan.sections ?? []).filter((s) => s.bars > 0);
  const origin = secs.length ? Math.min(...secs.map((s) => s.startBar)) : 0;
  const end = secs.reduce((m, s) => Math.max(m, s.startBar - origin + s.bars), 0);
  const total = Math.max(1, plan.bars || 0, end);
  const blocks = secs.map((s, i) => {
    const u = usesSongs(s.uses, names);
    const shift = (['a', 'b'] as const)
      .filter((song) => u[song])
      .map((song) => shiftLabel(plan, song, stems))
      .filter(Boolean)
      .join(' · ');
    return {
      key: `${i}:${s.startBar}`,
      name: s.name,
      uses: s.uses,
      firstBar: s.startBar - origin + 1,
      bars: s.bars,
      left: (s.startBar - origin) / total,
      width: s.bars / total,
      tone: (u.a && u.b ? 'both' : u.a ? 'a' : u.b ? 'b' : 'none') as TimelineBlock['tone'],
      shift,
    };
  });
  const step = total > 96 ? 32 : total > 40 ? 16 : total > 16 ? 8 : 4;
  const ticks: number[] = [];
  for (let b = 0; b <= total; b += step) ticks.push(b);
  return { total, blocks, ticks };
}

export function suggestionPatch(text: string): Partial<FormOptions> | null {
  const t = text.replace(/[’']/g, "'");
  const patch: Partial<FormOptions> = {};
  const tempo = /\b(?:song\s+)?([AB])\b(?:'s)?[^:.;]*?\b(half|double)[- ]time\b/.exec(t) ?? /\b(half|double)[- ]time\b[^:.;]*?\b(?:for|on)\s+(?:song\s+)?([AB])\b/.exec(t);
  if (tempo) {
    const [song, kind] = /^[AB]$/.test(tempo[1]) ? [tempo[1], tempo[2]] : [tempo[2], tempo[1]];
    patch[song === 'A' ? 'factorA' : 'factorB'] = kind.toLowerCase() === 'half' ? 0.5 : 2;
  } else {
    const detected = /\b(?:song\s+)?([AB])\b[^:.;]*?\bas detected\b/.exec(t);
    if (detected) patch[detected[1] === 'A' ? 'factorA' : 'factorB'] = 1;
  }
  const vocal = /\bvocals?\s+(?:from|of)\s+(?:song\s+)?([AB])\b/i.exec(t) ?? /\b([AB])'s\s+vocals?\b/.exec(t) ?? /\b(?:song\s+)?([AB])\s+(?:as|for)\s+the\s+vocals?\b/i.exec(t);
  if (vocal && /\b(use|take|try|swap|switch|put)\b/i.test(t)) patch.vocalFrom = vocal[1].toLowerCase() as Song;
  const anchor = /\banchor\s*[:=]?\s*"?(beat|vocal|middle)\b/i.exec(t);
  if (anchor) patch.anchor = anchor[1].toLowerCase() as MashupAnchor;
  else if (/\bkeep the beat\b/i.test(t)) patch.anchor = 'beat';
  else if (/\bkeep the vocal\b/i.test(t)) patch.anchor = 'vocal';
  else if (/\bmeet (?:in the middle|half ?way)\b/i.test(t)) patch.anchor = 'middle';
  if (/\bback[- ]?(?:and|&)[- ]?forth\b/i.test(t)) patch.style = 'backAndForth';
  else if (/\bstem ?blend\b/i.test(t)) patch.style = 'stemBlend';
  else if (/\bvocal ?over ?(?:the )?beat\b/i.test(t)) patch.style = 'vocalOverBeat';
  const tune = /\bKrypt Tune\b[^.:;]*?\b(off|natural|pop|hard)\b/i.exec(t) ?? /\b(natural|pop|hard)\b[^.:;]*?\bKrypt Tune\b/i.exec(t);
  if (tune) patch.tune = tune[1].toLowerCase() as TuneChoice;
  else if (/\b(?:without|no)\s+Krypt Tune\b/i.test(t)) patch.tune = 'off';
  const bars = /\b(?:length|shorten|lengthen|make it|use|try)\b[^.:;]*?\b(\d{1,3})\s+bars\b/i.exec(t);
  if (bars) patch.bars = clampBars(Number(bars[1]));
  if (/\b(?:without|no) transitions\b|\btransitions off\b/i.test(t)) patch.transitions = false;
  return Object.keys(patch).length ? patch : null;
}

export function patchChanges(f: MashupForm, patch: Partial<FormOptions> | null): boolean {
  if (!patch) return false;
  return (Object.keys(patch) as Array<keyof FormOptions>).some((k) => f[k] !== patch[k]);
}

export function needsStemModel(problem: string): boolean {
  return /\b(stem|stems|demucs|model manager)\b/i.test(problem);
}

export type JobPhase = 'idle' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';
export type StageState = 'pending' | 'active' | 'done' | 'failed' | 'stopped';

export const STAGES: ReadonlyArray<{ id: MashupStage; label: string }> = [
  { id: 'reading', label: 'Reading both songs' },
  { id: 'separating', label: 'Splitting stems' },
  { id: 'analyzing', label: 'Listening: tempo, key, beats and sections' },
  { id: 'planning', label: 'Planning the mashup' },
  { id: 'building', label: 'Building the arrangement' },
  { id: 'mixing', label: 'Mixing: vocal chain, carving, transitions' },
];

export function stageStates(phase: JobPhase, current: MashupStage | null): StageState[] {
  if (phase === 'done') return STAGES.map(() => 'done');
  const at = current ? STAGES.findIndex((s) => s.id === current) : -1;
  const now: StageState = phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'stopped' : phase === 'running' || phase === 'cancelling' ? 'active' : 'pending';
  return STAGES.map((_, i) => {
    if (at < 0) return i === 0 && now !== 'pending' ? now : 'pending';
    if (i < at) return 'done';
    if (i === at) return now;
    return 'pending';
  });
}

export function barFraction(phase: JobPhase, p: MashupProgress | null): number {
  if (phase === 'done') return 1;
  if (!p || !(p.fraction >= 0)) return -1;
  return Math.max(0, Math.min(1, p.fraction));
}

export function percentText(fraction: number): string {
  return fraction >= 0 ? `${Math.round(fraction * 100)} %` : '';
}

export function doneToast(o: MashupOutcome): string {
  return `"${o.name}" is ready: ${planLine(o.plan)}, ${o.tracks} track${o.tracks === 1 ? '' : 's'}`;
}

export function checkLine(c: Pick<MashupCheck, 'score' | 'plan'>): string {
  return `Fit ${Math.round(c.score)} · ${planLine(c.plan)}`;
}

export const NOT_AVAILABLE =
  "Auto Mashup isn't available in this build yet: the mashup service didn't answer. Restart Krypt Studio after updating it, or build one by hand: Separate stems, then Match key & tempo.";

export function failureMessage(err: unknown, fallback = 'The mashup failed without saying why'): string {
  const m = typeof err === 'string' ? err : ((err as Error)?.message ?? String(err ?? ''));
  if (/no handler registered/i.test(m)) return NOT_AVAILABLE;
  const clean = m.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '').trim();
  return clean || fallback;
}

export function isCancelMessage(m: string | undefined): boolean {
  return /cancel/i.test(m ?? '');
}

export function libraryTrackCount(collections: ReadonlyArray<{ counts: { total: number; missing: number; failed: number } }> | null | undefined): number {
  return (collections ?? []).reduce((n, c) => n + Math.max(0, c.counts.total - c.counts.missing - c.counts.failed), 0);
}
