// "Link to controller…" (FL Remote control / MIDI-learn) items for every
// parameter's right-click menu (src/controls/ParamKnob.tsx paramMenuItems).

import { Cable, Unlink } from 'lucide-react';
import { midiSettings } from '@shared/live/recording';
import type { MenuItem } from '../components/Menu';
import { useSettings } from '../state/status';
import { linkToController } from './liveInput';
import { report, toast } from '../app/notify';

export function controllerMenuItems(paramRef: string, label: string): MenuItem[] {
  const links = midiSettings(useSettings.getState().settings).mappings.filter((m) => m.paramRef === paramRef);
  const items: MenuItem[] = [
    {
      label: 'Link to controller…',
      icon: Cable,
      detail: links.length ? links.map((m) => `CC ${m.cc} · ch ${m.channel + 1}${m.device ? ` · ${m.device}` : ''}`).join(', ') : undefined,
      hint: 'Then move a knob, fader or pedal on your MIDI controller',
      onSelect: () => void linkToController(paramRef, label),
    },
  ];
  for (const m of links) {
    items.push({
      label: `Unlink CC ${m.cc}`,
      icon: Unlink,
      onSelect: () => void window.krypt.midi.removeMapping(m.id).then((r) => report(r, r.message), (e: Error) => toast.error(e.message)),
    });
  }
  return items;
}
