// ──────────────────────────────────────────────────────────────────────
// The preset bar in a channel's plugin editor: ‹ [preset name • ▾] › Save.
// The name is generator.preset; the pink dot means the params or sample
// moved away from that preset. The arrows step through presets of the same
// instrument; the name opens the preset browser. Drop a preset from the
// Browser onto the bar to load it. Stock instruments only: VST3 / CLAP
// presets live in the plugin's own window.
// ──────────────────────────────────────────────────────────────────────

import { useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Save, SwatchBook } from 'lucide-react';
import { isExternalPluginId, pluginById } from '@shared/plugins/catalog';
import { useProject } from '../doc/store';
import { cls } from '../utils/format';
import { cycleList, decodePresetDrag, isPresetModified, modifiedHint, PRESET_MIME } from './logic';
import { presetList, useEnsureSounds, usePresetObject, useSounds } from './store';
import { loadPresetOnChannel, stepPreset } from './actions';
import { toggleChannelPresetPopover } from './pickers';
import { openSavePresetDialog } from './SavePresetDialog';
import { toast } from '../app/notify';

/** Instruments that get the bar: stock ones (not third-party, not the playlist's audio clip). */
export function hasPresetBar(type: string): boolean {
  return !isExternalPluginId(type) && type !== 'krypt.audioclip';
}

const btn = 'flex h-6 flex-shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-white/80 transition hover:border-white/20 hover:text-white disabled:opacity-35 disabled:hover:border-white/10';

export function PresetBar({ channelId }: { channelId: string }) {
  useEnsureSounds();
  const type = useProject((p) => p.channels[channelId]?.generator.type ?? '');
  const params = useProject((p) => p.channels[channelId]?.generator.params);
  const preset = useProject((p) => p.channels[channelId]?.generator.preset);
  const samplePath = useProject((p) => {
    const sid = p.channels[channelId]?.generator.sampleId;
    return sid ? (p.samples[sid]?.path ?? null) : null;
  });
  const state = useSounds((s) => s.state);
  const full = usePresetObject(preset?.id);
  const nameRef = useRef<HTMLButtonElement>(null);
  const [drop, setDrop] = useState(false);

  const count = useMemo(() => cycleList(presetList(state), type).length, [state, type]);
  const desc = pluginById(type);
  const cur = { type, params: params ?? {}, samplePath };
  const modified = !!preset && !!full && full.kind === 'instrument' && isPresetModified(cur, full, desc?.params);
  const hint = preset
    ? full && full.kind === 'instrument'
      ? modifiedHint(cur, full, desc?.params)
      : `${preset.name} · click to browse presets`
    : 'No preset loaded · click to browse presets';

  return (
    <div
      className={cls('flex items-center gap-1 rounded-lg border bg-black/25 p-1 transition', drop ? 'border-krypt-purple/70 ring-1 ring-krypt-purple/40' : 'border-white/[0.07]')}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes(PRESET_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        setDrop(true);
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        setDrop(false);
        const d = decodePresetDrag(e.dataTransfer.getData(PRESET_MIME));
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        if (d.kind !== 'instrument') toast.warn(`${d.name} is an effect chain. Drop it on a mixer insert's chain instead.`);
        else void loadPresetOnChannel(channelId, d.id);
      }}
    >
      <SwatchBook className="ml-1 h-3.5 w-3.5 flex-shrink-0 text-krypt-purple/80" aria-hidden="true" />
      <button type="button" className={cls(btn, 'w-6')} onClick={() => void stepPreset(channelId, -1)} disabled={!count} data-hint={count ? `Previous ${desc?.name ?? ''} preset (${count})` : 'No presets for this instrument yet'} aria-label="Previous preset">
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <button
        ref={nameRef}
        type="button"
        onClick={() => nameRef.current && toggleChannelPresetPopover(nameRef.current, channelId)}
        className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-white/10 bg-black/40 px-2 text-left transition hover:border-white/20"
        data-hint={hint}
        aria-label={`Preset: ${preset?.name ?? 'none'}${modified ? ', modified' : ''}. Browse presets`}
      >
        <span className={cls('truncate text-[11.5px] font-semibold', preset ? 'text-white' : 'text-krypt-muted')}>{preset?.name ?? 'No preset'}</span>
        {modified && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-krypt-pink shadow-[0_0_6px_rgba(236,72,153,0.8)]" aria-hidden="true" />}
        <ChevronDown className="ml-auto h-3 w-3 flex-shrink-0 text-krypt-muted" />
      </button>
      <button type="button" className={cls(btn, 'w-6')} onClick={() => void stepPreset(channelId, 1)} disabled={!count} data-hint={count ? `Next ${desc?.name ?? ''} preset (${count})` : 'No presets for this instrument yet'} aria-label="Next preset">
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={cls(btn, 'gap-1 px-2 text-[10px] font-semibold')}
        onClick={(e) => openSavePresetDialog(channelId, (e.currentTarget as Node).ownerDocument)}
        data-hint="Save this sound as your own preset (instrument, settings, sample and, if you like, its effects)"
      >
        <Save className="h-3 w-3" /> Save…
      </button>
    </div>
  );
}
