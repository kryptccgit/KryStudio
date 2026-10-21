// KPN — Krypt Pattern Notation (research/04 §10). Parser, canonical printer,
// symbolic stats and the cheat sheet shared by the MCP tools, the built-in
// agent and the renderer (ghost-note previews).

export * from './types';
export {
  parse,
  formatIssues,
  defaultGrid,
  defaultLenSteps,
  chordSymbolToMidi,
  chordIntervals,
  CHORD_ALIASES,
  KPN_VERSION,
  DEFAULT_DRUM_KEY,
  DEFAULT_OCTAVE,
  DEFAULT_VELOCITY,
} from './parse';
export { print, printKpn, midiVelocity, prefersFlats } from './print';
export { symbolicStats, estimateKey, type SymbolicStats, type SymbolicChannel, type SymbolicNote, type ChannelStats } from './symbolic';
export { KPN_REFERENCE, KPN_SHORT } from './reference';
