// Keeps audio clips showing the same audio when an Audio Clip channel's
// timing params change (tempo_sync / src_bpm / stretch). Those params change
// how source seconds map to ticks, so the channel's playlist clips are
// rescaled (start stays; length, offset and fades scale). Used by every
// command that writes generator params, so a knob, a MIDI controller, the
// analysis dialog and an agent all get the same result.

import type { PluginCatalog } from '../plugins/types';
import type { Project } from '../schema/project';
import { AUDIOCLIP, audioTickBpm } from '../analyzer/tempo';

/** Run `mutate` (which edits channel `channelId`'s generator), then rescale its audio clips if their tick tempo changed. */
export function keepAudioInPlace<R>(d: Project, catalog: PluginCatalog, channelId: string, mutate: () => R): R {
  const ch = d.channels[channelId];
  if (!ch || ch.generator.type !== AUDIOCLIP) return mutate();
  const before = audioTickBpm(d, catalog, ch).bpm;
  const out = mutate();
  const after = audioTickBpm(d, catalog, d.channels[channelId]).bpm;
  if (!(before > 0) || !(after > 0) || Math.abs(after / before - 1) < 1e-9) return out;
  const f = after / before;
  for (const c of Object.values(d.playlist.clips)) {
    if (c.kind !== 'audio' || c.channelId !== channelId) continue;
    c.length = Math.max(1, Math.round(c.length * f));
    c.offset = Math.max(0, Math.round(c.offset * f));
    if (c.fadeIn) c.fadeIn = Math.max(0, Math.round(c.fadeIn * f));
    if (c.fadeOut) c.fadeOut = Math.max(0, Math.round(c.fadeOut * f));
  }
  return out;
}
