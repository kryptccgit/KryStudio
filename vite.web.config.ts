// Browser-only dev server (no Electron): `npm run dev:web` → http://localhost:5191.
// main.tsx installs the in-page mock (src/dev/mockKrypt.ts) when window.krypt
// is missing, so the real DocHost/commands drive the UI. Engine calls are stubs.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(__dirname, 'shared') } },
  worker: { format: 'es' },
  server: {
    port: 5191,
    strictPort: true,
    watch: { ignored: ['**/engine/**', '**/resources/bin/**', '**/test/.out/**', '**/release/**'] },
  },
  clearScreen: false,
});
