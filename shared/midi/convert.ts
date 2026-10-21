// Project ⇄ Standard MIDI File conversion. Pure TS.
//
// Import: every MIDI track (format-0 files split by MIDI channel) becomes
// one instrument channel in ONE new pattern; ticks are rescaled to PPQ 960
// and velocity 1..127 maps to 0..1.
// Export: one pattern's channels (in Channel Rack order) become format-1
// tracks after a conductor track carrying the project tempo + meter.

import type { Project } from '../schema/project';
import { PPQ } from '../schema/time';
import { convertPpq, type SmfFile, type SmfNote, type SmfTrack } from './smf';

export interface MidiImportNote {
  tick: number;
  dur: number;
  key: number;
  /** 0..1 */
  vel: number;
}

export interface MidiImportTrack {
  name: string;
  notes: MidiImportNote[];
}

export interface MidiImportPlan {
  tracks: MidiImportTrack[];
  /** First tempo in the file, if any. */
  bpm: number | null;
  timeSig: { num: number; den: number } | null;
  noteCount: number;
}

const MAX_NAME = 64;

function trackLabel(t: SmfTrack, index: number, channel: number | null): string {
  const base = t.name || `MIDI ${index + 1}`;
  const label = channel === null ? base : `${base} (ch ${channel + 1})`;
  return label.slice(0, MAX_NAME);
}

/** Turn a parsed SMF into per-channel note lists at PPQ 960. Empty tracks are dropped. */
export function planMidiImport(file: SmfFile): MidiImportPlan {
  const f = convertPpq(file, PPQ);
  const tracks: MidiImportTrack[] = [];
  f.tracks.forEach((t, i) => {
    if (t.notes.length === 0) return;
    const byChannel = new Map<number, SmfNote[]>();
    for (const n of t.notes) {
      let list = byChannel.get(n.channel);
      if (!list) byChannel.set(n.channel, (list = []));
      list.push(n);
    }
    const split = byChannel.size > 1;
    for (const [ch, notes] of [...byChannel.entries()].sort((a, b) => a[0] - b[0])) {
      tracks.push({
        name: trackLabel(t, i, split ? ch : null),
        notes: notes.map((n) => ({
          tick: Math.max(0, Math.round(n.tick)),
          dur: Math.max(1, Math.round(n.dur)),
          key: Math.max(0, Math.min(127, n.key)),
          vel: Math.max(0, Math.min(1, n.vel / 127)),
        })),
      });
    }
  });
  const first = f.tempos[0];
  const ts = f.timeSigs[0];
  return {
    tracks,
    bpm: first ? Math.round(first.bpm * 100) / 100 : null,
    timeSig: ts ? { num: ts.num, den: ts.den } : null,
    noteCount: tracks.reduce((s, t) => s + t.notes.length, 0),
  };
}

/** MIDI channel for the i-th exported track (skips 10, the GM drum channel). */
function exportChannel(i: number): number {
  return (i < 9 ? i : i + 1) % 16;
}

/** Build a format-1 SMF (PPQ 960) from one pattern. Throws if the pattern doesn't exist. */
export function patternToSmf(project: Project, patternId: string): SmfFile {
  const pat = project.patterns[patternId];
  if (!pat) throw new Error(`Pattern ${patternId} not found`);
  const order = [...project.channelOrder, ...Object.keys(pat.notes).filter((id) => !project.channelOrder.includes(id))];
  const tracks: SmfTrack[] = [];
  for (const chId of order) {
    const notes = pat.notes[chId];
    if (!notes || Object.keys(notes).length === 0) continue;
    const midiCh = exportChannel(tracks.length);
    tracks.push({
      name: project.channels[chId]?.name ?? chId,
      program: null,
      notes: Object.values(notes)
        .filter((n) => !n.mute) // muted notes never play, so they don't export either
        .sort((a, b) => a.tick - b.tick || a.key - b.key)
        .map((n) => ({
          tick: n.tick,
          dur: Math.max(1, n.dur),
          key: n.key,
          vel: Math.max(1, Math.min(127, Math.round(n.vel * 127))),
          // FL maps note colour groups to MIDI channels; colour 0 keeps the track's channel
          channel: n.color ? n.color : midiCh,
        })),
    });
  }
  return {
    format: 1,
    ppq: PPQ,
    tracks,
    tempos: [{ tick: 0, bpm: project.transport.bpm }],
    timeSigs: [{ tick: 0, num: project.transport.timeSig.num, den: project.transport.timeSig.den }],
  };
}
