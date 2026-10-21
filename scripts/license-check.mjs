import { cargoCrates, evaluateLicense, npmAll, npmShipped } from './lib/deps.mjs';

const APPROVED = {
};

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
