import { factoryChainPresets } from '@shared/sounds/factory';
import { recordingInsert, recordingSettings } from '@shared/live/recording';
import type { TuneStyle } from '@shared/music/keymatch';
import { dispatch, dispatchBatch, getProject } from '../doc/store';
import { useLiveInput } from '../live/liveInput';
import { updateSettings, useEngineStatus, useSettings } from '../state/status';
import { toast } from '../app/notify';
import { autoTuneVocal } from '../ears/vocals';
import { audioClipIds, newAudioTakes } from '../voice/logic';
import { showStudio } from '../home/store';
import { wm } from '../workspace/WindowManager';
import { beatPattern, boothBlocker, fmtTakeSeconds, loopBeatSteps, LOOP_BARS, nextBarTick, targetTrackName, type BoothPhase } from './logic';
import { useBooth } from './store';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const set = useBooth.setState;

let before = new Set<string>();
let lastTakeId: number | null = null;
let listenTimer: ReturnType<typeof setTimeout> | null = null;

function fail(message: string, phase: BoothPhase = 'ready'): void {
  set({ error: message, phase });
  toast.error(message);
}

function noteStart(): void {
  before = audioClipIds(getProject());
  lastTakeId = useLiveInput.getState().record.lastTake?.id ?? null;
}

async function setArmed(on: boolean): Promise<boolean> {
  try {
    const r = await window.krypt.record.setArmed(on);
    if (r.data) useLiveInput.setState({ record: r.data });
    if (!r.ok) {
      if (on) fail(r.message || "Couldn't arm recording");
      return false;
    }
    if (on) {
      const input = r.data?.input;
      const blocked = boothBlocker({ engineRunning: useEngineStatus.getState().status?.state === 'running', inputOpen: !!input?.open, inputMessage: input?.message });
      if (blocked) {
        fail(blocked);
        return false;
      }
    }
    return true;
  } catch (err) {
    if (on) fail((err as Error)?.message ?? "Couldn't arm recording");
    return false;
  }
}

export async function openBooth(): Promise<void> {
  set({ open: true, phase: 'ready', take: null, error: null, listening: false });
  showStudio();
  wm.open('playlist');
  if (!recordingInsert(getProject())) {
    const chain = factoryChainPresets().find((c) => c.role === 'vocal') ?? null;
    const r = await dispatch<{ createdTrack: boolean }>('recording.setupVocals', { name: 'Vocals', chain }, { label: 'Set up the Vocal Booth' });
    if (r.ok) toast.success(`Made a "Vocals" track${chain ? ` with the ${chain.name} chain` : ''}: every take lands there`);
    else return fail(r.message || "Couldn't set up the Vocals track");
  }
  const rec = recordingSettings(useSettings.getState().settings);
  if (rec.mode === 'midi') await updateSettings({ recording: { ...rec, mode: 'audio' } });
  if (getProject().transport.mode !== 'song') await dispatch('transport.setMode', { mode: 'song' });
  await setArmed(true);
}

export async function closeBooth(): Promise<void> {
  const { phase, kept, take } = useBooth.getState();
  if (phase === 'recording' || phase === 'countIn' || phase === 'starting') await boothStop();
  await stopListening();
  await setArmed(false);
  const n = kept + (useBooth.getState().take || take ? 1 : 0);
  set({ open: false, phase: 'ready', take: null, kept: 0, tuned: null, error: null });
  if (n) toast.success(`${n} take${n === 1 ? '' : 's'} on ${targetTrackName(getProject())}. Undo (Ctrl+Z) takes any of them back.`);
  else toast.info('Vocal Booth closed: recording disarmed');
}

export async function boothRecord(): Promise<void> {
  await stopListening();
  if (!useLiveInput.getState().record.armed && !(await setArmed(true))) return;
  noteStart();
  set({ phase: 'starting', error: null, take: null });
  try {
    const r = await window.krypt.engine.transport('play');
    if (!r.ok) fail(r.message || "The audio engine didn't start");
  } catch (err) {
    fail((err as Error)?.message ?? "The audio engine didn't start");
  }
}

export async function boothStop(): Promise<void> {
  const counting = useBooth.getState().phase === 'countIn';
  set({ phase: 'saving' });
  await window.krypt.engine.transport('stop').catch(() => undefined);
  if (counting) {
    set({ phase: 'ready' });
    toast.info('Stopped during the count-in: nothing was recorded');
    return;
  }
  await collectTake();
}

export async function collectTake(): Promise<void> {
  set({ phase: 'saving' });
  let message = '';
  for (let i = 0; i < 100; i++) {
    const t = useLiveInput.getState().record.lastTake;
    if (t && t.id !== lastTakeId) {
      message = t.message;
      break;
    }
    await wait(150);
  }
  let found = newAudioTakes(getProject(), before)[0];
  for (let i = 0; i < 10 && !found; i++) {
    await wait(150);
    found = newAudioTakes(getProject(), before)[0];
  }
  if (!found) return fail(message ? `No take was added: ${message}` : 'No audio was recorded. Check your microphone in Home ▸ Recording Studio, then try again.');
  const clip = getProject().playlist.clips[found.clipId];
  await setArmed(false);
  set({ phase: 'review', take: { clipId: found.clipId, channelId: found.channelId, start: clip?.start ?? 0, length: clip?.length ?? 0, seconds: found.seconds }, error: null });
}

async function stopListening(): Promise<void> {
  if (listenTimer) clearTimeout(listenTimer);
  listenTimer = null;
  if (!useBooth.getState().listening) return;
  set({ listening: false });
  await window.krypt.engine.transport('stop').catch(() => undefined);
}

export async function boothListen(): Promise<void> {
  const take = useBooth.getState().take;
  if (!take) return;
  if (useBooth.getState().listening) return stopListening();
  await setArmed(false);
  await window.krypt.engine.locate(take.start);
  const r = await window.krypt.engine.transport('play').catch((e) => ({ ok: false, message: String(e) }));
  if (!r.ok) return void toast.error(r.message || "Couldn't play the take");
  set({ listening: true });
  listenTimer = setTimeout(() => void stopListening(), ((take.seconds ?? 8) + 0.6) * 1000);
}

export async function boothRedo(): Promise<void> {
  const take = useBooth.getState().take;
  if (!take) return;
  await stopListening();
  const r = await dispatch('channels.remove', { ids: [take.channelId] }, { label: 'Redo the take' });
  if (!r.ok) return;
  set({ take: null });
  await window.krypt.engine.locate(take.start);
  await boothRecord();
}

export async function boothMore(): Promise<void> {
  const take = useBooth.getState().take;
  await stopListening();
  if (take) await window.krypt.engine.locate(nextBarTick(getProject(), take.start + take.length));
  set((s) => ({ take: null, kept: s.kept + (take ? 1 : 0), phase: 'ready', error: null }));
  await setArmed(true);
}

export async function boothTune(style: TuneStyle): Promise<void> {
  const take = useBooth.getState().take;
  if (!take || useBooth.getState().tuning) return;
  set({ tuning: true });
  const ok = await autoTuneVocal({ clipId: take.clipId }, style);
  set((s) => ({ tuning: false, tuned: ok ? style : s.tuned }));
}

export async function boothLoopBeat(): Promise<void> {
  const p = getProject();
  const steps = loopBeatSteps(p);
  if (!steps) {
    toast.warn(beatPattern(p) ? 'No free Playlist track for the beat: clear one, or paint the beat in yourself.' : 'There is no beat yet: make a pattern in the Channel Rack (F6) first.');
    return;
  }
  const name = p.patterns[beatPattern(p)!]?.name ?? 'the beat';
  const r = await dispatchBatch(steps, { label: 'Loop the beat for the vocal' });
  if (r.ok) {
    await window.krypt.engine.locate(0);
    toast.success(`Looped ${name} for ${LOOP_BARS} bars: record over it from bar 1`);
  }
}

export function followRecordState(prev: 'countIn' | 'recording' | null, rec: 'countIn' | 'recording' | null): void {
  const phase = useBooth.getState().phase;
  if (!prev && rec) {
    if (phase === 'ready' || phase === 'review') noteStart();
    if (phase === 'ready' || phase === 'starting' || phase === 'review') set({ phase: rec, take: null, error: null });
  } else if (prev && rec && prev !== rec && (phase === 'countIn' || phase === 'recording' || phase === 'starting')) {
    set({ phase: rec });
  } else if (prev && !rec && (phase === 'countIn' || phase === 'recording' || phase === 'starting')) {
    if (prev === 'countIn') {
      set({ phase: 'ready' });
      toast.info('Stopped during the count-in: nothing was recorded');
    } else void collectTake();
  }
}

export function takeLine(seconds: number | null, n: number): string {
  return `Take ${n}${seconds !== null ? ` · ${fmtTakeSeconds(seconds)}` : ''} on ${targetTrackName(getProject())}`;
}
