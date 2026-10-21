export interface SmfNote {
  tick: number;
  dur: number;
  key: number;
  vel: number;
  channel: number;
}

export interface SmfTrack {
  name: string;
  program: number | null;
  notes: SmfNote[];
}

export interface SmfTempo {
  tick: number;
  bpm: number;
}

export interface SmfTimeSig {
  tick: number;
  num: number;
  den: number;
}

export interface SmfFile {
  format: 0 | 1 | 2;
  ppq: number;
  tracks: SmfTrack[];
  tempos: SmfTempo[];
  timeSigs: SmfTimeSig[];
}

export class SmfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmfError';
  }
}

class Reader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }
  get done(): boolean {
    return this.pos >= this.end;
  }
  u8(): number {
    if (this.pos >= this.end) throw new SmfError('Unexpected end of MIDI data');
    return this.buf[this.pos++];
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u32(): number {
    return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8();
  }
  ascii(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return v >>> 0;
    }
    return v >>> 0;
  }
  bytes(n: number): Uint8Array {
    const take = Math.max(0, Math.min(n, this.end - this.pos));
    const out = this.buf.subarray(this.pos, this.pos + take);
    this.pos += take;
    return out;
  }
}

function decodeText(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/\0+$/, '').trim();
  } catch {
    let s = '';
    for (const c of b) s += String.fromCharCode(c);
    return s.replace(/\0+$/, '').trim();
  }
}

function unwrapRiff(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes);
  if (bytes.length < 12 || r.ascii(4) !== 'RIFF') return bytes;
  r.pos = 8;
  if (r.ascii(4) !== 'RMID') return bytes;
  while (r.pos + 8 <= bytes.length) {
    const id = r.ascii(4);
    const len = r.u8() | (r.u8() << 8) | (r.u8() << 16) | ((r.u8() << 24) >>> 0);
    if (id === 'data') return bytes.subarray(r.pos, Math.min(bytes.length, r.pos + len));
    r.pos += len + (len & 1);
  }
  throw new SmfError('RIFF MIDI file has no data chunk');
}

interface OpenNote {
  tick: number;
  vel: number;
}

function readTrack(
  r: Reader,
  tempos: SmfTempo[],
  timeSigs: SmfTimeSig[],
): SmfTrack {
  const track: SmfTrack = { name: '', program: null, notes: [] };
  let instrument = '';
  let tick = 0;
  let running = 0;
  const open = new Map<number, OpenNote[]>();

  const noteOff = (ch: number, key: number, at: number): void => {
    const q = open.get((ch << 7) | key);
    const n = q?.shift();
    if (!n) return;
    track.notes.push({ tick: n.tick, dur: Math.max(1, at - n.tick), key, vel: n.vel, channel: ch });
  };

  try {
    while (!r.done) {
      tick += r.vlq();
      let status = r.u8();
      if (status < 0x80) {
        if (!running) throw new SmfError('Corrupt MIDI track (data byte without status)');
        status = running;
        r.pos--;
      }
      if (status === 0xff) {
        running = 0;
        const type = r.u8();
        const len = r.vlq();
        const data = r.bytes(len);
        if (type === 0x2f) break;
        if (type === 0x03 && !track.name) track.name = decodeText(data);
        else if (type === 0x04 && !instrument) instrument = decodeText(data);
        else if (type === 0x51 && data.length >= 3) {
          const usPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2];
          if (usPerQuarter > 0) tempos.push({ tick, bpm: 60_000_000 / usPerQuarter });
        } else if (type === 0x58 && data.length >= 2) {
          timeSigs.push({ tick, num: Math.max(1, data[0]), den: 2 ** Math.min(data[1], 6) });
        }
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        running = 0;
        r.bytes(r.vlq());
        continue;
      }
      if (status >= 0xf1) {
        running = 0;
        continue;
      }
      running = status;
      const kind = status & 0xf0;
      const ch = status & 0x0f;
      const d1 = r.u8() & 0x7f;
      const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : r.u8() & 0x7f;
      if (kind === 0x90 && d2 > 0) {
        const k = (ch << 7) | d1;
        let q = open.get(k);
        if (!q) open.set(k, (q = []));
        q.push({ tick, vel: d2 });
      } else if (kind === 0x80 || kind === 0x90) {
        noteOff(ch, d1, tick);
      } else if (kind === 0xc0 && track.program === null) {
        track.program = d1;
      }
    }
  } catch (err) {
    if (!(err instanceof SmfError) || !/Unexpected end/.test(err.message)) throw err;
  }

  for (const [k, q] of open) {
    for (const n of q) track.notes.push({ tick: n.tick, dur: Math.max(1, tick - n.tick), key: k & 0x7f, vel: n.vel, channel: k >> 7 });
  }
  if (!track.name && instrument) track.name = instrument;
  track.notes.sort((a, b) => a.tick - b.tick || a.key - b.key);
  return track;
}

export function readSmf(input: Uint8Array): SmfFile {
  const bytes = unwrapRiff(input);
  const r = new Reader(bytes);
  if (bytes.length < 14 || r.ascii(4) !== 'MThd') throw new SmfError('Not a MIDI file (missing MThd header)');
  const hlen = r.u32();
  const hdrEnd = r.pos + hlen;
  const format = r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  r.pos = hdrEnd;
  if (format > 2) throw new SmfError(`Unsupported MIDI format ${format}`);

  let ppq: number;
  if (division & 0x8000) {
    const fps = 256 - (division >> 8);
    const tpf = division & 0xff;
    ppq = Math.max(1, Math.round(fps * tpf * 0.5));
  } else {
    ppq = division;
  }
  if (ppq <= 0) throw new SmfError('Invalid MIDI time division');

  const tempos: SmfTempo[] = [];
  const timeSigs: SmfTimeSig[] = [];
  const tracks: SmfTrack[] = [];
  while (r.pos + 8 <= bytes.length && tracks.length < ntrks) {
    const id = r.ascii(4);
    const len = r.u32();
    const start = r.pos;
    const end = Math.min(bytes.length, start + len);
    if (id === 'MTrk') tracks.push(readTrack(new Reader(bytes, start, end), tempos, timeSigs));
    r.pos = end;
  }
  if (tracks.length === 0) throw new SmfError('MIDI file contains no tracks');

  tempos.sort((a, b) => a.tick - b.tick);
  timeSigs.sort((a, b) => a.tick - b.tick);
  return { format: format as 0 | 1 | 2, ppq, tracks, tempos, timeSigs };
}

export function convertPpq(file: SmfFile, ppq = 960): SmfFile {
  if (file.ppq === ppq) return file;
  const s = ppq / file.ppq;
  const t = (x: number): number => Math.round(x * s);
  return {
    ...file,
    ppq,
    tempos: file.tempos.map((e) => ({ ...e, tick: t(e.tick) })),
    timeSigs: file.timeSigs.map((e) => ({ ...e, tick: t(e.tick) })),
    tracks: file.tracks.map((tr) => ({
      ...tr,
      notes: tr.notes.map((n) => ({ ...n, tick: t(n.tick), dur: Math.max(1, t(n.tick + n.dur) - t(n.tick)) })),
    })),
  };
}

interface TimedEvent {
  tick: number;
  order: number;
  data: number[];
}

function vlqBytes(v: number): number[] {
  let n = Math.max(0, Math.min(0x0fffffff, Math.floor(v)));
  const out = [n & 0x7f];
  n >>>= 7;
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  return out;
}

function textMeta(type: number, s: string): number[] {
  const b = Array.from(new TextEncoder().encode(s));
  return [0xff, type, ...vlqBytes(b.length), ...b];
}

function tempoMeta(bpm: number): number[] {
  const us = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / bpm)));
  return [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
}

function timeSigMeta(num: number, den: number): number[] {
  const pow = Math.max(0, Math.min(6, Math.round(Math.log2(Math.max(1, den)))));
  return [0xff, 0x58, 0x04, Math.max(1, Math.min(255, num)) & 0xff, pow, 24, 8];
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function noteEvents(notes: SmfNote[], fallbackChannel: number): TimedEvent[] {
  const ev: TimedEvent[] = [];
  for (const n of notes) {
    const ch = clamp(Math.round(n.channel ?? fallbackChannel), 0, 15);
    const key = clamp(Math.round(n.key), 0, 127);
    const vel = clamp(Math.round(n.vel), 1, 127);
    const on = Math.max(0, Math.round(n.tick));
    ev.push({ tick: on, order: 3, data: [0x90 | ch, key, vel] });
    ev.push({ tick: on + Math.max(1, Math.round(n.dur)), order: 2, data: [0x80 | ch, key, 0] });
  }
  return ev;
}

function chunk(events: TimedEvent[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const e of events) {
    body.push(...vlqBytes(e.tick - last), ...e.data);
    last = e.tick;
  }
  body.push(0x00, 0xff, 0x2f, 0x00);
  const len = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...body];
}

function conductorEvents(file: SmfFile): TimedEvent[] {
  const ev: TimedEvent[] = [];
  for (const t of file.tempos) ev.push({ tick: Math.round(t.tick), order: 0, data: tempoMeta(t.bpm) });
  for (const s of file.timeSigs) ev.push({ tick: Math.round(s.tick), order: 0, data: timeSigMeta(s.num, s.den) });
  return ev;
}

export function writeSmf(file: SmfFile): Uint8Array {
  const ppq = clamp(Math.round(file.ppq), 1, 0x7fff);
  const tracks: number[][] = [];
  if (file.format === 0) {
    const ev = conductorEvents(file);
    const name = file.tracks.find((t) => t.name)?.name;
    if (name) ev.push({ tick: 0, order: 0, data: textMeta(0x03, name) });
    file.tracks.forEach((t, i) => ev.push(...noteEvents(t.notes, i)));
    tracks.push(chunk(ev));
  } else {
    tracks.push(chunk(conductorEvents(file)));
    file.tracks.forEach((t, i) => {
      const ev: TimedEvent[] = [];
      if (t.name) ev.push({ tick: 0, order: 0, data: textMeta(0x03, t.name) });
      const ch = t.notes[0]?.channel ?? i % 16;
      if (t.program !== null && t.program !== undefined) ev.push({ tick: 0, order: 1, data: [0xc0 | ch, clamp(t.program, 0, 127)] });
      ev.push(...noteEvents(t.notes, ch));
      tracks.push(chunk(ev));
    });
  }
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, file.format === 0 ? 0 : 1, (tracks.length >> 8) & 0xff, tracks.length & 0xff, (ppq >> 8) & 0xff, ppq & 0xff];
  let total = header.length;
  for (const t of tracks) total += t.length;
  const out = new Uint8Array(total);
  out.set(header, 0);
  let off = header.length;
  for (const t of tracks) {
    out.set(t, off);
    off += t.length;
  }
  return out;
}
