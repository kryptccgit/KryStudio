import { AudioWaveform, Timer, TimerOff } from 'lucide-react';
import { pluginById } from '@shared/plugins/catalog';
import { formatParam } from '@shared/plugins/types';
import { useProject } from '../doc/store';
import { ParamControl, ParamKnob, paramMenuItems, useParam } from '../controls/ParamKnob';
import { DragNumber } from '../controls/DragNumber';
import { Select, Toggle } from '../controls/Toggle';
import { openMenu } from '../components/Menu';
import { cls } from '../utils/format';
import { openAnalysisDialog } from './AnalysisDialog';
import { audioClipCanFollowTempo } from './actions';
import { fmtBpm } from './logic';

export const STRETCH_PARAM_IDS = ['tempo_sync', 'src_bpm', 'stretch', 'pitch', 'formant'];

export function DetectTempoButton({ channelId, label = 'Detect tempo & key' }: { channelId: string; label?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => openAnalysisDialog({ channelId }, (e.target as Node).ownerDocument)}
      className="flex h-5 flex-shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 text-[10px] font-semibold text-white/85 hover:border-white/20"
      data-hint="Tempo, key, swing, sections and loudness of this sample"
    >
      <AudioWaveform className="h-3 w-3" /> {label}
    </button>
  );
}

function Labelled({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1" data-hint={hint}>
      <div className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-wider text-krypt-muted">{label}</div>
      {children}
    </div>
  );
}

function FollowToggle({ paramRef }: { paramRef: string }) {
  const p = useParam(paramRef);
  if (!p.spec) return null;
  const on = Math.round(p.value) >= 1;
  return (
    <Labelled label="Follow tempo">
      <Toggle
        variant="button"
        on={on}
        onChange={(v) => void p.commitNow(v ? 1 : 0)}
        hint={on ? 'Stretches to the project tempo · click to play at the recorded speed' : 'Plays at its recorded speed · click to follow the project tempo'}
        className="h-6 w-[72px] justify-center"
        onContextMenu={(e) => (e.preventDefault(), openMenu(e, paramMenuItems(paramRef, p.spec!, p.value, (v) => void p.commitNow(v))))}
      >
        {on ? 'On' : 'Off'}
      </Toggle>
    </Labelled>
  );
}

function SourceBpm({ paramRef }: { paramRef: string }) {
  const p = useParam(paramRef);
  if (!p.spec) return null;
  const spec = p.spec;
  return (
    <Labelled label="Source BPM" hint="The tempo the audio was recorded at (Detect tempo fills it in)">
      <DragNumber
        value={p.value}
        min={spec.min}
        max={spec.max}
        step={1}
        fineStep={0.01}
        pxPerStep={3}
        defaultValue={spec.default}
        label="Source BPM"
        hint="Source tempo"
        format={(v) => (v > 0 ? v.toFixed(v % 1 ? 2 : 0) : '?')}
        className="h-6 w-[64px] text-[12px] font-semibold"
        onChange={(v) => p.setPlain(v)}
        onEnd={() => void p.end()}
        onContextMenu={(e) => openMenu(e, paramMenuItems(paramRef, spec, p.value, (v) => void p.commitNow(v)))}
      />
    </Labelled>
  );
}

function ModeControl({ paramRef, label }: { paramRef: string; label: string }) {
  const p = useParam(paramRef);
  if (!p.spec) return null;
  const spec = p.spec;
  if (!spec.options) return <ParamControl paramRef={paramRef} size={34} label={label} />;
  return (
    <div onContextMenu={(e) => (e.preventDefault(), openMenu(e, paramMenuItems(paramRef, spec, p.value, (v) => void p.commitNow(v))))}>
      <Labelled label={label}>
        <Select value={Math.round(p.value)} options={spec.options.map((o, i) => ({ value: i, label: o }))} onChange={(v) => void p.commitNow(v)} hint={`${label}: ${formatParam(spec, p.value)}`} width={104} />
      </Labelled>
    </div>
  );
}

function Status({ channelId }: { channelId: string }) {
  const sync = useProject((p) => p.channels[channelId]?.generator.params.tempo_sync ?? null);
  const src = useProject((p) => p.channels[channelId]?.generator.params.src_bpm ?? null);
  const bpm = useProject((p) => p.transport.bpm);
  const supported = audioClipCanFollowTempo();
  const following = supported && Math.round(sync ?? 0) >= 1 && !!src && src > 0;
  const needsBpm = supported && Math.round(sync ?? 0) >= 1 && !(src && src > 0);
  const ratio = following && src ? bpm / src : 1;
  return (
    <div
      className={cls(
        'mt-2 flex items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px]',
        following ? 'border-krypt-purple/30 bg-krypt-purple/[0.07] text-white/90' : needsBpm ? 'border-amber-400/30 bg-amber-500/[0.07] text-amber-100' : 'border-white/[0.07] bg-black/20 text-krypt-muted',
      )}
    >
      {following ? <Timer className="h-3.5 w-3.5 flex-shrink-0 text-krypt-purple" /> : <TimerOff className="h-3.5 w-3.5 flex-shrink-0" />}
      <span className="min-w-0 flex-1 truncate">
        {following ? (
          <>
            Follows the project tempo: <span className="font-mono text-white">{fmtBpm(src!)}</span> → <span className="font-mono text-white">{fmtBpm(bpm)}</span> BPM
            <span className="ml-1.5 font-mono text-krypt-muted">×{ratio.toFixed(2)}</span>
          </>
        ) : needsBpm ? (
          'Set the source BPM (or detect it) so the clip can follow the project tempo.'
        ) : supported ? (
          'Plays at its recorded speed.'
        ) : (
          'Plays at its recorded speed. Time-stretching needs a newer audio engine.'
        )}
      </span>
      <DetectTempoButton channelId={channelId} label="Detect tempo" />
    </div>
  );
}

export function AudioClipStretchSection({ channelId }: { channelId: string }) {
  const desc = pluginById('krypt.audioclip');
  const has = (id: string): boolean => !!desc?.params.some((p) => p.id === id);
  const ref = (id: string): string => `channel/${channelId}/gen/${id}`;
  const pitchSpec = desc?.params.find((p) => p.id === 'pitch');
  return (
    <section className="rounded-xl border border-white/[0.07] bg-krypt-panel/70 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Stretch & pitch</h3>
      </div>
      {STRETCH_PARAM_IDS.some(has) && (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2.5">
          {has('tempo_sync') && <FollowToggle paramRef={ref('tempo_sync')} />}
          {has('src_bpm') && <SourceBpm paramRef={ref('src_bpm')} />}
          {has('stretch') && <ModeControl paramRef={ref('stretch')} label="Stretch" />}
          {has('pitch') && (
            <ParamKnob
              paramRef={ref('pitch')}
              size={34}
              showLabel
              showValue
              label="Pitch"
              hint={pitchSpec ? `Pitch shift without changing speed (${formatParam(pitchSpec, pitchSpec.min)} … ${formatParam(pitchSpec, pitchSpec.max)})` : undefined}
            />
          )}
          {has('formant') && <ParamControl paramRef={ref('formant')} size={34} label="Formants" />}
        </div>
      )}
      <Status channelId={channelId} />
    </section>
  );
}
