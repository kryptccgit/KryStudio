import { useRef } from 'react';
import { Copy, Palette, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { dispatch, getProject, useProject } from '../doc/store';
import { ColorSwatches, toggleMenuAt, closeMenu, type MenuItem } from '../components/Menu';
import { PALETTE } from '@shared/schema/project';
import { addPattern, clonePattern, deletePattern, renamePattern, stepPattern } from './actions';
import { cls } from '../utils/format';
import { checkOriginality } from '../library/actions';
import { PATTERN_MIME } from '../panels/session/model';

export function PatternPicker({ compact, className }: { compact?: boolean; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const active = useProject((p) => (p.transport.activePatternId ? p.patterns[p.transport.activePatternId] : null));
  const count = useProject((p) => p.patternOrder.length);
  const order = useProject(useShallow((p) => p.patternOrder));

  const menu = (): MenuItem[] => {
    const p = getProject();
    const items: MenuItem[] = [{ type: 'header', label: `Patterns (${p.patternOrder.length})` }];
    for (const id of p.patternOrder) {
      const pat = p.patterns[id];
      const notes = Object.values(pat.notes).reduce((n, byId) => n + Object.keys(byId).length, 0);
      items.push({
        label: pat.name,
        swatch: pat.color,
        checked: id === p.transport.activePatternId,
        detail: notes ? `${notes} note${notes === 1 ? '' : 's'}` : 'empty',
        onSelect: () => void dispatch('patterns.select', { id }),
      });
    }
    items.push(
      { type: 'separator' },
      { label: 'New pattern', icon: Plus, onSelect: () => void addPattern() },
      { label: 'Clone pattern', icon: Copy, onSelect: () => void clonePattern() },
      { label: 'Rename…', icon: Pencil, onSelect: () => void renamePattern() },
      {
        type: 'submenu',
        label: 'Color',
        icon: Palette,
        items: [
          {
            type: 'custom',
            render: () => (
              <ColorSwatches
                colors={PALETTE}
                current={active?.color}
                onPick={(color) => {
                  closeMenu();
                  if (active) void dispatch('patterns.set', { id: active.id, color });
                }}
              />
            ),
          },
        ],
      },
      {
        label: 'Check originality…',
        icon: ShieldCheck,
        hint: 'Compare this pattern’s melodies with your deep-analysed references',
        disabled: !active,
        onSelect: () => active && checkOriginality({ patternId: active.id, doc: ref.current?.ownerDocument }),
      },
      { label: 'Delete pattern…', icon: Trash2, danger: true, disabled: p.patternOrder.length <= 1, onSelect: () => active && void deletePattern(active.id) },
    );
    return items;
  };

  const idx = active ? order.indexOf(active.id) + 1 : 0;
  return (
    <div className={cls('flex items-center gap-1', className)} data-guide={compact ? 'channelRack.patterns' : undefined}>
      <button
        ref={ref}
        type="button"
        onClick={() => ref.current && toggleMenuAt(ref.current, menu, { minWidth: 220 })}
        onWheel={(e) => stepPattern(e.deltaY > 0 ? 1 : -1)}
        draggable={!!active}
        onDragStart={(e) => {
          if (!active) return;
          e.dataTransfer.setData(PATTERN_MIME, active.id);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        data-hint="Active pattern: what pattern mode loops and the Channel Rack edits. Click for the list, wheel or Num +/− to step, drag onto the Playlist or a Session slot."
        className={cls(
          'flex h-6 items-center gap-1.5 rounded-md border border-white/10 bg-black/40 px-2 text-[11px] font-semibold text-white hover:border-white/20 transition',
          compact ? 'max-w-[150px]' : 'min-w-[130px] max-w-[200px]',
        )}
      >
        <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: active?.color ?? '#555' }} />
        <span className="truncate">{active?.name ?? 'No pattern'}</span>
        <span className="ml-auto pl-1 font-mono text-[9px] text-krypt-muted">
          {idx}/{count}
        </span>
      </button>
      {!compact && (
        <>
          <button
            type="button"
            onClick={() => void addPattern()}
            data-hint="New pattern (F4 jumps to the next empty one)"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-krypt-muted hover:text-white hover:border-white/20"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void clonePattern()}
            data-hint="Clone the active pattern"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-krypt-muted hover:text-white hover:border-white/20"
          >
            <Copy className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => void renamePattern()}
            data-hint="Rename the active pattern"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-krypt-muted hover:text-white hover:border-white/20"
          >
            <Pencil className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}
