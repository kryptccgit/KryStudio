export interface SongTags {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  genre?: string;
  track?: string;
  software?: string;
  lengthMs?: number;
  gapless?: string;
}

type TextTag = 'title' | 'artist' | 'album' | 'year' | 'genre' | 'track' | 'software';

export interface TagPicture {
  mime: 'image/jpeg' | 'image/png';
  data: Uint8Array;
}

export class TagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TagError';
  }
}

export type TagPart = { copy: [offset: number, length: number] } | { bytes: Uint8Array };

export interface TagPlan {
  parts: TagPart[];
  size: number;
}

export type ByteReader = (offset: number, length: number) => Uint8Array;

const MAX_TEXT = 1000;

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0x7f);
const fromAscii = (b: Uint8Array): string => String.fromCharCode(...b);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function u32le(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

const readU32le = (b: Uint8Array, o = 0): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const readU32be = (b: Uint8Array, o = 0): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

export function synchsafe(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n >= 1 << 28) throw new TagError(`An ID3 tag can't hold ${n} bytes`);
  return Uint8Array.of((n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f);
}

export function readSynchsafe(b: Uint8Array, o = 0): number {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

export function cleanTagText(s: string | undefined | null, max = MAX_TEXT): string {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max) : t;
}

const isLatin1 = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return false;
  return true;
};

function encodeId3Text(s: string, terminate: boolean): { enc: number; bytes: Uint8Array } {
  if (isLatin1(s)) {
    const b = new Uint8Array(s.length + (terminate ? 1 : 0));
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return { enc: 0, bytes: b };
  }
  const b = new Uint8Array(2 + s.length * 2 + (terminate ? 2 : 0));
  b[0] = 0xff;
  b[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[2 + i * 2] = c & 0xff;
    b[3 + i * 2] = c >>> 8;
  }
  return { enc: 1, bytes: b };
}

function id3Frame(id: string, body: Uint8Array): Uint8Array {
  return concat([ascii(id), u32be(body.length), Uint8Array.of(0, 0), body]);
}

function textFrame(id: string, value: string): Uint8Array {
  const t = encodeId3Text(value, false);
  return id3Frame(id, concat([Uint8Array.of(t.enc), t.bytes]));
}

function commFrame(lang: string, description: string, text: string): Uint8Array {
  const latin = isLatin1(description) && isLatin1(text);
  const d = latin ? encodeId3Text(description, true) : utf16(description, true);
  const t = latin ? encodeId3Text(text, false) : utf16(text, false);
  return id3Frame('COMM', concat([Uint8Array.of(latin ? 0 : 1), ascii(lang.padEnd(3, ' ').slice(0, 3)), d.bytes, t.bytes]));
}

function utf16(s: string, terminate: boolean): { enc: number; bytes: Uint8Array } {
  const b = new Uint8Array(2 + s.length * 2 + (terminate ? 2 : 0));
  b[0] = 0xff;
  b[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[2 + i * 2] = c & 0xff;
    b[3 + i * 2] = c >>> 8;
  }
  return { enc: 1, bytes: b };
}

function apicFrame(pic: TagPicture): Uint8Array {
  return id3Frame('APIC', concat([Uint8Array.of(0), ascii(pic.mime), Uint8Array.of(0, 0x03, 0), pic.data]));
}

const ID3_FRAMES: Array<[TextTag, string]> = [
  ['title', 'TIT2'],
  ['artist', 'TPE1'],
  ['album', 'TALB'],
  ['year', 'TYER'],
  ['genre', 'TCON'],
  ['track', 'TRCK'],
  ['software', 'TSSE'],
];

export function buildId3v23(tags: SongTags, picture?: TagPicture | null, padding = 0): Uint8Array {
  const frames: Uint8Array[] = [];
  for (const [key, id] of ID3_FRAMES) {
    let v = cleanTagText(tags[key]);
    if (key === 'year') v = /^\d{4}$/.test(v) ? v : '';
    if (key === 'track') v = /^\d{1,3}(\/\d{1,3})?$/.test(v) ? v : '';
    if (v) frames.push(textFrame(id, v));
  }
  if (Number.isFinite(tags.lengthMs) && (tags.lengthMs ?? 0) > 0) frames.push(textFrame('TLEN', String(Math.round(tags.lengthMs!))));
  const gapless = String(tags.gapless ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
  if (gapless.trim()) frames.push(commFrame('eng', 'iTunSMPB', gapless));
  if (picture && picture.data.length) frames.push(apicFrame(picture));
  const body = concat([...frames, new Uint8Array(Math.max(0, padding))]);
  return concat([ascii('ID3'), Uint8Array.of(3, 0, 0), synchsafe(body.length), body]);
}

export interface Id3Frame {
  id: string;
  data: Uint8Array;
}

export interface ParsedId3 {
  major: number;
  size: number;
  frames: Id3Frame[];
}

export function id3TagLength(head: Uint8Array): number {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  if (head[3] === 0xff || head[4] === 0xff || head[6] & 0x80 || head[7] & 0x80 || head[8] & 0x80 || head[9] & 0x80) return 0;
  const footer = head[3] === 4 && head[5] & 0x10 ? 10 : 0;
  return 10 + readSynchsafe(head, 6) + footer;
}

export function parseId3v2(b: Uint8Array): ParsedId3 | null {
  const size = id3TagLength(b);
  if (!size || size > b.length) return null;
  const major = b[3];
  const flags = b[5];
  const frames: Id3Frame[] = [];
  if (major < 3 || major > 4 || flags & 0x80) return { major, size, frames };
  let o = 10;
  if (flags & 0x40) o += major === 4 ? readSynchsafe(b, 10) : 4 + readU32be(b, 10);
  const end = 10 + readSynchsafe(b, 6);
  while (o + 10 <= end) {
    if (b[o] === 0) break;
    const id = fromAscii(b.subarray(o, o + 4));
    const len = major === 4 ? readSynchsafe(b, o + 4) : readU32be(b, o + 4);
    if (!/^[A-Z0-9]{4}$/.test(id) || o + 10 + len > end) break;
    frames.push({ id, data: b.subarray(o + 10, o + 10 + len) });
    o += 10 + len;
  }
  return { major, size, frames };
}

export function id3FrameText(data: Uint8Array): string {
  const enc = data[0];
  const body = data.subarray(1);
  let s: string;
  if (enc === 0) s = String.fromCharCode(...body);
  else if (enc === 3) s = new TextDecoder('utf-8').decode(body);
  else {
    let le = enc === 1;
    let o = 0;
    if (enc === 1 && body.length >= 2) {
      le = !(body[0] === 0xfe && body[1] === 0xff);
      o = body[0] === 0xff || body[0] === 0xfe ? 2 : 0;
    }
    let out = '';
    for (; o + 1 < body.length; o += 2) out += String.fromCharCode(le ? body[o] | (body[o + 1] << 8) : (body[o] << 8) | body[o + 1]);
    s = out;
  }
  return s.replace(/\u0000+$/, '');
}

export function parseComm(data: Uint8Array): { lang: string; description: string; text: string } {
  const enc = data[0];
  const lang = fromAscii(data.subarray(1, 4));
  let o = 4;
  if (enc === 1 || enc === 2) {
    while (o + 1 < data.length && !(data[o] === 0 && data[o + 1] === 0)) o += 2;
    return { lang, description: id3FrameText(Uint8Array.of(enc, ...data.subarray(4, o))), text: id3FrameText(Uint8Array.of(enc, ...data.subarray(o + 2))) };
  }
  while (o < data.length && data[o] !== 0) o++;
  return { lang, description: id3FrameText(Uint8Array.of(enc, ...data.subarray(4, o))), text: id3FrameText(Uint8Array.of(enc, ...data.subarray(o + 1))) };
}

export function parseApic(data: Uint8Array): { mime: string; type: number; description: string; image: Uint8Array } {
  const enc = data[0];
  let o = 1;
  while (o < data.length && data[o] !== 0) o++;
  const mime = fromAscii(data.subarray(1, o));
  o++;
  const type = data[o++];
  const d0 = o;
  if (enc === 1 || enc === 2) {
    while (o + 1 < data.length && !(data[o] === 0 && data[o + 1] === 0)) o += 2;
    const description = id3FrameText(Uint8Array.of(enc, ...data.subarray(d0, o)));
    o += 2;
    return { mime, type, description, image: data.subarray(o) };
  }
  while (o < data.length && data[o] !== 0) o++;
  const description = enc === 3 ? new TextDecoder().decode(data.subarray(d0, o)) : String.fromCharCode(...data.subarray(d0, o));
  return { mime, type, description, image: data.subarray(o + 1) };
}

export function planMp3Tags(read: ByteReader, size: number, tags: SongTags, picture?: TagPicture | null): TagPlan {
  let start = 0;
  for (let guard = 0; guard < 4 && start + 10 <= size; guard++) {
    const n = id3TagLength(read(start, 10));
    if (!n) break;
    start += n;
  }
  if (start > size) throw new TagError('The MP3 starts with a broken ID3 tag');
  let end = size;
  if (end - start >= 128 && fromAscii(read(end - 128, 3)) === 'TAG') end -= 128;
  if (end <= start) throw new TagError('The MP3 has no audio after its tags');
  const tag = buildId3v23(tags, picture, 512);
  return { parts: [{ bytes: tag }, { copy: [start, end - start] }], size: tag.length + (end - start) };
}

export interface RiffChunk {
  id: string;
  offset: number;
  size: number;
  listType?: string;
  padMissing?: boolean;
}

export function scanRiff(read: ByteReader, size: number): RiffChunk[] {
  if (size < 12) throw new TagError('Not a WAV file (too short)');
  const head = read(0, 12);
  const form = fromAscii(head.subarray(0, 4));
  if (form === 'RF64' || form === 'BW64') throw new TagError("WAV files over 4 GB (RF64) can't carry song info yet");
  if (form !== 'RIFF' || fromAscii(head.subarray(8, 12)) !== 'WAVE') throw new TagError('Not a WAV file (no RIFF/WAVE header)');
  const chunks: RiffChunk[] = [];
  let o = 12;
  while (o + 8 <= size) {
    const h = read(o, 8);
    const id = fromAscii(h.subarray(0, 4));
    const len = readU32le(h, 4);
    if (!/^[\x20-\x7e]{4}$/.test(id)) throw new TagError(`The WAV has a damaged chunk at byte ${o}`);
    const end = o + 8 + len;
    if (end > size) throw new TagError(`The WAV's "${id.trim()}" chunk claims more bytes than the file has`);
    const c: RiffChunk = { id, offset: o, size: len };
    if (id === 'LIST' && len >= 4) c.listType = fromAscii(read(o + 8, 4));
    if (len & 1 && end === size) c.padMissing = true;
    chunks.push(c);
    o = end + (len & 1);
  }
  if (!chunks.some((c) => c.id === 'fmt ')) throw new TagError('The WAV has no fmt chunk');
  if (!chunks.some((c) => c.id === 'data')) throw new TagError('The WAV has no data chunk');
  return chunks;
}

const INFO_IDS: Array<[TextTag, string]> = [
  ['title', 'INAM'],
  ['artist', 'IART'],
  ['album', 'IPRD'],
  ['year', 'ICRD'],
  ['genre', 'IGNR'],
  ['track', 'ITRK'],
  ['software', 'ISFT'],
];

export function buildInfoChunk(tags: SongTags): Uint8Array | null {
  const enc = new TextEncoder();
  const subs: Uint8Array[] = [];
  for (const [key, id] of INFO_IDS) {
    const v = cleanTagText(tags[key]);
    if (!v) continue;
    const text = enc.encode(v);
    const len = text.length + 1;
    subs.push(concat([ascii(id), u32le(len), text, new Uint8Array(1 + (len & 1))]));
  }
  if (!subs.length) return null;
  const body = concat([ascii('INFO'), ...subs]);
  return concat([ascii('LIST'), u32le(body.length), body]);
}

export function buildId3Chunk(tags: SongTags, picture?: TagPicture | null): Uint8Array {
  const tag = buildId3v23(tags, picture);
  return concat([ascii('id3 '), u32le(tag.length), tag, new Uint8Array(tag.length & 1)]);
}

const isOldTagChunk = (c: RiffChunk): boolean => (c.id === 'LIST' && c.listType === 'INFO') || c.id === 'id3 ' || c.id === 'ID3 ';

export function planWavTags(chunks: RiffChunk[], tags: SongTags, picture?: TagPicture | null): TagPlan {
  const info = buildInfoChunk(tags);
  const id3 = buildId3Chunk(tags, picture);
  const parts: TagPart[] = [];
  let size = 12;
  const add = (p: TagPart): void => {
    parts.push(p);
    size += 'copy' in p ? p.copy[1] : p.bytes.length;
  };
  parts.push({ bytes: new Uint8Array(12) });
  for (const c of chunks) {
    if (isOldTagChunk(c)) continue;
    const padded = c.size & 1;
    if (c.padMissing) {
      add({ copy: [c.offset, 8 + c.size] });
      add({ bytes: new Uint8Array(1) });
    } else add({ copy: [c.offset, 8 + c.size + padded] });
  }
  if (info) add({ bytes: info });
  add({ bytes: id3 });
  if (size - 8 > 0xffffffff) throw new TagError('The tagged WAV would pass the 4 GB WAV limit');
  parts[0] = { bytes: concat([ascii('RIFF'), u32le(size - 8), ascii('WAVE')]) };
  return { parts, size };
}

export function applyTagPlan(src: Uint8Array, plan: TagPlan): Uint8Array {
  const out = new Uint8Array(plan.size);
  let o = 0;
  for (const p of plan.parts) {
    const b = 'copy' in p ? src.subarray(p.copy[0], p.copy[0] + p.copy[1]) : p.bytes;
    out.set(b, o);
    o += b.length;
  }
  return out;
}

export const memoryReader =
  (b: Uint8Array): ByteReader =>
  (offset, length) =>
    b.subarray(offset, offset + length);

export function tagWavBytes(src: Uint8Array, tags: SongTags, picture?: TagPicture | null): Uint8Array {
  return applyTagPlan(src, planWavTags(scanRiff(memoryReader(src), src.length), tags, picture));
}

export function tagMp3Bytes(src: Uint8Array, tags: SongTags, picture?: TagPicture | null): Uint8Array {
  return applyTagPlan(src, planMp3Tags(memoryReader(src), src.length, tags, picture));
}

export function readWavInfo(src: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of scanRiff(memoryReader(src), src.length)) {
    if (c.id !== 'LIST' || c.listType !== 'INFO') continue;
    let o = c.offset + 12;
    const end = c.offset + 8 + c.size;
    while (o + 8 <= end) {
      const id = fromAscii(src.subarray(o, o + 4));
      const len = readU32le(src, o + 4);
      out[id] = new TextDecoder().decode(src.subarray(o + 8, o + 8 + len)).replace(/\u0000+$/, '');
      o += 8 + len + (len & 1);
    }
  }
  return out;
}
