import type { MelodyOptions } from './options';
import { makeRng, type Rng } from './random';
import { GenerateError, chordAt, chordPcs, degreeToMidi, mod12, scaleSteps, type ChordEvent } from './harmony';
import { chordNames, chordTimeline, vel3, type GenContext, type GenNote, type GenOutput } from './context';
import { metricWeight } from './rhythm';

const CONTOURS: Record<MelodyOptions['contour'], (x: number) => number> = {
  rise: (x) => x,
  fall: (x) => 1 - x,
  arch: (x) => Math.sin(Math.PI * x),
  valley: (x) => 1 - Math.sin(Math.PI * x),
  wave: (x) => 0.5 + 0.5 * Math.sin(2 * Math.PI * x * 1.5 - Math.PI / 2),
};

const STEP_W = [0.5, 3, 2, 0.8, 0.45];

const SYNC_W = [0.75, 0.35, 0.6, 0.8];

interface Slot {
  tick: number;
  strong: boolean;
}

function phraseRhythm(o: MelodyOptions, t0: number, t1: number, ctx: GenContext, rng: Rng): Slot[] {
  const beat = ctx.beatTicks;
  const grid = o.feel === 'quarters' ? beat : o.feel === '8ths' ? beat / 2 : beat / 4;
  const out: Slot[] = [];
  for (let t = t0; t < t1; t += grid) {
    const rel = t - ctx.start;
    const w = metricWeight(rel, ctx.barTicks, beat);
    const ws = o.feel === 'syncopated' ? SYNC_W[Math.round((rel % beat) / (beat / 4)) % 4] : w;
    const p = t === t0 ? 1 : Math.min(1, o.density * (0.3 + 1.0 * ws) + (o.density > 0.85 ? 0.3 : 0));
    if (t !== t0 && t >= t1 - beat && t1 - t0 >= ctx.barTicks) continue;
    if (rng.next() < p) out.push({ tick: t, strong: w >= 0.8 });
  }
  if (out.length < 2 && t1 - t0 > grid) out.push({ tick: t0 + Math.max(grid, Math.floor((t1 - t0) / 2 / grid) * grid), strong: true });
  return out.sort((a, b) => a.tick - b.tick);
}

export function generateMelody(o: MelodyOptions, ctx: GenContext): GenOutput {
  if (o.low > o.high) throw new GenerateError('The lowest melody note must be at or below the highest');
  if (o.high - o.low < 5) throw new GenerateError('Give the melody a range of at least 5 semitones');
  const rng = makeRng(ctx.seed, 0x55);
  const inRange = ctx.patternChords.some((e) => e.tick < ctx.end && e.end > ctx.start);
  const source = o.chords === 'auto' ? (inRange ? 'pattern' : 'none') : o.chords;
  const tl = chordTimeline({ ...o, chords: source, octave: 4 }, ctx, rng.fork(1));
  const steps = scaleSteps(ctx.key.scale);
  const n = steps.length;
  const toMidi = (d: number): number => degreeToMidi(d, ctx.key, steps);
  let dLo = Math.floor(((o.low - ctx.key.root) / 12) * n) - n;
  while (toMidi(dLo) < o.low) dLo++;
  let dHi = dLo;
  while (toMidi(dHi + 1) <= o.high) dHi++;
  if (dHi - dLo < 2) throw new GenerateError('The melody range holds fewer than 3 notes of the scale: widen it');
  const shape = CONTOURS[o.contour];
  const phraseLen = o.phrase * ctx.barTicks;
  const ct = o.chordTones;

  const stableDeg = (d: number): boolean => [0, 2, 4].includes(((d % n) + n) % n) || (n === 5 && ((d % n) + n) % n === 3);
  const chordOf = (t: number): ChordEvent | null => (tl.events.length ? chordAt(tl.events, t) : null);

  const choose = (r: Rng, prev: number, prev2: number | null, t: number, x: number, strong: boolean, last: boolean, home: boolean): number => {
    const target = dLo + (dHi - dLo) * (0.15 + 0.7 * shape(Math.min(1, Math.max(0, x))));
    const ch = chordOf(t);
    const pcs = ch ? chordPcs(ch) : null;
    const cands: number[] = [];
    const weights: number[] = [];
    for (let d = Math.max(dLo, prev - 4); d <= Math.min(dHi, prev + 4); d++) {
      const jump = Math.abs(d - prev);
      let w = STEP_W[jump] * Math.exp(-0.45 * Math.abs(d - target));
      const isChordTone = pcs ? pcs.includes(mod12(toMidi(d))) : stableDeg(d);
      if (strong || last) w *= isChordTone ? 1 + 4 * ct : Math.max(0.05, 1 - 0.85 * ct);
      else if (pcs && isChordTone) w *= 1 + 0.5 * ct;
      if (prev2 !== null && Math.abs(prev - prev2) >= 3) {
        const back = Math.sign(prev2 - prev);
        if (Math.sign(d - prev) === back && jump <= 2) w *= 2.5;
      }
      if (last) w *= stableDeg(d) || isChordTone ? 4 : 0.2;
      if (home && ((d % n) + n) % n === 0) w *= 6;
      cands.push(d);
      weights.push(w);
    }
    return cands[r.weighted(weights)] ?? prev;
  };

  interface Mel {
    tick: number;
    deg: number;
    strong: boolean;
  }
  const phrases: Mel[][] = [];
  let prev = Math.round(dLo + (dHi - dLo) * (0.15 + 0.7 * shape(0)));
  prev = choose(rng.fork(9), prev, null, ctx.start, 0, true, false, false);
  let prev2: number | null = null;
  for (let p0 = ctx.start, k = 0; p0 < ctx.end; p0 += phraseLen, k++) {
    const p1 = Math.min(ctx.end, p0 + phraseLen);
    const pr = rng.fork(100 + k);
    if (o.callResponse && k % 2 === 1 && phrases[k - 1]) {
      const call = phrases[k - 1];
      const shift = phraseLen;
      const keep = call.filter((m) => m.tick + shift < p1 && (m.tick - (p0 - phraseLen)) / phraseLen < 0.55);
      const out: Mel[] = keep.map((m) => ({ ...m, tick: m.tick + shift }));
      for (const m of out) {
        const ch = chordOf(m.tick);
        if (!ch || !m.strong || ct < 0.5 || chordPcs(ch).includes(mod12(toMidi(m.deg)))) continue;
        for (const d of [m.deg - 1, m.deg + 1, m.deg - 2, m.deg + 2]) if (d >= dLo && d <= dHi && chordPcs(ch).includes(mod12(toMidi(d)))) {
          m.deg = d;
          break;
        }
      }
      const from = out.length ? out[out.length - 1].tick + 1 : p0;
      const tail = phraseRhythm(o, p0, p1, ctx, pr).filter((s) => s.tick >= from && (s.tick - p0) / phraseLen >= 0.5);
      let pv = out.length ? out[out.length - 1].deg : prev;
      let pv2: number | null = out.length > 1 ? out[out.length - 2].deg : null;
      tail.forEach((s, i) => {
        const last = i === tail.length - 1;
        const d = choose(pr, pv, pv2, s.tick, (s.tick - p0) / phraseLen, s.strong, last, last);
        out.push({ tick: s.tick, deg: d, strong: s.strong });
        pv2 = pv;
        pv = d;
      });
      phrases.push(out);
      prev2 = pv2;
      prev = pv;
      continue;
    }
    const slots = phraseRhythm(o, p0, p1, ctx, pr);
    const out: Mel[] = [];
    slots.forEach((s, i) => {
      const last = i === slots.length - 1;
      const d = i === 0 && k === 0 ? prev : choose(pr, prev, prev2, s.tick, (s.tick - p0) / phraseLen, s.strong, last, last && p1 >= ctx.end);
      out.push({ tick: s.tick, deg: d, strong: s.strong });
      prev2 = prev;
      prev = d;
    });
    phrases.push(out);
  }

  const hum = rng.fork(7);
  const notes: GenNote[] = [];
  phrases.forEach((ph, k) => {
    const p1 = Math.min(ctx.end, ctx.start + (k + 1) * phraseLen);
    ph.forEach((m, i) => {
      const next = ph[i + 1]?.tick;
      const last = next === undefined;
      const room = (next ?? p1) - m.tick;
      const dur = last ? Math.min(room, ctx.beatTicks * 2) * 0.95 : Math.min(room * 0.92, ctx.beatTicks * 2);
      const w = metricWeight(m.tick - ctx.start, ctx.barTicks, ctx.beatTicks);
      notes.push({ tick: m.tick, dur: Math.max(1, Math.round(dur)), key: toMidi(m.deg), vel: vel3(o.velocity + (w >= 0.8 ? 0.07 : w < 0.4 ? -0.07 : 0) + hum.jitter(0.04)) });
    });
  });
  return {
    notes,
    chords: tl.events.length ? chordNames(tl.events, ctx.start, ctx.end) : undefined,
    chordSource: tl.source,
    detail: `${o.contour} contour, ${o.feel}, ${o.phrase}-bar phrases${o.callResponse ? ' with call and response' : ''}${tl.source === 'none' ? '' : `, chord tones from ${tl.label}`}`,
  };
}
