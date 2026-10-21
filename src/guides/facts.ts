import { PLAYBOOKS, type Playbook } from '@shared/playbooks';
import { SAMPLE_KINDS, type InstrumentRole, type SampleKind } from '@shared/sounds/types';
import { SAMPLE_KIND_LABELS } from '../sounds/logic';

export interface PlaybookFacts {
  id: string;
  name: string;
  summary: string;
  tempo: string;
  swing: string;
  grid: string;
  modes: string;
  keys: string;
  keyNotes?: string;
  progressions: string[];
  drums: Array<{ name: string; writing: string }>;
  parts: string[];
  sections: Array<{ label: string; bars: number; energy: number }>;
  totalBars: number;
  length: string;
  groove?: string;
  mix: Array<{ label: string; value: string }>;
  mistakes: string[];
}

const DRUM_ROLES = new Set<InstrumentRole>(['kick', 'snare', 'clap', 'hat', 'openhat', 'ride', 'crash', 'perc', 'tom']);

export function firstSentence(s: string, max = 220): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.trim());
  const out = (m ? m[1] : s.trim()).trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

const list = (xs: readonly string[]): string => xs.join(', ');

function gridText(p: Playbook): string {
  const g = p.grid ?? 16;
  if (g === 16) return '16th-note steps';
  if (g === 24) return '16th-note triplet steps';
  if (g === 32) return '32nd-note steps';
  if (g === 12) return '8th-note triplet steps';
  return `${g} steps per bar`;
}

function minutes(bars: number, bpm: number): string {
  const sec = Math.round((bars * 4 * 60) / bpm);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

const db = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

export function playbookById(id: string): Playbook | null {
  return PLAYBOOKS.find((p) => p.id === id) ?? null;
}

export function playbookIds(): string[] {
  return PLAYBOOKS.map((p) => p.id);
}

export function playbookFacts(id: string): PlaybookFacts | null {
  const p = playbookById(id);
  if (!p) return null;
  const totalBars = p.arrangement.reduce((a, s) => a + s.bars, 0);
  const mix: PlaybookFacts['mix'] = [
    { label: 'Loudness', value: `${p.targets.lufs} LUFS integrated, true peak under ${p.targets.truePeakDb} dBTP` },
    { label: 'Song length', value: `${p.targets.bars[0]}-${p.targets.bars[1]} bars` },
  ];
  if (p.targets.contrastLu) mix.push({ label: 'Section contrast', value: `${p.targets.contrastLu[0]}-${p.targets.contrastLu[1]} LU between the loudest and quietest section` });
  if (p.targets.bands?.sub) mix.push({ label: 'Sub vs mids', value: `${db(p.targets.bands.sub[0])} to ${db(p.targets.bands.sub[1])} dB` });
  if (p.targets.minCorrelation !== undefined) mix.push({ label: 'Stereo', value: `wide but mono-safe (correlation above ${p.targets.minCorrelation})` });
  const buses = p.mix.buses?.map((b) => b.name) ?? [];
  const sends = p.mix.sends?.map((s) => s.name) ?? [];
  if (buses.length || sends.length) mix.push({ label: 'Buses and sends', value: list([...buses, ...sends]) });
  mix.push({ label: 'Levels', value: firstSentence(p.mix.levels, 260) });
  return {
    id: p.id,
    name: p.name,
    summary: firstSentence(p.summary, 260),
    tempo: `${p.bpm.min}-${p.bpm.max} BPM, usually ${p.bpm.typical}${p.halfTime ? ' (half-time feel)' : ''}`,
    swing: p.swing > 0 ? `${p.swing}%` : 'None (straight)',
    grid: gridText(p),
    modes: list(p.keys.modes),
    keys: list(p.keys.common),
    ...(p.keys.notes ? { keyNotes: firstSentence(p.keys.notes) } : {}),
    progressions: p.harmony.progressions.slice(0, 3),
    drums: p.parts.filter((x) => DRUM_ROLES.has(x.role)).map((x) => ({ name: x.name, writing: firstSentence(x.writing, 180) })),
    parts: p.parts.filter((x) => !DRUM_ROLES.has(x.role)).map((x) => x.name),
    sections: p.arrangement.map((s) => ({ label: s.label, bars: s.bars, energy: s.energy })),
    totalBars,
    length: `about ${minutes(totalBars, p.bpm.typical)} at ${p.bpm.typical} BPM`,
    ...(p.groove ? { groove: `${p.groove.template} groove on ${list(p.groove.parts)} (${Math.round(p.groove.amount * 100)}% timing, ${Math.round(p.groove.velocity * 100)}% velocity)` } : {}),
    mix,
    mistakes: p.mistakes.slice(0, 3).map((m) => firstSentence(m, 200)),
  };
}

export interface KindRow {
  kind: SampleKind;
  label: string;
  factory: number;
  packs: number;
}

export function kindRows(factory: ReadonlyArray<{ kind: string }>, packs: ReadonlyArray<{ kind: string }> = []): KindRow[] {
  const count = (xs: ReadonlyArray<{ kind: string }>): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x.kind, (m.get(x.kind) ?? 0) + 1);
    return m;
  };
  const f = count(factory);
  const p = count(packs);
  return SAMPLE_KINDS.map((kind) => ({ kind, label: SAMPLE_KIND_LABELS[kind] ?? kind, factory: f.get(kind) ?? 0, packs: p.get(kind) ?? 0 }));
}
