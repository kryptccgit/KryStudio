// ──────────────────────────────────────────────────────────────────────
// Plugin editor (one floating window per open instrument / effect). The UI
// is generated from the catalog ParamSpecs grouped by `group`: knobs, 0/1
// toggles and option selects. Channels also get their channel settings and
// (for samplers) the sample with its waveform; FX slots get mix, bypass and
// sidechain.
// ──────────────────────────────────────────────────────────────────────

import { useMemo, useState, type ReactNode } from 'react';
import { FolderInput, Layers, Piano, RotateCcw } from 'lucide-react';
import { isRackPlugin } from '@shared/schema/rack';
import { pluginById } from '@shared/plugins/catalog';
import { GATE_STEP_PARAM_IDS } from '@shared/plugins/gateSteps';
import type { ParamSpec, PluginDescriptor } from '@shared/plugins/types';
import { dispatch, getProject, useProject } from '../../doc/store';
import { ParamControl, ParamKnob, SpecKnob } from '../../controls/ParamKnob';
import { Select, Toggle } from '../../controls/Toggle';
import { flashHint } from '../../app/hints';
import { handleOsDrop } from '../../app/fileDrop';
import type { PluginTarget } from '../../workspace/panels';
import { noteName } from '../../input/typingPiano';
import { cls } from '../../utils/format';
import { Waveform } from './Waveform';
import { WarpOverlay, WarpSection } from './WarpOverlay';
import { SlicerOverlay, SlicerSection } from './SlicerEditor';
import { SLICER_PLUGIN } from '@shared/schema/slicer';
import { PICKABLE_INSTRUMENTS, SAMPLE_MIME, loadSampleDialog, openInPianoRoll, replaceChannelSample } from '../channelRack/rackActions';
import { ExternalParams, ExternalPluginBar } from '../pluginManager/ExternalPluginBar';
import { externalPlugins, installedDetail, isExternalPluginId, useCatalogVersion } from '../pluginManager/store';
import { AudioClipStretchSection, DetectTempoButton, STRETCH_PARAM_IDS } from '../../ears/AudioClipTempo';
import { PresetBar, hasPresetBar } from '../../sounds/PresetBar';
import { RackEditor } from './RackEditor';
import { wrapChannelInRack, wrapSlotInRack } from '../../racks/actions';
import { SlotDisplay } from './SlotDisplay';

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/[0.07] bg-krypt-panel/70 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function groupParams(desc: PluginDescriptor, skip?: readonly string[]): Array<[string, ParamSpec[]]> {
  const groups = new Map<string, ParamSpec[]>();
  for (const p of desc.params) {
    if (skip?.includes(p.id)) continue;
    const g = p.group ?? 'Parameters';
    const list = groups.get(g) ?? [];
    list.push(p);
    groups.set(g, list);
  }
  return [...groups.entries()];
}

/** `skip`: param ids drawn by a dedicated section (e.g. the Audio Clip's Stretch & pitch). */
function ParamGroups({ desc, refFor, skip }: { desc: PluginDescriptor; refFor: (paramId: string) => string; skip?: readonly string[] }) {
  const groups = useMemo(() => groupParams(desc, skip), [desc, skip]);
  return (
    <>
      {groups.map(([g, specs]) => (
        <Section key={g} title={g}>
          <div className="flex flex-wrap items-start gap-x-2 gap-y-2.5">
            {specs.map((s) => (
              <ParamControl key={s.id} paramRef={refFor(s.id)} size={34} />
            ))}
          </div>
        </Section>
      ))}
    </>
  );
}

// ── Channel ───────────────────────────────────────────────────────────

const ROOT_KEY: ParamSpec = { id: 'rootKey', name: 'Root key', min: 0, max: 127, default: 60, unit: '', scale: 'linear', step: 1 };
const SWING_MIX: ParamSpec = { id: 'swing', name: 'Swing mix', min: 0, max: 1, default: 1, unit: '%', scale: 'linear' };
const GLIDE: ParamSpec = { id: 'glideMs', name: 'Glide', min: 0, max: 2000, default: 0, unit: 'ms', scale: 'linear' };
const CUT: ParamSpec = { id: 'cutGroup', name: 'Cut group', min: 0, max: 16, default: 0, unit: '', scale: 'linear', step: 1 };
const CUT_BY: ParamSpec = { id: 'cutBy', name: 'Cut by', min: 0, max: 16, default: 0, unit: '', scale: 'linear', step: 1 };

function ChannelEditor({ channelId }: { channelId: string }) {
  const ch = useProject((p) => p.channels[channelId]);
  const sample = useProject((p) => (p.channels[channelId]?.generator.sampleId ? p.samples[p.channels[channelId].generator.sampleId!] : null));
  const inserts = useProject((p) => p.mixer.insertOrder);
  const [drop, setDrop] = useState(false);
  useCatalogVersion(); // re-render when installed VST3/CLAP plugins register
  if (!ch) return <Gone what="channel" />;
  const desc = pluginById(ch.generator.type);
  const set = (patch: Record<string, unknown>, key?: string) =>
    dispatch('channels.set', { id: channelId, ...patch }, key ? { coalesceKey: `knob:ch/${channelId}/${key}` } : undefined);
  const p = getProject();

  return (
    <div className="space-y-2 p-2.5">
      <div className="flex items-center gap-2">
        <span className="h-8 w-1 rounded-full" style={{ background: ch.color }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-white">{ch.name}</div>
          <div className="truncate text-[10px] text-krypt-muted">{desc ? `${desc.name} · ${desc.description}` : `Unknown plugin ${ch.generator.type}`}</div>
        </div>
        <Select
          value={ch.generator.type}
          options={[
            ...PICKABLE_INSTRUMENTS.map((d) => ({ value: d.id, label: d.name, detail: d.category })),
            ...externalPlugins('instrument').map((d) => ({ value: d.id, label: d.name, detail: `Installed · ${installedDetail(d)}` })),
          ]}
          onChange={(type) => void dispatch('channels.setGenerator', { id: channelId, type }).then((r) => r.ok && flashHint(`${ch.name} now plays ${pluginById(type)?.name}`, 'ok'))}
          hint="Instrument"
          width={130}
        />
        <button
          type="button"
          onClick={() => openInPianoRoll(channelId)}
          className="flex h-6 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[10px] font-semibold text-white/85 hover:border-white/20"
          data-hint="Edit this channel's notes in the Piano Roll (F7)"
        >
          <Piano className="h-3 w-3" /> Piano Roll
        </button>
      </div>

      {hasPresetBar(ch.generator.type) && <PresetBar channelId={channelId} />}

      <ExternalPluginBar type={ch.generator.type} target={{ kind: 'channel', channelId }} />

      {desc?.id === 'krypt.multisampler' && (
        <Section title="Instrument">
          <div className="flex flex-col gap-0.5 text-[11px]">
            <span className="font-semibold text-white/90">{ch.generator.preset?.name ?? sample?.name ?? 'No instrument loaded'}</span>
            {sample && <span className="truncate font-mono text-[9px] text-krypt-muted">{sample.path}</span>}
            <span className="text-[10px] text-krypt-muted">A multisampled instrument from a sound pack. Pick another with the preset browser above.</span>
          </div>
        </Section>
      )}

      {desc?.usesSample && desc.id !== 'krypt.multisampler' && (
        <Section
          title="Sample"
          right={
            <div className="flex items-center gap-1">
              {sample && desc.id !== 'krypt.audioclip' && <DetectTempoButton channelId={channelId} />}
              <button
                type="button"
                onClick={() => void loadSampleDialog(channelId)}
                className="flex h-5 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 text-[10px] font-semibold text-white/85 hover:border-white/20"
                data-hint="Load or replace the sample (or drop one from the Browser)"
              >
                <FolderInput className="h-3 w-3" /> {sample ? 'Replace' : 'Load'}
              </button>
            </div>
          }
        >
          <div
            onDragOver={(e) => {
              const types = Array.from(e.dataTransfer.types);
              if (types.includes(SAMPLE_MIME) || types.includes('Files')) {
                e.preventDefault();
                e.stopPropagation();
                setDrop(true);
              }
            }}
            onDragLeave={() => setDrop(false)}
            onDrop={(e) => {
              setDrop(false);
              const path = e.dataTransfer.getData(SAMPLE_MIME);
              e.preventDefault();
              e.stopPropagation();
              if (path) void replaceChannelSample(channelId, path);
              else if (Array.from(e.dataTransfer.types).includes('Files')) void handleOsDrop(e.dataTransfer, (paths) => replaceChannelSample(channelId, paths[0]));
            }}
            className={cls('rounded-lg transition', drop && 'ring-1 ring-krypt-purple/70')}
          >
            <div className="mb-1.5 flex items-center gap-2 text-[11px]">
              <span className="font-semibold text-white/90">{sample?.name ?? 'No sample'}</span>
              {sample && <span className="truncate font-mono text-[9px] text-krypt-muted">{sample.path}</span>}
            </div>
            <Waveform
              path={sample?.path ?? null}
              color={ch.color}
              overlay={
                desc.id === 'krypt.audioclip'
                  ? (g) => <WarpOverlay channelId={channelId} geom={g} />
                  : desc.id === SLICER_PLUGIN
                    ? (g) => <SlicerOverlay channelId={channelId} geom={g} />
                    : undefined
              }
            />
          </div>
        </Section>
      )}

      {desc?.id === 'krypt.audioclip' && sample && <AudioClipStretchSection channelId={channelId} />}
      {desc?.id === 'krypt.audioclip' && sample && <WarpSection channelId={channelId} />}
      {desc?.id === SLICER_PLUGIN && sample && <SlicerSection channelId={channelId} />}

      <Section title="Channel">
        <div className="flex flex-wrap items-start gap-x-2 gap-y-2.5">
          <ParamKnob paramRef={`channel/${channelId}/volume`} size={34} showLabel showValue />
          <ParamKnob paramRef={`channel/${channelId}/pan`} size={34} showLabel showValue />
          <ParamKnob paramRef={`channel/${channelId}/pitch`} size={34} showLabel showValue />
          <SpecKnob spec={ROOT_KEY} value={ch.rootKey} format={(v) => noteName(Math.round(v))} onCommit={(v) => set({ rootKey: Math.round(v) }, 'rootKey')} size={34} />
          <SpecKnob spec={SWING_MIX} value={ch.swing} onCommit={(v) => set({ swing: v }, 'swing')} size={34} />
          <div className="flex flex-col items-center gap-1">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-krypt-muted">Mixer</div>
            <Select<string>
              value={ch.insertId}
              options={inserts.map((id, i) => ({
                value: id,
                label: p.mixer.inserts[id]?.isMaster ? 'Master' : `${i} · ${p.mixer.inserts[id]?.name}`,
                swatch: p.mixer.inserts[id]?.color,
              }))}
              onChange={(insertId) => void set({ insertId })}
              hint="Mixer insert this channel feeds"
              width={110}
            />
          </div>
        </div>
      </Section>

      <Section title="Voice">
        <div className="flex flex-wrap items-start gap-x-2 gap-y-2.5">
          <div className="flex w-[64px] flex-col items-center gap-1">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-krypt-muted">Mono</div>
            <Toggle variant="button" on={ch.poly.mono} onChange={(mono) => void set({ poly: { mono } })} hint="Mono: one voice at a time (808s, basses)" className="w-12 justify-center">
              {ch.poly.mono ? 'On' : 'Off'}
            </Toggle>
          </div>
          <SpecKnob spec={GLIDE} value={ch.poly.glideMs} onCommit={(v) => set({ poly: { glideMs: v } }, 'glide')} size={34} />
          <SpecKnob spec={CUT} value={ch.poly.cutGroup} format={(v) => (v ? String(Math.round(v)) : 'Off')} onCommit={(v) => set({ poly: { cutGroup: Math.round(v) } }, 'cut')} size={34} />
          <SpecKnob spec={CUT_BY} value={ch.poly.cutBy} format={(v) => (v ? String(Math.round(v)) : 'Off')} onCommit={(v) => set({ poly: { cutBy: Math.round(v) } }, 'cutBy')} size={34} />
        </div>
        <div className="mt-1.5 text-[10px] text-krypt-muted/80">Cut groups: a channel cuts off every channel whose “cut by” matches its group (open/closed hats).</div>
      </Section>

      {isRackPlugin(ch.generator.type) ? (
        <RackEditor target={{ channelId }} />
      ) : desc ? (
        <>
          <div className="flex items-center justify-between px-0.5 pt-1">
            <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{desc.name}</span>
            {!isExternalPluginId(desc.id) && desc.id !== 'krypt.audioclip' && desc.id !== SLICER_PLUGIN && (
              <button
                type="button"
                onClick={() => void wrapChannelInRack(channelId)}
                className="ml-auto mr-3 flex items-center gap-1 text-[10px] text-krypt-muted hover:text-white"
                data-hint="Wrap this sound in an instrument rack: layer more chains by key and velocity, with 8 macros (undoable)"
              >
                <Layers className="h-3 w-3" /> Wrap in rack
              </button>
            )}
            <button
              type="button"
              onClick={() => void dispatch('channels.resetGenParams', { id: channelId }).then((r) => r.ok && flashHint(`${desc.name} reset to defaults`, 'ok'))}
              className="flex items-center gap-1 text-[10px] text-krypt-muted hover:text-white"
              data-hint="Reset every instrument parameter to its default (undoable)"
            >
              <RotateCcw className="h-3 w-3" /> Reset
            </button>
          </div>
          {isExternalPluginId(desc.id) ? (
            <ExternalParams desc={desc} refFor={(id) => `channel/${channelId}/gen/${id}`} />
          ) : (
            <ParamGroups desc={desc} refFor={(id) => `channel/${channelId}/gen/${id}`} skip={desc.id === 'krypt.audioclip' ? STRETCH_PARAM_IDS : undefined} />
          )}
        </>
      ) : isExternalPluginId(ch.generator.type) ? null : (
        <div className="text-xs text-amber-300">This instrument isn't in the plugin catalog, so it has no editor here.</div>
      )}
    </div>
  );
}

// ── FX slot ───────────────────────────────────────────────────────────

function SlotEditor({ insertId, slotId }: { insertId: string; slotId: string }) {
  const slot = useProject((p) => p.mixer.inserts[insertId]?.slots[slotId]);
  const ins = useProject((p) => p.mixer.inserts[insertId]);
  const order = useProject((p) => p.mixer.insertOrder);
  useCatalogVersion(); // re-render when installed VST3/CLAP plugins register
  if (!slot || !ins) return <Gone what="effect" />;
  const desc = pluginById(slot.type);
  const p = getProject();
  return (
    <div className="space-y-2 p-2.5">
      <div className="flex items-center gap-2">
        <span className="h-8 w-1 rounded-full" style={{ background: ins.color }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-white">{desc?.name ?? slot.type}</div>
          <div className="truncate text-[10px] text-krypt-muted">
            {ins.isMaster ? 'Master' : `Insert ${order.indexOf(insertId)} · ${ins.name}`} · slot {ins.slotOrder.indexOf(slotId) + 1}
          </div>
        </div>
        <Toggle
          variant="button"
          tone="green"
          on={slot.enabled}
          onChange={(enabled) => void dispatch('mixer.setSlot', { insertId, slotId, enabled }).then((r) => r.ok && flashHint(enabled ? 'Effect enabled' : 'Effect bypassed', 'ok'))}
          hint={slot.enabled ? 'Active · click to bypass' : 'Bypassed · click to enable'}
        >
          {slot.enabled ? 'Active' : 'Bypassed'}
        </Toggle>
      </div>

      <ExternalPluginBar type={slot.type} target={{ kind: 'slot', insertId, slotId }} />

      <Section title="Slot">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <ParamKnob paramRef={`insert/${insertId}/slot/${slotId}/mix`} size={34} showLabel showValue label="Mix" />
          {desc?.sidechain && (
            <div className="flex flex-col items-center gap-1">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-krypt-muted">Sidechain</div>
              <Select<string>
                value={slot.sidechainFrom ?? ''}
                options={[
                  { value: '', label: 'None' },
                  ...order
                    .filter((id) => id !== insertId && !p.mixer.inserts[id]?.isMaster)
                    .map((id) => ({ value: id, label: `${order.indexOf(id)} · ${p.mixer.inserts[id].name}`, swatch: p.mixer.inserts[id].color })),
                ]}
                onChange={(v) => void dispatch('mixer.setSlot', { insertId, slotId, sidechainFrom: v || null })}
                hint="Sidechain source insert"
                width={140}
              />
            </div>
          )}
        </div>
      </Section>

      <SlotDisplay insertId={insertId} slotId={slotId} pluginType={slot.type} />

      {isRackPlugin(slot.type) ? (
        <RackEditor target={{ insertId, slotId }} />
      ) : desc ? (
        <>
          <div className="flex items-center justify-between px-0.5 pt-1">
            <span className="pr-2 text-[10px] text-krypt-muted">{desc.description}</span>
            {!isExternalPluginId(desc.id) && (
              <button
                type="button"
                onClick={() => void wrapSlotInRack(insertId, slotId)}
                className="mr-3 flex flex-shrink-0 items-center gap-1 text-[10px] text-krypt-muted hover:text-white"
                data-hint="Wrap this effect in an effect rack: parallel chains with 8 macros (undoable)"
              >
                <Layers className="h-3 w-3" /> Wrap in rack
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                void dispatch('mixer.setSlotParams', { insertId, slotId, params: Object.fromEntries(desc.params.map((s) => [s.id, s.default])) }).then(
                  (r) => r.ok && flashHint(`${desc.name} reset to defaults`, 'ok'),
                )
              }
              className="flex flex-shrink-0 items-center gap-1 text-[10px] text-krypt-muted hover:text-white"
              data-hint="Reset every parameter to its default (undoable)"
            >
              <RotateCcw className="h-3 w-3" /> Reset
            </button>
          </div>
          {isExternalPluginId(desc.id) ? (
            <ExternalParams desc={desc} refFor={(id) => `insert/${insertId}/slot/${slotId}/${id}`} />
          ) : (
            <ParamGroups desc={desc} refFor={(id) => `insert/${insertId}/slot/${slotId}/${id}`} skip={desc.id === 'krypt.gate' ? GATE_STEP_PARAM_IDS : undefined} />
          )}
        </>
      ) : isExternalPluginId(slot.type) ? null : (
        <div className="text-xs text-amber-300">This effect isn't in the plugin catalog, so it has no editor here.</div>
      )}
    </div>
  );
}

function Gone({ what }: { what: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-xs text-krypt-muted">
      This {what} no longer exists. Close this window, or undo to bring it back.
    </div>
  );
}

export function PluginPanel({ target }: { target: PluginTarget; panelId: string }) {
  if (!target) return <Gone what="plugin" />;
  return <div className="h-full overflow-y-auto">{target.kind === 'channel' ? <ChannelEditor channelId={target.channelId} /> : <SlotEditor insertId={target.insertId} slotId={target.slotId} />}</div>;
}
