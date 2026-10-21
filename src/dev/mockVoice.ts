// Browser-preview Krypt Voice (window.krypt.voice without the desktop app), for `npm run dev:web` screenshots:
// Kokoro "installed" with a few local voices, no Fish key until one is saved (any 16+ character key works, then
// three Fish voices appear), Speak / Sing walk the stages with progress and honour Cancel, and Add to song places a
// real audio clip in the in-page DocHost as ONE user undo step. Sing returns a believable syllable → note mapping
// from the pattern's notes (shared/voice/singplan.ts via src/voice/sing.ts). Cloning needs the key + consent and returns a "mine" voice.

import { USER, type DocHost } from '@shared/doc/DocHost';
import type { ActionResult, KryptApi } from '@shared/types';
import type { SingOutcome, SpeakOutcome, VoiceInfo, VoiceProgress, VoiceStage, VoiceState } from '@shared/voice/types';
import { ticksPerBar, ticksPerBeat } from '@shared/schema/time';
import { mapSyllables, melodyNotes, parseBarRange, parseLyrics, plannedRows } from '../voice/sing';

const LOCAL: VoiceInfo[] = [
  { id: 'local:af_heart', engine: 'local', name: 'Heart', description: 'US English · female · warm', language: 'en-US' },
  { id: 'local:af_bella', engine: 'local', name: 'Bella', description: 'US English · female · bright', language: 'en-US' },
  { id: 'local:am_michael', engine: 'local', name: 'Michael', description: 'US English · male · deep', language: 'en-US' },
  { id: 'local:bm_george', engine: 'local', name: 'George', description: 'UK English · male · calm', language: 'en-GB' },
];
const FISH: VoiceInfo[] = [
  { id: 'fish:energetic-host', engine: 'fish', name: 'Energetic host', description: 'English · male · hype', language: 'en' },
  { id: 'fish:soft-narrator', engine: 'fish', name: 'Soft narrator', description: 'English · female · breathy', language: 'en' },
  { id: 'fish:radio-dj', engine: 'fish', name: 'Radio DJ', description: 'English · male · classic radio', language: 'en' },
];

const fail = <T>(message: string): ActionResult<T> => ({ ok: false, message });

export function createMockVoice(host: DocHost): KryptApi['voice'] {
  let keySet = false;
  const mine: VoiceInfo[] = [];
  let cancelled = false;
  let running = false;
  const stateCbs = new Set<(s: VoiceState) => void>();
  const progCbs = new Set<(p: VoiceProgress) => void>();

  const snapshot = (): VoiceState => ({
    local: { installed: true, modelId: 'kokoro-82m' },
    fish: keySet ? { keySet: true } : { keySet: false, message: 'Cloud voices need your free Fish Audio key: add it in Settings ▸ Voice' },
    voices: [...LOCAL, ...(keySet ? FISH : []), ...mine],
  });
  const broadcast = (): void => stateCbs.forEach((cb) => cb(snapshot()));
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function walk(stages: VoiceStage[], msgs: Record<string, string>): Promise<boolean> {
    for (let i = 0; i < stages.length; i++) {
      for (let k = 0; k <= 4; k++) {
        if (cancelled) return false;
        progCbs.forEach((cb) => cb({ stage: stages[i], fraction: (i + k / 5) / stages.length, message: msgs[stages[i]] ?? 'Working…' }));
        await wait(160);
      }
    }
    return true;
  }

  function check(voiceId: string): string | null {
    const v = snapshot().voices.find((x) => x.id === voiceId);
    if (!v) return `Unknown voice "${voiceId}"`;
    if (v.engine === 'fish' && !keySet) return 'Cloud voices need your Fish Audio key: add it in Settings ▸ Voice';
    return null;
  }

  /** Place the rendered "file" as one audio clip (one undo step). */
  function place(label: string, path: string, seconds: number, start: number, trackId?: string): { clipId: string; channelId: string } | string {
    const p = host.project;
    const g = host.beginGroup(USER, label);
    try {
      let tid = trackId && p.playlist.tracks[trackId] ? trackId : undefined;
      if (!tid) {
        const tr = host.exec<{ id: string }>('playlist.addTrack', { name: label.replace(/^Add /, '') }, { actor: USER, groupId: g });
        if (!tr.ok || !tr.data) return tr.message ?? "Couldn't add a track";
        tid = tr.data.id;
      }
      const a = host.exec<{ clipId: string; channelId: string }>(
        'playlist.addAudio',
        { path, name: label.replace(/^Add /, ''), trackId: tid, start, frames: Math.round(seconds * 48000), sampleRate: 48000, channels: 1 },
        { actor: USER, groupId: g },
      );
      if (!a.ok || !a.data) return a.message ?? "Couldn't place the clip";
      return a.data;
    } finally {
      host.endGroup(g);
    }
  }

  const fakePath = (text: string): string => `C:\\Users\\you\\AppData\\Roaming\\Krypt Studio\\voice\\${Math.abs([...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(16)}.wav`;

  return {
    state: async () => snapshot(),
    onState: (cb) => {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    onProgress: (cb) => {
      progCbs.add(cb);
      return () => progCbs.delete(cb);
    },
    async speak(req) {
      if (running) return fail('Krypt Voice is already rendering');
      const bad = check(req.voiceId);
      if (bad) return fail(bad);
      running = true;
      cancelled = false;
      try {
        const ok = await walk(req.preview ? ['phonemes', 'speaking'] : ['phonemes', 'speaking', 'placing'], { phonemes: 'Reading the text', speaking: req.voiceId.startsWith('local:') ? 'Speaking on your PC' : 'Fish Audio is speaking', placing: 'Adding the clip' });
        if (!ok) return fail('Cancelled');
        const seconds = Math.max(0.8, req.text.split(/\s+/).length * 0.38 / (req.speed ?? 1));
        const path = fakePath(req.text + req.voiceId);
        const o: SpeakOutcome = { path, durationSec: seconds, engine: req.voiceId.startsWith('local:') ? 'local' : 'fish', notes: [] };
        if (!req.preview) {
          const ts = host.project.transport.timeSig;
          let start = 0;
          if (req.at) {
            const [b, beat] = req.at.split('.').map(Number);
            start = (b - 1) * ticksPerBar(ts) + (beat ? beat - 1 : 0) * ticksPerBeat(ts);
          }
          const r = place(`Add Voice: ${req.text.slice(0, 24)}`, path, seconds, start, req.track);
          if (typeof r === 'string') return fail(r);
          o.clipId = r.clipId;
          o.channelId = r.channelId;
          if (req.tune && req.tune !== 'off') o.notes.push(`Krypt Tune (${req.tune}) is first on the clip's insert`);
        }
        return { ok: true, data: o };
      } finally {
        running = false;
      }
    },
    async sing(req) {
      if (running) return fail('Krypt Voice is already rendering');
      const bad = check(req.voiceId);
      if (bad) return fail(bad);
      const p = host.project;
      const pat = p.patterns[req.patternId];
      const notesRec = pat?.notes[req.channelId];
      const range = parseBarRange(req.bars);
      const melody = melodyNotes(Object.values(notesRec ?? {}), range === 'invalid' ? null : range, p.transport.timeSig);
      if (!melody.length) return fail('That channel has no notes to sing in this pattern');
      running = true;
      cancelled = false;
      try {
        const ok = await walk(req.preview ? ['phonemes', 'speaking', 'syllables', 'singing'] : ['phonemes', 'speaking', 'syllables', 'singing', 'placing'], {
          phonemes: 'Reading the lyrics',
          speaking: 'Speaking them line by line',
          syllables: 'Finding the syllables',
          singing: `Pitching ${melody.length} notes`,
          placing: 'Adding the vocal',
        });
        if (!ok) return fail('Cancelled');
        const parsed = parseLyrics(req.lyrics);
        const m = mapSyllables(parsed, melody);
        const mapping = plannedRows(parsed, melody);
        const last = melody[melody.length - 1];
        const seconds = ((last.tick + last.dur - melody[0].tick) / 960) * (60 / p.transport.bpm);
        const o: SingOutcome = { path: fakePath(req.lyrics), durationSec: seconds, engine: req.voiceId.startsWith('local:') ? 'local' : 'fish', notes: [...m.messages], mapping };
        if (!req.preview) {
          const r = place(`Add Sung: ${req.lyrics.slice(0, 20)}`, o.path, seconds, melody[0].tick);
          if (typeof r === 'string') return fail(r);
          o.clipId = r.clipId;
          o.channelId = r.channelId;
        }
        return { ok: true, data: o };
      } finally {
        running = false;
      }
    },
    async cancel() {
      if (!running) return fail('Nothing is rendering');
      cancelled = true;
      return { ok: true };
    },
    async setFishKey(key) {
      await wait(500);
      if (key === null) {
        keySet = false;
        broadcast();
        return { ok: true, message: 'Fish Audio key removed' };
      }
      if (key.trim().length < 16) return fail('Fish Audio refused the key (401): check you copied all of it');
      keySet = true;
      broadcast();
      return { ok: true, message: 'Key works: saved, encrypted on this PC (preview: nothing was sent)' };
    },
    async cloneMyVoice(opts) {
      if (!keySet) return fail('Add your Fish Audio key in Settings ▸ Voice first');
      if (opts.consent !== true) return fail('Tick the consent box first');
      await wait(900);
      const v: VoiceInfo = { id: `mine:${Date.now().toString(36)}`, engine: 'fish', name: opts.name, description: 'Your voice · private on Fish Audio', language: 'en', mine: true };
      mine.push(v);
      broadcast();
      return { ok: true, data: v };
    },
    async removeMyVoice(id) {
      const i = mine.findIndex((v) => v.id === id);
      if (i < 0) return fail('That voice is already gone');
      const [v] = mine.splice(i, 1);
      broadcast();
      return { ok: true, message: `Removed ${v.name} from Fish Audio and Krypt Studio` };
    },
  };
}
