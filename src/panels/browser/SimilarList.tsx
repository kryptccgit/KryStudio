import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileAudio, Loader2, Replace, ScanSearch, Square, SwatchBook } from 'lucide-react';
import type { BrowserEntry, SimilarItem, SimilarResult } from '@shared/types';
import { getProject } from '../../doc/store';
import { effectiveChannelId } from '../../state/ui';
import { openMenu, type MenuItem } from '../../components/Menu';
import { flashHint } from '../../app/hints';
import { toast } from '../../app/notify';
import { cls } from '../../utils/format';
import { addSampleChannel, replaceChannelSample, SAMPLE_MIME } from '../channelRack/rackActions';
import { addPresetChannel, loadPresetOnChannel } from '../../sounds/actions';
import { encodePresetDrag, PRESET_MIME, sampleDetail } from '../../sounds/logic';
import { closeSimilar, openSimilar, type SimilarRequest } from '../../sounds/similar';
import { kindName, measuringText, shouldMeasureMore, similarItemKey, sourceKindText } from '../../sounds/similarLogic';

type Scope = 'same' | 'any';

async function loadOntoSelected(i: SimilarItem): Promise<void> {
  const chId = effectiveChannelId();
  const ch = chId ? getProject().channels[chId] : null;
  if (!ch) {
    toast.warn('Select a channel in the Channel Rack first');
    return;
  }
  if (i.type === 'sample') await replaceChannelSample(ch.id, i.path);
  else await loadPresetOnChannel(ch.id, i.id);
}

function selectedChannelName(): string | null {
  const id = effectiveChannelId();
  return id ? (getProject().channels[id]?.name ?? null) : null;
}

export function SimilarList({
  request,
  previewing,
  selected,
  onSelect,
  onClickSample,
}: {
  request: SimilarRequest;
  previewing: string | null;
  selected: string | null;
  onSelect: (key: string) => void;
  onClickSample: (e: BrowserEntry) => void;
}) {
  const [scope, setScope] = useState<Scope>('same');
  const [res, setRes] = useState<SimilarResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const token = useRef(0);
  const stopRef = useRef(false);

  const search = useCallback(
    async (sc: Scope, keep: boolean) => {
      const my = ++token.current;
      stopRef.current = false;
      setStopped(false);
      setBusy(true);
      setError(null);
      if (!keep) setRes(null);
      let warned = false;
      try {
        for (let round = 0; ; round++) {
          const r = await window.krypt.sounds.similar(request.source, { scope: sc, limit: 40 });
          if (my !== token.current) return;
          if (!r.ok || !r.data) {
            const m = r.message || "Couldn't find similar sounds";
            setError(m);
            toast.error(m);
            break;
          }
          setRes(r.data);
          if (!warned && r.data.notes.length) {
            warned = true;
            toast.warn(r.data.notes[0]);
          }
          if (stopRef.current || !shouldMeasureMore(r.data, round)) break;
        }
      } catch (err) {
        if (my !== token.current) return;
        const m = `Couldn't find similar sounds: ${(err as Error).message}`;
        setError(m);
        toast.error(m);
      } finally {
        if (my === token.current) setBusy(false);
      }
    },
    [request.source],
  );

  useEffect(() => {
    void search(scope, false);
    return () => {
      token.current++;
    };
  }, [search, scope]);

  const stop = (): void => {
    stopRef.current = true;
    setStopped(true);
    flashHint('Stopped measuring pack sounds: the list shows what is measured so far', 'info');
  };

  const chName = selectedChannelName();

  const moreLike = (i: SimilarItem): void => openSimilar(i.type === 'sample' ? { kind: 'sample', path: i.path } : { kind: 'preset', id: i.id }, i.name);

  const menu = (ev: React.MouseEvent, i: SimilarItem): void => {
    ev.preventDefault();
    onSelect(similarItemKey(i));
    const items: MenuItem[] = [{ type: 'header', label: i.name }];
    if (i.type === 'sample') {
      items.push(
        { label: previewing === i.path ? 'Stop preview' : 'Preview', onSelect: () => onClickSample({ name: i.name, path: i.path, kind: 'audio' }) },
        { label: 'Add to Channel Rack', icon: FileAudio, onSelect: () => void addSampleChannel(i.path) },
      );
    } else items.push({ label: 'Add to Channel Rack', icon: SwatchBook, onSelect: () => void addPresetChannel(i.id) });
    items.push(
      { label: chName ? `Load onto ${chName}` : 'Load onto selected channel', icon: Replace, disabled: !chName, hint: i.type === 'sample' ? 'Replace the selected channel’s sample (one undo step)' : 'Replace the selected channel’s sound with this preset (one undo step)', onSelect: () => void loadOntoSelected(i) },
      { type: 'separator' },
      { label: 'More like this', icon: ScanSearch, onSelect: () => moreLike(i) },
    );
    openMenu(ev, items);
  };

  const row = (i: SimilarItem) => {
    const key = similarItemKey(i);
    const isPrev = i.type === 'sample' && previewing === i.path;
    const Icon = i.type === 'sample' ? FileAudio : SwatchBook;
    const kindText = i.type === 'sample' ? kindName(i.kind) : kindName(i.role);
    const detail = i.type === 'sample' ? sampleDetail(i) : '';
    return (
      <div
        key={key}
        draggable
        onDragStart={(ev) => {
          if (i.type === 'sample') {
            ev.dataTransfer.setData(SAMPLE_MIME, i.path);
            ev.dataTransfer.setData('text/plain', i.path);
          } else {
            ev.dataTransfer.setData(PRESET_MIME, encodePresetDrag({ id: i.id, kind: 'instrument', name: i.name }));
            ev.dataTransfer.setData('text/plain', i.name);
          }
          ev.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => {
          if (i.type === 'sample') onClickSample({ name: i.name, path: i.path, kind: 'audio' });
          else {
            onSelect(key);
            flashHint(`${i.name} · ${kindText} preset · double-click or drag onto the Channel Rack to add it`, 'info', 3000);
          }
        }}
        onDoubleClick={() => void (i.type === 'sample' ? addSampleChannel(i.path) : addPresetChannel(i.id))}
        onContextMenu={(ev) => menu(ev, i)}
        className={cls('group cursor-grab rounded py-0.5 pl-1.5 pr-1 transition-colors', selected === key ? 'bg-white/[0.08] text-white' : 'text-white/80 hover:bg-white/[0.04] hover:text-white')}
        data-hint={`${i.name} · ${i.percent}% similar · ${i.why}. ${i.type === 'sample' ? 'Click to preview, drag onto the Channel Rack / Playlist, double-click to add' : 'Double-click or drag onto the Channel Rack to add'}; right-click for more`}
      >
        <div className="flex h-[18px] items-center gap-1.5 text-[11px]">
          <Icon className={cls('h-3.5 w-3.5 flex-shrink-0', isPrev ? 'text-emerald-300' : 'text-krypt-muted')} />
          <span className="truncate">{i.name}</span>
          {(shownScope === 'any' || !i.sameKind || i.type === 'preset') && <span className="flex-shrink-0 text-[9px] text-krypt-muted/70">{kindText}</span>}
          {isPrev && <Square className="h-2.5 w-2.5 flex-shrink-0 fill-emerald-300 text-emerald-300" />}
          <span className="ml-auto flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation();
              void loadOntoSelected(i);
            }}
            onDoubleClick={(ev) => ev.stopPropagation()}
            className="hidden h-4 w-4 flex-shrink-0 items-center justify-center rounded text-krypt-muted hover:bg-white/10 hover:text-white group-hover:flex"
            data-hint={chName ? `Load onto ${chName} (the selected channel)` : 'Load onto the selected channel'}
            aria-label="Load onto selected channel"
          >
            <Replace className="h-3 w-3" />
          </button>
          <span className={cls('font-mono text-[9.5px]', i.percent >= 85 ? 'text-krypt-purple' : 'text-krypt-muted/80')}>{i.percent}%</span>
          </span>
        </div>
        <div className="truncate pl-5 text-[9.5px] leading-tight text-krypt-muted/70">
          {i.why}
          {detail ? ` · ${detail}` : ''}
          {i.type === 'sample' && i.origin === 'pack' ? ' · sound pack' : ''}
          {i.type === 'preset' && i.origin === 'user' ? ' · yours' : ''}
        </div>
      </div>
    );
  };

  const items = res?.items ?? [];
  const pending = res?.pending ?? 0;
  const shownScope: Scope = res?.scope ?? scope;
  return (
    <div className="flex min-h-0 flex-col" data-guide="browser.similar">
      <div className="flex items-center gap-1 px-0.5 pb-1">
        <button type="button" onClick={closeSimilar} className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-krypt-muted hover:bg-white/[0.06] hover:text-white" data-hint="Back to the Browser" aria-label="Back">
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-semibold text-white">Similar to {request.name}</div>
          <div className="truncate text-[9.5px] text-krypt-muted/80">{res ? sourceKindText(res) : busy ? 'Measuring the sound…' : ' '}</div>
        </div>
      </div>
      <div className="mx-0.5 mb-1 flex rounded-md border border-white/10 p-0.5 text-[10px]">
        {(['same', 'any'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScope(s)}
            disabled={s === 'same' && !!res && !res.source.kind}
            className={cls('h-5 flex-1 rounded transition-colors disabled:opacity-40', shownScope === s ? 'bg-white/10 text-white' : 'text-krypt-muted hover:text-white')}
            data-hint={s === 'same' ? 'The same kind of sound and close relatives (a kick finds kicks)' : 'Every kind of sound, by timbre alone'}
          >
            {s === 'same' ? 'Same kind' : 'Any kind'}
          </button>
        ))}
      </div>
      {busy && pending > 0 && !stopped && (
        <div className="mx-0.5 mb-1 flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-1 text-[10px] text-krypt-muted">
          <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-krypt-purple" />
          <span className="truncate">{measuringText(pending)}</span>
          <button type="button" onClick={stop} className="ml-auto rounded px-1 text-krypt-muted hover:bg-white/10 hover:text-white" data-hint="Stop measuring: rank only what is measured so far">
            Stop
          </button>
        </div>
      )}
      {!busy && pending > 0 && (
        <div className="mx-0.5 mb-1 flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-1 text-[10px] text-krypt-muted">
          <span className="truncate">
            {pending} pack sound{pending === 1 ? '' : 's'} not measured yet
          </span>
          <button type="button" onClick={() => void search(scope, true)} className="ml-auto rounded px-1 text-krypt-purple hover:bg-white/10" data-hint="Measure the rest and include them">
            Measure
          </button>
        </div>
      )}
      {busy && !res && (
        <div className="flex items-center gap-2 p-2 text-[11px] text-krypt-muted">
          <Loader2 className="h-3 w-3 animate-spin" /> Finding sounds like {request.name}…
        </div>
      )}
      {error && !res && <div className="p-2 text-[11px] leading-snug text-rose-300">{error}</div>}
      {res && !items.length && (
        <div className="p-2 text-[11px] leading-snug text-krypt-muted">
          {shownScope === 'same' ? (
            <>
              No other {kindName(res.source.kind).toLowerCase()} sounds to compare with{pending ? ' yet' : ''}.{' '}
              <button type="button" onClick={() => setScope('any')} className="text-krypt-purple hover:underline">
                Try any kind
              </button>
            </>
          ) : (
            'Nothing in the library to compare it with.'
          )}
        </div>
      )}
      {items.map(row)}
    </div>
  );
}
