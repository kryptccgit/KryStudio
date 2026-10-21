/// <reference types="vite/client" />
import type { KryptApi } from '@shared/types';

declare global {
  interface Window {
    krypt: KryptApi;
  }
}

export {};
