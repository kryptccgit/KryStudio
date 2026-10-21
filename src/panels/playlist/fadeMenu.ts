import { Blend, Eraser } from 'lucide-react';
import type { Clip } from '@shared/schema/project';
import { previousTouching } from '@shared/commands/fades';
import { getProject } from '../../doc/store';
import type { MenuItem } from '../../components/Menu';
import type { PlaylistController } from './controller';

export function fadeMenuItems(ctl: PlaylistController, c: Clip): MenuItem[] {
  if (c.kind !== 'audio') return [];
  const p = getProject();
  const prev = p ? previousTouching(p, c) : null;
  const hasFades = !!((c.fadeIn ?? 0) || (c.fadeOut ?? 0));
  return [
    {
      label: 'Crossfade with the previous clip',
      icon: Blend,
      disabled: !prev,
      hint: prev ? 'Overlap the cut so one clip fades into the other (or Alt-drag the fade-in handle)' : 'Needs an audio clip that ends where this one starts, on the same track',
      onSelect: () => void ctl.crossfadeWithPrevious(c.id),
    },
    { label: 'Remove fades', icon: Eraser, disabled: !hasFades, onSelect: () => void ctl.clearFades([c.id]) },
  ];
}
