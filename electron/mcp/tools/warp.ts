// warp_clip (Wave 12.2, research/16 §2.2): warp an audio clip to the grid.
// Auto-warp beat-tracks the sample with the analyzer (electron/warp) and
// writes the markers through audio.autoWarp; hand-placed markers, the mode
// and its options go through the other audio.*Warp* commands. Everything is
// one undo step (the call's group); the warp map is on the clip's Audio Clip
// channel, so every clip of that channel follows.

import { z } from 'zod';
import type { Channel } from '@shared/schema/project';
import { WARP_MODES, type WarpMap } from '@shared/schema/warp';
import { defineTool, fail, type RunCtx } from './types';
import { findChannel, findPluginRef, plural, round, safeName } from './util';
import { findAudioClip } from './ears';
import { AUDIOCLIP } from '../../analyzer/convert';
import { autoWarpChannel } from '../../warp/autoWarp';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");

function runOpts(ctx: RunCtx) {
  return { onProgress: ctx.progress ? (stage: string, fraction: number) => ctx.progress!(fraction, stage || 'working') : undefined, signal: ctx.signal };
}

/** "tones mode, 17 markers (beat 0 @ 0.12 s … beat 64 @ 30.1 s)". */
export function describeWarp(w: WarpMap | undefined): string {
  if (!w) return 'not warped (Stretch params only)';
  const m = w.markers;
  const opts: string[] = [];
  if (w.mode === 'beats') opts.push(`slices ${w.beatsSlice ?? 'transients'}`, `fade ${w.beatsFadeMs ?? 20} ms`);
  if (w.mode === 'texture') opts.push(`grain ${w.grainMs ?? 80} ms`, `flux ${w.flux ?? 0.2}`);
  const at = (i: number) => `beat ${round(m[i].beat, 3)} @ ${round(m[i].sec, 3)} s`;
  const markers = m.length === 0 ? 'no markers (timing from the Stretch params)' : m.length === 1 ? `1 marker (${at(0)}; timing from the Stretch params)` : `${plural(m.length, 'marker')} (${at(0)} … ${at(m.length - 1)})`;
  return `${w.mode} mode${opts.length ? ` (${opts.join(', ')})` : ''}, ${markers}`;
}

export const warpClip = defineTool({
  name: 'warp_clip',
  title: 'Warp an audio clip to the grid',
  kind: 'write',
  description:
    "Warp an audio clip so its beats land on the project grid (its Audio Clip channel, so every clip of that channel follows). auto: true beat-tracks it (Beat This! model when installed, else the DSP tracker; a stem is tracked on its source mix) and pins one marker per bar (every: 'beat' for one per beat); a half-time reading keeps the loop's speed. markers: [{sec, beat}] REPLACES the markers by hand: sec = position in the source file, beat = quarter notes from the sample start at the project tempo, both strictly increasing. clear: true removes the markers (with mode 'off': the whole warp, back to plain Stretch). mode: complex (full mixes), tones (vocals, bass, leads), beats (drums: slices keep their punch), texture (pads, noise), repitch (pitch follows speed); auto picks it from hint (drums / mono / mix, guessed when omitted). options: beatsSlice / beatsFadeMs (beats), grainMs / flux (texture). Order: clear, auto or markers, mode, options. With 2+ markers they override stretch / sync_to_tempo. One undo step. Example: {\"clip\":\"Drum Loop\",\"auto\":true}",
  input: z.object({
    clip: z.string().min(1).max(200).describe('Audio clip id, or the name/id of its audio-clip channel.'),
    mode: z.enum([...WARP_MODES, 'off']).optional().describe("Warp mode; 'off' removes the warp entirely."),
    auto: z.boolean().optional().describe('Beat-track the audio and pin markers to the grid (replaces existing markers).'),
    every: z.enum(['bar', 'beat']).optional().describe("auto: one marker per bar (default) or per beat."),
    hint: z.enum(['drums', 'mono', 'mix']).optional().describe('auto: what the clip is (drums → beats mode, mono → tones, mix → complex). Guessed when omitted.'),
    markers: z
      .array(z.object({ sec: z.number().min(0), beat: z.number().min(0) }))
      .min(1)
      .max(2048)
      .optional()
      .describe('Markers by hand (replace the existing ones), strictly increasing in sec and beat.'),
    clear: z.boolean().optional().describe('Remove the warp markers first.'),
    options: z
      .object({
        beatsSlice: z.enum(['transients', '1/16', '1/8', '1/4']).optional(),
        beatsFadeMs: z.number().min(0).max(200).optional(),
        grainMs: z.number().min(10).max(500).optional(),
        flux: z.number().min(0).max(1).optional(),
      })
      .optional(),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.clip, 40)}${a.auto ? ' (auto)' : ''}`,
  async run(deps, _c, a, ctx) {
    const p0 = deps.doc.project;
    const r0 = a.clip.trim();
    const clip0 = p0.playlist.clips[r0] ? findAudioClip(p0, r0) : null;
    const ch0: Channel | undefined = clip0?.channelId ? p0.channels[clip0.channelId] : findChannel(p0, r0);
    if (!ch0) fail('That clip has no audio channel');
    if (ch0.generator.type !== AUDIOCLIP) fail(`warp_clip works on audio clips; "${safeName(ch0.name)}" is a ${findPluginRef(deps.doc.catalog, ch0.generator.type).name} channel`);
    const id = ch0.id;
    const name = safeName(ch0.name);
    if (a.auto && a.markers) fail('Pass either auto: true or markers, not both');
    if (a.mode === 'off' && (a.auto || a.markers || a.options)) fail("mode 'off' removes the warp; it can't be combined with auto, markers or options");
    if (!a.auto && !a.markers && !a.clear && a.mode === undefined && !a.options) fail('Nothing to change: pass auto: true, markers, clear, mode or options.');
    if (a.markers) {
      const ms = a.markers;
      for (let i = 1; i < ms.length; i++) {
        if (!(ms[i].sec > ms[i - 1].sec) || !(ms[i].beat > ms[i - 1].beat))
          fail(`markers must be strictly increasing in both sec and beat: marker ${i + 1} (${ms[i].sec} s, beat ${ms[i].beat}) doesn't come after marker ${i} (${ms[i - 1].sec} s, beat ${ms[i - 1].beat})`);
      }
    }

    const notes: string[] = [];
    const warnings: string[] = [];
    const warpOf = () => deps.doc.project.channels[id]?.generator.warp;

    if (a.mode === 'off') {
      if (warpOf()) {
        ctx.exec('audio.clearWarp', { channelId: id, all: true });
        notes.push('warp removed (plays with the Stretch params only)');
      }
    } else if (a.clear || a.markers) {
      const n = warpOf()?.markers.length ?? 0;
      if (n) {
        ctx.exec('audio.clearWarp', { channelId: id });
        if (a.clear) notes.push(`${plural(n, 'marker')} cleared`);
      }
    }

    if (a.auto) {
      const r = await autoWarpChannel(deps, id, { every: a.every, hint: a.hint, mode: a.mode && a.mode !== 'off' ? a.mode : undefined }, (cmd, args) => ctx.exec(cmd, args), runOpts(ctx));
      if (!r.ok || !r.data) fail(r.message ?? 'Auto-warp failed');
      notes.push(r.message!.replace(/^Warped "[^"]*": /, 'auto-warped: '));
      if (r.data.warning) warnings.push(r.data.warning);
    }

    if (a.markers) {
      for (const m of a.markers) ctx.exec('audio.addWarpMarker', { channelId: id, sec: m.sec, beat: m.beat });
      notes.push(`${plural(a.markers.length, 'marker')} set by hand`);
    }

    if (a.mode && a.mode !== 'off' && !a.auto && warpOf()?.mode !== a.mode) {
      ctx.exec('audio.setWarpMode', { channelId: id, mode: a.mode });
      notes.push(`${a.mode} mode`);
    }

    if (a.options) {
      const w = warpOf();
      const o = a.options;
      const diff = (Object.keys(o) as Array<keyof typeof o>).filter((k) => o[k] !== undefined && w?.[k] !== o[k]);
      if (diff.length) {
        ctx.exec('audio.setWarpOptions', { channelId: id, ...o });
        notes.push(`options ${diff.map((k) => `${k} ${o[k]}`).join(', ')}`);
      }
    }

    const w = warpOf();
    const markers = w?.markers.length ?? 0;
    if (w && w.mode !== 'complex' && markers < 2 && !a.auto) warnings.push('With fewer than 2 markers the timing still comes from the Stretch params; add markers (or auto: true) to warp.');
    return {
      ok: true,
      message: `"${name}": ${notes.length ? notes.join('; ') : 'already as asked'}. Now ${describeWarp(w)}.`,
      changed: [],
      warnings: warnings.length ? warnings : undefined,
      data: { channelId: id, warp: w ? { mode: w.mode, markers: w.markers.map((m) => ({ id: m.id, sec: round(m.sec, 4), beat: round(m.beat, 4) })), beatsSlice: w.beatsSlice, beatsFadeMs: w.beatsFadeMs, grainMs: w.grainMs, flux: w.flux } : null },
    };
  },
});

export const WARP_TOOLS = [warpClip];
