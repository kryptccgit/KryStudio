import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const binDir = path.join(root, 'resources', 'bin');
const DYNAMIC_CRT = /^(vcruntime\d+|msvcp\d+|ucrtbase|api-ms-win-crt-)/i;

function importedDlls(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (no MZ header)');
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x4550) throw new Error('not a PE file (no PE signature)');
  const sectionCount = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const s = opt + optSize + i * 40;
    sections.push({ va: buf.readUInt32LE(s + 12), size: Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)), raw: buf.readUInt32LE(s + 20) });
  }
  const offsetOf = (rva) => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + x.size);
    if (!s) throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
    return rva - s.va + s.raw;
  };
  const cstr = (rva) => {
    const at = offsetOf(rva);
    return buf.toString('latin1', at, buf.indexOf(0, at));
  };
  const dlls = [];
  const walk = (dirIndex, entrySize, nameField) => {
    const rva = buf.readUInt32LE(dirs + dirIndex * 8);
    if (!rva) return;
    for (let at = offsetOf(rva); ; at += entrySize) {
      const name = buf.readUInt32LE(at + nameField);
      if (!name) break;
      dlls.push(cstr(name));
    }
  };
  walk(1, 20, 12);
  walk(13, 32, 4);
  return dlls;
}

const exes = fs.existsSync(binDir) ? fs.readdirSync(binDir).filter((f) => f.toLowerCase().endsWith('.exe')) : [];
if (!exes.length) {
  console.error(`No .exe files in ${binDir}: run npm run engine:build first.`);
  process.exit(1);
}
let bad = 0;
for (const exe of exes) {
  const file = path.join(binDir, exe);
  const dlls = importedDlls(file);
  const crt = dlls.filter((d) => DYNAMIC_CRT.test(d));
  const mb = (fs.statSync(file).size / 1048576).toFixed(2);
  if (crt.length) {
    bad++;
    console.error(`${exe} imports ${crt.join(', ')}: the static CRT flags in .cargo/config.toml were not applied`);
  } else console.log(`${exe}: static CRT ok (${mb} MB; imports ${dlls.length} DLLs)`);
}
if (bad) process.exit(1);
