import { USER, type DocHost, type DocChange } from '@shared/doc/DocHost';
import type { ActionResult, MidiOutSettings, Settings } from '@shared/types';
import type { EngineEvent, LauncherLedState, MidiClockReply, MidiInputInfo, MidiOutputInfo } from '@shared/engine/protocol';
import { launchGridSettings } from '@shared/live/launchGrid';
import { EMPTY_LAUNCHER_STATE, gridView, launchpadProgrammerMode, ledChanges, ledMap, ledOff, resolveLedOutput, type LedMap } from '@shared/live/gridLeds';
import { mergeMidiOut, midiOutSettings, outputsToOpen, syncTempoToWrite } from '@shared/live/midiOut';
import { EVENT } from '../channels';
import type { EngineClient } from '../engine/types';

export interface HardwareDeps {
  doc: DocHost;
  engine: Pick<EngineClient, 'request' | 'onEvent' | 'onStatus' | 'status'>;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  onSettingsChanged(fn: (s: Settings, prev: Settings) => void): () => void;
  broadcast(channel: string, payload: unknown): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

const TIMEOUT_MS = 6000;
const LED_DEBOUNCE_MS = 15;

const flat = (m: LedMap): number[][] => Object.values(m).flat();

export class HardwareController {
  private outputs: MidiOutputInfo[] = [];
  private openKey = '';
  private clockKey = '';
  private syncKey = '';
  private ledPort: string | null = null;
  private ledInitKey = '';
  private ledSent: LedMap | null = null;
  private launcher: LauncherLedState = EMPTY_LAUNCHER_STATE;
  private ledTimer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private engineState = '';
  private offs: Array<() => void> = [];

  constructor(private readonly d: HardwareDeps) {}

  start(): void {
    this.offs.push(
      this.d.engine.onStatus((s) => {
        const was = this.engineState;
        this.engineState = s.state;
        if (s.state === 'running' && was !== 'running') this.queue(() => this.sync());
      }),
      this.d.engine.onEvent((e) => this.onEngineEvent(e)),
      this.d.doc.subscribe((c) => {
        if (touchesGrid(c)) this.scheduleLeds();
      }),
      this.d.onSettingsChanged((s, prev) => {
        const a = midiOutSettings(s);
        const b = midiOutSettings(prev);
        const g = JSON.stringify(launchGridSettings(s)) !== JSON.stringify(launchGridSettings(prev));
        if (g || JSON.stringify(a) !== JSON.stringify(b)) this.queue(() => this.apply());
      }),
    );
    if (this.d.engine.status().state === 'running') {
      this.engineState = 'running';
      this.queue(() => this.sync());
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.ledTimer) clearTimeout(this.ledTimer);
    this.ledTimer = null;
  }

  settle(): Promise<unknown> {
    return this.chain;
  }

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private running(): boolean {
    return this.d.engine.status().state === 'running';
  }

  private async sync(): Promise<void> {
    this.openKey = '';
    this.clockKey = '';
    this.syncKey = '';
    this.ledPort = null;
    this.ledInitKey = '';
    this.ledSent = null;
    this.launcher = EMPTY_LAUNCHER_STATE;
    const r = await this.d.engine.request<MidiOutputInfo[]>({ cmd: 'listMidiOutputs' }, TIMEOUT_MS);
    if (r.ok && Array.isArray(r.data)) this.setOutputs(r.data);
    await this.apply();
  }

  private async apply(): Promise<void> {
    if (!this.running()) return;
    await this.handOver();
    await this.pushOutputs();
    await this.pushClock();
    await this.pushSync();
    await this.updateLeds();
  }

  private setOutputs(list: MidiOutputInfo[]): void {
    this.outputs = list;
    this.d.broadcast(EVENT.midiOutputsChanged, list);
  }

  private async pushOutputs(): Promise<ActionResult<MidiOutputInfo[]>> {
    const s = this.d.getSettings();
    const want = outputsToOpen(midiOutSettings(s), resolveLedOutput(launchGridSettings(s), this.outputs));
    const key = JSON.stringify(want);
    if (key === this.openKey) return { ok: true, data: this.outputs };
    const r = await this.d.engine.request<MidiOutputInfo[]>({ cmd: 'setMidiOutputs', enabled: want }, TIMEOUT_MS);
    if (r.ok && Array.isArray(r.data)) {
      this.openKey = key;
      this.setOutputs(r.data);
      for (const o of r.data) if (o.enabled && !o.open) this.d.log('warn', `MIDI output ${o.name}: ${o.error ?? "couldn't open it"}`);
    } else {
      this.d.log('warn', `Couldn't open the MIDI outputs: ${r.message ?? 'no reply from the audio engine'}`);
    }
    return r;
  }

  private async pushClock(): Promise<ActionResult<MidiClockReply>> {
    const m = midiOutSettings(this.d.getSettings());
    const key = JSON.stringify([m.clockPorts, m.clockOffsetMs]);
    if (key === this.clockKey) return { ok: true };
    const r = await this.d.engine.request<MidiClockReply>({ cmd: 'setMidiClock', ports: m.clockPorts, offsetMs: m.clockOffsetMs }, TIMEOUT_MS);
    if (r.ok) {
      this.clockKey = key;
      const closed = m.clockPorts.filter((p) => !r.data?.open?.includes(p));
      if (closed.length) this.d.log('warn', `MIDI clock out: ${closed.join(', ')} ${closed.length === 1 ? "isn't" : "aren't"} open, so no clock goes there. Check Settings → MIDI.`);
    } else {
      this.d.log('warn', `Couldn't set up MIDI clock out: ${r.message ?? 'no reply from the audio engine'}`);
    }
    return r;
  }

  private async pushSync(): Promise<ActionResult> {
    const m = midiOutSettings(this.d.getSettings());
    const key = m.syncInput ?? '';
    if (key === this.syncKey) return { ok: true };
    const r = await this.d.engine.request({ cmd: 'setMidiSync', device: m.syncInput }, TIMEOUT_MS);
    if (r.ok) this.syncKey = key;
    else this.d.log('warn', `Couldn't switch the clock source: ${r.message ?? 'no reply from the audio engine'}`);
    return r;
  }

  private scheduleLeds(): void {
    if (this.ledTimer) return;
    this.ledTimer = setTimeout(() => {
      this.ledTimer = null;
      void this.queue(() => this.updateLeds());
    }, LED_DEBOUNCE_MS);
  }

  private async handOver(): Promise<boolean> {
    const port = resolveLedOutput(launchGridSettings(this.d.getSettings()), this.outputs);
    if (port === this.ledPort) return false;
    const old = this.ledPort;
    if (old && this.ledSent && this.isOpen(old)) {
      const bye = [...flat(ledOff(this.ledSent)), ...(this.ledInitKey.endsWith('|launchpad') ? launchpadProgrammerMode(this.name(old), false) : [])];
      await this.d.engine.request({ cmd: 'midiSend', port: old, messages: bye, atClose: [] }, TIMEOUT_MS);
    }
    this.ledPort = port;
    this.ledSent = null;
    this.ledInitKey = '';
    return true;
  }

  private async updateLeds(): Promise<void> {
    if (!this.running()) return;
    const gs = launchGridSettings(this.d.getSettings());
    if (await this.handOver()) await this.pushOutputs();
    const port = this.ledPort;
    if (!port || !this.isOpen(port)) return;
    const map = ledMap(gs, gridView(this.d.doc.project, gs, this.launcher));
    const initKey = `${port}|${gs.layout}`;
    const messages: number[][] = [];
    let atClose: number[][] | undefined;
    if (initKey !== this.ledInitKey) {
      if (this.ledSent) messages.push(...flat(ledOff(this.ledSent)));
      this.ledSent = null;
      if (gs.layout === 'launchpad') messages.push(...launchpadProgrammerMode(this.name(port), true));
      atClose = [...flat(ledOff(map)), ...(gs.layout === 'launchpad' ? launchpadProgrammerMode(this.name(port), false) : [])];
    }
    messages.push(...ledChanges(this.ledSent, map));
    if (!messages.length && !atClose) return;
    const r = await this.d.engine.request<{ sent: number }>({ cmd: 'midiSend', port, messages, ...(atClose ? { atClose } : {}) }, TIMEOUT_MS);
    if (r.ok) {
      this.ledSent = map;
      this.ledInitKey = initKey;
    } else {
      this.d.log('warn', `Couldn't update the grid LEDs on ${this.name(port)}: ${r.message ?? 'no reply from the audio engine'}`);
    }
  }

  private isOpen(id: string): boolean {
    return !!this.outputs.find((o) => o.id === id)?.open;
  }

  private name(id: string): string {
    return this.outputs.find((o) => o.id === id)?.name ?? id;
  }

  ledOutput(): { port: string | null; open: boolean } {
    const port = resolveLedOutput(launchGridSettings(this.d.getSettings()), this.outputs);
    return { port, open: port ? this.isOpen(port) : false };
  }

  private onEngineEvent(e: EngineEvent): void {
    switch (e.event) {
      case 'midiOutputs':
        this.setOutputs(Array.isArray(e.outputs) ? e.outputs : []);
        this.queue(() => this.apply());
        break;
      case 'launcherState':
        this.launcher = { playing: e.playing ?? {}, queued: e.queued ?? {}, overridden: e.overridden ?? [], recording: !!e.recording };
        this.scheduleLeds();
        break;
      case 'midiSync':
        this.onSync(e.running, e.bpm, !!e.lost);
        break;
      default:
        break;
    }
  }

  private onSync(running: boolean, bpm: number | null, lost: boolean): void {
    const m = midiOutSettings(this.d.getSettings());
    if (running) {
      this.d.log('info', `Following the external MIDI clock${m.syncInput ? ` from ${m.syncInput}` : ''}${bpm ? ` at ${bpm.toFixed(1)} bpm` : ''}`);
      return;
    }
    if (lost || !m.syncWritesTempo) return;
    const bpmToWrite = syncTempoToWrite(bpm, this.d.doc.project.transport.bpm);
    if (bpmToWrite === null) return;
    const r = this.d.doc.exec('transport.set', { bpm: bpmToWrite }, { actor: USER, label: 'Tempo from external clock' });
    if (r.ok) this.d.log('info', `Project tempo set to ${bpmToWrite} bpm from the external clock (Ctrl+Z undoes it)`);
    else this.d.log('warn', `Couldn't write the external tempo into the project: ${r.message ?? 'unknown error'}`);
  }

  async listOutputs(): Promise<ActionResult<MidiOutputInfo[]>> {
    if (!this.running()) return { ok: false, message: "The audio engine isn't running" };
    const r = await this.d.engine.request<MidiOutputInfo[]>({ cmd: 'listMidiOutputs' }, TIMEOUT_MS);
    if (r.ok && Array.isArray(r.data)) {
      this.setOutputs(r.data);
      this.queue(() => this.apply());
    }
    return r;
  }

  listInputs(): Promise<ActionResult<MidiInputInfo[]>> {
    if (!this.running()) return Promise.resolve({ ok: false, message: "The audio engine isn't running" });
    return this.d.engine.request<MidiInputInfo[]>({ cmd: 'listMidiInputs' }, TIMEOUT_MS);
  }

  outputsNow(): MidiOutputInfo[] {
    return this.outputs;
  }

  async setOutputEnabled(id: string, enabled: boolean): Promise<ActionResult<MidiOutputInfo[]>> {
    if (!id) return { ok: false, message: 'No MIDI output given' };
    const m = midiOutSettings(this.d.getSettings());
    this.d.updateSettings({ midiOut: { ...m, outputs: { ...m.outputs, [id]: !!enabled } } });
    await this.queue(() => this.apply());
    const o = this.outputs.find((x) => x.id === id);
    if (enabled && !o) return { ok: false, message: `There is no MIDI output "${id}" (unplugged?)`, data: this.outputs };
    if (enabled && o && !o.open) return { ok: false, message: `${id}: ${o.error ?? "couldn't open it"}`, data: this.outputs };
    return { ok: true, message: `${id} ${enabled ? 'enabled' : 'disabled'}`, data: this.outputs };
  }

  clockSettings(): MidiOutSettings {
    return midiOutSettings(this.d.getSettings());
  }

  async setClockSettings(patch: unknown): Promise<ActionResult<MidiOutSettings>> {
    if (!patch || typeof patch !== 'object') return { ok: false, message: 'No clock settings to change' };
    const { outputs: _ignored, ...rest } = patch as Record<string, unknown>;
    const before = this.clockSettings();
    const next = mergeMidiOut(before, rest);
    const saved = midiOutSettings(this.d.updateSettings({ midiOut: next }));
    await this.queue(() => this.apply());
    const parts: string[] = [];
    if (JSON.stringify(saved.clockPorts) !== JSON.stringify(before.clockPorts) || saved.clockOffsetMs !== before.clockOffsetMs) {
      parts.push(saved.clockPorts.length ? `MIDI clock out to ${saved.clockPorts.join(', ')}${saved.clockOffsetMs ? ` (offset ${saved.clockOffsetMs > 0 ? '+' : ''}${saved.clockOffsetMs} ms)` : ''}` : 'MIDI clock out off');
    }
    if (saved.syncInput !== before.syncInput) parts.push(saved.syncInput ? `Following the MIDI clock from ${saved.syncInput} (press Play on that device)` : 'Internal clock');
    if (saved.syncWritesTempo !== before.syncWritesTempo) parts.push(saved.syncWritesTempo ? 'The external tempo is written into the project when it stops' : "The external tempo isn't written into the project");
    const missing = saved.clockPorts.filter((p) => !this.outputs.some((o) => o.id === p));
    const message = parts.length ? parts.join('. ') : 'No change: those are the current MIDI clock settings';
    if (missing.length) return { ok: false, message: `${message}. No MIDI output called ${missing.map((x) => `"${x}"`).join(', ')} is connected.`, data: saved };
    return { ok: true, message, data: saved };
  }
}

function touchesGrid(c: DocChange): boolean {
  if (c.kind === 'reset') return true;
  for (const p of c.patches) {
    const [a, , k] = p.path;
    if (a === 'session') return true;
    if (a === 'playlist' && (p.path[1] === 'trackOrder' || (p.path[1] === 'tracks' && p.path.length <= 3))) return true;
    if ((a === 'patterns' || a === 'channels') && (k === undefined || k === 'color')) return true;
  }
  return false;
}
