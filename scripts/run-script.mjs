// Run a TypeScript script that imports @shared/* : bundles with esbuild, runs with node.
// Usage: node scripts/run-script.mjs <file.ts> [args...]
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const entry = path.resolve(process.argv[2]);
const outDir = path.join(root, 'test', '.out');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, path.basename(entry).replace(/\.ts$/, '.script.mjs'));
await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile,
  alias: { '@shared': path.join(root, 'shared') }, logLevel: 'error',
  define: { 'import.meta.dirname': JSON.stringify(path.dirname(entry)) },
});
const r = spawnSync(process.execPath, [outfile, ...process.argv.slice(3)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
