// Map DocHost patches → engine entity upserts/deletes. Granularity is the
// ENTITY (a whole Pattern / Channel / Clip / Insert): coarse enough to be
// simple and robust, fine enough that a note drag only resends one pattern.

import type { Patch } from 'immer';
import type { Project } from '../schema/project';
import type { EntityDelete, EntityKind, EntityUpsert } from './protocol';

interface Touched {
  kind: EntityKind;
  id?: string;
}

function locate(path: (string | number)[]): Touched | null {
  const [a, b, c] = path.map(String);
  switch (a) {
    case 'transport':
      return { kind: 'transport' };
    case 'channels':
      return b ? { kind: 'channel', id: b } : null;
    case 'patterns':
      return b ? { kind: 'pattern', id: b } : null;
    case 'automations':
      return b ? { kind: 'automation', id: b } : null;
    case 'samples':
      return b ? { kind: 'sample', id: b } : null;
    case 'playlist':
      if (b === 'clips' && c) return { kind: 'clip', id: c };
      if (b === 'tracks' && c) return { kind: 'track', id: c };
      return null; // markers, trackOrder: irrelevant to audio
    case 'session':
      if (b === 'scenes' && c) return { kind: 'scene', id: c };
      if (b === 'clips' && c) return { kind: 'launchClip', id: c };
      return { kind: 'session' }; // quantize, sceneOrder, or the whole session added / removed
    case 'mixer':
      if (b === 'inserts' && c) return { kind: 'insert', id: c };
      if (b === 'masterId') return { kind: 'mixer' };
      return null;
    default:
      return null; // meta, channelOrder, patternOrder: not audio-relevant
  }
}

function lookup(p: Project, t: Touched): unknown | undefined {
  switch (t.kind) {
    case 'transport':
      return p.transport;
    case 'mixer':
      return { masterId: p.mixer.masterId };
    case 'channel':
      return p.channels[t.id!];
    case 'pattern':
      return p.patterns[t.id!];
    case 'automation':
      return p.automations[t.id!];
    case 'sample':
      return p.samples[t.id!];
    case 'clip':
      return p.playlist.clips[t.id!];
    case 'track':
      return p.playlist.tracks[t.id!];
    case 'insert':
      return p.mixer.inserts[t.id!];
    case 'scene':
      return p.session?.scenes[t.id!];
    case 'launchClip':
      return p.session?.clips[t.id!];
    case 'session':
      // The engine drops launch clips / scenes not listed here (covers a whole session being removed).
      return { quantize: p.session?.quantize ?? '1bar', sceneOrder: p.session?.sceneOrder ?? [], clipIds: Object.keys(p.session?.clips ?? {}) };
  }
}

/**
 * Compute the engine diff for a batch of patches, reading entity values from
 * the post-change project. `resolveSample` lets main rewrite sample paths
 * (factory: → absolute) before they reach the engine.
 */
export function projectPatches(
  next: Project,
  patches: Patch[],
  resolveSample: (s: Project['samples'][string]) => unknown = (s) => s,
): { upserts: EntityUpsert[]; deletes: EntityDelete[] } {
  const seen = new Map<string, Touched>();
  for (const p of patches) {
    const t = locate(p.path);
    if (t) seen.set(`${t.kind}:${t.id ?? ''}`, t);
    if (p.path.length === 1 && p.path[0] === 'session' && next.session) {
      // The whole session was replaced / added: send every scene and launch clip.
      for (const id of Object.keys(next.session.scenes)) seen.set(`scene:${id}`, { kind: 'scene', id });
      for (const id of Object.keys(next.session.clips)) seen.set(`launchClip:${id}`, { kind: 'launchClip', id });
    }
  }
  const upserts: EntityUpsert[] = [];
  const deletes: EntityDelete[] = [];
  for (const t of seen.values()) {
    const v = lookup(next, t);
    if (v === undefined) {
      if (t.id) deletes.push({ kind: t.kind, id: t.id });
    } else {
      upserts.push({ kind: t.kind, id: t.id, value: t.kind === 'sample' ? resolveSample(v as any) : v });
    }
  }
  return { upserts, deletes };
}
