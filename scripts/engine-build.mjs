// Build the Rust engine workspace and stage its outputs for Electron.
//
//   node scripts/engine-build.mjs           release build
//   node scripts/engine-build.mjs --debug   debug build (faster compile)
//
// Steps (any failure exits non-zero with a clear message):
//   1. cargo build --manifest-path engine/Cargo.toml --workspace [--release]
//      (run from the repo root so .cargo/config.toml's static CRT applies)
//   2. copy krypt-studio-engine.exe (+ krypt-studio-mcp.exe, -pluginhost.exe, -analyzer.exe if built) → resources/bin/
//   3. --dump-catalog → shared/plugins/catalog.gen.json (only if it has plugins)
//   4. --gen-factory resources/factory (legacy kit + sound library + index.json; fails without a usable index)
//   5. scripts/fingerprints.mjs → resources/factory/fingerprints.json (warn-only: a failure keeps the old index)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const debug = process.argv.includes('--debug');
const profile = debug ? 'debug' : 'release';
const exe = process.platform === 'win32' ? '.exe' : '';
const started = Date.now();
const summary = [];
const warnings = [];

function fail(msg, hint) {
  console.error(`\n✖ engine-build failed: ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

function step(title) {
  console.log(`\n▸ ${title}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts });
  if (r.error) {
    if (r.error.code === 'ENOENT') fail(`'${cmd}' was not found`, cmd === 'cargo' ? 'Install the Rust toolchain (https://rustup.rs, stable MSVC) and reopen the terminal.' : undefined);
    fail(`could not run ${cmd}: ${r.error.message}`);
  }
  return r;
}

const mb = (p) => `${(statSync(p).size / (1024 * 1024)).toFixed(2)} MB`;

// 1. Build ─────────────────────────────────────────────────────────────────
step(`cargo build (${profile}, workspace)`);
{
  const args = ['build', '--manifest-path', path.join('engine', 'Cargo.toml'), '--workspace'];
  if (!debug) args.push('--release');
  const r = run('cargo', args, { stdio: 'inherit' });
  if (r.status !== 0) fail(`cargo build exited with code ${r.status}`, 'See the compiler output above.');
}

// 2. Stage binaries ────────────────────────────────────────────────────────
step('copy binaries → resources/bin/');
const targetDir = path.join(root, 'engine', 'target', profile);
const binDir = path.join(root, 'resources', 'bin');
mkdirSync(binDir, { recursive: true });
const engineSrc = path.join(targetDir, `krypt-studio-engine${exe}`);
if (!existsSync(engineSrc)) fail(`${path.relative(root, engineSrc)} was not produced by the build`);
const stage = (name, required) => {
  const src = path.join(targetDir, name);
  if (!existsSync(src)) {
    if (required) fail(`${name} is missing from ${path.relative(root, targetDir)}`);
    warnings.push(`${name} was not built; skipped`);
    return null;
  }
  const dst = path.join(binDir, name);
  try {
    copyFileSync(src, dst);
  } catch (e) {
    fail(`cannot copy ${name} to resources/bin (${e.code ?? e.message})`, 'Is Krypt Studio (or the engine) still running? Close it and retry.');
  }
  summary.push(`${name.padEnd(26)} ${mb(dst)}`);
  return dst;
};
const engineBin = stage(`krypt-studio-engine${exe}`, true);
stage(`krypt-studio-mcp${exe}`, false);
// Sandboxed VST3/CLAP host; packaged via resources/bin/*.exe. Windows-only for now (electron/plugins/index.ts).
if (process.platform === 'win32') stage(`krypt-studio-pluginhost${exe}`, false);
stage(`krypt-studio-analyzer${exe}`, false); // on-device audio ML sidecar (analyze / transcribe / separate)
// Bundled models (Basic Pitch, Beat This! small) are committed under resources/models/<id>/ and packaged from
// there (package.json build.extraResources "models/**"); check they're present.
{
  const modelsDir = path.join(root, 'resources', 'models');
  for (const id of ['basic-pitch', 'beat-this-small']) {
    const dir = path.join(modelsDir, id);
    const onnx = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.onnx')) : [];
    if (onnx.length === 0) warnings.push(`resources/models/${id} has no .onnx files; the analyzer will report the model as missing`);
    else if (!existsSync(path.join(dir, 'LICENSE'))) warnings.push(`resources/models/${id}/LICENSE is missing (it must ship with the model)`);
    else summary.push(`models/${id}`.padEnd(27) + onnx.map((f) => `${f} ${mb(path.join(dir, f))}`).join(', '));
  }
}
// ONNX Runtime + DirectML + VC++ runtime DLLs for the analyzer's stem separation (warns, never fails).
{
  const { stageOnnxRuntime } = await import('./models/onnxruntime.mjs');
  const r = await stageOnnxRuntime({ binDir });
  summary.push(...r.summary);
  warnings.push(...r.warnings);
}

// 3. Plugin catalog ────────────────────────────────────────────────────────
step('dump plugin catalog');
{
  const r = run(engineBin, ['--dump-catalog']);
  if (r.status !== 0) fail(`--dump-catalog exited with code ${r.status}`, r.stderr?.trim());
  let catalog;
  try {
    catalog = JSON.parse(r.stdout);
  } catch (e) {
    fail(`--dump-catalog printed invalid JSON: ${e.message}`);
  }
  if (!catalog || !Array.isArray(catalog.plugins)) fail('--dump-catalog output has no "plugins" array');
  const out = path.join(root, 'shared', 'plugins', 'catalog.gen.json');
  if (catalog.plugins.length === 0) {
    warnings.push('engine reports 0 plugins (DSP crate not implemented yet?); kept the existing catalog.gen.json seed');
    summary.push(`catalog.gen.json           kept seed (engine reported 0 plugins)`);
  } else {
    const ids = new Set();
    for (const p of catalog.plugins) {
      if (!p || typeof p.id !== 'string' || !Array.isArray(p.params)) fail(`catalog entry without id/params: ${JSON.stringify(p).slice(0, 120)}`);
      if (ids.has(p.id)) fail(`duplicate plugin id in catalog: ${p.id}`);
      ids.add(p.id);
    }
    const text = JSON.stringify({ version: catalog.version ?? 1, plugins: catalog.plugins }, null, 2) + '\n';
    const tmp = `${out}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, out);
    const inst = catalog.plugins.filter((p) => p.kind === 'instrument').length;
    summary.push(`catalog.gen.json           ${catalog.plugins.length} plugins (${inst} instruments, ${catalog.plugins.length - inst} effects)`);
  }
}

// 4. Factory sounds ──────────────────────────────────────────────────────
step('generate factory sounds → resources/factory/');
{
  const factoryDir = path.join(root, 'resources', 'factory');
  mkdirSync(factoryDir, { recursive: true });
  const r = run(engineBin, ['--gen-factory', factoryDir]);
  if (r.status !== 0) fail(`--gen-factory exited with code ${r.status}`, r.stderr?.trim());
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    fail('--gen-factory printed invalid JSON', r.stdout?.slice(0, 200));
  }
  if (!out?.ok) fail('--gen-factory did not report success', r.stdout?.slice(0, 200));
  // index.json (FactoryIndex, shared/sounds/types.ts) must exist, list samples, and every file must be on disk
  const indexPath = path.join(factoryDir, 'index.json');
  if (!existsSync(indexPath)) fail('resources/factory/index.json was not written', 'The engine binary predates the factory library; rebuild it.');
  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (e) {
    fail(`resources/factory/index.json is not valid JSON: ${e.message}`);
  }
  const samples = Array.isArray(index?.samples) ? index.samples : [];
  if (samples.length === 0) fail('resources/factory/index.json lists no samples');
  const fileOf = (s) => path.join(factoryDir, ...String(s?.path ?? '').replace(/^factory:/, '').split('/'));
  const missing = samples.filter((s) => typeof s?.path !== 'string' || !s.path.startsWith('factory:') || !existsSync(fileOf(s)));
  if (missing.length) fail(`${missing.length} indexed factory samples are missing on disk, e.g. ${missing[0]?.path}`);
  // counts per top folder + total size (MB = MiB, like the other lines)
  const folders = new Map();
  let total = statSync(indexPath).size;
  for (const s of samples) {
    const top = s.path.replace(/^factory:/, '').split('/')[0];
    const size = statSync(fileOf(s)).size;
    const f = folders.get(top) ?? { files: 0, bytes: 0 };
    f.files += 1;
    f.bytes += size;
    folders.set(top, f);
    total += size;
  }
  const MB = 1024 * 1024;
  const secs = typeof out.seconds === 'number' ? ` in ${out.seconds.toFixed(1)} s` : '';
  summary.push(`resources/factory          ${samples.length} samples, ${(total / MB).toFixed(1)} MB${secs} (${index.generator ?? 'unknown generator'})`);
  for (const [top, f] of folders) summary.push(`  factory/${top}`.padEnd(27) + `${String(f.files).padStart(4)} files ${(f.bytes / MB).toFixed(1).padStart(6)} MB`);
  if (out.removed > 0) summary.push(`  factory                  removed ${out.removed} stale file(s) from an older generation`);
  if (total > 45_000_000) warnings.push(`factory sounds total ${(total / 1e6).toFixed(1)} MB, over the 45 MB budget`);
}

// 5. Sound fingerprints (warn-only) ────────────────────────────────────────
// resources/factory/fingerprints.json for match_sounds (scripts/fingerprints.mjs): every preset rendered by the
// fresh engine and every factory sample measured by the fresh analyzer. A failure keeps the previous index.
step('fingerprint presets + factory samples → resources/factory/fingerprints.json');
{
  const analyzerBin = path.join(targetDir, `krypt-studio-analyzer${exe}`);
  if (!existsSync(analyzerBin)) warnings.push('fingerprints.json not regenerated: krypt-studio-analyzer was not built');
  else {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'fingerprints.mjs'), '--engine', engineBin, '--analyzer', analyzerBin], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const last = (s) => (s ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
    if (r.error || r.status !== 0) warnings.push(`fingerprints.json not regenerated (match_sounds keeps the previous index): ${last(r.stderr) || last(r.stdout) || r.error?.message || `exit ${r.status}`}`);
    else summary.push(`fingerprints.json          ${last(r.stdout).replace(/^✔\s*resources[\\/]factory[\\/]fingerprints\.json:\s*/, '')}`);
  }
}

// Summary ──────────────────────────────────────────────────────────────────
const version = run(engineBin, ['--version']).stdout?.trim() ?? '?';
console.log(`\n✔ engine-build (${profile}) finished in ${((Date.now() - started) / 1000).toFixed(1)} s — ${version}`);
for (const s of summary) console.log(`  ${s}`);
for (const w of warnings) console.warn(`  ⚠ ${w}`);
