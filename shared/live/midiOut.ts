// ──────────────────────────────────────────────────────────────────────
// MIDI outputs, clock out and sync in: settings defaults / validation and
// the small decisions main makes (Wave 12.2b, docs/ENGINE_PROTOCOL.md §14).
// Pure: no I/O.
// ──────────────────────────────────────────────────────────────────────

import type { MidiOutSettings, Settings } from '../types';

export const MAX_CLOCK_OFFSET_MS = 100;

export const DEFAULT_MIDI_OUT: MidiOutSettings = {
  outputs: {},
  clockPorts: [],
  clockOffsetMs: 0,
  syncInput: null,
  syncWritesTempo: true,
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const id = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.slice(0, 200) : null);

/** The MIDI-out settings in a Settings object (defaults filled). */
export function midiOutSettings(s: Pick<Settings, 'midiOut'> | null | undefined): MidiOutSettings {
  const m = s?.midiOut;
  return { ...DEFAULT_MIDI_OUT, ...(m ?? {}), outputs: { ...(m?.outputs ?? {}) }, clockPorts: [...(m?.clockPorts ?? [])] };
}

/** Validate an untrusted partial (settings.json / a renderer patch) over a base. */
export function mergeMidiOut(base: MidiOutSettings | undefined, input: unknown): MidiOutSettings {
  const b = midiOutSettings({ midiOut: base });
  if (input === undefined) return b;
  const o = obj(input);
  let outputs = b.outputs;
  if ('outputs' in o) {
    outputs = {};
    for (const [k, v] of Object.entries(obj(o.outputs)).slice(0, 256)) if (id(k) && typeof v === 'boolean') outputs[k.slice(0, 200)] = v;
  }
  let clockPorts = b.clockPorts;
  if (Array.isArray(o.clockPorts)) {
    clockPorts = [];
    for (const p of o.clockPorts.slice(0, 32)) {
      const x = id(p);
      if (x && !clockPorts.includes(x)) clockPorts.push(x);
    }
  }
  const off = typeof o.clockOffsetMs === 'number' && Number.isFinite(o.clockOffsetMs) ? Math.max(-MAX_CLOCK_OFFSET_MS, Math.min(MAX_CLOCK_OFFSET_MS, Math.round(o.clockOffsetMs * 10) / 10)) : b.clockOffsetMs;
  return {
    outputs,
    clockPorts,
    clockOffsetMs: off,
    syncInput: 'syncInput' in o ? id(o.syncInput) : b.syncInput,
    syncWritesTempo: typeof o.syncWritesTempo === 'boolean' ? o.syncWritesTempo : b.syncWritesTempo,
  };
}

/** The outputs main asks the engine to open: the user's, the clock ports and the grid-LED port (sorted, unique). */
export function outputsToOpen(m: MidiOutSettings, ledPort: string | null): string[] {
  const set = new Set<string>();
  for (const [k, on] of Object.entries(m.outputs)) if (on) set.add(k);
  for (const p of m.clockPorts) set.add(p);
  if (ledPort) set.add(ledPort);
  return [...set].sort();
}

/**
 * The project tempo to write when the external clock stops (rounded to 0.1 bpm), or null when it is (nearly)
 * the project's already or unknown.
 */
export function syncTempoToWrite(externalBpm: number | null | undefined, projectBpm: number): number | null {
  if (typeof externalBpm !== 'number' || !Number.isFinite(externalBpm) || externalBpm < 10 || externalBpm > 999) return null;
  const r = Math.round(externalBpm * 10) / 10;
  return Math.abs(r - projectBpm) >= 0.05 ? r : null;
}
