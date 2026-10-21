import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Dices, Headphones, Link2, Plus, Save, Trash2, Unlink, VolumeX, X } from 'lucide-react';
import { EFFECTS, INSTRUMENTS, pluginById } from '@shared/plugins/catalog';
import { formatParam, fromNormalized, toNormalized, type ParamSpec, type PluginDescriptor } from '@shared/plugins/types';
import { BUILTIN_SPECS, RACK_CHAIN_PAN, RACK_CHAIN_VOLUME, rackParamRef } from '@shared/schema/params';
import { DRUM_RACK_BASE_NOTE, DRUM_RACK_PADS, MACRO_COUNT, MACRO_PARAM_IDS, MAX_RACK_CHAINS, isRackPlugin, type MacroTarget, type RackChain, type RackDef } from '@shared/schema/rack';
import { MAX_FX_SLOTS, type FxSlot, type Generator, type Project } from '@shared/schema/project';
import { dispatch, useProject } from '../../doc/store';
import { Knob } from '../../controls/Knob';
import { Select, Toggle } from '../../controls/Toggle';
import { DragNumber } from '../../controls/DragNumber';
import { useGestureValue, useParam, paramMenuItems } from '../../controls/ParamKnob';
import { openMenu, toggleMenuAt, type MenuItem } from '../../components/Menu';
import { flashHint } from '../../app/hints';
import { modal } from '../../app/notify';
import { handleOsDrop } from '../../app/fileDrop';
import { cls } from '../../utils/format';
import { SAMPLE_MIME } from '../channelRack/rackActions';
import { Waveform } from './Waveform';
import { rackArgs, type RackTarget } from '../../racks/actions';
import { useLiveParam } from '../../live/automationFollow';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteLabel = (n: number): string => `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;

function hostOf(p: Project, t: RackTarget): { rack: RackDef | null; params: Record<string, number>; type: string; refPrefix: string; color: string } | null {
  if ('channelId' in t) {
    const ch = p.channels[t.channelId];
    if (!ch) return null;
    return { rack: ch.generator.rack ?? null, params: ch.generator.params, type: ch.generator.type, refPrefix: `channel/${ch.id}/gen/`, color: ch.color };
  }
  const ins = p.mixer.inserts[t.insertId];
  const s = ins?.slots[t.slotId];
  if (!s) return null;
  return { rack: s.rack ?? null, params: s.params, type: s.type, refPrefix: `insert/${t.insertId}/slot/${t.slotId}/`, color: ins.color };
}

const RACK_INSTRUMENTS = INSTRUMENTS.filter((d) => !isRackPlugin(d.id) && d.id !== 'krypt.audioclip' && d.id !== 'krypt.multisampler');
const RACK_EFFECTS = EFFECTS.filter((d) => !isRackPlugin(d.id));

const CHAIN_VOLUME: ParamSpec = { ...RACK_CHAIN_VOLUME, name: 'Volume' };
const CHAIN_PAN: ParamSpec = { ...RACK_CHAIN_PAN, name: 'Pan' };

function innerRef(t: RackTarget, target: MacroTarget): string {
  return rackParamRef('channelId' in t ? { kind: 'channel', channelId: t.channelId } : { kind: 'slot', insertId: t.insertId, slotId: t.slotId }, target);
}

function exec(t: RackTarget, cmd: string, args: Record<string, unknown>, opts?: { coalesceKey?: string; label?: string }) {
  return dispatch(cmd, { ...rackArgs(t), ...args }, opts);
}

function targetLabel(rack: RackDef, t: MacroTarget): string {
  const c = rack.chains[t.chainId];
  if (!c) return 'missing chain';
  if (t.kind === 'chain') return `${c.name} · ${t.param}`;
  if (t.kind === 'instrument') {
    const spec = c.instrument ? pluginById(c.instrument.type)?.params.find((s) => s.id === t.param) : undefined;
    return `${c.name} · ${spec?.name ?? t.param}`;
  }
  const d = c.devices[t.deviceId];
  const desc = d ? pluginById(d.type) : undefined;
  const spec = desc?.params.find((s) => s.id === t.param);
  return `${c.name} · ${desc?.name.replace(/^Krypt /, '') ?? 'device'} ${t.param === 'mix' ? 'mix' : spec?.name ?? t.param}`;
}

const sameTarget = (a: MacroTarget, b: MacroTarget): boolean =>
  a.chainId === b.chainId && a.kind === b.kind && a.param === b.param && (a.kind !== 'device' || (b.kind === 'device' && a.deviceId === b.deviceId));

function macroMenuItems(t: RackTarget, rack: RackDef, target: MacroTarget, norm: number): MenuItem[] {
  const mapped = rack.macros.map((m, i) => ({ i, map: Object.values(m.maps).find((x) => sameTarget(x.target, target)) })).filter((x) => x.map);
  const lo = norm >= 0.99 ? 0 : Math.round(norm * 1000) / 1000;
  const items: MenuItem[] = [
    { type: 'separator' },
    {
      type: 'submenu',
      label: 'Map to macro',
      icon: Link2,
      items: [
        { type: 'header', label: `Sweeps ${Math.round(lo * 100)}% → 100% (edit under Macros)` },
        ...rack.macros.map((m, i) => ({
          label: `Map to Macro ${i + 1}`,
          detail: m.name !== `Macro ${i + 1}` ? m.name : undefined,
          checked: mapped.some((x) => x.i === i),
          onSelect: () =>
            void exec(t, 'rack.mapMacro', { macro: i + 1, target, min: lo, max: 1 }).then((r) => r.ok && flashHint(`Mapped to ${m.name} (${Math.round(lo * 100)}–100%)`, 'ok')),
        })),
      ],
    },
  ];
  for (const x of mapped) {
    items.push({ label: `Unmap from ${rack.macros[x.i].name}`, icon: Unlink, onSelect: () => void exec(t, 'rack.unmapMacro', { macro: x.i + 1, mapId: x.map!.id }) });
  }
  return items;
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/[0.07] bg-krypt-panel/70 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function SmallButton({ onClick, hint, children, danger, disabled }: { onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; hint: string; children: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-hint={hint}
      className={cls(
        'flex h-5 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 text-[10px] font-semibold text-white/80 transition hover:border-white/25 hover:text-white disabled:opacity-40',
        danger && 'hover:border-rose-400/50 hover:text-rose-200',
      )}
    >
      {children}
    </button>
  );
}

function InnerKnob({ spec, value, onCommit, extra, label, size = 34, paramRef }: { spec: ParamSpec; value: number; onCommit: (v: number) => unknown; extra?: (norm: number) => MenuItem[]; label?: string; size?: number; paramRef?: string }) {
  const g = useGestureValue(spec, value, onCommit);
  const live = useLiveParam(paramRef ?? '');
  const following = live.norm !== null && !g.gesturing;
  const norm = following ? live.norm! : g.norm;
  const shown = following ? fromNormalized(spec, live.norm!) : g.value;
  const knob = (
    <Knob
      size={size}
      value={norm}
      defaultValue={toNormalized(spec, spec.default)}
      display={formatParam(spec, shown)}
      label={label ?? spec.name}
      showLabel
      showValue
      steps={spec.options ? spec.options.length : undefined}
      bipolar={spec.min < 0 && spec.max > 0 && spec.scale === 'linear'}
      onChange={g.setNorm}
      onEnd={() => void g.end()}
      onReset={() => void g.commitNow(spec.default)}
      onContextMenu={(e) => openMenu(e, paramMenuItems(paramRef ?? null, spec, g.value, (v) => void g.commitNow(v), extra?.(g.norm) ?? []))}
    />
  );
  if (!live.automated) return knob;
  return (
    <span className="relative inline-flex" data-hint={`${label ?? spec.name} · automated: ${following ? 'following its automation clip' : 'follows its automation clip while the song plays'}`}>
      {knob}
      <span className={cls('pointer-events-none absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-krypt-pink', following ? 'shadow-[0_0_6px_rgba(236,72,153,0.9)]' : 'opacity-70')} />
    </span>
  );
}

function InnerControl({ spec, value, onCommit, extra, paramRef }: { spec: ParamSpec; value: number; onCommit: (v: number) => unknown; extra?: (norm: number) => MenuItem[]; paramRef?: string }) {
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    openMenu(e, paramMenuItems(paramRef ?? null, spec, value, (v) => void onCommit(v), extra?.(toNormalized(spec, value)) ?? []));
  };
  if (spec.options && spec.options.length === 2 && spec.min === 0 && spec.max === 1) {
    return (
      <div className="flex w-[64px] flex-col items-center gap-1" onContextMenu={menu}>
        <div className="max-w-[64px] truncate text-[9px] font-semibold uppercase tracking-wider text-krypt-muted" title={spec.name}>
          {spec.name}
        </div>
        <Toggle variant="button" on={Math.round(value) === 1} onChange={(on) => void onCommit(on ? 1 : 0)} hint={spec.name} className="w-12 justify-center">
          {spec.options[Math.round(value)] ?? (Math.round(value) ? 'On' : 'Off')}
        </Toggle>
      </div>
    );
  }
  if (spec.options) {
    return (
      <div className="flex flex-col items-center gap-1" onContextMenu={menu}>
        <div className="max-w-[96px] truncate text-[9px] font-semibold uppercase tracking-wider text-krypt-muted" title={spec.name}>
          {spec.name}
        </div>
        <Select value={Math.round(value)} options={spec.options.map((o, i) => ({ value: i, label: o }))} onChange={(v) => void onCommit(v)} hint={spec.name} width={92} />
      </div>
    );
  }
  return <InnerKnob spec={spec} value={value} onCommit={onCommit} extra={extra} paramRef={paramRef} />;
}

function groupSpecs(desc: PluginDescriptor): Array<[string, ParamSpec[]]> {
  const groups = new Map<string, ParamSpec[]>();
  for (const p of desc.params) {
    const g = p.group ?? 'Parameters';
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  return [...groups.entries()];
}

function InnerParams({ desc, params, commit, extraFor, refFor }: { desc: PluginDescriptor; params: Record<string, number>; commit: (id: string, v: number) => unknown; extraFor: (id: string) => (norm: number) => MenuItem[]; refFor: (id: string) => string }) {
  const groups = useMemo(() => groupSpecs(desc), [desc]);
  return (
    <div className="space-y-1.5">
      {groups.map(([g, specs]) => (
        <div key={g}>
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-krypt-muted/80">{g}</div>
          <div className="flex flex-wrap items-start gap-x-2 gap-y-2">
            {specs.map((s) => (
              <InnerControl key={s.id} spec={s} value={params[s.id] ?? s.default} onCommit={(v) => commit(s.id, v)} extra={extraFor(s.id)} paramRef={refFor(s.id)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MacroKnob({ t, rack, index, refPrefix }: { t: RackTarget; rack: RackDef; index: number; refPrefix: string }) {
  const ref = `${refPrefix}${MACRO_PARAM_IDS[index]}`;
  const p = useParam(ref);
  const m = rack.macros[index];
  const n = Object.keys(m.maps).length;
  const rename = async () => {
    const name = await modal.prompt({ title: `Rename macro ${index + 1}`, initialValue: m.name, confirmLabel: 'Rename', validate: (v) => (v.length > 32 ? 'At most 32 characters' : null) });
    if (name !== null) void exec(t, 'rack.renameMacro', { macro: index + 1, name });
  };
  if (!p.spec) {
    return (
      <div className="flex w-[66px] flex-col items-center gap-1 text-center" data-hint="This build's plugin catalog has no macro params yet (it's regenerated with the engine)">
        <div className="h-[38px] w-[38px] rounded-full border border-dashed border-white/15" />
        <div className="w-full truncate text-[9px] text-krypt-muted">{m.name}</div>
      </div>
    );
  }
  const spec = p.spec;
  return (
    <div className="flex w-[66px] flex-col items-center gap-0.5" onDoubleClick={(e) => (e.target as HTMLElement).closest('[data-macro-name]') && void rename()}>
      <Knob
        size={38}
        value={p.norm}
        defaultValue={0}
        display={`${Math.round(p.norm * 100)}%`}
        label={m.name}
        showValue
        color={n ? undefined : '#52525b'}
        hint={`${m.name}: ${n ? `moves ${n} mapped knob${n === 1 ? '' : 's'}` : 'nothing mapped yet: right-click a knob in a chain ▸ Map to macro'} · double-click the name to rename`}
        onChange={p.setNorm}
        onEnd={() => void p.end()}
        onReset={() => void p.commitNow(spec.default)}
        onContextMenu={(e) =>
          openMenu(
            e,
            paramMenuItems(ref, spec, p.value, (v) => void p.commitNow(v), [
              { type: 'separator' },
              { label: 'Rename…', onSelect: () => void rename() },
              { label: 'Remove all mappings', icon: Unlink, disabled: !n, onSelect: () => void exec(t, 'rack.unmapMacro', { macro: index + 1, all: true }) },
            ]),
          )
        }
      />
      <div data-macro-name className="w-full cursor-text truncate text-center text-[9px] font-semibold text-white/80" title={`${m.name} (double-click to rename)`}>
        {m.name}
      </div>
      <div className="text-[8px] text-krypt-muted/70">{n ? `${n} target${n === 1 ? '' : 's'}` : '—'}</div>
    </div>
  );
}

function MacroMaps({ t, rack }: { t: RackTarget; rack: RackDef }) {
  const rows = rack.macros.flatMap((m, i) => Object.values(m.maps).map((map) => ({ i, m, map })));
  if (!rows.length) return <div className="mt-1.5 text-[10px] text-krypt-muted/80">Right-click any knob in a chain below and choose Map to macro.</div>;
  const set = (macro: number, target: MacroTarget, min: number, max: number) =>
    void exec(t, 'rack.mapMacro', { macro, target, min, max }, { coalesceKey: `rack/map/${macro}/${JSON.stringify(target)}` });
  return (
    <div className="mt-2 space-y-0.5">
      {rows.map(({ i, m, map }) => (
        <div key={map.id} className="flex items-center gap-1.5 rounded-md bg-white/[0.03] px-1.5 py-0.5 text-[10px]">
          <span className="w-16 truncate font-semibold text-white/80" title={m.name}>
            {i + 1} · {m.name}
          </span>
          <span className="min-w-0 flex-1 truncate text-krypt-muted">→ {targetLabel(rack, map.target)}</span>
          <DragNumber value={Math.round(map.min * 100)} min={0} max={100} step={1} format={(v) => `${v}%`} label="Min" hint="Where the macro starts this knob (0% = its minimum); drag or double-click to type" onChange={(v) => set(i + 1, map.target, v / 100, map.max)} className="w-10" />
          <span className="text-white/30">→</span>
          <DragNumber value={Math.round(map.max * 100)} min={0} max={100} step={1} format={(v) => `${v}%`} label="Max" hint="Where the macro ends at 100%; set it below Min to invert" onChange={(v) => set(i + 1, map.target, map.min, v / 100)} className="w-10" />
          <button type="button" onClick={() => void exec(t, 'rack.unmapMacro', { macro: i + 1, mapId: map.id })} className="text-white/30 hover:text-rose-200" data-hint="Remove this mapping">
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function Variations({ t, rack }: { t: RackTarget; rack: RackDef }) {
  const store = async () => {
    const name = await modal.prompt({ title: 'Store variation', message: 'Saves the 8 macro positions under a name.', initialValue: `Variation ${rack.variationOrder.length + 1}`, confirmLabel: 'Store' });
    if (name === null) return;
    const r = await exec(t, 'rack.storeVariation', { name });
    if (r.ok) flashHint(`Stored "${name || 'Variation'}"`, 'ok');
  };
  return (
    <div data-guide="rack.variations" className="mt-2 flex flex-wrap items-center gap-1">
      <span className="mr-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">Variations</span>
      {rack.variationOrder.map((id) => {
        const v = rack.variations[id];
        if (!v) return null;
        return (
          <button
            key={id}
            type="button"
            onClick={() => void exec(t, 'rack.recallVariation', { variationId: id }).then((r) => r.ok && flashHint(`Recalled "${v.name}"`, 'ok'))}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e, [
                { type: 'header', label: v.name },
                { label: 'Recall', onSelect: () => void exec(t, 'rack.recallVariation', { variationId: id }) },
                { label: 'Delete', icon: Trash2, danger: true, onSelect: () => void exec(t, 'rack.removeVariation', { variationId: id }).then((r) => r.ok && flashHint(`Deleted "${v.name}"`, 'ok')) },
              ]);
            }}
            className="h-5 max-w-[120px] truncate rounded-md border border-white/10 bg-white/[0.04] px-1.5 text-[10px] text-white/85 hover:border-krypt-purple/50"
            data-hint={`Recall "${v.name}" (${v.values.map((x) => Math.round(x * 100)).join(' / ')}%) · right-click to delete`}
          >
            {v.name}
          </button>
        );
      })}
      <SmallButton onClick={() => void store()} hint="Store the current macro positions as a variation">
        <Save className="h-3 w-3" /> Store
      </SmallButton>
      <SmallButton
        onClick={() => void exec(t, 'rack.randomizeMacros', { seed: Math.floor(Math.random() * 2 ** 31) }).then((r) => r.ok && flashHint('Macros randomized (undo to go back)', 'ok'))}
        hint="Randomize the mapped macros (all 8 when none is mapped); undoable"
      >
        <Dices className="h-3 w-3" /> Randomize
      </SmallButton>
    </div>
  );
}

function DrumPads({ t, rack, selected, onSelect }: { t: RackTarget; rack: RackDef; selected: string | null; onSelect: (id: string) => void }) {
  const [page, setPage] = useState(() => {
    const notes = Object.values(rack.chains).map((c) => c.zone?.keyLo ?? DRUM_RACK_BASE_NOTE);
    return notes.length ? Math.max(0, Math.floor((Math.min(...notes) - DRUM_RACK_BASE_NOTE) / DRUM_RACK_PADS)) : 0;
  });
  const [over, setOver] = useState<number | null>(null);
  const base = DRUM_RACK_BASE_NOTE + page * DRUM_RACK_PADS;
  const byNote = new Map<number, RackChain>();
  for (const id of rack.chainOrder) {
    const c = rack.chains[id];
    if (c?.zone && c.zone.keyLo === c.zone.keyHi) byNote.set(c.zone.keyLo, c);
  }
  const loadPad = async (note: number, path: string) => {
    const r = await exec(t, 'rack.drumPad', { note, samplePath: path });
    if (r.ok) flashHint(`Loaded ${path.split(/[\\/:]/).pop()} on pad ${noteLabel(note)}`, 'ok');
  };
  const audition = (note: number) => {
    if (!('channelId' in t)) return;
    window.krypt.engine.audition(t.channelId, note, 0.85, true);
    setTimeout(() => window.krypt.engine.audition(t.channelId, note, 0, false), 300);
  };
  const padMenu = (e: React.MouseEvent, note: number, c: RackChain | undefined) => {
    e.preventDefault();
    const items: MenuItem[] = [{ type: 'header', label: `Pad ${noteLabel(note)}${c ? ` · ${c.name}` : ''}` }];
    if (!c) items.push({ label: 'New pad (empty sampler)', icon: Plus, onSelect: () => void exec(t, 'rack.drumPad', { note }) });
    else {
      items.push(
        {
          type: 'submenu',
          label: 'Choke group',
          items: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((g) => ({ label: g ? `Group ${g}` : 'None', checked: (c.choke ?? 0) === g, onSelect: () => void exec(t, 'rack.setChain', { chainId: c.id, choke: g }) })),
        },
        { label: 'Clear sample', disabled: !c.instrument?.sampleId, onSelect: () => void exec(t, 'rack.drumPad', { note, sampleId: null }) },
        { label: c.mute ? 'Unmute' : 'Mute', icon: VolumeX, onSelect: () => void exec(t, 'rack.setChain', { chainId: c.id, mute: !c.mute }) },
        { type: 'separator' },
        { label: 'Remove pad', icon: Trash2, danger: true, onSelect: () => void exec(t, 'rack.removeChain', { chainId: c.id }) },
      );
    }
    openMenu(e, items);
  };
  const pages = Math.ceil((128 - DRUM_RACK_BASE_NOTE) / DRUM_RACK_PADS);
  return (
    <div data-guide="rack.pads">
      <Section
        title="Pads"
        right={
          <div className="flex items-center gap-1 text-[10px] text-krypt-muted">
            <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="disabled:opacity-30" data-hint="Lower 16 pads">
              <ChevronLeft className="h-3 w-3" />
            </button>
            <span className="font-mono">
              {noteLabel(base)}–{noteLabel(Math.min(127, base + DRUM_RACK_PADS - 1))}
            </span>
            <button type="button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} className="disabled:opacity-30" data-hint="Higher 16 pads">
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-4 gap-1.5">
          {Array.from({ length: DRUM_RACK_PADS }, (_, i) => {
            const row = 3 - Math.floor(i / 4);
            const note = base + row * 4 + (i % 4);
            if (note > 127) return <div key={i} />;
            const c = byNote.get(note);
            const choke = c?.choke ?? 0;
            return (
              <button
                key={note}
                type="button"
                onClick={() => {
                  if (c) onSelect(c.id);
                  audition(note);
                }}
                onContextMenu={(e) => padMenu(e, note, c)}
                onDragOver={(e) => {
                  const types = Array.from(e.dataTransfer.types);
                  if (types.includes(SAMPLE_MIME) || types.includes('Files')) {
                    e.preventDefault();
                    setOver(note);
                  }
                }}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => {
                  setOver(null);
                  e.preventDefault();
                  const path = e.dataTransfer.getData(SAMPLE_MIME);
                  if (path) void loadPad(note, path);
                  else if (Array.from(e.dataTransfer.types).includes('Files')) void handleOsDrop(e.dataTransfer, (paths) => loadPad(note, paths[0]));
                }}
                className={cls(
                  'relative flex h-12 flex-col items-start justify-between rounded-lg border p-1 text-left transition',
                  c ? 'border-white/12 bg-white/[0.05] hover:border-white/25' : 'border-dashed border-white/[0.08] bg-black/20 hover:border-white/20',
                  c && selected === c.id && 'border-krypt-purple/70 bg-krypt-purple/10',
                  c?.mute && 'opacity-50',
                  over === note && 'ring-1 ring-krypt-pink/70',
                )}
                data-hint={c ? `${c.name} on ${noteLabel(note)} · click to play and edit · drop a sample to replace · right-click for choke` : `Empty pad ${noteLabel(note)} · drop a sample from the Browser here`}
              >
                <span className="w-full truncate text-[10px] font-semibold text-white/85">{c?.name ?? ''}</span>
                <span className="flex w-full items-center justify-between font-mono text-[8px] text-krypt-muted">
                  {noteLabel(note)}
                  {choke > 0 && <span className="rounded bg-amber-500/20 px-1 text-amber-200">C{choke}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

function ZoneEditor({ t, chainId }: { t: RackTarget; chainId: string }) {
  const chain = useProject((p) => hostOf(p, t)?.rack?.chains[chainId]);
  if (!chain) return <div className="px-2 py-1.5 text-[10px] text-krypt-muted">This chain no longer exists.</div>;
  const z0 = chain.zone ?? { keyLo: 0, keyHi: 127, velLo: 0, velHi: 1 };
  const set = (patch: Partial<typeof z0>) => {
    const z = { ...z0, ...patch };
    if (z.keyLo > z.keyHi || z.velLo > z.velHi) return;
    void exec(t, 'rack.setChain', { chainId: chain.id, zone: z }, { coalesceKey: `rack/zone/${chain.id}`, label: 'Set chain zone' });
  };
  return (
    <div className="w-[230px] space-y-1.5 px-2 py-1.5 text-[10px]">
      <div className="text-[9px] uppercase tracking-[0.16em] text-krypt-muted">Plays these notes</div>
      <div className="flex items-center gap-1.5">
        <span className="w-14 text-krypt-muted">Keys</span>
        <DragNumber value={z0.keyLo} min={0} max={127} format={noteLabel} label="Lowest key" onChange={(v) => set({ keyLo: Math.round(v) })} className="w-12" />
        <span className="text-white/30">to</span>
        <DragNumber value={z0.keyHi} min={0} max={127} format={noteLabel} label="Highest key" onChange={(v) => set({ keyHi: Math.round(v) })} className="w-12" />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-14 text-krypt-muted">Velocity</span>
        <DragNumber value={Math.round(z0.velLo * 127)} min={0} max={127} label="Softest velocity" onChange={(v) => set({ velLo: Math.round(v) / 127 })} className="w-12" />
        <span className="text-white/30">to</span>
        <DragNumber value={Math.round(z0.velHi * 127)} min={0} max={127} label="Hardest velocity" onChange={(v) => set({ velHi: Math.round(v) / 127 })} className="w-12" />
      </div>
      <div className="text-[9px] text-krypt-muted/70">Layer chains on the same keys; split them by key or velocity.</div>
    </div>
  );
}

function zoneText(c: RackChain, drum: boolean): string {
  if (!c.zone) return 'All notes';
  if (drum && c.zone.keyLo === c.zone.keyHi) return noteLabel(c.zone.keyLo);
  const keys = c.zone.keyLo === 0 && c.zone.keyHi === 127 ? 'All keys' : `${noteLabel(c.zone.keyLo)}–${noteLabel(c.zone.keyHi)}`;
  const vel = c.zone.velLo > 0 || c.zone.velHi < 1 ? ` · vel ${Math.round(c.zone.velLo * 127)}–${Math.round(c.zone.velHi * 127)}` : '';
  return keys + vel;
}

function ChainRow({ t, rack, chain, index, selected, onSelect }: { t: RackTarget; rack: RackDef; chain: RackChain; index: number; selected: boolean; onSelect: () => void }) {
  const drum = rack.kind === 'drum';
  const rename = async () => {
    const name = await modal.prompt({ title: 'Rename chain', initialValue: chain.name, confirmLabel: 'Rename' });
    if (name?.trim()) void exec(t, 'rack.setChain', { chainId: chain.id, name: name.trim() });
  };
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    openMenu(e, [
      { type: 'header', label: chain.name },
      { label: 'Rename…', onSelect: () => void rename() },
      { label: 'Move up', icon: ArrowUp, disabled: index === 0, onSelect: () => void exec(t, 'rack.moveChain', { chainId: chain.id, toIndex: index - 1 }) },
      { label: 'Move down', icon: ArrowDown, disabled: index === rack.chainOrder.length - 1, onSelect: () => void exec(t, 'rack.moveChain', { chainId: chain.id, toIndex: index + 1 }) },
      ...(drum
        ? ([{ type: 'submenu', label: 'Choke group', items: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((g) => ({ label: g ? `Group ${g}` : 'None', checked: (chain.choke ?? 0) === g, onSelect: () => void exec(t, 'rack.setChain', { chainId: chain.id, choke: g }) })) }] as MenuItem[])
        : []),
      ...(rack.kind === 'instrument' ? ([{ label: 'Play every note', disabled: !chain.zone, onSelect: () => void exec(t, 'rack.setChain', { chainId: chain.id, zone: null }) }] as MenuItem[]) : []),
      { type: 'separator' },
      { label: 'Remove chain', icon: Trash2, danger: true, onSelect: () => void exec(t, 'rack.removeChain', { chainId: chain.id }) },
    ]);
  };
  return (
    <div
      onClick={onSelect}
      onContextMenu={menu}
      className={cls('flex items-center gap-1.5 rounded-md border px-1.5 py-1 transition', selected ? 'border-krypt-purple/60 bg-krypt-purple/10' : 'border-white/[0.07] bg-white/[0.02] hover:border-white/15', chain.mute && 'opacity-60')}
    >
      <span className="h-6 w-1 flex-shrink-0 rounded-full" style={{ background: chain.color ?? '#6366F1' }} />
      <button type="button" onDoubleClick={() => void rename()} className="w-24 truncate text-left text-[11px] font-semibold text-white/90" data-hint={`${chain.name} · double-click to rename, right-click for more`}>
        {chain.name}
      </button>
      <Toggle variant="button" tone="amber" on={chain.mute} onChange={(mute) => void exec(t, 'rack.setChain', { chainId: chain.id, mute })} hint={chain.mute ? 'Muted · click to unmute' : 'Mute this chain'} className="h-5 w-5 justify-center px-0">
        <VolumeX className="h-3 w-3" />
      </Toggle>
      <Toggle variant="button" tone="green" on={chain.solo} onChange={(solo) => void exec(t, 'rack.setChain', { chainId: chain.id, solo })} hint={chain.solo ? 'Soloed · click to unsolo' : 'Solo: only soloed chains play in this rack'} className="h-5 w-5 justify-center px-0">
        <Headphones className="h-3 w-3" />
      </Toggle>
      <InnerKnob
        size={20}
        spec={CHAIN_VOLUME}
        value={chain.volume}
        label={`${chain.name} volume`}
        paramRef={innerRef(t, { chainId: chain.id, kind: 'chain', param: 'volume' })}
        onCommit={(v) => exec(t, 'rack.setChain', { chainId: chain.id, volume: v }, { coalesceKey: `rack/vol/${chain.id}`, label: 'Set chain volume' })}
        extra={() => macroMenuItems(t, rack, { chainId: chain.id, kind: 'chain', param: 'volume' }, toNormalized(CHAIN_VOLUME, chain.volume))}
      />
      <InnerKnob
        size={20}
        spec={CHAIN_PAN}
        value={chain.pan}
        label={`${chain.name} pan`}
        paramRef={innerRef(t, { chainId: chain.id, kind: 'chain', param: 'pan' })}
        onCommit={(v) => exec(t, 'rack.setChain', { chainId: chain.id, pan: v }, { coalesceKey: `rack/pan/${chain.id}`, label: 'Set chain pan' })}
        extra={() => macroMenuItems(t, rack, { chainId: chain.id, kind: 'chain', param: 'pan' }, toNormalized(CHAIN_PAN, chain.pan))}
      />
      {rack.kind !== 'effect' && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openMenu(e, [{ type: 'custom', render: () => <ZoneEditor t={t} chainId={chain.id} /> }]);
          }}
          className="min-w-0 flex-1 truncate rounded border border-white/[0.07] px-1 text-left font-mono text-[9px] text-krypt-muted hover:border-white/20 hover:text-white"
          data-hint="Key and velocity zone: which notes play this chain (click to edit)"
        >
          {zoneText(chain, drum)}
        </button>
      )}
      {rack.kind === 'effect' && <span className="flex-1" />}
      {drum && (chain.choke ?? 0) > 0 && <span className="rounded bg-amber-500/20 px-1 font-mono text-[9px] text-amber-200" data-hint={`Choke group ${chain.choke}: pads in this group cut each other`}>C{chain.choke}</span>}
      <button type="button" onClick={(e) => (e.stopPropagation(), void exec(t, 'rack.removeChain', { chainId: chain.id }))} className="text-white/25 hover:text-rose-200" data-hint="Remove this chain (undoable)">
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function DeviceBlock({ t, rack, chain, dev, index }: { t: RackTarget; rack: RackDef; chain: RackChain; dev: FxSlot; index: number }) {
  const desc = pluginById(dev.type);
  const [open, setOpen] = useState(true);
  const mixSpec: ParamSpec = { ...BUILTIN_SPECS.mix };
  return (
    <div className={cls('rounded-lg border px-2 py-1.5', dev.enabled ? 'border-white/[0.08] bg-white/[0.02]' : 'border-white/[0.05] bg-black/30 opacity-70')}>
      <div className="flex items-center gap-1.5">
        <Toggle variant="led" tone="green" on={dev.enabled} onChange={(enabled) => void exec(t, 'rack.setDeviceParams', { chainId: chain.id, deviceId: dev.id, enabled })} hint={dev.enabled ? 'Active · click to bypass' : 'Bypassed · click to enable'} />
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-white/90" data-hint="Show / hide its knobs">
          {desc?.name ?? dev.type}
        </button>
        <InnerKnob
          size={20}
          spec={mixSpec}
          value={dev.mix}
          label={`${desc?.name ?? 'Device'} mix`}
          paramRef={innerRef(t, { chainId: chain.id, kind: 'device', deviceId: dev.id, param: 'mix' })}
          onCommit={(v) => exec(t, 'rack.setDeviceParams', { chainId: chain.id, deviceId: dev.id, mix: v }, { coalesceKey: `rack/mix/${dev.id}`, label: 'Set device mix' })}
          extra={() => macroMenuItems(t, rack, { chainId: chain.id, kind: 'device', deviceId: dev.id, param: 'mix' }, dev.mix)}
        />
        <button type="button" disabled={index === 0} onClick={() => void exec(t, 'rack.moveDevice', { chainId: chain.id, deviceId: dev.id, toIndex: index - 1 })} className="text-white/30 hover:text-white disabled:opacity-20" data-hint="Move up">
          <ArrowUp className="h-3 w-3" />
        </button>
        <button type="button" disabled={index === chain.deviceOrder.length - 1} onClick={() => void exec(t, 'rack.moveDevice', { chainId: chain.id, deviceId: dev.id, toIndex: index + 1 })} className="text-white/30 hover:text-white disabled:opacity-20" data-hint="Move down">
          <ArrowDown className="h-3 w-3" />
        </button>
        <button type="button" onClick={() => void exec(t, 'rack.removeDevice', { chainId: chain.id, deviceId: dev.id })} className="text-white/30 hover:text-rose-200" data-hint="Remove this device (undoable)">
          <X className="h-3 w-3" />
        </button>
      </div>
      {open && desc && (
        <div className="mt-1.5">
          <InnerParams
            desc={desc}
            params={dev.params}
            commit={(id, v) => exec(t, 'rack.setDeviceParams', { chainId: chain.id, deviceId: dev.id, params: { [id]: v } }, { coalesceKey: `rack/dev/${dev.id}/${id}`, label: `Set ${desc.params.find((s) => s.id === id)?.name ?? id}` })}
            extraFor={(id) => (norm) => macroMenuItems(t, rack, { chainId: chain.id, kind: 'device', deviceId: dev.id, param: id }, norm)}
            refFor={(id) => innerRef(t, { chainId: chain.id, kind: 'device', deviceId: dev.id, param: id })}
          />
        </div>
      )}
    </div>
  );
}

function InstrumentBlock({ t, rack, chain, color }: { t: RackTarget; rack: RackDef; chain: RackChain; color: string }) {
  const inst = chain.instrument as Generator | undefined;
  const desc = inst ? pluginById(inst.type) : undefined;
  const sample = useProject((p) => (inst?.sampleId ? p.samples[inst.sampleId] : null));
  const [drop, setDrop] = useState(false);
  const setType = (type: string) => void exec(t, 'rack.setInstrument', { chainId: chain.id, type }).then((r) => r.ok && flashHint(`${chain.name} now plays ${pluginById(type)?.name}`, 'ok'));
  const loadSample = async (path: string) => {
    const r = await exec(t, 'rack.setChainSample', { chainId: chain.id, samplePath: path });
    if (r.ok) flashHint(`Loaded ${path.split(/[\\/:]/).pop()} into ${chain.name}`, 'ok');
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">Instrument</span>
        <Select<string>
          value={inst?.type ?? ''}
          options={[...(inst ? [] : [{ value: '', label: 'None' }]), ...RACK_INSTRUMENTS.map((d) => ({ value: d.id, label: d.name, detail: d.category }))]}
          onChange={(type) => type && setType(type)}
          hint="The chain's sound source (stock instruments)"
          width={140}
        />
      </div>
      {desc?.usesSample && (
        <div
          onDragOver={(e) => {
            const types = Array.from(e.dataTransfer.types);
            if (types.includes(SAMPLE_MIME) || types.includes('Files')) {
              e.preventDefault();
              setDrop(true);
            }
          }}
          onDragLeave={() => setDrop(false)}
          onDrop={(e) => {
            setDrop(false);
            e.preventDefault();
            const path = e.dataTransfer.getData(SAMPLE_MIME);
            if (path) void loadSample(path);
            else if (Array.from(e.dataTransfer.types).includes('Files')) void handleOsDrop(e.dataTransfer, (paths) => loadSample(paths[0]));
          }}
          className={cls('rounded-lg', drop && 'ring-1 ring-krypt-purple/70')}
          data-hint="Drop a sample from the Browser here"
        >
          <div className="mb-1 text-[10px] font-semibold text-white/85">{sample?.name ?? 'No sample: drop one here'}</div>
          <Waveform path={sample?.path ?? null} color={color} height={48} />
        </div>
      )}
      {inst && desc && (
        <InnerParams
          desc={desc}
          params={inst.params}
          commit={(id, v) => exec(t, 'rack.setInstrumentParams', { chainId: chain.id, params: { [id]: v } }, { coalesceKey: `rack/inst/${chain.id}/${id}`, label: `Set ${desc.params.find((s) => s.id === id)?.name ?? id}` })}
          extraFor={(id) => (norm) => macroMenuItems(t, rack, { chainId: chain.id, kind: 'instrument', param: id }, norm)}
          refFor={(id) => innerRef(t, { chainId: chain.id, kind: 'instrument', param: id })}
        />
      )}
    </div>
  );
}

function ChainDetail({ t, rack, chain, color }: { t: RackTarget; rack: RackDef; chain: RackChain; color: string }) {
  const addDevice = (type: string) => void exec(t, 'rack.addDevice', { chainId: chain.id, type }).then((r) => r.ok && flashHint(`Added ${pluginById(type)?.name} to ${chain.name}`, 'ok'));
  return (
    <Section title={`Chain · ${chain.name}`}>
      <div className="space-y-2">
        {rack.kind !== 'effect' && <InstrumentBlock t={t} rack={rack} chain={chain} color={color} />}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">
              Devices {chain.deviceOrder.length}/{MAX_FX_SLOTS}
            </span>
            <SmallButton
              disabled={chain.deviceOrder.length >= MAX_FX_SLOTS}
              onClick={(e) => toggleMenuAt(e.currentTarget, () => RACK_EFFECTS.map((d) => ({ label: d.name, detail: d.category, onSelect: () => addDevice(d.id) })), { minWidth: 220 })}
              hint="Add a stock effect to this chain"
            >
              <Plus className="h-3 w-3" /> Add device
            </SmallButton>
          </div>
          {chain.deviceOrder.map((id, i) => {
            const dev = chain.devices[id];
            return dev ? <DeviceBlock key={id} t={t} rack={rack} chain={chain} dev={dev} index={i} /> : null;
          })}
          {!chain.deviceOrder.length && <div className="text-[10px] text-krypt-muted/70">{rack.kind === 'effect' ? 'An empty chain passes the audio through dry.' : 'No effects on this chain.'}</div>}
        </div>
      </div>
    </Section>
  );
}

export function RackEditor({ target }: { target: RackTarget }) {
  const stored = useProject((p) => hostOf(p, target)?.rack ?? null);
  const type = useProject((p) => hostOf(p, target)?.type ?? null);
  const color = useProject((p) => hostOf(p, target)?.color ?? '#A855F7');
  const [sel, setSel] = useState<string | null>(null);
  if (!type) return null;
  const host = { type, color, refPrefix: 'channelId' in target ? `channel/${target.channelId}/gen/` : `insert/${target.insertId}/slot/${target.slotId}/` };
  const rack = stored ?? { kind: type === 'krypt.drumrack' ? 'drum' : type === 'krypt.fxrack' ? 'effect' : 'instrument', chains: {}, chainOrder: [], macros: Array.from({ length: MACRO_COUNT }, (_, i) => ({ name: `Macro ${i + 1}`, maps: {} })), variations: {}, variationOrder: [] } as RackDef;
  const selected = sel && rack.chains[sel] ? sel : (rack.chainOrder[0] ?? null);
  const chain = selected ? rack.chains[selected] : undefined;
  const full = rack.chainOrder.length >= MAX_RACK_CHAINS;
  const addChain = (instrument?: string) =>
    void exec(target, 'rack.addChain', instrument ? { instrument: { type: instrument } } : {}).then((r) => {
      const id = (r.data as { chainId?: string } | undefined)?.chainId;
      if (r.ok && id) {
        setSel(id);
        flashHint('Chain added', 'ok');
      }
    });
  const addItems = (): MenuItem[] =>
    rack.kind === 'effect'
      ? [{ label: 'Empty chain', detail: 'Then add devices', onSelect: () => addChain() }, { type: 'separator' }, ...RACK_EFFECTS.map((d) => ({ label: `${d.name} chain`, detail: d.category, onSelect: () => void exec(target, 'rack.addChain', { name: d.name.replace(/^Krypt /, ''), devices: [{ type: d.id }] }).then((r) => r.ok && setSel((r.data as { chainId: string }).chainId)) }))]
      : [{ type: 'header', label: 'Chain with' }, ...RACK_INSTRUMENTS.map((d) => ({ label: d.name, detail: d.category, onSelect: () => addChain(d.id) })), { type: 'separator' }, { label: 'Empty chain', onSelect: () => addChain() }];
  const kindText = rack.kind === 'drum' ? 'Drum rack: one chain per pad note; choke groups cut pads (open / closed hats).' : rack.kind === 'effect' ? 'Effect rack: the input is split into every chain and the chains are summed. The slot Mix is the wet / dry.' : 'Instrument rack: each note plays every chain whose key and velocity zone contains it.';
  return (
    <div className="space-y-2">
      <div data-guide="rack.macros">
        <Section title="Macros">
          <div className="grid grid-cols-4 justify-items-center gap-y-2">
            {Array.from({ length: MACRO_COUNT }, (_, i) => (
              <MacroKnob key={i} t={target} rack={rack} index={i} refPrefix={host.refPrefix} />
            ))}
          </div>
          <MacroMaps t={target} rack={rack} />
          <Variations t={target} rack={rack} />
        </Section>
      </div>

      {rack.kind === 'drum' && <DrumPads t={target} rack={rack} selected={selected} onSelect={setSel} />}

      <div data-guide="rack.chains">
        <Section
          title={`Chains ${rack.chainOrder.length}`}
          right={
            <SmallButton disabled={full} onClick={(e) => toggleMenuAt(e.currentTarget, addItems, { minWidth: 220 })} hint={full ? `A rack holds at most ${MAX_RACK_CHAINS} chains` : 'Add a parallel chain'}>
              <Plus className="h-3 w-3" /> Add chain
            </SmallButton>
          }
        >
          <div className="mb-1.5 text-[10px] text-krypt-muted/80">{kindText}</div>
          <div className="space-y-1">
            {rack.chainOrder.map((id, i) => {
              const c = rack.chains[id];
              return c ? <ChainRow key={id} t={target} rack={rack} chain={c} index={i} selected={id === selected} onSelect={() => setSel(id)} /> : null;
            })}
            {!rack.chainOrder.length && (
              <div className="rounded-md border border-dashed border-white/10 p-3 text-center text-[11px] text-krypt-muted">
                {rack.kind === 'drum' ? 'No pads yet: drop samples on the pads above, or add a chain.' : 'No chains yet: add one.'}
              </div>
            )}
          </div>
        </Section>
      </div>

      {chain && <ChainDetail t={target} rack={rack} chain={chain} color={host.color} />}
      {!isRackPlugin(host.type) && (
        <div className="text-[10px] text-amber-300">This plugin isn't a rack.</div>
      )}
      <div className="px-0.5 text-[10px] text-krypt-muted/70">Macros automate like any knob: right-click one ▸ Create automation clip, or link it to a controller.</div>
    </div>
  );
}
