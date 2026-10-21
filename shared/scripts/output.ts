import { z } from 'zod';
import { PPQ } from '../schema/time';
import { SCRIPT_LIMITS, type ScriptNote } from './types';

const fin = z.number().refine(Number.isFinite, 'must be a finite number');

export const zScriptNoteOut = z.object({
  tick: fin,
  dur: fin,
  key: fin,
  vel: fin.optional(),
  pan: fin.optional(),
  release: fin.optional(),
  fine: fin.optional(),
  slide: z.boolean().optional(),
  mute: z.boolean().optional(),
  color: fin.optional(),
});

export const zScriptOutput = z.union([z.array(z.unknown()), z.object({ notes: z.array(z.unknown()) })]);

export const MAX_SCRIPT_TICK = 4096 * 4 * PPQ;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export type CleanOutput = { ok: true; notes: ScriptNote[] } | { ok: false; message: string };

export function cleanScriptOutput(raw: unknown): CleanOutput {
  if (raw === undefined || raw === null) return { ok: false, message: 'run() returned nothing: return an array of notes ({ tick, dur, key, vel })' };
  const shape = zScriptOutput.safeParse(raw);
  if (!shape.success) return { ok: false, message: `run() must return an array of notes (or { notes: [...] }), not ${Array.isArray(raw) ? 'that' : typeof raw}` };
  const list = Array.isArray(shape.data) ? shape.data : shape.data.notes;
  if (list.length > SCRIPT_LIMITS.notes) return { ok: false, message: `run() returned ${list.length} notes; the limit is ${SCRIPT_LIMITS.notes}` };
  const notes: ScriptNote[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = zScriptNoteOut.safeParse(list[i]);
    if (!r.success) {
      const iss = r.error.issues[0];
      const field = iss?.path.length ? String(iss.path[0]) : null;
      const what = list[i] === null || typeof list[i] !== 'object' ? `is ${list[i] === null ? 'null' : typeof list[i]}, not a note object` : field ? `${field} ${iss.code === 'invalid_type' ? `must be a ${iss.expected === 'boolean' ? 'boolean' : 'number'}` : iss.message}` : iss?.message ?? 'is not a note';
      return { ok: false, message: `Note ${i} (notes[${i}]) ${what}` };
    }
    const n = r.data;
    const vel = n.vel === undefined ? 0.78 : n.vel > 1 ? n.vel / 127 : n.vel;
    const out: ScriptNote = {
      tick: clamp(Math.round(n.tick), 0, MAX_SCRIPT_TICK),
      dur: clamp(Math.round(n.dur), 1, 64 * 4 * PPQ),
      key: clamp(Math.round(n.key), 0, 127),
      vel: Math.round(clamp(vel, 0, 1) * 1000) / 1000,
    };
    if (n.pan !== undefined) out.pan = clamp(n.pan, -1, 1);
    if (n.release !== undefined) out.release = clamp(n.release, 0, 1);
    if (n.fine !== undefined) out.fine = clamp(n.fine, -100, 100);
    if (n.slide) out.slide = true;
    if (n.mute) out.mute = true;
    if (n.color !== undefined) out.color = clamp(Math.round(n.color), 0, 15);
    notes.push(out);
  }
  return { ok: true, notes };
}
