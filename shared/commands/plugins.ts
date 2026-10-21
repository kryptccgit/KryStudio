import { z } from 'zod';
import { defineCommand, plural } from './types';

export const pluginsSetStates = defineCommand({
  id: 'plugins.setStates',
  label: (a) => `Store ${plural(Object.keys(a.states).length, 'plugin state')}`,
  description:
    'Store third-party plugin state blobs (base64) read from the engine, keyed by engine entity: a channel id (instrument) or "insertId/slotId" (effect). Used before saving; not undoable. Unknown keys are skipped.',
  args: z.object({ states: z.record(z.string(), z.string()) }),
  history: false,
  run(d, a) {
    let updated = 0;
    for (const [key, state] of Object.entries(a.states)) {
      const slash = key.indexOf('/');
      if (slash >= 0) {
        const slot = d.mixer.inserts[key.slice(0, slash)]?.slots[key.slice(slash + 1)];
        if (slot && slot.state !== state) {
          slot.state = state;
          updated++;
        }
      } else {
        const ch = d.channels[key];
        if (ch && ch.generator.state !== state) {
          ch.generator.state = state;
          updated++;
        }
      }
    }
    return { updated };
  },
});

export const PLUGIN_COMMANDS = [pluginsSetStates];
