import { create } from 'zustand';
import type { TuneStyle } from '@shared/music/keymatch';
import type { BoothPhase, BoothTake } from './logic';

export interface BoothState {
  open: boolean;
  phase: BoothPhase;
  take: BoothTake | null;
  kept: number;
  tuned: TuneStyle | null;
  tuning: boolean;
  listening: boolean;
  error: string | null;
}

export const useBooth = create<BoothState>(() => ({ open: false, phase: 'ready', take: null, kept: 0, tuned: null, tuning: false, listening: false, error: null }));
