import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import { GUIDE_IMAGE_FILE, GUIDE_IMAGE_ROUTE, guideImageUrl, isGuideImageFile } from '@shared/guides/images';
import { ARTICLES, DEFAULT_ARTICLE, GUIDE_GROUPS, articleById } from '../src/guides/articles';
import { BEGINNER_ARTICLES, BEGINNER_GROUP } from '../src/guides/beginner';
import { blockInlines, guideImageFiles, inlineText, parseGuide } from '../src/guides/markup';
import { blocksOf, orderedArticles, searchGuides } from '../src/guides/search';
import { guideImageResponse } from '../electron/system/guide-images';
import { AUTO_MIX_PRESETS } from '@shared/automix/presets';

function repoRoot(): string {
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const IMAGE_DIR = path.join(repoRoot(), 'resources', 'guides', 'images');
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

test('{{image:<file>|<caption>}} parses to an image block; malformed ones stay visible text', () => {
  const b = parseGuide(
    [
      '## Look',
      '{{image:beat-kick.webp|Kick: steps 1, 5, 9 and 13}}',
      '{{image:a.png|  A caption with spaces  }}',
      '{{image:photo.jpg|One}}',
      '{{image:beat-kick.webp}}',
      '{{image:../evil.webp|Up a folder}}',
      '{{image:sub/a.webp|A folder}}',
      '{{image:Shot.WEBP|Upper case}}',
      '{{image:notes.txt|Not an image}}',
      '{{image:a.webp|}}',
    ].join('\n\n'),
  );
  assert.deepEqual(
    b.map((x) => x.type),
    ['h2', 'image', 'image', 'image', 'p', 'p', 'p', 'p', 'p', 'p'],
  );
  assert.deepEqual(b[1], { type: 'image', file: 'beat-kick.webp', caption: 'Kick: steps 1, 5, 9 and 13' });
  assert.deepEqual(b[2], { type: 'image', file: 'a.png', caption: 'A caption with spaces' });
  assert.equal(inlineText((b[4] as { text: Parameters<typeof inlineText>[0] }).text), '{{image:beat-kick.webp}}');
  assert.deepEqual(guideImageFiles(b), ['beat-kick.webp', 'a.png', 'photo.jpg']);
});

test('an image ends a paragraph, and its caption is searchable text', () => {
  const b = parseGuide('Click the step.\n{{image:x.webp|The Kick row lit up}}\nThen play.');
  assert.deepEqual(
    b.map((x) => x.type),
    ['p', 'image', 'p'],
  );
  assert.ok(inlineText(blockInlines(b)).includes('The Kick row lit up'));
});

test('numbered steps carry on across a picture: "4." after an image starts the list at 4', () => {
  const b = parseGuide('1. One\n2. Two\n\n{{image:x.webp|Pic}}\n\n3. Three\n4. Four\n\n- a\n\n1. Fresh');
  assert.deepEqual(b[0], { type: 'ol', items: [[{ t: 'text', v: 'One' }], [{ t: 'text', v: 'Two' }]] }, 'a list from 1 has no start');
  assert.equal(b[1].type, 'image');
  assert.equal(b[2].type === 'ol' && b[2].start, 3);
  assert.equal(b[2].type === 'ol' && b[2].items.length, 2);
  assert.equal(b[4].type === 'ol' && b[4].start, undefined);
});

test('every {{image:…}} in an article is in resources/guides/images, every file there is used, the folder stays small', () => {
  const files = fs.existsSync(IMAGE_DIR) ? fs.readdirSync(IMAGE_DIR) : [];
  const used = new Set<string>();
  for (const a of ARTICLES) {
    for (const f of guideImageFiles(blocksOf(a))) {
      assert.ok(files.includes(f), `${a.id}: {{image:${f}|…}} but resources/guides/images/${f} doesn't exist`);
      used.add(f);
    }
  }
  let total = 0;
  for (const f of files) {
    assert.ok(GUIDE_IMAGE_FILE.test(f), `${f}: only flat <name>.webp / .png / .jpg files belong in resources/guides/images`);
    assert.ok(used.has(f), `${f} is in resources/guides/images but no guide shows it`);
    const st = fs.statSync(path.join(IMAGE_DIR, f));
    assert.ok(st.size > 0, `${f} is empty`);
    total += st.size;
  }
  assert.ok(total <= MAX_TOTAL_BYTES, `resources/guides/images is ${(total / 1e6).toFixed(1)} MB (keep it under ${MAX_TOTAL_BYTES / 1024 / 1024} MB)`);
});

test('image files really are WebP / PNG / JPEG (magic bytes match the extension)', () => {
  const files = fs.existsSync(IMAGE_DIR) ? fs.readdirSync(IMAGE_DIR) : [];
  for (const f of files) {
    const head = Buffer.alloc(12);
    const fd = fs.openSync(path.join(IMAGE_DIR, f), 'r');
    try {
      fs.readSync(fd, head, 0, 12, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (f.endsWith('.webp')) assert.ok(head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP', `${f} isn't WebP`);
    if (f.endsWith('.png')) assert.equal(head.subarray(1, 4).toString('latin1'), 'PNG', `${f} isn't PNG`);
    if (f.endsWith('.jpg')) assert.ok(head[0] === 0xff && head[1] === 0xd8, `${f} isn't JPEG`);
  }
});

test('"Start here (step by step)" is the first group, holds the eight beginner guides in order, and the Guides open on it', () => {
  assert.equal(GUIDE_GROUPS[0], BEGINNER_GROUP);
  assert.deepEqual(
    BEGINNER_ARTICLES.map((a) => a.id),
    ['step-start', 'step-windows', 'step-first-beat', 'step-play', 'step-save-export', 'step-master', 'step-ai', 'step-help'],
  );
  for (const a of BEGINNER_ARTICLES) assert.equal(a.group, BEGINNER_GROUP, `${a.id}: group`);
  assert.deepEqual(
    orderedArticles()
      .slice(0, BEGINNER_ARTICLES.length)
      .map((a) => a.id),
    BEGINNER_ARTICLES.map((a) => a.id),
  );
  assert.equal(DEFAULT_ARTICLE, 'step-start');
  assert.ok(articleById('getting-started'), 'the original Getting started stays');
});

test('beginner guides: numbered steps, bold targets, keys, a picture in each, and Getting started links to them', () => {
  for (const a of BEGINNER_ARTICLES) {
    const blocks = blocksOf(a);
    assert.ok(blocks.some((b) => b.type === 'ol'), `${a.id}: no numbered steps`);
    assert.ok(guideImageFiles(blocks).length > 0, `${a.id}: no screenshot`);
    const runs = blockInlines(blocks);
    assert.ok(runs.some((r) => r.t === 'b'), `${a.id}: nothing in bold`);
    assert.ok(runs.some((r) => r.t === 'kbd'), `${a.id}: no keys`);
    assert.ok(!/Auto-?Tune/i.test(a.body), `${a.id}: say Krypt Tune`);
  }
  const gs = blockInlines(blocksOf(articleById('getting-started')!));
  assert.ok(gs.some((r) => r.t === 'guide' && r.id === 'step-start'), 'Getting started links to Start here (step by step)');
  assert.ok(searchGuides('revert all ai edits').some((h) => h.article.id === 'step-ai'), 'the AI guide is found by "revert all AI edits"');
});

test('the windows guide lists every window key from the keymap it names', () => {
  const body = articleById('step-windows')!.body;
  for (const k of ['F5', 'F6', 'F7', 'F9', 'Alt+F8', 'F3', 'F1', 'Ctrl+Shift+H', 'Ctrl+Z']) assert.ok(body.includes(`[[${k}]]`), `step-windows: [[${k}]]`);
  assert.ok(body.includes('Reset layout'));
});

test('guideImageUrl: on the app origin, under guide-images/; isGuideImageFile only takes flat image names', () => {
  assert.equal(GUIDE_IMAGE_ROUTE, 'guide-images');
  assert.equal(guideImageUrl('beat-kick.webp'), 'app://bundle/guide-images/beat-kick.webp');
  for (const ok of ['a.webp', 'a-1.png', '0.jpg']) assert.ok(isGuideImageFile(ok), ok);
  for (const bad of ['', '.webp', 'A.webp', 'a.gif', 'a.svg', 'a/b.webp', '../a.webp', 'a.webp.txt', 'a b.webp', '-a.webp']) assert.ok(!isGuideImageFile(bad), bad);
});

test('guideImageResponse: serves flat images with their type, HEAD, and nothing outside the folder or off the list', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-images-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-images-out-'));
  try {
    const bytes = Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1');
    fs.writeFileSync(path.join(root, 'shot.webp'), bytes);
    fs.writeFileSync(path.join(root, 'shot.png'), 'png');
    fs.writeFileSync(path.join(root, 'shot.jpg'), 'jpg');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'secret');
    fs.mkdirSync(path.join(root, 'sub.webp'));
    fs.writeFileSync(path.join(outside, 'x.webp'), 'x');

    const r = await guideImageResponse('shot.webp', root);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/webp');
    assert.equal(r.headers.get('content-length'), String(bytes.length));
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
    assert.equal((await guideImageResponse('shot.png', root)).headers.get('content-type'), 'image/png');
    assert.equal((await guideImageResponse('shot.jpg', root)).headers.get('content-type'), 'image/jpeg');

    const head = await guideImageResponse('shot.webp', root, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    for (const name of ['notes.txt', '../x.webp', `..\\${path.basename(outside)}\\x.webp`, 'sub/shot.webp', 'Shot.WEBP', '', '.webp', 'sub.webp', 'missing.webp']) {
      const res = await guideImageResponse(name, root);
      assert.ok(res.status === 404 || res.status === 403, `${JSON.stringify(name)} → ${res.status}`);
    }
    assert.equal((await guideImageResponse('shot.webp', root, 'POST')).status, 405);
    assert.equal((await guideImageResponse('shot.webp', path.join(root, 'gone'))).status, 404, 'a missing folder is a 404, not a throw');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the mastering guide: every real preset with its real target, the Home card, the tour, and both help topics', () => {
  const a = articleById('step-master')!;
  assert.ok(a, 'step-master exists');
  const rows = blocksOf(a).filter((b) => b.type === 'table');
  assert.equal(rows.length, 1, 'one preset table');
  for (const p of AUTO_MIX_PRESETS) {
    const lufs = `${p.targetLufs < 0 ? '−' : ''}${Math.abs(p.targetLufs)} LUFS`;
    assert.ok(a.body.includes(`| **${p.name}** | ${lufs} |`), `step-master: the ${p.name} row says ${lufs}`);
  }
  assert.ok(a.body.includes('| **Auto** |'), 'Auto is explained');
  const runs = blockInlines(blocksOf(a));
  assert.ok(runs.some((r) => r.t === 'show' && r.anchor === 'home.audioTools'), 'Show me the Audio Tools card');
  assert.ok(runs.some((r) => r.t === 'show' && r.anchor === 'home.masterSong'), 'Show me the Master a song card');
  assert.ok(runs.some((r) => r.t === 'show' && r.anchor === 'automix.song'), 'Show me step 1, Your song');
  assert.ok(!a.body.includes('Choose a song and master it'), 'the old pick-and-run label is gone');
  assert.ok(runs.some((r) => r.t === 'action' && r.id === 'tourMaster'), 'Start the tour');
  assert.ok(runs.some((r) => r.t === 'action' && r.id === 'masterSong'), 'Open Master a song');
  for (const label of ['Master a song…', 'Choose your song…', 'Master my song', 'Pick a reference song…', 'Compare', 'Keep', 'Undo', 'Master another', 'Export…', 'Details', 'Master an album…', 'Choose your songs…', 'Master my album', "Keep the album's dynamics", 'Export all…']) {
    assert.ok(a.body.includes(`**${label}**`), `step-master: **${label}**`);
  }
  const headings = blocksOf(a).flatMap((b) => (b.type === 'h2' ? [inlineText(b.text)] : []));
  assert.ok(headings.some((h) => /too quiet/i.test(h) && /stopped before the target/i.test(h)), 'help: too quiet');
  assert.ok(headings.some((h) => /phone/i.test(h)), 'help: sounds different on my phone');
  assert.ok(searchGuides('master my song').some((h) => h.article.id === 'step-master'), 'found by "master my song"');
  assert.ok(!/LANDR|Ozone|Auto-?Tune/i.test(a.body), 'no competitor names');
});

void run('guide-images');
