// Audio file formats Krypt Studio reads: ONE list for every import path
// (playlist / rack drops, Browser, sample dialogs, agent sample paths, the
// analyzer, the reference library). Mirrors krypt_studio_dsp::decode:
// symphonia decodes the royalty-free formats on every machine; Windows Media
// Foundation decodes the rest with the OS's own codecs (absent on Windows N
// editions without the Media Feature Pack — those files then fail with a
// sentence saying so).

/** Decoded by symphonia (bundled, royalty-free formats). */
export const NATIVE_AUDIO_EXTENSIONS: readonly string[] = ['wav', 'wave', 'aif', 'aiff', 'aifc', 'flac', 'mp3', 'ogg', 'oga'];

/** Decoded by Windows Media Foundation (AAC / ALAC in MP4 containers, WMA, AC-3 …). Audio containers of dsp's MF_EXTENSIONS. */
export const MF_AUDIO_EXTENSIONS: readonly string[] = ['m4a', 'm4b', 'mp4', 'aac', 'adts', '3gp', '3g2', 'wma', 'asf', 'ac3', 'ec3', 'amr'];

export const AUDIO_EXTENSIONS: readonly string[] = [...NATIVE_AUDIO_EXTENSIONS, ...MF_AUDIO_EXTENSIONS];

/** Matches a file name or path with a supported audio extension. */
export const AUDIO_FILE_RE = new RegExp(`\\.(${AUDIO_EXTENSIONS.join('|')})$`, 'i');

export function isAudioFile(nameOrPath: string): boolean {
  return AUDIO_FILE_RE.test(nameOrPath);
}
