import type { SimilarItem, SimilarResult } from '@shared/types';
import { INSTRUMENT_ROLE_NAMES, SAMPLE_KIND_LABELS } from './logic';
import type { InstrumentRole, SampleKind } from '@shared/sounds/types';

const SINGULAR: Partial<Record<SampleKind, string>> = {
  'sweep-up': 'Sweep up',
  'sweep-down': 'Sweep down',
  zap: 'Zap',
  'bass-oneshot': 'Bass one-shot',
  'stab-oneshot': 'Stab one-shot',
  vox: 'Vocal shot',
  retro: 'Retro game sound',
};

export function kindName(kind: string | null | undefined): string {
  if (!kind) return 'Sound';
  if (kind in INSTRUMENT_ROLE_NAMES) return INSTRUMENT_ROLE_NAMES[kind as InstrumentRole];
  const s = SINGULAR[kind as SampleKind];
  if (s) return s;
  const plural = SAMPLE_KIND_LABELS[kind as SampleKind];
  if (!plural) return kind;
  if (/(ch|sh|x)es$/.test(plural)) return plural.slice(0, -2);
  return /[^s]s$/.test(plural) ? plural.slice(0, -1) : plural;
}

export function sourceKindText(r: Pick<SimilarResult, 'source'>): string {
  if (!r.source.kind) return "Couldn't tell what kind of sound this is: every kind is shown";
  return r.source.inferred ? `Sounds like a ${kindName(r.source.kind).toLowerCase()} (judged by its sound)` : kindName(r.source.kind);
}

export function similarItemKey(i: SimilarItem): string {
  return i.type === 'sample' ? `sample:${i.path}` : `preset:${i.id}`;
}

export function shouldMeasureMore(r: Pick<SimilarResult, 'pending' | 'measured'> | null | undefined, round: number): boolean {
  if (!r || r.pending <= 0) return false;
  return round === 0 || r.measured > 0;
}

export function measuringText(pending: number): string {
  return `Measuring ${pending} more pack sound${pending === 1 ? '' : 's'}…`;
}
