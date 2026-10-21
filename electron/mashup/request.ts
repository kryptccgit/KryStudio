import { z } from 'zod';
import type { MashupRequest } from '@shared/mashup/types';
import { toKeyRef } from '@shared/music/keymatch';

const zSide = z.enum(['a', 'b']).nullable();
const zFactor = z.union([z.literal(1), z.literal(0.5), z.literal(2)]);
const zSource = z.union([z.object({ clipId: z.string().min(1).max(200) }), z.object({ path: z.string().max(1024) })]);

export const zMashupRequest = z.object({
  a: zSource,
  b: zSource,
  style: z.enum(['vocalOverBeat', 'stemBlend', 'backAndForth']),
  vocalFrom: z.enum(['a', 'b', 'auto']).optional(),
  stems: z.object({ vocals: zSide, drums: zSide, bass: zSide, other: zSide }).optional(),
  anchor: z.enum(['beat', 'vocal', 'middle']).optional(),
  bpm: z.number().min(40).max(300).optional(),
  key: z.string().max(32).optional(),
  factorA: zFactor.optional(),
  factorB: zFactor.optional(),
  tune: z.enum(['off', 'natural', 'pop', 'hard']).optional(),
  bars: z.number().int().min(8).max(512).optional(),
  newProject: z.boolean().optional(),
  transitions: z.boolean().optional(),
});

export function cleanMashupRequest(raw: unknown): MashupRequest | string {
  const r = zMashupRequest.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    return `The mashup request is invalid (${i?.path.length ? `${i.path.join('.')}: ` : ''}${i?.message ?? 'unknown problem'})`;
  }
  const req = r.data as MashupRequest;
  if (req.key !== undefined) {
    const k = req.key.trim();
    if (!k) delete req.key;
    else if (!toKeyRef(k)) return `"${k.slice(0, 32)}" isn't a major or minor key (e.g. "F#m", "Eb", "A minor")`;
    else req.key = k;
  }
  return req;
}
