import { create } from 'zustand';
import type { SimilarSource } from '@shared/types';
import { wm } from '../workspace/WindowManager';

export interface SimilarRequest {
  source: SimilarSource;
  name: string;
  nonce: number;
}

export const useSimilar = create<{ request: SimilarRequest | null }>(() => ({ request: null }));

export function openSimilar(source: SimilarSource, name: string): void {
  useSimilar.setState({ request: { source, name, nonce: Date.now() } });
  wm.open('browser');
}

export function closeSimilar(): void {
  useSimilar.setState({ request: null });
}
