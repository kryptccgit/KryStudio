import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Ban, FolderOpen, FolderPlus, Loader2, Plug, RefreshCw, RotateCcw, Search, ShieldOff, Trash2, Zap } from 'lucide-react';
import type { PluginDescriptor } from '@shared/plugins/types';
import type { PluginFileEntry, PluginManagerState } from '@shared/types';
import { Badge } from '../../components/common';
import { cls } from '../../utils/format';
import { toast } from '../../app/notify';
import { addPluginFolder, formatLabel, reloadPlugins, removePluginFolder, rescanPlugins, unblockPlugin, usePluginManager } from './store';

function Group({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function SmallButton({ onClick, disabled, children, hint, danger }: { onClick: () => void; disabled?: boolean; children: ReactNode; hint?: string; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-hint={hint}
      className={cls(
        'flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        danger ? 'border-rose-400/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20' : 'border-white/10 bg-white/[0.04] text-white/90 hover:border-white/20 hover:bg-white/10',
      )}
    >
      {children}
    </button>
  );
}

const STATUS_TONE: Record<PluginFileEntry['status'], 'success' | 'warn' | 'danger' | 'neutral'> = {
  ok: 'success',
  partial: 'warn',
  timeout: 'warn',
  failed: 'danger',
  blocked: 'danger',
};

function PluginRow({ d, running }: { d: PluginDescriptor; running: number }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-semibold text-white">{d.name}</span>
          {d.hasEditor && <span title="Has its own editor window"><Plug className="h-3 w-3 flex-shrink-0 text-krypt-purple" /></span>}
          {running > 0 && <span className="text-[10px] text-emerald-300">· {running} in use</span>}
        </div>
        <div className="truncate text-[10px] text-krypt-muted">
          {[d.vendor || 'Unknown vendor', d.category, `${d.params.length} param${d.params.length === 1 ? '' : 's'}`, d.version ? `v${d.version}` : null].filter(Boolean).join(' · ')}
        </div>
      </div>
      <Badge tone={d.kind === 'instrument' ? 'gradient' : 'neutral'}>{d.kind === 'instrument' ? 'Instrument' : 'Effect'}</Badge>
      <Badge>{formatLabel(d) ?? '?'}</Badge>
    </div>
  );
}

function Problems({ s, busy }: { s: PluginManagerState; busy: boolean }) {
  const bad = s.files.filter((f) => f.status !== 'ok');
  if (!bad.length) return null;
  return (
    <Group
      title={`Problems (${bad.length})`}
      right={
        s.blocked.length > 0 && (
          <SmallButton onClick={() => void unblockPlugin()} disabled={busy} hint="Forget every blocked file and scan them again">
            <ShieldOff className="h-3.5 w-3.5" /> Reset blocklist
          </SmallButton>
        )
      }
    >
      <div className="space-y-1">
        {bad.map((f) => (
          <div key={f.path} className="flex items-start gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-1.5">
            {f.status === 'blocked' ? <Ban className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-rose-300" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-300" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[11px] font-semibold text-white/90">{f.path.split(/[\\/]/).pop()}</span>
                <Badge tone={STATUS_TONE[f.status]}>{f.status}</Badge>
              </div>
              <div className="truncate font-mono text-[9px] text-krypt-muted/80" title={f.path}>
                {f.path}
              </div>
              {f.message && <div className="mt-0.5 text-[10px] text-krypt-muted">{f.message}</div>}
            </div>
            {f.status === 'blocked' && (
              <SmallButton onClick={() => void unblockPlugin(f.path)} disabled={busy} hint="Remove from the blocklist and scan it again">
                <RotateCcw className="h-3 w-3" /> Retry
              </SmallButton>
            )}
          </div>
        ))}
      </div>
    </Group>
  );
}

export function PluginManager() {
  const s = usePluginManager((x) => x.state);
  const busyLabel = usePluginManager((x) => x.busy);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | 'instrument' | 'effect'>('all');
  const [format, setFormat] = useState<'all' | 'vst3' | 'clap'>('all');

  useEffect(() => {
    window.krypt.plugins
      .state()
      .then((st) => st && usePluginManager.setState({ state: st }))
      .catch((err) => toast.error(`Couldn't refresh the Plugin Manager: ${(err as Error)?.message ?? err}`));
  }, []);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (s?.plugins ?? []).filter(
      (d) =>
        (kind === 'all' || d.kind === kind) &&
        (format === 'all' || d.format === format || d.id.startsWith(`${format}:`)) &&
        (!q || d.name.toLowerCase().includes(q) || (d.vendor ?? '').toLowerCase().includes(q) || d.category.toLowerCase().includes(q)),
    );
  }, [s, query, kind, format]);

  if (!s)
    return (
      <div className="flex h-full items-center justify-center text-krypt-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );

  const busy = !!busyLabel || s.scanning;
  const running = new Map<string, number>();
  for (const i of s.instances) running.set(i.pluginId, (running.get(i.pluginId) ?? 0) + 1);
  const crashed = s.instances.filter((i) => i.state === 'crashed' || i.state === 'failed');
  const vst3 = s.plugins.filter((d) => d.format === 'vst3').length;
  const clap = s.plugins.length - vst3;

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-white">
            {s.plugins.length} installed plugin{s.plugins.length === 1 ? '' : 's'}
            <span className="ml-1.5 text-[11px] font-normal text-krypt-muted">
              {vst3} VST3 · {clap} CLAP{s.lastScanAt ? ` · scanned ${new Date(s.lastScanAt).toLocaleString()}` : ''}
            </span>
          </div>
          <div className="text-[10px] text-krypt-muted">64-bit VST3 and CLAP, running in a separate plugin-host process, so a plugin crash never takes down Krypt Studio.</div>
        </div>
        <div className="flex items-center gap-1.5">
          <SmallButton onClick={() => void rescanPlugins(false)} disabled={busy || !s.hostAvailable} hint="Scan new and changed plugin files">
            <RefreshCw className={cls('h-3.5 w-3.5', s.scanning && 'animate-spin')} /> Rescan
          </SmallButton>
          <SmallButton onClick={() => void rescanPlugins(true)} disabled={busy || !s.hostAvailable} hint="Scan every plugin file again (blocked files stay blocked)">
            <Zap className="h-3.5 w-3.5" /> Full rescan
          </SmallButton>
        </div>
      </div>

      {!s.hostAvailable && (
        <div className="mb-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          {s.hostUnsupported ?? 'The plugin host (krypt-studio-pluginhost) wasn’t found, so plugins can’t be scanned or loaded. In development run “npm run engine:build:debug”.'}
        </div>
      )}

      {s.scanning && s.progress && (
        <div className="mb-3 rounded-xl border border-white/10 bg-black/30 px-3 py-2">
          <div className="flex items-center justify-between text-[11px] text-white/90">
            <span className="truncate">
              Scanning{s.progress.current ? ` ${s.progress.current}` : '…'}
            </span>
            <span className="font-mono text-krypt-muted">
              {s.progress.done}/{s.progress.total}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-krypt-gradient transition-all" style={{ width: `${s.progress.total ? (100 * s.progress.done) / s.progress.total : 0}%` }} />
          </div>
        </div>
      )}

      {crashed.length > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 text-rose-300" />
          <div className="min-w-0 flex-1 text-[11px] text-rose-100">
            {crashed.map((c) => c.name).join(', ')} {crashed.length === 1 ? 'is' : 'are'} silent: the plugin host crashed or the plugin failed to load.
          </div>
          <SmallButton onClick={() => void reloadPlugins()} hint="Restart the plugin host and load every third-party plugin again (restores their last saved state)">
            <RotateCcw className="h-3.5 w-3.5" /> Reload plugins
          </SmallButton>
        </div>
      )}

      <div className="mb-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-krypt-muted">
        <span className="font-semibold text-white/90">VST2 is not supported.</span> Steinberg no longer licenses VST2, so Krypt Studio hosts VST3 and CLAP only — most
        plugins ship a VST3 or CLAP version; install that one.
        {s.vst2Found > 0 && (
          <span className="text-amber-200">
            {' '}
            {s.vst2Found} VST2 file{s.vst2Found === 1 ? ' was' : 's were'} found in your VST2 folders and skipped.
          </span>
        )}
      </div>

      <Group title="Installed">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <div className="flex min-w-[160px] flex-1 items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-2">
            <Search className="h-3.5 w-3.5 text-krypt-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, vendor, category"
              className="h-7 w-full bg-transparent text-[12px] text-white placeholder-krypt-muted/50 outline-none"
            />
          </div>
          {(['all', 'instrument', 'effect'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cls('h-7 rounded-lg border px-2 text-[11px] font-semibold', kind === k ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 text-krypt-muted hover:text-white')}
            >
              {k === 'all' ? 'All' : k === 'instrument' ? 'Instruments' : 'Effects'}
            </button>
          ))}
          {(['all', 'vst3', 'clap'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFormat(f)}
              className={cls('h-7 rounded-lg border px-2 text-[11px] font-semibold', format === f ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 text-krypt-muted hover:text-white')}
            >
              {f === 'all' ? 'Any format' : f.toUpperCase()}
            </button>
          ))}
        </div>
        {list.length ? (
          <div className="space-y-1">
            {list.map((d) => (
              <PluginRow key={d.id} d={d} running={running.get(d.id) ?? 0} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-[11px] text-krypt-muted">
            {s.plugins.length
              ? 'No plugin matches the filter.'
              : s.scanning
                ? 'Scanning your plugin folders…'
                : 'No VST3 or CLAP plugins found. Install some into the standard folders below, or add the folder where yours live, then Rescan.'}
          </div>
        )}
      </Group>

      <Problems s={s} busy={busy} />

      <Group
        title="Folders"
        right={
          <SmallButton onClick={() => void addPluginFolder()} disabled={busy} hint="Scan another folder for .vst3 and .clap files">
            <FolderPlus className="h-3.5 w-3.5" /> Add folder
          </SmallButton>
        }
      >
        <div className="space-y-1">
          {s.folders.map((f) => (
            <div key={f.path} className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-1.5">
              <FolderOpen className={cls('h-3.5 w-3.5 flex-shrink-0', f.exists ? 'text-krypt-purple' : 'text-krypt-muted/50')} />
              <span className={cls('min-w-0 flex-1 truncate font-mono text-[10px]', f.exists ? 'text-white/85' : 'text-krypt-muted/60')} title={f.path}>
                {f.path}
              </span>
              {!f.exists && <span className="text-[10px] text-krypt-muted/70">not found</span>}
              {f.builtin ? (
                <Badge>Standard</Badge>
              ) : (
                <button type="button" onClick={() => void removePluginFolder(f.path)} disabled={busy} className="text-krypt-muted hover:text-rose-300" data-hint="Stop scanning this folder">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      </Group>

      {s.instances.length > 0 && (
        <Group
          title={`Running in the plugin host${s.hostPid ? ` (pid ${s.hostPid})` : ''}`}
          right={
            <SmallButton onClick={() => void reloadPlugins()} hint="Restart the plugin host and reload every third-party plugin">
              <RotateCcw className="h-3.5 w-3.5" /> Reload plugins
            </SmallButton>
          }
        >
          <div className="space-y-1">
            {s.instances.map((i) => (
              <div key={i.key} className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-1">
                <span className="min-w-0 flex-1 truncate text-[11px] text-white/90">{i.name}</span>
                <span className="font-mono text-[9px] text-krypt-muted">{i.key}</span>
                <Badge tone={i.state === 'ok' ? 'success' : i.state === 'loading' || i.state === 'paused' ? 'warn' : 'danger'}>{i.state === 'ok' ? 'running' : i.state}</Badge>
              </div>
            ))}
          </div>
        </Group>
      )}
    </div>
  );
}
