// "More like this": which sound the Browser's similar list is showing. Any sound row (Browser samples, preset rows)
// opens it with openSimilar(); the Browser renders the list (src/panels/browser/SimilarList.tsx).

import { create } from 'zustand';
import type { SimilarSource } from '@shared/types';
import { wm } from '../workspace/WindowManager';

export interface SimilarRequest {
  source: SimilarSource;
  /** Display name of the source ("Punchy Kick"). */
  name: string;
  nonce: number;
}

export const useSimilar = create<{ request: SimilarRequest | null }>(() => ({ request: null }));

/** Show the sounds most like this one in the Browser (opens the Browser if it is closed). */
export function openSimilar(source: SimilarSource, name: string): void {
  useSimilar.setState({ request: { source, name, nonce: Date.now() } });
  wm.open('browser');
}

export function closeSimilar(): void {
  useSimilar.setState({ request: null });
}
