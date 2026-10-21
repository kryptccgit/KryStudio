// The tempo a dropped loop was made at (Wave 12.2b "Follow tempo on drop"):
// from the factory / sound-pack metadata (FactorySample.bpm) or from a
// filename such as "loop_128bpm.wav", "Drums 92 BPM.wav", "bpm140_hats" or
// "dnb_loop_174.wav". One-shots have no tempo and stay as they are.

export const LOOP_BPM_MIN = 40;
export const LOOP_BPM_MAX = 300;

const ok = (n: number): boolean => Number.isFinite(n) && n >= LOOP_BPM_MIN && n <= LOOP_BPM_MAX;
const tidy = (n: number): number => Math.round(n * 100) / 100;

/** The tempo written in a file name, or null. "loop" + one plausible number counts too ("loop_140", "140 loop"). */
export function bpmFromName(fileName: string): number | null {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.[a-z0-9]{2,5}$/i, '');
  // "128bpm", "128 bpm", "128-bpm", "128_BPM", "92.5bpm"
  const after = /(?:^|[^\d.])(\d{2,3}(?:[.,]\d{1,2})?)\s*[-_ ]?\s*bpm(?![a-z])/i.exec(base);
  if (after) {
    const n = Number(after[1].replace(',', '.'));
    if (ok(n)) return tidy(n);
  }
  // "bpm128", "BPM_140", "bpm-92"
  const before = /(?:^|[^a-z])bpm\s*[-_ ]?\s*(\d{2,3}(?:[.,]\d{1,2})?)(?!\d)/i.exec(base);
  if (before) {
    const n = Number(before[1].replace(',', '.'));
    if (ok(n)) return tidy(n);
  }
  // A loop with exactly one number in a typical tempo range ("drum_loop_140", "Loop 87 Am").
  if (/(?:^|[^a-z])loops?(?![a-z])/i.test(base)) {
    const nums = [...base.matchAll(/(?:^|[^\d.])(\d{2,3})(?![\d.])/g)].map((m) => Number(m[1])).filter((n) => n >= 60 && n <= 200);
    if (nums.length === 1) return nums[0];
  }
  return null;
}

export interface LoopMeta {
  path: string;
  bpm?: number;
}

/**
 * The source tempo for a dropped file: the sound library's metadata for that path first (factory / pack samples
 * carry `bpm` only when they are tempo-synced loops or FX), else the file name. null = a one-shot (leave it be).
 */
export function loopBpmFor(path: string, name: string | undefined, library: readonly LoopMeta[]): { bpm: number; from: 'library' | 'name' } | null {
  const meta = library.find((s) => s.path === path);
  if (meta) return meta.bpm && ok(meta.bpm) ? { bpm: tidy(meta.bpm), from: 'library' } : null;
  const n = bpmFromName(name || path);
  return n === null ? null : { bpm: n, from: 'name' };
}

/** "Following tempo (128 → 140 bpm) · undo to keep the original speed" */
export function followTempoMessage(srcBpm: number, projectBpm: number): string {
  const f = (b: number) => String(tidy(b));
  const span = Math.abs(srcBpm - projectBpm) < 0.005 ? `${f(projectBpm)} bpm` : `${f(srcBpm)} → ${f(projectBpm)} bpm`;
  return `Following tempo (${span}) · undo to keep the original speed`;
}
