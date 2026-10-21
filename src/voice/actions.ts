import type { ActionResult } from '@shared/types';
import type { SingOutcome, SingRequest, SpeakOutcome, SpeakRequest, VoiceInfo } from '@shared/voice/types';
import { modal, toast } from '../app/notify';
import { wm } from '../workspace/WindowManager';
import { FISH_KEY_URL, doneLine, failureMessage, fishKeyError, isCancelMessage, needsKey, needsModel, pickVoice, type JobKind } from './logic';
import { getVoice, isBusy, setSing, setSpeak, useVoice } from './store';

let subscribed = false;

export async function ensureVoiceState(force = false): Promise<void> {
  const k = window.krypt?.voice;
  if (!k) {
    useVoice.setState({ status: 'failed', stateError: 'Krypt Voice needs the desktop app' });
    return;
  }
  if (!subscribed) {
    subscribed = true;
    try {
      k.onState((state) => {
        useVoice.setState({ state, status: 'ready', stateError: null });
        syncVoicePicks();
      });
    } catch {
    }
  }
  const s = getVoice();
  if (s.status === 'loading' || (s.status === 'ready' && !force)) return;
  useVoice.setState({ status: 'loading' });
  try {
    const state = await k.state();
    useVoice.setState({ state, status: 'ready', stateError: null });
    syncVoicePicks();
  } catch (err) {
    const msg = failureMessage(err, "Couldn't read the voices");
    useVoice.setState({ status: 'failed', stateError: msg });
    toast.error(`Krypt Voice: ${msg}`);
  }
}

function syncVoicePicks(): void {
  const s = getVoice();
  const sp = pickVoice(s.state, s.speak.voiceId);
  if (sp !== s.speak.voiceId) setSpeak({ voiceId: sp });
  const sg = pickVoice(s.state, s.sing.voiceId);
  if (sg !== s.sing.voiceId) setSing({ voiceId: sg });
}

export function openModelManager(): void {
  wm.open('modelManager');
  toast.info('Install Kokoro (Speech) in the Model Manager: one download, then local voices work offline.');
}

export function openVoiceSettings(): void {
  wm.open('settings');
  void import('../guides/show').then((m) => m.showGuideAnchor('settings.voice')).catch(() => undefined);
}

export async function openFishSite(): Promise<void> {
  try {
    const r = await window.krypt.app.openExternal(FISH_KEY_URL);
    if (!r.ok) toast.error(r.message || `Couldn't open ${FISH_KEY_URL}`);
    else toast.info('Sign in at Fish Audio, create an API key, then paste it in Settings ▸ Voice.');
  } catch (err) {
    toast.error(`Couldn't open the link: ${failureMessage(err)}`);
  }
}

async function playFile(path: string): Promise<void> {
  try {
    const r = await window.krypt.engine.previewFile(path);
    if (!r.ok) {
      useVoice.setState({ previewing: null });
      toast.error(`Couldn't play the preview: ${r.message ?? 'the audio engine is not running'}`);
      return;
    }
    useVoice.setState({ previewing: path });
  } catch (err) {
    useVoice.setState({ previewing: null });
    toast.error(`Couldn't play the preview: ${failureMessage(err)}`);
  }
}

export async function replayPreview(): Promise<void> {
  const o = getVoice().job?.outcome;
  if (!o?.path) {
    toast.info('Nothing to replay yet: press Preview first');
    return;
  }
  await playFile(o.path);
}

export async function stopPreview(): Promise<void> {
  useVoice.setState({ previewing: null });
  try {
    const r = await window.krypt.engine.stopPreview();
    if (!r.ok) toast.error(r.message || "Couldn't stop the preview");
  } catch (err) {
    toast.error(`Couldn't stop the preview: ${failureMessage(err)}`);
  }
}

const failureAction = (message: string): { action: { label: string; run: () => void } } | undefined =>
  needsModel(message)
    ? { action: { label: 'Model Manager', run: openModelManager } }
    : needsKey(message)
      ? { action: { label: 'Settings ▸ Voice', run: openVoiceSettings } }
      : undefined;

async function runJob<T extends SpeakOutcome>(kind: JobKind, preview: boolean, call: () => Promise<ActionResult<T>>, onDone?: (o: T) => void): Promise<T | null> {
  if (isBusy()) {
    toast.warn('Krypt Voice is already rendering: one at a time. Cancel it first to start another.');
    return null;
  }
  if (getVoice().previewing) void stopPreview();
  useVoice.setState({ job: { kind, preview, phase: 'running', progress: null, outcome: null, error: null } });
  let unsub: () => void = () => undefined;
  try {
    unsub = window.krypt.voice.onProgress((p) => {
      const j = getVoice().job;
      if (j && (j.phase === 'running' || j.phase === 'cancelling')) useVoice.setState({ job: { ...j, progress: p } });
    });
  } catch {
  }
  let r: ActionResult<T>;
  try {
    r = await call();
  } catch (err) {
    r = { ok: false, message: failureMessage(err) };
  } finally {
    unsub();
  }
  const j = getVoice().job ?? { kind, preview, phase: 'running' as const, progress: null, outcome: null, error: null };
  if (!r.ok || !r.data) {
    if (isCancelMessage(r.message)) {
      useVoice.setState({ job: { ...j, phase: 'cancelled', error: null } });
      toast.info(preview ? 'Preview cancelled' : 'Cancelled: nothing was added to your song');
      return null;
    }
    const message = failureMessage(r.message ?? '', r.ok ? 'Krypt Voice finished without a result' : undefined);
    useVoice.setState({ job: { ...j, phase: 'failed', error: message } });
    toast.error(`Krypt Voice: ${message}`, failureAction(message));
    return null;
  }
  const o = r.data;
  useVoice.setState({ job: { ...j, phase: 'done', outcome: o, progress: null } });
  onDone?.(o);
  const notes = o.notes?.length ? ` Good to know: ${o.notes[0]}` : '';
  if (preview) {
    await playFile(o.path);
    toast.info(`${doneLine(kind, o, true)}.${notes}`);
  } else toast.success(`${doneLine(kind, o, false)}. Undo removes it in one step.${notes}`, { durationMs: 8000 });
  return o;
}

export function runSpeak(req: SpeakRequest): Promise<SpeakOutcome | null> {
  return runJob('speak', !!req.preview, () => window.krypt.voice.speak(req));
}

export function runSing(req: SingRequest): Promise<SingOutcome | null> {
  return runJob<SingOutcome>('sing', !!req.preview, () => window.krypt.voice.sing(req), (o) => useVoice.setState({ lastMapping: Array.isArray(o.mapping) ? o.mapping : null }));
}

export async function cancelJob(): Promise<void> {
  const j = getVoice().job;
  if (!j || j.phase !== 'running') return;
  useVoice.setState({ job: { ...j, phase: 'cancelling' } });
  const back = (): void => {
    const now = getVoice().job;
    if (now?.phase === 'cancelling') useVoice.setState({ job: { ...now, phase: 'running' } });
  };
  try {
    const r = await window.krypt.voice.cancel();
    if (!r.ok) {
      back();
      toast.error(r.message || "Couldn't cancel Krypt Voice");
    }
  } catch (err) {
    back();
    toast.error(`Couldn't cancel: ${failureMessage(err)}`);
  }
}

export async function saveFishKey(key: string | null): Promise<{ ok: boolean; message: string }> {
  if (key !== null) {
    const bad = fishKeyError(key);
    if (bad) {
      toast.warn(bad);
      return { ok: false, message: bad };
    }
  } else {
    const yes = await modal.confirm({
      title: 'Remove the Fish Audio key?',
      message: 'Cloud voices and My voice stop working until you add a key again. Your cloned voice stays on your Fish Audio account until you remove it.',
      confirmLabel: 'Remove key',
      destructive: true,
    });
    if (!yes) return { ok: false, message: 'Kept the key' };
  }
  let r: ActionResult;
  try {
    r = await window.krypt.voice.setFishKey(key === null ? null : key.trim());
  } catch (err) {
    r = { ok: false, message: failureMessage(err) };
  }
  const message = r.ok ? r.message || (key === null ? 'Fish Audio key removed' : 'Key works: saved, encrypted on this PC') : failureMessage(r.message ?? '', "Fish Audio didn't accept the key");
  if (r.ok) toast.success(message);
  else toast.error(`Fish Audio key: ${message}`);
  void ensureVoiceState(true);
  return { ok: r.ok, message };
}

export async function removeMyVoice(v: VoiceInfo): Promise<boolean> {
  const yes = await modal.confirm({
    title: `Remove "${v.name}"?`,
    message: 'Deletes your cloned voice from your Fish Audio account and from Krypt Studio. Clips you already made with it stay in your songs.',
    confirmLabel: 'Remove voice',
    destructive: true,
  });
  if (!yes) return false;
  try {
    const r = await window.krypt.voice.removeMyVoice(v.id);
    if (!r.ok) {
      toast.error(`Couldn't remove ${v.name}: ${failureMessage(r.message ?? '')}`);
      return false;
    }
    toast.success(r.message || `Removed ${v.name}`);
    void ensureVoiceState(true);
    return true;
  } catch (err) {
    toast.error(`Couldn't remove ${v.name}: ${failureMessage(err)}`);
    return false;
  }
}
