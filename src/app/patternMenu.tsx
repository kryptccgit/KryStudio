// One right-click menu for a pattern, wherever it shows up: the playlist's
// pattern list and pattern clips. "Open" actions first (the thing most people
// want), then edit, then the rarer tools.

import { Copy, Grid3x3, Palette, Paintbrush, Pencil, Piano, ShieldCheck, Trash2 } from 'lucide-react';
import { PALETTE } from '@shared/schema/project';
import { dispatch, getProject } from '../doc/store';
import { ColorSwatches, closeMenu, type MenuItem } from '../components/Menu';
import { openPanel } from '../editors/selection';
import { checkOriginality } from '../library/actions';
import { clonePattern, deletePattern, renamePattern } from './actions';

/** Select the pattern, then show one of its editors. */
export function openPattern(patternId: string, panel: 'pianoRoll' | 'channelRack'): void {
  void dispatch('patterns.select', { id: patternId }).then((r) => r.ok && openPanel(panel));
}

/** `open: false` leaves out the header and the Open items (a Pattern submenu under a clip menu that already has them). */
export function patternMenuItems(patternId: string, opts: { doc?: Document | null; brush?: boolean; open?: boolean } = {}): MenuItem[] {
  const p = getProject();
  const pat = p.patterns[patternId];
  if (!pat) return [];
  const items: MenuItem[] =
    opts.open === false
      ? []
      : [
          { type: 'header', label: pat.name },
          { label: 'Open in Piano Roll', icon: Piano, shortcut: 'F7', hint: 'Edit the notes', onSelect: () => openPattern(patternId, 'pianoRoll') },
          { label: 'Open in Channel Rack', icon: Grid3x3, shortcut: 'F6', hint: 'Edit the steps', onSelect: () => openPattern(patternId, 'channelRack') },
        ];
  if (opts.brush)
    items.push({
      label: 'Paint with this pattern',
      icon: Paintbrush,
      checked: p.transport.activePatternId === patternId,
      hint: 'Clicks in the playlist place this pattern',
      onSelect: () => void dispatch('patterns.select', { id: patternId }),
    });
  if (items.length) items.push({ type: 'separator' });
  items.push(
    { label: 'Rename…', icon: Pencil, onSelect: () => void renamePattern(patternId) },
    {
      type: 'submenu',
      label: 'Color',
      icon: Palette,
      swatch: pat.color,
      items: [
        {
          type: 'custom',
          render: () => (
            <ColorSwatches
              colors={PALETTE}
              current={pat.color}
              onPick={(color) => {
                closeMenu();
                void dispatch('patterns.set', { id: patternId, color });
              }}
            />
          ),
        },
      ],
    },
    { label: 'Clone pattern', icon: Copy, hint: 'A copy with the same notes, to change separately', onSelect: () => void clonePattern(patternId) },
    {
      label: 'Check originality…',
      icon: ShieldCheck,
      hint: 'Compare this pattern’s melodies with your deep-analysed references',
      onSelect: () => checkOriginality({ patternId, doc: opts.doc }),
    },
    { type: 'separator' },
    { label: 'Delete pattern…', icon: Trash2, danger: true, disabled: p.patternOrder.length <= 1, onSelect: () => void deletePattern(patternId) },
  );
  return items;
}
