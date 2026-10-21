import { useEffect, useMemo, useState } from 'react';
import { Bot, Loader2, RotateCcw, Undo2, User } from 'lucide-react';
import type { HistorySummary } from '@shared/doc/DocHost';
import { modal, report, toast } from '../../app/notify';
import { cls } from '../../utils/format';

function timeLabel(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

type Filter = 'all' | 'agents' | 'you';

export function HistoryPanel() {
  const [entries, setEntries] = useState<HistorySummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const load = async (): Promise<void> => {
      try {
        const h = await window.krypt.doc.history();
        if (alive) setEntries(h);
      } catch (err) {
        if (alive) setEntries([]);
        toast.error(`Couldn't load history: ${(err as Error).message}`);
      }
    };
    void load();
    const off = window.krypt.doc.onHistoryChanged(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void load(), 120);
    });
    return () => {
      alive = false;
      off();
      if (t) clearTimeout(t);
    };
  }, []);

  const groups = useMemo(() => {
    const list = [...(entries ?? [])].reverse();
    const by = new Map<string, { key: string; name: string; items: HistorySummary[] }>();
    for (const e of list) {
      if (filter === 'agents' && !e.actorKey.startsWith('agent:')) continue;
      if (filter === 'you' && e.actorKey !== 'user') continue;
      const g = by.get(e.actorKey) ?? { key: e.actorKey, name: e.actorName, items: [] };
      g.items.push(e);
      by.set(e.actorKey, g);
    }
    return [...by.values()].sort((a, b) => (a.key.startsWith('agent:') === b.key.startsWith('agent:') ? 0 : a.key.startsWith('agent:') ? -1 : 1));
  }, [entries, filter]);

  const toggle = async (e: HistorySummary): Promise<void> => {
    setBusy(e.id);
    try {
      const r = await window.krypt.doc.toggleEntry(e.id);
      report(r, r.message ?? (e.undone ? 'Re-applied' : 'Reverted'));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const revertAll = async (key: string, name: string, live: number): Promise<void> => {
    const ok = await modal.confirm({
      title: `Revert everything ${name} did?`,
      message: `${live} live edit${live === 1 ? '' : 's'} by ${name} will be undone, newest first. Edits you made on top of them may block some steps; you'll be told which.`,
      confirmLabel: 'Revert all AI edits',
      destructive: true,
    });
    if (!ok) return;
    setBusy(key);
    try {
      const r = await window.krypt.doc.revertActor(key);
      if (r.ok) toast.success(r.message ?? 'Reverted');
      else toast.warn(r.message ?? 'Some edits could not be reverted');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const agentKeys = groups.filter((g) => g.key.startsWith('agent:'));

  return (
    <div className="flex h-full flex-col bg-[#0b0b11]">
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-white/[0.06] p-1.5">
        {(['all', 'agents', 'you'] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cls(
              'h-6 rounded-md px-2 text-[10px] font-semibold uppercase tracking-wider transition',
              filter === f ? 'bg-white/10 text-white' : 'text-krypt-muted hover:text-white',
            )}
          >
            {f === 'all' ? 'All' : f === 'agents' ? 'AI' : 'You'}
          </button>
        ))}
        <span className="ml-auto pr-1 font-mono text-[9px] text-krypt-muted">{entries?.length ?? 0} entries</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {entries === null && (
          <div className="flex items-center gap-2 text-[11px] text-krypt-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        )}
        {entries && !groups.length && (
          <div className="pt-6 text-center text-[11px] text-krypt-muted">{filter === 'agents' ? 'No AI edits yet.' : 'No edits yet. Everything you and agents change shows up here.'}</div>
        )}
        {groups.map((g) => {
          const isAgent = g.key.startsWith('agent:');
          const live = g.items.filter((i) => !i.undone).length;
          return (
            <div key={g.key} className="mb-3">
              <div className="mb-1 flex items-center gap-1.5 px-0.5">
                {isAgent ? <Bot className="h-3.5 w-3.5 text-krypt-purple" /> : <User className="h-3.5 w-3.5 text-krypt-muted" />}
                <span className={cls('text-[11px] font-semibold', isAgent ? 'text-purple-200' : 'text-white/85')}>{g.name}</span>
                <span className="font-mono text-[9px] text-krypt-muted">
                  {live}/{g.items.length} live
                </span>
                {isAgent && (
                  <button
                    disabled={!live || busy === g.key}
                    data-guide="history.revertAgent"
                    onClick={() => void revertAll(g.key, g.name, live)}
                    className="ml-auto flex h-5 items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-1.5 text-[10px] font-semibold text-rose-100 transition hover:bg-rose-500/20 disabled:opacity-40"
                    data-hint={`Undo every live edit ${g.name} made`}
                  >
                    {busy === g.key ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />} Revert all AI edits
                  </button>
                )}
              </div>
              <div className="space-y-px">
                {g.items.map((e) => (
                  <div
                    key={e.id}
                    className={cls(
                      'group flex items-center gap-2 rounded-md px-2 py-1 text-[11px] transition',
                      e.undone ? 'text-white/35' : 'text-white/85 hover:bg-white/[0.04]',
                    )}
                  >
                    <span className={cls('h-1.5 w-1.5 flex-shrink-0 rounded-full', e.undone ? 'bg-white/15' : isAgent ? 'bg-krypt-purple' : 'bg-white/50')} />
                    <span className={cls('min-w-0 flex-1 truncate', e.undone && 'line-through')}>{e.label}</span>
                    <span className="font-mono text-[9px] text-krypt-muted">{timeLabel(e.time)}</span>
                    <button
                      disabled={busy === e.id}
                      onClick={() => void toggle(e)}
                      className={cls(
                        'flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-semibold transition',
                        e.undone ? 'text-emerald-300 hover:bg-emerald-500/15' : 'text-krypt-muted opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100',
                      )}
                      data-hint={e.undone ? 'Re-apply this edit' : 'Revert just this edit (blocked if a later edit touched the same thing)'}
                    >
                      {busy === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                      {e.undone ? 'Re-apply' : 'Revert'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {filter !== 'you' && agentKeys.length > 1 && (
          <div className="text-[10px] text-krypt-muted">Each agent is reverted separately, so one agent's work can be kept while another's is undone.</div>
        )}
      </div>
    </div>
  );
}
