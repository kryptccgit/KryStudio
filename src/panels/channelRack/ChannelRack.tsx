// ──────────────────────────────────────────────────────────────────────
// Channel Rack — FL's heart, in the Krypt look. Per row: activity LED,
// mute, pan/volume knobs, mixer insert, the channel button (opens its
// plugin), then the step grid (or a mini piano roll). Drag samples in from
// the Browser, reorder rows by the grip, right-click for everything else.
// ──────────────────────────────────────────────────────────────────────

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { BarChart3, GripVertical, ListFilter, Plus } from 'lucide-react';
import { pluginById } from '@shared/plugins/catalog';
import { patternLength } from '@shared/schema/project';
import { TICKS_PER_STEP, ticksPerBar } from '@shared/schema/time';
import { stepsPerBeatGroup } from '@shared/schema/meter';
import { dispatch, getProject, useProject } from '../../doc/store';
import { onFrame } from '../../render/frameLoop';
import { telemetry } from '../../live/telemetry';
import { playState } from '../../live/playState';
import { useUi, getUi, type GraphLane as Lane } from '../../state/ui';
import { ParamKnob } from '../../controls/ParamKnob';
import { Select, Toggle } from '../../controls/Toggle';
import { openMenu, toggleMenuAt } from '../../components/Menu';
import { PatternPicker } from '../../app/PatternPicker';
import { flashHint } from '../../app/hints';
import { handleOsDrop } from '../../app/fileDrop';
import { wm, useWorkspace } from '../../workspace/WindowManager';
import { pluginPanelId } from '../../workspace/panels';
import { cls } from '../../utils/format';
import { CELL_W, MiniRoll, ROW_H, StepGrid, analyzeSteps } from './StepRow';
import { GraphLane } from './GraphLane';
import {
  CHANNEL_MIME,
  SAMPLE_MIME,
  addSampleChannel,
  channelMenuItems,
  deleteChannel,
  insertMenuItems,
  instrumentPickerItems,
  replaceChannelSample,
  setPatternSteps,
  STEP_LENGTHS,
} from './rackActions';
import { ALL_GROUPS, cycleFilter, filterChannels, groupNames, useRackView } from './groups';
import { decodePresetDrag, PRESET_MIME } from '../../sounds/logic';
import { addPresetChannel } from '../../sounds/actions';

const LEFT_W = 262;

type LedMap = Map<string, HTMLElement>;

function hasType(e: React.DragEvent, mime: string): boolean {
  return Array.from(e.dataTransfer.types).includes(mime);
}

const ChannelRow = memo(function ChannelRow({
  channelId,
  index,
  patternId,
  steps,
  lengthTicks,
  stepsPerBeat,
  selected,
  leds,
}: {
  channelId: string;
  index: number;
  patternId: string;
  steps: number;
  lengthTicks: number;
  stepsPerBeat: number;
  selected: boolean;
  leds: LedMap;
}) {
  const ch = useProject((p) => p.channels[channelId]);
  const notes = useProject((p) => p.patterns[patternId]?.notes[channelId]);
  const insertNum = useProject((p) => (ch ? (ch.insertId === p.mixer.masterId ? 'M' : String(p.mixer.insertOrder.indexOf(ch.insertId))) : ''));
  const pluginOpen = useWorkspace((s) => s.open.includes(pluginPanelId({ kind: 'channel', channelId })));
  const [drop, setDrop] = useState<null | 'above' | 'below' | 'sample'>(null);
  const insertBtn = useRef<HTMLButtonElement>(null);
  const { isSteps } = useMemo(() => analyzeSteps(notes), [notes]);

  if (!ch) return null;
  const gen = pluginById(ch.generator.type);
  const sample = ch.generator.sampleId ? getProject().samples[ch.generator.sampleId] : null;

  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (hasType(e, CHANNEL_MIME)) {
      e.preventDefault();
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      setDrop(e.clientY < r.top + r.height / 2 ? 'above' : 'below');
    } else if (hasType(e, SAMPLE_MIME) || hasType(e, 'Files')) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setDrop('sample');
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    const where = drop;
    setDrop(null);
    const moved = e.dataTransfer.getData(CHANNEL_MIME);
    if (moved) {
      e.preventDefault();
      e.stopPropagation();
      if (moved === channelId) return;
      const order = getProject().channelOrder.filter((c) => c !== moved);
      const at = order.indexOf(channelId) + (where === 'below' ? 1 : 0);
      void dispatch('channels.move', { id: moved, toIndex: at }).then((r) => r.ok && flashHint('Channel moved', 'ok', 1000));
      return;
    }
    const path = e.dataTransfer.getData(SAMPLE_MIME);
    if (path) {
      e.preventDefault();
      e.stopPropagation();
      void replaceChannelSample(channelId, path);
      return;
    }
    if (hasType(e, 'Files')) {
      e.preventDefault();
      e.stopPropagation();
      void handleOsDrop(e.dataTransfer, (paths) => replaceChannelSample(channelId, paths[0]));
    }
  };

  return (
    <div
      className={cls('group relative flex items-center', selected ? 'bg-white/[0.045]' : 'hover:bg-white/[0.02]')}
      style={{ height: ROW_H }}
      onDragOver={onDragOver}
      onDragLeave={() => setDrop(null)}
      onDrop={onDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        getUi().selectChannel(channelId);
        openMenu(e, channelMenuItems(channelId, (e.target as Node).ownerDocument));
      }}
    >
      {drop === 'above' && <div className="pointer-events-none absolute left-0 right-0 top-0 z-20 h-[2px] bg-krypt-gradient" />}
      {drop === 'below' && <div className="pointer-events-none absolute left-0 right-0 bottom-0 z-20 h-[2px] bg-krypt-gradient" />}
      {drop === 'sample' && <div className="pointer-events-none absolute inset-0 z-20 rounded border border-krypt-purple/70 bg-krypt-purple/10" />}

      {/* Left, sticky controls */}
      <div
        className={cls('sticky left-0 z-10 flex h-full flex-shrink-0 items-center gap-1 pl-0.5 pr-2', selected ? 'bg-[#13131c]' : 'bg-[#0c0c12] group-hover:bg-[#0f0f16]')}
        style={{ width: LEFT_W }}
      >
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(CHANNEL_MIME, channelId);
            e.dataTransfer.effectAllowed = 'move';
          }}
          className="flex h-full w-3 cursor-grab items-center justify-center text-white/0 group-hover:text-white/30 hover:!text-white/70"
          data-hint="Drag to reorder channels"
        >
          <GripVertical className="h-3 w-3" />
        </span>
        <span
          ref={(el) => {
            if (el) leds.set(channelId, el);
            else leds.delete(channelId);
          }}
          className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
          style={{ background: ch.color, opacity: 0.15 }}
          data-hint="Activity: lights when this channel plays"
        />
        <Toggle
          variant="led"
          tone="green"
          on={!ch.mute}
          onChange={(on) => void dispatch('channels.set', { id: channelId, mute: !on })}
          hint={`${ch.mute ? 'Muted' : 'On'} · click to ${ch.mute ? 'unmute' : 'mute'}, right-click to solo`}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void dispatch('channels.solo', { id: channelId });
          }}
        />
        <ParamKnob paramRef={`channel/${channelId}/pan`} size={18} label={`${ch.name} · channel pan`} />
        <ParamKnob paramRef={`channel/${channelId}/volume`} size={18} label={`${ch.name} · channel volume`} />
        <button
          ref={insertBtn}
          type="button"
          onClick={() => insertBtn.current && toggleMenuAt(insertBtn.current, () => insertMenuItems(channelId), { minWidth: 200 })}
          onWheel={(e) => {
            const p = getProject();
            const order = p.mixer.insertOrder;
            const i = order.indexOf(ch.insertId);
            const next = order[Math.max(0, Math.min(order.length - 1, i + (e.deltaY > 0 ? 1 : -1)))];
            if (next && next !== ch.insertId) void dispatch('channels.set', { id: channelId, insertId: next });
          }}
          className="h-[18px] w-7 flex-shrink-0 rounded border border-white/10 bg-black/50 font-mono text-[10px] text-white/80 hover:border-white/25 hover:text-white"
          data-hint={`Mixer insert ${insertNum === 'M' ? 'Master' : insertNum}: click to change, wheel to step`}
        >
          {insertNum}
        </button>
        <button
          type="button"
          onClick={(e) => {
            getUi().selectChannel(channelId);
            if (e.ctrlKey) {
              // FL: Ctrl+click previews the channel.
              try {
                window.krypt.engine.audition(channelId, ch.rootKey, 0.8, true);
                setTimeout(() => window.krypt.engine.audition(channelId, ch.rootKey, 0, false), 250);
              } catch {
                /* ignore */
              }
              return;
            }
            wm.togglePlugin({ kind: 'channel', channelId });
          }}
          onDoubleClick={(e) => e.preventDefault()}
          className={cls(
            'relative flex h-[22px] min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-md border pl-2 pr-1.5 text-left text-[11px] font-semibold transition',
            selected ? 'border-white/25 bg-white/[0.08] text-white' : 'border-white/10 bg-white/[0.03] text-white/85 hover:border-white/20 hover:bg-white/[0.06]',
            pluginOpen && 'shadow-krypt-glow',
          )}
          data-hint={`${ch.name} · ${gen?.name ?? ch.generator.type}${sample ? ` · ${sample.name}` : ''} · click: plugin editor, Ctrl+click: preview, right-click: menu`}
        >
          <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: ch.color }} />
          <span className="truncate">{ch.name}</span>
          <span className="ml-auto flex-shrink-0 font-mono text-[8px] uppercase text-krypt-muted/60">{index + 1}</span>
        </button>
        {selected && <span className="absolute right-0 top-1 bottom-1 w-0.5 rounded-l bg-krypt-gradient" />}
      </div>

      {/* Steps or mini piano roll (data-tour-steps: "click 4 boxes on the Kick row", src/tours) */}
      <div className="flex h-full items-center pl-1" data-tour-steps={channelId}>
        {isSteps ? (
          <StepGrid channelId={channelId} patternId={patternId} notes={notes} steps={steps} color={ch.color} stepsPerBeat={stepsPerBeat} />
        ) : (
          <MiniRoll channelId={channelId} notes={notes} lengthTicks={lengthTicks} width={steps * CELL_W} color={ch.color} />
        )}
      </div>

      {/* Selection strip (FL's select LED) */}
      <button
        type="button"
        onClick={() => getUi().selectChannel(channelId)}
        className={cls('ml-1.5 h-[18px] w-2 flex-shrink-0 rounded-sm transition', selected ? 'bg-krypt-gradient' : 'bg-white/[0.06] hover:bg-white/20')}
        data-hint="Select: the Piano Roll and the typing keyboard follow the selected channel"
      />
    </div>
  );
});

const STEP_OPTIONS: Array<{ value: number; label: string }> = [{ value: 0, label: 'Auto' }, ...STEP_LENGTHS.map((n) => ({ value: n, label: `${n} steps` }))];

export function ChannelRack() {
  const allChannels = useProject(useShallow((p) => p.channelOrder));
  const filter = useRackView((s) => s.filter);
  const setFilter = useRackView((s) => s.setFilter);
  // Channels shown under the active filter group (FL display filter); 'All' keeps the stable order array.
  const channelOrder = useProject(useShallow((p) => filterChannels(p, filter)));
  // "name\u0001count" per filter option, as one primitive so the header only re-renders on real changes.
  const groupKey = useProject((p) => [ALL_GROUPS, ...groupNames(p)].map((g) => `${g}\u0001${filterChannels(p, g).length}`).join('\u0002'));
  const patternId = useProject((p) => p.transport.activePatternId);
  const pattern = useProject((p) => (p.transport.activePatternId ? p.patterns[p.transport.activePatternId] : null));
  const timeSig = useProject((p) => p.transport.timeSig);
  const selected = useUi((s) => s.selectedChannelId);
  const graphLane = useUi((s) => s.graphLane);
  const setGraphLane = useUi((s) => s.setGraphLane);
  const leds = useRef<LedMap>(new Map()).current;
  const playheadRef = useRef<HTMLDivElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [dropEnd, setDropEnd] = useState(false);

  const stepsPerBar = Math.max(1, Math.round(ticksPerBar(timeSig) / TICKS_PER_STEP));
  const stepsPerBeat = stepsPerBeatGroup(timeSig); // shading per felt beat: 4 in 4/4, 6 (a dotted quarter) in 6/8
  const lengthTicks = pattern ? patternLength(pattern, timeSig) : ticksPerBar(timeSig);
  const steps = Math.max(stepsPerBar, Math.ceil(lengthTicks / TICKS_PER_STEP));
  const fixedSteps = pattern?.length ? Math.round(pattern.length / TICKS_PER_STEP) : 0;

  // Default selection: first channel.
  useEffect(() => {
    if (!selected && channelOrder.length) getUi().selectChannel(channelOrder[0]);
  }, [selected, channelOrder]);

  // LEDs + step playhead: one frame subscriber for the whole rack, direct DOM writes.
  useEffect(() => {
    const ledCache = new Map<string, number>();
    let lastX = -1;
    return onFrame(() => {
      for (const [id, el] of leds) {
        const a = Math.round(telemetry.channelActivity(id) * 20) / 20;
        if (ledCache.get(id) !== a) {
          ledCache.set(id, a);
          el.style.opacity = String(0.15 + 0.85 * a);
          el.style.boxShadow = a > 0.05 ? `0 0 ${4 + 6 * a}px ${el.style.background}` : 'none';
        }
      }
      const ph = playheadRef.current;
      if (!ph) return;
      const t = playState.patternTick();
      const x = t === null ? -1 : Math.floor(t / TICKS_PER_STEP) * CELL_W;
      if (x !== lastX) {
        lastX = x;
        ph.style.display = x < 0 ? 'none' : 'block';
        if (x >= 0) ph.style.transform = `translateX(${x}px)`;
      }
    });
  }, [leds]);

  const setSteps = (n: number): void => void setPatternSteps(n);

  const filterOptions = groupKey.split('\u0002').map((s) => {
    const [g, n] = s.split('\u0001');
    return { value: g, label: `${g} (${n})` };
  });
  if (!filterOptions.some((o) => o.value === filter)) filterOptions.push({ value: filter, label: `${filter} (0)` });

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      // FL: PgUp / PgDn step through the Channel Rack filter groups.
      e.preventDefault();
      const g = cycleFilter(getProject(), e.key === 'PageUp' ? -1 : 1);
      flashHint(`Channel Rack filter: ${g}`, 'ok', 1200);
      return;
    }
    const order = channelOrder;
    const i = selected ? order.indexOf(selected) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = order[Math.max(0, Math.min(order.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) getUi().selectChannel(next);
    } else if (e.key === 'Enter' && selected) {
      e.preventDefault();
      wm.togglePlugin({ kind: 'channel', channelId: selected });
    } else if (e.key === 'Delete' && selected) {
      e.preventDefault();
      void deleteChannel(selected);
    }
  };

  const onBodyDragOver = (e: React.DragEvent): void => {
    if (hasType(e, SAMPLE_MIME) || hasType(e, 'Files') || hasType(e, PRESET_MIME)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setDropEnd(true);
    }
  };

  const onBodyDrop = (e: React.DragEvent): void => {
    setDropEnd(false);
    // A preset from the Browser's Presets section: a new channel playing it (src/sounds).
    const preset = decodePresetDrag(e.dataTransfer.getData(PRESET_MIME));
    if (preset) {
      e.preventDefault();
      e.stopPropagation();
      void addPresetChannel(preset.id);
      return;
    }
    const path = e.dataTransfer.getData(SAMPLE_MIME);
    if (path) {
      e.preventDefault();
      e.stopPropagation();
      void addSampleChannel(path);
      return;
    }
    if (hasType(e, 'Files')) {
      e.preventDefault();
      e.stopPropagation();
      void handleOsDrop(e.dataTransfer, async (paths) => {
        for (const p of paths) await addSampleChannel(p);
      });
    }
  };

  const laneOpts: Array<{ value: Lane; label: string }> = [
    { value: 'off', label: 'Graph off' },
    { value: 'vel', label: 'Velocity' },
    { value: 'pan', label: 'Pan' },
  ];

  return (
    <div className="flex h-full flex-col bg-[#0c0c12]" tabIndex={0} onKeyDown={onKeyDown} data-editor="channelRack">
      {/* Header */}
      <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-white/[0.06] px-2">
        <PatternPicker compact />
        <Select
          value={fixedSteps}
          options={STEP_OPTIONS.some((o) => o.value === fixedSteps) ? STEP_OPTIONS : [...STEP_OPTIONS, { value: fixedSteps, label: `${fixedSteps} steps` }]}
          onChange={setSteps}
          hint="Pattern length in steps (Auto follows the notes)"
          width={84}
        />
        <div className="flex items-center gap-1" data-hint="Filter group: show All channels, or only Drums / Synths / your own groups (PgUp / PgDn)">
          <ListFilter className={cls('h-3 w-3', filter === ALL_GROUPS ? 'text-krypt-muted' : 'text-krypt-purple')} />
          <Select<string> value={filter} options={filterOptions} onChange={(g) => setFilter(g)} hint="Channel filter group" width={92} />
        </div>
        <div className="flex items-center gap-1" data-hint="Graph editor: per-step velocity / pan lane under the selected channel">
          <BarChart3 className="h-3 w-3 text-krypt-muted" />
          {laneOpts.slice(1).map((o) => (
            <Toggle key={o.value} variant="button" on={graphLane === o.value} onChange={(on) => setGraphLane(on ? o.value : 'off')} hint={`Graph editor: ${o.label}`}>
              {o.label === 'Velocity' ? 'Vel' : 'Pan'}
            </Toggle>
          ))}
        </div>
        <div className="flex items-center gap-1 pl-1" data-guide="channelRack.swing">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-krypt-muted">Swing</span>
          <ParamKnob paramRef="transport/swing" size={20} label="Swing" />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-krypt-muted">{filter === ALL_GROUPS ? `${allChannels.length} ch` : `${channelOrder.length}/${allChannels.length} ch`}</span>
          <button
            ref={addBtn}
            type="button"
            data-guide="channelRack.add"
            onClick={() => addBtn.current && toggleMenuAt(addBtn.current, () => instrumentPickerItems(), { minWidth: 260, align: 'right' })}
            className="flex h-6 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[11px] font-semibold text-white/90 transition hover:border-krypt-purple/50 hover:bg-krypt-purple/10"
            data-hint="Add a channel (instrument picker). Or drag a sample from the Browser onto the rack."
          >
            <Plus className="h-3.5 w-3.5" /> Channel
          </button>
        </div>
      </div>

      {/* Rows */}
      <div
        ref={bodyRef}
        data-guide="channelRack.steps"
        className="relative min-h-0 flex-1 overflow-auto"
        onDragOver={onBodyDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropEnd(false);
        }}
        onDrop={onBodyDrop}
      >
        <div className="relative py-1" style={{ width: LEFT_W + steps * CELL_W + 24, minWidth: '100%' }}>
          {patternId &&
            channelOrder.map((id) => (
              <div key={id}>
                <ChannelRow
                  channelId={id}
                  index={allChannels.indexOf(id)}
                  patternId={patternId}
                  steps={steps}
                  lengthTicks={lengthTicks}
                  stepsPerBeat={stepsPerBeat}
                  selected={selected === id}
                  leds={leds}
                />
                {selected === id && graphLane !== 'off' && <LaneRow channelId={id} patternId={patternId} lane={graphLane} steps={steps} stepsPerBeat={stepsPerBeat} />}
              </div>
            ))}
          {/* step playhead */}
          <div
            ref={playheadRef}
            className="pointer-events-none absolute top-0 bottom-0 z-[5] hidden bg-white/[0.07] border-x border-white/10"
            style={{ left: LEFT_W + 4, width: CELL_W }}
          />
          {/* add / drop row */}
          <div className="sticky left-0 flex items-center px-2 pt-1.5 pb-2" style={{ width: LEFT_W + 220 }}>
            <button
              type="button"
              onClick={(e) => openMenu(e, instrumentPickerItems(), { minWidth: 260 })}
              className={cls(
                'flex h-7 w-full items-center justify-center gap-2 rounded-lg border border-dashed text-[11px] transition',
                dropEnd ? 'border-krypt-purple/70 bg-krypt-purple/10 text-white' : 'border-white/10 text-krypt-muted hover:border-white/25 hover:text-white',
              )}
              data-hint="Add a channel, or drop a sample here to create a sampler"
            >
              <Plus className="h-3.5 w-3.5" />
              {dropEnd ? 'Drop to add a sampler channel' : 'Add channel · or drop a sample'}
            </button>
          </div>
        </div>
        {!!allChannels.length && !channelOrder.length && (
          <div className="absolute inset-x-0 top-16 text-center text-xs text-krypt-muted">
            No channels in {filter}.{' '}
            <button type="button" onClick={() => setFilter(ALL_GROUPS)} className="text-krypt-purple hover:underline">
              Show all
            </button>
          </div>
        )}
        {!allChannels.length && (
          <div className="pointer-events-none absolute inset-x-0 top-16 text-center text-xs text-krypt-muted">The rack is empty. Add a channel to start.</div>
        )}
      </div>
    </div>
  );
}

function LaneRow({ channelId, patternId, lane, steps, stepsPerBeat }: { channelId: string; patternId: string; lane: Exclude<Lane, 'off'>; steps: number; stepsPerBeat: number }) {
  const notes = useProject((p) => p.patterns[patternId]?.notes[channelId]);
  const color = useProject((p) => p.channels[channelId]?.color ?? '#A855F7');
  const { isSteps } = useMemo(() => analyzeSteps(notes), [notes]);
  return (
    <div className="flex items-center py-0.5">
      <div className="sticky left-0 z-10 flex flex-shrink-0 items-center justify-end bg-[#0c0c12] pr-2 text-[9px] font-semibold uppercase tracking-wider text-krypt-muted" style={{ width: LEFT_W }}>
        {lane === 'vel' ? 'Velocity' : 'Pan'}
      </div>
      <div className="pl-1">
        {isSteps ? (
          <GraphLane lane={lane} channelId={channelId} patternId={patternId} notes={notes} steps={steps} color={color} stepsPerBeat={stepsPerBeat} />
        ) : (
          <div className="flex h-10 items-center px-2 text-[10px] text-krypt-muted" style={{ width: steps * CELL_W }}>
            This channel uses piano-roll notes. Edit velocity and pan in the Piano Roll.
          </div>
        )}
      </div>
    </div>
  );
}
