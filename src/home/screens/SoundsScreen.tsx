// Home ▸ Sounds & Plugins: presets (factory + yours), the factory sounds,
// optional sound packs (real recorded instruments, downloaded on click),
// sample folders found on this PC (one click adds them to the Browser, where
// agents can use them too), the stock instruments and effects, and the
// user's VST3 / CLAP plugins (Plugin Manager state, live).

import { useCallback, useEffect, useState } from 'react';
import { AudioLines, Blocks, Check, FolderOpen, FolderPlus, FolderSearch, FolderTree, Piano, RefreshCw, SlidersVertical, SwatchBook, TriangleAlert } from 'lucide-react';
import { EFFECTS, INSTRUMENTS } from '@shared/plugins/catalog';
import { rescanPlugins, usePluginManager } from '../../panels/pluginManager/store';
import { runHomeAction } from '../actions';
import { pluginsPill } from '../logic';
import { fmtCount } from '../../library/logic';
import { goBack, openGuides } from '../store';
import { Eyebrow, GlassPanel, HomeButton, IconTile, PillBadge, ScreenFrame, ScreenHeader } from '../ui';
import { soundsCounts } from '../../sounds/logic';
import { presetList, useEnsureSounds, useSounds } from '../../sounds/store';
import { addFolderToBrowser, openPresetsInBrowser, revealUserPresets } from '../../sounds/actions';
import { toast } from '../../app/notify';
import { SoundPacksSection } from './SoundPacks';

const STOCK_INSTRUMENTS = INSTRUMENTS.filter((p) => p.id !== 'krypt.audioclip');

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold leading-none text-white">{value}</div>
      {detail && <div className="mt-1.5 truncate text-[11px] text-krypt-muted">{detail}</div>}
    </div>
  );
}

type Found = Array<{ path: string; audioFiles: number; inBrowser: boolean }>;

function FoundOnThisPc() {
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  const scan = useCallback(async (announce: boolean): Promise<void> => {
    setBusy(true);
    try {
      const list = await window.krypt.sounds.suggestSampleFolders();
      setFound(list);
      setError(null);
      if (announce) toast.info(list.length ? `Found ${list.length} sample folder${list.length === 1 ? '' : 's'}` : 'No sample folders found in the usual places');
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      setError(msg);
      if (announce) toast.error(`Couldn’t look for sample folders: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void scan(false);
  }, [scan]);

  const add = async (path: string): Promise<void> => {
    setAdding(path);
    const ok = await addFolderToBrowser(path);
    setAdding(null);
    if (ok) setFound((cur) => cur?.map((f) => (f.path === path ? { ...f, inBrowser: true } : f)) ?? cur);
  };

  return (
    <GlassPanel className="mt-4 p-5" label="Sample folders found on this PC">
      <div className="flex items-start gap-3">
        <IconTile icon={FolderSearch} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-bold text-white">Found on this PC</h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-krypt-muted">Sample folders in the usual places. Add one to the Browser and AI agents can find and use its sounds too.</p>
        </div>
        <HomeButton kind="quiet" icon={RefreshCw} onClick={() => void scan(true)} busy={busy}>
          Look again
        </HomeButton>
      </div>
      <div className="mt-3 space-y-1.5">
        {found === null && !error && <p className="text-[12px] text-krypt-muted">Looking…</p>}
        {error && <p className="text-[12px] text-rose-300">Couldn’t look for sample folders: {error}</p>}
        {found && !found.length && (
          <p className="text-[12px] leading-relaxed text-krypt-muted">
            Nothing found in Documents, Music or Downloads. Add any folder with the folder button at the top of the Browser.
          </p>
        )}
        {found?.map((f) => {
          const name = f.path.split(/[\\/]/).filter(Boolean).pop() ?? f.path;
          return (
            <div key={f.path} className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
              <FolderOpen className="h-4 w-4 flex-shrink-0 text-krypt-purple/80" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-semibold text-white">{name}</div>
                <div className="truncate font-mono text-[10.5px] text-krypt-muted" title={f.path}>
                  {f.path} · {fmtCount(f.audioFiles)} audio file{f.audioFiles === 1 ? '' : 's'}
                </div>
              </div>
              {f.inBrowser ? (
                <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-300">
                  <Check className="h-3 w-3" aria-hidden="true" /> In the Browser
                </span>
              ) : (
                <HomeButton kind="ghost" icon={FolderPlus} onClick={() => void add(f.path)} busy={adding === f.path} disabled={!!adding && adding !== f.path}>
                  Add to Browser
                </HomeButton>
              )}
            </div>
          );
        })}
      </div>
    </GlassPanel>
  );
}

export function SoundsScreen() {
  useEnsureSounds();
  const st = usePluginManager((s) => s.state);
  const busy = usePluginManager((s) => s.busy);
  const soundsState = useSounds((s) => s.state);
  const soundsError = useSounds((s) => s.error);
  const samples = useSounds((s) => s.samples);
  const [rescanning, setRescanning] = useState(false);
  const pill = pluginsPill(st);
  const failed = st ? st.files.filter((f) => f.status !== 'ok').length : 0;
  const counts = soundsCounts(presetList(soundsState), samples);
  const stockPlugins = STOCK_INSTRUMENTS.length + EFFECTS.length;
  const rescan = async (): Promise<void> => {
    setRescanning(true);
    await rescanPlugins(false);
    setRescanning(false);
  };
  return (
    <ScreenFrame label="Sounds and Plugins">
      <ScreenHeader
        icon={Blocks}
        title="Sounds & Plugins"
        subtitle="Presets, samples, the stock instruments and effects, and your own VST3 / CLAP plugins."
        onBack={goBack}
        right={
          <div className="mt-1 flex gap-1">
            <HomeButton kind="quiet" onClick={() => openGuides('sounds-presets')}>
              Presets guide
            </HomeButton>
            <HomeButton kind="quiet" onClick={() => openGuides('sounds-plugins')}>
              Plugins guide
            </HomeButton>
          </div>
        }
      />

      <GlassPanel className="mt-7 p-5" label="Presets and sounds">
        <div className="flex items-start gap-3">
          <IconTile icon={SwatchBook} accent />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-bold text-white">Presets & sounds</h2>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-krypt-muted">
              Ready-made instrument sounds and effect chains, plus the factory sounds. Load a preset from a channel’s plugin editor, or drag one from the Browser onto the Channel Rack. Agents pick from the same presets.
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label="Factory presets" value={fmtCount(counts.factoryPresets)} detail={`${fmtCount(counts.chainPresets)} effect chain${counts.chainPresets === 1 ? '' : 's'} in total`} />
          <Stat label="Your presets" value={fmtCount(counts.userPresets)} detail={counts.userPresets ? 'Saved by you or an agent' : 'Save one with Save preset…'} />
          <Stat label="Factory sounds" value={samples === null ? '…' : fmtCount(counts.factorySamples)} detail={samples && !samples.length ? 'Factory index not installed' : 'Drums, 808s, risers, impacts…'} />
          <Stat label="Plugins" value={fmtCount(stockPlugins + (st?.plugins.length ?? 0))} detail={`${stockPlugins} stock · ${st ? fmtCount(st.plugins.length) : '…'} installed`} />
        </div>
        {soundsError && (
          <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-amber-300">
            <TriangleAlert className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
            <span>Couldn’t read your presets ({soundsError}). Showing the factory presets only.</span>
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <HomeButton kind="primary" icon={SwatchBook} onClick={openPresetsInBrowser}>
            Browse presets
          </HomeButton>
          <HomeButton kind="ghost" icon={FolderOpen} onClick={() => void revealUserPresets()}>
            Your presets folder
          </HomeButton>
          <HomeButton kind="ghost" icon={Blocks} onClick={() => runHomeAction('pluginManager')}>
            Plugin Manager
          </HomeButton>
        </div>
      </GlassPanel>

      <SoundPacksSection />

      <FoundOnThisPc />

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <GlassPanel className="flex flex-col p-5" label="Browser and factory sounds">
          <IconTile icon={FolderTree} />
          <h2 className="mt-3 text-[15px] font-bold text-white">Browser & factory sounds</h2>
          <p className="mt-1 flex-1 text-[12.5px] leading-relaxed text-krypt-muted">
            The factory sounds are made by Krypt Studio’s own engine and are free to use in anything. The Browser sorts them by kind (kicks, 808s, risers…), with the root note of tonal sounds and the length of tempo-synced effects. Click to hear, drag onto the Channel Rack or the Playlist.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <HomeButton kind="primary" icon={FolderTree} onClick={() => runHomeAction('browser')}>
              Open the Browser
            </HomeButton>
          </div>
        </GlassPanel>

        <GlassPanel className="flex flex-col p-5" label="Your plugins">
          <div className="flex items-start justify-between gap-3">
            <IconTile icon={Blocks} />
            <PillBadge pill={pill} />
          </div>
          <h2 className="mt-3 text-[15px] font-bold text-white">Your VST3 / CLAP plugins</h2>
          <p className="mt-1 flex-1 text-[12.5px] leading-relaxed text-krypt-muted">
            {!st
              ? 'Asking the Plugin Manager…'
              : !st.hostAvailable
                ? (st.hostUnsupported ?? 'The plugin host isn’t in this install, so third-party plugins can’t be scanned or loaded. Reinstall Krypt Studio.')
                : st.plugins.length
                  ? `${st.plugins.length} plugin${st.plugins.length === 1 ? '' : 's'} ready, from ${st.folders.length} folder${st.folders.length === 1 ? '' : 's'}. They show under “Installed” when you add a channel or an effect.`
                  : 'None found yet. The Plugin Manager scans the standard VST3 and CLAP folders, plus any folder you add.'}
          </p>
          {!!st && (failed > 0 || st.vst2Found > 0) && (
            <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-amber-300">
              <TriangleAlert className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
              <span>
                {[failed ? `${failed} file${failed === 1 ? '' : 's'} had problems while scanning` : null, st.vst2Found ? `${st.vst2Found} VST2 file${st.vst2Found === 1 ? '' : 's'} skipped (VST2 isn’t supported)` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <HomeButton kind="primary" icon={Blocks} onClick={() => runHomeAction('pluginManager')}>
              Plugin Manager
            </HomeButton>
            <HomeButton kind="ghost" icon={RefreshCw} onClick={() => void rescan()} busy={rescanning || st?.scanning} disabled={!st?.hostAvailable || !!busy}>
              {st?.scanning ? 'Scanning…' : 'Rescan'}
            </HomeButton>
          </div>
        </GlassPanel>
      </div>

      <GlassPanel className="mt-4 p-5" label="Stock instruments and effects">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div>
            <Eyebrow className="flex items-center gap-1.5">
              <Piano className="h-3 w-3" aria-hidden="true" /> {STOCK_INSTRUMENTS.length} stock instruments
            </Eyebrow>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {STOCK_INSTRUMENTS.map((p) => (
                <li key={p.id} className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-white/85">
                  {p.name}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <Eyebrow className="flex items-center gap-1.5">
              <SlidersVertical className="h-3 w-3" aria-hidden="true" /> {EFFECTS.length} stock effects
            </Eyebrow>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {EFFECTS.map((p) => (
                <li key={p.id} className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-white/85">
                  {p.name.replace(/^Krypt /, '')}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </GlassPanel>
      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-krypt-muted">
        <AudioLines className="h-3 w-3" aria-hidden="true" /> Agents use these too: they ask for a sound by role and genre, and Krypt Studio picks a fitting preset.
      </p>
    </ScreenFrame>
  );
}
