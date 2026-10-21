// Stage the ONNX Runtime DLLs the analyzer needs for stem separation next to
// krypt-studio-analyzer.exe (default: resources/bin/). The analyzer opens
// onnxruntime.dll at run time (ort `load-dynamic`), so a missing DLL only
// disables `separate`, never the analyzer.
//
//   node scripts/models/onnxruntime.mjs [--out <dir>]
//   (also called by scripts/engine-build.mjs)
//
// What gets staged, and from where (every download is pinned by SHA-256):
//   onnxruntime.dll  NuGet Microsoft.ML.OnnxRuntime.DirectML 1.24.4 (MIT)
//                    — the last ONNX Runtime release built with DirectML;
//                    matches the `api-24` feature of the `ort` crate.
//   DirectML.dll     NuGet Microsoft.AI.DirectML 1.15.4 (Microsoft software
//                    licence: redistributable inside an app, not open source).
//                    Skipped when KRYPT_NO_DIRECTML=1 (CPU-only build).
//   vcruntime140.dll, vcruntime140_1.dll, msvcp140.dll, msvcp140_1.dll
//                    the VC++ 2015-2022 runtime onnxruntime.dll links against
//                    (our own exes use the static CRT), copied app-local from
//                    the Visual Studio / Build Tools redist folder.
//   *-LICENSE.txt / *-ThirdPartyNotices.txt  the packages' licence texts.
//
// macOS arm64 / Linux x64: libonnxruntime.dylib / .so (CPU) from the pinned GitHub
// release tarball of the same version, plus its licence texts.
//
// Downloads are cached in engine/target-ort/ (gitignored).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, unzipSync } from 'fflate';

const root = path.resolve(import.meta.dirname, '..', '..');
const cacheDir = path.join(root, 'engine', 'target-ort');

const PACKAGES = [
  {
    id: 'microsoft.ml.onnxruntime.directml',
    version: '1.24.4',
    sha256: '57e9f11b73437bef7a309496135d4c1f96b1a8e9ddba60013fa27bfc1d788681',
    bytes: 12458649,
    files: [
      { from: 'runtimes/win-x64/native/onnxruntime.dll', to: 'onnxruntime.dll', sha256: 'e7eedec6a6f26dc39dc948276a75ef6d2bee3fff944d874ceed0bbd3b97bff40' },
      { from: 'LICENSE', to: 'onnxruntime-LICENSE.txt' },
      { from: 'ThirdPartyNotices.txt', to: 'onnxruntime-ThirdPartyNotices.txt' },
    ],
  },
  {
    id: 'microsoft.ai.directml',
    version: '1.15.4',
    sha256: '4e7cb7ddce8cf837a7a75dc029209b520ca0101470fcdf275c1f49736a3615b9',
    bytes: 202292617,
    optional: 'KRYPT_NO_DIRECTML',
    files: [
      { from: 'bin/x64-win/DirectML.dll', to: 'DirectML.dll', sha256: '9c9e6d822561c6c41b90e6994b3e8857cf1d66dbfb1e0c4c799c7c89b4e92da1' },
      { from: 'LICENSE.txt', to: 'DirectML-LICENSE.txt' },
      { from: 'ThirdPartyNotices.txt', to: 'DirectML-ThirdPartyNotices.txt' },
    ],
  },
];

// macOS / Linux: the CPU build of the same ONNX Runtime release from GitHub (MIT). No DirectML,
// and no C++ runtime to stage (libc++ / libstdc++ ship with the OS).
const TARBALLS = {
  'darwin-arm64': {
    id: 'onnxruntime-osx-arm64',
    version: '1.24.4',
    sha256: '93787795f47e1eee369182e43ed51b9e5da0878ab0346aecf4258979b8bba989',
    bytes: 30937282,
    files: [
      { from: 'lib/libonnxruntime.1.24.4.dylib', to: 'libonnxruntime.dylib', sha256: '872533f130f1839a5bc01788ddb4f75c83a189763441ba1178788ed965449289' },
      { from: 'LICENSE', to: 'onnxruntime-LICENSE.txt' },
      { from: 'ThirdPartyNotices.txt', to: 'onnxruntime-ThirdPartyNotices.txt' },
    ],
  },
  'linux-x64': {
    id: 'onnxruntime-linux-x64',
    version: '1.24.4',
    sha256: '3a211fbea252c1e66290658f1b735b772056149f28321e71c308942cdb54b747',
    bytes: 8155822,
    files: [
      { from: 'lib/libonnxruntime.so.1.24.4', to: 'libonnxruntime.so', sha256: 'd132535d051344ff5c64c9c200004150559049a81ed330eb4422c1962fb6b7e4' },
      { from: 'LICENSE', to: 'onnxruntime-LICENSE.txt' },
      { from: 'ThirdPartyNotices.txt', to: 'onnxruntime-ThirdPartyNotices.txt' },
    ],
  },
};

/** The ONNX Runtime library the analyzer opens on this OS (engine/crates/analyzer/src/separate/runtime.rs DYLIB). */
export const ORT_DYLIB = process.platform === 'win32' ? 'onnxruntime.dll' : process.platform === 'darwin' ? 'libonnxruntime.dylib' : 'libonnxruntime.so';
const isLib = (name) => /\.(dll|dylib|so)$/.test(name);

const CRT_DLLS = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const mb = (n) => `${(n / (1024 * 1024)).toFixed(2)} MB`;

async function fetchPackage(pkg) {
  mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${pkg.id}.${pkg.version}.nupkg`);
  if (existsSync(file)) {
    const data = readFileSync(file);
    if (sha256(data) === pkg.sha256) return data;
  }
  const url = `https://api.nuget.org/v3-flatcontainer/${pkg.id}/${pkg.version}/${pkg.id}.${pkg.version}.nupkg`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`cannot download ${url}: ${e.cause?.code ?? e.message}`);
  }
  if (!res.ok) throw new Error(`cannot download ${url}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const got = sha256(data);
  if (got !== pkg.sha256) throw new Error(`${pkg.id} ${pkg.version}: SHA-256 mismatch (got ${got}, expected ${pkg.sha256})`);
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
  return data;
}

async function fetchTarball(pkg) {
  mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${pkg.id}-${pkg.version}.tgz`);
  if (existsSync(file)) {
    const data = readFileSync(file);
    if (sha256(data) === pkg.sha256) return data;
  }
  const url = `https://github.com/microsoft/onnxruntime/releases/download/v${pkg.version}/${pkg.id}-${pkg.version}.tgz`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`cannot download ${url}: ${e.cause?.code ?? e.message}`);
  }
  if (!res.ok) throw new Error(`cannot download ${url}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const got = sha256(data);
  if (got !== pkg.sha256) throw new Error(`${pkg.id} ${pkg.version}: SHA-256 mismatch (got ${got}, expected ${pkg.sha256})`);
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
  return data;
}

/** Regular files of a ustar archive whose path (minus the top folder) is in `wanted`. */
function untar(tar, wanted) {
  const out = {};
  const str = (o, n) => tar.subarray(o, o + n).toString('latin1').replace(/\0.*$/s, '');
  for (let o = 0; o + 512 <= tar.length; ) {
    const name = str(o, 100);
    if (!name) break;
    const full = (tar.subarray(o + 257, o + 262).toString('latin1') === 'ustar' && str(o + 345, 155) ? `${str(o + 345, 155)}/` : '') + name;
    const size = parseInt(str(o + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(tar[o + 156]);
    const rel = full.split('/').slice(1).join('/');
    if ((type === '0' || type === '\0') && wanted.has(rel)) out[rel] = tar.subarray(o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function stageTarball(pkg, write, warnings) {
  try {
    const tar = Buffer.from(gunzipSync(await fetchTarball(pkg)));
    const entries = untar(tar, new Set(pkg.files.map((f) => f.from)));
    for (const f of pkg.files) {
      const data = entries[f.from];
      if (!data) throw new Error(`${f.from} is missing from ${pkg.id} ${pkg.version}`);
      if (f.sha256 && sha256(data) !== f.sha256) throw new Error(`${f.from} in ${pkg.id} ${pkg.version} has an unexpected SHA-256`);
      write(f.to, data);
    }
  } catch (e) {
    warnings.push(`${pkg.id} ${pkg.version} not staged: ${e.message}. Stem separation will not work in this build.`);
  }
}

/** The newest x64 VC++ CRT redist folder of any Visual Studio / Build Tools install. */
function findCrtDir() {
  const fromEnv = process.env.VCToolsRedistDir && path.join(process.env.VCToolsRedistDir, 'x64');
  const candidates = [];
  if (fromEnv && existsSync(fromEnv)) candidates.push(fromEnv);
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (existsSync(vswhere)) {
    const r = spawnSync(vswhere, ['-all', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true });
    for (const inst of (r.stdout ?? '').split(/\r?\n/).filter(Boolean)) {
      const msvc = path.join(inst.trim(), 'VC', 'Redist', 'MSVC');
      if (!existsSync(msvc)) continue;
      for (const ver of readdirSync(msvc).filter((v) => /^\d+\.\d+\.\d+$/.test(v))) candidates.push(path.join(msvc, ver, 'x64'));
    }
  }
  const dirs = [];
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    for (const sub of readdirSync(base).filter((d) => /^Microsoft\.VC\d+\.CRT$/.test(d))) {
      const dir = path.join(base, sub);
      if (CRT_DLLS.every((f) => existsSync(path.join(dir, f)))) dirs.push(dir);
    }
  }
  const ver = (d) => d.split(path.sep).find((s) => /^\d+\.\d+\.\d+$/.test(s))?.split('.').map(Number) ?? [0];
  dirs.sort((a, b) => {
    const [x, y] = [ver(a), ver(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  return dirs[0] ?? null;
}

/**
 * Stages the DLLs into `binDir`. Never throws: problems come back as
 * warnings (stem separation is optional; the rest of the build is not).
 */
export async function stageOnnxRuntime({ binDir = path.join(root, 'resources', 'bin') } = {}) {
  const summary = [];
  const warnings = [];
  mkdirSync(binDir, { recursive: true });
  const write = (name, data) => {
    const dst = path.join(binDir, name);
    try {
      writeFileSync(`${dst}.tmp`, data, { mode: isLib(name) ? 0o755 : 0o644 });
      renameSync(`${dst}.tmp`, dst);
    } catch (e) {
      throw new Error(`cannot write ${dst} (${e.code ?? e.message}); is the analyzer still running?`);
    }
    if (isLib(name)) summary.push(`${name.padEnd(26)} ${mb(data.length)}`);
  };
  if (process.platform !== 'win32') {
    const pkg = TARBALLS[`${process.platform}-${process.arch}`];
    if (!pkg) warnings.push(`no ONNX Runtime build is pinned for ${process.platform}-${process.arch}; stem separation will not work in this build`);
    else await stageTarball(pkg, write, warnings);
    return { summary, warnings };
  }
  for (const pkg of PACKAGES) {
    if (pkg.optional && process.env[pkg.optional] === '1') {
      warnings.push(`${pkg.id} skipped (${pkg.optional}=1): stem separation will offer the CPU only`);
      continue;
    }
    try {
      const nupkg = await fetchPackage(pkg);
      const wanted = new Set(pkg.files.map((f) => f.from));
      const entries = unzipSync(nupkg, { filter: (f) => wanted.has(f.name) });
      for (const f of pkg.files) {
        const data = entries[f.from];
        if (!data) throw new Error(`${f.from} is missing from ${pkg.id} ${pkg.version}`);
        if (f.sha256 && sha256(data) !== f.sha256) throw new Error(`${f.from} in ${pkg.id} ${pkg.version} has an unexpected SHA-256`);
        write(f.to, data);
      }
    } catch (e) {
      warnings.push(`${pkg.id} ${pkg.version} not staged: ${e.message}. Stem separation ${pkg.optional ? 'will offer the CPU only' : 'will not work in this build'}.`);
    }
  }
  const crt = findCrtDir();
  if (!crt) {
    warnings.push('VC++ runtime DLLs not found (install the "MSVC v143 C++ x64/x86 build tools" with Visual Studio or Build Tools); onnxruntime.dll will only load where the VC++ Redistributable is installed');
  } else {
    for (const f of CRT_DLLS) {
      try {
        copyFileSync(path.join(crt, f), path.join(binDir, f));
        summary.push(`${f.padEnd(26)} ${mb(statSync(path.join(binDir, f)).size)} (${path.basename(path.dirname(path.dirname(crt)))})`);
      } catch (e) {
        warnings.push(`cannot copy ${f} from ${crt} (${e.code ?? e.message})`);
      }
    }
  }
  return { summary, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--out');
  const binDir = i > 0 ? path.resolve(process.argv[i + 1]) : undefined;
  const { summary, warnings } = await stageOnnxRuntime({ binDir });
  for (const s of summary) console.log(`  ${s}`);
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
  process.exit(summary.some((s) => s.startsWith(ORT_DYLIB)) ? 0 : 1);
}
