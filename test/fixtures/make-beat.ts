import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DocHost, USER } from '@shared/doc/DocHost';
import { createDefaultProject } from '@shared/schema/factory';
import { CATALOG } from '@shared/plugins/catalog';
import { TICKS_PER_STEP as S, PPQ } from '@shared/schema/time';

const host = new DocHost(createDefaultProject('Fixture Beat'), CATALOG, { strict: true });
const p = () => host.project;
const ok = (r: { ok: boolean; message?: string }) => {
  if (!r.ok) throw new Error(r.message);
  return r as any;
};
const ex = (cmd: string, args: unknown) => ok(host.exec(cmd, args, { actor: USER }));

const [kick, clap, hat, snare, bass, keys] = p().channelOrder;
const patA = p().transport.activePatternId!;
const steps = (ch: string, pat: string, list: number[], key = 60, vel = 0.8) =>
  ex('notes.add', { patternId: pat, channelId: ch, notes: list.map((s) => ({ tick: s * S, key, vel, dur: S })) });

steps(kick, patA, [0, 10, 16, 22, 27]);
steps(clap, patA, [8, 24]);
steps(hat, patA, Array.from({ length: 32 }, (_, i) => i).filter((i) => i % 2 === 0), 60, 0.6);
steps(snare, patA, [31], 60, 0.5);
ex('notes.add', {
  patternId: patA,
  channelId: bass,
  notes: [
    { tick: 0, key: 42, dur: 6 * S, vel: 0.9 },
    { tick: 10 * S, key: 49, dur: 4 * S, vel: 0.85 },
    { tick: 16 * S, key: 42, dur: 6 * S, vel: 0.9 },
    { tick: 22 * S, key: 45, dur: 4 * S, vel: 0.85, slide: true },
    { tick: 27 * S, key: 40, dur: 5 * S, vel: 0.85 },
  ],
});
ex('patterns.set', { id: patA, name: 'Drums + 808' });

const patB = ex('patterns.add', { name: 'Keys' }).data.id as string;
const chord = (tick: number, keysArr: number[], dur: number) => keysArr.map((k) => ({ tick, key: k, dur, vel: 0.65 }));
ex('notes.add', {
  patternId: patB,
  channelId: keys,
  notes: [...chord(0, [54, 57, 61], 8 * S), ...chord(8 * S, [50, 54, 57], 8 * S), ...chord(16 * S, [57, 61, 64], 8 * S), ...chord(24 * S, [52, 56, 59], 8 * S)],
});

const keysIns = p().channels[keys].insertId;
ex('mixer.addSlot', { insertId: keysIns, type: 'krypt.reverb', mix: 0.3 });
ex('mixer.addSlot', { insertId: keysIns, type: 'krypt.delay', mix: 0.2 });
const bassIns = p().channels[bass].insertId;
ex('mixer.addSlot', { insertId: bassIns, type: 'krypt.drive', params: { drive: 9 } });
ex('mixer.setInsert', { id: p().channels[hat].insertId, volume: 0.7, pan: 0.15 });

const [t1, t2, t3] = p().playlist.trackOrder;
const bar = PPQ * 4;
for (let b = 0; b < 8; b += 2) ex('playlist.addClip', { kind: 'pattern', trackId: t1, start: b * bar, patternId: patA });
for (let b = 2; b < 8; b += 2) ex('playlist.addClip', { kind: 'pattern', trackId: t2, start: b * bar, patternId: patB });
ex('automation.create', {
  target: `channel/${keys}/gen/cutoff`,
  trackId: t3,
  start: 2 * bar,
  length: 6 * bar,
  points: [
    { tick: 0, value: 0.35, tension: 0 },
    { tick: 4 * bar, value: 0.85, tension: 0.4 },
    { tick: 6 * bar, value: 0.6, tension: 0 },
  ],
});
ex('transport.setMode', { mode: 'song' });

const out = path.join(import.meta.dirname ?? '.', 'beat.json');
writeFileSync(out, JSON.stringify(p(), null, 2));
console.log(`wrote ${out}: ${Object.keys(p().playlist.clips).length} clips, ${p().channelOrder.length} channels`);
