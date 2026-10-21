import { useMemo, useState } from 'react';
import { AlertTriangle, AppWindow, PackageSearch, RotateCcw, Search } from 'lucide-react';
import { pluginById } from '@shared/plugins/catalog';
import type { PluginDescriptor } from '@shared/plugins/types';
import { ParamControl } from '../../controls/ParamKnob';
import { Badge } from '../../components/common';
import { wm } from '../../workspace/WindowManager';
import type { PluginTarget as PanelTarget } from '../../workspace/panels';
import { formatLabel, isExternalPluginId, openPluginEditor, reloadPlugins, useCatalogVersion, usePluginManager } from './store';

const keyOf = (t: PanelTarget): string => (t.kind === 'channel' ? t.channelId : `${t.insertId}/${t.slotId}`);
const apiTarget = (t: PanelTarget) => (t.kind === 'channel' ? { channelId: t.channelId } : { insertId: t.insertId, slotId: t.slotId });

export function ExternalPluginBar({ type, target }: { type: string; target: PanelTarget }) {
  useCatalogVersion();
  const key = keyOf(target);
  const inst = usePluginManager((s) => s.state?.instances.find((i) => i.key === key));
  if (!isExternalPluginId(type)) return null;
  const desc = pluginById(type);
  if (!desc)
    return (
      <div className="flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
        <PackageSearch className="h-4 w-4 flex-shrink-0" />
        <span className="min-w-0 flex-1">
          This {type.startsWith('vst3:') ? 'VST3' : 'CLAP'} plugin isn't installed on this computer (or hasn't been scanned yet), so it stays silent.
        </span>
        <button type="button" onClick={() => wm.open('pluginManager')} className="rounded-md border border-white/15 px-2 py-1 text-[10px] font-semibold text-white hover:bg-white/10">
          Plugin Manager
        </button>
      </div>
    );
  const dead = inst && (inst.state === 'crashed' || inst.state === 'failed');
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-krypt-panel/70 px-2.5 py-1.5">
        <Badge tone="gradient">{formatLabel(desc)}</Badge>
        <span className="min-w-0 flex-1 truncate text-[11px] text-krypt-muted">
          {desc.vendor || 'Third-party'} · runs in the plugin host{inst ? ` · ${inst.state === 'ok' ? 'running' : inst.state}` : ''}
        </span>
        {desc.hasEditor ? (
          <button
            type="button"
            onClick={() => void openPluginEditor(apiTarget(target))}
            disabled={!!dead}
            className="flex h-6 items-center gap-1 rounded-md border border-krypt-purple/40 bg-krypt-purple/15 px-2 text-[10px] font-semibold text-white hover:bg-krypt-purple/25 disabled:opacity-50"
            data-hint="Open the plugin's own window (it floats above Krypt Studio)"
          >
            <AppWindow className="h-3 w-3" /> Open plugin window
          </button>
        ) : (
          <span className="text-[10px] text-krypt-muted/80">No plugin window · use the parameters below</span>
        )}
      </div>
      {dead && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-100">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="min-w-0 flex-1">{desc.name} is silent: the plugin host crashed or the plugin failed to load.</span>
          <button type="button" onClick={() => void reloadPlugins()} className="flex items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-[10px] font-semibold text-white hover:bg-white/10">
            <RotateCcw className="h-3 w-3" /> Reload plugins
          </button>
        </div>
      )}
    </div>
  );
}

const PAGE = 96;

export function ExternalParams({ desc, refFor }: { desc: PluginDescriptor; refFor: (paramId: string) => string }) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? desc.params.filter((p) => p.name.toLowerCase().includes(s) || (p.group ?? '').toLowerCase().includes(s) || p.id === s) : desc.params;
  }, [desc, q]);
  if (!desc.params.length)
    return <div className="px-1 text-[11px] text-krypt-muted">{desc.name} exposes no automatable parameters{desc.hasEditor ? '; use its own window' : ''}.</div>;
  return (
    <section className="rounded-xl border border-white/[0.07] bg-krypt-panel/70 p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Parameters ({desc.params.length})</h3>
        {desc.params.length > 12 && (
          <div className="ml-auto flex w-44 items-center gap-1 rounded-md border border-white/10 bg-black/40 px-1.5">
            <Search className="h-3 w-3 text-krypt-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a parameter" className="h-6 w-full bg-transparent text-[11px] text-white outline-none" />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-start gap-x-2 gap-y-2.5">
        {shown.slice(0, limit).map((s) => (
          <ParamControl key={s.id} paramRef={refFor(s.id)} size={34} />
        ))}
      </div>
      {shown.length > limit && (
        <button type="button" onClick={() => setLimit((l) => l + PAGE)} className="mt-2 text-[10px] font-semibold text-krypt-purple hover:text-white">
          Show {Math.min(PAGE, shown.length - limit)} more of {shown.length - limit}
        </button>
      )}
      {desc.format === 'vst3' && <div className="mt-1.5 text-[10px] text-krypt-muted/70">VST3 values are normalized 0–1 (switches and lists use step numbers).</div>}
    </section>
  );
}
