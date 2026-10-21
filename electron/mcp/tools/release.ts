import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { RenderScope } from '@shared/engine/protocol';
import { COVER_STYLES, MP3_BITRATES, type Mp3Kbps } from '@shared/types';
import { songInfo } from '@shared/schema/project';
import { ticksToSeconds } from '@shared/schema/time';
import { patternToSmf, planMidiImport } from '@shared/midi/convert';
import { readSmf, writeSmf } from '@shared/midi/smf';
import { defineTool, fail } from './types';
import { agentImagePath, agentMidiPath, findPattern, parseBarRange, plural, round, safeName } from './util';
import { songLengthTicks } from './overview';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");

export const setSongInfo = defineTool({
  name: 'set_song_info',
  title: 'Set the song info (title, artist, album …)',
  kind: 'write',
  description:
    'Set the song info that every export embeds (WAV: LIST/INFO + an id3 chunk; MP3: ID3v2.3), shown by Windows Explorer and music players: title (default: the project name), artist (default: the project author), album, year, genre, track. Also the project\'s own info (File ▸ Project info): project_name (shown while the project is unsaved; a saved project is named after its file), author, notes (free text, e.g. lyrics or a to-do list). Omitted fields stay; "" clears one (title / artist then fall back to the defaults); year or track null clears it. One undo step. Example: {"title":"Midnight Run","artist":"Krypt","album":"Night Drives","year":2026,"genre":"Synthwave","track":3}',
  input: z.object({
    title: z.string().max(200).optional(),
    artist: z.string().max(200).optional(),
    album: z.string().max(200).optional(),
    year: z.union([z.number().int().min(1000).max(9999), z.string().regex(/^\d{4}$/, 'year is four digits, e.g. "2026"'), z.null()]).optional(),
    genre: z.string().max(64).optional(),
    track: z.union([z.number().int().min(1).max(999), z.null()]).optional().describe('Track number on the album (1..999).'),
    project_name: z.string().min(1).max(128).optional().describe('The project name (used while it is unsaved, and as the default title).'),
    author: z.string().max(128).optional().describe('Project author (the default artist).'),
    notes: z.string().max(20000).optional().describe('Project notes (replaces them; "" clears).'),
    change_label: zLabel,
  }),
  summarize: (a) => safeName([a.title, a.artist, a.album, a.project_name].filter((x) => x !== undefined).join(' · ') || (a.notes !== undefined ? 'notes' : 'song info'), 60),
  run(deps, _c, a, ctx) {
    const args: Record<string, unknown> = {};
    for (const k of ['title', 'artist', 'album', 'genre'] as const) if (a[k] !== undefined) args[k] = a[k];
    if (a.year !== undefined) args.year = a.year === null ? null : Number(a.year);
    if (a.track !== undefined) args.trackNumber = a.track;
    const meta: Record<string, string> = {};
    if (a.project_name !== undefined) meta.name = safeName(a.project_name, 128);
    if (a.author !== undefined) meta.author = a.author;
    if (a.notes !== undefined) meta.notes = a.notes;
    if (!Object.keys(args).length && !Object.keys(meta).length) fail('Pass at least one of title, artist, album, year, genre, track, project_name, author, notes.');
    if (Object.keys(meta).length) ctx.exec('project.setMeta', meta);
    if (Object.keys(args).length) ctx.exec('project.setInfo', args);
    const info = songInfo(deps.doc.project.meta, deps.project.status().name);
    const shown = [`title "${safeName(info.title, 80)}"`, info.artist && `artist "${safeName(info.artist, 80)}"`, info.album && `album "${safeName(info.album, 80)}"`, info.year && `year ${info.year}`, info.genre && `genre ${safeName(info.genre, 40)}`, info.track && `track ${info.track}`].filter(Boolean);
    const m = deps.doc.project.meta;
    const metaLine = Object.keys(meta).length ? ` Project info: ${[meta.name !== undefined && `name "${safeName(m.name, 80)}"`, meta.author !== undefined && `author "${safeName(m.author, 80)}"`, meta.notes !== undefined && (m.notes ? `notes (${m.notes.length} characters)` : 'notes cleared')].filter(Boolean).join(', ')}.` : '';
    return { ok: true, message: `Song info set: ${shown.join(', ')}. Every export embeds it${m.cover ? ' with the cover' : ' (no cover yet: set_cover adds one)'}.${metaLine}`, changed: [], data: { ...info, project: { name: m.name, author: m.author, notes: m.notes.length } } };
  },
});

export const setCover = defineTool({
  name: 'set_cover',
  title: 'Set the cover art',
  kind: 'write',
  description: `Set the song's cover art, embedded in every export (MP3 covers show in Windows Explorer and every player; WAV covers in players that read the WAV id3 chunk). path = a PNG or JPEG on this PC (the same file-access rules as audio files; images are allowed for this tool only), cropped to a centred square of at most 1400 px; max 20 MB. Or generate = true: Krypt Studio draws a cover from the project (title and artist in Chakra Petch over a pattern made from the song's notes, Krypt gradient accents); style one of ${COVER_STYLES.join(', ')} and seed (any integer) pick the variation, the same style + seed give the same picture. The image is stored inside the project file. clear = true removes the cover. One undo step. Example: {"generate":true,"style":"orbit","seed":7}`,
  input: z.object({
    path: z.string().min(3).max(400).optional().describe('Absolute path of a PNG / JPEG.'),
    generate: z.boolean().optional().describe('Draw a cover from the project instead.'),
    style: z.enum(COVER_STYLES).optional().describe('Generated look (default: chosen from the seed).'),
    seed: z.number().int().min(0).max(2 ** 31 - 1).optional().describe('Variation of the generated cover (default 1).'),
    clear: z.boolean().optional().describe('Remove the cover art.'),
    change_label: zLabel,
  }),
  summarize: (a) => (a.clear ? 'clear' : a.path ? safeName(path.basename(a.path), 40) : `generated${a.style ? ` ${a.style}` : ''}${a.seed !== undefined ? ` #${a.seed}` : ''}`),
  paths: (a) => [{ value: a.path, kind: 'image' }],
  async run(deps, caller, a, ctx) {
    if ([!!a.path, !!a.generate, !!a.clear].filter(Boolean).length !== 1) fail('Pass either path (a PNG or JPEG on this PC) or generate: true, or clear: true to remove the cover; only one of them.');
    if (a.clear) {
      if (!deps.doc.project.meta.cover) fail('No change: the project has no cover art.');
      ctx.exec('project.clearCover', {});
      return { ok: true, message: 'Cover art removed: exports carry no picture now (undo_last brings it back).', changed: [] };
    }
    if (!deps.covers) fail('Cover art is not available in this session (see the Krypt Studio log).');
    let out: { ref: unknown; message: string };
    try {
      out = a.path ? await deps.covers.fromFile(agentImagePath(deps, a.path, caller)) : await deps.covers.generate({ style: a.style, seed: a.seed });
    } catch (err) {
      if ((err as Error)?.name === 'ToolFailure') throw err;
      fail((err as Error)?.message ?? String(err));
    }
    ctx.exec('project.setCover', out.ref);
    return { ok: true, message: `${out.message}. Every export embeds it; undo_last removes it.`, changed: [], data: out.ref };
  },
});

export const exportAudio = defineTool({
  name: 'export_audio',
  title: 'Export the song (WAV / MP3 with song info)',
  kind: 'transport',
  description: `Render and SAVE the song for the user: a new file in their Music\\Krypt Studio folder (or next to the saved project, per their settings), named after name or the song title, "(2)" added instead of overwriting. You can't choose the folder. format: wav16, wav24 (default), wav32f or mp3 (mp3_kbps ${MP3_BITRATES.join('/')}, default 320). scope: song (default, the whole Playlist), pattern (+ pattern, loops) or bars ("9-16"). The song info (set_song_info) and cover (set_cover) are embedded. Returns the path, length, integrated loudness and true peak. stems = true: one file per mixer insert plus "Master" in a NEW "<name> stems" folder there (File ▸ Export ▸ Stems: no song info, never normalized, so the stems sum back to the mix). Doesn't change the project. Example: {"format":"mp3","name":"Midnight Run (demo)"}`,
  input: z.object({
    format: z.enum(['wav16', 'wav24', 'wav32f', 'mp3']).default('wav24'),
    mp3_kbps: z
      .number()
      .int()
      .refine((n) => MP3_BITRATES.includes(n as Mp3Kbps), { message: `mp3_kbps is one of ${MP3_BITRATES.join(', ')}` })
      .optional(),
    scope: z.enum(['song', 'pattern', 'bars']).default('song'),
    pattern: z.string().max(120).optional().describe('scope "pattern": the pattern (default: active).'),
    loops: z.number().int().min(1).max(64).optional().describe('scope "pattern": times it plays (default 1).'),
    bars: z.string().max(16).optional().describe('scope "bars": e.g. "1-32" (inclusive).'),
    name: z.string().max(120).optional().describe('File name without extension (default: the song title).'),
    tail_sec: z.number().min(0).max(30).default(2).describe('Seconds rendered after the end for reverb / delay tails.'),
    normalize: z.boolean().default(false).describe('Peak-normalize to -0.1 dBFS (not with stems).'),
    stems: z.boolean().default(false).describe('One file per mixer insert + Master, in a new "<name> stems" folder.'),
  }),
  summarize: (a) => `${a.stems ? 'stems ' : ''}${a.format}${a.format === 'mp3' ? ` ${a.mp3_kbps ?? 320}k` : ''} ${a.scope}${a.name ? ` "${safeName(a.name, 30)}"` : ''}`,
  async run(deps, _c, a) {
    const exp = deps.exporter;
    if (!exp) fail('Exporting is not available in this session (see the Krypt Studio log).');
    const p = deps.doc.project;
    const ts = p.transport.timeSig;
    let scope: RenderScope;
    let ticks: number;
    let what: string;
    if (a.scope === 'pattern') {
      const pat = findPattern(p, a.pattern);
      scope = { kind: 'pattern', patternId: pat.id };
      ticks = 0;
      what = `pattern "${safeName(pat.name)}"${(a.loops ?? 1) > 1 ? ` × ${a.loops}` : ''}`;
    } else if (a.scope === 'bars') {
      if (!a.bars) fail('scope "bars" needs bars, e.g. "1-32"');
      const r = parseBarRange(a.bars, ts);
      scope = { kind: 'range', startTick: r.start, endTick: r.end };
      ticks = r.end - r.start;
      what = `bars ${a.bars}`;
    } else {
      ticks = songLengthTicks(p);
      if (ticks <= 0) fail('The Playlist is empty: arrange patterns first (arrange), or export scope "pattern".');
      scope = { kind: 'song' };
      what = 'the song';
    }
    if (a.stems) {
      if (!exp.exportStemsNew) fail('Stem export is not available in this session (see the Krypt Studio log).');
      if (a.normalize) fail('Stems are never normalized one by one (that would undo the mix balance): drop normalize, or export the mix.');
      const s = await exp.exportStemsNew({ scope, format: a.format, mp3Kbps: a.format === 'mp3' ? ((a.mp3_kbps ?? 320) as Mp3Kbps) : undefined, tailSec: a.tail_sec, loops: a.scope === 'pattern' ? a.loops : undefined, name: a.name });
      if (!s.ok || !s.data) fail(`Stem export of ${what} failed: ${s.message ?? 'the audio engine returned no result'}`);
      const files = s.data.stemResults?.map((x) => x.path) ?? s.data.files;
      const names = s.data.stemResults?.map((x) => safeName(x.name, 40)) ?? files.map((f) => path.basename(f));
      return {
        ok: true,
        message: `Exported ${plural(files.length, 'stem')} of ${what} to ${s.data.dir}: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''} (${round(s.data.durationSec || ticksToSeconds(ticks, p.transport.bpm), 1)} s each).${s.data.folderNote ? ` (${s.data.folderNote})` : ''}`,
        changed: [],
        data: { dir: s.data.dir, files, format: a.format },
      };
    }
    const r = await exp.exportNew({
      scope,
      format: a.format,
      mp3Kbps: a.format === 'mp3' ? ((a.mp3_kbps ?? 320) as Mp3Kbps) : undefined,
      tailSec: a.tail_sec,
      loops: a.scope === 'pattern' ? a.loops : undefined,
      normalize: a.normalize || undefined,
      name: a.name,
    });
    if (!r.ok || !r.data) fail(`Export of ${what} failed: ${r.message ?? 'the audio engine returned no result'}`);
    const d = r.data;
    const an = d.analysis;
    const lufs = an && Number.isFinite(an.lufsIntegrated) ? round(an.lufsIntegrated, 1) : Number.isFinite(d.lufsIntegrated) ? round(d.lufsIntegrated, 1) : null;
    const tp = an && Number.isFinite(an.truePeakDb) ? round(an.truePeakDb, 1) : null;
    const secs = round(d.durationSec || ticksToSeconds(ticks, p.transport.bpm), 1);
    const tags = exp.songTags();
    const info = d.tagged
      ? `Song info embedded (title "${safeName(tags.title, 60)}"${tags.artist ? `, artist "${safeName(tags.artist, 60)}"` : ''}${deps.doc.project.meta.cover ? ', cover' : ', no cover: set_cover adds one'}).`
      : `The song info could NOT be embedded: ${d.tagNote ?? 'unknown reason'} (the audio is fine).`;
    return {
      ok: true,
      message: `Exported ${what} to ${d.path}: ${secs} s, ${lufs ?? '-inf'} LUFS integrated, true peak ${tp ?? round(d.peakDb, 1)} ${tp !== null ? 'dBTP' : 'dBFS (sample peak)'}. ${info}${d.folderNote ? ` (${d.folderNote})` : ''}`,
      changed: [],
      data: { path: d.path, format: a.format, durationSec: secs, lufsIntegrated: lufs, truePeakDb: tp, peakDb: round(d.peakDb, 1), tagged: d.tagged },
    };
  },
});

export const exportMidi = defineTool({
  name: 'export_midi',
  title: 'Export a pattern as MIDI',
  kind: 'transport',
  description:
    'Save a pattern as a Standard MIDI File (one track per channel with notes, the project tempo) for the user: a NEW .mid in the same folder export_audio uses (Music\\Krypt Studio, or next to the saved project, per their settings), named after name or the pattern, "(2)" added instead of overwriting. You can\'t choose the folder. Doesn\'t change the project. Example: {"pattern":"Chorus","name":"Chorus chords"}',
  input: z.object({
    pattern: z.string().max(120).optional().describe('Pattern name / id (default: the active pattern).'),
    name: z.string().max(120).optional().describe('File name without extension (default: the pattern name).'),
  }),
  summarize: (a) => safeName(a.pattern ?? 'active pattern', 40),
  async run(deps, _c, a) {
    const exp = deps.exporter;
    if (!exp?.writeNewFile) fail('Exporting is not available in this session (see the Krypt Studio log).');
    const p = deps.doc.project;
    const pat = findPattern(p, a.pattern);
    const smf = patternToSmf(p, pat.id);
    if (!smf.tracks.length) fail(`Pattern "${safeName(pat.name)}" has no notes to export.`);
    const notes = Object.values(pat.notes).reduce((n, byId) => n + Object.keys(byId).length, 0);
    const r = await exp.writeNewFile(a.name?.trim() || pat.name, 'mid', writeSmf(smf));
    if (!r.ok || !r.data) fail(`MIDI export failed: ${r.message ?? 'unknown error'}`);
    return { ok: true, message: `Exported pattern "${safeName(pat.name)}" to ${r.data.path}: ${plural(smf.tracks.length, 'track')}, ${plural(notes, 'note')} at ${p.transport.bpm} BPM.${r.data.folderNote ? ` (${r.data.folderNote})` : ''}`, changed: [], data: { path: r.data.path, tracks: smf.tracks.length, notes } };
  },
});

const NOTES_PER_EXEC = 10_000;

export const importMidi = defineTool({
  name: 'import_midi',
  title: 'Import a MIDI file',
  kind: 'write',
  description:
    'Import a .mid file (File ▸ Import MIDI): a NEW pattern named after the file, one TriOsc channel per MIDI track / channel with its notes (PPQ converted to 960), selected as the active pattern. The project tempo stays; the result names the file\'s tempo when it differs (set_tempo to follow it). Then load_preset / set_instrument for real sounds. The same file-access rules as audio files. One undo step. Example: {"path":"C:\\\\Users\\\\me\\\\Music\\\\hook.mid"}',
  input: z.object({
    path: z.string().min(3).max(400).describe('Absolute path of a .mid / .midi file.'),
    name: z.string().min(1).max(64).optional().describe('Pattern name (default: the file name).'),
    change_label: zLabel,
  }),
  summarize: (a) => safeName(path.basename(a.path), 40),
  paths: (a) => [{ value: a.path, kind: 'midi' }],
  run(deps, caller, a, ctx) {
    const file = agentMidiPath(deps, a.path, caller);
    let plan: ReturnType<typeof planMidiImport>;
    try {
      const st = fs.statSync(file);
      if (st.size > 16 * 1024 * 1024) fail(`${safeName(path.basename(file))} is larger than 16 MB: not a MIDI song file.`);
      plan = planMidiImport(readSmf(new Uint8Array(fs.readFileSync(file))));
    } catch (err) {
      if ((err as Error)?.name === 'ToolFailure') throw err;
      fail(`Couldn't read ${safeName(path.basename(file))}: ${(err as Error)?.message ?? err}`);
    }
    if (plan.noteCount === 0) fail(`${safeName(path.basename(file))} has no notes to import.`);
    const name = safeName(a.name ?? path.basename(file).replace(/\.(mid|midi|smf)$/i, ''), 64) || 'MIDI';
    const { id: patternId } = ctx.exec<{ id: string }>('patterns.add', { name, select: true });
    const channels: string[] = [];
    for (const t of plan.tracks) {
      const { id } = ctx.exec<{ id: string }>('channels.add', { type: 'krypt.triosc', name: t.name });
      channels.push(t.name);
      for (let i = 0; i < t.notes.length; i += NOTES_PER_EXEC) ctx.exec('notes.add', { patternId, channelId: id, notes: t.notes.slice(i, i + NOTES_PER_EXEC) });
    }
    const bpm = deps.doc.project.transport.bpm;
    const tempo = plan.bpm && Math.abs(plan.bpm - bpm) > 0.01 ? ` The file's tempo is ${round(plan.bpm, 2)} BPM (the project stays at ${bpm}: set_tempo to follow it).` : '';
    return { ok: true, message: `Imported ${plural(plan.tracks.length, 'track')} (${plural(plan.noteCount, 'note')}) into pattern "${name}": ${channels.map((c) => safeName(c, 40)).join(', ')} (TriOsc; load_preset gives them real sounds).${tempo}`, changed: [], data: { patternId, tracks: plan.tracks.length, notes: plan.noteCount, bpm: plan.bpm } };
  },
});

export const saveProject = defineTool({
  name: 'save_project',
  title: 'Save the project',
  kind: 'transport',
  description:
    'Save the open project (File ▸ Save). A project that has a file is saved to it (a backup of the previous version is kept, like Ctrl+S). A project that was never saved needs name: it is saved as a NEW "<name>.kstudio" in the folder Save As would open ("(2)" added instead of overwriting); without name the tool refuses so you can ask the user for one (or they press Ctrl+S). Demos opened from Home count as never saved. You can\'t choose the folder or save over another file. Example: {"name":"Midnight Run"}',
  input: z.object({
    name: z.string().min(1).max(120).optional().describe('File name for a project that was never saved (ignored when it has a file).'),
  }),
  summarize: (a) => (a.name ? safeName(a.name, 40) : 'save'),
  async run(deps, _c, a) {
    const st = deps.project.status();
    if (st.path) {
      if (!st.dirty) return { ok: true, message: `No change: "${safeName(st.name)}" is already saved (${st.path}).`, changed: [], data: { path: st.path, saved: false } };
      const r = await deps.project.save();
      if (!r.ok || !r.data) fail(r.message ?? 'Save failed');
      return { ok: true, message: `Saved "${safeName(st.name)}" to ${r.data.path}.`, changed: [], data: { path: r.data.path, saved: true } };
    }
    if (!a.name?.trim()) fail(`"${safeName(st.name)}" has never been saved: pass name (e.g. {"name":"${safeName(deps.doc.project.meta.name || 'My Song', 40)}"}) to save it as a new project file, or ask the user to press Ctrl+S and pick the folder.`);
    if (!deps.project.saveNew) fail('Saving a new project file is not available in this session: ask the user to press Ctrl+S.');
    const r = await deps.project.saveNew(a.name);
    if (!r.ok || !r.data) fail(r.message ?? 'Save failed');
    return { ok: true, message: `Saved the project as ${r.data.path} (a new file). Ctrl+S saves there from now on.`, changed: [], data: { path: r.data.path, saved: true } };
  },
});

export const RELEASE_TOOLS = [setSongInfo, setCover, exportAudio];
export const FILE_TOOLS = [exportMidi, importMidi, saveProject];
