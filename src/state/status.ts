import { create } from 'zustand';
import type { AgentActivity, EngineStatus, McpStatus, ProjectStatus, Settings } from '@shared/types';
import { useDocStore } from '../doc/store';
import { connectTelemetry } from '../live/telemetry';
import { toast } from '../app/notify';
import { flashHint } from '../app/hints';

interface ProjectState {
  status: ProjectStatus | null;
  editedSinceStatus: boolean;
}
export const useProjectStatus = create<ProjectState>(() => ({ status: null, editedSinceStatus: false }));

export function isDirty(s: ProjectState = useProjectStatus.getState()): boolean {
  return !!s.status?.dirty || s.editedSinceStatus;
}

export async function refreshProjectStatus(): Promise<void> {
  try {
    const status = await window.krypt.project.status();
    useProjectStatus.setState({ status, editedSinceStatus: false });
  } catch {
  }
}

export const useEngineStatus = create<{ status: EngineStatus | null }>(() => ({ status: null }));

export const useSettings = create<{ settings: Settings | null }>(() => ({ settings: null }));

export async function updateSettings(patch: Partial<Settings>, success?: string): Promise<boolean> {
  try {
    const next = await window.krypt.settings.update(patch);
    useSettings.setState({ settings: next });
    if (success) flashHint(success, 'ok');
    return true;
  } catch (err) {
    toast.error(`Couldn't save settings: ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}

interface AgentsState {
  mcp: McpStatus | null;
  activity: AgentActivity[];
  lastAgentAt: number;
  agentTab: AgentTab;
}
export type AgentTab = 'chat' | 'activity' | 'connect';
export const useAgents = create<AgentsState>(() => ({ mcp: null, activity: [], lastAgentAt: 0, agentTab: 'chat' }));

export async function refreshMcpStatus(): Promise<void> {
  try {
    useAgents.setState({ mcp: await window.krypt.mcp.status() });
  } catch {
  }
}

export const useRender = create<{ active: boolean; progress: number; label: string }>(() => ({ active: false, progress: 0, label: '' }));

let installed = false;

export function installStatusFeeds(): void {
  if (installed) return;
  installed = true;
  const k = window.krypt;

  void refreshProjectStatus().then(() => {
    if (useProjectStatus.getState().status?.recovered) toast.info('Recovered unsaved changes from your last session. Save to keep them.');
  });
  k.project.onStatus((status) => useProjectStatus.setState({ status, editedSinceStatus: false }));
  useDocStore.subscribe((s, prev) => {
    if (s.version !== prev.version && s.lastChange && s.lastChange !== prev.lastChange) {
      if (!useProjectStatus.getState().editedSinceStatus) useProjectStatus.setState({ editedSinceStatus: true });
      if (s.lastChange.actorKind === 'agent') {
        useAgents.setState({ lastAgentAt: performance.now() });
        flashHint(`${s.lastChange.actorName}: ${s.lastChange.label}`, 'agent', 3200);
      }
    }
  });

  k.engine
    .status()
    .then((status) => useEngineStatus.setState({ status }))
    .catch(() => undefined);
  let lastState: string | null = null;
  k.engine.onStatus((status) => {
    useEngineStatus.setState({ status });
    if (status.state === 'running') void connectTelemetry();
    if (lastState && lastState !== status.state) {
      if (status.state === 'failed') toast.error(`Audio engine failed${status.message ? `: ${status.message}` : ''}`);
      else if (status.state === 'restarting') toast.warn('Audio engine is restarting…');
      else if (status.state === 'running' && (lastState === 'restarting' || lastState === 'failed')) toast.success('Audio engine is back');
    }
    lastState = status.state;
  });

  k.settings
    .get()
    .then((settings) => useSettings.setState({ settings }))
    .catch(() => toast.error("Couldn't load settings"));
  k.settings.onChanged((settings) => useSettings.setState({ settings }));

  void refreshMcpStatus();
  k.mcp.onStatus((mcp) => useAgents.setState({ mcp }));
  k.mcp.onActivity((a) => {
    useAgents.setState((s) => ({ activity: [a, ...s.activity].slice(0, 300), lastAgentAt: performance.now() }));
    if (!a.ok) flashHint(`${a.clientName}: ${a.tool} failed — ${a.summary}`, 'warn', 3500);
  });

  k.engine.onRenderProgress((progress) => {
    useRender.setState((s) => ({ active: progress < 1, progress, label: s.label || 'Rendering' }));
  });

  k.log.onAppend((line) => {
    if (line.level === 'error') toast.error(line.message);
    else if (line.level === 'warn') console.warn('[main]', line.message);
  });
}
