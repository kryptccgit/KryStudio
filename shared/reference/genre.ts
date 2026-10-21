import type { DrumGrid } from '../library/types';
import type { Playbook } from '../playbooks/types';
import { genreInfo, type GenreId } from '../sounds/genres';
import { cosine, gridSteps16, hitsPerBar, playbookDrums } from './drums';
import type { GenreGuess } from './types';

const RANGE_SLACK = 0.06;

export interface TempoReading {
  bpm: number;
  factor: number;
  inRange: boolean;
}

export function readingFor(pb: Pick<Playbook, 'bpm'>, detected: number): TempoReading {
  const cands = [1, 2, 0.5].map((f) => ({ f, bpm: detected * f })).filter((c) => c.bpm >= 40 && c.bpm <= 250);
  const lo = pb.bpm.min * (1 - RANGE_SLACK);
  const hi = pb.bpm.max * (1 + RANGE_SLACK);
  const cost = (b: number) => (b >= lo && b <= hi ? 0 : 10) + Math.abs(Math.log2(b / pb.bpm.typical));
  const best = (cands.length ? cands : [{ f: 1, bpm: detected }]).reduce((a, b) => (cost(b.bpm) < cost(a.bpm) ? b : a));
  return { bpm: Math.round(best.bpm), factor: best.f, inRange: best.bpm >= lo && best.bpm <= hi };
}

function tempoFit(pb: Playbook, r: TempoReading): number {
  if (r.inRange) return 1 - (0.5 * Math.abs(r.bpm - pb.bpm.typical)) / Math.max(4, pb.bpm.max - pb.bpm.min);
  const edge = r.bpm < pb.bpm.min ? pb.bpm.min - r.bpm : r.bpm - pb.bpm.max;
  return Math.max(0, 0.4 - edge / 20);
}

export interface GenreInput {
  detectedBpm: number | null;
  swing: number | null;
  grid: DrumGrid | null;
}

export function guessGenres(input: GenreInput, playbooks: readonly Playbook[], limit = 3): GenreGuess[] {
  const bpm = input.detectedBpm;
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return [];
  const grid = input.grid && input.grid.bars >= 2 ? input.grid : null;
  const out: GenreGuess[] = [];
  for (const pb of playbooks) {
    const r = readingFor(pb, bpm);
    const why: string[] = [];
    const t = tempoFit(pb, r);
    why.push(r.inRange ? `tempo ${r.bpm} in ${pb.bpm.min}-${pb.bpm.max}` : `tempo ${r.bpm} outside ${pb.bpm.min}-${pb.bpm.max}`);
    let score: number;
    const pd = grid ? playbookDrums(pb) : null;
    if (grid && pd) {
      const ref = gridSteps16(grid, r.factor);
      const kick = cosine(ref.kick, pd.steps.kick);
      const snare = cosine(ref.snare, pd.steps.snare);
      const rh = hitsPerBar(ref.hat);
      const ph = hitsPerBar(pd.steps.hat);
      const hat = Math.max(0, 1 - Math.abs(Math.log2((rh + 1) / (ph + 1))) / 2);
      const drums = 0.45 * kick + 0.4 * snare + 0.15 * hat;
      if (kick >= 0.8) why.push('kick pattern matches');
      if (snare >= 0.8) why.push('snare / clap placement matches');
      else if (snare < 0.4) why.push('snare / clap placement differs');
      const sw = r.factor === 1 && input.swing !== null ? 1 - Math.min(1, Math.abs(input.swing * 100 - pb.swing) / 40) : 0.6;
      score = 0.42 * t + 0.48 * drums + 0.1 * sw;
    } else {
      const sw = r.factor === 1 && input.swing !== null ? 1 - Math.min(1, Math.abs(input.swing * 100 - pb.swing) / 40) : 0.6;
      score = 0.6 * (0.8 * t + 0.2 * sw);
    }
    out.push({ id: pb.id, score: Math.round(score * 100) / 100, bpm: r.bpm, why });
  }
  return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, Math.max(1, limit));
}

export function guessLine(g: GenreGuess): string {
  return `${genreInfo(g.id).name} ${g.score.toFixed(2)} (${g.why.join(', ')})`;
}

export function guessedId(guesses: readonly GenreGuess[]): GenreId | null {
  return guesses[0]?.id ?? null;
}
