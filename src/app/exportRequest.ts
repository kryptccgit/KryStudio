// Pure part of the Export dialog: remembered choices and the render
// request they produce: one file, or stems into a folder (unit-tested in
// test/keymap.test.ts). No DOM, no React.

import { MP3_BITRATES, type Mp3Kbps, type RenderOptions } from '@shared/types';
import type { RenderScope } from '@shared/engine/protocol';
import { patternLength, type Project } from '@shared/schema/project';
import { ticksPerBar } from '@shared/schema/time';

export type ExportScope = 'song' | 'pattern' | 'loop';
export type ExportFormat = 'wav16' | 'wav24' | 'wav32f' | 'mp3';

export interface ExportPrefs {
  scope: ExportScope;
  patternId: string | null;
  loops: number;
  format: ExportFormat;
  /** MP3 bitrate (default 320). */
  mp3Kbps?: Mp3Kbps;
  tail: 'leave' | 'cut';
  tailSec: number;
  normalize: boolean;
  openFolder: boolean;
  /** One file per mixer insert plus "Master", into a new folder (no song info; never normalized one by one). */
  stems?: boolean;
}

export type ExportRunner = (opts: Partial<RenderOptions>, label: string, extra: { openFolder?: boolean }) => Promise<void>;

const PREFS_KEY = 'krypt.exportDialog.v1';
export const EXPORT_DEFAULTS: ExportPrefs = { scope: 'song', patternId: null, loops: 1, format: 'wav24', mp3Kbps: 320, tail: 'leave', tailSec: 2, normalize: false, openFolder: true };

export function loadExportPrefs(): ExportPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<ExportPrefs>;
    const p = { ...EXPORT_DEFAULTS, ...raw };
    return {
      scope: (['song', 'pattern', 'loop'] as const).includes(p.scope) ? p.scope : 'song',
      patternId: typeof p.patternId === 'string' ? p.patternId : null,
      loops: Math.max(1, Math.min(64, Math.round(Number(p.loops) || 1))),
      format: (['wav16', 'wav24', 'wav32f', 'mp3'] as const).includes(p.format) ? p.format : 'wav24',
      mp3Kbps: MP3_BITRATES.includes(Number(p.mp3Kbps) as Mp3Kbps) ? (Number(p.mp3Kbps) as Mp3Kbps) : 320,
      tail: p.tail === 'cut' ? 'cut' : 'leave',
      tailSec: Math.max(0, Math.min(30, Number(p.tailSec) || 0)),
      normalize: !!p.normalize,
      openFolder: p.openFolder !== false,
      stems: p.stems === true,
    };
  } catch {
    return { ...EXPORT_DEFAULTS };
  }
}

export function saveExportPrefs(p: ExportPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: the dialog still works, it just won't remember */
  }
}

export const FORMAT_LABEL: Record<ExportFormat, string> = { wav16: '16-bit WAV', wav24: '24-bit WAV', wav32f: '32-bit float WAV', mp3: 'MP3' };

/** "MP3 320 kbps" / "24-bit WAV". */
export function formatLabel(prefs: Pick<ExportPrefs, 'format' | 'mp3Kbps'>): string {
  return prefs.format === 'mp3' ? `MP3 ${prefs.mp3Kbps ?? 320} kbps` : FORMAT_LABEL[prefs.format];
}

/** Pure: the render options a set of prefs produces for a project (null = nothing to render). */
export function exportRequest(prefs: ExportPrefs, p: Project): { opts: Partial<RenderOptions>; ticks: number; label: string } | null {
  const ts = p.transport.timeSig;
  const bar = ticksPerBar(ts);
  const tailSec = prefs.tail === 'cut' ? 0 : prefs.tailSec;
  let scope: RenderScope;
  let ticks: number;
  let label: string;
  if (prefs.scope === 'pattern') {
    const pid = prefs.patternId && p.patterns[prefs.patternId] ? prefs.patternId : p.transport.activePatternId;
    const pat = pid ? p.patterns[pid] : undefined;
    if (!pat || !pid) return null;
    scope = { kind: 'pattern', patternId: pid };
    ticks = patternLength(pat, ts) * prefs.loops;
    label = `Export ${pat.name}`;
  } else if (prefs.scope === 'loop') {
    const l = p.transport.loop;
    if (!(l.end > l.start)) return null;
    scope = { kind: 'range', startTick: l.start, endTick: l.end };
    ticks = l.end - l.start;
    label = 'Export loop region';
  } else {
    const end = Math.max(0, ...Object.values(p.playlist.clips).map((c) => c.start + c.length));
    scope = { kind: 'song' };
    ticks = Math.max(bar, Math.ceil(end / bar) * bar);
    label = 'Export song';
  }
  const opts: Partial<RenderOptions> = { scope, format: prefs.format, tailSec };
  if (prefs.format === 'mp3') opts.mp3Kbps = prefs.mp3Kbps ?? 320;
  if (prefs.scope === 'pattern' && prefs.loops > 1) opts.loops = prefs.loops;
  if (prefs.stems) {
    // Stems keep the mix balance: normalizing each file on its own would undo it.
    opts.stems = true;
    label = prefs.scope === 'song' ? 'Export stems' : label.replace(/^Export /, 'Export stems of ');
  } else if (prefs.normalize) opts.normalize = true;
  return { opts, ticks, label };
}
