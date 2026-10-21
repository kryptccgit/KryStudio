import { build } from 'esbuild';
import { readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'test', '.out');
mkdirSync(outDir, { recursive: true });
const only = process.argv[2];
const FILE_TIMEOUT_MS = 5 * 60_000;
const files = readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.ts') && (!only || f.includes(only)));
let failed = 0;
for (const f of files) {
  const outfile = path.join(outDir, f.replace(/\.ts$/, '.mjs'));
  await build({
    entryPoints: [path.join(root, 'test', f)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    alias: { '@shared': path.join(root, 'shared'), electron: path.join(root, 'test', 'electron-stub.ts') },
    logLevel: 'error',
    banner: { js: "import { createRequire as __kryptRequire } from 'node:module'; const require = __kryptRequire(import.meta.url);" },
  });
  const r = spawnSync(process.execPath, [outfile], { stdio: 'inherit', timeout: FILE_TIMEOUT_MS });
  if (r.error?.code === 'ETIMEDOUT') console.error(`✗ ${f}: still running after ${FILE_TIMEOUT_MS / 60_000} min; killed`);
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} test file(s) FAILED` : `\nall ${files.length} test file(s) passed`);
process.exit(failed ? 1 : 0);
