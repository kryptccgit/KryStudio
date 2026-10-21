// "More like this" in the Browser: the pure bits (labels, when to ask main again while pack sounds are being
// measured). The store and the actions are in ./similar.ts, the list in src/panels/browser/SimilarList.tsx.

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

/** "Kick", "Reverse cymbal", "Open hat", "808" for a sample kind or an instrument role. */
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

/** The line under "Similar to …": "Kick", "Kick (judged by its sound)", "Unknown kind: every kind is shown". */
export function sourceKindText(r: Pick<SimilarResult, 'source'>): string {
  if (!r.source.kind) return "Couldn't tell what kind of sound this is: every kind is shown";
  return r.source.inferred ? `Sounds like a ${kindName(r.source.kind).toLowerCase()} (judged by its sound)` : kindName(r.source.kind);
}

/** Stable React key / selection key of a result row. */
export function similarItemKey(i: SimilarItem): string {
  return i.type === 'sample' ? `sample:${i.path}` : `preset:${i.id}`;
}

/** Ask main again: pack sounds are still being measured and the last round made progress (never loops forever). */
export function shouldMeasureMore(r: Pick<SimilarResult, 'pending' | 'measured'> | null | undefined, round: number): boolean {
  if (!r || r.pending <= 0) return false;
  return round === 0 || r.measured > 0;
}

/** "Measuring 24 more pack sounds…" */
export function measuringText(pending: number): string {
  return `Measuring ${pending} more pack sound${pending === 1 ? '' : 's'}…`;
}
