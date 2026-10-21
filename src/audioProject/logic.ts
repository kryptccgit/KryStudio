import type { AnalyzerState, AudioProjectOptions, AudioProjectOutcome, AudioProjectProgress, AudioProjectStage } from '@shared/types';

export type AudioPart = NonNullable<AudioProjectOptions['parts']>[number];
export type TempoFactor = NonNullable<AudioProjectOptions['factor']>;

export const STAGES: ReadonlyArray<{ id: AudioProjectStage; label: string }> = [
  { id: 'analyzing', label: 'Listening: tempo, key, beats and sections' },
  { id: 'separating', label: 'Splitting it into stems' },
  { id: 'transcribing', label: 'Writing the notes: drums, bass, chords, lead' },
  { id: 'matching', label: 'Matching sounds to the song' },
  { id: 'building', label: 'Building the project' },
];

export const ALL_PARTS: readonly AudioPart[] = ['drums', 'bass', 'chords', 'lead'];

export const PART_LABEL: Record<AudioPart, string> = { drums: 'Drums', bass: 'Bass', chords: 'Chords', lead: 'Lead' };

export const FACTOR_OPTIONS: ReadonlyArray<{ value: TempoFactor; label: string; title: string }> = [
  { value: 1, label: 'As detected', title: 'The tempo the analyzer reads' },
  { value: 0.5, label: 'Half time', title: 'Half the detected tempo: for a song that came out twice too fast' },
  { value: 2, label: 'Double time', title: 'Twice the detected tempo: for a song that came out twice too slow' },
];

export type JobPhase = 'idle' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';

export type StageState = 'pending' | 'active' | 'done' | 'failed' | 'stopped';

export function stageStates(phase: JobPhase, current: AudioProjectStage | null): StageState[] {
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

export function barFraction(phase: JobPhase, p: AudioProjectProgress | null): number {
  if (phase === 'done') return 1;
  if (!p || !(p.fraction >= 0)) return -1;
  return Math.max(0, Math.min(1, p.fraction));
}

export function percentText(fraction: number): string {
  return fraction >= 0 ? `${Math.round(fraction * 100)} %` : '';
}

export function buildOptions(form: { keepStems: boolean; factor: TempoFactor; parts: readonly AudioPart[] }): AudioProjectOptions {
  const parts = ALL_PARTS.filter((p) => form.parts.includes(p));
  const opts: AudioProjectOptions = { keepStems: form.keepStems, factor: form.factor };
  if (parts.length < ALL_PARTS.length) opts.parts = parts;
  return opts;
}

export function optionsError(parts: readonly AudioPart[]): string | null {
  return parts.length ? null : 'Pick at least one part to turn into patterns';
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function fmtBpm(bpm: number): string {
  if (!Number.isFinite(bpm) || bpm <= 0) return '?';
  return `${Math.abs(bpm - Math.round(bpm)) < 0.05 ? Math.round(bpm) : bpm.toFixed(1)} BPM`;
}

export function summaryFacts(o: AudioProjectOutcome): Array<{ label: string; value: string }> {
  return [
    { label: 'Tempo', value: fmtBpm(o.bpm) },
    { label: 'Key', value: o.key || 'Not clear' },
    { label: 'Length', value: plural(o.bars, 'bar') },
    { label: 'Sections', value: String(o.sections) },
    { label: 'Channels', value: String(o.channels) },
    { label: 'Patterns', value: String(o.patterns) },
  ];
}

export const STEMS_NOTE = 'Stems are on muted tracks: unmute one to compare.';
export const OWNERSHIP_NOTE = "If this isn't your song, use the result for practice and remix study, not for release.";

export function summaryLines(o: AudioProjectOutcome): string[] {
  const lines = [
    `${fmtBpm(o.bpm)}${o.key ? ` in ${o.key}` : ''}, ${plural(o.bars, 'bar')} in ${plural(o.sections, 'section')}: ${plural(o.channels, 'channel')} and ${plural(o.patterns, 'pattern')}.`,
  ];
  if (o.stemsKept) lines.push(STEMS_NOTE);
  return lines;
}

export function doneToast(o: AudioProjectOutcome): string {
  return `"${o.name}" is now a project: ${fmtBpm(o.bpm)}${o.key ? `, ${o.key}` : ''}, ${plural(o.bars, 'bar')}`;
}

export function isMissingHandler(message: string): boolean {
  return /no handler registered/i.test(message);
}

export const NOT_AVAILABLE =
  "Audio → Project isn't available in this build yet: the converter didn't answer. Restart Krypt Studio after updating it, or use Separate stems and Convert to pattern on an audio clip meanwhile.";

export function failureMessage(err: unknown): string {
  const m = typeof err === 'string' ? err : ((err as Error)?.message ?? String(err ?? ''));
  if (isMissingHandler(m)) return NOT_AVAILABLE;
  const clean = m.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '').trim();
  return clean || 'The conversion failed without saying why';
}

export function isCancelMessage(m: string | undefined): boolean {
  return /cancel/i.test(m ?? '');
}

export function stemModelState(a: AnalyzerState | null): 'installed' | 'missing' | 'unknown' {
  if (!a) return 'unknown';
  const ms = a.models.filter((m) => m.def.task === 'stems');
  if (!ms.length) return 'unknown';
  return ms.some((m) => m.status === 'installed') ? 'installed' : 'missing';
}

export function chatReferencePrompt(path: string): string {
  return `Make a song like "${path}"`;
}

export function claudeCodeReferencePrompt(path: string): string {
  return `/krypt-studio:like ${path} make it `;
}
