import { AUDIO_EXTENSIONS, AUDIO_FILE_RE } from '@shared/audio/formats';
import type { ActionResult } from '@shared/types';
import type { ReferenceSound } from '@shared/automix/types';
import { toast } from '../app/notify';
import { droppedPaths } from '../app/fileDrop';
import { NO_REFERENCE, failureMessage, fileLabel, type ReferenceState } from './logic';

export interface ReferenceSlot {
  get(): ReferenceState;
  set(r: ReferenceState): void;
  locked?(): string | null;
  guard?(path: string): string | null;
}

export interface ReferenceController {
  pick(): Promise<void>;
  use(path: string): Promise<void>;
  drop(dt: DataTransfer): void;
  clear(): void;
}

export function referenceController(slot: ReferenceSlot): ReferenceController {
  let seq = 0;
  const lockedSay = (): boolean => {
    const why = slot.locked?.();
    if (why) toast.warn(why);
    return !!why;
  };
  const use = async (path: string): Promise<void> => {
    if (lockedSay()) return;
    if (!AUDIO_FILE_RE.test(path)) {
      toast.warn(`"${fileLabel(path)}" isn't an audio file: pick a WAV, MP3, FLAC or other audio file as the reference`);
      return;
    }
    const mine = ++seq;
    const clash = slot.guard?.(path) ?? null;
    if (clash) {
      slot.set({ status: 'failed', path, sound: null, error: clash });
      toast.warn(clash);
      return;
    }
    slot.set({ status: 'busy', path, sound: null, error: null });
    let r: ActionResult<ReferenceSound>;
    try {
      r = await window.krypt.automix.analyzeReference(path);
    } catch (err) {
      r = { ok: false, message: failureMessage(err, "Couldn't read the reference") };
    }
    if (mine !== seq) return;
    if (!r.ok || !r.data) {
      const error = failureMessage(r.message ?? '', "Couldn't read the reference");
      slot.set({ status: 'failed', path, sound: null, error });
      toast.error(`Reference song: ${error}`);
      return;
    }
    slot.set({ status: 'ready', path, sound: r.data, error: null });
    toast.info(`Reference "${r.data.name}": ${r.data.summary}`);
  };
  return {
    use,
    async pick() {
      if (lockedSay()) return;
      let paths: string[] | null = null;
      try {
        paths = await window.krypt.dialog.openFile({ title: 'Pick a reference song (it is only measured)', filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS] }] });
      } catch (err) {
        toast.error(`Couldn't open the file dialog: ${failureMessage(err)}`);
        return;
      }
      if (!paths?.length) return;
      await use(paths[0]);
    },
    drop(dt) {
      const paths = droppedPaths(dt);
      if (!paths.length) return;
      const audio = paths.filter((p) => AUDIO_FILE_RE.test(p));
      if (!audio.length) {
        toast.warn('Drop an audio file (WAV, MP3, FLAC …) as the reference');
        return;
      }
      if (audio.length > 1) toast.info(`One reference at a time: using "${fileLabel(audio[0])}"`);
      void use(audio[0]);
    },
    clear() {
      if (lockedSay()) return;
      seq++;
      slot.set({ ...NO_REFERENCE });
      void stopReference();
    },
  };
}

export async function playReference(path: string, matchLufs: number | null): Promise<boolean> {
  try {
    await window.krypt.engine.transport('stop').catch(() => undefined);
    const r = await window.krypt.automix.playReference(path, matchLufs);
    if (!r.ok) {
      toast.error(r.message || "Couldn't play the reference");
      return false;
    }
    toast.info(r.message || 'Playing the reference');
    return true;
  } catch (err) {
    toast.error(`Couldn't play the reference: ${failureMessage(err)}`);
    return false;
  }
}

export async function stopReference(): Promise<void> {
  try {
    await window.krypt.engine.stopPreview();
  } catch {
  }
}
