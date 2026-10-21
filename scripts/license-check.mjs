// Licence gate (research/05 §9.5 and §10). Fails on any shipped dependency
// whose licence is not on the allowlist in scripts/lib/deps.mjs; GPL, AGPL,
// LGPL, SSPL and friends are denied unless approved in APPROVED below.
//
//   npm    production deps + devDeps the app source imports (bundled by Vite)
//          + the Electron runtime          → must pass
//          every other devDependency (build tools, never shipped) → warning only
//   cargo  every crate the engine workspace links or builds for Windows
//          (engine, dsp, MCP shim, plugin host...) → must pass
//          dev-only crates (tests/benches) → warning only
//
// Usage: npm run license:check   (also runs in CI)

import { cargoCrates, evaluateLicense, npmAll, npmShipped } from './lib/deps.mjs';

/**
 * Explicit approvals for packages whose licence is not on the allowlist.
 * Key: "npm:<name>" or "crate:<name>" (optionally "@<version>").
 * Every entry needs a reason a reviewer can check. Keep this short.
 */
const APPROVED = {
  // Example: 'crate:some-lgpl-crate@1.2.3': 'dynamically loaded DLL, user-replaceable, source link in notices',
};

/** Build tools only (never shipped). Warn instead of fail if their licence is unusual. */
const KNOWN_DEV_ONLY = {
  'npm:caniuse-lite': 'CC-BY-4.0 browser-support data used by autoprefixer at build time',
  'npm:exif-parser': 'no licence field; transitive dev dependency of jimp (make-ico only)',
  'npm:truncate-utf8-bytes': 'WTFPL; transitive dev dependency of electron-builder',
};

const approved = (kind, name, version) => APPROVED[`${kind}:${name}@${version}`] ?? APPROVED[`${kind}:${name}`] ?? null;

const errors = [];
const warnings = [];
let checked = 0;

function judge(kind, p, { shipped, label }) {
  checked++;
  const ev = evaluateLicense(p.license);
  if (ev.ok) return;
  const why = approved(kind, p.name, p.version);
  const desc = `${kind} ${p.name}@${p.version} (${label}): licence "${p.license || 'none'}"${ev.denied.length ? ` is copyleft/denied [${ev.denied.join(', ')}]` : ` is not on the allowlist${ev.unknown.length ? ` [${ev.unknown.join(', ')}]` : ''}`}`;
  if (why) {
    warnings.push(`${desc}; approved: ${why}`);
    return;
  }
  if (shipped) errors.push(desc);
  else warnings.push(`${desc}${KNOWN_DEV_ONLY[`${kind}:${p.name}`] ? `; known: ${KNOWN_DEV_ONLY[`${kind}:${p.name}`]}` : ''}`);
}

// npm
let shippedNpm = [];
try {
  shippedNpm = npmShipped();
} catch (e) {
  errors.push(`npm inventory failed: ${e.message} (did you run npm ci?)`);
}
const shippedKeys = new Set(shippedNpm.map((p) => `${p.name}@${p.version}`));
for (const p of shippedNpm) judge('npm', p, { shipped: true, label: p.reason });
try {
  for (const p of npmAll()) if (!shippedKeys.has(`${p.name}@${p.version}`)) judge('npm', p, { shipped: false, label: p.dev ? 'dev tool, not shipped' : 'installed, not shipped' });
} catch (e) {
  errors.push(`reading package-lock.json failed: ${e.message}`);
}

// cargo
let crates = [];
try {
  crates = cargoCrates().crates;
} catch (e) {
  errors.push(e.message);
}
for (const c of crates) judge('crate', c, { shipped: c.use !== 'dev', label: c.use === 'runtime' ? `linked into ${c.usedBy.join(', ')}` : c.use === 'build' ? 'build-time' : 'dev/test only' });

const mpl = crates.filter((c) => /MPL/.test(c.license)).map((c) => c.name);
console.log(`license-check: ${shippedNpm.length} shipped npm packages, ${crates.filter((c) => c.use !== 'dev').length} crates, ${checked} entries checked`);
if (mpl.length) console.log(`  note: MPL-2.0 (file-level copyleft, used unmodified, listed in THIRD-PARTY-NOTICES): ${mpl.join(', ')}`);
for (const w of warnings) console.warn(`  ⚠ ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`  ✖ ${e}`);
  console.error(`\n✖ license-check failed: ${errors.length} problem(s). Replace the dependency, or add a reviewed approval to APPROVED in scripts/license-check.mjs.`);
  process.exit(1);
}
console.log('✔ license-check passed');
