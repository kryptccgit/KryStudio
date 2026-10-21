import { useEffect, useRef, useState } from 'react';
import { Check, Circle, Headphones, Loader2, Mic, Play, RotateCcw, SkipBack, Square, TriangleAlert, Wand2, X } from 'lucide-react';
import { audioInputSettings, recordingSettings } from '@shared/live/recording';
import { TUNE_STYLES, type TuneStyle } from '@shared/music/keymatch';
import { useProject } from '../doc/store';
import { useLiveInput } from '../live/liveInput';
import { telemetry } from '../live/telemetry';
import { onFrame } from '../render/frameLoop';
import { updateSettings, useEngineStatus, useSettings } from '../state/status';
import { monitorProblem } from '../app/RecordControls';
import { useHome } from '../home/store';
import { cls } from '../utils/format';
import { btn, primary, small } from '../voice/parts';
import { barLabel, beatPattern, LOOP_BARS, monitorStatus, songIsEmpty, targetTrackName } from './logic';
import { boothListen, boothLoopBeat, boothMore, boothRecord, boothRedo, boothStop, boothTune, closeBooth, followRecordState, takeLine } from './actions';
import { useBooth } from './store';

const TONE: Record<'off' | 'ok' | 'warn' | 'wait', string> = { off: 'text-krypt-muted', ok: 'text-emerald-300', warn: 'text-amber-300', wait: 'text-krypt-muted' };

function useBoothLive(fill: React.RefObject<HTMLDivElement | null>): { beats: number; elapsed: number; tick: number; micPeak: number; monPeak: number; monRunning: boolean } {
  const [s, set] = useState({ beats: 0, elapsed: 0, tick: 0, micPeak: 0, monPeak: 0, monRunning: false });
  useEffect(() => {
    let prevRec: 'countIn' | 'recording' | null = null;
    let level = 0;
    let recSince = 0;
    let win: Array<{ t: number; mic: number; mon: number }> = [];
    let last = '';
    return onFrame((dt) => {
      const f = telemetry.connected ? telemetry.frame : null;
      const now = performance.now();
      const rec = f?.rec ?? null;
      if (rec !== prevRec) {
        if (rec === 'recording') recSince = now;
        followRecordState(prevRec, rec);
        prevRec = rec;
      }
      const mic = f?.inputPeak ? Math.max(f.inputPeak[0], f.inputPeak[1]) : 0;
      const mon = f?.monitorPeak ?? 0;
      level = Math.max(mic, level * Math.pow(10, (-24 * dt) / 20));
      if (fill.current) fill.current.style.width = `${Math.min(100, Math.sqrt(level) * 100)}%`;
      win.push({ t: now, mic, mon });
      win = win.filter((x) => now - x.t < 1500);
      const micPeak = win.reduce((m, x) => Math.max(m, x.mic), 0);
      const monPeak = win.reduce((m, x) => Math.max(m, x.mon), 0);
      const next = {
        beats: f?.countIn ?? 0,
        elapsed: rec === 'recording' ? Math.floor((now - recSince) / 1000) : 0,
        tick: telemetry.playheadTick(),
        micPeak,
        monPeak,
        monRunning: typeof f?.monitorPeak === 'number',
      };
      const key = `${next.beats}|${next.elapsed}|${Math.floor(next.tick / 960)}|${micPeak > 0.003}|${monPeak > 1e-4}|${next.monRunning}`;
      if (key !== last) {
        last = key;
        set(next);
      }
    });
  }, [fill]);
  return s;
}

function Booth() {
  const st = useBooth();
  const p = useProject((x) => x);
  const settings = useSettings((x) => x.settings);
  const record = useLiveInput((x) => x.record);
  const outRate = useEngineStatus((x) => x.status?.device?.sampleRate);
  const fill = useRef<HTMLDivElement>(null);
  const live = useBoothLive(fill);
  const inp = audioInputSettings(settings);
  const rec = recordingSettings(settings);
  const input = record.input;
  const mon = monitorStatus({
    monitorOn: inp.monitor,
    inputOpen: !!input?.open,
    running: live.monRunning,
    micPeak: live.micPeak,
    monitorPeak: live.monPeak,
    rateProblem: monitorProblem(inp.monitor, !!input?.open, input?.sampleRate, outRate),
  });
  const busy = st.phase === 'starting' || st.phase === 'countIn' || st.phase === 'recording';
  const empty = songIsEmpty(p);
  const beat = beatPattern(p);
  const n = st.kept + 1;

  return (
    <div
      role="dialog"
      aria-label="Vocal Booth"
      data-guide="booth.panel"
      className="fixed bottom-4 right-4 z-[1070] w-[380px] overflow-hidden rounded-2xl border border-white/10 bg-[#0e0e17]/[0.97] font-sans text-white shadow-[0_18px_60px_rgba(0,0,0,0.65),0_0_30px_rgba(168,85,247,0.18)] animate-pop-in"
    >
      <div className={cls('h-px w-full', busy ? 'bg-rose-500' : 'bg-krypt-gradient opacity-80')} aria-hidden="true" />
      <div className="flex items-center gap-2 px-4 pt-3">
        <Mic className="h-4 w-4 text-krypt-purple" />
        <div className="text-[14px] font-bold tracking-tight">Vocal Booth</div>
        <span className={cls('rounded-full px-2 py-0.5 text-[10.5px] font-semibold', busy ? 'bg-rose-500/20 text-rose-200' : record.armed ? 'bg-rose-500/10 text-rose-300' : 'bg-white/5 text-krypt-muted')} aria-live="polite">
          {st.phase === 'countIn' ? `Count-in ${live.beats || ''}` : st.phase === 'recording' ? `Recording ${live.elapsed}s` : st.phase === 'starting' ? 'Starting…' : st.phase === 'saving' ? 'Saving…' : st.phase === 'review' ? 'Take ready' : record.armed ? 'Armed' : 'Not armed'}
        </span>
        <button type="button" onClick={() => void closeBooth()} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-krypt-muted hover:bg-white/10 hover:text-white" aria-label="Close the Vocal Booth" data-hint="Done: disarm and close (your takes stay)">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-3 px-4 pb-4 pt-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[11.5px]">
            <span className="min-w-0 flex-1 truncate text-white/80" title={input?.name ?? undefined}>
              {input?.open ? input.name : 'Microphone not open'}
            </span>
            <button
              type="button"
              onClick={() => void updateSettings({ audioInput: { ...inp, monitor: !inp.monitor } }, inp.monitor ? 'Hear yourself: off' : 'Hear yourself: on (use headphones)')}
              className={cls(small, inp.monitor && 'border-krypt-purple/50 bg-krypt-purple/15 text-white')}
              aria-pressed={inp.monitor}
              data-hint="Hear your voice in your headphones while you sing (dry, before the vocal chain)"
            >
              <Headphones className="h-3 w-3" /> Hear yourself
            </button>
          </div>
          <div className="relative h-2 overflow-hidden rounded-full border border-white/10 bg-black/40" aria-label="Microphone level">
            <div ref={fill} className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-400 via-amber-300 to-rose-500" style={{ width: '0%' }} />
          </div>
          <div className={cls('text-[11px]', TONE[mon.tone])}>{mon.text}</div>
        </div>

        {st.phase !== 'review' && (
          <div className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2 text-[11.5px] text-white/80">
            <span className="min-w-0 flex-1">
              Records from <b className="text-white">{barLabel(p, live.tick)}</b> on <b className="text-white">{targetTrackName(p)}</b>
            </span>
            <button type="button" className={small} disabled={busy} onClick={() => void window.krypt.engine.locate(0)} data-hint="Move the playhead to the start (or click the Playlist ruler)">
              <SkipBack className="h-3 w-3" /> Bar 1
            </button>
          </div>
        )}

        {empty && st.phase === 'ready' && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11.5px] text-amber-100/90">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1">
              {beat ? `Your song is empty, so you'd sing over silence.` : 'No beat yet. You can still record, or make a pattern first (F6).'}
              {beat && (
                <button type="button" className={cls(small, 'mt-1.5')} onClick={() => void boothLoopBeat()}>
                  Loop my beat ({LOOP_BARS} bars)
                </button>
              )}
            </div>
          </div>
        )}

        {st.phase !== 'review' && (
          <div className="flex items-center gap-3">
            {busy ? (
              <button
                type="button"
                className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-rose-400/60 bg-rose-500/20 text-[14px] font-bold text-rose-100 transition hover:bg-rose-500/30"
                onClick={() => void boothStop()}
                data-guide="booth.stop"
              >
                <Square className="h-4 w-4 fill-current" /> Stop
              </button>
            ) : (
              <button
                type="button"
                className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-rose-500 text-[14px] font-bold text-white shadow-[0_0_24px_rgba(244,63,94,0.45)] transition hover:bg-rose-400 disabled:opacity-40 disabled:shadow-none"
                disabled={st.phase === 'saving'}
                onClick={() => void boothRecord()}
                data-guide="booth.record"
              >
                {st.phase === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Circle className="h-4 w-4 fill-current" />}
                {st.phase === 'saving' ? 'Saving the take…' : 'Record'}
              </button>
            )}
            <div className="flex flex-col items-end gap-1 text-[10.5px] text-krypt-muted">
              <span>
                or <kbd className="rounded border border-white/15 bg-white/5 px-1 font-mono text-[10px] text-white/80">Space</kbd>
              </span>
              <span className="flex items-center gap-1">
                Count-in
                {([0, 1, 2] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    disabled={busy}
                    onClick={() => void updateSettings({ recording: { ...rec, countInBars: b } }, b ? `Count in ${b} bar${b > 1 ? 's' : ''}` : 'No count-in')}
                    className={cls('rounded px-1 font-mono', rec.countInBars === b ? 'bg-krypt-purple/30 text-white' : 'hover:text-white')}
                    aria-pressed={rec.countInBars === b}
                  >
                    {b || 'off'}
                  </button>
                ))}
              </span>
            </div>
          </div>
        )}

        {st.phase === 'review' && st.take && (
          <div className="space-y-2.5">
            <div className="flex items-center gap-2 text-[12px] text-white/90">
              <Check className="h-3.5 w-3.5 text-emerald-300" /> {takeLine(st.take.seconds, n)}
              <span className="ml-auto font-mono text-[10.5px] text-krypt-muted">{barLabel(p, st.take.start)}</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button type="button" className={btn} onClick={() => void boothListen()} data-guide="booth.listen">
                {st.listening ? <Square className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 fill-current" />} {st.listening ? 'Stop' : 'Listen'}
              </button>
              <button type="button" className={btn} onClick={() => void boothRedo()} data-hint="Throw this take away and record the same spot again">
                <RotateCcw className="h-3.5 w-3.5" /> Redo
              </button>
              <button type="button" className={primary} onClick={() => void boothMore()} data-hint="Keep it; the playhead moves after it for the next part">
                <Check className="h-3.5 w-3.5" /> Keep
              </button>
            </div>
            <div className="rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2" data-guide="booth.tune">
              <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-white/90">
                <Wand2 className="h-3.5 w-3.5 text-krypt-purple" /> Krypt Tune
                {st.tuning && <Loader2 className="h-3 w-3 animate-spin text-krypt-muted" />}
                <span className="ml-auto text-[10.5px] font-normal text-krypt-muted">{st.tuned ? `On: ${TUNE_STYLES[st.tuned].label}` : 'Off'}</span>
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                {(Object.keys(TUNE_STYLES) as TuneStyle[]).map((k) => (
                  <button key={k} type="button" disabled={st.tuning} onClick={() => void boothTune(k)} className={cls(small, st.tuned === k && 'border-krypt-purple/50 bg-krypt-purple/15 text-white')} data-hint={TUNE_STYLES[k].detail}>
                    {TUNE_STYLES[k].label}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-[10.5px] text-krypt-muted">Finds your key and tunes every take on {targetTrackName(p)}.</div>
            </div>
          </div>
        )}

        {st.error && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/[0.07] px-3 py-2 text-[11.5px] text-rose-100">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-rose-300" /> {st.error}
          </div>
        )}

        <div className="flex items-center gap-2 pt-0.5">
          <span className="min-w-0 flex-1 text-[10.5px] text-krypt-muted">{st.kept ? `${st.kept} take${st.kept === 1 ? '' : 's'} kept` : 'Takes land on the Playlist as you go.'}</span>
          <button type="button" className={small} onClick={() => void closeBooth()}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export function BoothHost() {
  const open = useBooth((s) => s.open);
  const homeOpen = useHome((s) => s.open);
  if (!open || homeOpen) return null;
  return <Booth />;
}
