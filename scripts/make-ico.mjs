// Rebuilds resources/krypt.ico from resources/krypt.png as a multi-size icon
// (16/24/32/48/64/128/256). NSIS + the Windows taskbar both look ugly with a
// single-size PNG-as-ICO, so we always ship the full set.
//
// `png-to-ico` requires a SQUARE input. The Krypt master PNG isn't square,
// so we pad it with a transparent canvas via Jimp before handing it off —
// the same trick used across the suite.
//
// Run after the logo changes: `npm run make-ico`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';
import { Jimp } from 'jimp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'resources', 'krypt.png');
const padded = path.join(root, 'resources', '.krypt.square.png');
const dst = path.join(root, 'resources', 'krypt.ico');

if (!fs.existsSync(src)) {
  console.error(`[make-ico] missing source: ${src}`);
  process.exit(1);
}

try {
  const img = await Jimp.read(src);
  const side = Math.max(img.bitmap.width, img.bitmap.height, 256);
  const square = new Jimp({ width: side, height: side, color: 0x00000000 });
  square.composite(
    img,
    Math.floor((side - img.bitmap.width) / 2),
    Math.floor((side - img.bitmap.height) / 2),
  );
  await square.write(padded);

  const buf = await pngToIco(padded);
  fs.writeFileSync(dst, buf);
  fs.unlinkSync(padded);
  console.log(`[make-ico] wrote ${dst} (${buf.length} bytes, ${side}×${side} source)`);
} catch (err) {
  console.error('[make-ico] failed:', err);
  process.exit(1);
}
