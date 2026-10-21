import type { KryptApi } from '@shared/types';
import { MASHUP_RIGHTS_NOTE, type MashupCheck, type MashupPlanSummary, type MashupProgress, type MashupRequest, type MashupSongReading } from '@shared/mashup/types';

const reading = (name: string, bpm: number, key: string, vocal: number): MashupSongReading => ({
  name,
  durationSec: 200 + (name.length % 40),
  bpm,
  bpmAlternatives: [bpm / 2, bpm * 2],
  key,
  keyConfidence: 0.78,
  vocalPresence: vocal,
  sections: [
    { name: 'Intro', startBar: 0, bars: 8, energy: 0.3, vocal: false },
    { name: 'Verse', startBar: 8, bars: 16, energy: 0.5, vocal: true },
    { name: 'Chorus', startBar: 24, bars: 16, energy: 0.9, vocal: true },
    { name: 'Outro', startBar: 40, bars: 8, energy: 0.3, vocal: false },
  ],
  stems: [],
});

const srcName = (s: MashupRequest['a'], fallback: string): string => ('path' in s ? s.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || fallback : fallback);

function plan(req: MashupRequest): MashupPlanSummary {
  const vocalFrom = req.style === 'vocalOverBeat' ? (req.vocalFrom === 'b' ? 'b' : 'a') : null;
  const fa = req.factorA ?? 1;
  const fb = req.factorB ?? 1;
  const bpm = req.anchor === 'vocal' ? 96 * fa : req.anchor === 'middle' ? 110 : 124 * fb;
  const bars = req.bars ?? 64;
  const v = vocalFrom === 'b' ? 'B' : 'A';
  const beat = vocalFrom === 'b' ? 'A' : 'B';
  const sections =
    req.style === 'backAndForth'
      ? [
          { name: 'Intro', uses: 'A intro' },
          { name: 'A chorus', uses: 'A' },
          { name: 'B drop', uses: 'B' },
          { name: 'A verse', uses: 'A' },
          { name: 'B outro', uses: 'B' },
        ]
      : req.style === 'stemBlend'
        ? [
            { name: 'Intro', uses: 'B drums + other' },
            { name: 'Verse', uses: 'A vocals + B drums, bass' },
            { name: 'Chorus', uses: 'A vocals + B drums, bass, other' },
            { name: 'Outro', uses: 'B other' },
          ]
        : [
            { name: 'Intro', uses: `${beat} beat` },
            { name: 'Verse', uses: `${v} vocal + ${beat} beat` },
            { name: 'Chorus', uses: `${v} vocal + ${beat} beat` },
            { name: 'Break', uses: `${beat} beat` },
            { name: 'Outro', uses: `${beat} beat` },
          ];
  const each = Math.max(4, Math.floor(bars / sections.length / 4) * 4);
  let at = 0;
  const placed = sections.map((s, i) => {
    const len = i === sections.length - 1 ? Math.max(4, bars - at) : each;
    const out = { ...s, startBar: at, bars: len };
    at += len;
    return out;
  });
  return {
    style: req.style,
    vocalFrom,
    bpm,
    key: 'F minor',
    shiftA: { stretch: (96 * fa) / bpm, semitones: req.anchor === 'vocal' ? 0 : 2 },
    shiftB: { stretch: (124 * fb) / bpm, semitones: req.anchor === 'beat' ? 0 : -1 },
    sections: placed,
    bars: at,
  };
}

export function createMockMashup(): KryptApi['mashup'] {
  const listeners = new Set<(p: MashupProgress) => void>();
  let cancelled = false;
  const emit = (p: MashupProgress): void => listeners.forEach((cb) => cb(p));
  const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

  const check = async (req: MashupRequest): Promise<{ ok: true; data: MashupCheck }> => {
    await wait(700);
    const p = plan(req);
    const a = reading(srcName(req.a, 'Song A'), 96, 'G minor', 0.62);
    const b = reading(srcName(req.b, 'Song B'), 124, 'F minor', 0.08);
    const halfB = (req.factorB ?? 1) === 0.5;
    return {
      ok: true,
      data: {
        a,
        b,
        score: halfB ? 58 : req.style === 'backAndForth' ? 66 : 78,
        reasons: [
          `Tempo: ${p.bpm} BPM; A is stretched ${p.shiftA.stretch.toFixed(2)}× and B ${p.shiftB.stretch.toFixed(2)}×`,
          'Keys: G minor and F minor are a whole step apart: A moves +2 st',
          "Vocals: A has a lead vocal through most of it; B is nearly instrumental",
        ],
        plan: p,
        suggestions: halfB ? ['Use B as detected: stretch ×1.03 instead of ×0.52'] : ['Try Krypt Tune off: the vocal is already in tune', 'Use B at half time for a laid-back feel: stretch ×0.52'],
        problems: [],
      },
    };
  };

  return {
    check,
    build: async (req) => {
      cancelled = false;
      const stages: MashupProgress['stage'][] = ['reading', 'separating', 'analyzing', 'planning', 'building', 'mixing'];
      for (let i = 0; i < stages.length; i++) {
        if (cancelled) return { ok: false, message: 'Cancelled' };
        emit({ stage: stages[i], fraction: i / stages.length, message: `Browser preview: ${stages[i]}…` });
        await wait(600);
      }
      const p = plan(req);
      return {
        ok: true,
        data: {
          name: 'Mashup preview',
          plan: p,
          score: 78,
          notes: ['Browser preview: nothing was added to the project.', "A's vocal is pitched +2 st: listen for artefacts."],
          tracks: 6,
          rightsNote: MASHUP_RIGHTS_NOTE,
        },
      };
    },
    cancel: async () => {
      cancelled = true;
      return { ok: true };
    },
    onProgress: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
