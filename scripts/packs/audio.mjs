// Audio header readers for the pack manifest tool (scripts/packs/build.ts).
// Downloads are untrusted data: this only READS bytes. It parses the WAV `fmt `/`data` chunks and the FLAC
// STREAMINFO block to learn the sample rate, channel count, bit depth and length in frames. Nothing is decoded
// or executed.

/**
 * @param {Uint8Array} buf the first bytes of the file (64 KB is plenty for both formats) plus `size`, the whole
 *   file's byte length (WAV frames come from the data chunk size, which may be truncated by a short read).
 * @param {number} size
 * @returns {{ format: 'wav' | 'flac', rate: number, channels: number, bits: number, frames: number }}
 */
export function probeAudio(buf, size) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    let o = 12;
    let fmt = null;
    while (o + 8 <= buf.length) {
      const id = tag(o);
      const len = dv.getUint32(o + 4, true);
      if (id === 'fmt ') {
        fmt = {
          code: dv.getUint16(o + 8, true),
          channels: dv.getUint16(o + 10, true),
          rate: dv.getUint32(o + 12, true),
          blockAlign: dv.getUint16(o + 20, true),
          bits: dv.getUint16(o + 22, true),
        };
      } else if (id === 'data') {
        if (!fmt) throw new Error('WAV data chunk before fmt chunk');
        if (fmt.code !== 1 && fmt.code !== 3 && fmt.code !== 0xfffe) throw new Error(`unsupported WAV format code ${fmt.code}`);
        // A data chunk may claim more than the file holds (streamed writers); trust the smaller.
        const avail = Math.min(len, size - (o + 8));
        return { format: 'wav', rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, frames: Math.floor(avail / fmt.blockAlign) };
      }
      o += 8 + len + (len & 1);
    }
    throw new Error('WAV without a data chunk in the first bytes');
  }
  if (buf.length >= 42 && tag(0) === 'fLaC') {
    // METADATA_BLOCK_HEADER (4 bytes) then STREAMINFO (34 bytes): the first block is always STREAMINFO.
    const type = buf[4] & 0x7f;
    if (type !== 0) throw new Error('FLAC without STREAMINFO first');
    const s = 8;
    const rate = (buf[s + 10] << 12) | (buf[s + 11] << 4) | (buf[s + 12] >> 4);
    const channels = ((buf[s + 12] >> 1) & 0x07) + 1;
    const bits = (((buf[s + 12] & 0x01) << 4) | (buf[s + 13] >> 4)) + 1;
    const frames = (buf[s + 13] & 0x0f) * 2 ** 32 + ((buf[s + 14] << 24) >>> 0) + (buf[s + 15] << 16) + (buf[s + 16] << 8) + buf[s + 17];
    if (!frames) throw new Error('FLAC STREAMINFO has no total-samples count');
    return { format: 'flac', rate, channels, bits, frames };
  }
  throw new Error('not a WAV or FLAC file');
}

/**
 * Peak level and a pitch estimate of an uncompressed PCM WAV (FLAC is not decoded here: its levels are taken as
 * recorded). Returns null for anything else.
 * @param {Uint8Array} buf the whole file
 * @returns {{ peakDb: number, midi: number | null, onset: number } | null}
 */
export function analyzeWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12;
  let fmt = null;
  while (o + 8 <= buf.length) {
    const id = tag(o);
    const len = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      let code = dv.getUint16(o + 8, true);
      if (code === 0xfffe && len >= 26) code = dv.getUint16(o + 32, true); // EXTENSIBLE: the sub-format GUID's first word
      fmt = { code, channels: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), blockAlign: dv.getUint16(o + 20, true), bits: dv.getUint16(o + 22, true) };
    } else if (id === 'data' && fmt) {
      const start = o + 8;
      const end = Math.min(buf.length, start + len);
      const frames = Math.floor((end - start) / fmt.blockAlign);
      const bps = fmt.bits / 8;
      const read = (p) => {
        if (fmt.code === 3 && fmt.bits === 32) return dv.getFloat32(p, true);
        if (fmt.bits === 16) return dv.getInt16(p, true) / 32768;
        if (fmt.bits === 24) return ((buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)) << 8 >> 8) / 8388608;
        if (fmt.bits === 32) return dv.getInt32(p, true) / 2147483648;
        if (fmt.bits === 8) return (buf[p] - 128) / 128;
        return 0;
      };
      const mono = new Float32Array(frames);
      let peak = 0;
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const v = read(start + f * fmt.blockAlign + c * bps);
          const a = Math.abs(v);
          if (a > peak) peak = a;
          sum += v;
        }
        mono[f] = sum / fmt.channels;
      }
      // onset: the first frame within 40 dB of the peak, less 2 ms of lead-in (leading silence can be skipped with offset=)
      const gate = peak * 0.01;
      let first = 0;
      while (first < frames && Math.abs(mono[first]) < gate) first++;
      const onset = Math.max(0, first - Math.round(0.002 * fmt.rate));
      return { peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity, midi: estimatePitch(mono, fmt.rate), onset };
    }
    o += 8 + len + (len & 1);
  }
  return null;
}

/** YIN pitch estimate (MIDI note, fractional) of the steady part after the attack, or null when unpitched. */
function estimatePitch(x, rate) {
  let peakAt = 0;
  for (let i = 1; i < Math.min(x.length, rate); i++) if (Math.abs(x[i]) > Math.abs(x[peakAt])) peakAt = i;
  const start = peakAt + Math.round(0.08 * rate);
  const W = Math.round(0.1 * rate);
  const maxLag = Math.round(rate / 25); // down to 25 Hz
  if (start + W + maxLag > x.length) return null;
  const d = new Float64Array(maxLag);
  for (let lag = 1; lag < maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const e = x[start + i] - x[start + i + lag];
      s += e * e;
    }
    d[lag] = s;
  }
  // cumulative mean normalised difference
  let run = 0;
  const cm = new Float64Array(maxLag);
  cm[0] = 1;
  for (let lag = 1; lag < maxLag; lag++) {
    run += d[lag];
    cm[lag] = run > 0 ? (d[lag] * lag) / run : 1;
  }
  const minLag = Math.max(2, Math.round(rate / 4500));
  let lag = -1;
  for (let t = minLag; t < maxLag - 1; t++) {
    if (cm[t] < 0.15) {
      while (t + 1 < maxLag && cm[t + 1] < cm[t]) t++;
      lag = t;
      break;
    }
  }
  if (lag < 0) return null;
  const a = cm[lag - 1];
  const b = cm[lag];
  const c = cm[lag + 1];
  const denom = a - 2 * b + c;
  const refined = denom !== 0 ? lag + (0.5 * (a - c)) / denom : lag;
  const hz = rate / refined;
  return 69 + 12 * Math.log2(hz / 440);
}
