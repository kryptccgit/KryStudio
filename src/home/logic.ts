import type { AnalyzerState, EngineStatus, McpStatus, PluginManagerState } from '@shared/types';
import type { LibraryState } from '@shared/library/types';
import { fmtAgo, fmtCount, plural } from '../library/logic';

export { fmtAgo };

export type HomeScreen = 'home' | 'projects' | 'agents' | 'audio' | 'sounds' | 'recording' | 'guides';

export const HOME_ACTION_IDS = [
  'studio',
  'projects',
  'newProject',
  'openProject',
  'openDemo',
  'importMidi',
  'audioProject',
  'autoMashup',
  'autoMix',
  'masterSong',
  'masterAlbum',
  'kryptVoice',
  'agents',
  'agentPanel',
  'history',
  'library',
  'checkOriginality',
  'audioTools',
  'modelManager',
  'sounds',
  'presets',
  'browser',
  'pluginManager',
  'export',
  'recording',
  'booth',
  'settings',
  'shortcuts',
  'channelRack',
  'pianoRoll',
  'playlist',
  'mixer',
  'guides',
  'session',
  'tours',
  'tourFirstBeat',
  'tourWindows',
  'tourSong',
  'tourAi',
  'tourMaster',
] as const;

export type HomeActionId = (typeof HOME_ACTION_IDS)[number];

export function isHomeActionId(id: string): id is HomeActionId {
  return (HOME_ACTION_IDS as readonly string[]).includes(id);
}

const MASTER_ALBUM: string = 'masterAlbum';

export function masterCardActions(): { song: HomeActionId; album: HomeActionId | null } {
  return { song: 'masterSong', album: isHomeActionId(MASTER_ALBUM) ? MASTER_ALBUM : null };
}

export type PillTone = 'neutral' | 'live' | 'accent' | 'warn' | 'danger';

export interface Pill {
  text: string;
  tone: PillTone;
  dot?: boolean;
  hint?: string;
}

const clip = (s: string, max = 28): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

export function studioPill(p: { name: string | null | undefined; dirty: boolean; recovered?: boolean }): Pill | null {
  const name = (p.name ?? '').trim();
  if (!name) return null;
  if (p.recovered) return { text: clip(name), tone: 'warn', dot: p.dirty, hint: `${name}: recovered from your last session, not saved yet` };
  return { text: clip(name), tone: 'neutral', dot: p.dirty, hint: p.dirty ? `${name} has unsaved changes` : `${name} is open` };
}

export function projectsPill(recent: readonly string[] | null | undefined): Pill | null {
  if (!recent || !recent.length) return null;
  return { text: `${fmtCount(recent.length)} recent`, tone: 'neutral', hint: plural(recent.length, 'recent project') };
}

export function agentsPill(mcp: McpStatus | null | undefined): Pill | null {
  if (!mcp) return null;
  if (!mcp.enabled) return { text: 'Agents off', tone: 'warn', hint: 'The kill switch is on: agents can’t connect until you allow them again' };
  const clients = mcp.clients ?? [];
  if (!clients.length) return { text: 'Not connected', tone: 'neutral', hint: 'No AI agent is connected right now' };
  const first = clip(clients[0].name || 'An agent', 22);
  if (clients.length === 1) return { text: `${first} connected`, tone: 'live', hint: `${clients[0].name || 'An agent'} is connected` };
  return { text: `${first} + ${clients.length - 1} more`, tone: 'live', hint: clients.map((c) => c.name).join(', ') };
}

export function libraryPill(lib: LibraryState | null | undefined): Pill | null {
  if (!lib || !Array.isArray(lib.collections)) return null;
  if (lib.focus) return { text: `Focus: ${clip(lib.focus.name, 22)}`, tone: 'accent', hint: `Agents compose in the style of ${lib.focus.name}` };
  const q = lib.queue;
  if (q?.running && q.total > 0) return { text: `Analysing ${fmtCount(Math.min(q.total, q.done + 1))} of ${fmtCount(q.total)}`, tone: 'live' };
  const total = lib.collections.reduce((n, c) => n + (c.counts?.total ?? 0), 0);
  if (total > 0) return { text: plural(total, 'track'), tone: 'neutral' };
  return { text: 'Empty', tone: 'neutral', hint: 'No reference songs yet' };
}

const JOB_VERB: Record<string, string> = { analyze: 'Analysing', separate: 'Separating stems', transcribe: 'Transcribing' };

export function audioToolsPill(a: AnalyzerState | null | undefined): Pill | null {
  if (!a || !Array.isArray(a.models)) return null;
  if (!a.available) return { text: 'Analyzer missing', tone: 'warn', hint: 'krypt-studio-analyzer.exe was not found' };
  if (a.jobs?.length) {
    const j = a.jobs[0];
    const pct = j.fraction >= 0 ? ` ${Math.round(j.fraction * 100)}%` : '…';
    return { text: a.jobs.length > 1 ? `${a.jobs.length} jobs running` : `${JOB_VERB[j.kind] ?? 'Working'}${pct}`, tone: 'live', hint: j.label };
  }
  const installed = a.models.filter((m) => m.status === 'installed').length;
  const parts: string[] = [];
  if (a.devices?.length) parts.push(a.devices.includes('directml') ? 'GPU' : 'CPU');
  parts.push(plural(installed, 'model'));
  return { text: parts.join(' · '), tone: 'neutral', hint: a.devices?.includes('directml') ? 'Stems run on your GPU (DirectML)' : undefined };
}

export function pluginsPill(p: PluginManagerState | null | undefined): Pill | null {
  if (!p || !Array.isArray(p.plugins)) return null;
  if (p.scanning) {
    const prog = p.progress && p.progress.total > 0 ? ` ${p.progress.done}/${p.progress.total}` : '…';
    return { text: `Scanning${prog}`, tone: 'live' };
  }
  if (p.plugins.length) return { text: plural(p.plugins.length, 'plugin'), tone: 'neutral', hint: 'Installed VST3 / CLAP plugins' };
  return { text: 'Stock only', tone: 'neutral', hint: 'No VST3 / CLAP plugins found yet; every stock instrument and effect is ready' };
}

export function guidesPill(firstRun: boolean): Pill | null {
  return firstRun ? { text: 'Start here', tone: 'accent' } : null;
}

export function recordingPill(armed: boolean, input: { open: boolean; name?: string | null } | null, vocalsReady: boolean): Pill | null {
  if (armed) return { text: 'Armed', tone: 'danger', hint: 'Recording is armed: press Play in the Studio to record' };
  if (input?.open && input.name) return { text: clip(`Mic: ${input.name}`, 26), tone: 'live', hint: `The audio input is open: ${input.name}` };
  if (vocalsReady) return { text: 'Vocals ready', tone: 'neutral', hint: 'Takes play through your vocal insert and land on its track' };
  return null;
}

export function settingsPill(e: EngineStatus | null | undefined): Pill | null {
  if (!e) return null;
  switch (e.state) {
    case 'running':
      if (e.device?.open) return { text: clip(e.device.name || 'Audio device on', 26), tone: 'live', hint: `Audio: ${e.device.name ?? 'device'} · ${e.device.sampleRate} Hz · ${e.device.bufferFrames} samples` };
      return { text: 'No audio device', tone: 'warn', hint: e.device?.message ?? e.message ?? 'The engine is running but no output device is open' };
    case 'starting':
      return { text: 'Engine starting', tone: 'neutral' };
    case 'restarting':
      return { text: 'Engine restarting', tone: 'warn' };
    case 'failed':
      return { text: 'Engine failed', tone: 'danger', hint: e.message };
    case 'stopped':
      return { text: 'Engine stopped', tone: 'neutral', hint: e.message };
    default:
      return null;
  }
}

export function isFirstRun(flags: { guidesSeen: boolean; welcomeSeen: boolean }): boolean {
  return !flags.guidesSeen && !flags.welcomeSeen;
}

export function quickstartCardVisible(s: { ready: boolean; dismissed: boolean; welcomeSeen: boolean }): boolean {
  return s.ready && !s.dismissed && !s.welcomeSeen;
}

export interface RecentProject {
  path: string;
  name: string;
  folder: string;
  lastOpened: number | null;
}

export function splitProjectPath(path: string): { name: string; folder: string } {
  const p = path.replace(/[\\/]+$/, '');
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  const file = i >= 0 ? p.slice(i + 1) : p;
  const folder = i > 0 ? p.slice(0, i) : '';
  return { name: file.replace(/\.kstudio$/i, '') || file, folder };
}

export const pathKey = (p: string): string => p.replace(/\//g, '\\').toLowerCase();

export function shapeRecent(
  recent: readonly string[] | null | undefined,
  opts: { currentPath?: string | null; limit?: number; openedAt?: Record<string, number> } = {},
): RecentProject[] {
  const out: RecentProject[] = [];
  const seen = new Set<string>();
  const cur = opts.currentPath ? pathKey(opts.currentPath) : null;
  const limit = Math.max(0, opts.limit ?? 5);
  for (const raw of recent ?? []) {
    if (out.length >= limit) break;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const key = pathKey(raw);
    if (seen.has(key) || key === cur) continue;
    seen.add(key);
    const { name, folder } = splitProjectPath(raw);
    const t = opts.openedAt?.[key];
    out.push({ path: raw, name, folder, lastOpened: typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null });
  }
  return out;
}

export function shouldOpenHome(p: { openToHome: boolean | undefined; openedWithFile: boolean }): boolean {
  if (p.openedWithFile) return false;
  return p.openToHome !== false;
}

export const TIPS: readonly string[] = [
  'Ask Claude: “make the hats bouncier”. It edits your project live, and every change can be undone.',
  'Drop a folder of your own songs on the Library to learn their style.',
  'F6 opens the Channel Rack, F7 the Piano Roll, F9 the Mixer and F5 the Playlist.',
  'Space plays and stops. L switches between pattern mode and song mode.',
  'Right-click an audio clip in the Playlist to detect its tempo and key, split it into stems or turn it into a pattern.',
  'Edit ▸ History can revert everything an AI agent did in one click, and keeps your own edits.',
  'Right-click any knob and pick “Create automation clip” to automate it on the Playlist.',
  'In Claude Code, type /krypt-studio:beat to start a beat from a genre, a tempo and a key.',
  'Ctrl+T turns the typing keyboard on or off: the Z and Q rows play the selected channel.',
  'Double-click a knob to reset it. Hold Ctrl while dragging for fine moves.',
  'Right-click a knob and pick “Link to controller…”, then move a knob on your MIDI controller.',
  'Ctrl+R opens Export: render the song, one pattern or the loop region to WAV.',
];

export function tipAt(n: number, tips: readonly string[] = TIPS): string {
  if (!tips.length) return '';
  const i = ((Math.floor(n) % tips.length) + tips.length) % tips.length;
  return tips[i];
}
