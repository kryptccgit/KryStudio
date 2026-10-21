import { useRef, useState } from 'react';
import { GripVertical, Layers, Plus, X } from 'lucide-react';
import { EFFECTS, pluginById } from '@shared/plugins/catalog';
import { MAX_FX_SLOTS } from '@shared/schema/project';
import { dispatch, getProject, useProject } from '../../doc/store';
import { ParamKnob } from '../../controls/ParamKnob';
import { Select, Toggle } from '../../controls/Toggle';
import { openMenu, toggleMenuAt } from '../../components/Menu';
import { flashHint } from '../../app/hints';
import { wm } from '../../workspace/WindowManager';
import { cls } from '../../utils/format';
import { effectPickerItems, insertMenuItems, removeEffect, replaceEffect } from './mixerActions';
import { installedPickerItems, nativeEditorItems } from '../pluginManager/pickers';
import { toggleChainPopover } from '../../sounds/pickers';
import { applyChainPreset } from '../../sounds/actions';
import { decodePresetDrag, PRESET_MIME } from '../../sounds/logic';
import { toast } from '../../app/notify';
import { slotRackItems } from '../../racks/actions';
import { hasGrMeter } from '@shared/engine/meters';
import { GrBar } from './GrBar';

const SLOT_MIME = 'application/x-krypt-fxslot';

function SlotRow({ insertId, slotId, index }: { insertId: string; slotId: string; index: number }) {
  const slot = useProject((p) => p.mixer.inserts[insertId]?.slots[slotId]);
  const insertOptions = useProject((p) => p.mixer.insertOrder);
  const [drop, setDrop] = useState<null | 'above' | 'below'>(null);
  if (!slot) return null;
  const desc = pluginById(slot.type);
  const p = getProject();

  return (
    <div
      className={cls('group relative flex flex-col gap-1 rounded-md border px-1.5 py-1 transition', slot.enabled ? 'border-white/10 bg-white/[0.03]' : 'border-white/[0.05] bg-black/30 opacity-70')}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes(SLOT_MIME)) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setDrop(e.clientY < r.top + r.height / 2 ? 'above' : 'below');
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        const where = drop;
        setDrop(null);
        const raw = e.dataTransfer.getData(SLOT_MIME);
        if (!raw) return;
        e.preventDefault();
        const { insertId: from, slotId: moved } = JSON.parse(raw) as { insertId: string; slotId: string };
        if (moved === slotId) return;
        const order = getProject().mixer.inserts[insertId].slotOrder.filter((s) => s !== moved);
        const at = order.indexOf(slotId) + (where === 'below' ? 1 : 0);
        void dispatch('mixer.moveSlot', { insertId: from, slotId: moved, toIndex: at, toInsertId: from !== insertId ? insertId : undefined }).then(
          (r) => r.ok && flashHint('Effect moved', 'ok', 1000),
        );
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, [
          { type: 'header', label: desc?.name ?? slot.type },
          { label: 'Open editor', onSelect: () => wm.openPlugin({ kind: 'slot', insertId, slotId }) },
          ...nativeEditorItems(slot.type, { insertId, slotId }),
          { label: slot.enabled ? 'Bypass' : 'Enable', onSelect: () => void dispatch('mixer.setSlot', { insertId, slotId, enabled: !slot.enabled }) },
          {
            type: 'submenu',
            label: 'Replace with',
            items: [
              ...EFFECTS.filter((d) => d.id !== slot.type).map((d) => ({ label: d.name, detail: d.category, onSelect: () => void replaceEffect(insertId, slotId, d.id) })),
              ...installedPickerItems('effect', (d) => void replaceEffect(insertId, slotId, d.id), { exclude: slot.type }),
            ],
          },
          ...slotRackItems(insertId, slotId),
          { type: 'separator' },
          { label: 'Remove', danger: true, onSelect: () => void removeEffect(insertId, slotId) },
        ]);
      }}
    >
      {drop === 'above' && <div className="pointer-events-none absolute -top-[3px] left-0 right-0 h-[2px] bg-krypt-gradient" />}
      {drop === 'below' && <div className="pointer-events-none absolute -bottom-[3px] left-0 right-0 h-[2px] bg-krypt-gradient" />}
      <div className="flex items-center gap-1">
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(SLOT_MIME, JSON.stringify({ insertId, slotId }));
            e.dataTransfer.effectAllowed = 'move';
          }}
          className="cursor-grab text-white/20 hover:text-white/60"
          data-hint="Drag to reorder (or onto another insert's chain)"
        >
          <GripVertical className="h-3 w-3" />
        </span>
        <span className="w-3 font-mono text-[9px] text-krypt-muted">{index + 1}</span>
        <Toggle
          variant="led"
          tone="green"
          on={slot.enabled}
          onChange={(on) => void dispatch('mixer.setSlot', { insertId, slotId, enabled: on })}
          hint={slot.enabled ? 'Active · click to bypass' : 'Bypassed · click to enable'}
        />
        <button
          type="button"
          onClick={() => wm.openPlugin({ kind: 'slot', insertId, slotId })}
          className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-white/90 hover:text-white"
          data-hint={`${desc?.name ?? slot.type}: ${desc?.description ?? ''} · click to open the editor`}
        >
          {desc?.name ?? slot.type}
        </button>
        {hasGrMeter(slot.type) && slot.enabled && <GrBar insertId={insertId} slotId={slotId} />}
        <ParamKnob paramRef={`insert/${insertId}/slot/${slotId}/mix`} size={18} label={`${desc?.name ?? 'Effect'} mix`} />
        <button
          type="button"
          onClick={() => void removeEffect(insertId, slotId)}
          className="flex h-4 w-4 items-center justify-center rounded text-white/30 opacity-0 transition hover:bg-rose-500/20 hover:text-rose-200 group-hover:opacity-100"
          data-hint="Remove this effect (undoable)"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {desc?.sidechain && (
        <div className="flex items-center gap-1 pl-7">
          <span className="text-[9px] uppercase tracking-wider text-krypt-muted">Sidechain</span>
          <Select<string>
            value={slot.sidechainFrom ?? ''}
            options={[
              { value: '', label: 'None' },
              ...insertOptions
                .filter((id) => id !== insertId && !p.mixer.inserts[id]?.isMaster)
                .map((id) => ({ value: id, label: `${p.mixer.insertOrder.indexOf(id)} · ${p.mixer.inserts[id].name}`, swatch: p.mixer.inserts[id].color })),
            ]}
            onChange={(v) =>
              void dispatch('mixer.setSlot', { insertId, slotId, sidechainFrom: v || null }).then(
                (r) => r.ok && flashHint(v ? `Sidechain from ${p.mixer.inserts[v]?.name}` : 'Sidechain off', 'ok'),
              )
            }
            hint="Sidechain source: the insert whose signal drives this effect"
            width={130}
          />
        </div>
      )}
    </div>
  );
}

export function FxChain({ insertId }: { insertId: string }) {
  const ins = useProject((p) => p.mixer.inserts[insertId]);
  const num = useProject((p) => (p.mixer.inserts[insertId]?.isMaster ? 'Master' : `Insert ${p.mixer.insertOrder.indexOf(insertId)}`));
  const routes = useProject((p) => p.mixer.inserts[insertId]?.routes);
  const inserts = useProject((p) => p.mixer.inserts);
  const order = useProject((p) => p.mixer.insertOrder);
  const feeding = useProject((p) => p.channelOrder.filter((c) => p.channels[c]?.insertId === insertId).map((c) => p.channels[c].name).join(', '));
  const addRef = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLButtonElement>(null);
  const chainRef = useRef<HTMLButtonElement>(null);
  const [chainDrop, setChainDrop] = useState(false);
  if (!ins) return null;
  const empty = Math.max(0, MAX_FX_SLOTS - ins.slotOrder.length);

  return (
    <div className="flex w-[268px] flex-shrink-0 flex-col border-l border-white/[0.07] bg-[#0a0a10]">
      <button
        ref={headRef}
        type="button"
        onClick={() => headRef.current && toggleMenuAt(headRef.current, () => insertMenuItems(insertId, headRef.current?.ownerDocument))}
        className="flex h-8 flex-shrink-0 items-center gap-2 border-b border-white/[0.06] px-2.5 text-left hover:bg-white/[0.03]"
        data-hint="Insert options"
      >
        <span className="h-3 w-3 rounded-sm" style={{ background: ins.color }} />
        <span className="truncate text-[12px] font-semibold text-white">{ins.isMaster ? 'Master' : ins.name}</span>
        <span className="ml-auto font-mono text-[10px] text-krypt-muted">{num}</span>
      </button>

      <div
        data-guide="mixer.fxSlots"
        className={cls('min-h-0 flex-1 space-y-1 overflow-y-auto p-2 transition', chainDrop && 'bg-krypt-purple/[0.06] ring-1 ring-inset ring-krypt-purple/50')}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes(PRESET_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setChainDrop(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setChainDrop(false);
        }}
        onDrop={(e) => {
          setChainDrop(false);
          const d = decodePresetDrag(e.dataTransfer.getData(PRESET_MIME));
          if (!d) return;
          e.preventDefault();
          if (d.kind !== 'chain') toast.warn(`${d.name} is an instrument preset. Drop it on the Channel Rack instead.`);
          else void applyChainPreset(insertId, d.id, 'replace');
        }}
      >
        <div className="flex items-center justify-between gap-1 px-0.5 pb-0.5">
          <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Effects</span>
          <button
            ref={chainRef}
            type="button"
            data-guide="mixer.chainPresets"
            onClick={() => chainRef.current && toggleChainPopover(chainRef.current, insertId)}
            className="ml-auto flex h-5 items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-1.5 text-[10px] font-semibold text-white/75 transition hover:border-krypt-purple/50 hover:text-white"
            data-hint="Effect-chain presets: load a ready-made chain onto this insert (or drop one here from the Browser)"
          >
            <Layers className="h-3 w-3" /> Chains
          </button>
          <span className="font-mono text-[9px] text-krypt-muted">
            {ins.slotOrder.length}/{MAX_FX_SLOTS}
          </span>
        </div>
        {ins.slotOrder.map((sid, i) => (
          <SlotRow key={sid} insertId={insertId} slotId={sid} index={i} />
        ))}
        {empty > 0 && (
          <button
            ref={addRef}
            type="button"
            onClick={() => addRef.current && toggleMenuAt(addRef.current, () => effectPickerItems(insertId), { minWidth: 260 })}
            className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-white/12 text-[11px] text-krypt-muted transition hover:border-krypt-purple/60 hover:bg-krypt-purple/5 hover:text-white"
            data-hint="Add an effect to this insert"
          >
            <Plus className="h-3.5 w-3.5" /> Add effect
          </button>
        )}
        {Array.from({ length: Math.max(0, empty - 1) }).map((_, i) => (
          <div key={i} className="flex h-6 items-center rounded-md border border-white/[0.04] px-2 font-mono text-[9px] text-white/15">
            {ins.slotOrder.length + i + 2}
          </div>
        ))}

        <div className="pt-3">
          <div className="px-0.5 pb-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Routing</div>
          {ins.isMaster ? (
            <div className="px-0.5 text-[11px] text-krypt-muted">The master goes to the audio output.</div>
          ) : (
            <div className="space-y-1">
              {Object.entries(routes ?? {})
                .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
                .map(([to, lvl]) => (
                  <div key={to} className="flex items-center gap-1.5 rounded-md bg-white/[0.03] px-1.5 py-1 text-[11px]">
                    <span className="h-2 w-2 rounded-full" style={{ background: inserts[to]?.color }} />
                    <span className="flex-1 truncate text-white/85">→ {inserts[to]?.isMaster ? 'Master' : inserts[to]?.name}</span>
                    <span className="font-mono text-[9px] text-krypt-muted">{lvl > 0 ? `${(20 * Math.log10(lvl)).toFixed(1)} dB` : '-inf'}</span>
                    <button
                      type="button"
                      onClick={() => void dispatch('mixer.setRoute', { from: insertId, to, level: null })}
                      className="text-white/30 hover:text-rose-200"
                      data-hint="Remove this route"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              {!Object.keys(routes ?? {}).length && <div className="px-0.5 text-[11px] text-amber-300/80">Not routed anywhere: this insert is silent.</div>}
              <div className="px-0.5 pt-1 text-[10px] text-krypt-muted/80">Tip: with this insert selected, click the arrow under any other strip to route into it.</div>
            </div>
          )}
          {feeding && (
            <div className="mt-2 px-0.5 text-[10px] text-krypt-muted">
              <span className="font-semibold text-white/60">Fed by:</span> {feeding}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
