import type { CommandDef } from './types';
import { NOTE_COMMANDS } from './notes';
import { PATTERN_COMMANDS } from './patterns';
import { CHANNEL_COMMANDS } from './channels';
import { MIXER_COMMANDS } from './mixer';
import { PLAYLIST_COMMANDS } from './playlist';
import { MISC_COMMANDS } from './misc';
import { NOTE_TOOL_COMMANDS } from './noteTools';
import { RACK_COMMANDS } from './rack';
import { ARRANGE_COMMANDS } from './arrange';
import { PLUGIN_COMMANDS } from './plugins';
import { AUDIO_COMMANDS } from './audio';
import { PRESET_COMMANDS } from './presets';
import { GENERATE_COMMANDS } from './generate';
import { DEVICE_RACK_COMMANDS } from './racks';
import { SESSION_COMMANDS } from './session';
import { WARP_COMMANDS } from './warp';
import { MARKER_COMMANDS } from './markers';
import { FADE_COMMANDS } from './fades';
import { SCRIPT_COMMANDS } from './scripts';
import { TAKES_COMMANDS } from './takes';
import { SLICER_COMMANDS } from './slicer';
import { RECORDING_COMMANDS } from './recording';

const ALL: CommandDef[] = [
  ...NOTE_COMMANDS,
  ...PATTERN_COMMANDS,
  ...CHANNEL_COMMANDS,
  ...MIXER_COMMANDS,
  ...PLAYLIST_COMMANDS,
  ...MISC_COMMANDS,
  ...NOTE_TOOL_COMMANDS,
  ...RACK_COMMANDS,
  ...ARRANGE_COMMANDS,
  ...PLUGIN_COMMANDS,
  ...AUDIO_COMMANDS,
  ...PRESET_COMMANDS,
  ...GENERATE_COMMANDS,
  ...SESSION_COMMANDS,
  ...WARP_COMMANDS,
  ...DEVICE_RACK_COMMANDS,
  ...MARKER_COMMANDS,
  ...FADE_COMMANDS,
  ...SCRIPT_COMMANDS,
  ...TAKES_COMMANDS,
  ...SLICER_COMMANDS,
  ...RECORDING_COMMANDS,
] as CommandDef[];

export const COMMANDS: Record<string, CommandDef> = Object.fromEntries(ALL.map((c) => [c.id, c]));

export function getCommand(id: string): CommandDef | undefined {
  return COMMANDS[id];
}

export function listCommands(): CommandDef[] {
  return ALL;
}
