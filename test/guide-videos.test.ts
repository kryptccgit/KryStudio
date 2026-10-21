// Tutorial videos in the Guides (shared/guides/videos.ts): the {{video:…}} / {{videos}} markup, the manifest (ids,
// articles, the files in resources/guides/videos agree with it), how a block renders when a video isn't shipped
// (never a broken player), the Home quickstart card rule, and the read-only app:// handler that streams the files
// (flat names only, range requests for seeking).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, run } from './harness';
import {
  GUIDE_VIDEOS,
  GUIDE_VIDEO_FILE,
  PLAYBACK_RATES,
  QUICKSTART_VIDEO,
  VIDEO_CREDIT,
  fmtVideoDuration,
  guideVideoById,
  isVideoReady,
  minutesLabel,
  readyVideos,
  videoStatus,
  videoUrls,
  type GuideVideo,
} from '@shared/guides/videos';
import { ARTICLES, articleById } from '../src/guides/articles';
import { blockInlines, guideVideoIds, inlineText, parseGuide } from '../src/guides/markup';
import { blocksOf, searchGuides } from '../src/guides/search';
import { VIDEOS_ARTICLE, mediaErrorMessage, videoBlockView, videoIndex } from '../src/guides/videos';
import { quickstartCardVisible } from '../src/home/logic';
import { guideVideoResponse, parseRange } from '../electron/system/guide-videos';

/** The repo root: the first folder up from this (bundled) test that has a package.json. */
function repoRoot(): string {
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const VIDEO_DIR = path.join(repoRoot(), 'resources', 'guides', 'videos');

const fixture = (id: string, durationSec: number | null): GuideVideo => ({ id, title: id, description: `${id} video`, durationSec, article: 'getting-started' });
const FIX: GuideVideo[] = [fixture('shipped', 61), fixture('later', null), fixture('broken', Number.NaN)];

// ── Markup ────────────────────────────────────────────────────────────

test('{{video:<id>}} and {{videos}} parse to blocks; malformed ones stay visible text', () => {
  const b = parseGuide('## Watch\n\n{{video:quickstart}}\n\n{{videos}}\n\n{{video:}}\n\n{{videos:extra}}\n\n{{video:a b}}');
  assert.deepEqual(
    b.map((x) => x.type),
    ['h2', 'video', 'videos', 'p', 'p', 'p'],
  );
  assert.deepEqual(b[1], { type: 'video', id: 'quickstart' });
  assert.equal(inlineText((b[3] as { text: Parameters<typeof inlineText>[0] }).text), '{{video:}}');
  assert.deepEqual(guideVideoIds(b), ['quickstart']);
});

test('a video block adds its title to search only once the video ships', () => {
  const ready = GUIDE_VIDEOS.find(isVideoReady);
  const soon = GUIDE_VIDEOS.find((v) => !isVideoReady(v));
  if (ready) {
    const text = inlineText(blockInlines(parseGuide(`{{video:${ready.id}}}`)));
    assert.ok(text.includes(ready.title), 'a shipped video is searchable by title');
    assert.ok(searchGuides(ready.title).some((h) => h.article.id === ready.article), `searching "${ready.title}" finds ${ready.article}`);
  }
  if (soon) assert.equal(inlineText(blockInlines(parseGuide(`{{video:${soon.id}}}`))).trim(), '', 'a coming-soon video adds no text');
});

// ── Missing videos degrade, never a broken player ─────────────────────

test('videoBlockView: shipped → player, not shipped (null / NaN duration) → nothing, unknown id → a problem note', () => {
  assert.deepEqual(videoBlockView('shipped', FIX), { kind: 'player', video: FIX[0] });
  assert.equal(videoBlockView('later', FIX).kind, 'hidden');
  assert.equal(videoBlockView('broken', FIX).kind, 'hidden', 'a bad duration never yields a player');
  assert.deepEqual(videoBlockView('nope', FIX), { kind: 'unknown', id: 'nope' });
  assert.deepEqual(
    ['shipped', 'later', 'nope'].map((id) => videoStatus(id, FIX)),
    ['ready', 'soon', 'unknown'],
  );
  assert.equal(guideVideoById('', FIX), undefined);
  assert.equal(isVideoReady(undefined), false);
  assert.equal(isVideoReady(fixture('zero', 0)), false);
});

test('Videos index: shipped first in manifest order, the rest as coming soon; empty manifest → nothing to play', () => {
  const idx = videoIndex(FIX);
  assert.deepEqual(
    idx.ready.map((v) => v.id),
    ['shipped'],
  );
  assert.deepEqual(
    idx.soon.map((v) => v.id),
    ['later', 'broken'],
  );
  assert.deepEqual(videoIndex([]), { ready: [], soon: [] });
  assert.deepEqual(readyVideos(FIX), [FIX[0]]);
});

test('a failed video always gets a sentence', () => {
  for (const code of [1, 2, 3, 4, 99, null, undefined]) assert.ok(mediaErrorMessage(code).length > 10, String(code));
  assert.notEqual(mediaErrorMessage(4), mediaErrorMessage(2));
});

// ── Manifest ──────────────────────────────────────────────────────────

test('manifest: unique file-safe ids, one-line title and description, a real article, the quickstart, the credit', () => {
  const ids = GUIDE_VIDEOS.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate video id');
  for (const v of GUIDE_VIDEOS) {
    assert.ok(GUIDE_VIDEO_FILE.test(`${v.id}.mp4`), `${v.id}: not a file-safe id`);
    assert.ok(v.title.trim() && !/\n/.test(v.title), `${v.id}: title`);
    assert.ok(v.description.trim() && !/\n/.test(v.description) && v.description.length <= 120, `${v.id}: one-line description`);
    assert.ok(articleById(v.article), `${v.id}: article "${v.article}" doesn't exist`);
    assert.ok(v.durationSec === null || (Number.isInteger(v.durationSec) && v.durationSec > 0), `${v.id}: durationSec must be null or whole seconds`);
  }
  assert.ok(guideVideoById(QUICKSTART_VIDEO), 'the quickstart is in the manifest');
  assert.equal(VIDEO_CREDIT, 'Tutorial narration voice: ElevenLabs.');
  assert.deepEqual([...PLAYBACK_RATES], [1, 1.25, 1.5]);
});

test('articles: every {{video:…}} is in the manifest, every video is embedded in its own article, the index has {{videos}}', () => {
  const embeddedIn = new Map<string, string[]>();
  for (const a of ARTICLES) {
    for (const id of guideVideoIds(blocksOf(a))) {
      assert.ok(guideVideoById(id), `${a.id}: {{video:${id}}} is not in shared/guides/videos.ts`);
      embeddedIn.set(id, [...(embeddedIn.get(id) ?? []), a.id]);
    }
  }
  for (const v of GUIDE_VIDEOS) assert.ok(embeddedIn.get(v.id)?.includes(v.article), `${v.id}: no {{video:${v.id}}} in its article ${v.article}`);
  const index = articleById(VIDEOS_ARTICLE);
  assert.ok(index, 'the Videos article exists');
  assert.ok(blocksOf(index).some((b) => b.type === 'videos'), 'the Videos article holds {{videos}}');
});

test('resources/guides/videos agrees with the manifest: shipped videos have mp4 + vtt + jpg, no stray or unlisted files', () => {
  const files = fs.existsSync(VIDEO_DIR) ? fs.readdirSync(VIDEO_DIR) : [];
  for (const v of readyVideos()) {
    for (const ext of ['mp4', 'vtt', 'jpg']) assert.ok(files.includes(`${v.id}.${ext}`), `${v.id} is marked shipped (durationSec) but ${v.id}.${ext} is missing from resources/guides/videos`);
    const vtt = fs.readFileSync(path.join(VIDEO_DIR, `${v.id}.vtt`), 'utf8');
    assert.ok(vtt.replace(/^﻿/, '').startsWith('WEBVTT'), `${v.id}.vtt isn't WebVTT`);
  }
  for (const f of files) {
    const m = GUIDE_VIDEO_FILE.exec(f);
    assert.ok(m, `${f}: only <id>.mp4 / .vtt / .jpg belong in resources/guides/videos`);
    assert.ok(isVideoReady(guideVideoById(m[1])), `${f}: ${m[1]} has files but no durationSec in shared/guides/videos.ts (run node scripts/guide-videos.mjs --write)`);
  }
});

test('helpers: durations, the N-minute label, stream URLs on the app origin', () => {
  assert.equal(fmtVideoDuration(56), '0:56');
  assert.equal(fmtVideoDuration(754.4), '12:34');
  assert.equal(fmtVideoDuration(null), '');
  assert.equal(fmtVideoDuration(Number.NaN), '');
  assert.equal(minutesLabel(56), '1-minute');
  assert.equal(minutesLabel(20), '1-minute');
  assert.equal(minutesLabel(150), '3-minute');
  assert.deepEqual(videoUrls('quickstart'), {
    src: 'app://bundle/guide-videos/quickstart.mp4',
    captions: 'app://bundle/guide-videos/quickstart.vtt',
    poster: 'app://bundle/guide-videos/quickstart.jpg',
  });
});

test('Home quickstart card: only when shipped, not dismissed / watched, and not for returning users', () => {
  assert.equal(quickstartCardVisible({ ready: true, dismissed: false, welcomeSeen: false }), true);
  assert.equal(quickstartCardVisible({ ready: false, dismissed: false, welcomeSeen: false }), false);
  assert.equal(quickstartCardVisible({ ready: true, dismissed: true, welcomeSeen: false }), false);
  assert.equal(quickstartCardVisible({ ready: true, dismissed: false, welcomeSeen: true }), false);
});

// ── The app:// handler ────────────────────────────────────────────────

test('parseRange: start-end, open end, suffix, clamping, unsatisfiable, and fall back to the whole file', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=50-10', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(parseRange(null, 1000), null);
  assert.equal(parseRange('bytes=0-1,5-9', 1000), null, 'multi-range → whole file');
  assert.equal(parseRange('items=0-1', 1000), null);
  assert.equal(parseRange('bytes=-', 1000), null);
});

test('guideVideoResponse: whole file, ranges (206), HEAD, 416, and nothing outside the folder or off the list', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-videos-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-videos-out-'));
  try {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    fs.writeFileSync(path.join(root, 'demo.mp4'), bytes);
    fs.writeFileSync(path.join(root, 'demo.vtt'), 'WEBVTT\n');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'secret');
    fs.mkdirSync(path.join(root, 'sub.mp4'));
    fs.writeFileSync(path.join(outside, 'x.mp4'), 'x');

    const full = await guideVideoResponse('demo.mp4', root);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('content-length'), '256');
    assert.equal(full.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

    const part = await guideVideoResponse('demo.mp4', root, 'GET', 'bytes=10-19');
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/256');
    assert.equal(part.headers.get('content-length'), '10');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(10, 20));

    const tail = await guideVideoResponse('demo.mp4', root, 'GET', 'bytes=-6');
    assert.equal(tail.headers.get('content-range'), 'bytes 250-255/256');
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(250));

    const head = await guideVideoResponse('demo.mp4', root, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '256');
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const bad = await guideVideoResponse('demo.mp4', root, 'GET', 'bytes=300-');
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), 'bytes */256');

    const vtt = await guideVideoResponse('demo.vtt', root);
    assert.match(vtt.headers.get('content-type') ?? '', /^text\/vtt/);

    for (const name of ['notes.txt', '../x.mp4', `..\\${path.basename(outside)}\\x.mp4`, 'sub/demo.mp4', 'Demo.MP4', '', '.mp4', 'sub.mp4', 'missing.mp4']) {
      const r = await guideVideoResponse(name, root);
      assert.ok(r.status === 404 || r.status === 403, `${JSON.stringify(name)} → ${r.status}`);
    }
    assert.equal((await guideVideoResponse('demo.mp4', root, 'POST')).status, 405);
    assert.equal((await guideVideoResponse('demo.mp4', path.join(root, 'gone'))).status, 404, 'a missing folder is a 404, not a throw');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

void run('guide-videos');
