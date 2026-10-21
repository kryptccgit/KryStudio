export const NATIVE_AUDIO_EXTENSIONS: readonly string[] = ['wav', 'wave', 'aif', 'aiff', 'aifc', 'flac', 'mp3', 'ogg', 'oga'];

export const MF_AUDIO_EXTENSIONS: readonly string[] = ['m4a', 'm4b', 'mp4', 'aac', 'adts', '3gp', '3g2', 'wma', 'asf', 'ac3', 'ec3', 'amr'];

export const AUDIO_EXTENSIONS: readonly string[] = [...NATIVE_AUDIO_EXTENSIONS, ...MF_AUDIO_EXTENSIONS];

export const AUDIO_FILE_RE = new RegExp(`\\.(${AUDIO_EXTENSIONS.join('|')})$`, 'i');

export function isAudioFile(nameOrPath: string): boolean {
  return AUDIO_FILE_RE.test(nameOrPath);
}
