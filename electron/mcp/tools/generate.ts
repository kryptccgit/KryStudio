import { z } from 'zod';
import { parseKey } from '@shared/music/theory';
import { ticksPerBar } from '@shared/schema/time';
import { ARP_OPTIONS, BASS_OPTIONS, CHORD_OPTIONS, GENERATOR_LABELS, MELODY_OPTIONS, RHYTHM_OPTIONS, type GeneratorKind } from '@shared/music/generate';
import { defineTool, fail } from './types';
import { findChannel, findPattern, parseBarRange, plural, safeName } from './util';

const zGenerator = z.discriminatedUnion('kind', [
  RHYTHM_OPTIONS.extend({ kind: z.literal('rhythm') }),
  CHORD_OPTIONS.extend({ kind: z.literal('chords') }),
  ARP_OPTIONS.extend({ kind: z.literal('arp') }),
  MELODY_OPTIONS.extend({ kind: z.literal('melody') }),
  BASS_OPTIONS.extend({ kind: z.literal('bass') }),
]);

interface GenerateResult {
  ids: string[];
  count: number;
  removed: number;
  skipped: number;
  kind: GeneratorKind;
  seed: number;
  key: string;
  keySource: 'given' | 'pattern' | 'project' | 'default';
  range: { fromBar: number; bars: number };
  chords?: string[];
  chordSource?: 'pattern' | 'progression' | 'none';
  detail: string;
  extendedTo: number | null;
}

const KEY_FROM: Record<GenerateResult['keySource'], string> = { given: '', pattern: ', read from the pattern', project: ', read from the project', default: ', the default: pass key to choose' };

export const generateNotes = defineTool({
  name: 'generate_notes',
  title: 'Generate notes',
  kind: 'write',
  description: [
    'Quick drafts and variations: generate a part into one channel of a pattern, in key, as ONE undo step. Seeded: the same seed gives the same notes, another seed (or none) a new take; the result names the seed, so you can re-roll or come back to a take.',
    'generator.kind: rhythm {mode euclid|density, steps, pulses, rotation, rate 4th|8th|8thT|16th|16thT|32nd, density, accents none|downbeats|backbeat|offbeats|random, ghosts, rolls (32nd hat rolls), note} | chords {progression, extensions auto|triads|sevenths|ninths, voicing close|open|spread, inversion auto (voice leading)|root|first|second|third, rhythm whole|halves|quarters|stabs|offbeat|pulse, barsPerChord 0.5|1|2|4, octave} | arp {chords auto|pattern|progression, progression, style up|down|upDown|downUp|converge|random, rate, octaves, gate} | melody {contour rise|fall|arch|valley|wave, low, high (MIDI), density, feel quarters|8ths|16ths|syncopated, phrase 1|2|4 bars, callResponse, chordTones, chords auto|pattern|progression|none} | bass {style root|rootFifth|octave|walking|glide808 (slide notes), rhythm auto|whole|halves|quarters|eighths|offbeat|tresillo|trap|funk, octave, passing, chords}.',
    'progression: a preset (pop, sad, epic, dark, jazzy, lofi, house, circle), "auto" (the seed picks), or numerals in the key: "i VI III VII", "ii7 V7 Imaj7", "I bVII IV", "1 5 6 4". The arp, bass and melody follow the chords already in the pattern (3+ notes together on any channel) when there are any.',
    'key defaults to the key the pattern is in (else the project). bars "1-4" (default: the whole pattern). mode replace (default) rewrites the channel in those bars; merge adds. For hand-written parts use write_pattern (KPN); to reshape notes use transform_notes / shape_notes.',
    'Example: {"channel":"Bass","generator":{"kind":"bass","style":"glide808"},"bars":"1-4"}',
  ].join('\n'),
  input: z.object({
    channel: z.string().describe('Channel name or id to write into.'),
    pattern: z.string().max(80).optional().describe('Pattern id or name; default the active pattern.'),
    generator: zGenerator,
    key: z.string().max(24).optional().describe('Key, e.g. "F#m", "C", "D dorian", "A minorPentatonic". Default: the key the pattern is in.'),
    bars: z.string().max(16).optional().describe('"1-4" (1-based, inclusive). Default: the whole pattern.'),
    mode: z.enum(['replace', 'merge']).default('replace'),
    seed: z.number().int().min(0).max(2147483647).optional().describe('Omit for a fresh take; reuse a seed from an earlier result to get that take again.'),
    change_label: z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel."),
  }),
  summarize: (a) => `${a.generator.kind} on ${safeName(a.channel, 30)}${a.bars ? ` bars ${safeName(a.bars, 12)}` : ''}`,
  run(deps, _c, a, ctx) {
    const p = deps.doc.project;
    const pat = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const { kind, ...options } = a.generator;
    let key: { root: number; scale: string } | undefined;
    if (a.key) {
      const k = parseKey(a.key);
      if (!k) fail(`Unknown key "${safeName(a.key, 24)}" (use e.g. "F#m", "C", "D dorian", "A minorPentatonic")`);
      key = { root: k.root, scale: k.scale };
    }
    const bar = ticksPerBar(p.transport.timeSig);
    const range = a.bars ? (({ start, bars }) => ({ fromBar: start / bar + 1, bars }))(parseBarRange(a.bars, p.transport.timeSig)) : undefined;
    const seed = a.seed ?? Math.floor(Math.random() * 2 ** 31);
    const r = ctx.exec<GenerateResult>('notes.generate', { patternId: pat.id, channelId: ch.id, kind, options, seed, key, range, mode: a.mode });
    const { fromBar, bars } = r.range;
    const where = bars === 1 ? `bar ${fromBar}` : `bars ${fromBar}–${fromBar + bars - 1}`;
    const chords = r.chords?.length ? ` Chords: ${r.chords.join(' ')} (${r.chordSource === 'pattern' ? 'followed from the pattern' : r.chordSource === 'progression' ? 'from the progression' : 'none'}).` : '';
    const replaced = r.removed ? ` Replaced ${plural(r.removed, 'note')}.` : '';
    const skipped = r.skipped ? ` ${plural(r.skipped, 'note')} already there were not doubled.` : '';
    const grown = r.extendedTo ? ` The pattern grew to ${r.extendedTo / bar} bars.` : '';
    return {
      ok: true,
      message: `${GENERATOR_LABELS[kind]} on ${safeName(ch.name)} in "${safeName(pat.name)}": ${plural(r.count, 'note')} in ${where}, ${r.key}${KEY_FROM[r.keySource]}, seed ${r.seed} (${r.detail}).${chords}${replaced}${skipped}${grown} Same seed = same notes; call again with another seed (or none) for a new take, or undo_last to drop it.`,
      changed: [],
      data: { seed: r.seed, key: r.key, bars: { from: fromBar, count: bars }, notes: r.count, chords: r.chords ?? [] },
    };
  },
});

export const GENERATE_TOOLS = [generateNotes];
