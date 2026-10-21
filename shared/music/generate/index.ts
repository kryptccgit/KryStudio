import type { GenContext, GenOutput } from './context';
import type { GeneratorKind, GeneratorOptions } from './options';
import { generateRhythm } from './rhythm';
import { generateArp, generateBass, generateChords } from './parts';
import { generateMelody } from './melody';

export * from './options';
export * from './context';
export { GenerateError, PROGRESSIONS, detectChords, keyName, inKey, identifyChord, voiceDistance, type GenKey, type ChordEvent } from './harmony';
export { euclid, euclidString } from './rhythm';
export { arpCycle } from './parts';
export { makeRng, variationSeed } from './random';

export function runGenerator<K extends GeneratorKind>(kind: K, options: GeneratorOptions[K], ctx: GenContext): GenOutput {
  switch (kind) {
    case 'rhythm':
      return generateRhythm(options as GeneratorOptions['rhythm'], ctx);
    case 'chords':
      return generateChords(options as GeneratorOptions['chords'], ctx);
    case 'arp':
      return generateArp(options as GeneratorOptions['arp'], ctx);
    case 'melody':
      return generateMelody(options as GeneratorOptions['melody'], ctx);
    case 'bass':
      return generateBass(options as GeneratorOptions['bass'], ctx);
  }
  throw new Error(`unknown generator ${String(kind)}`);
}
