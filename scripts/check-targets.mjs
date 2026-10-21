// Type-check the engine workspace for macOS and Linux from any OS, so a Windows-only API or a missing
// `cfg(windows)` gate shows up before CI. `cargo check` never links, and KRYPT_CHECK_ONLY=1 makes
// engine/crates/stretch/build.rs skip its C++ compile (the host can't build C++ for another OS).
//
//   node scripts/check-targets.mjs          (npm run engine:check-targets)
//
// Needs the targets once: rustup target add aarch64-apple-darwin x86_64-unknown-linux-gnu
// Linux: the `engine` crate needs ALSA headers (alsa-sys), which only a Linux host has, so elsewhere it is
// skipped for that target and every other crate is checked.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = path.join('engine', 'Cargo.toml');
const targetDir = path.join('engine', 'target-check');
const env = { ...process.env, KRYPT_CHECK_ONLY: '1' };
const LINUX_ONLY_ON_LINUX = ['krypt-studio-engine'];

const targets = [
  { triple: 'aarch64-apple-darwin', args: ['--workspace'] },
  {
    triple: 'x86_64-unknown-linux-gnu',
    args: process.platform === 'linux' ? ['--workspace'] : ['--workspace', ...LINUX_ONLY_ON_LINUX.flatMap((p) => ['--exclude', p])],
  },
];

let failed = 0;
for (const t of targets) {
  console.log(`\n▸ cargo check --target ${t.triple}`);
  const r = spawnSync('cargo', ['check', '--manifest-path', manifest, ...t.args, '--all-targets', '--target', t.triple, '--target-dir', targetDir], { cwd: root, env, stdio: 'inherit' });
  if (r.error) {
    console.error(`✖ could not run cargo: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    failed++;
    console.error(`✖ ${t.triple} failed (missing target? rustup target add ${t.triple})`);
  }
}
if (failed) process.exit(1);
console.log('\n✔ engine type-checks for macOS and Linux');
