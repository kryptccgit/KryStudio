import { registerCommands } from '../../input/commands';
import { flashHint } from '../../app/hints';
import { openPanel } from '../../editors/selection';
import { getActivePianoRoll } from './active';
import type { PianoRollController } from './controller';
import { quickTools, toolDialogs } from './toolDialogs';
import { openGenerateDialog } from './generateDialog';
import { openScriptsDialog } from './scriptsDialog';
import { openSingDialog } from '../../voice/SingDialog';

function withRoll(fn: (ctl: PianoRollController) => unknown): () => unknown {
  return () => {
    const ctl = getActivePianoRoll();
    if (!ctl) {
      openPanel('pianoRoll');
      flashHint('Open the Piano Roll first, then run the tool again', 'warn');
      return;
    }
    return fn(ctl);
  };
}

let registered = false;

export function registerPianoRollCommands(): void {
  if (registered) return;
  registered = true;
  registerCommands([
    { id: 'pianoRoll.generate', label: 'Piano roll: Generate…', run: withRoll(openGenerateDialog) },
    { id: 'pianoRoll.scripts', label: 'Piano roll: Scripts…', run: withRoll(openScriptsDialog) },
    { id: 'pianoRoll.sing', label: 'Piano roll: Sing my notes…', run: withRoll(openSingDialog) },
    { id: 'pianoRoll.quantize', label: 'Piano roll: Quantize…', run: withRoll(toolDialogs.quantize) },
    { id: 'pianoRoll.chop', label: 'Piano roll: Chop…', run: withRoll(toolDialogs.chop) },
    { id: 'pianoRoll.quickChop', label: 'Piano roll: Quick chop', run: withRoll(quickTools.quickChop) },
    { id: 'pianoRoll.glue', label: 'Piano roll: Glue', run: withRoll(quickTools.glue) },
    { id: 'pianoRoll.legato', label: 'Piano roll: Legato', run: withRoll(quickTools.legato) },
    { id: 'pianoRoll.strum', label: 'Piano roll: Strum…', run: withRoll(toolDialogs.strum) },
    { id: 'pianoRoll.arpeggiate', label: 'Piano roll: Arpeggiate…', run: withRoll(toolDialogs.arpeggiate) },
    { id: 'pianoRoll.randomize', label: 'Piano roll: Randomize…', run: withRoll(toolDialogs.randomize) },
    { id: 'pianoRoll.flipH', label: 'Piano roll: Flip horizontally', run: withRoll(quickTools.flipH) },
    { id: 'pianoRoll.flipV', label: 'Piano roll: Flip vertically', run: withRoll(quickTools.flipV) },
    { id: 'pianoRoll.limit', label: 'Piano roll: Limit key range…', run: withRoll(toolDialogs.limit) },
    { id: 'pianoRoll.levels', label: 'Piano roll: Levels (ramp / LFO)…', run: withRoll(toolDialogs.levels) },
    { id: 'pianoRoll.scaleSnap', label: 'Piano roll: Snap to scale', run: withRoll(quickTools.scaleSnap) },
    { id: 'pianoRoll.toggleMute', label: 'Piano roll: Mute / unmute notes', run: withRoll(quickTools.toggleMute) },
    { id: 'pianoRoll.toggleSlide', label: 'Piano roll: Slide on / off', run: withRoll(quickTools.toggleSlide) },
  ]);
}
