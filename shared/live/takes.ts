import type { RecordedPass, RecordedTake } from '../engine/protocol';
import { PPQ } from '../schema/time';

export const MIN_PASS_TICKS = PPQ;

export interface TakePassArg {
  start: number;
  end: number;
  sec: number;
  notes?: Array<{ channelId: string; tick: number; dur: number; key: number; vel: number }>;
}

function q(tick: number, grid: number): number {
  return grid > 0 ? Math.round(tick / grid) * grid : Math.round(tick);
}

function passRange(p: RecordedPass): { start: number; end: number } {
  return { start: Math.max(0, Math.round(p.startTick)), end: Math.max(0, Math.round(p.endTick)) };
}

export function isLoopTake(ev: Pick<RecordedTake, 'mode' | 'passes'>): boolean {
  return ev.mode === 'song' && Array.isArray(ev.passes) && ev.passes.length >= 2;
}

export function audioTakePasses(passes: RecordedPass[]): TakePassArg[] {
  return passes
    .map((p) => ({ ...passRange(p), sec: Math.max(0, p.sec) }))
    .filter((p) => p.end - p.start >= MIN_PASS_TICKS);
}

export function midiTakePasses(ev: Pick<RecordedTake, 'notes' | 'passes'>, quantize: number, hasChannel: (id: string) => boolean): TakePassArg[] {
  const passes = ev.passes ?? [];
  const out: TakePassArg[] = [];
  passes.forEach((p, i) => {
    const r = passRange(p);
    if (!(r.end > r.start)) return;
    const notes = ev.notes
      .filter((n) => (n.pass ?? 0) === i && hasChannel(n.channelId))
      .map((n) => {
        const tick = Math.min(Math.max(q(n.tick, quantize), r.start), r.end - 1);
        return { channelId: n.channelId, tick, dur: Math.max(1, Math.round(n.dur)), key: Math.max(0, Math.min(127, Math.round(n.key))), vel: Math.max(0, Math.min(1, n.vel)) };
      });
    if (notes.length) out.push({ ...r, sec: Math.max(0, p.sec), notes });
  });
  return out;
}

export function passesSpan(passes: Array<{ start: number; end: number }>): { start: number; end: number } {
  return { start: Math.min(...passes.map((p) => p.start)), end: Math.max(...passes.map((p) => p.end)) };
}
