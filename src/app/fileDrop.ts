import { toast } from './notify';
import { importMidi, openProject } from './actions';
import { AUDIO_FILE_RE } from '@shared/audio/formats';

export const AUDIO_EXT = AUDIO_FILE_RE;
export const PROJECT_EXT = /\.kstudio$/i;
export const MIDI_EXT = /\.midi?$/i;

export function hasFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}

export function droppedPaths(dt: DataTransfer): string[] {
  const out: string[] = [];
  for (const f of Array.from(dt.files)) {
    let p = '';
    try {
      p = window.krypt.app.pathForFile?.(f) ?? '';
    } catch {
      p = '';
    }
    if (p) out.push(p);
  }
  if (!out.length && dt.files.length) toast.info('Dropping files from Explorer works in the desktop app. Here, drag samples from the Browser panel.');
  return out;
}

export async function handleOsDrop(dt: DataTransfer, onAudio: (paths: string[]) => Promise<unknown> | unknown): Promise<void> {
  const paths = droppedPaths(dt);
  if (!paths.length) return;
  const audio = paths.filter((p) => AUDIO_EXT.test(p));
  const project = paths.find((p) => PROJECT_EXT.test(p));
  const midi = paths.filter((p) => MIDI_EXT.test(p));
  const other = paths.filter((p) => !AUDIO_EXT.test(p) && !PROJECT_EXT.test(p) && !MIDI_EXT.test(p));
  if (project) {
    await openProject(project);
    return;
  }
  if (audio.length) await onAudio(audio);
  for (const m of midi) await importMidi(m);
  if (other.length) toast.warn(`Can't use ${other.map((p) => p.split(/[\\/]/).pop()).join(', ')}: drop audio, .kstudio or .mid files`);
}
