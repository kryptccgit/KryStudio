import { useRef } from 'react';
import { Crosshair, LibraryBig, X } from 'lucide-react';
import { openMenuAt, type MenuItem } from '../components/Menu';
import { cls } from '../utils/format';
import { useLibrary } from './store';
import { analysedCount, fmtCount } from './logic';
import { chooseFocus, clearFocus, collectionById, openLibrary } from './actions';

function focusHint(name: string, brief: string): string {
  return `AI focus: agents compose from ${name}'s style profile${brief ? ` + your brief “${brief}”` : ''}. Click to open the profile.`;
}

export function FocusChip() {
  const focus = useLibrary((s) => s.state?.focus ?? null);
  if (!focus) return null;
  return (
    <div className="app-no-drag flex h-6 max-w-[240px] items-center rounded-full border border-krypt-purple/40 bg-krypt-purple/[0.12] pl-1 pr-0.5 shadow-[0_0_12px_rgba(168,85,247,0.25)]">
      <button
        type="button"
        onClick={() => openLibrary({ collectionId: focus.collectionId, view: 'profile' })}
        data-hint={focusHint(focus.name, focus.brief)}
        className="flex min-w-0 items-center gap-1.5 rounded-full px-1.5 text-[11px] text-white/90 transition hover:text-white"
      >
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-krypt-gradient">
          <Crosshair className="h-2.5 w-2.5 text-white" strokeWidth={2.5} />
        </span>
        <span className="hidden text-krypt-muted md:inline">Focus</span>
        <span className="truncate font-semibold">{focus.name}</span>
      </button>
      <button
        type="button"
        onClick={() => void clearFocus()}
        aria-label="Clear the AI focus"
        data-hint="Clear the AI focus (agents stop leaning on this collection)"
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-white/55 transition hover:bg-white/10 hover:text-white"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function openFocusPicker(el: Element): void {
  const s = useLibrary.getState().state;
  const cols = s?.collections ?? [];
  const doc = el.ownerDocument;
  const items: MenuItem[] = [{ type: 'header', label: cols.length ? 'Compose in the style of' : 'No collections yet' }];
  for (const c of cols) {
    const n = analysedCount(c);
    items.push({
      label: c.name,
      icon: Crosshair,
      checked: s?.focus?.collectionId === c.id,
      detail: n ? `${fmtCount(n)} analysed track${n === 1 ? '' : 's'}${c.counts.deep ? ` · ${fmtCount(c.counts.deep)} deep` : ''}` : 'Nothing analysed yet',
      onSelect: () => chooseFocus(c, doc),
    });
  }
  items.push({ type: 'separator' }, { label: 'Open Library…', icon: LibraryBig, onSelect: () => openLibrary() });
  if (s?.focus) items.push({ label: 'Clear focus', icon: X, onSelect: () => void clearFocus() });
  openMenuAt(el, items, { minWidth: 240 });
}

export function AgentFocusBar() {
  const focus = useLibrary((s) => s.state?.focus ?? null);
  const hasState = useLibrary((s) => !!s.state);
  const pickRef = useRef<HTMLButtonElement>(null);
  if (!hasState) return null;
  const btn = 'flex h-6 flex-shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[10px] font-semibold text-white/85 transition hover:border-white/20 hover:bg-white/10';
  return (
    <div
      className={cls(
        'flex flex-shrink-0 items-center gap-2 border-b border-white/[0.06] px-2.5 py-1.5',
        focus ? 'bg-gradient-to-r from-krypt-indigo/[0.08] via-krypt-purple/[0.08] to-transparent' : '',
      )}
    >
      <Crosshair className={cls('h-3.5 w-3.5 flex-shrink-0', focus ? 'text-krypt-purple' : 'text-krypt-muted')} />
      {focus ? (
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => openLibrary({ collectionId: focus.collectionId, view: 'profile' })}
          data-hint={focusHint(focus.name, focus.brief)}
        >
          <div className="truncate text-[11px] text-white">
            <span className="text-krypt-muted">Style focus </span>
            <span className="font-semibold">{focus.name}</span>
          </div>
          {focus.brief && <div className="truncate text-[10px] italic text-white/60">“{focus.brief}”</div>}
        </button>
      ) : (
        <div className="min-w-0 flex-1 truncate text-[10px] text-krypt-muted" data-hint="Pick a Library collection: agents then compose from its style profile">
          No style focus. Agents compose freely.
        </div>
      )}
      {focus && (
        <button
          type="button"
          className={btn}
          onClick={() => {
            const c = collectionById(focus.collectionId);
            if (c) chooseFocus(c, pickRef.current?.ownerDocument);
            else openLibrary();
          }}
          data-hint="Edit the brief"
        >
          Brief
        </button>
      )}
      <button ref={pickRef} type="button" className={btn} onClick={() => pickRef.current && openFocusPicker(pickRef.current)} data-hint="Pick the collection agents compose from">
        {focus ? 'Change' : 'Choose…'}
      </button>
      {focus && (
        <button
          type="button"
          onClick={() => void clearFocus()}
          aria-label="Clear the AI focus"
          data-hint="Clear the AI focus"
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-white/55 transition hover:bg-rose-500/15 hover:text-rose-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
