// A small made-up context (2 bars of 4/4 in A minor at 120 BPM, with an Am
// and an F chord and a few melody notes) that write_script and the code
// view's Check use to try a script once before it is saved, so runtime
// errors come back with their line numbers. Pure.

import { PPQ } from '../schema/time';
import type { ScriptContextData } from './plan';
import type { ScriptHeader, ScriptParamValues } from './types';

export function sampleContext(h: ScriptHeader, params: ScriptParamValues, seed = 1): ScriptContextData {
  const bar = 4 * PPQ;
  const chord = (tick: number, keys: number[]) => keys.map((key) => ({ tick, dur: bar, key, vel: 0.78, pan: 0, release: 0.5, fine: 0, slide: false, mute: false, color: 0 }));
  const melody = [69, 72, 76, 74].map((key, i) => ({ tick: i * PPQ, dur: PPQ / 2, key: key + 12, vel: 0.7 + i * 0.05, pan: 0, release: 0.5, fine: 0, slide: false, mute: false, color: 0 }));
  const notes = [...chord(0, [57, 60, 64]), ...chord(bar, [53, 57, 60]), ...melody].sort((a, b) => a.tick - b.tick || a.key - b.key);
  return {
    kind: h.kind,
    name: h.name,
    notes: h.kind === 'transform' ? notes : [],
    params,
    key: 9,
    scale: 'minor',
    scaleSteps: [0, 2, 3, 5, 7, 8, 10],
    keyName: 'A minor',
    bpm: 120,
    timeSig: { num: 4, den: 4 },
    ppq: PPQ,
    barTicks: bar,
    beatTicks: PPQ,
    stepTicks: PPQ / 4,
    start: 0,
    end: 2 * bar,
    lengthTicks: 2 * bar,
    bars: 2,
    chords: [
      { tick: 0, end: bar, keys: [57, 60, 64], root: 9, name: 'Am' },
      { tick: bar, end: 2 * bar, keys: [53, 57, 60], root: 5, name: 'F' },
    ],
    rootKey: 60,
    seed,
  };
}
