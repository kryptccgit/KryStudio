import { rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
for (const dir of ['dist', 'dist-electron']) {
  try {
    rmSync(path.join(root, dir), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    console.log(`clean-build: removed ${dir}/`);
  } catch (e) {
    console.error(`✖ clean-build: could not remove ${dir}/ (${e.code ?? e.message}). Is a dev instance of Krypt Studio running? Close it and retry.`);
    process.exit(1);
  }
}
