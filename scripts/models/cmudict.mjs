// Build the compressed CMU Pronouncing Dictionary that krypt-studio-analyzer
// embeds for Krypt Voice's English G2P (engine/crates/analyzer/src/tts/g2p.rs).
//
//   node scripts/models/cmudict.mjs [<cmudict.dict> <LICENSE>]
//
// Without arguments it downloads both from cmusphinx/cmudict at the pinned
// commit below. Every input is SHA-256 pinned. Output (checked in):
//   engine/crates/analyzer/data/cmudict.txt.deflate  raw DEFLATE of
//       "word ARPABET\n" lines: first pronunciation per word only, comments
//       stripped, sorted bytewise by word (the analyzer binary-searches it);
//   engine/crates/analyzer/data/CMUDICT-LICENSE.txt  the dictionary's
//       BSD-style licence (reproduced in THIRD-PARTY-NOTICES.md).
//
// CMUdict: Copyright (C) 1993-2015 Carnegie Mellon University, BSD-2-Clause-style.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..', '..');
const COMMIT = '74790861f652b15e4ac49015a90074ad62a27690';
const BASE = `https://raw.githubusercontent.com/cmusphinx/cmudict/${COMMIT}`;
const PINS = {
  'cmudict.dict': '81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22',
  LICENSE: 'bd4ce8e44170a5f9f481310ca85c51de3c4f851a65e679b40e603b143bd3542a',
};
const outDir = path.join(root, 'engine', 'crates', 'analyzer', 'data');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function get(name, local) {
  const buf = local ? readFileSync(local) : Buffer.from(await (await fetch(`${BASE}/${name}`)).arrayBuffer());
  if (sha(buf) !== PINS[name]) throw new Error(`${name}: SHA-256 mismatch (got ${sha(buf)}, pinned ${PINS[name]})`);
  return buf;
}

const [dictPath, licPath] = process.argv.slice(2);
const dict = (await get('cmudict.dict', dictPath)).toString('utf8');
const lic = (await get('LICENSE', licPath)).toString('utf8');

const map = new Map();
for (const raw of dict.split(/\r?\n/)) {
  const line = raw.replace(/#.*$/, '').trim();
  if (!line) continue;
  const sp = line.indexOf(' ');
  if (sp < 0) continue;
  const word = line.slice(0, sp);
  if (/\(\d+\)$/.test(word)) continue; // alternate pronunciations: keep the first
  if (!map.has(word)) map.set(word, line.slice(sp + 1).trim().replace(/\s+/g, ' '));
}
const words = [...map.keys()].sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
const text = words.map((w) => `${w} ${map.get(w)}\n`).join('');
const packed = deflateRawSync(Buffer.from(text, 'utf8'), { level: 9 });
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'cmudict.txt.deflate'), packed);
writeFileSync(path.join(outDir, 'CMUDICT-LICENSE.txt'), lic.replace(/\r\n/g, '\n'));
console.log(`cmudict: ${words.length} words, ${text.length} bytes → ${packed.length} bytes (cmusphinx/cmudict@${COMMIT.slice(0, 7)})`);
