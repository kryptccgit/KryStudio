import type { AudioAnalysis, DrumHit } from '../analyzer/protocol';
import { beatMapping, beatsPerBar, unswingBeat } from '../library/grid';
import { PPQ } from '../schema/time';

export type TempoFactor = 0.5 | 1 | 2;

export const FALLBACK_BPM = 120;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export interface TranscriptionGrid {
  bpm: number;
  detectedBpm: number | null;
  factor: TempoFactor;
  beatsPerBar: number;
  ticksPerBar: number;
  firstDownbeatSec: number;
  shiftedBars: number;
  pickupBeats: number;
  swing: number | null;
  toTick(sec: number): number;
  toSec(tick: number): number;
  totalBars: number;
}

export interface GridOptions {
  onsets?: readonly number[];
  kicks?: readonly number[];
}

export function transcriptionGrid(a: AudioAnalysis, factor: TempoFactor, opts: GridOptions = {}): TranscriptionGrid {
  const bpb = beatsPerBar(a);
  const detected = a.tempo && isNum(a.tempo.bpm) && a.tempo.bpm > 0 ? a.tempo.bpm : null;
  const m = detected ? beatMapping(a) : null;
  const f: TempoFactor = detected ? factor : 1;
  const toBeat0 = m ? m.toBeat : (sec: number) => (sec * FALLBACK_BPM) / 60;
  const toSec0 = m ? m.toSec : (beat: number) => (beat * 60) / FALLBACK_BPM;
  const barBeats = bpb / f;

  let originBeat = 0;
  if (f === 0.5 && opts.kicks?.length) {
    const score = (offset: number) =>
      opts.kicks!.filter((t) => {
        const b = toBeat0(t) - offset;
        const r = ((b % barBeats) + barBeats) % barBeats;
        return Math.min(r, barBeats - r) < 0.15;
      }).length;
    if (score(bpb) > score(0) * 1.2) originBeat = bpb;
    if (originBeat > 0 && toSec0(originBeat - barBeats) >= -0.05) originBeat -= barBeats;
  }

  let shiftedBars = 0;
  let pickupBeats = 0;
  const firstOnset = (opts.onsets ?? []).reduce<number | null>((lo, t) => (isNum(t) && (lo === null || t < lo) ? t : lo), null);
  if (firstOnset !== null) {
    const before = originBeat - toBeat0(firstOnset);
    if (before > 0.05) {
      const whole = Math.floor((before + 0.1) / barBeats);
      let k = whole;
      while (k > 0 && toSec0(originBeat - k * barBeats) < -0.05) k--;
      shiftedBars = k;
      originBeat -= k * barBeats;
      const rest = originBeat - toBeat0(firstOnset);
      pickupBeats = rest > 0.05 ? Math.round(rest * f * 4) / 4 : 0;
    }
  }

  const swing = f === 1 && isNum(a.swing) && a.swing >= 0.1 ? Math.min(1, a.swing) : null;
  const tpb = PPQ;
  const toTick = (sec: number): number => {
    const b = toBeat0(sec) - originBeat;
    const u = swing !== null ? unswingBeat(b, swing) : b;
    return u * f * tpb;
  };
  const toSec = (tick: number): number => toSec0(tick / (f * tpb) + originBeat);
  const raw = detected ? detected * f : FALLBACK_BPM;
  const bpm = Math.abs(raw - Math.round(raw)) <= 0.2 ? Math.round(raw) : Math.round(raw * 100) / 100;
  const ticksPerBar = bpb * PPQ;
  const endBars = toTick(a.durationSec) / ticksPerBar;
  const totalBars = Math.max(1, endBars - Math.floor(endBars) >= 0.25 ? Math.ceil(endBars) : Math.floor(endBars));
  return {
    bpm,
    detectedBpm: detected,
    factor: f,
    beatsPerBar: bpb,
    ticksPerBar,
    firstDownbeatSec: Math.round(toSec(0) * 1000) / 1000,
    shiftedBars,
    pickupBeats,
    swing,
    toTick,
    toSec,
    totalBars,
  };
}

export function quantize(tick: number, grid: number, feel: number): { tick: number; cell: number } {
  if (!(grid > 1)) return { tick: Math.round(tick), cell: Math.round(tick) };
  const q = Math.round(tick / grid) * grid;
  const f = Math.max(0, Math.min(1, feel));
  return { tick: Math.round(q + f * (tick - q)), cell: q };
}

export function kickTimes(hits: readonly DrumHit[] | null | undefined): number[] {
  return (hits ?? []).filter((h) => h && h.role === 'kick' && isNum(h.timeSec)).map((h) => h.timeSec);
}
