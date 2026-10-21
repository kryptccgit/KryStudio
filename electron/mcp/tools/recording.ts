// setup_recording: the document side of the Recording Studio (Home ▸ Recording
// Studio): a Vocals insert + track with a vocal chain as the recording target
// (recording.setupVocals), or another insert / track as the target
// (recording.setTarget), and a read-only report of the recording setup.
// Agents never arm, start a take, pick the input device or switch monitoring:
// the microphone is the user's (Settings ▸ Audio input, the Record button).

import { z } from 'zod';
import type { ChainPreset } from '@shared/sounds/types';
import { rankPresets } from '@shared/sounds/select';
import { audioInputSettings, recordingSettings } from '@shared/live/recording';
import { defineTool, fail } from './types';
import { findInsert, findTrack, safeName } from './util';
import { soundLibrary } from './instruments';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");

/** A vocal chain by id, exact name or words (vocal role first); null for "none". */
function vocalChain(presets: ReturnType<typeof soundLibrary>['presets'], ref: string): ChainPreset | null {
  const q = ref.trim();
  if (/^(none|no effects|dry|clean)$/i.test(q)) return null;
  const chains = presets.filter((p): p is ChainPreset => p.kind === 'chain');
  const hit =
    chains.find((p) => p.id === q || p.id.toLowerCase() === q.toLowerCase()) ??
    chains.find((p) => p.name.toLowerCase() === q.toLowerCase()) ??
    rankPresets(chains, { text: q, kind: 'chain', role: 'vocal' }, 1)[0] ??
    rankPresets(chains, { text: q, kind: 'chain' }, 1)[0];
  if (!hit) fail(`No effect chain matches "${safeName(q, 60)}". find_presets {"kind":"chain","role":"vocal"} lists the vocal chains; "none" sets up without effects.`);
  return hit;
}

export const setupRecording = defineTool({
  name: 'setup_recording',
  title: 'Set up vocal recording',
  kind: 'write',
  description:
    'The recording target (Home ▸ Recording Studio): where recorded audio takes go. vocals = a name (default "Vocals") sets up vocal recording in one undo step: a mixer insert + a playlist track with that name (the current target\'s are reused and renamed), the effect chain `chain` on the insert, replacing its effects (a chain preset id, name or words like "pop vocal"; omitted or "none" = no chain loaded: a new insert stays clean, a reused one keeps its effects), both made the target, so every take plays through the chain and lands on that track. Or insert / track = an insert or track (name, id, number) as the target, null = none (a new insert per take / the first free track). No arguments: reports the target, record mode, count-in and whether an input is set and armed (read-only). You CAN\'T arm, record, pick the microphone or turn monitoring on: tell the user to press Record (Ctrl+R) or open Home ▸ Recording Studio. Example: {"vocals":"Lead Vox","chain":"pop vocal"}',
  input: z.object({
    vocals: z.string().min(1).max(64).optional().describe('Set up vocal recording with an insert + track of this name.'),
    chain: z.string().min(1).max(120).optional().describe('With vocals: the effect chain loaded onto the insert ("none" = none).'),
    insert: z.union([z.string().max(120), z.number().int().min(1), z.null()]).optional().describe('Target insert (null = a new insert per take). Not the master.'),
    track: z.union([z.string().max(120), z.number().int().min(1), z.null()]).optional().describe('Target track (null = the first free track).'),
    change_label: zLabel,
  }),
  summarize: (a) => (a.vocals ? `vocals "${safeName(a.vocals, 30)}"${a.chain ? ` + ${safeName(a.chain, 30)}` : ''}` : a.insert !== undefined || a.track !== undefined ? 'target' : 'status'),
  run(deps, _c, a, ctx) {
    if (a.vocals !== undefined && (a.insert !== undefined || a.track !== undefined)) fail('Pass vocals (a new or renamed Vocals insert + track) or insert / track (an existing target), not both.');
    if (a.chain !== undefined && a.vocals === undefined) fail('chain goes with vocals (e.g. {"vocals":"Vocals","chain":"pop vocal"}); for an existing insert use apply_chain.');
    const status = (): string => {
      const p = deps.doc.project;
      const t = p.recording;
      const ins = t?.insertId ? p.mixer.inserts[t.insertId] : null;
      const tr = t?.trackId ? p.playlist.tracks[t.trackId] : null;
      const s = deps.getSettings();
      const rec = recordingSettings(s);
      const input = audioInputSettings(s);
      const st = deps.recorder?.status();
      const fx = ins ? ins.slotOrder.map((id) => deps.doc.catalog.plugins.find((pl) => pl.id === ins.slots[id].type)?.name ?? ins.slots[id].type) : [];
      return [
        `Takes play through: ${ins ? `insert "${safeName(ins.name)}"${fx.length ? ` (${fx.join(' → ')})` : ' (no effects)'}` : 'a new insert per take'}; land on: ${tr ? `track "${safeName(tr.name)}" when free` : 'the first free track'}.`,
        `Record mode ${rec.mode}, count-in ${rec.countInBars} bar${rec.countInBars === 1 ? '' : 's'}${rec.quantize ? `, quantize ${rec.quantize} ticks` : ''}; input ${input.deviceId ? `device set (${input.channels.length === 2 ? 'stereo' : 'mono'})` : 'the system default'}${input.monitor ? ', monitoring on' : ''}${st ? `; ${st.armed ? 'armed' : 'not armed'}` : ''}.`,
        'Only the user arms and records (Record button / Ctrl+R, or Home ▸ Recording Studio).',
      ].join(' ');
    };
    if (a.vocals !== undefined) {
      let chain: ChainPreset | null = null;
      if (a.chain !== undefined) chain = vocalChain(soundLibrary(deps).presets, a.chain);
      const args = { name: safeName(a.vocals, 64), chain };
      const r = ctx.exec<{ insertId: string; trackId: string; createdInsert: boolean; createdTrack: boolean }>('recording.setupVocals', args);
      const what = `${r.createdInsert ? 'New' : 'Renamed'} insert + ${r.createdTrack ? 'new' : 'renamed'} track "${args.name}"`;
      const fx = chain ? ` with the "${safeName(chain.name)}" chain` : r.createdInsert ? ' (no effects)' : ' (its effects unchanged)';
      return { ok: true, message: `${what}${fx} set as the recording target. ${status()}`, changed: [], data: r };
    }
    if (a.insert !== undefined || a.track !== undefined) {
      const p = deps.doc.project;
      const args: { insertId?: string | null; trackId?: string | null } = {};
      if (a.insert !== undefined) args.insertId = a.insert === null ? null : findInsert(p, a.insert).id;
      if (a.track !== undefined) args.trackId = a.track === null ? null : findTrack(p, a.track);
      ctx.exec('recording.setTarget', args);
      return { ok: true, message: `Recording target set. ${status()}`, changed: [], data: deps.doc.project.recording ?? null };
    }
    return { ok: true, message: status(), changed: [], data: { target: deps.doc.project.recording ?? null, armed: deps.recorder?.status().armed ?? null } };
  },
});

export const RECORDING_TOOLS = [setupRecording];
