// ──────────────────────────────────────────────────────────────────────
// Mixer: master + inserts in insertOrder. Fader, pan, stereo separation,
// mute/solo, canvas peak meters with hold. FL-style routing: select a strip
// and every other strip shows a send toggle + level for "selected → this".
// The selected insert's FX chain sits on the right.
// ──────────────────────────────────────────────────────────────────────

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ArrowDownToLine, Plus, WandSparkles } from 'lucide-react';
import { dispatch, getProject, useProject } from '../../doc/store';
import { useUi, getUi } from '../../state/ui';
import { ParamFader, ParamKnob } from '../../controls/ParamKnob';
import { openMenu } from '../../components/Menu';
import { flashHint } from '../../app/hints';
import { cls } from '../../utils/format';
import { MeterBank } from './meters';
import { addInsert, insertMenuItems, renameInsert } from './mixerActions';
import { FxChain } from './FxChain';
import { openAutoMaster, openAutoMix } from '../../automix/actions';

const STRIP_W = 66;

const Strip = memo(function Strip({
  insertId,
  index,
  selected,
  source,
  faderH,
  bank,
}: {
  insertId: string;
  index: number;
  selected: boolean;
  /** The selected insert (routing source), if not this one and not the master. */
  source: string | null;
  faderH: number;
  bank: MeterBank;
}) {
  const ins = useProject((p) => p.mixer.inserts[insertId]);
  const routeLevel = useProject((p) => (source ? p.mixer.inserts[source]?.routes[insertId] : undefined));
  const sourceName = useProject((p) => (source ? p.mixer.inserts[source]?.name : ''));
  const feeds = useProject((p) => p.channelOrder.filter((c) => p.channels[c]?.insertId === insertId).length);
  const meterRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    bank.register(insertId, meterRef.current, 10, faderH);
    return () => bank.register(insertId, null, 0, 0);
  }, [bank, insertId, faderH]);

  if (!ins) return null;
  const routed = routeLevel !== undefined;
  const label = ins.isMaster ? 'M' : String(index);

  return (
    <div
      className={cls(
        'relative flex h-full flex-shrink-0 flex-col items-center gap-1 border-r border-white/[0.05] px-1 pb-1.5 pt-0 transition-colors',
        selected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.025]',
        ins.isMaster && 'border-r-white/15',
      )}
      style={{ width: ins.isMaster ? STRIP_W + 10 : STRIP_W }}
      data-guide={ins.isMaster ? 'mixer.master' : undefined}
      onMouseDown={(e) => {
        if (e.button === 0) getUi().selectInsert(insertId);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        getUi().selectInsert(insertId);
        openMenu(e, insertMenuItems(insertId, (e.target as Node).ownerDocument));
      }}
    >
      <div className="h-[3px] w-full rounded-b" style={{ background: ins.color }} />
      <div className="flex w-full items-center justify-between px-0.5">
        <span className={cls('font-mono text-[10px]', selected ? 'text-white' : 'text-krypt-muted')}>{label}</span>
        {ins.isMaster && (
          <button
            type="button"
            data-guide="automix.master"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => openAutoMaster(e.currentTarget.ownerDocument)}
            className="flex h-4 items-center gap-0.5 rounded border border-krypt-purple/40 bg-krypt-purple/10 px-1 text-[8.5px] font-bold uppercase tracking-wide text-purple-100 transition hover:bg-krypt-purple/25 hover:text-white"
            data-hint="Auto Master: tone, glue, width and loudness to a target, from a preset or a prompt (one undo step)"
          >
            <WandSparkles className="h-2.5 w-2.5" /> Auto
          </button>
        )}
        {feeds > 0 && (
          <span className="rounded bg-white/[0.06] px-1 font-mono text-[8px] text-krypt-muted" data-hint={`${feeds} channel${feeds === 1 ? '' : 's'} feed this insert`}>
            {feeds}
          </span>
        )}
      </div>
      <button
        type="button"
        onDoubleClick={() => void renameInsert(insertId)}
        className={cls('w-full truncate rounded px-0.5 text-center text-[10px] font-semibold', selected ? 'text-white' : 'text-white/75')}
        data-hint={`${ins.name} · double-click to rename, right-click for options`}
      >
        {ins.isMaster ? 'Master' : ins.name}
      </button>

      <div className="flex items-end gap-1">
        <ParamKnob paramRef={`insert/${insertId}/pan`} size={22} label={`${ins.name} · insert pan`} />
        <ParamKnob paramRef={`insert/${insertId}/stereoSep`} size={16} label={`${ins.name} · stereo separation`} hint="Stereo separation (left = mono, right = wider)" />
      </div>

      <div className="flex min-h-0 flex-1 items-stretch gap-1.5">
        <ParamFader paramRef={`insert/${insertId}/volume`} height={faderH} width={20} label={`${ins.name} · fader`} />
        <canvas ref={meterRef} className="block rounded-sm" style={{ width: 10, height: faderH }} data-hint="Peak meter (hold line, red cap = clipped)" />
      </div>

      <div className="flex gap-0.5">
        <button
          type="button"
          onClick={() => void dispatch('mixer.setInsert', { id: insertId, mute: !ins.mute })}
          className={cls(
            'h-4 w-6 rounded border text-[9px] font-bold transition',
            ins.mute ? 'border-amber-400/50 bg-amber-500/20 text-amber-200' : 'border-white/10 bg-white/[0.03] text-krypt-muted hover:text-white',
          )}
          data-hint={ins.mute ? 'Muted · click to unmute' : 'Mute this insert'}
        >
          M
        </button>
        <button
          type="button"
          onClick={() => void dispatch('mixer.setInsert', { id: insertId, solo: !ins.solo })}
          className={cls(
            'h-4 w-6 rounded border text-[9px] font-bold transition',
            ins.solo ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200' : 'border-white/10 bg-white/[0.03] text-krypt-muted hover:text-white',
          )}
          data-hint={ins.solo ? 'Soloed · click to unsolo' : 'Solo this insert'}
        >
          S
        </button>
      </div>

      {/* FL-style routing from the selected strip into this one */}
      <div className="flex h-5 items-center gap-0.5">
        {source && (
          <>
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() =>
                void dispatch('mixer.setRoute', { from: source, to: insertId, level: routed ? null : 1 }).then(
                  (r) => r.ok && flashHint(routed ? `${sourceName} no longer sends to ${ins.name}` : `${sourceName} → ${ins.name}`, 'ok'),
                )
              }
              className={cls(
                'flex h-4 w-5 items-center justify-center rounded border transition',
                routed ? 'border-krypt-purple/60 bg-krypt-purple/25 text-white shadow-[0_0_8px_rgba(168,85,247,0.45)]' : 'border-white/10 text-white/30 hover:text-white',
              )}
              data-hint={routed ? `${sourceName} sends here · click to remove the route` : `Route ${sourceName} into ${ins.name}`}
            >
              <ArrowDownToLine className="h-3 w-3" />
            </button>
            {routed && <ParamKnob paramRef={`insert/${source}/route/${insertId}`} size={16} label={`Send ${sourceName} → ${ins.name}`} />}
          </>
        )}
      </div>
      {selected && <div className="absolute inset-x-1 bottom-0 h-[2px] rounded-t bg-krypt-gradient" />}
    </div>
  );
});

export function Mixer() {
  const order = useProject(useShallow((p) => p.mixer.insertOrder));
  const masterId = useProject((p) => p.mixer.masterId);
  const selectedRaw = useUi((s) => s.selectedInsertId);
  const selected = selectedRaw && order.includes(selectedRaw) ? selectedRaw : masterId;
  const bank = useMemo(() => new MeterBank(), []);
  const areaRef = useRef<HTMLDivElement>(null);
  const [faderH, setFaderH] = useState(140);

  useEffect(() => bank.start(), [bank]);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      setFaderH(Math.max(60, Math.min(420, h - 168)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const source = selected !== masterId ? selected : null;

  return (
    <div className="flex h-full bg-[#0c0c12]">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar: Auto Mix (src/automix) */}
        <div className="flex h-7 flex-shrink-0 items-center gap-2 border-b border-white/[0.06] bg-krypt-panel px-2">
          <button
            type="button"
            data-guide="automix.open"
            onClick={(e) => openAutoMix({ doc: e.currentTarget.ownerDocument })}
            className="flex h-5 items-center gap-1 rounded-md border border-krypt-purple/40 bg-krypt-purple/10 px-2 text-[10.5px] font-semibold text-purple-100 transition hover:bg-krypt-purple/25 hover:text-white"
            data-hint="Auto Mix: the vocals, the whole mix or the master, from a preset or a prompt. Measured, real knob settings, one undo step"
          >
            <WandSparkles className="h-3 w-3" /> Auto Mix
          </button>
          <span className="min-w-0 truncate text-[10px] text-krypt-muted">Vocals, mix or master from a preset or a prompt</span>
        </div>
        <div ref={areaRef} className="relative min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex h-full">
            {order.map((id, i) => (
              <Strip key={id} insertId={id} index={i} selected={selected === id} source={source && source !== id ? source : null} faderH={faderH} bank={bank} />
            ))}
            <div className="flex h-full w-14 flex-shrink-0 flex-col items-center justify-start pt-6">
              <button
                type="button"
                onClick={() => void addInsert()}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-white/15 text-krypt-muted transition hover:border-krypt-purple/60 hover:text-white"
                data-hint="Add a mixer insert (routed to the master)"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
      <FxChain insertId={selected} />
    </div>
  );
}

export function selectedInsertOrMaster(): string {
  const p = getProject();
  const s = getUi().selectedInsertId;
  return s && p.mixer.inserts[s] ? s : p.mixer.masterId;
}
