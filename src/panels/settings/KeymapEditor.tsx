import { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, RotateCcw, Search } from 'lucide-react';
import { listAppCommands } from '../../input/commands';
import {
  CONTEXT_LABELS,
  DEFAULT_KEYMAP,
  applyKeymapOverrides,
  contextForCommand,
  eventToKeys,
  findKeyConflicts,
  keysForCommand,
  prettyKeys,
  rebindOverrides,
  setKeymapSuspended,
  type KeyConflict,
} from '../../input/keymap';
import { updateSettings, useSettings } from '../../state/status';
import { modal } from '../../app/notify';
import { flashHint } from '../../app/hints';
import { cls } from '../../utils/format';

const EMPTY: Record<string, string[]> = {};

const GROUPS: Array<[prefix: string, label: string]> = [
  ['file', 'File'],
  ['edit', 'Edit'],
  ['view', 'View'],
  ['transport', 'Transport'],
  ['pattern', 'Patterns'],
  ['input', 'Input'],
  ['pianoRoll', 'Piano roll'],
  ['playlist', 'Playlist'],
  ['channelRack', 'Channel Rack'],
  ['mixer', 'Mixer'],
  ['tools', 'Tools'],
  ['help', 'Help'],
];

let pendingReveal = false;

export function revealShortcuts(): void {
  pendingReveal = true;
  window.dispatchEvent(new CustomEvent('krypt:reveal-shortcuts'));
}

function humanize(id: string): string {
  const last = id.split('.').pop() ?? id;
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface Row {
  id: string;
  label: string;
  group: string;
}

function collectRows(): Row[] {
  const seen = new Map<string, Row>();
  for (const c of listAppCommands()) seen.set(c.id, { id: c.id, label: c.label, group: c.id.split('.')[0] });
  for (const b of DEFAULT_KEYMAP) if (!seen.has(b.command)) seen.set(b.command, { id: b.command, label: humanize(b.command), group: b.command.split('.')[0] });
  return [...seen.values()];
}

function conflictText(c: KeyConflict, labelOf: (id: string) => string): string {
  const who = labelOf(c.binding.command);
  if (c.kind === 'same-scope') return `already runs “${who}”${c.binding.context ? ` in the ${CONTEXT_LABELS[c.binding.context]}` : ''}`;
  if (c.kind === 'shadows') return `hides the global “${who}” while this editor has focus`;
  return `is used by “${who}” inside the ${c.binding.context ? CONTEXT_LABELS[c.binding.context] : 'editor'}, which wins there`;
}

export function KeymapEditor() {
  const overrides = useSettings((s) => s.settings?.keymap) ?? EMPTY;
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [capturing, setCapturing] = useState<string | null>(null);
  const [pending, setPending] = useState<{ command: string; keys: string; conflicts: KeyConflict[] } | null>(null);
  const map = useMemo(() => applyKeymapOverrides(DEFAULT_KEYMAP, overrides), [overrides]);
  const rows = collectRows();
  const labelOf = (id: string): string => rows.find((r) => r.id === id)?.label ?? humanize(id);
  const overriddenCount = Object.keys(overrides).length;

  useEffect(() => {
    const reveal = (): void => {
      pendingReveal = false;
      setTimeout(() => rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
    };
    if (pendingReveal) reveal();
    window.addEventListener('krypt:reveal-shortcuts', reveal);
    return () => window.removeEventListener('krypt:reveal-shortcuts', reveal);
  }, []);

  const save = async (next: Record<string, string[]>, message: string): Promise<void> => {
    await updateSettings({ keymap: next }, message);
  };

  const commit = (command: string, keys: string | null, replace = false): void => {
    const next = rebindOverrides(DEFAULT_KEYMAP, overrides, command, keys, replace);
    void save(next, keys ? `${labelOf(command)}: ${prettyKeys(keys)}` : `${labelOf(command)}: no shortcut`);
  };

  useEffect(() => {
    if (!capturing) return;
    const doc = rootRef.current?.ownerDocument ?? document;
    const win = doc.defaultView ?? window;
    const command = capturing;
    setKeymapSuspended(true);
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (bare && e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      if (bare && (e.key === 'Backspace' || e.key === 'Delete')) {
        setCapturing(null);
        commit(command, null);
        return;
      }
      const keys = eventToKeys(e);
      if (!keys) return;
      setCapturing(null);
      const ctx = contextForCommand(command);
      const conflicts = findKeyConflicts(map, keys, command, ctx);
      if (!ctx && /^[A-Z0-9]$/.test(keys)) {
        conflicts.push({ binding: { keys, command: 'input.toggleTypingPiano' }, kind: 'shadowed' });
      }
      if (conflicts.length) setPending({ command, keys, conflicts });
      else commit(command, keys);
    };
    const cancel = (): void => setCapturing(null);
    doc.addEventListener('keydown', onKey, true);
    win.addEventListener('blur', cancel);
    return () => {
      doc.removeEventListener('keydown', onKey, true);
      win.removeEventListener('blur', cancel);
      setKeymapSuspended(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);

  const resetOne = (command: string): void => {
    const next = { ...overrides };
    delete next[command];
    void save(next, `${labelOf(command)}: default shortcut`);
  };

  const resetAll = async (): Promise<void> => {
    if (!overriddenCount) {
      flashHint('Shortcuts are already the defaults', 'info');
      return;
    }
    const ok = await modal.confirm({
      title: 'Reset all shortcuts?',
      message: `This puts ${overriddenCount} changed shortcut${overriddenCount === 1 ? '' : 's'} back to the defaults.`,
      confirmLabel: 'Reset all',
      destructive: true,
    });
    if (ok) await save({}, 'Shortcuts reset to defaults');
  };

  const q = query.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (!q) return true;
    const keys = keysForCommand(map, r.id).map(prettyKeys).join(' ').toLowerCase();
    return r.label.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || keys.includes(q);
  });
  const known = new Set(GROUPS.map(([p]) => p));
  const sections = [...GROUPS, ['__other', 'Other'] as [string, string]]
    .map(([prefix, label]) => ({
      label,
      rows: visible.filter((r) => (prefix === '__other' ? !known.has(r.group) : r.group === prefix)).sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .filter((s) => s.rows.length);

  return (
    <div ref={rootRef} className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-2 focus-within:border-krypt-purple/60">
          <Search className="h-3 w-3 flex-shrink-0 text-krypt-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands or keys"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-white placeholder-krypt-muted/60 outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => void resetAll()}
          disabled={!overriddenCount}
          className="flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-[11px] font-semibold text-white/85 transition hover:border-white/20 disabled:opacity-40"
          data-hint="Put every shortcut back to the FL-style defaults"
        >
          <RotateCcw className="h-3 w-3" /> Reset all{overriddenCount ? ` (${overriddenCount})` : ''}
        </button>
      </div>
      <div className="max-h-[340px] overflow-y-auto rounded-xl border border-white/10 bg-black/20">
        {sections.map((s) => (
          <div key={s.label}>
            <div className="sticky top-0 z-[1] border-b border-white/[0.06] bg-[#12121b] px-3 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{s.label}</div>
            {s.rows.map((r) => {
              const keys = keysForCommand(map, r.id);
              const ctx = contextForCommand(r.id);
              const overridden = Object.prototype.hasOwnProperty.call(overrides, r.id);
              const isCapturing = capturing === r.id;
              const isPending = pending?.command === r.id;
              const hard = isPending && pending!.conflicts.some((c) => c.kind === 'same-scope');
              return (
                <div key={r.id} className={cls('border-b border-white/[0.04] last:border-b-0', isCapturing && 'bg-krypt-purple/[0.08]')}>
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {overridden && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-krypt-purple" title="Changed from the default" />}
                        <span className="truncate text-[11px] font-semibold text-white/90">{r.label}</span>
                        {ctx && <span className="flex-shrink-0 rounded border border-white/10 px-1 text-[8px] font-semibold uppercase tracking-wider text-krypt-muted">{CONTEXT_LABELS[ctx]}</span>}
                      </div>
                      <div className="truncate font-mono text-[9px] text-krypt-muted/60">{r.id}</div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1">
                      {isCapturing ? (
                        <span className="animate-pulse rounded border border-krypt-purple/60 bg-krypt-purple/15 px-1.5 py-0.5 font-mono text-[10px] text-white">
                          Press keys… Esc cancels · Backspace clears
                        </span>
                      ) : keys.length ? (
                        keys.map((k) => (
                          <kbd key={k} className="rounded border border-white/15 bg-black/50 px-1.5 py-0.5 font-mono text-[10px] text-white/85">
                            {prettyKeys(k)}
                          </kbd>
                        ))
                      ) : (
                        <span className="text-[10px] text-krypt-muted/60">—</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setPending(null);
                        setCapturing(isCapturing ? null : r.id);
                      }}
                      className={cls(
                        'flex h-6 flex-shrink-0 items-center gap-1 rounded-md border px-1.5 text-[10px] font-semibold transition',
                        isCapturing ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-white/10 bg-white/[0.04] text-white/80 hover:border-white/25 hover:text-white',
                      )}
                      data-hint="Rebind: press the new key combo"
                    >
                      <Keyboard className="h-3 w-3" /> {isCapturing ? 'Cancel' : 'Rebind'}
                    </button>
                    <button
                      type="button"
                      onClick={() => resetOne(r.id)}
                      disabled={!overridden}
                      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-krypt-muted transition hover:bg-white/10 hover:text-white disabled:invisible"
                      data-hint="Back to the default shortcut"
                      aria-label="Reset to default"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  </div>
                  {isPending && (
                    <div
                      className={cls(
                        'mx-3 mb-2 rounded-lg border px-2.5 py-2 text-[11px]',
                        hard ? 'border-amber-400/40 bg-amber-500/10 text-amber-100' : 'border-white/10 bg-white/[0.04] text-white/80',
                      )}
                    >
                      <div>
                        <kbd className="rounded border border-white/20 bg-black/40 px-1 font-mono text-[10px]">{prettyKeys(pending!.keys)}</kbd>{' '}
                        {pending!.conflicts.map((c) => (c.binding.command === 'input.toggleTypingPiano' ? 'also plays a note while the typing keyboard is on' : conflictText(c, labelOf))).join('; ')}.
                      </div>
                      <div className="mt-1.5 flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            const p = pending!;
                            setPending(null);
                            commit(p.command, p.keys, true);
                          }}
                          className={cls(
                            'h-6 rounded-md px-2 text-[10px] font-semibold transition',
                            hard ? 'bg-amber-400/90 text-black hover:bg-amber-300' : 'bg-krypt-gradient text-white hover:brightness-110',
                          )}
                        >
                          {hard ? 'Replace' : 'Use it'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPending(null)}
                          className="h-6 rounded-md border border-white/10 bg-white/5 px-2 text-[10px] font-semibold text-krypt-muted hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {!sections.length && <div className="px-3 py-6 text-center text-[11px] text-krypt-muted">No command matches “{query}”.</div>}
      </div>
      <p className="text-[10px] text-krypt-muted/80">
        Editor shortcuts (Piano roll, Playlist, Channel Rack) only fire while that window has focus and win over a global shortcut with the same keys.
      </p>
    </div>
  );
}
