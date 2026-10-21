// Piano-roll view state (not undoable, not in the document). Module-level so
// it survives dockview remounts / popouts.

import { create } from 'zustand';
import { TICKS_PER_STEP } from '@shared/schema/time';
import type { SnapId } from '../../editors/snap';
import type { EditTool } from '../../editors/tools';

export type LaneProp = 'vel' | 'pan' | 'release' | 'fine' | 'modX' | 'modY';

export const LANE_PROPS: Record<LaneProp, { label: string; short: string; min: number; max: number; def: number; centered: boolean; int?: boolean }> = {
  vel: { label: 'Velocity', short: 'Vel', min: 0, max: 1, def: 0.78, centered: false },
  pan: { label: 'Pan', short: 'Pan', min: -1, max: 1, def: 0, centered: true },
  release: { label: 'Release', short: 'Rel', min: 0, max: 1, def: 0.5, centered: false },
  fine: { label: 'Fine pitch', short: 'Fine', min: -100, max: 100, def: 0, centered: true, int: true },
  modX: { label: 'Mod X', short: 'ModX', min: 0, max: 1, def: 0.5, centered: false },
  modY: { label: 'Mod Y', short: 'ModY', min: 0, max: 1, def: 0.5, centered: false },
};

export const PR_TOOLS: EditTool[] = ['draw', 'paint', 'delete', 'mute', 'select', 'slice'];

export interface PianoRollView {
  tool: EditTool;
  snap: SnapId;
  /** Scale highlight: pitch class root + scale id, or 'off'. */
  scaleRoot: number;
  scale: string;
  ghosts: boolean;
  /** Chord stamp quality ('' = single note). */
  chord: string;
  lane: LaneProp;
  laneH: number;
  /** Last used note length (FL: new notes take it). */
  lastLen: number;
  /** Page-scroll to keep the playhead in view while playing. */
  follow: boolean;
  /** FL look: notes in their colour group, velocity as opacity (off = velocity colour ramp). */
  velAlpha: boolean;
  /** Colour group (0..15) for newly drawn notes. */
  noteColor: number;
  /** New notes are slide notes (they glide from the previous note). */
  slideMode: boolean;
  set: (patch: Partial<Omit<PianoRollView, 'set'>>) => void;
}

export const usePianoRollView = create<PianoRollView>((set) => ({
  tool: 'draw',
  snap: 'step',
  scaleRoot: 0,
  scale: 'off',
  ghosts: true,
  chord: '',
  lane: 'vel',
  laneH: 96,
  lastLen: TICKS_PER_STEP,
  follow: true,
  velAlpha: true,
  noteColor: 0,
  slideMode: false,
  set: (patch) => set(patch),
}));
