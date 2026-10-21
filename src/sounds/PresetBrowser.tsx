// ──────────────────────────────────────────────────────────────────────
// The preset browser: search, genre chips, tag filters, presets grouped by
// role, your own presets marked. One component for instrument presets (the
// preset bar's popover; footer: "With effects") and effect chains (the
// Mixer's chain picker; footer: Replace / Append). ↑ ↓ move, Enter loads.
// Hosted in a Menu 'custom' item (popover) or a Dialog.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, Layers, Search, SwatchBook, UserRound, X } from 'lucide-react';
import { pluginById } from '@shared/plugins/catalog';
import { GENRES, type GenreId } from '@shared/sounds/genres';
import type { PresetSummary } from '@shared/sounds/types';
import { Segmented } from '../components/Dialog';
import { cls } from '../utils/format';
import { chainRoleOrder, genreName, groupPresets, type PresetFilter } from './logic';
import { presetList, setWithFx, useEnsureSounds, useSounds } from './store';
import { showPackInHome, useMissingPack } from './packs';
import { needsPackMessage } from './packsLogic';

export interface PresetPickOptions {
  withFx: boolean;
  mode: 'replace' | 'append';
}

export interface PresetBrowserProps {
  kind: 'instrument' | 'chain';
  /** The preset loaded now (highlighted, list starts there). */
  currentId?: string | null;
  /** Chains on the master: master chains first. */
  isMaster?: boolean;
  /** Load the pick. Resolve false to keep the browser open. */
  onPick: (p: PresetSummary, opts: PresetPickOptions) => Promise<boolean> | boolean;
  close: () => void;
  /** Width in px (the popover passes what fits its window). */
  width?: number;
  /** CSS max-height of the list. */
  listMaxHeight?: string;
}

function pluginShort(id: string | undefined): string {
  if (!id) return '';
  const name = pluginById(id)?.name ?? id;
  return name.replace(/^Krypt /, '');
}

export function PresetBrowser({ kind, currentId, isMaster, onPick, close, width = 380, listMaxHeight = 'min(340px, calc(70vh - 160px))' }: PresetBrowserProps) {
  useEnsureSounds();
  const state = useSounds((s) => s.state);
  const loadError = useSounds((s) => s.error);
  const withFx = useSounds((s) => s.withFx);
  const all = presetList(state);
  const missingPack = useMissingPack();
  const [text, setText] = useState('');
  const [genre, setGenre] = useState<GenreId | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [source, setSource] = useState<'all' | 'factory' | 'user'>('all');
  const [mode, setMode] = useState<'replace' | 'append'>('replace');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const filter: PresetFilter = { kind, text, genre, tags, source };
    return groupPresets(all, filter, kind === 'chain' ? chainRoleOrder(!!isMaster) : undefined);
  }, [all, kind, text, genre, tags, source, isMaster]);
  const flat = useMemo(() => groups.flatMap((g) => g.presets), [groups]);
  const ofKind = useMemo(() => all.filter((p) => p.kind === kind), [all, kind]);
  const genresUsed = useMemo(() => {
    const used = new Set<string>();
    for (const p of ofKind) for (const g of p.genres) used.add(g);
    return GENRES.filter((g) => used.has(g.id));
  }, [ofKind]);
  const [active, setActive] = useState(() => Math.max(0, currentId ? flat.findIndex((p) => p.id === currentId) : 0));

  useEffect(() => {
    setActive((a) => Math.min(Math.max(0, a), Math.max(0, flat.length - 1)));
  }, [flat.length]);

  // The list host (Menu / Dialog) focuses itself first; take focus for the search box right after.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 40);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = async (p: PresetSummary | undefined): Promise<void> => {
    if (!p || busy) return;
    setBusy(true);
    let done = false;
    try {
      done = (await onPick(p, { withFx, mode })) !== false;
    } finally {
      setBusy(false);
    }
    if (done) close();
  };

  const toggleTag = (t: string): void => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (!flat.length) return;
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void pick(flat[active]);
    }
  };

  const filtersOn = !!(text || genre || tags.length || source !== 'all');
  const Icon = kind === 'chain' ? Layers : SwatchBook;
  let row = -1;

  return (
    <div className="flex flex-col font-sans text-white" style={{ width }} onKeyDown={onKeyDown}>
      <div className="space-y-1.5 border-b border-white/[0.07] px-2 pb-2 pt-1">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-krypt-muted" />
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={kind === 'chain' ? 'Search chains: glue, loud, wide…' : 'Search: dark pluck, supersaw, 808…'}
              className="h-7 w-full rounded-lg border border-white/10 bg-black/40 pl-6 pr-6 text-[11.5px] text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60"
              aria-label="Search presets"
            />
            {text && (
              <button type="button" onClick={() => setText('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-krypt-muted hover:text-white" aria-label="Clear search">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <Segmented
            size="sm"
            value={source}
            onChange={setSource}
            options={[
              { value: 'all', label: 'All' },
              { value: 'factory', label: 'Factory', title: 'Presets that ship with Krypt Studio' },
              { value: 'user', label: 'Mine', title: 'Presets you (or an agent) saved' },
            ]}
          />
        </div>
        {genresUsed.length > 0 && (
          <div className="flex gap-1 overflow-x-auto pb-0.5" data-hint="Genre filter: only presets made for that genre">
            {genresUsed.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setGenre((cur) => (cur === g.id ? null : g.id))}
                className={cls(
                  'h-5 flex-shrink-0 rounded-full border px-2 text-[10px] font-semibold transition',
                  genre === g.id ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-white/10 bg-white/[0.03] text-white/60 hover:border-white/20 hover:text-white',
                )}
              >
                {g.name}
              </button>
            ))}
          </div>
        )}
        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-krypt-muted">Tags</span>
            {tags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => toggleTag(t)}
                className="flex h-4 items-center gap-0.5 rounded-full border border-krypt-purple/50 bg-krypt-purple/15 px-1.5 text-[9.5px] text-white"
                data-hint={`Remove the "${t}" filter`}
              >
                {t} <X className="h-2.5 w-2.5" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div ref={listRef} className="overflow-y-auto overflow-x-hidden py-1" style={{ maxHeight: listMaxHeight }} role="listbox" aria-label={kind === 'chain' ? 'Effect chains' : 'Presets'}>
        {groups.map((g) => (
          <div key={g.role}>
            <div className="sticky top-0 z-10 bg-[#101018] px-2.5 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted/80">
              {g.label} <span className="font-mono text-krypt-muted/50">{g.presets.length}</span>
            </div>
            {g.presets.map((p) => {
              row++;
              const i = row;
              const current = p.id === currentId;
              const pack = missingPack(p);
              return (
                <div
                  key={p.id}
                  data-row={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => void pick(p)}
                  className={cls('group mx-1 flex cursor-pointer items-start gap-1.5 rounded-md px-1.5 py-1 transition-colors', i === active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]')}
                  data-hint={pack ? needsPackMessage(p.name, pack) : `${p.name}: ${p.description || 'no description'}`}
                >
                  <span className="mt-[1px] flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
                    {current ? <Check className="h-3.5 w-3.5 text-krypt-purple" /> : <Icon className="h-3 w-3 text-krypt-muted/70" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={cls('truncate text-[12px] leading-tight', current ? 'font-semibold text-white' : pack ? 'text-white/55' : 'text-white/90')}>{p.name}</span>
                      {p.source === 'user' && (
                        <span className="flex flex-shrink-0 items-center gap-0.5 rounded-full border border-krypt-purple/40 bg-krypt-purple/10 px-1 text-[8.5px] font-semibold uppercase tracking-wider text-purple-200">
                          <UserRound className="h-2 w-2" /> Mine
                        </span>
                      )}
                      {pack && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            close();
                            showPackInHome(pack.id);
                          }}
                          className="ml-auto flex h-4 flex-shrink-0 items-center gap-0.5 rounded-full border border-krypt-purple/40 bg-krypt-purple/10 px-1.5 text-[9px] font-semibold text-purple-200 transition hover:border-krypt-purple/70 hover:text-white"
                          data-hint={`${needsPackMessage(p.name, pack)} Opens Home ▸ Sounds, where you can download it.`}
                          aria-label={`Download the pack for ${p.name}`}
                        >
                          <Download className="h-2.5 w-2.5" /> Download pack
                        </button>
                      )}
                      {kind === 'instrument' && <span className={cls('flex-shrink-0 font-mono text-[9px] text-krypt-muted/70', !pack && 'ml-auto')}>{pluginShort(p.plugin)}</span>}
                    </span>
                    {(p.tags.length > 0 || p.genres.length > 0) && (
                      <span className="mt-0.5 flex flex-wrap gap-0.5">
                        {p.tags.slice(0, 4).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleTag(t.toLowerCase());
                            }}
                            className={cls(
                              'rounded-full border px-1 text-[9px] leading-[13px] transition',
                              tags.includes(t.toLowerCase()) ? 'border-krypt-purple/50 text-white' : 'border-white/[0.08] text-krypt-muted hover:border-white/20 hover:text-white',
                            )}
                            data-hint={`Only show presets tagged "${t}"`}
                          >
                            {t}
                          </button>
                        ))}
                        {p.genres.slice(0, 2).map((g) => (
                          <span key={g} className="px-0.5 text-[9px] leading-[13px] text-krypt-muted/60">
                            {genreName(g)}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {!flat.length && (
          <div className="px-3 py-6 text-center text-[11px] leading-relaxed text-krypt-muted">
            {!ofKind.length ? (
              kind === 'chain' ? (
                'No effect chains yet. Build a chain on an insert, then use Save chain as preset….'
              ) : (
                'No presets yet. Shape a sound, then use Save preset… to keep it.'
              )
            ) : (
              <>
                Nothing matches.{' '}
                {filtersOn && (
                  <button
                    type="button"
                    className="text-krypt-purple hover:underline"
                    onClick={() => {
                      setText('');
                      setGenre(null);
                      setTags([]);
                      setSource('all');
                    }}
                  >
                    Clear the filters
                  </button>
                )}
              </>
            )}
            {loadError && <div className="mt-1 text-rose-300">Couldn’t read your presets: {loadError}</div>}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-white/[0.07] px-2.5 py-1.5">
        {kind === 'instrument' ? (
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-white/85" data-hint="Also load the effects the preset was designed with (onto the channel's own mixer insert)">
            <input type="checkbox" checked={withFx} onChange={(e) => setWithFx(e.target.checked)} className="h-3.5 w-3.5 cursor-pointer accent-krypt-purple" />
            With effects
          </label>
        ) : (
          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'replace', label: 'Replace', title: 'Swap the insert’s effects for the chain' },
              { value: 'append', label: 'Append', title: 'Add the chain after the effects already there' },
            ]}
          />
        )}
        <span className="ml-auto font-mono text-[9.5px] text-krypt-muted">{busy ? 'Loading…' : `${flat.length} ${kind === 'chain' ? 'chain' : 'preset'}${flat.length === 1 ? '' : 's'}`}</span>
      </div>
    </div>
  );
}
