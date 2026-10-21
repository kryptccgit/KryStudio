import { z } from 'zod';
import type { MainDeps, VoiceAccess } from '../types';
import { defineTool, fail, ok, type RunCtx } from './types';
import { findChannel, findPattern, safeName } from './util';

const zLabel = z.string().max(80).optional().describe("Short description of this change for the user's AI-history panel.");
const zTune = z.enum(['off', 'natural', 'pop', 'hard']);

function voice(deps: MainDeps): VoiceAccess {
  if (!deps.voice) fail('Krypt Voice is not available in this session (see the Krypt Studio log).');
  return deps.voice;
}

function runOpts(ctx: RunCtx) {
  return { onProgress: ctx.progress ? (stage: string, fraction: number) => ctx.progress!(fraction, stage || 'working') : undefined, signal: ctx.signal };
}

const apply = (ctx: RunCtx) => <T>(cmd: string, args: unknown): T => ctx.exec<T>(cmd, args);

export const listVoices = defineTool({
  name: 'list_voices',
  title: 'List Krypt Voice voices',
  kind: 'read',
  description:
    'The voices generate_voice and sing_notes can use: Local voices (Kokoro, offline and free, English; "local:af_heart" …) when the user installed the model, Cloud voices (Fish Audio\'s official voices, "fish:<id>") when the user added their own Fish key, and the user\'s own cloned voice ("mine:<id>") if they made one. Cloud voices send the text to Fish Audio. Also says why an engine is unavailable (model not installed / no key). You cannot install models, set keys or clone voices: tell the user where (Model Manager, Settings ▸ Voice).',
  input: z.object({ engine: z.enum(['local', 'fish']).optional().describe('Only this engine.') }),
  async run(deps, _c, a) {
    const st = await voice(deps).state();
    const voices = st.voices.filter((v) => !a.engine || v.engine === a.engine);
    const lines = voices.map((v) => `${v.id}  ${safeName(v.name, 40)}: ${safeName(v.description, 80)}${v.mine ? ' (the user\'s own voice)' : ''}`);
    const status = [
      `Local: ${st.local.installed ? 'installed' : 'not installed'}${st.local.message ? ` (${st.local.message})` : ''}`,
      `Cloud (Fish Audio): ${st.fish.keySet ? 'key set' : 'no key'}${st.fish.message ? ` (${st.fish.message})` : ''}`,
    ];
    const message = voices.length ? `${voices.length} voice${voices.length === 1 ? '' : 's'}. ${status.join('. ')}.` : `No voices available. ${status.join('. ')}.`;
    return ok(message, { local: st.local, fish: st.fish, voices }, { text: lines.join('\n') });
  },
});

export const generateVoice = defineTool({
  name: 'generate_voice',
  title: 'Speak text as an audio clip (Krypt Voice)',
  kind: 'write',
  description:
    'Text → speech as an audio clip on the Playlist, in one undo step: ad-libs, producer tags, intros, spoken word, a guide vocal. voice = an id from list_voices (default: the first Local voice, else a Cloud one); engine picks the default voice of "local" (offline, English) or "fish" (Cloud: the text is sent to Fish Audio with the user\'s key; supports emotion tags like [whisper] [excited] [laughing] in the text). speed 0.5–2. at = where it starts (bar "9" or "9.3"; default bar 1 / the playhead), track = an existing track (number or name; default a new track). The clip plays at its own speed (Follow tempo off). tune adds Krypt Tune (natural / pop / hard). Renders are cached (the same text + voice + speed is instant). Example: {"text":"[excited] Krypt on the beat!","engine":"fish","at":"1","tune":"off"}',
  input: z.object({
    text: z.string().min(1).max(1000).describe('What to say (≤ 1000 characters).'),
    voice: z.string().max(120).optional().describe('Voice id from list_voices, e.g. "local:af_heart".'),
    engine: z.enum(['local', 'fish']).optional().describe('Default voice of this engine when voice is not given. fish = Cloud (Fish Audio).'),
    speed: z.number().min(0.5).max(2).optional().describe('Speaking rate (default 1).'),
    at: z.union([z.number().int().min(1), z.string().max(16)]).optional().describe('Start: bar (1-based) or "bar.step".'),
    track: z.union([z.number().int().min(1), z.string().max(120)]).optional().describe('Existing Playlist track (number or name). Default: a new track.'),
    tune: zTune.default('off').describe('Krypt Tune on the clip (default off).'),
    change_label: zLabel,
  }),
  summarize: (a) => `"${safeName(a.text, 32)}"`,
  async run(deps, _c, a, ctx) {
    const svc = voice(deps);
    const r = await svc.speak(
      { text: a.text, voiceId: a.voice ?? '', engine: a.engine, speed: a.speed, at: a.at === undefined ? undefined : String(a.at), track: a.track === undefined ? undefined : String(a.track), tune: a.tune },
      apply(ctx),
      runOpts(ctx),
    );
    if (!r.ok || !r.data) fail(r.message ?? 'Speaking failed');
    const d = r.data;
    return ok(r.message ?? 'Added', { clipId: d.clipId, channelId: d.channelId, durationSec: d.durationSec, engine: d.engine, notes: d.notes });
  },
});

export const singNotes = defineTool({
  name: 'sing_notes',
  title: 'Sing lyrics on a melody (Krypt Voice)',
  kind: 'write',
  description:
    'Sing typed lyrics on a pattern\'s melody ("Sing my notes"), in one undo step: the channel\'s notes in the pattern become one monophonic line (the highest note wins), the lyrics are split into syllables (one per note; "-" splits a word yourself: "beau-ti-ful"; "_" holds a syllable over the next note: "love__"; new lines = phrases), spoken, then each syllable is stretched onto its note at the project tempo and pitched to it (formants kept, glide + vibrato). The result is one audio clip at the pattern\'s first note on the Playlist (a new track), with Krypt Tune (hard by default) in the song\'s key. Extra notes extend the last syllable; extra syllables squeeze onto the last note (the result says so and lists syllable → note). voice = an id from list_voices (Local is offline; Cloud sends the lyrics to Fish Audio). octave −2..2 moves the melody for the voice (−1 for a low voice on a high lead). bars = a bar range of the pattern ("1-4"). vibrato 0..1 (default 0.2). It is a guide-vocal quality, not a real singer. Example: {"pattern":"Hook","channel":"Lead","lyrics":"Hold me close_ to-night\\nnev-er let me go","octave":-1}',
  input: z.object({
    pattern: z.string().min(1).max(200).describe('Pattern id or name (the melody).'),
    channel: z.string().min(1).max(200).describe('Channel id or name whose notes are the melody.'),
    lyrics: z.string().min(1).max(2000).describe('Lyrics; "-" splits syllables, "_" holds one over the next note, new lines separate phrases.'),
    voice: z.string().max(120).optional().describe('Voice id from list_voices (default: the first Local voice, else a Cloud one).'),
    bars: z.string().max(16).optional().describe('Bars of the pattern to sing, e.g. "1-4" (default: all).'),
    tune: zTune.default('hard').describe('Krypt Tune style on the sung clip (default hard).'),
    octave: z.number().int().min(-2).max(2).default(0).describe('Shift the melody by octaves for the voice.'),
    vibrato: z.number().min(0).max(1).optional().describe('Vibrato depth 0..1 (default 0.2).'),
    change_label: zLabel,
  }),
  summarize: (a) => `${safeName(a.channel, 24)} in ${safeName(a.pattern, 24)}: "${safeName(a.lyrics, 24)}"`,
  async run(deps, _c, a, ctx) {
    const svc = voice(deps);
    const p = deps.doc.project;
    const pat = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const r = await svc.sing({ patternId: pat.id, channelId: ch.id, lyrics: a.lyrics, voiceId: a.voice ?? '', bars: a.bars, tune: a.tune, octave: a.octave, vibrato: a.vibrato }, apply(ctx), runOpts(ctx));
    if (!r.ok || !r.data) fail(r.message ?? 'Singing failed');
    const d = r.data;
    const rows = d.mapping.slice(0, 64).map((m) => `${m.syllable} → ${m.key} @ ${m.noteTick}`);
    return ok(r.message ?? 'Sung', { clipId: d.clipId, channelId: d.channelId, durationSec: d.durationSec, engine: d.engine, notes: d.notes, mapping: d.mapping.length }, { text: `Syllable → MIDI key @ pattern tick:\n${rows.join('\n')}${d.mapping.length > 64 ? `\n… ${d.mapping.length - 64} more` : ''}` });
  },
});

export const VOICE_TOOLS = [listVoices, generateVoice, singNotes];
