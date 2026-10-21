import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, run } from './harness';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { checkIntegrity, songInfo, type Project } from '@shared/schema/project';
import type { RenderRequest, RenderResult } from '@shared/engine/protocol';
import type { CoverDrawResult, Settings } from '@shared/types';
import {
  buildId3v23,
  id3FrameText,
  memoryReader,
  parseApic,
  parseComm,
  parseId3v2,
  readWavInfo,
  scanRiff,
  tagMp3Bytes,
  tagWavBytes,
  TagError,
  type SongTags,
} from '@shared/audio/tags';
import { decodeContainer, encodeContainer } from '../electron/project/container';
import { validateProject } from '../electron/project/migrations';
import { RecoveryStore } from '../electron/project/recovery';
import { coverFileName, ProjectAssets } from '../electron/project/assets';
import { ProjectService } from '../electron/project/service';
import { CoverService } from '../electron/project/cover';
import { ExportService, mp3Tags, safeFileName } from '../electron/project/export';
import { tagAudioFile } from '../electron/system/tagging';
import type { MainDeps } from '../electron/mcp/types';
import { callTool, getTool, newSession, type ToolCaller } from '../electron/mcp/tools';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-songinfo-'));
const noLog = (): void => {};
let seq = 0;
const tmpDir = (name: string): string => {
  const d = path.join(TMP, `${name}-${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const enc = new TextEncoder();
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const u32le = (n: number) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const chunk = (id: string, payload: Uint8Array): Uint8Array => concat([ascii(id), u32le(payload.length), payload, new Uint8Array(payload.length & 1)]);
function noise(n: number, seed = 7): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}
const FMT = chunk('fmt ', concat([Uint8Array.of(1, 0, 2, 0), u32le(48000), u32le(192000), Uint8Array.of(4, 0, 16, 0)]));

function wav(parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([ascii('RIFF'), u32le(4 + body.length), ascii('WAVE'), body]);
}

const MP3_FRAMES = concat(Array.from({ length: 12 }, (_, i) => concat([Uint8Array.of(0xff, 0xfb, 0x90, 0x64), noise(413, i + 1)])));

const FAKE_JPEG = concat([Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), noise(2000, 3), Uint8Array.of(0xff, 0xd9)]);
const FAKE_JPEG_2 = concat([Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), noise(1500, 4), Uint8Array.of(0xff, 0xd9)]);
const FAKE_PNG = concat([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), noise(900, 5)]);

const TAGS: SongTags = { title: 'Midnight Run', artist: 'Krypt Test', album: 'Night Drives', year: '2026', genre: 'Synthwave', track: '3', software: 'Krypt Studio' };

function frameMap(tag: Uint8Array): Map<string, Uint8Array> {
  const p = parseId3v2(tag);
  assert.ok(p, 'an ID3 tag');
  return new Map(p.frames.map((f) => [f.id, f.data]));
}

function dataPayload(w: Uint8Array): Uint8Array {
  const c = scanRiff(memoryReader(w), w.length).find((x) => x.id === 'data')!;
  return w.subarray(c.offset + 8, c.offset + 8 + c.size);
}

test('ID3v2.3: header layout, every text frame, APIC front cover, Unicode titles in UTF-16', () => {
  const tag = buildId3v23({ ...TAGS, title: 'Café 夜 Run' }, { mime: 'image/jpeg', data: FAKE_JPEG });
  assert.deepEqual([...tag.subarray(0, 6)], [0x49, 0x44, 0x33, 3, 0, 0], '"ID3", v2.3.0, no flags');
  assert.ok(tag.subarray(6, 10).every((b) => b < 0x80), 'synchsafe size');
  const p = parseId3v2(tag)!;
  assert.equal(p.major, 3);
  assert.equal(p.size, tag.length);
  assert.deepEqual(p.frames.map((f) => f.id), ['TIT2', 'TPE1', 'TALB', 'TYER', 'TCON', 'TRCK', 'TSSE', 'APIC']);
  const f = frameMap(tag);
  assert.equal(f.get('TIT2')![0], 1, 'non-Latin-1 → UTF-16 with BOM');
  assert.equal(id3FrameText(f.get('TIT2')!), 'Café 夜 Run');
  assert.equal(f.get('TPE1')![0], 0, 'Latin-1 stays ISO-8859-1');
  assert.equal(id3FrameText(f.get('TPE1')!), 'Krypt Test');
  assert.equal(id3FrameText(f.get('TYER')!), '2026');
  assert.equal(id3FrameText(f.get('TRCK')!), '3');
  assert.equal(id3FrameText(f.get('TSSE')!), 'Krypt Studio');
  const pic = parseApic(f.get('APIC')!);
  assert.deepEqual([pic.mime, pic.type, pic.description], ['image/jpeg', 3, '']);
  assert.deepEqual([...pic.image], [...FAKE_JPEG], 'cover bytes untouched');
});

test('ID3v2.3: empty and malformed values are left out; control characters stripped', () => {
  const f = frameMap(buildId3v23({ title: '  A\u0000B\nC  ', artist: '', year: '26', track: 'x3', album: undefined }));
  assert.deepEqual([...f.keys()], ['TIT2'], 'artist empty, year not 4 digits, track not a number');
  assert.equal(id3FrameText(f.get('TIT2')!), 'A B C');
  assert.equal(id3FrameText(frameMap(buildId3v23({ track: '3/12' })).get('TRCK')!), '3/12');
});

test('ID3v2.3: MP3 extras: TLEN in ms and the iTunSMPB gapless COMM frame', () => {
  const smpb = ' 00000000 000002A0 00000348 0000000000017700 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000';
  const f = frameMap(buildId3v23({ title: 'x', lengthMs: 180000.4, gapless: smpb }));
  assert.equal(id3FrameText(f.get('TLEN')!), '180000');
  const c = parseComm(f.get('COMM')!);
  assert.deepEqual([c.lang, c.description, c.text], ['eng', 'iTunSMPB', smpb], 'leading space and spacing kept');
  assert.equal(f.get('COMM')![0], 0, 'ISO-8859-1');
  const r = { path: 'x.mp3', files: [], durationSec: 4, peakDb: -1, lufsIntegrated: -14, mp3: { sampleRate: 44100, kbps: 320, samples: 44100 * 3 + 441, encoderDelay: 672, endPadding: 100, itunSmpb: smpb } } as RenderResult;
  assert.deepEqual(mp3Tags(r), { lengthMs: 3010, gapless: smpb });
  assert.deepEqual(mp3Tags({ ...r, mp3: undefined }), {});
});

test('WAV: INFO + id3 chunks go after the audio; the audio bytes are identical; RIFF size and word alignment hold', () => {
  const audio = noise(48_001, 9);
  const src = wav([FMT, chunk('fact', u32le(12000)), chunk('data', audio), chunk('cue ', noise(25, 2))]);
  const out = tagWavBytes(src, TAGS, { mime: 'image/png', data: FAKE_PNG });
  const view = new DataView(out.buffer, out.byteOffset);
  assert.equal(view.getUint32(4, true), out.length - 8, 'RIFF size');
  const chunks = scanRiff(memoryReader(out), out.length);
  assert.deepEqual(chunks.map((c) => c.id), ['fmt ', 'fact', 'data', 'cue ', 'LIST', 'id3 '], 'old chunks in order, then INFO and id3');
  for (const c of chunks) assert.equal(c.offset % 2, 0, `${c.id} starts on a word boundary`);
  assert.deepEqual([...dataPayload(out)], [...audio], 'audio untouched');
  assert.deepEqual([...out.subarray(12, 12 + FMT.length)], [...FMT], 'fmt chunk byte-identical');
  assert.deepEqual(readWavInfo(out), { INAM: 'Midnight Run', IART: 'Krypt Test', IPRD: 'Night Drives', ICRD: '2026', IGNR: 'Synthwave', ITRK: '3', ISFT: 'Krypt Studio' });
  const id3 = chunks.find((c) => c.id === 'id3 ')!;
  const tag = out.subarray(id3.offset + 8, id3.offset + 8 + id3.size);
  const f = frameMap(tag);
  assert.equal(id3FrameText(f.get('TALB')!), 'Night Drives');
  assert.deepEqual([...parseApic(f.get('APIC')!).image], [...FAKE_PNG]);
});

test('WAV: tagging twice replaces the old tags; other LIST types survive; a missing pad byte is added', () => {
  const audio = noise(3001, 4);
  const adtl = chunk('LIST', concat([ascii('adtl'), noise(10)]));
  const old = chunk('LIST', concat([ascii('INFO'), ascii('ISFT'), u32le(5), ascii('Lavf'), Uint8Array.of(0, 0)]));
  const src = concat([wav([FMT, old, adtl]), ascii('data'), u32le(audio.length), audio]);
  new DataView(src.buffer).setUint32(4, src.length - 8, true);
  const once = tagWavBytes(src, TAGS);
  const twice = tagWavBytes(once, { ...TAGS, title: 'Second' });
  const ids = scanRiff(memoryReader(twice), twice.length).map((c) => c.id);
  assert.deepEqual(ids, ['fmt ', 'LIST', 'data', 'LIST', 'id3 '], 'the adtl LIST stays, one INFO, one id3');
  assert.equal(readWavInfo(twice).INAM, 'Second');
  assert.equal(readWavInfo(twice).ISFT, 'Krypt Studio', 'the old Lavf INFO is gone');
  assert.deepEqual([...dataPayload(twice)], [...audio]);
  assert.equal(twice.length % 2, 0);
});

test('WAV: RF64, broken chunk sizes and non-WAV files are refused (never guessed)', () => {
  const rf64 = wav([FMT, chunk('data', noise(8))]);
  rf64.set(ascii('RF64'), 0);
  assert.throws(() => tagWavBytes(rf64, TAGS), (e: unknown) => e instanceof TagError && /RF64/.test((e as Error).message));
  const short = wav([FMT, chunk('data', noise(64))]);
  new DataView(short.buffer).setUint32(12 + FMT.length + 4, 9999, true);
  assert.throws(() => tagWavBytes(short, TAGS), /claims more bytes than the file has/);
  assert.throws(() => tagWavBytes(enc.encode('not a wav at all, honestly'), TAGS), /Not a WAV file/);
  assert.throws(() => tagWavBytes(wav([FMT]), TAGS), /no data chunk/);
});

test('MP3: a fresh ID3v2.3 tag is prepended; an old ID3v2 (with footer) and a trailing ID3v1 are dropped; frames untouched', () => {
  const v24 = concat([ascii('ID3'), Uint8Array.of(4, 0, 0x10, 0, 0, 0, 20), new Uint8Array(20), ascii('3DI'), Uint8Array.of(4, 0, 0x10, 0, 0, 0, 20)]);
  const v1 = concat([ascii('TAG'), new Uint8Array(125)]);
  const out = tagMp3Bytes(concat([v24, MP3_FRAMES, v1]), TAGS, { mime: 'image/jpeg', data: FAKE_JPEG });
  const tag = parseId3v2(out)!;
  assert.equal(tag.major, 3);
  assert.deepEqual([...out.subarray(tag.size)], [...MP3_FRAMES], 'exactly the MPEG frames follow the tag');
  assert.equal(id3FrameText(frameMap(out.subarray(0, tag.size)).get('TIT2')!), 'Midnight Run');
  const plain = tagMp3Bytes(MP3_FRAMES, TAGS);
  assert.deepEqual([...plain.subarray(parseId3v2(plain)!.size)], [...MP3_FRAMES]);
});

test('tagAudioFile: the streamed on-disk result equals the in-memory one; a broken file is left untouched', async () => {
  const dir = tmpDir('disk');
  const src = wav([FMT, chunk('data', noise(300_001, 11))]);
  const f = path.join(dir, 'song.wav');
  fs.writeFileSync(f, src);
  const r = await tagAudioFile(f, TAGS, { mime: 'image/jpeg', data: FAKE_JPEG });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(new Uint8Array(fs.readFileSync(f)), tagWavBytes(src, TAGS, { mime: 'image/jpeg', data: FAKE_JPEG }));
  const m = path.join(dir, 'song.mp3');
  fs.writeFileSync(m, MP3_FRAMES);
  assert.equal((await tagAudioFile(m, TAGS)).ok, true);
  assert.deepEqual(new Uint8Array(fs.readFileSync(m)), tagMp3Bytes(MP3_FRAMES, TAGS));
  const bad = path.join(dir, 'bad.wav');
  fs.writeFileSync(bad, 'garbage, not RIFF');
  const b = await tagAudioFile(bad, TAGS);
  assert.equal(b.ok, false);
  assert.match(b.message, /Not a WAV file/);
  assert.equal(fs.readFileSync(bad, 'utf8'), 'garbage, not RIFF');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp files left');
  assert.match((await tagAudioFile(path.join(dir, 'x.flac'), TAGS)).message, /only be written into WAV and MP3/);
});

function findTool(name: string): string | null {
  const exe = `${name}.exe`;
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  const winget = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const d of fs.readdirSync(winget).filter((n) => /ffmpeg/i.test(n))) {
      for (const sub of fs.readdirSync(path.join(winget, d))) dirs.push(path.join(winget, d, sub, 'bin'));
    }
  } catch {
  }
  for (const d of dirs) {
    for (const f of [path.join(d, exe), path.join(d, name)]) if (d && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

test('ffprobe reads the song info and the attached cover in our WAV and MP3 (skipped without ffmpeg)', async () => {
  const ffmpeg = findTool('ffmpeg');
  const ffprobe = findTool('ffprobe');
  if (!ffmpeg || !ffprobe) {
    console.log('    (skipped: ffmpeg / ffprobe not found)');
    return;
  }
  const dir = tmpDir('ffprobe');
  const gen = (args: string[]) => assert.equal(spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]).status, 0, args.join(' '));
  gen(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s24le', path.join(dir, 'a.wav')]);
  gen(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', '-write_xing', '0', '-id3v2_version', '0', path.join(dir, 'a.mp3')]);
  gen(['-f', 'lavfi', '-i', 'testsrc2=size=320x320:rate=1', '-frames:v', '1', path.join(dir, 'cover.jpg')]);
  const cover = { mime: 'image/jpeg' as const, data: new Uint8Array(fs.readFileSync(path.join(dir, 'cover.jpg'))) };
  const md5 = (f: string) => spawnSync(ffmpeg, ['-v', 'error', '-i', f, '-map', '0:a', '-f', 'md5', '-']).stdout.toString().trim();
  for (const [file, extra] of [
    ['a.wav', {}],
    ['a.mp3', { lengthMs: 2000, gapless: ' 00000000 00000240 000003C0 0000000000015888' }],
  ] as const) {
    const f = path.join(dir, file);
    const before = md5(f);
    const r = await tagAudioFile(f, { ...TAGS, title: 'Café Run', ...extra }, cover);
    assert.equal(r.ok, true, r.message);
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format_tags:stream=codec_type,codec_name:stream_disposition=attached_pic', '-of', 'json', f]);
    const j = JSON.parse(probe.stdout.toString()) as { format: { tags: Record<string, string> }; streams: Array<{ codec_type: string; codec_name: string; disposition: { attached_pic: number } }> };
    const t = Object.fromEntries(Object.entries(j.format.tags).map(([k, v]) => [k.toLowerCase(), v]));
    assert.deepEqual([t.title, t.artist, t.album, t.date, t.genre, t.track], ['Café Run', 'Krypt Test', 'Night Drives', '2026', 'Synthwave', '3'], `${file}: ${JSON.stringify(t)}`);
    const pic = j.streams.find((s) => s.codec_type === 'video');
    assert.ok(pic && pic.disposition.attached_pic === 1 && pic.codec_name === 'mjpeg', `${file}: attached cover ${JSON.stringify(j.streams)}`);
    if (file === 'a.mp3') assert.equal(t.itunsmpb, (extra as { gapless?: string }).gapless, 'the gapless COMM frame reads back, leading space and all');
    assert.equal(md5(f), before, `${file}: decoded audio identical`);
  }
});

function projectWithCover(bytes = FAKE_JPEG): { project: Project; file: string } {
  const host = new DocHost(createDefaultProject('Cover'), CATALOG, { strict: true });
  const file = coverFileName(bytes, 'image/jpeg');
  host.exec('project.setCover', { file, mime: 'image/jpeg', width: 1400, height: 1400 }, { actor: USER });
  return { project: host.project, file };
}

test('container: the cover is stored in the zip, only the referenced one is extracted, and bad names are refused', () => {
  const { project, file } = projectWithCover();
  const stray = coverFileName(FAKE_JPEG_2, 'image/jpeg');
  const bytes = encodeContainer(project, '9.9.9', {}, { [file]: FAKE_JPEG, [stray]: FAKE_JPEG_2 });
  const d = decodeContainer(bytes);
  assert.deepEqual(Object.keys(d.assets), [file], 'only meta.cover.file is extracted');
  assert.deepEqual([...d.assets[file]], [...FAKE_JPEG]);
  const p = validateProject(d.project, d.meta?.schemaVersion);
  assert.deepEqual(p.meta.cover, { file, mime: 'image/jpeg', width: 1400, height: 1400 });
  assert.throws(() => encodeContainer(project, '1', {}, { '../evil.jpg': FAKE_JPEG }), /Can't store/);
  assert.deepEqual(decodeContainer(enc.encode(JSON.stringify(project))).assets, {});
});

test('schema: song info is optional (schema-1 files without it still open); bad covers are refused', () => {
  const old = createDefaultProject('Old') as unknown as Record<string, unknown>;
  const p = validateProject(JSON.parse(JSON.stringify(old)));
  assert.equal(p.meta.title, undefined);
  assert.equal(songInfo(p.meta, 'File Name').title, 'File Name', 'title falls back to the file name, then the project name');
  assert.equal(songInfo({ ...p.meta, author: 'Me' }).artist, 'Me', 'artist falls back to the author');
  const { project } = projectWithCover();
  const bad = JSON.parse(JSON.stringify(project));
  bad.meta.cover.file = '../../cover.jpg';
  assert.throws(() => validateProject(bad), /damaged/);
  const mism = JSON.parse(JSON.stringify(project));
  mism.meta.cover.mime = 'image/png';
  assert.deepEqual(checkIntegrity(mism), [`meta.cover ${mism.meta.cover.file} is not image/png`]);
  const withInfo = JSON.parse(JSON.stringify(project));
  Object.assign(withInfo.meta, { title: 'T', artist: 'A', album: 'B', year: 2026, trackNumber: 3 });
  assert.deepEqual(validateProject(withInfo).meta.year, 2026);
});

test('assets: content-addressed names; adopt checks name, magic and hash', () => {
  const a = new ProjectAssets();
  const s = a.put(FAKE_JPEG, 'image/jpeg');
  assert.match(s.file, /^cover-[0-9a-f]{16}\.jpg$/);
  assert.equal(a.put(FAKE_JPEG, 'image/jpeg'), s, 'same bytes, same entry');
  assert.throws(() => a.put(FAKE_JPEG, 'image/png'), /isn't a PNG/);
  const b = new ProjectAssets();
  assert.equal(b.adopt(s.file, FAKE_JPEG_2), false, 'bytes that do not hash to the name');
  assert.equal(b.adopt('cover.jpg', FAKE_JPEG), false);
  assert.equal(b.adopt(s.file, FAKE_JPEG), true);
});

test('recovery: the snapshot carries the cover, and a cover set after the snapshot comes back from autosave/assets', async () => {
  const dir = tmpDir('recovery');
  const host = new DocHost(createDefaultProject('Crash'), CATALOG);
  const store = new RecoveryStore(dir, 'test', noLog);
  const assets = new ProjectAssets((x) => void store.saveAsset(x.file, x.bytes));
  store.begin();
  host.subscribe((c) => {
    if (c.kind !== 'reset') store.appendChange(c.version, c.patches);
  });
  const first = assets.put(FAKE_JPEG, 'image/jpeg');
  host.exec('project.setCover', { file: first.file, mime: 'image/jpeg', width: 10, height: 10 }, { actor: USER });
  await store.snapshot(host.project, { docVersion: host.version, savedVersion: -1, projectPath: null }, assets.entriesFor(host.project));
  const second = assets.put(FAKE_JPEG_2, 'image/jpeg');
  host.exec('project.setCover', { file: second.file, mime: 'image/jpeg', width: 12, height: 12 }, { actor: USER });
  await store.flush();
  await new Promise((r) => setTimeout(r, 50));
  const s = await new RecoveryStore(dir, 'test', noLog).recover();
  assert.ok(s);
  assert.equal(s.project.meta.cover?.file, second.file);
  assert.deepEqual([...s.assets[second.file]], [...FAKE_JPEG_2]);
  await store.endClean();
  assert.equal(fs.existsSync(path.join(dir, 'assets')), false, 'a clean exit removes the mirrored covers');
});

function service(userData: string) {
  const doc = new DocHost(createDefaultProject('Svc'), CATALOG, { strict: true });
  const svc = new ProjectService({
    doc,
    appVersion: 'test',
    userDataDir: userData,
    factoryDir: path.join(userData, 'factory'),
    documentsDir: userData,
    getSettings: () => ({ recent: [], autosaveSec: 0, browserRoots: [] }) as unknown as Settings,
    addRecent: () => {},
    log: noLog,
  });
  return { doc, svc };
}

test('ProjectService: the cover survives open → save → reopen; a missing cover entry opens without one', async () => {
  const dir = tmpDir('service');
  const { project, file } = projectWithCover();
  const f = path.join(dir, 'song.kstudio');
  fs.writeFileSync(f, encodeContainer(project, 'test', {}, { [file]: FAKE_JPEG }));
  const a = service(path.join(dir, 'ud1'));
  assert.equal((await a.svc.open(f)).ok, true);
  assert.deepEqual([...a.svc.coverImage()!.bytes], [...FAKE_JPEG]);
  const ref = a.svc.storeCover(FAKE_PNG, 'image/png', 64, 64);
  a.doc.exec('project.setCover', ref, { actor: USER });
  a.doc.exec('project.setInfo', { title: 'Reopened', year: 2026 }, { actor: USER });
  assert.equal((await a.svc.save()).ok, true);
  const b = service(path.join(dir, 'ud2'));
  assert.equal((await b.svc.open(f)).ok, true);
  assert.equal(b.doc.project.meta.title, 'Reopened');
  assert.deepEqual([...b.svc.coverImage()!.bytes], [...FAKE_PNG]);
  a.doc.undo(USER);
  a.doc.undo(USER);
  assert.deepEqual([...a.svc.coverImage()!.bytes], [...FAKE_JPEG]);
  const lost = path.join(dir, 'lost.kstudio');
  fs.writeFileSync(lost, encodeContainer(project, 'test'));
  const c = service(path.join(dir, 'ud3'));
  const r = await c.svc.open(lost);
  assert.equal(r.ok, true);
  assert.match(r.message!, /cover image was missing or damaged/);
  assert.equal(c.doc.project.meta.cover, undefined);
});

test('commands: project.setInfo / setCover / clearCover, each one undo step', () => {
  const doc = new DocHost(createDefaultProject('Cmd'), CATALOG, { strict: true });
  const r = doc.exec('project.setInfo', { title: '  Title  ', artist: 'Art', album: 'Alb', year: 2026, genre: 'Trap', trackNumber: 4 }, { actor: USER });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual([doc.project.meta.title, doc.project.meta.artist, doc.project.meta.album, doc.project.meta.year, doc.project.meta.genre, doc.project.meta.trackNumber], ['Title', 'Art', 'Alb', 2026, 'Trap', 4]);
  doc.exec('project.setInfo', { title: '', year: null }, { actor: USER });
  assert.equal('title' in doc.project.meta, false, '"" clears');
  assert.equal('year' in doc.project.meta, false, 'null clears');
  assert.equal(doc.exec('project.setInfo', { year: 99 }, { actor: USER }).ok, false);
  const file = coverFileName(FAKE_JPEG, 'image/jpeg');
  assert.equal(doc.exec('project.setCover', { file, mime: 'image/png', width: 1, height: 1 }, { actor: USER }).ok, false, 'mime must match the name');
  assert.equal(doc.exec('project.setCover', { file: 'evil.jpg', mime: 'image/jpeg', width: 1, height: 1 }, { actor: USER }).ok, false);
  assert.equal(doc.exec('project.setCover', { file, mime: 'image/jpeg', width: 1400, height: 1400 }, { actor: USER }).ok, true);
  assert.equal(doc.exec('project.clearCover', {}, { actor: USER }).ok, true);
  assert.equal(doc.project.meta.cover, undefined);
  assert.match(doc.exec('project.clearCover', {}, { actor: USER }).message ?? '', /no cover image/);
  doc.undo(USER);
  const coverNow = () => doc.project.meta.cover;
  assert.equal(coverNow()?.file, file, 'undo brings the cover back');
  doc.undo(USER);
  assert.equal(doc.project.meta.cover, undefined);
  doc.undo(USER);
  assert.equal(doc.project.meta.title, 'Title');
  assert.equal(checkIntegrity(doc.project).length, 0);
});

function fakeNormalize(bytes: Uint8Array) {
  if (bytes[0] !== 0xff && bytes[0] !== 0x89) throw new Error("That file isn't a PNG or JPEG image.");
  return { bytes, mime: bytes[0] === 0x89 ? ('image/png' as const) : ('image/jpeg' as const), width: 1400, height: 1400, sourceWidth: 3000, sourceHeight: 2000 };
}

const SETTINGS = (folder: 'music' | 'project' = 'music'): Settings => ({
  audio: { deviceId: null, bufferFrames: 256, sampleRate: 48000 },
  ui: { scale: 1, showHints: true },
  browserRoots: [],
  recent: [],
  autosaveSec: 60,
  mcp: { enabled: true, httpEnabled: false, httpPort: 47800, requireConsentForDestructive: false, fileAccess: 'anywhere' },
  agent: { model: 'claude-opus-5-5', hasApiKey: false },
  discordRpc: false,
  export: { folder },
});

function rig(opts: { folder?: 'music' | 'project'; projectPath?: string | null; failRender?: boolean; draw?: (r: { style?: string; seed?: number }) => Promise<CoverDrawResult> } = {}) {
  const root = tmpDir('rig');
  const doc = new DocHost(createDefaultProject('Release'), CATALOG, { strict: true });
  const assets = new ProjectAssets();
  const status = () => ({ path: opts.projectPath ?? null, name: 'My Song', dirty: false, lastSavedAt: null, recovered: false });
  const coverImage = () => {
    const ref = doc.project.meta.cover;
    const a = ref ? assets.get(ref.file) : null;
    return ref && a ? { ...ref, bytes: a.bytes } : null;
  };
  const projectOps = {
    status,
    coverImage,
    storeCover(bytes: Uint8Array, mime: 'image/png' | 'image/jpeg', width: number, height: number) {
      const a = assets.put(bytes, mime);
      return { file: a.file, mime: a.mime, width, height };
    },
  };
  const covers = new CoverService({
    project: projectOps,
    normalize: fakeNormalize,
    fileSize: (p) => (fs.existsSync(p) ? fs.statSync(p).size : null),
    readFile: async (p) => new Uint8Array(fs.readFileSync(p)),
    draw: opts.draw,
    maxSourceBytes: 20 * 1024 * 1024,
  });
  const renders: RenderRequest[] = [];
  const exporter = new ExportService({
    doc,
    engine: {
      async render(job) {
        renders.push(job);
        if (opts.failRender) return { ok: false, message: 'The audio engine crashed' };
        const mp3 = job.format === 'mp3';
        fs.writeFileSync(job.path, mp3 ? MP3_FRAMES : wav([FMT, chunk('data', noise(4800, 1))]));
        return {
          ok: true,
          data: {
            path: job.path,
            files: [job.path],
            durationSec: 2,
            peakDb: -1.2,
            lufsIntegrated: -12.3,
            analysis: { truePeakDb: -1.0, lufsIntegrated: -12.3 } as never,
            ...(mp3 ? { mp3: { sampleRate: 44100, kbps: job.mp3Kbps ?? 320, samples: 88200, encoderDelay: 672, endPadding: 900, itunSmpb: ' 00000000 000002A0 00000384 0000000000015888' } } : {}),
          },
        };
      },
    },
    project: { status, coverImage },
    getSettings: () => SETTINGS(opts.folder),
    musicDir: path.join(root, 'Music'),
    tag: tagAudioFile,
    log: noLog,
  });
  const deps = {
    doc,
    project: { status, resolveSamplePath: (p: string) => p, allowedRoots: () => [], renderDir: () => root, save: async () => ({ ok: true }) },
    getSettings: () => SETTINGS(opts.folder),
    updateSettings: () => SETTINGS(opts.folder),
    broadcast: () => {},
    log: noLog,
    covers,
    exporter,
  } as unknown as MainDeps;
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'rel', name: 'Release Agent' }, session: newSession(), via: 'test' };
  const call = (name: string, args: unknown = {}) => callTool(deps, caller, name, args, { quiet: true });
  const arrange = () => {
    const p = doc.project;
    const r = doc.exec('playlist.addClip', { kind: 'pattern', trackId: p.playlist.trackOrder[0], start: 0, patternId: p.transport.activePatternId }, { actor: USER });
    assert.equal(r.ok, true, r.message);
  };
  return { root, doc, assets, covers, exporter, renders, call, caller, arrange };
}

test('CoverService: normalizes and stores, explains crops, enforces 20 MB, and needs a window to generate', async () => {
  const r = rig();
  const out = r.covers.fromBytes(FAKE_JPEG, 'The image');
  assert.match(out.message, /cropped from 3000×2000 to a square, 1400×1400 px/);
  assert.equal(r.assets.get(out.ref.file)?.bytes.length, FAKE_JPEG.length);
  assert.throws(() => r.covers.fromBytes(new Uint8Array(21 * 1024 * 1024)), /Pick one under 20\.0 MB/);
  await assert.rejects(r.covers.fromFile(path.join(r.root, 'missing.png')), /Image not found/);
  await assert.rejects(r.covers.generate({}), /window isn't open/);
});

test('set_song_info → export_audio: a new tagged WAV in Music\\Krypt Studio, never overwriting; MP3 adds TLEN + gapless', async () => {
  const r = rig();
  r.arrange();
  const info = await r.call('set_song_info', { title: 'Night Drive', album: 'Late', year: '2026', genre: 'Synthwave', track: 2 });
  assert.equal(info.ok, true, info.message);
  assert.match(info.message, /title "Night Drive".*album "Late".*year 2026.*track 2.*no cover yet/);
  fs.writeFileSync(path.join(r.root, 'cover.jpg'), FAKE_JPEG);
  const cov = await r.call('set_cover', { path: path.join(r.root, 'cover.jpg') });
  assert.equal(cov.ok, true, cov.message);
  assert.match(cov.message, /"cover\.jpg" is the cover \(cropped/);
  const a = await r.call('export_audio', {});
  assert.equal(a.ok, true, a.message);
  const d = a.data as { path: string; tagged: boolean; lufsIntegrated: number; truePeakDb: number };
  assert.equal(d.path, path.join(r.root, 'Music', 'Krypt Studio', 'Night Drive.wav'));
  assert.deepEqual([d.tagged, d.lufsIntegrated, d.truePeakDb], [true, -12.3, -1]);
  assert.match(a.message, /-12\.3 LUFS integrated, true peak -1 dBTP\. Song info embedded \(title "Night Drive", cover\)/);
  const w = new Uint8Array(fs.readFileSync(d.path));
  assert.equal(readWavInfo(w).INAM, 'Night Drive');
  assert.equal(readWavInfo(w).IPRD, 'Late');
  const b = await r.call('export_audio', { format: 'mp3', mp3_kbps: 192 });
  const bp = (b.data as { path: string }).path;
  assert.equal(bp, path.join(r.root, 'Music', 'Krypt Studio', 'Night Drive.mp3'));
  assert.equal(r.renders.at(-1)!.mp3Kbps, 192);
  const again = await r.call('export_audio', {});
  assert.equal((again.data as { path: string }).path, path.join(r.root, 'Music', 'Krypt Studio', 'Night Drive (2).wav'), 'never overwrites');
  const mp3 = new Uint8Array(fs.readFileSync(bp));
  const tag = frameMap(mp3.subarray(0, parseId3v2(mp3)!.size));
  assert.equal(id3FrameText(tag.get('TLEN')!), '2000');
  assert.equal(parseComm(tag.get('COMM')!).description, 'iTunSMPB');
  assert.deepEqual([...parseApic(tag.get('APIC')!).image], [...FAKE_JPEG]);
  assert.equal((await r.call('export_audio', { format: 'mp3', mp3_kbps: 100 })).ok, false, 'bitrates outside the list are refused');
  assert.equal(r.doc.getHistory().length, 3, 'the clip, the song info and the cover: exports change nothing in the project');
});

test('export_audio: named files, the project folder setting, empty songs, and a failed render leaves no file behind', async () => {
  const saved = rig({ folder: 'project', projectPath: path.join(TMP, 'proj', 'Song.kstudio') });
  fs.mkdirSync(path.join(TMP, 'proj'), { recursive: true });
  const named = await saved.call('export_audio', { scope: 'pattern', name: 'Hook: v2?' });
  assert.equal(named.ok, true, named.message);
  assert.equal((named.data as { path: string }).path, path.join(TMP, 'proj', `${safeFileName('Hook: v2?')}.wav`));
  assert.equal(saved.renders[0].scope.kind, 'pattern');
  const unsaved = rig({ folder: 'project' });
  const u = await unsaved.call('export_audio', { scope: 'pattern' });
  assert.match(u.message, /the project isn't saved yet, so it went to the Music folder/);
  const empty = rig();
  assert.match((await empty.call('export_audio', {})).message, /The Playlist is empty/);
  const broken = rig({ failRender: true });
  const f = await broken.call('export_audio', { scope: 'pattern' });
  assert.equal(f.ok, false);
  assert.match(f.message, /The audio engine crashed/);
  assert.deepEqual(fs.readdirSync(path.join(broken.root, 'Music', 'Krypt Studio')), [], 'the placeholder is removed');
});

test('set_cover {generate}: drawn by the window, undoable; path and generate are exclusive; non-images refused', async () => {
  const asked: Array<{ style?: string; seed?: number }> = [];
  const r = rig({ draw: async (req) => (asked.push(req), { ok: true, bytes: FAKE_JPEG_2, mime: 'image/jpeg', style: req.style ?? 'waves', seed: req.seed ?? 1 }) });
  const g = await r.call('set_cover', { generate: true, style: 'orbit', seed: 7 });
  assert.equal(g.ok, true, g.message);
  assert.deepEqual(asked, [{ style: 'orbit', seed: 7 }]);
  assert.match(g.message, /style "orbit", seed 7/);
  assert.equal(r.doc.project.meta.cover?.file, coverFileName(FAKE_JPEG_2, 'image/jpeg'));
  assert.equal((await r.call('undo_last')).ok, true);
  assert.equal(r.doc.project.meta.cover, undefined);
  fs.writeFileSync(path.join(r.root, 'pic.png'), FAKE_PNG);
  assert.match((await r.call('set_cover', { generate: true, path: path.join(r.root, 'pic.png') })).message, /either path .* or generate/);
  fs.writeFileSync(path.join(r.root, 'notes.txt'), 'x');
  assert.match((await r.call('set_cover', { path: path.join(r.root, 'notes.txt') })).message, /is not a PNG or JPEG image/);
  assert.match((await r.call('set_cover', { path: '\\\\server\\share\\cover.png' })).message, /Network \(UNC\)/);
  const failing = rig({ draw: async () => ({ ok: false, message: "Couldn't draw the cover: no canvas" }) });
  assert.match((await failing.call('set_cover', { generate: true })).message, /no canvas/);
  assert.deepEqual(['set_song_info', 'set_cover', 'export_audio'].map((t) => getTool(t)?.kind), ['write', 'write', 'transport']);
});

await run('song info + cover');
fs.rmSync(TMP, { recursive: true, force: true });
