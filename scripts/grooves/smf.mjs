// Minimal Standard MIDI File reader for the groove extractor (scripts/grooves/extract.mjs).
// Reads note-ons with absolute ticks, the time division, tempo and time-signature events.
// Formats 0 and 1, running status, sysex and meta events skipped safely. Input is treated as
// untrusted data: every read is bounds-checked and a malformed file throws, never hangs.
//
// The app's full reader/writer is shared/midi/smf.ts; this one stays a dependency-free .mjs so
// the extractor runs with plain `node`.

export class SmfError extends Error {}

/**
 * @param {Uint8Array} bytes
 * @returns {{ format: number, ppq: number, hits: Array<{tick:number,key:number,vel:number,channel:number}>,
 *            tempos: Array<{tick:number,bpm:number}>, timeSigs: Array<{tick:number,num:number,den:number}> }}
 */
export function readMidi(bytes) {
  let pos = 0;
  const need = (n, end = bytes.length) => {
    if (pos + n > end) throw new SmfError(`truncated file at byte ${pos}`);
  };
  const u8 = (end) => (need(1, end), bytes[pos++]);
  const u16 = () => (need(2), (bytes[pos++] << 8) | bytes[pos++]);
  const u32 = () => (need(4), ((bytes[pos++] << 24) | (bytes[pos++] << 16) | (bytes[pos++] << 8) | bytes[pos++]) >>> 0);
  const ascii4 = () => (need(4), String.fromCharCode(bytes[pos++], bytes[pos++], bytes[pos++], bytes[pos++]));
  const vlq = (end) => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = u8(end);
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new SmfError('variable-length quantity longer than 4 bytes');
  };

  if (ascii4() !== 'MThd') throw new SmfError('not a MIDI file (no MThd)');
  const hlen = u32();
  const hdrEnd = pos + hlen;
  const format = u16();
  const ntrks = u16();
  const division = u16();
  if (division & 0x8000) throw new SmfError('SMPTE time division is not supported');
  if (division <= 0) throw new SmfError('invalid time division');
  if (format > 1) throw new SmfError(`unsupported MIDI format ${format}`);
  pos = hdrEnd;

  const hits = [];
  const tempos = [];
  const timeSigs = [];
  for (let t = 0; t < ntrks && pos + 8 <= bytes.length; t++) {
    const id = ascii4();
    const len = u32();
    const end = Math.min(bytes.length, pos + len);
    if (id !== 'MTrk') {
      pos = end;
      continue;
    }
    let tick = 0;
    let status = 0;
    while (pos < end) {
      tick += vlq(end);
      let b = u8(end);
      if (b === 0xff) {
        const type = u8(end);
        const n = vlq(end);
        need(n, end);
        if (type === 0x51 && n === 3) tempos.push({ tick, bpm: 60e6 / ((bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2]) });
        else if (type === 0x58 && n >= 2) timeSigs.push({ tick, num: bytes[pos], den: 2 ** bytes[pos + 1] });
        pos += n;
        if (type === 0x2f) break; // end of track
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        const n = vlq(end);
        need(n, end);
        pos += n;
        continue;
      }
      let d1;
      if (b & 0x80) {
        status = b;
        d1 = u8(end);
      } else {
        if (!status) throw new SmfError('running status without a status byte');
        d1 = b;
        b = status;
      }
      const hi = b & 0xf0;
      const d2 = hi === 0xc0 || hi === 0xd0 ? 0 : u8(end);
      if (hi === 0x90 && d2 > 0) hits.push({ tick, key: d1 & 0x7f, vel: d2 & 0x7f, channel: b & 0x0f });
    }
    pos = end;
  }
  hits.sort((a, b) => a.tick - b.tick || a.key - b.key);
  tempos.sort((a, b) => a.tick - b.tick);
  timeSigs.sort((a, b) => a.tick - b.tick);
  return { format, ppq: division, hits, tempos, timeSigs };
}
