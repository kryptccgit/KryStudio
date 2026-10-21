import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import path from 'node:path';

// Content-Security-Policy for the packaged app only (dev keeps Vite/HMR working).
// connect-src allows the engine's telemetry WebSocket on 127.0.0.1 (random port).
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' ws://127.0.0.1:* data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
  return {
    name: 'krypt-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('</head>', `    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n  </head>`);
    },
  };
}

// Main + preload are bundled by vite-plugin-electron. discord-rpc is CommonJS
// with a native-ish transport and MUST stay external (house rule).
// Release builds (`vite build`) minify main + preload too (kryptguidelines §9.7:
// minified bundles, no source maps in the package; electron-builder's files
// filter drops *.map). keepNames keeps class/function names for error messages.
// Dev (`vite`) stays unminified for readable stack traces.
const release = process.argv.includes('build');
const mainMinify = release ? { minify: true as const } : {};
const mainEsbuild = release ? { esbuild: { keepNames: true } } : {};

export default defineConfig({
  plugins: [
    cspPlugin(),
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          ...mainEsbuild,
          resolve: { alias: { '@shared': path.resolve(__dirname, 'shared') } },
          build: {
            outDir: 'dist-electron',
            sourcemap: true,
            ...mainMinify,
            rollupOptions: { external: ['discord-rpc'] },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          ...mainEsbuild,
          resolve: { alias: { '@shared': path.resolve(__dirname, 'shared') } },
          build: { outDir: 'dist-electron', sourcemap: true, ...mainMinify },
        },
      },
    ]),
  ],
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'shared') },
  },
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        popout: path.resolve(__dirname, 'popout.html'),
      },
    },
  },
  server: {
    port: 5190,
    strictPort: true,
    // cargo rewrites engine/target while Vite runs → EBUSY crashes in the watcher.
    watch: { ignored: ['**/engine/**', '**/resources/bin/**', '**/test/.out/**', '**/release/**'] },
  },
  clearScreen: false,
});
