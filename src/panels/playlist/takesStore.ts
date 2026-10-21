import { create } from 'zustand';

export interface TakeLanesView {
  open: Record<string, boolean>;
  toggle: (trackId: string, on?: boolean) => void;
}

export const useTakeLanes = create<TakeLanesView>((set) => ({
  open: {},
  toggle: (trackId, on) => set((s) => ({ open: { ...s.open, [trackId]: on ?? !s.open[trackId] } })),
}));
