import type { ActionResult, AudioTarget } from '@shared/types';
import { TUNE_STYLES, type TuneStyle } from '@shared/music/keymatch';
import { getProject } from '../doc/store';
import { toast } from '../app/notify';
import { flashHint } from '../app/hints';
import { cautionsIn, matchSentence, targetName, tuneSentence } from './logic';

async function call<T>(what: string, fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, message: `${what} failed: ${(err as Error)?.message ?? String(err)}` };
  }
}

function done(sentence: string, message: string | undefined): void {
  const cautions = cautionsIn(message);
  if (cautions.length) toast.warn(`${sentence}. ${cautions.join(' ')}`);
  else toast.success(sentence);
}

export async function autoTuneVocal(target: AudioTarget, style: TuneStyle): Promise<boolean> {
  const name = targetName(getProject(), target);
  flashHint(`Tuning ${name} (${TUNE_STYLES[style].label}): finding its key…`, 'info', 4000);
  const r = await call('Tune vocal', () => window.krypt.vocals.tune(target, { style }));
  if (!r.ok || !r.data) {
    toast.error(r.message || `Couldn't tune ${name}`);
    return false;
  }
  done(tuneSentence(name, r.data), r.message);
  return true;
}

export async function matchClipTo(clipId: string, to: 'project' | { clipId: string }): Promise<boolean> {
  const p = getProject();
  const name = targetName(p, { clipId });
  const toName = to === 'project' ? 'the project' : targetName(p, to);
  flashHint(`Matching ${name} to ${toName}: reading keys and tempos…`, 'info', 4000);
  const r = await call('Match key & tempo', () => window.krypt.vocals.match(clipId, { to }));
  if (!r.ok || !r.data) {
    toast.error(r.message || `Couldn't match ${name} to ${toName}`);
    return false;
  }
  done(matchSentence(name, r.data, toName), r.message);
  return true;
}
