// ──────────────────────────────────────────────────────────────────────
// Record my voice (research/21 §voices): clone the user's OWN voice on
// Fish Audio. Why (only your own voice), the consent line and a short
// passage to read, then a live take through the existing recorder (arm
// audio, play, ~30 s, stop: the take lands on the playlist like any
// recording), then a consent checkbox + a name → cloneMyVoice. Never a
// file upload: the recording must be made here, from the microphone.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { Check, Circle, Cloud, Loader2, Mic, RotateCcw, ShieldCheck, Square, TriangleAlert, UserRound } from 'lucide-react';
import { CONSENT_LINE } from '@shared/voice/types';
import { recordingSettings } from '@shared/live/recording';
import type { RecordMode } from '@shared/types';
import { Check as CheckBox, openDialog } from '../components/Dialog';
import { dispatch, getProject } from '../doc/store';
import { toast } from '../app/notify';
import { onFrame } from '../render/frameLoop';
import { telemetry } from '../live/telemetry';
import { useLiveInput } from '../live/liveInput';
import { updateSettings, useSettings } from '../state/status';
import { cls } from '../utils/format';
import { FISH_PRIVACY, READING_PASSAGE, RECORD_MIN_SEC, RECORD_TARGET_SEC, audioClipIds, cloneNameError, failureMessage, fmtSeconds, newAudioTakes, recordingTooShort } from './logic';
import { setSpeak, setSing, useVoice } from './store';
import { ensureVoiceState, openVoiceSettings } from './actions';
import { CloudBadge, Note, SectionTitle, btn, danger, primary, small } from './parts';

type Phase = 'intro' | 'starting' | 'recording' | 'finishing' | 'captured' | 'cloning' | 'done';
type Take = { path: string; seconds: number | null; channelId: string };

export function openRecordVoice(doc?: Document | null): void {
  void ensureVoiceState();
  openDialog({
    key: 'recordVoice',
    title: 'Record my voice',
    subtitle: 'Make a Cloud voice from your own voice, for your own music.',
    icon: Mic,
    width: 560,
    doc,
    render: (close) => <RecordView close={close} />,
    onClose: () => void session.abort(),
  });
}

// ── The recording session (outside React: it must clean up when the dialog closes) ──

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const session = {
  before: new Set<string>(),
  restoreMode: null as RecordMode | null,
  lastTakeId: null as number | null,
  active: false,

  async restore(): Promise<void> {
    try {
      await window.krypt.record.setArmed(false);
    } catch {
      /* the transport button shows the arm state */
    }
    if (this.restoreMode) {
      const rec = recordingSettings(useSettings.getState().settings);
      await updateSettings({ recording: { ...rec, mode: this.restoreMode } });
      this.restoreMode = null;
    }
  },

  /** Arm audio recording and start the transport. Returns an error message or null. */
  async start(): Promise<string | null> {
    this.before = audioClipIds(getProject());
    this.lastTakeId = useLiveInput.getState().record.lastTake?.id ?? null;
    const rec = recordingSettings(useSettings.getState().settings);
    if (rec.mode === 'midi') {
      this.restoreMode = rec.mode;
      if (!(await updateSettings({ recording: { ...rec, mode: 'audio' } }))) return "Couldn't switch the recorder to audio";
    }
    const armed = await window.krypt.record.setArmed(true);
    if (!armed.ok) {
      await this.restore();
      return armed.message || "Couldn't arm the recorder";
    }
    const input = armed.data?.input;
    if (input && !input.open) {
      await this.restore();
      return input.message || 'No microphone is open: pick your audio input in Settings ▸ MIDI and audio input';
    }
    const play = await window.krypt.engine.transport('play');
    if (!play.ok) {
      await this.restore();
      return play.message || "The audio engine didn't start";
    }
    this.active = true;
    return null;
  },

  /** Stop, wait for the take to land on the playlist, and find its WAV. */
  async stop(): Promise<{ take: Take | null; message: string }> {
    this.active = false;
    await window.krypt.engine.transport('stop').catch(() => undefined);
    let message = '';
    for (let i = 0; i < 100; i++) {
      const t = useLiveInput.getState().record.lastTake;
      if (t && t.id !== this.lastTakeId) {
        message = t.message;
        break;
      }
      await wait(150);
    }
    let found: Take | null = null;
    for (let i = 0; i < 15 && !found; i++) {
      const takes = newAudioTakes(getProject(), this.before);
      if (takes[0]) found = { path: takes[0].path, seconds: takes[0].seconds, channelId: takes[0].channelId };
      else await wait(150);
    }
    await this.restore();
    return { take: found, message };
  },

  async abort(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await window.krypt.engine.transport('stop').catch(() => undefined);
    await this.restore();
    toast.info('Recording stopped: the dialog was closed. Any take is on the playlist.');
  },
};

/** Take the recording off the playlist (its audio-clip channel and clip). The WAV stays in your recordings folder. */
async function removeTake(take: Take): Promise<void> {
  const r = await dispatch('channels.remove', { ids: [take.channelId] }, { label: 'Remove the voice recording' });
  if (r.ok) toast.info('The recording was taken off the playlist');
}

// ── View ──────────────────────────────────────────────────────────────

function useRecLive(active: boolean): { rec: 'countIn' | 'recording' | null; level: number } {
  const [s, set] = useState<{ rec: 'countIn' | 'recording' | null; level: number }>({ rec: null, level: 0 });
  useEffect(() => {
    if (!active) return;
    let level = 0;
    let last = '';
    return onFrame((dt) => {
      const f = telemetry.connected ? telemetry.frame : null;
      const pk = f?.inputPeak ? Math.max(f.inputPeak[0], f.inputPeak[1]) : 0;
      level = Math.max(pk, level * Math.pow(10, (-24 * dt) / 20));
      const rec = f?.rec ?? null;
      const key = `${rec}|${Math.round(level * 40)}`;
      if (key !== last) {
        last = key;
        set({ rec, level });
      }
    });
  }, [active]);
  return s;
}

function RecordView({ close }: { close: () => void }) {
  const state = useVoice((s) => s.state);
  const [phase, setPhase] = useState<Phase>('intro');
  const [error, setError] = useState<string | null>(null);
  const [take, setTake] = useState<Take | null>(null);
  const [consent, setConsent] = useState(false);
  const [tidy, setTidy] = useState(true);
  const [name, setName] = useState('My voice');
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(0);
  const live = useRecLive(phase === 'recording');
  const keySet = !!state?.fish.keySet;

  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => setElapsed((performance.now() - started.current) / 1000), 200);
    return () => clearInterval(id);
  }, [phase]);

  const begin = async (): Promise<void> => {
    if (take && tidy) await removeTake(take);
    setTake(null);
    setError(null);
    setConsent(false);
    setPhase('starting');
    let err: string | null;
    try {
      err = await session.start();
    } catch (e) {
      err = failureMessage(e);
    }
    if (err) {
      setPhase('intro');
      setError(err);
      toast.error(`Record my voice: ${err}`);
      return;
    }
    started.current = performance.now();
    setElapsed(0);
    setPhase('recording');
  };

  const finish = async (): Promise<void> => {
    setPhase('finishing');
    try {
      const r = await session.stop();
      if (!r.take) {
        const msg = r.message ? `No voice take was found: ${r.message}` : 'No audio was recorded. Check your microphone in Settings ▸ MIDI and audio input, then try again.';
        setError(msg);
        setPhase('intro');
        toast.error(msg);
        return;
      }
      setTake(r.take);
      setPhase('captured');
      if (r.take.seconds !== null && recordingTooShort(r.take.seconds)) toast.warn(`That take is only ${fmtSeconds(r.take.seconds)}: read the whole passage (about ${RECORD_TARGET_SEC} s) for a good clone.`);
      else toast.success('Got it. Tick the consent box, name your voice, then make it.');
    } catch (e) {
      setError(failureMessage(e));
      setPhase('intro');
      toast.error(`Record my voice: ${failureMessage(e)}`);
    }
  };

  const clone = async (): Promise<void> => {
    if (!take || !consent) return;
    const bad = cloneNameError(name);
    if (bad) {
      toast.warn(bad);
      return;
    }
    setPhase('cloning');
    setError(null);
    try {
      const r = await window.krypt.voice.cloneMyVoice({ recordingPath: take.path, name: name.trim(), consent: true });
      if (!r.ok || !r.data) {
        const msg = failureMessage(r.message ?? '', "Fish Audio couldn't make the voice");
        setError(msg);
        setPhase('captured');
        toast.error(`Record my voice: ${msg}`);
        return;
      }
      const v = r.data;
      setSpeak({ voiceId: v.id });
      setSing({ voiceId: v.id });
      void ensureVoiceState(true);
      if (tidy) await removeTake(take);
      setPhase('done');
      toast.success(`Your voice "${v.name}" is ready: it's under My voice in Krypt Voice.`);
    } catch (e) {
      const msg = failureMessage(e);
      setError(msg);
      setPhase('captured');
      toast.error(`Record my voice: ${msg}`);
    }
  };

  const tooShort = !!take && take.seconds !== null && recordingTooShort(take.seconds);
  const recording = phase === 'recording';

  return (
    <div className="flex flex-col">
      <div className="space-y-3.5 px-4 py-3.5">
        <Note icon={ShieldCheck} tone="muted">
          <div className="font-semibold text-white/90">Only your own voice</div>
          Krypt clones the voice of the person at the microphone, for their own music. Never record or clone someone else, and there is no file upload: the take is made here, live.
        </Note>

        <section aria-label="What to read" data-guide="voice.record">
          <SectionTitle right={<CloudBadge />}>Read this out loud</SectionTitle>
          <div className={cls('space-y-2 rounded-xl border px-3.5 py-3 transition', recording ? 'border-rose-400/40 bg-rose-500/[0.06]' : 'border-white/10 bg-black/25')}>
            <p className="text-[13.5px] font-semibold leading-relaxed text-white">“{CONSENT_LINE}”</p>
            <p className="text-[12.5px] leading-relaxed text-white/75">{READING_PASSAGE}</p>
          </div>
          <div className="mt-1.5 text-[10.5px] text-krypt-muted">Start with the first line, then read the rest in your normal voice. Quiet room, about {RECORD_TARGET_SEC} seconds. Headphones help if a beat is playing.</div>
        </section>

        {!keySet && (
          <Note icon={Cloud} tone="warn">
            My voice is made by Fish Audio with your own key.{' '}
            <button type="button" className="font-semibold text-white underline decoration-white/40 underline-offset-2 hover:decoration-white" onClick={openVoiceSettings}>
              Add a free key in Settings ▸ Voice
            </button>{' '}
            first.
          </Note>
        )}

        {(phase === 'recording' || phase === 'starting' || phase === 'finishing') && (
          <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/30 px-3 py-2.5" aria-live="polite">
            <Circle size={12} className={cls('fill-current text-rose-400', recording && live.rec === 'recording' && 'animate-pulse')} />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-white">
                {phase === 'starting' ? 'Starting the recorder…' : phase === 'finishing' ? 'Saving the take…' : live.rec === 'countIn' ? 'Counting in…' : 'Recording'}
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-300 to-rose-500 transition-[width] duration-75" style={{ width: `${Math.min(100, Math.sqrt(live.level) * 100)}%` }} />
              </div>
            </div>
            <span className={cls('font-mono text-[13px]', elapsed >= RECORD_MIN_SEC ? 'text-white' : 'text-krypt-muted')}>
              {Math.floor(elapsed)} / {RECORD_TARGET_SEC} s
            </span>
          </div>
        )}

        {take && (phase === 'captured' || phase === 'cloning') && (
          <div className="space-y-2.5 rounded-xl border border-white/[0.07] bg-black/20 px-3 py-3">
            <div className="flex items-center gap-2 text-[11.5px] text-white/85">
              <Check size={13} className="text-emerald-300" /> Take recorded{take.seconds !== null ? `: ${fmtSeconds(take.seconds)}` : ''}
              {tooShort && <span className="text-amber-200">(short: a longer read sounds better)</span>}
            </div>
            <label className="flex items-center gap-2 text-[12px] text-white/85">
              <UserRound size={13} className="text-krypt-purple" />
              <span className="font-semibold">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                className="h-7 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-2 text-[12px] text-white outline-none focus:border-krypt-purple/60"
              />
            </label>
            <CheckBox checked={consent} onChange={setConsent} label="This is my own voice, and I agree to have it turned into an AI voice for my own music." hint="It's stored as a private voice on your Fish Audio account. Remove it any time in Settings ▸ Voice." />
            <CheckBox checked={tidy} onChange={setTidy} label="Take the recording off the playlist afterwards" hint="The take was placed on the playlist like any recording." />
          </div>
        )}

        {phase === 'done' && (
          <Note icon={Check} tone="ok">
            Your voice is ready. Pick it under <b>My voice</b> in Krypt Voice or Sing my notes.
          </Note>
        )}

        {error && (
          <Note icon={TriangleAlert} tone="error">
            {error}
          </Note>
        )}
        <p className="text-[10px] leading-snug text-krypt-muted/80">{FISH_PRIVACY}</p>
      </div>

      <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3">
        <div className="min-w-0 flex-1" />
        <button type="button" className={btn} onClick={close}>
          {phase === 'done' ? 'Done' : 'Close'}
        </button>
        {(phase === 'intro' || phase === 'starting') && (
          <button type="button" className={primary} disabled={!keySet || phase === 'starting'} onClick={() => void begin()}>
            {phase === 'starting' ? <Loader2 size={13} className="animate-spin" /> : <Circle size={12} className="fill-current" />} Start recording
          </button>
        )}
        {(phase === 'recording' || phase === 'finishing') && (
          <button type="button" className={cls(btn, danger)} disabled={phase === 'finishing'} onClick={() => void finish()}>
            {phase === 'finishing' ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} className="fill-current" />} Stop
          </button>
        )}
        {(phase === 'captured' || phase === 'cloning') && (
          <>
            <button type="button" className={small} disabled={phase === 'cloning'} onClick={() => void begin()}>
              <RotateCcw size={12} /> Record again
            </button>
            <button type="button" className={primary} disabled={!consent || phase === 'cloning' || !!cloneNameError(name)} onClick={() => void clone()} title={consent ? undefined : 'Tick the consent box first'}>
              {phase === 'cloning' ? <Loader2 size={13} className="animate-spin" /> : <Cloud size={13} />} Make my voice
            </button>
          </>
        )}
      </div>
    </div>
  );
}
