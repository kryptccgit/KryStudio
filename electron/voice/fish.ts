import { CONSENT_LINE } from '@shared/voice/types';

export const FISH_API = 'https://api.fish.audio';
export const FISH_TTS_MODEL = 's2.1-pro-free';
export const FISH_KEYS_URL = 'https://fish.audio/app/api-keys/';
export const FISH_SAMPLE_RATE = 44100;

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export class FishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly cancelled = false,
  ) {
    super(message);
    this.name = 'FishError';
  }
}

export interface FishVoice {
  id: string;
  title: string;
  description: string;
  languages: string[];
  tags: string[];
}

export interface FishClientOptions {
  fetch: FetchLike;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  base?: string;
}

const clean = (s: unknown, max = 160): string =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export function fishErrorMessage(status: number, body: string, what: string): string {
  let msg = '';
  try {
    const j = JSON.parse(body) as { message?: unknown; detail?: unknown; reason?: unknown };
    msg = clean(j.message ?? (typeof j.detail === 'string' ? j.detail : '') ?? '');
    if (j.reason) msg = msg ? `${msg} (${clean(j.reason, 80)})` : clean(j.reason);
  } catch {
    msg = clean(body.replace(/<[^>]+>/g, ' '), 120);
  }
  const said = msg ? ` Fish Audio said: "${msg}".` : '';
  if (/free/i.test(msg) && /(end|expire|no longer|over|discontinu)/i.test(msg)) {
    return `Fish Audio's free developer tier (${FISH_TTS_MODEL}) has ended for your account, so ${what} didn't run.${said} Add credit at fish.audio, or use a Local voice (offline, free).`;
  }
  switch (status) {
    case 401:
      return `Fish Audio didn't accept your API key (it may be mistyped, revoked or expired), so ${what} didn't run. Paste a new key in Settings ▸ Voice (free keys: ${FISH_KEYS_URL}).`;
    case 402:
      return `Fish Audio says your account has no credit left for ${what}: the free developer tier (${FISH_TTS_MODEL}) may have ended or reached its fair-use limit.${said} Add credit at fish.audio, or use a Local voice (offline, free).`;
    case 403:
      return `Fish Audio refused ${what} for this key (403).${said}`;
    case 404:
      return `Fish Audio couldn't find that voice (it may have been deleted), so ${what} didn't run.${said}`;
    case 413:
      return `That is too much for Fish Audio in one request (${what}): send a shorter text or recording.`;
    case 429:
      return `Fish Audio is rate-limiting your key (too many requests, or the free tier's fair-use limit), so ${what} didn't run. Wait a minute and try again.${said}`;
    case 400:
    case 422:
      return `Fish Audio couldn't use the request for ${what} (${status}).${said}`;
    default:
      if (status >= 500) return `Fish Audio is busy or down right now (HTTP ${status}), so ${what} didn't run. Try again in a moment, or use a Local voice.`;
      return `Fish Audio answered HTTP ${status} to ${what}.${said}`;
  }
}

export function consentHeard(transcript: string, line = CONSENT_LINE): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean);
  const want = words(line);
  const got = words(transcript).slice(0, want.length * 2 + 8);
  const close = (a: string, b: string): boolean => {
    if (a === b) return true;
    if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i++;
        j++;
        continue;
      }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else {
        i++;
        j++;
      }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  };
  let k = 0;
  let hit = 0;
  for (const w of got) {
    for (let look = k; look < Math.min(want.length, k + 3); look++) {
      if (close(w, want[look])) {
        hit++;
        k = look + 1;
        break;
      }
    }
    if (k >= want.length) break;
  }
  return want.length > 0 && hit / want.length >= 0.7;
}

export class FishClient {
  private readonly base: string;

  constructor(private readonly opts: FishClientOptions) {
    this.base = opts.base ?? FISH_API;
  }

  private async call(key: string, what: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }, logLine: string) {
    this.opts.log('info', `Krypt Voice: sent to Fish Audio (Cloud): ${logLine}`);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.opts.fetch(`${this.base}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });
    } catch (err) {
      if (init.signal?.aborted || (err as Error)?.name === 'AbortError') throw new FishError('Cancelled', 0, true);
      throw new FishError(`Couldn't reach Fish Audio for ${what} (${clean((err as Error)?.message ?? err, 100) || 'network error'}). Check your internet connection; Local voices work offline.`, 0);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const message = fishErrorMessage(res.status, body, what);
      this.opts.log('warn', `Krypt Voice: Fish Audio answered HTTP ${res.status} to ${logLine}`);
      throw new FishError(message, res.status);
    }
    return res;
  }

  private async json<T>(res: { text(): Promise<string> }, what: string): Promise<T> {
    const t = await res.text();
    try {
      return JSON.parse(t) as T;
    } catch {
      throw new FishError(`Fish Audio sent an answer Krypt Studio couldn't read for ${what}.`, 0);
    }
  }

  async verify(key: string, signal?: AbortSignal): Promise<{ freeCredit: boolean | null }> {
    const res = await this.call(key, 'checking your key', '/wallet/self/api-credit?check_free_credit=true', { method: 'GET', signal }, 'key check (no text)');
    const j = await this.json<{ has_free_credit?: boolean | null }>(res, 'checking your key').catch(() => ({ has_free_credit: null }));
    return { freeCredit: typeof j.has_free_credit === 'boolean' ? j.has_free_credit : null };
  }

  async tts(key: string, req: { text: string; referenceId: string; speed: number; signal?: AbortSignal }): Promise<Uint8Array> {
    const body = {
      text: req.text,
      reference_id: req.referenceId,
      format: 'wav',
      sample_rate: FISH_SAMPLE_RATE,
      normalize: true,
      latency: 'normal',
      prosody: { speed: req.speed, volume: 0 },
    };
    const res = await this.call(
      key,
      'speech',
      '/v1/tts',
      { method: 'POST', headers: { 'Content-Type': 'application/json', model: FISH_TTS_MODEL }, body: JSON.stringify(body), signal: req.signal },
      `text to speech (${[...req.text].length} characters, voice ${req.referenceId}, model ${FISH_TTS_MODEL})`,
    );
    return new Uint8Array(await res.arrayBuffer());
  }

  async officialVoices(key: string, signal?: AbortSignal): Promise<FishVoice[]> {
    const res = await this.call(key, 'listing voices', '/model?licensed=true&sort_by=score&page_size=30', { method: 'GET', signal }, 'voice list (licensed voices)');
    const j = await this.json<{ items?: Array<Record<string, unknown>> }>(res, 'listing voices');
    const items = Array.isArray(j.items) ? j.items : [];
    return items
      .filter((m) => typeof m._id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(m._id as string) && (m.type === undefined || m.type === 'tts'))
      .map((m) => ({
        id: m._id as string,
        title: clean(m.title, 48) || 'Fish voice',
        description: clean(m.description, 120),
        languages: Array.isArray(m.languages) ? (m.languages as unknown[]).map((x) => clean(x, 8)).filter(Boolean).slice(0, 4) : [],
        tags: Array.isArray(m.tags) ? (m.tags as unknown[]).map((x) => clean(x, 24)).filter(Boolean).slice(0, 4) : [],
      }));
  }

  async transcribe(key: string, wav: Uint8Array, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'my-voice.wav');
    form.append('language', 'en');
    form.append('ignore_timestamps', 'true');
    const res = await this.call(key, 'checking the consent line', '/v1/asr', { method: 'POST', body: form, signal }, `speech to text of your "my voice" recording (${wav.byteLength} bytes)`);
    const j = await this.json<{ text?: unknown }>(res, 'checking the consent line');
    return typeof j.text === 'string' ? j.text : '';
  }

  async createVoice(key: string, req: { title: string; wav: Uint8Array; text?: string; signal?: AbortSignal }): Promise<{ id: string; state: string }> {
    const form = new FormData();
    form.append('type', 'tts');
    form.append('title', req.title);
    form.append('train_mode', 'fast');
    form.append('visibility', 'private');
    form.append('description', 'My own voice, recorded in Krypt Studio.');
    form.append('enhance_audio_quality', 'true');
    form.append('voices', new Blob([new Uint8Array(req.wav)], { type: 'audio/wav' }), 'my-voice.wav');
    if (req.text) form.append('texts', req.text);
    const res = await this.call(key, 'creating your voice', '/model', { method: 'POST', body: form, signal: req.signal }, `create a private voice model from your recording (${req.wav.byteLength} bytes)`);
    const j = await this.json<{ _id?: unknown; state?: unknown }>(res, 'creating your voice');
    if (typeof j._id !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(j._id)) throw new FishError("Fish Audio created the voice but didn't return its id.", 0);
    return { id: j._id, state: typeof j.state === 'string' ? j.state : 'created' };
  }

  async deleteVoice(key: string, id: string, signal?: AbortSignal): Promise<'deleted' | 'gone'> {
    try {
      await this.call(key, 'deleting your voice', `/model/${encodeURIComponent(id)}`, { method: 'DELETE', signal }, `delete your voice model ${id}`);
      return 'deleted';
    } catch (err) {
      if (err instanceof FishError && err.status === 404) return 'gone';
      throw err;
    }
  }
}
