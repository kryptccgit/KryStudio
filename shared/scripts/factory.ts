// The factory Krypt Scripts: ready-made note devices and worked examples of
// the script API (each one is plain JavaScript the user can open in the code
// view, change and "Save as"). Ids are factory:<slug>. test/scripts.test.ts
// runs every one of them in the sandbox and validates the notes.

export interface FactoryScript {
  id: string;
  code: string;
}

const EUCLID = `// @name Euclid with probability
// @kind generator
// @description Euclidean hits spread evenly over the steps; each hit after the first plays with a probability. The first hit is accented.
// @param steps number 16 2..32 step 1 "Steps"
// @param pulses number 5 1..32 step 1 "Pulses"
// @param rotation number 0 0..31 step 1 "Rotation"
// @param chance number 0.85 0..1 step 0.05 "Probability"
// @param rate choice 16th 8th|16th|32nd "Step"
// @param accent number 0.25 0..1 step 0.05 "Accent"
// @param note number 0 0..127 step 1 "Note (0 = the channel's)"

function run({ params, start, end, ppq, rootKey, rand, euclid }) {
  const step = { '8th': ppq / 2, '16th': ppq / 4, '32nd': ppq / 8 }[params.rate];
  const steps = params.steps;
  const hits = euclid(Math.min(params.pulses, steps), steps, params.rotation);
  const first = hits.indexOf(true);
  const key = params.note > 0 ? params.note : rootKey;
  const notes = [];
  for (let t = start, i = 0; t < end; t += step, i++) {
    const s = i % steps;
    if (!hits[s]) continue;
    const accent = s === first;
    if (!accent && !rand.chance(params.chance)) continue;
    const vel = accent ? 0.8 + params.accent * 0.2 : 0.8 - params.accent * 0.35 + rand.range(-0.04, 0.04);
    notes.push({ tick: t, dur: Math.max(1, Math.round(step * 0.9)), key, vel });
  }
  return notes;
}
`;

const STRUM = `// @name Strum and humanize
// @kind transform
// @description Strums chords (notes that start together) down or up like a guitar, then loosens the timing and the velocity a little.
// @param strum number 30 0..120 step 1 "Strum (ms)"
// @param direction choice down down|up|alternate|random "Direction"
// @param timing number 8 0..40 step 1 "Timing (ms)"
// @param velocity number 0.08 0..0.3 step 0.01 "Velocity spread"
// @param keepEnds toggle on "Keep note ends"

function run({ notes, params, bpm, ppq, rand }) {
  const ticks = (ms) => (ms / 1000) * (bpm / 60) * ppq;
  // chords = notes starting on the same tick
  const groups = new Map();
  for (const n of notes) {
    if (!groups.has(n.tick)) groups.set(n.tick, []);
    groups.get(n.tick).push(n);
  }
  const out = [];
  let index = 0;
  for (const tick of [...groups.keys()].sort((a, b) => a - b)) {
    const chord = groups.get(tick).sort((a, b) => a.key - b.key);
    const dir = params.direction;
    // a down-stroke plays the low string first
    const down = dir === 'down' || (dir === 'alternate' && index % 2 === 0) || (dir === 'random' && rand.chance(0.5));
    const order = down ? chord : chord.slice().reverse();
    const gap = chord.length > 1 ? ticks(params.strum) : 0;
    order.forEach((n, i) => {
      const t = Math.max(0, Math.round(tick + i * gap + ticks(rand.range(-params.timing, params.timing))));
      const end = n.tick + n.dur;
      out.push({ ...n, tick: t, dur: params.keepEnds ? Math.max(1, end - t) : n.dur, vel: n.vel + rand.range(-params.velocity, params.velocity) });
    });
    index++;
  }
  return out;
}
`;

const ARP = `// @name Arpeggiator
// @kind transform
// @description Turns held chords into arpeggios: pick a pattern, a rate, how many octaves and a gate. Write or select chords first.
// @param pattern choice up up|down|upDown|downUp|thumb|pinky|converge|random "Pattern"
// @param rate choice 16th 8th|8thT|16th|16thT|32nd "Rate"
// @param octaves number 1 1..4 step 1 "Octaves"
// @param gate number 0.8 0.1..1 step 0.05 "Gate"
// @param accent toggle on "Accent each beat"

function order(keys, pattern) {
  const up = keys;
  const down = keys.slice().reverse();
  switch (pattern) {
    case 'down': return down;
    case 'upDown': return keys.length > 2 ? up.concat(down.slice(1, -1)) : up;
    case 'downUp': return keys.length > 2 ? down.concat(up.slice(1, -1)) : down;
    case 'thumb': {
      const r = [];
      for (const k of up.slice(1)) r.push(up[0], k);
      return r.length ? r : up;
    }
    case 'pinky': {
      const top = up[up.length - 1];
      const r = [];
      for (const k of up.slice(0, -1)) r.push(k, top);
      return r.length ? r : up;
    }
    case 'converge': {
      const r = [];
      let lo = 0;
      let hi = up.length - 1;
      while (lo <= hi) {
        r.push(up[lo++]);
        if (lo <= hi) r.push(up[hi--]);
      }
      return r;
    }
    default: return up;
  }
}

function run({ notes, params, ppq, beatTicks, rand }) {
  const rate = { '8th': ppq / 2, '8thT': ppq / 3, '16th': ppq / 4, '16thT': ppq / 6, '32nd': ppq / 8 }[params.rate];
  // a chord = notes that start within one step of each other; it lasts until its longest note ends
  const chords = [];
  for (const n of notes.slice().sort((a, b) => a.tick - b.tick || a.key - b.key)) {
    const c = chords[chords.length - 1];
    if (c && n.tick - c.tick < rate && n.tick < c.end) {
      c.keys.push(n.key);
      c.end = Math.max(c.end, n.tick + n.dur);
      c.vel = Math.max(c.vel, n.vel);
    } else chords.push({ tick: n.tick, end: n.tick + n.dur, keys: [n.key], vel: n.vel, color: n.color });
  }
  const out = [];
  for (const c of chords) {
    const base = [...new Set(c.keys)].sort((a, b) => a - b);
    const keys = [];
    for (let o = 0; o < params.octaves; o++) for (const k of base) if (k + 12 * o <= 127) keys.push(k + 12 * o);
    const seq = order(keys, params.pattern);
    let i = 0;
    for (let t = c.tick; t < c.end; t += rate, i++) {
      const key = params.pattern === 'random' ? rand.pick(keys) : seq[i % seq.length];
      const onBeat = Math.round(t) % beatTicks === 0;
      const vel = params.accent ? c.vel * (onBeat ? 1 : 0.8) : c.vel;
      const dur = Math.max(1, Math.round(Math.min(rate * params.gate, c.end - t)));
      out.push({ tick: Math.round(t), dur, key, vel, color: c.color });
    }
  }
  return out;
}
`;

const MARKOV = `// @name Markov melody
// @kind generator
// @description A melody in the key from a Markov chain over scale degrees: mostly steps, a few leaps, chord tones on the beat, and phrases that come home to the root.
// @param octave number 4 2..6 step 1 "Octave"
// @param range number 9 5..15 step 1 "Range (scale steps)"
// @param density number 0.6 0.1..1 step 0.05 "Density"
// @param rate choice 8th 4th|8th|16th "Rate"
// @param leaps number 0.2 0..0.8 step 0.05 "Leaps"
// @param phrase choice 2 1|2|4 "Phrase (bars)"
// @param answer toggle on "Answer the first phrase"

function run({ params, start, end, barTicks, beatTicks, ppq, rand, degree, chordAt, scaleSteps }) {
  const step = { '4th': ppq, '8th': ppq / 2, '16th': ppq / 4 }[params.rate];
  const phraseTicks = Number(params.phrase) * barTicks;
  const top = params.range;
  const pitch = (d) => degree(d, params.octave);
  const weightsFrom = (d, t) => {
    const chord = chordAt(t);
    const strong = t % beatTicks === 0;
    const w = [];
    for (let n = 0; n <= top; n++) {
      const dist = Math.abs(n - d);
      let p = dist === 0 ? 0.35 : dist === 1 ? 1.5 : dist === 2 ? 0.9 : dist <= 4 ? params.leaps * 1.2 : params.leaps * 0.25;
      const deg = n % scaleSteps.length;
      if (deg === 0 || deg === 2 || deg === 4) p *= 1.2;
      if (strong && chord && chord.keys.some((k) => (k - pitch(n)) % 12 === 0)) p *= 2;
      w.push(p);
    }
    return w;
  };
  const phraseNotes = (from, to, d0) => {
    const out = [];
    let d = d0;
    for (let t = from; t < to; t += step) {
      const strong = (t - from) % beatTicks === 0;
      if (!rand.chance(strong ? Math.min(1, params.density * 1.3) : params.density * 0.8)) continue;
      d = rand.weighted(weightsFrom(d, t));
      out.push({ tick: t, deg: d, vel: strong ? 0.82 : 0.68 + rand.range(-0.05, 0.05) });
    }
    // end the phrase home: the nearest root
    if (out.length) {
      const last = out[out.length - 1];
      const n = scaleSteps.length;
      last.deg = Math.min(top - (top % n), Math.round(last.deg / n) * n);
    }
    return out;
  };
  const notes = [];
  let call = null;
  for (let p = start, i = 0; p < end; p += phraseTicks, i++) {
    const pEnd = Math.min(end, p + phraseTicks);
    let phrase;
    if (params.answer && i % 2 === 1 && call) {
      // the answer repeats the first half of the call, then ends its own way
      const half = p + Math.floor((pEnd - p) / 2 / step) * step;
      const head = call.filter((x) => x.tick + phraseTicks < half).map((x) => ({ ...x, tick: x.tick + phraseTicks }));
      phrase = head.concat(phraseNotes(half, pEnd, head.length ? head[head.length - 1].deg : Math.floor(top / 2)));
    } else {
      phrase = phraseNotes(p, pEnd, Math.floor(top / 2));
      call = phrase;
    }
    phrase.forEach((x, j) => {
      const next = j + 1 < phrase.length ? phrase[j + 1].tick : pEnd;
      notes.push({ tick: x.tick, dur: Math.max(1, Math.round(Math.min(next - x.tick, step * 2) * 0.92)), key: pitch(x.deg), vel: x.vel });
    });
  }
  return notes;
}
`;

const RATCHET = `// @name Ratchet
// @kind transform
// @description Repeats notes in fast bursts (ratchets, rolls, stutters) with a velocity ramp. Each note ratchets with a chance, so re-roll the seed for another take.
// @param repeats number 3 2..8 step 1 "Repeats"
// @param rate choice 32nd 16th|16thT|32nd|64th "Rate"
// @param chance number 0.5 0..1 step 0.05 "Chance per note"
// @param ramp choice down down|up|flat "Velocity ramp"
// @param pitch number 0 -12..12 step 1 "Pitch step (semitones)"
// @param fit toggle on "Fit inside the note"

function run({ notes, params, ppq, rand }) {
  const rate = { '16th': ppq / 4, '16thT': ppq / 6, '32nd': ppq / 8, '64th': ppq / 16 }[params.rate];
  const out = [];
  for (const n of notes) {
    let count = params.repeats;
    if (params.fit) count = Math.min(count, Math.floor(n.dur / rate));
    if (count < 2 || !rand.chance(params.chance)) {
      out.push(n);
      continue;
    }
    for (let i = 0; i < count; i++) {
      const f = i / (count - 1);
      const gain = params.ramp === 'down' ? 1 - 0.5 * f : params.ramp === 'up' ? 0.5 + 0.5 * f : 1;
      out.push({ ...n, tick: Math.round(n.tick + i * rate), dur: Math.max(1, Math.round(rate * 0.8)), key: n.key + i * params.pitch, vel: n.vel * gain });
    }
  }
  return out;
}
`;

const VELOCITY = `// @name Velocity shaper
// @kind transform
// @description Reshapes velocities: a curve over the bars (ramp up, ramp down, swell, dip), accents on the beat, evening out and a touch of randomness.
// @param shape choice swell none|rampUp|rampDown|swell|dip "Curve"
// @param depth number 0.4 0..1 step 0.05 "Curve depth"
// @param accents choice beats none|beats|downbeats|backbeat|offbeats "Accents"
// @param accent number 0.15 0..0.5 step 0.01 "Accent amount"
// @param even number 0 0..1 step 0.05 "Even out"
// @param random number 0.03 0..0.2 step 0.01 "Random"

function run({ notes, params, start, end, beatTicks, barTicks, rand, clamp }) {
  const span = Math.max(1, end - start);
  return notes.map((n) => {
    const x = clamp((n.tick - start) / span, 0, 1);
    let curve = 1;
    if (params.shape === 'rampUp') curve = 1 - params.depth * (1 - x);
    else if (params.shape === 'rampDown') curve = 1 - params.depth * x;
    else if (params.shape === 'swell') curve = 1 - params.depth * (1 - Math.sin(Math.PI * x));
    else if (params.shape === 'dip') curve = 1 - params.depth * Math.sin(Math.PI * x);
    const inBar = n.tick % barTicks;
    const inBeat = n.tick % beatTicks;
    const beat = Math.floor(inBar / beatTicks);
    const accented =
      params.accents === 'beats' ? inBeat === 0 :
      params.accents === 'downbeats' ? inBar === 0 :
      params.accents === 'backbeat' ? inBeat === 0 && beat % 2 === 1 :
      params.accents === 'offbeats' ? inBeat === beatTicks / 2 : false;
    let v = n.vel + (0.75 - n.vel) * params.even;
    v = v * curve + (accented ? params.accent : 0) + rand.range(-params.random, params.random);
    return { ...n, vel: clamp(v, 0.02, 1) };
  });
}
`;

export const FACTORY_SCRIPTS: FactoryScript[] = [
  { id: 'factory:euclid-chance', code: EUCLID },
  { id: 'factory:markov-melody', code: MARKOV },
  { id: 'factory:arpeggiator', code: ARP },
  { id: 'factory:strum-humanize', code: STRUM },
  { id: 'factory:ratchet', code: RATCHET },
  { id: 'factory:velocity-shaper', code: VELOCITY },
];

/** The starting point of "New script" in the code view. */
export const NEW_SCRIPT_TEMPLATE = `// @name My device
// @kind transform
// @description Shifts every note by an interval and keeps it in the key.
// @param interval number 7 -24..24 step 1 "Interval (semitones)"
// @param keep toggle on "Keep the original notes"

// ctx: notes, params, key, scale, scaleSteps, keyName, bpm, timeSig, ppq, barTicks, beatTicks,
// stepTicks, start, end, lengthTicks, bars, chords, rootKey, seed, rand() (seeded: rand.int,
// rand.range, rand.chance, rand.pick, rand.weighted, rand.shuffle), inScale, snap, degree,
// euclid, chordAt, clamp, log. Return notes: { tick, dur, key, vel (0..1) }.
function run({ notes, params, snap }) {
  const moved = notes.map((n) => ({ ...n, key: snap(n.key + params.interval) }));
  return params.keep ? notes.concat(moved) : moved;
}
`;
