// ──────────────────────────────────────────────────────────────────────
// Exports with song info: render through the engine (WAV, or MP3 through
// Windows' own encoder), then write the project's song info + cover into the
// file (WAV: LIST/INFO + an id3 chunk; MP3: a prepended ID3v2.3 tag with the
// exact length and the iTunSMPB gapless frame; shared/audio/tags.ts). Used by
// the Export dialog (IPC) and by the export_audio MCP tool, which can't pick
// a path: it always writes a NEW file (never overwriting) into
// <Music>\Krypt Studio\, or next to the saved project when Settings ▸
// Project ▸ Agent exports says so.
// ──────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import type { DocHost } from '@shared/doc/DocHost';
import { songInfo, type CoverRef } from '@shared/schema/project';
import type { Mp3Kbps, RenderRequest, RenderResult } from '@shared/engine/protocol';
import type { ActionResult, ExportFormat, ProjectStatus, RenderOptions, Settings } from '@shared/types';
import type { SongTags, TagPicture } from '@shared/audio/tags';
import type { StoredAsset } from './assets';
import { removeIfEmptySync, reserveUniquePath, writeFileAtomic } from '../system/files';

export const SOFTWARE_TAG = 'Krypt Studio';
export const AGENT_EXPORT_SUBDIR = 'Krypt Studio';

export interface ExportServiceDeps {
  doc: DocHost;
  engine: { render(job: RenderRequest): Promise<ActionResult<RenderResult>> };
  project: { status(): ProjectStatus; coverImage(): (StoredAsset & CoverRef) | null };
  getSettings(): Settings;
  /** The user's Music folder (app.getPath('music')). */
  musicDir: string;
  tag(file: string, tags: SongTags, picture: TagPicture | null): Promise<{ ok: boolean; message: string }>;
  log(level: 'info' | 'warn' | 'error', m: string): void;
}

export interface ExportOutcome extends RenderResult {
  /** Song info written into the file. */
  tagged: boolean;
  /** Why it wasn't (the export itself still succeeded). */
  tagNote?: string;
}

export type ExportRenderOptions = Pick<RenderOptions, 'scope' | 'format' | 'sampleRate' | 'tailSec' | 'loops' | 'normalize' | 'tags'> & { mp3Kbps?: Mp3Kbps };

/** Windows-safe file name part (no reserved characters / names, no trailing dots). */
export function safeFileName(name: string, fallback = 'Untitled'): string {
  let s = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `${s}_`;
  return s.slice(0, 120) || fallback;
}

export const extensionFor = (format: ExportFormat): 'mp3' | 'wav' => (format === 'mp3' ? 'mp3' : 'wav');

/** The tags an MP3 render adds: its exact length (TLEN) and the encoder's gapless info (iTunSMPB). */
export function mp3Tags(r: RenderResult): Pick<SongTags, 'lengthMs' | 'gapless'> {
  const m = r.mp3;
  if (!m) return {};
  const lengthMs = m.samples > 0 && m.sampleRate > 0 ? Math.round((m.samples / m.sampleRate) * 1000) : undefined;
  return { ...(lengthMs ? { lengthMs } : {}), ...(m.itunSmpb ? { gapless: m.itunSmpb } : {}) };
}

export class ExportService {
  constructor(private readonly deps: ExportServiceDeps) {}

  /** The song info that goes into exports (title → project name, artist → author when empty). */
  songTags(): SongTags {
    const info = songInfo(this.deps.doc.project.meta, this.deps.project.status().name);
    return { ...info, software: SOFTWARE_TAG };
  }

  /** The default file name for an export: the song title. */
  defaultName(): string {
    return safeFileName(this.songTags().title ?? '');
  }

  picture(): TagPicture | null {
    const c = this.deps.project.coverImage();
    return c ? { mime: c.mime, data: c.bytes } : null;
  }

  /** Where export_audio writes: <Music>\Krypt Studio, or the saved project's folder (Settings ▸ Project). */
  agentFolder(): { dir: string; note?: string } {
    const want = this.deps.getSettings().export?.folder ?? 'music';
    const music = path.join(this.deps.musicDir, AGENT_EXPORT_SUBDIR);
    if (want === 'project') {
      const p = this.deps.project.status().path;
      if (p) return { dir: path.dirname(p) };
      return { dir: music, note: "the project isn't saved yet, so it went to the Music folder" };
    }
    return { dir: music };
  }

  /**
   * Render to `out` (WAV or MP3), then embed the song info + cover unless opts.tags === false. A tagging problem
   * never fails the export: the file is kept untagged and the reason is returned.
   */
  async render(out: string, opts: ExportRenderOptions): Promise<ActionResult<ExportOutcome>> {
    const job: RenderRequest = {
      path: out,
      scope: opts.scope,
      format: opts.format,
      ...(opts.format === 'mp3' ? { mp3Kbps: opts.mp3Kbps ?? 320 } : {}),
      sampleRate: opts.sampleRate,
      tailSec: opts.tailSec,
      stems: false,
      analyze: true,
      loops: typeof opts.loops === 'number' && Number.isFinite(opts.loops) ? Math.max(1, Math.min(256, Math.round(opts.loops))) : undefined,
      normalize: opts.normalize === true ? true : undefined,
    };
    const r = await this.deps.engine.render(job);
    if (!r.ok || !r.data) return { ok: false, message: r.message ?? 'The render failed' };
    const file = r.data.path || out;
    if (opts.tags === false) return { ok: true, data: { ...r.data, tagged: false } };
    const tags: SongTags = { ...this.songTags(), ...(opts.format === 'mp3' ? mp3Tags(r.data) : {}) };
    const t = await this.deps.tag(file, tags, this.picture());
    if (!t.ok) this.deps.log('warn', `Export ${file}: song info not written: ${t.message}`);
    return { ok: true, data: { ...r.data, tagged: t.ok, ...(t.ok ? {} : { tagNote: t.message }) } };
  }

  /**
   * export_audio: a NEW file in the agent export folder (never an existing one), named after `name` or the song
   * title. A failed render removes the empty placeholder again.
   */
  async exportNew(opts: ExportRenderOptions & { name?: string }): Promise<ActionResult<ExportOutcome & { folderNote?: string }>> {
    const { dir, note } = this.agentFolder();
    let file: string;
    try {
      file = reserveUniquePath(dir, safeFileName(opts.name?.trim() || this.defaultName()), extensionFor(opts.format));
    } catch (err) {
      return { ok: false, message: `Couldn't create the export in ${dir}: ${(err as Error)?.message ?? err}` };
    }
    const r = await this.render(file, opts);
    if (!r.ok) {
      removeIfEmptySync(file);
      return r;
    }
    return { ...r, data: { ...r.data!, ...(note ? { folderNote: note } : {}) } };
  }

  /**
   * export_audio stems: one offline pass into a NEW "<name> stems" folder in the agent export folder (" 2", " 3" …
   * when taken), one file per mixer insert plus "Master", like File ▸ Export ▸ Stems. No song info and no per-stem
   * normalizing (that would undo the mix balance). A failed render removes the folder again when it is empty.
   */
  async exportStemsNew(opts: Pick<ExportRenderOptions, 'scope' | 'format' | 'sampleRate' | 'tailSec' | 'loops' | 'mp3Kbps'> & { name?: string }): Promise<ActionResult<RenderResult & { dir: string; folderNote?: string }>> {
    const { dir: base, note } = this.agentFolder();
    const stem = `${safeFileName(opts.name?.trim() || this.defaultName())} stems`;
    let dir = path.join(base, stem);
    try {
      fs.mkdirSync(base, { recursive: true });
      for (let n = 2; ; n++) {
        try {
          fs.mkdirSync(dir);
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 9999) throw err;
          dir = path.join(base, `${stem} ${n}`);
        }
      }
    } catch (err) {
      return { ok: false, message: `Couldn't create the stems folder in ${base}: ${(err as Error)?.message ?? err}` };
    }
    const r = await this.deps.engine.render({
      path: dir,
      scope: opts.scope,
      format: opts.format,
      ...(opts.format === 'mp3' ? { mp3Kbps: opts.mp3Kbps ?? 320 } : {}),
      sampleRate: opts.sampleRate,
      tailSec: opts.tailSec,
      loops: typeof opts.loops === 'number' && Number.isFinite(opts.loops) ? Math.max(1, Math.min(256, Math.round(opts.loops))) : undefined,
      stems: true,
      analyze: false,
    });
    if (!r.ok || !r.data) {
      try {
        fs.rmdirSync(dir); // only when the render left it empty
      } catch {
        /* it has files in it: keep them */
      }
      return { ok: false, message: r.message ?? 'The stem render failed' };
    }
    return { ok: true, data: { ...r.data, path: dir, dir, ...(note ? { folderNote: note } : {}) } };
  }

  /** A NEW file (never an existing one) in the agent export folder with these bytes: export_midi. */
  async writeNewFile(name: string, ext: string, bytes: Uint8Array): Promise<ActionResult<{ path: string; folderNote?: string }>> {
    const { dir, note } = this.agentFolder();
    let file: string;
    try {
      file = reserveUniquePath(dir, safeFileName(name.trim() || this.defaultName()), ext);
    } catch (err) {
      return { ok: false, message: `Couldn't create the file in ${dir}: ${(err as Error)?.message ?? err}` };
    }
    try {
      await writeFileAtomic(file, bytes);
    } catch (err) {
      removeIfEmptySync(file);
      return { ok: false, message: `Couldn't write ${path.basename(file)}: ${(err as Error)?.message ?? err}` };
    }
    return { ok: true, data: { path: file, ...(note ? { folderNote: note } : {}) } };
  }
}
