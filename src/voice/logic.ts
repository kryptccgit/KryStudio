// ──────────────────────────────────────────────────────────────────────
// Krypt Voice view logic (research/21): the voice list in Local / Cloud /
// My voice groups, what blocks a voice (no Kokoro model, no Fish key),
// the text box (character count, Fish tags inserted at the cursor, tags
// stripped for local voices), the forms → SpeakRequest / SingRequest,
// the progress stages, failure messages, the Fish key checks, and the
// own-voice recording helpers. Pure: no window.krypt, no React.
// ──────────────────────────────────────────────────────────────────────

import { FISH_TAGS, type SingRequest, type SpeakRequest, type VoiceEngine, type VoiceInfo, type VoiceProgress, type VoiceStage, type VoiceState } from '@shared/voice/types';
import type { Project } from '@shared/schema/project';
import { ticksPerBar, ticksPerBeat, type TimeSig } from '@shared/schema/time';
import { parseBarRange } from './sing';

export type TuneStyle = NonNullable<SpeakRequest['tune']>;
export type VoiceGroup = 'local' | 'cloud' | 'mine';

export const TUNE_OPTIONS: ReadonlyArray<{ value: TuneStyle; label: string; title: string }> = [
  { value: 'off', label: 'Off', title: 'No Krypt Tune: the voice as it was rendered' },
  { value: 'natural', label: 'Natural', title: 'Krypt Tune, gentle: keeps it human' },
  { value: 'pop', label: 'Pop', title: 'Krypt Tune, tight: polished pop pitch' },
  { value: 'hard', label: 'Hard', title: 'Krypt Tune, instant: the robotic tuned sound' },
];

/** Where Fish keys come from (free developer tier). */
export const FISH_KEY_URL = 'https://fish.audio/app/api-keys/';
export const FISH_PRIVACY =
  'Fish Audio receives your text and, for My voice, your recording. They may use requests to improve their models. The free tier ends on the date Fish Audio sets.';
export const CLOUD_NOTE = 'Cloud: your text is sent to Fish Audio with your own key.';
export const LOCAL_NOTE = 'On your PC: nothing leaves this computer.';

// ── Voices ────────────────────────────────────────────────────────────

/** 'local:af_heart' → local, 'fish:…' → cloud, 'mine:…' → my voice (a Fish clone of the user). */
export function groupOf(v: Pick<VoiceInfo, 'id' | 'engine' | 'mine'>): VoiceGroup {
  if (v.mine || v.id.startsWith('mine:')) return 'mine';
  return v.engine === 'local' ? 'local' : 'cloud';
}

export function engineOfId(id: string): VoiceEngine {
  return id.startsWith('local:') ? 'local' : 'fish';
}

export function groupVoices(voices: readonly VoiceInfo[]): Record<VoiceGroup, VoiceInfo[]> {
  const out: Record<VoiceGroup, VoiceInfo[]> = { local: [], cloud: [], mine: [] };
  for (const v of voices) out[groupOf(v)].push(v);
  return out;
}

export const GROUP_LABEL: Record<VoiceGroup, string> = { local: 'Local', cloud: 'Cloud', mine: 'My voice' };

export type VoiceBlock = { kind: 'needModel'; message: string } | { kind: 'needKey'; message: string } | { kind: 'missing'; message: string };

/** Why this voice can't be used right now (null = ready). */
export function voiceBlock(state: VoiceState | null, voiceId: string | null): VoiceBlock | null {
  if (!state) return null;
  if (!voiceId) return { kind: 'missing', message: 'Pick a voice first' };
  const engine = engineOfId(voiceId);
  if (engine === 'local' && !state.local.installed)
    return { kind: 'needModel', message: state.local.message || 'Local voices need the Kokoro model: install it once in the Model Manager (free, runs offline)' };
  if (engine === 'fish' && !state.fish.keySet) return { kind: 'needKey', message: state.fish.message || 'Cloud voices need your free Fish Audio key: add it in Settings ▸ Voice' };
  if (!state.voices.some((v) => v.id === voiceId)) return { kind: 'missing', message: "That voice isn't available any more: pick another" };
  return null;
}

/** The voice to select: the remembered one if it is still listed, else the first usable local, cloud, then any voice. */
export function pickVoice(state: VoiceState | null, remembered: string | null): string | null {
  if (!state) return remembered;
  const vs = state.voices;
  if (remembered && vs.some((v) => v.id === remembered)) return remembered;
  const usable = vs.filter((v) => !voiceBlock(state, v.id));
  const g = groupVoices(usable);
  return g.local[0]?.id ?? g.mine[0]?.id ?? g.cloud[0]?.id ?? vs[0]?.id ?? null;
}

export function isCloudVoice(voiceId: string | null): boolean {
  return !!voiceId && engineOfId(voiceId) === 'fish';
}

// ── Text ──────────────────────────────────────────────────────────────

export const MAX_TEXT = 2000;

export function charCountLabel(text: string): string {
  const n = [...text].length;
  return `${n.toLocaleString('en-US')} / ${MAX_TEXT.toLocaleString('en-US')}`;
}

const TAG_RE = /\[[a-z][a-z \-]{0,30}\]/gi;

export function hasTags(text: string): boolean {
  TAG_RE.lastIndex = 0;
  return TAG_RE.test(text);
}

/** Local voices would read "[whisper]" out loud: drop the tags and tidy the spaces. */
export function stripTags(text: string): string {
  return text
    .replace(TAG_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n +/g, '\n')
    .trim();
}

/** Insert a tag at the cursor (replacing a selection), with a space on either side where needed. Returns the new text and caret. */
export function insertAtCursor(text: string, insert: string, selStart: number, selEnd: number = selStart): { text: string; caret: number } {
  const a = Math.max(0, Math.min(text.length, Math.min(selStart, selEnd)));
  const b = Math.max(a, Math.min(text.length, Math.max(selStart, selEnd)));
  const before = text.slice(0, a);
  const after = text.slice(b);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : after ? '' : ' ';
  const out = `${before}${lead}${insert}${trail}${after}`;
  return { text: out, caret: before.length + lead.length + insert.length + trail.length };
}

export function textError(text: string): string | null {
  const t = text.trim();
  if (!t) return 'Type what the voice should say';
  if (!stripTags(t)) return 'Only tags so far: type the words too';
  if ([...text].length > MAX_TEXT) return `That's too long: ${MAX_TEXT} characters at most per clip (split it into a few clips)`;
  return null;
}

export const TAG_CHIPS: readonly string[] = FISH_TAGS;

// ── Speed ─────────────────────────────────────────────────────────────

export function clampSpeed(v: number): number {
  return Number.isFinite(v) ? Math.max(0.5, Math.min(2, Math.round(v * 20) / 20)) : 1;
}

export function fmtSpeed(v: number): string {
  return `${clampSpeed(v).toFixed(2).replace(/0$/, '')}×`;
}

// ── Placement ─────────────────────────────────────────────────────────

export interface Placement {
  mode: 'playhead' | 'bar';
  /** "9" or "9.3" (bar.beat). */
  bar: string;
  /** '' = a new track; else a track id. */
  trackId: string;
}

export const DEFAULT_PLACEMENT: Placement = { mode: 'playhead', bar: '1', trackId: '' };

export function barError(bar: string): string | null {
  const t = bar.trim();
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(t)) return 'Type a bar like 9, or 9.3 for bar 9, beat 3';
  const [b, beat] = t.split('.').map(Number);
  if (b < 1) return 'Bars start at 1';
  if (beat !== undefined && beat < 1) return 'Beats start at 1';
  return null;
}

export function placementLine(p: Placement, trackName?: string): string {
  const track = p.trackId ? `on ${trackName ?? 'the chosen track'}` : 'on a new track';
  return p.mode === 'playhead' ? `At the playhead, ${track}` : `At bar ${p.bar.trim()}, ${track}`;
}

// ── The forms → requests ──────────────────────────────────────────────

export interface SpeakForm {
  text: string;
  voiceId: string | null;
  speed: number;
  tune: TuneStyle;
  placement: Placement;
}

export const DEFAULT_SPEAK: SpeakForm = { text: '', voiceId: null, speed: 1, tune: 'off', placement: { ...DEFAULT_PLACEMENT } };

export function speakFormError(f: SpeakForm, state: VoiceState | null, preview: boolean): string | null {
  const t = textError(f.text);
  if (t) return t;
  const b = voiceBlock(state, f.voiceId);
  if (b) return b.message;
  if (!preview && f.placement.mode === 'bar') return barError(f.placement.bar);
  return null;
}

/** A song tick → the "bar.step" position main understands (1-based; 16th steps). */
export function tickToAt(tick: number, ppq: number, num: number, den: number): string {
  const bar = (ppq * 4 * num) / den;
  const t = Math.max(0, Math.floor(tick));
  const b = Math.floor(t / bar) + 1;
  const step = Math.floor((t % bar) / (ppq / 4)) + 1;
  return step > 1 ? `${b}.${step}` : String(b);
}

/** `playheadAt`: the playhead as "bar.step" (the dialog reads it at send time); used for placement mode 'playhead'. */
export function buildSpeakRequest(f: SpeakForm, preview: boolean, playheadAt?: string): SpeakRequest | null {
  if (!f.voiceId) return null;
  const local = engineOfId(f.voiceId) === 'local';
  const text = local ? stripTags(f.text) : f.text.trim();
  const req: SpeakRequest = { text, voiceId: f.voiceId };
  const speed = clampSpeed(f.speed);
  if (speed !== 1) req.speed = speed;
  if (preview) req.preview = true;
  else {
    if (f.placement.mode === 'bar') req.at = f.placement.bar.trim();
    else if (playheadAt) req.at = playheadAt;
    if (f.placement.trackId) req.track = f.placement.trackId;
    if (f.tune !== 'off') req.tune = f.tune;
  }
  if (preview && f.tune !== 'off') req.tune = f.tune;
  return req;
}

export interface SingForm {
  lyrics: string;
  voiceId: string | null;
  octave: number;
  vibrato: number;
  glideMs: number;
  tune: TuneStyle;
  /** "1-4", or '' for the whole pattern. */
  bars: string;
}

export const DEFAULT_SING: SingForm = { lyrics: '', voiceId: null, octave: 0, vibrato: 0.2, glideMs: 40, tune: 'hard', bars: '' };

export const OCTAVE_OPTIONS: ReadonlyArray<{ value: number; label: string; title: string }> = [
  { value: -2, label: '−2', title: 'Two octaves down' },
  { value: -1, label: '−1', title: 'One octave down: a low voice on a high lead line' },
  { value: 0, label: '0', title: 'As written' },
  { value: 1, label: '+1', title: 'One octave up' },
  { value: 2, label: '+2', title: 'Two octaves up' },
];

export function singFormError(f: SingForm, state: VoiceState | null, noteCount: number): string | null {
  if (!f.lyrics.trim()) return 'Type the lyrics first';
  if (!noteCount) return 'This channel has no notes to sing in this pattern (or in those bars): draw a melody first';
  if (parseBarRange(f.bars) === 'invalid') return 'Bars: type a range like 1-4, or leave it empty for the whole pattern';
  return voiceBlock(state, f.voiceId)?.message ?? null;
}

export function buildSingRequest(f: SingForm, target: { patternId: string; channelId: string }, preview: boolean): SingRequest | null {
  if (!f.voiceId) return null;
  const req: SingRequest = {
    patternId: target.patternId,
    channelId: target.channelId,
    lyrics: f.lyrics.trim(),
    voiceId: f.voiceId,
    tune: f.tune,
    vibrato: Math.max(0, Math.min(1, f.vibrato)),
    glideMs: Math.max(0, Math.min(400, Math.round(f.glideMs))),
  };
  const range = parseBarRange(f.bars);
  if (range && range !== 'invalid') req.bars = range.from === range.to ? String(range.from) : `${range.from}-${range.to}`;
  if (f.octave) req.octave = Math.max(-2, Math.min(2, Math.round(f.octave)));
  if (preview) req.preview = true;
  return req;
}

// ── Progress ──────────────────────────────────────────────────────────

export type JobKind = 'speak' | 'sing';
export type JobPhase = 'idle' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';
export type StageState = 'pending' | 'active' | 'done' | 'failed' | 'stopped';

const STAGE_LABEL: Record<VoiceStage, string> = {
  phonemes: 'Reading the text',
  speaking: 'Speaking',
  syllables: 'Finding the syllables',
  singing: 'Putting them on your notes',
  placing: 'Adding it to the song',
};

export function stagesFor(kind: JobKind, preview: boolean): Array<{ id: VoiceStage; label: string }> {
  const ids: VoiceStage[] = kind === 'speak' ? ['phonemes', 'speaking'] : ['phonemes', 'speaking', 'syllables', 'singing'];
  if (!preview) ids.push('placing');
  return ids.map((id) => ({ id, label: STAGE_LABEL[id] }));
}

export function stageStates(stages: ReadonlyArray<{ id: VoiceStage }>, phase: JobPhase, current: VoiceStage | null): StageState[] {
  if (phase === 'done') return stages.map(() => 'done');
  const at = current ? stages.findIndex((s) => s.id === current) : -1;
  const now: StageState = phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'stopped' : phase === 'running' || phase === 'cancelling' ? 'active' : 'pending';
  return stages.map((_, i) => {
    if (at < 0) return i === 0 && now !== 'pending' ? now : 'pending';
    if (i < at) return 'done';
    if (i === at) return now;
    return 'pending';
  });
}

export function barFraction(phase: JobPhase, p: VoiceProgress | null): number {
  if (phase === 'done') return 1;
  if (!p || !(p.fraction >= 0)) return -1;
  return Math.max(0, Math.min(1, p.fraction));
}

export function percentText(fraction: number): string {
  return fraction >= 0 ? `${Math.round(fraction * 100)} %` : '';
}

// ── Failures ──────────────────────────────────────────────────────────

export const NOT_AVAILABLE = "Krypt Voice isn't available in this build yet: the voice service didn't answer. Restart Krypt Studio after updating it.";

export function failureMessage(err: unknown, fallback = 'Krypt Voice failed without saying why'): string {
  const m = typeof err === 'string' ? err : ((err as Error)?.message ?? String(err ?? ''));
  if (/no handler registered/i.test(m)) return NOT_AVAILABLE;
  const clean = m.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '').trim();
  return clean || fallback;
}

export function isCancelMessage(m: string | undefined): boolean {
  return /cancel/i.test(m ?? '');
}

/** A failure that a Model Manager button fixes. */
export function needsModel(m: string | undefined): boolean {
  return /kokoro|model manager|tts model|voice model/i.test(m ?? '');
}

/** A failure that Settings ▸ Voice fixes (no key, a refused key, the free tier over). */
export function needsKey(m: string | undefined): boolean {
  return /fish (audio )?key|api key|401|unauthori[sz]ed|settings ▸ voice|free tier/i.test(m ?? '');
}

export function fmtSeconds(sec: number): string {
  if (!(sec >= 0)) return '';
  return sec < 10 ? `${sec.toFixed(1)} s` : `${Math.round(sec)} s`;
}

// ── Fish key ──────────────────────────────────────────────────────────

/** A quick shape check before the real verification request (keys are long tokens without spaces). */
export function fishKeyError(key: string): string | null {
  const k = key.trim();
  if (!k) return 'Paste your Fish Audio key first';
  if (/\s/.test(k)) return "That doesn't look like a key: it has spaces in it";
  if (k.length < 16) return "That's too short to be a Fish Audio key";
  return null;
}

// ── My voice (recording + clone) ──────────────────────────────────────

export const RECORD_TARGET_SEC = 30;
export const RECORD_MIN_SEC = 10;

/** Read after the consent line: varied sounds, about 30 seconds aloud. */
export const READING_PASSAGE =
  'The quick brown fox jumps over the lazy dog. I make music late at night, with headphones on and the lights down low. ' +
  'Some days the beat comes first, and some days it starts with a melody I hum on the way home. ' +
  'Every voice is different: the way we breathe, the way we laugh, the way we say our own name. This one is mine.';

export function cloneNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give your voice a name';
  if (n.length > 40) return 'Keep the name under 40 characters';
  return null;
}

export function recordingTooShort(sec: number): boolean {
  return sec < RECORD_MIN_SEC;
}

/** The audio clips added since `before` (a take the recorder just placed), newest-looking first, with the WAV path. */
export function newAudioTakes(p: Project, before: ReadonlySet<string>): Array<{ clipId: string; channelId: string; path: string; seconds: number | null }> {
  const out: Array<{ clipId: string; channelId: string; path: string; seconds: number | null }> = [];
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'audio' || before.has(c.id) || !c.channelId) continue;
    const ch = p.channels[c.channelId];
    const s = ch?.generator.sampleId ? p.samples[ch.generator.sampleId] : undefined;
    if (!s || s.origin) continue; // only recorded / imported audio, never a rendered or separated file
    out.push({ clipId: c.id, channelId: c.channelId, path: s.path, seconds: s.frames && s.sampleRate ? s.frames / s.sampleRate : null });
  }
  return out.reverse();
}

export function audioClipIds(p: Project): Set<string> {
  return new Set(Object.values(p.playlist.clips).filter((c) => c.kind === 'audio').map((c) => c.id));
}

// ── Results ───────────────────────────────────────────────────────────

export function doneLine(kind: JobKind, o: { durationSec: number; engine: VoiceEngine; clipId?: string }, preview: boolean): string {
  const what = kind === 'sing' ? 'Sung' : 'Spoken';
  const where = o.engine === 'fish' ? ' (Fish Audio, cloud)' : ' (on your PC)';
  if (preview) return `${what} ${fmtSeconds(o.durationSec)}${where}: playing the preview`;
  return `${what} ${fmtSeconds(o.durationSec)}${where} and added to the song`;
}

/** A timeline tick → the "9" / "9.3" bar text SpeakRequest.at takes (beat only when it isn't the downbeat). */
export function barAtTick(tick: number, ts: TimeSig): string {
  const bar = ticksPerBar(ts);
  const beat = ticksPerBeat(ts);
  const t = Math.max(0, Math.floor(tick));
  const b = Math.floor(t / bar) + 1;
  const bt = Math.floor((t % bar) / beat) + 1;
  return bt > 1 ? `${b}.${bt}` : String(b);
}
