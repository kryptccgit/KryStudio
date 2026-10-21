import { memo } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Layers, ListChecks, Scissors, Trash2, Waves } from 'lucide-react';
import { takeGroupsOnTrack } from '@shared/schema/takes';
import { secondsToTicks } from '@shared/schema/time';
import { dispatchBatch, getProject, useDocStore } from '../../doc/store';
import { toast } from '../../app/notify';
import type { MenuItem } from '../../editors/ui';
import { cls } from '../../utils/format';
import { useTakeLanes } from './takesStore';
import { laneHeaderInfo } from './takes';
import { takeLaneH } from './takesLayout';

type LaneTake = { groupId: string; takeId: string; pass: number };

export function TakesToggle({ trackId }: { trackId: string }) {
  const groups = useDocStore((s) => (s.project ? takeGroupsOnTrack(s.project, trackId).length : 0));
  const open = useTakeLanes((s) => !!s.open[trackId]);
  if (!groups) return null;
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      data-guide="playlist.takes"
      title={open ? 'Hide take lanes' : 'Show take lanes: drag across a take to comp it'}
      onClick={() => useTakeLanes.getState().toggle(trackId)}
      onPointerDown={(e) => e.stopPropagation()}
      className={cls('flex h-4 shrink-0 items-center gap-0.5 rounded-[3px] px-0.5 transition', open ? 'bg-krypt-purple/25 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white')}
    >
      <Icon size={11} />
      <Layers size={10} />
    </button>
  );
}

async function pickWholeTake(takes: LaneTake[], label: string): Promise<void> {
  if (!takes.length) return;
  const r = await dispatchBatch(
    takes.map((t) => ({ cmd: 'takes.select', args: { groupId: t.groupId, takeId: t.takeId } })),
    { label: `Use ${label}` },
  );
  if (r.ok) {
    const changed = (r.data ?? []).some((x) => (x as { changed?: boolean })?.changed);
    toast.info(changed ? `${label} now plays everywhere it was recorded` : `${label} already plays everywhere it was recorded`);
  }
}

function laneMenu(trackId: string, k: number, count: number, label: string, takes: LaneTake[]): MenuItem[] {
  const groups = [...new Set(takes.map((t) => t.groupId))];
  const xfade = (ms: number) => () => {
    const p = getProject();
    if (!p) return;
    const ticks = Math.round(secondsToTicks(ms / 1000, p.transport.bpm));
    void dispatchBatch(groups.map((groupId) => ({ cmd: 'takes.setCrossfade', args: { groupId, ticks } })), { label: 'Comp crossfade' }).then((r) => {
      if (r.ok) toast.info(ms ? `Comp crossfades: ${ms} ms` : 'Comp crossfades off (hard cuts)');
    });
  };
  return [
    { label: `Use ${label} everywhere`, icon: ListChecks, onClick: () => void pickWholeTake(takes, label) },
    { label: 'Move lane up', icon: ArrowUp, disabled: k === 0, onClick: () => void dispatchBatch(takes.map((t) => ({ cmd: 'takes.moveTake', args: { groupId: t.groupId, takeId: t.takeId, direction: 'up' } })), { label: 'Move take up' }) },
    { label: 'Move lane down', icon: ArrowDown, disabled: k >= count - 1, onClick: () => void dispatchBatch(takes.map((t) => ({ cmd: 'takes.moveTake', args: { groupId: t.groupId, takeId: t.takeId, direction: 'down' } })), { label: 'Move take down' }) },
    { label: 'Crossfade: hard cuts', icon: Scissors, onClick: xfade(0) },
    { label: 'Crossfade: 10 ms', icon: Waves, onClick: xfade(10) },
    { label: 'Crossfade: 20 ms', icon: Waves, onClick: xfade(20) },
    { label: 'Crossfade: 50 ms', icon: Waves, onClick: xfade(50) },
    {
      label: 'Flatten comp (keep the comp, remove the lanes)',
      icon: Layers,
      onClick: () =>
        void dispatchBatch(groups.map((groupId) => ({ cmd: 'takes.flatten', args: { groupId } })), { label: 'Flatten comp' }).then((r) => {
          if (r.ok) {
            useTakeLanes.getState().toggle(trackId, false);
            toast.success('Comp flattened: the comp stays as clips, the unused takes are gone');
          }
        }),
    },
    {
      label: `Delete ${label}`,
      icon: Trash2,
      danger: true,
      onClick: () =>
        void dispatchBatch(takes.map((t) => ({ cmd: 'takes.removeTake', args: { groupId: t.groupId, takeId: t.takeId } })), { label: `Delete ${label}` }).then((r) => {
          if (r.ok) toast.info(`${label} deleted; the latest other take fills its places in the comp`);
        }),
    },
  ];
}

export const TakeLaneHeaders = memo(function TakeLaneHeaders({ trackId, scale, onMenu }: { trackId: string; scale: number; onMenu: (m: { x: number; y: number; items: MenuItem[] }) => void }) {
  const open = useTakeLanes((s) => !!s.open[trackId]);
  const key = useDocStore((s) => (s.project && open ? JSON.stringify(laneHeaderInfo(s.project, trackId)) : ''));
  if (!open || !key) return null;
  const lanes = JSON.parse(key) as ReturnType<typeof laneHeaderInfo>;
  const h = takeLaneH(scale);
  return (
    <div className="bg-black/20">
      {lanes.map((l, k) => (
        <button
          key={k}
          type="button"
          title={`Click: use ${l.label} everywhere it was recorded · drag across it on the right to comp a range · right-click: more`}
          onClick={() => void pickWholeTake(l.takes, l.label)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onMenu({ x: e.clientX, y: e.clientY, items: laneMenu(trackId, k, lanes.length, l.label, l.takes) });
          }}
          className="flex w-full items-center gap-1.5 border-t border-white/[0.04] pl-4 pr-1.5 text-left text-[10px] text-white/55 transition hover:bg-white/[0.04] hover:text-white"
          style={{ height: h }}
        >
          <span className={cls('h-1.5 w-1.5 shrink-0 rounded-full', l.inComp ? 'bg-krypt-pink shadow-[0_0_6px_rgba(236,72,153,0.8)]' : 'bg-white/15')} />
          <span className="min-w-0 flex-1 truncate">{l.label}</span>
          {l.inComp && <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-krypt-pink/80">comp</span>}
        </button>
      ))}
    </div>
  );
});
