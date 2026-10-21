// In-app editor clipboard (notes are stored relative to the earliest note so
// they paste at any position, into any channel/pattern). Pure helpers are
// unit-tested; the module-level slot survives panel remounts.

import type { Clip, Note } from '@shared/schema/project';
import type { NoteInput } from '@shared/commands/notes';

export interface NoteClipboard {
  /** Notes with tick relative to the earliest copied note. */
  notes: Array<Omit<Note, 'id'>>;
  /** Span from the first start to the last end (ticks). */
  span: number;
}

let notesSlot: NoteClipboard | null = null;
let clipsSlot: ClipClipboard | null = null;

/** Playlist clips as snapshots, so a paste works after Cut (or after the originals were deleted). */
export interface ClipClipboard {
  clips: Array<Omit<Clip, 'id'>>;
  minStart: number;
}

export function makeNoteClipboard(notes: Note[]): NoteClipboard | null {
  if (!notes.length) return null;
  let t0 = Infinity;
  let t1 = 0;
  for (const n of notes) {
    t0 = Math.min(t0, n.tick);
    t1 = Math.max(t1, n.tick + n.dur);
  }
  return {
    notes: notes.map(({ id: _id, ...rest }) => ({ ...rest, tick: rest.tick - t0 })),
    span: t1 - t0,
  };
}

/** Clipboard notes placed at `at` ticks, as notes.add inputs. */
export function pasteNotes(cb: NoteClipboard, at: number): NoteInput[] {
  const base = Math.max(0, Math.round(at));
  return cb.notes.map((n) => ({
    tick: base + n.tick,
    key: n.key,
    dur: n.dur,
    vel: n.vel,
    pan: n.pan,
    release: n.release,
    fine: n.fine,
    slide: n.slide,
    modX: n.modX,
    modY: n.modY,
  }));
}

export function setNoteClipboard(cb: NoteClipboard | null): void {
  notesSlot = cb;
}
export function getNoteClipboard(): NoteClipboard | null {
  return notesSlot;
}

export function setClipClipboard(clips: Clip[]): void {
  clipsSlot = clips.length ? { clips: clips.map(({ id: _id, ...rest }) => ({ ...rest })), minStart: Math.min(...clips.map((c) => c.start)) } : null;
}
export function getClipClipboard(): ClipClipboard | null {
  return clipsSlot;
}

/** Shift used by Ctrl+B duplicate: the selection span rounded up to the grid (min one grid cell). */
export function duplicateShift(minStart: number, maxEnd: number, grid: number): number {
  const span = Math.max(1, maxEnd - minStart);
  if (grid <= 1) return span;
  return Math.max(grid, Math.ceil(span / grid - 1e-9) * grid);
}
