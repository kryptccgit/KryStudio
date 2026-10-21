import { z } from 'zod';
import type { AlbumExportRequest, AlbumRequest, AutoMixRequest, MasterFileRequest } from '@shared/automix/types';
import { ALBUM_MAX_SONGS } from '@shared/automix/album';

const zLufs = z.number().min(-30).max(0);
const zTp = z.number().min(-6).max(0);

export const zAutoMixRequest = z.object({
  mode: z.enum(['vocals', 'mix', 'master', 'full']),
  preset: z.string().max(64).optional(),
  prompt: z.string().max(2000).optional(),
  targetLufs: zLufs.optional(),
  truePeak: zTp.optional(),
  bars: z.string().max(32).optional(),
  vocalInserts: z.array(z.string().max(200)).max(32).optional(),
  useAi: z.enum(['auto', 'never']).optional(),
  keepUserFx: z.boolean().optional(),
  reference: z.string().max(1024).optional(),
});

export const zMasterFileRequest = z.object({
  path: z.string().max(1024),
  preset: z.string().max(64).optional(),
  prompt: z.string().max(2000).optional(),
  targetLufs: zLufs.optional(),
  truePeak: zTp.optional(),
  reference: z.string().max(1024).optional(),
  useAi: z.enum(['auto', 'never']).optional(),
});

export const zAlbumRequest = z.object({
  paths: z.array(z.string().min(1).max(1024)).max(ALBUM_MAX_SONGS + 5),
  preset: z.string().max(64).optional(),
  prompt: z.string().max(2000).optional(),
  reference: z.string().max(1024).optional(),
  targetLufs: zLufs.optional(),
  truePeak: zTp.optional(),
  keepDynamics: z.boolean().optional(),
  useAi: z.enum(['auto', 'never']).optional(),
});

export const zAlbumExportRequest = z.object({
  folder: z.string().max(1024),
  format: z.enum(['wav24', 'wav16', 'mp3']),
  mp3Kbps: z.number().int().optional(),
  songs: z
    .array(z.object({ name: z.string().max(200), startTick: z.number().int().min(0), endTick: z.number().int().min(0) }))
    .min(1)
    .max(ALBUM_MAX_SONGS),
});

function problem(what: string, e: z.ZodError): string {
  const i = e.issues[0];
  return `The ${what} is invalid (${i?.path.length ? `${i.path.join('.')}: ` : ''}${i?.message ?? 'unknown problem'})`;
}

export function cleanAutoMixRequest(raw: unknown): AutoMixRequest | string {
  const r = zAutoMixRequest.safeParse(raw);
  if (!r.success) return problem('Auto Mix request', r.error);
  const req = r.data as AutoMixRequest;
  if (req.bars !== undefined && !req.bars.trim()) delete req.bars;
  if (req.prompt !== undefined && !req.prompt.trim()) delete req.prompt;
  if (req.reference !== undefined && !req.reference.trim()) delete req.reference;
  return req;
}

export function cleanMasterFileRequest(raw: unknown): MasterFileRequest | string {
  const r = zMasterFileRequest.safeParse(raw);
  if (!r.success) return problem('master-a-song request', r.error);
  const req = r.data as MasterFileRequest;
  if (req.reference !== undefined && !req.reference.trim()) delete req.reference;
  return req;
}

export function cleanAlbumRequest(raw: unknown): AlbumRequest | string {
  const r = zAlbumRequest.safeParse(raw);
  if (!r.success) return problem('album request', r.error);
  const req = r.data as AlbumRequest;
  if (req.prompt !== undefined && !req.prompt.trim()) delete req.prompt;
  if (req.reference !== undefined && !req.reference.trim()) delete req.reference;
  return req;
}

export function cleanAlbumExportRequest(raw: unknown): AlbumExportRequest | string {
  const r = zAlbumExportRequest.safeParse(raw);
  if (!r.success) return problem('export request', r.error);
  return r.data as AlbumExportRequest;
}
