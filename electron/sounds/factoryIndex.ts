// The factory sample index (resources/factory/index.json, written by the
// engine's --gen-factory). Read leniently: a bad entry is skipped (counted),
// a bad file is null. Cached by mtime so a regenerated kit shows up without a
// restart. Node-only, no Electron import (the MCP tools use it when the sounds
// service isn't wired, e.g. in tests).

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { GENRE_IDS, type GenreId } from '@shared/sounds/genres';
import { SAMPLE_KINDS, type FactoryIndex, type FactorySample } from '@shared/sounds/types';

const zSample = z.object({
  path: z
    .string()
    .max(400)
    .regex(/^factory:[^\\:]+$/)
    .refine((p) => !p.slice('factory:'.length).split('/').includes('..'), 'no ".." segments'),
  name: z.string().min(1).max(120),
  kind: z.enum(SAMPLE_KINDS),
  tags: z.array(z.string().max(40)).max(40).default([]),
  genres: z.array(z.string()).max(40).default([]),
  rootNote: z.number().int().min(0).max(127).optional(),
  lengthSec: z.number().finite().min(0),
  channels: z.union([z.literal(1), z.literal(2)]),
  bpm: z.number().finite().min(10).max(999).optional(),
  bars: z.number().finite().positive().max(256).optional(),
  peakDb: z.number().finite(),
});

const zIndex = z.object({ version: z.literal(1), generator: z.string().max(200), samples: z.array(z.unknown()) });

/** Validate a parsed index.json. `skipped` = sample entries that didn't fit the contract. */
export function parseFactoryIndex(raw: unknown): { index: FactoryIndex | null; skipped: number; error?: string } {
  const top = zIndex.safeParse(raw);
  if (!top.success) {
    const i = top.error.issues[0];
    return { index: null, skipped: 0, error: `${i?.path.join('.') || 'index'}: ${i?.message ?? 'invalid'}` };
  }
  const samples: FactorySample[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const s of top.data.samples) {
    const r = zSample.safeParse(s);
    if (!r.success || seen.has(r.data.path)) {
      skipped++;
      continue;
    }
    seen.add(r.data.path);
    const genres = r.data.genres.filter((g): g is GenreId => (GENRE_IDS as readonly string[]).includes(g));
    samples.push({ ...r.data, tags: r.data.tags.map((t) => t.toLowerCase()), genres });
  }
  return { index: { version: 1, generator: top.data.generator, samples }, skipped };
}

export interface IndexReader {
  /** The index, or null when the file is missing / unreadable / not an index. */
  read(): FactoryIndex | null;
}

/** A cached reader for `<factoryDir>/index.json` (re-read when the file's mtime or size changes). */
export function factoryIndexReader(factoryDir: string, log?: (level: 'info' | 'warn', m: string) => void): IndexReader {
  const file = path.join(factoryDir, 'index.json');
  let key = '';
  let cached: FactoryIndex | null = null;
  return {
    read() {
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        if (key !== 'missing') {
          key = 'missing';
          cached = null;
        }
        return null;
      }
      const k = `${st.mtimeMs}:${st.size}`;
      if (k === key) return cached;
      key = k;
      try {
        const r = parseFactoryIndex(JSON.parse(fs.readFileSync(file, 'utf8')));
        cached = r.index;
        if (!r.index) log?.('warn', `Factory sample index ${file} is not valid (${r.error}); factory samples are listed by file name only.`);
        else if (r.skipped) log?.('warn', `Factory sample index: skipped ${r.skipped} malformed entr${r.skipped === 1 ? 'y' : 'ies'}.`);
      } catch (e) {
        cached = null;
        log?.('warn', `Couldn't read the factory sample index ${file}: ${(e as Error).message}`);
      }
      return cached;
    },
  };
}
