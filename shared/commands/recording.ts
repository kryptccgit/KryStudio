import { z } from 'zod';
import { defineCommand, must, CommandError, type CommandDef } from './types';
import { zChainPreset } from '../sounds/schema';
import { mixerAddInsert } from './mixer';
import { playlistAddTrack } from './playlist';
import { presetsApplyChain } from './presets';

export const recordingSetupVocals = defineCommand({
  id: 'recording.setupVocals',
  label: (a) => `Set up ${a.name} recording`,
  description:
    "Set up vocal recording in one undo step: a mixer insert and a playlist track called `name` (default \"Vocals\"; the project's current recording insert / track are reused and renamed), the effect-chain `chain` loaded onto the insert (replacing its effects; null = leave the effects alone, [] effects = clear them), and both set as the recording target, so every audio take plays through that insert and lands on that track when it is free. Returns {insertId, trackId, createdInsert, createdTrack}.",
  args: z.object({ name: z.string().min(1).max(64).default('Vocals'), chain: zChainPreset.nullable().default(null) }),
  run(d, a, ctx) {
    const cur = d.recording;
    let insertId = cur?.insertId && d.mixer.inserts[cur.insertId] ? cur.insertId : null;
    const createdInsert = !insertId;
    if (insertId) d.mixer.inserts[insertId].name = a.name;
    else insertId = mixerAddInsert.run(d, { name: a.name }, ctx).id;
    let trackId = cur?.trackId && d.playlist.tracks[cur.trackId] ? cur.trackId : null;
    const createdTrack = !trackId;
    if (trackId) d.playlist.tracks[trackId].name = a.name;
    else trackId = playlistAddTrack.run(d, { name: a.name, index: 0 }, ctx).id;
    if (a.chain) presetsApplyChain.run(d, { insertId, preset: a.chain, mode: 'replace' }, ctx);
    d.recording = { insertId, trackId };
    return { insertId, trackId, createdInsert, createdTrack };
  },
});

export const recordingSetTarget = defineCommand({
  id: 'recording.setTarget',
  label: () => 'Set recording target',
  description:
    'Where audio takes go: insertId = the mixer insert every take plays through (null = a new insert per take), trackId = the playlist track takes land on when free (null = the first free track). Omitted = unchanged.',
  args: z.object({ insertId: z.string().nullable().optional(), trackId: z.string().nullable().optional() }),
  run(d, a) {
    const next = { insertId: d.recording?.insertId ?? null, trackId: d.recording?.trackId ?? null };
    if (a.insertId !== undefined) {
      if (a.insertId) {
        const ins = must(d.mixer.inserts[a.insertId], `Insert ${a.insertId} not found`);
        if (ins.isMaster) throw new CommandError('Takes can’t play straight through the master: pick an insert, or a new insert per take');
      }
      next.insertId = a.insertId;
    }
    if (a.trackId !== undefined) {
      if (a.trackId) must(d.playlist.tracks[a.trackId], `Track ${a.trackId} not found`);
      next.trackId = a.trackId;
    }
    if (next.insertId || next.trackId) d.recording = next;
    else delete d.recording;
    return {};
  },
});

export const RECORDING_COMMANDS: CommandDef[] = [recordingSetupVocals, recordingSetTarget] as CommandDef[];
