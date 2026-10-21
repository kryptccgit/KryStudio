// Follow tempo on drop (Wave 12.2b): a loop dropped on the Playlist with a
// known tempo (factory / pack metadata, or "loop_128bpm.wav") gets Follow
// tempo with that Source BPM, as its own undo step after the clip, so one
// undo keeps the clip at its original speed. One-shots stay as they are.

import { loopBpmFor, followTempoMessage, type LoopMeta } from '@shared/audio/loopTempo';
import { dispatchBatch, getProject } from '../../doc/store';
import { useSounds } from '../../sounds/store';
import { usePacks } from '../../sounds/packs';
import { toast } from '../../app/notify';

/** Factory + installed-pack samples the renderer already loaded (empty until the Browser loaded them). */
function libraryMeta(): LoopMeta[] {
  return [...(useSounds.getState().samples ?? []), ...(usePacks.getState().samples?.samples ?? [])];
}

/** After `playlist.addAudio` made `channelId`: turn on Follow tempo when the file's tempo is known. */
export async function followTempoAfterDrop(path: string, name: string | undefined, channelId: string): Promise<void> {
  const found = loopBpmFor(path, name, libraryMeta());
  if (!found) return;
  const p = getProject();
  const ch = p?.channels[channelId];
  if (!p || !ch) return;
  const r = await dispatchBatch(
    [
      { cmd: 'params.set', args: { ref: `channel/${channelId}/gen/src_bpm`, value: found.bpm } },
      { cmd: 'params.set', args: { ref: `channel/${channelId}/gen/tempo_sync`, value: 1 } },
    ],
    { label: `Follow tempo (${found.bpm} bpm)` },
  );
  if (r.ok) toast.success(followTempoMessage(found.bpm, getProject()?.transport.bpm ?? p.transport.bpm));
}
