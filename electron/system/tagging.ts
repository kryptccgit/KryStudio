import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { planMp3Tags, planWavTags, scanRiff, TagError, type SongTags, type TagPicture, type TagPlan } from '@shared/audio/tags';
import { describeFsError, writeFileAtomicWith } from './files';

const BLOCK = 4 * 1024 * 1024;

export type TaggableFormat = 'wav' | 'mp3';

export function taggableFormat(file: string): TaggableFormat | null {
  return /\.wav$/i.test(file) ? 'wav' : /\.mp3$/i.test(file) ? 'mp3' : null;
}

function planFor(file: string, format: TaggableFormat, tags: SongTags, picture?: TagPicture | null): TagPlan {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (offset: number, length: number): Uint8Array => {
      const b = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
      const n = b.length ? fs.readSync(fd, b, 0, b.length, offset) : 0;
      return new Uint8Array(b.buffer, b.byteOffset, n);
    };
    return format === 'wav' ? planWavTags(scanRiff(read, size), tags, picture) : planMp3Tags(read, size, tags, picture);
  } finally {
    fs.closeSync(fd);
  }
}

export async function tagAudioFile(file: string, tags: SongTags, picture?: TagPicture | null): Promise<{ ok: boolean; message: string }> {
  const format = taggableFormat(file);
  if (!format) return { ok: false, message: 'Song info can only be written into WAV and MP3 files' };
  let src: fsp.FileHandle | null = null;
  try {
    const plan = planFor(file, format, tags, picture);
    const fh = await fsp.open(file, 'r');
    src = fh;
    await writeFileAtomicWith(file, async (out) => {
      const buf = new Uint8Array(BLOCK);
      for (const part of plan.parts) {
        if ('bytes' in part) {
          await out.write(part.bytes);
          continue;
        }
        let [at, left] = part.copy;
        while (left > 0) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(BLOCK, left), at);
          if (bytesRead <= 0) throw new Error('The export got shorter while it was being tagged');
          await out.write(buf.subarray(0, bytesRead));
          at += bytesRead;
          left -= bytesRead;
        }
      }
    }, async () => {
      src = null;
      await fh.close();
    });
    return { ok: true, message: `Song info${picture ? ' and cover' : ''} written` };
  } catch (err) {
    if (err instanceof TagError) return { ok: false, message: err.message };
    return { ok: false, message: describeFsError(err, file) };
  } finally {
    await src?.close().catch(() => {});
  }
}
