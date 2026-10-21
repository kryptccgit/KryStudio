export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  durationSec: number;
}

export function parseWav(buf: Uint8Array): WavInfo | { error: string } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 44 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return { error: 'not a WAV file' };
  let at = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  while (at + 8 <= b.length) {
    const id = b.toString('latin1', at, at + 4);
    let size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > b.length) return { error: 'broken WAV format chunk' };
      let format = b.readUInt16LE(body);
      if (format === 0xfffe && size >= 40 && body + 26 <= b.length) format = b.readUInt16LE(body + 24);
      fmt = { format, channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bitsPerSample: b.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) return { error: 'WAV data before its format' };
      if (size === 0 || size === 0xffffffff || body + size > b.length) size = b.length - body;
      const frameBytes = Math.max(1, (fmt.bitsPerSample / 8) * fmt.channels);
      const dataBytes = size - (size % frameBytes);
      if (!(fmt.format === 1 || fmt.format === 3) || !fmt.channels || !fmt.sampleRate) return { error: `unsupported WAV encoding (format ${fmt.format})` };
      return { ...fmt, dataOffset: body, dataBytes, durationSec: dataBytes / frameBytes / fmt.sampleRate };
    }
    at = body + size + (size % 2);
  }
  return { error: 'WAV without audio data' };
}

function header(info: Pick<WavInfo, 'format' | 'channels' | 'sampleRate' | 'bitsPerSample'>, dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  const block = (info.bitsPerSample / 8) * info.channels;
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(info.format, 20);
  h.writeUInt16LE(info.channels, 22);
  h.writeUInt32LE(info.sampleRate, 24);
  h.writeUInt32LE(info.sampleRate * block, 28);
  h.writeUInt16LE(block, 32);
  h.writeUInt16LE(info.bitsPerSample, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function concatWav(parts: Uint8Array[], gapSec = 0.2): { bytes: Buffer; offsets: number[]; durationSec: number } | { error: string } {
  if (!parts.length) return { error: 'nothing to join' };
  const infos: WavInfo[] = [];
  for (const p of parts) {
    const i = parseWav(p);
    if ('error' in i) return { error: i.error };
    infos.push(i);
  }
  const f = infos[0];
  if (infos.some((i) => i.format !== f.format || i.channels !== f.channels || i.sampleRate !== f.sampleRate || i.bitsPerSample !== f.bitsPerSample)) {
    return { error: 'the spoken lines have different audio formats' };
  }
  const frameBytes = (f.bitsPerSample / 8) * f.channels;
  const gapBytes = Math.round(Math.max(0, gapSec) * f.sampleRate) * frameBytes;
  const gap = Buffer.alloc(gapBytes, f.format === 1 && f.bitsPerSample === 8 ? 0x80 : 0);
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let bytes = 0;
  infos.forEach((info, k) => {
    if (k > 0) {
      chunks.push(gap);
      bytes += gap.length;
    }
    offsets.push(bytes / frameBytes / f.sampleRate);
    const src = parts[k];
    const data = Buffer.from(src.buffer, src.byteOffset + info.dataOffset, info.dataBytes);
    chunks.push(data);
    bytes += data.length;
  });
  return { bytes: Buffer.concat([header(f, bytes), ...chunks]), offsets, durationSec: bytes / frameBytes / f.sampleRate };
}

export function silentWav(seconds: number, sampleRate = 24000): Buffer {
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  return Buffer.concat([header({ format: 1, channels: 1, sampleRate, bitsPerSample: 16 }, frames * 2), Buffer.alloc(frames * 2)]);
}
