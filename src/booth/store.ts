// The Vocal Booth's state (one booth per window). Logic: ./logic.ts; session: ./actions.ts; panel: ./VocalBooth.tsx.
import { create } from 'zustand';
import type { TuneStyle } from '@shared/music/keymatch';
import type { BoothPhase, BoothTake } from './logic';

export interface BoothState {
  open: boolean;
  phase: BoothPhase;
  /** The take being reviewed (phase 'review'). */
  take: BoothTake | null;
  /** Takes kept this session (the Record more counter). */
  kept: number;
  /** Krypt Tune style set on the Vocals insert this session, if any. */
  tuned: TuneStyle | null;
  tuning: boolean;
  /** Playing the take back (Listen). */
  listening: boolean;
  error: string | null;
}

export const useBooth = create<BoothState>(() => ({ open: false, phase: 'ready', take: null, kept: 0, tuned: null, tuning: false, listening: false, error: null }));
