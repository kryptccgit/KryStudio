// ──────────────────────────────────────────────────────────────────────
// Clip launcher runtime (main process), Wave 12.2 (research/16 §2.1).
//
//   renderer / MCP ─▶ this ─NDJSON─▶ engine: launch, launchScene, launchStop,
//                                     backToArrangement, setLaunchRecord, setLaunchGrid
//   engine `launchRecorded` ─▶ session.capture (actor user, ONE undo step)
//                           ─▶ SessionRecordState.lastCapture (the renderer toasts it)
//
// Editing the grid is plain doc commands (session.*); this only drives
// playback. Scene tempo is applied as a doc edit (transport.set) by the
// launching actor. The grid-controller note map is recomputed whenever the
// launcher layout (scenes, clips, track order), the settings or the engine
// (restart) change, and re-sent only when it differs.
// ──────────────────────────────────────────────────────────────────────

import { USER, type DocHost, type DocChange } from '@shared/doc/DocHost';
import type { ActionResult, LaunchGridSettings, SessionRecordState, Settings } from '@shared/types';
import type { EngineEvent, LaunchRecordEntry } from '@shared/engine/protocol';
import { launchGridMap, launchGridSettings, mergeLaunchGrid } from '@shared/live/launchGrid';
import { EVENT } from '../channels';
import type { EngineClient } from '../engine/types';

export interface SessionDeps {
  doc: DocHost;
  engine: Pick<EngineClient, 'request' | 'onEvent' | 'onStatus' | 'status'>;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  onSettingsChanged(fn: (s: Settings, prev: Settings) => void): () => void;
  broadcast(channel: string, payload: unknown): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

/** Runs a doc command for the launching actor; throws (or returns ok:false) on failure. */
export type SessionExec = (cmd: string, args: unknown) => { ok: boolean; message?: string } | unknown;

const LAUNCH_TIMEOUT_MS = 3000;

const quote = (s: string, max = 40): string => `"${s.length > max ? s.slice(0, max - 1) + '…' : s}"`;

export class SessionController {
  private recordOn = false;
  private lastCapture: SessionRecordState['lastCapture'];
  private captureSeq = 0;
  private gridKey = 'off';
  private engineState = '';
  private offs: Array<() => void> = [];

  constructor(private readonly d: SessionDeps) {}

  start(): void {
    this.offs.push(
      this.d.engine.onStatus((s) => {
        const was = this.engineState;
        this.engineState = s.state;
        if (s.state === 'running' && was !== 'running') void this.sync();
      }),
      this.d.engine.onEvent((e) => this.onEngineEvent(e)),
      this.d.doc.subscribe((c) => {
        if (layoutChanged(c)) void this.pushGrid();
      }),
      this.d.onSettingsChanged((s, prev) => {
        if (JSON.stringify(launchGridSettings(s)) !== JSON.stringify(launchGridSettings(prev))) void this.pushGrid();
      }),
    );
    if (this.d.engine.status().state === 'running') {
      this.engineState = 'running';
      void this.sync();
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  // ── Engine sync ────────────────────────────────────────────────────

  /** After every engine (re)start: the engine forgot the record switch and the grid map. */
  private async sync(): Promise<void> {
    this.gridKey = 'off';
    if (this.recordOn) {
      const r = await this.d.engine.request({ cmd: 'setLaunchRecord', on: true }, LAUNCH_TIMEOUT_MS);
      if (!r.ok) {
        this.recordOn = false;
        this.broadcastRecord();
        this.d.log('warn', `Launch recording was switched off: the restarted audio engine refused it (${r.message ?? 'no reply'})`);
      }
    }
    await this.pushGrid();
  }

  /** Send the grid-controller note map when it changed (and the engine runs). */
  async pushGrid(): Promise<ActionResult> {
    if (this.d.engine.status().state !== 'running') return { ok: true };
    const settings = launchGridSettings(this.d.getSettings());
    const map = launchGridMap(this.d.doc.project, settings);
    const key = settings.enabled ? JSON.stringify(map) : 'off';
    if (key === this.gridKey) return { ok: true };
    const prev = this.gridKey;
    this.gridKey = key;
    const r = await this.d.engine.request({ cmd: 'setLaunchGrid', device: map.device, channel: map.channel, notes: map.notes, ...(map.cc ? { cc: true } : {}) }, LAUNCH_TIMEOUT_MS);
    if (!r.ok) {
      if (this.gridKey === key) this.gridKey = prev;
      this.d.log('warn', `Couldn't send the launch grid mapping to the audio engine: ${r.message ?? 'no reply'}`);
    }
    return r;
  }

  private onEngineEvent(e: EngineEvent): void {
    if (e.event === 'launchRecorded') this.capture(Array.isArray(e.entries) ? e.entries : []);
  }

  /** Write launch-recorded spans into the playlist (one undo step, actor user) and report it to the renderer. */
  capture(entries: LaunchRecordEntry[]): ActionResult<{ placed: number; spans: number; skipped: number }> {
    if (!entries.length) return { ok: true, message: 'Nothing was launched while recording' };
    const r = this.d.doc.exec<{ placed: number; spans: number; skipped: number }>('session.capture', { entries }, { actor: USER, label: 'Record launches' });
    let result: ActionResult<{ placed: number; spans: number; skipped: number }>;
    if (!r.ok) {
      result = { ok: false, message: `Couldn't write the launch recording into the playlist: ${r.message ?? 'unknown error'}` };
      this.d.log('error', result.message!);
    } else {
      const { placed = 0, spans = 0, skipped = 0 } = r.data ?? {};
      const tracks = new Set(entries.map((x) => x.trackId)).size;
      const skip = skipped ? ` (${skipped} span${skipped === 1 ? '' : 's'} skipped: the clip or track was deleted)` : '';
      result = spans
        ? { ok: true, message: `Launch recording written to the playlist: ${placed} clip${placed === 1 ? '' : 's'} on ${tracks} track${tracks === 1 ? '' : 's'}${skip}. Ctrl+Z undoes it.`, data: { placed, spans, skipped } }
        : { ok: false, message: `Nothing from the launch recording could be written${skip}.`, data: { placed, spans, skipped } };
      this.d.log(spans ? 'info' : 'warn', result.message!);
    }
    this.lastCapture = { id: ++this.captureSeq, ok: result.ok, message: result.message ?? '' };
    this.broadcastRecord();
    return result;
  }

  // ── Launching ──────────────────────────────────────────────────────

  private engineDown(): ActionResult<never> | null {
    const st = this.d.engine.status();
    if (st.state === 'running') return null;
    return { ok: false, message: `The audio engine isn't running${st.message ? ` (${st.message})` : ''}` } as ActionResult<never>;
  }

  async launch(clipId: string, release = false): Promise<ActionResult> {
    const p = this.d.doc.project;
    const c = p.session?.clips[clipId];
    if (!c) return { ok: false, message: 'That launch clip no longer exists' };
    const down = this.engineDown();
    if (down) return down;
    const r = await this.d.engine.request({ cmd: 'launch', clipId, ...(release ? { release: true } : {}) }, LAUNCH_TIMEOUT_MS);
    if (!r.ok) return { ok: false, message: `Couldn't launch the clip: ${r.message ?? 'engine error'}` };
    return { ok: true, message: release ? 'Released' : `Launched ${quote(clipLabel(p, c.id))}` };
  }

  /** Launch a scene row; a scene tempo is set first through transport.set (by `exec`, default: the user). */
  async launchScene(sceneId: string, exec?: SessionExec): Promise<ActionResult<{ tempo: number | null }>> {
    const p = this.d.doc.project;
    const sc = p.session?.scenes[sceneId];
    if (!sc) return { ok: false, message: 'That scene no longer exists' };
    const down = this.engineDown();
    if (down) return down;
    let tempo: number | null = null;
    if (sc.tempo !== null && Math.abs(sc.tempo - p.transport.bpm) > 1e-6) {
      const run: SessionExec = exec ?? ((cmd, args) => this.d.doc.exec(cmd, args, { actor: USER, label: `Scene ${quote(sc.name)} tempo ${sc.tempo}` }));
      const t = run('transport.set', { bpm: sc.tempo }) as { ok?: boolean; message?: string } | undefined;
      if (t && t.ok === false) return { ok: false, message: `Couldn't set the scene tempo: ${t.message ?? 'unknown error'}` };
      tempo = sc.tempo;
    }
    const r = await this.d.engine.request({ cmd: 'launchScene', sceneId }, LAUNCH_TIMEOUT_MS);
    if (!r.ok) return { ok: false, message: `Couldn't launch the scene: ${r.message ?? 'engine error'}` };
    return { ok: true, message: `Launched scene ${quote(sc.name)}${tempo !== null ? ` at ${tempo} bpm` : ''}`, data: { tempo } };
  }

  async stop(trackId: string | null): Promise<ActionResult> {
    const p = this.d.doc.project;
    if (trackId !== null && !p.playlist.tracks[trackId]) return { ok: false, message: 'That track no longer exists' };
    const down = this.engineDown();
    if (down) return down;
    const r = await this.d.engine.request({ cmd: 'launchStop', trackId }, LAUNCH_TIMEOUT_MS);
    if (!r.ok) return { ok: false, message: `Couldn't stop: ${r.message ?? 'engine error'}` };
    return { ok: true, message: trackId === null ? 'Stopping every launched clip' : `Stopping ${quote(p.playlist.tracks[trackId].name)}` };
  }

  async backToArrangement(): Promise<ActionResult> {
    const down = this.engineDown();
    if (down) return down;
    const r = await this.d.engine.request({ cmd: 'backToArrangement' }, LAUNCH_TIMEOUT_MS);
    if (!r.ok) return { ok: false, message: `Couldn't return to the arrangement: ${r.message ?? 'engine error'}` };
    return { ok: true, message: 'Back to the arrangement' };
  }

  // ── Launch recording ───────────────────────────────────────────────

  recordState(): SessionRecordState {
    return { on: this.recordOn, ...(this.lastCapture ? { lastCapture: { ...this.lastCapture } } : {}) };
  }

  isRecording(): boolean {
    return this.recordOn;
  }

  async setRecord(on: boolean): Promise<ActionResult<SessionRecordState>> {
    if (on === this.recordOn) return { ok: true, message: `No change: launch recording is already ${on ? 'on' : 'off'}`, data: this.recordState() };
    const down = this.engineDown();
    if (down) return down;
    const r = await this.d.engine.request({ cmd: 'setLaunchRecord', on }, LAUNCH_TIMEOUT_MS);
    if (!r.ok) return { ok: false, message: `Couldn't switch launch recording ${on ? 'on' : 'off'}: ${r.message ?? 'engine error'}` };
    this.recordOn = on;
    this.broadcastRecord();
    return {
      ok: true,
      message: on ? 'Launch recording on: what you launch while the song plays is written to the playlist when you stop' : 'Launch recording off',
      data: this.recordState(),
    };
  }

  private broadcastRecord(): void {
    this.d.broadcast(EVENT.sessionRecordState, this.recordState());
  }

  // ── Grid controller settings ───────────────────────────────────────

  gridSettings(): LaunchGridSettings {
    return launchGridSettings(this.d.getSettings());
  }

  setGridSettings(patch: unknown): ActionResult<LaunchGridSettings> {
    if (!patch || typeof patch !== 'object') return { ok: false, message: 'No grid settings to change' };
    const next = mergeLaunchGrid(this.gridSettings(), patch);
    const saved = launchGridSettings(this.d.updateSettings({ launchGrid: next }));
    // onSettingsChanged re-sends the map.
    return { ok: true, message: saved.enabled ? `Grid controller on (${saved.layout})` : 'Grid controller off', data: saved };
  }
}

/** Does a doc change move what the grid shows (scenes, launch clips, track order)? */
function layoutChanged(c: DocChange): boolean {
  if (c.kind === 'reset') return true;
  for (const p of c.patches) {
    const [a, b] = p.path;
    if (a === 'session') return true;
    if (a === 'playlist' && (b === 'trackOrder' || b === 'tracks') && p.path.length <= 3) return true;
  }
  return false;
}

/** Display name of a launch clip: its own name, else the pattern / channel name. */
export function clipLabel(p: { session?: import('@shared/schema/launcher').Session; patterns: Record<string, { name: string }>; channels: Record<string, { name: string }> }, clipId: string): string {
  const c = p.session?.clips[clipId];
  if (!c) return '?';
  if (c.name) return c.name;
  return (c.kind === 'pattern' ? p.patterns[c.patternId ?? '']?.name : p.channels[c.channelId ?? '']?.name) ?? '?';
}
